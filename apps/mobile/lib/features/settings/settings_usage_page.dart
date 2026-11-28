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
  Widget build(BuildContext context) {
    final l = context.l10n;
    final textScaler = MediaQuery.textScalerOf(context);
    final tabHeight = (textScaler.scale(17) * 2 + 8).clamp(
      48.0,
      double.infinity,
    );
    return DefaultTabController(
      length: 2,
      child: Scaffold(
        appBar: AppBar(
          centerTitle: true,
          toolbarHeight: 48,
          title: Text(l.usageTitle),
          backgroundColor: Theme.of(context).scaffoldBackgroundColor,
          surfaceTintColor: Colors.transparent,
          bottom: TabBar(
            indicatorSize: TabBarIndicatorSize.tab,
            labelStyle: Theme.of(context).textTheme.titleSmall,
            labelPadding: const EdgeInsets.symmetric(horizontal: 8),
            tabs: [
              for (final label in [l.usageOverview, l.usageAccountHistory])
                Tab(
                  height: tabHeight,
                  child: Text(label, textAlign: TextAlign.center),
                ),
            ],
          ),
        ),
        body: const SafeArea(
          top: false,
          child: TabBarView(children: [_Overview(), _AccountHistory()]),
        ),
      ),
    );
  }
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
DateTime _utc(int at) => DateTime.fromMillisecondsSinceEpoch(at, isUtc: true);

String _date(BuildContext context, int at) =>
    '${DateFormat.yMMMd(context.l10n.localeName).add_Hm().format(_utc(at))} UTC';

