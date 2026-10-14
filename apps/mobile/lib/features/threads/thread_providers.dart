import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/models/eco_types.dart';
import '../../core/models/acp_models.dart';
import '../../core/models/asr_models.dart';
import '../../core/models/git_models.dart';
import '../../core/models/integration_models.dart';
import '../../core/models/mcp_models.dart';
import '../../core/models/project_orchestration_settings.dart';
import '../../core/models/project_models.dart';
import '../../core/models/app_error.dart';
import '../../core/models/skill_models.dart';
import '../../core/models/thread_runtime_config.dart';
import '../../core/models/thread_models.dart';
import '../../core/models/thread_usage_models.dart';
import '../../core/models/conversation_v2_projection_models.dart';
import '../../core/models/conversation_v2_models.dart';
import '../../core/network/desktop_rpc.dart';
import '../../core/storage/conversation_v2_cache.dart';
import '../../core/sync/conversation_v2_session.dart';
import '../../core/sync/conversation_v2_sync_engine.dart';
import '../../core/providers/app_providers.dart';
import '../../core/providers/desktop_bind_ready.dart';
import '../../core/utils/activity_display.dart';
import '../../core/utils/conversation_v2_hash.dart';
import '../../core/utils/thread_follow_up_ui.dart';
import '../../core/utils/thread_status.dart';

final conversationV2CacheProvider = Provider<ConversationV2Cache?>((ref) {
  final client = ref.watch(ecoCenterClientProvider);
  ref.watch(credentialsProvider);
  final fromState = ref.watch(selectedDesktopIdProvider);
  final desktopId = (fromState != null && fromState.isNotEmpty)
      ? fromState
      : client.credentials.selectedDesktopId;
  if (desktopId == null || desktopId.isEmpty) return null;
  final accountId = client.credentials.userId?.trim() ?? '';
  if (accountId.isEmpty) return null;
  // sqflite defaults to singleInstance per path. Keep one owner for the
  // shared native handle; a per-session close can otherwise invalidate every
  // other conversation and the durable command store.
  final cache = ConversationV2Cache(
    accountId: accountId,
    desktopDeviceId: desktopId,
  );
  ref.onDispose(() {
    unawaited(cache.close());
  });
  return cache;
});

final desktopRpcProvider = Provider<DesktopRpc?>((ref) {
  final client = ref.watch(ecoCenterClientProvider);
  // Rebuild when persisted credentials finish loading / change.
  ref.watch(credentialsProvider);
  final fromState = ref.watch(selectedDesktopIdProvider);
  final desktopId = (fromState != null && fromState.isNotEmpty)
      ? fromState
      : client.credentials.selectedDesktopId;
  if (desktopId == null || desktopId.isEmpty) return null;
  return DesktopRpc(
    client,
    desktopId,
    threadDeleteCommandStore: ref.watch(conversationV2CacheProvider),
  );
});

/// V2 is the source of truth for the ordered message window. The older
/// projection remains available for tool/process detail widgets during the
/// transition, but it no longer owns message ordering.
final conversationV2SessionProvider = StateNotifierProvider.autoDispose
    .family<
      ConversationV2SessionController,
      ConversationV2SessionState,
      String
    >((ref, conversationId) {
      final rpc = ref.watch(desktopRpcProvider);
      final credentials = ref.watch(credentialsProvider).valueOrNull;
      final accountId = credentials?.userId?.trim() ?? '';
      final sharedCache = ref.watch(conversationV2CacheProvider);
      final enabled =
          rpc != null && accountId.isNotEmpty && sharedCache != null;
      final cache =
          sharedCache ??
          ConversationV2Cache(
            accountId: 'unavailable',
            desktopDeviceId: 'unavailable',
          );
      final remote = rpc == null
          ? _UnavailableConversationV2Remote()
          : DesktopRpcConversationV2Remote(rpc);
      final controller = ConversationV2SessionController(
        conversationId: conversationId,
        cache: cache,
        remote: remote,
        actions: rpc == null
            ? null
            : ConversationV2InteractionActions(
                resolveBash: (toolUseId, decision, {feedback}) => ref
                    .read(threadSessionProvider(conversationId).notifier)
                    .resolveBash(toolUseId, decision, feedback: feedback),
                approvePlan: () => ref
                    .read(threadSessionProvider(conversationId).notifier)
                    .approvePlan(),
                dismissPlan: () => ref
                    .read(threadSessionProvider(conversationId).notifier)
                    .dismissPlan(),
                submitClarification: (toolUseId, selections) => ref
                    .read(threadSessionProvider(conversationId).notifier)
                    .submitClarification(toolUseId, selections),
                dismissClarification: (toolUseId) => ref
                    .read(threadSessionProvider(conversationId).notifier)
                    .dismissClarification(toolUseId),
              ),
        enabled: enabled,
        closeCacheOnClose: sharedCache == null,
      );
      ref.listen(ecoEventsProvider, (_, next) {
        next.whenData((event) {
          if (event.kind == 'conversation.projection_extras') {
            final rawPayload = event.payload;
            if (rawPayload is Map &&
                rawPayload['conversationId'] == conversationId) {
              unawaited(controller.reloadProjectionExtras());
            }
            return;
          }
          if (event.kind != 'conversation.sync_effect') return;
          final rawPayload = event.payload;
          if (rawPayload is! Map) return;
          final payload = Map<String, dynamic>.from(rawPayload);
          if (payload['conversationId'] != conversationId) {
            return;
          }
          // The sync engine accepts the full event envelope. The provider
          // listener receives the envelope fields separately, so passing only
          // `event.payload` silently drops every V2 push before it reaches
          // sequence validation.
          unawaited(
            controller.acceptPushEnvelope({
              'kind': event.kind,
              'payload': payload,
            }),
          );
        });
      });
      ref.listen(connectionStatusProvider, (_, next) {
        next.whenData((status) {
          if (status.state == EcoConnectionState.connected) {
            unawaited(controller.refresh());
          }
        });
      });
      unawaited(controller.start());
      ref.onDispose(() {
        unawaited(controller.close());
      });
      return controller;
    });

class _UnavailableConversationV2Remote implements ConversationV2Remote {
  Never _unavailable() => throw StateError('Desktop is not available.');

  @override
  Future<ConversationV2Capabilities> capabilities() async => _unavailable();

  @override
  Future<ConversationV2Bootstrap> bootstrap(
    String conversationId, {
    int pageSize = 30,
    int maxBytes = 512 * 1024,
  }) async => _unavailable();

  @override
  Future<ConversationV2MessagePage> messagesPage(
    String conversationId, {
    String? beforeCursor,
    int limit = 30,
    int maxBytes = 512 * 1024,
  }) async => _unavailable();

  @override
  Future<ConversationV2DetailPage> detailsPage(
    String conversationId,
    String runId, {
    String? cursor,
    String? toolCallId,
    String? agentInstanceId,
    int limit = 50,
    int maxBytes = 512 * 1024,
  }) async => _unavailable();

  @override
  Future<ConversationV2ToolsPage> toolsPage(
    String conversationId,
    String runId, {
    String? cursor,
    String? toolCallId,
    String? agentInstanceId,
    int limit = 50,
    int maxBytes = 512 * 1024,
  }) async => _unavailable();

  @override
  Future<ConversationV2Head> head(String conversationId) async =>
      _unavailable();

  @override
  Future<ConversationV2SyncPage> sync(
    String conversationId,
    String storeEpoch,
    int afterSeq, {
    int? throughSeq,
    int maxEvents = 200,
    int maxBytes = 512 * 1024,
  }) async => _unavailable();

  @override
  Future<ConversationV2Message?> messageGet(
    String conversationId,
    String messageId,
  ) async => _unavailable();

  @override
  Future<ConversationV2ProjectionExtras> projectionExtras(
    String conversationId,
  ) async => _unavailable();

  @override
  Future<ConversationV2SendMessageResult> sendMessage({
    required String principalId,
    required String conversationId,
    required String clientCommandId,
    required String text,
    List<dynamic>? attachments,
  }) async => _unavailable();
}

/// Pre-seed [threadSessionProvider] when handing off from the landing composer
/// so the session page does not flash a full-screen loading spinner.
final threadSessionSeedProvider = StateProvider<ThreadSummary?>((ref) => null);

/// Thread ids whose feed has been revealed at least once in this app session.
/// Matches desktop `activityFeedRevealedThreadIdsRef` boot-skip behavior.
final threadSessionRevealedProvider = StateProvider<Set<String>>((ref) => {});

/// In-memory per-desktop digest of the last successfully synced global settings.
final Map<String, String> globalSettingsDigestByDesktopId = <String, String>{};

@visibleForTesting
void clearGlobalSettingsDigestCacheForTest() {
  globalSettingsDigestByDesktopId.clear();
}

@visibleForTesting
Future<bool> syncGlobalSettingsIfDigestChanged({
  required String desktopId,
  required String? knownDigest,
  required String? cachedDigest,
  required Future<String> Function() fetchDigest,
  required Future<void> Function() reloadAll,
  required void Function(String digest) rememberDigest,
  required void Function() forceReloadWithoutDigest,
}) async {
  if (desktopId.trim().isEmpty) {
    return false;
  }

  var digest = knownDigest?.trim() ?? '';
  if (digest.isEmpty) {
    try {
      digest = (await fetchDigest()).trim();
    } catch (_) {
      forceReloadWithoutDigest();
      return true;
    }
  }
  if (digest.isEmpty) {
    forceReloadWithoutDigest();
    return true;
  }

  if (cachedDigest != null && cachedDigest == digest) {
    return false;
  }

  await reloadAll();
  rememberDigest(digest);
  return true;
}

