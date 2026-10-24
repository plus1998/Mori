import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:eco_mobile/l10n/generated/app_localizations.dart';

import 'package:eco_mobile/core/models/conversation_v2_models.dart';
import 'package:eco_mobile/core/preferences/thinking_display_preferences.dart';
import 'package:eco_mobile/core/utils/activity_display.dart';
import 'package:eco_mobile/features/threads/activity_feed.dart';
import 'package:eco_mobile/features/threads/conversation_v2_activity_feed.dart';
import 'package:eco_mobile/features/threads/conversation_v2_projection.dart';

void main() {
  mainSessionRunningClocks();

  for (final status in ['completed', 'failed']) {
    test('terminal error selection follows the run status: $status', () {
      final projection = buildConversationV2Projection(
        conversationId: 'thread_terminal',
        messages: [
          for (final (seq, role, channel, body) in [
            (1, 'assistant', 'answer', 'Progress reply'),
            (2, 'system', 'system', 'Request failed'),
          ])
            ConversationV2Message(
              messageId: 'message_$seq',
              conversationId: 'thread_terminal',
              turnId: 'turn_1',
              runId: 'run_1',
              role: role,
              channel: channel,
              createdSeq: seq,
              versionSeq: seq,
              contentVersion: 1,
              body: body,
              status: ConversationV2MessageStatus.finalised,
              isDeleted: false,
            ),
        ],
        runs: [
          ConversationV2Run(
            runId: 'run_1',
            conversationId: 'thread_terminal',
            turnId: 'turn_1',
            status: status,
            versionSeq: 3,
            timingQuality: 'recorded',
          ),
        ],
        tools: const [],
      );
      final turn = buildActivityFeed(
        runProjection: projection,
        l10n: lookupAppLocalizations(const Locale('zh')),
      ).singleWhere((entry) => entry.kind == ActivityFeedKind.turn);
      expect(
        turn.finalOutput?.text.trim(),
        status == 'failed' ? 'Request failed' : 'Progress reply',
      );
      expect(turn.processEntries, hasLength(1));
    });
  }

  for (final mode in ThinkingDisplayMode.values) {
    test(
      'SDK state diagnostics stay off the Feed and preserve the final answer: $mode',
      () {
        ConversationV2Message message(
          int seq,
          String role,
          String channel,
          String body,
        ) => ConversationV2Message(
          messageId: 'message_$seq',
          conversationId: 'thread_diagnostics',
          turnId: 'turn_1',
          runId: 'run_1',
          role: role,
          channel: channel,
          providerRole: role == 'assistant' ? 'main' : null,
          createdSeq: seq,
          versionSeq: seq,
          contentVersion: 1,
          body: body,
          status: ConversationV2MessageStatus.finalised,
          isDeleted: false,
        );
        final projection = buildConversationV2Projection(
          conversationId: 'thread_diagnostics',
          messages: [
            message(1, 'user', 'answer', 'question'),
            message(2, 'system', 'commentary', 'Session state: running'),
            message(
              3,
              'system',
              'commentary',
              'Session state: requires_action',
            ),
            message(4, 'assistant', 'commentary', 'I will edit the file.'),
            message(5, 'assistant', 'answer', 'The real answer'),
            message(6, 'system', 'commentary', 'Session state: idle'),
            message(7, 'system', 'commentary', 'Available commands updated.'),
            message(8, 'system', 'system', 'HTTP 503 request failed'),
          ],
          runs: const [
            ConversationV2Run(
              runId: 'run_1',
              conversationId: 'thread_diagnostics',
              turnId: 'turn_1',
              status: 'completed',
              versionSeq: 9,
              timingQuality: 'recorded',
            ),
          ],
          tools: const [],
        );
        expect(
          projection.timeline.where((item) => item.eventType == 'diagnostic'),
          hasLength(4),
        );
        expect(projection.timeline.last.eventType, 'api.error');
        expect(projection.status, 'completed');
        final entries = buildActivityFeed(
          threadId: 'thread_diagnostics',
          runProjection: projection,
          l10n: lookupAppLocalizations(const Locale('zh')),
          thinkingDisplayMode: mode,
        );
        final turn = entries.singleWhere(
          (entry) => entry.kind == ActivityFeedKind.turn,
        );
        expect(turn.finalOutput?.text.trim(), 'The real answer');
        final visible = [
          for (final entry in entries)
            if (entry.kind == ActivityFeedKind.turn) ...[
              ...entry.processEntries,
              ?entry.finalOutput,
            ] else
              entry,
        ];
        expect(
          visible.any((entry) => entry.text.contains('Session state:')),
          isFalse,
        );
        expect(
          visible.any(
            (entry) => entry.text.contains('Available commands updated.'),
          ),
          isFalse,
        );
        expect(
          visible.any((entry) => entry.text.contains('I will edit the file.')),
          isTrue,
        );
        expect(
          visible.any((entry) => entry.kind == ActivityFeedKind.error),
          isTrue,
        );
      },
    );
  }

  test('ordinary messages quoting SDK state text remain visible', () {
    final projection = buildConversationV2Projection(
      conversationId: 'thread_state_quote',
      messages: [
        for (final role in ['user', 'assistant'])
          ConversationV2Message(
            messageId: 'quote_$role',
            conversationId: 'thread_state_quote',
            turnId: 'turn_1',
            role: role,
            channel: 'commentary',
            createdSeq: role == 'user' ? 1 : 2,
            versionSeq: role == 'user' ? 1 : 2,
            contentVersion: 1,
            body: 'Session state: running',
            status: ConversationV2MessageStatus.finalised,
            isDeleted: false,
          ),
      ],
      runs: const [],
      tools: const [],
    );
    expect(
      projection.timeline.every((item) => item.eventType == 'message.final'),
      isTrue,
    );
    final entries = buildActivityFeed(
      runProjection: projection,
      l10n: lookupAppLocalizations(const Locale('zh')),
      groupTurns: false,
    );
    expect(
      entries.where((entry) => entry.text.trim() == 'Session state: running'),
      hasLength(2),
    );
  });

  test('renders a running V2 context compaction detail in the feed', () {
    final projection = buildConversationV2Projection(
      conversationId: 'thread_compaction',
      messages: const [],
      runs: const [
        ConversationV2Run(
          runId: 'run_compaction',
          conversationId: 'thread_compaction',
          turnId: 'turn_compaction',
          status: 'running',
          versionSeq: 2,
          timingQuality: 'recorded',
        ),
      ],
      tools: const [],
      details: const [
        ConversationV2Detail(
          itemId: 'compaction_started',
          conversationId: 'thread_compaction',
          runId: 'run_compaction',
          type: 'context.compaction.started',
          createdSeq: 2,
          versionSeq: 2,
          content:
              '{"message":"正在压缩上下文","observedAt":"2026-10-21T00:00:02.000Z","scope":"main","role":"main"}',
        ),
      ],
    );

    final entries = buildActivityFeed(
      runProjection: projection,
      l10n: lookupAppLocalizations(const Locale('zh')),
      groupTurns: false,
    );

    expect(entries, hasLength(1));
    expect(entries.single.kind, ActivityFeedKind.phase);
    expect(entries.single.text, '正在压缩上下文');
    expect(entries.single.actionIcon, ActivityActionIcon.context);
    expect(entries.single.lifecycle, ToolActionLifecycle.running);
  });

  test('does not render an accepted queued follow-up as a sent user message', () {
    final projection = buildConversationV2Projection(
      conversationId: 'thread_queued_follow_up',
      messages: const [
        ConversationV2Message(
          messageId: 'queued_follow_up',
          conversationId: 'thread_queued_follow_up',
          turnId: 'turn_queued_follow_up',
          role: 'user',
          channel: 'answer',
          createdSeq: 1,
          versionSeq: 1,
          contentVersion: 0,
          body: 'same prompt',
          status: ConversationV2MessageStatus.queued,
          isDeleted: false,
        ),
      ],
      runs: const [],
      tools: const [],
    );

    expect(projection.timeline, isEmpty);
  });

  test('places a finalized queued follow-up after the turn that accepted it', () {
    final projection = buildConversationV2Projection(
      conversationId: 'thread_queued_follow_up_order',
      messages: const [
        ConversationV2Message(
          messageId: 'first_answer',
          conversationId: 'thread_queued_follow_up_order',
          turnId: 'turn_first',
          role: 'assistant',
          channel: 'answer',
          createdSeq: 5,
          versionSeq: 5,
          contentVersion: 0,
          body: '第一轮回答',
          status: ConversationV2MessageStatus.finalised,
          isDeleted: false,
          occurredAt: '2026-09-14T00:00:05.000Z',
        ),
        ConversationV2Message(
          messageId: 'queued_follow_up',
          conversationId: 'thread_queued_follow_up_order',
          turnId: 'turn_queued',
          role: 'user',
          channel: 'answer',
          createdSeq: 3,
          versionSeq: 8,
          contentVersion: 0,
          body: '第二轮问题',
          status: ConversationV2MessageStatus.finalised,
          isDeleted: false,
          occurredAt: '2026-09-14T00:00:08.000Z',
        ),
      ],
      runs: const [],
      tools: const [],
    );

    expect(projection.timeline.map((item) => item.text), ['第一轮回答', '第二轮问题']);
  });

  test(
    'V2 keeps retry identity and history revision on failed-request feed rows',
    () {
      final projection = buildConversationV2Projection(
        conversationId: 'thread_retry',
        messages: const [
          ConversationV2Message(
            messageId: 'user_retry_1',
            conversationId: 'thread_retry',
            turnId: 'turn_retry_1',
            role: 'user',
            channel: 'answer',
            createdSeq: 1,
            versionSeq: 1,
            contentVersion: 1,
            body: 'retry this request',
            status: ConversationV2MessageStatus.finalised,
            isDeleted: false,
            historyTarget: ConversationV2HistoryTarget(
              activityLineId: 'activity_retry_1',
              userMessageId: 'claude-user-1',
            ),
          ),
          ConversationV2Message(
            messageId: 'notice_retry_1',
            conversationId: 'thread_retry',
            turnId: 'turn_retry_1',
            role: 'system',
            channel: 'system',
            runId: 'run_retry_1',
            createdSeq: 3,
            versionSeq: 4,
            contentVersion: 1,
            body: '【连接失败】HTTP 503',
            status: ConversationV2MessageStatus.finalised,
            isDeleted: false,
          ),
        ],
        runs: const [
          ConversationV2Run(
            runId: 'run_retry_1',
            conversationId: 'thread_retry',
            turnId: 'turn_retry_1',
            status: 'failed',
            versionSeq: 2,
            timingQuality: 'recorded',
          ),
        ],
        tools: const [],
        historyRevision: 7,
      );

      final entries = buildActivityFeed(
        runProjection: projection,
        l10n: lookupAppLocalizations(const Locale('zh')),
        groupTurns: false,
      );
      final user = entries.firstWhere(
        (entry) => entry.kind == ActivityFeedKind.user,
      );
      final error = entries.firstWhere(
        (entry) => entry.kind == ActivityFeedKind.error,
      );

      expect(user.activityLineId, 'activity_retry_1');
      expect(user.rewindTarget?.userMessageId, 'claude-user-1');
      expect(user.historyRevision, 7);
      expect(error.sequence, 3);
    },
  );

  test('V2 preserves mobile action grouping and structured tool cards', () {
    final projection = buildConversationV2Projection(
      conversationId: 'thread_1',
      messages: const [
        ConversationV2Message(
          messageId: 'user_1',
          conversationId: 'thread_1',
          turnId: 'turn_1',
          role: 'user',
          channel: 'answer',
          createdSeq: 1,
          versionSeq: 1,
          contentVersion: 1,
          body: 'question',
          status: ConversationV2MessageStatus.finalised,
          isDeleted: false,
        ),
        ConversationV2Message(
          messageId: 'answer_1',
          conversationId: 'thread_1',
          turnId: 'turn_1',
          role: 'assistant',
          channel: 'answer',
          runId: 'run_1',
          createdSeq: 6,
          versionSeq: 7,
          contentVersion: 1,
          body: 'done',
          status: ConversationV2MessageStatus.finalised,
          isDeleted: false,
        ),
      ],
      runs: const [
        ConversationV2Run(
          runId: 'run_1',
          conversationId: 'thread_1',
          turnId: 'turn_1',
          status: 'completed',
          versionSeq: 2,
          timingQuality: 'recorded',
        ),
      ],
      tools: const [
        ConversationV2Tool(
          toolCallId: 'tool_1',
          conversationId: 'thread_1',
          runId: 'run_1',
          name: 'Bash',
          status: 'completed',
          createdSeq: 3,
          versionSeq: 4,
          input: {
            'command': 'ls -la',
            'bashApproval': {
              'toolUseId': 'tool_1',
              'toolName': 'Bash',
              'phase': 'requested',
              'detail': 'ls -la',
            },
          },
        ),
        ConversationV2Tool(
          toolCallId: 'tool_2',
          conversationId: 'thread_1',
          runId: 'run_1',
          name: 'Read',
          status: 'completed',
          createdSeq: 4,
          versionSeq: 5,
          input: {'file_path': '/tmp/report.md', 'offset': 1, 'limit': 5},
        ),
      ],
    );

    final entries = buildActivityFeed(
      runProjection: projection,
      l10n: lookupAppLocalizations(const Locale('zh')),
    );

    expect(entries.map((entry) => entry.kind), [
      ActivityFeedKind.user,
      ActivityFeedKind.turn,
    ]);
    final turn = entries.last;
    expect(turn.processEntries, hasLength(1));
    expect(turn.processEntries.single.kind, ActivityFeedKind.actionGroup);
    expect(turn.processEntries.single.actionChildren, hasLength(2));
    expect(turn.processEntries.single.actionChildren.first.bashRun, isNotNull);
    expect(
      turn.processEntries.single.actionChildren.first.lifecycle,
      ToolActionLifecycle.approvalPending,
    );
    // Desktop parity: the read row keeps the file name plus the line range
    // instead of the transport path.
    expect(
      turn.processEntries.single.actionChildren.last.text,
      'report.md:L1-5',
    );
  });

  test('single V2 tool rows never repeat the generic verb label', () {
    final l10n = lookupAppLocalizations(const Locale('zh'));

    for (final tool in const [
      ConversationV2Tool(
        toolCallId: 'read_1',
        conversationId: 'thread_1',
        runId: 'run_1',
        name: 'Read',
        status: 'completed',
        createdSeq: 3,
        versionSeq: 4,
      ),
      ConversationV2Tool(
        toolCallId: 'bash_1',
        conversationId: 'thread_1',
        runId: 'run_1',
        name: 'Bash',
        status: 'completed',
        createdSeq: 3,
        versionSeq: 4,
      ),
    ]) {
      final projection = buildConversationV2Projection(
        conversationId: 'thread_1',
        messages: const [],
        runs: const [
          ConversationV2Run(
            runId: 'run_1',
            conversationId: 'thread_1',
            turnId: 'turn_1',
            status: 'completed',
            versionSeq: 2,
            timingQuality: 'recorded',
          ),
        ],
        tools: [tool],
      );
      final entries = buildActivityFeed(
        runProjection: projection,
        l10n: l10n,
        groupTurns: false,
      );
      final group = entries.single;
      expect(group.kind, ActivityFeedKind.actionGroup);
      expect(group.actionChildren, hasLength(1));
      // Before the guard the header re-used the child label as a target and
      // rendered "读取了 读取了文件" / "运行了 运行了命令".
      expect(group.text, anyOf('读取了文件', '运行了命令'));
      expect(group.actionChildren.single.text, anyOf('读取了文件', '运行了命令'));
    }
  });

  test('V2 rows written before structured input still show their target', () {
    // Older builds stored only the legacy display detail in `output`
    // (`input_json` was NULL), which used to degrade every tool row to
    // "读取了文件" / "运行了命令".
    final projection = buildConversationV2Projection(
      conversationId: 'thread_1',
      messages: const [],
      runs: const [
        ConversationV2Run(
          runId: 'run_1',
          conversationId: 'thread_1',
          turnId: 'run_1',
          status: 'completed',
          versionSeq: 2,
          timingQuality: 'recorded',
        ),
      ],
      tools: const [
        ConversationV2Tool(
          toolCallId: 'read_1',
          conversationId: 'thread_1',
          runId: 'run_1',
          name: 'Read',
          status: 'completed',
          createdSeq: 3,
          versionSeq: 4,
          output: 'productLabelName.service.ts',
        ),
        ConversationV2Tool(
          toolCallId: 'bash_1',
          conversationId: 'thread_1',
          runId: 'run_1',
          name: 'Bash',
          status: 'completed',
          createdSeq: 4,
          versionSeq: 5,
          output: 'npm test',
        ),
      ],
    );

    final entries = buildActivityFeed(
      runProjection: projection,
      l10n: lookupAppLocalizations(const Locale('zh')),
      groupTurns: false,
    );
    final group = entries.single;
    expect(group.kind, ActivityFeedKind.actionGroup);
    expect(group.actionChildren, hasLength(2));
    expect(group.actionChildren.first.text, 'productLabelName.service.ts');
    expect(group.actionChildren.last.text, 'npm test');
    // The header keeps its verb-count summary, and the rows are never the
    // generic labels or a doubled verb.
    expect(group.text, isNot(contains('读取了文件')));
    expect(group.text, isNot(contains('读取了 读取了')));
    expect(group.text, isNot(contains('运行了 运行了')));
  });

  test('V2 read rows show the file with its line range', () {
    final projection = buildConversationV2Projection(
      conversationId: 'thread_1',
      messages: const [],
      runs: const [
        ConversationV2Run(
          runId: 'run_1',
          conversationId: 'thread_1',
          turnId: 'turn_1',
          status: 'completed',
          versionSeq: 2,
          timingQuality: 'recorded',
        ),
      ],
      tools: const [
        ConversationV2Tool(
          toolCallId: 'read_1',
          conversationId: 'thread_1',
          runId: 'run_1',
          name: 'Read',
          status: 'completed',
          createdSeq: 3,
          versionSeq: 4,
          input: {
            'file_path': 'lib/features/feed.dart',
            'offset': 12,
            'limit': 29,
          },
        ),
      ],
    );

    final entries = buildActivityFeed(
      runProjection: projection,
      l10n: lookupAppLocalizations(const Locale('zh')),
      groupTurns: false,
    );
    final group = entries.single;
    expect(group.kind, ActivityFeedKind.actionGroup);
    expect(group.actionChildren.single.text, 'feed.dart:L12-40');
    // The header keeps the file name and the line range instead of repeating
    // the verb or dropping the range.
    expect(group.text, '读取了 feed.dart L12-40');
  });

  test('V2 keeps file-change and web-search presentation metadata', () {
    final projection = buildConversationV2Projection(
      conversationId: 'thread_1',
      messages: const [
        ConversationV2Message(
          messageId: 'user_1',
          conversationId: 'thread_1',
          turnId: 'turn_1',
          role: 'user',
          channel: 'answer',
          createdSeq: 1,
          versionSeq: 1,
          contentVersion: 1,
          body: 'edit the file',
          status: ConversationV2MessageStatus.finalised,
          isDeleted: false,
        ),
      ],
      runs: const [
        ConversationV2Run(
          runId: 'run_1',
          conversationId: 'thread_1',
          turnId: 'turn_1',
          status: 'completed',
          versionSeq: 2,
          timingQuality: 'recorded',
        ),
      ],
      tools: const [
        ConversationV2Tool(
          toolCallId: 'edit_1',
          conversationId: 'thread_1',
          runId: 'run_1',
          name: 'Edit',
          status: 'completed',
          createdSeq: 3,
          versionSeq: 4,
          input: {
            'file_path': 'src/app.ts',
            'old_string': 'old',
            'new_string': 'new',
            'fileChange': {
              'path': 'src/app.ts',
              'additions': 1,
              'deletions': 1,
              'previewLines': [
                {'kind': 'add', 'text': 'new'},
                {'kind': 'remove', 'text': 'old'},
              ],
            },
          },
        ),
        ConversationV2Tool(
          toolCallId: 'search_1',
          conversationId: 'thread_1',
          runId: 'run_1',
          name: 'WebSearch',
          status: 'completed',
          createdSeq: 4,
          versionSeq: 5,
          input: {
            'webSearch': {'query': 'eco coding'},
          },
        ),
      ],
    );

    final entries = buildActivityFeed(
      runProjection: projection,
      l10n: lookupAppLocalizations(const Locale('zh')),
    );
    final turn = entries.last;
    final actions = turn.processEntries.single.actionChildren;
    expect(actions, hasLength(2));
    expect(actions[0].fileChange, isNotNull);
    expect(actions[0].fileChange?.path, 'src/app.ts');
    expect(actions[1].webSearch, isNotNull);
    expect(actions[1].webSearch?.query, 'eco coding');
  });

  test('V2 keeps user image previews on the user bubble', () {
    final projection = buildConversationV2Projection(
      conversationId: 'thread_1',
      messages: const [
        ConversationV2Message(
          messageId: 'user_1',
          conversationId: 'thread_1',
          turnId: 'turn_1',
          role: 'user',
          channel: 'answer',
          createdSeq: 1,
          versionSeq: 1,
          contentVersion: 1,
          body: 'look at this',
          status: ConversationV2MessageStatus.finalised,
          isDeleted: false,
          attachments: [
            {'id': 'image_1', 'mediaType': 'image/jpeg', 'data': 'aGVsbG8='},
          ],
        ),
      ],
      runs: const [],
      tools: const [],
    );

    final entries = buildActivityFeed(
      runProjection: projection,
      l10n: lookupAppLocalizations(const Locale('zh')),
    );

    expect(entries.single.kind, ActivityFeedKind.user);
    expect(entries.single.attachments, hasLength(1));
    expect(entries.single.attachments.single.mediaType, 'image/jpeg');
  });

  test('orders V2 messages and shows explicit run/tool summaries', () {
    final projection = buildConversationV2Projection(
      conversationId: 'thread_1',
      messages: [
        const ConversationV2Message(
          messageId: 'answer_1',
          conversationId: 'thread_1',
          turnId: 'turn_1',
          role: 'assistant',
          channel: 'answer',
          createdSeq: 4,
          versionSeq: 5,
          contentVersion: 1,
          body: 'answer',
          status: ConversationV2MessageStatus.finalised,
          isDeleted: false,
        ),
        const ConversationV2Message(
          messageId: 'user_1',
          conversationId: 'thread_1',
          turnId: 'turn_1',
          role: 'user',
          channel: 'answer',
          createdSeq: 1,
          versionSeq: 1,
          contentVersion: 1,
          body: 'question',
          status: ConversationV2MessageStatus.finalised,
          isDeleted: false,
        ),
      ],
      runs: [
        const ConversationV2Run(
          runId: 'run_1',
          conversationId: 'thread_1',
          turnId: 'turn_1',
          status: 'completed',
          versionSeq: 3,
          timingQuality: 'recorded',
        ),
      ],
      tools: [
        const ConversationV2Tool(
          toolCallId: 'tool_1',
          conversationId: 'thread_1',
          runId: 'run_1',
          name: 'Read',
          status: 'completed',
          createdSeq: 2,
          versionSeq: 2,
        ),
      ],
    );

    final entries = buildActivityFeed(
      threadPrompt: '',
      threadId: 'thread_1',
      runProjection: projection,
      l10n: lookupAppLocalizations(const Locale('zh')),
    );

    // The Feed draws the rows the V2 store holds in the order their sequences put them:
    // the question, then the call it triggered, then the turn's phase row, then the answer.
    // The Feed draws the question, then the turn the V2 store recorded: the call the turn
    // made and the answer it ended with. A single attempt is the turn itself, so it has no
    // row of its own — the row that carries the attempt id is the turn.
    expect(entries.map((entry) => entry.kind), [
      ActivityFeedKind.user,
      ActivityFeedKind.turn,
    ]);
    expect(entries.first.text.trim(), 'question');
    final turn = entries.last;
    expect(turn.runAttemptId, 'run_1');
    expect(turn.finalOutput?.text.trim(), 'answer');

    final children = turn.processEntries.expand(
      (entry) => entry.kind == ActivityFeedKind.actionGroup
          ? entry.actionChildren
          : [entry],
    );
    expect(children.map((entry) => entry.toolUseId), ['tool_1']);
    expect(children.single.kind, ActivityFeedKind.action);
  });

  test('filters tool detail to the explicit run and tool identity', () {
    final page = ConversationV2DetailPage(
      protocolVersion: 2,
      storeEpoch: 'epoch_1',
      conversationId: 'thread_1',
      readSeq: 4,
      historyRevision: 0,
      items: const [
        ConversationV2Detail(
          itemId: 'detail_1',
          conversationId: 'thread_1',
          runId: 'run_1',
          agentId: 'agent_role_1',
          agentInstanceId: 'agent_instance_1',
          parentAgentInstanceId: 'parent_instance_1',
          parentAgentId: 'parent_role_1',
          parentToolCallId: 'parent_tool_1',
          toolCallId: 'tool_1',
          type: 'tool.output',
          createdSeq: 3,
          versionSeq: 7,
          content: '',
          ref: '',
        ),
        ConversationV2Detail(
          itemId: 'detail_2',
          conversationId: 'thread_1',
          runId: 'run_2',
          toolCallId: 'tool_1',
          type: 'tool.output',
          createdSeq: 4,
          versionSeq: 4,
          content: 'other run',
        ),
      ],
      nextCursor: null,
      hasMore: false,
    );

    final entries = buildConversationV2ToolDetailFeed(
      page,
      runId: 'run_1',
      toolCallId: 'tool_1',
    );

    expect(entries.map((entry) => entry.id), ['v2-detail:detail_1']);
    final entry = entries.single;
    expect(entry.text, 'tool.output');
    expect(entry.agentId, 'agent_role_1');
    expect(entry.conversationV2Detail, page.items.first.toJson());
    expect(entry.conversationV2Detail, {
      'itemId': 'detail_1',
      'conversationId': 'thread_1',
      'runId': 'run_1',
      'agentId': 'agent_role_1',
      'agentInstanceId': 'agent_instance_1',
      'parentAgentInstanceId': 'parent_instance_1',
      'parentAgentId': 'parent_role_1',
      'parentToolCallId': 'parent_tool_1',
      'toolCallId': 'tool_1',
      'type': 'tool.output',
      'createdSeq': 3,
      'versionSeq': 7,
      'content': '',
      'ref': '',
    });
    expect(
      entry.withSequence(30).conversationV2Detail,
      entry.conversationV2Detail,
    );
    expect(
      entry
          .withIdAtSequence(id: 'renumbered_detail', sequence: 31)
          .conversationV2Detail,
      entry.conversationV2Detail,
    );
  });

  test('ephemeral mode hides completed thinking but keeps streaming thinking', () {
    const completed = ConversationV2Message(
      messageId: 'thinking_done',
      conversationId: 'thread_1',
      turnId: 'turn_1',
      role: 'assistant',
      channel: 'thinking',
      createdSeq: 1,
      versionSeq: 2,
      contentVersion: 1,
      body: 'finished reasoning',
      status: ConversationV2MessageStatus.finalised,
      isDeleted: false,
      runId: 'run_1',
    );
    const streaming = ConversationV2Message(
      messageId: 'thinking_live',
      conversationId: 'thread_1',
      turnId: 'turn_1',
      role: 'assistant',
      channel: 'thinking',
      createdSeq: 3,
      versionSeq: 3,
      contentVersion: 0,
      body: 'live reasoning',
      status: ConversationV2MessageStatus.streaming,
      isDeleted: false,
      runId: 'run_1',
    );
    final projection = buildConversationV2Projection(
      conversationId: 'thread_1',
      messages: const [completed, streaming],
      runs: const [],
      tools: const [],
    );
    List<ActivityFeedEntry> render(ThinkingDisplayMode mode) {
      final entries = buildActivityFeed(
        threadPrompt: '',
        threadId: 'thread_1',
        runProjection: projection,
        l10n: lookupAppLocalizations(const Locale('zh')),
        thinkingDisplayMode: mode,
        conversationLive: true,
      );
      return entries
          .expand(
            (entry) => entry.kind == ActivityFeedKind.turn
                ? [...entry.processEntries, ?entry.finalOutput]
                : [entry],
          )
          .toList();
    }

    // Finished reasoning is a working-stage symptom: the tip mode drops it, because the
    // answer that follows is what the reader wants. The live row is kept — it is the
    // reason the Feed still says the run is working.
    final ephemeral = render(ThinkingDisplayMode.ephemeral);
    expect(ephemeral.map((entry) => entry.text.trim()), ['live reasoning']);
    expect(ephemeral.single.streaming, isTrue);
    // Collapsed mode keeps both: nothing is hidden, the blocks are merely folded into one
    // row that stands where the last block happened.
    final collapsed = render(ThinkingDisplayMode.collapsed);
    expect(collapsed, hasLength(1));
    expect(
      collapsed.single.text.trim(),
      'finished reasoning\n\nlive reasoning',
    );
  });

  test('ephemeral mode drops the reasoning tip once the run has terminated', () {
    // Supersede-by-event only works while the run keeps producing. A run that ended
    // without landing a hard event after the tip must not leave 阅后即焚 content
    // parked on the Feed, still cycling its stages.
    const tip = ConversationV2Message(
      messageId: 'thinking_tip',
      conversationId: 'thread_1',
      turnId: 'turn_1',
      role: 'assistant',
      channel: 'thinking',
      createdSeq: 1,
      versionSeq: 2,
      contentVersion: 1,
      body: '定位入口',
      status: ConversationV2MessageStatus.finalised,
      isDeleted: false,
      runId: 'run_1',
    );
    final projection = buildConversationV2Projection(
      conversationId: 'thread_1',
      messages: const [tip],
      runs: const [
        ConversationV2Run(
          runId: 'run_1',
          conversationId: 'thread_1',
          turnId: 'turn_1',
          status: 'completed',
          versionSeq: 3,
          timingQuality: 'recorded',
        ),
      ],
      tools: const [],
    );
    final entries = buildActivityFeed(
      threadPrompt: '',
      threadId: 'thread_1',
      runProjection: projection,
      l10n: lookupAppLocalizations(const Locale('zh')),
      thinkingDisplayMode: ThinkingDisplayMode.ephemeral,
    );
    final texts = entries
        .expand(
          (entry) => entry.kind == ActivityFeedKind.turn
              ? [...entry.processEntries, ?entry.finalOutput]
              : [entry],
        )
        .map((entry) => entry.text.trim())
        .toList();

    expect(texts, isNot(contains('定位入口')));
  });
}

