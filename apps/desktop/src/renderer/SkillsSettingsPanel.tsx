import { AppWindow, Check, Download, RefreshCw, Search, Sparkles, Trash2, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AppLocale } from "../shared/locale";
import type {
  SkillCatalogEntry,
  SkillCatalogSearchResult,
  SkillInfo,
  SkillLayout,
  SkillsListResult,
} from "../shared/skills";
import { SkillUninstallConfirmDialog } from "./SkillUninstallConfirmDialog";

const SKILL_LAYOUT_TABS: ReadonlyArray<{ layout: SkillLayout; label: string }> = [
  { layout: "agents", label: "Agents" },
  { layout: "pi", label: "Pi" },
  { layout: "codex", label: "Codex" },
  { layout: "claude", label: "Claude Code" },
];

interface SkillsSettingsPanelProps {
  snapshot?: SkillsListResult | undefined;
  loading?: boolean | undefined;
  onRefresh: () => void;
  onUninstall: (skill: SkillInfo) => Promise<void>;
  onLoadCatalogLeaderboard: () => Promise<SkillCatalogSearchResult>;
  onSearchCatalog: (query: string) => Promise<SkillCatalogSearchResult>;
  onInstallCatalog: (entry: SkillCatalogEntry, layout: SkillLayout) => Promise<void>;
}

