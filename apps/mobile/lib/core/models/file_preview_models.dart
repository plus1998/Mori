// ignore_for_file: curly_braces_in_flow_control_structures

import 'dart:convert';
import 'dart:typed_data';

const filePreviewMaxBytes = 32 * 1024 * 1024;
const filePreviewMaxTextBytes = 2 * 1024 * 1024;

class LocalFileLink {
  const LocalFileLink({required this.path, this.line, this.column});
  final String path;
  final int? line;
  final int? column;
}

enum FilePreviewKind {
  text,
  markdown,
  html,
  image,
  audio,
  video,
  pdf,
  unsupported,
}

class RemoteFileData {
  const RemoteFileData({
    required this.path,
    required this.name,
    required this.bytes,
    this.unsupportedReason,
  });

  final String path;
  final String name;
  final Uint8List bytes;
  final String? unsupportedReason;

  String get extension =>
      name.contains('.') ? name.split('.').last.toLowerCase() : '';

  String? get text {
    if (bytes.length > filePreviewMaxTextBytes || bytes.contains(0))
      return null;
    try {
      return utf8.decode(bytes, allowMalformed: false);
    } on FormatException {
      return null;
    }
  }

  FilePreviewKind get kind {
    if (unsupportedReason != null) return FilePreviewKind.unsupported;
    if (const [
      'png',
      'jpg',
      'jpeg',
      'gif',
      'webp',
      'bmp',
      'avif',
      'ico',
      'heic',
      'heif',
    ].contains(extension)) {
      return FilePreviewKind.image;
    }
    if (const [
      'mp3',
      'wav',
      'm4a',
      'aac',
      'ogg',
      'opus',
      'flac',
      'weba',
    ].contains(extension)) {
      return FilePreviewKind.audio;
    }
    if (const ['mp4', 'mov', 'm4v', 'webm'].contains(extension))
      return FilePreviewKind.video;
    if (extension == 'pdf') return FilePreviewKind.pdf;
    if (text == null) return FilePreviewKind.unsupported;
    if (const ['md', 'markdown', 'mdown'].contains(extension))
      return FilePreviewKind.markdown;
    if (const ['html', 'htm', 'svg'].contains(extension))
      return FilePreviewKind.html;
    return FilePreviewKind.text;
  }

  String? get mimeType => switch (extension) {
    'mp3' => 'audio/mpeg',
    'wav' => 'audio/wav',
    'm4a' => 'audio/mp4',
    'aac' => 'audio/aac',
    'ogg' || 'opus' => 'audio/ogg',
    'flac' => 'audio/flac',
    'weba' => 'audio/webm',
    'mp4' || 'm4v' => 'video/mp4',
    'mov' => 'video/quicktime',
    'webm' => 'video/webm',
    _ => null,
  };
}

class RemoteDirectoryEntry {
  const RemoteDirectoryEntry({
    required this.name,
    required this.path,
    required this.kind,
    this.size,
  });

  factory RemoteDirectoryEntry.fromJson(Map<String, dynamic> json) {
    final kind = json['kind'];
    if (kind != 'directory' && kind != 'file') {
      throw const FormatException('Invalid directory entry kind.');
    }
    final name = json['name'];
    final path = json['path'];
    if (name is! String || name.isEmpty || path is! String || path.isEmpty) {
      throw const FormatException('Invalid directory entry identity.');
    }
    return RemoteDirectoryEntry(
      name: name,
      path: path,
      kind: kind,
      size: (json['size'] as num?)?.toInt(),
    );
  }

  final String name;
  final String path;
  final String kind;
  final int? size;

  bool get isDirectory => kind == 'directory';
}

class RemoteDirectoryData {
  const RemoteDirectoryData({
    required this.path,
    required this.name,
    required this.entries,
    this.parentPath,
  });

  factory RemoteDirectoryData.fromJson(Map<String, dynamic> json) {
    final path = json['path'];
    final name = json['name'];
    final entries = json['entries'];
    if (path is! String ||
        path.isEmpty ||
        name is! String ||
        name.isEmpty ||
        entries is! List) {
      throw const FormatException('Invalid directory listing response.');
    }
    return RemoteDirectoryData(
      path: path,
      name: name,
      parentPath: json['parentPath'] as String?,
      entries: entries
          .map(
            (entry) =>
                RemoteDirectoryEntry.fromJson(entry as Map<String, dynamic>),
          )
          .toList(growable: false),
    );
  }

  final String path;
  final String name;
  final String? parentPath;
  final List<RemoteDirectoryEntry> entries;
}

class FilePreviewCancelled implements Exception {
  const FilePreviewCancelled();
}
