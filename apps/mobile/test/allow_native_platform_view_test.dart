import 'package:flutter_test/flutter_test.dart';

import 'package:eco_mobile/core/widgets/allow_native_platform_view.dart';

void main() {
  group('isShellCoveredLocation', () {
    test('allows only bare shell tab roots', () {
      expect(isShellCoveredLocation('/threads'), isFalse);
      expect(isShellCoveredLocation('/todos'), isFalse);
      expect(isShellCoveredLocation('/settings'), isFalse);
    });

    test('covers session and new-thread routes', () {
      expect(isShellCoveredLocation('/threads/new'), isTrue);
      expect(isShellCoveredLocation('/threads/abc-123'), isTrue);
    });

    test('covers settings detail routes', () {
      expect(isShellCoveredLocation('/settings/theme'), isTrue);
      expect(isShellCoveredLocation('/settings/language'), isTrue);
      expect(isShellCoveredLocation('/settings/thinking-content'), isTrue);
      expect(isShellCoveredLocation('/settings/models'), isTrue);
    });

    test('covers switch-PC connect route (above shell)', () {
      expect(isShellCoveredLocation('/connect'), isTrue);
    });
  });
}
