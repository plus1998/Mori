import 'dart:convert';
import 'dart:typed_data';

import 'package:eco_mobile/core/models/file_preview_models.dart';
import 'package:eco_mobile/core/widgets/eco_markdown.dart';
import 'package:eco_mobile/core/widgets/markdown_link.dart';
import 'package:eco_mobile/features/files/file_preview_page.dart';
import 'package:eco_mobile/l10n/generated/app_localizations.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('native file link opens loaded preview and unsupported state', (
    tester,
  ) async {
    Future<RemoteFileData> readFile(
      LocalFileLink link, {
      String? relativeTo,
      bool Function()? isCancelled,
      void Function(int received, int total)? onProgress,
    }) async {
      if (link.path.endsWith('.bin')) {
        return RemoteFileData(
          path: '/repo/data.bin',
          name: 'data.bin',
          bytes: Uint8List.fromList([0, 1, 2, 255]),
        );
      }
      final bytes = Uint8List.fromList(utf8.encode('来自桌面端的原始内容'));
      onProgress?.call(bytes.length, bytes.length);
      return RemoteFileData(path: link.path, name: 'notes.txt', bytes: bytes);
    }

    await tester.pumpWidget(
      MaterialApp(
        locale: const Locale('zh'),
        localizationsDelegates: AppLocalizations.localizationsDelegates,
        supportedLocales: AppLocalizations.supportedLocales,
        home: FileLinkScope(
          onOpenFile: (link) => openFilePreview(
            tester.element(find.byType(EcoMarkdown)),
            link: link,
            readFile: readFile,
          ),
          child: Scaffold(
            body: EcoMarkdown(
              text:
                  '[查看文件](eco-file:%7B%22path%22%3A%22%2Frepo%2Fnotes.txt%22%7D)',
            ),
          ),
        ),
      ),
    );
    await tester.pump();
    await tester.tap(find.text('查看文件', findRichText: true));
    await tester.pumpAndSettle();
    expect(find.byType(FilePreviewPage), findsOneWidget);
    expect(find.byKey(const ValueKey('file-preview-source')), findsOneWidget);
    expect(find.text('来自桌面端的原始内容'), findsOneWidget);

    Navigator.of(tester.element(find.byType(FilePreviewPage))).pop();
    await tester.pumpAndSettle();
    expect(find.byType(FilePreviewPage), findsNothing);
    await tester.pumpWidget(
      MaterialApp(
        localizationsDelegates: AppLocalizations.localizationsDelegates,
        supportedLocales: AppLocalizations.supportedLocales,
        home: FilePreviewPage(
          link: const LocalFileLink(path: '/repo/data.bin'),
          readFile: readFile,
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(
      find.byKey(const ValueKey('file-preview-unsupported')),
      findsOneWidget,
    );
  });
}
