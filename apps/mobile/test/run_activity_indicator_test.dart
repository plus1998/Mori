import 'package:eco_mobile/core/widgets/run_activity_indicator.dart';
import 'package:eco_mobile/l10n/generated/app_localizations.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  Widget app({bool enabled = true, bool reduceMotion = false}) => MaterialApp(
    localizationsDelegates: AppLocalizations.localizationsDelegates,
    supportedLocales: AppLocalizations.supportedLocales,
    home: MediaQuery(
      data: MediaQueryData(disableAnimations: reduceMotion),
      child: TickerMode(enabled: enabled, child: const RunActivityIndicator()),
    ),
  );

  testWidgets('waiting does not schedule a display-rate ticker and rests', (
    tester,
  ) async {
    await tester.pumpWidget(app());
    expect(tester.binding.transientCallbackCount, 0);
    await tester.pump(const Duration(milliseconds: 1800));
    for (var i = 0; i < 35; i++) {
      await tester.pump(const Duration(milliseconds: 100));
      expect(tester.binding.hasScheduledFrame, isFalse);
    }
    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('waiting cancels wakeups when hidden, backgrounded or reduced', (
    tester,
  ) async {
    await tester.pumpWidget(app());
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
    await tester.pump(const Duration(seconds: 8));
    expect(tester.binding.hasScheduledFrame, isFalse);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    await tester.pumpWidget(app(enabled: false));
    await tester.pump(const Duration(seconds: 8));
    expect(tester.binding.hasScheduledFrame, isFalse);
    await tester.pumpWidget(app(reduceMotion: true));
    await tester.pump(const Duration(seconds: 8));
    expect(tester.binding.hasScheduledFrame, isFalse);
    await tester.pumpWidget(const SizedBox.shrink());
  });
}
