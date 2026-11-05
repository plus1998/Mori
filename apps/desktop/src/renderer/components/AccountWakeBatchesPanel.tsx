import { Check, ChevronLeft, Clock3, Loader2, Pencil, Plus, Search, Trash2, X, Zap } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Switch } from "./Switch";
import type {
  AccountWakeBatch,
  AccountWakeBatchInput,
  AccountWakeBatchState,
  AccountWakeItem,
} from "../../shared/account-wake-batch";
import type { CodexModelCatalogSnapshot } from "../../shared/models";
import { canUseOpenAIAccountCredentials, type OpenAIAccount } from "../../shared/openai-account";
import "./account-wake-batches.css";

interface Props {
  accounts: OpenAIAccount[];
  model: string | null;
  models: CodexModelCatalogSnapshot["models"];
  modelBusy: boolean;
  modelError: string;
  onModelChange(model: string | null): Promise<void>;
}
const quickTimes = ["05:00", "06:00", "07:00", "13:00"];
const itemLabel = {
  pending: "pending",
  running: "waking",
  succeeded: "succeeded",
  failed: "failed",
  unknown: "unknown",
  skipped: "skipped",
} as const;

export function AccountWakeBatchesPanel(props: Props) {
  const { t, i18n } = useTranslation();
  const api = window.eco;
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<AccountWakeBatchState>({ version: 1, batches: [] });
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [selectedId, setSelectedId] = useState<string>();
  const [draft, setDraft] = useState<AccountWakeBatchInput>();
  const [query, setQuery] = useState("");
  const [unassigned, setUnassigned] = useState(false);
  const [busy, setBusy] = useState(false);
  const [removeArmed, setRemoveArmed] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const active = state.batches.find((b) => b.id === selectedId);
  const running = active?.lastRun?.status === "running";
  const accountsById = new Map(props.accounts.map((a) => [a.id, a]));
  const formatAt = (at: string, tz = timezone) =>
    new Date(at).toLocaleString(i18n.language, {
      timeZone: tz,
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });

  const refresh = useCallback(async () => {
    const api = window.eco;
    if (!api) return;
    const next = await api.openAIAccountsWakeBatchesList();
    setState(next);
    setLoaded(true);
    setSelectedId((id) => (next.batches.some((batch) => batch.id === id) ? id : next.batches[0]?.id));
  }, []);
  useEffect(() => {
    if (!open) return;
    const element = dialog.current;
    element?.showModal();
    return () => {
      element?.close();
      trigger.current?.focus();
    };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const load = () => {
      void refresh().catch((e) => {
        if (!cancelled) setError(String(e.message ?? e));
      });
    };
    load();
    const timer = setInterval(load, 2_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [open, refresh]);

  const add = (time = "05:00") => {
    setDraft({ name: "", time, timezone, repeat: "daily", accountIds: [], enabled: true });
    setQuery("");
    setUnassigned(false);
    setError("");
    setRemoveArmed(false);
  };
  const update = (value: Partial<AccountWakeBatchInput>) => setDraft((d) => (d ? { ...d, ...value } : d));
  const edit = () => {
    if (!active) return;
    setDraft({
      id: active.id,
      expectedRevision: active.revision,
      name: active.name,
      time: active.time,
      timezone: active.timezone,
      repeat: active.repeat,
      accountIds: [...active.accountIds],
      enabled: active.enabled,
    });
    setQuery("");
    setUnassigned(false);
    setRemoveArmed(false);
    setError("");
  };
  const operate = async (operation: () => Promise<AccountWakeBatchState>) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const next = await operation();
      setState(next);
      return next;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
    return undefined;
  };
  const save = async () => {
    if (!api || !draft) return;
    const next = await operate(() => api.openAIAccountsWakeBatchesSave(draft));
    if (next) {
      setSelectedId(draft.id ?? next.batches.at(-1)?.id);
      setDraft(undefined);
    }
  };
  const toggle = async (batch: AccountWakeBatch) => {
    if (!api) return;
    await operate(() =>
      api.openAIAccountsWakeBatchesSave({
        ...batch,
        expectedRevision: batch.revision,
        enabled: !batch.enabled,
      }),
    );
  };
  const remove = async () => {
    if (!api || !active) return;
    if (!removeArmed) {
      setRemoveArmed(true);
      return;
    }
    const next = await operate(() => api.openAIAccountsWakeBatchesRemove(active.id, active.revision));
    if (next) {
      setSelectedId(next.batches[0]?.id);
      setRemoveArmed(false);
    }
  };
  const assignments = (id: string) =>
    state.batches.filter((b) => b.id !== draft?.id && b.accountIds.includes(id)).map((b) => b.time);
  const visibleAccounts = props.accounts.filter((a) => {
    const matches = `${a.name} ${a.email ?? ""}`.toLowerCase().includes(query.trim().toLowerCase());
    return matches && (!unassigned || !assignments(a.id).length || draft?.accountIds.includes(a.id));
  });
  const toggleAccount = (id: string) => {
    if (!draft) return;
    update({
      accountIds: draft.accountIds.includes(id)
        ? draft.accountIds.filter((a) => a !== id)
        : [...draft.accountIds, id],
    });
  };
  const statusText = (batch: AccountWakeBatch) => {
    const run = batch.lastRun;
    if (!run) return t("wakeBatch.notRun");
    if (run.status === "missed") return t("wakeBatch.missed");
    if (run.status === "interrupted") return t("wakeBatch.interrupted");
    if (run.status === "running")
      return t("wakeBatch.running", {
        done: run.items.filter((i) => !["pending", "running"].includes(i.status)).length,
        total: run.items.length,
      });
    return t("wakeBatch.result", {
      success: run.items.filter((i) => i.status === "succeeded").length,
      failed: run.items.filter((i) => i.status !== "succeeded").length,
    });
  };
  const rows: AccountWakeItem[] = active?.lastRun?.items.length
    ? active.lastRun.items
    : (active?.accountIds.map((id) => ({
        accountId: id,
        name: accountsById.get(id)?.name ?? t("wakeBatch.deleted"),
        status: "pending",
      })) ?? []);
  const canRetry = active?.lastRun?.items.some(
    (i) => active.accountIds.includes(i.accountId) && ["failed", "unknown", "skipped"].includes(i.status),
  );

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="codex-action-secondary"
        onClick={() => {
          setOpen(true);
          setError("");
        }}
      >
        <Zap size={14} />
        {t("wakeBatch.title")}
      </button>
      {open
        ? createPortal(
            <dialog
              ref={dialog}
              className="account-wake-dialog"
              aria-labelledby="account-wake-title"
              onCancel={() => setOpen(false)}
              onKeyDown={(event) => {
                if (event.key === "Escape") setOpen(false);
              }}
              onClick={(event) => {
                if (event.target === event.currentTarget) {
                  const box = event.currentTarget.getBoundingClientRect();
                  if (
                    event.clientX < box.left ||
                    event.clientX > box.right ||
                    event.clientY < box.top ||
                    event.clientY > box.bottom
                  )
                    setOpen(false);
                }
              }}
            >
              <header className="wake-header">
                <div>
                  <div className="wake-eyebrow">
                    <Zap size={13} /> CHATGPT ACCOUNTS
                  </div>
                  <h2 id="account-wake-title">{t("wakeBatch.title")}</h2>
                  <p>{t("wakeBatch.intro")}</p>
                </div>
                <button
                  type="button"
                  className="mcp-icon-button"
                  aria-label={t("wakeBatch.close")}
                  onClick={() => setOpen(false)}
                >
                  <X size={18} />
                </button>
              </header>
              <div className="wake-model-bar">
                <span>
                  <Clock3 size={13} />
                  {t("wakeBatch.timezone", { timezone })}
                </span>
                <button type="button" onClick={() => setModelOpen(!modelOpen)}>
                  {t("wakeBatch.model")} · {props.model ?? t("wakeBatch.auto")}
                </button>
              </div>
              {modelOpen ? (
                <div className="wake-model-editor">
                  <select
                    aria-label={t("wakeBatch.model")}
                    className="mcp-select"
                    value={props.model ?? ""}
                    disabled={props.modelBusy}
                    onChange={(e) => void props.onModelChange(e.target.value || null)}
                  >
                    <option value="">{t("wakeBatch.auto")}</option>
                    {props.model && !props.models.some((m) => m.modelId === props.model) ? (
                      <option value={props.model}>{props.model}</option>
                    ) : null}
                    {props.models.map((m) => (
                      <option key={m.modelId} value={m.modelId}>
                        {m.displayName || m.modelId}
                      </option>
                    ))}
                  </select>
                  <p>{t("wakeBatch.modelHint")}</p>
                  {props.modelError ? <p role="alert">{props.modelError}</p> : null}
                </div>
              ) : null}
              {error ? (
                <div className="wake-error" role="alert">
                  {error}
                </div>
              ) : null}
              <div className={`wake-layout ${draft || active ? "has-detail" : ""}`}>
                <aside className="wake-sidebar">
                  <div className="wake-sidebar-heading">
                    <span>
                      {t("wakeBatch.summary", {
                        batches: state.batches.length,
                        accounts: new Set(state.batches.flatMap((b) => b.accountIds)).size,
                      })}
                    </span>
                    <button
                      type="button"
                      className="mcp-icon-button"
                      aria-label={t("wakeBatch.add")}
                      onClick={() => add()}
                      disabled={busy}
                    >
                      <Plus size={17} />
                    </button>
                  </div>
                  <div className="wake-batch-list">
                    {!loaded ? (
                      <p className="wake-empty">{t("wakeBatch.loading")}</p>
                    ) : !state.batches.length ? (
                      <div className="wake-empty">
                        <Clock3 size={28} strokeWidth={1.3} />
                        <strong>{t("wakeBatch.empty")}</strong>
                        <p>{t("wakeBatch.emptyHint")}</p>
                      </div>
                    ) : (
                      [...state.batches]
                        .sort((a, b) => a.time.localeCompare(b.time))
                        .map((batch) => (
                          <div
                            key={batch.id}
                            className={`wake-batch-card ${!draft && selectedId === batch.id ? "is-selected" : ""}`}
                          >
                            <button
                              type="button"
                              className="wake-batch-select"
                              onClick={() => {
                                setSelectedId(batch.id);
                                setDraft(undefined);
                                setRemoveArmed(false);
                                setError("");
                              }}
                            >
                              <div className="wake-batch-clock">
                                {batch.time}
                                <span>
                                  {t(batch.repeat === "daily" ? "wakeBatch.daily" : "wakeBatch.onceShort")}
                                </span>
                              </div>
                              <strong>{batch.name}</strong>
                              <span>{t("wakeBatch.selected", { count: batch.accountIds.length })}</span>
                              <small data-running={batch.lastRun?.status === "running"}>
                                {statusText(batch)}
                              </small>
                            </button>
                            <Switch
                              className="wake-batch-row-switch"
                              size="sm"
                              checked={batch.enabled}
                              aria-label={t("wakeBatch.enabled", { name: batch.name })}
                              disabled={busy || batch.lastRun?.status === "running"}
                              onCheckedChange={() => void toggle(batch)}
                            />
                          </div>
                        ))
                    )}
                  </div>
                  <div className="wake-sidebar-footer">
                    <button type="button" className="wake-add-button" onClick={() => add()} disabled={busy}>
                      <Plus size={14} />
                      {t("wakeBatch.add")}
                    </button>
                    <div className="wake-quick-times">
                      {quickTimes.map((time) => (
                        <button type="button" key={time} onClick={() => add(time)} disabled={busy}>
                          {time}
                        </button>
                      ))}
                    </div>
                  </div>
                </aside>
                <section className="wake-detail">
                  {draft ? (
                    <>
                      <div className="wake-detail-title">
                        <h3>{t(draft.id ? "wakeBatch.edit" : "wakeBatch.new")}</h3>
                        <button
                          type="button"
                          className="mcp-icon-button wake-back"
                          aria-label={t("wakeBatch.back")}
                          onClick={() => setDraft(undefined)}
                        >
                          <ChevronLeft size={16} />
                        </button>
                      </div>
                      <div className="wake-form-fields">
                        <label>
                          {t("wakeBatch.name")}
                          <input
                            value={draft.name}
                            maxLength={80}
                            placeholder={t("wakeBatch.namePlaceholder")}
                            onChange={(e) => update({ name: e.target.value })}
                          />
                        </label>
                        <div className="wake-time-fields">
                          <label>
                            {t("wakeBatch.time")}
                            <input
                              type="time"
                              value={draft.time}
                              required
                              onChange={(e) => update({ time: e.target.value })}
                            />
                          </label>
                          <label>
                            {t("wakeBatch.repeat")}
                            <select
                              value={draft.repeat}
                              onChange={(e) => update({ repeat: e.target.value as "daily" | "once" })}
                            >
                              <option value="daily">{t("wakeBatch.daily")}</option>
                              <option value="once">{t("wakeBatch.once")}</option>
                            </select>
                          </label>
                        </div>
                        <span className="wake-form-zone">
                          {t("wakeBatch.timezone", { timezone: draft.timezone })}
                        </span>
                      </div>
                      <div className="wake-picker-heading">
                        <strong>{t("wakeBatch.accounts")}</strong>
                        <span>{t("wakeBatch.selected", { count: draft.accountIds.length })}</span>
                      </div>
                      <div className="wake-search">
                        <Search size={14} />
                        <input
                          aria-label={t("wakeBatch.search")}
                          placeholder={t("wakeBatch.search")}
                          value={query}
                          onChange={(e) => setQuery(e.target.value)}
                        />
                      </div>
                      <div className="wake-picker-tools">
                        <label>
                          <input
                            type="checkbox"
                            checked={unassigned}
                            onChange={(e) => setUnassigned(e.target.checked)}
                          />
                          {t("wakeBatch.unassigned")}
                        </label>
                        <button
                          type="button"
                          onClick={() =>
                            update({
                              accountIds: [
                                ...new Set([
                                  ...draft.accountIds,
                                  ...visibleAccounts.filter(canUseOpenAIAccountCredentials).map((a) => a.id),
                                ]),
                              ],
                            })
                          }
                        >
                          {t("wakeBatch.selectVisible")}
                        </button>
                        <button type="button" onClick={() => update({ accountIds: [] })}>
                          {t("wakeBatch.clear")}
                        </button>
                      </div>
                      <div className="wake-account-list wake-picker-list">
                        {visibleAccounts.map((a) => {
                          const selected = draft.accountIds.includes(a.id);
                          const ready = canUseOpenAIAccountCredentials(a);
                          const times = assignments(a.id);
                          return (
                            <label key={a.id} className={`wake-account-row ${selected ? "is-checked" : ""}`}>
                              <input
                                type="checkbox"
                                checked={selected}
                                disabled={!ready && !selected}
                                onChange={() => toggleAccount(a.id)}
                              />
                              <span className="wake-account-avatar">{a.name.slice(0, 1).toUpperCase()}</span>
                              <span className="wake-account-copy">
                                <strong>{a.name}</strong>
                                <small>
                                  {!ready
                                    ? t("wakeBatch.loginNeeded")
                                    : times.length
                                      ? t("wakeBatch.assigned", { times: times.join("、") })
                                      : (a.email ?? a.quota?.planType ?? "ChatGPT")}
                                </small>
                              </span>
                              {selected ? <Check size={14} className="wake-check-mark" /> : null}
                            </label>
                          );
                        })}
                        {draft.accountIds
                          .filter((id) => !accountsById.has(id))
                          .map((id) => (
                            <label key={id} className="wake-account-row">
                              <input type="checkbox" checked onChange={() => toggleAccount(id)} />
                              <span>{t("wakeBatch.deleted")}</span>
                            </label>
                          ))}
                        {!visibleAccounts.length ? (
                          <p className="wake-empty">
                            {t(props.accounts.length ? "wakeBatch.noMatches" : "wakeBatch.noAccounts")}
                          </p>
                        ) : null}
                      </div>
                      <footer className="wake-detail-footer">
                        <button
                          type="button"
                          className="codex-action-secondary"
                          disabled={busy}
                          onClick={() => setDraft(undefined)}
                        >
                          {t("wakeBatch.cancel")}
                        </button>
                        <button
                          type="button"
                          className="settings-primary-button"
                          disabled={busy || !draft.time || !draft.accountIds.length}
                          onClick={() => void save()}
                        >
                          {busy ? <Loader2 size={14} className="mcp-spin" /> : <Check size={14} />}
                          {t(draft.enabled ? "wakeBatch.saveEnable" : "wakeBatch.save")}
                        </button>
                      </footer>
                    </>
                  ) : active ? (
                    <>
                      <div className="wake-detail-title">
                        <div>
                          <h3>{active.name}</h3>
                          <p>
                            {active.enabled && active.nextRunAt
                              ? t("wakeBatch.next", { time: formatAt(active.nextRunAt, active.timezone) })
                              : t(active.nextRunAt ? "wakeBatch.paused" : "wakeBatch.ended")}
                          </p>
                        </div>
                        <button
                          type="button"
                          className="mcp-icon-button"
                          aria-label={t("wakeBatch.edit")}
                          disabled={busy || running}
                          onClick={edit}
                        >
                          <Pencil size={15} />
                        </button>
                      </div>
                      <div className="wake-run-summary" data-running={running}>
                        <span className="wake-run-icon">
                          {running ? (
                            <Loader2 size={20} className="mcp-spin" />
                          ) : (
                            <Zap size={20} strokeWidth={1.5} />
                          )}
                        </span>
                        <div>
                          <strong>{statusText(active)}</strong>
                          <small>
                            {active.lastRun
                              ? t("wakeBatch.sentAt", {
                                  time: formatAt(active.lastRun.startedAt, active.timezone),
                                })
                              : t("wakeBatch.modelHint")}
                          </small>
                        </div>
                      </div>
                      <div className="wake-picker-heading">
                        <strong>
                          {t(active.lastRun?.items.length ? "wakeBatch.last" : "wakeBatch.ready")}
                        </strong>
                        <span>{rows.length}</span>
                      </div>
                      <div className="wake-account-list">
                        {rows.map((item) => (
                          <div className="wake-account-row" key={item.accountId}>
                            <span className="wake-account-avatar">{item.name.slice(0, 1).toUpperCase()}</span>
                            <span className="wake-account-copy">
                              <strong>{item.name}</strong>
                              {item.error || item.quotaError ? (
                                <small className="wake-item-error">
                                  {item.error ?? t("wakeBatch.quotaWarning", { error: item.quotaError })}
                                </small>
                              ) : (
                                <small>{accountsById.get(item.accountId)?.email ?? "ChatGPT"}</small>
                              )}
                            </span>
                            <span className={`wake-item-status is-${item.status}`}>
                              {item.status === "running" ? <Loader2 size={12} className="mcp-spin" /> : null}
                              {active.lastRun?.items.length ? t(`wakeBatch.${itemLabel[item.status]}`) : "—"}
                            </span>
                          </div>
                        ))}
                      </div>
                      <footer className="wake-detail-footer">
                        <button
                          type="button"
                          className="wake-remove"
                          disabled={busy || running}
                          onClick={() => void remove()}
                        >
                          <Trash2 size={13} />
                          {t(removeArmed ? "wakeBatch.confirmRemove" : "wakeBatch.remove")}
                        </button>
                        <div>
                          {canRetry && !running ? (
                            <button
                              type="button"
                              className="codex-action-secondary"
                              disabled={busy}
                              onClick={() =>
                                api && void operate(() => api.openAIAccountsWakeBatchesRun(active.id, true))
                              }
                            >
                              {t("wakeBatch.retry")}
                            </button>
                          ) : null}
                          <button
                            type="button"
                            className="settings-primary-button"
                            disabled={busy || running}
                            onClick={() =>
                              api && void operate(() => api.openAIAccountsWakeBatchesRun(active.id))
                            }
                          >
                            {running ? <Loader2 size={14} className="mcp-spin" /> : <Zap size={14} />}
                            {t(running ? "wakeBatch.waking" : "wakeBatch.run")}
                          </button>
                        </div>
                      </footer>
                    </>
                  ) : (
                    <div className="wake-detail-empty">
                      <Clock3 size={36} strokeWidth={1} />
                      <h3>{t("wakeBatch.empty")}</h3>
                      <p>{t("wakeBatch.selectBatch")}</p>
                      <button type="button" className="settings-primary-button" onClick={() => add()}>
                        <Plus size={14} />
                        {t("wakeBatch.add")}
                      </button>
                    </div>
                  )}
                </section>
              </div>
              <div className="wake-bottom-note">
                <Clock3 size={12} />
                <span>{t("wakeBatch.note")}</span>
              </div>
            </dialog>,
            document.body,
          )
        : null}
    </>
  );
}
