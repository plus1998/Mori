import 'package:eco_mobile/core/models/conversation_v2_models.dart';
import 'package:eco_mobile/core/models/conversation_v2_projection_models.dart';
import 'package:eco_mobile/core/preferences/thinking_display_preferences.dart';
import 'package:eco_mobile/core/utils/tool_writing_indicator.dart';
import 'package:eco_mobile/features/threads/activity_feed.dart';
import 'package:eco_mobile/l10n/generated/app_localizations.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

const _start = '2026-10-21T00:00:00.000Z';
const _next = '2026-10-21T00:00:05.000Z';

ThreadRunProjectionRequestSpan _span({
  String? owner,
  bool writing = false,
  bool thinking = false,
}) => ThreadRunProjectionRequestSpan.fromJson({
  'requestId': 'request',
  'status': 'completed',
  'startedAt': _start,
  'ownerAgentId': ?owner,
  if (writing)
    'writingTool': {'kind': 'file', 'target': 'src/main.ts', 'since': _next},
  if (thinking) ...{
    'pendingThinkingSince': _next,
    'pendingThinkingMessageId': 'native-thinking',
  },
});

ThreadRunProjectionTimelineItem _tool({bool running = false}) =>
    ThreadRunProjectionTimelineItem(
      id: 'tool',
      sequence: 1,
      eventType: running ? 'tool.started' : 'tool.completed',
      scope: 'main',
      role: 'tool',
      text: 'Tool: Write',
      at: _start,
      runAttemptId: 'run',
      metadata: {
        'tool': {
          'name': 'Write',
          'detail': 'src/app.ts',
          'status': running ? 'started' : 'completed',
        },
      },
    );

List<ActivityFeedEntry> _feed({
  List<ThreadRunProjectionRequestSpan> spans = const [],
  List<ThreadRunProjectionTimelineItem>? timeline,
  bool live = true,
  bool grouped = true,
}) => buildActivityFeed(
  runProjection: ThreadRunProjectionSnapshot(
    threadId: 'thread',
    status: live ? 'running' : 'completed',
    generatedAt: _next,
    sourceEventCount: 1,
    agents: const [],
    attempts: [
      ThreadRunProjectionAttempt(
        attemptId: 'run',
        phase: 'main',
        retryIndex: 0,
        status: live ? 'running' : 'completed',
        startedAt: _start,
      ),
    ],
    requestSpans: spans,
    timeline: timeline ?? [_tool()],
  ),
  groupTurns: grouped,
  conversationLive: live,
  thinkingDisplayMode: ThinkingDisplayMode.expanded,
);

List<ActivityFeedEntry> _rows(List<ActivityFeedEntry> feed) => [
  for (final entry in feed)
    if (entry.kind == ActivityFeedKind.turn) ...entry.processEntries else entry,
];

