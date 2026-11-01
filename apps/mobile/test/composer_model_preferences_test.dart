import 'package:eco_mobile/core/models/thread_models.dart';
import 'package:eco_mobile/core/storage/composer_model_preferences.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  const defaults = ThreadRuntimeConfig(
    orchestrationSelection: OrchestrationSelection(
      mainAgentConfigId: '',
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
  const model = OrchestrationModelRef(
    providerId: 'openai',
    modelId: 'gpt-6.1-sol',
    accountId: 'account_1',
    thinkingEffort: 'high',
  );
  setUp(() => SharedPreferences.setMockInitialValues({}));

  test(
    'new sessions keep model preference without copying session settings',
    () async {
      await scope.remember(
        defaults.copyWith(
          orchestrationSelection: defaults.orchestrationSelection!.copyWith(
            mainModel: model,
          ),
          bashReviewMode: 'allow_all',
          sessionMode: 'plan',
        ),
      );
      final restored = await scope.restore(defaults);
      expect(
        restored.orchestrationSelection?.mainModel?.toJson(),
        model.toJson(),
      );
      expect(restored.bashReviewMode, 'always');
      expect(restored.sessionMode, 'agent');
    },
  );

  test(
    'model and account preferences are isolated by desktop, project and core',
    () async {
      await scope.remember(
        defaults.copyWith(
          orchestrationSelection: defaults.orchestrationSelection!.copyWith(
            mainModel: model,
          ),
        ),
      );
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
        expect(
          (await other.restore(defaults)).orchestrationSelection?.mainModel,
          isNull,
        );
      }
    },
  );

  test('clearing the selection clears the remembered model', () async {
    await scope.remember(
      defaults.copyWith(
        orchestrationSelection: defaults.orchestrationSelection!.copyWith(
          mainModel: model,
        ),
      ),
    );
    await scope.remember(defaults);
    expect(
      (await scope.restore(defaults)).orchestrationSelection?.mainModel,
      isNull,
    );
  });
}
