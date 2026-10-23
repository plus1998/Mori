import 'dart:async';

import '../network/desktop_rpc.dart';
import '../models/conversation_v2_models.dart';
import '../models/eco_types.dart';
import '../storage/conversation_v2_cache.dart';
import '../utils/conversation_v2_hash.dart';

const _conversationV2IncompatibleRemoteErrorCodes = <String>{
  'unsupported_version',
  'epoch_mismatch',
};

abstract interface class ConversationV2Remote {
  Future<ConversationV2Capabilities> capabilities();

  Future<ConversationV2Bootstrap> bootstrap(
    String conversationId, {
    int pageSize,
    int maxBytes,
  });

  Future<ConversationV2ProjectionExtras> projectionExtras(
    String conversationId,
  );

  Future<ConversationV2MessagePage> messagesPage(
    String conversationId, {
    String? beforeCursor,
    int limit,
    int maxBytes,
  });

  Future<ConversationV2DetailPage> detailsPage(
    String conversationId,
    String runId, {
    String? cursor,
    String? toolCallId,
    String? agentInstanceId,
    int limit,
    int maxBytes,
  });

  Future<ConversationV2ToolsPage> toolsPage(
    String conversationId,
    String runId, {
    String? cursor,
    String? toolCallId,
    String? agentInstanceId,
    int limit,
    int maxBytes,
  });

  Future<ConversationV2Head> head(String conversationId);

  Future<ConversationV2SyncPage> sync(
    String conversationId,
    String storeEpoch,
    int afterSeq, {
    int? throughSeq,
    int maxEvents,
    int maxBytes,
  });

  Future<ConversationV2Message?> messageGet(
    String conversationId,
    String messageId,
  );

  Future<ConversationV2SendMessageResult> sendMessage({
    required String principalId,
    required String conversationId,
    required String clientCommandId,
    required String text,
    List<dynamic>? attachments,
  });
}

class DesktopRpcConversationV2Remote implements ConversationV2Remote {
  const DesktopRpcConversationV2Remote(this.rpc);

  final DesktopRpc rpc;

  @override
  Future<ConversationV2Capabilities> capabilities() =>
      rpc.conversationV2Capabilities();

  @override
  Future<ConversationV2Bootstrap> bootstrap(
    String conversationId, {
    int pageSize = 30,
    int maxBytes = 512 * 1024,
  }) => rpc.conversationV2Bootstrap(
    conversationId,
    pageSize: pageSize,
    maxBytes: maxBytes,
  );

  @override
  Future<ConversationV2ProjectionExtras> projectionExtras(
    String conversationId,
  ) => rpc.conversationV2Projection(conversationId);

  @override
  Future<ConversationV2Head> head(String conversationId) =>
      rpc.conversationV2Head(conversationId);

  @override
  Future<ConversationV2MessagePage> messagesPage(
    String conversationId, {
    String? beforeCursor,
    int limit = 30,
    int maxBytes = 512 * 1024,
  }) => rpc.conversationV2MessagesPage(
    conversationId,
    beforeCursor: beforeCursor,
    limit: limit,
    maxBytes: maxBytes,
  );

  @override
  Future<ConversationV2DetailPage> detailsPage(
    String conversationId,
    String runId, {
    String? cursor,
    String? toolCallId,
    String? agentInstanceId,
    int limit = 50,
    int maxBytes = 512 * 1024,
  }) => rpc.conversationV2DetailsPage(
    conversationId,
    runId,
    cursor: cursor,
    toolCallId: toolCallId,
    agentInstanceId: agentInstanceId,
    limit: limit,
    maxBytes: maxBytes,
  );

  @override
  Future<ConversationV2ToolsPage> toolsPage(
    String conversationId,
    String runId, {
    String? cursor,
    String? toolCallId,
    String? agentInstanceId,
    int limit = 50,
    int maxBytes = 512 * 1024,
  }) => rpc.conversationV2ToolsPage(
    conversationId,
    runId,
    cursor: cursor,
    toolCallId: toolCallId,
    agentInstanceId: agentInstanceId,
    limit: limit,
    maxBytes: maxBytes,
  );

  @override
  Future<ConversationV2Message?> messageGet(
    String conversationId,
    String messageId,
  ) async {
    final value = await rpc.conversationV2MessageGet(conversationId, messageId);
    return value == null ? null : ConversationV2Message.fromJson(value);
  }

