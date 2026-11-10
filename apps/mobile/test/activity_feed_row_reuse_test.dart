import 'package:eco_mobile/core/theme/eco_theme.dart';
import 'package:eco_mobile/core/widgets/paced_stream_text.dart';
import 'package:eco_mobile/features/threads/activity_feed.dart';
import 'package:eco_mobile/l10n/generated/app_localizations.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_markdown/flutter_markdown.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  testWidgets('tail updates retain the display subtree of unchanged history', (
    tester,
  ) async {
    final scroll = ScrollController();
    addTearDown(scroll.dispose);
    Widget app(
      int tick, {
      String history = '固定的历史',
      bool meta = false,
      bool dark = false,
    }) => ProviderScope(
      child: MaterialApp(
        theme: dark ? buildEcoDarkTheme() : buildEcoLightTheme(),
        localizationsDelegates: AppLocalizations.localizationsDelegates,
        supportedLocales: AppLocalizations.supportedLocales,
        home: Scaffold(
          body: BatchedStreamUpdates(
            child: ActivityFeedList(
              scrollController: scroll,
              showMessageCopyAndTime: meta,
              // Production callbacks may be recreated as the parent builds.
              onOpenAgentDetail: (_) {},
              entries: [
                ActivityFeedEntry(
                  id: 'history',
                  kind: ActivityFeedKind.assistant,
                  text: history,
                ),
                ActivityFeedEntry(
                  id: 'tail',
                  kind: ActivityFeedKind.assistant,
                  text: '流式输出 $tick',
                  streaming: true,
                ),
              ],
            ),
          ),
        ),
      ),
    );
    Finder historyText(String text) => find.byWidgetPredicate(
      (widget) => widget is PacedStreamText && widget.text == text,
    );
    await tester.pumpWidget(app(0));
    final initial = tester.widget<PacedStreamText>(historyText('固定的历史'));
    for (var i = 1; i <= 20; i++) {
      await tester.pumpWidget(app(i));
      expect(tester.widget(historyText('固定的历史')), same(initial));
    }
    final markdown = find.descendant(
      of: historyText('固定的历史'),
      matching: find.byType(MarkdownBody),
    );
    final lightColor = tester
        .widget<MarkdownBody>(markdown)
        .styleSheet!
        .p!
        .color;
    await tester.pumpWidget(app(20, dark: true));
    await tester.pump(const Duration(milliseconds: 300));
    expect(tester.widget(historyText('固定的历史')), same(initial));
    expect(
      tester.widget<MarkdownBody>(markdown).styleSheet!.p!.color,
      isNot(lightColor),
      reason: 'Reusing the widget must preserve inherited theme updates',
    );
    await tester.pumpWidget(app(21, history: '修正的历史'));
    expect(find.text('修正的历史', findRichText: true), findsOneWidget);
    expect(historyText('固定的历史'), findsNothing);
    final repaired = tester.widget(historyText('修正的历史'));
    await tester.pumpWidget(app(21, history: '修正的历史', meta: true));
    expect(
      tester.widget(historyText('修正的历史')),
      isNot(same(repaired)),
      reason: 'Message action visibility must still follow the parent',
    );
    await tester.pumpWidget(const SizedBox.shrink());
  });
}
