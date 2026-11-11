import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

import '../test/mobile_parity_test.dart' as parity;
import '../test/image_display_floating_gallery_test.dart' as gallery;
import 'mobile_parity_flows_test.dart' as flows;

// Exercise production pages on the real iOS/Android engine and screen size.
// RPC responses are isolated fixtures: this suite does not publish snapshots,
// delete desktop files, or change a real conversation's notification settings.
void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  WidgetController.hitTestWarningShouldBeFatal = true;
  parity.main(enterSearchText: _enterSearchText);
  gallery.main();
  flows.main();
}

Future<void> _enterSearchText(WidgetTester tester, String text) async {
  if (Platform.isIOS) {
    // Use the production native bridge. UISearchBar is not an EditableText;
    // setText updates UIKit and emits the same onChanged event as typing.
    final field = tester.widget<UiKitView>(
      find.byWidgetPredicate(
        (widget) =>
            widget is UiKitView &&
            widget.viewType == 'eco_mobile/ios26_search_field',
      ),
    );
    final id = (field.creationParams as Map)['id'];
    await MethodChannel(
      'eco_mobile/ios26_search_field_$id',
    ).invokeMethod<void>('setText', {'text': text});
  } else {
    await tester.enterText(find.byType(TextField), text);
  }
}
