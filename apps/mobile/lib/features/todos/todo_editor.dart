import 'dart:convert';
import 'dart:math' as math;
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:image_picker/image_picker.dart';
import 'package:uuid/uuid.dart';

import '../../core/locale/app_localizations_ext.dart';
import '../../core/models/project_todo_models.dart';
import '../../core/network/desktop_rpc.dart';
import '../../core/theme/eco_theme.dart';
import '../../core/utils/prompt_image_attachment.dart';
import '../../core/widgets/eco_modal_sheet.dart';
import '../threads/thread_providers.dart';
import 'todo_providers.dart';
import 'todo_widgets.dart';

Future<bool?> showTodoEditor(
  BuildContext context, {
  required Map<String, String> projects,
  String? projectPath,
  ProjectTodo? todo,
}) => showEcoModalBottomSheet<bool>(
  context: context,
  isScrollControlled: true,
  useSafeArea: true,
  isDismissible: false,
  enableDrag: false,
  builder: (_) =>
      TodoEditor(projects: projects, projectPath: projectPath, todo: todo),
);

class TodoEditor extends ConsumerStatefulWidget {
  const TodoEditor({
    super.key,
    required this.projects,
    this.projectPath,
    this.todo,
  });
  final Map<String, String> projects;
  final String? projectPath;
  final ProjectTodo? todo;
  @override
  ConsumerState<TodoEditor> createState() => _TodoEditorState();
}

class _TodoEditorState extends ConsumerState<TodoEditor> {
  late final _text = TextEditingController(text: widget.todo?.text ?? '');
  late String? _project = widget.todo?.projectPath ?? widget.projectPath;
  late final _images = List<ProjectTodoImage>.of(widget.todo?.images ?? []);
  final _uploadedRefs = <String, String>{};
  DesktopRpc? _rpc;
  bool _dirty = false;
  bool _busy = false;
  String? _error;
  double? _progress;

  @override
  void initState() {
    super.initState();
    _rpc = ref.read(desktopRpcProvider);
  }

  @override
  void dispose() {
    _text.dispose();
    super.dispose();
  }

