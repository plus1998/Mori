import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';
import 'package:eco_mobile/core/models/tts_models.dart';
import 'package:eco_mobile/core/services/eco_tts_service.dart';
import 'package:eco_mobile/core/services/read_aloud_player.dart';
import 'package:eco_mobile/core/utils/activity_feed_speak_candidate.dart';
import 'package:eco_mobile/core/utils/markdown_to_speech_text.dart';
import 'package:eco_mobile/features/threads/activity_feed.dart';
import 'package:eco_mobile/core/providers/app_providers.dart';
import 'package:eco_mobile/core/providers/activity_feed_auto_read_provider.dart';
import 'package:eco_mobile/core/models/eco_types.dart';
import 'package:eco_mobile/core/widgets/activity_feed_auto_read_listener.dart';
import 'package:eco_mobile/core/widgets/activity_feed_speak_button.dart';
import 'package:eco_mobile/core/widgets/read_aloud_thread_scope.dart';
import 'package:eco_mobile/l10n/generated/app_localizations.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_tts/flutter_tts.dart';
import 'package:shared_preferences/shared_preferences.dart';

class _Engine extends FlutterTts {
  @override
  Future<dynamic> stop() async => 1;
}

class _Remote implements ReadAloudRemote {
  final segments = <int>[];
  final cancelled = <String>[];
  Completer<ReadAloudStartResult>? delayedStart;
  Completer<ReadAloudSegmentResult>? delayedSecond;
  String? requestId;
  @override
  Future<ReadAloudStatus> getReadAloudStatus() async =>
      const ReadAloudStatus(available: true);
  @override
  Future<ReadAloudStartResult> startReadAloud({
    required String requestId,
    required String threadId,
    required String entryId,
    required String sourceText,
  }) async {
    this.requestId = requestId;
    return delayedStart == null
        ? ReadAloudStartResult(requestId, 3)
        : delayedStart!.future;
  }

  @override
  Future<ReadAloudSegmentResult> synthesizeReadAloudSegment(
    String requestId,
    int index,
  ) async {
    segments.add(index);
    if (index == 1 && delayedSecond != null) return delayedSecond!.future;
    return const ReadAloudSegmentResult('audio/wav', 1);
  }

  @override
  Future<ReadAloudChunk> readReadAloudChunk(
    String requestId,
    int index,
    int offset,
    int length,
  ) async => ReadAloudChunk(
    bytes: Uint8List.fromList([index]),
    offset: offset,
    totalBytes: 1,
    mimeType: 'audio/wav',
  );
  @override
  Future<void> cancelReadAloud(String requestId) async {
    cancelled.add(requestId);
  }
}

class _Player implements ReadAloudPlayer {
  final played = <int>[];
  Completer<void>? completion;
  @override
  Future<void> play(
    Uint8List bytes,
    String mimeType,
    void Function() onStarted,
  ) async {
    played.add(bytes.first);
    completion = Completer<void>();
    onStarted();
    await completion!.future;
  }

  void finish() {
    final current = completion;
    completion = null;
    if (current != null && !current.isCompleted) current.complete();
  }

  @override
  Future<void> stop() async {
    finish();
  }

  @override
  Future<void> dispose() async {
    finish();
  }
}

