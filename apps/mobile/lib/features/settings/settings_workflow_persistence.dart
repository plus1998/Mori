import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/locale/app_error_localizations.dart';
import '../../core/locale/app_localizations_ext.dart';
import '../../core/models/thread_models.dart';
import '../../core/models/thread_runtime_config.dart';
import '../threads/thread_providers.dart';

WorkflowSettingsSnapshot workflowSettingsWith({
  required WorkflowSettingsSnapshot? workflow,
  String? defaultCoreKind,
  bool? showBilling,
  String? defaultBashReviewMode,
  bool clearDefaultCoreKind = false,
  int? contextWindowLimitTokens,
  Object? maxOutputLimitTokens,
  OrchestrationSelection? defaultOrchestrationSelection,
  bool clearDefaultOrchestrationSelection = false,
  AuxiliaryModelSelection? defaultAuxiliaryModel,
  ApprovalModelSelection? defaultApprovalModel,
  bool clearDefaultAuxiliaryModel = false,
  bool clearDefaultApprovalModel = false,
  VisionModelSelection? defaultVisionModel,
  bool clearDefaultVisionModel = false,
  Map<String, bool>? mcpServersEnabled,
  bool clearMcpServersEnabled = false,
}) {
  return WorkflowSettingsSnapshot(
    sessionMode: workflow?.sessionMode ?? 'agent',
    defaultCoreKind: clearDefaultCoreKind
        ? null
        : (defaultCoreKind ?? workflow?.defaultCoreKind),
    acpCursorModelId: workflow?.acpCursorModelId,
    showBilling: showBilling ?? workflow?.showBilling ?? true,
    defaultBashReviewMode: normalizeBashReviewMode(
      defaultBashReviewMode ?? workflow?.defaultBashReviewMode,
    ),
    contextWindowLimitTokens:
        contextWindowLimitTokens ??
        workflow?.contextWindowLimitTokens ??
        defaultContextWindowLimitTokens,
    maxOutputLimitTokens:
        maxOutputLimitTokens ??
        workflow?.maxOutputLimitTokens ??
        defaultMaxOutputLimitTokens,
    defaultOrchestrationSelection: clearDefaultOrchestrationSelection
        ? null
        : (defaultOrchestrationSelection ??
              workflow?.defaultOrchestrationSelection),
    defaultAuxiliaryModel: clearDefaultAuxiliaryModel
        ? null
        : (defaultAuxiliaryModel ?? workflow?.defaultAuxiliaryModel),
    defaultApprovalModel: clearDefaultApprovalModel
        ? null
        : (defaultApprovalModel ?? workflow?.defaultApprovalModel),
    defaultVisionModel: clearDefaultVisionModel
        ? null
        : (defaultVisionModel ?? workflow?.defaultVisionModel),
    mcpServersEnabled: clearMcpServersEnabled
        ? null
        : (mcpServersEnabled ?? workflow?.mcpServersEnabled),
    integrationsEnabled: workflow?.integrationsEnabled,
  );
}

Future<void> saveSettingsShowBilling(
  WidgetRef ref, {
  required BuildContext context,
  required bool nextValue,
}) async {
  final rpc = ref.read(desktopRpcProvider);
  if (rpc == null) return;
  try {
    final workflow = await ref.read(workflowSettingsProvider.future);
    await rpc.saveWorkflowSettings(
      workflowSettingsWith(workflow: workflow, showBilling: nextValue),
    );
    ref.invalidate(workflowSettingsProvider);
  } catch (error) {
    if (context.mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(localizedAppError(error, context.l10n))),
      );
    }
  }
}

Future<void> saveSettingsDefaultBashReviewMode(
  WidgetRef ref, {
  required BuildContext context,
  required String nextMode,
}) async {
  final rpc = ref.read(desktopRpcProvider);
  if (rpc == null) return;
  try {
    final workflow = await ref.read(workflowSettingsProvider.future);
    await rpc.saveWorkflowSettings(
      workflowSettingsWith(workflow: workflow, defaultBashReviewMode: nextMode),
    );
    ref.invalidate(workflowSettingsProvider);
  } catch (error) {
    if (context.mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(localizedAppError(error, context.l10n))),
      );
    }
  }
}

