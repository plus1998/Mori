import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';

import '../theme/eco_theme.dart';
import '../utils/shimmer_paint.dart';

/// Same-hue shimmer: a soft highlight sweeps across [text] repeatedly.
///
/// Labels with the same cadence share a 30fps paint clock. Only the shader is
/// repainted; text is not rebuilt or laid out on animation frames. A positive
/// [pauseDuration] leaves the text static between sweeps without paint ticks.
class ShimmerText extends StatelessWidget {
  const ShimmerText({
    super.key,
    required this.text,
    this.style,
    required this.baseColor,
    this.highlightColor,
    this.duration = const Duration(milliseconds: 1800),
    this.pauseDuration = Duration.zero,
    this.maxLines,
    this.overflow,
  });

  final String text;
  final TextStyle? style;
  final Color baseColor;
  final Color? highlightColor;
  final Duration duration;
  final Duration pauseDuration;
  final int? maxLines;
  final TextOverflow? overflow;

  @override
  Widget build(BuildContext context) {
    final peakWhite = ecoColors(context).shimmerHighlight;
    final peak = resolveShimmerPeak(
      base: baseColor,
      highlight: highlightColor,
      peak: peakWhite,
    );
    final mid = highlightColor ?? Color.lerp(baseColor, peakWhite, 0.45)!;
    final resolvedStyle = (style ?? Theme.of(context).textTheme.bodySmall)
        ?.copyWith(color: baseColor, fontWeight: FontWeight.w500);
    final child = Text(
      text,
      style: resolvedStyle,
      maxLines: maxLines,
      overflow: overflow ?? TextOverflow.clip,
    );
    if (!TickerMode.valuesOf(context).enabled ||
        MediaQuery.disableAnimationsOf(context) ||
        duration <= Duration.zero) {
      return child;
    }

    final timing = (
      sweep: duration,
      pause: pauseDuration > Duration.zero ? pauseDuration : Duration.zero,
    );
    final clock = _shimmerClocks.putIfAbsent(
      timing,
      () => _ShimmerClock(timing),
    );
    return RepaintBoundary(
      child: _ShimmerMask(
        clock: clock,
        shaderCallback: (bounds) {
          if (!bounds.isFinite || bounds.width <= 0 || bounds.height <= 0) {
            return LinearGradient(
              colors: [baseColor, baseColor],
            ).createShader(bounds);
          }
          final phase = clock.phase;
          final bandWidth = bounds.width * shimmerBandWidthFactor;
          final left = shimmerBandLeft(phase: phase, textWidth: bounds.width);
          return LinearGradient(
            begin: Alignment.centerLeft,
            end: Alignment.centerRight,
            colors: [baseColor, mid, peak, mid, baseColor],
            stops: const [0.0, 0.32, 0.5, 0.68, 1.0],
            tileMode: TileMode.clamp,
          ).createShader(
            Rect.fromLTWH(left, bounds.top, bandWidth, bounds.height),
          );
        },
        child: child,
      ),
    );
  }
}

typedef _ShimmerTiming = ({Duration sweep, Duration pause});

// One dormant clock per configured cadence; only attached labels keep timers
// and lifecycle observers active. Shared pauses prevent staggered tool rows
// from keeping the engine continuously busy.
final _shimmerClocks = <_ShimmerTiming, _ShimmerClock>{};

/// A shared timer leaves the engine idle between paints even on 120Hz screens.
/// A throttled Ticker would still request a frame on every display refresh.
class _ShimmerClock extends ChangeNotifier with WidgetsBindingObserver {
  _ShimmerClock(this.timing);

  final _ShimmerTiming timing;
  Timer? _timer;
  Timer? _phaseTimer;
  bool _resting = false;

  double get phase => _resting
      ? 0
      : shimmerPhaseFromElapsed(
          ms: (_timer?.tick ?? 0) * shimmerPaintIntervalMs,
          durationMs: timing.sweep.inMilliseconds,
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
      (_) => notifyListeners(),
    );
    if (timing.pause > Duration.zero) {
      _phaseTimer = Timer(timing.sweep, () {
        _timer?.cancel();
        _timer = null;
        _resting = true;
        // Phase 0 and 1 both put the highlight outside the text. Paint the
        // neutral endpoint once, then sleep until the next sweep.
        notifyListeners();
        _phaseTimer = Timer(timing.pause, () {
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

class _ShimmerMask extends SingleChildRenderObjectWidget {
  const _ShimmerMask({
    required this.clock,
    required this.shaderCallback,
    required super.child,
  });

  final _ShimmerClock clock;
  final ShaderCallback shaderCallback;

  @override
  RenderObject createRenderObject(BuildContext context) =>
      _RenderShimmerMask(clock: clock, shaderCallback: shaderCallback);

  @override
  void updateRenderObject(
    BuildContext context,
    _RenderShimmerMask renderObject,
  ) {
    renderObject
      ..clock = clock
      ..shaderCallback = shaderCallback;
  }
}

class _RenderShimmerMask extends RenderShaderMask {
  _RenderShimmerMask({
    required _ShimmerClock clock,
    required super.shaderCallback,
  }) : _clock = clock,
       super(blendMode: BlendMode.srcIn);

  _ShimmerClock _clock;

  set clock(_ShimmerClock value) {
    if (identical(value, _clock)) return;
    if (attached) _clock.removeListener(markNeedsPaint);
    _clock = value;
    if (attached) _clock.addListener(markNeedsPaint);
    markNeedsPaint();
  }

  @override
  void attach(PipelineOwner owner) {
    super.attach(owner);
    _clock.addListener(markNeedsPaint);
  }

  @override
  void detach() {
    _clock.removeListener(markNeedsPaint);
    super.detach();
  }
}
