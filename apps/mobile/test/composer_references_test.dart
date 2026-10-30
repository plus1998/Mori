import 'dart:convert';

import 'package:eco_mobile/core/utils/composer_references.dart';
import 'package:flutter_test/flutter_test.dart';

String token(String kind, Object data) =>
    '@$kind{${Uri.encodeComponent(jsonEncode(data))}}';

void main() {
  test(
    'all desktop reference kinds preserve identity and surrounding text',
    () {
      for (final kind in [
        'ssh',
        'todo',
        'web',
        'web_selection',
        'conversation',
        'integration',
        'subagent',
        'mcp',
      ]) {
        final raw = token(kind, {
          'id': '$kind-id',
          'label': '移动端 + 引用',
          'detail': '项目 A / 完整详情',
        });
        final segments = parseComposerPrompt('处理 $raw\n谢谢 @普通文本');
        expect(segments.map((s) => s.text).join(), '处理 $raw\n谢谢 @普通文本');
        expect(segments[1].id, '$kind-id');
        expect(segments[1].detail, '项目 A / 完整详情');
        expect(
          composerPromptDisplayText('处理 $raw\n谢谢 @普通文本'),
          '处理 @移动端 + 引用\n谢谢 @普通文本',
        );
      }
    },
  );

  test(
    'invalid tokens remain verbatim, including beside a valid reference',
    () {
      final valid = token('todo', {'id': '1', 'label': '待办', 'detail': ''});
      for (final invalid in [
        '@todo{%}',
        '@todo{%GG}',
        '@todo{%FF}',
        '@todo{null}',
        '@todo{[]}',
        token('todo', {'id': '', 'label': 'x', 'detail': ''}),
        token('todo', {'id': 'a' * 257, 'label': 'x', 'detail': ''}),
        token('todo', {'id': '1', 'label': 'x'}),
        token('todo', {'id': '1', 'label': 1, 'detail': ''}),
        token('unknown', {'id': '1', 'label': 'x', 'detail': ''}),
      ]) {
        expect(composerPromptDisplayText('$invalid $valid'), '$invalid @待办');
      }
      expect(composerPromptDisplayText(''), '');
    },
  );

  test(
    'same labels keep distinct identities and follow desktop length limits',
    () {
      final raw = [
        for (final id in ['one', 'two'])
          token('todo', {'id': id, 'label': '名' * 501, 'detail': '详' * 2001}),
      ].join();
      final segments = parseComposerPrompt(raw);
      expect(segments.map((s) => s.id), ['one', 'two']);
      expect(segments.first.label!.length, 500);
      expect(segments.first.detail!.length, 2000);
      expect(segments.map((s) => s.text).join(), raw);
    },
  );
}
