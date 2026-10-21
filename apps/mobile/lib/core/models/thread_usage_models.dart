import '../utils/agent_role.dart';

class ContextBreakdownSegment {
  const ContextBreakdownSegment({
    required this.key,
    required this.label,
    required this.tokens,
    this.color,
  });

  factory ContextBreakdownSegment.fromJson(Map<String, dynamic> json) =>
      ContextBreakdownSegment(
        key: json['key'] as String? ?? '',
        label: json['label'] as String? ?? '',
        tokens: (json['tokens'] as num?)?.toInt() ?? 0,
        color: json['color'] as String?,
      );

  final String key;
  final String label;
  final int tokens;
  final String? color;
}

class ThreadRoleContextSnapshot {
  const ThreadRoleContextSnapshot({
    required this.role,
    required this.occupied,
    required this.limit,
    required this.occupancyPct,
    required this.limitsResolved,
    this.modelId,
    this.segments = const [],
  });

  factory ThreadRoleContextSnapshot.fromJson(Map<String, dynamic> json) =>
      ThreadRoleContextSnapshot(
        role: normalizeAgentRole(json['role'] as String? ?? 'main'),
        occupied: (json['occupied'] as num?)?.toInt() ?? 0,
        limit: (json['limit'] as num?)?.toInt() ?? 0,
        occupancyPct: (json['occupancyPct'] as num?)?.toInt() ?? 0,
        limitsResolved: json['limitsResolved'] as bool? ?? false,
        modelId: json['modelId'] as String?,
        segments: (json['segments'] as List<dynamic>? ?? [])
            .map(
              (entry) => ContextBreakdownSegment.fromJson(
                entry as Map<String, dynamic>,
              ),
            )
            .toList(),
      );

  final String role;
  final int occupied;
  final int limit;
  final int occupancyPct;
  final bool limitsResolved;
  final String? modelId;
  final List<ContextBreakdownSegment> segments;
}

class ThreadContextInstanceSnapshot {
  const ThreadContextInstanceSnapshot({
    required this.agentId,
    required this.role,
    required this.occupied,
    required this.limit,
    required this.occupancyPct,
    required this.limitsResolved,
    this.modelId,
    this.segments = const [],
  });

  factory ThreadContextInstanceSnapshot.fromJson(Map<String, dynamic> json) =>
      ThreadContextInstanceSnapshot(
        agentId: json['agentId'] as String? ?? '',
        role: normalizeAgentRole(json['role'] as String? ?? 'coder'),
        occupied: (json['occupied'] as num?)?.toInt() ?? 0,
        limit: (json['limit'] as num?)?.toInt() ?? 0,
        occupancyPct: (json['occupancyPct'] as num?)?.toInt() ?? 0,
        limitsResolved: json['limitsResolved'] as bool? ?? false,
        modelId: json['modelId'] as String?,
        segments: (json['segments'] as List<dynamic>? ?? [])
            .map(
              (entry) => ContextBreakdownSegment.fromJson(
                entry as Map<String, dynamic>,
              ),
            )
            .toList(),
      );

  final String agentId;
  final String role;
  final int occupied;
  final int limit;
  final int occupancyPct;
  final bool limitsResolved;
  final String? modelId;
  final List<ContextBreakdownSegment> segments;
}

class ThreadContextSnapshot {
  const ThreadContextSnapshot({
    required this.occupied,
    required this.limit,
    required this.occupancyPct,
    required this.limitsResolved,
    this.displayRole,
    this.modelId,
    this.segments = const [],
    this.roles = const [],
    this.instances = const [],
  });

  factory ThreadContextSnapshot.fromJson(
    Map<String, dynamic> json,
  ) => ThreadContextSnapshot(
    occupied: (json['occupied'] as num?)?.toInt() ?? 0,
    limit: (json['limit'] as num?)?.toInt() ?? 0,
    occupancyPct: (json['occupancyPct'] as num?)?.toInt() ?? 0,
    limitsResolved: json['limitsResolved'] as bool? ?? false,
    displayRole: json['displayRole'] == null
        ? null
        : normalizeAgentRole(json['displayRole'] as String),
    modelId: json['modelId'] as String?,
    segments: (json['segments'] as List<dynamic>? ?? [])
        .map(
          (entry) =>
              ContextBreakdownSegment.fromJson(entry as Map<String, dynamic>),
        )
        .toList(),
    roles: (json['roles'] as List<dynamic>? ?? [])
        .map(
          (entry) =>
              ThreadRoleContextSnapshot.fromJson(entry as Map<String, dynamic>),
        )
        .toList(),
    instances: (json['instances'] as List<dynamic>? ?? [])
        .map(
          (entry) => ThreadContextInstanceSnapshot.fromJson(
            entry as Map<String, dynamic>,
          ),
        )
        .toList(),
  );