  Future<void> _close() async {
    if (_busy) return;
    if (_dirty) {
      final discard = await showDialog<bool>(
        context: context,
        builder: (context) => AlertDialog(
          title: Text(context.l10n.todosDiscardTitle),
          content: Text(context.l10n.todosDiscardHint),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context, false),
              child: Text(context.l10n.commonCancel),
            ),
            FilledButton(
              onPressed: () => Navigator.pop(context, true),
              child: Text(context.l10n.todosDiscard),
            ),
          ],
        ),
      );
      if (discard != true) return;
    }
    if (mounted) Navigator.pop(context, false);
  }

  Future<void> _pickImage() async {
    final l = context.l10n;
    if (_busy) return;
    if (_images.length >= todoMaxImages) {
      setState(() => _error = l.todosImageLimit);
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final file = await ImagePicker().pickImage(source: ImageSource.gallery);
      if (file == null || !mounted) return;
      if (await file.length() > todoMaxImageBytes) {
        if (mounted) setState(() => _error = l.todosImageTooLarge);
        return;
      }
      final mediaType = promptImageMediaTypeFromPath(file.path);
      if (mediaType == null) {
        if (mounted) setState(() => _error = l.todosImageInvalid);
        return;
      }
      final bytes = await file.readAsBytes();
      final buffer = await ui.ImmutableBuffer.fromUint8List(bytes);
      late ui.Codec codec;
      try {
        final descriptor = await ui.ImageDescriptor.encoded(buffer);
        try {
          final scale = math.min(
            1.0,
            224 / math.max(descriptor.width, descriptor.height),
          );
          codec = await descriptor.instantiateCodec(
            targetWidth: math.max(1, (descriptor.width * scale).round()),
            targetHeight: math.max(1, (descriptor.height * scale).round()),
          );
        } finally {
          descriptor.dispose();
        }
      } finally {
        buffer.dispose();
      }
      String thumbnail;
      try {
        final frame = await codec.getNextFrame();
        try {
          final png = await frame.image.toByteData(
            format: ui.ImageByteFormat.png,
          );
          if (png == null || png.lengthInBytes > 220000) {
            throw const FormatException('Invalid image preview');
          }
          thumbnail =
              'data:image/png;base64,${base64Encode(png.buffer.asUint8List(png.offsetInBytes, png.lengthInBytes))}';
        } finally {
          frame.image.dispose();
        }
      } finally {
        codec.dispose();
      }
      if (!mounted) return;
      setState(() {
        _images.add(
          ProjectTodoImage(
            id: const Uuid().v4(),
            mediaType: mediaType,
            data: base64Encode(bytes),
            thumbnail: thumbnail,
          ),
        );
        _dirty = true;
      });
    } catch (error) {
      if (mounted) {
        setState(
          () => _error = error is PlatformException
              ? todoErrorMessage(error, l)
              : l.todosImageInvalid,
        );
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _preview(ProjectTodoImage image) async {
    if (_busy) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final data =
          image.data ??
          await _rpc!.downloadProjectTodoImage(widget.todo!, image);
      if (mounted) await showTodoImage(context, data);
    } catch (error) {
      if (mounted) {
        setState(() => _error = todoErrorMessage(error, context.l10n));
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _save() async {
    if (_busy ||
        _project == null ||
        _project!.isEmpty ||
        (_text.text.trim().isEmpty && _images.isEmpty)) {
      return;
    }
    if (_text.text.length > 100000) {
      setState(() => _error = context.l10n.todosTextLimit);
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
      _progress = null;
    });
    try {
      final rpc = _rpc;
      if (rpc == null) throw StateError('Desktop is not connected');
      final wireImages = <Map<String, dynamic>>[];
      for (final image in _images) {
        String? contentRef = _uploadedRefs[image.id];
        if (image.data != null && contentRef == null) {
          final uploaded = await rpc.uploadPromptImageChunkedWithMetadata(
            contextKey: composerDraftContextKey(workspacePath: _project),
            imageId: image.id,
            mediaType: image.mediaType,
            bytes: base64Decode(image.data!),
            onProgress: (sent, total) {
              if (mounted) setState(() => _progress = sent / total);
            },
          );
          contentRef = uploaded.contentRef;
          _uploadedRefs[image.id] = contentRef;
        }
        wireImages.add({
          'id': image.id,
          'mediaType': image.mediaType,
          'thumbnail': image.thumbnail,
          'contentRef': ?contentRef,
        });
      }
      await rpc.saveProjectTodo({
        if (widget.todo != null) 'id': widget.todo!.id,
        if (widget.todo != null) 'revision': widget.todo!.revision,
        'projectPath': _project,
        'text': _text.text,
        'images': wireImages,
        'completed': widget.todo?.completed ?? false,
      });
      ref.invalidate(projectTodosProvider);
      if (mounted) Navigator.pop(context, true);
    } catch (error) {
      if (mounted) {
        setState(() => _error = todoErrorMessage(error, context.l10n));
      }
      ref.invalidate(projectTodosProvider);
    } finally {
      if (mounted) {
        setState(() {
          _busy = false;
          _progress = null;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final l = context.l10n;
    final eco = ecoColors(context);
    final canSave =
        !_busy &&
        _project != null &&
        _project!.isNotEmpty &&
        (_text.text.trim().isNotEmpty || _images.isNotEmpty);
    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop) _close();
      },
      child: Padding(
        padding: EdgeInsets.only(
          bottom: MediaQuery.viewInsetsOf(context).bottom,
        ),
        child: SafeArea(
          top: false,
          child: SizedBox(
            height:
                MediaQuery.sizeOf(context).height * .82 -
                MediaQuery.viewInsetsOf(context).bottom * .5,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Padding(
                  padding: const EdgeInsets.fromLTRB(12, 12, 20, 8),
                  child: Row(
                    children: [
                      IconButton(
                        onPressed: _busy ? null : _close,
                        tooltip: l.commonClose,
                        icon: const Icon(Icons.close),
                      ),
                      const SizedBox(width: 4),
                      Expanded(
                        child: Text(
                          widget.todo == null ? l.todosAdd : l.todosEdit,
                          style: Theme.of(context).textTheme.titleLarge,
                        ),
                      ),
                      FilledButton(
                        onPressed: canSave ? _save : null,
                        child: _busy
                            ? const SizedBox(
                                width: 20,
                                height: 20,
                                child: CircularProgressIndicator(
                                  strokeWidth: 2,
                                ),
                              )
                            : Text(l.commonSave),
                      ),
                    ],
                  ),
                ),
                if (_progress != null)
                  LinearProgressIndicator(value: _progress),
                Expanded(
                  child: SingleChildScrollView(
                    padding: const EdgeInsets.fromLTRB(24, 8, 24, 24),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        OutlinedButton.icon(
                          onPressed: _busy
                              ? null
                              : () async {
                                  final path = await pickTodoProject(
                                    context,
                                    widget.projects,
                                  );
                                  if (path != null && mounted) {
                                    setState(() {
                                      _project = path;
                                      _dirty = true;
                                    });
                                  }
                                },
                          icon: const Icon(Icons.folder_outlined, size: 20),
                          label: Row(
                            children: [
                              Expanded(
                                child: Text(
                                  _project == null
                                      ? l.todosProject
                                      : todoProjectName(
                                          widget.projects,
                                          _project!,
                                        ),
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                ),
                              ),
                              const Icon(Icons.expand_more),
                            ],
                          ),
                        ),
                        const SizedBox(height: 12),
                        TextField(
                          controller: _text,
                          readOnly: _busy,
                          minLines: 5,
                          maxLines: null,
                          textCapitalization: TextCapitalization.sentences,
                          decoration: InputDecoration(
                            hintText: l.todosInputHint,
                            border: InputBorder.none,
                          ),
                          style: Theme.of(
                            context,
                          ).textTheme.bodyLarge?.copyWith(height: 1.6),
                          onChanged: (_) => setState(() => _dirty = true),
                        ),
                        if (_images.isNotEmpty) ...[
                          const SizedBox(height: 12),
                          Wrap(
                            spacing: 12,
                            runSpacing: 12,
                            children: [
                              for (final image in _images)
                                SizedBox(
                                  width: 92,
                                  height: 112,
                                  child: Column(
                                    children: [
                                      TodoThumbnail(
                                        source: image.thumbnail,
                                        size: 72,
                                        onTap: _busy
                                            ? null
                                            : () => _preview(image),
                                      ),
                                      SizedBox(
                                        height: 40,
                                        child: IconButton(
                                          padding: EdgeInsets.zero,
                                          constraints: const BoxConstraints(
                                            minWidth: 44,
                                            minHeight: 40,
                                          ),
                                          tooltip: l.todosRemoveImage,
                                          icon: const Icon(
                                            Icons.close,
                                            size: 18,
                                          ),
                                          onPressed: _busy
                                              ? null
                                              : () => setState(() {
                                                  _images.remove(image);
                                                  _dirty = true;
                                                }),
                                        ),
                                      ),
                                    ],
                                  ),
                                ),
                            ],
                          ),
                        ],
                        const SizedBox(height: 16),
                        Align(
                          alignment: Alignment.centerLeft,
                          child: TextButton.icon(
                            onPressed: _busy || _images.length >= todoMaxImages
                                ? null
                                : _pickImage,
                            icon: const Icon(
                              Icons.add_photo_alternate_outlined,
                            ),
                            label: Text(l.todosAddImage),
                          ),
                        ),
                        Text(
                          l.todosImagesHint,
                          style: Theme.of(
                            context,
                          ).textTheme.bodySmall?.copyWith(color: eco.textMuted),
                        ),
                        if (_error != null) ...[
                          const SizedBox(height: 16),
                          Semantics(
                            liveRegion: true,
                            child: Text(
                              _error!,
                              style: TextStyle(color: eco.danger),
                            ),
                          ),
                        ],
                      ],
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
