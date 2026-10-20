import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:image_picker/image_picker.dart';

import '../../core/locale/app_localizations_ext.dart';
import '../../core/locale/app_error_localizations.dart';
import '../../core/models/app_error.dart';
import '../../core/models/conversation_v2_models.dart';
import '../../core/models/git_models.dart';
import '../../core/models/image_display_models.dart';
import '../../core/models/image_view_models.dart';
import '../../core/models/project_models.dart';
import '../../core/models/project_orchestration_settings.dart';
import '../../core/models/thread_runtime_config.dart';
import '../../core/models/thread_models.dart';
import '../../core/models/acp_host_ui_features.dart';
import '../../core/providers/app_providers.dart';
import '../../core/providers/thinking_display_provider.dart';
import '../../core/widgets/activity_feed_auto_read_listener.dart';
import '../../core/theme/eco_icons.dart';
import '../../core/theme/eco_theme.dart';
import '../../core/utils/conversation_v2_hash.dart';
import '../../core/utils/prompt_image_attachment.dart';
import '../../core/utils/prompt_image_upload.dart';
import '../../core/utils/thread_follow_up_ui.dart';
import '../../core/utils/thread_status.dart';
import '../../core/platform/session_wake_lock.dart';
import '../../core/widgets/eco_modal_sheet.dart';
import '../approvals/approval_sheets.dart';
import '../approvals/bash_approval_panel.dart';
import '../approvals/plan_approval_panel.dart';
import '../composer/composer_dock_shell.dart';
import '../composer/follow_up_queue_bar.dart';
import '../composer/session_composer.dart';
import '../composer/workspace_changes_pill.dart';
import '../projects/project_providers.dart';
import 'activity_feed.dart';
import 'activity_feed_scroll_coordinator.dart';
import 'conversation_v2_activity_feed.dart';
import '../../core/sync/conversation_v2_session.dart';
import 'conversation_v2_projection.dart';
import 'image_display_artifacts.dart';
import 'image_display_floating_gallery.dart';
import 'thread_menu_sheets.dart';
import 'thread_session_layout.dart';
import 'thread_providers.dart';
import 'thread_session_app_bar.dart';
import 'thread_session_route.dart';
import 'session_content_boot_loading.dart';

class ThreadSessionScreen extends ConsumerStatefulWidget {
  const ThreadSessionScreen({super.key, required this.threadId});

  final String threadId;

  @override
  ConsumerState<ThreadSessionScreen> createState() =>
      _ThreadSessionScreenState();
}

