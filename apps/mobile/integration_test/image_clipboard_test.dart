import 'dart:convert';

import 'package:eco_mobile/core/widgets/image_memory_lightbox.dart';
import 'package:eco_mobile/l10n/generated/app_localizations.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

final _png = base64Decode(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
);

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('copies original image through the native clipboard channel', (
    tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        locale: const Locale('zh'),
        localizationsDelegates: AppLocalizations.localizationsDelegates,
        supportedLocales: AppLocalizations.supportedLocales,
        home: Builder(
          builder: (context) => Scaffold(
            body: TextButton(
              onPressed: () =>
                  showImageMemoryLightboxSingle(context, bytes: _png),
              child: const Text('open'),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
    expect(find.text('复制'), findsOneWidget);

    await tester.tap(find.byKey(const ValueKey('image-copy-to-clipboard')));
    await tester.pumpAndSettle();

    expect(find.text('已复制'), findsOneWidget);
    final button = tester.widget<OutlinedButton>(
      find.byKey(const ValueKey('image-copy-to-clipboard')),
    );
    expect(button.style!.backgroundColor, isNotNull);
    expect(tester.takeException(), isNull);
  });
}
