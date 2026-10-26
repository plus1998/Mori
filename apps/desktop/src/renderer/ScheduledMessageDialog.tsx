import { ArrowLeft, ChevronDown, Clock3, LoaderCircle, X } from "lucide-react";
import { useEffect, useRef, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import type { PromptImageAttachment } from "../shared/ipc";
import type { ScheduleCreateInput, ScheduleDefinition, ScheduleOccurrence, ScheduledMessageNewThread, ScheduledPlanApproval } from "../shared/scheduling";
import { initialScheduledMessageForm, scheduledMessageLatenessFor, scheduledMessageName, scheduledMessageTriggerFor, type ScheduledMessageForm } from "./scheduled-message-form";
import { ComposerAbovePanel } from "./ComposerAbovePanel";
import { ScheduleDurationField } from "./ScheduleDurationField";
import { fromPromptImageAttachments, hydrateComposerImageAttachments, revokeComposerAttachmentPreviews, type ComposerImageAttachment } from "./composer-attachments";
import { stageScheduledMessageImages } from "./scheduled-message-attachments";
import { CodexQuotaMonitor, type CodexQuotaReminderSnapshot } from "./codex-quota-reminder";
import { nextScheduledMessageQuotaReset } from "./scheduled-message-quota";
import { localScheduleDate } from "./schedule-form";
import "./scheduling.css";

export function ScheduledMessageDialog({ threadId, newThread, planApproval: initialPlanApproval, usesChatGptLogin = false, initialPrompt = "", initialAttachments = [], imageContextKey, definition, occurrences, onClose, onSaved, anchorRef, triggerRef, onBack }: {
  threadId: string;
  newThread?: ScheduledMessageNewThread | undefined;
  planApproval?: ScheduledPlanApproval | undefined;
  usesChatGptLogin?: boolean;
  initialPrompt?: string | undefined;
  initialAttachments?: readonly ComposerImageAttachment[] | undefined;
  imageContextKey?: string | undefined;
  anchorRef?: RefObject<HTMLElement | null> | undefined;
  triggerRef?: RefObject<HTMLElement | null> | undefined;
  onBack?: (() => void) | undefined;
  definition?: ScheduleDefinition | undefined;
  occurrences: readonly ScheduleOccurrence[];
  onClose(): void;
  onSaved(): void | Promise<void>;
}) {
  const { t, i18n } = useTranslation();
  const planApproval = definition?.planApproval ?? initialPlanApproval;
  const title = t(planApproval ? "approval.plan.scheduleExecution" : definition ? "scheduling.editMessage" : "scheduling.addMessage");
  const dialogRef = useRef<HTMLDivElement>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const timingRef = useRef<HTMLSelectElement>(null);
  const preparedCreate = useRef<{ formKey: string; input: ScheduleCreateInput } | null>(null);
  const [form, setForm] = useState(() => ({ ...initialScheduledMessageForm(definition), ...(!definition ? { prompt: initialPrompt } : {}) }));
  const [images, setImages] = useState(() => definition
    ? fromPromptImageAttachments(definition.attachments ?? [])
    : initialAttachments.map(image => ({ ...image, previewUrl: "" })));
  const initialImages = useRef(images);
  const imagePreviews = useRef<ComposerImageAttachment[]>([]);
  const uploadedImages = useRef(new Map<string, PromptImageAttachment>());
  const contextKey = imageContextKey ?? `thread:${threadId}`;
  const [advanced, setAdvanced] = useState(() => Boolean(definition && definition.trigger.type !== "at"));
  // The open/closed choice the user made themselves, if any; otherwise the send type drives it.
  const advancedManual = useRef<boolean | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<string[]>([]);
  const quotaMonitor = useRef<CodexQuotaMonitor | undefined>(undefined);
  const quotaSnapshotRef = useRef<CodexQuotaReminderSnapshot | undefined>(undefined);
  const quotaErrorRef = useRef<string | undefined>(undefined);
  const [quotaSnapshot, setQuotaSnapshot] = useState<CodexQuotaReminderSnapshot>();
  const [quotaLoading, setQuotaLoading] = useState(false);
  const [quotaError, setQuotaError] = useState<string>();
  const showQuotaReset = usesChatGptLogin && !definition;
  const quotaResetAt = quotaSnapshot ? nextScheduledMessageQuotaReset(quotaSnapshot.quota) : undefined;
  const update = (value: Partial<typeof form>) => { setForm(current => ({ ...current, ...value })); setPreview([]); setError(""); };
  const formatTime = (at: string) => new Date(at).toLocaleString(i18n.language);

  useEffect(() => {
    const api = window.eco;
    if (!showQuotaReset || !api) return;
    const monitor = new CodexQuotaMonitor(api, {
      enabled: () => true,
      onChange: (snapshot) => {
        quotaSnapshotRef.current = snapshot;
        setQuotaSnapshot(snapshot);
        quotaErrorRef.current = undefined;
        setQuotaError(undefined);
      },
      onError: (message) => {
        quotaErrorRef.current = message;
        setQuotaError(message);
      },
    });
    quotaMonitor.current = monitor;
    const unsubscribe = api.onOpenAIAccountsChanged(() => { void monitor.accountsChanged(); });
    setQuotaLoading(true);
    void monitor.refresh().finally(() => {
      if (quotaMonitor.current === monitor) setQuotaLoading(false);
    });
    return () => {
      quotaMonitor.current = undefined;
      quotaSnapshotRef.current = undefined;
      unsubscribe();
      monitor.dispose();
    };
  }, [showQuotaReset]);

  async function selectQuotaReset() {
    const monitor = quotaMonitor.current;
    if (!monitor || quotaLoading) return;
    setQuotaLoading(true);
    setQuotaError(undefined);
    quotaErrorRef.current = undefined;
    // Choosing this shortcut explicitly refreshes the current account once.
    await monitor.refresh(true);
    if (quotaMonitor.current !== monitor) return;
    const snapshot = quotaSnapshotRef.current;
    const at = snapshot && !snapshot.switching ? nextScheduledMessageQuotaReset(snapshot.quota) : undefined;
    if (!quotaErrorRef.current) {
      if (at) update({ timingMode: "schedule", at: localScheduleDate(at), originalAt: at });
      else setQuotaError(t("scheduling.quotaResetUnavailable"));
    }
    setQuotaLoading(false);
  }

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    if (planApproval) timingRef.current?.focus();
    else promptRef.current?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);

  useEffect(() => {
    let cancelled = false;
    for (const image of initialImages.current.filter(item => !item.previewUrl)) {
      void hydrateComposerImageAttachments([image], contextKey, request => window.eco!.readPromptImageChunk(request))
        .then(([loaded]) => {
          if (!loaded) return;
          if (!loaded.previewUrl) throw new Error("图片预览不可用 / Image preview is unavailable");
          if (cancelled) { revokeComposerAttachmentPreviews([loaded]); return; }
          imagePreviews.current.push(loaded);
          setImages(current => current.map(item => item.id === image.id ? loaded : item));
        }).catch(caught => { if (!cancelled) setError(String(caught)); });
    }
    return () => { cancelled = true; };
  }, [contextKey]);
  useEffect(() => () => revokeComposerAttachmentPreviews(imagePreviews.current), []);

  async function save() {
    setBusy(true); setError("");
    try {
      const api = window.eco!;
      const attachments = await stageScheduledMessageImages(images, contextKey, request => api.stagePromptImage(request), uploadedImages.current);
      const common = { name: scheduledMessageName(form) || (attachments.length ? t("scheduling.imageMessage") : ""), prompt: form.prompt, attachments, maxLatenessSeconds: scheduledMessageLatenessFor(form) };
      if (definition) await api.updateSchedule({ id: definition.id, expectedRevision: definition.revision, enabled: form.enabled, trigger: scheduledMessageTriggerFor(form), ...common });
      else {
        // Keep both the request ID and absolute deadline stable if an IPC response is lost.
        const formKey = JSON.stringify({ form, attachments, threadId, newThread, planApproval });
        if (preparedCreate.current?.formKey !== formKey) preparedCreate.current = {
          formKey, input: { kind: "session_message", requestId: crypto.randomUUID(), threadId, ...(newThread ? { newThread } : {}), ...(planApproval ? { planApproval } : {}), trigger: scheduledMessageTriggerFor(form), ...common },
        };
        await api.createSchedule(preparedCreate.current.input);
      }
      await onSaved();
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
  const content = <div className="scheduling-panel scheduled-message-dialog" ref={dialogRef} role={anchorRef ? undefined : "dialog"} aria-modal={anchorRef ? undefined : true} aria-labelledby="scheduled-message-title" onClick={event => event.stopPropagation()}
      onKeyDown={event => {
        if (!anchorRef && event.key === "Escape" && !busy) { event.stopPropagation(); onClose(); }
        if (anchorRef || event.key !== "Tab") return;
        const nodes = dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled)');
        const first = nodes?.[0], last = nodes?.[nodes.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }}>
      <header className="scheduling-header">
        {anchorRef && onBack ? <button type="button" disabled={busy} className="scheduling-icon" aria-label={t("composer.plus.back")} onClick={onBack}><ArrowLeft size={18}/></button> : null}
        <div>
        <h2 id="scheduled-message-title"><Clock3 size={20}/>{title}</h2>
      </div><button disabled={busy} className="scheduling-icon" onClick={onClose} aria-label={t("common.close")}><X size={20}/></button></header>
      <main className="scheduling-detail">
        {error && <p className="scheduling-error" role="alert">{error}</p>}
        {newThread && <p className="scheduling-hint">{t("scheduling.newConversationHint")}</p>}
        {planApproval && <p className="scheduling-hint">{t("approval.plan.scheduleHint")}</p>}
        <form id="scheduled-message-form" onSubmit={event => { event.preventDefault(); void save(); }}>
          <fieldset disabled={busy || quotaLoading}>
            <label>{t(planApproval ? "approval.plan.title" : "scheduling.messageContent")}<textarea data-panel-autofocus={planApproval ? undefined : true} ref={promptRef} readOnly={Boolean(planApproval)} required={!images.length} rows={anchorRef ? 3 : 4} value={form.prompt} placeholder={t("scheduling.messagePlaceholder")} onChange={event => update({ prompt: event.target.value })}/></label>
            {images.length > 0 && <ul className="composer-attachments" aria-label={t("app.pastedImages")}>
              {images.map((image, index) => <li key={image.id} className="composer-attachment">
                {image.previewUrl ? <img className="scheduled-message-image" src={image.previewUrl} alt={`${t("app.pastedImages")} ${index + 1}`}/> : <span className="composer-attachment-preview-missing">{t("app.imagePreviewUnavailable")}</span>}
                <button type="button" className="composer-attachment-remove" aria-label={t("app.removeImage")} onClick={() => setImages(current => current.filter(item => item.id !== image.id))}><X size={14}/></button>
              </li>)}
            </ul>}
            <label>{t(planApproval ? "approval.plan.executionTime" : "scheduling.sendTiming")}<select ref={timingRef} data-panel-autofocus={planApproval ? true : undefined} value={form.timingMode} onChange={event => {
              const timingMode = event.target.value as ScheduledMessageForm["timingMode"];
              update({ timingMode });
              // Repeating sends need the catch-up window and preview, so reveal them right away.
              if (timingMode === "interval" || timingMode === "cron") setAdvanced(true);
              else setAdvanced(advancedManual.current ?? false);
            }}>
              <option value="delay">{t(planApproval ? "approval.plan.delayExecution" : "scheduling.delayMode")}</option><option value="schedule">{t("scheduling.atMode")}</option>
              {!planApproval && <><option value="interval">{t("scheduling.interval")}</option><option value="cron">{t("scheduling.cronTiming")}</option></>}
            </select></label>
            {showQuotaReset ? <div className="scheduled-message-quota-reset">
              <button type="button" aria-busy={quotaLoading} onClick={() => void selectQuotaReset()}>
                {quotaLoading ? <LoaderCircle size={14} className="mcp-spin"/> : <Clock3 size={14}/>}{t("scheduling.atQuotaReset")}
              </button>
              {quotaResetAt ? <span className="scheduling-hint">{formatTime(quotaResetAt)}</span> : null}
              {quotaError ? <p className="scheduling-error" role="alert">{quotaError}</p> : null}
            </div> : null}
            {form.timingMode === "delay" || form.timingMode === "interval" ? <ScheduleDurationField label={t(planApproval ? "approval.plan.executeAfter" : form.timingMode === "delay" ? "scheduling.sendAfter" : "scheduling.repeatInterval")} value={form.duration} minSeconds={60} suffix={form.timingMode === "delay" ? t(planApproval ? "approval.plan.afterExecute" : "scheduling.afterSend") : undefined} onChange={duration => update({ duration })}/> : null}
            {form.timingMode === "schedule" || form.timingMode === "interval" ? <label>{t(planApproval ? "approval.plan.executionTime" : form.timingMode === "interval" ? "scheduling.firstSendTime" : "scheduling.sendTime")}<input type="datetime-local" step={1} required value={form.at} onChange={event => update({ at: event.target.value })}/></label> : null}
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
          </fieldset>
        </form>
      </main>
      <footer className="scheduling-form-actions"><button disabled={busy || quotaLoading} form="scheduled-message-form" className="scheduling-primary" type="submit">{t(busy ? "scheduling.saving" : definition ? "scheduling.save" : planApproval ? "approval.plan.scheduleConfirm" : "scheduling.scheduleSend")}</button></footer>
    </div>;
  return anchorRef ? <ComposerAbovePanel anchorRef={anchorRef} triggerRef={triggerRef} className="composer-schedule-panel" label={title} onClose={() => { if (!busy) onClose(); }}>{content}</ComposerAbovePanel>
    : <div className="scheduling-backdrop" onClick={() => { if (!busy) onClose(); }}>{content}</div>;
}
