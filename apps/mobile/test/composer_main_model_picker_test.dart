import 'package:eco_mobile/core/models/codex_account_models.dart';
import 'package:eco_mobile/core/models/git_models.dart';
import 'package:eco_mobile/features/composer/composer_controls.dart';
import 'package:eco_mobile/features/composer/commit_push_sheet.dart';
import 'package:eco_mobile/core/models/thread_models.dart';
import 'package:eco_mobile/core/network/desktop_rpc.dart';
import 'package:eco_mobile/core/network/eco_center_client.dart';
import 'package:eco_mobile/core/storage/credential_store.dart';
import 'package:eco_mobile/features/composer/composer_main_model_picker.dart';
import 'package:eco_mobile/features/threads/thread_providers.dart';
import 'package:eco_mobile/l10n/generated/app_localizations.dart';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

class _AccountsRpc extends DesktopRpc {
  _AccountsRpc({
    this.catalogFailure,
    this.includeQuota = false,
    this.oauthFailure,
  }) : super(EcoCenterClient(store: CredentialStore()), 'desktop');
  final String? catalogFailure;
  final String? oauthFailure;
  AuxiliaryModelSelection? generatedWith;
  @override
  Future<GitListCommitModelOptionsResult> listCommitModelOptions({
    String? mainAgentConfigId,
  }) async => const GitListCommitModelOptionsResult(
    options: [],
    savedCandidateModelId: 'auto',
  );
  @override
  Future<GitGenerateCommitMessageResult> generateCommitMessage({
    required String workspacePath,
    String? mainAgentConfigId,
    bool includeUnstaged = true,
    String? candidateModelId,
    AuxiliaryModelSelection? modelSelection,
  }) async {
    generatedWith = modelSelection;
    return const GitGenerateCommitMessageResult(
      message: 'Fix OAuth accounts',
      candidateModelId: 'account:eco-coding-chatgpt:gpt-test',
      modelId: 'gpt-test',
      providerName: 'ChatGPT OAuth',
    );
  }

  var loginCalls = 0;
  var workflow = const WorkflowSettingsSnapshot(sessionMode: 'agent');
  final savedWorkflows = <WorkflowSettingsSnapshot>[];

  @override
  Future<WorkflowSettingsSnapshot> saveWorkflowSettings(
    WorkflowSettingsSnapshot settings,
  ) async {
    savedWorkflows.add(settings);
    workflow = settings;
    return settings;
  }

  final bool includeQuota;
  final oauthRequests = <String>[];
  @override
  Future<List<CodexAccount>> listCodexAccounts() async {
    loginCalls++;
    return [
      for (final id in ['A', 'B'])
        CodexAccount(
          id: id,
          name: 'Login $id',
          email: '',
          isLoggedIn: true,
          authState: 'configured',
          quota: includeQuota
              ? CodexAccountQuota(
                  planType: 'pro',
                  email: '',
                  allowed: true,
                  limitReached: false,
                  windows: [
                    CodexQuotaWindow(
                      usedPercent: id == 'A' ? 25 : 60,
                      seconds: 5 * 60 * 60,
                      resetAfterSeconds: 0,
                      resetAt:
                          DateTime.utc(2030, 1, 2, 12).millisecondsSinceEpoch ~/
                          1000,
                    ),
                  ],
                  resetCreditsAvailable: 0,
                  fetchedAt: DateTime.utc(2030, 1, 1).millisecondsSinceEpoch,
                )
              : null,
        ),
    ];
  }

  @override
  Future<List<Map<String, dynamic>>> listChatGptOauthAccounts() async => [
    for (final id in ['A', 'B'])
      {
        'accountId': 'oauth-$id',
        'displayName': 'OAuth $id',
        'enabled': true,
        'hasCredentials': true,
      },
  ];
  @override
  Future<List<Map<String, dynamic>>> listCodexAccountModels() async {
    loginCalls++;
    if (catalogFailure case final failure?) throw StateError(failure);
    return [
      {
        'modelId': 'gpt-test',
        'displayName': 'GPT Test',
        'supportsFast': true,
        'reasoningEfforts': ['low', 'medium', 'high'],
      },
    ];
  }

