import 'dart:io';
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:eco_mobile/core/models/image_display_models.dart';
import 'package:eco_mobile/core/models/image_view_models.dart';
import 'package:eco_mobile/core/theme/eco_theme.dart';
import 'package:eco_mobile/features/threads/image_display_floating_gallery.dart';
import 'package:eco_mobile/l10n/generated/app_localizations.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

// Production gallery and native Photos plugin; fixtures are drawn in memory.
// Run against a simulator with add-only photo permission granted. No account,
// desktop RPC, or model requests. Files/screenshots must remain outside git.
var _captureKey = GlobalKey();

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  late Map<String, Uint8List> images;
  setUpAll(() async {
    images = {
      'portrait': await _fixture(true),
      'landscape': await _fixture(false),
    };
  });

  Future<void> screenshot(String name) async {
    const directory = String.fromEnvironment('ECO_GALLERY_SCREENSHOTS');
    if (directory.isEmpty) return;
    if (!directory.startsWith('/tmp/')) {
      throw ArgumentError('Screenshots must stay in /tmp.');
    }
    await Directory(directory).create(recursive: true);
    // Native capture can include iOS's launch snapshot even while the Flutter
    // test tree is active. Capture the actual rendered app, including dialogs.
    final boundary =
        _captureKey.currentContext!.findRenderObject()!
            as RenderRepaintBoundary;
    final image = await boundary.toImage(
      pixelRatio: View.of(_captureKey.currentContext!).devicePixelRatio,
    );
    final data = (await image.toByteData(format: ui.ImageByteFormat.png))!;
    await File('$directory/$name.png').writeAsBytes(
      data.buffer.asUint8List(data.offsetInBytes, data.lengthInBytes),
    );
    image.dispose();
  }

  testWidgets(
    'native gallery, paged preview, image clipboard and real Photos save',
    (tester) async {
      for (final dark in [false, true]) {
        // Each theme gets a fresh Navigator and a collapsed gallery.
        _captureKey = GlobalKey();
        await tester.pumpWidget(
          _GalleryApp(key: ValueKey(dark), dark: dark, images: images),
        );
        await tester.pumpAndSettle();
        await tester.tap(find.byIcon(Icons.photo_library_outlined));
        await tester.pumpAndSettle();
        final grid = find.byType(GridView);
        expect(grid, findsOneWidget);
        expect(tester.getSize(grid).width, greaterThan(300));
        await screenshot('gallery-${dark ? 'dark' : 'light'}');
        await tester.tap(find.text('移动端界面'));
        await tester.pumpAndSettle();
        expect(find.byType(InteractiveViewer), findsOneWidget);
        expect(find.text('2 / 2'), findsOneWidget);
        await screenshot('preview-${dark ? 'dark' : 'light'}');
        await tester.tap(find.text('复制'));
        await tester.pumpAndSettle();
        expect(find.text('已复制'), findsOneWidget);
        await screenshot('preview-copied-${dark ? 'dark' : 'light'}');
        await tester.drag(find.byType(PageView), const Offset(340, 0));
        await tester.pumpAndSettle();
        expect(find.text('1 / 2'), findsOneWidget);
        await tester.tap(find.text('复制'));
        await tester.pumpAndSettle();
        expect(find.text('已复制'), findsOneWidget);
        await tester.drag(find.byType(PageView), const Offset(-340, 0));
        await tester.pumpAndSettle();
        expect(find.text('2 / 2'), findsOneWidget);
        await tester.tap(find.text('保存到相册'));
        await tester.pumpAndSettle();
        expect(find.text('已保存到相册'), findsOneWidget);
        expect(find.text('正在保存…'), findsNothing);
        const directory = String.fromEnvironment('ECO_GALLERY_SCREENSHOTS');
        if (directory.isNotEmpty) {
          await File(
            '$directory/original-portrait.png',
          ).writeAsBytes(images['portrait']!);
        }
        await tester.drag(find.byType(PageView), const Offset(340, 0));
        await tester.pumpAndSettle();
        expect(find.text('1 / 2'), findsOneWidget);
        expect(find.text('保存到相册'), findsOneWidget);
        await screenshot('preview-landscape-${dark ? 'dark' : 'light'}');
        await tester.tap(find.byTooltip('关闭'));
        await tester.pumpAndSettle();
        expect(find.byType(Dialog), findsNothing);
        expect(tester.takeException(), isNull);
      }
    },
  );
}

