import 'dart:convert';

import 'package:eco_mobile/app.dart';
import 'package:eco_mobile/core/models/eco_types.dart';
import 'package:eco_mobile/core/models/conversation_v2_models.dart';
import 'package:eco_mobile/core/network/desktop_rpc.dart';
import 'package:eco_mobile/core/network/eco_center_client.dart';
import 'package:eco_mobile/core/providers/app_providers.dart';
import 'package:eco_mobile/core/storage/credential_store.dart';
import 'package:eco_mobile/core/widgets/progressive_blur.dart';
import 'package:eco_mobile/features/threads/thread_providers.dart';
import 'package:flutter/material.dart';
import 'package:flutter/scheduler.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

// Run on a device with --dart-define-from-file pointing to a private /tmp JSON
// containing these ECO_SMOKE_* values. Never print credentials or tokens.
void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  binding.framePolicy = LiveTestWidgetsFlutterBindingFramePolicy.fullyLive;
  testWidgets('private Realtime RPC and native mobile idle/scroll smoke', (
    tester,
  ) async {
    const url = String.fromEnvironment('ECO_SMOKE_URL');
    const key = String.fromEnvironment('ECO_SMOKE_ANON_KEY');
    const email = String.fromEnvironment('ECO_SMOKE_EMAIL');
    const password = String.fromEnvironment('ECO_SMOKE_PASSWORD');
    const desktopId = String.fromEnvironment('ECO_SMOKE_DESKTOP_ID');
    expect(
      [url, key, email, password, desktopId].every((v) => v.isNotEmpty),
      isTrue,
      reason: 'Supply all ECO_SMOKE_* runtime values.',
    );
    final client = _MeasuredClient(store: _MemoryStore());
    final frames = <FrameTiming>[];
    final connectionStates = <String>[];
    final statuses = client.connectionStatus.listen((s) {
      connectionStates.add(s.state.name);
      debugPrint('SMOKE_CONNECTION ${s.state.name} ${s.lastError ?? ''}');
    });
    final events = <String, int>{};
    final subscription = client.events.listen((event) {
      events.update(event.kind, (n) => n + 1, ifAbsent: () => 1);
    });
    addTearDown(() async {
      client.disconnect();
      final credentials = client.credentials;
      if (credentials.bindingId != null) {
        await client.revokeBinding(credentials.bindingId!);
      }
      if (credentials.deviceId != null) {
        final result = await client.supabaseOrNull!.functions.invoke(
          'device-disable',
          body: {
            'deviceId': credentials.deviceId,
            'deviceSecret': credentials.deviceSecret,
            'kind': 'mobile',
          },
        );
        expect(result.status, 200);
      }
      await subscription.cancel();
      await statuses.cancel();
      await client.dispose();
    });
    await client.setProjectConfig(supabaseUrl: url, anonKey: key);
    client.supabaseOrNull!.realtime.logger = (kind, message, data) {
      if ((kind == 'push' || kind == 'receive') &&
          data is Map &&
          data['type'] == 'broadcast') {
        final payload = data['payload'];
        debugPrint(
          'SMOKE_WIRE ${jsonEncode({'direction': kind, 'event': data['event'], 'payloadKeys': payload is Map ? payload.keys.toList() : null})}',
        );
      }
    };
    await client.login(email: email, password: password);
    await client.registerMobileDevice(deviceName: 'Eco iOS performance smoke');
    await client.setSelectedDesktop(desktopId);
    await client.connect();
    expect(client.status.state, EcoConnectionState.connected);
    debugPrint('SMOKE_CHANNELS ${client.supabaseOrNull!.getChannels().length}');
    final watch = Stopwatch()..start();
    await client.ping();
    debugPrint('SMOKE_PING_MS ${watch.elapsedMilliseconds}');
    final rpc = DesktopRpc(client, desktopId);
    final threads = await rpc.listThreads();
    expect(threads, isNotEmpty);
    debugPrint('SMOKE_THREADS ${threads.length}');
    await ProgressiveBlur.preload();
    await tester.pumpWidget(
      ProviderScope(
        overrides: [ecoCenterClientProvider.overrideWithValue(client)],
        child: const EcoApp(),
      ),
    );
    await tester.pump(const Duration(seconds: 1));
    final container = ProviderScope.containerOf(
      tester.element(find.byType(EcoApp)),
    );
    container.read(appRouterProvider).go('/threads/${threads.first.id}');
    for (var i = 0; i < 80; i++) {
      await tester.pump(const Duration(milliseconds: 100));
    }
    final session = container.read(
      conversationV2SessionProvider(threads.first.id),
    );
    expect(
      session.syncState,
      ConversationV2SyncState.live,
      reason: 'The native conversation must finish bootstrap before measuring.',
    );
    expect(session.error, isNull);
    void collect(List<FrameTiming> timings) => frames.addAll(timings);
    WidgetsBinding.instance.addTimingsCallback(collect);
    addTearDown(() => WidgetsBinding.instance.removeTimingsCallback(collect));
    client.calls.clear();
    events.clear();
    // Do not pump artificial frames while measuring an idle native screen.
    debugPrint('SMOKE_IDLE_START');
    final animations = <String, int>{};
    for (final element in find.byWidgetPredicate((widget) =>
        RegExp('Shimmer|Skeleton|ProgressIndicator|ActivityIndicator|ReconnectPhase|BootLoading').hasMatch(widget.runtimeType.toString())).evaluate()) {
      final type = element.widget.runtimeType.toString();
      animations.update(type, (n) => n + 1, ifAbsent: () => 1);
    }
    debugPrint('SMOKE_ANIMATIONS ${jsonEncode({
      'widgets': animations,
      'transientCallbacks': SchedulerBinding.instance.transientCallbackCount,
      'threadStatus': threads.first.status,
    })}');
    await Future<void>.delayed(const Duration(seconds: 20));
    debugPrint(
      'SMOKE_IDLE ${jsonEncode({'rpc': client.calls, 'events': events, 'channels': client.supabaseOrNull!.getChannels().length, 'connectionStates': connectionStates})}',
    );
    // fullyLive drives engine frames even without app animation; idle energy
    // measurements need the normal app binding, separate from this harness.
    expect(client.calls['conversation:capabilities'] ?? 0, 0);
    expect(connectionStates.where((s) => s == 'connecting'), hasLength(1));
    frames.clear();
    final scrollable = find.byType(Scrollable);
    if (scrollable.evaluate().isNotEmpty) {
      for (var i = 0; i < 6; i++) {
        await tester.drag(scrollable.last, Offset(0, i.isEven ? 450 : -450));
        await tester.pump(const Duration(milliseconds: 250));
      }
    }
    final build =
        frames.map((f) => f.buildDuration.inMicroseconds / 1000).toList()
          ..sort();
    final raster =
        frames.map((f) => f.rasterDuration.inMicroseconds / 1000).toList()
          ..sort();
    debugPrint(
      'SMOKE_SCROLL ${jsonEncode({'frames': frames.length, 'buildP95Ms': build.isEmpty ? null : build[(build.length * .95).floor().clamp(0, build.length - 1)], 'rasterP95Ms': raster.isEmpty ? null : raster[(raster.length * .95).floor().clamp(0, raster.length - 1)]})}',
    );
    await tester.pumpWidget(const SizedBox.shrink());
  }, timeout: const Timeout(Duration(minutes: 5)));
}

class _MemoryStore extends CredentialStore {
  AppCredentials value = const AppCredentials(supabaseUrl: '');
  @override
  Future<AppCredentials> load() async => value;
  @override
  Future<void> save(AppCredentials credentials) async => value = credentials;
}

class _MeasuredClient extends EcoCenterClient {
  _MeasuredClient({required super.store});
  final calls = <String, int>{};
  @override
  Future<T> invoke<T>(
    String desktopDeviceId,
    String channel,
    List<dynamic> args, {
    int? deadlineMs,
  }) {
    calls.update(channel, (n) => n + 1, ifAbsent: () => 1);
    return super.invoke(desktopDeviceId, channel, args, deadlineMs: deadlineMs);
  }
}