void mainSessionRunningClocks() {
  test('session running state joins the lifecycle and V2 stream clocks', () {
    final running = ConversationV2Run(
      runId: 'run_1',
      conversationId: 'thread_1',
      turnId: 'run_1',
      status: 'running',
      versionSeq: 10,
      timingQuality: 'recorded',
    );
    final failed = ConversationV2Run(
      runId: 'run_2',
      conversationId: 'thread_1',
      turnId: 'run_2',
      status: 'failed',
      versionSeq: 20,
      timingQuality: 'recorded',
    );

    // Lifecycle already reported its terminal status, but the V2 run this feed
    // is still printing from is active: stay running.
    expect(
      resolveSessionRunning(
        lifecycleRunning: false,
        v2StreamTrusted: true,
        runs: const [],
      ),
      isFalse,
    );
    expect(
      resolveSessionRunning(
        lifecycleRunning: false,
        v2StreamTrusted: true,
        runs: [running],
      ),
      isTrue,
    );
    // Old conversations carry no V2 runs: the lifecycle clock stays in charge
    // instead of the session being stuck in the running state.
    expect(
      resolveSessionRunning(
        lifecycleRunning: false,
        v2StreamTrusted: false,
        runs: [running],
      ),
      isFalse,
    );
    expect(
      resolveSessionRunning(
        lifecycleRunning: true,
        v2StreamTrusted: false,
        runs: const [],
      ),
      isTrue,
    );
    // Only the newest run decides: a finished retry closes the turn.
    expect(
      resolveSessionRunning(
        lifecycleRunning: false,
        v2StreamTrusted: true,
        runs: [running, failed],
      ),
      isFalse,
    );
    expect(hasActiveConversationV2Run([failed]), isFalse);
    expect(hasActiveConversationV2Run([running, failed]), isFalse);
  });

  test('placeholder stream rows cannot keep a V2 turn streaming forever', () {
    final projection = buildConversationV2Projection(
      conversationId: 'thread_1',
      messages: const [
        ConversationV2Message(
          messageId: 'user_1',
          conversationId: 'thread_1',
          turnId: 'turn_1',
          role: 'user',
          channel: 'answer',
          createdSeq: 1,
          versionSeq: 1,
          contentVersion: 1,
          body: 'question',
          status: ConversationV2MessageStatus.finalised,
          isDeleted: false,
        ),
        // Never-finalized placeholder row (empty body, status streaming).
        ConversationV2Message(
          messageId: 'answer_1',
          conversationId: 'thread_1',
          turnId: 'turn_1',
          role: 'assistant',
          channel: 'answer',
          createdSeq: 2,
          versionSeq: 2,
          contentVersion: 1,
          body: '',
          status: ConversationV2MessageStatus.streaming,
          isDeleted: false,
        ),
        ConversationV2Message(
          messageId: 'answer_2',
          conversationId: 'thread_1',
          turnId: 'turn_1',
          role: 'assistant',
          channel: 'answer',
          createdSeq: 3,
          versionSeq: 3,
          contentVersion: 1,
          body: 'done',
          status: ConversationV2MessageStatus.finalised,
          isDeleted: false,
        ),
      ],
      runs: const [
        ConversationV2Run(
          runId: 'run_1',
          conversationId: 'thread_1',
          turnId: 'run_1',
          status: 'completed',
          versionSeq: 4,
          timingQuality: 'recorded',
        ),
      ],
      tools: const [],
    );

    expect(projection.timeline.map((item) => item.text), ['question', 'done']);
    expect(
      projection.timeline.any((item) => item.eventType == 'message.delta'),
      isFalse,
    );
  });

  test("keeps a subagent's V2 narration out of the main feed", () {
    final projection = buildConversationV2Projection(
      conversationId: 'thread_1',
      messages: const [
        ConversationV2Message(
          messageId: 'user_1',
          conversationId: 'thread_1',
          turnId: 'turn_1',
          role: 'user',
          channel: 'answer',
          createdSeq: 1,
          versionSeq: 1,
          contentVersion: 1,
          body: 'question',
          status: ConversationV2MessageStatus.finalised,
          isDeleted: false,
        ),
        ConversationV2Message(
          messageId: 'message_agent',
          conversationId: 'thread_1',
          turnId: 'turn_1',
          role: 'assistant',
          channel: 'answer',
          runId: 'run_1',
          agentId: 'main:attempt_1',
          agentInstanceId: 'main:attempt_1',
          createdSeq: 5,
          versionSeq: 6,
          contentVersion: 1,
          body: '辅助模型已允许 Grep：/repo',
          status: ConversationV2MessageStatus.finalised,
          isDeleted: false,
        ),
      ],
      runs: const [
        ConversationV2Run(
          runId: 'run_1',
          conversationId: 'thread_1',
          turnId: 'turn_1',
          status: 'completed',
          versionSeq: 2,
          timingQuality: 'recorded',
        ),
      ],
      tools: const [
        ConversationV2Tool(
          toolCallId: 'tool_1',
          conversationId: 'thread_1',
          runId: 'run_1',
          agentId: 'main:attempt_1',
          name: 'Grep',
          status: 'completed',
          createdSeq: 3,
          versionSeq: 4,
        ),
      ],
    );

    // The legacy projection kept agent-scoped rows off the main timeline; merged
    // V2 rows have to be routed to the same card or the subagent's narration leaks
    // into the main Feed.
    expect(
      projection.timeline.map((item) => item.id),
      isNot(contains('message_agent')),
    );
    final agent = projection.agents.single;
    expect(agent.agentId, 'main:attempt_1');
    expect(agent.timeline.map((item) => item.id), contains('message_agent'));
    expect(
      agent.timeline.firstWhere((item) => item.id == 'message_agent').scope,
      'agent',
    );
  });

  test('carries the provider role and the row time the Feed reads', () {
    // Two facts the desktop Feed has and mobile used to drop: the provider's own role
    // label (the turn's final output is the row with `role == 'main'`) and when a row
    // happened (mobile derived a clock from the sequence number, so a row could not be
    // placed between the two tools of its own turn).
    final projection = buildConversationV2Projection(
      conversationId: 'thread_1',
      messages: const [
        ConversationV2Message(
          messageId: 'message_plan',
          conversationId: 'thread_1',
          turnId: 'turn_1',
          role: 'assistant',
          providerRole: 'main',
          agentId: 'agent_orphan',
          agentInstanceId: 'agent_instance_1',
          channel: 'answer',
          runId: 'run_1',
          createdSeq: 9,
          versionSeq: 9,
          contentVersion: 1,
          body: 'the answer',
          occurredAt: '2026-01-01T00:00:07.000Z',
          status: ConversationV2MessageStatus.finalised,
          isDeleted: false,
        ),
      ],
      runs: const [
        ConversationV2Run(
          runId: 'run_1',
          conversationId: 'thread_1',
          turnId: 'turn_1',
          status: 'completed',
          versionSeq: 2,
          timingQuality: 'recorded',
        ),
      ],
      tools: const [
        ConversationV2Tool(
          toolCallId: 'tool_1',
          conversationId: 'thread_1',
          runId: 'run_1',
          name: 'Bash',
          status: 'completed',
          createdSeq: 4,
          versionSeq: 4,
          agentId: 'agent_orphan',
          agentInstanceId: 'agent_instance_1',
          parentAgentInstanceId: 'parent_agent_1',
          parentToolCallId: 'parent_tool_1',
          occurredAt: '2026-01-01T00:00:03.000Z',
        ),
      ],
      agents: const [
        ConversationV2Agent(
          agentId: 'agent_orphan',
          conversationId: 'thread_1',
          role: 'main',
          kind: 'main',
          status: 'completed',
          versionSeq: 9,
        ),
      ],
    );

    final answer = projection.timeline.singleWhere(
      (item) => item.id == 'message_plan',
    );
    expect(answer.role, 'main');
    expect(answer.agentId, 'agent_orphan');
    expect(answer.streamKey, 'message_plan');
    expect(answer.at, '2026-01-01T00:00:07.000Z');
    expect(answer.metadata, {
      'v2': true,
      'conversationV2MessageId': 'message_plan',
      'conversationV2TurnId': 'turn_1',
      'conversationV2VersionSeq': 9,
      'conversationV2ContentVersion': 1,
      'conversationV2Channel': 'answer',
      'conversationV2Status': 'final',
      'logicalEntityId': 'message_plan',
      'conversationV2AgentInstanceId': 'agent_instance_1',
    });
    final tool = projection.timeline.singleWhere((item) => item.id == 'tool_1');
    expect(tool.agentId, 'agent_orphan');
    expect(tool.at, '2026-01-01T00:00:03.000Z');
    expect(tool.metadata?['conversationV2ToolCallId'], 'tool_1');
    expect(tool.metadata?['conversationV2VersionSeq'], 4);
    expect(tool.metadata?['conversationV2AgentInstanceId'], 'agent_instance_1');
    expect(
      tool.metadata?['conversationV2ParentAgentInstanceId'],
      'parent_agent_1',
    );
    expect(tool.metadata?['conversationV2ParentToolCallId'], 'parent_tool_1');
    // The tool happened before the answer even though its sequence is lower than the
    // answer's only by chance: placement follows the recorded times.
    expect(
      projection.timeline.indexWhere((item) => item.id == 'tool_1'),
      lessThan(
        projection.timeline.indexWhere((item) => item.id == 'message_plan'),
      ),
    );
  });

  test('carries the complete agent registry row into the mobile Feed', () {
    final projection = buildConversationV2Projection(
      conversationId: 'thread_1',
      messages: const [],
      runs: const [],
      tools: const [],
      agents: const [
        ConversationV2Agent(
          agentId: 'agent_1',
          conversationId: 'thread_1',
          role: 'researcher',
          kind: 'subagent',
          status: 'completed',
          versionSeq: 4,
          runId: 'run_1',
          parentAgentInstanceId: 'parent_agent_1',
          parentToolCallId: 'parent_tool_1',
          startedAt: '2026-01-01T00:00:01.000Z',
          endedAt: '2026-01-01T00:00:04.000Z',
          mission: 'inspect the durable stream',
          taskName: 'stream audit',
          delegationSummary: 'audit summary',
          delegationPrompt: 'audit prompt',
          todoId: 'todo_1',
        ),
      ],
    );

    final agent = projection.agents.single;
    expect(agent.mission, 'inspect the durable stream');
    expect(agent.todoId, 'todo_1');
    expect(agent.parentAgentId, 'parent_agent_1');
    expect(agent.parentToolUseId, 'parent_tool_1');
    expect(agent.runAttemptId, 'run_1');
    expect(agent.startedAt, '2026-01-01T00:00:01.000Z');
    expect(agent.endedAt, '2026-01-01T00:00:04.000Z');
    expect(agent.durationMs, 3000);

    final card = buildActivityFeed(
      runProjection: projection,
      l10n: lookupAppLocalizations(const Locale('zh')),
    ).single;
    expect(card.kind, ActivityFeedKind.subagentMission);
    expect(card.missionPrompt, 'audit prompt');
    expect(card.taskName, 'stream audit');
    expect(card.agentId, 'agent_1');
    expect(card.running, isFalse);
  });

  test(
    'keeps a subagent message on the feed when no agent card can hold it',
    () {
      final projection = buildConversationV2Projection(
        conversationId: 'thread_1',
        messages: const [
          ConversationV2Message(
            messageId: 'message_orphan',
            conversationId: 'thread_1',
            turnId: 'turn_1',
            role: 'assistant',
            channel: 'answer',
            runId: 'run_1',
            agentId: 'main:missing_card',
            createdSeq: 5,
            versionSeq: 6,
            contentVersion: 1,
            body: '辅助模型已允许 Grep：/repo',
            status: ConversationV2MessageStatus.finalised,
            isDeleted: false,
          ),
        ],
        runs: const [],
        tools: const [],
      );

      final orphan = projection.timeline.singleWhere(
        (item) => item.id == 'message_orphan',
      );
      expect(orphan.scope, 'main');
      expect(projection.agents, isEmpty);
    },
  );
}
