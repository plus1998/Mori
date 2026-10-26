import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../theme/eco_theme.dart';
import '../utils/composer_references.dart';

/// Shares exact chip dimensions between rendering and collapsed-line measuring.
/// Measuring encoded tokens as plain text would incorrectly collapse short refs.
class ComposerReferenceTextLayout {
  ComposerReferenceTextLayout({
    required BuildContext context,
    required List<ComposerPromptSegment> segments,
    required TextStyle? style,
    required double maxWidth,
  }) : style = DefaultTextStyle.of(context).style.merge(style),
       textScaler = MediaQuery.textScalerOf(context),
       textDirection = Directionality.of(context) {
    final eco = ecoColors(context);
    final labelStyle = this.style.copyWith(
      fontSize: (this.style.fontSize ?? 14) * 0.93,
      height: 1.2,
    );
    final children = <InlineSpan>[];
    for (final segment in segments) {
      if (!segment.isReference) {
        children.add(TextSpan(text: segment.text));
        continue;
      }
      final labelPainter = TextPainter(
        text: TextSpan(text: segment.displayText, style: labelStyle),
        textDirection: textDirection,
        textScaler: textScaler,
        maxLines: 1,
      )..layout();
      final iconSize = textScaler.scale(13);
      final width = math.min(maxWidth, labelPainter.width + iconSize + 4 + 12);
      final height = math.max(labelPainter.height, iconSize) + 4;
      labelPainter.dispose();
      placeholders.add(
        PlaceholderDimensions(
          size: Size(width, height),
          alignment: PlaceholderAlignment.middle,
        ),
      );
      children.add(
        WidgetSpan(
          alignment: PlaceholderAlignment.middle,
          child: Tooltip(
            message: [
              segment.label!,
              if (segment.detail!.isNotEmpty) segment.detail!,
            ].join(' · '),
            excludeFromSemantics: true,
            child: Container(
              width: width,
              height: height,
              padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
              decoration: BoxDecoration(
                color: eco.navHover,
                borderRadius: BorderRadius.circular(6),
              ),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Icon(
                    _referenceIcon(segment),
                    size: iconSize,
                    color: eco.textSecondary,
                  ),
                  const SizedBox(width: 4),
                  Expanded(
                    child: Text(
                      segment.displayText,
                      style: labelStyle,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      textScaler: textScaler,
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      );
    }
    span = TextSpan(style: this.style, children: children);
  }

  final TextStyle style;
  final TextScaler textScaler;
  final TextDirection textDirection;
  final placeholders = <PlaceholderDimensions>[];
  late final TextSpan span;

  bool exceedsLineLimit({required double maxWidth, required int maxLines}) {
    final painter = TextPainter(
      text: span,
      textDirection: textDirection,
      textScaler: textScaler,
      maxLines: maxLines,
    )..setPlaceholderDimensions(placeholders);
    painter.layout(maxWidth: maxWidth);
    final exceeds = painter.didExceedMaxLines;
    painter.dispose();
    return exceeds;
  }

  Widget build({int? maxLines}) => Text.rich(
    span,
    style: style,
    textScaler: textScaler,
    textDirection: textDirection,
    maxLines: maxLines,
    overflow: TextOverflow.clip,
  );
}

IconData _referenceIcon(ComposerPromptSegment reference) =>
    switch (reference.kind) {
      'todo' => Icons.checklist_rounded,
      'ssh' => Icons.terminal_rounded,
      'web' => Icons.language_rounded,
      'web_selection' => Icons.select_all_rounded,
      'conversation' => Icons.chat_bubble_outline_rounded,
      'subagent' => Icons.people_outline_rounded,
      'integration' => switch (reference.id) {
        'browser' => Icons.language_rounded,
        'imageGeneration' => Icons.image_outlined,
        'tts' => Icons.graphic_eq_rounded,
        'computerUse' => Icons.desktop_mac_outlined,
        _ => Icons.apps_rounded,
      },
      _ => Icons.apps_rounded,
    };
