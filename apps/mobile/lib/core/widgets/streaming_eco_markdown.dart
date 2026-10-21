import 'package:flutter/material.dart';

import '../utils/feed_text.dart';
import '../utils/incremental_markdown.dart';
import '../utils/markdown_repair.dart';
import 'eco_markdown.dart';

/// Reuses completed Markdown subtrees while only the final block grows.
class StreamingEcoMarkdown extends StatefulWidget {
  const StreamingEcoMarkdown({
    super.key,
    required this.text,
    required this.tailStyle,
    this.compact = false,
    this.muted = false,
    this.fontSizeScale = 1,
  });

  final String text;
  final TextStyle? tailStyle;
  final bool compact;
  final bool muted;
  final double fontSizeScale;

  @override
  State<StreamingEcoMarkdown> createState() => _StreamingEcoMarkdownState();
}

class _StreamingEcoMarkdownState extends State<StreamingEcoMarkdown> {
  final _markdown = IncrementalMarkdown();
  final _completedWidgets = <CompletedMarkdownBlock, Widget>{};

  @override
  void initState() {
    super.initState();
    _markdown.update(widget.text);
  }

  @override
  void didUpdateWidget(covariant StreamingEcoMarkdown oldWidget) {
    super.didUpdateWidget(oldWidget);
    final oldReferences = _markdown.references;
    _markdown.update(widget.text);
    if (!widget.text.startsWith(oldWidget.text) ||
        widget.compact != oldWidget.compact ||
        widget.muted != oldWidget.muted ||
        widget.fontSizeScale != oldWidget.fontSizeScale) {
      _completedWidgets.clear();
    } else if (!identical(oldReferences, _markdown.references)) {
      _completedWidgets.removeWhere((block, _) => block.hasReferenceCandidate);
    }
  }

  Widget _prose(String text, {Key? key, bool? hasReferenceCandidate}) =>
      EcoMarkdown(
        key: key,
        text: text,
        compact: widget.compact,
        muted: widget.muted,
        selectable: false,
        fontSizeScale: widget.fontSizeScale,
        references: (hasReferenceCandidate ?? text.contains('['))
            ? _markdown.references
            : null,
      );

  @override
  Widget build(BuildContext context) {
    final children = <Widget>[];
    var previousEndsInTable = false;
    var hasPrevious = false;
    void add(
      Widget child, {
      required bool startsInTable,
      required bool endsInTable,
    }) {
      if (hasPrevious && !previousEndsInTable && !startsInTable) {
        children.add(SizedBox(height: widget.compact ? 8 : 12));
      }
      children.add(child);
      previousEndsInTable = endsInTable;
      hasPrevious = true;
    }

    void addTail(String text, Widget child) {
      final segments = splitEcoMarkdownSegments(text)
          .where(
            (segment) =>
                segment is! EcoMarkdownProseSegment ||
                segment.text.trim().isNotEmpty,
          )
          .toList();
      add(
        child,
        startsInTable:
            segments.isNotEmpty && segments.first is EcoMarkdownTableSegment,
        endsInTable:
            segments.isNotEmpty && segments.last is EcoMarkdownTableSegment,
      );
    }

    for (final block in _markdown.completed) {
      if (!block.visible) continue;
      add(
        _completedWidgets.putIfAbsent(
          block,
          () => _prose(
            block.text,
            key: ObjectKey(block),
            hasReferenceCandidate: block.hasReferenceCandidate,
          ),
        ),
        startsInTable: block.startsInTable,
        endsInTable: block.endsInTable,
      );
    }
    final tail = _markdown.tail;
    if (_markdown.tailVisible) {
      final partition = partitionStreamingMarkdown(tail, streaming: true);
      if (isStructuralStreamingTail(partition.tail)) {
        if (partition.stable.trim().isNotEmpty) {
          addTail(partition.stable, _prose(partition.stable));
        }
        addTail(partition.tail, Text(partition.tail, style: widget.tailStyle));
      } else {
        addTail(tail, _prose(tail));
      }
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: children,
    );
  }
}
