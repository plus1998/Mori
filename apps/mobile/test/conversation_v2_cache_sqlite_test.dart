import 'dart:io';

import 'package:eco_mobile/core/models/conversation_v2_models.dart';
import 'package:eco_mobile/core/storage/conversation_v2_cache.dart';
import 'package:eco_mobile/core/utils/conversation_v2_hash.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:path/path.dart' as p;
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

void main() {
  sqfliteFfiInit();

  test(
    'queued text and image edits survive sync and database reopen',
    () async {
      final directory = await Directory.systemTemp.createTemp(
        'eco-queued-edit-',
      );
      final databasePath = p.join(directory.path, 'conversation-v2.sqlite');
      addTearDown(() async {
        await databaseFactoryFfi.deleteDatabase(databasePath);
        await directory.delete(recursive: true);
      });
      final cache = _cache(databasePath);
      await cache.installBootstrap(
        const ConversationV2Bootstrap(
          protocolVersion: 2,
          storeEpoch: _storeEpoch,
          conversationId: _conversationId,
          snapshotSeq: 1,
          historyRevision: 0,
          messages: [
            ConversationV2Message(
              messageId: 'queued-edit',
              conversationId: _conversationId,
              turnId: 'turn-edit',
              role: 'user',
              channel: 'answer',
              createdSeq: 1,
              versionSeq: 1,
              contentVersion: 0,
              body: 'old',
              status: ConversationV2MessageStatus.queued,
              isDeleted: false,
              attachments: [
                {'contentRef': 'old-image'},
              ],
            ),
          ],
          runs: [],
          tools: [],
          olderCursor: null,
          hasOlder: false,
        ),
      );
      final payload = <String, dynamic>{
        'type': 'message.replace',
        'messageId': 'queued-edit',
        'baseContentVersion': 0,
        'nextContentVersion': 1,
        'body': 'edited',
        'versionSeq': 2,
        'attachments': [],
      };
      await cache.applySyncPage(
        _page(
          fromSeq: 2,
          throughSeq: 2,
          headSeq: 2,
          effects: [
            ConversationV2Effect(
              seq: 2,
              effectVersion: 1,
              effectHash: conversationV2StableHash(payload),
              type: 'message.replace',
              payload: payload,
            ),
          ],
        ),
      );
      expect((await cache.messages(_conversationId)).single.body, 'edited');
      expect(
        (await cache.messages(_conversationId)).single.attachments,
        isEmpty,
      );
      await cache.close();
      final reopened = _cache(databasePath);
      expect((await reopened.messages(_conversationId)).single.body, 'edited');
      expect(
        (await reopened.messages(_conversationId)).single.attachments,
        isEmpty,
      );
      await reopened.close();
    },
  );

  test('pending thread delete survives database reopen', () async {
    final directory = await Directory.systemTemp.createTemp(
      'eco-conversation-v2-delete-cache-',
    );
    final databasePath = p.join(directory.path, 'conversation-v2.sqlite');
    addTearDown(() async {
      await databaseFactoryFfi.deleteDatabase(databasePath);
      await directory.delete(recursive: true);
    });

    final first = _cache(databasePath);
    const command = ConversationV2PendingThreadDelete(
      principalId: 'account-sqlite',
      threadId: 'thread-delete',
      clientCommandId: 'delete-command',
      expectedHistoryRevision: 7,
      createdAt: '2026-09-17T00:00:00.000Z',
    );
    await first.putPendingThreadDelete(command);
    await first.close();

    final reopened = _cache(databasePath);
    final restored = await reopened.pendingThreadDelete('thread-delete');
    expect(restored?.principalId, command.principalId);
    expect(restored?.clientCommandId, command.clientCommandId);
    expect(restored?.expectedHistoryRevision, 7);
    await reopened.removePendingThreadDelete(
      command.threadId,
      command.clientCommandId,
    );
    expect(await reopened.pendingThreadDelete(command.threadId), isNull);
    await reopened.close();
  });

  test('bootstrap at head can persist live state across reopen', () async {
    final directory = await Directory.systemTemp.createTemp(
      'eco-conversation-v2-live-cache-',
    );
    final databasePath = p.join(directory.path, 'conversation-v2.sqlite');
    addTearDown(() async {
      await databaseFactoryFfi.deleteDatabase(databasePath);
      await directory.delete(recursive: true);
    });

    final first = _cache(databasePath);
    await first.installBootstrap(
      const ConversationV2Bootstrap(
        protocolVersion: 2,
        storeEpoch: _storeEpoch,
        conversationId: _conversationId,
        snapshotSeq: 2,
        historyRevision: 0,
        messages: [],
        runs: [],
        tools: [],
        olderCursor: null,
        hasOlder: false,
      ),
    );
    expect(
      (await first.state(_conversationId))?.state,
      ConversationV2SyncState.catchingUp,
    );
    await first.markLive(_conversationId);
    expect(
      (await first.state(_conversationId))?.state,
      ConversationV2SyncState.live,
    );
    await first.close();

    final reopened = _cache(databasePath);
    addTearDown(reopened.close);
    expect(
      (await reopened.state(_conversationId))?.state,
      ConversationV2SyncState.live,
    );
    await reopened.close();
  });

  test(
    'agent effects survive reopen and a failed page rolls back atomically',
    () async {
      final directory = await Directory.systemTemp.createTemp(
        'eco-conversation-v2-cache-',
      );
      final databasePath = p.join(directory.path, 'conversation-v2.sqlite');
      addTearDown(() async {
        await databaseFactoryFfi.deleteDatabase(databasePath);
        await directory.delete(recursive: true);
      });

      final first = _cache(databasePath);
      await first.installBootstrap(_bootstrap());
      await first.applySyncPage(
        _page(
          fromSeq: 1,
          throughSeq: 1,
          headSeq: 1,
          effects: [_agentEffect(1, status: 'started', mission: '')],
        ),
      );
      expect((await first.state(_conversationId))?.appliedSeq, 1);
      expect((await first.agents(_conversationId)).single.toJson(), {
        'agentId': _agentId,
        'conversationId': _conversationId,
        'role': 'researcher',
        'kind': 'subagent',
        'status': 'started',
        'versionSeq': 1,
        'runId': 'run-1',
        'parentAgentInstanceId': 'parent-agent-1',
        'parentToolCallId': 'parent-tool-1',
        'startedAt': '2026-09-17T00:00:00.000Z',
        'mission': '',
        'taskName': 'sqlite task',
        'delegationSummary': 'sqlite summary',
        'delegationPrompt': 'sqlite prompt',
        'todoId': 'todo-sqlite',
      });
      await first.close();

      final reopened = _cache(databasePath);
      addTearDown(reopened.close);
      expect((await reopened.state(_conversationId))?.appliedSeq, 1);
      expect((await reopened.agents(_conversationId)).single.mission, '');

      await expectLater(
        reopened.applySyncPage(
          _page(
            fromSeq: 2,
            throughSeq: 3,
            effects: [
              _agentEffect(2, status: 'working', mission: ''),
              _agentEffect(3, status: 'completed', versionSeq: 2, mission: ''),
            ],
          ),
        ),
        throwsA(isA<StateError>()),
      );

      expect((await reopened.state(_conversationId))?.appliedSeq, 1);
      final rolledBack = (await reopened.agents(_conversationId)).single;
      expect(rolledBack.status, 'started');
      expect(rolledBack.versionSeq, 1);
      await reopened.close();

      final reopenedAfterRollback = _cache(databasePath);
      addTearDown(reopenedAfterRollback.close);
      expect(
        (await reopenedAfterRollback.state(_conversationId))?.appliedSeq,
        1,
      );
      expect(
        (await reopenedAfterRollback.agents(_conversationId)).single.status,
        'started',
      );

      await reopenedAfterRollback.applySyncPage(
        _page(
          fromSeq: 2,
          throughSeq: 2,
          headSeq: 2,
          effects: [_agentEffect(2, status: 'completed', mission: '')],
        ),
      );
      expect(
        (await reopenedAfterRollback.state(_conversationId))?.appliedSeq,
        2,
      );
      expect(
        (await reopenedAfterRollback.agents(_conversationId)).single.status,
        'completed',
      );
      await reopenedAfterRollback.close();

      final finalReopen = _cache(databasePath);
      addTearDown(finalReopen.close);
      expect((await finalReopen.agents(_conversationId)).single.toJson(), {
        'agentId': _agentId,
        'conversationId': _conversationId,
        'role': 'researcher',
        'kind': 'subagent',
        'status': 'completed',
        'versionSeq': 2,
        'runId': 'run-1',
        'parentAgentInstanceId': 'parent-agent-1',
        'parentToolCallId': 'parent-tool-1',
        'startedAt': '2026-09-17T00:00:00.000Z',
        'endedAt': '2026-09-17T00:00:02.000Z',
        'mission': '',
        'taskName': 'sqlite task',
        'delegationSummary': 'sqlite summary',
        'delegationPrompt': 'sqlite prompt',
        'todoId': 'todo-sqlite',
      });
    },
  );

  test(
    'todo bootstrap and replacement effects survive reopen atomically',
    () async {
      final directory = await Directory.systemTemp.createTemp(
        'eco-conversation-v2-todo-cache-',
      );
      final databasePath = p.join(directory.path, 'conversation-v2.sqlite');
      addTearDown(() async {
        await databaseFactoryFfi.deleteDatabase(databasePath);
        await directory.delete(recursive: true);
      });

      final cache = _cache(databasePath);
      await cache.installBootstrap(
        const ConversationV2Bootstrap(
          protocolVersion: 2,
          storeEpoch: _storeEpoch,
          conversationId: _conversationId,
          snapshotSeq: 1,
          historyRevision: 0,
          messages: [],
          runs: [],
          tools: [],
          todos: [
            ConversationV2Todo(
              todoId: 'todo-1',
              conversationId: _conversationId,
              title: 'Bootstrap',
              detail: '',
              status: 'pending',
              position: 0,
              updatedAt: '2026-09-17T00:00:00.000Z',
              versionSeq: 1,
            ),
          ],
          olderCursor: null,
          hasOlder: false,
        ),
      );
      expect((await cache.todos(_conversationId)).single.title, 'Bootstrap');

      await cache.applySyncPage(
        _page(fromSeq: 2, throughSeq: 2, headSeq: 2, effects: [_todoEffect(2)]),
      );
      expect((await cache.todos(_conversationId)).map((todo) => todo.todoId), [
        'todo-2',
        'todo-3',
      ]);

      await expectLater(
        cache.applySyncPage(
          _page(
            fromSeq: 3,
            throughSeq: 3,
            headSeq: 3,
            effects: [_todoEffect(3, duplicatePosition: true)],
          ),
        ),
        throwsA(isA<StateError>()),
      );
      expect((await cache.state(_conversationId))?.appliedSeq, 2);
      expect((await cache.todos(_conversationId)).map((todo) => todo.todoId), [
        'todo-2',
        'todo-3',
      ]);
      await cache.close();

      final reopened = _cache(databasePath);
      expect(
        (await reopened.todos(_conversationId)).map((todo) => todo.todoId),
        ['todo-2', 'todo-3'],
      );
      await reopened.close();
    },
  );

  test(
    'independent tool pages persist summaries without widening bootstrap',
    () async {
      final directory = await Directory.systemTemp.createTemp(
        'eco-conversation-v2-tools-page-cache-',
      );
      final databasePath = p.join(directory.path, 'conversation-v2.sqlite');
      addTearDown(() async {
        await databaseFactoryFfi.deleteDatabase(databasePath);
        await directory.delete(recursive: true);
      });

      final cache = _cache(databasePath);
      await cache.installBootstrap(
        const ConversationV2Bootstrap(
          protocolVersion: 2,
          storeEpoch: _storeEpoch,
          conversationId: _conversationId,
          snapshotSeq: 2,
          historyRevision: 0,
          messages: [],
          runs: [
            ConversationV2Run(
              runId: 'run-tools',
              conversationId: _conversationId,
              turnId: 'turn-tools',
              status: 'running',
              versionSeq: 1,
              timingQuality: 'recorded',
            ),
          ],
          tools: [],
          olderCursor: null,
          hasOlder: false,
        ),
      );
      await cache.applyToolsPage(
        const ConversationV2ToolsPage(
          protocolVersion: 2,
          storeEpoch: _storeEpoch,
          conversationId: _conversationId,
          runId: 'run-tools',
          readSeq: 2,
          historyRevision: 0,
          tools: [
            ConversationV2Tool(
              toolCallId: 'tool-1',
              conversationId: _conversationId,
              runId: 'run-tools',
              name: 'Bash',
              status: 'completed',
              createdSeq: 1,
              versionSeq: 2,
            ),
          ],
          totalCount: 3,
          nextCursor: 'cursor-tools',
          hasMore: true,
        ),
      );
      expect(
        (await cache.tools(_conversationId, 'run-tools')).single.toolCallId,
        'tool-1',
      );
      await cache.close();

      final reopened = _cache(databasePath);
      addTearDown(reopened.close);
      expect(
        (await reopened.tools(_conversationId, 'run-tools')).single.name,
        'Bash',
      );
      await reopened.close();
    },
  );

  test(
    'rejects a future or mismatched tool page without changing the cache',
    () async {
      final directory = await Directory.systemTemp.createTemp(
        'eco-conversation-v2-tool-page-guard-',
      );
      final databasePath = p.join(directory.path, 'conversation-v2.sqlite');
      addTearDown(() async {
        await databaseFactoryFfi.deleteDatabase(databasePath);
        await directory.delete(recursive: true);
      });

      final cache = _cache(databasePath);
      addTearDown(cache.close);
      await cache.installBootstrap(
        const ConversationV2Bootstrap(
          protocolVersion: 2,
          storeEpoch: _storeEpoch,
          conversationId: _conversationId,
          snapshotSeq: 2,
          historyRevision: 0,
          messages: [],
          runs: [],
          tools: [],
          olderCursor: null,
          hasOlder: false,
        ),
      );
      const page = ConversationV2ToolsPage(
        protocolVersion: 2,
        storeEpoch: _storeEpoch,
        conversationId: _conversationId,
        runId: 'run-tools',
        readSeq: 3,
        historyRevision: 0,
        tools: [],
        totalCount: 0,
        nextCursor: null,
        hasMore: false,
      );
      await expectLater(cache.applyToolsPage(page), throwsStateError);
      await expectLater(
        cache.applyToolsPage(
          const ConversationV2ToolsPage(
            protocolVersion: 2,
            storeEpoch: _storeEpoch,
            conversationId: _conversationId,
            runId: 'run-tools',
            readSeq: 2,
            historyRevision: 1,
            tools: [],
            totalCount: 0,
            nextCursor: null,
            hasMore: false,
          ),
        ),
        throwsStateError,
      );
      expect(await cache.tools(_conversationId), isEmpty);
      expect((await cache.state(_conversationId))?.historyRevision, 0);
    },
  );

  test('history target effects survive sync and database reopen', () async {
    final directory = await Directory.systemTemp.createTemp(
      'eco-conversation-v2-history-target-cache-',
    );
    final databasePath = p.join(directory.path, 'conversation-v2.sqlite');
    addTearDown(() async {
      await databaseFactoryFfi.deleteDatabase(databasePath);
      await directory.delete(recursive: true);
    });

    final cache = _cache(databasePath);
    await cache.installBootstrap(
      ConversationV2Bootstrap(
        protocolVersion: 2,
        storeEpoch: _storeEpoch,
        conversationId: _conversationId,
        snapshotSeq: 1,
        historyRevision: 0,
        messages: const [
          ConversationV2Message(
            messageId: 'message-history-target',
            conversationId: _conversationId,
            turnId: 'turn-history-target',
            role: 'user',
            channel: 'answer',
            createdSeq: 1,
            versionSeq: 1,
            contentVersion: 0,
            body: 'bind me',
            status: ConversationV2MessageStatus.finalised,
            isDeleted: false,
          ),
        ],
        runs: const [],
        tools: const [],
        olderCursor: null,
        hasOlder: false,
      ),
    );
    await cache.applySyncPage(
      _page(
        fromSeq: 2,
        throughSeq: 2,
        headSeq: 2,
        effects: [_historyTargetEffect(2)],
      ),
    );
    expect(
      (await cache.messages(_conversationId)).single.historyTarget?.toJson(),
      {
        'activityLineId': 'activity-history',
        'userMessageId': 'provider-history',
      },
    );
    await cache.close();

    final reopened = _cache(databasePath);
    addTearDown(reopened.close);
    expect(
      (await reopened.messages(
        _conversationId,
      )).single.historyTarget?.userMessageId,
      'provider-history',
    );
    await reopened.close();
  });
}

