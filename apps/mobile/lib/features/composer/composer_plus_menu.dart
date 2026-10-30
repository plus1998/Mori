import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/constants/session_mode.dart';
import '../../core/constants/session_mode_ui.dart';
import '../../core/locale/app_localizations_ext.dart';
import '../../core/models/thread_models.dart';
import '../../core/theme/eco_icons.dart';
import '../../core/theme/eco_theme.dart';
import '../../core/widgets/eco_pressable.dart';
import '../../core/widgets/eco_action_sheet.dart';
import '../threads/thread_providers.dart';
import 'composer_controls.dart';
import 'composer_toolbar_icon.dart';

enum ComposerPlusMenuAction { plan, ask, image, schedule, reference }

/// One route for the menu and runtime configuration, anchored to the input card.
class ComposerPlusMenuRoute extends PopupRoute<ComposerPlusMenuAction> {
  ComposerPlusMenuRoute({
    required this.anchorKey,
    required this.builder,
    required this.dismissLabel,
    required this.reduceMotion,
  }) : super(requestFocus: false);

  final GlobalKey anchorKey;
  final WidgetBuilder builder;
  final String dismissLabel;
  final bool reduceMotion;
  bool _refreshPending = false;
  late final _metricsObserver = _MenuMetricsObserver(refresh);

  @override
  Color? get barrierColor => null;
  @override
  bool get barrierDismissible => false;
  @override
  String get barrierLabel => dismissLabel;
  @override
  Duration get transitionDuration => const Duration(milliseconds: 200);

  @override
  void install() {
    super.install();
    WidgetsBinding.instance.addObserver(_metricsObserver);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(_metricsObserver);
    super.dispose();
  }

  /// Read the anchor after its new layout (keyboard, typing or rotation).
  void refresh() {
    if (_refreshPending) return;
    _refreshPending = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _refreshPending = false;
      if (isActive) changedExternalState();
    });
  }

  void close() {
    if (isCurrent) navigator?.pop();
  }

  @override
  Widget buildPage(
    BuildContext context,
    Animation<double> animation,
    Animation<double> secondaryAnimation,
  ) {
    final media = MediaQuery.of(context);
    return LayoutBuilder(
      builder: (context, constraints) {
        final box = anchorKey.currentContext?.findRenderObject() as RenderBox?;
        final overlay =
            navigator?.overlay?.context.findRenderObject() as RenderBox?;
        if (box == null || !box.attached || !box.hasSize || overlay == null) {
          WidgetsBinding.instance.addPostFrameCallback((_) {
            if (isActive) navigator?.removeRoute(this);
          });
          return const SizedBox.shrink();
        }
        final anchor =
            box.localToGlobal(Offset.zero, ancestor: overlay) & box.size;
        final safeTop = media.padding.top + 8;
        final width = math.min(
          anchor.width,
          math.max(0.0, constraints.maxWidth - 16),
        );
        final left = anchor.left
            .clamp(8.0, math.max(8.0, constraints.maxWidth - width - 8))
            .toDouble();
        final maxHeight = math.min(
          420.0,
          math.max(0.0, anchor.top - 10 - safeTop),
        );
        final curved = animation.drive(CurveTween(curve: Curves.easeOutCubic));
        return Material(
          type: MaterialType.transparency,
          child: Stack(
            children: [
              Positioned.fill(
                child: Semantics(
                  label: dismissLabel,
                  button: true,
                  onTap: close,
                  child: GestureDetector(
                    behavior: HitTestBehavior.opaque,
                    onTap: close,
                    child: const SizedBox.expand(),
                  ),
                ),
              ),
              Positioned(
                left: left,
                bottom: constraints.maxHeight - anchor.top + 10,
                width: width,
                child: ConstrainedBox(
                  constraints: BoxConstraints(maxHeight: maxHeight),
                  child: FadeTransition(
                    opacity: curved,
                    child: SlideTransition(
                      position: Tween<Offset>(
                        begin: reduceMotion
                            ? Offset.zero
                            : const Offset(0, 0.025),
                        end: Offset.zero,
                      ).animate(curved),
                      child: Dismissible(
                        key: const ValueKey('composer-plus-dismiss'),
                        direction: DismissDirection.down,
                        dismissThresholds: const {DismissDirection.down: 0.22},
                        resizeDuration: null,
                        onDismissed: (_) => close(),
                        child: builder(context),
                      ),
                    ),
                  ),
                ),
              ),
            ],
          ),
        );
      },
    );
  }

  @override
  Widget buildTransitions(
    BuildContext context,
    Animation<double> animation,
    Animation<double> secondaryAnimation,
    Widget child,
  ) => child;
}

