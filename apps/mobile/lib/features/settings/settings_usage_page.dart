import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';

import '../../core/locale/app_localizations_ext.dart';
import '../../core/locale/app_error_localizations.dart';
import '../../core/models/account_usage_models.dart';
import '../threads/thread_providers.dart';

class SettingsUsagePage extends StatelessWidget {
  const SettingsUsagePage({super.key});
  @override
  Widget build(BuildContext context) => DefaultTabController(
    length: 2,
    child: Scaffold(
      appBar: AppBar(
        title: Text(context.l10n.usageTitle),
        bottom: TabBar(
          tabs: [
            Tab(text: context.l10n.usageOverview),
            Tab(text: context.l10n.usageAccountHistory),
          ],
        ),
      ),
      body: const TabBarView(children: [_Overview(), _AccountHistory()]),
    ),
  );
}

String usagePeriodLabel(BuildContext context, String period) =>
    switch (period) {
      '5h' => context.l10n.usagePeriod5h,
      'day' => context.l10n.usagePeriodDay,
      'week' => context.l10n.usagePeriodWeek,
      'month' => context.l10n.usagePeriodMonth,
      'all' => context.l10n.usagePeriodAll,
      _ => throw ArgumentError.value(period),
    };
String _date(BuildContext context, int at) =>
    '${DateFormat.yMd(context.l10n.localeName).add_Hm().format(DateTime.fromMillisecondsSinceEpoch(at, isUtc: true))} UTC';
String _range(BuildContext context, int start, int end) =>
    '${_date(context, start)} – ${_date(context, end)}';

class _Overview extends ConsumerStatefulWidget {
  const _Overview();
  @override
  ConsumerState<_Overview> createState() => _OverviewState();
}

