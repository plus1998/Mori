import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  Archive,
  Database,
  FileText,
  Folder,
  HardDrive,
  Loader2,
  type LucideIcon,
  MessageSquare,
  RefreshCw,
  Sparkles,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  StorageCategoryId,
  StorageCategoryUsage,
  StorageCleanupAction,
  StorageCleanupOlderThanUnit,
  StorageCleanupProgress,
  StorageCleanupRequest,
  StorageCleanupResult,
  StorageUsageSnapshot,
} from "../shared/storage-usage";

import "./storage-cleanup-progress.css";
import "./settings-detail-pages.css";

/** Spring: critically damped, response ~0.35s — Apple move/reposition default. */
const SPRING_SETTLE = { type: "spring" as const, bounce: 0, duration: 0.35 };
const SPRING_BAR = { type: "spring" as const, bounce: 0, duration: 0.45 };

const DEFAULT_OLD_CONVERSATIONS_VALUE = 7;
const DEFAULT_OLD_CONVERSATIONS_UNIT: StorageCleanupOlderThanUnit = "days";

type BusyKey =
  | StorageCleanupAction
  | "refresh"
  | `clearClaudeSessions:${"orphans" | "all"}`
  | `clearPiAgent:${"orphans" | "all"}`
  | null;

function formatBytes(bytes: number, locale: string): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const digits = unitIndex === 0 ? 0 : value < 10 ? 2 : 1;
  return `${value.toLocaleString(locale, { maximumFractionDigits: digits })} ${units[unitIndex]}`;
}

const CATEGORY_META: Record<StorageCategoryId, { icon: LucideIcon; tone: string }> = {
  database: { icon: Database, tone: "storage-tone-database" },
  logs: { icon: FileText, tone: "storage-tone-logs" },
  claudeSessions: { icon: MessageSquare, tone: "storage-tone-claude" },
  codexHome: { icon: Archive, tone: "storage-tone-codex" },
  piAgent: { icon: Sparkles, tone: "storage-tone-pi" },
  otherUserData: { icon: Folder, tone: "storage-tone-other" },
};

interface CleanupActionDef {
  busyKey: BusyKey;
  request: StorageCleanupRequest;
  titleKey: string;
  hintKey: string;
  buttonKey: string;
  confirmKey?: string;
  destructive?: boolean;
}

const MANAGE_ACTIONS: CleanupActionDef[] = [
  {
    busyKey: "clearLogs",
    request: { action: "clearLogs" },
    titleKey: "settings.storage.clearLogs",
    hintKey: "settings.storage.clearLogsHint",
    buttonKey: "settings.storage.clear",
  },
  {
    busyKey: "clearClaudeSessions:orphans",
    request: { action: "clearClaudeSessions", options: { orphansOnly: true } },
    titleKey: "settings.storage.clearOrphanClaude",
    hintKey: "settings.storage.clearOrphanClaudeHint",
    buttonKey: "settings.storage.clear",
  },
  {
    busyKey: "clearPiAgent:orphans",
    request: { action: "clearPiAgent", options: { orphansOnly: true } },
    titleKey: "settings.storage.clearOrphanPi",
    hintKey: "settings.storage.clearOrphanPiHint",
    buttonKey: "settings.storage.clear",
  },
  {
    busyKey: "clearCodexHomeCaches",
    request: { action: "clearCodexHomeCaches" },
    titleKey: "settings.storage.clearCodexCaches",
    hintKey: "settings.storage.clearCodexCachesHint",
    buttonKey: "settings.storage.clear",
  },
  {
    busyKey: "vacuumDatabase",
    request: { action: "vacuumDatabase" },
    titleKey: "settings.storage.vacuum",
    hintKey: "settings.storage.vacuumHint",
    buttonKey: "settings.storage.vacuumAction",
  },
];

