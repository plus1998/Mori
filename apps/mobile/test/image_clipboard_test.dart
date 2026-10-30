import 'package:eco_mobile/core/platform/image_clipboard.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  const channel = ImageClipboard.channel;
  final messenger =
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
  final original = Uint8List.fromList([137, 80, 78, 71, 0, 255, 10]);

  tearDown(() => messenger.setMockMethodCallHandler(channel, null));

  test(
    'sends the exact original encoded bytes and requires native acceptance',
    () async {
      Uint8List? received;
      messenger.setMockMethodCallHandler(channel, (call) async {
        expect(call.method, 'copyImage');
        received = call.arguments['bytes'] as Uint8List;
        return true;
      });

      await const ImageClipboard().copy(original);

      expect(received, orderedEquals(original));
      expect(identical(received, original), isFalse);
    },
  );

  test('rejects empty input before invoking native clipboard', () async {
    var called = false;
    messenger.setMockMethodCallHandler(channel, (call) async {
      called = true;
      return true;
    });

    await expectLater(
      const ImageClipboard().copy(Uint8List(0)),
      throwsA(
        isA<ImageClipboardException>().having(
          (error) => error.failure,
          'failure',
          ImageClipboardFailure.unsupportedImage,
        ),
      ),
    );
    expect(called, isFalse);
  });

  test(
    'does not report success when the native clipboard declines the write',
    () async {
      messenger.setMockMethodCallHandler(channel, (call) async => false);

      await expectLater(
        const ImageClipboard().copy(original),
        throwsA(
          isA<ImageClipboardException>().having(
            (error) => error.failure,
            'failure',
            ImageClipboardFailure.writeFailed,
          ),
        ),
      );
    },
  );

  test(
    'maps platform failures to explicit user-facing failure types',
    () async {
      for (final (code, failure) in [
        ('invalid_image', ImageClipboardFailure.unsupportedImage),
        ('clipboard_unavailable', ImageClipboardFailure.unavailable),
        ('copy_failed', ImageClipboardFailure.writeFailed),
      ]) {
        messenger.setMockMethodCallHandler(
          channel,
          (call) async => throw PlatformException(code: code),
        );
        await expectLater(
          const ImageClipboard().copy(original),
          throwsA(
            isA<ImageClipboardException>().having(
              (error) => error.failure,
              'failure',
              failure,
            ),
          ),
        );
      }
    },
  );

  test('reports a missing native clipboard implementation', () async {
    messenger.setMockMethodCallHandler(channel, null);

    await expectLater(
      const ImageClipboard().copy(original),
      throwsA(
        isA<ImageClipboardException>().having(
          (error) => error.failure,
          'failure',
          ImageClipboardFailure.unavailable,
        ),
      ),
    );
  });
}
