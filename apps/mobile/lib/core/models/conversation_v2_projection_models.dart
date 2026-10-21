import '../utils/agent_role.dart';

class ThreadSubagentSessionTiming {
  const ThreadSubagentSessionTiming({
    required this.agentId,
    required this.role,
    this.phase,
    required this.status,
    required this.startedAt,
    required this.lastActiveAt,
    required this.accumulatedMs,
    required this.durationMs,
    this.endedAt,
  });

  factory ThreadSubagentSessionTiming.fromJson(Map<String, dynamic> json) =>
      ThreadSubagentSessionTiming(
        agentId: json['agentId'] as String? ?? '',
        role: json['role'] as String? ?? '',
        phase: json['phase'] as String?,
        status: json['status'] as String? ?? 'stopped',
        startedAt: json['startedAt'] as String? ?? '',
        lastActiveAt: json['lastActiveAt'] as String? ?? '',
        endedAt: json['endedAt'] as String?,
        accumulatedMs: (json['accumulatedMs'] as num?)?.toInt() ?? 0,
        durationMs: (json['durationMs'] as num?)?.toInt() ?? 0,
      );

  final String agentId;
  final String role;
  final String? phase;
  final String status;
  final String startedAt;
  final String lastActiveAt;
  final String? endedAt;
  final int accumulatedMs;
  final int durationMs;

  bool get isActive => status == 'active';
}

class ThreadRunProjectionTimelineItem {
  const ThreadRunProjectionTimelineItem({
    required this.id,
    required this.sequence,
    required this.eventType,
    required this.scope,
    required this.text,
    required this.at,
    this.summary,
    this.contentLoaded,
    this.contentAvailable,
    this.role,
    this.agentId,
    this.runAttemptId,
    this.requestId,
    this.streamKey,
    this.metadata,
  });

  factory ThreadRunProjectionTimelineItem.fromJson(
    Map<String, dynamic> json, {
    bool includeToolOutputPreview = true,
  }) => ThreadRunProjectionTimelineItem(
    id: json['id'] as String? ?? '',
    sequence: (json['sequence'] as num?)?.toInt() ?? 0,
    eventType: json['eventType'] as String? ?? '',
    scope: json['scope'] as String? ?? '',
    text: json['text'] as String? ?? '',
    at: json['at'] as String? ?? '',
    summary: json['summary'] as String?,
    contentLoaded: json['contentLoaded'] as bool?,
    contentAvailable: json['contentAvailable'] as bool?,
    role: json['role'] == null
        ? null
        : normalizeAgentRole(json['role'] as String),
    agentId: json['agentId'] as String?,
    runAttemptId: json['runAttemptId'] as String?,
    requestId: json['requestId'] as String?,
    streamKey: json['streamKey'] as String?,
    metadata: _threadRunProjectionMetadataFromJson(
      json['metadata'],
      includeToolOutputPreview: includeToolOutputPreview,
    ),
  );

  final String id;
  final int sequence;
  final String eventType;
  final String scope;
  final String text;
  final String at;
  final String? summary;
  final bool? contentLoaded;
  final bool? contentAvailable;
  final String? role;
  final String? agentId;
  final String? runAttemptId;
  final String? requestId;
  final String? streamKey;
  final Map<String, dynamic>? metadata;
}

class ThreadRunProjectionAgent {
  const ThreadRunProjectionAgent({
    required this.agentId,
    required this.role,
    required this.kind,
    required this.status,
    required this.startedAt,
    required this.durationMs,
    required this.timeline,
    this.delegationSummary,
    this.delegationPrompt,
    this.mission,
    this.taskName,
    this.todoId,
    this.nickname,
    this.parentAgentId,
    this.parentToolUseId,
    this.latestActivity,
    this.endedAt,
    this.runAttemptId,
  });

