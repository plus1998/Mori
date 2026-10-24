import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../../core/locale/app_localizations_ext.dart';
import '../../core/models/thread_runtime_config.dart';
import '../../core/models/thread_usage_models.dart';
import '../../core/theme/eco_icons.dart';
import '../../core/theme/eco_theme.dart';
import '../../core/widgets/eco_action_sheet.dart';
import '../../core/widgets/eco_grouped_list.dart';
import '../../core/utils/model_id.dart';
import '../../core/utils/thread_usage_display.dart';
import '../../l10n/generated/app_localizations.dart';
import 'codex_quota_page.dart';

Future<void> showThreadContextSheet({
  required BuildContext context,
  required ThreadContextSnapshot? contextSnapshot,
  required String? threadStatus,
  ThreadBillingSnapshot? billing,
  String? currentMainModelId,
  String? mainAgentConfigName,
  SubagentThemeSource? themeSource,
  bool showContextUsage = true,
  bool showBilling = true,
  bool showCodexQuota = false,
}) {
  return showEcoActionSheet<void>(
    context: context,
    isScrollControlled: true,
    builder: (context) {
      return EcoSheetScaffold(
        maxHeightFactor: 0.88,
        child: _ContextBillingTabs(
          contextSnapshot: contextSnapshot,
          billing: billing,
          threadStatus: threadStatus,
          currentMainModelId: currentMainModelId,
          mainAgentConfigName: mainAgentConfigName,
          themeSource: themeSource,
          showContextUsage: showContextUsage,
          showBilling: showBilling,
          showCodexQuota: showCodexQuota,
        ),
      );
    },
  );
}

class _ContextBillingTabs extends StatefulWidget {
  const _ContextBillingTabs({
    required this.contextSnapshot,
    required this.billing,
    required this.threadStatus,
    required this.currentMainModelId,
    required this.mainAgentConfigName,
    required this.themeSource,
    this.showContextUsage = true,
    this.showBilling = true,
    this.showCodexQuota = false,
  });

  final ThreadContextSnapshot? contextSnapshot;
  final ThreadBillingSnapshot? billing;
  final String? threadStatus;
  final String? currentMainModelId;
  final String? mainAgentConfigName;
  final SubagentThemeSource? themeSource;
  final bool showContextUsage;
  final bool showBilling;
  final bool showCodexQuota;

  @override
  State<_ContextBillingTabs> createState() => _ContextBillingTabsState();
}

class _ContextBillingTabsState extends State<_ContextBillingTabs> {
  late final PageController _pageController;
  var _page = 0;

  @override
  void initState() {
    super.initState();
    _pageController = PageController();
  }

  @override
  void dispose() {
    _pageController.dispose();
    super.dispose();
  }

  void _selectPage(int page) {
    if (_page == page) return;
    _pageController.animateToPage(
      page,
      duration: const Duration(milliseconds: 220),
      curve: Curves.easeOutCubic,
    );
  }

  @override
  Widget build(BuildContext context) {
    final pages = <Widget>[];
    final labels = <String>[];
    if (widget.showContextUsage) {
      labels.add(context.l10n.billingContext);
      pages.add(
        _ContextPage(
          snapshot: widget.contextSnapshot,
          threadStatus: widget.threadStatus,
          themeSource: widget.themeSource,
          mainAgentConfigName: widget.mainAgentConfigName,
          currentMainModelId: widget.currentMainModelId,
        ),
      );
    }
    if (widget.showBilling) {
      labels.add(context.l10n.billingTitle);
      pages.add(
        _BillingPage(
          billing: widget.billing,
          threadStatus: widget.threadStatus,
          currentMainModelId: widget.currentMainModelId,
        ),
      );
    }

    if (widget.showCodexQuota) {
      labels.add(context.l10n.codexQuotaTab);
      pages.add(const CodexQuotaPage());
    }

    return Column(
      children: [
        _ContextBillingTitleTabs(
          page: _page,
          labels: labels,
          onSelected: _selectPage,
        ),
        Expanded(
          child: PageView(
            controller: _pageController,
            onPageChanged: (page) => setState(() => _page = page),
            children: pages,
          ),
        ),
      ],
    );
  }
}

