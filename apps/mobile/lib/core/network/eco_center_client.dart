import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:supabase_flutter/supabase_flutter.dart';

import '../models/eco_types.dart';
import '../storage/credential_store.dart';
import '../utils/center_server_auth.dart';
import '../utils/device_profile.dart';
import '../widgets/lifecycle_tracker.dart';
import 'eco_realtime.dart';

typedef JsonMap = Map<String, dynamic>;

/// Converts a JSON-RPC error into the app exception used by the transport.
///
/// Desktop V2 errors keep their stable domain code in `error.data` so callers
/// can distinguish an incompatible protocol from a transient RPC failure.
EcoCenterException ecoCenterExceptionFromRpcError(dynamic error) {
  final errorMap = _stringKeyedMap(error);
  final data = _stringKeyedMap(errorMap?['data']);
  final rawDomainCode = data?['conversationCode'];
  final domainCode = rawDomainCode is String && rawDomainCode.trim().isNotEmpty
      ? rawDomainCode
      : null;
  final rawRpcCode = errorMap?['code'];
  final rpcCode = rawRpcCode is int ? rawRpcCode : null;
  final message = errorMap?['message'];

  if (message is String) {
    return EcoCenterException.native(
      message,
      code: rpcCode,
      domainCode: domainCode,
      domainData: data,
    );
  }
  return EcoCenterException.app(EcoCenterErrorKind.rpcFailed, code: rpcCode);
}

Map<String, dynamic>? _stringKeyedMap(dynamic value) {
  if (value is Map<String, dynamic>) return value;
  if (value is! Map) return null;
  final result = <String, dynamic>{};
  for (final entry in value.entries) {
    if (entry.key is String) {
      result[entry.key as String] = entry.value;
    }
  }
  return result;
}

/// Edge Function names (Track A). Documented in `supabase/README.md`.
abstract final class EcoSupabaseFunctions {
  static const deviceRegister = 'device-register';
  static const deviceSessionRegister = 'device-session-register';
  static const deviceDisable = 'device-disable';
  static const bindingEnsure = 'binding-ensure';
  static const pairingJoin = 'pairing-join';
  static const pairingCreate = 'pairing-create';
}

/// Supabase Center mobile client (Track F foundation).
///
/// Auth + device-register + pairing-join + Realtime `eco:bind:*` ping/invoke stub.
/// [DesktopRpc] continues to call [invoke]; transport is private Broadcast, not WS.
class EcoCenterClient {
  EcoCenterClient({
    required CredentialStore store,
    DateTime Function()? now,
    this.reconnectDelayMs = 3000,
    this.defaultInvokeTimeoutMs = 30000,
  }) : _store = store,
       _now = now ?? DateTime.now;

  final CredentialStore _store;
  final DateTime Function() _now;
  final int reconnectDelayMs;
  final int defaultInvokeTimeoutMs;

  AppCredentials _credentials = const AppCredentials(supabaseUrl: '');
  SupabaseClient? _supabase;
  String? _clientUrl;
  String? _clientAnonKey;

  RealtimeChannel? _bindChannel;
  String? _subscribedBindingId;
  RealtimeChannel? _presenceChannel;
  final Set<String> _onlineDesktopDeviceIds = {};
  Future<void>? _connectInFlight;
  Future<void>? _presenceConnectInFlight;
  StreamSubscription<AuthState>? _authSub;
  Timer? _reconnectTimer;
  Timer? _keepaliveTimer;
  Timer? _deviceSessionRefreshTimer;
  bool _transportProbeInFlight = false;
  bool _intentionallyStopped = true;
  bool _presenceOnlyMode = false;
  int _rpcCounter = 0;
  int _reconnectAttempts = 0;

  final _connectionController =
      StreamController<CenterServerConnectionStatus>.broadcast();
  final _eventController = StreamController<EcoEventEnvelope>.broadcast();
  final Map<String, Completer<dynamic>> _pendingInvokes = {};
  final Map<String, Completer<void>> _pendingBindingReady = {};

  CenterServerConnectionStatus _status = const CenterServerConnectionStatus(
    state: EcoConnectionState.disconnected,
  );
  CenterServerConnectionStatus? _lastEmittedStatus;

  Stream<CenterServerConnectionStatus> get connectionStatus =>
      _connectionController.stream;
  Stream<EcoEventEnvelope> get events => _eventController.stream;
  CenterServerConnectionStatus get status => _status;
  AppCredentials get credentials => _credentials;
  SupabaseClient? get supabaseOrNull => _supabase;
  bool get hasActiveBindingChannel =>
      _bindChannel != null &&
      _bindChannel!.canPush &&
      _subscribedBindingId != null &&
      _subscribedBindingId == _credentials.bindingId;

  /// True after [_subscribeUserPresence] succeeds (online flags become meaningful).
  bool get hasUserPresenceChannel => _presenceChannel != null;

  /// Picker owns the transport: Presence is up, bind/RPC must stay idle.
  ///
  /// Session providers under a pushed `/connect` route still watch desktop id
  /// changes; they must not call [connect] until the picker leaves this mode.
  bool get isPresenceOnlyMode => _presenceOnlyMode;

  /// Mark the picker as Presence-only immediately (before the socket is up).
  ///
  /// [disconnect] clears this flag; call this right after so shell providers
  /// cannot race a full [connect] while [connectPresence] is still starting.
  void beginPresenceOnlyMode() {
    _intentionallyStopped = false;
    _presenceOnlyMode = true;
  }

  /// Allow bind/RPC again (enter `/threads`, or leave the picker via pop).
  void leavePresenceOnlyMode() {
    _presenceOnlyMode = false;
  }

  Future<void> initialize() async {
    _credentials = await _store.load();
    if (_credentials.hasProjectConfig) {
      await _ensureSupabaseClient();
      await _restoreSessionIfNeeded();
    }
    _emitStatus(_status);
  }

  Future<void> updateCredentials(AppCredentials credentials) async {
    _credentials = credentials;
    await _store.save(credentials);
  }

  /// Persists project URL + anon key. Prefer this over [setServerUrl].
  Future<void> setProjectConfig({
    required String supabaseUrl,
    required String anonKey,
  }) async {
    final normalized = normalizeSupabaseProjectUrl(supabaseUrl);
    final key = anonKey.trim();
    if (key.isEmpty) {
      throw EcoCenterException.app(EcoCenterErrorKind.anonKeyRequired);
    }
    final previousUrl = _credentials.supabaseUrl.trim();
    final urlChanged = previousUrl.isEmpty
        ? true
        : normalizeSupabaseProjectUrl(previousUrl) != normalized;
    final keyChanged = (_credentials.anonKey?.trim() ?? '') != key;
    _credentials = _credentials.copyWith(
      supabaseUrl: normalized,
      anonKey: key,
      clearUserSession: urlChanged,
      clearDeviceCredentials: urlChanged,
      clearSelectedDesktop: urlChanged,
      clearBindingId: urlChanged,
    );
    await _store.save(_credentials);
    if (urlChanged || keyChanged || _supabase == null) {
      await _resetSupabaseClient();
      await _ensureSupabaseClient();
    }
  }

  /// @deprecated Prefer [setProjectConfig]. Keeps anon key if already stored.
  Future<void> setServerUrl(String serverUrl) async {
    final normalized = normalizeSupabaseProjectUrl(serverUrl);
    final anon = _credentials.anonKey?.trim() ?? '';
    if (anon.isEmpty) {
      _credentials = _credentials.copyWith(supabaseUrl: normalized);
      await _store.save(_credentials);
      return;
    }
    await setProjectConfig(supabaseUrl: normalized, anonKey: anon);
  }

