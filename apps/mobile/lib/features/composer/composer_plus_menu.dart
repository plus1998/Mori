import 'dart:async';
import 'dart:ui';

import 'package:adaptive_platform_ui/adaptive_platform_ui.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/constants/session_mode.dart';
import '../../core/constants/session_mode_ui.dart';
import '../../core/locale/app_localizations_ext.dart';
import '../../core/models/thread_models.dart';
import '../../core/theme/eco_icons.dart';
import '../../core/theme/eco_theme.dart';
import '../../core/widgets/eco_android_glass.dart';
import '../../core/widgets/eco_pressable.dart';
import 'composer_controls.dart';
import 'composer_toolbar_icon.dart';
import '../scheduling/schedule_editor.dart';

enum ComposerPlusMenuAction {
  plan,
  ask,
  image,
  schedule,
  integrations,
  skills,
  mcp,
  subagents,
}

/// Anchored glass “+” menu — modes + Image / Skills / MCP / Subagents.
Future<void> showComposerPlusMenu({
  required BuildContext context,
  required WidgetRef ref,
  required GlobalKey anchorKey,
  required ThreadRuntimeConfigInput runtimeConfig,
  required String threadId,
  required bool canEdit,
  required ValueChanged<ThreadRuntimeConfigInput> onChanged,
  required VoidCallback onPickImage,
  required String workspacePath,
  String initialPrompt = '',
  VoidCallback? onMessageScheduled,
}) {
  final box = anchorKey.currentContext?.findRenderObject() as RenderBox?;
  if (box == null || !box.hasSize) return Future<void>.value();

  final overlayState = Overlay.of(context);
  final overlayBox = overlayState.context.findRenderObject() as RenderBox;
  final origin = box.localToGlobal(Offset.zero, ancestor: overlayBox);
  final anchorRect = origin & box.size;
  final completer = Completer<void>();
  late OverlayEntry entry;

  void dismiss() {
    if (entry.mounted) entry.remove();
    if (!completer.isCompleted) completer.complete();
  }

  entry = OverlayEntry(
    builder: (overlayContext) {
      return _ComposerPlusMenuOverlay(
        anchorRect: anchorRect,
        runtimeConfig: runtimeConfig,
        canEdit: canEdit,
        canSchedule: threadId.isNotEmpty,
        onDismiss: dismiss,
        onAction: (action) {
          dismiss();
          // Defer so the overlay is gone before sheets / pickers open.
          WidgetsBinding.instance.addPostFrameCallback((_) {
            if (!context.mounted) return;
            _handlePlusMenuAction(
              context: context,
              ref: ref,
              action: action,
              runtimeConfig: runtimeConfig,
              threadId: threadId,
              canEdit: canEdit,
              onChanged: onChanged,
              onPickImage: onPickImage,
              workspacePath: workspacePath,
              initialPrompt: initialPrompt,
              onMessageScheduled: onMessageScheduled,
            );
          });
        },
      );
    },
  );

  overlayState.insert(entry);
  return completer.future;
}

void _handlePlusMenuAction({
  required BuildContext context,
  required WidgetRef ref,
  required ComposerPlusMenuAction action,
  required ThreadRuntimeConfigInput runtimeConfig,
  required String threadId,
  required bool canEdit,
  required ValueChanged<ThreadRuntimeConfigInput> onChanged,
  required VoidCallback onPickImage,
  required String workspacePath,
  required String initialPrompt,
  required VoidCallback? onMessageScheduled,
}) {
  switch (action) {
    case ComposerPlusMenuAction.schedule:
      if (threadId.isEmpty) return;
      unawaited(
        showScheduleEditor(
          context,
          threadId: threadId,
          initialPrompt: initialPrompt,
        ).then((saved) {
          if (saved == true && context.mounted) onMessageScheduled?.call();
        }),
      );
    case ComposerPlusMenuAction.plan:
      if (!canEdit) return;
      if (runtimeConfig.sessionMode == 'plan') return;
      persistRuntimeConfig(
        ref,
        threadId: threadId,
        config: runtimeConfig.copyWith(sessionMode: 'plan'),
        onChanged: onChanged,
      );
    case ComposerPlusMenuAction.ask:
      if (!canEdit) return;
      if (runtimeConfig.sessionMode == 'ask') return;
      persistRuntimeConfig(
        ref,
        threadId: threadId,
        config: runtimeConfig.copyWith(sessionMode: 'ask'),
        onChanged: onChanged,
      );
    case ComposerPlusMenuAction.image:
      onPickImage();
    case ComposerPlusMenuAction.integrations:
      unawaited(
        showComposerRouteCategorySheet(
          context: context,
          runtimeConfig: runtimeConfig,
          threadId: threadId,
          canEdit: canEdit,
          onChanged: onChanged,
          workspacePath: workspacePath,
          category: ComposerRouteCategory.integrations,
        ),
      );
    case ComposerPlusMenuAction.skills:
      unawaited(
        showComposerRouteCategorySheet(
          context: context,
          runtimeConfig: runtimeConfig,
          threadId: threadId,
          canEdit: canEdit,
          onChanged: onChanged,
          workspacePath: workspacePath,
          category: ComposerRouteCategory.skills,
        ),
      );
    case ComposerPlusMenuAction.mcp:
      unawaited(
        showComposerRouteCategorySheet(
          context: context,
          runtimeConfig: runtimeConfig,
          threadId: threadId,
          canEdit: canEdit,
          onChanged: onChanged,
          workspacePath: workspacePath,
          category: ComposerRouteCategory.mcp,
        ),
      );
    case ComposerPlusMenuAction.subagents:
      unawaited(
        showComposerRouteCategorySheet(
          context: context,
          runtimeConfig: runtimeConfig,
          threadId: threadId,
          canEdit: canEdit,
          onChanged: onChanged,
          workspacePath: workspacePath,
          category: ComposerRouteCategory.subagents,
        ),
      );
  }
}

