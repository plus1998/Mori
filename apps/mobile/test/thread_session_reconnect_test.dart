import 'dart:async';

import 'package:eco_mobile/core/models/eco_types.dart';
import 'package:eco_mobile/core/models/conversation_v2_models.dart';
import 'package:eco_mobile/core/models/thread_models.dart';
import 'package:eco_mobile/core/network/desktop_rpc.dart';
import 'package:eco_mobile/core/network/eco_center_client.dart';
import 'package:eco_mobile/core/providers/app_providers.dart';
import 'package:eco_mobile/core/providers/desktop_bind_ready.dart';
import 'package:eco_mobile/core/storage/credential_store.dart';
import 'package:eco_mobile/core/utils/thread_follow_up_ui.dart';
import 'package:eco_mobile/features/threads/thread_providers.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test(
    'registry reconciliation updates stale lifecycle and preserves full MCP requests',
    () async {
      final rpc = _TrackingDesktopRpc();
      final container = ProviderContainer(
        overrides: [
          desktopRpcProvider.overrideWithValue(rpc),
          desktopBindReadyOverrideProvider.overrideWithValue(true),
          ecoEventsProvider.overrideWith((ref) => const Stream.empty()),
          connectionStatusProvider.overrideWith((ref) => const Stream.empty()),
        ],
      );
      final subscription = container.listen(
        threadSessionProvider('thr_1'),
        (_, _) {},
      );
      addTearDown(() {
        subscription.close();
        container.dispose();
      });
      await _waitUntil(
        () => container.read(threadSessionProvider('thr_1')).thread != null,
      );
      rpc.bootstrapReply = Completer()
        ..complete(
          ThreadSessionBootstrapResult(
            thread: _thread.copyWith(status: 'completed'),
            pendingBash: const BashApprovalRequest(
              toolUseId: 'mcp',
              threadId: 'thr_1',
              command: 'MCP service/write',
              cwd: '/workspace',
              reason: 'write document',
              riskScore: 2,
              riskLevel: 'medium',
              mcpToolServerName: 'service',
              mcpToolName: 'write',
            ),
          ),
        );
      final pending = await container
          .read(threadSessionProvider('thr_1').notifier)
          .readPendingInteractions();
      expect(
        container.read(threadSessionProvider('thr_1')).thread?.status,
        'completed',
      );
      expect(pending.bash?.reason, 'write document');
      expect(pending.bash?.mcpToolName, 'write');
    },
  );

  test(
    'approval commands use the current V2 history revision after rewrites',
    () async {
      final rpc = _TrackingDesktopRpc();
      final container = ProviderContainer(
        overrides: [
          desktopRpcProvider.overrideWithValue(rpc),
          desktopBindReadyOverrideProvider.overrideWithValue(true),
          ecoEventsProvider.overrideWith((ref) => const Stream.empty()),
          connectionStatusProvider.overrideWith((ref) => const Stream.empty()),
          credentialsProvider.overrideWith(
            (ref) async =>
                const AppCredentials(supabaseUrl: '', userId: 'user'),
          ),
        ],
      );
      final subscription = container.listen(
        threadSessionProvider('thr_1'),
        (_, _) {},
      );
      addTearDown(() {
        subscription.close();
        container.dispose();
      });
      await container.read(credentialsProvider.future);
      await _waitUntil(
        () => container.read(threadSessionProvider('thr_1')).thread != null,
      );
      final notifier = container.read(threadSessionProvider('thr_1').notifier);
      await notifier.approvePlan();
      await notifier.dismissPlan();
      await notifier.resolveBash('mcp', 'approved_remember_mcp_tool');
      expect(rpc.resolutionRevisions, [7, 7, 7]);
    },
  );
  test(
    'a delayed queue snapshot cannot undo live delivery or remove a new row',
    () async {
      final statuses =
          StreamController<CenterServerConnectionStatus>.broadcast();
      final events = StreamController<EcoEventEnvelope>.broadcast();
      final queued = ThreadPendingFollowUp.fromJson({
        'id': 'sent',
        'threadId': 'thr_1',
        'prompt': 'old queue row',
        'status': 'queued',
        'createdAt': '2026-10-05T09:39:07.014Z',
        'updatedAt': '2026-10-05T09:42:58.648Z',
      });
      final rpc = _TrackingDesktopRpc()..followUps = [queued];
      final container = ProviderContainer(
        overrides: [
          desktopRpcProvider.overrideWithValue(rpc),
          selectedDesktopIdProvider.overrideWith((ref) => 'desktop_1'),
          connectionStatusProvider.overrideWith((ref) => statuses.stream),
          ecoEventsProvider.overrideWith((ref) => events.stream),
          desktopBindReadyOverrideProvider.overrideWithValue(true),
        ],
      );
      final subscription = container.listen(
        threadSessionProvider('thr_1'),
        (_, _) {},
        fireImmediately: true,
      );
      addTearDown(() async {
        subscription.close();
        container.dispose();
        await statuses.close();
        await events.close();
      });
      await _waitUntil(
        () =>
            container.read(threadSessionProvider('thr_1')).followUps.isNotEmpty,
      );
      final stale = Completer<List<ThreadPendingFollowUp>>();
      rpc.followUpsReply = stale;
      final refresh = container
          .read(threadSessionProvider('thr_1').notifier)
          .refreshFollowUps();
      events.add(
        _event('thread.follow_up.applied', {
          'followUp': {
            'id': 'sent',
            'threadId': 'thr_1',
            'prompt': 'old queue row',
            'status': 'applied',
            'createdAt': queued.createdAt,
            'updatedAt': '2026-10-05T09:46:20.407Z',
          },
        }),
      );
      await _waitUntil(
        () => container
            .read(threadSessionProvider('thr_1'))
            .followUps
            .any((row) => row.status == 'applied'),
      );
      events.add(
        _event('thread.follow_up.queued', {
          'followUp': {
            'id': 'new',
            'threadId': 'thr_1',
            'prompt': 'new row',
            'status': 'queued',
            'createdAt': '2026-10-05T09:47:00.000Z',
            'updatedAt': '2026-10-05T09:47:00.000Z',
          },
        }),
      );
      await _waitUntil(
        () =>
            container.read(threadSessionProvider('thr_1')).followUps.length ==
            2,
      );
      stale.complete([queued]);
      await refresh;
      await Future<void>.delayed(Duration.zero);
      expect(
        queuedThreadFollowUps(
          container.read(threadSessionProvider('thr_1')).followUps,
        ).map((row) => row.id),
        ['new'],
      );
    },
  );

  test(
    'a Resume receipt preserves the live run state and cannot undo a later pause',
    () async {
      final statuses =
          StreamController<CenterServerConnectionStatus>.broadcast();
      final events = StreamController<EcoEventEnvelope>.broadcast();
      final rpc = _TrackingDesktopRpc();
      final container = ProviderContainer(
        overrides: [
          desktopRpcProvider.overrideWithValue(rpc),
          selectedDesktopIdProvider.overrideWith((ref) => 'desktop_1'),
          connectionStatusProvider.overrideWith((ref) => statuses.stream),
          ecoEventsProvider.overrideWith((ref) => events.stream),
          desktopBindReadyOverrideProvider.overrideWithValue(true),
        ],
      );
      final subscription = container.listen(
        threadSessionProvider('thr_1'),
        (_, _) {},
        fireImmediately: true,
      );
      addTearDown(() async {
        subscription.close();
        container.dispose();
        await statuses.close();
        await events.close();
      });
      await _waitUntil(
        () => container.read(threadSessionProvider('thr_1')).thread != null,
      );
      final session = container.read(threadSessionProvider('thr_1').notifier);
      final beforeResume = session.followUpQueuePauseRevision;
      events.add(
        _event('thread.follow_up_queue_paused', {'followUpQueuePaused': true}),
      );
      await _waitUntil(
        () => container
            .read(threadSessionProvider('thr_1'))
            .thread!
            .followUpQueuePaused,
      );
      session.applyFollowUpQueuePaused(false, expectedRevision: beforeResume);
      expect(
        container
            .read(threadSessionProvider('thr_1'))
            .thread!
            .followUpQueuePaused,
        isTrue,
      );
      expect(
        container.read(threadSessionProvider('thr_1')).thread!.status,
        'running',
      );
      session.applyFollowUpQueuePaused(
        false,
        expectedRevision: session.followUpQueuePauseRevision,
      );
      expect(
        container
            .read(threadSessionProvider('thr_1'))
            .thread!
            .followUpQueuePaused,
        isFalse,
      );
      expect(
        container.read(threadSessionProvider('thr_1')).thread!.status,
        'running',
      );
      final oldBootstrap = Completer<ThreadSessionBootstrapResult>();
      rpc.bootstrapReply = oldBootstrap;
      final refresh = session.refreshPending();
      events.add(_event('thread.completed', {}));
      await _waitUntil(
        () =>
            container.read(threadSessionProvider('thr_1')).thread!.status ==
            'completed',
      );
      oldBootstrap.complete(
        const ThreadSessionBootstrapResult(thread: _thread),
      );
      await refresh;
      expect(
        container.read(threadSessionProvider('thr_1')).thread!.status,
        'completed',
      );
    },
  );

  test(
    'thread session reconnect never calls retired projection RPCs',
    () async {
      final statuses =
          StreamController<CenterServerConnectionStatus>.broadcast();
      final events = StreamController<EcoEventEnvelope>.broadcast();
      final rpc = _TrackingDesktopRpc();
      final container = ProviderContainer(
        overrides: [
          desktopRpcProvider.overrideWithValue(rpc),
          selectedDesktopIdProvider.overrideWith((ref) => 'desktop_1'),
          connectionStatusProvider.overrideWith((ref) => statuses.stream),
          ecoEventsProvider.overrideWith((ref) => events.stream),
          desktopBindReadyOverrideProvider.overrideWithValue(true),
        ],
      );
      final subscription = container.listen(
        threadSessionProvider('thr_1'),
        (_, _) {},
        fireImmediately: true,
      );
      addTearDown(() async {
        subscription.close();
        container.dispose();
        await statuses.close();
        await events.close();
      });

      await _waitUntil(() => rpc.sessionBootstrapRequests >= 1);
      expect(
        container.read(threadSessionProvider('thr_1')).thread?.id,
        'thr_1',
      );
      expect(rpc.retiredProjectionCalls, 0);

      statuses.add(
        const CenterServerConnectionStatus(
          state: EcoConnectionState.disconnected,
        ),
      );
      statuses.add(
        const CenterServerConnectionStatus(state: EcoConnectionState.connected),
      );
      await _waitUntil(() => rpc.sessionBootstrapRequests >= 2);
      expect(rpc.retiredProjectionCalls, 0);
      expect(
        container.read(threadSessionProvider('thr_1')).runProjection,
        isNull,
      );
    },
  );

  test(
    'composer recovery lookup failure does not replace the thread session',
    () async {
      final statuses =
          StreamController<CenterServerConnectionStatus>.broadcast();
      final events = StreamController<EcoEventEnvelope>.broadcast();
      final rpc = _TrackingDesktopRpc(failComposerDraft: true);
      final container = ProviderContainer(
        overrides: [
          desktopRpcProvider.overrideWithValue(rpc),
          selectedDesktopIdProvider.overrideWith((ref) => 'desktop_1'),
          connectionStatusProvider.overrideWith((ref) => statuses.stream),
          ecoEventsProvider.overrideWith((ref) => events.stream),
          // See the first case: the Realtime bind gate is not under test here.
          desktopBindReadyOverrideProvider.overrideWithValue(true),
        ],
      );
      final subscription = container.listen(
        threadSessionProvider('thr_1'),
        (_, _) {},
        fireImmediately: true,
      );
      addTearDown(() async {
        subscription.close();
        container.dispose();
        await statuses.close();
        await events.close();
      });

      await _waitUntil(
        () =>
            container.read(threadSessionProvider('thr_1')).thread?.id ==
            'thr_1',
      );
      final state = container.read(threadSessionProvider('thr_1'));
      expect(state.error, isNull);
      expect(state.thread?.id, 'thr_1');
      expect(state.composerRestore, isNull);
    },
  );

  test(
    'thread session refreshes and acknowledges durable composer recovery',
    () async {
      final statuses =
          StreamController<CenterServerConnectionStatus>.broadcast();
      final events = StreamController<EcoEventEnvelope>.broadcast();
      final rpc = _TrackingDesktopRpc()
        ..composerDraft = const ComposerDraftRecord(
          contextKey: 'thread:thr_1',
          prompt: 'restore me',
          revision: 'revision_1',
          updatedAt: '2026-08-22T00:00:00.000Z',
          recoveryReason: 'Cursor session failed',
          attachments: [
            PromptImageAttachment(mediaType: 'image/png', data: 'AQI='),
          ],
        );
      final container = ProviderContainer(
        overrides: [
          desktopRpcProvider.overrideWithValue(rpc),
          selectedDesktopIdProvider.overrideWith((ref) => 'desktop_1'),
          connectionStatusProvider.overrideWith((ref) => statuses.stream),
          ecoEventsProvider.overrideWith((ref) => events.stream),
          // See the first case: the Realtime bind gate is not under test here.
          desktopBindReadyOverrideProvider.overrideWithValue(true),
        ],
      );
      final subscription = container.listen(
        threadSessionProvider('thr_1'),
        (_, _) {},
        fireImmediately: true,
      );
      addTearDown(() async {
        subscription.close();
        container.dispose();
        await statuses.close();
        await events.close();
      });

      await _waitUntil(
        () =>
            container.read(threadSessionProvider('thr_1')).composerRestore !=
            null,
      );
      final restore = container
          .read(threadSessionProvider('thr_1'))
          .composerRestore!;
      expect(restore.prompt, 'restore me');
      expect(restore.revision, 'revision_1');
      expect(restore.attachments, hasLength(1));

      final deleted = await container
          .read(threadSessionProvider('thr_1').notifier)
          .acknowledgeComposerRestore('revision_1');
      expect(deleted, isTrue);
      expect(rpc.composerDraftDeletes, [
        (contextKey: 'thread:thr_1', revision: 'revision_1'),
      ]);
      expect(
        container.read(threadSessionProvider('thr_1')).composerRestore,
        isNull,
      );

      rpc.composerDraft = const ComposerDraftRecord(
        contextKey: 'thread:thr_1',
        prompt: 'restore after reconnect',
        revision: 'revision_2',
        updatedAt: '2026-08-22T00:00:01.000Z',
        recoveryReason: 'Cursor reconnect failure',
      );
      statuses.add(
        const CenterServerConnectionStatus(
          state: EcoConnectionState.disconnected,
        ),
      );
      statuses.add(
        const CenterServerConnectionStatus(state: EcoConnectionState.connected),
      );
      await _waitUntil(
        () =>
            container
                .read(threadSessionProvider('thr_1'))
                .composerRestore
                ?.revision ==
            'revision_2',
      );
      expect(rpc.composerDraftRequests.length, greaterThanOrEqualTo(2));
    },
  );
}

