List<String> buildRunCommand(
  String packageManager,
  String script,
  String? args,
) {
  final trimmedArgs = args?.trim();
  final tokens = trimmedArgs != null && trimmedArgs.isNotEmpty
      ? _splitShellArgs(trimmedArgs)
      : <String>[];
  switch (packageManager) {
    case 'bun':
      return tokens.isNotEmpty
          ? ['bun', 'run', script, ...tokens]
          : ['bun', 'run', script];
    case 'pnpm':
      if (tokens.isEmpty) {
        return ['pnpm', 'run', script];
      }
      return tokens.first == '--'
          ? ['pnpm', 'run', script, ...tokens]
          : ['pnpm', 'run', script, '--', ...tokens];
    case 'yarn':
      if (tokens.isEmpty) {
        return ['yarn', 'run', script];
      }
      return tokens.first == '--'
          ? ['yarn', 'run', script, ...tokens]
          : ['yarn', 'run', script, '--', ...tokens];
    default:
      if (tokens.isEmpty) {
        return ['npm', 'run', script];
      }
      return tokens.first == '--'
          ? ['npm', 'run', script, ...tokens]
          : ['npm', 'run', script, '--', ...tokens];
  }
}

String formatRunCommand(
  String packageManager,
  String script,
  String? args, [
  String? prefix,
]) {
  final base = joinPrefixedCommand(
    prefix,
    buildRunCommand(packageManager, script, null),
  );
  final trailingArgs = args?.trim() ?? '';
  if (trailingArgs.isEmpty) return base;
  final separator =
      packageManager != 'bun' && !RegExp(r'^--(?:\s|$)').hasMatch(trailingArgs)
      ? ' --'
      : '';
  // Keep authored shell syntax for preview/copy, including incomplete edits.
  return '$base$separator $trailingArgs';
}

/// Join a leading shell command (nvm switch, env exports) with the argv.
String joinPrefixedCommand(String? prefix, List<String> command) {
  final normalizedPrefix = normalizeCommandPrefix(prefix);
  final body = command.map(_quoteCommandArg).join(' ');
  return normalizedPrefix.isEmpty ? body : '$normalizedPrefix && $body';
}

/// Leading command as authored by the user; a trailing connector is dropped
/// because we always insert `&&`.
String normalizeCommandPrefix(String? prefix) {
  return (prefix?.trim() ?? '')
      .replaceAll(RegExp(r'(?:&&|\|\||[;&])\s*$'), '')
      .trim();
}

String _quoteCommandArg(String value) {
  if (RegExp(r'^[A-Za-z0-9_@%+=:,./-]+$').hasMatch(value)) return value;
  final escaped = value.replaceAllMapped(
    RegExp(r'[\\"$`]'),
    (match) => '\\${match[0]}',
  );
  return '"$escaped"';
}

/// Parse quoting/escaping without expanding shell expressions.
List<String> _splitShellArgs(String value) {
  final tokens = <String>[];
  var token = StringBuffer();
  String? quote;
  var started = false;
  for (var index = 0; index < value.length; index += 1) {
    final char = value[index];
    if (char == r'\' && quote != "'") {
      if (index + 1 == value.length) {
        throw const FormatException('Trailing escape in script arguments.');
      }
      final next = value[index + 1];
      if (quote == null || RegExp(r'[\\"$`\n]').hasMatch(next)) {
        if (next != '\n') {
          token.write(next);
          started = true;
        }
        index += 1;
        continue;
      }
    }
    if (quote != null) {
      if (char == quote) {
        quote = null;
      } else {
        token.write(char);
      }
    } else if (char == "'" || char == '"') {
      quote = char;
      started = true;
    } else if (RegExp(r'\s').hasMatch(char)) {
      if (started) tokens.add(token.toString());
      token = StringBuffer();
      started = false;
    } else {
      token.write(char);
      started = true;
    }
  }
  if (quote != null) {
    throw const FormatException('Unclosed quote in script arguments.');
  }
  if (started) tokens.add(token.toString());
  return tokens;
}
