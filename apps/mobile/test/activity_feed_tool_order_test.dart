import 'package:eco_mobile/core/models/conversation_v2_projection_models.dart';
import 'package:eco_mobile/features/threads/activity_feed.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  for (final running in [true, false]) {
    test('tool groups stay between their narration while running=$running', () {
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
        ActivityFeedKind.assistant,
        ActivityFeedKind.actionGroup,
      ]);
      expect(turn.processEntries.first.text, 'I will inspect the page.');
      expect(
        turn.processEntries[2].text,
        'The copy is ready. I will deploy it next.',
      );
      expect(turn.processEntries[1].actionChildren.single.sequence, 2);
      expect(turn.processEntries.last.actionChildren.single.sequence, 4);
      expect(turn.processEntries.map((entry) => entry.sequence), [1, 2, 3, 4]);
      expect(turn.finalOutput?.text, running ? null : 'Deployed and verified.');
    });
  }

  test('a restored live tool group stays below existing progress text', () {
    final prefix = [
      _row('intro', 1, text: 'I will inspect the page.'),
      _row('inspect', 2, tool: true),
      _row('progress', 3, text: 'The copy is ready. I will deploy it next.'),
      _row('deploy', 4, tool: true),
      {
        ..._row('summary', 5, text: 'Checking deployment'),
        'eventType': 'thinking.delta',
        'metadata': {'reasoningDisplay': 'summary'},
      },
    ];
    List<ActivityFeedEntry> process(List<Map<String, dynamic>> timeline) =>
        buildActivityFeed(
          runProjection: ThreadRunProjectionSnapshot.fromJson({
            'threadId': 'thread',
            'status': 'running',
            'generatedAt': '2026-10-22T00:00:07.000Z',
            'sourceEventCount': timeline.length,
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
            'timeline': timeline,
          }),
        ).single.processEntries;

    final before = process(prefix);
    expect(before.map((entry) => entry.sequence), [1, 2, 3, 4]);
    expect(before.last.kind, ActivityFeedKind.reasoningStage);

    // Later speech restores the tool group that shared the temporary tail slot.
    // It must not move that group above the progress paragraph already on screen.
    for (final streaming in [true, false]) {
      final after = process([
        ...prefix,
        {
          ..._row('next', 6, text: 'Deployed. I will verify it next.'),
          'eventType': streaming ? 'message.delta' : 'message.final',
        },
      ]);
      expect(
        after.take(3).map((entry) => entry.id),
        before.take(3).map((entry) => entry.id),
      );
      expect(after.map((entry) => entry.sequence), [1, 2, 3, 4, 6]);
      expect(after[3].kind, ActivityFeedKind.actionGroup);
      expect(after[3].actionChildren.single.sequence, 4);
      expect(after.last.streaming, streaming);
    }
  });

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
