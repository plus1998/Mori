import 'package:flutter_test/flutter_test.dart';

import 'package:eco_mobile/core/models/html_host_models.dart';
import 'package:eco_mobile/core/models/conversation_v2_projection_models.dart';
import 'package:eco_mobile/features/threads/html_host_artifacts.dart';

void main() {
  test('collects html host artifacts from projection metadata', () {
    final projection = ThreadRunProjectionSnapshot(
      threadId: 'thr_1',
      status: 'idle',
      generatedAt: '2026-01-01T00:00:00.000Z',
      agents: const [],
      sourceEventCount: 1,
      timeline: [
        ThreadRunProjectionTimelineItem(
          id: 'item_1',
          sequence: 1,
          eventType: 'tool.completed',
          scope: 'main',
          text: '',
          at: '2026-01-01T00:00:01.000Z',
          role: 'tool',
          metadata: {
            'tool': {
              'name': 'mcp__mori_html_host__publish_html',
              'status': 'completed',
              'htmlHost': {
                'pageId': 'page_1',
                'publicUrl': 'https://example.test/p/page_1',
                'title': 'Report',
              },
            },
          },
        ),
      ],
    );

    final artifacts = collectHtmlHostArtifactsFromProjection(
      threadId: 'thr_1',
      projection: projection,
    );
    expect(artifacts, hasLength(1));
    expect(artifacts.single.pageId, 'page_1');
    expect(artifacts.single.title, 'Report');
    expect(artifacts.single.publicUrl, 'https://example.test/p/page_1');
  });

  test('merge prefers remote html host metadata', () {
    final merged = mergeHtmlHostArtifacts(
      fromProjection: [
        const HtmlHostArtifact(
          id: 'page_1',
          threadId: 'thr_1',
          status: 'completed',
          pageId: 'page_1',
          slug: '',
          title: 'Local',
          publicUrl: 'https://example.test/local',
          expiresAt: '',
          canExtend: false,
          createdAt: 'a',
          updatedAt: 'a',
        ),
      ],
      fromRemote: [
        const HtmlHostArtifact(
          id: 'art_1',
          threadId: 'thr_1',
          status: 'completed',
          pageId: 'page_1',
          slug: 'report',
          title: 'Remote',
          publicUrl: 'https://example.test/remote',
          expiresAt: 'later',
          canExtend: true,
          createdAt: 'b',
          updatedAt: 'b',
        ),
      ],
    );
    expect(merged, hasLength(1));
    expect(merged.single.id, 'art_1');
    expect(merged.single.title, 'Remote');
    expect(merged.single.slug, 'report');
    expect(merged.single.canExtend, isTrue);
  });
}
