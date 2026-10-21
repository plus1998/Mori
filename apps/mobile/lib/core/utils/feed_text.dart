final _inlineWebCitation = RegExp(
  '\u{E200}cite(?:\u{E202}[^\u{E201}]+)+\u{E201}',
);

/// Removes provider-specific rich-text citations that Flutter Markdown cannot render.
String sanitizeFeedText(String text) {
  return text.replaceAll(_inlineWebCitation, '');
}

class StreamingMarkdownPartition {
  const StreamingMarkdownPartition({required this.stable, required this.tail});

  final String stable;
  final String tail;
}

final _markdownFenceOpen = RegExp(r'^( {0,3})(`{3,}|~{3,})(.*)$');
final _markdownTableRow = RegExp(r'^\s*\|.*\|\s*$');
final _markdownTableSeparator = RegExp(
  r'^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$',
);

/// Separates completed top-level blocks from the mutable streaming tail.
///
/// Plain prose is safe to render as Markdown while it streams. Incomplete
/// fences / *confirmed* GFM tables (header+separator) / edit holds stay
/// structural. Pipe rows without a separator are not GFM tables — live-render
/// them so a malformed table cannot freeze the rest of the stream as plain.
StreamingMarkdownPartition partitionStreamingMarkdown(
  String text, {
  required bool streaming,
}) {
  if (text.isEmpty) {
    return StreamingMarkdownPartition(stable: text, tail: '');
  }
  if (!streaming) {
    return StreamingMarkdownPartition(stable: text, tail: '');
  }

  final holdFrom = structuredEditHoldStart(text);
  if (holdFrom != null) {
    final prefix = text.substring(0, holdFrom);
    final held = text.substring(holdFrom);
    if (prefix.isEmpty) {
      return StreamingMarkdownPartition(stable: '', tail: held);
    }
    final parts = _partitionClosedTopLevel(prefix);
    return StreamingMarkdownPartition(
      stable: parts.stable,
      tail: '${parts.tail}$held',
    );
  }

  return _partitionClosedTopLevel(text);
}

bool isStructuralStreamingTail(String tail) {
  if (tail.isEmpty) return false;
  if (structuredEditHoldStart(tail) != null) return true;

  final lines = _splitMarkdownLines(tail);
  for (final line in lines) {
    if (line.content.trim().isEmpty) continue;

    final fence = _matchMarkdownFenceOpen(line.content);
    if (fence != null) {
      return _findClosingMarkdownFence(lines, lines.indexOf(line) + 1, fence) ==
          null;
    }
    if (_isMarkdownTableRow(line.content) ||
        _isMarkdownTableSeparator(line.content)) {
      final table = _scanMarkdownTable(lines, lines.indexOf(line));
      // Only confirmed GFM tables (separator seen) are structural while open.
      return !table.complete && table.sawSeparator;
    }

    // Paragraphs, lists, headings and quotes can be live-rendered safely.
    return false;
  }
  return false;
}

StreamingMarkdownPartition _partitionClosedTopLevel(String text) {
  final mutableStart = _findMutableMarkdownStart(text);
  if (mutableStart <= 0) {
    return StreamingMarkdownPartition(stable: '', tail: text);
  }
  if (mutableStart >= text.length) {
    return StreamingMarkdownPartition(stable: text, tail: '');
  }
  return StreamingMarkdownPartition(
    stable: text.substring(0, mutableStart),
    tail: text.substring(mutableStart),
  );
}

int _findMutableMarkdownStart(String text) {
  final lines = _splitMarkdownLines(text);
  var index = 0;
  var completedThrough = 0;

  while (index < lines.length) {
    final line = lines[index];
    if (line.content.trim().isEmpty) {
      index += 1;
      continue;
    }

    final fence = _matchMarkdownFenceOpen(line.content);
    if (fence != null) {
      final closeAt = _findClosingMarkdownFence(lines, index + 1, fence);
      if (closeAt == null) return line.start;
      completedThrough = _endOfMarkdownLine(lines[closeAt]);
      index = closeAt + 1;
      continue;
    }

    if (_isMarkdownTableRow(line.content) ||
        _isMarkdownTableSeparator(line.content)) {
      final table = _scanMarkdownTable(lines, index);
      if (!table.complete) return line.start;
      completedThrough = table.endExclusive;
      index = table.nextIndex;
      continue;
    }

    final block = _scanMarkdownLooseBlock(lines, index);
    if (!block.complete) return line.start;
    completedThrough = block.endExclusive;
    index = block.nextIndex;
  }

  return completedThrough;
}

