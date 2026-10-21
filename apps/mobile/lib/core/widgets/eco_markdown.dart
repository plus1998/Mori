import 'package:flutter/material.dart';
import 'package:flutter_markdown/flutter_markdown.dart';
import 'package:markdown/markdown.dart' as md;

import '../theme/eco_theme.dart';
import '../utils/feed_text.dart';
import '../utils/markdown_repair.dart';
import 'eco_markdown_table.dart';
import 'feed_code_builder.dart';

class EcoMarkdown extends StatefulWidget {
  const EcoMarkdown({
    super.key,
    required this.text,
    this.compact = false,
    this.muted = false,
    this.selectable = true,
    this.fontSizeScale = 1,
    this.references,
  });

  final String text;
  final bool compact;
  final bool muted;
  final bool selectable;
  final double fontSizeScale;

  /// Shared reference definitions for independently rendered streaming blocks.
  /// Callers retain this immutable map until its destinations/titles change.
  final Map<String, md.LinkReference>? references;

  @override
  State<EcoMarkdown> createState() => _EcoMarkdownState();
}

class _EcoMarkdownState extends State<EcoMarkdown> {
  Widget? _content;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _content = null;
  }

  @override
  void didUpdateWidget(covariant EcoMarkdown oldWidget) {
    super.didUpdateWidget(oldWidget);
    // Live feed updates and duration labels also rebuild settled messages.
    // Keep their repaired text, tables and Markdown subtree until an input changes.
    if (oldWidget.text != widget.text ||
        oldWidget.compact != widget.compact ||
        oldWidget.muted != widget.muted ||
        oldWidget.selectable != widget.selectable ||
        oldWidget.fontSizeScale != widget.fontSizeScale ||
        !identical(oldWidget.references, widget.references)) {
      _content = null;
    }
  }

  @override
  Widget build(BuildContext context) {
    return _content ??= _buildContent(context);
  }

  Widget _buildContent(BuildContext context) {
    final repaired = repairMarkdown(sanitizeFeedText(widget.text));
    final segments = splitEcoMarkdownSegments(repaired);
    if (segments.isEmpty) {
      return const SizedBox.shrink();
    }
    if (segments.length == 1 && segments.first is EcoMarkdownProseSegment) {
      return _buildProse(
        context,
        (segments.first as EcoMarkdownProseSegment).text,
      );
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        for (final (index, segment) in segments.indexed)
          switch (segment) {
            EcoMarkdownProseSegment(:final text) =>
              text.trim().isEmpty
                  ? const SizedBox.shrink()
                  : _buildProse(context, text, segmentIndex: index),
            EcoMarkdownTableSegment(:final table) => Padding(
              padding: EdgeInsets.symmetric(vertical: widget.compact ? 10 : 14),
              child: EcoMarkdownTable(
                table: table,
                compact: widget.compact,
                muted: widget.muted,
                fontSizeScale: widget.fontSizeScale,
              ),
            ),
          },
      ],
    );
  }

  Widget _buildProse(
    BuildContext context,
    String data, {
    int segmentIndex = 0,
  }) {
    final compact = widget.compact;
    final muted = widget.muted;
    final eco = ecoColors(context);
    final baseColor = muted
        ? eco.textMuted.withValues(alpha: 0.85)
        : eco.textHeading;
    final baseStyle = Theme.of(context).textTheme.bodyMedium;
    final base = baseStyle?.copyWith(
      fontSize: (baseStyle.fontSize ?? 13) * widget.fontSizeScale,
      height: compact ? 1.45 : 1.55,
      color: baseColor,
    );

    return MarkdownBody(
      // flutter_markdown reparses on data/style changes, but not syntaxes.
      key: ValueKey((widget.references, segmentIndex)),
      data: data,
      selectable: widget.selectable,
      shrinkWrap: true,
      builders: {'code': FeedCodeBuilder()},
      inlineSyntaxes: widget.references == null
          ? null
          : [
              _SharedLinkSyntax(widget.references!),
              _SharedImageSyntax(widget.references!),
            ],
      styleSheet: MarkdownStyleSheet(
        p: base,
        h1: base?.copyWith(
          fontSize: (base.fontSize ?? 14) + (muted ? 4 : 6),
          fontWeight: FontWeight.w600,
          color: baseColor,
        ),
        h2: base?.copyWith(
          fontSize: (base.fontSize ?? 14) + (muted ? 2 : 4),
          fontWeight: FontWeight.w600,
          color: baseColor,
        ),
        h3: base?.copyWith(
          fontSize: (base.fontSize ?? 14) + (muted ? 1 : 2),
          fontWeight: FontWeight.w600,
          color: baseColor,
        ),
        h4: base?.copyWith(fontWeight: FontWeight.w600, color: baseColor),
        strong: base?.copyWith(fontWeight: FontWeight.w600, color: baseColor),
        em: base?.copyWith(fontStyle: FontStyle.italic, color: baseColor),
        blockquote: base?.copyWith(
          color: muted ? eco.textMuted : eco.textSecondary,
        ),
        blockquotePadding: const EdgeInsets.fromLTRB(12, 2, 0, 2),
        blockquoteDecoration: BoxDecoration(
          border: Border(left: BorderSide(color: eco.borderSubtle, width: 3)),
        ),
        listBullet: base,
        code: base?.copyWith(
          fontFamily: 'monospace',
          fontSize: (base.fontSize ?? 14) - 1,
          color: muted ? eco.textSecondary : eco.accentText,
          backgroundColor: eco.codeBg,
        ),
        codeblockDecoration: BoxDecoration(
          color: eco.codeBg,
          borderRadius: BorderRadius.circular(8),
          border: Border.all(color: eco.borderSubtle),
        ),
        codeblockPadding: const EdgeInsets.all(12),
        // Fallback if a table leaks into prose (should be rare after split).
        tableColumnWidth: const IntrinsicColumnWidth(),
        tableHeadAlign: TextAlign.left,
        tableHead: base?.copyWith(
          fontWeight: FontWeight.w600,
          fontSize: (base.fontSize ?? 14) - 0.5,
          color: muted ? eco.textMuted : eco.textSecondary,
          height: 1.35,
        ),
        tableBody: base,
        tableBorder: TableBorder(
          top: BorderSide(color: eco.borderSubtle),
          bottom: BorderSide(color: eco.borderSubtle),
          left: BorderSide(color: eco.borderSubtle),
          right: BorderSide(color: eco.borderSubtle),
          horizontalInside: BorderSide(color: eco.borderSubtle),
          verticalInside: BorderSide(color: eco.borderSubtle),
        ),
        tableCellsPadding: const EdgeInsets.symmetric(
          horizontal: 10,
          vertical: 6,
        ),
        tablePadding: const EdgeInsets.only(bottom: 4),
        tableScrollbarThumbVisibility: true,
        blockSpacing: compact ? 8 : 12,
        listIndent: 20,
        horizontalRuleDecoration: BoxDecoration(
          border: Border(top: BorderSide(color: eco.borderSubtle)),
        ),
        a: base?.copyWith(color: muted ? eco.textSecondary : eco.accentText),
      ),
    );
  }
}

class _SharedLinkSyntax extends md.LinkSyntax {
  _SharedLinkSyntax(this.references);
  final Map<String, md.LinkReference> references;

  @override
  bool onMatch(md.InlineParser parser, Match match) {
    parser.document.linkReferences.addAll(references);
    return super.onMatch(parser, match);
  }
}

class _SharedImageSyntax extends md.ImageSyntax {
  _SharedImageSyntax(this.references);
  final Map<String, md.LinkReference> references;

  @override
  bool onMatch(md.InlineParser parser, Match match) {
    parser.document.linkReferences.addAll(references);
    return super.onMatch(parser, match);
  }
}
