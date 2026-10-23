import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models/conversation_v2_models.dart';
import '../models/thread_models.dart';
import '../storage/conversation_v2_cache.dart';
import 'conversation_v2_sync_engine.dart';

/// Thinking/tool-writing starts have no visible message body. Refresh their
/// presentation facts at boundaries without adding an RPC for every token.
bool _refreshesProjectionExtras(Map effect) {
  final type = effect['type'];
  if (type == 'noop') {
    return effect['reason'] == 'runtime.thinking.changed' ||
        effect['reason'] == 'runtime.tool_writing.changed';
  }
  return type == 'message.create' ||
      type == 'tool.summary.upsert' ||
      type == 'run.upsert';
}

/// Existing thread actions exposed to the V2 session without duplicating the
/// desktop command implementation. The provider wires these callbacks to the
/// mature ThreadSessionNotifier methods during the migration window.
class ConversationV2InteractionActions {
  const ConversationV2InteractionActions({
    required this.resolveBash,
    required this.approvePlan,
    required this.dismissPlan,
    required this.submitClarification,
    required this.dismissClarification,
  });

  final Future<void> Function(
    String toolUseId,
    String decision, {
    String? feedback,
  })
  resolveBash;
  final Future<void> Function() approvePlan;
  final Future<void> Function() dismissPlan;
  final Future<void> Function(
    String toolUseId,
    List<List<String>> selections, {
    List<int>? customInputIndices,
  })
  submitClarification;
  final Future<void> Function(String toolUseId) dismissClarification;
}

class ConversationV2SessionState {
  const ConversationV2SessionState({
    this.messages = const [],
    this.runs = const [],
    this.tools = const [],
    this.agents = const [],
    this.todos = const [],
    this.projectionExtras,
    this.syncState = ConversationV2SyncState.uninitialized,
    this.hasOlder = false,
    this.historyRevision = 0,
    this.details = const [],
    this.pendingBash,
    this.pendingPlan,
    this.pendingClarification,
    Object? error,
    this.pendingInteractionsError,
  }) : _error = error;

  final List<ConversationV2Message> messages;
  final List<ConversationV2Run> runs;
  final List<ConversationV2Tool> tools;

  /// The agents the conversation ran. The Feed needs them to know that a row belongs to an
  /// agent's card: inferring ownership from tool rows loses narrated-only agents and puts
  /// their rows in the main Feed.
  final List<ConversationV2Agent> agents;
  final List<ConversationV2Todo> todos;
  final ConversationV2ProjectionExtras? projectionExtras;
  final ConversationV2SyncState syncState;
  final bool hasOlder;
  final int historyRevision;
  final List<ConversationV2Detail> details;
  final BashApprovalRequest? pendingBash;
  final ThreadPendingPlan? pendingPlan;
  final ClarificationRequest? pendingClarification;
  final Object? _error;
  final Object? pendingInteractionsError;
  Object? get error => _error ?? pendingInteractionsError;

  ConversationV2SessionState copyWith({
    List<ConversationV2Message>? messages,
    List<ConversationV2Run>? runs,
    List<ConversationV2Tool>? tools,
    List<ConversationV2Agent>? agents,
    List<ConversationV2Todo>? todos,
    ConversationV2ProjectionExtras? projectionExtras,
    ConversationV2SyncState? syncState,
    bool? hasOlder,
    int? historyRevision,
    List<ConversationV2Detail>? details,
    BashApprovalRequest? pendingBash,
    ThreadPendingPlan? pendingPlan,
    ClarificationRequest? pendingClarification,
    bool clearPendingInteractions = false,
    bool replacePendingInteractions = false,
    Object? error,
    bool clearError = false,
    Object? pendingInteractionsError,
    bool clearPendingInteractionsError = false,
  }) {
    return ConversationV2SessionState(
      messages: messages ?? this.messages,
      runs: runs ?? this.runs,
      tools: tools ?? this.tools,
      agents: agents ?? this.agents,
      todos: todos ?? this.todos,
      projectionExtras: projectionExtras ?? this.projectionExtras,
      syncState: syncState ?? this.syncState,
      hasOlder: hasOlder ?? this.hasOlder,
      historyRevision: historyRevision ?? this.historyRevision,
      details: details ?? this.details,
      pendingBash: replacePendingInteractions
          ? pendingBash
          : clearPendingInteractions
          ? null
          : (pendingBash ?? this.pendingBash),
      pendingPlan: replacePendingInteractions
          ? pendingPlan
          : clearPendingInteractions
          ? null
          : (pendingPlan ?? this.pendingPlan),
      pendingClarification: replacePendingInteractions
          ? pendingClarification
          : clearPendingInteractions
          ? null
          : (pendingClarification ?? this.pendingClarification),
      error: clearError ? null : (error ?? _error),
      pendingInteractionsError: clearPendingInteractionsError
          ? null
          : (pendingInteractionsError ?? this.pendingInteractionsError),
    );
  }
}