  Future<void> setSelectedDesktop(
    String? desktopDeviceId, {
    String? knownBindingId,
  }) async {
    final changed = _credentials.selectedDesktopId != desktopDeviceId;
    if (changed) {
      // Drop the previous PC's bind channel before pointing credentials at the
      // next one. Full Presence teardown stays on [disconnect] (picker entry).
      _clearReconnectTimer();
      _clearKeepalive();
      _teardownBindChannel();
      // Abort any in-flight connect so it cannot resurrect the old bind after
      // credentials flip. The next explicit [connect] clears this again.
      _intentionallyStopped = true;
      _connectInFlight = null;
      _emitStatus(
        const CenterServerConnectionStatus(
          state: EcoConnectionState.disconnected,
        ),
      );
      _intentionallyStopped = false;
    }
    if (desktopDeviceId == null || desktopDeviceId.isEmpty) {
      _credentials = _credentials.copyWith(
        clearSelectedDesktop: true,
        clearBindingId: true,
      );
      await _store.save(_credentials);
      return;
    }

    final known = knownBindingId?.trim();
    if (known != null && known.isNotEmpty) {
      _credentials = _credentials.copyWith(
        selectedDesktopId: desktopDeviceId,
        bindingId: known,
      );
      await _store.save(_credentials);
      return;
    }

    // Re-tapping the already-selected PC with a cached binding — no network.
    if (!changed &&
        _credentials.bindingId != null &&
        _credentials.bindingId!.isNotEmpty) {
      return;
    }

    if (changed) {
      _credentials = _credentials.copyWith(
        selectedDesktopId: desktopDeviceId,
        clearBindingId: true,
      );
      await _store.save(_credentials);
    }

    // First bind (or lost bindingId): create/reuse via Edge Function.
    // Profile sync is not needed here — [connect] already calls syncDeviceProfile.
    if (_credentials.hasDeviceCredentials) {
      try {
        await ensureBinding(desktopDeviceId);
      } catch (_) {
        // Binding errors are surfaced when the session connects on entry.
      }
    }
  }

  /// Same-account mobile→desktop binding without pairing QR codes.
  Future<DeviceBinding> ensureBinding(String desktopDeviceId) async {
    final trimmed = desktopDeviceId.trim();
    if (trimmed.isEmpty) {
      throw EcoCenterException.app(EcoCenterErrorKind.bindingRequired);
    }
    await ensureMobileDevice(syncProfile: false);
    final client = await _ensureSupabaseClient();
    await _ensureUserAccessToken();
    final response = await client.functions.invoke(
      EcoSupabaseFunctions.bindingEnsure,
      body: {
        'mobileDeviceId': _credentials.deviceId,
        'deviceSecret': _credentials.deviceSecret,
        'desktopDeviceId': trimmed,
      },
    );
    final data = _requireFunctionJson(response);
    final binding = DeviceBinding.fromJson(_asJsonMap(data['binding']));
    _credentials = _credentials.copyWith(
      selectedDesktopId: binding.desktopDeviceId,
      bindingId: binding.id,
    );
    await _store.save(_credentials);
    return binding;
  }

  Future<bool> testConnection(String supabaseUrl, {String? anonKey}) async {
    try {
      final normalized = normalizeSupabaseProjectUrl(supabaseUrl);
      final key = (anonKey ?? _credentials.anonKey)?.trim() ?? '';
      if (key.isEmpty) return false;
      final healthUri = Uri.parse('$normalized/auth/v1/health');
      final client = HttpClient();
      try {
        final request = await client
            .getUrl(healthUri)
            .timeout(const Duration(seconds: 8));
        request.headers.set('apikey', key);
        request.headers.set('authorization', 'Bearer $key');
        final response = await request.close().timeout(
          const Duration(seconds: 8),
        );
        await response.drain<void>();
        return response.statusCode >= 200 && response.statusCode < 300;
      } finally {
        client.close(force: true);
      }
    } catch (_) {
      return false;
    }
  }

  Future<PublicUser> register({
    required String email,
    required String password,
    String? displayName,
  }) async {
    final client = await _ensureSupabaseClient();
    final response = await client.auth.signUp(
      email: email.trim(),
      password: password,
      data: {
        if (displayName != null && displayName.trim().isNotEmpty)
          'display_name': displayName.trim(),
      },
    );
    final user = response.user;
    final session = response.session;
    if (user == null || session == null) {
      throw EcoCenterException.native(
        'Sign up succeeded but no session returned. Confirm email may be required.',
      );
    }
    return _applyAuthSession(user, session);
  }

  Future<PublicUser> login({
    required String email,
    required String password,
  }) async {
    final client = await _ensureSupabaseClient();
    final response = await client.auth.signInWithPassword(
      email: email.trim(),
      password: password,
    );
    final user = response.user;
    final session = response.session;
    if (user == null || session == null) {
      throw EcoCenterException.app(
        EcoCenterErrorKind.reauthRequired,
        recovery: CenterServerAuthRecovery.relogin,
      );
    }
    return _applyAuthSession(user, session);
  }

  /// Re-authenticate the current account password without changing the signed-in email.
  ///
  /// Used before destructive account actions such as unpairing a Desktop.
  Future<void> verifyAccountPassword(String password) async {
    final email = _credentials.userEmail?.trim() ?? '';
    if (email.isEmpty || !_credentials.hasUserSession) {
      throw EcoCenterException.app(
        EcoCenterErrorKind.reauthRequired,
        recovery: CenterServerAuthRecovery.relogin,
      );
    }
    if (password.isEmpty) {
      throw EcoCenterException.app(EcoCenterErrorKind.invalidCredentials);
    }
    try {
      await login(email: email, password: password);
    } on AuthException {
      throw EcoCenterException.app(EcoCenterErrorKind.invalidCredentials);
    }
  }

  Future<PublicDevice> registerMobileDevice({String? deviceName}) async {
    final client = await _ensureSupabaseClient();
    await _ensureUserAccessToken();
    final profile = await DeviceProfile.collect();
    final response = await client.functions.invoke(
      EcoSupabaseFunctions.deviceRegister,
      body: {
        'kind': 'mobile',
        'name': (deviceName ?? profile.displayName).trim(),
        'metadata': profile.toMetadata(),
      },
    );
    final data = _requireFunctionJson(response);
    final device = PublicDevice.fromJson(_asJsonMap(data['device']));
    final deviceSecret = data['deviceSecret'] as String?;
    if (deviceSecret == null || deviceSecret.isEmpty) {
      throw EcoCenterException.native('device-register omitted deviceSecret.');
    }
    _credentials = _credentials.copyWith(
      deviceId: device.id,
      deviceSecret: deviceSecret,
      deviceName: device.name,
      clearDeviceSession: true,
    );
    await _store.save(_credentials);
    return device;
  }

  Future<void> ensureMobileDevice({bool syncProfile = false}) async {
    if (_credentials.hasDeviceCredentials) {
      if (syncProfile) {
        await syncDeviceProfile();
      }
      return;
    }
    await registerMobileDevice();
  }

  Future<PublicDevice> syncDeviceProfile() async {
    if (!_credentials.hasDeviceCredentials || _credentials.deviceId == null) {
      throw EcoCenterException.app(
        EcoCenterErrorKind.deviceCredentialsRequired,
      );
    }
    final client = await _ensureSupabaseClient();
    await _ensureUserAccessToken();
    final profile = await DeviceProfile.collect();
    final result = await client.rpc(
      'eco_update_device_profile',
      params: {
        'p_device_id': _credentials.deviceId!,
        'p_name': profile.displayName,
        'p_metadata': profile.toMetadata(),
      },
    );
    final rows = result is List ? result : const <dynamic>[];
    if (rows.length != 1) {
      throw EcoCenterException.native(
        'eco_update_device_profile returned ${rows.length} rows.',
      );
    }
    final device = _deviceFromRow(_asJsonMap(rows.single));
    _credentials = _credentials.copyWith(deviceName: device.name);
    await _store.save(_credentials);
    return device;
  }