class _OverviewState extends ConsumerState<_Overview> {
  String _period = 'day';
  String? _provider, _model;
  int? _at;
  UsageOverview? _data;
  Object? _error;
  bool _busy = false;
  int _generation = 0;
  List<UsageDimension> _dimensions = [];
  Future<void> _load() async {
    final generation = ++_generation;
    setState(() {
      _busy = true;
      _error = null;
      _data = null;
    });
    try {
      final rpc = ref.read(desktopRpcProvider);
      if (rpc == null) throw StateError('Desktop is not connected');
      final result = await rpc.usageOverview(
        period: _period,
        at: _at,
        providerKey: _provider,
        modelId: _model,
      );
      if (mounted && generation == _generation) {
        setState(() {
          _data = result;
          _dimensions = result.dimensions;
        });
      }
    } catch (error) {
      if (mounted && generation == _generation) setState(() => _error = error);
    } finally {
      if (mounted && generation == _generation) setState(() => _busy = false);
    }
  }

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  Widget build(BuildContext context) {
    ref.listen(desktopRpcProvider, (_, next) {
      _provider = null;
      _model = null;
      _dimensions = [];
      _load();
    });
    final l = context.l10n;
    final data = _data;
    final providers = {
      for (final d in _dimensions) d.providerKey: d.providerName,
    };
    final models = _dimensions
        .where((d) => _provider == null || d.providerKey == _provider)
        .map((d) => d.modelId)
        .toSet();
    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            for (final period in ['5h', 'day', 'week', 'month', 'all'])
              ChoiceChip(
                label: Text(usagePeriodLabel(context, period)),
                selected: _period == period,
                onSelected: _busy
                    ? null
                    : (_) {
                        _period = period;
                        _at = null;
                        _load();
                      },
              ),
          ],
        ),
        DropdownButton<String>(
          isExpanded: true,
          value: _provider ?? '',
          items: [
            DropdownMenuItem(value: '', child: Text(l.usageAllProviders)),
            for (final entry in providers.entries)
              DropdownMenuItem(
                value: entry.key,
                child: Text(
                  entry.value,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
              ),
          ],
          onChanged: _busy
              ? null
              : (value) {
                  _provider = value == '' ? null : value;
                  _model = null;
                  _load();
                },
        ),
        DropdownButton<String>(
          isExpanded: true,
          value: _model ?? '',
          items: [
            DropdownMenuItem(value: '', child: Text(l.usageAllModels)),
            for (final model in models)
              DropdownMenuItem(
                value: model,
                child: Text(
                  model,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
              ),
          ],
          onChanged: _busy
              ? null
              : (value) {
                  _model = value == '' ? null : value;
                  _load();
                },
        ),
        Row(
          children: [
            IconButton(
              tooltip: l.usagePrevious,
              onPressed: _busy || data?.startAt == null
                  ? null
                  : () {
                      _at = (data!.startAt! - 1).clamp(
                        0,
                        DateTime.now().millisecondsSinceEpoch,
                      );
                      _load();
                    },
              icon: const Icon(Icons.chevron_left),
            ),
            Expanded(
              child: Text(
                data?.startAt == null
                    ? usagePeriodLabel(context, _period)
                    : _range(context, data!.startAt!, data.endAt!),
                textAlign: TextAlign.center,
              ),
            ),
            IconButton(
              tooltip: l.usageNext,
              onPressed:
                  _busy ||
                      data?.endAt == null ||
                      data!.endAt! >= DateTime.now().millisecondsSinceEpoch
                  ? null
                  : () {
                      _at = data.endAt;
                      _load();
                    },
              icon: const Icon(Icons.chevron_right),
            ),
            IconButton(
              tooltip: l.commonRetry,
              onPressed: _busy ? null : _load,
              icon: const Icon(Icons.refresh),
            ),
          ],
        ),
        if (_busy) const LinearProgressIndicator(),
        if (_error != null) _Failure(error: _error!, retry: _load),
        if (data != null) ...[
          _Totals(totals: data.totals),
          Text(
            '${l.usageTimeZone}: ${data.timeZone}\n${l.usageTrackingSince}: ${_date(context, data.trackingStartedAt)}',
          ),
          if (data.recordingFailures > 0)
            _Warning('${l.usageRecordingFailures}: ${data.recordingFailures}'),
          if (data.rows.isEmpty)
            Padding(
              padding: const EdgeInsets.all(24),
              child: Text(l.usageEmpty),
            ),
          for (final row in data.rows)
            Card(
              child: Padding(
                padding: const EdgeInsets.all(12),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      '${row.providerName} · ${row.modelId}',
                      style: Theme.of(context).textTheme.titleSmall,
                    ),
                    _Totals(totals: row.totals, compact: true),
                  ],
                ),
              ),
            ),
        ],
      ],
    );
  }
}

class _UsageAccount {
  const _UsageAccount(this.kind, this.id, this.label);
  final String kind, id, label;
  String get key => '$kind:$id';
}

class _AccountHistory extends ConsumerStatefulWidget {
  const _AccountHistory();
  @override
  ConsumerState<_AccountHistory> createState() => _AccountHistoryState();
}

