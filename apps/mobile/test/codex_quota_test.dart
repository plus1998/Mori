import 'dart:async';

import 'package:eco_mobile/core/models/codex_account_models.dart';
import 'package:eco_mobile/core/models/thread_models.dart';
import 'package:eco_mobile/core/network/desktop_rpc.dart';
import 'package:eco_mobile/core/network/eco_center_client.dart';
import 'package:eco_mobile/core/storage/credential_store.dart';
import 'package:eco_mobile/features/threads/codex_quota_page.dart';
import 'package:eco_mobile/features/threads/codex_quota_provider.dart';
import 'package:eco_mobile/features/threads/thread_info_sheets.dart';
import 'package:eco_mobile/l10n/generated/app_localizations.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  CodexQuotaController controller(_Rpc rpc, {Map<String, String>? attempts}) {
    final c = CodexQuotaController(
      rpc: rpc,
      bindReady: () async => true,
      resetAttempts: attempts ?? {},
    );
    addTearDown(() {
      if (c.mounted) c.dispose();
    });
    return c;
  }

  test(
    'Codex RPC keeps identity, pending state and reset key on the wire',
    () async {
      final client = _WireClient();
      final rpc = DesktopRpc(client, 'desktop');
      client.result = [
        {
          'id': 'a',
          'name': 'Account',
          'isLoggedIn': true,
          'authState': 'configured',
          'quota': _quotaJson(),
        },
      ];
      expect((await rpc.listCodexAccounts()).single.id, 'a');
      expect(client.channel, 'openai-accounts:list');
      client.result = {
        'activeAccountId': 'a',
        'isLoggedIn': true,
        'pendingAccountId': null,
        'syncStatus': {'state': 'ok'},
      };
      expect((await rpc.getActiveCodexAccount()).hasPending, isTrue);
      expect(client.channel, 'openai-accounts:get-active');
      client.result = _quotaJson();
      expect(
        (await rpc.queryCodexAccountQuota('a')).windows.first.remaining,
        80,
      );
      expect(client.channel, 'openai-accounts:query-quota');
      expect(client.args, [
        {'accountId': 'a'},
      ]);
      client.result = {'success': true, 'pending': true};
      expect(await rpc.setActiveCodexAccount('b'), isTrue);
      expect(client.channel, 'openai-accounts:set-active');
      expect(client.args, [
        {'accountId': 'b'},
      ]);
      client.result = {'outcome': 'alreadyRedeemed'};
      expect(
        await rpc.resetCodexAccountQuota('a', 'reset-key'),
        'alreadyRedeemed',
      );
      expect(client.channel, 'openai-accounts:reset-quota');
      expect(client.args, [
        {'accountId': 'a', 'idempotencyKey': 'reset-key'},
      ]);
      client.result = {'outcome': 'unknown'};
      await expectLater(
        rpc.resetCodexAccountQuota('a', 'reset-key'),
        throwsFormatException,
      );
    },
  );

  test(
    'only Codex login conversations get account usage, not custom APIs or ACP',
    () {
      final login = ThreadRuntimeConfigInput.fromJson({
        'mainAgentModelOverride': {
          'providerId': 'openai',
          'modelId': 'gpt-6.1-sol',
        },
      });
      final api = ThreadRuntimeConfigInput.fromJson({
        'mainAgentModelOverride': {
          'providerId': 'custom',
          'modelId': 'gpt-6.1-sol',
        },
      });
      expect(usesCodexAccount(login, 'codex'), isTrue);
      expect(usesCodexAccount(login, 'acp'), isFalse);
      expect(usesCodexAccount(api, 'codex'), isFalse);
      expect(usesCodexAccount(login, 'claude'), isFalse);
    },
  );

  test(
    'saved account list has no usable quota if blocked, unknown, invalid or exhausted',
    () {
      expect(_account('a').available, isTrue);
      expect(_account('a', used: 100).available, isFalse);
      expect(_account('a', used: -1).available, isFalse);
      expect(_account('a', used: double.nan).available, isFalse);
      final unknown = CodexAccount.fromJson({
        'id': 'a',
        'name': 'A',
        'email': '',
        'isLoggedIn': true,
        'authState': 'configured',
      });
      expect(unknown.available, isFalse);
      expect(
        CodexAccountQuota.fromJson(
          _quotaJson()
            ..['rateLimit'] = {
              'allowed': false,
              'limitReached': true,
              'primaryWindow': null,
              'secondaryWindow': null,
            },
        ).available,
        isFalse,
      );
    },
  );

  test(
    'fresh quota and cached account signal do not create a refresh feedback loop',
    () async {
      final rpc = _Rpc();
      final c = controller(rpc);
      await c.refresh();
      expect(c.state.value!.account!.id, 'a');
      expect(rpc.queries, ['a']);
      await c.refresh(query: false);
      expect(rpc.queries, ['a']);
      expect(c.state.value!.candidates.map((a) => a.id), ['b', 'empty']);
    },
  );

  test(
    'quota result crossing an account switch is discarded then read for the new identity',
    () async {
      final rpc = _Rpc();
      final wait = Completer<CodexAccountQuota>();
      rpc.queryWait = wait;
      final c = controller(rpc);
      final first = c.refresh();
      await _until(() => rpc.queries.isNotEmpty);
      rpc.active = 'b';
      wait.complete(_quota(used: 99));
      await first;
      await _until(() => c.state.valueOrNull?.account?.id == 'b');
      expect(c.state.value!.account!.quota!.windows.first.remaining, 80);
      expect(rpc.queries, ['a', 'b']);
    },
  );

  test(
    'switch checks fresh quota and refuses an account that just exhausted',
    () async {
      final rpc = _Rpc();
      final c = controller(rpc);
      await c.refresh();
      rpc.usage['b'] = 100;
      await expectLater(
        c.switchAccount('b'),
        throwsA(isA<CodexQuotaFailure>()),
      );
      expect(rpc.switches, isEmpty);
      expect(c.state.value!.account!.id, 'a');
    },
  );

  test(
    'switch publishes pending state and blocks resets until confirmed',
    () async {
      final rpc = _Rpc()..deferSwitch = true;
      final c = controller(rpc);
      await c.refresh();
      await c.switchAccount('b');
      expect(c.state.value!.active.pendingId, 'b');
      await expectLater(c.reset(), throwsA(isA<CodexQuotaFailure>()));
      expect(rpc.resetKeys, isEmpty);
      rpc.active = 'b';
      rpc.pending = null;
      await c.refresh();
      expect(c.state.value!.account!.id, 'b');
      expect(c.state.value!.active.hasPending, isFalse);
    },
  );

  test(
    'uncertain reset keeps idempotency key even after reopening the sheet',
    () async {
      final rpc = _Rpc()..resetError = StateError('response lost');
      final attempts = <String, String>{};
      final first = CodexQuotaController(
        rpc: rpc,
        bindReady: () async => true,
        resetAttempts: attempts,
      );
      await first.refresh();
      await expectLater(first.reset(), throwsStateError);
      first.dispose();
      expect(attempts, hasLength(1));
      final second = controller(rpc, attempts: attempts);
      await second.refresh();
      rpc.resetError = null;
      expect(await second.reset(), 'reset');
      expect(rpc.resetKeys[0], rpc.resetKeys[1]);
      expect(attempts, isEmpty);
      expect(rpc.queries.length, greaterThanOrEqualTo(3));
    },
  );

  test(
    'disconnection and quota failure remain errors rather than zero quota',
    () async {
      final rpc = _Rpc()..queryError = StateError('quota API unavailable');
      final c = controller(rpc);
      await c.refresh();
      expect(c.state.hasError, isTrue);
      expect(c.state.valueOrNull, isNull);
      rpc.queryError = null;
      await c.refresh();
      expect(c.state.value!.account!.quota!.windows.first.remaining, 80);
    },
  );

  testWidgets(
    'quota tab matches card, switching list shows unknown and exhausted accounts',
    (tester) async {
      final rpc = _Rpc()..usage['b'] = 100;
      final c = controller(rpc);
      await c.refresh();
      await tester.pumpWidget(_app(c, const CodexQuotaPage()));
      expect(find.text('当前使用账号：账号 a'), findsOneWidget);
      expect(find.text('剩余 80%'), findsNWidgets(2));
      expect(find.text('5 小时额度'), findsOneWidget);
      expect(find.text('7 天额度'), findsOneWidget);
      expect(find.text('可用重置：1 次'), findsOneWidget);
      await tester.tap(find.text('切换账号'));
      await tester.pump();
      expect(find.text('账号 b'), findsOneWidget);
      expect(find.text('暂无可用额度'), findsOneWidget);
      expect(find.text('尚无额度数据，请先刷新'), findsOneWidget);
      await tester.tap(find.text('账号 b'));
      await tester.pump();
      expect(rpc.switches, isEmpty);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'reset is disabled without credits; reset result and refreshed quota are visible',
    (tester) async {
      final rpc = _Rpc()..credits = 0;
      final c = controller(rpc);
      await c.refresh();
      await tester.pumpWidget(_app(c, const CodexQuotaPage()));
      final button = find.widgetWithText(FilledButton, '使用重置');
      expect(tester.widget<FilledButton>(button).onPressed, isNull);
      rpc.credits = 1;
      await c.refresh();
      await tester.pump();
      await tester.ensureVisible(button);
      await tester.tap(button);
      await tester.pumpAndSettle();
      expect(rpc.resetKeys, hasLength(1));
      expect(find.text('额度已重置'), findsOneWidget);
    },
  );

  testWidgets(
    'context sheet keeps existing tabs and adds usage only when requested',
    (tester) async {
      tester.view.physicalSize = const Size(375, 812);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final c = controller(_Rpc());
      await c.refresh();
      Future<void> open(bool show) async {
        await tester.pumpWidget(
          _app(
            c,
            Builder(
              builder: (context) => TextButton(
                onPressed: () => showThreadContextSheet(
                  context: context,
                  contextSnapshot: null,
                  threadStatus: 'completed',
                  showCodexQuota: show,
                ),
                child: const Text('open'),
              ),
            ),
          ),
        );
        await tester.tap(find.text('open'));
        await tester.pumpAndSettle();
      }

      await open(false);
      expect(find.text('额度'), findsNothing);
      Navigator.of(tester.element(find.text('上下文'))).pop();
      await tester.pumpAndSettle();
      await open(true);
      expect(find.text('上下文'), findsOneWidget);
      expect(
        find.text(
          AppLocalizations.of(tester.element(find.text('上下文'))).billingTitle,
        ),
        findsOneWidget,
      );
      await tester.tap(find.text('额度'));
      await tester.pumpAndSettle();
      expect(find.text('当前使用账号：账号 a'), findsOneWidget);
      expect(tester.takeException(), isNull);
    },
  );
}

