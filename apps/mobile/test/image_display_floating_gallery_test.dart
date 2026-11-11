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
    'deleting media requires confirmation and keeps the record on failure',
    (tester) async {
      final controller = ImageDisplayFloatingGalleryController();
      addTearDown(controller.dispose);
      var deletes = 0;
      await tester.pumpWidget(
        _app(
          Stack(
            children: [
              ImageDisplayFloatingGallery(
                artifacts: [_artifact],
                controller: controller,
                loadBytes: (_, {onProgress}) async => _image,
                onDeleteArtifact: (id) async {
                  expect(id, _artifact.id);
                  deletes++;
                  throw StateError('Delete failed');
                },
              ),
            ],
          ),
        ),
      );
      controller.reveal();
      await tester.pumpAndSettle();
      await tester.tap(find.byTooltip('Delete media record'));
      await tester.pumpAndSettle();
      expect(deletes, 0);
      await tester.tap(find.text('Delete').last);
      await tester.pumpAndSettle();
      expect(deletes, 1);
      expect(find.textContaining('Delete failed'), findsOneWidget);
      expect(find.text('Menu screenshot'), findsOneWidget);
    },
  );

  testWidgets(
    'video and audio are not downloaded when the media gallery expands',
    (tester) async {
      var reads = 0;
      final controller = ImageDisplayFloatingGalleryController();
      addTearDown(controller.dispose);
      final artifacts = [
        for (final mime in ['video/mp4', 'audio/wav'])
          ImageDisplayArtifact(
            id: mime,
            threadId: 'thread',
            status: 'completed',
            sourceKind: 'path',
            title: mime,
            mimeType: mime,
            filePath: '',
            bytes: 1024,
            createdAt: '',
            updatedAt: '',
          ),
      ];
      await tester.pumpWidget(
        _app(
          Stack(
            children: [
              ImageDisplayFloatingGallery(
                artifacts: artifacts,
                controller: controller,
                loadBytes: (_, {onProgress}) async {
                  reads++;
                  throw StateError('unavailable');
                },
              ),
            ],
          ),
        ),
      );
      controller.reveal();
      await tester.pumpAndSettle();
      expect(reads, 0);
      expect(find.byType(Image), findsNothing);
      expect(find.byIcon(Icons.video_library_outlined), findsOneWidget);
      expect(find.byIcon(Icons.audiotrack), findsOneWidget);
      await tester.tap(find.text('video/mp4'));
      await tester.pumpAndSettle();
      expect(reads, 1);
      expect(find.text('Tap to retry'), findsOneWidget);
      expect(find.byType(Dialog), findsNothing);
    },
  );

  testWidgets(
    'live images stay collapsed until tapped, then open fullscreen and reveal from the menu',
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
      expect(find.text('Menu screenshot'), findsNothing);
      expect(find.text('1'), findsOneWidget);
      expect(reads, 0);
      await tester.tap(find.byIcon(Icons.perm_media_outlined));
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
        tester.getTopLeft(find.text('Newest screenshot')).dx,
        lessThan(tester.getTopLeft(find.text('Menu screenshot')).dx),
        reason: 'Newest images appear first in the mobile grid',
      );
      rebuild(() => artifacts = []);
      await tester.pumpAndSettle();
      expect(find.text('Menu screenshot'), findsNothing);
    },
  );

  testWidgets(
    'entering and reentering a session defers image reads until revealed',
    (tester) async {
      final controller = ImageDisplayFloatingGalleryController();
      addTearDown(controller.dispose);
      var artifacts = <ImageDisplayArtifact>[_artifact];
      var inSession = true;
      var reads = 0;
      late StateSetter rebuild;
      await tester.pumpWidget(
        _app(
          StatefulBuilder(
            builder: (_, setState) {
              rebuild = setState;
              return Stack(
                children: [
                  if (inSession)
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
      await tester.pumpAndSettle();
      expect(find.byIcon(Icons.perm_media_outlined), findsOneWidget);
      expect(find.byType(Image), findsNothing);
      expect(reads, 0);

      rebuild(() {});
      await tester.pumpAndSettle();
      expect(reads, 0, reason: 'Feed rebuilds do not read collapsed images');

      controller.reveal(artifactId: _artifact.id);
      await tester.pumpAndSettle();
      expect(find.byType(Image), findsOneWidget);
      expect(reads, 1);
      await tester.tap(find.byTooltip('Collapse'));
      await tester.pumpAndSettle();

      rebuild(() => artifacts = [_artifact, _newestArtifact]);
      await tester.pumpAndSettle();
      expect(find.text('2'), findsOneWidget);
      expect(find.byType(Image), findsNothing);
      expect(reads, 1, reason: 'New images do not load while collapsed');

      await tester.tap(find.byIcon(Icons.perm_media_outlined));
      await tester.pumpAndSettle();
      expect(reads, 2, reason: 'Reopening reuses the previously loaded image');
      expect(find.text('Newest screenshot'), findsOneWidget);

      rebuild(() => inSession = false);
      await tester.pumpAndSettle();
      rebuild(() => inSession = true);
      await tester.pumpAndSettle();
      expect(find.text('2'), findsOneWidget);
      expect(find.byType(Image), findsNothing);
      expect(reads, 2, reason: 'Reentering a session does not reload images');

      controller.reveal(artifactId: _newestArtifact.id);
      await tester.pumpAndSettle();
      expect(find.text('Newest screenshot'), findsOneWidget);
      expect(reads, 4, reason: 'Explicitly revealing loads the current images');
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
      expect(reads, 0);
      await tester.tap(find.byIcon(Icons.perm_media_outlined));
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
  locale: const Locale('en'),
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
