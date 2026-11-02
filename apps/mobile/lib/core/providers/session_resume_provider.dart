import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../storage/credential_store.dart';

const sessionResumeEnabledStorageKey = 'eco.mobile.resume-session';
const lastSessionStorageKey = 'eco.mobile.last-session';

class SavedSession {
  const SavedSession({
    required this.serverUrl,
    required this.userId,
    required this.desktopId,
    required this.threadId,
  });

  final String serverUrl;
  final String userId;
  final String desktopId;
  final String threadId;

  List<String> get storageValue => [serverUrl, userId, desktopId, threadId];

  bool matches(AppCredentials credentials, String selectedDesktopId) =>
      serverUrl == credentials.supabaseUrl &&
      userId == credentials.userId &&
      desktopId == selectedDesktopId;
}

class SessionResumePreference {
  const SessionResumePreference({this.enabled = false, this.lastSession});

  final bool enabled;
  final SavedSession? lastSession;

  static SessionResumePreference read(SharedPreferences prefs) {
    final saved = prefs.getStringList(lastSessionStorageKey);
    return SessionResumePreference(
      enabled: prefs.getBool(sessionResumeEnabledStorageKey) ?? false,
      lastSession:
          saved != null && saved.length == 4 && saved.every((v) => v.isNotEmpty)
          ? SavedSession(
              serverUrl: saved[0],
              userId: saved[1],
              desktopId: saved[2],
              threadId: saved[3],
            )
          : null,
    );
  }

  /// Only used for the launch route. Returning to the picker never resumes.
  String launchLocation(AppCredentials credentials, String? desktopId) {
    if (!enabled ||
        !credentials.hasProjectConfig ||
        !credentials.isProvisioned ||
        desktopId == null ||
        desktopId.isEmpty) {
      return '/connect';
    }
    final saved = lastSession;
    if (saved == null) return '/threads';
    if (!saved.matches(credentials, desktopId)) return '/connect';
    return '/threads/${Uri.encodeComponent(saved.threadId)}';
  }
}

final sessionResumeBootstrapProvider = Provider<SessionResumePreference>(
  (ref) => const SessionResumePreference(),
);

final sessionResumePreferenceProvider =
    NotifierProvider<SessionResumePreferenceNotifier, SessionResumePreference>(
      SessionResumePreferenceNotifier.new,
    );

class SessionResumePreferenceNotifier
    extends Notifier<SessionResumePreference> {
  @override
  SessionResumePreference build() => ref.watch(sessionResumeBootstrapProvider);

  Future<void> setEnabled(bool enabled) async {
    final prefs = await SharedPreferences.getInstance();
    if (!await prefs.setBool(sessionResumeEnabledStorageKey, enabled)) {
      throw StateError('Could not save session resume preference');
    }
    state = SessionResumePreference(
      enabled: enabled,
      lastSession: state.lastSession,
    );
  }

  Future<void> remember(SavedSession session) async {
    final prefs = await SharedPreferences.getInstance();
    if (!await prefs.setStringList(
      lastSessionStorageKey,
      session.storageValue,
    )) {
      throw StateError('Could not save last session');
    }
    state = SessionResumePreference(
      enabled: state.enabled,
      lastSession: session,
    );
  }
}
