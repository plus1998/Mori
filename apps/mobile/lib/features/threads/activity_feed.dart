import 'dart:async';
import 'dart:convert';

import 'package:adaptive_platform_ui/adaptive_platform_ui.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:image_picker/image_picker.dart';
import 'package:intl/intl.dart' show DateFormat;

import '../../core/locale/app_error_localizations.dart';
import '../../core/locale/app_localizations_ext.dart';
import '../../core/models/image_view_models.dart';
import '../../core/models/conversation_v2_projection_models.dart';
import '../../core/preferences/thinking_display_preferences.dart';
import '../../core/theme/eco_icons.dart';
import '../../core/models/thread_models.dart';
import '../../core/models/thread_runtime_config.dart';
import '../../core/theme/eco_theme.dart';
import '../../core/utils/activity_display.dart';
import '../../core/utils/feed_action_kind.dart';
import '../../core/utils/file_change.dart';
import '../../core/utils/feed_text.dart';
import '../../core/utils/agent_mission.dart';
import '../../core/utils/stream_text.dart';
import '../../core/utils/prompt_image_attachment.dart';
import '../../core/utils/subagent_projection_feed.dart';
import '../../core/utils/subagent_session_timing.dart'
    show formatSubagentDuration;
import '../../core/widgets/activity_feed_block.dart';
import '../../core/widgets/activity_feed_speak_button.dart';
import '../../core/widgets/eco_markdown.dart';
import '../../core/widgets/eco_surface_card.dart';
import '../../core/widgets/image_memory_lightbox.dart';
import '../../core/widgets/paced_stream_text.dart';
import '../../core/widgets/shimmer_text.dart';
import '../../core/theme/subagent_theme.dart';
import '../../l10n/generated/app_localizations.dart';
import 'activity_feed_scroll_coordinator.dart';
import 'projection_activity_feed.dart';
import 'thread_session_layout.dart';

/// Feed primary text shares the theme body size across all entry types.
const activityFeedBodyFontScale = 1.0;
const activityFeedLoadEarlierThreshold = 160.0;
const activityFeedLoadingIndicatorSize = 24.0;
const _scrollToBottomButtonSize = 36.0;
const _scrollToBottomButtonAlignedBottomGap = 6.0;

typedef ActivityFeedEntryCallback = void Function(ActivityFeedEntry entry);
typedef ActivityFeedToolDetailLoader =
    Future<List<ActivityFeedEntry>> Function(ActivityFeedEntry entry);
typedef ActivityFeedToolDetailPageLoader =
    Future<ActivityFeedToolDetailPage> Function(
      ActivityFeedEntry entry, {
      String? cursor,
    });
typedef ActivityFeedToolDetailPageRequest =
    Future<ActivityFeedToolDetailPage> Function({String? cursor});
typedef ActivityFeedTurnDetailLoader =
    Future<void> Function(ActivityFeedEntry entry);
typedef ActivityFeedImageViewLoader =
    Future<ImageViewReadData> Function(ActivityFeedEntry entry);
typedef ActivityFeedEarlierLoader = Future<void> Function();
typedef ActivityFeedLoadErrorCallback = void Function(Object error);
typedef ActivityFeedUserMessageEditLoader =
    Future<ThreadUserMessageEditGetResult> Function(String activityLineId);
typedef ActivityFeedUserMessageRewriteHandler =
    Future<void> Function({
      required String activityLineId,
      required String prompt,
      required List<PromptImageAttachment> attachments,
      required int expectedHistoryRevision,
    });
typedef ActivityFeedFailedRequestRetryHandler =
    Future<void> Function(ActivityFeedEntry entry);

/// One bounded page of tool detail rows.
///
/// The page loader is deliberately separate from [ActivityFeedToolDetailLoader]
/// so the V2 detail cursor stays explicit. The disclosure tile requests the
/// next bounded page only after the user asks for it.
class ActivityFeedToolDetailPage {
  const ActivityFeedToolDetailPage({
    required this.entries,
    required this.hasMore,
    this.nextCursor,
  });

  final List<ActivityFeedEntry> entries;
  final bool hasMore;
  final String? nextCursor;
}

bool shouldLoadEarlierActivityFeed({
  required double extentAfter,
  required bool hasEarlier,
  required bool loadingEarlier,
  required bool shrinkWrap,
  double threshold = activityFeedLoadEarlierThreshold,
}) {
  return !shrinkWrap &&
      hasEarlier &&
      !loadingEarlier &&
      extentAfter <= threshold;
}

TextStyle? activityFeedBodyStyle(
  BuildContext context, {
  Color? color,
  double height = 1.55,
}) {
  final base = Theme.of(context).textTheme.bodyMedium;
  return base?.copyWith(
    fontSize: (base.fontSize ?? 13) * activityFeedBodyFontScale,
    height: height,
    color: color,
  );
}

String _formatTurnDurationMs(int ms) {
  final totalSeconds = (ms ~/ 1000).clamp(0, 1 << 31);
  // Sub-second (or zero) durations omit the label — avoid "已思考 0s".
  if (totalSeconds <= 0) {
    return '';
  }
  final hours = totalSeconds ~/ 3600;
  final minutes = (totalSeconds % 3600) ~/ 60;
  final seconds = totalSeconds % 60;
  final parts = <String>[];
  if (hours > 0) {
    parts.add('${hours}h');
  }
  if (minutes > 0) {
    parts.add('${minutes}m');
  }
  if (seconds > 0 || parts.isEmpty) {
    parts.add('${seconds}s');
  }
  return parts.join(' ');
}

enum ActivityFeedKind {
  turn,
  user,
  clarificationAnswer,
  assistant,
  thinking,
  reasoningStage,
  action,
  imageView,
  actionGroup,
  phase,
  subagentMission,
  error,
}

class ActivityFeedEntry {
  const ActivityFeedEntry({
    required this.id,
    required this.kind,
    required this.text,
    this.actionIcon,
    this.toolName,
    this.readTargetPath,
    this.readTargetLineRange,
    this.subagentRole,
    this.detail,
    this.streaming = false,
    this.usageBadge,
    this.lifecycle,
    this.missionPrompt,
    this.taskName,
    this.agentId,
    this.running = false,
    this.continuation = false,
    this.turnStatus,
    this.durationMs = 0,
    this.statusText,
    this.timeline = const [],
    this.bashRun,
    this.fileChange,
    this.webSearch,
    this.imageView,
    this.mcpDiscovery,
    this.toolUseId,
    this.reconnecting = false,
    this.role,
    this.toolEventType,
    this.actionChildren = const [],
    this.attachments = const [],
    this.runAttemptId,
    this.requestId,
    this.at,
    this.startedAt,
    this.endedAt,
    this.processEntries = const [],
    this.finalOutput,
    this.rewindTarget,
    this.activityLineId,
    this.historyRevision = 0,
    this.conversationV2Detail,
    this.sequence = 0,
  });

  final String id;
  final ActivityFeedKind kind;
  final String text;
  final ActivityActionIcon? actionIcon;
  final String? toolName;

  /// Structured read/search target from the run tool metadata. Kept separate
  /// from [text] because the aggregate header must not re-render a formatted
  /// label as if it were a raw target.
  final String? readTargetPath;
  final String? readTargetLineRange;
  final String? subagentRole;
  final String? detail;
  final bool streaming;
  final String? usageBadge;
  final ToolActionLifecycle? lifecycle;
  final String? missionPrompt;
  final String? taskName;
  final String? agentId;
  final bool running;

  /// Output after a prompt inserted into an already running attempt.
  final bool continuation;
  final String? turnStatus;
  final int durationMs;
  final String? statusText;
  final List<SubagentTimelineEntry> timeline;
  final BashRunCardDisplay? bashRun;
  final FileChangeCardDisplay? fileChange;
  final WebSearchCardDisplay? webSearch;
  final ImageViewDisplay? imageView;
  final ActionKindMcpDiscovery? mcpDiscovery;
  final String? toolUseId;
  final bool reconnecting;

  /// The provider's own label for the row (`planner`, `coder`, ...), from the timeline item
  /// it came from.
  ///
  /// The Feed picks a turn's final output by this label, and the desktop Feed renders it, so
  /// a row that reaches the list without it is a row the Feed can no longer describe the same
  /// way as the desktop. A grouped or synthesized row has no single author and stays null.
  final String? role;

  /// The tool event this row reports (`tool.started` / `tool.completed` / `tool.failed`), when
  /// it reports one.
  ///
  /// [lifecycle] is the row's *display* state and covers more than tool outcomes (an approval
  /// phase, for instance), so the call's own outcome is kept as the event type — the same fact
  /// the desktop reads off the item it renders.
  final String? toolEventType;
  final List<ActivityFeedEntry> actionChildren;
  final List<PromptImageAttachment> attachments;
  final String? runAttemptId;
  final String? requestId;
  final String? at;
  final String? startedAt;
  final String? endedAt;
  final List<ActivityFeedEntry> processEntries;
  final ActivityFeedEntry? finalOutput;
  final ThreadActivityRewindTarget? rewindTarget;
  final String? activityLineId;
  final int historyRevision;

  /// Complete source row for a V2 detail item.
  ///
  /// Detail rows are rendered as ordinary thinking entries, but callers that
  /// consume or diagnose them must retain the source identity, ownership,
  /// parent links, versions, and exact nullable/empty payload values.
  final Map<String, dynamic>? conversationV2Detail;
  final int sequence;

  ActivityFeedEntry withSequence(int sequence) {
    if (this.sequence == sequence) return this;
    return ActivityFeedEntry(
      id: id,
      kind: kind,
      text: text,
      actionIcon: actionIcon,
      toolName: toolName,
      readTargetPath: readTargetPath,
      readTargetLineRange: readTargetLineRange,
      subagentRole: subagentRole,
      detail: detail,
      streaming: streaming,
      usageBadge: usageBadge,
      lifecycle: lifecycle,
      missionPrompt: missionPrompt,
      taskName: taskName,
      agentId: agentId,
      running: running,
      continuation: continuation,
      turnStatus: turnStatus,
      durationMs: durationMs,
      statusText: statusText,
      timeline: timeline,
      bashRun: bashRun,
      fileChange: fileChange,
      webSearch: webSearch,
      imageView: imageView,
      mcpDiscovery: mcpDiscovery,
      toolUseId: toolUseId,
      role: role,
      toolEventType: toolEventType,
      reconnecting: reconnecting,
      actionChildren: actionChildren,
      attachments: attachments,
      runAttemptId: runAttemptId,
      requestId: requestId,
      at: at,
      startedAt: startedAt,
      endedAt: endedAt,
      processEntries: processEntries,
      finalOutput: finalOutput,
      rewindTarget: rewindTarget,
      activityLineId: activityLineId,
      historyRevision: historyRevision,
      conversationV2Detail: conversationV2Detail,
      sequence: sequence,
    );
  }

  ActivityFeedEntry withIdAtSequence({
    required String id,
    String? at,
    required int sequence,
  }) {
    return ActivityFeedEntry(
      id: id,
      kind: kind,
      text: text,
      actionIcon: actionIcon,
      toolName: toolName,
      readTargetPath: readTargetPath,
      readTargetLineRange: readTargetLineRange,
      subagentRole: subagentRole,
      detail: detail,
      streaming: streaming,
      usageBadge: usageBadge,
      lifecycle: lifecycle,
      missionPrompt: missionPrompt,
      taskName: taskName,
      agentId: agentId,
      running: running,
      continuation: continuation,
      turnStatus: turnStatus,
      durationMs: durationMs,
      statusText: statusText,
      timeline: timeline,
      bashRun: bashRun,
      fileChange: fileChange,
      webSearch: webSearch,
      imageView: imageView,
      mcpDiscovery: mcpDiscovery,
      toolUseId: toolUseId,
      role: role,
      toolEventType: toolEventType,
      reconnecting: reconnecting,
      actionChildren: actionChildren,
      attachments: attachments,
      runAttemptId: runAttemptId,
      requestId: requestId,
      at: at ?? this.at,
      startedAt: startedAt,
      endedAt: endedAt,
      processEntries: processEntries,
      finalOutput: finalOutput,
      rewindTarget: rewindTarget,
      activityLineId: activityLineId,
      historyRevision: historyRevision,
      conversationV2Detail: conversationV2Detail,
      sequence: sequence,
    );
  }
}

bool isProjectionFeedReady(ThreadRunProjectionSnapshot? projection) {
  return projection != null && projection.sourceEventCount > 0;
}

/// Whether the session feed should show the desktop-aligned boot overlay.
///
/// Covers two projection sources:
/// - **Local load**: Conversation V2 sync until [projectionSettled]
/// - **Cloud sync**: Conversation V2 sync settles the ordered feed before
///   [projectionReady] is observed.
bool isSessionContentBooting({
  required bool hasError,
  required bool projectionReady,
  required bool projectionSettled,
  required bool projectionSynchronizing,
  required bool loading,
  required ThreadSummary? thread,
}) {
  if (hasError || projectionReady) {
    return false;
  }
  if (projectionSynchronizing) {
    return true;
  }
  if (!projectionSettled && (loading || thread != null)) {
    return true;
  }
  return false;
}

List<ActivityFeedEntry> buildActivityFeed({
  String? threadPrompt,
  String? threadId,
  ThreadRunProjectionSnapshot? runProjection,
  List<ThreadSubagentSessionTiming> subagentSessions = const [],
  AppLocalizations? l10n,
  bool groupTurns = true,
  bool groupActions = true,
  ThinkingDisplayMode thinkingDisplayMode = defaultThinkingDisplayMode,
  bool? conversationLive,
}) {
  if (!isProjectionFeedReady(runProjection)) {
    return const [];
  }
  final strings = l10n ?? lookupAppLocalizations(const Locale('zh'));
  final projected = buildProjectionActivityFeed(
    projection: runProjection!,
    threadPrompt: threadPrompt,
    threadId: threadId,
    subagentSessions: subagentSessions,
    l10n: strings,
    thinkingDisplayMode: thinkingDisplayMode,
    conversationLive: conversationLive,
  );
  final groupedActions = groupActions
      ? groupActivityFeedActionEntries(projected, l10n: strings)
      : projected;
  final groupedThinking = groupConsecutiveThinkingEntries(groupedActions);
  final groupedEphemeralTail = replaceLatestToolWithReasoningStage(
    groupedThinking,
  );
  return groupTurns
      ? groupProjectionActivityFeedTurns(groupedEphemeralTail, runProjection)
      : groupedEphemeralTail;
}

/// Chooses the Feed rows for a live thread session.
///
/// The thread prompt is only an optimistic bootstrap for an empty V2
/// projection. Once V2 has rows, replacing them with that prompt hides every
/// later turn even though the cache and projection are current.
List<ActivityFeedEntry> resolveThreadSessionDisplayFeedEntries({
  required List<ActivityFeedEntry> feedEntries,
  required String threadId,
  required String? threadPrompt,
  required bool isRunning,
}) {
  if (shouldAppendPendingAgentThinking(
    isRunning: isRunning,
    entries: feedEntries,
  )) {
    return [
      ...feedEntries,
      const ActivityFeedEntry(
        id: 'pending-agent',
        kind: ActivityFeedKind.thinking,
        text: '',
        streaming: true,
      ),
    ];
  }
  if (feedEntries.isNotEmpty) return feedEntries;

  final optimisticPrompt = threadPrompt?.trim() ?? '';
  if (optimisticPrompt.isNotEmpty || isRunning) {
    return [
      if (optimisticPrompt.isNotEmpty)
        ActivityFeedEntry(
          id: 'optimistic-user-$threadId',
          kind: ActivityFeedKind.user,
          text: optimisticPrompt,
        ),
      if (shouldAppendPendingAgentThinking(
        isRunning: isRunning,
        entries: const [],
      ))
        const ActivityFeedEntry(
          id: 'pending-agent',
          kind: ActivityFeedKind.thinking,
          text: '',
          streaming: true,
        ),
    ];
  }
  return const [];
}

/// Summary and the current tool aggregate share one temporary tail slot.
List<ActivityFeedEntry> replaceLatestToolWithReasoningStage(
  List<ActivityFeedEntry> entries,
) {
  var summaryIndex = -1;
  var toolIndex = -1;
  for (var index = entries.length - 1; index >= 0; index -= 1) {
    final entry = entries[index];
    if (summaryIndex < 0 && entry.kind == ActivityFeedKind.reasoningStage) {
      summaryIndex = index;
    }
    if (summaryIndex >= 0 && _isToolAggregateEntry(entry)) {
      if (!_hasReasoningSummaryBoundaryBetween(
        entries,
        entry,
        entries[summaryIndex],
      )) {
        toolIndex = index;
        break;
      }
    }
  }
  if (summaryIndex <= toolIndex || summaryIndex < 0 || toolIndex < 0) {
    return entries;
  }
  final summary = entries[summaryIndex];
  final tool = entries[toolIndex];
  final replacement = summary.withIdAtSequence(
    id: tool.id,
    at: tool.at,
    sequence: tool.sequence,
  );
  return [
    ...entries.take(toolIndex),
    replacement,
    ...entries.skip(toolIndex + 1).take(summaryIndex - toolIndex - 1),
    ...entries.skip(summaryIndex + 1),
  ];
}

bool _isToolAggregateEntry(ActivityFeedEntry entry) {
  return entry.kind == ActivityFeedKind.action ||
      entry.kind == ActivityFeedKind.actionGroup;
}

bool _hasReasoningSummaryBoundaryBetween(
  List<ActivityFeedEntry> entries,
  ActivityFeedEntry tool,
  ActivityFeedEntry summary,
) {
  return entries.any((entry) {
    if (entry.kind != ActivityFeedKind.assistant || entry.text.trim().isEmpty) {
      return false;
    }
    return entry.sequence > tool.sequence && entry.sequence < summary.sequence;
  });
}

List<ActivityFeedEntry> groupActivityFeedActionEntries(
  List<ActivityFeedEntry> entries, {
  AppLocalizations? l10n,
}) {
  final strings = l10n ?? lookupAppLocalizations(const Locale('zh'));
  final grouped = <ActivityFeedEntry>[];
  var pending = <ActivityFeedEntry>[];

  void flush() {
    if (pending.isNotEmpty) {
      grouped.add(_buildActionGroupEntry(pending, strings));
    }
    pending = <ActivityFeedEntry>[];
  }

  for (final entry in entries) {
    if (entry.kind == ActivityFeedKind.action) {
      pending.add(entry);
      continue;
    }
    flush();
    grouped.add(entry);
  }
  flush();
  return grouped;
}