  factory ThreadRunProjectionAgent.fromJson(
    Map<String, dynamic> json, {
    bool includeToolOutputPreview = true,
  }) {
    final timelineRaw = json['timeline'] as List<dynamic>? ?? const [];
    return ThreadRunProjectionAgent(
      agentId: json['agentId'] as String? ?? '',
      role: normalizeAgentRole(json['role'] as String? ?? ''),
      kind: normalizeAgentRole(json['kind'] as String? ?? 'subagent'),
      status: json['status'] as String? ?? 'stopped',
      startedAt: json['startedAt'] as String? ?? '',
      durationMs: (json['durationMs'] as num?)?.toInt() ?? 0,
      delegationSummary: json['delegationSummary'] as String?,
      delegationPrompt: json['delegationPrompt'] as String?,
      mission: json['mission'] as String?,
      taskName: json['taskName'] as String?,
      todoId: json['todoId'] as String?,
      nickname: json['nickname'] as String?,
      parentAgentId: json['parentAgentId'] as String?,
      parentToolUseId: json['parentToolUseId'] as String?,
      latestActivity: json['latestActivity'] as String?,
      endedAt: json['endedAt'] as String?,
      runAttemptId: json['runAttemptId'] as String?,
      timeline: timelineRaw
          .map(
            (entry) => ThreadRunProjectionTimelineItem.fromJson(
              entry as Map<String, dynamic>,
              includeToolOutputPreview: includeToolOutputPreview,
            ),
          )
          .toList(),
    );
  }

  final String agentId;
  final String role;
  final String kind;
  final String status;
  final String startedAt;
  final int durationMs;
  final String? delegationSummary;
  final String? delegationPrompt;
  final String? mission;
  final String? taskName;
  final String? todoId;
  final String? nickname;
  final String? parentAgentId;
  final String? parentToolUseId;
  final String? latestActivity;
  final String? endedAt;
  final String? runAttemptId;
  final List<ThreadRunProjectionTimelineItem> timeline;

  bool get isRunning => status == 'active' || status == 'launching';
}

class ThreadRunProjectionAttempt {
  const ThreadRunProjectionAttempt({
    required this.attemptId,
    required this.phase,
    required this.retryIndex,
    required this.status,
    required this.startedAt,
    this.endedAt,
  });

  factory ThreadRunProjectionAttempt.fromJson(Map<String, dynamic> json) =>
      ThreadRunProjectionAttempt(
        attemptId: json['attemptId'] as String? ?? '',
        phase: json['phase'] as String? ?? '',
        retryIndex: (json['retryIndex'] as num?)?.toInt() ?? 0,
        status: json['status'] as String? ?? 'running',
        startedAt: json['startedAt'] as String? ?? '',
        endedAt: json['endedAt'] as String?,
      );

  final String attemptId;
  final String phase;
  final int retryIndex;
  final String status;
  final String startedAt;
  final String? endedAt;

  bool get isRunning => status == 'running';
}

class ThreadRunProjectionWritingTool {
  const ThreadRunProjectionWritingTool({
    required this.since,
    this.name,
    this.kind,
    this.target,
  });

  factory ThreadRunProjectionWritingTool.fromJson(Map<String, dynamic> json) =>
      ThreadRunProjectionWritingTool(
        since: json['since'] as String,
        name: json['name'] as String?,
        kind: json['kind'] as String?,
        target: json['target'] as String?,
      );

  final String since;
  final String? name;
  final String? kind;
  final String? target;
}

class ThreadRunProjectionRequestSpan {
  const ThreadRunProjectionRequestSpan({
    required this.requestId,
    required this.status,
    required this.startedAt,
    this.ownerAgentId,
    this.role,
    this.firstTokenAt,
    this.endedAt,
    this.writingTool,
    this.pendingThinkingSince,
    this.pendingThinkingMessageId,
  });

  factory ThreadRunProjectionRequestSpan.fromJson(Map<String, dynamic> json) =>
      ThreadRunProjectionRequestSpan(
        requestId: json['requestId'] as String? ?? '',
        status: json['status'] as String? ?? '',
        startedAt: json['startedAt'] as String? ?? '',
        ownerAgentId: json['ownerAgentId'] as String?,
        role: json['role'] == null
            ? null
            : normalizeAgentRole(json['role'] as String),
        firstTokenAt: json['firstTokenAt'] as String?,
        endedAt: json['endedAt'] as String?,
        writingTool: json['writingTool'] == null
            ? null
            : ThreadRunProjectionWritingTool.fromJson(
                Map<String, dynamic>.from(json['writingTool'] as Map),
              ),
        pendingThinkingSince: json['pendingThinkingSince'] as String?,
        pendingThinkingMessageId: json['pendingThinkingMessageId'] as String?,
      );

