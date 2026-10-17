const builtinMainPromptValue = 'builtin';
const subagentsNoneValue = '__none__';

sealed class MainAgentPromptSelection {
  const MainAgentPromptSelection();

  factory MainAgentPromptSelection.fromJson(Object? json) {
    if (json is! Map) {
      throw FormatException('Invalid mainPrompt');
    }
    final mode = json['mode'] as String?;
    if (mode == 'builtin') {
      return const BuiltinMainAgentPromptSelection();
    }
    if (mode == 'custom_append') {
      final promptId = json['promptId'] as String? ?? '';
      if (promptId.trim().isEmpty) {
        throw FormatException('Invalid mainPrompt.promptId');
      }
      return CustomAppendMainAgentPromptSelection(promptId: promptId.trim());
    }
    throw FormatException('Invalid mainPrompt.mode');
  }

  Map<String, dynamic> toJson();
  String get mode;
}

class BuiltinMainAgentPromptSelection extends MainAgentPromptSelection {
  const BuiltinMainAgentPromptSelection();

  @override
  String get mode => 'builtin';

  @override
  Map<String, dynamic> toJson() => const {'mode': 'builtin'};
}

class CustomAppendMainAgentPromptSelection extends MainAgentPromptSelection {
  const CustomAppendMainAgentPromptSelection({required this.promptId});

  final String promptId;

  @override
  String get mode => 'custom_append';

  @override
  Map<String, dynamic> toJson() => {
    'mode': 'custom_append',
    'promptId': promptId,
  };
}

sealed class SubagentSelection {
  const SubagentSelection();

  factory SubagentSelection.fromJson(Object? json) {
    if (json is! Map) {
      throw FormatException('Invalid subagents');
    }
    final mode = json['mode'] as String?;
    if (mode == 'none') {
      return const NoneSubagentSelection();
    }
    if (mode == 'orchestration') {
      final orchestrationId = json['orchestrationId'] as String? ?? '';
      if (orchestrationId.trim().isEmpty) {
        throw FormatException('Invalid subagents.orchestrationId');
      }
      return OrchestrationSubagentSelection(
        orchestrationId: orchestrationId.trim(),
      );
    }
    throw FormatException('Invalid subagents.mode');
  }

  Map<String, dynamic> toJson();
  String get mode;
}

class NoneSubagentSelection extends SubagentSelection {
  const NoneSubagentSelection();

  @override
  String get mode => 'none';

  @override
  Map<String, dynamic> toJson() => const {'mode': 'none'};
}

class OrchestrationSubagentSelection extends SubagentSelection {
  const OrchestrationSubagentSelection({required this.orchestrationId});

  final String orchestrationId;

  @override
  String get mode => 'orchestration';

  @override
  Map<String, dynamic> toJson() => {
    'mode': 'orchestration',
    'orchestrationId': orchestrationId,
  };
}

class OrchestrationSelection {
  const OrchestrationSelection({
    required this.mainAgentConfigId,
    required this.mainPrompt,
    required this.subagents,
  });

  factory OrchestrationSelection.fromJson(Map<String, dynamic> json) {
    final mainAgentConfigId = json['mainAgentConfigId'] as String? ?? '';
    if (mainAgentConfigId.trim().isEmpty) {
      throw FormatException('Invalid orchestrationSelection.mainAgentConfigId');
    }
    return OrchestrationSelection(
      mainAgentConfigId: mainAgentConfigId.trim(),
      mainPrompt: MainAgentPromptSelection.fromJson(json['mainPrompt']),
      subagents: SubagentSelection.fromJson(json['subagents']),
    );
  }

  Map<String, dynamic> toJson() => {
    'mainAgentConfigId': mainAgentConfigId,
    'mainPrompt': mainPrompt.toJson(),
    'subagents': subagents.toJson(),
  };

  final String mainAgentConfigId;
  final MainAgentPromptSelection mainPrompt;
  final SubagentSelection subagents;

