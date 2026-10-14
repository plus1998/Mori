import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:eco_mobile/l10n/generated/app_localizations.dart';
import 'package:flutter_localizations/flutter_localizations.dart';

import 'package:eco_mobile/core/models/git_models.dart';
import 'package:eco_mobile/core/models/image_view_models.dart';
import 'package:eco_mobile/core/models/thread_models.dart';
import 'package:eco_mobile/core/models/conversation_v2_projection_models.dart';
import 'package:eco_mobile/core/models/thread_runtime_config.dart';
import 'package:eco_mobile/core/preferences/thinking_display_preferences.dart';
import 'package:eco_mobile/core/theme/eco_icons.dart';
import 'package:eco_mobile/core/utils/agent_mission.dart';
import 'package:eco_mobile/core/utils/activity_display.dart';
import 'package:eco_mobile/core/utils/file_change.dart';
import 'package:eco_mobile/core/utils/stream_text.dart';
import 'package:eco_mobile/core/theme/eco_theme.dart';
import 'package:eco_mobile/core/theme/subagent_theme.dart';
import 'package:eco_mobile/core/utils/subagent_projection_feed.dart';
import 'package:eco_mobile/core/widgets/eco_markdown.dart';
import 'package:eco_mobile/features/threads/activity_feed.dart';

/// Test-only adapter for the legacy projection fixture shape. Production detail
/// loading is V2-only; these fixtures exercise the Feed's scoped timeline rules
/// without importing the retired session screen helpers.
List<ActivityFeedEntry> _toolActions(List<ActivityFeedEntry> entries) => [
  for (final entry in entries)
    if (entry.kind == ActivityFeedKind.action)
      entry
    else if (entry.kind == ActivityFeedKind.actionGroup)
      ...entry.actionChildren,
];

ThreadRunProjectionSnapshot _projectionDetailSnapshot({
  required String threadId,
  required ThreadRunProjectionSnapshot? base,
  required List<ThreadRunProjectionTimelineItem> timeline,
  bool normalizeItems = true,
}) {
  return ThreadRunProjectionSnapshot(
    threadId: base?.threadId ?? threadId,
    status: base?.status ?? '',
    generatedAt: base?.generatedAt ?? '',
    sourceEventCount: timeline.isNotEmpty ? timeline.length : 0,
    agents: const [],
    timeline: normalizeItems
        ? timeline.map(_projectionDetailTimelineItem).toList()
        : timeline,
    requestSpans: base?.requestSpans ?? const [],
    attempts: base?.attempts ?? const [],
  );
}

