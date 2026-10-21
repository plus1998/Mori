import 'dart:convert';

import 'package:eco_mobile/core/utils/incremental_markdown.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:markdown/markdown.dart' as md;

List<Object> ast(List<md.Node> nodes) => [
  for (final node in nodes)
    if (node is md.Element)
      [node.tag, node.attributes, ast(node.children ?? [])]
    else
      node.textContent,
];

List<md.Node> parse(String text, Map<String, md.LinkReference> references) =>
    (md.Document(extensionSet: md.ExtensionSet.gitHubFlavored)
          ..linkReferences.addAll(references))
        .parseLines(const LineSplitter().convert(text));

void main() {
  final fixtures = <String, String>{
    'paragraphs and partial interrupting headings':
        '第一段 **中文**。\n\n第二段\n#变回段落\n\n# 标题\n\n结尾🙂',
    'Setext headings and thematic breaks':
        '开头\n\n多行\n标题\n===\n\n正文\n\n---\n\n最后',
    'loose nested lists and ordered numbering':
        '开头\n\n3. 第一项\n\n   另一段\n\n   - 嵌套\n\n4. 第二项\n\n结尾\n\n尾段',
    'lazy blockquotes and indented code':
        '开头\n\n> 引用\n懒续行\n>\n> 第二段\n\n结束\n\n    code\n\n    more\n\n尾段',
    'fences with embedded block markers':
        '开头\n\n````dart\n# 标题\n\n```\n| a | b |\n````\n\n结尾\n\n末段',
    'GFM tables and partial separator rows':
        '开头\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n结尾\n\n末段',
    'late references and duplicate definitions':
        '[**链接**][id] 和 ![alt][img]\n\n普通段\n\n[id]: /first "标题"\n\n'
        '[img]: /image.png\n\n[id]: /second\n\n尾段\n\n最后',
    'multiline reference titles':
        '[link][id]\n\n[id]: /path\n  "a\n  multiline title"\n\n尾段\n\n最后',
    'footnotes preserve the document scope':
        '普通前缀\n\n脚注[^b] 和 [^a]\n\n另一段[^b]\n\n[^a]: 第一条\n\n'
        '[^b]: 第二条\n\n    续段\n\n最后',
    'HTML blocks':
        '开头\n\n<div>\n# raw\n</div>\n\n正文\n\n<!-- comment\n\nend -->\n\n末段',
    'adjacent HTML blocks retain their parser context':
        '# 标题\n<div>\nraw\n</div>\n\n正文\n<!-- comment -->\n# 最后\n',
    'CRLF and lone CR': '首段\r\n\r\n次段\r\n\r\n# 标题\r\n\r\n结尾\r再行',
  };

  for (final fixture in fixtures.entries) {
    test('every streamed prefix matches full parsing: ${fixture.key}', () {
      final incremental = IncrementalMarkdown();
      for (var length = 1; length <= fixture.value.length; length++) {
        final text = fixture.value.substring(0, length);
        incremental.update(text);
        expect(
          incremental.completed.map((block) => block.text).join() +
              incremental.tail,
          text,
          reason: 'lossless prefix $length',
        );
        final actual = [
          for (final block in incremental.completed)
            ...parse(block.text, incremental.references),
          ...parse(incremental.tail, incremental.references),
        ];
        expect(
          ast(actual),
          ast(parse(text, const {})),
          reason: 'prefix $length: ${jsonEncode(text)}',
        );
      }
    });
  }

  test('completed blocks and unchanged references keep their identity', () {
    final incremental = IncrementalMarkdown()..update('第一段\n\n第二段\n\n尾段');
    final blocks = List.of(incremental.completed);
    final references = incremental.references;
    for (var count = 1; count <= 20; count++) {
      incremental.update('第一段\n\n第二段\n\n尾段${'字' * count}');
      expect(incremental.completed, orderedEquals(blocks));
      expect(incremental.references, same(references));
      expect(incremental.tail.trimLeft(), '第二段\n\n尾段${'字' * count}');
    }
  });

  test('replacement and shrinking reset source and reference definitions', () {
    final incremental = IncrementalMarkdown()..update('[r]: /old\n\n正文\n\n尾段');
    expect(incremental.references['r']!.destination, '/old');
    incremental.update('[r]: /new\n\n新文\n\n新尾');
    expect(incremental.references['r']!.destination, '/new');
    incremental.update('短文');
    expect(incremental.completed, isEmpty);
    expect(incremental.references, isEmpty);
    expect(incremental.tail, '短文');
    incremental.update('');
    expect(incremental.tailVisible, isFalse);
  });

  test('open edit holds are kept together until their closing marker', () {
    final incremental = IncrementalMarkdown()
      ..update('前文\n\n<<<<<<< SEARCH\nold\n\n=======\nnew\n\n');
    expect(incremental.tail, contains('<<<<<<< SEARCH'));
    expect(
      incremental.completed.map((block) => block.text).join().trim(),
      '前文',
    );
    incremental.update(
      '前文\n\n<<<<<<< SEARCH\nold\n\n=======\nnew\n\n>>>>>>> REPLACE\n\n后文\n\n末段',
    );
    expect(incremental.tail.trimLeft(), '后文\n\n末段');
  });
}
