import 'package:eco_mobile/core/theme/eco_theme.dart';
import 'package:eco_mobile/core/widgets/eco_markdown.dart';
import 'package:eco_mobile/core/widgets/eco_markdown_table.dart';
import 'package:eco_mobile/core/widgets/streaming_eco_markdown.dart';
import 'package:eco_mobile/l10n/generated/app_localizations.dart';
import 'package:flutter/material.dart';
import 'package:flutter_markdown/flutter_markdown.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:markdown/markdown.dart' as md;

Widget app(
  String text, {
  double scale = 1,
  bool dark = false,
  bool live = true,
}) => MaterialApp(
  theme: dark ? buildEcoDarkTheme() : buildEcoLightTheme(),
  localizationsDelegates: AppLocalizations.localizationsDelegates,
  supportedLocales: AppLocalizations.supportedLocales,
  home: Scaffold(
    body: SingleChildScrollView(
      child: live
          ? StreamingEcoMarkdown(
              text: text,
              tailStyle: const TextStyle(fontSize: 13, height: 1.55),
              fontSizeScale: scale,
            )
          : EcoMarkdown(text: text, selectable: false, fontSizeScale: scale),
    ),
  ),
);

MarkdownBody bodyFor(WidgetTester tester, String text) => tester
    .widgetList<MarkdownBody>(find.byType(MarkdownBody))
    .firstWhere((body) => body.data.trim() == text);

