import 'dart:io';

import 'package:eco_mobile/core/models/thread_models.dart';
import 'package:eco_mobile/core/theme/eco_icons.dart';
import 'package:eco_mobile/core/theme/eco_theme.dart';
import 'package:eco_mobile/features/composer/session_composer.dart';
import 'package:eco_mobile/features/composer/composer_plus_menu.dart';
import 'package:eco_mobile/features/composer/ios_composer_send_button.dart';
import 'package:eco_mobile/features/scheduling/schedule_editor.dart';
import 'package:eco_mobile/features/threads/thread_providers.dart';
import 'package:eco_mobile/l10n/generated/app_localizations.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

// Production composer, local state and callbacks; no account, RPC or model calls.
void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  Future<void> screenshot(String name) async {
    const directory = String.fromEnvironment('ECO_COMPOSER_SCREENSHOTS');
    if (directory.isEmpty) return;
    if (!directory.startsWith('/tmp/')) {
      throw ArgumentError('Screenshots must stay in /tmp.');
    }
    await Directory(directory).create(recursive: true);
    await File(
      '$directory/$name.png',
    ).writeAsBytes(await binding.takeScreenshot(name));
  }

  testWidgets('Harness changes from plus menu and stays out of model popup', (
    tester,
  ) async {
    await tester.pumpWidget(const _ComposerApp(dark: false));
    await tester.pumpAndSettle();
    await tester.tap(find.text('5.6 Sol'));
    await tester.pumpAndSettle();
    expect(find.text('Harness'), findsNothing);
    await tester.tapAt(const Offset(20, 100));
    await tester.pumpAndSettle();
    await tester.tap(find.byIcon(EcoIcons.add));
    await tester.pumpAndSettle();
    await tester.ensureVisible(find.text('Harness'));
    expect(find.text('Claude Code'), findsOneWidget);
    await tester.tap(find.text('Harness'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Codex'));
    await tester.pumpAndSettle();
    expect(find.byType(ComposerPlusMenuPanel), findsNothing);
    await tester.tap(find.byIcon(EcoIcons.add));
    await tester.pumpAndSettle();
    await tester.ensureVisible(find.text('Harness'));
    expect(find.text('Codex'), findsOneWidget);
    await screenshot('composer-harness-menu');
  });

  testWidgets(
    'running conversation schedules via plus menu and native send callback',
    (tester) async {
      await tester.pumpWidget(const _ComposerApp(dark: false, running: true));
      await tester.pumpAndSettle();
      await tester.tap(find.byIcon(EcoIcons.add));
      await tester.pumpAndSettle();
      await tester.tap(find.text('添加定时消息'));
      await tester.pumpAndSettle();
      var editor = tester.widget<ScheduleEditor>(find.byType(ScheduleEditor));
      expect(editor.threadId, 'thread-running');
      expect(editor.newThread, isNull);
      await tester.tap(find.byType(CloseButton));
      await tester.pumpAndSettle();
      await tester.enterText(find.byType(TextField).first, '运行中定时发送');
      await tester.pumpAndSettle();
      // UIKit menu actions reach this callback; its channel is covered by the
      // IOSComposerSendButton widget test. Flutter finders cannot inspect UIMenu.
      final send = tester.widget<IOSComposerSendButton>(
        find.byType(IOSComposerSendButton),
      );
      expect(send.onSchedule, isNotNull);
      send.onSchedule!();
      await tester.pumpAndSettle();
      editor = tester.widget<ScheduleEditor>(find.byType(ScheduleEditor));
      expect(editor.threadId, 'thread-running');
      expect(editor.initialPrompt, '运行中定时发送');
      await screenshot('composer-running-schedule');
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'native composer menu, configuration and keyboard remain anchored',
    (tester) async {
      for (final dark in [false, true]) {
        final style = dark ? 'dark' : 'light';
        await tester.pumpWidget(_ComposerApp(key: ValueKey(dark), dark: dark));
        await tester.pumpAndSettle();
        await tester.tap(find.text('5.6 Sol'));
        await tester.pumpAndSettle();
        expect(find.text('模型'), findsOneWidget);
        expect(find.text('推理'), findsOneWidget);
        for (final duplicate in [
          '主 Agent',
          '提示词',
          '子代理',
          '辅助模型',
          '审批模型',
          '视觉模型',
          '高级',
        ]) {
          expect(find.text(duplicate), findsNothing);
        }
        await tester.tap(find.text('模型'));
        await tester.pumpAndSettle();
        await screenshot('composer-model-$style');
        await tester.tapAt(const Offset(20, 100));
        await tester.pumpAndSettle();
        await tester.tap(find.byIcon(EcoIcons.add));
        await tester.pumpAndSettle();
        final panel = find.byKey(const ValueKey('composer-plus-panel'));
        expect(find.text('对话模式'), findsOneWidget);
        expect(find.text('更多操作'), findsOneWidget);
        expect(find.text('运行配置'), findsOneWidget);
        expect(tester.getSize(panel).height, lessThanOrEqualTo(420));
        await screenshot('composer-menu-$style');
        await tester.ensureVisible(find.text('运行配置'));
        await tester.tap(find.text('运行配置'));
        await tester.pumpAndSettle();
        expect(find.text('主 Agent'), findsOneWidget);
        expect(find.text('Skills'), findsNothing);
        expect(find.text('视觉模型'), findsOneWidget);
        await screenshot('composer-config-$style');
        await tester.tap(find.byTooltip('返回菜单'));
        await tester.pumpAndSettle();
        await tester.ensureVisible(find.text('Skills'));
        await tester.tap(find.text('Skills'));
        await tester.pumpAndSettle();
        await tester.binding.handlePopRoute();
        await tester.pumpAndSettle();
        await tester.ensureVisible(find.text('Plan'));
        await tester.tap(find.text('Plan'));
        await tester.pumpAndSettle();
        expect(panel, findsNothing);
        expect(find.byIcon(EcoIcons.planMode), findsOneWidget);
        await tester.tap(find.byIcon(EcoIcons.add));
        await tester.pumpAndSettle();
        expect(find.text('当前开启'), findsOneWidget);
        await tester.tap(find.text('Plan'));
        await tester.pumpAndSettle();
        expect(find.byIcon(EcoIcons.planMode), findsNothing);
        await tester.tap(find.byType(TextField).first);
        await tester.pumpAndSettle();
        await tester.enterText(find.byType(TextField).first, '键盘展开时检查菜单');
        await tester.pumpAndSettle();
        await tester.tap(find.byIcon(EcoIcons.add));
        await tester.pumpAndSettle();
        final media = MediaQuery.of(tester.element(panel));
        expect(
          media.viewInsets.bottom,
          greaterThan(0),
          reason: 'Native keyboard must be open',
        );
        final rect = tester.getRect(panel);
        expect(rect.top, greaterThanOrEqualTo(media.padding.top));
        expect(
          rect.bottom,
          lessThan(media.size.height - media.viewInsets.bottom),
        );
        await screenshot('composer-keyboard-$style');
        await tester.ensureVisible(find.text('运行配置'));
        await tester.ensureVisible(find.text('运行配置'));
        await tester.tap(find.text('运行配置'));
        await tester.pumpAndSettle();
        await tester.tap(find.byTooltip('关闭'));
        await tester.pumpAndSettle();
        expect(panel, findsNothing);
        expect(tester.takeException(), isNull);
      }
    },
  );
}

class _ComposerApp extends StatefulWidget {
  const _ComposerApp({super.key, required this.dark, this.running = false});
  final bool dark;
  final bool running;

  @override
  State<_ComposerApp> createState() => _ComposerAppState();
}

class _ComposerAppState extends State<_ComposerApp> {
  final controller = TextEditingController();
  var coreKind = 'claude';
  var config = const ThreadRuntimeConfig(
    sessionMode: 'agent',
    subagentEnabled: {},
    bashReviewMode: 'always',
    orchestrationSelection: OrchestrationSelection(
      mainAgentConfigId: 'main-1',
      mainPrompt: BuiltinMainAgentPromptSelection(),
      subagents: NoneSubagentSelection(),
    ),
  );

  @override
  void dispose() {
    controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => ProviderScope(
    overrides: [
      desktopRpcProvider.overrideWithValue(null),
      modelSettingsProvider.overrideWith(
        (ref) async => const ModelSettingsSnapshot(
          mainAgentConfigs: [
            MainAgentConfigResource(
              id: 'main-1',
              name: 'Coding',
              agentKey: 'main',
              modelRef: OrchestrationModelRef(
                providerId: 'provider-1',
                modelId: 'gpt-5.6-sol',
                thinkingEffort: 'high',
              ),
              tools: ToolPolicy(),
            ),
          ],
          providers: [
            ModelProviderView(
              id: 'provider-1',
              name: 'OpenAI',
              defaultModel: 'gpt-5.6-sol',
              enabled: true,
            ),
          ],
        ),
      ),
    ],
    child: MaterialApp(
      theme: widget.dark ? buildEcoDarkTheme() : buildEcoLightTheme(),
      locale: const Locale('zh'),
      localizationsDelegates: AppLocalizations.localizationsDelegates,
      supportedLocales: AppLocalizations.supportedLocales,
      home: Scaffold(
        body: Align(
          alignment: Alignment.bottomCenter,
          child: SessionComposer(
            controller: controller,
            attachments: const [],
            runtimeConfig: config,
            threadId: widget.running ? 'thread-running' : '',
            isRunning: widget.running,
            followUpMode: widget.running,
            coreKind: coreKind,
            onCoreKindChanged: (value) => setState(() => coreKind = value),
            hasActivity: false,
            onPickImage: () {},
            onRemoveAttachment: (_) {},
            onSend: () {},
            onStop: () {},
            onRuntimeConfigChanged: (value) => setState(() => config = value),
          ),
        ),
      ),
    ),
  );
}
