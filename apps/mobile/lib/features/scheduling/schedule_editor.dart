import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';

import '../../core/locale/app_error_localizations.dart';
import '../../core/locale/app_localizations_ext.dart';
import '../../core/models/scheduling_models.dart';
import '../../core/models/thread_models.dart';
import '../../core/models/thread_runtime_config.dart';
import '../../core/theme/eco_theme.dart';
import '../../core/theme/eco_icons.dart';
import '../../core/utils/prompt_image_attachment.dart';
import '../../core/utils/prompt_image_upload.dart';
import '../../core/widgets/composer_prompt_editing_controller.dart';
import 'schedule_widgets.dart';
import '../composer/composer_controls.dart';
import '../projects/project_providers.dart';
import '../threads/thread_providers.dart';
import 'scheduling_providers.dart';

Future<bool?> showScheduleEditor(
  BuildContext context, {
  ScheduleDefinition? definition,
  String? threadId,
  String initialPrompt = '',
  List<PromptImageAttachment> initialAttachments = const [],
  ScheduledMessageNewThread? newThread,
}) => Navigator.of(context, rootNavigator: true).push<bool>(
  MaterialPageRoute(
    fullscreenDialog: true,
    builder: (_) => ScheduleEditor(
      definition: definition,
      threadId: threadId,
      initialPrompt: initialPrompt,
      initialAttachments: initialAttachments,
      newThread: newThread,
    ),
  ),
);

class ScheduleEditor extends ConsumerStatefulWidget {
  const ScheduleEditor({
    super.key,
    this.definition,
    this.threadId,
    this.initialPrompt = '',
    this.initialAttachments = const [],
    this.newThread,
  });
  final ScheduleDefinition? definition;
  final String? threadId;
  final String initialPrompt;
  final List<PromptImageAttachment> initialAttachments;
  final ScheduledMessageNewThread? newThread;
  @override
  ConsumerState<ScheduleEditor> createState() => _ScheduleEditorState();
}

class _ScheduleEditorState extends ConsumerState<ScheduleEditor> {
  final _name = TextEditingController();
  final _prompt = ComposerPromptEditingController();
  final _workspace = TextEditingController();
  final _delay = TextEditingController(text: '60');
  final _interval = TextEditingController(text: '60');
  final _cron = TextEditingController(text: '0 9 * * *');
  final _timezone = TextEditingController(text: 'UTC');
  final _catchUp = TextEditingController(text: '1440');
  final _attempt = ScheduleCreateAttempt();
  late DateTime _at;
  String _type = 'at';
  bool _useDelay = true, _timingChanged = false, _busy = false;
  bool _workspaceInitialized = false;
  String? _error;
  List<String>? _preview;
  ThreadRuntimeConfig? _config;
  String? _coreKind;
  final _attachments = <PromptImageAttachment>[];
  bool get _isMessage =>
      widget.definition?.isMessage ?? widget.threadId != null;

  @override
  void initState() {
    super.initState();
    final d = widget.definition;
    _at = DateTime.now().add(const Duration(hours: 1));
    _prompt.text = d?.prompt ?? widget.initialPrompt;
    _attachments.addAll(d?.attachments ?? widget.initialAttachments);
    _name.text = d?.name ?? '';
    _workspace.text = d?.workspacePath ?? '';
    _workspaceInitialized = d != null;
    if (d != null) {
      _type = d.trigger['type'] as String;
      _useDelay = false;
      final date = d.trigger['at'] ?? d.trigger['anchorAt'];
      if (date is String) _at = DateTime.parse(date).toLocal();
      if (_type == 'interval') {
        _interval.text = _minutes(d.trigger['everySeconds'] as int);
      }
      if (_type == 'cron') {
        _cron.text = d.trigger['expression'] as String;
        _timezone.text = d.trigger['timezone'] as String;
      }
      _catchUp.text = _minutes(d.maxLatenessSeconds);
      final profile = d.executionProfile;
      if (profile != null) {
        _coreKind = profile['coreKind'] as String;
        _config = ThreadRuntimeConfig.fromJson(
          Map<String, dynamic>.from(profile['runtimeConfig'] as Map),
        );
      }
    }
  }

  String _minutes(int seconds) =>
      (seconds / 60).toString().replaceFirst(RegExp(r'\.0$'), '');

