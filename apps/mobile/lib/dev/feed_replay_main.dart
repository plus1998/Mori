import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:sqflite/sqflite.dart';

import '../core/storage/conversation_v2_cache.dart';
import '../core/theme/eco_theme.dart';
import '../core/widgets/progressive_blur.dart';
import '../features/threads/activity_feed.dart';
import '../features/threads/projection_activity_feed.dart';
import '../l10n/generated/app_localizations.dart';
import 'feed_replay.dart';

/// Simulator-only entry point. Absolute fixture paths refer to the host /tmp.
/// This entry point never mounts EcoApp or its auth/transport providers.
Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  HttpOverrides.global = _OfflineHttp();
  await ProgressiveBlur.preload();
  const path = String.fromEnvironment('ECO_REPLAY_FIXTURE');
  if (!path.startsWith('/tmp/') && !path.startsWith('/private/tmp/')) {
    throw ArgumentError('ECO_REPLAY_FIXTURE must be an exported /tmp file.');
  }
  final replay = MobileFeedReplay(
    Map<String, dynamic>.from(
      jsonDecode(await File(path).readAsString()) as Map,
    ),
    ConversationV2Cache(
      accountId: 'offline-replay',
      desktopDeviceId: 'offline-replay',
      databasePath: inMemoryDatabasePath,
    ),
  );
  await replay.seek(const int.fromEnvironment('ECO_REPLAY_SEQ'));
  runApp(ProviderScope(child: MobileFeedReplayApp(replay: replay)));
}

class _OfflineHttp extends HttpOverrides {
  @override
  HttpClient createHttpClient(SecurityContext? context) =>
      throw UnsupportedError('Offline replay blocks HTTP, media and RPC.');
}

class MobileFeedReplayApp extends StatelessWidget {
  const MobileFeedReplayApp({super.key, required this.replay});
  final MobileFeedReplay replay;
  @override
  Widget build(BuildContext context) => MaterialApp(
    theme: buildEcoLightTheme(),
    darkTheme: buildEcoDarkTheme(),
    themeMode: ThemeMode.dark,
    locale: const Locale('zh'),
    localizationsDelegates: AppLocalizations.localizationsDelegates,
    supportedLocales: AppLocalizations.supportedLocales,
    home: MobileFeedReplayScreen(replay: replay),
  );
}

class MobileFeedReplayScreen extends StatefulWidget {
  const MobileFeedReplayScreen({super.key, required this.replay});
  final MobileFeedReplay replay;
  @override
  State<MobileFeedReplayScreen> createState() => _ReplayScreenState();
}

class _ReplayScreenState extends State<MobileFeedReplayScreen> {
  final _feedCache = ProjectionActivityFeedCache();
  final _scroll = ScrollController();
  final _sequence = TextEditingController();
  double _speed = 1;
  bool _busy = false;
  Object? _error;
  MobileFeedReplay get replay => widget.replay;
  @override
  void initState() {
    super.initState();
    replay.addListener(_changed);
  }

  void _changed() {
    if (mounted) setState(() {});
  }

  Future<void> _run(Future<void> Function() action) async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await action();
    } catch (error) {
      _error = error;
    }
    if (mounted) setState(() => _busy = false);
  }

  @override
  void dispose() {
    replay.removeListener(_changed);
    unawaited(replay.close());
    _scroll.dispose();
    _sequence.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final projection = replay.projection;
    final entries = projection == null
        ? <ActivityFeedEntry>[]
        : buildActivityFeed(
            presentationCache: _feedCache,
            l10n: AppLocalizations.of(context),
            runProjection: projection,
            conversationLive: projection.status == 'running',
          );
    return Scaffold(
      appBar: AppBar(title: const Text('移动端离线 Replay')),
      body: SafeArea(
        child: Column(
          children: [
            Text('${replay.title} · ${replay.sequence}/${replay.eventCount}'),
            Row(
              children: [
                IconButton(
                  key: const ValueKey('replay-play'),
                  onPressed: _busy
                      ? null
                      : () {
                          if (replay.playing) {
                            replay.pause();
                          } else {
                            unawaited(
                              replay.play(speed: _speed).catchError((
                                Object error,
                              ) {
                                if (mounted) setState(() => _error = error);
                              }),
                            );
                          }
                        },
                  icon: Icon(replay.playing ? Icons.pause : Icons.play_arrow),
                ),
                IconButton(
                  key: const ValueKey('replay-step'),
                  onPressed: _busy || replay.playing
                      ? null
                      : () => _run(replay.step),
                  icon: const Icon(Icons.skip_next),
                ),
                DropdownButton<double>(
                  value: _speed,
                  items: [1.0, 5.0, 20.0]
                      .map(
                        (speed) => DropdownMenuItem(
                          value: speed,
                          child: Text('${speed.toInt()}×'),
                        ),
                      )
                      .toList(),
                  onChanged: replay.playing
                      ? null
                      : (speed) => setState(() => _speed = speed!),
                ),
                Expanded(
                  child: TextField(
                    controller: _sequence,
                    keyboardType: TextInputType.number,
                    decoration: const InputDecoration(hintText: '事件序号'),
                  ),
                ),
                TextButton(
                  onPressed: _busy
                      ? null
                      : () => _run(() async {
                          final target = int.tryParse(_sequence.text);
                          if (target == null) {
                            throw const FormatException('请输入事件序号');
                          }
                          await replay.seek(target);
                        }),
                  child: const Text('跳转'),
                ),
                IconButton(
                  onPressed: () => showDialog<void>(
                    context: context,
                    builder: (context) => AlertDialog(
                      scrollable: true,
                      title: const Text('回放覆盖范围'),
                      content: Text(
                        [
                          ...replay.coverage,
                          '使用真实移动端 SQLite reducer、投影、Feed 和滚动组件。',
                          '仅回放 effect 携带的详情；导出文件中额外保存的详情正文和媒体未加载。',
                          '不加载账号、网络、模型或工具。媒体请求明确阻止；未录制交互不提供按钮。',
                          '逐事件播放；默认最长空档缩短至 1000ms，不能用于证明网络或 SDK 正常。',
                          '尚未虚拟化历史时钟，“处理中”时长包含录制后的间隔，不能验收历史耗时。',
                        ].join('\n\n'),
                      ),
                    ),
                  ),
                  icon: const Icon(Icons.info_outline),
                ),
              ],
            ),
            if (_error != null || replay.error != null)
              Text(
                '回放失败：${_error ?? replay.error}',
                style: const TextStyle(color: Colors.red),
              ),
            if (_busy) const LinearProgressIndicator(),
            Expanded(
              child: ActivityFeedList(
                entries: entries,
                scrollController: _scroll,
                thinkingDefaultExpanded: false,
              ),
            ),
          ],
        ),
      ),
    );
  }
}
