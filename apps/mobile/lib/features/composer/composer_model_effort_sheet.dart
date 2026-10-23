import 'dart:async';
import 'dart:math' as math;
import 'dart:ui';

import 'package:adaptive_platform_ui/adaptive_platform_ui.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/locale/app_localizations_ext.dart';
import '../../core/models/git_models.dart';
import '../../core/models/mcp_models.dart';
import '../../core/models/thread_models.dart';
import '../../core/models/thread_runtime_config.dart';
import '../../core/models/acp_models.dart';
import '../../core/providers/app_providers.dart';
import '../../core/storage/composer_model_preferences.dart';
import '../../core/theme/eco_icons.dart';
import '../../core/theme/eco_theme.dart';
import '../../core/utils/model_id.dart';
import '../../core/utils/acp_model_vendor.dart';
import '../../core/widgets/eco_action_sheet.dart';
import '../../core/widgets/eco_android_glass.dart';
import '../../core/widgets/eco_grouped_list.dart';
import '../../core/widgets/eco_model_cascade.dart';
import '../../core/widgets/eco_pressable.dart';
import '../../l10n/generated/app_localizations.dart';
import '../threads/thread_providers.dart';
import 'composer_controls.dart';

enum _CascadeBranch {
  mainAgent,
  prompt,
  arrangement,
  model,
  effort,
  agent,
  auxiliary,
  approval,
  vision,
  cursorModel,
}

/// Floating glass cascade: primary menu + side submenu (screenshot style).
Future<void> showComposerModelEffortSheet(
  BuildContext context,
  WidgetRef ref, {
  required GlobalKey anchorKey,
  required ThreadRuntimeConfigInput runtimeConfig,
  required String threadId,
  required ValueChanged<ThreadRuntimeConfigInput> onChanged,
  ModelProviderView? provider,
  OrchestrationModelRef? templateModel,
  String workspacePath = '',
  String? coreKind,
  ValueChanged<String>? onCoreKindChanged,
  bool canEdit = true,
  bool canEditStatelessModels = true,
}) {
  final box = anchorKey.currentContext?.findRenderObject() as RenderBox?;
  if (box == null || !box.hasSize) return Future<void>.value();

  final overlayState = Overlay.of(context);
  final overlayBox = overlayState.context.findRenderObject() as RenderBox;
  final anchorOrigin = box.localToGlobal(Offset.zero, ancestor: overlayBox);
  final anchorRect = anchorOrigin & box.size;
  final completer = Completer<void>();
  late OverlayEntry entry;

  void dismiss() {
    if (entry.mounted) entry.remove();
    if (!completer.isCompleted) completer.complete();
  }

  entry = OverlayEntry(
    builder: (overlayContext) {
      return _ComposerCascadeOverlay(
        anchorRect: anchorRect,
        anchorKey: anchorKey,
        runtimeConfig: runtimeConfig,
        threadId: threadId,
        onChanged: onChanged,
        provider: provider,
        templateModel: templateModel,
        workspacePath: workspacePath,
        coreKind: coreKind,
        onCoreKindChanged: onCoreKindChanged,
        canEdit: canEdit,
        canEditStatelessModels: canEditStatelessModels,
        onDismiss: dismiss,
      );
    },
  );

  overlayState.insert(entry);
  return completer.future;
}

class _ComposerCascadeOverlay extends ConsumerStatefulWidget {
  const _ComposerCascadeOverlay({
    required this.anchorRect,
    required this.anchorKey,
    required this.runtimeConfig,
    required this.threadId,
    required this.onChanged,
    this.provider,
    this.templateModel,
    required this.onDismiss,
    this.workspacePath = '',
    this.coreKind,
    this.onCoreKindChanged,
    this.canEdit = true,
    this.canEditStatelessModels = true,
  });

  final Rect anchorRect;
  final GlobalKey anchorKey;
  final ThreadRuntimeConfigInput runtimeConfig;
  final String threadId;
  final ValueChanged<ThreadRuntimeConfigInput> onChanged;
  final ModelProviderView? provider;
  final OrchestrationModelRef? templateModel;
  final String workspacePath;
  final String? coreKind;
  final ValueChanged<String>? onCoreKindChanged;
  /// Session-bound rows: main model / effort / core kind / orchestration.
  final bool canEdit;

  /// Auxiliary / approval / vision requests are stateless single-shot calls, so those
  /// three pickers stay editable while a run is active.
  final bool canEditStatelessModels;
  final VoidCallback onDismiss;

  @override
  ConsumerState<_ComposerCascadeOverlay> createState() =>
      _ComposerCascadeOverlayState();
}