/// Compare Desktop global-settings digest and full-pull only when it changed.
///
/// Returns `true` when model/workflow providers were invalidated (or forced).
Future<bool> ensureGlobalSettingsSynced(Ref ref, {String? knownDigest}) async {
  final desktopId = ref.read(selectedDesktopIdProvider)?.trim() ?? '';
  final rpc = ref.read(desktopRpcProvider);
  if (desktopId.isEmpty || rpc == null) {
    return false;
  }

  return syncGlobalSettingsIfDigestChanged(
    desktopId: desktopId,
    knownDigest: knownDigest,
    cachedDigest: globalSettingsDigestByDesktopId[desktopId],
    fetchDigest: () async => (await rpc.getSettingsDigest()).digest,
    reloadAll: () async {
      ref.invalidate(modelSettingsProvider);
      ref.invalidate(workflowSettingsProvider);
      await Future.wait([
        ref.read(modelSettingsProvider.future),
        ref.read(workflowSettingsProvider.future),
      ]);
    },
    rememberDigest: (digest) {
      globalSettingsDigestByDesktopId[desktopId] = digest;
    },
    forceReloadWithoutDigest: () {
      ref.invalidate(modelSettingsProvider);
      ref.invalidate(workflowSettingsProvider);
    },
  ).catchError((_) => true);
}

Future<void> warmGlobalSettingsDigestCache(Ref ref) async {
  final desktopId = ref.read(selectedDesktopIdProvider)?.trim() ?? '';
  final rpc = ref.read(desktopRpcProvider);
  if (desktopId.isEmpty || rpc == null) {
    return;
  }
  try {
    final digest = (await rpc.getSettingsDigest()).digest;
    if (digest.isNotEmpty) {
      globalSettingsDigestByDesktopId[desktopId] = digest;
    }
  } catch (_) {
    // Older Desktop or transient RPC failure — ignore.
  }
}

/// Keeps global model/workflow caches aligned via settings.updated + WS reconnect.
final globalSettingsSyncBootstrapProvider = Provider<void>((ref) {
  ref.listen(ecoEventsProvider, (_, next) {
    next.whenData((event) {
      if (event.kind != 'settings.updated') {
        return;
      }
      final payload = event.payload;
      String? knownDigest;
      if (payload is Map<String, dynamic>) {
        knownDigest = ThreadLiveEvent.fromJson(payload).settingsDigest;
      }
      unawaited(ensureGlobalSettingsSynced(ref, knownDigest: knownDigest));
    });
  });

  ref.listen(connectionStatusProvider, (previous, next) {
    next.whenData((status) {
      if (status.state != EcoConnectionState.connected) {
        return;
      }
      final wasConnected =
          previous?.valueOrNull?.state == EcoConnectionState.connected;
      if (wasConnected) {
        return;
      }
      unawaited(ensureGlobalSettingsSynced(ref));
    });
  });
});

final asrStatusProvider = FutureProvider<AsrStatus?>((ref) async {
  final rpc = ref.watch(desktopRpcProvider);
  if (rpc == null) return null;
  try {
    return await rpc.getAsrStatus();
  } catch (_) {
    return null;
  }
});

final threadListProvider =
    AsyncNotifierProvider<ThreadListNotifier, List<ThreadSummary>>(
      ThreadListNotifier.new,
    );

const threadListMorePageSize = 20;

final threadListPageMetadataProvider =
    StateProvider<Map<String, ThreadListPageMetadata>>((ref) => {});

enum ThreadAttentionKind { plan, bash }

class ThreadAttentionItem {
  const ThreadAttentionItem({
    required this.id,
    required this.threadId,
    required this.title,
    required this.kind,
    required this.updatedAt,
    this.detail,
  });

  final String id;
  final String threadId;
  final String title;
  final ThreadAttentionKind kind;
  final String updatedAt;
  final String? detail;
}

final threadAttentionProvider = FutureProvider<List<ThreadAttentionItem>>((
  ref,
) async {
  final rpc = ref.watch(desktopRpcProvider);
  if (rpc == null) return const [];
  final threadState = ref.watch(threadListProvider);
  final threads =
      (threadState.valueOrNull ?? await ref.watch(threadListProvider.future)) ??
      const <ThreadSummary>[];
  final items = <ThreadAttentionItem>[
    for (final thread in threads)
      if (thread.status == 'awaiting_plan')
        ThreadAttentionItem(
          id: 'plan:${thread.id}',
          threadId: thread.id,
          title: _threadAttentionTitle(thread),
          kind: ThreadAttentionKind.plan,
          updatedAt: thread.updatedAt,
        ),
  ];

  final bashItems = await Future.wait(
    threads.where((thread) => thread.status == 'running').map((thread) async {
      final approval = await rpc.getPendingBashApproval(thread.id);
      if (approval == null) return null;
      return ThreadAttentionItem(
        id: 'bash:${thread.id}:${approval.toolUseId}',
        threadId: thread.id,
        title: _threadAttentionTitle(thread),
        kind: ThreadAttentionKind.bash,
        updatedAt: thread.updatedAt,
        detail: _bashAttentionDetail(approval),
      );
    }),
  );
  items.addAll(bashItems.whereType<ThreadAttentionItem>());
  items.sort((left, right) {
    final kindOrder = left.kind.index.compareTo(right.kind.index);
    return kindOrder != 0
        ? kindOrder
        : right.updatedAt.compareTo(left.updatedAt);
  });
  return items;
});

String _threadAttentionTitle(ThreadSummary thread) {
  final title = thread.title.trim();
  if (title.isNotEmpty) return title;
  final prompt = thread.prompt.trim();
  if (prompt.isNotEmpty) return prompt;
  return thread.id;
}

String? _bashAttentionDetail(BashApprovalRequest approval) {
  final filesystemTool = approval.filesystemTool?.trim();
  final filesystemPath = approval.filesystemPath?.trim();
  if (filesystemTool?.isNotEmpty == true &&
      filesystemPath?.isNotEmpty == true) {
    return '$filesystemTool $filesystemPath';
  }
  return approval.command.trim().isNotEmpty
      ? approval.command.trim()
      : approval.description?.trim().isNotEmpty == true
      ? approval.description!.trim()
      : approval.reason.trim().isNotEmpty
      ? approval.reason.trim()
      : null;
}

class ThreadListNotifier extends AsyncNotifier<List<ThreadSummary>> {
  final _moreRequests = <String, Future<void>>{};
  final _pendingLiveEvents = <_ThreadListLiveEvent>[];
  final _pendingLocalUpserts = <String, _PendingThreadListUpsert>{};
  final _pendingLocalRemovals = <String>{};
  Future<void> _liveEventChain = Future<void>.value();
  int _dataEpoch = 0;
  bool _synchronizing = false;

  @override
  Future<List<ThreadSummary>> build() async {
    ref.watch(selectedDesktopIdProvider);
    final epoch = ++_dataEpoch;
    _pendingLiveEvents.clear();
    _pendingLocalUpserts.clear();
    _pendingLocalRemovals.clear();
    _liveEventChain = Future<void>.value();
    _moreRequests.clear();
    _synchronizing = true;

    ref.listen(ecoEventsProvider, (previous, next) {
      next.whenData((event) {
        if (event.kind == 'conversation.sync_effect') return;
        final payload = event.payload;
        if (payload is! Map<String, dynamic>) return;
        final live = ThreadLiveEvent.fromJson(payload);
        if (!_isThreadListLiveEvent(live)) return;
        final pending = _ThreadListLiveEvent(event, live);
        if (_synchronizing || state.valueOrNull == null) {
          _pendingLiveEvents.add(pending);
          return;
        }
        _scheduleLiveEvent(pending);
      });
    });

    final rpc = ref.watch(desktopRpcProvider);

    // Must not mutate sibling providers (e.g. page metadata) during the
    // synchronous initialization window — Riverpod asserts on that and the
    // threads screen surfaces it as "无法加载会话列表".
    await Future<void>.value();
    if (epoch != _dataEpoch) {
      return state.valueOrNull ?? const [];
    }
    _clearPageMetadata();

    if (rpc == null) {
      if (epoch == _dataEpoch) {
        await _publishSynchronizedList(const [], epoch);
      }
      return [];
    }

    try {
      // Match session-screen behavior: don't RPC until the bind channel is up.
      final ready = await ensureDesktopBindReady(ref);
      if (!ready) {
        // Stay subscribed so a later connect rebuilds this provider.
        ref.listen(connectionStatusProvider, (previous, next) {
          next.whenData((status) {
            if (status.state != EcoConnectionState.connected) return;
            final wasConnected =
                previous?.valueOrNull?.state == EcoConnectionState.connected;
            if (!wasConnected) {
              ref.invalidateSelf();
            }
          });
        });
        throw EcoCenterException.app(EcoCenterErrorKind.websocketDisconnected);
      }

      ref.listen(connectionStatusProvider, (previous, next) {
        next.whenData((status) {
          if (status.state != EcoConnectionState.connected) return;
          final wasConnected =
              previous?.valueOrNull?.state == EcoConnectionState.connected;
          if (!wasConnected) {
            ref.invalidateSelf();
          }
        });
      });

      final initial = await withDesktopRpcRetry(rpc.listInitialThreads);
      if (epoch != _dataEpoch) return initial.threads;
      _setPageMetadata(initial.pages);
      return await _publishSynchronizedList(initial.threads, epoch);
    } finally {
      if (epoch == _dataEpoch) _synchronizing = false;
    }
  }

