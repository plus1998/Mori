import { ArrowLeft, Clock3, ExternalLink, Folder, Pause, Pencil, Play, Plus, RefreshCw, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { CoreKind } from "@eco/runtime/core-runtime";
import type { CandidateModelView, CursorModelOption, ModelSettingsSnapshot, WorkflowSettingsSnapshot } from "../shared/ipc";
import { materializeThreadOrchestrationSnapshot } from "../shared/thread-runtime-config";
import { buildAcpThreadRuntimeConfig, buildThreadRuntimeConfigFromDefaults, resolveThreadOrchestrationSnapshot } from "../shared/thread-runtime-config";
import type { ScheduleDefinition, ScheduleExecutionProfile, ScheduleTrigger, SchedulingSnapshot } from "../shared/scheduling";
import { coreDisplayName, coreIconSrc } from "./SidebarCoreSelector";
import { ScheduleTimingFields } from "./ScheduleTimingFields";
import { SchedulingProjectField, projectDisplayName, type SchedulingProjectOption } from "./SchedulingProjectField";
import { ComposerFieldSelect } from "./ComposerFieldSelect";
import { ModelCascadeSelect, type ModelCascadeOption, type ModelCascadeSelection } from "./ModelCascadeSelect";
import { mapAcpModelOptions, resolveAcpVendorNames } from "./model-cascade-options";
import { resolveProviderAccentColor } from "../shared/commit-model-options";
import { formatIpcInvokeError } from "./AppMessage";
import { messageDurationFromSeconds } from "./scheduled-message-form";
import { localScheduleDate as localDate, scheduleCatchUpSeconds, scheduleIntervalDuration, scheduleIntervalLabel, scheduleTriggerFor as triggerFor, type ScheduleTimingForm } from "./schedule-form";
import "./scheduling.css";

interface Props {
  settings: ModelSettingsSnapshot;
  workflow: WorkflowSettingsSnapshot;
  snapshot: SchedulingSnapshot;
  loading: boolean;
  loadError: string;
  onRefresh(): Promise<void>;
  workspacePath?: string | undefined;
  projects: readonly SchedulingProjectOption[];
  defaultProfile?: ScheduleExecutionProfile | undefined;
  onClose(): void;
  onOpenThread(id: string): void;
}
type Form = ScheduleTimingForm & {
  id?: string;
  revision?: number;
  requestId: string;
  name: string;
  prompt: string;
  workspacePath: string;
  profile?: ScheduleExecutionProfile;
  enabled: boolean;
};
const CORE_ORDER = ["claude", "codex", "pi", "acp"] as const;

export function SchedulingPanel(props: Props) {
  const { t, i18n } = useTranslation();
  const api = window.eco!;
  const { snapshot, loading, loadError, onRefresh: refresh } = props;
  const [selectedId, setSelectedId] = useState<string>();
  const [form, setForm] = useState<Form>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<string[]>([]);
  const [candidates, setCandidates] = useState<CandidateModelView[]>([]);
  const [cursorModels, setCursorModels] = useState<CursorModelOption[]>([]);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [modelError, setModelError] = useState("");
  const dialogRef = useRef<HTMLDivElement>(null);
  const initialFocus = useRef<HTMLButtonElement>(null);
  const formatTime = (at: string) => new Date(at).toLocaleString(i18n.language);
  const updateForm = (update: Partial<Form>) => { setForm(current => current ? { ...current, ...update } : current); setPreview([]); setError(""); };

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    initialFocus.current?.focus();
    return () => { previous?.focus(); };
  }, []);
  useEffect(() => {
    let cancelled = false;
    const providers = props.settings.providers.filter(item => item.enabled);
    setModelsLoading(true);
    void Promise.all(providers.map(item => api.listCandidateModels(item.id))).then(rows => {
      if (!cancelled) { setCandidates(rows.flat()); setModelError(""); setModelsLoading(false); }
    }).catch(error => { if (!cancelled) { setModelError(String(error)); setModelsLoading(false); } });
    return () => { cancelled = true; };
  }, [props.settings.providers]);
  useEffect(() => {
    if (form?.profile?.coreKind !== "acp") return;
    let cancelled = false;
    void api.listCursorModels().then(rows => { if (!cancelled) setCursorModels(rows); }).catch(error => { if (!cancelled) setModelError(String(error)); });
    return () => { cancelled = true; };
  }, [form?.profile?.coreKind]);

  const create = () => {
    setError(""); setPreview([]); setSelectedId(undefined);
    setForm({ requestId: crypto.randomUUID(), name: "", prompt: "",
      workspacePath: props.workspacePath ?? "", ...(props.defaultProfile ? { profile: structuredClone(props.defaultProfile) } : {}),
      triggerType: "at", at: localDate(new Date(Date.now() + 3600_000).toISOString()),
      interval: { amount: "1", unit: "hours" }, cron: "0 9 * * *",
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, catchUp: messageDurationFromSeconds(86400), enabled: true,
    });
  };
  const edit = (definition: ScheduleDefinition) => {
    setError(""); setPreview([]);
    const trigger = definition.trigger;
    setForm({ id: definition.id, revision: definition.revision, requestId: crypto.randomUUID(),
      name: definition.name, prompt: definition.prompt, workspacePath: definition.workspacePath ?? "",
      ...(definition.executionProfile ? { profile: structuredClone(definition.executionProfile) } : {}), triggerType: trigger.type,
      at: localDate(trigger.type === "at" ? trigger.at : trigger.type === "interval" ? trigger.anchorAt : new Date(Date.now() + 3600_000).toISOString()),
      interval: scheduleIntervalDuration(trigger.type === "interval" ? trigger.everySeconds : 3600),
      cron: trigger.type === "cron" ? trigger.expression : "0 9 * * *",
      timezone: trigger.type === "cron" ? trigger.timezone : Intl.DateTimeFormat().resolvedOptions().timeZone,
      catchUp: messageDurationFromSeconds(definition.maxLatenessSeconds), enabled: definition.enabled,
    });
  };
  const runAction = async (action: () => Promise<unknown>) => {
    setBusy(true); setError("");
    try { await action(); await refresh(); }
    catch (caught) { setError(formatIpcInvokeError(caught)); }
    finally { setBusy(false); }
  };
  const save = () => {
    if (!form) return;
    void runAction(async () => {
      const trigger = triggerFor(form);
      if (!form.workspacePath.trim()) throw new Error(t("scheduling.projectRequired"));
      const common = { name: form.name, prompt: form.prompt, trigger, maxLatenessSeconds: scheduleCatchUpSeconds(form) };
      let saved: ScheduleDefinition;
      if (!form.profile) throw new Error(t("scheduling.configRequired"));
      if (form.id) saved = await api.updateSchedule({ id: form.id, expectedRevision: form.revision!, enabled: form.enabled, ...common,
        workspacePath: form.workspacePath, executionProfile: form.profile,
      });
      else saved = await api.createSchedule({ kind: "scheduled_task", requestId: form.requestId, workspacePath: form.workspacePath, executionProfile: form.profile, ...common });
      setSelectedId(saved.id); setForm(undefined);
    });
  };
  const selectCore = (coreKind: CoreKind) => {
    if (!form) return;
    setModelError("");
    const base = form.profile ?? props.defaultProfile;
    if (base) { updateForm({ profile: { ...base, coreKind } }); return; }
    try {
      updateForm({ profile: { coreKind, runtimeConfig: coreKind === "acp"
        ? buildAcpThreadRuntimeConfig({ sessionMode: props.workflow.sessionMode, ...(props.workflow.acpCursorModelId ? { cursorModelId: props.workflow.acpCursorModelId } : {}) })
        : buildThreadRuntimeConfigFromDefaults({ settings: props.settings, workflowDefaults: props.workflow }) } });
    } catch (caught) { setError(formatIpcInvokeError(caught, t("scheduling.configRequired"))); }
  };
  const setMainConfig = (id: string) => {
    if (!form) return;
    try {
      const selection = form.profile?.runtimeConfig.orchestrationSelection ?? { mainAgentConfigId: id, mainPrompt: { mode: "builtin" as const }, subagents: { mode: "none" as const } };
      const nextSelection = { ...selection, mainAgentConfigId: id };
      const base = form.profile?.runtimeConfig ?? buildThreadRuntimeConfigFromDefaults({ settings: props.settings, workflowDefaults: props.workflow, orchestrationSelection: nextSelection });
      const { mainAgentModelOverride: _override, ...clean } = base;
      updateForm({ profile: { coreKind: form.profile?.coreKind ?? "claude", runtimeConfig: { ...clean, ...materializeThreadOrchestrationSnapshot(props.settings, nextSelection) } } });
    } catch (caught) { setError(formatIpcInvokeError(caught)); }
  };
  const mainModel = useMemo(() => {
    if (!form?.profile || form.profile.coreKind === "acp") return undefined;
    try {
      const config = form.profile.runtimeConfig;
      const model = resolveThreadOrchestrationSnapshot(props.settings, config)?.mainAgent.modelRef;
      return config.mainAgentModelOverride?.providerId === model?.providerId ? { ...model, ...config.mainAgentModelOverride } : model;
    } catch { return undefined; }
  }, [form?.profile, props.settings]);
  const chooseModel = (selection: ModelCascadeSelection | undefined) => {
    if (!form?.profile || !selection) return;
    if (form.profile.coreKind === "acp") {
      updateForm({ profile: { ...form.profile, runtimeConfig: { ...form.profile.runtimeConfig, cursorModelId: selection.key ?? selection.modelId } } });
      return;
    }
    const candidate = candidates.find(item => item.id === selection.key || (item.providerId === selection.providerId && item.modelId === selection.modelId));
    if (!candidate) return;
    const snapshot = resolveThreadOrchestrationSnapshot(props.settings, form.profile.runtimeConfig);
    if (!snapshot) { setError(t("scheduling.configRequired")); return; }
    const provider = props.settings.providers.find(item => item.id === candidate.providerId);
    const { mainAgentModelOverride: _override, ...base } = form.profile.runtimeConfig;
    updateForm({ profile: { ...form.profile, runtimeConfig: { ...base, resolvedOrchestrationSnapshot: {
      ...snapshot, mainAgent: { ...snapshot.mainAgent, modelRef: { providerId: candidate.providerId, modelId: candidate.modelId,
        ...(provider ? { apiCompat: provider.apiCompat } : {}), ...(candidate.manualSpec ? { manualSpec: candidate.manualSpec } : {}),
        ...(candidate.modelsDevMapping ? { modelsDevMapping: candidate.modelsDevMapping } : {}),
      } },
    } } } });
  };
  const modelOptions = useMemo<ModelCascadeOption[]>(() => form?.profile?.coreKind === "acp"
    ? mapAcpModelOptions(cursorModels, resolveAcpVendorNames(t))
    : candidates.map(candidate => {
        const provider = props.settings.providers.find(item => item.id === candidate.providerId);
        const providerName = provider?.name ?? candidate.providerId;
        return { key: candidate.id, providerId: candidate.providerId, providerName,
          providerColor: resolveProviderAccentColor(providerName), modelId: candidate.modelId,
          label: candidate.displayName ?? candidate.modelId,
          ...(candidate.displayName ? { description: candidate.modelId } : {}) };
      }), [form?.profile?.coreKind, cursorModels, candidates, props.settings.providers, t]);
  const modelValue = !form?.profile ? undefined : form.profile.coreKind === "acp"
    ? (form.profile.runtimeConfig.cursorModelId
      ? { key: form.profile.runtimeConfig.cursorModelId, providerId: "", modelId: form.profile.runtimeConfig.cursorModelId }
      : undefined)
    : (mainModel?.modelId ? { providerId: mainModel.providerId ?? "", modelId: mainModel.modelId } : undefined);
  const selected = snapshot.schedules.find(item => item.kind === "scheduled_task" && item.id === selectedId);
  const items = snapshot.schedules.filter(item => item.kind === "scheduled_task");
  const history = snapshot.occurrences.filter(item => item.definition.kind === "scheduled_task" && (!selectedId || item.scheduleId === selectedId)).slice(0, 30);
  const labelInterval = (seconds: number) => { const interval = scheduleIntervalLabel(seconds); return t(interval.key, interval.options); };
  const labelTrigger = (trigger: ScheduleTrigger) => trigger.type === "at" ? formatTime(trigger.at)
    : trigger.type === "cron" ? `${trigger.expression} · ${trigger.timezone}` : labelInterval(trigger.everySeconds);
  const labelModel = (profile: ScheduleExecutionProfile) => profile.coreKind === "acp"
    ? profile.runtimeConfig.cursorModelId ?? coreDisplayName("acp")
    : profile.runtimeConfig.resolvedOrchestrationSnapshot?.mainAgent.modelRef.modelId ?? coreDisplayName(profile.coreKind);

  return <div className="scheduling-backdrop" onClick={props.onClose}>
    <div className="scheduling-panel" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="scheduling-title" onClick={event => event.stopPropagation()}
      onKeyDown={event => {
        if (event.key === "Escape") props.onClose();
        if (event.key !== "Tab") return;
        const nodes = dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]');
        const first = nodes?.[0], last = nodes?.[nodes.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }}>
      <header className="scheduling-header"><h2 id="scheduling-title"><Clock3 size={20} />{t("scheduling.title")}</h2>
        <button ref={initialFocus} className="scheduling-icon" onClick={props.onClose} aria-label={t("common.close")}><X size={20} /></button>
      </header>
      <div className="scheduling-toolbar">
        <button className="scheduling-icon" onClick={() => void refresh()} aria-label={t("common.refresh")}><RefreshCw size={16} /></button>
        <button className="scheduling-primary" onClick={create} disabled={busy}><Plus size={16} />{t("scheduling.create")}</button>
      </div>
      {(error || loadError) && <div className="scheduling-error" role="alert">{error || loadError}</div>}
      <div className="scheduling-content">
        <aside className="scheduling-list" aria-label={t("scheduling.scheduled_task")}>
          {loading ? <p>{t("common.loading")}</p> : items.length === 0 ? <p className="scheduling-empty">{t("scheduling.empty")}</p> : items.map(item => <button key={item.id} className={`scheduling-item ${selectedId === item.id ? "selected" : ""}`} onClick={() => { setSelectedId(item.id); setForm(undefined); setError(""); }}>
            <span className="scheduling-item-title">{item.name}<span className={`scheduling-badge ${item.error ? "error" : ""}`}>{t(item.error ? "scheduling.needsAttention" : item.enabled ? "scheduling.enabled" : "scheduling.paused")}</span></span>
            <span>{labelTrigger(item.trigger)}</span>
            {item.executionProfile && <span className="scheduling-item-meta"><img className="scheduling-core-icon" src={coreIconSrc(item.executionProfile.coreKind)} alt="" aria-hidden/>{labelModel(item.executionProfile)}</span>}
          </button>)}
        </aside>
        <main className="scheduling-detail">
          {form ? <form onSubmit={event => { event.preventDefault(); save(); }}>
            <button type="button" className="scheduling-text-button" onClick={() => setForm(undefined)}><ArrowLeft size={16}/>{t(form.id ? "scheduling.edit" : "scheduling.create")}</button>
            {form.id && <label className="scheduling-enabled-field"><input type="checkbox" checked={form.enabled} onChange={event => updateForm({ enabled: event.target.checked })}/>{t("scheduling.enableSchedule")}</label>}
            <label>{t("scheduling.name")}<input autoFocus required maxLength={200} value={form.name} onChange={event => updateForm({ name: event.target.value })} /></label>
            <label>{t("scheduling.instructions")}<textarea required rows={5} value={form.prompt} onChange={event => updateForm({ prompt: event.target.value })} placeholder={t("scheduling.taskPlaceholder")} /></label>
            <SchedulingProjectField label={t("scheduling.workspace")} projects={props.projects} value={form.workspacePath} onChange={workspacePath => updateForm({ workspacePath })}/>
            <div className="scheduling-field">
              <span className="scheduling-field-label">{t("scheduling.agent")}</span>
              <div className="scheduling-core-options" role="group" aria-label={t("scheduling.agent")}>
                {CORE_ORDER.map(core => <button key={core} type="button" aria-pressed={(form.profile?.coreKind ?? "claude") === core} onClick={() => selectCore(core)}>
                  <img src={coreIconSrc(core)} alt="" aria-hidden/>{coreDisplayName(core)}
                </button>)}
              </div>
            </div>
            <div className="scheduling-fields">
              <div className="scheduling-field">
                <span className="scheduling-field-label">{t("scheduling.model")}</span>
                <ModelCascadeSelect options={modelOptions} value={modelValue} loading={modelsLoading} error={modelError}
                  disabled={!form.profile} placeholder={t("scheduling.chooseModel")} hint={t("scheduling.model")} onChange={chooseModel}/>
              </div>
              {form.profile?.coreKind !== "acp" && <div className="scheduling-field">
                <span className="scheduling-field-label">{t("scheduling.runtimeConfig")}</span>
                <ComposerFieldSelect value={form.profile?.runtimeConfig.orchestrationSelection?.mainAgentConfigId ?? ""}
                  showPlaceholder placeholder={t("scheduling.chooseConfig")} searchable
                  searchPlaceholder={t("composer.fieldSelect.searchMainAgent")} onChange={setMainConfig}>
                  {props.settings.mainAgentConfigs.map(config => <option key={config.id} value={config.id}>{config.name}</option>)}
                </ComposerFieldSelect>
              </div>}
            </div>
            {modelError && <p className="scheduling-error">{modelError}</p>}
            <ScheduleTimingFields form={form} onChange={updateForm} />
            <div className="scheduling-form-actions"><button type="button" disabled={busy} onClick={() => void runAction(async () => setPreview(await api.previewSchedule(triggerFor(form))))}>{t("scheduling.preview")}</button><button className="scheduling-primary" disabled={busy} type="submit">{t(busy ? "scheduling.saving" : "scheduling.save")}</button></div>
            {preview.length > 0 && <ul className="scheduling-preview">{preview.map(time => <li key={time}>{formatTime(time)}</li>)}</ul>}
          </form> : selected ? <>
            <h3>{selected.name}</h3>
            <div className="scheduling-meta">
              <span>{t("scheduling.nextRun")}：{selected.enabled && selected.nextRunAt ? formatTime(selected.nextRunAt) : "—"}</span>
              {selected.executionProfile && <span><img className="scheduling-core-icon" src={coreIconSrc(selected.executionProfile.coreKind)} alt="" aria-hidden/>{labelModel(selected.executionProfile)}</span>}
              {selected.workspacePath && <span><Folder size={13} aria-hidden/>{projectDisplayName(props.projects, selected.workspacePath)}</span>}
            </div>
            {selected.error && <p className="scheduling-error" role="alert">{selected.error}</p>}
            <pre className="scheduling-prompt">{selected.prompt}</pre>
            <div className="scheduling-form-actions">
              <button disabled={busy} onClick={() => edit(selected)}><Pencil size={15}/>{t("scheduling.edit")}</button>
              <button disabled={busy} onClick={() => void runAction(() => api.updateSchedule({ id: selected.id, expectedRevision: selected.revision, enabled: !selected.enabled }))}>{selected.enabled ? <Pause size={15}/> : <Play size={15}/>} {t(selected.enabled ? "scheduling.pause" : "scheduling.resume")}</button>
              <button disabled={busy} onClick={() => void runAction(() => api.runScheduleNow({ id: selected.id, requestId: crypto.randomUUID() }))}><Play size={15}/>{t("scheduling.runNow")}</button>
              <button disabled={busy} className="scheduling-danger" onClick={() => void runAction(async () => { await api.deleteSchedule(selected.id); setSelectedId(undefined); })}><Trash2 size={15}/>{t("common.delete")}</button>
            </div>
          </> : <p className="scheduling-empty">{t("scheduling.selectHint")}</p>}
          {!form && <section className="scheduling-history"><h3>{t("scheduling.history")}</h3>{history.length === 0 ? <p className="scheduling-hint">{t("scheduling.noHistory")}</p> : history.map(item => <div className="scheduling-run" key={item.id}>
            <div><strong>{selectedId ? formatTime(item.scheduledAt) : item.definition.name}</strong><span className={`scheduling-badge ${item.status === "failed" || item.status === "unknown" ? "error" : ""}`}>{t(`scheduling.status.${item.status}`)}</span><small>{!selectedId && formatTime(item.scheduledAt)}</small>{item.error && <p>{item.error}</p>}</div>
            {item.threadId && <button className="scheduling-icon" aria-label={t("scheduling.openThread")} title={t("scheduling.openThread")} onClick={() => props.onOpenThread(item.threadId!)}><ExternalLink size={16}/></button>}
          </div>)}</section>}
        </main>
      </div>
    </div>
  </div>;
}
