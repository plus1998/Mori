import 'package:eco_mobile/core/providers/app_providers.dart';
import 'package:eco_mobile/core/widgets/lifecycle_tracker.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  testWidgets(
    'foreground tracker initializes from lifecycle and follows resume',
    (tester) async {
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
      final container = ProviderContainer();
      addTearDown(container.dispose);
    container.listen(appForegroundProvider, (_, _) {});
      expect(container.read(appForegroundProvider), isFalse);
      expect(AppLifecycleTracker.isForeground, isFalse);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      expect(container.read(appForegroundProvider), isTrue);
      expect(AppLifecycleTracker.isForeground, isTrue);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
      expect(AppLifecycleTracker.isForeground, isFalse);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    },
  );
}