String _range(BuildContext context, int start, int end) {
  final from = _utc(start);
  final to = _utc(end);
  final locale = context.l10n.localeName;
  final date = DateFormat.yMMMd(locale);
  final time = DateFormat.Hm(locale);
  if (DateUtils.isSameDay(from, to)) {
    return '${date.format(from)} · ${time.format(from)}–${time.format(to)} UTC';
  }
  final dateTime = date.add_Hm();
  return '${dateTime.format(from)} –\n${dateTime.format(to)} UTC';
}

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
    final models = {
      for (final d in _dimensions)
        if (_provider == null || d.providerKey == _provider)
          d.modelId: d.modelId,
    };
    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        _PeriodPicker(
          periods: const ['5h', 'day', 'week', 'month', 'all'],
          selected: _period,
          onChanged: _busy
              ? null
              : (period) {
                  _period = period;
                  _at = null;
                  _load();
                },
        ),
        const SizedBox(height: 8),
        Row(
          children: [
            Expanded(
              child: _UsageSelect(
                value: _provider ?? '',
                options: {'': l.usageAllProviders, ...providers},
                onChanged: _busy
                    ? null
                    : (value) {
                        _provider = value == '' ? null : value;
                        _model = null;
                        _load();
                      },
              ),
            ),
            const SizedBox(width: 8),
            Expanded(
              child: _UsageSelect(
                value: _model ?? '',
                options: {'': l.usageAllModels, ...models},
                onChanged: _busy
                    ? null
                    : (value) {
                        _model = value == '' ? null : value;
                        _load();
                      },
              ),
            ),
          ],
        ),
        const SizedBox(height: 4),
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
              tooltip: l.commonRefresh,
              onPressed: _busy ? null : _load,
              icon: const Icon(Icons.refresh),
            ),
          ],
        ),
        _UsageProgress(busy: _busy),
        if (_error != null) _Failure(error: _error!, retry: _load),
        if (data != null) ...[
          _UsageSummary(
            totals: data.totals,
            timeZone: data.timeZone,
            trackingStartedAt: data.trackingStartedAt,
          ),
          if (data.recordingFailures > 0)
            _Warning('${l.usageRecordingFailures}: ${data.recordingFailures}'),
          if (data.rows.isEmpty) _EmptyUsage(l.usageEmpty),
          for (final row in data.rows)
            _UsageEntry(
              title: row.modelId,
              subtitle: row.providerName,
              totals: row.totals,
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
        if (!accounts.any((account) => account.key == _selected)) {
          _selected = accounts.firstOrNull?.key;
        }
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
    ref.listen(desktopRpcProvider, (_, _) {
      _selected = null;
      _loadAccounts();
    });
    final l = context.l10n;
    final history = _history;
    final busy = _accountsBusy || _busy;
    return ListView(
      padding: const EdgeInsets.fromLTRB(20, 8, 20, 20),
      children: [
        Row(
          children: [
            Expanded(
              child: _accounts.isNotEmpty
                  ? _UsageSelect(
                      value: _selected,
                      filled: false,
                      options: {
                        for (final account in _accounts)
                          account.key: account.label,
                      },
                      onChanged: busy
                          ? null
                          : (value) {
                              _selected = value;
                              _load();
                            },
                    )
                  : Text(l.usageAccount),
            ),
            const SizedBox(width: 8),
            IconButton(
              tooltip: l.commonRefresh,
              onPressed: busy ? null : _loadAccounts,
              icon: const Icon(Icons.refresh),
            ),
          ],
        ),
        const Divider(height: 1),
        const SizedBox(height: 16),
        if (_accounts.isNotEmpty)
          _HistoryPeriods(
            periods: const ['5h', 'day', 'week', 'month'],
            selected: _period,
            onChanged: busy
                ? null
                : (period) {
                    _period = period;
                    _load();
                  },
          ),
        _UsageProgress(busy: busy && history == null),
        if (_error != null)
          _Failure(
            error: _error!,
            retry: _accountsFailed ? _loadAccounts : _load,
          ),
        if (!busy && !_accountsFailed && _accounts.isEmpty)
          _EmptyUsage(l.usageUnknownAccount),
        if (history != null) ...[
          _UsageSummary(
            title: l.usagePeriodAll,
            totals: history.totals,
            timeZone: history.timeZone,
            trackingStartedAt: history.trackingStartedAt,
          ),
          if (history.recordingFailure case final failure?)
            _Warning(
              '${l.usageRecordingFailures}: ${failure['count']}\n${failure['lastError']}',
            ),
          if (_buckets.isEmpty) _EmptyUsage(l.usageEmpty),
          if (_buckets.isNotEmpty) ...[
            const SizedBox(height: 16),
            Card(
              shape: _usageCardShape,
              margin: EdgeInsets.zero,
              child: Column(
                children: [
                  for (final (index, bucket) in _buckets.indexed) ...[
                    if (index > 0)
                      const Divider(height: 1, indent: 16, endIndent: 16),
                    _UsageEntry(
                      title: DateFormat.yMMMd(
                        l.localeName,
                      ).format(_utc(bucket.startAt)),
                      timeRange: _bucketTime(context, bucket),
                      totals: bucket.totals,
                    ),
                  ],
                ],
              ),
            ),
          ],
          if (_olderError != null)
            _Failure(error: _olderError!, retry: () => _load(older: true))
          else if (history.nextBefore != null)
            TextButton(
              onPressed: _busy ? null : () => _load(older: true),
              child: Text(l.usageOlder),
            ),
          if (_busy) const LinearProgressIndicator(),
        ],
      ],
    );
  }
}

final _usageCardShape = RoundedRectangleBorder(
  borderRadius: BorderRadius.circular(16),
);

String _bucketTime(BuildContext context, AccountUsageBucket bucket) {
  final from = _utc(bucket.startAt);
  final to = _utc(bucket.endAt);
  final locale = context.l10n.localeName;
  final time = DateFormat.Hm(locale);
  if (DateUtils.isSameDay(from, to)) {
    return '${time.format(from)}–${time.format(to)} UTC';
  }
  final endDate = from.year == to.year
      ? DateFormat.MMMd(locale)
      : DateFormat.yMMMd(locale);
  return '${time.format(from)} UTC – ${endDate.add_Hm().format(to)} UTC';
}

