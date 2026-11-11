import 'package:adaptive_platform_ui/adaptive_platform_ui.dart';
import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';

import '../../core/locale/app_localizations_ext.dart';
import '../../core/models/project_models.dart';
import '../../core/models/scheduling_models.dart';
import '../../core/locale/app_error_localizations.dart';
import '../../core/models/thread_models.dart';
import '../../core/theme/eco_icons.dart';
import '../../core/theme/eco_theme.dart';
import '../../core/widgets/adaptive_toolbar_icon.dart';
import '../../core/widgets/eco_grouped_list.dart';
import '../../core/widgets/ios26_native_search_field.dart';
import 'thread_session_app_bar.dart';

const _maxThreadResults = 10;
const _maxProjectResults = 8;

class ThreadSearchSelection {
  const ThreadSearchSelection.thread(this.thread)
    : project = null,
      schedule = null;

  const ThreadSearchSelection.project(this.project)
    : thread = null,
      schedule = null;

  const ThreadSearchSelection.schedule(this.schedule)
    : thread = null,
      project = null;
  final ScheduleDefinition? schedule;
  final ThreadSummary? thread;
  final EcoProject? project;
}

Future<ThreadSearchSelection?> showThreadSearchSheet({
  required BuildContext context,
  required List<ThreadSummary> threads,
  required List<EcoProject> projects,
  Future<List<ScheduleDefinition>> Function()? loadSchedules,
  Future<Map<String, List<String>>> Function()? loadProjectTerms,
}) {
  final page = _ThreadSearchPage(
    threads: threads,
    projects: projects,
    loadSchedules: loadSchedules,
    loadProjectTerms: loadProjectTerms,
  );
  if (PlatformInfo.isIOS) {
    return Navigator.of(
      context,
      rootNavigator: true,
    ).push<ThreadSearchSelection>(
      CupertinoPageRoute(fullscreenDialog: true, builder: (_) => page),
    );
  }
  return Navigator.of(context, rootNavigator: true).push<ThreadSearchSelection>(
    MaterialPageRoute(fullscreenDialog: true, builder: (_) => page),
  );
}

class _ThreadSearchPage extends StatefulWidget {
  const _ThreadSearchPage({
    required this.threads,
    required this.projects,
    this.loadSchedules,
    this.loadProjectTerms,
  });
  final Future<List<ScheduleDefinition>> Function()? loadSchedules;
  final Future<Map<String, List<String>>> Function()? loadProjectTerms;

  final List<ThreadSummary> threads;
  final List<EcoProject> projects;

  @override
  State<_ThreadSearchPage> createState() => _ThreadSearchPageState();
}

class _ThreadSearchPageState extends State<_ThreadSearchPage> {
  final _searchController = TextEditingController();
  final _focusNode = FocusNode();
  String _query = '';
  List<ScheduleDefinition> _schedules = [];
  Map<String, List<String>> _terms = {};
  Object? _scheduleError, _termsError;
  bool _schedulesLoading = false, _termsLoading = false;
  @override
  void initState() {
    super.initState();
    _loadSchedules();
    _loadTerms();
  }

  Future<void> _loadSchedules() async {
    if (widget.loadSchedules == null || _schedulesLoading) return;
    setState(() {
      _schedulesLoading = true;
      _scheduleError = null;
    });
    try {
      final data = await widget.loadSchedules!();
      if (mounted) setState(() => _schedules = data);
    } catch (error) {
      if (mounted) setState(() => _scheduleError = error);
    } finally {
      if (mounted) setState(() => _schedulesLoading = false);
    }
  }

  Future<void> _loadTerms() async {
    if (widget.loadProjectTerms == null || _termsLoading) return;
    setState(() {
      _termsLoading = true;
      _termsError = null;
    });
    try {
      final data = await widget.loadProjectTerms!();
      if (mounted) setState(() => _terms = data);
    } catch (error) {
      if (mounted) setState(() => _termsError = error);
    } finally {
      if (mounted) setState(() => _termsLoading = false);
    }
  }

  @override
  void dispose() {
    _searchController.dispose();
    _focusNode.dispose();
    super.dispose();
  }

  void _close() {
    Navigator.of(context).pop();
  }

  void _onQueryChanged(String value) {
    setState(() => _query = value);
  }

  void _clearQuery() {
    _searchController.clear();
    setState(() => _query = '');
  }

