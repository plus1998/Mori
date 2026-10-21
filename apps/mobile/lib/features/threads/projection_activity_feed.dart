import 'dart:convert';
import 'dart:math' as math;

import '../../core/models/conversation_v2_projection_models.dart';
import '../../core/models/thread_models.dart';
import '../../core/preferences/thinking_display_preferences.dart';
import '../../core/utils/activity_display.dart';
import '../../core/utils/feed_action_kind.dart';
import '../../core/utils/file_change.dart';
import '../../core/utils/agent_mission.dart';
import '../../core/utils/reasoning_summary.dart';
import '../../core/utils/stream_text.dart';
import '../../core/utils/subagent_projection_feed.dart';
import '../../core/utils/thread_status.dart';
import '../../l10n/generated/app_localizations.dart';
import 'activity_feed.dart';

class _ProjectionFeedSlot {
  const _ProjectionFeedSlot({
    required this.entry,
    required this.at,
    required this.sequence,
    required this.sortLane,
    required this.sortKey,
  });

  final ActivityFeedEntry entry;
  final String at;
  final int sequence;
  final int sortLane;
  final String sortKey;
}

const _feedSortLaneNormal = 0;
const _feedSortLaneStreamMessage = 1;

class _ProjectionSubagentCard {
  const _ProjectionSubagentCard({
    required this.agent,
    required this.displayTimeline,
    required this.missionText,
    required this.statusText,
  });

  final ThreadRunProjectionAgent agent;
  final List<ThreadRunProjectionTimelineItem> displayTimeline;
  final String missionText;
  final String? statusText;
}

class _MutableProjectionTurn {
  _MutableProjectionTurn(
    this.attempt, {
    required this.afterUserSequence,
    this.boundaryAt,
  });

  final ThreadRunProjectionAttempt attempt;
  final int afterUserSequence;
  final String? boundaryAt;
  final entries = <ActivityFeedEntry>[];
}

class _UserPromptBoundary {
  const _UserPromptBoundary({required this.sequence, required this.at});

  final int sequence;
  final String at;
}

class _OrderedFeedSection {
  const _OrderedFeedSection({
    required this.value,
    required this.at,
    required this.sequence,
    required this.isUser,
    required this.sortKey,
  });

  final Object value;
  final String at;
  final int sequence;
  final bool isUser;
  final String sortKey;
}

const _maxTurnSortSequence = 1 << 53;

List<ActivityFeedEntry> groupProjectionActivityFeedTurns(
  List<ActivityFeedEntry> entries,
  ThreadRunProjectionSnapshot projection,
) {
  if (projection.attempts.isEmpty) return entries;
  final attempts = [...projection.attempts]
    ..sort((left, right) => left.startedAt.compareTo(right.startedAt));
  final attemptById = {
    for (final attempt in attempts) attempt.attemptId: attempt,
  };
  final userBoundaries = [
    for (final entry in entries)
      if (_isUserSideFeedEntry(entry))
        _UserPromptBoundary(sequence: entry.sequence, at: entry.at ?? ''),
  ]..sort((left, right) => left.sequence.compareTo(right.sequence));
  // Acceptance sequences remain unchanged when reordered queue rows are sent.
  // Time-based lookups need a separate index in actual delivery order.
  final userBoundariesByTime = [...userBoundaries]
    ..sort((left, right) {
      final time = left.at.compareTo(right.at);
      return time != 0 ? time : left.sequence.compareTo(right.sequence);
    });
  final v2TimelineSequences = {
    for (final item in projection.timeline)
      if (item.metadata?['v2'] == true) item.sequence,
  };
  final turnBySegmentKey = <String, _MutableProjectionTurn>{};
  final sections = <_OrderedFeedSection>[];
  final visibleTimelineAttemptIds = projection.timeline
      .map((item) => item.runAttemptId?.trim())
      .whereType<String>()
      .where((attemptId) => attemptId.isNotEmpty)
      .toSet();

  for (final entry in entries) {
    if (_isUserSideFeedEntry(entry)) {
      sections.add(
        _OrderedFeedSection(
          value: entry,
          at: entry.at ?? '',
          sequence: entry.sequence,
          isUser: true,
          sortKey: 'user:${entry.id}',
        ),
      );
      continue;
    }
    final attempt = _resolveFeedEntryAttempt(entry, attempts, attemptById);
    if (attempt == null) {
      sections.add(
        _OrderedFeedSection(
          value: entry,
          at: entry.at ?? '',
          sequence: entry.sequence,
          isUser: false,
          sortKey: 'standalone:${entry.id}',
        ),
      );
      continue;
    }
    // V2 tools, including grouped actions, share the same delivery clock as
    // V2 messages; sequence-based placement can split them from their answer.
    final useObservedAt =
        _isStreamNarrativeFeedEntry(entry) ||
        v2TimelineSequences.contains(entry.sequence) ||
        entry.actionChildren.any(
          (child) => v2TimelineSequences.contains(child.sequence),
        );
    final boundary = _lastUserBoundaryForEntry(
      useObservedAt ? userBoundariesByTime : userBoundaries,
      entry,
      useObservedAt: useObservedAt,
    );
    final afterUserSequence = boundary?.sequence ?? 0;
    final segmentKey = '${attempt.attemptId}#after:$afterUserSequence';
    final turn = turnBySegmentKey.putIfAbsent(segmentKey, () {
      return _MutableProjectionTurn(
        attempt,
        afterUserSequence: afterUserSequence,
        boundaryAt: boundary?.at,
      );
    });
    turn.entries.add(entry);
  }

  for (final attempt in attempts) {
    final rootKey = '${attempt.attemptId}#after:0';
    final hasInitialPrompt = userBoundariesByTime.any(
      (boundary) => boundary.at.compareTo(attempt.startedAt) <= 0,
    );
    if (attempt.status == 'completed' ||
        turnBySegmentKey.containsKey(rootKey) ||
        turnBySegmentKey.values.any(
          (turn) =>
              turn.attempt.attemptId == attempt.attemptId &&
              (!attempt.isRunning ||
                  !hasInitialPrompt ||
                  turn.boundaryAt == null ||
                  turn.boundaryAt!.compareTo(attempt.startedAt) <= 0),
        ) ||
        (!attempt.isRunning &&
            !visibleTimelineAttemptIds.contains(attempt.attemptId))) {
      continue;
    }
    // Preserve the original heading if the first output follows a mid-turn prompt.
    turnBySegmentKey[rootKey] = _MutableProjectionTurn(
      attempt,
      afterUserSequence: 0,
    );
  }

  for (final entry in turnBySegmentKey.entries) {
    final turn = entry.value;
    final minEntrySequence = turn.entries.isEmpty
        ? _maxTurnSortSequence
        : turn.entries
              .map((item) => item.sequence)
              .reduce((left, right) => math.min(left, right));
    final sortSequence = minEntrySequence == _maxTurnSortSequence
        ? (turn.afterUserSequence > 0
              ? turn.afterUserSequence + 1
              : _maxTurnSortSequence)
        : (turn.afterUserSequence > 0
              ? math.max(minEntrySequence, turn.afterUserSequence + 1)
              : minEntrySequence);
    sections.add(
      _OrderedFeedSection(
        value: turn,
        at: turn.boundaryAt ?? turn.attempt.startedAt,
        sequence: sortSequence,
        isUser: false,
        sortKey: entry.key,
      ),
    );
  }

  sections.sort(_compareOrderedFeedSections);

  final seenAttemptIds = <String>{};
  return sections.map((section) {
    if (section.value is ActivityFeedEntry) {
      return section.value as ActivityFeedEntry;
    }
    final turn = section.value as _MutableProjectionTurn;
    final continuation = !seenAttemptIds.add(turn.attempt.attemptId);
    return _buildTurnFeedEntry(turn, continuation: continuation);
  }).toList();
}

bool _isUserSideFeedEntry(ActivityFeedEntry entry) {
  return entry.kind == ActivityFeedKind.user ||
      entry.kind == ActivityFeedKind.clarificationAnswer;
}

int _compareOrderedFeedSections(
  _OrderedFeedSection left,
  _OrderedFeedSection right,
) {
  final atDelta = left.at.compareTo(right.at);
  if (atDelta != 0) return atDelta;
  final sequenceDelta = left.sequence.compareTo(right.sequence);
  if (sequenceDelta != 0) return sequenceDelta;
  if (left.isUser != right.isUser) {
    return left.isUser ? -1 : 1;
  }
  return left.sortKey.compareTo(right.sortKey);
}

_UserPromptBoundary? _lastUserBoundaryForEntry(
  List<_UserPromptBoundary> boundaries,
  ActivityFeedEntry entry, {
  required bool useObservedAt,
}) {
  _UserPromptBoundary? found;
  final entryAt = entry.at ?? '';
  for (final boundary in boundaries) {
    if (useObservedAt) {
      if (boundary.at.compareTo(entryAt) < 0) {
        found = boundary;
        continue;
      }
      break;
    }
    if (boundary.sequence < entry.sequence) {
      found = boundary;
      continue;
    }
    break;
  }
  return found;
}

bool _isStreamNarrativeFeedEntry(ActivityFeedEntry entry) {
  // Subagent cards on the skeleton Feed often have sequence 0 (cleared timeline).
  // Wall-clock keeps them in the same turn segment as later finals, avoiding a
  // duplicate "已处理"/stopped heading for the same attempt.
  return entry.kind == ActivityFeedKind.assistant ||
      entry.kind == ActivityFeedKind.thinking ||
      entry.kind == ActivityFeedKind.reasoningStage ||
      entry.kind == ActivityFeedKind.toolWriting ||
      entry.kind == ActivityFeedKind.subagentMission;
}

ActivityFeedEntry _buildTurnFeedEntry(
  _MutableProjectionTurn turn, {
  required bool continuation,
}) {
  final finalOutput = turn.attempt.isRunning
      ? null
      : _resolveFinalProjectionOutput(turn.entries);
  final processEntries = finalOutput == null
      ? turn.entries
      : turn.entries.where((entry) => entry.id != finalOutput.id).toList();
  final startedAt = DateTime.tryParse(turn.attempt.startedAt);
  final endedAt = DateTime.tryParse(turn.attempt.endedAt ?? '');
  final durationMs = startedAt == null
      ? 0
      : (endedAt ?? DateTime.now())
            .difference(startedAt)
            .inMilliseconds
            .clamp(0, 1 << 31);
  return ActivityFeedEntry(
    id: 'turn:${turn.attempt.attemptId}#after:${turn.afterUserSequence}',
    kind: ActivityFeedKind.turn,
    text: '',
    runAttemptId: turn.attempt.attemptId,
    running: turn.attempt.isRunning,
    continuation: continuation,
    turnStatus: turn.attempt.status,
    durationMs: durationMs,
    startedAt: turn.attempt.startedAt,
    endedAt: turn.attempt.endedAt,
    processEntries: List<ActivityFeedEntry>.unmodifiable(processEntries),
    finalOutput: finalOutput,
    sequence: turn.afterUserSequence,
  );
}

ThreadRunProjectionAttempt? _resolveFeedEntryAttempt(
  ActivityFeedEntry entry,
  List<ThreadRunProjectionAttempt> attempts,
  Map<String, ThreadRunProjectionAttempt> attemptById,
) {
  final explicitId = entry.runAttemptId?.trim();
  if (explicitId != null && explicitId.isNotEmpty) {
    final explicit = attemptById[explicitId];
    if (explicit != null) return explicit;
  }
  final at = entry.at;
  if (at == null || at.isEmpty) return null;
  ThreadRunProjectionAttempt? candidate;
  for (final attempt in attempts) {
    if (attempt.startedAt.compareTo(at) > 0) break;
    candidate = attempt;
  }
  return candidate;
}