  Future<void> refresh() async {
    final epoch = ++_dataEpoch;
    _pendingLiveEvents.clear();
    _pendingLocalUpserts.clear();
    _pendingLocalRemovals.clear();
    _liveEventChain = Future<void>.value();
    _moreRequests.clear();
    _synchronizing = true;
    _clearPageMetadata();
    state = const AsyncLoading();
    try {
      final nextState = await AsyncValue.guard(() async {
        final rpc = ref.read(desktopRpcProvider);
        if (rpc == null) return const <ThreadSummary>[];
        final ready = await ensureDesktopBindReady(ref);
        if (!ready) {
          throw EcoCenterException.app(
            EcoCenterErrorKind.websocketDisconnected,
          );
        }
        final threads = await withDesktopRpcRetry(rpc.listThreads);
        if (epoch != _dataEpoch) return threads;
        _setFullListMetadata(threads);
        return await _drainPendingLiveEvents(threads, epoch);
      });
      if (epoch == _dataEpoch) {
        final threads = nextState.valueOrNull;
        if (threads != null) {
          await _publishSynchronizedList(threads, epoch);
        } else {
          state = nextState;
          _synchronizing = false;
        }
      }
    } finally {
      if (epoch == _dataEpoch) _synchronizing = false;
    }
  }

  Future<List<ThreadSummary>> listAllForSearch() async {
    final rpc = ref.read(desktopRpcProvider);
    if (rpc == null) return const [];
    final ready = await ensureDesktopBindReady(ref);
    if (!ready) {
      throw EcoCenterException.app(EcoCenterErrorKind.websocketDisconnected);
    }
    return withDesktopRpcRetry(rpc.listThreads);
  }

  Future<void> loadMore(String workspacePath) {
    final key = normalizeProjectPath(workspacePath);
    final pending = _moreRequests[key];
    if (pending != null) return pending;
    final request = _loadMore(key);
    late final Future<void> tracked;
    tracked = request.whenComplete(() {
      if (identical(_moreRequests[key], tracked)) {
        _moreRequests.remove(key);
      }
    });
    _moreRequests[key] = tracked;
    return tracked;
  }

  void upsertThread(ThreadSummary thread, {bool countAsNew = true}) {
    final current = state.valueOrNull;
    if (_synchronizing || current == null) {
      _pendingLocalRemovals.remove(thread.id);
      final previous = _pendingLocalUpserts[thread.id];
      _pendingLocalUpserts[thread.id] = _PendingThreadListUpsert(
        thread: thread,
        countAsNew: countAsNew || previous?.countAsNew == true,
      );
      return;
    }
    final index = current.indexWhere((candidate) => candidate.id == thread.id);
    final next = List<ThreadSummary>.of(current);
    if (index < 0) {
      next.add(thread);
      if (countAsNew) {
        _updatePageMetadataAfterCountChange(thread.workspacePath, 1, next);
      }
    } else {
      next[index] = mergeThreadSummaryFromRemoteList(
        current: next[index],
        listed: thread,
      );
    }
    state = AsyncData(next);
  }

  void removeThread(String threadId) {
    final current = state.valueOrNull;
    if (_synchronizing || current == null) {
      _pendingLocalUpserts.remove(threadId);
      _pendingLocalRemovals.add(threadId);
      return;
    }
    final index = current.indexWhere((thread) => thread.id == threadId);
    if (index < 0) return;
    final removed = current[index];
    final next = List<ThreadSummary>.of(current)..removeAt(index);
    _updatePageMetadataAfterCountChange(removed.workspacePath, -1, next);
    state = AsyncData(next);
  }

  Future<void> _loadMore(String workspacePath) async {
    final epoch = _dataEpoch;
    final metadataEntry = _pageMetadataEntry(workspacePath);
    final metadata = metadataEntry?.value;
    if (metadata == null || !metadata.hasMore || metadata.nextCursor == null) {
      return;
    }
    final rpc = ref.read(desktopRpcProvider);
    if (rpc == null) return;
    final ready = await ensureDesktopBindReady(ref);
    if (!ready) {
      throw EcoCenterException.app(EcoCenterErrorKind.websocketDisconnected);
    }
    final page = await withDesktopRpcRetry(
      () => rpc.listMoreThreads(
        workspacePath: metadataEntry!.key,
        cursor: metadata.nextCursor!,
        limit: threadListMorePageSize,
      ),
    );
    if (epoch != _dataEpoch) return;
    final current = state.valueOrNull ?? const <ThreadSummary>[];
    state = AsyncData(_mergeThreadSummaries(current, page.threads));
    _setPageMetadataForWorkspace(workspacePath, page);
  }

  Future<void> _handleThreadListEvent(
    EcoEventEnvelope envelope,
    ThreadLiveEvent live,
    int epoch,
  ) async {
    if (epoch != _dataEpoch) return;
    if (_synchronizing) {
      _pendingLiveEvents.add(_ThreadListLiveEvent(envelope, live));
      return;
    }
    final current = state.valueOrNull;
    if (current == null) {
      _pendingLiveEvents.add(_ThreadListLiveEvent(envelope, live));
      return;
    }
    var next = await _applyThreadListEvent(current, envelope, live, epoch);
    if (epoch != _dataEpoch) return;
    final latest = state.valueOrNull;
    if (latest != null && !identical(latest, current)) {
      next = await _applyThreadListEvent(latest, envelope, live, epoch);
      if (epoch != _dataEpoch) return;
    }
    if (!identical(next, current)) {
      state = AsyncData(next);
    }
  }

  void _scheduleLiveEvent(_ThreadListLiveEvent pending) {
    final epoch = _dataEpoch;
    _liveEventChain = _liveEventChain.then((_) async {
      if (epoch != _dataEpoch) return;
      try {
        await _handleThreadListEvent(pending.envelope, pending.live, epoch);
      } catch (error) {
        debugPrint('Failed to apply live thread event: $error');
      }
    });
  }

  Future<List<ThreadSummary>> _publishSynchronizedList(
    List<ThreadSummary> threads,
    int epoch,
  ) async {
    var current = threads;
    while (epoch == _dataEpoch) {
      current = await _drainPendingLiveEvents(current, epoch);
      if (epoch != _dataEpoch) return current;
      state = AsyncData(current);
      if (_pendingLocalUpserts.isNotEmpty ||
          _pendingLocalRemovals.isNotEmpty ||
          _pendingLiveEvents.isNotEmpty) {
        continue;
      }
      _synchronizing = false;
      return current;
    }
    return current;
  }

  Future<List<ThreadSummary>> _drainPendingLiveEvents(
    List<ThreadSummary> threads,
    int epoch,
  ) async {
    var current = threads;
    while (_pendingLocalUpserts.isNotEmpty ||
        _pendingLocalRemovals.isNotEmpty ||
        _pendingLiveEvents.isNotEmpty) {
      if (epoch != _dataEpoch) return current;
      if (_pendingLocalRemovals.isNotEmpty || _pendingLocalUpserts.isNotEmpty) {
        final removals = Set<String>.of(_pendingLocalRemovals);
        final upserts = Map<String, _PendingThreadListUpsert>.of(
          _pendingLocalUpserts,
        );
        _pendingLocalRemovals.clear();
        _pendingLocalUpserts.clear();
        for (final threadId in removals) {
          final index = current.indexWhere((thread) => thread.id == threadId);
          if (index < 0) continue;
          final removed = current[index];
          current = List<ThreadSummary>.of(current)..removeAt(index);
          _updatePageMetadataAfterCountChange(
            removed.workspacePath,
            -1,
            current,
          );
        }
        for (final pending in upserts.values) {
          final thread = pending.thread;
          final index = current.indexWhere(
            (candidate) => candidate.id == thread.id,
          );
          if (index < 0) {
            current = List<ThreadSummary>.of(current)..add(thread);
            _updatePageMetadataAfterCountChange(
              thread.workspacePath,
              pending.countAsNew ? 1 : 0,
              current,
            );
          } else {
            current = List<ThreadSummary>.of(current)
              ..[index] = mergeThreadSummaryFromRemoteList(
                current: current[index],
                listed: thread,
              );
          }
        }
      }
      if (_pendingLiveEvents.isEmpty) continue;
      final pending = List<_ThreadListLiveEvent>.of(_pendingLiveEvents);
      _pendingLiveEvents.clear();
      for (final event in pending) {
        current = await _applyThreadListEvent(
          current,
          event.envelope,
          event.live,
          epoch,
        );
      }
    }
    return current;
  }