Future<void> _until(bool Function() condition) async {
  for (var i = 0; i < 50 && !condition(); i++) {
    await Future<void>.delayed(const Duration(milliseconds: 1));
  }
  expect(condition(), isTrue);
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUp(() {
    SharedPreferences.setMockInitialValues({});
  });
  test('Markdown conversion matches the shared TypeScript fixtures', () {
    final cases =
        jsonDecode(
              File(
                '../../packages/shared/test/fixtures/speech-text.json',
              ).readAsStringSync(),
            )
            as List;
    for (final entry in cases) {
      expect(
        markdownToSpeechText(entry['source'] as String),
        entry['expected'],
      );
    }
  });
  test(
    'online is the default, starts the first segment and prepares only one ahead',
    () async {
      final remote = _Remote();
      final player = _Player();
      final service = EcoTtsService(
        engine: _Engine(),
        remote: () => remote,
        player: player,
      );
      addTearDown(service.dispose);
      expect(service.engine, TtsEngine.online);
      final playback = service.speak(
        entryId: 'entry',
        sourceText: '正文',
        locale: const Locale('zh'),
        threadId: 'thread',
      );
      await _until(
        () => player.played.length == 1 && remote.segments.length == 2,
      );
      expect(player.played, [0]);
      expect(remote.segments, [0, 1]);
      player.finish();
      await _until(
        () => player.played.length == 2 && remote.segments.length == 3,
      );
      player.finish();
      await _until(() => player.played.length == 3);
      player.finish();
      expect(await playback, isTrue);
      expect(service.state, TtsPlaybackState.idle);
    },
  );
  test(
    'stopping during preparation cancels before a late start response',
    () async {
      final remote = _Remote()..delayedStart = Completer();
      final player = _Player();
      final service = EcoTtsService(
        engine: _Engine(),
        remote: () => remote,
        player: player,
      );
      addTearDown(service.dispose);
      final playback = service.speak(
        entryId: 'entry',
        sourceText: '正文',
        locale: const Locale('zh'),
        threadId: 'thread',
      );
      await _until(() => remote.requestId != null);
      expect(service.isSpeakingEntry('entry'), isTrue);
      await service.stop();
      remote.delayedStart!.complete(ReadAloudStartResult(remote.requestId!, 3));
      await playback;
      expect(player.played, isEmpty);
      expect(remote.cancelled, [remote.requestId]);
    },
  );
  test(
    'failed prefetch stops playback and preserves the actual provider error',
    () async {
      final remote = _Remote()..delayedSecond = Completer();
      final player = _Player();
      final service = EcoTtsService(
        engine: _Engine(),
        remote: () => remote,
        player: player,
      );
      addTearDown(service.dispose);
      final playback = service.speak(
        entryId: 'entry',
        sourceText: '正文',
        locale: const Locale('zh'),
        threadId: 'thread',
      );
      await _until(() => player.played.length == 1);
      remote.delayedSecond!.completeError(const ReadAloudException('429: 限流'));
      expect(await playback, isFalse);
      expect(service.state, TtsPlaybackState.failed);
      expect(service.lastError, '429: 限流');
      expect(player.played, [0]);
    },
  );
  test(
    'missing computer fails explicitly and never invokes the local engine',
    () async {
      final service = EcoTtsService(engine: _Engine(), player: _Player());
      addTearDown(service.dispose);
      expect(
        await service.speak(
          entryId: 'entry',
          sourceText: '正文',
          locale: const Locale('zh'),
          threadId: 'thread',
        ),
        isFalse,
      );
      expect(service.lastError, contains('电脑'));
      expect(service.engine, TtsEngine.online);
      await service.setEngine(TtsEngine.system);
      expect(
        (await SharedPreferences.getInstance()).getString('read_aloud_engine'),
        'system',
      );
    },
  );
  test(
    'auto-read ignores history, backfill, other turns and repeated final updates',
    () {
      final tracker = ReadAloudAutoReadTracker();
      const old = ActivityFeedSpeakCandidate(
        id: 'old',
        text: '旧回复',
        streaming: false,
        runId: 'old-run',
      );
      const next = ActivityFeedSpeakCandidate(
        id: 'new',
        text: '新回复',
        streaming: false,
        runId: 'new-run',
      );
      expect(tracker.observe('thread', false, old, true), isNull);
      tracker.observe('thread', true, old, true, runningRunId: 'new-run');
      expect(tracker.observe('thread', false, old, true), isNull);
      expect(tracker.observe('thread', false, next, true), next);
      expect(tracker.observe('thread', false, next, true), isNull);
      expect(tracker.observe('other', false, next, true), isNull);
    },
  );
  test(
    'auto-read handles a completed reply while the next queued turn is running',
    () {
      final tracker = ReadAloudAutoReadTracker();
      const first = ActivityFeedSpeakCandidate(
        id: 'first',
        text: '第一条',
        streaming: false,
        runId: 'run-1',
      );
      const second = ActivityFeedSpeakCandidate(
        id: 'second',
        text: '第二条',
        streaming: false,
        runId: 'run-2',
      );
      tracker.observe('thread', true, null, true, runningRunId: 'run-1');
      expect(
        tracker.observe('thread', true, first, true, runningRunId: 'run-2'),
        first,
      );
      expect(
        tracker.observe('thread', true, first, true, runningRunId: 'run-2'),
        isNull,
      );
      expect(tracker.observe('thread', false, second, true), second);
    },
  );
  test('only completed final output is an auto-read candidate', () {
    const output = ActivityFeedEntry(
      id: 'final',
      kind: ActivityFeedKind.assistant,
      text: '最终输出',
    );
    expect(findLatestFinalAssistantSpeakCandidate(const [output]), isNull);
    expect(
      findLatestFinalAssistantSpeakCandidate(const [
        ActivityFeedEntry(
          id: 'turn',
          kind: ActivityFeedKind.turn,
          text: '',
          turnStatus: 'cancelled',
          finalOutput: output,
        ),
      ]),
      isNull,
    );
    expect(
      findLatestFinalAssistantSpeakCandidate(const [
        ActivityFeedEntry(
          id: 'turn',
          kind: ActivityFeedKind.turn,
          text: '',
          turnStatus: 'completed',
          finalOutput: output,
        ),
      ])?.id,
      'final',
    );
  });
  testWidgets(
    'reconnect catch-up establishes a baseline without reading historical completion',
    (tester) async {
      final remote = _Remote();
      final player = _Player();
      final service = EcoTtsService(
        engine: _Engine(),
        remote: () => remote,
        player: player,
      );
      final connection = StreamController<CenterServerConnectionStatus>();
      var running = true;
      var ready = true;
      var entries = const <ActivityFeedEntry>[
        ActivityFeedEntry(
          id: 'turn',
          kind: ActivityFeedKind.turn,
          text: '',
          running: true,
          runAttemptId: 'run',
        ),
      ];
      late StateSetter update;
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            ecoTtsServiceProvider.overrideWith((ref) => service),
            activityFeedAutoReadBootstrapProvider.overrideWithValue(true),
            connectionStatusProvider.overrideWith((ref) => connection.stream),
          ],
          child: MaterialApp(
            home: StatefulBuilder(
              builder: (context, setState) {
                update = setState;
                return Scaffold(
                  body: ActivityFeedAutoReadListener(
                    threadId: 'thread',
                    entries: entries,
                    running: running,
                    ready: ready,
                    child: const Text('feed'),
                  ),
                );
              },
            ),
          ),
        ),
      );
      connection.add(
        const CenterServerConnectionStatus(state: EcoConnectionState.connected),
      );
      await tester.pump();
      update(() {});
      await tester.pump();
      connection.add(
        const CenterServerConnectionStatus(
          state: EcoConnectionState.disconnected,
        ),
      );
      await tester.pump();
      update(() {
        ready = false;
        running = false;
        entries = const [
          ActivityFeedEntry(
            id: 'turn',
            kind: ActivityFeedKind.turn,
            text: '',
            runAttemptId: 'run',
            turnStatus: 'completed',
            finalOutput: ActivityFeedEntry(
              id: 'final',
              kind: ActivityFeedKind.assistant,
              text: '离线期间完成的回复',
            ),
          ),
        ];
      });
      await tester.pump();
      connection.add(
        const CenterServerConnectionStatus(state: EcoConnectionState.connected),
      );
      await tester.pump();
      update(() => ready = true);
      await tester.pump();
      expect(remote.requestId, isNull);
      expect(player.played, isEmpty);
      await tester.pumpWidget(const SizedBox());
      await tester.runAsync(connection.close);
    },
  );
  testWidgets(
    'message button remains stoppable during preparation and rejects late audio',
    (tester) async {
      final remote = _Remote()..delayedStart = Completer();
      final player = _Player();
      final service = EcoTtsService(
        engine: _Engine(),
        remote: () => remote,
        player: player,
      );
      await tester.pumpWidget(
        ProviderScope(
          overrides: [ecoTtsServiceProvider.overrideWith((ref) => service)],
          child: const MaterialApp(
            localizationsDelegates: AppLocalizations.localizationsDelegates,
            supportedLocales: AppLocalizations.supportedLocales,
            locale: Locale('zh'),
            home: Scaffold(
              body: ReadAloudThreadScope(
                threadId: 'thread',
                child: ActivityFeedSpeakButton(
                  entryId: 'entry',
                  sourceText: '正文',
                ),
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.byType(IconButton));
      await tester.pump();
      await tester.pump();
      expect(find.byType(CircularProgressIndicator), findsOneWidget);
      await tester.tap(find.byType(IconButton));
      await tester.pump();
      expect(service.state, TtsPlaybackState.idle);
      remote.delayedStart!.complete(ReadAloudStartResult(remote.requestId!, 3));
      await tester.pump();
      expect(player.played, isEmpty);
      expect(find.byType(SnackBar), findsNothing);
      await tester.pumpWidget(const SizedBox());
    },
  );
}
