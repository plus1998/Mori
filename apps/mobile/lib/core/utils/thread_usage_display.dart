import 'package:flutter/material.dart';

import '../../l10n/generated/app_localizations.dart';
import '../models/thread_runtime_config.dart';
import '../models/thread_usage_models.dart';
import '../theme/subagent_theme.dart';
import 'model_id.dart';

String formatCostUsd(double value) {
  if (value <= 0) {
    return '\$0';
  }
  if (value < 0.01) {
    return '\$${value.toStringAsFixed(4)}';
  }
  if (value < 1) {
    return '\$${value.toStringAsFixed(3)}';
  }
  return '\$${value.toStringAsFixed(2)}';
}

String formatBillingPillCost(ThreadBillingSnapshot? billing) {
  return formatCostUsd(billing?.ecoCostUsd ?? 0);
}

String formatBillingCacheHitRate(ThreadBillingSnapshot billing) {
  final cacheRead = billing.cacheReadTokens < 0 ? 0 : billing.cacheReadTokens;
  final input = billing.inputTokens < 0 ? 0 : billing.inputTokens;
  final cacheCreation = billing.cacheCreationTokens < 0
      ? 0
      : billing.cacheCreationTokens;
  final promptTokens = input + cacheRead + cacheCreation;
  final ratio = promptTokens > 0 ? cacheRead / promptTokens : 0;
  return '${(ratio * 100).round()}%';
}

String resolveBillingMainModelLabel(
  ThreadBillingSnapshot billing, {
  String? currentMainModelId,
}) {
  final currentModel = currentMainModelId?.trim();
  if (currentModel != null && currentModel.isNotEmpty) {
    return shortenModelId(currentModel);
  }
  final billedModel = billing.plannerModelLabel?.split(' · ').first.trim();
  return billedModel == null || billedModel.isEmpty ? '' : billedModel;
}

String formatSavingsLine(
  double savedUsd,
  double savedPct,
  AppLocalizations l10n,
) {
  if (savedUsd <= 0) {
    return l10n.usageNoSavings;
  }
  final pct = savedPct > 0 ? ' ${savedPct.toStringAsFixed(0)}%' : '';
  return l10n.usageSavings(formatCostUsd(savedUsd), pct);
}

String formatContextK(int value) {
  if (value < 1000) {
    return value.toString();
  }
  if (value < 1000000) {
    final rounded = value / 1000;
    return rounded >= 100
        ? '${rounded.round()}K'
        : '${rounded.toStringAsFixed(1)}K';
  }
  return '${(value / 1000000).toStringAsFixed(1)}M';
}

String formatOccupancyLabel(int pct, AppLocalizations l10n) {
  if (pct >= 100) {
    return l10n.usageFull;
  }
  if (pct >= 95) {
    return l10n.usageNearLimit(pct);
  }
  if (pct >= 85) {
    return l10n.usageAlmostFull(pct);
  }
  return l10n.usageUsed(pct);
}

int? resolvePlannerOccupancyPct(ThreadContextSnapshot? context) {
  if (context == null) {
    return null;
  }
  for (final role in context.roles) {
    if (role.role == 'main') {
      return role.occupancyPct;
    }
  }
  return context.occupancyPct;
}

ThreadRoleContextSnapshot resolvePlannerContext(ThreadContextSnapshot context) {
  for (final role in context.roles) {
    if (role.role == 'main') {
      return role;
    }
  }
  return ThreadRoleContextSnapshot(
    role: context.displayRole ?? 'main',
    occupied: context.occupied,
    limit: context.limit,
    occupancyPct: context.occupancyPct,
    limitsResolved: context.limitsResolved,
    modelId: context.modelId,
    segments: context.segments,
  );
}

String billingEmptyHint(String? status, AppLocalizations l10n) {
  if (status == 'running' || status == 'queued') {
    return l10n.usageAccumulating;
  }
  if (status == 'awaiting_plan') {
    return l10n.usagePlanHint;
  }
  if (status != null &&
      status != 'idle' &&
      status != 'completed' &&
      status != 'failed' &&
      status != 'blocked') {
    return l10n.usageNoRecords;
  }
  return l10n.usageCostPlaceholder;
}

String contextCardPlaceholder(String? status, AppLocalizations l10n) {
  if (status == 'running' || status == 'queued') {
    return l10n.usageUpdatesPerResponse;
  }
  if (status == 'awaiting_plan') {
    return l10n.usagePlanUpdates;
  }
  if (status == 'completed' ||
      status == 'idle' ||
      status == 'failed' ||
      status == 'blocked') {
    return l10n.usageNoContext;
  }
  return l10n.usageContextPlaceholder;
}

String roleDisplayLabel(String role, AppLocalizations l10n) {
  switch (role) {
    case 'main':
      return 'Main Agent';
    case 'vision':
      return l10n.roleVision;
    case 'coder':
      return l10n.roleCoder;
    case 'reviewer':
      return l10n.roleReviewer;
    case 'tester':
      return l10n.roleTester;
    case 'explore':
      return l10n.roleExplore;
    case 'architect':
      return l10n.roleArchitect;
    default:
      return role;
  }
}

String formatRoleModelLabel(
  String role,
  String? modelId,
  AppLocalizations l10n,
) {
  final base = roleDisplayLabel(role, l10n);
  final model = modelId?.trim();
  if (model == null || model.isEmpty) {
    return base;
  }
  return '$base · ${shortenModelId(model)}';
}

String shortAgentId(String agentId) {
  if (agentId.length <= 8) {
    return agentId;
  }
  return agentId.substring(0, 8);
}

class FlatSubagentContextRow {
  const FlatSubagentContextRow({
    required this.key,
    required this.role,
    required this.title,
    required this.snapshot,
    this.accentColor,
  });

  final String key;
  final String role;
  final String title;
  final ThreadRoleContextSnapshot snapshot;
  final Color? accentColor;
}

List<FlatSubagentContextRow> buildFlatSubagentContextRows(
  ThreadContextSnapshot context, {
  SubagentThemeSource? themeSource,
  required AppLocalizations l10n,
}) {
  final subagentRoles = context.roles
      .where((role) => role.role != 'main')
      .toList();

  final instances =
      [...context.instances]
          .where(
            (instance) => instance.role != 'main' && instance.occupied > 0,
          )
          .toList()
        ..sort((left, right) => right.occupied.compareTo(left.occupied));

  if (instances.isNotEmpty) {
    return instances.map((instance) {
      final roleLabel = roleDisplayLabel(instance.role, l10n);
      return FlatSubagentContextRow(
        key: instance.agentId,
        role: instance.role,
        title: '$roleLabel #${shortAgentId(instance.agentId)}',
        accentColor: resolveSubagentThemeColor(
          instance.role,
          agents: themeSource?.agents ?? const [],
        ),
        snapshot: ThreadRoleContextSnapshot(
          role: instance.role,
          occupied: instance.occupied,
          limit: instance.limit,
          occupancyPct: instance.occupancyPct,
          limitsResolved: instance.limitsResolved,
          modelId: instance.modelId,
          segments: instance.segments,
        ),
      );
    }).toList();
  }

  return subagentRoles.map((role) {
    return FlatSubagentContextRow(
      key: role.role,
      role: role.role,
      title: formatRoleModelLabel(role.role, role.modelId, l10n),
      accentColor: resolveSubagentThemeColor(
        role.role,
        agents: themeSource?.agents ?? const [],
      ),
      snapshot: role,
    );
  }).toList();
}

String formatBillingModelLabel(ThreadBillingModelSnapshot entry) {
  return shortenModelId(entry.modelId);
}
