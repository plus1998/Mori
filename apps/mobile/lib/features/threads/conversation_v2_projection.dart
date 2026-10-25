import 'dart:convert';

import '../../core/models/conversation_v2_models.dart';
import '../../core/models/conversation_v2_projection_models.dart';
import '../../core/utils/activity_display.dart';
import '../../core/utils/agent_role.dart';
import '../../core/utils/file_change.dart';

/// Retains only the current window's row adapters. Versions are authoritative
/// within an epoch; history targets can also be enriched at the same version.
class ConversationV2ProjectionCache {
  (String, String, int)? _scope;
  final _messages = <String, (Object, ThreadRunProjectionTimelineItem?)>{};
  final _tools = <String, (Object, ThreadRunProjectionTimelineItem)>{};
  final _seenMessages = <String>{};
  final _seenTools = <String>{};

  void _begin(String epoch, String conversationId, int revision) {
    final scope = (epoch, conversationId, revision);
    if (_scope != scope) {
      _scope = scope;
      _messages.clear();
      _tools.clear();
    }
    _seenMessages.clear();
    _seenTools.clear();
  }

  void _finish() {
    _messages.removeWhere((id, _) => !_seenMessages.contains(id));
    _tools.removeWhere((id, _) => !_seenTools.contains(id));
  }

  ThreadRunProjectionTimelineItem? _message(
    ConversationV2Message message,
    String? agentId,
  ) {
    _seenMessages.add(message.messageId);
    final key = (
      message.versionSeq,
      agentId,
      message.historyTarget?.activityLineId,
      message.historyTarget?.userMessageId,
    );
    final cached = _messages[message.messageId];
    if (cached != null && cached.$1 == key) return cached.$2;
    final item = _messageTimelineItem(message, agentId: agentId);
    _messages[message.messageId] = (key, item);
    return item;
  }

  ThreadRunProjectionTimelineItem _tool(
    ConversationV2Tool tool,
    String? agentId,
  ) {
    _seenTools.add(tool.toolCallId);
    final key = (tool.versionSeq, agentId);
    final cached = _tools[tool.toolCallId];
    if (cached != null && cached.$1 == key) return cached.$2;
    final item = _toolTimelineItem(tool, agentId: agentId);
    _tools[tool.toolCallId] = (key, item);
    return item;
  }
}