class _ThreadSessionScreenState extends ConsumerState<ThreadSessionScreen>
    with WidgetsBindingObserver {
  final _promptController = TextEditingController();
  final _scrollController = ScrollController();
  late final ActivityFeedScrollCoordinator _scrollCoordinator =
      ActivityFeedScrollCoordinator(_scrollController);
  final _attachments = <PromptImageAttachment>[];
  final _picker = ImagePicker();
  final _imageDisplayGalleryController =
      ImageDisplayFloatingGalleryController();
  List<ImageDisplayArtifact> _remoteImageDisplayArtifacts = const [];
  int _imageDisplayListEpoch = 0;
  bool _bashApprovalBusy = false;
  bool _planActionBusy = false;
  bool _clarificationBusy = false;
  bool _followUpBusy = false;
  bool _sendBusy = false;
  bool _stopBusy = false;
  bool _starting = false;
  var _coreKind = 'claude';
  String? _runtimeConfigScope;
  String? _editingFollowUpId;
  String? _followUpCancelBusyId;
  String? _followUpEscalateBusyId;
  bool _followUpQueuePauseBusy = false;
  double _lastKeyboardInset = 0;
  String? _deferredComposerRestoreRevision;
  bool _active = true;

  bool get _isLanding => widget.threadId == threadSessionNewPathSegment;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _promptController.addListener(() {
      if (_isLanding && mounted) setState(() {});
    });
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      if (_isLanding) {
        unawaited(_initLandingRuntimeConfig());
        return;
      }
      final thread = ref.read(threadSessionProvider(widget.threadId)).thread;
      ref.read(runtimeConfigProvider.notifier).state = thread?.runtimeConfig;
      _scheduleImageDisplayArtifactsRefresh();
    });
  }

  @override
  void activate() {
    super.activate();
    _active = true;
  }

  @override
  void didUpdateWidget(covariant ThreadSessionScreen oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.threadId == threadSessionNewPathSegment &&
        widget.threadId != threadSessionNewPathSegment) {
      // Landing → live session handoff: keep composer controllers; seed already
      // applied. Pull runtime config from the new session when available.
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!mounted || _isLanding) return;
        final thread = ref.read(threadSessionProvider(widget.threadId)).thread;
        if (thread?.runtimeConfig != null) {
          ref.read(runtimeConfigProvider.notifier).state =
              thread!.runtimeConfig;
        }
      });
    }
  }

  @override
  void didChangeMetrics() {
    if (!mounted || _isLanding) return;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || _isLanding) return;
      final inset = MediaQuery.viewInsetsOf(context).bottom;
      if (inset > _lastKeyboardInset &&
          !_scrollCoordinator.userDetachedFromBottom) {
        _scrollCoordinator.scrollToEnd();
      }
      _lastKeyboardInset = inset;
    });
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      if (!_isLanding) {
        unawaited(_refreshFollowUps());
        final notifier = ref.read(
          threadSessionProvider(widget.threadId).notifier,
        );
        unawaited(notifier.refreshComposerRestore());
        unawaited(notifier.recoverProjection());
        unawaited(notifier.ensureThreadLoaded());
        final workspacePath =
            ref
                .read(threadSessionProvider(widget.threadId))
                .thread
                ?.workspacePath ??
            '';
        if (workspacePath.isNotEmpty) {
          refreshWorkspaceChanges(ref, workspacePath);
        }
      }
      _syncSessionWakeLock();
      return;
    }
    if (state == AppLifecycleState.inactive ||
        state == AppLifecycleState.paused ||
        state == AppLifecycleState.hidden ||
        state == AppLifecycleState.detached) {
      unawaited(sessionWakeLock.disable());
    }
  }

  @override
  void deactivate() {
    _active = false;
    _imageDisplayListEpoch += 1;
    if (_editingFollowUpId != null) {
      final rpc = ref.read(desktopRpcProvider);
      if (rpc != null) {
        unawaited(rpc.followUpSetEditing(threadId: widget.threadId));
      }
      _editingFollowUpId = null;
    }
    unawaited(ref.read(ecoTtsServiceProvider).stop());
    unawaited(sessionWakeLock.disable());
    super.deactivate();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    unawaited(sessionWakeLock.disable());
    _imageDisplayGalleryController.dispose();
    _promptController.dispose();
    _scrollController.dispose();
    super.dispose();
  }

  void _scheduleImageDisplayArtifactsRefresh() {
    if (!_active || _isLanding) return;
    final epoch = ++_imageDisplayListEpoch;
    unawaited(_refreshImageDisplayArtifacts(epoch));
  }

  Future<void> _refreshImageDisplayArtifacts(int epoch) async {
    if (!_active) return;
    final rpc = ref.read(desktopRpcProvider);
    if (rpc == null) return;
    try {
      final listed = await rpc.listImageDisplayArtifacts(widget.threadId);
      if (!mounted || epoch != _imageDisplayListEpoch) return;
      setState(() => _remoteImageDisplayArtifacts = listed);
    } catch (_) {
      // Projection-derived artifacts still drive the gallery; list is enrichment.
    }
  }

  Future<ImageViewReadData> _loadImageDisplayArtifactBytes(
    String artifactId, {
    void Function(int receivedBytes, int totalBytes)? onProgress,
  }) async {
    final rpc = ref.read(desktopRpcProvider);
    if (rpc == null) {
      throw const ImageViewReadException(
        ImageViewReadFailureCode.bridgeUnavailable,
      );
    }
    return rpc.readImageDisplay(artifactId, onProgress: onProgress);
  }

  void _revealImageDisplayGallery(String artifactId) {
    _imageDisplayGalleryController.reveal(artifactId: artifactId);
  }

  /// Legacy lifecycle clock: `thread.*` events own queued/approval transitions.
  bool _isRunning(ThreadSummary? thread) {
    if (thread == null) return false;
    return thread.status == 'running' || thread.status == 'queued';
  }

  /// Whether the V2 stream is trustworthy enough to own the run state.
  bool _v2OwnsRunState(ConversationV2SessionState v2) {
    return v2.syncState == ConversationV2SyncState.catchingUp ||
        v2.syncState == ConversationV2SyncState.live;
  }

  /// Joins the two clocks the session state arrives on.
  ///
  /// The Feed renders from the V2 event stream while the running status arrives
  /// on the legacy `thread.*` channel, and the two are applied independently.
  /// Leaving the running state early makes the composer switch back to send
  /// while the Feed is still printing the answer, so the session may only leave
  /// it once both agree: the lifecycle reports a terminal status *and* V2 has no
  /// active run (whose `run.completed` is emitted after the final message in the
  /// same ordered stream).
  bool _isSessionRunning(
    ThreadSummary? thread, [
    ConversationV2SessionState? v2,
  ]) {
    final ConversationV2SessionState v2State =
        v2 ?? ref.read(conversationV2SessionProvider(widget.threadId));
    return resolveSessionRunning(
      lifecycleRunning: _isRunning(thread),
      v2StreamTrusted: _v2OwnsRunState(v2State),
      runs: v2State.runs,
    );
  }

  bool _shouldKeepScreenAwake(ThreadSummary? thread) {
    // Landing send (_starting) must also keep the screen on until handoff.
    return _starting || (!_isLanding && _isSessionRunning(thread));
  }

  void _syncSessionWakeLock([ThreadSummary? thread]) {
    final current =
        thread ??
        (_isLanding
            ? null
            : ref.read(threadSessionProvider(widget.threadId)).thread);
    final lifecycle = WidgetsBinding.instance.lifecycleState;
    final foreground =
        lifecycle == null || lifecycle == AppLifecycleState.resumed;
    unawaited(
      sessionWakeLock.sync(foreground && _shouldKeepScreenAwake(current)),
    );
  }

  @override
  Widget build(BuildContext context) {
    if (_isLanding) {
      _syncSessionWakeLock(null);
      return _buildLanding(context);
    }

    final session = ref.watch(
      threadSessionProvider(widget.threadId).select(
        (state) => (
          loading: state.loading,
          error: state.error,
          thread: state.thread,
          titleGenerating: state.titleGenerating,
          pendingPlan: state.pendingPlan,
          pendingBash: state.pendingBash,
          pendingClarification: state.pendingClarification,
          followUps: state.followUps,
          billing: state.billing,
          contextSnapshot: state.contextSnapshot,
          composerRestore: state.composerRestore,
          runProjection: state.runProjection,
          projectionReady: isProjectionFeedReady(state.runProjection),
          projectionSettled: state.projectionSettled,
          projectionSynchronizing: state.projectionSynchronizing,
        ),
      ),
    );
    final conversationV2 = ref.watch(
      conversationV2SessionProvider(widget.threadId),
    );
    final conversationV2ContentReady =
        conversationV2.syncState != ConversationV2SyncState.uninitialized &&
        conversationV2.syncState != ConversationV2SyncState.bootstrapping;
    final runtimeConfig =
        ref.watch(runtimeConfigProvider) ??
        session.thread?.runtimeConfig ??
        buildDefaultRuntimeConfig();
    final thread = session.thread;
    final workspacePath = thread?.workspacePath ?? '';
    final projectName = workspacePath.isEmpty
        ? null
        : workspaceDisplayName(workspacePath);
    final landingHero = landingHeroText(
      workspacePath: workspacePath.isEmpty ? null : workspacePath,
      projectName: projectName,
      l10n: context.l10n,
    );
    final gitStatusAsync = workspacePath.isNotEmpty && !session.loading
        ? ref.watch(gitStatusProvider(workspacePath))
        : const AsyncValue<GitWorkingTreeStatus?>.data(null);
    final gitStatus = gitStatusAsync.valueOrNull;
    final workspaceChanges = ref.watch(
      workspacePillSummaryProvider(workspacePath),
    );
    final changesLoading = ref.watch(
      workspacePillLoadingProvider(workspacePath),
    );
    final isRunning = _isSessionRunning(thread, conversationV2);
    _syncSessionWakeLock(thread);
    final stopping = _stopBusy || (thread?.cancelling == true);
    final sessionContentBooting = isSessionContentBooting(
      hasError: session.error != null && !conversationV2ContentReady,
      projectionReady: session.projectionReady || conversationV2ContentReady,
      projectionSettled:
          session.projectionSettled || conversationV2ContentReady,
      projectionSynchronizing:
          session.projectionSynchronizing && !conversationV2ContentReady,
      loading: session.loading && !conversationV2ContentReady,
      thread: thread,
    );
    final showLanding =
        !sessionContentBooting &&
        !session.loading &&
        session.error == null &&
        !isRunning &&
        !session.projectionReady &&
        !conversationV2ContentReady;
    final followUpMode = shouldComposerUseFollowUpQueue(
      // `isRunning` is the joined clock: while a V2 run is still active the
      // composer must keep queueing instead of starting a new turn, even if the
      // lifecycle status already reported its terminal value.
      status: isRunning ? 'running' : thread?.status,
      editingFollowUpId: _editingFollowUpId,
      followUpQueuePaused: thread?.followUpQueuePaused ?? false,
    );
    // Once V2 has started, interaction state is read from V2 detail items as
    // well. Do not let a stale legacy bootstrap row resurrect an approval or
    // clarification after V2 has already resolved it.
    final useConversationV2Interactions =
        conversationV2.syncState != ConversationV2SyncState.uninitialized;
    final pendingBash = useConversationV2Interactions
        ? conversationV2.pendingBash
        : session.pendingBash;
    final pendingPlan = useConversationV2Interactions
        ? conversationV2.pendingPlan
        : session.pendingPlan;
    final pendingClarification = useConversationV2Interactions
        ? conversationV2.pendingClarification
        : session.pendingClarification;
    final isAwaitingPlan = thread != null && pendingPlan?.threadId == thread.id;
    final canStopThread = isRunning || isAwaitingPlan;
    final planFailureMessage = isAwaitingPlan
        ? extractPlanFailureMessage(thread.message)
        : null;
    final showBashApproval =
        pendingBash != null && pendingBash.threadId == thread?.id;
    final showPlanApproval =
        pendingPlan != null && pendingPlan.threadId == thread?.id;
    final showClarification =
        pendingClarification != null &&
        pendingClarification.threadId == thread?.id;
    final queuedFollowUps = queuedThreadFollowUps(session.followUps);

    ref.listen(threadSessionProvider(widget.threadId), (previous, next) {
      if (next.loading) return;
      final previousProjection = previous?.runProjection;
      final nextProjection = next.runProjection;
      final projectionBecameReady =
          !isProjectionFeedReady(previousProjection) &&
          isProjectionFeedReady(nextProjection);
      if (projectionBecameReady) {
        ref
            .read(threadSessionRevealedProvider.notifier)
            .update((revealed) => {...revealed, widget.threadId});
        _scrollCoordinator.forceScrollToEnd();
      }
      if (!identical(previousProjection, nextProjection)) {
        _scheduleImageDisplayArtifactsRefresh();
      }
      final restore = next.composerRestore;
      if (restore != null &&
          restore.revision.isNotEmpty &&
          previous?.composerRestore?.revision != restore.revision) {
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (mounted) unawaited(_applyComposerRestore(restore));
        });
      }
      final prevThread = previous?.thread;
      final nextThread = next.thread;
      if (prevThread != null &&
          nextThread != null &&
          isThreadBusy(prevThread) &&
          !isThreadBusy(nextThread)) {
        final path = nextThread.workspacePath;
        if (path.isNotEmpty) {
          refreshWorkspaceChanges(ref, path);
        }
      }
      if (_stopBusy) {
        final liveThread = next.thread;
        if (liveThread == null ||
            (!_isSessionRunning(liveThread) && liveThread.cancelling != true)) {
          setState(() => _stopBusy = false);
        }
      }
    });

    final hasWorkspaceChanges = workspaceChanges?.hasChanges ?? false;
    final hasFloatingComposerContent =
        hasWorkspaceChanges ||
        queuedFollowUps.isNotEmpty ||
        _editingFollowUpId != null;

    final projectionImageDisplays = collectImageDisplayArtifactsFromProjection(
      threadId: widget.threadId,
      projection: session.runProjection,
    );
    final imageDisplayArtifacts = mergeImageDisplayArtifacts(
      fromProjection: projectionImageDisplays,
      fromRemote: _remoteImageDisplayArtifacts,
    );

    final floatingComposer = hasFloatingComposerContent
        ? Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              if (hasWorkspaceChanges)
                WorkspaceChangesPill(
                  summary: workspaceChanges,
                  busy: changesLoading,
                  onTap: workspacePath.isNotEmpty
                      ? () {
                          refreshWorkspaceChanges(ref, workspacePath);
                          showWorkspaceDiffReviewSheet(
                            context: context,
                            ref: ref,
                            workspacePath: workspacePath,
                          );
                        }
                      : null,
                ),
              if (queuedFollowUps.isNotEmpty)
                FollowUpQueueBar(
                  followUps: queuedFollowUps,
                  editingFollowUpId: _editingFollowUpId,
                  queuePaused: thread?.followUpQueuePaused ?? false,
                  pauseBusy: _followUpQueuePauseBusy,
                  cancelBusyId: _followUpCancelBusyId,
                  escalateBusyId: _followUpEscalateBusyId,
                  onEscalate: (followUp) => _escalateFollowUp(followUp),
                  onEdit: _startEditingFollowUp,
                  onDelete: (followUp) => _deleteFollowUp(followUp),
                  onReorder: (oldIndex, newIndex) =>
                      _reorderFollowUps(queuedFollowUps, oldIndex, newIndex),
                  onTogglePause: _toggleFollowUpQueuePaused,
                ),
            ],
          )
        : null;

    return PopScope(
      onPopInvokedWithResult: (didPop, result) {
        if (didPop) {
          ref.read(ecoTtsServiceProvider).stop();
        }
      },
      child: Scaffold(
        resizeToAvoidBottomInset: false,
        extendBodyBehindAppBar: true,
        backgroundColor: ecoColors(context).bgFeed,
        appBar: buildThreadSessionAppBar(
          context,
          ref,
          title: thread?.title ?? '',
          prompt: thread?.prompt ?? '',
          workspacePath: workspacePath,
          threadId: widget.threadId,
          projectName: projectName,
          runtimeConfig: runtimeConfig,
          isRunning: isRunning,
          titleGenerating: session.titleGenerating,
          gitStatus: gitStatus,
          onRevealImageDisplay: imageDisplayArtifacts.isEmpty
              ? null
              : () => _imageDisplayGalleryController.reveal(
                  artifactId: imageDisplayArtifacts.last.id,
                ),
        ),
        body: ThreadSessionConversationLayout(
          floatingComposer: floatingComposer,
          floatingOverlayBuilder: imageDisplayArtifacts.isEmpty
              ? null
              : (controlsBottomInset) => ImageDisplayFloatingGallery(
                  artifacts: imageDisplayArtifacts,
                  controller: _imageDisplayGalleryController,
                  bottomInset: controlsBottomInset,
                  loadBytes: _loadImageDisplayArtifactBytes,
                ),
          foreground: sessionContentBooting
              ? SessionContentBootLoading(
                  semanticLabel: context.l10n.feedOpening,
                  continueFromLaunchSplash: false,
                )
              : null,
          feedBuilder: (context, feedBottomInset, controlsBottomInset) =>
              session.error != null && !conversationV2ContentReady
              ? Center(
                  child: Text(localizedAppError(session.error!, context.l10n)),
                )
              : showLanding
              ? Padding(
                  padding: EdgeInsets.fromLTRB(
                    32,
                    sessionContentTopPadding(context),
                    32,
                    32 + feedBottomInset,
                  ),
                  child: Align(
                    alignment: Alignment.center,
                    child: Text(
                      landingHero,
                      textAlign: TextAlign.center,
                      style: Theme.of(context).textTheme.headlineSmall
                          ?.copyWith(fontWeight: FontWeight.w600, height: 1.35),
                    ),
                  ),
                )
              : _ThreadSessionFeedPane(
                  threadId: widget.threadId,
                  scrollController: _scrollController,
                  scrollCoordinator: _scrollCoordinator,
                  isRunning: isRunning,
                  stopping: stopping,
                  feedBottomInset: feedBottomInset,
                  controlsBottomInset: controlsBottomInset,
                  onOpenImageDisplayArtifact: _revealImageDisplayGallery,
                ),
          composer: IgnorePointer(
            ignoring: sessionContentBooting,
            child: Opacity(
              opacity: sessionContentBooting ? 0 : 1,
              child: AnimatedPadding(
                duration: const Duration(milliseconds: 100),
                curve: Curves.easeOut,
                padding: EdgeInsets.only(
                  bottom: MediaQuery.viewInsetsOf(context).bottom,
                ),
                child: ComposerDockShell(
                  child: AnimatedSwitcher(
                    duration: const Duration(milliseconds: 280),
                    switchInCurve: Curves.easeOutCubic,
                    switchOutCurve: Curves.easeInCubic,
                    transitionBuilder: (child, animation) {
                      return FadeTransition(
                        opacity: animation,
                        child: ScaleTransition(
                          scale: Tween<double>(begin: 0.96, end: 1).animate(
                            CurvedAnimation(
                              parent: animation,
                              curve: Curves.easeOutCubic,
                            ),
                          ),
                          alignment: Alignment.bottomCenter,
                          child: child,
                        ),
                      );
                    },
                    child: showBashApproval
                        ? BashApprovalPanel(
                            key: ValueKey('bash-${pendingBash.toolUseId}'),
                            request: pendingBash,
                            busy: _bashApprovalBusy,
                            onResolve: ({required decision, feedback}) async {
                              setState(() => _bashApprovalBusy = true);
                              try {
                                if (useConversationV2Interactions) {
                                  await ref
                                      .read(
                                        conversationV2SessionProvider(
                                          widget.threadId,
                                        ).notifier,
                                      )
                                      .resolveBash(
                                        pendingBash.toolUseId,
                                        decision,
                                        feedback: feedback,
                                      );
                                } else {
                                  await ref
                                      .read(
                                        threadSessionProvider(
                                          widget.threadId,
                                        ).notifier,
                                      )
                                      .resolveBash(
                                        pendingBash.toolUseId,
                                        decision,
                                        feedback: feedback,
                                      );
                                }
                              } finally {
                                if (mounted) {
                                  setState(() => _bashApprovalBusy = false);
                                }
                              }
                            },
                            onSkip: () async {
                              setState(() => _bashApprovalBusy = true);
                              try {
                                if (useConversationV2Interactions) {
                                  await ref
                                      .read(
                                        conversationV2SessionProvider(
                                          widget.threadId,
                                        ).notifier,
                                      )
                                      .resolveBash(
                                        pendingBash.toolUseId,
                                        'denied',
                                      );
                                } else {
                                  await ref
                                      .read(
                                        threadSessionProvider(
                                          widget.threadId,
                                        ).notifier,
                                      )
                                      .resolveBash(
                                        pendingBash.toolUseId,
                                        'denied',
                                      );
                                }
                              } finally {
                                if (mounted) {
                                  setState(() => _bashApprovalBusy = false);
                                }
                              }
                            },
                          )
                        : showPlanApproval
                        ? PlanApprovalPanel(
                            key: ValueKey('plan-${pendingPlan.threadId}'),
                            plan: pendingPlan,
                            busy: _planActionBusy,
                            failureMessage: planFailureMessage,
                            onApprove: () async {
                              setState(() => _planActionBusy = true);
                              try {
                                await _handlePlanApproval(approve: true);
                              } finally {
                                if (mounted) {
                                  setState(() => _planActionBusy = false);
                                }
                              }
                            },
                            onDismiss: () async {
                              setState(() => _planActionBusy = true);
                              try {
                                await _handlePlanApproval(approve: false);
                              } finally {
                                if (mounted) {
                                  setState(() => _planActionBusy = false);
                                }
                              }
                            },
                          )
                        : showClarification
                        ? ClarificationDockPanel(
                            key: ValueKey(
                              'clarification-${pendingClarification.toolUseId}',
                            ),
                            request: pendingClarification,
                            busy: _clarificationBusy,
                            onSubmit: (selections) => _submitClarification(
                              pendingClarification,
                              selections,
                            ),
                            onDismiss: () =>
                                _dismissClarification(pendingClarification),
                          )
                        : SessionComposer(
                            key: const ValueKey('session-composer'),
                            controller: _promptController,
                            attachments: _attachments,
                            runtimeConfig: runtimeConfig,
                            threadId: widget.threadId,
                            isRunning: isRunning,
                            canStopThread: canStopThread,
                            followUpMode: followUpMode,
                            sendBusy: _followUpBusy || _sendBusy,
                            stopBusy: stopping,
                            hasActivity:
                                session.projectionReady ||
                                conversationV2ContentReady,
                            inputHint: _editingFollowUpId != null
                                ? context.l10n.threadEditGuidanceHint
                                : (showLanding
                                      ? composerLandingPlaceholder(context.l10n)
                                      : null),
                            recoveryNotice:
                                session.composerRestore != null &&
                                    _deferredComposerRestoreRevision ==
                                        session.composerRestore!.revision
                                ? session.composerRestore!.reason
                                : null,
                            onRestoreDraft:
                                session.composerRestore != null &&
                                    _deferredComposerRestoreRevision ==
                                        session.composerRestore!.revision
                                ? () => _applyComposerRestore(
                                    session.composerRestore!,
                                    overwrite: true,
                                  )
                                : null,
                            billing: conversationV2ContentReady
                                ? conversationV2.projectionExtras?.billing
                                : session.billing,
                            contextSnapshot: conversationV2ContentReady
                                ? conversationV2.projectionExtras?.context
                                : session.contextSnapshot,
                            threadStatus: thread?.status,
                            workspacePath: workspacePath,
                            coreKind: thread?.coreKind,
                            hostUiFeatures:
                                thread?.hostUiFeatures ??
                                AcpHostUiFeatures.showAll,
                            onPickImage: _pickImage,
                            onRemoveAttachment: (index) =>
                                setState(() => _attachments.removeAt(index)),
                            onSend: () => _sendMessage(runtimeConfig),
                            onStop: () => _stopThread(),
                            onRuntimeConfigChanged: (config) {
                              ref.read(runtimeConfigProvider.notifier).state =
                                  config;
                            },
                          ),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  Widget _buildLanding(BuildContext context) {
    ref.listen(selectedDesktopIdProvider, (previous, next) {
      if (previous != null && previous != next) {
        ref.read(runtimeConfigProvider.notifier).state = null;
        _runtimeConfigScope = null;
        unawaited(_initLandingRuntimeConfig());
      }
    });

    final workspacePath =
        ref.watch(selectedProjectPathProvider).valueOrNull ?? '';
    ref.listen(selectedProjectPathProvider, (previous, next) {
      if (previous?.valueOrNull != next.valueOrNull) {
        ref.read(runtimeConfigProvider.notifier).state = null;
        _runtimeConfigScope = null;
        unawaited(_initLandingRuntimeConfig());
      }
    });
    final modelSettings = ref.watch(modelSettingsProvider);
    final workflow = ref.watch(workflowSettingsProvider);
    final mcpSettings = ref.watch(mcpSettingsProvider);
    final projectOrchestration = workspacePath.isEmpty
        ? const AsyncValue<ProjectOrchestrationSettingsSnapshot?>.data(null)
        : ref.watch(projectOrchestrationSettingsProvider(workspacePath));
    final runtimeConfig =
        ref.watch(runtimeConfigProvider) ??
        (projectOrchestration.hasValue
            ? buildDefaultRuntimeConfig(
                modelSettings: modelSettings.valueOrNull,
                workflow: workflow.valueOrNull,
                mcpServers: mcpSettings.valueOrNull?.servers,
                orchestrationSelection:
                    projectOrchestration.valueOrNull?.orchestrationSelection,
                coreKind: _coreKind,
              )
            : ThreadRuntimeConfig(
                subagentEnabled: defaultSubagentAvailability(),
                sessionMode: workflow.valueOrNull?.sessionMode ?? 'agent',
                bashReviewMode: normalizeBashReviewMode(
                  workflow.valueOrNull?.defaultBashReviewMode,
                ),
              ));
    final gitStatusAsync = workspacePath.isNotEmpty
        ? ref.watch(gitStatusProvider(workspacePath))
        : const AsyncValue<GitWorkingTreeStatus?>.data(null);
    final gitStatus = gitStatusAsync.valueOrNull;
    final workspaceChanges = ref.watch(
      workspacePillSummaryProvider(workspacePath),
    );
    final changesLoading = ref.watch(
      workspacePillLoadingProvider(workspacePath),
    );
    final projectsAsync = ref.watch(projectListProvider);
    EcoProject? project;
    for (final item in projectsAsync.valueOrNull ?? const <EcoProject>[]) {
      if (item.path == workspacePath) {
        project = item;
        break;
      }
    }

    return Scaffold(
      resizeToAvoidBottomInset: false,
      extendBodyBehindAppBar: true,
      backgroundColor: ecoColors(context).bgFeed,
      appBar: buildThreadSessionAppBar(
        context,
        ref,
        title: context.l10n.threadNew,
        workspacePath: workspacePath,
        projectName: project?.name,
        runtimeConfig: runtimeConfig,
        isRunning: _starting,
        gitStatus: gitStatus,
        showNewThreadAction: false,
      ),
      body: ref.watch(runtimeConfigProvider) == null
          ? const Center(child: CircularProgressIndicator())
          : Stack(
              children: [
                Padding(
                  padding: EdgeInsets.fromLTRB(
                    32,
                    sessionContentTopPadding(context),
                    32,
                    180,
                  ),
                  child: Align(
                    alignment: Alignment.center,
                    child: Text(
                      landingHeroText(
                        workspacePath: workspacePath,
                        isHomeProject: project?.isHome ?? false,
                        projectName: project?.name,
                        l10n: context.l10n,
                      ),
                      textAlign: TextAlign.center,
                      style: Theme.of(context).textTheme.headlineSmall
                          ?.copyWith(fontWeight: FontWeight.w600, height: 1.35),
                    ),
                  ),
                ),
                Positioned(
                  top: 0,
                  left: 0,
                  right: 0,
                  height: sessionToolbarFrostHeight(context),
                  child: const IgnorePointer(child: SessionTopFrostGradient()),
                ),
                Positioned(
                  left: 0,
                  right: 0,
                  bottom: 0,
                  child: AnimatedPadding(
                    duration: const Duration(milliseconds: 100),
                    curve: Curves.easeOut,
                    padding: EdgeInsets.only(
                      bottom: MediaQuery.viewInsetsOf(context).bottom,
                    ),
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        WorkspaceChangesPill(
                          summary: workspaceChanges,
                          busy: changesLoading,
                          onTap: workspacePath.isNotEmpty
                              ? () {
                                  refreshWorkspaceChanges(ref, workspacePath);
                                  showWorkspaceDiffReviewSheet(
                                    context: context,
                                    ref: ref,
                                    workspacePath: workspacePath,
                                  );
                                }
                              : null,
                        ),
                        ComposerDockShell(
                          child: SessionComposer(
                            controller: _promptController,
                            attachments: _attachments,
                            runtimeConfig: runtimeConfig,
                            threadId: '',
                            isRunning: false,
                            sendBusy: _starting,
                            hasActivity: false,
                            inputHint: composerLandingPlaceholder(context.l10n),
                            workspacePath: workspacePath,
                            coreKind: _coreKind,
                            onCoreKindChanged: _handleLandingCoreKindChanged,
                            onPickImage: _pickImage,
                            onRemoveAttachment: (index) =>
                                setState(() => _attachments.removeAt(index)),
                            onSend: _startNewThread,
                            onStop: () {},
                            onRuntimeConfigChanged: (config) {
                              ref.read(runtimeConfigProvider.notifier).state =
                                  config;
                            },
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
              ],
            ),
    );
  }

  Future<void> _initLandingRuntimeConfig() async {
    final currentDesktopId = ref.read(selectedDesktopIdProvider);
    final workspacePath = await ref.read(selectedProjectPathProvider.future);
    final scope = '$currentDesktopId:${workspacePath ?? ''}';
    final existing = ref.read(runtimeConfigProvider);
    if (existing != null && _runtimeConfigScope == scope) return;

    _runtimeConfigScope = scope;
    final modelSettings = await ref.read(modelSettingsProvider.future);
    final workflow = await ref.read(workflowSettingsProvider.future);
    final mcpSettings = await ref.read(mcpSettingsProvider.future);
    final projectOrchestration = workspacePath == null || workspacePath.isEmpty
        ? null
        : await ref.read(
            projectOrchestrationSettingsProvider(workspacePath).future,
          );
    if (!mounted || _runtimeConfigScope != scope) return;
    _coreKind = workflow?.defaultCoreKind ?? 'claude';
    ref.read(runtimeConfigProvider.notifier).state = buildDefaultRuntimeConfig(
      modelSettings: modelSettings,
      workflow: workflow,
      mcpServers: mcpSettings?.servers,
      orchestrationSelection: projectOrchestration?.orchestrationSelection,
      coreKind: _coreKind,
    );
  }

  void _handleLandingCoreKindChanged(String coreKind) {
    final current = ref.read(runtimeConfigProvider);
    final modelSettings = ref.read(modelSettingsProvider).valueOrNull;
    final workflow = ref.read(workflowSettingsProvider).valueOrNull;
    final mcpSettings = ref.read(mcpSettingsProvider).valueOrNull;
    final workspacePath = ref.read(selectedProjectPathProvider).valueOrNull;
    final projectOrchestration = workspacePath == null || workspacePath.isEmpty
        ? null
        : ref
              .read(projectOrchestrationSettingsProvider(workspacePath))
              .valueOrNull;
    final next = coreKind == 'acp'
        ? buildAcpRuntimeConfig(
            workflow: workflow,
            cursorModelId: current?.cursorModelId,
            sessionMode: current?.sessionMode,
            bashReviewMode: current?.bashReviewMode,
            subagentEnabled: current?.subagentEnabled,
            auxiliaryModel: current?.auxiliaryModel,
            approvalModel: current?.approvalModel,
            visionModel: current?.visionModel,
            mcpServersEnabled: current?.mcpServersEnabled,
            integrationsEnabled: current?.integrationsEnabled,
          )
        : buildDefaultRuntimeConfig(
            modelSettings: modelSettings,
            workflow: workflow,
            mcpServers: mcpSettings?.servers,
            orchestrationSelection:
                projectOrchestration?.orchestrationSelection,
            coreKind: coreKind,
          );
    ref.read(runtimeConfigProvider.notifier).state = next;
    setState(() => _coreKind = coreKind);
    unawaited(_saveDefaultCoreKind(coreKind));
  }

  Future<void> _saveDefaultCoreKind(String coreKind) async {
    final rpc = ref.read(desktopRpcProvider);
    final workflow = ref.read(workflowSettingsProvider).valueOrNull;
    if (rpc == null || workflow == null) return;
    try {
      await rpc.saveWorkflowSettings(
        WorkflowSettingsSnapshot(
          sessionMode: workflow.sessionMode,
          defaultCoreKind: coreKind,
          acpCursorModelId: workflow.acpCursorModelId,
          showBilling: workflow.showBilling,
          defaultBashReviewMode: workflow.defaultBashReviewMode,
          contextWindowLimitTokens: workflow.contextWindowLimitTokens,
          maxOutputLimitTokens: workflow.maxOutputLimitTokens,
          defaultOrchestrationSelection: workflow.defaultOrchestrationSelection,
          defaultAuxiliaryModel: workflow.defaultAuxiliaryModel,
          defaultApprovalModel: workflow.defaultApprovalModel,
          defaultVisionModel: workflow.defaultVisionModel,
          mcpServersEnabled: workflow.mcpServersEnabled,
          integrationsEnabled: workflow.integrationsEnabled,
        ),
      );
      ref.invalidate(workflowSettingsProvider);
    } catch (_) {
      // The local selection still applies to this new thread.
    }
  }

  Future<void> _startNewThread() async {
    final prompt = _promptController.text.trim();
    if (prompt.isEmpty && _attachments.isEmpty) return;
    if (_starting) return;

    final rpc = ref.read(desktopRpcProvider);
    final workspacePath = ref.read(selectedProjectPathProvider).valueOrNull;
    final runtimeConfig = ref.read(runtimeConfigProvider);
    final modelSettings = ref.read(modelSettingsProvider).valueOrNull;
    if (rpc == null || workspacePath == null || workspacePath.isEmpty) return;
    if (runtimeConfig == null) return;
    if (!isThreadRuntimeConfigReady(
      modelSettings,
      runtimeConfig,
      coreKind: _coreKind,
    )) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(context.l10n.commonNotConfigured)),
        );
      }
      return;
    }

    setState(() => _starting = true);
    try {
      final sendRuntimeConfig = downgradeApprovalDependentFeatures(
        runtimeConfig,
      );
      if (sendRuntimeConfig.bashReviewMode != runtimeConfig.bashReviewMode) {
        ref.read(runtimeConfigProvider.notifier).state = sendRuntimeConfig;
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(
              content: Text(context.l10n.auxiliaryModelAutoReviewFallback),
            ),
          );
        }
      }
      final stagedAttachments = _attachments.isEmpty
          ? null
          : await stagePromptImageAttachments(
              rpc: rpc,
              contextKey: composerDraftContextKey(workspacePath: workspacePath),
              attachments: List.of(_attachments),
              onUpdate: (next) {
                if (!mounted) return;
                setState(() {
                  _attachments
                    ..clear()
                    ..addAll(next);
                });
              },
            );
      final thread = await rpc.startThread(
        workspacePath: workspacePath,
        prompt: prompt,
        coreKind: _coreKind,
        attachments: stagedAttachments,
        runtimeConfig: sendRuntimeConfig,
      );
      ref.read(threadSessionSeedProvider.notifier).state = thread;
      ref.read(threadListProvider.notifier).upsertThread(thread);
      ref.invalidate(projectWorkspaceContextProvider);
      _promptController.clear();
      _attachments.clear();
      if (mounted) {
        context.go(
          '/threads/${thread.id}',
          extra: const ThreadSessionRouteExtra(handoff: true),
        );
      }
    } catch (error) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(localizedAppError(error, context.l10n))),
        );
      }
    } finally {
      if (mounted) setState(() => _starting = false);
    }
  }

  Future<void> _pickImage() async {
    final file = await _picker.pickImage(source: ImageSource.gallery);
    if (file == null) return;
    final picked = await promptImageAttachmentFromXFile(file);
    if (!mounted) return;
    final attachment = picked.attachment;
    if (attachment == null) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            picked.failure == PromptImagePickFailure.tooLarge
                ? context.l10n.composerImageTooLarge
                : context.l10n.composerUnsupportedImage,
          ),
        ),
      );
      return;
    }
    setState(() {
      _attachments.add(attachment);
    });
  }

  Future<void> _submitClarification(
    ClarificationRequest request,
    List<List<String>> selections,
  ) async {
    if (_clarificationBusy) return;
    setState(() => _clarificationBusy = true);
    try {
      final v2 = ref.read(conversationV2SessionProvider(widget.threadId));
      if (v2.syncState != ConversationV2SyncState.uninitialized) {
        await ref
            .read(conversationV2SessionProvider(widget.threadId).notifier)
            .submitClarification(request.toolUseId, selections);
      } else {
        await ref
            .read(threadSessionProvider(widget.threadId).notifier)
            .submitClarification(request.toolUseId, selections);
      }
    } catch (error) {
      if (mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text(error.toString())));
      }
    } finally {
      if (mounted) {
        setState(() => _clarificationBusy = false);
      }
    }
  }

  Future<void> _dismissClarification(ClarificationRequest request) async {
    if (_clarificationBusy) return;
    setState(() => _clarificationBusy = true);
    try {
      final v2 = ref.read(conversationV2SessionProvider(widget.threadId));
      if (v2.syncState != ConversationV2SyncState.uninitialized) {
        await ref
            .read(conversationV2SessionProvider(widget.threadId).notifier)
            .dismissClarification(request.toolUseId);
      } else {
        await ref
            .read(threadSessionProvider(widget.threadId).notifier)
            .dismissClarification(request.toolUseId);
      }
    } catch (error) {
      if (mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text(error.toString())));
      }
    } finally {
      if (mounted) {
        setState(() => _clarificationBusy = false);
      }
    }
  }

  Future<void> _startEditingFollowUp(ThreadPendingFollowUp followUp) async {
    final rpc = ref.read(desktopRpcProvider);
    if (rpc == null) return;
    setState(() => _followUpBusy = true);
    try {
      await rpc.followUpSetEditing(
        threadId: followUp.threadId,
        followUpId: followUp.id,
      );
      if (!mounted) {
        await rpc.followUpSetEditing(threadId: followUp.threadId);
        return;
      }
      setState(() {
        _editingFollowUpId = followUp.id;
        _promptController.text = followUp.prompt;
        _attachments
          ..clear()
          ..addAll(followUp.attachments);
      });
    } catch (error) {
      if (mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text(error.toString())));
      }
    } finally {
      if (mounted) {
        setState(() => _followUpBusy = false);
      }
    }
  }

  Future<void> _cancelEditingFollowUp() async {
    final rpc = ref.read(desktopRpcProvider);
    if (_editingFollowUpId != null && rpc != null) {
      try {
        await rpc.followUpSetEditing(threadId: widget.threadId);
      } catch (error) {
        if (mounted) {
          ScaffoldMessenger.of(
            context,
          ).showSnackBar(SnackBar(content: Text(error.toString())));
        }
        rethrow;
      }
    }
    if (!mounted) return;
    setState(() {
      _editingFollowUpId = null;
      _promptController.clear();
      _attachments.clear();
    });
  }

  Future<void> _refreshFollowUps() async {
    await ref
        .read(threadSessionProvider(widget.threadId).notifier)
        .refreshPending();
  }

  Future<void> _reorderFollowUps(
    List<ThreadPendingFollowUp> followUps,
    int oldIndex,
    int newIndex,
  ) async {
    if (newIndex > oldIndex) newIndex -= 1;
    if (oldIndex == newIndex) return;
    final reordered = List<ThreadPendingFollowUp>.of(followUps);
    reordered.insert(newIndex, reordered.removeAt(oldIndex));
    final rpc = ref.read(desktopRpcProvider);
    if (rpc == null) return;
    try {
      await rpc.followUpReorder(
        threadId: widget.threadId,
        followUpIds: reordered.map((followUp) => followUp.id).toList(),
      );
      await _refreshFollowUps();
    } catch (error) {
      if (mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text(error.toString())));
      }
    }
  }

  Future<void> _deleteFollowUp(ThreadPendingFollowUp followUp) async {
    final rpc = ref.read(desktopRpcProvider);
    if (rpc == null) return;
    setState(() => _followUpCancelBusyId = followUp.id);
    try {
      await rpc.followUpCancel(
        threadId: widget.threadId,
        followUpId: followUp.id,
      );
      if (_editingFollowUpId == followUp.id) {
        await _cancelEditingFollowUp();
      }
      await _refreshFollowUps();
    } catch (error) {
      if (mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text(error.toString())));
      }
    } finally {
      if (mounted) {
        setState(() => _followUpCancelBusyId = null);
      }
    }
  }

  Future<void> _escalateFollowUp(ThreadPendingFollowUp followUp) async {
    final rpc = ref.read(desktopRpcProvider);
    if (rpc == null) return;
    // An already-escalated row is stuck while the queue is paused, so Guide there
    // means "send this one now" (mirrors canEscalateFollowUp).
    final queuePaused =
        ref
            .read(threadSessionProvider(widget.threadId))
            .thread
            ?.followUpQueuePaused ??
        false;
    if (followUp.priority == 'escalated' && !queuePaused) return;
    setState(() => _followUpEscalateBusyId = followUp.id);
    try {
      await rpc.followUpEscalate(
        threadId: widget.threadId,
        followUpId: followUp.id,
      );
      if (_editingFollowUpId == followUp.id) {
        await _cancelEditingFollowUp();
      }
      await _refreshFollowUps();
    } catch (error) {
      if (mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text(error.toString())));
      }
    } finally {
      if (mounted) {
        setState(() => _followUpEscalateBusyId = null);
      }
    }
  }

  Future<void> _toggleFollowUpQueuePaused(bool paused) async {
    final rpc = ref.read(desktopRpcProvider);
    if (rpc == null) return;
    setState(() => _followUpQueuePauseBusy = true);
    final session = ref.read(threadSessionProvider(widget.threadId).notifier);
    final pauseRevision = session.followUpQueuePauseRevision;
    try {
      final thread = await rpc.followUpSetQueuePaused(
        threadId: widget.threadId,
        paused: paused,
      );
      if (!mounted) return;
      session.applyFollowUpQueuePaused(
        thread.followUpQueuePaused,
        expectedRevision: pauseRevision,
      );
    } catch (error) {
      if (mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text(error.toString())));
      }
    } finally {
      if (mounted) {
        setState(() => _followUpQueuePauseBusy = false);
      }
    }
  }

  Future<void> _applyComposerRestore(
    ComposerRestore restore, {
    bool overwrite = false,
  }) async {
    if (!overwrite &&
        (_promptController.text.isNotEmpty || _attachments.isNotEmpty)) {
      if (_deferredComposerRestoreRevision != restore.revision) {
        setState(() => _deferredComposerRestoreRevision = restore.revision);
      }
      return;
    }
    setState(() {
      _deferredComposerRestoreRevision = null;
      _promptController.text = restore.prompt;
      _promptController.selection = TextSelection.collapsed(
        offset: _promptController.text.length,
      );
      _attachments
        ..clear()
        ..addAll(restore.attachments);
    });
    if (restore.reason?.trim().isNotEmpty == true) {
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text(restore.reason!.trim())));
    }
    try {
      await ref
          .read(threadSessionProvider(widget.threadId).notifier)
          .acknowledgeComposerRestore(restore.revision);
    } catch (error) {
      if (!mounted) return;
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text(error.toString())));
    }
  }

  Future<void> _sendMessage(ThreadRuntimeConfigInput runtimeConfig) async {
    final prompt = _promptController.text.trim();
    if (prompt.isEmpty && _attachments.isEmpty) return;
    if (_sendBusy || _followUpBusy) return;
    final rpc = ref.read(desktopRpcProvider);
    if (rpc == null) return;
    final thread = ref.read(threadSessionProvider(widget.threadId)).thread;
    final followUpMode = shouldComposerUseFollowUpQueue(
      status: _isSessionRunning(thread) ? 'running' : thread?.status,
      editingFollowUpId: _editingFollowUpId,
      followUpQueuePaused: thread?.followUpQueuePaused ?? false,
    );

    try {
      if (followUpMode) {
        setState(() => _followUpBusy = true);
        final stagedAttachments = _attachments.isEmpty
            ? null
            : await stagePromptImageAttachments(
                rpc: rpc,
                contextKey: composerDraftContextKey(threadId: widget.threadId),
                attachments: List.of(_attachments),
                onUpdate: (next) {
                  if (!mounted) return;
                  setState(() {
                    _attachments
                      ..clear()
                      ..addAll(next);
                  });
                },
              );
        if (_editingFollowUpId != null) {
          await rpc.followUpUpdate(
            threadId: widget.threadId,
            followUpId: _editingFollowUpId!,
            prompt: prompt,
            attachments: stagedAttachments,
          );
          await _cancelEditingFollowUp();
        } else {
          await rpc.followUpEnqueue(
            threadId: widget.threadId,
            prompt: prompt,
            attachments: stagedAttachments,
          );
          FocusManager.instance.primaryFocus?.unfocus();
          _promptController.clear();
          if (mounted) {
            setState(() => _attachments.clear());
          }
        }
        await _refreshFollowUps();
      } else {
        setState(() => _sendBusy = true);
        try {
          final sendRuntimeConfig = downgradeApprovalDependentFeatures(
            runtimeConfig,
          );
          if (sendRuntimeConfig.bashReviewMode !=
              runtimeConfig.bashReviewMode) {
            ref.read(runtimeConfigProvider.notifier).state = sendRuntimeConfig;
            if (mounted) {
              ScaffoldMessenger.of(context).showSnackBar(
                SnackBar(
                  content: Text(context.l10n.auxiliaryModelAutoReviewFallback),
                ),
              );
            }
          }
          final stagedAttachments = _attachments.isEmpty
              ? null
              : await stagePromptImageAttachments(
                  rpc: rpc,
                  contextKey: composerDraftContextKey(
                    threadId: widget.threadId,
                  ),
                  attachments: List.of(_attachments),
                  onUpdate: (next) {
                    if (!mounted) return;
                    setState(() {
                      _attachments
                        ..clear()
                        ..addAll(next);
                    });
                  },
                );
          final credentials = ref.read(credentialsProvider).valueOrNull;
          final v2Controller = ref.read(
            conversationV2SessionProvider(widget.threadId).notifier,
          );
          final principalId = credentials?.userId?.trim() ?? '';
          if (principalId.isEmpty || !v2Controller.enabled) {
            throw StateError(
              'Conversation V2 is unavailable; refusing legacy continuation.',
            );
          }
          await rpc.updateRuntimeConfig(
            threadId: widget.threadId,
            runtimeConfig: sendRuntimeConfig,
          );
          await v2Controller.sendMessage(
            principalId: principalId,
            text: prompt,
            attachments: stagedAttachments
                ?.map((attachment) => attachment.toWireJson())
                .toList(),
          );
          FocusManager.instance.primaryFocus?.unfocus();
          _promptController.clear();
          if (mounted) {
            setState(() => _attachments.clear());
          }
        } finally {
          if (mounted) {
            setState(() => _sendBusy = false);
          }
        }
      }
    } catch (error) {
      if (mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text(error.toString())));
      }
    } finally {
      if (mounted && followUpMode) {
        setState(() => _followUpBusy = false);
      }
    }
  }

  Future<void> _stopThread() async {
    final rpc = ref.read(desktopRpcProvider);
    if (rpc == null || _stopBusy) return;
    setState(() => _stopBusy = true);
    try {
      await rpc.cancelThread(widget.threadId);
      if (!mounted) return;
      final live = ref.read(threadSessionProvider(widget.threadId)).thread;
      if (live == null || (!live.cancelling && !_isSessionRunning(live))) {
        setState(() => _stopBusy = false);
      }
    } catch (error) {
      if (mounted) {
        setState(() => _stopBusy = false);
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text(error.toString())));
      }
    }
  }

  Future<void> _handlePlanApproval({required bool approve}) async {
    try {
      final v2 = ref.read(conversationV2SessionProvider(widget.threadId));
      if (v2.syncState != ConversationV2SyncState.uninitialized) {
        final notifier = ref.read(
          conversationV2SessionProvider(widget.threadId).notifier,
        );
        if (approve) {
          await notifier.approvePlan();
        } else {
          await notifier.dismissPlan();
        }
      } else {
        final notifier = ref.read(
          threadSessionProvider(widget.threadId).notifier,
        );
        if (approve) {
          await notifier.approvePlan();
        } else {
          await notifier.dismissPlan();
        }
      }
    } catch (error) {
      if (mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text(error.toString())));
      }
    }
  }
}