const _conversationId = 'conversation-sqlite';
const _storeEpoch = 'epoch-sqlite';
const _agentId = 'agent-sqlite';

ConversationV2Cache _cache(String databasePath) => ConversationV2Cache(
  accountId: 'account-sqlite',
  desktopDeviceId: 'desktop-sqlite',
  databaseFactory: databaseFactoryFfi,
  databasePath: databasePath,
);

ConversationV2Bootstrap _bootstrap() => const ConversationV2Bootstrap(
  protocolVersion: 2,
  storeEpoch: _storeEpoch,
  conversationId: _conversationId,
  snapshotSeq: 0,
  historyRevision: 0,
  messages: [],
  runs: [],
  tools: [],
  olderCursor: null,
  hasOlder: false,
);

ConversationV2SyncPage _page({
  required int fromSeq,
  required int throughSeq,
  required List<ConversationV2Effect> effects,
  int headSeq = 3,
}) => ConversationV2SyncPage(
  protocolVersion: 2,
  storeEpoch: _storeEpoch,
  conversationId: _conversationId,
  fromSeq: fromSeq,
  throughSeq: throughSeq,
  headSeq: headSeq,
  hasMore: false,
  effects: effects,
);

ConversationV2Effect _agentEffect(
  int seq, {
  required String status,
  required String mission,
  int? versionSeq,
}) {
  final payload = <String, dynamic>{
    'type': 'agent.upsert',
    'agent': {
      'agentId': _agentId,
      'conversationId': _conversationId,
      'role': 'researcher',
      'kind': 'subagent',
      'status': status,
      'versionSeq': versionSeq ?? seq,
      'runId': 'run-1',
      'parentAgentInstanceId': 'parent-agent-1',
      'parentToolCallId': 'parent-tool-1',
      'startedAt': '2026-09-17T00:00:00.000Z',
      if (status == 'completed') 'endedAt': '2026-09-17T00:00:02.000Z',
      'mission': mission,
      'taskName': 'sqlite task',
      'delegationSummary': 'sqlite summary',
      'delegationPrompt': 'sqlite prompt',
      'todoId': 'todo-sqlite',
    },
  };
  return ConversationV2Effect(
    seq: seq,
    effectVersion: 1,
    effectHash: conversationV2StableHash(payload),
    type: 'agent.upsert',
    payload: payload,
  );
}