class _MenuMetricsObserver extends WidgetsBindingObserver {
  _MenuMetricsObserver(this.onMetricsChanged);
  final VoidCallback onMetricsChanged;

  @override
  void didChangeMetrics() => onMetricsChanged();
}

class ComposerPlusMenuPanel extends ConsumerStatefulWidget {
  const ComposerPlusMenuPanel({
    super.key,
    required this.runtimeConfig,
    required this.threadId,
    required this.canEdit,
    required this.canEditStatelessModels,
    required this.onChanged,
    required this.workspacePath,
    required this.canSchedule,
    required this.canReference,
    this.coreKind,
    this.onCoreKindChanged,
  });

  final ThreadRuntimeConfigInput runtimeConfig;
  final String threadId;
  final bool canEdit;
  final bool canEditStatelessModels;
  final ValueChanged<ThreadRuntimeConfigInput> onChanged;
  final String workspacePath;
  final bool canSchedule;
  final bool canReference;
  final String? coreKind;
  final ValueChanged<String>? onCoreKindChanged;

  @override
  ConsumerState<ComposerPlusMenuPanel> createState() =>
      _ComposerPlusMenuPanelState();
}

class _ComposerPlusMenuPanelState extends ConsumerState<ComposerPlusMenuPanel> {
  bool _showConfig = false;

