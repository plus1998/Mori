import 'package:adaptive_platform_ui/adaptive_platform_ui.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/locale/app_localizations_ext.dart';
import '../../core/providers/activity_feed_auto_read_provider.dart';
import '../../core/models/git_models.dart';
import '../../core/models/html_host_models.dart';
import '../../core/models/image_generation_models.dart';
import '../../core/models/thread_models.dart';
import '../../core/models/thread_runtime_config.dart';
import '../../core/theme/eco_adaptive_icons.dart';
import '../../core/theme/eco_icons.dart';
import '../../core/widgets/adaptive_toolbar_icon.dart'
    show AdaptiveToolbarIcon, sessionToolbarButtonSize;
import '../../l10n/generated/app_localizations.dart';
import '../composer/commit_push_sheet.dart';
import 'thread_menu_sheets.dart';
import 'thread_providers.dart';
import 'thread_session_menu_cards.dart';
import '../scheduling/scheduling_screen.dart';

final _openingCommitPushWorkspaces = <String>{};

String resolveGitRemoteSyncAction(int behindCount) {
  return behindCount > 0 ? 'pull' : 'fetch';
}

String resolveGitRemoteSyncLabel(
  GitWorkingTreeStatus? gitStatus,
  AppLocalizations l10n,
) {
  final behindCount = gitStatus?.behindCount ?? 0;
  return behindCount > 0
      ? l10n.threadPullBehind(behindCount)
      : l10n.threadFetch;
}

class ThreadSessionMenuVisibility {
  const ThreadSessionMenuVisibility({
    this.showProgress = false,
    this.showPlan = false,
    this.showImageDisplay = false,
    this.showImageGeneration = false,
    this.showHtmlHost = false,
  });

  final bool showProgress;
  final bool showPlan;
  final bool showImageDisplay;
  final bool showImageGeneration;
  final bool showHtmlHost;

  static const none = ThreadSessionMenuVisibility();
}

List<ThreadSessionMenuEntry> buildThreadSessionMenuEntries(
  AppLocalizations l10n, {
  required bool hasThread,
  required String workspacePath,
  required bool isRunning,
  required bool autoReadEnabled,
  GitWorkingTreeStatus? gitStatus,
  ThreadSessionMenuVisibility visibility = ThreadSessionMenuVisibility.none,
}) {
  final canPull =
      gitStatus?.isGitRepository == true &&
      gitStatus?.branch != null &&
      gitStatus!.branch != 'detached' &&
      gitStatus.hasUpstream;

  return [
    ThreadSessionMenuEntry(
      value: 'scheduled_messages',
      icon: EcoIcons.schedule,
      label: l10n.schedulingMessages,
      enabled: hasThread,
    ),
    if (visibility.showProgress)
      ThreadSessionMenuEntry(
        value: 'todos',
        icon: EcoIcons.todos,
        label: l10n.threadTasks,
        enabled: hasThread,
      ),
    if (visibility.showPlan)
      ThreadSessionMenuEntry(
        value: 'plan',
        icon: EcoIcons.planApproval,
        label: l10n.threadPlan,
        enabled: hasThread,
      ),
    if (visibility.showImageDisplay)
      ThreadSessionMenuEntry(
        value: 'image_display',
        icon: EcoIcons.images,
        label: l10n.taskImageDisplayHistory,
        enabled: hasThread,
      ),
    if (visibility.showImageGeneration)
      ThreadSessionMenuEntry(
        value: 'image_generation',
        icon: EcoIcons.image,
        label: l10n.taskImageGenerationHistory,
        enabled: hasThread,
      ),
    if (visibility.showHtmlHost)
      ThreadSessionMenuEntry(
        value: 'html_host',
        icon: EcoIcons.browser,
        label: l10n.taskHtmlHostHistory,
        enabled: hasThread,
      ),
    ThreadSessionMenuEntry(
      value: 'review',
      icon: EcoIcons.codeReview,
      label: l10n.threadCodeReview,
      enabled: workspacePath.isNotEmpty,
    ),
    ThreadSessionMenuEntry(
      value: 'commit',
      icon: EcoIcons.commitPush,
      label: l10n.threadCommitPush,
      enabled:
          workspacePath.isNotEmpty && (gitStatus?.isGitRepository ?? false),
    ),
    ThreadSessionMenuEntry(
      value: resolveGitRemoteSyncAction(gitStatus?.behindCount ?? 0),
      icon: EcoIcons.pull,
      label: resolveGitRemoteSyncLabel(gitStatus, l10n),
      enabled: !isRunning && canPull,
    ),
    ThreadSessionMenuEntry(
      value: 'scripts',
      icon: EcoIcons.npmScripts,
      label: l10n.threadNpmScripts,
      enabled: workspacePath.isNotEmpty,
    ),
    ThreadSessionMenuEntry(
      value: 'auto_read',
      icon: autoReadEnabled ? EcoIcons.speaking : EcoIcons.volume2,
      label: l10n.threadAutoRead,
      enabled: true,
    ),
  ];
}