/// Converts the V2 read models into the presentation projection consumed by
/// the existing mobile Feed.
///
/// This is deliberately a presentation adapter, not a second storage path:
/// messages, runs and tools still come exclusively from V2. Keeping the
/// adapter here lets V2 inherit the mobile Feed's established grouping,
/// turn/action summaries, tool cards and subagent layout while the protocol
/// catches up with those presentation fields.
ThreadRunProjectionSnapshot buildConversationV2Projection({
  required String conversationId,
  required List<ConversationV2Message> messages,
  required List<ConversationV2Run> runs,
  required List<ConversationV2Tool> tools,
  List<ConversationV2Agent> agents = const [],
  List<ConversationV2Detail> details = const [],
  ConversationV2ProjectionExtras? projectionExtras,
  bool hasEarlier = false,
  int historyRevision = 0,
  ConversationV2ProjectionCache? cache,
  String? storeEpoch,
}) {
  if (cache != null) {
    if (storeEpoch == null || storeEpoch.isEmpty) {
      throw ArgumentError('A projection cache requires its store epoch.');
    }
    cache._begin(storeEpoch, conversationId, historyRevision);
  }
  final sortedRuns = [...runs]
    ..sort((left, right) {
      final sequence = left.versionSeq.compareTo(right.versionSeq);
      return sequence != 0 ? sequence : left.runId.compareTo(right.runId);
    });
  final attempts = [
    for (final run in sortedRuns)
      ThreadRunProjectionAttempt(
        attemptId: run.runId,
        phase: 'main',
        retryIndex: run.retryOfRunId == null ? 0 : 1,
        status: _projectionAttemptStatus(run.status),
        startedAt: run.startedAt ?? _v2Timestamp(run.versionSeq),
        endedAt: run.endedAt,
      ),
  ];

  // `message.accepted` is the durable receipt for a queued follow-up. Until the
  // runtime finalizes it, the queue bar is its only visible representation;
  // rendering it here makes the same prompt look both queued and already sent.
  final sortedMessages =
      messages
          .where(
            (message) =>
                !(message.role == 'user' &&
                    message.status == ConversationV2MessageStatus.queued),
          )
          .toList()
        ..sort(_compareMessages);
  final sortedTools = [...tools]
    ..sort((left, right) {
      final time = _compareRowTime(left.occurredAt, right.occurredAt);
      if (time != 0) return time;
      final sequence = left.createdSeq.compareTo(right.createdSeq);
      return sequence != 0
          ? sequence
          : left.toolCallId.compareTo(right.toolCallId);
    });
  final sortedDetails = [...details]
    ..sort((left, right) {
      final sequence = left.createdSeq.compareTo(right.createdSeq);
      return sequence != 0 ? sequence : left.itemId.compareTo(right.itemId);
    });

  final toolsByAgent = <String, List<ConversationV2Tool>>{};
  for (final tool in sortedTools) {
    final agentId = tool.agentId?.trim();
    if (agentId == null || agentId.isEmpty) continue;
    toolsByAgent.putIfAbsent(agentId, () => []).add(tool);
  }

  // The registry says which owners are cards. Inferring that from the tools an owner has is
  // the old behaviour and it is lossy in both directions: an agent whose narration never
  // called a tool gets no card (its rows land in the main Feed, which is the desktop defect
  // this mirrors), and the card cannot show the role, the task name or the delegation text,
  // because those only ever lived in the registry. A payload without a registry (an older
  // desktop) still falls back to the tool-derived cards.
  final registry = <String, ConversationV2Agent>{
    for (final agent in agents)
      if (agent.agentId.trim().isNotEmpty) agent.agentId.trim(): agent,
  };
  final cardAgentIds = <String>{
    for (final agent in registry.values)
      if (agent.kind == 'subagent') agent.agentId,
  };
  bool isCardOwner(String? agentId) {
    final id = agentId?.trim();
    if (id == null || id.isEmpty) return false;
    if (registry.isNotEmpty) return cardAgentIds.contains(id);
    return toolsByAgent.containsKey(id);
  }

  final mainTimeline = <ThreadRunProjectionTimelineItem>[];
  final messagesByAgent = <String, List<ThreadRunProjectionTimelineItem>>{};
  for (final message in sortedMessages) {
    final ownerAgentId = message.agentId?.trim();
    // A subagent's narration belongs to that agent's card, not to the main Feed:
    // the legacy projection kept those rows off the main timeline by scope. An
    // owner without a card (orphan agent id) stays on the Feed, because showing
    // the content beats hiding it where nothing can render it.
    final agentId = isCardOwner(ownerAgentId) ? ownerAgentId : null;
    final item = cache == null
        ? _messageTimelineItem(message, agentId: agentId)
        : cache._message(message, agentId);
    if (item == null) continue;
    if (agentId == null) {
      mainTimeline.add(item);
      continue;
    }
    messagesByAgent.putIfAbsent(agentId, () => []).add(item);
  }

  for (final tool in sortedTools) {
    final agentId = tool.agentId?.trim();
    // A tool whose owner has no card stays on the Feed rather than disappearing: the card
    // is where the Feed would draw it, and a row it cannot draw somewhere is a lost row.
    if (isCardOwner(agentId)) continue;
    mainTimeline.add(cache?._tool(tool, null) ?? _toolTimelineItem(tool));
  }

  for (final detail in sortedDetails) {
    if (!isConversationV2ContextCompactionType(detail.type)) continue;
    final ownerAgentId = detail.agentId?.trim().isNotEmpty == true
        ? detail.agentId!.trim()
        : detail.agentInstanceId?.trim();
    final agentId = isCardOwner(ownerAgentId) ? ownerAgentId : null;
    final item = _compactionDetailTimelineItem(detail, agentId: agentId);
    if (agentId != null) {
      messagesByAgent.putIfAbsent(agentId, () => []).add(item);
    } else {
      mainTimeline.add(item);
    }
  }

  final cardOwnerIds = <String>{
    ...cardAgentIds,
    if (registry.isEmpty)
      for (final agentId in toolsByAgent.keys) agentId,
  };
  final cardAgents = [
    for (final agentId in cardOwnerIds)
      _buildAgent(
        agentId,
        toolsByAgent[agentId] ?? const [],
        messagesByAgent[agentId] ?? const [],
        registry[agentId],
        cache: cache,
      ),
  ];
  mainTimeline.sort(_compareTimelineItems);
  cache?._finish();

  return ThreadRunProjectionSnapshot(
    threadId: conversationId,
    status: _projectionThreadStatus(sortedRuns),
    generatedAt: _v2Timestamp(
      [
        ...messages.map((item) => item.versionSeq),
        ...runs.map((item) => item.versionSeq),
        ...tools.map((item) => item.versionSeq),
        ...details.map((item) => item.versionSeq),
      ].fold<int>(0, (max, value) => value > max ? value : max),
    ),
    agents: cardAgents,
    // A live V2 session with no rows is still a ready projection. This keeps
    // the UI from silently switching to stale legacy data during bootstrap.
    sourceEventCount:
        (messages.length + runs.length + tools.length + details.length).clamp(
          1,
          1 << 31,
        ),
    timeline: mainTimeline,
    requestSpans: projectionExtras?.requestSpans ?? const [],
    attempts: attempts,
    hasEarlier: hasEarlier,
    historyRevision: historyRevision,
  );
}

