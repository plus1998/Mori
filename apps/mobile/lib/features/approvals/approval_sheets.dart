import 'dart:ui';
import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../../core/locale/app_localizations_ext.dart';
import '../../core/models/thread_models.dart';
import '../../core/theme/eco_icons.dart';
import '../../core/theme/eco_theme.dart';
import '../../core/utils/activity_display.dart';
import '../../core/widgets/eco_action_sheet.dart';
import '../../core/widgets/eco_grouped_list.dart';
import '../../core/widgets/eco_modal_sheet.dart';
import '../../core/widgets/eco_markdown.dart';

Future<void> showPlanApprovalSheet({
  required BuildContext context,
  required ThreadPendingPlan plan,
  required Future<void> Function() onApprove,
  required Future<void> Function() onDismiss,
}) {
  return showEcoModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    isDismissible: false,
    enableDrag: false,
    backgroundColor: ecoColors(context).bgMain,
    builder: (context) {
      return PopScope(
        canPop: false,
        child: _ScrollableSheetFrame(
          maxHeightFactor: 0.92,
          footer: Row(
            children: [
              Expanded(
                child: OutlinedButton(
                  onPressed: () async {
                    await onDismiss();
                    if (context.mounted) Navigator.pop(context);
                  },
                  child: Text(context.l10n.approvalReject),
                ),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: FilledButton(
                  onPressed: () async {
                    await onApprove();
                    if (context.mounted) Navigator.pop(context);
                  },
                  child: Text(context.l10n.approvalApproveExecution),
                ),
              ),
            ],
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(
                context.l10n.approvalPlanTitle,
                style: Theme.of(
                  context,
                ).textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w600),
              ),
              const SizedBox(height: 20),
              _ApprovalField(
                label: context.l10n.approvalUserRequest,
                body: Text(plan.userPrompt),
              ),
              const SizedBox(height: 16),
              _ApprovalField(
                label: context.l10n.approvalAnalysis,
                body: Text(plan.analysis),
              ),
              const SizedBox(height: 16),
              _ApprovalField(
                label: context.l10n.approvalPlan,
                body: EcoMarkdown(text: plan.plan),
              ),
            ],
          ),
        ),
      );
    },
  );
}

Future<void> showBashApprovalSheet({
  required BuildContext context,
  required BashApprovalRequest request,
  required Future<void> Function(String decision) onResolve,
}) {
  final title = resolveBashApprovalTitle(
    description: request.description,
    reason: request.reason,
    filesystemTool: request.filesystemTool,
    l10n: context.l10n,
  );
  final detail = request.filesystemTool != null
      ? '${request.filesystemTool}: ${request.filesystemPath}'
      : request.command;
  return showEcoModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    backgroundColor: ecoColors(context).bgMain,
    builder: (context) {
      return _ScrollableSheetFrame(
        maxHeightFactor: 0.85,
        footer: Row(
          children: [
            Expanded(
              child: OutlinedButton(
                onPressed: () async {
                  await onResolve('denied');
                  if (context.mounted) Navigator.pop(context);
                },
                child: Text(context.l10n.approvalReject),
              ),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: FilledButton(
                onPressed: () async {
                  await onResolve('approved');
                  if (context.mounted) Navigator.pop(context);
                },
                child: Text(context.l10n.approvalApprove),
              ),
            ),
          ],
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              request.filesystemTool != null
                  ? context.l10n.approvalToolReadTitle
                  : context.l10n.approvalBashTitle,
              style: Theme.of(context).textTheme.labelSmall?.copyWith(
                color: ecoColors(context).textMuted,
                letterSpacing: 0.2,
              ),
            ),
            const SizedBox(height: 8),
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Expanded(
                  child: Text(
                    title,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: Theme.of(context).textTheme.titleMedium?.copyWith(
                      fontWeight: FontWeight.w600,
                      height: 1.3,
                    ),
                  ),
                ),
                if (request.filesystemTool == null) ...[
                  const SizedBox(width: 12),
                  _BashRiskBadge(
                    level: request.riskLevel,
                    score: request.riskScore,
                  ),
                ],
              ],
            ),
            const SizedBox(height: 16),
            EcoGroupedSurface(
              margin: EdgeInsets.zero,
              padding: const EdgeInsets.all(14),
              child: SelectableText(
                detail,
                style: TextStyle(
                  fontFamily: 'monospace',
                  fontSize: 13,
                  height: 1.4,
                  color: ecoColors(context).textPrimary,
                ),
              ),
            ),
          ],
        ),
      );
    },
  );
}

