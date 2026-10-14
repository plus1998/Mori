import { Clock3, Pause, Pencil, Play, Send, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { ScheduleDefinition, ScheduleOccurrence } from "../shared/scheduling";
import { isExpiredOneShotSchedule } from "../shared/scheduling";
import { formatIpcInvokeError } from "./AppMessage";
import { scheduleIntervalLabel } from "./schedule-form";

export function ScheduledMessagesCardBody({ messages, occurrences, onEdit, onRefresh, onError }: {
  messages: readonly ScheduleDefinition[];
  occurrences: readonly ScheduleOccurrence[];
  onEdit?: ((message: ScheduleDefinition) => void) | undefined;
  onRefresh?: (() => Promise<void>) | undefined;
  onError?: ((message: string) => void) | undefined;
}) {
  const { t, i18n } = useTranslation();
  const [busy, setBusy] = useState(false);
  const labelInterval = (seconds: number) => { const interval = scheduleIntervalLabel(seconds); return t(interval.key, interval.options); };
  const [expiredToResume, setExpiredToResume] = useState<ScheduleDefinition>();
  const confirmButtonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (expiredToResume) confirmButtonRef.current?.focus(); }, [expiredToResume]);
  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    try { await action(); await onRefresh?.(); }
    catch (caught) { onError?.(formatIpcInvokeError(caught)); }
    finally { setBusy(false); }
  }
  function toggleEnabled(message: ScheduleDefinition) {
    // A passed one-shot has no future date to re-arm, so resuming can only mean sending it now.
    if (isExpiredOneShotSchedule(message)) { setExpiredToResume(message); return; }
    void run(() => window.eco!.updateSchedule({ id: message.id, expectedRevision: message.revision, enabled: !message.enabled }));
  }
  function sendExpiredMessageNow(message: ScheduleDefinition) {
    setExpiredToResume(undefined);
    void run(() => window.eco!.runScheduleNow({ id: message.id, requestId: crypto.randomUUID() }));
  }
  return <div className="workspace-scheduled-messages">
    {messages.map(message => {
      const latest = occurrences.find(item => item.scheduleId === message.id);
      const active = latest && ["pending", "dispatching", "running", "waiting_user"].includes(latest.status);
      const status = active ? `scheduling.status.${latest.status}` : message.error ? "scheduling.needsAttention" : message.enabled ? "scheduling.enabled" : "scheduling.paused";
      const time = message.nextRunAt ?? (message.trigger.type === "at" ? message.trigger.at : undefined);
      return <article key={message.id} className="workspace-scheduled-message">
        <div className="workspace-scheduled-message-heading"><Clock3 size={14} aria-hidden/><strong title={message.name}>{message.name}</strong><span>{t(status)}</span></div>
        {time && <time dateTime={time}>{new Date(time).toLocaleString(i18n.language)}</time>}
        {message.trigger.type !== "at" && <small>{message.trigger.type === "cron" ? `${message.trigger.expression} · ${message.trigger.timezone}` : labelInterval(message.trigger.everySeconds)}</small>}
        {message.prompt !== message.name && <p className="workspace-scheduled-message-content" title={message.prompt}>{message.prompt}</p>}
        {message.error && <p className="workspace-scheduled-message-error">{message.error}</p>}
        <div className="workspace-scheduled-message-actions">
          <button type="button" disabled={busy} onClick={() => onEdit?.(message)} aria-label={t("scheduling.editNamed", { name: message.name })} title={t("scheduling.edit")}><Pencil size={13}/></button>
          <button type="button" disabled={busy} onClick={() => toggleEnabled(message)} aria-label={t(message.enabled ? "scheduling.pauseNamed" : "scheduling.resumeNamed", { name: message.name })} title={t(message.enabled ? "scheduling.pause" : "scheduling.resume")}>{message.enabled ? <Pause size={13}/> : <Play size={13}/>}</button>
          <button type="button" disabled={busy} onClick={() => void run(() => window.eco!.runScheduleNow({ id: message.id, requestId: crypto.randomUUID() }))} aria-label={t("scheduling.runNowNamed", { name: message.name })} title={t("scheduling.runNow")}><Send size={13}/></button>
          <button type="button" disabled={busy} onClick={() => void run(() => window.eco!.deleteSchedule(message.id))} aria-label={t("scheduling.deleteNamed", { name: message.name })} title={t("common.delete")}><Trash2 size={13}/></button>
        </div>
      </article>;
    })}
    {expiredToResume && createPortal(<div className="scheduling-backdrop" onClick={() => { if (!busy) setExpiredToResume(undefined); }}>
      <div className="scheduling-panel scheduled-message-resume-confirm" role="alertdialog" aria-modal="true" aria-labelledby="scheduled-message-resume-title"
        onClick={event => event.stopPropagation()}
        onKeyDown={event => { if (event.key === "Escape" && !busy) setExpiredToResume(undefined); }}>
        <header className="scheduling-header"><h2 id="scheduled-message-resume-title"><Clock3 size={18}/>{t("scheduling.resumeExpiredTitle")}</h2></header>
        <main className="scheduling-detail">
          <p>{t("scheduling.resumeExpiredBody")}</p>
          <div className="scheduling-form-actions">
            <button type="button" disabled={busy} onClick={() => setExpiredToResume(undefined)}>{t("common.cancel")}</button>
            <button ref={confirmButtonRef} type="button" className="scheduling-primary" disabled={busy} onClick={() => sendExpiredMessageNow(expiredToResume)}>{t("scheduling.iUnderstand")}</button>
          </div>
        </main>
      </div>
    </div>, document.body)}
  </div>;
}
