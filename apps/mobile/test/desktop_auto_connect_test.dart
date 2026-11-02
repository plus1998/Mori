import 'dart:async';

import 'package:eco_mobile/app.dart';
import 'package:eco_mobile/core/providers/app_providers.dart';
import 'package:eco_mobile/core/providers/desktop_auto_connect_provider.dart';
import 'package:eco_mobile/core/storage/credential_store.dart';
import 'package:eco_mobile/core/utils/center_server_auth.dart';
import 'package:eco_mobile/features/home/setup_status.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

const _credentials = AppCredentials(
  supabaseUrl: 'https://center.example.com',
  anonKey: 'public-key',
  userId: 'user_a',
  userEmail: 'a@example.com',
  userRefreshToken: 'refresh-token',
  deviceId: 'mobile_a',
  deviceSecret: 'device-secret',
  selectedDesktopId: 'desktop_a',
);

const _enabled = DesktopAutoConnectPreference(enabled: true);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() => SharedPreferences.setMockInitialValues({}));

  test('default launch shows PC picker even with a saved desktop', () async {
    final prefs = await SharedPreferences.getInstance();
    final preference = DesktopAutoConnectPreference.read(prefs);
    expect(preference.enabled, isFalse);
    expect(preference.launchLocation(_credentials, 'desktop_a'), '/connect');
  });

  test(
    'auto-connect switch survives restart; disabling restores picker',
    () async {
      final container = ProviderContainer();
      addTearDown(container.dispose);
      final notifier = container.read(
        desktopAutoConnectPreferenceProvider.notifier,
      );
      await notifier.setEnabled(true);

      final prefs = await SharedPreferences.getInstance();
      final restored = DesktopAutoConnectPreference.read(prefs);
      expect(restored.launchLocation(_credentials, 'desktop_a'), '/threads');

      final restarted = ProviderContainer(
        overrides: [
          desktopAutoConnectBootstrapProvider.overrideWithValue(restored),
        ],
      );
      addTearDown(restarted.dispose);
      await restarted
          .read(desktopAutoConnectPreferenceProvider.notifier)
          .setEnabled(false);
      final disabled = DesktopAutoConnectPreference.read(prefs);
      expect(disabled.launchLocation(_credentials, 'desktop_a'), '/connect');
    },
  );

  test('incomplete credentials or missing desktop show the picker', () {
    expect(_enabled.launchLocation(_credentials, ''), '/connect');
    expect(_enabled.launchLocation(_credentials, null), '/connect');
    expect(
      _enabled.launchLocation(
        _credentials.copyWith(supabaseUrl: ''),
        'desktop_a',
      ),
      '/connect',
    );
    expect(
      _enabled.launchLocation(
        _credentials.copyWith(clearUserSession: true),
        'desktop_a',
      ),
      '/connect',
    );
    expect(
      _enabled.launchLocation(
        _credentials.copyWith(clearDeviceCredentials: true),
        'desktop_a',
      ),
      '/connect',
    );
  });

  test(
    'auto-connect uses the selected desktop without a previous conversation',
    () {
      expect(
        const DesktopAutoConnectPreference(
          enabled: true,
        ).launchLocation(_credentials, 'desktop_a'),
        '/threads',
      );
    },
  );

  test(
    'upgrade preserves the switch and ignores the old conversation',
    () async {
      SharedPreferences.setMockInitialValues({
        'eco.mobile.resume-session': true,
        'eco.mobile.last-session': [
          'https://center.example.com',
          'user_a',
          'desktop_old',
          'thr_old',
        ],
      });
      final prefs = await SharedPreferences.getInstance();
      final preference = DesktopAutoConnectPreference.read(prefs);
      expect(preference.enabled, isTrue);
      expect(preference.launchLocation(_credentials, 'desktop_a'), '/threads');
    },
  );

  testWidgets(
    'launch waits for credentials, opens only the list, and allows the picker',
    (tester) async {
      final credentials = Completer<AppCredentials>();
      final container = ProviderContainer(
        overrides: [
          credentialsProvider.overrideWith((ref) => credentials.future),
          setupOverviewProvider.overrideWithValue(_overview),
          selectedDesktopIdProvider.overrideWith((ref) => null),
          desktopAutoConnectBootstrapProvider.overrideWithValue(_enabled),
        ],
      );
      addTearDown(container.dispose);
      final router = container.read(appRouterProvider);
      late BuildContext context;
      await tester.pumpWidget(
        MaterialApp(
          home: Builder(
            builder: (value) {
              context = value;
              return const SizedBox();
            },
          ),
        ),
      );

      Future<String?> redirect(String path) async {
        final matches = router.configuration.findMatch(Uri.parse(path));
        return router.configuration.topRedirect(
          context,
          router.configuration.buildTopLevelGoRouterState(matches),
        );
      }

      expect(await redirect('/'), isNull);
      credentials.complete(_credentials);
      await tester.pump();
      expect(await redirect('/'), '/threads');
      expect(await redirect('/threads'), isNull);
      expect(await redirect('/connect'), isNull);
      container.read(selectedDesktopIdProvider.notifier).state = 'desktop_b';
      expect(await redirect('/'), '/threads');

      // Opening a conversation must not persist it as a launch destination.
      await router.routerDelegate.setNewRoutePath(
        router.configuration.findMatch(Uri.parse('/threads/thr_new')),
      );
      await tester.pump();
      final prefs = await SharedPreferences.getInstance();
      expect(prefs.containsKey('eco.mobile.last-session'), isFalse);
      expect(await redirect('/'), '/threads');
      expect(await redirect('/threads/thr_new'), isNull);

      await container
          .read(desktopAutoConnectPreferenceProvider.notifier)
          .setEnabled(false);
      expect(await redirect('/'), '/connect');
      // Changing the setting does not interrupt the current page.
      expect(await redirect('/threads/thr_new'), isNull);
    },
  );

  testWidgets('credential recovery prevents automatic desktop connection', (
    tester,
  ) async {
    final container = ProviderContainer(
      overrides: [
        credentialsProvider.overrideWith((ref) async => _credentials),
        setupOverviewProvider.overrideWithValue(_overview),
        selectedDesktopIdProvider.overrideWith((ref) => 'desktop_a'),
        desktopAutoConnectBootstrapProvider.overrideWithValue(_enabled),
      ],
    );
    addTearDown(container.dispose);
    final router = container.read(appRouterProvider);
    await container.read(credentialsProvider.future);
    await tester.pumpWidget(
      MaterialApp(
        home: Builder(
          builder: (context) {
            return const SizedBox();
          },
        ),
      ),
    );
    final context = tester.element(find.byType(SizedBox).first);
    final matches = router.configuration.findMatch(Uri.parse('/'));
    container.read(pendingAuthRecoveryProvider.notifier).state =
        CenterServerAuthRecovery.relogin;
    expect(
      await router.configuration.topRedirect(
        context,
        router.configuration.buildTopLevelGoRouterState(matches),
      ),
      '/connect',
    );
  });
}

const _overview = SetupOverview(
  selectedDesktopId: 'desktop_a',
  readyForThreads: true,
  steps: [
    SetupStep(id: 'server', title: '', state: SetupStepState.done),
    SetupStep(id: 'login', title: '', state: SetupStepState.done),
    SetupStep(id: 'websocket', title: '', state: SetupStepState.done),
    SetupStep(id: 'select', title: '', state: SetupStepState.done),
  ],
);
