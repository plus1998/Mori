// ignore_for_file: curly_braces_in_flow_control_structures

import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

import '../../core/locale/app_error_localizations.dart';
import '../../core/locale/app_localizations_ext.dart';
import '../../core/models/app_error.dart';
import '../../core/models/file_preview_models.dart';
import '../../core/models/image_view_models.dart';
import '../../core/network/desktop_rpc.dart';
import '../../core/theme/eco_theme.dart';
import '../../core/widgets/eco_markdown.dart';
import '../../core/widgets/markdown_link.dart';
import '../threads/media_artifact_player.dart';
import 'file_web_preview.dart';

typedef FilePreviewReader =
    Future<RemoteFileData> Function(
      LocalFileLink link, {
      String? relativeTo,
      bool Function()? isCancelled,
      void Function(int received, int total)? onProgress,
    });

typedef DirectoryPreviewReader =
    Future<RemoteDirectoryData> Function(
      LocalFileLink link, {
      String? relativeTo,
    });

class ConversationFileLinks extends StatelessWidget {
  const ConversationFileLinks({
    super.key,
    required this.threadId,
    required this.rpc,
    required this.child,
  });
  final String threadId;
  final DesktopRpc? rpc;
  final Widget child;

  @override
  Widget build(BuildContext context) => FileLinkScope(
    onOpenFile: (link) {
      openFilePreview(
        context,
        link: link,
        listDirectory: (target, {relativeTo}) {
          final remote = rpc;
          if (remote == null) {
            throw const AppErrorCodeException(
              AppErrorCode.threadProjectionNoPcSelected,
            );
          }
          return remote.listThreadDirectory(
            threadId: threadId,
            directoryPath: target.path,
            relativeTo: relativeTo,
          );
        },
        readFile: (target, {relativeTo, isCancelled, onProgress}) {
          final remote = rpc;
          if (remote == null) {
            throw const AppErrorCodeException(
              AppErrorCode.threadProjectionNoPcSelected,
            );
          }
          return remote.readThreadFile(
            threadId: threadId,
            filePath: target.path,
            relativeTo: relativeTo,
            isCancelled: isCancelled,
            onProgress: onProgress,
          );
        },
      );
    },
    child: child,
  );
}

void openFilePreview(
  BuildContext context, {
  required LocalFileLink link,
  required FilePreviewReader readFile,
  DirectoryPreviewReader? listDirectory,
  String? relativeTo,
}) {
  Navigator.of(context).push<void>(
    MaterialPageRoute(
      builder: (_) => FilePreviewPage(
        link: link,
        readFile: readFile,
        listDirectory: listDirectory,
        relativeTo: relativeTo,
      ),
    ),
  );
}

class FilePreviewPage extends StatefulWidget {
  const FilePreviewPage({
    super.key,
    required this.link,
    required this.readFile,
    this.listDirectory,
    this.relativeTo,
  });
  final LocalFileLink link;
  final FilePreviewReader readFile;
  final DirectoryPreviewReader? listDirectory;
  final String? relativeTo;

  @override
  State<FilePreviewPage> createState() => _FilePreviewPageState();
}

class _FilePreviewPageState extends State<FilePreviewPage> {
  RemoteFileData? _file;
  RemoteDirectoryData? _directory;
  Object? _error;
  int _generation = 0;
  double? _progress;
  bool _source = false;

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  Future<void> _load() async {
    final generation = ++_generation;
    setState(() {
      _file = null;
      _directory = null;
      _error = null;
      _progress = null;
    });
    try {
      try {
        final file = await widget.readFile(
          widget.link,
          relativeTo: widget.relativeTo,
          isCancelled: () => !mounted || generation != _generation,
          onProgress: (received, total) {
            if (mounted && generation == _generation) {
              setState(() => _progress = total == 0 ? 1 : received / total);
            }
          },
        );
        if (mounted && generation == _generation) setState(() => _file = file);
        return;
      } catch (fileError) {
        final listDirectory = widget.listDirectory;
        if (listDirectory == null) rethrow;
        try {
          final directory = await listDirectory(
            widget.link,
            relativeTo: widget.relativeTo,
          );
          if (mounted && generation == _generation) {
            setState(() => _directory = directory);
          }
          return;
        } catch (_) {
          Error.throwWithStackTrace(fileError, StackTrace.current);
        }
      }
    } catch (error) {
      if (mounted && generation == _generation) setState(() => _error = error);
    }
  }