/// Combines adjacent thinking rows into one collapsible panel.
///
/// Reasoning-stage rows stay distinct from raw thinking. Any non-thinking
/// row, agent, or run attempt change ends the current group.
List<ActivityFeedEntry> groupConsecutiveThinkingEntries(
  List<ActivityFeedEntry> entries,
) {
  final grouped = <ActivityFeedEntry>[];
  var pending = <ActivityFeedEntry>[];

  void flush() {
    if (pending.isEmpty) return;
    grouped.add(
      pending.length == 1 ? pending.first : _buildThinkingGroupEntry(pending),
    );
    pending = <ActivityFeedEntry>[];
  }

  for (final entry in entries) {
    if (entry.kind == ActivityFeedKind.thinking &&
        (pending.isEmpty || _canJoinThinkingEntries(pending.last, entry))) {
      pending.add(entry);
      continue;
    }
    flush();
    if (entry.kind == ActivityFeedKind.thinking) {
      pending.add(entry);
    } else {
      grouped.add(entry);
    }
  }
  flush();
  return grouped;
}

bool _canJoinThinkingEntries(
  ActivityFeedEntry previous,
  ActivityFeedEntry next,
) {
  return previous.kind == ActivityFeedKind.thinking &&
      next.kind == ActivityFeedKind.thinking &&
      _sameThinkingContext(previous.agentId, next.agentId) &&
      _sameThinkingContext(previous.runAttemptId, next.runAttemptId) &&
      _sameThinkingContext(previous.requestId, next.requestId);
}

bool _sameThinkingContext(String? left, String? right) {
  return (left?.trim() ?? '') == (right?.trim() ?? '');
}

ActivityFeedEntry _buildThinkingGroupEntry(List<ActivityFeedEntry> entries) {
  final first = entries.first;
  final last = entries.last;
  final streaming = entries.any((entry) => entry.streaming);
  final startedAt = entries
      .map((entry) => entry.startedAt?.trim())
      .whereType<String>()
      .firstWhere((value) => value.isNotEmpty, orElse: () => '');
  final text = entries
      .map((entry) => entry.text.trim())
      .where((value) => value.isNotEmpty)
      .join('\n\n');

  return ActivityFeedEntry(
    id: first.id,
    role: first.role,
    kind: ActivityFeedKind.thinking,
    text: text,
    streaming: streaming,
    agentId: first.agentId,
    runAttemptId: first.runAttemptId,
    requestId: first.requestId,
    // The merged row stands where its last block happened: the row reports completed
    // reasoning, so its place in the Feed is the end of the reasoning, not its beginning
    // (the desktop merges thinking rows the same way).
    at: last.at,
    startedAt: startedAt.isEmpty ? null : startedAt,
    endedAt: streaming ? null : last.endedAt,
    durationMs: entries.fold(0, (total, entry) => total + entry.durationMs),
    sequence: first.sequence,
  );
}

ActivityFeedEntry _buildActionGroupEntry(
  List<ActivityFeedEntry> entries,
  AppLocalizations l10n,
) {
  final first = entries.first;
  final summary = _summarizeActionEntries(entries, l10n);
  return ActivityFeedEntry(
    id: 'action-group:${first.id}',
    kind: ActivityFeedKind.actionGroup,
    text: summary.label,
    actionIcon: summary.icon,
    lifecycle: _resolveActionGroupLifecycle(entries),
    actionChildren: List<ActivityFeedEntry>.unmodifiable(entries),
    runAttemptId: _sharedRunAttemptId(entries),
    at: first.at,
    sequence: first.sequence,
  );
}

String? _sharedRunAttemptId(List<ActivityFeedEntry> entries) {
  final ids = entries
      .map((entry) => entry.runAttemptId?.trim())
      .whereType<String>()
      .where((id) => id.isNotEmpty)
      .toSet();
  return ids.length == 1 ? ids.single : null;
}

/// Prefer human-readable bash title over the raw command for collapsed
/// action-group summaries (especially while a command is still running).
///
/// Never returns the tool's own generic verb label (e.g. `读取了文件`): the
/// aggregate header prepends the verb again, so feeding the finished label
/// back as a target renders `读取了 读取了文件`. Kept in sync with the desktop
/// `actionBlockTargetKey` guard.
String _actionSummaryTarget(ActivityFeedEntry entry, AppLocalizations l10n) {
  final webSearch = entry.webSearch;
  if (webSearch != null && webSearch.query.trim().isNotEmpty) {
    return webSearch.query.trim();
  }
  final bashRun = entry.bashRun;
  if (bashRun != null) {
    final title = bashRun.title.trim();
    if (title.isNotEmpty && title != 'Shell') return title;
    final command = bashRun.command?.trim() ?? '';
    if (command.isNotEmpty) return command;
  }
  final filePath = entry.readTargetPath?.trim();
  if (filePath != null && filePath.isNotEmpty) {
    final name = pathBasename(filePath);
    final range = entry.readTargetLineRange?.trim();
    return range == null || range.isEmpty ? name : '$name $range';
  }
  final toolName = entry.toolName?.trim() ?? '';
  final text = entry.text.trim();
  if (isCommandToolName(toolName) &&
      text.isNotEmpty &&
      text.toLowerCase() != toolName.toLowerCase() &&
      text != 'Shell' &&
      !_isGenericToolLabel(toolName, text, l10n)) {
    return text;
  }
  final path = entry.fileChange?.path.trim();
  if (path != null && path.isNotEmpty) return path;
  return _isGenericToolLabel(toolName, text, l10n) ? '' : text;
}

bool _isGenericToolLabel(String toolName, String text, AppLocalizations l10n) {
  if (toolName.isEmpty || text.isEmpty) return false;
  return formatToolDisplayLabel(toolName, null, l10n) == text;
}

ActionKindPayload _payloadFromEntry(ActivityFeedEntry entry) {
  final fileChange = entry.fileChange;
  final readTargetPath = entry.readTargetPath?.trim();
  final readTargetLineRange = entry.readTargetLineRange?.trim();
  final webSearch = entry.webSearch;
  final imageView = entry.imageView;
  final bashRun = entry.bashRun;
  return ActionKindPayload(
    fileChange: fileChange == null
        ? null
        : ActionKindFileChange(
            path: fileChange.path,
            fileName: fileChange.fileName,
          ),
    readTarget: readTargetPath == null || readTargetPath.isEmpty
        ? null
        : ActionKindReadTarget(
            filePath: readTargetPath,
            fileName: pathBasename(readTargetPath),
            lineRange:
                readTargetLineRange == null || readTargetLineRange.isEmpty
                ? null
                : readTargetLineRange,
          ),
    webSearch: webSearch == null
        ? null
        : ActionKindWebSearch(
            mode: webSearch.kind == 'fetch' ? 'fetch' : 'search',
            query: webSearch.query,
            url: webSearch.url,
          ),
    imageView: imageView == null
        ? null
        : ActionKindImageView(path: imageView.path),
    bashRun: bashRun == null
        ? null
        : ActionKindBashRun(command: bashRun.command),
    mcpDiscovery: entry.mcpDiscovery,
  );
}

String? _toolNameForActionIcon(ActivityActionIcon? icon) {
  return switch (icon) {
    ActivityActionIcon.search => 'Grep',
    ActivityActionIcon.read => 'Read',
    ActivityActionIcon.file => 'Read',
    ActivityActionIcon.edit => 'Edit',
    ActivityActionIcon.terminal => 'Bash',
    ActivityActionIcon.agent => 'Agent',
    ActivityActionIcon.network => 'WebSearch',
    ActivityActionIcon.image => 'ViewImage',
    ActivityActionIcon.images => 'ViewImage',
    ActivityActionIcon.browser => 'mcp__eco_agent_browser__browser',
    ActivityActionIcon.computer => 'mcp__eco_computer_use__click',
    ActivityActionIcon.tool || ActivityActionIcon.context || null => null,
  };
}

ResolvedAction _resolveFeedEntryAction(ActivityFeedEntry entry) {
  final toolName = entry.toolName?.trim() ?? '';
  final payload = _payloadFromEntry(entry);
  if (toolName.isNotEmpty) {
    return resolveActionKind(toolName: toolName, payload: payload);
  }
  final fromPayload = resolveActionKind(payload: payload);
  if (fromPayload.kind != ActionKind.tool) {
    return fromPayload;
  }
  return resolveActionKind(
    toolName: _toolNameForActionIcon(entry.actionIcon),
    payload: payload,
  );
}

String _formatFeedActionLine(
  ActivityFeedEntry entry,
  ActionLinePhase phase,
  AppLocalizations l10n,
) {
  return formatActionLine(
    resolved: _resolveFeedEntryAction(entry),
    phase: phase,
    rawTarget: _actionSummaryTarget(entry, l10n),
    payload: _payloadFromEntry(entry),
    l10n: l10n,
  );
}

({String label, ActivityActionIcon icon})? _summarizeSingleCommandGroupHeader(
  ActivityFeedEntry entry,
  ActionLinePhase phase,
  AppLocalizations l10n,
) {
  final resolved = _resolveFeedEntryAction(entry);
  if (resolved.kind != ActionKind.command) {
    return null;
  }
  return (
    label: phase == ActionLinePhase.done
        ? l10n.activityRanCommand
        : l10n.activityRunningCommand(''),
    icon: resolved.icon,
  );
}

({String label, ActivityActionIcon icon}) _summarizeActionLine(
  ActivityFeedEntry entry,
  ActionLinePhase phase,
  AppLocalizations l10n,
) {
  final resolved = _resolveFeedEntryAction(entry);
  return (
    label: formatActionLine(
      resolved: resolved,
      phase: phase,
      rawTarget: _actionSummaryTarget(entry, l10n),
      payload: _payloadFromEntry(entry),
      l10n: l10n,
    ),
    icon: resolved.icon,
  );
}

({String label, ActivityActionIcon icon}) _summarizeActionEntries(
  List<ActivityFeedEntry> entries,
  AppLocalizations l10n,
) {
  // Every group child is one tool call. A group holding a single tool call keeps that
  // tool's own failure copy; a group that aggregates several calls has to summarize all
  // of them, otherwise one failed tool retitles the aggregate and hides every action
  // next to it. Kept in sync with the desktop `summarizeActionBlocks`.
  if (entries.length == 1) {
    final only = entries.single;
    if (only.lifecycle == ToolActionLifecycle.failed) {
      return _summarizeSingleCommandGroupHeader(
            only,
            ActionLinePhase.done,
            l10n,
          ) ??
          _summarizeActionLine(only, ActionLinePhase.done, l10n);
    }
  }
  for (final entry in entries.reversed) {
    if (entry.lifecycle == ToolActionLifecycle.running) {
      return _summarizeActionLine(entry, ActionLinePhase.running, l10n);
    }
  }
  if (entries.length == 1) {
    return _summarizeSingleCommandGroupHeader(
          entries.single,
          ActionLinePhase.done,
          l10n,
        ) ??
        _summarizeActionLine(entries.single, ActionLinePhase.done, l10n);
  }

  final fileBucketKeys = <ActionGroupBucket, Set<String>>{};
  final items = <ResolvedAction>[];
  for (final entry in entries) {
    final action = _resolveFeedEntryAction(entry);
    if (action.bucket == ActionGroupBucket.readFiles ||
        action.bucket == ActionGroupBucket.writtenFiles ||
        action.bucket == ActionGroupBucket.editedFiles) {
      final key = entry.fileChange?.path.trim().isNotEmpty == true
          ? entry.fileChange!.path.trim()
          : _actionSummaryTarget(entry, l10n);
      final seen = fileBucketKeys.putIfAbsent(action.bucket, () => <String>{});
      if (!seen.add(key)) continue;
    }
    items.add(action);
  }
  return summarizeActionGroup(items, l10n);
}

String _formatActionChildLabel(ActivityFeedEntry entry, AppLocalizations l10n) {
  return _formatFeedActionLine(entry, ActionLinePhase.done, l10n);
}

ToolActionLifecycle? _resolveActionGroupLifecycle(
  List<ActivityFeedEntry> entries,
) {
  final lifecycles = entries
      .map((entry) => entry.lifecycle)
      .whereType<ToolActionLifecycle>()
      .toSet();
  if (lifecycles.contains(ToolActionLifecycle.failed)) {
    return ToolActionLifecycle.failed;
  }
  if (lifecycles.contains(ToolActionLifecycle.running)) {
    return ToolActionLifecycle.running;
  }
  if (lifecycles.contains(ToolActionLifecycle.approvalPending)) {
    return ToolActionLifecycle.approvalPending;
  }
  if (lifecycles.contains(ToolActionLifecycle.approvalRejected)) {
    return ToolActionLifecycle.approvalRejected;
  }
  if (lifecycles.contains(ToolActionLifecycle.approvalApproved)) {
    return ToolActionLifecycle.approvalApproved;
  }
  return lifecycles.isNotEmpty ? ToolActionLifecycle.completed : null;
}

bool shouldAutoScrollActivityFeed({
  required List<ActivityFeedEntry> previous,
  required List<ActivityFeedEntry> next,
}) {
  if (next.length <= previous.length) return false;
  final previousIds = {for (final entry in previous) entry.id};
  final added = next.where((entry) => !previousIds.contains(entry.id)).toList();
  if (added.isEmpty) return false;
  if (added.any(
    (entry) =>
        entry.kind == ActivityFeedKind.action ||
        entry.kind == ActivityFeedKind.imageView ||
        entry.kind == ActivityFeedKind.actionGroup ||
        entry.kind == ActivityFeedKind.subagentMission ||
        entry.kind == ActivityFeedKind.phase,
  )) {
    return false;
  }
  final firstNewIndex = next.indexWhere(
    (entry) => !previousIds.contains(entry.id),
  );
  return firstNewIndex >= previous.length;
}

bool shouldFollowStreamingTail({
  required List<ActivityFeedEntry> previous,
  required List<ActivityFeedEntry> next,
}) {
  if (next.isEmpty) return false;
  final last = _liveFeedTail(next);
  if (!_isLiveThinkingStatus(last)) return false;
  if (previous.isEmpty) return true;
  final previousLast = _liveFeedTail(previous);
  if (previousLast.id != last.id) return false;
  return last.text.length > previousLast.text.length;
}

bool shouldAppendPendingAgentThinking({
  required bool isRunning,
  required List<ActivityFeedEntry> entries,
}) {
  if (!isRunning) return false;
  if (entries.any(_containsRunningContextCompaction)) return false;
  if (entries.any(_containsRunningTool)) return false;
  return !entries.any(_containsLiveThinkingStatus);
}

ActivityFeedEntry _liveFeedTail(List<ActivityFeedEntry> entries) {
  final last = entries.last;
  if (last.kind == ActivityFeedKind.turn && last.processEntries.isNotEmpty) {
    return last.processEntries.last;
  }
  return last;
}

bool _isLiveThinkingStatus(ActivityFeedEntry entry) {
  if (entry.kind == ActivityFeedKind.reasoningStage) {
    return true;
  }
  return (entry.kind == ActivityFeedKind.assistant ||
          entry.kind == ActivityFeedKind.thinking) &&
      entry.streaming;
}

/// 逐字效果只跟随 feed 中最后一个仍在流式输出的条目（按展示顺序，含
/// turn 内的 processEntries / finalOutput）。
///
/// 更早的流式条目（例如思考块）应全量展示：否则会出现“后面的内容已经
/// 出完、前面的思考还在逐字追赶”的乱序感；重新进入页面时也不应重放。
String? resolveFeedPaceTargetId(List<ActivityFeedEntry> entries) {
  String? targetId;
  for (final entry in entries) {
    final id = _lastStreamingPaceEntryId(entry);
    if (id != null) targetId = id;
  }
  return targetId;
}

String? _lastStreamingPaceEntryId(ActivityFeedEntry entry) {
  String? id;
  if (entry.streaming &&
      entry.text.trim().isNotEmpty &&
      (entry.kind == ActivityFeedKind.assistant ||
          entry.kind == ActivityFeedKind.thinking)) {
    id = entry.id;
  }
  for (final child in entry.processEntries) {
    final childId = _lastStreamingPaceEntryId(child);
    if (childId != null) id = childId;
  }
  for (final child in entry.actionChildren) {
    final childId = _lastStreamingPaceEntryId(child);
    if (childId != null) id = childId;
  }
  final finalOutput = entry.finalOutput;
  if (finalOutput != null) {
    final outputId = _lastStreamingPaceEntryId(finalOutput);
    if (outputId != null) id = outputId;
  }
  return id;
}

bool _containsLiveThinkingStatus(ActivityFeedEntry entry) {
  if (_isLiveThinkingStatus(entry)) {
    return true;
  }
  if (entry.processEntries.any(_containsLiveThinkingStatus)) {
    return true;
  }
  if (entry.actionChildren.any(_containsLiveThinkingStatus)) {
    return true;
  }
  final finalOutput = entry.finalOutput;
  return finalOutput != null && _containsLiveThinkingStatus(finalOutput);
}

bool _containsRunningContextCompaction(ActivityFeedEntry entry) {
  if (entry.actionIcon == ActivityActionIcon.context &&
      entry.lifecycle == ToolActionLifecycle.running) {
    return true;
  }
  if (entry.processEntries.any(_containsRunningContextCompaction)) {
    return true;
  }
  if (entry.actionChildren.any(_containsRunningContextCompaction)) {
    return true;
  }
  final finalOutput = entry.finalOutput;
  return finalOutput != null && _containsRunningContextCompaction(finalOutput);
}

bool _containsRunningTool(ActivityFeedEntry entry) {
  if ((entry.kind == ActivityFeedKind.action ||
          entry.kind == ActivityFeedKind.actionGroup) &&
      entry.lifecycle == ToolActionLifecycle.running) {
    return true;
  }
  if (entry.processEntries.any(_containsRunningTool)) {
    return true;
  }
  if (entry.actionChildren.any(_containsRunningTool)) {
    return true;
  }
  final finalOutput = entry.finalOutput;
  return finalOutput != null && _containsRunningTool(finalOutput);
}

String activityFeedLayoutSignature(List<ActivityFeedEntry> entries) {
  if (entries.isEmpty) return '';
  final last = entries.last;
  return '${entries.length}:${_activityFeedEntrySignature(last)}';
}

bool activityFeedContentChanged({
  required List<ActivityFeedEntry> previous,
  required List<ActivityFeedEntry> next,
}) {
  if (previous.length != next.length) return true;
  for (var index = 0; index < previous.length; index += 1) {
    final before = previous[index];
    final after = next[index];
    if (before.id != after.id) return true;
    if (_activityFeedEntrySignature(before) !=
        _activityFeedEntrySignature(after)) {
      return true;
    }
  }
  return false;
}

String _activityFeedEntrySignature(ActivityFeedEntry entry) {
  final childSignature = entry.actionChildren
      .map((child) => '${child.id}:${child.text.length}:${child.lifecycle}')
      .join(',');
  final processSignature = entry.processEntries
      .map((child) => '${child.id}:${child.text.length}:${child.streaming}')
      .join(',');
  return [
    entry.id,
    entry.kind,
    entry.text.length,
    entry.streaming,
    entry.lifecycle,
    entry.actionChildren.length,
    childSignature,
    entry.running,
    entry.durationMs,
    processSignature,
    entry.finalOutput?.id ?? '',
    entry.finalOutput?.text.length ?? 0,
    entry.imageView?.path ?? '',
  ].join(':');
}