  OrchestrationSelection copyWith({
    String? mainAgentConfigId,
    MainAgentPromptSelection? mainPrompt,
    SubagentSelection? subagents,
  }) {
    return OrchestrationSelection(
      mainAgentConfigId: mainAgentConfigId ?? this.mainAgentConfigId,
      mainPrompt: mainPrompt ?? this.mainPrompt,
      subagents: subagents ?? this.subagents,
    );
  }
}

class OrchestrationModelRef {
  const OrchestrationModelRef({
    required this.providerId,
    required this.modelId,
    this.thinkingEffort,
    this.candidateModelId,
  });

  factory OrchestrationModelRef.fromJson(Map<String, dynamic> json) =>
      OrchestrationModelRef(
        providerId: json['providerId'] as String? ?? '',
        modelId: json['modelId'] as String? ?? '',
        thinkingEffort: json['thinkingEffort'] as String?,
        candidateModelId: json['candidateModelId'] as String?,
      );

  Map<String, dynamic> toJson() => {
    'providerId': providerId,
    'modelId': modelId,
    if (thinkingEffort != null) 'thinkingEffort': thinkingEffort,
    if (candidateModelId != null) 'candidateModelId': candidateModelId,
  };

  final String providerId;
  final String modelId;
  final String? thinkingEffort;
  final String? candidateModelId;
}

class ToolPolicyMcp {
  const ToolPolicyMcp({this.allowedServers = const []});

  factory ToolPolicyMcp.fromJson(Map<String, dynamic>? json) {
    if (json == null) return const ToolPolicyMcp();
    final servers = json['allowedServers'];
    return ToolPolicyMcp(
      allowedServers: servers is List
          ? servers.map((entry) => entry.toString()).toList(growable: false)
          : const [],
    );
  }

  final List<String> allowedServers;
}

class ToolPolicy {
  const ToolPolicy({
    this.allowed = const [],
    this.disallowed = const [],
    this.mcp,
    this.confirmation,
  });

  factory ToolPolicy.fromJson(Map<String, dynamic>? json) {
    if (json == null) return const ToolPolicy();
    final mcp = json['mcp'];
    return ToolPolicy(
      allowed: (json['allowed'] as List<dynamic>? ?? const [])
          .map((entry) => entry.toString())
          .toList(growable: false),
      disallowed: (json['disallowed'] as List<dynamic>? ?? const [])
          .map((entry) => entry.toString())
          .toList(growable: false),
      mcp: mcp is Map
          ? ToolPolicyMcp.fromJson(Map<String, dynamic>.from(mcp))
          : null,
      confirmation: json['confirmation'] as String?,
    );
  }

  final List<String> allowed;
  final List<String> disallowed;
  final ToolPolicyMcp? mcp;
  final String? confirmation;
}

class MainAgentConfigResource {
  const MainAgentConfigResource({
    required this.id,
    required this.name,
    required this.agentKey,
    required this.modelRef,
    required this.tools,
    this.skills = const [],
    this.updatedAt = '',
    this.source = 'user',
  });

  factory MainAgentConfigResource.fromJson(Map<String, dynamic> json) {
    final modelRef = json['modelRef'];
    final tools = json['tools'];
    return MainAgentConfigResource(
      id: json['id'] as String? ?? '',
      name: json['name'] as String? ?? '',
      agentKey: json['agentKey'] as String? ?? 'main',
      modelRef: OrchestrationModelRef.fromJson(
        modelRef is Map
            ? Map<String, dynamic>.from(modelRef)
            : const <String, dynamic>{},
      ),
      tools: ToolPolicy.fromJson(
        tools is Map ? Map<String, dynamic>.from(tools) : null,
      ),
      skills: (json['skills'] as List<dynamic>? ?? const [])
          .map((entry) => entry.toString())
          .toList(growable: false),
      updatedAt: json['updatedAt'] as String? ?? '',
      source: json['source'] as String? ?? 'user',
    );
  }