  void _openNested(LocalFileLink link) => openFilePreview(
    context,
    link: link,
    readFile: widget.readFile,
    listDirectory: widget.listDirectory,
    relativeTo: _directory?.path ?? _file?.path,
  );

  Widget _directoryBody(RemoteDirectoryData directory) {
    final eco = ecoColors(context);
    if (directory.entries.isEmpty) {
      return Center(child: Text(context.l10n.filePreviewDirectoryEmpty));
    }
    return ListView.separated(
      padding: const EdgeInsets.symmetric(vertical: 8),
      itemCount: directory.entries.length,
      separatorBuilder: (_, _) => const Divider(height: 1, indent: 56),
      itemBuilder: (context, index) {
        final entry = directory.entries[index];
        return ListTile(
          leading: Icon(
            entry.isDirectory
                ? Icons.folder_outlined
                : Icons.insert_drive_file_outlined,
            color: entry.isDirectory ? eco.accent : eco.textMuted,
          ),
          title: Text(entry.name, maxLines: 1, overflow: TextOverflow.ellipsis),
          subtitle: entry.size == null
              ? null
              : Text(_formatFileSize(entry.size!)),
          trailing: entry.isDirectory ? const Icon(Icons.chevron_right) : null,
          onTap: () => _openNested(LocalFileLink(path: entry.path)),
        );
      },
    );
  }

  String _formatFileSize(int bytes) {
    if (bytes < 1024) return '$bytes B';
    if (bytes < 1024 * 1024) return '${(bytes / 1024).toStringAsFixed(1)} KB';
    return '${(bytes / (1024 * 1024)).toStringAsFixed(1)} MB';
  }

