import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../core/locale/app_localizations_ext.dart';
import '../../core/models/git_models.dart';
import '../../core/models/thread_models.dart';
import '../../core/network/desktop_rpc.dart';
import '../../core/theme/eco_icons.dart';
import '../../core/theme/eco_theme.dart';
import '../../core/widgets/eco_action_sheet.dart';
import '../../core/widgets/eco_grouped_list.dart';
import '../../core/widgets/eco_modal_sheet.dart';
import '../../core/widgets/eco_pressable.dart';
import '../threads/thread_providers.dart';
import 'composer_controls.dart';
import 'composer_main_model_picker.dart';

Future<String?> showCommitPushSheet({
  required BuildContext context,
  required WidgetRef ref,
  required String workspacePath,
  String? mainAgentConfigId,
  AuxiliaryModelSelection? defaultModelSelection,
  required WorkspaceDiffResult diff,
  required GitWorkingTreeStatus gitStatus,
}) {
  return showEcoModalBottomSheet<String>(
    context: context,
    isScrollControlled: true,
    backgroundColor: ecoColors(context).bgMenu,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(16)),
    ),
    builder: (context) => DraggableScrollableSheet(
      expand: false,
      initialChildSize: 0.72,
      minChildSize: 0.45,
      maxChildSize: 0.92,
      builder: (context, scrollController) => CommitPushSheet(
        workspacePath: workspacePath,
        mainAgentConfigId: mainAgentConfigId,
        defaultModelSelection: defaultModelSelection,
        diff: diff,
        gitStatus: gitStatus,
        scrollController: scrollController,
      ),
    ),
  );
}

class CommitPushSheet extends ConsumerStatefulWidget {
  const CommitPushSheet({
    super.key,
    required this.workspacePath,
    this.mainAgentConfigId,
    this.defaultModelSelection,
    required this.diff,
    required this.gitStatus,
    required this.scrollController,
  });

  final String workspacePath;
  final String? mainAgentConfigId;
  final AuxiliaryModelSelection? defaultModelSelection;
  final WorkspaceDiffResult diff;
  final GitWorkingTreeStatus gitStatus;
  final ScrollController scrollController;

  @override
  ConsumerState<CommitPushSheet> createState() => _CommitPushSheetState();
}

enum _CommitPushAction { commit, commitPush, push }

enum _CommitPushPhase { committing, pushing }

class _CommitPushSheetState extends ConsumerState<CommitPushSheet> {
  final _messageController = TextEditingController();
  bool _generating = false;
  _CommitPushAction? _activeAction;
  _CommitPushPhase? _phase;
  bool _loadingModels = false;
  bool _includeUnstaged = true;
  bool _branchBusy = false;
  String? _error;
  List<CommitModelOptionView> _modelOptions = [];
  AuxiliaryModelSelection? _selectedModelSelection;

  String? get _selectedCandidateModelId =>
      _selectedModelSelection?.candidateModelId;
  late GitWorkingTreeStatus _gitStatus;
  late WorkspaceDiffResult _diff;

  bool get _busy => _activeAction != null;

  @override
  void initState() {
    super.initState();
    _gitStatus = widget.gitStatus;
    _diff = widget.diff;
    _loadModelOptions();
  }

  @override
  void dispose() {
    _messageController.dispose();
    super.dispose();
  }

  DesktopRpc? get _rpc => ref.read(desktopRpcProvider);

  Future<void> _loadModelOptions() async {
    final rpc = _rpc;
    if (rpc == null) return;
    setState(() => _loadingModels = true);
    try {
      final result = await rpc.listCommitModelOptions(
        mainAgentConfigId: widget.mainAgentConfigId,
      );
      final workflow = await ref.read(workflowSettingsProvider.future);
      final configured =
          widget.defaultModelSelection ?? workflow?.defaultAuxiliaryModel;
      final initialOption = result.options
          .where((option) => option.providerId != 'eco-coding-chatgpt')
          .firstOrNull;
      final selected =
          configured ??
          (initialOption == null
              ? null
              : AuxiliaryModelSelection(
                  providerId: initialOption.providerId,
                  modelId: initialOption.modelId,
                  candidateModelId: initialOption.candidateModelId,
                ));
      if (!mounted) return;
      setState(() {
        _modelOptions = result.options;
        _selectedModelSelection = selected;
      });
    } catch (error) {
      if (!mounted) return;
      setState(() => _error = error.toString());
    } finally {
      if (mounted) setState(() => _loadingModels = false);
    }
  }

