import '../constants/session_mode.dart';
import 'composer_mcp.dart';
import 'mcp_models.dart';
import 'thread_models.dart';

OrchestrationResourceLookup orchestrationResourceLookupFromSettings(
  ModelSettingsSnapshot settings,
) {
  return OrchestrationResourceLookup(
    mainAgentConfigs: settings.mainAgentConfigs,
    mainAgentPrompts: settings.mainAgentPrompts,
    subagentOrchestrations: settings.subagentOrchestrations,
  );
}

ResolvedOrchestrationSnapshot? resolveThreadOrchestrationSnapshot(
  ModelSettingsSnapshot? settings,
  ThreadRuntimeConfig config,
) {
  final stored = config.resolvedOrchestrationSnapshot;
  if (stored != null) return stored;
  final selection = config.orchestrationSelection;
  if (settings == null || !hasCompleteOrchestrationSelection(selection)) {
    return null;
  }
  return resolveOrchestrationSnapshot(
    selection!,
    orchestrationResourceLookupFromSettings(settings),
  );
}

bool isThreadOrchestrationReady(
  ModelSettingsSnapshot? settings,
  ThreadRuntimeConfig config,
) {
  return resolveThreadOrchestrationSnapshot(settings, config) != null;
}

bool isThreadRuntimeConfigReady(
  ModelSettingsSnapshot? settings,
  ThreadRuntimeConfig config, {
  String? coreKind,
}) {
  if (coreKind == 'acp') return true;
  return isThreadOrchestrationReady(settings, config);
}

/// Commit/push does not require orchestration; only use a main-agent id when one exists.
String? resolveCommitMainAgentConfigId(ThreadRuntimeConfig config) {
  final fromSelection = config.orchestrationSelection?.mainAgentConfigId.trim();
  if (fromSelection != null && fromSelection.isNotEmpty) {
    return fromSelection;
  }
  final fromSnapshot = config
      .resolvedOrchestrationSnapshot
      ?.selection
      .mainAgentConfigId
      .trim();
  if (fromSnapshot != null && fromSnapshot.isNotEmpty) {
    return fromSnapshot;
  }
  return null;
}

String orchestrationCompositionSummary(
  ModelSettingsSnapshot? settings,
  ThreadRuntimeConfig config,
) {
  final snapshot = resolveThreadOrchestrationSnapshot(settings, config);
  if (snapshot != null) {
    final parts = <String>[
      snapshot.mainAgentConfigName,
      snapshot.mainPromptDisplayName,
    ];
    final subagentName = snapshot.subagentOrchestrationDisplayName;
    if (subagentName != null && subagentName.isNotEmpty) {
      parts.add(subagentName);
    } else if (snapshot.selection.subagents is NoneSubagentSelection) {
      parts.add('无子代理');
    }
    return parts.join(' · ');
  }
  final selection = config.orchestrationSelection;
  if (selection == null) {
    return '';
  }
  return selection.mainAgentConfigId;
}

Map<String, bool> deriveSubagentEnabledFromSnapshot(
  ResolvedOrchestrationSnapshot snapshot, {
  Map<String, bool>? existing,
}) {
  final subagentEnabled = defaultSubagentAvailability();
  final orchestrationAgents = snapshot.agents;
  for (final role in subagentRoles) {
    AgentInstanceConfig? agent;
    for (final candidate in orchestrationAgents) {
      if (candidate.agentKey == role) {
        agent = candidate;
        break;
      }
    }
    if (agent == null || !agent.enabled) {
      subagentEnabled[role] = false;
      continue;
    }
    final existingValue = existing?[role];
    if (existingValue is bool) {
      subagentEnabled[role] = existingValue;
    }
  }
  return subagentEnabled;
}

List<String> collectSnapshotAssignedMcpServers(
  ResolvedOrchestrationSnapshot snapshot,
) {
  final servers = <String>{};
  for (final server
      in snapshot.mainAgent.tools.mcp?.allowedServers ?? const []) {
    servers.add(sanitizeMcpServerName(server));
  }
  for (final agent in snapshot.agents) {
    if (!agent.enabled) continue;
    for (final server in agent.mcpServers) {
      servers.add(sanitizeMcpServerName(server));
    }
    for (final server in agent.tools.mcp?.allowedServers ?? const []) {
      servers.add(sanitizeMcpServerName(server));
    }
  }
  return servers.toList(growable: false);
}