List<ActivityFeedEntry> listMiddleInsertedFeedEntries({
  required List<ActivityFeedEntry> previous,
  required List<ActivityFeedEntry> next,
}) {
  if (next.length <= previous.length) return const [];
  var prefix = 0;
  while (prefix < previous.length &&
      prefix < next.length &&
      previous[prefix].id == next[prefix].id) {
    prefix += 1;
  }
  if (prefix >= previous.length) {
    return const [];
  }
  final previousIds = {for (final entry in previous) entry.id};
  final inserted = <ActivityFeedEntry>[];
  for (var index = prefix; index < next.length; index += 1) {
    final entry = next[index];
    if (!previousIds.contains(entry.id)) {
      inserted.add(entry);
    } else {
      break;
    }
  }
  return inserted;
}

class _FeedStoppingScope extends InheritedWidget {
  const _FeedStoppingScope({required this.stopping, required super.child});

  final bool stopping;

  static bool of(BuildContext context) {
    return context
            .dependOnInheritedWidgetOfExactType<_FeedStoppingScope>()
            ?.stopping ??
        false;
  }

  @override
  bool updateShouldNotify(_FeedStoppingScope oldWidget) {
    return stopping != oldWidget.stopping;
  }
}

class ActivityFeedList extends StatefulWidget {
  const ActivityFeedList({
    super.key,
    required this.entries,
    required this.scrollController,
    this.scrollCoordinator,
    this.themeSource,
    this.onOpenAgentDetail,
    this.loadToolDetail,
    this.loadToolDetailPage,
    this.loadTurnDetail,
    this.loadImageView,
    this.onOpenImageDisplayArtifact,
    this.onLoadUserMessageEdit,
    this.onRewriteUserMessage,
    this.onRetryFailedRequest,
    this.hasEarlier = false,
    this.onLoadEarlier,
    this.onLoadEarlierError,
    this.expandUserPrompts = false,
    this.thinkingDefaultExpanded = false,
    this.shrinkWrap = false,
    this.showScrollJumpButton = true,
    this.scrollJumpBottomInset = 0,
    this.stopping = false,
    this.showMessageCopyAndTime = true,
    this.padding,
  });

  final List<ActivityFeedEntry> entries;
  final ScrollController scrollController;
  final ActivityFeedScrollCoordinator? scrollCoordinator;
  final SubagentThemeSource? themeSource;
  final ActivityFeedEntryCallback? onOpenAgentDetail;
  final ActivityFeedToolDetailLoader? loadToolDetail;
  final ActivityFeedToolDetailPageLoader? loadToolDetailPage;
  final ActivityFeedTurnDetailLoader? loadTurnDetail;
  final ActivityFeedImageViewLoader? loadImageView;
  final ValueChanged<String>? onOpenImageDisplayArtifact;
  final ActivityFeedUserMessageEditLoader? onLoadUserMessageEdit;
  final ActivityFeedUserMessageRewriteHandler? onRewriteUserMessage;
  final ActivityFeedFailedRequestRetryHandler? onRetryFailedRequest;
  final bool hasEarlier;
  final ActivityFeedEarlierLoader? onLoadEarlier;
  final ActivityFeedLoadErrorCallback? onLoadEarlierError;
  final bool expandUserPrompts;
  final bool thinkingDefaultExpanded;
  final bool shrinkWrap;
  final bool showScrollJumpButton;
  final double scrollJumpBottomInset;
  final bool stopping;

  /// Copy/time (and speak) under messages — only after the conversation stopped.
  final bool showMessageCopyAndTime;
  final EdgeInsetsGeometry? padding;

  @override
  State<ActivityFeedList> createState() => _ActivityFeedListState();
}

class _ActivityFeedListState extends State<ActivityFeedList> {
  late ActivityFeedScrollCoordinator _coordinator;
  String _layoutSignature = '';
  bool _showScrollJump = false;
  bool _loadingEarlier = false;
  bool _loadEarlierFailed = false;

  @override
  void initState() {
    super.initState();
    _coordinator =
        widget.scrollCoordinator ??
        ActivityFeedScrollCoordinator(widget.scrollController);
    _layoutSignature = activityFeedLayoutSignature(widget.entries);
    WidgetsBinding.instance.addPostFrameCallback((_) => _maybeLoadEarlier());
  }

  @override
  void didUpdateWidget(ActivityFeedList oldWidget) {
    super.didUpdateWidget(oldWidget);
    final nextSignature = activityFeedLayoutSignature(widget.entries);
    if (nextSignature != _layoutSignature) {
      _layoutSignature = nextSignature;
      _scheduleLayoutScroll();
    }
    if (nextSignature != activityFeedLayoutSignature(oldWidget.entries) ||
        (!oldWidget.hasEarlier && widget.hasEarlier)) {
      WidgetsBinding.instance.addPostFrameCallback((_) => _maybeLoadEarlier());
    }
  }

  void _scheduleLayoutScroll() {
    if (widget.shrinkWrap) return;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      _coordinator.scrollToEnd();
      _syncScrollJumpVisibility();
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!mounted) return;
        _coordinator.scrollToEnd();
        _syncScrollJumpVisibility();
      });
    });
  }

  void _syncScrollJumpVisibility() {
    final next = _coordinator.userDetachedFromBottom;
    if (next != _showScrollJump) {
      setState(() => _showScrollJump = next);
    }
  }

  Future<void> _maybeLoadEarlier({bool userInitiated = false}) async {
    if (!mounted || !widget.scrollController.hasClients) return;
    if (_loadEarlierFailed && !userInitiated) return;
    if (userInitiated) {
      _loadEarlierFailed = false;
    }
    if (widget.onLoadEarlier == null ||
        !shouldLoadEarlierActivityFeed(
          extentAfter: widget.scrollController.position.extentAfter,
          hasEarlier: widget.hasEarlier,
          loadingEarlier: _loadingEarlier,
          shrinkWrap: widget.shrinkWrap,
        )) {
      return;
    }
    setState(() => _loadingEarlier = true);
    var failed = false;
    try {
      await widget.onLoadEarlier!();
    } catch (error) {
      failed = true;
      _loadEarlierFailed = true;
      widget.onLoadEarlierError?.call(error);
    } finally {
      if (mounted) {
        setState(() => _loadingEarlier = false);
      }
    }
    if (!failed && mounted) {
      WidgetsBinding.instance.addPostFrameCallback((_) => _maybeLoadEarlier());
    }
  }

  @override
  Widget build(BuildContext context) {
    final displayEntries = widget.entries.reversed.toList(growable: false);
    final finalMetaId = widget.showMessageCopyAndTime
        ? _resolveFinalTurnMetaId(widget.entries)
        : null;
    final paceTargetId = resolveFeedPaceTargetId(widget.entries);

    return _FeedStoppingScope(
      stopping: widget.stopping,
      child: Stack(
        clipBehavior: Clip.hardEdge,
        children: [
          GestureDetector(
            onTap: () => FocusManager.instance.primaryFocus?.unfocus(),
            behavior: HitTestBehavior.translucent,
            child: NotificationListener<ScrollNotification>(
              onNotification: (notification) {
                _coordinator.onScrollNotification(notification);
                _syncScrollJumpVisibility();
                unawaited(
                  _maybeLoadEarlier(
                    userInitiated:
                        notification is ScrollUpdateNotification &&
                        notification.dragDetails != null,
                  ),
                );
                return false;
              },
              child: ListView.builder(
                controller: widget.scrollController,
                reverse: true,
                shrinkWrap: widget.shrinkWrap,
                primary: widget.shrinkWrap ? false : null,
                keyboardDismissBehavior:
                    ScrollViewKeyboardDismissBehavior.onDrag,
                padding:
                    widget.padding ??
                    const EdgeInsets.fromLTRB(
                      threadSessionFeedHorizontalPadding,
                      threadSessionComposerGap,
                      threadSessionFeedHorizontalPadding,
                      0,
                    ),
                itemCount: displayEntries.length + (_loadingEarlier ? 1 : 0),
                itemBuilder: (context, index) {
                  if (index == displayEntries.length) {
                    return const SizedBox(
                      height: 44,
                      child: Center(
                        child: SizedBox.square(
                          dimension: activityFeedLoadingIndicatorSize,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        ),
                      ),
                    );
                  }
                  final entry = displayEntries[index];
                  return _ActivityFeedEntryTile(
                    key: ValueKey(entry.id),
                    entry: entry,
                    themeSource: widget.themeSource,
                    onOpenAgentDetail: widget.onOpenAgentDetail,
                    loadToolDetail: widget.loadToolDetail,
                    loadToolDetailPage: widget.loadToolDetailPage,
                    loadTurnDetail: widget.loadTurnDetail,
                    loadImageView: widget.loadImageView,
                    onOpenImageDisplayArtifact:
                        widget.onOpenImageDisplayArtifact,
                    onLoadUserMessageEdit: widget.onLoadUserMessageEdit,
                    onRewriteUserMessage: widget.onRewriteUserMessage,
                    onRetryFailedRequest: widget.onRetryFailedRequest,
                    expandUserPrompts: widget.expandUserPrompts,
                    thinkingDefaultExpanded: widget.thinkingDefaultExpanded,
                    finalMetaEntryId: finalMetaId,
                    paceTargetEntryId: paceTargetId,
                    showMessageCopyAndTime: widget.showMessageCopyAndTime,
                  );
                },
              ),
            ),
          ),
          if (widget.showScrollJumpButton && _showScrollJump)
            Positioned(
              left: 12,
              bottom:
                  _scrollToBottomButtonAlignedBottomGap +
                  widget.scrollJumpBottomInset,
              child: _ScrollToBottomButton(
                onPressed: () {
                  _coordinator.forceScrollToEnd();
                  setState(() => _showScrollJump = false);
                },
              ),
            ),
        ],
      ),
    );
  }
}

class _ScrollToBottomButton extends StatelessWidget {
  const _ScrollToBottomButton({required this.onPressed});

  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    final colors = ecoColors(context);
    final buttonChild = Semantics(
      button: true,
      label: context.l10n.threadBackToBottom,
      child: SizedBox(
        width: _scrollToBottomButtonSize,
        height: _scrollToBottomButtonSize,
        child: Icon(
          Icons.arrow_downward_rounded,
          size: 18,
          color: colors.textPrimary,
        ),
      ),
    );

    if (PlatformInfo.isIOS) {
      return Tooltip(
        message: context.l10n.threadBackToBottom,
        child: AdaptiveButton.child(
          onPressed: onPressed,
          style: AdaptiveButtonStyle.glass,
          size: AdaptiveButtonSize.medium,
          minSize: const Size(
            _scrollToBottomButtonSize,
            _scrollToBottomButtonSize,
          ),
          enabled: true,
          useSmoothRectangleBorder: false,
          child: buttonChild,
        ),
      );
    }

    return Material(
      color: colors.cardSurface.withValues(alpha: 0.92),
      elevation: 2,
      shadowColor: Colors.black26,
      borderRadius: BorderRadius.circular(20),
      child: InkWell(
        onTap: onPressed,
        borderRadius: BorderRadius.circular(20),
        child: Tooltip(
          message: context.l10n.threadBackToBottom,
          child: buttonChild,
        ),
      ),
    );
  }
}

/// 只给最后一个已完成回合的最终输出加 meta（复制 + 时间），与桌面端一致。
/// 调用方应在会话仍在进行时传入 `showMessageCopyAndTime: false`，避免 meta 插入抖动。
String? _resolveFinalTurnMetaId(List<ActivityFeedEntry> entries) {
  String? metaId;
  for (final entry in entries) {
    if (entry.kind != ActivityFeedKind.turn) continue;
    final output = entry.finalOutput;
    if (output == null || output.text.trim().isEmpty) continue;
    metaId = output.id;
  }
  return metaId;
}

class _ActivityFeedEntryTile extends StatelessWidget {
  const _ActivityFeedEntryTile({
    super.key,
    required this.entry,
    this.themeSource,
    this.onOpenAgentDetail,
    this.loadToolDetail,
    this.loadToolDetailPage,
    this.loadTurnDetail,
    this.loadImageView,
    this.onOpenImageDisplayArtifact,
    this.onLoadUserMessageEdit,
    this.onRewriteUserMessage,
    this.onRetryFailedRequest,
    this.expandUserPrompts = false,
    this.thinkingDefaultExpanded = false,
    this.finalMetaEntryId,
    this.paceTargetEntryId,
    this.hideMessageActions = false,
    this.showMessageCopyAndTime = true,
  });

  final ActivityFeedEntry entry;
  final SubagentThemeSource? themeSource;
  final ActivityFeedEntryCallback? onOpenAgentDetail;
  final ActivityFeedToolDetailLoader? loadToolDetail;
  final ActivityFeedToolDetailPageLoader? loadToolDetailPage;
  final ActivityFeedTurnDetailLoader? loadTurnDetail;
  final ActivityFeedImageViewLoader? loadImageView;
  final ValueChanged<String>? onOpenImageDisplayArtifact;
  final ActivityFeedUserMessageEditLoader? onLoadUserMessageEdit;
  final ActivityFeedUserMessageRewriteHandler? onRewriteUserMessage;
  final ActivityFeedFailedRequestRetryHandler? onRetryFailedRequest;
  final bool expandUserPrompts;
  final bool thinkingDefaultExpanded;
  final String? finalMetaEntryId;
  final String? paceTargetEntryId;
  final bool hideMessageActions;
  final bool showMessageCopyAndTime;

  @override
  Widget build(BuildContext context) {
    switch (entry.kind) {
      case ActivityFeedKind.turn:
        return _TurnFeedTile(
          entry: entry,
          themeSource: themeSource,
          onOpenAgentDetail: onOpenAgentDetail,
          loadToolDetail: loadToolDetail,
          loadToolDetailPage: loadToolDetailPage,
          loadTurnDetail: loadTurnDetail,
          loadImageView: loadImageView,
          onOpenImageDisplayArtifact: onOpenImageDisplayArtifact,
          thinkingDefaultExpanded: thinkingDefaultExpanded,
          showFinalMeta:
              showMessageCopyAndTime &&
              entry.finalOutput?.id == finalMetaEntryId,
          showMessageCopyAndTime: showMessageCopyAndTime,
          paceTargetEntryId: paceTargetEntryId,
          onRetryFailedRequest: onRetryFailedRequest,
        );
      case ActivityFeedKind.user:
        return _UserPromptTile(
          text: entry.text,
          attachments: entry.attachments,
          rewindTarget: entry.rewindTarget,
          historyRevision: entry.historyRevision,
          onLoadUserMessageEdit: onLoadUserMessageEdit,
          onRewriteUserMessage: onRewriteUserMessage,
          initiallyExpanded: expandUserPrompts,
        );
      case ActivityFeedKind.clarificationAnswer:
        return _ClarificationAnswerTile(text: entry.text);
      case ActivityFeedKind.assistant:
        return _AssistantNarrativeTile(
          entryId: entry.id,
          text: entry.text,
          streaming: entry.streaming,
          pacing: entry.id == paceTargetEntryId,
          usageBadge: entry.usageBadge,
          hideMessageActions: hideMessageActions || !showMessageCopyAndTime,
        );
      case ActivityFeedKind.thinking:
        return _ThinkingTile(
          text: entry.text,
          streaming: entry.streaming,
          pacing: entry.id == paceTargetEntryId,
          startedAt: entry.startedAt,
          endedAt: entry.endedAt,
          durationMs: entry.durationMs,
          defaultExpanded: thinkingDefaultExpanded,
        );
      case ActivityFeedKind.reasoningStage:
        return _WaitingThinkingLine(label: entry.text);
      case ActivityFeedKind.action:
        return _ActionTile(
          label: entry.text,
          icon: entry.actionIcon ?? ActivityActionIcon.file,
          lifecycle: entry.lifecycle,
          bashRun: entry.bashRun,
          fileChange: entry.fileChange,
          webSearch: entry.webSearch,
          toolUseId: entry.toolUseId,
          loadToolDetail: loadToolDetail != null
              ? () => loadToolDetail!(entry)
              : null,
          loadToolDetailPage: loadToolDetailPage != null
              ? ({String? cursor}) => loadToolDetailPage!(entry, cursor: cursor)
              : null,
        );
      case ActivityFeedKind.imageView:
        return _ImageViewTile(
          entry: entry,
          loadImageView: loadImageView,
          onOpenImageDisplayArtifact: onOpenImageDisplayArtifact,
        );
      case ActivityFeedKind.actionGroup:
        return _ActionGroupTile(
          entry: entry,
          loadToolDetail: loadToolDetail,
          loadToolDetailPage: loadToolDetailPage,
        );
      case ActivityFeedKind.phase:
        if (entry.reconnecting) {
          return _ReconnectPhaseTile(summary: entry.text, detail: entry.detail);
        }
        return _PhaseTile(
          text: entry.text,
          detail: entry.detail,
          icon: entry.actionIcon,
          lifecycle: entry.lifecycle,
        );
      case ActivityFeedKind.subagentMission:
        return _SubagentMissionTile(
          role: entry.subagentRole ?? '',
          summary: entry.text,
          prompt: entry.missionPrompt,
          taskName: entry.taskName,
          agentId: entry.agentId,
          attachments: entry.attachments,
          themeSource: themeSource,
          running: entry.running,
          durationMs: entry.durationMs,
          statusText: entry.statusText,
          timeline: entry.timeline,
          onOpenDetail: onOpenAgentDetail != null && entry.attachments.isEmpty
              ? () => onOpenAgentDetail!(entry)
              : null,
        );
      case ActivityFeedKind.error:
        return _ErrorTile(
          text: entry.text,
          onRetry: onRetryFailedRequest == null
              ? null
              : () => onRetryFailedRequest!(entry),
        );
    }
  }
}

class _TurnFeedTile extends StatefulWidget {
  const _TurnFeedTile({
    required this.entry,
    this.themeSource,
    this.onOpenAgentDetail,
    this.loadToolDetail,
    this.loadToolDetailPage,
    this.loadTurnDetail,
    this.loadImageView,
    this.onOpenImageDisplayArtifact,
    this.thinkingDefaultExpanded = false,
    this.showFinalMeta = false,
    this.showMessageCopyAndTime = true,
    this.paceTargetEntryId,
    this.onRetryFailedRequest,
  });

  final ActivityFeedEntry entry;
  final SubagentThemeSource? themeSource;
  final ActivityFeedEntryCallback? onOpenAgentDetail;
  final ActivityFeedToolDetailLoader? loadToolDetail;
  final ActivityFeedToolDetailPageLoader? loadToolDetailPage;
  final ActivityFeedTurnDetailLoader? loadTurnDetail;
  final ActivityFeedImageViewLoader? loadImageView;
  final ValueChanged<String>? onOpenImageDisplayArtifact;
  final bool thinkingDefaultExpanded;
  final bool showFinalMeta;
  final bool showMessageCopyAndTime;
  final String? paceTargetEntryId;
  final ActivityFeedFailedRequestRetryHandler? onRetryFailedRequest;

