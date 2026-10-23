import 'dart:convert';
import 'dart:io';

import 'package:eco_mobile/dev/feed_replay_main.dart' as app;
import 'package:eco_mobile/features/threads/activity_feed.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  testWidgets('offline replay renders and advances the native mobile Feed', (
    tester,
  ) async {
    await app.main();
    await tester.pump();
    final replay = tester
        .widget<app.MobileFeedReplayApp>(find.byType(app.MobileFeedReplayApp))
        .replay;
    expect(replay.projection, isNotNull);
    expect(find.byType(ActivityFeedList), findsOneWidget);
    final start = replay.sequence;
    if (start < replay.eventCount) {
      await tester.tap(find.byKey(const ValueKey('replay-step')));
      await tester.pump(const Duration(milliseconds: 300));
      expect(replay.sequence, start + 1);
    }
    const throughSequence = int.fromEnvironment('ECO_REPLAY_THROUGH_SEQ');
    final end = throughSequence > 0 ? throughSequence : replay.eventCount;
    final until = throughSequence > 0
        ? end
        : (replay.sequence + 30).clamp(0, end);
    final playing = replay.play(speed: 20, maxGapMs: 10, through: until);
    while (replay.playing) {
      await tester.pump(const Duration(milliseconds: 50));
    }
    await playing;
    expect(replay.sequence, until);
    await replay.seek(end);
    await tester.pump(const Duration(milliseconds: 300));
    expect(replay.error, isNull);
    final list = tester.widget<ActivityFeedList>(find.byType(ActivityFeedList));
    final rows = list.entries;
    expect(rows, isNotEmpty);
    const toolSequence = int.fromEnvironment('ECO_REPLAY_TOOL_SEQ');
    const messageSequence = int.fromEnvironment('ECO_REPLAY_MESSAGE_SEQ');
    if (toolSequence > 0 && messageSequence > 0) {
      final process = rows.last.processEntries;
      final toolIndex = process.indexWhere(
        (entry) => entry.sequence == toolSequence,
      );
      final messageIndex = process.indexWhere(
        (entry) => entry.sequence == messageSequence,
      );
      expect(toolIndex, greaterThanOrEqualTo(0));
      expect(messageIndex, greaterThanOrEqualTo(0));
      expect(
        toolIndex.compareTo(messageIndex),
        toolSequence.compareTo(messageSequence),
        reason: '工具分组与正文必须保留录制顺序',
      );
    }
    final scroll = find.byType(Scrollable).last;
    await tester.drag(scroll, const Offset(0, -550));
    await tester.pump(const Duration(milliseconds: 300));
    await tester.drag(scroll, const Offset(0, 350));
    await tester.pump(const Duration(milliseconds: 300));
    debugPrint(
      'MOBILE_REPLAY_UI ${jsonEncode({'conversationId': replay.conversationId, 'fromSeq': start, 'throughSeq': until, 'finalSeq': replay.sequence, 'speed': 20, 'maxGapMs': 10, 'rows': rows.length, 'scrollPixels': list.scrollController.position.pixels, 'scrollExtent': list.scrollController.position.maxScrollExtent})}',
    );
    const tracePath = String.fromEnvironment('ECO_REPLAY_UI_TRACE');
    if (tracePath.isNotEmpty) {
      if (!tracePath.startsWith('/tmp/')) {
        throw ArgumentError('Trace must stay in /tmp.');
      }
      await File(tracePath).writeAsString(
        jsonEncode({
          'conversationId': replay.conversationId,
          'sequence': replay.sequence,
          'entries': rows
              .map((r) => {'kind': r.kind.name, 'id': r.id})
              .toList(),
        }),
      );
    }
    expect(tester.takeException(), isNull);
    // Keep the last rendered frame available for a simctl screenshot.
    await tester.pump(const Duration(seconds: 3));
    await tester.pumpWidget(const SizedBox.shrink());
  }, timeout: const Timeout(Duration(minutes: 4)));
}
