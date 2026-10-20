import 'package:flutter_test/flutter_test.dart';

import 'package:eco_mobile/core/models/conversation_v2_models.dart';
import 'package:eco_mobile/core/storage/conversation_v2_cache.dart';
import 'package:eco_mobile/core/sync/conversation_v2_fault_transport.dart';
import 'package:eco_mobile/core/sync/conversation_v2_sync_engine.dart';
import 'package:eco_mobile/core/utils/conversation_v2_hash.dart';

void main() {
  test(
    'negotiates capabilities once for a burst, and again on refresh',
    () async {
      final cache = _FakeCache();
      final remote = _FakeRemote();
      final engine = ConversationV2SyncEngine(cache: cache, remote: remote);
      await engine.start('thread_1');
      final before = remote.capabilitiesCalls;
      for (var seq = 3; seq <= 102; seq++) {
        await engine.acceptPush(_effect(seq), 'thread_1');
      }
      expect(cache.current?.appliedSeq, 102);
      expect(remote.capabilitiesCalls - before, 0);
      // Reconnect/refresh must still negotiate with the authoritative desktop.
      remote.headSeq = 102;
      await engine.refresh('thread_1');
      expect(remote.capabilitiesCalls, before + 1);
      await engine.dispose();
    },
  );

  test(
    'bootstraps, catches up and only becomes live after a contiguous range',
    () async {
      final cache = _FakeCache();
      final remote = _FakeRemote();
      final engine = ConversationV2SyncEngine(cache: cache, remote: remote);

      await engine.start('thread_1');

      expect(engine.state, ConversationV2SyncState.live);
      expect(cache.current?.appliedSeq, 2);
      expect(remote.syncCalls, 1);
      await engine.dispose();
    },
  );

  test(
    'persists live when bootstrap already reaches the authoritative head',
    () async {
      final cache = _FakeCache();
      final remote = _HeadAtBootstrapRemote();
      final engine = ConversationV2SyncEngine(cache: cache, remote: remote);

      await engine.start('thread_1');

      expect(engine.state, ConversationV2SyncState.live);
      expect(cache.current?.state, ConversationV2SyncState.live);
      expect(remote.syncCalls, 0);
      await engine.dispose();
    },
  );

  test(
    'a pushed gap triggers range recovery instead of advancing the cursor',
    () async {
      final cache = _FakeCache()..current = _state(appliedSeq: 1);
      final remote = _FakeRemote();
      final engine = ConversationV2SyncEngine(cache: cache, remote: remote);

      await engine.acceptPush(_effect(3), 'thread_1');

      expect(cache.current?.appliedSeq, 2);
      expect(remote.syncCalls, 1);
      expect(engine.state, ConversationV2SyncState.live);
      await engine.dispose();
    },
  );

  test(
    'accepts a committed event-center envelope at the next sequence',
    () async {
      final cache = _FakeCache()..current = _state(appliedSeq: 1);
      final engine = ConversationV2SyncEngine(
        cache: cache,
        remote: _FakeRemote(),
      );

      await engine.acceptPushEnvelope({
        'kind': 'conversation.sync_effect',
        'payload': {
          'conversationId': 'thread_1',
          'storeEpoch': 'epoch_1',
          'effect': {
            'seq': 2,
            'effectVersion': 1,
            'effectHash': conversationV2StableHash({
              'type': 'noop',
              'reason': 'fixture',
            }),
            'effect': {'type': 'noop', 'reason': 'fixture'},
          },
        },
      }, conversationId: 'thread_1');

      expect(cache.current?.appliedSeq, 2);
      await engine.dispose();
    },
  );

  test('verifies and ignores a duplicate push at the applied cursor', () async {
    final cache = _FakeCache()..current = _state(appliedSeq: 2);
    final remote = _FakeRemote();
    final engine = ConversationV2SyncEngine(cache: cache, remote: remote);

    await engine.acceptPush(_effect(2), 'thread_1');

    expect(cache.current?.appliedSeq, 2);
    expect(remote.syncCalls, 1);
    expect(engine.state, ConversationV2SyncState.live);
    await engine.dispose();
  });

  test(
    'rejects a duplicate push with a conflicting authoritative effect',
    () async {
      final cache = _FakeCache()..current = _state(appliedSeq: 2);
      final engine = ConversationV2SyncEngine(
        cache: cache,
        remote: _ConflictingDuplicateRemote(),
      );

      await expectLater(
        engine.acceptPush(_effect(2), 'thread_1'),
        throwsStateError,
      );
      expect(engine.state, ConversationV2SyncState.error);
      expect(cache.current?.appliedSeq, 2);
      await engine.dispose();
    },
  );

  test('rejects a pushed effect whose content hash does not match', () async {
    final cache = _FakeCache()..current = _state(appliedSeq: 1);
    final engine = ConversationV2SyncEngine(
      cache: cache,
      remote: _FakeRemote(),
    );
    final payload = const <String, dynamic>{
      'type': 'noop',
      'reason': 'tampered',
    };

    await expectLater(
      engine.acceptPush(
        ConversationV2Effect(
          seq: 2,
          effectVersion: 1,
          effectHash: 'wrong-hash',
          type: 'noop',
          payload: payload,
        ),
        'thread_1',
      ),
      throwsStateError,
    );
    expect(engine.state, ConversationV2SyncState.error);
    await engine.dispose();
  });

  test(
    'marks an unexpected push transport failure as an explicit error',
    () async {
      final cache = _FakeCache()..current = _state(appliedSeq: 1);
      final engine = ConversationV2SyncEngine(
        cache: cache,
        remote: _FailingCapabilitiesRemote(),
      );

      await expectLater(
        engine.acceptPush(_effect(2), 'thread_1'),
        throwsStateError,
      );
      expect(engine.state, ConversationV2SyncState.error);
      await engine.dispose();
    },
  );

  test('marks a send transport failure as an explicit error', () async {
    final engine = ConversationV2SyncEngine(
      cache: _FakeCache()..current = _state(appliedSeq: 1),
      remote: _FailingSendRemote(),
    );

    await expectLater(
      engine.sendMessage(
        principalId: 'user_1',
        conversationId: 'thread_1',
        clientCommandId: 'command_1',
        text: 'hello',
      ),
      throwsStateError,
    );
    expect(engine.state, ConversationV2SyncState.error);
    await engine.dispose();
  });

  test('repairs a missing message entity before applying a delta', () async {
    final cache = _RepairingCache()..current = _state(appliedSeq: 1);
    final remote = _FakeRemote()
      ..repair = const ConversationV2Message(
        messageId: 'message_1',
        conversationId: 'thread_1',
        turnId: 'turn_1',
        role: 'assistant',
        channel: 'answer',
        createdSeq: 1,
        versionSeq: 1,
        contentVersion: 0,
        body: 'hello',
        status: ConversationV2MessageStatus.streaming,
        isDeleted: false,
      );
    final engine = ConversationV2SyncEngine(cache: cache, remote: remote);

    final payload = <String, dynamic>{
      'type': 'message.append',
      'messageId': 'message_1',
      'baseContentVersion': 0,
      'nextContentVersion': 1,
      'delta': ' world',
      'versionSeq': 2,
    };
    await engine.acceptPush(
      ConversationV2Effect(
        seq: 2,
        effectVersion: 1,
        effectHash: conversationV2StableHash(payload),
        type: 'message.append',
        payload: payload,
      ),
      'thread_1',
    );

    expect(cache.repaired, isTrue);
    expect(remote.messageGetCalls, 1);
    expect(cache.current?.appliedSeq, 2);
    await engine.dispose();
  });

  test('repairs every distinct missing entity in one sync page', () async {
    final cache = _MultiRepairingCache(
      missing: {for (var index = 1; index <= 5; index += 1) 'message_$index'},
    )..current = _state(appliedSeq: 0);
    final remote = _MultiRepairRemote(count: 5);
    final engine = ConversationV2SyncEngine(cache: cache, remote: remote);

    await engine.start('thread_1');

    expect(cache.current?.appliedSeq, 5);
    expect(cache.repairedMessageIds, {
      'message_1',
      'message_2',
      'message_3',
      'message_4',
      'message_5',
    });
    expect(remote.messageGetCalls, 5);
    await engine.dispose();
  });

  test('does not treat an empty catch-up page as live progress', () async {
    final cache = _FakeCache()..current = _state(appliedSeq: 0);
    final engine = ConversationV2SyncEngine(
      cache: cache,
      remote: _EmptySyncPageRemote(),
    );

    await expectLater(engine.start('thread_1'), throwsStateError);
    expect(engine.state, ConversationV2SyncState.error);
    expect(cache.current?.appliedSeq, 0);
    await engine.dispose();
  });

  test('stops at an unknown effect instead of treating it as a noop', () async {
    final cache = _FakeCache()..current = _state(appliedSeq: 2);
    final payload = const <String, dynamic>{
      'type': 'future.effect',
      'value': 'must-upgrade',
    };
    final remote = _UnknownPrefixRemote(
      effect: ConversationV2Effect(
        seq: 3,
        effectVersion: 1,
        effectHash: conversationV2StableHash(payload),
        type: 'future.effect',
        payload: payload,
      ),
    );
    final engine = ConversationV2SyncEngine(cache: cache, remote: remote);

    await expectLater(engine.refresh('thread_1'), throwsStateError);

    expect(engine.state, ConversationV2SyncState.incompatible);
    expect(cache.current?.appliedSeq, 2);
    await engine.dispose();
  });

  test('rejects a head that regresses behind the durable cursor', () async {
    final cache = _FakeCache()..current = _state(appliedSeq: 2);
    final engine = ConversationV2SyncEngine(
      cache: cache,
      remote: _RegressedHeadRemote(),
    );

    await expectLater(engine.refresh('thread_1'), throwsStateError);
    expect(engine.state, ConversationV2SyncState.error);
    expect(cache.current?.appliedSeq, 2);
    await engine.dispose();
  });

  test(
    'replays seeded loss, duplication, delay and reorder before catch-up',
    () async {
      for (var seed = 1; seed <= 100; seed += 1) {
        final cache = _FakeCache()..current = _state(appliedSeq: 0);
        final remote = _FaultReplayRemote(lastSeq: 32);
        final engine = ConversationV2SyncEngine(cache: cache, remote: remote);
        final transport = ConversationV2FaultTransport<ConversationV2Effect>(
          plan: ConversationV2FaultPlan(
            seed: seed,
            dropRate: .18,
            duplicateRate: .22,
            delayRate: .16,
            reorderWindow: 5,
            maxBufferedPackets: 64,
          ),
          sequenceOf: (effect) => effect.seq,
        );

        final first = transport.transmit(
          List.generate(32, (index) => _effect(index + 1)),
        );
        for (final effect in first.packets) {
          await engine.acceptPush(effect, 'thread_1');
        }
        final second = transport.transmit(const []);
        for (final effect in second.packets) {
          await engine.acceptPush(effect, 'thread_1');
        }

        // A lost tail packet is discovered by the authoritative head check,
        // not by pretending the last delivered push was the end of the stream.
        await engine.refresh('thread_1');

        expect(remote.syncCalls, greaterThan(0), reason: 'seed=$seed');
        expect(cache.current?.appliedSeq, 32, reason: 'seed=$seed');
        expect(
          engine.state,
          ConversationV2SyncState.live,
          reason: 'seed=$seed',
        );
        await engine.dispose();
      }
    },
  );

  test(
    'disconnect buffers packets and reconnect keeps the same replay seed',
    () {
      final transport = ConversationV2FaultTransport<int>(
        plan: const ConversationV2FaultPlan(
          seed: 7,
          disconnectOnFirstTransmit: true,
        ),
        sequenceOf: (value) => value,
      );

      final disconnected = transport.transmit([1, 2, 3]);
      expect(disconnected.disconnected, isTrue);
      expect(disconnected.packets, isEmpty);

      transport.reconnect();
      final recovered = transport.transmit(const []);
      expect(recovered.packets, [1, 2, 3]);
      expect(transport.bufferedPackets, 0);
    },
  );
}