  final int occupied;
  final int limit;
  final int occupancyPct;
  final bool limitsResolved;
  final String? displayRole;
  final String? modelId;
  final List<ContextBreakdownSegment> segments;
  final List<ThreadRoleContextSnapshot> roles;
  final List<ThreadContextInstanceSnapshot> instances;
}

class ThreadBillingModelSnapshot {
  const ThreadBillingModelSnapshot({
    required this.modelId,
    required this.roles,
    required this.inputTokens,
    required this.outputTokens,
    required this.cacheReadTokens,
    required this.cacheCreationTokens,
    required this.ecoCostUsd,
    this.reportedCostUsd,
  });

  factory ThreadBillingModelSnapshot.fromJson(Map<String, dynamic> json) =>
      ThreadBillingModelSnapshot(
        modelId: json['modelId'] as String? ?? '',
        roles: (json['roles'] as List<dynamic>? ?? [])
            .map((entry) => normalizeAgentRole(entry as String))
            .toSet()
            .toList(),
        inputTokens: (json['inputTokens'] as num?)?.toInt() ?? 0,
        outputTokens: (json['outputTokens'] as num?)?.toInt() ?? 0,
        cacheReadTokens: (json['cacheReadTokens'] as num?)?.toInt() ?? 0,
        cacheCreationTokens:
            (json['cacheCreationTokens'] as num?)?.toInt() ?? 0,
        ecoCostUsd: (json['ecoCostUsd'] as num?)?.toDouble() ?? 0,
        reportedCostUsd: (json['reportedCostUsd'] as num?)?.toDouble(),
      );

  final String modelId;
  final List<String> roles;
  final int inputTokens;
  final int outputTokens;
  final int cacheReadTokens;
  final int cacheCreationTokens;
  final double ecoCostUsd;
  final double? reportedCostUsd;
}

class ThreadBillingSnapshot {
  const ThreadBillingSnapshot({
    required this.plannerTokenCostUsd,
    required this.ecoCostUsd,
    required this.savedUsd,
    required this.savedPct,
    required this.pricingResolved,
    this.plannerModelLabel,
    this.inputTokens = 0,
    this.outputTokens = 0,
    this.cacheReadTokens = 0,
    this.cacheCreationTokens = 0,
    this.byModel = const [],
  });

  factory ThreadBillingSnapshot.fromJson(Map<String, dynamic> json) {
    final totals = json['totalTokens'] as Map<String, dynamic>? ?? {};
    return ThreadBillingSnapshot(
      plannerTokenCostUsd:
          (json['plannerTokenCostUsd'] as num?)?.toDouble() ?? 0,
      ecoCostUsd: (json['ecoCostUsd'] as num?)?.toDouble() ?? 0,
      savedUsd: (json['savedUsd'] as num?)?.toDouble() ?? 0,
      savedPct: (json['savedPct'] as num?)?.toDouble() ?? 0,
      pricingResolved: json['pricingResolved'] as bool? ?? false,
      plannerModelLabel: json['plannerModelLabel'] as String?,
      inputTokens: (totals['input'] as num?)?.toInt() ?? 0,
      outputTokens: (totals['output'] as num?)?.toInt() ?? 0,
      cacheReadTokens: (totals['cacheRead'] as num?)?.toInt() ?? 0,
      cacheCreationTokens: (totals['cacheCreation'] as num?)?.toInt() ?? 0,
      byModel: (json['byModel'] as List<dynamic>? ?? [])
          .map(
            (entry) => ThreadBillingModelSnapshot.fromJson(
              entry as Map<String, dynamic>,
            ),
          )
          .toList(),
    );
  }

  final double plannerTokenCostUsd;
  final double ecoCostUsd;
  final double savedUsd;
  final double savedPct;
  final bool pricingResolved;
  final String? plannerModelLabel;
  final int inputTokens;
  final int outputTokens;
  final int cacheReadTokens;
  final int cacheCreationTokens;
  final List<ThreadBillingModelSnapshot> byModel;
}
