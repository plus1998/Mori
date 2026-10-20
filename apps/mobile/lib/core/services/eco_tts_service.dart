import 'dart:async';
import 'dart:ui';
import 'package:flutter/foundation.dart';
import 'package:flutter/scheduler.dart';
import 'package:flutter_tts/flutter_tts.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:uuid/uuid.dart';
import '../models/tts_models.dart';
import 'read_aloud_player.dart';
import 'system_tts_service.dart';

enum TtsPlaybackState { idle, preparing, speaking, failed }

enum TtsEngine { online, system }

/// Owns one playback on this device; remote generation never owns its audio output.
class EcoTtsService extends ChangeNotifier {
  EcoTtsService({
    FlutterTts? engine,
    ReadAloudRemote? Function()? remote,
    ReadAloudPlayer? player,
  }) : _system = SystemTtsService(engine: engine),
       _remote = remote ?? (() => null),
       _player = player ?? JustAudioReadAloudPlayer() {
    _system.addListener(_systemChanged);
  }
  final SystemTtsService _system;
  final ReadAloudRemote? Function() _remote;
  final ReadAloudPlayer _player;
  TtsPlaybackState _state = TtsPlaybackState.idle;
  TtsEngine _engine = TtsEngine.online;
  String? _activeEntryId;
  String? _lastError;
  ReadAloudRemote? _activeRemote;
  String? _requestId;
  int _generation = 0;
  bool _disposed = false;
  bool _notificationScheduled = false;
  Future<void>? _preferences;
  Future<void> _stopping = Future.value();

  TtsPlaybackState get state => _state;
  TtsEngine get engine => _engine;
  String? get activeEntryId => _activeEntryId;
  String? get lastError => _lastError;
  bool get isSpeaking => _state == TtsPlaybackState.speaking;
  bool isSpeakingEntry(String entryId) =>
      _activeEntryId == entryId &&
      (_state == TtsPlaybackState.speaking ||
          _state == TtsPlaybackState.preparing);

  Future<void> loadPreferences() => _preferences ??= () async {
    final prefs = await SharedPreferences.getInstance();
    if (_disposed) return;
    _engine = prefs.getString('read_aloud_engine') == 'system'
        ? TtsEngine.system
        : TtsEngine.online;
    _notify();
  }();

  Future<void> setEngine(TtsEngine engine) async {
    await loadPreferences();
    await stop();
    if (_disposed) return;
    _engine = engine;
    _notify();
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString('read_aloud_engine', engine.name);
  }

  Future<ReadAloudStatus> getOnlineStatus() async {
    final remote = _remote();
    if (remote == null) throw const ReadAloudException('请先连接一台在线的电脑。');
    return remote.getReadAloudStatus();
  }