Map<String, bool> resolveComposerMcpSettings({
  required List<McpServerConfigView> servers,
  required ThreadRuntimeConfig runtimeConfig,
  ResolvedOrchestrationSnapshot? snapshot,
  Map<String, bool>? remembered,
}) {
  final availableServerKeys = listEnabledGlobalMcpServerKeys(servers);
  if (availableServerKeys.isEmpty) {
    return const {};
  }
  if (runtimeConfig.mcpServersEnabled != null) {
    return deriveMcpServersEnabled(
      availableServerKeys,
      existing: runtimeConfig.mcpServersEnabled,
    );
  }
  return deriveMcpServersEnabled(
    availableServerKeys,
    orchestrationAssignedServers: snapshot == null
        ? const []
        : collectSnapshotAssignedMcpServers(snapshot),
    remembered: remembered,
  );
}

({
  OrchestrationSelection orchestrationSelection,
  ResolvedOrchestrationSnapshot resolvedOrchestrationSnapshot,
})
materializeThreadOrchestrationSnapshot(
  ModelSettingsSnapshot settings,
  OrchestrationSelection selection,
) {
  final resolvedOrchestrationSnapshot = resolveOrchestrationSnapshot(
    selection,
    orchestrationResourceLookupFromSettings(settings),
  );
  return (
    orchestrationSelection: selection,
    resolvedOrchestrationSnapshot: resolvedOrchestrationSnapshot,
  );
}

ThreadRuntimeConfig buildRuntimeConfigForSelection({
  required ModelSettingsSnapshot settings,
  required OrchestrationSelection selection,
  required ThreadRuntimeConfig runtimeConfig,
  required List<McpServerConfigView> servers,
  Map<String, bool>? remembered,
}) {
  final materialized = materializeThreadOrchestrationSnapshot(
    settings,
    selection,
  );
  final snapshot = materialized.resolvedOrchestrationSnapshot;
  final availableKeys = listEnabledGlobalMcpServerKeys(servers);
  return ThreadRuntimeConfig(
    orchestrationSelection: materialized.orchestrationSelection,
    resolvedOrchestrationSnapshot: snapshot,
    subagentEnabled: deriveSubagentEnabledFromSnapshot(
      snapshot,
      existing: runtimeConfig.subagentEnabled,
    ),
    mcpServersEnabled: availableKeys.isEmpty
        ? null
        : deriveMcpServersEnabled(
            availableKeys,
            orchestrationAssignedServers: collectSnapshotAssignedMcpServers(
              snapshot,
            ),
            existing: runtimeConfig.mcpServersEnabled,
            remembered: remembered,
          ),
    integrationsEnabled: runtimeConfig.integrationsEnabled,
    skillsEnabled: runtimeConfig.skillsEnabled,
    mainAgentModelOverride: null,
    auxiliaryModel: runtimeConfig.auxiliaryModel,
    approvalModel: runtimeConfig.approvalModel,
    visionModel: runtimeConfig.visionModel,
    sessionMode: runtimeConfig.sessionMode,
    bashReviewMode: runtimeConfig.bashReviewMode,
  );
}

ThreadRuntimeConfig applyOrchestrationSelectionPatch({
  required ModelSettingsSnapshot? settings,
  required ThreadRuntimeConfig runtimeConfig,
  required List<McpServerConfigView> servers,
  Map<String, bool>? remembered,
  String? mainAgentConfigId,
  MainAgentPromptSelection? mainPrompt,
  SubagentSelection? subagents,
}) {
  final current =
      runtimeConfig.orchestrationSelection ?? emptyOrchestrationSelection();
  final nextSelection = current.copyWith(
    mainAgentConfigId: mainAgentConfigId,
    mainPrompt: mainPrompt,
    subagents: subagents,
  );
  if (settings == null || !hasCompleteOrchestrationSelection(nextSelection)) {
    return runtimeConfig.copyWith(
      orchestrationSelection: nextSelection,
      clearOrchestrationSnapshot: true,
      clearMainAgentModelOverride: true,
    );
  }
  return buildRuntimeConfigForSelection(
    settings: settings,
    selection: nextSelection,
    runtimeConfig: runtimeConfig,
    servers: servers,
    remembered: remembered,
  );
}

