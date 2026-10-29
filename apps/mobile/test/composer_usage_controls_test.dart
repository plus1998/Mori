import 'package:eco_mobile/core/network/desktop_rpc.dart';
import 'package:eco_mobile/core/network/eco_center_client.dart';
import 'package:eco_mobile/core/storage/credential_store.dart';
import 'package:eco_mobile/core/theme/eco_theme.dart';
import 'package:eco_mobile/features/composer/composer_plus_menu.dart';
import 'package:eco_mobile/core/models/acp_host_ui_features.dart';
import 'package:eco_mobile/core/models/acp_models.dart';
import 'package:eco_mobile/core/models/thread_models.dart';
import 'package:eco_mobile/core/models/thread_usage_models.dart';
import 'package:eco_mobile/core/models/integration_models.dart';
import 'package:eco_mobile/core/providers/app_providers.dart';
import 'package:eco_mobile/core/storage/composer_model_preferences.dart';
import 'package:eco_mobile/core/theme/eco_icons.dart';
import 'package:eco_mobile/core/widgets/eco_action_sheet.dart';
import 'package:eco_mobile/core/widgets/eco_model_cascade.dart';
import 'package:eco_mobile/features/composer/composer_context_ring.dart';
import 'package:eco_mobile/features/composer/composer_controls.dart';
import 'package:eco_mobile/features/composer/composer_toolbar_icon.dart';
import 'package:eco_mobile/features/composer/session_composer.dart';
import 'package:eco_mobile/features/scheduling/schedule_editor.dart';
import 'package:eco_mobile/features/threads/thread_providers.dart';
import 'package:eco_mobile/l10n/generated/app_localizations.dart';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));
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
      expect(find.text('Model'), findsOneWidget);
      expect(find.text('Reasoning'), findsOneWidget);
      for (final duplicate in [
        'Profile',
        'Main agent',
        'Advanced',
        'Prompt',
        'Subagents',
        'Aux',
        'Auxiliary model',
        'Approval model',
        'Vision',
        'Vision model',
      ]) {
        expect(find.text(duplicate), findsNothing);
      }
      expect(find.text('High'), findsWidgets);
      expect(find.text('Fast'), findsNothing);

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

  testWidgets('new Codex composer restores the last picked model and effort', (
    tester,
  ) async {
    const scope = ComposerModelPreferenceScope(
      desktopId: 'desktop_1',
      workspacePath: '/repo',
      coreKind: 'codex',
    );
    Widget composer(ThreadRuntimeConfigInput config) => _TestApp(
      modelSettings: modelSettings,
      candidates: candidates,
      overrides: [
        selectedDesktopIdProvider.overrideWith((ref) => 'desktop_1'),
        workflowSettingsProvider.overrideWith((ref) async => null),
      ],
      child: ComposerRouteSummary(
        runtimeConfig: config,
        threadId: '',
        workspacePath: '/repo',
        coreKind: 'codex',
        canEdit: true,
        onChanged: (_) {},
      ),
    );
    await tester.pumpWidget(composer(modelRuntimeConfig));
    await tester.pumpAndSettle();
    await tester.tap(find.text('5.6 Sol'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Reasoning'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Low'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Model'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Fast'));
    await tester.pumpAndSettle();

    // Dispose the old composer and reconstruct from fresh workflow defaults.
    await tester.pumpWidget(const SizedBox.shrink());
    final restored = await scope.restore(modelRuntimeConfig);
    expect(restored.mainAgentModelOverride?.modelId, 'gpt-5.6-fast');
    expect(restored.mainAgentModelOverride?.thinkingEffort, 'low');
    await tester.pumpWidget(composer(restored));
    await tester.pumpAndSettle();
    expect(find.text('5.6 Fast'), findsOneWidget);
    expect(find.text('Low'), findsOneWidget);
    expect(find.text('5.6 Sol'), findsNothing);
  });

  for (final newThread in [false, true]) {
    testWidgets('long press transfers text and images for newThread=$newThread', (
      tester,
    ) async {
      final controller = TextEditingController(text: 'Schedule this idea');
      addTearDown(controller.dispose);
      final images = [
        PromptImageAttachment(
          id: 'draft-image',
          mediaType: 'image/png',
          data:
              'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nGkAAAAASUVORK5CYII=',
        ),
      ];
      var sends = 0;
      await tester.pumpWidget(
        _TestApp(
          modelSettings: modelSettings,
          child: StatefulBuilder(
            builder: (context, rebuild) => SessionComposer(
              controller: controller,
              attachments: images,
              runtimeConfig: modelRuntimeConfig,
              threadId: newThread ? '' : 'thread-1',
              workspacePath: '/workspace',
              coreKind: 'claude',
              onScheduledThreadCreated: (_) =>
                  fail('Cancel must not create a thread'),
              isRunning: false,
              hasActivity: true,
              onPickImage: () {},
              onRemoveAttachment: (i) => rebuild(() => images.removeAt(i)),
              onSend: () => sends++,
              onStop: () {},
              onRuntimeConfigChanged: (_) {},
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      await tester.longPress(find.byIcon(EcoIcons.send));
      await tester.pumpAndSettle();
      expect(find.text('Schedule send'), findsOneWidget);
      expect(find.byType(CloseButton), findsNothing);
      expect(controller.text, 'Schedule this idea');
      expect(images, hasLength(1));
      // Dismissing the menu must not consume the draft.
      await tester.tapAt(const Offset(5, 5));
      await tester.pumpAndSettle();
      expect(controller.text, 'Schedule this idea');
      expect(images, hasLength(1));
      await tester.longPress(find.byIcon(EcoIcons.send));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Schedule send'));
      await tester.pumpAndSettle();
      expect(
        find.widgetWithText(TextField, 'Schedule this idea'),
        findsOneWidget,
      );
      expect(find.byTooltip('Remove image 1'), findsOneWidget);
      final editor = tester.widget<ScheduleEditor>(find.byType(ScheduleEditor));
      expect(editor.newThread?.workspacePath, newThread ? '/workspace' : null);
      expect(editor.newThread?.coreKind, newThread ? 'claude' : null);
      expect(editor.threadId, newThread ? startsWith('thr_') : 'thread-1');
      expect(sends, 0);
      expect(controller.text, isEmpty);
      expect(images, isEmpty);
      await tester.tap(find.byType(CloseButton));
      await tester.pumpAndSettle();
      expect(controller.text, isEmpty);
      expect(images, isEmpty);
      expect(sends, 0);
    });
  }

  testWidgets(
    'empty new conversation can long press to compose its first scheduled message',
    (tester) async {
      final controller = TextEditingController();
      addTearDown(controller.dispose);
      var sends = 0;
      await tester.pumpWidget(
        _TestApp(
          modelSettings: modelSettings,
          child: SessionComposer(
            controller: controller,
            attachments: const [],
            runtimeConfig: modelRuntimeConfig,
            threadId: '',
            workspacePath: '/workspace',
            coreKind: 'claude',
            isRunning: false,
            hasActivity: false,
            onPickImage: () {},
            onRemoveAttachment: (_) {},
            onSend: () => sends++,
            onStop: () {},
            onRuntimeConfigChanged: (_) {},
            onScheduledThreadCreated: (_) => fail('Not saved'),
          ),
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byIcon(EcoIcons.send));
      expect(sends, 0);
      await tester.longPress(find.byIcon(EcoIcons.send));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Schedule send'));
      await tester.pumpAndSettle();
      expect(find.byType(ScheduleEditor), findsOneWidget);
      expect(
        tester.widget<ScheduleEditor>(find.byType(ScheduleEditor)).newThread,
        isNotNull,
      );
      expect(sends, 0);
    },
  );

  testWidgets('send tap uses default; long press selects only this message', (
    tester,
  ) async {
    final controller = TextEditingController(text: 'next message');
    addTearDown(controller.dispose);
    var defaultSends = 0;
    final modes = <FollowUpDeliveryMode>[];
    var busy = false;
    late StateSetter rebuild;
    await tester.pumpWidget(
      _TestApp(
        modelSettings: modelSettings,
        child: StatefulBuilder(
          builder: (context, setState) {
            rebuild = setState;
            return SessionComposer(
              controller: controller,
              attachments: const [],
              runtimeConfig: modelRuntimeConfig,
              threadId: 'thread-1',
              isRunning: true,
              followUpMode: true,
              sendBusy: busy,
              hasActivity: true,
              onPickImage: () {},
              onRemoveAttachment: (_) {},
              onSend: () => defaultSends++,
              onSendWithMode: modes.add,
              onStop: () {},
              onRuntimeConfigChanged: (_) {},
            );
          },
        ),
      ),
    );
    await tester.pumpAndSettle();
    final send = find.byIcon(EcoIcons.send);
    await tester.tap(send);
    expect(defaultSends, 1);

    await tester.longPress(send);
    await tester.pumpAndSettle();
    expect(defaultSends, 1);
    expect(modes, isEmpty);
    await tester.tap(find.text('Queue'));
    await tester.pumpAndSettle();
    expect(modes, [FollowUpDeliveryMode.queue]);

    await tester.longPress(send);
    await tester.pumpAndSettle();
    await tester.tap(find.text('Guide direction'));
    await tester.pumpAndSettle();
    expect(modes, [FollowUpDeliveryMode.queue, FollowUpDeliveryMode.steer]);

    await tester.longPress(send);
    await tester.pumpAndSettle();
    await tester.tapAt(const Offset(5, 5));
    await tester.pumpAndSettle();
    expect(modes, hasLength(2));
    expect(controller.text, 'next message');
    await tester.tap(send);
    expect(defaultSends, 2);

    rebuild(() => busy = true);
    await tester.pump();
    await tester.longPress(find.byType(CircularProgressIndicator).last);
    await tester.pump(const Duration(milliseconds: 300));
    expect(find.text('Queue'), findsNothing);
    expect(defaultSends, 2);
    expect(modes, hasLength(2));
    rebuild(() => busy = false);
    controller.clear();
    await tester.pumpAndSettle();
    expect(find.byIcon(EcoIcons.send), findsNothing);
    expect(
      find.byWidgetPredicate(
        (widget) => widget is Semantics && widget.properties.label == 'Stop',
      ),
      findsOneWidget,
    );
  });

  testWidgets('runtime config switches main agent prompt and subagents', (
    tester,
  ) async {
    final changes = <ThreadRuntimeConfigInput>[];
    final controller = TextEditingController();
    addTearDown(controller.dispose);
    var config = modelRuntimeConfig;
    await tester.pumpWidget(
      _TestApp(
        modelSettings: modelSettings,
        candidates: candidates,
        child: StatefulBuilder(
          builder: (context, setState) => Align(
            alignment: Alignment.bottomCenter,
            child: SessionComposer(
              controller: controller,
              attachments: const [],
              runtimeConfig: config,
              threadId: 'thread-1',
              isRunning: false,
              hasActivity: true,
              onPickImage: () {},
              onRemoveAttachment: (_) {},
              onSend: () {},
              onStop: () {},
              onRuntimeConfigChanged: (next) {
                changes.add(next);
                setState(() => config = next);
              },
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.byIcon(EcoIcons.add));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Runtime config'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Main agent'));
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
  });

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

  Widget menuComposer(
    TextEditingController controller, {
    ThreadRuntimeConfigInput config = modelRuntimeConfig,
    ValueChanged<ThreadRuntimeConfigInput>? onChanged,
    bool running = false,
    bool followUpMode = false,
    bool sendBusy = false,
    String threadId = 'thread-1',
    String? coreKind,
    ValueChanged<String>? onScheduledThreadCreated,
  }) => Align(
    alignment: Alignment.bottomCenter,
    child: SessionComposer(
      controller: controller,
      attachments: const [],
      runtimeConfig: config,
      threadId: threadId,
      workspacePath: '/workspace',
      coreKind: coreKind,
      isRunning: running,
      followUpMode: followUpMode,
      sendBusy: sendBusy,
      hasActivity: threadId.isNotEmpty,
      onPickImage: () {},
      onRemoveAttachment: (_) {},
      onSend: () {},
      onStop: () {},
      onRuntimeConfigChanged: onChanged ?? (_) {},
      onScheduledThreadCreated: onScheduledThreadCreated,
    ),
  );

  testWidgets(
    'plus menu matches the card and navigates runtime configuration',
    (tester) async {
      final controller = TextEditingController();
      addTearDown(controller.dispose);
      var config = modelRuntimeConfig;
      await tester.pumpWidget(
        _TestApp(
          modelSettings: modelSettings,
          child: StatefulBuilder(
            builder: (context, setState) => menuComposer(
              controller,
              config: config,
              onChanged: (next) => setState(() => config = next),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      final card = tester.getRect(
        find
            .descendant(
              of: find.byType(SessionComposer),
              matching: find.byType(ClipRRect),
            )
            .first,
      );
      await tester.tap(find.byIcon(EcoIcons.add));
      await tester.pumpAndSettle();
      final panel = find.byKey(const ValueKey('composer-plus-panel'));
      final rect = tester.getRect(panel);
      expect(rect.width, closeTo(card.width, 0.1));
      expect(rect.left, closeTo(card.left, 0.1));
      expect(rect.bottom, closeTo(card.top - 10, 0.1));
      expect(rect.height, lessThanOrEqualTo(420));
      await tester.tap(find.text('Runtime config'));
      await tester.pumpAndSettle();
      expect(find.text('Main agent'), findsOneWidget);
      expect(find.text('Prompt'), findsOneWidget);
      expect(find.text('Auxiliary model'), findsOneWidget);
      expect(find.text('Approval model'), findsOneWidget);
      expect(find.text('Vision model'), findsOneWidget);
      await tester.tap(find.text('Prompt'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Strict style'));
      await tester.pumpAndSettle();
      expect(find.text('Strict style'), findsOneWidget);
      expect(
        config.orchestrationSelection?.mainPrompt,
        isA<CustomAppendMainAgentPromptSelection>(),
      );
      expect(find.text('Subagents'), findsOneWidget);
      expect(find.text('Integrations'), findsNothing);
      expect(find.text('MCP Servers'), findsNothing);
      expect(find.text('Skills'), findsNothing);
      await tester.binding.handlePopRoute();
      await tester.pumpAndSettle();
      expect(find.text('Modes and session'), findsOneWidget);
      for (final category in [
        (label: 'Integrations', value: ComposerRouteCategory.integrations),
        (label: 'MCP Servers', value: ComposerRouteCategory.mcp),
        (label: 'Skills', value: ComposerRouteCategory.skills),
        (label: 'Subagents', value: ComposerRouteCategory.subagents),
      ]) {
        await tester.ensureVisible(find.text(category.label));
        await tester.tap(find.text(category.label));
        await tester.pumpAndSettle();
        final sheet = tester.widget<ComposerRouteSheet>(
          find.byType(ComposerRouteSheet),
        );
        expect(sheet.initialCategory, category.value);
        expect(sheet.lockCategory, isTrue);
        await tester.binding.handlePopRoute();
        await tester.pumpAndSettle();
        expect(find.text('Modes and session'), findsOneWidget);
      }
      await tester.ensureVisible(find.text('Runtime config'));
      await tester.tap(find.text('Runtime config'));
      await tester.pumpAndSettle();
      await tester.tap(find.byTooltip('Back to menu'));
      await tester.pumpAndSettle();
      expect(find.text('Modes and session'), findsOneWidget);
      // The outside barrier at the trigger position dismisses the menu.
      await tester.tapAt(tester.getCenter(find.byIcon(EcoIcons.add)));
      await tester.pumpAndSettle();
      expect(panel, findsNothing);
      await tester.tap(find.byIcon(EcoIcons.add));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Runtime config'));
      await tester.pumpAndSettle();
      await tester.tap(find.byTooltip('Close'));
      await tester.pumpAndSettle();
      expect(panel, findsNothing);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('plus menu toggles an active mode and switches between modes', (
    tester,
  ) async {
    final controller = TextEditingController();
    addTearDown(controller.dispose);
    var config = modelRuntimeConfig;
    await tester.pumpWidget(
      _TestApp(
        modelSettings: modelSettings,
        child: StatefulBuilder(
          builder: (context, setState) => menuComposer(
            controller,
            config: config,
            onChanged: (value) => setState(() => config = value),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    for (final mode in ['Plan', 'Ask', 'Ask']) {
      await tester.tap(find.byIcon(EcoIcons.add));
      await tester.pumpAndSettle();
      if (config.sessionMode != 'agent') {
        expect(find.text('Enabled'), findsOneWidget);
      }
      await tester.tap(find.text(mode));
      await tester.pumpAndSettle();
    }
    expect(config.sessionMode, 'agent');
  });

  testWidgets(
    'open config refreshes and keeps stateless models editable during a run',
    (tester) async {
      final controller = TextEditingController();
      addTearDown(controller.dispose);
      var running = false;
      var config = modelRuntimeConfig;
      late StateSetter rebuild;
      await tester.pumpWidget(
        _TestApp(
          modelSettings: modelSettings,
          child: StatefulBuilder(
            builder: (context, setState) {
              rebuild = setState;
              return menuComposer(controller, config: config, running: running);
            },
          ),
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byIcon(EcoIcons.add));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Runtime config'));
      await tester.pumpAndSettle();
      rebuild(() {
        running = true;
        config = config.copyWith(
          auxiliaryModel: const AuxiliaryModelSelection(
            providerId: 'provider-1',
            modelId: 'new-model',
            candidateModelId: 'new-candidate',
          ),
        );
      });
      await tester.pumpAndSettle();
      final selectors = tester.widget<OrchestrationCompositionSelectors>(
        find.byType(OrchestrationCompositionSelectors),
      );
      expect(selectors.canEdit, isFalse);
      expect(selectors.canEditStatelessModels, isTrue);
      expect(find.text('new-model'), findsOneWidget);
      await tester.tap(find.text('Main agent'));
      await tester.pumpAndSettle();
      expect(find.byType(EcoSheetScaffold), findsNothing);
      await tester.tap(find.text('Auxiliary model'));
      await tester.pumpAndSettle();
      expect(find.byType(ComposerAuxiliaryModelSection), findsOneWidget);
      await tester.binding.handlePopRoute();
      await tester.pumpAndSettle();
      await tester.tap(find.byTooltip('Back to menu'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Plan'));
      await tester.pumpAndSettle();
      expect(find.byType(ComposerPlusMenuPanel), findsOneWidget);
      expect(config.sessionMode, 'agent');
      expect(tester.takeException(), isNull);
    },
  );

  for (final newThread in [false, true]) {
    testWidgets(
      'plus menu schedules ${newThread ? "first" : "existing"} message via the composer flow',
      (tester) async {
        final controller = TextEditingController(
          text: 'Schedule from plus menu',
        );
        addTearDown(controller.dispose);
        await tester.pumpWidget(
          _TestApp(
            modelSettings: modelSettings,
            child: menuComposer(
              controller,
              threadId: newThread ? '' : 'thread-1',
              coreKind: 'claude',
              onScheduledThreadCreated: (_) => fail('Not saved'),
            ),
          ),
        );
        await tester.pumpAndSettle();
        await tester.tap(find.byIcon(EcoIcons.add));
        await tester.pumpAndSettle();
        await tester.tap(find.text('Add scheduled message'));
        await tester.pumpAndSettle();
        final editor = tester.widget<ScheduleEditor>(
          find.byType(ScheduleEditor),
        );
        expect(editor.initialPrompt, 'Schedule from plus menu');
        expect(
          editor.newThread?.workspacePath,
          newThread ? '/workspace' : null,
        );
        expect(editor.threadId, newThread ? startsWith('thr_') : 'thread-1');
        expect(find.byType(ComposerPlusMenuPanel), findsNothing);
        expect(controller.text, isEmpty);
        await tester.tap(find.byType(CloseButton));
        await tester.pumpAndSettle();
      },
    );
  }

  for (final scenario in [
    (running: true, followUp: true, draft: ''),
    (running: true, followUp: true, draft: 'Later while running'),
    (running: true, followUp: false, draft: 'Later'),
    (running: false, followUp: true, draft: 'Paused queue'),
  ]) {
    testWidgets('schedule current conversation from plus menu: $scenario', (
      tester,
    ) async {
      final controller = TextEditingController(text: scenario.draft);
      addTearDown(controller.dispose);
      await tester.pumpWidget(
        _TestApp(
          modelSettings: modelSettings,
          child: menuComposer(
            controller,
            running: scenario.running,
            followUpMode: scenario.followUp,
          ),
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byIcon(EcoIcons.add));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Add scheduled message'));
      await tester.pumpAndSettle();
      final editor = tester.widget<ScheduleEditor>(find.byType(ScheduleEditor));
      expect(editor.threadId, 'thread-1');
      expect(editor.newThread, isNull);
      expect(editor.initialPrompt, scenario.draft);
      expect(controller.text, isEmpty);
    });
  }

  testWidgets('running follow-up send menu can schedule without sending now', (
    tester,
  ) async {
    final controller = TextEditingController(text: 'Send later');
    addTearDown(controller.dispose);
    await tester.pumpWidget(
      _TestApp(
        modelSettings: modelSettings,
        child: menuComposer(controller, running: true, followUpMode: true),
      ),
    );
    await tester.pumpAndSettle();
    await tester.longPress(find.byIcon(EcoIcons.send));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Schedule send'));
    await tester.pumpAndSettle();
    final editor = tester.widget<ScheduleEditor>(find.byType(ScheduleEditor));
    expect(editor.threadId, 'thread-1');
    expect(editor.initialPrompt, 'Send later');
    expect(controller.text, isEmpty);
  });

  testWidgets(
    'sending a message still locks scheduling and preserves the draft',
    (tester) async {
      final controller = TextEditingController(text: 'Sending draft');
      addTearDown(controller.dispose);
      await tester.pumpWidget(
        _TestApp(
          modelSettings: modelSettings,
          child: menuComposer(
            controller,
            running: true,
            followUpMode: true,
            sendBusy: true,
          ),
        ),
      );
      await tester.pump(const Duration(milliseconds: 400));
      await tester.tap(find.byIcon(EcoIcons.add));
      await tester.pump(const Duration(milliseconds: 400));
      await tester.tap(find.text('Add scheduled message'));
      await tester.pump(const Duration(milliseconds: 400));
      expect(find.byType(ScheduleEditor), findsNothing);
      expect(controller.text, 'Sending draft');
    },
  );

  for (final scenario in [
    (
      size: const Size(320, 700),
      locale: const Locale('en'),
      scale: 1.0,
      dark: false,
      platform: TargetPlatform.android,
    ),
    (
      size: const Size(390, 844),
      locale: const Locale('zh'),
      scale: 2.0,
      dark: true,
      platform: TargetPlatform.iOS,
    ),
    (
      size: const Size(844, 390),
      locale: const Locale('en'),
      scale: 1.4,
      dark: true,
      platform: TargetPlatform.android,
    ),
    (
      size: const Size(390, 844),
      locale: const Locale('en'),
      scale: 1.0,
      dark: false,
      platform: TargetPlatform.iOS,
    ),
  ]) {
    testWidgets(
      'plus menu fits ${scenario.size} ${scenario.locale} scale ${scenario.scale}',
      (tester) async {
        tester.view.physicalSize = scenario.size;
        tester.view.devicePixelRatio = 1;
        addTearDown(tester.view.resetPhysicalSize);
        addTearDown(tester.view.resetDevicePixelRatio);
        final controller = TextEditingController();
        addTearDown(controller.dispose);
        await tester.pumpWidget(
          _TestApp(
            modelSettings: modelSettings,
            locale: scenario.locale,
            textScaler: TextScaler.linear(scenario.scale),
            theme: (scenario.dark ? buildEcoDarkTheme() : buildEcoLightTheme())
                .copyWith(platform: scenario.platform),
            child: menuComposer(controller),
          ),
        );
        await tester.pumpAndSettle();
        await tester.tap(find.byIcon(EcoIcons.add));
        await tester.pumpAndSettle();
        final panel = find.byKey(const ValueKey('composer-plus-panel'));
        final rect = tester.getRect(panel);
        expect(rect.top, greaterThanOrEqualTo(8));
        expect(rect.left, greaterThanOrEqualTo(8));
        expect(rect.right, lessThanOrEqualTo(scenario.size.width - 8));
        expect(rect.bottom, lessThan(scenario.size.height));
        final configLabel = scenario.locale.languageCode == 'zh'
            ? '运行配置'
            : 'Runtime config';
        await tester.ensureVisible(find.text(configLabel));
        await tester.tap(find.text(configLabel));
        await tester.pumpAndSettle();
        final visionLabel = scenario.locale.languageCode == 'zh'
            ? '视觉模型'
            : 'Vision model';
        await tester.ensureVisible(find.text(visionLabel));
        expect(find.text('Skills'), findsNothing);
        expect(tester.takeException(), isNull);
        await tester.tapAt(const Offset(1, 1));
        await tester.pumpAndSettle();
        expect(panel, findsNothing);
      },
    );
  }

  testWidgets(
    'plus menu tracks keyboard and cleans up when composer is removed',
    (tester) async {
      tester.view.physicalSize = const Size(390, 844);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      addTearDown(tester.view.resetViewInsets);
      final controller = TextEditingController();
      addTearDown(controller.dispose);
      var visible = true;
      late StateSetter rebuild;
      await tester.pumpWidget(
        _TestApp(
          modelSettings: modelSettings,
          child: StatefulBuilder(
            builder: (context, setState) {
              rebuild = setState;
              return visible
                  ? menuComposer(controller)
                  : const SizedBox.shrink();
            },
          ),
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byIcon(EcoIcons.add));
      await tester.pumpAndSettle();
      final panel = find.byKey(const ValueKey('composer-plus-panel'));
      final original = tester.getRect(panel);
      tester.view.viewInsets = const FakeViewPadding(bottom: 300);
      await tester.pumpAndSettle();
      final moved = tester.getRect(panel);
      expect(moved.bottom, closeTo(original.bottom - 300, 0.1));
      expect(moved.top, greaterThanOrEqualTo(8));
      tester.view.physicalSize = const Size(844, 390);
      tester.view.viewInsets = const FakeViewPadding(bottom: 200);
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.text('Runtime config'));
      await tester.tap(find.text('Runtime config'));
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
      rebuild(() => visible = false);
      await tester.pumpAndSettle();
      expect(panel, findsNothing);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'runtime save failure restores the supplied config and reports the error',
    (tester) async {
      final updates = <ThreadRuntimeConfigInput>[];
      await tester.pumpWidget(
        _TestApp(
          overrides: [
            desktopRpcProvider.overrideWithValue(_FailingConfigRpc()),
          ],
          child: Consumer(
            builder: (context, ref, _) => TextButton(
              onPressed: () => persistRuntimeConfig(
                ref,
                threadId: 'thread-1',
                config: modelRuntimeConfig.copyWith(sessionMode: 'plan'),
                previousConfig: modelRuntimeConfig,
                onChanged: updates.add,
                reportFailure: true,
              ),
              child: const Text('Save'),
            ),
          ),
        ),
      );
      await tester.tap(find.text('Save'));
      await tester.pumpAndSettle();
      expect(updates.map((value) => value.sessionMode), ['plan', 'agent']);
      expect(find.text('The Desktop request failed.'), findsOneWidget);
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
    expect(find.text('Modes and session'), findsOneWidget);
    expect(find.text('Add and actions'), findsOneWidget);
    expect(find.text('Configuration'), findsOneWidget);
    expect(find.text('Runtime config'), findsOneWidget);
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
    await tester.ensureVisible(find.text('Image'));
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
    }) async {
      // The overlay lays out from MediaQuery.size, which follows the view's
      // physical size / dpr — `setSurfaceSize` only moves the coordinate
      // transform and would leave it at the default 800x600.
      tester.view.devicePixelRatio = 1.0;
      tester.view.physicalSize = surface;
      addTearDown(tester.view.reset);
      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pumpWidget(
        _TestApp(
          modelSettings: modelSettings,
          candidates: candidates,
          overrides: [
            cursorModelsProvider.overrideWith((ref) async => cursorModels),
          ],
          child: ComposerRouteSummary(
            runtimeConfig: coreKind == 'acp'
                ? acpRuntimeConfig
                : modelRuntimeConfig,
            threadId: 'thread-1',
            canEdit: canEdit,
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

    testWidgets('model and reasoning menus fit a narrow surface', (
      tester,
    ) async {
      const surface = Size(320, 600);
      await openSheet(tester, surface: surface);
      for (final label in ['Model', 'Reasoning']) {
        await tester.tap(find.text(label));
        await tester.pumpAndSettle();
        expect(tester.takeException(), isNull);
        final option = find.text(label == 'Model' ? 'Fast' : 'Low');
        expect(option, findsOneWidget);
        final rect = tester.getRect(option);
        expect(rect.left, greaterThanOrEqualTo(0));
        expect(rect.right, lessThanOrEqualTo(surface.width));
        expect(rect.bottom, lessThanOrEqualTo(surface.height));
      }
    });

    testWidgets('Harness switching lives in plus menu instead of model popup', (
      tester,
    ) async {
      final controller = TextEditingController();
      addTearDown(controller.dispose);
      String? picked;
      await tester.pumpWidget(
        _TestApp(
          modelSettings: modelSettings,
          candidates: candidates,
          child: Align(
            alignment: Alignment.bottomCenter,
            child: SessionComposer(
              controller: controller,
              attachments: const [],
              runtimeConfig: modelRuntimeConfig,
              threadId: '',
              workspacePath: '/workspace',
              isRunning: false,
              hasActivity: false,
              coreKind: 'claude',
              onCoreKindChanged: (kind) => picked = kind,
              onPickImage: () {},
              onRemoveAttachment: (_) {},
              onSend: () {},
              onStop: () {},
              onRuntimeConfigChanged: (_) {},
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.text('5.6 Sol'));
      await tester.pumpAndSettle();
      expect(find.text('Harness'), findsNothing);
      expect(find.text('Model'), findsOneWidget);
      expect(find.text('Reasoning'), findsOneWidget);
      await tester.tapAt(const Offset(10, 10));
      await tester.pumpAndSettle();
      await tester.tap(find.byIcon(EcoIcons.add));
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.text('Harness'));
      expect(find.text('Claude Code'), findsOneWidget);
      await tester.tap(find.text('Harness'));
      await tester.pumpAndSettle();
      expect(find.text('Cursor · ACP'), findsOneWidget);
      await tester.tap(find.text('Codex'));
      await tester.pumpAndSettle();
      expect(picked, 'codex');
      expect(find.byType(ComposerPlusMenuPanel), findsNothing);
    });

    for (final running in [false, true]) {
      testWidgets(
        'Harness menu stays locked in an existing session running=$running',
        (tester) async {
          final controller = TextEditingController();
          addTearDown(controller.dispose);
          await tester.pumpWidget(
            _TestApp(
              modelSettings: modelSettings,
              child: menuComposer(
                controller,
                coreKind: 'claude',
                running: running,
              ),
            ),
          );
          await tester.pumpAndSettle();
          await tester.tap(find.byIcon(EcoIcons.add));
          await tester.pumpAndSettle();
          await tester.ensureVisible(find.text('Harness'));
          await tester.tap(find.text('Harness'));
          await tester.pumpAndSettle();
          expect(find.text('Codex'), findsNothing);
          expect(
            find.textContaining('The Harness is locked for this session'),
            findsOneWidget,
          );
        },
      );
    }

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

    testWidgets('running sessions cannot open the model panel', (tester) async {
      for (final coreKind in ['acp', 'claude']) {
        await openSheet(
          tester,
          surface: const Size(800, 900),
          coreKind: coreKind,
          canEdit: false,
        );
        expect(find.text('Model'), findsNothing);
        expect(find.text('Reasoning'), findsNothing);
        expect(find.byType(EcoModelCascadeList), findsNothing);
      }
    });
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
    this.locale = const Locale('en'),
    this.textScaler = TextScaler.noScaling,
    this.theme,
  });

  final Locale locale;
  final TextScaler textScaler;
  final ThemeData? theme;
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
        locale: locale,
        theme: theme,
        builder: (context, child) => MediaQuery(
          data: MediaQuery.of(context).copyWith(textScaler: textScaler),
          child: child!,
        ),
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

class _FailingConfigRpc extends DesktopRpc {
  _FailingConfigRpc()
    : super(EcoCenterClient(store: CredentialStore()), 'desktop');

  @override
  Future<ThreadSummary> updateRuntimeConfig({
    required String threadId,
    required ThreadRuntimeConfigInput runtimeConfig,
  }) async => throw StateError('Save rejected');
}