ActivityFeedEntry? _resolveFinalProjectionOutput(
  List<ActivityFeedEntry> entries,
) {
  for (var index = entries.length - 1; index >= 0; index -= 1) {
    final entry = entries[index];
    if (entry.kind == ActivityFeedKind.assistant &&
        !entry.streaming &&
        entry.agentId == null &&
        entry.text.trim().isNotEmpty) {
      return entry;
    }
  }
  for (var index = entries.length - 1; index >= 0; index -= 1) {
    final entry = entries[index];
    if (entry.kind == ActivityFeedKind.error) return entry;
  }
  return null;
}

List<ActivityFeedEntry> buildProjectionActivityFeed({
  required ThreadRunProjectionSnapshot projection,
  String? threadPrompt,
  String? threadId,
  List<ThreadSubagentSessionTiming> subagentSessions = const [],
  required AppLocalizations l10n,
  ThinkingDisplayMode thinkingDisplayMode = defaultThinkingDisplayMode,
  bool? conversationLive,
}) {
  final requestSpansById = {
    for (final span in projection.requestSpans) span.requestId: span,
  };
  // The session supplies its joined lifecycle/V2 clock when run coverage is absent.
  // Missing run rows alone do not establish that a conversation is live.
  final feedLive =
      conversationLive ?? !isThreadStoppedForMessageMeta(projection.status);
  final terminalAttemptIds = {
    for (final attempt in projection.attempts)
      if (!attempt.isRunning) attempt.attemptId,
  };
  final sessionsByAgentId = indexSubagentSessionsByAgentId(subagentSessions);
  final slots = <_ProjectionFeedSlot>[];

  final hasProjectedUserPrompt = projection.timeline.any(
    _isProjectionUserPromptItem,
  );
  final prompt = threadPrompt?.trim();
  // Only seed the first thread.prompt when the Feed is still empty. If the
  // timeline already has assistant/tool rows but no user prompt (e.g. a bad
  // incremental replace), injecting the original prompt creates a cliff that
  // pairs turn-1 text with the latest agent output.
  if (!hasProjectedUserPrompt &&
      projection.timeline.isEmpty &&
      prompt != null &&
      prompt.isNotEmpty) {
    final isClarificationAnswer = parseClarificationAnswers(prompt) != null;
    slots.add(
      _ProjectionFeedSlot(
        entry: ActivityFeedEntry(
          id: 'user-prompt-${threadId ?? projection.threadId}',
          kind: isClarificationAnswer
              ? ActivityFeedKind.clarificationAnswer
              : ActivityFeedKind.user,
          text: prompt,
          at: '1970-01-01T00:00:00.000Z',
        ),
        at: '1970-01-01T00:00:00.000Z',
        sequence: 0,
        sortLane: _feedSortLaneNormal,
        sortKey: 'user:prompt',
      ),
    );
  }

  for (final item in projection.timeline.where(_isProjectionUserPromptItem)) {
    final rewindTarget = _readProjectionRewindTarget(item.metadata);
    final isClarificationAnswer = parseClarificationAnswers(item.text) != null;
    slots.add(
      _ProjectionFeedSlot(
        entry: ActivityFeedEntry(
          id: item.id,
          role: item.role,
          kind: isClarificationAnswer
              ? ActivityFeedKind.clarificationAnswer
              : ActivityFeedKind.user,
          text: item.text.trim(),
          attachments: _promptImagePreviews(item),
          rewindTarget: rewindTarget,
          // V2 messages no longer carry the retired V1 activity-line column.
          // The stable message identity is still the deterministic target
          // required by the non-rewind Codex retry gate; migrated rewind
          // metadata wins when it is present.
          activityLineId:
              rewindTarget?.activityLineId ?? item.streamKey ?? item.id,
          historyRevision: projection.historyRevision,
          at: item.at,
          sequence: item.sequence,
        ),
        at: item.at,
        sequence: item.sequence,
        sortLane: _feedSortLaneNormal,
        sortKey: 'user:${item.id}',
      ),
    );
  }

  final subagentCards = projection.agents
      .where((agent) => agent.kind == 'subagent')
      .map((agent) {
        final displayTimeline = _filterProjectionTimelineForDetailFeed(
          agent.timeline,
          requestSpansById,
          thinkingDisplayMode: thinkingDisplayMode,
          conversationLive: feedLive && agent.isRunning,
          terminalAttemptIds: terminalAttemptIds,
        );
        final hiddenThinkingActivity =
            agent.latestActivity != null &&
            agent.timeline.any(
              (item) =>
                  (item.eventType == 'thinking.delta' ||
                      item.eventType == 'thinking.final') &&
                  item.text.trim() == agent.latestActivity!.trim() &&
                  !displayTimeline.any((visible) => visible.id == item.id),
            );
        final displayAgent = ThreadRunProjectionAgent(
          agentId: agent.agentId,
          role: agent.role,
          kind: agent.kind,
          status: agent.status,
          startedAt: agent.startedAt,
          durationMs: agent.durationMs,
          timeline: displayTimeline,
          delegationSummary: agent.delegationSummary,
          delegationPrompt: agent.delegationPrompt,
          mission: agent.mission,
          taskName: agent.taskName,
          todoId: agent.todoId,
          nickname: agent.nickname,
          parentAgentId: agent.parentAgentId,
          parentToolUseId: agent.parentToolUseId,
          latestActivity: hiddenThinkingActivity ? null : agent.latestActivity,
          endedAt: agent.endedAt,
          runAttemptId: agent.runAttemptId,
        );
        final missionText = resolveSubagentCardMissionText(
          agent,
          mainTimeline: projection.timeline,
        );
        return _ProjectionSubagentCard(
          agent: displayAgent,
          displayTimeline: displayTimeline,
          missionText: missionText,
          statusText: resolveProjectionAgentStatusText(displayAgent, l10n),
        );
      })
      .toList();

  final rawMainTimeline = _mainProjectionTimelineItems(projection);
  final mainTimeline = _filterAbsorbedSubagentDelegations(
    _filterMainTimelineForFeed(
      rawMainTimeline,
      requestSpansById,
      thinkingDisplayMode: thinkingDisplayMode,
      conversationLive: feedLive,
      terminalAttemptIds: terminalAttemptIds,
    ),
    subagentCards,
    requestSpansById,
  );
  final toolSortAnchors = _buildToolLifecycleSortAnchors([
    ...rawMainTimeline,
    for (final card in subagentCards) ...card.agent.timeline,
  ]);

  for (final item in mainTimeline) {
    final entry = _buildProjectionFeedEntry(
      item,
      requestSpansById,
      rawMainTimeline,
      l10n: l10n,
    );
    if (entry == null) continue;
    final sortAnchor = _resolveFeedEntrySortAnchor(item, toolSortAnchors);
    slots.add(
      _ProjectionFeedSlot(
        entry: entry,
        at: sortAnchor.at,
        sequence: sortAnchor.sequence,
        sortLane: _resolveFeedEntrySortLane(item, requestSpansById),
        sortKey: entry.id,
      ),
    );
  }

  for (final card in subagentCards) {
    final agent = card.agent;
    final role = normalizeAgentDisplayRole(agent.role) ?? agent.role;
    final delegation = readProjectionAgentDelegation(agent);
    final missionText = card.missionText;
    final timing = sessionsByAgentId[agent.agentId];
    final running = resolveSubagentRunning(agent: agent, timing: timing);
    final durationMs = resolveSubagentDurationMs(agent: agent, timing: timing);
    final timeline = buildSubagentTimelineFromProjection(
      card.displayTimeline,
      l10n,
    );
    final attachments = _visionSubagentPromptImages(
      agent: agent,
      timeline: projection.timeline,
    );

    slots.add(
      _ProjectionFeedSlot(
        entry: ActivityFeedEntry(
          id: 'projection-agent-${agent.agentId}',
          kind: ActivityFeedKind.subagentMission,
          text:
              delegation?.summary ?? resolveSubagentRunDisplayTitle(role, l10n),
          subagentRole: role,
          attachments: attachments,
          missionPrompt: missionText.isNotEmpty
              ? missionText
              : delegation?.prompt,
          taskName: agent.taskName,
          agentId: agent.agentId,
          running: running,
          durationMs: durationMs,
          statusText:
              card.statusText ?? (running ? l10n.activityWorking : null),
          timeline: timeline,
          runAttemptId: agent.runAttemptId,
          at: agent.startedAt,
        ),
        at: agent.startedAt,
        sequence: card.displayTimeline.firstOrNull?.sequence ?? 0,
        sortLane: _feedSortLaneNormal,
        sortKey: 'agent-card:${agent.agentId}',
      ),
    );
  }

  slots.sort((left, right) {
    final laneDelta = left.sortLane.compareTo(right.sortLane);
    if (laneDelta != 0) return laneDelta;
    final atDelta = left.at.compareTo(right.at);
    if (atDelta != 0) return atDelta;
    final sequenceDelta = left.sequence.compareTo(right.sequence);
    if (sequenceDelta != 0) return sequenceDelta;
    return left.sortKey.compareTo(right.sortKey);
  });

  return slots.map((slot) => slot.entry.withSequence(slot.sequence)).toList();
}

Map<String, ({String at, int sequence})> _buildToolLifecycleSortAnchors(
  List<ThreadRunProjectionTimelineItem> timeline,
) {
  final anchors = <String, ({String at, int sequence})>{};
  for (final item in timeline) {
    final toolUseId =
        readProjectionToolMetadata(item.metadata)?.toolUseId?.trim() ??
        readBashApprovalMetadata(item.metadata)?.toolUseId.trim();
    if (toolUseId == null || toolUseId.isEmpty) continue;
    final candidate = (at: item.at, sequence: item.sequence);
    final existing = anchors[toolUseId];
    if (existing == null || candidate.sequence < existing.sequence) {
      anchors[toolUseId] = candidate;
    }
  }
  return anchors;
}

({String at, int sequence}) _resolveFeedEntrySortAnchor(
  ThreadRunProjectionTimelineItem item,
  Map<String, ({String at, int sequence})> toolAnchors,
) {
  final toolUseId =
      readProjectionToolMetadata(item.metadata)?.toolUseId?.trim() ??
      readBashApprovalMetadata(item.metadata)?.toolUseId.trim();
  if (toolUseId != null && toolUseId.isNotEmpty) {
    final anchor = toolAnchors[toolUseId];
    if (anchor != null) return anchor;
  }
  return (at: item.at, sequence: item.sequence);
}

int _resolveFeedEntrySortLane(
  ThreadRunProjectionTimelineItem item,
  Map<String, ThreadRunProjectionRequestSpan> requestSpansById,
) {
  if (item.eventType == 'message.delta') {
    final requestId = item.requestId?.trim();
    final span = requestId == null ? null : requestSpansById[requestId];
    if (span == null || _isProjectionRequestActive(span)) {
      return _feedSortLaneStreamMessage;
    }
  }
  return _feedSortLaneNormal;
}