  @override
  Future<List<Map<String, dynamic>>> listChatGptOauthAccountModels(
    String accountId,
  ) async {
    oauthRequests.add(accountId);
    if (oauthFailure case final failure?) throw StateError(failure);
    return [
      {'id': 'gpt-test', 'displayName': 'GPT Test'},
    ];
  }
}

Future<void> _chooseAccount(WidgetTester tester, String accountName) async {
  await tester.tap(find.text('Select an account first').first);
  await tester.pumpAndSettle();
  await tester.tap(find.text(accountName));
  await tester.pumpAndSettle();
}

Future<void> _open(
  WidgetTester tester,
  _AccountsRpc rpc,
  List<OrchestrationModelRef> changes, {
  Size size = const Size(375, 812),
  double textScale = 1,
  OrchestrationModelRef? selected,
}) async {
  tester.view.physicalSize = size;
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        desktopRpcProvider.overrideWithValue(rpc),
        auxiliaryModelOptionsProvider('').overrideWith((ref) async => []),
      ],
      child: MaterialApp(
        locale: const Locale('en'),
        supportedLocales: AppLocalizations.supportedLocales,
        localizationsDelegates: const [
          AppLocalizations.delegate,
          GlobalMaterialLocalizations.delegate,
          GlobalWidgetsLocalizations.delegate,
          GlobalCupertinoLocalizations.delegate,
        ],
        builder: (context, child) => MediaQuery(
          data: MediaQuery.of(
            context,
          ).copyWith(textScaler: TextScaler.linear(textScale)),
          child: child!,
        ),
        home: Scaffold(
          body: Builder(
            builder: (context) => TextButton(
              onPressed: () => showComposerMainModelPickerSheet(
                context,
                selectedModel: selected,
                coreKind: 'codex',
                onSelected: changes.add,
              ),
              child: const Text('Open'),
            ),
          ),
        ),
      ),
    ),
  );
  await tester.tap(find.text('Open'));
  await tester.pumpAndSettle();
}

const _apiOption = CommitModelOptionView(
  id: 'api-model',
  candidateModelId: 'api-model',
  providerId: 'custom',
  providerName: 'Custom API',
  modelId: 'api-model',
  modelLabel: 'API Model',
  providerColor: '',
);

