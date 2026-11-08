import { Clock3, Loader2, Plus, Server, Terminal as TerminalIcon, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { GhosttyTerminal, type TerminalDimensions } from "./GhosttyTerminal";
import {
  createAutoCloseState,
  listExpiredAutoCloseTabIds,
  pruneStaleAutoCloseEntries,
  type TerminalAutoCloseState,
  tickAutoCloseRemainingSeconds,
} from "./terminal-auto-close";
import {
  clampTerminalHeight,
  createTerminalTab,
  nextTerminalTabLabel,
  type ProjectTerminalState,
  type TerminalTabRecord,
} from "./terminal-panel-storage";
import {
  deleteTerminalSessionId,
  getTerminalSessionId,
  listTerminalSessionsForProject,
  setTerminalSessionId,
} from "./terminal-session-cache";

export interface TerminalSessionPresentation {
  initialOutput?: string;
  exitCode?: number;
}

interface TerminalPanelProps {
  workspacePath: string;
  workspaceLabel: string;
  state: ProjectTerminalState;
  onStateChange: (next: ProjectTerminalState) => void;
  onSessionExit?: (sessionId: string, exitCode: number) => boolean;
  sessionPresentations?: Record<string, TerminalSessionPresentation>;
  isCurrentProject?: boolean;
  injectedSessionId?: string | null;
  onInjectedSessionConsumed?: () => void;
}

export function TerminalPanel({
  workspacePath,
  workspaceLabel,
  state,
  onStateChange,
  onSessionExit,
  sessionPresentations = {},
  isCurrentProject = true,
  injectedSessionId,
  onInjectedSessionConsumed,
}: TerminalPanelProps) {
  const { t } = useTranslation();
  const dragStateRef = useRef<{ startY: number; startHeight: number } | undefined>(undefined);
  const [sessionsByTabId, setSessionsByTabId] = useState<Record<string, string>>(() =>
    state.open
      ? listTerminalSessionsForProject(
          workspacePath,
          state.tabs.map((tab) => tab.id),
        )
      : {},
  );
  const [tabEpochById, setTabEpochById] = useState<Record<string, number>>({});
  const [busyTabIds, setBusyTabIds] = useState<Record<string, boolean>>({});
  const [errorsByTabId, setErrorsByTabId] = useState<Record<string, string>>({});
  const [autoCloseByTabId, setAutoCloseByTabId] = useState<Record<string, TerminalAutoCloseState>>({});
  const autoCloseStartedSessionsRef = useRef(new Set<string>());
  const spawningTabIdsRef = useRef(new Set<string>());
  const sessionsByTabIdRef = useRef(sessionsByTabId);
  const stateRef = useRef(state);
  sessionsByTabIdRef.current = sessionsByTabId;
  stateRef.current = state;

  const activeTab = state.tabs.find((tab) => tab.id === state.activeTabId) ?? state.tabs[0];

  useEffect(() => {
    if (!injectedSessionId || !activeTab) {
      return;
    }
    const currentSession = sessionsByTabIdRef.current[activeTab.id];
    if (currentSession && currentSession !== injectedSessionId) {
      // Occupied by a live PTY (e.g. a persistent task). Wait for App to switch
      // to an idle/new tab instead of replacing this session.
      return;
    }
    setTerminalSessionId(workspacePath, activeTab.id, injectedSessionId, {
      kind: activeTab.kind,
      ...(activeTab.label ? { label: activeTab.label } : {}),
      ...(activeTab.endpoint ? { endpoint: activeTab.endpoint } : {}),
    });
    setSessionsByTabId((current) => ({ ...current, [activeTab.id]: injectedSessionId }));
    setErrorsByTabId((current) => {
      const next = { ...current };
      delete next[activeTab.id];
      return next;
    });
    onInjectedSessionConsumed?.();
  }, [activeTab, injectedSessionId, onInjectedSessionConsumed, workspacePath]);

  const syncSessionsFromCache = useCallback(() => {
    setSessionsByTabId(
      listTerminalSessionsForProject(
        workspacePath,
        state.tabs.map((tab) => tab.id),
      ),
    );
  }, [state.tabs, workspacePath]);

  useEffect(() => {
    if (!state.open) {
      return;
    }
    syncSessionsFromCache();
  }, [state.open, syncSessionsFromCache, workspacePath, state.tabs]);

  const ensureTabSession = useCallback(
    async (tabId: string, dimensions?: TerminalDimensions) => {
      if (!window.eco) {
        return undefined;
      }

      const cached = getTerminalSessionId(workspacePath, tabId);
      if (cached) {
        setSessionsByTabId((current) => ({ ...current, [tabId]: cached }));
        return cached;
      }

      if (!dimensions || dimensions.cols <= 0 || dimensions.rows <= 0) {
        return undefined;
      }

      // Fit-before-spawn: only one in-flight create per tab (avoids double PTY on
      // rapid dimension callbacks before the session id is cached).
      if (spawningTabIdsRef.current.has(tabId)) {
        return undefined;
      }
      spawningTabIdsRef.current.add(tabId);

      setBusyTabIds((current) => ({ ...current, [tabId]: true }));
      setErrorsByTabId((current) => {
        const next = { ...current };
        delete next[tabId];
        return next;
      });

      try {
        const result = await window.eco.spawnTerminal({
          workspacePath,
          cols: dimensions.cols,
          rows: dimensions.rows,
        });
        // This path spawns a local shell; SSH sessions arrive through the injected
        // session effect above, never here.
        setTerminalSessionId(workspacePath, tabId, result.sessionId, { kind: "local" });
        setSessionsByTabId((current) => ({ ...current, [tabId]: result.sessionId }));
        return result.sessionId;
      } catch (spawnError) {
        const message = spawnError instanceof Error ? spawnError.message : String(spawnError);
        setErrorsByTabId((current) => ({ ...current, [tabId]: message }));
        return undefined;
      } finally {
        spawningTabIdsRef.current.delete(tabId);
        setBusyTabIds((current) => {
          const next = { ...current };
          delete next[tabId];
          return next;
        });
      }
    },
    [workspacePath],
  );

  const clearTabSession = useCallback(
    (tabId: string) => {
      deleteTerminalSessionId(workspacePath, tabId);
      setSessionsByTabId((current) => {
        const next = { ...current };
        delete next[tabId];
        return next;
      });
    },
    [workspacePath],
  );

  const killTabSession = useCallback(
    (tabId: string) => {
      const sessionId = deleteTerminalSessionId(workspacePath, tabId);
      if (sessionId && window.eco) {
        void window.eco.killTerminal(sessionId);
      }
      setTabEpochById((current) => ({
        ...current,
        [tabId]: (current[tabId] ?? 0) + 1,
      }));
      setSessionsByTabId((current) => {
        const next = { ...current };
        delete next[tabId];
        return next;
      });
      setErrorsByTabId((current) => {
        const next = { ...current };
        delete next[tabId];
        return next;
      });
    },
    [workspacePath],
  );

  const handleSelectTab = (tabId: string) => {
    if (tabId === state.activeTabId) {
      return;
    }
    onStateChange({ ...state, activeTabId: tabId });
  };

  const handleAddTab = () => {
    const label = nextTerminalTabLabel(workspaceLabel, state.tabs);
    const tab = createTerminalTab(label);
    onStateChange({
      ...state,
      tabs: [...state.tabs, tab],
      activeTabId: tab.id,
    });
  };

  const handleCloseTab = (tab: TerminalTabRecord) => {
    const remaining = state.tabs.filter((item) => item.id !== tab.id);
    setAutoCloseByTabId((current) => {
      if (!current[tab.id]) {
        return current;
      }
      const next = { ...current };
      delete next[tab.id];
      return next;
    });
    killTabSession(tab.id);
    if (remaining.length === 0) {
      onStateChange({ ...state, tabs: [], activeTabId: "", open: false });
      return;
    }
    const fallbackTab = remaining[remaining.length - 1];
    const activeTabId = state.activeTabId === tab.id && fallbackTab ? fallbackTab.id : state.activeTabId;
    onStateChange({
      ...state,
      tabs: remaining,
      activeTabId,
    });
  };

  const handleExitedTab = (tab: TerminalTabRecord) => {
    clearTabSession(tab.id);
    setAutoCloseByTabId((current) => {
      if (!current[tab.id]) {
        return current;
      }
      const next = { ...current };
      delete next[tab.id];
      return next;
    });
    const remaining = state.tabs.filter((item) => item.id !== tab.id);
    if (remaining.length === 0) {
      onStateChange({ ...state, tabs: [], activeTabId: "", open: false });
      return;
    }
    const fallbackTab = remaining[remaining.length - 1];
    const activeTabId = state.activeTabId === tab.id && fallbackTab ? fallbackTab.id : state.activeTabId;
    onStateChange({
      ...state,
      tabs: remaining,
      activeTabId,
    });
  };

  const cancelAutoClose = useCallback((tabId: string) => {
    setAutoCloseByTabId((current) => {
      if (!current[tabId]) {
        return current;
      }
      const next = { ...current };
      delete next[tabId];
      return next;
    });
  }, []);

  const startAutoClose = useCallback((tab: TerminalTabRecord, sessionId: string) => {
    if (autoCloseStartedSessionsRef.current.has(sessionId)) {
      return;
    }
    // Only auto-close while this finished session still owns the tab.
    if (sessionsByTabIdRef.current[tab.id] !== sessionId) {
      return;
    }
    autoCloseStartedSessionsRef.current.add(sessionId);
    setAutoCloseByTabId((current) => ({
      ...current,
      [tab.id]: createAutoCloseState(sessionId),
    }));
  }, []);

  useEffect(() => {
    setAutoCloseByTabId((current) => pruneStaleAutoCloseEntries(current, sessionsByTabId));
  }, [sessionsByTabId]);

  useEffect(() => {
    for (const tab of state.tabs) {
      const sessionId = sessionsByTabId[tab.id];
      if (!sessionId || sessionPresentations[sessionId]?.exitCode === undefined) {
        continue;
      }
      startAutoClose(tab, sessionId);
    }
  }, [sessionPresentations, sessionsByTabId, startAutoClose, state.tabs]);

  useEffect(() => {
    if (Object.keys(autoCloseByTabId).length === 0) {
      return undefined;
    }
    const timer = window.setInterval(() => {
      const now = Date.now();
      const currentState = stateRef.current;
      const currentSessions = sessionsByTabIdRef.current;
      const expiredTabIds = listExpiredAutoCloseTabIds(autoCloseByTabId, currentSessions, now);
      if (expiredTabIds.length > 0) {
        setAutoCloseByTabId((current) => {
          const next = { ...current };
          for (const tabId of expiredTabIds) {
            delete next[tabId];
          }
          return next;
        });
        for (const tabId of expiredTabIds) {
          deleteTerminalSessionId(workspacePath, tabId);
        }
        const expiredIds = new Set(expiredTabIds);
        const remaining = currentState.tabs.filter((tab) => !expiredIds.has(tab.id));
        if (remaining.length === 0) {
          onStateChange({ ...currentState, tabs: [], activeTabId: "", open: false });
          return;
        }
        const activeTabId = expiredIds.has(currentState.activeTabId)
          ? (remaining[remaining.length - 1]?.id ?? "")
          : currentState.activeTabId;
        onStateChange({ ...currentState, tabs: remaining, activeTabId });
        return;
      }
      setAutoCloseByTabId((current) => {
        let changed = false;
        const next = { ...current };
        for (const [tabId, countdown] of Object.entries(current)) {
          const updated = tickAutoCloseRemainingSeconds(countdown, now);
          if (updated !== countdown) {
            next[tabId] = updated;
            changed = true;
          }
        }
        return changed ? next : current;
      });
    }, 250);
    return () => window.clearInterval(timer);
  }, [autoCloseByTabId, onStateChange, workspacePath]);

  const handleResizePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    dragStateRef.current = { startY: event.clientY, startHeight: state.height };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handleResizePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragStateRef.current;
    if (!drag) {
      return;
    }
    const delta = drag.startY - event.clientY;
    onStateChange({
      ...state,
      height: clampTerminalHeight(drag.startHeight + delta),
    });
  };

  const handleResizePointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    dragStateRef.current = undefined;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  if (state.tabs.length === 0 || !activeTab) {
    return null;
  }

  const isOpen = state.open;

  return (
    <section
      id={isCurrentProject ? "terminal-panel" : undefined}
      className={["terminal-panel", isOpen ? "is-open" : ""].filter(Boolean).join(" ")}
      style={{ height: isOpen ? state.height : 0 }}
      aria-label={t("terminal.title")}
      aria-hidden={!isOpen}
    >
      <div
        className="terminal-panel-resize-handle"
        role="separator"
        aria-orientation="horizontal"
        aria-label={t("terminal.resize")}
        onPointerDown={handleResizePointerDown}
        onPointerMove={handleResizePointerMove}
        onPointerUp={handleResizePointerUp}
        onPointerCancel={handleResizePointerUp}
      />
      <div className="terminal-panel-tabs" role="tablist" aria-label={t("terminal.tabs")}>
        {state.tabs.map((tab) => {
          const isActive = tab.id === state.activeTabId;
          const isSsh = tab.kind === "ssh";
          const classNames = ["terminal-panel-tab", isSsh ? "is-ssh" : "", isActive ? "is-active" : ""];
          return (
            <div key={tab.id} className={classNames.filter(Boolean).join(" ")}>
              <button
                type="button"
                className="terminal-panel-tab-button"
                role="tab"
                aria-selected={isActive}
                aria-controls={`terminal-panel-tab-${tab.id}`}
                title={
                  isSsh && tab.endpoint ? `${tab.label} · ${tab.endpoint}` : `${tab.label} · ${workspacePath}`
                }
                onClick={() => handleSelectTab(tab.id)}
              >
                {isSsh ? (
                  <Server size={13} strokeWidth={1.75} aria-hidden />
                ) : (
                  <TerminalIcon size={13} strokeWidth={1.75} aria-hidden />
                )}
                <span className="terminal-panel-tab-label">{tab.label}</span>
              </button>
              <button
                type="button"
                className="terminal-panel-tab-close"
                aria-label={t("terminal.closeTab", { label: tab.label })}
                onClick={() => handleCloseTab(tab)}
              >
                <X size={10} strokeWidth={2.5} aria-hidden />
              </button>
            </div>
          );
        })}
        <button
          type="button"
          className="terminal-panel-tab-add"
          aria-label={t("terminal.newTab")}
          onClick={handleAddTab}
        >
          <Plus size={14} aria-hidden />
        </button>
      </div>
      <div className="terminal-panel-body">
        {state.tabs.map((tab) => {
          const sessionId = sessionsByTabId[tab.id];
          const busy = busyTabIds[tab.id] === true;
          const error = errorsByTabId[tab.id];
          const isActive = tab.id === state.activeTabId;
          const shouldKeepTerminalMounted = Boolean(sessionId);
          const presentation = sessionId ? sessionPresentations[sessionId] : undefined;
          const autoClose = autoCloseByTabId[tab.id];
          return (
            <div
              key={tab.id}
              id={`terminal-panel-tab-${tab.id}`}
              className="terminal-panel-tab-pane"
              role="tabpanel"
              hidden={!isActive}
            >
              {busy ? (
                <div className="terminal-panel-loading" aria-live="polite">
                  <Loader2 size={16} className="terminal-panel-spinner" aria-hidden />
                  <span>{t("terminal.starting")}</span>
                </div>
              ) : null}
              {error ? (
                <p className="terminal-panel-error" role="alert">
                  {error}
                </p>
              ) : null}
              {!error &&
              (state.open || shouldKeepTerminalMounted) &&
              (isActive || shouldKeepTerminalMounted) ? (
                <GhosttyTerminal
                  key={`${workspacePath}:${tab.id}:${tabEpochById[tab.id] ?? 0}`}
                  sessionId={sessionId ?? null}
                  active={isActive && isCurrentProject && isOpen}
                  {...(presentation?.initialOutput !== undefined && {
                    initialOutput: presentation.initialOutput,
                  })}
                  {...(!sessionId && {
                    onDimensionsReady: (dimensions: TerminalDimensions) => {
                      void ensureTabSession(tab.id, dimensions);
                    },
                  })}
                  onExit={(exitCode) => {
                    if (sessionId && onSessionExit?.(sessionId, exitCode) === false) {
                      startAutoClose(tab, sessionId);
                      return;
                    }
                    handleExitedTab(tab);
                  }}
                  {...(autoClose
                    ? {
                        onUserInput: () => {
                          cancelAutoClose(tab.id);
                        },
                      }
                    : {})}
                />
              ) : null}
              {autoClose ? (
                <div className="terminal-panel-auto-close" role="status" aria-live="polite">
                  <Clock3 size={13} strokeWidth={1.9} aria-hidden />
                  <span className="terminal-panel-auto-close-label">
                    {t("terminal.autoClose", { count: autoClose.remainingSeconds })}
                  </span>
                  <span className="terminal-panel-auto-close-sep" aria-hidden />
                  <button
                    type="button"
                    className="terminal-panel-auto-close-cancel"
                    onClick={() => cancelAutoClose(tab.id)}
                  >
                    {t("common.cancel")}
                  </button>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}