ThreadRunProjectionTimelineItem _compactionDetailTimelineItem(
  ConversationV2Detail detail, {
  required String? agentId,
}) {
  final rawContent = detail.content?.trim();
  Map<String, dynamic>? payload;
  if (rawContent != null && rawContent.isNotEmpty) {
    try {
      payload = _mapValue(jsonDecode(rawContent));
    } on FormatException {
      payload = null;
    }
  }
  final payloadMetadata = _mapValue(payload?['metadata']) ?? const {};
  final scope = agentId == null ? 'main' : 'agent';
  return ThreadRunProjectionTimelineItem(
    id: detail.itemId,
    sequence: detail.createdSeq,
    eventType: detail.type,
    scope: scope,
    role: payload == null
        ? 'main'
        : _firstText(payload, const ['role']) ?? 'main',
    agentId: agentId ?? detail.agentId,
    runAttemptId: detail.runId,
    requestId: payload == null
        ? null
        : _firstText(payload, const ['requestId']),
    streamKey: payload == null
        ? detail.itemId
        : _firstText(payload, const ['streamKey']) ?? detail.itemId,
    text: payload == null ? '' : _firstText(payload, const ['message']) ?? '',
    at: _v2RowTime(
      payload == null ? null : _firstText(payload, const ['observedAt']),
      detail.createdSeq,
    ),
    metadata: <String, dynamic>{
      'v2': true,
      'liveType': detail.type,
      'conversationV2DetailId': detail.itemId,
      'conversationV2VersionSeq': detail.versionSeq,
      'conversationV2RunId': detail.runId,
      if (detail.agentId != null) 'conversationV2AgentId': detail.agentId,
      if (detail.agentInstanceId != null)
        'conversationV2AgentInstanceId': detail.agentInstanceId,
      ...payloadMetadata,
    },
  );
}

