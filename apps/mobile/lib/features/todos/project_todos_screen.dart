import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/locale/app_localizations_ext.dart';
import '../../core/models/project_todo_models.dart';
import '../../core/models/thread_models.dart';
import '../../core/theme/eco_theme.dart';
import '../../core/widgets/adaptive_nav_bar.dart';
import '../../core/widgets/app_error_state.dart';
import '../../core/widgets/eco_modal_sheet.dart';
import '../projects/project_providers.dart';
import '../threads/thread_providers.dart';
import '../threads/thread_session_route.dart';
import 'todo_editor.dart';
import 'todo_providers.dart';
import 'todo_widgets.dart';

class ProjectTodosScreen extends ConsumerStatefulWidget {
  const ProjectTodosScreen({super.key});
  @override
  ConsumerState<ProjectTodosScreen> createState() => _ProjectTodosScreenState();
}

class _ProjectTodosScreenState extends ConsumerState<ProjectTodosScreen>
    with WidgetsBindingObserver {
  final _search = TextEditingController();
  String _project = '';
  bool _showCompleted = false;
  bool _busy = false;
  bool _working = false;
  final _previewData = <String, String>{};

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _search.dispose();
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      ref.invalidate(projectTodosProvider);
    }
  }

  void _message(String text) =>
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(text)));

  Future<void> _refresh() async {
    ref.invalidate(projectTodosProvider);
    await ref.read(projectTodosProvider.future);
  }

  Future<void> _run(Future<void> Function() task) async {
    if (_busy) return;
    setState(() {
      _busy = true;
      _working = true;
    });
    try {
      await task();
    } catch (error) {
      if (mounted) _message(todoErrorMessage(error, context.l10n));
      ref.invalidate(projectTodosProvider);
    } finally {
      if (mounted) {
        setState(() {
          _busy = false;
          _working = false;
        });
      }
    }
  }

  Future<void> _edit(Map<String, String> projects, [ProjectTodo? todo]) =>
      _run(() async {
        final rpc = ref.read(desktopRpcProvider);
        final latest = todo == null ? null : await rpc!.getProjectTodo(todo.id);
        if (!mounted ||
            rpc?.desktopDeviceId !=
                ref.read(desktopRpcProvider)?.desktopDeviceId) {
          return;
        }
        setState(() => _working = false);
        final saved = await showTodoEditor(
          context,
          projects: projects,
          todo: latest,
          projectPath: _project.isNotEmpty
              ? _project
              : ref.read(selectedProjectPathProvider).valueOrNull,
        );
        if (saved == true && mounted) _message(context.l10n.todosSaved);
      });

  Future<void> _toggle(ProjectTodo todo) => _run(() async {
    await ref
        .read(desktopRpcProvider)!
        .saveProjectTodo(todo.toSaveJson(completed: !todo.completed));
    ref.invalidate(projectTodosProvider);
  });

  Future<void> _delete(ProjectTodo todo) => _run(() async {
    final rpc = ref.read(desktopRpcProvider)!;
    final desktopId = rpc.desktopDeviceId;
    final revision = await rpc.trashProjectTodo(
      id: todo.id,
      revision: todo.revision,
      deleted: true,
    );
    ref.invalidate(projectTodosProvider);
    if (!mounted) return;
    final messenger = ScaffoldMessenger.of(context);
    messenger.hideCurrentSnackBar();
    messenger.showSnackBar(
      SnackBar(
        content: Text(context.l10n.todosDeleted),
        action: SnackBarAction(
          label: context.l10n.todosUndo,
          onPressed: () {
            if (!mounted ||
                ref.read(desktopRpcProvider)?.desktopDeviceId != desktopId) {
              return;
            }
            _run(() async {
              await rpc.trashProjectTodo(
                id: todo.id,
                revision: revision,
                deleted: false,
              );
              ref.invalidate(projectTodosProvider);
            });
          },
        ),
      ),
    );
  });

  Future<void> _preview(ProjectTodo todo, ProjectTodoImage image) => _run(
    () async {
      final rpc = ref.read(desktopRpcProvider)!;
      final key =
          '${rpc.desktopDeviceId}:${todo.id}:${todo.revision}:${image.id}';
      final data =
          _previewData[key] ?? await rpc.downloadProjectTodoImage(todo, image);
      if (_previewData.length >= 5) _previewData.clear();
      _previewData[key] = data;
      if (mounted) {
        setState(() => _working = false);
        await showTodoImage(context, data);
      }
    },
  );

  Future<void> _compose(ProjectTodo todo) => _run(() async {
    final rpc = ref.read(desktopRpcProvider)!;
    final threads = await ref.read(threadListProvider.future);
    if (!mounted) return;
    setState(() => _working = false);
    final target = await showEcoModalBottomSheet<String>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      showDragHandle: true,
      builder: (_) => _ConversationPicker(
        threads: threads
            .where((t) => t.workspacePath == todo.projectPath)
            .toList(),
      ),
    );
    if (target == null || !mounted) return;
    setState(() => _working = true);
    if (rpc.desktopDeviceId != ref.read(desktopRpcProvider)?.desktopDeviceId) {
      return;
    }
    // Re-read after choosing the destination: the desktop may have edited it.
    final latest = await rpc.getProjectTodo(todo.id);
    if (latest.projectPath != todo.projectPath) {
      throw StateError('Todo changed. Reopen it before saving.');
    }
    final attachments = <PromptImageAttachment>[];
    for (final image in latest.images) {
      attachments.add(
        image.toAttachment(await rpc.downloadProjectTodoImage(latest, image)),
      );
    }
    await openProjectPath(ref, latest.projectPath);
    if (!mounted) return;
    context.push(
      '/threads/$target',
      extra: ThreadSessionRouteExtra(
        prompt: latest.text,
        attachments: attachments,
      ),
    );
  });

  @override
  Widget build(BuildContext context) {
    final l = context.l10n;
    final eco = ecoColors(context);
    final snapshot = ref.watch(projectTodosProvider);
    final todos = snapshot.valueOrNull ?? const <ProjectTodo>[];
    final projects = <String, String>{
      for (final p in ref.watch(projectListProvider).valueOrNull ?? [])
        p.path: p.name,
    };
    for (final todo in todos) {
      projects.putIfAbsent(
        todo.projectPath,
        () => todoProjectName({}, todo.projectPath),
      );
    }
    final selected = ref.watch(selectedProjectPathProvider).valueOrNull;
    if (selected != null && selected.isNotEmpty) {
      projects.putIfAbsent(selected, () => todoProjectName({}, selected));
    }
    ref.listen(projectTodosProvider, (_, _) => _previewData.clear());
    final needle = _search.text.trim().toLowerCase();
    final filtered = todos
        .where(
          (todo) =>
              (_project.isEmpty || todo.projectPath == _project) &&
              (needle.isEmpty ||
                  '${todo.text} ${todoProjectName(projects, todo.projectPath)}'
                      .toLowerCase()
                      .contains(needle)),
        )
        .toList();
    final pending = filtered.where((todo) => !todo.completed).toList();
    final completed = filtered.where((todo) => todo.completed).toList();
    final navInset = adaptiveNavOverlayInset(context);

    return Scaffold(
      backgroundColor: eco.bgMain,
      appBar: AppBar(
        title: Text(l.todosTitle),
        actions: [
          IconButton(
            tooltip: l.commonRetry,
            onPressed: _busy ? null : () => _run(_refresh),
            icon: const Icon(Icons.refresh_rounded),
          ),
          const SizedBox(width: 8),
        ],
      ),
      floatingActionButton: Padding(
        padding: EdgeInsets.only(bottom: navInset),
        child: FloatingActionButton.extended(
          onPressed: _busy ? null : () => _edit(projects),
          icon: const Icon(Icons.add_rounded),
          label: Text(l.todosAdd),
        ),
      ),
      body: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 720),
          child: LayoutBuilder(
            builder: (context, constraints) => Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                ConstrainedBox(
                  constraints: BoxConstraints(
                    maxHeight: constraints.maxHeight * .6,
                  ),
                  child: SingleChildScrollView(
                    child: Padding(
                      padding: const EdgeInsets.fromLTRB(24, 8, 24, 18),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [
                          Text(
                            l.todosSubtitle,
                            style: Theme.of(context).textTheme.bodyLarge
                                ?.copyWith(color: eco.textMuted),
                          ),
                          const SizedBox(height: 20),
                          TextField(
                            controller: _search,
                            onChanged: (_) => setState(() {}),
                            decoration: InputDecoration(
                              hintText: l.todosSearch,
                              prefixIcon: const Icon(Icons.search_rounded),
                              suffixIcon: needle.isEmpty
                                  ? null
                                  : IconButton(
                                      tooltip: l.commonClose,
                                      onPressed: () =>
                                          setState(() => _search.clear()),
                                      icon: const Icon(Icons.close_rounded),
                                    ),
                              filled: true,
                              fillColor: eco.bgInput,
                              border: OutlineInputBorder(
                                borderRadius: BorderRadius.circular(16),
                                borderSide: BorderSide.none,
                              ),
                            ),
                          ),
                          const SizedBox(height: 14),
                          Align(
                            alignment: Alignment.centerLeft,
                            child: ActionChip(
                              avatar: const Icon(
                                Icons.folder_outlined,
                                size: 18,
                              ),
                              label: ConstrainedBox(
                                constraints: BoxConstraints(
                                  maxWidth:
                                      MediaQuery.sizeOf(context).width - 130,
                                ),
                                child: Text(
                                  _project.isEmpty
                                      ? l.todosAllProjects
                                      : todoProjectName(projects, _project),
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                ),
                              ),
                              onPressed: _busy
                                  ? null
                                  : () async {
                                      final path = await pickTodoProject(
                                        context,
                                        projects,
                                        includeAll: true,
                                      );
                                      if (path != null && mounted) {
                                        setState(() => _project = path);
                                      }
                                    },
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                ),
                if (_working) const LinearProgressIndicator(minHeight: 2),
                Expanded(
                  child: snapshot.when(
                    skipError: false,
                    data: (_) => RefreshIndicator(
                      onRefresh: _refresh,
                      child: ListView(
                        physics: const AlwaysScrollableScrollPhysics(),
                        keyboardDismissBehavior:
                            ScrollViewKeyboardDismissBehavior.onDrag,
                        padding: EdgeInsets.fromLTRB(20, 0, 20, navInset + 100),
                        children: [
                          if (filtered.isEmpty)
                            _EmptyTodos(
                              title: needle.isNotEmpty || _project.isNotEmpty
                                  ? l.todosNoResults
                                  : l.todosEmpty,
                              message: needle.isNotEmpty || _project.isNotEmpty
                                  ? l.todosNoResultsHint
                                  : l.todosEmptyHint,
                            )
                          else ...[
                            _SectionLabel(
                              label: l.todosPending,
                              count: pending.length,
                            ),
                            if (pending.isEmpty)
                              Padding(
                                padding: const EdgeInsets.symmetric(
                                  vertical: 28,
                                ),
                                child: Text(
                                  l.todosNoPending,
                                  textAlign: TextAlign.center,
                                  style: TextStyle(color: eco.textMuted),
                                ),
                              ),
                            for (final todo in pending) _card(todo, projects),
                            if (completed.isNotEmpty) ...[
                              const SizedBox(height: 16),
                              ListTile(
                                contentPadding: const EdgeInsets.symmetric(
                                  horizontal: 4,
                                ),
                                title: Text(
                                  '${l.todosCompleted} · ${completed.length}',
                                ),
                                trailing: Icon(
                                  _showCompleted
                                      ? Icons.expand_less
                                      : Icons.expand_more,
                                ),
                                onTap: () => setState(
                                  () => _showCompleted = !_showCompleted,
                                ),
                              ),
                              if (_showCompleted)
                                for (final todo in completed)
                                  _card(todo, projects),
                            ],
                          ],
                        ],
                      ),
                    ),
                    error: (error, _) => SingleChildScrollView(
                      padding: const EdgeInsets.all(24),
                      child: AppErrorState(
                        title: l.todosLoadFailed,
                        message: todoErrorMessage(error, l),
                        onRetry: _refresh,
                        retryLabel: l.commonRetry,
                      ),
                    ),
                    loading: () =>
                        const Center(child: CircularProgressIndicator()),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _card(ProjectTodo todo, Map<String, String> projects) {
    final l = context.l10n;
    final eco = ecoColors(context);
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: Material(
        color: eco.cardSurface,
        borderRadius: BorderRadius.circular(20),
        child: InkWell(
          onTap: _busy ? null : () => _edit(projects, todo),
          borderRadius: BorderRadius.circular(20),
          child: Padding(
            padding: const EdgeInsets.fromLTRB(6, 12, 12, 12),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                IconButton(
                  tooltip: todo.completed
                      ? l.todosMarkPending
                      : l.todosMarkComplete,
                  onPressed: _busy ? null : () => _toggle(todo),
                  icon: Icon(
                    todo.completed
                        ? Icons.check_circle_rounded
                        : Icons.radio_button_unchecked_rounded,
                    color: todo.completed ? eco.success : eco.textMuted,
                  ),
                ),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      const SizedBox(height: 10),
                      if (todo.text.isNotEmpty)
                        Text(
                          todo.text,
                          maxLines: 5,
                          overflow: TextOverflow.ellipsis,
                          style: Theme.of(context).textTheme.bodyLarge
                              ?.copyWith(
                                height: 1.5,
                                color: todo.completed
                                    ? eco.textMuted
                                    : eco.textPrimary,
                                decoration: todo.completed
                                    ? TextDecoration.lineThrough
                                    : null,
                              ),
                        ),
                      if (todo.images.isNotEmpty) ...[
                        const SizedBox(height: 12),
                        SingleChildScrollView(
                          scrollDirection: Axis.horizontal,
                          child: Row(
                            children: [
                              for (final image in todo.images)
                                Padding(
                                  padding: const EdgeInsets.only(right: 8),
                                  child: TodoThumbnail(
                                    source: image.thumbnail,
                                    onTap: _busy
                                        ? null
                                        : () => _preview(todo, image),
                                  ),
                                ),
                            ],
                          ),
                        ),
                      ],
                      const SizedBox(height: 10),
                      Text(
                        todoProjectName(projects, todo.projectPath),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: Theme.of(
                          context,
                        ).textTheme.bodySmall?.copyWith(color: eco.textMuted),
                      ),
                      const SizedBox(height: 4),
                      Align(
                        alignment: Alignment.centerLeft,
                        child: TextButton.icon(
                          onPressed: _busy ? null : () => _compose(todo),
                          icon: const Icon(
                            Icons.chat_bubble_outline_rounded,
                            size: 17,
                          ),
                          label: Text(l.todosCompose),
                        ),
                      ),
                    ],
                  ),
                ),
                PopupMenuButton<String>(
                  tooltip: l.todosMore,
                  enabled: !_busy,
                  icon: const Icon(Icons.more_horiz_rounded),
                  onSelected: (action) {
                    if (action == 'edit') {
                      _edit(projects, todo);
                    } else {
                      _delete(todo);
                    }
                  },
                  itemBuilder: (_) => [
                    PopupMenuItem(value: 'edit', child: Text(l.todosEdit)),
                    PopupMenuItem(
                      value: 'delete',
                      child: Text(
                        l.commonDelete,
                        style: TextStyle(color: eco.danger),
                      ),
                    ),
                  ],
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _SectionLabel extends StatelessWidget {
  const _SectionLabel({required this.label, required this.count});
  final String label;
  final int count;
  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.fromLTRB(4, 4, 4, 14),
    child: Text(
      '$label · $count',
      style: Theme.of(
        context,
      ).textTheme.titleSmall?.copyWith(color: ecoColors(context).textMuted),
    ),
  );
}

class _EmptyTodos extends StatelessWidget {
  const _EmptyTodos({required this.title, required this.message});
  final String title;
  final String message;
  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 48),
    child: Column(
      children: [
        Container(
          padding: const EdgeInsets.all(22),
          decoration: BoxDecoration(
            color: ecoColors(context).accent.withValues(alpha: .08),
            borderRadius: BorderRadius.circular(28),
          ),
          child: Icon(
            Icons.checklist_rounded,
            size: 40,
            color: ecoColors(context).accent,
          ),
        ),
        const SizedBox(height: 24),
        Text(
          title,
          textAlign: TextAlign.center,
          style: Theme.of(context).textTheme.titleLarge,
        ),
        const SizedBox(height: 12),
        Text(
          message,
          textAlign: TextAlign.center,
          style: TextStyle(color: ecoColors(context).textMuted, height: 1.6),
        ),
      ],
    ),
  );
}

class _ConversationPicker extends StatefulWidget {
  const _ConversationPicker({required this.threads});
  final List<ThreadSummary> threads;
  @override
  State<_ConversationPicker> createState() => _ConversationPickerState();
}

class _ConversationPickerState extends State<_ConversationPicker> {
  String _query = '';
  @override
  Widget build(BuildContext context) {
    final l = context.l10n;
    final threads =
        widget.threads
            .where(
              (t) => '${t.title} ${t.prompt}'.toLowerCase().contains(
                _query.toLowerCase(),
              ),
            )
            .toList()
          ..sort((a, b) => b.updatedAt.compareTo(a.updatedAt));
    return SafeArea(
      child: Padding(
        padding: EdgeInsets.fromLTRB(
          20,
          0,
          20,
          MediaQuery.viewInsetsOf(context).bottom + 16,
        ),
        child: SizedBox(
          height: MediaQuery.sizeOf(context).height * .65,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(
                l.todosCompose,
                style: Theme.of(context).textTheme.titleLarge,
              ),
              const SizedBox(height: 8),
              Text(
                l.todosComposeHint,
                style: TextStyle(color: ecoColors(context).textMuted),
              ),
              const SizedBox(height: 16),
              FilledButton.icon(
                onPressed: () => Navigator.pop(context, 'new'),
                icon: const Icon(Icons.add),
                label: Text(l.todosNewConversation),
              ),
              const SizedBox(height: 12),
              TextField(
                decoration: InputDecoration(
                  hintText: l.todosSearchThreads,
                  prefixIcon: const Icon(Icons.search),
                ),
                onChanged: (value) => setState(() => _query = value),
              ),
              const SizedBox(height: 8),
              Expanded(
                child: ListView(
                  children: [
                    for (final thread in threads)
                      ListTile(
                        leading: const Icon(Icons.chat_bubble_outline_rounded),
                        title: Text(
                          thread.title,
                          maxLines: 2,
                          overflow: TextOverflow.ellipsis,
                        ),
                        onTap: () => Navigator.pop(context, thread.id),
                      ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
