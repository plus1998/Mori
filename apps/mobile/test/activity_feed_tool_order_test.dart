import 'package:eco_mobile/core/models/conversation_v2_projection_models.dart';
import 'package:eco_mobile/core/preferences/thinking_display_preferences.dart';
import 'package:eco_mobile/features/threads/activity_feed.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  for (final mode in ThinkingDisplayMode.values) {
    test(
      'six commands and new thinking survive old running tools in ${mode.name}',
      () {
        final tools = [
          for (var i = 1; i <= 6; i++) _row('command-$i', i, tool: true),
        ];
        final thinking = {
          ..._row('thinking', 7, text: 'Checking the next source'),
          'eventType': 'thinking.delta',
          'metadata': {'conversationV2MessageId': 'thinking'},
        };
        List<ActivityFeedEntry> process({
          List<Map<String, dynamic>> extra = const [],
          Map<String, dynamic>? span,
          bool live = true,
        }) => buildActivityFeed(
          thinkingDisplayMode: mode,
          runProjection: ThreadRunProjectionSnapshot.fromJson({
            'threadId': 'thread',
            'status': live ? 'running' : 'completed',
            'generatedAt': '2026-10-22T00:00:09.000Z',
            'sourceEventCount': 10,
            'agents': [],
            'attempts': [
              {
                'attemptId': 'old-run',
                'phase': 'main',
                'retryIndex': 0,
                'status': 'completed',
                'startedAt': '2026-10-21T00:00:00.000Z',
                'endedAt': '2026-10-21T00:00:02.000Z',
              },
              {
                'attemptId': 'run',
                'phase': 'main',
                'retryIndex': 0,
                'status': live ? 'running' : 'completed',
                'startedAt': '2026-10-22T00:00:00.000Z',
                if (!live) 'endedAt': '2026-10-22T00:00:09.000Z',
              },
            ],
            'timeline': [
              {
                ..._row('background-command', 0, tool: true),
                'eventType': 'tool.started',
                'runAttemptId': 'old-run',
                'at': '2026-10-21T00:00:00.000Z',
                'metadata': {
                  'tool': {'name': 'Bash', 'status': 'started'},
                },
              },
              {
                ..._row('old-answer', 0, text: 'Dev app started.'),
                'runAttemptId': 'old-run',
                'at': '2026-10-21T00:00:01.000Z',
              },
              ...tools,
              ...extra,
            ],
            'requestSpans': [
              if (span != null)
                {
                  'requestId': 'request',
                  'status': 'streaming',
                  'startedAt': '2026-10-22T00:00:00.000Z',
                  ...span,
                },
            ],
          }),
        ).last.processEntries;
        final before = process();
        final states = [
          process(
            span: {
              'pendingThinkingSince': '2026-10-22T00:00:07.000Z',
              'pendingThinkingMessageId': 'thinking',
            },
          ),
          process(extra: [thinking]),
          process(
            extra: [
              {...thinking, 'eventType': 'thinking.final'},
            ],
          ),
          process(
            span: {
              'writingTool': {
                'since': '2026-10-22T00:00:07.000Z',
                'kind': 'command',
                'target': 'next',
              },
            },
          ),
          process(
            extra: [
              thinking,
              _row('progress', 8, text: 'Continuing the check'),
            ],
          ),
          process(
            extra: [
              thinking,
              _row('final', 9, text: 'Done'),
            ],
            live: false,
          ),
        ];
        expect(states[0].last.kind, ActivityFeedKind.thinking);
        expect(states[0].last.text, isEmpty);
        for (final state in states.skip(1).take(2)) {
          expect(
            state.last.kind,
            mode.usesEphemeralTip
                ? ActivityFeedKind.reasoningStage
                : ActivityFeedKind.thinking,
          );
          expect(state.last.text, 'Checking the next source');
        }
        expect(states[3].last.kind, ActivityFeedKind.toolWriting);
        for (var i = 0; i < states.length; i++) {
          final groups = states[i].where(
            (e) => e.kind == ActivityFeedKind.actionGroup,
          );
          expect(groups, hasLength(1), reason: 'transition $i');
          expect(groups.single.id, before.single.id, reason: 'transition $i');
          expect(
            groups.single.actionChildren.map((e) => e.id),
            before.single.actionChildren.map((e) => e.id),
            reason: 'transition $i',
          );
          expect(
            groups.single.actionChildren,
            hasLength(6),
            reason: 'transition $i',
          );
        }
      },
    );
  }

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

  test(
    'a tool group stays below progress while a temporary summary changes',
    () {
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
      expect(before.map((entry) => entry.sequence), [1, 2, 3, 4, 5]);
      expect(before[3].kind, ActivityFeedKind.actionGroup);
      expect(before.last.kind, ActivityFeedKind.reasoningStage);

      // Later speech clears only the temporary summary. The existing tool group
      // keeps its identity and its position below the progress paragraph.
      for (final streaming in [true, false]) {
        final after = process([
          ...prefix,
          {
            ..._row('next', 6, text: 'Deployed. I will verify it next.'),
            'eventType': streaming ? 'message.delta' : 'message.final',
          },
        ]);
        expect(
          after.take(4).map((entry) => entry.id),
          before.take(4).map((entry) => entry.id),
        );
        expect(after.map((entry) => entry.sequence), [1, 2, 3, 4, 6]);
        expect(after[3].kind, ActivityFeedKind.actionGroup);
        expect(after[3].actionChildren.single.sequence, 4);
        expect(after.last.streaming, streaming);
      }
    },
  );

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
