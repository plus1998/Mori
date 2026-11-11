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

class FilePreviewCancelled implements Exception {
  const FilePreviewCancelled();
}