class _FaultReplayRemote extends _FakeRemote {
  _FaultReplayRemote({required this.lastSeq});

  final int lastSeq;

  @override
  Future<ConversationV2Head> head(String conversationId) async =>
      ConversationV2Head(
        protocolVersion: 2,
        storeEpoch: 'epoch_1',
        conversationId: conversationId,
        lastSeq: lastSeq,
        historyRevision: 0,
      );

  @override
  Future<ConversationV2SyncPage> sync(
    String conversationId,
    String storeEpoch,
    int afterSeq, {
    int? throughSeq,
    int maxEvents = 200,
    int maxBytes = 512 * 1024,
  }) async {
    syncCalls += 1;
    final target = throughSeq == null || throughSeq > lastSeq
        ? lastSeq
        : throughSeq;
    final effects = [
      for (var seq = afterSeq + 1; seq <= target; seq += 1) _effect(seq),
    ];
    return ConversationV2SyncPage(
      protocolVersion: 2,
      storeEpoch: 'epoch_1',
      conversationId: conversationId,
      fromSeq: afterSeq + 1,
      throughSeq: target,
      headSeq: lastSeq,
      hasMore: false,
      effects: effects,
    );
  }
}

class _FakeRemote implements ConversationV2Remote {
  int capabilitiesCalls = 0;
  int headSeq = 2;
  int syncCalls = 0;
  int messageGetCalls = 0;
  ConversationV2Message? repair;

