import 'package:eco_mobile/core/theme/eco_theme.dart';
import 'package:eco_mobile/core/widgets/eco_markdown.dart';
import 'package:flutter/material.dart';
import 'package:flutter_markdown/flutter_markdown.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  Widget app({String text = '**完整消息**', double scale = 1, bool dark = false}) =>
      MaterialApp(
        theme: dark ? buildEcoDarkTheme() : buildEcoLightTheme(),
        home: EcoMarkdown(text: text, fontSizeScale: scale),
      );

  testWidgets('unchanged messages reuse the Markdown subtree on feed updates', (
    tester,
  ) async {
    await tester.pumpWidget(app());
    final content = tester.widget<MarkdownBody>(find.byType(MarkdownBody));
    for (var update = 0; update < 10; update++) {
      await tester.pumpWidget(app());
      expect(
        tester.widget<MarkdownBody>(find.byType(MarkdownBody)),
        same(content),
      );
    }
  });

  testWidgets('cached Markdown follows text, font and theme changes', (
    tester,
  ) async {
    await tester.pumpWidget(app());
    var content = tester.widget<MarkdownBody>(find.byType(MarkdownBody));
    await tester.pumpWidget(app(text: '更新消息'));
    var updated = tester.widget<MarkdownBody>(find.byType(MarkdownBody));
    expect(updated.data.trim(), '更新消息');
    expect(updated, isNot(same(content)));
    content = updated;
    await tester.pumpWidget(app(text: '更新消息', scale: 1.5));
    updated = tester.widget<MarkdownBody>(find.byType(MarkdownBody));
    expect(
      updated.styleSheet!.p!.fontSize,
      content.styleSheet!.p!.fontSize! * 1.5,
    );
    content = updated;
    await tester.pumpWidget(app(text: '更新消息', scale: 1.5, dark: true));
    await tester.pumpAndSettle();
    updated = tester.widget<MarkdownBody>(find.byType(MarkdownBody));
    expect(updated.styleSheet!.p!.color, isNot(content.styleSheet!.p!.color));
  });
}