class _ContextBillingTitleTabs extends StatelessWidget {
  const _ContextBillingTitleTabs({
    required this.page,
    required this.labels,
    required this.onSelected,
  });

  final int page;
  final List<String> labels;
  final ValueChanged<int> onSelected;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(24, 4, 24, 12),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.center,
        crossAxisAlignment: CrossAxisAlignment.center,
        children: [
          for (var i = 0; i < labels.length; i++) ...[
            if (i > 0) const SizedBox(width: 14),
            _ContextBillingTitleTab(
              label: labels[i],
              active: page == i,
              onTap: () => onSelected(i),
            ),
          ],
        ],
      ),
    );
  }
}

class _ContextBillingTitleTab extends StatelessWidget {
  const _ContextBillingTitleTab({
    required this.label,
    required this.active,
    required this.onTap,
  });

  final String label;
  final bool active;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final eco = ecoColors(context);
    final baseStyle = Theme.of(context).textTheme.titleMedium;

    return Semantics(
      button: true,
      selected: active,
      label: label,
      child: GestureDetector(
        onTap: onTap,
        behavior: HitTestBehavior.opaque,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 4),
          child: AnimatedDefaultTextStyle(
            duration: const Duration(milliseconds: 200),
            curve: Curves.easeOutCubic,
            style: (baseStyle ?? const TextStyle()).copyWith(
              fontSize: active ? 22 : 15,
              fontWeight: active ? FontWeight.w700 : FontWeight.w500,
              letterSpacing: active ? -0.45 : -0.15,
              height: 1.1,
              color: active
                  ? eco.textPrimary
                  : eco.textMuted.withValues(alpha: 0.55),
            ),
            child: Text(label),
          ),
        ),
      ),
    );
  }
}

class _ContextPage extends StatelessWidget {
  const _ContextPage({
    required this.snapshot,
    required this.threadStatus,
    required this.themeSource,
    required this.mainAgentConfigName,
    required this.currentMainModelId,
  });

  final ThreadContextSnapshot? snapshot;
  final String? threadStatus;
  final SubagentThemeSource? themeSource;
  final String? mainAgentConfigName;
  final String? currentMainModelId;

  @override
  Widget build(BuildContext context) {
    final planner = snapshot == null ? null : resolvePlannerContext(snapshot!);
    return ListView(
      padding: const EdgeInsets.only(bottom: 8),
      children: [
        if (planner == null)
          Padding(
            padding: const EdgeInsets.fromLTRB(28, 24, 28, 16),
            child: Text(
              contextCardPlaceholder(threadStatus, context.l10n),
              textAlign: TextAlign.center,
              style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                color: ecoColors(context).textMuted,
                height: 1.4,
              ),
            ),
          )
        else ...[
          _ContextHero(
            role: planner,
            mainAgentConfigName: mainAgentConfigName,
            currentMainModelId: currentMainModelId,
          ),
          EcoGroupedSection(
            label: context.l10n.billingComposition,
            topSpacing: 20,
            child: _ContextSegmentList(role: planner),
          ),
          ..._buildSubagentSections(
            snapshot!,
            themeSource: themeSource,
            l10n: context.l10n,
          ),
        ],
      ],
    );
  }
}

class _BillingPage extends StatelessWidget {
  const _BillingPage({
    required this.billing,
    required this.threadStatus,
    required this.currentMainModelId,
  });

  final ThreadBillingSnapshot? billing;
  final String? threadStatus;
  final String? currentMainModelId;