({bool complete, int endExclusive, int nextIndex}) _scanMarkdownLooseBlock(
  List<_MarkdownLine> lines,
  int startIndex,
) {
  var index = startIndex;
  while (index < lines.length) {
    final line = lines[index];
    if (line.content.trim().isEmpty) {
      var end = _endOfMarkdownLine(line);
      var next = index + 1;
      while (next < lines.length && lines[next].content.trim().isEmpty) {
        end = _endOfMarkdownLine(lines[next]);
        next += 1;
      }
      return (complete: true, endExclusive: end, nextIndex: next);
    }
    if (_matchMarkdownFenceOpen(line.content) != null ||
        _isMarkdownTableRow(line.content) ||
        _isMarkdownTableSeparator(line.content)) {
      return (complete: true, endExclusive: line.start, nextIndex: index);
    }
    index += 1;
  }
  return (complete: false, endExclusive: 0, nextIndex: startIndex);
}

({
  bool complete,
  bool sawSeparator,
  int endExclusive,
  int nextIndex,
}) _scanMarkdownTable(
  List<_MarkdownLine> lines,
  int startIndex,
) {
  var index = startIndex;
  var sawSeparator = false;
  while (index < lines.length) {
    final line = lines[index];
    if (line.content.trim().isEmpty) {
      if (!sawSeparator) {
        // Pipe rows + blank without a separator are not a GFM table — commit
        // them so following prose is not frozen as structural plain text.
        return (
          complete: true,
          sawSeparator: false,
          endExclusive: _endOfMarkdownLine(line),
          nextIndex: index + 1,
        );
      }
      return (
        complete: true,
        sawSeparator: true,
        endExclusive: _endOfMarkdownLine(line),
        nextIndex: index + 1,
      );
    }
    if (_isMarkdownTableSeparator(line.content)) {
      sawSeparator = true;
      index += 1;
      continue;
    }
    if (_isMarkdownTableRow(line.content)) {
      index += 1;
      continue;
    }
    // Left the table on a non-table line.
    if (!sawSeparator) {
      // Malformed / decorative pipes — commit the run, continue from this line.
      return (
        complete: true,
        sawSeparator: false,
        endExclusive: line.start,
        nextIndex: index,
      );
    }
    return (
      complete: true,
      sawSeparator: true,
      endExclusive: line.start,
      nextIndex: index,
    );
  }
  // Still inside the table at EOF — whole region is mutable.
  return (
    complete: false,
    sawSeparator: sawSeparator,
    endExclusive: 0,
    nextIndex: startIndex,
  );
}

/// The start of a still-open SEARCH/REPLACE or conflict region.
int? structuredEditHoldStart(String text) {
  final searchReplaceOpen = text.lastIndexOf('<<<<<<< SEARCH');
  if (searchReplaceOpen >= 0 &&
      !text.substring(searchReplaceOpen).contains('>>>>>>> REPLACE')) {
    return searchReplaceOpen;
  }

  final conflictOpen = text.lastIndexOf('<<<<<<<');
  if (conflictOpen >= 0 && !text.substring(conflictOpen).contains('>>>>>>>')) {
    return conflictOpen;
  }
  return null;
}

String? _matchMarkdownFenceOpen(String line) {
  final match = _markdownFenceOpen.firstMatch(line);
  return match?.group(2);
}

int? _findClosingMarkdownFence(
  List<_MarkdownLine> lines,
  int fromIndex,
  String openMarker,
) {
  final character = openMarker[0];
  final minimumLength = openMarker.length;
  final close = RegExp(r'^( {0,3})(`{3,}|~{3,})\s*$');
  for (var index = fromIndex; index < lines.length; index += 1) {
    final match = close.firstMatch(lines[index].content);
    if (match == null) continue;
    final marker = match.group(2)!;
    if (marker[0] == character && marker.length >= minimumLength) {
      return index;
    }
  }
  return null;
}

bool _isMarkdownTableRow(String line) => _markdownTableRow.hasMatch(line);

bool _isMarkdownTableSeparator(String line) =>
    _markdownTableSeparator.hasMatch(line);

class _MarkdownLine {
  const _MarkdownLine({
    required this.start,
    required this.content,
    required this.contentEnd,
    required this.hasNewline,
  });

  final int start;
  final String content;
  final int contentEnd;
  final bool hasNewline;
}

List<_MarkdownLine> _splitMarkdownLines(String text) {
  final lines = <_MarkdownLine>[];
  var start = 0;
  for (var index = 0; index < text.length; index += 1) {
    if (text.codeUnitAt(index) != 10) continue;
    lines.add(
      _MarkdownLine(
        start: start,
        content: text.substring(start, index),
        contentEnd: index,
        hasNewline: true,
      ),
    );
    start = index + 1;
  }
  if (start < text.length || text.isEmpty || text.endsWith('\n')) {
    lines.add(
      _MarkdownLine(
        start: start,
        content: text.substring(start),
        contentEnd: text.length,
        hasNewline: false,
      ),
    );
  }
  return lines;
}

int _endOfMarkdownLine(_MarkdownLine line) {
  return line.hasNewline ? line.contentEnd + 1 : line.contentEnd;
}
