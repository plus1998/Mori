import 'dart:async';
import 'dart:convert';
import 'dart:ui';

import 'package:adaptive_platform_ui/adaptive_platform_ui.dart';
import 'package:flutter/material.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:uuid/uuid.dart';

import '../../core/locale/app_localizations_ext.dart';
import '../../core/locale/app_error_localizations.dart';
import '../../core/models/asr_models.dart';
import '../../core/models/scheduling_models.dart';
import '../../core/models/thread_models.dart';
import '../../core/models/acp_host_ui_features.dart';
import '../../core/models/thread_runtime_config.dart';
import '../../core/models/thread_usage_models.dart';
import '../../core/platform/mobile_asr_service.dart';
import '../../core/theme/eco_icons.dart';
import '../../core/theme/eco_theme.dart';
import '../../core/utils/speech_text.dart';
import '../../core/widgets/image_memory_lightbox.dart';
import 'composer_controls.dart';
import 'composer_plus_menu.dart';
import 'composer_toolbar_icon.dart';
import 'ios_composer_send_button.dart';
import '../threads/thread_providers.dart';
import '../scheduling/schedule_editor.dart';
import 'voice_recording_composer.dart';

bool shouldCancelMobileAsrOnDispose({
  required bool speechBusy,
  required bool speechFinishing,
}) {
  return speechBusy || speechFinishing;
}

class SessionComposer extends ConsumerStatefulWidget {
  const SessionComposer({
    super.key,
    required this.controller,
    required this.attachments,
    required this.runtimeConfig,
    required this.threadId,
    required this.isRunning,
    this.canStopThread = false,
    this.followUpMode = false,
    this.sendBusy = false,
    this.stopBusy = false,
    required this.hasActivity,
    required this.onPickImage,
    required this.onRemoveAttachment,
    required this.onSend,
    this.onSendWithMode,
    required this.onStop,
    required this.onRuntimeConfigChanged,
    this.inputHint,
    this.recoveryNotice,
    this.onRestoreDraft,
    this.billing,
    this.contextSnapshot,
    this.threadStatus,
    this.workspacePath = '',
    this.coreKind,
    this.onCoreKindChanged,
    this.hostUiFeatures = AcpHostUiFeatures.showAll,
    this.onScheduledThreadCreated,
  });

  final TextEditingController controller;
  final List<PromptImageAttachment> attachments;
  final ThreadRuntimeConfigInput runtimeConfig;
  final String threadId;
  final bool isRunning;
  final bool canStopThread;
  final bool followUpMode;
  final bool sendBusy;
  final bool stopBusy;
  final bool hasActivity;
  final VoidCallback onPickImage;
  final void Function(int index) onRemoveAttachment;
  final VoidCallback onSend;
  final ValueChanged<FollowUpDeliveryMode>? onSendWithMode;
  final VoidCallback onStop;
  final ValueChanged<ThreadRuntimeConfigInput> onRuntimeConfigChanged;
  final String? inputHint;
  final String? recoveryNotice;
  final VoidCallback? onRestoreDraft;
  final ThreadBillingSnapshot? billing;
  final ThreadContextSnapshot? contextSnapshot;
  final String? threadStatus;
  final String workspacePath;
  final String? coreKind;
  final ValueChanged<String>? onCoreKindChanged;
  final AcpHostUiFeatures hostUiFeatures;
  final ValueChanged<String>? onScheduledThreadCreated;

  @override
  ConsumerState<SessionComposer> createState() => _SessionComposerState();
}

class _SessionComposerState extends ConsumerState<SessionComposer> {
  final _focusNode = FocusNode();
  final _composerCardKey = GlobalKey();
  ComposerPlusMenuRoute? _plusMenuRoute;
  bool _speechBusy = false;
  bool _speechFinishing = false;
  bool _discardSpeechResult = false;
  double _speechAudioLevel = 0;
  StreamSubscription<double>? _speechLevelSubscription;
  MobileAsrService? _speechRecorder;

  @override
  void initState() {
    super.initState();
    widget.controller.addListener(_handleControllerChanged);
  }

  @override
  void didUpdateWidget(covariant SessionComposer oldWidget) {
    super.didUpdateWidget(oldWidget);
    _plusMenuRoute?.refresh();
    if (oldWidget.controller != widget.controller) {
      oldWidget.controller.removeListener(_handleControllerChanged);
      widget.controller.addListener(_handleControllerChanged);
    }
  }