  @override
  Widget build(BuildContext context) {
    final mainModelLabel = billing == null
        ? ''
        : resolveBillingMainModelLabel(
            billing!,
            currentMainModelId: currentMainModelId,
          );
    return ListView(
      padding: const EdgeInsets.only(bottom: 8),
      children: [
        if (billing == null)
          Padding(
            padding: const EdgeInsets.fromLTRB(28, 24, 28, 16),
            child: Text(
              billingEmptyHint(threadStatus, context.l10n),
              textAlign: TextAlign.center,
              style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                color: ecoColors(context).textMuted,
                height: 1.4,
              ),
            ),
          )
        else ...[
          _BillingHero(billing: billing!),
          if (billing!.savedUsd > 0)
            EcoGroupedSection(
              label: context.l10n.billingComparison,
              topSpacing: 20,
              child: Column(
                children: [
                  _InsetMetricTile(
                    label: context.l10n.billingUnorchestrated,
                    subtitle: mainModelLabel.isNotEmpty
                        ? context.l10n.billingPlannerEstimate(mainModelLabel)
                        : context.l10n.billingMainModelEstimate,
                    value: formatCostUsd(billing!.plannerTokenCostUsd),
                  ),
                  const EcoGroupedDivider(indent: 16),
                  _InsetMetricTile(
                    label: context.l10n.billingEco,
                    subtitle: context.l10n.billingEcoSubtitle,
                    value: formatCostUsd(billing!.ecoCostUsd),
                    emphasized: true,
                  ),
                  const EcoGroupedDivider(indent: 16),
                  _InsetMetricTile(
                    label: context.l10n.billingSavings,
                    value: formatSavingsLine(
                      billing!.savedUsd,
                      billing!.savedPct,
                      context.l10n,
                    ),
                    valueColor: ecoColors(context).success,
                  ),
                ],
              ),
            ),
          EcoGroupedSection(
            label: context.l10n.billingTokenUsage,
            topSpacing: 20,
            child: Column(
              children: [
                _InsetMetricTile(
                  label: context.l10n.billingCacheHitRate,
                  value: formatBillingCacheHitRate(billing!),
                  emphasized: true,
                ),
                const EcoGroupedDivider(indent: 16),
                _InsetMetricTile(
                  label: context.l10n.billingInput,
                  value: _formatTokenCount(billing!.inputTokens),
                ),
                const EcoGroupedDivider(indent: 16),
                _InsetMetricTile(
                  label: context.l10n.billingOutput,
                  value: _formatTokenCount(billing!.outputTokens),
                ),
                if (billing!.cacheReadTokens > 0) ...[
                  const EcoGroupedDivider(indent: 16),
                  _InsetMetricTile(
                    label: context.l10n.billingCacheRead,
                    value: _formatTokenCount(billing!.cacheReadTokens),
                  ),
                ],
                if (billing!.cacheCreationTokens > 0) ...[
                  const EcoGroupedDivider(indent: 16),
                  _InsetMetricTile(
                    label: context.l10n.billingCacheWrite,
                    value: _formatTokenCount(billing!.cacheCreationTokens),
                  ),
                ],
              ],
            ),
          ),
          if (billing!.byModel.isNotEmpty)
            EcoGroupedSection(
              label: context.l10n.billingByModel,
              topSpacing: 20,
              child: Column(
                children: [
                  for (var i = 0; i < billing!.byModel.length; i++) ...[
                    if (i > 0) const EcoGroupedDivider(indent: 16),
                    _InsetMetricTile(
                      label: formatBillingModelLabel(billing!.byModel[i]),
                      value: formatCostUsd(billing!.byModel[i].ecoCostUsd),
                    ),
                  ],
                ],
              ),
            ),
        ],
      ],
    );
  }
}

List<Widget> _buildSubagentSections(
  ThreadContextSnapshot snapshot, {
  SubagentThemeSource? themeSource,
  required AppLocalizations l10n,
}) {
  final rows = buildFlatSubagentContextRows(
    snapshot,
    themeSource: themeSource,
    l10n: l10n,
  );
  if (rows.isEmpty) return const [];

  return [
    for (final row in rows)
      EcoGroupedSection(
        label: row.title,
        topSpacing: 20,
        child: Column(
          children: [
            _ContextOccupancyTile(
              role: row.snapshot,
              accentColor: row.accentColor,
            ),
            if (row.snapshot.segments.any((s) => s.tokens > 0)) ...[
              const EcoGroupedDivider(indent: 16),
              _ContextSegmentList(role: row.snapshot),
            ],
          ],
        ),
      ),
  ];
}

