import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';
import 'package:uuid/uuid.dart';

import '../../core/locale/app_error_localizations.dart';
import '../../core/locale/app_localizations_ext.dart';
import '../../core/models/scheduling_models.dart';
import '../../core/theme/eco_theme.dart';
import '../../core/theme/eco_icons.dart';
import '../../core/widgets/eco_modal_sheet.dart';
import 'schedule_widgets.dart';
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
                          onTap: o.definition.attachments.isEmpty
                              ? null
                              : () => showEcoModalBottomSheet<void>(
                                  context: context,
                                  useSafeArea: true,
                                  showDragHandle: true,
                                  isScrollControlled: true,
                                  builder: (_) => SingleChildScrollView(
                                    padding: const EdgeInsets.all(20),
                                    child: ScheduleImages(
                                      attachments: o.definition.attachments,
                                      threadId: o.definition.threadId!,
                                    ),
                                  ),
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
                final activeStatuses = <String, String>{};
                for (final occurrence in data.occurrences) {
                  if (const [
                    'pending',
                    'dispatching',
                    'running',
                    'waiting_user',
                  ].contains(occurrence.status)) {
                    activeStatuses[occurrence.scheduleId] = occurrence.status;
                  }
                }
                return RefreshIndicator(
                  onRefresh: () async {
                    ref.invalidate(schedulingSnapshotProvider);
                    await ref.read(schedulingSnapshotProvider.future);
                  },
                  child: ListView(
                    physics: const AlwaysScrollableScrollPhysics(),
                    padding: const EdgeInsets.all(16),
                    children: [
                      if (schedules.isEmpty)
                        Padding(
                          padding: const EdgeInsets.all(24),
                          child: Text(l.schedulingEmpty),
                        ),
                      for (final d in schedules) ...[
                        _scheduleCard(d, activeStatuses[d.id]),
                        const SizedBox(height: 12),
                      ],
                      Padding(
                        padding: const EdgeInsets.all(8),
                        child: Text(
                          l.schedulingHint,
                          style: TextStyle(
                            fontSize: 12,
                            height: 1.5,
                            color: ecoColors(context).textMuted,
                          ),
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

  String _definitionStatus(ScheduleDefinition d, String? status) =>
      status != null
      ? _status(status)
      : (d.enabled
            ? context.l10n.schedulingEnabled
            : context.l10n.schedulingPaused);

  Widget _badge(ScheduleDefinition d, String? status) {
    final colors = ecoColors(context);
    final color = status == 'pending' || status == 'waiting_user'
        ? colors.warnAccent
        : (d.error != null
              ? colors.danger
              : (status != null || d.enabled
                    ? colors.accent
                    : colors.textMuted));
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 4),
      decoration: BoxDecoration(
        color: color.withValues(alpha: .10),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Text(
        _definitionStatus(d, status),
        style: TextStyle(
          color: color,
          fontSize: 12,
          fontWeight: FontWeight.w500,
        ),
      ),
    );
  }

  List<PopupMenuEntry<String>> _menu(ScheduleDefinition d) {
    final l = context.l10n;
    return [
      PopupMenuItem(value: 'edit', child: Text(l.schedulingEdit)),
      PopupMenuItem(
        value: d.enabled ? 'pause' : 'enable',
        child: Text(d.enabled ? l.schedulingPause : l.schedulingResume),
      ),
      PopupMenuItem(
        value: 'run',
        child: Text(d.isMessage ? l.schedulingSendNow : l.schedulingRunNow),
      ),
      PopupMenuItem(value: 'history', child: Text(l.schedulingHistory)),
      const PopupMenuDivider(),
      PopupMenuItem(
        value: 'delete',
        child: Text(
          l.commonDelete,
          style: TextStyle(color: ecoColors(context).danger),
        ),
      ),
    ];
  }

  Widget _scheduleCard(ScheduleDefinition d, String? status) {
    final colors = ecoColors(context);
    final firstLine = d.prompt.trim().split('\n').first;
    return Material(
      color: colors.bgElevated,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(20),
        side: BorderSide(color: colors.borderSubtle),
      ),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: _busy ? null : () => _details(d, status),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 10, 12, 16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Row(
                children: [
                  Icon(
                    d.isMessage ? EcoIcons.sessions : EcoIcons.schedule,
                    size: 17,
                    color: colors.textSecondary,
                  ),
                  const SizedBox(width: 8),
                  _badge(d, status),
                  const Spacer(),
                  PopupMenuButton<String>(
                    tooltip: context.l10n.threadMore,
                    enabled: !_busy,
                    icon: Icon(
                      EcoIcons.more,
                      size: 20,
                      color: colors.textSecondary,
                    ),
                    itemBuilder: (_) => _menu(d),
                    onSelected: (action) => _action(d, action),
                  ),
                ],
              ),
              Text(
                d.name,
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                  fontSize: 16,
                  height: 1.4,
                  fontWeight: FontWeight.w600,
                  color: colors.textHeading,
                ),
              ),
              if (d.prompt.isNotEmpty &&
                  d.name != firstLine &&
                  d.name != firstLine.characters.take(200).toString()) ...[
                const SizedBox(height: 6),
                Text(
                  d.prompt,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(height: 1.5, color: colors.textSecondary),
                ),
              ],
              if (d.attachments.isNotEmpty) ...[
                const SizedBox(height: 12),
                ScheduleImages(
                  attachments: d.attachments.take(3).toList(),
                  threadId: d.threadId!,
                ),
                if (d.attachments.length > 3)
                  Padding(
                    padding: const EdgeInsets.only(top: 6),
                    child: Text(
                      '+${d.attachments.length - 3}',
                      style: TextStyle(color: colors.textMuted),
                    ),
                  ),
              ],
              const SizedBox(height: 14),
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Icon(EcoIcons.schedule, size: 15, color: colors.textMuted),
                  const SizedBox(width: 7),
                  Expanded(
                    child: Text(
                      _rule(d),
                      style: TextStyle(
                        fontSize: 12,
                        height: 1.4,
                        color: colors.textSecondary,
                      ),
                    ),
                  ),
                ],
              ),
              if (d.nextRunAt != null && d.trigger['type'] != 'at')
                Padding(
                  padding: const EdgeInsets.only(top: 6, left: 22),
                  child: Text(
                    '${context.l10n.schedulingNext}: ${_date(d.nextRunAt!)}',
                    style: TextStyle(fontSize: 12, color: colors.textMuted),
                  ),
                ),
              if (d.error != null)
                Padding(
                  padding: const EdgeInsets.only(top: 8),
                  child: Text(
                    d.error!,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(fontSize: 12, color: colors.danger),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }

  Future<void> _details(ScheduleDefinition d, String? status) async {
    final l = context.l10n;
    final action = await showEcoModalBottomSheet<String>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      showDragHandle: true,
      builder: (sheetContext) => ConstrainedBox(
        constraints: BoxConstraints(
          maxHeight: MediaQuery.sizeOf(sheetContext).height * .85,
        ),
        child: SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(20, 0, 20, 28),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(d.name, style: Theme.of(context).textTheme.titleLarge),
              const SizedBox(height: 12),
              Align(alignment: Alignment.centerLeft, child: _badge(d, status)),
              const SizedBox(height: 20),
              if (d.prompt.isNotEmpty)
                SelectableText(
                  d.prompt,
                  style: const TextStyle(fontSize: 16, height: 1.6),
                ),
              if (d.attachments.isNotEmpty) ...[
                const SizedBox(height: 16),
                ScheduleImages(
                  attachments: d.attachments,
                  threadId: d.threadId!,
                ),
              ],
              const SizedBox(height: 20),
              Text(
                _rule(d),
                style: TextStyle(color: ecoColors(context).textSecondary),
              ),
              if (d.workspacePath != null)
                Padding(
                  padding: const EdgeInsets.only(top: 8),
                  child: Text(d.workspacePath!),
                ),
              if (d.error != null)
                Padding(
                  padding: const EdgeInsets.only(top: 8),
                  child: SelectableText(d.error!),
                ),
              const SizedBox(height: 20),
              FilledButton.icon(
                onPressed: () => Navigator.pop(sheetContext, 'edit'),
                icon: const Icon(EcoIcons.edit, size: 18),
                label: Text(l.schedulingEdit),
              ),
              if (d.threadId != null)
                TextButton(
                  onPressed: () => Navigator.pop(sheetContext, 'thread'),
                  child: Text(l.schedulingOpenThread),
                ),
              TextButton(
                onPressed: () => Navigator.pop(sheetContext, 'run'),
                child: Text(
                  d.isMessage ? l.schedulingSendNow : l.schedulingRunNow,
                ),
              ),
              TextButton(
                onPressed: () =>
                    Navigator.pop(sheetContext, d.enabled ? 'pause' : 'enable'),
                child: Text(d.enabled ? l.schedulingPause : l.schedulingResume),
              ),
              TextButton(
                onPressed: () => Navigator.pop(sheetContext, 'history'),
                child: Text(l.schedulingHistory),
              ),
              TextButton(
                onPressed: () => Navigator.pop(sheetContext, 'delete'),
                child: Text(
                  l.commonDelete,
                  style: TextStyle(color: ecoColors(context).danger),
                ),
              ),
            ],
          ),
        ),
      ),
    );
    if (!mounted || action == null) return;
    if (action == 'thread') {
      _openThread(d.threadId!);
      return;
    }
    await _action(d, action);
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