  @override
  State<_TurnFeedTile> createState() => _TurnFeedTileState();
}

class _TurnFeedTileState extends State<_TurnFeedTile> {
  late bool _expanded;
  late int _durationMs;
  bool _detailLoading = false;
  bool _detailLoaded = false;
  Object? _detailError;
  Timer? _timer;

  @override
  void initState() {
    super.initState();
    _expanded = widget.entry.running;
    _durationMs = _resolveDurationMs();
    _syncTimer();
  }

  @override
  void didUpdateWidget(covariant _TurnFeedTile oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.entry.id != widget.entry.id) {
      _expanded = widget.entry.running;
      _detailLoaded = false;
      _detailError = null;
    } else if (widget.entry.running) {
      _expanded = true;
    } else if (oldWidget.entry.running && !widget.entry.running) {
      _expanded = false;
    }
    _durationMs = _resolveDurationMs();
    _syncTimer();
  }

  int _resolveDurationMs() {
    final startedAt = DateTime.tryParse(widget.entry.startedAt ?? '');
    final endedAt = DateTime.tryParse(widget.entry.endedAt ?? '');
    if (startedAt == null) return widget.entry.durationMs;
    final end = endedAt ?? DateTime.now();
    return end.difference(startedAt).inMilliseconds.clamp(0, 1 << 31);
  }

  void _syncTimer() {
    _timer?.cancel();
    _timer = null;
    if (!widget.entry.running) return;
    _timer = Timer.periodic(const Duration(seconds: 1), (_) {
      if (!mounted) return;
      setState(() => _durationMs = _resolveDurationMs());
    });
  }

  Future<void> _loadDetail() async {
    if (widget.loadTurnDetail == null || _detailLoading || _detailLoaded) {
      return;
    }
    setState(() {
      _detailLoading = true;
      _detailError = null;
    });
    try {
      await widget.loadTurnDetail!(widget.entry);
      if (mounted) setState(() => _detailLoaded = true);
    } catch (error) {
      if (mounted) setState(() => _detailError = error);
    } finally {
      if (mounted) setState(() => _detailLoading = false);
    }
  }

  Future<void> _toggleExpanded() async {
    if (widget.entry.running) return;
    final next = !_expanded;
    setState(() {
      _expanded = next;
      if (next) _detailError = null;
    });
    if (next) await _loadDetail();
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final eco = ecoColors(context);
    final status = _formatTurnStatusLabel(
      entry: widget.entry,
      durationMs: _durationMs,
      l10n: context.l10n,
      stopping: _FeedStoppingScope.of(context) && widget.entry.running,
    );
    final process = widget.entry.processEntries;
    final showHeading = !widget.entry.running || !widget.entry.continuation;

    return Padding(
      padding: const EdgeInsets.only(top: 18),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (showHeading)
            Semantics(
              button: !widget.entry.running,
              expanded: _expanded,
              label: widget.entry.running
                  ? context.l10n.activityExecutionProcess
                  : context.l10n.activityExecutionResult,
              child: InkWell(
                onTap: widget.entry.running ? null : _toggleExpanded,
                borderRadius: BorderRadius.circular(4),
                child: Padding(
                  padding: const EdgeInsets.symmetric(vertical: 5),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      Row(
                        children: [
                          Text(
                            status,
                            style: activityFeedBodyStyle(
                              context,
                              height: 1.4,
                              color: eco.textMuted,
                            )?.copyWith(fontWeight: FontWeight.w500),
                          ),
                          if (!widget.entry.running) ...[
                            const SizedBox(width: 3),
                            AnimatedRotation(
                              turns: _expanded ? 0.25 : 0,
                              duration: const Duration(milliseconds: 180),
                              curve: Curves.easeOut,
                              child: Icon(
                                Icons.chevron_right_rounded,
                                size: 18,
                                color: eco.textMuted,
                              ),
                            ),
                          ],
                        ],
                      ),
                      const SizedBox(height: 8),
                      Divider(height: 1, color: eco.borderSubtle),
                    ],
                  ),
                ),
              ),
            ),
          ClipRect(
            child: AnimatedSize(
              duration: const Duration(milliseconds: 180),
              curve: Curves.easeOut,
              alignment: Alignment.topCenter,
              child: _expanded
                  ? Padding(
                      padding: EdgeInsets.only(top: showHeading ? 7 : 0),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [
                          for (final child in process)
                            _ActivityFeedEntryTile(
                              key: ValueKey(child.id),
                              entry: child,
                              themeSource: widget.themeSource,
                              onOpenAgentDetail: widget.onOpenAgentDetail,
                              loadToolDetail: widget.loadToolDetail,
                              loadToolDetailPage: widget.loadToolDetailPage,
                              loadImageView: widget.loadImageView,
                              onOpenImageDisplayArtifact:
                                  widget.onOpenImageDisplayArtifact,
                              thinkingDefaultExpanded:
                                  widget.thinkingDefaultExpanded,
                              paceTargetEntryId: widget.paceTargetEntryId,
                              onRetryFailedRequest: widget.onRetryFailedRequest,
                              showMessageCopyAndTime:
                                  widget.showMessageCopyAndTime,
                            ),
                        ],
                      ),
                    )
                  : const SizedBox.shrink(),
            ),
          ),
          if (_detailLoading)
            const Padding(
              padding: EdgeInsets.only(top: 6),
              child: LinearProgressIndicator(minHeight: 2),
            ),
          if (_detailError != null)
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: Row(
                children: [
                  Expanded(
                    child: Text(
                      localizedAppError(_detailError!, context.l10n),
                      style: activityFeedBodyStyle(
                        context,
                        color: eco.statusDenyText,
                      ),
                    ),
                  ),
                  TextButton(
                    onPressed: _detailLoading ? null : _loadDetail,
                    child: Text(context.l10n.commonRetry),
                  ),
                ],
              ),
            ),
          if (widget.entry.finalOutput != null) ...[
            Padding(
              padding: const EdgeInsets.only(top: 9),
              child: Semantics(
                label: context.l10n.activityFinalOutput,
                child: _ActivityFeedEntryTile(
                  entry: widget.entry.finalOutput!,
                  themeSource: widget.themeSource,
                  onOpenAgentDetail: widget.onOpenAgentDetail,
                  loadToolDetail: widget.loadToolDetail,
                  loadToolDetailPage: widget.loadToolDetailPage,
                  loadImageView: widget.loadImageView,
                  onOpenImageDisplayArtifact: widget.onOpenImageDisplayArtifact,
                  thinkingDefaultExpanded: widget.thinkingDefaultExpanded,
                  paceTargetEntryId: widget.paceTargetEntryId,
                  onRetryFailedRequest: widget.onRetryFailedRequest,
                  hideMessageActions: widget.showFinalMeta,
                  showMessageCopyAndTime: widget.showMessageCopyAndTime,
                ),
              ),
            ),
            if (widget.showFinalMeta &&
                !widget.entry.running &&
                widget.entry.finalOutput!.text.trim().isNotEmpty)
              _FinalOutputMeta(
                entryId: widget.entry.finalOutput!.id,
                text: widget.entry.finalOutput!.text,
                at: widget.entry.finalOutput!.at ?? widget.entry.endedAt,
              ),
          ],
        ],
      ),
    );
  }
}

class _FinalOutputMeta extends StatefulWidget {
  const _FinalOutputMeta({required this.entryId, required this.text, this.at});

  final String entryId;
  final String text;
  final String? at;

  @override
  State<_FinalOutputMeta> createState() => _FinalOutputMetaState();
}

class _FinalOutputMetaState extends State<_FinalOutputMeta> {
  Future<void> _copy() async {
    final text = widget.text.trim();
    if (text.isEmpty) return;
    await Clipboard.setData(ClipboardData(text: text));
    if (mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(context.l10n.activityMessageCopied)),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    final timestamp = DateTime.tryParse(widget.at ?? '');
    final label = timestamp == null
        ? null
        : DateFormat('MM-dd HH:mm').format(timestamp);
    final tooltip = timestamp == null
        ? null
        : DateFormat("yyyy-MM-dd 'HH:mm:ss'").format(timestamp);
    return Padding(
      padding: const EdgeInsets.fromLTRB(2, 4, 12, 0),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.center,
        children: [
          if (tooltip != null)
            Tooltip(
              message: tooltip,
              child: Text(label!, style: activityFeedMetaLabelStyle(context)),
            ),
          if (tooltip != null) const SizedBox(width: 8),
          ActivityFeedCopyButton(onPressed: _copy),
          const SizedBox(width: activityFeedMessageActionGap),
          ActivityFeedSpeakButton(
            entryId: widget.entryId,
            sourceText: widget.text,
          ),
        ],
      ),
    );
  }
}

String _formatTurnStatusLabel({
  required ActivityFeedEntry entry,
  required int durationMs,
  required AppLocalizations l10n,
  bool stopping = false,
}) {
  if (entry.running) {
    final duration = _formatTurnDurationMs(durationMs);
    final label = stopping ? l10n.threadStopping : l10n.activityProcessing;
    return duration.isEmpty ? label : '$label $duration';
  }

  if (entry.turnStatus == 'cancelled' || entry.turnStatus == 'failed') {
    final duration = _formatStoppedTurnDurationMs(durationMs, l10n.localeName);
    if (entry.turnStatus == 'cancelled') {
      return duration.isEmpty
          ? l10n.activityStoppedByYou
          : l10n.activityStoppedByYouAfter(duration);
    }
    return duration.isEmpty
        ? l10n.activityStoppedUnexpectedly
        : l10n.activityStoppedUnexpectedlyAfter(duration);
  }

  final duration = _formatTurnDurationMs(durationMs);
  return duration.isEmpty
      ? l10n.activityProcessed
      : '${l10n.activityProcessed} $duration';
}

String _formatStoppedTurnDurationMs(int ms, String localeName) {
  final duration = _formatTurnDurationMs(ms);
  if (duration.isEmpty || !localeName.toLowerCase().startsWith('zh')) {
    return duration;
  }
  return duration
      .replaceAllMapped(RegExp(r'(\d+)h\b'), (match) => '${match.group(1)}小时')
      .replaceAllMapped(RegExp(r'(\d+)m\b'), (match) => '${match.group(1)}分')
      .replaceAllMapped(RegExp(r'(\d+)s\b'), (match) => '${match.group(1)}秒');
}

class _UserPromptTile extends StatefulWidget {
  const _UserPromptTile({
    required this.text,
    this.attachments = const [],
    this.rewindTarget,
    this.historyRevision = 0,
    this.onLoadUserMessageEdit,
    this.onRewriteUserMessage,
    this.initiallyExpanded = false,
  });

  final String text;
  final List<PromptImageAttachment> attachments;
  final ThreadActivityRewindTarget? rewindTarget;
  final int historyRevision;
  final ActivityFeedUserMessageEditLoader? onLoadUserMessageEdit;
  final ActivityFeedUserMessageRewriteHandler? onRewriteUserMessage;
  final bool initiallyExpanded;

  @override
  State<_UserPromptTile> createState() => _UserPromptTileState();
}

class _UserPromptTileState extends State<_UserPromptTile> {
  static const _collapsedMaxLines = 5;
  static const _maxEditImages = 5;

  late var _expanded = widget.initiallyExpanded;
  final _editController = TextEditingController();
  final _picker = ImagePicker();
  var _editing = false;
  var _editLoading = false;
  var _editSaving = false;
  var _editAttachments = <PromptImageAttachment>[];
  var _editRevision = 0;
  var _editRequest = 0;

  bool get _canEdit =>
      widget.rewindTarget != null &&
      widget.onLoadUserMessageEdit != null &&
      widget.onRewriteUserMessage != null;

  @override
  void initState() {
    super.initState();
    _editController.text = widget.text;
    _editRevision = widget.historyRevision;
    _editAttachments = List.of(widget.attachments);
  }

