import 'package:flutter/material.dart';

import '../theme/eco_theme.dart';
import '../utils/composer_references.dart';

class _ReferenceRange {
  const _ReferenceRange(this.start, this.end, this.reference);
  final int start;
  final int end;
  final ComposerPromptSegment reference;

  _ReferenceRange shift(int delta) =>
      _ReferenceRange(start + delta, end + delta, reference);
}

/// Native undo/redo stores editing values; keep reference identity in that same
/// snapshot. Edits that change text go through the controller's range mapping.
class _PromptEditingValue extends TextEditingValue {
  _PromptEditingValue(TextEditingValue value, List<_ReferenceRange> references)
    : references = List.unmodifiable(references),
      super(
        text: value.text,
        selection: value.selection,
        composing: value.composing,
      );

  final List<_ReferenceRange> references;

  @override
  TextEditingValue copyWith({
    String? text,
    TextSelection? selection,
    TextRange? composing,
  }) {
    final next = super.copyWith(
      text: text,
      selection: selection,
      composing: composing,
    );
    return text == null || text == this.text
        ? _PromptEditingValue(next, references)
        : next;
  }
}

/// Editable text contains visible @labels, while [prompt] retains durable IDs.
/// Spans have the same text length as the editing value, so native selection,
/// composing and caret offsets stay valid. An edit inside a reference replaces
/// the entire reference rather than silently changing its identity.
class ComposerPromptEditingController extends TextEditingController {
  ComposerPromptEditingController({String text = ''}) {
    this.text = text;
  }

  var _references = <_ReferenceRange>[];
  _PromptEditingValue? _snapshot;

  @override
  TextEditingValue get value => _snapshot ?? super.value;

  void _commitValue(TextEditingValue next) {
    final snapshot = _PromptEditingValue(next, _references);
    final oldReferences = _snapshot?.references ?? const <_ReferenceRange>[];
    final sameReferences =
        oldReferences.length == _references.length &&
        List.generate(
          oldReferences.length,
          (i) =>
              oldReferences[i].start == _references[i].start &&
              oldReferences[i].end == _references[i].end &&
              oldReferences[i].reference.text == _references[i].reference.text,
        ).every((same) => same);
    final sameFields = super.value == snapshot;
    _snapshot = snapshot;
    super.value = snapshot;
    // TextEditingValue equality only compares visible fields. A restored draft
    // can use the same label for a different todo, which still changes identity.
    if (sameFields && !sameReferences) notifyListeners();
  }

  String get prompt {
    final out = StringBuffer();
    var cursor = 0;
    for (final range in _references) {
      out.write(text.substring(cursor, range.start));
      out.write(range.reference.text);
      cursor = range.end;
    }
    out.write(text.substring(cursor));
    return out.toString();
  }

  ComposerMentionQuery? get mentionQuery {
    final caret = selection;
    if (!caret.isValid ||
        !caret.isCollapsed ||
        (value.isComposingRangeValid && !value.composing.isCollapsed)) {
      return null;
    }
    final query = parseComposerMentionQuery(text, caret.extentOffset);
    if (query == null ||
        _references.any(
          (range) =>
              query.start < range.end && caret.extentOffset > range.start,
        )) {
      return null;
    }
    return query;
  }

  void startMention() {
    var caret = selection.isValid
        ? selection
        : TextSelection.collapsed(offset: text.length);
    if (caret.isCollapsed) {
      for (final range in _references) {
        if (caret.start > range.start && caret.start < range.end) {
          caret = TextSelection.collapsed(offset: range.end);
          break;
        }
      }
    }
    final prefix =
        caret.start > 0 && !RegExp(r'\s').hasMatch(text[caret.start - 1])
        ? ' '
        : '';
    final replacement = '$prefix@';
    selection = caret;
    value = TextEditingValue(
      text: text.replaceRange(caret.start, caret.end, replacement),
      selection: TextSelection.collapsed(
        offset: caret.start + replacement.length,
      ),
    );
  }

  /// Use a fresh editing value so native undo snapshots retain both old and
  /// new identities; copyWith on a snapshot deliberately preserves its ranges.
  void insertReference(String token, ComposerMentionQuery query) {
    if (mentionQuery != query) return;
    final replacement = _decode('$token ');
    if (replacement.references.length != 1) {
      throw ArgumentError.value(
        token,
        'token',
        'Expected one durable reference',
      );
    }
    final end = selection.extentOffset;
    final updated = text.replaceRange(query.start, end, replacement.text);
    final delta = replacement.text.length - (end - query.start);
    _references = [
      for (final range in _references)
        if (range.end <= query.start) range,
      for (final range in replacement.references) range.shift(query.start),
      for (final range in _references)
        if (range.start >= end) range.shift(delta),
    ];
    _commitValue(
      TextEditingValue(
        text: updated,
        selection: TextSelection.collapsed(
          offset: query.start + replacement.text.length,
        ),
      ),
    );
  }