class _GalleryApp extends StatelessWidget {
  const _GalleryApp({super.key, required this.dark, required this.images});
  final bool dark;
  final Map<String, Uint8List> images;
  @override
  Widget build(BuildContext context) => RepaintBoundary(
    key: _captureKey,
    child: MaterialApp(
      debugShowCheckedModeBanner: false,
      theme: dark ? buildEcoDarkTheme() : buildEcoLightTheme(),
      locale: const Locale('zh'),
      localizationsDelegates: AppLocalizations.localizationsDelegates,
      supportedLocales: AppLocalizations.supportedLocales,
      home: Scaffold(
        appBar: AppBar(title: const Text('界面设计')),
        body: Stack(
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(24, 28, 24, 0),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text(
                    '方案已生成',
                    style: TextStyle(fontSize: 24, fontWeight: FontWeight.w600),
                  ),
                  const SizedBox(height: 12),
                  Text(
                    '两张界面草图已放入画廊，点开即可查看完整图片。',
                    style: TextStyle(
                      fontSize: 15,
                      height: 1.6,
                      color: dark ? Colors.white60 : Colors.black54,
                    ),
                  ),
                ],
              ),
            ),
            ImageDisplayFloatingGallery(
              artifacts: [
                for (final id in ['portrait', 'landscape'])
                  ImageDisplayArtifact(
                    id: id,
                    threadId: 'fixture',
                    title: id == 'portrait' ? '移动端界面' : '工作台概览',
                    status: 'completed',
                    sourceKind: 'path',
                    mimeType: 'image/png',
                    filePath: '/fixture/$id.png',
                    bytes: images[id]!.length,
                    createdAt: '',
                    updatedAt: '',
                  ),
              ],
              loadBytes: (id, {onProgress}) async => ImageViewReadData(
                bytes: images[id]!,
                mimeType: 'image/png',
                path: '/fixture/$id.png',
                fileName: '$id.png',
                byteLength: images[id]!.length,
                width: id == 'portrait' ? 900 : 1200,
                height: id == 'portrait' ? 1200 : 800,
              ),
              bottomInset: 100,
            ),
            Positioned(
              left: 12,
              right: 12,
              bottom: 24,
              child: Container(
                padding: const EdgeInsets.symmetric(
                  horizontal: 18,
                  vertical: 20,
                ),
                decoration: BoxDecoration(
                  color: dark
                      ? const Color(0xFF242426)
                      : const Color(0xFFF1F1F4),
                  borderRadius: BorderRadius.circular(24),
                ),
                child: Text(
                  '继续对话…',
                  style: TextStyle(
                    color: dark ? Colors.white38 : Colors.black38,
                    fontSize: 16,
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    ),
  );
}

Future<Uint8List> _fixture(bool portrait) async {
  final width = portrait ? 900 : 1200;
  final height = portrait ? 1200 : 800;
  final recorder = ui.PictureRecorder();
  final canvas = Canvas(recorder);
  final bounds = Rect.fromLTWH(0, 0, width.toDouble(), height.toDouble());
  canvas.drawRect(bounds, Paint()..color = const Color(0xFFF3F4EF));
  void text(
    String value,
    Offset position,
    double size,
    Color color, {
    FontWeight weight = FontWeight.w400,
  }) {
    final painter = TextPainter(
      text: TextSpan(
        text: value,
        style: TextStyle(fontSize: size, fontWeight: weight, color: color),
      ),
      textDirection: TextDirection.ltr,
    )..layout(maxWidth: width - position.dx - 60);
    painter.paint(canvas, position);
    painter.dispose();
  }

  text(
    'MORI / STUDIO',
    const Offset(60, 60),
    22,
    const Color(0xFF526558),
    weight: FontWeight.w600,
  );
  text(
    portrait ? 'A calmer place\nto make things.' : 'Space for your next idea.',
    const Offset(60, 135),
    portrait ? 64 : 60,
    const Color(0xFF223D2B),
    weight: FontWeight.w600,
  );
  final artTop = portrait ? 375.0 : 290.0;
  final rect = Rect.fromLTWH(60, artTop, width - 120, portrait ? 480 : 340);
  canvas.drawRRect(
    RRect.fromRectAndRadius(rect, const Radius.circular(30)),
    Paint()..color = const Color(0xFFC7D4BF),
  );
  canvas.save();
  canvas.clipRRect(RRect.fromRectAndRadius(rect, const Radius.circular(30)));
  for (var i = 0; i < 5; i++) {
    canvas.drawCircle(
      Offset(width * .78 - i * 60, artTop + 80 + i * 100),
      190,
      Paint()
        ..color = [
          const Color(0xFF6D8E6A),
          const Color(0xFF527852),
          const Color(0xFF355E3F),
          const Color(0xFF244B32),
          const Color(0xFF193D29),
        ][i],
    );
  }
  canvas.restore();
  text(
    'Ideas, quietly taking shape.',
    Offset(60, portrait ? 905 : 675),
    28,
    const Color(0xFF35513D),
    weight: FontWeight.w500,
  );
  if (portrait) {
    text(
      'Your workspace, with room to breathe.',
      const Offset(60, 960),
      22,
      const Color(0xFF738175),
    );
  }
  canvas.drawRRect(
    RRect.fromRectAndRadius(
      Rect.fromLTWH(60, height - 120.0, 230, 56),
      const Radius.circular(28),
    ),
    Paint()..color = const Color(0xFF223D2B),
  );
  text('Open workspace', Offset(88, height - 108.0), 22, Colors.white);
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