  @override
  Future<ConversationV2Capabilities> capabilities() async {
    capabilitiesCalls += 1;
    return const ConversationV2Capabilities(
      protocolVersion: 2,
      eventSchemaVersion: 1,
      effectVersion: 1,
      maxEvents: 100,
      maxBytes: 512 * 1024,
      storeEpoch: 'epoch_1',
    );
  }

  @override
  Future<ConversationV2Bootstrap> bootstrap(
    String conversationId, {
    int pageSize = 30,
    int maxBytes = 512 * 1024,
  }) async => const ConversationV2Bootstrap(
    protocolVersion: 2,
    storeEpoch: 'epoch_1',
    conversationId: 'thread_1',
    snapshotSeq: 0,
    historyRevision: 0,
    messages: [],
    runs: [],
    tools: [],
    olderCursor: null,
    hasOlder: false,
  );

  @override
  Future<ConversationV2ProjectionExtras> projectionExtras(
    String conversationId,
  ) async => const ConversationV2ProjectionExtras();

  @override
  Future<ConversationV2MessagePage> messagesPage(
    String conversationId, {
    String? beforeCursor,
    int limit = 30,
    int maxBytes = 512 * 1024,
  }) async => const ConversationV2MessagePage(
    protocolVersion: 2,
    storeEpoch: 'epoch_1',
    conversationId: 'thread_1',
    readSeq: 0,
    historyRevision: 0,
    messages: [],
    nextCursor: null,
    hasMore: false,
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
  }) async => const ConversationV2DetailPage(
    protocolVersion: 2,
    storeEpoch: 'epoch_1',
    conversationId: 'thread_1',
    readSeq: 0,
    historyRevision: 0,
    items: [],
    nextCursor: null,
    hasMore: false,
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
  }) async => const ConversationV2ToolsPage(
    protocolVersion: 2,
    storeEpoch: 'epoch_1',
    conversationId: 'thread_1',
    runId: 'run_1',
    readSeq: 0,
    historyRevision: 0,
    tools: [],
    totalCount: 0,
    nextCursor: null,
    hasMore: false,
  );

  @override
  Future<ConversationV2Head> head(String conversationId) async =>
      ConversationV2Head(
        protocolVersion: 2,
        storeEpoch: 'epoch_1',
        conversationId: 'thread_1',
        lastSeq: headSeq,
        historyRevision: 0,
      );

  @override
  Future<ConversationV2SyncPage> sync(
    String conversationId,
    String storeEpoch,
    int afterSeq, {
    int? throughSeq,
    int maxEvents = 200,
    int maxBytes = 512 * 1024,
  }) async {
    syncCalls += 1;
    return ConversationV2SyncPage(
      protocolVersion: 2,
      storeEpoch: 'epoch_1',
      conversationId: 'thread_1',
      fromSeq: afterSeq + 1,
      throughSeq: 2,
      headSeq: 2,
      hasMore: false,
      effects: [_effect(afterSeq + 1), if (afterSeq == 0) _effect(2)],
    );
  }

  @override
  Future<ConversationV2Message?> messageGet(
    String conversationId,
    String messageId,
  ) async {
    messageGetCalls += 1;
    return repair;
  }

  @override
  Future<ConversationV2SendMessageResult> sendMessage({
    required String principalId,
    required String conversationId,
    required String clientCommandId,
    required String text,
    List<dynamic>? attachments,
  }) async => ConversationV2SendMessageResult(
    protocolVersion: 2,
    conversationId: conversationId,
    clientCommandId: clientCommandId,
    messageId: 'message_accepted',
    turnId: 'turn_accepted',
    acceptedSeq: 1,
    status: 'queued',
  );
}

