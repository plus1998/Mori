import 'package:eco_mobile/core/models/acp_host_ui_features.dart';
import 'package:eco_mobile/core/models/acp_models.dart';
import 'package:eco_mobile/core/models/git_models.dart';
import 'package:eco_mobile/core/models/thread_models.dart';
import 'package:eco_mobile/core/models/thread_usage_models.dart';
import 'package:eco_mobile/core/models/integration_models.dart';
import 'package:eco_mobile/core/theme/eco_icons.dart';
import 'package:eco_mobile/core/widgets/eco_action_sheet.dart';
import 'package:eco_mobile/core/widgets/eco_model_cascade.dart';
import 'package:eco_mobile/features/composer/composer_context_ring.dart';
import 'package:eco_mobile/features/composer/composer_controls.dart';
import 'package:eco_mobile/features/composer/composer_toolbar_icon.dart';
import 'package:eco_mobile/features/composer/session_composer.dart';
import 'package:eco_mobile/features/threads/thread_providers.dart';
import 'package:eco_mobile/l10n/generated/app_localizations.dart';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('composer core options include the Cursor ACP runtime', () {
    final acp = composerCoreKindOptions.where(
      (option) => option.value == 'acp',
    );

    expect(acp, hasLength(1));
    expect(acp.single.label, 'Cursor');
    expect(acp.single.badge, 'ACP');
  });

  const runtimeConfig = ThreadRuntimeConfig(
    subagentEnabled: {},
    sessionMode: 'agent',
    bashReviewMode: 'always',
    mainAgentModelOverride: MainAgentModelOverride(
      providerId: 'anthropic',
      modelId: 'anthropic/claude-sonnet-4',
    ),
  );
  const billing = ThreadBillingSnapshot(
    plannerTokenCostUsd: 0.2,
    ecoCostUsd: 0.1,
    savedUsd: 0,
    savedPct: 0,
    pricingResolved: true,
    plannerModelLabel: 'gpt-5.5 · OpenAI',
    inputTokens: 100,
    cacheReadTokens: 300,
    cacheCreationTokens: 100,
  );
  const modelProvider = ModelProviderView(
    id: 'provider-1',
    name: 'OpenAI',
    defaultModel: 'gpt-5.6-sol',
    enabled: true,
  );
  const templateModel = OrchestrationModelRef(
    providerId: 'provider-1',
    modelId: 'gpt-5.6-sol',
    thinkingEffort: 'high',
    candidateModelId: 'candidate-sol',
  );
  const altTemplateModel = OrchestrationModelRef(
    providerId: 'provider-1',
    modelId: 'gpt-5.6-fast',
    thinkingEffort: 'medium',
    candidateModelId: 'candidate-fast',
  );
  const resolvedSnapshot = ResolvedOrchestrationSnapshot(
    selection: OrchestrationSelection(
      mainAgentConfigId: 'main-1',
      mainPrompt: BuiltinMainAgentPromptSelection(),
      subagents: NoneSubagentSelection(),
    ),
    mainAgentConfigName: 'Coding',
    mainPromptDisplayName: 'Built in',
    mainAgent: MainAgentConfig(
      agentKey: 'main',
      name: 'Coding',
      systemPromptPreset: 'core_native',
      prompt: '',
      modelRef: templateModel,
      tools: ToolPolicy(),
    ),
    agents: [],
    strategy: OrchestrationStrategy(kind: 'autonomous'),
    resolvedAt: '2026-08-01T00:00:00.000Z',
  );
  const modelRuntimeConfig = ThreadRuntimeConfig(
    resolvedOrchestrationSnapshot: resolvedSnapshot,
    orchestrationSelection: OrchestrationSelection(
      mainAgentConfigId: 'main-1',
      mainPrompt: BuiltinMainAgentPromptSelection(),
      subagents: NoneSubagentSelection(),
    ),
    subagentEnabled: {},
    sessionMode: 'agent',
    bashReviewMode: 'always',
  );
  const modelSettings = ModelSettingsSnapshot(
    mainAgentConfigs: [
      MainAgentConfigResource(
        id: 'main-1',
        name: 'Coding',
        agentKey: 'main',
        modelRef: templateModel,
        tools: ToolPolicy(),
      ),
      MainAgentConfigResource(
        id: 'main-2',
        name: 'Research',
        agentKey: 'main',
        modelRef: altTemplateModel,
        tools: ToolPolicy(),
      ),
    ],
    mainAgentPrompts: [
      MainAgentPromptResource(
        id: 'prompt-1',
        name: 'Strict style',
        mode: 'custom_append',
        prompt: 'Be concise.',
      ),
    ],
    subagentOrchestrations: [
      SubagentOrchestrationResource(
        id: 'orch-1',
        name: 'Coding Subagents',
        agents: [
          AgentInstanceConfig(
            agentKey: 'coder',
            templateId: 'builtin.coding.coder',
            enabled: true,
            modelRef: templateModel,
            tools: ToolPolicy(),
          ),
        ],
        strategy: OrchestrationStrategy(kind: 'autonomous'),
      ),
    ],
    providers: [modelProvider],
  );
  const candidates = [
    CandidateModelView(
      id: 'candidate-sol',
      providerId: 'provider-1',
      modelId: 'gpt-5.6-sol',
      displayName: 'Solution',
      resolvedSupportsReasoning: true,
    ),
    CandidateModelView(
      id: 'candidate-fast',
      providerId: 'provider-1',
      modelId: 'gpt-5.6-fast',
      displayName: 'Fast',
      resolvedSupportsReasoning: true,
    ),
  ];

  testWidgets('composer shows billing beside usage controls and opens sheet', (
    tester,
  ) async {
    await tester.pumpWidget(
      _TestApp(
        child: ComposerRouteSummary(
          runtimeConfig: runtimeConfig,
          threadId: 'thread-1',
          canEdit: true,
          onChanged: (_) {},
          billing: billing,
          threadStatus: 'idle',
          contextSnapshot: const ThreadContextSnapshot(
            occupied: 20,
            limit: 100,
            occupancyPct: 20,
            limitsResolved: true,
          ),
        ),
      ),
    );
    await tester.pump();

    expect(find.byType(ComposerContextRing), findsOneWidget);

    await tester.tap(find.byType(ComposerContextRing));
    await tester.pumpAndSettle();

    expect(find.text('Context'), findsWidgets);
    expect(find.text('Billing'), findsWidgets);

    await tester.tap(find.text('Billing').last);
    await tester.pumpAndSettle();

    expect(find.text(r'$0.100'), findsOneWidget);
    expect(find.text('COST COMPARISON'), findsNothing);
    expect(find.text('Estimated at claude-sonnet-4 rates'), findsNothing);
    expect(find.text('gpt-5.5'), findsNothing);
    expect(find.text('Savings'), findsNothing);
    expect(find.text('Cache hit rate'), findsOneWidget);
    expect(find.text('60%'), findsOneWidget);
  });

  testWidgets('composer shows cost comparison only when savings are positive', (
    tester,
  ) async {
    const savedBilling = ThreadBillingSnapshot(
      plannerTokenCostUsd: 0.2,
      ecoCostUsd: 0.1,
      savedUsd: 0.1,
      savedPct: 50,
      pricingResolved: true,
      plannerModelLabel: 'gpt-5.5 · OpenAI',
    );
    await tester.pumpWidget(
      _TestApp(
        child: ComposerRouteSummary(
          runtimeConfig: runtimeConfig,
          threadId: 'thread-1',
          canEdit: true,
          onChanged: (_) {},
          billing: savedBilling,
          threadStatus: 'idle',
          contextSnapshot: const ThreadContextSnapshot(
            occupied: 20,
            limit: 100,
            occupancyPct: 20,
            limitsResolved: true,
          ),
        ),
      ),
    );
    await tester.pump();
    await tester.tap(find.byType(ComposerContextRing));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Billing').last);
    await tester.pumpAndSettle();

    expect(find.text('COST COMPARISON'), findsOneWidget);
    expect(find.text('Estimated at claude-sonnet-4 rates'), findsOneWidget);
    expect(find.text('Savings'), findsOneWidget);
  });

  testWidgets('composer hides context controls without a context snapshot', (
    tester,
  ) async {
    await tester.pumpWidget(
      _TestApp(
        child: ComposerRouteSummary(
          runtimeConfig: runtimeConfig,
          threadId: 'thread-1',
          canEdit: true,
          onChanged: (_) {},
          billing: billing,
        ),
      ),
    );
    await tester.pump();

    expect(find.byType(ComposerContextRing), findsNothing);
  });

  testWidgets(
    'composer hides context ring when host UI features hide both columns',
    (tester) async {
      await tester.pumpWidget(
        _TestApp(
          child: ComposerRouteSummary(
            runtimeConfig: runtimeConfig,
            threadId: 'thread-1',
            canEdit: true,
            onChanged: (_) {},
            billing: billing,
            contextSnapshot: const ThreadContextSnapshot(
              occupied: 20,
              limit: 100,
              occupancyPct: 20,
              limitsResolved: true,
            ),
            hostUiFeatures: const AcpHostUiFeatures(
              contextUsage: 'hide',
              billing: 'hide',
            ),
          ),
        ),
      );
      await tester.pump();
      expect(find.byType(ComposerContextRing), findsNothing);
    },
  );

  testWidgets('composer toolbar no longer shows orchestration control', (
    tester,
  ) async {
    await tester.pumpWidget(
      _TestApp(
        child: ComposerRouteSummary(
          runtimeConfig: runtimeConfig,
          threadId: 'thread-1',
          canEdit: false,
          onChanged: (_) {},
        ),
      ),
    );
    await tester.pump();

    expect(find.byIcon(EcoIcons.orchestration), findsNothing);
  });

  testWidgets(
    'composer model label sits left of context and switches model and effort',
    (tester) async {
      final changes = <ThreadRuntimeConfigInput>[];
      await tester.pumpWidget(
        _TestApp(
          modelSettings: modelSettings,
          candidates: candidates,
          child: ComposerRouteSummary(
            runtimeConfig: modelRuntimeConfig,
            threadId: 'thread-1',
            canEdit: true,
            contextSnapshot: const ThreadContextSnapshot(
              occupied: 20,
              limit: 100,
              occupancyPct: 20,
              limitsResolved: true,
            ),
            onChanged: changes.add,
          ),
        ),
      );
      await tester.pumpAndSettle();

      final modelLabel = find.text('5.6 Sol');
      final effortLabel = find.text('High');
      final contextRing = find.byType(ComposerContextRing);
      expect(modelLabel, findsOneWidget);
      expect(effortLabel, findsOneWidget);
      expect(find.byIcon(EcoIcons.expandDown), findsNothing);
      expect(
        tester.getCenter(modelLabel).dx,
        lessThan(tester.getCenter(effortLabel).dx),
      );
      expect(
        tester.getCenter(modelLabel).dy,
        closeTo(tester.getCenter(effortLabel).dy, 1),
      );
      expect(
        tester.getSize(find.byType(ComposerModelEffortControl)).height,
        kComposerToolbarHitSize,
      );
      expect(
        tester.getCenter(modelLabel).dx,
        lessThan(tester.getCenter(contextRing).dx),
      );

      await tester.tap(modelLabel);
      await tester.pumpAndSettle();
      expect(find.text('Profile'), findsOneWidget);
      expect(find.text('Model'), findsOneWidget);
      expect(find.text('Reasoning'), findsOneWidget);
      expect(find.text('Advanced'), findsOneWidget);
      // Toolbar + primary detail both show current effort.
      expect(find.text('High'), findsWidgets);
      // Primary only until a row is tapped — no submenu yet.
      expect(find.text('Fast'), findsNothing);
      // Advanced starts collapsed — extra items are hidden.
      expect(find.text('Prompt'), findsNothing);
      expect(find.text('Subagents'), findsNothing);
      expect(find.text('Agent'), findsNothing);
      expect(find.text('Aux'), findsNothing);
      expect(find.text('Vision'), findsNothing);
      // Profile remains visible at the top without expanding Advanced.
      expect(find.text('Coding'), findsWidgets);

      await tester.tap(find.text('Advanced'));
      await tester.pumpAndSettle();
      expect(find.text('Prompt'), findsOneWidget);
      expect(find.text('Subagents'), findsOneWidget);
      expect(find.text('Runtime'), findsOneWidget);
      expect(find.text('Aux'), findsOneWidget);
      expect(find.text('Vision'), findsOneWidget);
      expect(find.text('None'), findsWidgets);
      expect(find.text('No subagents'), findsOneWidget);
      // Expanding Advanced does not open a side submenu by itself.
      expect(find.text('Fast'), findsNothing);
      expect(find.text('Claude Code'), findsNothing);
      expect(
        tester.getTopLeft(find.text('Runtime')).dy,
        lessThan(tester.getTopLeft(find.text('Prompt')).dy),
      );
      expect(
        tester.getTopLeft(find.text('Prompt')).dy,
        lessThan(tester.getTopLeft(find.text('Subagents')).dy),
      );
      expect(
        tester.getTopLeft(find.text('Subagents')).dy,
        lessThan(tester.getTopLeft(find.text('Aux')).dy),
      );
      expect(
        tester.getTopLeft(find.text('Aux')).dy,
        lessThan(tester.getTopLeft(find.text('Vision')).dy),
      );

      await tester.tap(find.text('Aux'));
      await tester.pumpAndSettle();
      // Primary Aux/Vision values + submenu None option.
      expect(find.text('None'), findsWidgets);

      await tester.tap(find.text('Model'));
      await tester.pumpAndSettle();
      expect(find.text('Fast'), findsOneWidget);
      expect(find.text('5.6 Sol'), findsWidgets);

      await tester.tap(find.text('Reasoning'));
      await tester.pumpAndSettle();
      expect(find.text('Low'), findsOneWidget);
      await tester.tap(find.text('Low'));
      await tester.pumpAndSettle();
      expect(changes, hasLength(1));
      expect(changes.single.mainAgentModelOverride?.thinkingEffort, 'low');

      await tester.tap(find.text('Model'));
      await tester.pumpAndSettle();
      expect(find.text('Fast'), findsOneWidget);
      await tester.tap(find.text('Fast'));
      await tester.pumpAndSettle();
      expect(changes, hasLength(2));
      expect(changes.last.mainAgentModelOverride?.modelId, 'gpt-5.6-fast');
      expect(changes.last.mainAgentModelOverride?.thinkingEffort, 'low');
    },
  );

  testWidgets(
    'composer model menu switches main agent prompt and arrangement',
    (tester) async {
      final changes = <ThreadRuntimeConfigInput>[];
      await tester.pumpWidget(
        _TestApp(
          modelSettings: modelSettings,
          candidates: candidates,
          child: ComposerRouteSummary(
            runtimeConfig: modelRuntimeConfig,
            threadId: 'thread-1',
            canEdit: true,
            onChanged: changes.add,
          ),
        ),
      );
      await tester.pumpAndSettle();

      await tester.tap(find.text('5.6 Sol'));
      await tester.pumpAndSettle();

      await tester.tap(find.text('Profile'));
      await tester.pumpAndSettle();
      expect(find.text('Research'), findsOneWidget);
      await tester.tap(find.text('Research'));
      await tester.pumpAndSettle();
      expect(changes, isNotEmpty);
      expect(changes.last.orchestrationSelection?.mainAgentConfigId, 'main-2');
      expect(changes.last.mainAgentModelOverride, isNull);
      expect(
        changes.last.resolvedOrchestrationSnapshot?.mainAgentConfigName,
        'Research',
      );

      await tester.tap(find.text('Advanced'));
      await tester.pumpAndSettle();

      await tester.tap(find.text('Prompt'));
      await tester.pumpAndSettle();
      expect(find.text('Strict style'), findsOneWidget);
      await tester.tap(find.text('Strict style'));
      await tester.pumpAndSettle();
      final prompt = changes.last.orchestrationSelection?.mainPrompt;
      expect(prompt, isA<CustomAppendMainAgentPromptSelection>());
      expect(
        (prompt as CustomAppendMainAgentPromptSelection).promptId,
        'prompt-1',
      );

      await tester.tap(find.text('Subagents'));
      await tester.pumpAndSettle();
      expect(find.text('Coding Subagents'), findsOneWidget);
      await tester.tap(find.text('Coding Subagents'));
      await tester.pumpAndSettle();
      final subagents = changes.last.orchestrationSelection?.subagents;
      expect(subagents, isA<OrchestrationSubagentSelection>());
      expect(
        (subagents as OrchestrationSubagentSelection).orchestrationId,
        'orch-1',
      );
    },
  );

  testWidgets(
    'composer route category sheet shows locked skills mcp or subagents',
    (tester) async {
      await tester.pumpWidget(
        _TestApp(
          modelSettings: modelSettings,
          candidates: candidates,
          child: Builder(
            builder: (context) {
              return TextButton(
                onPressed: () {
                  showComposerRouteCategorySheet(
                    context: context,
                    runtimeConfig: modelRuntimeConfig,
                    threadId: 'thread-1',
                    canEdit: true,
                    onChanged: (_) {},
                    workspacePath: '',
                    category: ComposerRouteCategory.mcp,
                  );
                },
                child: const Text('Open MCP'),
              );
            },
          ),
        ),
      );
      await tester.pumpAndSettle();

      await tester.tap(find.text('Open MCP'));
      await tester.pumpAndSettle();

      expect(find.text('MCP'), findsWidgets);
      expect(find.text('Skills'), findsNothing);
      expect(find.text('Subagents'), findsNothing);
      expect(find.text('Orchestration'), findsNothing);
      expect(find.text('Profile'), findsNothing);
    },
  );

  testWidgets('composer integrations enforce availability and update runtime', (
    tester,
  ) async {
    final changes = <ThreadRuntimeConfigInput>[];
    await tester.pumpWidget(
      _TestApp(
        integrationAvailability: const IntegrationAvailabilitySnapshot(
          integrations: [
            IntegrationAvailabilityItem(
              id: 'browser',
              enabled: true,
              available: true,
            ),
            IntegrationAvailabilityItem(
              id: 'computerUse',
              enabled: false,
              available: true,
            ),
            IntegrationAvailabilityItem(
              id: 'imageGeneration',
              enabled: true,
              available: false,
              reason: 'API key missing',
            ),
          ],
        ),
        child: Builder(
          builder: (context) => TextButton(
            onPressed: () {
              showComposerRouteCategorySheet(
                context: context,
                runtimeConfig: modelRuntimeConfig,
                threadId: 'thread-1',
                canEdit: true,
                onChanged: changes.add,
                workspacePath: '',
                category: ComposerRouteCategory.integrations,
              );
            },
            child: const Text('Open integrations'),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.text('Open integrations'));
    await tester.pumpAndSettle();

    expect(find.text('Browser'), findsOneWidget);
    expect(find.text('Computer Use'), findsOneWidget);
    expect(find.text('Creative Drawing'), findsOneWidget);
    expect(find.text('Image creation'), findsNothing);
    final tiles = tester
        .widgetList<EcoSheetSwitchTile>(find.byType(EcoSheetSwitchTile))
        .toList();
    expect(tiles, hasLength(3));
    expect(tiles[0].enabled, isTrue);
    expect(tiles[1].enabled, isTrue);
    expect(tiles[2].enabled, isFalse);

    await tester.tap(
      find.descendant(
        of: find.byType(EcoSheetSwitchTile).first,
        matching: find.byType(Switch),
      ),
    );
    await tester.pumpAndSettle();
    expect(changes.single.integrationsEnabled, const {'browser': true});
  });

  testWidgets(
    'composer reports integration sync failures instead of an empty list',
    (tester) async {
      await tester.pumpWidget(
        _TestApp(
          integrationAvailabilityError: StateError('command not registered'),
          child: Builder(
            builder: (context) => TextButton(
              onPressed: () {
                showComposerRouteCategorySheet(
                  context: context,
                  runtimeConfig: modelRuntimeConfig,
                  threadId: 'thread-1',
                  canEdit: true,
                  onChanged: (_) {},
                  workspacePath: '',
                  category: ComposerRouteCategory.integrations,
                );
              },
              child: const Text('Open integrations'),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.text('Open integrations'));
      await tester.pumpAndSettle();

      expect(
        find.text('Failed to load integrations from Desktop'),
        findsOneWidget,
      );
      expect(find.text('Retry'), findsOneWidget);
      expect(
        find.text('No integrations are available from Desktop'),
        findsNothing,
      );
    },
  );

  testWidgets('session composer plus menu exposes modes and tools', (
    tester,
  ) async {
    final controller = TextEditingController();
    addTearDown(controller.dispose);
    var pickedImage = false;
    var runtimeConfig = modelRuntimeConfig;

    await tester.pumpWidget(
      _TestApp(
        modelSettings: modelSettings,
        candidates: candidates,
        child: StatefulBuilder(
          builder: (context, setState) {
            return SessionComposer(
              controller: controller,
              attachments: const [],
              runtimeConfig: runtimeConfig,
              threadId: 'thread-1',
              isRunning: false,
              hasActivity: true,
              onPickImage: () => pickedImage = true,
              onRemoveAttachment: (_) {},
              onSend: () {},
              onStop: () {},
              onRuntimeConfigChanged: (next) {
                setState(() => runtimeConfig = next);
              },
            );
          },
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.byIcon(EcoIcons.orchestration), findsNothing);
    expect(find.byIcon(EcoIcons.agentMode), findsNothing);

    await tester.tap(find.byIcon(EcoIcons.add));
    await tester.pumpAndSettle();

    expect(find.text('Plan'), findsOneWidget);
    expect(find.text('Ask'), findsOneWidget);
    expect(find.text('Image'), findsOneWidget);
    expect(find.text('Integrations'), findsOneWidget);
    expect(find.text('Skills'), findsOneWidget);
    expect(find.text('MCP Servers'), findsOneWidget);
    expect(find.text('Subagents'), findsOneWidget);

    await tester.tap(find.text('Plan'));
    await tester.pumpAndSettle();
    expect(runtimeConfig.sessionMode, 'plan');
    expect(find.byIcon(EcoIcons.planMode), findsOneWidget);
    expect(find.text('Plan'), findsNothing);
    expect(find.byIcon(EcoIcons.close), findsNothing);

    await tester.tap(find.byIcon(EcoIcons.planMode));
    await tester.pumpAndSettle();
    expect(runtimeConfig.sessionMode, 'agent');
    expect(find.byIcon(EcoIcons.agentMode), findsNothing);

    await tester.tap(find.byIcon(EcoIcons.add));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Image'));
    await tester.pumpAndSettle();
    expect(pickedImage, isTrue);
  });

  testWidgets(
    'session composer keeps model and context controls on narrow screens',
    (tester) async {
      tester.view.physicalSize = const Size(320, 700);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final controller = TextEditingController();
      addTearDown(controller.dispose);

      await tester.pumpWidget(
        _TestApp(
          modelSettings: modelSettings,
          candidates: candidates,
          child: SessionComposer(
            controller: controller,
            attachments: const [],
            runtimeConfig: modelRuntimeConfig,
            threadId: 'thread-1',
            isRunning: false,
            hasActivity: true,
            contextSnapshot: const ThreadContextSnapshot(
              occupied: 20,
              limit: 100,
              occupancyPct: 20,
              limitsResolved: true,
            ),
            onPickImage: () {},
            onRemoveAttachment: (_) {},
            onSend: () {},
            onStop: () {},
            onRuntimeConfigChanged: (_) {},
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(tester.takeException(), isNull);
      expect(find.text('5.6 Sol'), findsOneWidget);
      expect(find.byType(ComposerContextRing), findsOneWidget);
    },
  );

  testWidgets(
    'context sheet dual titles switch pages and show main agent card',
    (tester) async {
      await tester.pumpWidget(
        _TestApp(
          modelSettings: modelSettings,
          candidates: candidates,
          child: ComposerRouteSummary(
            runtimeConfig: modelRuntimeConfig,
            threadId: 'thread-1',
            canEdit: true,
            billing: billing,
            threadStatus: 'idle',
            contextSnapshot: const ThreadContextSnapshot(
              occupied: 42_000,
              limit: 200_000,
              occupancyPct: 21,
              limitsResolved: true,
              modelId: 'anthropic/claude-sonnet-4',
            ),
            onChanged: (_) {},
          ),
        ),
      );
      await tester.pumpAndSettle();

      await tester.tap(find.byType(ComposerContextRing));
      await tester.pumpAndSettle();

      expect(find.text('Context'), findsWidgets);
      expect(find.text('Billing'), findsWidgets);
      expect(find.text('Coding'), findsOneWidget);
      expect(find.text('claude-sonnet-4'), findsOneWidget);
      expect(find.text('21% used'), findsOneWidget);

      await tester.tap(find.text('Billing').last);
      await tester.pumpAndSettle();

      expect(find.text(r'$0.100'), findsOneWidget);
      expect(find.text('Cache hit rate'), findsOneWidget);
      expect(find.text('Coding'), findsNothing);
      expect(find.text('21% used'), findsNothing);
    },
  );

  group('model cascade panels fit their surface', () {
    const acpRuntimeConfig = ThreadRuntimeConfig(
      subagentEnabled: {},
      sessionMode: 'agent',
      bashReviewMode: 'always',
      cursorModelId: 'cursor-sonnet',
    );
    const cursorModels = [
      CursorModelOption(
        id: 'cursor-sonnet',
        displayName: 'Sonnet 4.5',
        current: true,
        isDefault: false,
      ),
      CursorModelOption(
        id: 'cursor-haiku',
        displayName: 'Haiku 4.5',
        current: false,
        isDefault: false,
      ),
    ];
    const auxOptions = [
      CommitModelOptionView(
        id: 'opt-1',
        candidateModelId: 'candidate-aux-1',
        providerId: 'provider-1',
        providerName: 'OpenAI',
        modelId: 'gpt-5.6-mini',
        modelLabel: '5.6 Mini',
        providerColor: '#10a37f',
      ),
      CommitModelOptionView(
        id: 'opt-2',
        candidateModelId: 'candidate-aux-2',
        providerId: 'provider-2',
        providerName: 'Anthropic',
        modelId: 'claude-haiku-4.5',
        modelLabel: 'Haiku 4.5',
        providerColor: '#d97757',
      ),
    ];

    /// The split catalogue's columns are the only vertical scrollables in an
    /// open cascade, so their geometry is what "fits the panel" means.
    List<Rect> bodyRects(WidgetTester tester) => [
      for (final element in find.byType(ListView).evaluate())
        tester.getRect(find.byWidget(element.widget)),
    ];

    Future<void> openSheet(
      WidgetTester tester, {
      required Size surface,
      String? coreKind,
      bool canEdit = true,
      bool canEditStatelessModels = true,
    }) async {
      // The overlay lays out from MediaQuery.size, which follows the view's
      // physical size / dpr — `setSurfaceSize` only moves the coordinate
      // transform and would leave it at the default 800x600.
      tester.view.devicePixelRatio = 1.0;
      tester.view.physicalSize = surface;
      addTearDown(tester.view.reset);
      await tester.pumpWidget(
        _TestApp(
          modelSettings: modelSettings,
          candidates: candidates,
          overrides: [
            cursorModelsProvider.overrideWith((ref) async => cursorModels),
            auxiliaryModelOptionsProvider(
              'main-1',
            ).overrideWith((ref) async => auxOptions),
          ],
          child: ComposerRouteSummary(
            runtimeConfig: coreKind == 'acp'
                ? acpRuntimeConfig
                : modelRuntimeConfig,
            threadId: 'thread-1',
            canEdit: canEdit,
            canEditStatelessModels: canEditStatelessModels,
            coreKind: coreKind,
            onChanged: (_) {},
          ),
        ),
      );
      await tester.pumpAndSettle();
      // The summary renders the model label in more than one control; the
      // composer toolbar label is the first.
      await tester.tap(
        find.text(coreKind == 'acp' ? 'Sonnet 4.5' : '5.6 Sol').first,
      );
      await tester.pumpAndSettle();
    }

    testWidgets('aux/vision cascade fits the default 800x600 surface', (
      tester,
    ) async {
      await openSheet(tester, surface: const Size(800, 600));
      await tester.tap(find.text('Advanced'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Aux'));
      await tester.pumpAndSettle();

      // This is the case that used to overflow by ~85px at 800x600: the panel is
      // capped at 48% of the viewport while the catalogue wanted a fixed 280.
      expect(tester.takeException(), isNull);
      expect(find.byType(EcoModelCascadeList), findsOneWidget);
      expect(find.byType(TextField), findsOneWidget);
      expect(find.text('None'), findsWidgets);
      final bodies = bodyRects(tester);
      expect(bodies, isNotEmpty);
      for (final body in bodies) {
        expect(body.height, lessThan(280));
        expect(body.bottom, lessThanOrEqualTo(600));
      }
    });

    testWidgets('cascades keep the full catalogue on a tall surface', (
      tester,
    ) async {
      const surface = Size(800, 900);
      await openSheet(tester, surface: surface);
      await tester.tap(find.text('Advanced'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Vision'));
      await tester.pumpAndSettle();

      expect(tester.takeException(), isNull);
      final bodies = bodyRects(tester);
      expect(bodies, isNotEmpty);
      for (final body in bodies) {
        // ~275 rather than 280: the panel prefers 380 and the search box + rows
        // take a little more than the 100px that leaves, so the body lands just
        // under its preference instead of being visibly squeezed.
        expect(body.height, greaterThan(270));
        expect(body.bottom, lessThanOrEqualTo(surface.height));
      }
    });

    testWidgets('cursor model cascade fits the default and a short surface', (
      tester,
    ) async {
      for (final surface in const [Size(800, 900), Size(800, 600)]) {
        await openSheet(tester, surface: surface, coreKind: 'acp');
        await tester.tap(find.text('Model'));
        await tester.pumpAndSettle();

        expect(tester.takeException(), isNull);
        expect(find.byType(EcoModelCascadeList), findsOneWidget);
        expect(find.text('Cursor default'), findsOneWidget);
        expect(find.byType(TextField), findsOneWidget);
        final bodies = bodyRects(tester);
        expect(bodies, isNotEmpty);
        for (final body in bodies) {
          // 380 preferred panel − chrome ≈ 275 on the tall surface, 189 at 600.
          expect(body.height, greaterThan(150));
          expect(body.bottom, lessThanOrEqualTo(surface.height));
        }
      }
    });

    testWidgets(
      'running sessions lock session rows but still switch aux / approval / vision',
      (tester) async {
        // Auxiliary / approval / vision requests are stateless single-shot calls, so
        // switching them mid-run is allowed; the session-bound rows stay locked.
        await openSheet(
          tester,
          surface: const Size(800, 900),
          coreKind: 'acp',
          canEdit: false,
          canEditStatelessModels: true,
        );

        // Locked: the Cursor model row cannot open its catalogue.
        await tester.tap(find.text('Model'));
        await tester.pumpAndSettle();
        expect(find.byType(EcoModelCascadeList), findsNothing);

        // Live: the auxiliary row still opens the catalogue.
        await tester.tap(find.text('Aux'));
        await tester.pumpAndSettle();
        expect(tester.takeException(), isNull);
        expect(find.byType(EcoModelCascadeList), findsOneWidget);
      },
    );
  });
}

class _TestApp extends StatelessWidget {
  const _TestApp({
    required this.child,
    this.modelSettings,
    this.candidates = const [],
    this.integrationAvailability,
    this.integrationAvailabilityError,
    this.overrides = const [],
  });

  final Widget child;
  final ModelSettingsSnapshot? modelSettings;
  final List<CandidateModelView> candidates;
  final IntegrationAvailabilitySnapshot? integrationAvailability;
  final Object? integrationAvailabilityError;
  final List<Override> overrides;

  @override
  Widget build(BuildContext context) {
    return ProviderScope(
      overrides: [
        modelSettingsProvider.overrideWith((ref) async => modelSettings),
        candidateModelsProvider(
          'provider-1',
        ).overrideWith((ref) async => candidates),
        integrationAvailabilityProvider.overrideWith((ref) async {
          if (integrationAvailabilityError != null) {
            throw integrationAvailabilityError!;
          }
          return integrationAvailability;
        }),
        ...overrides,
      ],
      child: MaterialApp(
        locale: const Locale('en'),
        localizationsDelegates: const [
          AppLocalizations.delegate,
          GlobalMaterialLocalizations.delegate,
          GlobalWidgetsLocalizations.delegate,
          GlobalCupertinoLocalizations.delegate,
        ],
        supportedLocales: AppLocalizations.supportedLocales,
        home: Scaffold(body: Center(child: child)),
      ),
    );
  }
}
