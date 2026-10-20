import 'dart:async';

import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models/eco_types.dart';
import '../network/eco_center_client.dart';
import '../network/desktop_rpc.dart';
import '../services/eco_tts_service.dart';
import '../storage/credential_store.dart';
import '../utils/center_server_auth.dart';
import '../utils/device_display.dart';
import '../widgets/lifecycle_tracker.dart';

/// Tracks whether the app is in the foreground.
///
/// Consumers (timers, polling) should watch this and pause work when the app
/// is hidden / paused / detached to save battery.
final appForegroundProvider = Provider<bool>((ref) {
  bool foreground = true;

  void handleLifecycle(AppLifecycleState state) {
    AppLifecycleTracker.update(state);
    final nowForeground = AppLifecycleTracker.isForeground;
    if (foreground != nowForeground) {
      foreground = nowForeground;
      ref.state = nowForeground;
    }
  }

  final observer = _LifecycleObserver(handleLifecycle);
  final initialState = WidgetsBinding.instance.lifecycleState;
  if (initialState != null) {
    AppLifecycleTracker.update(initialState);
    foreground = AppLifecycleTracker.isForeground;
  }
  WidgetsBinding.instance.addObserver(observer);
  ref.onDispose(() => WidgetsBinding.instance.removeObserver(observer));
  return foreground;
});

class _LifecycleObserver extends Object with WidgetsBindingObserver {
  _LifecycleObserver(this._onStateChange);
  final void Function(AppLifecycleState) _onStateChange;

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    _onStateChange(state);
  }
}

final credentialStoreProvider = Provider<CredentialStore>((ref) {
  return CredentialStore();
});

final ecoCenterClientProvider = Provider<EcoCenterClient>((ref) {
  final store = ref.watch(credentialStoreProvider);
  final client = EcoCenterClient(store: store);
  ref.onDispose(() {
    client.dispose();
  });
  return client;
});

final credentialsProvider = FutureProvider<AppCredentials>((ref) async {
  final client = ref.watch(ecoCenterClientProvider);
  await client.initialize();
  return client.credentials;
});

final connectionStatusProvider = StreamProvider<CenterServerConnectionStatus>((
  ref,
) {
  final client = ref.watch(ecoCenterClientProvider);
  return () async* {
    yield client.status;
    yield* client.connectionStatus;
  }();
});

final ecoEventsProvider = StreamProvider<EcoEventEnvelope>((ref) {
  final client = ref.watch(ecoCenterClientProvider);
  return client.events;
});

final selectedDesktopIdProvider = StateProvider<String?>((ref) => null);

final ecoTtsServiceProvider = ChangeNotifierProvider<EcoTtsService>((ref) {
  return EcoTtsService(remote: () {
    final client = ref.read(ecoCenterClientProvider);
    final id = ref.read(selectedDesktopIdProvider) ?? client.credentials.selectedDesktopId;
    if (id == null || id.isEmpty) return null;
    return DesktopRpc(client, id);
  });
});

/// Set when credentials expire; [HomeScreen] consumes this to show login UI.
final pendingAuthRecoveryProvider =
    StateProvider<CenterServerAuthRecovery?>((ref) => null);

/// Clears local auth and marks [pendingAuthRecoveryProvider].
///
/// Returns `false` when the same recovery is already in progress (dedupe).
Future<bool> beginCredentialRecovery(
  WidgetRef ref,
  CenterServerAuthRecovery recovery,
) async {
  final current = ref.read(pendingAuthRecoveryProvider);
  if (current == recovery) return false;

  final client = ref.read(ecoCenterClientProvider);
  if (recovery == CenterServerAuthRecovery.accountUnusable) {
    await client.clearSession();
    ref.read(selectedDesktopIdProvider.notifier).state = null;
  } else {
    await client.invalidateExpiredUserSession();
  }

  ref.invalidate(credentialsProvider);
  ref.invalidate(bindingsProvider);
  ref.invalidate(desktopPresenceProvider);
  ref.read(pendingAuthRecoveryProvider.notifier).state = recovery;
  return true;
}

final selectedDesktopLabelProvider = Provider<String?>((ref) {
  final credentials =
      ref.watch(credentialsProvider).valueOrNull ??
      ref.read(ecoCenterClientProvider).credentials;
  final selectedId =
      ref.watch(selectedDesktopIdProvider) ?? credentials.selectedDesktopId;
  if (selectedId == null || selectedId.isEmpty) return null;
  final presence = ref.watch(desktopPresenceProvider).valueOrNull;
  if (presence != null) {
    for (final device in presence) {
      if (device.id == selectedId) {
        return formatDesktopLabel(device, selectedId);
      }
    }
  }
  return shortenDeviceId(selectedId);
});

final serverReachableProvider = StateProvider<bool?>((ref) => null);

final bindingsProvider = FutureProvider<List<DeviceBinding>>((ref) async {
  final client = ref.watch(ecoCenterClientProvider);
  await client.initialize();
  if (!client.credentials.hasDeviceCredentials) return [];
  return client.listBindings();
});

