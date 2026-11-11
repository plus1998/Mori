import 'dart:async';
import 'package:eco_mobile/core/models/account_usage_models.dart';
import 'package:eco_mobile/core/models/conversation_actions.dart';
import 'package:eco_mobile/core/models/project_models.dart';
import 'package:eco_mobile/core/models/project_todo_models.dart';
import 'package:eco_mobile/core/models/scheduling_models.dart';
import 'package:eco_mobile/core/models/thread_models.dart';
import 'package:eco_mobile/core/models/thread_usage_models.dart';
import 'package:eco_mobile/core/network/desktop_rpc.dart';
import 'package:eco_mobile/core/network/eco_center_client.dart';
import 'package:eco_mobile/core/storage/credential_store.dart';
import 'package:eco_mobile/core/theme/eco_theme.dart';
import 'package:eco_mobile/core/utils/composer_references.dart';
import 'package:eco_mobile/core/utils/thread_usage_display.dart';
import 'package:eco_mobile/core/widgets/eco_markdown.dart';
import 'package:eco_mobile/features/threads/activity_feed.dart';
import 'package:eco_mobile/features/threads/thread_search_sheet.dart';
import 'package:eco_mobile/features/threads/thread_menu_sheets.dart';
import 'package:eco_mobile/core/providers/app_providers.dart';
import 'package:eco_mobile/features/threads/conversation_action_sheets.dart';
import 'package:eco_mobile/features/settings/settings_usage_page.dart';
import 'package:eco_mobile/features/threads/thread_providers.dart'
    show desktopRpcProvider;
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:eco_mobile/l10n/generated/app_localizations.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_markdown/flutter_markdown.dart';
import 'package:flutter_test/flutter_test.dart';

Widget app(Widget child) => MaterialApp(
  theme: buildEcoLightTheme(),
  localizationsDelegates: AppLocalizations.localizationsDelegates,
  supportedLocales: AppLocalizations.supportedLocales,
  locale: const Locale('en'),
  home: Scaffold(body: child),
);

final totals = <String, dynamic>{
  'inputTokens': 10,
  'outputTokens': 20,
  'cacheReadTokens': 2,
  'cacheCreationTokens': 3,
  'reasoningTokens': 8,
  'totalTokens': 35,
  'records': 1,
  'estimatedCostUsd': 0.0012,
  'unpricedRecords': 0,
};
Map<String, dynamic> overview() => {
  'totals': totals,
  'rows': <dynamic>[],
  'dimensions': [
    {
      'providerKey': 'provider:old',
      'providerName': 'Deleted provider',
      'modelId': 'model',
    },
  ],
  'timeZone': 'Asia/Shanghai',
  'startAt': 100,
  'endAt': 200,
  'trackingStartedAt': 1,
  'recordingFailures': 2,
};

class Client extends EcoCenterClient {
  Client() : super(store: CredentialStore());
  final calls = <({String channel, List<dynamic> args, int? deadline})>[];
  Object? response;
  Object? Function(String, List<dynamic>)? respond;
  @override
  Future<T> invoke<T>(
    String desktopDeviceId,
    String channel,
    List<dynamic> args, {
    int? deadlineMs,
  }) async {
    calls.add((channel: channel, args: args, deadline: deadlineMs));
    return (respond == null ? response : respond!(channel, args)) as T;
  }
}

