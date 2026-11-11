import 'dart:async';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/locale/app_localizations_ext.dart';
import '../../core/locale/app_error_localizations.dart';
import '../../core/models/git_models.dart';
import '../../core/models/html_host_models.dart';
import '../../core/models/image_generation_models.dart';
import '../../core/models/conversation_v2_models.dart';
import '../../core/models/thread_models.dart';
import '../../core/storage/package_script_args_storage.dart';
import '../../core/theme/eco_icons.dart';
import '../../core/theme/eco_theme.dart';
import '../../core/widgets/eco_action_sheet.dart';
import '../../core/widgets/eco_markdown.dart';
import '../../core/widgets/image_memory_lightbox.dart';
import '../../core/widgets/eco_modal_sheet.dart';
import '../../core/widgets/web_page_viewer.dart';
import '../../core/utils/package_script_run.dart';
import '../../core/utils/package_script_search.dart';
import '../../core/utils/strip_ansi.dart';
import '../../l10n/generated/app_localizations.dart';
import '../projects/project_providers.dart';
import 'workspace_diff_review_view.dart';
import 'thread_providers.dart';

Future<void> showThreadTodoSheet({
  required BuildContext context,
  required WidgetRef ref,
  required String threadId,
}) {
  return showEcoModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    backgroundColor: ecoColors(context).bgMenu,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(16)),
    ),
    builder: (context) => DraggableScrollableSheet(
      expand: false,
      initialChildSize: 0.55,
      minChildSize: 0.35,
      maxChildSize: 0.85,
      builder: (context, scrollController) => _ThreadTodoSheet(
        threadId: threadId,
        scrollController: scrollController,
      ),
    ),
  );
}

Future<void> showThreadPlanSheet({
  required BuildContext context,
  required WidgetRef ref,
  required String threadId,
}) {
  return showEcoModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    backgroundColor: ecoColors(context).bgMenu,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(16)),
    ),
    builder: (context) => DraggableScrollableSheet(
      expand: false,
      initialChildSize: 0.72,
      minChildSize: 0.4,
      maxChildSize: 0.92,
      builder: (context, scrollController) => _ThreadPlanSheet(
        threadId: threadId,
        scrollController: scrollController,
      ),
    ),
  );
}

Future<void> showWorkspaceDiffReviewSheet({
  required BuildContext context,
  required WidgetRef ref,
  required String workspacePath,
}) {
  refreshWorkspaceChanges(ref, workspacePath);
  return showEcoModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    backgroundColor: ecoColors(context).bgMenu,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(16)),
    ),
    builder: (context) => DraggableScrollableSheet(
      expand: false,
      initialChildSize: 0.75,
      minChildSize: 0.45,
      maxChildSize: 0.92,
      builder: (context, scrollController) => _WorkspaceDiffReviewSheet(
        workspacePath: workspacePath,
        scrollController: scrollController,
      ),
    ),
  );
}

Future<void> showNpmScriptsSheet({
  required BuildContext context,
  required WidgetRef ref,
  required String workspacePath,
}) {
  return showEcoModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    backgroundColor: ecoColors(context).bgMenu,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(16)),
    ),
    builder: (context) => DraggableScrollableSheet(
      expand: false,
      initialChildSize: 0.85,
      minChildSize: 0.35,
      maxChildSize: 0.92,
      builder: (context, scrollController) => _NpmScriptsSheet(
        workspacePath: workspacePath,
        scrollController: scrollController,
      ),
    ),
  );
}

Future<void> showImageGenerationArtifactsSheet({
  required BuildContext context,
  required WidgetRef ref,
  required String threadId,
  List<ImageGenerationArtifact> artifacts = const [],
}) {
  return showEcoModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    backgroundColor: ecoColors(context).bgMenu,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(16)),
    ),
    builder: (context) => DraggableScrollableSheet(
      expand: false,
      initialChildSize: 0.62,
      minChildSize: 0.4,
      maxChildSize: 0.92,
      builder: (context, scrollController) => _ImageGenerationArtifactsSheet(
        threadId: threadId,
        initialArtifacts: artifacts,
        scrollController: scrollController,
      ),
    ),
  );
}

Future<void> showHtmlHostArtifactsSheet({
  required BuildContext context,
  required WidgetRef ref,
  required String threadId,
  List<HtmlHostArtifact> artifacts = const [],
}) {
  return showEcoModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    backgroundColor: ecoColors(context).bgMenu,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(16)),
    ),
    builder: (context) => DraggableScrollableSheet(
      expand: false,
      initialChildSize: 0.55,
      minChildSize: 0.35,
      maxChildSize: 0.92,
      builder: (context, scrollController) => _HtmlHostArtifactsSheet(
        threadId: threadId,
        initialArtifacts: artifacts,
        scrollController: scrollController,
      ),
    ),
  );
}

class _SheetHeader extends StatelessWidget {
  const _SheetHeader({required this.title, this.subtitle});

  final String title;
  final String? subtitle;

  @override
  Widget build(BuildContext context) {
    final eco = ecoColors(context);
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 16, 16, 8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(title, style: Theme.of(context).textTheme.titleMedium),
          if (subtitle != null) ...[
            const SizedBox(height: 4),
            Text(
              subtitle!,
              style: Theme.of(
                context,
              ).textTheme.bodySmall?.copyWith(color: eco.textMuted),
            ),
          ],
        ],
      ),
    );
  }
}

class _ThreadTodoSheet extends ConsumerStatefulWidget {
  const _ThreadTodoSheet({
    required this.threadId,
    required this.scrollController,
  });

  final String threadId;
  final ScrollController scrollController;

  @override
  ConsumerState<_ThreadTodoSheet> createState() => _ThreadTodoSheetState();
}

class _ThreadPlanSheet extends ConsumerStatefulWidget {
  const _ThreadPlanSheet({
    required this.threadId,
    required this.scrollController,
  });