ActivityFeedEntry? _buildProjectionFeedEntry(
  ThreadRunProjectionTimelineItem item,
  Map<String, ThreadRunProjectionRequestSpan> requestSpansById,
  List<ThreadRunProjectionTimelineItem> rawMainTimeline, {
  String? agentId,
  String? agentRole,
  required AppLocalizations l10n,
}) {
  final feedId = _projectionMainFeedEntryKey(
    item,
    requestSpansById,
    rawMainTimeline,
    agentId: agentId,
  );
  return _projectionItemToFeedEntry(
    item,
    feedId: feedId,
    agentRole: agentRole,
    agentId: agentId,
    l10n: l10n,
  );
}

String _projectionMainFeedEntryKey(
  ThreadRunProjectionTimelineItem item,
  Map<String, ThreadRunProjectionRequestSpan> requestSpansById,
  List<ThreadRunProjectionTimelineItem> rawMainTimeline, {
  String? agentId,
}) {
  final scope = agentId != null ? 'agent:$agentId' : 'main';
  final reasoningSummarySlotKey = item.metadata?['reasoningSummarySlotKey'];
  if (reasoningSummarySlotKey is String &&
      reasoningSummarySlotKey.trim().isNotEmpty) {
    return '$scope:reasoning-summary:${reasoningSummarySlotKey.trim()}';
  }
  final streamKey = _projectionStreamDisplayKey(
    item,
    requestSpansById,
    rawMainTimeline,
  );
  if (streamKey != null) {
    return '$scope:stream:$streamKey';
  }
  final lifecycleKey = _projectionToolLifecycleKey(item);
  if (lifecycleKey != null) {
    return '$scope:$lifecycleKey';
  }
  final toolKey = _projectionToolDisplayKey(item);
  if (toolKey != null) {
    return '$scope:$toolKey';
  }
  return '$scope:${item.id}';
}

List<ThreadRunProjectionTimelineItem> _mainProjectionTimelineItems(
  ThreadRunProjectionSnapshot projection,
) {
  final items = <ThreadRunProjectionTimelineItem>[...projection.timeline];
  for (final agent in projection.agents) {
    if (agent.kind == 'subagent') continue;
    items.addAll(agent.timeline);
  }
  items.sort((left, right) {
    final atDelta = left.at.compareTo(right.at);
    if (atDelta != 0) return atDelta;
    final sequenceDelta = left.sequence.compareTo(right.sequence);
    if (sequenceDelta != 0) return sequenceDelta;
    return left.id.compareTo(right.id);
  });
  return items;
}

bool _isProjectionUserPromptItem(ThreadRunProjectionTimelineItem item) {
  final liveType = _projectionLiveType(item);
  final hasText = item.text.trim().isNotEmpty;
  final hasAttachments = _promptImagePreviews(item).isNotEmpty;
  if ((!hasText && !hasAttachments) ||
      isThreadFollowUpActivityMessage(item.text)) {
    return false;
  }
  if (isRecordedUserPromptLiveEvent(liveType)) {
    return true;
  }
  return liveType == 'message.user' &&
      item.role == 'user' &&
      item.scope != 'agent';
}

List<PromptImageAttachment> _promptImagePreviews(
  ThreadRunProjectionTimelineItem item,
) {
  final raw = item.metadata?['promptImagePreviews'];
  if (raw is! List<dynamic>) return const [];
  return raw
      .whereType<Map<String, dynamic>>()
      .map(PromptImageAttachment.fromJson)
      .where((attachment) => attachment.data.isNotEmpty)
      .toList();
}

ThreadActivityRewindTarget? _readProjectionRewindTarget(
  Map<String, dynamic>? metadata,
) {
  final raw = metadata?['rewindTarget'];
  if (raw is! Map) return null;
  final activityLineId = raw['activityLineId'];
  if (activityLineId is! String || activityLineId.trim().isEmpty) return null;
  final userMessageId = raw['userMessageId'];
  return ThreadActivityRewindTarget(
    activityLineId: activityLineId.trim(),
    userMessageId: userMessageId is String && userMessageId.trim().isNotEmpty
        ? userMessageId.trim()
        : null,
  );
}

List<PromptImageAttachment> _visionSubagentPromptImages({
  required ThreadRunProjectionAgent agent,
  required List<ThreadRunProjectionTimelineItem> timeline,
}) {
  if (normalizeAgentDisplayRole(agent.role) != 'vision') return const [];

  for (final item in timeline.reversed) {
    if (!_isProjectionUserPromptItem(item)) continue;
    if (agent.startedAt.isNotEmpty &&
        item.at.isNotEmpty &&
        item.at.compareTo(agent.startedAt) > 0) {
      continue;
    }
    return _promptImagePreviews(item);
  }
  return const [];
}

List<ThreadRunProjectionTimelineItem> _filterMainTimelineForFeed(
  List<ThreadRunProjectionTimelineItem> timeline,
  Map<String, ThreadRunProjectionRequestSpan> requestSpansById, {
  ThinkingDisplayMode thinkingDisplayMode = defaultThinkingDisplayMode,
  bool conversationLive = true,
  Set<String> terminalAttemptIds = const {},
}) {
  final displayTimeline = _filterProjectionTimelineForDetailFeed(
    timeline,
    requestSpansById,
    thinkingDisplayMode: thinkingDisplayMode,
    conversationLive: conversationLive,
    terminalAttemptIds: terminalAttemptIds,
  );
  final filtered = displayTimeline
      .where(
        (item) =>
            item.scope != 'agent' &&
            !_isMainTimelineNoiseItem(item, displayTimeline),
      )
      .toList();
  return _filterCompactionTimelineForFeed(filtered);
}

List<ThreadRunProjectionTimelineItem> _filterAbsorbedSubagentDelegations(
  List<ThreadRunProjectionTimelineItem> timeline,
  List<_ProjectionSubagentCard> subagentCards,
  Map<String, ThreadRunProjectionRequestSpan> requestSpansById,
) {
  final absorbedToolUseIds = _collectAgentTimelineToolUseIds(
    subagentCards,
    requestSpansById,
  );
  final subagentAgentIds = subagentCards
      .map((card) => card.agent.agentId)
      .toSet();
  for (final card in subagentCards) {
    final parentToolUseId = card.agent.parentToolUseId?.trim();
    if (parentToolUseId != null && parentToolUseId.isNotEmpty) {
      absorbedToolUseIds.add(parentToolUseId);
    }
  }
  if (absorbedToolUseIds.isEmpty && subagentAgentIds.isEmpty) return timeline;

  return timeline.where((item) {
    final mission = parseSubagentMissionMessage(item.text);
    if (isSubagentMissionEnvelope(item.text)) {
      final missionAgentId = mission?.agentId?.trim();
      if (missionAgentId != null &&
          missionAgentId.isNotEmpty &&
          subagentAgentIds.contains(missionAgentId)) {
        return false;
      }
      final itemAgentId = item.agentId?.trim();
      if (itemAgentId != null &&
          itemAgentId.isNotEmpty &&
          subagentAgentIds.contains(itemAgentId)) {
        return false;
      }
      final toolUseId =
          readProjectionToolMetadata(item.metadata)?.toolUseId?.trim() ??
          readBashApprovalMetadata(item.metadata)?.toolUseId.trim();
      if (toolUseId != null && absorbedToolUseIds.contains(toolUseId)) {
        return false;
      }
    }
    final bashApproval = readBashApprovalMetadata(item.metadata);
    final approvalToolUseId = bashApproval?.toolUseId.trim();
    if (approvalToolUseId != null &&
        approvalToolUseId.isNotEmpty &&
        absorbedToolUseIds.contains(approvalToolUseId)) {
      return false;
    }
    if (item.eventType != 'tool.started' &&
        item.eventType != 'tool.completed') {
      return true;
    }
    final toolUseId = readProjectionToolMetadata(
      item.metadata,
    )?.toolUseId?.trim();
    return toolUseId == null || !absorbedToolUseIds.contains(toolUseId);
  }).toList();
}

Set<String> _collectAgentTimelineToolUseIds(
  List<_ProjectionSubagentCard> subagentCards,
  Map<String, ThreadRunProjectionRequestSpan> requestSpansById,
) {
  final ids = <String>{};
  for (final card in subagentCards) {
    final displayTimeline = _filterProjectionTimelineForDetailFeed(
      card.agent.timeline,
      requestSpansById,
      thinkingDisplayMode: defaultThinkingDisplayMode,
    );
    for (final item in displayTimeline) {
      final toolUseId =
          readProjectionToolMetadata(item.metadata)?.toolUseId?.trim() ??
          readBashApprovalMetadata(item.metadata)?.toolUseId.trim();
      if (toolUseId != null && toolUseId.isNotEmpty) {
        ids.add(toolUseId);
      }
    }
  }
  return ids;
}

List<ThreadRunProjectionTimelineItem> _filterProjectionTimelineForDetailFeed(
  List<ThreadRunProjectionTimelineItem> timeline,
  Map<String, ThreadRunProjectionRequestSpan> requestSpansById, {
  ThinkingDisplayMode thinkingDisplayMode = defaultThinkingDisplayMode,
  bool conversationLive = true,
  Set<String> terminalAttemptIds = const {},
}) {
  final built = _buildProjectionDisplayTimelineItems(
    timeline,
    requestSpansById,
  ).where((item) => !isEmptyTerminalThinkingItem(item)).toList();
  // 阅后即焚 → tip path; 折叠/展开 → keep raw thinking as cards.
  final forCollapse = thinkingDisplayMode.usesEphemeralTip
      ? presentThinkingAsEphemeralSummaryTips(built)
      : built;
  final displayTimeline = collapseEphemeralReasoningSummaryTimeline(
    forCollapse,
    conversationLive: conversationLive,
    terminalAttemptIds: terminalAttemptIds,
  );
  final failedTools = displayTimeline
      .where((item) => item.eventType == 'tool.failed')
      .map((item) => _resolveProjectionToolName(item).toLowerCase())
      .toSet();
  if (failedTools.isEmpty) return displayTimeline;
  return displayTimeline
      .where(
        (item) => !_isProjectionToolFailureDuplicateMessage(item, failedTools),
      )
      .toList();
}