String _formatTokenCount(int value) {
  if (value < 1000) return '$value';
  return formatContextK(value);
}

class _BillingHero extends StatelessWidget {
  const _BillingHero({required this.billing});

  final ThreadBillingSnapshot billing;

  @override
  Widget build(BuildContext context) {
    final eco = ecoColors(context);
    final savedPositive = billing.savedUsd > 0;

    return Padding(
      padding: const EdgeInsets.fromLTRB(24, 4, 24, 0),
      child: Column(
        children: [
          Text(
            formatCostUsd(billing.ecoCostUsd),
            style: Theme.of(context).textTheme.displaySmall?.copyWith(
              fontSize: 40,
              fontWeight: FontWeight.w700,
              letterSpacing: -1.2,
              height: 1.05,
              fontFeatures: const [FontFeature.tabularFigures()],
            ),
          ),
          const SizedBox(height: 8),
          Text(
            savedPositive
                ? formatSavingsLine(
                    billing.savedUsd,
                    billing.savedPct,
                    context.l10n,
                  )
                : context.l10n.billingEcoSubtitle,
            style: Theme.of(context).textTheme.bodyMedium?.copyWith(
              color: savedPositive ? eco.success : eco.textMuted,
              fontWeight: savedPositive ? FontWeight.w500 : FontWeight.w400,
            ),
          ),
        ],
      ),
    );
  }
}

class _ContextHero extends StatelessWidget {
  const _ContextHero({
    required this.role,
    required this.mainAgentConfigName,
    required this.currentMainModelId,
  });

  final ThreadRoleContextSnapshot role;
  final String? mainAgentConfigName;
  final String? currentMainModelId;

  @override
  Widget build(BuildContext context) {
    final eco = ecoColors(context);
    final pctColor = _occupancyColor(eco, role.occupancyPct);
    final configName = mainAgentConfigName?.trim() ?? '';
    final modelId =
        (role.modelId?.trim().isNotEmpty == true
            ? role.modelId!.trim()
            : currentMainModelId?.trim()) ??
        '';
    final showConfigCard = configName.isNotEmpty || modelId.isNotEmpty;

    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(24, 4, 24, 0),
          child: Column(
            children: [
              SizedBox(
                width: 112,
                height: 112,
                child: CustomPaint(
                  painter: _ContextRingPainter(
                    progress: role.limit > 0
                        ? (role.occupied / role.limit).clamp(0.0, 1.0)
                        : 0,
                    trackColor: eco.borderSubtle.withValues(
                      alpha: Theme.of(context).brightness == Brightness.dark
                          ? 0.45
                          : 0.2,
                    ),
                    progressColor: pctColor,
                    strokeWidth: 8,
                  ),
                  child: Center(
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Text(
                          '${role.occupancyPct}',
                          style: Theme.of(context).textTheme.headlineMedium
                              ?.copyWith(
                                fontWeight: FontWeight.w700,
                                letterSpacing: -0.8,
                                height: 1,
                                fontFeatures: const [
                                  FontFeature.tabularFigures(),
                                ],
                              ),
                        ),
                        Text(
                          '%',
                          style: Theme.of(context).textTheme.labelMedium
                              ?.copyWith(color: eco.textMuted),
                        ),
                      ],
                    ),
                  ),
                ),
              ),
              const SizedBox(height: 14),
              Text(
                formatOccupancyLabel(role.occupancyPct, context.l10n),
                style: Theme.of(context).textTheme.titleSmall?.copyWith(
                  color: pctColor,
                  fontWeight: FontWeight.w600,
                ),
              ),
              const SizedBox(height: 4),
              Text(
                '~${formatContextK(role.occupied)} / ${formatContextK(role.limit)} tokens',
                style: Theme.of(context).textTheme.bodySmall?.copyWith(
                  color: eco.textMuted,
                  fontFeatures: const [FontFeature.tabularFigures()],
                ),
              ),
            ],
          ),
        ),
        if (showConfigCard) ...[
          const SizedBox(height: 16),
          _MainAgentConfigCard(configName: configName, modelId: modelId),
        ],
      ],
    );
  }
}