  final String threadId;
  final ScrollController scrollController;

  @override
  ConsumerState<_ThreadPlanSheet> createState() => _ThreadPlanSheetState();
}

class _ThreadPlanSheetState extends ConsumerState<_ThreadPlanSheet> {
  late Future<ThreadPendingPlan?> _future;

  @override
  void initState() {
    super.initState();
    _future = _loadPlan();
  }

  Future<ThreadPendingPlan?> _loadPlan() async {
    final rpc = ref.read(desktopRpcProvider);
    if (rpc == null) throw StateError('Desktop is not connected');
    final pending = await rpc.getPendingPlan(widget.threadId);
    return pending ?? rpc.getApprovedPlan(widget.threadId);
  }

  @override
  Widget build(BuildContext context) {
    final eco = ecoColors(context);
    return SafeArea(
      child: Column(
        children: [
          const SizedBox(height: 12),
          const EcoSheetGrabber(),
          _SheetHeader(title: context.l10n.threadPlan),
          Expanded(
            child: FutureBuilder<ThreadPendingPlan?>(
              future: _future,
              builder: (context, snapshot) {
                if (snapshot.connectionState == ConnectionState.waiting) {
                  return const Center(child: CircularProgressIndicator());
                }
                if (snapshot.hasError) {
                  return Center(
                    child: Padding(
                      padding: const EdgeInsets.all(24),
                      child: Text(
                        snapshot.error.toString(),
                        textAlign: TextAlign.center,
                        style: TextStyle(color: eco.textMuted),
                      ),
                    ),
                  );
                }
                final plan = snapshot.data;
                if (plan == null || plan.plan.trim().isEmpty) {
                  return Center(
                    child: Text(
                      context.l10n.threadPlanEmpty,
                      style: TextStyle(color: eco.textMuted),
                    ),
                  );
                }
                return ListView(
                  controller: widget.scrollController,
                  padding: const EdgeInsets.fromLTRB(16, 8, 16, 32),
                  children: [EcoMarkdown(text: plan.plan)],
                );
              },
            ),
          ),
        ],
      ),
    );
  }
}

class _ThreadTodoSheetState extends ConsumerState<_ThreadTodoSheet> {
  late Future<List<CoderTodoItem>> _future;

  @override
  void initState() {
    super.initState();
    _future = _loadTodos();
  }

  Future<List<CoderTodoItem>> _loadTodos() async {
    final todos = ref
        .read(conversationV2SessionProvider(widget.threadId))
        .todos
        .map(_coderTodoFromV2)
        .toList(growable: false);
    todos.sort((left, right) => left.position.compareTo(right.position));
    return todos;
  }

  Future<void> _refresh() async {
    await ref
        .read(conversationV2SessionProvider(widget.threadId).notifier)
        .refresh();
    if (!mounted) return;
    setState(() => _future = _loadTodos());
    await _future;
  }

  @override
  Widget build(BuildContext context) {
    ref.listen(
      conversationV2SessionProvider(
        widget.threadId,
      ).select((state) => state.todos),
      (_, todos) {
        if (!mounted) return;
        setState(
          () => _future = Future.value(
            todos.map(_coderTodoFromV2).toList(growable: false)
              ..sort((left, right) => left.position.compareTo(right.position)),
          ),
        );
      },
    );
    final eco = ecoColors(context);
    return SafeArea(
      child: Column(
        children: [
          const SizedBox(height: 12),
          const EcoSheetGrabber(),
          _SheetHeader(title: context.l10n.threadTasks),
          Expanded(
            child: FutureBuilder<List<CoderTodoItem>>(
              future: _future,
              builder: (context, snapshot) {
                if (snapshot.connectionState == ConnectionState.waiting) {
                  return const Center(child: CircularProgressIndicator());
                }
                if (snapshot.hasError) {
                  return Center(child: Text(snapshot.error.toString()));
                }
                final todos = snapshot.data ?? const [];
                if (todos.isEmpty) {
                  return Center(
                    child: Text(
                      context.l10n.threadTaskListEmpty,
                      style: TextStyle(color: eco.textMuted),
                    ),
                  );
                }
                return RefreshIndicator(
                  onRefresh: _refresh,
                  child: ListView.separated(
                    controller: widget.scrollController,
                    padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
                    itemCount: todos.length,
                    separatorBuilder: (_, _) => const SizedBox(height: 8),
                    itemBuilder: (context, index) {
                      final todo = todos[index];
                      return _TodoRow(todo: todo);
                    },
                  ),
                );
              },
            ),
          ),
        ],
      ),
    );
  }
}

CoderTodoItem _coderTodoFromV2(ConversationV2Todo todo) => CoderTodoItem(
  id: todo.todoId,
  threadId: todo.conversationId,
  title: todo.title,
  detail: todo.detail,
  status: todo.status,
  position: todo.position,
  updatedAt: todo.updatedAt,
);

class _TodoRow extends StatelessWidget {
  const _TodoRow({required this.todo});

  final CoderTodoItem todo;

