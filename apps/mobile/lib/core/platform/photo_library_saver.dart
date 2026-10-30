import 'package:flutter/services.dart';
import 'package:gal/gal.dart';

enum PhotoLibrarySaveFailure {
  accessDenied,
  notEnoughSpace,
  unsupportedFormat,
  unavailable,
  unexpected,
}

class PhotoLibrarySaveException implements Exception {
  const PhotoLibrarySaveException(this.failure, {this.cause});
  final PhotoLibrarySaveFailure failure;
  final Object? cause;

  @override
  String toString() =>
      'Photo library save failed: ${failure.name}${cause == null ? '' : ': $cause'}';
}

class PhotoLibrarySaver {
  const PhotoLibrarySaver();

  /// Write original bytes to the camera roll. No named album: iOS only needs
  /// add-only access, and image encoding/metadata remain intact.
  Future<void> save(Uint8List bytes) async {
    if (bytes.isEmpty) {
      throw const PhotoLibrarySaveException(
        PhotoLibrarySaveFailure.unsupportedFormat,
      );
    }
    try {
      if (!await Gal.hasAccess() && !await Gal.requestAccess()) {
        throw const PhotoLibrarySaveException(
          PhotoLibrarySaveFailure.accessDenied,
        );
      }
      await Gal.putImageBytes(
        bytes,
        name: 'Mori_${DateTime.now().microsecondsSinceEpoch}',
      );
    } on GalException catch (error) {
      throw PhotoLibrarySaveException(switch (error.type) {
        GalExceptionType.accessDenied => PhotoLibrarySaveFailure.accessDenied,
        GalExceptionType.notEnoughSpace =>
          PhotoLibrarySaveFailure.notEnoughSpace,
        GalExceptionType.notSupportedFormat =>
          PhotoLibrarySaveFailure.unsupportedFormat,
        GalExceptionType.unexpected => PhotoLibrarySaveFailure.unexpected,
      }, cause: error);
    } on MissingPluginException catch (error) {
      throw PhotoLibrarySaveException(
        PhotoLibrarySaveFailure.unavailable,
        cause: error,
      );
    }
  }
}
