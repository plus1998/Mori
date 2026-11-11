// ignore_for_file: curly_braces_in_flow_control_structures

import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:uuid/uuid.dart';
import 'package:webview_flutter/webview_flutter.dart';

import '../../core/locale/app_localizations_ext.dart';
import '../../core/models/file_preview_models.dart';
import '../../core/utils/local_file_link.dart';
import '../../core/widgets/markdown_link.dart';
import 'file_preview_page.dart' show FilePreviewReader;

class FileWebPreview extends StatefulWidget {
  const FileWebPreview({
    super.key,
    required this.file,
    required this.readFile,
    required this.onOpenFile,
  });
  final RemoteFileData file;
  final FilePreviewReader readFile;
  final ValueChanged<LocalFileLink> onOpenFile;
  @override
  State<FileWebPreview> createState() => _FileWebPreviewState();
}

class _FileWebPreviewState extends State<FileWebPreview> {
  final _token = const Uuid().v4();
  final _resources = <String, Future<RemoteFileData>>{};
  HttpServer? _server;
  WebViewController? _controller;
  bool _loading = true;
  String? _error;
  String? _resourceError;

  @override
  void initState() {
    super.initState();
    unawaited(_initialize());
  }

  String? _remotePath(Uri uri) {
    final segments = uri.pathSegments;
    if (segments.isEmpty || segments.first != _token) return null;
    final path = segments.skip(1).join('/');
    return RegExp(r'^[a-zA-Z]:/').hasMatch(path) ? path : '/$path';
  }

  Future<void> _initialize() async {
    try {
      final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      if (!mounted) {
        await server.close(force: true);
        return;
      }
      _server = server;
      final path = widget.file.path
          .replaceAll('\\', '/')
          .replaceFirst(RegExp(r'^/'), '');
      final controller = WebViewController()
        ..setJavaScriptMode(JavaScriptMode.unrestricted)
        ..setNavigationDelegate(
          NavigationDelegate(
            onNavigationRequest: (request) {
              final uri = Uri.tryParse(request.url);
              if (uri == null) return NavigationDecision.prevent;
              if (uri.port == server.port && uri.host == '127.0.0.1') {
                final targetPath = _remotePath(uri);
                if (targetPath != null && targetPath != '/$path') {
                  final target = parseLocalFileLink(
                    '$targetPath${uri.hasFragment ? '#${uri.fragment}' : ''}',
                  );
                  if (target != null) widget.onOpenFile(target);
                  return NavigationDecision.prevent;
                }
                return NavigationDecision.navigate;
              }
              if (request.isMainFrame)
                openMarkdownLink(context, request.url, request.url, '');
              return NavigationDecision.prevent;
            },
            onPageFinished: (_) {
              if (mounted) setState(() => _loading = false);
            },
            onWebResourceError: (error) {
              if (mounted && error.isForMainFrame != false) {
                setState(() {
                  _loading = false;
                  _error = error.description;
                });
              }
            },
          ),
        );
      final url = Uri(
        scheme: 'http',
        host: '127.0.0.1',
        port: server.port,
        path: '/$_token/$path',
      );
      server.listen((request) => unawaited(_serve(request)));
      await controller.loadRequest(url);
      if (mounted) setState(() => _controller = controller);
    } catch (error) {
      if (mounted)
        setState(() {
          _loading = false;
          _error = error.toString();
        });
    }
  }

  Future<RemoteFileData> _resource(String path) async {
    if (path == widget.file.path.replaceAll('\\', '/')) return widget.file;
    return _resources.putIfAbsent(
      path,
      () => widget.readFile(
        LocalFileLink(path: path),
        relativeTo: widget.file.path,
        isCancelled: () => !mounted,
      ),
    );
  }

  Future<void> _serve(HttpRequest request) async {
    try {
      final path = _remotePath(request.uri);
      if (path == null ||
          (request.method != 'GET' && request.method != 'HEAD')) {
        request.response.statusCode = HttpStatus.notFound;
        await request.response.close();
        return;
      }
      final file = await _resource(path);
      if (file.unsupportedReason != null)
        throw UnsupportedError('File is too large to preview.');
      final bytes = file.bytes;
      final mime = switch (file.extension) {
        'html' || 'htm' => 'text/html; charset=utf-8',
        'svg' => 'image/svg+xml',
        'css' => 'text/css; charset=utf-8',
        'js' || 'mjs' => 'text/javascript; charset=utf-8',
        'json' => 'application/json',
        'png' => 'image/png',
        'jpg' || 'jpeg' => 'image/jpeg',
        'gif' => 'image/gif',
        'webp' => 'image/webp',
        'avif' => 'image/avif',
        _ => file.mimeType ?? 'application/octet-stream',
      };
      request.response.headers.set(HttpHeaders.contentTypeHeader, mime);
      request.response.headers.set(HttpHeaders.cacheControlHeader, 'no-store');
      var start = 0, end = bytes.length - 1;
      final range = request.headers.value(HttpHeaders.rangeHeader);
      if (range != null && bytes.isNotEmpty) {
        final match = RegExp(r'^bytes=(\d+)-(\d*)$').firstMatch(range);
        if (match == null) {
          request.response.statusCode = HttpStatus.requestedRangeNotSatisfiable;
          await request.response.close();
          return;
        }
        start = int.parse(match.group(1)!);
        end = int.tryParse(match.group(2) ?? '') ?? end;
        if (end >= bytes.length) end = bytes.length - 1;
        if (start > end || start >= bytes.length) {
          request.response.statusCode = HttpStatus.requestedRangeNotSatisfiable;
          await request.response.close();
          return;
        }
        request.response.statusCode = HttpStatus.partialContent;
        request.response.headers.set(
          HttpHeaders.contentRangeHeader,
          'bytes $start-$end/${bytes.length}',
        );
      }
      request.response.contentLength = bytes.isEmpty ? 0 : end - start + 1;
      if (request.method == 'GET' && bytes.isNotEmpty)
        request.response.add(bytes.sublist(start, end + 1));
      await request.response.close();
    } catch (error) {
      if (mounted) setState(() => _resourceError = error.toString());
      request.response.statusCode = HttpStatus.internalServerError;
      await request.response.close();
    }
  }

  @override
  void dispose() {
    unawaited(_server?.close(force: true));
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (_error != null)
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Text(
            '${context.l10n.filePreviewUnsupported}\n$_error',
            textAlign: TextAlign.center,
          ),
        ),
      );
    return Column(
      children: [
        if (_resourceError != null)
          Material(
            color: Theme.of(context).colorScheme.errorContainer,
            child: Padding(
              padding: const EdgeInsets.all(8),
              child: Row(
                children: [
                  Expanded(
                    child: Text(
                      '${context.l10n.filePreviewResourceFailed}\n$_resourceError',
                    ),
                  ),
                  TextButton(
                    onPressed: () {
                      setState(() => _resourceError = null);
                      _controller?.reload();
                    },
                    child: Text(context.l10n.commonRetry),
                  ),
                ],
              ),
            ),
          ),
        Expanded(
          child: Stack(
            fit: StackFit.expand,
            children: [
              if (_controller != null) WebViewWidget(controller: _controller!),
              if (_loading) const Center(child: CircularProgressIndicator()),
            ],
          ),
        ),
      ],
    );
  }
}