  Future<List<ThreadSummary>> _applyThreadListEvent(
    List<ThreadSummary> current,
    EcoEventEnvelope envelope,
    ThreadLiveEvent live,
    int epoch,
  ) async {
    if (epoch != _dataEpoch) return current;
    if (!_isThreadListLiveEvent(live)) return current;
    final threadId = live.threadId.trim().isNotEmpty
        ? live.threadId.trim()
        : envelope.threadId?.trim() ?? '';
    if (threadId.isEmpty) return current;

    final index = current.indexWhere((thread) => thread.id == threadId);
    if (live.type == 'thread.deleted') {
      if (index < 0) {
        final workspacePath = envelope.workspacePath?.trim();
        if (workspacePath?.isNotEmpty == true) {
          _updatePageMetadataAfterCountChange(workspacePath!, -1, current);
        }
        return current;
      }
      final removed = current[index];
      final next = List<ThreadSummary>.of(current)..removeAt(index);
      _updatePageMetadataAfterCountChange(removed.workspacePath, -1, next);
      return next;
    }

    if (index < 0) {
      final thread = await _getThreadForLiveEvent(threadId);
      if (epoch != _dataEpoch) return current;
      if (thread == null) return current;
      final next = List<ThreadSummary>.of(current)..add(thread);
      final countAsNew = live.type == 'thread.started';
      _updatePageMetadataAfterCountChange(
        thread.workspacePath,
        countAsNew ? 1 : 0,
        next,
      );
      return next;
    }

    final thread = current[index];
    final statusUpdate = shouldUpdateThreadSummaryFromLiveEvent(live.type);
    final nextStatus = statusUpdate
        ? threadStatusFromLiveEvent(live.type, thread.status)
        : thread.status;
    final nextTitle = live.title?.trim();
    final next = thread.copyWith(
      title: nextTitle?.isNotEmpty == true ? nextTitle : null,
      status: nextStatus,
      message: statusUpdate
          ? resolveThreadMessageFromLiveEvent(live.type, live.message)
          : thread.message,
      updatedAt: envelope.occurredAt,
      runtimeConfig: live.runtimeConfig ?? thread.runtimeConfig,
      cancelling: statusUpdate
          ? resolveThreadCancellingFromLiveEvent(
              nextStatus: nextStatus,
              currentCancelling: thread.cancelling,
              eventCancelling: live.cancelling,
            )
          : thread.cancelling,
      followUpQueuePaused:
          live.followUpQueuePaused ?? thread.followUpQueuePaused,
    );
    final nextList = List<ThreadSummary>.of(current)..[index] = next;
    return nextList;
  }

  Future<ThreadSummary?> _getThreadForLiveEvent(String threadId) async {
    final rpc = ref.read(desktopRpcProvider);
    if (rpc == null) return null;
    try {
      return await withDesktopRpcRetry(() => rpc.getThread(threadId));
    } catch (error) {
      debugPrint('Failed to add live thread $threadId: $error');
      return null;
    }
  }

  void _clearPageMetadata() {
    ref.read(threadListPageMetadataProvider.notifier).state = {};
  }

  void _setPageMetadata(Map<String, ThreadListPageMetadata> pages) {
    ref.read(threadListPageMetadataProvider.notifier).state = {...pages};
  }

  void _setFullListMetadata(List<ThreadSummary> threads) {
    final counts = <String, int>{};
    for (final thread in threads) {
      final key = normalizeProjectPath(thread.workspacePath);
      counts[key] = (counts[key] ?? 0) + 1;
    }
    ref.read(threadListPageMetadataProvider.notifier).state = {
      for (final entry in counts.entries)
        entry.key: ThreadListPageMetadata(
          hasMore: false,
          totalCount: entry.value,
        ),
    };
  }

  void _setPageMetadataForWorkspace(String workspacePath, ThreadListPage page) {
    final current = Map<String, ThreadListPageMetadata>.of(
      ref.read(threadListPageMetadataProvider),
    );
    final key = _pageMetadataEntry(workspacePath)?.key ?? workspacePath;
    current[key] = ThreadListPageMetadata(
      hasMore: page.hasMore,
      totalCount: page.totalCount,
      nextCursor: page.nextCursor,
    );
    ref.read(threadListPageMetadataProvider.notifier).state = current;
  }

  void _updatePageMetadataAfterCountChange(
    String workspacePath,
    int delta,
    List<ThreadSummary> threads,
  ) {
    final metadataEntry = _pageMetadataEntry(workspacePath);
    final current = ref.read(threadListPageMetadataProvider);
    final metadata = metadataEntry?.value;
    final key = metadataEntry?.key ?? workspacePath;
    final normalizedKey = normalizeProjectPath(key);
    final loadedCount = threads
        .where(
          (thread) =>
              normalizeProjectPath(thread.workspacePath) == normalizedKey,
        )
        .length;
    if (metadata == null) {
      ref.read(threadListPageMetadataProvider.notifier).state = {
        ...current,
        normalizedKey: ThreadListPageMetadata(
          hasMore: false,
          totalCount: loadedCount,
        ),
      };
      return;
    }
    final totalCount = (metadata.totalCount + delta)
        .clamp(loadedCount, 1 << 30)
        .toInt();
    ref.read(threadListPageMetadataProvider.notifier).state = {
      ...current,
      key: ThreadListPageMetadata(
        hasMore: totalCount > loadedCount,
        totalCount: totalCount,
        nextCursor: metadata.nextCursor,
      ),
    };
  }

  MapEntry<String, ThreadListPageMetadata>? _pageMetadataEntry(
    String workspacePath,
  ) {
    final normalized = normalizeProjectPath(workspacePath);
    for (final entry in ref.read(threadListPageMetadataProvider).entries) {
      if (normalizeProjectPath(entry.key) == normalized) return entry;
    }
    return null;
  }
}

class _ThreadListLiveEvent {
  const _ThreadListLiveEvent(this.envelope, this.live);

  final EcoEventEnvelope envelope;
  final ThreadLiveEvent live;
}

class _PendingThreadListUpsert {
  const _PendingThreadListUpsert({
    required this.thread,
    required this.countAsNew,
  });

  final ThreadSummary thread;
  final bool countAsNew;
}

List<ThreadSummary> _mergeThreadSummaries(
  List<ThreadSummary> current,
  List<ThreadSummary> incoming,
) {
  final merged = List<ThreadSummary>.of(current);
  final indexById = <String, int>{
    for (var index = 0; index < merged.length; index++) merged[index].id: index,
  };
  for (final thread in incoming) {
    final index = indexById[thread.id];
    if (index == null) {
      indexById[thread.id] = merged.length;
      merged.add(thread);
    } else {
      final currentThread = merged[index];
      final currentTime = threadActivityTimeMs(currentThread);
      final listedTime = threadActivityTimeMs(thread);
      if (listedTime >= currentTime) {
        merged[index] = mergeThreadSummaryFromRemoteList(
          current: currentThread,
          listed: thread,
        );
      }
    }
  }
  return merged;
}

final runtimeConfigProvider = StateProvider<ThreadRuntimeConfigInput?>(
  (ref) => null,
);

/// Wait for the bind channel, then run [fetch]. Re-subscribes on reconnect.
Future<T?> fetchDesktopSettingWhenReady<T>(
  Ref ref, {
  required Future<T> Function(DesktopRpc rpc) fetch,
}) async {
  final rpc = ref.watch(desktopRpcProvider);
  if (rpc == null) return null;

  final ready = await ensureDesktopBindReady(ref);
  if (!ready) {
    ref.listen(connectionStatusProvider, (previous, next) {
      next.whenData((status) {
        if (status.state != EcoConnectionState.connected) return;
        final wasConnected =
            previous?.valueOrNull?.state == EcoConnectionState.connected;
        if (!wasConnected) {
          ref.invalidateSelf();
        }
      });
    });
    throw EcoCenterException.app(EcoCenterErrorKind.websocketDisconnected);
  }

  return withDesktopRpcRetry(() => fetch(rpc));
}

final modelSettingsProvider = FutureProvider<ModelSettingsSnapshot?>((
  ref,
) async {
  final settings = await fetchDesktopSettingWhenReady(
    ref,
    fetch: (rpc) => rpc.getModelSettings(),
  );
  if (settings != null) {
    unawaited(warmGlobalSettingsDigestCache(ref));
  }
  return settings;
});

final candidateModelsProvider =
    FutureProvider.family<List<CandidateModelView>, String>((
      ref,
      providerId,
    ) async {
      final rpc = ref.watch(desktopRpcProvider);
      if (rpc == null || providerId.trim().isEmpty) return const [];
      return rpc.listCandidateModels(providerId);
    });

final cursorModelsProvider = FutureProvider<List<CursorModelOption>>((
  ref,
) async {
  final rpc = ref.watch(desktopRpcProvider);
  if (rpc == null) return const [];
  return rpc.listCursorModels();
});

final auxiliaryModelOptionsProvider =
    FutureProvider.family<List<CommitModelOptionView>, String>((
      ref,
      mainAgentConfigId,
    ) async {
      final rpc = ref.watch(desktopRpcProvider);
      if (rpc == null) return const [];
      final result = await rpc.listCommitModelOptions(
        mainAgentConfigId: mainAgentConfigId,
      );
      return result.options;
    });

final approvalModelOptionsProvider =
    FutureProvider.family<List<CommitModelOptionView>, String>((
      ref,
      mainAgentConfigId,
    ) async {
      ref.watch(modelSettingsProvider);
      final rpc = ref.watch(desktopRpcProvider);
      if (rpc == null) return const [];
      final result = await rpc.listApprovalModelOptions(
        mainAgentConfigId: mainAgentConfigId,
      );
      return result.options;
    });

