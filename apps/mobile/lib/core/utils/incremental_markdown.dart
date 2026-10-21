import 'dart:convert';

import 'package:markdown/markdown.dart' as md;

import 'feed_text.dart';
import 'markdown_repair.dart';

/// An immutable, completed top-level block. Lists and quotes stay in one block,
/// including their blank lines, so numbering and loose-list layout survive.
class CompletedMarkdownBlock {
  CompletedMarkdownBlock(this.text, {required this.visible}) {
    final segments = splitEcoMarkdownSegments(text)
        .where(
          (segment) =>
              segment is! EcoMarkdownProseSegment ||
              segment.text.trim().isNotEmpty,
        )
        .toList();
    startsInTable =
        segments.isNotEmpty && segments.first is EcoMarkdownTableSegment;
    endsInTable =
        segments.isNotEmpty && segments.last is EcoMarkdownTableSegment;
  }

  final String text;
  final bool visible;
  late final bool startsInTable;
  late final bool endsInTable;
  late final bool hasReferenceCandidate = text.contains('[');
}

/// Keeps completed source blocks while parsing only the growing suffix.
///
/// Keep the last block, and any preceding block whose successor's first line
/// is unfinished: `paragraph\n#` can still become `paragraph\n#text`.
class IncrementalMarkdown {
  String _text = '';
  int _completedEnd = 0;
  final _completed = <CompletedMarkdownBlock>[];
  final _completedReferences = <String, md.LinkReference>{};
  Map<String, md.LinkReference> _references = const {};
  bool _tailVisible = false;

  List<CompletedMarkdownBlock> get completed => _completed;
  String get tail => _text.substring(_completedEnd);
  Map<String, md.LinkReference> get references => _references;
  bool get tailVisible => _tailVisible;

  void update(String text) {
    if (_text == text) return;
    final appended = text.startsWith(_text);
    final addedText = appended ? text.substring(_text.length) : text;
    if (!appended) {
      _completed.clear();
      _completedReferences.clear();
      _completedEnd = 0;
    }
    _text = text;
    final suffix = tail;
    // Without a newly completed line, no new block boundary can be committed.
    // A reference definition can change mid-line, so those tails still scan.
    if (appended &&
        !addedText.contains('\n') &&
        !addedText.contains('\r') &&
        !suffix.contains('[')) {
      _tailVisible = RegExp(r'[^ \t\r\n]').hasMatch(suffix);
      return;
    }
    final scan = _scanBlocks(suffix, _completedReferences);
    final editHold = structuredEditHoldStart(suffix);
    var end = 0;
    for (var index = 0; index + 1 < scan.starts.length; index++) {
      final start = scan.starts[index];
      final next = scan.starts[index + 1];
      if (!scan.completeFirstLines.contains(next)) break;
      final source = suffix.substring(start, next);
      // Footnotes have document-wide ordering and backlinks. Keep their whole
      // dependency scope live, starting at the first possible reference/def.
      // Ordinary reference links instead use the shared reference map below.
      if (source.contains('[^') || (editHold != null && editHold < next)) {
        break;
      }
      final document = md.Document(extensionSet: md.ExtensionSet.gitHubFlavored)
        ..linkReferences.addAll(_completedReferences);
      final nodes = document.parseLines(const LineSplitter().convert(source));
      _completedReferences.addAll(document.linkReferences);
      _completed.add(CompletedMarkdownBlock(source, visible: nodes.isNotEmpty));
      end = next;
    }
    _completedEnd += end;
    _tailVisible = end == 0
        ? scan.visible
        : md.BlockParser(
            const LineSplitter().convert(tail).map(md.Line.new).toList(),
            md.Document(extensionSet: md.ExtensionSet.gitHubFlavored)
              ..linkReferences.addAll(_completedReferences),
          ).parseLines().isNotEmpty;
    if (!_sameReferences(_references, scan.references)) {
      _references = Map.unmodifiable(scan.references);
    }
  }
}

bool _sameReferences(
  Map<String, md.LinkReference> left,
  Map<String, md.LinkReference> right,
) =>
    left.length == right.length &&
    left.entries.every((entry) {
      final other = right[entry.key];
      return other != null &&
          other.destination == entry.value.destination &&
          other.title == entry.value.title;
    });

({
  List<int> starts,
  Set<int> completeFirstLines,
  Map<String, md.LinkReference> references,
  bool visible,
})
_scanBlocks(String source, Map<String, md.LinkReference> references) {
  final lines = <md.Line>[];
  final offsets = Map<md.Line, int>.identity();
  final indices = <int, int>{};
  final complete = <int>{};
  var offset = 0;
  for (final content in const LineSplitter().convert(source)) {
    final line = md.Line(content);
    indices[offset] = lines.length;
    lines.add(line);
    offsets[line] = offset;
    offset += content.length;
    if (offset < source.length) {
      complete.add(offsets[line]!);
      if (source.codeUnitAt(offset) == 13 &&
          offset + 1 < source.length &&
          source.codeUnitAt(offset + 1) == 10) {
        offset++;
      }
      offset++;
    }
  }
  final starts = <int>[];
  late md.BlockParser root;
  final probe = _BlockBoundaryProbe((parser) {
    if (!identical(parser, root)) return;
    // Internal lookahead also calls canParse. The unconsumed buffer's first
    // line changes only after a root block is committed, including Setext.
    final first = parser.linesToConsume.first;
    if (first.isBlankLine) return;
    final start = offsets[first]!;
    if (starts.isEmpty || starts.last != start) starts.add(start);
  });
  final document = md.Document(
    blockSyntaxes: [probe],
    extensionSet: md.ExtensionSet.gitHubFlavored,
  )..linkReferences.addAll(references);
  root = md.BlockParser(lines, document);
  final nodes = root.parseLines();
  final boundaries = <int>[];
  final completeBoundaries = <int>{};
  for (final start in starts) {
    var index = indices[start]!;
    // Preserve preceding newlines, including adjacent HTML's non-first-block
    // context. The previous block does not need its terminal line ending.
    while (index > 0 && lines[index - 1].isBlankLine) {
      index--;
    }
    var boundary = boundaries.isEmpty ? 0 : offsets[lines[index]]!;
    if (boundary > 0) {
      boundary--;
      if (source.codeUnitAt(boundary) == 10 &&
          boundary > 0 &&
          source.codeUnitAt(boundary - 1) == 13) {
        boundary--;
      }
    }
    boundaries.add(boundary);
    if (complete.contains(start)) completeBoundaries.add(boundary);
  }
  return (
    starts: boundaries,
    completeFirstLines: completeBoundaries,
    references: document.linkReferences,
    visible: nodes.isNotEmpty,
  );
}

/// Observes the parser without consuming a line or participating in syntax.
class _BlockBoundaryProbe extends md.BlockSyntax {
  _BlockBoundaryProbe(this.observe);

  final void Function(md.BlockParser) observe;

  @override
  RegExp get pattern => RegExp(r'(?!)');

  @override
  bool canParse(md.BlockParser parser) {
    if (!parser.isDone) observe(parser);
    return false;
  }

  @override
  md.Node? parse(md.BlockParser parser) => null;
}
