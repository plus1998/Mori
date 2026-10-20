import 'dart:io';
import 'dart:async';
import 'package:audio_session/audio_session.dart';
import 'package:flutter/foundation.dart';
import 'package:just_audio/just_audio.dart';
import 'package:path_provider/path_provider.dart';
import '../models/tts_models.dart';

abstract interface class ReadAloudPlayer {
  Future<void> play(Uint8List bytes, String mimeType, VoidCallback onStarted);
  Future<void> stop();
  Future<void> dispose();
}

class JustAudioReadAloudPlayer implements ReadAloudPlayer {
  AudioPlayer? _player;
  int _generation = 0;
  bool _disposed = false;

  @override
  Future<void> play(
    Uint8List bytes,
    String mimeType,
    VoidCallback onStarted,
  ) async {
    final generation = _generation;
    void ensureActive() {
      if (_disposed || generation != _generation) {
        throw const ReadAloudException('朗读已停止。');
      }
    }

    ensureActive();
    final player = _player ??= AudioPlayer();
    final session = await AudioSession.instance;
    ensureActive();
    await session.configure(const AudioSessionConfiguration.speech());
    ensureActive();
    final root = await getTemporaryDirectory();
    ensureActive();
    final directory = await root.createTemp('eco-read-aloud-');
    final errors = Completer<PlayerException>();
    final subscription = player.errorStream.listen((error) {
      if (!errors.isCompleted) errors.complete(error);
    });
    try {
      final file = File(
        '${directory.path}/speech.${mimeType == 'audio/wav' ? 'wav' : 'mp3'}',
      );
      await file.writeAsBytes(bytes, flush: true);
      ensureActive();
      await player.setFilePath(file.path);
      ensureActive();
      final playback = player.play();
      onStarted();
      final error = await Future.any<PlayerException?>([
        playback.then((_) => null),
        errors.future,
      ]);
      if (error != null) throw error;
      ensureActive();
      if (player.processingState != ProcessingState.completed) {
        throw const ReadAloudException('朗读播放被中断。');
      }
    } finally {
      await subscription.cancel();
      if (await directory.exists()) await directory.delete(recursive: true);
    }
  }

  @override
  Future<void> stop() async {
    ++_generation;
    await _player?.stop();
  }

  @override
  Future<void> dispose() async {
    _disposed = true;
    ++_generation;
    await _player?.stop();
    await _player?.dispose();
  }
}
