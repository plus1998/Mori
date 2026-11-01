import 'package:flutter_test/flutter_test.dart';
import 'package:eco_mobile/core/models/image_display_models.dart';
import 'package:eco_mobile/core/models/conversation_v2_projection_models.dart';
import 'package:eco_mobile/features/threads/image_display_artifacts.dart';

void main() {
  test('collectImageDisplayArtifactsFromProjection reads tool metadata', () {
    final projection = ThreadRunProjectionSnapshot(
      threadId: 't1',
      status: 'idle',
      generatedAt: '2026-01-01T00:00:00.000Z',
      agents: const [],
      sourceEventCount: 1,
      timeline: [
        ThreadRunProjectionTimelineItem(
          id: 'e1',
          sequence: 1,
          eventType: 'tool.completed',
          scope: 'main',
          text: '',
          at: '2026-01-01T00:00:00.000Z',
          role: 'tool',
          metadata: {
            'tool': {
              'name': 'mcp__eco_image_display__display_image',
              'status': 'completed',
              'imageDisplay': {
                'artifactId': 'art-1',
                'title': 'Hero',
                'mimeType': 'video/mp4',
              },
            },
          },
        ),
      ],
    );

    final artifacts = collectImageDisplayArtifactsFromProjection(
      threadId: 't1',
      projection: projection,
    );
    expect(artifacts, hasLength(1));
    expect(artifacts.single.id, 'art-1');
    expect(artifacts.single.title, 'Hero');
    expect(artifacts.single.isVideo, isTrue);
    expect(artifacts.single.isImage, isFalse);
  });

  test('mergeImageDisplayArtifacts prefers remote metadata', () {
    final merged = mergeImageDisplayArtifacts(
      fromProjection: [
        const ImageDisplayArtifact(
          id: 'art-1',
          threadId: 't1',
          status: 'completed',
          sourceKind: 'path',
          mimeType: 'image/png',
          filePath: '',
          bytes: 0,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        ),
      ],
      fromRemote: [
        const ImageDisplayArtifact(
          id: 'art-1',
          threadId: 't1',
          status: 'completed',
          sourceKind: 'url',
          title: 'Remote title',
          mimeType: 'image/jpeg',
          filePath: '/tmp/a.jpg',
          bytes: 12,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:01:00.000Z',
        ),
      ],
    );
    expect(merged, hasLength(1));
    expect(merged.single.title, 'Remote title');
    expect(merged.single.sourceKind, 'url');
    expect(merged.single.bytes, 12);
  });
}
