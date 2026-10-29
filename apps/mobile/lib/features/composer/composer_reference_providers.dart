import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/models/composer_reference_models.dart';
import '../../core/models/integration_models.dart';
import '../../core/models/mcp_models.dart';
import '../../core/models/thread_models.dart';
import '../../core/models/thread_runtime_config.dart';
import '../threads/thread_providers.dart';

typedef ComposerReferenceSearch = ({
  String query,
  String? kind,
  ThreadRuntimeConfig runtimeConfig,
  String workspacePath,
  String? coreKind,
});

final composerReferenceSearchProvider = FutureProvider.autoDispose
    .family<ComposerReferenceSearchResult, ComposerReferenceSearch>((
      ref,
      input,
    ) async {
      final rpc = ref.watch(desktopRpcProvider);
      if (rpc == null) throw StateError('引用服务尚未连接');
      final config = input.runtimeConfig;
      final needsIntegrations =
          input.kind == null || input.kind == 'integration';
      final needsMcp = input.kind == null || input.kind == 'mcp';
      final needsAgents =
          input.coreKind != 'acp' &&
          (input.kind == null || input.kind == 'subagent');
      // Register every dependency before awaiting. A query can be disposed or
      // invalidated while desktop settings are loading.
      final pending = <Future<Object?>>[
        rpc.searchComposerReferences(query: input.query, kind: input.kind),
        if (needsMcp || needsAgents)
          ref.watch(modelSettingsProvider.future)
        else
          Future.value(null),
        if ((needsMcp && config.mcpServersEnabled == null) ||
            (needsIntegrations && config.integrationsEnabled == null))
          ref.watch(workflowSettingsProvider.future)
        else
          Future.value(null),
        if (needsIntegrations &&
            config.integrationsEnabled == null &&
            input.workspacePath.isNotEmpty)
          ref.watch(
            projectIntegrationsSettingsProvider(input.workspacePath).future,
          )
        else
          Future.value(null),
        if (needsIntegrations)
          ref.watch(integrationAvailabilityProvider.future)
        else
          Future.value(null),
      ];
      final values = await Future.wait(pending);
      final result = values[0] as ComposerReferenceSearchResult;
      final settings = values[1] as ModelSettingsSnapshot?;
      final workflow = values[2] as WorkflowSettingsSnapshot?;
      final project = values[3] as ProjectIntegrationsSettingsSnapshot?;
      final availability = values[4] as IntegrationAvailabilitySnapshot?;
      if (needsIntegrations && availability == null) {
        throw StateError('无法读取集成工具状态');
      }
      final snapshot = needsMcp || needsAgents
          ? resolveThreadOrchestrationSnapshot(settings, config)
          : null;
      // Do not turn MCP transport errors into an empty capability list.
      final servers = needsMcp
          ? settings?.mcpSettings?.servers ??
                (await rpc.getMcpSettings()).servers
          : const <McpServerConfigView>[];
      final capabilities = buildComposerCapabilityReferences(
        availability:
            availability ??
            const IntegrationAvailabilitySnapshot(integrations: []),
        integrationsEnabled:
            config.integrationsEnabled ??
            project?.enabled ??
            workflow?.integrationsEnabled ??
            {},
        mcpServers: servers,
        mcpServersEnabled: resolveComposerMcpSettings(
          servers: servers,
          runtimeConfig: config,
          snapshot: snapshot,
          remembered: workflow?.mcpServersEnabled,
        ),
        agents: needsAgents ? snapshot?.agents ?? [] : [],
        subagentEnabled: config.subagentEnabled,
      ).where((item) => item.matches(input.query, input.kind));
      return ComposerReferenceSearchResult(
        items: [...capabilities, ...result.items],
        hasMore: result.hasMore,
      );
    });
