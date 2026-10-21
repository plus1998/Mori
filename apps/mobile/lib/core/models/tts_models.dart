import 'dart:typed_data';

class ReadAloudException implements Exception {
  const ReadAloudException(this.message);
  final String message;
  @override
  String toString() => message;
}

class ReadAloudStatus {
  const ReadAloudStatus({
    required this.available,
    this.reason,
    this.profileName,
    this.voice,
    this.style,
  });
  final bool available;
  final String? reason;
  final String? profileName;
  final String? voice;
  final String? style;
  factory ReadAloudStatus.fromJson(dynamic json) {
    if (json is! Map || json['available'] is! bool) {
      throw const ReadAloudException('朗读状态响应无效。');
    }
    return ReadAloudStatus(
      available: json['available'] as bool,
      reason: json['reason'] as String?,
      profileName: json['profileName'] as String?,
      voice: json['voice'] as String?,
      style: json['style'] as String?,
    );
  }
}

class ReadAloudStartResult {
  const ReadAloudStartResult(this.requestId, this.segmentCount);
  final String requestId;
  final int segmentCount;
}

class ReadAloudSegmentResult {
  const ReadAloudSegmentResult(this.mimeType, this.totalBytes);
  final String mimeType;
  final int totalBytes;
}

class ReadAloudChunk {
  const ReadAloudChunk({
    required this.bytes,
    required this.offset,
    required this.totalBytes,
    required this.mimeType,
  });
  final Uint8List bytes;
  final int offset;
  final int totalBytes;
  final String mimeType;
}

abstract interface class ReadAloudRemote {
  Future<ReadAloudStatus> getReadAloudStatus();
  Future<ReadAloudStartResult> startReadAloud({
    required String requestId,
    required String threadId,
    required String entryId,
    required String sourceText,
  });
  Future<ReadAloudSegmentResult> synthesizeReadAloudSegment(
    String requestId,
    int index,
  );
  Future<ReadAloudChunk> readReadAloudChunk(
    String requestId,
    int index,
    int offset,
    int length,
  );
  Future<void> cancelReadAloud(String requestId);
}