  @override
  Widget build(BuildContext context) {
    final eco = ecoColors(context);
    final icon = _todoIcon(todo.status);
    final label = _todoStatusLabel(todo.status, context.l10n);
    final displayTitle =
        todo.status == 'running' &&
            todo.detail.trim().isNotEmpty &&
            todo.detail != todo.title
        ? todo.detail
        : todo.title;

    return DecoratedBox(
      decoration: BoxDecoration(
        color: eco.cardSurface,
        borderRadius: BorderRadius.circular(12),
      ),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Icon(icon, size: 18, color: _todoIconColor(todo.status, eco)),
            const SizedBox(width: 10),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    '#${todo.position + 1} $displayTitle',
                    style: Theme.of(context).textTheme.bodyLarge?.copyWith(
                      fontWeight: FontWeight.w600,
                      fontSize: 15,
                      letterSpacing: -0.15,
                    ),
                  ),
                  const SizedBox(height: 4),
                  Text(
                    label,
                    style: Theme.of(
                      context,
                    ).textTheme.bodySmall?.copyWith(color: eco.textMuted),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

IconData _todoIcon(String status) {
  switch (status) {
    case 'running':
      return EcoIcons.active;
    case 'completed':
      return EcoIcons.checkCircle;
    case 'blocked':
      return EcoIcons.error;
    case 'cancelled':
      return EcoIcons.blocked;
    default:
      return EcoIcons.pending;
  }
}

Color _todoIconColor(String status, EcoColors colors) {
  switch (status) {
    case 'running':
      return colors.accentText;
    case 'completed':
      return colors.success;
    case 'blocked':
      return colors.danger;
    default:
      return colors.textMuted;
  }
}

String _todoStatusLabel(String status, AppLocalizations l10n) {
  switch (status) {
    case 'running':
      return l10n.threadTaskInProgress;
    case 'completed':
      return l10n.threadTaskCompleted;
    case 'blocked':
      return l10n.threadTaskBlocked;
    case 'cancelled':
      return l10n.threadTaskStopped;
    default:
      return l10n.threadTaskPending;
  }
}

class _WorkspaceDiffReviewSheet extends ConsumerStatefulWidget {
  const _WorkspaceDiffReviewSheet({
    required this.workspacePath,
    required this.scrollController,
  });

  final String workspacePath;
  final ScrollController scrollController;

  @override
  ConsumerState<_WorkspaceDiffReviewSheet> createState() =>
      _WorkspaceDiffReviewSheetState();
}

class _WorkspaceDiffReviewSheetState
    extends ConsumerState<_WorkspaceDiffReviewSheet> {
  late Future<WorkspaceDiffResult> _future;

  @override
  void initState() {
    super.initState();
    _future = _loadDiff();
  }

  Future<WorkspaceDiffResult> _loadDiff() async {
    final rpc = ref.read(desktopRpcProvider);
    if (rpc == null) {
      throw StateError(context.l10n.threadDesktopDisconnected);
    }
    final diff = await rpc.getWorkspaceDiff(widget.workspacePath);
    refreshWorkspaceChanges(ref, widget.workspacePath);
    return diff;
  }

  Future<void> _refresh() async {
    setState(() => _future = _loadDiff());
    await _future;
  }

  @override
  Widget build(BuildContext context) {
    final rpc = ref.watch(desktopRpcProvider);
    return SafeArea(
      child: Column(
        children: [
          const SizedBox(height: 12),
          const EcoSheetGrabber(),
          Expanded(
            child: FutureBuilder<WorkspaceDiffResult>(
              future: _future,
              builder: (context, snapshot) {
                if (snapshot.connectionState == ConnectionState.waiting) {
                  return const Center(
                    child: CircularProgressIndicator(strokeWidth: 2),
                  );
                }
                if (snapshot.hasError) {
                  return Center(child: Text(snapshot.error.toString()));
                }
                if (rpc == null) {
                  return Center(
                    child: Text(context.l10n.threadDesktopDisconnected),
                  );
                }
                final diff = snapshot.data!;
                return RefreshIndicator(
                  onRefresh: _refresh,
                  child: WorkspaceDiffReviewView(
                    diff: diff,
                    scrollController: widget.scrollController,
                    workspacePath: widget.workspacePath,
                    rpc: rpc,
                  ),
                );
              },
            ),
          ),
        ],
      ),
    );
  }
}

class _NpmScriptsSheet extends ConsumerStatefulWidget {
  const _NpmScriptsSheet({
    required this.workspacePath,
    required this.scrollController,
  });

  final String workspacePath;
  final ScrollController scrollController;

  @override
  ConsumerState<_NpmScriptsSheet> createState() => _NpmScriptsSheetState();
}

class _NpmScriptsSheetState extends ConsumerState<_NpmScriptsSheet> {
  late Future<PackageScriptsListResult> _future;
  Map<String, String> _scriptArgsByName = {};
  Map<String, String> _scriptPrefixesByName = {};
  String? _editingScript;
  final TextEditingController _argsInputController = TextEditingController();
  final TextEditingController _prefixInputController = TextEditingController();
  final TextEditingController _searchController = TextEditingController();
  bool _running = false;
  bool _stopping = false;
  String? _errorMessage;
  String? _activeScriptName;
  BackgroundTerminalTask? _activeTask;
  Timer? _taskPollTimer;

  @override
  void initState() {
    super.initState();
    _future = _loadScripts();
  }

  Future<void> _commitScriptOverrides(
    String scriptName,
    String nextArgs,
    String nextPrefix,
  ) async {
    final rpc = ref.read(desktopRpcProvider);
    if (rpc == null) {
      return;
    }
    final saved = await rpc.savePackageScriptArgs(
      workspacePath: widget.workspacePath,
      script: scriptName,
      args: nextArgs,
      prefix: nextPrefix,
    );
    if (!mounted) return;
    setState(() {
      _scriptArgsByName = saved.scriptArgs;
      _scriptPrefixesByName = saved.scriptPrefixes;
      _editingScript = null;
      _argsInputController.clear();
      _prefixInputController.clear();
    });
  }

  void _openArgsEditor(String scriptName) {
    _argsInputController.text = _scriptArgsByName[scriptName] ?? '';
    _prefixInputController.text = _scriptPrefixesByName[scriptName] ?? '';
    setState(() => _editingScript = scriptName);
  }

  @override
  void dispose() {
    _taskPollTimer?.cancel();
    _argsInputController.dispose();
    _prefixInputController.dispose();
    _searchController.dispose();
    super.dispose();
  }

  Future<void> _pollActiveTask(String taskId) async {
    final rpc = ref.read(desktopRpcProvider);
    if (rpc == null || !mounted) return;
    try {
      final task = await rpc.getBackgroundTerminalTask(taskId);
      if (!mounted || _activeTask?.taskId != taskId) return;
      setState(() => _activeTask = task);
      if (!task.isActive) {
        _taskPollTimer?.cancel();
      }
    } catch (error) {
      if (!mounted || _activeTask?.taskId != taskId) return;
      _taskPollTimer?.cancel();
      setState(() => _errorMessage = error.toString());
    }
  }

  void _startTaskPolling(String taskId) {
    _taskPollTimer?.cancel();
    unawaited(_pollActiveTask(taskId));
    _taskPollTimer = Timer.periodic(
      const Duration(milliseconds: 600),
      (_) => unawaited(_pollActiveTask(taskId)),
    );
  }

  Future<void> _stopActiveTask() async {
    final task = _activeTask;
    final rpc = ref.read(desktopRpcProvider);
    if (task == null || rpc == null || _stopping) return;
    setState(() {
      _stopping = true;
      _errorMessage = null;
    });
    try {
      await rpc.stopBackgroundTerminalTask(task.taskId);
      await _pollActiveTask(task.taskId);
    } catch (error) {
      if (!mounted) return;
      setState(() => _errorMessage = error.toString());
    } finally {
      if (mounted) setState(() => _stopping = false);
    }
  }

  Future<PackageScriptsListResult> _loadScripts() async {
    final rpc = ref.read(desktopRpcProvider);
    if (rpc == null) {
      throw StateError(context.l10n.threadDesktopDisconnected);
    }
    final listing = await rpc.listPackageScripts(widget.workspacePath);
    var scriptArgs = Map<String, String>.from(listing.scriptArgs);
    var scriptPrefixes = Map<String, String>.from(listing.scriptPrefixes);
    if (scriptArgs.isEmpty && scriptPrefixes.isEmpty) {
      final legacy = await readWorkspaceScriptArgs(widget.workspacePath);
      if (legacy.isNotEmpty) {
        for (final entry in legacy.entries) {
          final saved = await rpc.savePackageScriptArgs(
            workspacePath: widget.workspacePath,
            script: entry.key,
            args: entry.value,
          );
          scriptArgs = saved.scriptArgs;
          scriptPrefixes = saved.scriptPrefixes;
        }
        await clearWorkspaceScriptArgs(widget.workspacePath);
      }
    }
    _scriptArgsByName = scriptArgs;
    _scriptPrefixesByName = scriptPrefixes;
    return listing;
  }

  Future<void> _refresh() async {
    setState(() => _future = _loadScripts());
    await _future;
  }

  Future<void> _runScript(
    PackageScriptInfo script, {
    required String packageManager,
    String? args,
    String? prefix,
  }) async {
    final rpc = ref.read(desktopRpcProvider);
    if (rpc == null || _running || (_activeTask?.isActive ?? false)) {
      return;
    }
    setState(() {
      _running = true;
      _errorMessage = null;
    });
    try {
      final result = await rpc.startPackageScript(
        workspacePath: widget.workspacePath,
        script: script.name,
        args: args,
        prefix: prefix,
      );
      if (!mounted) return;
      setState(() {
        _activeScriptName = script.name;
        _activeTask = BackgroundTerminalTask(
          taskId: result.taskId,
          sessionId: result.sessionId,
          status: 'running',
          command: result.command,
        );
      });
      if (result.taskId.isNotEmpty) {
        _startTaskPolling(result.taskId);
      }
    } catch (error) {
      if (!mounted) return;
      setState(() => _errorMessage = error.toString());
    } finally {
      if (mounted) {
        setState(() => _running = false);
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final eco = ecoColors(context);
    return SafeArea(
      child: Column(
        children: [
          const SizedBox(height: 12),
          const EcoSheetGrabber(),
          Expanded(
            child: FutureBuilder<PackageScriptsListResult>(
              future: _future,
              builder: (context, snapshot) {
                if (snapshot.connectionState == ConnectionState.waiting) {
                  return const Center(child: CircularProgressIndicator());
                }
                if (snapshot.hasError) {
                  return Center(child: Text(snapshot.error.toString()));
                }
                final listing = snapshot.data!;
                final subtitle = listing.packageName != null
                    ? '${listing.packageName} · ${listing.packageManager}'
                    : listing.packageManager;
                final isRunning = _running || (_activeTask?.isActive ?? false);
                final filteredScripts = filterPackageScripts(
                  listing.scripts,
                  _searchController.text,
                );
                return Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Expanded(
                      child: RefreshIndicator(
                        onRefresh: _refresh,
                        child: ListView(
                          controller: widget.scrollController,
                          keyboardDismissBehavior:
                              ScrollViewKeyboardDismissBehavior.onDrag,
                          padding: const EdgeInsets.fromLTRB(16, 16, 16, 16),
                          children: [
                            _SheetHeader(
                              title: context.l10n.threadNpmScripts,
                              subtitle: subtitle,
                            ),
                            if (listing.scripts.isNotEmpty) ...[
                              const SizedBox(height: 16),
                              TextField(
                                controller: _searchController,
                                textInputAction: TextInputAction.search,
                                onChanged: (_) => setState(() {}),
                                decoration: InputDecoration(
                                  hintText:
                                      context.l10n.threadNpmScriptsSearchHint,
                                  prefixIcon: const Icon(
                                    EcoIcons.search,
                                    size: 19,
                                  ),
                                  suffixIcon: _searchController.text.isEmpty
                                      ? null
                                      : IconButton(
                                          tooltip:
                                              context.l10n.threadSearchClear,
                                          icon: const Icon(
                                            EcoIcons.close,
                                            size: 18,
                                          ),
                                          onPressed: () {
                                            _searchController.clear();
                                            setState(() {});
                                          },
                                        ),
                                ),
                              ),
                            ],
                            if (_errorMessage != null) ...[
                              const SizedBox(height: 12),
                              _PackageScriptErrorNotice(
                                message: _errorMessage!,
                                onDismiss: () =>
                                    setState(() => _errorMessage = null),
                              ),
                            ],
                            if (!listing.hasPackageJson ||
                                listing.scripts.isEmpty)
                              Padding(
                                padding: const EdgeInsets.only(top: 24),
                                child: Center(
                                  child: Text(
                                    context.l10n.threadNpmScriptsEmpty,
                                    style: TextStyle(color: eco.textMuted),
                                  ),
                                ),
                              )
                            else if (filteredScripts.isEmpty)
                              Padding(
                                padding: const EdgeInsets.only(top: 24),
                                child: Center(
                                  child: Text(
                                    context.l10n.threadNpmScriptsNoMatches,
                                    style: TextStyle(color: eco.textMuted),
                                  ),
                                ),
                              )
                            else ...[
                              const SizedBox(height: 12),
                              ...filteredScripts.map((script) {
                                final savedArgs =
                                    _scriptArgsByName[script.name] ?? '';
                                final savedPrefix =
                                    _scriptPrefixesByName[script.name] ?? '';
                                final hasOverrides =
                                    savedArgs.isNotEmpty ||
                                    savedPrefix.isNotEmpty;
                                final isEditingArgs =
                                    _editingScript == script.name;
                                final displayCommand = hasOverrides
                                    ? formatRunCommand(
                                        listing.packageManager,
                                        script.name,
                                        savedArgs.isEmpty ? null : savedArgs,
                                        savedPrefix.isEmpty
                                            ? null
                                            : savedPrefix,
                                      )
                                    : script.command;
                                return Padding(
                                  padding: const EdgeInsets.only(bottom: 8),
                                  child: DecoratedBox(
                                    decoration: BoxDecoration(
                                      color: eco.cardSurface,
                                      borderRadius: BorderRadius.circular(12),
                                    ),
                                    child: Padding(
                                      padding: const EdgeInsets.fromLTRB(
                                        14,
                                        12,
                                        8,
                                        12,
                                      ),
                                      child: Column(
                                        crossAxisAlignment:
                                            CrossAxisAlignment.stretch,
                                        children: [
                                          Row(
                                            children: [
                                              Expanded(
                                                child: Text(
                                                  script.name,
                                                  style: Theme.of(
                                                    context,
                                                  ).textTheme.titleSmall,
                                                ),
                                              ),
                                              IconButton(
                                                tooltip: hasOverrides
                                                    ? context.l10n
                                                          .threadExtraArgsValue(
                                                            savedPrefix.isEmpty
                                                                ? savedArgs
                                                                : '$savedPrefix && $savedArgs',
                                                          )
                                                    : context
                                                          .l10n
                                                          .threadCustomizeScript,
                                                icon: Icon(
                                                  EcoIcons.rename,
                                                  size: 18,
                                                  color:
                                                      hasOverrides ||
                                                          isEditingArgs
                                                      ? eco.accent
                                                      : eco.textMuted,
                                                ),
                                                onPressed: isRunning
                                                    ? null
                                                    : () {
                                                        if (isEditingArgs) {
                                                          _commitScriptOverrides(
                                                            script.name,
                                                            _argsInputController
                                                                .text,
                                                            _prefixInputController
                                                                .text,
                                                          );
                                                          return;
                                                        }
                                                        _openArgsEditor(
                                                          script.name,
                                                        );
                                                      },
                                              ),
                                              IconButton(
                                                tooltip: context.l10n.threadRun,
                                                icon: Icon(
                                                  Icons.play_arrow_rounded,
                                                  size: 22,
                                                  color: eco.accent,
                                                ),
                                                onPressed: isRunning
                                                    ? null
                                                    : () => _runScript(
                                                        script,
                                                        packageManager: listing
                                                            .packageManager,
                                                        args:
                                                            savedArgs.isNotEmpty
                                                            ? savedArgs
                                                            : null,
                                                        prefix:
                                                            savedPrefix
                                                                .isNotEmpty
                                                            ? savedPrefix
                                                            : null,
                                                      ),
                                              ),
                                            ],
                                          ),
                                          if (isEditingArgs)
                                            Column(
                                              crossAxisAlignment:
                                                  CrossAxisAlignment.stretch,
                                              children: [
                                                Padding(
                                                  padding:
                                                      const EdgeInsets.only(
                                                        top: 8,
                                                      ),
                                                  child: TextField(
                                                    controller:
                                                        _prefixInputController,
                                                    autofocus: true,
                                                    enabled: !isRunning,
                                                    textInputAction:
                                                        TextInputAction.next,
                                                    decoration: InputDecoration(
                                                      isDense: true,
                                                      labelText: context
                                                          .l10n
                                                          .threadPrefixCommand,
                                                      hintText: context
                                                          .l10n
                                                          .threadPrefixCommandHint,
                                                    ),
                                                  ),
                                                ),
                                                Padding(
                                                  padding:
                                                      const EdgeInsets.only(
                                                        top: 8,
                                                      ),
                                                  child: TextField(
                                                    controller:
                                                        _argsInputController,
                                                    enabled: !isRunning,
                                                    textInputAction:
                                                        TextInputAction.done,
                                                    decoration: InputDecoration(
                                                      isDense: true,
                                                      labelText: context
                                                          .l10n
                                                          .threadExtraArgs,
                                                    ),
                                                    onSubmitted: (value) =>
                                                        _commitScriptOverrides(
                                                          script.name,
                                                          value,
                                                          _prefixInputController
                                                              .text,
                                                        ),
                                                  ),
                                                ),
                                                Padding(
                                                  padding:
                                                      const EdgeInsets.only(
                                                        top: 4,
                                                      ),
                                                  child: Row(
                                                    mainAxisAlignment:
                                                        MainAxisAlignment.end,
                                                    children: [
                                                      TextButton(
                                                        onPressed: isRunning
                                                            ? null
                                                            : () => setState(() {
                                                                _editingScript =
                                                                    null;
                                                                _argsInputController
                                                                    .clear();
                                                                _prefixInputController
                                                                    .clear();
                                                              }),
                                                        child: Text(
                                                          context
                                                              .l10n
                                                              .commonCancel,
                                                        ),
                                                      ),
                                                      FilledButton(
                                                        onPressed: isRunning
                                                            ? null
                                                            : () => _commitScriptOverrides(
                                                                script.name,
                                                                _argsInputController
                                                                    .text,
                                                                _prefixInputController
                                                                    .text,
                                                              ),
                                                        child: Text(
                                                          context
                                                              .l10n
                                                              .commonSave,
                                                        ),
                                                      ),
                                                    ],
                                                  ),
                                                ),
                                              ],
                                            )
                                          else
                                            Text(
                                              displayCommand,
                                              maxLines: 2,
                                              overflow: TextOverflow.ellipsis,
                                              style: Theme.of(context)
                                                  .textTheme
                                                  .bodySmall
                                                  ?.copyWith(
                                                    color: eco.textMuted,
                                                    fontSize: 12,
                                                  ),
                                            ),
                                        ],
                                      ),
                                    ),
                                  ),
                                );
                              }),
                            ],
                          ],
                        ),
                      ),
                    ),
                    if (_activeTask != null)
                      Padding(
                        padding: const EdgeInsets.fromLTRB(16, 8, 16, 12),
                        child: _PackageScriptProgressCard(
                          scriptName: _activeScriptName ?? '',
                          task: _activeTask!,
                          stopping: _stopping,
                          onStop: _stopActiveTask,
                        ),
                      ),
                  ],
                );
              },
            ),
          ),
        ],
      ),
    );
  }
}

class _PackageScriptErrorNotice extends StatelessWidget {
  const _PackageScriptErrorNotice({
    required this.message,
    required this.onDismiss,
  });

  final String message;
  final VoidCallback onDismiss;

  @override
  Widget build(BuildContext context) {
    final eco = ecoColors(context);
    return DecoratedBox(
      decoration: BoxDecoration(
        color: eco.dangerSoft,
        border: Border.all(color: eco.danger.withValues(alpha: 0.35)),
        borderRadius: BorderRadius.circular(10),
      ),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(12, 10, 4, 10),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Padding(
              padding: const EdgeInsets.only(top: 2),
              child: Icon(EcoIcons.error, size: 18, color: eco.danger),
            ),
            const SizedBox(width: 8),
            Expanded(
              child: Text(
                message,
                style: Theme.of(context).textTheme.bodySmall?.copyWith(
                  color: eco.danger,
                  height: 1.35,
                ),
              ),
            ),
            IconButton(
              tooltip: context.l10n.commonClose,
              visualDensity: VisualDensity.compact,
              onPressed: onDismiss,
              icon: const Icon(Icons.close_rounded, size: 18),
            ),
          ],
        ),
      ),
    );
  }
}

