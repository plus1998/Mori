import 'package:flutter/material.dart';

import '../../core/locale/app_localizations_ext.dart';
import '../../l10n/generated/app_localizations.dart';
import '../../core/models/thread_models.dart';
import '../../core/theme/eco_theme.dart';
import '../../core/utils/activity_display.dart';
import '../../core/utils/bash_approval_ui.dart';

const _circledMarkers = ['①', '②', '③', '④', '⑤'];

class BashApprovalPanel extends StatefulWidget {
  const BashApprovalPanel({
    super.key,
    required this.request,
    required this.busy,
    required this.onResolve,
    required this.onSkip,
  });

  final BashApprovalRequest request;
  final bool busy;
  final Future<void> Function({required String decision, String? feedback})
  onResolve;
  final Future<void> Function() onSkip;

  @override
  State<BashApprovalPanel> createState() => _BashApprovalPanelState();
}

class _BashApprovalPanelState extends State<BashApprovalPanel> {
  int _highlightIndex = 0;
  bool _codeExpanded = false;
  final _denyController = TextEditingController();
  final _denyFocusNode = FocusNode();

  @override
  void initState() {
    super.initState();
    _highlightIndex = widget.request.defaultToNo
        ? _choices.indexOf(BashApprovalChoice.deny)
        : 0;
  }

