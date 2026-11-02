import 'dart:async';

import 'package:eco_mobile/features/threads/thread_attention_sheet.dart';
import 'package:eco_mobile/features/threads/thread_providers.dart';
import 'package:eco_mobile/l10n/generated/app_localizations.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  testWidgets('shows loading until attention items are available', (
    tester,
  ) async {
    final itemsCompleter = Completer<List<ThreadAttentionItem>>();
    late Future<ThreadAttentionItem?> sheetFuture;
    const item = ThreadAttentionItem(
      id: 'plan:thread-1',
      threadId: 'thread-1',
      title: '待处理会话',
      kind: ThreadAttentionKind.plan,
      updatedAt: '2026-01-01T00:00:00.000Z',
    );

    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          threadAttentionProvider.overrideWith((ref) => itemsCompleter.future),
        ],
        child: _localizedMaterialApp(
          home: Builder(
            builder: (context) => Scaffold(
              body: TextButton(
                onPressed: () {
                  sheetFuture = showThreadAttentionSheet(context: context);
                },
                child: const Text('打开'),
              ),
            ),
          ),
        ),
      ),
    );

    await tester.tap(find.text('打开'));
    await tester.pump();

    expect(find.byType(CircularProgressIndicator), findsOneWidget);
    expect(find.text('待处理会话'), findsNothing);

    itemsCompleter.complete([item]);
    await tester.pumpAndSettle();

    expect(find.text('待处理会话'), findsOneWidget);
    await tester.tap(find.text('待处理会话'));
    await tester.pumpAndSettle();

    expect(await sheetFuture, same(item));
  });

  testWidgets(
    'resolved approvals disappear while the attention sheet is open',
    (tester) async {
      const item = ThreadAttentionItem(
        id: 'bash:thread-1:tool-1',
        threadId: 'thread-1',
        title: '等待操作审批',
        kind: ThreadAttentionKind.bash,
        updatedAt: '2026-01-01T00:00:00.000Z',
      );
      final pending = StateProvider<List<ThreadAttentionItem>>((ref) => [item]);
      final container = ProviderContainer(
        overrides: [
          threadAttentionProvider.overrideWith((ref) => ref.watch(pending)),
        ],
      );
      addTearDown(container.dispose);
      await tester.pumpWidget(
        UncontrolledProviderScope(
          container: container,
          child: _localizedMaterialApp(
            home: Builder(
              builder: (context) => Scaffold(
                body: TextButton(
                  onPressed: () => showThreadAttentionSheet(context: context),
                  child: const Text('打开'),
                ),
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.text('打开'));
      await tester.pumpAndSettle();
      expect(find.text('等待操作审批'), findsOneWidget);
      container.read(pending.notifier).state = [];
      await tester.pumpAndSettle();
      expect(find.text('等待操作审批'), findsNothing);
      expect(find.text('暂无需要处理的对话'), findsOneWidget);
    },
  );
}

Widget _localizedMaterialApp({required Widget home}) {
  return MaterialApp(
    locale: const Locale('zh', 'CN'),
    localizationsDelegates: const [
      AppLocalizations.delegate,
      GlobalMaterialLocalizations.delegate,
      GlobalWidgetsLocalizations.delegate,
      GlobalCupertinoLocalizations.delegate,
    ],
    supportedLocales: AppLocalizations.supportedLocales,
    home: home,
  );
}
