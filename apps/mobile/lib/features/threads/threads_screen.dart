import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/locale/app_localizations_ext.dart';
import '../../core/locale/app_error_localizations.dart';
import '../../core/models/project_models.dart';
import '../../core/theme/eco_icons.dart';
import '../../core/theme/eco_theme.dart';
import '../../core/widgets/adaptive_nav_bar.dart';
import '../../core/widgets/adaptive_toolbar_icon.dart';
import '../projects/project_list_widgets.dart';
import '../projects/project_menu_sheets.dart';
import '../projects/project_providers.dart';
import 'thread_menu_sheets.dart';
import 'thread_attention_sheet.dart';
import 'thread_providers.dart';
import 'thread_search_sheet.dart';
import '../scheduling/scheduling_screen.dart';
import 'thread_session_app_bar.dart';
import 'session_content_boot_loading.dart';

class ThreadsScreen extends ConsumerStatefulWidget {
  const ThreadsScreen({super.key});

  @override
  ConsumerState<ThreadsScreen> createState() => _ThreadsScreenState();
}

class _ThreadsScreenState extends ConsumerState<ThreadsScreen> {
  final _dismissedAttentionIds = <String>{};
  bool _attentionSheetOpen = false;
  bool _newThreadOpening = false;
  bool _searchOpening = false;