class _ComposerCascadeOverlayState
    extends ConsumerState<_ComposerCascadeOverlay> {
  late ThreadRuntimeConfigInput _config;
  late String? _coreKind;
  bool _savingModel = false;

  /// Null until Model / Reasoning / Agent is tapped — then the side submenu appears.
  _CascadeBranch? _branch;

  /// Advanced is an inline disclosure, not a cascade branch.
  var _advancedExpanded = false;

  static const _primaryWidth = 208.0;
  static const _submenuWidthIdeal = 260.0;
  static const _cascadeSubmenuWidth = 320.0;
  static const _panelGap = 8.0;
  static const _rowHeight = 44.0;
  static const _rowHeightWithSubtitle = 54.0;
  static const _radius = 16.0;
  static const _edgePad = 12.0;

  /// Cursor/aux/vision cascade panel height (search + split catalogue).
  static const _cursorCascadeHeight = 380.0;
  static const _cascadeBodyHeight = 280.0;

  double get _primaryHeight {
    final rows = 4 + (_advancedExpanded ? 5 : 0);
    return rows * _rowHeight + (rows - 1) * 0.5;
  }

  /// Vertical offset of a primary row from the top of the primary panel.
  double _primaryRowTop(_CascadeBranch branch) {
    final index = switch (branch) {
      _CascadeBranch.cursorModel => 0,
      _CascadeBranch.mainAgent => 0,
      _CascadeBranch.model => 1,
      _CascadeBranch.effort => 2,
      // Advanced header occupies index 3; items below it start at 4.
      _CascadeBranch.agent => 4,
      _CascadeBranch.prompt => 5,
      _CascadeBranch.arrangement => 6,
      _CascadeBranch.auxiliary => 7,
      _CascadeBranch.approval => 8,
      _CascadeBranch.vision => 9,
    };
    return index * (_rowHeight + 0.5);
  }

  /// Side submenu top: align with the tapped primary row; push up if needed.
  double _submenuTopForBranch({
    required _CascadeBranch branch,
    required double primaryTop,
    required double submenuHeight,
    required double minTop,
    required double maxBottom,
  }) {
    var top = primaryTop + _primaryRowTop(branch);
    if (top + submenuHeight > maxBottom) {
      top = maxBottom - submenuHeight;
    }
    if (top < minTop) {
      top = minTop;
    }
    return top;
  }

  @override
  void initState() {
    super.initState();
    _config = widget.runtimeConfig;
    _coreKind = widget.coreKind;
  }

  Future<void> _persist(
    MainAgentModelOverride? nextOverride, {
    bool dismiss = false,
  }) async {
    if (!widget.canEdit || _savingModel) return;
    final previous = _config;
    final next = nextOverride == null
        ? _config.copyWith(clearMainAgentModelOverride: true)
        : _config.copyWith(mainAgentModelOverride: nextOverride);
    final preference = ComposerModelPreferenceScope(
      desktopId: ref.read(selectedDesktopIdProvider) ?? '',
      workspacePath: widget.workspacePath,
      coreKind: _coreKind ?? 'claude',
    );
    final messenger = ScaffoldMessenger.of(context);
    final errorMessage = context.l10n.errorRpcFailed;
    setState(() {
      _savingModel = true;
      _config = next;
    });
    var applied = next;
    final saved = await persistRuntimeConfig(
      ref,
      threadId: widget.threadId,
      config: next,
      onChanged: (config) {
        applied = config;
        widget.onChanged(config);
      },
    );
    if (!saved) {
      messenger.showSnackBar(SnackBar(content: Text(errorMessage)));
      if (mounted) {
        setState(() {
          _config = previous;
          _savingModel = false;
        });
      }
      return;
    }
    try {
      await preference.remember(applied);
    } catch (error) {
      messenger.showSnackBar(SnackBar(content: Text(error.toString())));
    }
    if (!mounted) return;
    setState(() {
      _config = applied;
      _savingModel = false;
    });
    if (dismiss) widget.onDismiss();
  }

  void _selectCoreKind(String value) {
    if (!widget.canEdit) return;
    if (_coreKind == value) return;
    setState(() => _coreKind = value);
    widget.onCoreKindChanged?.call(value);
    widget.onDismiss();
  }

  void _selectCursorModel(String? modelId) {
    if (!widget.canEdit) return;
    final next = modelId == null
        ? _config.copyWith(clearCursorModelId: true)
        : _config.copyWith(cursorModelId: modelId);
    _persistConfig(next);
    widget.onDismiss();
  }

  /// Cursor ACP model picker: the unified provider (vendor) → model cascade
  /// with a search box, so the catalogue is never a flat list.
  Widget _buildCursorModelCascade({
    required AppLocalizations l10n,
    required List<CursorModelOption> models,
  }) {
    final selectedModelId = _config.cursorModelId?.trim();
    final isDefault = selectedModelId == null || selectedModelId.isEmpty;
    return EcoModelCascadeList(
      layout: EcoModelCascadeLayout.split,
      height: _cascadeBodyHeight,
      flexibleBody: true,
      options: [
        for (final model in models)
          ModelCascadeEntry(
            key: model.id,
            providerKey: classifyAcpModelVendor(model).toString(),
            providerName: acpModelVendorLabel(l10n, classifyAcpModelVendor(model)),
            modelId: model.id,
            title: model.displayName,
            subtitle: model.id,
            badge: model.current ? l10n.composerAcpModelCurrent : null,
          ),
      ],
      selectedKey: isDefault ? null : selectedModelId,
      onSelected: (key) {
        HapticFeedback.selectionClick();
        _selectCursorModel(key);
      },
      leading: [
        EcoSheetOptionTile(
          title: l10n.composerAcpModelDefault,
          selected: isDefault,
          onTap: () {
            HapticFeedback.selectionClick();
            _selectCursorModel(null);
          },
        ),
        const EcoGroupedDivider(indent: 12),
      ],
    );
  }

  /// Auxiliary / vision model picker: the unified provider → model cascade
  /// with a search box, so the catalogue is never a flat list.
  Widget _buildAuxVisionCascade({
    required AppLocalizations l10n,
    required AsyncValue<List<CommitModelOptionView>>? auxOptions,
    required bool isVision,
    bool isApproval = false,
  }) {
    final selectedCandidateId = isApproval
        ? _config.approvalModel?.candidateModelId
        : isVision
        ? _config.visionModel?.candidateModelId
        : _config.auxiliaryModel?.candidateModelId;
    final isNotConfigured = isApproval
        ? _config.approvalModel == null
        : isVision
        ? _config.visionModel == null
        : _config.auxiliaryModel == null;
    final statusStyle = Theme.of(context)
        .textTheme
        .bodyMedium
        ?.copyWith(color: ecoColors(context).textMuted);
    final body = auxOptions == null
        ? Padding(
            padding: const EdgeInsets.symmetric(vertical: 14),
            child: Text(l10n.commonUnavailable,
                textAlign: TextAlign.center, style: statusStyle),
          )
        : auxOptions.when(
            data: (items) => EcoModelCascadeList(
              layout: EcoModelCascadeLayout.split,
              height: _cascadeBodyHeight,
              flexibleBody: true,
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
              selectedKey: selectedCandidateId,
              onSelected: (key) {
                for (final option in items) {
                  if (option.candidateModelId == key) {
                    HapticFeedback.selectionClick();
                    if (isApproval) {
                      _selectApproval(option);
                    } else if (isVision) {
                      _selectVision(option);
                    } else {
                      _selectAuxiliary(option);
                    }
                    break;
                  }
                }
              },
            ),
            loading: () => Padding(
              padding: const EdgeInsets.symmetric(vertical: 14),
              child: Text(l10n.commonLoading,
                  textAlign: TextAlign.center, style: statusStyle),
            ),
            error: (_, _) => Padding(
              padding: const EdgeInsets.symmetric(vertical: 14),
              child: Text(l10n.composerModelLoadFailed,
                  textAlign: TextAlign.center, style: statusStyle),
            ),
          );
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        EcoSheetOptionTile(
          title: l10n.composerNone,
          selected: isNotConfigured,
          onTap: () {
            HapticFeedback.selectionClick();
            if (isApproval) {
              _selectApproval(null);
            } else if (isVision) {
              _selectVision(null);
            } else {
              _selectAuxiliary(null);
            }
          },
        ),
        const EcoGroupedDivider(indent: 12),
        // Fill the rest of the panel rather than demanding a fixed 280 body:
        // a short surface (or the 48% viewport cap) hands down less here.
        Flexible(child: body),
      ],
    );
  }

  void _persistConfig(ThreadRuntimeConfigInput next) {
    setState(() => _config = next);
    persistRuntimeConfig(
      ref,
      threadId: widget.threadId,
      config: next,
      onChanged: widget.onChanged,
    );
  }

  void _applyOrchestrationPatch({
    required ModelSettingsSnapshot? settings,
    required List<McpServerConfigView> mcpServers,
    Map<String, bool>? rememberedMcp,
    String? mainAgentConfigId,
    MainAgentPromptSelection? mainPrompt,
    SubagentSelection? subagents,
  }) {
    if (!widget.canEdit) return;
    final nextConfig = applyOrchestrationSelectionPatch(
      settings: settings,
      runtimeConfig: _config,
      servers: mcpServers,
      remembered: rememberedMcp,
      mainAgentConfigId: mainAgentConfigId,
      mainPrompt: mainPrompt,
      subagents: subagents,
    );
    _persistConfig(nextConfig);
    final selection = nextConfig.orchestrationSelection;
    if (widget.threadId.isEmpty &&
        widget.workspacePath.trim().isNotEmpty &&
        hasCompleteOrchestrationSelection(selection)) {
      unawaited(
        persistProjectOrchestrationSelection(
          ref,
          workspacePath: widget.workspacePath,
          selection: selection!,
        ),
      );
    }
  }

  void _selectAuxiliary(CommitModelOptionView? option) {
    if (!widget.canEditStatelessModels) return;
    final selection = option == null
        ? null
        : AuxiliaryModelSelection(
            providerId: option.providerId,
            modelId: option.modelId,
            candidateModelId: option.candidateModelId,
          );
    var next = option == null
        ? _config.copyWith(clearAuxiliaryModel: true)
        : _config.copyWith(auxiliaryModel: selection);
    _persistConfig(next);
    persistAuxiliaryModelWorkflowDefault(
      ref,
      selection: selection,
    ).catchError((_) {});
  }

  void _selectApproval(CommitModelOptionView? option) {
    if (!widget.canEditStatelessModels) return;
    final selection = option == null
        ? null
        : ApprovalModelSelection(
            providerId: option.providerId,
            modelId: option.modelId,
            candidateModelId: option.candidateModelId,
          );
    var next = option == null
        ? _config.copyWith(clearApprovalModel: true)
        : _config.copyWith(approvalModel: selection);
    next = downgradeApprovalDependentFeatures(next);
    _persistConfig(next);
    persistApprovalModelWorkflowDefault(ref, selection: selection).catchError((
      Object error,
    ) {
      if (mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text(error.toString())));
      }
    });
  }

  void _selectVision(CommitModelOptionView? option) {
    if (!widget.canEditStatelessModels) return;
    final selection = option == null
        ? null
        : VisionModelSelection(
            providerId: option.providerId,
            modelId: option.modelId,
            candidateModelId: option.candidateModelId,
          );
    final next = option == null
        ? _config.copyWith(clearVisionModel: true)
        : _config.copyWith(visionModel: selection);
    _persistConfig(next);
    persistVisionModelWorkflowDefault(
      ref,
      selection: selection,
    ).catchError((_) {});
  }

  ({String label, String? badge}) _coreKindDisplay(AppLocalizations l10n) {
    for (final option in composerCoreKindOptions) {
      if (option.value == _coreKind) {
        return (label: option.label, badge: option.badge);
      }
    }
    return (label: l10n.commonUnavailable, badge: null);
  }

  String _modelSelectionLabel(AppLocalizations l10n, {required bool vision}) {
    if (vision) {
      final selection = _config.visionModel;
      if (selection == null) return l10n.composerNone;
      return composerModelDisplayName(selection.modelId);
    }
    final selection = _config.auxiliaryModel;
    if (selection == null) return l10n.composerNone;
    return composerModelDisplayName(selection.modelId);
  }

  void _setBranch(_CascadeBranch? branch) {
    setState(() => _branch = branch);
  }

  void _toggleAdvanced() {
    setState(() {
      _advancedExpanded = !_advancedExpanded;
      if (!_advancedExpanded &&
          (_branch == _CascadeBranch.prompt ||
              _branch == _CascadeBranch.arrangement ||
              _branch == _CascadeBranch.agent ||
              _branch == _CascadeBranch.auxiliary ||
              _branch == _CascadeBranch.approval ||
              _branch == _CascadeBranch.vision)) {
        _branch = null;
      }
    });
  }

  double _safeClamp(double value, double min, double max) {
    if (max < min) return min;
    return value.clamp(min, max);
  }

  /// Re-measure the anchor every frame instead of trusting the snapshot taken
  /// when the overlay opened. The composer is lifted by the keyboard inset
  /// (`resizeToAvoidBottomInset: false` + manual viewInsets padding), so a
  /// stale rect would leave the cascade floating behind the keyboard.
  Rect _liveAnchorRect() {
    final box =
        widget.anchorKey.currentContext?.findRenderObject() as RenderBox?;
    if (box == null || !box.hasSize) return widget.anchorRect;
    final overlayBox =
        Overlay.of(context).context.findRenderObject() as RenderBox?;
    if (overlayBox == null || !overlayBox.hasSize) return widget.anchorRect;
    final origin = box.localToGlobal(Offset.zero, ancestor: overlayBox);
    return origin & box.size;
  }

  OrchestrationModelRef get _activeTemplateModel {
    return _config.resolvedOrchestrationSnapshot?.mainAgent.modelRef ??
        widget.templateModel ??
        const OrchestrationModelRef(providerId: '', modelId: '', thinkingEffort: null);
  }

  ModelProviderView _resolveProvider(ModelSettingsSnapshot? settings) {
    final providerId = _activeTemplateModel.providerId;
    final fallback = widget.provider;
    if (providerId.isEmpty) return fallback!;
    if (settings != null) {
      for (final provider in settings.providers) {
        if (provider.id == providerId) return provider;
      }
    }
    if (fallback != null && fallback.id == providerId) return fallback;
    return fallback!;
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final eco = ecoColors(context);
    final media = MediaQuery.of(context);
    final viewPadding = media.viewPadding;
    // Prefer live overlay size — captured size can be wrong before layout.
    final overlaySize = media.size;
    // The anchor follows the composer as the keyboard inset animates; the
    // keyboard itself is part of the overlay occlusion, so the cascade must
    // stay above it.
    final anchor = _liveAnchorRect();
    final branch = _branch;
    final showSubmenu = branch != null;
    final isAcp = widget.coreKind == 'acp';

    final cursorModels = ref.watch(cursorModelsProvider).valueOrNull ?? const [];
    final cursorModelName = isAcp
        ? resolveCursorModelDisplayName(cursorModels, _config.cursorModelId)
        : '';

    final modelSettingsAsync = ref.watch(modelSettingsProvider);
    final modelSettings = modelSettingsAsync.valueOrNull;
    final workflow = ref.watch(workflowSettingsProvider).valueOrNull;
    final mcpServers =
        ref.watch(mcpSettingsProvider).valueOrNull?.servers ?? const [];
    final provider = isAcp ? null : _resolveProvider(modelSettings);
    final templateModel = isAcp ? null : _activeTemplateModel;

    final candidates = provider != null
        ? ref.watch(candidateModelsProvider(provider.id))
        : const AsyncValue<List<CandidateModelView>>.data([]);
    final options = provider != null
        ? buildComposerTemporaryModelOptions(
            provider: provider,
            templateModel: templateModel!,
            candidates: candidates.valueOrNull ?? const [],
          )
        : const <ComposerTemporaryModelOption>[];
    final modelOverride = _config.mainAgentModelOverride;
    final currentModel = provider != null
        ? resolveComposerTemporaryModel(
            options: options,
            override: modelOverride,
            templateModel: templateModel!,
          )
        : const ComposerTemporaryModelOption(providerId: '', modelId: '');
    final currentEffort = provider != null
        ? (composerTemporaryModelEffort(modelOverride, templateModel!) ?? 'off')
        : 'off';
    final effortLabel = composerThinkingEffortLabel(currentEffort, l10n);
    final modelName = composerModelDisplayName(currentModel.modelId);
    final reasoningUnavailable = provider != null && currentModel.supportsReasoning == false;
    final templateSelected = provider != null
        ? composerTemporaryModelMatchesTemplate(currentModel, templateModel!)
        : false;

    final mainAgentConfigId =
        _config.orchestrationSelection?.mainAgentConfigId.trim() ?? '';
    final auxOptionsAsync = isAcp
        ? ref.watch(auxiliaryModelOptionsProvider(''))
        : (mainAgentConfigId.isEmpty
            ? null
            : ref.watch(auxiliaryModelOptionsProvider(mainAgentConfigId)));

    final orchestrationLabels = _orchestrationPrimaryLabels(
      l10n: l10n,
      settings: modelSettings,
    );

    final availableWidth =
        overlaySize.width - viewPadding.left - viewPadding.right - _edgePad * 2;
    final cascadeSubmenu = showSubmenu &&
        (branch == _CascadeBranch.cursorModel ||
            branch == _CascadeBranch.auxiliary ||
            branch == _CascadeBranch.approval ||
            branch == _CascadeBranch.vision);
    final idealSubmenuWidth =
        cascadeSubmenu ? _cascadeSubmenuWidth : _submenuWidthIdeal;
    final sideBySide =
        showSubmenu && availableWidth >= _primaryWidth + _panelGap + 160;
    final submenuWidth = sideBySide
        ? math.min(
            idealSubmenuWidth,
            availableWidth - _primaryWidth - _panelGap,
          )
        : math.min(idealSubmenuWidth, availableWidth);
    final cascadeWidth = !showSubmenu
        ? _primaryWidth
        : sideBySide
        ? _primaryWidth + _panelGap + submenuWidth
        : math.max(_primaryWidth, submenuWidth);

    final submenuItems = showSubmenu
        ? _buildSubmenuItems(
            l10n: l10n,
            options: options,
            modelOverride: modelOverride,
            currentModel: currentModel,
            currentEffort: currentEffort,
            templateModel: templateModel ?? const OrchestrationModelRef(providerId: '', modelId: '', thinkingEffort: null),
            templateSelected: templateSelected,
            reasoningUnavailable: reasoningUnavailable,
            candidatesLoading: candidates.isLoading,
            candidatesError: candidates.hasError,
            settings: modelSettings,
            settingsLoading: modelSettingsAsync.isLoading,
            settingsError: modelSettingsAsync.hasError,
            mcpServers: mcpServers,
            rememberedMcp: workflow?.mcpServersEnabled,
          )
        : const <_SubmenuItem>[];

    final minLeft =
        math.max(viewPadding.left, media.viewInsets.left) + _edgePad;
    final maxBottom =
        overlaySize.height -
        math.max(viewPadding.bottom, media.viewInsets.bottom) -
        _edgePad;
    final minTop = math.max(viewPadding.top, media.viewInsets.top) + _edgePad;
    final maxSubmenuHeight = math.max(0.0, maxBottom - minTop);

    final auxVisionCascade =
        branch == _CascadeBranch.auxiliary ||
                branch == _CascadeBranch.approval ||
                branch == _CascadeBranch.vision
            ? _buildAuxVisionCascade(
                l10n: l10n,
                auxOptions: branch == _CascadeBranch.approval
                    ? ref.watch(approvalModelOptionsProvider(mainAgentConfigId))
                    : auxOptionsAsync,
                isVision: branch == _CascadeBranch.vision,
                isApproval: branch == _CascadeBranch.approval,
              )
            : null;

    final cursorModelCascade = branch == _CascadeBranch.cursorModel
        ? _buildCursorModelCascade(l10n: l10n, models: cursorModels)
        : null;

    final customCascade = cursorModelCascade ?? auxVisionCascade;

    final submenuContentHeight = showSubmenu
        ? customCascade != null
            // Preferred height for a model cascade: search box + rows + a full
            // catalogue body. Cascades are built with `flexibleBody`, so a
            // smaller viewport only shrinks the list — it never overflows.
            ? _cursorCascadeHeight
            : submenuItems.fold<double>(8, (sum, item) => sum + item.rowHeight)
        : 0.0;
    final submenuHeight = showSubmenu
        ? math.min(
            math.min(overlaySize.height * 0.48, maxSubmenuHeight),
            submenuContentHeight,
          )
        : 0.0;

    // Keep the primary panel fixed; opening a submenu must not move it.
    final primaryMaxTop = maxBottom - _primaryHeight;
    var primaryTop = anchor.top - _primaryHeight - 10;
    if (primaryTop < minTop) {
      primaryTop = anchor.bottom + 10;
    }
    primaryTop = _safeClamp(primaryTop, minTop, primaryMaxTop);

    final maxLeft =
        overlaySize.width - cascadeWidth - viewPadding.right - _edgePad;
    final left = _safeClamp(anchor.right - cascadeWidth, minLeft, maxLeft);

    // Submenu vertical rule:
    // 1) Align with the tapped primary row.
    // 2) If it would overflow the bottom, push it up.
    // 3) Never go above the safe top inset.
    final submenuTop = branch == null
        ? primaryTop
        : _submenuTopForBranch(
            branch: branch,
            primaryTop: primaryTop,
            submenuHeight: submenuHeight,
            minTop: minTop,
            maxBottom: maxBottom,
          );

    // Narrow screens: keep primary fixed and park the submenu above when
    // possible; otherwise place it below and push up if needed.
    var stackedSubmenuTop = submenuTop;
    if (showSubmenu && !sideBySide) {
      final aboveTop = primaryTop - _panelGap - submenuHeight;
      if (aboveTop >= minTop) {
        stackedSubmenuTop = aboveTop;
      } else {
        stackedSubmenuTop = primaryTop + _primaryHeight + _panelGap;
        if (stackedSubmenuTop + submenuHeight > maxBottom) {
          stackedSubmenuTop = maxBottom - submenuHeight;
        }
        if (stackedSubmenuTop < minTop) {
          stackedSubmenuTop = minTop;
        }
      }
    }

    final primaryPanel = SizedBox(
      width: _primaryWidth,
      child: _buildPrimaryPanel(
        l10n: l10n,
        eco: eco,
        isAcp: isAcp,
        modelName: modelName,
        effortLabel: effortLabel,
        mainAgentLabel: orchestrationLabels.mainAgent,
        promptLabel: orchestrationLabels.prompt,
        arrangementLabel: orchestrationLabels.arrangement,
        canPickOrchestration: modelSettings != null,
        settingsLoading: modelSettingsAsync.isLoading,
        cursorModelName: cursorModelName,
      ),
    );

    final submenuPanel = showSubmenu
        ? SizedBox(
            width: sideBySide
                ? submenuWidth
                : math.min(_submenuWidthIdeal, availableWidth),
            child: customCascade != null
                ? _GlassPanel(
                    radius: _radius,
                    child: Padding(
                      padding: const EdgeInsets.symmetric(
                        horizontal: 4,
                        vertical: 8,
                      ),
                      child: SizedBox(
                        height: submenuHeight,
                        child: customCascade,
                      ),
                    ),
                  )
                : _buildSubmenuPanel(
                    items: submenuItems,
                    maxHeight: submenuHeight,
                  ),
          )
        : null;

    return Material(
      type: MaterialType.transparency,
      child: Stack(
        children: [
          Positioned.fill(
            child: GestureDetector(
              behavior: HitTestBehavior.opaque,
              onTap: widget.onDismiss,
              child: ColoredBox(color: eco.shadowScrim.withValues(alpha: 0.10)),
            ),
          ),
          Positioned(
            left: left,
            top: primaryTop,
            width: _primaryWidth,
            child: primaryPanel,
          ),
          if (showSubmenu && sideBySide)
            Positioned(
              left: left + _primaryWidth + _panelGap,
              top: submenuTop,
              width: submenuWidth,
              child: submenuPanel!,
            ),
          if (showSubmenu && !sideBySide)
            Positioned(
              left: left,
              top: stackedSubmenuTop,
              width: math.min(_submenuWidthIdeal, availableWidth),
              child: submenuPanel!,
            ),
        ],
      ),
    );
  }

  ({String mainAgent, String prompt, String arrangement})
  _orchestrationPrimaryLabels({
    required AppLocalizations l10n,
    required ModelSettingsSnapshot? settings,
  }) {
    if (settings == null) {
      return (
        mainAgent: l10n.commonUnavailable,
        prompt: l10n.commonUnavailable,
        arrangement: l10n.commonUnavailable,
      );
    }

    final mainAgentConfigs = settings.mainAgentConfigs;
    final mainAgentPrompts = settings.mainAgentPrompts
        .where((prompt) => prompt.mode == 'custom_append')
        .toList(growable: false);
    final subagentOrchestrations = settings.subagentOrchestrations;
    final selection =
        _config.orchestrationSelection ?? emptyOrchestrationSelection();
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

    final selectedMainAgent = mainAgentConfigs
        .where((config) => config.id == mainAgentConfigId)
        .firstOrNull;
    final selectedMainAgentLabel = selectedMainAgent == null
        ? l10n.commonNotConfigured
        : selectedMainAgent.name;

    final selectedPromptLabel = mainPromptValue.isEmpty
        ? l10n.commonNotConfigured
        : mainPromptValue == builtinMainPromptValue
        ? l10n.composerNone
        : mainAgentPrompts
                  .where((prompt) => prompt.id == mainPromptValue)
                  .firstOrNull
                  ?.name ??
              l10n.commonNotConfigured;

    final selectedSubagent = subagentOrchestrations
        .where((orchestration) => orchestration.id == subagentOrchestrationId)
        .firstOrNull;
    final selectedSubagentLabel = subagentOrchestrationId.isEmpty
        ? l10n.commonNotConfigured
        : subagentOrchestrationId == subagentsNoneValue
        ? l10n.composerNoSubagentOrchestration
        : selectedSubagent?.name ?? l10n.commonNotConfigured;

    return (
      mainAgent: selectedMainAgentLabel,
      prompt: selectedPromptLabel,
      arrangement: selectedSubagentLabel,
    );
  }

  Widget _buildPrimaryPanel({
    required AppLocalizations l10n,
    required EcoColors eco,
    required bool isAcp,
    required String modelName,
    required String effortLabel,
    required String mainAgentLabel,
    required String promptLabel,
    required String arrangementLabel,
    required bool canPickOrchestration,
    required bool settingsLoading,
    required String cursorModelName,
  }) {
    final mainAgentConfigId =
        _config.orchestrationSelection?.mainAgentConfigId.trim() ?? '';
    // Auxiliary / approval / vision requests are stateless single-shot calls, so those
    // three pickers stay switchable while a run locks the session-bound rows.
    final canPickAuxVision =
        (mainAgentConfigId.isNotEmpty || isAcp) && widget.canEditStatelessModels;
    final canEditSession = widget.canEdit;
    final orchestrationEnabled =
        canPickOrchestration && !settingsLoading && canEditSession;
    final coreKindDisplay = _coreKindDisplay(l10n);

    if (isAcp) {
      return _GlassPanel(
        radius: _radius,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            _PrimaryRow(
              label: l10n.composerModel,
              value: cursorModelName,
              selected: _branch == _CascadeBranch.cursorModel,
              enabled: canEditSession,
              onTap: () {
                HapticFeedback.selectionClick();
                _setBranch(_CascadeBranch.cursorModel);
              },
            ),
            _Hairline(eco: eco),
            _PrimaryRow(
              label: l10n.composerCoreKind,
              value: coreKindDisplay.label,
              valueBadge: coreKindDisplay.badge,
              selected: _branch == _CascadeBranch.agent,
              enabled: canEditSession,
              onTap: () {
                HapticFeedback.selectionClick();
                _setBranch(_CascadeBranch.agent);
              },
            ),
            _Hairline(eco: eco),
            _PrimaryRow(
              label: l10n.composerAux,
              value: _modelSelectionLabel(l10n, vision: false),
              selected: _branch == _CascadeBranch.auxiliary,
              enabled: canPickAuxVision,
              onTap: () {
                if (!canPickAuxVision) return;
                HapticFeedback.selectionClick();
                _setBranch(_CascadeBranch.auxiliary);
              },
            ),
            _Hairline(eco: eco),
            _PrimaryRow(
              label: l10n.composerApprovalModel,
              value: _config.approvalModel == null
                  ? l10n.composerNone
                  : composerModelDisplayName(_config.approvalModel!.modelId),
              selected: _branch == _CascadeBranch.approval,
              enabled: widget.canEditStatelessModels,
              onTap: () {
                HapticFeedback.selectionClick();
                _setBranch(_CascadeBranch.approval);
              },
            ),
            _Hairline(eco: eco),
            _PrimaryRow(
              label: l10n.composerVision,
              value: _modelSelectionLabel(l10n, vision: true),
              selected: _branch == _CascadeBranch.vision,
              enabled: canPickAuxVision,
              onTap: () {
                if (!canPickAuxVision) return;
                HapticFeedback.selectionClick();
                _setBranch(_CascadeBranch.vision);
              },
            ),
          ],
        ),
      );
    }

    return _GlassPanel(
      radius: _radius,
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          _PrimaryRow(
            label: l10n.composerMainAgent,
            value: settingsLoading ? l10n.commonLoading : mainAgentLabel,
            selected: _branch == _CascadeBranch.mainAgent,
            enabled: orchestrationEnabled,
            onTap: () {
              if (!orchestrationEnabled) return;
              HapticFeedback.selectionClick();
              _setBranch(_CascadeBranch.mainAgent);
            },
          ),
          _Hairline(eco: eco),
          _PrimaryRow(
            label: l10n.composerModel,
            value: modelName,
            selected: _branch == _CascadeBranch.model,
            enabled: canEditSession,
            onTap: () {
              HapticFeedback.selectionClick();
              _setBranch(_CascadeBranch.model);
            },
          ),
          _Hairline(eco: eco),
          _PrimaryRow(
            label: l10n.composerReasoningIntensity,
            value: effortLabel,
            selected: _branch == _CascadeBranch.effort,
            enabled: canEditSession,
            onTap: () {
              HapticFeedback.selectionClick();
              _setBranch(_CascadeBranch.effort);
            },
          ),
          _Hairline(eco: eco),
          EcoPressable(
            scale: 0.98,
            onTap: () {
              HapticFeedback.selectionClick();
              _toggleAdvanced();
            },
            child: SizedBox(
              height: _rowHeight,
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 14),
                child: Row(
                  children: [
                    Expanded(
                      child: Text(
                        l10n.composerAdvanced,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          fontSize: 15,
                          fontWeight: FontWeight.w400,
                          letterSpacing: -0.2,
                          color: eco.textMuted,
                        ),
                      ),
                    ),
                    Icon(
                      _advancedExpanded
                          ? EcoIcons.expandUp
                          : EcoIcons.expandDown,
                      size: 14,
                      color: eco.textMuted,
                    ),
                  ],
                ),
              ),
            ),
          ),
          if (_advancedExpanded) ...[
            _Hairline(eco: eco),
            _PrimaryRow(
              label: l10n.composerAgent,
              value: coreKindDisplay.label,
              valueBadge: coreKindDisplay.badge,
              selected: _branch == _CascadeBranch.agent,
              enabled: _coreKind != null && canEditSession,
              onTap: () {
                if (_coreKind == null) return;
                HapticFeedback.selectionClick();
                _setBranch(_CascadeBranch.agent);
              },
            ),
            _Hairline(eco: eco),
            _PrimaryRow(
              label: l10n.composerMainAgentPrompt,
              value: settingsLoading ? l10n.commonLoading : promptLabel,
              selected: _branch == _CascadeBranch.prompt,
              enabled: orchestrationEnabled,
              onTap: () {
                if (!orchestrationEnabled) return;
                HapticFeedback.selectionClick();
                _setBranch(_CascadeBranch.prompt);
              },
            ),
            _Hairline(eco: eco),
            _PrimaryRow(
              label: l10n.composerSubagentOrchestration,
              value: settingsLoading ? l10n.commonLoading : arrangementLabel,
              selected: _branch == _CascadeBranch.arrangement,
              enabled: orchestrationEnabled,
              onTap: () {
                if (!orchestrationEnabled) return;
                HapticFeedback.selectionClick();
                _setBranch(_CascadeBranch.arrangement);
              },
            ),
            _Hairline(eco: eco),
            _PrimaryRow(
              label: l10n.composerAux,
              value: _modelSelectionLabel(l10n, vision: false),
              selected: _branch == _CascadeBranch.auxiliary,
              enabled: canPickAuxVision,
              onTap: () {
                if (!canPickAuxVision) return;
                HapticFeedback.selectionClick();
                _setBranch(_CascadeBranch.auxiliary);
              },
            ),
            _Hairline(eco: eco),
            _PrimaryRow(
              label: l10n.composerApprovalModel,
              value: _config.approvalModel == null
                  ? l10n.composerNone
                  : composerModelDisplayName(_config.approvalModel!.modelId),
              selected: _branch == _CascadeBranch.approval,
              enabled: widget.canEditStatelessModels,
              onTap: () {
                HapticFeedback.selectionClick();
                _setBranch(_CascadeBranch.approval);
              },
            ),
            _Hairline(eco: eco),
            _PrimaryRow(
              label: l10n.composerVision,
              value: _modelSelectionLabel(l10n, vision: true),
              selected: _branch == _CascadeBranch.vision,
              enabled: canPickAuxVision,
              onTap: () {
                if (!canPickAuxVision) return;
                HapticFeedback.selectionClick();
                _setBranch(_CascadeBranch.vision);
              },
            ),
          ],
        ],
      ),
    );
  }

  Widget _buildSubmenuPanel({
    required List<_SubmenuItem> items,
    required double maxHeight,
  }) {
    return _GlassPanel(
      radius: _radius,
      child: _SubmenuScrollList(
        key: ValueKey(_branch),
        items: items,
        maxHeight: maxHeight,
      ),
    );
  }

  List<_SubmenuItem> _buildSubmenuItems({
    required AppLocalizations l10n,
    required List<ComposerTemporaryModelOption> options,
    required MainAgentModelOverride? modelOverride,
    required ComposerTemporaryModelOption currentModel,
    required String currentEffort,
    required OrchestrationModelRef templateModel,
    required bool templateSelected,
    required bool reasoningUnavailable,
    required bool candidatesLoading,
    required bool candidatesError,
    required ModelSettingsSnapshot? settings,
    required bool settingsLoading,
    required bool settingsError,
    required List<McpServerConfigView> mcpServers,
    required Map<String, bool>? rememberedMcp,
  }) {
    if (_branch == _CascadeBranch.cursorModel) {
      // Rendered as a custom provider → model cascade panel (search + vendor
      // groups) in the submenu slot — never a flat model list.
      return const [];
    }

    if (_branch == _CascadeBranch.mainAgent ||
        _branch == _CascadeBranch.prompt ||
        _branch == _CascadeBranch.arrangement) {
      return _buildOrchestrationSubmenuItems(
        l10n: l10n,
        settings: settings,
        settingsLoading: settingsLoading,
        settingsError: settingsError,
        mcpServers: mcpServers,
        rememberedMcp: rememberedMcp,
      );
    }

    if (_branch == _CascadeBranch.model) {
      return [
        _SubmenuItem(
          label: composerModelDisplayName(templateModel.modelId),
          selected: templateSelected,
          onTap: () {
            HapticFeedback.selectionClick();
            _persist(
              buildComposerTemporaryModelOverride(
                model: ComposerTemporaryModelOption(
                  providerId: templateModel.providerId,
                  modelId: templateModel.modelId,
                  candidateModelId: templateModel.candidateModelId,
                ),
                thinkingEffort: currentEffort,
                templateModel: templateModel,
              ),
              dismiss: true,
            );
          },
        ),
        if (candidatesLoading)
          _SubmenuItem(
            label: l10n.commonLoading,
            selected: false,
            enabled: false,
            onTap: () {},
          )
        else if (candidatesError)
          _SubmenuItem(
            label: l10n.composerModelLoadFailed,
            selected: false,
            enabled: false,
            onTap: () {},
          )
        else
          for (final option in options.where(
            (o) => !composerTemporaryModelMatchesTemplate(o, templateModel),
          ))
            _SubmenuItem(
              label: option.displayName?.isNotEmpty == true
                  ? option.displayName!
                  : composerModelDisplayName(option.modelId),
              selected: composerTemporaryModelSelected(modelOverride, option),
              onTap: () {
                HapticFeedback.selectionClick();
                _persist(
                  buildComposerTemporaryModelOverride(
                    model: option,
                    thinkingEffort: option.supportsReasoning == false
                        ? 'off'
                        : currentEffort,
                    templateModel: templateModel,
                  ),
                  dismiss: true,
                );
              },
            ),
      ];
    }

    if (_branch == _CascadeBranch.effort) {
      return [
        for (final option in composerThinkingEffortOptions(l10n))
          _SubmenuItem(
            label: option.label,
            selected: currentEffort == option.value,
            enabled: !reasoningUnavailable || option.value == 'off',
            onTap: () {
              if (reasoningUnavailable && option.value != 'off') return;
              HapticFeedback.selectionClick();
              _persist(
                buildComposerTemporaryModelOverride(
                  model: currentModel,
                  thinkingEffort: option.value,
                  templateModel: templateModel,
                ),
              );
            },
          ),
      ];
    }

    if (_branch == _CascadeBranch.agent) {
      return [
        for (final option in composerCoreKindOptions)
          _SubmenuItem(
            label: option.label,
            badge: option.badge,
            selected: _coreKind == option.value,
            enabled: widget.onCoreKindChanged != null,
            onTap: () {
              if (widget.onCoreKindChanged == null) return;
              HapticFeedback.selectionClick();
              _selectCoreKind(option.value);
            },
          ),
      ];
    }

    // auxiliary / vision fall through here: rendered as a custom provider →
    // model cascade panel (search + grouped) in the submenu slot — never a
    // flat model list.
    return const [];
  }

  List<_SubmenuItem> _buildOrchestrationSubmenuItems({
    required AppLocalizations l10n,
    required ModelSettingsSnapshot? settings,
    required bool settingsLoading,
    required bool settingsError,
    required List<McpServerConfigView> mcpServers,
    required Map<String, bool>? rememberedMcp,
  }) {
    if (settingsLoading) {
      return [
        _SubmenuItem(
          label: l10n.commonLoading,
          selected: false,
          enabled: false,
          onTap: () {},
        ),
      ];
    }
    if (settingsError || settings == null) {
      return [
        _SubmenuItem(
          label: settingsError
              ? l10n.composerModelLoadFailed
              : l10n.commonUnavailable,
          selected: false,
          enabled: false,
          onTap: () {},
        ),
      ];
    }

    final selection =
        _config.orchestrationSelection ?? emptyOrchestrationSelection();

    if (_branch == _CascadeBranch.mainAgent) {
      final configs = settings.mainAgentConfigs;
      if (configs.isEmpty) {
        return [
          _SubmenuItem(
            label: l10n.commonNotConfigured,
            selected: false,
            enabled: false,
            onTap: () {},
          ),
        ];
      }
      return [
        for (final config in configs)
          _SubmenuItem(
            label: config.name,
            subtitle: shortenModelId(config.modelRef.modelId),
            selected: selection.mainAgentConfigId == config.id,
            onTap: () {
              HapticFeedback.selectionClick();
              _applyOrchestrationPatch(
                settings: settings,
                mcpServers: mcpServers,
                rememberedMcp: rememberedMcp,
                mainAgentConfigId: config.id,
              );
            },
          ),
      ];
    }

    if (_branch == _CascadeBranch.prompt) {
      final prompts = settings.mainAgentPrompts
          .where((prompt) => prompt.mode == 'custom_append')
          .toList(growable: false);
      final selectedValue = mainPromptSelectionValue(selection.mainPrompt);
      return [
        _SubmenuItem(
          label: l10n.composerNone,
          selected: selectedValue == builtinMainPromptValue,
          onTap: () {
            HapticFeedback.selectionClick();
            _applyOrchestrationPatch(
              settings: settings,
              mcpServers: mcpServers,
              rememberedMcp: rememberedMcp,
              mainPrompt: const BuiltinMainAgentPromptSelection(),
            );
          },
        ),
        for (final prompt in prompts)
          _SubmenuItem(
            label: prompt.name,
            selected: selectedValue == prompt.id,
            onTap: () {
              HapticFeedback.selectionClick();
              _applyOrchestrationPatch(
                settings: settings,
                mcpServers: mcpServers,
                rememberedMcp: rememberedMcp,
                mainPrompt: CustomAppendMainAgentPromptSelection(
                  promptId: prompt.id,
                ),
              );
            },
          ),
      ];
    }

    final orchestrations = settings.subagentOrchestrations;
    final selectedValue = subagentSelectionValue(selection.subagents);
    return [
      _SubmenuItem(
        label: l10n.composerNoSubagentOrchestration,
        selected: selectedValue == subagentsNoneValue,
        onTap: () {
          HapticFeedback.selectionClick();
          _applyOrchestrationPatch(
            settings: settings,
            mcpServers: mcpServers,
            rememberedMcp: rememberedMcp,
            subagents: const NoneSubagentSelection(),
          );
        },
      ),
      for (final orchestration in orchestrations)
        _SubmenuItem(
          label: orchestration.name,
          subtitle: l10n.composerAgentsCount(orchestration.agents.length),
          selected: selectedValue == orchestration.id,
          onTap: () {
            HapticFeedback.selectionClick();
            _applyOrchestrationPatch(
              settings: settings,
              mcpServers: mcpServers,
              rememberedMcp: rememberedMcp,
              subagents: OrchestrationSubagentSelection(
                orchestrationId: orchestration.id,
              ),
            );
          },
        ),
    ];
  }
}

