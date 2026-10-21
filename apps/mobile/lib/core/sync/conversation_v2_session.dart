import 'dart:async';
import 'dart:convert';

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
  final Future<void> Function(String toolUseId, List<List<String>> selections)
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
    this.error,
  });

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
  final Object? error;

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
    bool clearDetails = false,
    Object? error,
    bool clearError = false,
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
      details: clearDetails ? const [] : (details ?? this.details),
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
      error: clearError ? null : (error ?? this.error),
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
    this.enabled = true,
    bool closeCacheOnClose = true,
  }) : _cache = cache,
       _closeCacheOnClose = closeCacheOnClose,
       _engine = ConversationV2SyncEngine(cache: cache, remote: remote),
       super(const ConversationV2SessionState()) {
    _stateSubscription = _engine.states.listen((syncState) {
      unawaited(
        _reload(
          syncState: syncState,
        ).then((_) => _hydratePendingDetails()).catchError((error, _) {
          if (_disposed) return;
          _update(state.copyWith(syncState: syncState, error: error));
        }),
      );
    });
  }

  final String conversationId;
  final bool enabled;
  final ConversationV2InteractionActions? actions;
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

  Future<void> start() async {
    if (_disposed || !enabled) return;
    try {
      await _engine.start(conversationId);
      await _reload();
      await reloadProjectionExtras();
      await _hydratePendingDetails();
      await _replayPendingCommands();
    } catch (error) {
      state = state.copyWith(syncState: _engine.state, error: error);
    }
  }

  Future<void> refresh() async {
    if (_disposed || !enabled) return;
    try {
      await _engine.refresh(conversationId);
      await _reload();
      await reloadProjectionExtras();
      await _hydratePendingDetails();
      await _replayPendingCommands();
    } catch (error) {
      state = state.copyWith(syncState: _engine.state, error: error);
    }
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
    await handler(toolUseId, decision, feedback: feedback);
    await _refreshAfterInteraction();
  }

  Future<void> approvePlan() async {
    final handler = actions?.approvePlan;
    if (handler == null) {
      throw StateError('Conversation actions are unavailable.');
    }
    await handler();
    await _refreshAfterInteraction();
  }

  Future<void> dismissPlan() async {
    final handler = actions?.dismissPlan;
    if (handler == null) {
      throw StateError('Conversation actions are unavailable.');
    }
    await handler();
    await _refreshAfterInteraction();
  }

  Future<void> submitClarification(
    String toolUseId,
    List<List<String>> selections,
  ) async {
    final handler = actions?.submitClarification;
    if (handler == null) {
      throw StateError('Conversation actions are unavailable.');
    }
    await handler(toolUseId, selections);
    await _refreshAfterInteraction();
  }

  Future<void> dismissClarification(String toolUseId) async {
    final handler = actions?.dismissClarification;
    if (handler == null) {
      throw StateError('Conversation actions are unavailable.');
    }
    await handler(toolUseId);
    await _refreshAfterInteraction();
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
        clearDetails: true,
        clearPendingInteractions: true,
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
            await _hydratePendingDetails();
          } while (_pushReloadRequested && !_disposed);
        }().whenComplete(() async {
          _pushReloadInFlight = null;
          if (_pushReloadRequested && !_disposed) await _reloadAfterPush();
        });
    _pushReloadInFlight = operation;
    return operation;
  }

  Future<void> _hydratePendingDetails({bool force = false}) async {
    if (_disposed || !enabled) return;
    final generation = _reloadGeneration;
    final selectedRun = _selectInteractionRun(state.runs);
    if (selectedRun == null) return;

    var details = await _cache.details(conversationId, selectedRun.runId);
    if ((force || details.isEmpty) && !_disposed) {
      try {
        await _engine.loadDetails(conversationId, selectedRun.runId);
        details = await _cache.details(conversationId, selectedRun.runId);
      } catch (_) {
        // The feed remains available when the optional interaction detail page
        // is temporarily unavailable. A later push/refresh retries hydration.
      }
    }
    if (_disposed || generation != _reloadGeneration) return;
    final pending = resolveConversationV2PendingInteractions(
      conversationId,
      details,
    );
    _update(
      state.copyWith(
        details: details,
        pendingBash: pending.bash,
        pendingPlan: pending.plan,
        pendingClarification: pending.clarification,
        replacePendingInteractions: true,
      ),
    );
  }

  Future<void> _refreshAfterInteraction() async {
    if (_disposed) return;
    await _engine.refresh(conversationId);
    await _reload();
    await _hydratePendingDetails(force: true);
  }

  ConversationV2Run? _selectInteractionRun(List<ConversationV2Run> runs) {
    final ordered = [...runs]
      ..sort((left, right) => right.versionSeq.compareTo(left.versionSeq));
    for (final run in ordered) {
      if (run.status == 'queued' || run.status == 'running') return run;
    }
    return ordered.isEmpty ? null : ordered.first;
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

ConversationV2PendingInteractions resolveConversationV2PendingInteractions(
  String conversationId,
  List<ConversationV2Detail> details,
) {
  final approvals = <String, Map<String, dynamic>>{};
  final clarifications = <String, Map<String, dynamic>>{};
  final ordered = [...details]
    ..sort((left, right) {
      final sequence = left.createdSeq.compareTo(right.createdSeq);
      return sequence != 0 ? sequence : left.itemId.compareTo(right.itemId);
    });
  for (final detail in ordered) {
    final payload = _detailPayload(detail);
    final key = detail.toolCallId?.trim().isNotEmpty == true
        ? detail.toolCallId!.trim()
        : detail.itemId;
    final type = detail.type.trim();
    final resolved =
        type.endsWith('.resolved') ||
        _stringValue(payload?['liveType'])?.endsWith('.approved') == true ||
        _stringValue(payload?['liveType'])?.endsWith('.answered') == true ||
        _stringValue(payload?['liveType'])?.endsWith('.denied') == true ||
        _stringValue(payload?['liveType'])?.endsWith('.rejected') == true;
    if (type == 'clarification.requested' ||
        _stringValue(payload?['liveType']) == 'clarification.requested') {
      if (resolved) {
        clarifications.remove(key);
      } else if (payload?['clarification'] is Map) {
        clarifications[key] = _mapValue(payload!['clarification'])!;
      }
      continue;
    }
    if (type == 'clarification.resolved' ||
        _stringValue(payload?['liveType']) == 'clarification.resolved') {
      clarifications.remove(key);
      continue;
    }
    if (type == 'approval.requested' ||
        _stringValue(payload?['liveType'])?.endsWith('.requested') == true) {
      if (resolved) {
        approvals.remove(key);
      } else if (payload != null) {
        approvals[key] = payload;
      }
      continue;
    }
    if (type == 'approval.resolved' || resolved) {
      approvals.remove(key);
    }
  }

  BashApprovalRequest? bash;
  ThreadPendingPlan? plan;
  for (final payload in approvals.values) {
    final rawBash = _mapValue(payload['bashApproval']);
    if (rawBash != null) {
      bash = BashApprovalRequest.fromJson({
        ...rawBash,
        'threadId': conversationId,
      });
      continue;
    }
    final rawPlan =
        _mapValue(payload['plan']) ?? _mapValue(payload['planApproval']);
    if (rawPlan != null) {
      plan = ThreadPendingPlan.fromJson({
        ...rawPlan,
        'threadId': conversationId,
        'workspacePath': rawPlan['workspacePath'] ?? '',
        'worktreePath': rawPlan['worktreePath'] ?? '',
      });
    }
  }

  ClarificationRequest? clarification;
  final rawClarification = clarifications.values.lastOrNull;
  if (rawClarification != null) {
    clarification = ClarificationRequest.fromJson({
      ...rawClarification,
      'threadId': conversationId,
    });
  }
  return ConversationV2PendingInteractions(
    bash: bash,
    plan: plan,
    clarification: clarification,
  );
}

Map<String, dynamic>? _detailPayload(ConversationV2Detail detail) {
  final content = detail.content?.trim();
  if (content == null || content.isEmpty) return null;
  try {
    final decoded = jsonDecode(content);
    return _mapValue(decoded);
  } on Object {
    return null;
  }
}

Map<String, dynamic>? _mapValue(dynamic value) {
  if (value is! Map) return null;
  return value.map((key, nested) => MapEntry(key.toString(), nested));
}

String? _stringValue(dynamic value) =>
    value is String && value.trim().isNotEmpty ? value.trim() : null;