  final String id;
  final String name;
  final String agentKey;
  final OrchestrationModelRef modelRef;
  final ToolPolicy tools;
  final List<String> skills;
  final String updatedAt;
  final String source;
}

class MainAgentPromptResource {
  const MainAgentPromptResource({
    required this.id,
    required this.name,
    required this.mode,
    this.prompt = '',
    this.updatedAt = '',
    this.source = 'user',
  });

  factory MainAgentPromptResource.fromJson(Map<String, dynamic> json) =>
      MainAgentPromptResource(
        id: json['id'] as String? ?? '',
        name: json['name'] as String? ?? '',
        mode: json['mode'] as String? ?? 'builtin',
        prompt: json['prompt'] as String? ?? '',
        updatedAt: json['updatedAt'] as String? ?? '',
        source: json['source'] as String? ?? 'user',
      );

  final String id;
  final String name;
  final String mode;
  final String prompt;
  final String updatedAt;
  final String source;
}

class AgentInstanceConfig {
  const AgentInstanceConfig({
    required this.agentKey,
    required this.templateId,
    required this.modelRef,
    required this.tools,
    this.displayName,
    this.themeColor,
    this.mcpServers = const [],
    this.skills = const [],
    this.enabled = true,
    this.claudeAutoCompactWindow,
  });

  factory AgentInstanceConfig.fromJson(Map<String, dynamic> json) =>
      AgentInstanceConfig(
        agentKey: json['agentKey'] as String? ?? '',
        templateId: json['templateId'] as String? ?? '',
        displayName: json['displayName'] as String?,
        themeColor: json['themeColor'] as String?,
        modelRef: OrchestrationModelRef.fromJson(
          json['modelRef'] as Map<String, dynamic>? ?? const {},
        ),
        tools: ToolPolicy.fromJson(json['tools'] as Map<String, dynamic>?),
        mcpServers: (json['mcpServers'] as List<dynamic>? ?? const [])
            .map((entry) => entry.toString())
            .toList(growable: false),
        skills: (json['skills'] as List<dynamic>? ?? const [])
            .map((entry) => entry.toString())
            .toList(growable: false),
        enabled: json['enabled'] as bool? ?? true,
        claudeAutoCompactWindow: (json['claudeAutoCompactWindow'] as num?)
            ?.toInt(),
      );

  final String agentKey;
  final String templateId;
  final String? displayName;
  final String? themeColor;
  final OrchestrationModelRef modelRef;
  final ToolPolicy tools;
  final List<String> mcpServers;
  final List<String> skills;
  final bool enabled;
  final int? claudeAutoCompactWindow;
}

class OrchestrationStrategy {
  const OrchestrationStrategy({required this.kind, this.guidancePrompt});

  factory OrchestrationStrategy.fromJson(Map<String, dynamic>? json) =>
      OrchestrationStrategy(
        kind: json?['kind'] as String? ?? 'autonomous',
        guidancePrompt: json?['guidancePrompt'] as String?,
      );

  final String kind;
  final String? guidancePrompt;
}

class MainAgentConfig {
  const MainAgentConfig({
    required this.agentKey,
    required this.name,
    required this.systemPromptPreset,
    required this.prompt,
    required this.modelRef,
    required this.tools,
    this.skills = const [],
  });

  factory MainAgentConfig.fromJson(Map<String, dynamic> json) =>
      MainAgentConfig(
        agentKey: json['agentKey'] as String? ?? 'main',
        name: json['name'] as String? ?? '',
        systemPromptPreset:
            json['systemPromptPreset'] as String? ?? 'core_native',
        prompt: json['prompt'] as String? ?? '',
        modelRef: OrchestrationModelRef.fromJson(
          json['modelRef'] as Map<String, dynamic>? ?? const {},
        ),
        tools: ToolPolicy.fromJson(json['tools'] as Map<String, dynamic>?),
        skills: (json['skills'] as List<dynamic>? ?? const [])
            .map((entry) => entry.toString())
            .toList(growable: false),
      );

