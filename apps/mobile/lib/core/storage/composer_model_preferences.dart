import 'dart:convert';

import 'package:shared_preferences/shared_preferences.dart';

import '../models/thread_models.dart';

/// Model choices belong to a desktop, project, core and main-agent template.
/// Session snapshots themselves must never become defaults for new sessions.
class ComposerModelPreferenceScope {
  const ComposerModelPreferenceScope({
    required this.desktopId,
    required this.workspacePath,
    required this.coreKind,
  });

  final String desktopId;
  final String workspacePath;
  final String coreKind;

  String? _key(ThreadRuntimeConfig config) {
    final mainAgentId = config.orchestrationSelection?.mainAgentConfigId;
    if (desktopId.isEmpty || coreKind == 'acp' || mainAgentId == null) {
      return null;
    }
    return 'eco.composer-model.${jsonEncode([desktopId, workspacePath, coreKind, mainAgentId])}';
  }

  Future<void> remember(ThreadRuntimeConfig config) async {
    final key = _key(config);
    if (key == null) return;
    final prefs = await SharedPreferences.getInstance();
    final override = config.mainAgentModelOverride;
    final saved = override == null
        ? await prefs.remove(key)
        : await prefs.setString(key, jsonEncode(override.toJson()));
    if (!saved) {
      throw StateError('Could not save the composer model preference.');
    }
  }

  Future<ThreadRuntimeConfig> restore(ThreadRuntimeConfig defaults) async {
    final key = _key(defaults);
    if (key == null) return defaults;
    final prefs = await SharedPreferences.getInstance();
    final raw = prefs.getString(key);
    if (raw == null) return defaults;
    return defaults.copyWith(
      mainAgentModelOverride: MainAgentModelOverride.fromJson(
        jsonDecode(raw) as Map<String, dynamic>,
      ),
    );
  }
}
