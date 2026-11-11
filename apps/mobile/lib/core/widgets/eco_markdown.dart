import 'dart:convert';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter_markdown/flutter_markdown.dart';
import 'package:markdown/markdown.dart' as md;

import '../theme/eco_theme.dart';
import '../utils/feed_text.dart';
import '../utils/local_file_link.dart';
import '../utils/composer_references.dart';
import 'composer_reference_text.dart';
import '../utils/markdown_repair.dart';
import 'eco_markdown_table.dart';
import 'feed_code_builder.dart';
import 'markdown_link.dart';

class EcoMarkdown extends StatefulWidget {
  const EcoMarkdown({
    super.key,
    required this.text,
    this.compact = false,
    this.muted = false,
    this.selectable = true,
    this.fontSizeScale = 1,
    this.references,
    this.composerReferences = false,
  });

  final String text;
  final bool composerReferences;
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
    if (oldWidget.composerReferences != widget.composerReferences ||
        oldWidget.text != widget.text ||
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
    // Markdown scrollbars belong to their content, not the screen's safe area.
    // In particular, iOS subtracts the inherited bottom inset from a code
    // block's scrollbar position: https://github.com/flutter/flutter/issues/57920
    return MediaQuery.removePadding(
      context: context,
      removeLeft: true,
      removeTop: true,
      removeRight: true,
      removeBottom: true,
      child: _content ??= _buildContent(context),
    );
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
                composerReferences: widget.composerReferences,
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
    // flutter_markdown constrains markers to listIndent. Measure their actual
    // scaled font so accessibility text cannot wrap the period below a number.
    final markerPainter = TextPainter(
      text: TextSpan(text: '99.', style: base),
      textDirection: Directionality.of(context),
      textScaler: MediaQuery.textScalerOf(context),
    )..layout();
    final listIndent = math.max(20.0, markerPainter.width.ceilToDouble());
    markerPainter.dispose();

    return MarkdownBody(
      // flutter_markdown reparses on data/style changes, but not syntaxes.
      key: ValueKey((
        widget.references,
        widget.composerReferences,
        segmentIndex,
      )),
      data: data,
      selectable: widget.selectable,
      onTapLink: (text, href, title) {
        openMarkdownLink(context, text, href, title);
      },
      shrinkWrap: true,
      builders: {
        'code': FeedCodeBuilder(),
        if (widget.composerReferences)
          'composer-ref': _ComposerReferenceBuilder(),
      },
      inlineSyntaxes: [
        _LocalFileReferenceSyntax(),
        if (widget.composerReferences) _ComposerReferenceSyntax(),
        if (widget.references != null) ...[
          _SharedLinkSyntax(widget.references!),
          _SharedImageSyntax(widget.references!),
        ],
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
        listIndent: listIndent,
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

/// Matches absolute workspace paths emitted as plain Markdown text. Desktop
/// turns these into file references before rendering; mobile must do the same
/// so a path in prose is tappable instead of inert text.
class _LocalFileReferenceSyntax extends md.InlineSyntax {
  _LocalFileReferenceSyntax()
    : super(
        r'(?<![\w:/])(?:/[\w.\-+@~%]+(?:/[\w.\-+@~%]+)*|[A-Za-z]:[\\/][^\s`<>()\[\]]+)(?::\d+(?::\d+)?)?',
      );

  @override
  bool onMatch(md.InlineParser parser, Match match) {
    final raw = match.group(0)!;
    final reference = parseLocalFileLink(raw);
    if (reference == null) return false;
    final href =
        'eco-file:${Uri.encodeComponent(jsonEncode({'path': reference.path, 'line': ?reference.line, 'column': ?reference.column}))}';
    final link = md.Element('a', [])..attributes['href'] = href;
    link.children!.add(md.Text(raw));
    parser.addNode(link);
    return true;
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

class _ComposerReferenceSyntax extends md.InlineSyntax {
  _ComposerReferenceSyntax()
    : super(
        r'@(ssh|todo|plan|web|web_selection|conversation|integration|subagent|mcp)\{([^{}\s]+)\}',
      );
  @override
  bool onMatch(md.InlineParser parser, Match match) {
    final text = match.group(0)!;
    if (!parseComposerPrompt(text).any((part) => part.isReference)) {
      return false;
    }
    parser.addNode(md.Element.text('composer-ref', text));
    return true;
  }
}

class _ComposerReferenceBuilder extends MarkdownElementBuilder {
  @override
  Widget? visitElementAfterWithContext(
    BuildContext context,
    md.Element element,
    TextStyle? preferredStyle,
    TextStyle? parentStyle,
  ) {
    // Return Text.rich directly: flutter_markdown merges its TextSpans and
    // WidgetSpans into the surrounding emphasis/link paragraph (flutter#144383).
    return ComposerReferenceTextLayout(
      context: context,
      segments: parseComposerPrompt(element.textContent),
      style: preferredStyle ?? parentStyle,
      maxWidth: MediaQuery.sizeOf(context).width * .7,
    ).build();
  }
}