  Future<bool> speak({
    required String entryId,
    required String sourceText,
    required Locale locale,
    String? threadId,
  }) async {
    final stopping = stop();
    final generation = _generation;
    bool active() => !_disposed && generation == _generation;
    try {
      await Future.wait([stopping, loadPreferences()]);
      if (!active()) return true;
      _activeEntryId = entryId;
      _lastError = null;
      _state = TtsPlaybackState.preparing;
      _notify();
      if (_engine == TtsEngine.system) {
        final started = await _system.speak(
          entryId: entryId,
          sourceText: sourceText,
          locale: locale,
        );
        if (!active()) return true;
        if (!started) {
          throw ReadAloudException(_system.lastError ?? '当前设备没有适用于正文语言的系统音色。');
        }
        return true;
      }
      final remote = _remote();
      if (remote == null) throw const ReadAloudException('请先连接一台在线的电脑。');
      if (threadId == null || threadId.isEmpty) {
        throw const ReadAloudException('无法确定朗读所属会话。');
      }
      _activeRemote = remote;
      final requestId = const Uuid().v4();
      _requestId = requestId;
      final result = await remote.startReadAloud(
        requestId: requestId,
        threadId: threadId,
        entryId: entryId,
        sourceText: sourceText,
      );
      if (!active()) return true;
      if (result.requestId != requestId || result.segmentCount < 1) {
        throw const ReadAloudException('朗读任务响应无效。');
      }
      Future<({Uint8List bytes, String mimeType})> prepare(int index) async {
        final meta = await remote.synthesizeReadAloudSegment(requestId, index);
        if (!active()) throw const ReadAloudException('朗读已停止。');
        if (meta.totalBytes < 1 ||
            meta.totalBytes > 64 * 1024 * 1024 ||
            !['audio/mpeg', 'audio/wav'].contains(meta.mimeType)) {
          throw const ReadAloudException('朗读音频响应无效。');
        }
        final bytes = Uint8List(meta.totalBytes);
        var offset = 0;
        while (offset < bytes.length) {
          final remaining = bytes.length - offset;
          final length = remaining < 65536 ? remaining : 65536;
          final chunk = await remote.readReadAloudChunk(
            requestId,
            index,
            offset,
            length,
          );
          if (!active()) throw const ReadAloudException('朗读已停止。');
          if (chunk.offset != offset ||
              chunk.totalBytes != bytes.length ||
              chunk.mimeType != meta.mimeType ||
              chunk.bytes.isEmpty ||
              chunk.bytes.length > length) {
            throw const ReadAloudException('朗读音频分块不完整或顺序无效。');
          }
          bytes.setRange(offset, offset + chunk.bytes.length, chunk.bytes);
          offset += chunk.bytes.length;
        }
        return (bytes: bytes, mimeType: meta.mimeType);
      }

      var pending = prepare(0);
      for (var index = 0; index < result.segmentCount; index++) {
        _state = TtsPlaybackState.preparing;
        _notify();
        final audio = await pending;
        if (!active()) return true;
        if (index + 1 < result.segmentCount) {
          pending = prepare(index + 1);
          // Observe errors immediately while the previous segment is playing.
          unawaited(
            pending.then<void>(
              (_) {},
              onError: (Object error, StackTrace stack) {
                if (active()) unawaited(_fail(error, entryId));
              },
            ),
          );
        }
        await _player.play(audio.bytes, audio.mimeType, () {
          if (active()) {
            _state = TtsPlaybackState.speaking;
            _notify();
          }
        });
        if (!active()) return _state != TtsPlaybackState.failed;
      }
      if (active()) await stop();
      return true;
    } catch (error) {
      if (!active()) return _state != TtsPlaybackState.failed;
      await _fail(error, entryId);
      return false;
    }
  }

  Future<void> connectionLost() async {
    if (_engine == TtsEngine.online &&
        _activeEntryId != null &&
        (_state == TtsPlaybackState.preparing ||
            _state == TtsPlaybackState.speaking)) {
      await _fail(
        const ReadAloudException('与电脑的连接已中断，朗读已停止，请重新连接后重试。'),
        _activeEntryId!,
      );
    }
  }

  Future<void> _fail(Object error, String entryId) async {
    final stopping = stop();
    final generation = _generation;
    _lastError = error.toString();
    _activeEntryId = entryId;
    _state = TtsPlaybackState.failed;
    _notify();
    await stopping;
    if (_disposed || generation != _generation) return;
  }

  void _systemChanged() {
    if (_disposed ||
        _engine != TtsEngine.system ||
        _activeEntryId == null ||
        (_state != TtsPlaybackState.preparing &&
            _state != TtsPlaybackState.speaking)) {
      return;
    }
    if (_system.lastError != null) {
      unawaited(_fail(ReadAloudException(_system.lastError!), _activeEntryId!));
      return;
    }
    if (_system.isSpeaking) {
      _state = TtsPlaybackState.speaking;
      _notify();
    } else if (_state == TtsPlaybackState.speaking) {
      _state = TtsPlaybackState.idle;
      _activeEntryId = null;
      _notify();
    }
  }

  Future<void> stop() {
    ++_generation;
    final changed =
        _state != TtsPlaybackState.idle ||
        _activeEntryId != null ||
        _lastError != null;
    final remote = _activeRemote;
    final requestId = _requestId;
    _activeRemote = null;
    _requestId = null;
    _state = TtsPlaybackState.idle;
    _activeEntryId = null;
    _lastError = null;
    if (changed) _notify();
    if (remote != null && requestId != null) {
      unawaited(
        remote.cancelReadAloud(requestId).catchError((Object _) {
          // Disconnected clients cannot deliver cancellation; Desktop expires idle tasks.
        }),
      );
    }
    return _stopping = _stopping.then((_) async {
      await Future.wait([_system.stop(), _player.stop()]);
    });
  }

  void _notify() {
    if (_disposed || _notificationScheduled) return;
    if (SchedulerBinding.instance.schedulerPhase ==
        SchedulerPhase.persistentCallbacks) {
      _notificationScheduled = true;
      SchedulerBinding.instance.addPostFrameCallback((_) {
        _notificationScheduled = false;
        if (!_disposed) notifyListeners();
      });
      return;
    }
    notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    unawaited(stop());
    _system.removeListener(_systemChanged);
    _system.dispose();
    unawaited(_player.dispose());
    super.dispose();
  }
}
