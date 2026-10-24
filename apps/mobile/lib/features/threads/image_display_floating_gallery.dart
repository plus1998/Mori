import 'dart:async';

import 'package:flutter/material.dart';

import '../../core/locale/app_localizations_ext.dart';
import '../../core/models/image_display_models.dart';
import '../../core/models/image_view_models.dart';
import '../../core/theme/eco_theme.dart';
import '../../core/widgets/image_memory_lightbox.dart';
import '../../l10n/generated/app_localizations.dart';
import '../composer/composer_stack_card.dart';

typedef ImageDisplayBytesLoader =
    Future<ImageViewReadData> Function(
      String artifactId, {
      void Function(int receivedBytes, int totalBytes)? onProgress,
    });

/// Desktop-like floating gallery for `display_image` artifacts.
///
/// Collapsed: bubble with count on the trailing edge.
/// Starts collapsed and loads image bytes only after an explicit reveal.
/// Expanded: frosted card with thumbnails; tap opens fullscreen lightbox.
/// Failed thumbs retry on tap; loading shows percent when available.
class ImageDisplayFloatingGallery extends StatefulWidget {
  const ImageDisplayFloatingGallery({
    super.key,
    required this.artifacts,
    required this.loadBytes,
    this.controller,
    this.bottomInset = 0,
  });

  final List<ImageDisplayArtifact> artifacts;
  final ImageDisplayBytesLoader loadBytes;
  final ImageDisplayFloatingGalleryController? controller;
  final double bottomInset;

  @override
  State<ImageDisplayFloatingGallery> createState() =>
      _ImageDisplayFloatingGalleryState();
}

class ImageDisplayFloatingGalleryController extends ChangeNotifier {
  String? _focusArtifactId;
  var _expandToken = 0;

  String? get focusArtifactId => _focusArtifactId;
  int get expandToken => _expandToken;

  void reveal({String? artifactId}) {
    _focusArtifactId = artifactId;
    _expandToken += 1;
    notifyListeners();
  }

  void clearFocus() {
    if (_focusArtifactId == null) return;
    _focusArtifactId = null;
    notifyListeners();
  }
}

class _ThumbLoadState {
  Future<ImageViewReadData>? future;
  ImageViewReadData? data;
  Object? error;
  double? progress;
  var generation = 0;
}

