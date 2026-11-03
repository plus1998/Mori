import 'agent_orchestration.dart';

/// Matches the desktop's explicit plan execution target contract.
class PlanExecutionTarget {
  const PlanExecutionTarget.subagent(this.agentKey, {this.additionalMessage});

  final String agentKey;
  final String? additionalMessage;

  Map<String, dynamic> toJson() => {
    'kind': 'subagent',
    'agentKey': agentKey,
    if (additionalMessage?.trim().isNotEmpty == true)
      'additionalMessage': additionalMessage!.trim(),
  };
}

class PlanDelegationAgentOption {
  const PlanDelegationAgentOption({
    required this.agentKey,
    required this.displayName,
    required this.canExecutePlan,
  });

  final String agentKey;
  final String displayName;
  final bool canExecutePlan;
}

/// Use the session's locked snapshot, with the same write-policy checks as desktop.
List<PlanDelegationAgentOption> listPlanDelegationAgents(
  ResolvedOrchestrationSnapshot? snapshot,
) {
  final seen = <String>{};
  return [
    for (final agent in snapshot?.agents ?? <AgentInstanceConfig>[])
      if (agent.enabled &&
          agent.agentKey.trim().isNotEmpty &&
          seen.add(agent.agentKey.trim()))
        PlanDelegationAgentOption(
          agentKey: agent.agentKey.trim(),
          displayName: agent.displayName?.trim().isNotEmpty == true
              ? agent.displayName!.trim()
              : agent.agentKey.trim(),
          canExecutePlan: _canExecutePlan(agent.tools),
        ),
  ];
}

bool _canExecutePlan(ToolPolicy tools) {
  final filesystem = tools.capabilities['filesystem'];
  final overrides = tools.capabilities['coreOverrides'];
  final codex = overrides is Map ? overrides['codex'] : null;
  final claude = overrides is Map ? overrides['claude'] : null;
  if ((codex is Map && codex['sandboxMode'] == 'read-only') ||
      filesystem is! Map ||
      filesystem['write'] != 'workspace') {
    return false;
  }
  final denied = {
    ...tools.disallowed,
    if (claude is Map && claude['disallowedTools'] is List)
      ...(claude['disallowedTools'] as List),
  };
  return !const [
    'Write',
    'Edit',
    'MultiEdit',
    'NotebookEdit',
    'apply_patch',
  ].any(denied.contains);
}