  void _handleControllerChanged() {
    _plusMenuRoute?.refresh();
    setState(() {});
  }

  @override
  void dispose() {
    final route = _plusMenuRoute;
    if (route != null) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (route.isActive) route.navigator?.removeRoute(route);
      });
    }
    if (shouldCancelMobileAsrOnDispose(
      speechBusy: _speechBusy,
      speechFinishing: _speechFinishing,
    )) {
      unawaited(_speechRecorder?.cancel().catchError((_) {}));
    }
    unawaited(_speechLevelSubscription?.cancel());
    widget.controller.removeListener(_handleControllerChanged);
    _focusNode.dispose();
    super.dispose();
  }

  bool get _hasContent =>
      widget.controller.text.trim().isNotEmpty || widget.attachments.isNotEmpty;

  bool get _canSend {
    if (widget.sendBusy) {
      return false;
    }
    final modelSettings = ref.read(modelSettingsProvider).valueOrNull;
    if (!isThreadRuntimeConfigReady(
      modelSettings,
      widget.runtimeConfig,
      coreKind: widget.coreKind,
    )) {
      return false;
    }
    if (widget.followUpMode) {
      return _hasContent;
    }
    return !widget.isRunning && _hasContent;
  }

  void _handleSend() {
    if (!_canSend) return;
    _focusNode.unfocus();
    widget.onSend();
  }

  void _handleSendWithMode(FollowUpDeliveryMode mode) {
    if (!_canSend || widget.onSendWithMode == null) return;
    _focusNode.unfocus();
    widget.onSendWithMode?.call(mode);
  }

  Future<void> _togglePlusMenu() async {
    final existing = _plusMenuRoute;
    if (existing != null) {
      existing.close();
      return;
    }
    final route = ComposerPlusMenuRoute(
      anchorKey: _composerCardKey,
      dismissLabel: context.l10n.commonClose,
      reduceMotion: MediaQuery.disableAnimationsOf(context),
      builder: (context) => ComposerPlusMenuPanel(
        runtimeConfig: widget.runtimeConfig,
        threadId: widget.threadId,
        canEdit: !widget.isRunning,
        canEditStatelessModels: true,
        onChanged: widget.onRuntimeConfigChanged,
        workspacePath: widget.workspacePath,
        coreKind: widget.coreKind,
        onCoreKindChanged: widget.onCoreKindChanged,
        canSchedule: _canSchedule,
      ),
    );
    setState(() => _plusMenuRoute = route);
    final action = await Navigator.of(context).push(route);
    if (!mounted) return;
    setState(() => _plusMenuRoute = null);
    await route.completed;
    if (!mounted) return;
    switch (action) {
      case ComposerPlusMenuAction.plan:
      case ComposerPlusMenuAction.ask:
        if (widget.isRunning) return;
        final mode = action == ComposerPlusMenuAction.plan ? 'plan' : 'ask';
        await persistRuntimeConfig(
          ref,
          threadId: widget.threadId,
          previousConfig: widget.runtimeConfig,
          config: widget.runtimeConfig.copyWith(
            sessionMode: widget.runtimeConfig.sessionMode == mode
                ? 'agent'
                : mode,
          ),
          onChanged: widget.onRuntimeConfigChanged,
          reportFailure: true,
        );
      case ComposerPlusMenuAction.image:
        widget.onPickImage();
      case ComposerPlusMenuAction.schedule:
        await _handleSchedule();
      case null:
        break;
    }
  }

  Future<void> _handleSchedule() async {
    if (!_canSchedule) return;
    final draft = widget.controller.text;
    final images = List<PromptImageAttachment>.of(widget.attachments);
    final isNew = widget.threadId.isEmpty;
    final threadId = isNew ? 'thr_${const Uuid().v4()}' : widget.threadId;
    _focusNode.unfocus();
    final editor = showScheduleEditor(
      context,
      threadId: threadId,
      initialPrompt: draft,
      initialAttachments: images,
      newThread: isNew
          ? ScheduledMessageNewThread(
              workspacePath: widget.workspacePath,
              coreKind: widget.coreKind!,
              runtimeConfig: widget.runtimeConfig,
            )
          : null,
    );
    _clearScheduledDraft(draft, images);
    final saved = await editor;
    if (mounted && isNew && saved == true) {
      widget.onScheduledThreadCreated?.call(threadId);
    }
  }

  // Scheduling is independent of the active run; due messages join its queue.
  bool get _canSchedule =>
      !widget.sendBusy &&
      (widget.threadId.isNotEmpty ||
          (widget.workspacePath.trim().isNotEmpty &&
              widget.coreKind != null &&
              widget.onScheduledThreadCreated != null));

  void _clearScheduledDraft(String draft, List<PromptImageAttachment> images) {
    if (!mounted ||
        widget.controller.text != draft ||
        !listEquals(widget.attachments, images)) {
      return;
    }
    widget.controller.clear();
    for (var i = images.length - 1; i >= 0; i--) {
      widget.onRemoveAttachment(i);
    }
  }

  void _handleStop() {
    if (widget.stopBusy) return;
    _focusNode.unfocus();
    widget.onStop();
  }

  Future<void> _handleSpeechInput() async {
    final recorder = ref.read(mobileAsrServiceProvider);
    _speechRecorder = recorder;
    if (_speechBusy) return;

    _focusNode.unfocus();
    _discardSpeechResult = false;
    await _speechLevelSubscription?.cancel();
    _speechLevelSubscription = recorder.audioLevels.listen((level) {
      if (!mounted || !_speechBusy) return;
      setState(() => _speechAudioLevel = level);
    }, onError: (_) {});
    setState(() {
      _speechBusy = true;
      _speechFinishing = false;
      _speechAudioLevel = 0;
    });

    try {
      await recorder.start(
        onMaximumDuration: () =>
            _finishSpeechInput(discard: false, send: false),
      );
    } catch (error) {
      await recorder.cancel();
      await _speechLevelSubscription?.cancel();
      _speechLevelSubscription = null;
      if (!mounted) return;
      setState(() {
        _speechBusy = false;
        _speechAudioLevel = 0;
      });
      await _showSpeechError(error);
    }
  }

  Future<void> _finishSpeechInput({
    required bool discard,
    required bool send,
  }) async {
    if (!_speechBusy || _speechFinishing) return;
    setState(() {
      _speechFinishing = true;
      _discardSpeechResult = discard;
    });
    final recorder = _speechRecorder;
    if (recorder == null) return;
    var recognized = false;
    var shouldSend = false;
    Object? speechError;
    try {
      if (discard) {
        await recorder.cancel();
      } else {
        final text = await recorder.stopAndTranscribe();
        if (text.isEmpty) {
          throw const AsrServiceException('empty_response', '没有识别到语音内容');
        }
        if (!_discardSpeechResult && mounted) {
          final merged = mergeRecognizedSpeechText(
            currentText: widget.controller.text,
            selection: widget.controller.selection,
            recognizedText: text,
          );
          widget.controller.value = TextEditingValue(
            text: merged.text,
            selection: TextSelection.collapsed(offset: merged.selectionOffset),
          );
          recognized = true;
          shouldSend = send;
        }
      }
    } catch (error) {
      if (!discard) speechError = error;
    } finally {
      await _speechLevelSubscription?.cancel();
      _speechLevelSubscription = null;
      if (mounted) {
        setState(() {
          _speechBusy = false;
          _speechFinishing = false;
          _speechAudioLevel = 0;
        });
      }
    }
    if (speechError != null && mounted) {
      await _showSpeechError(speechError);
      return;
    }
    if (!mounted || !recognized) return;
    if (shouldSend) {
      _handleSend();
    } else {
      _focusNode.requestFocus();
    }
  }

  Future<void> _showSpeechError(Object error) {
    return showDialog<void>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: Text(context.l10n.composerVoiceInputFailed),
        content: Text(localizedAppError(error, context.l10n)),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(dialogContext),
            child: Text(context.l10n.commonClose),
          ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final canEditConfig = !widget.isRunning;
    final showSpeechInput =
        _speechBusy || ref.watch(desktopRpcProvider) != null;
    final asrModel = ref.watch(asrStatusProvider).valueOrNull?.model;
    if (_speechBusy) {
      return VoiceRecordingComposer(
        audioLevel: _speechAudioLevel,
        finishing: _speechFinishing,
        onCancel: () => _finishSpeechInput(discard: true, send: false),
        onStop: () => _finishSpeechInput(discard: false, send: false),
        onSend: () => _finishSpeechInput(discard: false, send: true),
      );
    }

    return SafeArea(
      top: false,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(8, 0, 8, 10),
        child: ClipRRect(
          key: _composerCardKey,
          borderRadius: BorderRadius.circular(24),
          child: BackdropFilter(
            filter: ImageFilter.blur(sigmaX: 22, sigmaY: 22),
            child: DecoratedBox(
              decoration: BoxDecoration(
                color: ecoColors(context).composerContextBg.withValues(
                  alpha: Theme.of(context).brightness == Brightness.dark
                      ? 0.78
                      : 0.72,
                ),
                borderRadius: BorderRadius.circular(24),
                border: Border.all(
                  width: 0.5,
                  color: Theme.of(context).brightness == Brightness.dark
                      ? ecoColors(context).borderSubtle.withValues(alpha: 0.45)
                      : const Color(0x143C3C43), // ~8% — hairline only
                ),
                boxShadow: [
                  BoxShadow(
                    color: ecoColors(context).shadowScrim.withValues(
                      alpha: Theme.of(context).brightness == Brightness.dark
                          ? 0.35
                          : 0.04,
                    ),
                    blurRadius: Theme.of(context).brightness == Brightness.dark
                        ? 24
                        : 16,
                    offset: const Offset(0, 6),
                  ),
                ],
              ),
              child: Padding(
                padding: const EdgeInsets.fromLTRB(4, 14, 4, 12),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    if (widget.onRestoreDraft != null)
                      Padding(
                        padding: const EdgeInsets.fromLTRB(8, 0, 8, 10),
                        child: DecoratedBox(
                          decoration: BoxDecoration(
                            color: ecoColors(context).dangerSoft,
                            borderRadius: BorderRadius.circular(14),
                            border: Border.all(
                              color: ecoColors(
                                context,
                              ).danger.withValues(alpha: 0.24),
                            ),
                          ),
                          child: Padding(
                            padding: const EdgeInsets.fromLTRB(12, 8, 8, 8),
                            child: Row(
                              children: [
                                Expanded(
                                  child: Text(
                                    widget.recoveryNotice?.trim().isNotEmpty ==
                                            true
                                        ? widget.recoveryNotice!.trim()
                                        : context
                                              .l10n
                                              .composerDraftRecoveryPending,
                                    maxLines: 2,
                                    overflow: TextOverflow.ellipsis,
                                    style: TextStyle(
                                      color: ecoColors(context).danger,
                                      fontSize: 13,
                                      height: 1.3,
                                    ),
                                  ),
                                ),
                                TextButton(
                                  onPressed: widget.onRestoreDraft,
                                  child: Text(
                                    context.l10n.composerRestoreDraft,
                                  ),
                                ),
                              ],
                            ),
                          ),
                        ),
                      ),
                    if (widget.attachments.isNotEmpty)
                      Padding(
                        padding: const EdgeInsets.fromLTRB(8, 0, 8, 12),
                        child: SizedBox(
                          height: 72,
                          child: ListView.separated(
                            scrollDirection: Axis.horizontal,
                            itemCount: widget.attachments.length,
                            separatorBuilder: (_, _) =>
                                const SizedBox(width: 8),
                            itemBuilder: (context, index) =>
                                _PendingImagePreview(
                                  attachment: widget.attachments[index],
                                  index: index,
                                  attachments: widget.attachments,
                                  onRemove: () =>
                                      widget.onRemoveAttachment(index),
                                ),
                          ),
                        ),
                      ),
                    Padding(
                      padding: const EdgeInsets.symmetric(horizontal: 8),
                      child: TextField(
                        controller: widget.controller,
                        focusNode: _focusNode,
                        minLines: 1,
                        maxLines: 6,
                        textInputAction: TextInputAction.send,
                        onSubmitted: _canSend ? (_) => _handleSend() : null,
                        decoration: InputDecoration(
                          hintText:
                              widget.inputHint ??
                              (widget.followUpMode
                                  ? context.l10n.composerRequestChanges
                                  : (widget.hasActivity
                                        ? context.l10n.composerFollowUp
                                        : context.l10n.composerSendHint)),
                          filled: false,
                          fillColor: Colors.transparent,
                          border: InputBorder.none,
                          enabledBorder: InputBorder.none,
                          focusedBorder: InputBorder.none,
                          disabledBorder: InputBorder.none,
                          errorBorder: InputBorder.none,
                          focusedErrorBorder: InputBorder.none,
                          isDense: true,
                          contentPadding: EdgeInsets.zero,
                          hintStyle: TextStyle(
                            color: ecoColors(context).textMuted,
                            fontSize: 17,
                            letterSpacing: -0.2,
                          ),
                        ),
                        style: TextStyle(
                          fontSize: 17,
                          height: 1.35,
                          letterSpacing: -0.2,
                          color: ecoColors(context).textHeading,
                          backgroundColor: Colors.transparent,
                        ),
                      ),
                    ),
                    const SizedBox(height: 10),
                    Row(
                      crossAxisAlignment: CrossAxisAlignment.center,
                      children: [
                        ComposerToolbarIconButton(
                          onPressed: _togglePlusMenu,
                          tooltip: context.l10n.composerPlusMenu,
                          icon: AnimatedRotation(
                            turns: _plusMenuRoute == null ? 0 : 0.125,
                            duration: Duration(
                              milliseconds:
                                  MediaQuery.disableAnimationsOf(context)
                                  ? 0
                                  : 200,
                            ),
                            child: ComposerToolbarIcon(
                              icon: EcoIcons.add,
                              color: ecoColors(context).textSecondary,
                            ),
                          ),
                        ),
                        if (widget.runtimeConfig.sessionMode == 'plan' ||
                            widget.runtimeConfig.sessionMode == 'ask')
                          ComposerSessionModeTag(
                            mode: widget.runtimeConfig.sessionMode,
                            onClose: !canEditConfig
                                ? null
                                : () => persistRuntimeConfig(
                                    ref,
                                    threadId: widget.threadId,
                                    config: widget.runtimeConfig.copyWith(
                                      sessionMode: 'agent',
                                    ),
                                    onChanged: widget.onRuntimeConfigChanged,
                                  ),
                          ),
                        ComposerBashReviewIconButton(
                          runtimeConfig: widget.runtimeConfig,
                          threadId: widget.threadId,
                          onChanged: widget.onRuntimeConfigChanged,
                        ),
                        Expanded(
                          child: Align(
                            alignment: Alignment.centerRight,
                            child: ComposerRouteSummary(
                              runtimeConfig: widget.runtimeConfig,
                              threadId: widget.threadId,
                              canEdit: canEditConfig,
                              onChanged: widget.onRuntimeConfigChanged,
                              billing: widget.billing,
                              contextSnapshot: widget.contextSnapshot,
                              threadStatus: widget.threadStatus,
                              workspacePath: widget.workspacePath,
                              coreKind: widget.coreKind,
                              hostUiFeatures: widget.hostUiFeatures,
                            ),
                          ),
                        ),
                        if (showSpeechInput) ...[
                          ComposerToolbarIconButton(
                            onPressed: _handleSpeechInput,
                            tooltip: _speechBusy
                                ? context.l10n.composerStopVoiceInput
                                : (asrModel?.isNotEmpty == true
                                      ? asrModel!
                                      : context.l10n.composerVoiceInput),
                            color: _speechBusy
                                ? ecoColors(context).accent
                                : null,
                            icon: ComposerToolbarIcon(
                              icon: _speechBusy ? EcoIcons.stop : EcoIcons.mic,
                              color: _speechBusy
                                  ? ecoColors(context).accent
                                  : ecoColors(context).textSecondary,
                            ),
                          ),
                        ],
                        if (widget.followUpMode)
                          _hasContent
                              ? _SendButton(
                                  busy: widget.sendBusy,
                                  onSend: _canSend ? _handleSend : null,
                                  onSchedule: _canSchedule
                                      ? _handleSchedule
                                      : null,
                                  onSendWithMode: widget.onSendWithMode != null
                                      ? _handleSendWithMode
                                      : null,
                                )
                              : _StopButton(
                                  busy: widget.stopBusy,
                                  onStop: _handleStop,
                                )
                        else if (widget.isRunning || widget.canStopThread)
                          _StopButton(
                            busy: widget.stopBusy,
                            onStop: _handleStop,
                          )
                        else
                          _SendButton(
                            busy: widget.sendBusy,
                            onSend: _canSend ? _handleSend : null,
                            onSchedule: _canSchedule ? _handleSchedule : null,
                          ),
                      ],
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _PendingImagePreview extends StatelessWidget {
  const _PendingImagePreview({
    required this.attachment,
    required this.index,
    required this.attachments,
    required this.onRemove,
  });

  final PromptImageAttachment attachment;
  final int index;
  final List<PromptImageAttachment> attachments;
  final VoidCallback onRemove;

  Future<void> _openPreview(BuildContext context) async {
    final images = <Uint8List>[];
    final indexes = <int>[];
    for (var i = 0; i < attachments.length; i++) {
      try {
        images.add(base64Decode(attachments[i].data));
        indexes.add(i);
      } on FormatException {
        // Skip undecodable thumbnails.
      }
    }
    if (images.isEmpty) return;
    final start = indexes.indexOf(index).clamp(0, images.length - 1);
    await showImageMemoryLightbox(context, images: images, initialIndex: start);
  }

  @override
  Widget build(BuildContext context) {
    final eco = ecoColors(context);
    return Semantics(
      button: true,
      label: context.l10n.composerPendingImage(index + 1),
      child: SizedBox.square(
        dimension: 72,
        child: Stack(
          children: [
            Positioned.fill(
              child: Material(
                color: Colors.transparent,
                child: InkWell(
                  onTap: () => _openPreview(context),
                  borderRadius: BorderRadius.circular(12),
                  child: ClipRRect(
                    borderRadius: BorderRadius.circular(12),
                    child: DecoratedBox(
                      decoration: BoxDecoration(
                        color: eco.composerPillBg,
                        border: Border.all(
                          width: 0.5,
                          color: eco.composerPillBorder.withValues(alpha: 0.5),
                        ),
                      ),
                      child: Image.memory(
                        base64Decode(attachment.data),
                        fit: BoxFit.cover,
                        gaplessPlayback: true,
                        filterQuality: FilterQuality.medium,
                        errorBuilder: (_, _, _) => const Center(
                          child: Icon(Icons.broken_image_outlined),
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            ),
            if (attachment.uploadProgress != null || attachment.uploadFailed)
              Positioned.fill(
                child: IgnorePointer(
                  child: DecoratedBox(
                    decoration: BoxDecoration(
                      color: Colors.black.withValues(alpha: 0.45),
                      borderRadius: BorderRadius.circular(12),
                    ),
                    child: Center(
                      child: attachment.uploadFailed
                          ? Icon(
                              Icons.refresh,
                              size: 20,
                              color: Colors.white.withValues(alpha: 0.95),
                            )
                          : Column(
                              mainAxisSize: MainAxisSize.min,
                              children: [
                                SizedBox(
                                  width: 28,
                                  height: 28,
                                  child: CircularProgressIndicator(
                                    value: attachment.uploadProgress,
                                    strokeWidth: 2.5,
                                    color: Colors.white,
                                    backgroundColor: Colors.white24,
                                  ),
                                ),
                                const SizedBox(height: 4),
                                Text(
                                  '${((attachment.uploadProgress ?? 0) * 100).clamp(0, 100).round()}%',
                                  style: const TextStyle(
                                    color: Colors.white,
                                    fontSize: 11,
                                    fontWeight: FontWeight.w600,
                                  ),
                                ),
                              ],
                            ),
                    ),
                  ),
                ),
              ),
            Positioned(
              top: 4,
              right: 4,
              child: Semantics(
                button: true,
                label: context.l10n.composerRemoveImage(index + 1),
                child: Material(
                  color: Colors.black.withValues(alpha: 0.62),
                  shape: const CircleBorder(),
                  clipBehavior: Clip.antiAlias,
                  child: InkWell(
                    onTap: onRemove,
                    customBorder: const CircleBorder(),
                    child: const SizedBox.square(
                      dimension: 24,
                      child: Icon(
                        EcoIcons.close,
                        size: 14,
                        color: Colors.white,
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _SendButton extends StatelessWidget {
  const _SendButton({
    required this.busy,
    required this.onSend,
    this.onSendWithMode,
    this.onSchedule,
  });

  final bool busy;
  final VoidCallback? onSend;
  final ValueChanged<FollowUpDeliveryMode>? onSendWithMode;
  final VoidCallback? onSchedule;

  Future<void> _chooseMode(BuildContext context) async {
    if (busy ||
        (onSchedule == null && (onSend == null || onSendWithMode == null))) {
      return;
    }
    HapticFeedback.selectionClick();
    final box = context.findRenderObject() as RenderBox;
    final overlay = Overlay.of(context).context.findRenderObject() as RenderBox;
    final rect = box.localToGlobal(Offset.zero, ancestor: overlay) & box.size;
    final mode = await showMenu<String>(
      context: context,
      position: RelativeRect.fromRect(rect, Offset.zero & overlay.size),
      items: [
        if (onSend != null && onSendWithMode != null)
          PopupMenuItem(
            value: 'queue',
            child: Text(context.l10n.composerSendQueue),
          ),
        if (onSend != null && onSendWithMode != null)
          PopupMenuItem(
            value: 'steer',
            child: Text(context.l10n.composerSendSteer),
          ),
        if (onSchedule != null)
          PopupMenuItem(
            value: 'schedule',
            child: Text(context.l10n.composerSendScheduled),
          ),
      ],
    );
    if (!context.mounted) return;
    switch (mode) {
      case 'queue':
        onSendWithMode?.call(FollowUpDeliveryMode.queue);
      case 'steer':
        onSendWithMode?.call(FollowUpDeliveryMode.steer);
      case 'schedule':
        onSchedule?.call();
    }
  }

  @override
  Widget build(BuildContext context) {
    final colors = ecoColors(context);
    final enabled = onSend != null;
    final showBusy = busy && !enabled;
    if (PlatformInfo.isIOS && (onSendWithMode != null || onSchedule != null)) {
      return IOSComposerSendButton(
        size: kComposerToolbarHitSize,
        busy: showBusy,
        backgroundColor: enabled || showBusy
            ? colors.composerSendBg
            : colors.borderSubtle,
        foregroundColor: enabled || showBusy
            ? colors.composerSendText
            : colors.textMuted,
        label: context.l10n.composerSendHint,
        queueLabel: context.l10n.composerSendQueue,
        steerLabel: context.l10n.composerSendSteer,
        scheduleLabel: context.l10n.composerSendScheduled,
        onSend: onSend,
        onSendWithMode: onSendWithMode,
        onSchedule: onSchedule,
      );
    }
    return Material(
      color: enabled || showBusy ? colors.composerSendBg : colors.borderSubtle,
      shape: const CircleBorder(),
      child: Builder(
        builder: (anchorContext) => InkWell(
          onTap: onSend,
          onLongPress: busy || (!enabled && onSchedule == null)
              ? null
              : (onSchedule != null || onSendWithMode != null)
              ? () => _chooseMode(anchorContext)
              : null,
          customBorder: const CircleBorder(),
          child: SizedBox(
            width: kComposerToolbarHitSize,
            height: kComposerToolbarHitSize,
            child: showBusy
                ? Padding(
                    padding: const EdgeInsets.all(10),
                    child: CircularProgressIndicator(
                      strokeWidth: 2,
                      color: colors.composerSendText,
                    ),
                  )
                : Icon(
                    EcoIcons.send,
                    size: composerToolbarGlyphSize(EcoIcons.send),
                    color: enabled ? colors.composerSendText : colors.textMuted,
                  ),
          ),
        ),
      ),
    );
  }
}

class _StopButton extends StatelessWidget {
  const _StopButton({required this.busy, required this.onStop});

  final bool busy;
  final VoidCallback onStop;

  @override
  Widget build(BuildContext context) {
    final colors = ecoColors(context);
    return Semantics(
      button: true,
      enabled: !busy,
      label: busy ? context.l10n.threadStopping : context.l10n.threadStop,
      child: Material(
        color: colors.voiceRecordBg,
        shape: const CircleBorder(),
        child: InkWell(
          onTap: busy ? null : onStop,
          customBorder: const CircleBorder(),
          child: SizedBox(
            width: kComposerToolbarHitSize,
            height: kComposerToolbarHitSize,
            child: busy
                ? Padding(
                    padding: const EdgeInsets.all(10),
                    child: CircularProgressIndicator(
                      strokeWidth: 2,
                      color: colors.onAccent,
                    ),
                  )
                : Center(
                    child: DecoratedBox(
                      decoration: BoxDecoration(
                        color: colors.onAccent,
                        borderRadius: BorderRadius.all(Radius.circular(2.5)),
                      ),
                      child: SizedBox(width: 12, height: 12),
                    ),
                  ),
          ),
        ),
      ),
    );
  }
}
