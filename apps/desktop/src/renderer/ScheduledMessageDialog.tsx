import { ChevronDown, Clock3, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ThreadSummary } from "../shared/ipc";
import type { ScheduleCreateInput, ScheduleDefinition, ScheduleOccurrence } from "../shared/scheduling";
import { initialScheduledMessageForm, scheduledMessageLatenessFor, scheduledMessageName, scheduledMessageTriggerFor, type ScheduledMessageForm } from "./scheduled-message-form";
import { ScheduleDurationField } from "./ScheduleDurationField";
import "./scheduling.css";

export function ScheduledMessageDialog({ thread, definition, occurrences, onClose, onSaved }: {
  thread: ThreadSummary;
  definition?: ScheduleDefinition | undefined;
  occurrences: readonly ScheduleOccurrence[];
  onClose(): void;
  onSaved(): void;
}) {
  const { t, i18n } = useTranslation();
  const dialogRef = useRef<HTMLDivElement>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const preparedCreate = useRef<{ formKey: string; input: ScheduleCreateInput } | null>(null);
  const [form, setForm] = useState(() => initialScheduledMessageForm(definition));
  const [advanced, setAdvanced] = useState(() => Boolean(definition && definition.trigger.type !== "at"));
  // The open/closed choice the user made themselves, if any; otherwise the send type drives it.
  const advancedManual = useRef<boolean | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<string[]>([]);
  const update = (value: Partial<typeof form>) => { setForm(current => ({ ...current, ...value })); setPreview([]); setError(""); };
  const formatTime = (at: string) => new Date(at).toLocaleString(i18n.language);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    promptRef.current?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);

  async function save() {
    setBusy(true); setError("");
    try {
      const api = window.eco!;
      const common = { name: scheduledMessageName(form), prompt: form.prompt, maxLatenessSeconds: scheduledMessageLatenessFor(form) };
      if (definition) await api.updateSchedule({ id: definition.id, expectedRevision: definition.revision, enabled: form.enabled, trigger: scheduledMessageTriggerFor(form), ...common });
      else {
        // Keep both the request ID and absolute deadline stable if an IPC response is lost.
        const formKey = JSON.stringify(form);
        if (preparedCreate.current?.formKey !== formKey) preparedCreate.current = {
          formKey, input: { kind: "session_message", requestId: crypto.randomUUID(), threadId: thread.id, trigger: scheduledMessageTriggerFor(form), ...common },
        };
        await api.createSchedule(preparedCreate.current.input);
      }
      onSaved();
    } catch (caught) { setError(String(caught)); }
    finally { setBusy(false); }
  }

  async function previewTimes() {
    setBusy(true); setError("");
    try { setPreview(await window.eco!.previewSchedule(scheduledMessageTriggerFor(form))); }
    catch (caught) { setError(String(caught)); }
    finally { setBusy(false); }
  }

  const history = definition ? occurrences.filter(item => item.scheduleId === definition.id).slice(0, 5) : [];
  return <div className="scheduling-backdrop" onClick={() => { if (!busy) onClose(); }}>
    <div className="scheduling-panel scheduled-message-dialog" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="scheduled-message-title" onClick={event => event.stopPropagation()}
      onKeyDown={event => {
        if (event.key === "Escape" && !busy) { event.stopPropagation(); onClose(); }
        if (event.key !== "Tab") return;
        const nodes = dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled)');
        const first = nodes?.[0], last = nodes?.[nodes.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }}>
      <header className="scheduling-header"><div>
        <h2 id="scheduled-message-title"><Clock3 size={20}/>{t(definition ? "scheduling.editMessage" : "scheduling.addMessage")}</h2>
        <p>{thread.title}</p>
      </div><button disabled={busy} className="scheduling-icon" onClick={onClose} aria-label={t("common.close")}><X size={20}/></button></header>
      <main className="scheduling-detail">
        <p className="scheduling-hint">{t("scheduling.messageHint")}</p>
        {error && <p className="scheduling-error" role="alert">{error}</p>}
        <form onSubmit={event => { event.preventDefault(); void save(); }}>
          <fieldset disabled={busy}>
            <label>{t("scheduling.messageContent")}<textarea ref={promptRef} required rows={4} value={form.prompt} placeholder={t("scheduling.messagePlaceholder")} onChange={event => update({ prompt: event.target.value })}/></label>
            <label>{t("scheduling.sendTiming")}<select value={form.timingMode} onChange={event => {
              const timingMode = event.target.value as ScheduledMessageForm["timingMode"];
              update({ timingMode });
              // Repeating sends need the catch-up window and preview, so reveal them right away.
              if (timingMode === "interval" || timingMode === "cron") setAdvanced(true);
              else setAdvanced(advancedManual.current ?? false);
            }}>
              <option value="delay">{t("scheduling.delayMode")}</option><option value="schedule">{t("scheduling.atMode")}</option>
              <option value="interval">{t("scheduling.interval")}</option><option value="cron">{t("scheduling.cronTiming")}</option>
            </select></label>
            {form.timingMode === "delay" || form.timingMode === "interval" ? <ScheduleDurationField label={t(form.timingMode === "delay" ? "scheduling.sendAfter" : "scheduling.repeatInterval")} value={form.duration} minSeconds={60} suffix={form.timingMode === "delay" ? t("scheduling.afterSend") : undefined} onChange={duration => update({ duration })}/> : null}
            {form.timingMode === "schedule" || form.timingMode === "interval" ? <label>{t(form.timingMode === "interval" ? "scheduling.firstSendTime" : "scheduling.sendTime")}<input type="datetime-local" step={1} required value={form.at} onChange={event => update({ at: event.target.value })}/></label> : null}
            {form.timingMode === "cron" ? <div className="scheduling-fields">
              <label>{t("scheduling.cron")}<input required value={form.cron} onChange={event => update({ cron: event.target.value })}/></label>
              <label>{t("scheduling.timezone")}<input required value={form.timezone} onChange={event => update({ timezone: event.target.value })}/></label>
            </div> : null}
            <button type="button" className="scheduled-message-advanced-toggle" aria-expanded={advanced} aria-controls="scheduled-message-advanced" onClick={() => { const next = !advanced; advancedManual.current = next; setAdvanced(next); }}><ChevronDown size={14} className={advanced ? "expanded" : undefined}/>{t("scheduling.advanced")}</button>
            {advanced && <div id="scheduled-message-advanced" className="scheduled-message-advanced">
              {definition && <label className="scheduling-enabled-field"><input type="checkbox" checked={form.enabled} onChange={event => update({ enabled: event.target.checked })}/>{t("scheduling.enableSchedule")}</label>}
              <label>{t("scheduling.optionalName")}<input maxLength={200} value={form.name} placeholder={t("scheduling.autoName")} onChange={event => update({ name: event.target.value })}/></label>
              <ScheduleDurationField label={t("scheduling.messageCatchUp")} value={form.lateness} minSeconds={0} maxSeconds={86400} onChange={lateness => update({ lateness })}/>
              <p className="scheduling-hint">{t("scheduling.messageCatchUpHint")}</p>
              <button type="button" onClick={() => void previewTimes()}>{t("scheduling.preview")}</button>
              {preview.length > 0 && <ul className="scheduling-preview">{preview.map(at => <li key={at}>{formatTime(at)}</li>)}</ul>}
              {history.length > 0 && <section className="scheduling-history"><h3>{t("scheduling.history")}</h3>{history.map(item => <div className="scheduling-run" key={item.id}><div>
                <strong>{formatTime(item.scheduledAt)}</strong><span className="scheduling-badge">{t(`scheduling.status.${item.status}`)}</span>{item.error && <p>{item.error}</p>}
              </div></div>)}</section>}
            </div>}
            <div className="scheduling-form-actions"><button className="scheduling-primary" type="submit">{t(busy ? "scheduling.saving" : definition ? "scheduling.save" : "scheduling.scheduleSend")}</button></div>
          </fieldset>
        </form>
      </main>
    </div>
  </div>;
}