class _SubmenuScrollList extends StatefulWidget {
  const _SubmenuScrollList({
    super.key,
    required this.items,
    required this.maxHeight,
  });

  final List<_SubmenuItem> items;
  final double maxHeight;

  @override
  State<_SubmenuScrollList> createState() => _SubmenuScrollListState();
}

class _SubmenuScrollListState extends State<_SubmenuScrollList> {
  static const _verticalPadding = 4.0;

  final ScrollController _controller = ScrollController();

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _jumpToSelected());
  }

  @override
  void didUpdateWidget(covariant _SubmenuScrollList oldWidget) {
    super.didUpdateWidget(oldWidget);
    final oldSelected = oldWidget.items.indexWhere((item) => item.selected);
    final nextSelected = widget.items.indexWhere((item) => item.selected);
    if (oldSelected != nextSelected ||
        oldWidget.items.length != widget.items.length) {
      WidgetsBinding.instance.addPostFrameCallback((_) => _jumpToSelected());
    }
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  void _jumpToSelected() {
    if (!mounted || !_controller.hasClients) return;
    final position = _controller.position;
    if (!position.hasContentDimensions) {
      WidgetsBinding.instance.addPostFrameCallback((_) => _jumpToSelected());
      return;
    }

    final index = widget.items.indexWhere((item) => item.selected);
    if (index < 0) {
      if (position.pixels != 0) _controller.jumpTo(0);
      return;
    }

    // Offset to the top of the selected row (includes list top padding).
    var rowTop = _verticalPadding;
    for (var i = 0; i < index; i++) {
      rowTop += widget.items[i].rowHeight;
    }
    final rowHeight = widget.items[index].rowHeight;
    final viewport = position.viewportDimension;
    // Prefer centering the selected row in the viewport when space allows.
    final target = (rowTop + rowHeight / 2 - viewport / 2).clamp(
      0.0,
      position.maxScrollExtent,
    );
    if ((position.pixels - target).abs() > 0.5) {
      _controller.jumpTo(target);
    }
  }

  @override
  Widget build(BuildContext context) {
    return ConstrainedBox(
      constraints: BoxConstraints(maxHeight: widget.maxHeight),
      child: ListView.builder(
        controller: _controller,
        shrinkWrap: true,
        padding: const EdgeInsets.symmetric(vertical: _verticalPadding),
        itemCount: widget.items.length,
        itemBuilder: (context, index) => _SubmenuRow(item: widget.items[index]),
      ),
    );
  }
}

