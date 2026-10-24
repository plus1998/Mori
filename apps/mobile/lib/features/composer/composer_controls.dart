import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../core/locale/app_localizations_ext.dart';
import '../../core/models/codex_account_models.dart';
import '../../core/constants/bash_review_ui.dart';
import 'composer_toolbar_icon.dart';
import '../../core/models/acp_models.dart';
import '../../core/models/composer_mcp.dart';
import '../../core/models/git_models.dart';
import '../../core/models/integration_models.dart';
import '../../core/models/mcp_models.dart';
import '../../core/models/project_orchestration_settings.dart';
import '../../core/models/skill_models.dart';
import '../../core/models/thread_models.dart';
import '../../core/models/acp_host_ui_features.dart';
import '../../core/models/thread_runtime_config.dart';
import '../../core/models/thread_usage_models.dart';
import '../../core/theme/eco_icons.dart';
import '../../core/theme/eco_theme.dart';
import '../../core/utils/model_id.dart';
import '../../core/utils/thread_usage_display.dart';
import '../../core/widgets/eco_action_sheet.dart';
import '../../core/widgets/eco_grouped_list.dart';
import '../../core/widgets/eco_model_cascade.dart';
import '../../core/widgets/eco_pressable.dart';
import '../../l10n/generated/app_localizations.dart';
import '../threads/thread_info_sheets.dart';
import '../threads/thread_providers.dart';
import 'composer_context_ring.dart';
import 'composer_model_effort_sheet.dart';

const _subagentRoleLabels = {
  'explore': 'Explore',
  'architect': 'Architect',
  'coder': 'Coder',
  'reviewer': 'Reviewer',
  'tester': 'Tester',
};

class ComposerTemporaryModelOption {
  const ComposerTemporaryModelOption({
    required this.providerId,
    required this.modelId,
    this.displayName,
    this.candidateModelId,
    this.supportsReasoning,
  });

  final String providerId;
  final String modelId;
  final String? displayName;
  final String? candidateModelId;
  final bool? supportsReasoning;
}

List<({String value, String label})> composerThinkingEffortOptions(
  AppLocalizations l10n,
) => [
  (value: 'off', label: l10n.composerReasoningOff),
  (value: 'low', label: l10n.composerReasoningLow),
  (value: 'medium', label: l10n.composerReasoningMedium),
  (value: 'high', label: l10n.composerReasoningHigh),
  (value: 'xhigh', label: l10n.composerReasoningExtraHigh),
  (value: 'max', label: l10n.composerReasoningMaximum),
];

List<({String value, String label})> _thinkingEffortOptions(
  AppLocalizations l10n,
) => composerThinkingEffortOptions(l10n);

List<ComposerTemporaryModelOption> buildComposerTemporaryModelOptions({
  required ModelProviderView provider,
  required OrchestrationModelRef templateModel,
  required List<CandidateModelView> candidates,
}) {
  if (!provider.enabled || provider.id != templateModel.providerId) {
    return const [];
  }
  final seen = <String>{};
  final options = <ComposerTemporaryModelOption>[];
  for (final candidate in candidates) {
    final modelId = candidate.modelId.trim();
    if (candidate.providerId != provider.id ||
        modelId.isEmpty ||
        !seen.add(modelId)) {
      continue;
    }
    options.add(
      ComposerTemporaryModelOption(
        providerId: provider.id,
        modelId: modelId,
        displayName: candidate.displayName?.trim().isEmpty == true
            ? null
            : candidate.displayName?.trim(),
        candidateModelId: candidate.id.trim().isEmpty
            ? null
            : candidate.id.trim(),
        supportsReasoning: candidate.resolvedSupportsReasoning,
      ),
    );
  }
  final defaultModel = provider.defaultModel.trim();
  if (defaultModel.isNotEmpty && seen.add(defaultModel)) {
    options.add(
      ComposerTemporaryModelOption(
        providerId: provider.id,
        modelId: defaultModel,
      ),
    );
  }
  final templateModelId = templateModel.modelId.trim();
  if (templateModelId.isNotEmpty && seen.add(templateModelId)) {
    options.insert(
      0,
      ComposerTemporaryModelOption(
        providerId: provider.id,
        modelId: templateModelId,
        candidateModelId: templateModel.candidateModelId,
      ),
    );
  }
  return options;
}

String? composerTemporaryModelEffort(
  MainAgentModelOverride? override,
  OrchestrationModelRef templateModel,
) {
  final overrideUsesTemplateModel =
      override?.providerId.trim() == templateModel.providerId.trim() &&
      override?.modelId.trim() == templateModel.modelId.trim();
  return override?.thinkingEffort ??
      (override == null || overrideUsesTemplateModel
          ? templateModel.thinkingEffort
          : null);
}

String _thinkingEffortLabel(String? effort, AppLocalizations l10n) {
  final value = effort ?? 'off';
  for (final option in _thinkingEffortOptions(l10n)) {
    if (option.value == value) return option.label;
  }
  return value;
}

String composerThinkingEffortLabel(String? effort, AppLocalizations l10n) =>
    _thinkingEffortLabel(effort, l10n);

String composerModelDisplayName(String modelId) =>
    shortenModelId(formatModelDisplayName(modelId));

MainAgentModelOverride? buildComposerTemporaryModelOverride({
  required ComposerTemporaryModelOption model,
  required String? thinkingEffort,
  required OrchestrationModelRef templateModel,
}) {
  final providerId = model.providerId.trim();
  final modelId = model.modelId.trim();
  final candidateModelId = model.candidateModelId?.trim();
  final sameAsTemplate =
      providerId == templateModel.providerId.trim() &&
      modelId == templateModel.modelId.trim() &&
      candidateModelId == templateModel.candidateModelId?.trim() &&
      thinkingEffort == templateModel.thinkingEffort;
  if (sameAsTemplate) return null;
  return MainAgentModelOverride(
    providerId: providerId,
    modelId: modelId,
    thinkingEffort: thinkingEffort,
    candidateModelId: candidateModelId?.isEmpty == true
        ? null
        : candidateModelId,
  );
}

bool composerTemporaryModelSelected(
  MainAgentModelOverride? override,
  ComposerTemporaryModelOption option,
) {
  if (override == null) return false;
  final overrideCandidateId = override.candidateModelId?.trim();
  final optionCandidateId = option.candidateModelId?.trim();
  if (overrideCandidateId?.isNotEmpty == true &&
      optionCandidateId?.isNotEmpty == true) {
    return overrideCandidateId == optionCandidateId;
  }
  return override.providerId == option.providerId &&
      override.modelId == option.modelId;
}

bool composerTemporaryModelMatchesTemplate(
  ComposerTemporaryModelOption option,
  OrchestrationModelRef templateModel,
) {
  final optionCandidateId = option.candidateModelId?.trim();
  final templateCandidateId = templateModel.candidateModelId?.trim();
  if (optionCandidateId?.isNotEmpty == true &&
      templateCandidateId?.isNotEmpty == true) {
    return optionCandidateId == templateCandidateId;
  }
  return option.providerId == templateModel.providerId &&
      option.modelId == templateModel.modelId;
}

Future<void> persistComposerMcpWorkflowDefaults(
  WidgetRef ref, {
  required Map<String, bool> mcpServersEnabled,
}) async {
  final rpc = ref.read(desktopRpcProvider);
  if (rpc == null) return;
  final workflow = await ref.read(workflowSettingsProvider.future);
  if (workflow == null) return;
  await rpc.saveWorkflowSettings(
    WorkflowSettingsSnapshot(
      sessionMode: workflow.sessionMode,
      defaultCoreKind: workflow.defaultCoreKind,
      acpCursorModelId: workflow.acpCursorModelId,
      showBilling: workflow.showBilling,
      defaultBashReviewMode: workflow.defaultBashReviewMode,
      contextWindowLimitTokens: workflow.contextWindowLimitTokens,
      maxOutputLimitTokens: workflow.maxOutputLimitTokens,
      defaultOrchestrationSelection: workflow.defaultOrchestrationSelection,
      defaultAuxiliaryModel: workflow.defaultAuxiliaryModel,
      defaultApprovalModel: workflow.defaultApprovalModel,
      defaultVisionModel: workflow.defaultVisionModel,
      mcpServersEnabled: mcpServersEnabled,
      integrationsEnabled: workflow.integrationsEnabled,
    ),
  );
  ref.invalidate(workflowSettingsProvider);
}

Future<void> persistAuxiliaryModelWorkflowDefault(
  WidgetRef ref, {
  required AuxiliaryModelSelection? selection,
}) async {
  final rpc = ref.read(desktopRpcProvider);
  if (rpc == null) return;
  final workflow = await ref.read(workflowSettingsProvider.future);
  if (workflow == null) return;
  await rpc.saveWorkflowSettings(
    WorkflowSettingsSnapshot(
      sessionMode: workflow.sessionMode,
      defaultCoreKind: workflow.defaultCoreKind,
      acpCursorModelId: workflow.acpCursorModelId,
      showBilling: workflow.showBilling,
      defaultBashReviewMode: workflow.defaultBashReviewMode,
      contextWindowLimitTokens: workflow.contextWindowLimitTokens,
      maxOutputLimitTokens: workflow.maxOutputLimitTokens,
      defaultOrchestrationSelection: workflow.defaultOrchestrationSelection,
      defaultAuxiliaryModel: selection,
      defaultApprovalModel: workflow.defaultApprovalModel,
      defaultVisionModel: workflow.defaultVisionModel,
      mcpServersEnabled: workflow.mcpServersEnabled,
      integrationsEnabled: workflow.integrationsEnabled,
    ),
  );
  ref.invalidate(workflowSettingsProvider);
}

Future<void> persistApprovalModelWorkflowDefault(
  WidgetRef ref, {
  required ApprovalModelSelection? selection,
}) async {
  final rpc = ref.read(desktopRpcProvider);
  if (rpc == null) return;
  final workflow = await ref.read(workflowSettingsProvider.future);
  if (workflow == null) return;
  await rpc.saveWorkflowSettings(
    WorkflowSettingsSnapshot(
      sessionMode: workflow.sessionMode,
      defaultCoreKind: workflow.defaultCoreKind,
      acpCursorModelId: workflow.acpCursorModelId,
      showBilling: workflow.showBilling,
      defaultBashReviewMode: workflow.defaultBashReviewMode,
      contextWindowLimitTokens: workflow.contextWindowLimitTokens,
      maxOutputLimitTokens: workflow.maxOutputLimitTokens,
      defaultOrchestrationSelection: workflow.defaultOrchestrationSelection,
      defaultAuxiliaryModel: workflow.defaultAuxiliaryModel,
      defaultApprovalModel: selection,
      defaultVisionModel: workflow.defaultVisionModel,
      mcpServersEnabled: workflow.mcpServersEnabled,
      integrationsEnabled: workflow.integrationsEnabled,
    ),
  );
  ref.invalidate(workflowSettingsProvider);
}