final workflowSettingsProvider = FutureProvider<WorkflowSettingsSnapshot?>((
  ref,
) async {
  final settings = await fetchDesktopSettingWhenReady(
    ref,
    fetch: (rpc) => rpc.getWorkflowSettings(),
  );
  if (settings != null) {
    unawaited(warmGlobalSettingsDigestCache(ref));
  }
  return settings;
});

final integrationAvailabilityProvider =
    FutureProvider<IntegrationAvailabilitySnapshot?>((ref) async {
      final rpc = ref.watch(desktopRpcProvider);
      if (rpc == null) return null;
      return rpc.getIntegrationAvailability();
    });

final projectIntegrationsSettingsProvider =
    FutureProvider.family<ProjectIntegrationsSettingsSnapshot?, String>((
      ref,
      workspacePath,
    ) async {
      final rpc = ref.watch(desktopRpcProvider);
      if (rpc == null || workspacePath.trim().isEmpty) return null;
      return rpc.getProjectIntegrationsSettings(workspacePath);
    });

final mcpSettingsProvider = FutureProvider<McpSettingsSnapshot?>((ref) async {
  final modelSettings = await ref.watch(modelSettingsProvider.future);
  final embedded = modelSettings?.mcpSettings;
  if (embedded != null) {
    return embedded;
  }

  final rpc = ref.watch(desktopRpcProvider);
  if (rpc == null) return null;
  try {
    return await rpc.getMcpSettings();
  } catch (_) {
    return null;
  }
});

final composerSkillsProvider = FutureProvider.family<SkillsListResult?, String>(
  (ref, workspacePath) async {
    final rpc = ref.watch(desktopRpcProvider);
    if (rpc == null || workspacePath.trim().isEmpty) return null;
    try {
      return await rpc.listSkills(workspacePath);
    } catch (_) {
      return null;
    }
  },
);

final projectSkillsSettingsProvider =
    FutureProvider.family<ProjectSkillsSettingsSnapshot?, String>((
      ref,
      workspacePath,
    ) async {
      final rpc = ref.watch(desktopRpcProvider);
      if (rpc == null || workspacePath.trim().isEmpty) return null;
      try {
        return await rpc.getProjectSkillsSettings(workspacePath);
      } catch (_) {
        return null;
      }
    });

final projectOrchestrationSettingsProvider =
    FutureProvider.family<ProjectOrchestrationSettingsSnapshot?, String>((
      ref,
      workspacePath,
    ) async {
      final rpc = ref.watch(desktopRpcProvider);
      if (rpc == null || workspacePath.trim().isEmpty) return null;
      return rpc.getProjectOrchestrationSettings(workspacePath);
    });

ThreadRuntimeConfig defaultRuntimeConfig({
  ModelSettingsSnapshot? modelSettings,
  WorkflowSettingsSnapshot? workflow,
  List<McpServerConfigView>? mcpServers,
}) {
  return buildDefaultRuntimeConfig(
    modelSettings: modelSettings,
    workflow: workflow,
    mcpServers: mcpServers,
  );
}

String normalizeWorkspacePathKey(String workspacePath) {
  var normalized = workspacePath.trim();
  while (normalized.length > 1 && normalized.endsWith('/')) {
    normalized = normalized.substring(0, normalized.length - 1);
  }
  return normalized;
}

void refreshWorkspaceChanges(WidgetRef ref, String workspacePath) {
  if (workspacePath.isEmpty) return;
  ref
      .read(workspaceGitStatusPushProvider.notifier)
      .clearForWorkspace(workspacePath);
  ref.invalidate(gitStatusProvider(workspacePath));
  ref.invalidate(workspaceDiffProvider(workspacePath));
}

final workspaceGitStatusPushProvider =
    NotifierProvider<
      WorkspaceGitStatusPushNotifier,
      Map<String, WorkspaceChangesSummary>
    >(WorkspaceGitStatusPushNotifier.new);

class WorkspaceGitStatusPushNotifier
    extends Notifier<Map<String, WorkspaceChangesSummary>> {
  @override
  Map<String, WorkspaceChangesSummary> build() {
    ref.listen(ecoEventsProvider, (previous, next) {
      next.whenData(_handleEvent);
    });
    return const {};
  }

  void _handleEvent(EcoEventEnvelope event) {
    if (event.kind != 'workspace.git_status_changed') {
      return;
    }
    final payload = event.payload;
    if (payload is! Map<String, dynamic>) {
      return;
    }

    final workspacePath = payload['workspacePath'] as String?;
    if (workspacePath == null || workspacePath.trim().isEmpty) {
      return;
    }

    final summary = WorkspaceChangesSummary(
      fileCount: (payload['dirtyFileCount'] as num?)?.toInt() ?? 0,
      totalAdditions: (payload['insertions'] as num?)?.toInt() ?? 0,
      totalDeletions: (payload['deletions'] as num?)?.toInt() ?? 0,
    );
    final key = normalizeWorkspacePathKey(workspacePath);
    final current = state[key];
    if (current != null &&
        current.fileCount == summary.fileCount &&
        current.totalAdditions == summary.totalAdditions &&
        current.totalDeletions == summary.totalDeletions) {
      return;
    }
    state = {...state, key: summary};
  }

  void clearForWorkspace(String workspacePath) {
    final key = normalizeWorkspacePathKey(workspacePath);
    if (!state.containsKey(key)) {
      return;
    }
    final next = Map<String, WorkspaceChangesSummary>.from(state);
    next.remove(key);
    state = next;
  }
}

final workspacePillSummaryProvider =
    Provider.family<WorkspaceChangesSummary?, String>((ref, workspacePath) {
      if (workspacePath.isEmpty) {
        return null;
      }
      final key = normalizeWorkspacePathKey(workspacePath);
      final pushed = ref.watch(workspaceGitStatusPushProvider)[key];
      if (pushed != null) {
        return pushed;
      }
      return ref
          .watch(gitStatusProvider(workspacePath))
          .valueOrNull
          ?.toChangesSummary();
    });

final workspacePillLoadingProvider = Provider.family<bool, String>((
  ref,
  workspacePath,
) {
  if (workspacePath.isEmpty) {
    return false;
  }
  final key = normalizeWorkspacePathKey(workspacePath);
  if (ref.watch(workspaceGitStatusPushProvider).containsKey(key)) {
    return false;
  }
  final gitAsync = ref.watch(gitStatusProvider(workspacePath));
  return gitAsync.isLoading || gitAsync.isReloading;
});

final workspaceDiffProvider =
    FutureProvider.family<WorkspaceDiffResult?, String>((
      ref,
      workspacePath,
    ) async {
      if (workspacePath.isEmpty) return null;
      final rpc = ref.watch(desktopRpcProvider);
      if (rpc == null) return null;

      try {
        final diff = await rpc.getWorkspaceDiff(workspacePath);
        return diff.hasChanges ? diff : null;
      } catch (_) {
        return null;
      }
    });

final gitStatusProvider = FutureProvider.family<GitWorkingTreeStatus?, String>((
  ref,
  workspacePath,
) async {
  if (workspacePath.isEmpty) return null;
  final rpc = ref.watch(desktopRpcProvider);
  if (rpc == null) return null;

  try {
    return await rpc.getGitStatus(workspacePath);
  } catch (_) {
    return null;
  }
});

class ActivityItem {
  const ActivityItem({
    required this.id,
    required this.role,
    required this.message,
    this.stream = false,
    this.agentId,
    this.apiError,
    this.tool,
  });

  final String id;
  final String role;
  final String message;
  final bool stream;
  final String? agentId;
  final ThreadApiErrorInfo? apiError;
  final ThreadRunToolMetadata? tool;
}

class ThreadSessionState {
  const ThreadSessionState({
    this.pendingPlan,
    this.pendingBash,
    this.pendingClarification,
    this.followUps = const [],
    this.loading = true,
    this.error,
    this.thread,
    this.titleGenerating = false,
    this.runProjection,
    this.subagentSessions = const [],
    this.billing,
    this.contextSnapshot,
    this.composerRestore,
    this.projectionSettled = false,
    this.projectionSynchronizing = false,
  });

  final ThreadPendingPlan? pendingPlan;
  final BashApprovalRequest? pendingBash;
  final ClarificationRequest? pendingClarification;
  final List<ThreadPendingFollowUp> followUps;
  final bool loading;
  final String? error;
  final ThreadSummary? thread;

  /// Desktop is currently auto-generating this session's title.
  final bool titleGenerating;
  final ThreadRunProjectionSnapshot? runProjection;
  final List<ThreadSubagentSessionTiming> subagentSessions;
  final ThreadBillingSnapshot? billing;
  final ThreadContextSnapshot? contextSnapshot;
  final ComposerRestore? composerRestore;

  /// Local desktop RPC for Feed projection has completed at least once.
  final bool projectionSettled;

  /// Incremental resync / initial RPC is in flight (local load path).
  final bool projectionSynchronizing;