  final String agentKey;
  final String name;
  final String systemPromptPreset;
  final String prompt;
  final OrchestrationModelRef modelRef;
  final ToolPolicy tools;
  final List<String> skills;
}

class SubagentOrchestrationResource {
  const SubagentOrchestrationResource({
    required this.id,
    required this.name,
    required this.agents,
    required this.strategy,
    this.updatedAt = '',
    this.source = 'user',
  });

  factory SubagentOrchestrationResource.fromJson(Map<String, dynamic> json) =>
      SubagentOrchestrationResource(
        id: json['id'] as String? ?? '',
        name: json['name'] as String? ?? '',
        agents: (json['agents'] as List<dynamic>? ?? const [])
            .map(
              (entry) =>
                  AgentInstanceConfig.fromJson(entry as Map<String, dynamic>),
            )
            .toList(growable: false),
        strategy: OrchestrationStrategy.fromJson(
          json['strategy'] as Map<String, dynamic>?,
        ),
        updatedAt: json['updatedAt'] as String? ?? '',
        source: json['source'] as String? ?? 'user',
      );

  final String id;
  final String name;
  final List<AgentInstanceConfig> agents;
  final OrchestrationStrategy strategy;
  final String updatedAt;
  final String source;
}

class ResolvedOrchestrationSnapshot {
  const ResolvedOrchestrationSnapshot({
    required this.selection,
    required this.mainAgentConfigName,
    required this.mainPromptDisplayName,
    required this.mainAgent,
    required this.agents,
    required this.strategy,
    required this.resolvedAt,
    this.subagentOrchestrationDisplayName,
  });

  factory ResolvedOrchestrationSnapshot.fromJson(Map<String, dynamic> json) =>
      ResolvedOrchestrationSnapshot(
        selection: OrchestrationSelection.fromJson(
          json['selection'] as Map<String, dynamic>? ?? const {},
        ),
        mainAgentConfigName: json['mainAgentConfigName'] as String? ?? '',
        mainPromptDisplayName: json['mainPromptDisplayName'] as String? ?? '',
        subagentOrchestrationDisplayName:
            json['subagentOrchestrationDisplayName'] as String?,
        mainAgent: MainAgentConfig.fromJson(
          json['mainAgent'] as Map<String, dynamic>? ?? const {},
        ),
        agents: (json['agents'] as List<dynamic>? ?? const [])
            .map(
              (entry) =>
                  AgentInstanceConfig.fromJson(entry as Map<String, dynamic>),
            )
            .toList(growable: false),
        strategy: OrchestrationStrategy.fromJson(
          json['strategy'] as Map<String, dynamic>?,
        ),
        resolvedAt: json['resolvedAt'] as String? ?? '',
      );

  Map<String, dynamic> toJson() => {
    'selection': selection.toJson(),
    'mainAgentConfigName': mainAgentConfigName,
    'mainPromptDisplayName': mainPromptDisplayName,
    if (subagentOrchestrationDisplayName != null)
      'subagentOrchestrationDisplayName': subagentOrchestrationDisplayName,
    'mainAgent': {
      'agentKey': mainAgent.agentKey,
      'name': mainAgent.name,
      'systemPromptPreset': mainAgent.systemPromptPreset,
      'prompt': mainAgent.prompt,
      'modelRef': mainAgent.modelRef.toJson(),
      'tools': {
        'allowed': mainAgent.tools.allowed,
        'disallowed': mainAgent.tools.disallowed,
        if (mainAgent.tools.mcp != null)
          'mcp': {
            'allowedServers': mainAgent.tools.mcp!.allowedServers,
            'allowedTools': const <String>[],
          },
        if (mainAgent.tools.confirmation != null)
          'confirmation': mainAgent.tools.confirmation,
      },
      'skills': mainAgent.skills,
    },
    'agents': agents
        .map(
          (agent) => {
            'agentKey': agent.agentKey,
            'templateId': agent.templateId,
            if (agent.displayName != null) 'displayName': agent.displayName,
            if (agent.themeColor != null) 'themeColor': agent.themeColor,
            'modelRef': agent.modelRef.toJson(),
            'tools': {
              'allowed': agent.tools.allowed,
              'disallowed': agent.tools.disallowed,
              if (agent.tools.mcp != null)
                'mcp': {
                  'allowedServers': agent.tools.mcp!.allowedServers,
                  'allowedTools': const <String>[],
                },
            },
            'mcpServers': agent.mcpServers,
            'skills': agent.skills,
            'enabled': agent.enabled,
            if (agent.claudeAutoCompactWindow != null)
              'claudeAutoCompactWindow': agent.claudeAutoCompactWindow,
          },
        )
        .toList(growable: false),
    'strategy': {
      'kind': strategy.kind,
      if (strategy.guidancePrompt != null)
        'guidancePrompt': strategy.guidancePrompt,
    },
    'resolvedAt': resolvedAt,
  };

