import 'dart:convert';

import 'package:flutter/material.dart';

import '../../core/locale/app_localizations_ext.dart';
import '../../core/theme/eco_theme.dart';
import '../../core/widgets/eco_modal_sheet.dart';

String todoProjectName(Map<String, String> projects, String path) =>
    projects[path] ??
    path
        .replaceAll('\\', '/')
        .split('/')
        .where((part) => part.isNotEmpty)
        .lastOrNull ??
    path;

Future<String?> pickTodoProject(
  BuildContext context,
  Map<String, String> projects, {
  bool includeAll = false,
}) => showEcoModalBottomSheet<String>(
  context: context,
  isScrollControlled: true,
  useSafeArea: true,
  showDragHandle: true,
  builder: (context) =>
      _ProjectPicker(projects: projects, includeAll: includeAll),
);

class _ProjectPicker extends StatefulWidget {
  const _ProjectPicker({required this.projects, required this.includeAll});
  final Map<String, String> projects;
  final bool includeAll;
  @override
  State<_ProjectPicker> createState() => _ProjectPickerState();
}

class _ProjectPickerState extends State<_ProjectPicker> {
  String _query = '';
  @override
  Widget build(BuildContext context) {
    final l = context.l10n;
    final projects = widget.projects.entries
        .where(
          (p) => '${p.value} ${p.key}'.toLowerCase().contains(
            _query.toLowerCase(),
          ),
        )
        .toList();
    return SafeArea(
      child: Padding(
        padding: EdgeInsets.fromLTRB(
          20,
          0,
          20,
          MediaQuery.viewInsetsOf(context).bottom + 16,
        ),
        child: SizedBox(
          height: MediaQuery.sizeOf(context).height * .6,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(
                l.todosProject,
                style: Theme.of(context).textTheme.titleLarge,
              ),
              const SizedBox(height: 16),
              TextField(
                decoration: InputDecoration(
                  prefixIcon: const Icon(Icons.search),
                  hintText: l.todosSearchProjects,
                ),
                onChanged: (value) => setState(() => _query = value),
              ),
              const SizedBox(height: 8),
              Expanded(
                child: ListView(
                  children: [
                    if (widget.includeAll)
                      ListTile(
                        leading: const Icon(Icons.apps_rounded),
                        title: Text(l.todosAllProjects),
                        onTap: () => Navigator.pop(context, ''),
                      ),
                    for (final p in projects)
                      ListTile(
                        leading: const Icon(Icons.folder_outlined),
                        title: Text(p.value),
                        subtitle: Text(
                          p.key,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                        ),
                        onTap: () => Navigator.pop(context, p.key),
                      ),
                    if (projects.isEmpty)
                      Padding(
                        padding: const EdgeInsets.all(24),
                        child: Text(l.todosNoProjects),
                      ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class TodoThumbnail extends StatelessWidget {
  const TodoThumbnail({
    super.key,
    required this.source,
    this.size = 72,
    this.onTap,
  });
  final String source;
  final double size;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    Widget invalid() => ColoredBox(
      color: ecoColors(context).bgInput,
      child: const Center(child: Icon(Icons.broken_image_outlined)),
    );
    Widget image;
    try {
      image = Image.memory(
        base64Decode(source.split(',').last),
        fit: BoxFit.cover,
        cacheWidth: 256,
        errorBuilder: (_, _, _) => invalid(),
      );
    } catch (_) {
      image = invalid();
    }
    return Semantics(
      label: context.l10n.todosPreviewImage,
      button: onTap != null,
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(12),
        child: ClipRRect(
          borderRadius: BorderRadius.circular(12),
          child: SizedBox(width: size, height: size, child: image),
        ),
      ),
    );
  }
}

Future<void> showTodoImage(BuildContext context, String data) =>
    Navigator.of(context, rootNavigator: true).push<void>(
      MaterialPageRoute(
        builder: (context) => Scaffold(
          appBar: AppBar(title: Text(context.l10n.todosPreviewImage)),
          body: Center(
            child: InteractiveViewer(
              minScale: .5,
              maxScale: 5,
              child: Image.memory(
                base64Decode(data.split(',').last),
                errorBuilder: (_, _, _) =>
                    const Icon(Icons.broken_image_outlined),
              ),
            ),
          ),
        ),
      ),
    );
