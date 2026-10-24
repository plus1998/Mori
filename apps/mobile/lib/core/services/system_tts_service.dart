import 'dart:async';
import 'dart:ui';

import 'package:flutter/foundation.dart';
import 'package:flutter_tts/flutter_tts.dart';

import '../models/tts_models.dart';
import '../utils/markdown_to_speech_text.dart';
import '../utils/speech_text_segments.dart';

enum SystemTtsState { idle, speaking }

/// Wraps the platform TTS engine for reading agent output aloud.
class SystemTtsService extends ChangeNotifier {
  SystemTtsService({FlutterTts? engine}) : _engine = engine ?? FlutterTts();

  final FlutterTts _engine;
  SystemTtsState _state = SystemTtsState.idle;
  String? _activeEntryId;
  String? lastError;
  bool _initialized = false;
  bool _disposed = false;
  int _playbackGeneration = 0;
  int _activeGeneration = 0;
  List<dynamic>? _cachedLanguages;
  List<Map<String, String>>? _cachedVoices;

  SystemTtsState get state => _state;
  String? get activeEntryId => _activeEntryId;
  bool get isSpeaking => _state == SystemTtsState.speaking;

  bool isSpeakingEntry(String entryId) =>
      _state == SystemTtsState.speaking && _activeEntryId == entryId;

  Future<void> _ensureInitialized() async {
    if (_initialized) return;
    _initialized = true;

    await _engine.setSpeechRate(0.5);
    await _engine.setVolume(1.0);
    await _engine.setPitch(1.0);

    _engine.setStartHandler(() {
      if (!_isActiveGeneration(_activeGeneration)) return;
      _state = SystemTtsState.speaking;
      notifyListeners();
    });

    _engine.setCompletionHandler(() {
      if (!_isActiveGeneration(_activeGeneration)) return;
      _finishPlayback();
    });

    _engine.setCancelHandler(() {
      if (!_isActiveGeneration(_activeGeneration)) return;
      _finishPlayback();
    });

    _engine.setErrorHandler((message) {
      lastError = message;
      if (!_isActiveGeneration(_activeGeneration)) return;
      _finishPlayback();
    });
  }

  bool _isActiveGeneration(int generation) => generation == _playbackGeneration;

  Future<void> _prepareAudioSession() async {
    if (kIsWeb || defaultTargetPlatform != TargetPlatform.iOS) return;

    // iOS shares this session with recording and online audio playback. Restore
    // it for every utterance, including after the previous one deactivated it.
    final configured = await _engine.setIosAudioCategory(
      IosTextToSpeechAudioCategory.playback,
      [IosTextToSpeechAudioCategoryOptions.duckOthers],
      IosTextToSpeechAudioMode.spokenAudio,
    );
    if (configured != 1) {
      throw const ReadAloudException('无法配置 iOS 朗读音频会话，请重试。');
    }
    final activated = await _engine.setSharedInstance(true);
    if (activated != 1) {
      throw const ReadAloudException('无法激活 iOS 朗读音频会话，请重试。');
    }
  }

  void _finishPlayback() {
    _state = SystemTtsState.idle;
    _activeEntryId = null;
    if (!_disposed) notifyListeners();
  }

  Future<List<String>> _installedLanguages() async {
    _cachedLanguages ??= await _engine.getLanguages;
    final languages = _cachedLanguages;
    if (languages == null) return const [];
    return languages.map((entry) => entry.toString()).toList(growable: false);
  }

  Future<List<Map<String, String>>> _installedVoices() async {
    if (_cachedVoices != null) return _cachedVoices!;

    final raw = await _engine.getVoices;
    if (raw is! List) {
      _cachedVoices = const [];
      return _cachedVoices!;
    }

    _cachedVoices = raw
        .whereType<Map>()
        .map(
          (voice) => voice.map(
            (key, value) => MapEntry(key.toString(), value?.toString() ?? ''),
          ),
        )
        .where((voice) => voice['locale']?.isNotEmpty ?? false)
        .toList(growable: false);
    return _cachedVoices!;
  }