class _ThreadSessionFeedPane extends ConsumerWidget {
  const _ThreadSessionFeedPane({
    required this.threadId,
    required this.scrollController,
    required this.scrollCoordinator,
    required this.isRunning,
    required this.stopping,
    required this.feedBottomInset,
    required this.controlsBottomInset,
    this.onOpenImageDisplayArtifact,
  });

  final String threadId;
  final ScrollController scrollController;
  final ActivityFeedScrollCoordinator scrollCoordinator;
  final bool isRunning;
  final bool stopping;
  final double feedBottomInset;
  final double controlsBottomInset;
  final ValueChanged<String>? onOpenImageDisplayArtifact;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return Stack(
      clipBehavior: Clip.hardEdge,
      children: [
        _ActivityFeedView(
          threadId: threadId,
          scrollController: scrollController,
          scrollCoordinator: scrollCoordinator,
          isRunning: isRunning,
          stopping: stopping,
          feedBottomInset: feedBottomInset,
          controlsBottomInset: controlsBottomInset,
          onOpenImageDisplayArtifact: onOpenImageDisplayArtifact,
        ),
      ],
    );
  }
}

class _ActivityFeedView extends ConsumerWidget {
  const _ActivityFeedView({
    required this.threadId,
    required this.scrollController,
    required this.scrollCoordinator,
    required this.isRunning,
    required this.stopping,
    required this.feedBottomInset,
    required this.controlsBottomInset,
    this.onOpenImageDisplayArtifact,
  });

