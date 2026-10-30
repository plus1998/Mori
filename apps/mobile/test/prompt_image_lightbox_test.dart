import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:eco_mobile/core/models/thread_models.dart';
import 'package:eco_mobile/core/theme/eco_theme.dart';
import 'package:eco_mobile/core/widgets/prompt_image_lightbox.dart';
import 'package:eco_mobile/features/threads/activity_feed.dart';
import 'package:eco_mobile/l10n/generated/app_localizations.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';

Future<Uint8List> _png(int width, int height) async {
  final recorder = ui.PictureRecorder();
  final canvas = Canvas(recorder);
  canvas.drawColor(Colors.white, BlendMode.src);
  final painter = TextPainter(
    text: const TextSpan(
      text: 'Original screenshot 0123456789',
      style: TextStyle(color: Colors.black, fontSize: 24),
    ),
    textDirection: TextDirection.ltr,
  )..layout();
  painter.paint(canvas, const Offset(10, 10));
  painter.dispose();
  final picture = recorder.endRecording();
  final image = await picture.toImage(width, height);
  final data = (await image.toByteData(format: ui.ImageByteFormat.png))!;
  final bytes = Uint8List.fromList(
    data.buffer.asUint8List(data.offsetInBytes, data.lengthInBytes),
  );
  image.dispose();
  picture.dispose();
  return bytes;
}

