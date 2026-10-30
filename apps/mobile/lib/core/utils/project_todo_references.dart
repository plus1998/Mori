import '../models/project_todo_models.dart';
import 'composer_references.dart';

/// Matches desktop appendProjectTodoReference, including identity deduplication.
String appendProjectTodoReference(String prompt, ProjectTodo todo) {
  if (parseComposerPrompt(
    prompt,
  ).any((s) => s.kind == 'todo' && s.id == todo.id)) {
    return prompt;
  }
  final firstLine = todo.text.trim().split(RegExp(r'\r?\n')).first;
  final label = firstLine.isEmpty
      ? '待办'
      : firstLine.substring(0, firstLine.length.clamp(0, 80));
  final token = composerReferenceToken(
    kind: 'todo',
    id: todo.id,
    label: label,
    detail: todo.projectPath,
  );
  final separator = prompt.isNotEmpty && !RegExp(r'\s$').hasMatch(prompt)
      ? '\n'
      : '';
  return '$prompt$separator$token ';
}