void main({Future<void> Function(WidgetTester, String)? enterSearchText}) {
  test('failed context counts remain an error rather than zero occupancy', () {
    final context = ThreadContextSnapshot.fromJson({
      'occupied': 0,
      'limit': 200000,
      'limitsResolved': true,
      'occupancyPct': 0,
      'error': 'Tokenizer failed',
    });
    expect(context.error, 'Tokenizer failed');
    expect(resolvePlannerOccupancyPct(context), isNull);
  });
  test(
    'usage preserves server totals, unpriced counts and historical dimensions',
    () {
      final data = UsageOverview.fromJson(overview());
      expect(
        data.totals.totalTokens,
        35,
      ); // Reasoning is already included in output.
      expect(data.totals.reasoningTokens, 8);
      expect(data.dimensions.single.providerName, 'Deleted provider');
      expect(data.recordingFailures, 2);
      final history = AccountUsageHistory.fromJson({
        'totals': totals,
        'buckets': [
          {...totals, 'startAt': 100, 'endAt': 200},
        ],
        'nextBefore': 100,
        'trackingStartedAt': 1,
        'firstUsageAt': 10,
        'timeZone': 'Asia/Shanghai',
        'recordingFailure': {
          'count': 2,
          'lastError': 'DB full',
          'lastErrorAt': 12,
        },
      });
      expect(history.buckets.single.totals.estimatedCostUsd, .0012);
      expect(history.nextBefore, 100);
      expect(history.recordingFailure!['lastError'], 'DB full');
    },
  );
  test(
    'usage and share RPC retain filtering, pagination and publish timeout',
    () async {
      final client = Client();
      final rpc = DesktopRpc(client, 'pc');
      client.response = overview();
      await rpc.usageOverview(
        period: 'month',
        at: 100,
        providerKey: 'provider:old',
        modelId: 'model',
      );
      expect(client.calls.last.args.single, {
        'period': 'month',
        'at': 100,
        'providerKey': 'provider:old',
        'modelId': 'model',
      });
      await rpc.usageOverview(period: 'all');
      expect(client.calls.last.args.single, {'period': 'all'});
      client.response = {
        'totals': totals,
        'buckets': [],
        'trackingStartedAt': 1,
        'timeZone': 'UTC',
      };
      await rpc.accountUsageHistory(
        kind: 'chatgpt_login',
        accountId: 'a',
        period: '5h',
        before: 100,
      );
      expect(client.calls.last.channel, 'account-usage:history');
      expect(client.calls.last.args.single, {
        'kind': 'chatgpt_login',
        'accountId': 'a',
        'period': '5h',
        'before': 100,
      });
      client.response = {
        'publicUrl': 'https://example.com/share',
        'expiresAt': '2026-12-01T00:00:00Z',
      };
      final share = await rpc.shareConversation('thr');
      expect(share.url, 'https://example.com/share');
      expect(client.calls.last.deadline, 240000);
      client.response = null;
      await rpc.deleteImageDisplayArtifact('media');
      expect(client.calls.last.channel, 'image-display-artifact:delete');
      expect(client.calls.last.args.single, {'artifactId': 'media'});
    },
  );
  test(
    'todo parsing keeps draft and sent-message destinations without writing history',
    () {
      final todo = ProjectTodo.fromJson({
        'id': 'todo',
        'revision': 1,
        'projectPath': '/repo',
        'text': 'Fix',
        'images': [],
        'completed': false,
        'status': 'in_progress',
        'createdAt': '',
        'updatedAt': '',
        'composedAt': '2026-11-11T00:00:00Z',
        'handoffs': [
          {'contextKey': 'landing:/repo', 'composedAt': '2026-11-10T00:00:00Z'},
          {
            'contextKey': 'thread:thr',
            'threadId': 'thr',
            'messageId': 'msg',
            'composedAt': '2026-11-11T00:00:00Z',
          },
        ],
      });
      expect(todo.handoffs.first.messageId, isNull);
      expect(todo.handoffs.last.messageId, 'msg');
      expect(todo.toSaveJson().containsKey('handoffs'), isFalse);
    },
  );
  test(
    'pinyin uses full spelling, initials and punctuation folding with two-letter minimum',
    () {
      for (final query in ['hui hua', 'HH-CD', 'hui_hua', 'hui.hua']) {
        expect(matchesProjectPinyin(query, ['huihuacundang', 'hhcd']), isTrue);
      }
      expect(matchesProjectPinyin('h', ['huihuacundang']), isFalse);
    },
  );
  test(
    'share and link models reject invalid data and preserve deleted destinations',
    () {
      expect(
        () => ConversationShare.fromJson({
          'publicUrl': 'file:///tmp/a',
          'expiresAt': '2026-11-11',
        }),
        throwsFormatException,
      );
      final link = PlanExecutionLink.fromJson({
        'id': 'link',
        'version': 2,
        'planTitle': 'Plan',
        'sourceThreadId': 'source',
        'sourceTitle': 'Source',
        'sourceDeleted': false,
        'executionThreadId': 'run',
        'executionTitle': 'Run',
        'executionDeleted': true,
        'status': 'interrupted',
        'message': 'Restarted',
      });
      expect(link.executionDeleted, isTrue);
      expect(link.status, 'interrupted');
    },
  );
  testWidgets(
    'user Markdown keeps emphasis, links, code and embedded reference chips',
    (tester) async {
      final ref = composerReferenceToken(
        kind: 'todo',
        id: 'todo',
        label: 'Fix app',
        detail: '/repo',
      );
      await tester.pumpWidget(
        app(
          EcoMarkdown(
            text: '**Hello** $ref [site](https://example.com)\n\n`literal`',
            composerReferences: true,
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
      expect(find.text('@Fix app'), findsOneWidget);
      expect(find.textContaining('Hello', findRichText: true), findsOneWidget);
      expect(find.byType(MarkdownBody), findsOneWidget);
    },
  );
  testWidgets('Markdown table cells retain reference chips', (tester) async {
    final token = composerReferenceToken(
      kind: 'todo',
      id: 'todo',
      label: 'Table todo',
      detail: '',
    );
    await tester.pumpWidget(
      app(
        EcoMarkdown(
          text: '| Task | Status |\n| --- | --- |\n| $token | Open |',
          composerReferences: true,
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('@Table todo'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
  testWidgets('ordered list numbers stay on one line with large text', (
    tester,
  ) async {
    await tester.pumpWidget(
      app(
        Builder(
          builder: (context) => MediaQuery(
            data: MediaQuery.of(
              context,
            ).copyWith(textScaler: const TextScaler.linear(1.65)),
            child: const EcoMarkdown(
              text: '8. Eighth step\n9. Ninth step\n10. Tenth step',
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    for (final marker in ['8.', '9.', '10.']) {
      final paragraph = tester.renderObject<RenderParagraph>(
        find.descendant(of: find.text(marker), matching: find.byType(RichText)),
      );
      final boxes = paragraph.getBoxesForSelection(
        TextSelection(baseOffset: 0, extentOffset: marker.length),
      );
      expect(boxes, isNotEmpty);
      expect(
        boxes.map((box) => box.top).toSet(),
        hasLength(1),
        reason: 'The number and period in $marker must share one line.',
      );
    }
    expect(tester.takeException(), isNull);
  });
  testWidgets('user tables render as Markdown without other markup', (
    tester,
  ) async {
    final controller = ScrollController();
    addTearDown(controller.dispose);
    await tester.pumpWidget(
      app(
        ActivityFeedList(
          entries: const [
            ActivityFeedEntry(
              id: 'table',
              kind: ActivityFeedKind.user,
              text: '| Task | Status |\n| --- | --- |\n| Build | Open |',
            ),
          ],
          scrollController: controller,
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.byType(EcoMarkdown), findsOneWidget);
    expect(find.text('Build'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
  testWidgets(
    'user bubble renders Markdown while preserving copy and fork actions',
    (tester) async {
      final controller = ScrollController();
      addTearDown(controller.dispose);
      var calls = 0;
      final ids = <String>[];
      final ref = composerReferenceToken(
        kind: 'plan',
        id: 'plan',
        label: 'Plan',
        detail: '',
      );
      await tester.pumpWidget(
        app(
          ActivityFeedList(
            entries: [
              ActivityFeedEntry(
                id: 'msg',
                kind: ActivityFeedKind.user,
                text: '**bold** $ref',
                rewindTarget: const ThreadActivityRewindTarget(
                  activityLineId: 'line',
                ),
                historyRevision: 3,
              ),
            ],
            scrollController: controller,
            onForkUserMessage: (target, id) async {
              calls++;
              ids.add(id);
              if (calls == 1) throw StateError('Offline');
            },
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
      expect(find.byType(EcoMarkdown), findsOneWidget);
      expect(find.text('@Plan'), findsOneWidget);
      for (var attempt = 0; attempt < 2; attempt++) {
        if (find.byType(SnackBar).evaluate().isNotEmpty) {
          ScaffoldMessenger.of(
            tester.element(find.byType(ActivityFeedList)),
          ).clearSnackBars();
          await tester.pumpAndSettle();
        }
        await tester.tap(find.byTooltip('Fork conversation'));
        await tester.pumpAndSettle();
        await tester.tap(
          find.widgetWithText(FilledButton, 'Fork conversation'),
        );
        await tester.pumpAndSettle();
      }
      expect(calls, 2);
      expect(
        ids.first,
        ids.last,
        reason: 'lost-response retries keep one command identity',
      );
    },
  );
  testWidgets(
    'history navigation loads older messages and locates a virtualized row',
    (tester) async {
      final controller = ScrollController();
      addTearDown(controller.dispose);
      var loaded = false;
      await tester.pumpWidget(
        app(
          StatefulBuilder(
            builder: (context, setState) => ActivityFeedList(
              targetMessageId: 'old',
              scrollController: controller,
              hasEarlier: !loaded,
              onLoadEarlier: () async {
                setState(() => loaded = true);
              },
              entries: [
                if (loaded)
                  ActivityFeedEntry(
                    id: 'old',
                    kind: ActivityFeedKind.user,
                    text: 'Target original message',
                  ),
                for (var i = 0; i < 50; i++)
                  ActivityFeedEntry(
                    id: 'm$i',
                    kind: ActivityFeedKind.user,
                    text: 'Recent message $i',
                  ),
              ],
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(loaded, isTrue);
      expect(find.text('Target original message'), findsOneWidget);
      expect(controller.offset, greaterThan(0));
      expect(tester.takeException(), isNull);
    },
  );
  testWidgets(
    'missing original message displays an explicit navigation error',
    (tester) async {
      final controller = ScrollController();
      addTearDown(controller.dispose);
      await tester.pumpWidget(
        app(
          ActivityFeedList(
            targetMessageId: 'missing',
            scrollController: controller,
            entries: [
              ActivityFeedEntry(
                id: 'latest',
                kind: ActivityFeedKind.user,
                text: 'Latest',
              ),
            ],
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.textContaining('original message'), findsOneWidget);
    },
  );
  testWidgets(
    'search includes scheduled prompt text and pinyin project results',
    (tester) async {
      await tester.pumpWidget(
        app(
          Builder(
            builder: (context) => TextButton(
              onPressed: () => showThreadSearchSheet(
                context: context,
                threads: const [],
                projects: const [EcoProject(path: '/repo', name: '会话存档')],
                loadProjectTerms: () async => {
                  '/repo': ['huihuacundang', 'hhcd'],
                },
                loadSchedules: () async => [
                  ScheduleDefinition.fromJson({
                    'id': 'schedule',
                    'kind': 'session_message',
                    'name': 'Tomorrow',
                    'prompt': 'Review releases',
                    'trigger': {'type': 'at', 'at': '2026-12-01T00:00:00Z'},
                    'enabled': true,
                    'revision': 1,
                    'maxLatenessSeconds': 60,
                  }),
                ],
              ),
              child: const Text('Search'),
            ),
          ),
        ),
      );
      await tester.tap(find.text('Search'));
      await tester.pumpAndSettle();
      await (enterSearchText?.call(tester, 'hhcd') ??
          tester.enterText(find.byType(TextField), 'hhcd'));
      await tester.pumpAndSettle();
      expect(find.text('会话存档'), findsOneWidget);
      await (enterSearchText?.call(tester, 'releases') ??
          tester.enterText(find.byType(TextField), 'releases'));
      await tester.pumpAndSettle();
      expect(find.text('Tomorrow'), findsOneWidget);
    },
  );
  testWidgets(
    'share waits for explicit publish and retains a retryable service error',
    (tester) async {
      final client = Client();
      var failed = true;
      client.respond = (channel, args) {
        if (failed) throw StateError('Sharing unavailable');
        return {
          'publicUrl': 'https://example.com/snapshot',
          'expiresAt': '2026-12-01T00:00:00Z',
        };
      };
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            desktopRpcProvider.overrideWithValue(DesktopRpc(client, 'pc')),
          ],
          child: app(
            Builder(
              builder: (context) => TextButton(
                onPressed: () => showConversationShare(context, 'thr'),
                child: const Text('Share'),
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.text('Share'));
      await tester.pumpAndSettle();
      expect(client.calls, isEmpty);
      await tester.tap(find.widgetWithText(FilledButton, 'Create share link'));
      await tester.pumpAndSettle();
      expect(find.textContaining('Sharing unavailable'), findsOneWidget);
      failed = false;
      await tester.tap(find.widgetWithText(FilledButton, 'Create share link'));
      await tester.pumpAndSettle();
      expect(find.text('https://example.com/snapshot'), findsOneWidget);
      expect(find.text('Copy link'), findsOneWidget);
      expect(find.text('Preview share'), findsOneWidget);
    },
  );
  testWidgets('plan links show outcome and disable deleted destinations', (
    tester,
  ) async {
    final link = PlanExecutionLink.fromJson({
      'id': 'link',
      'version': 2,
      'planTitle': 'Plan',
      'sourceThreadId': 'source',
      'sourceTitle': 'Source',
      'sourceDeleted': false,
      'executionThreadId': 'run',
      'executionTitle': 'Run',
      'executionDeleted': true,
      'status': 'interrupted',
      'message': 'Restarted',
    });
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          planExecutionLinksProvider(
            'source',
          ).overrideWith((ref) async => [link]),
        ],
        child: app(
          Builder(
            builder: (context) => TextButton(
              onPressed: () => showPlanExecutionLinks(context, 'source'),
              child: const Text('Links'),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('Links'));
    await tester.pumpAndSettle();
    final tile = tester.widget<ListTile>(find.byType(ListTile));
    expect(tile.enabled, isFalse);
    expect(find.textContaining('Interrupted'), findsOneWidget);
    expect(find.textContaining('Restarted'), findsOneWidget);
  });
  testWidgets(
    'usage filters server windows and surfaces unpriced records and recording failures',
    (tester) async {
      final client = Client();
      client.respond = (channel, args) {
        if (channel == 'usage:overview') {
          return {
            ...overview(),
            'totals': {...totals, 'unpricedRecords': 1},
          };
        }
        if (channel == 'openai-accounts:list' ||
            channel == 'chatgpt-subscription:accounts-list') {
          return <dynamic>[];
        }
        throw StateError('Unexpected channel: $channel');
      };
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            desktopRpcProvider.overrideWithValue(DesktopRpc(client, 'pc')),
          ],
          child: app(const SettingsUsagePage()),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.textContaining('Unpriced records'), findsOneWidget);
      expect(find.text('—'), findsOneWidget);
      await tester.drag(find.byType(ListView).first, const Offset(0, -400));
      await tester.pumpAndSettle();
      expect(find.textContaining('Recording failures: 2'), findsOneWidget);
      await tester.drag(find.byType(ListView).first, const Offset(0, 600));
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(ChoiceChip, 'Month'));
      await tester.pumpAndSettle();
      expect((client.calls.last.args.single as Map)['period'], 'month');
      await tester.tap(find.byTooltip('Previous period'));
      await tester.pumpAndSettle();
      expect((client.calls.last.args.single as Map)['at'], 99);
      client.respond = (channel, args) =>
          throw StateError('Usage DB unavailable');
      await tester.tap(find.byTooltip('Retry'));
      await tester.pumpAndSettle();
      expect(find.textContaining('Usage DB unavailable'), findsOneWidget);
      expect(find.text('—'), findsNothing);
    },
  );
  testWidgets('search keeps source failures visible and retries them', (
    tester,
  ) async {
    var fail = true;
    await tester.pumpWidget(
      app(
        Builder(
          builder: (context) => TextButton(
            onPressed: () => showThreadSearchSheet(
              context: context,
              threads: const [],
              projects: const [],
              loadSchedules: () async {
                if (fail) throw StateError('Schedule list unavailable');
                return [];
              },
              loadProjectTerms: () async {
                if (fail) throw StateError('Pinyin service unavailable');
                return {};
              },
            ),
            child: const Text('Search'),
          ),
        ),
      ),
    );
    await tester.tap(find.text('Search'));
    await tester.pumpAndSettle();
    expect(find.textContaining('Schedule list unavailable'), findsOneWidget);
    expect(find.textContaining('Pinyin service unavailable'), findsOneWidget);
    fail = false;
    await tester.tap(find.text('Retry').first);
    await tester.pumpAndSettle();
    expect(find.textContaining('Schedule list unavailable'), findsNothing);
    expect(find.textContaining('Pinyin service unavailable'), findsOneWidget);
  });
  for (final generated in [true, false]) {
    testWidgets(
      'artifact history reports errors and retries: generated=$generated',
      (tester) async {
        final client = Client();
        var fail = true;
        client.respond = (channel, args) {
          if (fail) throw StateError('History unavailable');
          return [
            generated
                ? {
                    'id': 'artifact',
                    'threadId': 'thread',
                    'prompt': 'Generated prompt',
                  }
                : {
                    'id': 'artifact',
                    'threadId': 'thread',
                    'title': 'Published page',
                    'publicUrl': 'https://example.com',
                  },
          ];
        };
        await tester.pumpWidget(
          ProviderScope(
            overrides: [
              desktopRpcProvider.overrideWithValue(DesktopRpc(client, 'pc')),
            ],
            child: app(
              Consumer(
                builder: (context, ref, _) => TextButton(
                  onPressed: () => generated
                      ? showImageGenerationArtifactsSheet(
                          context: context,
                          ref: ref,
                          threadId: 'thread',
                        )
                      : showHtmlHostArtifactsSheet(
                          context: context,
                          ref: ref,
                          threadId: 'thread',
                        ),
                  child: const Text('History'),
                ),
              ),
            ),
          ),
        );
        await tester.tap(find.text('History'));
        await tester.pumpAndSettle();
        expect(find.textContaining('History unavailable'), findsOneWidget);
        fail = false;
        await tester.tap(find.text('Retry'));
        await tester.pumpAndSettle();
        expect(
          find.text(generated ? 'Generated prompt' : 'Published page'),
          findsOneWidget,
        );
      },
    );
  }
  testWidgets(
    'rejected WeChat setup keeps the previous preference and shows the reason',
    (tester) async {
      final client = Client();
      client.respond = (channel, args) {
        if (channel == 'thread:get') {
          return {
            'id': 'thread',
            'title': 'Thread',
            'prompt': '',
            'workspacePath': '/repo',
            'status': 'idle',
            'message': '',
            'createdAt': '',
            'updatedAt': '',
            'wechatFollowEnabled': false,
          };
        }
        if (channel == 'thread:wechat-follow') {
          throw StateError('Connect WeChat first');
        }
        throw StateError('Unexpected channel: $channel');
      };
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            desktopRpcProvider.overrideWithValue(DesktopRpc(client, 'pc')),
            ecoEventsProvider.overrideWith((ref) => const Stream.empty()),
          ],
          child: app(
            Builder(
              builder: (context) => TextButton(
                onPressed: () =>
                    showWechatCompletionSettings(context, 'thread'),
                child: const Text('WeChat'),
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.text('WeChat'));
      await tester.pumpAndSettle();
      expect(
        tester.widget<SwitchListTile>(find.byType(SwitchListTile)).value,
        isFalse,
      );
      await tester.tap(find.byType(SwitchListTile));
      await tester.pumpAndSettle();
      expect(find.textContaining('Connect WeChat first'), findsOneWidget);
      expect(
        tester.widget<SwitchListTile>(find.byType(SwitchListTile)).value,
        isFalse,
      );
    },
  );
  testWidgets(
    'account history retries an older page with the same exclusive cursor',
    (tester) async {
      final client = Client();
      var failOlder = true;
      client.respond = (channel, args) {
        if (channel == 'usage:overview') return overview();
        if (channel == 'openai-accounts:list') {
          return [
            {
              'id': 'a',
              'name': 'My account',
              'email': '',
              'isLoggedIn': true,
              'authState': 'configured',
            },
          ];
        }
        if (channel == 'chatgpt-subscription:accounts-list') return <dynamic>[];
        if (channel == 'account-usage:history') {
          final older = (args.single as Map)['before'] != null;
          if (older && failOlder) throw StateError('Older page unavailable');
          return {
            'totals': totals,
            'buckets': [
              {
                ...totals,
                'startAt': older ? 0 : 100,
                'endAt': older ? 100 : 200,
              },
            ],
            if (!older) 'nextBefore': 100,
            'trackingStartedAt': 1,
            'timeZone': 'UTC',
          };
        }
        throw StateError('Unexpected channel: $channel');
      };
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            desktopRpcProvider.overrideWithValue(DesktopRpc(client, 'pc')),
          ],
          child: app(const SettingsUsagePage()),
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.text('Account usage history'));
      await tester.pumpAndSettle();
      final list = find.byType(ListView).last;
      await tester.drag(list, const Offset(0, -700));
      await tester.pumpAndSettle();
      expect(find.text('Load older records'), findsOneWidget);
      await tester.tap(find.text('Load older records'));
      await tester.pumpAndSettle();
      expect(find.textContaining('Older page unavailable'), findsOneWidget);
      failOlder = false;
      // Pagination errors and their retry action stay beside the older-page
      // control, including on narrow screens with accessibility text sizes.
      await tester.ensureVisible(find.text('Retry'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Retry'));
      await tester.pumpAndSettle();
      final requests = client.calls
          .where((c) => c.channel == 'account-usage:history')
          .toList();
      expect(requests.length, 3);
      expect((requests[1].args.single as Map)['before'], 100);
      expect((requests[2].args.single as Map)['before'], 100);
      expect(find.textContaining('Older page unavailable'), findsNothing);
      expect(find.text('Load older records'), findsNothing);
    },
  );
}
