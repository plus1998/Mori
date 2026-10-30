import 'package:flutter/services.dart';

enum ImageClipboardFailure { unsupportedImage, unavailable, writeFailed }

class ImageClipboardException implements Exception {
  const ImageClipboardException(this.failure, {this.cause});
  final ImageClipboardFailure failure;
  final Object? cause;
  @override
  String toString() =>
      'Image clipboard failed: ${failure.name}${cause == null ? '' : ': $cause'}';
}

/// Copies encoded original bytes, preserving format, metadata and transparency.
/// Android publishes a readable image content URI; iOS publishes typed data.
class ImageClipboard {
  const ImageClipboard();
  static const channel = MethodChannel('eco_mobile/image_clipboard');

  Future<void> copy(Uint8List bytes) async {
    if (bytes.isEmpty) {
      throw const ImageClipboardException(
        ImageClipboardFailure.unsupportedImage,
      );
    }
    try {
      final written = await channel.invokeMethod<bool>('copyImage', {
        'bytes': bytes,
      });
      if (written != true) {
        throw const ImageClipboardException(ImageClipboardFailure.writeFailed);
      }
    } on MissingPluginException catch (error) {
      throw ImageClipboardException(
        ImageClipboardFailure.unavailable,
        cause: error,
      );
    } on PlatformException catch (error) {
      throw ImageClipboardException(switch (error.code) {
        'invalid_image' => ImageClipboardFailure.unsupportedImage,
        'clipboard_unavailable' => ImageClipboardFailure.unavailable,
        _ => ImageClipboardFailure.writeFailed,
      }, cause: error);
    }
  }
}
