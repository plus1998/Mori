import 'package:eco_mobile/core/models/conversation_v2_models.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('round-trips the immutable history target on a V2 user message', () {
    final message = ConversationV2Message.fromJson({
      'messageId': 'message_1',
      'conversationId': 'thread_1',
      'turnId': 'turn_1',
      'role': 'user',
      'channel': 'answer',
      'createdSeq': 1,
      'versionSeq': 1,
      'contentVersion': 0,
      'body': 'retry me',
      'status': 'final',
      'isDeleted': false,
      'historyTarget': {
        'activityLineId': 'activity_1',
        'userMessageId': 'provider_1',
      },
    });

    expect(message.historyTarget?.activityLineId, 'activity_1');
    expect(message.historyTarget?.userMessageId, 'provider_1');
    expect(message.toJson()['historyTarget'], {
      'activityLineId': 'activity_1',
      'userMessageId': 'provider_1',
    });
  });

  test(
    'rejects malformed optional identity fields instead of treating them as absent',
    () {
      final message = <String, dynamic>{
        'messageId': 'message_1',
        'conversationId': 'thread_1',
        'turnId': 'turn_1',
        'runId': 7,
        'role': 'assistant',
        'channel': 'answer',
        'createdSeq': 1,
        'versionSeq': 1,
        'contentVersion': 0,
        'body': 'hello',
        'status': 'streaming',
        'isDeleted': false,
      };

      expect(
        () => ConversationV2Message.fromJson(message),
        throwsFormatException,
      );
    },
  );

  test('accepts bootstrap responses from desktops without run summaries', () {
    final bootstrap = ConversationV2Bootstrap.fromJson({
      'protocolVersion': 2,
      'storeEpoch': 'epoch_1',
      'conversationId': 'thread_1',
      'snapshotSeq': 0,
      'historyRevision': 0,
      'messages': const [],
      'runs': null,
      'hasOlder': false,
    });

    expect(bootstrap.messages, isEmpty);
    expect(bootstrap.runs, isEmpty);
    expect(bootstrap.tools, isEmpty);
  });

  test('parses compaction details from a V2 bootstrap response', () {
    final bootstrap = ConversationV2Bootstrap.fromJson({
      'protocolVersion': 2,
      'storeEpoch': 'epoch_1',
      'conversationId': 'thread_1',
      'snapshotSeq': 4,
      'historyRevision': 0,
      'messages': const [],
      'runs': const [],
      'tools': const [],
      'details': [
        {
          'itemId': 'compaction-1',
          'conversationId': 'thread_1',
          'runId': 'run_1',
          'type': 'context.compaction.started',
          'createdSeq': 3,
          'versionSeq': 3,
          'content':
              '{"message":"正在压缩上下文","observedAt":"2026-10-21T00:00:03.000Z","scope":"main"}',
        },
      ],
      'hasOlder': false,
    });

    expect(bootstrap.details, hasLength(1));
    expect(bootstrap.details.single.itemId, 'compaction-1');
    expect(bootstrap.details.single.type, 'context.compaction.started');
  });

  test('identifies the invalid response list field', () {
    expect(
      () => ConversationV2Bootstrap.fromJson({
        'protocolVersion': 2,
        'storeEpoch': 'epoch_1',
        'conversationId': 'thread_1',
        'snapshotSeq': 0,
        'historyRevision': 0,
        'messages': null,
        'runs': const [],
        'tools': const [],
        'hasOlder': false,
      }),
      throwsA(
        isA<FormatException>().having(
          (error) => error.message,
          'message',
          'Conversation V2 messages must be a list, got Null.',
        ),
      ),
    );
  });

  test('rejects integers outside the cross-platform safe range', () {
    expect(
      () => ConversationV2Message.fromJson({
        'messageId': 'message_1',
        'conversationId': 'thread_1',
        'turnId': 'turn_1',
        'role': 'assistant',
        'channel': 'answer',
        'createdSeq': 9007199254740992,
        'versionSeq': 1,
        'contentVersion': 0,
        'body': 'hello',
        'status': 'streaming',
        'isDeleted': false,
      }),
      throwsFormatException,
    );
  });

  test('rejects unknown message roles and channels', () {
    final message = <String, dynamic>{
      'messageId': 'message_1',
      'conversationId': 'thread_1',
      'turnId': 'turn_1',
      'role': 'operator',
      'channel': 'answer',
      'createdSeq': 1,
      'versionSeq': 1,
      'contentVersion': 0,
      'body': 'hello',
      'status': 'streaming',
      'isDeleted': false,
    };

    expect(
      () => ConversationV2Message.fromJson(message),
      throwsFormatException,
    );
    expect(
      () => ConversationV2Message.fromJson({
        ...message,
        'role': 'assistant',
        'channel': 'debug',
      }),
      throwsFormatException,
    );
  });

  test('rejects inconsistent V2 tool page metadata', () {
    final base = <String, dynamic>{
      'protocolVersion': 2,
      'storeEpoch': 'epoch_1',
      'conversationId': 'thread_1',
      'runId': 'run_1',
      'readSeq': 2,
      'historyRevision': 0,
      'tools': const [],
      'totalCount': 0,
      'hasMore': false,
    };

    expect(
      () => ConversationV2ToolsPage.fromJson({...base, 'readSeq': -1}),
      throwsFormatException,
    );
    expect(
      () => ConversationV2ToolsPage.fromJson({...base, 'totalCount': -1}),
      throwsFormatException,
    );
    expect(
      () => ConversationV2ToolsPage.fromJson({...base, 'hasMore': true}),
      throwsFormatException,
    );
    expect(
      () => ConversationV2ToolsPage.fromJson({
        ...base,
        'nextCursor': 'cursor_without_more',
      }),
      throwsFormatException,
    );
  });
}