  @override
  Widget build(BuildContext context) {
    final query = _query.trim().toLowerCase();
    final sortedThreads = [...widget.threads]
      ..sort((left, right) => right.updatedAt.compareTo(left.updatedAt));
    final matchingThreads = sortedThreads
        .where(
          (thread) =>
              query.isEmpty || thread.title.toLowerCase().contains(query),
        )
        .toList();
    final runningThreads = matchingThreads
        .where((thread) => thread.status == 'running')
        .toList();
    final recentThreads = matchingThreads
        .where((thread) => thread.status != 'running')
        .take(_maxThreadResults)
        .toList();
    final matchingProjects = widget.projects
        .where(
          (project) =>
              query.isEmpty ||
              project.name.toLowerCase().contains(query) ||
              project.path.toLowerCase().contains(query) ||
              matchesProjectPinyin(query, _terms[project.path] ?? const []),
        )
        .take(_maxProjectResults)
        .toList();
    final projectNames = {
      for (final project in widget.projects)
        normalizeProjectPath(project.path): project.name,
    };
    final titles = {
      for (final thread in widget.threads) thread.id: thread.title,
    };
    final matchingSchedules =
        _schedules
            .where(
              (s) =>
                  s.isMessage &&
                  (query.isEmpty ||
                      [
                        s.name,
                        s.prompt,
                        titles[s.threadId] ?? '',
                      ].any((text) => text.toLowerCase().contains(query))),
            )
            .toList()
          ..sort(
            (a, b) => (a.nextRunAt ?? '9999').compareTo(b.nextRunAt ?? '9999'),
          );
    final hasResults =
        _schedulesLoading ||
        _termsLoading ||
        _scheduleError != null ||
        _termsError != null ||
        matchingSchedules.isNotEmpty ||
        runningThreads.isNotEmpty ||
        recentThreads.isNotEmpty ||
        matchingProjects.isNotEmpty;
    final frostCanvas = ecoColors(context).bgMain;
    final useIos = PlatformInfo.isIOS;

    // Opaque canvas (fullscreen route is above the shell). Transparency is only
    // the AppBar + frost so results scroll underneath — same as session chrome.
    return Scaffold(
      backgroundColor: frostCanvas,
      extendBodyBehindAppBar: true,
      appBar: AppBar(
        automaticallyImplyLeading: false,
        backgroundColor: Colors.transparent,
        forceMaterialTransparency: true,
        elevation: 0,
        scrolledUnderElevation: 0,
        surfaceTintColor: Colors.transparent,
        shadowColor: Colors.transparent,
        toolbarHeight: _SearchHeader.toolbarHeight(useIos),
        // Frost paints under this transparent AppBar (same as session / threads).
        flexibleSpace: SafeArea(
          bottom: false,
          child: _SearchHeader(
            controller: _searchController,
            focusNode: _focusNode,
            useIos: useIos,
            onChanged: _onQueryChanged,
            onClear: _clearQuery,
            onClose: _close,
          ),
        ),
      ),
      body: Builder(
        builder: (bodyContext) {
          final listTopPad = sessionAppBarChromeHeight(bodyContext);
          return Stack(
            fit: StackFit.expand,
            children: [
              hasResults
                  ? ListView(
                      keyboardDismissBehavior:
                          ScrollViewKeyboardDismissBehavior.onDrag,
                      padding: EdgeInsets.only(top: listTopPad, bottom: 24),
                      children: [
                        if (_schedulesLoading || _termsLoading)
                          const LinearProgressIndicator(),
                        if (_scheduleError != null)
                          ListTile(
                            title: Text(
                              '${context.l10n.schedulingMessages}: ${localizedAppError(_scheduleError!, context.l10n)}',
                            ),
                            trailing: TextButton(
                              onPressed: _loadSchedules,
                              child: Text(context.l10n.commonRetry),
                            ),
                          ),
                        if (_termsError != null)
                          ListTile(
                            title: Text(
                              '${context.l10n.threadSearchProjects}: ${localizedAppError(_termsError!, context.l10n)}',
                            ),
                            trailing: TextButton(
                              onPressed: _loadTerms,
                              child: Text(context.l10n.commonRetry),
                            ),
                          ),
                        if (matchingSchedules.isNotEmpty)
                          _SearchResultSection(
                            label: context.l10n.schedulingMessages,
                            children: [
                              for (final schedule in matchingSchedules.take(10))
                                ListTile(
                                  leading: const Icon(Icons.schedule),
                                  title: Text(schedule.name),
                                  subtitle: Text(
                                    [
                                      schedule.prompt,
                                      if (titles[schedule.threadId] != null)
                                        titles[schedule.threadId]!,
                                    ].join(' · '),
                                    maxLines: 2,
                                    overflow: TextOverflow.ellipsis,
                                  ),
                                  onTap: () => Navigator.pop(
                                    context,
                                    ThreadSearchSelection.schedule(schedule),
                                  ),
                                ),
                            ],
                          ),
                        if (runningThreads.isNotEmpty)
                          _SearchResultSection(
                            label: context.l10n.threadSearchRunning,
                            children: [
                              for (final thread in runningThreads)
                                _ThreadSearchRow(
                                  thread: thread,
                                  projectName:
                                      projectNames[normalizeProjectPath(
                                        thread.workspacePath,
                                      )] ??
                                      _projectBasename(
                                        thread.workspacePath,
                                        context.l10n.projectFallbackName,
                                      ),
                                  onTap: () => Navigator.pop(
                                    context,
                                    ThreadSearchSelection.thread(thread),
                                  ),
                                ),
                            ],
                          ),
                        if (recentThreads.isNotEmpty)
                          _SearchResultSection(
                            label: context.l10n.threadSearchSessions,
                            children: [
                              for (final thread in recentThreads)
                                _ThreadSearchRow(
                                  thread: thread,
                                  projectName:
                                      projectNames[normalizeProjectPath(
                                        thread.workspacePath,
                                      )] ??
                                      _projectBasename(
                                        thread.workspacePath,
                                        context.l10n.projectFallbackName,
                                      ),
                                  onTap: () => Navigator.pop(
                                    context,
                                    ThreadSearchSelection.thread(thread),
                                  ),
                                ),
                            ],
                          ),
                        if (matchingProjects.isNotEmpty)
                          _SearchResultSection(
                            label: context.l10n.threadSearchProjects,
                            children: [
                              for (final project in matchingProjects)
                                _ProjectSearchRow(
                                  project: project,
                                  onTap: () => Navigator.pop(
                                    context,
                                    ThreadSearchSelection.project(project),
                                  ),
                                ),
                            ],
                          ),
                      ],
                    )
                  : Padding(
                      padding: EdgeInsets.only(top: listTopPad),
                      child: Center(
                        child: Text(
                          context.l10n.threadSearchNoResults,
                          style: Theme.of(context).textTheme.bodyMedium
                              ?.copyWith(color: ecoColors(context).textMuted),
                        ),
                      ),
                    ),
              SessionTopFrostOverlay(canvasColor: frostCanvas),
            ],
          );
        },
      ),
    );
  }
}

