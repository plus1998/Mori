import 'dart:convert';

import 'package:shared_preferences/shared_preferences.dart';

import '../models/thread_models.dart';

/// Model choices belong to a desktop, project and core.
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

  String? get _key {
    if (desktopId.isEmpty || coreKind == 'acp') {
      return null;
    }
    return 'eco.composer-main-model.${jsonEncode([desktopId, workspacePath, coreKind])}';
  }

  Future<void> remember(ThreadRuntimeConfig config) async {
    final key = _key;
    if (key == null) return;
    final prefs = await SharedPreferences.getInstance();
    final model = config.orchestrationSelection?.mainModel;
    final saved = model == null
        ? await prefs.remove(key)
        : await prefs.setString(key, jsonEncode(model.toJson()));
    if (!saved) {
      throw StateError('Could not save the composer model preference.');
    }
  }

  Future<ThreadRuntimeConfig> restore(ThreadRuntimeConfig defaults) async {
    final key = _key;
    if (key == null) return defaults;
    final prefs = await SharedPreferences.getInstance();
    final raw = prefs.getString(key);
    if (raw == null) return defaults;
    final model = OrchestrationModelRef.fromJson(
      jsonDecode(raw) as Map<String, dynamic>,
    );
    if (model.providerId.trim().isEmpty || model.modelId.trim().isEmpty) {
      throw const FormatException('Invalid remembered main model');
    }
    final selection =
        defaults.orchestrationSelection ?? emptyOrchestrationSelection();
    return defaults.copyWith(
      orchestrationSelection: selection.copyWith(
        mainAgentConfigId: '',
        mainModel: model,
      ),
      clearOrchestrationSnapshot: true,
      clearMainAgentModelOverride: true,
    );
  }
}
