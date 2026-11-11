import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

import '../test/activity_feed_status_geometry_test.dart' as geometry;

// Replay deterministic projection updates through the production feed on the
// native engine. No desktop connection or real conversation is changed.
void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  WidgetController.hitTestWarningShouldBeFatal = true;
  var checkpoint = 0;
  geometry.main(
    onCheckpoint: (tester, name, frames) async {
      debugPrint('STATUS_GEOMETRY $name ${jsonEncode(frames.first)}');
      const directory = String.fromEnvironment('ECO_STATUS_GEOMETRY_DIR');
      if (directory.isEmpty) return;
      if (!directory.startsWith('/tmp/')) {
        throw ArgumentError('Geometry artifacts must stay in /tmp.');
      }
      await Directory(directory).create(recursive: true);
      final artifact = '${checkpoint++}-$name';
      await File('$directory/$artifact.json').writeAsString(jsonEncode(frames));
      final phase = frames.first['phase'];
      if (name.startsWith('grouped-true-') &&
          (phase == 'thinking' ||
              phase == 'running-tool' ||
              phase == 'writing')) {
        await binding.pump(const Duration(milliseconds: 300));
        await File(
          '$directory/$artifact.png',
        ).writeAsBytes(await binding.takeScreenshot(artifact));
      }
    },
  );
}