  @override
  void dispose() {
    for (final c in [
      _name,
      _prompt,
      _workspace,
      _delay,
      _interval,
      _cron,
      _timezone,
      _catchUp,
    ]) {
      c.dispose();
    }
    super.dispose();
  }

  int _seconds(TextEditingController c, {int minimum = 60, int? maximum}) {
    final value = double.tryParse(c.text.trim());
    final seconds = value == null ? double.nan : value * 60;
    if (!seconds.isFinite ||
        (seconds - seconds.round()).abs() > 0.000001 ||
        seconds < minimum ||
        (maximum != null && seconds > maximum)) {
      throw FormatException(context.l10n.schedulingRequired);
    }
    return seconds.round();
  }

  Map<String, dynamic> _trigger() {
    if (widget.definition != null && !_timingChanged) {
      return widget.definition!.trigger;
    }
    if (_type == 'cron') {
      return {
        'type': 'cron',
        'expression': _cron.text.trim(),
        'timezone': _timezone.text.trim(),
      };
    }
    final at = _useDelay
        ? DateTime.now().add(Duration(seconds: _seconds(_delay)))
        : _at;
    if (!at.isAfter(DateTime.now())) {
      throw FormatException(context.l10n.schedulingExpired);
    }
    return _type == 'at'
        ? {'type': 'at', 'at': scheduleTimestamp(at)}
        : {
            'type': 'interval',
            'everySeconds': _seconds(_interval),
            'anchorAt': scheduleTimestamp(at),
          };
  }

  void _changed() => setState(() {
    _timingChanged = true;
    _preview = null;
  });

  Future<void> _pickTime() async {
    final now = DateTime.now();
    final date = await showDatePicker(
      context: context,
      initialDate: _at.isBefore(now) ? now : _at,
      firstDate: DateTime(now.year, now.month, now.day),
      lastDate: DateTime(now.year + 20),
    );
    if (date == null || !mounted) return;
    final time = await showTimePicker(
      context: context,
      initialTime: TimeOfDay.fromDateTime(_at),
    );
    if (time == null || !mounted) return;
    _at = DateTime(date.year, date.month, date.day, time.hour, time.minute);
    _changed();
  }

