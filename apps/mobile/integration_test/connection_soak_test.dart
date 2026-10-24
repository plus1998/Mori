import 'package:eco_mobile/core/models/eco_types.dart';
import 'package:eco_mobile/core/network/eco_center_client.dart';
import 'package:eco_mobile/core/storage/credential_store.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

// Private configuration belongs in /tmp, passed with --dart-define-from-file.
void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  testWidgets('private connection survives idle and a socket interruption', (
    tester,
  ) async {
    final client = EcoCenterClient(store: _MemoryStore());
    final states = <String>[];
    final subscription = client.connectionStatus.listen((status) {
      states.add(status.state.name);
      debugPrint(
        'CONNECTION_SOAK ${status.state.name} ${status.lastError ?? ''}',
      );
    });
    addTearDown(() async {
      client.disconnect();
      final credentials = client.credentials;
      if (credentials.bindingId != null) {
        await client.revokeBinding(credentials.bindingId!);
      }
      if (credentials.deviceId != null) {
        await client.supabaseOrNull!.functions.invoke(
          'device-disable',
          body: {
            'deviceId': credentials.deviceId,
            'deviceSecret': credentials.deviceSecret,
            'kind': 'mobile',
          },
        );
      }
      await subscription.cancel();
      await client.dispose();
    });
    await client.setProjectConfig(
      supabaseUrl: const String.fromEnvironment('ECO_SMOKE_URL'),
      anonKey: const String.fromEnvironment('ECO_SMOKE_ANON_KEY'),
    );
    await client.login(
      email: const String.fromEnvironment('ECO_SMOKE_EMAIL'),
      password: const String.fromEnvironment('ECO_SMOKE_PASSWORD'),
    );
    await client.registerMobileDevice(
      deviceName: 'Eco simulator connection soak',
    );
    await client.connectPresence();
    await Future<void>.delayed(const Duration(seconds: 2));
    final devices = await client.listPresence();
    debugPrint(
      'CONNECTION_SOAK desktops=${devices.map((d) => '${d.name}:${d.online}').join(',')}',
    );
    const desktopId = String.fromEnvironment('ECO_SMOKE_DESKTOP_ID');
    final desktop = desktopId.isNotEmpty
        ? devices.singleWhere((d) => d.id == desktopId)
        : devices.firstWhere((d) => d.online == true);
    await client.setSelectedDesktop(desktop.id);
    await client.connect();
    const seconds = int.fromEnvironment('ECO_SOAK_SECONDS', defaultValue: 180);
    final deadline = DateTime.now().add(const Duration(seconds: seconds));
    var pings = 0;
    while (DateTime.now().isBefore(deadline)) {
      await Future<void>.delayed(const Duration(seconds: 3));
      try {
        await client.ping();
        pings++;
      } catch (error) {
        debugPrint('CONNECTION_SOAK probe failed: $error');
      }
    }
    debugPrint(
      'CONNECTION_SOAK idle pings=$pings states=$states channels=${client.supabaseOrNull!.getChannels().length}',
    );
    expect(client.status.state, EcoConnectionState.connected);
    expect(states.where((s) => s == 'error'), isEmpty);
    await client.supabaseOrNull!.realtime.disconnect();
    // Also request reconnect while the timer may already be retrying.
    await Future<void>.delayed(const Duration(seconds: 4));
    await Future.wait([client.connect(), client.connect()]);
    await client.ping();
    expect(client.hasActiveBindingChannel, isTrue);
    debugPrint(
      'CONNECTION_SOAK recovered states=$states channels=${client.supabaseOrNull!.getChannels().length}',
    );
    final beforeAutomatic = states.length;
    await client.supabaseOrNull!.realtime.disconnect();
    final automaticRecovery = Stopwatch()..start();
    final recoveryDeadline = DateTime.now().add(const Duration(seconds: 60));
    while (DateTime.now().isBefore(recoveryDeadline) &&
        (!client.hasActiveBindingChannel ||
            client.status.state != EcoConnectionState.connected)) {
      await Future<void>.delayed(const Duration(milliseconds: 250));
    }
    expect(client.status.state, EcoConnectionState.connected);
    expect(client.hasActiveBindingChannel, isTrue);
    expect(
      states.skip(beforeAutomatic),
      containsAllInOrder(['error', 'connecting', 'connected']),
    );
    await client.ping();
    expect(client.supabaseOrNull!.getChannels(), hasLength(2));
    debugPrint(
      'CONNECTION_SOAK automaticRecoveryMs=${automaticRecovery.elapsedMilliseconds} states=${states.skip(beforeAutomatic).toList()}',
    );
  }, timeout: const Timeout(Duration(minutes: 8)));
}

class _MemoryStore extends CredentialStore {
  AppCredentials value = const AppCredentials(supabaseUrl: '');
  @override
  Future<AppCredentials> load() async => value;
  @override
  Future<void> save(AppCredentials credentials) async => value = credentials;
}