class _SubmenuItem {
  const _SubmenuItem({
    required this.label,
    required this.selected,
    required this.onTap,
    this.subtitle,
    this.badge,
    this.enabled = true,
  });

  final String label;
  final String? subtitle;
  final String? badge;
  final bool selected;
  final bool enabled;
  final VoidCallback onTap;

  double get rowHeight => subtitle == null
      ? _ComposerCascadeOverlayState._rowHeight
      : _ComposerCascadeOverlayState._rowHeightWithSubtitle;
}

class _GlassPanel extends StatelessWidget {
  const _GlassPanel({required this.child, required this.radius});

  final Widget child;
  final double radius;

  @override
  Widget build(BuildContext context) {
    final eco = ecoColors(context);
    final isDark = Theme.of(context).brightness == Brightness.dark;
    final borderRadius = BorderRadius.circular(radius);
    final panel = Material(type: MaterialType.transparency, child: child);

    final Widget surface;
    if (PlatformInfo.isIOS26OrHigher()) {
      // Native UIVisualEffectView — no custom white sheen.
      surface = AdaptiveBlurView(
        blurStyle: BlurStyle.systemThinMaterial,
        borderRadius: borderRadius,
        child: panel,
      );
    } else if (PlatformInfo.isAndroid) {
      surface = EcoAndroidGlassSurface(
        borderRadius: borderRadius,
        child: panel,
      );
    } else {
      surface = ClipRRect(
        borderRadius: borderRadius,
        child: BackdropFilter(
          filter: ImageFilter.blur(sigmaX: 40, sigmaY: 40),
          child: DecoratedBox(
            decoration: BoxDecoration(
              borderRadius: borderRadius,
              color: isDark ? const Color(0xCC1C1C1E) : const Color(0xE6F2F2F7),
              border: Border.all(
                color: isDark
                    ? Colors.white.withValues(alpha: 0.10)
                    : Colors.black.withValues(alpha: 0.06),
                width: 0.5,
              ),
            ),
            child: panel,
          ),
        ),
      );
    }

    return DecoratedBox(
      decoration: BoxDecoration(
        borderRadius: borderRadius,
        boxShadow: [
          BoxShadow(
            color: eco.shadowScrim.withValues(alpha: isDark ? 0.40 : 0.12),
            blurRadius: 32,
            spreadRadius: -2,
            offset: const Offset(0, 12),
          ),
        ],
      ),
      child: surface,
    );
  }
}