  @override
  Future<ConversationV2SendMessageResult> sendMessage({
    required String principalId,
    required String conversationId,
    required String clientCommandId,
    required String text,
    List<dynamic>? attachments,
  }) async {
    final value = await rpc.conversationV2SendMessage(
      principalId: principalId,
      conversationId: conversationId,
      clientCommandId: clientCommandId,
      text: text,
      attachments: attachments,
    );
    return ConversationV2SendMessageResult.fromJson(value);
  }

  @override
  Future<ConversationV2SyncPage> sync(
    String conversationId,
    String storeEpoch,
    int afterSeq, {
    int? throughSeq,
    int maxEvents = 200,
    int maxBytes = 512 * 1024,
  }) => rpc.conversationV2Sync(
    conversationId,
    storeEpoch,
    afterSeq,
    throughSeq: throughSeq,
    maxEvents: maxEvents,
    maxBytes: maxBytes,
  );
}

class ConversationV2SyncEngine {
  ConversationV2SyncEngine({
    required ConversationV2CachePort cache,
    required ConversationV2Remote remote,
  }) : _cache = cache,
       _remote = remote;

  final ConversationV2CachePort _cache;
  final ConversationV2Remote _remote;
  final _stateController =
      StreamController<ConversationV2SyncState>.broadcast();
  Future<void> _operationTail = Future<void>.value();
  ConversationV2SyncState _state = ConversationV2SyncState.uninitialized;
  int _generation = 0;
  bool _disposed = false;
  ConversationV2Capabilities? _capabilities;

  ConversationV2SyncState get state => _state;
  Stream<ConversationV2SyncState> get states => _stateController.stream;

  Future<ConversationV2ProjectionExtras> projectionExtras(
    String conversationId,
  ) => _remote.projectionExtras(conversationId);

  Future<void> start(String conversationId) =>
      _serialize(() => _start(conversationId));

  Future<void> _start(String conversationId) async {
    if (_disposed) return;
    final generation = ++_generation;
    _setState(ConversationV2SyncState.bootstrapping);
    try {
      final capabilities = await _remote.capabilities();
      if (!_isCurrent(generation)) return;
      if (!_isCompatible(capabilities)) {
        _setState(ConversationV2SyncState.incompatible);
        throw StateError('Conversation V2 capabilities are unsupported.');
      }
      _capabilities = capabilities;
      final bootstrap = await _remote.bootstrap(
        conversationId,
        pageSize: 30,
        maxBytes: capabilities.maxBytes,
      );
      if (!_isCurrent(generation)) return;
      if (bootstrap.protocolVersion != 2 ||
          bootstrap.storeEpoch != capabilities.storeEpoch) {
        _setState(ConversationV2SyncState.incompatible);
        throw StateError(
          'Conversation V2 bootstrap is not compatible with capabilities.',
        );
      }
      if (bootstrap.conversationId != conversationId) {
        throw StateError(
          'Conversation V2 bootstrap belongs to another stream.',
        );
      }
      await _cache.installBootstrap(bootstrap);
      if (!_isCurrent(generation)) return;
      _setState(ConversationV2SyncState.catchingUp);
      await _catchUp(conversationId, capabilities, generation);
      if (_isCurrent(generation)) {
        await _cache.markLive(conversationId);
        _setState(ConversationV2SyncState.live);
      }
    } catch (error) {
      if (!_isCurrent(generation)) return;
      if (_state != ConversationV2SyncState.incompatible) {
        _setState(ConversationV2SyncState.error);
      }
      rethrow;
    }
  }

  Future<void> refresh(String conversationId) =>
      _serialize(() => _refresh(conversationId));

  Future<void> _refresh(String conversationId) async {
    if (_disposed) return;
    final generation = ++_generation;
    _setState(ConversationV2SyncState.catchingUp);
    try {
      final capabilities = await _remote.capabilities();
      if (!_isCurrent(generation)) return;
      if (!_isCompatible(capabilities)) {
        _setState(ConversationV2SyncState.incompatible);
        throw StateError('Conversation V2 capabilities are unsupported.');
      }
      _capabilities = capabilities;
      final current = await _cache.state(conversationId);
      if (current == null || current.storeEpoch != capabilities.storeEpoch) {
        final bootstrap = await _remote.bootstrap(
          conversationId,
          pageSize: 30,
          maxBytes: capabilities.maxBytes,
        );
        if (!_isCurrent(generation)) return;
        if (bootstrap.protocolVersion != 2 ||
            bootstrap.storeEpoch != capabilities.storeEpoch) {
          _setState(ConversationV2SyncState.incompatible);
          throw StateError(
            'Conversation V2 bootstrap is not compatible with capabilities.',
          );
        }
        if (bootstrap.conversationId != conversationId) {
          throw StateError(
            'Conversation V2 bootstrap belongs to another stream.',
          );
        }
        await _cache.installBootstrap(bootstrap);
      }
      await _catchUp(conversationId, capabilities, generation);
      if (_isCurrent(generation)) {
        await _cache.markLive(conversationId);
        _setState(ConversationV2SyncState.live);
      }
    } catch (error) {
      if (!_isCurrent(generation)) return;
      if (_state != ConversationV2SyncState.incompatible) {
        _setState(ConversationV2SyncState.error);
      }
      rethrow;
    }
  }

