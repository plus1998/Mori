import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:eco_mobile/core/models/codex_account_models.dart';
import 'package:eco_mobile/core/models/git_models.dart';
import 'package:eco_mobile/core/models/thread_models.dart';
import 'package:eco_mobile/core/models/thread_runtime_config.dart';
import 'package:eco_mobile/core/models/thread_usage_models.dart';
import 'package:eco_mobile/core/network/desktop_rpc.dart';
import 'package:eco_mobile/core/providers/app_providers.dart';
import 'package:eco_mobile/core/providers/desktop_bind_ready.dart';
import 'package:eco_mobile/core/theme/eco_theme.dart';
import 'package:eco_mobile/features/approvals/plan_approval_panel.dart';
import 'package:eco_mobile/features/composer/composer_controls.dart';
import 'package:eco_mobile/features/projects/project_providers.dart';
import 'package:eco_mobile/features/threads/conversation_action_sheets.dart';
import 'package:eco_mobile/features/threads/thread_info_sheets.dart';
import 'package:eco_mobile/features/threads/thread_menu_sheets.dart';
import 'package:eco_mobile/features/threads/thread_providers.dart';
import 'package:eco_mobile/features/threads/thread_session_route.dart';
import 'package:eco_mobile/features/todos/project_todos_screen.dart';
import 'package:eco_mobile/l10n/generated/app_localizations.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:integration_test/integration_test.dart';
import 'package:webview_flutter/webview_flutter.dart';

import '../test/mobile_parity_test.dart' as fixtures;
import '../test/project_todos_test.dart' as todos;