void main() {
  test('a durable tool after writing began prevents a stale writing hint', () {
    final rows = _rows(
      _feed(
        spans: [_span(writing: true)],
        timeline: [
          ThreadRunProjectionTimelineItem(
            id: 'finished-tool',
            sequence: 4,
            eventType: 'tool.completed',
            scope: 'main',
            role: 'tool',
            text: 'Tool: Write',
            at: '2026-10-21T00:00:06.000Z',
            runAttemptId: 'run',
            metadata: const {
              'tool': {'name': 'Write', 'status': 'completed'},
            },
          ),
        ],
      ),
    );
    expect(rows.single.kind, ActivityFeedKind.actionGroup);
    expect(
      rows.any((entry) => entry.kind == ActivityFeedKind.toolWriting),
      isFalse,
    );
  });

  test('projection extras retain writing and native thinking identity', () {
    final extras = ConversationV2ProjectionExtras.fromJson({
      'requestSpans': [
        {
          'requestId': 'request',
          'status': 'completed',
          'startedAt': _start,
          'writingTool': {
            'since': _next,
            'name': 'Write',
            'kind': 'file',
            'target': 'src/main.ts',
          },
          'pendingThinkingSince': _next,
          'pendingThinkingMessageId': 'native-thinking',
        },
      ],
    });
    final span = extras.requestSpans.single;
    expect(span.writingTool?.name, 'Write');
    expect(span.writingTool?.target, 'src/main.ts');
    expect(span.pendingThinkingSince, _next);
    expect(span.pendingThinkingMessageId, 'native-thinking');
  });

  test('tool, writing and native thinking take turns owning one live row', () {
    final states = [
      _feed(timeline: [_tool(running: true)]),
      _feed(),
      _feed(spans: [_span(writing: true)]),
      _feed(spans: [_span(thinking: true)]),
      _feed(timeline: [_tool(running: true)]),
    ];
    expect(states.map((feed) => _rows(feed).single.kind), [
      ActivityFeedKind.actionGroup,
      ActivityFeedKind.actionGroup,
      ActivityFeedKind.toolWriting,
      ActivityFeedKind.thinking,
      ActivityFeedKind.actionGroup,
    ]);
    for (final feed in states) {
      final display = resolveThreadSessionDisplayFeedEntries(
        feedEntries: feed,
        threadId: 'thread',
        threadPrompt: '',
        isRunning: true,
      );
      expect(_rows(display), hasLength(1));
      expect(display.any((entry) => entry.id == 'pending-agent'), isFalse);
    }
    expect(_rows(states[2]).single.text, '正在写入 src/main.ts');
  });

  test(
    'a genuinely running tool keeps the slot during writing or thinking',
    () {
      for (final span in [_span(writing: true), _span(thinking: true)]) {
        final rows = _rows(
          _feed(spans: [span], timeline: [_tool(running: true)]),
        );
        expect(rows.single.kind, ActivityFeedKind.actionGroup);
      }
    },
  );

  test('writing replaces a summary and empty thinking instead of stacking', () {
    final rows = _rows(
      _feed(
        spans: [_span(writing: true, thinking: true)],
        timeline: [
          _tool(),
          const ThreadRunProjectionTimelineItem(
            id: 'summary',
            sequence: 2,
            eventType: 'thinking.final',
            scope: 'main',
            text: '检查实现',
            at: _next,
            runAttemptId: 'run',
            metadata: {'reasoningDisplay': 'summary'},
          ),
          const ThreadRunProjectionTimelineItem(
            id: 'empty-thinking',
            sequence: 3,
            eventType: 'thinking.delta',
            scope: 'main',
            text: '',
            at: _next,
            runAttemptId: 'run',
          ),
        ],
      ),
    );
    expect(rows.single.kind, ActivityFeedKind.toolWriting);
  });

  test('thinking body replaces its pending fact before extras catch up', () {
    final rows = _rows(
      _feed(
        spans: [_span(thinking: true)],
        timeline: const [
          ThreadRunProjectionTimelineItem(
            id: 'body',
            sequence: 2,
            eventType: 'thinking.delta',
            scope: 'main',
            text: '检查实现和边界',
            at: _next,
            runAttemptId: 'run',
            metadata: {
              'reasoningDisplay': 'raw',
              'conversationV2MessageId': 'native-thinking',
            },
          ),
        ],
      ),
    );
    expect(rows.single.text, '检查实现和边界');
  });

  test('subagent and terminal facts cannot take the main live slot', () {
    expect(
      _rows(_feed(spans: [_span(owner: 'child', writing: true)])).single.kind,
      ActivityFeedKind.actionGroup,
    );
    expect(
      _rows(_feed(spans: [_span(owner: 'child', thinking: true)])).single.kind,
      ActivityFeedKind.actionGroup,
    );
    expect(
      _rows(_feed(spans: [_span(writing: true)], live: false)).single.kind,
      ActivityFeedKind.actionGroup,
    );
  });

  test('writing labels match desktop kinds in both locales', () {
    final zh = lookupAppLocalizations(const Locale('zh'));
    final en = lookupAppLocalizations(const Locale('en'));
    for (final entry in {
      'file': ['正在写入 target', 'Writing target'],
      'read': ['正在读取 target', 'Reading target'],
      'command': ['正在调用 target', 'Running target'],
      'tool': ['正在调用 target', 'Calling target'],
    }.entries) {
      final writing = ThreadRunProjectionWritingTool(
        since: _next,
        kind: entry.key,
        target: 'target',
      );
      expect(toolWritingLabel(writing, zh), entry.value[0]);
      expect(toolWritingLabel(writing, en), entry.value[1]);
    }
  });

  testWidgets('writing uses one waiting line with a spinner', (tester) async {
    final scroll = ScrollController();
    addTearDown(scroll.dispose);
    await tester.pumpWidget(
      MaterialApp(
        locale: const Locale('zh'),
        localizationsDelegates: AppLocalizations.localizationsDelegates,
        supportedLocales: AppLocalizations.supportedLocales,
        home: Scaffold(
          body: ActivityFeedList(
            entries: _feed(spans: [_span(writing: true)], grouped: false),
            scrollController: scroll,
            shrinkWrap: true,
          ),
        ),
      ),
    );
    await tester.pump();
    expect(
      find.byKey(const ValueKey('activity-waiting-thinking')),
      findsOneWidget,
    );
    expect(
      find.byKey(const ValueKey('activity-tool-writing-spinner')),
      findsOneWidget,
    );
    expect(find.text('正在写入 src/main.ts'), findsOneWidget);
    expect(find.text('正在思考'), findsNothing);
  });
}