  ThreadSessionState copyWith({
    ThreadPendingPlan? pendingPlan,
    bool clearPlan = false,
    BashApprovalRequest? pendingBash,
    bool clearBash = false,
    ClarificationRequest? pendingClarification,
    bool clearClarification = false,
    List<ThreadPendingFollowUp>? followUps,
    bool? loading,
    String? error,
    ThreadSummary? thread,
    bool? titleGenerating,
    ThreadRunProjectionSnapshot? runProjection,
    bool clearProjection = false,
    List<ThreadSubagentSessionTiming>? subagentSessions,
    ThreadBillingSnapshot? billing,
    bool clearBilling = false,
    ThreadContextSnapshot? contextSnapshot,
    bool clearContext = false,
    ComposerRestore? composerRestore,
    bool clearComposerRestore = false,
    bool? projectionSettled,
    bool? projectionSynchronizing,
  }) {
    return ThreadSessionState(
      pendingPlan: clearPlan ? null : (pendingPlan ?? this.pendingPlan),
      pendingBash: clearBash ? null : (pendingBash ?? this.pendingBash),
      pendingClarification: clearClarification
          ? null
          : (pendingClarification ?? this.pendingClarification),
      followUps: followUps ?? this.followUps,
      loading: loading ?? this.loading,
      error: error,
      thread: thread ?? this.thread,
      titleGenerating: titleGenerating ?? this.titleGenerating,
      runProjection: clearProjection
          ? null
          : (runProjection ?? this.runProjection),
      subagentSessions: subagentSessions ?? this.subagentSessions,
      billing: clearBilling ? null : (billing ?? this.billing),
      contextSnapshot: clearContext
          ? null
          : (contextSnapshot ?? this.contextSnapshot),
      composerRestore: clearComposerRestore
          ? null
          : (composerRestore ?? this.composerRestore),
      projectionSettled: projectionSettled ?? this.projectionSettled,
      projectionSynchronizing:
          projectionSynchronizing ?? this.projectionSynchronizing,
    );
  }
}

final threadSessionProvider = StateNotifierProvider.autoDispose
    .family<ThreadSessionNotifier, ThreadSessionState, String>(
      (ref, threadId) => ThreadSessionNotifier(threadId, ref),
    );

class ThreadSessionNotifier extends StateNotifier<ThreadSessionState> {
  ThreadSessionNotifier(this.threadId, this.ref)
    : super(const ThreadSessionState()) {
    _init();
  }

  final String threadId;
  final Ref ref;
  bool _centerConnectionWasInterrupted = false;
  bool _selectedDesktopWasOffline = false;
  bool _projectionSynchronized = false;
  int _followUpQueuePauseRevision = 0;
  int _threadLiveRevision = 0;
  int get followUpQueuePauseRevision => _followUpQueuePauseRevision;
  Future<ThreadSummary?>? _threadLoadInFlight;

  String get _composerDraftContextKey => 'thread:$threadId';

  /// Fills in a missing thread summary. Bootstrap can leave `thread` null
  /// after a transient bind failure (nothing re-fetches it unless the
  /// connection state changes), which leaves the session chrome — title,
  /// workspace, runtime config — blank forever even though the feed loads.
  Future<void> ensureThreadLoaded() async {
    if (!mounted || state.thread != null) {
      return;
    }
    final inFlight = _threadLoadInFlight;
    if (inFlight != null) {
      await inFlight;
      return;
    }
    final rpc = ref.read(desktopRpcProvider);
    if (rpc == null) {
      return;
    }

    Future<ThreadSummary?> fetchThread() async {
      try {
        return await rpc.getThread(threadId);
      } catch (_) {
        return null;
      }
    }

    final request = fetchThread().then((thread) {
      _threadLoadInFlight = null;
      if (!mounted || thread == null) {
        return;
      }
      state = state.copyWith(thread: thread);
      if (thread.titleGenerating) {
        state = state.copyWith(titleGenerating: true);
      }
      final runtimeConfig = thread.runtimeConfig;
      if (runtimeConfig != null && ref.read(runtimeConfigProvider) == null) {
        ref.read(runtimeConfigProvider.notifier).state = runtimeConfig;
      }
      ref
          .read(threadListProvider.notifier)
          .upsertThread(thread, countAsNew: false);
    });
    _threadLoadInFlight = request;
    await request;
  }

  void _markProjectionSyncStarted() {
    if (!mounted || state.projectionSynchronizing) {
      return;
    }
    state = state.copyWith(projectionSynchronizing: true);
  }

  void _markProjectionSyncFinished({required bool settled}) {
    if (!mounted) {
      return;
    }
    state = state.copyWith(
      projectionSynchronizing: false,
      projectionSettled: settled || state.projectionSettled,
    );
  }

  ComposerRestore? _composerRestoreFromDraft(ComposerDraftRecord? draft) {
    if (draft == null || draft.recoveryReason?.trim().isNotEmpty != true) {
      return null;
    }
    return ComposerRestore(
      prompt: draft.prompt,
      attachments: draft.attachments,
      revision: draft.revision,
      reason: draft.recoveryReason,
    );
  }

  Future<void> recoverProjection({bool rethrowOnError = false}) async {
    if (!mounted) {
      return;
    }
    _markProjectionSyncStarted();
    try {
      final controller = ref.read(
        conversationV2SessionProvider(threadId).notifier,
      );
      final v2State = ref.read(conversationV2SessionProvider(threadId));
      if (v2State.syncState == ConversationV2SyncState.uninitialized) {
        await controller.start();
      } else {
        await controller.refresh();
      }
      _projectionSynchronized = true;
    } catch (error) {
      if (rethrowOnError) rethrow;
    } finally {
      _markProjectionSyncFinished(settled: true);
    }
  }

  Future<void> acceptRewrittenThread(ThreadSummary thread) async {
    await _acceptHistoryCommandThread(thread);
  }

  Future<void> acceptRetriedThread(ThreadSummary thread) async {
    await _acceptHistoryCommandThread(thread);
  }

  Future<void> _acceptHistoryCommandThread(ThreadSummary thread) async {
    if (!mounted) return;
    state = state.copyWith(
      thread: thread,
      clearPlan: true,
      clearBash: true,
      clearClarification: true,
      clearProjection: true,
      projectionSettled: false,
      projectionSynchronizing: true,
    );
    ref
        .read(threadListProvider.notifier)
        .upsertThread(thread, countAsNew: false);
    await recoverProjection(rethrowOnError: true);
  }

  Future<void> _init() async {
    ref.listen(ecoEventsProvider, (previous, next) {
      next.whenData(_handleEvent);
    });

    ref.listen(connectionStatusProvider, (_, next) {
      next.whenData((status) {
        if (status.state == EcoConnectionState.disconnected ||
            status.state == EcoConnectionState.error) {
          _centerConnectionWasInterrupted = true;
          _projectionSynchronized = false;
          return;
        }
        if (status.state != EcoConnectionState.connected) {
          return;
        }
        if (!_centerConnectionWasInterrupted && _projectionSynchronized) {
          return;
        }
        final needsFullBootstrap =
            _centerConnectionWasInterrupted && !_projectionSynchronized;
        _centerConnectionWasInterrupted = false;
        if (needsFullBootstrap) {
          unawaited(_bootstrapSession());
          return;
        }
        if (state.thread == null) {
          unawaited(ensureThreadLoaded());
        }
        unawaited(_refreshFollowUpsFromRpc());
        unawaited(_refreshComposerDraftFromRpc());
        unawaited(recoverProjection());
      });
    });

    await _bootstrapSession();
  }

  Future<void> _bootstrapSession() async {
    final rpc = ref.read(desktopRpcProvider);
    if (rpc == null) {
      if (!mounted) return;
      state = state.copyWith(
        loading: false,
        error: threadNoPcSelectedErrorCode,
        projectionSynchronizing: false,
      );
      return;
    }

    final seed = ref.read(threadSessionSeedProvider);
    ThreadSummary? seededThread;
    if (seed != null && seed.id == threadId) {
      seededThread = seed;
      // The synchronous prefix of this method runs while the session provider is
      // being initialized (constructor → `_init`), so writing another provider
      // here trips Riverpod's "Providers are not allowed to modify other
      // providers during their initialization" assertion in debug builds. The
      // resulting async error aborts bootstrap before the Feed RPC, so a session
      // handed off from the landing composer (the user's own new message) never
      // loads its projection and the user prompt never renders. Clear the seed on
      // the next microtask instead, which leaves the build phase first.
      scheduleMicrotask(() {
        if (!mounted) return;
        if (ref.read(threadSessionSeedProvider)?.id == threadId) {
          ref.read(threadSessionSeedProvider.notifier).state = null;
        }
      });
    }
    final cachedThread = seededThread ?? state.thread ?? _threadFromCacheSync();
    if (cachedThread != null) {
      // Show session chrome immediately; bootstrap continues below.
      state = state.copyWith(
        thread: cachedThread,
        loading: false,
        projectionSynchronizing: true,
      );
    } else if (!state.projectionSynchronizing) {
      state = state.copyWith(loading: true, projectionSynchronizing: true);
    }

    // Wait for Realtime bind before any Desktop RPC — keeps the boot overlay
    // up instead of flashing "Realtime not connected" after a PC switch.
    final ready = await ensureDesktopBindReady(ref);
    if (!mounted) return;
    if (!ready) {
      _centerConnectionWasInterrupted = true;
      state = state.copyWith(
        thread: cachedThread ?? state.thread,
        loading: false,
        projectionSynchronizing: true,
      );
      return;
    }

    try {
      // Session bootstrap supplies chrome and pending interactions. The ordered
      // feed, billing, context and subagent facts are owned by the V2 session
      // provider and never come from a legacy projection RPC.
      final threadRevision = _threadLiveRevision;
      final bootstrap = await rpc.sessionBootstrap(threadId);
      _projectionSynchronized = true;
      final loadedThread =
          bootstrap.thread ?? cachedThread ?? await rpc.getThread(threadId);
      final thread =
          threadRevision != _threadLiveRevision && state.thread != null
          ? state.thread
          : loadedThread;
      final loadedFollowUps = _mergeThreadFollowUps(
        bootstrap.followUps,
        state.followUps,
      );

      state = ThreadSessionState(
        pendingPlan: bootstrap.pendingPlan,
        pendingBash: bootstrap.pendingBash,
        pendingClarification: bootstrap.pendingClarification,
        followUps: loadedFollowUps,
        thread: thread ?? state.thread,
        titleGenerating: thread?.titleGenerating ?? state.titleGenerating,
        runProjection: null,
        subagentSessions: const [],
        billing: null,
        contextSnapshot: null,
        composerRestore: state.composerRestore,
        loading: false,
        projectionSettled: true,
        projectionSynchronizing: false,
      );
      final bootstrappedRuntimeConfig = thread?.runtimeConfig;
      if (bootstrappedRuntimeConfig != null &&
          ref.read(runtimeConfigProvider) == null) {
        ref.read(runtimeConfigProvider.notifier).state =
            bootstrappedRuntimeConfig;
      }
      if (thread?.status == 'awaiting_plan' && bootstrap.pendingPlan == null) {
        _loadPendingPlanFromRpc();
      }
      unawaited(_refreshComposerDraftFromRpc());
    } catch (error) {
      if (!mounted) return;
      if (isTransientDesktopBindError(error)) {
        _centerConnectionWasInterrupted = true;
        state = state.copyWith(loading: false, projectionSynchronizing: true);
        return;
      }
      state = state.copyWith(
        loading: false,
        error: error.toString(),
        projectionSynchronizing: false,
      );
    }
  }