// Native UI coverage with isolated desktop responses. This intentionally does
// not use a user's desktop account, publish a public link, or invoke a model.
void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  Future<void> screenshot(String name) async {
    const directory = String.fromEnvironment('ECO_PARITY_SCREENSHOTS');
    if (directory.isEmpty) return;
    if (!directory.startsWith('/tmp/')) {
      throw ArgumentError('Screenshots must stay in /tmp.');
    }
    await binding.pump(const Duration(milliseconds: 250));
    await Directory(directory).create(recursive: true);
    await File(
      '$directory/$name.png',
    ).writeAsBytes(await binding.takeScreenshot(name));
  }

  testWidgets('context counting errors stay visible in the native sheet', (
    tester,
  ) async {
    for (final dark in [false, true]) {
      await tester.pumpWidget(
        _app(
          Builder(
            builder: (context) => TextButton(
              onPressed: () => showThreadContextSheet(
                context: context,
                contextSnapshot: ThreadContextSnapshot.fromJson({
                  'error': '无法读取模型的分词器，请检查桌面端配置',
                }),
                threadStatus: 'idle',
                showBilling: false,
              ),
              child: const Text('检查上下文'),
            ),
          ),
          dark: dark,
        ),
      );
      final media = MediaQuery.of(tester.element(find.text('检查上下文')));
      debugPrint(
        'NATIVE_PARITY_VIEW size=${media.size} '
        'scaled14=${media.textScaler.scale(14)} dark=$dark',
      );
      if (const bool.fromEnvironment('ECO_EXPECT_LARGE_TEXT')) {
        expect(media.textScaler.scale(14), greaterThan(14));
      }
      await tester.tap(find.text('检查上下文'));
      await tester.pumpAndSettle();
      expect(find.textContaining('无法读取模型的分词器'), findsOneWidget);
      expect(find.text('0%'), findsNothing);
      await screenshot('context-error-${dark ? 'dark' : 'light'}');
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
    }
  });

  testWidgets(
    'approval uses the real model picker and persists before execution',
    (tester) async {
      final rpc = _ModelRpc();
      var config = const ThreadRuntimeConfig(
        sessionMode: 'plan',
        bashReviewMode: 'always',
        subagentEnabled: {},
        orchestrationSelection: OrchestrationSelection(
          mainAgentConfigId: '',
          mainModel: OrchestrationModelRef(providerId: 'api', modelId: 'old'),
          mainPrompt: BuiltinMainAgentPromptSelection(),
          subagents: NoneSubagentSelection(),
        ),
      );
      String? approvedModel;
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            desktopRpcProvider.overrideWithValue(rpc),
            modelSettingsProvider.overrideWith(
              (ref) async => const ModelSettingsSnapshot(mainAgentConfigs: []),
            ),
            mcpSettingsProvider.overrideWith((ref) async => null),
            workflowSettingsProvider.overrideWith((ref) async => null),
            auxiliaryModelOptionsProvider('').overrideWith(
              (ref) async => const [
                CommitModelOptionView(
                  id: 'next',
                  candidateModelId: 'next',
                  providerId: 'api',
                  providerName: '测试 API',
                  modelId: 'new',
                  modelLabel: '新执行模型',
                  providerColor: '#22aa88',
                ),
              ],
            ),
            candidateModelsProvider('api').overrideWith((ref) async => []),
          ],
          child: _app(
            StatefulBuilder(
              builder: (context, setState) => Align(
                alignment: Alignment.bottomCenter,
                child: PlanApprovalPanel(
                  plan: const ThreadPendingPlan(
                    threadId: 'thread',
                    userPrompt: '验证移动端计划审批',
                    analysis: '',
                    plan: '## 执行计划\n\n1. 选择模型\n2. 保存后开始执行',
                    workspacePath: '/repo',
                    worktreePath: '/repo',
                  ),
                  busy: false,
                  modelControl: ComposerDirectMainModelControl(
                    runtimeConfig: config,
                    threadId: 'thread',
                    canEdit: true,
                    onChanged: (next) => setState(() => config = next),
                    workspacePath: '/repo',
                    coreKind: 'claude',
                  ),
                  onApprove: () async {
                    approvedModel = resolveThreadMainModel(config)?.modelId;
                  },
                  onDismiss: () async {},
                ),
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byType(ComposerDirectMainModelControl));
      await tester.pumpAndSettle();
      expect(find.text('新执行模型'), findsOneWidget);
      await screenshot('approval-model-picker');
      await tester.tap(find.text('新执行模型'));
      await tester.pumpAndSettle();
      expect(
        rpc.saved.single.orchestrationSelection?.mainModel?.modelId,
        'new',
      );
      expect(resolveThreadMainModel(config)?.modelId, 'new');
      // The picker stays open so thinking effort can be adjusted as well.
      await tester.tapAt(const Offset(20, 90));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('plan-approval-execute')));
      await tester.pumpAndSettle();
      expect(approvedModel, 'new');
      await screenshot('approval-new-model');
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'generated image history pages both images in the native viewer',
    (tester) async {
      final client = fixtures.Client();
      final png = await _drawPng();
      final indexes = <int>[];
      client.respond = (channel, args) {
        if (channel == 'image-generation-artifacts:list') {
          return [
            {
              'id': 'images',
              'threadId': 'thread',
              'prompt': '模拟器图片历史',
              'status': 'completed',
              'images': [
                for (final n in [0, 1])
                  {
                    'relativePath': '$n.png',
                    'mimeType': 'image/png',
                    'bytes': 68,
                  },
              ],
            },
          ];
        }
        if (channel == 'image-generation-artifact:read') {
          final n = (args.single as Map)['imageIndex'] as int;
          indexes.add(n);
          return {
            'dataBase64': base64Encode(png),
            'mimeType': 'image/png',
            'path': '/test/$n.png',
          };
        }
        throw StateError('Unexpected RPC $channel');
      };
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            desktopRpcProvider.overrideWithValue(DesktopRpc(client, 'test')),
          ],
          child: _app(
            Consumer(
              builder: (context, ref, _) => TextButton(
                onPressed: () => showImageGenerationArtifactsSheet(
                  context: context,
                  ref: ref,
                  threadId: 'thread',
                ),
                child: const Text('图片历史'),
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.text('图片历史'));
      await tester.pumpAndSettle();
      await screenshot('image-history');
      await tester.tap(find.text('模拟器图片历史'));
      await tester.pumpAndSettle();
      expect(find.text('1 / 2'), findsOneWidget);
      await tester.drag(find.byType(PageView), const Offset(-320, 0));
      await tester.pumpAndSettle();
      expect(find.text('2 / 2'), findsOneWidget);
      expect(indexes.toSet(), {0, 1});
      final copy = find.byKey(const ValueKey('image-copy-to-clipboard'));
      await _waitFor(
        tester,
        () => tester.widget<OutlinedButton>(copy).onPressed != null,
      );
      await tester.tap(copy);
      try {
        await _waitFor(tester, () => find.text('已复制').evaluate().isNotEmpty);
      } finally {
        await screenshot('generated-image-copy-result');
      }
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('share clipboard and HTML history load the native WebView', (
    tester,
  ) async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    addTearDown(() => server.close(force: true));
    server.listen((request) async {
      request.response.headers.contentType = ContentType.html;
      request.response.write(
        '<!doctype html><meta name="viewport" content="width=device-width">'
        '<title>本地模拟器验证</title><h1 id="verified">原生网页预览成功</h1>',
      );
      await request.response.close();
    });
    final url = 'http://127.0.0.1:${server.port}/snapshot';
    final client = fixtures.Client();
    client.respond = (channel, args) {
      if (channel == 'conversation:share') {
        return {'publicUrl': url, 'expiresAt': '2026-12-01T00:00:00Z'};
      }
      if (channel == 'html-host-artifacts:list') {
        return [
          {'id': 'page', 'title': 'HTML 产物验证', 'publicUrl': url},
        ];
      }
      throw StateError('Unexpected RPC $channel');
    };
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          desktopRpcProvider.overrideWithValue(DesktopRpc(client, 'test')),
        ],
        child: _app(
          Consumer(
            builder: (context, ref, _) => Column(
              children: [
                TextButton(
                  onPressed: () => showConversationShare(context, 'thread'),
                  child: const Text('分享验证'),
                ),
                TextButton(
                  onPressed: () => showHtmlHostArtifactsSheet(
                    context: context,
                    ref: ref,
                    threadId: 'thread',
                  ),
                  child: const Text('HTML 历史'),
                ),
              ],
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('分享验证'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('生成分享链接'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('复制链接'));
    await tester.pumpAndSettle();
    expect((await Clipboard.getData(Clipboard.kTextPlain))?.text, url);
    await screenshot('share-link');
    await tester.tap(find.text('预览分享'));
    await _expectWebContent(tester);
    await screenshot('share-native-webview');
    await tester.tap(find.byType(BackButton));
    await tester.pumpAndSettle();
    await tester.tap(find.byType(BackButton));
    await tester.pumpAndSettle();
    await tester.tap(find.text('HTML 历史'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('HTML 产物验证'));
    await _expectWebContent(tester);
    await screenshot('html-native-webview');
    expect(tester.takeException(), isNull);
  });

  testWidgets('todo handoff opens the original message and saved draft', (
    tester,
  ) async {
    final client = _TodoClient();
    client.items
      ..clear()
      ..add({
        ...todos.row('history', '检查转入记录'),
        'composedAt': '2026-11-11T00:00:00Z',
        'handoffs': [
          {
            'contextKey': 'thread:sent',
            'threadId': 'sent',
            'messageId': 'original',
            'composedAt': '2026-11-11T00:00:00Z',
          },
          {'contextKey': 'thread:draft', 'composedAt': '2026-11-10T00:00:00Z'},
        ],
      });
    String? openedThread, originalMessage, prompt;
    final router = GoRouter(
      routes: [
        GoRoute(path: '/', builder: (_, _) => const ProjectTodosScreen()),
        GoRoute(
          path: '/threads/:id',
          builder: (_, state) {
            openedThread = state.pathParameters['id'];
            originalMessage = state.uri.queryParameters['messageId'];
            prompt = (state.extra as ThreadSessionRouteExtra?)?.prompt;
            return const Scaffold(body: Text('目标会话'));
          },
        ),
      ],
    );
    addTearDown(router.dispose);
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          desktopRpcProvider.overrideWithValue(DesktopRpc(client, 'test')),
          desktopBindReadyOverrideProvider.overrideWithValue(true),
          selectedDesktopIdProvider.overrideWith((ref) => 'test'),
          ecoEventsProvider.overrideWith((ref) => const Stream.empty()),
          connectionStatusProvider.overrideWith((ref) => const Stream.empty()),
          threadListProvider.overrideWith(todos.TodoThreads.new),
          selectedProjectPathProvider.overrideWith(todos.SelectedProject.new),
          projectListProvider.overrideWithValue(const AsyncData([])),
        ],
        child: MaterialApp.router(
          debugShowCheckedModeBanner: false,
          routerConfig: router,
          theme: buildEcoLightTheme(),
          locale: const Locale('zh'),
          localizationsDelegates: AppLocalizations.localizationsDelegates,
          supportedLocales: AppLocalizations.supportedLocales,
        ),
      ),
    );
    await tester.pumpAndSettle();
    final historyButton = find.widgetWithText(TextButton, '转入记录');
    await tester.ensureVisible(historyButton);
    await tester.tap(historyButton);
    await tester.pumpAndSettle();
    await screenshot('todo-handoff-history');
    await tester.tap(find.text('打开会话'));
    await tester.pumpAndSettle();
    expect(find.text('目标会话'), findsOneWidget);
    expect(openedThread, 'sent');
    expect(originalMessage, 'original');
    router.pop();
    await tester.pumpAndSettle();
    await tester.tap(historyButton);
    await tester.pumpAndSettle();
    await tester.tap(find.text('打开草稿'));
    await tester.pumpAndSettle();
    expect(openedThread, 'draft');
    expect(prompt, '保留的待办草稿');
    expect(tester.takeException(), isNull);
  });
}

Widget _app(Widget child, {bool dark = false}) => MaterialApp(
  key: ValueKey(dark),
  debugShowCheckedModeBanner: false,
  theme: dark ? buildEcoDarkTheme() : buildEcoLightTheme(),
  locale: const Locale('zh'),
  localizationsDelegates: AppLocalizations.localizationsDelegates,
  supportedLocales: AppLocalizations.supportedLocales,
  home: Scaffold(body: SafeArea(child: child)),
);

Future<void> _expectWebContent(WidgetTester tester) async {
  for (var i = 0; i < 100; i++) {
    await tester.pump(const Duration(milliseconds: 100));
    final views = find.byType(WebViewWidget);
    if (views.evaluate().isNotEmpty) {
      final controller = tester
          .widget<WebViewWidget>(views)
          .platform
          .params
          .controller;
      final content = await controller.runJavaScriptReturningResult(
        'document.readyState === "complete" && document.body.innerText.includes("原生网页预览成功")',
      );
      if (content == true || content == 'true') {
        await tester.pump(const Duration(seconds: 1));
        return;
      }
    }
  }
  fail('Native WebView did not load the local HTML fixture');
}

class _ModelRpc extends DesktopRpc {
  _ModelRpc() : super(fixtures.Client(), 'test');
  final saved = <ThreadRuntimeConfig>[];
  @override
  Future<List<CodexAccount>> listCodexAccounts() async => [];
  @override
  Future<List<Map<String, dynamic>>> listChatGptOauthAccounts() async => [];
  @override
  Future<List<Map<String, dynamic>>> listCodexAccountModels() async => [];
  @override
  Future<ThreadSummary> updateRuntimeConfig({
    required String threadId,
    required ThreadRuntimeConfigInput runtimeConfig,
  }) async {
    saved.add(runtimeConfig);
    return ThreadSummary.fromJson({
      ..._thread(threadId),
      'runtimeConfig': runtimeConfig.toJson(),
    });
  }
}

class _TodoClient extends todos.TodoClient {
  @override
  Future<T> invoke<T>(
    String desktopDeviceId,
    String channel,
    List<dynamic> args, {
    int? deadlineMs,
  }) async {
    if (channel == 'thread:get') return _thread(args.single as String) as T;
    if (channel == 'composer-draft:get') {
      return {
            'contextKey': args.single,
            'prompt': '保留的待办草稿',
            'revision': 'revision',
            'updatedAt': '2026-11-11T00:00:00Z',
            'attachments': [],
          }
          as T;
    }
    return super.invoke<T>(
      desktopDeviceId,
      channel,
      args,
      deadlineMs: deadlineMs,
    );
  }
}

Map<String, dynamic> _thread(String id) => {
  'id': id,
  'title': '模拟器验证会话',
  'prompt': '',
  'workspacePath': '/a',
  'status': 'idle',
  'message': '',
  'createdAt': '',
  'updatedAt': '',
};

Future<void> _waitFor(WidgetTester tester, bool Function() ready) async {
  for (var i = 0; i < 100; i++) {
    await tester.pump(const Duration(milliseconds: 100));
    if (ready()) return;
  }
  fail(
    'Native operation did not complete. Visible labels: '
    '${tester.widgetList<Text>(find.byType(Text)).map((text) => text.data ?? text.textSpan?.toPlainText()).join(" | ")}',
  );
}

Future<Uint8List> _drawPng() async {
  final recorder = ui.PictureRecorder();
  final canvas = Canvas(recorder);
  canvas.drawRect(
    const Rect.fromLTWH(0, 0, 64, 64),
    Paint()..color = Colors.teal,
  );
  final picture = recorder.endRecording();
  final image = await picture.toImage(64, 64);
  final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
  image.dispose();
  picture.dispose();
  return bytes!.buffer.asUint8List();
}