  @override
  void didUpdateWidget(covariant _UserPromptTile oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.text != widget.text ||
        oldWidget.initiallyExpanded != widget.initiallyExpanded ||
        oldWidget.historyRevision != widget.historyRevision ||
        oldWidget.rewindTarget?.activityLineId !=
            widget.rewindTarget?.activityLineId) {
      _expanded = widget.initiallyExpanded;
      _editRequest += 1;
      _editing = false;
      _editLoading = false;
      _editSaving = false;
      _editController.text = widget.text;
      _editRevision = widget.historyRevision;
      _editAttachments = List.of(widget.attachments);
    }
  }

  @override
  void dispose() {
    _editController.dispose();
    _editFocusNode.dispose();
    super.dispose();
  }

  Future<void> _beginEdit() async {
    final target = widget.rewindTarget;
    final loader = widget.onLoadUserMessageEdit;
    if (!_canEdit || target == null || loader == null) return;
    final request = ++_editRequest;
    setState(() {
      _editLoading = true;
      _editSaving = false;
    });
    try {
      final result = await loader(target.activityLineId);
      if (!mounted || request != _editRequest) return;
      if (!result.capability.isReady) {
        _showEditToast(
          result.capability.reason?.trim().isNotEmpty == true
              ? result.capability.reason!.trim()
              : _editUnavailableText(context),
        );
        return;
      }
      setState(() {
        _editing = true;
        _editController.text = result.text;
        _editController.selection = TextSelection.collapsed(
          offset: result.text.length,
        );
        _editAttachments = List.of(result.attachments);
        _editRevision = result.historyRevision;
      });
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!mounted || request != _editRequest) return;
        FocusScope.of(context).requestFocus(_editFocusNode);
      });
    } catch (error) {
      if (mounted && request == _editRequest) {
        _showEditToast(error.toString());
      }
    } finally {
      if (mounted && request == _editRequest) {
        setState(() => _editLoading = false);
      }
    }
  }

  void _showEditToast(String message) {
    if (!mounted) return;
    ScaffoldMessenger.of(
      context,
    ).showSnackBar(SnackBar(content: Text(message)));
  }

  final _editFocusNode = FocusNode();

  String _editUnavailableText(BuildContext context) =>
      context.l10n.commonUnavailable;

  void _cancelEdit() {
    _editRequest += 1;
    setState(() {
      _editing = false;
      _editLoading = false;
      _editSaving = false;
      _editController.text = widget.text;
      _editRevision = widget.historyRevision;
      _editAttachments = List.of(widget.attachments);
    });
  }

  Future<void> _pickEditImage() async {
    if (_editLoading ||
        _editSaving ||
        _editAttachments.length >= _maxEditImages) {
      return;
    }
    final file = await _picker.pickImage(source: ImageSource.gallery);
    if (file == null || !mounted) return;
    final picked = await promptImageAttachmentFromXFile(file);
    if (!mounted) return;
    final attachment = picked.attachment;
    if (attachment == null) {
      _showEditToast(
        picked.failure == PromptImagePickFailure.tooLarge
            ? context.l10n.composerImageTooLarge
            : context.l10n.composerUnsupportedImage,
      );
      return;
    }
    setState(() {
      _editAttachments = [..._editAttachments, attachment];
    });
  }

  Future<void> _submitEdit() async {
    final target = widget.rewindTarget;
    final rewrite = widget.onRewriteUserMessage;
    if (target == null || rewrite == null || _editLoading || _editSaving) {
      return;
    }
    final prompt = _editController.text.trim();
    if (prompt.isEmpty && _editAttachments.isEmpty) {
      _showEditToast(_emptyEditMessageText(context));
      return;
    }
    setState(() {
      _editSaving = true;
    });
    try {
      await rewrite(
        activityLineId: target.activityLineId,
        prompt: prompt,
        attachments: List.of(_editAttachments),
        expectedHistoryRevision: _editRevision,
      );
      if (mounted) {
        setState(() {
          _editing = false;
          _editSaving = false;
        });
      }
    } catch (error) {
      if (mounted) {
        setState(() => _editSaving = false);
        _showEditToast(error.toString());
      }
    }
  }

  String _emptyEditMessageText(BuildContext context) =>
      Localizations.localeOf(context).languageCode == 'zh'
      ? '消息不能为空'
      : 'Message cannot be empty';

  Widget _buildImage(
    PromptImageAttachment attachment, {
    double size = 108,
    VoidCallback? onTap,
  }) {
    try {
      final image = Image.memory(
        base64Decode(attachment.data),
        width: size,
        height: size,
        fit: BoxFit.cover,
        gaplessPlayback: true,
        filterQuality: FilterQuality.medium,
        errorBuilder: (_, _, _) =>
            const Center(child: Icon(Icons.broken_image_outlined)),
      );
      if (onTap == null) return image;
      return Material(
        color: Colors.transparent,
        child: InkWell(onTap: onTap, child: image),
      );
    } on FormatException {
      return const Center(child: Icon(Icons.broken_image_outlined));
    }
  }

  Future<void> _openAttachmentLightbox(int index) async {
    final images = <Uint8List>[];
    final indexes = <int>[];
    for (var i = 0; i < widget.attachments.length; i++) {
      try {
        images.add(base64Decode(widget.attachments[i].data));
        indexes.add(i);
      } on FormatException {
        // Skip undecodable thumbnails.
      }
    }
    if (images.isEmpty || !mounted) return;
    final start = indexes.indexOf(index).clamp(0, images.length - 1);
    await showImageMemoryLightbox(context, images: images, initialIndex: start);
  }

  Future<void> _openEditAttachmentLightbox(int index) async {
    final images = <Uint8List>[];
    final indexes = <int>[];
    for (var i = 0; i < _editAttachments.length; i++) {
      try {
        images.add(base64Decode(_editAttachments[i].data));
        indexes.add(i);
      } on FormatException {
        // Skip undecodable thumbnails.
      }
    }
    if (images.isEmpty || !mounted) return;
    final start = indexes.indexOf(index).clamp(0, images.length - 1);
    await showImageMemoryLightbox(context, images: images, initialIndex: start);
  }

  Widget _buildEditBubble(BuildContext context, double maxBubbleWidth) {
    final eco = ecoColors(context);
    return Container(
      margin: const EdgeInsets.symmetric(vertical: 6),
      padding: const EdgeInsets.fromLTRB(12, 10, 12, 8),
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: eco.borderSubtle),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: [
          TextField(
            controller: _editController,
            focusNode: _editFocusNode,
            minLines: 2,
            maxLines: 8,
            enabled: !_editLoading && !_editSaving,
            textInputAction: TextInputAction.newline,
            decoration: InputDecoration(
              hintText: context.l10n.threadEditGuidanceHint,
              filled: false,
              fillColor: Colors.transparent,
              border: InputBorder.none,
              enabledBorder: InputBorder.none,
              focusedBorder: InputBorder.none,
              disabledBorder: InputBorder.none,
              isDense: true,
              contentPadding: EdgeInsets.zero,
            ),
            style: activityFeedBodyStyle(
              context,
              height: 1.45,
              color: eco.textPrimary,
            )?.copyWith(backgroundColor: Colors.transparent),
          ),
          if (_editAttachments.isNotEmpty) ...[
            const SizedBox(height: 8),
            SizedBox(
              height: 88,
              child: ListView.separated(
                scrollDirection: Axis.horizontal,
                itemCount: _editAttachments.length,
                separatorBuilder: (_, _) => const SizedBox(width: 6),
                itemBuilder: (context, index) {
                  final attachment = _editAttachments[index];
                  return Stack(
                    children: [
                      ClipRRect(
                        borderRadius: BorderRadius.circular(10),
                        child: SizedBox.square(
                          dimension: 88,
                          child: _buildImage(
                            attachment,
                            size: 88,
                            onTap: () => _openEditAttachmentLightbox(index),
                          ),
                        ),
                      ),
                      Positioned(
                        top: 2,
                        right: 2,
                        child: IconButton(
                          onPressed: _editLoading || _editSaving
                              ? null
                              : () => setState(
                                  () => _editAttachments = [
                                    ..._editAttachments.take(index),
                                    ..._editAttachments.skip(index + 1),
                                  ],
                                ),
                          icon: const Icon(Icons.close, size: 16),
                          tooltip: context.l10n.commonDelete,
                          visualDensity: VisualDensity.compact,
                          style: IconButton.styleFrom(
                            backgroundColor: Colors.black54,
                            foregroundColor: Colors.white,
                            padding: EdgeInsets.zero,
                            minimumSize: const Size(26, 26),
                            tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                          ),
                        ),
                      ),
                    ],
                  );
                },
              ),
            ),
          ],
          Row(
            children: [
              IconButton(
                onPressed:
                    _editLoading ||
                        _editSaving ||
                        _editAttachments.length >= _maxEditImages
                    ? null
                    : _pickEditImage,
                icon: const Icon(Icons.add_photo_alternate_outlined, size: 20),
                tooltip: context.l10n.composerAddImage,
                visualDensity: VisualDensity.compact,
              ),
              const Spacer(),
              IconButton(
                onPressed: _editSaving ? null : _cancelEdit,
                icon: const Icon(Icons.close, size: 19),
                tooltip: context.l10n.commonCancel,
                visualDensity: VisualDensity.compact,
              ),
              IconButton(
                onPressed: _editLoading || _editSaving ? null : _submitEdit,
                icon: _editSaving
                    ? const SizedBox.square(
                        dimension: 18,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : const Icon(Icons.check, size: 20),
                tooltip: context.l10n.commonSubmit,
                visualDensity: VisualDensity.compact,
              ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _buildReadOnlyBubble(BuildContext context, double maxBubbleWidth) {
    final eco = ecoColors(context);
    const horizontalPadding = 28.0;
    final textStyle = activityFeedBodyStyle(
      context,
      height: 1.45,
      color: eco.textPrimary,
    );

    return Container(
      margin: const EdgeInsets.fromLTRB(0, 6, 0, 16),
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
      decoration: BoxDecoration(
        color: eco.userBubble,
        borderRadius: BorderRadius.circular(16),
      ),
      child: LayoutBuilder(
        builder: (context, constraints) {
          final bodyMaxWidth = (constraints.maxWidth - horizontalPadding).clamp(
            0.0,
            maxBubbleWidth - horizontalPadding,
          );
          final canExpand = _textExceedsLineLimit(
            text: widget.text,
            style: textStyle,
            maxWidth: bodyMaxWidth,
            maxLines: _collapsedMaxLines,
            textDirection: Directionality.of(context),
          );
          final showCollapsed = canExpand && !_expanded;
          final galleryWidth = (widget.attachments.length * 108.0).clamp(
            0.0,
            maxBubbleWidth - horizontalPadding,
          );

          return IntrinsicWidth(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              mainAxisSize: MainAxisSize.min,
              children: [
                if (widget.attachments.isNotEmpty) ...[
                  SizedBox(
                    width: galleryWidth,
                    height: 108,
                    child: ListView.separated(
                      scrollDirection: Axis.horizontal,
                      itemCount: widget.attachments.length,
                      separatorBuilder: (_, _) => const SizedBox(width: 6),
                      itemBuilder: (context, index) => ClipRRect(
                        borderRadius: BorderRadius.circular(10),
                        child: SizedBox.square(
                          dimension: 108,
                          child: _buildImage(
                            widget.attachments[index],
                            onTap: () => _openAttachmentLightbox(index),
                          ),
                        ),
                      ),
                    ),
                  ),
                  const SizedBox(height: 8),
                ],
                AnimatedSize(
                  duration: const Duration(milliseconds: 150),
                  curve: Curves.easeOut,
                  alignment: Alignment.topRight,
                  child: showCollapsed
                      ? ShaderMask(
                          blendMode: BlendMode.dstIn,
                          shaderCallback: (bounds) {
                            return const LinearGradient(
                              begin: Alignment.topCenter,
                              end: Alignment.bottomCenter,
                              colors: [
                                Color(0xFF000000),
                                Color(0xFF000000),
                                Color(0x00000000),
                              ],
                              stops: [0, 0.45, 1],
                            ).createShader(bounds);
                          },
                          child: Text(
                            widget.text,
                            maxLines: _collapsedMaxLines,
                            overflow: TextOverflow.clip,
                            style: textStyle,
                          ),
                        )
                      : Text(widget.text, style: textStyle),
                ),
                if (canExpand)
                  Align(
                    alignment: Alignment.center,
                    child: TextButton(
                      onPressed: () => setState(() => _expanded = !_expanded),
                      style: TextButton.styleFrom(
                        padding: const EdgeInsets.fromLTRB(8, 4, 8, 0),
                        minimumSize: Size.zero,
                        tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                        visualDensity: VisualDensity.compact,
                      ),
                      child: Text(
                        _expanded
                            ? context.l10n.commonCollapse
                            : context.l10n.activityExpandFull,
                        style: Theme.of(
                          context,
                        ).textTheme.labelSmall?.copyWith(color: eco.textMuted),
                      ),
                    ),
                  ),
              ],
            ),
          );
        },
      ),
    );
  }

  Future<void> _copyMessage() async {
    final text = widget.text.trim();
    if (text.isEmpty) return;
    await Clipboard.setData(ClipboardData(text: text));
    if (mounted) _showEditToast(context.l10n.activityMessageCopied);
  }

  @override
  Widget build(BuildContext context) {
    final maxBubbleWidth = MediaQuery.of(context).size.width * 0.88;
    final bubble = _editing
        ? _buildEditBubble(context, maxBubbleWidth)
        : _buildReadOnlyBubble(context, maxBubbleWidth);

    return Align(
      alignment: Alignment.centerRight,
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.end,
        children: [
          ConstrainedBox(
            constraints: BoxConstraints(maxWidth: maxBubbleWidth),
            child: bubble,
          ),
          // 用户消息不随会话进行状态隐藏操作：编辑与复制始终可见（仅要求文本非空），
          // 只有 agent 侧输出才用 showMessageCopyAndTime 延迟挂载以避免 streaming 抖动。
          if (!_editing && (_canEdit || widget.text.trim().isNotEmpty))
            Padding(
              // Keep space below copy/edit actions so the next agent turn does
              // not sit flush against the icon row (desktop uses ~20px block gap).
              padding: const EdgeInsets.fromLTRB(4, 2, 8, 12),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.center,
                children: [
                  if (_canEdit)
                    IconButton(
                      onPressed: _beginEdit,
                      icon: const Icon(
                        EcoIcons.edit,
                        size: activityFeedMessageActionIconSize,
                      ),
                      tooltip: context.l10n.activityEditing,
                      style: activityFeedMessageActionStyle(context),
                    ),
                  if (_canEdit && widget.text.trim().isNotEmpty)
                    const SizedBox(width: activityFeedMessageActionGap),
                  if (widget.text.trim().isNotEmpty)
                    ActivityFeedCopyButton(onPressed: _copyMessage),
                ],
              ),
            ),
        ],
      ),
    );
  }
}

class _ClarificationAnswerTile extends StatelessWidget {
  const _ClarificationAnswerTile({required this.text});

  final String text;

  @override
  Widget build(BuildContext context) {
    final rows = parseClarificationAnswersSummary(text) ?? const [];
    final eco = ecoColors(context);

    return Align(
      alignment: Alignment.centerRight,
      child: ConstrainedBox(
        constraints: BoxConstraints(
          maxWidth: MediaQuery.of(context).size.width * 0.88,
        ),
        child: Container(
          margin: const EdgeInsets.symmetric(vertical: 6),
          padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
          decoration: BoxDecoration(
            color: eco.userBubble,
            borderRadius: BorderRadius.circular(16),
            border: Border.all(color: eco.borderSubtle),
          ),
          child: IntrinsicWidth(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  context.l10n.activityClarificationAnswer,
                  style: Theme.of(context).textTheme.labelMedium?.copyWith(
                    color: eco.textMuted,
                    fontWeight: FontWeight.w600,
                    letterSpacing: 0.2,
                  ),
                ),
                const SizedBox(height: 10),
                for (var index = 0; index < rows.length; index++) ...[
                  if (index > 0) const SizedBox(height: 10),
                  Text(
                    rows[index].question,
                    style: Theme.of(context).textTheme.labelSmall?.copyWith(
                      color: eco.textMuted,
                      height: 1.35,
                    ),
                  ),
                  const SizedBox(height: 4),
                  Text(
                    rows[index].answer.isEmpty
                        ? context.l10n.activityNoneSelected
                        : rows[index].answer,
                    style: activityFeedBodyStyle(context, height: 1.45),
                  ),
                ],
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _AssistantNarrativeTile extends StatelessWidget {
  const _AssistantNarrativeTile({
    required this.entryId,
    required this.text,
    this.streaming = false,
    this.pacing = false,
    this.usageBadge,
    this.hideMessageActions = false,
  });

  final String entryId;
  final String text;
  final bool streaming;
  // 只有 feed 中最后一个流式条目才逐字输出；更早的条目全量展示。
  final bool pacing;
  final String? usageBadge;
  final bool hideMessageActions;

  @override
  Widget build(BuildContext context) {
    final sanitizedText = sanitizeFeedText(text);
    final live = streaming && pacing;
    return PacedStreamText(
      text: sanitizedText,
      streaming: live,
      builder: (context, displayText, revealing) => _AssistantNarrativeContent(
        entryId: entryId,
        text: displayText,
        sourceText: sanitizedText,
        streaming: live || revealing,
        usageBadge: usageBadge,
        hideMessageActions: hideMessageActions,
      ),
    );
  }
}

class _AssistantNarrativeContent extends StatelessWidget {
  const _AssistantNarrativeContent({
    required this.entryId,
    required this.text,
    required this.sourceText,
    required this.streaming,
    this.usageBadge,
    this.hideMessageActions = false,
  });

  final String entryId;
  final String text;
  final String sourceText;
  final bool streaming;
  final String? usageBadge;
  final bool hideMessageActions;

  @override
  Widget build(BuildContext context) {
    if (text.isEmpty && usageBadge != null) {
      return _UsageBadgeLine(badge: usageBadge!);
    }
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 8, horizontal: 2),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (text.isNotEmpty)
            streaming
                ? _StreamingFeedMarkdown(
                    text: text,
                    color: ecoColors(context).textHeading,
                  )
                : EcoMarkdown(
                    text: text,
                    selectable: false,
                    fontSizeScale: activityFeedBodyFontScale,
                  ),
          if (usageBadge != null) ...[
            const SizedBox(height: 6),
            _UsageBadgeLine(badge: usageBadge!),
          ],
          if (!hideMessageActions && !streaming && sourceText.trim().isNotEmpty)
            Align(
              alignment: Alignment.centerLeft,
              child: ActivityFeedMessageActions(
                entryId: entryId,
                sourceText: sourceText,
              ),
            ),
          if (streaming && text.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Text(
                '…',
                style: Theme.of(context).textTheme.bodySmall?.copyWith(
                  color: ecoColors(context).textMuted,
                ),
              ),
            ),
        ],
      ),
    );
  }
}

class _StreamingFeedMarkdown extends StatelessWidget {
  const _StreamingFeedMarkdown({
    required this.text,
    this.compact = false,
    this.muted = false,
    this.color,
  });

  final String text;
  final bool compact;
  final bool muted;
  final Color? color;

  @override
  Widget build(BuildContext context) {
    final partition = partitionStreamingMarkdown(text, streaming: true);
    final structuralTail = isStructuralStreamingTail(partition.tail);
    final tailStyle = activityFeedBodyStyle(
      context,
      color: color ?? ecoColors(context).textMuted,
      height: compact ? 1.45 : 1.55,
    );
    if (!structuralTail) {
      return EcoMarkdown(
        text: text,
        compact: compact,
        muted: muted,
        selectable: false,
        fontSizeScale: activityFeedBodyFontScale,
      );
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (partition.stable.trim().isNotEmpty)
          EcoMarkdown(
            text: partition.stable,
            compact: compact,
            muted: muted,
            selectable: false,
            fontSizeScale: activityFeedBodyFontScale,
          ),
        if (partition.tail.isNotEmpty) Text(partition.tail, style: tailStyle),
      ],
    );
  }
}

/// Empty/live thinking status — same shell for "正在思考" and ephemeral
/// reasoning summary.
class _WaitingThinkingLine extends StatelessWidget {
  const _WaitingThinkingLine({required this.label});

  final String label;

  @override
  Widget build(BuildContext context) {
    return _ThinkingSummaryCarousel(label: label);
  }
}

class _ThinkingSummaryCarousel extends StatefulWidget {
  const _ThinkingSummaryCarousel({required this.label});

  final String label;

  @override
  State<_ThinkingSummaryCarousel> createState() =>
      _ThinkingSummaryCarouselState();
}

class _ThinkingSummaryCarouselState extends State<_ThinkingSummaryCarousel> {
  Timer? _timer;
  var _activeIndex = 0;
  var _linesKey = '';

  List<String> get _lines => splitThinkingCarouselLines(widget.label);

  @override
  void initState() {
    super.initState();
    _syncTimer(reset: true);
  }

  @override
  void didUpdateWidget(covariant _ThinkingSummaryCarousel oldWidget) {
    super.didUpdateWidget(oldWidget);
    _syncTimer();
  }

  void _syncTimer({bool reset = false}) {
    final lines = _lines;
    final key = lines.join('\n');
    if (!reset && key == _linesKey) return;
    _linesKey = key;
    _activeIndex = 0;
    _timer?.cancel();
    _timer = null;
    if (lines.length > 1) {
      _timer = Timer.periodic(const Duration(milliseconds: 2600), (_) {
        if (!mounted) return;
        setState(() => _activeIndex = (_activeIndex + 1) % lines.length);
      });
    }
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final lines = _lines;
    final activeText = lines.isEmpty
        ? context.l10n.activityThinking
        : lines[_activeIndex % lines.length];
    final style = activityFeedBodyStyle(context, height: 1.4);
    final lineHeight = (style?.fontSize ?? 13) * (style?.height ?? 1.4);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 8, horizontal: 2),
      child: SizedBox(
        key: const ValueKey('activity-waiting-thinking'),
        height: lineHeight,
        child: ClipRect(
          child: AnimatedSwitcher(
            duration: const Duration(milliseconds: 260),
            switchInCurve: Curves.easeOut,
            switchOutCurve: Curves.easeIn,
            layoutBuilder: (current, previous) => Stack(
              alignment: Alignment.topLeft,
              children: [...previous, ?current],
            ),
            transitionBuilder: (child, animation) {
              final isIncoming = child.key == ValueKey(activeText);
              final offset = isIncoming
                  ? Tween<Offset>(
                      begin: const Offset(0, 1),
                      end: Offset.zero,
                    ).animate(animation)
                  : Tween<Offset>(
                      begin: const Offset(0, -1),
                      end: Offset.zero,
                    ).animate(animation);
              return ClipRect(
                child: SlideTransition(position: offset, child: child),
              );
            },
            child: ShimmerText(
              key: ValueKey(activeText),
              text: activeText,
              style: style,
              baseColor: ecoColors(context).textMuted,
              highlightColor: ecoColors(context).textSecondary,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
            ),
          ),
        ),
      ),
    );
  }
}

class _ThinkingTile extends StatelessWidget {
  const _ThinkingTile({
    required this.text,
    this.streaming = false,
    this.pacing = false,
    this.startedAt,
    this.endedAt,
    this.durationMs = 0,
    this.defaultExpanded = false,
  });

  final String text;
  final bool streaming;
  // 只有 feed 中最后一个流式条目才逐字输出；更早的条目全量展示。
  final bool pacing;
  final String? startedAt;
  final String? endedAt;
  final int durationMs;
  final bool defaultExpanded;

  @override
  Widget build(BuildContext context) {
    final sanitizedText = sanitizeFeedText(text);
    return PacedStreamText(
      text: sanitizedText,
      streaming: streaming && pacing,
      builder: (context, displayText, revealing) => _ThinkingTileBody(
        text: displayText,
        streaming: streaming,
        revealing: revealing,
        startedAt: startedAt,
        endedAt: endedAt,
        durationMs: durationMs,
        defaultExpanded: defaultExpanded,
      ),
    );
  }
}

class _ThinkingTileBody extends StatefulWidget {
  const _ThinkingTileBody({
    required this.text,
    required this.streaming,
    required this.revealing,
    this.startedAt,
    this.endedAt,
    this.durationMs = 0,
    this.defaultExpanded = false,
  });

  final String text;
  final bool streaming;
  final bool revealing;
  final String? startedAt;
  final String? endedAt;
  final int durationMs;
  final bool defaultExpanded;

  @override
  State<_ThinkingTileBody> createState() => _ThinkingTileBodyState();
}

class _ThinkingTileBodyState extends State<_ThinkingTileBody> {
  var _expanded = false;
  var _settling = false;
  late int _durationMs;
  Timer? _timer;
  Timer? _settleTimer;

  bool get _activelyStreaming => widget.streaming || widget.revealing;

  @override
  void initState() {
    super.initState();
    _expanded = _activelyStreaming || widget.defaultExpanded;
    _durationMs = _resolveDurationMs();
    _syncTimer();
  }

  @override
  void didUpdateWidget(covariant _ThinkingTileBody oldWidget) {
    super.didUpdateWidget(oldWidget);
    final wasActive = oldWidget.streaming || oldWidget.revealing;
    final isActive = _activelyStreaming;
    if (wasActive && !isActive) {
      _expanded = widget.defaultExpanded;
      if (widget.defaultExpanded) {
        _cancelSettling();
      } else {
        _startSettling();
      }
    } else if (isActive && !_expanded) {
      _cancelSettling();
      _expanded = true;
    } else if (!isActive &&
        !oldWidget.defaultExpanded &&
        widget.defaultExpanded &&
        !_expanded) {
      _cancelSettling();
      _expanded = true;
    }
    _durationMs = _resolveDurationMs();
    _syncTimer();
  }

  @override
  void dispose() {
    _timer?.cancel();
    _settleTimer?.cancel();
    super.dispose();
  }