class _MainAgentConfigCard extends StatelessWidget {
  const _MainAgentConfigCard({required this.configName, required this.modelId});

  final String configName;
  final String modelId;

  @override
  Widget build(BuildContext context) {
    final eco = ecoColors(context);
    final modelLabel = modelId.isEmpty ? '' : shortenModelId(modelId);
    final title = configName.isNotEmpty ? configName : modelLabel;
    final subtitle = configName.isNotEmpty ? modelLabel : '';

    return EcoGroupedSurface(
      padding: const EdgeInsets.fromLTRB(16, 14, 16, 14),
      child: Row(
        children: [
          Container(
            width: 36,
            height: 36,
            decoration: BoxDecoration(
              color: eco.accent.withValues(alpha: 0.12),
              borderRadius: BorderRadius.circular(10),
            ),
            alignment: Alignment.center,
            child: Icon(EcoIcons.agent, size: 18, color: eco.accent),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  title,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: Theme.of(context).textTheme.bodyLarge?.copyWith(
                    fontSize: 16,
                    fontWeight: FontWeight.w600,
                    letterSpacing: -0.25,
                  ),
                ),
                if (subtitle.isNotEmpty) ...[
                  const SizedBox(height: 2),
                  Text(
                    subtitle,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: Theme.of(context).textTheme.bodySmall?.copyWith(
                      color: eco.textMuted,
                      letterSpacing: -0.08,
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

class _ContextOccupancyTile extends StatelessWidget {
  const _ContextOccupancyTile({required this.role, this.accentColor});

  final ThreadRoleContextSnapshot role;
  final Color? accentColor;

  @override
  Widget build(BuildContext context) {
    final eco = ecoColors(context);
    final pctColor = _occupancyColor(
      eco,
      role.occupancyPct,
      accent: accentColor,
    );
    final ratio = role.limit > 0
        ? (role.occupied / role.limit).clamp(0.0, 1.0)
        : 0.0;

    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 14, 16, 14),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              if (accentColor != null) ...[
                Container(
                  width: 8,
                  height: 8,
                  decoration: BoxDecoration(
                    color: accentColor,
                    shape: BoxShape.circle,
                  ),
                ),
                const SizedBox(width: 8),
              ],
              Expanded(
                child: Text(
                  formatOccupancyLabel(role.occupancyPct, context.l10n),
                  style: Theme.of(context).textTheme.bodyLarge?.copyWith(
                    fontSize: 17,
                    letterSpacing: -0.2,
                    color: pctColor,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ),
              Text(
                '~${formatContextK(role.occupied)} / ${formatContextK(role.limit)}',
                style: Theme.of(context).textTheme.bodySmall?.copyWith(
                  color: eco.textMuted,
                  fontFeatures: const [FontFeature.tabularFigures()],
                ),
              ),
            ],
          ),
          const SizedBox(height: 10),
          ClipRRect(
            borderRadius: BorderRadius.circular(999),
            child: LinearProgressIndicator(
              value: ratio,
              minHeight: 5,
              backgroundColor: eco.borderSubtle.withValues(
                alpha: Theme.of(context).brightness == Brightness.dark
                    ? 0.4
                    : 0.18,
              ),
              color: pctColor,
            ),
          ),
        ],
      ),
    );
  }
}

class _ContextSegmentList extends StatelessWidget {
  const _ContextSegmentList({required this.role});

  final ThreadRoleContextSnapshot role;

  @override
  Widget build(BuildContext context) {
    final eco = ecoColors(context);
    final segments = role.segments
        .where((segment) => segment.tokens > 0)
        .toList();
    if (segments.isEmpty) {
      return EcoGroupedTile(
        padding: const EdgeInsets.fromLTRB(16, 14, 16, 14),
        child: Text(
          context.l10n.billingNoComposition,
          style: Theme.of(
            context,
          ).textTheme.bodyMedium?.copyWith(color: eco.textMuted),
        ),
      );
    }

    return Column(
      children: [
        for (var i = 0; i < segments.length; i++) ...[
          if (i > 0) const EcoGroupedDivider(indent: 16),
          EcoGroupedTile(
            padding: const EdgeInsets.fromLTRB(16, 12, 16, 12),
            child: Row(
              children: [
                Expanded(
                  child: Text(
                    segments[i].label,
                    style: Theme.of(context).textTheme.bodyLarge?.copyWith(
                      fontSize: 17,
                      letterSpacing: -0.2,
                    ),
                  ),
                ),
                Text(
                  formatContextK(segments[i].tokens),
                  style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                    color: eco.textMuted,
                    fontFeatures: const [FontFeature.tabularFigures()],
                  ),
                ),
              ],
            ),
          ),
        ],
      ],
    );
  }
}

class _InsetMetricTile extends StatelessWidget {
  const _InsetMetricTile({
    required this.label,
    required this.value,
    this.subtitle,
    this.emphasized = false,
    this.valueColor,
  });

  final String label;
  final String value;
  final String? subtitle;
  final bool emphasized;
  final Color? valueColor;

  @override
  Widget build(BuildContext context) {
    final eco = ecoColors(context);
    return EcoGroupedTile(
      padding: const EdgeInsets.fromLTRB(16, 12, 16, 12),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.center,
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  label,
                  style: Theme.of(context).textTheme.bodyLarge?.copyWith(
                    fontSize: 17,
                    letterSpacing: -0.2,
                    fontWeight: emphasized ? FontWeight.w600 : FontWeight.w400,
                  ),
                ),
                if (subtitle != null) ...[
                  const SizedBox(height: 2),
                  Text(
                    subtitle!,
                    style: Theme.of(
                      context,
                    ).textTheme.bodySmall?.copyWith(color: eco.textMuted),
                  ),
                ],
              ],
            ),
          ),
          const SizedBox(width: 12),
          Text(
            value,
            style: Theme.of(context).textTheme.bodyLarge?.copyWith(
              fontSize: 17,
              letterSpacing: -0.2,
              color: valueColor ?? (emphasized ? eco.success : eco.textPrimary),
              fontWeight: emphasized ? FontWeight.w700 : FontWeight.w500,
              fontFeatures: const [FontFeature.tabularFigures()],
            ),
          ),
        ],
      ),
    );
  }
}