class _SearchHeader extends StatelessWidget {
  const _SearchHeader({
    required this.controller,
    required this.focusNode,
    required this.useIos,
    required this.onChanged,
    required this.onClear,
    required this.onClose,
  });

  final TextEditingController controller;
  final FocusNode focusNode;
  final bool useIos;
  final ValueChanged<String> onChanged;
  final VoidCallback onClear;
  final VoidCallback onClose;

  /// System [UISearchBar] preferred height — style over tight chrome match.
  static const double _fieldHeight = 56;

  /// Large glass close control (maps to 44pt native glass extent).
  static const double _closeButtonSize = 48;

  static const double _paddingTop = 10;
  static const double _paddingBottom = 20;

  /// Matches session AppBar toolbarHeight: content row + vertical padding.
  static double toolbarHeight(bool useIos) {
    final fieldHeight = useIos ? _fieldHeight : 48.0;
    final contentHeight = fieldHeight > _closeButtonSize
        ? fieldHeight
        : _closeButtonSize;
    return _paddingTop + contentHeight + _paddingBottom;
  }

  @override
  Widget build(BuildContext context) {
    final closeButton = AdaptiveToolbarIcon(
      icon: EcoIcons.close,
      tooltip: context.l10n.commonClose,
      size: _closeButtonSize,
      onPressed: onClose,
    );

    return SizedBox(
      height: toolbarHeight(useIos),
      child: Padding(
        padding: EdgeInsets.fromLTRB(
          useIos ? 12 : 16,
          _paddingTop,
          12,
          _paddingBottom,
        ),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.center,
          children: [
            Expanded(
              child: useIos
                  ? _IosSearchField(height: _fieldHeight, onChanged: onChanged)
                  : _MaterialSearchField(
                      height: 48,
                      controller: controller,
                      focusNode: focusNode,
                      onChanged: onChanged,
                      onClear: onClear,
                    ),
            ),
            const SizedBox(width: sessionToolbarButtonGap),
            closeButton,
          ],
        ),
      ),
    );
  }
}

