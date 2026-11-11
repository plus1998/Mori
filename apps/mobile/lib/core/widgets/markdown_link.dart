import 'package:flutter/material.dart';

import '../locale/app_localizations_ext.dart';
import '../models/file_preview_models.dart';
import '../utils/local_file_link.dart';
import 'web_page_viewer.dart';

/// Resolve at click time so retained streaming Markdown uses the current scope.
class FileLinkScope extends InheritedWidget {
  const FileLinkScope({
    super.key,
    required this.onOpenFile,
    required super.child,
  });
  final ValueChanged<LocalFileLink> onOpenFile;

  static FileLinkScope? maybeOf(BuildContext context) =>
      context.getInheritedWidgetOfExactType<FileLinkScope>();

  @override
  bool updateShouldNotify(FileLinkScope oldWidget) => false;
}

void openMarkdownLink(
  BuildContext context,
  String text,
  String? href,
  String title,
) {
  final file = parseLocalFileLink(href);
  final scope = FileLinkScope.maybeOf(context);
  if (file != null && scope != null) {
    scope.onOpenFile(file);
    return;
  }
  final uri = Uri.tryParse(href?.trim() ?? '');
  if (uri != null &&
      uri.hasAuthority &&
      uri.host.isNotEmpty &&
      (uri.scheme == 'http' || uri.scheme == 'https')) {
    Navigator.of(context).push<void>(
      MaterialPageRoute(
        builder: (_) => WebPageViewer(
          title: title.trim().isNotEmpty ? title : text,
          url: uri.toString(),
        ),
      ),
    );
    return;
  }
  ScaffoldMessenger.of(context).showSnackBar(
    SnackBar(
      content: Text(
        file == null
            ? context.l10n.taskHtmlHostOpenFailed
            : context.l10n.filePreviewNoContext,
      ),
    ),
  );
}
