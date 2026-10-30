import 'dart:io';

import 'package:eco_mobile/core/models/thread_models.dart';
import 'package:eco_mobile/core/theme/eco_theme.dart';
import 'package:eco_mobile/core/widgets/progressive_blur.dart';
import 'package:eco_mobile/features/approvals/approval_sheets.dart';
import 'package:eco_mobile/features/composer/composer_dock_shell.dart';
import 'package:eco_mobile/features/threads/thread_session_layout.dart';
import 'package:eco_mobile/l10n/generated/app_localizations.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

const _textQuestion =
    '请先在桌面端终端运行 gh auth login --hostname github.com --web，完成后回复“已登录”。登录凭据请留在终端，不要发到聊天里；我会继续完成本地签名验证。';

// Native UI harness: production dock/layout, local callbacks, no account or RPC.
void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  Future<void> screenshot(String name) async {
    const directory = String.fromEnvironment('ECO_QUESTION_SCREENSHOTS');
    if (directory.isEmpty) return;
    if (!directory.startsWith('/tmp/')) {
      throw ArgumentError('Screenshots must stay in /tmp.');
    }
    await Directory(directory).create(recursive: true);
    // Let the native compositor present Flutter's frame. The marker also lets
    // a host-side simctl capture include the system keyboard (a separate window).
    await Future<void>.delayed(const Duration(milliseconds: 500));
    debugPrint('QUESTION_SCREENSHOT_READY $name');
    await Future<void>.delayed(const Duration(seconds: 3));
    final bytes = await binding.takeScreenshot(name);
    await File('$directory/$name.png').writeAsBytes(bytes);
  }

  testWidgets('native question dock selects, types with keyboard and closes', (
    tester,
  ) async {
    await ProgressiveBlur.preload();
    await tester.pumpWidget(const _QuestionApp());
    await tester.pumpAndSettle();
    final panel = find.byKey(const Key('clarification-dock-panel'));
    expect(
      tester.getSize(panel).height,
      lessThanOrEqualTo(MediaQuery.sizeOf(tester.element(panel)).height * .72),
    );
    await screenshot('question-options');
    final option = find.text('选项 7');
    await tester.scrollUntilVisible(
      option,
      160,
      scrollable: find.descendant(
        of: find.byKey(const Key('clarification-content-scroll')),
        matching: find.byType(Scrollable),
      ),
    );
    await tester.tap(option);
    await tester.pumpAndSettle();
    expect(find.text(_textQuestion), findsOneWidget);
    expect(find.text('其他（自行输入）'), findsNothing);
    expect(MediaQuery.viewInsetsOf(tester.element(panel)).bottom, 0);
    await screenshot('question-free-text');
    final input = find.byType(TextField);
    await tester.ensureVisible(input);
    await tester.tap(input);
    await tester.pumpAndSettle();
    await tester.enterText(input, '模拟器可以输入并提交');
    await tester.pumpAndSettle();
    final submit = find.text('提交');
    final close = find.byTooltip('关闭');
    final context = tester.element(panel);
    final media = MediaQuery.of(context);
    expect(media.viewInsets.bottom, greaterThan(0), reason: '必须弹出原生键盘');
    expect(
      tester.getBottomRight(submit).dy,
      lessThanOrEqualTo(media.size.height - media.viewInsets.bottom),
    );
    expect(
      tester.getTopLeft(close).dy,
      greaterThanOrEqualTo(media.padding.top),
    );
    debugPrint(
      'QUESTION_UI keyboard=${media.viewInsets.bottom} panel=${tester.getSize(panel).height}',
    );
    await screenshot('question-keyboard');
    await tester.tap(submit);
    await tester.pumpAndSettle();
    expect(find.text('已提交：选项 7 / 模拟器可以输入并提交'), findsOneWidget);
    expect(panel, findsNothing);
    await tester.tap(find.text('再次提问'));
    await tester.pumpAndSettle();
    await tester.tap(find.byTooltip('关闭'));
    await tester.pumpAndSettle();
    expect(find.text('提问已关闭'), findsOneWidget);
    expect(panel, findsNothing);
    expect(tester.takeException(), isNull);
    debugPrint('QUESTION_UI selection, free text, submit and close passed');
  });
}

class _QuestionApp extends StatefulWidget {
  const _QuestionApp();
  @override
  State<_QuestionApp> createState() => _QuestionAppState();
}

class _QuestionAppState extends State<_QuestionApp> {
  bool _showQuestion = true;
  String _result = '本地提问交互验证';
  int _round = 0;

  @override
  Widget build(BuildContext context) => MaterialApp(
    theme: buildEcoDarkTheme(),
    locale: const Locale('zh'),
    localizationsDelegates: AppLocalizations.localizationsDelegates,
    supportedLocales: AppLocalizations.supportedLocales,
    home: Builder(
      builder: (context) => Scaffold(
        resizeToAvoidBottomInset: false,
        body: ThreadSessionConversationLayout(
          feedBuilder: (_, _, _) => Center(child: Text(_result)),
          composer: AnimatedPadding(
            duration: const Duration(milliseconds: 100),
            padding: EdgeInsets.only(
              bottom: MediaQuery.viewInsetsOf(context).bottom,
            ),
            child: ComposerDockShell(
              child: _showQuestion
                  ? ClarificationDockPanel(
                      key: ValueKey(_round),
                      request: ClarificationRequest(
                        toolUseId: 'native-question-$_round',
                        threadId: 'local-test',
                        questions: [
                          ClarificationQuestion(
                            question:
                                '请选择需要验证的移动端场景。这里使用较长的选项列表，检查问题卡是否超出屏幕以及按钮能否点击。',
                            options: [
                              for (var i = 0; i < 10; i++)
                                ClarificationQuestionOption(
                                  label: '选项 $i',
                                  description: '用于验证长列表滚动、点选与分页的测试说明。',
                                ),
                            ],
                          ),
                          const ClarificationQuestion(
                            question: _textQuestion,
                            options: [],
                          ),
                        ],
                      ),
                      busy: false,
                      onSubmit: (answers, {customInputIndices}) async =>
                          setState(() {
                            _result =
                                '已提交：${answers.map((row) => row.join('、')).join(' / ')}';
                            _showQuestion = false;
                          }),
                      onDismiss: () async => setState(() {
                        _result = '提问已关闭';
                        _showQuestion = false;
                      }),
                    )
                  : SafeArea(
                      top: false,
                      child: TextButton(
                        onPressed: () => setState(() {
                          _round++;
                          _showQuestion = true;
                        }),
                        child: const Text('再次提问'),
                      ),
                    ),
            ),
          ),
        ),
      ),
    ),
  );
}
