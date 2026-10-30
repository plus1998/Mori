const pacedStreamInterval = Duration(milliseconds: 40);

/// Merges streaming text chunks (cumulative snapshots or incremental deltas).
String mergeStreamText(String previous, String incoming) {
  if (incoming.isEmpty) {
    return previous;
  }
  if (previous.isEmpty) {
    return incoming;
  }
  if (incoming == previous) {
    return previous;
  }
  if (incoming.startsWith(previous) && incoming.length > previous.length) {
    return incoming;
  }
  if (incoming.length >= 2 && previous.endsWith(incoming)) {
    return previous;
  }

  final overlapped = _mergeWithSuffixPrefixOverlap(previous, incoming);
  if (overlapped != null) {
    return overlapped;
  }

  return '$previous$incoming';
}

String? _mergeWithSuffixPrefixOverlap(String previous, String incoming) {
  final max = [
    previous.length,
    incoming.length,
    256,
  ].reduce((left, right) => left < right ? left : right);
  for (var len = max; len >= 3; len--) {
    if (previous.substring(previous.length - len) ==
        incoming.substring(0, len)) {
      return previous + incoming.substring(len);
    }
  }
  return null;
}

String thinkingPreviewLine(String text, {int max = 120}) {
  var plain = text.replaceAll(RegExp(r'```[\s\S]*?```'), ' ');
  for (final pattern in [
    RegExp(r'`([^`]+)`'),
    RegExp(r'\*\*([^*]+)\*\*'),
    RegExp(r'\*([^*]+)\*'),
  ]) {
    plain = plain.replaceAllMapped(pattern, (match) => match.group(1) ?? '');
  }
  plain = plain
      .replaceAll(RegExp(r'^#+\s+', multiLine: true), '')
      .replaceAll(RegExp(r'\s+'), ' ')
      .trim();
  if (plain.length <= max) {
    return plain;
  }
  return '${plain.substring(0, max - 1)}…';
}

/// Splits Summary carousel stages at explicit newlines and sentence boundaries
/// (EN/CJK). Does not use camelCase heuristics, which falsely split identifiers
/// like `iPhone`.
List<String> splitThinkingCarouselLines(String text) {
  return text
      .split(RegExp(r'\r?\n'))
      .expand(_splitReasoningCarouselStageLine)
      .map((line) => line.replaceAll(RegExp(r'[ \t]+'), ' ').trim())
      .where((line) => line.isNotEmpty)
      .toList();
}

List<String> _splitReasoningCarouselStageLine(String line) {
  final trimmed = line.trim();
  if (trimmed.isEmpty) {
    return const [];
  }
  return trimmed
      .split(RegExp(r'(?<=[.!?。！？])\s*(?=[A-Z\u4e00-\u9fff])'))
      .map((part) => part.trim())
      .where((part) => part.isNotEmpty)
      .toList();
}

/// Reasoning summary label. Keeps natural line breaks for carousel stages and
/// strips markdown markers like [thinkingPreviewLine] without flattening them.
/// Adjacent bold stage titles (`**A****B**`) become separate lines.
/// [maxLines] only bounds pathological inputs; Summary remains ephemeral.
String reasoningSummaryLabel(String text, {int maxLines = 20}) {
  var plain = text.replaceAll(RegExp(r'```[\s\S]*?```'), ' ');
  plain = plain.replaceAllMapped(
    RegExp(r'`([^`]+)`'),
    (match) => match.group(1) ?? '',
  );
  // Separate glued bold stage titles (`**A****B**`) before stripping markers.
  plain = plain.replaceAllMapped(
    RegExp(r'\*\*([^*]+)\*\*(?=\*\*)'),
    (match) => '${match.group(1)}\n',
  );
  for (final pattern in [
    RegExp(r'\*\*([^*]+)\*\*'),
    RegExp(r'\*([^*]+)\*'),
  ]) {
    plain = plain.replaceAllMapped(pattern, (match) => match.group(1) ?? '');
  }
  plain = plain
      .replaceAll(RegExp(r'^#+\s+', multiLine: true), '')
      .replaceAll(RegExp(r'[ \t]+'), ' ')
      .trim();
  final lines = plain.split('\n');
  if (lines.length <= maxLines) {
    return plain;
  }
  return lines.sublist(lines.length - maxLines).join('\n');
}
