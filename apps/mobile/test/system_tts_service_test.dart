import 'dart:ui';

import 'package:eco_mobile/core/services/eco_tts_service.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_tts/flutter_tts.dart';
import 'package:shared_preferences/shared_preferences.dart';

class _Engine extends FlutterTts {
  final calls = <String>[];
  bool sessionConfigured = false;
  bool sessionActive = false;
  int categoryResult = 1;
  int activationResult = 1;
  VoidCallback? onStart;
  VoidCallback? onComplete;

  @override
  Future<dynamic> setSpeechRate(double rate) async => 1;
  @override
  Future<dynamic> setVolume(double volume) async => 1;
  @override
  Future<dynamic> setPitch(double pitch) async => 1;
  @override
  Future<dynamic> setLanguage(String language) async => 1;
  @override
  Future<dynamic> get getVoices async => <Map<String, String>>[];
  @override
  void setStartHandler(VoidCallback callback) => onStart = callback;
  @override
  void setCompletionHandler(VoidCallback callback) => onComplete = callback;

  @override
  Future<dynamic> setIosAudioCategory(
    IosTextToSpeechAudioCategory category,
    List<IosTextToSpeechAudioCategoryOptions> options, [
    IosTextToSpeechAudioMode mode = IosTextToSpeechAudioMode.defaultMode,
  ]) async {
    expect(category, IosTextToSpeechAudioCategory.playback);
    expect(mode, IosTextToSpeechAudioMode.spokenAudio);
    calls.add('configure');
    sessionConfigured = categoryResult == 1;
    return categoryResult;
  }

  @override
  Future<dynamic> setSharedInstance(bool sharedSession) async {
    calls.add('activate');
    sessionActive = sharedSession && activationResult == 1;
    return activationResult;
  }

  @override
  Future<dynamic> speak(String text, {bool focus = false}) async {
    calls.add('speak');
    expect(text, '你好，手机。');
    if (defaultTargetPlatform == TargetPlatform.iOS) {
      expect(sessionConfigured, isTrue);
      expect(sessionActive, isTrue);
    }
    onStart?.call();
    return 1;
  }

  void finish() {
    // A completed utterance or another audio plugin can deactivate/change it.
    sessionActive = false;
    sessionConfigured = false;
    onComplete?.call();
  }

  @override
  Future<dynamic> stop() async => 1;
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUp(() {
    SharedPreferences.setMockInitialValues({'read_aloud_engine': 'system'});
    debugDefaultTargetPlatformOverride = TargetPlatform.iOS;
  });
  tearDown(() => debugDefaultTargetPlatformOverride = null);

  Future<bool> speak(EcoTtsService service) => service.speak(
    entryId: 'entry',
    sourceText: '**你好，手机。**',
    locale: const Locale('zh'),
  );

  test(
    'saved system engine speaks locally and restores iOS audio each time',
    () async {
      final engine = _Engine();
      final service = EcoTtsService(
        engine: engine,
        remote: () =>
            throw StateError('System speech must not contact Desktop'),
      );
      addTearDown(service.dispose);
      expect(await speak(service), isTrue);
      expect(service.engine, TtsEngine.system);
      expect(service.state, TtsPlaybackState.speaking);
      engine.finish();
      expect(service.state, TtsPlaybackState.idle);
      expect(await speak(service), isTrue);
      expect(engine.calls, [
        'configure',
        'activate',
        'speak',
        'configure',
        'activate',
        'speak',
      ]);
    },
  );

  for (final failActivation in [false, true]) {
    test(
      'iOS ${failActivation ? 'activation' : 'configuration'} failure is explicit and retryable',
      () async {
        final engine = _Engine()
          ..categoryResult = failActivation ? 1 : 0
          ..activationResult = failActivation ? 0 : 1;
        final service = EcoTtsService(engine: engine);
        addTearDown(service.dispose);
        expect(await speak(service), isFalse);
        expect(service.state, TtsPlaybackState.failed);
        expect(service.lastError, contains('音频会话'));
        expect(engine.calls, isNot(contains('speak')));
        engine.categoryResult = 1;
        engine.activationResult = 1;
        expect(await speak(service), isTrue);
      },
    );
  }

  test('Android system speech does not use iOS audio session APIs', () async {
    debugDefaultTargetPlatformOverride = TargetPlatform.android;
    final engine = _Engine();
    final service = EcoTtsService(engine: engine);
    addTearDown(service.dispose);
    expect(await speak(service), isTrue);
    expect(engine.calls, ['speak']);
  });
}