class _PrimaryRow extends StatelessWidget {
  const _PrimaryRow({
    required this.label,
    required this.value,
    required this.selected,
    required this.onTap,
    this.valueBadge,
    this.enabled = true,
  });

  final String label;
  final String value;
  final String? valueBadge;
  final bool selected;
  final bool enabled;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final eco = ecoColors(context);
    final isDark = Theme.of(context).brightness == Brightness.dark;

    return EcoPressable(
      enabled: enabled,
      scale: 0.98,
      onTap: onTap,
      child: Opacity(
        opacity: enabled ? 1 : 0.45,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(6, 4, 6, 4),
          child: AnimatedContainer(
            duration: const Duration(milliseconds: 180),
            curve: Curves.easeOutCubic,
            height: _ComposerCascadeOverlayState._rowHeight - 8,
            padding: const EdgeInsets.symmetric(horizontal: 10),
            decoration: BoxDecoration(
              color: selected
                  ? (isDark
                        ? Colors.white.withValues(alpha: 0.12)
                        : Colors.black.withValues(alpha: 0.06))
                  : Colors.transparent,
              borderRadius: BorderRadius.circular(10),
            ),
            child: Row(
              children: [
                Expanded(
                  child: Text(
                    label,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontSize: 15,
                      fontWeight: FontWeight.w500,
                      letterSpacing: -0.25,
                      color: eco.textPrimary,
                    ),
                  ),
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: _ComposerLabelWithBadge(
                    label: value,
                    badge: valueBadge,
                    textAlign: TextAlign.right,
                    style: TextStyle(
                      fontSize: 15,
                      fontWeight: FontWeight.w400,
                      letterSpacing: -0.2,
                      color: eco.textMuted,
                    ),
                  ),
                ),
                const SizedBox(width: 4),
                Icon(EcoIcons.chevronRight, size: 16, color: eco.textMuted),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _ComposerLabelWithBadge extends StatelessWidget {
  const _ComposerLabelWithBadge({
    required this.label,
    required this.style,
    required this.textAlign,
    this.badge,
  });

  final String label;
  final String? badge;
  final TextStyle style;
  final TextAlign textAlign;

  @override
  Widget build(BuildContext context) {
    final eco = ecoColors(context);
    final badgeText = badge?.trim();

    return Row(
      mainAxisSize: MainAxisSize.max,
      children: [
        Expanded(
          child: Text(
            label,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            textAlign: textAlign,
            style: style,
          ),
        ),
        if (badgeText != null && badgeText.isNotEmpty) ...[
          const SizedBox(width: 5),
          DecoratedBox(
            decoration: BoxDecoration(
              color: eco.accentSoft,
              border: Border.all(
                color: eco.accent.withValues(alpha: 0.24),
                width: 0.5,
              ),
              borderRadius: BorderRadius.circular(4),
            ),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 2),
              child: Text(
                badgeText,
                maxLines: 1,
                style: TextStyle(
                  color: eco.accentText,
                  fontSize: 10,
                  fontWeight: FontWeight.w700,
                  letterSpacing: 0.25,
                  height: 1,
                ),
              ),
            ),
          ),
        ],
      ],
    );
  }
}

class _SubmenuRow extends StatelessWidget {
  const _SubmenuRow({required this.item});

  final _SubmenuItem item;

  @override
  Widget build(BuildContext context) {
    final eco = ecoColors(context);
    final subtitle = item.subtitle?.trim();
    return EcoPressable(
      enabled: item.enabled,
      scale: 0.98,
      onTap: item.onTap,
      child: Opacity(
        opacity: item.enabled ? 1 : 0.45,
        child: SizedBox(
          height: item.rowHeight,
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16),
            child: Row(
              children: [
                Expanded(
                  child: Column(
                    mainAxisAlignment: MainAxisAlignment.center,
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      _ComposerLabelWithBadge(
                        label: item.label,
                        badge: item.badge,
                        textAlign: TextAlign.left,
                        style: TextStyle(
                          fontSize: 16,
                          fontWeight: item.selected
                              ? FontWeight.w600
                              : FontWeight.w400,
                          letterSpacing: -0.25,
                          height: 1.15,
                          color: eco.textPrimary,
                        ),
                      ),
                      if (subtitle != null && subtitle.isNotEmpty) ...[
                        const SizedBox(height: 2),
                        Text(
                          subtitle,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(
                            fontSize: 12,
                            fontWeight: FontWeight.w400,
                            letterSpacing: -0.1,
                            height: 1.1,
                            color: eco.textMuted,
                          ),
                        ),
                      ],
                    ],
                  ),
                ),
                if (item.selected)
                  Icon(EcoIcons.check, size: 17, color: eco.textMuted),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _Hairline extends StatelessWidget {
  const _Hairline({required this.eco});

  final EcoColors eco;

  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    return Padding(
      padding: const EdgeInsets.only(left: 14),
      child: Divider(
        height: 0.33,
        thickness: 0.33,
        color: eco.borderSubtle.withValues(alpha: isDark ? 0.28 : 0.22),
      ),
    );
  }
}

/// Shared resolver used by the toolbar control and the sheet.
ComposerTemporaryModelOption resolveComposerTemporaryModel({
  required List<ComposerTemporaryModelOption> options,
  required MainAgentModelOverride? override,
  required OrchestrationModelRef templateModel,
}) {
  if (override != null) {
    for (final option in options) {
      if (composerTemporaryModelSelected(override, option)) return option;
    }
    return ComposerTemporaryModelOption(
      providerId: override.providerId,
      modelId: override.modelId,
      candidateModelId: override.candidateModelId,
      supportsReasoning: null,
    );
  }
  for (final option in options) {
    if (composerTemporaryModelMatchesTemplate(option, templateModel)) {
      return option;
    }
  }
  return ComposerTemporaryModelOption(
    providerId: templateModel.providerId,
    modelId: templateModel.modelId,
    candidateModelId: templateModel.candidateModelId,
  );
}
