import 'package:flutter_test/flutter_test.dart';

import 'package:eco_mobile/core/models/conversation_v2_projection_models.dart';
import 'package:eco_mobile/core/utils/reasoning_summary.dart';

ThreadRunProjectionTimelineItem _item({
  required String id,
  required String eventType,
  String text = '',
  String? streamKey,
  Map<String, dynamic>? metadata,
  int sequence = 1,
}) {
  return ThreadRunProjectionTimelineItem(
    id: id,
    sequence: sequence,
    eventType: eventType,
    scope: 'main',
    role: eventType.startsWith('thinking.') ? 'thinking' : 'tool',
    text: text,
    at: '2026-01-01T00:00:0$sequence.000Z',
    streamKey: streamKey,
    metadata: metadata,
  );
}

void main() {
  test('isReasoningSummaryItem requires summary stamp and non-empty text', () {
    expect(
      isReasoningSummaryItem(
        _item(
          id: 'empty',
          eventType: 'thinking.final',
          metadata: const {'reasoningDisplay': 'summary'},
        ),
      ),
      isFalse,
    );
    expect(
      isReasoningSummaryItem(
        _item(
          id: 'raw',
          eventType: 'thinking.final',
          text: 'raw chain of thought',
          metadata: const {'reasoningDisplay': 'raw'},
        ),
      ),
      isFalse,
    );
    expect(
      isReasoningSummaryItem(
        _item(
          id: 'summary',
          eventType: 'thinking.final',
          text: '定位入口',
          metadata: const {'reasoningDisplay': 'summary'},
        ),
      ),
      isTrue,
    );
    expect(
      isReasoningSummaryItem(
        _item(
          id: 'method',
          eventType: 'thinking.delta',
          text: '检查测试',
          metadata: const {'codexMethod': 'item/reasoning/summaryTextDelta'},
        ),
      ),
      isTrue,
    );
  });

  test('collapse drops every tip once the conversation has stopped', () {
    // Supersede-by-event only works while the run keeps producing. A conversation
    // that stopped without landing a hard event after the tip must not leave the
    // 阅后即焚 tip on the Feed, still cycling its stages.
    final collapsed = collapseEphemeralReasoningSummaryTimeline(
      [
        _item(
          id: 'bash-1',
          eventType: 'tool.completed',
          text: 'Tool: Bash · ls',
          sequence: 1,
        ),
        _item(
          id: 'stage-1',
          eventType: 'thinking.final',
          text: '定位入口',
          streamKey: 'rs_1',
          metadata: const {'reasoningDisplay': 'summary'},
          sequence: 2,
        ),
      ],
      conversationLive: false,
    );

    expect(collapsed.map((item) => item.id), ['bash-1']);
  });

  test(
    'collapse keeps only the latest tip after the last superseding event',
    () {
      final collapsed = collapseEphemeralReasoningSummaryTimeline([
        _item(
          id: 'stage-1',
          eventType: 'thinking.final',
          text: '定位入口',
          streamKey: 'rs_1',
          metadata: const {'reasoningDisplay': 'summary'},
        ),
        _item(
          id: 'bash-1',
          eventType: 'tool.started',
          text: 'Tool: Bash · ls',
          sequence: 2,
        ),
        _item(
          id: 'stage-2',
          eventType: 'thinking.delta',
          text: '检查测试',
          streamKey: 'rs_2',
          sequence: 3,
          metadata: const {'reasoningDisplay': 'summary'},
        ),
      ]);

      expect(collapsed.map((item) => item.id), ['bash-1', 'stage-2']);
    },
  );

  test('empty terminal thinking does not supersede a reasoning summary', () {
    final collapsed = collapseEphemeralReasoningSummaryTimeline([
      _item(
        id: 'stage-1',
        eventType: 'thinking.final',
        text: '定位入口',
        streamKey: 'rs_1',
        metadata: const {'reasoningDisplay': 'summary'},
      ),
      _item(id: 'empty', eventType: 'thinking.final', sequence: 2),
    ]);

    expect(collapsed.map((item) => item.id), ['stage-1', 'empty']);
  });

  test('raw thinking supersedes a reasoning summary', () {
    final collapsed = collapseEphemeralReasoningSummaryTimeline([
      _item(
        id: 'stage-1',
        eventType: 'thinking.final',
        text: '定位入口',
        streamKey: 'rs_1',
        metadata: const {'reasoningDisplay': 'summary'},
      ),
      _item(
        id: 'raw-1',
        eventType: 'thinking.final',
        text: 'raw chain of thought',
        sequence: 2,
        metadata: const {'reasoningDisplay': 'raw'},
      ),
    ]);

    expect(collapsed.map((item) => item.id), ['raw-1']);
  });

  test('collapse uses source sequence instead of display list order', () {
    final collapsed = collapseEphemeralReasoningSummaryTimeline([
      _item(
        id: 'stage-latest',
        eventType: 'thinking.delta',
        text: '继续处理',
        streamKey: 'rs_latest',
        sequence: 3,
        metadata: const {'reasoningDisplay': 'summary'},
      ),
      _item(
        id: 'tool-earlier',
        eventType: 'tool.completed',
        text: 'Tool: Edit · lib/a.dart',
        sequence: 2,
      ),
    ]);

    expect(collapsed.map((item) => item.id), ['stage-latest', 'tool-earlier']);
  });

  test('later summaries keep the first temporary slot key', () {
    final collapsed = collapseEphemeralReasoningSummaryTimeline([
      _item(
        id: 'stage-1',
        eventType: 'thinking.delta',
        text: '第一阶段',
        streamKey: 'rs_1',
        metadata: const {'reasoningDisplay': 'summary'},
      ),
      _item(
        id: 'stage-2',
        eventType: 'thinking.delta',
        text: '第二阶段',
        streamKey: 'rs_2',
        sequence: 2,
        metadata: const {'reasoningDisplay': 'summary'},
      ),
    ]);

    expect(collapsed, hasLength(1));
    expect(collapsed.single.id, 'stage-2');
    expect(collapsed.single.metadata?['reasoningSummarySlotKey'], 'rs_1');
  });

  test('presentThinkingAsEphemeralSummaryTips stamps raw thinking as summary', () {
    final stamped = presentThinkingAsEphemeralSummaryTips([
      _item(
        id: 'raw',
        eventType: 'thinking.final',
        text: '先定位入口',
        metadata: const {'reasoningDisplay': 'raw'},
      ),
      _item(
        id: 'summary',
        eventType: 'thinking.delta',
        text: '已是 summary',
        metadata: const {'reasoningDisplay': 'summary'},
      ),
      _item(
        id: 'message',
        eventType: 'message.final',
        text: '结论',
      ),
    ]);

    expect(readReasoningDisplay(stamped[0].metadata), 'summary');
    expect(readReasoningDisplay(stamped[1].metadata), 'summary');
    expect(stamped[2].eventType, 'message.final');
  });
}
