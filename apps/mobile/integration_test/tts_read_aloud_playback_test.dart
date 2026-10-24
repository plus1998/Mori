import 'dart:async';
import 'dart:math';
import 'dart:typed_data';
import 'package:eco_mobile/core/models/tts_models.dart';
import 'package:eco_mobile/core/providers/app_providers.dart';
import 'package:eco_mobile/core/models/eco_types.dart';
import 'package:eco_mobile/core/services/eco_tts_service.dart';
import 'package:eco_mobile/core/services/read_aloud_player.dart';
import 'package:eco_mobile/core/widgets/tts_lifecycle_binder.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_tts/flutter_tts.dart';
import 'package:integration_test/integration_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

Uint8List _wav() {
  const rate = 24000;
  const samples = rate ~/ 2;
  final data = ByteData(44 + samples * 2);
  void ascii(int at, String text) {
    for (var i = 0; i < text.length; i++) {
      data.setUint8(at + i, text.codeUnitAt(i));
    }
  }

  ascii(0, 'RIFF');
  data.setUint32(4, 36 + samples * 2, Endian.little);
  ascii(8, 'WAVEfmt ');
  data.setUint32(16, 16, Endian.little);
  data.setUint16(20, 1, Endian.little);
  data.setUint16(22, 1, Endian.little);
  data.setUint32(24, rate, Endian.little);
  data.setUint32(28, rate * 2, Endian.little);
  data.setUint16(32, 2, Endian.little);
  data.setUint16(34, 16, Endian.little);
  ascii(36, 'data');
  data.setUint32(40, samples * 2, Endian.little);
  for (var i = 0; i < samples; i++) {
    data.setInt16(
      44 + i * 2,
      (sin(i * 2 * pi * 440 / rate) * 600).round(),
      Endian.little,
    );
  }
  return data.buffer.asUint8List();
}

class _Engine extends FlutterTts {
  @override
  Future<dynamic> stop() async => 1;
}

class _ObservedSystemEngine extends FlutterTts {
  int started = 0;
  int completed = 0;

  @override
  void setStartHandler(VoidCallback callback) {
    super.setStartHandler(() {
      started++;
      callback();
    });
  }

  @override
  void setCompletionHandler(VoidCallback callback) {
    super.setCompletionHandler(() {
      completed++;
      callback();
    });
  }
}

class _Remote implements ReadAloudRemote {
  final bytes = _wav();
  final second = Completer<ReadAloudSegmentResult>();
  final requested = <int>[];
  int cancelled = 0;
  @override
  Future<ReadAloudStatus> getReadAloudStatus() async =>
      const ReadAloudStatus(available: true);
  @override
  Future<ReadAloudStartResult> startReadAloud({
    required String requestId,
    required String threadId,
    required String entryId,
    required String sourceText,
  }) async => ReadAloudStartResult(requestId, 3);
  @override
  Future<ReadAloudSegmentResult> synthesizeReadAloudSegment(
    String requestId,
    int index,
  ) async {
    requested.add(index);
    return index == 1
        ? second.future
        : ReadAloudSegmentResult('audio/wav', bytes.length);
  }

  @override
  Future<ReadAloudChunk> readReadAloudChunk(
    String requestId,
    int index,
    int offset,
    int length,
  ) async => ReadAloudChunk(
    bytes: Uint8List.sublistView(
      bytes,
      offset,
      min(offset + length, bytes.length),
    ),
    offset: offset,
    totalBytes: bytes.length,
    mimeType: 'audio/wav',
  );
  @override
  Future<void> cancelReadAloud(String requestId) async {
    cancelled++;
  }
}

class _ObservedPlayer implements ReadAloudPlayer {
  final native = JustAudioReadAloudPlayer();
  int started = 0;
  @override
  Future<void> play(
    Uint8List bytes,
    String mimeType,
    void Function() onStarted,
  ) => native.play(bytes, mimeType, () {
    started++;
    onStarted();
  });
  @override
  Future<void> stop() => native.stop();
  @override
  Future<void> dispose() => native.dispose();
}

