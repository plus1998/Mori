import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { FolderClosed } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import {
  type ActivityHeaderProjectInfoPopoverBox,
  activityHeaderProjectInfoPopoverBoxForRect,
} from "./activity-header-project-info-layout";
import { ConversationShareButton } from "./ConversationShareButton";
import { ICON_SIZE, ICON_STROKE } from "./icon-metrics";

export interface ActivityHeaderProjectInfoPanelProps {
  projectName: string;
  projectPath: string;
  threadCount: number;
  threadId: string;
  acpSessionId?: string;
  onOpenProjectFolder: () => void;
}

export interface ActivityHeaderProjectInfoProps {
  projectName: string;
  projectPath: string;
  threadCount: number;
  threadId: string;
  acpSessionId?: string;
  onError: (message: string) => void;
}

const POPOVER_SPRING = { type: "spring" as const, bounce: 0, duration: 0.34 };
const POPOVER_FADE = { duration: 0.18, ease: "easeOut" as const };

function panelStyleFromAnchor(anchor: HTMLElement): ActivityHeaderProjectInfoPopoverBox {
  const rect = anchor.getBoundingClientRect();
  return activityHeaderProjectInfoPopoverBoxForRect(rect, {
    width: window.innerWidth,
    height: window.innerHeight,
  });
}

export function ActivityHeaderProjectInfoPanel({
  projectName,
  projectPath,
  threadCount,
  threadId,
  acpSessionId,
  onOpenProjectFolder,
}: ActivityHeaderProjectInfoPanelProps) {
  const { t } = useTranslation();
  const cursorSessionId = acpSessionId?.trim() || undefined;
  return (
    <div className="activity-header-project-info-panel">
      <header className="activity-header-project-info-hero">
        <h3 className="activity-header-project-info-name">{projectName}</h3>
        <p className="activity-header-project-info-count">
          {t("thread.projectSessionCount", { count: threadCount })}
        </p>
      </header>
      <dl className="activity-header-project-info-list">
        <div className="activity-header-project-info-row">
          <dt>{t("thread.projectPath")}</dt>
          <dd>
            <button
              type="button"
              className="activity-header-project-info-path"
              title={t("thread.openProjectFolder")}
              onClick={onOpenProjectFolder}
            >
              {projectPath}
            </button>
          </dd>
        </div>
        <div className="activity-header-project-info-row">
          <dt>{t("thread.sessionId")}</dt>
          <dd>
            <span className="activity-header-project-info-id">{threadId}</span>
          </dd>
        </div>
        {cursorSessionId ? (
          <div className="activity-header-project-info-row">
            <dt>{t("thread.acpSessionId")}</dt>
            <dd>
              <span className="activity-header-project-info-id">{cursorSessionId}</span>
            </dd>
          </div>
        ) : null}
      </dl>
      <div className="activity-header-project-info-actions">
        <ConversationShareButton threadId={threadId} showLabel />
      </div>
    </div>
  );
}

export function ActivityHeaderProjectInfo({
  projectName,
  projectPath,
  threadCount,
  threadId,
  acpSessionId,
  onError,
}: ActivityHeaderProjectInfoProps) {
  const { t } = useTranslation();
  const prefersReducedMotion = useReducedMotion();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [panelStyle, setPanelStyle] = useState<
    ActivityHeaderProjectInfoPopoverBox | { visibility: "hidden" }
  >({ visibility: "hidden" });

  const updatePanelPosition = useCallback(() => {
    const anchor = buttonRef.current;
    if (!anchor) {
      return;
    }
    setPanelStyle(panelStyleFromAnchor(anchor));
  }, []);

  useLayoutEffect(() => {
    if (!open) {
      return;
    }
    updatePanelPosition();
    window.addEventListener("resize", updatePanelPosition);
    window.addEventListener("scroll", updatePanelPosition, true);
    return () => {
      window.removeEventListener("resize", updatePanelPosition);
      window.removeEventListener("scroll", updatePanelPosition, true);
    };
  }, [open, updatePanelPosition]);

  useEffect(() => {
    if (!open) {
      return;
    }
    function onPointerDown(event: MouseEvent) {
      const target = event.target as Node;
      if (panelRef.current?.contains(target) || buttonRef.current?.contains(target)) {
        return;
      }
      setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  async function openProjectFolder() {
    if (!window.eco?.openWorkspaceInFileManager) {
      onError(t("app.preload.openWorkspaceInFileManager"));
      return;
    }
    try {
      await window.eco.openWorkspaceInFileManager(projectPath);
      setOpen(false);
    } catch (error) {
      onError(
        error instanceof Error
          ? error.message
          : t("thread.openProjectFolderFailed", { detail: String(error) }),
      );
    }
  }

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={["activity-header-project-info-trigger", open ? "is-open" : ""].filter(Boolean).join(" ")}
        title={t("thread.projectInfo")}
        aria-label={t("thread.projectInfo")}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <FolderClosed size={ICON_SIZE.sm} strokeWidth={ICON_STROKE} aria-hidden />
      </button>
      {typeof document !== "undefined"
        ? createPortal(
            <AnimatePresence>
              {open ? (
                <motion.div
                  key="activity-header-project-info"
                  ref={panelRef}
                  className="activity-header-project-info-popover"
                  role="dialog"
                  aria-label={t("thread.projectInfo")}
                  style={
                    panelStyle.visibility === "hidden"
                      ? { visibility: "hidden" }
                      : { transformOrigin: "20px 0px", ...panelStyle }
                  }
                  initial={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.96, y: -6 }}
                  animate={prefersReducedMotion ? { opacity: 1 } : { opacity: 1, scale: 1, y: 0 }}
                  exit={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.96, y: -6 }}
                  transition={prefersReducedMotion ? POPOVER_FADE : POPOVER_SPRING}
                >
                  <ActivityHeaderProjectInfoPanel
                    projectName={projectName}
                    projectPath={projectPath}
                    threadCount={threadCount}
                    threadId={threadId}
                    {...(acpSessionId ? { acpSessionId } : {})}
                    onOpenProjectFolder={() => {
                      void openProjectFolder();
                    }}
                  />
                </motion.div>
              ) : null}
            </AnimatePresence>,
            document.body,
          )
        : null}
    </>
  );
}