/// Maps one V2 message row to a Feed timeline row, or null when it has nothing
/// to render.
ThreadRunProjectionTimelineItem? _messageTimelineItem(
  ConversationV2Message message, {
  String? agentId,
}) {
  if (message.isDeleted) return null;
  final body = message.body.trim();
  // An empty body has nothing to render. Streaming agent rows without text are
  // placeholder stream rows: when their final row never arrives they would
  // stay `streaming` forever and the Feed could never finish that turn (the
  // live run state, not the message row, owns "still working").
  if (body.isEmpty && message.role != 'user') return null;
  if (body.isEmpty && message.status != ConversationV2MessageStatus.streaming) {
    return null;
  }
  final isUser = message.role == 'user';
  // The desktop chain decides this by the channel being `thinking`, and the difference is
  // not cosmetic: a provider notice arrives on the `system` channel and is neither reasoning
  // nor assistant speech. Treating every non-`answer` row as reasoning folds the notice into
  // the thinking stream (and in collapsed mode the notice disappears from the Feed).
  final isThinking = !isUser && message.channel == 'thinking';
  // A system-channel row is a notice the provider reported (a failed request). The Feed has
  // a row for that (`api.error`), and it must not be read as the agent's speech: as
  // `message.final` the notice became the turn's *final answer* — the reader was shown the
  // failure text as what the agent said, instead of the answer that preceded it.
  final isNotice = !isThinking && message.channel == 'system';
  // SDK state/command updates use system commentary, as on desktop. Keep them
  // as diagnostics so the Feed cannot present them as speech or a final answer.
  final isDiagnostic =
      message.role == 'system' && message.channel == 'commentary';
  final eventType = isNotice
      ? 'api.error'
      : isDiagnostic
      ? 'diagnostic'
      : isThinking
      ? _messageEventType(message.status, thinking: true)
      : _messageEventType(message.status);
  final metadata = <String, dynamic>{
    'v2': true,
    'conversationV2MessageId': message.messageId,
    'conversationV2TurnId': message.turnId,
    'conversationV2VersionSeq': message.versionSeq,
    'conversationV2ContentVersion': message.contentVersion,
    'conversationV2Channel': message.channel,
    'conversationV2Status': message.toJson()['status'],
    'logicalEntityId': message.messageId,
    if (message.historyTarget != null)
      'rewindTarget': message.historyTarget!.toJson(),
    if (message.agentInstanceId != null)
      'conversationV2AgentInstanceId': message.agentInstanceId,
    if (isUser) 'liveType': 'message.user',
    if (isUser &&
        message.attachments != null &&
        message.attachments!.isNotEmpty)
      'promptImagePreviews': [
        for (final attachment in message.attachments!)
          if (attachment is Map)
            attachment.map((key, value) => MapEntry(key.toString(), value)),
      ],
  };
  return ThreadRunProjectionTimelineItem(
    id: message.messageId,
    sequence: message.createdSeq,
    eventType: eventType,
    scope: agentId == null ? 'main' : 'agent',
    // The Feed asks a row's role who wrote it (a turn's final output is the row with
    // `role == 'main'`), so the provider's own label travels with the row. The channel
    // role is the fallback for rows written before the label was recorded.
    role: message.providerRole?.trim().isNotEmpty == true
        ? normalizeAgentRole(message.providerRole!.trim())
        : (isUser ? 'user' : 'assistant'),
    agentId: agentId ?? message.agentId,
    text: message.body,
    at: _v2RowTime(message.occurredAt, message.createdSeq),
    runAttemptId: message.runId,
    streamKey: message.messageId,
    metadata: metadata,
  );
}