  @override
  void didUpdateWidget(covariant BashApprovalPanel oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.request.toolUseId != widget.request.toolUseId) {
      _highlightIndex = widget.request.defaultToNo
          ? _choices.indexOf(BashApprovalChoice.deny)
          : 0;
      _codeExpanded = false;
      _denyController.clear();
    }
  }

  @override
  void dispose() {
    _denyController.dispose();
    _denyFocusNode.dispose();
    super.dispose();
  }

  List<BashApprovalChoice> get _choices {
    final choices = <BashApprovalChoice>[BashApprovalChoice.approve];
    if (widget.request.filesystemTool == null &&
        !widget.request.suppressAlwaysAllowRule) {
      choices.add(BashApprovalChoice.approveRememberPrefix);
    }
    choices.add(BashApprovalChoice.deny);
    return choices;
  }

  bool get _denyHighlighted =>
      _choices[_highlightIndex] == BashApprovalChoice.deny;

  Future<void> _submitChoice(BashApprovalChoice choice) async {
    if (widget.busy) return;
    if (choice == BashApprovalChoice.deny) {
      final feedback = _denyController.text.trim();
      if (feedback.isEmpty) {
        _denyFocusNode.requestFocus();
        return;
      }
      await widget.onResolve(
        decision: bashApprovalDecisionValue(choice),
        feedback: feedback,
      );
      return;
    }
    await widget.onResolve(decision: bashApprovalDecisionValue(choice));
  }

  Future<void> _submitHighlighted() async {
    final choice = _choices[_highlightIndex];
    if (widget.request.defaultToNo && choice != BashApprovalChoice.deny) return;
    await _submitChoice(choice);
  }

  @override
  Widget build(BuildContext context) {
    final colors = ecoColors(context);
    final isDark = Theme.of(context).brightness == Brightness.dark;
    final title = resolveBashApprovalTitle(
      description: widget.request.description,
      reason: widget.request.reason,
      filesystemTool: widget.request.filesystemTool,
      l10n: context.l10n,
    );
    final detail = widget.request.filesystemTool != null
        ? '${widget.request.filesystemTool}: ${widget.request.filesystemPath}'
        : widget.request.command;
    final rememberCommand = widget.request.command.trim();

    return SafeArea(
      top: false,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(12, 0, 12, 10),
        child: DecoratedBox(
          decoration: BoxDecoration(
            color: colors.composerContextBg,
            borderRadius: BorderRadius.circular(24),
            border: Border.all(
              width: 0.5,
              color: isDark
                  ? colors.borderSubtle.withValues(alpha: 0.45)
                  : const Color(0x143C3C43),
            ),
            boxShadow: [
              BoxShadow(
                color: colors.shadowScrim.withValues(
                  alpha: isDark ? 0.28 : 0.04,
                ),
                blurRadius: isDark ? 20 : 14,
                offset: const Offset(0, 6),
              ),
            ],
          ),
          child: Padding(
            padding: const EdgeInsets.fromLTRB(18, 18, 18, 14),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  title,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: Theme.of(context).textTheme.bodyLarge?.copyWith(
                    fontWeight: FontWeight.w400,
                    height: 1.5,
                  ),
                ),
                if ((widget.request.reviewRationale ?? '')
                    .trim()
                    .isNotEmpty) ...[
                  const SizedBox(height: 10),
                  _ReviewRationale(
                    rationale: widget.request.reviewRationale!.trim(),
                    colors: colors,
                    l10n: context.l10n,
                  ),
                ],
                const SizedBox(height: 12),
                _CodePreview(
                  text: detail,
                  expanded: _codeExpanded,
                  surfaceColor: colors.composerContextBg,
                  onToggle: () =>
                      setState(() => _codeExpanded = !_codeExpanded),
                ),
                const SizedBox(height: 8),
                for (var i = 0; i < _choices.length; i++)
                  _buildOptionRow(
                    context: context,
                    index: i,
                    choice: _choices[i],
                    highlighted: _highlightIndex == i,
                    rememberCommand: rememberCommand,
                  ),
                const SizedBox(height: 10),
                Row(
                  children: [
                    TextButton(
                      onPressed: widget.busy ? null : () => widget.onSkip(),
                      style: TextButton.styleFrom(
                        foregroundColor: colors.textMuted,
                        padding: const EdgeInsets.symmetric(horizontal: 10),
                      ),
                      child: Text(
                        widget.busy
                            ? context.l10n.commonProcessing
                            : context.l10n.approvalSkip,
                      ),
                    ),
                    const Spacer(),
                    FilledButton(
                      onPressed:
                          widget.busy ||
                              (_denyHighlighted &&
                                  _denyController.text.trim().isEmpty)
                          ? null
                          : _submitHighlighted,
                      style: FilledButton.styleFrom(
                        backgroundColor: isDark
                            ? colors.composerSendBg
                            : const Color(0xFF0D0D0D),
                        foregroundColor: isDark
                            ? colors.composerSendText
                            : Colors.white,
                        minimumSize: const Size(0, 34),
                        padding: const EdgeInsets.symmetric(horizontal: 16),
                        shape: const StadiumBorder(),
                      ),
                      child: widget.busy
                          ? SizedBox(
                              width: 16,
                              height: 16,
                              child: CircularProgressIndicator(
                                strokeWidth: 2,
                                color: isDark
                                    ? colors.composerSendText
                                    : Colors.white,
                              ),
                            )
                          : Text(context.l10n.approvalSubmitEnter),
                    ),
                  ],
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _buildOptionRow({
    required BuildContext context,
    required int index,
    required BashApprovalChoice choice,
    required bool highlighted,
    required String rememberCommand,
  }) {
    final colors = ecoColors(context);

    if (choice == BashApprovalChoice.deny) {
      return Padding(
        padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 4),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.center,
          children: [
            SizedBox(
              width: 20,
              child: Icon(
                Icons.edit_outlined,
                size: 14,
                color: colors.textMuted,
              ),
            ),
            Expanded(
              child: TextField(
                controller: _denyController,
                focusNode: _denyFocusNode,
                enabled: !widget.busy,
                maxLines: 1,
                style: Theme.of(
                  context,
                ).textTheme.bodyMedium?.copyWith(fontSize: 14, height: 1.45),
                decoration: InputDecoration(
                  isDense: true,
                  isCollapsed: true,
                  filled: false,
                  fillColor: Colors.transparent,
                  hintText: bashApprovalDenyOptionLabel(context.l10n),
                  hintStyle: Theme.of(context).textTheme.bodyMedium?.copyWith(
                    fontSize: 14,
                    height: 1.45,
                    color: colors.textMuted,
                  ),
                  border: InputBorder.none,
                  enabledBorder: InputBorder.none,
                  focusedBorder: InputBorder.none,
                  disabledBorder: InputBorder.none,
                  contentPadding: EdgeInsets.zero,
                ),
                onTap: () => setState(() => _highlightIndex = index),
                onChanged: (_) => setState(() {}),
                onSubmitted: (value) {
                  if (value.trim().isNotEmpty) {
                    _submitChoice(BashApprovalChoice.deny);
                  }
                },
              ),
            ),
          ],
        ),
      );
    }

    if (choice == BashApprovalChoice.approveRememberPrefix) {
      return Material(
        color: highlighted
            ? colors.textHeading.withValues(alpha: 0.05)
            : Colors.transparent,
        borderRadius: BorderRadius.circular(8),
        child: InkWell(
          borderRadius: BorderRadius.circular(8),
          onTap: widget.busy
              ? null
              : () {
                  setState(() => _highlightIndex = index);
                  _submitChoice(choice);
                },
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 7),
            child: Row(
              children: [
                SizedBox(
                  width: 20,
                  child: Text(
                    index < _circledMarkers.length
                        ? _circledMarkers[index]
                        : '${index + 1}.',
                    style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                      color: colors.textMuted,
                      fontSize: 13,
                      height: 1.2,
                    ),
                  ),
                ),
                Expanded(
                  child: Text.rich(
                    TextSpan(
                      style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                        fontSize: 14,
                        height: 1.45,
                      ),
                      children: [
                        TextSpan(text: context.l10n.bashApprovalRememberPrefix),
                        TextSpan(
                          text: formatBashApprovalRememberPrefix(
                            rememberCommand,
                          ),
                          style: TextStyle(
                            fontFamily: 'monospace',
                            fontSize: 13,
                            color: colors.textMuted,
                          ),
                        ),
                      ],
                    ),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
              ],
            ),
          ),
        ),
      );
    }

    return Material(
      color: highlighted
          ? colors.textHeading.withValues(alpha: 0.05)
          : Colors.transparent,
      borderRadius: BorderRadius.circular(8),
      child: InkWell(
        borderRadius: BorderRadius.circular(8),
        onTap: widget.busy
            ? null
            : () {
                setState(() => _highlightIndex = index);
                _submitChoice(choice);
              },
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 7),
          child: Row(
            children: [
              SizedBox(
                width: 20,
                child: Text(
                  index < _circledMarkers.length
                      ? _circledMarkers[index]
                      : '${index + 1}.',
                  style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                    color: colors.textMuted,
                    fontSize: 13,
                    height: 1.2,
                  ),
                ),
              ),
              Expanded(child: Text(context.l10n.approvalYes)),
            ],
          ),
        ),
      ),
    );
  }
}