Future<void> persistVisionModelWorkflowDefault(
  WidgetRef ref, {
  required VisionModelSelection? selection,
}) async {
  final rpc = ref.read(desktopRpcProvider);
  if (rpc == null) return;
  final workflow = await ref.read(workflowSettingsProvider.future);
  if (workflow == null) return;
  await rpc.saveWorkflowSettings(
    WorkflowSettingsSnapshot(
      sessionMode: workflow.sessionMode,
      defaultCoreKind: workflow.defaultCoreKind,
      acpCursorModelId: workflow.acpCursorModelId,
      showBilling: workflow.showBilling,
      defaultBashReviewMode: workflow.defaultBashReviewMode,
      contextWindowLimitTokens: workflow.contextWindowLimitTokens,
      maxOutputLimitTokens: workflow.maxOutputLimitTokens,
      defaultOrchestrationSelection: workflow.defaultOrchestrationSelection,
      defaultAuxiliaryModel: workflow.defaultAuxiliaryModel,
      defaultApprovalModel: workflow.defaultApprovalModel,
      defaultVisionModel: selection,
      mcpServersEnabled: workflow.mcpServersEnabled,
      integrationsEnabled: workflow.integrationsEnabled,
    ),
  );
  ref.invalidate(workflowSettingsProvider);
}

/// Persist thread runtime config to Desktop.
///
/// Optimistically updates local state, then awaits the RPC. On failure the
/// previous config is restored so the UI does not lie about a save that failed
/// (e.g. busy-thread rejection). On success, syncs from the host response so
/// mobile round-trip drift does not stick in local state.
Future<bool> persistRuntimeConfig(
  WidgetRef ref, {
  required String threadId,
  required ThreadRuntimeConfigInput config,
  required ValueChanged<ThreadRuntimeConfigInput> onChanged,
  ThreadRuntimeConfigInput? previousConfig,
  bool reportFailure = false,
}) async {
  final previous = previousConfig ?? ref.read(runtimeConfigProvider);
  final messenger = reportFailure
      ? ScaffoldMessenger.maybeOf(ref.context)
      : null;
  final failureMessage = reportFailure ? ref.context.l10n.errorRpcFailed : null;
  onChanged(config);
  if (threadId.isEmpty) return true;
  final rpc = ref.read(desktopRpcProvider);
  if (rpc == null) return true;
  try {
    final thread = await rpc.updateRuntimeConfig(
      threadId: threadId,
      runtimeConfig: config,
    );
    final saved = thread.runtimeConfig;
    if (saved != null) {
      onChanged(saved);
    }
    return true;
  } catch (_) {
    if (previous != null) {
      onChanged(previous);
    }
    if (messenger != null && messenger.mounted) {
      messenger.showSnackBar(SnackBar(content: Text(failureMessage!)));
    }
    return false;
  }
}

class OrchestrationCompositionSelectors extends ConsumerWidget {
  const OrchestrationCompositionSelectors({
    super.key,
    required this.settings,
    required this.runtimeConfig,
    required this.threadId,
    required this.canEdit,
    this.canEditStatelessModels,
    this.isAcp = false,
    this.mainAgentLabel,
    required this.onChanged,
    required this.workspacePath,
    this.mcpServers = const [],
    this.rememberedMcp,
    this.showOrchestrationPickers = true,
    this.showAuxiliaryModelPicker = false,
    this.showApprovalModelPicker = false,
    this.showVisionModelPicker = false,
  });

  final ModelSettingsSnapshot settings;
  final ThreadRuntimeConfigInput runtimeConfig;
  final String threadId;
  final bool canEdit;
  final bool? canEditStatelessModels;
  final bool isAcp;
  final String? mainAgentLabel;
  final ValueChanged<ThreadRuntimeConfigInput> onChanged;
  final String workspacePath;
  final List<McpServerConfigView> mcpServers;
  final Map<String, bool>? rememberedMcp;
  final bool showOrchestrationPickers;
  final bool showAuxiliaryModelPicker;
  final bool showApprovalModelPicker;
  final bool showVisionModelPicker;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final mainAgentConfigs = settings.mainAgentConfigs;
    final mainAgentPrompts = settings.mainAgentPrompts
        .where((prompt) => prompt.mode == 'custom_append')
        .toList(growable: false);
    final subagentOrchestrations = settings.subagentOrchestrations;
    final selection =
        runtimeConfig.orchestrationSelection ?? emptyOrchestrationSelection();
    final selectedMainAgentConfigId = selection.mainAgentConfigId;
    final mainAgentConfigId =
        mainAgentConfigs.any((config) => config.id == selectedMainAgentConfigId)
        ? selectedMainAgentConfigId
        : '';
    final selectedMainPromptValue = mainPromptSelectionValue(
      selection.mainPrompt,
    );
    final mainPromptValue =
        selectedMainPromptValue == builtinMainPromptValue ||
            mainAgentPrompts.any(
              (prompt) => prompt.id == selectedMainPromptValue,
            )
        ? selectedMainPromptValue
        : '';
    final subagentsValue = subagentSelectionValue(selection.subagents);
    final subagentOrchestrationId =
        subagentsValue != subagentsNoneValue &&
            subagentOrchestrations.any(
              (orchestration) => orchestration.id == subagentsValue,
            )
        ? subagentsValue
        : subagentsValue == subagentsNoneValue
        ? subagentsNoneValue
        : '';

    void applyPatch({
      String? mainAgentConfigId,
      MainAgentPromptSelection? mainPrompt,
      SubagentSelection? subagents,
    }) {
      final nextConfig = applyOrchestrationSelectionPatch(
        settings: settings,
        runtimeConfig: runtimeConfig,
        servers: mcpServers,
        remembered: rememberedMcp,
        mainAgentConfigId: mainAgentConfigId,
        mainPrompt: mainPrompt,
        subagents: subagents,
      );
      persistRuntimeConfig(
        ref,
        previousConfig: runtimeConfig,
        reportFailure: true,
        threadId: threadId,
        config: nextConfig,
        onChanged: onChanged,
      );
      final selection = nextConfig.orchestrationSelection;
      if (threadId.isEmpty &&
          workspacePath.trim().isNotEmpty &&
          hasCompleteOrchestrationSelection(selection)) {
        unawaited(
          persistProjectOrchestrationSelection(
            ref,
            workspacePath: workspacePath,
            selection: selection!,
          ),
        );
      }
    }

    final selectedMainAgent = mainAgentConfigs
        .where((config) => config.id == mainAgentConfigId)
        .firstOrNull;
    final selectedMainAgentLabel = selectedMainAgent == null
        ? context.l10n.commonNotConfigured
        : selectedMainAgent.name;
    final selectedMainAgentDetail = selectedMainAgent == null
        ? null
        : shortenModelId(selectedMainAgent.modelRef.modelId);

    final selectedPromptLabel = mainPromptValue.isEmpty
        ? context.l10n.commonNotConfigured
        : mainPromptValue == builtinMainPromptValue
        ? context.l10n.composerBuiltinMainAgentPrompt
        : mainAgentPrompts
                  .where((prompt) => prompt.id == mainPromptValue)
                  .firstOrNull
                  ?.name ??
              context.l10n.commonNotConfigured;

    final selectedSubagent = subagentOrchestrations
        .where((orchestration) => orchestration.id == subagentOrchestrationId)
        .firstOrNull;
    final selectedSubagentLabel = subagentOrchestrationId.isEmpty
        ? context.l10n.commonNotConfigured
        : subagentOrchestrationId == subagentsNoneValue
        ? context.l10n.composerNoSubagentOrchestration
        : selectedSubagent?.name ?? context.l10n.commonNotConfigured;
    final selectedSubagentDetail = selectedSubagent == null
        ? null
        : context.l10n.composerAgentsCount(selectedSubagent.agents.length);

    final canEditModels = canEditStatelessModels ?? canEdit;
    final children = <Widget>[];
    if (showOrchestrationPickers) {
      children.addAll([
        _OrchestrationPickerRow(
          label: mainAgentLabel ?? context.l10n.composerMainAgent,
          value: selectedMainAgentLabel,
          detail: selectedMainAgentDetail,
          enabled: canEdit && mainAgentConfigs.isNotEmpty,
          onTap: !canEdit || mainAgentConfigs.isEmpty
              ? null
              : () => _showOrchestrationOptionSheet(
                  context,
                  title: mainAgentLabel ?? context.l10n.composerMainAgent,
                  options: [
                    for (final config in mainAgentConfigs)
                      _OrchestrationPickerOption(
                        value: config.id,
                        title: config.name,
                        subtitle: shortenModelId(config.modelRef.modelId),
                      ),
                  ],
                  selectedValue: mainAgentConfigId,
                  onSelected: (value) => applyPatch(mainAgentConfigId: value),
                ),
        ),
        const EcoGroupedDivider(indent: 16),
        _OrchestrationPickerRow(
          label: context.l10n.composerMainAgentPrompt,
          value: selectedPromptLabel,
          enabled: canEdit,
          onTap: !canEdit
              ? null
              : () => _showOrchestrationOptionSheet(
                  context,
                  title: context.l10n.composerMainAgentPrompt,
                  options: [
                    _OrchestrationPickerOption(
                      value: builtinMainPromptValue,
                      title: context.l10n.composerBuiltinMainAgentPrompt,
                    ),
                    for (final prompt in mainAgentPrompts)
                      _OrchestrationPickerOption(
                        value: prompt.id,
                        title: prompt.name,
                      ),
                  ],
                  selectedValue: mainPromptValue,
                  onSelected: (value) => applyPatch(
                    mainPrompt: value == builtinMainPromptValue
                        ? const BuiltinMainAgentPromptSelection()
                        : CustomAppendMainAgentPromptSelection(promptId: value),
                  ),
                ),
        ),
        const EcoGroupedDivider(indent: 16),
        _OrchestrationPickerRow(
          label: context.l10n.composerSubagentOrchestration,
          value: selectedSubagentLabel,
          detail: selectedSubagentDetail,
          enabled: canEdit,
          onTap: !canEdit
              ? null
              : () => _showOrchestrationOptionSheet(
                  context,
                  title: context.l10n.composerSubagentOrchestration,
                  options: [
                    _OrchestrationPickerOption(
                      value: subagentsNoneValue,
                      title: context.l10n.composerNoSubagentOrchestration,
                    ),
                    for (final orchestration in subagentOrchestrations)
                      _OrchestrationPickerOption(
                        value: orchestration.id,
                        title: orchestration.name,
                        subtitle: context.l10n.composerAgentsCount(
                          orchestration.agents.length,
                        ),
                      ),
                  ],
                  selectedValue: subagentOrchestrationId,
                  onSelected: (value) => applyPatch(
                    subagents: value == subagentsNoneValue
                        ? const NoneSubagentSelection()
                        : OrchestrationSubagentSelection(
                            orchestrationId: value,
                          ),
                  ),
                ),
        ),
      ]);
    }
    if (showAuxiliaryModelPicker) {
      if (children.isNotEmpty) {
        children.add(const EcoGroupedDivider(indent: 16));
      }
      children.add(
        _OrchestrationPickerRow(
          label: context.l10n.composerAuxiliaryModel,
          value: runtimeConfig.auxiliaryModel == null
              ? context.l10n.commonNotConfigured
              : shortenModelId(runtimeConfig.auxiliaryModel!.modelId),
          enabled: canEditModels,
          onTap: !canEditModels
              ? null
              : () => showComposerAuxiliaryModelPickerSheet(
                  context,
                  runtimeConfig: runtimeConfig,
                  threadId: threadId,
                  canEdit: canEditModels,
                  onChanged: onChanged,
                  mainAgentConfigId: mainAgentConfigId,
                  isAcp: isAcp,
                ),
        ),
      );
    }
    if (showApprovalModelPicker) {
      if (children.isNotEmpty) {
        children.add(const EcoGroupedDivider(indent: 16));
      }
      children.add(
        _OrchestrationPickerRow(
          label: context.l10n.composerApprovalModel,
          value: runtimeConfig.approvalModel == null
              ? context.l10n.commonNotConfigured
              : shortenModelId(runtimeConfig.approvalModel!.modelId),
          enabled: canEditModels,
          onTap: !canEditModels
              ? null
              : () => showComposerApprovalModelPickerSheet(
                  context,
                  runtimeConfig: runtimeConfig,
                  threadId: threadId,
                  canEdit: canEditModels,
                  onChanged: onChanged,
                  mainAgentConfigId: mainAgentConfigId,
                  isAcp: isAcp,
                ),
        ),
      );
    }
    if (showVisionModelPicker) {
      if (children.isNotEmpty) {
        children.add(const EcoGroupedDivider(indent: 16));
      }
      children.add(
        _OrchestrationPickerRow(
          label: context.l10n.composerVisionModel,
          value: runtimeConfig.visionModel == null
              ? context.l10n.commonNotConfigured
              : shortenModelId(runtimeConfig.visionModel!.modelId),
          enabled: canEditModels,
          onTap: !canEditModels
              ? null
              : () => showComposerVisionModelPickerSheet(
                  context,
                  runtimeConfig: runtimeConfig,
                  threadId: threadId,
                  canEdit: canEditModels,
                  onChanged: onChanged,
                  mainAgentConfigId: mainAgentConfigId,
                  isAcp: isAcp,
                ),
        ),
      );
    }

    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: children,
    );
  }
}