List<ThreadRunProjectionTimelineItem> _buildProjectionDisplayTimelineItems(
  List<ThreadRunProjectionTimelineItem> timeline,
  Map<String, ThreadRunProjectionRequestSpan> requestSpansById,
) {
  final latestStreamDisplayByKey = <String, ThreadRunProjectionTimelineItem>{};
  final latestToolDisplayByKey = <String, ThreadRunProjectionTimelineItem>{};
  final latestLifecycleDisplayByKey =
      <String, ThreadRunProjectionTimelineItem>{};
  final latestReconnectDisplayByKey =
      <String, ThreadRunProjectionTimelineItem>{};

  for (final item in timeline) {
    final reconnectKey = _projectionReconnectDisplayKey(item);
    if (reconnectKey != null) {
      final current = latestReconnectDisplayByKey[reconnectKey];
      if (current == null || _compareTimelineItems(current, item) <= 0) {
        latestReconnectDisplayByKey[reconnectKey] = item;
      }
    }

    final lifecycleKey = _projectionToolLifecycleKey(item);
    if (lifecycleKey != null) {
      final current = latestLifecycleDisplayByKey[lifecycleKey];
      if (current == null ||
          _compareProjectionLifecycleDisplayItems(item, current) > 0) {
        latestLifecycleDisplayByKey[lifecycleKey] = item;
      }
    }

    final streamKey = _projectionStreamDisplayKey(
      item,
      requestSpansById,
      timeline,
    );
    if (streamKey != null) {
      if (_isDuplicateStreamBlockFinalEcho(item, timeline) ||
          _isDuplicateLegacyStreamFinalEcho(item, timeline)) {
        continue;
      }
      final current = latestStreamDisplayByKey[streamKey];
      if (current == null || _compareTimelineItems(current, item) <= 0) {
        latestStreamDisplayByKey[streamKey] = _mergeStreamDisplayTimelineItem(
          current,
          item,
          timeline,
        );
      }
    }

    final toolKey = _projectionToolDisplayKey(item);
    if (toolKey != null) {
      final current = latestToolDisplayByKey[toolKey];
      if (current == null ||
          _compareProjectionToolDisplayItems(current, item) <= 0) {
        latestToolDisplayByKey[toolKey] = item;
      }
    }
  }

  final displayItems = <ThreadRunProjectionTimelineItem>[];
  for (final item in timeline) {
    final reconnectKey = _projectionReconnectDisplayKey(item);
    if (reconnectKey != null) {
      if (latestReconnectDisplayByKey[reconnectKey]?.id != item.id) {
        continue;
      }
      if (_isTimelineItemSupersededByRecovery(timeline, item)) {
        continue;
      }
    }
    final lifecycleKey = _projectionToolLifecycleKey(item);
    if (lifecycleKey != null &&
        latestLifecycleDisplayByKey[lifecycleKey]?.id != item.id) {
      continue;
    }
    final streamKey = _projectionStreamDisplayKey(
      item,
      requestSpansById,
      timeline,
    );
    var displayItem = item;
    if (streamKey != null) {
      final latestStream = latestStreamDisplayByKey[streamKey];
      if (latestStream == null || latestStream.id != item.id) {
        continue;
      }
      displayItem = latestStream;
    }
    final toolKey = _projectionToolDisplayKey(item);
    if (toolKey != null && latestToolDisplayByKey[toolKey]?.id != item.id) {
      continue;
    }
    if (_isDuplicateStreamBlockFinalEcho(displayItem, timeline)) {
      continue;
    }
    if (_isDuplicateLegacyStreamFinalEcho(displayItem, timeline)) {
      continue;
    }
    final settled = _settleTerminalStreamDisplayItem(
      displayItem,
      requestSpansById,
    );
    if (settled != null) {
      displayItems.add(settled);
    }
  }
  return displayItems;
}

bool _isDuplicateStreamBlockFinalEcho(
  ThreadRunProjectionTimelineItem item,
  List<ThreadRunProjectionTimelineItem> timeline,
) {
  if (item.eventType != 'message.final' && item.eventType != 'thinking.final') {
    return false;
  }
  if (!_isExplicitStreamBlockItem(item) ||
      (item.requestId?.trim().isNotEmpty ?? false)) {
    return false;
  }
  final streamKey = item.streamKey?.trim();
  final text = item.text.trim();
  if (streamKey == null || streamKey.isEmpty || text.isEmpty) {
    return false;
  }
  final channel = _streamDisplayChannel(item);
  return timeline.any((other) {
    if (other.id == item.id || other.streamKey?.trim() != streamKey) {
      return false;
    }
    if ((other.requestId?.trim().isEmpty ?? true) ||
        _streamDisplayChannel(other) != channel) {
      return false;
    }
    if (!_isStreamDisplayTimelineItem(other) || other.text.trim() != text) {
      return false;
    }
    return !_hasUserPromptBetweenTimelineItems(timeline, item, other);
  });
}

bool _isDuplicateLegacyStreamFinalEcho(
  ThreadRunProjectionTimelineItem item,
  List<ThreadRunProjectionTimelineItem> timeline,
) {
  if (item.eventType != 'message.final' && item.eventType != 'thinking.final') {
    return false;
  }
  if (_isExplicitStreamBlockItem(item)) {
    return false;
  }
  final text = item.text.trim();
  if (text.isEmpty) {
    return false;
  }
  final channel = _streamDisplayChannel(item);
  return timeline.any((other) {
    if (other.id == item.id || !_isExplicitStreamBlockItem(other)) {
      return false;
    }
    if (other.eventType != item.eventType ||
        _streamDisplayChannel(other) != channel) {
      return false;
    }
    if (other.text.trim() != text) {
      return false;
    }
    return !_hasUserPromptBetweenTimelineItems(timeline, item, other);
  });
}

bool _isExplicitStreamBlockItem(ThreadRunProjectionTimelineItem item) {
  return item.streamKey?.contains(':block:') ?? false;
}

bool _isStreamDisplayTimelineItem(ThreadRunProjectionTimelineItem item) {
  return item.eventType == 'thinking.delta' ||
      item.eventType == 'thinking.final' ||
      item.eventType == 'message.delta' ||
      item.eventType == 'message.final';
}

String _streamDisplayChannel(ThreadRunProjectionTimelineItem item) {
  return item.eventType == 'thinking.delta' ||
          item.eventType == 'thinking.final'
      ? 'thinking'
      : 'message';
}

bool _hasUserPromptBetweenTimelineItems(
  List<ThreadRunProjectionTimelineItem> timeline,
  ThreadRunProjectionTimelineItem left,
  ThreadRunProjectionTimelineItem right,
) {
  final earlier = _compareTimelineItems(left, right) <= 0 ? left : right;
  final later = earlier.id == left.id ? right : left;
  return _hasUserPromptBetween(timeline, earlier, later);
}

bool _hasUserPromptBetween(
  List<ThreadRunProjectionTimelineItem> timeline,
  ThreadRunProjectionTimelineItem current,
  ThreadRunProjectionTimelineItem item,
) {
  final currentIndex = timeline.indexWhere((entry) => entry.id == current.id);
  final itemIndex = timeline.indexWhere((entry) => entry.id == item.id);
  if (currentIndex < 0 || itemIndex < 0 || itemIndex <= currentIndex) {
    return false;
  }
  for (var index = currentIndex + 1; index < itemIndex; index += 1) {
    final entry = timeline[index];
    if (_isProjectionUserPromptItem(entry)) {
      return true;
    }
  }
  return false;
}

bool _isThinkingTextContinuation(String previous, String next) {
  final prev = previous.trim();
  final nextTrim = next.trim();
  if (nextTrim.isEmpty) {
    return true;
  }
  if (prev.isEmpty) {
    return true;
  }
  return nextTrim.startsWith(prev) || prev.startsWith(nextTrim);
}

bool _hasThinkingStreamBoundaryBetween(
  List<ThreadRunProjectionTimelineItem> timeline,
  ThreadRunProjectionTimelineItem current,
  ThreadRunProjectionTimelineItem item,
) {
  final currentIndex = timeline.indexWhere((entry) => entry.id == current.id);
  final itemIndex = timeline.indexWhere((entry) => entry.id == item.id);
  if (currentIndex < 0 || itemIndex < 0 || itemIndex <= currentIndex) {
    return false;
  }
  for (var index = currentIndex + 1; index < itemIndex; index += 1) {
    final entry = timeline[index];
    if (_isProjectionUserPromptItem(entry)) {
      return true;
    }
    if (entry.eventType == 'thinking.final' ||
        entry.eventType == 'message.final') {
      return true;
    }
    if (entry.eventType == 'tool.started' ||
        entry.eventType == 'tool.completed' ||
        entry.eventType == 'tool.failed') {
      return true;
    }
  }
  return false;
}

bool _hasOnlyEmptyThinkingBefore(
  List<ThreadRunProjectionTimelineItem> timeline,
  ThreadRunProjectionTimelineItem item,
) {
  final itemIndex = timeline.indexWhere((entry) => entry.id == item.id);
  if (itemIndex <= 0) {
    return false;
  }
  var sawEmptyThinking = false;
  for (var index = itemIndex - 1; index >= 0; index -= 1) {
    final entry = timeline[index];
    final isThinking =
        entry.eventType == 'thinking.delta' ||
        entry.eventType == 'thinking.final';
    if (!isThinking) {
      return false;
    }
    if (entry.text.trim().isNotEmpty) {
      return sawEmptyThinking;
    }
    sawEmptyThinking = true;
  }
  return false;
}

bool _shouldResetThinkingStreamMerge(
  ThreadRunProjectionTimelineItem current,
  ThreadRunProjectionTimelineItem item,
  List<ThreadRunProjectionTimelineItem> timeline,
) {
  final currentRequestId = current.requestId?.trim();
  final itemRequestId = item.requestId?.trim();
  if (currentRequestId != null &&
      currentRequestId.isNotEmpty &&
      itemRequestId != null &&
      itemRequestId.isNotEmpty &&
      currentRequestId != itemRequestId) {
    return true;
  }
  if (hasReasoningSummaryStamp(current) || hasReasoningSummaryStamp(item)) {
    if (hasReasoningSummaryStamp(current) != hasReasoningSummaryStamp(item)) {
      return true;
    }
    final currentKey = current.streamKey?.trim();
    final itemKey = item.streamKey?.trim();
    final currentStamp = (currentKey != null && currentKey.isNotEmpty)
        ? currentKey
        : current.id;
    final itemStamp = (itemKey != null && itemKey.isNotEmpty)
        ? itemKey
        : item.id;
    if (currentStamp != itemStamp) {
      return true;
    }
  }
  if (current.eventType == 'thinking.final') {
    return true;
  }
  if (_hasUserPromptBetween(timeline, current, item)) {
    return true;
  }
  final currentStreamKey = current.streamKey?.trim();
  final itemStreamKey = item.streamKey?.trim();
  if (currentStreamKey != null &&
      currentStreamKey.isNotEmpty &&
      currentStreamKey == itemStreamKey) {
    return false;
  }
  if (current.id != item.id &&
      item.text.trim().isEmpty &&
      current.text.trim().isNotEmpty &&
      _hasThinkingStreamBoundaryBetween(timeline, current, item)) {
    return true;
  }
  if (current.id != item.id &&
      !_isThinkingTextContinuation(current.text, item.text)) {
    if (_hasThinkingStreamBoundaryBetween(timeline, current, item)) {
      return true;
    }
    if (item.text.trim().isNotEmpty &&
        item.text.length < current.text.length &&
        _hasOnlyEmptyThinkingBefore(timeline, item)) {
      return false;
    }
    return true;
  }
  return false;
}

ThreadRunProjectionTimelineItem _mergeStreamDisplayTimelineItem(
  ThreadRunProjectionTimelineItem? current,
  ThreadRunProjectionTimelineItem item,
  List<ThreadRunProjectionTimelineItem> timeline,
) {
  if (current == null || _compareTimelineItems(current, item) > 0) {
    return item;
  }
  final isThinkingStream =
      item.eventType == 'thinking.delta' || item.eventType == 'thinking.final';
  if (!isThinkingStream) {
    final mergedText = mergeStreamText(current.text, item.text);
    if (mergedText == item.text) {
      return item;
    }
    return ThreadRunProjectionTimelineItem(
      id: item.id,
      sequence: item.sequence,
      eventType: item.eventType,
      scope: item.scope,
      text: mergedText,
      at: item.at,
      role: item.role,
      agentId: item.agentId,
      runAttemptId: item.runAttemptId,
      requestId: item.requestId,
      streamKey: item.streamKey,
      metadata: item.metadata,
    );
  }
  if (_shouldResetThinkingStreamMerge(current, item, timeline)) {
    return item;
  }
  final preservedText = mergeStreamText(current.text, item.text);
  return ThreadRunProjectionTimelineItem(
    id: item.id,
    sequence: item.sequence,
    eventType: item.eventType,
    scope: item.scope,
    text: preservedText,
    at: item.at,
    role: item.role,
    agentId: item.agentId,
    runAttemptId: item.runAttemptId,
    requestId: item.requestId,
    streamKey: item.streamKey,
    metadata: _mergeThinkingTimingMetadata(current.metadata, item.metadata),
  );
}

