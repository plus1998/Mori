import 'package:eco_mobile/core/models/integration_models.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('integration availability parses profile and failure reason', () {
    final snapshot = IntegrationAvailabilitySnapshot.fromJson({
      'integrations': [
        {
          'id': 'imageGeneration',
          'enabled': true,
          'available': false,
          'reason': 'API key missing',
          'activeProfileName': 'Primary',
        },
      ],
    });

    expect(snapshot.integrations.single.id, 'imageGeneration');
    expect(snapshot.integrations.single.available, isFalse);
    expect(snapshot.integrations.single.reason, 'API key missing');
    expect(snapshot.integrations.single.activeProfileName, 'Primary');
  });

  test('project integrations retain only supported ids', () {
    final snapshot = ProjectIntegrationsSettingsSnapshot.fromJson({
      'workspacePath': '/repo',
      'enabled': {
        'browser': true,
        'imageGeneration': false,
        'computerUse': true,
        'tts': true,
        'unknown': true,
      },
    });

    expect(snapshot.enabled, const {
      'browser': true,
      'imageGeneration': false,
      'computerUse': true,
      'tts': true,
    });
    expect(snapshot.toJson(), {
      'workspacePath': '/repo',
      'enabled': {
        'browser': true,
        'imageGeneration': false,
        'computerUse': true,
        'tts': true,
      },
    });
  });
}
