import '../models/conversation_v2_projection_models.dart';

/// OpenAI/Codex reasoning summary stamp (`summary` | `raw`).
String? readReasoningDisplay(Map<String, dynamic>? metadata) {
  final value = metadata?['reasoningDisplay'];
  return value == 'summary' || value == 'raw' ? value as String : null;
}

bool isEmptyTerminalThinkingItem(ThreadRunProjectionTimelineItem item) {
  return item.eventType == 'thinking.final' && item.text.trim().isEmpty;
}

bool hasReasoningSummaryStamp(ThreadRunProjectionTimelineItem item) {
  if (item.eventType != 'thinking.delta' &&
      item.eventType != 'thinking.final') {
    return false;
  }
  if (readReasoningDisplay(item.metadata) == 'summary') {
    return true;
  }
  return item.metadata?['codexMethod'] == 'item/reasoning/summaryTextDelta';
}

/// OpenAI/Codex reasoning summary (not Claude raw thinking / raw CoT).
bool isReasoningSummaryItem(ThreadRunProjectionTimelineItem item) {
  if (item.text.trim().isEmpty) {
    return false;
  }
  return hasReasoningSummaryStamp(item);
}

/// Events that replace the ephemeral reasoning-summary status line
/// (tools, assistant speech, true thinking, …).
bool isReasoningSummarySupersedingItem(ThreadRunProjectionTimelineItem item) {
  if (isReasoningSummaryItem(item) || isEmptyTerminalThinkingItem(item)) {
    return false;
  }
  if (item.eventType.startsWith('tool.')) {
    return true;
  }
  if (item.eventType == 'message.delta' || item.eventType == 'message.final') {
    return item.text.trim().isNotEmpty;
  }
  if (item.eventType == 'thinking.delta' ||
      item.eventType == 'thinking.final') {
    return item.text.trim().isNotEmpty;
  }
  if (item.eventType == 'thread.status' ||
      item.eventType == 'api.error' ||
      item.eventType == 'tool.failed') {
    return true;
  }
  return false;
}

/// Display-only fork onto the tip path: stamp raw/untagged thinking as
/// `reasoningDisplay: "summary"` so `reasoningStage` +
/// [collapseEphemeralReasoningSummaryTimeline] apply. Does not mutate
/// persisted activity.
List<ThreadRunProjectionTimelineItem> presentThinkingAsEphemeralSummaryTips(
  List<ThreadRunProjectionTimelineItem> timeline,
) {
  return [
    for (final item in timeline)
      if (item.eventType != 'thinking.delta' &&
          item.eventType != 'thinking.final')
        item
      else if (item.text.trim().isEmpty)
        item
      else if (readReasoningDisplay(item.metadata) == 'summary')
        item
      else
        ThreadRunProjectionTimelineItem(
          id: item.id,
          sequence: item.sequence,
          eventType: item.eventType,
          scope: item.scope,
          text: item.text,
          at: item.at,
          summary: item.summary,
          contentLoaded: item.contentLoaded,
          contentAvailable: item.contentAvailable,
          role: item.role,
          agentId: item.agentId,
          runAttemptId: item.runAttemptId,
          requestId: item.requestId,
          streamKey: item.streamKey,
          metadata: {
            ...(item.metadata ?? {}),
            'reasoningDisplay': 'summary',
          },
        ),
  ];
}