  @override
  Widget build(BuildContext context) {
    final eco = ecoColors(context);
    final l10n = context.l10n;
    return PopScope<ComposerPlusMenuAction>(
      canPop: !_showConfig,
      onPopInvokedWithResult: (didPop, result) {
        if (!didPop && _showConfig) setState(() => _showConfig = false);
      },
      child: Semantics(
        scopesRoute: true,
        explicitChildNodes: true,
        namesRoute: true,
        label: _showConfig ? l10n.composerRuntimeConfig : l10n.composerPlusMenu,
        child: Material(
          key: const ValueKey('composer-plus-panel'),
          color: eco.bgMenu,
          borderRadius: BorderRadius.circular(16),
          clipBehavior: Clip.antiAlias,
          elevation: 8,
          shadowColor: eco.shadowScrim.withValues(alpha: 0.16),
          child: Padding(
            padding: const EdgeInsets.all(10),
            child: LayoutBuilder(
              builder: (context, constraints) {
                // On short keyboard/landscape viewports the header scrolls too.
                final scrollHeader = constraints.maxHeight < 96;
                return Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Semantics(
                      label: l10n.commonClose,
                      onDismiss: () => Navigator.pop(context),
                      child: SizedBox(
                        key: const ValueKey('composer-plus-grabber'),
                        height: math.min(28, constraints.maxHeight),
                        child: const EcoSheetGrabber(),
                      ),
                    ),
                    if (_showConfig && !scrollHeader) _header(context),
                    Flexible(
                      child: SingleChildScrollView(
                        key: ValueKey(_showConfig),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.stretch,
                          children: [
                            if (_showConfig && scrollHeader) _header(context),
                            _showConfig ? _config(context) : _menu(context),
                          ],
                        ),
                      ),
                    ),
                  ],
                );
              },
            ),
          ),
        ),
      ),
    );
  }

  Widget _header(BuildContext context) {
    final l10n = context.l10n;
    final eco = ecoColors(context);
    return Row(
      children: [
        IconButton(
          tooltip: l10n.composerPlusBack,
          icon: const Icon(EcoIcons.back, size: 18),
          onPressed: () => setState(() => _showConfig = false),
        ),
        Expanded(
          child: Text(
            l10n.composerRuntimeConfig,
            style: TextStyle(
              fontSize: 15,
              fontWeight: FontWeight.w600,
              color: eco.textPrimary,
            ),
          ),
        ),
        IconButton(
          tooltip: l10n.commonClose,
          icon: const Icon(EcoIcons.close, size: 18),
          onPressed: () => Navigator.pop(context),
        ),
      ],
    );
  }

  void _select(ComposerPlusMenuAction action) {
    HapticFeedback.selectionClick();
    Navigator.pop(context, action);
  }

  Widget _menu(BuildContext context) {
    final l10n = context.l10n;
    final mode = widget.runtimeConfig.sessionMode;
    final harness = composerCoreKindOptions
        .where((option) => option.value == widget.coreKind)
        .firstOrNull;
    final harnessLabel = harness == null
        ? l10n.commonUnavailable
        : harness.badge == null
        ? harness.label
        : '${harness.label} · ${harness.badge}';
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _MenuSection(l10n.composerPlusModeSection),
        for (final sessionMode in ['plan', 'ask'])
          _PlusMenuRow(
            icon: sessionModeIcon(sessionMode),
            label: sessionModeUi(sessionMode, l10n).title,
            description: sessionMode == 'plan'
                ? l10n.composerPlusPlanHint
                : l10n.composerPlusAskHint,
            selected: mode == sessionMode,
            toggle: true,
            enabled: widget.canEdit,
            onTap: () => _select(
              sessionMode == 'plan'
                  ? ComposerPlusMenuAction.plan
                  : ComposerPlusMenuAction.ask,
            ),
          ),
        _MenuSection(l10n.composerPlusActionSection),
        if (widget.canReference)
          _PlusMenuRow(
            icon: Icons.alternate_email_rounded,
            label: l10n.composerReferencesChoose,
            description: l10n.composerReferencesHint,
            onTap: () => _select(ComposerPlusMenuAction.reference),
          ),
        _PlusMenuRow(
          icon: EcoIcons.image,
          label: l10n.composerImage,
          description: l10n.composerPlusImageHint,
          onTap: () => _select(ComposerPlusMenuAction.image),
        ),
        _PlusMenuRow(
          icon: EcoIcons.schedule,
          label: l10n.schedulingNewMessage,
          description: widget.threadId.isEmpty
              ? l10n.composerPlusFirstMessageHint
              : l10n.composerPlusScheduleHint,
          showChevron: true,
          enabled: widget.canSchedule,
          onTap: () => _select(ComposerPlusMenuAction.schedule),
        ),
        _MenuSection(l10n.composerPlusConfigSection),
        if (widget.coreKind != null)
          _PlusMenuRow(
            icon: EcoIcons.agent,
            label: l10n.composerCoreKind,
            description: widget.onCoreKindChanged == null
                ? '$harnessLabel · ${l10n.composerRuntimeCoreLocked}'
                : harnessLabel,
            showChevron: true,
            enabled: widget.canEdit && widget.onCoreKindChanged != null,
            onTap: _chooseHarness,
          ),
        _PlusMenuRow(
          icon: EcoIcons.orchestration,
          label: l10n.composerRuntimeConfig,
          description: l10n.composerPlusConfigHint,
          showChevron: true,
          onTap: () => setState(() => _showConfig = true),
        ),
        for (final category in ComposerRouteCategory.values)
          _PlusMenuRow(
            icon: switch (category) {
              ComposerRouteCategory.integrations => Icons.extension_outlined,
              ComposerRouteCategory.mcp => EcoIcons.mcp,
              ComposerRouteCategory.skills => EcoIcons.skills,
              ComposerRouteCategory.subagents => EcoIcons.subagents,
            },
            label: switch (category) {
              ComposerRouteCategory.integrations => l10n.composerIntegrations,
              ComposerRouteCategory.mcp => l10n.composerMcpServers,
              ComposerRouteCategory.skills => l10n.composerSkills,
              ComposerRouteCategory.subagents => l10n.composerSubagents,
            },
            description: switch (category) {
              ComposerRouteCategory.integrations =>
                l10n.composerPlusIntegrationsHint,
              ComposerRouteCategory.mcp => l10n.composerPlusMcpHint,
              ComposerRouteCategory.skills => l10n.composerPlusSkillsHint,
              ComposerRouteCategory.subagents => l10n.composerPlusSubagentsHint,
            },
            showChevron: true,
            onTap: () => showComposerRouteCategorySheet(
              context: context,
              runtimeConfig: widget.runtimeConfig,
              threadId: widget.threadId,
              canEdit: widget.canEdit,
              onChanged: widget.onChanged,
              workspacePath: widget.workspacePath,
              category: category,
            ),
          ),
      ],
    );
  }

  Future<void> _chooseHarness() async {
    if (!widget.canEdit || widget.onCoreKindChanged == null) return;
    final value = await showEcoActionSheet<String>(
      context: context,
      builder: (context) => SafeArea(
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const EcoSheetGrabber(),
              EcoSheetHeader(title: context.l10n.composerCoreKind),
              for (final option in composerCoreKindOptions)
                EcoSheetOptionTile(
                  title: option.badge == null
                      ? option.label
                      : '${option.label} · ${option.badge}',
                  selected: widget.coreKind == option.value,
                  onTap: () => Navigator.of(context).pop(option.value),
                ),
            ],
          ),
        ),
      ),
    );
    if (!mounted ||
        value == null ||
        value == widget.coreKind ||
        !widget.canEdit ||
        widget.onCoreKindChanged == null) {
      return;
    }
    Navigator.of(context).pop();
    widget.onCoreKindChanged!(value);
  }

  Widget _config(BuildContext context) {
    final l10n = context.l10n;
    final settings = ref.watch(modelSettingsProvider);
    final workflow = ref.watch(workflowSettingsProvider).valueOrNull;
    final mcp = ref.watch(mcpSettingsProvider).valueOrNull;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        settings.when(
          data: (settings) => settings == null
              ? Padding(
                  padding: const EdgeInsets.all(12),
                  child: Text(l10n.commonNotConfigured),
                )
              : OrchestrationCompositionSelectors(
                  settings: settings,
                  mainAgentLabel: l10n.composerPrimaryAgent,
                  runtimeConfig: widget.runtimeConfig,
                  threadId: widget.threadId,
                  canEdit: widget.canEdit,
                  canEditStatelessModels: widget.canEditStatelessModels,
                  onChanged: widget.onChanged,
                  workspacePath: widget.workspacePath,
                  mcpServers: mcp?.servers ?? const [],
                  rememberedMcp: workflow?.mcpServersEnabled,
                  isAcp: widget.coreKind == 'acp',
                  showOrchestrationPickers: widget.coreKind != 'acp',
                  showAuxiliaryModelPicker: true,
                  showApprovalModelPicker: true,
                  showVisionModelPicker: true,
                ),
          loading: () => const Padding(
            padding: EdgeInsets.all(12),
            child: LinearProgressIndicator(),
          ),
          error: (_, _) => Padding(
            padding: const EdgeInsets.all(12),
            child: Column(
              children: [
                Text(l10n.composerModelLoadFailed),
                TextButton(
                  onPressed: () => ref.invalidate(modelSettingsProvider),
                  child: Text(l10n.commonRetry),
                ),
              ],
            ),
          ),
        ),
      ],
    );
  }
}

