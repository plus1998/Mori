import 'package:eco_mobile/core/widgets/shimmer_text.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  Widget app({
    bool enabled = true,
    bool reduceMotion = false,
    Duration pause = Duration.zero,
    int count = 1,
  }) => MaterialApp(
    home: MediaQuery(
      data: MediaQueryData(disableAnimations: reduceMotion),
      child: TickerMode(
        enabled: enabled,
        child: Column(
          children: [
            for (var i = 0; i < count; i++)
              ShimmerText(
                key: ValueKey(i),
                text: i == 0 ? '正在运行工具' : '正在运行工具 $i',
                baseColor: Colors.grey,
                pauseDuration: pause,
              ),
          ],
        ),
      ),
    ),
  );

  testWidgets(
    'shimmer paints without rebuilding text or requesting vsync ticks',
    (tester) async {
      await tester.pumpWidget(app());
      final text = tester.widget<Text>(find.text('正在运行工具'));
      expect(tester.binding.transientCallbackCount, 0);
      await tester.pump(const Duration(milliseconds: 16));
      expect(tester.binding.hasScheduledFrame, isFalse);
      await tester.pump(const Duration(milliseconds: 18));
      expect(tester.widget<Text>(find.text('正在运行工具')), same(text));
      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pump(const Duration(milliseconds: 100));
      expect(tester.binding.hasScheduledFrame, isFalse);
    },
  );

  testWidgets('shimmer stops when hidden, backgrounded or motion is reduced', (
    tester,
  ) async {
    await tester.pumpWidget(app(enabled: false));
    await tester.pump(const Duration(milliseconds: 100));
    expect(tester.binding.hasScheduledFrame, isFalse);
    await tester.pumpWidget(app());
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
    await tester.pump(const Duration(milliseconds: 100));
    expect(tester.binding.hasScheduledFrame, isFalse);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    await tester.pumpWidget(app(reduceMotion: true));
    await tester.pump(const Duration(milliseconds: 100));
    expect(tester.binding.hasScheduledFrame, isFalse);
    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('intermittent shimmer sleeps between complete sweeps', (
    tester,
  ) async {
    await tester.pumpWidget(app(pause: const Duration(milliseconds: 4200)));
    final paints = _trackPaints(tester).single;
    await tester.pump();
    final beforeSweep = paints.value;
    await tester.pump(const Duration(milliseconds: 33));
    expect(paints.value, greaterThan(beforeSweep));
    await tester.pump(const Duration(milliseconds: 1767));
    final restingPaints = paints.value;
    for (var i = 0; i < 40; i++) {
      await tester.pump(const Duration(milliseconds: 100));
    }
    expect(paints.value, restingPaints, reason: 'No shader paints during rest');
    expect(tester.binding.transientCallbackCount, 0);
    await tester.pump(const Duration(milliseconds: 200));
    expect(paints.value, greaterThan(restingPaints));
    final beforeNextTick = paints.value;
    await tester.pump(const Duration(milliseconds: 33));
    expect(paints.value, greaterThan(beforeNextTick));
    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('new tool rows join the shared pause without restarting it', (
    tester,
  ) async {
    const pause = Duration(milliseconds: 4200);
    await tester.pumpWidget(app(pause: pause));
    await tester.pump(const Duration(milliseconds: 1800));
    await tester.pumpWidget(app(pause: pause, count: 3));
    final paints = _trackPaints(tester);
    await tester.pump();
    final restingPaints = paints.map((count) => count.value).toList();
    for (var i = 0; i < 40; i++) {
      await tester.pump(const Duration(milliseconds: 100));
    }
    expect(paints.map((count) => count.value), restingPaints);
    await tester.pump(const Duration(milliseconds: 233));
    for (var i = 0; i < paints.length; i++) {
      expect(paints[i].value, greaterThan(restingPaints[i]));
    }
    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('changing cadence detaches the old paint clock', (tester) async {
    await tester.pumpWidget(app(pause: const Duration(milliseconds: 4200)));
    await tester.pump(const Duration(milliseconds: 1800));
    await tester.pumpWidget(app());
    final paints = _trackPaints(tester).single;
    await tester.pump();
    final beforeTick = paints.value;
    await tester.pump(const Duration(milliseconds: 33));
    expect(paints.value, greaterThan(beforeTick));
    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump(const Duration(seconds: 7));
    expect(tester.binding.hasScheduledFrame, isFalse);
  });

  testWidgets('paused shimmer cancels its wakeup when hidden or backgrounded', (
    tester,
  ) async {
    const pause = Duration(milliseconds: 4200);
    await tester.pumpWidget(app(pause: pause));
    final paints = _trackPaints(tester).single;
    await tester.pump(const Duration(milliseconds: 1800));
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
    final backgroundPaints = paints.value;
    for (var i = 0; i < 70; i++) {
      await tester.pump(const Duration(milliseconds: 100));
    }
    expect(paints.value, backgroundPaints);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    await tester.pump();
    final resumedPaints = paints.value;
    await tester.pump(const Duration(milliseconds: 33));
    expect(paints.value, greaterThan(resumedPaints));

    await tester.pumpWidget(app(pause: pause, enabled: false));
    await tester.pump(const Duration(seconds: 7));
    expect(tester.allRenderObjects.whereType<RenderShaderMask>(), isEmpty);
    expect(tester.binding.hasScheduledFrame, isFalse);
    await tester.pumpWidget(app(pause: pause, reduceMotion: true));
    await tester.pump(const Duration(seconds: 7));
    expect(tester.allRenderObjects.whereType<RenderShaderMask>(), isEmpty);
    expect(tester.binding.hasScheduledFrame, isFalse);
    await tester.pumpWidget(const SizedBox.shrink());
  });
}

class _PaintCount {
  int value = 0;
}

List<_PaintCount> _trackPaints(WidgetTester tester) => [
  for (final mask in tester.allRenderObjects.whereType<RenderShaderMask>())
    () {
      final counter = _PaintCount();
      final original = mask.shaderCallback;
      mask.shaderCallback = (bounds) {
        counter.value++;
        return original(bounds);
      };
      return counter;
    }(),
];
