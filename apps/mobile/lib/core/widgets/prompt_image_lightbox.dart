import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/widgets.dart';

import '../locale/app_localizations_ext.dart';
import '../models/thread_models.dart';
import 'image_memory_lightbox.dart';

typedef PromptImageOriginalLoader =
    Future<Uint8List> Function(PromptImageAttachment attachment);

/// Keeps original-image reads scoped to the conversation that owns the image.
class PromptImageReadScope extends InheritedWidget {
  const PromptImageReadScope({
    super.key,
    required this.loadOriginal,
    required super.child,
  });

  final PromptImageOriginalLoader? loadOriginal;

  @override
  bool updateShouldNotify(PromptImageReadScope oldWidget) =>
      loadOriginal != oldWidget.loadOriginal;
}

Future<void> showPromptImageLightbox(
  BuildContext context, {
  required List<PromptImageAttachment> attachments,
  int initialIndex = 0,
}) {
  final loader = context
      .getInheritedWidgetOfExactType<PromptImageReadScope>()
      ?.loadOriginal;
  final unavailable = context.l10n.activityImageViewErrorBridgeUnavailable;
  // Freeze the gallery for this dialog; message updates must not change indexes.
  final images = List<PromptImageAttachment>.of(attachments);
  return showImageMemoryLightbox(
    context,
    images: [for (final _ in images) Uint8List(0)],
    initialIndex: initialIndex,
    loadImage: (index) async {
      final image = images[index];
      if (image.contentRef?.trim().isNotEmpty == true) {
        if (loader == null) throw StateError(unavailable);
        // In sent messages data contains a bounded thumbnail, even when the
        // original contentRef and byteLength are present. Never enlarge it.
        final bytes = await loader(image);
        if (bytes.isEmpty ||
            (image.byteLength != null && bytes.length != image.byteLength)) {
          throw const FormatException('Original image byte length mismatch.');
        }
        return bytes;
      }
      // Older messages without durable references only contain inline bytes.
      final bytes = base64Decode(image.data);
      if (bytes.isEmpty) throw const FormatException('Image content is empty.');
      return bytes;
    },
  );
}
