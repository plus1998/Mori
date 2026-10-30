import 'dart:async';
import 'dart:convert';

import 'package:eco_mobile/core/theme/eco_theme.dart';
import 'package:eco_mobile/core/widgets/image_memory_lightbox.dart';
import 'package:eco_mobile/l10n/generated/app_localizations.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

final _png = Uint8List.fromList(
  base64Decode(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  ),
);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  const channel = MethodChannel('eco_mobile/image_clipboard');
  final messenger =
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
  final writes = <Uint8List>[];
  Object? nextError;
  Future<void> Function()? pendingWrite;

  setUp(() {
    writes.clear();
    nextError = null;
    pendingWrite = null;
    messenger.setMockMethodCallHandler(channel, (call) async {
      writes.add(Uint8List.fromList(call.arguments['bytes'] as Uint8List));
      await pendingWrite?.call();
      if (nextError case final error?) throw error;
      return true;
    });
  });
  tearDown(() => messenger.setMockMethodCallHandler(channel, null));

  Future<void> open(
    WidgetTester tester, {
    List<Uint8List>? images,
    Future<Uint8List> Function(int index)? load,
    bool dark = false,
    double scale = 1,
  }) async {
    await tester.pumpWidget(
      MaterialApp(
        theme: dark ? buildEcoDarkTheme() : buildEcoLightTheme(),
        locale: const Locale('en'),
        localizationsDelegates: AppLocalizations.localizationsDelegates,
        supportedLocales: AppLocalizations.supportedLocales,
        builder: (context, child) => MediaQuery(
          data: MediaQuery.of(
            context,
          ).copyWith(textScaler: TextScaler.linear(scale)),
          child: child!,
        ),
        home: Builder(
          builder: (context) => Scaffold(
            body: TextButton(
              onPressed: () => showImageMemoryLightbox(
                context,
                images: images ?? [_png],
                loadImage: load,
              ),
              child: const Text('open'),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('open'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
  }

  testWidgets('copies exact original bytes and confirms success', (
    tester,
  ) async {
    await open(tester);
    await tester.tap(find.byKey(const ValueKey('image-copy-to-clipboard')));
    await tester.pumpAndSettle();
    expect(writes, hasLength(1));
    expect(writes.single, orderedEquals(_png));
    expect(find.text('Copied'), findsOneWidget);
    final copyButton = tester.widget<OutlinedButton>(
      find.byKey(const ValueKey('image-copy-to-clipboard')),
    );
    expect(
      copyButton.style!.backgroundColor!.resolve(<WidgetState>{}),
      Colors.white.withValues(alpha: .09),
    );
    expect(tester.takeException(), isNull);
  });

  testWidgets('prevents duplicate taps while copying and keeps page fixed', (
    tester,
  ) async {
    final pending = Completer<void>();
    pendingWrite = () => pending.future;
    final second = Uint8List.fromList([..._png, 7]);
    await open(tester, images: [_png, second]);
    await tester.tap(find.byKey(const ValueKey('image-copy-to-clipboard')));
    await tester.pump();
    expect(find.text('Copying…'), findsOneWidget);
    expect(
      tester.widget<PageView>(find.byType(PageView)).physics,
      isA<NeverScrollableScrollPhysics>(),
    );
    await tester.tap(find.byKey(const ValueKey('image-copy-to-clipboard')));
    await tester.pump();
    expect(writes, hasLength(1));
    pending.complete();
    await tester.pumpAndSettle();
    expect(find.text('Copied'), findsOneWidget);
  });

  testWidgets(
    'copies selected page original bytes and clears feedback on paging',
    (tester) async {
      final second = Uint8List.fromList([..._png, 9, 8]);
      await open(tester, images: [_png, second]);
      await tester.tap(find.byKey(const ValueKey('image-copy-to-clipboard')));
      await tester.pumpAndSettle();
      expect(find.text('Copied'), findsOneWidget);
      await tester.drag(find.byType(PageView), const Offset(-700, 0));
      await tester.pumpAndSettle();
      expect(find.text('2 / 2'), findsOneWidget);
      expect(find.text('Copy'), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('image-copy-to-clipboard')));
      await tester.pumpAndSettle();
      expect(writes, hasLength(2));
      expect(writes.last, orderedEquals(second));
    },
  );

  testWidgets('does not enable copy until lazy original bytes are loaded', (
    tester,
  ) async {
    final pending = Completer<Uint8List>();
    await open(tester, images: [Uint8List(0)], load: (_) => pending.future);
    final button = tester.widget<OutlinedButton>(
      find.byKey(const ValueKey('image-copy-to-clipboard')),
    );
    expect(button.onPressed, isNull);
    expect(writes, isEmpty);
    pending.complete(_png);
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('image-copy-to-clipboard')));
    await tester.pumpAndSettle();
    expect(writes.single, orderedEquals(_png));
  });

  testWidgets('shows explicit error and allows retry', (tester) async {
    nextError = PlatformException(code: 'copy_failed');
    await open(tester);
    await tester.tap(find.byKey(const ValueKey('image-copy-to-clipboard')));
    await tester.pumpAndSettle();
    expect(find.text('Could not copy this image. Try again.'), findsOneWidget);
    expect(find.text('Copied'), findsNothing);
    nextError = null;
    await tester.tap(find.byKey(const ValueKey('image-copy-to-clipboard')));
    await tester.pumpAndSettle();
    expect(find.text('Copied'), findsOneWidget);
    expect(writes, hasLength(2));
  });

  for (final dark in [false, true]) {
    testWidgets(
      'fits narrow screen with large text (${dark ? 'dark' : 'light'})',
      (tester) async {
        tester.view.physicalSize = const Size(320, 568);
        tester.view.devicePixelRatio = 1;
        addTearDown(tester.view.resetPhysicalSize);
        addTearDown(tester.view.resetDevicePixelRatio);
        await open(tester, dark: dark, scale: 2);
        expect(
          find.byKey(const ValueKey('image-copy-to-clipboard')),
          findsOneWidget,
        );
        await tester.tap(find.byKey(const ValueKey('image-copy-to-clipboard')));
        await tester.pumpAndSettle();
        expect(find.text('Copied'), findsOneWidget);
        expect(tester.takeException(), isNull);
      },
    );
  }
}