/// Legacy tool-detail mapper: keep agent-scoped tool/message items visible in
/// the shared feed builder by projecting them onto main scope.
ThreadRunProjectionTimelineItem _projectionDetailTimelineItem(
  ThreadRunProjectionTimelineItem item,
) {
  if (item.scope == 'main') return item;
  return ThreadRunProjectionTimelineItem(
    id: item.id,
    sequence: item.sequence,
    eventType: item.eventType,
    scope: 'main',
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

/// Desktop-aligned subagent detail rules:
/// - mission is shown once as a leading user bubble
/// - `@mission` envelopes / lifecycle events are suppressed
/// - agent-scope `message.user` follow-ups become user bubbles
/// - duplicate mission prompts are suppressed
ThreadRunProjectionTimelineItem? _projectionAgentDetailTimelineItem(
  ThreadRunProjectionTimelineItem item,
  String missionDisplay,
) {
  if (item.eventType == 'agent.started' ||
      item.eventType == 'agent.stopped' ||
      item.eventType == 'agent.abandoned') {
    return null;
  }
  if (item.eventType == 'thinking.final' && item.text.trim().isEmpty) {
    return null;
  }
  if (isSubagentMissionEnvelope(item.text)) {
    return null;
  }
  if (_isProjectionSubagentPromptItem(item)) {
    final text = resolveMissionDisplayText(item.text).trim();
    if (text.isEmpty) return null;
    if (missionDisplay.isNotEmpty && text == missionDisplay) return null;
    return ThreadRunProjectionTimelineItem(
      id: item.id,
      sequence: item.sequence,
      eventType: 'thread.status',
      scope: 'main',
      text: text,
      at: item.at,
      role: 'user',
      agentId: item.agentId,
      runAttemptId: item.runAttemptId,
      requestId: item.requestId,
      streamKey: item.streamKey,
      metadata: {...?item.metadata, 'liveType': 'thread.user_prompt'},
    );
  }
  if (item.scope == 'main') return item;
  return ThreadRunProjectionTimelineItem(
    id: item.id,
    sequence: item.sequence,
    eventType: item.eventType,
    scope: 'main',
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

bool _isProjectionSubagentPromptItem(ThreadRunProjectionTimelineItem item) {
  final liveType = item.metadata?['liveType'];
  return item.scope == 'agent' &&
      liveType == 'message.user' &&
      item.text.trim().isNotEmpty;
}

List<ThreadRunProjectionTimelineItem> _normalizeAgentDetailTimeline(
  List<ThreadRunProjectionTimelineItem> timeline, {
  required String missionDisplay,
}) {
  final mapped = <ThreadRunProjectionTimelineItem>[];
  for (final item in timeline) {
    final next = _projectionAgentDetailTimelineItem(item, missionDisplay);
    if (next != null) mapped.add(next);
  }

  // Match desktop: put follow-up prompt bubbles before their request.started.
  final ordered = <ThreadRunProjectionTimelineItem>[];
  for (var index = 0; index < mapped.length; index += 1) {
    final item = mapped[index];
    final next = index + 1 < mapped.length ? mapped[index + 1] : null;
    final itemLiveType = item.metadata?['liveType'];
    final nextLiveType = next?.metadata?['liveType'];
    if (item.eventType == 'request.started' &&
        item.requestId != null &&
        item.requestId!.isNotEmpty &&
        next != null &&
        next.requestId == item.requestId &&
        nextLiveType == 'thread.user_prompt' &&
        itemLiveType != 'thread.user_prompt') {
      ordered.add(next);
      ordered.add(item);
      index += 1;
      continue;
    }
    ordered.add(item);
  }

  if (missionDisplay.isEmpty) return ordered;
  return [
    ThreadRunProjectionTimelineItem(
      id: 'subagent-mission-prompt',
      sequence: -1,
      eventType: 'thread.status',
      scope: 'main',
      text: missionDisplay,
      at: ordered.isNotEmpty ? ordered.first.at : '',
      role: 'user',
      metadata: const {'liveType': 'thread.user_prompt'},
    ),
    ...ordered,
  ];
}

List<ActivityFeedEntry> buildProjectionDetailEntries({
  required String threadId,
  required ThreadRunProjectionSnapshot? base,
  required List<ThreadRunProjectionTimelineItem> cachedTimeline,
  required ThreadRunProjectionDetailResult? detail,
  required AppLocalizations l10n,
  String? missionText,
  bool injectMainThreadUserPrompts = true,
  ThinkingDisplayMode thinkingDisplayMode = defaultThinkingDisplayMode,
}) {
  final timeline = _mergeProjectionDetailTimeline(
    cachedTimeline,
    detail?.timeline ?? const [],
  );
  final missionDisplay = resolveMissionDisplayText(missionText ?? '').trim();

  if (!injectMainThreadUserPrompts) {
    final normalized = _normalizeAgentDetailTimeline(
      timeline,
      missionDisplay: missionDisplay,
    );
    final detailProjection = _projectionDetailSnapshot(
      threadId: threadId,
      base: base,
      timeline: normalized,
      normalizeItems: false,
    );
    return buildActivityFeed(
      threadPrompt: '',
      threadId: threadId,
      runProjection: detailProjection,
      l10n: l10n,
      thinkingDisplayMode: thinkingDisplayMode,
    );
  }

  // Tool rows expand a scoped timeline, not a chat turn.
  final detailProjection = _projectionDetailSnapshot(
    threadId: threadId,
    base: base,
    timeline: timeline,
  );
  return buildActivityFeed(
    threadPrompt: '',
    threadId: threadId,
    runProjection: detailProjection,
    l10n: l10n,
    groupTurns: false,
    groupActions: false,
    thinkingDisplayMode: thinkingDisplayMode,
  );
}

List<ThreadRunProjectionTimelineItem> _mergeProjectionDetailTimeline(
  List<ThreadRunProjectionTimelineItem> cached,
  List<ThreadRunProjectionTimelineItem> fresh,
) {
  if (cached.isEmpty) return fresh;
  if (fresh.isEmpty) return cached;
  final byId = <String, ThreadRunProjectionTimelineItem>{
    for (final item in cached) item.id: item,
  };
  for (final item in fresh) {
    byId[item.id] = item;
  }
  final merged = byId.values.toList();
  merged.sort((left, right) {
    final sequenceDelta = left.sequence.compareTo(right.sequence);
    if (sequenceDelta != 0) return sequenceDelta;
    final atDelta = left.at.compareTo(right.at);
    if (atDelta != 0) return atDelta;
    return left.id.compareTo(right.id);
  });
  return merged;
}

ThreadRunProjectionTimelineItem _toolTimelineItem({
  required String id,
  required int sequence,
  required String at,
  required String eventType,
  required String toolUseId,
  required String toolName,
  required String detail,
  required String requestId,
}) {
  final status = eventType == 'tool.completed' ? 'completed' : 'running';
  return ThreadRunProjectionTimelineItem(
    id: id,
    sequence: sequence,
    eventType: eventType,
    scope: 'main',
    role: 'tool',
    requestId: requestId,
    text: 'Tool: $toolName · $detail',
    at: at,
    metadata: {
      'liveType': eventType,
      'tool': {
        'name': toolName,
        'detail': detail,
        'toolUseId': toolUseId,
        'status': status,
      },
    },
  );
}

ThreadRunProjectionTimelineItem _codexMessageTimelineItem({
  required String id,
  required int sequence,
  required String at,
  required String text,
  required String requestId,
}) {
  final streamKey = 'msg_$id';
  return ThreadRunProjectionTimelineItem(
    id: id,
    sequence: sequence,
    eventType: 'message.final',
    scope: 'main',
    role: 'assistant',
    text: text,
    at: at,
    requestId: requestId,
    streamKey: streamKey,
    metadata: {
      'codexMethod': 'item/completed',
      'logicalEntityId': streamKey,
      'itemId': streamKey,
      'itemType': 'agentMessage',
    },
  );
}

final _onePixelPng = Uint8List.fromList(const [
  137,
  80,
  78,
  71,
  13,
  10,
  26,
  10,
  0,
  0,
  0,
  13,
  73,
  72,
  68,
  82,
  0,
  0,
  0,
  1,
  0,
  0,
  0,
  1,
  8,
  6,
  0,
  0,
  0,
  31,
  21,
  196,
  137,
  0,
  0,
  0,
  10,
  73,
  68,
  65,
  84,
  8,
  215,
  99,
  248,
  207,
  192,
  240,
  31,
  0,
  5,
  0,
  1,
  255,
  137,
  153,
  61,
  29,
  0,
  0,
  0,
  0,
  73,
  69,
  78,
  68,
  174,
  66,
  96,
  130,
]);

ImageViewReadData _imageViewData() => ImageViewReadData(
  bytes: _onePixelPng,
  mimeType: 'image/png',
  path: '/tmp/preview.png',
  fileName: 'preview.png',
  byteLength: _onePixelPng.length,
  width: 1,
  height: 1,
);

ThreadRunProjectionTimelineItem _thinkingTimelineItem({
  required String id,
  required String eventType,
  required String text,
  required int sequence,
  required String at,
  String? streamKey,
  String? requestId,
  Map<String, dynamic>? metadata,
}) {
  return ThreadRunProjectionTimelineItem(
    id: id,
    sequence: sequence,
    eventType: eventType,
    scope: 'main',
    role: 'thinking',
    text: text,
    at: at,
    requestId: requestId,
    streamKey: streamKey,
    metadata: metadata,
  );
}

List<ActivityFeedEntry> _flattenFeed(List<ActivityFeedEntry> entries) {
  return [
    for (final entry in entries)
      if (entry.kind == ActivityFeedKind.turn) ...[
        ...entry.processEntries,
        if (entry.finalOutput != null) entry.finalOutput!,
      ] else
        entry,
  ];
}

const _imageViewFeedEntry = ActivityFeedEntry(
  id: 'image-entry',
  kind: ActivityFeedKind.imageView,
  text: '已查看 1 张图像',
  actionIcon: ActivityActionIcon.images,
  lifecycle: ToolActionLifecycle.completed,
  imageView: ImageViewDisplay(path: '/tmp/preview.png', eventId: 'image-entry'),
);

void main() {
  test(
    'resolveSubagentDetailTitle prefers nickname and includes task name',
    () {
      expect(
        resolveSubagentDetailTitle(
          roleLabel: 'Coder',
          nickname: 'build-1',
          taskName: 'implement_export_filters',
        ),
        'build-1 · Implement Export Filters',
      );
    },
  );

  test('resolveSubagentDetailTitle falls back to role without a task name', () {
    expect(
      resolveSubagentDetailTitle(roleLabel: 'Explore', nickname: ' '),
      'Explore',
    );
  });

  test('isSessionContentBooting mirrors desktop boot overlay rules', () {
    const thread = ThreadSummary(
      id: 'thr_1',
      title: 'Test',
      prompt: '',
      workspacePath: '/tmp',
      status: 'idle',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      message: '',
    );

    expect(
      isSessionContentBooting(
        hasError: false,
        projectionReady: false,
        projectionSettled: false,
        projectionSynchronizing: false,
        loading: true,
        thread: null,
      ),
      isTrue,
    );
    expect(
      isSessionContentBooting(
        hasError: false,
        projectionReady: false,
        projectionSettled: false,
        projectionSynchronizing: true,
        loading: false,
        thread: thread,
      ),
      isTrue,
    );
    expect(
      isSessionContentBooting(
        hasError: false,
        projectionReady: false,
        projectionSettled: false,
        projectionSynchronizing: false,
        loading: false,
        thread: thread,
      ),
      isTrue,
    );
    expect(
      isSessionContentBooting(
        hasError: false,
        projectionReady: true,
        projectionSettled: true,
        projectionSynchronizing: false,
        loading: false,
        thread: thread,
      ),
      isFalse,
    );
    expect(
      isSessionContentBooting(
        hasError: false,
        projectionReady: false,
        projectionSettled: true,
        projectionSynchronizing: false,
        loading: false,
        thread: thread,
      ),
      isFalse,
    );
  });

  test('earlier Feed loading only triggers near the reverse list top', () {
    expect(
      shouldLoadEarlierActivityFeed(
        extentAfter: 80,
        hasEarlier: true,
        loadingEarlier: false,
        shrinkWrap: false,
      ),
      isTrue,
    );
    expect(
      shouldLoadEarlierActivityFeed(
        extentAfter: 240,
        hasEarlier: true,
        loadingEarlier: false,
        shrinkWrap: false,
      ),
      isFalse,
    );
    expect(
      shouldLoadEarlierActivityFeed(
        extentAfter: 0,
        hasEarlier: true,
        loadingEarlier: true,
        shrinkWrap: false,
      ),
      isFalse,
    );
    expect(
      shouldLoadEarlierActivityFeed(
        extentAfter: 0,
        hasEarlier: false,
        loadingEarlier: false,
        shrinkWrap: false,
      ),
      isFalse,
    );
  });

  testWidgets(
    'ActivityFeedList does not page earlier history when the Feed is a full skeleton',
    (tester) async {
      final scrollController = ScrollController();
      addTearDown(scrollController.dispose);
      var loadCount = 0;

      await tester.pumpWidget(
        _localizedMaterialApp(
          theme: buildEcoDarkTheme(),
          home: Scaffold(
            body: ActivityFeedList(
              entries: const [
                ActivityFeedEntry(
                  id: 'assistant-1',
                  kind: ActivityFeedKind.assistant,
                  text: 'Latest response',
                ),
              ],
              scrollController: scrollController,
              hasEarlier: false,
              onLoadEarlier: () async {
                loadCount += 1;
              },
            ),
          ),
        ),
      );
      await tester.pump();
      await tester.pump();

      expect(loadCount, 0);
      expect(find.byType(CircularProgressIndicator), findsNothing);
    },
  );

  testWidgets('ActivityFeedList keeps its viewport after prepending history', (
    tester,
  ) async {
    final scrollController = ScrollController();
    addTearDown(scrollController.dispose);
    var entries = List.generate(
      20,
      (index) => ActivityFeedEntry(
        id: 'assistant-${index + 20}',
        kind: ActivityFeedKind.assistant,
        text: 'Response ${index + 20}: ${List.filled(8, 'content').join(' ')}',
      ),
    );
    var hasEarlier = true;
    var loadCount = 0;

    await tester.pumpWidget(
      _localizedMaterialApp(
        theme: buildEcoDarkTheme(),
        home: Scaffold(
          body: StatefulBuilder(
            builder: (context, setHostState) => ActivityFeedList(
              entries: entries,
              scrollController: scrollController,
              hasEarlier: hasEarlier,
              onLoadEarlier: () async {
                loadCount += 1;
                setHostState(() {
                  entries = [
                    ...List.generate(
                      20,
                      (index) => ActivityFeedEntry(
                        id: 'assistant-$index',
                        kind: ActivityFeedKind.assistant,
                        text:
                            'Response $index: ${List.filled(8, 'earlier').join(' ')}',
                      ),
                    ),
                    ...entries,
                  ];
                  hasEarlier = false;
                });
              },
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(scrollController.position.maxScrollExtent, greaterThan(160));

    final offsetBefore = scrollController.position.maxScrollExtent - 40;
    scrollController.jumpTo(offsetBefore);
    await tester.pumpAndSettle();

    expect(loadCount, 1);
    expect(scrollController.offset, closeTo(offsetBefore, 1));
  });

  test('configuredOrchestrationSubagentRoles hides unconfigured roles', () {
    const snapshot = ResolvedOrchestrationSnapshot(
      selection: OrchestrationSelection(
        mainAgentConfigId: 'main-1',
        mainPrompt: BuiltinMainAgentPromptSelection(),
        subagents: NoneSubagentSelection(),
      ),
      mainAgentConfigName: 'Main',
      mainPromptDisplayName: 'Builtin',
      mainAgent: MainAgentConfig(
        agentKey: 'main',
        name: 'Main',
        systemPromptPreset: 'core_native',
        prompt: '',
        modelRef: OrchestrationModelRef(providerId: 'p1', modelId: 'm1'),
        tools: ToolPolicy(),
      ),
      agents: [
        AgentInstanceConfig(
          agentKey: 'coder',
          templateId: 'coder',
          modelRef: OrchestrationModelRef(providerId: 'p1', modelId: 'm1'),
          tools: ToolPolicy(),
        ),
      ],
      strategy: OrchestrationStrategy(kind: 'autonomous'),
      resolvedAt: '2026-07-27T00:00:00.000Z',
    );

    expect(configuredOrchestrationSubagentRoles(snapshot), ['coder']);
  });

  test('buildActivityFeed returns empty without projection', () {
    final feed = buildActivityFeed(threadPrompt: '', threadId: 't1');
    expect(feed, isEmpty);
  });

  test(
    'buildActivityFeed seeds threadPrompt only when the projection timeline is empty',
    () {
      final emptyFeed = buildActivityFeed(
        threadPrompt: '首条 TTS 调研',
        threadId: 't1',
        runProjection: const ThreadRunProjectionSnapshot(
          threadId: 't1',
          status: 'running',
          generatedAt: '2026-01-01T00:00:00.000Z',
          // Ready for the Feed builder, but still no timeline rows yet.
          sourceEventCount: 1,
          agents: [],
          timeline: [],
        ),
      );
      expect(emptyFeed, hasLength(1));
      expect(emptyFeed.single.kind, ActivityFeedKind.user);
      expect(emptyFeed.single.text, '首条 TTS 调研');
      expect(emptyFeed.single.id, 'user-prompt-t1');
    },
  );

  test(
    'buildActivityFeed does not inject threadPrompt over a user-less live delta',
    () {
      final feed = buildActivityFeed(
        threadPrompt: '首条 TTS 调研',
        threadId: 't1',
        runProjection: const ThreadRunProjectionSnapshot(
          threadId: 't1',
          status: 'running',
          generatedAt: '2026-01-01T00:00:02.000Z',
          sourceEventCount: 2,
          historyRevision: 4,
          agents: [],
          timeline: [
            ThreadRunProjectionTimelineItem(
              id: 'assistant-hf',
              sequence: 535,
              eventType: 'message.final',
              scope: 'main',
              role: 'planner',
              text: '我去查一下 Hugging Face 上常见开源 TTS 的部署形态和对外接口。',
              at: '2026-01-01T00:00:02.000Z',
            ),
          ],
        ),
      );

      expect(
        feed.any(
          (entry) =>
              entry.kind == ActivityFeedKind.user &&
              entry.text.contains('首条 TTS'),
        ),
        isFalse,
      );
      expect(feed.any((entry) => entry.text.contains('Hugging Face')), isTrue);
    },
  );

  test(
    'thread session keeps a populated V2 feed instead of optimistic prompt',
    () {
      const v2User = ActivityFeedEntry(
        id: 'message-v2-user',
        kind: ActivityFeedKind.user,
        text: 'V2_LONGCAT_E2E_20260922_0007：只回复 OK',
      );
      final display = resolveThreadSessionDisplayFeedEntries(
        feedEntries: const [v2User],
        threadId: 'thread-v2',
        threadPrompt: 'hi 你能做什么',
        isRunning: false,
      );

      expect(display, hasLength(1));
      expect(display.single.id, 'message-v2-user');
      expect(display.single.text, contains('V2_LONGCAT_E2E_20260922_0007'));
      expect(
        display.any((entry) => entry.id.startsWith('optimistic-user-')),
        isFalse,
      );
    },
  );

  test('buildActivityFeed hides Codex connection status messages', () {
    final feed = buildActivityFeed(
      threadPrompt: '',
      threadId: 't1',
      runProjection: const ThreadRunProjectionSnapshot(
        threadId: 't1',
        status: 'running',
        generatedAt: '2026-01-01T00:00:00.000Z',
        sourceEventCount: 4,
        agents: [],
        timeline: [
          ThreadRunProjectionTimelineItem(
            id: 'starting',
            sequence: 1,
            eventType: 'thread.status',
            scope: 'main',
            text: '正在启动Codex…',
            at: '2026-01-01T00:00:00.000Z',
          ),
          ThreadRunProjectionTimelineItem(
            id: 'connected',
            sequence: 2,
            eventType: 'thread.status',
            scope: 'main',
            text: 'Codex 已连接 · gpt-5.6-sol',
            at: '2026-01-01T00:00:01.000Z',
          ),
          ThreadRunProjectionTimelineItem(
            id: 'approval-waiting',
            sequence: 3,
            eventType: 'thread.status',
            scope: 'main',
            text: '等待工具权限确认…',
            at: '2026-01-01T00:00:02.000Z',
          ),
          ThreadRunProjectionTimelineItem(
            id: 'assistant',
            sequence: 4,
            eventType: 'message.final',
            scope: 'main',
            text: '开始处理任务。',
            at: '2026-01-01T00:00:03.000Z',
          ),
        ],
      ),
    );

    expect(feed.map((entry) => entry.text), ['开始处理任务。']);
  });

  test(
    'context compaction phases use the context action icon and lifecycle',
    () {
      const cases = {
        'context.compaction.started': ToolActionLifecycle.running,
        'context.compaction.completed': ToolActionLifecycle.completed,
        'context.compaction.failed': ToolActionLifecycle.failed,
        'context.compaction.suspended': ToolActionLifecycle.failed,
      };

      for (final entry in cases.entries) {
        final feed = buildActivityFeed(
          threadPrompt: '',
          threadId: 't1',
          groupTurns: false,
          runProjection: ThreadRunProjectionSnapshot(
            threadId: 't1',
            status: 'running',
            generatedAt: '2026-01-01T00:00:00.000Z',
            sourceEventCount: 1,
            agents: const [],
            timeline: [
              ThreadRunProjectionTimelineItem(
                id: entry.key,
                sequence: 1,
                eventType: entry.key,
                scope: 'main',
                text: '',
                at: '2026-01-01T00:00:00.000Z',
              ),
            ],
          ),
        );

        expect(feed, hasLength(1), reason: entry.key);
        expect(feed.single.kind, ActivityFeedKind.phase, reason: entry.key);
        expect(
          feed.single.actionIcon,
          ActivityActionIcon.context,
          reason: entry.key,
        );
        expect(feed.single.lifecycle, entry.value, reason: entry.key);
      }
    },
  );

  test('context compaction does not add a pending thinking row', () {
    const compaction = ActivityFeedEntry(
      id: 'context-compaction',
      kind: ActivityFeedKind.phase,
      text: '正在自动压缩上下文',
      actionIcon: ActivityActionIcon.context,
      lifecycle: ToolActionLifecycle.running,
    );
    const runningTurn = ActivityFeedEntry(
      id: 'turn-running',
      kind: ActivityFeedKind.turn,
      text: '',
      running: true,
      processEntries: [compaction],
    );

    expect(
      shouldAppendPendingAgentThinking(
        isRunning: true,
        entries: const [runningTurn],
      ),
      isFalse,
    );
  });

  test('nested streaming thinking does not add a pending thinking row', () {
    const runningTurn = ActivityFeedEntry(
      id: 'turn-running',
      kind: ActivityFeedKind.turn,
      text: '',
      running: true,
      processEntries: [
        ActivityFeedEntry(
          id: 'thinking-stream',
          kind: ActivityFeedKind.thinking,
          text: '正在输出的思考',
          streaming: true,
        ),
      ],
    );

    expect(
      shouldAppendPendingAgentThinking(
        isRunning: true,
        entries: const [runningTurn],
      ),
      isFalse,
    );
  });

  test('reasoning stage does not add a pending thinking row', () {
    const stage = ActivityFeedEntry(
      id: 'stage-1',
      kind: ActivityFeedKind.reasoningStage,
      text: '定位入口',
      streaming: true,
    );
    const runningTurn = ActivityFeedEntry(
      id: 'turn-running',
      kind: ActivityFeedKind.turn,
      text: '',
      running: true,
      processEntries: [stage],
    );

    expect(
      shouldAppendPendingAgentThinking(isRunning: true, entries: const [stage]),
      isFalse,
    );
    expect(
      shouldAppendPendingAgentThinking(
        isRunning: true,
        entries: const [runningTurn],
      ),
      isFalse,
    );
  });

  test('MCP elicitation status lines are hidden from the feed', () {
    final feed = buildActivityFeed(
      threadPrompt: '',
      threadId: 't1',
      groupTurns: false,
      runProjection: const ThreadRunProjectionSnapshot(
        threadId: 't1',
        status: 'completed',
        generatedAt: '2026-01-01T00:00:00.000Z',
        sourceEventCount: 3,
        agents: [],
        timeline: [
          ThreadRunProjectionTimelineItem(
            id: 'mcp-waiting',
            sequence: 1,
            eventType: 'thread.status',
            scope: 'main',
            role: 'system',
            text: '等待你完成 mongo 的 MCP 表单…',
            at: '2026-01-01T00:00:00.000Z',
          ),
          ThreadRunProjectionTimelineItem(
            id: 'mcp-submitted',
            sequence: 2,
            eventType: 'message.final',
            scope: 'main',
            role: 'tool',
            text: 'mongo 的 MCP 表单已提交。',
            at: '2026-01-01T00:00:01.000Z',
            metadata: {'liveType': 'clarification.answered'},
          ),
          ThreadRunProjectionTimelineItem(
            id: 'assistant-reply',
            sequence: 3,
            eventType: 'message.final',
            scope: 'main',
            role: 'assistant',
            text: '已连接 MongoDB。',
            at: '2026-01-01T00:00:02.000Z',
          ),
        ],
      ),
    );

    expect(feed.map((entry) => entry.text), ['已连接 MongoDB。']);
  });

  test(
    'buildActivityFeed hides plan execution transition and empty processed turn',
    () {
      final feed = buildActivityFeed(
        threadPrompt: '',
        threadId: 't1',
        runProjection: const ThreadRunProjectionSnapshot(
          threadId: 't1',
          status: 'completed',
          generatedAt: '2026-01-01T00:00:05.000Z',
          sourceEventCount: 1,
          attempts: [
            ThreadRunProjectionAttempt(
              attemptId: 'attempt-planning',
              phase: 'planning',
              retryIndex: 0,
              status: 'completed',
              startedAt: '2026-01-01T00:00:00.000Z',
              endedAt: '2026-01-01T00:00:05.000Z',
            ),
          ],
          agents: [],
          timeline: [
            ThreadRunProjectionTimelineItem(
              id: 'plan-cleared',
              sequence: 1,
              eventType: 'thread.status',
              scope: 'main',
              role: 'system',
              runAttemptId: 'attempt-planning',
              text: '计划已进入执行阶段。',
              at: '2026-01-01T00:00:05.000Z',
              metadata: {'liveType': 'thread.plan_cleared'},
            ),
          ],
        ),
      );

      expect(feed, isEmpty);
    },
  );

  test('parseToolActionDisplayLabel normalizes tool lines', () {
    expect(
      parseToolActionDisplayLabel(
        'Tool: Read · lib/main.dart',
        lookupAppLocalizations(const Locale('zh')),
      ),
      'lib/main.dart',
    );
    expect(isUsageNoiseMessage('Usage recorded'), isTrue);
  });

  test('WebSearch metadata produces a network card model', () {
    final l10n = lookupAppLocalizations(const Locale('zh'));
    final tool = threadRunToolMetadataFromJson({
      'name': 'WebSearch',
      'durationMs': 1200,
      'status': 'completed',
      'webSearch': {
        'query': 'Flutter markdown',
        'actionType': 'findInPage',
        'url': 'https://docs.flutter.dev',
        'pattern': 'MarkdownBody',
        'queries': ['Flutter markdown', 'MarkdownBody'],
        'mode': 'search',
      },
    });

    expect(tool, isNotNull);
    expect(iconForToolName('WebSearch'), ActivityActionIcon.network);
    expect(iconForToolName('bash'), ActivityActionIcon.terminal);
    expect(iconForToolName('TotallyUnknown'), ActivityActionIcon.tool);
    final display = resolveWebSearchCardDisplayFromTool(tool!, l10n);
    expect(display?.title, '联网搜索 · Flutter markdown');
    expect(display?.query, 'Flutter markdown');
    expect(display?.url, 'https://docs.flutter.dev');
    expect(
      display?.actionLabel,
      '页内查找 · "MarkdownBody" · https://docs.flutter.dev',
    );
    expect(display?.meta, '1.2s');
  });

  test(
    'eco browser and image generation tools use dedicated labels and icons',
    () {
      final l10n = lookupAppLocalizations(const Locale('zh'));
      expect(
        formatToolDisplayLabel(
          'mcp__eco_agent_browser__agent_browser_click',
          null,
          l10n,
        ),
        '浏览器点击',
      );
      expect(
        formatToolDisplayLabel(
          'mcp__eco_image_generation__create_image',
          null,
          l10n,
        ),
        '生成图片',
      );
      expect(
        formatToolDisplayLabel(
          'mcp__eco_ab_ea4a60abe66__agent_browser_open',
          null,
          l10n,
        ),
        '打开网页',
      );
      expect(
        iconForToolName('mcp__eco_agent_browser__agent_browser_click'),
        ActivityActionIcon.browser,
      );
      expect(
        iconForToolName('mcp__eco_image_generation__create_image'),
        ActivityActionIcon.image,
      );
    },
  );

  test('groupActivityFeedActionEntries summarizes consecutive actions', () {
    final grouped = groupActivityFeedActionEntries(const [
      ActivityFeedEntry(
        id: 'edit-1',
        kind: ActivityFeedKind.action,
        text: 'lib/editor.dart',
        actionIcon: ActivityActionIcon.edit,
        lifecycle: ToolActionLifecycle.completed,
      ),
      ActivityFeedEntry(
        id: 'read-1',
        kind: ActivityFeedKind.action,
        text: 'lib/feed.dart',
        actionIcon: ActivityActionIcon.read,
        lifecycle: ToolActionLifecycle.completed,
      ),
      ActivityFeedEntry(
        id: 'grep-1',
        kind: ActivityFeedKind.action,
        text: 'search ActivityFeed',
        actionIcon: ActivityActionIcon.search,
        lifecycle: ToolActionLifecycle.completed,
      ),
    ]);

    expect(grouped.length, 1);
    expect(grouped.first.kind, ActivityFeedKind.actionGroup);
    expect(grouped.first.text, '已读取 1 个文件、已编辑 1 个文件和已搜索代码 1 次');
    expect(grouped.first.actionIcon, ActivityActionIcon.edit);
    expect(grouped.first.actionChildren.map((entry) => entry.id), [
      'edit-1',
      'read-1',
      'grep-1',
    ]);
  });

  test('re-sorting a row keeps the facts the Feed reads off it', () {
    // The Feed rebuilds rows when it sorts them into turns and when it folds them into
    // groups. Every field has to survive that rebuild: a row that lost its provider role
    // would stop being comparable with the desktop Feed, and one that lost its tool event
    // would stop reporting whether the call finished.
    const row = ActivityFeedEntry(
      id: 'read-1',
      kind: ActivityFeedKind.action,
      text: 'lib/feed.dart',
      actionIcon: ActivityActionIcon.read,
      lifecycle: ToolActionLifecycle.completed,
      toolEventType: 'tool.completed',
      toolUseId: 'call_1',
      role: 'tool',
      sequence: 1,
    );

    final moved = row.withSequence(9);
    expect(moved.sequence, 9);
    expect(moved.role, 'tool');
    expect(moved.toolEventType, 'tool.completed');
    expect(moved.toolUseId, 'call_1');

    final renamed = row.withIdAtSequence(
      id: 'renamed',
      at: '2026-01-01T00:00:00.000Z',
      sequence: 3,
    );
    expect(renamed.id, 'renamed');
    expect(renamed.role, 'tool');
    expect(renamed.toolEventType, 'tool.completed');
    expect(renamed.toolUseId, 'call_1');
  });

  test(
    'a folded thinking row stands at its last block and keeps its author',
    () {
      final grouped = groupConsecutiveThinkingEntries(const [
        ActivityFeedEntry(
          id: 'thinking-1',
          kind: ActivityFeedKind.thinking,
          text: 'first',
          role: 'planner',
          at: '2026-01-01T00:00:01.000Z',
        ),
        ActivityFeedEntry(
          id: 'thinking-2',
          kind: ActivityFeedKind.thinking,
          text: 'second',
          role: 'planner',
          at: '2026-01-01T00:00:05.000Z',
        ),
      ]);

      expect(grouped, hasLength(1));
      expect(grouped.single.text, 'first\n\nsecond');
      expect(grouped.single.role, 'planner');
      expect(grouped.single.at, '2026-01-01T00:00:05.000Z');
    },
  );

  test('groupActivityFeedActionEntries wraps isolated actions', () {
    final grouped = groupActivityFeedActionEntries(const [
      ActivityFeedEntry(
        id: 'read-1',
        kind: ActivityFeedKind.action,
        text: 'lib/feed.dart',
        actionIcon: ActivityActionIcon.read,
      ),
      ActivityFeedEntry(
        id: 'assistant-1',
        kind: ActivityFeedKind.assistant,
        text: 'done',
      ),
    ]);

    expect(grouped.map((entry) => entry.kind), [
      ActivityFeedKind.actionGroup,
      ActivityFeedKind.assistant,
    ]);
    expect(grouped.first.text, '读取了 feed.dart');
  });

  test('groupConsecutiveThinkingEntries joins adjacent thinking panels', () {
    final grouped = groupConsecutiveThinkingEntries(const [
      ActivityFeedEntry(
        id: 'thinking-1',
        kind: ActivityFeedKind.thinking,
        text: '  先分析结构  ',
        runAttemptId: 'attempt-1',
        startedAt: '2026-01-01T00:00:01.000Z',
        endedAt: '2026-01-01T00:00:02.000Z',
        durationMs: 1000,
      ),
      ActivityFeedEntry(
        id: 'thinking-2',
        kind: ActivityFeedKind.thinking,
        text: '再确认边界',
        runAttemptId: 'attempt-1',
        endedAt: '2026-01-01T00:00:03.000Z',
        durationMs: 1000,
      ),
      ActivityFeedEntry(
        id: 'assistant-1',
        kind: ActivityFeedKind.assistant,
        text: '已完成',
      ),
      ActivityFeedEntry(
        id: 'thinking-3',
        kind: ActivityFeedKind.thinking,
        text: '后续思考',
        runAttemptId: 'attempt-1',
      ),
    ]);

    expect(grouped.map((entry) => entry.kind), [
      ActivityFeedKind.thinking,
      ActivityFeedKind.assistant,
      ActivityFeedKind.thinking,
    ]);
    expect(grouped.first.text, '先分析结构\n\n再确认边界');
    expect(grouped.first.id, 'thinking-1');
    expect(grouped.first.durationMs, 2000);
    expect(grouped.first.endedAt, '2026-01-01T00:00:03.000Z');
  });

  test('groupConsecutiveThinkingEntries keeps different contexts separate', () {
    final grouped = groupConsecutiveThinkingEntries(const [
      ActivityFeedEntry(
        id: 'main-thinking',
        kind: ActivityFeedKind.thinking,
        text: '主 Agent',
        agentId: 'main',
        runAttemptId: 'attempt-1',
      ),
      ActivityFeedEntry(
        id: 'other-agent-thinking',
        kind: ActivityFeedKind.thinking,
        text: '子 Agent',
        agentId: 'subagent-1',
        runAttemptId: 'attempt-1',
      ),
      ActivityFeedEntry(
        id: 'retry-thinking',
        kind: ActivityFeedKind.thinking,
        text: '重试请求',
        agentId: 'subagent-1',
        runAttemptId: 'attempt-2',
      ),
    ]);

    expect(grouped.map((entry) => entry.id), [
      'main-thinking',
      'other-agent-thinking',
      'retry-thinking',
    ]);
  });

  test('groupConsecutiveThinkingEntries keeps reasoning stages separate', () {
    final grouped = groupConsecutiveThinkingEntries(const [
      ActivityFeedEntry(
        id: 'thinking-1',
        kind: ActivityFeedKind.thinking,
        text: 'raw chain of thought',
      ),
      ActivityFeedEntry(
        id: 'stage-1',
        kind: ActivityFeedKind.reasoningStage,
        text: '定位入口',
        streaming: true,
      ),
      ActivityFeedEntry(
        id: 'thinking-2',
        kind: ActivityFeedKind.thinking,
        text: 'more raw thinking',
      ),
    ]);

    expect(grouped.map((entry) => entry.kind), [
      ActivityFeedKind.thinking,
      ActivityFeedKind.reasoningStage,
      ActivityFeedKind.thinking,
    ]);
    expect(grouped.map((entry) => entry.id), [
      'thinking-1',
      'stage-1',
      'thinking-2',
    ]);
  });

  test(
    'single completed commands and edits use shared completed summaries',
    () {
      final command = groupActivityFeedActionEntries(const [
        ActivityFeedEntry(
          id: 'command-1',
          kind: ActivityFeedKind.action,
          text: 'npm test',
          actionIcon: ActivityActionIcon.terminal,
          lifecycle: ToolActionLifecycle.completed,
        ),
      ]);
      final edit = groupActivityFeedActionEntries(const [
        ActivityFeedEntry(
          id: 'edit-1',
          kind: ActivityFeedKind.action,
          text: 'lib/feed.dart',
          actionIcon: ActivityActionIcon.edit,
          lifecycle: ToolActionLifecycle.completed,
        ),
      ]);

      expect(command.single.text, '运行了命令');
      expect(edit.single.text, '编辑了 feed.dart');
    },
  );

  test('lowercase bash command groups hide the tool name in the header', () {
    final grouped = groupActivityFeedActionEntries(const [
      ActivityFeedEntry(
        id: 'bash-lowercase',
        kind: ActivityFeedKind.action,
        text: 'rg -n needle lib',
        toolName: 'bash',
        actionIcon: ActivityActionIcon.terminal,
        lifecycle: ToolActionLifecycle.completed,
        bashRun: BashRunCardDisplay(
          title: 'Shell',
          command: 'rg -n needle lib',
        ),
      ),
    ]);

    expect(grouped.single.text, '运行了命令');
    expect(grouped.single.actionChildren, hasLength(1));
  });

  test('buildActivityFeed keeps tool groups between assistant text blocks', () {
    const requestId = 'req_planner';
    final timeline = <ThreadRunProjectionTimelineItem>[
      _codexMessageTimelineItem(
        id: 'body-1',
        sequence: 1,
        text: '正文输出1',
        at: '2026-01-01T00:00:01.000Z',
        requestId: requestId,
      ),
      for (var index = 0; index < 3; index++)
        _toolTimelineItem(
          id: 'bash-$index-start',
          sequence: 2 + index,
          eventType: 'tool.started',
          toolUseId: 'toolu_bash_$index',
          toolName: 'Bash',
          detail: 'bash${index + 1}',
          at: '2026-01-01T00:00:0${2 + index}.000Z',
          requestId: requestId,
        ),
      _codexMessageTimelineItem(
        id: 'body-2',
        sequence: 5,
        text: '正文输出2',
        at: '2026-01-01T00:00:05.000Z',
        requestId: requestId,
      ),
      for (var index = 0; index < 3; index++)
        _toolTimelineItem(
          id: 'edit-$index-start',
          sequence: 6 + index,
          eventType: 'tool.started',
          toolUseId: 'toolu_edit_$index',
          toolName: 'Edit',
          detail: 'lib/file_${index + 1}.dart',
          at: '2026-01-01T00:00:0${6 + index}.000Z',
          requestId: requestId,
        ),
      _codexMessageTimelineItem(
        id: 'body-3',
        sequence: 9,
        text: '正文输出3',
        at: '2026-01-01T00:00:09.000Z',
        requestId: requestId,
      ),
      for (var index = 0; index < 3; index++)
        _toolTimelineItem(
          id: 'bash-$index-complete',
          sequence: 10 + index,
          eventType: 'tool.completed',
          toolUseId: 'toolu_bash_$index',
          toolName: 'Bash',
          detail: 'bash${index + 1}',
          at: '2026-01-01T00:00:${10 + index}.000Z',
          requestId: requestId,
        ),
      for (var index = 0; index < 3; index++)
        _toolTimelineItem(
          id: 'edit-$index-complete',
          sequence: 13 + index,
          eventType: 'tool.completed',
          toolUseId: 'toolu_edit_$index',
          toolName: 'Edit',
          detail: 'lib/file_${index + 1}.dart',
          at: '2026-01-01T00:00:${13 + index}.000Z',
          requestId: requestId,
        ),
    ];

    final feed = buildActivityFeed(
      threadPrompt: '',
      threadId: 't1',
      runProjection: ThreadRunProjectionSnapshot(
        threadId: 't1',
        status: 'idle',
        generatedAt: '2026-01-01T00:00:16.000Z',
        sourceEventCount: timeline.length,
        agents: const [],
        requestSpans: const [
          ThreadRunProjectionRequestSpan(
            requestId: requestId,
            status: 'completed',
            startedAt: '2026-01-01T00:00:00.000Z',
            endedAt: '2026-01-01T00:00:16.000Z',
          ),
        ],
        timeline: timeline,
      ),
    );

    expect(feed.map((entry) => entry.kind), [
      ActivityFeedKind.assistant,
      ActivityFeedKind.actionGroup,
      ActivityFeedKind.assistant,
      ActivityFeedKind.actionGroup,
      ActivityFeedKind.assistant,
    ]);
    expect(feed.map((entry) => entry.text), [
      '正文输出1',
      '已运行 3 条命令',
      '正文输出2',
      '已编辑 3 个文件',
      '正文输出3',
    ]);
    expect(feed[1].actionChildren, hasLength(3));
    expect(feed[3].actionChildren, hasLength(3));
  });

  test(
    'groupActivityFeedActionEntries groups adjacent tools across attempts',
    () {
      final grouped = groupActivityFeedActionEntries(const [
        ActivityFeedEntry(
          id: 'read-attempt-1',
          kind: ActivityFeedKind.action,
          text: 'lib/first.dart',
          runAttemptId: 'attempt-1',
        ),
        ActivityFeedEntry(
          id: 'read-attempt-2',
          kind: ActivityFeedKind.action,
          text: 'lib/second.dart',
          runAttemptId: 'attempt-2',
        ),
      ]);

      expect(grouped, hasLength(1));
      expect(grouped.single.kind, ActivityFeedKind.actionGroup);
      expect(grouped.single.runAttemptId, isNull);
    },
  );

  test('empty terminal thinking does not split adjacent tool summaries', () {
    final feed = buildActivityFeed(
      threadPrompt: '',
      threadId: 't1',
      runProjection: const ThreadRunProjectionSnapshot(
        threadId: 't1',
        status: 'completed',
        generatedAt: '2026-01-01T00:00:03.000Z',
        sourceEventCount: 3,
        agents: [],
        timeline: [
          ThreadRunProjectionTimelineItem(
            id: 'read-a',
            sequence: 1,
            eventType: 'tool.completed',
            scope: 'main',
            text: 'Tool: Read · lib/a.dart',
            at: '2026-01-01T00:00:01.000Z',
            metadata: {
              'tool': {
                'name': 'Read',
                'detail': 'lib/a.dart',
                'toolUseId': 'toolu_read_a',
                'status': 'completed',
              },
            },
          ),
          ThreadRunProjectionTimelineItem(
            id: 'empty-reasoning',
            sequence: 2,
            eventType: 'thinking.final',
            scope: 'main',
            role: 'thinking',
            text: '',
            at: '2026-01-01T00:00:02.000Z',
          ),
          ThreadRunProjectionTimelineItem(
            id: 'read-b',
            sequence: 3,
            eventType: 'tool.completed',
            scope: 'main',
            text: 'Tool: Read · lib/b.dart',
            at: '2026-01-01T00:00:03.000Z',
            metadata: {
              'tool': {
                'name': 'Read',
                'detail': 'lib/b.dart',
                'toolUseId': 'toolu_read_b',
                'status': 'completed',
              },
            },
          ),
        ],
      ),
    );

    expect(feed, hasLength(1));
    expect(feed.single.kind, ActivityFeedKind.actionGroup);
    expect(feed.single.actionChildren.map((entry) => entry.id), [
      'main:lifecycle:toolu_read_a',
      'main:lifecycle:toolu_read_b',
    ]);
    expect(
      feed.any((entry) => entry.kind == ActivityFeedKind.thinking),
      isFalse,
    );
  });

  test('buildActivityFeed maps reasoningDisplay summary to a stage line', () {
    final feed = _flattenFeed(
      buildActivityFeed(
        threadPrompt: '',
        threadId: 't1',
        groupTurns: false,
        runProjection: ThreadRunProjectionSnapshot(
          threadId: 't1',
          status: 'running',
          generatedAt: '2026-01-01T00:00:01.000Z',
          sourceEventCount: 1,
          agents: const [],
          timeline: [
            _thinkingTimelineItem(
              id: 'summary-1',
              eventType: 'thinking.delta',
              text: '**定位入口**\n\n检查 adapter',
              sequence: 1,
              at: '2026-01-01T00:00:01.000Z',
              streamKey: 'rs_1',
              metadata: const {'reasoningDisplay': 'summary'},
            ),
          ],
        ),
      ),
    );

    expect(feed, hasLength(1));
    expect(feed.single.kind, ActivityFeedKind.reasoningStage);
    expect(feed.single.text, '定位入口\n\n检查 adapter');
    expect(feed.single.streaming, isTrue);

    // Summary remains temporary regardless of its line count; the renderer
    // presents its stages through the single-line carousel.
    final longSummary = _flattenFeed(
      buildActivityFeed(
        threadPrompt: '',
        threadId: 't1',
        groupTurns: false,
        runProjection: ThreadRunProjectionSnapshot(
          threadId: 't1',
          status: 'running',
          generatedAt: '2026-01-01T00:00:01.000Z',
          sourceEventCount: 1,
          agents: const [],
          timeline: [
            _thinkingTimelineItem(
              id: 'summary-long',
              eventType: 'thinking.delta',
              text: '第一行\n第二行\n第三行\n第四行\n第五行',
              sequence: 1,
              at: '2026-01-01T00:00:01.000Z',
              streamKey: 'rs_2',
              metadata: const {'reasoningDisplay': 'summary'},
            ),
          ],
        ),
      ),
    );

    expect(longSummary.single.kind, ActivityFeedKind.reasoningStage);
    expect(longSummary.single.text, '第一行\n第二行\n第三行\n第四行\n第五行');
  });

  test(
    'buildActivityFeed presents raw thinking as ephemeral tips while running',
    () {
      ActivityFeedEntry buildThinking(ThreadRunProjectionTimelineItem item) {
        return _flattenFeed(
          buildActivityFeed(
            threadPrompt: '',
            threadId: 't1',
            groupTurns: false,
            runProjection: ThreadRunProjectionSnapshot(
              threadId: 't1',
              status: 'running',
              generatedAt: item.at,
              sourceEventCount: 1,
              agents: const [],
              timeline: [item],
            ),
          ),
        ).single;
      }

      final raw = buildThinking(
        _thinkingTimelineItem(
          id: 'raw-1',
          eventType: 'thinking.final',
          text: 'raw chain of thought',
          sequence: 1,
          at: '2026-01-01T00:00:01.000Z',
          streamKey: 'raw_1',
          metadata: const {'reasoningDisplay': 'raw'},
        ),
      );
      final legacy = buildThinking(
        _thinkingTimelineItem(
          id: 'legacy-1',
          eventType: 'thinking.final',
          text: 'legacy thinking without tag',
          sequence: 2,
          at: '2026-01-01T00:00:02.000Z',
          streamKey: 'legacy_1',
        ),
      );

      expect(raw.kind, ActivityFeedKind.reasoningStage);
      expect(raw.text, 'raw chain of thought');
      expect(raw.streaming, isTrue);
      expect(legacy.kind, ActivityFeedKind.reasoningStage);
      expect(legacy.text, 'legacy thinking without tag');
      expect(legacy.streaming, isTrue);
    },
  );

  test(
    'buildActivityFeed keeps raw thinking as cards when collapsed/expanded',
    () {
      ActivityFeedEntry buildThinking(
        ThreadRunProjectionTimelineItem item, {
        required ThinkingDisplayMode mode,
      }) {
        return _flattenFeed(
          buildActivityFeed(
            threadPrompt: '',
            threadId: 't1',
            groupTurns: false,
            thinkingDisplayMode: mode,
            runProjection: ThreadRunProjectionSnapshot(
              threadId: 't1',
              status: 'completed',
              generatedAt: item.at,
              sourceEventCount: 1,
              agents: const [],
              timeline: [item],
            ),
          ),
        ).single;
      }

      final item = _thinkingTimelineItem(
        id: 'raw-1',
        eventType: 'thinking.final',
        text: 'raw chain of thought',
        sequence: 1,
        at: '2026-01-01T00:00:01.000Z',
        streamKey: 'raw_1',
        metadata: const {'reasoningDisplay': 'raw'},
      );

      expect(
        buildThinking(item, mode: ThinkingDisplayMode.collapsed).kind,
        ActivityFeedKind.thinking,
      );
      expect(
        buildThinking(item, mode: ThinkingDisplayMode.expanded).kind,
        ActivityFeedKind.thinking,
      );
    },
  );

  test(
    'buildActivityFeed ephemeral mode hides completed thinking after message',
    () {
      final feed = _flattenFeed(
        buildActivityFeed(
          threadPrompt: '',
          threadId: 't1',
          groupTurns: false,
          runProjection: ThreadRunProjectionSnapshot(
            threadId: 't1',
            status: 'completed',
            generatedAt: '2026-01-01T00:00:02.000Z',
            sourceEventCount: 2,
            agents: const [],
            timeline: [
              _thinkingTimelineItem(
                id: 'raw-1',
                eventType: 'thinking.final',
                text: '先定位入口',
                sequence: 1,
                at: '2026-01-01T00:00:01.000Z',
                streamKey: 'raw_1',
                metadata: const {'reasoningDisplay': 'raw'},
              ),
              ThreadRunProjectionTimelineItem(
                id: 'msg-1',
                sequence: 2,
                eventType: 'message.final',
                scope: 'main',
                text: '结论',
                at: '2026-01-01T00:00:02.000Z',
                role: 'assistant',
              ),
            ],
          ),
        ),
      );

      expect(feed.map((entry) => entry.kind).toList(), [
        ActivityFeedKind.assistant,
      ]);
      expect(
        feed.any((entry) => entry.kind == ActivityFeedKind.reasoningStage),
        isFalse,
      );
      expect(
        feed.any((entry) => entry.kind == ActivityFeedKind.thinking),
        isFalse,
      );
    },
  );

  test(
    'buildActivityFeed keeps tip reasoning summary after finalize until a tool',
    () {
      final beforeTool = _flattenFeed(
        buildActivityFeed(
          threadPrompt: '',
          threadId: 't1',
          groupTurns: false,
          runProjection: ThreadRunProjectionSnapshot(
            threadId: 't1',
            status: 'running',
            generatedAt: '2026-01-01T00:00:01.000Z',
            sourceEventCount: 1,
            agents: const [],
            timeline: [
              _thinkingTimelineItem(
                id: 'stage-1',
                eventType: 'thinking.final',
                text: '定位入口',
                sequence: 1,
                at: '2026-01-01T00:00:01.000Z',
                streamKey: 'rs_1',
                metadata: const {'reasoningDisplay': 'summary'},
              ),
            ],
          ),
        ),
      );
      expect(beforeTool, hasLength(1));
      expect(beforeTool.single.kind, ActivityFeedKind.reasoningStage);
      expect(beforeTool.single.text, '定位入口');

      final withTool = _flattenFeed(
        buildActivityFeed(
          threadPrompt: '',
          threadId: 't1',
          groupTurns: false,
          runProjection: ThreadRunProjectionSnapshot(
            threadId: 't1',
            status: 'running',
            generatedAt: '2026-01-01T00:00:03.000Z',
            sourceEventCount: 3,
            agents: const [],
            timeline: [
              _thinkingTimelineItem(
                id: 'stage-1',
                eventType: 'thinking.final',
                text: '定位入口',
                sequence: 1,
                at: '2026-01-01T00:00:01.000Z',
                streamKey: 'rs_1',
                metadata: const {'reasoningDisplay': 'summary'},
              ),
              ThreadRunProjectionTimelineItem(
                id: 'bash-1',
                sequence: 2,
                eventType: 'tool.started',
                scope: 'main',
                role: 'tool',
                text: 'Tool: Bash · ls',
                at: '2026-01-01T00:00:02.000Z',
                metadata: const {
                  'tool': {'name': 'Bash', 'detail': 'ls', 'status': 'started'},
                },
              ),
              _thinkingTimelineItem(
                id: 'stage-2',
                eventType: 'thinking.delta',
                text: '检查测试',
                sequence: 3,
                at: '2026-01-01T00:00:03.000Z',
                streamKey: 'rs_2',
                metadata: const {'reasoningDisplay': 'summary'},
              ),
            ],
          ),
        ),
      );

      expect(withTool, hasLength(1));
      expect(withTool.single.kind, ActivityFeedKind.reasoningStage);
      expect(withTool.single.text, '检查测试');
      expect(withTool.any((entry) => entry.text == '定位入口'), isFalse);
    },
  );

  test('buildActivityFeed replaces earlier live reasoning summaries', () {
    final feed = _flattenFeed(
      buildActivityFeed(
        threadPrompt: '',
        threadId: 't1',
        groupTurns: false,
        runProjection: ThreadRunProjectionSnapshot(
          threadId: 't1',
          status: 'running',
          generatedAt: '2026-01-01T00:00:02.000Z',
          sourceEventCount: 2,
          agents: const [],
          timeline: [
            _thinkingTimelineItem(
              id: 'stage-1',
              eventType: 'thinking.delta',
              text: '第一阶段',
              sequence: 1,
              at: '2026-01-01T00:00:01.000Z',
              streamKey: 'rs_1',
              metadata: const {'reasoningDisplay': 'summary'},
            ),
            _thinkingTimelineItem(
              id: 'stage-2',
              eventType: 'thinking.delta',
              text: '第二阶段',
              sequence: 2,
              at: '2026-01-01T00:00:02.000Z',
              streamKey: 'rs_2',
              metadata: const {'reasoningDisplay': 'summary'},
            ),
          ],
        ),
      ),
    );

    expect(feed, hasLength(1));
    expect(feed.single.kind, ActivityFeedKind.reasoningStage);
    expect(feed.single.text, '第二阶段');
  });

  test(
    'buildActivityFeed maps summaryTextDelta without reasoningDisplay stamp',
    () {
      final feed = _flattenFeed(
        buildActivityFeed(
          threadPrompt: '',
          threadId: 't1',
          groupTurns: false,
          runProjection: ThreadRunProjectionSnapshot(
            threadId: 't1',
            status: 'running',
            generatedAt: '2026-01-01T00:00:01.000Z',
            sourceEventCount: 1,
            agents: const [],
            timeline: [
              _thinkingTimelineItem(
                id: 'stage-method',
                eventType: 'thinking.delta',
                text: '检查测试',
                sequence: 1,
                at: '2026-01-01T00:00:01.000Z',
                streamKey: 'rs_method',
                metadata: const {
                  'codexMethod': 'item/reasoning/summaryTextDelta',
                },
              ),
            ],
          ),
        ),
      );

      expect(feed.single.kind, ActivityFeedKind.reasoningStage);
      expect(feed.single.text, '检查测试');
    },
  );

  test('buildActivityFeed clears reasoning summary after a completed tool', () {
    final feed = _flattenFeed(
      buildActivityFeed(
        threadPrompt: '',
        threadId: 't1',
        groupTurns: false,
        runProjection: ThreadRunProjectionSnapshot(
          threadId: 't1',
          status: 'completed',
          generatedAt: '2026-01-01T00:00:02.000Z',
          sourceEventCount: 2,
          agents: const [],
          timeline: [
            _thinkingTimelineItem(
              id: 'stage-done',
              eventType: 'thinking.final',
              text: '已完成阶段',
              sequence: 1,
              at: '2026-01-01T00:00:01.000Z',
              streamKey: 'rs_stage_done',
              metadata: const {'reasoningDisplay': 'summary'},
            ),
            ThreadRunProjectionTimelineItem(
              id: 'bash-done',
              sequence: 2,
              eventType: 'tool.completed',
              scope: 'main',
              role: 'tool',
              text: 'Tool: Bash · ls',
              at: '2026-01-01T00:00:02.000Z',
              metadata: const {
                'tool': {'name': 'Bash', 'detail': 'ls', 'status': 'completed'},
              },
            ),
          ],
        ),
      ),
    );

    expect(feed.any((entry) => entry.text == '已完成阶段'), isFalse);
    expect(
      feed.any((entry) => entry.kind == ActivityFeedKind.reasoningStage),
      isFalse,
    );
    expect(
      feed.any(
        (entry) =>
            entry.kind == ActivityFeedKind.action ||
            entry.kind == ActivityFeedKind.actionGroup,
      ),
      isTrue,
    );
  });

  test('tool detail feed does not nest user prompts or turn wrappers', () {
    final toolItem = _toolTimelineItem(
      id: 'read-1',
      sequence: 2,
      at: '2026-01-01T00:00:02.000Z',
      eventType: 'tool.completed',
      toolUseId: 'toolu_read_1',
      toolName: 'Read',
      detail:
          'Non-read-only bash is blocked. Use read or an allowlisted read-only command.',
      requestId: 'request-1',
    );
    final entries = buildProjectionDetailEntries(
      threadId: 'thread-1',
      base: ThreadRunProjectionSnapshot(
        threadId: 'thread-1',
        status: 'completed',
        generatedAt: '2026-01-01T00:00:04.000Z',
        sourceEventCount: 2,
        agents: const [],
        attempts: const [
          ThreadRunProjectionAttempt(
            attemptId: 'attempt-1',
            phase: 'initial',
            retryIndex: 0,
            status: 'completed',
            startedAt: '2026-01-01T00:00:00.000Z',
            endedAt: '2026-01-01T00:00:04.000Z',
          ),
        ],
        timeline: [
          ThreadRunProjectionTimelineItem(
            id: 'user-prompt',
            sequence: 1,
            eventType: 'thread.status',
            scope: 'main',
            role: 'user',
            runAttemptId: 'attempt-1',
            text: '模型可以单独配置用什么 apiCompact',
            at: '2026-01-01T00:00:00.000Z',
            metadata: const {'liveType': 'thread.user_prompt'},
          ),
          toolItem,
        ],
      ),
      cachedTimeline: [toolItem],
      detail: null,
      l10n: lookupAppLocalizations(const Locale('zh')),
    );

    expect(
      entries.any((entry) => entry.kind == ActivityFeedKind.user),
      isFalse,
    );
    expect(
      entries.any((entry) => entry.kind == ActivityFeedKind.turn),
      isFalse,
    );
    expect(
      entries.any((entry) => entry.kind == ActivityFeedKind.actionGroup),
      isFalse,
    );
    expect(
      entries.any((entry) => entry.kind == ActivityFeedKind.action),
      isTrue,
    );
  });

  test('tool detail feed skips turn wrappers for task updates', () {
    final feed = buildActivityFeed(
      threadPrompt: '',
      threadId: 't1',
      groupTurns: false,
      runProjection: ThreadRunProjectionSnapshot(
        threadId: 't1',
        status: 'completed',
        generatedAt: '2026-01-01T00:00:03.000Z',
        sourceEventCount: 1,
        agents: const [],
        attempts: const [
          ThreadRunProjectionAttempt(
            attemptId: 'attempt-1',
            phase: 'initial',
            retryIndex: 0,
            status: 'completed',
            startedAt: '2026-01-01T00:00:00.000Z',
            endedAt: '2026-01-01T00:00:03.000Z',
          ),
        ],
        timeline: [
          _toolTimelineItem(
            id: 'task-update',
            sequence: 1,
            at: '2026-01-01T00:00:02.000Z',
            eventType: 'tool.completed',
            toolUseId: 'toolu_task_update',
            toolName: 'TaskUpdate',
            detail: '更新移动端展示',
            requestId: 'request-1',
          ),
        ],
      ),
    );

    expect(feed.any((entry) => entry.kind == ActivityFeedKind.turn), isFalse);
    expect(feed.single.kind, ActivityFeedKind.actionGroup);
    expect(feed.single.actionChildren.single.toolName, 'TaskUpdate');
  });

  test('completed attempt separates process from final output', () {
    final feed = buildActivityFeed(
      threadPrompt: '修复 Feed',
      threadId: 't1',
      runProjection: const ThreadRunProjectionSnapshot(
        threadId: 't1',
        status: 'completed',
        generatedAt: '2026-01-01T00:00:04.000Z',
        sourceEventCount: 4,
        agents: [],
        attempts: [
          ThreadRunProjectionAttempt(
            attemptId: 'attempt-1',
            phase: 'initial',
            retryIndex: 0,
            status: 'completed',
            startedAt: '2026-01-01T00:00:00.000Z',
            endedAt: '2026-01-01T00:00:04.000Z',
          ),
        ],
        timeline: [
          ThreadRunProjectionTimelineItem(
            id: 'user-1',
            sequence: 1,
            eventType: 'thread.status',
            scope: 'main',
            role: 'user',
            runAttemptId: 'attempt-1',
            text: '修复 Feed',
            at: '2026-01-01T00:00:00.000Z',
            metadata: {'liveType': 'thread.user_prompt'},
          ),
          ThreadRunProjectionTimelineItem(
            id: 'narrative-1',
            sequence: 2,
            eventType: 'message.final',
            scope: 'main',
            runAttemptId: 'attempt-1',
            text: '我先检查投影数据。',
            at: '2026-01-01T00:00:01.000Z',
          ),
          ThreadRunProjectionTimelineItem(
            id: 'tool-1',
            sequence: 3,
            eventType: 'tool.completed',
            scope: 'main',
            runAttemptId: 'attempt-1',
            text: 'Tool: Read · lib/feed.dart',
            at: '2026-01-01T00:00:02.000Z',
            metadata: {
              'tool': {
                'name': 'Read',
                'detail': 'lib/feed.dart',
                'status': 'completed',
              },
            },
          ),
          ThreadRunProjectionTimelineItem(
            id: 'final-1',
            sequence: 4,
            eventType: 'message.final',
            scope: 'main',
            runAttemptId: 'attempt-1',
            text: 'Feed 已按轮次完成整理。',
            at: '2026-01-01T00:00:04.000Z',
          ),
        ],
      ),
    );

    expect(feed.first.kind, ActivityFeedKind.user);
    final turn = feed.singleWhere(
      (entry) => entry.kind == ActivityFeedKind.turn,
    );
    expect(turn.running, isFalse);
    expect(turn.turnStatus, 'completed');
    expect(turn.finalOutput?.text, 'Feed 已按轮次完成整理。');
    expect(
      turn.processEntries.map((entry) => entry.text),
      contains('我先检查投影数据。'),
    );
    expect(
      turn.processEntries.any(
        (entry) =>
            entry.kind == ActivityFeedKind.action ||
            entry.kind == ActivityFeedKind.actionGroup,
      ),
      isTrue,
    );
    expect(turn.processEntries.any((entry) => entry.id == 'final-1'), isFalse);
  });

  test('running attempt keeps all assistant output in process', () {
    final feed = buildActivityFeed(
      threadPrompt: '',
      threadId: 't1',
      runProjection: const ThreadRunProjectionSnapshot(
        threadId: 't1',
        status: 'running',
        generatedAt: '2026-01-01T00:00:02.000Z',
        sourceEventCount: 1,
        agents: [],
        attempts: [
          ThreadRunProjectionAttempt(
            attemptId: 'attempt-running',
            phase: 'follow_up',
            retryIndex: 0,
            status: 'running',
            startedAt: '2026-01-01T00:00:00.000Z',
          ),
        ],
        timeline: [
          ThreadRunProjectionTimelineItem(
            id: 'message-running',
            sequence: 1,
            eventType: 'message.final',
            scope: 'main',
            runAttemptId: 'attempt-running',
            text: '正在检查剩余文件。',
            at: '2026-01-01T00:00:01.000Z',
          ),
        ],
      ),
    );

    final turn = feed.single;
    expect(turn.kind, ActivityFeedKind.turn);
    expect(turn.running, isTrue);
    expect(turn.finalOutput, isNull);
    expect(turn.processEntries.single.text, '正在检查剩余文件。');
  });

  test(
    'cancelled attempt without process events still creates a stopped turn',
    () {
      final feed = buildActivityFeed(
        threadPrompt: '',
        threadId: 't1',
        runProjection: const ThreadRunProjectionSnapshot(
          threadId: 't1',
          status: 'idle',
          generatedAt: '2026-01-01T00:00:05.000Z',
          sourceEventCount: 1,
          agents: [],
          attempts: [
            ThreadRunProjectionAttempt(
              attemptId: 'attempt-cancelled-empty',
              phase: 'initial',
              retryIndex: 0,
              status: 'cancelled',
              startedAt: '2026-01-01T00:00:00.000Z',
              endedAt: '2026-01-01T00:00:05.000Z',
            ),
          ],
          timeline: [
            ThreadRunProjectionTimelineItem(
              id: 'cancelled-event',
              sequence: 1,
              eventType: 'request.cancelled',
              scope: 'main',
              runAttemptId: 'attempt-cancelled-empty',
              text: '',
              at: '2026-01-01T00:00:05.000Z',
            ),
          ],
        ),
      );

      expect(feed, hasLength(1));
      expect(feed.single.kind, ActivityFeedKind.turn);
      expect(feed.single.turnStatus, 'cancelled');
      expect(feed.single.running, isFalse);
      expect(feed.single.processEntries, isEmpty);
    },
  );

  test('terminal attempts clipped from the timeline are not synthesized', () {
    final feed = buildActivityFeed(
      threadPrompt: '',
      threadId: 't1',
      runProjection: const ThreadRunProjectionSnapshot(
        threadId: 't1',
        status: 'idle',
        generatedAt: '2026-01-01T00:00:08.000Z',
        sourceEventCount: 1,
        agents: [],
        attempts: [
          ThreadRunProjectionAttempt(
            attemptId: 'attempt-old',
            phase: 'initial',
            retryIndex: 0,
            status: 'cancelled',
            startedAt: '2026-01-01T00:00:00.000Z',
            endedAt: '2026-01-01T00:00:03.000Z',
          ),
          ThreadRunProjectionAttempt(
            attemptId: 'attempt-visible',
            phase: 'follow_up',
            retryIndex: 0,
            status: 'failed',
            startedAt: '2026-01-01T00:00:05.000Z',
            endedAt: '2026-01-01T00:00:08.000Z',
          ),
        ],
        timeline: [
          ThreadRunProjectionTimelineItem(
            id: 'visible-failed',
            sequence: 1,
            eventType: 'request.failed',
            scope: 'main',
            runAttemptId: 'attempt-visible',
            text: '',
            at: '2026-01-01T00:00:08.000Z',
          ),
        ],
      ),
    );

    expect(feed, hasLength(1));
    expect(feed.single.id, 'turn:attempt-visible#after:0');
    expect(feed.single.turnStatus, 'failed');
  });

  test('skeleton subagent cards stay in the same turn as the attempt final', () {
    final feed = buildActivityFeed(
      threadPrompt: '',
      threadId: 't1',
      runProjection: ThreadRunProjectionSnapshot.fromJson({
        'thread': {
          'threadId': 't1',
          'status': 'completed',
          'generatedAt': '2026-01-01T00:01:00.000Z',
        },
        'sourceEventCount': 3,
        'attempts': [
          {
            'attemptId': 'attempt-1',
            'phase': 'execution',
            'retryIndex': 0,
            'status': 'completed',
            'startedAt': '2026-01-01T00:00:00.000Z',
            'endedAt': '2026-01-01T00:00:45.000Z',
          },
        ],
        'timeline': [
          {
            'id': 'user',
            'sequence': 1,
            'eventType': 'thread.status',
            'scope': 'main',
            'role': 'user',
            'text': '帮我改代码',
            'at': '2026-01-01T00:00:00.000Z',
            'metadata': {'liveType': 'thread.user_prompt'},
          },
          {
            'id': 'final',
            'sequence': 4,
            'eventType': 'message.final',
            'scope': 'main',
            'role': 'planner',
            'runAttemptId': 'attempt-1',
            'text': '全部完成。',
            'at': '2026-01-01T00:00:45.000Z',
          },
        ],
        'agents': [
          {
            'agentId': 'agent_coder_1',
            'role': 'coder',
            'kind': 'subagent',
            'status': 'completed',
            'startedAt': '2026-01-01T00:00:05.500Z',
            'endedAt': '2026-01-01T00:00:40.000Z',
            'durationMs': 34500,
            'runAttemptId': 'attempt-1',
            'parentToolUseId': 'toolu_agent',
            'delegationPrompt': '改路由',
            // Skeleton Feed clears agent process timelines → sequence falls to 0.
            'timeline': <Map<String, Object>>[],
          },
        ],
      }),
    );

    expect(feed.map((entry) => entry.kind).toList(), [
      ActivityFeedKind.user,
      ActivityFeedKind.turn,
    ]);
    final turn = feed[1];
    expect(turn.id, 'turn:attempt-1#after:1');
    expect(turn.processEntries.map((entry) => entry.kind).toList(), [
      ActivityFeedKind.subagentMission,
    ]);
    expect(turn.finalOutput?.text, '全部完成。');
  });

  test(
    'mid-turn user prompt splits same attempt so steered output appears after the prompt',
    () {
      final feed = buildActivityFeed(
        threadPrompt: '',
        threadId: 't1',
        runProjection: const ThreadRunProjectionSnapshot(
          threadId: 't1',
          status: 'completed',
          generatedAt: '2026-01-01T00:00:26.000Z',
          sourceEventCount: 4,
          agents: [],
          attempts: [
            ThreadRunProjectionAttempt(
              attemptId: 'attempt-1',
              phase: 'execution',
              retryIndex: 0,
              status: 'completed',
              startedAt: '2026-01-01T00:00:01.000Z',
              endedAt: '2026-01-01T00:00:26.000Z',
            ),
          ],
          timeline: [
            ThreadRunProjectionTimelineItem(
              id: 'user-1',
              sequence: 1,
              eventType: 'thread.status',
              scope: 'main',
              role: 'user',
              text: '你能用浏览器吗？',
              at: '2026-01-01T00:00:00.500Z',
              metadata: {'liveType': 'thread.user_prompt'},
            ),
            ThreadRunProjectionTimelineItem(
              id: 'first-final',
              sequence: 3,
              eventType: 'message.final',
              scope: 'main',
              role: 'planner',
              runAttemptId: 'attempt-1',
              text: '可以，内置浏览器能打开网页。',
              at: '2026-01-01T00:00:05.000Z',
            ),
            ThreadRunProjectionTimelineItem(
              id: 'user-mid',
              sequence: 10,
              eventType: 'thread.status',
              scope: 'main',
              role: 'user',
              text: '可以打开Baidu.com吗',
              at: '2026-01-01T00:00:20.000Z',
              metadata: {'liveType': 'thread.user_prompt'},
            ),
            ThreadRunProjectionTimelineItem(
              id: 'steer-final',
              sequence: 12,
              eventType: 'message.final',
              scope: 'main',
              role: 'planner',
              runAttemptId: 'attempt-1',
              text: '好的，我来打开百度。',
              at: '2026-01-01T00:00:25.000Z',
            ),
          ],
        ),
      );

      expect(feed.map((entry) => entry.kind).toList(), [
        ActivityFeedKind.user,
        ActivityFeedKind.turn,
        ActivityFeedKind.user,
        ActivityFeedKind.turn,
      ]);
      expect(feed[0].text, '你能用浏览器吗？');
      expect(feed[2].text, '可以打开Baidu.com吗');
      expect(feed[1].finalOutput?.text, '可以，内置浏览器能打开网页。');
      expect(feed[3].finalOutput?.text, '好的，我来打开百度。');
    },
  );

  testWidgets(
    'mid-turn prompts show one running heading and keep subsequent output visible',
    (tester) async {
      final controller = ScrollController();
      addTearDown(controller.dispose);

      ThreadRunProjectionSnapshot snapshot({
        required String status,
        required bool initialOutput,
        bool continuedOutput = true,
      }) => ThreadRunProjectionSnapshot(
        threadId: 'midturn',
        status: status,
        generatedAt: '2026-01-01T00:00:08.000Z',
        sourceEventCount: 6,
        agents: const [],
        attempts: [
          ThreadRunProjectionAttempt(
            attemptId: 'attempt-midturn',
            phase: 'execution',
            retryIndex: 0,
            status: status,
            startedAt: '2026-01-01T00:00:01.000Z',
            endedAt: status == 'running' ? null : '2026-01-01T00:00:08.000Z',
          ),
        ],
        timeline: [
          const ThreadRunProjectionTimelineItem(
            id: 'user-first',
            sequence: 1,
            eventType: 'thread.status',
            scope: 'main',
            role: 'user',
            text: '开始检查',
            at: '2026-01-01T00:00:00.000Z',
            metadata: {'liveType': 'thread.user_prompt'},
          ),
          if (initialOutput)
            const ThreadRunProjectionTimelineItem(
              id: 'output-first',
              sequence: 3,
              eventType: 'message.final',
              scope: 'main',
              role: 'planner',
              runAttemptId: 'attempt-midturn',
              text: '先检查代码。',
              at: '2026-01-01T00:00:02.000Z',
            ),
          const ThreadRunProjectionTimelineItem(
            id: 'user-mid',
            sequence: 4,
            eventType: 'thread.status',
            scope: 'main',
            role: 'user',
            text: '补充第一条要求',
            at: '2026-01-01T00:00:03.000Z',
            metadata: {'liveType': 'thread.user_prompt'},
          ),
          if (continuedOutput)
            const ThreadRunProjectionTimelineItem(
              id: 'output-mid',
              sequence: 5,
              eventType: 'message.final',
              scope: 'main',
              role: 'planner',
              runAttemptId: 'attempt-midturn',
              text: '继续检查第一条要求。',
              at: '2026-01-01T00:00:04.000Z',
            ),
          const ThreadRunProjectionTimelineItem(
            id: 'user-mid-2',
            sequence: 6,
            eventType: 'thread.status',
            scope: 'main',
            role: 'user',
            text: '补充第二条要求',
            at: '2026-01-01T00:00:05.000Z',
            metadata: {'liveType': 'thread.user_prompt'},
          ),
          if (continuedOutput)
            const ThreadRunProjectionTimelineItem(
              id: 'output-mid-2',
              sequence: 7,
              eventType: 'message.final',
              scope: 'main',
              role: 'planner',
              runAttemptId: 'attempt-midturn',
              text: '继续检查第二条要求。',
              at: '2026-01-01T00:00:06.000Z',
            ),
        ],
      );

      Future<void> show(ThreadRunProjectionSnapshot projection) async {
        final entries = buildActivityFeed(runProjection: projection);
        await tester.pumpWidget(
          _localizedMaterialApp(
            theme: buildEcoDarkTheme(),
            home: Scaffold(
              body: ActivityFeedList(
                entries: entries,
                scrollController: controller,
                shrinkWrap: true,
              ),
            ),
          ),
        );
        await tester.pump(const Duration(milliseconds: 200));
      }

      for (final initialOutput in [true, false]) {
        await show(
          snapshot(
            status: 'running',
            initialOutput: initialOutput,
            continuedOutput: false,
          ),
        );
        expect(find.textContaining('处理中'), findsOneWidget);

        final running = snapshot(
          status: 'running',
          initialOutput: initialOutput,
        );
        final entries = buildActivityFeed(runProjection: running);
        final turns = entries
            .where((entry) => entry.kind == ActivityFeedKind.turn)
            .toList();
        expect(turns.map((entry) => entry.continuation), [false, true, true]);
        expect(turns[1].processEntries.single.text, '继续检查第一条要求。');
        expect(turns[2].processEntries.single.text, '继续检查第二条要求。');
        expect(
          entries.indexOf(turns[1]),
          greaterThan(entries.indexWhere((entry) => entry.text == '补充第一条要求')),
        );
        expect(
          entries.indexOf(turns[2]),
          greaterThan(entries.indexWhere((entry) => entry.text == '补充第二条要求')),
        );
        await show(running);
        expect(find.textContaining('处理中'), findsOneWidget);
        expect(find.text('继续检查第一条要求。'), findsOneWidget);
        expect(find.text('继续检查第二条要求。'), findsOneWidget);
      }

      for (final status in ['completed', 'cancelled', 'failed']) {
        await show(snapshot(status: status, initialOutput: true));
        expect(find.textContaining('处理中'), findsNothing);
        final heading = status == 'completed' ? '已处理' : '停止了';
        expect(find.textContaining(heading), findsNWidgets(3));
      }
      await tester.pumpWidget(const SizedBox.shrink());
    },
  );

  test(
    'stream rows that keep an early sequence still follow a later mid-turn user prompt',
    () {
      final feed = buildActivityFeed(
        threadPrompt: '',
        threadId: 't1',
        runProjection: const ThreadRunProjectionSnapshot(
          threadId: 't1',
          status: 'completed',
          generatedAt: '2026-01-01T00:00:26.000Z',
          sourceEventCount: 4,
          agents: [],
          attempts: [
            ThreadRunProjectionAttempt(
              attemptId: 'attempt-1',
              phase: 'execution',
              retryIndex: 0,
              status: 'completed',
              startedAt: '2026-01-01T00:00:01.000Z',
              endedAt: '2026-01-01T00:00:26.000Z',
            ),
          ],
          timeline: [
            ThreadRunProjectionTimelineItem(
              id: 'user-1',
              sequence: 1,
              eventType: 'thread.status',
              scope: 'main',
              role: 'user',
              text: '先看看',
              at: '2026-01-01T00:00:00.500Z',
              metadata: {'liveType': 'thread.user_prompt'},
            ),
            ThreadRunProjectionTimelineItem(
              id: 'user-mid',
              sequence: 82,
              eventType: 'thread.status',
              scope: 'main',
              role: 'user',
              text: '继续改',
              at: '2026-01-01T00:00:20.000Z',
              metadata: {'liveType': 'thread.user_prompt'},
            ),
            ThreadRunProjectionTimelineItem(
              id: 'stale-seq-final',
              sequence: 50,
              eventType: 'message.final',
              scope: 'main',
              role: 'planner',
              runAttemptId: 'attempt-1',
              text: '这是跟在后续消息后面的回答。',
              at: '2026-01-01T00:00:25.000Z',
            ),
            ThreadRunProjectionTimelineItem(
              id: 'tool-after',
              sequence: 90,
              eventType: 'tool.started',
              scope: 'main',
              role: 'tool',
              runAttemptId: 'attempt-1',
              text: 'Tool: Bash · ls',
              at: '2026-01-01T00:00:22.000Z',
              metadata: {
                'tool': {
                  'name': 'Bash',
                  'detail': 'ls',
                  'toolUseId': 'toolu_after',
                  'status': 'running',
                },
              },
            ),
          ],
        ),
      );

      final midIndex = feed.indexWhere((entry) => entry.text == '继续改');
      expect(midIndex, greaterThanOrEqualTo(0));
      expect(feed[midIndex].kind, ActivityFeedKind.user);
      final turnAfter = feed
          .skip(midIndex + 1)
          .firstWhere((entry) => entry.kind == ActivityFeedKind.turn);
      expect(turnAfter.finalOutput?.text, '这是跟在后续消息后面的回答。');
    },
  );

  test(
    'main-scope message.user mid-turn prompt renders as a user bubble and splits the turn',
    () {
      final feed = buildActivityFeed(
        threadPrompt: '',
        threadId: 't1',
        runProjection: const ThreadRunProjectionSnapshot(
          threadId: 't1',
          status: 'completed',
          generatedAt: '2026-01-01T00:00:26.000Z',
          sourceEventCount: 4,
          agents: [],
          attempts: [
            ThreadRunProjectionAttempt(
              attemptId: 'attempt-1',
              phase: 'execution',
              retryIndex: 0,
              status: 'completed',
              startedAt: '2026-01-01T00:00:01.000Z',
              endedAt: '2026-01-01T00:00:26.000Z',
            ),
          ],
          timeline: [
            ThreadRunProjectionTimelineItem(
              id: 'user-1',
              sequence: 1,
              eventType: 'thread.status',
              scope: 'main',
              role: 'user',
              text: '先改登录',
              at: '2026-01-01T00:00:00.500Z',
              metadata: {'liveType': 'thread.user_prompt'},
            ),
            ThreadRunProjectionTimelineItem(
              id: 'first-final',
              sequence: 3,
              eventType: 'message.final',
              scope: 'main',
              role: 'planner',
              runAttemptId: 'attempt-1',
              text: '登录页已改好。',
              at: '2026-01-01T00:00:05.000Z',
            ),
            ThreadRunProjectionTimelineItem(
              id: 'user-mid',
              sequence: 10,
              eventType: 'message.final',
              scope: 'main',
              role: 'user',
              text: '再补上注册',
              at: '2026-01-01T00:00:20.000Z',
              metadata: {'liveType': 'message.user'},
            ),
            ThreadRunProjectionTimelineItem(
              id: 'steer-final',
              sequence: 12,
              eventType: 'message.final',
              scope: 'main',
              role: 'planner',
              runAttemptId: 'attempt-1',
              text: '注册也补上了。',
              at: '2026-01-01T00:00:25.000Z',
            ),
          ],
        ),
      );

      expect(
        feed
            .where((entry) => entry.kind == ActivityFeedKind.user)
            .map((entry) => entry.text),
        ['先改登录', '再补上注册'],
      );
      expect(feed.map((entry) => entry.kind).toList(), [
        ActivityFeedKind.user,
        ActivityFeedKind.turn,
        ActivityFeedKind.user,
        ActivityFeedKind.turn,
      ]);
      expect(feed[3].finalOutput?.text, '注册也补上了。');
    },
  );

  testWidgets(
    'completed turn collapses process and keeps final output visible',
    (tester) async {
      final controller = ScrollController();
      addTearDown(controller.dispose);
      await tester.pumpWidget(
        _localizedMaterialApp(
          theme: buildEcoDarkTheme(),
          home: Scaffold(
            body: ActivityFeedList(
              scrollController: controller,
              shrinkWrap: true,
              entries: const [
                ActivityFeedEntry(
                  id: 'turn-1',
                  kind: ActivityFeedKind.turn,
                  text: '',
                  durationMs: 2000,
                  processEntries: [
                    ActivityFeedEntry(
                      id: 'process-1',
                      kind: ActivityFeedKind.assistant,
                      text: '执行过程正文',
                    ),
                  ],
                  finalOutput: ActivityFeedEntry(
                    id: 'final-1',
                    kind: ActivityFeedKind.assistant,
                    text: '最终输出正文',
                  ),
                ),
              ],
            ),
          ),
        ),
      );
      await tester.pump();

      expect(find.textContaining('已处理'), findsOneWidget);
      expect(find.text('最终输出正文'), findsOneWidget);
      expect(find.text('执行过程正文'), findsNothing);

      await tester.tap(find.textContaining('已处理'));
      await tester.pumpAndSettle();
      expect(find.text('执行过程正文'), findsOneWidget);
    },
  );

  testWidgets(
    'running conversation keeps copy on user prompts but hides it on agent output',
    (tester) async {
      final controller = ScrollController();
      addTearDown(controller.dispose);
      await tester.pumpWidget(
        _localizedMaterialApp(
          theme: buildEcoDarkTheme(),
          home: Scaffold(
            body: ActivityFeedList(
              scrollController: controller,
              shrinkWrap: true,
              // 会话进行中：只有 agent 侧输出延迟挂 meta。
              showMessageCopyAndTime: false,
              entries: const [
                ActivityFeedEntry(
                  id: 'user-1',
                  kind: ActivityFeedKind.user,
                  text: '帮我把复制按钮加回来',
                ),
                ActivityFeedEntry(
                  id: 'turn-1',
                  kind: ActivityFeedKind.turn,
                  text: '',
                  running: true,
                  finalOutput: ActivityFeedEntry(
                    id: 'final-1',
                    kind: ActivityFeedKind.assistant,
                    text: '正在处理',
                  ),
                ),
              ],
            ),
          ),
        ),
      );
      await tester.pump();

      // 用户消息始终可复制；agent 侧流式输出仍不挂复制，所以全场只有一个复制按钮。
      expect(find.byIcon(EcoIcons.copy), findsOneWidget);

      // 只保留进行中的 agent 回合时，仍不出现复制按钮。
      final agentController = ScrollController();
      addTearDown(agentController.dispose);
      await tester.pumpWidget(
        _localizedMaterialApp(
          theme: buildEcoDarkTheme(),
          home: Scaffold(
            body: ActivityFeedList(
              scrollController: agentController,
              shrinkWrap: true,
              showMessageCopyAndTime: false,
              entries: const [
                ActivityFeedEntry(
                  id: 'turn-1',
                  kind: ActivityFeedKind.turn,
                  text: '',
                  running: true,
                  finalOutput: ActivityFeedEntry(
                    id: 'final-1',
                    kind: ActivityFeedKind.assistant,
                    text: '正在处理',
                  ),
                ),
              ],
            ),
          ),
        ),
      );
      await tester.pump();
      expect(find.text('正在处理'), findsOneWidget);
      expect(find.byIcon(EcoIcons.copy), findsNothing);
    },
  );

  testWidgets('manually cancelled turn shows who stopped it and elapsed time', (
    tester,
  ) async {
    final controller = ScrollController();
    addTearDown(controller.dispose);
    await tester.pumpWidget(
      _localizedMaterialApp(
        theme: buildEcoDarkTheme(),
        home: Scaffold(
          body: ActivityFeedList(
            scrollController: controller,
            shrinkWrap: true,
            entries: const [
              ActivityFeedEntry(
                id: 'turn-cancelled',
                kind: ActivityFeedKind.turn,
                text: '',
                turnStatus: 'cancelled',
                durationMs: 5000,
              ),
            ],
          ),
        ),
      ),
    );
    await tester.pump();

    expect(find.text('你在 5秒 后停止了'), findsOneWidget);
    expect(find.textContaining('已处理'), findsNothing);
  });

  testWidgets('unexpectedly failed turn shows run stopped and elapsed time', (
    tester,
  ) async {
    final controller = ScrollController();
    addTearDown(controller.dispose);
    await tester.pumpWidget(
      _localizedMaterialApp(
        theme: buildEcoDarkTheme(),
        home: Scaffold(
          body: ActivityFeedList(
            scrollController: controller,
            shrinkWrap: true,
            entries: const [
              ActivityFeedEntry(
                id: 'turn-failed',
                kind: ActivityFeedKind.turn,
                text: '',
                turnStatus: 'failed',
                durationMs: 5000,
              ),
            ],
          ),
        ),
      ),
    );
    await tester.pump();

    expect(find.text('运行 5秒 后停止了'), findsOneWidget);
    expect(find.textContaining('已处理'), findsNothing);
  });

  test(
    'subagent detail feed shows mission once and keeps follow-up user prompts',
    () {
      final entries = buildProjectionDetailEntries(
        threadId: 'thread-1',
        base: const ThreadRunProjectionSnapshot(
          threadId: 'thread-1',
          status: 'completed',
          generatedAt: '2026-01-01T00:00:04.000Z',
          sourceEventCount: 4,
          agents: [],
          attempts: [
            ThreadRunProjectionAttempt(
              attemptId: 'attempt-1',
              phase: 'main',
              retryIndex: 0,
              status: 'completed',
              startedAt: '2026-01-01T00:00:00.000Z',
              endedAt: '2026-01-01T00:00:04.000Z',
            ),
          ],
          timeline: [
            ThreadRunProjectionTimelineItem(
              id: 'main-user-prompt',
              sequence: 1,
              eventType: 'thread.status',
              scope: 'main',
              role: 'user',
              runAttemptId: 'attempt-1',
              text: '请检查登录流程',
              at: '2026-01-01T00:00:00.000Z',
              metadata: {'liveType': 'thread.user_prompt'},
            ),
          ],
        ),
        cachedTimeline: const [
          ThreadRunProjectionTimelineItem(
            id: 'agent-started',
            sequence: 2,
            eventType: 'agent.started',
            scope: 'agent',
            role: 'explore',
            runAttemptId: 'attempt-1',
            text: 'Subagent explore started',
            at: '2026-01-01T00:00:00.500Z',
          ),
          ThreadRunProjectionTimelineItem(
            id: 'mission-envelope',
            sequence: 3,
            eventType: 'message.final',
            scope: 'agent',
            role: 'explore',
            runAttemptId: 'attempt-1',
            text: '@mission explore: 梳理 auth 流程',
            at: '2026-01-01T00:00:00.600Z',
            metadata: {'liveType': 'message.user'},
          ),
          ThreadRunProjectionTimelineItem(
            id: 'duplicate-mission-prompt',
            sequence: 4,
            eventType: 'message.final',
            scope: 'agent',
            role: 'explore',
            runAttemptId: 'attempt-1',
            text: '梳理 auth 流程',
            at: '2026-01-01T00:00:00.700Z',
            metadata: {'liveType': 'message.user'},
          ),
          ThreadRunProjectionTimelineItem(
            id: 'follow-up-prompt',
            sequence: 5,
            eventType: 'message.final',
            scope: 'agent',
            role: 'explore',
            runAttemptId: 'attempt-1',
            requestId: 'req-2',
            text: '重点看 OAuth 回调',
            at: '2026-01-01T00:00:02.000Z',
            metadata: {'liveType': 'message.user'},
          ),
          ThreadRunProjectionTimelineItem(
            id: 'agent-result',
            sequence: 6,
            eventType: 'message.final',
            scope: 'agent',
            role: 'explore',
            runAttemptId: 'attempt-1',
            text: '已完成检查。',
            at: '2026-01-01T00:00:03.000Z',
          ),
        ],
        detail: null,
        missionText: '梳理 auth 流程',
        injectMainThreadUserPrompts: false,
        l10n: lookupAppLocalizations(const Locale('zh')),
      );

      final userEntries = entries
          .where((entry) => entry.kind == ActivityFeedKind.user)
          .toList();
      expect(userEntries.map((entry) => entry.text), [
        '梳理 auth 流程',
        '重点看 OAuth 回调',
      ]);
      expect(entries.any((entry) => entry.text == '请检查登录流程'), isFalse);
      expect(entries.any((entry) => entry.text.contains('@mission')), isFalse);
      expect(
        entries.any((entry) => entry.text == 'Subagent explore started'),
        isFalse,
      );

      final turn = entries.where(
        (entry) => entry.kind == ActivityFeedKind.turn,
      );
      expect(turn, isNotEmpty);
      expect(turn.first.finalOutput?.text, '已完成检查。');
    },
  );

  testWidgets('completed thinking collapses behind deep-thinking summary', (
    tester,
  ) async {
    final controller = ScrollController();
    addTearDown(controller.dispose);
    await tester.pumpWidget(
      _localizedMaterialApp(
        theme: buildEcoDarkTheme(),
        home: Scaffold(
          body: ActivityFeedList(
            scrollController: controller,
            shrinkWrap: true,
            entries: const [
              ActivityFeedEntry(
                id: 'thinking-1',
                kind: ActivityFeedKind.thinking,
                text: '这段思考只能在展开后显示',
              ),
            ],
          ),
        ),
      ),
    );
    await tester.pump();

    expect(find.text('已思考'), findsOneWidget);
    expect(
      find.byKey(const ValueKey('activity-thinking-icon')),
      findsOneWidget,
    );
    expect(find.text('这段思考只能在展开后显示'), findsNothing);

    await tester.tap(find.text('已思考'));
    await tester.pumpAndSettle();

    expect(find.text('这段思考只能在展开后显示'), findsOneWidget);
  });

  testWidgets('completed thinking summary includes turn-style duration', (
    tester,
  ) async {
    final controller = ScrollController();
    addTearDown(controller.dispose);
    await tester.pumpWidget(
      _localizedMaterialApp(
        theme: buildEcoDarkTheme(),
        home: Scaffold(
          body: ActivityFeedList(
            scrollController: controller,
            shrinkWrap: true,
            entries: const [
              ActivityFeedEntry(
                id: 'thinking-timed',
                kind: ActivityFeedKind.thinking,
                text: '带耗时的思考',
                startedAt: '2026-01-01T00:00:00.000Z',
                endedAt: '2026-01-01T00:00:05.000Z',
                durationMs: 5000,
              ),
            ],
          ),
        ),
      ),
    );
    await tester.pump();

    expect(find.text('已思考 5s'), findsOneWidget);
    expect(find.text('带耗时的思考'), findsNothing);
  });

  testWidgets('zero-duration thinking omits the 0s suffix', (tester) async {
    final controller = ScrollController();
    addTearDown(controller.dispose);
    await tester.pumpWidget(
      _localizedMaterialApp(
        theme: buildEcoDarkTheme(),
        home: Scaffold(
          body: ActivityFeedList(
            scrollController: controller,
            shrinkWrap: true,
            entries: const [
              ActivityFeedEntry(
                id: 'thinking-zero-duration',
                kind: ActivityFeedKind.thinking,
                text: '零秒思考',
                durationMs: 0,
              ),
            ],
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('已思考'), findsOneWidget);
    expect(find.text('已思考 0s'), findsNothing);
  });

  testWidgets('streaming thinking stays expanded with live body', (
    tester,
  ) async {
    final controller = ScrollController();
    addTearDown(controller.dispose);
    await tester.pumpWidget(
      _localizedMaterialApp(
        theme: buildEcoDarkTheme(),
        home: Scaffold(
          body: ActivityFeedList(
            scrollController: controller,
            shrinkWrap: true,
            entries: const [
              ActivityFeedEntry(
                id: 'thinking-stream',
                kind: ActivityFeedKind.thinking,
                text: '正在输出的思考内容',
                streaming: true,
              ),
            ],
          ),
        ),
      ),
    );
    for (var index = 0; index < 40; index++) {
      await tester.pump(pacedStreamInterval);
    }

    expect(find.text('正在思考'), findsOneWidget);
    expect(
      find.byKey(const ValueKey('activity-thinking-icon')),
      findsOneWidget,
    );
    expect(find.text('正在输出的思考内容'), findsOneWidget);
  });

  testWidgets('empty streaming thinking shows shimmer-only waiting line', (
    tester,
  ) async {
    final controller = ScrollController();
    addTearDown(controller.dispose);
    await tester.pumpWidget(
      _localizedMaterialApp(
        theme: buildEcoDarkTheme(),
        home: Scaffold(
          body: ActivityFeedList(
            scrollController: controller,
            shrinkWrap: true,
            entries: const [
              ActivityFeedEntry(
                id: 'thinking-empty',
                kind: ActivityFeedKind.thinking,
                text: '',
                streaming: true,
              ),
            ],
          ),
        ),
      ),
    );
    await tester.pump();

    expect(find.text('正在思考'), findsOneWidget);
    expect(
      find.byKey(const ValueKey('activity-waiting-thinking')),
      findsOneWidget,
    );
    expect(find.byKey(const ValueKey('activity-thinking-icon')), findsNothing);
  });

  testWidgets('reasoning stage renders as ephemeral tip status', (
    tester,
  ) async {
    final controller = ScrollController();
    addTearDown(controller.dispose);
    await tester.pumpWidget(
      _localizedMaterialApp(
        theme: buildEcoDarkTheme(),
        home: Scaffold(
          body: ActivityFeedList(
            scrollController: controller,
            shrinkWrap: true,
            entries: const [
              ActivityFeedEntry(
                id: 'stage-1',
                kind: ActivityFeedKind.reasoningStage,
                text: '定位入口',
                streaming: true,
              ),
            ],
          ),
        ),
      ),
    );
    await tester.pump();

    expect(find.text('定位入口'), findsOneWidget);
    expect(
      find.byKey(const ValueKey('activity-waiting-thinking')),
      findsOneWidget,
    );
    expect(find.byKey(const ValueKey('activity-thinking-icon')), findsNothing);
    expect(find.text('正在思考'), findsNothing);
    expect(find.text('已思考'), findsNothing);
  });

  testWidgets('reasoning stage carousel shows one stage and advances upward', (
    tester,
  ) async {
    final controller = ScrollController();
    addTearDown(controller.dispose);
    await tester.pumpWidget(
      _localizedMaterialApp(
        theme: buildEcoDarkTheme(),
        home: Scaffold(
          body: ActivityFeedList(
            scrollController: controller,
            shrinkWrap: true,
            entries: const [
              ActivityFeedEntry(
                id: 'stage-carousel',
                kind: ActivityFeedKind.reasoningStage,
                text: 'Planning first stage\nRefining second stage',
                streaming: true,
              ),
            ],
          ),
        ),
      ),
    );
    await tester.pump();

    expect(find.text('Planning first stage'), findsOneWidget);
    expect(find.text('Refining second stage'), findsNothing);

    await tester.pump(const Duration(milliseconds: 2601));
    await tester.pump(const Duration(milliseconds: 300));

    expect(find.text('Planning first stage'), findsNothing);
    expect(find.text('Refining second stage'), findsOneWidget);
  });

  testWidgets('streaming prose keeps Markdown rendering before a blank line', (
    tester,
  ) async {
    final controller = ScrollController();
    addTearDown(controller.dispose);
    await tester.pumpWidget(
      _localizedMaterialApp(
        theme: buildEcoDarkTheme(),
        home: Scaffold(
          body: ActivityFeedList(
            scrollController: controller,
            shrinkWrap: true,
            entries: const [
              ActivityFeedEntry(
                id: 'assistant-streaming-markdown',
                kind: ActivityFeedKind.assistant,
                text: '**加粗内容**',
                streaming: true,
              ),
            ],
          ),
        ),
      ),
    );
    for (var index = 0; index < 40; index++) {
      await tester.pump(pacedStreamInterval);
    }

    expect(find.byType(EcoMarkdown), findsOneWidget);
    expect(find.text('加粗内容'), findsOneWidget);
    expect(find.text('**加粗内容**'), findsNothing);
  });

  testWidgets('thinking auto-collapses when streaming completes', (
    tester,
  ) async {
    final controller = ScrollController();
    addTearDown(controller.dispose);

    Widget app({required bool streaming}) {
      return _localizedMaterialApp(
        theme: buildEcoDarkTheme(),
        home: Scaffold(
          body: ActivityFeedList(
            scrollController: controller,
            shrinkWrap: true,
            entries: [
              ActivityFeedEntry(
                id: 'thinking-auto',
                kind: ActivityFeedKind.thinking,
                text: '完成后应自动折叠',
                streaming: streaming,
              ),
            ],
          ),
        ),
      );
    }

    await tester.pumpWidget(app(streaming: true));
    for (var index = 0; index < 40; index++) {
      await tester.pump(pacedStreamInterval);
    }
    expect(find.text('完成后应自动折叠'), findsOneWidget);

    await tester.pumpWidget(app(streaming: false));
    for (var index = 0; index < 20; index++) {
      await tester.pump(pacedStreamInterval);
    }

    expect(find.text('已思考'), findsOneWidget);
    expect(find.text('完成后应自动折叠'), findsNothing);
  });

  testWidgets('primary feed rows share one font size', (tester) async {
    final controller = ScrollController();
    addTearDown(controller.dispose);
    await tester.pumpWidget(
      _localizedMaterialApp(
        theme: buildEcoDarkTheme(),
        home: Scaffold(
          body: ActivityFeedList(
            scrollController: controller,
            shrinkWrap: true,
            entries: const [
              ActivityFeedEntry(
                id: 'user-font',
                kind: ActivityFeedKind.user,
                text: '用户消息字号',
              ),
              ActivityFeedEntry(
                id: 'assistant-font',
                kind: ActivityFeedKind.assistant,
                text: '正文输出字号',
                streaming: true,
              ),
              ActivityFeedEntry(
                id: 'thinking-font',
                kind: ActivityFeedKind.thinking,
                text: '',
                streaming: true,
              ),
              ActivityFeedEntry(
                id: 'turn-font',
                kind: ActivityFeedKind.turn,
                text: '',
                durationMs: 2000,
              ),
            ],
          ),
        ),
      ),
    );
    await tester.pump();
    for (var index = 0; index < 12; index++) {
      await tester.pump(pacedStreamInterval);
    }

    double? fontSize(String text) {
      for (final element in find.text(text).evaluate()) {
        final widget = element.widget;
        if (widget is! Text) continue;
        final span = widget.textSpan;
        return widget.style?.fontSize ??
            (span is TextSpan ? span.style?.fontSize : null);
      }
      return null;
    }

    final expected = fontSize('用户消息字号');
    expect(expected, isNotNull);
    expect(fontSize('正文输出字号'), expected);
    expect(fontSize('正在思考'), expected);
  });

  test('groupActivityFeedActionEntries includes Bash cards in tool groups', () {
    final grouped = groupActivityFeedActionEntries(const [
      ActivityFeedEntry(
        id: 'read-1',
        kind: ActivityFeedKind.action,
        text: 'lib/feed.dart',
        actionIcon: ActivityActionIcon.read,
      ),
      ActivityFeedEntry(
        id: 'edit-1',
        kind: ActivityFeedKind.action,
        text: 'lib/editor.dart',
        actionIcon: ActivityActionIcon.edit,
      ),
      ActivityFeedEntry(
        id: 'bash-1',
        kind: ActivityFeedKind.action,
        text: 'Run unit tests',
        actionIcon: ActivityActionIcon.terminal,
        bashRun: BashRunCardDisplay(
          title: 'Run unit tests',
          meta: 'npm, 1.2s',
          command: 'npm test',
          output: '36 pass',
        ),
      ),
      ActivityFeedEntry(
        id: 'search-1',
        kind: ActivityFeedKind.action,
        text: 'search ActivityFeed',
        actionIcon: ActivityActionIcon.search,
      ),
      ActivityFeedEntry(
        id: 'read-2',
        kind: ActivityFeedKind.action,
        text: 'lib/theme.dart',
        actionIcon: ActivityActionIcon.read,
      ),
    ]);

    expect(grouped, hasLength(1));
    expect(grouped.single.id, 'action-group:read-1');
    expect(grouped.single.actionChildren, hasLength(5));
    expect(grouped.single.actionChildren[2].bashRun?.command, 'npm test');
    expect(grouped.single.actionChildren[2].bashRun?.output, '36 pass');
  });

  test('tool group shows the latest running action as 正在...', () {
    final grouped = groupActivityFeedActionEntries(const [
      ActivityFeedEntry(
        id: 'read-1',
        kind: ActivityFeedKind.action,
        text: 'lib/feed.dart',
        toolName: 'Read',
        actionIcon: ActivityActionIcon.read,
        lifecycle: ToolActionLifecycle.completed,
      ),
      ActivityFeedEntry(
        id: 'bash-1',
        kind: ActivityFeedKind.action,
        text: 'npm test',
        toolName: 'Bash',
        actionIcon: ActivityActionIcon.terminal,
        lifecycle: ToolActionLifecycle.running,
      ),
    ]);

    expect(grouped.single.text, '正在运行 npm test');
    expect(grouped.single.lifecycle, ToolActionLifecycle.running);
    expect(grouped.single.id, 'action-group:read-1');
  });

  test('projects imageView as an independent entry beside tool groups', () {
    final feed = buildActivityFeed(
      threadPrompt: '',
      threadId: 't1',
      groupTurns: false,
      runProjection: const ThreadRunProjectionSnapshot(
        threadId: 't1',
        status: 'completed',
        generatedAt: '2026-01-01T00:00:02.000Z',
        sourceEventCount: 2,
        agents: [],
        timeline: [
          ThreadRunProjectionTimelineItem(
            id: 'image-item',
            sequence: 1,
            eventType: 'tool.completed',
            scope: 'main',
            text: 'Tool: ViewImage · /tmp/preview.png',
            at: '2026-01-01T00:00:01.000Z',
            metadata: {
              'tool': {
                'name': 'ViewImage',
                'toolUseId': 'image-tool-1',
                'status': 'completed',
                'imageView': {'path': '/tmp/preview.png'},
              },
            },
          ),
          ThreadRunProjectionTimelineItem(
            id: 'read-item',
            sequence: 2,
            eventType: 'tool.completed',
            scope: 'main',
            text: 'Tool: Read · lib/feed.dart',
            at: '2026-01-01T00:00:02.000Z',
            metadata: {
              'tool': {
                'name': 'Read',
                'toolUseId': 'read-tool-1',
                'status': 'completed',
                'readTarget': {'filePath': 'lib/feed.dart'},
              },
            },
          ),
        ],
      ),
    );

    expect(feed, hasLength(2));
    expect(feed.first.kind, ActivityFeedKind.imageView);
    expect(feed.first.imageView?.path, '/tmp/preview.png');
    expect(feed.first.imageView?.eventId, 'image-item');
    expect(feed.last.kind, ActivityFeedKind.actionGroup);
    expect(feed.last.actionChildren.single.toolName, 'Read');
  });

  test('PI mcp search metadata classifies as mcpSearch', () {
    final feed = buildActivityFeed(
      threadPrompt: '',
      threadId: 't1',
      groupTurns: false,
      runProjection: const ThreadRunProjectionSnapshot(
        threadId: 't1',
        status: 'completed',
        generatedAt: '2026-01-01T00:00:01.000Z',
        sourceEventCount: 1,
        agents: [],
        timeline: [
          ThreadRunProjectionTimelineItem(
            id: 'pi-mcp-search',
            sequence: 1,
            eventType: 'tool.completed',
            scope: 'main',
            text: 'Tool: mcp',
            at: '2026-01-01T00:00:01.000Z',
            metadata: {
              'tool': {
                'name': 'mcp',
                'toolUseId': 'tool_mcp_search',
                'status': 'completed',
                'mcpDiscovery': {'kind': 'search'},
              },
            },
          ),
        ],
      ),
    );

    expect(feed.single.text, '查找 MCP 工具');
    expect(feed.single.text, isNot(contains('调用了 MCP 工具')));
  });

  test('projects eco_image_view MCP imageView as an independent entry', () {
    final feed = buildActivityFeed(
      threadPrompt: '',
      threadId: 't1',
      groupTurns: false,
      runProjection: const ThreadRunProjectionSnapshot(
        threadId: 't1',
        status: 'completed',
        generatedAt: '2026-01-01T00:00:02.000Z',
        sourceEventCount: 2,
        agents: [],
        timeline: [
          ThreadRunProjectionTimelineItem(
            id: 'eco-image-item',
            sequence: 1,
            eventType: 'tool.completed',
            scope: 'main',
            text: 'Tool: mcp__eco_image_view__view_image · /tmp/preview.png',
            at: '2026-01-01T00:00:01.000Z',
            metadata: {
              'tool': {
                'name': 'mcp__eco_image_view__view_image',
                'toolUseId': 'eco-image-tool-1',
                'status': 'completed',
                'imageView': {'path': '/tmp/preview.png'},
              },
            },
          ),
          ThreadRunProjectionTimelineItem(
            id: 'read-item',
            sequence: 2,
            eventType: 'tool.completed',
            scope: 'main',
            text: 'Tool: Read · lib/feed.dart',
            at: '2026-01-01T00:00:02.000Z',
            metadata: {
              'tool': {
                'name': 'Read',
                'toolUseId': 'read-tool-1',
                'status': 'completed',
                'readTarget': {'filePath': 'lib/feed.dart'},
              },
            },
          ),
        ],
      ),
    );

    expect(feed, hasLength(2));
    expect(feed.first.kind, ActivityFeedKind.imageView);
    expect(feed.first.imageView?.path, '/tmp/preview.png');
    expect(feed.first.imageView?.eventId, 'eco-image-item');
    expect(feed.last.kind, ActivityFeedKind.actionGroup);
    expect(feed.last.actionChildren.single.toolName, 'Read');
  });

  test('upgrades persisted unprojected imageView records', () {
    final feed = buildActivityFeed(
      threadPrompt: '',
      threadId: 't1',
      groupTurns: false,
      runProjection: const ThreadRunProjectionSnapshot(
        threadId: 't1',
        status: 'completed',
        generatedAt: '2026-01-01T00:00:02.000Z',
        sourceEventCount: 1,
        agents: [],
        timeline: [
          ThreadRunProjectionTimelineItem(
            id: 'legacy-image-item',
            sequence: 1,
            eventType: 'thread.status',
            scope: 'main',
            text: '未知类型 · imageView',
            at: '2026-01-01T00:00:01.000Z',
            metadata: {
              'liveType': 'codex.item.unprojected',
              'itemType': 'imageView',
              'unprojectedPhase': 'completed',
              'payloadJson': '{"type":"imageView","path":"/tmp/legacy.png"}',
            },
          ),
        ],
      ),
    );

    expect(feed, hasLength(1));
    expect(feed.single.kind, ActivityFeedKind.imageView);
    expect(feed.single.imageView?.path, '/tmp/legacy.png');
    expect(feed.single.imageView?.eventId, 'legacy-image-item');
  });

  testWidgets('imageView stays collapsed without requesting the image', (
    tester,
  ) async {
    final controller = ScrollController();
    addTearDown(controller.dispose);
    var loadCount = 0;

    await tester.pumpWidget(
      _localizedMaterialApp(
        theme: buildEcoDarkTheme(),
        home: Scaffold(
          body: ActivityFeedList(
            entries: const [_imageViewFeedEntry],
            scrollController: controller,
            shrinkWrap: true,
            loadImageView: (_) {
              loadCount += 1;
              return Future.value(_imageViewData());
            },
          ),
        ),
      ),
    );
    await tester.pump();

    expect(loadCount, 0);
    expect(find.text('已查看 1 张图像'), findsOneWidget);
  });

  testWidgets(
    'imageView loads on expand, caches, retries, and opens a viewer',
    (tester) async {
      final controller = ScrollController();
      addTearDown(controller.dispose);
      var loadCount = 0;

      await tester.pumpWidget(
        _localizedMaterialApp(
          theme: buildEcoDarkTheme(),
          home: Scaffold(
            body: ActivityFeedList(
              entries: const [_imageViewFeedEntry],
              scrollController: controller,
              shrinkWrap: true,
              loadImageView: (_) {
                loadCount += 1;
                if (loadCount == 1) {
                  return Future.error(
                    const ImageViewReadException(
                      ImageViewReadFailureCode.tooLarge,
                    ),
                  );
                }
                return Future.value(_imageViewData());
              },
            ),
          ),
        ),
      );
      await tester.pump();

      final summary = find.byKey(
        const ValueKey('activity-image-view-summary-image-entry'),
      );
      await tester.tap(summary);
      await tester.pumpAndSettle();
      expect(loadCount, 1);
      expect(find.text('图片超过 20 MB，无法在 Feed 中预览。'), findsOneWidget);

      await tester.tap(find.byTooltip('重试'));
      await tester.pumpAndSettle();
      expect(loadCount, 2);
      expect(
        find.byKey(const ValueKey('activity-image-view-image-image-entry')),
        findsOneWidget,
      );

      await tester.tap(
        find.byKey(const ValueKey('activity-image-view-preview-image-entry')),
      );
      await tester.pumpAndSettle();
      expect(find.byType(InteractiveViewer), findsOneWidget);

      await tester.tap(find.byIcon(EcoIcons.close));
      await tester.pumpAndSettle();

      await tester.tap(summary);
      await tester.pump();
      await tester.tap(summary);
      await tester.pumpAndSettle();
      expect(loadCount, 2);
    },
  );

  test(
    'subagentMissionBorderColor uses unknown blue for non-standard roles',
    () {
      expect(
        resolveSubagentThemeColor('researcher'),
        subagentUnknownThemeColor,
      );
    },
  );

  test('parseSubagentMissionMessage extracts summary from @mission JSON', () {
    const payload =
        '@mission {"role":"explore","summary":"梳理 auth 模块","prompt":"check auth flow"}';
    final mission = parseSubagentMissionMessage(payload);
    expect(mission?.role, 'explore');
    expect(mission?.summary, '梳理 auth 模块');
    expect(mission?.prompt, 'check auth flow');
  });

  test(
    'isLegacyBashApprovalActivityText matches approval transition variants',
    () {
      const noise = [
        '辅助模型已允许 Bash：npm test',
        '辅助模型已允许 Read：/etc/hosts',
        '辅助模型已允许：npm test',
        '已允许 Bash：npm test',
        '已允许：npm test',
        '已允许本次 Bash：npm test',
        '已允许本次 Read：/etc/hosts',
        '已允许本次图片创建',
        '已允许打开浏览器：https://example.com',
        '已允许打开内置浏览器',
        '已拒绝 Bash：涉及生产环境',
        '已拒绝 Read：/outside/secret.txt',
        '已拒绝：风险较高',
        'Bash 已拒绝：涉及生产环境',
        '等待确认 Bash：npm test',
        '等待确认 Read：/etc/hosts',
      ];
      for (final line in noise) {
        expect(isLegacyBashApprovalActivityText(line), isTrue, reason: line);
      }
      const kept = ['已允许，继续执行。', '等待确认 npm test && npm run lint', '正在执行测试命令。'];
      for (final line in kept) {
        expect(isLegacyBashApprovalActivityText(line), isFalse, reason: line);
      }
    },
  );

  test('approval transition text never surfaces as feed assistant lines', () {
    final feed = buildActivityFeed(
      threadPrompt: '',
      threadId: 't1',
      runProjection: ThreadRunProjectionSnapshot(
        threadId: 't1',
        status: 'running',
        generatedAt: '2026-01-01T00:00:00.000Z',
        sourceEventCount: 4,
        agents: const [],
        timeline: [
          ThreadRunProjectionTimelineItem(
            id: 'auto-allow',
            sequence: 1,
            eventType: 'message.final',
            scope: 'main',
            role: 'tool',
            text: '辅助模型已允许 Bash：npm test',
            at: '2026-01-01T00:00:00.000Z',
            metadata: const {'liveType': 'bash_approval.approved'},
          ),
          ThreadRunProjectionTimelineItem(
            id: 'auto-allow-fs',
            sequence: 2,
            eventType: 'message.final',
            scope: 'main',
            role: 'tool',
            text: '辅助模型已允许 Read：/etc/hosts',
            at: '2026-01-01T00:00:00.250Z',
          ),
          ThreadRunProjectionTimelineItem(
            id: 'auto-deny',
            sequence: 3,
            eventType: 'message.final',
            scope: 'main',
            role: 'tool',
            text: '已拒绝 Bash：涉及生产环境',
            at: '2026-01-01T00:00:00.500Z',
            metadata: const {'liveType': 'bash_approval.denied'},
          ),
          ThreadRunProjectionTimelineItem(
            id: 'planner-note',
            sequence: 4,
            eventType: 'message.final',
            scope: 'main',
            role: 'planner',
            text: '正在执行测试命令。',
            at: '2026-01-01T00:00:00.750Z',
          ),
        ],
      ),
    );

    expect(
      feed.any(
        (entry) =>
            entry.kind == ActivityFeedKind.assistant &&
            (entry.text.contains('辅助模型已允许') || entry.text.contains('已拒绝 Bash')),
      ),
      isFalse,
    );
    expect(feed.any((entry) => entry.text.contains('正在执行测试命令。')), isTrue);
  });

  test('bash approval merges into the same action row by toolUseId', () {
    final feed = buildActivityFeed(
      threadPrompt: '',
      threadId: 't1',
      runProjection: ThreadRunProjectionSnapshot(
        threadId: 't1',
        status: 'running',
        generatedAt: '2026-01-01T00:00:00.000Z',
        sourceEventCount: 2,
        agents: const [],
        timeline: [
          ThreadRunProjectionTimelineItem(
            id: 'approval-1',
            sequence: 1,
            eventType: 'bash_approval.requested',
            scope: 'main',
            text: '等待确认 Bash：npm test',
            at: '2026-01-01T00:00:00.000Z',
            metadata: const {
              'bashApproval': {
                'toolUseId': 'toolu_bash_1',
                'toolName': 'Bash',
                'detail': 'npm test',
                'description': 'Run unit tests',
                'phase': 'approved',
              },
            },
          ),
          ThreadRunProjectionTimelineItem(
            id: 'tool-1',
            sequence: 2,
            eventType: 'tool.started',
            scope: 'main',
            role: 'tool',
            agentId: 'agent_coder_1',
            text: 'Tool: Bash · npm test',
            at: '2026-01-01T00:00:01.000Z',
            metadata: const {
              'tool': {
                'name': 'Bash',
                'detail': 'npm test',
                'toolUseId': 'toolu_bash_1',
                'description': 'Run unit tests',
                'status': 'running',
              },
            },
          ),
        ],
      ),
    );

    final actions = _toolActions(feed);
    expect(actions.length, 1);
    expect(actions.first.text, 'Run unit tests');
    expect(actions.first.toolUseId, 'toolu_bash_1');
    expect(actions.first.bashRun?.title, 'Run unit tests');
  });

  test(
    'buildActivityFeed merges bash approval lifecycle into one completed card',
    () {
      final feed = buildActivityFeed(
        threadPrompt: '',
        threadId: 't1',
        runProjection: ThreadRunProjectionSnapshot(
          threadId: 't1',
          status: 'running',
          generatedAt: '2026-01-01T00:00:00.000Z',
          sourceEventCount: 3,
          agents: const [],
          timeline: [
            ThreadRunProjectionTimelineItem(
              id: 'approval-wait',
              sequence: 1,
              eventType: 'message.final',
              scope: 'main',
              role: 'tool',
              text: '等待确认 Bash：npm test',
              at: '2026-01-01T00:00:00.000Z',
              metadata: const {
                'liveType': 'bash_approval.requested',
                'bashApproval': {
                  'toolUseId': 'toolu_bash_1',
                  'toolName': 'Bash',
                  'detail': 'npm test',
                  'description': 'Run unit tests',
                  'phase': 'requested',
                },
              },
            ),
            ThreadRunProjectionTimelineItem(
              id: 'approval-approved',
              sequence: 2,
              eventType: 'message.final',
              scope: 'main',
              role: 'tool',
              text: '已允许本次 Bash：npm test',
              at: '2026-01-01T00:00:00.500Z',
              metadata: const {
                'liveType': 'bash_approval.approved',
                'bashApproval': {
                  'toolUseId': 'toolu_bash_1',
                  'toolName': 'Bash',
                  'detail': 'npm test',
                  'description': 'Run unit tests',
                  'phase': 'approved',
                },
              },
            ),
            ThreadRunProjectionTimelineItem(
              id: 'bash-completed',
              sequence: 3,
              eventType: 'tool.completed',
              scope: 'main',
              role: 'tool',
              text: 'Tool: Bash · npm test',
              at: '2026-01-01T00:00:01.000Z',
              metadata: const {
                'liveType': 'tool.completed',
                'tool': {
                  'name': 'Bash',
                  'detail': 'npm test',
                  'toolUseId': 'toolu_bash_1',
                  'description': 'Run unit tests',
                  'status': 'completed',
                  'outputPreview': '36 pass',
                },
              },
            ),
          ],
        ),
      );

      final actions = _toolActions(feed);
      expect(actions.length, 1);
      expect(actions.first.toolUseId, 'toolu_bash_1');
      expect(actions.first.text, 'Run unit tests');
      expect(actions.first.lifecycle, ToolActionLifecycle.completed);
      expect(actions.first.bashRun?.command, 'npm test');
      expect(actions.first.bashRun?.output, '36 pass');
      expect(
        feed.any(
          (entry) =>
              entry.kind == ActivityFeedKind.assistant &&
              (entry.text.contains('等待确认') || entry.text.contains('已允许本次')),
        ),
        isFalse,
      );
    },
  );

  test(
    'buildActivityFeed keeps bash approval out of assistant body after approval',
    () {
      final feed = buildActivityFeed(
        threadPrompt: '',
        threadId: 't1',
        runProjection: ThreadRunProjectionSnapshot(
          threadId: 't1',
          status: 'running',
          generatedAt: '2026-01-01T00:00:00.000Z',
          sourceEventCount: 2,
          agents: const [],
          timeline: [
            ThreadRunProjectionTimelineItem(
              id: 'approval-approved',
              sequence: 1,
              eventType: 'message.final',
              scope: 'main',
              role: 'tool',
              text: '已允许本次 Bash：npm test',
              at: '2026-01-01T00:00:00.000Z',
              metadata: const {
                'liveType': 'bash_approval.approved',
                'bashApproval': {
                  'toolUseId': 'toolu_bash_1',
                  'toolName': 'Bash',
                  'detail': 'npm test',
                  'description': 'Run unit tests',
                  'phase': 'approved',
                },
              },
            ),
            ThreadRunProjectionTimelineItem(
              id: 'planner-note',
              sequence: 2,
              eventType: 'message.final',
              scope: 'main',
              role: 'planner',
              text: '正在执行测试命令。',
              at: '2026-01-01T00:00:00.500Z',
            ),
          ],
        ),
      );

      final actions = _toolActions(feed);
      expect(actions.length, 1);
      expect(actions.first.lifecycle, ToolActionLifecycle.approvalApproved);
      expect(
        feed.any(
          (entry) =>
              entry.kind == ActivityFeedKind.assistant &&
              entry.text.contains('已允许本次'),
        ),
        isFalse,
      );
    },
  );

  testWidgets(
    'ActivityFeedList expands Bash title before showing command and output',
    (tester) async {
      final scrollController = ScrollController();
      addTearDown(scrollController.dispose);

      await tester.pumpWidget(
        _localizedMaterialApp(
          theme: buildEcoDarkTheme(),
          home: Scaffold(
            body: ActivityFeedList(
              entries: const [
                ActivityFeedEntry(
                  id: 'bash-1',
                  kind: ActivityFeedKind.action,
                  text: 'Run unit tests',
                  actionIcon: ActivityActionIcon.terminal,
                  lifecycle: ToolActionLifecycle.completed,
                  toolUseId: 'toolu_bash_1',
                  bashRun: BashRunCardDisplay(
                    title: 'Run unit tests',
                    meta: 'npm, 1.2s',
                    command: 'npm test',
                    output: '36 pass',
                  ),
                ),
              ],
              scrollController: scrollController,
              loadToolDetail: (_) async => const [],
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('运行了 npm test'), findsOneWidget);
      expect(find.text('36 pass'), findsNothing);
      expect(find.text('npm test'), findsNothing);

      await tester.tap(find.text('运行了 npm test'));
      await tester.pumpAndSettle();

      expect(find.text('36 pass'), findsOneWidget);
      expect(find.text('npm test'), findsOneWidget);
    },
  );

  testWidgets(
    'ActivityFeedList loads a missing Bash output preview when expanded',
    (tester) async {
      final scrollController = ScrollController();
      addTearDown(scrollController.dispose);

      await tester.pumpWidget(
        _localizedMaterialApp(
          theme: buildEcoDarkTheme(),
          home: Scaffold(
            body: ActivityFeedList(
              entries: const [
                ActivityFeedEntry(
                  id: 'bash-lazy-output',
                  kind: ActivityFeedKind.action,
                  text: 'Search source',
                  actionIcon: ActivityActionIcon.search,
                  lifecycle: ToolActionLifecycle.completed,
                  toolUseId: 'toolu_search_1',
                  bashRun: BashRunCardDisplay(
                    title: 'Search source',
                    command: 'rg -n needle lib',
                  ),
                ),
              ],
              scrollController: scrollController,
              loadToolDetail: (_) async => const [
                ActivityFeedEntry(
                  id: 'bash-lazy-output-detail',
                  kind: ActivityFeedKind.action,
                  bashRun: BashRunCardDisplay(
                    title: 'Search source',
                    command: 'rg -n needle lib',
                    output: 'lib/main.dart:12: needle',
                  ),
                  text: 'Search source',
                ),
              ],
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('lib/main.dart:12: needle'), findsNothing);
      await tester.tap(find.text('运行了 rg -n needle lib'));
      await tester.pumpAndSettle();

      expect(find.text('lib/main.dart:12: needle'), findsOneWidget);
    },
  );

  test('buildActivityFeed categorizes projected Bash reads and searches', () {
    final feed = buildActivityFeed(
      threadPrompt: '',
      threadId: 't1',
      runProjection: ThreadRunProjectionSnapshot(
        threadId: 't1',
        status: 'completed',
        generatedAt: '2026-01-01T00:00:00.000Z',
        sourceEventCount: 2,
        agents: const [],
        timeline: [
          ThreadRunProjectionTimelineItem(
            id: 'read-command',
            sequence: 1,
            eventType: 'tool.completed',
            scope: 'main',
            text: 'Tool: Bash · sed -n 1,20p lib/main.dart',
            at: '2026-01-01T00:00:00.000Z',
            metadata: const {
              'tool': {
                'name': 'Bash',
                'detail': 'sed -n 1,20p lib/main.dart',
                'toolUseId': 'toolu_read_1',
                'status': 'completed',
                'readTarget': {'filePath': 'lib/main.dart'},
              },
            },
          ),
          ThreadRunProjectionTimelineItem(
            id: 'search-command',
            sequence: 2,
            eventType: 'tool.completed',
            scope: 'main',
            text: 'Tool: Bash · rg -n needle lib',
            at: '2026-01-01T00:00:01.000Z',
            metadata: const {
              'tool': {
                'name': 'Bash',
                'detail': 'rg -n needle lib',
                'toolUseId': 'toolu_search_1',
                'status': 'completed',
                'grepTarget': {'pattern': 'needle', 'path': 'lib'},
              },
            },
          ),
        ],
      ),
    );

    final actions = _toolActions(feed);
    expect(actions.map((entry) => entry.actionIcon), [
      ActivityActionIcon.read,
      ActivityActionIcon.search,
    ]);
  });

  testWidgets('grouped fileChange child rows keep formatActionLine labels', (
    tester,
  ) async {
    final scrollController = ScrollController();
    addTearDown(scrollController.dispose);
    final entries = groupActivityFeedActionEntries(const [
      ActivityFeedEntry(
        id: 'edit-1',
        kind: ActivityFeedKind.action,
        text: 'lib/feed.dart',
        toolName: 'Edit',
        actionIcon: ActivityActionIcon.edit,
        lifecycle: ToolActionLifecycle.completed,
        fileChange: FileChangeCardDisplay(
          fileName: 'feed.dart',
          path: 'lib/feed.dart',
          additions: 1,
          deletions: 0,
          previewLines: [
            FileChangePreviewLine(
              kind: FileChangePreviewLineKind.add,
              text: 'new value',
            ),
          ],
        ),
      ),
      ActivityFeedEntry(
        id: 'edit-2',
        kind: ActivityFeedKind.action,
        text: 'lib/other.dart',
        toolName: 'Edit',
        actionIcon: ActivityActionIcon.edit,
        lifecycle: ToolActionLifecycle.completed,
        fileChange: FileChangeCardDisplay(
          fileName: 'other.dart',
          path: 'lib/other.dart',
          additions: 1,
          deletions: 0,
          previewLines: [
            FileChangePreviewLine(
              kind: FileChangePreviewLineKind.add,
              text: 'other value',
            ),
          ],
        ),
      ),
    ]);

    await tester.pumpWidget(
      _localizedMaterialApp(
        theme: buildEcoDarkTheme(),
        home: Scaffold(
          body: ActivityFeedList(
            entries: entries,
            scrollController: scrollController,
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.textContaining('已编辑').first);
    await tester.pumpAndSettle();

    expect(find.text('编辑了 feed.dart'), findsOneWidget);
    expect(find.text('feed.dart'), findsNothing);
  });

  testWidgets('ActivityFeedList expands file changes inline', (tester) async {
    final scrollController = ScrollController();
    addTearDown(scrollController.dispose);
    var detailLoadCount = 0;

    await tester.pumpWidget(
      _localizedMaterialApp(
        theme: buildEcoDarkTheme(),
        home: Scaffold(
          body: ActivityFeedList(
            entries: const [
              ActivityFeedEntry(
                id: 'edit-1',
                kind: ActivityFeedKind.action,
                text: 'Edit lib/feed.dart',
                actionIcon: ActivityActionIcon.edit,
                lifecycle: ToolActionLifecycle.completed,
                toolUseId: 'toolu_edit_1',
                fileChange: FileChangeCardDisplay(
                  fileName: 'feed.dart',
                  path: 'lib/feed.dart',
                  additions: 1,
                  deletions: 1,
                  previewLines: [
                    FileChangePreviewLine(
                      kind: FileChangePreviewLineKind.remove,
                      text: 'old value',
                    ),
                    FileChangePreviewLine(
                      kind: FileChangePreviewLineKind.add,
                      text: 'new value',
                    ),
                  ],
                ),
              ),
            ],
            scrollController: scrollController,
            loadToolDetail: (_) async {
              detailLoadCount += 1;
              return const [];
            },
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('Edit lib/feed.dart'), findsOneWidget);
    expect(find.text('old value'), findsNothing);
    expect(find.text('new value'), findsNothing);

    await tester.tap(find.text('Edit lib/feed.dart'));
    await tester.pumpAndSettle();

    expect(find.text('old value'), findsOneWidget);
    expect(find.text('new value'), findsOneWidget);
    expect(detailLoadCount, 0);
  });

  testWidgets(
    'tool disclosure arrow is hidden until expanded and sits before diff stats',
    (tester) async {
      final scrollController = ScrollController();
      addTearDown(scrollController.dispose);

      await tester.pumpWidget(
        _localizedMaterialApp(
          theme: buildEcoDarkTheme(),
          home: Scaffold(
            body: ActivityFeedList(
              entries: const [
                ActivityFeedEntry(
                  id: 'edit-arrow',
                  kind: ActivityFeedKind.action,
                  text: 'Edit lib/feed.dart',
                  actionIcon: ActivityActionIcon.edit,
                  fileChange: FileChangeCardDisplay(
                    fileName: 'feed.dart',
                    path: 'lib/feed.dart',
                    additions: 3,
                    deletions: 1,
                    previewLines: [
                      FileChangePreviewLine(
                        kind: FileChangePreviewLineKind.remove,
                        text: 'old value',
                      ),
                    ],
                  ),
                ),
              ],
              scrollController: scrollController,
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.byIcon(EcoIcons.expandDown), findsNothing);
      expect(find.byIcon(EcoIcons.expandUp), findsNothing);

      // Expand via the action row label (collapsed title only).
      await tester.tap(find.text('Edit lib/feed.dart'));
      await tester.pumpAndSettle();

      final arrowRect = tester.getRect(find.byIcon(EcoIcons.expandUp));
      final additionsRect = tester.getRect(find.text('+3'));
      // Expanded row: title … chevron … +stats (chevron sits left of stats).
      expect(arrowRect.right, lessThan(additionsRect.left));
      expect(arrowRect.center.dy, closeTo(additionsRect.center.dy, 8));
    },
  );

  testWidgets('non-expandable tools do not show a disclosure arrow', (
    tester,
  ) async {
    final scrollController = ScrollController();
    addTearDown(scrollController.dispose);

    await tester.pumpWidget(
      _localizedMaterialApp(
        theme: buildEcoDarkTheme(),
        home: Scaffold(
          body: ActivityFeedList(
            entries: const [
              ActivityFeedEntry(
                id: 'read-no-arrow',
                kind: ActivityFeedKind.action,
                text: 'Read lib/feed.dart',
                actionIcon: ActivityActionIcon.read,
              ),
            ],
            scrollController: scrollController,
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.byIcon(EcoIcons.expandDown), findsNothing);
  });

  testWidgets('ActivityFeedList loads generic tool details inline', (
    tester,
  ) async {
    final scrollController = ScrollController();
    addTearDown(scrollController.dispose);
    var detailLoadCount = 0;

    await tester.pumpWidget(
      _localizedMaterialApp(
        theme: buildEcoDarkTheme(),
        home: Scaffold(
          body: ActivityFeedList(
            entries: const [
              ActivityFeedEntry(
                id: 'read-1',
                kind: ActivityFeedKind.action,
                text: 'Read lib/feed.dart',
                actionIcon: ActivityActionIcon.read,
                lifecycle: ToolActionLifecycle.completed,
                toolUseId: 'toolu_read_1',
              ),
            ],
            scrollController: scrollController,
            loadToolDetail: (_) async {
              detailLoadCount += 1;
              return const [
                ActivityFeedEntry(
                  id: 'read-detail',
                  kind: ActivityFeedKind.assistant,
                  text: 'inline tool detail',
                ),
              ];
            },
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('inline tool detail'), findsNothing);
    await tester.tap(find.text('Read lib/feed.dart'));
    await tester.pumpAndSettle();

    expect(find.text('inline tool detail'), findsOneWidget);
    expect(detailLoadCount, 1);

    await tester.tap(find.text('Read lib/feed.dart'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Read lib/feed.dart'));
    await tester.pumpAndSettle();
    expect(detailLoadCount, 1);
  });

  testWidgets('inline tool details do not re-nest the same action group chrome', (
    tester,
  ) async {
    final scrollController = ScrollController();
    addTearDown(scrollController.dispose);
    const error =
        'Non-read-only bash is blocked. Use read or an allowlisted read-only command.';
    final grouped = groupActivityFeedActionEntries(const [
      ActivityFeedEntry(
        id: 'blocked-bash',
        kind: ActivityFeedKind.action,
        text: error,
        actionIcon: ActivityActionIcon.file,
        lifecycle: ToolActionLifecycle.failed,
        toolUseId: 'toolu_blocked_1',
      ),
    ]);

    await tester.pumpWidget(
      _localizedMaterialApp(
        theme: buildEcoDarkTheme(),
        home: Scaffold(
          body: ActivityFeedList(
            entries: grouped,
            scrollController: scrollController,
            loadToolDetail: (_) async => grouped,
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.textContaining('读取了').first);
    await tester.pumpAndSettle();
    await tester.tap(find.textContaining('读取了').last);
    await tester.pumpAndSettle();

    expect(find.textContaining('读取了'), findsNWidgets(2));
    expect(find.textContaining('Use read or an allowlisted'), findsWidgets);
  });

  testWidgets('V2 tool details request continuation only after loading more', (
    tester,
  ) async {
    final scrollController = ScrollController();
    addTearDown(scrollController.dispose);
    var loadCount = 0;
    String? requestedCursor;

    await tester.pumpWidget(
      _localizedMaterialApp(
        theme: buildEcoDarkTheme(),
        home: Scaffold(
          body: ActivityFeedList(
            entries: const [
              ActivityFeedEntry(
                id: 'v2-tool-detail-loader',
                kind: ActivityFeedKind.action,
                text: 'Read source',
                actionIcon: ActivityActionIcon.read,
                lifecycle: ToolActionLifecycle.completed,
                toolUseId: 'tool_v2_1',
                runAttemptId: 'run_v2_1',
              ),
            ],
            scrollController: scrollController,
            loadToolDetailPage: (_, {String? cursor}) async {
              loadCount += 1;
              requestedCursor = cursor;
              if (cursor == null) {
                return const ActivityFeedToolDetailPage(
                  entries: [
                    ActivityFeedEntry(
                      id: 'v2-detail-page-1',
                      kind: ActivityFeedKind.assistant,
                      text: 'first detail page',
                    ),
                  ],
                  hasMore: true,
                  nextCursor: 'cursor-page-2',
                );
              }
              return const ActivityFeedToolDetailPage(
                entries: [
                  ActivityFeedEntry(
                    id: 'v2-detail-page-2',
                    kind: ActivityFeedKind.assistant,
                    text: 'second detail page',
                  ),
                ],
                hasMore: false,
              );
            },
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(loadCount, 0);
    await tester.tap(find.textContaining('Read source').first);
    await tester.pumpAndSettle();

    expect(loadCount, 1);
    expect(requestedCursor, isNull);
    expect(find.text('first detail page'), findsOneWidget);
    expect(find.text('second detail page'), findsNothing);
    expect(find.text('加载更多详情'), findsOneWidget);

    await tester.tap(find.text('加载更多详情'));
    await tester.pumpAndSettle();

    expect(loadCount, 2);
    expect(requestedCursor, 'cursor-page-2');
    expect(find.text('first detail page'), findsOneWidget);
    expect(find.text('second detail page'), findsOneWidget);
    expect(find.text('加载更多详情'), findsNothing);
  });

  testWidgets(
    'ActivityFeedList keeps a single Bash tool group child disclosure',
    (tester) async {
      final scrollController = ScrollController();
      addTearDown(scrollController.dispose);
      final entries = groupActivityFeedActionEntries(const [
        ActivityFeedEntry(
          id: 'single-bash-group',
          kind: ActivityFeedKind.action,
          text: 'Run unit tests',
          toolName: 'Bash',
          actionIcon: ActivityActionIcon.terminal,
          lifecycle: ToolActionLifecycle.completed,
          bashRun: BashRunCardDisplay(
            title: 'Run unit tests',
            meta: 'npm, 1.2s',
            command: 'npm test',
            output: '36 pass',
          ),
        ),
      ]);

      await tester.pumpWidget(
        _localizedMaterialApp(
          theme: buildEcoDarkTheme(),
          home: Scaffold(
            body: ActivityFeedList(
              entries: entries,
              scrollController: scrollController,
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('运行了命令'), findsOneWidget);
      expect(find.text('Run unit tests'), findsNothing);
      expect(find.text('npm test'), findsNothing);

      await tester.tap(find.text('运行了命令'));
      await tester.pumpAndSettle();

      expect(find.text('运行了命令'), findsOneWidget);
      expect(find.text('运行了 npm test'), findsOneWidget);
      expect(find.text('npm test'), findsNothing);
      expect(find.text('36 pass'), findsNothing);

      await tester.tap(find.text('运行了 npm test'));
      await tester.pumpAndSettle();

      expect(find.text('npm test'), findsOneWidget);
      expect(find.text('36 pass'), findsOneWidget);
    },
  );

  testWidgets('ActivityFeedList shows failed Bash as ran with a subtle dot', (
    tester,
  ) async {
    final scrollController = ScrollController();
    addTearDown(scrollController.dispose);
    final entries = groupActivityFeedActionEntries(const [
      ActivityFeedEntry(
        id: 'failed-bash-group',
        kind: ActivityFeedKind.action,
        text: 'Run unit tests',
        toolName: 'Bash',
        actionIcon: ActivityActionIcon.terminal,
        lifecycle: ToolActionLifecycle.failed,
        bashRun: BashRunCardDisplay(
          title: 'Run unit tests',
          meta: 'npm, 1.2s',
          command: 'npm test',
          output: '1 test failed',
        ),
      ),
    ]);

    expect(entries.single.text, '运行了命令');

    await tester.pumpWidget(
      _localizedMaterialApp(
        theme: buildEcoDarkTheme(),
        home: Scaffold(
          body: ActivityFeedList(
            entries: entries,
            scrollController: scrollController,
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('运行了命令'), findsOneWidget);
    expect(find.textContaining('工具未完成'), findsNothing);
    expect(find.textContaining('运行失败'), findsNothing);
    // Aggregated group title omits the failure dot.
    expect(
      find.byKey(const ValueKey('activity-tool-failure-dot')),
      findsNothing,
    );
    expect(find.text('npm test'), findsNothing);

    await tester.tap(find.text('运行了命令'));
    await tester.pumpAndSettle();

    expect(find.text('运行了命令'), findsOneWidget);
    expect(find.text('运行了 npm test'), findsOneWidget);
    expect(find.text('npm test'), findsNothing);
    expect(find.text('1 test failed'), findsNothing);
    // The failed child keeps its subtle status dot on the child row.
    expect(
      find.byKey(const ValueKey('activity-tool-failure-dot')),
      findsOneWidget,
    );

    await tester.tap(find.text('运行了 npm test'));
    await tester.pumpAndSettle();

    expect(find.text('npm test'), findsOneWidget);
    expect(find.text('1 test failed'), findsOneWidget);
  });

  test('action group summarizes every tool call even when one failed', () {
    final entries = groupActivityFeedActionEntries(const [
      ActivityFeedEntry(
        id: 'bash-ok',
        kind: ActivityFeedKind.action,
        text: 'Run unit tests',
        toolName: 'Bash',
        actionIcon: ActivityActionIcon.terminal,
        lifecycle: ToolActionLifecycle.completed,
        bashRun: BashRunCardDisplay(
          title: 'Run unit tests',
          meta: 'npm, 1.2s',
          command: 'npm test',
          output: '36 pass',
        ),
      ),
      ActivityFeedEntry(
        id: 'bash-failed',
        kind: ActivityFeedKind.action,
        text: 'Run lint',
        toolName: 'Bash',
        actionIcon: ActivityActionIcon.terminal,
        lifecycle: ToolActionLifecycle.failed,
        bashRun: BashRunCardDisplay(
          title: 'Run lint',
          meta: 'npm, 1.2s',
          command: 'npm run lint',
          output: '1 error',
        ),
      ),
    ]);

    // The group title aggregates what ran instead of echoing one failed child.
    expect(entries.single.text, '已运行 2 条命令');
    expect(entries.single.actionChildren.length, 2);
  });

  test('Bash title uses description or Shell without command fallback', () {
    expect(
      resolveBashRunCardDisplay(toolName: 'Bash', command: 'npm test')?.title,
      'Shell',
    );
    expect(
      resolveBashRunCardDisplay(
        toolName: 'Bash',
        command: 'npm test',
        description: 'Run unit tests',
      )?.title,
      'Run unit tests',
    );
  });

  test('Bash metadata hides zero duration and keeps real duration', () {
    expect(formatBashRunMeta('npm test', durationMs: 0), 'npm');
    expect(formatBashRunMeta('npm test', durationMs: 1250), 'npm, 1.3s');
  });

  test('subagent mission card gets duration and timeline from projection', () {
    final feed = buildActivityFeed(
      threadPrompt: '实现登录',
      threadId: 't1',
      runProjection: ThreadRunProjectionSnapshot.fromJson({
        'thread': {
          'threadId': 't1',
          'status': 'running',
          'generatedAt': '2026-01-01T00:00:00.000Z',
        },
        'sourceEventCount': 2,
        'agents': [
          {
            'agentId': 'agent_coder_1',
            'role': 'coder',
            'kind': 'subagent',
            'status': 'active',
            'startedAt': '2026-01-01T00:00:00.000Z',
            'durationMs': 4200,
            'delegationPrompt': 'add login',
            'delegationSummary': '实现登录',
            'timeline': [
              {
                'id': 'tl1',
                'sequence': 1,
                'eventType': 'tool.started',
                'scope': 'agent',
                'text': 'Reading src/auth.ts',
                'at': '2026-01-01T00:00:01.000Z',
                'role': 'coder',
                'agentId': 'agent_coder_1',
                'metadata': {
                  'tool': {
                    'name': 'Read',
                    'detail': 'src/auth.ts',
                    'toolUseId': 'toolu_read_1',
                  },
                },
              },
            ],
          },
        ],
      }),
      subagentSessions: const [
        ThreadSubagentSessionTiming(
          agentId: 'agent_coder_1',
          role: 'coder',
          status: 'active',
          startedAt: '2026-01-01T00:00:00.000Z',
          lastActiveAt: '2026-01-01T00:00:04.000Z',
          accumulatedMs: 4200,
          durationMs: 4200,
        ),
      ],
    );

    final missions = feed
        .where((entry) => entry.kind == ActivityFeedKind.subagentMission)
        .toList();
    expect(missions.length, 1);
    final card = missions.first;
    expect(card.kind, ActivityFeedKind.subagentMission);
    expect(card.agentId, 'agent_coder_1');
    expect(card.text, '实现登录');
    expect(card.running, isTrue);
    expect(card.durationMs, greaterThan(0));
    expect(card.timeline.length, 1);
    expect(feed.any((entry) => entry.kind == ActivityFeedKind.action), isFalse);
  });

  test(
    'isSubagentMissionEnvelope matches legacy and structured mission lines',
    () {
      expect(isSubagentMissionEnvelope('@mission explore: scan src'), isTrue);
      expect(
        isSubagentMissionEnvelope(
          '@mission {"role":"explore","summary":"scan","prompt":"scan src"}',
        ),
        isTrue,
      );
      expect(isSubagentMissionEnvelope('Plain task prompt'), isFalse);
    },
  );

  test('buildActivityFeed keeps subagent content inside its mission card', () {
    const missionText =
        '@mission {"role":"explore","summary":"Gather CPU info","prompt":"Gather CPU info","agentId":"agent_explore_a"}';
    final feed = buildActivityFeed(
      runProjection: ThreadRunProjectionSnapshot.fromJson({
        'thread': {
          'threadId': 't1',
          'status': 'running',
          'generatedAt': '2026-01-01T00:00:00.000Z',
        },
        'sourceEventCount': 2,
        'agents': [
          {
            'agentId': 'agent_explore_a',
            'role': 'explore',
            'kind': 'subagent',
            'status': 'active',
            'startedAt': '2026-01-01T00:00:01.000Z',
            'durationMs': 1000,
            'delegationPrompt': 'Gather CPU info',
            'delegationSummary': 'Gather CPU info',
            'timeline': [
              {
                'id': 'mission-echo',
                'sequence': 2,
                'eventType': 'message.final',
                'scope': 'agent',
                'text': missionText,
                'at': '2026-01-01T00:00:01.100Z',
                'role': 'explore',
                'agentId': 'agent_explore_a',
              },
              {
                'id': 'agent-speech',
                'sequence': 3,
                'eventType': 'message.final',
                'scope': 'agent',
                'text': 'Checking CPU topology.',
                'at': '2026-01-01T00:00:02.000Z',
                'role': 'explore',
                'agentId': 'agent_explore_a',
              },
            ],
          },
        ],
      }),
    );

    expect(
      feed
          .where((entry) => entry.kind == ActivityFeedKind.subagentMission)
          .length,
      1,
    );
    expect(feed.any((entry) => entry.text.contains('@mission')), isFalse);
    expect(
      feed.any(
        (entry) =>
            entry.kind == ActivityFeedKind.assistant &&
            entry.text == 'Checking CPU topology.',
      ),
      isFalse,
    );
    final mission = feed.singleWhere(
      (entry) => entry.kind == ActivityFeedKind.subagentMission,
    );
    expect(
      mission.timeline.any((item) => item.label == 'Checking CPU topology.'),
      isTrue,
    );
  });

  test('buildActivityFeed renders bash action cards from history text', () {
    final feed = buildActivityFeed(
      runProjection: ThreadRunProjectionSnapshot(
        threadId: 't1',
        status: 'running',
        generatedAt: '2026-01-01T00:00:00.000Z',
        sourceEventCount: 1,
        agents: [
          ThreadRunProjectionAgent(
            agentId: 'agent_planner',
            role: 'planner',
            kind: 'main',
            status: 'active',
            startedAt: '2026-01-01T00:00:00.000Z',
            durationMs: 1000,
            timeline: [
              ThreadRunProjectionTimelineItem(
                id: 'bash-done',
                sequence: 1,
                eventType: 'tool.completed',
                scope: 'main',
                text: 'Tool: Bash · npm test',
                at: '2026-01-01T00:00:01.000Z',
                metadata: const {
                  'tool': {
                    'name': 'Bash',
                    'detail': 'npm test',
                    'toolUseId': 'toolu_bash_1',
                    'description': 'Run unit tests',
                  },
                },
              ),
            ],
          ),
        ],
      ),
    );

    final actions = _toolActions(feed);
    expect(actions.length, 1);
    expect(actions.first.text, 'Run unit tests');
    expect(actions.first.toolUseId, 'toolu_bash_1');
    expect(actions.first.bashRun?.title, 'Run unit tests');
  });

  test(
    'buildActivityFeed injects cards for concurrent projection subagents',
    () {
      final feed = buildActivityFeed(
        threadPrompt: '并发子代理',
        threadId: 't1',
        runProjection: ThreadRunProjectionSnapshot(
          threadId: 't1',
          status: 'running',
          generatedAt: '2026-01-01T00:00:00.000Z',
          sourceEventCount: 3,
          timeline: [
            ThreadRunProjectionTimelineItem(
              id: 'user-1',
              sequence: 0,
              eventType: 'thread.status',
              scope: 'main',
              role: 'user',
              text: '并发子代理',
              at: '2026-01-01T00:00:00.000Z',
              metadata: const {'liveType': 'thread.user_prompt'},
            ),
            ThreadRunProjectionTimelineItem(
              id: 'planner-1',
              sequence: 1,
              eventType: 'message.final',
              scope: 'main',
              role: 'planner',
              text: '主代理先说明计划。',
              at: '2026-01-01T00:00:02.000Z',
            ),
          ],
          agents: [
            ThreadRunProjectionAgent(
              agentId: 'agent_explore_1',
              role: 'explore',
              kind: 'subagent',
              status: 'active',
              startedAt: '2026-01-01T00:00:00.500Z',
              durationMs: 1000,
              timeline: const [],
              delegationSummary: '梳理模块 A',
            ),
            ThreadRunProjectionAgent(
              agentId: 'agent_coder_1',
              role: 'coder',
              kind: 'subagent',
              status: 'active',
              startedAt: '2026-01-01T00:00:01.000Z',
              durationMs: 2000,
              timeline: const [],
              delegationSummary: '实现功能 B',
            ),
          ],
        ),
      );

      final missions = feed
          .where((entry) => entry.kind == ActivityFeedKind.subagentMission)
          .toList();
      expect(missions.length, 2);
      expect(missions.map((entry) => entry.agentId).toSet(), {
        'agent_explore_1',
        'agent_coder_1',
      });
      final exploreIndex = feed.indexWhere(
        (entry) => entry.agentId == 'agent_explore_1',
      );
      final plannerIndex = feed.indexWhere(
        (entry) => entry.kind == ActivityFeedKind.assistant,
      );
      expect(exploreIndex, lessThan(plannerIndex));
    },
  );

  test('buildActivityFeed preserves user prompt image previews', () {
    final feed = buildActivityFeed(
      threadPrompt: '分析图片',
      threadId: 't-image',
      runProjection: ThreadRunProjectionSnapshot(
        threadId: 't-image',
        status: 'running',
        generatedAt: '2026-01-01T00:00:00.000Z',
        sourceEventCount: 1,
        timeline: [
          ThreadRunProjectionTimelineItem(
            id: 'user-image',
            sequence: 1,
            eventType: 'thread.status',
            scope: 'main',
            role: 'user',
            text: '分析图片',
            at: '2026-01-01T00:00:00.000Z',
            metadata: const {
              'liveType': 'thread.user_prompt',
              'promptImagePreviews': [
                {'id': 'preview-1', 'mediaType': 'image/jpeg', 'data': 'YWJj'},
              ],
            },
          ),
        ],
        agents: const [],
      ),
    );

    final user = feed.firstWhere(
      (entry) => entry.kind == ActivityFeedKind.user,
    );
    expect(user.attachments, hasLength(1));
    expect(user.attachments.single.mediaType, 'image/jpeg');
  });

  test('buildActivityFeed adds prompt images to the vision subagent card', () {
    final feed = buildActivityFeed(
      threadPrompt: '分析图片',
      threadId: 't-image',
      runProjection: ThreadRunProjectionSnapshot(
        threadId: 't-image',
        status: 'running',
        generatedAt: '2026-01-01T00:00:00.000Z',
        sourceEventCount: 1,
        timeline: [
          ThreadRunProjectionTimelineItem(
            id: 'user-image',
            sequence: 1,
            eventType: 'thread.status',
            scope: 'main',
            role: 'user',
            text: '分析图片',
            at: '2026-01-01T00:00:00.000Z',
            metadata: const {
              'liveType': 'thread.user_prompt',
              'promptImagePreviews': [
                {'id': 'preview-1', 'mediaType': 'image/jpeg', 'data': 'YWJj'},
              ],
            },
          ),
        ],
        agents: const [
          ThreadRunProjectionAgent(
            agentId: 'vision-1',
            role: 'vision',
            kind: 'subagent',
            status: 'active',
            startedAt: '2026-01-01T00:00:01.000Z',
            durationMs: 0,
            timeline: [],
          ),
        ],
      ),
    );

    final vision = feed.firstWhere(
      (entry) => entry.kind == ActivityFeedKind.subagentMission,
    );
    expect(vision.subagentRole, 'vision');
    expect(vision.attachments, hasLength(1));
    expect(vision.attachments.single.mediaType, 'image/jpeg');
  });

  testWidgets('subagent mission cards hide internal agent ids', (tester) async {
    final scrollController = ScrollController();
    addTearDown(scrollController.dispose);

    await tester.pumpWidget(
      _localizedMaterialApp(
        theme: buildEcoDarkTheme(),
        home: Scaffold(
          body: ActivityFeedList(
            entries: const [
              ActivityFeedEntry(
                id: 'vision-card',
                kind: ActivityFeedKind.subagentMission,
                text: '分析附图',
                subagentRole: 'vision',
                agentId: 'vision:thread:internal-id',
                attachments: [
                  PromptImageAttachment(
                    mediaType: 'image/png',
                    data:
                        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAF/gL+6U9yAAAAAElFTkSuQmCC',
                  ),
                ],
              ),
            ],
            scrollController: scrollController,
          ),
        ),
      ),
    );

    expect(find.textContaining('#'), findsNothing);
    expect(find.text('查看 1 张图片'), findsOneWidget);
    expect(find.byType(Image), findsNothing);

    await tester.tap(find.text('查看 1 张图片'));
    await tester.pumpAndSettle();

    expect(find.byType(Image), findsOneWidget);
  });

  test(
    'buildActivityFeed keeps subagent mission before later assistant text',
    () {
      final feed = buildActivityFeed(
        threadPrompt: '修复登录',
        threadId: 't1',
        runProjection: ThreadRunProjectionSnapshot.fromJson({
          'thread': {
            'threadId': 't1',
            'status': 'running',
            'generatedAt': '2026-01-01T00:00:00.000Z',
          },
          'sourceEventCount': 3,
          'timeline': [
            {
              'id': 'user-1',
              'sequence': 0,
              'eventType': 'thread.status',
              'scope': 'main',
              'role': 'user',
              'text': '修复登录',
              'at': '2026-01-01T00:00:00.000Z',
              'metadata': {'liveType': 'thread.user_prompt'},
            },
            {
              'id': 'planner-1',
              'sequence': 3,
              'eventType': 'message.final',
              'scope': 'main',
              'role': 'planner',
              'text': '子代理完成后我继续总结。',
              'at': '2026-01-01T00:00:06.000Z',
            },
          ],
          'agents': [
            {
              'agentId': 'agent_coder_1',
              'role': 'coder',
              'kind': 'subagent',
              'status': 'stopped',
              'startedAt': '2026-01-01T00:00:01.000Z',
              'endedAt': '2026-01-01T00:00:05.000Z',
              'durationMs': 4000,
              'delegationPrompt': 'add login',
              'delegationSummary': '实现登录',
              'timeline': [],
            },
          ],
        }),
      );

      final missionIndex = feed.indexWhere(
        (entry) => entry.kind == ActivityFeedKind.subagentMission,
      );
      final assistantIndex = feed.indexWhere(
        (entry) => entry.kind == ActivityFeedKind.assistant,
      );
      expect(missionIndex, greaterThanOrEqualTo(0));
      expect(assistantIndex, greaterThan(missionIndex));
      expect(feed[missionIndex].agentId, 'agent_coder_1');
    },
  );

  test('GitWorkingTreeStatus exposes workspace changes summary', () {
    const status = GitWorkingTreeStatus(
      workspacePath: '/tmp/repo',
      isGitRepository: true,
      hasGitCommits: true,
      dirtyFileCount: 3,
      insertions: 12,
      deletions: 4,
      canCommit: true,
      aheadCount: 0,
      behindCount: 0,
      hasUpstream: false,
    );

    expect(status.toChangesSummary().fileCount, 3);
    expect(status.toChangesSummary().totalAdditions, 12);
    expect(status.toChangesSummary().hasChanges, isTrue);
  });

  test('buildActivityFeed still renders truncated projection text', () {
    final feed = buildActivityFeed(
      threadPrompt: '',
      threadId: 't1',
      runProjection: ThreadRunProjectionSnapshot(
        threadId: 't1',
        status: 'idle',
        generatedAt: '2026-01-01T00:00:00.000Z',
        sourceEventCount: 1,
        agents: const [],
        timeline: [
          ThreadRunProjectionTimelineItem(
            id: 'evt_truncated',
            sequence: 1,
            eventType: 'message.final',
            scope: 'main',
            text: 'preview only',
            at: '2026-01-01T00:00:00.000Z',
            metadata: const {'textTruncated': true},
          ),
        ],
      ),
    );

    expect(feed, isNotEmpty);
    expect(feed.first.text, 'preview only');
  });

  test('buildActivityFeed hides model request lifecycle from mobile feed', () {
    final feed = buildActivityFeed(
      threadPrompt: '',
      threadId: 't1',
      runProjection: ThreadRunProjectionSnapshot(
        threadId: 't1',
        status: 'running',
        generatedAt: '2026-01-01T00:00:00.000Z',
        sourceEventCount: 5,
        agents: const [],
        timeline: [
          ThreadRunProjectionTimelineItem(
            id: 'request-done',
            sequence: 1,
            eventType: 'request.completed',
            scope: 'main',
            text: '模型请求完成',
            at: '2026-01-01T00:00:00.000Z',
          ),
          ThreadRunProjectionTimelineItem(
            id: 'request-failed',
            sequence: 2,
            eventType: 'request.failed',
            scope: 'main',
            text: '模型请求失败',
            at: '2026-01-01T00:00:01.000Z',
          ),
          ThreadRunProjectionTimelineItem(
            id: 'request-cancelled',
            sequence: 3,
            eventType: 'request.cancelled',
            scope: 'main',
            text: '模型请求已取消',
            at: '2026-01-01T00:00:02.000Z',
          ),
          ThreadRunProjectionTimelineItem(
            id: 'route-changed',
            sequence: 4,
            eventType: 'thread.status',
            scope: 'main',
            text: '模型路由已变更，将尝试接续原 session；若失败会自动改用对话摘要。',
            at: '2026-01-01T00:00:03.000Z',
          ),
          ThreadRunProjectionTimelineItem(
            id: 'cache-drift',
            sequence: 5,
            eventType: 'context.cache_config_drift',
            scope: 'main',
            text: '模型路由已变更：主模型',
            at: '2026-01-01T00:00:04.000Z',
          ),
        ],
      ),
    );

    expect(feed.any((entry) => entry.text == '模型请求完成'), isFalse);
    expect(feed.any((entry) => entry.text == '模型请求失败'), isFalse);
    expect(feed.any((entry) => entry.text == '模型请求已取消'), isFalse);
    expect(feed.any((entry) => entry.text.contains('模型路由已变更')), isFalse);
  });

  test('buildActivityFeed drops reconnect after agent recovers', () {
    final feed = buildActivityFeed(
      threadPrompt: '',
      threadId: 't1',
      runProjection: ThreadRunProjectionSnapshot(
        threadId: 't1',
        status: 'running',
        generatedAt: '2026-01-01T00:00:00.000Z',
        sourceEventCount: 2,
        agents: const [],
        timeline: [
          ThreadRunProjectionTimelineItem(
            id: 'reconnect-1',
            sequence: 1,
            eventType: 'request.retry_scheduled',
            scope: 'main',
            text: 'API retry 2/5…',
            at: '2026-01-01T00:00:00.000Z',
            metadata: {
              'activityOrigin': 'sdk.api_retry',
              'retry': {'attempt': 2, 'maxRetries': 5},
            },
          ),
          ThreadRunProjectionTimelineItem(
            id: 'reply-1',
            sequence: 2,
            eventType: 'message.final',
            scope: 'main',
            text: '好的，我已经完成分析。',
            at: '2026-01-01T00:00:00.001Z',
          ),
        ],
      ),
    );

    expect(feed.where((entry) => entry.reconnecting), isEmpty);
    expect(feed.any((entry) => entry.text.contains('完成分析')), isTrue);
  });

  test('buildActivityFeed maps reconnect activity to collapsible phase', () {
    final feed = buildActivityFeed(
      threadPrompt: '',
      threadId: 't1',
      runProjection: ThreadRunProjectionSnapshot(
        threadId: 't1',
        status: 'running',
        generatedAt: '2026-01-01T00:00:00.000Z',
        sourceEventCount: 2,
        agents: const [],
        timeline: [
          ThreadRunProjectionTimelineItem(
            id: 'reconnect-1',
            sequence: 1,
            eventType: 'message.final',
            scope: 'main',
            text:
                '【连接失败】HTTP 500：upstream error: do request failed (request id: abc)',
            at: '2026-01-01T00:00:00.000Z',
          ),
          ThreadRunProjectionTimelineItem(
            id: 'reconnect-2',
            sequence: 2,
            eventType: 'request.retry_scheduled',
            scope: 'main',
            text: 'API retry 2/5…',
            at: '2026-01-01T00:00:00.001Z',
            metadata: {
              'activityOrigin': 'sdk.api_retry',
              'retry': {'attempt': 2, 'maxRetries': 5},
            },
          ),
        ],
      ),
    );

    final reconnectEntries = feed
        .where((entry) => entry.reconnecting)
        .toList(growable: false);
    expect(reconnectEntries, hasLength(1));
    expect(reconnectEntries.first.text, '重连 2/5');
    expect(reconnectEntries.first.detail, isNull);
  });

  test(
    'buildActivityFeed treats recorded user prompts as right-aligned user bubbles',
    () {
      final feed = buildActivityFeed(
        threadPrompt: '请继续实现登录页',
        threadId: 't1',
        runProjection: ThreadRunProjectionSnapshot(
          threadId: 't1',
          status: 'running',
          generatedAt: '2026-01-01T00:00:00.000Z',
          sourceEventCount: 1,
          agents: const [],
          timeline: [
            ThreadRunProjectionTimelineItem(
              id: 'prompt',
              sequence: 0,
              eventType: 'thread.status',
              scope: 'main',
              role: 'user',
              text: '请继续实现登录页',
              at: '2026-01-01T00:00:00.000Z',
              metadata: const {'liveType': 'thread.user_prompt'},
            ),
          ],
        ),
      );

      final userEntries = feed
          .where((entry) => entry.kind == ActivityFeedKind.user)
          .toList();
      expect(userEntries, hasLength(1));
      expect(userEntries.first.text, '请继续实现登录页');
      expect(
        feed.any(
          (entry) =>
              entry.kind == ActivityFeedKind.phase && entry.text == '请继续实现登录页',
        ),
        isFalse,
      );
    },
  );

  test('parseClarificationAnswersSummary extracts question answer rows', () {
    final rows = parseClarificationAnswersSummary(
      '澄清回答：是否自动分配？ → 自动启用；导出范围 → 已启用、备选',
    );
    expect(rows, isNotNull);
    expect(rows, hasLength(2));
    expect(rows![0].question, '是否自动分配？');
    expect(rows[0].answer, '自动启用');
    expect(rows[1].question, '导出范围');
    expect(rows[1].answer, '已启用、备选');
    expect(parseClarificationAnswersSummary('普通助手回复'), isNull);
  });

  test(
    'buildActivityFeed renders clarification answers as right-aligned cards',
    () {
      final feed = buildActivityFeed(
        threadPrompt: '',
        threadId: 't1',
        runProjection: ThreadRunProjectionSnapshot(
          threadId: 't1',
          status: 'running',
          generatedAt: '2026-01-01T00:00:00.000Z',
          sourceEventCount: 1,
          agents: const [],
          timeline: [
            ThreadRunProjectionTimelineItem(
              id: 'clarification-answer',
              sequence: 1,
              eventType: 'message.final',
              scope: 'main',
              role: 'planner',
              text: '澄清回答：是否自动分配？ → 自动启用',
              at: '2026-01-01T00:00:01.000Z',
            ),
          ],
        ),
      );

      final answers = feed
          .where((entry) => entry.kind == ActivityFeedKind.clarificationAnswer)
          .toList();
      expect(answers, hasLength(1));
      expect(
        feed.any((entry) => entry.kind == ActivityFeedKind.assistant),
        isFalse,
      );
    },
  );

  test('buildActivityFeed hides generated plan status messages', () {
    final feed = buildActivityFeed(
      threadPrompt: '',
      threadId: 't1',
      runProjection: ThreadRunProjectionSnapshot(
        threadId: 't1',
        status: 'awaiting_plan',
        generatedAt: '2026-01-01T00:00:00.000Z',
        sourceEventCount: 4,
        agents: const [],
        timeline: [
          ThreadRunProjectionTimelineItem(
            id: 'plan-generated-waiting',
            sequence: 1,
            eventType: 'message.final',
            scope: 'main',
            role: 'planner',
            text: '计划已生成，等待确认。',
            at: '2026-01-01T00:00:01.000Z',
          ),
          ThreadRunProjectionTimelineItem(
            id: 'plan-generated-confirm',
            sequence: 2,
            eventType: 'message.final',
            scope: 'main',
            role: 'planner',
            text: '计划已生成，请确认是否执行。',
            at: '2026-01-01T00:00:02.000Z',
          ),
          ThreadRunProjectionTimelineItem(
            id: 'plan-ready',
            sequence: 3,
            eventType: 'thread.status',
            scope: 'main',
            role: 'planner',
            text: '计划已生成，请确认是否执行。',
            at: '2026-01-01T00:00:03.000Z',
            metadata: const {'liveType': 'plan.ready'},
          ),
          ThreadRunProjectionTimelineItem(
            id: 'plan-waiting',
            sequence: 4,
            eventType: 'thread.status',
            scope: 'main',
            role: 'planner',
            text: '等待确认',
            at: '2026-01-01T00:00:04.000Z',
            metadata: const {'liveType': 'thread.awaiting_plan'},
          ),
          ThreadRunProjectionTimelineItem(
            id: 'plan-approval-requested',
            sequence: 5,
            eventType: 'thread.status',
            scope: 'main',
            role: 'planner',
            text: '计划已提交，等待你确认。',
            at: '2026-01-01T00:00:05.000Z',
            metadata: const {'liveType': 'plan_approval.requested'},
          ),
        ],
      ),
    );

    expect(feed, isEmpty);
  });

  testWidgets('ActivityFeedList collapses long user prompts to five lines', (
    tester,
  ) async {
    await tester.binding.setSurfaceSize(const Size(360, 640));
    addTearDown(() => tester.binding.setSurfaceSize(null));

    final scrollController = ScrollController();
    addTearDown(scrollController.dispose);

    final longText = List.filled(12, '这是一段较长的用户输入内容').join('\n');

    await tester.pumpWidget(
      _localizedMaterialApp(
        theme: buildEcoDarkTheme(),
        home: Scaffold(
          body: SizedBox(
            width: 360,
            child: ActivityFeedList(
              entries: [
                ActivityFeedEntry(
                  id: 'user-long',
                  kind: ActivityFeedKind.user,
                  text: longText,
                ),
              ],
              scrollController: scrollController,
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('展开全文'), findsOneWidget);

    await tester.tap(find.text('展开全文'));
    await tester.pumpAndSettle();

    expect(find.text('收起'), findsOneWidget);
  });

  testWidgets('ActivityFeedList keeps short user prompts fully visible', (
    tester,
  ) async {
    final scrollController = ScrollController();
    addTearDown(scrollController.dispose);

    await tester.pumpWidget(
      _localizedMaterialApp(
        theme: buildEcoDarkTheme(),
        home: Scaffold(
          body: ActivityFeedList(
            entries: const [
              ActivityFeedEntry(
                id: 'user-short',
                kind: ActivityFeedKind.user,
                text: '短消息',
              ),
            ],
            scrollController: scrollController,
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('展开全文'), findsNothing);
    expect(find.text('短消息'), findsOneWidget);

    final bubble = tester.widget<Container>(
      find
          .ancestor(of: find.text('短消息'), matching: find.byType(Container))
          .first,
    );
    final decoration = bubble.decoration! as BoxDecoration;
    expect(decoration.color, const Color(0xFF3C3C3C));
    expect(decoration.border, isNull);
  });

  testWidgets(
    'ActivityFeedList uses the user bubble background for clarification answers',
    (tester) async {
      final scrollController = ScrollController();
      addTearDown(scrollController.dispose);

      await tester.pumpWidget(
        _localizedMaterialApp(
          theme: buildEcoDarkTheme(),
          home: Scaffold(
            body: ActivityFeedList(
              entries: const [
                ActivityFeedEntry(
                  id: 'clarification-answer',
                  kind: ActivityFeedKind.clarificationAnswer,
                  text: '澄清回答：是否自动分配？ → 自动启用',
                ),
              ],
              scrollController: scrollController,
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      final bubble = tester.widget<Container>(
        find
            .ancestor(of: find.text('自动启用'), matching: find.byType(Container))
            .first,
      );
      final decoration = bubble.decoration! as BoxDecoration;
      expect(
        decoration.color,
        ecoColors(tester.element(find.text('自动启用'))).userBubble,
      );
    },
  );

  testWidgets(
    'ActivityFeedList edits a user prompt inline without using the composer',
    (tester) async {
      final scrollController = ScrollController();
      addTearDown(scrollController.dispose);
      var rewritten = false;
      String? rewrittenPrompt;
      int? rewrittenRevision;

      await tester.pumpWidget(
        _localizedMaterialApp(
          theme: buildEcoDarkTheme(),
          home: Scaffold(
            body: ActivityFeedList(
              entries: const [
                ActivityFeedEntry(
                  id: 'user-editable',
                  kind: ActivityFeedKind.user,
                  text: 'original',
                  rewindTarget: ThreadActivityRewindTarget(
                    activityLineId: 'activity-1',
                  ),
                  historyRevision: 4,
                ),
              ],
              scrollController: scrollController,
              onLoadUserMessageEdit: (activityLineId) async {
                expect(activityLineId, 'activity-1');
                return const ThreadUserMessageEditGetResult(
                  threadId: 'thread-1',
                  activityLineId: 'activity-1',
                  text: 'loaded original',
                  attachments: [],
                  capability: ThreadUserMessageEditCapability(status: 'ready'),
                  historyRevision: 5,
                );
              },
              onRewriteUserMessage:
                  ({
                    required activityLineId,
                    required prompt,
                    required attachments,
                    required expectedHistoryRevision,
                  }) async {
                    rewritten =
                        activityLineId == 'activity-1' && attachments.isEmpty;
                    rewrittenPrompt = prompt;
                    rewrittenRevision = expectedHistoryRevision;
                  },
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.byIcon(EcoIcons.edit), findsOneWidget);
      await tester.tap(find.byIcon(EcoIcons.edit));
      await tester.pumpAndSettle();
      expect(find.byType(TextField), findsOneWidget);
      expect(find.text('loaded original'), findsOneWidget);

      await tester.enterText(find.byType(TextField), 'replacement');
      await tester.tap(find.byIcon(Icons.check));
      await tester.pumpAndSettle();

      expect(rewritten, isTrue);
      expect(rewrittenPrompt, 'replacement');
      expect(rewrittenRevision, 5);
      expect(find.byType(TextField), findsNothing);
    },
  );

  testWidgets('ActivityFeedList exposes V2 retry on failed request rows', (
    tester,
  ) async {
    final scrollController = ScrollController();
    addTearDown(scrollController.dispose);
    String? retriedEntryId;

    await tester.pumpWidget(
      _localizedMaterialApp(
        theme: buildEcoDarkTheme(),
        home: Scaffold(
          body: ActivityFeedList(
            entries: const [
              ActivityFeedEntry(
                id: 'user-retry',
                kind: ActivityFeedKind.user,
                text: 'retry prompt',
                sequence: 1,
                activityLineId: 'user-retry',
                historyRevision: 7,
              ),
              ActivityFeedEntry(
                id: 'turn-retry',
                kind: ActivityFeedKind.turn,
                text: '',
                running: true,
                runAttemptId: 'run-retry',
                processEntries: [
                  ActivityFeedEntry(
                    id: 'request-error',
                    kind: ActivityFeedKind.error,
                    text: '【连接失败】HTTP 503',
                    sequence: 3,
                  ),
                ],
              ),
            ],
            scrollController: scrollController,
            onRetryFailedRequest: (entry) async {
              retriedEntryId = entry.id;
            },
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('【连接失败】HTTP 503'), findsOneWidget);
    await tester.tap(find.text('重试'));
    await tester.pumpAndSettle();
    expect(retriedEntryId, 'request-error');
  });

  testWidgets('ActivityFeedList shrinkWrap grows until constrained', (
    tester,
  ) async {
    const maxHeight = 220.0;
    final scrollController = ScrollController();
    addTearDown(scrollController.dispose);
    final listKey = GlobalKey();

    Future<void> pumpList(List<ActivityFeedEntry> entries) async {
      await tester.pumpWidget(
        _localizedMaterialApp(
          theme: buildEcoDarkTheme(),
          home: Scaffold(
            body: Center(
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxHeight: maxHeight),
                child: ActivityFeedList(
                  key: listKey,
                  entries: entries,
                  scrollController: scrollController,
                  shrinkWrap: true,
                  showScrollJumpButton: false,
                  padding: EdgeInsets.zero,
                ),
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
    }

    await pumpList(const [
      ActivityFeedEntry(
        id: 'phase-short',
        kind: ActivityFeedKind.phase,
        text: '短状态',
      ),
    ]);
    expect(tester.getSize(find.byKey(listKey)).height, lessThan(maxHeight));

    await pumpList(
      List.generate(
        16,
        (index) => ActivityFeedEntry(
          id: 'assistant-$index',
          kind: ActivityFeedKind.assistant,
          text: '这是一段用于撑高详情弹窗的内容 $index',
        ),
      ),
    );
    expect(tester.getSize(find.byKey(listKey)).height, maxHeight);
  });

  test(
    'resolveSubagentCardMissionText falls back to main timeline @mission by parentToolUseId',
    () {
      const missionText =
          '@mission {"role":"coder","summary":"Implement export filters in src/api.ts","prompt":"Implement export filters in src/api.ts"}';
      final text = resolveSubagentCardMissionText(
        ThreadRunProjectionAgent(
          agentId: 'agent_coder_a',
          role: 'coder',
          kind: 'subagent',
          status: 'active',
          startedAt: '2026-01-01T00:00:01.000Z',
          durationMs: 0,
          parentToolUseId: 'toolu_agent_1',
          timeline: const [],
        ),
        mainTimeline: [
          ThreadRunProjectionTimelineItem(
            id: 'delegate-coder',
            sequence: 1,
            eventType: 'tool.started',
            scope: 'main',
            role: 'coder',
            text: missionText,
            at: '2026-01-01T00:00:00.000Z',
            metadata: const {
              'liveType': 'tool.started',
              'tool': {
                'name': 'Agent',
                'detail': 'coder',
                'toolUseId': 'toolu_agent_1',
                'status': 'running',
              },
            },
          ),
        ],
      );
      expect(text, 'Implement export filters in src/api.ts');
    },
  );

  test(
    'resolveSubagentCardMissionText falls back to agent.started timeline metadata',
    () {
      final text = resolveSubagentCardMissionText(
        ThreadRunProjectionAgent(
          agentId: 'coder_a',
          role: 'coder',
          kind: 'subagent',
          status: 'active',
          startedAt: '2026-01-01T00:00:00.000Z',
          durationMs: 0,
          timeline: [
            ThreadRunProjectionTimelineItem(
              id: 'agent-started',
              sequence: 1,
              eventType: 'agent.started',
              scope: 'agent',
              role: 'coder',
              agentId: 'coder_a',
              text: 'Subagent coder started',
              at: '2026-01-01T00:00:00.000Z',
              metadata: const {
                'lifecycle': 'started',
                'delegationPrompt': 'Review export filters in src/api.ts',
                'delegationSummary': '审查：export filters',
              },
            ),
          ],
        ),
      );
      expect(text, 'Review export filters in src/api.ts');
    },
  );

  test(
    'buildActivityFeed shows subagent mission from parentToolUseId fallback',
    () {
      const missionText =
          '@mission {"role":"coder","summary":"Implement export filters in src/api.ts","prompt":"Implement export filters in src/api.ts"}';
      final feed = buildActivityFeed(
        runProjection: ThreadRunProjectionSnapshot.fromJson({
          'thread': {
            'threadId': 't1',
            'status': 'running',
            'generatedAt': '2026-01-01T00:00:00.000Z',
          },
          'sourceEventCount': 2,
          'timeline': [
            {
              'id': 'delegate-coder',
              'sequence': 1,
              'eventType': 'tool.started',
              'scope': 'main',
              'role': 'coder',
              'text': missionText,
              'at': '2026-01-01T00:00:00.000Z',
              'metadata': {
                'liveType': 'tool.started',
                'tool': {
                  'name': 'Agent',
                  'detail': 'coder',
                  'toolUseId': 'toolu_agent_1',
                  'status': 'running',
                },
              },
            },
          ],
          'agents': [
            {
              'agentId': 'agent_coder_a',
              'role': 'coder',
              'kind': 'subagent',
              'status': 'active',
              'startedAt': '2026-01-01T00:00:01.000Z',
              'durationMs': 0,
              'parentToolUseId': 'toolu_agent_1',
              'timeline': [],
            },
          ],
        }),
      );

      final card = feed.firstWhere(
        (entry) => entry.kind == ActivityFeedKind.subagentMission,
      );
      expect(card.missionPrompt, 'Implement export filters in src/api.ts');
    },
  );

  test(
    'buildActivityFeed keeps completed planner replies from prior turns',
    () {
      final feed = buildActivityFeed(
        threadPrompt: '',
        threadId: 't1',
        runProjection: ThreadRunProjectionSnapshot(
          threadId: 't1',
          status: 'idle',
          generatedAt: '2026-01-01T00:00:00.000Z',
          sourceEventCount: 3,
          agents: const [],
          requestSpans: const [
            ThreadRunProjectionRequestSpan(
              requestId: 'req_turn_1',
              status: 'completed',
              startedAt: '2026-01-01T00:00:01.000Z',
              endedAt: '2026-01-01T00:00:03.000Z',
            ),
            ThreadRunProjectionRequestSpan(
              requestId: 'req_turn_2',
              status: 'completed',
              startedAt: '2026-01-01T00:01:00.000Z',
              endedAt: '2026-01-01T00:01:05.000Z',
            ),
          ],
          timeline: [
            ThreadRunProjectionTimelineItem(
              id: 'turn-1-final',
              sequence: 1,
              eventType: 'message.final',
              scope: 'main',
              role: 'planner',
              requestId: 'req_turn_1',
              streamKey: 'thr_view:planner',
              text: '第一轮回复。',
              at: '2026-01-01T00:00:03.000Z',
            ),
            ThreadRunProjectionTimelineItem(
              id: 'turn-2-user',
              sequence: 2,
              eventType: 'thread.status',
              scope: 'main',
              role: 'user',
              text: '继续帮我查一下。',
              at: '2026-01-01T00:00:59.000Z',
              metadata: const {'liveType': 'thread.user_prompt'},
            ),
            ThreadRunProjectionTimelineItem(
              id: 'turn-2-final',
              sequence: 3,
              eventType: 'message.final',
              scope: 'main',
              role: 'planner',
              requestId: 'req_turn_2',
              streamKey: 'thr_view:planner',
              text: '第二轮回复。',
              at: '2026-01-01T00:01:05.000Z',
            ),
          ],
        ),
      );

      final assistantTexts = feed
          .where((entry) => entry.kind == ActivityFeedKind.assistant)
          .map((entry) => entry.text)
          .toList();
      expect(assistantTexts, ['第一轮回复。', '第二轮回复。']);
    },
  );

  test('buildActivityFeed keeps early turns after many thinking deltas', () {
    final deltas = List<ThreadRunProjectionTimelineItem>.generate(
      100,
      (index) => ThreadRunProjectionTimelineItem(
        id: 'thinking-delta-$index',
        sequence: index + 1,
        eventType: 'thinking.delta',
        scope: 'main',
        role: 'thinking',
        requestId: 'req_long',
        streamKey: 'thr_test:thinking',
        text: 'x' * (index + 1),
        at: '2026-01-01T00:00:${(index + 1).toString().padLeft(2, '0')}.000Z',
      ),
    );
    final feed = buildActivityFeed(
      threadPrompt: '',
      threadId: 't1',
      runProjection: ThreadRunProjectionSnapshot(
        threadId: 't1',
        status: 'idle',
        generatedAt: '2026-01-01T00:00:00.000Z',
        sourceEventCount: deltas.length + 2,
        agents: const [],
        requestSpans: const [
          ThreadRunProjectionRequestSpan(
            requestId: 'req_long',
            status: 'completed',
            startedAt: '2026-01-01T00:00:01.000Z',
            endedAt: '2026-01-01T00:02:00.000Z',
          ),
          ThreadRunProjectionRequestSpan(
            requestId: 'req_turn_2',
            status: 'completed',
            startedAt: '2026-01-01T00:03:00.000Z',
            endedAt: '2026-01-01T00:03:05.000Z',
          ),
        ],
        timeline: [
          ...deltas,
          ThreadRunProjectionTimelineItem(
            id: 'turn-1-final',
            sequence: 101,
            eventType: 'message.final',
            scope: 'main',
            role: 'planner',
            requestId: 'req_long',
            streamKey: 'thr_test:planner',
            text: '第一轮回复。',
            at: '2026-01-01T00:02:01.000Z',
          ),
          ThreadRunProjectionTimelineItem(
            id: 'turn-2-final',
            sequence: 102,
            eventType: 'message.final',
            scope: 'main',
            role: 'planner',
            requestId: 'req_turn_2',
            streamKey: 'thr_test:planner',
            text: '第二轮回复。',
            at: '2026-01-01T00:03:05.000Z',
          ),
        ],
      ),
    );

    final assistantTexts = feed
        .where((entry) => entry.kind == ActivityFeedKind.assistant)
        .map((entry) => entry.text)
        .toList();
    expect(assistantTexts, ['第一轮回复。', '第二轮回复。']);
  });

  test(
    'buildActivityFeed keeps separate SDK text blocks in one completed request',
    () {
      final feed = buildActivityFeed(
        threadPrompt: '',
        threadId: 't1',
        runProjection: ThreadRunProjectionSnapshot(
          threadId: 't1',
          status: 'idle',
          generatedAt: '2026-01-01T00:00:00.000Z',
          sourceEventCount: 2,
          agents: const [],
          requestSpans: const [
            ThreadRunProjectionRequestSpan(
              requestId: 'req_planner',
              status: 'completed',
              startedAt: '2026-01-01T00:00:01.000Z',
              endedAt: '2026-01-01T00:00:04.000Z',
            ),
          ],
          timeline: const [
            ThreadRunProjectionTimelineItem(
              id: 'text-block-0',
              sequence: 1,
              eventType: 'message.final',
              scope: 'main',
              role: 'planner',
              requestId: 'req_planner',
              streamKey: 'thr_view:planner:block:text:0',
              text: '第一句正文。',
              at: '2026-01-01T00:00:02.000Z',
            ),
            ThreadRunProjectionTimelineItem(
              id: 'text-block-2',
              sequence: 2,
              eventType: 'message.final',
              scope: 'main',
              role: 'planner',
              requestId: 'req_planner',
              streamKey: 'thr_view:planner:block:text:2',
              text: '第二句正文。',
              at: '2026-01-01T00:00:04.000Z',
            ),
          ],
        ),
      );

      final assistantTexts = feed
          .where((entry) => entry.kind == ActivityFeedKind.assistant)
          .map((entry) => entry.text)
          .toList();
      expect(assistantTexts, ['第一句正文。', '第二句正文。']);
    },
  );

  test('buildActivityFeed keeps SDK block streams from separate turns', () {
    final feed = buildActivityFeed(
      threadPrompt: '',
      threadId: 't1',
      thinkingDisplayMode: ThinkingDisplayMode.collapsed,
      runProjection: ThreadRunProjectionSnapshot(
        threadId: 't1',
        status: 'idle',
        generatedAt: '2026-01-01T00:00:00.000Z',
        sourceEventCount: 10,
        agents: const [],
        requestSpans: const [
          ThreadRunProjectionRequestSpan(
            requestId: 'req_turn_1',
            status: 'completed',
            startedAt: '2026-01-01T00:00:01.000Z',
            endedAt: '2026-01-01T00:00:05.000Z',
            role: 'planner',
          ),
          ThreadRunProjectionRequestSpan(
            requestId: 'req_turn_2',
            status: 'completed',
            startedAt: '2026-01-01T00:01:01.000Z',
            endedAt: '2026-01-01T00:01:05.000Z',
            role: 'planner',
          ),
        ],
        timeline: const [
          ThreadRunProjectionTimelineItem(
            id: 'turn-1-user',
            sequence: 1,
            eventType: 'thread.status',
            scope: 'main',
            role: 'user',
            text: '第一轮。',
            at: '2026-01-01T00:00:00.000Z',
            metadata: {'liveType': 'thread.user_prompt'},
          ),
          ThreadRunProjectionTimelineItem(
            id: 'turn-1-request',
            sequence: 2,
            eventType: 'request.started',
            scope: 'main',
            role: 'planner',
            requestId: 'req_turn_1',
            text: '',
            at: '2026-01-01T00:00:01.000Z',
          ),
          ThreadRunProjectionTimelineItem(
            id: 'turn-1-thinking',
            sequence: 3,
            eventType: 'thinking.final',
            scope: 'main',
            role: 'thinking',
            requestId: 'req_turn_1',
            streamKey: 'thr_view:thinking:block:thinking:0',
            text: '第一轮思考。',
            at: '2026-01-01T00:00:02.000Z',
          ),
          ThreadRunProjectionTimelineItem(
            id: 'turn-1-message',
            sequence: 4,
            eventType: 'message.final',
            scope: 'main',
            role: 'planner',
            streamKey: 'thr_view:planner:block:text:1',
            text: '第一轮回复。',
            at: '2026-01-01T00:00:04.000Z',
          ),
          ThreadRunProjectionTimelineItem(
            id: 'turn-2-user',
            sequence: 5,
            eventType: 'thread.status',
            scope: 'main',
            role: 'user',
            text: '第二轮。',
            at: '2026-01-01T00:01:00.000Z',
            metadata: {'liveType': 'thread.user_prompt'},
          ),
          ThreadRunProjectionTimelineItem(
            id: 'turn-2-request',
            sequence: 6,
            eventType: 'request.started',
            scope: 'main',
            role: 'planner',
            requestId: 'req_turn_2',
            text: '',
            at: '2026-01-01T00:01:01.000Z',
          ),
          ThreadRunProjectionTimelineItem(
            id: 'turn-2-thinking',
            sequence: 7,
            eventType: 'thinking.final',
            scope: 'main',
            role: 'thinking',
            requestId: 'req_turn_2',
            streamKey: 'thr_view:thinking:block:thinking:0',
            text: '第二轮思考。',
            at: '2026-01-01T00:01:02.000Z',
          ),
          ThreadRunProjectionTimelineItem(
            id: 'turn-2-message',
            sequence: 8,
            eventType: 'message.final',
            scope: 'main',
            role: 'planner',
            streamKey: 'thr_view:planner:block:text:1',
            text: '第二轮回复。',
            at: '2026-01-01T00:01:04.000Z',
          ),
        ],
      ),
    );

    expect(feed.map((entry) => entry.id).toList(), [
      'turn-1-user',
      'main:stream:thinking:sk:thr_view:thinking:block:thinking:0:req:req_turn_1',
      'main:stream:message:sk:thr_view:planner:block:text:1:req:req_turn_1',
      'turn-2-user',
      'main:stream:thinking:sk:thr_view:thinking:block:thinking:0:req:req_turn_2',
      'main:stream:message:sk:thr_view:planner:block:text:1:req:req_turn_2',
    ]);
    final assistantTexts = feed
        .where((entry) => entry.kind == ActivityFeedKind.assistant)
        .map((entry) => entry.text)
        .toList();
    expect(assistantTexts, ['第一轮回复。', '第二轮回复。']);
  });

  test('buildActivityFeed hides duplicate final echoes for SDK block rows', () {
    final feed = buildActivityFeed(
      threadPrompt: '',
      threadId: 't1',
      thinkingDisplayMode: ThinkingDisplayMode.collapsed,
      runProjection: ThreadRunProjectionSnapshot(
        threadId: 't1',
        status: 'idle',
        generatedAt: '2026-01-01T00:00:00.000Z',
        sourceEventCount: 4,
        agents: const [],
        requestSpans: const [
          ThreadRunProjectionRequestSpan(
            requestId: 'req_planner',
            status: 'completed',
            startedAt: '2026-01-01T00:00:01.000Z',
            endedAt: '2026-01-01T00:00:04.000Z',
          ),
        ],
        timeline: const [
          ThreadRunProjectionTimelineItem(
            id: 'thinking-legacy-final',
            sequence: 1,
            eventType: 'thinking.final',
            scope: 'main',
            role: 'thinking',
            requestId: 'req_planner',
            streamKey: 'thr_view:thinking',
            text: '旧思考。',
            at: '2026-01-01T00:00:02.000Z',
          ),
          ThreadRunProjectionTimelineItem(
            id: 'thinking-block-final',
            sequence: 2,
            eventType: 'thinking.final',
            scope: 'main',
            role: 'thinking',
            streamKey: 'thr_view:thinking:block:thinking:0',
            text: '旧思考。',
            at: '2026-01-01T00:00:02.001Z',
          ),
          ThreadRunProjectionTimelineItem(
            id: 'message-legacy-final',
            sequence: 3,
            eventType: 'message.final',
            scope: 'main',
            role: 'planner',
            requestId: 'req_planner',
            streamKey: 'thr_view:planner',
            text: '最终回复。',
            at: '2026-01-01T00:00:04.000Z',
          ),
          ThreadRunProjectionTimelineItem(
            id: 'message-block-final',
            sequence: 4,
            eventType: 'message.final',
            scope: 'main',
            role: 'planner',
            streamKey: 'thr_view:planner:block:text:1',
            text: '最终回复。',
            at: '2026-01-01T00:00:04.001Z',
          ),
        ],
      ),
    );

    expect(feed.map((entry) => entry.id).toList(), [
      'main:stream:thinking:sk:thr_view:thinking:block:thinking:0:req:req_planner',
      'main:stream:message:sk:thr_view:planner:block:text:1:req:req_planner',
    ]);
    expect(feed.map((entry) => entry.text).toList(), ['旧思考。', '最终回复。']);
  });

  test(
    'buildActivityFeed keeps settled stream delta while hiding assistant final echo',
    () {
      final feed = buildActivityFeed(
        threadPrompt: '',
        threadId: 't1',
        thinkingDisplayMode: ThinkingDisplayMode.collapsed,
        runProjection: ThreadRunProjectionSnapshot(
          threadId: 't1',
          status: 'idle',
          generatedAt: '2026-01-01T00:00:00.000Z',
          sourceEventCount: 2,
          agents: const [],
          requestSpans: const [
            ThreadRunProjectionRequestSpan(
              requestId: 'req_planner',
              status: 'completed',
              startedAt: '2026-01-01T00:00:01.000Z',
              endedAt: '2026-01-01T00:00:03.000Z',
            ),
          ],
          timeline: const [
            ThreadRunProjectionTimelineItem(
              id: 'thinking-block-delta',
              sequence: 1,
              eventType: 'thinking.delta',
              scope: 'main',
              role: 'thinking',
              requestId: 'req_planner',
              streamKey: 'thr_view:thinking:block:thinking:0',
              text: '已流式输出的思考。',
              at: '2026-01-01T00:00:02.000Z',
            ),
            ThreadRunProjectionTimelineItem(
              id: 'thinking-assistant-final',
              sequence: 2,
              eventType: 'thinking.final',
              scope: 'main',
              role: 'thinking',
              streamKey: 'thr_view:thinking:block:thinking:0',
              text: '已流式输出的思考。',
              at: '2026-01-01T00:00:02.001Z',
            ),
          ],
        ),
      );

      expect(feed.length, 1);
      expect(
        feed.first.id,
        'main:stream:thinking:sk:thr_view:thinking:block:thinking:0:req:req_planner',
      );
      expect(feed.first.kind, ActivityFeedKind.thinking);
      expect(feed.first.text, '已流式输出的思考。');
      expect(feed.first.streaming, isFalse);
    },
  );

  test(
    'buildActivityFeed keeps settled message delta while hiding assistant final echo',
    () {
      final feed = buildActivityFeed(
        threadPrompt: '',
        threadId: 't1',
        runProjection: ThreadRunProjectionSnapshot(
          threadId: 't1',
          status: 'idle',
          generatedAt: '2026-01-01T00:00:00.000Z',
          sourceEventCount: 2,
          agents: const [],
          requestSpans: const [
            ThreadRunProjectionRequestSpan(
              requestId: 'req_planner',
              status: 'completed',
              startedAt: '2026-01-01T00:00:01.000Z',
              endedAt: '2026-01-01T00:00:03.000Z',
              role: 'planner',
            ),
          ],
          timeline: const [
            ThreadRunProjectionTimelineItem(
              id: 'message-block-delta',
              sequence: 1,
              eventType: 'message.delta',
              scope: 'main',
              role: 'planner',
              requestId: 'req_planner',
              streamKey: 'thr_view:planner:block:text:1',
              text: '已流式输出的正文。',
              at: '2026-01-01T00:00:02.000Z',
            ),
            ThreadRunProjectionTimelineItem(
              id: 'message-assistant-final',
              sequence: 2,
              eventType: 'message.final',
              scope: 'main',
              role: 'planner',
              streamKey: 'thr_view:planner:block:text:1',
              text: '已流式输出的正文。',
              at: '2026-01-01T00:00:02.001Z',
            ),
          ],
        ),
      );

      expect(feed.length, 1);
      expect(
        feed.first.id,
        'main:stream:message:sk:thr_view:planner:block:text:1:req:req_planner',
      );
      expect(feed.first.kind, ActivityFeedKind.assistant);
      expect(feed.first.text, '已流式输出的正文。');
      expect(feed.first.streaming, isFalse);
    },
  );

  test('buildActivityFeed appends incremental message stream batches', () {
    final feed = buildActivityFeed(
      threadPrompt: '',
      threadId: 't1',
      runProjection: const ThreadRunProjectionSnapshot(
        threadId: 't1',
        status: 'running',
        generatedAt: '2026-01-01T00:00:00.000Z',
        sourceEventCount: 2,
        agents: [],
        requestSpans: [
          ThreadRunProjectionRequestSpan(
            requestId: 'req_stream',
            status: 'streaming',
            startedAt: '2026-01-01T00:00:01.000Z',
          ),
        ],
        timeline: [
          ThreadRunProjectionTimelineItem(
            id: 'message-batch-1',
            sequence: 1,
            eventType: 'message.delta',
            scope: 'main',
            role: 'planner',
            requestId: 'req_stream',
            streamKey: 'thr_test:planner:block:text:1',
            text: '第一批内容，',
            at: '2026-01-01T00:00:02.000Z',
          ),
          ThreadRunProjectionTimelineItem(
            id: 'message-batch-2',
            sequence: 2,
            eventType: 'message.delta',
            scope: 'main',
            role: 'planner',
            requestId: 'req_stream',
            streamKey: 'thr_test:planner:block:text:1',
            text: '第二批内容。',
            at: '2026-01-01T00:00:03.000Z',
          ),
        ],
      ),
    );

    expect(feed, hasLength(1));
    expect(feed.single.text, '第一批内容，第二批内容。');
    expect(feed.single.streaming, isTrue);
  });

  testWidgets(
    'ActivityFeedList keeps rendered text while appending the next projection batch',
    (tester) async {
      final controller = ScrollController();
      addTearDown(controller.dispose);

      ThreadRunProjectionSnapshot projection(
        String id,
        String text,
        int eventCount,
      ) {
        return ThreadRunProjectionSnapshot(
          threadId: 't1',
          status: 'running',
          generatedAt: '2026-01-01T00:00:0$eventCount.000Z',
          sourceEventCount: eventCount,
          agents: const [],
          requestSpans: const [
            ThreadRunProjectionRequestSpan(
              requestId: 'req_stream',
              status: 'streaming',
              startedAt: '2026-01-01T00:00:01.000Z',
            ),
          ],
          timeline: [
            ThreadRunProjectionTimelineItem(
              id: id,
              sequence: eventCount,
              eventType: 'message.delta',
              scope: 'main',
              role: 'planner',
              requestId: 'req_stream',
              streamKey: 'thr_test:planner:block:text:1',
              text: text,
              at: '2026-01-01T00:00:02.000Z',
            ),
          ],
        );
      }

      Widget app(ThreadRunProjectionSnapshot snapshot) {
        final entries = buildActivityFeed(
          threadPrompt: '',
          threadId: 't1',
          runProjection: snapshot,
        );
        return _localizedMaterialApp(
          theme: buildEcoDarkTheme(),
          home: Scaffold(
            body: ActivityFeedList(
              entries: entries,
              scrollController: controller,
              shrinkWrap: true,
            ),
          ),
        );
      }

      var current = projection('message-batch-1', '第一批内容，', 1);
      await tester.pumpWidget(app(current));
      for (var index = 0; index < 10; index++) {
        await tester.pump(pacedStreamInterval);
      }
      expect(find.text('第一批内容，'), findsOneWidget);

      current = mergeThreadRunProjectionSnapshots(
        current,
        projection('message-batch-2', '第二批内容。', 2),
      );
      await tester.pumpWidget(app(current));
      expect(find.text('第一批内容，'), findsOneWidget);

      for (var index = 0; index < 10; index++) {
        await tester.pump(pacedStreamInterval);
      }
      expect(find.text('第一批内容，第二批内容。'), findsOneWidget);
    },
  );

  test(
    'buildActivityFeed keeps stable ids while streaming thinking advances',
    () {
      ThreadRunProjectionSnapshot projectionForDelta(String id, String text) {
        return ThreadRunProjectionSnapshot(
          threadId: 't1',
          status: 'running',
          generatedAt: '2026-01-01T00:00:00.000Z',
          sourceEventCount: 1,
          agents: const [],
          requestSpans: const [
            ThreadRunProjectionRequestSpan(
              requestId: 'req_stream',
              status: 'streaming',
              startedAt: '2026-01-01T00:00:01.000Z',
            ),
          ],
          timeline: [
            ThreadRunProjectionTimelineItem(
              id: id,
              sequence: 1,
              eventType: 'thinking.delta',
              scope: 'main',
              role: 'thinking',
              requestId: 'req_stream',
              streamKey: 'thr_test:thinking',
              text: text,
              at: '2026-01-01T00:00:02.000Z',
            ),
          ],
        );
      }

      final firstFeed = buildActivityFeed(
        threadPrompt: '',
        threadId: 't1',
        runProjection: projectionForDelta('delta-1', '第一段思考'),
      );
      final secondFeed = buildActivityFeed(
        threadPrompt: '',
        threadId: 't1',
        runProjection: projectionForDelta('delta-2', '第一段思考扩展'),
      );

      expect(firstFeed.length, 1);
      expect(secondFeed.length, 1);
      expect(firstFeed.first.id, secondFeed.first.id);
      expect(secondFeed.first.text, '第一段思考扩展');
    },
  );

  test('shouldAutoScrollActivityFeed ignores bash action insertions', () {
    const previous = [
      ActivityFeedEntry(
        id: 'user-1',
        kind: ActivityFeedKind.user,
        text: '帮我跑测试',
      ),
      ActivityFeedEntry(
        id: 'thinking-1',
        kind: ActivityFeedKind.thinking,
        text: '思考中',
        streaming: true,
      ),
    ];
    final next = [
      previous[0],
      const ActivityFeedEntry(
        id: 'bash-1',
        kind: ActivityFeedKind.action,
        text: 'Run tests',
      ),
      previous[1],
    ];

    expect(
      shouldAutoScrollActivityFeed(previous: previous, next: next),
      isFalse,
    );
    expect(
      listMiddleInsertedFeedEntries(previous: previous, next: next).single.id,
      'bash-1',
    );
  });

  test(
    'shouldFollowStreamingTail tracks assistant, thinking, and reasoning',
    () {
      const previous = [
        ActivityFeedEntry(
          id: 'assistant-1',
          kind: ActivityFeedKind.assistant,
          text: 'hello',
          streaming: true,
        ),
      ];
      final next = [
        const ActivityFeedEntry(
          id: 'assistant-1',
          kind: ActivityFeedKind.assistant,
          text: 'hello world',
          streaming: true,
        ),
      ];

      expect(shouldFollowStreamingTail(previous: previous, next: next), isTrue);
    },
  );

  test('shouldFollowStreamingTail tracks reasoning stage text growth', () {
    const previous = [
      ActivityFeedEntry(
        id: 'stage-1',
        kind: ActivityFeedKind.reasoningStage,
        text: '定位',
        streaming: true,
      ),
    ];
    const next = [
      ActivityFeedEntry(
        id: 'stage-1',
        kind: ActivityFeedKind.reasoningStage,
        text: '定位入口',
        streaming: true,
      ),
    ];

    expect(shouldFollowStreamingTail(previous: previous, next: next), isTrue);
  });

  test('paces only the last streaming entry in feed order', () {
    final entries = [
      const ActivityFeedEntry(
        id: 'thinking-1',
        kind: ActivityFeedKind.thinking,
        text: '前面的思考',
        streaming: true,
      ),
      const ActivityFeedEntry(
        id: 'assistant-1',
        kind: ActivityFeedKind.assistant,
        text: '后面的内容',
        streaming: true,
      ),
    ];
    expect(resolveFeedPaceTargetId(entries), 'assistant-1');
  });

  test('paces the only streaming entry and ignores finalized ones', () {
    final entries = [
      const ActivityFeedEntry(
        id: 'thinking-1',
        kind: ActivityFeedKind.thinking,
        text: '已完成的思考',
        streaming: false,
      ),
      const ActivityFeedEntry(
        id: 'assistant-1',
        kind: ActivityFeedKind.assistant,
        text: '',
        streaming: true,
      ),
      const ActivityFeedEntry(
        id: 'assistant-2',
        kind: ActivityFeedKind.assistant,
        text: '正在输出',
        streaming: true,
      ),
    ];
    expect(resolveFeedPaceTargetId(entries), 'assistant-2');
    expect(
      resolveFeedPaceTargetId([
        const ActivityFeedEntry(
          id: 'thinking-1',
          kind: ActivityFeedKind.thinking,
          text: '已完成的思考',
          streaming: false,
        ),
      ]),
      isNull,
    );
  });

  test('finds the last streaming entry nested in a turn', () {
    final entries = [
      ActivityFeedEntry(
        id: 'turn-1',
        kind: ActivityFeedKind.turn,
        text: '',
        processEntries: const [
          ActivityFeedEntry(
            id: 'thinking-1',
            kind: ActivityFeedKind.thinking,
            text: '思考中',
            streaming: true,
          ),
        ],
        finalOutput: const ActivityFeedEntry(
          id: 'final-1',
          kind: ActivityFeedKind.assistant,
          text: '最终输出中',
          streaming: true,
        ),
      ),
    ];
    expect(resolveFeedPaceTargetId(entries), 'final-1');
  });
}

Widget _localizedMaterialApp({ThemeData? theme, required Widget home}) {
  return ProviderScope(
    child: MaterialApp(
      locale: const Locale('zh'),
      localizationsDelegates: const [
        AppLocalizations.delegate,
        GlobalMaterialLocalizations.delegate,
        GlobalWidgetsLocalizations.delegate,
        GlobalCupertinoLocalizations.delegate,
      ],
      supportedLocales: AppLocalizations.supportedLocales,
      theme: theme,
      home: home,
    ),
  );
}
