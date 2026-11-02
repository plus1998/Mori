import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../storage/credential_store.dart';

// Keep the existing key so upgrades preserve the user's switch setting.
const desktopAutoConnectEnabledStorageKey = 'eco.mobile.resume-session';

class DesktopAutoConnectPreference {
  const DesktopAutoConnectPreference({this.enabled = false});

  final bool enabled;

  static DesktopAutoConnectPreference read(SharedPreferences prefs) =>
      DesktopAutoConnectPreference(
        enabled: prefs.getBool(desktopAutoConnectEnabledStorageKey) ?? false,
      );

  /// Only used for launch. Returning to the picker never auto-connects.
  String launchLocation(AppCredentials credentials, String? desktopId) {
    if (!enabled ||
        !credentials.hasProjectConfig ||
        !credentials.isProvisioned ||
        desktopId == null ||
        desktopId.isEmpty) {
      return '/connect';
    }
    return '/threads';
  }
}

final desktopAutoConnectBootstrapProvider =
    Provider<DesktopAutoConnectPreference>(
      (ref) => const DesktopAutoConnectPreference(),
    );

final desktopAutoConnectPreferenceProvider =
    NotifierProvider<
      DesktopAutoConnectPreferenceNotifier,
      DesktopAutoConnectPreference
    >(DesktopAutoConnectPreferenceNotifier.new);

class DesktopAutoConnectPreferenceNotifier
    extends Notifier<DesktopAutoConnectPreference> {
  @override
  DesktopAutoConnectPreference build() =>
      ref.watch(desktopAutoConnectBootstrapProvider);

  Future<void> setEnabled(bool enabled) async {
    final prefs = await SharedPreferences.getInstance();
    if (!await prefs.setBool(desktopAutoConnectEnabledStorageKey, enabled)) {
      throw StateError('Could not save desktop auto-connect preference');
    }
    state = DesktopAutoConnectPreference(enabled: enabled);
  }
}
