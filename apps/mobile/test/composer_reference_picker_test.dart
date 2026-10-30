import 'dart:async';

import 'package:eco_mobile/core/models/composer_reference_models.dart';
import 'package:eco_mobile/core/models/integration_models.dart';
import 'package:eco_mobile/core/models/mcp_models.dart';
import 'package:eco_mobile/core/models/thread_models.dart';
import 'package:eco_mobile/core/network/desktop_rpc.dart';
import 'package:eco_mobile/core/network/eco_center_client.dart';
import 'package:eco_mobile/core/storage/credential_store.dart';
import 'package:eco_mobile/core/theme/eco_theme.dart';
import 'package:eco_mobile/core/utils/composer_references.dart';
import 'package:eco_mobile/core/widgets/composer_prompt_editing_controller.dart';
import 'package:eco_mobile/features/composer/composer_reference_picker.dart';
import 'package:eco_mobile/features/threads/thread_providers.dart';
import 'package:eco_mobile/l10n/generated/app_localizations.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

const _config = ThreadRuntimeConfig(
  subagentEnabled: {},
  sessionMode: 'agent',
  bashReviewMode: 'always',
  integrationsEnabled: {'browser': true},
  mcpServersEnabled: {'docs': true},
);
const _ssh = ComposerReference(
  kind: 'ssh',
  id: 'ssh-prod',
  label: '生产服务器',
  detail: 'deploy@example.com',
);
const _web = ComposerReference(
  kind: 'web',
  id: 'page-1',
  label: '项目文档',
  detail: 'https://example.com/docs',
);
const _conversation = ComposerReference(
  kind: 'conversation',
  id: 'thr-other',
  label: '另一个项目的会话',
  detail: '/other/project',
);

class _Rpc extends DesktopRpc {
  _Rpc() : super(EcoCenterClient(store: CredentialStore()), 'desktop');
  Future<ComposerReferenceSearchResult> Function(String, String?)? search;
  final calls = <(String, String?)>[];

  @override
  Future<ComposerReferenceSearchResult> searchComposerReferences({
    required String query,
    String? kind,
    int limit = 12,
  }) async {
    calls.add((query, kind));
    if (search != null) return search!(query, kind);
    return ComposerReferenceSearchResult(
      items: [
        _ssh,
        _web,
        _conversation,
      ].where((item) => item.matches(query, kind)).toList(),
      hasMore: false,
    );
  }
}

