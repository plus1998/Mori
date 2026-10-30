import 'package:eco_mobile/core/widgets/paced_stream_text.dart';
import 'package:eco_mobile/core/utils/stream_text.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  Widget app(String text, {required bool streaming}) {
    return MaterialApp(
      home: PacedStreamText(
        key: const ValueKey('stream'),
        text: text,
        streaming: streaming,
        builder: (context, displayText, revealing) =>
            Text(displayText, textDirection: TextDirection.ltr),
      ),
    );
  }

  testWidgets('shows existing content immediately and batches new arrivals', (
    tester,
  ) async {
    await tester.pumpWidget(app('首批', streaming: true));
    expect(find.text('首批'), findsOneWidget);

    // 同一批已收到的文本一起显示，不额外逐字追赶。
    await tester.pumpWidget(app('首批这是第二批', streaming: true));
    expect(find.text('首批'), findsOneWidget);
    await tester.pump(pacedStreamInterval);
    expect(find.text('首批这是第二批'), findsOneWidget);
  });

  testWidgets('keeps revealing across repeated streaming updates', (
    tester,
  ) async {
    await tester.pumpWidget(app('a', streaming: true));
    for (final text in ['ab', 'abc', 'abcd', 'abcde']) {
      await tester.pumpWidget(app(text, streaming: true));
      await tester.pump(pacedStreamInterval);
    }

    expect(tester.takeException(), isNull);
    expect(find.text('abcde'), findsOneWidget);
  });

  testWidgets('a large burst catches up in one batch without extra ticks', (
    tester,
  ) async {
    await tester.pumpWidget(app('开始', streaming: true));
    final burst = '开始${'👍🏽e\u0301中文' * 2000}';
    await tester.pumpWidget(app(burst, streaming: true));
    await tester.pump(pacedStreamInterval);
    expect(find.text(burst), findsOneWidget);
    await tester.pump(pacedStreamInterval);
    expect(tester.binding.hasScheduledFrame, isFalse);
  });

  testWidgets('does not replay existing content when re-entering the page', (
    tester,
  ) async {
    // 重新进入页面 / 重建：streaming 仍为 true 时也不能从空串重新逐字渲染。
    await tester.pumpWidget(app('已有完整内容', streaming: true));
    expect(find.text('已有完整内容'), findsOneWidget);
    expect(find.text(''), findsNothing);

    for (var index = 0; index < 5; index++) {
      await tester.pump(pacedStreamInterval);
    }
    expect(find.text('已有完整内容'), findsOneWidget);
  });

  testWidgets('snaps to full text immediately when streaming finishes', (
    tester,
  ) async {
    await tester.pumpWidget(app('开始', streaming: true));
    await tester.pumpWidget(app('开始这是一段最终文本', streaming: false));
    await tester.pump();
    expect(find.text('开始这是一段最终文本'), findsOneWidget);
  });

  testWidgets('snaps up earlier entry when it is no longer the pace target', (
    tester,
  ) async {
    // 模拟“后面的内容出现后，前面的流式条目不再逐字追赶”。
    await tester.pumpWidget(app('开始', streaming: true));
    await tester.pumpWidget(app('开始这是思考内容', streaming: true));
    await tester.pump(pacedStreamInterval);
    expect(find.text('开始这是思考内容'), findsOneWidget);

    await tester.pumpWidget(app('开始这是思考内容', streaming: false));
    await tester.pump();
    expect(find.text('开始这是思考内容'), findsOneWidget);
  });

  testWidgets('ignores a stale shorter streaming snapshot', (tester) async {
    await tester.pumpWidget(app('已经显示的完整内容', streaming: true));
    for (var index = 0; index < 10; index++) {
      await tester.pump(pacedStreamInterval);
    }
    expect(find.text('已经显示的完整内容'), findsOneWidget);

    await tester.pumpWidget(app('已经显示的', streaming: true));
    await tester.pump(pacedStreamInterval);

    expect(find.text('已经显示的完整内容'), findsOneWidget);
    expect(find.text('已经显示的'), findsNothing);
  });

  testWidgets('stream reveal does not schedule frames between text updates', (
    tester,
  ) async {
    await tester.pumpWidget(app('开始', streaming: true));
    await tester.pumpWidget(app('开始继续逐字输出', streaming: true));
    expect(tester.binding.transientCallbackCount, 0);
    await tester.pump(const Duration(milliseconds: 20));
    expect(find.text('开始'), findsOneWidget);
    expect(tester.binding.hasScheduledFrame, isFalse);
    await tester.pump(const Duration(milliseconds: 20));
    expect(find.text('开始继续逐字输出'), findsOneWidget);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
    await tester.pump(const Duration(seconds: 1));
    expect(find.text('开始继续逐字输出'), findsOneWidget);
    expect(tester.binding.hasScheduledFrame, isFalse);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    await tester.pump(pacedStreamInterval);
    expect(find.text('开始继续逐字输出'), findsOneWidget);
    await tester.pumpWidget(const SizedBox.shrink());
  });
}
