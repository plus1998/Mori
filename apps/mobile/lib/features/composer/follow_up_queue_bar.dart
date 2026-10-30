import 'dart:convert';
import 'dart:math' as math;
import 'dart:ui';

import 'package:flutter/material.dart';

import '../../core/locale/app_localizations_ext.dart';
import '../../core/models/thread_models.dart';
import '../../core/theme/eco_icons.dart';
import '../../core/theme/eco_theme.dart';
import '../../core/utils/thread_follow_up_ui.dart';
import 'composer_context_menu.dart';

class FollowUpQueueBar extends StatelessWidget {
  const FollowUpQueueBar({
    super.key,
    required this.followUps,
    required this.cancelBusyId,
    required this.escalateBusyId,
    this.editingFollowUpId,
    this.moveToTodoBusyId,
    required this.queuePaused,
    required this.pauseBusy,
    required this.onEscalate,
    required this.onEdit,
    required this.onDelete,
    required this.onMoveToTodo,
    required this.onReorder,
    required this.onTogglePause,
  });

  final List<ThreadPendingFollowUp> followUps;
  final String? cancelBusyId;
  final String? escalateBusyId;
  final String? editingFollowUpId;
  final String? moveToTodoBusyId;
  final bool queuePaused;
  final bool pauseBusy;
  final Future<void> Function(ThreadPendingFollowUp followUp) onEscalate;
  final void Function(ThreadPendingFollowUp followUp) onEdit;
  final Future<void> Function(ThreadPendingFollowUp followUp) onDelete;
  final Future<void> Function(ThreadPendingFollowUp followUp) onMoveToTodo;
  final Future<void> Function(int oldIndex, int newIndex) onReorder;
  final Future<void> Function(bool paused) onTogglePause;

