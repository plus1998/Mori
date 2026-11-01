class ImageDisplayArtifact {
  const ImageDisplayArtifact({
    required this.id,
    required this.threadId,
    required this.status,
    required this.sourceKind,
    required this.mimeType,
    required this.filePath,
    required this.bytes,
    required this.createdAt,
    required this.updatedAt,
    this.toolUseId,
    this.title,
    this.sourceRef,
    this.width,
    this.height,
  });

  final String id;
  final String threadId;
  final String? toolUseId;
  final String status;
  final String sourceKind;
  final String? title;
  final String mimeType;
  final String filePath;
  final String? sourceRef;
  final int bytes;
  final int? width;
  final int? height;
  final String createdAt;
  final String updatedAt;

  bool get isVideo => mimeType.startsWith('video/');
  bool get isAudio => mimeType.startsWith('audio/');
  bool get isImage => mimeType.startsWith('image/');

  factory ImageDisplayArtifact.fromJson(Map<String, dynamic> json) {
    final id = (json['id'] as String?)?.trim() ?? '';
    final threadId = (json['threadId'] as String?)?.trim() ?? '';
    final status = (json['status'] as String?)?.trim() ?? 'completed';
    final sourceKind = (json['sourceKind'] as String?)?.trim() ?? 'path';
    final mimeType = (json['mimeType'] as String?)?.trim() ?? 'image/png';
    final filePath = (json['filePath'] as String?)?.trim() ?? '';
    final createdAt = (json['createdAt'] as String?)?.trim() ?? '';
    final updatedAt = (json['updatedAt'] as String?)?.trim() ?? '';
    final toolUseId = (json['toolUseId'] as String?)?.trim();
    final title = (json['title'] as String?)?.trim();
    final sourceRef = (json['sourceRef'] as String?)?.trim();
    final bytes = json['bytes'];
    final width = json['width'];
    final height = json['height'];
    return ImageDisplayArtifact(
      id: id,
      threadId: threadId,
      toolUseId: toolUseId?.isNotEmpty == true ? toolUseId : null,
      status: status.isEmpty ? 'completed' : status,
      sourceKind: sourceKind.isEmpty ? 'path' : sourceKind,
      title: title?.isNotEmpty == true ? title : null,
      mimeType: mimeType.isEmpty ? 'image/png' : mimeType,
      filePath: filePath,
      sourceRef: sourceRef?.isNotEmpty == true ? sourceRef : null,
      bytes: bytes is num ? bytes.toInt() : 0,
      width: width is num ? width.toInt() : null,
      height: height is num ? height.toInt() : null,
      createdAt: createdAt,
      updatedAt: updatedAt,
    );
  }

  String get displayTitle {
    final named = title?.trim();
    if (named != null && named.isNotEmpty) return named;
    final ref = sourceRef?.trim();
    if (ref != null && ref.isNotEmpty) {
      final normalized = ref.replaceAll('\\', '/');
      final parts = normalized.split('/').where((part) => part.isNotEmpty);
      final basename = parts.isEmpty ? ref : parts.last;
      if (basename.isNotEmpty) return basename;
    }
    return id;
  }
}
