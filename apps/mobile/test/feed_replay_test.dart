import 'dart:convert';
import 'dart:io';

import 'package:eco_mobile/core/models/conversation_v2_models.dart';
import 'package:eco_mobile/core/storage/conversation_v2_cache.dart';
import 'package:eco_mobile/core/utils/conversation_v2_hash.dart';
import 'package:eco_mobile/dev/feed_replay.dart';
import 'package:eco_mobile/features/threads/activity_feed.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

Map<String, dynamic> _fixture() {
  final message = ConversationV2Message(
    messageId: 'm1',
    conversationId: 'thread',
    turnId: 'turn',
    role: 'assistant',
    channel: 'answer',
    createdSeq: 1,
    versionSeq: 1,
    contentVersion: 0,
    body: 'hello',
    status: ConversationV2MessageStatus.streaming,
    isDeleted: false,
  );
  final effects = [
    {'type': 'message.create', 'message': message.toJson()},
    {
      'type': 'message.append',
      'messageId': 'm1',
      'baseContentVersion': 0,
      'nextContentVersion': 1,
      'delta': ' world',
      'versionSeq': 2,
    },
  ];
  return {
    'formatVersion': 2,
    'protocolVersion': 2,
    'conversationId': 'thread',
    'storeEpoch': 'epoch',
    'thread': {'id': 'thread', 'title': 'Synthetic'},
    'coverage': <String>[],
    'detailItems': <dynamic>[],
    'events': [
      for (var i = 0; i < effects.length; i++)
        {
          'seq': i + 1,
          'effectVersion': 1,
          'effectHash': conversationV2StableHash(effects[i]),
          'effect': effects[i],
          'at': i * 1000,
        },
    ],
  };
}

ConversationV2Cache _cache() => ConversationV2Cache(
  accountId: 'replay',
  desktopDeviceId: 'replay',
  databaseFactory: databaseFactoryFfi,
  databasePath: inMemoryDatabasePath,
);

void main() {
  sqfliteFfiInit();
  test('rejects gaps and corrupt effects before applying any event', () {
    final badHash = _fixture();
    (badHash['events'] as List)[0]['effectHash'] = 'corrupt';
    expect(() => MobileFeedReplay(badHash, _cache()), throwsFormatException);
    final gap = _fixture();
    (gap['events'] as List)[1]['seq'] = 3;
    expect(() => MobileFeedReplay(gap, _cache()), throwsFormatException);
  });

  test(
    'seek rebuilds state and playback uses the production effect reducer',
    () async {
      final replay = MobileFeedReplay(_fixture(), _cache());
      addTearDown(replay.close);
      await replay.seek(1);
      expect(replay.projection!.timeline.single.text, 'hello');
      await replay.play(speed: 20, maxGapMs: 0);
      expect(replay.sequence, 2);
      expect(replay.projection!.timeline.single.text, 'hello world');
      await replay.seek(0);
      expect(replay.projection!.timeline, isEmpty);
      await replay.step();
      expect(replay.projection!.timeline.single.text, 'hello');
    },
  );

  const path = String.fromEnvironment('ECO_REPLAY_FIXTURE');
  if (path.isNotEmpty) {
    test('replays a private desktop export through the mobile Feed', () async {
      final replay = MobileFeedReplay(
        Map<String, dynamic>.from(
          jsonDecode(await File(path).readAsString()) as Map,
        ),
        _cache(),
      );
      addTearDown(replay.close);
      final checkpoints = const String.fromEnvironment(
        'ECO_REPLAY_CHECKPOINTS',
      ).split(',').where((s) => s.isNotEmpty).map(int.parse).toList();
      final trace = <Object>[];
      for (final seq
          in checkpoints.isEmpty ? [replay.eventCount] : checkpoints) {
        await replay.seek(seq);
        final entries = buildActivityFeed(runProjection: replay.projection);
        trace.add({
          'seq': seq,
          'timeline': [
            for (final row in replay.projection!.timeline)
              {
                'id': row.id,
                'seq': row.sequence,
                'at': row.at,
                'type': row.eventType,
                'text': row.text.substring(0, row.text.length.clamp(0, 100)),
              },
          ],
          'feed': entries.map(_entry).toList(),
        });
      }
      const tracePath = String.fromEnvironment('ECO_REPLAY_TRACE');
      if (tracePath.isNotEmpty) {
        if (!tracePath.startsWith('/tmp/')) {
          throw ArgumentError('Trace must stay in /tmp.');
        }
        await File(
          tracePath,
        ).writeAsString(const JsonEncoder.withIndent('  ').convert(trace));
      }
      expect(
        replay.sequence,
        checkpoints.isEmpty ? replay.eventCount : checkpoints.last,
      );
    });
  }
}

Map<String, dynamic> _entry(ActivityFeedEntry entry) => {
  'id': entry.id,
  'seq': entry.sequence,
  'at': entry.at,
  'kind': entry.kind.name,
  'text': entry.text.substring(0, entry.text.length.clamp(0, 160)),
  'process': entry.processEntries.map(_entry).toList(),
  'actions': entry.actionChildren.map(_entry).toList(),
  if (entry.finalOutput != null) 'final': _entry(entry.finalOutput!),
};