class _HistoryPeriods extends StatelessWidget {
  const _HistoryPeriods({
    required this.periods,
    required this.selected,
    required this.onChanged,
  });

  final List<String> periods;
  final String selected;
  final ValueChanged<String>? onChanged;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    return LayoutBuilder(
      builder: (context, constraints) {
        final scale = MediaQuery.textScalerOf(context).scale(15) / 15;
        final columns = constraints.maxWidth >= 280 * scale ? 4 : 2;
        final width = (constraints.maxWidth - 10) / columns;
        return DecoratedBox(
          decoration: BoxDecoration(
            border: Border.all(color: colors.outline),
            borderRadius: BorderRadius.circular(10),
          ),
          child: Padding(
            padding: const EdgeInsets.all(5),
            child: Wrap(
              children: [
                for (final period in periods)
                  SizedBox(
                    width: width,
                    child: Semantics(
                      selected: period == selected,
                      child: TextButton(
                        onPressed: onChanged == null
                            ? null
                            : () => onChanged!(period),
                        style: TextButton.styleFrom(
                          textStyle: theme.textTheme.labelLarge,
                          padding: const EdgeInsets.symmetric(
                            horizontal: 3,
                            vertical: 6,
                          ),
                          minimumSize: const Size(0, 44),
                          tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                          visualDensity: VisualDensity.standard,
                          backgroundColor: period == selected
                              ? colors.primaryContainer
                              : null,
                          foregroundColor: period == selected
                              ? colors.onPrimaryContainer
                              : colors.onSurface,
                          shape: RoundedRectangleBorder(
                            borderRadius: BorderRadius.circular(7),
                          ),
                        ),
                        child: Wrap(
                          alignment: WrapAlignment.center,
                          crossAxisAlignment: WrapCrossAlignment.center,
                          spacing: 3,
                          children: [
                            if (period == selected)
                              const Icon(Icons.check, size: 14),
                            Text(
                              usagePeriodLabel(context, period),
                              textAlign: TextAlign.center,
                            ),
                          ],
                        ),
                      ),
                    ),
                  ),
              ],
            ),
          ),
        );
      },
    );
  }
}

class _PeriodPicker extends StatelessWidget {
  const _PeriodPicker({
    required this.periods,
    required this.selected,
    required this.onChanged,
  });

  final List<String> periods;
  final String selected;
  final ValueChanged<String>? onChanged;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Wrap(
      spacing: 8,
      runSpacing: 4,
      children: [
        for (final period in periods)
          ChoiceChip(
            label: Text(usagePeriodLabel(context, period)),
            labelPadding: EdgeInsets.zero,
            labelStyle: theme.textTheme.labelMedium?.copyWith(
              color: selected == period
                  ? theme.chipTheme.secondaryLabelStyle?.color
                  : null,
            ),
            selected: selected == period,
            showCheckmark: false,
            onSelected: onChanged == null ? null : (_) => onChanged!(period),
          ),
      ],
    );
  }
}

class _UsageSelect extends StatelessWidget {
  const _UsageSelect({
    required this.value,
    required this.options,
    required this.onChanged,
    this.filled = true,
  });

  final String? value;
  final bool filled;
  final Map<String, String> options;
  final ValueChanged<String?>? onChanged;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return DecoratedBox(
      decoration: BoxDecoration(
        color: filled ? theme.colorScheme.surface : null,
        borderRadius: BorderRadius.circular(12),
      ),
      child: DropdownButtonHideUnderline(
        child: DropdownButton<String>(
          isExpanded: true,
          itemHeight: null,
          style: theme.textTheme.titleSmall,
          padding: EdgeInsets.symmetric(horizontal: filled ? 12 : 0),
          borderRadius: BorderRadius.circular(12),
          value: value,
          items: [
            for (final option in options.entries)
              DropdownMenuItem(value: option.key, child: Text(option.value)),
          ],
          selectedItemBuilder: (context) => [
            for (final option in options.entries)
              if (option.key == value)
                ConstrainedBox(
                  constraints: const BoxConstraints(minHeight: 48),
                  child: Align(
                    alignment: AlignmentDirectional.centerStart,
                    child: Padding(
                      padding: const EdgeInsets.symmetric(vertical: 6),
                      child: Text(
                        option.value,
                        maxLines: 3,
                        overflow: TextOverflow.ellipsis,
                      ),
                    ),
                  ),
                )
              else
                const SizedBox.shrink(),
          ],
          onChanged: onChanged,
        ),
      ),
    );
  }
}

