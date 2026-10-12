import 'package:flutter_test/flutter_test.dart';

import 'package:eco_mobile/core/models/conversation_v2_models.dart';
import 'package:eco_mobile/core/models/conversation_v2_projection_models.dart';
import 'package:eco_mobile/core/preferences/thinking_display_preferences.dart';
import 'package:eco_mobile/features/threads/activity_feed.dart';
import 'package:eco_mobile/features/threads/conversation_v2_projection.dart';

ConversationV2Message tip({
  String id = 'old-tip',
  String runId = 'old-run',
  String? agentId,
  int sequence = 1,
}) => ConversationV2Message(
  messageId: id,
  conversationId: 'thread',
  turnId: 'turn',
  role: 'assistant',
  channel: 'thinking',
  createdSeq: sequence,
  versionSeq: sequence,
  contentVersion: 1,
  body: id,
  status: ConversationV2MessageStatus.finalised,
  isDeleted: false,
  runId: runId,
  agentId: agentId,
);

ConversationV2Run run({
  String id = 'old-run',
  String status = 'cancelled',
  int sequence = 2,
  String? retryOf,
}) => ConversationV2Run(
  runId: id,
  conversationId: 'thread',
  turnId: 'turn',
  status: status,
  versionSeq: sequence,
  timingQuality: 'recorded',
  retryOfRunId: retryOf,
);

List<ActivityFeedEntry> feed(
  ThreadRunProjectionSnapshot projection, {
  bool? conversationLive,
  ThinkingDisplayMode mode = ThinkingDisplayMode.ephemeral,
}) => buildActivityFeed(
  threadPrompt: '',
  threadId: 'thread',
  runProjection: projection,
  conversationLive: conversationLive,
  thinkingDisplayMode: mode,
  groupTurns: false,
);

void main() {
  test('missing run coverage cannot keep a stopped reasoning tip alive', () {
    final projection = buildConversationV2Projection(
      conversationId: 'thread',
      messages: [tip()],
      runs: const [],
      tools: const [],
    );
    expect(projection.attempts, isEmpty);
    expect(feed(projection), isEmpty);
    // The lifecycle clock keeps the tip visible during a real live bootstrap,
    // then removes it even when no run row arrives in between.
    expect(feed(projection, conversationLive: true).single.text, 'old-tip');
    final stopped = resolveThreadSessionDisplayFeedEntries(
      feedEntries: feed(projection, conversationLive: false),
      threadId: 'thread',
      threadPrompt: '',
      isRunning: false,
    );
    expect(stopped, isEmpty);
  });

  test('retry startup never resurrects a terminal run tip', () {
    for (final status in ['completed', 'failed', 'cancelled', 'interrupted']) {
      final oldRun = run(status: status);
      final retry = run(
        id: 'retry-run',
        status: 'running',
        sequence: 3,
        retryOf: 'old-run',
      );
      ThreadRunProjectionSnapshot project(
        List<ConversationV2Message> messages,
      ) => buildConversationV2Projection(
        conversationId: 'thread',
        messages: messages,
        runs: [oldRun, retry],
        tools: const [],
      );
      final retryPending = project([tip()]);
      expect(feed(retryPending), isEmpty, reason: status);
      expect(
        feed(retryPending, conversationLive: true),
        isEmpty,
        reason: 'a live session cannot revive a $status run tip',
      );
      final retryThinking = project([
        tip(),
        tip(id: 'new-tip', runId: 'retry-run', sequence: 4),
      ]);
      expect(feed(retryThinking).single.text, 'new-tip');
      expect(feed(retryThinking).single.streaming, isTrue);
      for (final mode in [
        ThinkingDisplayMode.collapsed,
        ThinkingDisplayMode.expanded,
      ]) {
        expect(feed(retryPending, mode: mode).single.text, 'old-tip');
      }
    }
  });

  test('subagent tip expires independently while its parent is running', () {
    for (final status in ['completed', 'interrupted', 'running']) {
      final projection = buildConversationV2Projection(
        conversationId: 'thread',
        messages: [tip(id: 'child-tip', agentId: 'child')],
        runs: [run(status: 'running')],
        tools: const [],
        agents: [
          ConversationV2Agent(
            agentId: 'child',
            conversationId: 'thread',
            role: 'coder',
            kind: 'subagent',
            status: status,
            versionSeq: 3,
            runId: 'old-run',
          ),
        ],
      );
      final card = feed(projection).single;
      if (status == 'running') {
        expect(card.running, isTrue);
        expect(card.timeline.single.label, 'child-tip');
        expect(card.statusText, 'child-tip');
        final stoppedCard = feed(projection, conversationLive: false).single;
        expect(stoppedCard.timeline, isEmpty);
        expect(stoppedCard.statusText, isNot('child-tip'));
      } else {
        expect(card.running, isFalse);
        expect(card.timeline, isEmpty);
        expect(card.statusText, isNull);
        expect(
          feed(
            projection,
            mode: ThinkingDisplayMode.expanded,
          ).single.timeline.single.label,
          contains('child-tip'),
        );
      }
    }
  });
}
