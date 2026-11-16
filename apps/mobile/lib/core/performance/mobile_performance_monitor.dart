import 'dart:async';
import 'dart:developer' as developer;
import 'dart:ui' as ui;
import 'dart:math' as math;

import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';

/// Low-overhead performance breadcrumbs for profiling a real device.
///
/// Enable with `--dart-define=ECO_PERF_MONITOR=true`. The monitor is deliberately
/// disabled in normal builds: no timers, frame callbacks, or platform-channel
/// traffic are installed unless explicitly enabled. It records causes that can
/// be correlated with Xcode Instruments' Energy Log, CPU, Network, and
/// Animation instruments. It never records request bodies, tokens, or message
/// text.
final class MobilePerformanceMonitor with WidgetsBindingObserver {
  MobilePerformanceMonitor._();

  static final instance = MobilePerformanceMonitor._();
  static const _enabled = bool.fromEnvironment(
    'ECO_PERF_MONITOR',
    defaultValue: false,
  );
  static const _channel = MethodChannel('eco_mobile/performance');

  final Stopwatch _clock = Stopwatch();
  final Map<String, int> _counters = <String, int>{};
  final List<double> _buildMs = <double>[];
  final List<double> _rasterMs = <double>[];
  int _frames = 0;
  int _slowFrames = 0;
  int _verySlowFrames = 0;
  int _nextSpanId = 0;
  bool _started = false;

  bool get enabled => _enabled;

  void start() {
    if (!_enabled || _started) return;
    _started = true;
    _clock.start();
    WidgetsBinding.instance.addObserver(this);
    WidgetsBinding.instance.addTimingsCallback(_onTimings);
    _instant('monitor.start');
  }

  /// Increment a bounded cardinality counter. Names are code-controlled.
  void count(String name, [int amount = 1]) {
    if (!_enabled || amount == 0) return;
    _counters[name] = (_counters[name] ?? 0) + amount;
  }

  /// Add a timeline breadcrumb and an iOS signpost event.
  void mark(String name, {Map<String, Object?> arguments = const {}}) {
    if (!_enabled) return;
    count('mark.$name');
    _instant(name, arguments: arguments);
  }

  PerformanceSpan begin(
    String name, {
    Map<String, Object?> arguments = const {},
  }) {
    if (!_enabled) return PerformanceSpan.disabled();
    final id = ++_nextSpanId;
    final startedAt = _clock.elapsedMicroseconds;
    final task = developer.TimelineTask()
      ..start('eco.$name', arguments: _safeArguments(arguments));
    unawaited(
      _invokeNative('begin', <String, Object?>{
        'id': id,
        'name': name,
        'detail': _detail(arguments),
      }),
    );
    return PerformanceSpan._(this, id, name, startedAt, task);
  }

  Map<String, Object?> snapshot() {
    if (!_enabled) return const <String, Object?>{'enabled': false};
    final build = List<double>.from(_buildMs)..sort();
    final raster = List<double>.from(_rasterMs)..sort();
    return <String, Object?>{
      'enabled': true,
      'elapsedMs': _clock.elapsedMilliseconds,
      'frames': _frames,
      'slowFrames': _slowFrames,
      'verySlowFrames': _verySlowFrames,
      'buildP50Ms': _percentile(build, .50),
      'buildP95Ms': _percentile(build, .95),
      'rasterP50Ms': _percentile(raster, .50),
      'rasterP95Ms': _percentile(raster, .95),
      'counters': Map<String, int>.from(_counters),
    };
  }

  /// Emits a compact snapshot to the debug console and Instruments timeline.
  void logSnapshot(String reason) {
    if (!_enabled) return;
    final data = snapshot();
    debugPrint('ECO_PERF ${<String, Object?>{'reason': reason, ...data}}');
    mark(
      'snapshot',
      arguments: <String, Object?>{
        'reason': reason,
        'frames': _frames,
        'slowFrames': _slowFrames,
        'rpcCount': _counters['rpc.count'] ?? 0,
        'eventCount': _counters['realtime.event'] ?? 0,
      },
    );
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (!_enabled) return;
    count('lifecycle.${state.name}');
    mark('lifecycle.${state.name}');
    if (state == AppLifecycleState.paused ||
        state == AppLifecycleState.hidden ||
        state == AppLifecycleState.detached) {
      logSnapshot('background');
    }
  }

  void endSpan(
    int id,
    String name,
    int startedAt,
    developer.TimelineTask task,
  ) {
    if (!_enabled) return;
    final elapsedUs = math.max(0, _clock.elapsedMicroseconds - startedAt);
    task.finish();
    unawaited(
      _invokeNative('end', <String, Object?>{
        'id': id,
        'name': name,
        'durationUs': elapsedUs,
      }),
    );
    count('span.$name');
  }

  void _onTimings(List<ui.FrameTiming> timings) {
    if (!_enabled) return;
    for (final timing in timings) {
      final build = timing.buildDuration.inMicroseconds / 1000;
      final raster = timing.rasterDuration.inMicroseconds / 1000;
      _frames++;
      _slowFrames += build > 16.67 || raster > 16.67 ? 1 : 0;
      _verySlowFrames += build > 33.33 || raster > 33.33 ? 1 : 0;
      _appendSample(_buildMs, build);
      _appendSample(_rasterMs, raster);
    }
  }

  void _appendSample(List<double> target, double value) {
    // Keep enough samples for p95 without allowing a long soak to grow memory.
    if (target.length < 2048) {
      target.add(value);
    } else {
      target[_frames % target.length] = value;
    }
  }

  void _instant(String name, {Map<String, Object?> arguments = const {}}) {
    developer.Timeline.instantSync(
      'eco.$name',
      arguments: _safeArguments(arguments),
    );
    unawaited(
      _invokeNative('instant', <String, Object?>{
        'name': name,
        'detail': _detail(arguments),
      }),
    );
  }

  Future<void> _invokeNative(
    String method,
    Map<String, Object?> arguments,
  ) async {
    try {
      await _channel.invokeMethod<void>(method, arguments);
    } on MissingPluginException {
      // Android, simulator, and older hot-reloaded engines can lack the channel.
    } on PlatformException {
      // Profiling must never affect the product path.
    }
  }

  static Map<String, Object> _safeArguments(Map<String, Object?> input) {
    return <String, Object>{
      for (final entry in input.entries)
        if (entry.value is String || entry.value is num || entry.value is bool)
          entry.key: entry.value!,
    };
  }

  static String _detail(Map<String, Object?> input) => input.entries
      .where(
        (entry) =>
            entry.value is String || entry.value is num || entry.value is bool,
      )
      .map((entry) => '${entry.key}=${entry.value}')
      .join(' ');

  static double? _percentile(List<double> values, double fraction) {
    if (values.isEmpty) return null;
    final index = ((values.length - 1) * fraction).round().clamp(
      0,
      values.length - 1,
    );
    return double.parse(values[index].toStringAsFixed(2));
  }
}

final class PerformanceSpan {
  PerformanceSpan.disabled()
    : _monitor = null,
      _id = 0,
      _name = '',
      _startedAt = 0,
      _task = null;

  PerformanceSpan._(
    this._monitor,
    this._id,
    this._name,
    this._startedAt,
    this._task,
  );

  final MobilePerformanceMonitor? _monitor;
  final int _id;
  final String _name;
  final int _startedAt;
  final developer.TimelineTask? _task;
  bool _ended = false;

  void end() {
    if (_ended) return;
    _ended = true;
    final task = _task;
    if (_monitor != null && task != null) {
      _monitor.endSpan(_id, _name, _startedAt, task);
    }
  }
}