  final String requestId;
  final String status;
  final String startedAt;
  final String? ownerAgentId;
  final String? role;
  final String? firstTokenAt;
  final String? endedAt;
  final ThreadRunProjectionWritingTool? writingTool;
  final String? pendingThinkingSince;
  final String? pendingThinkingMessageId;
}

class ThreadRunProjectionSnapshot {
  const ThreadRunProjectionSnapshot({
    required this.threadId,
    required this.status,
    required this.generatedAt,
    required this.agents,
    required this.sourceEventCount,
    this.timeline = const [],
    this.requestSpans = const [],
    this.attempts = const [],
    this.historyRevision = 0,
    this.hasEarlier = false,
  });

  factory ThreadRunProjectionSnapshot.fromJson(
    Map<String, dynamic> json, {
    bool includeToolOutputPreview = true,
  }) {
    final thread = json['thread'] as Map<String, dynamic>? ?? const {};
    final agentsRaw = json['agents'] as List<dynamic>? ?? const [];
    final timelineRaw = json['timeline'] as List<dynamic>? ?? const [];
    final requestSpansRaw = json['requestSpans'] as List<dynamic>? ?? const [];
    final attemptsRaw = json['attempts'] as List<dynamic>? ?? const [];
    return ThreadRunProjectionSnapshot(
      threadId: thread['threadId'] as String? ?? '',
      status: thread['status'] as String? ?? '',
      generatedAt: thread['generatedAt'] as String? ?? '',
      sourceEventCount: (json['sourceEventCount'] as num?)?.toInt() ?? 0,
      historyRevision: (json['historyRevision'] as num?)?.toInt() ?? 0,
      hasEarlier: json['hasEarlier'] == true,
      agents: agentsRaw
          .map(
            (entry) => ThreadRunProjectionAgent.fromJson(
              entry as Map<String, dynamic>,
              includeToolOutputPreview: includeToolOutputPreview,
            ),
          )
          .toList(),
      timeline: timelineRaw
          .map(
            (entry) => ThreadRunProjectionTimelineItem.fromJson(
              entry as Map<String, dynamic>,
              includeToolOutputPreview: includeToolOutputPreview,
            ),
          )
          .toList(),
      requestSpans: requestSpansRaw
          .map(
            (entry) => ThreadRunProjectionRequestSpan.fromJson(
              entry as Map<String, dynamic>,
            ),
          )
          .toList(),
      attempts: attemptsRaw
          .map(
            (entry) => ThreadRunProjectionAttempt.fromJson(
              entry as Map<String, dynamic>,
            ),
          )
          .toList(),
    );
  }

  final String threadId;
  final String status;
  final String generatedAt;
  final int sourceEventCount;
  final int historyRevision;
  final bool hasEarlier;
  final List<ThreadRunProjectionAgent> agents;
  final List<ThreadRunProjectionTimelineItem> timeline;
  final List<ThreadRunProjectionRequestSpan> requestSpans;
  final List<ThreadRunProjectionAttempt> attempts;

  bool get hasData => sourceEventCount > 0;
}

Map<String, dynamic>? _threadRunProjectionMetadataFromJson(
  dynamic value, {
  required bool includeToolOutputPreview,
}) {
  if (value is! Map<String, dynamic>) return null;
  if (includeToolOutputPreview) return value;
  final rawTool = value['tool'];
  if (rawTool is! Map<String, dynamic>) return value;
  final tool = <String, dynamic>{...rawTool}
    ..remove('output')
    ..remove('outputPreview')
    ..remove('outputTruncated')
    ..remove('outputPreviewTruncated')
    ..remove('outputOriginalChars')
    ..remove('outputKeptChars');
  return <String, dynamic>{...value, 'tool': tool};
}