  final String threadId;
  final ScrollController scrollController;
  final ActivityFeedScrollCoordinator scrollCoordinator;
  final bool isRunning;
  final bool stopping;
  final double feedBottomInset;
  final double controlsBottomInset;
  final ValueChanged<String>? onOpenImageDisplayArtifact;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final threadPrompt = ref.watch(
      threadSessionProvider(threadId).select((state) => state.thread?.prompt),
    );
    final threadStatus = ref.watch(
      threadSessionProvider(threadId).select((state) => state.thread?.status),
    );
    final threadCoreKind = ref.watch(
      threadSessionProvider(threadId).select((state) => state.thread?.coreKind),
    );
    final conversationV2 = ref.watch(conversationV2SessionProvider(threadId));
    final modelSettings = ref.watch(modelSettingsProvider).valueOrNull;
    final runtimeConfig = ref.watch(
      threadSessionProvider(
        threadId,
      ).select((state) => state.thread?.runtimeConfig),
    );
    final snapshot = runtimeConfig == null
        ? null
        : resolveThreadOrchestrationSnapshot(modelSettings, runtimeConfig);
    final themeSource = SubagentThemeSource.fromSnapshot(snapshot);
    final thinkingDisplayMode = ref.watch(thinkingDisplayModeProvider);
    final v2Projection = buildConversationV2Projection(
      conversationId: threadId,
      messages: conversationV2.messages,
      runs: conversationV2.runs,
      tools: conversationV2.tools,
      agents: conversationV2.agents,
      projectionExtras: conversationV2.projectionExtras,
      hasEarlier: conversationV2.hasOlder,
      historyRevision: conversationV2.historyRevision,
    );
    // Once the V2 controller has started, its state owns the ordered message
    // window even when that window is empty or failed. Falling back based on
    // entry count would hide migration/sync failures behind the legacy
    // projection and could display stale or incomplete history as current.
    final feedEntries = buildActivityFeed(
      threadPrompt: threadPrompt,
      threadId: threadId,
      runProjection: v2Projection,
      subagentSessions:
          conversationV2.projectionExtras?.subagentTimings ?? const [],
      l10n: context.l10n,
      thinkingDisplayMode: thinkingDisplayMode,
      conversationLive: isRunning,
    );
    final displayFeedEntries = resolveThreadSessionDisplayFeedEntries(
      feedEntries: feedEntries,
      threadId: threadId,
      threadPrompt: threadPrompt,
      isRunning: isRunning,
    );

