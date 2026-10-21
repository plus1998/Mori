import 'dart:convert';
import 'dart:io';

import 'package:eco_mobile/core/models/conversation_v2_models.dart';
import 'package:eco_mobile/core/storage/conversation_v2_cache.dart';
import 'package:eco_mobile/core/utils/conversation_v2_hash.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

void main() {
  sqfliteFfiInit();
  late ConversationV2Cache cache;

  setUp(() async {
    final directory = await Directory.systemTemp.createTemp('eco-v2-snapshot-');
    cache = ConversationV2Cache(
      accountId: 'snapshot-account',
      desktopDeviceId: 'snapshot-desktop',
      databaseFactory: databaseFactoryFfi,
      databasePath: '${directory.path}/cache.sqlite',
    );
    addTearDown(() async {
      await cache.close();
      await directory.delete(recursive: true);
    });
  });

  test(
    'an unknown conversation has no presentation state or entities',
    () async {
      final snapshot = await cache.presentationSnapshot('unknown');
      expect(snapshot.cacheState, isNull);
      expect(snapshot.messages, isEmpty);
      expect(snapshot.runs, isEmpty);
      expect(snapshot.tools, isEmpty);
      expect(snapshot.agents, isEmpty);
      expect(snapshot.todos, isEmpty);
    },
  );

  final fixtures = Directory(
    '../desktop/test/fixtures/feed-parity/v2-bootstrap',
  ).listSync().whereType<File>().where((file) => file.path.endsWith('.json'));
  for (final fixture in fixtures) {
    test(
      'snapshot preserves all cached collections: ${fixture.uri.pathSegments.last}',
      () async {
        final bootstrap = ConversationV2Bootstrap.fromJson(
          jsonDecode(fixture.readAsStringSync()),
        );
        await cache.installBootstrap(bootstrap);
        final id = bootstrap.conversationId;
        final snapshot = await cache.presentationSnapshot(id);
        expect(snapshot.cacheState?.appliedSeq, bootstrap.snapshotSeq);
        expect(snapshot.cacheState?.historyRevision, bootstrap.historyRevision);
        expect(snapshot.cacheState?.hasOlder, bootstrap.hasOlder);
        expect(
          snapshot.messages.map((item) => item.toJson()),
          (await cache.messages(id)).map((item) => item.toJson()),
        );
        expect(
          snapshot.runs.map((item) => item.toJson()),
          (await cache.runs(id)).map((item) => item.toJson()),
        );
        expect(
          snapshot.tools.map((item) => item.toJson()),
          (await cache.tools(id)).map((item) => item.toJson()),
        );
        expect(
          snapshot.agents.map((item) => item.toJson()),
          (await cache.agents(id)).map((item) => item.toJson()),
        );
        expect(
          snapshot.todos.map((item) => item.toJson()),
          (await cache.todos(id)).map((item) => item.toJson()),
        );

        // Old epoch rows remain in SQLite. They must not leak into a new epoch's
        // empty snapshot, even for the same conversation identity.
        await cache.installBootstrap(
          ConversationV2Bootstrap(
            protocolVersion: 2,
            storeEpoch: 'replacement-epoch',
            conversationId: id,
            snapshotSeq: 0,
            historyRevision: 0,
            messages: const [],
            runs: const [],
            tools: const [],
            olderCursor: null,
            hasOlder: false,
          ),
        );
        final replacement = await cache.presentationSnapshot(id);
        expect(replacement.cacheState?.storeEpoch, 'replacement-epoch');
        expect(replacement.messages, isEmpty);
        expect(replacement.runs, isEmpty);
        expect(replacement.tools, isEmpty);
        expect(replacement.agents, isEmpty);
        expect(replacement.todos, isEmpty);
      },
    );
  }

  test(
    'racing push writes cannot mix the cursor and message version',
    () async {
      await cache.installBootstrap(
        const ConversationV2Bootstrap(
          protocolVersion: 2,
          storeEpoch: 'epoch',
          conversationId: 'live',
          snapshotSeq: 1,
          historyRevision: 0,
          messages: [
            ConversationV2Message(
              messageId: 'answer',
              conversationId: 'live',
              turnId: 'turn',
              role: 'assistant',
              channel: 'answer',
              createdSeq: 1,
              versionSeq: 1,
              contentVersion: 0,
              body: '',
              status: ConversationV2MessageStatus.streaming,
              isDeleted: false,
            ),
          ],
          runs: [],
          tools: [],
          olderCursor: null,
          hasOlder: false,
        ),
      );
      for (var seq = 2; seq <= 20; seq++) {
        final payload = <String, dynamic>{
          'type': 'message.append',
          'messageId': 'answer',
          'baseContentVersion': seq - 2,
          'nextContentVersion': seq - 1,
          'delta': 'a',
        };
        final read = cache.presentationSnapshot('live');
        final write = cache.applySyncPage(
          ConversationV2SyncPage(
            protocolVersion: 2,
            storeEpoch: 'epoch',
            conversationId: 'live',
            fromSeq: seq,
            throughSeq: seq,
            headSeq: seq,
            hasMore: false,
            effects: [
              ConversationV2Effect(
                seq: seq,
                effectVersion: 1,
                effectHash: conversationV2StableHash(payload),
                type: 'message.append',
                payload: payload,
              ),
            ],
          ),
        );
        final snapshot = await read;
        await write;
        final message = snapshot.messages.single;
        expect(message.versionSeq, snapshot.cacheState!.appliedSeq);
        expect(message.body.length, snapshot.cacheState!.appliedSeq - 1);
      }
      final finalSnapshot = await cache.presentationSnapshot('live');
      expect(finalSnapshot.cacheState?.appliedSeq, 20);
      expect(finalSnapshot.messages.single.body, 'a' * 19);
    },
  );
}
