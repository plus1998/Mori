import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { BROWSER_WEBVIEW_TAB_ID_ATTR, browserTaskTabId } from "../shared/browser";
import { BrowserPanel } from "./BrowserPanel";
import type { TaskPanelBrowserInstance } from "./SubagentTaskDrawer";
import { clampBrowserSplitRatio, type BrowserSplitLayout } from "./browser-split-layout";
import type { TaskPanelHomeTool } from "./task-panel-tabs";
import { startPointerDragSession } from "./pointer-drag-session";

export function BrowserTaskWorkspace({
  instances, activeBrowserId, surfaceActive, split, splitBusy = false,
  onChangeSplit, onToggleSplit, onSelectBrowser, onOpenTool,
}: {
  instances: readonly TaskPanelBrowserInstance[];
  activeBrowserId: string | undefined;
  surfaceActive: boolean;
  split: BrowserSplitLayout | undefined;
  splitBusy?: boolean | undefined;
  onChangeSplit: (split: BrowserSplitLayout | undefined) => void;
  onToggleSplit: (browserId: string) => void;
  onSelectBrowser: (browserId: string) => void;
  onOpenTool: (sourceTabId: string, tool: TaskPanelHomeTool) => void;
}) {
  const { t } = useTranslation();
  const rootRef = useRef<HTMLDivElement>(null);
  const stopDrag = useRef<(() => void) | undefined>(undefined);
  const latestSplit = useRef(split);
  latestSplit.current = split;
  const splitVisible = Boolean(
    activeBrowserId && split?.browserIds.includes(activeBrowserId) &&
    split.browserIds.every(id => instances.some(instance => instance.id === id)),
  );
  const leftId = splitVisible ? split?.browserIds[0] : undefined;
  const rightId = splitVisible ? split?.browserIds[1] : undefined;
  const ratio = split?.ratio ?? 0.5;

  // Guests live in a separate overlay, outside these React panes. Their DOM focus
  // still identifies the human's active side, including clicks inside the page.
  useEffect(() => {
    if (!surfaceActive || !activeBrowserId) return;
    const onFocus = (event: FocusEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const id = target.getAttribute(BROWSER_WEBVIEW_TAB_ID_ATTR);
      if (id && id !== activeBrowserId && (id === leftId || id === rightId)) onSelectBrowser(id);
    };
    document.addEventListener("focus", onFocus, true);
    return () => document.removeEventListener("focus", onFocus, true);
  }, [activeBrowserId, leftId, rightId, surfaceActive, onSelectBrowser]);

  useEffect(() => () => stopDrag.current?.(), [splitVisible, surfaceActive, leftId, rightId]);

  return (
    <div ref={rootRef} className={`browser-task-workspace${splitVisible ? " is-split" : ""}`}
      hidden={!activeBrowserId}
      style={splitVisible ? { gridTemplateColumns: `minmax(0, ${ratio}fr) 7px minmax(0, ${1 - ratio}fr)` } : undefined}>
      {instances.map(instance => {
        const side = instance.id === leftId ? 0 : instance.id === rightId ? 1 : undefined;
        const visible = splitVisible ? side !== undefined : instance.id === activeBrowserId;
        const focused = instance.id === activeBrowserId;
        return (
          <div key={instance.id} id={`subagent-task-tab-browser-${instance.id}`}
            className={`subagent-task-panel-tab-pane subagent-task-panel-tab-pane--browser ${visible ? "is-active" : "is-inactive"}${focused ? " is-focused" : ""}`}
            role="tabpanel" hidden={!visible} data-browser-pane={instance.id}
            style={splitVisible && side !== undefined ? { gridColumn: side === 0 ? 1 : 3, gridRow: 1 } : undefined}
            onPointerDownCapture={() => { if (!focused && visible) onSelectBrowser(instance.id); }}
            onFocusCapture={() => { if (!focused && visible) onSelectBrowser(instance.id); }}>
            {splitVisible && side !== undefined && split ? (
              <div className="browser-split-page-picker">
                <span>{t(side === 0 ? "browser.split.left" : "browser.split.right")}</span>
                <select aria-label={t(side === 0 ? "browser.split.chooseLeft" : "browser.split.chooseRight")}
                  value={instance.id} onChange={event => {
                    const id = event.target.value;
                    const browserIds: [string, string] = [...split.browserIds];
                    browserIds[side] = id;
                    onChangeSplit({ ...split, browserIds });
                    onSelectBrowser(id);
                  }}>
                  {instances.filter(candidate => candidate.id !== split.browserIds[side === 0 ? 1 : 0]).map(candidate => (
                    <option key={candidate.id} value={candidate.id}>
                      {candidate.url === "about:blank" ? t("browser.split.newPage") : (candidate.title || candidate.url)}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}
            <BrowserPanel active={focused && surfaceActive} visible={visible && surfaceActive}
              browserId={instance.id} onOpenTool={(id, tool) => onOpenTool(browserTaskTabId(id), tool)}
              onToggleSplit={() => onToggleSplit(instance.id)} split={splitVisible} splitBusy={splitBusy} />
          </div>
        );
      })}
      {splitVisible && split ? (
        <div className="browser-split-divider" role="separator" tabIndex={0}
          aria-label={t("browser.split.resize")} aria-orientation="vertical"
          aria-valuemin={25} aria-valuemax={75} aria-valuenow={Math.round(ratio * 100)}
          onPointerDown={event => {
            if (!surfaceActive || !event.isPrimary || event.button !== 0 || !rootRef.current) return;
            event.preventDefault();
            const rect = rootRef.current.getBoundingClientRect();
            if (rect.width <= 7) return;
            const body = event.currentTarget.ownerDocument.body;
            stopDrag.current?.();
            stopDrag.current = startPointerDragSession({
              handle: event.currentTarget,
              pointerId: event.pointerId,
              onMove: point => {
                const current = latestSplit.current;
                if (current) {
                  const ratio = clampBrowserSplitRatio((point.clientX - rect.left) / (rect.width - 7));
                  if (ratio !== current.ratio) onChangeSplit({ ...current, ratio });
                }
              },
              onEnd: () => {
                stopDrag.current = undefined;
                body.classList.remove("is-resizing-browser-split");
              },
            });
            body.classList.add("is-resizing-browser-split");
          }}
          onDoubleClick={() => onChangeSplit({ ...split, ratio: 0.5 })}
          onKeyDown={event => {
            const next = event.key === "ArrowLeft" ? ratio - 0.05 : event.key === "ArrowRight" ? ratio + 0.05 :
              event.key === "Home" ? 0.25 : event.key === "End" ? 0.75 : undefined;
            if (next === undefined) return;
            event.preventDefault();
            onChangeSplit({ ...split, ratio: clampBrowserSplitRatio(next) });
          }} />
      ) : null}
    </div>
  );
}