class _TrackingDesktopRpc extends DesktopRpc {
  _TrackingDesktopRpc({this.failComposerDraft = false})
    : super(EcoCenterClient(store: CredentialStore()), 'desktop_1');

  final bool failComposerDraft;
  final resolutionRevisions = <int>[];

  @override
  Future<ConversationV2Head> conversationV2Head(String conversationId) async =>
      ConversationV2Head(
        protocolVersion: 2,
        storeEpoch: 'epoch',
        conversationId: conversationId,
        lastSeq: 1,
        historyRevision: 7,
      );
  @override
  Future<void> approvePlan({
    required String principalId,
    required String clientCommandId,
    required String threadId,
    required int expectedHistoryRevision,
  }) async {
    resolutionRevisions.add(expectedHistoryRevision);
  }

  @override
  Future<void> dismissPlan({
    required String principalId,
    required String clientCommandId,
    required String threadId,
    required int expectedHistoryRevision,
  }) async {
    resolutionRevisions.add(expectedHistoryRevision);
  }

  @override
  Future<void> resolveBashApproval({
    required String principalId,
    required String clientCommandId,
    required String threadId,
    required String toolUseId,
    required String decision,
    required int expectedHistoryRevision,
    String? feedback,
  }) async {
    resolutionRevisions.add(expectedHistoryRevision);
  }