class _ComposerPlusMenuOverlay extends StatefulWidget {
  const _ComposerPlusMenuOverlay({
    required this.anchorRect,
    required this.runtimeConfig,
    required this.canEdit,
    required this.canSchedule,
    required this.onDismiss,
    required this.onAction,
  });

  final Rect anchorRect;
  final ThreadRuntimeConfigInput runtimeConfig;
  final bool canEdit;
  final bool canSchedule;
  final VoidCallback onDismiss;
  final ValueChanged<ComposerPlusMenuAction> onAction;

  @override
  State<_ComposerPlusMenuOverlay> createState() =>
      _ComposerPlusMenuOverlayState();
}

class _ComposerPlusMenuOverlayState extends State<_ComposerPlusMenuOverlay>
    with SingleTickerProviderStateMixin {
  static const _menuWidth = 220.0;
  static const _radius = 16.0;
  static const _rowHeight = 44.0;
  static const _sectionGap = 5.0;
  static const _edgePad = 12.0;
  static const _anchorGap = 8.0;

  late final AnimationController _controller;
  late final Animation<double> _fade;
  late final Animation<double> _scale;

  @override
  void initState() {
    super.initState();
    final reduceMotion = WidgetsBinding
        .instance
        .platformDispatcher
        .accessibilityFeatures
        .disableAnimations;
    _controller = AnimationController(
      vsync: this,
      duration: Duration(milliseconds: reduceMotion ? 120 : 280),
    );
    _fade = CurvedAnimation(parent: _controller, curve: Curves.easeOutCubic);
    // Critically damped feel — no overshoot on a menu that just appeared.
    _scale = Tween<double>(
      begin: reduceMotion ? 1 : 0.92,
      end: 1,
    ).animate(CurvedAnimation(parent: _controller, curve: Curves.easeOutCubic));
    _controller.forward();
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  Future<void> _dismiss() async {
    await _controller.reverse();
    widget.onDismiss();
  }

  @override
  Widget build(BuildContext context) {
    final media = MediaQuery.of(context);
    final viewPadding = media.viewPadding;
    final screen = media.size;
    final modeRows = 2;
    final toolRows = 6;
    final menuHeight =
        modeRows * _rowHeight +
        _sectionGap +
        0.5 +
        toolRows * _rowHeight +
        8; // vertical padding

    // Prefer opening above the “+”; flip below if needed.
    var top = widget.anchorRect.top - menuHeight - _anchorGap;
    if (top < viewPadding.top + 8) {
      top = widget.anchorRect.bottom + _anchorGap;
    }
    top = top.clamp(
      viewPadding.top + 8,
      screen.height - menuHeight - viewPadding.bottom - 8,
    );

    // Align near the trigger; keep inside horizontal edges.
    var left = widget.anchorRect.left;
    left = left.clamp(_edgePad, screen.width - _menuWidth - _edgePad);

    final originX = ((widget.anchorRect.center.dx - left) / _menuWidth).clamp(
      0.0,
      1.0,
    );
    final openingAbove = top + menuHeight <= widget.anchorRect.top + 1;
    final originY = openingAbove ? 1.0 : 0.0;

    final sessionMode = widget.runtimeConfig.sessionMode;
    final l10n = context.l10n;

    return Material(
      type: MaterialType.transparency,
      child: Stack(
        children: [
          Positioned.fill(
            child: GestureDetector(
              onTap: _dismiss,
              behavior: HitTestBehavior.opaque,
              child: FadeTransition(
                opacity: _fade,
                child: ColoredBox(
                  color: ecoColors(context).shadowScrim.withValues(alpha: 0.10),
                ),
              ),
            ),
          ),
          Positioned(
            left: left,
            top: top,
            width: _menuWidth,
            child: FadeTransition(
              opacity: _fade,
              child: ScaleTransition(
                scale: _scale,
                alignment: Alignment(originX * 2 - 1, originY * 2 - 1),
                child: _PlusMenuGlassPanel(
                  radius: _radius,
                  child: Padding(
                    padding: const EdgeInsets.symmetric(vertical: 4),
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        _PlusMenuRow(
                          icon: sessionModeIcon('plan'),
                          label: sessionModeUi('plan', l10n).title,
                          selected: sessionMode == 'plan',
                          enabled: widget.canEdit,
                          onTap: () {
                            HapticFeedback.selectionClick();
                            widget.onAction(ComposerPlusMenuAction.plan);
                          },
                        ),
                        _PlusMenuRow(
                          icon: sessionModeIcon('ask'),
                          label: sessionModeUi('ask', l10n).title,
                          selected: sessionMode == 'ask',
                          enabled: widget.canEdit,
                          onTap: () {
                            HapticFeedback.selectionClick();
                            widget.onAction(ComposerPlusMenuAction.ask);
                          },
                        ),
                        Padding(
                          padding: const EdgeInsets.symmetric(
                            horizontal: 12,
                            vertical: _sectionGap / 2,
                          ),
                          child: Divider(
                            height: 0.5,
                            thickness: 0.5,
                            color: ecoColors(
                              context,
                            ).borderSubtle.withValues(alpha: 0.7),
                          ),
                        ),
                        _PlusMenuRow(
                          icon: Icons.schedule,
                          label: l10n.schedulingNewMessage,
                          enabled: widget.canSchedule,
                          onTap: () =>
                              widget.onAction(ComposerPlusMenuAction.schedule),
                        ),
                        _PlusMenuRow(
                          icon: EcoIcons.image,
                          label: l10n.composerImage,
                          onTap: () {
                            HapticFeedback.selectionClick();
                            widget.onAction(ComposerPlusMenuAction.image);
                          },
                        ),
                        _PlusMenuRow(
                          icon: EcoIcons.skills,
                          label: l10n.composerSkills,
                          showChevron: true,
                          onTap: () {
                            HapticFeedback.selectionClick();
                            widget.onAction(ComposerPlusMenuAction.skills);
                          },
                        ),
                        _PlusMenuRow(
                          icon: EcoIcons.mcp,
                          label: l10n.composerMcpServers,
                          showChevron: true,
                          onTap: () {
                            HapticFeedback.selectionClick();
                            widget.onAction(ComposerPlusMenuAction.mcp);
                          },
                        ),
                        _PlusMenuRow(
                          icon: Icons.extension_outlined,
                          label: l10n.composerIntegrations,
                          showChevron: true,
                          onTap: () {
                            HapticFeedback.selectionClick();
                            widget.onAction(
                              ComposerPlusMenuAction.integrations,
                            );
                          },
                        ),
                        _PlusMenuRow(
                          icon: EcoIcons.subagents,
                          label: l10n.composerSubagents,
                          showChevron: true,
                          onTap: () {
                            HapticFeedback.selectionClick();
                            widget.onAction(ComposerPlusMenuAction.subagents);
                          },
                        ),
                      ],
                    ),
                  ),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _PlusMenuGlassPanel extends StatelessWidget {
  const _PlusMenuGlassPanel({required this.child, required this.radius});

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

class _PlusMenuRow extends StatelessWidget {
  const _PlusMenuRow({
    required this.icon,
    required this.label,
    required this.onTap,
    this.selected = false,
    this.enabled = true,
    this.showChevron = false,
  });

  final IconData icon;
  final String label;
  final VoidCallback onTap;
  final bool selected;
  final bool enabled;
  final bool showChevron;

  @override
  Widget build(BuildContext context) {
    final eco = ecoColors(context);
    final isDark = Theme.of(context).brightness == Brightness.dark;
    final color = !enabled
        ? eco.textMuted.withValues(alpha: 0.55)
        : eco.textPrimary;
    final iconColor = !enabled
        ? eco.textMuted.withValues(alpha: 0.45)
        : (selected ? eco.accent : eco.textSecondary);

    return EcoPressable(
      enabled: enabled,
      scale: 0.98,
      onTap: onTap,
      child: Opacity(
        opacity: enabled ? 1 : 0.55,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(6, 2, 6, 2),
          child: AnimatedContainer(
            duration: const Duration(milliseconds: 160),
            curve: Curves.easeOutCubic,
            height: _ComposerPlusMenuOverlayState._rowHeight - 4,
            padding: const EdgeInsets.symmetric(horizontal: 12),
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
                Icon(icon, size: 18, color: iconColor),
                const SizedBox(width: 12),
                Expanded(
                  child: Text(
                    label,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontSize: 15,
                      fontWeight: FontWeight.w500,
                      letterSpacing: -0.25,
                      color: color,
                    ),
                  ),
                ),
                if (showChevron)
                  Icon(EcoIcons.chevronRight, size: 16, color: eco.textMuted),
              ],
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