ThreadRunProjectionSnapshot mergeThreadRunProjectionSnapshots(
  ThreadRunProjectionSnapshot? current,
  ThreadRunProjectionSnapshot incoming,
) {
  if (current == null) return incoming;
  if (current.historyRevision != incoming.historyRevision) {
    return incoming.generatedAt.compareTo(current.generatedAt) >= 0
        ? incoming
        : current;
  }
  final useIncomingHeader =
      incoming.generatedAt.compareTo(current.generatedAt) >= 0;
  return ThreadRunProjectionSnapshot(
    threadId: useIncomingHeader ? incoming.threadId : current.threadId,
    status: useIncomingHeader ? incoming.status : current.status,
    generatedAt: useIncomingHeader ? incoming.generatedAt : current.generatedAt,
    sourceEventCount: incoming.sourceEventCount > current.sourceEventCount
        ? incoming.sourceEventCount
        : current.sourceEventCount,
    historyRevision: incoming.historyRevision,
    hasEarlier: _mergedProjectionHasEarlier(current, incoming),
    timeline: _mergeProjectionTimeline(current.timeline, incoming.timeline),
    agents: _mergeProjectionAgents(current.agents, incoming.agents),
    requestSpans: _mergeProjectionRequestSpans(
      current.requestSpans,
      incoming.requestSpans,
    ),
    attempts: _mergeProjectionAttempts(current.attempts, incoming.attempts),
  );
}

bool _mergedProjectionHasEarlier(
  ThreadRunProjectionSnapshot current,
  ThreadRunProjectionSnapshot incoming,
) {
  final currentFirst = current.timeline.isEmpty
      ? null
      : current.timeline.first.sequence;
  final incomingFirst = incoming.timeline.isEmpty
      ? null
      : incoming.timeline.first.sequence;
  if (currentFirst == null) return incoming.hasEarlier;
  if (incomingFirst == null) return current.hasEarlier;
  if (currentFirst < incomingFirst) return current.hasEarlier;
  if (incomingFirst < currentFirst) return incoming.hasEarlier;
  return incoming.hasEarlier || current.hasEarlier;
}

List<ThreadRunProjectionAttempt> _mergeProjectionAttempts(
  List<ThreadRunProjectionAttempt> current,
  List<ThreadRunProjectionAttempt> incoming,
) {
  final byId = <String, ThreadRunProjectionAttempt>{
    for (final attempt in current) attempt.attemptId: attempt,
    for (final attempt in incoming) attempt.attemptId: attempt,
  };
  final merged = byId.values.toList();
  merged.sort((left, right) => left.startedAt.compareTo(right.startedAt));
  return merged;
}

ThreadRunProjectionSnapshot mergeThreadRunProjectionDetailResult(
  ThreadRunProjectionSnapshot? current,
  ThreadRunProjectionDetailResult detail,
) {
  final agents = <ThreadRunProjectionAgent>[];
  final mainTimeline = <ThreadRunProjectionTimelineItem>[];

  if (detail.kind == 'agent') {
    final baseAgent =
        detail.agent ?? _findProjectionAgent(current?.agents, detail.key);
    if (baseAgent != null || detail.timeline.isNotEmpty) {
      agents.add(
        _copyProjectionAgentWithTimeline(
          baseAgent ??
              _projectionAgentFromTimeline(detail.key, detail.timeline),
          detail.timeline,
        ),
      );
    }
  } else if (detail.kind == 'main') {
    mainTimeline.addAll(detail.timeline);
  } else if (detail.kind == 'turn') {
    mainTimeline.addAll(detail.timeline.where((item) => item.scope != 'agent'));
    final byAgentId = <String, List<ThreadRunProjectionTimelineItem>>{};
    for (final item in detail.timeline) {
      final agentId = item.agentId?.trim();
      if (item.scope == 'agent' && agentId != null && agentId.isNotEmpty) {
        byAgentId.putIfAbsent(agentId, () => []).add(item);
      }
    }
    for (final entry in byAgentId.entries) {
      final baseAgent = _findProjectionAgent(current?.agents, entry.key);
      agents.add(
        _copyProjectionAgentWithTimeline(
          baseAgent ?? _projectionAgentFromTimeline(entry.key, entry.value),
          entry.value,
        ),
      );
    }
  } else if (detail.kind == 'tool') {
    final byAgentId = <String, List<ThreadRunProjectionTimelineItem>>{};
    for (final item in detail.timeline) {
      final agentId = item.agentId?.trim();
      if (item.scope == 'agent' && agentId != null && agentId.isNotEmpty) {
        byAgentId.putIfAbsent(agentId, () => []).add(item);
      } else {
        mainTimeline.add(item);
      }
    }
    for (final entry in byAgentId.entries) {
      final baseAgent = _findProjectionAgent(current?.agents, entry.key);
      agents.add(
        _copyProjectionAgentWithTimeline(
          baseAgent ?? _projectionAgentFromTimeline(entry.key, entry.value),
          entry.value,
        ),
      );
    }
  }

  final incoming = ThreadRunProjectionSnapshot(
    threadId: detail.threadId,
    status: current?.status ?? '',
    generatedAt: detail.generatedAt,
    sourceEventCount: detail.sourceEventCount,
    historyRevision: current?.historyRevision ?? 0,
    hasEarlier: detail.kind == 'main'
        ? detail.hasEarlier
        : (current?.hasEarlier ?? false),
    timeline: mainTimeline,
    agents: agents,
    requestSpans: current?.requestSpans ?? const [],
    attempts: current?.attempts ?? const [],
  );
  final merged = mergeThreadRunProjectionSnapshots(current, incoming);
  if (detail.kind != 'main' || merged.hasEarlier == detail.hasEarlier) {
    return merged;
  }
  return ThreadRunProjectionSnapshot(
    threadId: merged.threadId,
    status: merged.status,
    generatedAt: merged.generatedAt,
    sourceEventCount: merged.sourceEventCount,
    historyRevision: merged.historyRevision,
    hasEarlier: detail.hasEarlier,
    timeline: merged.timeline,
    agents: merged.agents,
    requestSpans: merged.requestSpans,
    attempts: merged.attempts,
  );
}

