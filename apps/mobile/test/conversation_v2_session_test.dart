import 'dart:async';
import 'dart:io';
import 'package:flutter_test/flutter_test.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';
import 'package:eco_mobile/core/models/conversation_v2_models.dart';
import 'package:eco_mobile/core/models/thread_models.dart';
import 'package:eco_mobile/core/storage/conversation_v2_cache.dart';
import 'package:eco_mobile/core/sync/conversation_v2_session.dart';
import 'package:eco_mobile/core/sync/conversation_v2_sync_engine.dart';
import 'package:eco_mobile/core/utils/conversation_v2_hash.dart';

const approval = BashApprovalRequest(
  toolUseId: 'mcp_1',
  threadId: 'thread',
  command: 'MCP service/write',
  cwd: '/workspace',
  reason: 'Write a document',
  riskScore: 3,
  riskLevel: 'medium',
  mcpToolServerName: 'service',
  mcpToolName: 'write',
);

void main() {
  sqfliteFfiInit();
  late ConversationV2Cache cache;
  late _Remote remote;
  late ConversationV2SessionController controller;
  var pending = const ConversationV2PendingInteractions();
  Future<ConversationV2PendingInteractions> Function()? reply;
  Object? actionError;
  setUp(() async {
    final directory = await Directory.systemTemp.createTemp('eco-v2-session-');
    cache = ConversationV2Cache(
      accountId: 'account',
      desktopDeviceId: 'desktop',
      databaseFactory: databaseFactoryFfi,
      databasePath: '${directory.path}/cache.sqlite',
    );
    remote = _Remote();
    pending = const ConversationV2PendingInteractions();
    reply = null;
    actionError = null;
    controller = ConversationV2SessionController(
      conversationId: 'thread',
      cache: cache,
      remote: remote,
      loadPendingInteractions: () => reply?.call() ?? Future.value(pending),
      actions: ConversationV2InteractionActions(
        resolveBash: (id, decision, {feedback}) async {
          pending = const ConversationV2PendingInteractions();
          if (actionError != null) throw actionError!;
        },
        approvePlan: () async {},
        dismissPlan: () async {},
        submitClarification: (id, selections, {customInputIndices}) async {},
        dismissClarification: (id) async {},
      ),
    );
    addTearDown(() async {
      await controller.close();
      controller.dispose();
      await directory.delete(recursive: true);
    });
  });

  test(
    'loads complete live MCP requests independently of run detail pages',
    () async {
      pending = const ConversationV2PendingInteractions(bash: approval);
      await controller.start();
      expect(controller.state.pendingBash?.command, approval.command);
      expect(controller.state.pendingBash?.reason, approval.reason);
      expect(controller.state.pendingBash?.mcpToolServerName, 'service');
      expect(controller.state.pendingBash?.mcpToolName, 'write');
    },
  );

  test('historical requests cannot resurrect cancelled approvals', () async {
    remote.bootstrapDetails = [
      const ConversationV2Detail(
        itemId: 'old',
        conversationId: 'thread',
        runId: 'old-run',
        toolCallId: 'mcp_1',
        type: 'approval.requested',
        createdSeq: 1,
        versionSeq: 1,
        content:
            '{"liveType":"bash_approval.requested","bashApproval":{"toolUseId":"mcp_1","phase":"requested","toolName":"Bash"}}',
      ),
    ];
    remote.snapshotSeq = 1;
    await controller.start();
    expect(controller.state.pendingBash, isNull);
  });

  test(
    'push boundaries fetch new requests and desktop resolutions clear them',
    () async {
      await controller.start();
      pending = const ConversationV2PendingInteractions(bash: approval);
      await controller.acceptPushEnvelope(
        _envelope(1, _detailEffect(1, 'approval.requested')),
      );
      expect(controller.state.pendingBash?.toolUseId, 'mcp_1');
      pending = const ConversationV2PendingInteractions();
      await controller.acceptPushEnvelope(
        _envelope(2, _detailEffect(2, 'approval.resolved')),
      );
      expect(controller.state.pendingBash, isNull);
      await controller.acceptPushEnvelope(
        _envelope(3, {'type': 'noop', 'reason': 'token'}),
      );
      expect(controller.state.pendingBash, isNull);
    },
  );

  test(
    'discards an old registry reply after another refresh request',
    () async {
      await controller.start();
      final stale = Completer<ConversationV2PendingInteractions>();
      var calls = 0;
      reply = () => ++calls == 1
          ? stale.future
          : Future.value(const ConversationV2PendingInteractions());
      final seen = <String>[];
      final remove = controller.addListener((s) {
        if (s.pendingBash != null) seen.add(s.pendingBash!.toolUseId);
      });
      addTearDown(remove);
      final first = controller.refreshPendingInteractions();
      final second = controller.refreshPendingInteractions();
      stale.complete(const ConversationV2PendingInteractions(bash: approval));
      await Future.wait([first, second]);
      expect(calls, 2);
      expect(seen, isEmpty);
    },
  );

  test('cross-device resolution races clear the obsolete card', () async {
    pending = const ConversationV2PendingInteractions(bash: approval);
    await controller.start();
    actionError = StateError('No pending Bash approval for this tool use.');
    await expectLater(
      controller.resolveBash('mcp_1', 'approved'),
      throwsStateError,
    );
    expect(controller.state.pendingBash, isNull);
  });

  test(
    'pending read failures expose an error and preserve the last known request',
    () async {
      pending = const ConversationV2PendingInteractions(bash: approval);
      await controller.start();
      reply = () async => throw StateError('pending registry unavailable');
      await controller.refresh();
      expect(
        controller.state.error.toString(),
        contains('pending registry unavailable'),
      );
      expect(controller.state.pendingBash?.toolUseId, 'mcp_1');
      remote.effects.add({'type': 'noop', 'reason': 'unrelated token'});
      await controller.acceptPushEnvelope(_envelope(1, remote.effects.single));
      expect(
        controller.state.error.toString(),
        contains('pending registry unavailable'),
      );
      reply = null;
      pending = const ConversationV2PendingInteractions();
      await controller.refresh();
      expect(controller.state.error, isNull);
      expect(controller.state.pendingBash, isNull);
    },
  );

  test('refresh recovers a lost final message without a later push', () async {
    await controller.start();
    remote.effects.add({
      'type': 'message.create',
      'message': {
        'messageId': 'final',
        'conversationId': 'thread',
        'turnId': 'turn',
        'role': 'assistant',
        'channel': 'answer',
        'createdSeq': 1,
        'versionSeq': 1,
        'contentVersion': 0,
        'body': 'Complete review',
        'status': 'final',
        'isDeleted': false,
      },
    });
    await Future.wait([controller.refresh(), controller.refresh()]);
    expect(controller.state.messages.single.body, 'Complete review');
    expect(controller.state.syncState, ConversationV2SyncState.live);
    expect((await cache.state('thread'))?.appliedSeq, 1);
    expect(remote.syncCalls, 1);
  });

  test(
    'duplicate pushes verify local receipts and still reject conflicts',
    () async {
      remote.effects.addAll(
        List.generate(20, (i) => {'type': 'noop', 'reason': 'token_$i'}),
      );
      await controller.start();
      final before = remote.syncCalls;
      for (var i = 0; i < remote.effects.length; i++) {
        await controller.acceptPushEnvelope(
          _envelope(i + 1, remote.effects[i]),
        );
      }
      expect(remote.syncCalls, before);
      await controller.acceptPushEnvelope(
        _envelope(20, {'type': 'noop', 'reason': 'conflict'}),
      );
      expect(
        controller.state.error.toString(),
        contains('conflicts with the committed effect'),
      );
    },
  );
}