  final OrchestrationSelection selection;
  final String mainAgentConfigName;
  final String mainPromptDisplayName;
  final String? subagentOrchestrationDisplayName;
  final MainAgentConfig mainAgent;
  final List<AgentInstanceConfig> agents;
  final OrchestrationStrategy strategy;
  final String resolvedAt;
}

class OrchestrationResourceLookup {
  const OrchestrationResourceLookup({
    required this.mainAgentConfigs,
    required this.mainAgentPrompts,
    required this.subagentOrchestrations,
  });

  final List<MainAgentConfigResource> mainAgentConfigs;
  final List<MainAgentPromptResource> mainAgentPrompts;
  final List<SubagentOrchestrationResource> subagentOrchestrations;
}

bool isOrchestrationSelection(Object? value) {
  if (value is! Map) return false;
  final mainAgentConfigId = value['mainAgentConfigId'];
  if (mainAgentConfigId is! String || mainAgentConfigId.trim().isEmpty) {
    return false;
  }
  try {
    MainAgentPromptSelection.fromJson(value['mainPrompt']);
    SubagentSelection.fromJson(value['subagents']);
    return true;
  } catch (_) {
    return false;
  }
}

bool isResolvedOrchestrationSnapshot(Object? value) {
  if (value is! Map) return false;
  try {
    ResolvedOrchestrationSnapshot.fromJson(value.cast<String, dynamic>());
    return true;
  } catch (_) {
    return false;
  }
}

bool hasCompleteOrchestrationSelection(OrchestrationSelection? selection) {
  if (selection == null) return false;
  if (selection.mainAgentConfigId.trim().isEmpty) return false;
  final mainPrompt = selection.mainPrompt;
  if (mainPrompt is CustomAppendMainAgentPromptSelection &&
      mainPrompt.promptId.trim().isEmpty) {
    return false;
  }
  final subagents = selection.subagents;
  if (subagents is OrchestrationSubagentSelection &&
      subagents.orchestrationId.trim().isEmpty) {
    return false;
  }
  return true;
}

String resolveMainPromptDisplayName(
  MainAgentPromptSelection selection,
  List<MainAgentPromptResource> prompts,
) {
  if (selection is BuiltinMainAgentPromptSelection) {
    return '内置提示词';
  }
  final custom = selection as CustomAppendMainAgentPromptSelection;
  for (final prompt in prompts) {
    if (prompt.id == custom.promptId) {
      return prompt.name;
    }
  }
  throw FormatException('找不到主 Agent 提示词：${custom.promptId}');
}