class _PackageScriptProgressCard extends StatelessWidget {
  const _PackageScriptProgressCard({
    required this.scriptName,
    required this.task,
    required this.stopping,
    required this.onStop,
  });

  final String scriptName;
  final BackgroundTerminalTask task;
  final bool stopping;
  final VoidCallback onStop;

  String _statusLabel(AppLocalizations l10n) => switch (task.status) {
    'starting' => l10n.threadRunStarting,
    'running' => l10n.threadRunRunning,
    'exited' => l10n.threadRunCompleted,
    'failed' => l10n.threadRunFailed,
    'stopped' => l10n.threadRunStopped,
    _ => task.status,
  };

  @override
  Widget build(BuildContext context) {
    final eco = ecoColors(context);
    final output = stripAnsi(
      task.output,
    ).replaceAll('\r\n', '\n').replaceAll('\r', '\n').trimRight();
    final statusColor = switch (task.status) {
      'exited' => Colors.green,
      'failed' => eco.danger,
      'stopped' => eco.textMuted,
      _ => eco.accent,
    };

    return DecoratedBox(
      decoration: BoxDecoration(
        color: eco.cardSurface,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: eco.borderSubtle),
      ),
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              children: [
                Expanded(
                  child: Text(
                    scriptName,
                    style: Theme.of(context).textTheme.titleSmall?.copyWith(
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                ),
                Text(
                  task.exitCode == null
                      ? _statusLabel(context.l10n)
                      : '${_statusLabel(context.l10n)} · ${task.exitCode}',
                  style: Theme.of(context).textTheme.labelMedium?.copyWith(
                    color: statusColor,
                    fontWeight: FontWeight.w600,
                  ),
                ),
                if (task.isActive) ...[
                  const SizedBox(width: 8),
                  TextButton(
                    onPressed: stopping ? null : onStop,
                    child: Text(
                      stopping
                          ? context.l10n.threadStopping
                          : context.l10n.threadStop,
                    ),
                  ),
                ],
              ],
            ),
            if (task.isActive) ...[
              const SizedBox(height: 8),
              const LinearProgressIndicator(),
            ],
            const SizedBox(height: 8),
            Text(
              task.command.join(' '),
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              style: Theme.of(context).textTheme.bodySmall?.copyWith(
                color: eco.textMuted,
                fontFamily: 'monospace',
              ),
            ),
            const SizedBox(height: 10),
            Container(
              constraints: const BoxConstraints(minHeight: 80, maxHeight: 220),
              padding: const EdgeInsets.all(10),
              decoration: BoxDecoration(
                color: eco.bgMenu,
                borderRadius: BorderRadius.circular(8),
              ),
              child: SingleChildScrollView(
                reverse: true,
                child: SelectableText(
                  output.isEmpty
                      ? context.l10n.threadWaitingCommandOutput
                      : output,
                  style: Theme.of(context).textTheme.bodySmall?.copyWith(
                    color: output.isEmpty ? eco.textMuted : eco.textPrimary,
                    fontFamily: 'monospace',
                    height: 1.35,
                  ),
                ),
              ),
            ),
            if (task.outputTruncated) ...[
              const SizedBox(height: 6),
              Text(
                context.l10n.threadOutputTruncated,
                style: Theme.of(
                  context,
                ).textTheme.labelSmall?.copyWith(color: eco.textMuted),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

Future<void> showThreadActionSheet({
  required BuildContext context,
  required WidgetRef ref,
  required ThreadSummary thread,
}) {
  final isPinned = ref
      .read(pinnedThreadIdsProvider.notifier)
      .isPinned(thread.id);

  return showEcoActionSheet<void>(
    context: context,
    builder: (sheetContext) {
      return SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const EcoSheetGrabber(),
            EcoSheetHeader(title: thread.title),
            EcoActionSheetActions(
              items: [
                EcoActionSheetItem(
                  icon: EcoIcons.pin,
                  label: isPinned
                      ? context.l10n.projectUnpin
                      : context.l10n.projectPin,
                  onTap: () async {
                    Navigator.pop(sheetContext);
                    if (isPinned) {
                      await ref
                          .read(pinnedThreadIdsProvider.notifier)
                          .unpin(thread.id);
                    } else {
                      await ref
                          .read(pinnedThreadIdsProvider.notifier)
                          .pin(thread.id);
                    }
                  },
                ),
                EcoActionSheetItem(
                  icon: EcoIcons.delete,
                  label: context.l10n.threadDelete,
                  destructive: true,
                  onTap: () async {
                    Navigator.pop(sheetContext);
                    final confirmed = await showDialog<bool>(
                      context: context,
                      builder: (dialogContext) {
                        return AlertDialog(
                          title: Text(context.l10n.threadDelete),
                          content: Text(
                            context.l10n.threadDeleteConfirm(thread.title),
                          ),
                          actions: [
                            TextButton(
                              onPressed: () =>
                                  Navigator.pop(dialogContext, false),
                              child: Text(context.l10n.commonCancel),
                            ),
                            TextButton(
                              onPressed: () =>
                                  Navigator.pop(dialogContext, true),
                              child: Text(
                                context.l10n.commonDelete,
                                style: TextStyle(
                                  color: ecoColors(context).danger,
                                  fontWeight: FontWeight.w600,
                                ),
                              ),
                            ),
                          ],
                        );
                      },
                    );
                    if (confirmed != true || !context.mounted) return;

                    final messenger = ScaffoldMessenger.of(context);
                    try {
                      final rpc = ref.read(desktopRpcProvider);
                      if (rpc == null) {
                        throw StateError(context.l10n.projectNoPcSelected);
                      }
                      await rpc.deleteThread(thread.id);
                      await ref
                          .read(pinnedThreadIdsProvider.notifier)
                          .remove(thread.id);
                      ref
                          .read(threadListProvider.notifier)
                          .removeThread(thread.id);
                      if (context.mounted) {
                        messenger.showSnackBar(
                          SnackBar(content: Text(context.l10n.threadDeleted)),
                        );
                      }
                    } catch (error) {
                      if (context.mounted) {
                        messenger.showSnackBar(
                          SnackBar(content: Text(error.toString())),
                        );
                      }
                    }
                  },
                ),
              ],
            ),
          ],
        ),
      );
    },
  );
}

class _ImageGenerationArtifactsSheet extends ConsumerStatefulWidget {
  const _ImageGenerationArtifactsSheet({
    required this.threadId,
    required this.initialArtifacts,
    required this.scrollController,
  });

  final String threadId;
  final List<ImageGenerationArtifact> initialArtifacts;
  final ScrollController scrollController;

  @override
  ConsumerState<_ImageGenerationArtifactsSheet> createState() =>
      _ImageGenerationArtifactsSheetState();
}

class _ImageGenerationArtifactsSheetState
    extends ConsumerState<_ImageGenerationArtifactsSheet> {
  late Future<List<ImageGenerationArtifact>> _future;

  @override
  void initState() {
    super.initState();
    _future = widget.initialArtifacts.isNotEmpty
        ? Future.value(widget.initialArtifacts)
        : _load();
  }

  Future<List<ImageGenerationArtifact>> _load() async {
    final rpc = ref.read(desktopRpcProvider);
    if (rpc == null) throw StateError('Desktop is not connected');
    return rpc.listImageGenerationArtifacts(widget.threadId);
  }

  Future<void> _openArtifact(ImageGenerationArtifact artifact) async {
    if (artifact.images.isEmpty) return;
    final rpc = ref.read(desktopRpcProvider);
    if (rpc == null) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(context.l10n.conversationHistoryError)),
      );
      return;
    }
    await showImageMemoryLightbox(
      context,
      images: List.generate(artifact.images.length, (_) => Uint8List(0)),
      title: artifact.displayTitle,
      loadImage: (index) async {
        final read = await rpc.readImageGenerationArtifact(
          artifactId: artifact.id,
          imageIndex: index,
        );
        return Uint8List.fromList(read.bytes);
      },
    );
  }

  String _statusLabel(String status, AppLocalizations l10n) {
    return switch (status) {
      'running' => l10n.taskImageGenerationStatusRunning,
      'failed' => l10n.taskImageGenerationStatusFailed,
      _ => l10n.taskImageGenerationStatusCompleted,
    };
  }

  @override
  Widget build(BuildContext context) {
    final eco = ecoColors(context);
    return SafeArea(
      child: Column(
        children: [
          const SizedBox(height: 12),
          const EcoSheetGrabber(),
          _SheetHeader(title: context.l10n.taskImageGenerationHistory),
          Expanded(
            child: FutureBuilder<List<ImageGenerationArtifact>>(
              future: _future,
              builder: (context, snapshot) {
                if (snapshot.connectionState == ConnectionState.waiting) {
                  return const Center(child: CircularProgressIndicator());
                }
                if (snapshot.hasError) {
                  return Center(
                    child: Padding(
                      padding: const EdgeInsets.all(24),
                      child: Column(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          SelectableText(
                            localizedAppError(snapshot.error!, context.l10n),
                          ),
                          TextButton(
                            onPressed: () => setState(() {
                              _future = _load();
                            }),
                            child: Text(context.l10n.commonRetry),
                          ),
                        ],
                      ),
                    ),
                  );
                }
                final artifacts = snapshot.data ?? const [];
                if (artifacts.isEmpty) {
                  return Center(
                    child: Text(
                      context.l10n.taskImageGenerationEmpty,
                      style: TextStyle(color: eco.textMuted),
                    ),
                  );
                }
                return ListView.separated(
                  controller: widget.scrollController,
                  padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
                  itemCount: artifacts.length,
                  separatorBuilder: (_, _) => const SizedBox(height: 8),
                  itemBuilder: (context, index) {
                    final artifact = artifacts[index];
                    final meta = [
                      _statusLabel(artifact.status, context.l10n),
                      if (artifact.model.trim().isNotEmpty) artifact.model,
                    ].join(' · ');
                    return ListTile(
                      shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(12),
                      ),
                      tileColor: eco.bgElevated,
                      leading: Icon(EcoIcons.image, color: eco.textMuted),
                      title: Text(
                        artifact.displayTitle,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                      ),
                      subtitle: Text(meta),
                      enabled:
                          artifact.status == 'completed' &&
                          artifact.images.isNotEmpty,
                      onTap: () => _openArtifact(artifact),
                    );
                  },
                );
              },
            ),
          ),
        ],
      ),
    );
  }
}

