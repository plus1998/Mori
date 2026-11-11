// ignore_for_file: curly_braces_in_flow_control_structures

import 'dart:convert';

import '../models/file_preview_models.dart';

LocalFileLink? parseLocalFileLink(String? href) {
  final raw = href?.trim() ?? '';
  if (raw.isEmpty || raw.startsWith('//') || raw.startsWith('#')) return null;
  try {
    if (raw.startsWith('eco-file:')) {
      final json = jsonDecode(Uri.decodeComponent(raw.substring(9)));
      if (json is! Map || json['path'] is! String) return null;
      final line = json['line'];
      final column = json['column'];
      if ((line != null && (line is! int || line < 1)) ||
          (column != null && (column is! int || column < 1)))
        return null;
      return _link(
        json['path'] as String,
        line: line as int?,
        column: column as int?,
      );
    }
    String filePath;
    String fragment = '';
    if (RegExp(r'^[a-zA-Z]:[\\/]').hasMatch(raw) || raw.startsWith(r'\\')) {
      filePath = Uri.decodeFull(raw);
    } else {
      var uri = Uri.parse(raw);
      fragment = uri.fragment;
      if (uri.scheme == 'file') {
        if (uri.host == 'localhost') uri = uri.replace(host: '');
        final windows =
            RegExp(r'^/[a-zA-Z]:/').hasMatch(uri.path) || uri.host.isNotEmpty;
        filePath = uri.removeFragment().toFilePath(windows: windows);
      } else if (uri.scheme.isEmpty && !uri.hasAuthority) {
        filePath = Uri.decodeComponent(uri.path);
      } else {
        return null;
      }
    }
    final suffix = RegExp(r':([1-9]\d*)(?::([1-9]\d*))?$').firstMatch(filePath);
    final anchor = RegExp(
      r'^L?([1-9]\d*)(?:C([1-9]\d*)|(?:-L?[1-9]\d*)?)$',
    ).firstMatch(fragment);
    final line = int.tryParse(suffix?.group(1) ?? anchor?.group(1) ?? '');
    final column = int.tryParse(suffix?.group(2) ?? anchor?.group(2) ?? '');
    if (suffix != null) filePath = filePath.substring(0, suffix.start);
    return _link(filePath, line: line, column: column);
  } on FormatException {
    return null;
  } on UnsupportedError {
    return null;
  }
}

LocalFileLink? _link(String path, {int? line, int? column}) {
  if (path.isEmpty || RegExp(r'[\x00-\x1f\x7f]').hasMatch(path)) return null;
  return LocalFileLink(path: path, line: line, column: column);
}