final desktopPresenceProvider =
    AsyncNotifierProvider<DesktopPresenceNotifier, List<PublicDevice>>(
      DesktopPresenceNotifier.new,
    );

class DesktopPresenceNotifier extends AsyncNotifier<List<PublicDevice>> {
  Timer? _pollTimer;
  Timer? _connectRefreshTimer;

  @override
  Future<List<PublicDevice>> build() async {
    final client = ref.watch(ecoCenterClientProvider);
    ref.onDispose(() {
      _pollTimer?.cancel();
      _pollTimer = null;
      _connectRefreshTimer?.cancel();
      _connectRefreshTimer = null;
    });

    ref.listen(connectionStatusProvider, (previous, next) {
      next.whenData((status) {
        if (status.state != EcoConnectionState.connected) {
          return;
        }
        final wasConnected =
            previous?.valueOrNull?.state == EcoConnectionState.connected;
        if (wasConnected) {
          return;
        }
        _connectRefreshTimer?.cancel();
        _connectRefreshTimer = Timer(const Duration(milliseconds: 600), () {
          unawaited(refresh(force: true));
        });
      });
    });

    ref.listen(ecoEventsProvider, (_, next) {
      next.whenData(_handleEcoEvent);
    });

    await client.initialize();
    if (!client.credentials.hasDeviceCredentials) {
      return [];
    }

    _pollTimer?.cancel();
    _pollTimer = Timer.periodic(const Duration(seconds: 20), (_) {
      // Skip polling when app is in background to save battery.
      if (!AppLifecycleTracker.isForeground) return;
      unawaited(refresh());
    });

    // The PC picker only needs a REST snapshot. Starting Realtime here would
    // make every later desktop switch tear down and recreate the bind channel.
    return _fetchPresenceWithRetry(client);
  }

  Future<void> refresh({bool force = false}) async {
    final client = ref.read(ecoCenterClientProvider);
    await client.initialize();
    if (!client.credentials.hasDeviceCredentials) {
      state = const AsyncData([]);
      return;
    }

    final previous = state.valueOrNull;
    if (!force && previous != null && state.isLoading) {
      return;
    }

    final next = await AsyncValue.guard(() => _fetchPresenceWithRetry(client));
    if (next.hasError) {
      if (previous != null && previous.isNotEmpty) {
        return;
      }
      state = next;
      return;
    }
    state = next;
  }

  Future<List<PublicDevice>> _fetchPresenceWithRetry(
    EcoCenterClient client,
  ) async {
    Object? lastError;
    for (var attempt = 0; attempt < 3; attempt++) {
      try {
        return await client.listPresence();
      } catch (error) {
        lastError = error;
        if (attempt < 2) {
          await Future<void>.delayed(
            Duration(milliseconds: 400 * (attempt + 1)),
          );
        }
      }
    }
    throw lastError ?? StateError('Failed to load desktop presence.');
  }

  void _handleEcoEvent(EcoEventEnvelope event) {
    if (event.kind != presenceDeviceEventKind) {
      return;
    }
    final current = state.valueOrNull;
    if (current != null) {
      final next = applyPresenceDeviceEvent(current, event);
      if (!identical(next, current)) {
        state = AsyncData(next);
      }
    }
    unawaited(refresh(force: true));
  }
}

const presenceDeviceEventKind = 'presence.device';

List<PublicDevice> applyPresenceDeviceEvent(
  List<PublicDevice> devices,
  EcoEventEnvelope event,
) {
  if (event.kind != presenceDeviceEventKind) {
    return devices;
  }
  final payload = event.payload;
  if (payload is! Map) {
    return devices;
  }
  final deviceId = payload['deviceId'];
  final online = payload['online'];
  if (deviceId is! String || deviceId.isEmpty || online is! bool) {
    return devices;
  }
  final lastSeenAt = payload['lastSeenAt'];
  var changed = false;
  final next = devices
      .map((device) {
        if (device.id != deviceId) {
          return device;
        }
        changed = true;
        return device.copyWith(
          online: online,
          lastSeenAt: lastSeenAt is String && lastSeenAt.isNotEmpty
              ? lastSeenAt
              : null,
        );
      })
      .toList(growable: false);
  return changed ? next : devices;
}

/// Current online status for a desktop, updated by polling and presence events.
final stableDesktopOnlineProvider =
    NotifierProvider.family<StableDesktopOnlineNotifier, bool?, String>(
      StableDesktopOnlineNotifier.new,
    );

class StableDesktopOnlineNotifier extends FamilyNotifier<bool?, String> {
  @override
  bool? build(String desktopId) {
    ref.listen(desktopPresenceProvider, (_, next) {
      next.when(
        data: (devices) {
          final device = devices
              .where((entry) => entry.id == desktopId)
              .firstOrNull;
          if (device == null) return;
          state = device.online;
        },
        loading: () {},
        error: (_, _) {},
      );
    });

    final presence = ref.watch(desktopPresenceProvider).valueOrNull;
    if (presence == null) return null;
    final device = presence.where((entry) => entry.id == desktopId).firstOrNull;
    return device?.online;
  }
}
