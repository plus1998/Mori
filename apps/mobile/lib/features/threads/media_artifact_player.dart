import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:just_audio/just_audio.dart';
import 'package:path_provider/path_provider.dart';
import 'package:video_player/video_player.dart';

import '../../core/locale/app_localizations_ext.dart';
import '../../core/models/image_view_models.dart';

/// Plays the downloaded artifact locally; the desktop file path is never used on mobile.
class MediaArtifactPlayer extends StatefulWidget {
  const MediaArtifactPlayer({super.key, required this.data});

  final ImageViewReadData data;

  @override
  State<MediaArtifactPlayer> createState() => _MediaArtifactPlayerState();
}

class _MediaArtifactPlayerState extends State<MediaArtifactPlayer>
    with WidgetsBindingObserver {
  VideoPlayerController? _video;
  AudioPlayer? _audio;
  Directory? _directory;
  final List<StreamSubscription<dynamic>> _subscriptions = [];
  late final Future<void> _initialization;
  var _ready = false;
  String? _error;
  Duration _audioPosition = Duration.zero;
  Duration _audioDuration = Duration.zero;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _initialization = _initialize();
  }

  Future<void> _initialize() async {
    try {
      final root = await getTemporaryDirectory();
      if (!mounted) return;
      final directory = await root.createTemp('mori-media-');
      _directory = directory;
      final extension = switch (widget.data.mimeType) {
        'video/mp4' => 'mp4',
        'video/quicktime' => 'mov',
        'video/webm' => 'webm',
        'audio/mp4' => 'm4a',
        'audio/mpeg' => 'mp3',
        'audio/wav' => 'wav',
        'audio/ogg' => 'ogg',
        'audio/flac' => 'flac',
        'audio/aac' => 'aac',
        'audio/webm' => 'weba',
        _ => throw UnsupportedError(widget.data.mimeType),
      };
      final file = File('${directory.path}/media.$extension');
      await file.writeAsBytes(widget.data.bytes, flush: true);
      if (!mounted) return;
      if (widget.data.mimeType.startsWith('video/')) {
        final controller = VideoPlayerController.file(file);
        _video = controller;
        controller.addListener(_videoChanged);
        await controller.initialize();
      } else {
        final player = AudioPlayer();
        _audio = player;
        _subscriptions.addAll([
          player.playerStateStream.listen((_) {
            if (mounted) setState(() {});
          }),
          player.positionStream.listen((value) {
            if (mounted) setState(() => _audioPosition = value);
          }),
          player.durationStream.listen((value) {
            if (mounted) {
              setState(() => _audioDuration = value ?? Duration.zero);
            }
          }),
          player.errorStream.listen((error) {
            if (mounted) setState(() => _error = error.toString());
          }),
        ]);
        await player.setFilePath(file.path);
      }
      if (mounted) setState(() => _ready = true);
    } catch (error) {
      if (mounted) setState(() => _error = error.toString());
    }
  }

  void _videoChanged() {
    if (!mounted) return;
    setState(() {
      if (_video?.value.hasError == true) {
        _error = _video!.value.errorDescription;
      }
    });
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state != AppLifecycleState.resumed) {
      unawaited(_video?.pause());
      unawaited(_audio?.pause());
    }
  }

  Future<void> _toggle() async {
    try {
      final video = _video;
      if (video != null) {
        if (video.value.isPlaying) {
          await video.pause();
        } else {
          if (video.value.position >= video.value.duration) {
            await video.seekTo(Duration.zero);
          }
          await video.play();
        }
      } else {
        final audio = _audio!;
        if (audio.playing) {
          await audio.pause();
        } else {
          if (audio.processingState == ProcessingState.completed) {
            await audio.seek(Duration.zero);
          }
          await audio.play();
        }
      }
    } catch (error) {
      if (mounted) setState(() => _error = error.toString());
    }
  }

  Future<void> _seek(double milliseconds) async {
    try {
      final position = Duration(milliseconds: milliseconds.round());
      if (_video != null) {
        await _video!.seekTo(position);
      } else {
        await _audio!.seek(position);
      }
    } catch (error) {
      if (mounted) setState(() => _error = error.toString());
    }
  }

  Future<void> _release() async {
    await _initialization;
    for (final subscription in _subscriptions) {
      await subscription.cancel();
    }
    _video?.removeListener(_videoChanged);
    await _video?.dispose();
    await _audio?.dispose();
    await _directory?.delete(recursive: true);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    unawaited(_video?.pause());
    unawaited(_audio?.pause());
    unawaited(_release());
    super.dispose();
  }

  String _time(Duration value) =>
      '${value.inMinutes}:${(value.inSeconds % 60).toString().padLeft(2, '0')}';

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    if (_error != null) {
      return Padding(
        padding: const EdgeInsets.all(16),
        child: Text('${l10n.mediaPlaybackFailed}\n$_error'),
      );
    }
    if (!_ready) {
      return const Padding(
        padding: EdgeInsets.all(24),
        child: Center(child: CircularProgressIndicator()),
      );
    }
    final video = _video;
    final playing = video?.value.isPlaying ?? _audio?.playing ?? false;
    final duration = video?.value.duration ?? _audioDuration;
    final position = video?.value.position ?? _audioPosition;
    final max = duration.inMilliseconds.toDouble();
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        if (video != null)
          AspectRatio(
            aspectRatio: video.value.aspectRatio > 0
                ? video.value.aspectRatio
                : 16 / 9,
            child: VideoPlayer(video),
          )
        else
          const Padding(
            padding: EdgeInsets.all(20),
            child: Icon(Icons.audiotrack, size: 48),
          ),
        Row(
          children: [
            IconButton(
              tooltip: playing ? l10n.mediaPause : l10n.mediaPlay,
              onPressed: () => unawaited(_toggle()),
              icon: Icon(playing ? Icons.pause : Icons.play_arrow),
            ),
            Expanded(
              child: Slider(
                min: 0,
                max: max > 0 ? max : 1,
                value: position.inMilliseconds.toDouble().clamp(
                  0,
                  max > 0 ? max : 1,
                ),
                onChanged: max > 0 ? (value) => unawaited(_seek(value)) : null,
              ),
            ),
            Padding(
              padding: const EdgeInsets.only(right: 12),
              child: Text('${_time(position)} / ${_time(duration)}'),
            ),
          ],
        ),
      ],
    );
  }
}