  CommitModelOptionView? get _selectedModelOption {
    final selectedId = _selectedCandidateModelId;
    if (selectedId == null) return null;
    for (final option in _modelOptions) {
      if (option.candidateModelId == selectedId) {
        return option;
      }
    }
    final selected = _selectedModelSelection;
    if (selected == null) return null;
    return CommitModelOptionView(
      id: selected.candidateModelId,
      candidateModelId: selected.candidateModelId,
      providerId: selected.providerId,
      providerName: selected.providerId == 'eco-coding-chatgpt'
          ? 'ChatGPT OAuth'
          : selected.providerId,
      modelId: selected.modelId,
      modelLabel: selected.modelId,
      providerColor: '',
    );
  }

  bool _ensureCommitInput() {
    if (_messageController.text.trim().isNotEmpty) return true;
    if (_selectedCandidateModelId != null) return true;
    setState(() => _error = context.l10n.commitSelectModel);
    return false;
  }

  Future<void> _generateMessage() async {
    final rpc = _rpc;
    if (rpc == null || _generating || _busy || _branchBusy) return;
    if (_selectedCandidateModelId == null) {
      setState(() => _error = context.l10n.commitSelectModel);
      return;
    }
    setState(() {
      _generating = true;
      _error = null;
    });
    try {
      final result = await rpc.generateCommitMessage(
        workspacePath: widget.workspacePath,
        mainAgentConfigId: widget.mainAgentConfigId,
        includeUnstaged: _includeUnstaged,
        modelSelection: _selectedModelSelection,
      );
      _messageController.text = result.message;
    } catch (error) {
      setState(() => _error = error.toString());
    } finally {
      if (mounted) setState(() => _generating = false);
    }
  }

  Future<void> _commitAndPush() async {
    final rpc = _rpc;
    if (rpc == null || _busy) return;
    if (!_ensureCommitInput()) return;
    setState(() {
      _activeAction = _CommitPushAction.commitPush;
      _phase = _CommitPushPhase.committing;
      _error = null;
    });
    var committed = false;
    try {
      final message = _messageController.text.trim();
      await rpc.commitChanges(
        workspacePath: widget.workspacePath,
        mainAgentConfigId: widget.mainAgentConfigId,
        includeUnstaged: _includeUnstaged,
        message: message.isEmpty ? null : message,
        modelSelection: message.isEmpty ? _selectedModelSelection : null,
      );
      committed = true;
      if (mounted) {
        refreshWorkspaceChanges(ref, widget.workspacePath);
        setState(() => _phase = _CommitPushPhase.pushing);
      }
      await rpc.pushChanges(
        workspacePath: widget.workspacePath,
        branch: _gitStatus.branch,
      );
      if (mounted) {
        refreshWorkspaceChanges(ref, widget.workspacePath);
        Navigator.of(context).pop('commit-push');
      }
    } catch (error) {
      if (committed && mounted) {
        await _refreshGitState();
      }
      if (mounted) {
        setState(
          () => _error = committed
              ? context.l10n.commitPushFailed(error.toString())
              : error.toString(),
        );
      }
    } finally {
      if (mounted) {
        setState(() {
          _activeAction = null;
          _phase = null;
        });
      }
    }
  }

  Future<void> _commitOnly() async {
    final rpc = _rpc;
    if (rpc == null || _busy) return;
    if (!_ensureCommitInput()) return;
    setState(() {
      _activeAction = _CommitPushAction.commit;
      _phase = _CommitPushPhase.committing;
      _error = null;
    });
    try {
      final message = _messageController.text.trim();
      await rpc.commitChanges(
        workspacePath: widget.workspacePath,
        mainAgentConfigId: widget.mainAgentConfigId,
        includeUnstaged: _includeUnstaged,
        message: message.isEmpty ? null : message,
        modelSelection: message.isEmpty ? _selectedModelSelection : null,
      );
      if (mounted) {
        refreshWorkspaceChanges(ref, widget.workspacePath);
        Navigator.of(context).pop('commit');
      }
    } catch (error) {
      setState(() => _error = error.toString());
    } finally {
      if (mounted) {
        setState(() {
          _activeAction = null;
          _phase = null;
        });
      }
    }
  }

