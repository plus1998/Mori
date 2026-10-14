import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';
import 'dart:ui';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/locale/app_localizations_ext.dart';
import '../../core/locale/app_error_localizations.dart';
import '../../core/models/asr_models.dart';
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
import '../threads/thread_providers.dart';
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

  @override
  ConsumerState<SessionComposer> createState() => _SessionComposerState();
}

class _SessionComposerState extends ConsumerState<SessionComposer> {
  final _focusNode = FocusNode();
  final _plusMenuAnchorKey = GlobalKey();
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
    if (oldWidget.controller != widget.controller) {
      oldWidget.controller.removeListener(_handleControllerChanged);
      widget.controller.addListener(_handleControllerChanged);
    }
  }

  void _handleControllerChanged() {
    setState(() {});
  }

  @override
  void dispose() {
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
    // Auxiliary / approval / vision requests are stateless single-shot calls, so the
    // host accepts switching them mid-run; they take effect on the next such request.
    const canEditStatelessModelConfig = true;
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
                          key: _plusMenuAnchorKey,
                          onPressed: () => showComposerPlusMenu(
                            context: context,
                            ref: ref,
                            anchorKey: _plusMenuAnchorKey,
                            runtimeConfig: widget.runtimeConfig,
                            threadId: widget.threadId,
                            canEdit: canEditConfig,
                            onChanged: widget.onRuntimeConfigChanged,
                            onPickImage: widget.onPickImage,
                            workspacePath: widget.workspacePath,
                          ),
                          tooltip: context.l10n.composerPlusMenu,
                          icon: ComposerToolbarIcon(
                            icon: EcoIcons.add,
                            color: ecoColors(context).textSecondary,
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
                              canEditStatelessModels: canEditStatelessModelConfig,
                              onChanged: widget.onRuntimeConfigChanged,
                              billing: widget.billing,
                              contextSnapshot: widget.contextSnapshot,
                              threadStatus: widget.threadStatus,
                              workspacePath: widget.workspacePath,
                              coreKind: widget.coreKind,
                              onCoreKindChanged: widget.onCoreKindChanged,
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
    await showImageMemoryLightbox(
      context,
      images: images,
      initialIndex: start,
    );
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
                        errorBuilder: (_, _, _) =>
                            const Center(child: Icon(Icons.broken_image_outlined)),
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
  const _SendButton({required this.busy, required this.onSend});

  final bool busy;
  final VoidCallback? onSend;

  @override
  Widget build(BuildContext context) {
    final colors = ecoColors(context);
    final enabled = onSend != null;
    final showBusy = busy && !enabled;
    return Material(
      color: enabled || showBusy ? colors.composerSendBg : colors.borderSubtle,
      shape: const CircleBorder(),
      child: InkWell(
        onTap: onSend,
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
