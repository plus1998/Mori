import { Check, ChevronDown, Folder, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

export interface SchedulingProjectOption { path: string; name: string }

const MAX_RESULTS = 40;
const POPOVER_HEIGHT = 320;

/** Name matches come before path matches; the caller's order (most recent first) is kept. */
export function filterSchedulingProjects(projects: readonly SchedulingProjectOption[], query: string): SchedulingProjectOption[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return projects.slice(0, MAX_RESULTS);
  const named: SchedulingProjectOption[] = [];
  const pathed: SchedulingProjectOption[] = [];
  for (const project of projects) {
    if (project.name.toLocaleLowerCase().includes(needle)) named.push(project);
    else if (project.path.toLocaleLowerCase().includes(needle)) pathed.push(project);
  }
  return [...named, ...pathed].slice(0, MAX_RESULTS);
}

export function projectDisplayName(projects: readonly SchedulingProjectOption[], path: string): string {
  const match = projects.find((project) => project.path === path);
  if (match) return match.name;
  const segments = path.split("/").filter(Boolean);
  return segments[segments.length - 1] ?? path;
}

/** Project chooser for a scheduled task: search the known projects, or type any directory. */
export function SchedulingProjectField({ label, projects, value, onChange }: {
  label: string;
  projects: readonly SchedulingProjectOption[];
  value: string;
  onChange(path: string): void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [customMode, setCustomMode] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [anchor, setAnchor] = useState({ left: 0, top: 0, width: 0, openUp: false });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const results = useMemo(() => filterSchedulingProjects(projects, query), [projects, query]);

  useEffect(() => {
    if (!open) return;
    searchRef.current?.focus();
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const openUp = rect.bottom + POPOVER_HEIGHT > window.innerHeight && rect.top > POPOVER_HEIGHT;
    setAnchor({ left: Math.min(rect.left, window.innerWidth - 360), top: openUp ? rect.top - POPOVER_HEIGHT - 6 : rect.bottom + 6, width: Math.max(rect.width, 320), openUp });
  }, [open]);
  function search(next: string) { setQuery(next); setActiveIndex(0); }

  function choose(path: string) {
    onChange(path);
    setOpen(false); setQuery(""); setCustomMode(false);
    triggerRef.current?.focus();
  }

  return <div className="scheduling-project-field">
    <span className="scheduling-project-label">{label}</span>
    <button ref={triggerRef} type="button" className="scheduling-project-trigger" aria-haspopup="listbox" aria-expanded={open}
      onClick={() => setOpen(current => !current)}>
      <Folder size={14} aria-hidden/>
      <span className="scheduling-project-name">{value ? projectDisplayName(projects, value) : t("scheduling.selectProject")}</span>
      {value && <span className="scheduling-project-path">{value}</span>}
      <ChevronDown size={14} aria-hidden className={open ? "expanded" : undefined}/>
    </button>
    {open && createPortal(<div className="scheduling-backdrop scheduling-project-backdrop" onClick={() => { setOpen(false); setQuery(""); setCustomMode(false); }}>
      <div className="scheduling-project-popover" role="dialog" aria-modal="true" style={{ left: anchor.left, top: anchor.top, width: anchor.width }}
        onClick={event => event.stopPropagation()}
        onKeyDown={event => {
          if (event.key === "Escape") { setOpen(false); setQuery(""); setCustomMode(false); triggerRef.current?.focus(); return; }
          if (customMode || results.length === 0) return;
          if (event.key === "ArrowDown") { event.preventDefault(); setActiveIndex(index => (index + 1) % results.length); }
          else if (event.key === "ArrowUp") { event.preventDefault(); setActiveIndex(index => (index - 1 + results.length) % results.length); }
          else if (event.key === "Enter") { event.preventDefault(); choose(results[activeIndex]!.path); }
        }}>
        <div className="scheduling-project-search">
          <Search size={14} aria-hidden/>
          <input ref={searchRef} value={query} placeholder={t("scheduling.searchProjects")} aria-label={t("scheduling.searchProjects")}
            onChange={event => search(event.target.value)}/>
        </div>
        {customMode ? <div className="scheduling-project-custom">
          <input autoFocus value={value} placeholder="/absolute/path/to/project" aria-label={t("scheduling.projectPath")} onChange={event => onChange(event.target.value)}/>
          <button type="button" className="scheduling-primary" disabled={!value.trim()} onClick={() => choose(value.trim())}>{t("common.done")}</button>
        </div> : results.length === 0 ? <p className="scheduling-empty">{t("scheduling.noProjectMatch")}</p> : (
          <div className="scheduling-project-results" role="listbox">
            {results.map((project, index) => <button key={project.path} type="button" role="option" aria-selected={project.path === value}
              className={`scheduling-project-option ${index === activeIndex ? "active" : ""}`}
              onMouseEnter={() => setActiveIndex(index)} onClick={() => choose(project.path)}>
              <span className="scheduling-project-option-name">{project.name}</span>
              <span className="scheduling-project-option-path">{project.path}</span>
              {project.path === value && <Check size={14} aria-hidden/>}
            </button>)}
          </div>
        )}
        <button type="button" className="scheduling-text-button" onClick={() => setCustomMode(current => !current)}>{customMode ? t("scheduling.searchProjects") : t("scheduling.otherProject")}</button>
      </div>
    </div>, document.body)}
  </div>;
}