class _MenuSection extends StatelessWidget {
  const _MenuSection(this.label);
  final String label;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.fromLTRB(10, 8, 10, 4),
    child: Text(
      label,
      style: TextStyle(
        fontSize: 11,
        fontWeight: FontWeight.w500,
        color: ecoColors(context).textMuted,
      ),
    ),
  );
}

class _PlusMenuRow extends StatelessWidget {
  const _PlusMenuRow({
    required this.icon,
    required this.label,
    required this.onTap,
    this.description,
    this.selected = false,
    this.toggle = false,
    this.enabled = true,
    this.showChevron = false,
  });

  final IconData icon;
  final String label;
  final VoidCallback onTap;
  final String? description;
  final bool selected;
  final bool toggle;
  final bool enabled;
  final bool showChevron;

  @override
  Widget build(BuildContext context) {
    final eco = ecoColors(context);
    final labelWidget = Text(
      label,
      style: TextStyle(
        fontSize: 15,
        fontWeight: FontWeight.w500,
        color: eco.textPrimary,
      ),
    );
    final hint = description == null
        ? null
        : Text(
            description!,
            style: TextStyle(fontSize: 12, color: eco.textMuted),
          );
    return Semantics(
      button: true,
      enabled: enabled,
      checked: toggle ? selected : null,
      child: EcoPressable(
        enabled: enabled,
        onTap: onTap,
        borderRadius: BorderRadius.circular(24),
        child: Opacity(
          opacity: enabled ? 1 : 0.5,
          child: Container(
            constraints: const BoxConstraints(minHeight: 44),
            margin: const EdgeInsets.symmetric(vertical: 2),
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
            decoration: BoxDecoration(
              color: selected
                  ? eco.textPrimary.withValues(alpha: 0.06)
                  : Colors.transparent,
              borderRadius: BorderRadius.circular(24),
            ),
            child: LayoutBuilder(
              builder: (context, constraints) {
                final stacked =
                    constraints.maxWidth <= 340 ||
                    MediaQuery.textScalerOf(context).scale(15) > 18;
                return Row(
                  children: [
                    Icon(
                      icon,
                      size: 18,
                      color: selected ? eco.accent : eco.textSecondary,
                    ),
                    const SizedBox(width: 10),
                    Expanded(
                      child: stacked
                          ? Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [labelWidget, ?hint],
                            )
                          : Row(
                              children: [
                                labelWidget,
                                if (hint != null) ...[
                                  const SizedBox(width: 10),
                                  Expanded(child: hint),
                                ],
                              ],
                            ),
                    ),
                    if (selected) ...[
                      const SizedBox(width: 6),
                      Icon(EcoIcons.check, size: 14, color: eco.accent),
                      const SizedBox(width: 4),
                      Flexible(
                        child: Text(
                          context.l10n.composerPlusEnabled,
                          style: TextStyle(fontSize: 11, color: eco.textMuted),
                        ),
                      ),
                    ] else if (showChevron) ...[
                      const SizedBox(width: 6),
                      Icon(
                        EcoIcons.chevronRight,
                        size: 15,
                        color: eco.textMuted,
                      ),
                    ],
                  ],
                );
              },
            ),
          ),
        ),
      ),
    );
  }
}

/// Icon-only Plan / Ask mode control. Tapping it exits the mode.
class ComposerSessionModeTag extends StatelessWidget {
  const ComposerSessionModeTag({super.key, required this.mode, this.onClose});

  final SessionMode mode;
  final VoidCallback? onClose;

  @override
  Widget build(BuildContext context) {
    assert(mode == 'plan' || mode == 'ask', 'Tag only for Plan/Ask modes');
    final label = sessionModeUi(mode, context.l10n).title;
    final exitLabel = context.l10n.composerExitSessionMode(label);

    return Semantics(
      button: true,
      enabled: onClose != null,
      label: exitLabel,
      child: ComposerToolbarIconButton(
        onPressed: onClose,
        tooltip: exitLabel,
        icon: SessionModeIcon(mode: mode, color: ecoColors(context).accent),
      ),
    );
  }
}