  Widget _unsupported({String? detail}) => Center(
    child: Padding(
      padding: const EdgeInsets.all(24),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          const Icon(Icons.insert_drive_file_outlined, size: 40),
          const SizedBox(height: 12),
          Text(
            context.l10n.filePreviewUnsupported,
            key: const ValueKey('file-preview-unsupported'),
          ),
          if (detail != null) ...[
            const SizedBox(height: 8),
            Text(detail, textAlign: TextAlign.center),
          ],
        ],
      ),
    ),
  );

  Widget _body(RemoteFileData file) {
    if (file.unsupportedReason == 'too_large') {
      return _unsupported(detail: context.l10n.filePreviewTooLarge);
    }
    if (file.bytes.isEmpty)
      return Center(child: Text(context.l10n.filePreviewEmpty));
    final kind = file.kind;
    if (_source || kind == FilePreviewKind.text) {
      return _FileSource(text: file.text!, line: widget.link.line);
    }
    switch (kind) {
      case FilePreviewKind.markdown:
        return SingleChildScrollView(
          padding: const EdgeInsets.all(16),
          child: EcoMarkdown(text: file.text!),
        );
      case FilePreviewKind.html:
        return FileWebPreview(
          file: file,
          readFile: widget.readFile,
          onOpenFile: _openNested,
        );
      case FilePreviewKind.pdf:
        if (defaultTargetPlatform != TargetPlatform.iOS) return _unsupported();
        return FileWebPreview(
          file: file,
          readFile: widget.readFile,
          onOpenFile: _openNested,
        );
      case FilePreviewKind.image:
        return InteractiveViewer(
          minScale: .5,
          maxScale: 6,
          child: Center(
            child: Image.memory(
              file.bytes,
              key: const ValueKey('file-preview-image'),
              fit: BoxFit.contain,
              errorBuilder: (_, error, stack) =>
                  _unsupported(detail: context.l10n.filePreviewDecodeFailed),
            ),
          ),
        );
      case FilePreviewKind.audio:
      case FilePreviewKind.video:
        return SingleChildScrollView(
          child: MediaArtifactPlayer(
            data: ImageViewReadData(
              bytes: file.bytes,
              mimeType: file.mimeType!,
              path: file.path,
              fileName: file.name,
              byteLength: file.bytes.length,
              width: 0,
              height: 0,
            ),
          ),
        );
      case FilePreviewKind.unsupported:
        return _unsupported(
          detail: file.bytes.length > filePreviewMaxTextBytes
              ? context.l10n.filePreviewTextTooLarge
              : null,
        );
      case FilePreviewKind.text:
        throw StateError('Text preview is handled above.');
    }
  }

  @override
  Widget build(BuildContext context) {
    final file = _file;
    final directory = _directory;
    final canShowSource =
        file != null &&
        (file.kind == FilePreviewKind.markdown ||
            file.kind == FilePreviewKind.html);
    final title =
        file?.name ??
        directory?.name ??
        widget.link.path.replaceAll('\\', '/').split('/').last;
    return FileLinkScope(
      onOpenFile: _openNested,
      child: Scaffold(
        appBar: AppBar(
          title: Text(title, maxLines: 1, overflow: TextOverflow.ellipsis),
          actions: [
            if (canShowSource)
              TextButton(
                key: const ValueKey('file-preview-toggle-source'),
                onPressed: () => setState(() => _source = !_source),
                child: Text(
                  _source
                      ? context.l10n.filePreviewRendered
                      : context.l10n.filePreviewSource,
                ),
              ),
          ],
        ),
        body: SafeArea(
          top: false,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 4, 16, 12),
                child: SelectableText(
                  file?.path ?? directory?.path ?? widget.link.path,
                  style: Theme.of(context).textTheme.bodySmall?.copyWith(
                    color: ecoColors(context).textMuted,
                  ),
                ),
              ),
              const Divider(height: 1),
              Expanded(
                child: _error != null
                    ? Center(
                        child: Padding(
                          padding: const EdgeInsets.all(24),
                          child: Column(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              Text(context.l10n.filePreviewLoadFailed),
                              const SizedBox(height: 8),
                              Text(
                                localizedAppError(_error!, context.l10n),
                                textAlign: TextAlign.center,
                              ),
                              const SizedBox(height: 12),
                              TextButton(
                                onPressed: _load,
                                child: Text(context.l10n.commonRetry),
                              ),
                            ],
                          ),
                        ),
                      )
                    : file == null && directory == null
                    ? Center(
                        child: Column(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            CircularProgressIndicator(value: _progress),
                            const SizedBox(height: 12),
                            Text(context.l10n.commonLoading),
                          ],
                        ),
                      )
                    : directory != null
                    ? _directoryBody(directory)
                    : _body(file!),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _FileSource extends StatefulWidget {
  const _FileSource({required this.text, this.line});
  final String text;
  final int? line;
  @override
  State<_FileSource> createState() => _FileSourceState();
}

class _FileSourceState extends State<_FileSource> {
  final _scroll = ScrollController();
  bool _positioned = false;
  @override
  void dispose() {
    _scroll.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final style = Theme.of(
      context,
    ).textTheme.bodyMedium!.copyWith(fontFamily: 'monospace', height: 1.5);
    if (!_positioned) {
      _positioned = true;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!mounted || !_scroll.hasClients || widget.line == null) return;
        final offset =
            (widget.line! - 1) *
            MediaQuery.textScalerOf(context).scale(style.fontSize!) *
            1.5;
        _scroll.jumpTo(offset.clamp(0, _scroll.position.maxScrollExtent));
      });
    }
    return Scrollbar(
      controller: _scroll,
      child: SingleChildScrollView(
        controller: _scroll,
        padding: const EdgeInsets.all(16),
        child: SingleChildScrollView(
          scrollDirection: Axis.horizontal,
          child: SelectionArea(
            child: Text(
              widget.text,
              key: const ValueKey('file-preview-source'),
              softWrap: false,
              style: style,
              strutStyle: StrutStyle.fromTextStyle(
                style,
                forceStrutHeight: true,
              ),
            ),
          ),
        ),
      ),
    );
  }
}