ThreadRuntimeConfig buildAcpRuntimeConfig({
  WorkflowSettingsSnapshot? workflow,
  String? cursorModelId,
  String? sessionMode,
  String? bashReviewMode,
  Map<String, bool>? subagentEnabled,
  AuxiliaryModelSelection? auxiliaryModel,
  ApprovalModelSelection? approvalModel,
  VisionModelSelection? visionModel,
  Map<String, bool>? mcpServersEnabled,
  Map<String, bool>? integrationsEnabled,
}) {
  final selectedModelId = (cursorModelId ?? workflow?.acpCursorModelId)?.trim();
  return ThreadRuntimeConfig(
    cursorModelId: selectedModelId?.isEmpty == true ? null : selectedModelId,
    subagentEnabled: normalizeSubagentAvailability(subagentEnabled),
    auxiliaryModel: auxiliaryModel ?? workflow?.defaultAuxiliaryModel,
    approvalModel: approvalModel ?? workflow?.defaultApprovalModel,
    visionModel: visionModel ?? workflow?.defaultVisionModel,
    mcpServersEnabled: mcpServersEnabled ?? workflow?.mcpServersEnabled,
    integrationsEnabled: integrationsEnabled ?? workflow?.integrationsEnabled,
    sessionMode: resolveSessionMode(
      sessionMode: sessionMode ?? workflow?.sessionMode,
    ),
    bashReviewMode:
        bashReviewMode ??
        normalizeBashReviewMode(workflow?.defaultBashReviewMode),
  );
}

/// Draft config for Settings → Runtime config / Models.
///
/// Always surfaces [WorkflowSettingsSnapshot.defaultOrchestrationSelection],
/// even when [WorkflowSettingsSnapshot.defaultCoreKind] is ACP. Composer ACP
/// runs ignore Eco orchestration, but the stored defaults remain editable here.
ThreadRuntimeConfig buildGlobalSettingsRuntimeConfig({
  ModelSettingsSnapshot? modelSettings,
  WorkflowSettingsSnapshot? workflow,
  List<McpServerConfigView>? mcpServers,
}) {
  return buildDefaultRuntimeConfig(
    modelSettings: modelSettings,
    workflow: workflow,
    mcpServers: mcpServers,
    orchestrationSelection: workflow?.defaultOrchestrationSelection,
    // Force Eco path so ACP default core does not drop orchestrationSelection.
    coreKind: 'claude',
  );
}

