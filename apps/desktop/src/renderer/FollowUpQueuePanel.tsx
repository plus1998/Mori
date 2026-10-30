import { Activity, CornerDownRight, GripVertical, ListTodo, LoaderCircle, MoreHorizontal, Pause, Pencil, Play, Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { ThreadPendingFollowUp } from "../shared/ipc";
import { BrowserToolbarMenu } from "./BrowserToolbarMenu";
import { FollowUpPromptPreview } from "./FollowUpPromptPreview";
import { canEscalateThreadFollowUp, isThreadFollowUpGuidancePending } from "./thread-follow-up-ui";

export function FollowUpQueuePanel({
  followUps,
  editingFollowUpId,
  queuePaused,
  threadActive,
  pauseBusy,
  cancelBusyId,
  escalateBusyId,
  moveToTodoBusyId,
  onMoveToTodo,
  allowEscalate = true,
  onCancel,
  onEscalate,
  onEdit,
  onReorder,
  onTogglePause,
}: {
  followUps: ThreadPendingFollowUp[];
  editingFollowUpId: string | undefined;
  queuePaused: boolean;
  threadActive: boolean;
  pauseBusy: boolean;
  cancelBusyId: string | undefined;
  escalateBusyId: string | undefined;
  moveToTodoBusyId: string | undefined;
  onMoveToTodo: (followUp: ThreadPendingFollowUp) => void;
  allowEscalate?: boolean;
  onCancel: (followUp: ThreadPendingFollowUp) => void;
  onEscalate: (followUp: ThreadPendingFollowUp) => void;
  onEdit: (followUp: ThreadPendingFollowUp) => void;
  onReorder: (followUpIds: string[]) => void;
  onTogglePause: (paused: boolean) => void;
}) {
  const { t } = useTranslation();
  const [draggedId, setDraggedId] = useState<string>();
  const editingPaused = Boolean(editingFollowUpId);
  const showPauseHint = queuePaused || editingPaused;
  const pauseHint = editingPaused
    ? t("thread.followUpQueuePausedEditing")
    : queuePaused
      ? t("thread.followUpQueuePaused")
      : null;

  const moveDraggedBefore = (targetId: string) => {
    if (!draggedId || draggedId === targetId || draggedId === editingFollowUpId) return;
    const next = followUps.map((followUp) => followUp.id);
    const from = next.indexOf(draggedId);
    const to = next.indexOf(targetId);
    if (from < 0 || to < 0) return;
    next.splice(to, 0, next.splice(from, 1)[0]!);
    onReorder(next);
  };
  return (
    <div className="follow-up-queue" aria-label={t("app.queuedGuidance")}>
      <div className="follow-up-queue-header">
        {showPauseHint && pauseHint ? (
          <div className="follow-up-queue-pause-hint" role="status">
            {pauseHint}
          </div>
        ) : (
          <div className="follow-up-queue-pause-hint follow-up-queue-pause-hint-idle" aria-hidden>
            {t("thread.followUpQueueActive", { count: followUps.length })}
          </div>
        )}
        <button
          type="button"
          className="follow-up-queue-pause-toggle"
          disabled={pauseBusy}
          onClick={() => onTogglePause(!queuePaused)}
          title={queuePaused ? t("thread.followUpQueueResume") : t("thread.followUpQueuePause")}
          aria-label={queuePaused ? t("thread.followUpQueueResumeAria") : t("thread.followUpQueuePauseAria")}
        >
          {pauseBusy ? (
            <Activity size={12} aria-hidden />
          ) : queuePaused ? (
            <Play size={12} aria-hidden />
          ) : (
            <Pause size={12} aria-hidden />
          )}
          <span>{queuePaused ? t("thread.followUpQueueResume") : t("thread.followUpQueuePause")}</span>
        </button>
      </div>
      <div className="follow-up-queue-rows">
        {followUps.map((followUp) => {
          const isEditing = editingFollowUpId === followUp.id;
          const actionBusy = cancelBusyId === followUp.id || escalateBusyId === followUp.id || moveToTodoBusyId === followUp.id || isEditing;
          const isEscalating = escalateBusyId === followUp.id ||
            isThreadFollowUpGuidancePending(followUp, { queuePaused, threadActive });
          // Paused queues also let an already-escalated row be clicked: it is stuck
          // there, so the click means "send this one now".
          const canEscalate = canEscalateThreadFollowUp({
            priority: followUp.priority,
            coreSupportsEscalate: allowEscalate,
            queuePaused,
          });

          return (
            <div
              key={followUp.id}
              className={`follow-up-row${draggedId === followUp.id ? " is-dragging" : ""}${isEditing ? " is-editing" : ""}`}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault();
                moveDraggedBefore(followUp.id);
                setDraggedId(undefined);
              }}
            >
              <div
                className="follow-up-card-main follow-up-card-main-editable"
                role="button"
                tabIndex={actionBusy ? -1 : 0}
                aria-label={isEditing ? t("thread.followUpEditing") : t("thread.editFollowUpAria")}
                title={isEditing ? t("thread.followUpEditing") : t("thread.editFollowUp")}
                onClick={() => {
                  if (!actionBusy) {
                    onEdit(followUp);
                  }
                }}
                onKeyDown={(event) => {
                  if (actionBusy || (event.key !== "Enter" && event.key !== " ")) {
                    return;
                  }
                  event.preventDefault();
                  onEdit(followUp);
                }}
              >
                <span
                  className="follow-up-card-drag-handle"
                  draggable={!actionBusy && !isEditing}
                  role="button"
                  tabIndex={actionBusy || isEditing ? -1 : 0}
                  aria-label={t("thread.reorderFollowUpAria")}
                  title={t("thread.reorderFollowUp")}
                  onClick={(event) => event.stopPropagation()}
                  onDragStart={(event) => {
                    if (isEditing) {
                      event.preventDefault();
                      return;
                    }
                    event.stopPropagation();
                    setDraggedId(followUp.id);
                    event.dataTransfer.effectAllowed = "move";
                  }}
                  onDragEnd={() => setDraggedId(undefined)}
                >
                  <GripVertical size={14} aria-hidden />
                </span>
                <FollowUpPromptPreview followUp={followUp} />
              </div>
              <div className="follow-up-card-actions">
                {isEditing ? (
                  <span className="follow-up-card-editing-badge">{t("thread.followUpEditing")}</span>
                ) : (
                  <>
                    {allowEscalate ? (
                      isEscalating ? (
                        <span className="follow-up-card-type" role="status" aria-live="polite" aria-busy="true">
                          <LoaderCircle size={11} className="spinning" aria-hidden />
                          {t("thread.followUpSending")}
                        </span>
                      ) : canEscalate ? (
                        <span
                          className="follow-up-card-type follow-up-card-type-action"
                          role="button"
                          tabIndex={actionBusy ? -1 : 0}
                          aria-disabled={actionBusy}
                          aria-label={t("thread.followUpNowAria")}
                          title={t("thread.followUpNow")}
                          onClick={() => {
                            if (!actionBusy) {
                              onEscalate(followUp);
                            }
                          }}
                          onKeyDown={(event) => {
                            if (actionBusy || (event.key !== "Enter" && event.key !== " ")) {
                              return;
                            }
                            event.preventDefault();
                            onEscalate(followUp);
                          }}
                        >
                          <CornerDownRight size={11} aria-hidden />
                          {t("thread.guide")}
                        </span>
                      ) : (
                        <span className="follow-up-card-type">
                          <CornerDownRight size={11} aria-hidden />
                          {t("thread.guide")}
                        </span>
                      )
                    ) : null}
                    <FollowUpActionsMenu
                      busy={actionBusy}
                      label={t("thread.followUpActions")}
                      items={[
                        {
                          id: "edit", label: t("thread.editFollowUp"),
                          icon: <Pencil size={14} />, onSelect: () => onEdit(followUp),
                        },
                        ...(canEscalate ? [{
                          id: "guide", label: t("thread.guide"),
                          icon: <CornerDownRight size={14} />, onSelect: () => onEscalate(followUp),
                        }] : []),
                        {
                          id: "todo", label: t("thread.followUpToTodo"),
                          icon: <ListTodo size={14} />, onSelect: () => onMoveToTodo(followUp),
                        },
                        {
                          id: "delete", label: t("common.delete"),
                          icon: <Trash2 size={14} />, onSelect: () => onCancel(followUp),
                        },
                      ]}
                    />
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function FollowUpActionsMenu({
  busy,
  label,
  items,
}: {
  busy: boolean;
  label: string;
  items: Parameters<typeof BrowserToolbarMenu>[0]["items"];
}) {
  const [trigger, setTrigger] = useState<HTMLButtonElement>();
  return (
    <>
      <button
        type="button"
        className="follow-up-card-action"
        disabled={busy}
        title={label}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={Boolean(trigger) && !busy}
        onClick={(event) => setTrigger(trigger ? undefined : event.currentTarget)}
      >
        {busy ? <Activity size={12} aria-hidden /> : <MoreHorizontal size={14} aria-hidden />}
      </button>
      {trigger && !busy ? (
        <BrowserToolbarMenu
          trigger={trigger}
          label={label}
          items={items}
          focusOnOpen
          onClose={() => setTrigger(undefined)}
        />
      ) : null}
    </>
  );
}
