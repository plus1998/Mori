import { Clock3, Pencil, RefreshCw, Trash2 } from "lucide-react";
import { useState } from "react";
import { moriScheduledActionLabel } from "../shared/mori-scheduled-action";
import type { ScheduleDefinition, ScheduleOccurrence } from "../shared/scheduling";
import { localScheduleDate } from "./schedule-form";

export function MoriScheduledCards({
  schedules,
  occurrences,
  onChanged,
}: {
  schedules: ScheduleDefinition[];
  occurrences: ScheduleOccurrence[];
  onChanged(): Promise<void>;
}) {
  const [editing, setEditing] = useState("");
  const [at, setAt] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const records = new Map<string, { definition: ScheduleDefinition; occurrence?: ScheduleOccurrence }>();
  for (const occurrence of occurrences)
    if (!records.has(occurrence.scheduleId))
      records.set(occurrence.scheduleId, { definition: occurrence.definition, occurrence });
  for (const definition of schedules)
    records.set(definition.id, { ...records.get(definition.id), definition });
  if (!records.size) return null;
  async function action(id: string, work: () => Promise<unknown>) {
    if (busy) return;
    setBusy(id);
    setError("");
    try {
      await work();
      await onChanged();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy("");
    }
  }
  return (
    <section className="mori-schedules" aria-label="Mori 定时安排">
      <h3>
        <Clock3 size={15} />
        定时安排
      </h3>
      {error && <p role="alert">{error}</p>}
      {[...records.values()]
        .sort((a, b) => b.definition.createdAt.localeCompare(a.definition.createdAt))
        .slice(0, 8)
        .map(({ definition, occurrence }) => {
          const live = schedules.some((item) => item.id === definition.id);
          const notification = occurrence?.assistant?.notification;
          const status = occurrence
            ? {
                pending: "等待 Mori 执行",
                dispatching: "正在投递",
                running:
                  occurrence.assistant?.phase === "queued"
                    ? "等待 Mori 执行"
                    : occurrence.assistant?.agents?.length
                      ? "Agent 执行中"
                      : "正在执行",
                waiting_user: "等待你处理",
                completed: "已完成",
                failed: "执行失败",
                skipped: "已错过执行时间",
                unknown: "执行状态不确定",
                cancelled: "已取消",
              }[occurrence.status]
            : definition.enabled && live
              ? "等待触发"
              : live
                ? "已暂停"
                : "已取消";
          const targetId =
            definition.action?.type === "check_task"
              ? definition.action.taskThreadId
              : definition.action?.type === "execute"
                ? definition.action.agentThreadId
                : undefined;
          return (
            <article key={definition.id}>
              <strong>{definition.name}</strong>
              <span>
                {definition.action ? moriScheduledActionLabel(definition.action) : "定时操作"} · {status}
              </span>
              <time>
                {new Date(
                  definition.trigger.type === "at" ? definition.trigger.at : definition.createdAt,
                ).toLocaleString()}
              </time>
              <small>
                通知：{definition.notification?.channel === "wechat" ? "微信" : "桌面"}
                {notification
                  ? ` · ${{ sending: "正在发送", sent: "已发送", failed: "发送失败", unknown: "送达状态不确定" }[notification.status]}`
                  : ""}
              </small>
              {occurrence?.error && <p role="status">{occurrence.error}</p>}
              {notification?.error && <p role="status">{notification.error}</p>}
              <div className="mori-schedule-actions">
                {live && (
                  <button
                    type="button"
                    disabled={!!busy}
                    onClick={() => {
                      setEditing(definition.id);
                      setAt(
                        localScheduleDate(
                          definition.trigger.type === "at" ? definition.trigger.at : new Date().toISOString(),
                        ),
                      );
                    }}
                  >
                    <Pencil size={13} />
                    修改时间
                  </button>
                )}
                {live && (
                  <button
                    type="button"
                    disabled={!!busy}
                    onClick={() =>
                      void action(definition.id, () =>
                        window.eco!.deleteSchedule(definition.id, definition.revision),
                      )
                    }
                  >
                    <Trash2 size={13} />
                    取消安排
                  </button>
                )}
                {targetId && (
                  <button
                    type="button"
                    onClick={() =>
                      void action(definition.id, () => window.eco!.moriAssistantOpenTask(targetId))
                    }
                  >
                    查看目标任务
                  </button>
                )}
                {occurrence && notification && ["failed", "unknown"].includes(notification.status) && (
                  <button
                    type="button"
                    disabled={!!busy}
                    onClick={() =>
                      void action(definition.id, () => window.eco!.retryScheduleNotification(occurrence.id))
                    }
                  >
                    <RefreshCw size={13} />
                    {notification.status === "unknown" ? "重发通知（可能重复）" : "重试通知"}
                  </button>
                )}
              </div>
              {editing === definition.id && (
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    void action(definition.id, async () => {
                      const date = new Date(at);
                      if (!Number.isFinite(date.getTime()) || date.getTime() <= Date.now())
                        throw new Error("请选择未来的时间。");
                      await window.eco!.updateSchedule({
                        id: definition.id,
                        expectedRevision: definition.revision,
                        enabled: true,
                        trigger: { type: "at", at: date.toISOString() },
                      });
                      setEditing("");
                    });
                  }}
                >
                  <label>
                    新的提醒时间
                    <input
                      required
                      type="datetime-local"
                    step={1}
                      value={at}
                      onChange={(event) => setAt(event.target.value)}
                    />
                  </label>
                  <button type="submit" disabled={!!busy}>
                    保存
                  </button>
                  <button type="button" onClick={() => setEditing("")}>
                    返回
                  </button>
                </form>
              )}
            </article>
          );
        })}
    </section>
  );
}