Widget _app(CodexQuotaController c, Widget child) => ProviderScope(
  overrides: [codexQuotaProvider.overrideWith((ref) => c)],
  child: MaterialApp(
    locale: const Locale('zh'),
    localizationsDelegates: AppLocalizations.localizationsDelegates,
    supportedLocales: AppLocalizations.supportedLocales,
    home: Scaffold(body: child),
  ),
);

Future<void> _until(bool Function() done) async {
  for (var i = 0; i < 50 && !done(); i++) {
    await Future<void>.delayed(Duration.zero);
  }
  expect(done(), isTrue);
}

Map<String, dynamic> _quotaJson({double used = 20, int credits = 1}) => {
  'planType': 'plus',
  'email': 'test@example.com',
  'resetCreditsAvailable': credits,
  'fetchedAt': 1792756800000,
  'rateLimit': {
    'allowed': true,
    'limitReached': false,
    'primaryWindow': {
      'usedPercent': used,
      'limitWindowSeconds': 18000,
      'resetAt': 1792774800,
      'resetAfterSeconds': 18000,
    },
    'secondaryWindow': {
      'usedPercent': used,
      'limitWindowSeconds': 604800,
      'resetAt': 1793361600,
      'resetAfterSeconds': 604800,
    },
  },
};
CodexAccountQuota _quota({double used = 20, int credits = 1}) =>
    CodexAccountQuota.fromJson(_quotaJson(used: used, credits: credits));
