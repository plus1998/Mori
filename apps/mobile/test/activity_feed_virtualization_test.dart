import 'package:eco_mobile/core/theme/eco_theme.dart';
import 'package:eco_mobile/core/widgets/paced_stream_text.dart';
import 'package:eco_mobile/features/threads/activity_feed.dart';
import 'package:eco_mobile/l10n/generated/app_localizations.dart';
import 'package:flutter/material.dart';
import 'package:flutter_markdown/flutter_markdown.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  testWidgets('a long running turn only mounts the visible process rows', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(390, 844);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final scroll = ScrollController();
    addTearDown(scroll.dispose);
    final history = List.generate(
      240,
      (index) => ActivityFeedEntry(
        id: 'history-$index',
        kind: ActivityFeedKind.assistant,
        text: '记录 $index\n\n**已完成的分析**，保留原始内容和显示顺序。' * 3,
      ),
    );
    Future<void> render(
      String text, {
      bool running = true,
      bool appendNext = false,
    }) => tester.pumpWidget(
      MaterialApp(
        theme: buildEcoLightTheme(),
        locale: const Locale('zh'),
        localizationsDelegates: AppLocalizations.localizationsDelegates,
        supportedLocales: AppLocalizations.supportedLocales,
        home: Scaffold(
          body: ActivityFeedList(
            scrollController: scroll,
            running: running,
            showMessageCopyAndTime: false,
            entries: [
              ActivityFeedEntry(
                id: 'turn',
                kind: ActivityFeedKind.turn,
                text: '',
                running: running,
                turnStatus: running ? 'running' : 'completed',
                processEntries: [
                  ...history,
                  ActivityFeedEntry(
                    id: 'tail',
                    kind: ActivityFeedKind.assistant,
                    text: text,
                    streaming: running && !appendNext,
                  ),
                  if (appendNext)
                    const ActivityFeedEntry(
                      id: 'next',
                      kind: ActivityFeedKind.assistant,
                      text: '下一段输出',
                      streaming: true,
                    ),
                ],
                finalOutput: running
                    ? null
                    : const ActivityFeedEntry(
                        id: 'final',
                        kind: ActivityFeedKind.assistant,
                        text: '最终回复',
                      ),
              ),
            ],
          ),
        ),
      ),
    );

    await render('当前输出');
    await tester.pump();
    expect(find.byType(MarkdownBody).evaluate().length, lessThan(20));
    expect(find.textContaining('记录 0', findRichText: true), findsNothing);
    final tailFinder = find.byWidgetPredicate(
      (widget) => widget is PacedStreamText && widget.text.startsWith('当前输出'),
    );
    final tail = tester.element(tailFinder);
    await render('当前输出追加内容');
    await tester.pump(const Duration(milliseconds: 50));
    expect(tail.mounted, isTrue);
    expect(scroll.offset, closeTo(0, 1));

    // Reading history must mount older rows without losing the live tail data.
    scroll.jumpTo(1000);
    await tester.pump();
    await tester.pump();
    final readingPosition = scroll.offset;
    await render('当前输出追加内容，继续增长');
    await tester.pump(const Duration(milliseconds: 50));
    expect(scroll.offset, closeTo(readingPosition, 1));
    expect(find.byType(MarkdownBody).evaluate().length, lessThan(20));
    scroll.jumpTo(0);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    expect(find.textContaining('继续增长', findRichText: true), findsOneWidget);

    final returnedTail = tester.element(tailFinder);
    await render('当前输出追加内容，继续增长', appendNext: true);
    await tester.pump(const Duration(milliseconds: 50));
    expect(tester.element(tailFinder), same(returnedTail));
    expect(find.text('下一段输出', findRichText: true), findsOneWidget);

    await render('当前输出追加内容，继续增长', running: false);
    await tester.pump(const Duration(milliseconds: 250));
    expect(find.text('最终回复', findRichText: true), findsOneWidget);
    expect(find.textContaining('记录 239', findRichText: true), findsNothing);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox.shrink());
  });
}