void main() {
  testWidgets('long replies reuse completed Markdown bodies on every append', (
    tester,
  ) async {
    final prefix = List.generate(
      80,
      (index) => '第 $index 段 **已完成**。',
    ).join('\n\n');
    final text = '$prefix\n\n活动段落\n';
    await tester.pumpWidget(app(text));
    final completed = tester
        .widgetList<MarkdownBody>(find.byType(MarkdownBody))
        .where((body) => !body.data.contains('活动段落'))
        .toList();
    final completedWidgets = tester
        .widgetList<EcoMarkdown>(find.byType(EcoMarkdown))
        .where((body) => !body.text.contains('活动段落'))
        .toList();
    expect(completed, hasLength(80));
    for (var count = 1; count <= 30; count++) {
      await tester.pumpWidget(app('$text${'新增' * count}'));
      final updated = tester
          .widgetList<MarkdownBody>(find.byType(MarkdownBody))
          .where((body) => !body.data.contains('活动段落'))
          .toList();
      for (var index = 0; index < completed.length; index++) {
        expect(updated[index], same(completed[index]));
      }
      final updatedWidgets = tester
          .widgetList<EcoMarkdown>(find.byType(EcoMarkdown))
          .where((body) => !body.text.contains('活动段落'))
          .toList();
      for (var index = 0; index < completedWidgets.length; index++) {
        expect(updatedWidgets[index], same(completedWidgets[index]));
      }
    }
  });

  testWidgets('late reference definitions update formatted links only', (
    tester,
  ) async {
    const prefix = '[**链接**][id]\n\n普通段落\n\n尾段\n';
    await tester.pumpWidget(app(prefix));
    final plain = bodyFor(tester, '普通段落');
    final unresolved = bodyFor(tester, '[**链接**][id]');
    expect(find.textContaining('[id]', findRichText: true), findsOneWidget);
    await tester.pumpWidget(app('$prefix\n[id]: /first "标题"\n\n结束\n'));
    final resolved = bodyFor(tester, '[**链接**][id]');
    expect(resolved, isNot(same(unresolved)));
    expect(bodyFor(tester, '普通段落'), same(plain));
    expect(find.text('[id]', findRichText: true), findsNothing);
    expect(find.text('链接', findRichText: true), findsOneWidget);
    final eco = tester
        .widgetList<EcoMarkdown>(find.byType(EcoMarkdown))
        .firstWhere((widget) => widget.text.trim() == '[**链接**][id]');
    expect(eco.references!['id']!.destination, '/first');
    final nodes = md.Document(
      inlineSyntaxes: resolved.inlineSyntaxes,
      extensionSet: md.ExtensionSet.gitHubFlavored,
    ).parse('[**链接**][id] 和 ![alt][id]');
    final children = (nodes.single as md.Element).children!;
    final link = children.first as md.Element;
    expect(link.tag, 'a');
    expect(link.attributes, {'href': '/first', 'title': '标题'});
    expect((link.children!.single as md.Element).tag, 'strong');
    final image = children.last as md.Element;
    expect(image.tag, 'img');
    expect(image.attributes['src'], '/first');
    expect(image.attributes['alt'], 'alt');
    await tester.pumpWidget(
      app('$prefix\n[id]: /first "标题"\n\n结束\n\n[id]: /second\n'),
    );
    expect(bodyFor(tester, '[**链接**][id]'), same(resolved));
  });

  for (final text in [
    '前文\n\n3. 第一项\n\n   第二段\n\n4. 第二项\n\n后文\n',
    '前文\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n后文\n',
    '前文\n\n```dart\nfinal a = 1;\n```\n\n后文\n',
    '前文\n\n引用[^b] 和 [^a]\n\n再次[^b]\n\n[^a]: A\n\n[^b]: B\n',
    '前文\n\n[id]: /path\n',
  ]) {
    testWidgets('completed structural blocks retain the final layout: $text', (
      tester,
    ) async {
      await tester.pumpWidget(app(text));
      final height = tester.getSize(find.byType(StreamingEcoMarkdown)).height;
      await tester.pumpWidget(app(text, live: false));
      expect(
        tester.getSize(find.byType(EcoMarkdown)).height,
        closeTo(height, 0.01),
      );
    });
  }

  testWidgets('unfinished fences and tables keep their raw tail', (
    tester,
  ) async {
    await tester.pumpWidget(app('前文\n\n```dart\nfinal a = 1;\n'));
    expect(find.textContaining('```dart'), findsOneWidget);
    expect(
      tester
          .widgetList<MarkdownBody>(find.byType(MarkdownBody))
          .any((body) => body.data.contains('```')),
      isFalse,
    );
    await tester.pumpWidget(app('前文\n\n```dart\nfinal a = 1;\n```\n\n后文\n'));
    expect(find.textContaining('```dart'), findsNothing);
    expect(
      tester
          .widgetList<MarkdownBody>(find.byType(MarkdownBody))
          .any((body) => body.data.contains('final a = 1;')),
      isTrue,
    );
    await tester.pumpWidget(app('前文\n\n| a | b |\n| --- | --- |\n| 1 | 2 |'));
    expect(find.byType(EcoMarkdownTable), findsNothing);
    expect(find.textContaining('| --- |'), findsOneWidget);
    await tester.pumpWidget(
      app('前文\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n后文\n'),
    );
    expect(find.byType(EcoMarkdownTable), findsOneWidget);
  });

  testWidgets(
    'streaming and final prose preserve block spacing and style updates',
    (tester) async {
      const text = '第一段 **加粗**\n\n# 标题\n\n第三段\n\n最后\n';
      await tester.pumpWidget(app(text));
      final liveHeight = tester
          .getSize(find.byType(StreamingEcoMarkdown))
          .height;
      final first = bodyFor(tester, '第一段 **加粗**');
      await tester.pumpWidget(app(text, scale: 1.4, dark: true));
      await tester.pumpAndSettle();
      final styled = bodyFor(tester, '第一段 **加粗**');
      expect(
        styled.styleSheet!.p!.fontSize,
        first.styleSheet!.p!.fontSize! * 1.4,
      );
      expect(styled.styleSheet!.p!.color, isNot(first.styleSheet!.p!.color));
      await tester.pumpWidget(app(text, live: false));
      await tester.pumpAndSettle();
      expect(
        tester.getSize(find.byType(EcoMarkdown)).height,
        closeTo(liveHeight, 0.01),
      );
      await tester.pumpWidget(app('替换后的短消息'));
      expect(find.text('替换后的短消息', findRichText: true), findsOneWidget);
      expect(find.textContaining('第一段', findRichText: true), findsNothing);
    },
  );
}