MainAgentConfig materializeMainAgentConfig(
  MainAgentConfigResource config,
  MainAgentPromptSelection promptSelection,
  List<MainAgentPromptResource> prompts,
) {
  if (promptSelection is BuiltinMainAgentPromptSelection) {
    return MainAgentConfig(
      agentKey: config.agentKey,
      name: config.name,
      systemPromptPreset: 'core_native',
      prompt: '',
      modelRef: config.modelRef,
      tools: config.tools,
      skills: config.skills,
    );
  }
  final custom = promptSelection as CustomAppendMainAgentPromptSelection;
  MainAgentPromptResource? prompt;
  for (final entry in prompts) {
    if (entry.id == custom.promptId) {
      prompt = entry;
      break;
    }
  }
  if (prompt == null) {
    throw FormatException('找不到主 Agent 提示词：${custom.promptId}');
  }
  if (prompt.mode == 'builtin') {
    throw FormatException('主 Agent 提示词「${prompt.id}」不是有效的自定义追加资源。');
  }
  return MainAgentConfig(
    agentKey: config.agentKey,
    name: config.name,
    systemPromptPreset: 'custom_append',
    prompt: prompt.prompt,
    modelRef: config.modelRef,
    tools: config.tools,
    skills: config.skills,
  );
}

ResolvedOrchestrationSnapshot resolveOrchestrationSnapshot(
  OrchestrationSelection selection,
  OrchestrationResourceLookup lookup,
) {
  MainAgentConfigResource? mainAgentConfig;
  for (final entry in lookup.mainAgentConfigs) {
    if (entry.id == selection.mainAgentConfigId.trim()) {
      mainAgentConfig = entry;
      break;
    }
  }
  if (mainAgentConfig == null) {
    throw FormatException('找不到主 Agent 配置：${selection.mainAgentConfigId}');
  }

  final mainAgent = materializeMainAgentConfig(
    mainAgentConfig,
    selection.mainPrompt,
    lookup.mainAgentPrompts,
  );
  final mainPromptDisplayName = resolveMainPromptDisplayName(
    selection.mainPrompt,
    lookup.mainAgentPrompts,
  );

  if (selection.subagents is NoneSubagentSelection) {
    return ResolvedOrchestrationSnapshot(
      selection: selection,
      mainAgentConfigName: mainAgentConfig.name,
      mainPromptDisplayName: mainPromptDisplayName,
      mainAgent: mainAgent,
      agents: const [],
      strategy: const OrchestrationStrategy(kind: 'autonomous'),
      resolvedAt: DateTime.now().toUtc().toIso8601String(),
    );
  }

  final orchestrationId =
      (selection.subagents as OrchestrationSubagentSelection).orchestrationId;
  SubagentOrchestrationResource? subagentOrchestration;
  for (final entry in lookup.subagentOrchestrations) {
    if (entry.id == orchestrationId.trim()) {
      subagentOrchestration = entry;
      break;
    }
  }
  if (subagentOrchestration == null) {
    throw FormatException('找不到子代理编排：$orchestrationId');
  }

  return ResolvedOrchestrationSnapshot(
    selection: selection,
    mainAgentConfigName: mainAgentConfig.name,
    mainPromptDisplayName: mainPromptDisplayName,
    subagentOrchestrationDisplayName: subagentOrchestration.name,
    mainAgent: mainAgent,
    agents: List<AgentInstanceConfig>.of(subagentOrchestration.agents),
    strategy: subagentOrchestration.strategy,
    resolvedAt: DateTime.now().toUtc().toIso8601String(),
  );
}

String mainPromptSelectionValue(MainAgentPromptSelection? selection) {
  if (selection is BuiltinMainAgentPromptSelection) {
    return builtinMainPromptValue;
  }
  if (selection is CustomAppendMainAgentPromptSelection) {
    return selection.promptId;
  }
  return '';
}

String subagentSelectionValue(SubagentSelection? selection) {
  if (selection == null || selection is NoneSubagentSelection) {
    return subagentsNoneValue;
  }
  return (selection as OrchestrationSubagentSelection).orchestrationId;
}

OrchestrationSelection emptyOrchestrationSelection() {
  return const OrchestrationSelection(
    mainAgentConfigId: '',
    mainPrompt: BuiltinMainAgentPromptSelection(),
    subagents: NoneSubagentSelection(),
  );
}