  Future<void> acceptPush(ConversationV2Effect effect, String conversationId) =>
      _serialize(() => _acceptPush(effect, conversationId));

  Future<void> _acceptPush(
    ConversationV2Effect effect,
    String conversationId,
  ) async {
    if (_disposed) return;
    final current = await _cache.state(conversationId);
    if (current == null) return;
    final unsupportedEffect =
        effect.effectVersion != 1 ||
        !conversationV2SupportedEffectTypes.contains(effect.type);
    if (effect.seq <= 0 ||
        unsupportedEffect ||
        effect.type.trim().isEmpty ||
        effect.effectHash != conversationV2StableHash(effect.payload)) {
      _setState(
        unsupportedEffect
            ? ConversationV2SyncState.incompatible
            : ConversationV2SyncState.error,
      );
      throw StateError('Conversation V2 push effect is invalid.');
    }
    if (effect.seq > current.appliedSeq + 1) {
      _setState(ConversationV2SyncState.catchingUp);
      await _refresh(conversationId);
      return;
    }
    // Negotiate at bootstrap/reconnect, not once per streamed delta. The push
    // envelope still validates epoch, version, sequence and content hash.
    final capabilities = _capabilities ?? await _remote.capabilities();
    if (!_isCompatible(capabilities) ||
        capabilities.storeEpoch != current.storeEpoch) {
      _setState(ConversationV2SyncState.incompatible);
      throw StateError(
        'Conversation V2 push is not compatible with the cache.',
      );
    }
    if (effect.effectVersion != capabilities.effectVersion) {
      _setState(ConversationV2SyncState.incompatible);
      throw StateError('Conversation V2 push effect version is unsupported.');
    }
    _capabilities = capabilities;
    if (effect.seq <= current.appliedSeq) {
      await _verifyDuplicatePush(
        effect,
        conversationId,
        current.storeEpoch,
        capabilities.maxBytes,
      );
      _setState(ConversationV2SyncState.live);
      return;
    }
    final page = ConversationV2SyncPage(
      protocolVersion: 2,
      storeEpoch: current.storeEpoch,
      conversationId: conversationId,
      fromSeq: current.appliedSeq + 1,
      throughSeq: current.appliedSeq >= effect.seq
          ? current.appliedSeq
          : effect.seq,
      headSeq: current.appliedSeq >= effect.seq
          ? current.appliedSeq
          : effect.seq,
      hasMore: false,
      effects: [effect],
    );
    await _applyPageWithRepairs(page, conversationId);
    _setState(ConversationV2SyncState.live);
  }

  Future<void> _verifyDuplicatePush(
    ConversationV2Effect effect,
    String conversationId,
    String storeEpoch,
    int maxBytes,
  ) async {
    // Catch-up commonly commits effects whose pushes are still queued. Verify
    // their durable receipts locally instead of serializing one RPC per token.
    final committedHash = await _cache.effectHash(conversationId, effect.seq);
    if (committedHash != null) {
      if (committedHash != effect.effectHash) {
        throw StateError(
          'Conversation V2 duplicate push conflicts with the committed effect.',
        );
      }
      return;
    }
    // A bootstrap snapshot has no receipts for the effects it subsumes.
    final page = await _remote.sync(
      conversationId,
      storeEpoch,
      effect.seq - 1,
      throughSeq: effect.seq,
      maxEvents: 1,
      maxBytes: maxBytes,
    );
    if (page.protocolVersion != 2 ||
        page.conversationId != conversationId ||
        page.storeEpoch != storeEpoch ||
        page.effects.length != 1 ||
        page.effects.single.seq != effect.seq ||
        page.effects.single.effectHash != effect.effectHash) {
      _setState(ConversationV2SyncState.error);
      throw StateError(
        'Conversation V2 duplicate push conflicts with the authoritative effect.',
      );
    }
  }