Map<String, dynamic>? _mergeThinkingTimingMetadata(
  Map<String, dynamic>? existing,
  Map<String, dynamic>? incoming,
) {
  if (existing == null && incoming == null) {
    return null;
  }
  final merged = <String, dynamic>{...?existing, ...?incoming};
  final existingStarted = existing?['thinkingStartedAt'];
  final incomingStarted = incoming?['thinkingStartedAt'];
  final thinkingStartedAt =
      (existingStarted is String && existingStarted.trim().isNotEmpty)
      ? existingStarted.trim()
      : (incomingStarted is String && incomingStarted.trim().isNotEmpty)
      ? incomingStarted.trim()
      : null;
  if (thinkingStartedAt != null) {
    merged['thinkingStartedAt'] = thinkingStartedAt;
  }
  final reasoningDisplay =
      readReasoningDisplay(existing) ?? readReasoningDisplay(incoming);
  if (reasoningDisplay != null) {
    merged['reasoningDisplay'] = reasoningDisplay;
  }
  return merged.isEmpty ? null : merged;
}

int _resolveTurnBoundaryIndex(
  List<ThreadRunProjectionTimelineItem> timeline,
  int itemIndex,
) {
  for (var index = itemIndex - 1; index >= 0; index -= 1) {
    final entry = timeline[index];
    if (_isProjectionUserPromptItem(entry)) {
      return index;
    }
    if (entry.eventType == 'message.final' && entry.role == 'main') {
      return index;
    }
    if (entry.eventType == 'thinking.final') {
      return index;
    }
  }
  return -1;
}

int _resolveTurnSegmentEndIndex(
  List<ThreadRunProjectionTimelineItem> timeline,
  int itemIndex,
) {
  for (var index = itemIndex + 1; index < timeline.length; index += 1) {
    final entry = timeline[index];
    if (_isProjectionUserPromptItem(entry)) {
      return index;
    }
  }
  return timeline.length;
}

int _resolveUserPromptBoundaryIndex(
  List<ThreadRunProjectionTimelineItem> timeline,
  int itemIndex,
) {
  for (var index = itemIndex - 1; index >= 0; index -= 1) {
    final entry = timeline[index];
    if (_isProjectionUserPromptItem(entry)) {
      return index;
    }
  }
  return -1;
}

String? _resolveExpectedStreamRequestRole(
  ThreadRunProjectionTimelineItem item,
) {
  if (item.role == 'thinking' ||
      item.eventType == 'thinking.delta' ||
      item.eventType == 'thinking.final') {
    return 'main';
  }
  final role = item.role?.trim();
  if (role == null ||
      role.isEmpty ||
      role == 'tool' ||
      role == 'system' ||
      role == 'user') {
    return null;
  }
  return role;
}

bool _streamRequestCandidateMatchesItem(
  ThreadRunProjectionTimelineItem candidate,
  ThreadRunProjectionTimelineItem item,
  Map<String, ThreadRunProjectionRequestSpan> requestSpansById,
) {
  final requestId = candidate.requestId?.trim();
  if (requestId == null || requestId.isEmpty) {
    return false;
  }
  final span = requestSpansById[requestId];
  final itemAgentId = item.agentId?.trim();
  if (itemAgentId != null &&
      itemAgentId.isNotEmpty &&
      span?.ownerAgentId != null &&
      span!.ownerAgentId != itemAgentId) {
    return false;
  }
  final expectedRole = _resolveExpectedStreamRequestRole(item);
  final candidateRole = span?.role ?? candidate.role;
  if (expectedRole != null &&
      candidateRole != null &&
      candidateRole != expectedRole) {
    return false;
  }
  return true;
}

String? _resolveNearestStreamRequestIdInUserTurn(
  ThreadRunProjectionTimelineItem item,
  List<ThreadRunProjectionTimelineItem> timeline,
  Map<String, ThreadRunProjectionRequestSpan> requestSpansById,
) {
  final itemIndex = timeline.indexWhere((entry) => entry.id == item.id);
  if (itemIndex < 0) {
    return null;
  }
  final userBoundaryIndex = _resolveUserPromptBoundaryIndex(
    timeline,
    itemIndex,
  );
  final searchStart = userBoundaryIndex >= 0 ? userBoundaryIndex + 1 : 0;
  final searchEnd = _resolveTurnSegmentEndIndex(timeline, itemIndex);
  String? fallbackRequestId;

  for (var index = itemIndex; index >= searchStart; index -= 1) {
    final entry = timeline[index];
    if (!_streamRequestCandidateMatchesItem(entry, item, requestSpansById)) {
      continue;
    }
    final requestId = entry.requestId?.trim();
    if (entry.eventType == 'request.started') {
      return requestId;
    }
    fallbackRequestId ??= requestId;
  }
  if (fallbackRequestId != null) {
    return fallbackRequestId;
  }

  for (var index = itemIndex + 1; index < searchEnd; index += 1) {
    final entry = timeline[index];
    if (!_streamRequestCandidateMatchesItem(entry, item, requestSpansById)) {
      continue;
    }
    final requestId = entry.requestId?.trim();
    if (entry.eventType == 'request.started') {
      return requestId;
    }
    fallbackRequestId ??= requestId;
  }
  return fallbackRequestId;
}

String? _resolveNearestPlannerRequestId(
  ThreadRunProjectionTimelineItem item,
  List<ThreadRunProjectionTimelineItem> timeline,
  Map<String, ThreadRunProjectionRequestSpan> requestSpansById,
) {
  final itemIndex = timeline.indexWhere((entry) => entry.id == item.id);
  if (itemIndex < 0) {
    return null;
  }
  final turnBoundaryIndex = _resolveTurnBoundaryIndex(timeline, itemIndex);
  final searchStart = turnBoundaryIndex >= 0 ? turnBoundaryIndex + 1 : 0;
  final searchEnd = _resolveTurnSegmentEndIndex(timeline, itemIndex);
  for (var index = itemIndex; index >= searchStart; index -= 1) {
    final entry = timeline[index];
    final requestId = entry.requestId?.trim();
    if (requestId == null || requestId.isEmpty) {
      continue;
    }
    if (entry.eventType == 'request.started' && entry.role == 'main') {
      return requestId;
    }
    if (entry.role == 'main' && requestSpansById.containsKey(requestId)) {
      return requestId;
    }
  }
  for (var index = itemIndex + 1; index < searchEnd; index += 1) {
    final entry = timeline[index];
    final requestId = entry.requestId?.trim();
    if (requestId == null || requestId.isEmpty) {
      continue;
    }
    if (entry.eventType == 'request.started' && entry.role == 'main') {
      return requestId;
    }
    if (entry.role == 'main' && requestSpansById.containsKey(requestId)) {
      return requestId;
    }
  }
  return null;
}

String? _resolveEffectiveStreamRequestId(
  ThreadRunProjectionTimelineItem item,
  List<ThreadRunProjectionTimelineItem> timeline,
  Map<String, ThreadRunProjectionRequestSpan> requestSpansById,
) {
  final isThinkingStream =
      item.role == 'thinking' ||
      item.eventType == 'thinking.delta' ||
      item.eventType == 'thinking.final';
  final itemRequestId = item.requestId?.trim();
  final hasExplicitStreamBlockKey = _isExplicitStreamBlockItem(item);
  if (!isThinkingStream) {
    if (itemRequestId != null && itemRequestId.isNotEmpty) {
      return itemRequestId;
    }
    if (hasExplicitStreamBlockKey) {
      return _resolveNearestStreamRequestIdInUserTurn(
        item,
        timeline,
        requestSpansById,
      );
    }
    return null;
  }
  if (hasExplicitStreamBlockKey &&
      (itemRequestId == null || itemRequestId.isEmpty)) {
    final inferredRequestId = _resolveNearestStreamRequestIdInUserTurn(
      item,
      timeline,
      requestSpansById,
    );
    if (inferredRequestId != null) {
      return inferredRequestId;
    }
  }
  if (isThinkingStream) {
    final plannerRequestId = _resolveNearestPlannerRequestId(
      item,
      timeline,
      requestSpansById,
    );
    if (plannerRequestId != null) {
      return plannerRequestId;
    }
    final itemIndex = timeline.indexWhere((entry) => entry.id == item.id);
    final turnBoundaryIndex = itemIndex >= 0
        ? _resolveTurnBoundaryIndex(timeline, itemIndex)
        : -1;
    final boundaryItem = turnBoundaryIndex >= 0
        ? timeline[turnBoundaryIndex]
        : null;
    final hasUserPromptInTurn =
        boundaryItem != null && _isProjectionUserPromptItem(boundaryItem);
    if (!hasUserPromptInTurn) {
      if (itemRequestId != null &&
          itemRequestId.isNotEmpty &&
          requestSpansById.containsKey(itemRequestId)) {
        return itemRequestId;
      }
    }
    return null;
  }
  return null;
}

String? _projectionOwnerKey(ThreadRunProjectionTimelineItem item) {
  final agentId = item.agentId?.trim();
  if (agentId != null && agentId.isNotEmpty) {
    return 'agent:$agentId';
  }
  final role = item.role?.trim();
  if (role != null && role.isNotEmpty) {
    return 'role:$role';
  }
  final scope = item.scope.trim();
  return scope.isNotEmpty ? 'scope:$scope' : null;
}

String _appendStreamScopeSuffix(
  String key,
  ThreadRunProjectionTimelineItem item,
  String? effectiveRequestId, [
  List<ThreadRunProjectionTimelineItem> timeline = const [],
]) {
  final isStream =
      item.eventType == 'thinking.delta' ||
      item.eventType == 'thinking.final' ||
      item.eventType == 'message.delta' ||
      item.eventType == 'message.final';
  if (!isStream) {
    return key;
  }
  var scoped = key;
  final requestId = effectiveRequestId?.trim() ?? item.requestId?.trim();
  if (requestId != null && requestId.isNotEmpty) {
    if (!scoped.contains(':req:$requestId') &&
        !scoped.contains(':request:$requestId')) {
      scoped = '$scoped:req:$requestId';
    }
    return scoped;
  }
  final attemptId = item.runAttemptId?.trim();
  if (attemptId != null &&
      attemptId.isNotEmpty &&
      !scoped.contains(':attempt:$attemptId') &&
      !RegExp(r':attempt:[^:]+:block:').hasMatch(scoped)) {
    scoped = '$scoped:attempt:$attemptId';
  }
  final afterUser = _resolvePrecedingUserPromptSequence(item, timeline);
  return '$scoped:afterUser:$afterUser';
}

int _resolvePrecedingUserPromptSequence(
  ThreadRunProjectionTimelineItem item,
  List<ThreadRunProjectionTimelineItem> timeline,
) {
  var sequence = 0;
  for (final entry in timeline) {
    if (_compareTimelineItems(entry, item) >= 0) {
      break;
    }
    if (_isProjectionUserPromptItem(entry)) {
      sequence = entry.sequence;
    }
  }
  return sequence;
}