  /// Manual code entry without bootstrap token is not supported on Supabase
  /// Center (pairing-join requires bootstrapToken). Prefer QR quick join.
  Future<DeviceBinding> claimPairing(String code) async {
    throw EcoCenterException.app(EcoCenterErrorKind.quickPairQrOutdated);
  }

  Future<QuickPairingResult> quickJoinFromQr(PairingQrPayload payload) async {
    if (!payload.canQuickJoin) {
      throw EcoCenterException.app(EcoCenterErrorKind.quickPairQrOutdated);
    }
    final projectUrl = normalizeSupabaseProjectUrl(payload.projectUrl!);
    final anonFromQr = payload.anonKey?.trim();
    final currentProject = _credentials.supabaseUrl.trim().isEmpty
        ? null
        : normalizeSupabaseProjectUrl(_credentials.supabaseUrl);
    final sameProject = currentProject == projectUrl;
    final anon = (anonFromQr != null && anonFromQr.isNotEmpty)
        ? anonFromQr
        : (sameProject ? (_credentials.anonKey?.trim() ?? '') : '');
    if (anon.isEmpty) {
      throw EcoCenterException.app(EcoCenterErrorKind.anonKeyRequired);
    }

    final reachable = await testConnection(projectUrl, anonKey: anon);
    if (!reachable) {
      throw EcoCenterException.app(EcoCenterErrorKind.serverUnreachable);
    }

    await setProjectConfig(supabaseUrl: projectUrl, anonKey: anon);
    if (!_credentials.hasUserSession) {
      throw EcoCenterException.app(
        EcoCenterErrorKind.reauthRequired,
        recovery: CenterServerAuthRecovery.relogin,
      );
    }
    await ensureMobileDevice();

    final client = await _ensureSupabaseClient();
    await _ensureUserAccessToken();
    final profile = await DeviceProfile.collect();
    final response = await client.functions.invoke(
      EcoSupabaseFunctions.pairingJoin,
      body: {
        'code': payload.code,
        'bootstrapToken': payload.bootstrapToken,
        'mobileDeviceId': _credentials.deviceId,
        'deviceSecret': _credentials.deviceSecret,
        'deviceName': profile.displayName,
        'metadata': profile.toMetadata(),
      },
    );
    final data = _requireFunctionJson(response);
    final binding = DeviceBinding.fromJson(_asJsonMap(data['binding']));
    final desktopDeviceId =
        data['desktopDeviceId'] as String? ?? binding.desktopDeviceId;

    _credentials = _credentials.copyWith(
      selectedDesktopId: desktopDeviceId,
      bindingId: binding.id,
    );
    await _store.save(_credentials);

    return QuickPairingResult(
      binding: binding,
      desktopDeviceId: desktopDeviceId,
      reusedMobileDevice: true,
      alreadyBound: false,
    );
  }

  Future<List<DeviceBinding>> listBindings() async {
    final client = await _ensureSupabaseClient();
    await _ensureUserAccessToken();
    final rows = await client
        .from('device_bindings')
        .select(
          'id, user_id, desktop_device_id, mobile_device_id, capabilities, created_at, revoked_at',
        )
        .filter('revoked_at', 'is', null)
        .order('created_at', ascending: false);
    return (rows as List<dynamic>)
        .map((row) => _bindingFromRow(_asJsonMap(row)))
        .toList();
  }

  /// Revoke a mobile↔desktop binding from this phone (PC does not need to be online).
  Future<DeviceBinding> revokeBinding(String bindingId) async {
    final trimmed = bindingId.trim();
    if (trimmed.isEmpty) {
      throw EcoCenterException.app(EcoCenterErrorKind.bindingRequired);
    }
    final client = await _ensureSupabaseClient();
    await _ensureUserAccessToken();
    final revokedAt = _now().toUtc().toIso8601String();
    final row = await client
        .from('device_bindings')
        .update({'revoked_at': revokedAt})
        .eq('id', trimmed)
        .select(
          'id, user_id, desktop_device_id, mobile_device_id, capabilities, created_at, revoked_at',
        )
        .single();
    final binding = _bindingFromRow(_asJsonMap(row));

    final selected = _credentials.selectedDesktopId;
    if (selected != null &&
        selected.isNotEmpty &&
        selected == binding.desktopDeviceId) {
      await setSelectedDesktop(null);
    } else if (_credentials.bindingId == binding.id) {
      _credentials = _credentials.copyWith(clearBindingId: true);
      await _store.save(_credentials);
      _teardownBindChannel();
    }
    return binding;
  }

  /// Disable a desktop device owned by this account (no device secret required).
  ///
  /// Used to remove lost / unreachable PCs from the account. Server also revokes
  /// any active bindings for that desktop.
  Future<PublicDevice> disableOwnedDesktop(String desktopDeviceId) async {
    final trimmed = desktopDeviceId.trim();
    if (trimmed.isEmpty) {
      throw EcoCenterException.app(EcoCenterErrorKind.bindingRequired);
    }
    final client = await _ensureSupabaseClient();
    await _ensureUserAccessToken();
    final response = await client.functions.invoke(
      EcoSupabaseFunctions.deviceDisable,
      body: {'deviceId': trimmed, 'kind': 'desktop'},
    );
    final data = _requireFunctionJson(response);
    final device = PublicDevice.fromJson(_asJsonMap(data['device']));

    final selected = _credentials.selectedDesktopId;
    if (selected != null && selected.isNotEmpty && selected == trimmed) {
      await setSelectedDesktop(null);
    }
    _onlineDesktopDeviceIds.remove(trimmed);
    return device;
  }

  Future<List<PublicDevice>> listPresence() async {
    final client = await _ensureSupabaseClient();
    await _ensureUserAccessToken();
    final rows = await client
        .from('devices_public')
        .select(
          'id, user_id, kind, name, metadata, created_at, last_seen_at, disabled_at',
        )
        .eq('kind', 'desktop')
        .filter('disabled_at', 'is', null);
    return (rows as List<dynamic>).map((row) {
      final device = _deviceFromRow(_asJsonMap(row));
      return device.copyWith(
        online: _presenceChannel == null
            ? null
            : _onlineDesktopDeviceIds.contains(device.id),
      );
    }).toList();
  }

  /// Opens only the shared user Presence channel for the PC picker.
  ///
  /// This intentionally leaves [hasActiveBindingChannel] false. [connect]
  /// promotes the transport to the bind/RPC session when `/threads` mounts.
  Future<void> connectPresence() async {
    // A full session connection already includes Presence. Reuse it instead of
    // racing a second auth/channel setup while /threads is mounting. If the
    // caller just left /threads, wait for its intentional shutdown first.
    final fullInFlight = _connectInFlight;
    if (fullInFlight != null) {
      try {
        await fullInFlight;
        return;
      } catch (_) {
        // The old full connection was cancelled or failed; start Presence-only
        // below once its in-flight future has settled.
      }
    }

    _intentionallyStopped = false;
    if (_presenceChannel != null) {
      // Reuse the live Presence socket, but keep bind/RPC deferred for the picker.
      _presenceOnlyMode = true;
      return;
    }

    final existing = _presenceConnectInFlight;
    if (existing != null) {
      await existing;
      return;
    }

    _presenceOnlyMode = true;
    _clearReconnectTimer();
    late Future<void> tracked;
    tracked = _connectPresenceOnce().whenComplete(() {
      if (identical(_presenceConnectInFlight, tracked)) {
        _presenceConnectInFlight = null;
      }
    });
    _presenceConnectInFlight = tracked;
    return tracked;
  }