Future<void> saveSettingsContextWindowLimit(
  WidgetRef ref, {
  required BuildContext context,
  required int nextLimit,
  required int previousLimit,
  required ValueChanged<int> onOptimistic,
  required ValueChanged<int> onRevert,
}) async {
  if (nextLimit == previousLimit) return;
  onOptimistic(nextLimit);
  final rpc = ref.read(desktopRpcProvider);
  if (rpc == null) {
    onRevert(previousLimit);
    return;
  }
  try {
    final workflow = await ref.read(workflowSettingsProvider.future);
    await rpc.saveWorkflowSettings(
      workflowSettingsWith(
        workflow: workflow,
        contextWindowLimitTokens: nextLimit,
      ),
    );
    ref.invalidate(workflowSettingsProvider);
  } catch (error) {
    onRevert(previousLimit);
    if (context.mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(localizedAppError(error, context.l10n))),
      );
    }
  }
}

Future<void> saveSettingsMaxOutputLimit(
  WidgetRef ref, {
  required BuildContext context,
  required Object nextLimit,
  required Object previousLimit,
  required ValueChanged<Object> onOptimistic,
  required ValueChanged<Object> onRevert,
}) async {
  if (nextLimit == previousLimit) return;
  onOptimistic(nextLimit);
  final rpc = ref.read(desktopRpcProvider);
  if (rpc == null) {
    onRevert(previousLimit);
    return;
  }
  try {
    final workflow = await ref.read(workflowSettingsProvider.future);
    await rpc.saveWorkflowSettings(
      workflowSettingsWith(workflow: workflow, maxOutputLimitTokens: nextLimit),
    );
    ref.invalidate(workflowSettingsProvider);
  } catch (error) {
    onRevert(previousLimit);
    if (context.mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(localizedAppError(error, context.l10n))),
      );
    }
  }
}

/// Queued write-back for global default orchestration selection.
class SettingsGlobalOrchestrationWriter {
  OrchestrationSelection? _pending;
  bool _saving = false;

  bool get saving => _saving;

  void queue(
    WidgetRef ref, {
    required BuildContext context,
    required ThreadRuntimeConfigInput config,
    required VoidCallback onSavingChanged,
  }) {
    final selection = config.orchestrationSelection;
    if (!hasCompleteOrchestrationSelection(selection)) return;
    _pending = selection;
    _flush(ref, context: context, onSavingChanged: onSavingChanged);
  }

  Future<void> _flush(
    WidgetRef ref, {
    required BuildContext context,
    required VoidCallback onSavingChanged,
  }) async {
    final rpc = ref.read(desktopRpcProvider);
    if (rpc == null || _saving) return;
    _saving = true;
    onSavingChanged();
    try {
      while (_pending != null) {
        final selection = _pending!;
        _pending = null;
        final workflow = await ref.read(workflowSettingsProvider.future);
        await rpc.saveWorkflowSettings(
          workflowSettingsWith(
            workflow: workflow,
            defaultOrchestrationSelection: selection,
          ),
        );
      }
      ref.invalidate(workflowSettingsProvider);
    } catch (error) {
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(localizedAppError(error, context.l10n))),
        );
      }
    } finally {
      _saving = false;
      onSavingChanged();
    }
  }
}

Future<ThreadRuntimeConfigInput> loadGlobalRuntimeConfig(WidgetRef ref) async {
  final workflow = await ref.read(workflowSettingsProvider.future);
  final modelSettings = await ref.read(modelSettingsProvider.future);
  final mcpSettings = await ref.read(mcpSettingsProvider.future);
  return buildGlobalSettingsRuntimeConfig(
    modelSettings: modelSettings,
    workflow: workflow,
    mcpServers: mcpSettings?.servers,
  );
}