  void _cancelSettling() {
    _settleTimer?.cancel();
    _settleTimer = null;
    if (_settling) _settling = false;
  }

  void _startSettling() {
    _cancelSettling();
    _settling = true;
    _settleTimer = Timer(const Duration(milliseconds: 480), () {
      if (!mounted) return;
      setState(() {
        _settling = false;
        _settleTimer = null;
      });
    });
  }

  int _resolveDurationMs() {
    final startedAt = DateTime.tryParse(widget.startedAt ?? '');
    final endedAt = DateTime.tryParse(widget.endedAt ?? '');
    if (startedAt == null) return widget.durationMs;
    final end = endedAt ?? DateTime.now();
    final measured = end.difference(startedAt).inMilliseconds.clamp(0, 1 << 31);
    return measured > widget.durationMs ? measured : widget.durationMs;
  }

  void _syncTimer() {
    _timer?.cancel();
    _timer = null;
    if (!_activelyStreaming || widget.startedAt == null) return;
    _timer = Timer.periodic(const Duration(seconds: 1), (_) {
      if (!mounted) return;
      setState(() => _durationMs = _resolveDurationMs());
    });
  }

  @override
  Widget build(BuildContext context) {
    final hasBody = widget.text.trim().isNotEmpty;
    if (!_activelyStreaming && !hasBody) {
      return const SizedBox.shrink();
    }

    // Empty streaming keeps the original shimmer-only waiting row (no fold icon).
    if (_activelyStreaming && !hasBody) {
      return _WaitingThinkingLine(
        label: _FeedStoppingScope.of(context)
            ? context.l10n.threadStopping
            : context.l10n.activityThinking,
      );
    }

    final isExpanded = _activelyStreaming || _expanded || _settling;
    final showDetails = hasBody && isExpanded;
    final eco = ecoColors(context);
    final baseLabel = _activelyStreaming
        ? (_FeedStoppingScope.of(context)
              ? context.l10n.threadStopping
              : context.l10n.activityThinking)
        : context.l10n.activityDeepThinkingDone;
    final duration = _formatTurnDurationMs(_durationMs);
    final label = duration.isEmpty ? baseLabel : '$baseLabel $duration';

    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4, horizontal: 2),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          _ActionSummaryLine(
            label: label,
            icon: EcoIcons.sparkles,
            iconKey: const ValueKey('activity-thinking-icon'),
            lifecycle: _activelyStreaming ? ToolActionLifecycle.running : null,
            // Chevron only after a manual expand — never while auto-open
            // (streaming / settle), matching desktop hover-only disclosure.
            expanded: _expanded && !_activelyStreaming,
            onTap: () {
              if (_activelyStreaming) return;
              if (_settling) {
                setState(() => _cancelSettling());
                return;
              }
              setState(() => _expanded = !_expanded);
            },
          ),
          ClipRect(
            child: AnimatedSize(
              duration: const Duration(milliseconds: 200),
              curve: Curves.easeOut,
              alignment: Alignment.topCenter,
              child: showDetails
                  ? Padding(
                      padding: const EdgeInsets.only(left: 12, top: 8),
                      child: DecoratedBox(
                        decoration: BoxDecoration(
                          border: Border(
                            left: BorderSide(color: eco.borderSubtle),
                          ),
                        ),
                        child: Padding(
                          padding: const EdgeInsets.only(left: 12),
                          child: _activelyStreaming
                              ? _StreamingFeedMarkdown(
                                  text: widget.text,
                                  compact: true,
                                  muted: true,
                                  color: eco.textMuted.withValues(alpha: 0.9),
                                )
                              : EcoMarkdown(
                                  text: widget.text,
                                  compact: true,
                                  muted: true,
                                  selectable: false,
                                  fontSizeScale: activityFeedBodyFontScale,
                                ),
                        ),
                      ),
                    )
                  : const SizedBox.shrink(),
            ),
          ),
        ],
      ),
    );
  }
}

class _UsageBadgeLine extends StatelessWidget {
  const _UsageBadgeLine({required this.badge});

  final String badge;

  @override
  Widget build(BuildContext context) {
    return Text(
      badge,
      style: Theme.of(context).textTheme.labelSmall?.copyWith(
        color: ecoColors(context).textMuted,
        fontSize: 11,
        letterSpacing: 0.2,
      ),
    );
  }
}

class _ActionGroupTile extends StatefulWidget {
  const _ActionGroupTile({
    required this.entry,
    this.loadToolDetail,
    this.loadToolDetailPage,
  });

  final ActivityFeedEntry entry;
  final ActivityFeedToolDetailLoader? loadToolDetail;
  final ActivityFeedToolDetailPageLoader? loadToolDetailPage;

  @override
  State<_ActionGroupTile> createState() => _ActionGroupTileState();
}

class _ActionGroupTileState extends State<_ActionGroupTile> {
  var _expanded = false;

  @override
  Widget build(BuildContext context) {
    final children = widget.entry.actionChildren;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4, horizontal: 2),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          _ActionSummaryLine(
            label: widget.entry.text,
            icon: EcoIcons.activityAction(
              widget.entry.actionIcon ?? ActivityActionIcon.file,
            ),
            // Aggregated group titles never show the failure dot; failed Bash
            // children keep their own subtle indicator on the row/detail title.
            lifecycle: widget.entry.lifecycle == ToolActionLifecycle.failed
                ? ToolActionLifecycle.completed
                : widget.entry.lifecycle,
            expanded: _expanded,
            onTap: () => setState(() => _expanded = !_expanded),
          ),
          if (_expanded)
            Padding(
              padding: const EdgeInsets.only(left: 12, top: 8),
              child: DecoratedBox(
                decoration: BoxDecoration(
                  border: Border(
                    left: BorderSide(color: ecoColors(context).borderSubtle),
                  ),
                ),
                child: Padding(
                  padding: const EdgeInsets.only(left: 12),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      for (final child in children)
                        _ActionTile(
                          key: ValueKey(child.id),
                          preferFormattedLabel: true,
                          label: _formatActionChildLabel(child, context.l10n),
                          icon: child.actionIcon ?? ActivityActionIcon.file,
                          lifecycle: child.lifecycle,
                          bashRun: child.bashRun,
                          fileChange: child.fileChange,
                          webSearch: child.webSearch,
                          toolUseId: child.toolUseId,
                          loadToolDetail: widget.loadToolDetail != null
                              ? () => widget.loadToolDetail!(child)
                              : null,
                          loadToolDetailPage: widget.loadToolDetailPage != null
                              ? ({String? cursor}) =>
                                    widget.loadToolDetailPage!(
                                      child,
                                      cursor: cursor,
                                    )
                              : null,
                        ),
                    ],
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }
}

class _ActionTile extends StatefulWidget {
  const _ActionTile({
    super.key,
    required this.label,
    required this.icon,
    this.lifecycle,
    this.bashRun,
    this.fileChange,
    this.webSearch,
    this.toolUseId,
    this.loadToolDetail,
    this.loadToolDetailPage,
    this.preferFormattedLabel = false,
  });

  final String label;
  final ActivityActionIcon icon;
  final ToolActionLifecycle? lifecycle;
  final BashRunCardDisplay? bashRun;
  final FileChangeCardDisplay? fileChange;
  final WebSearchCardDisplay? webSearch;
  final String? toolUseId;
  final Future<List<ActivityFeedEntry>> Function()? loadToolDetail;
  final ActivityFeedToolDetailPageRequest? loadToolDetailPage;
  final bool preferFormattedLabel;

  @override
  State<_ActionTile> createState() => _ActionTileState();
}

class _ActionTileState extends State<_ActionTile> {
  var _expanded = false;
  Future<List<ActivityFeedEntry>>? _detailFuture;
  var _detailPageLoading = false;
  var _detailLoadingMore = false;
  var _detailPageLoaded = false;
  var _detailEntries = <ActivityFeedEntry>[];
  String? _detailCursor;
  var _detailHasMore = false;
  Object? _detailPageError;
  BashRunCardDisplay? _loadedBashRun;
  Object? _bashDetailError;

  void _toggleDetails() {
    if (_expanded) {
      setState(() => _expanded = false);
      return;
    }
    setState(() => _expanded = true);

    final needsBashDetail =
        widget.bashRun != null &&
        widget.bashRun!.output?.trim().isEmpty != false &&
        widget.toolUseId?.trim().isNotEmpty == true &&
        widget.loadToolDetail != null;
    final shouldLoadDetail =
        widget.webSearch == null && (widget.bashRun == null || needsBashDetail);
    if (!shouldLoadDetail || widget.fileChange != null) return;

    if (widget.loadToolDetailPage != null && !_detailPageLoaded) {
      _requestDetailPage();
      return;
    }
    if (_detailFuture != null || widget.loadToolDetail == null) return;
    final future = widget.loadToolDetail!();
    setState(() {
      _detailFuture = future;
    });
    if (widget.bashRun != null) {
      future.then(
        (entries) {
          if (!mounted) return;
          final bashRun = _findBashRunDetail(entries);
          if (bashRun == null) return;
          setState(() => _loadedBashRun = bashRun);
        },
        onError: (Object error) {
          if (!mounted) return;
          setState(() => _bashDetailError = error);
        },
      );
    }
  }

  void _requestDetailPage({String? cursor, bool append = false}) {
    final loader = widget.loadToolDetailPage;
    if (loader == null || (append && _detailLoadingMore)) return;
    setState(() {
      _detailPageError = null;
      if (append) {
        _detailLoadingMore = true;
      } else {
        _detailPageLoading = true;
      }
    });
    loader(cursor: cursor).then(
      (page) {
        if (!mounted) return;
        final existingEntries = append
            ? _detailEntries
            : const <ActivityFeedEntry>[];
        final byId = <String, ActivityFeedEntry>{
          for (final entry in existingEntries) entry.id: entry,
        };
        for (final entry in page.entries) {
          byId[entry.id] = entry;
        }
        setState(() {
          _detailEntries = byId.values.toList(growable: false);
          _detailCursor = page.nextCursor;
          _detailHasMore = page.hasMore;
          _detailPageLoaded = true;
          _detailPageLoading = false;
          _detailLoadingMore = false;
        });
      },
      onError: (Object error) {
        if (!mounted) return;
        setState(() {
          _detailPageError = error;
          _detailPageLoading = false;
          _detailLoadingMore = false;
        });
      },
    );
  }

  @override
  Widget build(BuildContext context) {
    final fileChange = widget.fileChange;
    final bashRun = _loadedBashRun ?? widget.bashRun;
    final webSearch = widget.webSearch;
    final needsBashDetail =
        bashRun != null &&
        bashRun.output?.trim().isEmpty != false &&
        widget.toolUseId?.trim().isNotEmpty == true &&
        widget.loadToolDetail != null;
    final canExpand =
        fileChange != null ||
        bashRun != null ||
        webSearch != null ||
        (widget.toolUseId?.trim().isNotEmpty == true &&
            (widget.loadToolDetail != null ||
                widget.loadToolDetailPage != null));

    if (webSearch != null) {
      return Padding(
        padding: const EdgeInsets.symmetric(vertical: 4, horizontal: 2),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            _ActionSummaryLine(
              label: widget.label.trim().isNotEmpty
                  ? widget.label
                  : _webSearchActionSummaryLabel(
                      webSearch,
                      widget.lifecycle,
                      context.l10n,
                    ),
              icon: EcoIcons.activityAction(widget.icon),
              lifecycle: widget.lifecycle,
              expanded: _expanded,
              onTap: _toggleDetails,
            ),
            if (_expanded)
              Padding(
                padding: const EdgeInsets.only(top: 8),
                child: _WebSearchCard(
                  display: webSearch,
                  lifecycle: widget.lifecycle,
                ),
              ),
          ],
        ),
      );
    }
    if (fileChange != null) {
      return Padding(
        padding: const EdgeInsets.symmetric(vertical: 4, horizontal: 2),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            _ActionSummaryLine(
              label: widget.label.trim().isNotEmpty
                  ? widget.label
                  : fileChange.fileName,
              icon: EcoIcons.activityAction(widget.icon),
              lifecycle: widget.lifecycle,
              expanded: _expanded,
              additions: fileChange.additions,
              deletions: fileChange.deletions,
              onTap: _toggleDetails,
            ),
            if (_expanded)
              Padding(
                padding: const EdgeInsets.only(top: 8),
                child: _FileChangeCard(
                  display: fileChange,
                  lifecycle: widget.lifecycle,
                ),
              ),
          ],
        ),
      );
    }
    if (bashRun != null) {
      final summaryLabel =
          widget.preferFormattedLabel && widget.label.trim().isNotEmpty
          ? widget.label.trim()
          : _bashActionSummaryLabel(bashRun, widget.lifecycle, context.l10n);
      return Padding(
        padding: const EdgeInsets.symmetric(vertical: 4, horizontal: 2),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            _ActionSummaryLine(
              label: summaryLabel,
              icon: EcoIcons.activityAction(widget.icon),
              lifecycle: widget.lifecycle,
              expanded: _expanded,
              onTap: _toggleDetails,
            ),
            if (_expanded)
              Padding(
                padding: const EdgeInsets.only(top: 8),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    _BashRunCard(
                      display: bashRun,
                      lifecycle: widget.lifecycle,
                      showHeader: false,
                    ),
                    if (needsBashDetail &&
                        _detailFuture != null &&
                        _loadedBashRun == null &&
                        _bashDetailError == null)
                      const Padding(
                        padding: EdgeInsets.only(top: 10),
                        child: Center(
                          child: SizedBox(
                            width: 16,
                            height: 16,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          ),
                        ),
                      ),
                    if (_bashDetailError != null)
                      Padding(
                        padding: const EdgeInsets.only(top: 8),
                        child: Text(
                          localizedAppError(_bashDetailError!, context.l10n),
                          style: activityFeedBodyStyle(
                            context,
                            color: ecoColors(context).statusDenyText,
                            height: 1.4,
                          ),
                        ),
                      ),
                  ],
                ),
              ),
          ],
        ),
      );
    }
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 3, horizontal: 2),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          _ActionSummaryLine(
            label: widget.label,
            icon: EcoIcons.activityAction(widget.icon),
            lifecycle: widget.lifecycle,
            expanded: canExpand ? _expanded : false,
            onTap: canExpand ? _toggleDetails : null,
          ),
          if (_expanded && widget.loadToolDetailPage != null)
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: _PagedInlineToolDetail(
                entries: _detailEntries,
                loading: _detailPageLoading,
                loadingMore: _detailLoadingMore,
                error: _detailPageError,
                hasMore: _detailHasMore,
                onRetry: _detailPageLoading
                    ? null
                    : () => _requestDetailPage(
                        cursor: _detailPageLoaded ? _detailCursor : null,
                        append: _detailPageLoaded,
                      ),
                onLoadMore: _detailLoadingMore || _detailCursor == null
                    ? null
                    : () => _requestDetailPage(
                        cursor: _detailCursor,
                        append: true,
                      ),
              ),
            )
          else if (_expanded && _detailFuture != null)
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: _InlineToolDetail(future: _detailFuture!),
            ),
        ],
      ),
    );
  }
}

class _ImageViewTile extends StatefulWidget {
  const _ImageViewTile({
    required this.entry,
    this.loadImageView,
    this.onOpenImageDisplayArtifact,
  });

  final ActivityFeedEntry entry;
  final ActivityFeedImageViewLoader? loadImageView;
  final ValueChanged<String>? onOpenImageDisplayArtifact;

  @override
  State<_ImageViewTile> createState() => _ImageViewTileState();
}

class _ImageViewTileState extends State<_ImageViewTile> {
  var _expanded = false;
  Future<ImageViewReadData>? _imageFuture;

  @override
  void didUpdateWidget(covariant _ImageViewTile oldWidget) {
    super.didUpdateWidget(oldWidget);
    final oldImage = oldWidget.entry.imageView;
    final image = widget.entry.imageView;
    if (oldImage?.path != image?.path || oldImage?.eventId != image?.eventId) {
      _expanded = false;
      _imageFuture = null;
    }
  }

  Future<ImageViewReadData> _loadImage() async {
    final loader = widget.loadImageView;
    await Future<void>.value();
    if (loader == null) {
      throw const ImageViewReadException(
        ImageViewReadFailureCode.bridgeUnavailable,
      );
    }
    return loader(widget.entry);
  }

  Future<ImageViewReadData> _startImageLoad() {
    final future = _loadImage();
    // A fast failure can complete before FutureBuilder attaches its listener.
    future.then<void>(
      (_) {},
      onError: (Object error, StackTrace stackTrace) {},
    );
    return future;
  }

  void _toggleDetails() {
    if (_expanded) {
      setState(() => _expanded = false);
      return;
    }
    final path = widget.entry.imageView?.path.trim() ?? '';
    if (path.startsWith('artifact:')) {
      final artifactId = path.substring('artifact:'.length).trim();
      if (artifactId.isNotEmpty) {
        widget.onOpenImageDisplayArtifact?.call(artifactId);
      }
    }
    setState(() {
      _expanded = true;
      _imageFuture ??= _startImageLoad();
    });
  }

  void _retry() {
    final future = _startImageLoad();
    setState(() {
      _imageFuture = future;
    });
  }

  Future<void> _openLightbox(ImageViewReadData image) {
    return showImageMemoryLightboxSingle(
      context,
      bytes: image.bytes,
      title: image.fileName,
    );
  }