ThreadRuntimeConfig buildDefaultRuntimeConfig({
  ModelSettingsSnapshot? modelSettings,
  WorkflowSettingsSnapshot? workflow,
  List<McpServerConfigView>? mcpServers,
  OrchestrationSelection? orchestrationSelection,
  String? coreKind,
}) {
  final defaultBashReviewMode = normalizeBashReviewMode(
    workflow?.defaultBashReviewMode,
  );
  if ((coreKind ?? workflow?.defaultCoreKind) == 'acp') {
    return buildAcpRuntimeConfig(workflow: workflow);
  }
  final selection =
      orchestrationSelection ?? workflow?.defaultOrchestrationSelection;
  if (modelSettings == null ||
      modelSettings.mainAgentConfigs.isEmpty ||
      !hasCompleteOrchestrationSelection(selection)) {
    return ThreadRuntimeConfig(
      orchestrationSelection: selection,
      subagentEnabled: defaultSubagentAvailability(),
      auxiliaryModel: workflow?.defaultAuxiliaryModel,
      approvalModel: workflow?.defaultApprovalModel,
      visionModel: workflow?.defaultVisionModel,
      integrationsEnabled: workflow?.integrationsEnabled,
      sessionMode: resolveSessionMode(sessionMode: workflow?.sessionMode),
      bashReviewMode: defaultBashReviewMode,
    );
  }

  final materialized = materializeThreadOrchestrationSnapshot(
    modelSettings,
    selection!,
  );
  final snapshot = materialized.resolvedOrchestrationSnapshot;
  final availableMcpServerKeys = listEnabledGlobalMcpServerKeys(
    mcpServers ?? [],
  );
  final mcpServersEnabled = availableMcpServerKeys.isEmpty
      ? null
      : deriveMcpServersEnabled(
          availableMcpServerKeys,
          orchestrationAssignedServers: collectSnapshotAssignedMcpServers(
            snapshot,
          ),
          remembered: workflow?.mcpServersEnabled,
        );
  final bashReviewMode =
      defaultBashReviewMode == 'auto' && workflow?.defaultApprovalModel == null
      ? 'always'
      : defaultBashReviewMode;

  return ThreadRuntimeConfig(
    orchestrationSelection: materialized.orchestrationSelection,
    resolvedOrchestrationSnapshot: snapshot,
    subagentEnabled: deriveSubagentEnabledFromSnapshot(snapshot),
    auxiliaryModel: workflow?.defaultAuxiliaryModel,
    approvalModel: workflow?.defaultApprovalModel,
    visionModel: workflow?.defaultVisionModel,
    mcpServersEnabled: mcpServersEnabled,
    integrationsEnabled: workflow?.integrationsEnabled,
    sessionMode: normalizeSessionMode(workflow?.sessionMode),
    bashReviewMode: bashReviewMode,
  );
}

ThreadRuntimeConfig downgradeApprovalDependentFeatures(
  ThreadRuntimeConfig runtimeConfig,
) {
  if (runtimeConfig.approvalModel != null ||
      runtimeConfig.bashReviewMode != 'auto') {
    return runtimeConfig;
  }
  return runtimeConfig.copyWith(bashReviewMode: 'always');
}

bool isSubagentConfiguredInSnapshot(
  ResolvedOrchestrationSnapshot? snapshot,
  String role,
) {
  if (snapshot == null) return false;
  for (final agent in snapshot.agents) {
    if (agent.agentKey == role) {
      return agent.enabled;
    }
  }
  return false;
}

Map<String, bool> normalizedRuntimeSubagentEnabled(
  Map<String, bool> subagentEnabled,
) {
  return normalizeSubagentAvailability(subagentEnabled);
}

bool isRuntimeSubagentEnabled(Map<String, bool> subagentEnabled, String role) {
  return normalizedRuntimeSubagentEnabled(subagentEnabled)[role] ?? true;
}

bool isSubagentToggleable(
  ResolvedOrchestrationSnapshot? snapshot,
  String role,
) {
  return isSubagentConfiguredInSnapshot(snapshot, role);
}

int countEnabledSubagents(Map<String, bool> subagentEnabled) {
  return subagentRoles.where((role) => subagentEnabled[role] ?? false).length;
}

int countConfiguredSubagents(ResolvedOrchestrationSnapshot? snapshot) {
  return configuredOrchestrationSubagentRoles(snapshot).length;
}

List<String> configuredOrchestrationSubagentRoles(
  ResolvedOrchestrationSnapshot? snapshot,
) {
  if (snapshot == null) return const [];
  return snapshot.agents
      .where((agent) => agent.enabled)
      .map((agent) => agent.agentKey)
      .where(subagentRoles.contains)
      .toList(growable: false);
}

List<AgentInstanceConfig> orchestrationAgentsForTheme(
  ResolvedOrchestrationSnapshot? snapshot,
) {
  if (snapshot == null) return const [];
  return snapshot.agents;
}

class SubagentThemeSource {
  const SubagentThemeSource({required this.agents});

  factory SubagentThemeSource.fromSnapshot(
    ResolvedOrchestrationSnapshot? snapshot,
  ) {
    if (snapshot == null) {
      return const SubagentThemeSource(agents: []);
    }
    return SubagentThemeSource(agents: orchestrationAgentsForTheme(snapshot));
  }

  final List<AgentInstanceConfig> agents;
}