    if (displayFeedEntries.isEmpty) {
      final emptyStateText = conversationV2.error != null
          ? localizedAppError(conversationV2.error!, context.l10n)
          : isRunning
          ? (stopping
                ? context.l10n.threadStopping
                : context.l10n.threadProjectionLoading)
          : context.l10n.threadProjectionUnavailable;
      return Center(
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 24),
          child: Text(
            emptyStateText,
            style: Theme.of(context).textTheme.bodyMedium?.copyWith(
              color: ecoColors(context).textMuted,
            ),
            textAlign: TextAlign.center,
          ),
        ),
      );
    }

    return ActivityFeedAutoReadListener(
      threadId: threadId,
      running: isRunning,
      ready: conversationV2.syncState == ConversationV2SyncState.live,
      entries: displayFeedEntries,
      child: ActivityFeedList(
        entries: displayFeedEntries,
        scrollController: scrollController,
        scrollCoordinator: scrollCoordinator,
        themeSource: themeSource,
        thinkingDefaultExpanded: thinkingDisplayMode.defaultExpanded,
        stopping: stopping,
        showMessageCopyAndTime: isThreadStoppedForMessageMeta(
          isRunning ? 'running' : (threadStatus ?? 'idle'),
        ),
        scrollJumpBottomInset: controlsBottomInset,
        padding: EdgeInsets.fromLTRB(
          threadSessionFeedHorizontalPadding,
          sessionContentTopPadding(context),
          threadSessionFeedHorizontalPadding,
          feedBottomInset,
        ),
        onOpenAgentDetail: (entry) => unawaited(
          _openConversationV2AgentDetail(context, ref, threadId, entry),
        ),
        loadToolDetail: (entry) =>
            _loadConversationV2ToolDetail(context, ref, threadId, entry),
        loadToolDetailPage: (entry, {String? cursor}) =>
            _loadConversationV2ToolDetailPage(
              context,
              ref,
              threadId,
              entry,
              cursor: cursor,
            ),
        loadTurnDetail: (entry) =>
            _loadConversationV2TurnDetail(ref, threadId, entry),
        loadImageView: (entry) => _loadImageViewForEntry(ref, entry),
        onOpenImageDisplayArtifact: onOpenImageDisplayArtifact,
        onLoadUserMessageEdit: (activityLineId) async {
          final rpc = ref.read(desktopRpcProvider);
          if (rpc == null) {
            throw const AppErrorCodeException(
              AppErrorCode.threadProjectionNoPcSelected,
            );
          }
          return rpc.getUserMessageEdit(
            threadId: threadId,
            activityLineId: activityLineId,
          );
        },
        onRewriteUserMessage:
            ({
              required activityLineId,
              required prompt,
              required attachments,
              required expectedHistoryRevision,
            }) async {
              final rpc = ref.read(desktopRpcProvider);
              if (rpc == null) {
                throw const AppErrorCodeException(
                  AppErrorCode.threadProjectionNoPcSelected,
                );
              }
              final staged = attachments.isEmpty
                  ? attachments
                  : await stagePromptImageAttachments(
                      rpc: rpc,
                      contextKey: composerDraftContextKey(threadId: threadId),
                      attachments: attachments,
                      onUpdate: (_) {},
                    );
              final principalId = ref
                  .read(credentialsProvider)
                  .valueOrNull
                  ?.userId
                  ?.trim();
              if (principalId == null || principalId.isEmpty) {
                throw StateError(
                  'A signed-in principal is required to rewrite conversation history.',
                );
              }
              final wireAttachments = staged
                  .map((attachment) => attachment.toWireJson())
                  .toList();
              final thread = await rpc.rewriteThreadFromMessage(
                principalId: principalId,
                clientCommandId:
                    'history_rewrite_${conversationV2StableHash({'threadId': threadId, 'activityLineId': activityLineId, 'prompt': prompt, 'attachments': wireAttachments, 'expectedHistoryRevision': expectedHistoryRevision})}',
                threadId: threadId,
                activityLineId: activityLineId,
                prompt: prompt,
                attachments: staged,
                expectedHistoryRevision: expectedHistoryRevision,
              );
              await ref
                  .read(threadSessionProvider(threadId).notifier)
                  .acceptRewrittenThread(thread);
            },
        onRetryFailedRequest:
            _mobileSupportsOneClickRequestRetry(
                  threadCoreKind,
                  displayFeedEntries,
                ) &&
                displayFeedEntries.any(
                  (entry) => entry.kind == ActivityFeedKind.user,
                )
            ? (entry) async {
                final user = _latestRetryUserPrompt(displayFeedEntries, entry);
                if (user == null || user.text.trim().isEmpty) {
                  throw StateError('找不到可重试的用户消息。');
                }
                final rpc = ref.read(desktopRpcProvider);
                if (rpc == null) {
                  throw const AppErrorCodeException(
                    AppErrorCode.threadProjectionNoPcSelected,
                  );
                }
                final principalId = ref
                    .read(credentialsProvider)
                    .valueOrNull
                    ?.userId
                    ?.trim();
                if (principalId == null || principalId.isEmpty) {
                  throw StateError(
                    'A signed-in principal is required to retry a conversation request.',
                  );
                }
                final activityLineId = user.activityLineId?.trim();
                final prompt = user.text.trim();
                final hasImages = user.attachments.isNotEmpty;
                final expectedHistoryRevision = conversationV2.historyRevision;
                if (threadCoreKind == 'claude') {
                  final rewindTarget = user.rewindTarget;
                  final userMessageId = rewindTarget?.userMessageId?.trim();
                  if (rewindTarget == null ||
                      rewindTarget.activityLineId.trim().isEmpty ||
                      userMessageId == null ||
                      userMessageId.isEmpty) {
                    throw StateError('Claude 重试缺少可验证的 provider userMessageId。');
                  }
                  final staged = user.attachments.isEmpty
                      ? user.attachments
                      : await stagePromptImageAttachments(
                          rpc: rpc,
                          contextKey: composerDraftContextKey(
                            threadId: threadId,
                          ),
                          attachments: user.attachments,
                          onUpdate: (_) {},
                        );
                  final wireAttachments = staged
                      .map((attachment) => attachment.toWireJson())
                      .toList();
                  final thread = await rpc.rewriteThreadFromMessage(
                    principalId: principalId,
                    clientCommandId:
                        'history_rewrite_${conversationV2StableHash({'threadId': threadId, 'activityLineId': rewindTarget.activityLineId, 'userMessageId': userMessageId, 'prompt': prompt, 'attachments': wireAttachments, 'expectedHistoryRevision': expectedHistoryRevision})}',
                    threadId: threadId,
                    activityLineId: rewindTarget.activityLineId,
                    prompt: prompt,
                    attachments: staged,
                    expectedHistoryRevision: expectedHistoryRevision,
                  );
                  await ref
                      .read(threadSessionProvider(threadId).notifier)
                      .acceptRewrittenThread(thread);
                  return;
                }
                final thread = await rpc.retryThreadFromMessage(
                  principalId: principalId,
                  clientCommandId:
                      'history_retry_${conversationV2StableHash({'threadId': threadId, 'activityLineId': activityLineId, 'prompt': prompt, 'hasImages': hasImages, 'expectedHistoryRevision': expectedHistoryRevision})}',
                  threadId: threadId,
                  activityLineId: activityLineId,
                  prompt: prompt,
                  hasImages: hasImages,
                  expectedHistoryRevision: expectedHistoryRevision,
                );
                await ref
                    .read(threadSessionProvider(threadId).notifier)
                    .acceptRetriedThread(thread);
              }
            : null,
        hasEarlier: conversationV2.hasOlder,
        onLoadEarlier: () => ref
            .read(conversationV2SessionProvider(threadId).notifier)
            .loadOlder(),
      ),
    );
  }
}