Map<String, dynamic> _detailEffect(int seq, String type) => {
  'type': 'detail.upsert',
  'detail': {
    'itemId': 'detail_$seq',
    'conversationId': 'thread',
    'runId': 'run',
    'toolCallId': 'mcp_1',
    'type': type,
    'createdSeq': seq,
    'versionSeq': seq,
  },
};
Map<String, dynamic> _envelope(int seq, Map<String, dynamic> effect) => {
  'kind': 'conversation.sync_effect',
  'payload': {
    'conversationId': 'thread',
    'storeEpoch': 'epoch',
    'effect': {
      'seq': seq,
      'effectVersion': 1,
      'effectHash': conversationV2StableHash(effect),
      'effect': effect,
    },
  },
};

class _Remote implements ConversationV2Remote {
  List<ConversationV2Detail> bootstrapDetails = [];
  int snapshotSeq = 0;
  int syncCalls = 0;
  final effects = <Map<String, dynamic>>[];
  @override
  Future<ConversationV2Capabilities> capabilities() async =>
      const ConversationV2Capabilities(
        protocolVersion: 2,
        eventSchemaVersion: 1,
        effectVersion: 1,
        maxEvents: 200,
        maxBytes: 512 * 1024,
        storeEpoch: 'epoch',
      );
  @override
  Future<ConversationV2Bootstrap> bootstrap(
    String conversationId, {
    int pageSize = 30,
    int maxBytes = 512 * 1024,
  }) async => ConversationV2Bootstrap(
    protocolVersion: 2,
    storeEpoch: 'epoch',
    conversationId: 'thread',
    snapshotSeq: snapshotSeq,
    historyRevision: 0,
    messages: [],
    runs: [],
    tools: [],
    details: bootstrapDetails,
    olderCursor: null,
    hasOlder: false,
  );
  @override
  Future<ConversationV2Head> head(String conversationId) async =>
      ConversationV2Head(
        protocolVersion: 2,
        storeEpoch: 'epoch',
        conversationId: 'thread',
        lastSeq: effects.length > snapshotSeq ? effects.length : snapshotSeq,
        historyRevision: 0,
      );
  @override
  Future<ConversationV2ProjectionExtras> projectionExtras(
    String conversationId,
  ) async => const ConversationV2ProjectionExtras();
  @override
  Future<ConversationV2SyncPage> sync(
    String conversationId,
    String storeEpoch,
    int afterSeq, {
    int? throughSeq,
    int maxEvents = 200,
    int maxBytes = 512 * 1024,
  }) async {
    syncCalls++;
    final target = throughSeq ?? effects.length;
    return ConversationV2SyncPage(
      protocolVersion: 2,
      storeEpoch: 'epoch',
      conversationId: 'thread',
      fromSeq: afterSeq + 1,
      throughSeq: target,
      headSeq: effects.length,
      hasMore: target < effects.length,
      effects: [
        for (var i = afterSeq; i < target; i++)
          ConversationV2Effect(
            seq: i + 1,
            effectVersion: 1,
            effectHash: conversationV2StableHash(effects[i]),
            type: effects[i]['type'] as String,
            payload: effects[i],
          ),
      ],
    );
  }

  @override
  dynamic noSuchMethod(Invocation invocation) =>
      throw UnimplementedError('$invocation');
}
