import 'package:eco_mobile/core/models/conversation_v2_projection_models.dart';
import 'package:eco_mobile/features/threads/activity_feed.dart';
import 'package:flutter_test/flutter_test.dart';

class _CountedMessage extends ThreadRunProjectionTimelineItem {
  _CountedMessage(int index)
    : _body = '第 $index 条已完成的输出',
      super(
        id: 'message-$index',
        sequence: index + 2,
        eventType: 'message.final',
        scope: 'main',
        role: 'assistant',
        text: '',
        at: '2026-10-25T00:00:00Z',
        streamKey: 'message-$index',
        metadata: {'v2': true, 'logicalEntityId': 'message-$index'},
      );

  final String _body;
  int reads = 0;

  @override
  String get text {
    reads++;
    return _body;
  }
}

void main() {
  test('stream boundaries do not repeatedly parse all historical text', () {
    int readCount(int count) {
      final messages = List.generate(count, _CountedMessage.new);
      final entries = buildActivityFeed(
        runProjection: ThreadRunProjectionSnapshot(
          threadId: 'long-history',
          status: 'running',
          generatedAt: '2026-10-25T00:00:01Z',
          sourceEventCount: count + 1,
          agents: const [],
          timeline: [
            const ThreadRunProjectionTimelineItem(
              id: 'user',
              sequence: 1,
              eventType: 'message.final',
              scope: 'main',
              role: 'user',
              text: '任务',
              at: '2026-10-25T00:00:00Z',
              metadata: {'liveType': 'message.user'},
            ),
            ...messages,
          ],
        ),
        groupTurns: false,
      );
      final rendered = entries.where(
        (e) => e.kind == ActivityFeedKind.assistant,
      );
      expect(rendered.length, count);
      expect(rendered.first.text, '第 0 条已完成的输出');
      expect(rendered.last.text, '第 ${count - 1} 条已完成的输出');
      return messages.fold(0, (sum, message) => sum + message.reads);
    }

    // Count work rather than wall time, so this regression is independent of
    // the CI machine's speed. Four times the history must not do 16x the work.
    final small = readCount(100);
    final large = readCount(400);
    expect(large, lessThan(small * 6));
  });
}
