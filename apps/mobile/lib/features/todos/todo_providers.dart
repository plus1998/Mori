import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/locale/app_error_localizations.dart';
import '../../core/models/eco_types.dart';
import '../../core/models/project_todo_models.dart';
import '../../core/providers/app_providers.dart';
import '../../core/providers/desktop_bind_ready.dart';
import '../../l10n/generated/app_localizations.dart';
import '../threads/thread_providers.dart';

final projectTodosProvider = FutureProvider.autoDispose<List<ProjectTodo>>((
  ref,
) async {
  ref.watch(selectedDesktopIdProvider);
  final rpc = ref.watch(desktopRpcProvider);
  ref.listen(ecoEventsProvider, (_, next) {
    if (next.valueOrNull?.kind == 'project-todo.changed') ref.invalidateSelf();
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
  return rpc.listProjectTodos();
});

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