  Future<void> connect() async {
    _intentionallyStopped = false;
    if (_status.state == EcoConnectionState.connected &&
        hasActiveBindingChannel &&
        _presenceChannel?.canPush == true) {
      return;
    }

    // Let an in-flight picker Presence handshake finish before promoting the
    // transport to a full bind/RPC session.
    final presenceInFlight = _presenceConnectInFlight;
    if (presenceInFlight != null) {
      try {
        await presenceInFlight;
      } catch (_) {
        // The full connection retries auth and Presence below.
      }
    }
    if (_intentionallyStopped) {
      throw EcoCenterException.app(EcoCenterErrorKind.connectionAborted);
    }

    final existing = _connectInFlight;
    if (existing != null) {
      return existing;
    }

    _presenceOnlyMode = false;
    late Future<void> tracked;
    tracked = _connectOnce().whenComplete(() {
      if (identical(_connectInFlight, tracked)) {
        _connectInFlight = null;
      }
    });
    _connectInFlight = tracked;
    return tracked;
  }

  void disconnect() {
    _intentionallyStopped = true;
    _clearReconnectTimer();
    _clearKeepalive();
    _clearDeviceSessionRefresh();
    _teardownBindChannel();
    _teardownPresenceChannel();
    _presenceOnlyMode = false;
    _emitStatus(
      const CenterServerConnectionStatus(
        state: EcoConnectionState.disconnected,
      ),
    );
  }

  Future<void> clearSession() async {
    disconnect();
    try {
      await _supabase?.auth.signOut();
    } catch (_) {}
    await _store.clearSession();
    _credentials = _credentials.copyWith(
      clearUserSession: true,
      clearDeviceCredentials: true,
      clearSelectedDesktop: true,
      clearBindingId: true,
      clearUserEmail: true,
    );
  }

  /// Drop expired Auth tokens so the UI can force re-login.
  ///
  /// Keeps project config, device credentials, selected desktop, and email
  /// (for the login form). Stops reconnect so we do not keep toasting.
  Future<void> invalidateExpiredUserSession() async {
    disconnect();
    try {
      await _supabase?.auth.signOut();
    } catch (_) {}
    final email = _credentials.userEmail;
    _credentials = _credentials.copyWith(
      clearUserSession: true,
      userEmail: email,
    );
    await _store.save(_credentials);
    _emitStatus(
      const CenterServerConnectionStatus(
        state: EcoConnectionState.disconnected,
      ),
    );
  }

  Future<T> invoke<T>(
    String desktopDeviceId,
    String channel,
    List<dynamic> args, {
    int? deadlineMs,
  }) async {
    if (_bindChannel == null || _status.state != EcoConnectionState.connected) {
      throw EcoCenterException.app(EcoCenterErrorKind.websocketDisconnected);
    }
    final id = 'mobile_req_${++_rpcCounter}';
    final completer = Completer<dynamic>();
    // Disconnect may reject this completer while _sendRpc is still awaiting,
    // before invoke attaches its normal await below. Observe the same Future
    // immediately so that early rejection is not reported as an uncaught zone
    // error; invoke still awaits this Future and receives the original error.
    unawaited(
      completer.future.then<void>((_) {}, onError: (Object _, StackTrace _) {}),
    );
    _pendingInvokes[id] = completer;

    final request = buildEcoInvokeRequest(
      id: id,
      desktopDeviceId: desktopDeviceId,
      channel: channel,
      args: args,
      deadlineMs: deadlineMs ?? defaultInvokeTimeoutMs,
    );

    try {
      await _sendRpc(request);
      final result = await completer.future.timeout(
        Duration(milliseconds: deadlineMs ?? defaultInvokeTimeoutMs),
        onTimeout: () {
          _pendingInvokes.remove(id);
          throw EcoCenterException.app(
            EcoCenterErrorKind.rpcTimeout,
            code: EcoRpcConstants.timeout,
          );
        },
      );
      return unwrapInvokeResult<T>(result);
    } catch (error) {
      _pendingInvokes.remove(id);
      if (error is EcoCenterException &&
          error.kind == EcoCenterErrorKind.rpcTimeout) {
        unawaited(_probeTransport());
      } else if (error is EcoCenterException &&
          error.kind == EcoCenterErrorKind.websocketDisconnected) {
        _markTransportUnhealthy(error);
      }
      rethrow;
    }
  }

  /// Sends `eco.ping` on the bind channel and waits for a JSON-RPC response.
  Future<void> ping({int timeoutMs = 10000}) async {
    if (_bindChannel == null) {
      throw EcoCenterException.app(EcoCenterErrorKind.websocketDisconnected);
    }
    final id = 'ping_${++_rpcCounter}';
    final completer = Completer<dynamic>();
    // Keep disconnect errors observed even if _sendRpc has not returned yet.
    unawaited(
      completer.future.then<void>((_) {}, onError: (Object _, StackTrace _) {}),
    );
    _pendingInvokes[id] = completer;
    try {
      await _sendRpc(buildEcoPingRequest(id));
      await completer.future.timeout(
        Duration(milliseconds: timeoutMs),
        onTimeout: () {
          _pendingInvokes.remove(id);
          throw EcoCenterException.app(
            EcoCenterErrorKind.rpcTimeout,
            code: EcoRpcConstants.timeout,
          );
        },
      );
    } finally {
      _pendingInvokes.remove(id);
    }
  }

  static T unwrapInvokeResult<T>(dynamic result) {
    if (result is Map<String, dynamic> && result.containsKey('result')) {
      return result['result'] as T;
    }
    return result as T;
  }

  Future<void> dispose() async {
    disconnect();
    await _resetSupabaseClient();
    await _connectionController.close();
    await _eventController.close();
  }

  // --- internals ---

  Future<PublicUser> _applyAuthSession(User user, Session session) async {
    final email = user.email ?? '';
    final displayName =
        user.userMetadata?['display_name'] as String? ??
        user.userMetadata?['displayName'] as String?;
    final sameAccount = _credentials.userId == user.id;
    _credentials = _credentials.copyWith(
      userId: user.id,
      userEmail: email,
      userDisplayName: displayName,
      userRefreshToken: session.refreshToken,
      userAccessToken: session.accessToken,
      userAccessTokenExpiresAt: DateTime.fromMillisecondsSinceEpoch(
        session.expiresAt! * 1000,
        isUtc: true,
      ).toIso8601String(),
      clearDeviceCredentials: !sameAccount,
      clearSelectedDesktop: !sameAccount,
      clearBindingId: !sameAccount,
    );
    await _store.save(_credentials);
    return PublicUser(
      id: user.id,
      email: email,
      displayName: displayName,
      createdAt: user.createdAt,
    );
  }

  Future<void> _restoreSessionIfNeeded() async {
    final refresh = _credentials.userRefreshToken;
    if (refresh == null || refresh.isEmpty || _supabase == null) return;
    try {
      final current = _supabase!.auth.currentSession;
      if (current != null) return;
      await _supabase!.auth.setSession(refresh);
      final session = _supabase!.auth.currentSession;
      final user = _supabase!.auth.currentUser;
      if (session != null && user != null) {
        await _applyAuthSession(user, session);
      }
    } catch (_) {
      // Leave stored tokens; login flow can recover.
    }
  }

