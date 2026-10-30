import 'package:eco_mobile/core/theme/eco_theme.dart';
import 'package:eco_mobile/core/utils/approval_feedback.dart';
import 'package:eco_mobile/core/widgets/activity_feed_speak_button.dart';
import 'package:eco_mobile/features/threads/activity_feed.dart';
import 'package:eco_mobile/l10n/generated/app_localizations.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

String _envelope(String feedback, [String tool = 'Bash']) =>
    'The user rejected the preceding $tool approval.\n'
    'User feedback: $feedback\n'
    'Do not retry the rejected request unless the user explicitly asks for it again.';

void main() {
  test('complete approval feedback retains multiline text and tool label', () {
    for (final tool in [
      'Bash',
      'FileChange',
      'PermissionGrant',
      'image generation',
    ]) {
      final parsed = parseApprovalFeedback(
        _envelope('你要查什么给我语句查\n<xml> & "引号"', tool),
      )!;
      expect(parsed.toolLabel, tool);
      expect(parsed.feedback, '你要查什么给我语句查\n<xml> & "引号"');
    }
    expect(
      parseApprovalFeedback(
        _envelope('a\nb').replaceAll('\n', '\r\n'),
      )!.feedback,
      'a\r\nb',
    );
  });

  test('ordinary, embedded, incomplete and empty messages stay untouched', () {
    final valid = _envelope('原因');
    for (final text in [
      '普通消息',
      '请解释：$valid',
      '$valid\n后续问题',
      valid.substring(0, valid.length - 1),
      _envelope('  '),
    ]) {
      expect(parseApprovalFeedback(text), isNull);
    }
  });

  testWidgets('long feedback expands and a replaced message clears the card', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(320, 700);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final scroll = ScrollController();
    addTearDown(scroll.dispose);
    final feedback = List.generate(12, (index) => '反馈第 $index 行').join('\n');
    Future<void> render(String text) => tester.pumpWidget(
      MaterialApp(
        theme: buildEcoLightTheme(),
        locale: const Locale('zh'),
        localizationsDelegates: AppLocalizations.localizationsDelegates,
        supportedLocales: AppLocalizations.supportedLocales,
        home: Scaffold(
          body: ActivityFeedList(
            scrollController: scroll,
            entries: [
              ActivityFeedEntry(
                id: 'feedback',
                kind: ActivityFeedKind.user,
                text: text,
              ),
            ],
          ),
        ),
      ),
    );
    await render(_envelope(feedback));
    await tester.pumpAndSettle();
    expect(tester.widget<Text>(find.text(feedback)).maxLines, 5);
    await tester.tap(find.text('展开全文'));
    await tester.pumpAndSettle();
    expect(tester.widget<Text>(find.text(feedback)).maxLines, isNull);
    expect(tester.takeException(), isNull);
    await render('普通用户消息');
    await tester.pumpAndSettle();
    expect(find.text('普通用户消息'), findsOneWidget);
    expect(find.text('已拒绝 Bash 审批'), findsNothing);
    await tester.pumpWidget(const SizedBox.shrink());
  });

  for (final dark in [false, true]) {
    for (final locale in ['zh', 'en']) {
      testWidgets(
        'feedback renders and copies user text ($locale, dark=$dark)',
        (tester) async {
          tester.view.physicalSize = const Size(320, 700);
          tester.view.devicePixelRatio = 1;
          addTearDown(tester.view.resetPhysicalSize);
          addTearDown(tester.view.resetDevicePixelRatio);
          final scroll = ScrollController();
          addTearDown(scroll.dispose);
          String? copied;
          tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
            SystemChannels.platform,
            (call) async {
              if (call.method == 'Clipboard.setData') {
                copied = (call.arguments as Map)['text'] as String;
              }
              return null;
            },
          );
          addTearDown(
            () => tester.binding.defaultBinaryMessenger
                .setMockMethodCallHandler(SystemChannels.platform, null),
          );
          await tester.pumpWidget(
            MaterialApp(
              theme: dark ? buildEcoDarkTheme() : buildEcoLightTheme(),
              locale: Locale(locale),
              localizationsDelegates: AppLocalizations.localizationsDelegates,
              supportedLocales: AppLocalizations.supportedLocales,
              home: Scaffold(
                body: ActivityFeedList(
                  scrollController: scroll,
                  entries: [
                    ActivityFeedEntry(
                      id: 'feedback',
                      kind: ActivityFeedKind.user,
                      text: _envelope('你要查什么给我语句查\n保留原文'),
                    ),
                  ],
                ),
              ),
            ),
          );
          await tester.pumpAndSettle();
          expect(
            find.text(
              locale == 'zh' ? '已拒绝 Bash 审批' : 'Bash approval rejected',
            ),
            findsOneWidget,
          );
          expect(find.text('你要查什么给我语句查\n保留原文'), findsOneWidget);
          expect(find.textContaining('Do not retry'), findsNothing);
          expect(find.textContaining('The user rejected'), findsNothing);
          expect(tester.takeException(), isNull);
          await tester.tap(find.byType(ActivityFeedCopyButton));
          await tester.pump();
          expect(copied, '你要查什么给我语句查\n保留原文');
          await tester.pumpWidget(const SizedBox.shrink());
        },
      );
    }
  }
}
