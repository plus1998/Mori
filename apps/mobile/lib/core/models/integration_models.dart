const integrationIds = ['browser', 'imageGeneration', 'computerUse', 'tts'];

Map<String, bool>? normalizeIntegrationsEnabled(Object? value) {
  if (value is! Map) return null;
  final result = <String, bool>{};
  for (final id in integrationIds) {
    final enabled = value[id];
    if (enabled is bool) result[id] = enabled;
  }
  return result.isEmpty ? null : result;
}

class IntegrationAvailabilityItem {
  const IntegrationAvailabilityItem({
    required this.id,
    required this.enabled,
    required this.available,
    this.reason,
    this.activeProfileName,
  });

  factory IntegrationAvailabilityItem.fromJson(Map<String, dynamic> json) =>
      IntegrationAvailabilityItem(
        id: json['id'] as String? ?? '',
        enabled: json['enabled'] as bool? ?? false,
        available: json['available'] as bool? ?? false,
        reason: json['reason'] as String?,
        activeProfileName: json['activeProfileName'] as String?,
      );

  final String id;
  final bool enabled;
  final bool available;
  final String? reason;
  final String? activeProfileName;
}

class IntegrationAvailabilitySnapshot {
  const IntegrationAvailabilitySnapshot({required this.integrations});

  factory IntegrationAvailabilitySnapshot.fromJson(Map<String, dynamic> json) =>
      IntegrationAvailabilitySnapshot(
        integrations: (json['integrations'] as List<dynamic>? ?? const [])
            .whereType<Map<String, dynamic>>()
            .map(IntegrationAvailabilityItem.fromJson)
            .toList(growable: false),
      );

  final List<IntegrationAvailabilityItem> integrations;
}

class ProjectIntegrationsSettingsSnapshot {
  const ProjectIntegrationsSettingsSnapshot({
    required this.workspacePath,
    required this.enabled,
  });

  factory ProjectIntegrationsSettingsSnapshot.fromJson(
    Map<String, dynamic> json,
  ) => ProjectIntegrationsSettingsSnapshot(
    workspacePath: json['workspacePath'] as String? ?? '',
    enabled: normalizeIntegrationsEnabled(json['enabled']) ?? const {},
  );

  Map<String, dynamic> toJson() => {
    'workspacePath': workspacePath,
    'enabled': enabled,
  };

  final String workspacePath;
  final Map<String, bool> enabled;
}