  Future<SupabaseClient> _ensureSupabaseClient() async {
    _requireProjectConfig();
    final url = normalizeSupabaseProjectUrl(_credentials.supabaseUrl);
    final anon = _credentials.anonKey!.trim();
    if (_supabase != null && _clientUrl == url && _clientAnonKey == anon) {
      return _supabase!;
    }
    await _resetSupabaseClient();
    _supabase = SupabaseClient(url, anon);
    _clientUrl = url;
    _clientAnonKey = anon;
    await _authSub?.cancel();
    _authSub = _supabase!.auth.onAuthStateChange.listen((state) {
      final session = state.session;
      if (session == null) return;
      unawaited(
        _store.save(
          _credentials = _credentials.copyWith(
            userAccessToken: session.accessToken,
            userRefreshToken: session.refreshToken,
            userAccessTokenExpiresAt: session.expiresAt == null
                ? null
                : DateTime.fromMillisecondsSinceEpoch(
                    session.expiresAt! * 1000,
                    isUtc: true,
                  ).toIso8601String(),
          ),
        ),
      );
      if (!_intentionallyStopped && _credentials.hasDeviceCredentials) {
        unawaited(_authorizeRefreshedRealtimeSession(session.accessToken));
      }
    });
    return _supabase!;
  }

  Future<void> _resetSupabaseClient() async {
    final client = _supabase;
    _teardownBindChannel();
    _teardownPresenceChannel();
    await _authSub?.cancel();
    _authSub = null;
    _supabase = null;
    _clientUrl = null;
    _clientAnonKey = null;
    await client?.dispose();
  }

  Future<String> _ensureUserAccessToken() async {
    final client = await _ensureSupabaseClient();
    var session = client.auth.currentSession;
    if (session != null &&
        tokenStillValid(
          DateTime.fromMillisecondsSinceEpoch(
            session.expiresAt! * 1000,
            isUtc: true,
          ).toIso8601String(),
          _now(),
        )) {
      return session.accessToken;
    }
    final refresh = _credentials.userRefreshToken;
    if (refresh == null || refresh.isEmpty) {
      throw EcoCenterException.app(
        EcoCenterErrorKind.userSessionExpired,
        recovery: CenterServerAuthRecovery.relogin,
      );
    }
    try {
      final recovered = await client.auth.setSession(refresh);
      session = recovered.session ?? client.auth.currentSession;
      if (session == null) {
        // setSession usually throws on Auth rejection; a null session without an
        // exception is treated as transient so we keep the refresh token.
        throw EcoCenterException.native(
          'Session refresh returned no session.',
          recovery: CenterServerAuthRecovery.network,
        );
      }
      final user = recovered.user ?? client.auth.currentUser;
      if (user != null) {
        await _applyAuthSession(user, session);
      }
      return session.accessToken;
    } catch (error) {
      if (error is EcoCenterException) rethrow;
      final message = _exceptionMessage(error);
      final recovery = recoveryForSessionRefreshFailure(message);
      throw EcoCenterException.native(message, recovery: recovery);
    }
  }

  Future<void> _registerDeviceSession(String accessToken) async {
    final deviceId = _credentials.deviceId;
    final deviceSecret = _credentials.deviceSecret;
    if (deviceId == null ||
        deviceId.isEmpty ||
        deviceSecret == null ||
        deviceSecret.isEmpty) {
      throw EcoCenterException.app(
        EcoCenterErrorKind.deviceCredentialsRequired,
      );
    }
    final client = await _ensureSupabaseClient();
    final response = await client.functions.invoke(
      EcoSupabaseFunctions.deviceSessionRegister,
      headers: {'authorization': 'Bearer $accessToken'},
      body: {
        'deviceId': deviceId,
        'deviceSecret': deviceSecret,
        'kind': 'mobile',
      },
    );
    _requireFunctionJson(response);
  }

  Future<void> _authorizeRefreshedRealtimeSession(String accessToken) async {
    final client = _supabase;
    if (client == null || _intentionallyStopped) return;
    try {
      await _registerDeviceSession(accessToken);
      if (_supabase != client || _intentionallyStopped) return;
      await client.realtime.setAuth(accessToken);
    } catch (error) {
      if (_supabase == client && !_intentionallyStopped) {
        _markTransportUnhealthy(error);
      }
    }
  }

  Future<void> _connectPresenceOnce() async {
    _requireProjectConfig();
    if (!_credentials.hasDeviceCredentials) {
      throw EcoCenterException.app(EcoCenterErrorKind.deviceCredentialsMissing);
    }

    try {
      final accessToken = await _ensureUserAccessToken();
      await _registerDeviceSession(accessToken);
      await _supabase!.realtime.setAuth(accessToken);
      if (_intentionallyStopped) {
        throw EcoCenterException.app(EcoCenterErrorKind.connectionAborted);
      }

      await _subscribeUserPresence();
      if (_intentionallyStopped) {
        _teardownPresenceChannel();
        throw EcoCenterException.app(EcoCenterErrorKind.connectionAborted);
      }
      // Presence-only mode must not make the setup page look like the bind
      // channel is ready. Keep the full transport status disconnected.
      if (_status.state == EcoConnectionState.error) {
        _emitStatus(
          const CenterServerConnectionStatus(
            state: EcoConnectionState.disconnected,
          ),
        );
      }
      _reconnectAttempts = 0;
    } catch (error) {
      _teardownPresenceChannel();
      if (_intentionallyStopped) {
        rethrow;
      }
      final message = _exceptionMessage(error);
      final recovery = _recoveryFromError(error);
      _emitStatus(
        CenterServerConnectionStatus(
          state: EcoConnectionState.error,
          lastError: message,
          authRecovery: recovery,
        ),
      );
      if (!_intentionallyStopped &&
          !shouldStopCenterServerReconnect(recovery)) {
        _scheduleReconnect();
      }
      rethrow;
    }
  }

  Future<void> _connectOnce() async {
    _clearReconnectTimer();
    _requireProjectConfig();
    if (!_credentials.hasDeviceCredentials) {
      throw EcoCenterException.app(EcoCenterErrorKind.deviceCredentialsMissing);
    }

    _emitStatus(
      const CenterServerConnectionStatus(state: EcoConnectionState.connecting),
    );

    try {
      final accessToken = await _ensureUserAccessToken();
      await _registerDeviceSession(accessToken);
      await _supabase!.realtime.setAuth(accessToken);
      if (_intentionallyStopped) {
        throw EcoCenterException.app(EcoCenterErrorKind.connectionAborted);
      }

      await _subscribeUserPresence();
      final bindingId = await _resolveBindingId();
      if (bindingId == null || bindingId.isEmpty) {
        final selectedDesktop = _credentials.selectedDesktopId;
        if (selectedDesktop != null && selectedDesktop.isNotEmpty) {
          _emitStatus(
            CenterServerConnectionStatus(
              state: EcoConnectionState.error,
              lastError: EcoCenterException.app(
                EcoCenterErrorKind.bindingRequired,
              ).message,
            ),
          );
        } else {
          _emitStatus(
            const CenterServerConnectionStatus(
              state: EcoConnectionState.disconnected,
            ),
          );
        }
        return;
      }

      await _subscribeBindChannel(bindingId);
      if (_intentionallyStopped) {
        throw EcoCenterException.app(EcoCenterErrorKind.connectionAborted);
      }

      await syncDeviceProfile();
      if (_intentionallyStopped) {
        throw EcoCenterException.app(EcoCenterErrorKind.connectionAborted);
      }
      // A subscribed mobile channel does not prove that the desktop has joined
      // the newly created binding. Verify the bidirectional RPC before exposing
      // connected to providers and starting their initial request burst.
      await ping(timeoutMs: 8000);
      if (_intentionallyStopped) {
        throw EcoCenterException.app(EcoCenterErrorKind.connectionAborted);
      }
      _reconnectAttempts = 0;
      _emitStatus(
        CenterServerConnectionStatus(
          state: EcoConnectionState.connected,
          connectedAt: _now().toIso8601String(),
        ),
      );
      _startKeepalive();
      _startDeviceSessionRefresh();
    } catch (error) {
      if (_intentionallyStopped) {
        rethrow;
      }
      final message = _exceptionMessage(error);
      final recovery = _recoveryFromError(error);
      _emitStatus(
        CenterServerConnectionStatus(
          state: EcoConnectionState.error,
          lastError: message,
          authRecovery: recovery,
        ),
      );
      if (!_intentionallyStopped &&
          !shouldStopCenterServerReconnect(recovery)) {
        _scheduleReconnect();
      }
      rethrow;
    }
  }