class _OrchestrationPickerOption {
  const _OrchestrationPickerOption({
    required this.value,
    required this.title,
    this.subtitle,
  });

  final String value;
  final String title;
  final String? subtitle;
}

class _OrchestrationPickerRow extends StatelessWidget {
  const _OrchestrationPickerRow({
    required this.label,
    required this.value,
    this.detail,
    required this.enabled,
    this.onTap,
  });

  final String label;
  final String value;
  final String? detail;
  final bool enabled;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final colors = ecoColors(context);
    final canTap = enabled && onTap != null;
    final valueColor = enabled ? colors.textSecondary : colors.textMuted;

    return EcoGroupedTile(
      onTap: canTap
          ? () {
              HapticFeedback.selectionClick();
              onTap!();
            }
          : null,
      padding: const EdgeInsets.fromLTRB(16, 12, 12, 12),
      child: Row(
        children: [
          Expanded(
            flex: 5,
            child: Text(
              label,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: Theme.of(context).textTheme.bodyLarge?.copyWith(
                fontSize: 17,
                letterSpacing: -0.2,
                color: enabled ? colors.textPrimary : colors.textMuted,
              ),
            ),
          ),
          const SizedBox(width: 12),
          Expanded(
            flex: 7,
            child: Row(
              mainAxisAlignment: MainAxisAlignment.end,
              children: [
                Flexible(
                  child: Text(
                    value,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    textAlign: TextAlign.end,
                    style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                      color: valueColor,
                      fontSize: 15,
                      letterSpacing: -0.1,
                      height: 1.2,
                    ),
                  ),
                ),
                if (detail != null && detail!.trim().isNotEmpty) ...[
                  const SizedBox(width: 6),
                  Flexible(
                    child: Text(
                      detail!,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      textAlign: TextAlign.end,
                      style: Theme.of(context).textTheme.bodySmall?.copyWith(
                        color: colors.textMuted,
                        fontSize: 13,
                        letterSpacing: -0.08,
                        height: 1.2,
                      ),
                    ),
                  ),
                ],
                if (canTap) ...[
                  const SizedBox(width: 4),
                  Icon(
                    EcoIcons.chevronRight,
                    size: 16,
                    color: colors.textMuted.withValues(alpha: 0.7),
                  ),
                ],
              ],
            ),
          ),
        ],
      ),
    );
  }
}

Future<void> _showOrchestrationOptionSheet(
  BuildContext context, {
  required String title,
  required List<_OrchestrationPickerOption> options,
  required String selectedValue,
  required ValueChanged<String> onSelected,
}) {
  return showEcoActionSheet<void>(
    context: context,
    isScrollControlled: true,
    builder: (context) => EcoSheetScaffold(
      title: title,
      maxHeightFactor: 0.62,
      child: ListView(
        shrinkWrap: true,
        padding: const EdgeInsets.only(bottom: 8),
        children: [
          EcoGroupedSection(
            topSpacing: 4,
            child: Column(
              children: [
                for (var i = 0; i < options.length; i++) ...[
                  if (i > 0) const EcoGroupedDivider(indent: 16),
                  EcoSheetOptionTile(
                    title: options[i].title,
                    subtitle: options[i].subtitle,
                    selected: options[i].value == selectedValue,
                    onTap: () {
                      HapticFeedback.selectionClick();
                      onSelected(options[i].value);
                      Navigator.pop(context);
                    },
                  ),
                ],
              ],
            ),
          ),
        ],
      ),
    ),
  );
}

class _ComposerSubagentSwitchList extends ConsumerWidget {
  const _ComposerSubagentSwitchList({
    required this.fallbackConfig,
    required this.threadId,
    required this.snapshot,
    required this.canEdit,
    required this.onChanged,
  });

  final ThreadRuntimeConfigInput fallbackConfig;
  final String threadId;
  final ResolvedOrchestrationSnapshot? snapshot;
  final bool canEdit;
  final ValueChanged<ThreadRuntimeConfigInput> onChanged;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final runtimeConfig = watchedComposerRuntimeConfig(ref, fallbackConfig);
    final roles = configuredOrchestrationSubagentRoles(snapshot);
    if (roles.isEmpty) {
      return Padding(
        padding: const EdgeInsets.fromLTRB(16, 14, 16, 14),
        child: Text(
          context.l10n.composerNoSubagents,
          style: Theme.of(
            context,
          ).textTheme.bodyMedium?.copyWith(color: ecoColors(context).textMuted),
        ),
      );
    }

    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        for (var i = 0; i < roles.length; i++) ...[
          if (i > 0) const EcoGroupedDivider(indent: 16),
          Builder(
            builder: (context) {
              final role = roles[i];
              final enabled = isRuntimeSubagentEnabled(
                runtimeConfig.subagentEnabled,
                role,
              );
              final toggleable =
                  canEdit && isSubagentToggleable(snapshot, role);
              final configured = isSubagentConfiguredInSnapshot(snapshot, role);
              return EcoSheetSwitchTile(
                title: _subagentRoleLabels[role] ?? role,
                subtitle: !configured
                    ? context.l10n.composerOrchestrationNotConfigured
                    : enabled
                    ? context.l10n.commonEnabled
                    : context.l10n.commonDisabled,
                value: enabled,
                enabled: toggleable,
                onChanged: !toggleable
                    ? null
                    : (value) {
                        final next = Map<String, bool>.from(
                          normalizedRuntimeSubagentEnabled(
                            runtimeConfig.subagentEnabled,
                          ),
                        );
                        next[role] = value;
                        persistRuntimeConfig(
                          ref,
                          previousConfig: runtimeConfig,
                          reportFailure: true,
                          threadId: threadId,
                          config: runtimeConfig.copyWith(subagentEnabled: next),
                          onChanged: onChanged,
                        );
                      },
              );
            },
          ),
        ],
      ],
    );
  }
}

ThreadRuntimeConfigInput watchedComposerRuntimeConfig(
  WidgetRef ref,
  ThreadRuntimeConfigInput fallback,
) {
  return ref.watch(runtimeConfigProvider) ?? fallback;
}

enum ComposerRouteCategory { integrations, mcp, skills, subagents }

Future<void> showComposerRouteCategorySheet({
  required BuildContext context,
  required ThreadRuntimeConfigInput runtimeConfig,
  required String threadId,
  required bool canEdit,
  required ValueChanged<ThreadRuntimeConfigInput> onChanged,
  required String workspacePath,
  required ComposerRouteCategory category,
}) {
  return showEcoActionSheet<void>(
    context: context,
    isScrollControlled: true,
    builder: (context) => ComposerRouteSheet(
      fallbackConfig: runtimeConfig,
      threadId: threadId,
      canEdit: canEdit,
      onChanged: onChanged,
      workspacePath: workspacePath,
      initialCategory: category,
      lockCategory: true,
    ),
  );
}

class ComposerRouteSheet extends ConsumerStatefulWidget {
  const ComposerRouteSheet({
    super.key,
    required this.fallbackConfig,
    required this.threadId,
    required this.canEdit,
    required this.onChanged,
    this.workspacePath = '',
    this.initialCategory = ComposerRouteCategory.mcp,
    this.lockCategory = false,
  });

  final ThreadRuntimeConfigInput fallbackConfig;
  final String threadId;
  final bool canEdit;
  final ValueChanged<ThreadRuntimeConfigInput> onChanged;
  final String workspacePath;
  final ComposerRouteCategory initialCategory;

  /// When true, hides the category grid and shows only [initialCategory].
  final bool lockCategory;

  @override
  ConsumerState<ComposerRouteSheet> createState() => _ComposerRouteSheetState();
}

class _ComposerRouteSheetState extends ConsumerState<ComposerRouteSheet> {
  late ComposerRouteCategory _selectedCategory = widget.initialCategory;

  ThreadRuntimeConfigInput get fallbackConfig => widget.fallbackConfig;
  String get threadId => widget.threadId;
  bool get canEdit => widget.canEdit;
  ValueChanged<ThreadRuntimeConfigInput> get onChanged => widget.onChanged;
  String get workspacePath => widget.workspacePath;

