import 'package:eco_mobile/core/models/conversation_v2_models.dart';
import 'package:eco_mobile/core/models/conversation_v2_projection_models.dart';
import 'package:eco_mobile/features/threads/activity_feed.dart';
import 'package:eco_mobile/features/threads/conversation_v2_projection.dart';
import 'package:eco_mobile/features/threads/projection_activity_feed.dart';
import 'package:eco_mobile/l10n/generated/app_localizations_en.dart';
import 'package:eco_mobile/l10n/generated/app_localizations_zh.dart';
import 'package:flutter_test/flutter_test.dart';

ConversationV2Message _message(String id, int sequence) =>
    ConversationV2Message(
      messageId: id,
      conversationId: 'thread',
      turnId: 'turn',
      role: 'assistant',
      channel: 'answer',
      createdSeq: sequence,
      versionSeq: sequence,
      contentVersion: 1,
      body: '内容 $id',
      status: ConversationV2MessageStatus.finalised,
      isDeleted: false,
    );

void main() {
  test('a cache requires an explicit store epoch', () {
    expect(
      () => buildConversationV2Projection(
        conversationId: 'thread',
        messages: const [],
        runs: const [],
        tools: const [],
        cache: ConversationV2ProjectionCache(),
      ),
      throwsArgumentError,
    );
  });

  test(
    'cached adapters update only changed rows and reset at epoch/revision',
    () {
      final cache = ConversationV2ProjectionCache();
      ThreadRunProjectionSnapshot build(
        List<ConversationV2Message> messages, {
        String epoch = 'epoch',
        int revision = 0,
      }) => buildConversationV2Projection(
        conversationId: 'thread',
        messages: messages,
        runs: const [],
        tools: const [],
        storeEpoch: epoch,
        historyRevision: revision,
        cache: cache,
      );

      final one = _message('one', 1);
      final two = _message('two', 2);
      final first = build([one, two]);
      // SQLite reloads construct new model instances, even for unchanged rows.
      final second = build([
        ConversationV2Message.fromJson(one.toJson()),
        two.copyWith(body: '追加内容', versionSeq: 3, contentVersion: 2),
      ]);
      expect(second.timeline.first, same(first.timeline.first));
      expect(second.timeline.last.text, '追加内容');
      expect(second.timeline.last, isNot(same(first.timeline.last)));

      final reset = build([one.copyWith(body: '重新导入')], epoch: 'new-epoch');
      expect(reset.timeline.single.text, '重新导入');
      expect(reset.timeline.single, isNot(same(first.timeline.first)));
      final rewritten = build([one], epoch: 'new-epoch', revision: 1);
      expect(rewritten.timeline.single.text, '内容 one');
      final deleted = build(
        [
          one.copyWith(
            versionSeq: 4,
            status: ConversationV2MessageStatus.deleted,
            isDeleted: true,
          ),
        ],
        epoch: 'new-epoch',
        revision: 1,
      );
      expect(deleted.timeline, isEmpty);
    },
  );

  test('same-version history target enrichment invalidates its cached row', () {
    final cache = ConversationV2ProjectionCache();
    final user = ConversationV2Message.fromJson({
      ..._message('user', 1).toJson(),
      'role': 'user',
    });
    ThreadRunProjectionSnapshot build(ConversationV2Message message) =>
        buildConversationV2Projection(
          conversationId: 'thread',
          messages: [message],
          runs: const [],
          tools: const [],
          cache: cache,
          storeEpoch: 'epoch',
        );
    final first = build(user);
    final enriched = build(
      user.copyWith(
        historyTarget: const ConversationV2HistoryTarget(
          activityLineId: 'activity',
          userMessageId: 'provider-user',
        ),
      ),
    );
    expect(enriched.timeline.single, isNot(same(first.timeline.single)));
    expect(enriched.timeline.single.metadata!['rewindTarget'], {
      'activityLineId': 'activity',
      'userMessageId': 'provider-user',
    });
  });

  test('a registry update moves cached narration into its agent card', () {
    final cache = ConversationV2ProjectionCache();
    final message = _message('owned', 1).copyWith(agentId: 'agent');
    ThreadRunProjectionSnapshot build(List<ConversationV2Agent> agents) =>
        buildConversationV2Projection(
          conversationId: 'thread',
          messages: [message],
          runs: const [],
          tools: const [],
          agents: agents,
          cache: cache,
          storeEpoch: 'epoch',
        );
    final orphaned = build(const []);
    expect(orphaned.timeline.single.scope, 'main');
    final registered = build(const [
      ConversationV2Agent(
        agentId: 'agent',
        conversationId: 'thread',
        role: 'coder',
        kind: 'subagent',
        status: 'completed',
        versionSeq: 2,
      ),
    ]);
    expect(registered.timeline, isEmpty);
    expect(registered.agents.single.timeline.single.scope, 'agent');
    expect(registered.agents.single.timeline.single.text, '内容 owned');
  });

  test(
    'display cache retains unchanged output and follows language changes',
    () {
      final projectionCache = ConversationV2ProjectionCache();
      final feedCache = ProjectionActivityFeedCache();
      final zh = AppLocalizationsZh();
      final en = AppLocalizationsEn();
      ThreadRunProjectionSnapshot build() => buildConversationV2Projection(
        conversationId: 'thread',
        messages: [_message('one', 1)],
        runs: const [],
        tools: const [
          ConversationV2Tool(
            toolCallId: 'tool',
            conversationId: 'thread',
            runId: 'run',
            name: 'Read',
            status: 'completed',
            createdSeq: 2,
            versionSeq: 2,
          ),
        ],
        cache: projectionCache,
        storeEpoch: 'epoch',
      );
      final first = buildActivityFeed(
        runProjection: build(),
        l10n: zh,
        groupTurns: false,
        groupActions: false,
        presentationCache: feedCache,
      );
      final repeated = buildActivityFeed(
        runProjection: build(),
        l10n: zh,
        groupTurns: false,
        groupActions: false,
        presentationCache: feedCache,
      );
      expect(repeated.first, same(first.first));
      final translated = buildActivityFeed(
        runProjection: build(),
        l10n: en,
        groupTurns: false,
        groupActions: false,
        presentationCache: feedCache,
      );
      expect(translated.first.text, repeated.first.text);
      expect(translated.last.text, isNot(repeated.last.text));
    },
  );
}
