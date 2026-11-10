import 'dart:async';

import 'package:flutter/widgets.dart';

import 'shimmer_paint.dart';

const activityPaintSweep = Duration(milliseconds: 1800);
const activityPaintPause = Duration(milliseconds: 4200);

typedef _Timing = ({Duration sweep, Duration pause});
final _clocks = <_Timing, ActivityPaintClock>{};

/// Shared by status effects so newly mounted rows join the same sleep window.
ActivityPaintClock activityPaintClock({
  Duration sweep = activityPaintSweep,
  Duration pause = activityPaintPause,
}) {
  final timing = (
    sweep: sweep,
    pause: pause > Duration.zero ? pause : Duration.zero,
  );
  return _clocks.putIfAbsent(timing, () => ActivityPaintClock._(timing));
}

/// Paint-only, near 30Hz during a sweep, with no vsync requests while resting.
/// Only attached render objects keep the clock alive. No work in background.
class ActivityPaintClock extends ChangeNotifier with WidgetsBindingObserver {
  ActivityPaintClock._(this._timing);
  final _Timing _timing;
  Timer? _timer;
  Timer? _phaseTimer;
  bool _resting = false;

  double get phase => _resting
      ? 0
      : shimmerPhaseFromElapsed(
          ms: (_timer?.tick ?? 0) * shimmerPaintIntervalMs,
          durationMs: _timing.sweep.inMilliseconds,
        );

  @override
  void addListener(VoidCallback listener) {
    if (!hasListeners) WidgetsBinding.instance.addObserver(this);
    super.addListener(listener);
    _syncTimer();
  }

  @override
  void removeListener(VoidCallback listener) {
    super.removeListener(listener);
    if (!hasListeners) {
      _cancelTimers();
      WidgetsBinding.instance.removeObserver(this);
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) => _syncTimer();

  void _syncTimer() {
    final lifecycle = WidgetsBinding.instance.lifecycleState;
    if (!hasListeners ||
        (lifecycle != null && lifecycle != AppLifecycleState.resumed)) {
      _cancelTimers();
      return;
    }
    if (_timer != null || _phaseTimer != null) return;
    _startSweep();
  }

  void _startSweep() {
    _resting = false;
    _timer = Timer.periodic(
      const Duration(milliseconds: shimmerPaintIntervalMs),
      (_) {
        notifyListeners();
      },
    );
    if (_timing.pause > Duration.zero) {
      _phaseTimer = Timer(_timing.sweep, () {
        _timer?.cancel();
        _timer = null;
        _resting = true;
        notifyListeners();
        _phaseTimer = Timer(_timing.pause, () {
          _phaseTimer = null;
          _startSweep();
        });
      });
    }
    notifyListeners();
  }

  void _cancelTimers() {
    _timer?.cancel();
    _timer = null;
    _phaseTimer?.cancel();
    _phaseTimer = null;
    _resting = false;
  }
}