class ThreadSessionMenuButton extends ConsumerWidget {
  const ThreadSessionMenuButton({
    super.key,
    this.threadId,
    required this.workspacePath,
    required this.runtimeConfig,
    required this.isRunning,
    this.gitStatus,
    this.onRevealImageDisplay,
  });

  final String? threadId;
  final String workspacePath;
  final ThreadRuntimeConfigInput runtimeConfig;
  final bool isRunning;
  final GitWorkingTreeStatus? gitStatus;
  final VoidCallback? onRevealImageDisplay;

  bool get _hasThread => threadId != null && threadId!.isNotEmpty;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final autoReadEnabled = ref.watch(activityFeedAutoReadProvider);
    final cards = _hasThread
        ? ref.watch(threadSessionMenuCardsProvider(threadId!)).valueOrNull
        : null;
    final visibility = ThreadSessionMenuVisibility(
      showProgress: cards?.showProgress ?? false,
      showPlan: cards?.showPlan ?? false,
      showImageDisplay: cards?.showImageDisplay ?? false,
      showImageGeneration: cards?.showImageGeneration ?? false,
      showHtmlHost: cards?.showHtmlHost ?? false,
    );
    final entries = buildThreadSessionMenuEntries(
      context.l10n,
      hasThread: _hasThread,
      workspacePath: workspacePath,
      isRunning: isRunning,
      autoReadEnabled: autoReadEnabled,
      gitStatus: gitStatus,
      visibility: visibility,
    );
    final menuItems = [
      for (final entry in entries)
        AdaptivePopupMenuItem<String>(
          label: entry.label,
          icon: adaptivePlatformIcon(entry.icon),
          enabled: entry.enabled,
          value: entry.value,
        ),
    ];

    return SizedBox.square(
      dimension: sessionToolbarButtonSize,
      child: Center(
        child: AdaptivePopupMenuButton.widget<String>(
          items: menuItems,
          onSelected: (index, item) {
            if (!item.enabled) return;
            final value = item.value;
            if (value == null) return;
            handleThreadSessionMenuAction(
              context: context,
              ref: ref,
              value: value,
              threadId: threadId,
              workspacePath: workspacePath,
              runtimeConfig: runtimeConfig,
              gitStatus: gitStatus,
              onRevealImageDisplay: onRevealImageDisplay,
              imageGenerationArtifacts:
                  cards?.imageGenerationArtifacts ?? const [],
              htmlHostArtifacts: cards?.htmlHostArtifacts ?? const [],
            );
          },
          child: AdaptiveToolbarIcon(
            icon: EcoIcons.more,
            tooltip: context.l10n.threadMore,
            size: sessionToolbarButtonSize,
            visualOnly: true,
          ),
        ),
      ),
    );
  }
}

class ThreadSessionMenuEntry {
  const ThreadSessionMenuEntry({
    required this.value,
    required this.icon,
    required this.label,
    required this.enabled,
  });

  final String value;
  final IconData icon;
  final String label;
  final bool enabled;
}

