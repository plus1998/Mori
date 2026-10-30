import 'dart:convert';

import 'package:eco_mobile/core/theme/eco_icons.dart';
import 'package:eco_mobile/core/theme/eco_theme.dart';
import 'package:eco_mobile/features/threads/activity_feed.dart';
import 'package:eco_mobile/l10n/generated/app_localizations.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

String _token(String label, {String detail = ''}) =>
    '@todo{${Uri.encodeComponent(jsonEncode({'id': 'todo-1', 'label': label, 'detail': detail}))}}';

void main() {
  Future<void> showPrompt(
    WidgetTester tester,
    String prompt, {
    bool dark = true,
    double scale = 1,
  }) async {
    await tester.binding.setSurfaceSize(const Size(320, 700));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final scroll = ScrollController();
    addTearDown(scroll.dispose);
    await tester.pumpWidget(
      MaterialApp(
        theme: dark ? buildEcoDarkTheme() : buildEcoLightTheme(),
        locale: const Locale('zh'),
        localizationsDelegates: AppLocalizations.localizationsDelegates,
        supportedLocales: AppLocalizations.supportedLocales,
        builder: (context, child) => MediaQuery(
          data: MediaQuery.of(
            context,
          ).copyWith(textScaler: TextScaler.linear(scale)),
          child: child!,
        ),
        home: Scaffold(
          body: ActivityFeedList(
            entries: [
              ActivityFeedEntry(
                id: 'user',
                kind: ActivityFeedKind.user,
                text: prompt,
              ),
            ],
            scrollController: scroll,
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
  }

  testWidgets(
    'encoded details do not expand a short reference; copy keeps token',
    (tester) async {
      final raw = '处理 ${_token('移动端适配', detail: '详情' * 400)}';
      await showPrompt(tester, raw);
      expect(find.text('@移动端适配'), findsOneWidget);
      expect(find.textContaining('%7B'), findsNothing);
      expect(find.text('展开全文'), findsNothing);
      expect(find.byIcon(Icons.checklist_rounded), findsOneWidget);
      final calls = <MethodCall>[];
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        SystemChannels.platform,
        (call) async {
          calls.add(call);
          return null;
        },
      );
      addTearDown(
        () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
          SystemChannels.platform,
          null,
        ),
      );
      await tester.tap(find.byIcon(EcoIcons.copy));
      await tester.pump();
      expect(
        calls.singleWhere((c) => c.method == 'Clipboard.setData').arguments,
        {'text': raw},
      );
      expect(tester.takeException(), isNull);
    },
  );

  for (final dark in [false, true]) {
    testWidgets(
      'long reference fits narrow screen at double text size (dark=$dark)',
      (tester) async {
        final label = '移动端很长的待办名称' * 30;
        await showPrompt(tester, _token(label), dark: dark, scale: 2);
        final text = tester.widget<Text>(find.text('@$label'));
        expect(text.overflow, TextOverflow.ellipsis);
        expect(find.text('展开全文'), findsNothing);
        expect(tester.getSize(find.text('@$label')).width, lessThan(260));
        expect(tester.takeException(), isNull);
      },
    );
  }

  testWidgets('multiline reference messages can expand and update', (
    tester,
  ) async {
    final raw = List.generate(8, (i) => _token('待办 $i')).join('\n');
    await showPrompt(tester, raw);
    expect(find.text('展开全文'), findsOneWidget);
    await tester.tap(find.text('展开全文'));
    await tester.pumpAndSettle();
    expect(find.text('收起'), findsOneWidget);
    expect(find.text('@待办 7'), findsOneWidget);
    await showPrompt(tester, _token('更新后的待办'));
    expect(find.text('@更新后的待办'), findsOneWidget);
    expect(find.text('@待办 0'), findsNothing);
    expect(find.text('展开全文'), findsNothing);
    expect(tester.takeException(), isNull);
  });
}