ThreadRunProjectionTimelineItem? _settleTerminalStreamDisplayItem(
  ThreadRunProjectionTimelineItem item,
  Map<String, ThreadRunProjectionRequestSpan> requestSpansById,
) {
  if (item.eventType != 'message.delta' && item.eventType != 'thinking.delta') {
    return item;
  }
  if (item.text.trim().isEmpty) return null;
  final requestId = item.requestId?.trim();
  final span = requestId != null ? requestSpansById[requestId] : null;
  if (span == null || _isProjectionRequestActive(span)) {
    return item;
  }
  return ThreadRunProjectionTimelineItem(
    id: item.id,
    sequence: item.sequence,
    eventType: item.eventType == 'thinking.delta'
        ? 'thinking.final'
        : 'message.final',
    scope: item.scope,
    text: item.text,
    at: item.at,
    role: item.role,
    agentId: item.agentId,
    runAttemptId: item.runAttemptId,
    requestId: item.requestId,
    streamKey: item.streamKey,
    metadata: item.metadata,
  );
}

bool _isProjectionRequestActive(ThreadRunProjectionRequestSpan span) {
  return span.status == 'waiting_first_token' || span.status == 'streaming';
}

List<ThreadRunProjectionTimelineItem> _filterCompactionTimelineForFeed(
  List<ThreadRunProjectionTimelineItem> timeline,
) {
  return timeline.where((item) {
    if (item.eventType != 'context.compaction.started') return true;
    final index = timeline.indexOf(item);
    return !timeline
        .skip(index + 1)
        .any((later) => _isProjectionContextCompactionItem(later));
  }).toList();
}

bool _isProjectionContextCompactionItem(ThreadRunProjectionTimelineItem item) {
  return item.eventType == 'context.compaction.started' ||
      item.eventType == 'context.compaction.completed' ||
      item.eventType == 'context.compaction.failed' ||
      item.eventType == 'context.compaction.suspended';
}

bool _isProjectionBashApprovalItem(ThreadRunProjectionTimelineItem item) {
  if (readBashApprovalMetadata(item.metadata) != null) return true;
  final liveType = _projectionLiveType(item);
  return liveType != null && liveType.startsWith('bash_approval.');
}

bool _isMainTimelineNoiseItem(
  ThreadRunProjectionTimelineItem item,
  List<ThreadRunProjectionTimelineItem> timeline,
) {
  if (_isProjectionUserPromptItem(item)) return true;
  if (item.eventType == 'request.completed') return true;
  if (_isProjectionBashApprovalItem(item)) return false;
  if (_isProjectionContextCompactionItem(item)) return false;
  if (_isSpuriousClarificationAnsweredItem(item)) return true;
  if (_isSupersededAskUserQuestionToolItem(item, timeline)) return true;
  if (isLegacyBashApprovalActivityText(item.text) ||
      _isProjectionInternalMessageText(item.text) ||
      isThreadFollowUpActivityMessage(item.text)) {
    return true;
  }
  final liveType = _projectionLiveType(item);
  if (liveType == 'clarification.requested' ||
      liveType == 'plan.ready' ||
      liveType == 'thread.awaiting_plan' ||
      liveType == 'thread.plan_cleared' ||
      liveType == 'plan_approval.requested') {
    return true;
  }
  if (liveType != null && _isThreadFollowUpLiveEvent(liveType)) return true;
  if (item.eventType == 'agent.started' ||
      item.eventType == 'agent.stopped' ||
      item.eventType == 'agent.abandoned' ||
      item.eventType == 'diagnostic') {
    return true;
  }
  if (item.eventType != 'thread.status') return false;
  final text = item.text.trim();
  return text.isEmpty ||
      text == '状态已更新' ||
      _isProjectionLifecycleText(text) ||
      _isProjectionUsageNoiseText(text);
}

bool _isSpuriousClarificationAnsweredItem(
  ThreadRunProjectionTimelineItem item,
) {
  if (_projectionLiveType(item) != 'clarification.answered') return false;
  final text = item.text.trim();
  return text.isEmpty || text == '状态已更新' || text.endsWith('的 MCP 表单已提交。');
}

bool _isSupersededAskUserQuestionToolItem(
  ThreadRunProjectionTimelineItem item,
  List<ThreadRunProjectionTimelineItem> timeline,
) {
  if (item.eventType != 'tool.started' && item.eventType != 'tool.completed') {
    return false;
  }
  final metadataTool = readProjectionToolMetadata(item.metadata);
  final toolUseId = metadataTool?.toolUseId?.trim();
  if (toolUseId == null ||
      toolUseId.isEmpty ||
      metadataTool?.name != 'AskUserQuestion') {
    return false;
  }
  return timeline.any((candidate) {
    if (_projectionLiveType(candidate) != 'clarification.answered') {
      return false;
    }
    if (_isSpuriousClarificationAnsweredItem(candidate)) return false;
    return readProjectionToolMetadata(candidate.metadata)?.toolUseId?.trim() ==
        toolUseId;
  });
}

ActivityFeedEntry? _projectionItemToFeedEntry(
  ThreadRunProjectionTimelineItem item, {
  required String feedId,
  String? agentRole,
  String? agentId,
  required AppLocalizations l10n,
}) {
  final text = item.text.trim();
  // A V2 api.error is a failed request with a durable retry target. Handle it
  // before the generic reconnect presentation, which is informational and
  // would otherwise hide the retry action behind a phase row.
  if (item.eventType == 'api.error') {
    final apiError = _readProjectionApiError(item);
    return ActivityFeedEntry(
      id: feedId,
      role: item.role,
      kind: ActivityFeedKind.error,
      text: apiError?.message ?? text,
      agentId: agentId,
      runAttemptId: item.runAttemptId,
      requestId: item.requestId,
      at: item.at,
      sequence: item.sequence,
    );
  }
  final reconnect = resolveReconnectPhaseDisplay(
    text: text,
    metadata: item.metadata,
    apiErrorStatusCode: _readProjectionApiError(item)?.statusCode,
    l10n: l10n,
  );
  if (reconnect != null) {
    return ActivityFeedEntry(
      id: feedId,
      role: item.role,
      kind: ActivityFeedKind.phase,
      text: reconnect.summary,
      detail: reconnect.detail,
      reconnecting: true,
      runAttemptId: item.runAttemptId,
      at: item.at,
    );
  }

  final bashApproval = readBashApprovalMetadata(item.metadata);
  if (bashApproval != null && item.scope != 'agent') {
    return _buildProjectionToolActionEntry(
      item,
      feedId: feedId,
      bashApproval: bashApproval,
      l10n: l10n,
    );
  }

  final unprojected = _readUnprojectedCodexItem(item);
  final persistedImagePath = unprojected == null
      ? null
      : _readPersistedUnprojectedImageViewPath(unprojected);
  if (persistedImagePath != null) {
    final lifecycle = unprojected!.phase == 'started'
        ? ToolActionLifecycle.running
        : ToolActionLifecycle.completed;
    return ActivityFeedEntry(
      id: feedId,
      role: item.role,
      kind: ActivityFeedKind.imageView,
      text: lifecycle == ToolActionLifecycle.running
          ? l10n.activityImageViewViewing
          : l10n.activityImageViewViewed,
      actionIcon: ActivityActionIcon.images,
      toolName: 'ViewImage',
      lifecycle: lifecycle,
      imageView: ImageViewDisplay(path: persistedImagePath, eventId: item.id),
      toolUseId: readProjectionToolMetadata(item.metadata)?.toolUseId,
      toolEventType: item.eventType,
      agentId: agentId ?? item.agentId,
      runAttemptId: item.runAttemptId,
      at: item.at,
    );
  }

  if (item.eventType == 'message.delta' || item.eventType == 'message.final') {
    if (text.isEmpty && item.eventType != 'message.delta') return null;
    if (isLegacyBashApprovalActivityText(text)) return null;
    if (parseClarificationAnswers(text) != null) {
      return ActivityFeedEntry(
        id: feedId,
        role: item.role,
        kind: ActivityFeedKind.clarificationAnswer,
        text: item.text,
        runAttemptId: item.runAttemptId,
        at: item.at,
      );
    }
    return ActivityFeedEntry(
      id: feedId,
      role: item.role,
      kind: ActivityFeedKind.assistant,
      text: item.text,
      streaming: item.eventType == 'message.delta',
      subagentRole: agentRole ?? _resolveProjectionSubagentRole(item),
      agentId: agentId,
      runAttemptId: item.runAttemptId,
      requestId: item.requestId,
      at: item.at,
      sequence: item.sequence,
    );
  }

  if (item.eventType == 'thinking.delta' ||
      item.eventType == 'thinking.final') {
    if (text.isEmpty && item.eventType == 'thinking.final') return null;
    if (isReasoningSummaryItem(item)) {
      final label = reasoningSummaryLabel(item.text);
      if (label.isEmpty) return null;
      return ActivityFeedEntry(
        id: feedId,
        role: item.role,
        kind: ActivityFeedKind.reasoningStage,
        text: label,
        streaming: true,
        agentId: agentId ?? item.agentId,
        runAttemptId: item.runAttemptId,
        requestId: item.requestId,
        at: item.at,
      );
    }
    final streaming = item.eventType == 'thinking.delta';
    final thinkingStartedAt = _readThinkingStartedAt(item.metadata);
    final thinkingDurationMs = _readThinkingDurationMs(item.metadata);
    return ActivityFeedEntry(
      id: feedId,
      role: item.role,
      kind: ActivityFeedKind.thinking,
      text: item.text,
      streaming: streaming,
      agentId: agentId ?? item.agentId,
      runAttemptId: item.runAttemptId,
      requestId: item.requestId,
      at: item.at,
      startedAt: thinkingStartedAt,
      endedAt: streaming ? null : item.at,
      durationMs: streaming ? 0 : (thinkingDurationMs ?? 0),
    );
  }

  if (item.eventType == 'tool.started' ||
      item.eventType == 'tool.completed' ||
      item.eventType == 'tool.failed') {
    return _buildProjectionToolActionEntry(item, feedId: feedId, l10n: l10n);
  }

  final phaseLabel = _resolveProjectionPhaseLabel(item, l10n);
  if (phaseLabel != null) {
    final isContextCompaction = _isProjectionContextCompactionItem(item);
    return ActivityFeedEntry(
      id: feedId,
      role: item.role,
      kind: ActivityFeedKind.phase,
      text: phaseLabel,
      actionIcon: isContextCompaction ? ActivityActionIcon.context : null,
      lifecycle: isContextCompaction ? _contextCompactionLifecycle(item) : null,
      runAttemptId: item.runAttemptId,
      at: item.at,
    );
  }

  return null;
}