class _ApprovalField extends StatelessWidget {
  const _ApprovalField({required this.label, required this.body});

  final String label;
  final Widget body;

  @override
  Widget build(BuildContext context) {
    final eco = ecoColors(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(
          label.toUpperCase(),
          style: Theme.of(context).textTheme.labelSmall?.copyWith(
            color: eco.textMuted,
            letterSpacing: 0.2,
          ),
        ),
        const SizedBox(height: 8),
        EcoGroupedSurface(
          margin: EdgeInsets.zero,
          padding: const EdgeInsets.all(14),
          child: DefaultTextStyle.merge(
            style: Theme.of(
              context,
            ).textTheme.bodyMedium?.copyWith(height: 1.4, letterSpacing: -0.15),
            child: body,
          ),
        ),
      ],
    );
  }
}

class _BashRiskBadge extends StatelessWidget {
  const _BashRiskBadge({required this.level, required this.score});

  final String level;
  final int score;

  @override
  Widget build(BuildContext context) {
    final colors = ecoColors(context);
    final color = switch (level) {
      'critical' => colors.danger,
      'high' => colors.severityHigh,
      'low' => colors.success,
      _ => colors.severityDefault,
    };
    final label = switch (level) {
      'critical' => context.l10n.approvalSeverityCritical,
      'high' => context.l10n.approvalSeverityHigh,
      'low' => context.l10n.approvalSeverityLow,
      _ => context.l10n.approvalSeverityMedium,
    };

    return DecoratedBox(
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.14),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              label,
              style: Theme.of(context).textTheme.labelSmall?.copyWith(
                color: color,
                fontWeight: FontWeight.w600,
              ),
            ),
            const SizedBox(width: 4),
            Text(
              '$score',
              style: Theme.of(context).textTheme.labelSmall?.copyWith(
                color: color,
                fontFeatures: const [FontFeature.tabularFigures()],
                fontWeight: FontWeight.w700,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class ClarificationDockPanel extends StatefulWidget {
  const ClarificationDockPanel({
    super.key,
    required this.request,
    required this.busy,
    required this.onSubmit,
    required this.onDismiss,
  });

  final ClarificationRequest request;
  final bool busy;
  final Future<void> Function(
    List<List<String>> selections, {
    List<int>? customInputIndices,
  })
  onSubmit;
  final Future<void> Function() onDismiss;

  @override
  State<ClarificationDockPanel> createState() => _ClarificationDockPanelState();
}

class _ClarificationDockPanelState extends State<ClarificationDockPanel> {
  static const _customOptionLabel = '其他（自定义说明）';
  static final _recommendedSuffix = RegExp(
    r'\s*(?:\(Recommended\)|（Recommended）|（推荐）)$',
    caseSensitive: false,
  );

  late List<List<String>> _selections;
  late List<TextEditingController> _customTexts;
  final _contentScroll = ScrollController();
  final _answerFocus = FocusNode();
  int _questionIndex = 0;

  @override
  void initState() {
    super.initState();
    _resetSelections();
  }

  @override
  void didUpdateWidget(covariant ClarificationDockPanel oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.request.toolUseId != widget.request.toolUseId ||
        oldWidget.request.questions.length != widget.request.questions.length) {
      _answerFocus.unfocus();
      for (final controller in _customTexts) {
        controller.dispose();
      }
      _questionIndex = 0;
      _resetSelections();
      if (_contentScroll.hasClients) _contentScroll.jumpTo(0);
    }
  }

  void _resetSelections() {
    _selections = [
      for (final question in widget.request.questions)
        question.options.isEmpty && question.allowCustom != false
            ? [_customOptionLabel]
            : <String>[],
    ];
    _customTexts = [
      for (final _ in widget.request.questions) TextEditingController(),
    ];
  }

  @override
  void dispose() {
    _contentScroll.dispose();
    _answerFocus.dispose();
    for (final controller in _customTexts) {
      controller.dispose();
    }
    super.dispose();
  }

  bool _isRecommendedOption(ClarificationQuestionOption option) =>
      option.recommended == true || _recommendedSuffix.hasMatch(option.label);

  String _formatOptionLabel(String label) =>
      label.replaceFirst(_recommendedSuffix, '').trim();

  bool _ready(int index) => _selections[index].contains(_customOptionLabel)
      ? (widget.request.questions[index].preserveCustomText == true
            ? _customTexts[index].text.isNotEmpty
            : _customTexts[index].text.trim().isNotEmpty)
      : _selections[index].isNotEmpty;

  bool get _questionReady => _ready(_questionIndex);

  List<List<String>> _answers() => [
    for (var i = 0; i < _selections.length; i++)
      if (_selections[i].contains(_customOptionLabel))
        [
          widget.request.questions[i].preserveCustomText == true
              ? _customTexts[i].text
              : _customTexts[i].text.trim(),
        ]
      else
        [..._selections[i]],
  ];

  void _changeQuestion(int index) {
    _answerFocus.unfocus();
    setState(() => _questionIndex = index);
    if (_contentScroll.hasClients) _contentScroll.jumpTo(0);
  }

  void _selectOption(ClarificationQuestion question, String value) {
    if (widget.busy) return;
    setState(() {
      final selected = _selections[_questionIndex];
      if (value == _customOptionLabel) {
        _selections[_questionIndex] = [value];
      } else {
        selected.remove(_customOptionLabel);
        if (question.multiSelect == true) {
          if (selected.contains(value)) {
            selected.remove(value);
          } else {
            selected.add(value);
          }
        } else {
          _selections[_questionIndex] = [value];
        }
      }
    });
    if (value != _customOptionLabel &&
        question.multiSelect != true &&
        _questionIndex < widget.request.questions.length - 1) {
      _changeQuestion(_questionIndex + 1);
    }
  }

  void _previousQuestion() {
    if (!widget.busy && _questionIndex > 0) {
      _changeQuestion(_questionIndex - 1);
    }
  }

  void _nextQuestion() {
    if (!widget.busy &&
        _questionReady &&
        _questionIndex < widget.request.questions.length - 1) {
      _changeQuestion(_questionIndex + 1);
    }
  }

  @override
  Widget build(BuildContext context) {
    if (widget.request.questions.isEmpty) return const SizedBox.shrink();
    final colors = ecoColors(context);
    final isDark = Theme.of(context).brightness == Brightness.dark;
    final question = widget.request.questions[_questionIndex];
    // A text-only question already has an editor; do not spend its limited
    // keyboard viewport on a redundant "Other" option.
    final textOnly = question.options.isEmpty;
    final options = [
      ...question.options.where(
        (option) =>
            question.allowCustom != false || option.label != _customOptionLabel,
      ),
      if (!textOnly &&
          question.allowCustom != false &&
          !question.options.any((option) => option.label == _customOptionLabel))
        ClarificationQuestionOption(label: _customOptionLabel),
    ];
    final showCustomInput = _selections[_questionIndex].contains(
      _customOptionLabel,
    );
    final total = widget.request.questions.length;
    final isLast = _questionIndex == total - 1;
    final canSubmit = List.generate(total, _ready).every((ready) => ready);

    return SafeArea(
      top: false,
      child: LayoutBuilder(
        builder: (context, constraints) {
          final media = MediaQuery.of(context);
          final availableHeight = math.max(
            0.0,
            media.size.height -
                media.viewInsets.bottom -
                media.padding.vertical -
                kToolbarHeight -
                24,
          );
          final maxPanelHeight = math.min(
            math.min(media.size.height * 0.72, availableHeight),
            constraints.maxHeight,
          );
          return Padding(
            padding: const EdgeInsets.fromLTRB(12, 0, 12, 8),
            child: ConstrainedBox(
              key: const Key('clarification-dock-panel'),
              constraints: BoxConstraints(maxHeight: maxPanelHeight),
              child: ClipRRect(
                borderRadius: BorderRadius.circular(24),
                child: BackdropFilter(
                  filter: ImageFilter.blur(sigmaX: 22, sigmaY: 22),
                  child: DecoratedBox(
                    key: const Key('clarification-dock-surface'),
                    decoration: BoxDecoration(
                      color: colors.composerContextBg.withValues(
                        alpha: isDark ? 0.94 : 0.96,
                      ),
                      borderRadius: BorderRadius.circular(24),
                    ),
                    child: Padding(
                      padding: const EdgeInsets.fromLTRB(16, 4, 16, 12),
                      child: Column(
                        mainAxisSize: MainAxisSize.min,
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [
                          Row(
                            children: [
                              Expanded(
                                child: Text(
                                  context.l10n.approvalClarificationTitle,
                                  style: Theme.of(context).textTheme.labelLarge
                                      ?.copyWith(color: colors.textSecondary),
                                ),
                              ),
                              if (total > 1)
                                Padding(
                                  padding: const EdgeInsets.only(
                                    left: 8,
                                    right: 4,
                                  ),
                                  child: Text(
                                    '${_questionIndex + 1} / $total',
                                    style: Theme.of(context)
                                        .textTheme
                                        .labelMedium
                                        ?.copyWith(color: colors.textMuted),
                                  ),
                                ),
                              _ClarificationPageButton(
                                icon: EcoIcons.close,
                                tooltip: context.l10n.commonClose,
                                enabled: !widget.busy,
                                onPressed: () => widget.onDismiss(),
                              ),
                            ],
                          ),
                          Flexible(
                            fit: FlexFit.loose,
                            child: Scrollbar(
                              controller: _contentScroll,
                              child: SingleChildScrollView(
                                key: const Key('clarification-content-scroll'),
                                controller: _contentScroll,
                                keyboardDismissBehavior:
                                    ScrollViewKeyboardDismissBehavior.onDrag,
                                padding: const EdgeInsets.only(
                                  top: 4,
                                  bottom: 12,
                                ),
                                child: Column(
                                  crossAxisAlignment:
                                      CrossAxisAlignment.stretch,
                                  mainAxisSize: MainAxisSize.min,
                                  children: [
                                    if (question.header?.trim().isNotEmpty ==
                                        true) ...[
                                      Text(
                                        question.header!,
                                        style: Theme.of(context)
                                            .textTheme
                                            .labelMedium
                                            ?.copyWith(color: colors.textMuted),
                                      ),
                                      const SizedBox(height: 6),
                                    ],
                                    Text(
                                      question.question,
                                      key: ValueKey(
                                        'clarification-question-$_questionIndex',
                                      ),
                                      style: Theme.of(context)
                                          .textTheme
                                          .bodyMedium
                                          ?.copyWith(
                                            fontSize: 15,
                                            fontWeight: FontWeight.w500,
                                            height: 1.5,
                                            color: colors.textPrimary,
                                          ),
                                    ),
                                    if (options.isNotEmpty) ...[
                                      const SizedBox(height: 16),
                                      Column(
                                        key: const Key(
                                          'clarification-options-content',
                                        ),
                                        mainAxisSize: MainAxisSize.min,
                                        children: [
                                          for (
                                            var index = 0;
                                            index < options.length;
                                            index++
                                          ) ...[
                                            if (index > 0)
                                              const SizedBox(height: 8),
                                            _ClarificationOptionRow(
                                              index: index,
                                              option: options[index],
                                              label:
                                                  options[index].label ==
                                                      _customOptionLabel
                                                  ? context
                                                        .l10n
                                                        .approvalClarificationCustomLabel
                                                  : _formatOptionLabel(
                                                      options[index].label,
                                                    ),
                                              selected:
                                                  _selections[_questionIndex]
                                                      .contains(
                                                        options[index].label,
                                                      ),
                                              recommended: _isRecommendedOption(
                                                options[index],
                                              ),
                                              enabled: !widget.busy,
                                              onTap: () => _selectOption(
                                                question,
                                                options[index].label,
                                              ),
                                            ),
                                          ],
                                        ],
                                      ),
                                    ],
                                    if (showCustomInput) ...[
                                      const SizedBox(height: 16),
                                      TextField(
                                        key: ValueKey(
                                          'clarification-custom-$_questionIndex',
                                        ),
                                        focusNode: _answerFocus,
                                        controller:
                                            _customTexts[_questionIndex],
                                        enabled: !widget.busy,
                                        minLines: textOnly ? 3 : 2,
                                        maxLines: 6,
                                        scrollPadding: const EdgeInsets.all(20),
                                        textCapitalization:
                                            TextCapitalization.sentences,
                                        style: Theme.of(context)
                                            .textTheme
                                            .bodyMedium
                                            ?.copyWith(
                                              fontSize: 15,
                                              height: 1.5,
                                            ),
                                        decoration: InputDecoration(
                                          hintText: context
                                              .l10n
                                              .approvalClarificationCustomHint,
                                          filled: true,
                                          fillColor: colors.bgInput,
                                          contentPadding: const EdgeInsets.all(
                                            14,
                                          ),
                                          border: OutlineInputBorder(
                                            borderRadius: BorderRadius.circular(
                                              14,
                                            ),
                                          ),
                                          enabledBorder: OutlineInputBorder(
                                            borderRadius: BorderRadius.circular(
                                              14,
                                            ),
                                            borderSide: BorderSide(
                                              color: colors.borderSubtle,
                                            ),
                                          ),
                                          focusedBorder: OutlineInputBorder(
                                            borderRadius: BorderRadius.circular(
                                              14,
                                            ),
                                            borderSide: BorderSide(
                                              color: colors.accent,
                                              width: 1.5,
                                            ),
                                          ),
                                        ),
                                        onChanged: (_) => setState(() {}),
                                      ),
                                    ],
                                  ],
                                ),
                              ),
                            ),
                          ),
                          Padding(
                            padding: const EdgeInsets.only(top: 8),
                            child: Row(
                              children: [
                                if (total > 1) ...[
                                  _ClarificationPageButton(
                                    icon: EcoIcons.chevronLeft,
                                    tooltip: context
                                        .l10n
                                        .approvalClarificationPrevious,
                                    enabled: !widget.busy && _questionIndex > 0,
                                    onPressed: _previousQuestion,
                                  ),
                                  _ClarificationPageButton(
                                    icon: EcoIcons.chevronRight,
                                    tooltip:
                                        context.l10n.approvalClarificationNext,
                                    enabled:
                                        !widget.busy &&
                                        _questionReady &&
                                        !isLast,
                                    onPressed: _nextQuestion,
                                  ),
                                  const SizedBox(width: 8),
                                ],
                                Expanded(
                                  child: FilledButton(
                                    style: FilledButton.styleFrom(
                                      minimumSize: const Size(0, 44),
                                      padding: const EdgeInsets.symmetric(
                                        horizontal: 16,
                                        vertical: 12,
                                      ),
                                      shape: RoundedRectangleBorder(
                                        borderRadius: BorderRadius.circular(14),
                                      ),
                                    ),
                                    onPressed:
                                        widget.busy ||
                                            !(isLast
                                                ? canSubmit
                                                : _questionReady)
                                        ? null
                                        : isLast
                                        ? () => widget.onSubmit(
                                            _answers(),
                                            customInputIndices: [
                                              for (var i = 0; i < total; i++)
                                                if (_selections[i].contains(
                                                  _customOptionLabel,
                                                ))
                                                  i,
                                            ],
                                          )
                                        : _nextQuestion,
                                    child: widget.busy
                                        ? SizedBox(
                                            width: 18,
                                            height: 18,
                                            child: CircularProgressIndicator(
                                              strokeWidth: 2,
                                              color: colors.onAccent,
                                            ),
                                          )
                                        : Text(
                                            isLast
                                                ? context.l10n.commonSubmit
                                                : context
                                                      .l10n
                                                      .approvalClarificationCompleteSelection,
                                            textAlign: TextAlign.center,
                                          ),
                                  ),
                                ),
                              ],
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                ),
              ),
            ),
          );
        },
      ),
    );
  }
}

class _ClarificationPageButton extends StatelessWidget {
  const _ClarificationPageButton({
    required this.icon,
    required this.tooltip,
    required this.enabled,
    required this.onPressed,
  });
  final IconData icon;
  final String tooltip;
  final bool enabled;
  final VoidCallback onPressed;
  @override
  Widget build(BuildContext context) => IconButton(
    onPressed: enabled ? onPressed : null,
    tooltip: tooltip,
    constraints: const BoxConstraints.tightFor(width: 44, height: 44),
    padding: EdgeInsets.zero,
    icon: Icon(icon, size: 18),
  );
}

class _ClarificationOptionRow extends StatelessWidget {
  const _ClarificationOptionRow({
    required this.index,
    required this.option,
    required this.label,
    required this.selected,
    required this.recommended,
    required this.enabled,
    required this.onTap,
  });
  final int index;
  final ClarificationQuestionOption option;
  final String label;
  final bool selected;
  final bool recommended;
  final bool enabled;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final colors = ecoColors(context);
    final radius = BorderRadius.circular(14);
    return Semantics(
      selected: selected,
      child: Material(
        color: selected
            ? colors.accent.withValues(alpha: 0.08)
            : colors.bgInput.withValues(alpha: 0.65),
        shape: RoundedRectangleBorder(
          borderRadius: radius,
          side: BorderSide(
            color: selected
                ? colors.accent.withValues(alpha: 0.6)
                : colors.borderSubtle,
          ),
        ),
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          onTap: enabled ? onTap : null,
          child: Padding(
            padding: const EdgeInsets.all(12),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Container(
                  width: 24,
                  height: 24,
                  alignment: Alignment.center,
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    color: selected ? colors.accent : Colors.transparent,
                    border: Border.all(
                      color: selected ? colors.accent : colors.borderStrong,
                    ),
                  ),
                  child: selected
                      ? Icon(EcoIcons.check, size: 14, color: colors.onAccent)
                      : Text(
                          '${index + 1}',
                          style: Theme.of(context).textTheme.labelMedium
                              ?.copyWith(color: colors.textMuted),
                        ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        label,
                        style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                          fontWeight: FontWeight.w600,
                          height: 1.4,
                          color: colors.textPrimary,
                        ),
                      ),
                      if (recommended)
                        Padding(
                          padding: const EdgeInsets.only(top: 6),
                          child: Text(
                            context.l10n.approvalClarificationRecommended,
                            style: Theme.of(context).textTheme.labelSmall
                                ?.copyWith(color: colors.accentText),
                          ),
                        ),
                      if (option.description?.trim().isNotEmpty == true) ...[
                        const SizedBox(height: 6),
                        Text(
                          option.description!,
                          style: Theme.of(context).textTheme.bodySmall
                              ?.copyWith(
                                color: colors.textSecondary,
                                height: 1.5,
                              ),
                        ),
                      ],
                    ],
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _ScrollableSheetFrame extends StatelessWidget {
  const _ScrollableSheetFrame({
    required this.child,
    required this.footer,
    this.maxHeightFactor = 0.92,
  });

  final Widget child;
  final Widget footer;
  final double maxHeightFactor;

  @override
  Widget build(BuildContext context) {
    final mediaQuery = MediaQuery.of(context);
    final maxHeight = mediaQuery.size.height * maxHeightFactor;
    return Padding(
      padding: EdgeInsets.only(bottom: mediaQuery.viewInsets.bottom),
      child: ConstrainedBox(
        constraints: BoxConstraints(maxHeight: maxHeight),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const EcoSheetGrabber(),
            Flexible(
              child: SingleChildScrollView(
                padding: const EdgeInsets.fromLTRB(
                  ecoGroupedHorizontalInset,
                  4,
                  ecoGroupedHorizontalInset,
                  12,
                ),
                child: child,
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(
                ecoGroupedHorizontalInset,
                0,
                ecoGroupedHorizontalInset,
                16,
              ),
              child: footer,
            ),
          ],
        ),
      ),
    );
  }
}