  Future<String?> _resolveBindingId() async {
    final selected = _credentials.selectedDesktopId;
    final mobileId = _credentials.deviceId;
    if (selected == null || mobileId == null) return null;

    final bindings = await listBindings();
    final cached = _credentials.bindingId;
    if (cached != null && cached.isNotEmpty) {
      final cachedStillValid = bindings.any(
        (b) =>
            b.id == cached &&
            b.isActive &&
            b.desktopDeviceId == selected &&
            b.mobileDeviceId == mobileId,
      );
      if (cachedStillValid) return cached;
    }

    final match = bindings.where(
      (b) =>
          b.isActive &&
          b.desktopDeviceId == selected &&
          b.mobileDeviceId == mobileId,
    );
    final existing = match.isEmpty ? null : match.first;
    if (existing != null) {
      _credentials = _credentials.copyWith(bindingId: existing.id);
      await _store.save(_credentials);
      return existing.id;
    }

    // Same-account auto-bind when user already selected a desktop.
    try {
      final ensured = await ensureBinding(selected);
      return ensured.id;
    } catch (_) {
      return null;
    }
  }

  Future<void> _subscribeBindChannel(String bindingId) async {
    final client = await _ensureSupabaseClient();
    _teardownBindChannel();
    final topic = EcoRealtimeTopics.bindTopic(bindingId);
    final channel = client.channel(
      topic,
      opts: const RealtimeChannelConfig(private: true, ack: true),
    );
    channel.onBroadcast(
      event: EcoRealtimeTopics.broadcastEvent,
      callback: (payload) {
        _handleBroadcastPayload(payload);
      },
    );
    await _awaitChannelSubscription(channel, topic);
    _bindChannel = channel;
    _subscribedBindingId = bindingId;
    final presence = _presenceChannel;
    if (presence == null || !presence.canPush) {
      throw EcoCenterException.app(EcoCenterErrorKind.websocketDisconnected);
    }
    final requestId = 'binding_${++_rpcCounter}';
    final ready = Completer<void>();
    unawaited(
      ready.future.then<void>((_) {}, onError: (Object _, StackTrace _) {}),
    );
    _pendingBindingReady[requestId] = ready;
    try {
      final notified = await sendEcoRealtimeBroadcast(
        presence,
        event: EcoRealtimeTopics.bindingsChangedEvent,
        payload: {
          'desktopDeviceId': _credentials.selectedDesktopId,
          'mobileDeviceId': _credentials.deviceId,
          'bindingId': bindingId,
          'requestId': requestId,
        },
      );
      if (notified != ChannelResponse.ok) {
        throw EcoCenterException.native(
          'Failed to notify desktop of binding ($notified).',
        );
      }
      await ready.future.timeout(
        const Duration(seconds: 10),
        onTimeout: () {
          throw EcoCenterException.native(
            'Desktop did not acknowledge its binding subscription within 10 seconds.',
          );
        },
      );
    } finally {
      _pendingBindingReady.remove(requestId);
    }
  }

  void _teardownBindChannel() {
    final channel = _bindChannel;
    _bindChannel = null;
    _subscribedBindingId = null;
    if (channel != null) {
      unawaited(channel.unsubscribe());
    }
    for (final pending in _pendingInvokes.values) {
      if (!pending.isCompleted) {
        pending.completeError(
          EcoCenterException.app(EcoCenterErrorKind.websocketDisconnected),
        );
      }
    }
    _pendingInvokes.clear();
    for (final ready in _pendingBindingReady.values) {
      if (!ready.isCompleted) {
        ready.completeError(
          EcoCenterException.app(EcoCenterErrorKind.websocketDisconnected),
        );
      }
    }
    _pendingBindingReady.clear();
  }

  Future<void> _subscribeUserPresence() async {
    final userId = _credentials.userId;
    final deviceId = _credentials.deviceId;
    if (userId == null ||
        userId.isEmpty ||
        deviceId == null ||
        deviceId.isEmpty) {
      throw EcoCenterException.app(EcoCenterErrorKind.reauthRequired);
    }
    if (_presenceChannel != null) return;

    final client = await _ensureSupabaseClient();
    final topic = EcoRealtimeTopics.userTopic(userId);
    final channel = client.channel(
      topic,
      opts: RealtimeChannelConfig(private: true, key: deviceId, enabled: true),
    );
    final presenceSynced = Completer<void>();
    channel.onBroadcast(
      event: EcoRealtimeTopics.bindingReadyEvent,
      callback: (event) {
        final raw = event['payload'] ?? event;
        if (raw is! Map ||
            raw['desktopDeviceId'] != _credentials.selectedDesktopId ||
            raw['mobileDeviceId'] != _credentials.deviceId ||
            raw['bindingId'] != _credentials.bindingId) {
          return;
        }
        final ready = _pendingBindingReady[raw['requestId']];
        if (ready != null && !ready.isCompleted) ready.complete();
      },
    );
    void refreshPresence() => _refreshPresenceState(channel);
    channel
      ..onPresenceSync((_) {
        refreshPresence();
        if (!presenceSynced.isCompleted) {
          presenceSynced.complete();
        }
      })
      ..onPresenceJoin((_) => refreshPresence())
      ..onPresenceLeave((_) => refreshPresence());

    try {
      await _awaitChannelSubscription(
        channel,
        topic,
        onSubscribed: () async {
          final trackedAt = _now().toUtc().toIso8601String();
          final tracked = await channel.track({
            'deviceId': deviceId,
            'deviceKind': 'mobile',
            'online': true,
            'connectedAt': trackedAt,
            'lastSeenAt': trackedAt,
          });
          if (tracked != ChannelResponse.ok) {
            throw EcoCenterException.native(
              'Failed to track presence on $topic ($tracked).',
            );
          }
        },
      );
    } catch (_) {
      await channel.unsubscribe();
      rethrow;
    }
    _presenceChannel = channel;
    _refreshPresenceState(channel);
    await presenceSynced.future.timeout(
      const Duration(seconds: 2),
      onTimeout: () {},
    );
  }

  Future<void> _awaitChannelSubscription(
    RealtimeChannel channel,
    String topic, {
    Future<void> Function()? onSubscribed,
  }) async {
    void reportUnhealthy(EcoCenterException exception) {
      if (_intentionallyStopped ||
          (!identical(_bindChannel, channel) &&
              !identical(_presenceChannel, channel))) {
        return;
      }
      if (identical(_bindChannel, channel)) {
        _teardownBindChannel();
      }
      if (identical(_presenceChannel, channel)) {
        _teardownPresenceChannel();
      }
      if (!_presenceOnlyMode) {
        _emitStatus(
          CenterServerConnectionStatus(
            state: EcoConnectionState.error,
            lastError: exception.message,
          ),
        );
      }
      _scheduleReconnect();
    }

    final lifecycle = EcoChannelSubscriptionLifecycle(
      topic: topic,
      onSubscribed: onSubscribed ?? () async {},
      onUnhealthy: reportUnhealthy,
    );
    channel.subscribe((status, error) {
      lifecycle.handle(switch (status) {
        RealtimeSubscribeStatus.subscribed =>
          EcoChannelSubscribeStatus.subscribed,
        RealtimeSubscribeStatus.channelError =>
          EcoChannelSubscribeStatus.channelError,
        RealtimeSubscribeStatus.timedOut => EcoChannelSubscribeStatus.timedOut,
        RealtimeSubscribeStatus.closed => EcoChannelSubscribeStatus.closed,
      }, error);
    }, const Duration(seconds: 10));
    await lifecycle.initialSubscription;
  }

