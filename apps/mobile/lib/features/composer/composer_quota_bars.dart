import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/locale/app_localizations_ext.dart';
import '../../core/theme/eco_theme.dart';
import '../threads/codex_quota_provider.dart';

/// Same compact, stacked remaining-quota tracks as the desktop composer.
class ComposerQuotaBars extends ConsumerWidget {
  const ComposerQuotaBars({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final usage = ref.watch(codexQuotaProvider);
    final eco = ecoColors(context);
    if (usage.hasError) {
      return Icon(Icons.error_outline, size: 20, color: eco.danger);
    }
    final windows =
        usage.valueOrNull?.account?.quota?.windows
            .where((window) => window.valid)
            .toList() ??
        [];
    return Semantics(
      label: usage.isLoading
          ? context.l10n.codexQuotaLoading
          : windows.isEmpty
          ? context.l10n.codexQuotaIdle
          : windows
                .map(
                  (window) => context.l10n.codexQuotaRemaining(
                    window.remaining.toStringAsFixed(1),
                  ),
                )
                .join(' · '),
      child: SizedBox(
        width: 24,
        height: 20,
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            for (
              var i = 0;
              i < (windows.isEmpty ? 1 : windows.length);
              i++
            ) ...[
              if (i > 0) const SizedBox(height: 3),
              Builder(
                builder: (context) {
                  final remaining = windows.isEmpty
                      ? null
                      : windows[i].remaining;
                  final color = remaining == null
                      ? eco.textMuted
                      : remaining <= 10
                      ? eco.danger
                      : remaining <= 25
                      ? eco.statusWarnText
                      : eco.success;
                  return Container(
                    height: 3,
                    decoration: BoxDecoration(
                      color: remaining == 0
                          ? Colors.transparent
                          : color.withValues(alpha: 0.15),
                      borderRadius: BorderRadius.circular(99),
                      border: remaining == 0 ? Border.all(color: color) : null,
                    ),
                    clipBehavior: Clip.antiAlias,
                    alignment: Alignment.centerLeft,
                    child: remaining == null
                        ? null
                        : FractionallySizedBox(
                            widthFactor: remaining / 100,
                            heightFactor: 1,
                            child: ColoredBox(color: color),
                          ),
                  );
                },
              ),
            ],
          ],
        ),
      ),
    );
  }
}
