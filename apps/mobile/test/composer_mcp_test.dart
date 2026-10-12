import 'package:flutter_test/flutter_test.dart';

import 'package:eco_mobile/core/models/composer_mcp.dart';
import 'package:eco_mobile/core/models/mcp_models.dart';
import 'package:eco_mobile/core/models/thread_models.dart';
import 'package:eco_mobile/core/models/thread_runtime_config.dart';
import 'package:eco_mobile/features/settings/settings_workflow_persistence.dart';

const _servers = [
  McpServerConfigView(
    id: '1',
    name: 'mongo',
    transport: 'stdio',
    enabled: true,
  ),
  McpServerConfigView(
    id: '2',
    name: 'browser',
    transport: 'stdio',
    enabled: true,
  ),
];

ModelSettingsSnapshot _settings() {
  return ModelSettingsSnapshot(
    mainAgentConfigs: [
      MainAgentConfigResource(
        id: 'main-1',
        name: 'Orchestration',
        agentKey: 'main',
        modelRef: const OrchestrationModelRef(
          providerId: 'provider-1',
          modelId: 'gpt-5.6-sol',
        ),
        tools: const ToolPolicy(mcp: ToolPolicyMcp(allowedServers: ['mongo'])),
      ),
    ],
    subagentOrchestrations: const [
      SubagentOrchestrationResource(
        id: 'orch-1',
        name: 'Subagents',
        agents: [],
        strategy: OrchestrationStrategy(kind: 'autonomous'),
      ),
    ],
  );
}

ResolvedOrchestrationSnapshot _snapshot() {
  return resolveOrchestrationSnapshot(
    const OrchestrationSelection(
      mainAgentConfigId: 'main-1',
      mainPrompt: BuiltinMainAgentPromptSelection(),
      subagents: OrchestrationSubagentSelection(orchestrationId: 'orch-1'),
    ),
    OrchestrationResourceLookup(
      mainAgentConfigs: _settings().mainAgentConfigs,
      mainAgentPrompts: const [],
      subagentOrchestrations: _settings().subagentOrchestrations,
    ),
  );
}

