import 'package:eco_mobile/core/platform/photo_library_saver.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  const channel = MethodChannel('gal');
  const saver = PhotoLibrarySaver();
  late List<MethodCall> calls;
  var granted = true;
  String? failure;
  final bytes = Uint8List.fromList([1, 2, 3, 4]);

  setUp(() {
    calls = [];
    granted = true;
    failure = null;
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (call) async {
          calls.add(call);
          if (call.method == 'hasAccess' || call.method == 'requestAccess') {
            return granted;
          }
          if (failure != null) throw PlatformException(code: failure!);
          return null;
        });
  });
  tearDown(
    () => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, null),
  );

  test(
    'writes original bytes with add-only permissions and no named album',
    () async {
      await saver.save(bytes);
      final write = calls.singleWhere((call) => call.method == 'putImageBytes');
      expect(write.arguments['bytes'], orderedEquals(bytes));
      expect(write.arguments['album'], isNull);
      expect(write.arguments['name'], startsWith('Mori_'));
      expect(
        calls
            .where((call) => call.method == 'requestAccess')
            .every((call) => call.arguments['toAlbum'] == false),
        isTrue,
      );
    },
  );

  test('denied permission never attempts a write', () async {
    granted = false;
    await expectLater(
      saver.save(bytes),
      throwsA(
        isA<PhotoLibrarySaveException>().having(
          (e) => e.failure,
          'failure',
          PhotoLibrarySaveFailure.accessDenied,
        ),
      ),
    );
    expect(calls.map((call) => call.method), ['hasAccess', 'requestAccess']);
  });

  test('granting requested permission proceeds to save', () async {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (call) async {
          calls.add(call);
          return switch (call.method) {
            'hasAccess' => false,
            'requestAccess' => true,
            _ => null,
          };
        });
    await saver.save(bytes);
    expect(calls.last.method, 'putImageBytes');
  });

  for (final entry in {
    'ACCESS_DENIED': PhotoLibrarySaveFailure.accessDenied,
    'NOT_ENOUGH_SPACE': PhotoLibrarySaveFailure.notEnoughSpace,
    'NOT_SUPPORTED_FORMAT': PhotoLibrarySaveFailure.unsupportedFormat,
    'UNEXPECTED': PhotoLibrarySaveFailure.unexpected,
  }.entries) {
    test('surfaces ${entry.key} without reporting success', () async {
      failure = entry.key;
      await expectLater(
        saver.save(bytes),
        throwsA(
          isA<PhotoLibrarySaveException>().having(
            (e) => e.failure,
            'failure',
            entry.value,
          ),
        ),
      );
    });
  }

  test('empty data cannot be saved', () async {
    await expectLater(
      saver.save(Uint8List(0)),
      throwsA(isA<PhotoLibrarySaveException>()),
    );
    expect(calls, isEmpty);
  });

  test('missing native plugin is a visible unavailable failure', () async {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(
          channel,
          (_) async => throw MissingPluginException(),
        );
    await expectLater(
      saver.save(bytes),
      throwsA(
        isA<PhotoLibrarySaveException>().having(
          (e) => e.failure,
          'failure',
          PhotoLibrarySaveFailure.unavailable,
        ),
      ),
    );
  });
}