ActivityFeedEntry _buildProjectionToolActionEntry(
  ThreadRunProjectionTimelineItem item, {
  required String feedId,
  ThreadRunBashApprovalMetadata? bashApproval,
  required AppLocalizations l10n,
}) {
  bashApproval ??= readBashApprovalMetadata(item.metadata);
  final tool = readProjectionToolMetadata(item.metadata);
  final toolName =
      bashApproval?.toolName ?? tool?.name ?? _resolveProjectionToolName(item);
  final description = bashApproval?.description?.trim().isNotEmpty == true
      ? bashApproval!.description!.trim()
      : (tool?.name == 'Bash' ? tool?.description?.trim() : null);
  final label = description != null && description.isNotEmpty
      ? description
      : formatStructuredToolActionLabel(
          tool ??
              ThreadRunToolMetadata(
                name: toolName,
                detail: bashApproval?.detail ?? tool?.detail,
                toolUseId: bashApproval?.toolUseId ?? tool?.toolUseId,
              ),
          bashApproval: bashApproval,
          l10n: l10n,
        );
  final lifecycle = bashApproval != null
      ? bashApprovalPhaseToLifecycle(bashApproval.phase)
      : _toolLifecycleFromProjectionItem(item, tool);
  final toolEventType = item.eventType;
  final imageView = tool?.imageView;
  if (imageView != null) {
    final imageLifecycle = lifecycle ?? ToolActionLifecycle.completed;
    return ActivityFeedEntry(
      id: feedId,
      role: item.role,
      kind: ActivityFeedKind.imageView,
      text: imageLifecycle == ToolActionLifecycle.running
          ? l10n.activityImageViewViewing
          : l10n.activityImageViewViewed,
      actionIcon: ActivityActionIcon.images,
      toolName: toolName,
      lifecycle: imageLifecycle,
      imageView: ImageViewDisplay(path: imageView.path, eventId: item.id),
      toolUseId: tool?.toolUseId ?? bashApproval?.toolUseId,
      toolEventType: toolEventType,
      agentId: item.agentId,
      runAttemptId: item.runAttemptId,
      at: item.at,
    );
  }
  final imageDisplay = tool?.imageDisplay;
  if (imageDisplay != null) {
    final imageLifecycle = lifecycle ?? ToolActionLifecycle.completed;
    return ActivityFeedEntry(
      id: feedId,
      role: item.role,
      kind: ActivityFeedKind.imageView,
      text: imageLifecycle == ToolActionLifecycle.running
          ? l10n.activityImageDisplayViewing
          : l10n.activityImageDisplayViewed,
      actionIcon: ActivityActionIcon.images,
      toolName: toolName,
      lifecycle: imageLifecycle,
      imageView: ImageViewDisplay(
        path: 'artifact:${imageDisplay.artifactId}',
        eventId: item.id,
      ),
      toolUseId: tool?.toolUseId ?? bashApproval?.toolUseId,
      toolEventType: toolEventType,
      agentId: item.agentId,
      runAttemptId: item.runAttemptId,
      at: item.at,
    );
  }
  final htmlHost = tool?.htmlHost;
  if (htmlHost != null) {
    final htmlLifecycle = lifecycle ?? ToolActionLifecycle.completed;
    final title = htmlHost.title?.trim();
    return ActivityFeedEntry(
      id: feedId,
      role: item.role,
      kind: ActivityFeedKind.action,
      text: htmlLifecycle == ToolActionLifecycle.running
          ? l10n.activityHtmlHostPublishing
          : l10n.activityHtmlHostPublished,
      detail: (title != null && title.isNotEmpty) ? title : htmlHost.publicUrl,
      actionIcon: ActivityActionIcon.browser,
      toolName: toolName,
      lifecycle: htmlLifecycle,
      toolUseId: tool?.toolUseId ?? bashApproval?.toolUseId,
      toolEventType: toolEventType,
      agentId: item.agentId,
      runAttemptId: item.runAttemptId,
      at: item.at,
    );
  }
  final command = tool?.detail?.trim() ?? bashApproval?.detail?.trim();
  final fileChange = resolveFileChangeCardDisplay(tool?.fileChange);
  final webSearch = tool == null
      ? null
      : resolveWebSearchCardDisplayFromTool(tool, l10n);
  return ActivityFeedEntry(
    id: feedId,
    role: item.role,
    kind: ActivityFeedKind.action,
    text: label,
    actionIcon: _projectionToolActionIcon(toolName, tool),
    toolName: toolName,
    readTargetPath: tool?.readTargetPath,
    readTargetLineRange: tool?.readTargetLineRange,
    lifecycle: lifecycle,
    toolUseId: bashApproval?.toolUseId ?? tool?.toolUseId,
    toolEventType: toolEventType,
    subagentRole: _resolveProjectionSubagentRole(item),
    agentId: item.agentId,
    bashRun: isCommandToolName(toolName)
        ? resolveBashRunCardDisplay(
            toolName: toolName,
            command: command,
            description: description ?? tool?.description,
            output: tool?.outputPreview,
            durationMs: tool?.durationMs,
          )
        : null,
    fileChange: fileChange,
    webSearch: webSearch,
    runAttemptId: item.runAttemptId,
    at: item.at,
    mcpDiscovery: tool?.mcpDiscovery?.kind == 'search'
        ? const ActionKindMcpDiscovery(kind: 'search')
        : null,
  );
}

class _UnprojectedCodexItem {
  const _UnprojectedCodexItem({
    required this.itemType,
    required this.phase,
    this.payload,
  });

  final String itemType;
  final String phase;
  final String? payload;
}

_UnprojectedCodexItem? _readUnprojectedCodexItem(
  ThreadRunProjectionTimelineItem item,
) {
  if (_projectionLiveType(item) != 'codex.item.unprojected') return null;
  final rawItemType = item.metadata?['itemType'];
  final itemType = rawItemType is String && rawItemType.trim().isNotEmpty
      ? rawItemType.trim()
      : item.text.replaceFirst(RegExp(r'^未知类型\s*·\s*'), '').trim();
  final payloadRaw = item.metadata?['payloadJson'];
  final payload = payloadRaw is String && payloadRaw.trim().isNotEmpty
      ? payloadRaw
      : null;
  final phaseRaw = item.metadata?['unprojectedPhase'];
  final phase = phaseRaw == 'started' ? 'started' : 'completed';
  return _UnprojectedCodexItem(
    itemType: itemType.isEmpty ? 'unknown' : itemType,
    phase: phase,
    payload: payload,
  );
}

String? _readPersistedUnprojectedImageViewPath(_UnprojectedCodexItem item) {
  if (item.itemType != 'imageView' || item.payload == null) return null;
  try {
    final decoded = jsonDecode(item.payload!);
    if (decoded is! Map) return null;
    if (decoded['type'] != 'imageView') return null;
    final path = decoded['path'];
    if (path is! String) return null;
    final trimmed = path.trim();
    return trimmed.isEmpty ? null : trimmed;
  } on FormatException {
    return null;
  }
}

ActivityActionIcon _projectionToolActionIcon(
  String toolName,
  ThreadRunToolMetadata? tool,
) {
  if (tool?.grepPattern?.isNotEmpty == true) {
    return ActivityActionIcon.search;
  }
  if (tool?.readTargetPath?.isNotEmpty == true) {
    return ActivityActionIcon.read;
  }
  if (tool?.imageDisplay != null) {
    return ActivityActionIcon.images;
  }
  if (tool?.htmlHost != null) {
    return ActivityActionIcon.browser;
  }
  if (tool?.imageView != null) {
    return ActivityActionIcon.images;
  }
  if (toolName == 'WebSearch' ||
      toolName == 'WebFetch' ||
      isEcoWebSearchToolName(toolName)) {
    return ActivityActionIcon.network;
  }
  return iconForToolName(toolName);
}

ToolActionLifecycle? _toolLifecycleFromProjectionItem(
  ThreadRunProjectionTimelineItem item,
  ThreadRunToolMetadata? tool,
) {
  if (item.eventType == 'tool.failed') return ToolActionLifecycle.failed;
  if (tool != null) return toolLifecycleFromMetadata(tool);
  if (item.eventType == 'tool.completed') return ToolActionLifecycle.completed;
  return ToolActionLifecycle.running;
}

ToolActionLifecycle _contextCompactionLifecycle(
  ThreadRunProjectionTimelineItem item,
) {
  if (item.eventType == 'context.compaction.started') {
    return ToolActionLifecycle.running;
  }
  if (item.eventType == 'context.compaction.failed' ||
      item.eventType == 'context.compaction.suspended') {
    return ToolActionLifecycle.failed;
  }
  return ToolActionLifecycle.completed;
}

String? _resolveProjectionSubagentRole(ThreadRunProjectionTimelineItem item) {
  final role = normalizeAgentDisplayRole(item.role);
  if (role == null || role == 'tool') return null;
  return role;
}

String _resolveProjectionToolName(ThreadRunProjectionTimelineItem item) {
  final tool = readProjectionToolMetadata(item.metadata);
  final name = tool?.name.trim();
  if (name != null && name.isNotEmpty) return name;
  return 'Tool';
}

String? _projectionLiveType(ThreadRunProjectionTimelineItem item) {
  final liveType = item.metadata?['liveType'];
  return liveType is String ? liveType : null;
}

bool _isThreadFollowUpLiveEvent(String liveType) {
  return liveType.startsWith('thread.follow_up.');
}

bool _isProjectionUsageNoiseText(String text) {
  return RegExp(r'^[↑↓⊙][↑↓⊙\d\s.,kKmM$%·+()-]*$').hasMatch(text);
}

bool _isProjectionLifecycleText(String text) {
  return RegExp(
    r'^Subagent\s+\S+\s+(started|stopped|abandoned)$',
    caseSensitive: false,
  ).hasMatch(text);
}

bool _isProjectionInternalMessageText(String text) {
  // Chinese literals match historical Desktop protocol payloads, not UI.
  final trimmed = text.trim();
  return isInternalActivityMessage(trimmed) ||
      trimmed.startsWith('__eco_worktree_merge__') ||
      trimmed == '等待你的回答…' ||
      trimmed == '正在继续处理…' ||
      trimmed == '回答完成。' ||
      trimmed == '执行完成。' ||
      trimmed == '执行完成，变更已写入项目目录。' ||
      trimmed == '执行完成，工作树内无相对基线的文件变更。' ||
      trimmed == '执行已结束，但无法确认文件变更。' ||
      trimmed == '计划已生成，等待确认。' ||
      trimmed == '计划已生成，请确认是否执行。' ||
      trimmed == '计划已提交，等待你确认。' ||
      trimmed == '计划已进入执行阶段。' ||
      trimmed == '计划已进入执行阶段' ||
      RegExp(r'^等待你完成 .+ 的 MCP 表单…$').hasMatch(trimmed) ||
      RegExp(r'^.+ 的 MCP 表单已提交。$').hasMatch(trimmed) ||
      RegExp(r'^ACP\s*已完成').hasMatch(trimmed) ||
      _isProjectionApprovalTransitionStatus(trimmed);
}

bool _isProjectionApprovalTransitionStatus(String text) {
  return text == '等待工具权限确认…' ||
      text == '等待工具读取确认…' ||
      text == '等待 Bash 执行确认…' ||
      text == '读取已确认，继续执行…' ||
      text == '读取已拒绝，等待 Agent 调整…' ||
      text == 'Bash 已确认，继续执行…' ||
      text == 'Bash 已拒绝，等待 Agent 调整…';
}

bool _isProjectionToolFailureDuplicateMessage(
  ThreadRunProjectionTimelineItem item,
  Set<String> failedTools,
) {
  if (item.eventType == 'tool.failed') return false;
  final text = item.text.trim();
  if (text.isEmpty) return false;
  if (text == '工具调用被拒绝') return true;
  final shortMatch = RegExp(
    r'^Permission denied for ([A-Za-z0-9_]+)$',
    caseSensitive: false,
  ).firstMatch(text);
  if (shortMatch != null &&
      failedTools.contains(shortMatch.group(1)!.toLowerCase())) {
    return true;
  }
  final fullMatch = RegExp(
    r'^Permission denied for ([A-Za-z0-9_]+):',
    caseSensitive: false,
  ).firstMatch(text);
  if (fullMatch != null &&
      failedTools.contains(fullMatch.group(1)!.toLowerCase())) {
    return true;
  }
  return false;
}