Color _occupancyColor(EcoColors eco, int pct, {Color? accent}) {
  if (pct >= 95) return eco.danger;
  if (pct >= 85) return eco.warnAccent;
  return accent ?? eco.accent;
}

class _ContextRingPainter extends CustomPainter {
  _ContextRingPainter({
    required this.progress,
    required this.trackColor,
    required this.progressColor,
    required this.strokeWidth,
  });

  final double progress;
  final Color trackColor;
  final Color progressColor;
  final double strokeWidth;

  @override
  void paint(Canvas canvas, Size size) {
    final center = Offset(size.width / 2, size.height / 2);
    final radius = (math.min(size.width, size.height) - strokeWidth) / 2;
    final track = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = strokeWidth
      ..color = trackColor;
    final arc = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = strokeWidth
      ..strokeCap = StrokeCap.round
      ..color = progressColor;

    canvas.drawCircle(center, radius, track);
    if (progress > 0) {
      canvas.drawArc(
        Rect.fromCircle(center: center, radius: radius),
        -math.pi / 2,
        2 * math.pi * progress,
        false,
        arc,
      );
    }
  }

  @override
  bool shouldRepaint(covariant _ContextRingPainter oldDelegate) {
    return oldDelegate.progress != progress ||
        oldDelegate.progressColor != progressColor ||
        oldDelegate.trackColor != trackColor;
  }
}