class _AccountHistoryState extends ConsumerState<_AccountHistory> {
  List<_UsageAccount> _accounts = [];
  String? _selected;
  String _period = '5h';
  AccountUsageHistory? _history;
  final List<AccountUsageBucket> _buckets = [];
  Object? _error;
  Object? _olderError;
  bool _busy = false, _accountsBusy = false;
  int _generation = 0, _accountGeneration = 0;
  bool _accountsFailed = false;
  Future<void> _loadAccounts() async {
    final generation = ++_accountGeneration;
    ++_generation;
    setState(() {
      _accountsBusy = true;
      _busy = false;
      _error = null;
      _olderError = null;
      _accountsFailed = false;
      _accounts = [];
      _selected = null;
      _history = null;
      _buckets.clear();
    });
    try {
      final rpc = ref.read(desktopRpcProvider);
      if (rpc == null) throw StateError('Desktop is not connected');
      final results = await Future.wait<Object>([
        rpc.listCodexAccounts(),
        rpc.listChatGptOauthAccounts(),
        rpc.usageOverview(period: 'all'),
      ]);
      final accounts = <_UsageAccount>[];
      for (final a in results[0] as List) {
        accounts.add(
          _UsageAccount(
            'chatgpt_login',
            a.id as String,
            'ChatGPT Login · ${a.name}',
          ),
        );
      }
      for (final a in results[1] as List<Map<String, dynamic>>) {
        accounts.add(
          _UsageAccount(
            'chatgpt_oauth',
            a['accountId'] as String,
            'ChatGPT OAuth · ${a['displayName']}',
          ),
        );
      }
      final overview = results[2] as UsageOverview;
      final providers = {
        for (final d in overview.dimensions.where(
          (d) => d.providerKey.startsWith('provider:'),
        ))
          d.providerKey.substring(9): d.providerName,
      };
      for (final p in providers.entries) {
        accounts.add(_UsageAccount('custom_provider', p.key, p.value));
      }
      if (!mounted || generation != _accountGeneration) return;
      setState(() {
        _accounts = accounts;
        _selected = accounts.firstOrNull?.key;
      });
      if (_selected != null) await _load();
    } catch (error) {
      if (mounted && generation == _accountGeneration) {
        setState(() {
          _error = error;
          _accountsFailed = true;
        });
      }
    } finally {
      if (mounted && generation == _accountGeneration) {
        setState(() => _accountsBusy = false);
      }
    }
  }

  Future<void> _load({bool older = false}) async {
    final account = _accounts.where((a) => a.key == _selected).firstOrNull;
    if (account == null) {
      return;
    }
    final cursor = older ? _history?.nextBefore : null;
    if (older && cursor == null) return;
    final generation = ++_generation;
    setState(() {
      _busy = true;
      _error = null;
      _olderError = null;
      if (!older) {
        _history = null;
        _buckets.clear();
      }
    });
    try {
      final rpc = ref.read(desktopRpcProvider);
      if (rpc == null) throw StateError('Desktop is not connected');
      final result = await rpc.accountUsageHistory(
        kind: account.kind,
        accountId: account.id,
        period: _period,
        before: cursor,
      );
      if (mounted && generation == _generation) {
        setState(() {
          _history = result;
          final known = _buckets.map((b) => b.startAt).toSet();
          _buckets.addAll(
            result.buckets.where((b) => !known.contains(b.startAt)),
          );
        });
      }
    } catch (error) {
      if (mounted && generation == _generation) {
        setState(() {
          if (older) {
            _olderError = error;
          } else {
            _error = error;
          }
        });
      }
    } finally {
      if (mounted && generation == _generation) setState(() => _busy = false);
    }
  }

  @override
  void initState() {
    super.initState();
    _loadAccounts();
  }