String? _resolveProjectionPhaseLabel(
  ThreadRunProjectionTimelineItem item,
  AppLocalizations l10n,
) {
  final text = item.text.trim();
  if (item.eventType == 'context.compaction.started') {
    return text.isEmpty ? l10n.activityCompressingContext : text;
  }
  if (item.eventType == 'context.compaction.completed') {
    return text.isEmpty ? l10n.activityContextCompressed : text;
  }
  if (item.eventType == 'context.compaction.failed') {
    return text.isEmpty ? l10n.activityContextCompressionFailed : text;
  }
  if (item.eventType == 'context.compaction.suspended') {
    return text.isEmpty ? l10n.activityContextCompressionPaused : text;
  }
  if (item.eventType == 'context.cache_config_drift') {
    return null;
  }
  if (item.eventType == 'context.cache_invalidated') {
    return null;
  }
  if (item.eventType == 'billing.cache_hit_dropped') {
    return text.isEmpty ? l10n.activityPromptCacheDrop : text;
  }
  if (item.eventType == 'request.retry_scheduled') {
    return text.isEmpty ? l10n.activityPreparingRetry : text;
  }
  if (item.eventType == 'request.completed') {
    return null;
  }
  if (item.eventType == 'request.failed') {
    return null;
  }
  if (item.eventType == 'request.cancelled') {
    return null;
  }
  if (item.eventType == 'diagnostic') {
    return text.isEmpty ? l10n.activityRunDiagnostics : text;
  }
  if (item.eventType == 'thread.status') {
    if (text.isEmpty || text == '状态已更新' || _isProjectionLifecycleText(text)) {
      return null;
    }
    return text;
  }
  return null;
}

class _ProjectionApiError {
  const _ProjectionApiError({
    required this.message,
    this.statusCode,
    this.code,
  });

  final String message;
  final int? statusCode;
  final String? code;
}

_ProjectionApiError? _readProjectionApiError(
  ThreadRunProjectionTimelineItem item,
) {
  final raw = item.metadata?['apiError'];
  if (raw is! Map<String, dynamic>) return null;
  final message = (raw['message'] as String?)?.trim() ?? '';
  if (message.isEmpty) return null;
  final statusCode = raw['statusCode'];
  final code = (raw['code'] as String?)?.trim();
  return _ProjectionApiError(
    message: message,
    statusCode: statusCode is int ? statusCode : null,
    code: code != null && code.isNotEmpty ? code : null,
  );
}

String? _projectionToolLifecycleKey(ThreadRunProjectionTimelineItem item) {
  final bashApproval = readBashApprovalMetadata(item.metadata);
  if (bashApproval != null) return 'lifecycle:${bashApproval.toolUseId}';
  final tool = readProjectionToolMetadata(item.metadata);
  final toolUseId = tool?.toolUseId?.trim();
  if (toolUseId != null &&
      toolUseId.isNotEmpty &&
      (item.eventType == 'tool.started' ||
          item.eventType == 'tool.completed' ||
          item.eventType == 'tool.failed')) {
    return 'lifecycle:$toolUseId';
  }
  return null;
}

String? _projectionToolDisplayKey(ThreadRunProjectionTimelineItem item) {
  if (item.eventType != 'tool.started' && item.eventType != 'tool.completed') {
    return null;
  }
  final toolUseId = readProjectionToolMetadata(
    item.metadata,
  )?.toolUseId?.trim();
  if (toolUseId == null || toolUseId.isEmpty) return null;
  return 'tool:$toolUseId';
}

String? _projectionReconnectDisplayKey(ThreadRunProjectionTimelineItem item) {
  final origin = item.metadata?['activityOrigin'];
  if (origin is String && isReconnectActivityOrigin(origin)) {
    return 'reconnect';
  }
  final liveType = _projectionLiveType(item);
  if (liveType == 'request.retry_scheduled') {
    return 'reconnect';
  }
  return isReconnectActivityMessage(item.text.trim()) ? 'reconnect' : null;
}

bool _shouldClearReconnectTimelineItem(ThreadRunProjectionTimelineItem item) {
  final origin = item.metadata?['activityOrigin'];
  if (origin is String && isReconnectActivityOrigin(origin)) {
    return false;
  }
  if (isReconnectActivityMessage(item.text.trim())) {
    return false;
  }

  if (item.eventType == 'request.completed' ||
      item.eventType == 'request.first_token') {
    return true;
  }
  if (item.eventType == 'tool.started' || item.eventType == 'tool.completed') {
    return true;
  }
  if (item.eventType == 'message.final' || item.eventType == 'thinking.final') {
    return item.text.trim().isNotEmpty;
  }
  if (item.eventType == 'message.delta' || item.eventType == 'thinking.delta') {
    return item.text.trim().isNotEmpty;
  }

  return shouldClearReconnectActivity(
    message: item.text,
    role: item.role ?? '',
  );
}

bool _isTimelineItemSupersededByRecovery(
  List<ThreadRunProjectionTimelineItem> timeline,
  ThreadRunProjectionTimelineItem anchor,
) {
  for (final later in timeline) {
    if (_compareTimelineItems(anchor, later) >= 0) {
      continue;
    }
    if (_shouldClearReconnectTimelineItem(later)) {
      return true;
    }
  }
  return false;
}

String? _projectionStreamDisplayKey(
  ThreadRunProjectionTimelineItem item,
  Map<String, ThreadRunProjectionRequestSpan> requestSpansById,
  List<ThreadRunProjectionTimelineItem> timeline,
) {
  if (!_isStreamingRequestDisplayItem(item)) return null;
  final liveType = _projectionLiveType(item);
  // Keep clarification Q&A as discrete rows (desktop used to collapse them into
  // the planner role stream and plant answers in the wrong feed slot).
  if (liveType == 'clarification.answered' ||
      liveType == 'clarification.requested' ||
      item.text.trim().startsWith('澄清回答：')) {
    return null;
  }
  final channel = _streamDisplayChannel(item);
  final requestId = _resolveEffectiveStreamRequestId(
    item,
    timeline,
    requestSpansById,
  );
  final streamKey = item.streamKey?.trim();
  final hasExplicitStreamBlockKey =
      streamKey != null && streamKey.contains(':block:');
  final hasExplicitLogicalItemKey =
      streamKey != null &&
      streamKey.isNotEmpty &&
      (item.metadata?['logicalEntityId'] == streamKey ||
          item.metadata?['itemId'] == streamKey);
  if (streamKey != null &&
      streamKey.isNotEmpty &&
      (hasExplicitStreamBlockKey || hasExplicitLogicalItemKey)) {
    return _appendStreamScopeSuffix(
      '$channel:sk:$streamKey',
      item,
      requestId,
      timeline,
    );
  }
  if (requestId != null) {
    final span = requestSpansById[requestId];
    if (span != null && !_isProjectionRequestActive(span)) {
      return _appendStreamScopeSuffix(
        '$channel:request:$requestId',
        item,
        requestId,
        timeline,
      );
    }
  }
  if (streamKey != null && streamKey.isNotEmpty) {
    return _appendStreamScopeSuffix(
      '$channel:sk:$streamKey',
      item,
      requestId,
      timeline,
    );
  }
  if (item.eventType == 'message.final' || item.eventType == 'thinking.final') {
    return _appendStreamScopeSuffix(
      '$channel:${item.id}',
      item,
      requestId,
      timeline,
    );
  }
  final ownerKey = _projectionOwnerKey(item);
  if (ownerKey != null) {
    return _appendStreamScopeSuffix(
      '$channel:$ownerKey',
      item,
      requestId,
      timeline,
    );
  }
  final requestKey = item.requestId?.trim();
  if (requestKey != null && requestKey.isNotEmpty) {
    return _appendStreamScopeSuffix(
      '$channel:request:$requestKey',
      item,
      requestId,
      timeline,
    );
  }
  return _appendStreamScopeSuffix(
    '$channel:${item.id}',
    item,
    requestId,
    timeline,
  );
}

bool _isStreamingRequestDisplayItem(ThreadRunProjectionTimelineItem item) {
  if (_projectionLiveType(item) == 'todo.updated') return false;
  if (_isProjectionBashApprovalItem(item)) return false;
  return item.eventType == 'message.delta' ||
      item.eventType == 'message.final' ||
      item.eventType == 'thinking.delta' ||
      item.eventType == 'thinking.final';
}

ToolActionLifecycle? _resolveProjectionToolLifecycle(
  ThreadRunProjectionTimelineItem item,
) {
  final bashApproval = readBashApprovalMetadata(item.metadata);
  if (bashApproval != null) {
    return bashApprovalPhaseToLifecycle(bashApproval.phase);
  }
  final tool = readProjectionToolMetadata(item.metadata);
  if (tool != null) {
    if (item.eventType == 'tool.failed') return ToolActionLifecycle.failed;
    return toolLifecycleFromMetadata(tool);
  }
  return null;
}

int _compareTimelineItems(
  ThreadRunProjectionTimelineItem left,
  ThreadRunProjectionTimelineItem right,
) {
  final atDelta = left.at.compareTo(right.at);
  if (atDelta != 0) return atDelta;
  final sequenceDelta = left.sequence.compareTo(right.sequence);
  if (sequenceDelta != 0) return sequenceDelta;
  return left.id.compareTo(right.id);
}

String? _readThinkingStartedAt(Map<String, dynamic>? metadata) {
  final value = metadata?['thinkingStartedAt'];
  if (value is! String) return null;
  final trimmed = value.trim();
  return trimmed.isEmpty ? null : trimmed;
}

int? _readThinkingDurationMs(Map<String, dynamic>? metadata) {
  final value = metadata?['thinkingDurationMs'];
  if (value is num && value.isFinite && value >= 0) {
    return value.round();
  }
  return null;
}

int _compareProjectionToolDisplayItems(
  ThreadRunProjectionTimelineItem left,
  ThreadRunProjectionTimelineItem right,
) {
  final timelineDelta = _compareTimelineItems(left, right);
  if (timelineDelta != 0) return timelineDelta;
  return _projectionToolDisplayRichness(left) -
      _projectionToolDisplayRichness(right);
}

int _projectionToolDisplayRichness(ThreadRunProjectionTimelineItem item) {
  final tool = readProjectionToolMetadata(item.metadata);
  var score = 0;
  if (tool?.detail?.trim().isNotEmpty == true) score += 1;
  if (tool?.description?.trim().isNotEmpty == true) score += 2;
  if (tool?.outputPreview?.trim().isNotEmpty == true) score += 4;
  if (tool?.durationMs != null) score += 8;
  if (tool?.fileChange != null) score += 32;
  if (item.eventType == 'tool.completed') score += 16;
  return score;
}

int _compareProjectionLifecycleDisplayItems(
  ThreadRunProjectionTimelineItem left,
  ThreadRunProjectionTimelineItem right,
) {
  final leftLifecycle = _resolveProjectionToolLifecycle(left);
  final rightLifecycle = _resolveProjectionToolLifecycle(right);
  if (leftLifecycle != null &&
      rightLifecycle != null &&
      leftLifecycle != rightLifecycle) {
    return compareToolActionLifecyclePriority(leftLifecycle, rightLifecycle);
  }
  final richness =
      _projectionToolDisplayRichness(left) -
      _projectionToolDisplayRichness(right);
  if (richness != 0) return richness;
  return _compareTimelineItems(left, right);
}