class _UsageProgress extends StatelessWidget {
  const _UsageProgress({required this.busy});

  final bool busy;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 7),
    child: SizedBox(
      height: 2,
      child: busy ? const LinearProgressIndicator() : null,
    ),
  );
}

class _UsageSummary extends StatelessWidget {
  const _UsageSummary({
    this.title,
    required this.totals,
    required this.timeZone,
    required this.trackingStartedAt,
  });

  final String? title;
  final AccountUsageTotals totals;
  final String timeZone;
  final int trackingStartedAt;

  @override
  Widget build(BuildContext context) {
    final l = context.l10n;
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final number = NumberFormat.decimalPattern(l.localeName);
    return Card(
      color: Color.alphaBlend(
        colors.primary.withValues(alpha: .10),
        colors.surface,
      ),
      shape: _usageCardShape,
      margin: EdgeInsets.zero,
      clipBehavior: Clip.antiAlias,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 16, 16, 0),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                if (title case final title?) ...[
                  Text(title, style: theme.textTheme.titleLarge),
                  const SizedBox(height: 12),
                ],
                _UsageMetrics(totals: totals, prominent: true),
                const SizedBox(height: 12),
                const Divider(height: 1),
                Padding(
                  padding: const EdgeInsets.symmetric(vertical: 9),
                  child: _UsageDetail(
                    l.usageRecords,
                    number.format(totals.records),
                  ),
                ),
                if (totals.unpricedRecords > 0)
                  _Warning(
                    '${l.usageUnpriced}: ${number.format(totals.unpricedRecords)}',
                  ),
              ],
            ),
          ),
          const Divider(height: 1, indent: 16, endIndent: 16),
          ExpansionTile(
            title: Text(l.usageTokenDetails, style: theme.textTheme.titleSmall),
            tilePadding: const EdgeInsets.symmetric(horizontal: 16),
            childrenPadding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
            shape: const Border(),
            collapsedShape: const Border(),
            children: [
              _UsageDetail(l.usageInput, number.format(totals.inputTokens)),
              _UsageDetail(l.usageOutput, number.format(totals.outputTokens)),
              _UsageDetail(
                l.usageCacheRead,
                number.format(totals.cacheReadTokens),
              ),
              _UsageDetail(
                l.usageCacheWrite,
                number.format(totals.cacheCreationTokens),
              ),
              _UsageDetail(
                l.usageReasoning,
                number.format(totals.reasoningTokens),
              ),
              const Divider(height: 20),
              _UsageDetail(l.usageTimeZone, timeZone),
              _UsageDetail(
                l.usageTrackingSince,
                _date(context, trackingStartedAt),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class _UsageEntry extends StatelessWidget {
  const _UsageEntry({
    required this.title,
    this.subtitle,
    this.timeRange,
    required this.totals,
  });

  final String title;
  final String? subtitle;
  final String? timeRange;
  final AccountUsageTotals totals;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final range = timeRange;
    final content = Padding(
      padding: const EdgeInsets.all(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (subtitle case final subtitle?)
            Text(subtitle, style: theme.textTheme.labelMedium),
          if (range == null)
            Text(title, style: theme.textTheme.titleSmall)
          else ...[
            Wrap(
              alignment: WrapAlignment.spaceBetween,
              crossAxisAlignment: WrapCrossAlignment.center,
              spacing: 12,
              runSpacing: 4,
              children: [
                Text(title, style: theme.textTheme.titleSmall),
                Text(range, style: theme.textTheme.bodySmall),
              ],
            ),
            const SizedBox(height: 8),
            const Divider(height: 1),
          ],
          const SizedBox(height: 10),
          _UsageMetrics(totals: totals),
          if (totals.unpricedRecords > 0)
            _Warning(
              '${context.l10n.usageUnpriced}: '
              '${NumberFormat.decimalPattern(context.l10n.localeName).format(totals.unpricedRecords)}',
            ),
        ],
      ),
    );
    return range != null
        ? content
        : Card(margin: const EdgeInsets.only(top: 8), child: content);
  }
}

class _UsageMetrics extends StatelessWidget {
  const _UsageMetrics({required this.totals, this.prominent = false});

  final AccountUsageTotals totals;
  final bool prominent;

  @override
  Widget build(BuildContext context) {
    final l = context.l10n;
    final theme = Theme.of(context);
    final number = NumberFormat.decimalPattern(l.localeName);
    final allUnpriced =
        totals.records > 0 && totals.unpricedRecords == totals.records;
    final values = {
      l.usageTotalTokens: number.format(totals.totalTokens),
      l.usageEstimatedCost: allUnpriced
          ? '—'
          : NumberFormat.currency(
              locale: l.localeName,
              symbol: '\$',
              decimalDigits: 4,
            ).format(totals.estimatedCostUsd),
      if (!prominent) l.usageRecords: number.format(totals.records),
    };
    final labelStyle = prominent
        ? theme.textTheme.labelMedium
        : theme.textTheme.labelSmall;
    final valueStyle =
        (prominent
                ? theme.textTheme.headlineMedium
                : theme.textTheme.titleMedium)
            ?.copyWith(
              fontWeight: FontWeight.w700,
              fontFeatures: const [FontFeature.tabularFigures()],
            );
    return LayoutBuilder(
      builder: (context, constraints) {
        const spacing = 12.0;
        final scale = MediaQuery.textScalerOf(context).scale(14) / 14;
        final minColumnWidth = (prominent ? 126 : 76) * scale;
        final columns =
            ((constraints.maxWidth + spacing) / (minColumnWidth + spacing))
                .floor()
                .clamp(1, values.length);
        final width =
            (constraints.maxWidth - (columns - 1) * spacing) / columns;
        final metrics = [
          for (final metric in values.entries)
            SizedBox(
              width: width,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  FittedBox(
                    alignment: AlignmentDirectional.centerStart,
                    fit: BoxFit.scaleDown,
                    child: Text(metric.value, style: valueStyle),
                  ),
                  const SizedBox(height: 2),
                  Text(metric.key, style: labelStyle),
                ],
              ),
            ),
        ];
        if (columns < metrics.length) {
          return Wrap(spacing: spacing, runSpacing: 10, children: metrics);
        }
        return IntrinsicHeight(
          child: Row(
            children: [
              for (final (index, metric) in metrics.indexed) ...[
                if (index > 0) const VerticalDivider(width: spacing),
                Expanded(child: metric),
              ],
            ],
          ),
        );
      },
    );
  }
}

class _UsageDetail extends StatelessWidget {
  const _UsageDetail(this.label, this.value);

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Expanded(
            flex: 3,
            child: Text(label, style: theme.textTheme.bodySmall),
          ),
          const SizedBox(width: 12),
          Expanded(
            flex: 2,
            child: Text(
              value,
              textAlign: TextAlign.end,
              style: theme.textTheme.bodySmall?.copyWith(
                fontWeight: FontWeight.w600,
                fontFeatures: const [FontFeature.tabularFigures()],
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _EmptyUsage extends StatelessWidget {
  const _EmptyUsage(this.text);

  final String text;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.all(20),
    child: Text(
      text,
      textAlign: TextAlign.center,
      style: Theme.of(context).textTheme.bodySmall,
    ),
  );
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
