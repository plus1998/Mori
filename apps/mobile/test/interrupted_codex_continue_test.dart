import 'package:eco_mobile/core/models/conversation_v2_projection_models.dart';
import 'package:eco_mobile/features/threads/activity_feed.dart';
import 'package:eco_mobile/features/threads/interrupted_codex_continue.dart';
import 'package:eco_mobile/l10n/generated/app_localizations.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

const _user = ActivityFeedEntry(
  id: 'user',
  kind: ActivityFeedKind.user,
  text: '发布并合并',
  activityLineId: 'canonical-user',
);
const _error = ActivityFeedEntry(
  id: 'error',
  kind: ActivityFeedKind.error,
  text: "You've hit your usage limit.",
  runAttemptId: 'run',
);

List<ActivityFeedEntry> _entries({
  ActivityFeedEntry user = _user,
  ActivityFeedEntry error = _error,
}) => [
  user,
  ActivityFeedEntry(
    id: 'turn',
    kind: ActivityFeedKind.turn,
    text: '',
    runAttemptId: 'run',
    turnStatus: 'failed',
    finalOutput: error,
    processEntries: [
      const ActivityFeedEntry(
        id: 'progress',
        kind: ActivityFeedKind.assistant,
        text: '发布停留在 3/4，我会继续跟踪。',
      ),
      const ActivityFeedEntry(
        id: 'tools',
        kind: ActivityFeedKind.actionGroup,
        text: '已操作浏览器 6 次',
      ),
    ],
  ),
];

InterruptedCodexContinueTarget? _target({
  String core = 'codex',
  String status = 'failed',
  String attemptStatus = 'failed',
  bool running = false,
  List<ActivityFeedEntry>? entries,
}) => resolveInterruptedCodexContinueTarget(
  coreKind: core,
  threadStatus: status,
  isRunning: running,
  projection: ThreadRunProjectionSnapshot(
    threadId: 'thread',
    status: status,
    generatedAt: '',
    sourceEventCount: 10,
    agents: const [],
    attempts: [
      ThreadRunProjectionAttempt(
        attemptId: 'run',
        phase: 'main',
        retryIndex: 0,
        status: attemptStatus,
        startedAt: '',
      ),
    ],
  ),
  entries: entries ?? _entries(),
);

void main() {
  test('an interrupted Codex turn can continue after output and tools', () {
    final target = _target()!;
    expect(target.sourceAttemptId, 'run');
    expect(target.user.activityLineId, 'canonical-user');
    expect(target.failureId, 'error');
    expect(_target(status: 'blocked'), isNotNull);
    expect(_target(status: 'idle', attemptStatus: 'cancelled'), isNotNull);
    // An image-only prompt still has a durable identity; no text is required
    // because the desktop dispatches an empty input rather than replaying it.
    expect(
      _target(
        entries: _entries(
          user: const ActivityFeedEntry(
            id: 'image-user',
            kind: ActivityFeedKind.user,
            text: '',
            activityLineId: 'image-user',
          ),
        ),
      ),
      isNotNull,
    );
  });

  test('continuation never targets running, completed or older work', () {
    expect(_target(running: true), isNull);
    expect(_target(status: 'running'), isNull);
    expect(_target(attemptStatus: 'running'), isNull);
    expect(_target(attemptStatus: 'completed'), isNull);
    expect(_target(status: 'completed'), isNull);
    expect(_target(core: 'claude'), isNull);
    expect(_target(core: 'acp'), isNull);
    expect(
      _target(
        entries: _entries(
          error: const ActivityFeedEntry(
            id: 'old-error',
            kind: ActivityFeedKind.error,
            text: 'old failure',
            runAttemptId: 'old-run',
          ),
        ),
      ),
      isNull,
    );
    expect(
      _target(
        entries: [
          ..._entries(),
          const ActivityFeedEntry(
            id: 'next-user',
            kind: ActivityFeedKind.user,
            text: 'New task',
            activityLineId: 'next-user',
          ),
        ],
      ),
      isNull,
    );
  });

  test('missing identity and runtime or subagent notices cannot continue', () {
    expect(
      _target(
        entries: _entries(
          user: const ActivityFeedEntry(
            id: 'unmapped',
            kind: ActivityFeedKind.user,
            text: 'task',
          ),
        ),
      ),
      isNull,
    );
    for (final error in const [
      ActivityFeedEntry(
        id: 'runtime-notice',
        kind: ActivityFeedKind.error,
        text: 'recording failed',
        runAttemptId: 'run',
        canRetryRequest: false,
      ),
      ActivityFeedEntry(
        id: 'agent-error',
        kind: ActivityFeedKind.error,
        text: 'child failed',
        runAttemptId: 'run',
        agentId: 'child',
      ),
    ]) {
      expect(_target(entries: _entries(error: error)), isNull);
    }
  });

  testWidgets('only the latest failure offers Continue and preserves progress', (
    tester,
  ) async {
    final scroll = ScrollController();
    addTearDown(scroll.dispose);
    final entries = [
      const ActivityFeedEntry(
        id: 'old-error',
        kind: ActivityFeedKind.error,
        text: 'old failure',
        runAttemptId: 'old-run',
      ),
      ..._entries(),
    ];
    final target = _target(entries: entries)!;
    final pending = ValueNotifier(false);
    addTearDown(pending.dispose);
    var calls = 0;
    await tester.pumpWidget(
      MaterialApp(
        locale: const Locale('zh'),
        localizationsDelegates: AppLocalizations.localizationsDelegates,
        supportedLocales: AppLocalizations.supportedLocales,
        home: Scaffold(
          body: ActivityFeedList(
            entries: entries,
            scrollController: scroll,
            shrinkWrap: true,
            showMessageCopyAndTime: false,
            // A resolver declining a historical failure must not fall back to retry.
            onRetryFailedRequest: (_) async => fail('Do not resend the prompt'),
            resolveFailedRequestAction: (entry) => entry.id != target.failureId
                ? null
                : ActivityFeedFailedRequestAction(
                    label: '继续',
                    run: () async {
                      calls++;
                      pending.value = true;
                    },
                  ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('重试'), findsNothing);
    expect(find.text('继续'), findsOneWidget);
    await tester.tap(
      find.text(
        lookupAppLocalizations(const Locale('zh')).activityStoppedUnexpectedly,
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('已操作浏览器 6 次'), findsOneWidget);
    await tester.tap(find.text('继续'));
    await tester.pumpAndSettle();
    expect(calls, 1);
    expect(pending.value, isTrue);
    expect(find.text('发布停留在 3/4，我会继续跟踪。'), findsOneWidget);
  });
}
