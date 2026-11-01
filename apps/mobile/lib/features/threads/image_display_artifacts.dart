import '../../core/models/image_display_models.dart';
import '../../core/models/conversation_v2_projection_models.dart';
import '../../core/utils/activity_display.dart';

/// Collect display_image artifacts from the live run projection.
///
/// Used as the primary mobile signal so the floating gallery appears as soon as
/// Feed metadata lands, even before / without a successful remote list call.
List<ImageDisplayArtifact> collectImageDisplayArtifactsFromProjection({
  required String threadId,
  ThreadRunProjectionSnapshot? projection,
}) {
  if (projection == null) return const [];
  final byId = <String, ImageDisplayArtifact>{};

  void scan(Iterable<ThreadRunProjectionTimelineItem> items) {
    for (final item in items) {
      final tool = readProjectionToolMetadata(item.metadata);
      final display = tool?.imageDisplay;
      final artifactId = display?.artifactId.trim() ?? '';
      if (artifactId.isEmpty) continue;
      final title = display?.title?.trim();
      final existing = byId[artifactId];
      if (existing != null &&
          (title == null || title.isEmpty || existing.title != null)) {
        continue;
      }
      byId[artifactId] = ImageDisplayArtifact(
        id: artifactId,
        threadId: threadId,
        toolUseId: tool?.toolUseId,
        status: tool?.status == 'failed' ? 'failed' : 'completed',
        sourceKind: 'path',
        title: title?.isNotEmpty == true ? title : existing?.title,
        mimeType: display?.mimeType ?? existing?.mimeType ?? 'image/png',
        filePath: existing?.filePath ?? '',
        sourceRef: existing?.sourceRef,
        bytes: existing?.bytes ?? 0,
        width: existing?.width,
        height: existing?.height,
        createdAt: item.at.isNotEmpty ? item.at : (existing?.createdAt ?? ''),
        updatedAt: item.at.isNotEmpty ? item.at : (existing?.updatedAt ?? ''),
      );
    }
  }

  scan(projection.timeline);
  for (final agent in projection.agents) {
    scan(agent.timeline);
  }

  final artifacts = byId.values.toList();
  artifacts.sort((left, right) {
    final byCreated = left.createdAt.compareTo(right.createdAt);
    if (byCreated != 0) return byCreated;
    return left.id.compareTo(right.id);
  });
  return List<ImageDisplayArtifact>.unmodifiable(artifacts);
}

/// Prefer remote list metadata, keep projection-only artifacts as fallback.
List<ImageDisplayArtifact> mergeImageDisplayArtifacts({
  required List<ImageDisplayArtifact> fromProjection,
  required List<ImageDisplayArtifact> fromRemote,
}) {
  if (fromRemote.isEmpty) return fromProjection;
  if (fromProjection.isEmpty) return fromRemote;
  final byId = <String, ImageDisplayArtifact>{
    for (final artifact in fromProjection) artifact.id: artifact,
  };
  for (final remote in fromRemote) {
    final local = byId[remote.id];
    byId[remote.id] = ImageDisplayArtifact(
      id: remote.id,
      threadId: remote.threadId.isNotEmpty
          ? remote.threadId
          : (local?.threadId ?? ''),
      toolUseId: remote.toolUseId ?? local?.toolUseId,
      status: remote.status,
      sourceKind: remote.sourceKind,
      title: remote.title ?? local?.title,
      mimeType: remote.mimeType,
      filePath: remote.filePath,
      sourceRef: remote.sourceRef ?? local?.sourceRef,
      bytes: remote.bytes > 0 ? remote.bytes : (local?.bytes ?? 0),
      width: remote.width ?? local?.width,
      height: remote.height ?? local?.height,
      createdAt: remote.createdAt.isNotEmpty
          ? remote.createdAt
          : (local?.createdAt ?? ''),
      updatedAt: remote.updatedAt.isNotEmpty
          ? remote.updatedAt
          : (local?.updatedAt ?? ''),
    );
  }
  final merged = byId.values.toList();
  merged.sort((left, right) {
    final byCreated = left.createdAt.compareTo(right.createdAt);
    if (byCreated != 0) return byCreated;
    return left.id.compareTo(right.id);
  });
  return List<ImageDisplayArtifact>.unmodifiable(merged);
}