List<ThreadRunProjectionTimelineItem> _mergeProjectionTimeline(
  List<ThreadRunProjectionTimelineItem> current,
  List<ThreadRunProjectionTimelineItem> incoming,
) {
  final byId = <String, ThreadRunProjectionTimelineItem>{
    for (final item in current) item.id: item,
  };
  for (final item in incoming) {
    final existing = byId[item.id];
    byId[item.id] = existing == null
        ? item
        : _mergeProjectionTimelineItem(existing, item);
  }
  final merged = byId.values.toList();
  merged.sort(_compareProjectionTimelineItems);
  return merged;
}

ThreadRunProjectionTimelineItem _mergeProjectionTimelineItem(
  ThreadRunProjectionTimelineItem current,
  ThreadRunProjectionTimelineItem incoming,
) {
  final metadata = _mergeProjectionTimelineMetadata(
    current.metadata,
    incoming.metadata,
  );
  final text = _shouldKeepCurrentProjectionText(current, incoming)
      ? current.text
      : incoming.text;
  if (!_isStreamProjectionItem(current) || !_isStreamProjectionItem(incoming)) {
    if (identical(metadata, incoming.metadata) &&
        text == incoming.text &&
        (incoming.runAttemptId != null || current.runAttemptId == null)) {
      return incoming;
    }
    return ThreadRunProjectionTimelineItem(
      id: incoming.id,
      sequence: incoming.sequence,
      eventType: incoming.eventType,
      scope: incoming.scope,
      text: text,
      summary: incoming.summary ?? current.summary,
      contentLoaded: incoming.contentLoaded ?? current.contentLoaded,
      contentAvailable: incoming.contentAvailable ?? current.contentAvailable,
      at: incoming.at,
      role: incoming.role,
      agentId: incoming.agentId,
      runAttemptId: incoming.runAttemptId ?? current.runAttemptId,
      requestId: incoming.requestId,
      streamKey: incoming.streamKey,
      metadata: metadata,
    );
  }
  if (text == incoming.text &&
      identical(metadata, incoming.metadata) &&
      (incoming.runAttemptId != null || current.runAttemptId == null)) {
    return incoming;
  }
  return ThreadRunProjectionTimelineItem(
    id: incoming.id,
    sequence: incoming.sequence,
    eventType: incoming.eventType,
    scope: incoming.scope,
    text: text,
    summary: incoming.summary ?? current.summary,
    contentLoaded: incoming.contentLoaded ?? current.contentLoaded,
    contentAvailable: incoming.contentAvailable ?? current.contentAvailable,
    at: incoming.at,
    role: incoming.role,
    agentId: incoming.agentId,
    runAttemptId: incoming.runAttemptId ?? current.runAttemptId,
    requestId: incoming.requestId,
    streamKey: incoming.streamKey,
    metadata: metadata,
  );
}