  @override
  Widget build(BuildContext context) {
    final runtimeConfig = watchedComposerRuntimeConfig(
      ref,
      widget.fallbackConfig,
    );
    final modelSettings = ref.watch(modelSettingsProvider).valueOrNull;
    final workflow = ref.watch(workflowSettingsProvider).valueOrNull;
    final integrationAvailabilityState = ref.watch(
      integrationAvailabilityProvider,
    );
    final integrationAvailability = integrationAvailabilityState.valueOrNull;
    final projectIntegrations = widget.workspacePath.isEmpty
        ? null
        : ref
              .watch(projectIntegrationsSettingsProvider(widget.workspacePath))
              .valueOrNull;
    final integrations =
        integrationAvailability?.integrations ??
        const <IntegrationAvailabilityItem>[];
    final integrationsEnabled =
        runtimeConfig.integrationsEnabled ??
        projectIntegrations?.enabled ??
        workflow?.integrationsEnabled ??
        const <String, bool>{};
    final integrationsUnavailable =
        (integrationAvailabilityState.hasError &&
            !integrationAvailabilityState.hasValue) ||
        (integrationAvailabilityState.hasValue &&
            integrationAvailability == null);
    final integrationsSummary =
        integrationAvailabilityState.isLoading &&
            !integrationAvailabilityState.hasValue
        ? '…'
        : integrationsUnavailable
        ? '!'
        : '${integrationsEnabled.values.where((value) => value).length}/${integrations.length}';
    final mcpServers =
        ref.watch(mcpSettingsProvider).valueOrNull?.servers ?? const [];
    final enabledMcpServers = mcpServers
        .where((server) => server.enabled && server.name.trim().isNotEmpty)
        .toList(growable: false);
    final mcpEnabledSettings = resolveComposerMcpSettings(
      servers: mcpServers,
      runtimeConfig: runtimeConfig,
      snapshot: resolveThreadOrchestrationSnapshot(
        modelSettings,
        runtimeConfig,
      ),
      remembered: workflow?.mcpServersEnabled,
    );
    final skillsResult = widget.workspacePath.isEmpty
        ? null
        : ref.watch(composerSkillsProvider(widget.workspacePath)).valueOrNull;
    final projectSkillsSettings = widget.workspacePath.isEmpty
        ? null
        : ref
              .watch(projectSkillsSettingsProvider(widget.workspacePath))
              .valueOrNull;
    final skills = skillsResult?.allSkills ?? const <SkillInfo>[];
    final skillsEnabled = _deriveComposerSkillsEnabled(
      skills,
      runtimeConfig.skillsEnabled,
      projectSkillsSettings?.enabledByPath,
    );
    final snapshot = resolveThreadOrchestrationSnapshot(
      modelSettings,
      runtimeConfig,
    );

    final categories = [
      (
        value: ComposerRouteCategory.integrations,
        label: context.l10n.composerIntegrations,
        summary: integrationsSummary,
        icon: Icons.extension_outlined,
      ),
      (
        value: ComposerRouteCategory.mcp,
        label: context.l10n.composerMcp,
        summary:
            '${mcpEnabledSettings.values.where((value) => value).length}/${enabledMcpServers.length}',
        icon: EcoIcons.mcp,
      ),
      (
        value: ComposerRouteCategory.skills,
        label: context.l10n.composerSkills,
        summary:
            '${skillsEnabled.values.where((value) => value).length}/${skills.length}',
        icon: EcoIcons.skills,
      ),
      (
        value: ComposerRouteCategory.subagents,
        label: context.l10n.composerSubagents,
        summary: _firstEnabledSubagentLabel(
          runtimeConfig,
          snapshot,
          context.l10n,
        ),
        icon: EcoIcons.subagents,
      ),
    ];
    final selected = categories.firstWhere(
      (category) => category.value == _selectedCategory,
    );
    final lockCategory = widget.lockCategory;

    return EcoSheetScaffold(
      title: lockCategory
          ? selected.label
          : context.l10n.composerOrchestrationComponents,
      subtitle: context.l10n.composerSessionOnly,
      maxHeightFactor: 0.86,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (!lockCategory)
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 2, 16, 12),
              child: GridView.builder(
                shrinkWrap: true,
                primary: false,
                physics: const NeverScrollableScrollPhysics(),
                gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
                  crossAxisCount: 2,
                  mainAxisSpacing: 8,
                  crossAxisSpacing: 8,
                  childAspectRatio: 1.25,
                ),
                itemCount: categories.length,
                itemBuilder: (context, index) {
                  final category = categories[index];
                  return _ComposerRouteCategoryTile(
                    label: category.label,
                    summary: category.summary,
                    icon: category.icon,
                    selected: category.value == _selectedCategory,
                    onTap: () {
                      if (category.value == _selectedCategory) return;
                      HapticFeedback.selectionClick();
                      setState(() => _selectedCategory = category.value);
                    },
                  );
                },
              ),
            ),
          if (!lockCategory)
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 4, 20, 8),
              child: Row(
                children: [
                  Expanded(
                    child: Text(
                      selected.label,
                      style: Theme.of(context).textTheme.titleMedium?.copyWith(
                        fontWeight: FontWeight.w600,
                        letterSpacing: -0.25,
                      ),
                    ),
                  ),
                  ConstrainedBox(
                    constraints: const BoxConstraints(maxWidth: 180),
                    child: Text(
                      selected.summary,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      textAlign: TextAlign.end,
                      style: Theme.of(context).textTheme.bodySmall?.copyWith(
                        color: ecoColors(context).textMuted,
                      ),
                    ),
                  ),
                ],
              ),
            )
          else
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 4, 20, 8),
              child: Align(
                alignment: Alignment.centerRight,
                child: Text(
                  selected.summary,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: Theme.of(context).textTheme.bodySmall?.copyWith(
                    color: ecoColors(context).textMuted,
                  ),
                ),
              ),
            ),
          Expanded(
            child: AnimatedSwitcher(
              duration: const Duration(milliseconds: 180),
              switchInCurve: Curves.easeOutCubic,
              switchOutCurve: Curves.easeInCubic,
              transitionBuilder: (child, animation) =>
                  FadeTransition(opacity: animation, child: child),
              child: ListView(
                key: ValueKey(_selectedCategory),
                padding: const EdgeInsets.only(bottom: 8),
                children: [
                  if (_selectedCategory == ComposerRouteCategory.subagents)
                    EcoGroupedSection(
                      label: context.l10n.composerSubagents,
                      topSpacing: snapshot == null ? 4 : 20,
                      footer: canEdit
                          ? null
                          : context.l10n.composerOrchestrationLocked,
                      child: Column(
                        children: [
                          EcoGroupedTile(
                            padding: const EdgeInsets.fromLTRB(16, 12, 14, 12),
                            child: Row(
                              children: [
                                Expanded(
                                  child: Column(
                                    crossAxisAlignment:
                                        CrossAxisAlignment.start,
                                    children: [
                                      Text(
                                        context.l10n.composerMainAgent,
                                        style: Theme.of(context)
                                            .textTheme
                                            .bodyLarge
                                            ?.copyWith(
                                              fontSize: 17,
                                              letterSpacing: -0.2,
                                            ),
                                      ),
                                      const SizedBox(height: 2),
                                      Text(
                                        context.l10n.composerAlwaysEnabled,
                                        style: Theme.of(context)
                                            .textTheme
                                            .bodySmall
                                            ?.copyWith(
                                              color: ecoColors(
                                                context,
                                              ).textMuted,
                                            ),
                                      ),
                                    ],
                                  ),
                                ),
                                DecoratedBox(
                                  decoration: BoxDecoration(
                                    color: ecoColors(context).statusAllowBg,
                                    borderRadius: BorderRadius.circular(8),
                                  ),
                                  child: Padding(
                                    padding: const EdgeInsets.symmetric(
                                      horizontal: 8,
                                      vertical: 4,
                                    ),
                                    child: Text(
                                      context.l10n.commonEnable,
                                      style: TextStyle(
                                        color: ecoColors(
                                          context,
                                        ).statusAllowText,
                                        fontSize: 12,
                                        fontWeight: FontWeight.w600,
                                      ),
                                    ),
                                  ),
                                ),
                              ],
                            ),
                          ),
                          const EcoGroupedDivider(indent: 16),
                          _ComposerSubagentSwitchList(
                            fallbackConfig: fallbackConfig,
                            threadId: threadId,
                            snapshot: snapshot,
                            canEdit: canEdit,
                            onChanged: onChanged,
                          ),
                        ],
                      ),
                    ),
                  if (_selectedCategory == ComposerRouteCategory.integrations &&
                      integrationAvailabilityState.isLoading &&
                      !integrationAvailabilityState.hasValue)
                    _ComposerRouteEmptyState(
                      message: context.l10n.commonLoading,
                    ),
                  if (_selectedCategory == ComposerRouteCategory.integrations &&
                      integrationsUnavailable)
                    _ComposerRouteErrorState(
                      message: context.l10n.composerIntegrationsLoadFailed,
                      onRetry: () =>
                          ref.invalidate(integrationAvailabilityProvider),
                    ),
                  if (_selectedCategory == ComposerRouteCategory.integrations &&
                      integrationAvailability != null &&
                      integrations.isNotEmpty)
                    EcoGroupedSection(
                      label: context.l10n.composerIntegrations,
                      topSpacing: 20,
                      footer: context.l10n.composerIntegrationsHint,
                      child: Column(
                        children: [
                          for (var i = 0; i < integrations.length; i++) ...[
                            if (i > 0) const EcoGroupedDivider(indent: 16),
                            Builder(
                              builder: (context) {
                                final integration = integrations[i];
                                final enabled =
                                    integrationsEnabled[integration.id] ??
                                    false;
                                final title = switch (integration.id) {
                                  'browser' => context.l10n.composerBrowser,
                                  'imageGeneration' =>
                                    context.l10n.composerImageGeneration,
                                  'computerUse' =>
                                    context.l10n.composerComputerUse,
                                  _ => integration.id,
                                };
                                return EcoSheetSwitchTile(
                                  title: title,
                                  subtitle: integration.available
                                      ? integration.activeProfileName ??
                                            context.l10n.commonEnabled
                                      : integration.reason ??
                                            context.l10n.commonDisabled,
                                  value: enabled,
                                  enabled: canEdit && integration.available,
                                  onChanged: !canEdit || !integration.available
                                      ? null
                                      : (value) async {
                                          final next = Map<String, bool>.from(
                                            integrationsEnabled,
                                          )..[integration.id] = value;
                                          persistRuntimeConfig(
                                            ref,
                                            previousConfig: runtimeConfig,
                                            reportFailure: true,
                                            threadId: threadId,
                                            config: runtimeConfig.copyWith(
                                              integrationsEnabled: next,
                                            ),
                                            onChanged: onChanged,
                                          );
                                          if (workspacePath.isNotEmpty) {
                                            await ref
                                                .read(desktopRpcProvider)
                                                ?.saveProjectIntegrationsSettings(
                                                  ProjectIntegrationsSettingsSnapshot(
                                                    workspacePath:
                                                        workspacePath,
                                                    enabled: next,
                                                  ),
                                                );
                                            ref.invalidate(
                                              projectIntegrationsSettingsProvider(
                                                workspacePath,
                                              ),
                                            );
                                          }
                                        },
                                );
                              },
                            ),
                          ],
                        ],
                      ),
                    ),
                  if (_selectedCategory == ComposerRouteCategory.integrations &&
                      integrationAvailability != null &&
                      integrations.isEmpty)
                    _ComposerRouteEmptyState(
                      message: context.l10n.composerNoIntegrations,
                    ),
                  if (_selectedCategory == ComposerRouteCategory.mcp &&
                      enabledMcpServers.isNotEmpty)
                    EcoGroupedSection(
                      label: context.l10n.composerMcp,
                      topSpacing: 20,
                      footer: canEdit
                          ? context.l10n.composerMcpDisabledHint
                          : null,
                      child: Column(
                        children: [
                          for (
                            var i = 0;
                            i < enabledMcpServers.length;
                            i++
                          ) ...[
                            if (i > 0) const EcoGroupedDivider(indent: 16),
                            Builder(
                              builder: (context) {
                                final server = enabledMcpServers[i];
                                final serverKey = sanitizeMcpServerName(
                                  server.name,
                                );
                                final enabled =
                                    mcpEnabledSettings[serverKey] ?? false;
                                return EcoSheetSwitchTile(
                                  title: server.name,
                                  subtitle: server.transport,
                                  value: enabled,
                                  enabled: canEdit,
                                  onChanged: !canEdit
                                      ? null
                                      : (value) async {
                                          final nextSettings =
                                              Map<String, bool>.from(
                                                mcpEnabledSettings,
                                              )..[serverKey] = value;
                                          persistRuntimeConfig(
                                            ref,
                                            previousConfig: runtimeConfig,
                                            reportFailure: true,
                                            threadId: threadId,
                                            config: runtimeConfig.copyWith(
                                              mcpServersEnabled: nextSettings,
                                            ),
                                            onChanged: onChanged,
                                          );
                                          await persistComposerMcpWorkflowDefaults(
                                            ref,
                                            mcpServersEnabled: nextSettings,
                                          );
                                        },
                                );
                              },
                            ),
                          ],
                        ],
                      ),
                    ),
                  if (_selectedCategory == ComposerRouteCategory.mcp &&
                      enabledMcpServers.isEmpty)
                    _ComposerRouteEmptyState(
                      message: context.l10n.composerNoMcpServers,
                    ),
                  if (_selectedCategory == ComposerRouteCategory.skills &&
                      skills.isEmpty)
                    _ComposerRouteEmptyState(
                      message: context.l10n.composerNoSkills,
                    ),
                  if (_selectedCategory == ComposerRouteCategory.skills &&
                      skills.isNotEmpty)
                    EcoGroupedSection(
                      label: context.l10n.composerSkills,
                      topSpacing: 20,
                      footer: canEdit ? context.l10n.composerSkillsHint : null,
                      child: Column(
                        children: [
                          for (var i = 0; i < skills.length; i++) ...[
                            if (i > 0) const EcoGroupedDivider(indent: 16),
                            Builder(
                              builder: (context) {
                                final skill = skills[i];
                                final key = skill.settingsId;
                                final enabled = skillsEnabled[key] ?? false;
                                return EcoSheetSwitchTile(
                                  title: skill.name,
                                  subtitle: skill.source == 'project'
                                      ? context.l10n.composerProjectSkill(
                                          skill.layout,
                                        )
                                      : context.l10n.composerUserSkill(
                                          skill.layout,
                                        ),
                                  value: enabled,
                                  enabled: canEdit,
                                  onChanged: !canEdit
                                      ? null
                                      : (value) async {
                                          final nextSettings =
                                              Map<String, bool>.from(
                                                skillsEnabled,
                                              )..[key] = value;
                                          persistRuntimeConfig(
                                            ref,
                                            previousConfig: runtimeConfig,
                                            reportFailure: true,
                                            threadId: threadId,
                                            config: runtimeConfig.copyWith(
                                              skillsEnabled: nextSettings,
                                            ),
                                            onChanged: onChanged,
                                          );
                                          if (workspacePath.isNotEmpty) {
                                            final rpc = ref.read(
                                              desktopRpcProvider,
                                            );
                                            await rpc
                                                ?.saveProjectSkillsSettings(
                                                  ProjectSkillsSettingsSnapshot(
                                                    workspacePath:
                                                        workspacePath,
                                                    enabledByPath: nextSettings,
                                                  ),
                                                );
                                            ref.invalidate(
                                              projectSkillsSettingsProvider(
                                                workspacePath,
                                              ),
                                            );
                                          }
                                        },
                                );
                              },
                            ),
                          ],
                        ],
                      ),
                    ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _ComposerRouteEmptyState extends StatelessWidget {
  const _ComposerRouteEmptyState({required this.message});

  final String message;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(20, 24, 16, 0),
      child: Text(
        message,
        style: Theme.of(
          context,
        ).textTheme.bodyMedium?.copyWith(color: ecoColors(context).textMuted),
      ),
    );
  }
}

class _ComposerRouteErrorState extends StatelessWidget {
  const _ComposerRouteErrorState({
    required this.message,
    required this.onRetry,
  });

  final String message;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(20, 24, 16, 0),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            message,
            style: Theme.of(context).textTheme.bodyMedium?.copyWith(
              color: ecoColors(context).textMuted,
            ),
          ),
          const SizedBox(height: 8),
          TextButton.icon(
            onPressed: onRetry,
            icon: const Icon(Icons.refresh, size: 18),
            label: Text(context.l10n.commonRetry),
          ),
        ],
      ),
    );
  }
}

