import 'package:eco_mobile/core/models/codex_account_models.dart';
import 'package:eco_mobile/core/models/thread_models.dart';
import 'package:eco_mobile/core/network/desktop_rpc.dart';
import 'package:eco_mobile/core/network/eco_center_client.dart';
import 'package:eco_mobile/core/storage/credential_store.dart';
import 'package:eco_mobile/features/composer/composer_main_model_picker.dart';
import 'package:eco_mobile/features/threads/thread_providers.dart';
import 'package:eco_mobile/l10n/generated/app_localizations.dart';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

class _AccountsRpc extends DesktopRpc {
  _AccountsRpc() : super(EcoCenterClient(store: CredentialStore()), 'desktop');
  final oauthRequests = <String>[];
  @override
  Future<List<CodexAccount>> listCodexAccounts() async => [
    for (final id in ['A', 'B'])
      CodexAccount(
        id: id,
        name: 'Login $id',
        email: '',
        isLoggedIn: true,
        authState: 'configured',
      ),
  ];
  @override
  Future<List<Map<String, dynamic>>> listChatGptOauthAccounts() async => [
    for (final id in ['A', 'B'])
      {
        'accountId': 'oauth-$id',
        'displayName': 'OAuth $id',
        'enabled': true,
        'hasCredentials': true,
      },
  ];
  @override
  Future<List<Map<String, dynamic>>> listCodexAccountModels() async => [
    {
      'modelId': 'gpt-test',
      'displayName': 'GPT Test',
      'reasoningEfforts': ['low', 'medium', 'high'],
    },
  ];
  @override
  Future<List<Map<String, dynamic>>> listChatGptOauthAccountModels(
    String accountId,
  ) async {
    oauthRequests.add(accountId);
    return [
      {'id': 'gpt-test', 'displayName': 'GPT Test'},
    ];
  }
}

Future<void> _open(
  WidgetTester tester,
  _AccountsRpc rpc,
  List<OrchestrationModelRef> changes, {
  Size size = const Size(375, 812),
  double textScale = 1,
  OrchestrationModelRef? selected,
}) async {
  tester.view.physicalSize = size;
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        desktopRpcProvider.overrideWithValue(rpc),
        auxiliaryModelOptionsProvider('').overrideWith((ref) async => []),
      ],
      child: MaterialApp(
        locale: const Locale('en'),
        supportedLocales: AppLocalizations.supportedLocales,
        localizationsDelegates: const [
          AppLocalizations.delegate,
          GlobalMaterialLocalizations.delegate,
          GlobalWidgetsLocalizations.delegate,
          GlobalCupertinoLocalizations.delegate,
        ],
        builder: (context, child) => MediaQuery(
          data: MediaQuery.of(
            context,
          ).copyWith(textScaler: TextScaler.linear(textScale)),
          child: child!,
        ),
        home: Scaffold(
          body: Builder(
            builder: (context) => TextButton(
              onPressed: () => showComposerMainModelPickerSheet(
                context,
                selectedModel: selected,
                coreKind: 'codex',
                onSelected: changes.add,
              ),
              child: const Text('Open'),
            ),
          ),
        ),
      ),
    ),
  );
  await tester.tap(find.text('Open'));
  await tester.pumpAndSettle();
}

void main() {
  testWidgets(
    'Login requires an explicit account and saves the model with low effort immediately',
    (tester) async {
      final rpc = _AccountsRpc();
      final changes = <OrchestrationModelRef>[];
      await _open(tester, rpc, changes);
      expect(find.byType(Slider), findsOneWidget);
      expect(find.text('GPT Test'), findsNothing);
      expect(changes, isEmpty);
      await tester.tap(find.text('Login B'));
      await tester.pumpAndSettle();
      expect(changes, isEmpty);
      await tester.tap(find.text('GPT Test'));
      await tester.pumpAndSettle();
      expect(changes.single.toJson(), containsPair('accountId', 'B'));
      expect(changes.single.thinkingEffort, 'low');
      expect(find.text('Done'), findsNothing);
      expect(find.byType(Slider), findsOneWidget);
      final slider = tester.widget<Slider>(find.byType(Slider));
      slider.onChanged!(2);
      slider.onChangeEnd!(2);
      await tester.pumpAndSettle();
      expect(changes.last.accountId, 'B');
      expect(changes.last.thinkingEffort, 'high');
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('OAuth loads the chosen account catalog and saves its identity', (
    tester,
  ) async {
    final rpc = _AccountsRpc();
    final changes = <OrchestrationModelRef>[];
    await _open(tester, rpc, changes);
    await tester.tap(find.text('ChatGPT OAuth'));
    await tester.pumpAndSettle();
    expect(find.byType(Slider), findsOneWidget);
    expect(rpc.oauthRequests, isEmpty);
    await tester.tap(find.text('OAuth B'));
    await tester.pumpAndSettle();
    expect(rpc.oauthRequests, ['oauth-B']);
    await tester.tap(find.text('GPT Test'));
    await tester.pumpAndSettle();
    expect(changes.single.providerId, 'eco-coding-chatgpt');
    expect(changes.single.accountId, 'oauth-B');
    expect(changes.single.thinkingEffort, 'low');
    expect(tester.takeException(), isNull);
  });

  testWidgets(
    'narrow screen, larger text and keyboard keep the effort slider visible',
    (tester) async {
      final rpc = _AccountsRpc();
      await _open(tester, rpc, [], textScale: 1.4);
      tester.view.viewInsets = const FakeViewPadding(bottom: 300);
      addTearDown(tester.view.resetViewInsets);
      await tester.tap(find.byType(TextField));
      await tester.pumpAndSettle();
      expect(find.byType(Slider), findsOneWidget);
      expect(
        tester.getBottomRight(find.byType(Slider)).dy,
        lessThanOrEqualTo(512),
      );
      expect(tester.takeException(), isNull);
    },
  );
}