  @override
  Widget build(BuildContext context) {
    final eco = ecoColors(context);
    final isDark = Theme.of(context).brightness == Brightness.dark;
    final editingPaused = editingFollowUpId != null;
    final showPauseHint = queuePaused || editingPaused;
    final pauseHint = editingPaused
        ? context.l10n.followUpQueuePausedEditing
        : queuePaused
        ? context.l10n.followUpQueuePaused
        : context.l10n.followUpQueueActive(followUps.length);
    final pauseHintHeight = 28.0;

    return Transform.translate(
      offset: const Offset(0, 18),
      transformHitTests: true,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 30),
        child: ClipRRect(
          borderRadius: const BorderRadius.vertical(top: Radius.circular(16)),
          child: BackdropFilter(
            filter: ImageFilter.blur(sigmaX: 18, sigmaY: 18),
            child: DecoratedBox(
              decoration: BoxDecoration(
                color: eco.composerContextBg.withValues(
                  alpha: isDark ? 0.58 : 0.52,
                ),
                borderRadius: const BorderRadius.vertical(
                  top: Radius.circular(16),
                ),
                border: Border.all(
                  width: 0.5,
                  color: isDark
                      ? eco.borderSubtle.withValues(alpha: 0.42)
                      : const Color(0x143C3C43),
                ),
                boxShadow: [
                  BoxShadow(
                    color: eco.shadowScrim.withValues(
                      alpha: isDark ? 0.16 : 0.04,
                    ),
                    blurRadius: 24,
                    offset: const Offset(0, 8),
                  ),
                ],
              ),
              child: SizedBox(
                height: math.min(
                  196,
                  pauseHintHeight +
                      10 +
                      (followUps.length * 34) +
                      (math.max(0, followUps.length - 1) * 5),
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Padding(
                      padding: const EdgeInsets.fromLTRB(14, 8, 10, 0),
                      child: Row(
                        children: [
                          Expanded(
                            child: Text(
                              pauseHint,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: Theme.of(context).textTheme.bodySmall
                                  ?.copyWith(
                                    color: eco.composerPillText.withValues(
                                      alpha: showPauseHint ? 0.72 : 0.52,
                                    ),
                                    fontSize: 11,
                                    height: 1.3,
                                  ),
                            ),
                          ),
                          TextButton(
                            onPressed: pauseBusy
                                ? null
                                : () => onTogglePause(!queuePaused),
                            style: TextButton.styleFrom(
                              minimumSize: Size.zero,
                              padding: const EdgeInsets.symmetric(
                                horizontal: 8,
                                vertical: 4,
                              ),
                              tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                              foregroundColor: eco.composerPillText.withValues(
                                alpha: 0.88,
                              ),
                            ),
                            child: Row(
                              mainAxisSize: MainAxisSize.min,
                              children: [
                                Icon(
                                  queuePaused ? EcoIcons.play : EcoIcons.pause,
                                  size: 12,
                                ),
                                const SizedBox(width: 4),
                                Text(
                                  queuePaused
                                      ? context.l10n.followUpQueueResume
                                      : context.l10n.followUpQueuePause,
                                  style: const TextStyle(fontSize: 11),
                                ),
                              ],
                            ),
                          ),
                        ],
                      ),
                    ),
                    Expanded(
                      child: ReorderableListView.builder(
                        shrinkWrap: true,
                        padding: const EdgeInsets.fromLTRB(12, 4, 12, 6),
                        buildDefaultDragHandles: false,
                        itemCount: followUps.length,
                        onReorderItem: (oldIndex, newIndex) {
                          if (editingFollowUpId != null) {
                            return;
                          }
                          onReorder(oldIndex, newIndex);
                        },
                        itemBuilder: (context, index) => Column(
                          key: ValueKey(followUps[index].id),
                          children: [
                            if (index > 0)
                              Divider(height: 5, color: eco.borderSubtle),
                            _FollowUpQueueItem(
                              followUp: followUps[index],
                              isEditing:
                                  followUps[index].id == editingFollowUpId,
                              queuePaused: queuePaused,
                              cancelBusyId: cancelBusyId,
                              escalateBusyId: escalateBusyId,
                              onEscalate: onEscalate,
                              onEdit: onEdit,
                              onDelete: onDelete,
                              onMoveToTodo: onMoveToTodo,
                              moveToTodoBusyId: moveToTodoBusyId,
                              dragHandle:
                                  followUps[index].id == editingFollowUpId
                                  ? Padding(
                                      padding: const EdgeInsets.symmetric(
                                        vertical: 5,
                                      ),
                                      child: Icon(
                                        EcoIcons.followUp,
                                        size: 16,
                                        color: eco.accentText.withValues(
                                          alpha: 0.9,
                                        ),
                                      ),
                                    )
                                  : ReorderableDragStartListener(
                                      index: index,
                                      child: _FollowUpDragHandle(
                                        color: eco.composerPillText.withValues(
                                          alpha: 0.82,
                                        ),
                                      ),
                                    ),
                            ),
                          ],
                        ),
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
  }
}

class _FollowUpDragHandle extends StatelessWidget {
  const _FollowUpDragHandle({required this.color});

  final Color color;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      label: context.l10n.followUpReorder,
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 5),
        child: Icon(Icons.drag_indicator_rounded, size: 16, color: color),
      ),
    );
  }
}

class _FollowUpQueueItem extends StatefulWidget {
  const _FollowUpQueueItem({
    required this.followUp,
    required this.isEditing,
    required this.queuePaused,
    required this.cancelBusyId,
    required this.escalateBusyId,
    required this.onEscalate,
    required this.onEdit,
    required this.onDelete,
    required this.onMoveToTodo,
    required this.dragHandle,
    required this.moveToTodoBusyId,
  });

  final ThreadPendingFollowUp followUp;
  final bool isEditing;
  final bool queuePaused;
  final String? cancelBusyId;
  final String? escalateBusyId;
  final Future<void> Function(ThreadPendingFollowUp followUp) onEscalate;
  final void Function(ThreadPendingFollowUp followUp) onEdit;
  final Future<void> Function(ThreadPendingFollowUp followUp) onDelete;
  final Future<void> Function(ThreadPendingFollowUp followUp) onMoveToTodo;
  final Widget dragHandle;
  final String? moveToTodoBusyId;

  @override
  State<_FollowUpQueueItem> createState() => _FollowUpQueueItemState();
}

class _FollowUpQueueItemState extends State<_FollowUpQueueItem> {
  final _menuKey = GlobalKey();

  bool get _actionBusy =>
      widget.isEditing ||
      widget.moveToTodoBusyId == widget.followUp.id ||
      widget.cancelBusyId == widget.followUp.id ||
      widget.escalateBusyId == widget.followUp.id;

  bool get _canEscalate => canEscalateFollowUp(
    priority: widget.followUp.priority,
    queuePaused: widget.queuePaused,
  );

  void _showMenu() {
    if (_actionBusy) return;

    final entries = <ComposerContextMenuEntry>[
      if (_canEscalate)
        ComposerContextMenuEntry(
          value: 'escalate',
          icon: EcoIcons.indent,
          label: widget.escalateBusyId == widget.followUp.id
              ? context.l10n.commonProcessing
              : context.l10n.followUpGuide,
          enabled: !_actionBusy,
        ),
      ComposerContextMenuEntry(
        value: 'edit',
        icon: EcoIcons.edit,
        label: context.l10n.followUpEdit,
      ),
      ComposerContextMenuEntry(
        value: 'todo',
        icon: Icons.playlist_add_rounded,
        label: context.l10n.followUpToTodo,
        enabled: !_actionBusy,
      ),
      ComposerContextMenuEntry(
        value: 'delete',
        icon: EcoIcons.delete,
        label: widget.cancelBusyId == widget.followUp.id
            ? context.l10n.followUpDeleting
            : context.l10n.commonDelete,
        enabled: !_actionBusy,
        danger: true,
      ),
    ];

    showComposerContextMenu(
      context: context,
      anchorKey: _menuKey,
      entries: entries,
      onSelected: (value) {
        if (_actionBusy) return;
        switch (value) {
          case 'escalate':
            if (_canEscalate) {
              widget.onEscalate(widget.followUp);
            }
          case 'edit':
            widget.onEdit(widget.followUp);
          case 'todo':
            widget.onMoveToTodo(widget.followUp);
          case 'delete':
            widget.onDelete(widget.followUp);
        }
      },
    );
  }

  @override
  Widget build(BuildContext context) {
    final eco = ecoColors(context);
    final attachments = widget.followUp.attachments;
    final textStyle = Theme.of(context).textTheme.bodySmall?.copyWith(
      color: eco.composerPillText,
      fontSize: 13,
      height: 1.25,
    );

    return Semantics(
      label: widget.isEditing
          ? context.l10n.followUpEditing
          : context.l10n.followUpQueuedGuidance,
      child: Material(
        color: widget.isEditing
            ? eco.accentText.withValues(alpha: 0.08)
            : Colors.transparent,
        borderRadius: BorderRadius.circular(10),
        child: InkWell(
          onTap: _actionBusy ? null : () => widget.onEdit(widget.followUp),
          borderRadius: BorderRadius.circular(10),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 2),
            child: Row(
              children: [
                widget.dragHandle,
                const SizedBox(width: 6),
                if (attachments.isNotEmpty &&
                    attachments.first.data.isNotEmpty) ...[
                  SizedBox(
                    width: 30,
                    height: 30,
                    child: ClipRRect(
                      borderRadius: BorderRadius.circular(7),
                      child: Image.memory(
                        base64Decode(attachments.first.data),
                        fit: BoxFit.cover,
                        gaplessPlayback: true,
                        errorBuilder: (_, _, _) => const SizedBox.shrink(),
                      ),
                    ),
                  ),
                  const SizedBox(width: 7),
                ],
                Expanded(
                  child: Text(
                    formatThreadFollowUpPreview(widget.followUp, context.l10n),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: textStyle,
                  ),
                ),
                if (widget.isEditing)
                  Container(
                    margin: const EdgeInsets.only(left: 8),
                    padding: const EdgeInsets.symmetric(
                      horizontal: 8,
                      vertical: 3,
                    ),
                    decoration: BoxDecoration(
                      color: eco.accentText.withValues(alpha: 0.14),
                      borderRadius: BorderRadius.circular(999),
                    ),
                    child: Text(
                      context.l10n.followUpEditing,
                      style: textStyle?.copyWith(
                        fontSize: 11,
                        color: eco.accentText,
                      ),
                    ),
                  )
                else
                  GestureDetector(
                    key: _menuKey,
                    onTap: _actionBusy ? null : _showMenu,
                    behavior: HitTestBehavior.opaque,
                    child: Padding(
                      padding: const EdgeInsets.fromLTRB(8, 5, 2, 5),
                      child: Icon(
                        EcoIcons.more,
                        size: 14,
                        color: _actionBusy
                            ? eco.composerPillText.withValues(alpha: 0.4)
                            : eco.composerPillText,
                      ),
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