void main() {
  test(
    'deriveMcpServersEnabled prefers existing over remembered and orchestration',
    () {
      expect(
        deriveMcpServersEnabled(
          const ['mongo', 'browser'],
          orchestrationAssignedServers: const ['mongo'],
          remembered: const {'mongo': false, 'browser': true},
          existing: const {'mongo': true},
        ),
        const {'mongo': true, 'browser': true},
      );
    },
  );

  test('resolveComposerMcpSettings uses runtime overrides when present', () {
    final runtimeConfig = ThreadRuntimeConfig(
      orchestrationSelection: const OrchestrationSelection(
        mainAgentConfigId: 'main-1',
        mainPrompt: BuiltinMainAgentPromptSelection(),
        subagents: OrchestrationSubagentSelection(orchestrationId: 'orch-1'),
      ),
      resolvedOrchestrationSnapshot: _snapshot(),
      subagentEnabled: defaultSubagentAvailability(),
      mcpServersEnabled: const {'mongo': false, 'browser': true},
      sessionMode: 'agent',
      bashReviewMode: 'always',
    );

    expect(
      resolveComposerMcpSettings(
        servers: _servers,
        runtimeConfig: runtimeConfig,
        snapshot: _snapshot(),
      ),
      const {'mongo': false, 'browser': true},
    );
  });

  test('buildDefaultRuntimeConfig seeds MCP from workflow defaults', () {
    final settings = _settings();
    final config = buildDefaultRuntimeConfig(
      modelSettings: settings,
      workflow: const WorkflowSettingsSnapshot(
        sessionMode: 'agent',
        mcpServersEnabled: {'browser': true},
        defaultOrchestrationSelection: OrchestrationSelection(
          mainAgentConfigId: 'main-1',
          mainPrompt: BuiltinMainAgentPromptSelection(),
          subagents: OrchestrationSubagentSelection(orchestrationId: 'orch-1'),
        ),
      ),
      mcpServers: _servers,
    );

    expect(config.mcpServersEnabled, const {'mongo': true, 'browser': true});
  });

  test(
    'buildDefaultRuntimeConfig seeds integrations from workflow defaults',
    () {
      final config = buildDefaultRuntimeConfig(
        modelSettings: _settings(),
        workflow: const WorkflowSettingsSnapshot(
          sessionMode: 'agent',
          integrationsEnabled: {'browser': true, 'imageGeneration': true},
          defaultOrchestrationSelection: OrchestrationSelection(
            mainAgentConfigId: 'main-1',
            mainPrompt: BuiltinMainAgentPromptSelection(),
            subagents: OrchestrationSubagentSelection(
              orchestrationId: 'orch-1',
            ),
          ),
        ),
        mcpServers: _servers,
      );

      expect(config.integrationsEnabled, const {
        'browser': true,
        'imageGeneration': true,
      });
    },
  );

  test(
    'WorkflowSettingsSnapshot toJson includes sessionMode and planModelEnabled',
    () {
      final planSnapshot = const WorkflowSettingsSnapshot(
        sessionMode: 'plan',
        mcpServersEnabled: {'mongo': true},
      );
      final planJson = planSnapshot.toJson();
      expect(planJson['sessionMode'], 'plan');
      expect(planJson['planModelEnabled'], true);
      expect(planJson['contextWindowLimitTokens'], 262144);
      expect(planJson['maxOutputLimitTokens'], 'dynamic');
      expect(planJson['showBilling'], true);
      expect(planJson['mcpServersEnabled'], {'mongo': true});

      final agentSnapshot = const WorkflowSettingsSnapshot(
        sessionMode: 'agent',
        mcpServersEnabled: {'mongo': true},
      );
      final agentJson = agentSnapshot.toJson();
      expect(agentJson['sessionMode'], 'agent');
      expect(agentJson['planModelEnabled'], false);
      expect(agentJson['contextWindowLimitTokens'], 262144);
      expect(agentJson['maxOutputLimitTokens'], 'dynamic');
      expect(agentJson['showBilling'], true);
      expect(agentJson['mcpServersEnabled'], {'mongo': true});

      final noMcpSnapshot = const WorkflowSettingsSnapshot(sessionMode: 'ask');
      final noMcpJson = noMcpSnapshot.toJson();
      expect(noMcpJson['sessionMode'], 'ask');
      expect(noMcpJson['planModelEnabled'], false);
      expect(noMcpJson['contextWindowLimitTokens'], 262144);
      expect(noMcpJson['maxOutputLimitTokens'], 'dynamic');
      final hidden = WorkflowSettingsSnapshot.fromJson(const {
        'sessionMode': 'agent',
        'showBilling': false,
      });
      expect(hidden.showBilling, false);
      expect(hidden.toJson()['showBilling'], false);
      expect(noMcpJson.containsKey('mcpServersEnabled'), false);
    },
  );

  test('WorkflowSettingsSnapshot preserves supported context limits', () {
    final snapshot = WorkflowSettingsSnapshot.fromJson({
      'sessionMode': 'agent',
      'contextWindowLimitTokens': 300000,
    });
    final invalid = WorkflowSettingsSnapshot.fromJson({
      'sessionMode': 'agent',
      'contextWindowLimitTokens': 2000000,
    });

    expect(snapshot.contextWindowLimitTokens, 300000);
    expect(invalid.contextWindowLimitTokens, 262144);
  });

  test('WorkflowSettingsSnapshot preserves supported max output limits', () {
    final snapshot = WorkflowSettingsSnapshot.fromJson({
      'sessionMode': 'agent',
      'maxOutputLimitTokens': 131072,
    });
    final invalid = WorkflowSettingsSnapshot.fromJson({
      'sessionMode': 'agent',
      'maxOutputLimitTokens': 2000000,
    });

    expect(snapshot.maxOutputLimitTokens, 131072);
    expect(invalid.maxOutputLimitTokens, 'dynamic');
  });

  test('dynamic output survives a mobile workflow copy and serialization', () {
    final workflow = WorkflowSettingsSnapshot.fromJson({
      'sessionMode': 'agent',
      'maxOutputLimitTokens': 'dynamic',
    });
    final copied = workflowSettingsWith(workflow: workflow, showBilling: false);
    expect(copied.maxOutputLimitTokens, 'dynamic');
    expect(copied.toJson()['maxOutputLimitTokens'], 'dynamic');
  });

  test('ModelSettingsSnapshot parses embedded mcpSettings', () {
    final settings = ModelSettingsSnapshot.fromJson({
      'mainAgentConfigs': [],
      'mainAgentPrompts': [],
      'subagentOrchestrations': [],
      'mcpSettings': {
        'servers': [
          {'id': '1', 'name': 'mongo', 'transport': 'stdio', 'enabled': true},
        ],
      },
    });

    expect(settings.mcpSettings?.servers.length, 1);
    expect(settings.mcpSettings?.servers.first.name, 'mongo');
  });
}