void main() {
  late Uint8List thumbnail;
  late Uint8List original;
  setUpAll(() async {
    TestWidgetsFlutterBinding.ensureInitialized();
    thumbnail = await _png(32, 24);
    original = await _png(1800, 1200);
  });

  Future<void> render(
    WidgetTester tester, {
    required PromptImageOriginalLoader? loader,
    List<PromptImageAttachment>? attachments,
  }) async {
    tester.view.physicalSize = const Size(390, 844);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final scroll = ScrollController();
    addTearDown(scroll.dispose);
    await tester.pumpWidget(
      MaterialApp(
        theme: buildEcoLightTheme(),
        locale: const Locale('en'),
        localizationsDelegates: AppLocalizations.localizationsDelegates,
        supportedLocales: AppLocalizations.supportedLocales,
        home: Scaffold(
          body: ActivityFeedList(
            scrollController: scroll,
            loadPromptImage: loader,
            entries: [
              ActivityFeedEntry(
                id: 'sent-message',
                kind: ActivityFeedKind.user,
                text: 'sent image',
                attachments:
                    attachments ??
                    [
                      PromptImageAttachment(
                        data: base64Encode(thumbnail),
                        mediaType: 'image/png',
                        contentRef: 'sha256:original',
                        byteLength: original.length,
                      ),
                    ],
              ),
            ],
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
  }

  testWidgets(
    'sent-message preview fetches and decodes original pixels instead of the thumbnail',
    (tester) async {
      final pending = Completer<Uint8List>();
      final requests = <PromptImageAttachment>[];
      await render(
        tester,
        loader: (image) {
          requests.add(image);
          return pending.future;
        },
      );
      expect(requests, isEmpty);
      await tester.tap(find.byType(Image));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));
      expect(requests.single.contentRef, 'sha256:original');
      expect(find.byType(CircularProgressIndicator), findsOneWidget);
      expect(
        find.descendant(of: find.byType(Dialog), matching: find.byType(Image)),
        findsNothing,
      );
      pending.complete(original);
      await tester.runAsync(
        () async => Future<void>.delayed(const Duration(milliseconds: 50)),
      );
      await tester.pumpAndSettle();
      final image = tester.widget<Image>(
        find.descendant(of: find.byType(Dialog), matching: find.byType(Image)),
      );
      expect((image.image as MemoryImage).bytes, orderedEquals(original));
      await tester.runAsync(
        () => precacheImage(image.image, tester.element(find.byType(Dialog))),
      );
      await tester.pumpAndSettle();
      final decoded = tester.renderObject<RenderImage>(
        find.descendant(
          of: find.byType(Dialog),
          matching: find.byType(RawImage),
        ),
      );
      expect(decoded.image!.width, 1800);
      expect(decoded.image!.height, 1200);
      expect(tester.takeException(), isNull);
      await tester.tap(find.byTooltip('Close'));
      await tester.pumpAndSettle();
      await tester.pumpWidget(const SizedBox.shrink());
    },
  );

  testWidgets(
    'original read failure stays explicit and retry fetches the original',
    (tester) async {
      var reads = 0;
      await render(
        tester,
        loader: (_) async {
          if (++reads == 1) throw StateError('offline');
          return original;
        },
      );
      await tester.tap(find.byType(Image));
      await tester.pumpAndSettle();
      expect(find.text('Failed to read the image.'), findsOneWidget);
      expect(
        find.descendant(of: find.byType(Dialog), matching: find.byType(Image)),
        findsNothing,
      );
      await tester.tap(find.text('Retry'));
      await tester.pumpAndSettle();
      expect(reads, 2);
      expect(
        find.descendant(of: find.byType(Dialog), matching: find.byType(Image)),
        findsOneWidget,
      );
      await tester.tap(find.byTooltip('Close'));
      await tester.pumpAndSettle();
      await tester.pumpWidget(const SizedBox.shrink());
    },
  );

  testWidgets(
    'selected page loads on demand and reuses its original after swiping',
    (tester) async {
      final reads = <String>[];
      await render(
        tester,
        loader: (image) async {
          reads.add(image.contentRef!);
          return original;
        },
        attachments: [
          for (final id in ['first', 'second'])
            PromptImageAttachment(
              data: base64Encode(thumbnail),
              mediaType: 'image/png',
              contentRef: 'sha256:$id',
              byteLength: original.length,
            ),
        ],
      );
      await tester.tap(find.byType(Image).at(1));
      await tester.pumpAndSettle();
      expect(find.text('2 / 2'), findsOneWidget);
      expect(reads, ['sha256:second']);
      await tester.drag(find.byType(PageView), const Offset(350, 0));
      await tester.pumpAndSettle();
      expect(find.text('1 / 2'), findsOneWidget);
      expect(reads, ['sha256:second', 'sha256:first']);
      await tester.drag(find.byType(PageView), const Offset(-350, 0));
      await tester.pumpAndSettle();
      expect(find.text('2 / 2'), findsOneWidget);
      expect(reads, ['sha256:second', 'sha256:first']);
      await tester.tap(find.byTooltip('Close'));
      await tester.pumpAndSettle();
      await tester.pumpWidget(const SizedBox.shrink());
    },
  );

  testWidgets('inline originals without a content reference still open', (
    tester,
  ) async {
    await render(
      tester,
      loader: (_) async => throw StateError('should not read'),
      attachments: [
        PromptImageAttachment(
          data: base64Encode(original),
          mediaType: 'image/png',
        ),
      ],
    );
    await tester.tap(find.byType(Image));
    await tester.pumpAndSettle();
    final image = tester.widget<Image>(
      find.descendant(of: find.byType(Dialog), matching: find.byType(Image)),
    );
    expect((image.image as MemoryImage).bytes, orderedEquals(original));
    await tester.tap(find.byTooltip('Close'));
    await tester.pumpAndSettle();
    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('a missing original reader does not enlarge the thumbnail', (
    tester,
  ) async {
    await render(tester, loader: null);
    await tester.tap(find.byType(Image));
    await tester.pumpAndSettle();
    expect(find.text('Failed to read the image.'), findsOneWidget);
    expect(
      find.descendant(of: find.byType(Dialog), matching: find.byType(Image)),
      findsNothing,
    );
    await tester.tap(find.byTooltip('Close'));
    await tester.pumpAndSettle();
    await tester.pumpWidget(const SizedBox.shrink());
  });
}