ThreadRunProjectionTimelineItem _toolTimelineItem(
  ConversationV2Tool tool, {
  String? agentId,
}) {
  final status = _toolStatus(tool.status);
  final toolMetadata = _toolMetadata(tool);
  // Same resolution as the metadata block (including the legacy `output` detail),
  // so the synthetic tool text and the structured card never disagree.
  final detail = toolMetadata['detail'] as String?;
  return ThreadRunProjectionTimelineItem(
    id: tool.toolCallId,
    sequence: tool.createdSeq,
    eventType: switch (status) {
      'running' => 'tool.started',
      'failed' || 'cancelled' => 'tool.failed',
      _ => 'tool.completed',
    },
    scope: agentId == null ? 'main' : 'agent',
    role: tool.providerRole?.trim().isNotEmpty == true
        ? normalizeAgentRole(tool.providerRole!.trim())
        : 'tool',
    agentId: agentId ?? tool.agentId,
    runAttemptId: tool.runId,
    text: detail == null
        ? 'Tool: ${tool.name}'
        : 'Tool: ${tool.name} · $detail',
    at: _v2RowTime(tool.occurredAt, tool.createdSeq),
    metadata: ToolDisplayMetadata({
      'v2': true,
      'liveType': 'tool.$status',
      'conversationV2ToolCallId': tool.toolCallId,
      'conversationV2VersionSeq': tool.versionSeq,
      if (tool.agentInstanceId != null)
        'conversationV2AgentInstanceId': tool.agentInstanceId,
      if (tool.parentAgentInstanceId != null)
        'conversationV2ParentAgentInstanceId': tool.parentAgentInstanceId,
      if (tool.parentToolCallId != null)
        'conversationV2ParentToolCallId': tool.parentToolCallId,
      'tool': toolMetadata,
      if (toolMetadata['bashApproval'] is Map)
        'bashApproval': toolMetadata['bashApproval'],
    }),
  );
}

/// One agent's card, from the registry entry when the conversation has one and from the
/// rows otherwise.
///
/// The registry is where the role, the task name and the delegation text live; deriving
/// them from tool rows instead invents a role (`subagent`), a title (the agent id) and a
/// delegation summary (a fixed string), all of which a reader sees. The row-derived
/// fallback stays for payloads from a desktop that predates the registry.
ThreadRunProjectionAgent _buildAgent(
  String agentId,
  List<ConversationV2Tool> tools,
  List<ThreadRunProjectionTimelineItem> messages,
  ConversationV2Agent? registered, {
  ConversationV2ProjectionCache? cache,
}) {
  final sorted = [...tools]
    ..sort((left, right) {
      final time = _compareRowTime(left.occurredAt, right.occurredAt);
      if (time != 0) return time;
      return left.createdSeq.compareTo(right.createdSeq);
    });
  final hasRunning = sorted.any(
    (tool) => _toolStatus(tool.status) == 'running',
  );
  final registeredStart = registered?.startedAt?.trim();
  final registeredEnd = registered?.endedAt?.trim();
  final rowStart = sorted.isNotEmpty
      ? _v2RowTime(sorted.first.occurredAt, sorted.first.createdSeq)
      : (messages.isEmpty ? '' : messages.first.at);
  final rowEnd = hasRunning
      ? null
      : sorted.isNotEmpty
      ? _v2RowTime(sorted.last.occurredAt, sorted.last.versionSeq)
      : (messages.isEmpty ? null : messages.last.at);
  final startedAt = registeredStart?.isNotEmpty == true
      ? registeredStart!
      : rowStart;
  final endedAt = registeredEnd?.isNotEmpty == true ? registeredEnd! : rowEnd;
  final started = DateTime.tryParse(startedAt);
  final ended = endedAt == null ? null : DateTime.tryParse(endedAt);
  final durationMs = started == null || ended == null
      ? 0
      : ended.difference(started).inMilliseconds;
  return ThreadRunProjectionAgent(
    agentId: agentId,
    role: normalizeAgentRole(registered?.role ?? 'subagent'),
    kind: normalizeAgentRole(registered?.kind ?? 'subagent'),
    // The projection's own vocabulary, mapped from the registry exactly as the desktop maps
    // it: the card's status is a rendering decision ("is this agent still going"), and the two
    // ends have to reach the same one from the same registry row.
    status: _projectionAgentStatus(
      registered?.status,
      fallback: hasRunning ? 'active' : 'stopped',
    ),
    startedAt: startedAt,
    endedAt: endedAt,
    durationMs: durationMs,
    timeline: ([
      for (final tool in sorted)
        cache?._tool(tool, agentId) ??
            _toolTimelineItem(tool, agentId: agentId),
      ...messages,
    ]..sort(_compareTimelineItems)),
    delegationSummary: registered?.delegationSummary,
    delegationPrompt: registered?.delegationPrompt,
    mission: registered?.mission,
    taskName: registered?.taskName,
    todoId: registered?.todoId,
    parentAgentId: registered?.parentAgentInstanceId,
    parentToolUseId:
        registered?.parentToolCallId ??
        (sorted.isEmpty ? null : sorted.first.parentToolCallId),
    runAttemptId:
        registered?.runId ?? (sorted.isEmpty ? null : sorted.first.runId),
  );
}