class _HtmlHostArtifactsSheet extends ConsumerStatefulWidget {
  const _HtmlHostArtifactsSheet({
    required this.threadId,
    required this.initialArtifacts,
    required this.scrollController,
  });

  final String threadId;
  final List<HtmlHostArtifact> initialArtifacts;
  final ScrollController scrollController;

  @override
  ConsumerState<_HtmlHostArtifactsSheet> createState() =>
      _HtmlHostArtifactsSheetState();
}

class _HtmlHostArtifactsSheetState
    extends ConsumerState<_HtmlHostArtifactsSheet> {
  late Future<List<HtmlHostArtifact>> _future;

  @override
  void initState() {
    super.initState();
    _future = widget.initialArtifacts.isNotEmpty
        ? Future.value(widget.initialArtifacts)
        : _load();
  }

  Future<List<HtmlHostArtifact>> _load() async {
    final rpc = ref.read(desktopRpcProvider);
    if (rpc == null) throw StateError('Desktop is not connected');
    return rpc.listHtmlHostArtifacts(widget.threadId);
  }

  Future<void> _openArtifact(HtmlHostArtifact artifact) async {
    final url = artifact.publicUrl.trim();
    if (url.isEmpty || artifact.status != 'completed') return;
    await Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (context) =>
            WebPageViewer(title: artifact.displayTitle, url: url),
      ),
    );
  }

  String _statusLabel(String status, AppLocalizations l10n) {
    return status == 'failed'
        ? l10n.taskHtmlHostStatusFailed
        : l10n.taskHtmlHostStatusCompleted;
  }

  @override
  Widget build(BuildContext context) {
    final eco = ecoColors(context);
    return SafeArea(
      child: Column(
        children: [
          const SizedBox(height: 12),
          const EcoSheetGrabber(),
          _SheetHeader(title: context.l10n.taskHtmlHostHistory),
          Expanded(
            child: FutureBuilder<List<HtmlHostArtifact>>(
              future: _future,
              builder: (context, snapshot) {
                if (snapshot.connectionState == ConnectionState.waiting) {
                  return const Center(child: CircularProgressIndicator());
                }
                if (snapshot.hasError) {
                  return Center(
                    child: Padding(
                      padding: const EdgeInsets.all(24),
                      child: Column(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          SelectableText(
                            localizedAppError(snapshot.error!, context.l10n),
                          ),
                          TextButton(
                            onPressed: () => setState(() {
                              _future = _load();
                            }),
                            child: Text(context.l10n.commonRetry),
                          ),
                        ],
                      ),
                    ),
                  );
                }
                final artifacts = snapshot.data ?? const [];
                if (artifacts.isEmpty) {
                  return Center(
                    child: Text(
                      context.l10n.taskHtmlHostEmpty,
                      style: TextStyle(color: eco.textMuted),
                    ),
                  );
                }
                return ListView.separated(
                  controller: widget.scrollController,
                  padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
                  itemCount: artifacts.length,
                  separatorBuilder: (_, _) => const SizedBox(height: 8),
                  itemBuilder: (context, index) {
                    final artifact = artifacts[index];
                    return ListTile(
                      shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(12),
                      ),
                      tileColor: eco.bgElevated,
                      leading: Icon(EcoIcons.browser, color: eco.textMuted),
                      title: Text(
                        artifact.displayTitle,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                      ),
                      subtitle: Text(
                        _statusLabel(artifact.status, context.l10n),
                      ),
                      enabled:
                          artifact.status == 'completed' &&
                          artifact.publicUrl.trim().isNotEmpty,
                      onTap: () => _openArtifact(artifact),
                    );
                  },
                );
              },
            ),
          ),
        ],
      ),
    );
  }
}
