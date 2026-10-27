import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:shared_preferences/shared_preferences.dart';

class AppCredentials {
  const AppCredentials({
    required this.supabaseUrl,
    this.anonKey,
    this.deviceId,
    this.deviceSecret,
    this.userRefreshToken,
    this.userAccessToken,
    this.userAccessTokenExpiresAt,
    this.deviceRefreshToken,
    this.deviceAccessToken,
    this.deviceAccessTokenExpiresAt,
    this.deviceName,
    this.selectedDesktopId,
    this.userId,
    this.userEmail,
    this.userDisplayName,
    this.bindingId,
  });

  /// Project URL (Cloud or self-hosted). Replaces legacy Center Server URL.
  final String supabaseUrl;

  /// Public anon key (never service_role). Stored in secure storage.
  final String? anonKey;

  final String? deviceId;
  final String? deviceSecret;
  final String? userRefreshToken;
  final String? userAccessToken;
  final String? userAccessTokenExpiresAt;
  final String? deviceRefreshToken;
  final String? deviceAccessToken;
  final String? deviceAccessTokenExpiresAt;
  final String? deviceName;
  final String? selectedDesktopId;
  final String? userId;
  final String? userEmail;
  final String? userDisplayName;

  /// Active `device_bindings.id` for Realtime `eco:bind:{bindingId}`.
  final String? bindingId;

  /// Legacy alias used by setup status / older call sites.
  String get serverUrl => supabaseUrl;

  bool get hasProjectConfig =>
      supabaseUrl.trim().isNotEmpty &&
      anonKey != null &&
      anonKey!.trim().isNotEmpty;

  bool get hasUserSession =>
      userId != null &&
      userId!.isNotEmpty &&
      userEmail != null &&
      userEmail!.isNotEmpty &&
      userRefreshToken != null &&
      userRefreshToken!.isNotEmpty;

  bool get isProvisioned => hasDeviceCredentials && hasUserSession;

  bool get hasDeviceCredentials =>
      deviceId != null &&
      deviceId!.isNotEmpty &&
      deviceSecret != null &&
      deviceSecret!.isNotEmpty;

  AppCredentials copyWith({
    String? supabaseUrl,
    String? anonKey,
    String? deviceId,
    String? deviceSecret,
    String? userRefreshToken,
    String? userAccessToken,
    String? userAccessTokenExpiresAt,
    String? deviceRefreshToken,
    String? deviceAccessToken,
    String? deviceAccessTokenExpiresAt,
    String? deviceName,
    String? selectedDesktopId,
    String? userId,
    String? userEmail,
    String? userDisplayName,
    String? bindingId,
    bool clearAnonKey = false,
    bool clearDeviceSecret = false,
    bool clearUserSession = false,
    bool clearUserEmail = false,
    bool clearDeviceSession = false,
    bool clearDeviceCredentials = false,
    bool clearSelectedDesktop = false,
    bool clearBindingId = false,
  }) {
    return AppCredentials(
      supabaseUrl: supabaseUrl ?? this.supabaseUrl,
      anonKey: clearAnonKey ? null : (anonKey ?? this.anonKey),
      deviceId: clearDeviceCredentials ? null : (deviceId ?? this.deviceId),
      deviceSecret: clearDeviceSecret || clearDeviceCredentials
          ? null
          : (deviceSecret ?? this.deviceSecret),
      userRefreshToken: clearUserSession
          ? null
          : (userRefreshToken ?? this.userRefreshToken),
      userAccessToken: clearUserSession
          ? null
          : (userAccessToken ?? this.userAccessToken),
      userAccessTokenExpiresAt: clearUserSession
          ? null
          : (userAccessTokenExpiresAt ?? this.userAccessTokenExpiresAt),
      deviceRefreshToken: clearDeviceSession || clearDeviceCredentials
          ? null
          : (deviceRefreshToken ?? this.deviceRefreshToken),
      deviceAccessToken: clearDeviceSession || clearDeviceCredentials
          ? null
          : (deviceAccessToken ?? this.deviceAccessToken),
      deviceAccessTokenExpiresAt: clearDeviceSession || clearDeviceCredentials
          ? null
          : (deviceAccessTokenExpiresAt ?? this.deviceAccessTokenExpiresAt),
      deviceName: deviceName ?? this.deviceName,
      selectedDesktopId: clearSelectedDesktop
          ? null
          : (selectedDesktopId ?? this.selectedDesktopId),
      userId: clearUserSession ? null : (userId ?? this.userId),
      userEmail: clearUserEmail ? null : (userEmail ?? this.userEmail),
      userDisplayName: clearUserSession
          ? null
          : (userDisplayName ?? this.userDisplayName),
      bindingId:
          clearBindingId || clearDeviceCredentials || clearSelectedDesktop
          ? null
          : (bindingId ?? this.bindingId),
    );
  }
}