class _HeadAtBootstrapRemote extends _FakeRemote {
  @override
  Future<ConversationV2Bootstrap> bootstrap(
    String conversationId, {
    int pageSize = 30,
    int maxBytes = 512 * 1024,
  }) async => ConversationV2Bootstrap(
    protocolVersion: 2,
    storeEpoch: 'epoch_1',
    conversationId: conversationId,
    snapshotSeq: 2,
    historyRevision: 0,
    messages: const [],
    runs: const [],
    tools: const [],
    olderCursor: null,
    hasOlder: false,
  );
}

class _MultiRepairRemote extends _FakeRemote {
  _MultiRepairRemote({required this.count});

  final int count;

  @override
  Future<ConversationV2Head> head(String conversationId) async =>
      ConversationV2Head(
        protocolVersion: 2,
        storeEpoch: 'epoch_1',
        conversationId: conversationId,
        lastSeq: count,
        historyRevision: 0,
      );

  @override
  Future<ConversationV2SyncPage> sync(
    String conversationId,
    String storeEpoch,
    int afterSeq, {
    int? throughSeq,
    int maxEvents = 200,
    int maxBytes = 512 * 1024,
  }) async {
    syncCalls += 1;
    final target = throughSeq ?? count;
    return ConversationV2SyncPage(
      protocolVersion: 2,
      storeEpoch: 'epoch_1',
      conversationId: conversationId,
      fromSeq: afterSeq + 1,
      throughSeq: target,
      headSeq: count,
      hasMore: target < count,
      effects: [
        for (var seq = afterSeq + 1; seq <= target; seq += 1)
          _messageAppendEffect(seq),
      ],
    );
  }

