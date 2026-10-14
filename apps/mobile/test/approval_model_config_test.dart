import 'package:flutter_test/flutter_test.dart';
import 'package:eco_mobile/core/models/thread_models.dart';
import 'package:eco_mobile/core/models/thread_runtime_config.dart';
import 'package:eco_mobile/features/settings/settings_workflow_persistence.dart';

void main() {
  const auxiliary = AuxiliaryModelSelection(
    providerId: 'chat',
    modelId: 'fast',
    candidateModelId: 'fast-id',
  );
  const approval = ApprovalModelSelection(
    providerId: 'jev',
    modelId: 'jev-latest',
    candidateModelId: 'jev-id',
  );
  const config = ThreadRuntimeConfig(
    subagentEnabled: {},
    auxiliaryModel: auxiliary,
    approvalModel: approval,
    sessionMode: 'agent',
    bashReviewMode: 'auto',
  );

  test(
    'approval and auxiliary models survive runtime JSON and independent clearing',
    () {
      final restored = ThreadRuntimeConfig.fromJson(config.toJson());
      expect(restored.approvalModel?.candidateModelId, 'jev-id');
      expect(restored.auxiliaryModel?.candidateModelId, 'fast-id');
      expect(
        restored.copyWith(clearAuxiliaryModel: true).approvalModel?.modelId,
        'jev-latest',
      );
      final cleared = restored.copyWith(clearApprovalModel: true);
      expect(cleared.approvalModel, isNull);
      expect(cleared.auxiliaryModel?.modelId, 'fast');
      expect(
        downgradeApprovalDependentFeatures(cleared).bashReviewMode,
        'always',
      );
      expect(
        downgradeApprovalDependentFeatures(
          restored.copyWith(clearAuxiliaryModel: true),
        ).bashReviewMode,
        'auto',
      );
    },
  );

  test('global workflow updates preserve the independent approval model', () {
    final workflow = WorkflowSettingsSnapshot.fromJson(
      const WorkflowSettingsSnapshot(
        sessionMode: 'agent',
        defaultCoreKind: 'acp',
        defaultAuxiliaryModel: auxiliary,
        defaultApprovalModel: approval,
      ).toJson(),
    );
    expect(workflow.defaultApprovalModel?.modelId, 'jev-latest');
    final changed = workflowSettingsWith(
      workflow: workflow,
      showBilling: false,
    );
    expect(changed.defaultApprovalModel?.candidateModelId, 'jev-id');
    expect(
      buildAcpRuntimeConfig(workflow: changed).approvalModel?.modelId,
      'jev-latest',
    );
    final cleared = workflowSettingsWith(
      workflow: changed,
      clearDefaultApprovalModel: true,
    );
    expect(cleared.defaultApprovalModel, isNull);
    expect(cleared.defaultAuxiliaryModel?.modelId, 'fast');
  });

  test('auxiliary selection never supplies a missing approval model', () {
    final runtime = buildAcpRuntimeConfig(
      workflow: const WorkflowSettingsSnapshot(
        sessionMode: 'agent',
        defaultAuxiliaryModel: auxiliary,
      ),
    );
    expect(runtime.approvalModel, isNull);
    expect(runtime.auxiliaryModel?.modelId, 'fast');
    expect(
      () => ThreadRuntimeConfig.fromJson({
        ...config.toJson(),
        'approvalModel': {'providerId': 'jev', 'modelId': 'jev-latest'},
      }),
      throwsFormatException,
    );
  });
}