  /// Accepts the `conversation.sync_effect` envelope emitted by the desktop
  /// event center. Transport delivery is intentionally not treated as durable;
  /// a gap still goes through the authoritative range sync above.
  Future<void> acceptPushEnvelope(
    Map<String, dynamic> envelope, {
    required String conversationId,
  }) => _serialize(
    () => _acceptPushEnvelope(envelope, conversationId: conversationId),
  );

  Future<void> _acceptPushEnvelope(
    Map<String, dynamic> envelope, {
    required String conversationId,
  }) async {
    if (envelope['kind'] != 'conversation.sync_effect') return;
    final payload = envelope['payload'];
    if (payload is! Map) {
      throw StateError('Conversation V2 push payload is invalid.');
    }
    final payloadMap = Map<String, dynamic>.from(payload);
    if (payloadMap['conversationId'] != conversationId) return;
    final state = await _cache.state(conversationId);
    if (state == null) return;
    if (payloadMap['storeEpoch'] != state.storeEpoch) {
      _setState(ConversationV2SyncState.incompatible);
      throw StateError('Conversation V2 push store epoch changed.');
    }
    final rawEffect = payloadMap['effect'];
    await _acceptPush(ConversationV2Effect.fromJson(rawEffect), conversationId);
  }

  Future<void> loadOlder(String conversationId) =>
      _serialize(() => _loadOlder(conversationId));

  Future<void> _loadOlder(String conversationId) async {
    if (_disposed) return;
    final current = await _cache.state(conversationId);
    if (current == null || !current.hasOlder) return;
    final page = await _remote.messagesPage(
      conversationId,
      beforeCursor: current.historyCursor,
    );
    if (_disposed) return;
    if (page.protocolVersion != 2 || page.conversationId != conversationId) {
      throw StateError(
        'Conversation V2 history page is for another protocol stream.',
      );
    }
    if (page.storeEpoch != current.storeEpoch) {
      throw StateError(
        'Conversation V2 history page belongs to another epoch.',
      );
    }
    await _cache.applyMessagePage(page);
  }

  Future<ConversationV2SendMessageResult> sendMessage({
    required String principalId,
    required String conversationId,
    required String clientCommandId,
    required String text,
    List<dynamic>? attachments,
  }) => _serialize(
    () => _sendMessage(
      principalId: principalId,
      conversationId: conversationId,
      clientCommandId: clientCommandId,
      text: text,
      attachments: attachments,
    ),
  );

  Future<ConversationV2SendMessageResult> _sendMessage({
    required String principalId,
    required String conversationId,
    required String clientCommandId,
    required String text,
    List<dynamic>? attachments,
  }) async {
    final result = await _remote.sendMessage(
      principalId: principalId,
      conversationId: conversationId,
      clientCommandId: clientCommandId,
      text: text,
      attachments: attachments,
    );
    if (result.protocolVersion != 2 ||
        result.conversationId != conversationId ||
        result.clientCommandId != clientCommandId ||
        result.acceptedSeq < 1 ||
        result.status != 'queued') {
      throw StateError('Conversation V2 send response is invalid.');
    }
    return result;
  }

  Future<ConversationV2DetailPage> loadDetails(
    String conversationId,
    String runId, {
    String? cursor,
    String? agentId,
    String? toolCallId,
  }) => _serialize(
    () => _loadDetails(
      conversationId,
      runId,
      cursor: cursor,
      agentId: agentId,
      toolCallId: toolCallId,
    ),
  );

  Future<ConversationV2DetailPage> _loadDetails(
    String conversationId,
    String runId, {
    String? cursor,
    String? agentId,
    String? toolCallId,
  }) async {
    if (_disposed) {
      throw StateError('Conversation V2 sync engine is disposed.');
    }
    final page = await _remote.detailsPage(
      conversationId,
      runId,
      cursor: cursor,
      toolCallId: toolCallId,
      agentInstanceId: agentId,
    );
    if (_disposed) return page;
    if (page.protocolVersion != 2 || page.conversationId != conversationId) {
      throw StateError(
        'Conversation V2 detail page is for another protocol stream.',
      );
    }
    final current = await _cache.state(conversationId);
    if (current == null || page.storeEpoch != current.storeEpoch) {
      throw StateError('Conversation V2 detail page belongs to another epoch.');
    }
    await _cache.applyDetailsPage(
      page,
      runId,
      agentId: agentId,
      toolCallId: toolCallId,
    );
    return page;
  }

