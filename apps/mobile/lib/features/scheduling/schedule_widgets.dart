import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/locale/app_localizations_ext.dart';
import '../../core/models/thread_models.dart';
import '../../core/theme/eco_icons.dart';
import '../../core/theme/eco_theme.dart';
import '../../core/widgets/image_memory_lightbox.dart';
import '../threads/thread_providers.dart';

class ScheduleSection extends StatelessWidget {
  const ScheduleSection({super.key, required this.title, required this.child});
  final String title;
  final Widget child;

  @override
  Widget build(BuildContext context) => Material(
    color: ecoColors(context).bgElevated,
    shape: RoundedRectangleBorder(
      borderRadius: BorderRadius.circular(20),
      side: BorderSide(color: ecoColors(context).borderSubtle),
    ),
    clipBehavior: Clip.antiAlias,
    child: Padding(
      padding: const EdgeInsets.all(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(
            title,
            style: Theme.of(
              context,
            ).textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w600),
          ),
          const SizedBox(height: 16),
          child,
        ],
      ),
    ),
  );
}

class ScheduleImages extends StatelessWidget {
  const ScheduleImages({
    super.key,
    required this.attachments,
    required this.threadId,
    this.onRemove,
  });
  final List<PromptImageAttachment> attachments;
  final String threadId;
  final ValueChanged<int>? onRemove;

  @override
  Widget build(BuildContext context) => Wrap(
    spacing: 10,
    runSpacing: 10,
    children: [
      for (var i = 0; i < attachments.length; i++)
        _ScheduleImage(
          attachment: attachments[i],
          threadId: threadId,
          index: i,
          onRemove: onRemove == null ? null : () => onRemove!(i),
        ),
    ],
  );
}

class _ScheduleImage extends ConsumerStatefulWidget {
  const _ScheduleImage({
    required this.attachment,
    required this.threadId,
    required this.index,
    this.onRemove,
  });
  final PromptImageAttachment attachment;
  final String threadId;
  final int index;
  final VoidCallback? onRemove;
  @override
  ConsumerState<_ScheduleImage> createState() => _ScheduleImageState();
}

class _ScheduleImageState extends ConsumerState<_ScheduleImage> {
  Object? _identity;
  Future<Uint8List>? _bytes;

  Widget _imageError(BuildContext context) => ColoredBox(
    color: ecoColors(context).bgInput,
    child: Column(
      mainAxisAlignment: MainAxisAlignment.center,
      children: [
        Icon(EcoIcons.image, size: 20, color: ecoColors(context).danger),
        const SizedBox(height: 4),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 4),
          child: Text(
            context.l10n.activityImageViewErrorReadFailed,
            maxLines: 3,
            overflow: TextOverflow.ellipsis,
            textAlign: TextAlign.center,
            style: TextStyle(
              fontSize: 10,
              height: 1.2,
              color: ecoColors(context).textSecondary,
            ),
          ),
        ),
      ],
    ),
  );

  @override
  Widget build(BuildContext context) {
    final a = widget.attachment;
    final rpc = ref.watch(desktopRpcProvider);
    final identity = (
      rpc?.desktopDeviceId,
      widget.threadId,
      a.contentRef,
      a.mediaType,
      a.data,
    );
    if (identity != _identity) {
      _identity = identity;
      _bytes = () async {
        if (a.data.isNotEmpty) return base64Decode(a.data);
        if (rpc == null || a.contentRef == null) {
          throw StateError('Image content is unavailable');
        }
        return rpc.downloadPromptImage(
          contextKey: 'thread:${widget.threadId}',
          contentRef: a.contentRef!,
          mediaType: a.mediaType,
        );
      }();
    }
    return SizedBox(
      width: 82,
      height: 82,
      child: Stack(
        children: [
          Positioned.fill(
            child: ClipRRect(
              borderRadius: BorderRadius.circular(14),
              child: FutureBuilder<Uint8List>(
                future: _bytes,
                builder: (context, snapshot) {
                  if (snapshot.hasError) {
                    return _imageError(context);
                  }
                  final bytes = snapshot.data;
                  if (bytes == null) {
                    return ColoredBox(
                      color: ecoColors(context).bgInput,
                      child: const Center(
                        child: SizedBox.square(
                          dimension: 18,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        ),
                      ),
                    );
                  }
                  return Semantics(
                    label: context.l10n.composerPendingImage(widget.index + 1),
                    button: true,
                    child: InkWell(
                      onTap: () =>
                          showImageMemoryLightbox(context, images: [bytes]),
                      child: Image.memory(
                        bytes,
                        fit: BoxFit.cover,
                        cacheWidth: 240,
                        errorBuilder: (_, _, _) => _imageError(context),
                      ),
                    ),
                  );
                },
              ),
            ),
          ),
          if (widget.onRemove != null)
            Positioned(
              top: 0,
              right: 0,
              child: IconButton.filled(
                tooltip: context.l10n.composerRemoveImage(widget.index + 1),
                onPressed: widget.onRemove,
                icon: const Icon(Icons.close, size: 16),
                constraints: const BoxConstraints.tightFor(
                  width: 32,
                  height: 32,
                ),
                padding: EdgeInsets.zero,
              ),
            ),
          if (a.uploadProgress != null)
            Positioned(
              left: 0,
              right: 0,
              bottom: 0,
              child: LinearProgressIndicator(value: a.uploadProgress),
            ),
        ],
      ),
    );
  }
}
