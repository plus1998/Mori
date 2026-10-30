import 'package:eco_mobile/core/utils/composer_references.dart';
import 'package:eco_mobile/core/widgets/composer_prompt_editing_controller.dart';
import 'package:eco_mobile/core/theme/eco_theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

String token(String id, {String label = '待办'}) => composerReferenceToken(
  kind: 'todo',
  id: id,
  label: label,
  detail: '/project',
);

void main() {
  test(
    'restoring equal labels with different IDs survives caret and composing changes',
    () {
      final c = ComposerPromptEditingController(text: token('one'));
      addTearDown(c.dispose);
      c.text = token('two');
      expect(c.prompt, token('two'));
      c.selection = const TextSelection.collapsed(offset: 0);
      c.clearComposing();
      expect(c.prompt, token('two'));
    },
  );
  testWidgets(
    'native undo and redo restore reference identity with visible text',
    (tester) async {
      final raw = token('one');
      final c = ComposerPromptEditingController(text: raw);
      final undo = UndoHistoryController();
      addTearDown(c.dispose);
      addTearDown(undo.dispose);
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: TextField(controller: c, undoController: undo, maxLines: 6),
          ),
        ),
      );
      await tester.tap(find.byType(TextField));
      await tester.pump(const Duration(seconds: 1));
      c.selection = TextSelection(baseOffset: 0, extentOffset: c.text.length);
      tester.testTextInput.updateEditingValue(
        const TextEditingValue(
          text: '',
          selection: TextSelection.collapsed(offset: 0),
        ),
      );
      await tester.pump(const Duration(seconds: 1));
      expect(c.prompt, '');
      undo.undo();
      await tester.pump();
      expect(c.prompt, raw);
      expect(c.text, '@待办');
      undo.redo();
      await tester.pump();
      expect(c.prompt, '');
      expect(tester.takeException(), isNull);
    },
  );
  test(
    'visible labels serialize to durable tokens through normal edits and restore',
    () {
      final raw = '处理 ${token('one')} 和 ${token('two', label: '另一个')}';
      final c = ComposerPromptEditingController(text: raw);
      addTearDown(c.dispose);
      expect(c.text, '处理 @待办 和 @另一个');
      expect(c.prompt, raw);
      c.value = c.value.copyWith(
        text: '${c.text}，谢谢',
        selection: TextSelection.collapsed(offset: c.text.length + 3),
      );
      expect(c.prompt, '$raw，谢谢');
      c.clearComposing();
      expect(c.prompt, '$raw，谢谢');
      c.text = raw;
      expect(c.prompt, raw);
      expect(c.text, '处理 @待办 和 @另一个');
      c.clear();
      expect(c.prompt, '');
      c.text = '普通 @文本';
      expect(c.prompt, '普通 @文本');
    },
  );

  test('deleting any part of a reference removes it atomically', () {
    final c = ComposerPromptEditingController(text: '前 ${token('one')} 后');
    addTearDown(c.dispose);
    c.selection = const TextSelection.collapsed(offset: 5);
    c.value = const TextEditingValue(
      text: '前 @待 后',
      selection: TextSelection.collapsed(offset: 4),
    );
    expect(c.text, '前  后');
    expect(c.prompt, '前  后');
    expect(c.selection.baseOffset, 2);
  });

  test('selection distinguishes equal labels with different IDs', () {
    final c = ComposerPromptEditingController(
      text: '${token('one')}${token('two')}',
    );
    addTearDown(c.dispose);
    c.selection = const TextSelection(baseOffset: 0, extentOffset: 3);
    c.value = const TextEditingValue(
      text: '@待办',
      selection: TextSelection.collapsed(offset: 0),
    );
    expect(c.prompt, token('two'));
    c.value = const TextEditingValue(
      text: '',
      selection: TextSelection.collapsed(offset: 0),
    );
    expect(c.prompt, '');
  });

  test('insertions at both reference boundaries preserve its identity', () {
    final c = ComposerPromptEditingController(text: token('one'));
    addTearDown(c.dispose);
    c.selection = const TextSelection.collapsed(offset: 0);
    c.value = const TextEditingValue(
      text: '先@待办',
      selection: TextSelection.collapsed(offset: 1),
    );
    expect(c.prompt, '先${token('one')}');
    c.selection = const TextSelection.collapsed(offset: 4);
    c.value = const TextEditingValue(
      text: '先@待办后',
      selection: TextSelection.collapsed(offset: 5),
    );
    expect(c.prompt, '先${token('one')}后');
  });

  test('pasted wire tokens render as labels and composing preserves IDs', () {
    final c = ComposerPromptEditingController();
    addTearDown(c.dispose);
    final raw = '${token('one')}中文';
    c.value = TextEditingValue(
      text: raw,
      selection: TextSelection.collapsed(offset: raw.length),
    );
    expect(c.text, '@待办中文');
    expect(c.prompt, raw);
    c.value = c.value.copyWith(composing: const TextRange(start: 3, end: 5));
    expect(c.prompt, raw);
    c.value = const TextEditingValue(
      text: '@待办汉字',
      selection: TextSelection.collapsed(offset: 5),
      composing: TextRange(start: 3, end: 5),
    );
    expect(c.prompt, '${token('one')}汉字');
    expect(c.value.composing, const TextRange(start: 3, end: 5));
  });

  testWidgets(
    'editable spans match visible text and native caret at narrow width',
    (tester) async {
      final raw = '${token('one', label: '一个很长的待办名称' * 5)} 继续';
      final c = ComposerPromptEditingController(text: raw);
      addTearDown(c.dispose);
      await tester.pumpWidget(
        MaterialApp(
          theme: buildEcoDarkTheme(),
          home: Scaffold(
            body: SizedBox(
              width: 280,
              child: TextField(controller: c, maxLines: 6),
            ),
          ),
        ),
      );
      await tester.tap(find.byType(TextField));
      await tester.pump();
      final context = tester.element(find.byType(TextField));
      final span = c.buildTextSpan(context: context, withComposing: true);
      expect(span.toPlainText(), c.value.text);
      expect(span.toPlainText(), isNot(contains('%7B')));
      tester.testTextInput.updateEditingValue(
        c.value.copyWith(
          text: '${c.text}吧',
          selection: TextSelection.collapsed(offset: c.text.length + 1),
        ),
      );
      await tester.pump();
      expect(c.prompt, '$raw吧');
      expect(tester.takeException(), isNull);
    },
  );
}
