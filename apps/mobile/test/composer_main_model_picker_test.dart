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
  _AccountsRpc({this.catalogFailure})
    : super(EcoCenterClient(store: CredentialStore()), 'desktop');
  final String? catalogFailure;
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
  Future<List<Map<String, dynamic>>> listCodexAccountModels() async {
    if (catalogFailure case final failure?) throw StateError(failure);
    return [
      {
        'modelId': 'gpt-test',
        'displayName': 'GPT Test',
        'reasoningEfforts': ['low', 'medium', 'high'],
      },
    ];
  }

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
      await tester.drag(find.byType(Slider), const Offset(260, 0));
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

  testWidgets('search clear button resets the query and restores models', (
    tester,
  ) async {
    final rpc = _AccountsRpc();
    await _open(tester, rpc, []);
    await tester.tap(find.text('Login A'));
    await tester.pumpAndSettle();
    expect(find.text('GPT Test'), findsOneWidget);

    await tester.enterText(find.byType(TextField), 'no matching model');
    await tester.pumpAndSettle();
    expect(find.text('GPT Test'), findsNothing);
    await tester.tap(find.byTooltip('Clear text'));
    await tester.pumpAndSettle();

    expect(
      tester.widget<TextField>(find.byType(TextField)).controller!.text,
      '',
    );
    expect(find.text('GPT Test'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets(
    'narrow screen, larger text and keyboard keep the effort slider visible',
    (tester) async {
      final rpc = _AccountsRpc();
      await _open(tester, rpc, [], size: const Size(320, 640), textScale: 1.4);
      tester.view.viewInsets = const FakeViewPadding(bottom: 220);
      addTearDown(tester.view.resetViewInsets);
      await tester.tap(find.byType(TextField));
      await tester.pumpAndSettle();
      expect(find.byType(Slider), findsOneWidget);
      expect(
        tester.getBottomRight(find.byType(Slider)).dy,
        lessThanOrEqualTo(420),
      );
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('catalog errors stay visible and never show a fallback model', (
    tester,
  ) async {
    final rpc = _AccountsRpc(catalogFailure: 'catalog unavailable');
    await _open(tester, rpc, []);
    expect(find.textContaining('catalog unavailable'), findsOneWidget);
    expect(find.text('GPT Test'), findsNothing);
    expect(tester.takeException(), isNull);
  });
}
