import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';

import '../../core/locale/app_localizations_ext.dart';
import '../../core/models/codex_account_models.dart';
import '../../core/theme/eco_icons.dart';
import '../../core/theme/eco_theme.dart';
import '../../core/widgets/eco_grouped_list.dart';
import 'codex_quota_provider.dart';

class CodexQuotaPage extends ConsumerStatefulWidget {
  const CodexQuotaPage({super.key});
  @override
  ConsumerState<CodexQuotaPage> createState() => _CodexQuotaPageState();
}

class _CodexQuotaPageState extends ConsumerState<CodexQuotaPage>
    with WidgetsBindingObserver {
  var _choosing = false;
  var _busy = false;
  String? _message;
  var _search = '';

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      unawaited(ref.read(codexQuotaProvider.notifier).refresh());
    }
  }

  String _error(Object error) {
    final l = context.l10n;
    if (error is CodexQuotaFailure) {
      return switch (error.code) {
        'disconnected' => l.codexQuotaDisconnected,
        'removed' => l.codexQuotaRemoved,
        'unavailable' => l.codexQuotaUnavailable,
        'switching' => l.codexQuotaSwitching,
        _ => error.toString(),
      };
    }
    return error.toString();
  }

  Future<void> _run(Future<void> Function(CodexQuotaController) action) async {
    if (_busy) return;
    setState(() {
      _busy = true;
      _message = null;
    });
    try {
      await action(ref.read(codexQuotaProvider.notifier));
    } catch (error) {
      if (mounted) setState(() => _message = _error(error));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _reset(CodexQuotaController controller) async {
    final result = await controller.reset();
    if (!mounted) return;
    setState(
      () => _message = switch (result) {
        'noCredit' => context.l10n.codexQuotaNoCredit,
        'nothingToReset' => context.l10n.codexQuotaNothingToReset,
        _ => context.l10n.codexQuotaResetSuccess,
      },
    );
  }

  @override
  Widget build(BuildContext context) {
    final usage = ref.watch(codexQuotaProvider);
    final snapshot = usage.valueOrNull;
    final eco = ecoColors(context);
    final l = context.l10n;
    final account = snapshot?.account;
    final quota = account?.quota;
    final candidates =
        snapshot?.candidates
            .where(
              (a) => [a.name, a.email, a.quota?.email ?? ''].any(
                (s) => s.toLowerCase().contains(_search.toLowerCase().trim()),
              ),
            )
            .toList() ??
        [];
    return ListView(
      padding: const EdgeInsets.fromLTRB(16, 4, 16, 24),
      children: [
        Row(
          children: [
            if (_choosing)
              IconButton(
                tooltip: l.codexQuotaBack,
                icon: const Icon(EcoIcons.back, size: 20),
                onPressed: _busy
                    ? null
                    : () => setState(() {
                        _choosing = false;
                        _message = null;
                      }),
              ),
            Expanded(
              child: Text(
                _choosing ? l.codexQuotaSwitchAccount : l.codexQuotaTitle,
                style: Theme.of(
                  context,
                ).textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w600),
              ),
            ),
            IconButton(
              tooltip: l.codexQuotaRefresh,
              onPressed: _busy || usage.isLoading
                  ? null
                  : () => _run((c) async {
                      if (_choosing) {
                        for (final a
                            in snapshot?.candidates ?? <CodexAccount>[]) {
                          await c.refreshCandidate(a.id);
                        }
                      } else {
                        await c.refresh();
                      }
                    }),
              icon: _busy || usage.isLoading
                  ? const SizedBox.square(
                      dimension: 18,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Icon(EcoIcons.refresh, size: 18),
            ),
          ],
        ),
        if (usage.hasError)
          _Notice(text: _error(usage.error!))
        else if (usage.isLoading && snapshot == null)
          _Notice(text: l.codexQuotaLoading)
        else if (_choosing) ...[
          _Notice(text: l.codexQuotaSwitchDescription),
          TextField(
            onChanged: (s) => setState(() => _search = s),
            decoration: InputDecoration(
              prefixIcon: const Icon(EcoIcons.search, size: 18),
              hintText: l.codexQuotaSearch,
            ),
          ),
          const SizedBox(height: 16),
          if (candidates.isEmpty)
            _Notice(
              text: _search.isEmpty
                  ? l.codexQuotaNoCandidates
                  : l.codexQuotaNoResults,
            ),
          for (final candidate in candidates) ...[
            EcoGroupedSurface(
              margin: EdgeInsets.zero,
              child: InkWell(
                onTap:
                    _busy || snapshot!.active.hasPending || !candidate.available
                    ? null
                    : () => _run((c) async {
                        await c.switchAccount(candidate.id);
                        if (mounted) setState(() => _choosing = false);
                      }),
                child: Padding(
                  padding: const EdgeInsets.all(16),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      Row(
                        children: [
                          Expanded(
                            child: Text(
                              candidate.name,
                              style: const TextStyle(
                                fontWeight: FontWeight.w600,
                              ),
                            ),
                          ),
                          if (candidate.quota?.planType.isNotEmpty == true)
                            Text(
                              candidate.quota!.planType,
                              style: TextStyle(color: eco.textMuted),
                            ),
                          IconButton(
                            tooltip: l.codexQuotaRefresh,
                            onPressed: _busy
                                ? null
                                : () => _run(
                                    (c) => c.refreshCandidate(candidate.id),
                                  ),
                            icon: const Icon(EcoIcons.refresh, size: 17),
                          ),
                        ],
                      ),
                      if (candidate.email.isNotEmpty &&
                          candidate.email != candidate.name)
                        Text(
                          candidate.email,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(color: eco.textMuted, fontSize: 12),
                        ),
                      const SizedBox(height: 12),
                      if (candidate.quota != null)
                        _QuotaWindows(quota: candidate.quota!),
                      if (!candidate.available)
                        _Notice(
                          text: candidate.quota == null
                              ? l.codexQuotaUnknown
                              : l.codexQuotaExhausted,
                        ),
                    ],
                  ),
                ),
              ),
            ),
            const SizedBox(height: 12),
          ],
        ] else if (account == null) ...[
          _Notice(text: l.codexQuotaNoAccount),
          TextButton(
            onPressed: _busy ? null : () => setState(() => _choosing = true),
            child: Text(l.codexQuotaSwitchAccount),
          ),
        ] else ...[
          EcoGroupedSurface(
            margin: EdgeInsets.zero,
            padding: const EdgeInsets.all(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Icon(EcoIcons.user, size: 20, color: eco.textSecondary),
                    const SizedBox(width: 10),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            l.codexQuotaCurrentAccount(account.name),
                            style: const TextStyle(fontWeight: FontWeight.w600),
                          ),
                          if (account.email.isNotEmpty &&
                              account.email != account.name) ...[
                            const SizedBox(height: 4),
                            Text(
                              account.email,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: TextStyle(
                                color: eco.textMuted,
                                fontSize: 12,
                              ),
                            ),
                          ],
                        ],
                      ),
                    ),
                    if (quota?.planType.isNotEmpty == true)
                      Text(
                        quota!.planType,
                        style: TextStyle(color: eco.textMuted, fontSize: 12),
                      ),
                  ],
                ),
                const SizedBox(height: 24),
                if (quota == null)
                  _Notice(text: l.codexQuotaIdle)
                else
                  _QuotaWindows(quota: quota),
                const SizedBox(height: 8),
                Text(
                  quota != null && quota.resetCreditsAvailable > 0
                      ? l.codexQuotaResetCount('${quota.resetCreditsAvailable}')
                      : l.codexQuotaNoCredit,
                  style: TextStyle(color: eco.textMuted, fontSize: 12),
                ),
                if (snapshot!.active.hasPending) ...[
                  const SizedBox(height: 10),
                  Text(
                    l.codexQuotaSwitching,
                    style: TextStyle(color: eco.textSecondary, fontSize: 13),
                  ),
                ],
                const SizedBox(height: 16),
                Row(
                  children: [
                    Expanded(
                      child: OutlinedButton(
                        onPressed: _busy || snapshot.active.hasPending
                            ? null
                            : () => setState(() => _choosing = true),
                        child: Text(l.codexQuotaSwitchAccount),
                      ),
                    ),
                    const SizedBox(width: 10),
                    Expanded(
                      child: FilledButton.tonal(
                        onPressed:
                            _busy ||
                                snapshot.active.hasPending ||
                                quota == null ||
                                quota.resetCreditsAvailable <= 0
                            ? null
                            : () => _run(_reset),
                        child: Text(l.codexQuotaUseReset),
                      ),
                    ),
                  ],
                ),
                if (quota != null) ...[
                  const SizedBox(height: 12),
                  Text(
                    l.codexQuotaUpdatedAt(
                      DateFormat.Hm(
                        Localizations.localeOf(context).toLanguageTag(),
                      ).format(
                        DateTime.fromMillisecondsSinceEpoch(quota.fetchedAt),
                      ),
                    ),
                    style: TextStyle(color: eco.textMuted, fontSize: 11),
                  ),
                ],
              ],
            ),
          ),
        ],
        if (_message != null) _Notice(text: _message!),
      ],
    );
  }
}