Future<void> _openStateless(
  WidgetTester tester,
  _AccountsRpc rpc,
  List<ThreadRuntimeConfigInput> changes, {
  required String section,
  bool enabled = true,
  ThreadRuntimeConfigInput? initial,
  Size size = const Size(375, 812),
  double textScale = 1,
}) async {
  tester.view.physicalSize = size;
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
  var runtime =
      initial ??
      const ThreadRuntimeConfig(
        subagentEnabled: {},
        sessionMode: 'agent',
        bashReviewMode: 'always',
      );
  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        desktopRpcProvider.overrideWithValue(rpc),
        workflowSettingsProvider.overrideWith((ref) async => rpc.workflow),
        auxiliaryModelOptionsProvider(
          '',
        ).overrideWith((ref) async => [_apiOption]),
        approvalModelOptionsProvider(
          '',
        ).overrideWith((ref) async => [_apiOption]),
      ],
      child: MaterialApp(
        locale: const Locale('en'),
        supportedLocales: AppLocalizations.supportedLocales,
        localizationsDelegates: const [
          AppLocalizations.delegate,
          GlobalMaterialLocalizations.delegate,
          GlobalWidgetsLocalizations.delegate,
          GlobalCupertinoLocalizations.delegate,
        ],
        builder: (context, child) => MediaQuery(
          data: MediaQuery.of(
            context,
          ).copyWith(textScaler: TextScaler.linear(textScale)),
          child: child!,
        ),
        home: Scaffold(
          body: SingleChildScrollView(
            child: StatefulBuilder(
              builder: (context, setState) {
                void changed(ThreadRuntimeConfigInput next) {
                  changes.add(next);
                  setState(() => runtime = next);
                }

                return switch (section) {
                  'auxiliary' => ComposerAuxiliaryModelSection(
                    runtimeConfig: runtime,
                    threadId: '',
                    canEdit: enabled,
                    onChanged: changed,
                    mainAgentConfigId: '',
                    closeOnSelect: false,
                  ),
                  'approval' => ComposerApprovalModelSection(
                    runtimeConfig: runtime,
                    threadId: '',
                    canEdit: enabled,
                    onChanged: changed,
                    mainAgentConfigId: '',
                    closeOnSelect: false,
                  ),
                  _ => ComposerVisionModelSection(
                    runtimeConfig: runtime,
                    threadId: '',
                    canEdit: enabled,
                    onChanged: changed,
                    mainAgentConfigId: '',
                    closeOnSelect: false,
                  ),
                };
              },
            ),
          ),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

void main() {
  testWidgets(
    'Git picker works without cached models and generates with the chosen OAuth account',
    (tester) async {
      final rpc = _AccountsRpc();
      final controller = ScrollController();
      addTearDown(controller.dispose);
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            desktopRpcProvider.overrideWithValue(rpc),
            workflowSettingsProvider.overrideWith((ref) async => rpc.workflow),
            auxiliaryModelOptionsProvider('').overrideWith((ref) async => []),
          ],
          child: MaterialApp(
            locale: const Locale('en'),
            supportedLocales: AppLocalizations.supportedLocales,
            localizationsDelegates: const [
              AppLocalizations.delegate,
              GlobalMaterialLocalizations.delegate,
              GlobalWidgetsLocalizations.delegate,
              GlobalCupertinoLocalizations.delegate,
            ],
            home: Scaffold(
              body: CommitPushSheet(
                workspacePath: '/workspace',
                diff: WorkspaceDiffResult.fromJson({'fileCount': 1}),
                gitStatus: GitWorkingTreeStatus.fromJson({
                  'isGitRepository': true,
                  'canCommit': true,
                }),
                scrollController: controller,
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.text('No model configured'));
      await tester.pumpAndSettle();
      await _chooseAccount(tester, 'OAuth B');
      await tester.tap(find.text('GPT Test'));
      await tester.pumpAndSettle();
      expect(
        rpc.savedWorkflows.last.defaultAuxiliaryModel?.accountId,
        'oauth-B',
      );
      await tester.tap(find.byTooltip('Generate commit message with AI'));
      await tester.pumpAndSettle();
      expect(rpc.generatedWith?.accountId, 'oauth-B');
      expect(
        rpc.generatedWith?.candidateModelId,
        'account:eco-coding-chatgpt:gpt-test',
      );
      expect(find.text('Fix OAuth accounts'), findsOneWidget);
      expect(tester.takeException(), isNull);
    },
  );

  for (final section in ['auxiliary', 'approval', 'vision']) {
    testWidgets(
      '$section OAuth selection persists the account, switches accounts and clears',
      (tester) async {
        final rpc = _AccountsRpc();
        final changes = <ThreadRuntimeConfigInput>[];
        await _openStateless(tester, rpc, changes, section: section);
        expect(find.text('ChatGPT Login'), findsNothing);
        expect(find.byType(Slider), findsNothing);
        expect(rpc.loginCalls, 0);
        await tester.tap(find.text('ChatGPT OAuth'));
        await tester.pumpAndSettle();
        expect(find.text('GPT Test'), findsNothing);
        await _chooseAccount(tester, 'OAuth B');
        expect(rpc.oauthRequests, ['oauth-B']);
        await tester.tap(find.text('GPT Test'));
        await tester.pumpAndSettle();
        final selected =
            changes.last.toJson()[section == 'auxiliary'
                ? 'auxiliaryModel'
                : section == 'approval'
                ? 'approvalModel'
                : 'visionModel'];
        expect(selected, {
          'providerId': 'eco-coding-chatgpt',
          'modelId': 'gpt-test',
          'candidateModelId': 'account:eco-coding-chatgpt:gpt-test',
          'accountId': 'oauth-B',
        });
        final key =
            'default${section[0].toUpperCase()}${section.substring(1)}Model';
        expect(rpc.savedWorkflows.last.toJson()[key], selected);
        await tester.tap(find.text('OAuth B'));
        await tester.pumpAndSettle();
        await tester.tap(find.text('OAuth A'));
        await tester.pumpAndSettle();
        await tester.tap(find.text('GPT Test'));
        await tester.pumpAndSettle();
        expect(
          (changes.last.toJson()['${section}Model'] as Map)['accountId'],
          'oauth-A',
        );
        expect(rpc.oauthRequests, ['oauth-B', 'oauth-A']);
        await tester.tap(find.text('Not configured'));
        await tester.pumpAndSettle();
        expect(changes.last.toJson().containsKey('${section}Model'), isFalse);
        expect(rpc.savedWorkflows.last.toJson().containsKey(key), isFalse);
        expect(tester.takeException(), isNull);
      },
    );
  }

  testWidgets(
    'stateless API selection needs no account and replaces OAuth identity',
    (tester) async {
      final rpc = _AccountsRpc();
      final changes = <ThreadRuntimeConfigInput>[];
      await _openStateless(
        tester,
        rpc,
        changes,
        section: 'auxiliary',
        initial: const ThreadRuntimeConfig(
          subagentEnabled: {},
          sessionMode: 'agent',
          bashReviewMode: 'always',
          auxiliaryModel: AuxiliaryModelSelection(
            providerId: 'eco-coding-chatgpt',
            modelId: 'gpt-test',
            candidateModelId: 'account:eco-coding-chatgpt:gpt-test',
            accountId: 'oauth-B',
          ),
        ),
      );
      expect(find.text('OAuth B'), findsOneWidget);
      await tester.tap(find.text('Custom API'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('API Model'));
      await tester.pumpAndSettle();
      expect(changes.single.auxiliaryModel?.candidateModelId, 'api-model');
      expect(changes.single.auxiliaryModel?.accountId, isNull);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'OAuth catalog errors stay visible and do not select a different model',
    (tester) async {
      final rpc = _AccountsRpc(oauthFailure: 'HTTP 503');
      final changes = <ThreadRuntimeConfigInput>[];
      await _openStateless(tester, rpc, changes, section: 'vision');
      await tester.tap(find.text('ChatGPT OAuth'));
      await tester.pumpAndSettle();
      await _chooseAccount(tester, 'OAuth A');
      expect(find.textContaining('HTTP 503'), findsOneWidget);
      expect(find.text('GPT Test'), findsNothing);
      expect(changes, isEmpty);
      expect(rpc.savedWorkflows, isEmpty);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'stateless picker remains usable on a small phone with larger text',
    (tester) async {
      final rpc = _AccountsRpc();
      await _openStateless(
        tester,
        rpc,
        [],
        section: 'approval',
        size: const Size(320, 640),
        textScale: 1.4,
      );
      await tester.tap(find.text('ChatGPT OAuth'));
      await tester.pumpAndSettle();
      await _chooseAccount(tester, 'OAuth B');
      expect(find.text('GPT Test'), findsOneWidget);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'Login requires an explicit account and saves the model with low effort immediately',
    (tester) async {
      final rpc = _AccountsRpc();
      final changes = <OrchestrationModelRef>[];
      await _open(tester, rpc, changes);
      expect(find.byType(Slider), findsOneWidget);
      expect(find.text('GPT Test'), findsNothing);
      expect(changes, isEmpty);
      await _chooseAccount(tester, 'Login B');
      expect(changes, isEmpty);
      await tester.tap(find.text('GPT Test'));
      await tester.pumpAndSettle();
      expect(changes.single.toJson(), containsPair('accountId', 'B'));
      expect(changes.single.thinkingEffort, 'low');
      expect(changes.single.serviceTier, 'default');
      await tester.tap(find.byType(Switch));
      await tester.pumpAndSettle();
      expect(changes.last.serviceTier, 'fast');
      expect(find.text('Done'), findsNothing);
      expect(find.byType(Slider), findsOneWidget);
      await tester.drag(find.byType(Slider), const Offset(260, 0));
      await tester.pumpAndSettle();
      expect(changes.last.accountId, 'B');
      expect(changes.last.thinkingEffort, 'high');
      expect(changes.last.serviceTier, 'fast');
      await tester.tap(find.byType(Switch));
      await tester.pumpAndSettle();
      expect(changes.last.serviceTier, 'default');
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('OAuth loads the chosen account catalog and saves its identity', (
    tester,
  ) async {
    final rpc = _AccountsRpc();
    final changes = <OrchestrationModelRef>[];
    await _open(tester, rpc, changes);
    await tester.tap(find.text('ChatGPT OAuth'));
    await tester.pumpAndSettle();
    expect(find.byType(Switch), findsNothing);
    expect(find.byType(Slider), findsOneWidget);
    expect(rpc.oauthRequests, isEmpty);
    await _chooseAccount(tester, 'OAuth B');
    expect(rpc.oauthRequests, ['oauth-B']);
    await tester.tap(find.text('GPT Test'));
    await tester.pumpAndSettle();
    expect(changes.single.providerId, 'eco-coding-chatgpt');
    expect(changes.single.serviceTier, isNull);
    expect(changes.single.accountId, 'oauth-B');
    expect(changes.single.thinkingEffort, 'low');
    expect(tester.takeException(), isNull);
  });

  testWidgets('account selection shows quota and the next reset time', (
    tester,
  ) async {
    final rpc = _AccountsRpc(includeQuota: true);
    await _open(tester, rpc, []);
    await _chooseAccount(tester, 'Login A');

    expect(find.textContaining('75%'), findsOneWidget);
    expect(find.textContaining('↻'), findsOneWidget);

    await tester.tap(find.text('Login A'));
    await tester.pumpAndSettle();
    expect(find.textContaining('75%'), findsAtLeastNWidgets(2));
    expect(find.textContaining('↻'), findsAtLeastNWidgets(2));
    expect(tester.takeException(), isNull);
  });

  testWidgets('search clear button resets the query and restores models', (
    tester,
  ) async {
    final rpc = _AccountsRpc();
    await _open(tester, rpc, []);
    await _chooseAccount(tester, 'Login A');
    expect(find.text('GPT Test'), findsOneWidget);

    await tester.enterText(find.byType(TextField), 'no matching model');
    await tester.pumpAndSettle();
    expect(find.text('GPT Test'), findsNothing);
    await tester.tap(find.byTooltip('Clear text'));
    await tester.pumpAndSettle();

    expect(
      tester.widget<TextField>(find.byType(TextField)).controller!.text,
      '',
    );
    expect(find.text('GPT Test'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets(
    'narrow screen, larger text and keyboard keep the effort slider visible',
    (tester) async {
      final rpc = _AccountsRpc();
      await _open(tester, rpc, [], size: const Size(320, 640), textScale: 1.4);
      tester.view.viewInsets = const FakeViewPadding(bottom: 220);
      addTearDown(tester.view.resetViewInsets);
      await tester.tap(find.byType(TextField));
      await tester.pumpAndSettle();
      expect(find.byType(Slider), findsOneWidget);
      expect(
        tester.getBottomRight(find.byType(Slider)).dy,
        lessThanOrEqualTo(420),
      );
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('catalog errors stay visible and never show a fallback model', (
    tester,
  ) async {
    final rpc = _AccountsRpc(catalogFailure: 'catalog unavailable');
    await _open(tester, rpc, []);
    expect(find.textContaining('catalog unavailable'), findsOneWidget);
    expect(find.text('GPT Test'), findsNothing);
    expect(tester.takeException(), isNull);
  });
}