/// Reasoning summary is a single replaceable tip status:
/// - later summary replaces earlier ones
/// - tools / messages / raw thinking after it clear the tip
/// - may be delta or final (final still shows until superseded)
/// - once the conversation has left its live statuses the tip is gone: supersede-by-event
///   only works while the run keeps producing, and 阅后即焚 has no durable form
List<ThreadRunProjectionTimelineItem> collapseEphemeralReasoningSummaryTimeline(
  List<ThreadRunProjectionTimelineItem> timeline, {
  bool conversationLive = true,
  Set<String> terminalAttemptIds = const {},
}) {
  if (!conversationLive) {
    return [
      for (final item in timeline)
        if (!isReasoningSummaryItem(item)) item,
    ];
  }
  var lastSupersedingIndex = -1;
  for (var index = 0; index < timeline.length; index += 1) {
    if (isReasoningSummarySupersedingItem(timeline[index]) &&
        (lastSupersedingIndex < 0 ||
            _compareTimelinePosition(timeline, lastSupersedingIndex, index) <
                0)) {
      lastSupersedingIndex = index;
    }
  }
  final summaryIndexes = <int>[];
  for (var index = 0; index < timeline.length; index += 1) {
    if (!isReasoningSummaryItem(timeline[index])) continue;
    if (lastSupersedingIndex >= 0 &&
        _compareTimelinePosition(timeline, lastSupersedingIndex, index) >= 0) {
      continue;
    }
    summaryIndexes.add(index);
  }
  summaryIndexes.sort(
    (left, right) => _compareTimelinePosition(timeline, left, right),
  );
  final tipSummaryIndex = summaryIndexes.lastOrNull ?? -1;
  final slotSummaryIndex = summaryIndexes.firstOrNull;
  final slotKey = slotSummaryIndex == null
      ? null
      : _resolveReasoningSummarySlotKey(
          timeline[slotSummaryIndex],
          slotSummaryIndex > 0 ? timeline[slotSummaryIndex - 1] : null,
        );
  return [
    for (var index = 0; index < timeline.length; index += 1) ...[
      if (!isReasoningSummaryItem(timeline[index]))
        timeline[index]
      else if (index == tipSummaryIndex &&
          !terminalAttemptIds.contains(timeline[index].runAttemptId))
        _withReasoningSummarySlotKey(timeline[index], slotKey),
    ],
  ];
}

int _compareTimelinePosition(
  List<ThreadRunProjectionTimelineItem> timeline,
  int leftIndex,
  int rightIndex,
) {
  final sequenceDelta = timeline[leftIndex].sequence.compareTo(
    timeline[rightIndex].sequence,
  );
  return sequenceDelta != 0 ? sequenceDelta : leftIndex.compareTo(rightIndex);
}

String _resolveReasoningSummarySlotKey(
  ThreadRunProjectionTimelineItem item,
  ThreadRunProjectionTimelineItem? previous,
) {
  final previousSlot = previous?.metadata?['reasoningSummarySlotKey'];
  if (previousSlot is String && previousSlot.trim().isNotEmpty) {
    return previousSlot.trim();
  }
  final owner = item.agentId?.trim().isNotEmpty == true
      ? item.agentId!.trim()
      : item.requestId?.trim().isNotEmpty == true
      ? item.requestId!.trim()
      : item.runAttemptId?.trim().isNotEmpty == true
      ? item.runAttemptId!.trim()
      : null;
  final stream = item.streamKey?.trim().isNotEmpty == true
      ? item.streamKey!.trim()
      : item.id;
  return owner == null ? stream : '$owner:$stream';
}

ThreadRunProjectionTimelineItem _withReasoningSummarySlotKey(
  ThreadRunProjectionTimelineItem item,
  String? slotKey,
) {
  if (slotKey == null || slotKey.trim().isEmpty) return item;
  return ThreadRunProjectionTimelineItem(
    id: item.id,
    sequence: item.sequence,
    eventType: item.eventType,
    scope: item.scope,
    text: item.text,
    at: item.at,
    summary: item.summary,
    contentLoaded: item.contentLoaded,
    contentAvailable: item.contentAvailable,
    role: item.role,
    agentId: item.agentId,
    runAttemptId: item.runAttemptId,
    requestId: item.requestId,
    streamKey: item.streamKey,
    metadata: {
      ...(item.metadata ?? {}),
      'reasoningSummarySlotKey': slotKey.trim(),
    },
  );
}