class _CodePreview extends StatelessWidget {
  const _CodePreview({
    required this.text,
    required this.expanded,
    required this.surfaceColor,
    required this.onToggle,
  });

  final String text;
  final bool expanded;
  final Color surfaceColor;
  final VoidCallback onToggle;

  @override
  Widget build(BuildContext context) {
    final colors = ecoColors(context);
    return Stack(
      children: [
        SelectableText(
          text,
          maxLines: expanded ? null : 4,
          style: TextStyle(
            fontFamily: 'monospace',
            fontSize: 13,
            height: 1.55,
            color: colors.textMuted,
          ),
        ),
        if (!expanded)
          Positioned(
            left: 0,
            right: 0,
            bottom: 0,
            height: 40,
            child: DecoratedBox(
              decoration: BoxDecoration(
                gradient: LinearGradient(
                  begin: Alignment.topCenter,
                  end: Alignment.bottomCenter,
                  colors: [surfaceColor.withValues(alpha: 0), surfaceColor],
                  stops: const [0.0, 0.78],
                ),
              ),
              child: Align(
                alignment: Alignment.bottomRight,
                child: TextButton(
                  onPressed: onToggle,
                  style: TextButton.styleFrom(
                    minimumSize: Size.zero,
                    tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                    padding: const EdgeInsets.symmetric(
                      horizontal: 2,
                      vertical: 0,
                    ),
                    foregroundColor: colors.textMuted,
                    textStyle: const TextStyle(fontSize: 11),
                  ),
                  child: Text(context.l10n.commonExpand),
                ),
              ),
            ),
          )
        else
          Align(
            alignment: Alignment.centerRight,
            child: TextButton(
              onPressed: onToggle,
              style: TextButton.styleFrom(
                minimumSize: Size.zero,
                tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                padding: const EdgeInsets.symmetric(horizontal: 2),
                foregroundColor: colors.textMuted,
                textStyle: const TextStyle(fontSize: 11),
              ),
              child: Text(context.l10n.commonCollapse),
            ),
          ),
      ],
    );
  }
}

// The reviewer hardcodes these Chinese prefixes onto rationale when the
// approval *request itself* fails (transport error, invalid JSON, model
// unavailable). A genuine risk-control rejection rationale is written in the
// user's locale and never contains them, so they reliably distinguish
// "couldn't review" from "reviewed and declined" — regardless of locale.
const _reviewRequestErrorMarkers = [
  '审批模型审批失败',
  '审批模型不可用',
  '辅助模型审批失败',
  '辅助模型不可用',
  '审批失败或返回了无效 JSON',
];

bool _isReviewRequestError(String rationale) {
  return _reviewRequestErrorMarkers.any((m) => rationale.contains(m));
}

class _ReviewRationale extends StatelessWidget {
  const _ReviewRationale({
    required this.rationale,
    required this.colors,
    required this.l10n,
  });

  final String rationale;
  final EcoColors colors;
  final AppLocalizations l10n;

  @override
  Widget build(BuildContext context) {
    final isError = _isReviewRequestError(rationale);
    final theme = Theme.of(context);

    if (isError) {
      // Raw error: muted, monospace, no color — reads as diagnostic text.
      return Text(
        rationale,
        style: theme.textTheme.bodySmall?.copyWith(
          fontFamily: 'monospace',
          fontSize: 12,
          height: 1.4,
          color: colors.textMuted,
        ),
      );
    }

    // Risk-control rejection: orange-tinted title, no heavy box.
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          l10n.approvalAutoReviewFailedTitle,
          style: theme.textTheme.bodyMedium?.copyWith(
            fontWeight: FontWeight.w600,
            color: colors.statusWarnText,
          ),
        ),
        const SizedBox(height: 2),
        Text(
          l10n.approvalAutoReviewFailedHint,
          style: theme.textTheme.bodySmall?.copyWith(
            color: colors.textMuted,
            height: 1.35,
          ),
        ),
        const SizedBox(height: 6),
        Text(
          rationale,
          style: theme.textTheme.bodyMedium?.copyWith(height: 1.4),
        ),
      ],
    );
  }
}