  Future<ConversationV2ToolsPage> loadTools(
    String conversationId,
    String runId, {
    String? cursor,
    String? toolCallId,
    String? agentId,
    int limit = 50,
    int maxBytes = 512 * 1024,
  }) => _serialize(
    () => _loadTools(
      conversationId,
      runId,
      cursor: cursor,
      toolCallId: toolCallId,
      agentId: agentId,
      limit: limit,
      maxBytes: maxBytes,
    ),
  );

  Future<ConversationV2ToolsPage> _loadTools(
    String conversationId,
    String runId, {
    String? cursor,
    String? toolCallId,
    String? agentId,
    int limit = 50,
    int maxBytes = 512 * 1024,
  }) async {
    if (_disposed) {
      throw StateError('Conversation V2 sync engine is disposed.');
    }
    final page = await _remote.toolsPage(
      conversationId,
      runId,
      cursor: cursor,
      toolCallId: toolCallId,
      agentInstanceId: agentId,
      limit: limit,
      maxBytes: maxBytes,
    );
    if (_disposed) return page;
    if (page.protocolVersion != 2 ||
        page.conversationId != conversationId ||
        page.runId != runId) {
      throw StateError(
        'Conversation V2 tool page is for another protocol stream.',
      );
    }
    final current = await _cache.state(conversationId);
    if (current == null || page.storeEpoch != current.storeEpoch) {
      throw StateError('Conversation V2 tool page belongs to another epoch.');
    }
    if (page.readSeq < 0 || page.readSeq > current.appliedSeq) {
      throw StateError(
        'Conversation V2 tool page is ahead of the durable effect cursor.',
      );
    }
    if (page.historyRevision != current.historyRevision) {
      throw StateError(
        'Conversation V2 tool page history revision does not match the cache.',
      );
    }
    await _cache.applyToolsPage(page);
    return page;
  }

  void setOffline() {
    if (!_disposed) _setState(ConversationV2SyncState.offline);
  }

  Future<void> dispose() async {
    _disposed = true;
    _generation += 1;
    await _stateController.close();
  }

  Future<void> _catchUp(
    String conversationId,
    ConversationV2Capabilities capabilities,
    int generation,
  ) async {
    final initial = await _cache.state(conversationId);
    if (initial == null) {
      throw StateError('Conversation V2 cache has no bootstrap state.');
    }
    var current = initial;
    // Finish the range observed at the start of this pass. Chasing a moving
    // head can keep bootstrap in this serialized operation indefinitely and
    // prevent queued pushes from reaching the presentation layer.
    final head = await _remote.head(conversationId);
    if (head.protocolVersion != 2 ||
        head.conversationId != conversationId ||
        head.storeEpoch != current.storeEpoch ||
        head.lastSeq < current.appliedSeq ||
        head.historyRevision < current.historyRevision) {
      throw StateError(
        'Conversation V2 head is incompatible while synchronizing.',
      );
    }
    while (true) {
      if (!_isCurrent(generation)) {
        return;
      }
      if (current.appliedSeq >= head.lastSeq) return;
      final page = await _remote.sync(
        conversationId,
        current.storeEpoch,
        current.appliedSeq,
        throughSeq: head.lastSeq,
        maxEvents: capabilities.maxEvents,
        maxBytes: capabilities.maxBytes,
      );
      if (!_isCurrent(generation)) {
        return;
      }
      if (page.conversationId != conversationId ||
          page.storeEpoch != current.storeEpoch ||
          page.protocolVersion != 2) {
        throw StateError('Conversation V2 sync page is for another stream.');
      }
      if (page.effects.isEmpty) {
        throw StateError('Conversation V2 sync returned no progress.');
      }
      _validateSyncPage(page, current, capabilities);
      await _applyPageWithRepairs(page, conversationId);
      final next = await _cache.state(conversationId);
      if (next == null) {
        throw StateError('Conversation V2 cache state disappeared.');
      }
      if (next.storeEpoch != current.storeEpoch ||
          next.appliedSeq < page.throughSeq) {
        throw StateError('Conversation V2 sync did not advance its range.');
      }
      current = next;
    }
  }

  bool _isCurrent(int generation) => !_disposed && generation == _generation;

  Future<T> _serialize<T>(Future<T> Function() operation) {
    final ready = _operationTail.then<void>((_) {}, onError: (_) {});
    final result = ready.then<T>((_) async {
      try {
        return await operation();
      } catch (error, stackTrace) {
        _markRemoteError(error);
        Error.throwWithStackTrace(error, stackTrace);
      }
    });
    _operationTail = result.then<void>((_) {}, onError: (_) {});
    return result;
  }

