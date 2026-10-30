import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../locale/app_localizations_ext.dart';
import '../platform/image_clipboard.dart';
import '../platform/photo_library_saver.dart';
import '../theme/eco_icons.dart';

/// Edge-to-edge image stage shared by generated images, attachments and todos.
/// Lazy pages save/copy their resolved original, never a placeholder/thumbnail.
Future<void> showImageMemoryLightbox(
  BuildContext context, {
  required List<Uint8List> images,
  int initialIndex = 0,
  String? title,
  List<String?>? titles,
  Future<Uint8List> Function(int index)? loadImage,
}) async {
  if (images.isEmpty) return;
  await showDialog<void>(
    context: context,
    useSafeArea: false,
    barrierColor: Colors.black,
    builder: (_) => Dialog.fullscreen(
      backgroundColor: const Color(0xFF101012),
      child: _ImageMemoryLightboxBody(
        images: List.of(images),
        initialIndex: initialIndex.clamp(0, images.length - 1),
        title: title,
        titles: titles == null ? null : List.of(titles),
        loadImage: loadImage,
      ),
    ),
  );
}

Future<void> showImageMemoryLightboxSingle(
  BuildContext context, {
  required Uint8List bytes,
  String? title,
}) => showImageMemoryLightbox(context, images: [bytes], title: title);

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
  late final _pages = PageController(initialPage: widget.initialIndex);
  late int _index = widget.initialIndex;
  final _loads = <int, Future<Uint8List>>{};
  final _originals = <int, Uint8List>{};
  final _saved = <int>{};
  final _zoomed = <int>{};
  bool _saving = false;
  bool _copying = false;
  int? _copiedIndex;
  String? _copyError;
  String? _saveError;

  @override
  void initState() {
    super.initState();
    if (widget.loadImage == null) {
      for (var i = 0; i < widget.images.length; i++) {
        if (widget.images[i].isNotEmpty) _originals[i] = widget.images[i];
      }
    }
  }

  @override
  void dispose() {
    _pages.dispose();
    super.dispose();
  }

  String get _title {
    final titles = widget.titles;
    final pageTitle = titles != null && _index < titles.length
        ? titles[_index]?.trim()
        : null;
    if (pageTitle?.isNotEmpty == true) return pageTitle!;
    if (widget.title?.trim().isNotEmpty == true) return widget.title!.trim();
    return context.l10n.imagePreviewTitle;
  }

  Future<Uint8List> _load(int index) => _loads.putIfAbsent(index, () async {
    final bytes = await widget.loadImage!(index);
    if (bytes.isEmpty) throw const FormatException('Original image is empty.');
    if (mounted) setState(() => _originals[index] = bytes);
    return bytes;
  });

  Future<void> _save() async {
    final bytes = _originals[_index];
    if (_saving || _copying || _saved.contains(_index) || bytes == null) return;
    final index = _index;
    setState(() {
      _saving = true;
      _saveError = null;
      _copyError = null;
    });
    try {
      await const PhotoLibrarySaver().save(bytes);
      if (mounted) setState(() => _saved.add(index));
    } catch (error) {
      if (mounted) setState(() => _saveError = _saveErrorMessage(error));
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  Future<void> _copy() async {
    final bytes = _originals[_index];
    if (_copying || _saving || bytes == null) return;
    final index = _index;
    setState(() {
      _copying = true;
      _copiedIndex = null;
      _copyError = null;
      _saveError = null;
    });
    try {
      await const ImageClipboard().copy(bytes);
      if (mounted) setState(() => _copiedIndex = index);
    } catch (error) {
      if (mounted) {
        setState(
          () => _copyError = switch (error) {
            ImageClipboardException(
              failure: ImageClipboardFailure.unsupportedImage,
            ) =>
              context.l10n.imageCopyUnsupported,
            ImageClipboardException(
              failure: ImageClipboardFailure.unavailable,
            ) =>
              context.l10n.imageCopyUnavailable,
            _ => context.l10n.imageCopyFailed,
          },
        );
      }
    } finally {
      if (mounted) setState(() => _copying = false);
    }
  }

  String _saveErrorMessage(Object error) {
    final l10n = context.l10n;
    return switch (error) {
      PhotoLibrarySaveException(
        failure: PhotoLibrarySaveFailure.accessDenied,
      ) =>
        l10n.imageSavePermissionDenied,
      PhotoLibrarySaveException(
        failure: PhotoLibrarySaveFailure.notEnoughSpace,
      ) =>
        l10n.imageSaveNotEnoughSpace,
      PhotoLibrarySaveException(
        failure: PhotoLibrarySaveFailure.unsupportedFormat,
      ) =>
        l10n.imageSaveUnsupported,
      PhotoLibrarySaveException(failure: PhotoLibrarySaveFailure.unavailable) =>
        l10n.imageSaveUnavailable,
      _ => l10n.imageSaveFailed,
    };
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final saved = _saved.contains(_index);
    final copied = _copiedIndex == _index;
    final actionError = _copyError ?? _saveError;
    return AnnotatedRegion<SystemUiOverlayStyle>(
      value: SystemUiOverlayStyle.light.copyWith(
        systemNavigationBarColor: const Color(0xFF101012),
      ),
      child: SafeArea(
        child: Column(
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 8, 12, 8),
              child: Row(
                children: [
                  Expanded(
                    child: Text(
                      _title,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(
                        color: Colors.white,
                        fontSize: 15,
                        fontWeight: FontWeight.w500,
                      ),
                    ),
                  ),
                  const SizedBox(width: 12),
                  IconButton.filledTonal(
                    tooltip: l10n.commonClose,
                    style: IconButton.styleFrom(
                      backgroundColor: Colors.white.withValues(alpha: .09),
                      foregroundColor: Colors.white,
                    ),
                    onPressed: () => Navigator.of(context).pop(),
                    icon: const Icon(EcoIcons.close, size: 20),
                  ),
                ],
              ),
            ),
            Expanded(
              child: PageView.builder(
                controller: _pages,
                physics: _saving || _copying || _zoomed.contains(_index)
                    ? const NeverScrollableScrollPhysics()
                    : null,
                itemCount: widget.images.length,
                onPageChanged: (index) => setState(() {
                  _index = index;
                  _saveError = null;
                  _copyError = null;
                  _copiedIndex = null;
                }),
                itemBuilder: (context, index) {
                  Widget preview(Uint8List bytes) => _ZoomableImage(
                    key: ValueKey(index),
                    bytes: bytes,
                    active: index == _index,
                    onZoomChanged: (zoomed) {
                      if (!mounted || _zoomed.contains(index) == zoomed) return;
                      setState(() {
                        if (zoomed) {
                          _zoomed.add(index);
                        } else {
                          _zoomed.remove(index);
                        }
                      });
                    },
                  );
                  if (widget.loadImage == null) {
                    return preview(widget.images[index]);
                  }
                  return FutureBuilder<Uint8List>(
                    future: _load(index),
                    builder: (context, snapshot) {
                      if (snapshot.hasError) {
                        return _PreviewNotice(
                          message: l10n.activityImageViewErrorReadFailed,
                          onRetry: () => setState(() {
                            _loads.remove(index);
                            _originals.remove(index);
                          }),
                        );
                      }
                      if (!snapshot.hasData) {
                        return Center(
                          child: Semantics(
                            label: l10n.activityImageViewLoading,
                            child: const SizedBox.square(
                              dimension: 24,
                              child: CircularProgressIndicator(
                                strokeWidth: 2,
                                color: Colors.white70,
                              ),
                            ),
                          ),
                        );
                      }
                      return preview(snapshot.data!);
                    },
                  );
                },
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(24, 18, 24, 18),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  if (widget.images.length > 1) ...[
                    Text(
                      '${_index + 1} / ${widget.images.length}',
                      style: const TextStyle(
                        color: Colors.white60,
                        fontSize: 12,
                        fontFeatures: [FontFeature.tabularFigures()],
                      ),
                    ),
                    const SizedBox(height: 14),
                  ],
                  if (actionError != null)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 12),
                      child: Semantics(
                        liveRegion: true,
                        child: Text(
                          actionError,
                          textAlign: TextAlign.center,
                          style: const TextStyle(
                            color: Color(0xFFFFB4AB),
                            fontSize: 13,
                            height: 1.4,
                          ),
                        ),
                      ),
                    ),
                  Wrap(
                    alignment: WrapAlignment.center,
                    spacing: 10,
                    runSpacing: 10,
                    children: [
                      Semantics(
                        liveRegion: copied,
                        child: OutlinedButton.icon(
                          key: const ValueKey('image-copy-to-clipboard'),
                          onPressed:
                              _copying ||
                                  _saving ||
                                  !_originals.containsKey(_index)
                              ? null
                              : _copy,
                          style: OutlinedButton.styleFrom(
                            foregroundColor: Colors.white,
                            disabledForegroundColor: Colors.white38,
                            backgroundColor: Colors.white.withValues(
                              alpha: .09,
                            ),
                            disabledBackgroundColor: Colors.white.withValues(
                              alpha: .04,
                            ),
                            side: BorderSide(
                              color: Colors.white.withValues(alpha: .24),
                            ),
                            minimumSize: const Size(0, 48),
                            padding: const EdgeInsets.symmetric(
                              horizontal: 22,
                              vertical: 12,
                            ),
                            shape: const StadiumBorder(),
                          ),
                          icon: _copying
                              ? const SizedBox.square(
                                  dimension: 17,
                                  child: CircularProgressIndicator(
                                    strokeWidth: 2,
                                    color: Colors.white70,
                                  ),
                                )
                              : Icon(
                                  copied ? EcoIcons.check : EcoIcons.copy,
                                  size: 18,
                                ),
                          label: Text(
                            _copying
                                ? l10n.imageCopying
                                : copied
                                ? l10n.imageCopied
                                : l10n.imageCopy,
                            textAlign: TextAlign.center,
                            style: const TextStyle(
                              fontSize: 14,
                              fontWeight: FontWeight.w600,
                            ),
                          ),
                        ),
                      ),
                      Semantics(
                        liveRegion: saved,
                        child: FilledButton.icon(
                          key: const ValueKey('image-save-to-photos'),
                          onPressed:
                              _saving ||
                                  _copying ||
                                  saved ||
                                  !_originals.containsKey(_index)
                              ? null
                              : _save,
                          style: FilledButton.styleFrom(
                            backgroundColor: Colors.white,
                            foregroundColor: const Color(0xFF151517),
                            disabledBackgroundColor: Colors.white.withValues(
                              alpha: .10,
                            ),
                            disabledForegroundColor: Colors.white60,
                            minimumSize: const Size(0, 48),
                            padding: const EdgeInsets.symmetric(
                              horizontal: 22,
                              vertical: 12,
                            ),
                            shape: const StadiumBorder(),
                          ),
                          icon: _saving
                              ? const SizedBox.square(
                                  dimension: 17,
                                  child: CircularProgressIndicator(
                                    strokeWidth: 2,
                                    color: Colors.white70,
                                  ),
                                )
                              : Icon(
                                  saved
                                      ? EcoIcons.check
                                      : Icons.save_alt_rounded,
                                  size: 18,
                                ),
                          label: Text(
                            _saving
                                ? l10n.imageSaving
                                : saved
                                ? l10n.imageSavedToPhotos
                                : l10n.imageSaveToPhotos,
                            textAlign: TextAlign.center,
                            style: const TextStyle(
                              fontSize: 14,
                              fontWeight: FontWeight.w600,
                            ),
                          ),
                        ),
                      ),
                    ],
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _PreviewNotice extends StatelessWidget {
  const _PreviewNotice({required this.message, this.onRetry});
  final String message;
  final VoidCallback? onRetry;
  @override
  Widget build(BuildContext context) => Center(
    child: Padding(
      padding: const EdgeInsets.all(24),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          const Icon(
            Icons.image_not_supported_outlined,
            size: 32,
            color: Colors.white38,
          ),
          const SizedBox(height: 12),
          Text(
            message,
            textAlign: TextAlign.center,
            style: const TextStyle(color: Colors.white70, fontSize: 14),
          ),
          if (onRetry != null)
            TextButton(
              onPressed: onRetry,
              style: TextButton.styleFrom(foregroundColor: Colors.white),
              child: Text(context.l10n.commonRetry),
            ),
        ],
      ),
    ),
  );
}

class _ZoomableImage extends StatefulWidget {
  const _ZoomableImage({
    super.key,
    required this.bytes,
    required this.active,
    required this.onZoomChanged,
  });
  final Uint8List bytes;
  final bool active;
  final ValueChanged<bool> onZoomChanged;
  @override
  State<_ZoomableImage> createState() => _ZoomableImageState();
}

class _ZoomableImageState extends State<_ZoomableImage> {
  final _transform = TransformationController();
  Offset _doubleTapPosition = Offset.zero;
  @override
  void initState() {
    super.initState();
    _transform.addListener(_changed);
  }

  void _changed() =>
      widget.onZoomChanged(_transform.value.getMaxScaleOnAxis() > 1.01);
  @override
  void didUpdateWidget(covariant _ZoomableImage oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!widget.active && oldWidget.active) {
      // Page changes are already building the parent; notify after this frame.
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) _transform.value = Matrix4.identity();
      });
    }
  }

  @override
  void dispose() {
    _transform.removeListener(_changed);
    _transform.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => GestureDetector(
    onDoubleTapDown: (details) => _doubleTapPosition = details.localPosition,
    onDoubleTap: () {
      const scale = 2.5;
      _transform.value = _transform.value.getMaxScaleOnAxis() > 1.01
          ? Matrix4.identity()
          : (Matrix4.diagonal3Values(scale, scale, 1)..setTranslationRaw(
              -_doubleTapPosition.dx * (scale - 1),
              -_doubleTapPosition.dy * (scale - 1),
              0,
            ));
    },
    child: InteractiveViewer(
      transformationController: _transform,
      minScale: 1,
      maxScale: 6,
      child: Center(
        child: Image.memory(
          widget.bytes,
          fit: BoxFit.contain,
          filterQuality: FilterQuality.high,
          gaplessPlayback: true,
          errorBuilder: (_, _, _) => _PreviewNotice(
            message: context.l10n.activityImageViewErrorReadFailed,
          ),
        ),
      ),
    ),
  );
}