Future<void> _until(bool Function() condition) async {
  final end = DateTime.now().add(const Duration(seconds: 20));
  while (!condition() && DateTime.now().isBefore(end)) {
    await Future<void>.delayed(const Duration(milliseconds: 20));
  }
  expect(condition(), isTrue);
}

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  testWidgets(
    'native audio plays the first WAV before the next segment is ready, then completes in order',
    (tester) async {
      SharedPreferences.setMockInitialValues({});
      final remote = _Remote();
      final player = _ObservedPlayer();
      final service = EcoTtsService(
        engine: _Engine(),
        remote: () => remote,
        player: player,
      );
      await tester.pumpWidget(
        const MaterialApp(home: Scaffold(body: Text('TTS playback test'))),
      );
      await tester.runAsync(() async {
        final playback = service.speak(
          entryId: 'entry',
          sourceText: '测试分段播放',
          locale: const Locale('zh'),
          threadId: 'thread',
        );
        await _until(() => player.started == 1);
        expect(remote.requested, [0, 1]);
        expect(remote.second.isCompleted, isFalse);
        remote.second.complete(
          ReadAloudSegmentResult('audio/wav', remote.bytes.length),
        );
        expect(
          await playback.timeout(const Duration(seconds: 30)),
          isTrue,
          reason: service.lastError,
        );
        expect(player.started, 3);
        expect(service.state, TtsPlaybackState.idle);
        service.dispose();
      });
    },
  );
  testWidgets(
    'background lifecycle stops native playback and late audio cannot restart it',
    (tester) async {
      SharedPreferences.setMockInitialValues({});
      final remote = _Remote();
      final player = _ObservedPlayer();
      final service = EcoTtsService(
        engine: _Engine(),
        remote: () => remote,
        player: player,
      );
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            ecoTtsServiceProvider.overrideWith((ref) => service),
            connectionStatusProvider.overrideWith(
              (ref) => Stream.value(
                const CenterServerConnectionStatus(
                  state: EcoConnectionState.connected,
                ),
              ),
            ),
          ],
          child: const MaterialApp(
            home: TtsLifecycleBinder(
              child: Scaffold(body: Text('TTS lifecycle test')),
            ),
          ),
        ),
      );
      await tester.runAsync(() async {
        final playback = service.speak(
          entryId: 'entry',
          sourceText: '测试后台停止',
          locale: const Locale('zh'),
          threadId: 'thread',
        );
        await _until(() => player.started == 1);
        tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
        await _until(() => service.state == TtsPlaybackState.idle);
        remote.second.complete(
          ReadAloudSegmentResult('audio/wav', remote.bytes.length),
        );
        await playback;
        tester.binding.handleAppLifecycleStateChanged(
          AppLifecycleState.resumed,
        );
        await Future<void>.delayed(const Duration(milliseconds: 300));
        expect(player.started, 1);
        expect(remote.cancelled, 1);
      });
      await tester.pumpWidget(const SizedBox());
    },
  );
  testWidgets(
    'system engine reads Chinese locally and restores iOS audio after recording',
    (tester) async {
      SharedPreferences.setMockInitialValues({'read_aloud_engine': 'system'});
      final engine = _ObservedSystemEngine();
      final service = EcoTtsService(
        engine: engine,
        remote: () => throw StateError('Local speech must not use Desktop'),
      );
      await tester.pumpWidget(
        const MaterialApp(home: Scaffold(body: Text('System TTS test'))),
      );
      await tester.runAsync(() async {
        try {
          for (var index = 1; index <= 2; index++) {
            // Reproduce the shared session left by a recorder, including a
            // deactivated session before the second utterance.
            await engine.setIosAudioCategory(
              IosTextToSpeechAudioCategory.playAndRecord,
              [IosTextToSpeechAudioCategoryOptions.defaultToSpeaker],
              IosTextToSpeechAudioMode.voiceChat,
            );
            await engine.setSharedInstance(false);
            expect(
              await service.speak(
                entryId: 'local-$index',
                sourceText: '你好，这是手机本地朗读。',
                locale: const Locale('zh'),
              ),
              isTrue,
              reason: service.lastError,
            );
            await _until(() => engine.started == index);
            await _until(() => engine.completed == index);
            expect(service.state, TtsPlaybackState.idle);
          }
        } finally {
          service.dispose();
        }
      });
    },
  );
}