const DANGER_ACTIONS: CleanupActionDef[] = [
  {
    busyKey: "clearClaudeSessions:all",
    request: { action: "clearClaudeSessions" },
    titleKey: "settings.storage.clearAllClaude",
    hintKey: "settings.storage.clearAllClaudeHint",
    buttonKey: "settings.storage.clear",
    confirmKey: "settings.storage.confirmClearAllClaude",
    destructive: true,
  },
  {
    busyKey: "clearPiAgent:all",
    request: { action: "clearPiAgent" },
    titleKey: "settings.storage.clearAllPi",
    hintKey: "settings.storage.clearAllPiHint",
    buttonKey: "settings.storage.clear",
    confirmKey: "settings.storage.confirmClearAllPi",
    destructive: true,
  },
  {
    busyKey: "clearAllConversations",
    request: { action: "clearAllConversations" },
    titleKey: "settings.storage.clearConversations",
    hintKey: "settings.storage.clearConversationsHint",
    buttonKey: "settings.storage.clearAll",
    confirmKey: "settings.storage.confirmClearConversations",
    destructive: true,
  },
];

function categoryPercent(category: StorageCategoryUsage, totalBytes: number): number {
  if (!category.exists || totalBytes <= 0 || category.bytes <= 0) {
    return 0;
  }
  return Math.max(0.4, (category.bytes / totalBytes) * 100);
}

