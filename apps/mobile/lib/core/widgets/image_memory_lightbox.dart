import 'dart:typed_data';

import 'package:flutter/material.dart';

import '../locale/app_localizations_ext.dart';
import '../theme/eco_icons.dart';
import '../theme/eco_theme.dart';

/// Fullscreen zoomable preview for in-memory images.
///
/// Uses Flutter [Dialog.fullscreen], [PageView], and [InteractiveViewer]
/// (same stack as the image-display gallery lightbox).
/// When [loadImage] is supplied, it loads each page on demand and replaces the
/// corresponding entry in [images]; failures show a retry action.
Future<void> showImageMemoryLightbox(
  BuildContext context, {
  required List<Uint8List> images,
  int initialIndex = 0,
  String? title,
  List<String?>? titles,
  Future<Uint8List> Function(int index)? loadImage,
}) async {
  if (images.isEmpty) return;
  final start = initialIndex.clamp(0, images.length - 1);
  final eco = ecoColors(context);

  await showDialog<void>(
    context: context,
    barrierColor: eco.bgOverlay,
    builder: (dialogContext) {
      return Dialog.fullscreen(
        backgroundColor: eco.bgElevated,
        child: _ImageMemoryLightboxBody(
          images: images,
          initialIndex: start,
          title: title,
          titles: titles,
          loadImage: loadImage,
        ),
      );
    },
  );
}

Future<void> showImageMemoryLightboxSingle(
  BuildContext context, {
  required Uint8List bytes,
  String? title,
}) {
  return showImageMemoryLightbox(context, images: [bytes], title: title);
}

class _ImageMemoryLightboxBody extends StatefulWidget {
  const _ImageMemoryLightboxBody({
    required this.images,
    required this.initialIndex,
    this.title,
    this.titles,
    this.loadImage,
  });

  final List<Uint8List> images;
  final int initialIndex;
  final String? title;
  final List<String?>? titles;
  final Future<Uint8List> Function(int index)? loadImage;

  @override
  State<_ImageMemoryLightboxBody> createState() =>
      _ImageMemoryLightboxBodyState();
}

class _ImageMemoryLightboxBodyState extends State<_ImageMemoryLightboxBody> {
  late final PageController _pageController;
  late int _index;
  final _loads = <int, Future<Uint8List>>{};

  @override
  void initState() {
    super.initState();
    _index = widget.initialIndex;
    _pageController = PageController(initialPage: widget.initialIndex);
  }

  @override
  void dispose() {
    _pageController.dispose();
    super.dispose();
  }

  String? get _currentTitle {
    final titles = widget.titles;
    if (titles != null && _index >= 0 && _index < titles.length) {
      final entry = titles[_index]?.trim();
      if (entry != null && entry.isNotEmpty) return entry;
    }
    final fallback = widget.title?.trim();
    if (fallback != null && fallback.isNotEmpty) return fallback;
    if (widget.images.length > 1) {
      return '${_index + 1} / ${widget.images.length}';
    }
    return null;
  }

  @override
  Widget build(BuildContext context) {
    final eco = ecoColors(context);
    final title = _currentTitle;

    return SafeArea(
      child: Stack(
        fit: StackFit.expand,
        children: [
          PageView.builder(
            controller: _pageController,
            itemCount: widget.images.length,
            onPageChanged: (value) => setState(() => _index = value),
            itemBuilder: (context, index) {
              if (widget.loadImage == null) {
                return _buildImage(widget.images[index]);
              }
              return FutureBuilder<Uint8List>(
                future: _loads.putIfAbsent(
                  index,
                  () => Future.sync(() => widget.loadImage!(index)),
                ),
                builder: (context, snapshot) {
                  if (snapshot.hasError) {
                    return Center(
                      child: Column(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Text(context.l10n.activityImageViewErrorReadFailed),
                          const SizedBox(height: 8),
                          TextButton.icon(
                            onPressed: () => setState(() {
                              _loads.remove(index);
                            }),
                            icon: const Icon(Icons.refresh),
                            label: Text(context.l10n.commonRetry),
                          ),
                        ],
                      ),
                    );
                  }
                  final bytes = snapshot.data;
                  if (bytes == null) {
                    return Center(
                      child: Semantics(
                        label: context.l10n.activityImageViewLoading,
                        child: const CircularProgressIndicator(),
                      ),
                    );
                  }
                  return _buildImage(bytes);
                },
              );
            },
          ),
          if (title != null)
            Positioned(
              top: 8,
              left: 16,
              right: 64,
              child: Text(
                title,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(color: eco.textMuted),
              ),
            ),
          Positioned(
            top: 0,
            right: 4,
            child: IconButton(
              tooltip: context.l10n.commonClose,
              icon: const Icon(EcoIcons.close),
              color: eco.textHeading,
              onPressed: () => Navigator.of(context).pop(),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildImage(Uint8List bytes) {
    final eco = ecoColors(context);
    return InteractiveViewer(
      minScale: 0.5,
      maxScale: 6,
      boundaryMargin: const EdgeInsets.all(48),
      child: Center(
        child: ColoredBox(
          color: eco.cardSurface,
          child: Image.memory(
            bytes,
            fit: BoxFit.contain,
            filterQuality: FilterQuality.high,
            gaplessPlayback: true,
            errorBuilder: (_, _, _) => Icon(
              Icons.broken_image_outlined,
              size: 48,
              color: eco.textMuted,
            ),
          ),
        ),
      ),
    );
  }
}
