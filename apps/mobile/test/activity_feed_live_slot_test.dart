import 'package:eco_mobile/core/models/conversation_v2_models.dart';
import 'package:eco_mobile/core/models/conversation_v2_projection_models.dart';
import 'package:eco_mobile/core/preferences/thinking_display_preferences.dart';
import 'package:eco_mobile/core/utils/tool_writing_indicator.dart';
import 'package:eco_mobile/core/widgets/run_activity_indicator.dart';
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

ThreadRunProjectionTimelineItem _tool({
  bool running = false,
  String runAttemptId = 'run',
}) => ThreadRunProjectionTimelineItem(
  id: '$runAttemptId-tool',
  sequence: 1,
  eventType: running ? 'tool.started' : 'tool.completed',
  scope: 'main',
  role: 'tool',
  text: 'Tool: Write',
  at: _start,
  runAttemptId: runAttemptId,
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
  List<ThreadRunProjectionAttempt> earlierAttempts = const [],
}) => buildActivityFeed(
  runProjection: ThreadRunProjectionSnapshot(
    threadId: 'thread',
    status: live ? 'running' : 'completed',
    generatedAt: _next,
    sourceEventCount: 1,
    agents: const [],
    attempts: [
      ...earlierAttempts,
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
  testWidgets('quiet running feed shows activity without moving its content', (
    tester,
  ) async {
    final scroll = ScrollController();
    addTearDown(scroll.dispose);
    Future<void> render({
      String text = '检查实现',
      bool running = true,
      bool stopping = false,
      int durationMs = 0,
    }) => tester.pumpWidget(
      MaterialApp(
        locale: const Locale('zh'),
        localizationsDelegates: AppLocalizations.localizationsDelegates,
        supportedLocales: AppLocalizations.supportedLocales,
        home: Scaffold(
          body: ActivityFeedList(
            entries: [
              ActivityFeedEntry(
                id: 'turn',
                kind: ActivityFeedKind.turn,
                text: '',
                running: true,
                durationMs: durationMs,
                processEntries: [
                  ActivityFeedEntry(
                    id: 'message',
                    kind: ActivityFeedKind.assistant,
                    text: text,
                    streaming: true,
                  ),
                ],
              ),
            ],
            running: running,
            stopping: stopping,
            scrollController: scroll,
            scrollJumpBottomInset: 120,
            padding: const EdgeInsets.only(bottom: 160),
          ),
        ),
      ),
    );

    await render();
    await tester.pump(const Duration(milliseconds: 499));
    expect(find.byType(RunActivityIndicator), findsNothing);
    // A clock refresh is not new content: keep the original silence deadline.
    await render(durationMs: 1000);
    final before = tester.getRect(find.byKey(const ValueKey('message')));
    final offset = scroll.offset;
    await tester.pump(const Duration(milliseconds: 1));
    await tester.pump(const Duration(milliseconds: 180));
    expect(find.byType(RunActivityIndicator), findsOneWidget);
    expect(tester.getRect(find.byKey(const ValueKey('message'))), before);
    expect(scroll.offset, offset);
    final mark = tester.getRect(find.byType(RunActivityIndicator));
    expect(mark.bottom, lessThanOrEqualTo(600 - 120));

    // Same-length content changes also count as visible output.
    await render(text: '更新实现');
    await tester.pump(const Duration(milliseconds: 180));
    expect(find.byType(RunActivityIndicator), findsNothing);
    await tester.pump(const Duration(milliseconds: 320));
    expect(find.byType(RunActivityIndicator), findsOneWidget);
    await render(stopping: true);
    await tester.pump(const Duration(milliseconds: 180));
    expect(find.byType(RunActivityIndicator), findsNothing);
    await render(running: false);
    await tester.pump(const Duration(seconds: 1));
    expect(find.byType(RunActivityIndicator), findsNothing);
    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('existing nested waiting states own their activity indicator', (
    tester,
  ) async {
    final scroll = ScrollController();
    addTearDown(scroll.dispose);
    for (final kind in [
      ActivityFeedKind.thinking,
      ActivityFeedKind.reasoningStage,
      ActivityFeedKind.toolWriting,
    ]) {
      await tester.pumpWidget(
        MaterialApp(
          locale: const Locale('zh'),
          localizationsDelegates: AppLocalizations.localizationsDelegates,
          supportedLocales: AppLocalizations.supportedLocales,
          home: Scaffold(
            body: ActivityFeedList(
              entries: [
                ActivityFeedEntry(
                  id: 'turn',
                  kind: ActivityFeedKind.turn,
                  text: '',
                  running: true,
                  processEntries: [
                    ActivityFeedEntry(
                      id: 'waiting',
                      kind: kind,
                      text: kind == ActivityFeedKind.thinking ? '' : '检查实现',
                      streaming: true,
                    ),
                  ],
                ),
              ],
              running: true,
              scrollController: scroll,
            ),
          ),
        ),
      );
      await tester.pump(const Duration(seconds: 1));
      expect(
        find.byType(RunActivityIndicator),
        findsNothing,
        reason: kind.name,
      );
    }
    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('reduced motion keeps a static mark with a screen reader label', (
    tester,
  ) async {
    final semantics = tester.ensureSemantics();
    await tester.pumpWidget(
      MaterialApp(
        locale: const Locale('en'),
        localizationsDelegates: AppLocalizations.localizationsDelegates,
        supportedLocales: AppLocalizations.supportedLocales,
        home: const MediaQuery(
          data: MediaQueryData(disableAnimations: true),
          child: Center(child: RunActivityIndicator()),
        ),
      ),
    );
    expect(find.text('Processing'), findsNothing);
    expect(find.bySemanticsLabel('Processing'), findsOneWidget);
    expect(
      tester.getSize(find.byType(RunActivityIndicator)),
      const Size(28, 12),
    );
    await tester.pump(const Duration(seconds: 1));
    expect(tester.binding.hasScheduledFrame, isFalse);
    semantics.dispose();
    await tester.pumpWidget(const SizedBox.shrink());
  });

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

  test('writing and native thinking preserve the completed tool history', () {
    final states = [
      _feed(timeline: [_tool(running: true)]),
      _feed(),
      _feed(spans: [_span(writing: true)]),
      _feed(spans: [_span(thinking: true)]),
      _feed(timeline: [_tool(running: true)]),
    ];
    expect(
      states.map((feed) => _rows(feed).map((entry) => entry.kind).toList()),
      [
        [ActivityFeedKind.actionGroup],
        [ActivityFeedKind.actionGroup],
        [ActivityFeedKind.actionGroup, ActivityFeedKind.toolWriting],
        [ActivityFeedKind.actionGroup, ActivityFeedKind.thinking],
        [ActivityFeedKind.actionGroup],
      ],
    );
    for (final feed in states) {
      final display = resolveThreadSessionDisplayFeedEntries(
        feedEntries: feed,
        threadId: 'thread',
        threadPrompt: '',
        isRunning: true,
      );
      expect(_rows(display), hasLength(_rows(feed).length));
      expect(_rows(display).first.kind, ActivityFeedKind.actionGroup);
      expect(display.any((entry) => entry.id == 'pending-agent'), isFalse);
    }
    expect(_rows(states[2]).last.text, '正在写入 src/main.ts');
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

  for (final eventType in ['tool.started', 'context.compaction.started']) {
    test('$eventType in a finished attempt cannot hide the live status', () {
      for (final status in ['completed', 'cancelled', 'failed']) {
        for (final span in [_span(writing: true), _span(thinking: true)]) {
          final rows = _rows(
            _feed(
              spans: [span],
              grouped: false,
              earlierAttempts: [
                ThreadRunProjectionAttempt(
                  attemptId: 'old-run',
                  phase: 'main',
                  retryIndex: 0,
                  status: status,
                  startedAt: '2026-10-20T00:00:00.000Z',
                  endedAt: _start,
                ),
              ],
              timeline: [
                if (eventType == 'tool.started')
                  _tool(running: true, runAttemptId: 'old-run')
                else
                  ThreadRunProjectionTimelineItem(
                    id: 'old-compaction',
                    sequence: 0,
                    eventType: eventType,
                    scope: 'main',
                    text: '',
                    at: _start,
                    runAttemptId: 'old-run',
                  ),
                // Adjacent tools merge into a group spanning both attempts.
                _tool(),
              ],
            ),
          );
          expect(
            rows.last.kind,
            span.writingTool != null
                ? ActivityFeedKind.toolWriting
                : ActivityFeedKind.thinking,
            reason: '$eventType in $status attempt',
          );
        }
      }
    });
  }

  test(
    'a running current tool in a cross-attempt group still owns the slot',
    () {
      final rows = _rows(
        _feed(
          spans: [_span(thinking: true)],
          grouped: false,
          earlierAttempts: const [
            ThreadRunProjectionAttempt(
              attemptId: 'old-run',
              phase: 'main',
              retryIndex: 0,
              status: 'completed',
              startedAt: '2026-10-20T00:00:00.000Z',
              endedAt: _start,
            ),
          ],
          timeline: [
            _tool(running: true, runAttemptId: 'old-run'),
            _tool(running: true),
          ],
        ),
      );
      expect(rows.single.kind, ActivityFeedKind.actionGroup);
      expect(rows.single.actionChildren, hasLength(2));
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
    expect(rows.map((entry) => entry.kind), [
      ActivityFeedKind.actionGroup,
      ActivityFeedKind.toolWriting,
    ]);
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
