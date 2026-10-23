import '../models/conversation_v2_models.dart';

/// Matches limitConversationToolSummaryPayload in packages/shared. Push effects
/// can carry full payloads while bootstrap/tool pages carry bounded summaries.
/// The summary cache must compare the same representation on both paths; full
/// tool output is read separately from the detail endpoint.
ConversationV2Tool limitConversationV2ToolSummaryPayload(
  ConversationV2Tool tool,
) => ConversationV2Tool(
  toolCallId: tool.toolCallId,
  conversationId: tool.conversationId,
  runId: tool.runId,
  agentId: tool.agentId,
  agentInstanceId: tool.agentInstanceId,
  parentAgentInstanceId: tool.parentAgentInstanceId,
  parentToolCallId: tool.parentToolCallId,
  name: tool.name,
  status: tool.status,
  createdSeq: tool.createdSeq,
  versionSeq: tool.versionSeq,
  occurredAt: tool.occurredAt,
  providerRole: tool.providerRole,
  input: _boundedPayload(tool.input),
  output: _boundedPayload(tool.output),
);

dynamic _boundedPayload(dynamic value, [int depth = 0]) {
  if (value == null || value is num || value is bool) return value;
  if (value is String) {
    return value.length <= 4000 ? value : '${value.substring(0, 4000)}…';
  }
  if (depth >= 4) {
    final text = _javascriptString(value);
    return text.length <= 1000 ? text : text.substring(0, 1000);
  }
  if (value is List) {
    return value
        .take(32)
        .map((item) => _boundedPayload(item, depth + 1))
        .toList();
  }
  if (value is Map) {
    return {
      for (final entry in value.entries.take(48))
        entry.key.toString(): _boundedPayload(entry.value, depth + 1),
    };
  }
  throw StateError('Conversation V2 tool payload is not JSON.');
}

String _javascriptString(dynamic value) {
  if (value is Map) return '[object Object]';
  if (value is List) {
    return value
        .map((item) => item == null ? '' : _javascriptString(item))
        .join(',');
  }
  return value.toString();
}
