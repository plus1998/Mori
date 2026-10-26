import 'package:eco_mobile/core/models/conversation_v2_models.dart';
import 'package:eco_mobile/core/preferences/thinking_display_preferences.dart';
import 'package:eco_mobile/features/threads/activity_feed.dart';
import 'package:eco_mobile/features/threads/conversation_v2_projection.dart';
import 'package:flutter_test/flutter_test.dart';

const _at = '2026-10-26T18:01:36.000Z';

ConversationV2Message _message(
  String id,
  int sequence, {
  String role = 'assistant',
  String channel = 'answer',
  ConversationV2MessageStatus status = ConversationV2MessageStatus.finalised,
}) => ConversationV2Message(
  messageId: id,
  conversationId: 'thread',
  turnId: 'turn',
  runId: role == 'user' ? null : 'run',
  role: role,
  channel: channel,
  createdSeq: sequence,
  versionSeq: sequence,
  contentVersion: 0,
  body: id,
  occurredAt: _at,
  status: status,
  isDeleted: false,
);

List<ActivityFeedEntry> _feed({
  required List<ConversationV2Message> messages,
  bool grouped = false,
  String toolAt = _at,
}) => buildActivityFeed(
  runProjection: buildConversationV2Projection(
    conversationId: 'thread',
    messages: messages,
    runs: const [
      ConversationV2Run(
        runId: 'run',
        conversationId: 'thread',
        turnId: 'turn',
        status: 'running',
        versionSeq: 4,
        timingQuality: 'recorded',
        startedAt: _at,
      ),
    ],
    tools: [
      ConversationV2Tool(
        toolCallId: 'tool',
        conversationId: 'thread',
        runId: 'run',
        name: 'Read',
        status: 'completed',
        createdSeq: 3,
        versionSeq: 4,
        occurredAt: toolAt,
      ),
    ],
  ),
  groupTurns: grouped,
  groupActions: false,
  thinkingDisplayMode: ThinkingDisplayMode.expanded,
);

void main() {
  test('stream status never changes prose/thinking/tool order', () {
    for (final status in [
      ConversationV2MessageStatus.streaming,
      ConversationV2MessageStatus.finalised,
    ]) {
      final feed = _feed(
        messages: [
          _message('prose', 1, status: status),
          _message('thinking', 2, channel: 'thinking'),
        ],
      );
      expect(feed.map((entry) => entry.sequence), [
        1,
        2,
        3,
      ], reason: status.name);
    }
  });

  test('equal-time prompt and first response stay in one turn segment', () {
    final feed = _feed(
      messages: [
        _message('prompt', 1, role: 'user'),
        _message('response', 2),
      ],
      toolAt: '2026-10-26T18:01:36.001Z',
      grouped: true,
    );
    expect(feed.map((entry) => entry.kind), [
      ActivityFeedKind.user,
      ActivityFeedKind.turn,
    ]);
    expect(feed.last.processEntries.map((entry) => entry.sequence), [2, 3]);
  });
}