bool _mobileSupportsOneClickRequestRetry(
  String? coreKind,
  List<ActivityFeedEntry> entries,
) {
  if (coreKind == 'acp' || coreKind == 'codex') return true;
  if (coreKind != 'claude') return false;
  final userEntries = entries
      .where((entry) => entry.kind == ActivityFeedKind.user)
      .toList(growable: false);
  return userEntries.isNotEmpty &&
      userEntries.every((entry) {
        final target = entry.rewindTarget;
        return target != null &&
            target.activityLineId.trim().isNotEmpty &&
            target.userMessageId?.trim().isNotEmpty == true;
      });
}

ActivityFeedEntry? _latestRetryUserPrompt(
  List<ActivityFeedEntry> entries,
  ActivityFeedEntry failure,
) {
  ActivityFeedEntry? latest;
  final failureSequence = failure.sequence;
  for (final entry in entries) {
    if (entry.kind != ActivityFeedKind.user) continue;
    if (failureSequence > 0 && entry.sequence > failureSequence) continue;
    latest = entry;
  }
  if (latest != null) return latest;
  for (final entry in entries.reversed) {
    if (entry.kind == ActivityFeedKind.user) return entry;
  }
  return null;
}

Future<void> _openConversationV2AgentDetail(
  BuildContext context,
  WidgetRef ref,
  String threadId,
  ActivityFeedEntry entry,
) async {
  final agentId = entry.agentId?.trim();
  final runId = entry.runAttemptId?.trim();
  if (agentId == null || agentId.isEmpty || runId == null || runId.isEmpty) {
    return;
  }
  final future = ref
      .read(conversationV2SessionProvider(threadId).notifier)
      .loadAllDetails(runId, agentId: agentId);
  if (!context.mounted) return;
  await showEcoModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    enableDrag: false,
    backgroundColor: Colors.transparent,
    builder: (context) => _ConversationV2AgentDetailSheet(
      threadId: threadId,
      agentId: agentId,
      runId: runId,
      title: entry.taskName ?? entry.subagentRole ?? agentId,
      future: future,
    ),
  );
}