  Widget _buildImageBody(BuildContext context, ImageViewReadData image) {
    final ratio = image.width > 0 && image.height > 0
        ? (image.width / image.height).clamp(0.25, 4.0).toDouble()
        : 1.0;
    return Semantics(
      button: true,
      label: context.l10n.activityImageViewOpen(image.fileName),
      child: InkWell(
        key: ValueKey('activity-image-view-preview-${widget.entry.id}'),
        onTap: () => unawaited(_openLightbox(image)),
        borderRadius: BorderRadius.circular(8),
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxHeight: 320),
          child: AspectRatio(
            aspectRatio: ratio,
            child: ClipRRect(
              borderRadius: BorderRadius.circular(8),
              child: ColoredBox(
                color: Colors.black12,
                child: Image.memory(
                  image.bytes,
                  key: ValueKey('activity-image-view-image-${widget.entry.id}'),
                  semanticLabel: context.l10n.activityImageViewPreviewAlt(
                    image.fileName,
                  ),
                  fit: BoxFit.contain,
                  gaplessPlayback: true,
                  filterQuality: FilterQuality.medium,
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  Widget _buildExpandedBody(BuildContext context) {
    final future = _imageFuture;
    if (future == null) return const SizedBox.shrink();
    return FutureBuilder<ImageViewReadData>(
      future: future,
      builder: (context, snapshot) {
        if (snapshot.connectionState != ConnectionState.done) {
          return Semantics(
            liveRegion: true,
            label: context.l10n.activityImageViewLoading,
            child: Padding(
              padding: const EdgeInsets.symmetric(vertical: 20),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  const SizedBox(
                    width: 20,
                    height: 20,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  ),
                  const SizedBox(height: 8),
                  Text(
                    context.l10n.activityImageViewLoading,
                    style: activityFeedBodyStyle(
                      context,
                      color: ecoColors(context).textMuted,
                    ),
                  ),
                ],
              ),
            ),
          );
        }
        if (snapshot.hasError || !snapshot.hasData) {
          final error =
              snapshot.error ??
              const ImageViewReadException(
                ImageViewReadFailureCode.invalidResponse,
              );
          final message = localizedAppError(error, context.l10n);
          return Semantics(
            liveRegion: true,
            label: message,
            child: Padding(
              padding: const EdgeInsets.symmetric(vertical: 8),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Icon(
                    EcoIcons.error,
                    size: 17,
                    color: ecoColors(context).statusDenyText,
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      message,
                      style: activityFeedBodyStyle(
                        context,
                        color: ecoColors(context).statusDenyText,
                        height: 1.4,
                      ),
                    ),
                  ),
                  IconButton(
                    tooltip: context.l10n.commonRetry,
                    visualDensity: VisualDensity.compact,
                    icon: Icon(EcoIcons.refresh, size: 17),
                    onPressed: _retry,
                  ),
                ],
              ),
            ),
          );
        }
        return _buildImageBody(context, snapshot.data!);
      },
    );
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4, horizontal: 2),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          _ActionSummaryLine(
            key: ValueKey('activity-image-view-summary-${widget.entry.id}'),
            label: widget.entry.text,
            icon: EcoIcons.activityAction(
              widget.entry.actionIcon ?? ActivityActionIcon.images,
            ),
            lifecycle: widget.entry.lifecycle,
            expanded: _expanded,
            onTap: _toggleDetails,
          ),
          if (_expanded)
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: _buildExpandedBody(context),
            ),
        ],
      ),
    );
  }
}

BashRunCardDisplay? _findBashRunDetail(List<ActivityFeedEntry> entries) {
  for (final entry in entries) {
    final bashRun = entry.bashRun;
    if (bashRun?.output?.trim().isNotEmpty == true) {
      return bashRun;
    }
    final nested = _findBashRunDetail(entry.actionChildren);
    if (nested != null) return nested;
  }
  return null;
}

List<ActivityFeedEntry> _flattenInlineToolDetailEntries(
  List<ActivityFeedEntry> entries,
) {
  final flattened = <ActivityFeedEntry>[];
  void add(ActivityFeedEntry entry) {
    if (entry.kind == ActivityFeedKind.actionGroup) {
      for (final child in entry.actionChildren) {
        add(child);
      }
      return;
    }
    flattened.add(entry);
  }

  for (final entry in entries) {
    add(entry);
  }
  return flattened;
}

bool _inlineToolDetailEntryHasBody(ActivityFeedEntry entry) {
  if (entry.kind != ActivityFeedKind.action) return true;
  return entry.bashRun != null ||
      entry.fileChange != null ||
      entry.webSearch != null ||
      (entry.detail ?? entry.text).trim().isNotEmpty;
}

Widget _inlineToolDetailBody(BuildContext context, ActivityFeedEntry entry) {
  if (entry.kind == ActivityFeedKind.action) {
    final bashRun = entry.bashRun;
    if (bashRun != null) {
      return _BashRunCard(
        display: bashRun,
        lifecycle: entry.lifecycle,
        showHeader: false,
      );
    }
    final fileChange = entry.fileChange;
    if (fileChange != null) {
      return _FileChangeCard(display: fileChange, lifecycle: entry.lifecycle);
    }
    final webSearch = entry.webSearch;
    if (webSearch != null) {
      return _WebSearchCard(display: webSearch, lifecycle: entry.lifecycle);
    }
    return EcoMarkdown(
      text: (entry.detail ?? entry.text).trim(),
      compact: true,
      muted: true,
      selectable: false,
      fontSizeScale: activityFeedBodyFontScale,
    );
  }
  return _ActivityFeedEntryTile(entry: entry);
}

class _PagedInlineToolDetail extends StatelessWidget {
  const _PagedInlineToolDetail({
    required this.entries,
    required this.loading,
    required this.loadingMore,
    required this.error,
    required this.hasMore,
    this.onRetry,
    this.onLoadMore,
  });

  final List<ActivityFeedEntry> entries;
  final bool loading;
  final bool loadingMore;
  final Object? error;
  final bool hasMore;
  final VoidCallback? onRetry;
  final VoidCallback? onLoadMore;

  @override
  Widget build(BuildContext context) {
    if (loading && entries.isEmpty) {
      return const Padding(
        padding: EdgeInsets.symmetric(vertical: 12),
        child: Center(
          child: SizedBox(
            width: 18,
            height: 18,
            child: CircularProgressIndicator(strokeWidth: 2),
          ),
        ),
      );
    }

    final visible = _flattenInlineToolDetailEntries(
      entries,
    ).where(_inlineToolDetailEntryHasBody).toList(growable: false);
    final children = <Widget>[
      if (visible.isEmpty && error == null && !loading)
        Text(
          context.l10n.threadNoToolDetails,
          style: activityFeedBodyStyle(
            context,
            color: ecoColors(context).textMuted,
            height: 1.4,
          ),
        ),
      for (final entry in visible)
        KeyedSubtree(
          key: ValueKey('inline-tool-detail:${entry.id}'),
          child: _inlineToolDetailBody(context, entry),
        ),
      if (error != null)
        Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Expanded(
              child: Text(
                localizedAppError(error!, context.l10n),
                style: activityFeedBodyStyle(
                  context,
                  color: ecoColors(context).statusDenyText,
                  height: 1.4,
                ),
              ),
            ),
            if (onRetry != null)
              TextButton(
                onPressed: onRetry,
                child: Text(context.l10n.commonRetry),
              ),
          ],
        ),
      if (loadingMore)
        const Padding(
          padding: EdgeInsets.symmetric(vertical: 8),
          child: Center(
            child: SizedBox(
              width: 16,
              height: 16,
              child: CircularProgressIndicator(strokeWidth: 2),
            ),
          ),
        )
      else if (hasMore && onLoadMore != null)
        Align(
          alignment: Alignment.centerLeft,
          child: TextButton(
            onPressed: onLoadMore,
            child: Text(context.l10n.threadLoadMoreToolDetails),
          ),
        ),
    ];

    return Padding(
      padding: const EdgeInsets.only(left: 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: children,
      ),
    );
  }
}

class _InlineToolDetail extends StatelessWidget {
  const _InlineToolDetail({required this.future});

  final Future<List<ActivityFeedEntry>> future;

  @override
  Widget build(BuildContext context) {
    return FutureBuilder<List<ActivityFeedEntry>>(
      future: future,
      builder: (context, snapshot) {
        if (snapshot.connectionState != ConnectionState.done) {
          return const Padding(
            padding: EdgeInsets.symmetric(vertical: 12),
            child: Center(
              child: SizedBox(
                width: 18,
                height: 18,
                child: CircularProgressIndicator(strokeWidth: 2),
              ),
            ),
          );
        }
        if (snapshot.hasError) {
          return Text(
            localizedAppError(snapshot.error!, context.l10n),
            style: activityFeedBodyStyle(
              context,
              color: ecoColors(context).statusDenyText,
              height: 1.4,
            ),
          );
        }
        final entries = _flattenInlineToolDetailEntries(
          snapshot.data ?? const [],
        ).where(_inlineToolDetailEntryHasBody).toList();
        if (entries.isEmpty) {
          return Text(
            context.l10n.threadNoToolDetails,
            style: activityFeedBodyStyle(
              context,
              color: ecoColors(context).textMuted,
              height: 1.4,
            ),
          );
        }
        return Padding(
          padding: const EdgeInsets.only(left: 12),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              for (final entry in entries)
                KeyedSubtree(
                  key: ValueKey('inline-tool-detail:${entry.id}'),
                  child: _inlineToolDetailBody(context, entry),
                ),
            ],
          ),
        );
      },
    );
  }
}

String _bashActionSummaryLabel(
  BashRunCardDisplay display,
  ToolActionLifecycle? lifecycle,
  AppLocalizations l10n,
) {
  final command = display.command?.trim();
  final title = display.title.trim();
  final payload = ActionKindPayload(
    bashRun: ActionKindBashRun(
      command: command == null || command.isEmpty ? null : command,
    ),
  );
  final rawTarget = command != null && command.isNotEmpty
      ? command
      : (title.isNotEmpty && title != 'Shell' ? title : null);
  return formatActionLine(
    resolved: resolveActionKind(toolName: 'Bash', payload: payload),
    phase: lifecycle == ToolActionLifecycle.running
        ? ActionLinePhase.running
        : ActionLinePhase.done,
    rawTarget: rawTarget,
    payload: payload,
    l10n: l10n,
  );
}

String _webSearchActionSummaryLabel(
  WebSearchCardDisplay display,
  ToolActionLifecycle? lifecycle,
  AppLocalizations l10n,
) {
  final title = display.title.trim();
  if (title.isEmpty) {
    return display.kind == 'fetch'
        ? l10n.activityWebSearchFetch
        : l10n.activityWebSearch;
  }
  return title;
}

String? _webSearchStatusText(
  WebSearchCardDisplay display,
  ToolActionLifecycle? lifecycle,
  AppLocalizations l10n,
) {
  switch (display.status) {
    case 'started':
      return display.kind == 'fetch'
          ? l10n.activityWebSearchFetching
          : l10n.activityWebSearchSearching;
    case 'failed':
      return l10n.activityWebSearchFailed;
    case 'completed':
      return l10n.activityWebSearchCompleted;
  }
  if (lifecycle == ToolActionLifecycle.running) {
    return display.kind == 'fetch'
        ? l10n.activityWebSearchFetching
        : l10n.activityWebSearchSearching;
  }
  if (lifecycle == ToolActionLifecycle.failed) {
    return l10n.activityWebSearchFailed;
  }
  return null;
}

class _WebSearchCard extends StatelessWidget {
  const _WebSearchCard({required this.display, this.lifecycle});

  final WebSearchCardDisplay display;
  final ToolActionLifecycle? lifecycle;

  @override
  Widget build(BuildContext context) {
    final eco = ecoColors(context);
    final status = _webSearchStatusText(display, lifecycle, context.l10n);
    final rows = <Widget>[];

    void addRow(String label, String? value) {
      final normalized = value?.trim();
      if (normalized == null || normalized.isEmpty) return;
      rows.add(
        Padding(
          padding: EdgeInsets.only(top: rows.isEmpty ? 0 : 7),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              SizedBox(
                width: 48,
                child: Text(
                  label,
                  style: Theme.of(context).textTheme.labelSmall?.copyWith(
                    color: eco.textMuted,
                    height: 1.35,
                  ),
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  normalized,
                  style: activityFeedBodyStyle(
                    context,
                    color: eco.textSecondary,
                    height: 1.35,
                  ),
                ),
              ),
            ],
          ),
        ),
      );
    }

    addRow(context.l10n.activityWebSearchQuery, display.query);
    addRow(context.l10n.activityWebSearchStatus, status);
    addRow(context.l10n.activityWebSearchAction, display.actionLabel);
    addRow('URL', display.url);
    addRow(context.l10n.activityWebSearchPattern, display.pattern);
    if (display.queries.length > 1) {
      addRow(
        context.l10n.activityWebSearchQueries,
        display.queries.join(
          context.l10n.localeName.startsWith('zh') ? '、' : ', ',
        ),
      );
    }
    if (display.meta != null) {
      addRow(context.l10n.activityWebSearchDuration, display.meta);
    }

    if (rows.isEmpty) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.only(left: 12),
      child: DecoratedBox(
        decoration: BoxDecoration(
          border: Border(left: BorderSide(color: eco.borderSubtle)),
        ),
        child: Padding(
          padding: const EdgeInsets.only(left: 12),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: rows,
          ),
        ),
      ),
    );
  }
}

class _ActionSummaryLine extends StatelessWidget {
  const _ActionSummaryLine({
    super.key,
    required this.label,
    required this.icon,
    this.iconKey,
    this.lifecycle,
    this.expanded = false,
    this.additions = 0,
    this.deletions = 0,
    this.onTap,
  });

  final String label;
  final IconData icon;
  final Key? iconKey;
  final ToolActionLifecycle? lifecycle;
  final bool expanded;
  final int additions;
  final int deletions;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final eco = ecoColors(context);
    final failed = lifecycle == ToolActionLifecycle.failed;

    final content = Row(
      children: [
        Icon(icon, key: iconKey, size: 15, color: eco.textMuted),
        const SizedBox(width: 8),
        Expanded(
          child: Row(
            children: [
              Flexible(
                child: lifecycle == ToolActionLifecycle.running
                    ? ShimmerText(
                        text: label,
                        baseColor: eco.textMuted,
                        highlightColor: eco.textSecondary,
                        style: activityFeedBodyStyle(
                          context,
                          color: eco.textMuted,
                          height: 1.35,
                        )?.copyWith(fontWeight: FontWeight.w500),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      )
                    : Text(
                        label,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: activityFeedBodyStyle(
                          context,
                          color: eco.textMuted,
                          height: 1.35,
                        )?.copyWith(fontWeight: FontWeight.w500),
                      ),
              ),
              if (failed) ...[
                const SizedBox(width: 6),
                Semantics(
                  label: context.l10n.activityFailed,
                  child: Container(
                    key: const ValueKey('activity-tool-failure-dot'),
                    width: 4,
                    height: 4,
                    decoration: BoxDecoration(
                      color: eco.statusDenyText.withValues(alpha: 0.58),
                      shape: BoxShape.circle,
                    ),
                  ),
                ),
              ],
              // Match desktop: no permanent disclosure chevron.
              // Only reveal after expand (hover is unavailable on mobile).
              if (onTap != null && expanded) ...[
                const SizedBox(width: 4),
                Icon(EcoIcons.expandUp, size: 17, color: eco.textMuted),
              ],
            ],
          ),
        ),
        if (additions > 0 || deletions > 0) ...[
          const SizedBox(width: 8),
          _InlineDiffStats(additions: additions, deletions: deletions),
        ],
      ],
    );

    if (onTap == null) {
      return Padding(
        padding: const EdgeInsets.symmetric(vertical: 3),
        child: content,
      );
    }

    return Material(
      color: Colors.transparent,
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(8),
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 5),
          child: content,
        ),
      ),
    );
  }
}

class _InlineDiffStats extends StatelessWidget {
  const _InlineDiffStats({required this.additions, required this.deletions});

  final int additions;
  final int deletions;

  @override
  Widget build(BuildContext context) {
    final diffPalette = FileChangeDiffPalette.of(ecoColors(context));
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        if (additions > 0)
          Text(
            '+$additions',
            style: TextStyle(
              color: diffPalette.addStat,
              fontWeight: FontWeight.w600,
              fontSize: 12,
              fontFeatures: const [FontFeature.tabularFigures()],
            ),
          ),
        if (additions > 0 && deletions > 0) const SizedBox(width: 8),
        if (deletions > 0)
          Text(
            '-$deletions',
            style: TextStyle(
              color: diffPalette.removeStat,
              fontWeight: FontWeight.w600,
              fontSize: 12,
              fontFeatures: const [FontFeature.tabularFigures()],
            ),
          ),
      ],
    );
  }
}

class _BashRunCard extends StatefulWidget {
  const _BashRunCard({
    required this.display,
    this.lifecycle,
    this.showHeader = true,
  });

  final BashRunCardDisplay display;
  final ToolActionLifecycle? lifecycle;
  final bool showHeader;

  @override
  State<_BashRunCard> createState() => _BashRunCardState();
}

class _BashRunCardState extends State<_BashRunCard> {
  static const _collapsedCommandLines = 2;
  static const _collapsedOutputLines = 3;
  bool _bodyExpanded = false;

  @override
  Widget build(BuildContext context) {
    final display = widget.display;
    // Bash cards only surface failure — not a live "running" state (unlike
    // subagent missions). Lifecycle often stays `running` in projection data.
    final failed = widget.lifecycle == ToolActionLifecycle.failed;
    final eco = ecoColors(context);
    final command = display.command?.trim() ?? '';
    final output = display.output?.trim() ?? '';
    final bodyStyle = Theme.of(context).textTheme.bodySmall?.copyWith(
      color: eco.textSecondary,
      fontFamily: 'Menlo',
      height: 1.4,
    );

    return LayoutBuilder(
      builder: (context, constraints) {
        final bodyMaxWidth = constraints.maxWidth - 24;
        final textWidth = bodyMaxWidth > 0
            ? bodyMaxWidth
            : constraints.maxWidth;
        final commandCanExpand =
            command.isNotEmpty &&
            _textExceedsLineLimit(
              text: command,
              style: bodyStyle,
              maxWidth: textWidth - 18,
              maxLines: _collapsedCommandLines,
              textDirection: Directionality.of(context),
            );
        final outputCanExpand =
            output.isNotEmpty &&
            _textExceedsLineLimit(
              text: output,
              style: bodyStyle,
              maxWidth: textWidth,
              maxLines: _collapsedOutputLines,
              textDirection: Directionality.of(context),
            );
        final canExpand = commandCanExpand || outputCanExpand;

        return ActivityFeedBlock(
          onTap: canExpand
              ? () => setState(() => _bodyExpanded = !_bodyExpanded)
              : null,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              if (widget.showHeader)
                ActivityFeedBlockHeader(
                  icon: EcoIcons.terminal,
                  title: display.title,
                  meta: display.meta,
                  iconColor: failed ? eco.danger : eco.textMuted,
                  titleColor: failed ? eco.danger : null,
                  expanded: canExpand ? _bodyExpanded : null,
                  trailing: failed
                      ? ActivityFeedStatusChip(
                          label: context.l10n.activityFailed,
                          danger: true,
                        )
                      : null,
                ),
              if (command.isNotEmpty || output.isNotEmpty) ...[
                if (widget.showHeader) const ActivityFeedBlockDivider(),
                if (command.isNotEmpty)
                  _BashCommandBody(
                    command: command,
                    style: bodyStyle,
                    expanded: _bodyExpanded || !commandCanExpand,
                  ),
                if (command.isNotEmpty && output.isNotEmpty)
                  const ActivityFeedBlockDivider(),
                if (output.isNotEmpty)
                  _BashOutputBody(
                    output: output,
                    style: bodyStyle,
                    expanded: _bodyExpanded || !outputCanExpand,
                  ),
              ],
            ],
          ),
        );
      },
    );
  }
}

class _BashCommandBody extends StatelessWidget {
  const _BashCommandBody({
    required this.command,
    required this.style,
    required this.expanded,
  });

  final String command;
  final TextStyle? style;
  final bool expanded;

