import 'dart:io';

import 'package:eco_mobile/core/models/conversation_v2_models.dart';
import 'package:eco_mobile/core/storage/conversation_v2_cache.dart';
import 'package:eco_mobile/core/sync/conversation_v2_session.dart';
import 'package:eco_mobile/core/sync/conversation_v2_sync_engine.dart';
import 'package:eco_mobile/core/utils/conversation_v2_hash.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

void main() {
  sqfliteFfiInit();
  test(
    'a burst commits every effect while coalescing presentation reads',
    () async {
      final directory = await Directory.systemTemp.createTemp('eco-v2-burst-');
      final cache = _CountingCache('${directory.path}/cache.sqlite');
      final remote = _Remote();
      final controller = ConversationV2SessionController(
        conversationId: 'burst',
        cache: cache,
        remote: remote,
      );
      addTearDown(() async {
        await controller.close();
        controller.dispose();
        await directory.delete(recursive: true);
      });
      await controller.start();
      await Future<void>.delayed(Duration.zero);
      cache.messageReads = 0;
      final beforeCapabilities = remote.capabilityCalls;
      final operations = <Future<void>>[];
      for (var seq = 1; seq <= 100; seq++) {
        final effect = {'type': 'noop', 'reason': 'burst_$seq'};
        operations.add(
          controller.acceptPushEnvelope({
            'kind': 'conversation.sync_effect',
            'payload': {
              'conversationId': 'burst',
              'storeEpoch': 'epoch',
              'effect': {
                'seq': seq,
                'effectVersion': 1,
                'effectHash': conversationV2StableHash(effect),
                'effect': effect,
              },
            },
          }),
        );
      }
      await Future.wait(operations);
      expect((await cache.state('burst'))?.appliedSeq, 100);
      expect(controller.state.error, isNull);
      expect(cache.messageReads, lessThan(20));
      expect(remote.capabilityCalls - beforeCapabilities, 0);
    },
  );
}

class _CountingCache extends ConversationV2Cache {
  _CountingCache(String path)
    : super(
        accountId: 'smoke',
        desktopDeviceId: 'desktop',
        databasePath: path,
        databaseFactory: databaseFactoryFfi,
      );
  int messageReads = 0;
  @override
  Future<List<ConversationV2Message>> messages(String conversationId) {
    messageReads++;
    return super.messages(conversationId);
  }
}

class _Remote implements ConversationV2Remote {
  int capabilityCalls = 0;
  @override
  Future<ConversationV2Capabilities> capabilities() async {
    capabilityCalls++;
    return const ConversationV2Capabilities(
      protocolVersion: 2,
      eventSchemaVersion: 1,
      effectVersion: 1,
      maxEvents: 200,
      maxBytes: 512 * 1024,
      storeEpoch: 'epoch',
    );
  }

  @override
  Future<ConversationV2Bootstrap> bootstrap(
    String conversationId, {
    int pageSize = 30,
    int maxBytes = 512 * 1024,
  }) async => const ConversationV2Bootstrap(
    protocolVersion: 2,
    storeEpoch: 'epoch',
    conversationId: 'burst',
    snapshotSeq: 0,
    historyRevision: 0,
    messages: [],
    runs: [],
    tools: [],
    olderCursor: null,
    hasOlder: false,
  );
  @override
  Future<ConversationV2Head> head(String conversationId) async =>
      const ConversationV2Head(
        protocolVersion: 2,
        storeEpoch: 'epoch',
        conversationId: 'burst',
        lastSeq: 0,
        historyRevision: 0,
      );
  @override
  Future<ConversationV2ProjectionExtras> projectionExtras(
    String conversationId,
  ) async => const ConversationV2ProjectionExtras();
  @override
  dynamic noSuchMethod(Invocation invocation) =>
      throw UnimplementedError('$invocation');
}
