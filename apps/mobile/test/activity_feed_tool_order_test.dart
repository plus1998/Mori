import 'package:eco_mobile/core/models/conversation_v2_projection_models.dart';
import 'package:eco_mobile/features/threads/activity_feed.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  for (final running in [true, false]) {
    test('tool groups precede progress narration while running=$running', () {
      final projection = ThreadRunProjectionSnapshot.fromJson({
        'threadId': 'thread',
        'status': running ? 'running' : 'completed',
        'generatedAt': '2026-10-22T00:00:06.000Z',
        'sourceEventCount': 7,
        'agents': [],
        'attempts': [
          {
            'attemptId': 'run',
            'phase': 'main',
            'retryIndex': 0,
            'status': running ? 'running' : 'completed',
            'startedAt': '2026-10-22T00:00:00.000Z',
            if (!running) 'endedAt': '2026-10-22T00:00:06.000Z',
          },
        ],
        'timeline': [
          _row('intro', 1, text: 'I will inspect the page.'),
          _row('edit', 2, tool: true),
          _row(
            'progress',
            3,
            text: 'The copy is ready. I will deploy it next.',
          ),
          _row('deploy', 4, tool: true),
          if (!running) _row('final', 5, text: 'Deployed and verified.'),
        ],
      });
      final entries = buildActivityFeed(runProjection: projection);
      final turn = entries.singleWhere(
        (entry) => entry.kind == ActivityFeedKind.turn,
      );
      expect(turn.processEntries.map((entry) => entry.kind), [
        ActivityFeedKind.assistant,
        ActivityFeedKind.actionGroup,
        ActivityFeedKind.actionGroup,
        ActivityFeedKind.assistant,
      ]);
      expect(turn.processEntries.first.text, 'I will inspect the page.');
      expect(
        turn.processEntries.last.text,
        'The copy is ready. I will deploy it next.',
      );
      expect(turn.processEntries[1].actionChildren.single.sequence, 2);
      expect(turn.processEntries[2].actionChildren.single.sequence, 4);
      expect(turn.processEntries.last.sequence, 3);
      expect(turn.finalOutput?.text, running ? null : 'Deployed and verified.');
    });
  }

  test('a user prompt remains a boundary for same-run tool placement', () {
    final projection = ThreadRunProjectionSnapshot.fromJson({
      'threadId': 'thread',
      'status': 'running',
      'generatedAt': '2026-10-22T00:00:06.000Z',
      'sourceEventCount': 5,
      'agents': [],
      'attempts': [
        {
          'attemptId': 'run',
          'phase': 'main',
          'retryIndex': 0,
          'status': 'running',
          'startedAt': '2026-10-22T00:00:00.000Z',
        },
      ],
      'timeline': [
        _row('edit', 1, tool: true),
        _row('progress', 2, text: 'Ready to deploy.'),
        {
          ..._row('steer', 3, text: 'Wait and verify first.'),
          'role': 'user',
          'metadata': {'liveType': 'message.user'},
        },
        _row('verify', 4, tool: true),
      ],
    });
    final feed = buildActivityFeed(runProjection: projection);
    expect(feed.map((entry) => entry.kind), [
      ActivityFeedKind.turn,
      ActivityFeedKind.user,
      ActivityFeedKind.turn,
    ]);
    expect(feed.first.processEntries.last.text, 'Ready to deploy.');
    expect(feed.last.processEntries.single.actionChildren.single.sequence, 4);
  });
}

Map<String, dynamic> _row(
  String id,
  int sequence, {
  String text = '',
  bool tool = false,
}) => {
  'id': id,
  'sequence': sequence,
  'eventType': tool ? 'tool.completed' : 'message.final',
  'scope': 'main',
  'role': tool ? 'tool' : 'assistant',
  'runAttemptId': 'run',
  'text': tool ? 'Tool: Bash · $id' : text,
  'at': '2026-10-22T00:00:0$sequence.000Z',
  if (tool)
    'metadata': {
      'tool': {'name': 'Bash', 'detail': id, 'status': 'completed'},
    },
};