export function SkillsSettingsPanel({
  snapshot,
  loading,
  onRefresh,
  onUninstall,
  onLoadCatalogLeaderboard,
  onSearchCatalog,
  onInstallCatalog,
}: SkillsSettingsPanelProps) {
  const { t, i18n } = useTranslation();
  const locale = (i18n.resolvedLanguage ?? i18n.language) as AppLocale;
  const [activeLayout, setActiveLayout] = useState<SkillLayout>("agents");
  const [selectedSkill, setSelectedSkill] = useState<SkillInfo>();
  const [pendingUninstall, setPendingUninstall] = useState<SkillInfo>();
  const [uninstalling, setUninstalling] = useState(false);
  const [uninstallError, setUninstallError] = useState<string>();
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [catalogQuery, setCatalogQuery] = useState("");
  const [catalogResult, setCatalogResult] = useState<SkillCatalogSearchResult>();
  const [leaderboardResult, setLeaderboardResult] = useState<SkillCatalogSearchResult>();
  const [leaderboardLoading, setLeaderboardLoading] = useState(false);
  const [leaderboardError, setLeaderboardError] = useState<string>();
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState<string>();
  const [installingCatalogId, setInstallingCatalogId] = useState<string>();
  const skillsByLayout: Record<SkillLayout, SkillInfo[]> = {
    agents: [],
    pi: [],
    codex: [],
    claude: [],
  };
  for (const skill of snapshot?.userSkills ?? []) {
    skillsByLayout[skill.layout].push(skill);
  }
  const visibleSkills = skillsByLayout[activeLayout].sort((a, b) => a.name.localeCompare(b.name));
  const searchEntryIds = new Set(catalogResult?.entries.map((entry) => entry.id) ?? []);
  const leaderboardEntries = (leaderboardResult?.entries ?? [])
    .map((entry, index) => ({ entry, rank: index + 1 }))
    .filter(({ entry }) => !searchEntryIds.has(entry.id))
    .slice(0, catalogResult ? Math.max(0, 8 - catalogResult.entries.length) : 12);
  const openCatalog = () => {
    setCatalogOpen(true);
    if (leaderboardResult || leaderboardLoading) return;
    setLeaderboardLoading(true);
    setLeaderboardError(undefined);
    void onLoadCatalogLeaderboard()
      .then(setLeaderboardResult)
      .catch((error: unknown) => setLeaderboardError(error instanceof Error ? error.message : String(error)))
      .finally(() => setLeaderboardLoading(false));
  };
  const renderCatalogEntry = (entry: SkillCatalogEntry, rank?: number) => {
    const installed = isCatalogSkillInstalled(skillsByLayout[activeLayout], entry);
    const installing = installingCatalogId === entry.id;
    return (
      <li key={entry.id} className="skills-catalog-card">
        {rank ? <span className="skills-catalog-rank">{rank}</span> : null}
        <a
          className="skills-catalog-card-main"
          href={entry.url}
          target="_blank"
          rel="noreferrer"
          title={t("settings.skills.viewOnStore", {
            source: entry.source,
            skill: entry.skillId,
          })}
        >
          <strong>{entry.name}</strong>
          <code>{entry.source}</code>
          <span>{t("settings.skills.installs", { count: formatInstallCount(entry.installs, locale) })}</span>
        </a>
        <button
          type="button"
          className="skills-catalog-install"
          disabled={installed || Boolean(installingCatalogId)}
          aria-label={
            installed
              ? t("settings.skills.installedAria", { name: entry.name })
              : t("settings.skills.installAria", { name: entry.name })
          }
          title={
            installed
              ? t("settings.skills.installed")
              : installing
                ? t("settings.skills.installing")
                : t("settings.skills.install")
          }
          onClick={() => {
            setInstallingCatalogId(entry.id);
            setCatalogError(undefined);
            void onInstallCatalog(entry, activeLayout)
              .catch((error: unknown) =>
                setCatalogError(error instanceof Error ? error.message : String(error)),
              )
              .finally(() => setInstallingCatalogId(undefined));
          }}
        >
          {installed ? <Check size={15} /> : <Download size={15} />}
        </button>
      </li>
    );
  };
  const catalogSearchForm = (
    <form
      className="skills-catalog-search"
      onSubmit={(event) => {
        event.preventDefault();
        const query = catalogQuery.trim();
        if (query.length < 2 || catalogLoading) return;
        setCatalogLoading(true);
        setCatalogError(undefined);
        void onSearchCatalog(query)
          .then(setCatalogResult)
          .catch((error: unknown) => {
            setCatalogResult(undefined);
            setCatalogError(error instanceof Error ? error.message : String(error));
          })
          .finally(() => setCatalogLoading(false));
      }}
    >
      <Search size={16} aria-hidden />
      <input
        type="search"
        value={catalogQuery}
        onChange={(event) => setCatalogQuery(event.target.value)}
        placeholder={t("settings.skills.searchPlaceholder")}
        aria-label={t("settings.skills.searchPlaceholder")}
        autoFocus
      />
      <button type="submit" disabled={catalogQuery.trim().length < 2 || catalogLoading}>
        {catalogLoading ? t("settings.skills.searching") : t("settings.skills.search")}
      </button>
    </form>
  );

  return (
    <>
      <header className="settings-page-header">
        <div className="settings-page-header-row">
          <div>
            <h1>Skills</h1>
          </div>
          <div className="skills-header-actions">
            <button
              type="button"
              className="settings-icon-button"
              onClick={openCatalog}
              aria-label={t("settings.skills.browse")}
              title={t("settings.skills.browse")}
            >
              <AppWindow size={18} />
            </button>
            <button
              type="button"
              className="settings-icon-button"
              onClick={onRefresh}
              disabled={loading}
              aria-label={t("settings.skills.refresh")}
            >
              <RefreshCw size={18} className={loading ? "spinning" : undefined} />
            </button>
          </div>
        </div>
      </header>

      {catalogOpen ? (
        <div
          className="settings-modal-backdrop"
          onClick={() => !installingCatalogId && setCatalogOpen(false)}
        >
          <section
            className="settings-modal skills-catalog-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="skills-catalog-title"
            onClick={(event) => event.stopPropagation()}
          >
            <header className="settings-modal-header">
              <div>
                <h2 id="skills-catalog-title" className="settings-modal-title">
                  {t("settings.skills.store")}
                </h2>
                <p className="skills-catalog-modal-meta">
                  {catalogResult
                    ? t("settings.skills.searchCount", { count: catalogResult.entries.length })
                    : t("settings.skills.leaderboardMeta")}
                  {t("settings.skills.installTo", { layout: skillLayoutLabel(activeLayout) })}
                </p>
              </div>
              <button
                type="button"
                className="settings-icon-button"
                aria-label={t("settings.skills.closeStore")}
                disabled={Boolean(installingCatalogId)}
                onClick={() => setCatalogOpen(false)}
              >
                <X size={17} />
              </button>
            </header>
            <div className="settings-modal-body skills-catalog-modal-body">
              {catalogSearchForm}
              {catalogError ? <p className="settings-form-error">{catalogError}</p> : null}
              {catalogResult ? (
                <section className="skills-catalog-results-section">
                  <h3>{t("settings.skills.searchResults")}</h3>
                  {catalogResult.entries.length === 0 ? (
                    <p className="settings-empty-hint">{t("settings.skills.noResults")}</p>
                  ) : (
                    <ul className="skills-catalog-grid">
                      {catalogResult.entries.map((entry) => renderCatalogEntry(entry))}
                    </ul>
                  )}
                </section>
              ) : null}
              {leaderboardError ? <p className="settings-form-error">{leaderboardError}</p> : null}
              {leaderboardLoading && leaderboardEntries.length === 0 ? (
                <p className="settings-empty-hint">{t("settings.skills.loadingLeaderboard")}</p>
              ) : null}
              {leaderboardEntries.length > 0 ? (
                <section className="skills-catalog-results-section">
                  <h3>{t("settings.skills.leaderboard")}</h3>
                  <ul className="skills-catalog-grid">
                    {leaderboardEntries.map(({ entry, rank }) => renderCatalogEntry(entry, rank))}
                  </ul>
                </section>
              ) : null}
            </div>
          </section>
        </div>
      ) : null}

      <div className="models-settings-tabs" role="tablist" aria-label={t("settings.skills.sources")}>
        {SKILL_LAYOUT_TABS.map((tab) => (
          <button
            key={tab.layout}
            type="button"
            role="tab"
            aria-selected={activeLayout === tab.layout}
            aria-controls="skills-source-panel"
            className={activeLayout === tab.layout ? "models-settings-tab active" : "models-settings-tab"}
            onClick={() => setActiveLayout(tab.layout)}
          >
            <span className="models-settings-tab-label">{tab.label}</span>
            <span className="models-settings-tab-count">{skillsByLayout[tab.layout].length}</span>
          </button>
        ))}
      </div>

      <section className="settings-section skills-list-section">
        <div id="skills-source-panel" role="tabpanel">
          {visibleSkills.length === 0 ? (
            <p className="settings-empty-hint">
              {t("settings.skills.addHint", { path: skillLayoutRoot(activeLayout) })}
            </p>
          ) : (
            <ul className="skill-list">
              {visibleSkills.map((skill) => (
                <li key={skill.skillFilePath} className="skill-card">
                  <button
                    type="button"
                    className="skill-card-main"
                    aria-label={t("settings.skills.detailsAria", { name: skill.name })}
                    aria-haspopup="dialog"
                    onClick={() => setSelectedSkill(skill)}
                  >
                    <span className="skill-card-icon" aria-hidden>
                      <Sparkles size={16} />
                    </span>
                    <span className="skill-card-body">
                      <span className="skill-card-title" title={skill.name}>{skill.name}</span>
                      <span className="skill-card-description">{skill.description}</span>
                    </span>
                  </button>
                  <button
                    type="button"
                    className="skill-card-uninstall"
                    aria-label={t("settings.skills.uninstallAria", { name: skill.name })}
                    title={
                      isSystemCodexSkill(skill)
                        ? t("settings.skills.systemCannotUninstall")
                        : t("settings.skills.uninstall")
                    }
                    disabled={isSystemCodexSkill(skill)}
                    onClick={() => {
                      setUninstallError(undefined);
                      setPendingUninstall(skill);
                    }}
                  >
                    <Trash2 size={15} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      {selectedSkill ? (
        <SkillDetailsDialog skill={selectedSkill} onClose={() => setSelectedSkill(undefined)} />
      ) : null}

      {pendingUninstall ? (
        <SkillUninstallConfirmDialog
          skill={pendingUninstall}
          busy={uninstalling}
          {...(uninstallError && { error: uninstallError })}
          onDismiss={() => {
            if (!uninstalling) {
              setPendingUninstall(undefined);
              setUninstallError(undefined);
            }
          }}
          onConfirm={() => {
            setUninstalling(true);
            setUninstallError(undefined);
            void onUninstall(pendingUninstall)
              .then(() => setPendingUninstall(undefined))
              .catch((error: unknown) =>
                setUninstallError(error instanceof Error ? error.message : String(error)),
              )
              .finally(() => setUninstalling(false));
          }}
        />
      ) : null}
    </>
  );
}

function SkillDetailsDialog({ skill, onClose }: { skill: SkillInfo; onClose: () => void }) {
  const { t } = useTranslation();
  const titleId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    const previousFocus = document.activeElement;
    dialog?.showModal();
    return () => {
      dialog?.close();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, []);

  return (
    <dialog
      ref={dialogRef}
      className="settings-modal skill-details-modal"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <header className="settings-modal-header">
        <h2 id={titleId} className="settings-modal-title">{skill.name}</h2>
        <button type="button" className="mcp-icon-button" onClick={onClose} aria-label={t("common.close")}>
          <X size={18} />
        </button>
      </header>
      <div className="settings-modal-body">
        <p className="skill-details-description">{skill.description}</p>
        <dl className="skill-details-meta">
          <div>
            <dt>{t("settings.skills.sources")}</dt>
            <dd>{skillLayoutLabel(skill.layout)}</dd>
          </div>
          <div>
            <dt>{t("settings.skills.filePath")}</dt>
            <dd><code>{skill.skillFilePath}</code></dd>
          </div>
        </dl>
      </div>
      <footer className="settings-modal-footer">
        <button type="button" className="settings-modal-cancel" onClick={onClose}>
          {t("common.close")}
        </button>
      </footer>
    </dialog>
  );
}

function isSystemCodexSkill(skill: SkillInfo): boolean {
  return skill.layout === "codex" && /[/\\]\.codex[/\\]skills[/\\]\.system[/\\]/.test(skill.directory);
}

function skillLayoutRoot(layout: SkillLayout): string {
  if (layout === "codex") {
    return "~/.codex/skills";
  }
  if (layout === "claude") {
    return "~/.claude/skills";
  }
  if (layout === "pi") {
    return "project .pi/skills (or ~/.agents/skills for shared Agents layout)";
  }
  return "~/.agents/skills";
}

function skillLayoutLabel(layout: SkillLayout): string {
  if (layout === "claude") return "Claude Code";
  if (layout === "codex") return "Codex";
  if (layout === "pi") return "Pi";
  return "Agents";
}

function formatInstallCount(count: number, locale: AppLocale): string {
  return new Intl.NumberFormat(locale, {
    notation: count >= 10_000 ? "compact" : "standard",
  }).format(count);
}

export function isCatalogSkillInstalled(skills: SkillInfo[], entry: SkillCatalogEntry): boolean {
  return skills.some(
    (skill) => skill.catalogSource === entry.source && skill.catalogSkillId === entry.skillId,
  );
}
