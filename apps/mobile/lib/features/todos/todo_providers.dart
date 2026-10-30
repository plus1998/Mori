import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/locale/app_error_localizations.dart';
import '../../core/models/eco_types.dart';
import '../../core/models/project_todo_models.dart';
import '../../core/network/desktop_rpc.dart';
import '../../core/providers/app_providers.dart';
import '../../core/providers/desktop_bind_ready.dart';
import '../../l10n/generated/app_localizations.dart';
import '../projects/project_providers.dart';
import '../threads/thread_providers.dart';

final projectTodosProvider = AsyncNotifierProvider.autoDispose
    .family<ProjectTodosController, ProjectTodoPage, ProjectTodosQuery>(
      ProjectTodosController.new,
    );

class ProjectTodosController
    extends AutoDisposeFamilyAsyncNotifier<ProjectTodoPage, ProjectTodosQuery> {
  int _generation = 0;
  late DesktopRpc _rpc;
  List<String> _matchingProjects = const [];

  @override
  Future<ProjectTodoPage> build(ProjectTodosQuery arg) async {
    final generation = ++_generation;
    ref.onDispose(() => _generation++);
    ref.watch(selectedDesktopIdProvider);
    final rpc = ref.watch(desktopRpcProvider);
    final projects = ref.watch(projectListProvider).valueOrNull ?? const [];
    final needle = arg.search.toLowerCase();
    final matchingProjects = needle.isEmpty
        ? <String>[]
        : [
            for (final project in projects)
              if (project.name.toLowerCase().contains(needle)) project.path,
          ];
    ref.listen(ecoEventsProvider, (_, next) {
      if (next.valueOrNull?.kind == 'project-todo.changed') {
        ref.invalidateSelf();
      }
    });
    ref.listen(connectionStatusProvider, (previous, next) {
      if (previous?.valueOrNull?.state != next.valueOrNull?.state) {
        ref.invalidateSelf();
      }
    });
    if (rpc == null || !await ensureDesktopBindReady(ref)) {
      throw EcoCenterException(
        'Desktop is not connected',
        kind: EcoCenterErrorKind.websocketDisconnected,
      );
    }
    // A filter/desktop change may dispose this request while the bind is pending.
    if (generation != _generation) {
      throw StateError('Todo query was superseded');
    }
    _rpc = rpc;
    _matchingProjects = matchingProjects;
    return rpc.queryProjectTodos(
      query: arg,
      matchingProjectPaths: matchingProjects,
    );
  }

  Future<void> loadMore() async {
    final current = state.valueOrNull;
    if (state.isLoading ||
        current == null ||
        current.loadingMore ||
        current.nextCursor == null) {
      return;
    }
    final generation = _generation;
    state = AsyncData(current.withLoadMore(loading: true));
    try {
      final page = await _rpc.queryProjectTodos(
        query: arg,
        cursor: current.nextCursor,
        matchingProjectPaths: _matchingProjects,
      );
      if (generation != _generation) return;
      final items = {for (final item in current.items) item.id: item};
      for (final item in page.items) {
        items[item.id] = item;
      }
      state = AsyncData(
        ProjectTodoPage(
          items: items.values.toList(),
          nextCursor: page.nextCursor,
          pendingCount: page.pendingCount,
          completedCount: page.completedCount,
          projectPaths: page.projectPaths,
        ),
      );
    } catch (error) {
      if (generation == _generation) {
        state = AsyncData(current.withLoadMore(error: error));
      }
    }
  }
}

String todoErrorMessage(Object error, AppLocalizations l) {
  final message = error.toString();
  if (message.contains('Todo changed') || message.contains('待办已被修改')) {
    return l.todosConflict;
  }
  if (message.contains('Todo no longer exists') ||
      message.contains('Todo image no longer exists')) {
    return l.todosMissing;
  }
  if (error is EcoCenterException &&
      (error.code == EcoRpcConstants.methodNotFound ||
          message.contains('not remote-enabled') ||
          message.contains('Unknown desktop command'))) {
    return l.todosUpgrade;
  }
  return localizedAppError(error, l);
}
