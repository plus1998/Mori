import 'package:flutter_test/flutter_test.dart';

import 'package:eco_mobile/core/models/conversation_v2_models.dart';
import 'package:eco_mobile/features/threads/activity_feed.dart';
import 'package:eco_mobile/features/threads/conversation_v2_projection.dart';

const _conversationId = 'reordered-follow-ups';

String _at(String time) => '2026-10-05T$time.000Z';

ConversationV2Message _message(
  String id,
  int sequence,
  String time, {
  bool user = true,
  int? versionSeq,
  ConversationV2MessageStatus status = ConversationV2MessageStatus.finalised,
  bool deleted = false,
}) => ConversationV2Message(
  messageId: user ? id : 'answer_$id',
  conversationId: _conversationId,
  turnId: 'turn_$id',
  runId: user ? null : 'run_$id',
  role: user ? 'user' : 'assistant',
  providerRole: user ? null : 'main',
  channel: 'answer',
  createdSeq: sequence,
  versionSeq: versionSeq ?? sequence,
  contentVersion: 0,
  body: user ? id : 'answer_$id',
  occurredAt: _at(time),
  status: status,
  isDeleted: deleted,
);

ConversationV2Run _run(String id, int sequence, String start, String end) =>
    ConversationV2Run(
      runId: 'run_$id',
      conversationId: _conversationId,
      turnId: 'turn_$id',
      status: 'completed',
      versionSeq: sequence,
      timingQuality: 'recorded',
      startedAt: _at(start),
      endedAt: _at(end),
    );

ConversationV2Tool _tool(String id, int sequence, String time) =>
    ConversationV2Tool(
      toolCallId: 'tool_$id',
      conversationId: _conversationId,
      runId: 'run_$id',
      name: 'Read',
      status: 'completed',
      createdSeq: sequence,
      versionSeq: sequence,
      occurredAt: _at(time),
      input: {'file_path': '$id.ts'},
    );

void main() {
  test('last reordered follow-up preserves earlier turns and their tools', () {
    final messages = [
      _message('original', 1, '08:37:01'),
      _message('cancelled', 2, '08:41:00', deleted: true),
      _message('original', 6, '08:47:00', user: false),
      _message('guided', 8, '08:48:01'),
      _message('guided', 11, '08:48:30', user: false),
      _message('confirmed', 14, '08:49:01'),
      _message('confirmed', 17, '09:01:00', user: false),
      _message('moved-first', 20, '09:01:01'),
      _message('moved-first', 23, '09:02:00', user: false),
    ];
    final runs = [
      _run('original', 7, '08:37:02', '08:47:00'),
      _run('guided', 12, '08:48:02', '08:48:30'),
      _run('confirmed', 18, '08:49:02', '09:01:00'),
      _run('moved-first', 24, '09:01:02', '09:02:00'),
    ];
    final tools = [
      _tool('original', 5, '08:37:03'),
      _tool('guided', 10, '08:48:03'),
      _tool('confirmed', 16, '08:49:03'),
      _tool('moved-first', 22, '09:01:03'),
    ];
    List<ActivityFeedEntry> feed(bool delivered) => buildActivityFeed(
      threadPrompt: '',
      threadId: _conversationId,
      runProjection: buildConversationV2Projection(
        conversationId: _conversationId,
        messages: [
          ...messages,
          _message(
            'last-queued',
            3,
            delivered ? '09:08:00' : '08:42:00',
            versionSeq: delivered ? 26 : 3,
            status: delivered
                ? ConversationV2MessageStatus.finalised
                : ConversationV2MessageStatus.queued,
          ),
          if (delivered) _message('last-queued', 29, '09:10:00', user: false),
        ],
        runs: [
          ...runs,
          if (delivered) _run('last-queued', 30, '09:08:01', '09:10:00'),
        ],
        tools: [...tools, if (delivered) _tool('last-queued', 28, '09:08:02')],
      ),
    );
    List<Map<String, Object?>> shape(List<ActivityFeedEntry> entries) => [
      for (final entry in entries)
        {
          'id': entry.id,
          'text': entry.kind == ActivityFeedKind.user
              ? entry.text
              : entry.finalOutput?.text,
          'tools': [
            for (final child in entry.processEntries)
              if (child.kind == ActivityFeedKind.action)
                child.toolUseId
              else if (child.kind == ActivityFeedKind.actionGroup)
                for (final action in child.actionChildren) action.toolUseId,
          ],
        },
    ];
    final before = shape(feed(false));
    expect(before.map((entry) => entry['text']).toList(), [
      'original',
      'answer_original',
      'guided',
      'answer_guided',
      'confirmed',
      'answer_confirmed',
      'moved-first',
      'answer_moved-first',
    ]);
    final after = shape(feed(true));
    expect(after.take(before.length).toList(), before);
    expect(after.map((entry) => entry['text']).toList(), [
      'original',
      'answer_original',
      'guided',
      'answer_guided',
      'confirmed',
      'answer_confirmed',
      'moved-first',
      'answer_moved-first',
      'last-queued',
      'answer_last-queued',
    ]);
    expect(
      after
          .where((entry) => (entry['tools'] as List).isNotEmpty)
          .map((entry) => entry['tools'])
          .toList(),
      [
        ['tool_original'],
        ['tool_guided'],
        ['tool_confirmed'],
        ['tool_moved-first'],
        ['tool_last-queued'],
      ],
    );
  });
}