class _Notice extends StatelessWidget {
  const _Notice({required this.text});
  final String text;
  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 14),
    child: Text(
      text,
      style: TextStyle(
        color: ecoColors(context).textMuted,
        fontSize: 13,
        height: 1.5,
      ),
    ),
  );
}

class _QuotaWindows extends StatelessWidget {
  const _QuotaWindows({required this.quota});
  final CodexAccountQuota quota;
  @override
  Widget build(BuildContext context) {
    final l = context.l10n;
    final eco = ecoColors(context);
    final windows = quota.windows.where((w) => w.valid).toList();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (windows.isEmpty) _Notice(text: l.codexQuotaIdle),
        for (final window in windows) ...[
          Row(
            children: [
              Expanded(
                child: Text(
                  window.seconds >= 86400 && window.seconds % 86400 == 0
                      ? l.codexQuotaDays(_number(window.seconds / 86400))
                      : l.codexQuotaHours(_number(window.seconds / 3600)),
                  style: TextStyle(color: eco.textSecondary, fontSize: 13),
                ),
              ),
              Text(
                l.codexQuotaRemaining(_number(window.remaining)),
                style: const TextStyle(
                  fontSize: 13,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ],
          ),
          const SizedBox(height: 10),
          ClipRRect(
            borderRadius: BorderRadius.circular(99),
            child: LinearProgressIndicator(
              value: window.remaining / 100,
              minHeight: 6,
              backgroundColor: eco.borderSubtle,
              color: eco.accent,
            ),
          ),
          if (window.resetsAt(quota.fetchedAt) != null) ...[
            const SizedBox(height: 8),
            Text(
              l.codexQuotaResetsAt(
                DateFormat.Md(
                  Localizations.localeOf(context).toLanguageTag(),
                ).add_Hm().format(window.resetsAt(quota.fetchedAt)!),
              ),
              style: TextStyle(color: eco.textMuted, fontSize: 11),
            ),
          ],
          const SizedBox(height: 20),
        ],
      ],
    );
  }
}

String _number(num value) => (value * 10).round() % 10 == 0
    ? value.toStringAsFixed(0)
    : value.toStringAsFixed(1);
