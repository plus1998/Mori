import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';
import 'package:uuid/uuid.dart';

import '../../core/locale/app_error_localizations.dart';
import '../../core/locale/app_localizations_ext.dart';
import '../../core/models/scheduling_models.dart';
import '../../core/theme/eco_theme.dart';
import '../../core/widgets/app_error_state.dart';
import '../threads/thread_providers.dart';
import 'schedule_editor.dart';
import 'scheduling_providers.dart';

Future<void> showSchedulingScreen(BuildContext context, {String? threadId}) =>
    Navigator.of(context, rootNavigator: true).push<void>(
      MaterialPageRoute(builder: (_) => SchedulingScreen(threadId: threadId)),
    );

class SchedulingScreen extends ConsumerStatefulWidget {
  const SchedulingScreen({super.key, this.threadId});
  final String? threadId;
  @override
  ConsumerState<SchedulingScreen> createState() => _SchedulingScreenState();
}

class _SchedulingScreenState extends ConsumerState<SchedulingScreen>
    with WidgetsBindingObserver {
  bool _messages = false;
  bool _busy = false;
  bool _working = false;
  String? _error;
  final _runRequests = <String, String>{};
  @override
  void initState() {
    super.initState();
    _messages = widget.threadId != null;
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
      ref.invalidate(schedulingSnapshotProvider);
    }
  }

  String _date(String value) => DateFormat.yMd(
    context.l10n.localeName,
  ).add_Hm().format(DateTime.parse(value).toLocal());
  String _rule(ScheduleDefinition d) {
    final l = context.l10n;
    return switch (d.trigger['type']) {
      'at' => '${l.schedulingOnce} · ${_date(d.trigger['at'] as String)}',
      'interval' =>
        '${l.schedulingInterval} · ${(d.trigger['everySeconds'] as num) / 60} min',
      _ => '${d.trigger['expression']} · ${d.trigger['timezone']}',
    };
  }

  String _status(String value) {
    final l = context.l10n;
    return switch (value) {
      'pending' => l.schedulingPending,
      'dispatching' => l.schedulingDispatching,
      'running' => l.schedulingRunning,
      'waiting_user' => l.schedulingWaitingUser,
      'completed' => l.schedulingCompleted,
      'failed' => l.schedulingFailed,
      'skipped' => l.schedulingSkipped,
      'cancelled' => l.schedulingCancelled,
      _ => l.schedulingUnknown,
    };
  }

  Future<bool> _confirm(String message) async =>
      await showDialog<bool>(
        context: context,
        builder: (context) => AlertDialog(
          content: Text(message),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context, false),
              child: Text(context.l10n.commonCancel),
            ),
            FilledButton(
              onPressed: () => Navigator.pop(context, true),
              child: Text(context.l10n.commonSubmit),
            ),
          ],
        ),
      ) ??
      false;

  Future<void> _action(ScheduleDefinition d, String action) async {
    if (_busy) return;
    if (action == 'edit') {
      await showScheduleEditor(context, definition: d);
      return;
    }
    if (action == 'history') {
      _history(scheduleId: d.id);
      return;
    }
    if (action == 'enable' && d.isExpiredOneShot) {
      setState(() => _error = context.l10n.schedulingExpired);
      return;
    }
    // Lock before confirmation, including while a dialog is open.
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final l = context.l10n;
      if (action == 'delete' && !await _confirm(l.schedulingDeleteConfirm)) {
        return;
      }
      if (action == 'run' && !await _confirm(l.schedulingRunConfirm)) return;
      if (!mounted) return;
      setState(() => _working = true);
      final rpc = ref.read(desktopRpcProvider);
      if (rpc == null) throw StateError('Desktop is not connected');
      switch (action) {
        case 'delete':
          await rpc.deleteSchedule(d.id);
        case 'run':
          final request = _runRequests.putIfAbsent(
            d.id,
            () => const Uuid().v4(),
          );
          await rpc.runScheduleNow(d.id, request);
          _runRequests.remove(d.id);
        case 'pause':
        case 'enable':
          await rpc.updateSchedule({
            'id': d.id,
            'expectedRevision': d.revision,
            'enabled': action == 'enable',
          });
      }
      ref.invalidate(schedulingSnapshotProvider);
    } catch (error) {
      if (mounted) {
        setState(() => _error = localizedAppError(error, context.l10n));
      }
      // A revision conflict requires a fresh definition before retrying.
      ref.invalidate(schedulingSnapshotProvider);
    } finally {
      if (mounted) {
        setState(() {
          _busy = false;
          _working = false;
        });
      }
    }
  }

  void _openThread(String id, {BuildContext? historyContext}) {
    if (historyContext != null) Navigator.of(historyContext).pop();
    final router = GoRouter.of(context);
    Navigator.of(context).pop();
    router.push('/threads/$id');
  }

  void _history({String? scheduleId}) {
    Navigator.of(context, rootNavigator: true).push<void>(
      MaterialPageRoute(
        builder: (historyContext) => Consumer(
          builder: (context, ref, _) {
            final l = context.l10n;
            final snapshot = ref.watch(schedulingSnapshotProvider);
            return Scaffold(
              appBar: AppBar(title: Text(l.schedulingHistory)),
              body: snapshot.when(
                loading: () => const Center(child: CircularProgressIndicator()),
                error: (error, _) => AppErrorState(
                  title: l.schedulingLoadFailed,
                  message: localizedAppError(error, l),
                  onRetry: () async {
                    ref.invalidate(schedulingSnapshotProvider);
                    await ref.read(schedulingSnapshotProvider.future);
                  },
                  retryLabel: l.commonRetry,
                ),
                data: (data) {
                  final runs =
                      data.occurrences
                          .where(
                            (o) => scheduleId != null
                                ? o.scheduleId == scheduleId
                                : o.definition.isMessage == _messages &&
                                      (widget.threadId == null ||
                                          o.definition.threadId ==
                                              widget.threadId),
                          )
                          .toList()
                        ..sort(
                          (a, b) => b.scheduledAt.compareTo(a.scheduledAt),
                        );
                  if (runs.isEmpty) {
                    return Center(child: Text(l.schedulingNoHistory));
                  }
                  return ListView(
                    children: [
                      for (final o in runs)
                        ListTile(
                          title: Text(
                            '${o.definition.name} · ${_status(o.status)}',
                          ),
                          subtitle: Text(
                            '${_date(o.scheduledAt)}${o.error == null ? '' : '\n${o.error}'}',
                          ),
                          trailing: o.threadId == null
                              ? null
                              : IconButton(
                                  tooltip: l.schedulingOpenThread,
                                  icon: const Icon(Icons.open_in_new),
                                  onPressed: () => _openThread(
                                    o.threadId!,
                                    historyContext: historyContext,
                                  ),
                                ),
                        ),
                    ],
                  );
                },
              ),
            );
          },
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final l = context.l10n;
    final snapshot = ref.watch(schedulingSnapshotProvider);
    return Scaffold(
      backgroundColor: ecoColors(context).bgMain,
      appBar: AppBar(
        title: Text(
          widget.threadId == null ? l.schedulingTitle : l.schedulingMessages,
        ),
        actions: [
          IconButton(
            tooltip: l.schedulingHistory,
            onPressed: _busy ? null : () => _history(),
            icon: const Icon(Icons.history),
          ),
          IconButton(
            tooltip: _messages ? l.schedulingNewMessage : l.schedulingNewTask,
            onPressed: _busy
                ? null
                : () async {
                    if (_messages && widget.threadId == null) {
                      await _chooseMessageThread();
                    } else {
                      await showScheduleEditor(
                        context,
                        threadId: _messages ? widget.threadId : null,
                      );
                    }
                  },
            icon: const Icon(Icons.add),
          ),
        ],
      ),
      body: Column(
        children: [
          if (widget.threadId == null)
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16),
              child: SegmentedButton<bool>(
                segments: [
                  ButtonSegment(value: false, label: Text(l.schedulingTitle)),
                  ButtonSegment(value: true, label: Text(l.schedulingMessages)),
                ],
                selected: {_messages},
                onSelectionChanged: _busy
                    ? null
                    : (value) => setState(() {
                        _messages = value.single;
                        _error = null;
                      }),
              ),
            ),
          if (_working) const LinearProgressIndicator(),
          if (_error != null)
            Padding(
              padding: const EdgeInsets.all(16),
              child: SelectableText(
                _error!,
                style: TextStyle(color: Theme.of(context).colorScheme.error),
              ),
            ),
          Expanded(
            child: snapshot.when(
              loading: () => const Center(child: CircularProgressIndicator()),
              error: (error, _) => AppErrorState(
                title: l.schedulingLoadFailed,
                message: localizedAppError(error, l),
                onRetry: () async {
                  ref.invalidate(schedulingSnapshotProvider);
                  await ref.read(schedulingSnapshotProvider.future);
                },
                retryLabel: l.commonRetry,
              ),
              data: (data) {
                final schedules = data.schedules
                    .where(
                      (d) =>
                          d.isMessage == _messages &&
                          (widget.threadId == null ||
                              d.threadId == widget.threadId),
                    )
                    .toList();
                return RefreshIndicator(
                  onRefresh: () async {
                    ref.invalidate(schedulingSnapshotProvider);
                    await ref.read(schedulingSnapshotProvider.future);
                  },
                  child: ListView(
                    physics: const AlwaysScrollableScrollPhysics(),
                    padding: const EdgeInsets.all(16),
                    children: [
                      Text(
                        l.schedulingHint,
                        style: TextStyle(
                          color: ecoColors(context).textSecondary,
                        ),
                      ),
                      const SizedBox(height: 12),
                      if (schedules.isEmpty)
                        Padding(
                          padding: const EdgeInsets.all(24),
                          child: Text(l.schedulingEmpty),
                        ),
                      for (final d in schedules)
                        Card(
                          child: ExpansionTile(
                            key: ValueKey(d.id),
                            title: Text(d.name),
                            subtitle: Text(
                              '${d.enabled ? l.schedulingEnabled : l.schedulingPaused}\n${_rule(d)}',
                            ),
                            childrenPadding: const EdgeInsets.all(16),
                            expandedCrossAxisAlignment:
                                CrossAxisAlignment.start,
                            children: [
                              SelectableText(d.prompt),
                              const SizedBox(height: 12),
                              if (d.workspacePath != null)
                                Text(d.workspacePath!),
                              if (d.threadId != null)
                                TextButton(
                                  onPressed: _busy
                                      ? null
                                      : () => _openThread(d.threadId!),
                                  child: Text(l.schedulingOpenThread),
                                ),
                              if (d.nextRunAt != null)
                                Text(
                                  '${l.schedulingNext}: ${_date(d.nextRunAt!)}',
                                ),
                              if (d.error != null)
                                SelectableText(
                                  d.error!,
                                  style: TextStyle(
                                    color: Theme.of(context).colorScheme.error,
                                  ),
                                ),
                              Wrap(
                                spacing: 8,
                                children: [
                                  TextButton(
                                    onPressed: _busy
                                        ? null
                                        : () => _action(d, 'edit'),
                                    child: Text(l.schedulingEdit),
                                  ),
                                  TextButton(
                                    onPressed: _busy
                                        ? null
                                        : () => _action(
                                            d,
                                            d.enabled ? 'pause' : 'enable',
                                          ),
                                    child: Text(
                                      d.enabled
                                          ? l.schedulingPause
                                          : l.schedulingResume,
                                    ),
                                  ),
                                  TextButton(
                                    onPressed: _busy
                                        ? null
                                        : () => _action(d, 'run'),
                                    child: Text(
                                      d.isMessage
                                          ? l.schedulingSendNow
                                          : l.schedulingRunNow,
                                    ),
                                  ),
                                  TextButton(
                                    onPressed: _busy
                                        ? null
                                        : () => _action(d, 'history'),
                                    child: Text(l.schedulingHistory),
                                  ),
                                  TextButton(
                                    onPressed: _busy
                                        ? null
                                        : () => _action(d, 'delete'),
                                    child: Text(l.commonDelete),
                                  ),
                                ],
                              ),
                            ],
                          ),
                        ),
                    ],
                  ),
                );
              },
            ),
          ),
        ],
      ),
    );
  }

  Future<void> _chooseMessageThread() async {
    final id = await showDialog<String>(
      context: context,
      builder: (context) => Consumer(
        builder: (context, ref, _) {
          final threads = ref.watch(threadListProvider);
          return SimpleDialog(
            title: Text(context.l10n.schedulingOpenThread),
            children: threads.when(
              loading: () => [const Center(child: CircularProgressIndicator())],
              error: (error, _) => [
                Text(localizedAppError(error, context.l10n)),
              ],
              data: (items) => [
                for (final t in items)
                  SimpleDialogOption(
                    onPressed: () => Navigator.pop(context, t.id),
                    child: Text(t.title.isEmpty ? t.prompt : t.title),
                  ),
              ],
            ),
          );
        },
      ),
    );
    if (id != null && mounted) await showScheduleEditor(context, threadId: id);
  }
}