class CredentialStore {
  CredentialStore({FlutterSecureStorage? secureStorage})
    : _secure = secureStorage ?? const FlutterSecureStorage();

  static const _supabaseUrlKey = 'supabase_url';
  static const _serverUrlKey = 'server_url'; // legacy migration
  static const _anonKeyKey = 'supabase_anon_key';
  static const _deviceIdKey = 'device_id';
  static const _deviceSecretKey = 'device_secret';
  static const _refreshTokenKey = 'refresh_token';
  static const _accessTokenKey = 'access_token';
  static const _accessTokenExpiresAtKey = 'access_token_expires_at';
  static const _userRefreshTokenKey = 'user_refresh_token';
  static const _userAccessTokenKey = 'user_access_token';
  static const _userAccessTokenExpiresAtKey = 'user_access_token_expires_at';
  static const _deviceRefreshTokenKey = 'device_refresh_token';
  static const _deviceAccessTokenKey = 'device_access_token';
  static const _deviceAccessTokenExpiresAtKey =
      'device_access_token_expires_at';
  static const _deviceNameKey = 'device_name';
  static const _selectedDesktopIdKey = 'selected_desktop_id';
  static const _userIdKey = 'user_id';
  static const _userEmailKey = 'user_email';
  static const _userDisplayNameKey = 'user_display_name';
  static const _bindingIdKey = 'binding_id';

  final FlutterSecureStorage _secure;

  Future<AppCredentials> load() async {
    final prefs = await SharedPreferences.getInstance();
    final deviceId = await _secure.read(key: _deviceIdKey);
    final deviceSecret = await _secure.read(key: _deviceSecretKey);
    final hasLegacyDeviceCredentials =
        deviceId != null &&
        deviceId.isNotEmpty &&
        deviceSecret != null &&
        deviceSecret.isNotEmpty;
    final legacyRefreshToken = await _secure.read(key: _refreshTokenKey);
    final legacyAccessToken = await _secure.read(key: _accessTokenKey);
    final legacyAccessTokenExpiresAt = await _secure.read(
      key: _accessTokenExpiresAtKey,
    );

    final supabaseUrl =
        prefs.getString(_supabaseUrlKey) ??
        prefs.getString(_serverUrlKey) ??
        '';

    return AppCredentials(
      supabaseUrl: supabaseUrl,
      anonKey: await _secure.read(key: _anonKeyKey),
      deviceName: prefs.getString(_deviceNameKey) ?? 'Mori',
      selectedDesktopId: prefs.getString(_selectedDesktopIdKey),
      userId: prefs.getString(_userIdKey),
      userEmail: prefs.getString(_userEmailKey),
      userDisplayName: prefs.getString(_userDisplayNameKey),
      bindingId: prefs.getString(_bindingIdKey),
      deviceId: deviceId,
      deviceSecret: deviceSecret,
      userRefreshToken:
          await _secure.read(key: _userRefreshTokenKey) ??
          (hasLegacyDeviceCredentials ? null : legacyRefreshToken),
      userAccessToken:
          await _secure.read(key: _userAccessTokenKey) ??
          (hasLegacyDeviceCredentials ? null : legacyAccessToken),
      userAccessTokenExpiresAt:
          await _secure.read(key: _userAccessTokenExpiresAtKey) ??
          (hasLegacyDeviceCredentials ? null : legacyAccessTokenExpiresAt),
      deviceRefreshToken:
          await _secure.read(key: _deviceRefreshTokenKey) ??
          (hasLegacyDeviceCredentials ? legacyRefreshToken : null),
      deviceAccessToken:
          await _secure.read(key: _deviceAccessTokenKey) ??
          (hasLegacyDeviceCredentials ? legacyAccessToken : null),
      deviceAccessTokenExpiresAt:
          await _secure.read(key: _deviceAccessTokenExpiresAtKey) ??
          (hasLegacyDeviceCredentials ? legacyAccessTokenExpiresAt : null),
    );
  }

