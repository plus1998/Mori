import 'package:flutter/material.dart';

import '../locale/app_localizations_ext.dart';
import '../theme/eco_theme.dart';

/// A quiet, indeterminate mark for work that has no visible Feed output yet.
class RunActivityIndicator extends StatefulWidget {
  const RunActivityIndicator({super.key});

  @override
  State<RunActivityIndicator> createState() => _RunActivityIndicatorState();
}

class _RunActivityIndicatorState extends State<RunActivityIndicator>
    with SingleTickerProviderStateMixin, WidgetsBindingObserver {
  late final _animation = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 1800),
  );

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _syncAnimation();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) => _syncAnimation();

  void _syncAnimation() {
    final lifecycle = WidgetsBinding.instance.lifecycleState;
    if (MediaQuery.disableAnimationsOf(context) ||
        !TickerMode.valuesOf(context).enabled ||
        (lifecycle != null && lifecycle != AppLifecycleState.resumed)) {
      _animation.stop();
      _animation.value = 0.5;
    } else if (!_animation.isAnimating) {
      _animation.repeat();
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _animation.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final colors = ecoColors(context);
    final label = context.l10n.activityProcessing;
    return Semantics(
      label: label,
      child: ExcludeSemantics(
        child: SizedBox(
          width: 28,
          height: 12,
          child: Center(
            child: RepaintBoundary(
              child: CustomPaint(
                size: const Size(28, 2),
                painter: _ActivityLinePainter(
                  animation: _animation,
                  color: colors.textSecondary,
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _ActivityLinePainter extends CustomPainter {
  _ActivityLinePainter({required this.animation, required this.color})
    : super(repaint: animation);

  final Animation<double> animation;
  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    final bounds = Offset.zero & size;
    canvas.clipRRect(RRect.fromRectAndRadius(bounds, const Radius.circular(2)));
    canvas.drawRect(bounds, Paint()..color = color.withValues(alpha: 0.08));
    // Both endpoints sit outside the clipped track, so the loop has no jump.
    final left = -size.width + animation.value * size.width * 2;
    canvas.drawRect(
      bounds,
      Paint()
        ..shader = LinearGradient(
          colors: [
            color.withValues(alpha: 0),
            color.withValues(alpha: 0.7),
            color.withValues(alpha: 0),
          ],
        ).createShader(Rect.fromLTWH(left, 0, size.width, size.height)),
    );
  }

  @override
  bool shouldRepaint(_ActivityLinePainter oldDelegate) =>
      oldDelegate.color != color || oldDelegate.animation != animation;
}