/// The registry's status, in the projection's vocabulary (desktop `agentProjectionStatus`).
String _projectionAgentStatus(String? status, {required String fallback}) {
  switch (status?.trim()) {
    case 'completed':
    case 'stopped':
      return 'stopped';
    case 'failed':
    case 'cancelled':
    case 'interrupted':
    case 'abandoned':
      return 'abandoned';
    case null:
    case '':
      return fallback;
    default:
      return 'active';
  }
}

Map<String, dynamic> _toolMetadata(ConversationV2Tool tool) {
  final input = _mapValue(tool.input);
  final arguments = _mapValue(input?['arguments']);
  final webSearch = _mapValue(input?['webSearch']);
  final values = <String, dynamic>{...?input, ...?arguments, ...?webSearch};
  // V2 tool rows written before the adapter carried a structured input kept only
  // the legacy display detail in `output`, so those rows degraded to the generic
  // "读取了文件" / "运行了命令" label. Rows written since always carry `input`,
  // which keeps a real output preview from being mistaken for a tool target.
  if (tool.input == null) {
    final legacyDetail = _toolOutputDetail(tool.output);
    if (legacyDetail != null) values['detail'] = legacyDetail;
  }
  final detail = _firstText(values, const [
    'command',
    'cmd',
    'script',
    'file_path',
    'filePath',
    'path',
    'query',
    'url',
    'pattern',
    'detail',
    'description',
  ]);
  final output = _preview(tool.output);
  final metadata = <String, dynamic>{
    'name': tool.name,
    'toolUseId': tool.toolCallId,
    'status': _toolStatus(tool.status),
  };
  if (detail != null) metadata['detail'] = detail;
  if (output != null) metadata['outputPreview'] = output;
  if (tool.agentId != null) metadata['agentId'] = tool.agentId;
  for (final key in const [
    'description',
    'readTarget',
    'grepTarget',
    'fileChange',
    'webSearch',
    'imageView',
    'imageDisplay',
    'htmlHost',
    'mcpDiscovery',
    'sendMessage',
    'nonExecutionKind',
    'bashApproval',
    'clarification',
    'planApproval',
  ]) {
    final value = values[key];
    if (value != null) metadata[key] = _normalizeMetadataValue(value);
  }
  final readTarget = _readTargetMetadata(tool.name, values);
  if (readTarget != null) metadata['readTarget'] = readTarget;
  final pattern = _firstText(values, const ['pattern', 'query']);
  if (_isSearchTool(tool.name) && pattern != null) {
    metadata['grepTarget'] = {'pattern': pattern};
  }
  final fileChange = resolveFileChangeFromToolInput(tool.name, values);
  if (fileChange != null) metadata['fileChange'] = _fileChangeJson(fileChange);
  if (_isWebTool(tool.name)) {
    metadata['webSearch'] = {
      if (values['query'] is String) 'query': values['query'],
      if (values['url'] is String) 'url': values['url'],
      if (values['pattern'] is String) 'pattern': values['pattern'],
      if (values['actionType'] is String) 'actionType': values['actionType'],
      if (values['mode'] is String) 'mode': values['mode'],
      if (values['queries'] is List) 'queries': values['queries'],
    };
  }
  return metadata;
}