  @override
  Future<ConversationV2Message?> messageGet(
    String conversationId,
    String messageId,
  ) async {
    messageGetCalls += 1;
    final index = int.parse(messageId.substring('message_'.length));
    return ConversationV2Message(
      messageId: messageId,
      conversationId: conversationId,
      turnId: 'turn_$index',
      role: 'assistant',
      channel: 'answer',
      createdSeq: index,
      versionSeq: index,
      contentVersion: 0,
      body: 'body_$index',
      status: ConversationV2MessageStatus.streaming,
      isDeleted: false,
    );
  }
}

class _MultiRepairingCache extends _FakeCache {
  _MultiRepairingCache({required this.missing});

  final Set<String> missing;
  final Set<String> repairedMessageIds = {};

  @override
  Future<void> applySyncPage(ConversationV2SyncPage page) async {
    if (missing.isNotEmpty) {
      throw ConversationV2EntityRepairError(
        'Message delta target is not cached.',
      );
    }
    await super.applySyncPage(page);
  }

  @override
  Future<void> repairMessage(ConversationV2Message message) async {
    repairedMessageIds.add(message.messageId);
    missing.remove(message.messageId);
  }
}

class _EmptySyncPageRemote extends _FakeRemote {
  @override
  Future<ConversationV2SyncPage> sync(
    String conversationId,
    String storeEpoch,
    int afterSeq, {
    int? throughSeq,
    int maxEvents = 200,
    int maxBytes = 512 * 1024,
  }) async {
    syncCalls += 1;
    return ConversationV2SyncPage(
      protocolVersion: 2,
      storeEpoch: storeEpoch,
      conversationId: conversationId,
      fromSeq: afterSeq + 1,
      throughSeq: afterSeq,
      headSeq: 2,
      hasMore: false,
      effects: const [],
    );
  }
}