  void _refreshPresenceState(RealtimeChannel channel) {
    if (_presenceChannel != null && !identical(_presenceChannel, channel)) {
      return;
    }
    final next = <String>{};
    for (final state in channel.presenceState()) {
      final desktop = state.presences.any((presence) {
        final payload = presence.payload;
        return payload['deviceKind'] == 'desktop' && payload['online'] != false;
      });
      if (desktop) next.add(state.key);
    }
    if (_onlineDesktopDeviceIds.length == next.length &&
        _onlineDesktopDeviceIds.containsAll(next)) {
      return;
    }
    _onlineDesktopDeviceIds
      ..clear()
      ..addAll(next);
    final occurredAt = _now().toUtc().toIso8601String();
    _eventController.add(
      EcoEventEnvelope(
        id: 'presence_$occurredAt',
        kind: 'presence.device',
        source: 'supabase.realtime',
        occurredAt: occurredAt,
        payload: {'onlineDeviceIds': next.toList(growable: false)},
      ),
    );
  }

  void _teardownPresenceChannel() {
    final channel = _presenceChannel;
    _presenceChannel = null;
    _onlineDesktopDeviceIds.clear();
    if (channel != null) {
      unawaited(channel.unsubscribe());
    }
  }

  Future<void> _sendRpc(Map<String, dynamic> message) async {
    final channel = _bindChannel;
    // Supabase falls back to HTTP Broadcast when canPush is false, but an RPC
    // response can only return through the subscribed Realtime channel.
    if (channel == null || !channel.canPush) {
      throw EcoCenterException.app(EcoCenterErrorKind.websocketDisconnected);
    }
    final envelope = wrapEcoRpcForBroadcast(message);
    final result = await sendEcoRealtimeBroadcast(
      channel,
      event: EcoRealtimeTopics.broadcastEvent,
      payload: envelope,
    );
    if (result != ChannelResponse.ok) {
      throw EcoCenterException(
        'eco_center.${EcoCenterErrorKind.websocketDisconnected.name}',
        kind: EcoCenterErrorKind.websocketDisconnected,
        nativeMessage: 'Realtime broadcast failed ($result).',
      );
    }
  }

  void _handleBroadcastPayload(Map<String, dynamic> payload) {
    // supabase_flutter may nest under `payload` or deliver envelope directly.
    final raw = payload['payload'] ?? payload;
    final message =
        unwrapEcoRpcFromBroadcast(raw) ??
        (raw is Map ? Map<String, dynamic>.from(raw) : null);
    if (message == null) return;

    if (message.containsKey('method') && !message.containsKey('id')) {
      final method = message['method'] as String?;
      if (method == EcoRpcConstants.methodEvent) {
        final params = message['params'];
        if (params is Map<String, dynamic>) {
          _eventController.add(EcoEventEnvelope.fromJson(params));
        } else if (params is Map) {
          _eventController.add(
            EcoEventEnvelope.fromJson(Map<String, dynamic>.from(params)),
          );
        }
      }
      return;
    }

    final id = message['id'];
    if (id == null) return;
    final pending = _pendingInvokes.remove(id.toString());
    if (pending == null) return;

    if (message.containsKey('error')) {
      pending.completeError(ecoCenterExceptionFromRpcError(message['error']));
      return;
    }

    pending.complete(message['result']);
  }

  void _scheduleReconnect() {
    _clearReconnectTimer();
    final delay = ecoRealtimeReconnectDelayMs(
      reconnectDelayMs,
      _reconnectAttempts++,
    );
    _reconnectTimer = Timer(Duration(milliseconds: delay), () {
      if (!_intentionallyStopped) {
        if (!AppLifecycleTracker.isForeground) {
          _scheduleReconnect();
          return;
        }
        if (_presenceOnlyMode) {
          unawaited(connectPresence().catchError((Object _) {}));
        } else {
          // _connectOnce publishes the concrete error state before rethrowing.
          unawaited(_connectOnce().catchError((Object _) {}));
        }
      }
    });
  }

  void _clearReconnectTimer() {
    _reconnectTimer?.cancel();
    _reconnectTimer = null;
  }

  void _startKeepalive() {
    _clearKeepalive();
    _keepaliveTimer = Timer.periodic(const Duration(seconds: 25), (_) {
      // Skip probe when app is in background to save battery.
      // WebSocket protocol-level ping/pong still runs; we only skip the
      // application-level transport health check.
      if (!AppLifecycleTracker.isForeground) return;
      unawaited(_probeTransport());
    });
  }

  Future<void> _probeTransport() async {
    if (_transportProbeInFlight ||
        _intentionallyStopped ||
        _bindChannel == null ||
        _status.state != EcoConnectionState.connected) {
      return;
    }
    final probedChannel = _bindChannel;
    _transportProbeInFlight = true;
    try {
      await ping(timeoutMs: 8000);
    } catch (error) {
      if (identical(_bindChannel, probedChannel)) {
        _markTransportUnhealthy(error);
      }
    } finally {
      _transportProbeInFlight = false;
    }
  }

  void _markTransportUnhealthy(Object error) {
    if (_intentionallyStopped) return;
    _clearKeepalive();
    _clearDeviceSessionRefresh();
    _teardownBindChannel();
    _teardownPresenceChannel();
    final recovery = _recoveryFromError(error);
    _emitStatus(
      CenterServerConnectionStatus(
        state: EcoConnectionState.error,
        lastError: _exceptionMessage(error),
        authRecovery: recovery,
      ),
    );
    if (!shouldStopCenterServerReconnect(recovery)) {
      _scheduleReconnect();
    }
  }

  void _clearKeepalive() {
    _keepaliveTimer?.cancel();
    _keepaliveTimer = null;
  }

  void _startDeviceSessionRefresh() {
    _clearDeviceSessionRefresh();
    _deviceSessionRefreshTimer = Timer.periodic(
      const Duration(seconds: 30),
      (_) => unawaited(_refreshDeviceSessionAuthorization()),
    );
  }

  Future<void> _refreshDeviceSessionAuthorization() async {
    if (_intentionallyStopped || !AppLifecycleTracker.isForeground) return;
    try {
      final accessToken = await _ensureUserAccessToken();
      await _registerDeviceSession(accessToken);
      final client = _supabase;
      if (client == null || _intentionallyStopped) return;
      await client.realtime.setAuth(accessToken);
    } catch (error) {
      _markTransportUnhealthy(error);
    }
  }

  void _clearDeviceSessionRefresh() {
    _deviceSessionRefreshTimer?.cancel();
    _deviceSessionRefreshTimer = null;
  }

  void _emitStatus(CenterServerConnectionStatus status) {
    _status = status;
    final previous = _lastEmittedStatus;
    if (previous != null &&
        previous.state == status.state &&
        previous.connectedAt == status.connectedAt &&
        previous.lastError == status.lastError &&
        previous.authRecovery == status.authRecovery) {
      return;
    }
    _lastEmittedStatus = status;
    if (!_connectionController.isClosed) {
      _connectionController.add(status);
    }
  }

