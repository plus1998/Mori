import { Sparkles } from "lucide-react";
import { type CSSProperties, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { SkillsEnabledSettings } from "../shared/composer-skills-settings";
import type { SkillInfo } from "../shared/skills";
import { ComposerHoverTooltip } from "./ComposerHoverTooltip";
import { composerFloatingStyleForAnchor } from "./composer-floating";
import { COMPOSER_TOOLBAR_ICON_PX, COMPOSER_TOOLBAR_ICON_STROKE } from "./composer-icon-metrics";

interface ComposerSkillsControlProps {
  skills: readonly SkillInfo[];
  enabledSettings: SkillsEnabledSettings;
  canEdit: boolean;
  saving?: boolean;
  compact?: boolean;
  onToggleSkill: (settingsKey: string, enabled: boolean) => void;
}

interface ComposerSkillsRowsProps {
  skills: readonly SkillInfo[];
  enabledSettings: SkillsEnabledSettings;
  canEdit: boolean;
  saving?: boolean;
  onToggleSkill?: (settingsKey: string, enabled: boolean) => void;
}

function ComposerSkillsRows({
  skills,
  enabledSettings,
  canEdit,
  saving,
  onToggleSkill,
}: ComposerSkillsRowsProps) {
  const { t } = useTranslation();
  return (
    <>
      {(["project", "user"] as const).map((source) => {
        const scoped = skills.filter((skill) => skill.source === source);
        if (scoped.length === 0) return null;
        return (
          <section key={source} className="composer-skills-scope">
            <h3>
              {source === "project" ? t("settings.models.editor.project") : t("settings.models.editor.user")}
            </h3>
            <div className="composer-agents-list">
              {scoped.map((skill) => {
                const key = skill.settingsKey ?? skill.skillFilePath;
                const enabled = enabledSettings[key] ?? false;
                return (
                  <div key={key} className="composer-mcp-row">
                    <div className="composer-mcp-row-main">
                      <span className="composer-mcp-row-name">{skill.name}</span>
                      <span className="composer-mcp-row-transport">{skill.layout}</span>
                    </div>
                    <label
                      className="composer-switch"
                      title={t(enabled ? "composer.enabledNamed" : "composer.disabledNamed", {
                        name: skill.name,
                      })}
                    >
                      <input
                        type="checkbox"
                        checked={enabled}
                        disabled={!canEdit || saving || !onToggleSkill}
                        aria-label={t(enabled ? "composer.enabledAria" : "composer.disabledAria", {
                          name: skill.name,
                        })}
                        onChange={() => onToggleSkill?.(key, !enabled)}
                      />
                      <span className="composer-switch-track" aria-hidden />
                    </label>
                  </div>
                );
              })}
            </div>
          </section>
        );
      })}
    </>
  );
}

export function ComposerSkillsCardBody(props: ComposerSkillsRowsProps) {
  const { t } = useTranslation();
  if (props.skills.length === 0) {
    return <p className="floating-workspace-card-empty">{t("composer.skills.empty")}</p>;
  }

  return (
    <div className="composer-skills-card-body is-embedded">
      <ComposerSkillsRows {...props} />
    </div>
  );
}

export function ComposerSkillsControl({
  skills,
  enabledSettings,
  canEdit,
  saving,
  compact,
  onToggleSkill,
}: ComposerSkillsControlProps) {
  const { t } = useTranslation();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [panelStyle, setPanelStyle] = useState<CSSProperties>({ visibility: "hidden" });
  const enabledCount = skills.filter(
    (skill) => enabledSettings[skill.settingsKey ?? skill.skillFilePath],
  ).length;
  const summary = `${enabledCount}/${skills.length}`;
  const updatePosition = useCallback(() => {
    if (!triggerRef.current) return;
    setPanelStyle(
      composerFloatingStyleForAnchor(triggerRef.current, {
        width: 340,
        minHeight: 140,
        prefer: "above",
      }),
    );
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [open, updatePosition]);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!panelRef.current?.contains(target) && !triggerRef.current?.contains(target)) setOpen(false);
    };
    const onEscape = (event: KeyboardEvent) => event.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", onEscape);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", onEscape);
    };
  }, [open]);

  if (skills.length === 0) return null;
  const popover = open
    ? createPortal(
        <div
          ref={panelRef}
          className="composer-codex-popover composer-agents-popover composer-skills-popover"
          role="dialog"
          aria-label={t("composer.skills.title")}
          style={panelStyle}
        >
          <div className="composer-agents-popover-header">
            <span>{t("composer.skills.title")}</span>
            <span>{summary}</span>
          </div>
          <div className="composer-skills-popover-scroll">
            <ComposerSkillsRows
              skills={skills}
              enabledSettings={enabledSettings}
              canEdit={canEdit}
              {...(saving !== undefined && { saving })}
              onToggleSkill={onToggleSkill}
            />
          </div>
        </div>,
        document.body,
      )
    : null;

  return (
    <span className="composer-agents-control">
      <ComposerHoverTooltip content="Skills" disabled={open}>
        <button
          ref={triggerRef}
          type="button"
          className={[
            "composer-context-trigger",
            "composer-agents-trigger",
            compact ? "is-compact" : "",
            open ? "is-active" : "",
          ]
            .filter(Boolean)
            .join(" ")}
          aria-label={t("composer.skills.configureSummary", { summary })}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => {
            if (!open) updatePosition();
            setOpen((value) => !value);
          }}
        >
          <Sparkles
            size={COMPOSER_TOOLBAR_ICON_PX}
            strokeWidth={COMPOSER_TOOLBAR_ICON_STROKE}
            aria-hidden
            className="composer-context-trigger-icon"
          />
          {enabledCount > 0 ? <span className="composer-context-trigger-label">{enabledCount}</span> : null}
        </button>
      </ComposerHoverTooltip>
      {popover}
    </span>
  );
}