Future<void> _loadConversationV2TurnDetail(
  WidgetRef ref,
  String threadId,
  ActivityFeedEntry entry,
) async {
  final runId = entry.runAttemptId?.trim();
  if (runId == null || runId.isEmpty) return;
  // Turn rows already contain the V2 tool summaries. Fetching the bounded
  // detail page here warms the cache for the child disclosures without
  // reviving the legacy projection as a second source of truth.
  await ref
      .read(conversationV2SessionProvider(threadId).notifier)
      .loadDetails(runId);
}

class _ConversationV2AgentDetailSheet extends StatefulWidget {
  const _ConversationV2AgentDetailSheet({
    required this.threadId,
    required this.agentId,
    required this.runId,
    required this.title,
    required this.future,
  });

  final String threadId;
  final String agentId;
  final String runId;
  final String title;
  final Future<ConversationV2DetailPage> future;

  @override
  State<_ConversationV2AgentDetailSheet> createState() =>
      _ConversationV2AgentDetailSheetState();
}

class _ConversationV2AgentDetailSheetState
    extends State<_ConversationV2AgentDetailSheet> {
  final _scrollController = ScrollController();
  late final _scrollCoordinator = ActivityFeedScrollCoordinator(
    _scrollController,
  );

  @override
  void dispose() {
    _scrollController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Align(
      alignment: Alignment.bottomCenter,
      child: ConstrainedBox(
        constraints: BoxConstraints(
          maxHeight: MediaQuery.sizeOf(context).height * 0.82,
        ),
        child: ClipRRect(
          borderRadius: const BorderRadius.vertical(top: Radius.circular(16)),
          child: ColoredBox(
            color: ecoColors(context).bgFeed,
            child: Padding(
              padding: EdgeInsets.only(
                bottom: MediaQuery.viewPaddingOf(context).bottom + 8,
              ),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  ListTile(
                    leading: Icon(
                      EcoIcons.agent,
                      color: ecoColors(context).textSecondary,
                    ),
                    title: Text(widget.title),
                    trailing: IconButton(
                      tooltip: context.l10n.commonClose,
                      icon: Icon(
                        Icons.close_rounded,
                        color: ecoColors(context).textMuted,
                      ),
                      onPressed: () => Navigator.of(context).maybePop(),
                    ),
                  ),
                  Divider(height: 1, color: ecoColors(context).borderSubtle),
                  Expanded(
                    child: FutureBuilder<ConversationV2DetailPage>(
                      future: widget.future,
                      builder: (context, snapshot) {
                        if (snapshot.connectionState != ConnectionState.done) {
                          return const Center(
                            child: CircularProgressIndicator(),
                          );
                        }
                        if (snapshot.hasError) {
                          return Center(
                            child: Text(context.l10n.threadDetailsFailed),
                          );
                        }
                        final page = snapshot.data;
                        if (page == null) {
                          return Center(
                            child: Text(context.l10n.threadNoDetailsResponse),
                          );
                        }
                        final entries = buildConversationV2ToolDetailFeed(
                          page,
                          runId: widget.runId,
                        );
                        if (entries.isEmpty) {
                          return Center(
                            child: Text(context.l10n.threadZeroDetails),
                          );
                        }
                        return ActivityFeedList(
                          entries: entries,
                          scrollController: _scrollController,
                          scrollCoordinator: _scrollCoordinator,
                          padding: const EdgeInsets.fromLTRB(16, 8, 16, 16),
                          showScrollJumpButton: false,
                          showMessageCopyAndTime: false,
                        );
                      },
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

Future<ImageViewReadData> _loadImageViewForEntry(
  WidgetRef ref,
  ActivityFeedEntry entry,
) {
  final imageView = entry.imageView;
  final path = imageView?.path.trim();
  if (path == null || path.isEmpty) {
    return Future.error(
      const ImageViewReadException(ImageViewReadFailureCode.invalidResponse),
    );
  }
  final rpc = ref.read(desktopRpcProvider);
  if (rpc == null) {
    return Future.error(
      const ImageViewReadException(ImageViewReadFailureCode.bridgeUnavailable),
    );
  }
  if (path.startsWith('artifact:')) {
    return rpc.readImageDisplay(path.substring('artifact:'.length));
  }
  return rpc.readImageView(path);
}

Future<List<ActivityFeedEntry>> _loadConversationV2ToolDetail(
  BuildContext context,
  WidgetRef ref,
  String threadId,
  ActivityFeedEntry entry,
) async {
  final runId = entry.runAttemptId?.trim();
  final toolCallId = entry.toolUseId?.trim();
  if (runId == null ||
      runId.isEmpty ||
      toolCallId == null ||
      toolCallId.isEmpty) {
    return const [];
  }
  final page = await ref
      .read(conversationV2SessionProvider(threadId).notifier)
      .loadDetails(runId, toolCallId: toolCallId);
  if (!context.mounted) return const [];
  return buildConversationV2ToolDetailFeed(
    page,
    runId: runId,
    toolCallId: toolCallId,
  );
}

Future<ActivityFeedToolDetailPage> _loadConversationV2ToolDetailPage(
  BuildContext context,
  WidgetRef ref,
  String threadId,
  ActivityFeedEntry entry, {
  String? cursor,
}) async {
  final runId = entry.runAttemptId?.trim();
  final toolCallId = entry.toolUseId?.trim();
  if (runId == null ||
      runId.isEmpty ||
      toolCallId == null ||
      toolCallId.isEmpty) {
    return const ActivityFeedToolDetailPage(entries: [], hasMore: false);
  }
  final page = await ref
      .read(conversationV2SessionProvider(threadId).notifier)
      .loadDetails(runId, cursor: cursor, toolCallId: toolCallId);
  if (!context.mounted) {
    return const ActivityFeedToolDetailPage(entries: [], hasMore: false);
  }
  return ActivityFeedToolDetailPage(
    entries: buildConversationV2ToolDetailFeed(
      page,
      runId: runId,
      toolCallId: toolCallId,
    ),
    nextCursor: page.nextCursor,
    hasMore: page.hasMore,
  );
}