bool _shouldKeepCurrentProjectionText(
  ThreadRunProjectionTimelineItem current,
  ThreadRunProjectionTimelineItem incoming,
) {
  if (incoming.text.length >= current.text.length) {
    return false;
  }
  if (_isStreamProjectionItem(current) && _isStreamProjectionItem(incoming)) {
    return true;
  }
  return incoming.metadata?['textTruncated'] == true;
}

Map<String, dynamic>? _mergeProjectionTimelineMetadata(
  Map<String, dynamic>? current,
  Map<String, dynamic>? incoming,
) {
  if (current == null || current.isEmpty) return incoming;
  if (incoming == null || incoming.isEmpty) return current;
  final merged = <String, dynamic>{...current, ...incoming};
  final currentTool = current['tool'];
  final incomingTool = incoming['tool'];
  if (currentTool is Map<String, dynamic> &&
      incomingTool is Map<String, dynamic>) {
    merged['tool'] = <String, dynamic>{...currentTool, ...incomingTool};
  }
  return merged;
}

bool _isStreamProjectionItem(ThreadRunProjectionTimelineItem item) {
  return item.eventType == 'thinking.delta' ||
      item.eventType == 'thinking.final' ||
      item.eventType == 'message.delta' ||
      item.eventType == 'message.final';
}

List<ThreadRunProjectionAgent> _mergeProjectionAgents(
  List<ThreadRunProjectionAgent> current,
  List<ThreadRunProjectionAgent> incoming,
) {
  final byId = <String, ThreadRunProjectionAgent>{
    for (final agent in current) agent.agentId: agent,
  };
  for (final agent in incoming) {
    final existing = byId[agent.agentId];
    byId[agent.agentId] = existing == null
        ? agent
        : _mergeProjectionAgent(existing, agent);
  }
  final merged = byId.values.toList();
  merged.sort(
    (left, right) => left.startedAt.compareTo(right.startedAt) == 0
        ? left.agentId.compareTo(right.agentId)
        : left.startedAt.compareTo(right.startedAt),
  );
  return merged;
}

ThreadRunProjectionAgent _mergeProjectionAgent(
  ThreadRunProjectionAgent current,
  ThreadRunProjectionAgent incoming,
) {
  return ThreadRunProjectionAgent(
    agentId: incoming.agentId,
    role: incoming.role.isNotEmpty ? incoming.role : current.role,
    kind: incoming.kind.isNotEmpty ? incoming.kind : current.kind,
    status: incoming.status.isNotEmpty ? incoming.status : current.status,
    startedAt: incoming.startedAt.isNotEmpty
        ? incoming.startedAt
        : current.startedAt,
    durationMs: incoming.durationMs,
    delegationSummary: incoming.delegationSummary ?? current.delegationSummary,
    delegationPrompt: incoming.delegationPrompt ?? current.delegationPrompt,
    mission: incoming.mission ?? current.mission,
    taskName: incoming.taskName ?? current.taskName,
    todoId: incoming.todoId ?? current.todoId,
    nickname: incoming.nickname ?? current.nickname,
    parentAgentId: incoming.parentAgentId ?? current.parentAgentId,
    parentToolUseId: incoming.parentToolUseId ?? current.parentToolUseId,
    latestActivity: incoming.latestActivity ?? current.latestActivity,
    endedAt: incoming.endedAt ?? current.endedAt,
    runAttemptId: incoming.runAttemptId ?? current.runAttemptId,
    timeline: incoming.timeline.isEmpty
        ? current.timeline
        : _mergeProjectionTimeline(current.timeline, incoming.timeline),
  );
}

ThreadRunProjectionAgent? _findProjectionAgent(
  List<ThreadRunProjectionAgent>? agents,
  String agentId,
) {
  if (agents == null) return null;
  for (final agent in agents) {
    if (agent.agentId == agentId) return agent;
  }
  return null;
}