class _ConflictingDuplicateRemote extends _FakeRemote {
  @override
  Future<ConversationV2SyncPage> sync(
    String conversationId,
    String storeEpoch,
    int afterSeq, {
    int? throughSeq,
    int maxEvents = 200,
    int maxBytes = 512 * 1024,
  }) async {
    syncCalls += 1;
    final payload = const <String, dynamic>{
      'type': 'noop',
      'reason': 'conflicting-authoritative-effect',
    };
    return ConversationV2SyncPage(
      protocolVersion: 2,
      storeEpoch: storeEpoch,
      conversationId: conversationId,
      fromSeq: afterSeq + 1,
      throughSeq: afterSeq + 1,
      headSeq: afterSeq + 1,
      hasMore: false,
      effects: [
        ConversationV2Effect(
          seq: afterSeq + 1,
          effectVersion: 1,
          effectHash: conversationV2StableHash(payload),
          type: 'noop',
          payload: payload,
        ),
      ],
    );
  }
}

class _FailingCapabilitiesRemote extends _FakeRemote {
  @override
  Future<ConversationV2Capabilities> capabilities() async {
    throw StateError('transport unavailable');
  }
}

class _FailingSendRemote extends _FakeRemote {
  @override
  Future<ConversationV2SendMessageResult> sendMessage({
    required String principalId,
    required String conversationId,
    required String clientCommandId,
    required String text,
    List<dynamic>? attachments,
  }) async {
    throw StateError('send transport unavailable');
  }
}

class _RegressedHeadRemote extends _FakeRemote {
  @override
  Future<ConversationV2Head> head(String conversationId) async =>
      ConversationV2Head(
        protocolVersion: 2,
        storeEpoch: 'epoch_1',
        conversationId: conversationId,
        lastSeq: 1,
        historyRevision: 0,
      );
}

class _UnknownPrefixRemote extends _FakeRemote {
  _UnknownPrefixRemote({required this.effect});

  final ConversationV2Effect effect;

  @override
  Future<ConversationV2Head> head(String conversationId) async =>
      const ConversationV2Head(
        protocolVersion: 2,
        storeEpoch: 'epoch_1',
        conversationId: 'thread_1',
        lastSeq: 3,
        historyRevision: 0,
      );