  Future<void> save(AppCredentials credentials) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_supabaseUrlKey, credentials.supabaseUrl);
    // Keep legacy key in sync so older readers / hot upgrades stay coherent.
    await prefs.setString(_serverUrlKey, credentials.supabaseUrl);
    if (credentials.deviceName != null) {
      await prefs.setString(_deviceNameKey, credentials.deviceName!);
    }
    if (credentials.selectedDesktopId != null) {
      await prefs.setString(
        _selectedDesktopIdKey,
        credentials.selectedDesktopId!,
      );
    } else {
      await prefs.remove(_selectedDesktopIdKey);
    }
    if (credentials.userEmail != null) {
      await prefs.setString(_userEmailKey, credentials.userEmail!);
    } else {
      await prefs.remove(_userEmailKey);
    }
    if (credentials.userId != null) {
      await prefs.setString(_userIdKey, credentials.userId!);
    } else {
      await prefs.remove(_userIdKey);
    }
    if (credentials.userDisplayName != null) {
      await prefs.setString(_userDisplayNameKey, credentials.userDisplayName!);
    } else {
      await prefs.remove(_userDisplayNameKey);
    }
    if (credentials.bindingId != null) {
      await prefs.setString(_bindingIdKey, credentials.bindingId!);
    } else {
      await prefs.remove(_bindingIdKey);
    }

    await _writeSecure(_anonKeyKey, credentials.anonKey);
    await _writeSecure(_deviceIdKey, credentials.deviceId);
    await _writeSecure(_deviceSecretKey, credentials.deviceSecret);
    await _writeSecure(_userRefreshTokenKey, credentials.userRefreshToken);
    await _writeSecure(_userAccessTokenKey, credentials.userAccessToken);
    await _writeSecure(
      _userAccessTokenExpiresAtKey,
      credentials.userAccessTokenExpiresAt,
    );
    await _writeSecure(_deviceRefreshTokenKey, credentials.deviceRefreshToken);
    await _writeSecure(_deviceAccessTokenKey, credentials.deviceAccessToken);
    await _writeSecure(
      _deviceAccessTokenExpiresAtKey,
      credentials.deviceAccessTokenExpiresAt,
    );
    await _secure.delete(key: _refreshTokenKey);
    await _secure.delete(key: _accessTokenKey);
    await _secure.delete(key: _accessTokenExpiresAtKey);
  }

  Future<void> clearSession() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove(_userEmailKey);
    await prefs.remove(_userIdKey);
    await prefs.remove(_userDisplayNameKey);
    await prefs.remove(_selectedDesktopIdKey);
    await prefs.remove(_bindingIdKey);
    await _secure.delete(key: _deviceIdKey);
    await _secure.delete(key: _deviceSecretKey);
    await _secure.delete(key: _refreshTokenKey);
    await _secure.delete(key: _accessTokenKey);
    await _secure.delete(key: _accessTokenExpiresAtKey);
    await _secure.delete(key: _userRefreshTokenKey);
    await _secure.delete(key: _userAccessTokenKey);
    await _secure.delete(key: _userAccessTokenExpiresAtKey);
    await _secure.delete(key: _deviceRefreshTokenKey);
    await _secure.delete(key: _deviceAccessTokenKey);
    await _secure.delete(key: _deviceAccessTokenExpiresAtKey);
  }

  Future<void> clearAll() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.clear();
    await _secure.deleteAll();
  }

  Future<void> _writeSecure(String key, String? value) async {
    if (value == null || value.isEmpty) {
      await _secure.delete(key: key);
      return;
    }
    await _secure.write(key: key, value: value);
  }
}
