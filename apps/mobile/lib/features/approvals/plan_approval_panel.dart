import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../../core/locale/app_localizations_ext.dart';
import '../../core/models/thread_models.dart';
import '../../core/models/plan_execution.dart';
import '../../core/theme/eco_icons.dart';
import '../../core/theme/eco_theme.dart';
import '../../core/widgets/eco_markdown.dart';
import '../composer/composer_dock_shell.dart';
import 'plan_execution_options.dart';

const planApprovalCollapsedMarkdownMaxHeight = 220.0;
const planApprovalExpandedHeightFactor = 0.85;

/// Matches the bottom padding applied around the expanded dock card.
const planApprovalPanelBottomPadding = 10.0;

/// Cap expanded height so the dock stays below the session title chrome.
///
/// The panel sits in an unbounded bottom [Stack] slot (see
/// [ThreadSessionConversationLayout]), so a raw `0.85 * screenHeight` grows
/// under the transparent AppBar and overlaps the title. Reserve:
/// - [paddingTop]: Scaffold-inflated AppBar / status chrome
/// - [paddingBottom]: home indicator (SafeArea still applies it)
/// - [planApprovalPanelBottomPadding]: card inset
/// - [composerDockTopSpacing]: shell gap above this panel
double planApprovalExpandedHeight({
  required double viewportHeight,
  required double paddingTop,
  required double paddingBottom,
}) {
  final preferred = viewportHeight * planApprovalExpandedHeightFactor;
  final available =
      viewportHeight -
      paddingTop -
      paddingBottom -
      planApprovalPanelBottomPadding -
      composerDockTopSpacing;
  return math.max(0, math.min(preferred, available));
}

class PlanApprovalPanel extends StatefulWidget {
  const PlanApprovalPanel({
    super.key,
    required this.plan,
    required this.busy,
    required this.onApprove,
    required this.onDismiss,
    this.failureMessage,
    this.modelControl,
    this.onScheduleExecution,
    this.onApproveWithSubagent,
    this.onStartNewSession,
    this.delegationAgents = const [],
  });

  final ThreadPendingPlan plan;
  final bool busy;
  final Future<void> Function() onApprove;
  final Future<void> Function() onDismiss;
  final String? failureMessage;
  final Widget? modelControl;
  final Future<void> Function()? onScheduleExecution;
  final Future<void> Function(PlanExecutionTarget target)?
  onApproveWithSubagent;
  final Future<void> Function()? onStartNewSession;
  final List<PlanDelegationAgentOption> delegationAgents;

  @override
  State<PlanApprovalPanel> createState() => _PlanApprovalPanelState();
}

class _PlanApprovalPanelState extends State<PlanApprovalPanel> {
  var _expanded = false;
  var _executeMenuOpen = false;

  Future<void> _showExecutionOptions() async {
    if (_executeMenuOpen || widget.busy) return;
    final plan = widget.plan;
    _executeMenuOpen = true;
    try {
      final selection = await showPlanExecutionOptions(
        context,
        agents: widget.onApproveWithSubagent == null
            ? const []
            : widget.delegationAgents,
        canSchedule: widget.onScheduleExecution != null,
        canStartNewSession: widget.onStartNewSession != null,
      );
      if (!mounted ||
          widget.busy ||
          widget.failureMessage != null ||
          widget.plan.referenceId != plan.referenceId ||
          widget.plan.plan != plan.plan) {
        return;
      }
      switch (selection?.action) {
        case PlanExecutionAction.schedule:
          await widget.onScheduleExecution?.call();
        case PlanExecutionAction.subagent:
          await widget.onApproveWithSubagent?.call(selection!.target!);
        case PlanExecutionAction.newSession:
          await widget.onStartNewSession?.call();
        case null:
          break;
      }
    } finally {
      _executeMenuOpen = false;
    }
  }

