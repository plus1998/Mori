import 'package:flutter/material.dart';

import '../theme/eco_icons.dart';
import '../theme/eco_theme.dart';

/// Inline, user-facing error state for content that can be retried in place.
///
/// Callers provide an already-localized title and message. Technical exception
/// details belong in diagnostics, not in this widget.
class AppErrorState extends StatefulWidget {
  const AppErrorState({
    super.key,
    required this.title,
    required this.message,
    this.onRetry,
    this.retryLabel,
  }) : assert(onRetry == null || retryLabel != null);

  final String title;
  final String message;
  final Future<void> Function()? onRetry;
  final String? retryLabel;

  @override
  State<AppErrorState> createState() => _AppErrorStateState();
}

class _AppErrorStateState extends State<AppErrorState> {
  var _retrying = false;

  Future<void> _retry() async {
    final retry = widget.onRetry;
    if (retry == null || _retrying) return;
    setState(() => _retrying = true);
    try {
      await retry();
    } catch (_) {
      // The surrounding provider remains the source of truth for the error.
      // A failed retry keeps this state visible without exposing the exception.
    } finally {
      if (mounted) setState(() => _retrying = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final eco = ecoColors(context);
    return Semantics(
      container: true,
      liveRegion: true,
      child: Container(
        padding: const EdgeInsets.all(16),
        decoration: BoxDecoration(
          color: eco.statusDenyBg,
          borderRadius: BorderRadius.circular(12),
          border: Border.all(color: eco.statusDenyBorder),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Icon(EcoIcons.error, size: 20, color: eco.statusDenyText),
                const SizedBox(width: 10),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        widget.title,
                        style: Theme.of(context).textTheme.titleSmall?.copyWith(
                          color: eco.statusDenyText,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                      const SizedBox(height: 4),
                      Text(
                        widget.message,
                        style: Theme.of(context).textTheme.bodySmall?.copyWith(
                          color: eco.statusDenyText,
                          height: 1.4,
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            ),
            if (widget.retryLabel != null) ...[
              const SizedBox(height: 10),
              Align(
                alignment: Alignment.centerRight,
                child: TextButton(
                  onPressed: widget.onRetry == null || _retrying
                      ? null
                      : _retry,
                  style: TextButton.styleFrom(
                    foregroundColor: eco.statusDenyText,
                    backgroundColor: eco.cardSurface,
                    minimumSize: const Size(0, 36),
                    padding: const EdgeInsets.symmetric(horizontal: 8),
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(8),
                      side: BorderSide(color: eco.statusDenyBorder),
                    ),
                  ),
                  child: _retrying
                      ? SizedBox.square(
                          dimension: 16,
                          child: CircularProgressIndicator(
                            strokeWidth: 2,
                            color: eco.statusDenyText,
                          ),
                        )
                      : Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            Icon(
                              EcoIcons.refresh,
                              size: 18,
                              color: eco.statusDenyText,
                            ),
                            const SizedBox(width: 6),
                            Text(widget.retryLabel!),
                          ],
                        ),
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}
