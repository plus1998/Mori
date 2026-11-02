import 'dart:async';

import 'package:eco_mobile/app.dart';
import 'package:eco_mobile/core/providers/app_providers.dart';
import 'package:eco_mobile/core/providers/session_resume_provider.dart';
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

const _session = SavedSession(
  serverUrl: 'https://center.example.com',
  userId: 'user_a',
  desktopId: 'desktop_a',
  threadId: 'thr_123',
);

const _enabled = SessionResumePreference(enabled: true, lastSession: _session);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() => SharedPreferences.setMockInitialValues({}));

  test('default launch shows PC picker even with a saved desktop', () async {
    final prefs = await SharedPreferences.getInstance();
    final preference = SessionResumePreference.read(prefs);
    expect(preference.enabled, isFalse);
    expect(preference.launchLocation(_credentials, 'desktop_a'), '/connect');
  });

  test(
    'last session and switch survive restart; disabling restores picker',
    () async {
      final container = ProviderContainer();
      addTearDown(container.dispose);
      final notifier = container.read(sessionResumePreferenceProvider.notifier);
      await notifier.remember(_session);
      await notifier.setEnabled(true);

      final prefs = await SharedPreferences.getInstance();
      final restored = SessionResumePreference.read(prefs);
      expect(
        restored.launchLocation(_credentials, 'desktop_a'),
        '/threads/thr_123',
      );

      final restarted = ProviderContainer(
        overrides: [sessionResumeBootstrapProvider.overrideWithValue(restored)],
      );
      addTearDown(restarted.dispose);
      await restarted
          .read(sessionResumePreferenceProvider.notifier)
          .setEnabled(false);
      final disabled = SessionResumePreference.read(prefs);
      expect(disabled.launchLocation(_credentials, 'desktop_a'), '/connect');
      expect(disabled.lastSession?.threadId, 'thr_123');
    },
  );

  test('never restores a session across accounts, servers, or desktops', () {
    expect(
      _enabled.launchLocation(
        _credentials.copyWith(userId: 'user_b'),
        'desktop_a',
      ),
      '/connect',
    );
    expect(
      _enabled.launchLocation(
        _credentials.copyWith(supabaseUrl: 'https://other.example.com'),
        'desktop_a',
      ),
      '/connect',
    );
    expect(_enabled.launchLocation(_credentials, 'desktop_b'), '/connect');
    expect(_enabled.launchLocation(_credentials, null), '/connect');
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

  test('enabled without a previous conversation enters the session list', () {
    expect(
      const SessionResumePreference(
        enabled: true,
      ).launchLocation(_credentials, 'desktop_a'),
      '/threads',
    );
  });

  testWidgets(
    'launch waits for credentials, restores once, and allows returning to picker',
    (tester) async {
      final credentials = Completer<AppCredentials>();
      final container = ProviderContainer(
        overrides: [
          credentialsProvider.overrideWith((ref) => credentials.future),
          setupOverviewProvider.overrideWithValue(_overview),
          selectedDesktopIdProvider.overrideWith((ref) => 'desktop_a'),
          sessionResumeBootstrapProvider.overrideWithValue(_enabled),
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
      expect(await redirect('/'), '/threads/thr_123');
      expect(await redirect('/threads'), isNull);
      expect(await redirect('/connect'), isNull);

      // Restored sessions retain the session list underneath for normal back.
      final restored = router.configuration.findMatch(
        Uri.parse('/threads/thr_123'),
      );
      expect(restored.matches.length, 2);

      // Committed navigation also remembers composer -> real conversation handoff.
      await router.routerDelegate.setNewRoutePath(
        router.configuration.findMatch(Uri.parse('/threads/new')),
      );
      await tester.pump();
      expect(
        container.read(sessionResumePreferenceProvider).lastSession?.threadId,
        'thr_123',
      );
      await router.routerDelegate.setNewRoutePath(
        router.configuration.findMatch(Uri.parse('/threads/thr_new')),
      );
      await tester.pump();
      expect(
        container.read(sessionResumePreferenceProvider).lastSession?.threadId,
        'thr_new',
      );
      await router.routerDelegate.setNewRoutePath(
        router.configuration.findMatch(Uri.parse('/connect')),
      );
      await tester.pump();
      expect(
        container.read(sessionResumePreferenceProvider).lastSession?.threadId,
        'thr_new',
      );
      expect(await redirect('/connect'), isNull);

      await container
          .read(sessionResumePreferenceProvider.notifier)
          .setEnabled(false);
      expect(await redirect('/'), '/connect');
      // Changing the setting does not interrupt the current page.
      expect(await redirect('/threads/thr_new'), isNull);
    },
  );

  testWidgets('credential recovery prevents automatic resume', (tester) async {
    final container = ProviderContainer(
      overrides: [
        credentialsProvider.overrideWith((ref) async => _credentials),
        setupOverviewProvider.overrideWithValue(_overview),
        selectedDesktopIdProvider.overrideWith((ref) => 'desktop_a'),
        sessionResumeBootstrapProvider.overrideWithValue(_enabled),
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