  Future<void> _run(Future<void> Function() action) async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await action();
    } catch (error) {
      if (mounted) {
        setState(
          () => _error = error is FormatException
              ? error.message
              : localizedAppError(error, context.l10n),
        );
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _save() => _run(() async {
    final l = context.l10n;
    final prompt = _prompt.prompt.trim();
    final name = _name.text.trim().isNotEmpty
        ? _name.text.trim()
        : (_isMessage && prompt.isNotEmpty
              ? _prompt.text
                    .trim()
                    .split('\n')
                    .first
                    .characters
                    .take(200)
                    .toString()
              : (_isMessage && _attachments.isNotEmpty ? l.composerImage : ''));
    if ((prompt.isEmpty && (!_isMessage || _attachments.isEmpty)) ||
        name.isEmpty ||
        (!_isMessage && _workspace.text.trim().isEmpty)) {
      throw FormatException(l.schedulingRequired);
    }
    final rpc = ref.read(desktopRpcProvider);
    if (rpc == null) throw StateError('Desktop is not connected');
    if (_isMessage) {
      for (var i = 0; i < _attachments.length; i++) {
        if (_attachments[i].contentRef?.isNotEmpty == true) continue;
        final index = i;
        await stagePromptImageAttachments(
          rpc: rpc,
          contextKey: widget.newThread != null
              ? 'landing:${widget.newThread!.workspacePath}'
              : 'thread:${widget.threadId ?? widget.definition!.threadId}',
          attachments: [_attachments[index]],
          onUpdate: (next) {
            if (mounted) setState(() => _attachments[index] = next.single);
          },
        );
      }
    }
    final fields = <String, dynamic>{
      'name': name,
      'prompt': prompt,
      if (_isMessage)
        'attachments': [
          for (final a in _attachments)
            {
              'mediaType': a.mediaType,
              'contentRef': a.contentRef,
              'byteLength': a.byteLength,
            },
        ],
      'maxLatenessSeconds': _seconds(_catchUp, minimum: 0, maximum: 86400),
    };
    if (!_isMessage) {
      final config = _config;
      if (config == null ||
          !isThreadRuntimeConfigReady(
            ref.read(modelSettingsProvider).valueOrNull,
            config,
            coreKind: _coreKind,
          ) ||
          (_coreKind == 'acp' &&
              (config.cursorModelId?.trim().isEmpty ?? true))) {
        throw FormatException(l.schedulingConfigRequired);
      }
      fields.addAll({
        'workspacePath': _workspace.text.trim(),
        'executionProfile': {
          'coreKind': _coreKind,
          'runtimeConfig': config.toJson(),
        },
      });
    }
    final definition = widget.definition;
    if (definition != null) {
      await rpc.updateSchedule({
        'id': definition.id,
        'expectedRevision': definition.revision,
        ...fields,
        if (_timingChanged) 'trigger': _trigger(),
      });
    } else {
      final payload = _attempt.prepare(
        {
          'kind': _isMessage ? 'session_message' : 'scheduled_task',
          ...fields,
          if (_isMessage) 'threadId': widget.threadId,
          if (widget.newThread != null) 'newThread': widget.newThread!.toJson(),
        },
        _trigger,
        timingIdentity: [
          _type,
          _useDelay,
          _at.toIso8601String(),
          _delay.text,
          _interval.text,
          _cron.text,
          _timezone.text,
        ],
      );
      await rpc.createSchedule(payload);
    }
    ref.invalidate(schedulingSnapshotProvider);
    if (mounted) Navigator.of(context).pop(true);
  });

  Future<void> _pickImage() async {
    if (_busy) return;
    await _run(() async {
      if (_attachments.length >= 20) {
        throw FormatException(context.l10n.schedulingImageLimit);
      }
      final file = await ImagePicker().pickImage(source: ImageSource.gallery);
      if (file == null || !mounted) return;
      final result = await promptImageAttachmentFromXFile(file);
      if (!mounted) return;
      if (result.failure != null) {
        throw FormatException(
          result.failure == PromptImagePickFailure.tooLarge
              ? context.l10n.composerImageTooLarge
              : context.l10n.composerUnsupportedImage,
        );
      }
      setState(() => _attachments.add(result.attachment!));
    });
  }

  Widget _field(
    TextEditingController c,
    String label, {
    bool numeric = false,
    int lines = 1,
    bool timing = false,
  }) => Padding(
    padding: const EdgeInsets.only(bottom: 16),
    child: TextField(
      controller: c,
      enabled: !_busy,
      minLines: lines,
      maxLines: lines == 1 ? 1 : 10,
      keyboardType: numeric
          ? const TextInputType.numberWithOptions(decimal: true)
          : lines > 1
          ? TextInputType.multiline
          : null,
      decoration: InputDecoration(
        labelText: label,
        border: const OutlineInputBorder(),
      ),
      onChanged: (_) {
        if (c == _workspace) _workspaceInitialized = true;
        if (timing) _changed();
      },
    ),
  );

  @override
  Widget build(BuildContext context) {
    final l = context.l10n;
    if (!_isMessage) {
      final selectedProject = ref.watch(selectedProjectPathProvider);
      if (!_workspaceInitialized && selectedProject.hasValue) {
        _workspace.text = selectedProject.valueOrNull ?? '';
        _workspaceInitialized = true;
      }
    }
    final settings = !_isMessage ? ref.watch(modelSettingsProvider) : null;
    final workflow = !_isMessage ? ref.watch(workflowSettingsProvider) : null;
    final mcp = !_isMessage
        ? ref.watch(mcpSettingsProvider).valueOrNull?.servers
        : null;
    if (!_isMessage &&
        _config == null &&
        settings?.hasValue == true &&
        workflow?.hasValue == true) {
      _coreKind ??= workflow!.valueOrNull?.defaultCoreKind ?? 'claude';
      _config = buildDefaultRuntimeConfig(
        modelSettings: settings!.valueOrNull,
        workflow: workflow!.valueOrNull,
        mcpServers: mcp,
        coreKind: _coreKind,
      );
    }
    return PopScope(
      canPop: !_busy,
      child: Scaffold(
        backgroundColor: ecoColors(context).bgMain,
        appBar: AppBar(
          title: Text(
            widget.definition != null
                ? l.schedulingEdit
                : _isMessage
                ? l.schedulingNewMessage
                : l.schedulingNewTask,
          ),
          actions: [
            TextButton(
              onPressed: _busy ? null : _save,
              child: _busy
                  ? const SizedBox.square(
                      dimension: 18,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : Text(l.commonSave),
            ),
          ],
        ),
        body: SafeArea(
          child: Column(
            children: [
              if (_error != null)
                Padding(
                  padding: const EdgeInsets.fromLTRB(20, 12, 20, 0),
                  child: SelectableText(
                    _error!,
                    style: TextStyle(
                      color: Theme.of(context).colorScheme.error,
                    ),
                  ),
                ),
              Expanded(
                child: ListView(
                  padding: const EdgeInsets.all(20),
                  children: [
                    ScheduleSection(
                      title: l.schedulingContent,
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [
                          _field(_prompt, l.schedulingPrompt, lines: 4),
                          _field(
                            _name,
                            _isMessage
                                ? l.schedulingOptionalName
                                : l.schedulingName,
                          ),
                          if (_isMessage) ...[
                            if (_attachments.isNotEmpty)
                              ScheduleImages(
                                attachments: _attachments,
                                contextKey: widget.newThread != null
                                    ? 'landing:${widget.newThread!.workspacePath}'
                                    : null,
                                threadId:
                                    widget.threadId ??
                                    widget.definition!.threadId!,
                                onRemove: _busy
                                    ? null
                                    : (index) => setState(
                                        () => _attachments.removeAt(index),
                                      ),
                              ),
                            Align(
                              alignment: Alignment.centerLeft,
                              child: TextButton.icon(
                                onPressed: _busy ? null : _pickImage,
                                icon: const Icon(EcoIcons.image, size: 18),
                                label: Text(l.composerAddImage),
                              ),
                            ),
                          ],
                        ],
                      ),
                    ),
                    const SizedBox(height: 16),
                    if (!_isMessage) ...[
                      ScheduleSection(
                        title: l.schedulingRuntime,
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.stretch,
                          children: [
                            if ((ref.watch(projectListProvider).valueOrNull ??
                                    [])
                                .isNotEmpty)
                              Padding(
                                padding: const EdgeInsets.only(bottom: 12),
                                child: DropdownButtonFormField<String>(
                                  initialValue: null,
                                  isExpanded: true,
                                  decoration: InputDecoration(
                                    labelText: l.schedulingWorkspace,
                                  ),
                                  items: [
                                    for (final p
                                        in ref
                                                .watch(projectListProvider)
                                                .valueOrNull ??
                                            [])
                                      DropdownMenuItem(
                                        value: p.path,
                                        child: Text(
                                          p.name,
                                          overflow: TextOverflow.ellipsis,
                                        ),
                                      ),
                                  ],
                                  onChanged: _busy
                                      ? null
                                      : (value) => setState(() {
                                          _workspaceInitialized = true;
                                          _workspace.text = value ?? '';
                                        }),
                                ),
                              ),
                            _field(_workspace, l.schedulingWorkspace),
                            if (settings?.hasError == true ||
                                workflow?.hasError == true) ...[
                              Text(
                                localizedAppError(
                                  settings?.error ?? workflow!.error!,
                                  l,
                                ),
                              ),
                              TextButton(
                                onPressed: () {
                                  ref.invalidate(modelSettingsProvider);
                                  ref.invalidate(workflowSettingsProvider);
                                },
                                child: Text(l.commonRetry),
                              ),
                            ] else if (_config == null)
                              const LinearProgressIndicator()
                            else ...[
                              DropdownButtonFormField<String>(
                                initialValue: _coreKind,
                                decoration: const InputDecoration(
                                  labelText: 'Agent',
                                ),
                                items: [
                                  for (final option in composerCoreKindOptions)
                                    DropdownMenuItem(
                                      value: option.value,
                                      child: Text(option.label),
                                    ),
                                ],
                                onChanged: _busy
                                    ? null
                                    : (value) => setState(() {
                                        _coreKind = value!;
                                        _config = buildDefaultRuntimeConfig(
                                          modelSettings: settings?.valueOrNull,
                                          workflow: workflow?.valueOrNull,
                                          mcpServers: mcp,
                                          coreKind: value,
                                        );
                                      }),
                              ),
                              if (_coreKind != 'acp' &&
                                  settings?.valueOrNull != null)
                                OrchestrationCompositionSelectors(
                                  settings: settings!.valueOrNull!,
                                  runtimeConfig: _config!,
                                  threadId: '',
                                  canEdit: !_busy,
                                  workspacePath: '',
                                  mcpServers: mcp ?? [],
                                  onChanged: (c) => setState(() => _config = c),
                                ),
                              ComposerRouteSummary(
                                runtimeConfig: _config!,
                                threadId: '',
                                canEdit: !_busy,
                                onChanged: (c) => setState(() => _config = c),
                                coreKind: _coreKind,
                              ),
                            ],
                          ],
                        ),
                      ),
                      const SizedBox(height: 16),
                    ],
                    ScheduleSection(
                      title: l.schedulingTiming,
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [
                          Text(
                            _isMessage
                                ? l.schedulingMessageHint
                                : l.schedulingTaskHint,
                            style: TextStyle(
                              color: ecoColors(context).textSecondary,
                            ),
                          ),
                          const SizedBox(height: 16),
                          DropdownButtonFormField<String>(
                            initialValue: _type,
                            decoration: InputDecoration(
                              labelText: l.schedulingTrigger,
                            ),
                            items: [
                              DropdownMenuItem(
                                value: 'at',
                                child: Text(l.schedulingOnce),
                              ),
                              DropdownMenuItem(
                                value: 'interval',
                                child: Text(l.schedulingInterval),
                              ),
                              DropdownMenuItem(
                                value: 'cron',
                                child: Text(l.schedulingCron),
                              ),
                            ],
                            onChanged: _busy
                                ? null
                                : (value) {
                                    _type = value!;
                                    _changed();
                                  },
                          ),
                          const SizedBox(height: 16),
                          if (_type != 'cron') ...[
                            SwitchListTile(
                              contentPadding: EdgeInsets.zero,
                              title: Text(l.schedulingDelay),
                              subtitle: Text(l.schedulingAt),
                              value: _useDelay,
                              onChanged: _busy
                                  ? null
                                  : (value) {
                                      _useDelay = value;
                                      _changed();
                                    },
                            ),
                            if (_useDelay)
                              _field(
                                _delay,
                                l.schedulingDelayMinutes,
                                numeric: true,
                                timing: true,
                              )
                            else
                              ListTile(
                                contentPadding: EdgeInsets.zero,
                                title: Text(l.schedulingLocalTime),
                                subtitle: Text(
                                  DateFormat.yMd(
                                    l.localeName,
                                  ).add_Hm().format(_at),
                                ),
                                trailing: const Icon(
                                  Icons.calendar_today_outlined,
                                ),
                                onTap: _busy ? null : _pickTime,
                              ),
                            if (_type == 'interval')
                              _field(
                                _interval,
                                l.schedulingIntervalMinutes,
                                numeric: true,
                                timing: true,
                              ),
                          ] else ...[
                            _field(
                              _cron,
                              l.schedulingCronExpression,
                              timing: true,
                            ),
                            _field(
                              _timezone,
                              l.schedulingTimezone,
                              timing: true,
                            ),
                          ],
                        ],
                      ),
                    ),
                    const SizedBox(height: 16),
                    ExpansionTile(
                      title: Text(l.schedulingAdvanced),
                      tilePadding: const EdgeInsets.symmetric(horizontal: 4),
                      childrenPadding: const EdgeInsets.symmetric(
                        horizontal: 4,
                      ),
                      children: [
                        Text(
                          l.schedulingHint,
                          style: TextStyle(
                            color: ecoColors(context).textSecondary,
                          ),
                        ),
                        const SizedBox(height: 16),
                        _field(_catchUp, l.schedulingCatchUp, numeric: true),
                        OutlinedButton(
                          onPressed: _busy
                              ? null
                              : () => _run(() async {
                                  final rpc = ref.read(desktopRpcProvider);
                                  if (rpc == null) {
                                    throw StateError(
                                      'Desktop is not connected',
                                    );
                                  }
                                  final times = await rpc.previewSchedule(
                                    _trigger(),
                                  );
                                  if (mounted) setState(() => _preview = times);
                                }),
                          child: Text(l.schedulingPreview),
                        ),
                        if (_preview != null) ...[
                          for (final time in _preview!)
                            Text(
                              DateFormat.yMd(l.localeName).add_Hms().format(
                                DateTime.parse(time).toLocal(),
                              ),
                            ),
                        ],
                      ],
                    ),
                    const SizedBox(height: 24),
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