  Future<void> _pushOnly() async {
    final rpc = _rpc;
    if (rpc == null || _busy) return;
    setState(() {
      _activeAction = _CommitPushAction.push;
      _phase = _CommitPushPhase.pushing;
      _error = null;
    });
    try {
      await rpc.pushChanges(
        workspacePath: widget.workspacePath,
        branch: _gitStatus.branch,
      );
      if (mounted) {
        refreshWorkspaceChanges(ref, widget.workspacePath);
        Navigator.of(context).pop('push');
      }
    } catch (error) {
      if (mounted) setState(() => _error = error.toString());
    } finally {
      if (mounted) {
        setState(() {
          _activeAction = null;
          _phase = null;
        });
      }
    }
  }

  Future<void> _refreshGitState() async {
    final rpc = _rpc;
    if (rpc == null) return;
    try {
      final status = await rpc.getGitStatus(widget.workspacePath);
      final diff = await rpc.getWorkspaceDiff(widget.workspacePath);
      if (!mounted) return;
      setState(() {
        _gitStatus = status;
        _diff = diff;
      });
    } catch (_) {
      // The original git action error remains the useful message.
    }
  }

  Future<void> _pickBranch() async {
    if (_branchBusy || _busy || _generating) return;
    final selection = await showEcoModalBottomSheet<String>(
      context: context,
      backgroundColor: ecoColors(context).bgMenu,
      builder: (sheetContext) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const SizedBox(height: 12),
            Text(
              context.l10n.commitDestination,
              style: Theme.of(context).textTheme.titleSmall,
            ),
            const SizedBox(height: 8),
            Flexible(
              child: ListView(
                shrinkWrap: true,
                children: [
                  for (final branch in _gitStatus.branches)
                    ListTile(
                      leading: const Icon(EcoIcons.branch, size: 18),
                      title: Text(branch),
                      trailing: branch == _gitStatus.branch
                          ? const Icon(EcoIcons.check, size: 18)
                          : null,
                      onTap: () => Navigator.pop(sheetContext, branch),
                    ),
                  ListTile(
                    leading: const Icon(EcoIcons.add, size: 18),
                    title: Text(context.l10n.commitNewBranch),
                    onTap: () => Navigator.pop(sheetContext, ''),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
    if (selection == null || !mounted) return;
    if (selection.isEmpty) {
      await _createBranch();
      return;
    }
    if (selection == _gitStatus.branch) return;

    final rpc = _rpc;
    if (rpc == null) return;
    setState(() {
      _branchBusy = true;
      _error = null;
    });
    try {
      final status = await rpc.checkoutGitBranch(
        workspacePath: widget.workspacePath,
        branch: selection,
      );
      final diff = await rpc.getWorkspaceDiff(widget.workspacePath);
      if (!mounted) return;
      setState(() {
        _gitStatus = status;
        _diff = diff;
      });
      refreshWorkspaceChanges(ref, widget.workspacePath);
    } catch (error) {
      if (mounted) setState(() => _error = error.toString());
    } finally {
      if (mounted) setState(() => _branchBusy = false);
    }
  }

  Future<void> _createBranch() async {
    final controller = TextEditingController();
    final branch = await showDialog<String>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: Text(context.l10n.commitCreateBranch),
        content: TextField(
          controller: controller,
          autofocus: true,
          textInputAction: TextInputAction.done,
          decoration: InputDecoration(hintText: context.l10n.commitBranchName),
          onSubmitted: (value) => Navigator.pop(dialogContext, value.trim()),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(dialogContext),
            child: Text(context.l10n.commonCancel),
          ),
          FilledButton(
            onPressed: () =>
                Navigator.pop(dialogContext, controller.text.trim()),
            child: Text(context.l10n.commonCreate),
          ),
        ],
      ),
    );
    controller.dispose();
    if (branch == null || branch.isEmpty || !mounted) return;

    final rpc = _rpc;
    if (rpc == null) return;
    setState(() {
      _branchBusy = true;
      _error = null;
    });
    try {
      final status = await rpc.createGitBranch(
        workspacePath: widget.workspacePath,
        branch: branch,
      );
      final diff = await rpc.getWorkspaceDiff(widget.workspacePath);
      if (!mounted) return;
      setState(() {
        _gitStatus = status;
        _diff = diff;
      });
      refreshWorkspaceChanges(ref, widget.workspacePath);
    } catch (error) {
      if (mounted) setState(() => _error = error.toString());
    } finally {
      if (mounted) setState(() => _branchBusy = false);
    }
  }

  Future<void> _pickModel() async {
    if (_loadingModels) return;
    final current = _selectedModelSelection;
    final selected = await showEcoActionSheet<OrchestrationModelRef>(
      context: context,
      isScrollControlled: true,
      builder: (sheetContext) => EcoSheetScaffold(
        title: context.l10n.commitSelectModel,
        maxHeightFactor: 0.75,
        child: ComposerStatelessModelPicker(
          selectedModel: current == null
              ? null
              : OrchestrationModelRef(
                  providerId: current.providerId,
                  modelId: current.modelId,
                  candidateModelId: current.candidateModelId,
                  accountId: current.accountId,
                ),
          enabled: true,
          mainAgentConfigId: widget.mainAgentConfigId ?? '',
          onSelected: (model) => Navigator.pop(sheetContext, model),
        ),
      ),
    );
    if (selected == null || !mounted) return;
    final selection = AuxiliaryModelSelection(
      providerId: selected.providerId,
      modelId: selected.modelId,
      candidateModelId: selected.candidateModelId!,
      accountId: selected.accountId,
    );
    setState(() => _selectedModelSelection = selection);
    try {
      await persistAuxiliaryModelWorkflowDefault(ref, selection: selection);
    } catch (error) {
      if (!mounted) return;
      setState(() => _error = error.toString());
    }
  }

  @override
  Widget build(BuildContext context) {
    final diff = _diff;
    final showModelPicker = _messageController.text.trim().isEmpty;
    final selectedModel = _selectedModelOption;
    final canCommit = _gitStatus.canCommit;
    final canPushOnly = _gitStatus.isGitRepository && _gitStatus.aheadCount > 0;
    final controlsBusy = _busy || _generating || _branchBusy;

    return SafeArea(
      child: Column(
        children: [
          const SizedBox(height: 12),
          Container(
            width: 36,
            height: 4,
            decoration: BoxDecoration(
              color: ecoColors(context).borderSubtle,
              borderRadius: BorderRadius.circular(2),
            ),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 16, 16, 8),
            child: Row(
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        context.l10n.commitChanges,
                        style: Theme.of(context).textTheme.titleMedium,
                      ),
                      const SizedBox(height: 4),
                      Text(
                        context.l10n.commitFilesSummary(
                          diff.fileCount, // count
                          diff.totalAdditions, // additions
                          diff.totalDeletions, // deletions
                        ),
                        style: Theme.of(context).textTheme.bodySmall?.copyWith(
                          color: ecoColors(context).textMuted,
                        ),
                      ),
                    ],
                  ),
                ),
                OutlinedButton.icon(
                  onPressed: controlsBusy ? null : _pickBranch,
                  icon: _branchBusy
                      ? const SizedBox(
                          width: 14,
                          height: 14,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : const Icon(EcoIcons.branch, size: 16),
                  label: ConstrainedBox(
                    constraints: const BoxConstraints(maxWidth: 128),
                    child: Text(
                      _gitStatus.branch ?? 'detached',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
                ),
              ],
            ),
          ),
          Expanded(
            child: ListView(
              controller: widget.scrollController,
              padding: const EdgeInsets.symmetric(horizontal: 16),
              children: [
                if (showModelPicker) ...[
                  const SizedBox(height: 8),
                  _CommitModelTrigger(
                    loading: _loadingModels,
                    enabled: !controlsBusy && !_loadingModels,
                    option: selectedModel,
                    emptyLabel: context.l10n.commitNoModel,
                    loadingLabel: context.l10n.commitLoadingModels,
                    onTap: _pickModel,
                  ),
                ],
                const SizedBox(height: 12),
                TextField(
                  controller: _messageController,
                  minLines: 3,
                  maxLines: 6,
                  enabled: !controlsBusy,
                  onChanged: (_) => setState(() {}),
                  decoration: InputDecoration(
                    hintText: context.l10n.commitMessageHint,
                    border: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(10),
                    ),
                    suffixIcon: IconButton(
                      onPressed:
                          controlsBusy ||
                              !canCommit ||
                              _selectedCandidateModelId == null
                          ? null
                          : _generateMessage,
                      icon: _generating
                          ? const SizedBox(
                              width: 18,
                              height: 18,
                              child: CircularProgressIndicator(strokeWidth: 2),
                            )
                          : const Icon(EcoIcons.sparkles, size: 20),
                      tooltip: context.l10n.commitGenerateMessage,
                    ),
                  ),
                ),
                CheckboxListTile(
                  contentPadding: EdgeInsets.zero,
                  controlAffinity: ListTileControlAffinity.leading,
                  title: Text(context.l10n.commitIncludeUnstaged),
                  value: _includeUnstaged,
                  onChanged: controlsBusy
                      ? null
                      : (value) =>
                            setState(() => _includeUnstaged = value ?? true),
                ),
                if (_error != null) ...[
                  const SizedBox(height: 8),
                  Text(
                    _error!,
                    style: TextStyle(
                      color: ecoColors(context).statusDenyText,
                      fontSize: 13,
                    ),
                  ),
                ],
                const SizedBox(height: 16),
              ],
            ),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 8, 16, 16),
            child: Column(
              children: [
                SizedBox(
                  width: double.infinity,
                  child: OutlinedButton.icon(
                    onPressed: controlsBusy || !canCommit ? null : _commitOnly,
                    icon: const Icon(EcoIcons.commitPush, size: 18),
                    label: Text(
                      _activeAction == _CommitPushAction.commit
                          ? context.l10n.commitCommitting
                          : context.l10n.commonSubmit,
                    ),
                  ),
                ),
                const SizedBox(height: 8),
                SizedBox(
                  width: double.infinity,
                  child: FilledButton.icon(
                    onPressed: controlsBusy || !canCommit
                        ? null
                        : _commitAndPush,
                    icon: _activeAction == _CommitPushAction.commitPush
                        ? SizedBox(
                            width: 16,
                            height: 16,
                            child: CircularProgressIndicator(
                              strokeWidth: 2,
                              color: Theme.of(context).colorScheme.onPrimary,
                            ),
                          )
                        : const Icon(EcoIcons.cloudUpload),
                    label: Text(
                      _activeAction == _CommitPushAction.commitPush
                          ? (_phase == _CommitPushPhase.pushing
                                ? context.l10n.commitPushing
                                : context.l10n.commitCommitting)
                          : context.l10n.commitAndPush,
                    ),
                  ),
                ),
                if (canPushOnly) ...[
                  const SizedBox(height: 8),
                  SizedBox(
                    width: double.infinity,
                    child: OutlinedButton.icon(
                      onPressed: controlsBusy ? null : _pushOnly,
                      icon: _activeAction == _CommitPushAction.push
                          ? const SizedBox(
                              width: 16,
                              height: 16,
                              child: CircularProgressIndicator(strokeWidth: 2),
                            )
                          : const Icon(EcoIcons.cloudUpload, size: 18),
                      label: Text(
                        _activeAction == _CommitPushAction.push
                            ? context.l10n.commitPushing
                            : context.l10n.commitPushOnlyAhead(
                                _gitStatus.aheadCount,
                              ),
                      ),
                    ),
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

class _CommitModelTrigger extends StatelessWidget {
  const _CommitModelTrigger({
    required this.loading,
    required this.enabled,
    required this.option,
    required this.emptyLabel,
    required this.loadingLabel,
    required this.onTap,
  });

  final bool loading;
  final bool enabled;
  final CommitModelOptionView? option;
  final String emptyLabel;
  final String loadingLabel;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final eco = ecoColors(context);
    final label = loading
        ? loadingLabel
        : option == null
        ? emptyLabel
        : option!.modelLabel;
    final subtitle = !loading && option != null ? option!.providerName : null;

    return EcoGroupedSurface(
      margin: EdgeInsets.zero,
      child: EcoPressable(
        enabled: enabled,
        onTap: enabled ? onTap : null,
        child: ConstrainedBox(
          constraints: const BoxConstraints(minHeight: 52),
          child: Padding(
            padding: const EdgeInsets.fromLTRB(14, 12, 12, 12),
            child: Row(
              children: [
                _CommitModelProviderDot(
                  color: option?.providerColor,
                  muted: !enabled || option == null,
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Text(
                        label,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: Theme.of(context).textTheme.bodyLarge?.copyWith(
                          fontSize: 16,
                          fontWeight: FontWeight.w500,
                          letterSpacing: -0.2,
                          color: enabled ? eco.textPrimary : eco.textMuted,
                        ),
                      ),
                      if (subtitle != null && subtitle.isNotEmpty) ...[
                        const SizedBox(height: 2),
                        Text(
                          subtitle,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: Theme.of(context).textTheme.bodySmall
                              ?.copyWith(
                                color: eco.textMuted,
                                height: 1.25,
                                letterSpacing: -0.08,
                              ),
                        ),
                      ],
                    ],
                  ),
                ),
                if (option?.hint != null) ...[
                  const SizedBox(width: 8),
                  _CommitModelPricingCompact(hint: option!.hint),
                ],
                const SizedBox(width: 6),
                if (loading)
                  SizedBox(
                    width: 14,
                    height: 14,
                    child: CircularProgressIndicator(
                      strokeWidth: 1.8,
                      color: eco.textMuted,
                    ),
                  )
                else
                  Icon(
                    EcoIcons.expandDown,
                    size: 18,
                    color: eco.textMuted.withValues(
                      alpha: enabled ? 0.9 : 0.45,
                    ),
                  ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _CommitModelProviderDot extends StatelessWidget {
  const _CommitModelProviderDot({this.color, this.muted = false});

  final String? color;
  final bool muted;

  @override
  Widget build(BuildContext context) {
    final eco = ecoColors(context);
    final parsed = _parseProviderColor(color);
    final fill = muted
        ? eco.textMuted.withValues(alpha: 0.35)
        : (parsed ?? eco.textMuted.withValues(alpha: 0.45));
    return Container(
      width: 8,
      height: 8,
      decoration: BoxDecoration(
        color: fill,
        shape: BoxShape.circle,
        border: Border.all(
          color: Colors.black.withValues(alpha: 0.08),
          width: 0.5,
        ),
      ),
    );
  }
}

class _CommitModelPricingCompact extends StatelessWidget {
  const _CommitModelPricingCompact({this.hint});

  final CommitModelPricingHint? hint;

  @override
  Widget build(BuildContext context) {
    final eco = ecoColors(context);
    final input = hint?.inputPerM;
    final output = hint?.outputPerM;
    if (input != null &&
        output != null &&
        input.toDouble() > 0 &&
        output.toDouble() > 0) {
      return Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          _PriceChip(
            icon: LucideIcons.arrowUp,
            value: _formatCompactRate(input.toDouble()),
            iconColor: const Color(0xFF7DD3A8),
            textColor: eco.textMuted,
          ),
          const SizedBox(width: 6),
          _PriceChip(
            icon: LucideIcons.arrowDown,
            value: _formatCompactRate(output.toDouble()),
            iconColor: const Color(0xFFF0A8A8),
            textColor: eco.textMuted,
          ),
        ],
      );
    }

    if (hint != null && !hint!.pricingResolved) {
      return Text(
        '—',
        style: Theme.of(context).textTheme.labelSmall?.copyWith(
          color: eco.textMuted,
          fontSize: 11,
          letterSpacing: 0,
        ),
      );
    }

    final label = hint?.pricingLabel?.trim();
    if (label != null && label.isNotEmpty) {
      return ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 96),
        child: Text(
          label,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          textAlign: TextAlign.end,
          style: Theme.of(context).textTheme.labelSmall?.copyWith(
            color: eco.textMuted,
            fontSize: 11,
            letterSpacing: -0.05,
          ),
        ),
      );
    }

    return const SizedBox.shrink();
  }
}

class _PriceChip extends StatelessWidget {
  const _PriceChip({
    required this.icon,
    required this.value,
    required this.iconColor,
    required this.textColor,
  });

  final IconData icon;
  final String value;
  final Color iconColor;
  final Color textColor;

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Icon(icon, size: 11, color: iconColor),
        const SizedBox(width: 2),
        Text(
          value,
          style: Theme.of(context).textTheme.labelSmall?.copyWith(
            color: textColor,
            fontSize: 11,
            fontFeatures: const [FontFeature.tabularFigures()],
            letterSpacing: 0,
            height: 1,
          ),
        ),
      ],
    );
  }
}

Color? _parseProviderColor(String? raw) {
  final value = raw?.trim() ?? '';
  if (value.startsWith('#') && value.length == 7) {
    final hex = value.substring(1);
    final parsed = int.tryParse(hex, radix: 16);
    if (parsed != null) {
      return Color(0xFF000000 | parsed);
    }
  }
  return null;
}

String _formatCompactRate(double usd) {
  if (!usd.isFinite) return '?';
  final text = usd >= 10
      ? usd.toStringAsFixed(0)
      : usd == usd.roundToDouble()
      ? usd.toStringAsFixed(0)
      : usd.toStringAsFixed(2).replaceFirst(RegExp(r'\.?0+$'), '');
  return text;
}