export function StorageSettingsPanel() {
  const { t, i18n } = useTranslation();
  const prefersReducedMotion = useReducedMotion();
  const liveRegionId = useId();
  const [snapshot, setSnapshot] = useState<StorageUsageSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [cleanupProgress, setCleanupProgress] = useState<StorageCleanupProgress | null>(null);
  const [busyKey, setBusyKey] = useState<BusyKey>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [oldConversationsValue, setOldConversationsValue] = useState(DEFAULT_OLD_CONVERSATIONS_VALUE);
  const [oldConversationsUnit, setOldConversationsUnit] = useState<StorageCleanupOlderThanUnit>(
    DEFAULT_OLD_CONVERSATIONS_UNIT,
  );

  const springSettle = prefersReducedMotion ? { duration: 0.15 } : SPRING_SETTLE;
  const springBar = prefersReducedMotion ? { duration: 0.15 } : SPRING_BAR;

  const loadUsage = useCallback(
    async (preserveFeedback = false) => {
      if (!window.eco?.getStorageUsage) {
        setErrorMessage(t("settings.storage.unavailable"));
        setLoading(false);
        return;
      }
      setBusyKey("refresh");
      if (!preserveFeedback) setErrorMessage(null);
      try {
        const next = await window.eco.getStorageUsage();
        setSnapshot(next);
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : String(error));
      } finally {
        setLoading(false);
        setBusyKey(null);
      }
    },
    [t],
  );

  useEffect(() => {
    void loadUsage();
  }, [loadUsage]);

  useEffect(() => {
    const eco = window.eco;
    if (!eco) return;
    let receivedEvent = false;
    let disposed = false;
    const unsubscribe = eco.onStorageCleanupProgress((next) => {
      receivedEvent = true;
      setCleanupProgress(next);
    });
    void eco
      .getStorageCleanupProgress()
      .then((next) => {
        if (!disposed && !receivedEvent) setCleanupProgress(next);
      })
      .catch((error) => {
        if (!disposed) setErrorMessage(error instanceof Error ? error.message : String(error));
      });
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, []);

  async function runCleanup(def: CleanupActionDef) {
    if (!window.eco?.cleanupStorage) {
      setErrorMessage(t("settings.storage.unavailable"));
      return;
    }
    if (def.confirmKey && !window.confirm(t(def.confirmKey))) {
      return;
    }
    setBusyKey(def.busyKey);
    setStatusMessage(null);
    setErrorMessage(null);
    try {
      const result: StorageCleanupResult = await window.eco.cleanupStorage(def.request);
      applyCleanupResult(result);
      await loadUsage(true);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyKey(null);
    }
  }

  async function runClearOldConversations() {
    if (!window.eco?.cleanupStorage) {
      setErrorMessage(t("settings.storage.unavailable"));
      return;
    }
    if (
      !Number.isFinite(oldConversationsValue) ||
      oldConversationsValue <= 0 ||
      !Number.isInteger(oldConversationsValue)
    ) {
      setErrorMessage(t("settings.storage.clearOldConversationsInvalid"));
      return;
    }
    const unitLabel = t(`settings.storage.olderThanUnit.${oldConversationsUnit}`);
    if (
      !window.confirm(
        t("settings.storage.clearOldConversationsConfirm", {
          count: oldConversationsValue,
          unit: unitLabel,
        }),
      )
    ) {
      return;
    }
    setBusyKey("clearOldConversations");
    setStatusMessage(null);
    setErrorMessage(null);
    try {
      const result: StorageCleanupResult = await window.eco.cleanupStorage({
        action: "clearOldConversations",
        options: {
          olderThanValue: oldConversationsValue,
          olderThanUnit: oldConversationsUnit,
        },
      });
      applyCleanupResult(result);
      await loadUsage(true);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyKey(null);
    }
  }

  function applyCleanupResult(result: StorageCleanupResult) {
    if (result.errors?.length) {
      setErrorMessage(result.errors.join("\n"));
    }
    if (result.skippedThreadIds?.length) {
      setStatusMessage(
        t("settings.storage.cleanupSummary", {
          deleted: result.deletedCount ?? 0,
          skipped: result.skippedThreadIds.length,
          failed: result.errors?.length ?? 0,
        }),
      );
      return;
    }
    if (result.message) {
      setStatusMessage(result.message);
      return;
    }
    if (!result.ok) {
      return;
    }
    if (typeof result.freedBytes === "number") {
      setStatusMessage(
        t("settings.storage.freed", {
          size: formatBytes(result.freedBytes, i18n.language),
        }),
      );
      return;
    }
    if (typeof result.deletedCount === "number") {
      setStatusMessage(t("settings.storage.deletedCount", { count: result.deletedCount }));
      return;
    }
    setStatusMessage(t("settings.storage.done"));
  }

  const busy = busyKey !== null || cleanupProgress?.status === "running";
  const totalBytes = snapshot?.totalBytes ?? 0;
  const meteredCategories = snapshot?.categories ?? [];

  const segmentShares = useMemo(() => {
    if (!snapshot || totalBytes <= 0) {
      return [] as Array<{ id: StorageCategoryId; percent: number; tone: string }>;
    }
    return snapshot.categories
      .filter((c) => c.exists && c.bytes > 0)
      .map((c) => ({
        id: c.id,
        percent: (c.bytes / totalBytes) * 100,
        tone: CATEGORY_META[c.id].tone,
      }));
  }, [snapshot, totalBytes]);

  return (
    <div className="storage-panel">
      <header className="settings-page-header storage-panel-header">
        <div className="storage-panel-header-copy">
          <h1>{t("settings.storage")}</h1>
          <p className="settings-page-desc">{t("settings.storage.subtitle")}</p>
        </div>
        <button
          type="button"
          className="storage-icon-button"
          disabled={busy}
          aria-label={t("settings.storage.refresh")}
          title={t("settings.storage.refresh")}
          onPointerDown={(event) => {
            // Instant press feedback: class is pure CSS :active sibling; keep path free of debounce.
            event.currentTarget.classList.add("is-pressed");
          }}
          onPointerUp={(event) => event.currentTarget.classList.remove("is-pressed")}
          onPointerLeave={(event) => event.currentTarget.classList.remove("is-pressed")}
          onClick={() => void loadUsage()}
        >
          {busyKey === "refresh" ? (
            <Loader2 size={16} className="storage-spin" aria-hidden />
          ) : (
            <RefreshCw size={16} aria-hidden />
          )}
        </button>
      </header>

      {cleanupProgress ? (
        <div className="storage-cleanup-progress" role="status" aria-live="polite">
          <strong>
            {t(
              cleanupProgress.status === "completed"
                ? "settings.storage.cleanupFinished"
                : "settings.storage.cleanupRunning",
            )}
          </strong>
          {cleanupProgress.phase === "conversations" ? (
            <>
              <progress
                max={Math.max(1, cleanupProgress.totalCount)}
                value={cleanupProgress.processedCount}
                aria-label={t("settings.storage.cleanupRunning")}
              />
              <span>
                {t("settings.storage.cleanupProgress", {
                  count: cleanupProgress.totalCount,
                  processed: cleanupProgress.processedCount,
                  total: cleanupProgress.totalCount,
                })}
              </span>
            </>
          ) : cleanupProgress.status === "running" ? (
            <span>{t("settings.storage.cleanupPreparing")}</span>
          ) : null}
          <span>
            {t("settings.storage.cleanupSummary", {
              deleted: cleanupProgress.deletedCount,
              skipped: cleanupProgress.skippedCount,
              failed: cleanupProgress.failedCount,
            })}
          </span>
          {cleanupProgress.status === "running" ? (
            <small>{t("settings.storage.cleanupBackgroundHint")}</small>
          ) : null}
          {cleanupProgress.status === "completed" && cleanupProgress.result?.errors?.length ? (
            <p className="storage-feedback-error">{cleanupProgress.result.errors.join("\n")}</p>
          ) : null}
        </div>
      ) : null}

      <section className="storage-hero" aria-labelledby={`${liveRegionId}-total`}>
        <div className="storage-hero-material">
          <div className="storage-hero-glyph" aria-hidden>
            <HardDrive size={22} strokeWidth={1.75} />
          </div>
          <div className="storage-hero-meta">
            <span className="storage-hero-kicker">{t("settings.storage.usage")}</span>
            <AnimatePresence mode="wait" initial={false}>
              <motion.p
                key={snapshot ? `${snapshot.totalBytes}` : "loading"}
                id={`${liveRegionId}-total`}
                className="storage-hero-total"
                initial={prefersReducedMotion ? false : { opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                {...(prefersReducedMotion ? {} : { exit: { opacity: 0, y: -4 } })}
                transition={springSettle}
              >
                {loading && !snapshot
                  ? t("settings.storage.loading")
                  : formatBytes(totalBytes, i18n.language)}
              </motion.p>
            </AnimatePresence>
            <span className="storage-hero-hint">{t("settings.storage.totalHint")}</span>
          </div>
        </div>

        <div
          className="storage-composition-bar"
          role="img"
          aria-label={t("settings.storage.compositionAria")}
        >
          {segmentShares.length === 0 ? (
            <div className="storage-composition-empty" />
          ) : (
            segmentShares.map((segment) => (
              <motion.span
                key={segment.id}
                className={`storage-composition-segment ${segment.tone}`}
                title={t(`settings.storage.category.${segment.id}`)}
                initial={false}
                animate={{ flexGrow: Math.max(segment.percent, 0.35) }}
                transition={springBar}
                style={{ flexBasis: 0 }}
              />
            ))
          )}
        </div>
      </section>

      {snapshot || loading ? (
        <section className="storage-section" aria-label={t("settings.storage.usage")}>
          <h2 className="storage-section-title">{t("settings.storage.breakdown")}</h2>
          {loading && !snapshot ? (
            <div className="storage-inset-group storage-skeleton" aria-busy="true">
              <div className="storage-skeleton-row" />
              <div className="storage-skeleton-row" />
              <div className="storage-skeleton-row" />
            </div>
          ) : (
            <ul className="storage-inset-group">
              {meteredCategories.map((category) => {
                const meta = CATEGORY_META[category.id];
                const Icon = meta.icon;
                const percent = categoryPercent(category, totalBytes);
                return (
                  <li key={category.id} className="storage-inset-row">
                    <span className={`storage-row-glyph ${meta.tone}`} aria-hidden>
                      <Icon size={15} strokeWidth={2} />
                    </span>
                    <span className="storage-row-copy">
                      <strong>{t(`settings.storage.category.${category.id}`)}</strong>
                      {category.id === "database" && category.detail?.threadCount !== undefined ? (
                        <small className="storage-row-meta">
                          {t("settings.storage.threadCount", { count: category.detail.threadCount })}
                        </small>
                      ) : null}
                      <span className="storage-row-track" aria-hidden>
                        <motion.span
                          className={`storage-row-fill ${meta.tone}`}
                          initial={false}
                          animate={{ width: category.exists ? `${percent}%` : "0%" }}
                          transition={springBar}
                        />
                      </span>
                    </span>
                    <span className="storage-row-value">
                      {category.exists
                        ? formatBytes(category.bytes, i18n.language)
                        : t("settings.storage.missing")}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      ) : null}

      <section className="storage-section" aria-label={t("settings.storage.cleanup")}>
        <h2 className="storage-section-title">{t("settings.storage.cleanup")}</h2>
        <p className="storage-section-lede">{t("settings.storage.cleanupSubtitle")}</p>
        <ul className="storage-inset-group storage-action-group">
          <li className="storage-inset-row storage-action-row storage-old-conversations-row">
            <span className="storage-row-copy storage-action-copy">
              <strong>{t("settings.storage.clearOldConversations")}</strong>
              <small>{t("settings.storage.clearOldConversationsHint")}</small>
            </span>
            <div className="storage-old-conversations-controls">
              <input
                type="number"
                className="storage-old-conversations-input"
                min={1}
                step={1}
                inputMode="numeric"
                disabled={busy}
                value={oldConversationsValue}
                aria-label={t("settings.storage.clearOldConversations")}
                onChange={(event) => {
                  const next = Number(event.target.value);
                  setOldConversationsValue(Number.isFinite(next) ? next : NaN);
                }}
              />
              <label className="storage-old-conversations-unit">
                <span className="sr-only">{t("settings.storage.olderThanUnitLabel")}</span>
                <select
                  disabled={busy}
                  value={oldConversationsUnit}
                  aria-label={t("settings.storage.olderThanUnitLabel")}
                  onChange={(event) => {
                    const next = event.target.value;
                    if (next === "hours" || next === "days") {
                      setOldConversationsUnit(next);
                    }
                  }}
                >
                  <option value="days">{t("settings.storage.olderThanUnit.days")}</option>
                  <option value="hours">{t("settings.storage.olderThanUnit.hours")}</option>
                </select>
              </label>
              <button
                type="button"
                className="storage-pill-button"
                disabled={busy || !Number.isFinite(oldConversationsValue) || oldConversationsValue <= 0}
                onClick={() => void runClearOldConversations()}
              >
                {busyKey === "clearOldConversations" ? (
                  <Loader2 size={14} className="storage-spin" aria-hidden />
                ) : null}
                {t("settings.storage.clear")}
              </button>
            </div>
          </li>
          {MANAGE_ACTIONS.map((def) => (
            <StorageActionRow
              key={String(def.busyKey)}
              def={def}
              busy={busy}
              busyKey={busyKey}
              title={t(def.titleKey)}
              hint={t(def.hintKey)}
              buttonLabel={t(def.buttonKey)}
              onRun={() => void runCleanup(def)}
            />
          ))}
        </ul>
      </section>

      <section className="storage-section" aria-label={t("settings.storage.dangerZone")}>
        <h2 className="storage-section-title storage-section-title-danger">
          {t("settings.storage.dangerZone")}
        </h2>
        <ul className="storage-inset-group storage-action-group storage-danger-group">
          {DANGER_ACTIONS.map((def) => (
            <StorageActionRow
              key={String(def.busyKey)}
              def={def}
              busy={busy}
              busyKey={busyKey}
              title={t(def.titleKey)}
              hint={t(def.hintKey)}
              buttonLabel={t(def.buttonKey)}
              onRun={() => void runCleanup(def)}
            />
          ))}
        </ul>
      </section>

      <div className="storage-feedback" aria-live="polite" id={liveRegionId}>
        <AnimatePresence>
          {statusMessage ? (
            <motion.p
              key={`ok-${statusMessage}`}
              className="storage-feedback-ok"
              initial={prefersReducedMotion ? false : { opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              {...(prefersReducedMotion ? {} : { exit: { opacity: 0 } })}
              transition={springSettle}
            >
              <Sparkles size={14} aria-hidden />
              {statusMessage}
            </motion.p>
          ) : null}
          {errorMessage ? (
            <motion.p
              key={`err-${errorMessage}`}
              className="storage-feedback-error"
              initial={prefersReducedMotion ? false : { opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              {...(prefersReducedMotion ? {} : { exit: { opacity: 0 } })}
              transition={springSettle}
            >
              {errorMessage}
            </motion.p>
          ) : null}
        </AnimatePresence>
      </div>
    </div>
  );
}

function StorageActionRow({
  def,
  busy,
  busyKey,
  title,
  hint,
  buttonLabel,
  onRun,
}: {
  def: CleanupActionDef;
  busy: boolean;
  busyKey: BusyKey;
  title: string;
  hint: string;
  buttonLabel: string;
  onRun: () => void;
}) {
  const isThisBusy = busyKey === def.busyKey;
  return (
    <li className="storage-inset-row storage-action-row">
      <span className="storage-row-copy storage-action-copy">
        <strong>{title}</strong>
        <small>{hint}</small>
      </span>
      <button
        type="button"
        className={def.destructive ? "storage-pill-button is-danger" : "storage-pill-button"}
        disabled={busy}
        onClick={onRun}
      >
        {isThisBusy ? (
          <Loader2 size={14} className="storage-spin" aria-hidden />
        ) : def.destructive ? (
          <Trash2 size={13} aria-hidden />
        ) : null}
        {buttonLabel}
      </button>
    </li>
  );
}