  void _markRemoteError(Object error) {
    if (error is EcoCenterException &&
        _conversationV2IncompatibleRemoteErrorCodes.contains(
          error.domainCode,
        )) {
      _setState(ConversationV2SyncState.incompatible);
      return;
    }
    if (_state != ConversationV2SyncState.incompatible &&
        _state != ConversationV2SyncState.offline) {
      _setState(ConversationV2SyncState.error);
    }
  }

  Future<void> _applyPageWithRepairs(
    ConversationV2SyncPage page,
    String conversationId,
  ) async {
    final repairableTargets = <String>{
      for (final effect in page.effects)
        if (_isMessageEffect(effect))
          if (effect.payload['messageId'] is String &&
              (effect.payload['messageId'] as String).isNotEmpty)
            effect.payload['messageId'] as String,
    };
    final repairedTargets = <String>{};
    for (var attempt = 0; attempt <= repairableTargets.length; attempt += 1) {
      try {
        await _cache.applySyncPage(page);
        return;
      } on ConversationV2EntityRepairError {
        final target = _repairTarget(page, excluding: repairedTargets);
        if (target == null) rethrow;
        repairedTargets.add(target);
        final message = await _remote.messageGet(conversationId, target);
        if (message == null) rethrow;
        if (message.conversationId != conversationId ||
            message.messageId != target) {
          throw StateError(
            'Conversation V2 entity repair returned a mismatch.',
          );
        }
        await _cache.repairMessage(message);
      }
    }
    throw StateError('Conversation V2 entity repair did not converge.');
  }

  void _validateSyncPage(
    ConversationV2SyncPage page,
    ConversationV2CacheState current,
    ConversationV2Capabilities capabilities,
  ) {
    if (page.fromSeq != current.appliedSeq + 1 ||
        page.fromSeq < 1 ||
        page.throughSeq < current.appliedSeq ||
        page.headSeq < current.appliedSeq ||
        page.throughSeq > page.headSeq ||
        page.fromSeq > page.throughSeq + 1 ||
        page.effects.length > capabilities.maxEvents ||
        (!page.hasMore && page.throughSeq < page.headSeq) ||
        (page.hasMore && page.throughSeq >= page.headSeq)) {
      throw StateError('Conversation V2 sync page range is invalid.');
    }
    var expectedSeq = page.fromSeq;
    for (final effect in page.effects) {
      final unsupportedEffect =
          effect.effectVersion != capabilities.effectVersion ||
          !conversationV2SupportedEffectTypes.contains(effect.type);
      if (unsupportedEffect ||
          effect.effectHash != conversationV2StableHash(effect.payload) ||
          effect.type.trim().isEmpty ||
          effect.seq != expectedSeq ||
          effect.seq > page.throughSeq ||
          effect.seq > page.headSeq) {
        if (unsupportedEffect) {
          _setState(ConversationV2SyncState.incompatible);
        }
        throw StateError(
          'Conversation V2 sync page effects are not contiguous.',
        );
      }
      expectedSeq += 1;
    }
    if (page.effects.isNotEmpty && expectedSeq - 1 != page.throughSeq) {
      throw StateError('Conversation V2 sync page throughSeq is invalid.');
    }
  }

  String? _repairTarget(
    ConversationV2SyncPage page, {
    Set<String> excluding = const <String>{},
  }) {
    for (final effect in page.effects) {
      if (!_isMessageEffect(effect)) continue;
      final id = effect.payload['messageId'];
      if (id is String && id.isNotEmpty && !excluding.contains(id)) return id;
    }
    return null;
  }

  bool _isCompatible(ConversationV2Capabilities capabilities) =>
      capabilities.protocolVersion == 2 &&
      capabilities.eventSchemaVersion == 1 &&
      capabilities.effectVersion == 1 &&
      capabilities.maxEvents > 0 &&
      capabilities.maxBytes > 0 &&
      capabilities.storeEpoch.trim().isNotEmpty;

  bool _isMessageEffect(ConversationV2Effect effect) =>
      effect.type == 'message.append' ||
      effect.type == 'message.replace' ||
      effect.type == 'message.finalize' ||
      effect.type == 'message.tombstone';

  void _setState(ConversationV2SyncState next) {
    if (_disposed || _state == next) return;
    _state = next;
    if (!_stateController.isClosed) _stateController.add(next);
  }
}