void main() {
  test(
    'Chinese trigger, category aliases and email/SSH boundaries match desktop',
    () {
      for (final entry in {
        'SSH': 'ssh',
        '网页': 'web',
        '会话': 'conversation',
        '工具': 'integration',
        '待办': 'todo',
        'MCP': 'mcp',
        '子代理': 'subagent',
      }.entries) {
        final text = '帮我看看@${entry.key}：生产';
        expect(parseComposerMentionQuery(text, text.length), (
          start: 4,
          query: '生产',
          kind: entry.value,
        ));
      }
      for (final text in [
        'a@example.com',
        'user@host',
        'a@@web',
        '@foo bar',
        '@ssh{abc}',
      ]) {
        expect(parseComposerMentionQuery(text, text.length), isNull);
      }
    },
  );

  test(
    'insertion preserves surrounding references, caret, and atomic deletion',
    () {
      final controller = ComposerPromptEditingController(
        text: '${_web.token} 请用@SSH 后文',
      );
      addTearDown(controller.dispose);
      final caret = controller.text.indexOf(' 后文');
      controller.selection = TextSelection.collapsed(offset: caret);
      final query = controller.mentionQuery!;
      controller.insertReference(_ssh.token, query);
      expect(controller.prompt, '${_web.token} 请用${_ssh.token}  后文');
      expect(controller.text, '@项目文档 请用@生产服务器  后文');
      expect(
        controller.selection.extentOffset,
        controller.text.indexOf('  后文') + 1,
      );
      controller.insertReference(
        _conversation.token,
        query,
      ); // stale result cannot insert
      expect(
        parseComposerPrompt(
          controller.prompt,
        ).where((p) => p.isReference).length,
        2,
      );
      final end = controller.text.indexOf('  后文');
      controller.selection = TextSelection.collapsed(offset: end);
      controller.value = TextEditingValue(
        text: controller.text.replaceRange(end - 1, end, ''),
        selection: TextSelection.collapsed(offset: end - 1),
      );
      expect(controller.prompt, '${_web.token} 请用  后文');
    },
  );

  test(
    'reference labels, selected text and IME composition never open a new query',
    () {
      final controller = ComposerPromptEditingController(text: _ssh.token);
      addTearDown(controller.dispose);
      controller.selection = const TextSelection.collapsed(offset: 3);
      expect(controller.mentionQuery, isNull);
      controller.startMention();
      expect(controller.prompt, '${_ssh.token} @');
      expect(controller.mentionQuery?.query, '');
      controller.value = controller.value.copyWith(
        composing: TextRange(
          start: controller.text.length - 1,
          end: controller.text.length,
        ),
      );
      expect(controller.mentionQuery, isNull);
      controller.clearComposing();
      controller.selection = TextSelection(
        baseOffset: 0,
        extentOffset: controller.text.length,
      );
      expect(controller.mentionQuery, isNull);
    },
  );

  Future<void> mount(
    WidgetTester tester,
    ComposerPromptEditingController controller,
    FocusNode focus,
    _Rpc? rpc, {
    bool dark = false,
    double scale = 1,
  }) async {
    tester.view.viewInsets = FakeViewPadding(
      bottom: 280 * tester.view.devicePixelRatio,
    );
    addTearDown(tester.view.resetViewInsets);
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          desktopRpcProvider.overrideWithValue(rpc),
          modelSettingsProvider.overrideWith(
            (ref) async => const ModelSettingsSnapshot(
              mainAgentConfigs: [],
              mcpSettings: McpSettingsSnapshot(
                servers: [
                  McpServerConfigView(
                    id: 'mcp-docs',
                    name: 'Docs',
                    transport: 'stdio',
                    enabled: true,
                  ),
                ],
              ),
            ),
          ),
          integrationAvailabilityProvider.overrideWith(
            (ref) async => const IntegrationAvailabilitySnapshot(
              integrations: [
                IntegrationAvailabilityItem(
                  id: 'browser',
                  enabled: true,
                  available: true,
                ),
              ],
            ),
          ),
        ],
        child: MaterialApp(
          locale: const Locale('zh'),
          localizationsDelegates: AppLocalizations.localizationsDelegates,
          supportedLocales: AppLocalizations.supportedLocales,
          theme: dark ? buildEcoDarkTheme() : buildEcoLightTheme(),
          builder: (context, child) => MediaQuery(
            data: MediaQuery.of(context).copyWith(
              textScaler: TextScaler.linear(scale),
              viewInsets: const EdgeInsets.only(bottom: 280),
            ),
            child: child!,
          ),
          home: Scaffold(
            body: Align(
              alignment: Alignment.bottomCenter,
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  ComposerReferencePicker(
                    controller: controller,
                    focusNode: focus,
                    runtimeConfig: _config,
                    workspacePath: '/project',
                  ),
                  TextField(controller: controller, focusNode: focus),
                ],
              ),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.byType(TextField));
    await tester.pump();
  }

  testWidgets(
    'touch category filtering keeps keyboard focus and inserts durable identity',
    (tester) async {
      final c = ComposerPromptEditingController();
      final focus = FocusNode();
      addTearDown(c.dispose);
      addTearDown(focus.dispose);
      final rpc = _Rpc();
      await mount(tester, c, focus, rpc);
      await tester.enterText(find.byType(TextField), '处理@');
      await tester.pump(const Duration(milliseconds: 150));
      await tester.pumpAndSettle();
      expect(find.text('浏览器'), findsOneWidget);
      expect(find.text('Docs'), findsOneWidget);
      await tester.tap(find.text('SSH 书签'));
      await tester.pump(const Duration(milliseconds: 150));
      await tester.pumpAndSettle();
      expect(focus.hasFocus, isTrue);
      expect(find.text('项目文档'), findsNothing);
      expect(rpc.calls.last, ('', 'ssh'));
      await tester.tap(find.text('生产服务器'));
      await tester.pump();
      expect(c.prompt, '处理${_ssh.token} ');
      expect(c.selection.extentOffset, c.text.length);
      expect(focus.hasFocus, isTrue);
      expect(
        find.byKey(const ValueKey('composer-reference-picker')),
        findsNothing,
      );
      c.startMention();
      await tester.pump(const Duration(milliseconds: 150));
      await tester.pumpAndSettle();
      expect(find.text('生产服务器'), findsNothing); // already referenced
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'old network response cannot replace new query, errors can retry',
    (tester) async {
      final c = ComposerPromptEditingController();
      final focus = FocusNode();
      addTearDown(c.dispose);
      addTearDown(focus.dispose);
      final old = Completer<ComposerReferenceSearchResult>();
      var fail = true;
      final rpc = _Rpc()
        ..search = (query, kind) async {
          if (query == 'old') return old.future;
          if (query == 'error' && fail) throw StateError('搜索连接失败');
          return const ComposerReferenceSearchResult(
            items: [_ssh],
            hasMore: false,
          );
        };
      await mount(tester, c, focus, rpc);
      await tester.enterText(find.byType(TextField), '@SSH:old');
      await tester.pump(const Duration(milliseconds: 150));
      await tester.pump();
      await tester.enterText(find.byType(TextField), '@SSH:new');
      await tester.pump(const Duration(milliseconds: 150));
      await tester.pumpAndSettle();
      expect(find.text('生产服务器'), findsOneWidget);
      old.complete(
        const ComposerReferenceSearchResult(items: [_web], hasMore: false),
      );
      await tester.pump();
      expect(find.text('项目文档'), findsNothing);
      await tester.enterText(find.byType(TextField), '@SSH:error');
      await tester.pump(const Duration(milliseconds: 150));
      await tester.pumpAndSettle();
      expect(find.textContaining('搜索连接失败'), findsOneWidget);
      fail = false;
      await tester.tap(find.text('重试'));
      await tester.pump();
      await tester.pump();
      expect(find.text('生产服务器'), findsOneWidget);
      expect(tester.takeException(), isNull);
    },
  );

  for (final dark in [false, true]) {
    testWidgets(
      '320px screen, open keyboard and large text fit (${dark ? 'dark' : 'light'})',
      (tester) async {
        await tester.binding.setSurfaceSize(const Size(320, 740));
        addTearDown(() => tester.binding.setSurfaceSize(null));
        final c = ComposerPromptEditingController();
        final focus = FocusNode();
        addTearDown(c.dispose);
        addTearDown(focus.dispose);
        await mount(tester, c, focus, _Rpc(), dark: dark, scale: 2);
        await tester.enterText(find.byType(TextField), '@');
        await tester.pump(const Duration(milliseconds: 150));
        await tester.pumpAndSettle();
        expect(find.text('浏览器'), findsOneWidget);
        await tester.tap(find.text('SSH 书签'));
        await tester.pump(const Duration(milliseconds: 150));
        await tester.pumpAndSettle();
        expect(find.text('生产服务器'), findsOneWidget);
        await tester.tap(find.byTooltip('关闭'));
        await tester.pump();
        expect(
          find.byKey(const ValueKey('composer-reference-picker')),
          findsNothing,
        );
        expect(focus.hasFocus, isTrue);
        expect(tester.takeException(), isNull);
      },
    );
  }

  testWidgets('disconnected state stays explicit', (tester) async {
    final c = ComposerPromptEditingController();
    final focus = FocusNode();
    addTearDown(c.dispose);
    addTearDown(focus.dispose);
    await mount(tester, c, focus, null);
    await tester.enterText(find.byType(TextField), '@');
    await tester.pump(const Duration(milliseconds: 150));
    await tester.pump();
    expect(find.text('请先连接桌面端，再选择引用'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}
