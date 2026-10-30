import '../utils/composer_references.dart';
import 'composer_mcp.dart';
import 'integration_models.dart';
import 'mcp_models.dart';
import 'thread_models.dart';

class ComposerReference {
  const ComposerReference({
    required this.kind,
    required this.id,
    required this.label,
    required this.detail,
    this.searchTerms = '',
  });

  factory ComposerReference.fromJson(Map<String, dynamic> json) {
    final reference = ComposerReference(
      kind: json['kind'] as String,
      id: json['id'] as String,
      label: json['label'] as String,
      detail: json['detail'] as String,
    );
    if (!parseComposerPrompt(reference.token).any((part) => part.isReference)) {
      throw const FormatException('Invalid composer reference');
    }
    return reference;
  }

  final String kind;
  final String id;
  final String label;
  final String detail;
  final String searchTerms;

  String get key => '$kind:$id';
  String get token =>
      composerReferenceToken(kind: kind, id: id, label: label, detail: detail);

  bool matches(String query, String? category) =>
      (category == null || category == kind) &&
      '$label $detail $searchTerms'.toLowerCase().contains(
        query.trim().toLowerCase(),
      );
}

class ComposerReferenceSearchResult {
  const ComposerReferenceSearchResult({
    required this.items,
    required this.hasMore,
  });

  factory ComposerReferenceSearchResult.fromJson(Map<String, dynamic> json) =>
      ComposerReferenceSearchResult(
        items: (json['items'] as List)
            .map(
              (item) => ComposerReference.fromJson(
                Map<String, dynamic>.from(item as Map),
              ),
            )
            .toList(growable: false),
        hasMore: json['hasMore'] as bool,
      );

  final List<ComposerReference> items;
  final bool hasMore;
}

/// Only public metadata belongs in reference candidates; never copy connection
/// configs, environment variables, headers or credentials into a prompt.
List<ComposerReference> buildComposerCapabilityReferences({
  required IntegrationAvailabilitySnapshot availability,
  required Map<String, bool> integrationsEnabled,
  required List<McpServerConfigView> mcpServers,
  required Map<String, bool> mcpServersEnabled,
  required List<AgentInstanceConfig> agents,
  required Map<String, bool> subagentEnabled,
}) {
  const integrations = {
    'browser': ('浏览器', 'browser 浏览器 网页操作'),
    'imageGeneration': (
      '创意绘画',
      'imageGeneration image generation drawing 创意绘画 绘图 图片生成',
    ),
    'tts': ('语音生成', 'tts speech generation text to speech voice 语音生成'),
    'computerUse': ('电脑操控', 'computerUse computer use desktop 电脑操控'),
  };
  return [
    for (final item in availability.integrations)
      if (item.enabled &&
          item.available &&
          integrationsEnabled[item.id] == true &&
          integrations.containsKey(item.id))
        ComposerReference(
          kind: 'integration',
          id: item.id,
          label: integrations[item.id]!.$1,
          detail: item.activeProfileName ?? '',
          searchTerms: integrations[item.id]!.$2,
        ),
    for (final agent in agents)
      if (agent.enabled &&
          agent.agentKey.trim().isNotEmpty &&
          agent.modelRef.modelId.trim().isNotEmpty &&
          subagentEnabled[agent.agentKey] != false)
        ComposerReference(
          kind: 'subagent',
          id: agent.agentKey,
          label: agent.displayName?.trim().isNotEmpty == true
              ? agent.displayName!.trim()
              : agent.agentKey,
          detail: agent.modelRef.modelId,
          searchTerms: '子代理 subagent ${agent.agentKey}',
        ),
    for (final server in mcpServers)
      if (server.enabled &&
          server.name.trim().isNotEmpty &&
          mcpServersEnabled[sanitizeMcpServerName(server.name)] == true)
        ComposerReference(
          kind: 'mcp',
          id: server.id,
          label: server.name,
          detail: server.transport,
          searchTerms: 'MCP ${sanitizeMcpServerName(server.name)}',
        ),
  ];
}