CodexAccount _account(String id, {double used = 20, int credits = 1}) =>
    CodexAccount(
      id: id,
      name: '账号 $id',
      email: '$id@example.com',
      isLoggedIn: true,
      authState: 'configured',
      quota: _quota(used: used, credits: credits),
    );

class _Rpc extends DesktopRpc {
  _Rpc() : super(EcoCenterClient(store: CredentialStore()), 'desktop');
  String active = 'a';
  String? pending;
  var deferSwitch = false;
  var credits = 1;
  final usage = <String, double>{};
  final queries = <String>[];
  final switches = <String>[];
  final resetKeys = <String>[];
  Object? resetError;
  Object? queryError;
  Completer<CodexAccountQuota>? queryWait;
  @override
  Future<CodexActiveAccount> getActiveCodexAccount() async =>
      CodexActiveAccount(
        id: active,
        isLoggedIn: true,
        syncState: 'ok',
        pendingId: pending,
        hasPending: pending != null,
      );
  @override
  Future<List<CodexAccount>> listCodexAccounts() async => [
    _account('a', used: usage['a'] ?? 20, credits: credits),
    _account('b', used: usage['b'] ?? 20, credits: credits),
    const CodexAccount(
      id: 'empty',
      name: '未查询账号',
      email: '',
      isLoggedIn: true,
      authState: 'configured',
    ),
  ];
  @override
  Future<CodexAccountQuota> queryCodexAccountQuota(String id) async {
    queries.add(id);
    if (queryError != null) throw queryError!;
    final wait = queryWait;
    queryWait = null;
    if (wait != null) return wait.future;
    return _quota(used: usage[id] ?? 20, credits: credits);
  }

  @override
  Future<bool> setActiveCodexAccount(String id) async {
    switches.add(id);
    if (deferSwitch) {
      pending = id;
    } else {
      active = id;
    }
    return deferSwitch;
  }

  @override
  Future<String> resetCodexAccountQuota(String id, String key) async {
    resetKeys.add(key);
    if (resetError != null) throw resetError!;
    return 'reset';
  }
}

class _WireClient extends EcoCenterClient {
  _WireClient() : super(store: CredentialStore());
  dynamic result;
  String? channel;
  List<dynamic>? args;
  @override
  Future<T> invoke<T>(
    String desktopDeviceId,
    String channel,
    List<dynamic> args, {
    int? deadlineMs,
  }) async {
    this.channel = channel;
    this.args = args;
    return result as T;
  }
}