Future<void> handleThreadSessionMenuAction({
  required BuildContext context,
  required WidgetRef ref,
  required String value,
  String? threadId,
  required String workspacePath,
  required ThreadRuntimeConfigInput runtimeConfig,
  GitWorkingTreeStatus? gitStatus,
  VoidCallback? onRevealImageDisplay,
  List<ImageGenerationArtifact> imageGenerationArtifacts = const [],
  List<HtmlHostArtifact> htmlHostArtifacts = const [],
}) async {
  final rpc = ref.read(desktopRpcProvider);
  if (rpc == null) return;

  try {
    switch (value) {
      case 'scheduled_messages':
        if (threadId == null || threadId.isEmpty) return;
        await showSchedulingScreen(context, threadId: threadId);
        return;
      case 'auto_read':
        await ref.read(activityFeedAutoReadProvider.notifier).toggle();
        return;
      case 'todos':
        if (threadId == null || threadId.isEmpty) {
          if (context.mounted) {
            ScaffoldMessenger.of(context).showSnackBar(
              SnackBar(content: Text(context.l10n.threadStartFirstForTasks)),
            );
          }
          return;
        }
        await showThreadTodoSheet(
          context: context,
          ref: ref,
          threadId: threadId,
        );
      case 'plan':
        if (threadId == null || threadId.isEmpty) return;
        await showThreadPlanSheet(
          context: context,
          ref: ref,
          threadId: threadId,
        );
      case 'image_display':
        if (threadId == null || threadId.isEmpty) return;
        onRevealImageDisplay?.call();
      case 'image_generation':
        if (threadId == null || threadId.isEmpty) return;
        await showImageGenerationArtifactsSheet(
          context: context,
          ref: ref,
          threadId: threadId,
          artifacts: imageGenerationArtifacts,
        );
      case 'html_host':
        if (threadId == null || threadId.isEmpty) return;
        await showHtmlHostArtifactsSheet(
          context: context,
          ref: ref,
          threadId: threadId,
          artifacts: htmlHostArtifacts,
        );
      case 'review':
        if (workspacePath.isEmpty) return;
        await showWorkspaceDiffReviewSheet(
          context: context,
          ref: ref,
          workspacePath: workspacePath,
        );
      case 'commit':
        await openCommitPushFromMenu(
          context: context,
          ref: ref,
          workspacePath: workspacePath,
          runtimeConfig: runtimeConfig,
          gitStatus: gitStatus,
        );
      case 'pull':
        if (workspacePath.isEmpty) return;
        await pullChangesFromMenu(
          context: context,
          ref: ref,
          workspacePath: workspacePath,
          branch: gitStatus?.branch,
        );
      case 'fetch':
        if (workspacePath.isEmpty) return;
        await fetchChangesFromMenu(
          context: context,
          ref: ref,
          workspacePath: workspacePath,
        );
      case 'scripts':
        if (workspacePath.isEmpty) return;
        await showNpmScriptsSheet(
          context: context,
          ref: ref,
          workspacePath: workspacePath,
        );
    }
  } catch (error) {
    if (context.mounted) {
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text(error.toString())));
    }
  }
}