  @override
  Widget build(BuildContext context) {
    ref.listen(desktopRpcProvider, (_, next) => _loadAccounts());
    final l = context.l10n;
    final h = _history;
    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        if (_accountsBusy || _busy) const LinearProgressIndicator(),
        if (_accounts.isNotEmpty)
          DropdownButton<String>(
            isExpanded: true,
            value: _selected,
            items: [
              for (final account in _accounts)
                DropdownMenuItem(
                  value: account.key,
                  child: Text(account.label, overflow: TextOverflow.ellipsis),
                ),
            ],
            onChanged: _busy || _accountsBusy
                ? null
                : (value) {
                    _selected = value;
                    _load();
                  },
          ),
        Wrap(
          spacing: 8,
          children: [
            for (final period in ['5h', 'day', 'week', 'month'])
              ChoiceChip(
                label: Text(usagePeriodLabel(context, period)),
                selected: _period == period,
                onSelected: _busy || _accountsBusy
                    ? null
                    : (_) {
                        _period = period;
                        _load();
                      },
              ),
          ],
        ),
        Align(
          alignment: Alignment.centerRight,
          child: IconButton(
            tooltip: l.commonRetry,
            onPressed: _busy || _accountsBusy ? null : _loadAccounts,
            icon: const Icon(Icons.refresh),
          ),
        ),
        if (_error != null)
          _Failure(
            error: _error!,
            retry: _accountsFailed
                ? _loadAccounts
                : () => _load(older: h != null),
          ),
        if (!_accountsBusy && !_accountsFailed && _accounts.isEmpty)
          Text(l.usageUnknownAccount),
        if (h != null) ...[
          Text(
            l.usagePeriodAll,
            style: Theme.of(context).textTheme.titleMedium,
          ),
          _Totals(totals: h.totals),
          Text(
            '${l.usageTimeZone}: ${h.timeZone}\n${l.usageTrackingSince}: ${_date(context, h.trackingStartedAt)}',
          ),
          if (h.recordingFailure != null)
            _Warning(
              '${l.usageRecordingFailures}: ${h.recordingFailure!['count']}\n${h.recordingFailure!['lastError']}',
            ),
          if (_buckets.isEmpty)
            Padding(
              padding: const EdgeInsets.all(24),
              child: Text(l.usageEmpty),
            ),
          for (final bucket in _buckets)
            Card(
              child: Padding(
                padding: const EdgeInsets.all(12),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(_range(context, bucket.startAt, bucket.endAt)),
                    _Totals(totals: bucket.totals, compact: true),
                  ],
                ),
              ),
            ),
          if (_olderError != null)
            _Failure(error: _olderError!, retry: () => _load(older: true))
          else if (h.nextBefore != null)
            TextButton(
              onPressed: _busy ? null : () => _load(older: true),
              child: Text(l.usageOlder),
            ),
        ],
      ],
    );
  }
}

class _Totals extends StatelessWidget {
  const _Totals({required this.totals, this.compact = false});
  final AccountUsageTotals totals;
  final bool compact;
  @override
  Widget build(BuildContext context) {
    final l = context.l10n;
    final n = NumberFormat.decimalPattern(l.localeName);
    final allUnpriced =
        totals.records > 0 && totals.unpricedRecords == totals.records;
    final values = <String, String>{
      l.usageTotalTokens: n.format(totals.totalTokens),
      l.usageEstimatedCost: allUnpriced
          ? '—'
          : NumberFormat.currency(
              locale: l.localeName,
              symbol: '\$',
              decimalDigits: 4,
            ).format(totals.estimatedCostUsd),
      l.usageRecords: n.format(totals.records),
      if (!compact) ...{
        l.usageInput: n.format(totals.inputTokens),
        l.usageOutput: n.format(totals.outputTokens),
        l.usageCacheRead: n.format(totals.cacheReadTokens),
        l.usageCacheWrite: n.format(totals.cacheCreationTokens),
        l.usageReasoning: n.format(totals.reasoningTokens),
      },
    };
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        for (final value in values.entries)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 5),
            child: Wrap(
              alignment: WrapAlignment.spaceBetween,
              spacing: 12,
              children: [
                Text(value.key),
                Text(
                  value.value,
                  style: const TextStyle(fontWeight: FontWeight.w600),
                ),
              ],
            ),
          ),
        if (totals.unpricedRecords > 0)
          _Warning('${l.usageUnpriced}: ${n.format(totals.unpricedRecords)}'),
      ],
    );
  }
}

class _Warning extends StatelessWidget {
  const _Warning(this.text);
  final String text;
  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 12),
    child: Text(
      text,
      style: TextStyle(color: Theme.of(context).colorScheme.error),
    ),
  );
}

class _Failure extends StatelessWidget {
  const _Failure({required this.error, required this.retry});
  final Object error;
  final VoidCallback retry;
  @override
  Widget build(BuildContext context) => Column(
    children: [
      SelectableText(localizedAppError(error, context.l10n)),
      TextButton(onPressed: retry, child: Text(context.l10n.commonRetry)),
    ],
  );
}