  bool _languageTagMatches(String installed, String candidate) {
    final normalizedInstalled = installed.toLowerCase();
    final normalizedCandidate = candidate.toLowerCase();
    if (normalizedInstalled == normalizedCandidate) return true;
    if (normalizedInstalled.startsWith('$normalizedCandidate-')) return true;
    if (normalizedCandidate.startsWith('$normalizedInstalled-')) return true;

    final installedPrimary = normalizedInstalled.split('-').first;
    final candidatePrimary = normalizedCandidate.split('-').first;
    return installedPrimary == candidatePrimary;
  }

  String? _pickInstalledLanguage(
    List<String> installed,
    List<String> candidates, {
    required bool preferChinese,
  }) {
    for (final candidate in candidates) {
      for (final language in installed) {
        if (_languageTagMatches(language, candidate)) {
          return language;
        }
      }
    }

    if (preferChinese) {
      for (final language in installed) {
        if (isChineseLanguageTag(language)) return language;
      }
    } else {
      for (final language in installed) {
        final lower = language.toLowerCase();
        if (lower.startsWith('en')) return language;
      }
    }
    return null;
  }

  Future<bool> _trySetVoiceForLanguage(String languageTag) async {
    final voices = await _installedVoices();
    if (voices.isEmpty) return false;

    Map<String, String>? matched;
    for (final voice in voices) {
      final locale = voice['locale'] ?? '';
      if (_languageTagMatches(locale, languageTag)) {
        matched = voice;
        break;
      }
    }

    matched ??= _preferChineseVoice(voices, languageTag);
    if (matched == null) return false;

    final result = await _engine.setVoice(matched);
    return result == 1;
  }

  Map<String, String>? _preferChineseVoice(
    List<Map<String, String>> voices,
    String languageTag,
  ) {
    if (!isChineseLanguageTag(languageTag)) return null;
    for (final voice in voices) {
      final locale = voice['locale'] ?? '';
      if (isChineseLanguageTag(locale)) return voice;
    }
    return null;
  }

  Future<bool> _applySpeechLanguage(SpeechLanguagePlan plan) async {
    for (final candidate in plan.candidates) {
      final result = await _engine.setLanguage(candidate);
      if (result == 1) {
        await _trySetVoiceForLanguage(candidate);
        return true;
      }
    }

    final installed = await _installedLanguages();
    final resolved = _pickInstalledLanguage(
      installed,
      plan.candidates,
      preferChinese: plan.preferChinese,
    );
    if (resolved == null) return false;

    final languageResult = await _engine.setLanguage(resolved);
    if (languageResult == 1) {
      await _trySetVoiceForLanguage(resolved);
      return true;
    }

    return _trySetVoiceForLanguage(resolved);
  }

  Future<bool> speak({
    required String entryId,
    required String sourceText,
    required Locale locale,
  }) async {
    final generation = ++_playbackGeneration;
    _activeGeneration = generation;
    lastError = null;
    await _ensureInitialized();
    if (_disposed || !_isActiveGeneration(generation)) return false;

    final plainText = markdownToSpeechText(sourceText);
    if (plainText.isEmpty) return false;

    if (isSpeakingEntry(entryId)) {
      await stop();
      return true;
    }

    if (!_isActiveGeneration(generation)) return false;
    _activeEntryId = entryId;
    notifyListeners();

    final languageApplied = await _applySpeechLanguage(
      planSpeechLanguage(plainText, locale),
    );

    if (!_isActiveGeneration(generation)) return false;

    if (!languageApplied && containsChineseSpeechText(plainText)) {
      _finishPlayback();
      return false;
    }

    await _prepareAudioSession();
    if (_disposed || !_isActiveGeneration(generation)) return false;

    final result = await _engine.speak(plainText);
    if (!_isActiveGeneration(generation)) return false;

    if (result != 1) {
      _finishPlayback();
      return false;
    }
    return true;
  }

  Future<void> stop() async {
    _playbackGeneration++;
    _activeGeneration = _playbackGeneration;
    await _engine.stop();
    _finishPlayback();
  }

  @override
  void dispose() {
    _disposed = true;
    _playbackGeneration++;
    unawaited(_engine.stop());
    super.dispose();
  }
}