  @override
  Widget build(BuildContext context) {
    final eco = ecoColors(context);
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(r'$', style: style?.copyWith(color: eco.textMuted)),
          const SizedBox(width: 6),
          Expanded(
            child: expanded
                ? SelectableText(command, style: style)
                : Text(
                    command,
                    maxLines: _BashRunCardState._collapsedCommandLines,
                    overflow: TextOverflow.clip,
                    style: style,
                  ),
          ),
        ],
      ),
    );
  }
}

class _BashOutputBody extends StatelessWidget {
  const _BashOutputBody({
    required this.output,
    required this.style,
    required this.expanded,
  });

  final String output;
  final TextStyle? style;
  final bool expanded;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      child: expanded
          ? SelectableText(output, style: style)
          : Text(
              output,
              maxLines: _BashRunCardState._collapsedOutputLines,
              overflow: TextOverflow.clip,
              style: style,
            ),
    );
  }
}

bool _textExceedsLineLimit({
  required String text,
  required TextStyle? style,
  required double maxWidth,
  required int maxLines,
  required TextDirection textDirection,
}) {
  final painter = TextPainter(
    text: TextSpan(text: text, style: style),
    maxLines: maxLines,
    textDirection: textDirection,
  )..layout(maxWidth: maxWidth);
  return painter.didExceedMaxLines;
}

class _FileChangeCard extends StatefulWidget {
  const _FileChangeCard({required this.display, this.lifecycle});

  final FileChangeCardDisplay display;
  final ToolActionLifecycle? lifecycle;

  @override
  State<_FileChangeCard> createState() => _FileChangeCardState();
}

class _FileChangeCardState extends State<_FileChangeCard> {
  static const _collapsedLineLimit = 6;
  bool _expanded = false;

  @override
  Widget build(BuildContext context) {
    final display = widget.display;
    final lifecycle = widget.lifecycle;
    final eco = ecoColors(context);
    final running = lifecycle == ToolActionLifecycle.running;
    final failed = lifecycle == ToolActionLifecycle.failed;
    final previewLines = _expanded
        ? display.previewLines
        : display.previewLines.take(_collapsedLineLimit).toList();
    final hasMore = display.previewLines.length > _collapsedLineLimit;

    final lineStyle = Theme.of(context).textTheme.bodySmall?.copyWith(
      fontFamily: 'Menlo',
      height: 1.45,
      color: eco.textSecondary,
    );
    final diffPalette = FileChangeDiffPalette.of(eco);

    String? diffMeta;
    if (display.additions > 0 || display.deletions > 0) {
      final parts = <String>[];
      if (display.additions > 0) parts.add('+${display.additions}');
      if (display.deletions > 0) parts.add('-${display.deletions}');
      diffMeta = parts.join(' ');
    }

    return ActivityFeedBlock(
      onTap: hasMore ? () => setState(() => _expanded = !_expanded) : null,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          ActivityFeedBlockHeader(
            icon: EcoIcons.file,
            title: display.fileName,
            meta: diffMeta,
            iconColor: failed ? eco.danger : eco.textMuted,
            expanded: hasMore ? _expanded : null,
            trailing: failed
                ? ActivityFeedStatusChip(
                    label: context.l10n.activityFailed,
                    danger: true,
                  )
                : running
                ? ActivityFeedStatusChip(
                    label: context.l10n.threadRunRunning,
                    active: true,
                  )
                : null,
          ),
          const ActivityFeedBlockDivider(),
          EcoClippedFadeBody(
            expanded: _expanded,
            collapsedMaxHeight: 148,
            showFade: !_expanded && hasMore,
            child: Padding(
              padding: EdgeInsets.only(top: 6, bottom: _expanded ? 10 : 6),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  for (final line in previewLines)
                    EcoDiffGutterLine(
                      text: line.text,
                      gutterColor: diffPalette.gutterFor(line.kind),
                      backgroundColor: diffPalette.backgroundFor(line.kind),
                      style: lineStyle,
                    ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _PhaseTile extends StatelessWidget {
  const _PhaseTile({
    required this.text,
    this.detail,
    this.icon,
    this.lifecycle,
  });

  final String text;
  final String? detail;
  final ActivityActionIcon? icon;
  final ToolActionLifecycle? lifecycle;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (icon != null)
            _ActionSummaryLine(
              label: text,
              icon: EcoIcons.activityAction(icon!),
              lifecycle: lifecycle,
            )
          else
            Text(
              text,
              style: activityFeedBodyStyle(
                context,
                color: ecoColors(context).textMuted,
                height: 1.4,
              ),
            ),
          if (detail != null && detail!.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Text(
                detail!,
                style: Theme.of(context).textTheme.bodySmall?.copyWith(
                  color: ecoColors(context).textMuted,
                  height: 1.35,
                ),
              ),
            ),
        ],
      ),
    );
  }
}

class _ReconnectPhaseTile extends StatefulWidget {
  const _ReconnectPhaseTile({required this.summary, this.detail});

  final String summary;
  final String? detail;

  @override
  State<_ReconnectPhaseTile> createState() => _ReconnectPhaseTileState();
}

class _ReconnectPhaseTileState extends State<_ReconnectPhaseTile>
    with SingleTickerProviderStateMixin {
  var _expanded = false;
  late final AnimationController _spinController;

  @override
  void initState() {
    super.initState();
    _spinController = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 1200),
    );
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (!_isFailure) {
      _spinController.repeat();
    } else {
      _spinController.stop();
    }
  }

  @override
  void dispose() {
    _spinController.dispose();
    super.dispose();
  }

  bool get _isFailure =>
      widget.summary.startsWith(context.l10n.activityConnectionFailed);

  bool get _hasDetail =>
      widget.detail != null && widget.detail!.trim().isNotEmpty;

  @override
  Widget build(BuildContext context) {
    final eco = ecoColors(context);
    final summaryColor = _isFailure ? eco.statusDenyText : eco.textSecondary;
    final iconColor = _isFailure ? eco.statusDenyText : eco.textMuted;

    final summaryRow = Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (_isFailure)
          Padding(
            padding: const EdgeInsets.only(top: 1),
            child: Icon(EcoIcons.error, size: 16, color: iconColor),
          )
        else
          Padding(
            padding: const EdgeInsets.only(top: 1),
            child: RotationTransition(
              turns: _spinController,
              child: Icon(EcoIcons.refresh, size: 16, color: iconColor),
            ),
          ),
        const SizedBox(width: 8),
        Expanded(
          child: Text(
            widget.summary,
            style: Theme.of(context).textTheme.bodySmall?.copyWith(
              color: summaryColor,
              fontWeight: FontWeight.w500,
              height: 1.35,
            ),
          ),
        ),
        if (_hasDetail)
          Icon(
            _expanded ? Icons.expand_less : Icons.expand_more,
            size: 18,
            color: eco.textMuted,
          ),
      ],
    );

    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Material(
        color: Colors.transparent,
        child: InkWell(
          onTap: _hasDetail
              ? () => setState(() => _expanded = !_expanded)
              : null,
          borderRadius: BorderRadius.circular(8),
          child: Padding(
            padding: const EdgeInsets.symmetric(vertical: 2),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                summaryRow,
                if (_hasDetail && _expanded)
                  Container(
                    margin: const EdgeInsets.only(left: 24, top: 6),
                    padding: const EdgeInsets.all(10),
                    decoration: BoxDecoration(
                      color: eco.codeBg,
                      borderRadius: BorderRadius.circular(8),
                      border: Border.all(color: eco.borderSubtle),
                    ),
                    child: SelectableText(
                      widget.detail!.trim(),
                      style: Theme.of(context).textTheme.bodySmall?.copyWith(
                        color: eco.textMuted,
                        fontFamily: 'monospace',
                        height: 1.4,
                      ),
                    ),
                  ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _SubagentMissionTile extends StatefulWidget {
  const _SubagentMissionTile({
    required this.role,
    required this.summary,
    this.prompt,
    this.taskName,
    this.agentId,
    this.attachments = const [],
    this.themeSource,
    this.running = false,
    this.durationMs = 0,
    this.statusText,
    this.timeline = const [],
    this.onOpenDetail,
  });

  final String role;
  final String summary;
  final String? prompt;
  final String? taskName;
  final String? agentId;
  final List<PromptImageAttachment> attachments;
  final SubagentThemeSource? themeSource;
  final bool running;
  final int durationMs;
  final String? statusText;
  final List<SubagentTimelineEntry> timeline;
  final VoidCallback? onOpenDetail;

  @override
  State<_SubagentMissionTile> createState() => _SubagentMissionTileState();
}

class _SubagentMissionTileState extends State<_SubagentMissionTile> {
  var _expanded = false;
  late int _liveDurationMs;
  Timer? _durationTimer;
  String? _latchedAgentId;
  String _latchedMissionText = '';
  var _latchedHasTimeline = false;

  String _resolvedMissionText() {
    final trimmedPrompt = widget.prompt?.trim() ?? '';
    final trimmedSummary = widget.summary.trim();
    final incoming = resolveMissionDisplayText(
      trimmedPrompt.isNotEmpty ? trimmedPrompt : trimmedSummary,
    );
    if (_latchedAgentId != widget.agentId) {
      _latchedAgentId = widget.agentId;
      _latchedMissionText = '';
      _latchedHasTimeline = false;
    }
    if (incoming.isNotEmpty) {
      _latchedMissionText = incoming;
    }
    if (widget.timeline.isNotEmpty) {
      _latchedHasTimeline = true;
    }
    return _latchedMissionText.isNotEmpty ? _latchedMissionText : incoming;
  }

  @override
  void initState() {
    super.initState();
    _liveDurationMs = widget.durationMs;
    _syncDurationTimer();
  }

  @override
  void didUpdateWidget(covariant _SubagentMissionTile oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!widget.running) {
      _liveDurationMs = widget.durationMs;
    } else if (oldWidget.durationMs != widget.durationMs) {
      _liveDurationMs = widget.durationMs;
    }
    _syncDurationTimer();
  }

  void _syncDurationTimer() {
    _durationTimer?.cancel();
    _durationTimer = null;
    if (!widget.running) return;
    final baselineMs = widget.durationMs;
    final anchorAt = DateTime.now();
    _durationTimer = Timer.periodic(const Duration(seconds: 1), (_) {
      if (!mounted) return;
      setState(() {
        _liveDurationMs =
            baselineMs + DateTime.now().difference(anchorAt).inMilliseconds;
      });
    });
  }

  @override
  Widget build(BuildContext context) {
    final eco = ecoColors(context);
    final role = normalizeAgentDisplayRole(widget.role) ?? widget.role;
    final fullText = _resolvedMissionText();
    final previewText = thinkingPreviewLine(fullText);
    final hasTimeline = widget.timeline.isNotEmpty || _latchedHasTimeline;
    final roleColor = resolveSubagentThemeColor(
      role,
      agents: widget.themeSource?.agents ?? const [],
    );
    final statusText = widget.statusText?.trim();
    final showStatus =
        fullText.isEmpty && statusText != null && statusText.isNotEmpty;
    final durationLabel = formatSubagentDuration(
      widget.running ? _liveDurationMs : widget.durationMs,
      running: widget.running,
      l10n: context.l10n,
    );

    final onTap =
        widget.onOpenDetail ?? () => setState(() => _expanded = !_expanded);
    final expanded = widget.onOpenDetail == null && _expanded;
    final title = role == 'vision' && widget.attachments.isNotEmpty
        ? context.l10n.activityViewImages(widget.attachments.length)
        : resolveSubagentActivityTitle(
            resolveSubagentRunDisplayTitle(role, context.l10n),
            widget.taskName,
          );
    final titleStyle = activityFeedBodyStyle(
      context,
      color: eco.textMuted,
      height: 1.35,
    )?.copyWith(fontWeight: FontWeight.w500, fontSize: 13);
    final missionStyle = activityFeedBodyStyle(
      context,
      color: eco.textMuted,
      height: 1.45,
    )?.copyWith(fontSize: 12);

    return Semantics(
      button: true,
      expanded: expanded,
      label: context.l10n.activitySubagentTask(title),
      child: Material(
        color: Colors.transparent,
        child: InkWell(
          onTap: onTap,
          borderRadius: BorderRadius.circular(8),
          child: Padding(
            padding: const EdgeInsets.symmetric(vertical: 8, horizontal: 2),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Row(
                  children: [
                    Icon(EcoIcons.agent, size: 14, color: roleColor),
                    const SizedBox(width: 6),
                    Flexible(
                      child: widget.running
                          ? ShimmerText(
                              text: title,
                              baseColor: eco.textMuted,
                              highlightColor: eco.textSecondary,
                              style: titleStyle,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                            )
                          : Text(
                              title,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: titleStyle,
                            ),
                    ),
                    if (durationLabel.isNotEmpty) ...[
                      const SizedBox(width: 6),
                      Text(
                        durationLabel,
                        style: Theme.of(context).textTheme.labelSmall?.copyWith(
                          color: eco.textMuted,
                          fontFeatures: const [FontFeature.tabularFigures()],
                        ),
                      ),
                    ],
                  ],
                ),
                if (expanded && widget.attachments.isNotEmpty) ...[
                  const SizedBox(height: 8),
                  _SubagentImageStrip(attachments: widget.attachments),
                ],
                if (showStatus) ...[
                  const SizedBox(height: 4),
                  Text(
                    statusText,
                    maxLines: expanded ? null : 1,
                    overflow: expanded ? null : TextOverflow.ellipsis,
                    style: missionStyle,
                  ),
                ] else if (fullText.isEmpty) ...[
                  const SizedBox(height: 4),
                  Text(
                    context.l10n.activityWaitingMission,
                    style: missionStyle?.copyWith(fontStyle: FontStyle.italic),
                  ),
                ] else ...[
                  const SizedBox(height: 4),
                  if (expanded)
                    Text(fullText, style: missionStyle)
                  else
                    EcoClippedFadeBody(
                      expanded: false,
                      collapsedMaxHeight: 40,
                      showFade: fullText.length > 80,
                      child: Text(
                        previewText,
                        maxLines: 2,
                        overflow: TextOverflow.clip,
                        style: missionStyle,
                      ),
                    ),
                ],
                if (expanded && hasTimeline) ...[
                  const SizedBox(height: 8),
                  ...widget.timeline.map(
                    (item) => _SubagentTimelineRow(entry: item),
                  ),
                ] else if (expanded && widget.running) ...[
                  const SizedBox(height: 8),
                  Text(
                    context.l10n.activityWaitingEvents,
                    style: missionStyle?.copyWith(fontStyle: FontStyle.italic),
                  ),
                ],
              ],
            ),
          ),
        ),
      ),
    );
  }

  @override
  void dispose() {
    _durationTimer?.cancel();
    super.dispose();
  }
}

class _SubagentImageStrip extends StatelessWidget {
  const _SubagentImageStrip({required this.attachments});

  final List<PromptImageAttachment> attachments;

  Future<void> _open(BuildContext context, int index) async {
    final images = <Uint8List>[];
    final indexes = <int>[];
    for (var i = 0; i < attachments.length; i++) {
      try {
        images.add(base64Decode(attachments[i].data));
        indexes.add(i);
      } on FormatException {
        // Skip undecodable thumbnails.
      }
    }
    if (images.isEmpty) return;
    final start = indexes.indexOf(index).clamp(0, images.length - 1);
    await showImageMemoryLightbox(context, images: images, initialIndex: start);
  }

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      height: 88,
      child: ListView.separated(
        scrollDirection: Axis.horizontal,
        itemCount: attachments.length,
        separatorBuilder: (_, _) => const SizedBox(width: 6),
        itemBuilder: (context, index) => ClipRRect(
          borderRadius: BorderRadius.circular(8),
          child: SizedBox.square(
            dimension: 88,
            child: Material(
              color: Colors.transparent,
              child: InkWell(
                onTap: () => _open(context, index),
                child: Image.memory(
                  base64Decode(attachments[index].data),
                  fit: BoxFit.cover,
                  gaplessPlayback: true,
                  filterQuality: FilterQuality.medium,
                  errorBuilder: (_, _, _) =>
                      const Center(child: Icon(Icons.broken_image_outlined)),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _SubagentTimelineRow extends StatelessWidget {
  const _SubagentTimelineRow({required this.entry});

  final SubagentTimelineEntry entry;

  @override
  Widget build(BuildContext context) {
    if (entry.fileChange != null) {
      return Padding(
        padding: const EdgeInsets.symmetric(vertical: 4),
        child: _FileChangeCard(
          display: entry.fileChange!,
          lifecycle: entry.lifecycle,
        ),
      );
    }

    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 3),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (entry.icon != null)
            Padding(
              padding: const EdgeInsets.only(top: 1),
              child: Icon(
                _materialIcon(entry.icon!),
                size: 14,
                color: entry.isError
                    ? ecoColors(context).statusDenyText
                    : ecoColors(context).textMuted,
              ),
            )
          else
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: Container(
                width: 5,
                height: 5,
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  color: entry.isError
                      ? ecoColors(context).statusDenyText
                      : ecoColors(context).textMuted,
                ),
              ),
            ),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              entry.label,
              style: Theme.of(context).textTheme.bodySmall?.copyWith(
                color: entry.isError
                    ? ecoColors(context).statusDenyText
                    : ecoColors(context).textMuted,
                height: 1.35,
              ),
            ),
          ),
        ],
      ),
    );
  }

  IconData _materialIcon(ActivityActionIcon icon) =>
      EcoIcons.activityAction(icon);
}

class _ErrorTile extends StatefulWidget {
  const _ErrorTile({required this.text, this.onRetry});

  final String text;
  final Future<void> Function()? onRetry;

  @override
  State<_ErrorTile> createState() => _ErrorTileState();
}

class _ErrorTileState extends State<_ErrorTile> {
  bool _retrying = false;
  Object? _retryError;

  Future<void> _retry() async {
    final callback = widget.onRetry;
    if (callback == null || _retrying) return;
    setState(() {
      _retrying = true;
      _retryError = null;
    });
    try {
      await callback();
    } catch (error) {
      if (mounted) setState(() => _retryError = error);
    } finally {
      if (mounted) setState(() => _retrying = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.symmetric(vertical: 6),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: ecoColors(context).statusDenyBg,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: ecoColors(context).statusDenyBorder),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            widget.text,
            style: Theme.of(context).textTheme.bodySmall?.copyWith(
              color: ecoColors(context).statusDenyText,
              height: 1.4,
            ),
          ),
          if (widget.onRetry != null) ...[
            const SizedBox(height: 6),
            TextButton(
              onPressed: _retrying ? null : _retry,
              style: TextButton.styleFrom(
                minimumSize: const Size(0, 32),
                padding: const EdgeInsets.symmetric(horizontal: 8),
              ),
              child: _retrying
                  ? const SizedBox.square(
                      dimension: 14,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : Text(context.l10n.commonRetry),
            ),
          ],
          if (_retryError != null)
            Text(
              localizedAppError(_retryError!, context.l10n),
              style: Theme.of(context).textTheme.bodySmall?.copyWith(
                color: ecoColors(context).statusDenyText,
                height: 1.3,
              ),
            ),
        ],
      ),
    );
  }
}
