import 'package:eco_mobile/core/models/conversation_v2_projection_models.dart';
import 'package:eco_mobile/core/theme/eco_theme.dart';
import 'package:eco_mobile/features/threads/activity_feed.dart';
import 'package:eco_mobile/l10n/generated/app_localizations.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';

typedef StatusGeometryCheckpoint =
    Future<void> Function(
      WidgetTester tester,
      String name,
      List<Map<String, Object>> frames,
    );

void main({StatusGeometryCheckpoint? onCheckpoint}) {
  for (final grouped in [false, true]) {
    for (final scale in [1.0, 1.65]) {
      testWidgets(
        'live status geometry stays fixed grouped=$grouped scale=$scale',
        (tester) async {
          final scroll = ScrollController();
          final state = ValueNotifier(_feed('thinking', grouped));
          addTearDown(scroll.dispose);
          addTearDown(state.dispose);
          await tester.pumpWidget(
            MaterialApp(
              debugShowCheckedModeBanner: false,
              theme: buildEcoLightTheme(),
              locale: const Locale('zh'),
              localizationsDelegates: AppLocalizations.localizationsDelegates,
              supportedLocales: AppLocalizations.supportedLocales,
              home: Builder(
                builder: (context) => MediaQuery(
                  data: MediaQuery.of(
                    context,
                  ).copyWith(textScaler: TextScaler.linear(scale)),
                  child: Scaffold(
                    body: SafeArea(
                      child: ValueListenableBuilder(
                        valueListenable: state,
                        builder: (context, entries, _) => ActivityFeedList(
                          entries: entries,
                          running: true,
                          scrollController: scroll,
                          showMessageCopyAndTime: false,
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          );
          await tester.pump();
          await tester.pump(const Duration(milliseconds: 300));
          Rect? initialRow, initialAnchor;
          double? initialBaseline, initialScroll;
          for (final phase in [
            'thinking',
            'running-tool',
            'tools',
            'thinking-with-tools',
            'summary',
            'summary-english',
            'thinking-with-tools',
            'writing',
            'thinking-with-tools',
            'tools',
            'thinking-with-tools',
          ]) {
            state.value = _feed(phase, grouped);
            final tail = state.value.last;
            final row = tail.kind == ActivityFeedKind.turn
                ? tail.processEntries.last
                : tail;
            final label = row.text.isEmpty ? '正在思考' : row.text;
            final frames = <Map<String, Object>>[];
            for (var frame = 0; frame < 18; frame++) {
              await tester.pump(const Duration(milliseconds: 16));
              final bounds = tester.getRect(find.byKey(ValueKey(row.id)));
              final anchor = tester.getRect(find.text('上一条消息保持原位'));
              final paragraph = tester.renderObject<RenderParagraph>(
                find.descendant(
                  of: find.text(label).last,
                  matching: find.byType(RichText),
                ),
              );
              final baseline = paragraph
                  .localToGlobal(
                    Offset(
                      0,
                      paragraph.getDryBaseline(
                        paragraph.constraints,
                        TextBaseline.alphabetic,
                      )!,
                    ),
                  )
                  .dy;
              initialRow ??= bounds;
              initialAnchor ??= anchor;
              initialBaseline ??= baseline;
              initialScroll ??= scroll.offset;
              frames.add({
                'phase': phase,
                'frame': frame,
                'rowTop': bounds.top,
                'rowHeight': bounds.height,
                'labelBaseline': baseline,
                'anchorTop': anchor.top,
                'scrollOffset': scroll.offset,
              });
              expect(bounds.top, closeTo(initialRow.top, .01), reason: phase);
              expect(
                bounds.height,
                closeTo(initialRow.height, .01),
                reason: phase,
              );
              expect(baseline, closeTo(initialBaseline, .01), reason: phase);
              expect(
                anchor.top,
                closeTo(initialAnchor.top, .01),
                reason: phase,
              );
              expect(scroll.offset, closeTo(initialScroll, .01), reason: phase);
              expect(tester.takeException(), isNull);
            }
            await onCheckpoint?.call(
              tester,
              'grouped-$grouped-scale-$scale-$phase',
              frames,
            );
          }
          await tester.pumpWidget(const SizedBox.shrink());
        },
      );
    }
  }
}

List<ActivityFeedEntry> _feed(String phase, bool grouped) {
  const start = '2026-11-11T00:00:00.000Z';
  const next = '2026-11-11T00:00:01.000Z';
  final hasTools = phase != 'thinking';
  final thinking = phase == 'thinking' || phase == 'thinking-with-tools';
  return [
    const ActivityFeedEntry(
      id: 'anchor',
      kind: ActivityFeedKind.user,
      text: '上一条消息保持原位',
    ),
    ...buildActivityFeed(
      runProjection: ThreadRunProjectionSnapshot(
        threadId: 'geometry-test',
        status: 'running',
        generatedAt: next,
        sourceEventCount: 1,
        agents: const [],
        attempts: const [
          ThreadRunProjectionAttempt(
            attemptId: 'run',
            phase: 'main',
            retryIndex: 0,
            status: 'running',
            startedAt: start,
          ),
        ],
        requestSpans: [
          if (thinking || phase == 'writing')
            ThreadRunProjectionRequestSpan.fromJson({
              'requestId': 'request',
              'status': 'streaming',
              'startedAt': start,
              if (thinking) ...{
                'pendingThinkingSince': next,
                'pendingThinkingMessageId': 'thinking',
              },
              if (phase == 'writing')
                'writingTool': {
                  'kind': 'file',
                  'target': 'src/main.ts',
                  'since': next,
                },
            }),
        ],
        timeline: [
          if (hasTools)
            ThreadRunProjectionTimelineItem(
              id: 'tool',
              sequence: 1,
              eventType: phase == 'running-tool'
                  ? 'tool.started'
                  : 'tool.completed',
              scope: 'main',
              role: 'tool',
              text: 'Tool: Read',
              at: start,
              runAttemptId: 'run',
              metadata: {
                'tool': {
                  'name': 'Read',
                  'detail': 'src/main.ts',
                  'status': phase == 'running-tool' ? 'started' : 'completed',
                },
              },
            ),
          if (phase.startsWith('summary'))
            ThreadRunProjectionTimelineItem(
              id: 'summary',
              sequence: 2,
              eventType: 'thinking.delta',
              scope: 'main',
              text: phase == 'summary' ? '检查工具执行结果' : 'Inspecting tool results',
              at: next,
              runAttemptId: 'run',
              metadata: const {'reasoningDisplay': 'summary'},
            ),
        ],
      ),
      groupTurns: grouped,
      conversationLive: true,
    ),
  ];
}
