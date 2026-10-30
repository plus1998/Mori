import 'dart:async';
import 'dart:convert';

import 'package:eco_mobile/core/theme/eco_theme.dart';
import 'package:eco_mobile/core/widgets/image_memory_lightbox.dart';
import 'package:eco_mobile/l10n/generated/app_localizations.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

final _png = base64Decode(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
);

void main() {
  const channel = MethodChannel('gal');
  var access = true;
  Future<void> Function()? write;
  late List<Uint8List> writes;
  setUp(() {
    writes = [];
    access = true;
    write = null;
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (call) async {
          if (call.method == 'hasAccess' || call.method == 'requestAccess') {
            return access;
          }
          writes.add(call.arguments['bytes'] as Uint8List);
          await write?.call();
          return null;
        });
  });
  tearDown(
    () => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, null),
  );

  Future<void> open(
    WidgetTester tester, {
    List<Uint8List>? images,
    Future<Uint8List> Function(int)? load,
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

  testWidgets(
    'saves once, prevents repeat taps while writing, then confirms success',
    (tester) async {
      final pending = Completer<void>();
      write = () => pending.future;
      await open(tester);
      await tester.tap(find.text('Save to Photos'));
      await tester.pump();
      expect(find.text('Saving…'), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('image-save-to-photos')));
      await tester.pump();
      expect(writes, hasLength(1));
      expect(writes.single, orderedEquals(_png));
      pending.complete();
      await tester.pumpAndSettle();
      expect(find.text('Saved to Photos'), findsOneWidget);
      expect(
        tester.widget<FilledButton>(find.byType(FilledButton)).onPressed,
        isNull,
      );
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('permission rejection stays explicit and can be retried', (
    tester,
  ) async {
    access = false;
    await open(tester);
    await tester.tap(find.text('Save to Photos'));
    await tester.pumpAndSettle();
    expect(find.textContaining('Photo access was denied'), findsOneWidget);
    expect(find.text('Saved to Photos'), findsNothing);
    expect(writes, isEmpty);
    access = true;
    await tester.tap(find.text('Save to Photos'));
    await tester.pumpAndSettle();
    expect(find.text('Saved to Photos'), findsOneWidget);
    expect(writes, hasLength(1));
  });

  testWidgets(
    'waits for original bytes, then saves the original for the selected page',
    (tester) async {
      final pending = Completer<Uint8List>();
      final other = Uint8List.fromList([..._png, 0]);
      await open(
        tester,
        images: [Uint8List(0), Uint8List(0)],
        load: (index) => index == 0 ? pending.future : Future.value(other),
      );
      expect(
        tester.widget<FilledButton>(find.byType(FilledButton)).onPressed,
        isNull,
      );
      expect(writes, isEmpty);
      pending.complete(_png);
      await tester.pumpAndSettle();
      await tester.drag(find.byType(PageView), const Offset(-700, 0));
      await tester.pumpAndSettle();
      expect(find.text('2 / 2'), findsOneWidget);
      await tester.tap(find.text('Save to Photos'));
      await tester.pumpAndSettle();
      expect(writes.single, orderedEquals(other));
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'failed original does not save a placeholder and retry loads original',
    (tester) async {
      var reads = 0;
      await open(
        tester,
        images: [Uint8List(0)],
        load: (_) async {
          if (++reads == 1) throw StateError('offline');
          return _png;
        },
      );
      await tester.pumpAndSettle();
      expect(find.text('Failed to read the image.'), findsOneWidget);
      expect(
        tester.widget<FilledButton>(find.byType(FilledButton)).onPressed,
        isNull,
      );
      await tester.tap(find.text('Retry'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Save to Photos'));
      await tester.pumpAndSettle();
      expect(reads, 2);
      expect(writes.single, orderedEquals(_png));
    },
  );

  for (final dark in [false, true]) {
    testWidgets(
      'preview fits 320px and large text (${dark ? 'dark' : 'light'})',
      (tester) async {
        tester.view.physicalSize = const Size(320, 568);
        tester.view.devicePixelRatio = 1;
        addTearDown(tester.view.resetPhysicalSize);
        addTearDown(tester.view.resetDevicePixelRatio);
        await open(tester, dark: dark, scale: 2);
        await tester.pumpAndSettle();
        final dialog = tester.widget<Dialog>(find.byType(Dialog));
        expect(dialog.backgroundColor, const Color(0xFF101012));
        expect(find.byType(InteractiveViewer), findsOneWidget);
        await tester.tap(find.text('Save to Photos'));
        await tester.pumpAndSettle();
        expect(find.text('Saved to Photos'), findsOneWidget);
        await tester.tap(find.byTooltip('Close'));
        await tester.pumpAndSettle();
        expect(tester.takeException(), isNull);
      },
    );
  }
}