  @override
  Widget build(BuildContext context) {
    final projectsAsync = ref.watch(displayProjectsProvider);
    final pinnedPaths = ref.watch(pinnedProjectPathsProvider);
    final pinnedThreadIds = ref.watch(pinnedThreadIdsProvider).toSet();
    final threadsByProject = ref.watch(threadsByProjectProvider);
    final threadPageMetadata = ref.watch(threadListPageMetadataProvider);
    final attention = ref.watch(threadAttentionProvider);
    final attentionItems =
        attention.valueOrNull ?? const <ThreadAttentionItem>[];
    final visibleAttentionItems = attentionItems
        .where((item) => !_dismissedAttentionIds.contains(item.id))
        .toList(growable: false);
    ref.watch(collapsedProjectPathsProvider);
    final collapsedNotifier = ref.read(collapsedProjectPathsProvider.notifier);

    ref.listen(threadAttentionProvider, (previous, next) {
      next.whenData(_retainActiveDismissedAttentionIds);
    });
    ref.listen(displayProjectsProvider, (previous, next) {
      next.whenData(collapsedNotifier.applyProjectDefaults);
    });
    projectsAsync.whenData(collapsedNotifier.applyProjectDefaults);

    final frostCanvas = ecoColors(context).bgMain;
    final projectsBooting = projectsAsync.isLoading && !projectsAsync.hasValue;

    // Entering / switching PC should land on this route's boot surface, not
    // linger on the connect PC list. Hide shell chrome until projects resolve.
    if (projectsBooting) {
      return Scaffold(
        body: SessionContentBootLoading(
          semanticLabel: context.l10n.commonLoading,
          continueFromLaunchSplash: false,
        ),
      );
    }

    return Scaffold(
      backgroundColor: Colors.transparent,
      extendBodyBehindAppBar: true,
      appBar: AppBar(
        backgroundColor: Colors.transparent,
        forceMaterialTransparency: true,
        elevation: 0,
        scrolledUnderElevation: 0,
        surfaceTintColor: Colors.transparent,
        shadowColor: Colors.transparent,
        leadingWidth: 64,
        leading: Padding(
          padding: const EdgeInsets.only(left: 12),
          child: AdaptiveToolbarIcon(
            tooltip: context.l10n.toolbarOpenProject,
            icon: EcoIcons.folderOpen,
            size: sessionToolbarButtonSize,
            onPressed: () => showOpenProjectSheet(context: context, ref: ref),
          ),
        ),
        title: Text(context.l10n.threadsTitle),
        actions: [
          Padding(
            padding: const EdgeInsets.only(right: 12),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                AdaptiveToolbarIcon(
                  tooltip: context.l10n.schedulingTitle,
                  icon: EcoIcons.schedule,
                  size: sessionToolbarButtonSize,
                  onPressed: () => showSchedulingScreen(context),
                ),
                const SizedBox(width: sessionToolbarButtonGap),
                AdaptiveToolbarIcon(
                  tooltip: context.l10n.toolbarSearch,
                  icon: EcoIcons.search,
                  size: sessionToolbarButtonSize,
                  onPressed: _searchOpening
                      ? null
                      : () => _openSearch(context, ref),
                ),
                const SizedBox(width: sessionToolbarButtonGap),
                _ThreadAttentionButton(
                  count: visibleAttentionItems.length,
                  loading: attention.isLoading || projectsAsync.isLoading,
                  onPressed: _attentionSheetOpen
                      ? null
                      : () => _openAttention(context),
                ),
              ],
            ),
          ),
        ],
      ),
      // Body MediaQuery.padding.top is inflated to clear the AppBar — must measure
      // under [Scaffold], not from [State.context] (parent of this Scaffold).
      body: Builder(
        builder: (bodyContext) {
          final listTopPad = sessionAppBarChromeHeight(bodyContext);
          final listBottomPad = adaptiveNavOverlayInset(bodyContext);
          return Stack(
            fit: StackFit.expand,
            children: [
              projectsAsync.when(
                data: (projects) {
                  if (projects.isEmpty) {
                    return const SafeArea(child: ProjectListEmptyState());
                  }
                  return RefreshIndicator(
                    // Align pull-to-refresh with content under the frosted AppBar.
                    edgeOffset: listTopPad,
                    onRefresh: () => refreshProjectsAndThreads(ref),
                    child: ListView.builder(
                      physics: const AlwaysScrollableScrollPhysics(),
                      padding: EdgeInsets.only(
                        top: listTopPad,
                        bottom: listBottomPad,
                      ),
                      itemCount: projects.length,
                      itemBuilder: (context, index) {
                        final project = projects[index];
                        final threads =
                            threadsByProject[normalizeProjectPath(
                              project.path,
                            )] ??
                            const [];
                        final pageMetadata = threadPageMetadata.entries
                            .where(
                              (entry) =>
                                  normalizeProjectPath(entry.key) ==
                                  normalizeProjectPath(project.path),
                            )
                            .firstOrNull
                            ?.value;
                        final isCollapsed = collapsedNotifier
                            .isProjectCollapsed(project);

                        final isPinned =
                            !project.isHome &&
                            pinnedPaths.any(
                              (path) =>
                                  normalizeProjectPath(path) ==
                                  normalizeProjectPath(project.path),
                            );

                        return ProjectSectionCard(
                          project: project,
                          threads: threads,
                          hasMoreThreads: pageMetadata?.hasMore ?? false,
                          totalThreadCount:
                              pageMetadata?.totalCount ?? threads.length,
                          onLoadMoreThreads: () => ref
                              .read(threadListProvider.notifier)
                              .loadMore(project.path),
                          isCollapsed: isCollapsed,
                          isPinned: isPinned,
                          pinnedThreadIds: pinnedThreadIds,
                          onHeaderTap: () =>
                              _onProjectHeaderTap(ref, project: project),
                          onHeaderLongPress: project.isHome
                              ? null
                              : () => showProjectActionSheet(
                                  context: context,
                                  ref: ref,
                                  project: project,
                                ),
                          onNewThread: () =>
                              _openNewThread(context, ref, project.path),
                          onThreadTap: (thread) =>
                              context.push('/threads/${thread.id}'),
                          onThreadLongPress: (thread) => showThreadActionSheet(
                            context: context,
                            ref: ref,
                            thread: thread,
                          ),
                        );
                      },
                    ),
                  );
                },
                loading: () => SessionContentBootLoading(
                  semanticLabel: context.l10n.commonLoading,
                  continueFromLaunchSplash: false,
                ),
                error: (error, _) => SafeArea(
                  child: ProjectListErrorState(
                    error: error,
                    onRetry: () => refreshProjectsAndThreads(ref),
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

  Future<void> _openNewThread(
    BuildContext context,
    WidgetRef ref,
    String projectPath,
  ) async {
    if (_newThreadOpening) return;
    _newThreadOpening = true;
    try {
      await ref.read(selectedProjectPathProvider.notifier).select(projectPath);
      if (context.mounted) context.push('/threads/new');
    } finally {
      _newThreadOpening = false;
    }
  }

  Future<void> _openSearch(BuildContext context, WidgetRef ref) async {
    if (_searchOpening) return;
    setState(() => _searchOpening = true);
    try {
      final threads = await ref
          .read(threadListProvider.notifier)
          .listAllForSearch();
      final projects =
          ref.read(displayProjectsProvider).valueOrNull ?? const [];
      if (!context.mounted) return;
      final selection = await showThreadSearchSheet(
        context: context,
        threads: threads,
        projects: projects,
      );
      if (selection == null || !context.mounted) return;

      final thread = selection.thread;
      if (thread != null) {
        context.push('/threads/${thread.id}');
        return;
      }

      final project = selection.project;
      if (project == null) return;
      await openProjectPath(ref, project.path);
    } catch (error) {
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(localizedAppError(error, context.l10n))),
        );
      }
    } finally {
      if (mounted) {
        setState(() => _searchOpening = false);
      }
    }
  }

  Future<void> _openAttention(BuildContext context) async {
    if (_attentionSheetOpen) return;
    setState(() => _attentionSheetOpen = true);
    try {
      final item = await showThreadAttentionSheet(
        context: context,
        itemsFuture: ref.read(threadAttentionProvider.future),
        hiddenItemIds: Set.unmodifiable(_dismissedAttentionIds),
      );
      if (item != null && context.mounted) {
        setState(() => _dismissedAttentionIds.add(item.id));
        ref.invalidate(threadAttentionProvider);
        context.push('/threads/${item.threadId}');
      }
    } finally {
      if (mounted) {
        setState(() => _attentionSheetOpen = false);
      }
    }
  }

  void _retainActiveDismissedAttentionIds(List<ThreadAttentionItem> items) {
    final activeIds = items.map((item) => item.id).toSet();
    final retainedIds = _dismissedAttentionIds
        .where(activeIds.contains)
        .toSet();
    if (retainedIds.length == _dismissedAttentionIds.length) return;
    if (!mounted) return;
    setState(() {
      _dismissedAttentionIds
        ..clear()
        ..addAll(retainedIds);
    });
  }

  Future<void> _onProjectHeaderTap(
    WidgetRef ref, {
    required EcoProject project,
  }) async {
    await ref.read(collapsedProjectPathsProvider.notifier).toggle(project.path);
    await ref.read(selectedProjectPathProvider.notifier).select(project.path);
  }
}

class _ThreadAttentionButton extends StatelessWidget {
  const _ThreadAttentionButton({
    required this.count,
    required this.loading,
    required this.onPressed,
  });

  final int count;
  final bool loading;
  final VoidCallback? onPressed;

  @override
  Widget build(BuildContext context) {
    if (loading) {
      return SizedBox.square(
        dimension: sessionToolbarButtonSize,
        child: Center(
          child: SizedBox.square(
            dimension: 16,
            child: CircularProgressIndicator(
              strokeWidth: 2,
              color: ecoColors(context).accent,
            ),
          ),
        ),
      );
    }

    return Stack(
      clipBehavior: Clip.none,
      children: [
        AdaptiveToolbarIcon(
          tooltip: context.l10n.threadAttentionTitle,
          icon: EcoIcons.notifications,
          size: sessionToolbarButtonSize,
          onPressed: onPressed,
        ),
        if (count > 0)
          Positioned(
            top: 4,
            right: 4,
            child: Container(
              width: 8,
              height: 8,
              decoration: BoxDecoration(
                color: ecoColors(context).danger,
                shape: BoxShape.circle,
                border: Border.all(
                  color: ecoColors(context).bgMain,
                  width: 1.5,
                ),
              ),
            ),
          ),
      ],
    );
  }
}