/// Legacy display detail stored in a V2 tool row's `output`.
String? _toolOutputDetail(dynamic value) {
  if (value is String) {
    final text = value.trim();
    return text.isEmpty ? null : text;
  }
  final map = _mapValue(value);
  if (map == null) return null;
  return _firstText(map, const ['detail', 'displayDetail', 'summary']);
}

Map<String, dynamic> _fileChangeJson(ThreadRunFileChangeMetadata value) => {
  'path': value.path,
  'additions': value.additions,
  'deletions': value.deletions,
  'previewLines': [
    for (final line in value.previewLines)
      {
        'kind': switch (line.kind) {
          FileChangePreviewLineKind.add => 'add',
          FileChangePreviewLineKind.remove => 'remove',
          FileChangePreviewLineKind.context => 'context',
        },
        'text': line.text,
      },
  ],
};

Map<String, dynamic>? _mapValue(dynamic value) {
  if (value is! Map) return null;
  return value.map((key, value) => MapEntry(key.toString(), value));
}

/// Mirrors the desktop `resolveReadTargetFromToolInput`: the V2 tool summary is
/// the mobile feed's only source, so the offset/limit that produce the
/// `L12-40` suffix must be derived here instead of being dropped.
Map<String, dynamic>? _readTargetMetadata(
  String toolName,
  Map<String, dynamic> values,
) {
  final structured = _mapValue(values['readTarget']);
  if (structured != null) {
    final filePath = _firstText(structured, const [
      'filePath',
      'file_path',
      'path',
    ]);
    if (filePath != null) {
      return {
        'filePath': filePath,
        if (structured['offset'] is num) 'offset': structured['offset'],
        if (structured['limit'] is num) 'limit': structured['limit'],
      };
    }
  }
  if (!isReadToolName(toolName)) return null;
  final filePath = _firstText(values, const [
    'file_path',
    'filePath',
    'path',
    'notebook_path',
    'notebookPath',
  ]);
  if (filePath == null) return null;
  return {
    'filePath': filePath,
    if (values['offset'] is num) 'offset': values['offset'],
    if (values['limit'] is num) 'limit': values['limit'],
  };
}

dynamic _normalizeMetadataValue(dynamic value) {
  if (value is Map) {
    return value.map(
      (key, nested) =>
          MapEntry(key.toString(), _normalizeMetadataValue(nested)),
    );
  }
  if (value is List) {
    return value.map(_normalizeMetadataValue).toList(growable: false);
  }
  return value;
}

String? _firstText(Map<String, dynamic> values, List<String> keys) {
  for (final key in keys) {
    final value = values[key];
    if (value is String && value.trim().isNotEmpty) return value.trim();
  }
  return null;
}

String? _preview(dynamic value) {
  if (value == null) return null;
  final text = value is String ? value : _encode(value);
  final trimmed = text.trim();
  if (trimmed.isEmpty) return null;
  return trimmed.length <= 4000 ? trimmed : '${trimmed.substring(0, 4000)}…';
}

String _encode(dynamic value) {
  try {
    return jsonEncode(value);
  } on Object {
    return value.toString();
  }
}

int _compareMessages(ConversationV2Message left, ConversationV2Message right) {
  final time = _compareRowTime(left.occurredAt, right.occurredAt);
  if (time != 0) return time;
  final sequence = left.createdSeq.compareTo(right.createdSeq);
  return sequence != 0 ? sequence : left.messageId.compareTo(right.messageId);
}

/// Orders two rows by when they happened; rows without a recorded time keep their
/// sequence order (absent, not invented: an old row must not be given a made-up clock).
int _compareRowTime(String? left, String? right) {
  if (left == null || right == null) return 0;
  return left.compareTo(right);
}

