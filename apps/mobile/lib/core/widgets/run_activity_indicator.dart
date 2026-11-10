import 'package:flutter/material.dart';

import '../locale/app_localizations_ext.dart';
import '../theme/eco_theme.dart';
import '../utils/activity_paint_clock.dart';

/// A quiet, indeterminate mark for work that has no visible Feed output yet.
class RunActivityIndicator extends StatelessWidget {
  const RunActivityIndicator({super.key});

  @override
  Widget build(BuildContext context) {
    final enabled =
        TickerMode.valuesOf(context).enabled &&
        !MediaQuery.disableAnimationsOf(context);
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
                  clock: enabled ? activityPaintClock() : null,
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
  _ActivityLinePainter({required this.clock, required this.color})
    : super(repaint: clock);

  final ActivityPaintClock? clock;
  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    final bounds = Offset.zero & size;
    canvas.clipRRect(RRect.fromRectAndRadius(bounds, const Radius.circular(2)));
    canvas.drawRect(bounds, Paint()..color = color.withValues(alpha: 0.08));
    // Both endpoints sit outside the clipped track, so the loop has no jump.
    final left = -size.width + (clock?.phase ?? 0.5) * size.width * 2;
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
      oldDelegate.color != color || oldDelegate.clock != clock;
}
