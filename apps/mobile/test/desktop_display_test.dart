import 'dart:async';

import 'package:eco_mobile/core/models/display_control_models.dart';
import 'package:eco_mobile/core/models/eco_types.dart';
import 'package:eco_mobile/core/network/desktop_rpc.dart';
import 'package:eco_mobile/core/network/eco_center_client.dart';
import 'package:eco_mobile/core/providers/desktop_bind_ready.dart';
import 'package:eco_mobile/core/storage/credential_store.dart';
import 'package:eco_mobile/features/settings/settings_desktop_display_page.dart';
import 'package:eco_mobile/features/threads/thread_providers.dart';
import 'package:eco_mobile/l10n/generated/app_localizations.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

final _selected = StateProvider<_Rpc>((ref) => _Rpc());

DesktopDisplayState _state({bool dimmed = true}) => DesktopDisplayState(
  preventAutoLock: true,
  dimmed: dimmed,
  brightnessAvailable: true,
  displays: [
    (name: 'Display', status: dimmed ? 'dimmed' : 'ready', error: null),
  ],
  pendingRestores: 0,
);

class _Rpc extends DesktopRpc {
  _Rpc() : super(EcoCenterClient(store: CredentialStore()), 'desktop');
  DesktopDisplayState state = _state();
  int reads = 0;
  Object? error;
  Completer<DesktopDisplayState>? pending;
  final changes = <(String, bool)>[];
  @override
  Future<DesktopDisplayState> getDisplayControl() async {
    reads++;
    if (error != null) throw error!;
    return pending == null ? state : pending!.future;
  }

  @override
  Future<DesktopDisplayState> setDisplayControl(
    String control,
    bool enabled,
  ) async {
    changes.add((control, enabled));
    return state = _state(dimmed: enabled);
  }
}

class _Client extends EcoCenterClient {
  _Client() : super(store: CredentialStore());
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
    return {
          'preventAutoLock': true,
          'dimmed': false,
          'brightnessAvailable': true,
          'displays': [
            {'name': 'Display', 'status': 'ready'},
          ],
          'pendingRestores': 0,
        }
        as T;
  }
}

void main() {
  test(
    'display RPC sends explicit state changes and parses physical display status',
    () async {
      final client = _Client();
      final rpc = DesktopRpc(client, 'desktop');
      expect((await rpc.getDisplayControl()).dimmed, false);
      expect(client.channel, 'display-control:get');
      expect(
        (await rpc.setDisplayControl('dimmed', true)).displays.single.status,
        'ready',
      );
      expect(client.channel, 'display-control:set');
      expect(client.args, [
        {'control': 'dimmed', 'enabled': true},
      ]);
    },
  );

  Future<ProviderContainer> open(WidgetTester tester, _Rpc rpc) async {
    final container = ProviderContainer(
      overrides: [
        _selected.overrideWith((ref) => rpc),
        desktopRpcProvider.overrideWith((ref) => ref.watch(_selected)),
        desktopBindReadyOverrideProvider.overrideWithValue(true),
      ],
    );
    addTearDown(container.dispose);
    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: container,
        child: MaterialApp(
          locale: const Locale('zh'),
          localizationsDelegates: AppLocalizations.localizationsDelegates,
          supportedLocales: AppLocalizations.supportedLocales,
          home: const SettingsDesktopDisplayPage(),
        ),
      ),
    );
    await tester.pumpAndSettle();
    return container;
  }

  testWidgets(
    'patrol detects a restored screen, reactivation works and patrol can stop',
    (tester) async {
      final rpc = _Rpc();
      await open(tester, rpc);
      expect(find.text('已确认处于最低亮度'), findsNWidgets(2));
      rpc.state = _state(dimmed: false);
      await tester.pump(const Duration(seconds: 5));
      await tester.pumpAndSettle();
      expect(find.text('当前未处于最低亮度，可重新开启'), findsNWidgets(2));
      await tester.tap(find.text('亮度调至最低'));
      await tester.pumpAndSettle();
      expect(rpc.changes, [('dimmed', true)]);
      expect(find.text('已确认处于最低亮度'), findsNWidgets(2));
      await tester.tap(find.text('巡查'));
      await tester.pumpAndSettle();
      final count = rpc.reads;
      await tester.pump(const Duration(seconds: 10));
      expect(rpc.reads, count);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets(
    'disconnection clears confirmed state and old desktop responses cannot overwrite a switch',
    (tester) async {
      final rpc = _Rpc();
      final container = await open(tester, rpc);
      rpc.pending = Completer();
      await tester.pump(const Duration(seconds: 5));
      final next = _Rpc()..state = _state(dimmed: false);
      container.read(_selected.notifier).state = next;
      await tester.pump();
      rpc.pending!.complete(_state());
      await tester.pumpAndSettle();
      expect(find.text('当前未处于最低亮度，可重新开启'), findsNWidgets(2));
      next.error = EcoCenterException.native('offline');
      await tester.pump(const Duration(seconds: 5));
      await tester.pumpAndSettle();
      expect(find.text('当前状态未确认'), findsNWidgets(2));
      expect(find.text('已确认处于最低亮度'), findsNothing);
      expect(find.text('offline'), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
    },
  );
}
