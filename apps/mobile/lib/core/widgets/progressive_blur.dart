import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/scheduler.dart';

/// Where the progressive blur is strongest.
enum ProgressiveBlurDirection {
  topToBottom,
  bottomToTop,
  leftToRight,
  rightToLeft,
}

/// Graduated backdrop blur (Signal / iOS header dissolve).
///
/// Uses [ui.ImageFilter.shader] on [BackdropFilter] (not [ShaderMask] — that
/// tends to go fully transparent on Impeller). See [ui.ImageFilter.shader].
class ProgressiveBlur extends StatefulWidget {
  const ProgressiveBlur({
    super.key,
    this.maxSigma = 18,
    this.direction = ProgressiveBlurDirection.topToBottom,
    this.falloff = 1.2,

    /// Keep full sigma for this fraction of the strong→weak path (0–0.95),
    /// then dissolve over the remaining band only.
    this.solidFraction = 0.0,
  });

  /// Blur sigma in **logical** pixels at the strong edge. `0` ⇒ passthrough.
  final double maxSigma;

  final ProgressiveBlurDirection direction;

  /// Gradient gamma on the **fade** segment after [solidFraction].
  final double falloff;

  /// 0 = dissolve across the whole rect; ~0.75 = full frost then short dissolve.
  final double solidFraction;

  static ui.FragmentProgram? _program;
  static Future<void>? _loadFuture;

  static Future<void> preload() {
    return _loadFuture ??= () async {
      try {
        _program = await ui.FragmentProgram.fromAsset(
          'shaders/progressive_blur.frag',
        );
      } catch (_) {
        _program = null;
      }
    }();
  }

  @override
  State<ProgressiveBlur> createState() => _ProgressiveBlurState();
}

class _ProgressiveBlurState extends State<ProgressiveBlur> {
  Offset? _origin;
  Size? _size;
  var _originCallbackPending = false;
  ui.ImageFilter? _filter;
  ({
    double sigma,
    double falloff,
    double direction,
    Offset origin,
    Size size,
    double solid,
  })?
  _filterInputs;

  @override
  void initState() {
    super.initState();
    ProgressiveBlur.preload().then((_) {
      if (mounted) setState(() {});
    });
    _scheduleOrigin();
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    // Rotation / inset changes move the global origin.
    _scheduleOrigin();
  }

  void _scheduleOrigin() {
    if (_originCallbackPending) return;
    _originCallbackPending = true;
    SchedulerBinding.instance.addPostFrameCallback((_) {
      _originCallbackPending = false;
      if (!mounted) return;
      final box = context.findRenderObject() as RenderBox?;
      if (box == null || !box.hasSize) {
        // Layout not ready yet — try once more.
        _scheduleOrigin();
        return;
      }
      final origin = box.localToGlobal(Offset.zero);
      final size = box.size;
      if (_origin != origin || _size != size) {
        setState(() {
          _origin = origin;
          _size = size;
        });
      }
    });
  }

  double get _directionIndex => switch (widget.direction) {
    ProgressiveBlurDirection.topToBottom => 0,
    ProgressiveBlurDirection.bottomToTop => 1,
    ProgressiveBlurDirection.leftToRight => 2,
    ProgressiveBlurDirection.rightToLeft => 3,
  };

  ui.ImageFilter? _shaderFilter({
    required double dpr,
    required Offset origin,
    required Size size,
  }) {
    final program = ProgressiveBlur._program;
    if (program == null || !ui.ImageFilter.isShaderFilterSupported) {
      return null;
    }
    if (widget.maxSigma <= 0) return null;

    final originPx = origin * dpr;
    final sizePx = size * dpr;
    final sigmaPx = widget.maxSigma * dpr;
    final solid = widget.solidFraction.clamp(0.0, 0.95);
    final inputs = (
      sigma: sigmaPx,
      falloff: widget.falloff,
      direction: _directionIndex,
      origin: originPx,
      size: sizePx,
      solid: solid,
    );
    // Feed updates do not change the blur geometry. Reuse its two shaders and
    // composed filter until a uniform actually changes.
    if (inputs == _filterInputs) return _filter;

    ui.FragmentShader pass({required double axis}) {
      final shader = program.fragmentShader();
      // 0-1 uSize (engine)
      shader.setFloat(2, sigmaPx);
      shader.setFloat(3, widget.falloff);
      shader.setFloat(4, _directionIndex);
      shader.setFloat(5, axis);
      shader.setFloat(6, originPx.dx);
      shader.setFloat(7, originPx.dy);
      shader.setFloat(8, sizePx.width);
      shader.setFloat(9, sizePx.height);
      shader.setFloat(10, solid);
      return shader;
    }

    _filterInputs = inputs;
    return _filter = ui.ImageFilter.compose(
      outer: ui.ImageFilter.shader(pass(axis: 1)),
      inner: ui.ImageFilter.shader(pass(axis: 0)),
    );
  }

  @override
  Widget build(BuildContext context) {
    final dpr = MediaQuery.devicePixelRatioOf(context);
    final origin = _origin;
    final size = _size;

    final filter = (origin != null && size != null)
        ? _shaderFilter(dpr: dpr, origin: origin, size: size)
        : null;

    late final Widget filtered;
    if (filter != null) {
      filtered = ClipRect(
        child: BackdropFilter(filter: filter, child: const SizedBox.expand()),
      );
    } else {
      final sigma = widget.maxSigma > 0 ? widget.maxSigma * 0.55 : 0.0;
      if (sigma <= 0) {
        filtered = const SizedBox.expand();
      } else {
        filtered = ClipRect(
          child: BackdropFilter(
            filter: ui.ImageFilter.blur(sigmaX: sigma, sigmaY: sigma),
            child: const ColoredBox(color: Color(0x08FFFFFF)),
          ),
        );
      }
    }

    // Re-measure when parent constraints change (keyboard / dock height).
    return LayoutBuilder(
      builder: (context, constraints) {
        final layoutSize = constraints.biggest;
        if (_size != layoutSize && layoutSize.isFinite) {
          _scheduleOrigin();
        }
        return RepaintBoundary(child: filtered);
      },
    );
  }
}
