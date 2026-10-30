import 'package:eco_mobile/core/models/project_todo_models.dart';
import 'package:eco_mobile/core/utils/composer_references.dart';
import 'package:eco_mobile/core/utils/project_todo_references.dart';
import 'package:flutter_test/flutter_test.dart';

ProjectTodo todo({String text = '待办标题\n完整正文', String id = 'todo-1'}) =>
    ProjectTodo(
      id: id,
      revision: 3,
      projectPath: '/project',
      text: text,
      images: [],
      completed: false,
      createdAt: '',
      updatedAt: '',
    );

void main() {
  test(
    'append keeps draft and only carries todo identity, title and project',
    () {
      final prompt = appendProjectTodoReference('原有草稿', todo());
      final segments = parseComposerPrompt(prompt);
      expect(segments.first.text, '原有草稿\n');
      final ref = segments[1];
      expect(ref.id, 'todo-1');
      expect(ref.label, '待办标题');
      expect(ref.detail, '/project');
      expect(prompt, isNot(contains('完整正文')));
      expect(appendProjectTodoReference(prompt, todo()), prompt);
      expect(
        parseComposerPrompt(
          appendProjectTodoReference(prompt, todo(id: 'todo-2')),
        ).where((s) => s.isReference),
        hasLength(2),
      );
    },
  );
  test('matches desktop first-line, length and image-only labels', () {
    for (final text in ['', '  \r\n ', '   标题\r\n正文  ', '长' * 100]) {
      final ref = parseComposerPrompt(
        appendProjectTodoReference('', todo(text: text)),
      ).first;
      expect(
        ref.label,
        text.trim().isEmpty
            ? '待办'
            : text
                  .trim()
                  .split(RegExp(r'\r?\n'))
                  .first
                  .substring(
                    0,
                    text
                        .trim()
                        .split(RegExp(r'\r?\n'))
                        .first
                        .length
                        .clamp(0, 80),
                  ),
      );
    }
  });
}