  void _handleEvent(EcoEventEnvelope event) {
    if (event.kind == 'conversation.sync_effect' ||
        event.kind == 'conversation.projection_extras') {
      // Conversation V2 owns the ordered feed and projection extras. The
      // legacy session parser must never consume these notifications.
      return;
    }
    final payload = event.payload;
    if (payload is! Map<String, dynamic>) return;
    if (_handleSelectedDesktopPresenceEvent(event, payload)) {
      return;
    }
    final live = ThreadLiveEvent.fromJson(payload);
    final eventThreadId = resolveThreadEventThreadId(
      envelopeThreadId: event.threadId,
      payloadThreadId: live.threadId,
    );
    if (eventThreadId != threadId) return;

    // A live event for this thread proves the desktop knows the thread even
    // when our bootstrap missed it — recover the missing summary so the
    // session chrome (title etc.) is not left blank.
    if (state.thread == null) {
      unawaited(ensureThreadLoaded());
    }

    if (live.followUpQueuePaused != null) _followUpQueuePauseRevision += 1;
    if (live.followUpQueuePaused != null ||
        shouldUpdateThreadSummaryFromLiveEvent(live.type)) {
      _threadLiveRevision += 1;
    }

    if (isFollowUpThreadLiveEvent(
      kind: event.kind,
      liveType: live.type,
      hasFollowUp: live.followUp != null,
    )) {
      if (live.followUp != null) {
        state = state.copyWith(
          followUps: mergeThreadFollowUp(state.followUps, live.followUp!),
        );
      }
      unawaited(_refreshFollowUpsFromRpc());
    }

    if (live.composerRestore != null) {
      state = state.copyWith(composerRestore: live.composerRestore);
    }

    final updatedTitle = live.title?.trim();
    if (updatedTitle != null &&
        updatedTitle.isNotEmpty &&
        state.thread != null &&
        state.thread!.title != updatedTitle) {
      state = state.copyWith(
        thread: state.thread!.copyWith(title: updatedTitle),
      );
    }

    final titleGenerating = live.titleGenerating;
    if (titleGenerating != null && titleGenerating != state.titleGenerating) {
      state = state.copyWith(titleGenerating: titleGenerating);
    }

    if (live.runtimeConfig != null) {
      final config = live.runtimeConfig!;
      if (state.thread != null) {
        state = state.copyWith(
          thread: state.thread!.copyWith(runtimeConfig: config),
        );
      }
      ref.read(runtimeConfigProvider.notifier).state = config;
      if (config.mcpServersEnabled != null) {
        ref.invalidate(workflowSettingsProvider);
      }
    }

    if (shouldUpdateThreadSummaryFromLiveEvent(live.type) &&
        state.thread != null) {
      final thread = state.thread!;
      state = state.copyWith(
        thread: thread.copyWith(
          status: threadStatusFromLiveEvent(live.type, thread.status),
          message: resolveThreadMessageFromLiveEvent(live.type, live.message),
          updatedAt: DateTime.now().toUtc().toIso8601String(),
          runtimeConfig: live.runtimeConfig ?? thread.runtimeConfig,
          cancelling: resolveThreadCancellingFromLiveEvent(
            nextStatus: threadStatusFromLiveEvent(live.type, thread.status),
            currentCancelling: thread.cancelling,
            eventCancelling: live.cancelling,
          ),
          followUpQueuePaused:
              live.followUpQueuePaused ?? thread.followUpQueuePaused,
        ),
      );
    } else if (live.followUpQueuePaused != null && state.thread != null) {
      state = state.copyWith(
        thread: state.thread!.copyWith(
          followUpQueuePaused: live.followUpQueuePaused,
          updatedAt: DateTime.now().toUtc().toIso8601String(),
        ),
      );
    }

    if (event.kind == 'thread.plan') {
      if (live.type == 'thread.plan_cleared' ||
          live.type == 'thread.completed' ||
          live.type == 'plan_approval.denied') {
        state = state.copyWith(clearPlan: true);
      } else if (live.type == 'thread.awaiting_plan' ||
          live.type == 'thread.execution_failed' ||
          live.type == 'plan_approval.requested') {
        if (live.plan != null) {
          state = state.copyWith(pendingPlan: live.plan);
        }
        _loadPendingPlanFromRpc();
      }
    }
    if (event.kind == 'thread.bash_approval') {
      ref.read(desktopRpcProvider)?.getPendingBashApproval(threadId).then((
        bash,
      ) {
        if (!mounted) return;
        state = state.copyWith(pendingBash: bash, clearBash: bash == null);
      });
    }
    if (event.kind == 'thread.clarification') {
      ref.read(desktopRpcProvider)?.getPendingClarification(threadId).then((
        clarification,
      ) {
        if (!mounted) return;
        state = state.copyWith(
          pendingClarification: clarification,
          clearClarification: clarification == null,
        );
      });
    }
  }

  bool _handleSelectedDesktopPresenceEvent(
    EcoEventEnvelope event,
    Map<String, dynamic> payload,
  ) {
    if (event.kind != presenceDeviceEventKind) {
      return false;
    }
    final selectedDesktopId = ref.read(selectedDesktopIdProvider);
    final rawOnlineDeviceIds = payload['onlineDeviceIds'];
    if (selectedDesktopId == null || rawOnlineDeviceIds is! List) {
      return true;
    }
    final selectedDesktopOnline = rawOnlineDeviceIds
        .whereType<String>()
        .contains(selectedDesktopId);
    if (!selectedDesktopOnline) {
      _selectedDesktopWasOffline = true;
      _projectionSynchronized = false;
      return true;
    }
    if (_selectedDesktopWasOffline || !_projectionSynchronized) {
      _selectedDesktopWasOffline = false;
      unawaited(_refreshFollowUpsFromRpc());
      unawaited(_refreshComposerDraftFromRpc());
      unawaited(recoverProjection());
    }
    return true;
  }

  Future<void> refreshComposerRestore() => _refreshComposerDraftFromRpc();

  Future<void> refreshFollowUps() => _refreshFollowUpsFromRpc();

  void applyFollowUpQueuePaused(bool paused, {required int expectedRevision}) {
    if (expectedRevision != _followUpQueuePauseRevision) return;
    final thread = state.thread;
    if (thread == null) return;
    state = state.copyWith(
      thread: thread.copyWith(followUpQueuePaused: paused),
    );
  }

  void applyThreadSummary(ThreadSummary thread) {
    state = state.copyWith(thread: thread);
    ref
        .read(threadListProvider.notifier)
        .upsertThread(thread, countAsNew: false);
  }

  Future<void> _refreshComposerDraftFromRpc() async {
    final rpc = ref.read(desktopRpcProvider);
    if (rpc == null) return;
    try {
      final draft = await rpc.getComposerDraft(_composerDraftContextKey);
      if (!mounted) return;
      final restore = _composerRestoreFromDraft(draft);
      state = state.copyWith(
        composerRestore: restore,
        clearComposerRestore: restore == null,
      );
    } catch (_) {
      if (!mounted) return;
    }
  }

  Future<bool> acknowledgeComposerRestore(String expectedRevision) async {
    final revision = expectedRevision.trim();
    if (revision.isEmpty) {
      return false;
    }
    final current = state.composerRestore;
    if (current == null || current.revision != revision) {
      return false;
    }
    final rpc = ref.read(desktopRpcProvider);
    if (rpc == null) return false;
    final deleted = await rpc.deleteComposerDraft(
      contextKey: _composerDraftContextKey,
      expectedRevision: revision,
    );
    if (!mounted) return deleted;
    if (deleted && state.composerRestore?.revision == revision) {
      state = state.copyWith(clearComposerRestore: true);
    } else if (!deleted) {
      await _refreshComposerDraftFromRpc();
    }
    return deleted;
  }