class _ImageDisplayFloatingGalleryState
    extends State<ImageDisplayFloatingGallery>
    with SingleTickerProviderStateMixin {
  var _expanded = false;
  var _pulse = false;
  String? _highlightId;
  int _lastSeenCount = 0;
  int _lastExpandToken = 0;
  late final AnimationController _pulseController;
  final Map<String, _ThumbLoadState> _loads = {};

  @override
  void initState() {
    super.initState();
    _lastSeenCount = widget.artifacts.length;
    _pulseController = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 700),
    );
    widget.controller?.addListener(_onController);
  }

  @override
  void didUpdateWidget(covariant ImageDisplayFloatingGallery oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.controller != widget.controller) {
      oldWidget.controller?.removeListener(_onController);
      widget.controller?.addListener(_onController);
    }
    final nextCount = widget.artifacts.length;
    if (nextCount > _lastSeenCount) {
      _lastSeenCount = nextCount;
      _triggerPulse();
      final newest = widget.artifacts.isEmpty ? null : widget.artifacts.last.id;
      _highlightId = newest;
    } else {
      _lastSeenCount = nextCount;
    }
    final liveIds = widget.artifacts.map((item) => item.id).toSet();
    _loads.removeWhere((id, _) => !liveIds.contains(id));
    if (_expanded) _loadArtifacts();
  }

  @override
  void dispose() {
    widget.controller?.removeListener(_onController);
    _pulseController.dispose();
    super.dispose();
  }

  void _onController() {
    final controller = widget.controller;
    if (controller == null) return;
    if (controller.expandToken != _lastExpandToken) {
      _lastExpandToken = controller.expandToken;
      setState(() {
        _expanded = true;
        _highlightId = controller.focusArtifactId;
      });
      _loadArtifacts();
      _triggerPulse();
    }
  }

  void _loadArtifacts() {
    for (final artifact in widget.artifacts) {
      _ensureLoad(artifact.id);
    }
  }

  void _expand() {
    setState(() => _expanded = true);
    _loadArtifacts();
  }

  void _triggerPulse() {
    setState(() => _pulse = true);
    unawaited(
      _pulseController.forward(from: 0).then((_) {
        if (!mounted) return;
        setState(() => _pulse = false);
      }),
    );
  }

  _ThumbLoadState _ensureLoad(String artifactId, {bool force = false}) {
    final existing = _loads[artifactId];
    if (!force && existing != null && existing.future != null) {
      return existing;
    }
    final state = existing ?? _ThumbLoadState();
    _loads[artifactId] = state;
    final generation = ++state.generation;
    state.error = null;
    state.data = null;
    // Show determinate 0% immediately; first RPC used to leave an indeterminate spinner.
    state.progress = 0;
    final future = widget.loadBytes(
      artifactId,
      onProgress: (received, total) {
        if (!mounted || state.generation != generation) return;
        final denominator = total > 0 ? total : 1;
        setState(() {
          state.progress = (received / denominator).clamp(0.0, 1.0);
        });
      },
    );
    state.future = future;
    unawaited(
      future.then(
        (data) {
          if (!mounted || state.generation != generation) return;
          setState(() {
            state.data = data;
            state.error = null;
            state.progress = 1;
          });
        },
        onError: (Object error, StackTrace _) {
          if (!mounted || state.generation != generation) return;
          setState(() {
            state.error = error;
            state.data = null;
            state.progress = null;
          });
        },
      ),
    );
    return state;
  }

  void _retry(String artifactId) {
    setState(() {
      _ensureLoad(artifactId, force: true);
    });
  }

  Future<void> _handleThumbTap(ImageDisplayArtifact artifact) async {
    final state = _ensureLoad(artifact.id);
    if (state.error != null) {
      _retry(artifact.id);
      return;
    }
    if (state.data != null) {
      await _openLightbox(artifact, state.data!);
      return;
    }
    try {
      final image = await state.future!;
      if (!mounted) return;
      await _openLightbox(artifact, image);
    } catch (_) {
      if (!mounted) return;
      // Error UI already shows in the thumb; tap again retries.
    }
  }

  Future<void> _openLightbox(
    ImageDisplayArtifact artifact,
    ImageViewReadData image,
  ) async {
    await showImageMemoryLightboxSingle(
      context,
      bytes: image.bytes,
      title: artifact.displayTitle,
    );
  }

  @override
  Widget build(BuildContext context) {
    if (widget.artifacts.isEmpty) return const SizedBox.shrink();

    final eco = ecoColors(context);
    final media = MediaQuery.of(context);
    final top = media.padding.top + kToolbarHeight + 12;
    final bottom = widget.bottomInset + 12;

    return Positioned(
      top: top,
      right: 12,
      bottom: bottom,
      width: _expanded ? 168 : null,
      child: Align(
        alignment: Alignment.topRight,
        child: AnimatedScale(
          scale: _pulse ? 1.06 : 1,
          duration: const Duration(milliseconds: 220),
          curve: Curves.easeOutBack,
          child: _expanded ? _buildExpanded(eco) : _buildCollapsed(eco),
        ),
      ),
    );
  }

  Widget _buildCollapsed(EcoColors eco) {
    final count = widget.artifacts.length;
    return Material(
      color: Colors.transparent,
      child: ComposerStackCard(
        frosted: true,
        stadium: true,
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 10),
        onTap: _expand,
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.photo_library_outlined, size: 18, color: eco.accent),
            const SizedBox(width: 6),
            Text(
              '$count',
              style: TextStyle(
                color: eco.composerPillText,
                fontWeight: FontWeight.w700,
                fontSize: 13,
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildExpanded(EcoColors eco) {
    final l10n = context.l10n;
    return ComposerStackCard(
      frosted: true,
      padding: EdgeInsets.zero,
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxHeight: 360),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(10, 8, 4, 6),
              child: Row(
                children: [
                  Expanded(
                    child: Text(
                      l10n.taskImageDisplayHistory,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        color: eco.textHeading,
                        fontWeight: FontWeight.w600,
                        fontSize: 12.5,
                      ),
                    ),
                  ),
                  IconButton(
                    visualDensity: VisualDensity.compact,
                    tooltip: l10n.commonCollapse,
                    onPressed: () => setState(() => _expanded = false),
                    icon: Icon(Icons.remove, size: 16, color: eco.textMuted),
                  ),
                ],
              ),
            ),
            Flexible(
              child: ListView.separated(
                shrinkWrap: true,
                padding: const EdgeInsets.fromLTRB(8, 0, 8, 8),
                itemCount: widget.artifacts.length,
                separatorBuilder: (_, _) => const SizedBox(height: 8),
                itemBuilder: (context, index) {
                  // Keep new screenshots visible within the bounded gallery.
                  final artifact =
                      widget.artifacts[widget.artifacts.length - 1 - index];
                  final load = _loads[artifact.id] ?? _ThumbLoadState();
                  return _ArtifactThumbRow(
                    artifact: artifact,
                    highlighted: artifact.id == _highlightId,
                    data: load.data,
                    error: load.error,
                    progress: load.progress,
                    onTap: () => unawaited(_handleThumbTap(artifact)),
                  );
                },
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _ArtifactThumbRow extends StatelessWidget {
  const _ArtifactThumbRow({
    required this.artifact,
    required this.onTap,
    required this.highlighted,
    this.data,
    this.error,
    this.progress,
  });

  final ImageDisplayArtifact artifact;
  final VoidCallback onTap;
  final bool highlighted;
  final ImageViewReadData? data;
  final Object? error;
  final double? progress;

  @override
  Widget build(BuildContext context) {
    final eco = ecoColors(context);
    final l10n = context.l10n;
    return Material(
      color: highlighted ? eco.accentSoft : eco.cardSurface,
      borderRadius: BorderRadius.circular(10),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(10),
        child: Padding(
          padding: const EdgeInsets.all(6),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              ClipRRect(
                borderRadius: BorderRadius.circular(8),
                child: AspectRatio(
                  aspectRatio: 1,
                  child: ColoredBox(
                    color: eco.bgElevated,
                    child: _buildPreview(eco, l10n),
                  ),
                ),
              ),
              const SizedBox(height: 6),
              Text(
                artifact.displayTitle,
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                  color: eco.textPrimary,
                  fontSize: 11,
                  height: 1.25,
                  fontWeight: FontWeight.w500,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildPreview(EcoColors eco, AppLocalizations l10n) {
    if (data != null) {
      return Image.memory(
        data!.bytes,
        fit: BoxFit.contain,
        filterQuality: FilterQuality.medium,
      );
    }
    if (error != null) {
      return Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Icon(Icons.refresh, color: eco.textMuted, size: 22),
          const SizedBox(height: 4),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 4),
            child: Text(
              l10n.activityImageDisplayTapToRetry,
              textAlign: TextAlign.center,
              style: TextStyle(color: eco.textMuted, fontSize: 10, height: 1.2),
            ),
          ),
        ],
      );
    }
    final percent = ((progress ?? 0) * 100).clamp(0, 100).round();
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          SizedBox(
            width: 22,
            height: 22,
            child: CircularProgressIndicator(
              strokeWidth: 2,
              value: progress ?? 0,
            ),
          ),
          const SizedBox(height: 6),
          Text(
            l10n.activityImageDisplayLoadingPercent(percent),
            style: TextStyle(color: eco.textMuted, fontSize: 10),
          ),
        ],
      ),
    );
  }
}