  /// Programmatic drafts/restores use the wire format; the getter is visible text.
  @override
  set text(String newText) {
    final decoded = _decode(newText);
    _references = decoded.references;
    _commitValue(
      TextEditingValue(
        text: decoded.text,
        selection: TextSelection.collapsed(offset: decoded.text.length),
      ),
    );
  }

  @override
  set value(TextEditingValue next) {
    if (next is _PromptEditingValue) {
      _references = List.of(next.references);
      _commitValue(next);
      return;
    }
    final previous = super.value;
    if (previous.text == next.text) {
      _commitValue(next);
      return;
    }
    var start = 0;
    while (start < previous.text.length &&
        start < next.text.length &&
        previous.text.codeUnitAt(start) == next.text.codeUnitAt(start)) {
      start++;
    }
    var oldEnd = previous.text.length;
    var newEnd = next.text.length;
    while (oldEnd > start &&
        newEnd > start &&
        previous.text.codeUnitAt(oldEnd - 1) ==
            next.text.codeUnitAt(newEnd - 1)) {
      oldEnd--;
      newEnd--;
    }
    // Anchor replacements to native selection when repeated labels are equal.
    final selection = previous.selection;
    if (selection.isValid) {
      var selectionStart = selection.start;
      var selectionEnd = selection.end;
      final removed = previous.text.length - next.text.length;
      if (selection.isCollapsed && removed > 0 && next.selection.isValid) {
        selectionStart = next.selection.start < selection.start
            ? next.selection.start
            : selection.start;
        selectionEnd = selectionStart + removed;
      }
      final insertedLength =
          next.text.length -
          previous.text.length +
          selectionEnd -
          selectionStart;
      if (insertedLength >= 0 &&
          selectionEnd <= previous.text.length &&
          next.text.startsWith(previous.text.substring(0, selectionStart)) &&
          next.text.endsWith(previous.text.substring(selectionEnd))) {
        start = selectionStart;
        oldEnd = selectionEnd;
        newEnd = start + insertedLength;
      }
    }
    final inserted = _decode(next.text.substring(start, newEnd));
    var replaceStart = start;
    var replaceEnd = oldEnd;
    for (final range in _references) {
      if ((start < range.end && oldEnd > range.start) ||
          (start == oldEnd && start > range.start && start < range.end)) {
        if (range.start < replaceStart) replaceStart = range.start;
        if (range.end > replaceEnd) replaceEnd = range.end;
      }
    }
    final delta = inserted.text.length - (replaceEnd - replaceStart);
    _references = [
      for (final range in _references)
        if (range.end <= replaceStart) range,
      for (final range in inserted.references) range.shift(replaceStart),
      for (final range in _references)
        if (range.start >= replaceEnd) range.shift(delta),
    ];
    final normalized =
        replaceStart != start ||
        replaceEnd != oldEnd ||
        inserted.text != next.text.substring(start, newEnd);
    final updated = normalized
        ? TextEditingValue(
            text:
                previous.text.substring(0, replaceStart) +
                inserted.text +
                previous.text.substring(replaceEnd),
            selection: TextSelection.collapsed(
              offset: replaceStart + inserted.text.length,
            ),
          )
        : next;
    _commitValue(updated);
  }

  @override
  TextSpan buildTextSpan({
    required BuildContext context,
    TextStyle? style,
    required bool withComposing,
  }) {
    if (_references.isEmpty) {
      return super.buildTextSpan(
        context: context,
        style: style,
        withComposing: withComposing,
      );
    }
    final composing = value.composing;
    final showComposing =
        withComposing && value.isComposingRangeValid && !composing.isCollapsed;
    final boundaries = <int>{
      0,
      text.length,
      for (final range in _references) ...[range.start, range.end],
      if (showComposing) ...[composing.start, composing.end],
    }.toList()..sort();
    final eco = ecoColors(context);
    return TextSpan(
      style: style,
      children: [
        for (var i = 0; i < boundaries.length - 1; i++)
          TextSpan(
            text: text.substring(boundaries[i], boundaries[i + 1]),
            style: TextStyle(
              backgroundColor:
                  _references.any(
                    (r) => r.start <= boundaries[i] && r.end > boundaries[i],
                  )
                  ? eco.navHover
                  : null,
              decoration:
                  showComposing &&
                      composing.start <= boundaries[i] &&
                      composing.end > boundaries[i]
                  ? TextDecoration.underline
                  : null,
            ),
          ),
      ],
    );
  }
}

({String text, List<_ReferenceRange> references}) _decode(String raw) {
  final out = StringBuffer();
  final references = <_ReferenceRange>[];
  for (final segment in parseComposerPrompt(raw)) {
    final start = out.length;
    out.write(segment.displayText);
    if (segment.isReference) {
      references.add(_ReferenceRange(start, out.length, segment));
    }
  }
  return (text: out.toString(), references: references);
}

String composerWirePrompt(TextEditingController controller) =>
    controller is ComposerPromptEditingController
    ? controller.prompt
    : controller.text;