ConversationV2Effect _todoEffect(int seq, {bool duplicatePosition = false}) {
  final payload = <String, dynamic>{
    'type': 'todo.list.replace',
    'todos': [
      {
        'todoId': 'todo-2',
        'conversationId': _conversationId,
        'title': 'Implement',
        'detail': 'Use V2',
        'status': 'running',
        'position': 0,
        'updatedAt': '2026-09-17T00:00:01.000Z',
        'versionSeq': seq,
      },
      {
        'todoId': 'todo-3',
        'conversationId': _conversationId,
        'title': 'Verify',
        'detail': '',
        'status': 'pending',
        'position': duplicatePosition ? 0 : 1,
        'updatedAt': '2026-09-17T00:00:01.000Z',
        'versionSeq': seq,
      },
    ],
  };
  return ConversationV2Effect(
    seq: seq,
    effectVersion: 1,
    effectHash: conversationV2StableHash(payload),
    type: 'todo.list.replace',
    payload: payload,
  );
}

ConversationV2Effect _historyTargetEffect(int seq) {
  final payload = <String, dynamic>{
    'type': 'message.history_target',
    'messageId': 'message-history-target',
    'historyTarget': {
      'activityLineId': 'activity-history',
      'userMessageId': 'provider-history',
    },
    'versionSeq': seq,
  };
  return ConversationV2Effect(
    seq: seq,
    effectVersion: 1,
    effectHash: conversationV2StableHash(payload),
    type: 'message.history_target',
    payload: payload,
  );
}