  @override
  Widget build(BuildContext context) {
    final colors = ecoColors(context);
    final isDark = Theme.of(context).brightness == Brightness.dark;
    final canApprove =
        widget.plan.plan.trim().isNotEmpty && widget.failureMessage == null;
    final media = MediaQuery.of(context);
    final expandedHeight = planApprovalExpandedHeight(
      viewportHeight: media.size.height,
      paddingTop: media.padding.top,
      paddingBottom: media.padding.bottom,
    );
    final expandLabel = _expanded
        ? context.l10n.approvalPlanCollapse
        : context.l10n.approvalPlanExpand;

    return SafeArea(
      top: false,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(
          12,
          0,
          12,
          planApprovalPanelBottomPadding,
        ),
        child: AnimatedSize(
          duration: const Duration(milliseconds: 280),
          curve: Curves.easeOutCubic,
          alignment: Alignment.bottomCenter,
          child: SizedBox(
            key: const Key('plan-approval-panel'),
            height: _expanded ? expandedHeight : null,
            width: double.infinity,
            child: DecoratedBox(
              decoration: BoxDecoration(
                color: colors.composerContextBg,
                borderRadius: BorderRadius.circular(22),
                border: Border.all(color: colors.composerPillBorder),
                boxShadow: [
                  BoxShadow(
                    color: colors.shadowScrim.withValues(
                      alpha: isDark ? 0.22 : 0.05,
                    ),
                    blurRadius: 16,
                    offset: const Offset(0, 4),
                  ),
                  BoxShadow(
                    color: colors.shadowScrim.withValues(
                      alpha: isDark ? 0.12 : 0.04,
                    ),
                    blurRadius: 2,
                    offset: const Offset(0, 1),
                  ),
                ],
              ),
              child: ClipRRect(
                borderRadius: BorderRadius.circular(22),
                child: Padding(
                  padding: const EdgeInsets.fromLTRB(18, 18, 18, 14),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    mainAxisSize: _expanded
                        ? MainAxisSize.max
                        : MainAxisSize.min,
                    children: [
                      Row(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Expanded(
                            child: Text(
                              context.l10n.approvalImplementPlan,
                              style: Theme.of(context).textTheme.bodyLarge
                                  ?.copyWith(
                                    fontWeight: FontWeight.w400,
                                    height: 1.5,
                                  ),
                            ),
                          ),
                          IconButton(
                            key: const Key('plan-approval-expand'),
                            onPressed: () =>
                                setState(() => _expanded = !_expanded),
                            tooltip: expandLabel,
                            icon: Icon(
                              _expanded
                                  ? EcoIcons.collapseFullscreen
                                  : EcoIcons.expandFullscreen,
                              size: 18,
                            ),
                            visualDensity: VisualDensity.compact,
                            style: IconButton.styleFrom(
                              foregroundColor: colors.textMuted,
                              padding: EdgeInsets.zero,
                              minimumSize: const Size(32, 32),
                              tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                            ),
                          ),
                        ],
                      ),
                      if (widget.failureMessage != null) ...[
                        const SizedBox(height: 10),
                        DecoratedBox(
                          decoration: BoxDecoration(
                            color: colors.dangerSoft,
                            borderRadius: BorderRadius.circular(10),
                            border: Border.all(
                              color: colors.danger.withValues(alpha: 0.35),
                            ),
                          ),
                          child: Padding(
                            padding: const EdgeInsets.all(12),
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(
                                  context.l10n.approvalLastRunFailed,
                                  style: Theme.of(context).textTheme.labelLarge
                                      ?.copyWith(color: colors.danger),
                                ),
                                const SizedBox(height: 4),
                                Text(
                                  widget.failureMessage!,
                                  style: Theme.of(context).textTheme.bodySmall
                                      ?.copyWith(
                                        color: colors.danger,
                                        height: 1.45,
                                      ),
                                ),
                              ],
                            ),
                          ),
                        ),
                      ],
                      const SizedBox(height: 12),
                      if (_expanded)
                        Expanded(
                          child: SingleChildScrollView(
                            child: EcoMarkdown(text: widget.plan.plan),
                          ),
                        )
                      else
                        ConstrainedBox(
                          constraints: const BoxConstraints(
                            maxHeight: planApprovalCollapsedMarkdownMaxHeight,
                          ),
                          child: SingleChildScrollView(
                            child: EcoMarkdown(text: widget.plan.plan),
                          ),
                        ),
                      if (widget.modelControl != null)
                        Align(
                          alignment: Alignment.centerLeft,
                          child: widget.modelControl!,
                        ),
                      const SizedBox(height: 10),
                      Row(
                        children: [
                          TextButton(
                            onPressed: widget.busy
                                ? null
                                : () => widget.onDismiss(),
                            style: TextButton.styleFrom(
                              foregroundColor: colors.textMuted,
                              padding: const EdgeInsets.symmetric(
                                horizontal: 10,
                              ),
                            ),
                            child: Text(
                              widget.busy
                                  ? context.l10n.commonProcessing
                                  : context.l10n.approvalIgnore,
                            ),
                          ),
                          const SizedBox(width: 8),
                          if (canApprove)
                            Flexible(
                              child: Align(
                                alignment: Alignment.centerRight,
                                child: FilledButton(
                                  key: const Key('plan-approval-execute'),
                                  onPressed: widget.busy
                                      ? null
                                      : () => widget.onApprove(),
                                  onLongPress:
                                      widget.busy ||
                                          (widget.onScheduleExecution == null &&
                                              widget.onStartNewSession ==
                                                  null &&
                                              !(widget.onApproveWithSubagent !=
                                                      null &&
                                                  widget.delegationAgents.any(
                                                    (agent) =>
                                                        agent.canExecutePlan,
                                                  )))
                                      ? null
                                      : _showExecutionOptions,
                                  style: FilledButton.styleFrom(
                                    backgroundColor: isDark
                                        ? colors.composerSendBg
                                        : const Color(0xFF0D0D0D),
                                    foregroundColor: isDark
                                        ? colors.composerSendText
                                        : Colors.white,
                                    minimumSize: const Size(0, 34),
                                    padding: const EdgeInsets.symmetric(
                                      horizontal: 16,
                                    ),
                                    shape: const StadiumBorder(),
                                  ),
                                  child: widget.busy
                                      ? SizedBox(
                                          width: 16,
                                          height: 16,
                                          child: CircularProgressIndicator(
                                            strokeWidth: 2,
                                            color: isDark
                                                ? colors.composerSendText
                                                : Colors.white,
                                          ),
                                        )
                                      : Text(
                                          context.l10n.approvalExecutePlan,
                                          maxLines: 1,
                                          overflow: TextOverflow.ellipsis,
                                        ),
                                ),
                              ),
                            ),
                        ],
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
