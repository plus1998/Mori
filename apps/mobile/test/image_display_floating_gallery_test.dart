import 'dart:convert';

import 'package:eco_mobile/core/models/image_display_models.dart';
import 'package:eco_mobile/core/models/image_view_models.dart';
import 'package:eco_mobile/core/theme/eco_theme.dart';
import 'package:eco_mobile/features/threads/image_display_floating_gallery.dart';
import 'package:eco_mobile/l10n/generated/app_localizations.dart';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  testWidgets(
    'live image appears, opens fullscreen and reveals again from the menu',
    (tester) async {
      final controller = ImageDisplayFloatingGalleryController();
      addTearDown(controller.dispose);
      var artifacts = <ImageDisplayArtifact>[];
      var reads = 0;
      late StateSetter rebuild;
      await tester.pumpWidget(
        _app(
          StatefulBuilder(
            builder: (_, setState) {
              rebuild = setState;
              return Stack(
                children: [
                  ImageDisplayFloatingGallery(
                    artifacts: artifacts,
                    controller: controller,
                    loadBytes: (_, {onProgress}) async {
                      reads++;
                      return _image;
                    },
                  ),
                ],
              );
            },
          ),
        ),
      );
      expect(find.byType(Image), findsNothing);
      rebuild(() => artifacts = [_artifact]);
      await tester.pumpAndSettle();
      expect(find.text('Menu screenshot'), findsOneWidget);
      expect(
        tester.widget<Image>(find.byType(Image)).fit,
        BoxFit.contain,
        reason: 'Portrait screenshots retain content at the top and bottom',
      );
      expect(reads, 1);
      await tester.tap(find.byType(Image));
      await tester.pumpAndSettle();
      expect(find.byType(InteractiveViewer), findsOneWidget);
      await tester.tap(find.byTooltip('Close'));
      await tester.pumpAndSettle();
      await tester.tap(find.byTooltip('Collapse'));
      await tester.pumpAndSettle();
      expect(find.text('Menu screenshot'), findsNothing);
      controller.reveal(artifactId: 'image');
      await tester.pumpAndSettle();
      expect(find.text('Menu screenshot'), findsOneWidget);
      expect(
        reads,
        1,
        reason: 'Reopening the gallery reuses already loaded bytes',
      );
      rebuild(() => artifacts = [_artifact, _newestArtifact]);
      await tester.pumpAndSettle();
      expect(reads, 2);
      expect(
        tester.getTopLeft(find.text('Newest screenshot')).dy,
        lessThan(tester.getTopLeft(find.text('Menu screenshot')).dy),
        reason: 'A newly displayed screenshot is visible above older images',
      );
      rebuild(() => artifacts = []);
      await tester.pumpAndSettle();
      expect(find.text('Menu screenshot'), findsNothing);
    },
  );

  testWidgets(
    'failed images do not retry on feed rebuilds; a tap retries once',
    (tester) async {
      var reads = 0;
      late StateSetter rebuild;
      await tester.pumpWidget(
        _app(
          StatefulBuilder(
            builder: (_, setState) {
              rebuild = setState;
              return Stack(
                children: [
                  ImageDisplayFloatingGallery(
                    artifacts: const [_artifact],
                    loadBytes: (_, {onProgress}) async {
                      reads++;
                      if (reads == 1) {
                        throw const ImageViewReadException(
                          ImageViewReadFailureCode.notFound,
                        );
                      }
                      return _image;
                    },
                  ),
                ],
              );
            },
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(reads, 1);
      rebuild(() {});
      await tester.pumpAndSettle();
      expect(reads, 1);
      await tester.tap(find.text('Menu screenshot'));
      await tester.pumpAndSettle();
      expect(reads, 2);
      expect(find.byType(Image), findsOneWidget);
    },
  );
}

Widget _app(Widget child) => MaterialApp(
  theme: buildEcoLightTheme(),
  localizationsDelegates: const [
    AppLocalizations.delegate,
    GlobalMaterialLocalizations.delegate,
    GlobalWidgetsLocalizations.delegate,
    GlobalCupertinoLocalizations.delegate,
  ],
  supportedLocales: AppLocalizations.supportedLocales,
  home: Scaffold(body: child),
);

const _artifact = ImageDisplayArtifact(
  id: 'image',
  threadId: 'thread',
  title: 'Menu screenshot',
  status: 'completed',
  sourceKind: 'path',
  mimeType: 'image/png',
  filePath: '/desktop/menu.png',
  bytes: 68,
  createdAt: '',
  updatedAt: '',
);
const _newestArtifact = ImageDisplayArtifact(
  id: 'newest',
  threadId: 'thread',
  title: 'Newest screenshot',
  status: 'completed',
  sourceKind: 'path',
  mimeType: 'image/png',
  filePath: '/desktop/newest.png',
  bytes: 68,
  createdAt: '',
  updatedAt: '',
);
final _image = ImageViewReadData(
  bytes: base64Decode(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  ),
  mimeType: 'image/png',
  path: '/desktop/menu.png',
  fileName: 'menu.png',
  byteLength: 68,
  width: 1,
  height: 1,
);
