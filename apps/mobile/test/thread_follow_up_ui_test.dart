import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:flutter/widgets.dart';

import 'package:eco_mobile/core/models/thread_models.dart';
import 'package:eco_mobile/core/utils/thread_follow_up_ui.dart';
import 'package:eco_mobile/l10n/generated/app_localizations.dart';

final _zh = lookupAppLocalizations(const Locale('zh'));

ThreadPendingFollowUp followUp(
  String id, {
  String status = 'queued',
  String priority = 'normal',
  String createdAt = '2024-01-01T00:00:00.000Z',
  String prompt = 'message',
  String updatedAt = '2024-01-01T00:00:00.000Z',
}) {
  return ThreadPendingFollowUp(
    id: id,
    threadId: 'thr_1',
    prompt: prompt,
    status: status,
    createdAt: createdAt,
    updatedAt: updatedAt,
    priority: priority,
  );
}

void main() {
  test('old edit replies and events cannot resurrect settled queue rows', () {
    for (final status in ['applied', 'cancelled', 'superseded', 'failed']) {
      final terminal = followUp(
        'sent',
        status: status,
        updatedAt: '2026-10-05T09:46:20.407Z',
      );
      final stale = followUp('sent', updatedAt: '2026-10-05T09:42:58.648Z');
      final editing = followUp('editing');
      final result = mergeThreadFollowUps([terminal, editing], [stale]);
      expect(queuedThreadFollowUps(result).map((row) => row.id), ['editing']);
      expect(result.firstWhere((row) => row.id == 'sent'), same(terminal));
    }
  });

  test(
    'newer queued edits win, and rejected pushes may legitimately requeue',
    () {
      final before = followUp(
        'edit',
        prompt: 'before',
        updatedAt: '2026-10-05T10:00:01.000Z',
      );
      final after = followUp(
        'edit',
        prompt: 'after',
        updatedAt: '2026-10-05T10:00:02.000Z',
      );
      expect(mergeThreadFollowUps([after], [before]).single, same(after));
      final delivered = followUp(
        'push',
        status: 'delivered',
        updatedAt: '2026-10-05T10:00:01.000Z',
      );
      final requeued = followUp('push', updatedAt: '2026-10-05T10:00:02.000Z');
      expect(
        mergeThreadFollowUps([delivered], [requeued]).single,
        same(requeued),
      );
      final applied = followUp(
        'push',
        status: 'applied',
        updatedAt: '2026-10-05T10:00:03.000Z',
      );
      expect(
        mergeThreadFollowUps([applied], [delivered, requeued]).single,
        same(applied),
      );
    },
  );

  test('isFollowUpThreadLiveEvent matches follow-up topics and payloads', () {
    expect(
      isFollowUpThreadLiveEvent(
        kind: 'thread.follow_up',
        liveType: 'thread.follow_up.queued',
      ),
      isTrue,
    );
    expect(
      isFollowUpThreadLiveEvent(
        kind: 'thread.lifecycle',
        liveType: 'thread.follow_up.applied',
      ),
      isTrue,
    );
    expect(
      isFollowUpThreadLiveEvent(
        kind: 'thread.stream',
        liveType: 'thread.running',
        hasFollowUp: true,
      ),
      isTrue,
    );
    expect(
      isFollowUpThreadLiveEvent(
        kind: 'thread.stream',
        liveType: 'thread.running',
      ),
      isFalse,
    );
  });

  test('resolveThreadEventThreadId prefers envelope thread id', () {
    expect(
      resolveThreadEventThreadId(
        envelopeThreadId: 'thr_envelope',
        payloadThreadId: 'thr_payload',
      ),
      'thr_envelope',
    );
    expect(
      resolveThreadEventThreadId(payloadThreadId: 'thr_payload'),
      'thr_payload',
    );
    expect(resolveThreadEventThreadId(), isNull);
  });

  test('isLiveFollowUpThreadStatus only opens running and queued UI', () {
    expect(isLiveFollowUpThreadStatus('running'), isTrue);
    expect(isLiveFollowUpThreadStatus('queued'), isTrue);
    expect(isLiveFollowUpThreadStatus('awaiting_plan'), isFalse);
    expect(isLiveFollowUpThreadStatus('completed'), isFalse);
  });

  test('shouldComposerUseFollowUpQueue while live, editing, or paused', () {
    expect(shouldComposerUseFollowUpQueue(status: 'running'), isTrue);
    expect(shouldComposerUseFollowUpQueue(status: 'idle'), isFalse);
    expect(
      shouldComposerUseFollowUpQueue(status: 'idle', followUpQueuePaused: true),
      isTrue,
    );
    expect(
      shouldComposerUseFollowUpQueue(
        status: 'completed',
        editingFollowUpId: 'fu_1',
      ),
      isTrue,
    );
  });

  test('queuedThreadFollowUps hides non-queued records', () {
    final normal = followUp('normal');
    final cancelled = followUp('cancelled', status: 'cancelled');
    final escalated = followUp(
      'escalated',
      priority: 'escalated',
      createdAt: '2024-01-01T00:00:01.000Z',
    );

    expect(
      queuedThreadFollowUps([
        normal,
        cancelled,
        escalated,
      ]).map((item) => item.id),
      ['escalated', 'normal'],
    );
  });

  test(
    'canEscalateFollowUp lets a stuck escalated row be sent while paused',
    () {
      expect(
        canEscalateFollowUp(priority: 'normal', queuePaused: false),
        isTrue,
      );
      expect(
        canEscalateFollowUp(priority: 'normal', queuePaused: true),
        isTrue,
      );
      expect(
        canEscalateFollowUp(priority: 'escalated', queuePaused: true),
        isTrue,
      );
      expect(
        canEscalateFollowUp(priority: 'escalated', queuePaused: false),
        isFalse,
      );
    },
  );

  test('mergeThreadFollowUp replaces existing records by id', () {
    final original = followUp('same', prompt: '旧消息');
    final updated = followUp('same', prompt: '已取消', status: 'cancelled');

    expect(mergeThreadFollowUp([original], updated), [updated]);
  });

  test('formatThreadFollowUpPreview clips long prompts', () {
    final preview = formatThreadFollowUpPreview(
      followUp('long', prompt: 'a' * 130),
      _zh,
    );

    expect(preview.length, 120);
    expect(preview.endsWith('...'), isTrue);
  });

  test(
    'follow-up preview resolves references before truncating encoded data',
    () {
      final token =
          '@todo{${Uri.encodeComponent(jsonEncode({'id': 'todo-1', 'label': '移动端适配', 'detail': '详细内容' * 200}))}}';
      final item = followUp('ref', prompt: '处理 $token');
      expect(formatThreadFollowUpPreview(item, _zh), '处理 @移动端适配');
      expect(item.prompt, '处理 $token');
    },
  );

  test('formatThreadFollowUpPreview includes image count', () {
    final item = ThreadPendingFollowUp(
      id: 'image-follow-up',
      threadId: 'thread-1',
      prompt: '看一下',
      status: 'queued',
      createdAt: '2026-01-01T00:00:00.000Z',
      attachments: const [
        PromptImageAttachment(mediaType: 'image/jpeg', data: 'YWJj'),
      ],
    );

    expect(formatThreadFollowUpPreview(item, _zh), '看一下 (1 张图片)');
  });
}
