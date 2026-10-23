import 'package:eco_mobile/core/models/thread_models.dart';
import 'package:eco_mobile/core/storage/composer_model_preferences.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  const defaults = ThreadRuntimeConfig(
    orchestrationSelection: OrchestrationSelection(
      mainAgentConfigId: 'main_1',
      mainPrompt: BuiltinMainAgentPromptSelection(),
      subagents: NoneSubagentSelection(),
    ),
    subagentEnabled: {},
    sessionMode: 'agent',
    bashReviewMode: 'always',
  );
  const scope = ComposerModelPreferenceScope(
    desktopId: 'desktop_1',
    workspacePath: '/repo',
    coreKind: 'codex',
  );
  const model = MainAgentModelOverride(
    providerId: 'openai',
    modelId: 'gpt-6.1-sol',
    candidateModelId: 'candidate_1',
    thinkingEffort: 'high',
  );
  setUp(() => SharedPreferences.setMockInitialValues({}));

  test(
    'new sessions keep model preference without copying session settings',
    () async {
      await scope.remember(
        defaults.copyWith(
          mainAgentModelOverride: model,
          bashReviewMode: 'allow_all',
          sessionMode: 'plan',
        ),
      );
      final restored = await scope.restore(defaults);
      expect(restored.mainAgentModelOverride?.toJson(), model.toJson());
      expect(restored.bashReviewMode, 'always');
      expect(restored.sessionMode, 'agent');
    },
  );

  test(
    'model preferences are isolated by desktop, project, core and profile',
    () async {
      await scope.remember(defaults.copyWith(mainAgentModelOverride: model));
      for (final other in const [
        ComposerModelPreferenceScope(
          desktopId: 'desktop_2',
          workspacePath: '/repo',
          coreKind: 'codex',
        ),
        ComposerModelPreferenceScope(
          desktopId: 'desktop_1',
          workspacePath: '/other',
          coreKind: 'codex',
        ),
        ComposerModelPreferenceScope(
          desktopId: 'desktop_1',
          workspacePath: '/repo',
          coreKind: 'claude',
        ),
      ]) {
        expect((await other.restore(defaults)).mainAgentModelOverride, isNull);
      }
      final otherProfile = defaults.copyWith(
        orchestrationSelection: const OrchestrationSelection(
          mainAgentConfigId: 'main_2',
          mainPrompt: BuiltinMainAgentPromptSelection(),
          subagents: NoneSubagentSelection(),
        ),
      );
      expect(
        (await scope.restore(otherProfile)).mainAgentModelOverride,
        isNull,
      );
    },
  );

  test('choosing template defaults clears a remembered override', () async {
    await scope.remember(defaults.copyWith(mainAgentModelOverride: model));
    await scope.remember(defaults);
    expect((await scope.restore(defaults)).mainAgentModelOverride, isNull);
  });
}