class _IosSearchField extends StatelessWidget {
  const _IosSearchField({required this.height, required this.onChanged});

  final double height;
  final ValueChanged<String> onChanged;

  @override
  Widget build(BuildContext context) {
    return IOS26NativeSearchField(
      placeholder: context.l10n.threadSearchHint,
      autofocus: true,
      height: height,
      onChanged: onChanged,
    );
  }
}

class _MaterialSearchField extends StatelessWidget {
  const _MaterialSearchField({
    required this.height,
    required this.controller,
    required this.focusNode,
    required this.onChanged,
    required this.onClear,
  });

  final double height;
  final TextEditingController controller;
  final FocusNode focusNode;
  final ValueChanged<String> onChanged;
  final VoidCallback onClear;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      height: height,
      child: TextField(
        controller: controller,
        focusNode: focusNode,
        autofocus: true,
        textInputAction: TextInputAction.search,
        style: Theme.of(context).textTheme.bodyLarge,
        onChanged: onChanged,
        decoration: InputDecoration(
          isDense: true,
          hintText: context.l10n.threadSearchHint,
          contentPadding: const EdgeInsets.symmetric(
            horizontal: 14,
            vertical: 12,
          ),
          prefixIcon: const Icon(EcoIcons.search, size: 20),
          suffixIcon: controller.text.isEmpty
              ? null
              : IconButton(
                  tooltip: context.l10n.threadSearchClear,
                  icon: const Icon(EcoIcons.close, size: 18),
                  onPressed: onClear,
                ),
          border: OutlineInputBorder(borderRadius: BorderRadius.circular(12)),
        ),
      ),
    );
  }
}

class _SearchResultSection extends StatelessWidget {
  const _SearchResultSection({required this.label, required this.children});

  final String label;
  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    return EcoGroupedSection(
      label: label,
      topSpacing: 14,
      child: Column(
        children: [
          for (var index = 0; index < children.length; index++) ...[
            if (index > 0) const EcoGroupedDivider(indent: 48),
            children[index],
          ],
        ],
      ),
    );
  }
}

class _ThreadSearchRow extends StatelessWidget {
  const _ThreadSearchRow({
    required this.thread,
    required this.projectName,
    required this.onTap,
  });

  final ThreadSummary thread;
  final String projectName;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return EcoGroupedTile(
      onTap: onTap,
      child: Row(
        children: [
          Icon(
            thread.status == 'running' ? EcoIcons.active : EcoIcons.sessions,
            size: 17,
            color: thread.status == 'running'
                ? ecoColors(context).accent
                : ecoColors(context).textMuted,
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  thread.title,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
                const SizedBox(height: 2),
                Text(
                  projectName,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: Theme.of(context).textTheme.bodySmall?.copyWith(
                    color: ecoColors(context).textMuted,
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(width: 8),
          Icon(
            EcoIcons.chevronRight,
            size: 16,
            color: ecoColors(context).textMuted,
          ),
        ],
      ),
    );
  }
}

class _ProjectSearchRow extends StatelessWidget {
  const _ProjectSearchRow({required this.project, required this.onTap});

  final EcoProject project;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return EcoGroupedTile(
      onTap: onTap,
      child: Row(
        children: [
          Icon(
            project.isHome ? EcoIcons.home : EcoIcons.folder,
            size: 17,
            color: ecoColors(context).accent,
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  project.name,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
                const SizedBox(height: 2),
                Text(
                  project.path,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: Theme.of(context).textTheme.bodySmall?.copyWith(
                    color: ecoColors(context).textMuted,
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(width: 8),
          Icon(
            EcoIcons.chevronRight,
            size: 16,
            color: ecoColors(context).textMuted,
          ),
        ],
      ),
    );
  }
}

String _projectBasename(String path, String fallback) {
  final normalized = normalizeProjectPath(path);
  final segments = normalized.split('/').where((part) => part.isNotEmpty);
  return segments.isEmpty ? fallback : segments.last;
}

/// Same minimum length and separator folding as desktop project-pinyin-search.
bool matchesProjectPinyin(String query, List<String> terms) {
  final token = query.toLowerCase().replaceAll(
    RegExp(r"[^\p{L}\p{N}]+", unicode: true),
    '',
  );
  return token.length >= 2 && terms.any((term) => term.contains(token));
}