  Future<void> _refreshFollowUpsFromRpc() async {
    final rpc = ref.read(desktopRpcProvider);
    if (rpc == null) return;
    try {
      final followUps = await rpc.followUpList(threadId);
      if (!mounted) return;
      state = state.copyWith(
        followUps: mergeThreadFollowUps(state.followUps, followUps),
      );
    } catch (error) {
      if (!mounted) return;
      state = state.copyWith(error: error.toString());
    }
  }

  ThreadSummary? _threadFromCacheSync() {
    final cached = ref.read(threadListProvider).valueOrNull;
    if (cached == null) return null;
    for (final candidate in cached) {
      if (candidate.id == threadId) {
        return candidate;
      }
    }
    return null;
  }

  Future<ThreadSummary?> _resolveThreadSummary(DesktopRpc rpc) async {
    final cached = _threadFromCacheSync();
    if (cached?.runtimeConfig != null) return cached;
    return rpc.getThread(threadId);
  }

  Future<void> refreshPending() async {
    final rpc = ref.read(desktopRpcProvider);
    if (rpc == null) return;
    final threadRevision = _threadLiveRevision;
    final bootstrap = await rpc.sessionBootstrap(threadId);
    final loadedThread = bootstrap.thread ?? await _resolveThreadSummary(rpc);
    final pendingPlan =
        bootstrap.pendingPlan ?? await rpc.getPendingPlan(threadId);
    if (!mounted) return;
    final thread = threadRevision != _threadLiveRevision && state.thread != null
        ? state.thread
        : loadedThread;
    state = state.copyWith(
      pendingPlan: pendingPlan,
      clearPlan: pendingPlan == null,
      pendingBash: bootstrap.pendingBash,
      clearBash: bootstrap.pendingBash == null,
      pendingClarification: bootstrap.pendingClarification,
      clearClarification: bootstrap.pendingClarification == null,
      followUps: mergeThreadFollowUps(state.followUps, bootstrap.followUps),
      thread: thread ?? state.thread,
      clearBilling: true,
      clearContext: true,
    );
    unawaited(
      ref
          .read(conversationV2SessionProvider(threadId).notifier)
          .reloadProjectionExtras(),
    );
  }

  Future<void> approvePlan() async {
    final rpc = ref.read(desktopRpcProvider);
    if (rpc == null) return;
    final principalId = ref
        .read(credentialsProvider)
        .valueOrNull
        ?.userId
        ?.trim();
    if (principalId == null || principalId.isEmpty) {
      throw StateError('A signed-in principal is required to approve a plan.');
    }
    final expectedHistoryRevision = state.runProjection?.historyRevision ?? 0;
    await rpc.approvePlan(
      principalId: principalId,
      clientCommandId:
          'plan_resolve_${conversationV2StableHash({'threadId': threadId, 'resolution': 'approve', 'expectedHistoryRevision': expectedHistoryRevision})}',
      threadId: threadId,
      expectedHistoryRevision: expectedHistoryRevision,
    );
    state = state.copyWith(clearPlan: true);
  }

  Future<void> dismissPlan() async {
    final rpc = ref.read(desktopRpcProvider);
    if (rpc == null) return;
    final principalId = ref
        .read(credentialsProvider)
        .valueOrNull
        ?.userId
        ?.trim();
    if (principalId == null || principalId.isEmpty) {
      throw StateError('A signed-in principal is required to dismiss a plan.');
    }
    final expectedHistoryRevision = state.runProjection?.historyRevision ?? 0;
    await rpc.dismissPlan(
      principalId: principalId,
      clientCommandId:
          'plan_resolve_${conversationV2StableHash({'threadId': threadId, 'resolution': 'dismiss', 'expectedHistoryRevision': expectedHistoryRevision})}',
      threadId: threadId,
      expectedHistoryRevision: expectedHistoryRevision,
    );
    state = state.copyWith(clearPlan: true);
  }

  void _loadPendingPlanFromRpc() {
    ref.read(desktopRpcProvider)?.getPendingPlan(threadId).then((plan) {
      if (!mounted) return;
      if (plan != null) {
        state = state.copyWith(pendingPlan: plan);
      }
    });
  }

  Future<void> resolveBash(
    String toolUseId,
    String decision, {
    String? feedback,
  }) async {
    final rpc = ref.read(desktopRpcProvider);
    if (rpc == null) {
      state = state.copyWith(clearBash: true);
      return;
    }
    final principalId = ref
        .read(credentialsProvider)
        .valueOrNull
        ?.userId
        ?.trim();
    if (principalId == null || principalId.isEmpty) {
      throw StateError(
        'A signed-in principal is required to resolve a Bash approval.',
      );
    }
    final expectedHistoryRevision = state.runProjection?.historyRevision ?? 0;
    final normalizedFeedback = feedback?.trim();
    await rpc.resolveBashApproval(
      principalId: principalId,
      clientCommandId:
          'approval_resolve_${conversationV2StableHash({'threadId': threadId, 'toolUseId': toolUseId, 'decision': decision, 'feedback': normalizedFeedback == null || normalizedFeedback.isEmpty ? null : normalizedFeedback, 'expectedHistoryRevision': expectedHistoryRevision})}',
      threadId: threadId,
      toolUseId: toolUseId,
      decision: decision,
      feedback: normalizedFeedback,
      expectedHistoryRevision: expectedHistoryRevision,
    );
    if (!mounted) return;
    BashApprovalRequest? next;
    try {
      next = await rpc.getPendingBashApproval(threadId);
    } catch (_) {
      next = null;
    }
    if (!mounted) return;
    // Drop the card we just acted on; surface any remaining parked approvals.
    if (next != null && next.toolUseId == toolUseId) {
      next = null;
    }
    state = state.copyWith(pendingBash: next, clearBash: next == null);
  }

  Future<void> submitClarification(
    String toolUseId,
    List<List<String>> selections,
  ) async {
    final rpc = ref.read(desktopRpcProvider);
    final principalId = ref
        .read(credentialsProvider)
        .valueOrNull
        ?.userId
        ?.trim();
    if (principalId == null || principalId.isEmpty) {
      throw StateError(
        'A signed-in principal is required to resolve a clarification.',
      );
    }
    final expectedHistoryRevision = state.runProjection?.historyRevision ?? 0;
    await rpc?.submitClarification(
      principalId: principalId,
      clientCommandId:
          'clarification_resolve_${conversationV2StableHash({'threadId': threadId, 'toolUseId': toolUseId, 'resolution': 'submit', 'selections': selections, 'expectedHistoryRevision': expectedHistoryRevision})}',
      threadId: threadId,
      toolUseId: toolUseId,
      selections: selections,
      expectedHistoryRevision: expectedHistoryRevision,
    );
    if (rpc == null) {
      state = state.copyWith(clearClarification: true);
      return;
    }
    final clarification = await rpc.getPendingClarification(threadId);
    if (!mounted) return;
    state = state.copyWith(
      pendingClarification: clarification,
      clearClarification: clarification == null,
    );
  }

  Future<void> dismissClarification(String toolUseId) async {
    final rpc = ref.read(desktopRpcProvider);
    final principalId = ref
        .read(credentialsProvider)
        .valueOrNull
        ?.userId
        ?.trim();
    if (principalId == null || principalId.isEmpty) {
      throw StateError(
        'A signed-in principal is required to resolve a clarification.',
      );
    }
    final expectedHistoryRevision = state.runProjection?.historyRevision ?? 0;
    await rpc?.dismissClarification(
      principalId: principalId,
      clientCommandId:
          'clarification_resolve_${conversationV2StableHash({'threadId': threadId, 'toolUseId': toolUseId, 'resolution': 'dismiss', 'expectedHistoryRevision': expectedHistoryRevision})}',
      threadId: threadId,
      toolUseId: toolUseId,
      expectedHistoryRevision: expectedHistoryRevision,
    );
    if (!mounted) return;
    state = state.copyWith(clearClarification: true);
  }
}

/// Legacy compatibility helper retained for older error surfaces outside the
/// V2 approval command path.
@visibleForTesting
bool isStalePendingBashApprovalError(Object error) {
  final message = error is EcoCenterException
      ? (error.nativeMessage ?? error.message)
      : error.toString();
  final trimmed = message.trim();
  if (trimmed.isEmpty) return false;
  return trimmed == 'No pending Bash approval for this tool use.' ||
      trimmed == 'No pending approval request was found.' ||
      trimmed == '找不到待处理的审批请求。' ||
      trimmed.contains('No pending Bash approval') ||
      trimmed.contains('pendingApprovalNotFound');
}

List<ThreadPendingFollowUp> _mergeThreadFollowUps(
  List<ThreadPendingFollowUp> base,
  List<ThreadPendingFollowUp> overlay,
) {
  return mergeThreadFollowUps(base, overlay);
}

bool _isThreadListLiveEvent(ThreadLiveEvent live) {
  if (live.type == 'thread.deleted') return true;
  if (live.title?.trim().isNotEmpty == true) return true;
  if (live.runtimeConfig != null) return true;
  if (live.followUpQueuePaused != null) return true;
  if (live.type == 'thread.follow_up_queue_paused' ||
      live.type == 'thread.follow_up_queue_resumed') {
    return true;
  }
  return shouldUpdateThreadSummaryFromLiveEvent(live.type);
}
