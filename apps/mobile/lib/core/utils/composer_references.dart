import 'dart:convert';

/// The durable reference format shared with desktop composer-references.ts.
/// Parsing is presentation-only: callers keep the original prompt for sending,
/// copying and editing, since labels do not identify the referenced object.
class ComposerPromptSegment {
  const ComposerPromptSegment.text(this.text)
    : kind = null,
      id = null,
      label = null,
      detail = null;

  const ComposerPromptSegment.reference({
    required this.text,
    required this.kind,
    required this.id,
    required this.label,
    required this.detail,
  });

  final String text;
  final String? kind;
  final String? id;
  final String? label;
  final String? detail;

  bool get isReference => kind != null;
  String get displayText => isReference ? '@$label' : text;
}

final _referencePattern = RegExp(
  r'@(ssh|todo|web|web_selection|conversation|integration|subagent|mcp)\{([^{}\s]+)\}',
);

List<ComposerPromptSegment> parseComposerPrompt(String text) {
  final segments = <ComposerPromptSegment>[];
  var cursor = 0;
  for (final match in _referencePattern.allMatches(text)) {
    final reference = _parseReference(match);
    if (reference == null) continue;
    if (match.start > cursor) {
      segments.add(
        ComposerPromptSegment.text(text.substring(cursor, match.start)),
      );
    }
    segments.add(reference);
    cursor = match.end;
  }
  if (cursor < text.length || segments.isEmpty) {
    segments.add(ComposerPromptSegment.text(text.substring(cursor)));
  }
  return segments;
}

ComposerPromptSegment? _parseReference(RegExpMatch match) {
  try {
    final data = jsonDecode(Uri.decodeComponent(match.group(2)!));
    if (data is! Map<String, dynamic>) return null;
    final id = data['id'];
    final label = data['label'];
    final detail = data['detail'];
    if (id is! String ||
        id.isEmpty ||
        id.length > 256 ||
        label is! String ||
        detail is! String) {
      return null;
    }
    return ComposerPromptSegment.reference(
      text: match.group(0)!,
      kind: match.group(1)!,
      id: id,
      label: label.length > 500 ? label.substring(0, 500) : label,
      detail: detail.length > 2000 ? detail.substring(0, 2000) : detail,
    );
  } on FormatException {
    // Malformed or unknown tokens stay visible verbatim, like ordinary text.
    return null;
  } on ArgumentError {
    // Uri.decodeComponent rejects malformed percent escapes with ArgumentError.
    return null;
  }
}

String composerPromptDisplayText(String text) =>
    parseComposerPrompt(text).map((segment) => segment.displayText).join();

String composerReferenceToken({
  required String kind,
  required String id,
  required String label,
  required String detail,
}) =>
    '@$kind{${Uri.encodeComponent(jsonEncode({'id': id, 'label': label.length > 500 ? label.substring(0, 500) : label, 'detail': detail.length > 2000 ? detail.substring(0, 2000) : detail}))}}';