class _ComposerRouteCategoryTile extends StatelessWidget {
  const _ComposerRouteCategoryTile({
    required this.label,
    required this.summary,
    required this.icon,
    required this.selected,
    required this.onTap,
  });

  final String label;
  final String summary;
  final IconData icon;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final colors = ecoColors(context);
    return Semantics(
      button: true,
      selected: selected,
      label: label,
      child: AnimatedScale(
        scale: selected ? 1 : 0.98,
        duration: const Duration(milliseconds: 160),
        curve: Curves.easeOutCubic,
        child: Material(
          color: selected ? colors.accentSoft : colors.cardSurface,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(8),
            side: BorderSide(
              width: 0.5,
              color: selected
                  ? colors.accent.withValues(alpha: 0.3)
                  : colors.cardSurfaceBorder,
            ),
          ),
          clipBehavior: Clip.antiAlias,
          child: InkWell(
            onTap: onTap,
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 8),
              child: Column(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  Row(
                    mainAxisAlignment: MainAxisAlignment.center,
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Icon(
                        icon,
                        size: 17,
                        color: selected ? colors.accent : colors.textSecondary,
                      ),
                      const SizedBox(width: 4),
                      Flexible(
                        child: Text(
                          label,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: Theme.of(context).textTheme.labelSmall
                              ?.copyWith(
                                color: selected
                                    ? colors.accent
                                    : colors.textPrimary,
                                fontSize: 12,
                                fontWeight: selected
                                    ? FontWeight.w600
                                    : FontWeight.w500,
                                letterSpacing: 0,
                              ),
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 5),
                  Text(
                    summary,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    textAlign: TextAlign.center,
                    style: Theme.of(context).textTheme.labelSmall?.copyWith(
                      color: colors.textMuted,
                      fontSize: 10,
                      fontWeight: FontWeight.w400,
                      letterSpacing: 0,
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

String _firstEnabledSubagentLabel(
  ThreadRuntimeConfigInput runtimeConfig,
  ResolvedOrchestrationSnapshot? snapshot,
  AppLocalizations l10n,
) {
  for (final role in configuredOrchestrationSubagentRoles(snapshot)) {
    if (isRuntimeSubagentEnabled(runtimeConfig.subagentEnabled, role)) {
      return _subagentRoleLabels[role] ?? role;
    }
  }
  return l10n.composerNotEnabled;
}

class ComposerAuxiliaryModelSection extends ConsumerWidget {
  const ComposerAuxiliaryModelSection({
    super.key,
    required this.runtimeConfig,
    required this.threadId,
    required this.canEdit,
    required this.onChanged,
    required this.mainAgentConfigId,
    this.closeOnSelect = true,
    this.topSpacing = 20,
    this.showSectionHeader = true,
    this.isAcp = false,
  });

  final ThreadRuntimeConfigInput runtimeConfig;
  final String threadId;
  final bool canEdit;
  final ValueChanged<ThreadRuntimeConfigInput> onChanged;
  final String mainAgentConfigId;
  final bool closeOnSelect;
  final double topSpacing;
  final bool showSectionHeader;
  final bool isAcp;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final options = ref.watch(auxiliaryModelOptionsProvider(mainAgentConfigId));

    void select(CommitModelOptionView? option) {
      final selection = option == null
          ? null
          : AuxiliaryModelSelection(
              providerId: option.providerId,
              modelId: option.modelId,
              candidateModelId: option.candidateModelId,
            );
      var next = option == null
          ? runtimeConfig.copyWith(clearAuxiliaryModel: true)
          : runtimeConfig.copyWith(auxiliaryModel: selection);
      persistRuntimeConfig(
        ref,
        previousConfig: runtimeConfig,
        reportFailure: true,
        threadId: threadId,
        config: next,
        onChanged: onChanged,
      );
      persistAuxiliaryModelWorkflowDefault(
        ref,
        selection: selection,
      ).catchError((_) {});
      if (closeOnSelect) {
        Navigator.pop(context);
      }
    }

    return _auxiliaryModelSection(
      context,
      child: Column(
        children: [
          EcoSheetOptionTile(
            title: context.l10n.commonNotConfigured,
            subtitle: context.l10n.composerAuxiliaryModelManualFallback,
            selected: runtimeConfig.auxiliaryModel == null,
            enabled: canEdit,
            onTap: !canEdit ? null : () => select(null),
          ),
          options.when(
            data: (items) => Column(
              children: [
                const EcoGroupedDivider(indent: 16),
                // Unified provider → model cascade (search + grouped) instead
                // of a flat model list.
                EcoModelCascadeList(
                  layout: EcoModelCascadeLayout.split,
                  height: 360,
                  options: [
                    for (final option in items)
                      ModelCascadeEntry(
                        key: option.candidateModelId,
                        providerKey: option.providerId,
                        providerName: option.providerName,
                        modelId: option.modelId,
                        title: option.modelLabel,
                        subtitle: option.modelId,
                      ),
                  ],
                  selectedKey: runtimeConfig.auxiliaryModel?.candidateModelId,
                  enabled: canEdit,
                  onSelected: (key) {
                    for (final option in items) {
                      if (option.candidateModelId == key) {
                        select(option);
                        break;
                      }
                    }
                  },
                ),
              ],
            ),
            loading: () => const Column(
              children: [
                EcoGroupedDivider(indent: 16),
                EcoGroupedTile(
                  child: Padding(
                    padding: EdgeInsets.symmetric(vertical: 2),
                    child: LinearProgressIndicator(minHeight: 2),
                  ),
                ),
              ],
            ),
            error: (_, _) => Column(
              children: [
                const EcoGroupedDivider(indent: 16),
                EcoGroupedTile(
                  child: Text(context.l10n.composerModelLoadFailed),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _auxiliaryModelSection(BuildContext context, {required Widget child}) {
    return EcoGroupedSection(
      label: showSectionHeader ? context.l10n.composerAuxiliaryModel : null,
      caption: showSectionHeader
          ? (isAcp
                ? context.l10n.composerAuxiliaryModelHintAcp
                : context.l10n.composerAuxiliaryModelHint)
          : null,
      topSpacing: topSpacing,
      child: child,
    );
  }
}

Future<void> showComposerAuxiliaryModelPickerSheet(
  BuildContext context, {
  required ThreadRuntimeConfigInput runtimeConfig,
  required String threadId,
  required bool canEdit,
  required ValueChanged<ThreadRuntimeConfigInput> onChanged,
  required String mainAgentConfigId,
  bool isAcp = false,
}) {
  return showEcoActionSheet<void>(
    context: context,
    isScrollControlled: true,
    builder: (context) => EcoSheetScaffold(
      title: context.l10n.composerAuxiliaryModel,
      subtitle: isAcp
          ? context.l10n.composerAuxiliaryModelHintAcp
          : context.l10n.composerAuxiliaryModelHint,
      maxHeightFactor: 0.7,
      child: ListView(
        shrinkWrap: true,
        padding: const EdgeInsets.only(bottom: 8),
        children: [
          ComposerAuxiliaryModelSection(
            runtimeConfig: runtimeConfig,
            threadId: threadId,
            canEdit: canEdit,
            onChanged: onChanged,
            mainAgentConfigId: mainAgentConfigId,
            topSpacing: 4,
            showSectionHeader: false,
            isAcp: isAcp,
          ),
        ],
      ),
    ),
  );
}

class ComposerApprovalModelSection extends ConsumerWidget {
  const ComposerApprovalModelSection({
    super.key,
    required this.runtimeConfig,
    required this.threadId,
    required this.canEdit,
    required this.onChanged,
    required this.mainAgentConfigId,
    this.closeOnSelect = true,
    this.topSpacing = 20,
    this.showSectionHeader = true,
    this.isAcp = false,
  });

  final ThreadRuntimeConfigInput runtimeConfig;
  final String threadId;
  final bool canEdit;
  final ValueChanged<ThreadRuntimeConfigInput> onChanged;
  final String mainAgentConfigId;
  final bool closeOnSelect;
  final double topSpacing;
  final bool showSectionHeader;
  final bool isAcp;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final options = ref.watch(approvalModelOptionsProvider(mainAgentConfigId));

    void select(CommitModelOptionView? option) {
      final selection = option == null
          ? null
          : ApprovalModelSelection(
              providerId: option.providerId,
              modelId: option.modelId,
              candidateModelId: option.candidateModelId,
            );
      var next = option == null
          ? runtimeConfig.copyWith(clearApprovalModel: true)
          : runtimeConfig.copyWith(approvalModel: selection);
      next = downgradeApprovalDependentFeatures(next);
      persistRuntimeConfig(
        ref,
        previousConfig: runtimeConfig,
        reportFailure: true,
        threadId: threadId,
        config: next,
        onChanged: onChanged,
      );
      persistApprovalModelWorkflowDefault(ref, selection: selection).catchError(
        (Object error) {
          if (context.mounted) {
            ScaffoldMessenger.of(
              context,
            ).showSnackBar(SnackBar(content: Text(error.toString())));
          }
        },
      );
      if (closeOnSelect) {
        Navigator.pop(context);
      }
    }

    return _approvalModelSection(
      context,
      child: Column(
        children: [
          EcoSheetOptionTile(
            title: context.l10n.commonNotConfigured,
            subtitle: context.l10n.composerApprovalModelManualFallback,
            selected: runtimeConfig.approvalModel == null,
            enabled: canEdit,
            onTap: !canEdit ? null : () => select(null),
          ),
          options.when(
            data: (items) => Column(
              children: [
                const EcoGroupedDivider(indent: 16),
                // Unified provider → model cascade (search + grouped) instead
                // of a flat model list.
                EcoModelCascadeList(
                  layout: EcoModelCascadeLayout.split,
                  height: 360,
                  options: [
                    for (final option in items)
                      ModelCascadeEntry(
                        key: option.candidateModelId,
                        providerKey: option.providerId,
                        providerName: option.providerName,
                        modelId: option.modelId,
                        title: option.modelLabel,
                        subtitle: option.modelId,
                      ),
                  ],
                  selectedKey: runtimeConfig.approvalModel?.candidateModelId,
                  enabled: canEdit,
                  onSelected: (key) {
                    for (final option in items) {
                      if (option.candidateModelId == key) {
                        select(option);
                        break;
                      }
                    }
                  },
                ),
              ],
            ),
            loading: () => const Column(
              children: [
                EcoGroupedDivider(indent: 16),
                EcoGroupedTile(
                  child: Padding(
                    padding: EdgeInsets.symmetric(vertical: 2),
                    child: LinearProgressIndicator(minHeight: 2),
                  ),
                ),
              ],
            ),
            error: (_, _) => Column(
              children: [
                const EcoGroupedDivider(indent: 16),
                EcoGroupedTile(
                  child: Text(context.l10n.composerModelLoadFailed),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _approvalModelSection(BuildContext context, {required Widget child}) {
    return EcoGroupedSection(
      label: showSectionHeader ? context.l10n.composerApprovalModel : null,
      caption: showSectionHeader
          ? (isAcp
                ? context.l10n.composerApprovalModelHintAcp
                : context.l10n.composerApprovalModelHint)
          : null,
      topSpacing: topSpacing,
      child: child,
    );
  }
}

Future<void> showComposerApprovalModelPickerSheet(
  BuildContext context, {
  required ThreadRuntimeConfigInput runtimeConfig,
  required String threadId,
  required bool canEdit,
  required ValueChanged<ThreadRuntimeConfigInput> onChanged,
  required String mainAgentConfigId,
  bool isAcp = false,
}) {
  return showEcoActionSheet<void>(
    context: context,
    isScrollControlled: true,
    builder: (context) => EcoSheetScaffold(
      title: context.l10n.composerApprovalModel,
      subtitle: isAcp
          ? context.l10n.composerApprovalModelHintAcp
          : context.l10n.composerApprovalModelHint,
      maxHeightFactor: 0.7,
      child: ListView(
        shrinkWrap: true,
        padding: const EdgeInsets.only(bottom: 8),
        children: [
          ComposerApprovalModelSection(
            runtimeConfig: runtimeConfig,
            threadId: threadId,
            canEdit: canEdit,
            onChanged: onChanged,
            mainAgentConfigId: mainAgentConfigId,
            topSpacing: 4,
            showSectionHeader: false,
            isAcp: isAcp,
          ),
        ],
      ),
    ),
  );
}

class ComposerVisionModelSection extends ConsumerWidget {
  const ComposerVisionModelSection({
    super.key,
    required this.runtimeConfig,
    required this.threadId,
    required this.canEdit,
    required this.onChanged,
    required this.mainAgentConfigId,
    this.closeOnSelect = true,
    this.topSpacing = 20,
    this.isAcp = false,
  });

  final ThreadRuntimeConfigInput runtimeConfig;
  final String threadId;
  final bool canEdit;
  final ValueChanged<ThreadRuntimeConfigInput> onChanged;
  final String mainAgentConfigId;
  final bool closeOnSelect;
  final double topSpacing;
  final bool isAcp;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final options = ref.watch(auxiliaryModelOptionsProvider(mainAgentConfigId));

    void select(CommitModelOptionView? option) {
      final selection = option == null
          ? null
          : VisionModelSelection(
              providerId: option.providerId,
              modelId: option.modelId,
              candidateModelId: option.candidateModelId,
            );
      final next = option == null
          ? runtimeConfig.copyWith(clearVisionModel: true)
          : runtimeConfig.copyWith(visionModel: selection);
      persistRuntimeConfig(
        ref,
        previousConfig: runtimeConfig,
        reportFailure: true,
        threadId: threadId,
        config: next,
        onChanged: onChanged,
      );
      persistVisionModelWorkflowDefault(
        ref,
        selection: selection,
      ).catchError((_) {});
      if (closeOnSelect) {
        Navigator.pop(context);
      }
    }

    return EcoGroupedSection(
      label: context.l10n.composerVisionModel,
      caption: isAcp
          ? context.l10n.composerVisionModelHintAcp
          : context.l10n.composerVisionModelHint,
      topSpacing: topSpacing,
      child: Column(
        children: [
          EcoSheetOptionTile(
            title: context.l10n.commonNotConfigured,
            subtitle: context.l10n.composerVisionModelFollowMain,
            selected: runtimeConfig.visionModel == null,
            enabled: canEdit,
            onTap: !canEdit ? null : () => select(null),
          ),
          options.when(
            data: (items) => Column(
              children: [
                const EcoGroupedDivider(indent: 16),
                // Unified provider → model cascade (search + grouped) instead
                // of a flat model list.
                EcoModelCascadeList(
                  layout: EcoModelCascadeLayout.split,
                  height: 360,
                  options: [
                    for (final option in items)
                      ModelCascadeEntry(
                        key: option.candidateModelId,
                        providerKey: option.providerId,
                        providerName: option.providerName,
                        modelId: option.modelId,
                        title: option.modelLabel,
                        subtitle: option.modelId,
                      ),
                  ],
                  selectedKey: runtimeConfig.visionModel?.candidateModelId,
                  enabled: canEdit,
                  onSelected: (key) {
                    for (final option in items) {
                      if (option.candidateModelId == key) {
                        select(option);
                        break;
                      }
                    }
                  },
                ),
              ],
            ),
            loading: () => const Column(
              children: [
                EcoGroupedDivider(indent: 16),
                EcoGroupedTile(
                  child: Padding(
                    padding: EdgeInsets.symmetric(vertical: 2),
                    child: LinearProgressIndicator(minHeight: 2),
                  ),
                ),
              ],
            ),
            error: (_, _) => Column(
              children: [
                const EcoGroupedDivider(indent: 16),
                EcoGroupedTile(
                  child: Text(context.l10n.composerModelLoadFailed),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

Future<void> showComposerVisionModelPickerSheet(
  BuildContext context, {
  required ThreadRuntimeConfigInput runtimeConfig,
  required String threadId,
  required bool canEdit,
  required ValueChanged<ThreadRuntimeConfigInput> onChanged,
  required String mainAgentConfigId,
  bool isAcp = false,
}) {
  return showEcoActionSheet<void>(
    context: context,
    isScrollControlled: true,
    builder: (context) => EcoSheetScaffold(
      title: context.l10n.composerVisionModel,
      subtitle: isAcp
          ? context.l10n.composerVisionModelHintAcp
          : context.l10n.composerVisionModelHint,
      maxHeightFactor: 0.7,
      child: ListView(
        shrinkWrap: true,
        padding: const EdgeInsets.only(bottom: 8),
        children: [
          ComposerVisionModelSection(
            runtimeConfig: runtimeConfig,
            threadId: threadId,
            canEdit: canEdit,
            onChanged: onChanged,
            mainAgentConfigId: mainAgentConfigId,
            topSpacing: 4,
            isAcp: isAcp,
          ),
        ],
      ),
    ),
  );
}

const composerCoreKindOptions = [
  (value: 'claude', label: 'Claude Code', badge: null, icon: EcoIcons.agent),
  (value: 'codex', label: 'Codex', badge: null, icon: EcoIcons.terminalSquare),
  (value: 'pi', label: 'π', badge: null, icon: EcoIcons.pi),
  (value: 'acp', label: 'Cursor', badge: 'ACP', icon: EcoIcons.agent),
];

Map<String, bool> _deriveComposerSkillsEnabled(
  List<SkillInfo> skills,
  Map<String, bool>? existing,
  Map<String, bool>? remembered,
) {
  return {
    for (final skill in skills)
      skill.settingsId:
          existing?[skill.settingsId] ??
          remembered?[skill.settingsId] ??
          (skill.source == 'project'),
  };
}

class ComposerContextTrigger extends StatelessWidget {
  const ComposerContextTrigger({
    super.key,
    required this.icon,
    required this.label,
    required this.onTap,
    this.enabled = true,
    this.compact = false,
  });

  final IconData icon;
  final String label;
  final VoidCallback? onTap;
  final bool enabled;
  final bool compact;

  @override
  Widget build(BuildContext context) {
    final child = Material(
      color: Colors.transparent,
      child: InkWell(
        onTap: enabled ? onTap : null,
        borderRadius: BorderRadius.circular(8),
        child: Padding(
          padding: EdgeInsets.symmetric(
            horizontal: compact ? 8 : 10,
            vertical: 6,
          ),
          child: Row(
            children: [
              Icon(
                icon,
                size: 15,
                color: enabled
                    ? ecoColors(context).textSecondary
                    : ecoColors(context).textMuted,
              ),
              const SizedBox(width: 6),
              Expanded(
                child: Text(
                  label,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: Theme.of(context).textTheme.labelSmall?.copyWith(
                    color: enabled
                        ? ecoColors(context).textPrimary
                        : ecoColors(context).textMuted,
                    fontWeight: FontWeight.w500,
                    fontSize: 12,
                  ),
                ),
              ),
              if (enabled && onTap != null)
                Icon(
                  EcoIcons.expandDown,
                  size: 14,
                  color: ecoColors(context).textMuted,
                ),
            ],
          ),
        ),
      ),
    );

    if (compact) return child;

    return DecoratedBox(
      decoration: BoxDecoration(
        color: ecoColors(context).composerPillBg,
        borderRadius: BorderRadius.circular(8),
        border: Border.all(
          width: 0.5,
          color: ecoColors(context).composerPillBorder,
        ),
      ),
      child: child,
    );
  }
}

class ComposerToolbarTrigger extends StatelessWidget {
  const ComposerToolbarTrigger({
    super.key,
    required this.icon,
    required this.label,
    required this.onTap,
    this.enabled = true,
  });

  final IconData icon;
  final String label;
  final VoidCallback? onTap;
  final bool enabled;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: Colors.transparent,
      child: InkWell(
        onTap: enabled ? onTap : null,
        borderRadius: BorderRadius.circular(8),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(
                icon,
                size: 15,
                color: enabled
                    ? ecoColors(context).textSecondary
                    : ecoColors(context).textMuted,
              ),
              const SizedBox(width: 5),
              Text(
                label,
                style: Theme.of(context).textTheme.labelSmall?.copyWith(
                  color: enabled
                      ? ecoColors(context).textPrimary
                      : ecoColors(context).textMuted,
                  fontWeight: FontWeight.w500,
                  fontSize: 12,
                ),
              ),
              if (enabled && onTap != null) ...[
                const SizedBox(width: 2),
                Icon(
                  EcoIcons.expandDown,
                  size: 14,
                  color: ecoColors(context).textMuted,
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

class ComposerCompositionControl extends ConsumerWidget {
  const ComposerCompositionControl({
    super.key,
    required this.runtimeConfig,
    required this.threadId,
    required this.canEdit,
    required this.onChanged,
    this.compact = true,
  });

  final ThreadRuntimeConfigInput runtimeConfig;
  final String threadId;
  final bool canEdit;
  final ValueChanged<ThreadRuntimeConfigInput> onChanged;
  final bool compact;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final modelSettings = ref.watch(modelSettingsProvider).valueOrNull;
    final label = orchestrationCompositionSummary(modelSettings, runtimeConfig);
    final displayLabel = label.isEmpty
        ? context.l10n.composerSelectOrchestration
        : label;

    return ComposerContextTrigger(
      icon: EcoIcons.orchestration,
      label: displayLabel,
      enabled: canEdit,
      compact: compact,
      onTap: canEdit
          ? () => _showCompositionSheet(
              context,
              ref,
              runtimeConfig: runtimeConfig,
              threadId: threadId,
              onChanged: onChanged,
            )
          : null,
    );
  }

  Future<void> _showCompositionSheet(
    BuildContext context,
    WidgetRef ref, {
    required ThreadRuntimeConfigInput runtimeConfig,
    required String threadId,
    required ValueChanged<ThreadRuntimeConfigInput> onChanged,
  }) async {
    final settings = await ref.read(modelSettingsProvider.future);
    final workflow = await ref.read(workflowSettingsProvider.future);
    final mcpServers = await ref.read(mcpSettingsProvider.future);
    if (settings == null ||
        settings.mainAgentConfigs.isEmpty ||
        !context.mounted) {
      return;
    }

    await showEcoActionSheet<void>(
      context: context,
      isScrollControlled: true,
      builder: (context) => EcoSheetScaffold(
        title: context.l10n.composerSelectOrchestrationSelection,
        maxHeightFactor: 0.7,
        child: ListView(
          shrinkWrap: true,
          padding: const EdgeInsets.only(bottom: 8),
          children: [
            EcoGroupedSection(
              topSpacing: 4,
              child: OrchestrationCompositionSelectors(
                settings: settings,
                runtimeConfig: runtimeConfig,
                threadId: threadId,
                canEdit: true,
                onChanged: onChanged,
                workspacePath: '',
                mcpServers: mcpServers?.servers ?? const [],
                rememberedMcp: workflow?.mcpServersEnabled,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

Future<void> persistProjectOrchestrationSelection(
  WidgetRef ref, {
  required String workspacePath,
  required OrchestrationSelection selection,
}) async {
  final rpc = ref.read(desktopRpcProvider);
  if (rpc == null || workspacePath.trim().isEmpty) return;
  try {
    await rpc.saveProjectOrchestrationSettings(
      ProjectOrchestrationSettingsSnapshot(
        workspacePath: workspacePath,
        orchestrationSelection: selection,
      ),
    );
    ref.invalidate(projectOrchestrationSettingsProvider(workspacePath));
  } catch (_) {
    // The local new-thread selection remains usable when persistence fails.
  }
}

class ComposerOrchestrationControl extends ConsumerWidget {
  const ComposerOrchestrationControl({
    super.key,
    required this.runtimeConfig,
    required this.threadId,
    required this.canEdit,
    required this.onChanged,
    this.compact = true,
  });

  final ThreadRuntimeConfigInput runtimeConfig;
  final String threadId;
  final bool canEdit;
  final ValueChanged<ThreadRuntimeConfigInput> onChanged;
  final bool compact;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final modelSettings = ref.watch(modelSettingsProvider).valueOrNull;
    final snapshot = resolveThreadOrchestrationSnapshot(
      modelSettings,
      runtimeConfig,
    );
    final enabledCount = countEnabledSubagents(runtimeConfig.subagentEnabled);
    final totalCount = countConfiguredSubagents(snapshot);
    final summary = totalCount > 0
        ? '$enabledCount/$totalCount'
        : '$enabledCount';

    return ComposerContextTrigger(
      icon: EcoIcons.subagents,
      label: compact
          ? summary
          : context.l10n.composerOrchestrationSummary(summary),
      enabled: canEdit,
      compact: compact,
      onTap: canEdit
          ? () => _showOrchestrationSheet(
              context,
              ref,
              runtimeConfig: runtimeConfig,
              threadId: threadId,
              snapshot: snapshot,
              onChanged: onChanged,
            )
          : null,
    );
  }

  Future<void> _showOrchestrationSheet(
    BuildContext context,
    WidgetRef ref, {
    required ThreadRuntimeConfigInput runtimeConfig,
    required String threadId,
    required ResolvedOrchestrationSnapshot? snapshot,
    required ValueChanged<ThreadRuntimeConfigInput> onChanged,
  }) async {
    await showEcoActionSheet<void>(
      context: context,
      isScrollControlled: true,
      builder: (context) => EcoSheetScaffold(
        title: context.l10n.composerSubagentOrchestration,
        subtitle: context.l10n.composerSubagentOrchestrationSubtitle,
        maxHeightFactor: 0.7,
        child: ListView(
          shrinkWrap: true,
          padding: const EdgeInsets.only(bottom: 8),
          children: [
            EcoGroupedSection(
              label: context.l10n.composerAgents,
              topSpacing: 4,
              child: Column(
                children: [
                  EcoGroupedTile(
                    padding: const EdgeInsets.fromLTRB(16, 12, 14, 12),
                    child: Row(
                      children: [
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(
                                context.l10n.composerMainAgent,
                                style: Theme.of(context).textTheme.bodyLarge
                                    ?.copyWith(
                                      fontSize: 17,
                                      letterSpacing: -0.2,
                                    ),
                              ),
                              const SizedBox(height: 2),
                              Text(
                                context.l10n.composerAlwaysEnabled,
                                style: Theme.of(context).textTheme.bodySmall
                                    ?.copyWith(
                                      color: ecoColors(context).textMuted,
                                    ),
                              ),
                            ],
                          ),
                        ),
                        DecoratedBox(
                          decoration: BoxDecoration(
                            color: ecoColors(context).statusAllowBg,
                            borderRadius: BorderRadius.circular(8),
                          ),
                          child: Padding(
                            padding: const EdgeInsets.symmetric(
                              horizontal: 8,
                              vertical: 4,
                            ),
                            child: Text(
                              context.l10n.commonEnable,
                              style: TextStyle(
                                color: ecoColors(context).statusAllowText,
                                fontSize: 12,
                                fontWeight: FontWeight.w600,
                              ),
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),
                  const EcoGroupedDivider(indent: 16),
                  _ComposerSubagentSwitchList(
                    fallbackConfig: runtimeConfig,
                    threadId: threadId,
                    snapshot: snapshot,
                    canEdit: canEdit,
                    onChanged: onChanged,
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class ComposerRouteSummary extends ConsumerWidget {
  const ComposerRouteSummary({
    super.key,
    required this.runtimeConfig,
    required this.threadId,
    required this.canEdit,
    required this.onChanged,
    this.billing,
    this.contextSnapshot,
    this.threadStatus,
    this.workspacePath = '',
    this.coreKind,
    this.hostUiFeatures = AcpHostUiFeatures.showAll,
  });

  final ThreadRuntimeConfigInput runtimeConfig;
  final String threadId;
  final bool canEdit;
  final ValueChanged<ThreadRuntimeConfigInput> onChanged;
  final ThreadBillingSnapshot? billing;
  final ThreadContextSnapshot? contextSnapshot;
  final String? threadStatus;
  final String workspacePath;
  final String? coreKind;
  final AcpHostUiFeatures hostUiFeatures;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final isAcp = coreKind == 'acp';
    final modelSettings = isAcp
        ? null
        : ref.watch(modelSettingsProvider).valueOrNull;
    final snapshot = resolveThreadOrchestrationSnapshot(
      modelSettings,
      runtimeConfig,
    );
    ModelProviderView? modelProvider;
    final templateProviderId = snapshot?.mainAgent.modelRef.providerId;
    if (templateProviderId != null) {
      for (final provider in modelSettings?.providers ?? const []) {
        if (provider.id == templateProviderId) {
          modelProvider = provider;
          break;
        }
      }
    }
    final themeSource = SubagentThemeSource.fromSnapshot(snapshot);
    final currentMainModelId = isAcp
        ? runtimeConfig.cursorModelId
        : runtimeConfig.mainAgentModelOverride?.modelId ??
              snapshot?.mainAgent.modelRef.modelId;
    final features = hostUiFeatures;
    final showBilling =
        features.showBilling &&
        (ref.watch(workflowSettingsProvider).valueOrNull?.showBilling ?? true);
    final occupancyPct = features.showContextUsage
        ? resolvePlannerOccupancyPct(contextSnapshot)
        : null;
    final showCodexQuota = usesCodexAccount(
      runtimeConfig,
      coreKind,
      resolvedSnapshot: snapshot,
    );
    final showRing =
        showCodexQuota ||
        ((features.showContextUsage || showBilling) &&
            (features.showContextUsage
                ? contextSnapshot != null
                : billing != null));

    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        if (isAcp)
          Flexible(
            child: ComposerAcpModelControl(
              runtimeConfig: runtimeConfig,
              threadId: threadId,
              canEdit: canEdit,
              onChanged: onChanged,
              coreKind: coreKind,
            ),
          )
        else if (snapshot != null && modelProvider != null)
          Flexible(
            child: ComposerModelEffortControl(
              runtimeConfig: runtimeConfig,
              threadId: threadId,
              canEdit: canEdit,
              onChanged: onChanged,
              provider: modelProvider,
              templateModel: snapshot.mainAgent.modelRef,
              workspacePath: workspacePath,
              coreKind: coreKind,
            ),
          ),
        if (showRing)
          ComposerToolbarIconButton(
            onPressed: () => showThreadContextSheet(
              context: context,
              contextSnapshot: features.showContextUsage
                  ? contextSnapshot
                  : null,
              billing: showBilling ? billing : null,
              showContextUsage: features.showContextUsage,
              showBilling: showBilling,
              showCodexQuota: showCodexQuota,
              currentMainModelId: currentMainModelId,
              mainAgentConfigName: snapshot?.mainAgentConfigName,
              threadStatus: threadStatus,
              themeSource: themeSource,
            ),
            tooltip: [
              if (occupancyPct != null) '$occupancyPct%',
              if (showBilling) formatBillingPillCost(billing),
            ].join(' · '),
            icon: ComposerContextRing(
              pct: occupancyPct ?? 0,
              size: kComposerToolbarIconSize,
            ),
          ),
      ],
    );
  }
}

class ComposerAcpModelControl extends ConsumerStatefulWidget {
  const ComposerAcpModelControl({
    super.key,
    required this.runtimeConfig,
    required this.threadId,
    required this.canEdit,
    required this.onChanged,
    this.coreKind,
  });

  final ThreadRuntimeConfigInput runtimeConfig;
  final String threadId;
  final bool canEdit;
  final ValueChanged<ThreadRuntimeConfigInput> onChanged;
  final String? coreKind;

  @override
  ConsumerState<ComposerAcpModelControl> createState() =>
      _ComposerAcpModelControlState();
}

class _ComposerAcpModelControlState
    extends ConsumerState<ComposerAcpModelControl> {
  final GlobalKey _anchorKey = GlobalKey();

  @override
  Widget build(BuildContext context) {
    final models = ref.watch(cursorModelsProvider).valueOrNull ?? const [];
    final selectedModelId = widget.runtimeConfig.cursorModelId;
    final modelName = resolveCursorModelDisplayName(models, selectedModelId);
    final fullModelName = selectedModelId?.trim().isNotEmpty == true
        ? selectedModelId!.trim()
        : modelName;
    final eco = ecoColors(context);
    final nameColor = widget.canEdit ? eco.textSecondary : eco.textMuted;
    final labelStyle = Theme.of(context).textTheme.labelSmall?.copyWith(
      color: nameColor,
      fontSize: 14,
      fontWeight: FontWeight.w500,
      height: 1,
      letterSpacing: 0,
    );
    final label = SizedBox(
      key: _anchorKey,
      height: kComposerToolbarHitSize,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 4),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.center,
          children: [
            Text(
              modelName,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: labelStyle,
            ),
          ],
        ),
      ),
    );

    final interactive = widget.canEdit
        ? EcoPressable(
            borderRadius: BorderRadius.circular(8),
            scale: 0.96,
            onTap: () {
              HapticFeedback.selectionClick();
              ref.invalidate(cursorModelsProvider);
              unawaited(
                showComposerAcpModelPickerSheet(
                  context,
                  ref,
                  anchorKey: _anchorKey,
                  runtimeConfig: widget.runtimeConfig,
                  threadId: widget.threadId,
                  onChanged: widget.onChanged,
                  coreKind: widget.coreKind,
                  canEdit: widget.canEdit,
                ),
              );
            },
            child: label,
          )
        : label;

    return Semantics(
      button: widget.canEdit,
      label: modelName,
      child: fullModelName.isEmpty
          ? interactive
          : Tooltip(
              message: fullModelName,
              triggerMode: TooltipTriggerMode.longPress,
              child: interactive,
            ),
    );
  }
}

Future<void> showComposerAcpModelPickerSheet(
  BuildContext context,
  WidgetRef ref, {
  required GlobalKey anchorKey,
  required ThreadRuntimeConfigInput runtimeConfig,
  required String threadId,
  required ValueChanged<ThreadRuntimeConfigInput> onChanged,
  String? coreKind,
  bool canEdit = true,
}) {
  return showComposerModelEffortSheet(
    context,
    ref,
    anchorKey: anchorKey,
    runtimeConfig: runtimeConfig,
    threadId: threadId,
    onChanged: onChanged,
    provider: null,
    templateModel: null,
    coreKind: coreKind,
    canEdit: canEdit,
  );
}

class ComposerModelEffortControl extends ConsumerStatefulWidget {
  const ComposerModelEffortControl({
    super.key,
    required this.runtimeConfig,
    required this.threadId,
    required this.canEdit,
    required this.onChanged,
    required this.provider,
    required this.templateModel,
    this.workspacePath = '',
    this.coreKind,
  });

  final ThreadRuntimeConfigInput runtimeConfig;
  final String threadId;
  final bool canEdit;
  final ValueChanged<ThreadRuntimeConfigInput> onChanged;
  final ModelProviderView provider;
  final OrchestrationModelRef templateModel;
  final String workspacePath;
  final String? coreKind;

  @override
  ConsumerState<ComposerModelEffortControl> createState() =>
      _ComposerModelEffortControlState();
}

class _ComposerModelEffortControlState
    extends ConsumerState<ComposerModelEffortControl> {
  final GlobalKey _anchorKey = GlobalKey();

  @override
  Widget build(BuildContext context) {
    final eco = ecoColors(context);
    final candidates = ref.watch(candidateModelsProvider(widget.provider.id));
    final options = buildComposerTemporaryModelOptions(
      provider: widget.provider,
      templateModel: widget.templateModel,
      candidates: candidates.valueOrNull ?? const [],
    );
    final override = widget.runtimeConfig.mainAgentModelOverride;
    final currentModel = resolveComposerTemporaryModel(
      options: options,
      override: override,
      templateModel: widget.templateModel,
    );
    final currentEffort = composerTemporaryModelEffort(
      override,
      widget.templateModel,
    );
    final effort = composerThinkingEffortLabel(currentEffort, context.l10n);
    final modelName = composerModelDisplayName(currentModel.modelId);
    final fullModelName = currentModel.modelId.trim();
    final effortAccent = override != null;
    final nameColor = widget.canEdit ? eco.textSecondary : eco.textMuted;
    final effortColor = !widget.canEdit
        ? eco.textMuted
        : effortAccent
        ? eco.accentText
        : eco.textMuted;
    final labelStyle = Theme.of(context).textTheme.labelSmall?.copyWith(
      fontSize: 14,
      fontWeight: FontWeight.w500,
      height: 1,
      letterSpacing: 0,
    );

    final nameStyle = labelStyle?.copyWith(color: nameColor);
    final effortStyle = labelStyle?.copyWith(color: effortColor);

    final label = SizedBox(
      key: _anchorKey,
      height: kComposerToolbarHitSize,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 4),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.center,
          children: [
            Flexible(
              child: Text(
                modelName,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: nameStyle,
              ),
            ),
            const SizedBox(width: 4),
            Text(effort, maxLines: 1, softWrap: false, style: effortStyle),
          ],
        ),
      ),
    );

    final interactive = widget.canEdit
        ? EcoPressable(
            borderRadius: BorderRadius.circular(8),
            scale: 0.96,
            onTap: () {
              HapticFeedback.selectionClick();
              unawaited(
                showComposerModelEffortSheet(
                  context,
                  ref,
                  anchorKey: _anchorKey,
                  runtimeConfig: widget.runtimeConfig,
                  threadId: widget.threadId,
                  onChanged: widget.onChanged,
                  provider: widget.provider,
                  templateModel: widget.templateModel,
                  workspacePath: widget.workspacePath,
                  coreKind: widget.coreKind,
                  canEdit: widget.canEdit,
                ),
              );
            },
            child: label,
          )
        : label;

    return Semantics(
      button: widget.canEdit,
      label: '$modelName $effort',
      child: fullModelName.isEmpty
          ? interactive
          : Tooltip(
              message: fullModelName,
              triggerMode: TooltipTriggerMode.longPress,
              child: interactive,
            ),
    );
  }
}

Future<void> showComposerBashReviewSheet(
  BuildContext context,
  WidgetRef ref, {
  required ThreadRuntimeConfigInput runtimeConfig,
  required String threadId,
  required ValueChanged<ThreadRuntimeConfigInput> onChanged,
}) {
  return showEcoActionSheet<void>(
    context: context,
    builder: (context) => EcoSheetScaffold(
      title: context.l10n.composerBashApproval,
      subtitle: context.l10n.composerBashApprovalSubtitle,
      maxHeightFactor: 0.55,
      child: ListView(
        shrinkWrap: true,
        padding: const EdgeInsets.only(bottom: 8),
        children: [
          EcoGroupedSection(
            label: context.l10n.composerMode,
            topSpacing: 4,
            child: Column(
              children: [
                for (
                  var i = 0;
                  i < bashReviewUiOptions(context.l10n).length;
                  i++
                ) ...[
                  if (i > 0) const EcoGroupedDivider(indent: 52),
                  EcoSheetOptionTile(
                    leading: ComposerBashReviewToolbarIcon(
                      mode: bashReviewUiOptions(context.l10n)[i].value,
                      size: 22,
                      color:
                          bashReviewUiOptions(context.l10n)[i].value ==
                              runtimeConfig.bashReviewMode
                          ? ecoColors(context).accent
                          : ecoColors(context).textMuted,
                    ),
                    title: bashReviewUiOptions(context.l10n)[i].title,
                    subtitle: bashReviewUiOptions(context.l10n)[i].description,
                    selected:
                        bashReviewUiOptions(context.l10n)[i].value ==
                        runtimeConfig.bashReviewMode,
                    onTap: () async {
                      final option = bashReviewUiOptions(context.l10n)[i];
                      if (option.value == 'auto' &&
                          runtimeConfig.approvalModel == null) {
                        ScaffoldMessenger.of(context).showSnackBar(
                          SnackBar(
                            content: Text(
                              context.l10n.auxiliaryModelRequiredForAutoReview,
                            ),
                          ),
                        );
                        return;
                      }
                      final saved = await persistRuntimeConfig(
                        ref,
                        threadId: threadId,
                        config: runtimeConfig.copyWith(
                          bashReviewMode: option.value,
                        ),
                        onChanged: onChanged,
                      );
                      if (!context.mounted) return;
                      if (!saved) {
                        ScaffoldMessenger.of(context).showSnackBar(
                          SnackBar(content: Text(context.l10n.errorRpcFailed)),
                        );
                        return;
                      }
                      Navigator.pop(context);
                    },
                  ),
                ],
              ],
            ),
          ),
        ],
      ),
    ),
  );
}

class ComposerBashReviewIconButton extends ConsumerWidget {
  const ComposerBashReviewIconButton({
    super.key,
    required this.runtimeConfig,
    required this.threadId,
    required this.onChanged,
  });

  final ThreadRuntimeConfigInput runtimeConfig;
  final String threadId;
  final ValueChanged<ThreadRuntimeConfigInput> onChanged;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final mode = runtimeConfig.bashReviewMode;

    return ComposerToolbarIconButton(
      onPressed: () => showComposerBashReviewSheet(
        context,
        ref,
        runtimeConfig: runtimeConfig,
        threadId: threadId,
        onChanged: onChanged,
      ),
      tooltip: bashReviewUi(mode, context.l10n).title,
      icon: ComposerBashReviewToolbarIcon(
        mode: mode,
        color: mode == 'allow_all'
            ? ecoColors(context).warnAccent
            : ecoColors(context).textSecondary,
      ),
    );
  }
}

class ComposerBashReviewControl extends ConsumerWidget {
  const ComposerBashReviewControl({
    super.key,
    required this.runtimeConfig,
    required this.threadId,
    required this.onChanged,
  });

  final ThreadRuntimeConfigInput runtimeConfig;
  final String threadId;
  final ValueChanged<ThreadRuntimeConfigInput> onChanged;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final current = bashReviewUi(runtimeConfig.bashReviewMode, context.l10n);
    final icon = switch (runtimeConfig.bashReviewMode) {
      'auto' => EcoIcons.shieldAuto,
      'allow_all' => EcoIcons.shieldAllowAll,
      _ => EcoIcons.shieldManual,
    };

    return ComposerToolbarTrigger(
      icon: icon,
      label: current.title,
      onTap: () => showComposerBashReviewSheet(
        context,
        ref,
        runtimeConfig: runtimeConfig,
        threadId: threadId,
        onChanged: onChanged,
      ),
    );
  }
}