  @override
  Future<BashApprovalRequest?> getPendingBashApproval(String threadId) async =>
      null;
  var sessionBootstrapRequests = 0;
  var retiredProjectionCalls = 0;
  final composerDraftRequests = <String>[];
  final composerDraftDeletes = <({String contextKey, String revision})>[];
  ComposerDraftRecord? composerDraft;
  List<ThreadPendingFollowUp> followUps = [];
  Completer<List<ThreadPendingFollowUp>>? followUpsReply;
  Completer<ThreadSessionBootstrapResult>? bootstrapReply;

  @override
  Future<List<ThreadSummary>> listThreads() async => [_thread];

  @override
  Future<ThreadSessionBootstrapResult> sessionBootstrap(String threadId) async {
    sessionBootstrapRequests += 1;
    if (bootstrapReply != null) return await bootstrapReply!.future;
    return ThreadSessionBootstrapResult(thread: _thread, followUps: followUps);
  }

  @override
  Future<ThreadPendingPlan?> getPendingPlan(String threadId) async => null;

  @override
  Future<ComposerDraftRecord?> getComposerDraft(String contextKey) async {
    composerDraftRequests.add(contextKey);
    if (failComposerDraft) {
      throw StateError('composer draft unavailable');
    }
    return composerDraft;
  }

  @override
  Future<bool> deleteComposerDraft({
    required String contextKey,
    required String expectedRevision,
  }) async {
    composerDraftDeletes.add((
      contextKey: contextKey,
      revision: expectedRevision,
    ));
    if (composerDraft?.revision != expectedRevision) return false;
    composerDraft = null;
    return true;
  }

  @override
  Future<List<ThreadPendingFollowUp>> followUpList(String threadId) async =>
      followUpsReply?.future ?? followUps;
}

EcoEventEnvelope _event(String type, Map<String, dynamic> extra) =>
    EcoEventEnvelope(
      id: type,
      kind: 'thread.follow_up',
      source: 'test',
      threadId: 'thr_1',
      occurredAt: '2026-10-05T09:47:00.000Z',
      payload: {'threadId': 'thr_1', 'type': type, 'message': '', ...extra},
    );

const _thread = ThreadSummary(
  id: 'thr_1',
  title: 'Thread',
  prompt: 'Prompt',
  workspacePath: '/tmp/workspace',
  status: 'running',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  message: '',
);

Future<void> _waitUntil(bool Function() predicate) async {
  for (var attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await Future<void>.delayed(const Duration(milliseconds: 10));
  }
  fail('Timed out waiting for asynchronous provider work.');
}
