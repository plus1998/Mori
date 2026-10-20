import 'dart:async';

import 'package:eco_mobile/core/services/eco_tts_service.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_tts/flutter_tts.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('stopping idle playback does not notify every feed listener', () async {
    final engine = _DelayedStopFlutterTts();
    final service = EcoTtsService(engine: engine);
    var notifications = 0;
    service.addListener(() => notifications++);
    final stop = service.stop();
    engine.completeStop();
    await stop;
    expect(notifications, 0);
    service.dispose();
  });

  test('late native stop completion does not notify after dispose', () async {
    final engine = _DelayedStopFlutterTts();
    final service = EcoTtsService(engine: engine);
    final stop = service.stop();

    service.dispose();
    engine.completeStop();

    await expectLater(stop, completes);
  });
}

class _DelayedStopFlutterTts extends FlutterTts {
  final _stopResult = Completer<dynamic>();

  @override
  Future<dynamic> stop() => _stopResult.future;

  void completeStop() => _stopResult.complete(1);
}
