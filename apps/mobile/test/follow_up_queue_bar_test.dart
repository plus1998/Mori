import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:eco_mobile/core/models/thread_models.dart';
import 'package:eco_mobile/core/theme/eco_icons.dart';
import 'package:eco_mobile/features/composer/follow_up_queue_bar.dart';
import 'package:eco_mobile/l10n/generated/app_localizations.dart';

const _followUps = [
  ThreadPendingFollowUp(
    id: 'follow-up-1',
    threadId: 'thread-1',
    prompt: '第一条排队消息',
    status: 'queued',
    createdAt: '2026-01-01T00:00:00.000Z',
  ),
  ThreadPendingFollowUp(
    id: 'follow-up-2',
    threadId: 'thread-1',
    prompt: '第二条排队消息',
    status: 'queued',
    createdAt: '2026-01-01T00:00:01.000Z',
  ),
];

Widget _app({
  String? busyId,
  Future<void> Function(ThreadPendingFollowUp)? onMove,
}) => MaterialApp(
  locale: const Locale('zh'),
  localizationsDelegates: AppLocalizations.localizationsDelegates,
  supportedLocales: AppLocalizations.supportedLocales,
  home: Scaffold(
    body: Align(
      alignment: Alignment.bottomCenter,
      child: FollowUpQueueBar(
        followUps: _followUps,
        cancelBusyId: null,
        escalateBusyId: null,
        moveToTodoBusyId: busyId,
        queuePaused: false,
        pauseBusy: false,
        onEscalate: (_) async {},
        onEdit: (_) {},
        onDelete: (_) async {},
        onMoveToTodo: onMove ?? (_) async {},
        onReorder: (_, _) async {},
        onTogglePause: (_) async {},
      ),
    ),
  ),
);

void main() {
  testWidgets('follow-up queue uses compact mobile spacing', (tester) async {
    await tester.pumpWidget(_app());
    expect(tester.getSize(find.byType(FollowUpQueueBar)).height, lessThan(120));
    expect(find.text('暂停'), findsOneWidget);
  });

  testWidgets('expanded row menu moves the chosen queued message to todos', (
    tester,
  ) async {
    ThreadPendingFollowUp? moved;
    await tester.pumpWidget(_app(onMove: (row) async => moved = row));
    await tester.tap(find.byIcon(EcoIcons.more).first);
    await tester.pumpAndSettle();
    expect(find.text('迁到待办'), findsOneWidget);
    expect(find.text('修改'), findsOneWidget);
    expect(find.text('删除'), findsOneWidget);
    await tester.tap(find.text('迁到待办'));
    await tester.pumpAndSettle();
    expect(moved?.id, 'follow-up-1');
    expect(moved?.prompt, '第一条排队消息');
    expect(find.text('迁到待办'), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets(
    'a migrating row disables repeat actions without locking other rows',
    (tester) async {
      await tester.pumpWidget(_app(busyId: 'follow-up-1'));
      await tester.tap(find.byIcon(EcoIcons.more).first);
      await tester.pumpAndSettle();
      expect(find.text('迁到待办'), findsNothing);
      await tester.tap(find.byIcon(EcoIcons.more).last);
      await tester.pumpAndSettle();
      expect(find.text('迁到待办'), findsOneWidget);
      expect(tester.takeException(), isNull);
    },
  );
}