Future<void> openCommitPushFromMenu({
  required BuildContext context,
  required WidgetRef ref,
  required String workspacePath,
  required ThreadRuntimeConfigInput runtimeConfig,
  GitWorkingTreeStatus? gitStatus,
}) async {
  if (workspacePath.isEmpty) return;

  final rpc = ref.read(desktopRpcProvider);
  if (rpc == null) return;
  if (!_openingCommitPushWorkspaces.add(workspacePath)) return;

  var loadingDialogOpen = false;
  try {
    if (!context.mounted) return;
    showDialog<void>(
      context: context,
      barrierDismissible: false,
      builder: (dialogContext) => PopScope(
        canPop: false,
        child: Center(
          child: Card(
            child: Padding(
              padding: EdgeInsets.all(24),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  const CircularProgressIndicator(),
                  const SizedBox(height: 12),
                  Text(context.l10n.threadLoadingCommit),
                ],
              ),
            ),
          ),
        ),
      ),
    );
    loadingDialogOpen = true;

    Future<GitWorkingTreeStatus> loadGitStatus() async {
      try {
        return await rpc.getGitStatus(workspacePath);
      } catch (_) {
        if (gitStatus == null) rethrow;
        return gitStatus;
      }
    }

    final results = await Future.wait<Object>([
      loadGitStatus(),
      rpc.getWorkspaceDiff(workspacePath),
    ]);
    if (!context.mounted) return;

    Navigator.of(context, rootNavigator: true).pop();
    loadingDialogOpen = false;

    final committed = await showCommitPushSheet(
      context: context,
      ref: ref,
      workspacePath: workspacePath,
      mainAgentConfigId: resolveCommitMainAgentConfigId(runtimeConfig),
      defaultCandidateModelId: runtimeConfig.auxiliaryModel?.candidateModelId,
      diff: results[1] as WorkspaceDiffResult,
      gitStatus: results[0] as GitWorkingTreeStatus,
    );

    if (committed != null && context.mounted) {
      refreshWorkspaceChanges(ref, workspacePath);
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(switch (committed) {
            'commit-push' => context.l10n.threadCommittedPushed,
            'push' => context.l10n.threadPushed,
            _ => context.l10n.threadCommitted,
          }),
        ),
      );
    }
  } finally {
    if (loadingDialogOpen && context.mounted) {
      Navigator.of(context, rootNavigator: true).pop();
    }
    _openingCommitPushWorkspaces.remove(workspacePath);
  }
}

Future<void> pullChangesFromMenu({
  required BuildContext context,
  required WidgetRef ref,
  required String workspacePath,
  String? branch,
}) async {
  final rpc = ref.read(desktopRpcProvider);
  if (rpc == null) return;

  if (!context.mounted) return;
  showDialog<void>(
    context: context,
    barrierDismissible: false,
    builder: (dialogContext) => Center(
      child: Card(
        child: Padding(
          padding: EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const CircularProgressIndicator(),
              const SizedBox(height: 12),
              Text(context.l10n.threadPulling),
            ],
          ),
        ),
      ),
    ),
  );

  try {
    final result = await rpc.pullChanges(
      workspacePath: workspacePath,
      branch: branch,
    );
    refreshWorkspaceChanges(ref, workspacePath);
    if (!context.mounted) return;

    if (result.conflicted) {
      final files = result.conflictFiles.join(', ');
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            files.isEmpty
                ? context.l10n.threadPullConflictDesktop
                : context.l10n.threadPullConflictFiles(files),
          ),
        ),
      );
      return;
    }

    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(
          result.pulled
              ? context.l10n.threadPullSuccess
              : context.l10n.threadAlreadySynced,
        ),
      ),
    );
  } finally {
    if (context.mounted) {
      Navigator.of(context, rootNavigator: true).pop();
    }
  }
}

Future<void> fetchChangesFromMenu({
  required BuildContext context,
  required WidgetRef ref,
  required String workspacePath,
}) async {
  final rpc = ref.read(desktopRpcProvider);
  if (rpc == null) return;

  if (!context.mounted) return;
  showDialog<void>(
    context: context,
    barrierDismissible: false,
    builder: (dialogContext) => Center(
      child: Card(
        child: Padding(
          padding: EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const CircularProgressIndicator(),
              const SizedBox(height: 12),
              Text(context.l10n.threadFetching),
            ],
          ),
        ),
      ),
    ),
  );

  try {
    await rpc.fetchChanges(workspacePath: workspacePath);
    refreshWorkspaceChanges(ref, workspacePath);
    if (!context.mounted) return;
    ScaffoldMessenger.of(
      context,
    ).showSnackBar(SnackBar(content: Text(context.l10n.threadFetchComplete)));
  } finally {
    if (context.mounted) {
      Navigator.of(context, rootNavigator: true).pop();
    }
  }
}
