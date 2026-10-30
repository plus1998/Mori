import 'dart:io';

import 'package:eco_mobile/core/models/composer_reference_models.dart';
import 'package:eco_mobile/core/models/integration_models.dart';
import 'package:eco_mobile/core/models/mcp_models.dart';
import 'package:eco_mobile/core/models/thread_models.dart';
import 'package:eco_mobile/core/network/desktop_rpc.dart';
import 'package:eco_mobile/core/network/eco_center_client.dart';
import 'package:eco_mobile/core/storage/credential_store.dart';
import 'package:eco_mobile/core/theme/eco_icons.dart';
import 'package:eco_mobile/core/theme/eco_theme.dart';
import 'package:eco_mobile/core/utils/composer_references.dart';
import 'package:eco_mobile/core/widgets/composer_prompt_editing_controller.dart';
import 'package:eco_mobile/features/composer/session_composer.dart';
import 'package:eco_mobile/features/threads/thread_providers.dart';
import 'package:eco_mobile/l10n/generated/app_localizations.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

// Real composer and native keyboard, local reference metadata. No account or
// model calls; transport and prompt resolution are covered separately.
void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  testWidgets(
    'native reference menu keeps keyboard and durable IDs in both themes',
    (tester) async {
      for (final dark in [false, true]) {
        final appKey = GlobalKey<_ReferenceAppState>();
        await tester.pumpWidget(_ReferenceApp(key: appKey, dark: dark));
        await tester.pumpAndSettle();
        await tester.tap(find.byIcon(EcoIcons.add));
        await tester.pumpAndSettle();
        await tester.ensureVisible(find.text('引用上下文'));
        await tester.tap(find.text('引用上下文'));
        await tester.pumpAndSettle();
        final picker = find.byKey(const ValueKey('composer-reference-picker'));
        expect(picker, findsOneWidget);
        final input = tester.widget<TextField>(find.byType(TextField).first);
        final media = MediaQueryData.fromView(View.of(tester.element(picker)));
        expect(
          media.viewInsets.bottom,
          greaterThan(0),
          reason: 'Native keyboard must stay open',
        );
        expect(
          tester.getRect(picker).bottom,
          lessThan(media.size.height - media.viewInsets.bottom),
        );
        expect(tester.getRect(picker).top, greaterThan(media.padding.top));
        expect(find.text('生产服务器'), findsOneWidget);
        const directory = String.fromEnvironment('ECO_COMPOSER_SCREENSHOTS');
        if (directory.isNotEmpty) {
          if (!directory.startsWith('/tmp/')) {
            throw ArgumentError('Screenshots must stay in /tmp.');
          }
          await Directory(directory).create(recursive: true);
          final name = 'references-${dark ? 'dark' : 'light'}';
          await File(
            '$directory/$name.png',
          ).writeAsBytes(await binding.takeScreenshot(name));
        }
        await tester.tap(find.text('SSH 书签'));
        await tester.pumpAndSettle();
        expect(find.text('项目文档'), findsNothing);
        await tester.tap(find.text('生产服务器'));
        await tester.pumpAndSettle();
        expect(picker, findsNothing);
        expect(input.focusNode!.hasFocus, isTrue);
        final controller = appKey.currentState!.controller;
        expect(controller.text, '@生产服务器 ');
        final reference = parseComposerPrompt(controller.prompt).first;
        expect(reference.kind, 'ssh');
        expect(reference.id, 'ssh-prod');
        await tester.enterText(
          find.byType(TextField).first,
          '${controller.text}继续检查@网页',
        );
        await tester.pumpAndSettle();
        expect(find.text('项目文档'), findsOneWidget);
        await tester.tap(find.text('项目文档'));
        await tester.pumpAndSettle();
        expect(
          parseComposerPrompt(
            controller.prompt,
          ).where((s) => s.isReference).map((s) => s.id),
          ['ssh-prod', 'web-docs'],
        );
        expect(tester.takeException(), isNull);
      }
    },
  );
}

class _ReferenceRpc extends DesktopRpc {
  _ReferenceRpc() : super(EcoCenterClient(store: CredentialStore()), 'desktop');
  @override
  Future<ComposerReferenceSearchResult> searchComposerReferences({
    required String query,
    String? kind,
    int limit = 12,
  }) async => ComposerReferenceSearchResult(
    items: const [
      ComposerReference(
        kind: 'ssh',
        id: 'ssh-prod',
        label: '生产服务器',
        detail: 'deploy@production.example.com',
      ),
      ComposerReference(
        kind: 'web',
        id: 'web-docs',
        label: '项目文档',
        detail: 'https://docs.example.com/getting-started',
      ),
      ComposerReference(
        kind: 'conversation',
        id: 'thr-review',
        label: '移动端交互设计讨论',
        detail: '/workspace/mori',
      ),
    ].where((item) => item.matches(query, kind)).toList(),
    hasMore: false,
  );
}

class _ReferenceApp extends StatefulWidget {
  const _ReferenceApp({super.key, required this.dark});
  final bool dark;
  @override
  State<_ReferenceApp> createState() => _ReferenceAppState();
}

class _ReferenceAppState extends State<_ReferenceApp> {
  final controller = ComposerPromptEditingController();
  final rpc = _ReferenceRpc();
  var config = const ThreadRuntimeConfig(
    sessionMode: 'agent',
    subagentEnabled: {},
    bashReviewMode: 'always',
    integrationsEnabled: {'browser': true, 'imageGeneration': true},
    mcpServersEnabled: {},
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
      desktopRpcProvider.overrideWithValue(rpc),
      asrStatusProvider.overrideWith((ref) async => null),
      workflowSettingsProvider.overrideWith((ref) async => null),
      integrationAvailabilityProvider.overrideWith(
        (ref) async => const IntegrationAvailabilitySnapshot(
          integrations: [
            IntegrationAvailabilityItem(
              id: 'browser',
              enabled: true,
              available: true,
            ),
            IntegrationAvailabilityItem(
              id: 'imageGeneration',
              enabled: true,
              available: true,
              activeProfileName: '默认绘图配置',
            ),
          ],
        ),
      ),
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
          mcpSettings: McpSettingsSnapshot(servers: []),
        ),
      ),
    ],
    child: MaterialApp(
      theme: widget.dark ? buildEcoDarkTheme() : buildEcoLightTheme(),
      locale: const Locale('zh'),
      localizationsDelegates: AppLocalizations.localizationsDelegates,
      supportedLocales: AppLocalizations.supportedLocales,
      home: Scaffold(
        appBar: AppBar(title: const Text('移动端引用')),
        body: Column(
          children: [
            Expanded(
              child: Center(
                child: Text(
                  '选择上下文，继续对话',
                  style: TextStyle(
                    color: widget.dark ? Colors.white38 : Colors.black38,
                  ),
                ),
              ),
            ),
            SessionComposer(
              controller: controller,
              attachments: const [],
              runtimeConfig: config,
              threadId: '',
              isRunning: false,
              hasActivity: false,
              workspacePath: '/project',
              coreKind: 'claude',
              onPickImage: () {},
              onRemoveAttachment: (_) {},
              onSend: () {},
              onStop: () {},
              onRuntimeConfigChanged: (value) => setState(() => config = value),
            ),
          ],
        ),
      ),
    ),
  );
}