/// The row's own time when the event recorded one, otherwise the sequence-derived value
/// that older rows were written with.
String _v2RowTime(String? occurredAt, int sequence) {
  final trimmed = occurredAt?.trim();
  if (trimmed != null && trimmed.isNotEmpty) return trimmed;
  return _v2Timestamp(sequence);
}

int _compareTimelineItems(
  ThreadRunProjectionTimelineItem left,
  ThreadRunProjectionTimelineItem right,
) {
  final time = _compareRowTime(left.at, right.at);
  if (time != 0) return time;
  final sequence = left.sequence.compareTo(right.sequence);
  return sequence != 0 ? sequence : left.id.compareTo(right.id);
}

String _v2Timestamp(int sequence) {
  final safe = sequence < 0 ? 0 : sequence;
  return DateTime.utc(1970).add(Duration(microseconds: safe)).toIso8601String();
}

String _messageEventType(
  ConversationV2MessageStatus status, {
  bool thinking = false,
}) {
  final prefix = thinking ? 'thinking' : 'message';
  return status == ConversationV2MessageStatus.streaming
      ? '$prefix.delta'
      : '$prefix.final';
}

/// Joins the two clocks a mobile session receives.
///
/// The Feed renders from the V2 event stream while the running status arrives on
/// the legacy `thread.*` channel; both are applied independently and either can
/// land first. Leaving the running state early makes the composer switch back to
/// send while the Feed is still printing, so the session only leaves it once the
/// lifecycle reports a terminal status *and* V2 has no active run — the run's
/// `run.completed` is emitted after the final message in the same ordered
/// stream.
bool resolveSessionRunning({
  required bool lifecycleRunning,
  required bool v2StreamTrusted,
  required List<ConversationV2Run> runs,
}) {
  if (lifecycleRunning) return true;
  if (!v2StreamTrusted) return false;
  return hasActiveConversationV2Run(runs);
}

/// True while the newest V2 run has not reached a terminal status.
///
/// This is the V2 half of the session running state: the V2 event stream is the
/// only channel that carries both the run lifecycle *and* the streamed answer,
/// so an active run means the Feed still has content in flight. An empty run
/// list means V2 has no run coverage for this conversation (legacy threads or a
/// turn that has not started yet), not that the session is idle.
bool hasActiveConversationV2Run(List<ConversationV2Run> runs) {
  if (runs.isEmpty) return false;
  final newest = runs.reduce(
    (left, right) => left.versionSeq >= right.versionSeq ? left : right,
  );
  // Only an explicitly non-terminal run keeps the session running; an
  // unreadable status must never be able to lock the composer.
  return newest.status == 'running' || newest.status == 'queued';
}

String _projectionAttemptStatus(String status) => switch (status) {
  'queued' || 'running' => 'running',
  'completed' => 'completed',
  'failed' => 'failed',
  // A cancelled or interrupted run did not fail: it was stopped. The distinction is the
  // run's own fact and the Feed words the turn's ending from it (desktop
  // `conversationV2RunStatusToAttemptStatus`).
  'cancelled' || 'interrupted' || 'unknown' => 'cancelled',
  _ => 'running',
};

String _projectionThreadStatus(List<ConversationV2Run> runs) {
  if (runs.any((run) => _projectionAttemptStatus(run.status) == 'running')) {
    return 'running';
  }
  if (runs.any((run) => run.status == 'failed')) return 'failed';
  return 'completed';
}

String _toolStatus(String status) => switch (status) {
  'started' || 'queued' || 'running' => 'running',
  'failed' || 'cancelled' => 'failed',
  _ => 'completed',
};

bool _isSearchTool(String name) =>
    name == 'Grep' || name == 'Search' || name == 'Find' || name == 'Glob';

bool _isWebTool(String name) =>
    name == 'WebSearch' || name == 'WebFetch' || isEcoWebSearchToolName(name);