/// UI-facing wrapper around the transactional V2 cache and sync engine.
/// Messages, runs, tools and detail pages all come from this controller's V2
/// state; no legacy projection is consulted for rendering or recovery.
class ConversationV2SessionController
    extends StateNotifier<ConversationV2SessionState> {
  ConversationV2SessionController({
    required this.conversationId,
    required ConversationV2Cache cache,
    required ConversationV2Remote remote,
    this.actions,
    this.loadPendingInteractions,
    this.enabled = true,
    bool closeCacheOnClose = true,
  }) : _cache = cache,
       _closeCacheOnClose = closeCacheOnClose,
       _engine = ConversationV2SyncEngine(cache: cache, remote: remote),
       super(const ConversationV2SessionState()) {
    _stateSubscription = _engine.states.listen((syncState) {
      unawaited(
        _reload(syncState: syncState).catchError((error, _) {
          if (_disposed) return;
          _update(state.copyWith(syncState: syncState, error: error));
        }),
      );
    });
  }

  final String conversationId;
  final bool enabled;
  final ConversationV2InteractionActions? actions;

  /// The desktop's live pending registry owns actionable requests. Historical
  /// detail rows contain display summaries, not complete permission requests.
  final Future<ConversationV2PendingInteractions> Function()?
  loadPendingInteractions;
  final ConversationV2Cache _cache;
  final bool _closeCacheOnClose;
  final ConversationV2SyncEngine _engine;
  late final StreamSubscription<ConversationV2SyncState> _stateSubscription;
  bool _disposed = false;
  int _commandSequence = 0;
  int _reloadGeneration = 0;
  Future<void>? _pushReloadInFlight;
  bool _pushReloadRequested = false;
  bool _projectionExtrasReloadRequested = false;
  bool _pendingInteractionsReloadRequested = false;
  Future<void>? _synchronizationInFlight;
  Future<void>? _interactionsInFlight;
  int _interactionGeneration = 0;

  Future<void> start() => _synchronize(bootstrap: true);

  Future<void> refresh() => _synchronize(bootstrap: false);

  Future<void> _synchronize({required bool bootstrap}) {
    if (_disposed || !enabled) return Future<void>.value();
    return _synchronizationInFlight ??= () async {
      try {
        if (bootstrap) {
          await _engine.start(conversationId);
        } else {
          await _engine.refresh(conversationId);
        }
        await _replayPendingCommands();
        await Future.wait([
          reloadProjectionExtras(),
          refreshPendingInteractions(),
        ]);
      } catch (error) {
        _update(state.copyWith(syncState: _engine.state, error: error));
      }
    }().whenComplete(() => _synchronizationInFlight = null);
  }

  Future<void> acceptPushEnvelope(Map<String, dynamic> envelope) async {
    if (_disposed) return;
    try {
      await _engine.acceptPushEnvelope(
        envelope,
        conversationId: conversationId,
      );
      final payload = envelope['payload'];
      if (envelope['kind'] == 'conversation.sync_effect' &&
          payload is Map &&
          payload['conversationId'] == conversationId) {
        final receipt = payload['effect'];
        final effect = receipt is Map ? receipt['effect'] : null;
        if (effect is Map && _refreshesProjectionExtras(effect)) {
          _projectionExtrasReloadRequested = true;
        }
        final detail = effect is Map ? effect['detail'] : null;
        final detailType = detail is Map ? detail['type'] : null;
        if (effect is Map &&
            (effect['type'] == 'run.upsert' ||
                (effect['type'] == 'detail.upsert' &&
                    detailType is String &&
                    (detailType.startsWith('approval.') ||
                        detailType.startsWith('clarification.'))))) {
          _pendingInteractionsReloadRequested = true;
        }
      }
      await _reloadAfterPush();
    } catch (error) {
      state = state.copyWith(syncState: _engine.state, error: error);
    }
  }

  /// Refreshes the durable V2 presentation snapshot without touching the
  /// ordered event cursor. Metric live events use this path so the mobile UI
  /// never has to ask the retired usage/projection RPCs for a delta.
  Future<void> reloadProjectionExtras() async {
    if (_disposed || !enabled) return;
    try {
      final extras = await _engine.projectionExtras(conversationId);
      if (_disposed) return;
      _update(state.copyWith(projectionExtras: extras));
    } catch (error) {
      if (_disposed) return;
      _update(state.copyWith(error: error));
    }
  }

  Future<void> loadOlder() async {
    if (_disposed || !state.hasOlder) return;
    try {
      await _engine.loadOlder(conversationId);
      await _reload();
    } catch (error) {
      state = state.copyWith(error: error);
    }
  }

  Future<ConversationV2DetailPage> loadDetails(
    String runId, {
    String? cursor,
    String? agentId,
    String? toolCallId,
  }) {
    if (_disposed || !enabled) {
      throw StateError('Desktop is not available.');
    }
    return _engine.loadDetails(
      conversationId,
      runId,
      cursor: cursor,
      agentId: agentId,
      toolCallId: toolCallId,
    );
  }

  /// Loads one bounded tool-summary page. Tool summaries use a separate
  /// cursor from message history, so a large run never forces bootstrap to
  /// carry every call; successful pages are persisted in the V2 cache.
  Future<ConversationV2ToolsPage> loadTools(
    String runId, {
    String? cursor,
    String? agentId,
    String? toolCallId,
    int limit = 50,
    int maxBytes = 512 * 1024,
  }) async {
    if (_disposed || !enabled) {
      throw StateError('Desktop is not available.');
    }
    final page = await _engine.loadTools(
      conversationId,
      runId,
      cursor: cursor,
      agentId: agentId,
      toolCallId: toolCallId,
      limit: limit,
      maxBytes: maxBytes,
    );
    // The cache write is durable, but callers render [state]. Refresh it
    // before returning so a tool-page request is immediately observable by
    // the Feed instead of waiting for a later sync or reload.
    await _reload();
    return page;
  }

  /// Loads every detail page for a run while retaining the same cursor
  /// validation and cache writes as the single-page UI loader. This is used
  /// by the existing full-detail sheet; tool cards can still request pages on
  /// demand through [loadDetails].
  Future<ConversationV2DetailPage> loadAllDetails(
    String runId, {
    String? agentId,
    String? toolCallId,
  }) async {
    if (_disposed || !enabled) {
      throw StateError('Desktop is not available.');
    }
    final byId = <String, ConversationV2Detail>{};
    String? cursor;
    ConversationV2DetailPage? lastPage;
    while (true) {
      final page = await loadDetails(
        runId,
        cursor: cursor,
        agentId: agentId,
        toolCallId: toolCallId,
      );
      lastPage = page;
      for (final item in page.items) {
        byId[item.itemId] = item;
      }
      if (!page.hasMore) break;
      final nextCursor = page.nextCursor?.trim();
      if (nextCursor == null || nextCursor.isEmpty || nextCursor == cursor) {
        throw StateError('Conversation V2 detail pagination did not advance.');
      }
      cursor = nextCursor;
    }
    final items = byId.values.toList()
      ..sort((left, right) {
        final sequence = left.createdSeq.compareTo(right.createdSeq);
        return sequence != 0 ? sequence : left.itemId.compareTo(right.itemId);
      });
    final page = lastPage;
    return ConversationV2DetailPage(
      protocolVersion: page.protocolVersion,
      storeEpoch: page.storeEpoch,
      conversationId: page.conversationId,
      readSeq: page.readSeq,
      historyRevision: page.historyRevision,
      items: items,
      nextCursor: null,
      hasMore: false,
    );
  }

  Future<void> resolveBash(
    String toolUseId,
    String decision, {
    String? feedback,
  }) async {
    final handler = actions?.resolveBash;
    if (handler == null) {
      throw StateError('Conversation actions are unavailable.');
    }
    try {
      await handler(toolUseId, decision, feedback: feedback);
    } finally {
      await _refreshAfterInteraction();
    }
  }

  Future<void> approvePlan() async {
    final handler = actions?.approvePlan;
    if (handler == null) {
      throw StateError('Conversation actions are unavailable.');
    }
    try {
      await handler();
    } finally {
      await _refreshAfterInteraction();
    }
  }

  Future<void> dismissPlan() async {
    final handler = actions?.dismissPlan;
    if (handler == null) {
      throw StateError('Conversation actions are unavailable.');
    }
    try {
      await handler();
    } finally {
      await _refreshAfterInteraction();
    }
  }

  Future<void> submitClarification(
    String toolUseId,
    List<List<String>> selections, {
    List<int>? customInputIndices,
  }) async {
    final handler = actions?.submitClarification;
    if (handler == null) {
      throw StateError('Conversation actions are unavailable.');
    }
    try {
      await handler(
        toolUseId,
        selections,
        customInputIndices: customInputIndices,
      );
    } finally {
      await _refreshAfterInteraction();
    }
  }

  Future<void> dismissClarification(String toolUseId) async {
    final handler = actions?.dismissClarification;
    if (handler == null) {
      throw StateError('Conversation actions are unavailable.');
    }
    try {
      await handler(toolUseId);
    } finally {
      await _refreshAfterInteraction();
    }
  }

  Future<ConversationV2SendMessageResult> sendMessage({
    required String principalId,
    required String text,
    List<dynamic>? attachments,
  }) async {
    if (_disposed || !enabled) {
      throw StateError('Desktop is not available.');
    }
    _commandSequence += 1;
    final commandId =
        'mobile_${DateTime.now().toUtc().microsecondsSinceEpoch}_$_commandSequence';
    await _cache.addPendingCommand(
      ConversationV2PendingCommand(
        clientCommandId: commandId,
        conversationId: conversationId,
        text: text,
        attachments: attachments,
        createdAt: DateTime.now().toUtc().toIso8601String(),
      ),
    );
    try {
      final result = await _engine.sendMessage(
        principalId: principalId,
        conversationId: conversationId,
        clientCommandId: commandId,
        text: text,
        attachments: attachments,
      );
      // The acceptance receipt is durable on the desktop, but the push can
      // be lost while this app is sending. Close the authoritative range
      // before deleting the local retry record.
      await _engine.refresh(conversationId);
      await _cache.removePendingCommand(conversationId, commandId);
      await _reload();
      return result;
    } catch (_) {
      // Keep the command durable for a future retry/recovery pass.
      rethrow;
    }
  }

  Future<void> close() async {
    if (_disposed) return;
    _disposed = true;
    _reloadGeneration += 1;
    await _stateSubscription.cancel();
    await _engine.dispose();
    if (_closeCacheOnClose) {
      await _cache.close();
    }
    // StateNotifierProvider owns StateNotifier.dispose(). Calling it here after
    // asynchronous cleanup races Riverpod's automatic disposal.
  }

  Future<void> _reload({ConversationV2SyncState? syncState}) async {
    if (_disposed) return;
    final generation = ++_reloadGeneration;
    final snapshot = await _cache.presentationSnapshot(conversationId);
    final compactionDetails = await _cache.compactionDetails(conversationId);
    if (_disposed || generation != _reloadGeneration) return;
    _update(
      state.copyWith(
        messages: snapshot.messages,
        runs: snapshot.runs,
        tools: snapshot.tools,
        agents: snapshot.agents,
        todos: snapshot.todos,
        syncState: syncState ?? _engine.state,
        hasOlder: snapshot.cacheState?.hasOlder ?? false,
        historyRevision: snapshot.cacheState?.historyRevision ?? 0,
        details: compactionDetails,
        clearError: syncState != ConversationV2SyncState.error,
      ),
    );
  }

  Future<void> _reloadAfterPush() {
    _pushReloadRequested = true;
    final pending = _pushReloadInFlight;
    if (pending != null) return pending;
    final operation =
        () async {
          do {
            // Every effect is committed in order by the engine. Coalesce only the
            // presentation reads so a token burst does not re-read six tables and
            // rebuild the entire feed once per effect.
            await Future<void>.delayed(const Duration(milliseconds: 50));
            if (_disposed) return;
            _pushReloadRequested = false;
            await _reload();
            if (_projectionExtrasReloadRequested) {
              _projectionExtrasReloadRequested = false;
              await reloadProjectionExtras();
            }
            if (_pendingInteractionsReloadRequested) {
              _pendingInteractionsReloadRequested = false;
              await refreshPendingInteractions();
            }
          } while (_pushReloadRequested && !_disposed);
        }().whenComplete(() async {
          _pushReloadInFlight = null;
          if (_pushReloadRequested && !_disposed) await _reloadAfterPush();
        });
    _pushReloadInFlight = operation;
    return operation;
  }

  Future<void> refreshPendingInteractions() {
    if (_disposed || !enabled || loadPendingInteractions == null) {
      return Future<void>.value();
    }
    _interactionGeneration++;
    return _interactionsInFlight ??= () async {
      while (!_disposed) {
        final generation = _interactionGeneration;
        try {
          final pending = await loadPendingInteractions!();
          if (_disposed) return;
          // A resolution/event arrived while this snapshot was being read.
          // Discard the old reply and read the registry again before publishing.
          if (generation != _interactionGeneration) continue;
          _update(
            state.copyWith(
              pendingBash: pending.bash,
              pendingPlan: pending.plan,
              pendingClarification: pending.clarification,
              replacePendingInteractions: true,
              clearPendingInteractionsError: true,
            ),
          );
        } catch (error) {
          if (_disposed) return;
          if (generation != _interactionGeneration) continue;
          _update(state.copyWith(pendingInteractionsError: error));
        }
        return;
      }
    }().whenComplete(() => _interactionsInFlight = null);
  }

  Future<void> _refreshAfterInteraction() async {
    // Invalidate any registry read started before the user's action, even if
    // refresh() joins an already running synchronization pass.
    await refreshPendingInteractions();
    await refresh();
  }

  Future<void> _replayPendingCommands() async {
    for (final command in await _cache.pendingCommands(conversationId)) {
      if (_disposed) return;
      try {
        await _engine.sendMessage(
          principalId: _cache.accountId,
          conversationId: conversationId,
          clientCommandId: command.clientCommandId,
          text: command.text,
          attachments: command.attachments,
        );
        // The acceptance receipt is durable on the desktop, but the push can
        // be lost while this app is recovering. Close the authoritative range
        // before deleting the local retry record.
        await _engine.refresh(conversationId);
        await _cache.removePendingCommand(
          conversationId,
          command.clientCommandId,
        );
      } catch (_) {
        // Keep it durable; the next reconnect/start retries the same key.
        return;
      }
    }
    await _reload();
  }

  void _update(ConversationV2SessionState next) {
    if (_disposed) return;
    state = next;
  }
}

class ConversationV2PendingInteractions {
  const ConversationV2PendingInteractions({
    this.bash,
    this.plan,
    this.clarification,
  });

  final BashApprovalRequest? bash;
  final ThreadPendingPlan? plan;
  final ClarificationRequest? clarification;
}
