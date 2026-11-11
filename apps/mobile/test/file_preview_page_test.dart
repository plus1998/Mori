import 'dart:convert';
import 'dart:typed_data';

import 'package:eco_mobile/core/models/file_preview_models.dart';
import 'package:eco_mobile/features/files/file_preview_page.dart';
import 'package:eco_mobile/l10n/generated/app_localizations.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

Widget _app(Widget child) => MaterialApp(
  localizationsDelegates: AppLocalizations.localizationsDelegates,
  supportedLocales: AppLocalizations.supportedLocales,
  home: child,
);

void main() {
  testWidgets('loads and displays the original text content', (tester) async {
    await tester.pumpWidget(
      _app(
        FilePreviewPage(
          link: const LocalFileLink(path: '/repo/notes.txt', line: 2),
          readFile: (_, {relativeTo, isCancelled, onProgress}) async =>
              RemoteFileData(
                path: '/repo/notes.txt',
                name: 'notes.txt',
                bytes: Uint8List.fromList(utf8.encode('正文内容')),
              ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('file-preview-source')), findsOneWidget);
  });

  testWidgets('shows the explicit unsupported preview state', (tester) async {
    await tester.pumpWidget(
      _app(
        FilePreviewPage(
          link: const LocalFileLink(path: '/repo/data.bin'),
          readFile: (_, {relativeTo, isCancelled, onProgress}) async =>
              RemoteFileData(
                path: '/repo/data.bin',
                name: 'data.bin',
                bytes: Uint8List.fromList([0, 1, 2, 255]),
              ),
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