ThreadRunProjectionAgent _copyProjectionAgentWithTimeline(
  ThreadRunProjectionAgent agent,
  List<ThreadRunProjectionTimelineItem> timeline,
) {
  return ThreadRunProjectionAgent(
    agentId: agent.agentId,
    role: agent.role,
    kind: agent.kind,
    status: agent.status,
    startedAt: agent.startedAt,
    durationMs: agent.durationMs,
    delegationSummary: agent.delegationSummary,
    delegationPrompt: agent.delegationPrompt,
    mission: agent.mission,
    taskName: agent.taskName,
    todoId: agent.todoId,
    nickname: agent.nickname,
    parentAgentId: agent.parentAgentId,
    parentToolUseId: agent.parentToolUseId,
    latestActivity: agent.latestActivity,
    endedAt: agent.endedAt,
    runAttemptId: agent.runAttemptId,
    timeline: timeline,
  );
}

ThreadRunProjectionAgent _projectionAgentFromTimeline(
  String agentId,
  List<ThreadRunProjectionTimelineItem> timeline,
) {
  final first = timeline.isNotEmpty ? timeline.first : null;
  return ThreadRunProjectionAgent(
    agentId: agentId,
    role: first?.role ?? '',
    kind: 'subagent',
    status: 'stopped',
    startedAt: first?.at ?? '',
    durationMs: 0,
    runAttemptId: first?.runAttemptId,
    timeline: timeline,
  );
}

List<ThreadRunProjectionRequestSpan> _mergeProjectionRequestSpans(
  List<ThreadRunProjectionRequestSpan> current,
  List<ThreadRunProjectionRequestSpan> incoming,
) {
  final byId = <String, ThreadRunProjectionRequestSpan>{
    for (final span in current) span.requestId: span,
  };
  for (final span in incoming) {
    byId[span.requestId] = span;
  }
  final merged = byId.values.toList();
  merged.sort(
    (left, right) => left.startedAt.compareTo(right.startedAt) == 0
        ? left.requestId.compareTo(right.requestId)
        : left.startedAt.compareTo(right.startedAt),
  );
  return merged;
}

int _compareProjectionTimelineItems(
  ThreadRunProjectionTimelineItem left,
  ThreadRunProjectionTimelineItem right,
) {
  final sequenceDelta = left.sequence.compareTo(right.sequence);
  if (sequenceDelta != 0) return sequenceDelta;
  final atDelta = left.at.compareTo(right.at);
  if (atDelta != 0) return atDelta;
  return left.id.compareTo(right.id);
}

class ThreadRunProjectionDetailResult {
  const ThreadRunProjectionDetailResult({
    required this.threadId,
    required this.kind,
    required this.key,
    required this.generatedAt,
    required this.timeline,
    required this.sourceEventCount,
    required this.hasMore,
    this.hasEarlier = false,
    this.nextAfterSequence,
    this.previousBeforeSequence,
    this.agent,
  });

  factory ThreadRunProjectionDetailResult.fromJson(
    Map<String, dynamic> json, {
    bool includeToolOutputPreview = true,
  }) {
    final timelineRaw = json['timeline'] as List<dynamic>? ?? const [];
    final agentRaw = json['agent'];
    return ThreadRunProjectionDetailResult(
      threadId: json['threadId'] as String? ?? '',
      kind: json['kind'] as String? ?? '',
      key: json['key'] as String? ?? '',
      generatedAt: json['generatedAt'] as String? ?? '',
      sourceEventCount: (json['sourceEventCount'] as num?)?.toInt() ?? 0,
      hasMore: json['hasMore'] == true,
      hasEarlier: json['hasEarlier'] == true,
      nextAfterSequence: (json['nextAfterSequence'] as num?)?.toInt(),
      previousBeforeSequence: (json['previousBeforeSequence'] as num?)?.toInt(),
      agent: agentRaw is Map<String, dynamic>
          ? ThreadRunProjectionAgent.fromJson(
              agentRaw,
              includeToolOutputPreview: includeToolOutputPreview,
            )
          : null,
      timeline: timelineRaw
          .map(
            (entry) => ThreadRunProjectionTimelineItem.fromJson(
              entry as Map<String, dynamic>,
              includeToolOutputPreview: includeToolOutputPreview,
            ),
          )
          .toList(),
    );
  }

  final String threadId;
  final String kind;
  final String key;
  final String generatedAt;
  final int sourceEventCount;
  final bool hasMore;
  final bool hasEarlier;
  final int? nextAfterSequence;
  final int? previousBeforeSequence;
  final ThreadRunProjectionAgent? agent;
  final List<ThreadRunProjectionTimelineItem> timeline;
}