  void _requireProjectConfig() {
    if (_credentials.supabaseUrl.trim().isEmpty) {
      throw EcoCenterException.app(EcoCenterErrorKind.serverUrlRequired);
    }
    if (_credentials.anonKey == null || _credentials.anonKey!.trim().isEmpty) {
      throw EcoCenterException.app(EcoCenterErrorKind.anonKeyRequired);
    }
  }

  CenterServerAuthRecovery _recoveryFromError(Object error) {
    if (error is EcoCenterException && error.recovery != null) {
      return error.recovery!;
    }
    return classifyCenterServerAuthError(_exceptionMessage(error));
  }

  String _exceptionMessage(Object error) {
    if (error is EcoCenterException) {
      return error.nativeMessage ?? error.message;
    }
    return error.toString();
  }

  bool _looksLikeMissingEdgeFunction(String message) {
    final lower = message.toLowerCase();
    return lower.contains('function not found') ||
        lower.contains('requested function was not found') ||
        (lower.contains('edge function') && lower.contains('not found')) ||
        (lower.contains('pairing-join') && lower.contains('not deploy'));
  }

  JsonMap _requireFunctionJson(FunctionResponse response) {
    if (response.status >= 400) {
      final data = response.data;
      String message = 'Edge Function failed (${response.status}).';
      if (data is Map && data['error'] is String) {
        message = data['error'] as String;
      } else if (data is Map && data['message'] is String) {
        message = data['message'] as String;
      } else if (data is String && data.trim().isNotEmpty) {
        message = data;
      }
      if (_looksLikeMissingEdgeFunction(message) || response.status == 404) {
        throw EcoCenterException.app(EcoCenterErrorKind.serverOutdated);
      }
      throw EcoCenterException.native(message, code: response.status);
    }
    final data = response.data;
    if (data is Map<String, dynamic>) return data;
    if (data is Map) return Map<String, dynamic>.from(data);
    if (data is String) {
      final decoded = jsonDecode(data);
      if (decoded is Map) return Map<String, dynamic>.from(decoded);
    }
    throw EcoCenterException.native('Edge Function returned non-JSON body.');
  }

  JsonMap _asJsonMap(dynamic value) {
    if (value is Map<String, dynamic>) return value;
    if (value is Map) return Map<String, dynamic>.from(value);
    throw EcoCenterException.native('Expected JSON object.');
  }

  PublicDevice _deviceFromRow(JsonMap row) {
    if (row.containsKey('userId')) {
      return PublicDevice.fromJson(row);
    }
    return PublicDevice(
      id: row['id'] as String,
      userId: row['user_id'] as String? ?? '',
      kind: row['kind'] as String,
      name: row['name'] as String,
      createdAt: row['created_at'] as String? ?? '',
      metadata: PublicDeviceMetadata.fromJson(
        row['metadata'] is Map
            ? Map<String, dynamic>.from(row['metadata'] as Map)
            : null,
      ),
      lastSeenAt: row['last_seen_at'] as String?,
      disabledAt: row['disabled_at'] as String?,
    );
  }

  DeviceBinding _bindingFromRow(JsonMap row) {
    if (row.containsKey('userId')) {
      return DeviceBinding.fromJson(row);
    }
    return DeviceBinding(
      id: row['id'] as String,
      userId: row['user_id'] as String,
      desktopDeviceId: row['desktop_device_id'] as String,
      mobileDeviceId: row['mobile_device_id'] as String,
      capabilities: (row['capabilities'] as List<dynamic>? ?? const [])
          .map((e) => e as String)
          .toList(),
      createdAt: row['created_at'] as String,
      revokedAt: row['revoked_at'] as String?,
    );
  }
}

String parsePairingCodeFromQr(String raw) => parsePairingQrPayload(raw).code;

class PairingQrPayload {
  const PairingQrPayload({
    required this.code,
    this.serverUrl,
    this.supabaseUrl,
    this.anonKey,
    this.bootstrapToken,
  });

  /// Legacy pairing code; empty for `eco://center` server-only QR.
  final String code;

  /// Legacy QR param `server` (Center Server or Supabase URL).
  final String? serverUrl;

  /// Explicit Supabase project URL (`supabase` / `url` query params).
  final String? supabaseUrl;

  /// Optional anon key carried in QR (`anon` / `anonKey`).
  final String? anonKey;

  final String? bootstrapToken;

  String? get projectUrl {
    final explicit = supabaseUrl?.trim();
    if (explicit != null && explicit.isNotEmpty) return explicit;
    final legacy = serverUrl?.trim();
    if (legacy != null && legacy.isNotEmpty) return legacy;
    return null;
  }

  /// QR carries enough to fill project URL + anon (password login still required).
  bool get canConfigureServer =>
      projectUrl != null &&
      projectUrl!.isNotEmpty &&
      anonKey != null &&
      anonKey!.trim().isNotEmpty;

  /// @deprecated Prefer [canConfigureServer] + password login + select PC.
  bool get canQuickJoin =>
      canConfigureServer &&
      bootstrapToken != null &&
      bootstrapToken!.trim().isNotEmpty;
}

class QuickPairingResult {
  const QuickPairingResult({
    required this.binding,
    required this.desktopDeviceId,
    required this.reusedMobileDevice,
    required this.alreadyBound,
  });

  final DeviceBinding binding;
  final String desktopDeviceId;
  final bool reusedMobileDevice;
  final bool alreadyBound;
}

/// Parses connect / pairing QR.
/// Preferred: `eco://center?supabase=...&anon=...` (server only).
/// Legacy: `eco://pair?supabase=...&anon=...&code=...&token=...`
PairingQrPayload parsePairingQrPayload(String raw) {
  final trimmed = raw.trim();
  if (trimmed.startsWith('eco://center')) {
    final uri = Uri.parse(trimmed);
    final supabase =
        uri.queryParameters['supabase'] ??
        uri.queryParameters['url'] ??
        uri.queryParameters['supabaseUrl'];
    final server = uri.queryParameters['server'];
    final anon =
        uri.queryParameters['anon'] ??
        uri.queryParameters['anonKey'] ??
        uri.queryParameters['key'];
    if ((supabase == null || supabase.trim().isEmpty) &&
        (server == null || server.trim().isEmpty)) {
      throw EcoCenterException.app(EcoCenterErrorKind.invalidPairQr);
    }
    return PairingQrPayload(
      code: '',
      serverUrl: server,
      supabaseUrl: supabase,
      anonKey: anon,
    );
  }
  if (trimmed.startsWith('eco://pair')) {
    final uri = Uri.parse(trimmed);
    final code = uri.queryParameters['code'] ?? '';
    final supabase =
        uri.queryParameters['supabase'] ??
        uri.queryParameters['url'] ??
        uri.queryParameters['supabaseUrl'];
    final server = uri.queryParameters['server'];
    final anon =
        uri.queryParameters['anon'] ??
        uri.queryParameters['anonKey'] ??
        uri.queryParameters['key'];
    // Server-only pair QR (no code) is accepted as configure-server.
    if (code.trim().isEmpty &&
        (supabase == null || supabase.trim().isEmpty) &&
        (server == null || server.trim().isEmpty)) {
      throw EcoCenterException.app(EcoCenterErrorKind.invalidPairQr);
    }
    return PairingQrPayload(
      code: code.trim().isEmpty ? '' : code.trim().toUpperCase(),
      serverUrl: server,
      supabaseUrl: supabase,
      anonKey: anon,
      bootstrapToken: uri.queryParameters['token'],
    );
  }
  return PairingQrPayload(code: trimmed.toUpperCase());
}
