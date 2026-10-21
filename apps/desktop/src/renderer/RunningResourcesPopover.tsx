import { Activity, Folder, Globe, Loader2, MessageSquare, Server, Square, Terminal, X } from "lucide-react";
import { type CSSProperties, type RefObject, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { type BrowserInstanceView, isPersonalBrowserScopeId } from "../shared/browser";
import { pathToName } from "../shared/home-project";
import type { CodexBackgroundTerminal } from "../shared/ipc";
import { browserStateStore, useBrowserStateSelector } from "./browser-state-store";
import { collectRunningTerminals, type RunningTerminal } from "./running-resources";
import type { TerminalWorkspaceState } from "./terminal-panel-storage";
import { listTerminalSessionEntriesForProject } from "./terminal-session-cache";
import { webChatListPopoverBoxForRect } from "./web-chat-list-popover-layout";

interface RunningResourcesPopoverProps {
  anchorRef: RefObject<HTMLButtonElement | null>;
  threads: readonly { id: string; title: string }[];
  projects: readonly { path: string; name: string }[];
  terminalByProject: TerminalWorkspaceState;
  codexTerminals: readonly CodexBackgroundTerminal[];
  codexTerminalError?: string;
  onTerminateCodexTerminal: (
    terminal: Pick<CodexBackgroundTerminal, "codexThreadId" | "processId">,
  ) => Promise<void>;
  onClose: () => void;
  onTerminalClosed: (terminal: RunningTerminal) => void;
}

const EMPTY_PAGES: BrowserInstanceView[] = [];

function requireDesktopApi() {
  if (!window.eco) throw new Error("Desktop API unavailable");
  return window.eco;
}

export function RunningResourcesPopover({
  anchorRef,
  threads,
  projects,
  terminalByProject,
  codexTerminals,
  codexTerminalError,
  onTerminateCodexTerminal,
  onClose,
  onTerminalClosed,
}: RunningResourcesPopoverProps) {
  const { t } = useTranslation();
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [style, setStyle] = useState<CSSProperties>({ visibility: "hidden" });
  const pages = useBrowserStateSelector((state) => state?.allInstances ?? EMPTY_PAGES);
  const [terminals, setTerminals] = useState<RunningTerminal[]>([]);
  const [loading, setLoading] = useState(true);
  const [terminalError, setTerminalError] = useState("");
  const [browserError, setBrowserError] = useState("");
  const [actionError, setActionError] = useState("");
  const [closing, setClosing] = useState<Set<string>>(() => new Set());
  const closingRef = useRef(new Set<string>());
  const [refreshEpoch, setRefreshEpoch] = useState(0);

  useLayoutEffect(() => {
    const update = () => {
      if (anchorRef.current) {
        setStyle(
          webChatListPopoverBoxForRect(
            anchorRef.current.getBoundingClientRect(),
            { width: window.innerWidth, height: window.innerHeight },
            { width: 340, maxHeight: 560 },
          ),
        );
      }
    };
    update();
    const frame = window.requestAnimationFrame(() => closeRef.current?.focus());
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [anchorRef]);

  useEffect(() => {
    const pointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!panelRef.current?.contains(target) && !anchorRef.current?.contains(target)) onClose();
    };
    const keyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        anchorRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", pointerDown, true);
    document.addEventListener("keydown", keyDown, true);
    return () => {
      document.removeEventListener("pointerdown", pointerDown, true);
      document.removeEventListener("keydown", keyDown, true);
    };
  }, [anchorRef, onClose]);

  useEffect(() => {
    let cancelled = false;
    void browserStateStore.hydrate().catch((error) => {
      if (!cancelled) setBrowserError(String(error));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: A successful close invalidates the terminal snapshot via refreshEpoch.
  useEffect(() => {
    let cancelled = false;
    let fetching = false;
    const refresh = async () => {
      if (fetching) return;
      fetching = true;
      try {
        const api = requireDesktopApi();
        const [sessions, tasks] = await Promise.all([
          api.listTerminalSessions(),
          api.listBackgroundTerminalTasks(),
        ]);
        if (!cancelled) {
          setTerminals(collectRunningTerminals(sessions, tasks, codexTerminals));
          setTerminalError(codexTerminalError ?? "");
        }
      } catch (error) {
        if (!cancelled) setTerminalError(String(error));
      } finally {
        fetching = false;
        if (!cancelled) setLoading(false);
      }
    };
    const unsubscribe = window.eco?.onTerminalEvent((event) => {
      if (event.type !== "output") void refresh();
    });
    void refresh();
    // Explicit kills do not emit an exit event; reconcile while the list is open.
    const timer = window.setInterval(() => void refresh(), 2000);
    return () => {
      cancelled = true;
      unsubscribe?.();
      window.clearInterval(timer);
    };
  }, [codexTerminalError, codexTerminals, refreshEpoch]);

  const threadLabel = (threadId: string) =>
    isPersonalBrowserScopeId(threadId)
      ? t("app.running.personal")
      : threads.find((thread) => thread.id === threadId)?.title || threadId;
  const projectLabel = (workspacePath: string) =>
    projects.find((project) => project.path === workspacePath)?.name || pathToName(workspacePath);
  const pageLocation = (url: string) => {
    if (url.startsWith("file:") || url.startsWith("data:")) return t("app.running.localPage");
    if (url === "about:blank") return t("app.running.blankPage");
    return url.replace(/^https?:\/\/(?:www\.)?/, "").split(/[/?#]/)[0] || url;
  };

  const closeResource = async (key: string, label: string, action: () => Promise<void>) => {
    if (closingRef.current.has(key)) return;
    closingRef.current.add(key);
    setClosing(new Set(closingRef.current));
    setActionError("");
    try {
      await action();
    } catch (error) {
      setActionError(t("app.running.closeFailed", { title: label, detail: String(error) }));
    } finally {
      closingRef.current.delete(key);
      setClosing(new Set(closingRef.current));
    }
  };

  const closePage = (page: BrowserInstanceView) =>
    void closeResource(page.id, page.title || page.url, async () => {
      browserStateStore.setState(await requireDesktopApi().browserCloseInstance({ browserId: page.id }));
    });
  const closeTerminal = (terminal: RunningTerminal) =>
    void closeResource(terminal.sessionId, terminal.label || terminal.sessionId, async () => {
      const api = requireDesktopApi();
      if (terminal.codexThreadId && terminal.codexProcessId) {
        await onTerminateCodexTerminal({
          codexThreadId: terminal.codexThreadId,
          processId: terminal.codexProcessId,
        });
      } else if (terminal.taskId) {
        await api.stopBackgroundTerminalTask({ taskId: terminal.taskId });
      } else {
        await api.killTerminal(terminal.sessionId);
      }
      onTerminalClosed(terminal);
      setRefreshEpoch((epoch) => epoch + 1);
    });

  return createPortal(
    <div
      ref={panelRef}
      className="running-resources-popover"
      style={style}
      role="dialog"
      aria-label={t("app.running.title")}
    >
      <div className="running-resources-header">
        <div className="running-resources-heading">
          <Activity size={16} aria-hidden />
          <h2>{t("app.running.title")}</h2>
        </div>
        <button
          ref={closeRef}
          type="button"
          className="running-resources-icon-button"
          onClick={() => {
            onClose();
            anchorRef.current?.focus();
          }}
          aria-label={t("app.webChat.close")}
        >
          <X size={14} aria-hidden />
        </button>
      </div>
      <div className="running-resources-summary">
        <span>{t("app.running.allSessions")}</span>
        <span>{t("app.running.resourceCount", { count: pages.length + terminals.length })}</span>
      </div>
      <div className="running-resources-scroll">
        <section className="running-resources-section" aria-labelledby="running-resources-pages-title">
          <h3 id="running-resources-pages-title" className="running-resources-section-title">
            {t("app.running.pagesShort")}
            <span className="running-resources-count">{pages.length}</span>
          </h3>
          {browserError ? (
            <p className="running-resources-error" role="alert">
              {t("app.running.loadFailed", { detail: browserError })}
            </p>
          ) : null}
          {pages.length === 0 && !browserError ? (
            <p className="running-resources-empty">
              <Globe size={15} aria-hidden />
              {t("app.running.noPages")}
            </p>
          ) : null}
          <ul className="running-resources-list" aria-label={t("app.running.pages")}>
            {pages.map((page) => (
              <li key={page.id} className="running-resources-row" aria-busy={closing.has(page.id)}>
                <span className="running-resources-kind is-browser">
                  <Globe size={17} aria-hidden />
                </span>
                <div className="running-resources-item" title={`${threadLabel(page.threadId)}\n${page.url}`}>
                  <span className="running-resources-item-title">{page.title || pageLocation(page.url)}</span>
                  <span className="running-resources-meta">
                    <span className="running-resources-location">{pageLocation(page.url)}</span>
                    <span className="running-resources-meta-divider" aria-hidden />
                    <MessageSquare size={11} aria-hidden />
                    <span className="running-resources-owner">{threadLabel(page.threadId)}</span>
                  </span>
                </div>
                <button
                  type="button"
                  className="running-resources-icon-button is-destructive"
                  disabled={closing.has(page.id)}
                  onClick={() => closePage(page)}
                  title={t("app.running.closePage")}
                  aria-label={t("app.running.closeNamed", { title: page.title || page.url })}
                >
                  {closing.has(page.id) ? (
                    <Loader2 size={14} className="is-spinning" aria-hidden />
                  ) : (
                    <X size={14} aria-hidden />
                  )}
                </button>
              </li>
            ))}
          </ul>
        </section>
        <section className="running-resources-section" aria-labelledby="running-resources-terminals-title">
          <h3 id="running-resources-terminals-title" className="running-resources-section-title">
            {t("app.running.terminalsShort")}
            <span className="running-resources-count">{terminals.length}</span>
          </h3>
          {terminalError ? (
            <p className="running-resources-error" role="alert">
              {t("app.running.loadFailed", { detail: terminalError })}
            </p>
          ) : null}
          {loading ? (
            <p className="running-resources-empty" role="status">
              <Loader2 size={15} className="is-spinning" aria-hidden />
              {t("app.running.loading")}
            </p>
          ) : null}
          {!loading && !terminalError && terminals.length === 0 ? (
            <p className="running-resources-empty">
              <Terminal size={15} aria-hidden />
              {t("app.running.noTerminals")}
            </p>
          ) : null}
          <ul className="running-resources-list" aria-label={t("app.running.terminals")}>
            {terminals.map((terminal) => {
              const tabId = listTerminalSessionEntriesForProject(terminal.workspacePath).find(
                (entry) => entry.sessionId === terminal.sessionId,
              )?.tabId;
              const tab = terminalByProject[terminal.workspacePath]?.tabs.find((entry) => entry.id === tabId);
              const label =
                terminal.label ||
                tab?.label ||
                t(terminal.kind === "ssh" ? "app.running.ssh" : "app.terminalFallback");
              const processDetail = [
                terminal.osPid !== undefined ? `PID ${terminal.osPid}` : undefined,
                terminal.cpuPercent !== undefined
                  ? t("app.running.processCpu", { value: terminal.cpuPercent.toFixed(1) })
                  : undefined,
                terminal.rssKb !== undefined
                  ? t("app.running.processMemory", { value: Math.max(1, Math.round(terminal.rssKb / 1024)) })
                  : undefined,
              ]
                .filter(Boolean)
                .join(" · ");
              return (
                <li
                  key={terminal.sessionId}
                  className="running-resources-row"
                  aria-busy={closing.has(terminal.sessionId)}
                >
                  <span className="running-resources-kind is-terminal">
                    {terminal.kind === "ssh" ? (
                      <Server size={17} aria-hidden />
                    ) : (
                      <Terminal size={17} aria-hidden />
                    )}
                    <span className="running-resources-live-dot" />
                  </span>
                  <div
                    className="running-resources-item"
                    title={[
                      terminal.workspacePath,
                      terminal.codexProcessId ? `processId ${terminal.codexProcessId}` : undefined,
                      terminal.endpoint || terminal.sessionId,
                    ].filter(Boolean).join("\n")}
                  >
                    <span className="running-resources-title-line">
                      <span className="running-resources-item-title">{label}</span>
                      {terminal.kind === "ssh" || terminal.taskId || terminal.codexProcessId ? (
                        <span className="running-resources-tag">
                          {terminal.kind === "ssh"
                            ? "SSH"
                            : terminal.codexProcessId
                              ? t("app.running.agentBash")
                              : t("app.running.background")}
                        </span>
                      ) : null}
                    </span>
                    <span className="running-resources-meta">
                      {terminal.threadId ? (
                        <MessageSquare size={11} aria-hidden />
                      ) : (
                        <Folder size={11} aria-hidden />
                      )}
                      <span className="running-resources-owner">
                        {terminal.threadId
                          ? threadLabel(terminal.threadId)
                          : projectLabel(terminal.workspacePath)}
                      </span>
                      {terminal.endpoint ? (
                        <>
                          <span className="running-resources-meta-divider" aria-hidden />
                          <span className="running-resources-endpoint">{terminal.endpoint}</span>
                        </>
                      ) : null}
                      {processDetail ? (
                        <>
                          <span className="running-resources-meta-divider" aria-hidden />
                          <span className="running-resources-endpoint">{processDetail}</span>
                        </>
                      ) : null}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="running-resources-icon-button is-destructive"
                    disabled={closing.has(terminal.sessionId)}
                    onClick={() => closeTerminal(terminal)}
                    title={t("app.running.closeTerminal")}
                    aria-label={t("app.running.closeNamed", { title: label })}
                  >
                    {closing.has(terminal.sessionId) ? (
                      <Loader2 size={14} className="is-spinning" aria-hidden />
                    ) : (
                      <Square size={11} fill="currentColor" aria-hidden />
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      </div>
      {actionError ? (
        <p className="running-resources-error is-action-error" role="alert">
          {actionError}
        </p>
      ) : null}
    </div>,
    document.body,
  );
}
