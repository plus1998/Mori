String shortenModelId(String modelId) {
  final trimmed = modelId.trim();
  if (trimmed.isEmpty) {
    return '';
  }
  final slash = trimmed.lastIndexOf('/');
  final normalized = slash >= 0 ? trimmed.substring(slash + 1) : trimmed;
  if (normalized.length <= 24) {
    return normalized;
  }
  return '${normalized.substring(0, 11)}…${normalized.substring(normalized.length - 10)}';
}

/// Vendor prefixes dropped from display names: these families are household names,
/// so `gpt-6.1-sol` reads better as `6.1 Sol`.
final RegExp _modelVendorPrefix = RegExp(r'^(gpt|claude)[-_]', caseSensitive: false);
const Map<String, String> _modelVendorAliases = {'gpt': 'GPT', 'claude': 'Claude'};

/// Humanizes a raw model id for compact UI (composer label, model menus): strips a
/// leading `gpt` / `claude` prefix, capitalizes `-` separated tokens
/// (`qwen3.8-flash-next` → `Qwen3.8 Flash Next`) and turns a separator between
/// single digits into `.` (`opus-5_5` / `opus-4-6` → `Opus 5.5` / `Opus 4.6`);
/// other `_` characters are kept as-is.
String formatModelDisplayName(String modelId) {
  final trimmed = modelId.trim();
  if (trimmed.isEmpty) {
    return '';
  }
  final slash = trimmed.lastIndexOf('/');
  final leaf = (slash >= 0 ? trimmed.substring(slash + 1) : trimmed).trim();
  if (leaf.isEmpty) {
    return trimmed;
  }
  final alias = _modelVendorAliases[leaf.toLowerCase()];
  if (alias != null) {
    return alias;
  }
  final prefix = _modelVendorPrefix.firstMatch(leaf);
  final body = prefix == null ? leaf : leaf.substring(prefix.end);
  final parts = mergeDigitVersionTokens(body.split('-')).map(_capitalizeModelSegment).toList();
  return parts.isEmpty ? leaf : parts.join(' ');
}

/// Joins adjacent single-digit tokens (`4`, `6`) into one version token (`4.6`), so
/// `claude-opus-4-6` reads as `Opus 4.6`. Only single digits join: `llama-3.3-70b`
/// stays `Llama 3.3 70b`.
List<String> mergeDigitVersionTokens(List<String> tokens) {
  final merged = <String>[];
  // True while the last entry is made only of single-digit source tokens.
  var mergeable = false;
  for (final token in tokens) {
    if (token.isEmpty) {
      continue;
    }
    final singleDigit = RegExp(r'^\d$').hasMatch(token);
    if (mergeable && singleDigit) {
      merged[merged.length - 1] = '${merged.last}.$token';
      continue;
    }
    merged.add(token);
    mergeable = singleDigit;
  }
  return merged;
}

String _capitalizeModelSegment(String segment) {
  final normalized = segment.replaceAllMapped(RegExp(r'(\d)_(?=\d)'), (match) => '${match[1]}.');
  if (normalized.isEmpty) {
    return normalized;
  }
  return '${normalized.substring(0, 1).toUpperCase()}${normalized.substring(1)}';
}