  @override
  Future<ConversationV2SyncPage> sync(
    String conversationId,
    String storeEpoch,
    int afterSeq, {
    int? throughSeq,
    int maxEvents = 200,
    int maxBytes = 512 * 1024,
  }) async {
    syncCalls += 1;
    return ConversationV2SyncPage(
      protocolVersion: 2,
      storeEpoch: storeEpoch,
      conversationId: conversationId,
      fromSeq: effect.seq,
      throughSeq: 3,
      headSeq: 3,
      hasMore: false,
      effects: [effect],
    );
  }
}

class _FakeCache implements ConversationV2CachePort {
  ConversationV2CacheState? current;

  @override
  Future<List<ConversationV2Message>> messages(String conversationId) async =>
      const [];

  @override
  Future<List<ConversationV2Agent>> agents(String conversationId) async =>
      const [];

  @override
  Future<List<ConversationV2Todo>> todos(String conversationId) async =>
      const [];

  @override
  Future<List<ConversationV2Tool>> tools(
    String conversationId, [
    String? runId,
  ]) async => const [];

  @override
  Future<void> applySyncPage(ConversationV2SyncPage page) async {
    var next = current!;
    for (final effect in page.effects) {
      if (effect.seq == next.appliedSeq + 1) {
        next = next.copyWith(appliedSeq: effect.seq);
      }
    }
    current = next;
  }

  @override
  Future<void> installBootstrap(ConversationV2Bootstrap bootstrap) async {
    current = _state(appliedSeq: bootstrap.snapshotSeq);
  }

  @override
  Future<void> markLive(String conversationId) async {
    current = current?.copyWith(state: ConversationV2SyncState.live);
  }

  @override
  Future<void> repairMessage(ConversationV2Message message) async {}

  @override
  Future<void> applyMessagePage(ConversationV2MessagePage page) async {}

  @override
  Future<void> applyDetailsPage(
    ConversationV2DetailPage page,
    String runId, {
    String? agentId,
    String? toolCallId,
  }) async {}

  @override
  Future<void> applyToolsPage(ConversationV2ToolsPage page) async {}

  @override
  Future<ConversationV2CacheState?> state(String conversationId) async =>
      current;
}

class _RepairingCache extends _FakeCache {
  bool repaired = false;

  @override
  Future<void> applySyncPage(ConversationV2SyncPage page) async {
    if (!repaired) {
      throw ConversationV2EntityRepairError(
        'Message delta target is not cached.',
      );
    }
    await super.applySyncPage(page);
  }

  @override
  Future<void> repairMessage(ConversationV2Message message) async {
    repaired = true;
  }
}

ConversationV2CacheState _state({required int appliedSeq}) =>
    ConversationV2CacheState(
      accountId: 'account_1',
      desktopDeviceId: 'desktop_1',
      storeEpoch: 'epoch_1',
      conversationId: 'thread_1',
      appliedSeq: appliedSeq,
      snapshotSeq: 0,
      historyRevision: 0,
      historyCursor: null,
      hasOlder: false,
      state: ConversationV2SyncState.catchingUp,
      error: null,
      updatedAt: '2026-09-14T00:00:00.000Z',
    );

ConversationV2Effect _messageAppendEffect(int seq) {
  final payload = <String, dynamic>{
    'type': 'message.append',
    'messageId': 'message_$seq',
    'baseContentVersion': 0,
    'nextContentVersion': 1,
    'delta': 'delta_$seq',
    'versionSeq': seq,
  };
  return ConversationV2Effect(
    seq: seq,
    effectVersion: 1,
    effectHash: conversationV2StableHash(payload),
    type: 'message.append',
    payload: payload,
  );
}

ConversationV2Effect _effect(int seq) => ConversationV2Effect(
  seq: seq,
  effectVersion: 1,
  effectHash: conversationV2StableHash(const {
    'type': 'noop',
    'reason': 'fixture',
  }),
  type: 'noop',
  payload: const {'type': 'noop', 'reason': 'fixture'},
);
