import { parseTtsTaskTabId, ttsTaskTabId, type TtsArtifact } from "../shared/tts";
import { TtsArtifactPlayer } from "./TtsArtifactPlayer";
import { shortenModelId } from "@eco/runtime/usage";
import {
  Bot,
  Check,
  Circle,
  Copy,
  ExternalLink,
  FileText,
  FolderOpen,
  Globe,
  Image as ImageIcon,
  KeyRound,
  ListChecks,
  LoaderCircle,
  Plus,
  Square,
  Terminal,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  browserTaskTabId,
  isBrowserPlaceholderUrl,
  isBrowserTaskTabId,
  parseBrowserTaskTabId,
} from "../shared/browser";
import type { CenterServerSyncDomain, CenterServerSyncDomainResult } from "../shared/center-server";
import { imageGenerationTaskTabId, parseImageGenerationTaskTabId } from "../shared/image-generation";
import { imageDisplayTaskTabId, parseImageDisplayTaskTabId } from "../shared/image-display";
import type {
  BackgroundTerminalTask,
  ImageDisplayArtifact,
  ImageGenerationArtifact,
  ThreadPendingPlan,
  ThreadRunProjectionSnapshot,
  ThreadStatus,
  WorkspaceDiffResult,
} from "../shared/ipc";
import type { SshBookmarkView } from "../shared/ssh-bookmarks";
import { ProjectionSubagentDetailFeed } from "./ActivityLogView";
import { resolveSubagentRunDisplayTitle } from "./activity-log";
import { BrowserPanel } from "./BrowserPanel";
import { TaskPanelTabOrder } from "./TaskPanelTabOrder";
import { TaskPanelNewTab } from "./TaskPanelNewTab";
import { useBrowserTaskInstances } from "./browser-state-store";
import { copyTextToClipboard } from "./clipboard";
import { i18n } from "./i18n";
import { ImageLightbox } from "./image-lightbox";
import {
  createImageObjectUrlFromBase64,
  revokeImageObjectUrl,
  revokeImageObjectUrls,
} from "./image-object-url";
import { MarkdownContent } from "./MarkdownContent";
import { type RuntimeAgentDisplayNames, resolveRuntimeAgentName } from "./runtime-agent-display";
import { type RuntimeAgentThemes, resolveSubagentRowThemeStyle } from "./runtime-agent-theme";
import { SshBookmarksPanel } from "./SshBookmarksPanel";
import type { ThreadRunProjectionSubagentCard } from "./conversation-v2-projection-view";
import { useEcoWorkspaceFileDiffLoader, WorkspaceDiffPanel } from "./WorkspaceDiffDrawer";
import { WorkspaceFileBrowser } from "./WorkspaceFileBrowser";
import { WorkspaceFileViewer } from "./WorkspaceFileViewer";
import { basename } from "./workspace-file-browser-logic";
import type { WorkspaceFileReference } from "./workspace-file-reference";
import {
  TASK_PANEL_BACKGROUND_TERMINAL_TAB_ID,
  TASK_PANEL_BROWSER_TAB_ID,
  TASK_PANEL_FILES_TAB_ID,
  TASK_PANEL_FILE_VIEWER_TAB_ID,
  TASK_PANEL_HOME_TAB_ID,
  TASK_PANEL_PLAN_TAB_ID,
  TASK_PANEL_REVIEW_TAB_ID,
  TASK_PANEL_SSH_BOOKMARKS_TAB_ID,
  type TaskPanelActiveTab,
  type TaskPanelHomeTool,
  isNewTaskPanelTabId,
} from "./task-panel-tabs";
import "./subagent-task-drawer-home.css";

export {
  TASK_PANEL_BACKGROUND_TERMINAL_TAB_ID,
  TASK_PANEL_BROWSER_TAB_ID,
  TASK_PANEL_FILES_TAB_ID,
  TASK_PANEL_FILE_VIEWER_TAB_ID,
  TASK_PANEL_HOME_TAB_ID,
  TASK_PANEL_PLAN_TAB_ID,
  TASK_PANEL_REVIEW_TAB_ID,
  TASK_PANEL_SSH_BOOKMARKS_TAB_ID,
  type TaskPanelActiveTab,
} from "./task-panel-tabs";

export type TaskPanelBrowserInstance = {
  id: string;
  title: string;
  url: string;
  faviconUrl?: string;
  isLoading?: boolean;
};

function TaskBrowserTabIcon({ faviconUrl, label }: { faviconUrl?: string; label: string }) {
  const [failed, setFailed] = useState(false);
  if (!faviconUrl || failed) {
    return <Globe size={15} aria-hidden />;
  }
  return (
    <img
      className="subagent-task-panel-tab-favicon"
      src={faviconUrl}
      alt=""
      title={label}
      draggable={false}
      onError={() => setFailed(true)}
      aria-hidden
    />
  );
}

type ProjectionRequestSpan = ThreadRunProjectionSnapshot["requestSpans"][number];

const emptyRequestSpansById = new Map<string, ProjectionRequestSpan>();

type StableSubagentCardSnapshot = {
  active: boolean;
  card: ThreadRunProjectionSubagentCard;
  signature: string;
};

type StableSubagentRequestSpansSnapshot = {
  active: boolean;
  signature: string;
  spansById: Map<string, ProjectionRequestSpan>;
};

function isThreadActive(status?: ThreadStatus | string): boolean {
  return status === "running" || status === "queued" || status === "awaiting_plan";
}

function isSubagentActive(card: ThreadRunProjectionSubagentCard): boolean {
  return card.agent.status === "active" || card.agent.status === "launching" || card.running;
}

function subagentRoleLabel(role: string, displayNames?: RuntimeAgentDisplayNames): string {
  return resolveRuntimeAgentName(role, displayNames) ?? resolveSubagentRunDisplayTitle(role);
}

function subagentTimelineItemSignature(
  item: ThreadRunProjectionSubagentCard["agent"]["timeline"][number],
): string {
  return (
    JSON.stringify([
      item.id,
      item.sequence,
      item.eventType,
      item.scope,
      item.role ?? "",
      item.agentId ?? "",
      item.requestId ?? "",
      item.streamKey ?? "",
      item.at,
      item.text,
      item.metadata ?? null,
    ]) ?? ""
  );
}

function subagentCardSignature(card: ThreadRunProjectionSubagentCard): string {
  const timeline = card.agent.timeline;
  const usage = card.agent.usage;
  return [
    card.agent.agentId,
    card.agent.status,
    card.agent.endedAt ?? "",
    card.missionText,
    card.promptImages?.map((image) => `${image.id}:${image.mediaType}:${image.data}`).join("|") ?? "",
    card.agent.mission ?? "",
    card.agent.delegationPrompt ?? "",
    card.agent.delegationSummary ?? "",
    card.statusText ?? "",
    card.agent.latestActivity ?? "",
    timeline.map(subagentTimelineItemSignature).join("|"),
    usage
      ? [
          usage.inputTokens,
          usage.outputTokens,
          usage.cacheReadTokens,
          usage.cacheCreationTokens,
          usage.ecoCostUsd,
          usage.modelId ?? "",
        ].join("/")
      : "",
    card.agent.context?.occupancyPct ?? "",
  ].join(":");
}

function requestSpanSignature(span: ProjectionRequestSpan): string {
  return [
    span.requestId,
    span.ownerAgentId ?? "",
    span.status,
    span.startedAt,
    span.firstTokenAt ?? "",
    span.endedAt ?? "",
    span.error ?? "",
  ].join(":");
}

function subagentRequestSpanKeys(card: ThreadRunProjectionSubagentCard): string[] {
  const keys = new Set<string>();
  for (const item of card.agent.timeline) {
    const key = item.requestId?.trim();
    if (key) {
      keys.add(key);
    }
  }
  return [...keys];
}

function useStableSubagentCard(
  card: ThreadRunProjectionSubagentCard | undefined,
): ThreadRunProjectionSubagentCard | undefined {
  const snapshotsRef = useRef(new Map<string, StableSubagentCardSnapshot>());

  if (!card) {
    return undefined;
  }
  const active = isSubagentActive(card);
  const snapshot = snapshotsRef.current.get(card.key);
  if (!active && snapshot && !snapshot.active) {
    return snapshot.card;
  }

  const signature = subagentCardSignature(card);
  if (active) {
    if (!snapshot?.active || snapshot.signature !== signature) {
      snapshotsRef.current.set(card.key, { active, card, signature });
      return card;
    }
    return snapshot.card;
  }

  if (!snapshot || snapshot.active) {
    snapshotsRef.current.set(card.key, { active, card, signature });
    return card;
  }
  return snapshot.card;
}

function useStableSubagentRequestSpansById(
  card: ThreadRunProjectionSubagentCard | undefined,
  requestSpans: readonly ProjectionRequestSpan[],
): Map<string, ProjectionRequestSpan> {
  const snapshotsRef = useRef(new Map<string, StableSubagentRequestSpansSnapshot>());

  if (!card) {
    return emptyRequestSpansById;
  }

  const active = isSubagentActive(card);
  const snapshot = snapshotsRef.current.get(card.key);
  if (!active && snapshot && !snapshot.active) {
    return snapshot.spansById;
  }

  const requestSpanKeys = subagentRequestSpanKeys(card);
  const spanById = new Map(requestSpans.map((span) => [span.requestId, span]));
  const spans = requestSpanKeys
    .map((key) => spanById.get(key))
    .filter((span): span is ProjectionRequestSpan => Boolean(span));
  const signature = spans.map(requestSpanSignature).join("|");
  if (active) {
    if (!snapshot?.active || snapshot.signature !== signature) {
      const spansById = new Map(spans.map((span) => [span.requestId, span]));
      snapshotsRef.current.set(card.key, { active, signature, spansById });
      return spansById;
    }
    return snapshot.spansById;
  }

  if (!snapshot || snapshot.active) {
    const spansById = new Map(spans.map((span) => [span.requestId, span]));
    snapshotsRef.current.set(card.key, { active, signature, spansById });
    return spansById;
  }
  return snapshot.spansById;
}

function SubagentProjectionDetail({
  card,
  requestSpansById,
  threadActive,
}: {
  card: ThreadRunProjectionSubagentCard;
  projection?: ThreadRunProjectionSnapshot;
  requestSpansById: Map<string, ProjectionRequestSpan>;
  threadActive: boolean;
  v2Only?: boolean;
}) {
  return (
    <ProjectionSubagentDetailFeed
      agent={card.agent}
      missionText={card.missionText}
      requestSpansById={requestSpansById}
      threadActive={threadActive}
      {...(card.promptImages && { images: card.promptImages })}
    />
  );
}

function taskStatusLabel(status: BackgroundTerminalTask["status"]): string {
  switch (status) {
    case "running":
      return i18n.t("task.status.running");
    case "starting":
      return i18n.t("task.status.starting");
    case "exited":
      return i18n.t("task.status.exited");
    case "failed":
      return i18n.t("task.status.failed");
    case "stopped":
      return i18n.t("task.status.stopped");
  }
}

function taskStatusTone(status: BackgroundTerminalTask["status"]): string {
  if (status === "running" || status === "starting") {
    return "running";
  }
  if (status === "failed") {
    return "failed";
  }
  return "done";
}

function formatCommand(command: readonly string[]): string {
  return command.join(" ");
}

export function BackgroundTerminalTasksPanel({
  tasks,
  onOpenTask,
  onStopTask,
}: {
  tasks: readonly BackgroundTerminalTask[];
  onOpenTask: (task: BackgroundTerminalTask) => void;
  onStopTask: (task: BackgroundTerminalTask) => void;
}) {
  const { t } = useTranslation();
  if (tasks.length === 0) {
    return null;
  }

  return (
    <section className="background-terminal-tasks" aria-label={t("task.background")}>
      <div className="subagent-task-section-head">
        <span className="subagent-task-section-title">
          <Terminal size={14} aria-hidden />
          {t("task.backgroundLabel")}
        </span>
        <span className="subagent-task-section-count">{tasks.length}</span>
      </div>
      <div className="background-terminal-task-list">
        {tasks.map((task) => {
          const running = task.status === "running" || task.status === "starting";
          return (
            <div key={task.taskId} className="background-terminal-task-row">
              <button
                type="button"
                className="background-terminal-task-open"
                onClick={() => onOpenTask(task)}
                title={formatCommand(task.command)}
              >
                <span className={`background-terminal-task-dot tone-${taskStatusTone(task.status)}`}>
                  <Circle size={8} aria-hidden />
                </span>
                <span className="background-terminal-task-main">
                  <span className="background-terminal-task-label">{task.label}</span>
                  <span className="background-terminal-task-command">{formatCommand(task.command)}</span>
                </span>
                <span className="background-terminal-task-status">{taskStatusLabel(task.status)}</span>
                <ExternalLink size={13} aria-hidden />
              </button>
              <button
                type="button"
                className="background-terminal-task-stop"
                onClick={() => onStopTask(task)}
                disabled={!running}
                title={running ? t("task.stopBackground") : t("task.ended")}
                aria-label={t("task.stopNamed", { name: task.label })}
              >
                <Square size={12} aria-hidden />
              </button>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function PlanDetailPanel({ plan }: { plan: ThreadPendingPlan }) {
  const { t } = useTranslation();
  const analysis = plan.analysis.trim();
  const [copied, setCopied] = useState(false);
  const planText = plan.plan.trim();

  function copyPlan() {
    if (!planText) {
      return;
    }
    void copyTextToClipboard(plan.plan).then((ok) => {
      if (!ok) {
        return;
      }
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  }

  const copyLabel = copied ? t("task.planCopied") : t("task.copyPlan");

  return (
    <section className="task-plan-detail" aria-label={t("task.fullPlan")}>
      <header className="task-plan-detail-header">
        <span className="task-plan-detail-title">{t("task.fullPlan")}</span>
        <button
          type="button"
          className={`task-plan-detail-copy${copied ? " is-copied" : ""}`}
          onClick={copyPlan}
          disabled={!planText}
          title={copyLabel}
          aria-label={copyLabel}
        >
          {copied ? (
            <Check size={15} strokeWidth={2} aria-hidden />
          ) : (
            <Copy size={15} strokeWidth={1.75} aria-hidden />
          )}
        </button>
      </header>
      <div className="task-plan-detail-body">
        <section className="task-plan-detail-section">
          <div className="task-plan-detail-markdown">
            <MarkdownContent text={plan.plan} />
          </div>
        </section>
        {analysis ? (
          <section className="task-plan-detail-section task-plan-detail-section--analysis">
            <h3>{t("task.analysis")}</h3>
            <pre>{analysis}</pre>
          </section>
        ) : null}
      </div>
    </section>
  );
}

function ImageGenerationArtifactDetail({ artifact }: { artifact: ImageGenerationArtifact }) {
  const { t } = useTranslation();
  const [images, setImages] = useState<string[]>([]);
  const [loadError, setLoadError] = useState<string>();
  const [revealError, setRevealError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    const objectUrls: string[] = [];
    setImages([]);
    setLoadError(undefined);
    setRevealError(undefined);
    if (artifact.images.length === 0 || !window.eco?.readImageGenerationArtifact) return;
    void Promise.all(
      artifact.images.map((_, imageIndex) =>
        window.eco!.readImageGenerationArtifact({ artifactId: artifact.id, imageIndex }),
      ),
    )
      .then((results) => {
        for (const result of results) {
          const url = createImageObjectUrlFromBase64(result.mimeType, result.dataBase64);
          if (cancelled) {
            revokeImageObjectUrl(url);
            continue;
          }
          objectUrls.push(url);
        }
        if (!cancelled) {
          setImages([...objectUrls]);
        }
      })
      .catch((error) => {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
      revokeImageObjectUrls(objectUrls);
    };
  }, [artifact.id, artifact.images.length]);

  async function handleRevealImage(imageIndex: number) {
    if (!window.eco?.revealImageGenerationArtifact) {
      setRevealError(t("task.image.openLocationUnavailable"));
      return;
    }
    setRevealError(undefined);
    try {
      await window.eco.revealImageGenerationArtifact({ artifactId: artifact.id, imageIndex });
    } catch (error) {
      setRevealError(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <section className="image-artifact-detail">
      <header>
        <span className={`image-artifact-status is-${artifact.status}`}>
          {t(`task.image.status.${artifact.status}`)}
        </span>
        <span>
          {artifact.profileName} · {artifact.model}
        </span>
      </header>
      <section>
        <h3>{t("task.image.prompt")}</h3>
        <p className="image-artifact-prompt">{artifact.prompt}</p>
      </section>
      <section>
        <h3>{t("task.image.parameters")}</h3>
        <pre>{JSON.stringify(artifact.parameters, null, 2)}</pre>
      </section>
      {artifact.errorMessage ? (
        <section className="image-artifact-error">
          <h3>{artifact.errorCode ?? t("task.image.error")}</h3>
          <p>{artifact.errorMessage}</p>
        </section>
      ) : null}
      {loadError ? <p className="image-artifact-error">{loadError}</p> : null}
      {revealError ? (
        <p className="image-artifact-error" role="alert">
          {revealError}
        </p>
      ) : null}
      {images.length > 0 ? (
        <div className="image-artifact-gallery">
          {images.map((source, index) => (
            <figure key={artifact.images[index]?.relativePath ?? index}>
              <img src={source} alt={`${t("task.image.generated")} ${index + 1}`} />
              <figcaption className="image-artifact-caption">
                <span>{artifact.images[index]?.relativePath}</span>
                <button
                  type="button"
                  className="image-artifact-location-button"
                  onClick={() => void handleRevealImage(index)}
                  title={t("task.image.openLocation")}
                  aria-label={t("task.image.openLocation")}
                >
                  <FolderOpen size={13} aria-hidden />
                  <span>{t("task.image.openLocation")}</span>
                </button>
              </figcaption>
            </figure>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function ImageDisplayArtifactDetail({ artifact }: { artifact: ImageDisplayArtifact }) {
  const { t } = useTranslation();
  const [src, setSrc] = useState<string>();
  const [fileName, setFileName] = useState<string>();
  const [filePath, setFilePath] = useState<string>();
  const [loadError, setLoadError] = useState<string>();
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const closeLightbox = useCallback(() => setLightboxOpen(false), []);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | undefined;
    setSrc(undefined);
    setFileName(undefined);
    setFilePath(undefined);
    setLoadError(undefined);
    setLightboxOpen(false);
    if (!window.eco?.readImageDisplay) {
      setLoadError(t("activity.imageDisplay.error.bridgeUnavailable"));
      return;
    }
    void window.eco
      .readImageDisplay({ artifactId: artifact.id })
      .then((result) => {
        if (cancelled) return;
        if (!result.ok) {
          const codeKey =
            result.code === "invalid_artifact"
              ? "invalidArtifact"
              : result.code === "not_found"
                ? "notFound"
                : result.code === "too_large"
                  ? "tooLarge"
                  : result.code === "unsupported_type"
                    ? "unsupportedType"
                    : "readFailed";
          setLoadError(t(`activity.imageDisplay.error.${codeKey}`));
          return;
        }
        objectUrl = createImageObjectUrlFromBase64(result.mimeType, result.dataBase64);
        if (cancelled) {
          revokeImageObjectUrl(objectUrl);
          objectUrl = undefined;
          return;
        }
        setSrc(objectUrl);
        setFileName(result.fileName);
        setFilePath(result.path);
      })
      .catch((error) => {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
      revokeImageObjectUrl(objectUrl);
    };
  }, [artifact.id, t]);

  const title = artifact.title?.trim() || fileName || artifact.sourceRef || t("task.imageDisplay.emptyTitle");
  const metaParts = [
    t(`task.imageDisplay.source.${artifact.sourceKind}`),
    artifact.width && artifact.height
      ? t("task.imageDisplay.dimensions", { width: artifact.width, height: artifact.height })
      : undefined,
    artifact.bytes > 0 ? t("task.imageDisplay.bytes", { bytes: artifact.bytes }) : undefined,
  ].filter(Boolean);
  const previewAlt = t("activity.imageDisplay.previewAlt", { name: title });
  const revealInFolder = useCallback(() => {
    if (!filePath) return;
    const bridge = window.eco;
    if (!bridge?.revealImageInFolder) return;
    void bridge.revealImageInFolder({ path: filePath }).catch((error) => {
      console.warn("Failed to open the folder containing the image.", error);
    });
  }, [filePath]);

  return (
    <section className="image-artifact-detail image-artifact-detail--display">
      <header>
        <div className="image-artifact-detail-heading">
          <span className={`image-artifact-status is-${artifact.status}`}>
            {t(`task.imageDisplay.status.${artifact.status}`)}
          </span>
          <p className="image-artifact-detail-title" title={title}>
            {title}
          </p>
        </div>
        {metaParts.length > 0 ? (
          <span className="image-artifact-detail-meta">{metaParts.join(" · ")}</span>
        ) : null}
      </header>
      {loadError ? <p className="image-artifact-error">{loadError}</p> : null}
      {src ? (
        <div className="image-artifact-gallery image-artifact-gallery--display">
          <figure>
            <button
              type="button"
              className="image-artifact-preview-button"
              onClick={() => setLightboxOpen(true)}
              aria-label={t("activity.imageDisplay.open", { name: title })}
              title={t("activity.imageDisplay.open", { name: title })}
            >
              <img src={src} alt={previewAlt} />
            </button>
          </figure>
        </div>
      ) : null}
      {lightboxOpen && src ? (
        <ImageLightbox
          src={src}
          alt={previewAlt}
          title={title}
          dialogLabel={t("activity.imageDisplay.open", { name: title })}
          onOpenFolder={revealInFolder}
          onClose={closeLightbox}
        />
      ) : null}
    </section>
  );
}

export function SubagentTaskDrawer({
  open,
  surfaceActive = open,
  fullscreen,
  cards,
  projection,
  v2Only = false,
  plan,
  activeTab,
  openTabIds,
  threadStatus,
  agentDisplayNames,
  agentThemes,
  backgroundTasks,
  ttsArtifacts = [],
  onSelectTtsArtifact,
  imageArtifacts = [],
  imageDisplayArtifacts = [],
  reviewDiff,
  reviewLoading,
  reviewError,
  reviewSelectedPath,
  reviewRevision,
  onRefreshReview,
  onSelectAgent,
  onSelectPlan,
  onCloseTab,
  onSelectBackgroundTasks,
  onSelectReview,
  workspacePath,
  threadId,
  fileTarget,
  onSelectFiles,
  onSelectFileViewer,
  onSelectBrowser,
  browserInstances,
  onViewedFileChange,
  onOpenHomeTool,
  onNavigateNewTab,
  onSelectNewTab,
  onNewBrowserTab,
  onSelectReviewPath,
  onOpenTerminalTask,
  onStopTerminalTask,
  onSelectImageArtifact,
  onSelectImageDisplayArtifact,
  sshBookmarks = [],
  onSelectSshBookmarks,
  onConnectSshBookmark,
  onSshBookmarksChange,
  centerServerSyncVisible,
  onSyncDomain,
}: {
  open: boolean;
  /**
   * False while the panel is exit-animating (or fully closed).
   * Keeps drawer chrome mounted for exit motion; browser webviews remain in the DOM.
   */
  surfaceActive?: boolean;
  fullscreen: boolean;
  cards: readonly ThreadRunProjectionSubagentCard[];
  projection?: ThreadRunProjectionSnapshot;
  /** When true, agent detail is already complete in the V2 renderer state. */
  v2Only?: boolean;
  plan?: ThreadPendingPlan;
  activeTab: TaskPanelActiveTab;
  openTabIds: readonly TaskPanelActiveTab[];
  threadStatus?: ThreadStatus;
  agentDisplayNames?: RuntimeAgentDisplayNames;
  agentThemes?: RuntimeAgentThemes;
  backgroundTasks: readonly BackgroundTerminalTask[];
  ttsArtifacts?: readonly TtsArtifact[];
  onSelectTtsArtifact?: (id: string) => void;
  imageArtifacts?: readonly ImageGenerationArtifact[];
  imageDisplayArtifacts?: readonly ImageDisplayArtifact[];
  reviewDiff?: WorkspaceDiffResult;
  reviewLoading?: boolean;
  reviewError?: string;
  reviewSelectedPath?: string;
  /** Bumped when the reviewer refreshes manually, to drop cached per-file diffs. */
  reviewRevision?: number;
  onRefreshReview?: () => void;
  onSelectAgent: (agentId: string) => void;
  onSelectPlan: () => void;
  onCloseTab: (tabId: TaskPanelActiveTab) => void;
  onSelectBackgroundTasks: () => void;
  onSelectReview: () => void;
  workspacePath: string;
  threadId?: string;
  fileTarget?: WorkspaceFileReference & { requestId: number; restricted?: boolean };
  onSelectFiles: () => void;
  onSelectFileViewer: () => void;
  onSelectBrowser: (browserId?: string) => void;
  browserInstances?: readonly TaskPanelBrowserInstance[];
  onViewedFileChange: (target: WorkspaceFileReference & { requestId: number }) => void;
  onOpenHomeTool: (sourceTabId: string, tool: TaskPanelHomeTool) => void;
  onNavigateNewTab: (tabId: string, url: string) => Promise<void>;
  onSelectNewTab: (tabId: string) => void;
  onNewBrowserTab: () => void;
  onSelectReviewPath: (path: string) => void;
  onOpenTerminalTask: (task: BackgroundTerminalTask) => void;
  onStopTerminalTask: (task: BackgroundTerminalTask) => void;
  onSelectImageArtifact: (artifactId: string) => void;
  onSelectImageDisplayArtifact: (artifactId: string) => void;
  sshBookmarks?: readonly SshBookmarkView[];
  onSelectSshBookmarks: () => void;
  onConnectSshBookmark: (bookmark: SshBookmarkView) => void | Promise<void>;
  onSshBookmarksChange: (bookmarks: SshBookmarkView[]) => void;
  centerServerSyncVisible?: boolean;
  onSyncDomain?: (
    domain: CenterServerSyncDomain,
    mode: "pull" | "push",
  ) => Promise<CenterServerSyncDomainResult>;
}) {
  const { t } = useTranslation();
  const storedBrowserInstances = useBrowserTaskInstances();
  const resolvedBrowserInstances = browserInstances ?? storedBrowserInstances;
  const loadFileDiff = useEcoWorkspaceFileDiffLoader();
  const filesSelected = activeTab === TASK_PANEL_FILES_TAB_ID;
  const fileViewerSelected = activeTab === TASK_PANEL_FILE_VIEWER_TAB_ID;
  const reviewSelected = activeTab === TASK_PANEL_REVIEW_TAB_ID;
  const planSelected = activeTab === TASK_PANEL_PLAN_TAB_ID;
  const terminalTasksSelected = activeTab === TASK_PANEL_BACKGROUND_TERMINAL_TAB_ID;
  const sshBookmarksSelected = activeTab === TASK_PANEL_SSH_BOOKMARKS_TAB_ID;
  const activeBrowserId = parseBrowserTaskTabId(String(activeTab));
  const browserSelected = Boolean(activeBrowserId);
  const newTabIds = openTabIds.filter(isNewTaskPanelTabId);
  const newTabSelected = isNewTaskPanelTabId(activeTab);
  const activeTtsArtifactId = parseTtsTaskTabId(String(activeTab));
  const activeTtsArtifact = ttsArtifacts.find(artifact => artifact.id === activeTtsArtifactId);
  const openTtsArtifacts = ttsArtifacts.filter(artifact => openTabIds.includes(ttsTaskTabId(artifact.id)));
  const activeImageArtifactId = parseImageGenerationTaskTabId(String(activeTab));
  const imageSelected = Boolean(activeImageArtifactId);
  const activeImageArtifact = imageArtifacts.find((artifact) => artifact.id === activeImageArtifactId);
  const openImageArtifacts = openTabIds
    .map((tabId) => parseImageGenerationTaskTabId(String(tabId)))
    .filter((id): id is string => Boolean(id))
    .map((id) => imageArtifacts.find((artifact) => artifact.id === id))
    .filter((artifact): artifact is ImageGenerationArtifact => Boolean(artifact));
  const activeImageDisplayArtifactId = parseImageDisplayTaskTabId(String(activeTab));
  const imageDisplaySelected = Boolean(activeImageDisplayArtifactId);
  const activeImageDisplayArtifact = imageDisplayArtifacts.find(
    (artifact) => artifact.id === activeImageDisplayArtifactId,
  );
  const openImageDisplayArtifacts = openTabIds
    .map((tabId) => parseImageDisplayTaskTabId(String(tabId)))
    .filter((id): id is string => Boolean(id))
    .map((id) => imageDisplayArtifacts.find((artifact) => artifact.id === id))
    .filter((artifact): artifact is ImageDisplayArtifact => Boolean(artifact));
  const browserTabIds = openTabIds.filter((tabId) => isBrowserTaskTabId(String(tabId)));
  const openBrowserInstances = resolvedBrowserInstances.filter((instance) =>
    browserTabIds.includes(browserTaskTabId(instance.id)),
  );
  // Also show tabs for openTabIds that mention browser ids even if state lag.
  const browserTabsFromOpenIds = browserTabIds
    .map((tabId) => {
      const id = parseBrowserTaskTabId(String(tabId));
      if (!id) return undefined;
      const known = resolvedBrowserInstances.find((item) => item.id === id);
      return known ?? { id, title: t("browser.newTab"), url: "about:blank" };
    })
    .filter((item): item is TaskPanelBrowserInstance => Boolean(item));
  // An explicit scoped list is authoritative, including [] while switching chats.
  // Restored ids alone must never mount a guest from the previous scope.
  const browserTabs = browserInstances !== undefined || openBrowserInstances.length > 0
    ? openBrowserInstances
    : browserTabsFromOpenIds;
  const filesOpen = openTabIds.includes(TASK_PANEL_FILES_TAB_ID);
  const fileViewerOpen = openTabIds.includes(TASK_PANEL_FILE_VIEWER_TAB_ID);
  const reviewOpen = openTabIds.includes(TASK_PANEL_REVIEW_TAB_ID);
  const planOpen = openTabIds.includes(TASK_PANEL_PLAN_TAB_ID);
  const terminalTasksOpen = openTabIds.includes(TASK_PANEL_BACKGROUND_TERMINAL_TAB_ID);
  const sshBookmarksOpen = openTabIds.includes(TASK_PANEL_SSH_BOOKMARKS_TAB_ID);
  const browserOpen = browserTabs.length > 0;
  const openSubagentCards = useMemo(
    () =>
      openTabIds
        .map((tabId) => cards.find((card) => card.key === tabId))
        .filter((card): card is ThreadRunProjectionSubagentCard => card !== undefined),
    [cards, openTabIds],
  );
  const liveActiveSubagentCard =
    !filesSelected &&
    !fileViewerSelected &&
    !reviewSelected &&
    !planSelected &&
    !terminalTasksSelected &&
    !sshBookmarksSelected &&
    !browserSelected &&
    !newTabSelected &&
    !activeTtsArtifactId &&
    !imageSelected &&
    !imageDisplaySelected
      ? cards.find((card) => card.key === activeTab)
      : undefined;
  const activeSubagentCard = useStableSubagentCard(liveActiveSubagentCard);
  const requestSpansById = useStableSubagentRequestSpansById(
    activeSubagentCard,
    projection?.requestSpans ?? [],
  );

  if (!open) {
    return null;
  }

  return (
    <section
      id="task-panel"
      className={["subagent-task-side-panel", "is-open", fullscreen ? "is-fullscreen" : ""]
        .filter(Boolean)
        .join(" ")}
      aria-label={fullscreen ? t("app.taskPanelFullscreen") : t("app.taskPanel")}
    >
      <header className="subagent-task-panel-topbar">
        <TaskPanelTabOrder openTabIds={openTabIds} label={t("task.tabs")}>
          {newTabIds.map((tabId) => (
            <span
              key={tabId}
              data-task-panel-tab-id={tabId}
              className={`subagent-task-panel-tab-shell${activeTab === tabId ? " is-active" : ""}`}
            >
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === tabId}
                aria-controls={`subagent-task-tab-${tabId}`}
                className={`subagent-task-panel-tab subagent-task-panel-tab--new${activeTab === tabId ? " is-active" : ""}`}
                onClick={() => onSelectNewTab(tabId)}
              >
                <Globe size={15} aria-hidden />
                <span>{t("browser.newTab")}</span>
              </button>
              <button
                type="button"
                className="subagent-task-panel-tab-close"
                aria-label={t("task.closeTab", { label: t("browser.newTab") })}
                title={t("task.closeTabTitle")}
                onClick={() => onCloseTab(tabId)}
              >
                <X size={13} aria-hidden />
              </button>
            </span>
          ))}
          {filesOpen ? (
            <span
              data-task-panel-tab-id={TASK_PANEL_FILES_TAB_ID}
              className={`subagent-task-panel-tab-shell${filesSelected ? " is-active" : ""}`}
            >
              <button
                type="button"
                className={`subagent-task-panel-tab subagent-task-panel-tab--files${
                  filesSelected ? " is-active" : ""
                }`}
                role="tab"
                aria-selected={filesSelected}
                aria-controls="subagent-task-tab-files"
                onClick={onSelectFiles}
              >
                <FolderOpen size={15} aria-hidden />
                <span>{t("task.files")}</span>
              </button>
              <button
                type="button"
                className="subagent-task-panel-tab-close"
                aria-label={t("task.closeTab", { label: t("task.files") })}
                title={t("task.closeTabTitle")}
                onClick={() => onCloseTab(TASK_PANEL_FILES_TAB_ID)}
              >
                <X size={13} aria-hidden />
              </button>
            </span>
          ) : null}
          {fileViewerOpen ? (
            <span
              data-task-panel-tab-id={TASK_PANEL_FILE_VIEWER_TAB_ID}
              className={`subagent-task-panel-tab-shell${fileViewerSelected ? " is-active" : ""}`}
            >
              <button
                type="button"
                className={`subagent-task-panel-tab subagent-task-panel-tab--file-viewer${
                  fileViewerSelected ? " is-active" : ""
                }`}
                role="tab"
                aria-selected={fileViewerSelected}
                aria-controls="subagent-task-tab-file-viewer"
                aria-label={t("fileViewer.tabLabel", {
                  name: fileTarget ? basename(fileTarget.path) : t("fileViewer.title"),
                })}
                title={fileTarget?.path ?? t("fileViewer.title")}
                onClick={onSelectFileViewer}
              >
                <FileText size={15} aria-hidden />
                <span>{fileTarget ? basename(fileTarget.path) : t("fileViewer.title")}</span>
              </button>
              <button
                type="button"
                className="subagent-task-panel-tab-close"
                aria-label={t("task.closeTab", {
                  label: fileTarget ? basename(fileTarget.path) : t("fileViewer.title"),
                })}
                title={t("task.closeTabTitle")}
                onClick={() => onCloseTab(TASK_PANEL_FILE_VIEWER_TAB_ID)}
              >
                <X size={13} aria-hidden />
              </button>
            </span>
          ) : null}
          {reviewOpen ? (
            <span
              data-task-panel-tab-id={TASK_PANEL_REVIEW_TAB_ID}
              className={`subagent-task-panel-tab-shell${reviewSelected ? " is-active" : ""}`}
            >
              <button
                type="button"
                className={`subagent-task-panel-tab subagent-task-panel-tab--review${
                  reviewSelected ? " is-active" : ""
                }`}
                role="tab"
                aria-selected={reviewSelected}
                aria-controls="subagent-task-tab-review"
                onClick={onSelectReview}
              >
                <ListChecks size={15} aria-hidden />
                <span>{t("task.review")}</span>
              </button>
              <button
                type="button"
                className="subagent-task-panel-tab-close"
                aria-label={t("task.closeTab", { label: t("task.review") })}
                title={t("task.closeTabTitle")}
                onClick={() => onCloseTab(TASK_PANEL_REVIEW_TAB_ID)}
              >
                <X size={13} aria-hidden />
              </button>
            </span>
          ) : null}
          {browserTabs.map((instance) => {
            const tabId = browserTaskTabId(instance.id);
            const isActive = activeTab === tabId;
            const isLoading = instance.isLoading === true;
            const label = isBrowserPlaceholderUrl(instance.url)
              ? t("browser.newTab")
              : instance.title?.trim() || instance.url || t("browser.newTab");
            return (
              <span
                key={tabId}
                data-task-panel-tab-id={tabId}
                className={`subagent-task-panel-tab-shell${isActive ? " is-active" : ""}${
                  isLoading ? " is-loading" : ""
                }`}
              >
                <button
                  type="button"
                  className={`subagent-task-panel-tab subagent-task-panel-tab--browser${
                    isActive ? " is-active" : ""
                  }${isLoading ? " is-loading" : ""}`}
                  role="tab"
                  aria-selected={isActive}
                  aria-controls={`subagent-task-tab-browser-${instance.id}`}
                  title={isBrowserPlaceholderUrl(instance.url) ? label : instance.url || label}
                  onClick={() => onSelectBrowser(instance.id)}
                >
                  {isLoading ? (
                    <LoaderCircle size={15} className="subagent-task-panel-tab-spinner" aria-hidden />
                  ) : (
                    <TaskBrowserTabIcon
                      {...(instance.faviconUrl ? { faviconUrl: instance.faviconUrl } : {})}
                      label={label}
                    />
                  )}
                  <span className="subagent-task-panel-tab-label">{label}</span>
                </button>
                <button
                  type="button"
                  className="subagent-task-panel-tab-close"
                  aria-label={t("task.closeTab", { label })}
                  title={t("task.closeTabTitle")}
                  onClick={() => onCloseTab(tabId)}
                >
                  <X size={13} aria-hidden />
                </button>
              </span>
            );
          })}
          {plan && planOpen ? (
            <span
              data-task-panel-tab-id={TASK_PANEL_PLAN_TAB_ID}
              className={`subagent-task-panel-tab-shell${planSelected ? " is-active" : ""}`}
            >
              <button
                type="button"
                className={`subagent-task-panel-tab subagent-task-panel-tab--plan${
                  planSelected ? " is-active" : ""
                }`}
                role="tab"
                aria-selected={planSelected}
                aria-controls="subagent-task-tab-plan"
                onClick={onSelectPlan}
              >
                <FileText size={15} aria-hidden />
                <span>{t("task.plan")}</span>
              </button>
              <button
                type="button"
                className="subagent-task-panel-tab-close"
                aria-label={t("task.closeTab", { label: t("task.plan") })}
                title={t("task.closeTabTitle")}
                onClick={() => onCloseTab(TASK_PANEL_PLAN_TAB_ID)}
              >
                <X size={13} aria-hidden />
              </button>
            </span>
          ) : null}
          {openImageArtifacts.map((artifact) => {
            const tabId = imageGenerationTaskTabId(artifact.id);
            const isActive = activeTab === tabId;
            return (
              <span
                key={tabId}
                data-task-panel-tab-id={tabId}
                className={`subagent-task-panel-tab-shell${isActive ? " is-active" : ""}`}
              >
                <button
                  type="button"
                  className={`subagent-task-panel-tab${isActive ? " is-active" : ""}`}
                  role="tab"
                  aria-selected={isActive}
                  onClick={() => onSelectImageArtifact(artifact.id)}
                >
                  <ImageIcon size={15} aria-hidden />
                  <span className="subagent-task-panel-tab-label">{t("task.image.title")}</span>
                </button>
                <button
                  type="button"
                  className="subagent-task-panel-tab-close"
                  title={t("task.closeTabTitle")}
                  onClick={() => onCloseTab(tabId)}
                >
                  <X size={13} aria-hidden />
                </button>
              </span>
            );
          })}
          {openTtsArtifacts.map((artifact) => {
            const tabId = ttsTaskTabId(artifact.id);
            const isActive = activeTab === tabId;
            return (
              <span
                key={tabId}
                data-task-panel-tab-id={tabId}
                className={`subagent-task-panel-tab-shell${isActive ? " is-active" : ""}`}
              >
                <button
                  type="button"
                  className={`subagent-task-panel-tab${isActive ? " is-active" : ""}`}
                  role="tab"
                  aria-selected={isActive}
                  onClick={() => onSelectTtsArtifact?.(artifact.id)}
                >
                  <ImageIcon size={15} aria-hidden />
                  <span className="subagent-task-panel-tab-label">{t("task.tts.title")}</span>
                </button>
                <button
                  type="button"
                  className="subagent-task-panel-tab-close"
                  title={t("task.closeTabTitle")}
                  onClick={() => onCloseTab(tabId)}
                >
                  <X size={13} aria-hidden />
                </button>
              </span>
            );
          })}
          {openImageDisplayArtifacts.map((artifact) => {
            const tabId = imageDisplayTaskTabId(artifact.id);
            const isActive = activeTab === tabId;
            const label =
              artifact.title?.trim() ||
              artifact.sourceRef?.split(/[\\/]/u).at(-1) ||
              t("task.imageDisplay.title");
            return (
              <span
                key={tabId}
                data-task-panel-tab-id={tabId}
                className={`subagent-task-panel-tab-shell${isActive ? " is-active" : ""}`}
              >
                <button
                  type="button"
                  className={`subagent-task-panel-tab${isActive ? " is-active" : ""}`}
                  role="tab"
                  aria-selected={isActive}
                  title={label}
                  onClick={() => onSelectImageDisplayArtifact(artifact.id)}
                >
                  <ImageIcon size={15} aria-hidden />
                  <span className="subagent-task-panel-tab-label">{t("task.imageDisplay.title")}</span>
                </button>
                <button
                  type="button"
                  className="subagent-task-panel-tab-close"
                  title={t("task.closeTabTitle")}
                  onClick={() => onCloseTab(tabId)}
                >
                  <X size={13} aria-hidden />
                </button>
              </span>
            );
          })}
          {openSubagentCards.map((card) => {
            const roleLabel = subagentRoleLabel(card.agent.role, agentDisplayNames);
            const modelId = card.agent.usage?.modelId ?? card.agent.context?.modelId;
            const modelShort = modelId ? shortenModelId(modelId) : undefined;
            const runningStatusText = card.running
              ? card.statusText?.trim() || t("task.processing")
              : undefined;
            const tabTitle = [roleLabel, modelShort, runningStatusText].filter(Boolean).join(" · ");
            const isActive = activeTab === card.key;
            return (
              <span
                key={card.key}
                data-task-panel-tab-id={card.key}
                className={`subagent-task-panel-tab-shell${isActive ? " is-active" : ""}`}
                style={resolveSubagentRowThemeStyle(card.agent.role, agentThemes)}
              >
                <button
                  type="button"
                  className={`subagent-task-panel-tab subagent-task-panel-tab--subagent${
                    isActive ? " is-active" : ""
                  }${card.running ? " is-running" : ""}`}
                  role="tab"
                  aria-selected={isActive}
                  aria-controls={`subagent-task-tab-${card.key}`}
                  title={tabTitle}
                  onClick={() => onSelectAgent(card.key)}
                >
                  <Bot size={15} aria-hidden />
                  <span className="subagent-task-panel-tab-label">
                    {roleLabel}
                    {modelShort ? (
                      <span className="subagent-task-panel-tab-model"> · {modelShort}</span>
                    ) : null}
                  </span>
                  {runningStatusText ? (
                    <span className="subagent-task-panel-tab-meta">{runningStatusText}</span>
                  ) : null}
                </button>
                <button
                  type="button"
                  className="subagent-task-panel-tab-close"
                  aria-label={t("task.closeTab", { label: roleLabel })}
                  title={t("task.closeTabTitle")}
                  onClick={(event) => {
                    event.stopPropagation();
                    onCloseTab(card.key);
                  }}
                >
                  <X size={13} aria-hidden />
                </button>
              </span>
            );
          })}
          {terminalTasksOpen ? (
            <span
              data-task-panel-tab-id={TASK_PANEL_BACKGROUND_TERMINAL_TAB_ID}
              className={`subagent-task-panel-tab-shell${terminalTasksSelected ? " is-active" : ""}`}
            >
              <button
                type="button"
                className={`subagent-task-panel-tab subagent-task-panel-tab--terminal${
                  terminalTasksSelected ? " is-active" : ""
                }`}
                role="tab"
                aria-selected={terminalTasksSelected}
                aria-controls="subagent-task-tab-background-terminal"
                onClick={onSelectBackgroundTasks}
              >
                <Terminal size={15} aria-hidden />
                <span>{t("task.terminal")}</span>
              </button>
              <button
                type="button"
                className="subagent-task-panel-tab-close"
                aria-label={t("task.closeTab", { label: t("task.terminal") })}
                title={t("task.closeTabTitle")}
                onClick={() => onCloseTab(TASK_PANEL_BACKGROUND_TERMINAL_TAB_ID)}
              >
                <X size={13} aria-hidden />
              </button>
            </span>
          ) : null}
          {sshBookmarksOpen ? (
            <span
              data-task-panel-tab-id={TASK_PANEL_SSH_BOOKMARKS_TAB_ID}
              className={`subagent-task-panel-tab-shell${sshBookmarksSelected ? " is-active" : ""}`}
            >
              <button
                type="button"
                className={`subagent-task-panel-tab subagent-task-panel-tab--ssh${
                  sshBookmarksSelected ? " is-active" : ""
                }`}
                role="tab"
                aria-selected={sshBookmarksSelected}
                aria-controls="subagent-task-tab-ssh-bookmarks"
                onClick={onSelectSshBookmarks}
              >
                <KeyRound size={15} aria-hidden />
                <span>{t("app.sshBookmarks.title")}</span>
              </button>
              <button
                type="button"
                className="subagent-task-panel-tab-close"
                aria-label={t("task.closeTab", { label: t("app.sshBookmarks.title") })}
                title={t("task.closeTabTitle")}
                onClick={() => onCloseTab(TASK_PANEL_SSH_BOOKMARKS_TAB_ID)}
              >
                <X size={13} aria-hidden />
              </button>
            </span>
          ) : null}
          <button
            type="button"
            className="subagent-task-panel-tab-add"
            aria-label={t("browser.newTab")}
            title={t("browser.newTab")}
            onClick={onNewBrowserTab}
          >
            <Plus size={17} aria-hidden />
          </button>
        </TaskPanelTabOrder>
      </header>

      <div className="subagent-task-panel-body">
        {newTabIds.map((tabId) => (
          <div
            key={tabId}
            id={`subagent-task-tab-${tabId}`}
            className={`subagent-task-panel-tab-pane subagent-task-panel-tab-pane--new ${activeTab === tabId ? "is-active" : "is-inactive"}`}
            role="tabpanel"
            hidden={activeTab !== tabId}
          >
            <TaskPanelNewTab tabId={tabId} onOpenTool={onOpenHomeTool} onNavigate={onNavigateNewTab} />
          </div>
        ))}
        {filesSelected ? (
          <div id="subagent-task-tab-files" className="subagent-task-panel-tab-pane" role="tabpanel">
            <WorkspaceFileBrowser workspacePath={workspacePath} {...(threadId ? { threadId } : {})} />
          </div>
        ) : null}
        {fileViewerSelected ? (
          <div
            id="subagent-task-tab-file-viewer"
            className="subagent-task-panel-tab-pane subagent-task-panel-tab-pane--file-viewer"
            role="tabpanel"
          >
            <WorkspaceFileViewer
              workspacePath={workspacePath}
              {...(threadId ? { threadId } : {})}
              {...(fileTarget ? { target: fileTarget } : {})}
              onViewedFileChange={onViewedFileChange}
            />
          </div>
        ) : null}
        {reviewSelected ? (
          <div
            id="subagent-task-tab-review"
            className="subagent-task-panel-tab-pane subagent-task-panel-tab-pane--review"
            role="tabpanel"
          >
            <WorkspaceDiffPanel
              loading={(reviewLoading ?? false) && !reviewDiff}
              refreshing={reviewLoading ?? false}
              {...(reviewError && { error: reviewError })}
              {...(reviewDiff && { diff: reviewDiff })}
              {...(reviewSelectedPath && { selectedPath: reviewSelectedPath })}
              loadFileDiff={loadFileDiff}
              revision={reviewRevision ?? 0}
              onSelectPath={onSelectReviewPath}
              {...(onRefreshReview && { onRefresh: onRefreshReview })}
            />
          </div>
        ) : null}
        {browserTabs.map((instance) => {
          const tabId = browserTaskTabId(instance.id);
          const isActive = activeTab === tabId;
          return (
            <div
              key={tabId}
              id={`subagent-task-tab-browser-${instance.id}`}
              className={[
                "subagent-task-panel-tab-pane",
                "subagent-task-panel-tab-pane--browser",
                isActive ? "is-active" : "is-inactive",
              ].join(" ")}
              role="tabpanel"
              hidden={!isActive}
            >
              <BrowserPanel
                active={isActive && surfaceActive}
                browserId={instance.id}
                onOpenTool={(browserId, tool) => onOpenHomeTool(browserTaskTabId(browserId), tool)}
              />
            </div>
          );
        })}
        {planSelected && plan ? (
          <div id="subagent-task-tab-plan" className="subagent-task-panel-tab-pane" role="tabpanel">
            <PlanDetailPanel plan={plan} />
          </div>
        ) : null}
        {activeTtsArtifact ? (
          <div className="subagent-task-panel-tab-pane" role="tabpanel">
            <TtsArtifactPlayer key={activeTtsArtifact.id} artifact={activeTtsArtifact} />
          </div>
        ) : null}
        {imageSelected && activeImageArtifact ? (
          <div
            className="subagent-task-panel-tab-pane subagent-task-panel-tab-pane--image-artifact"
            role="tabpanel"
          >
            <ImageGenerationArtifactDetail artifact={activeImageArtifact} />
          </div>
        ) : null}
        {imageDisplaySelected && activeImageDisplayArtifact ? (
          <div
            className="subagent-task-panel-tab-pane subagent-task-panel-tab-pane--image-artifact"
            role="tabpanel"
          >
            <ImageDisplayArtifactDetail artifact={activeImageDisplayArtifact} />
          </div>
        ) : null}
        {activeSubagentCard ? (
          <div
            id={`subagent-task-tab-${activeSubagentCard.key}`}
            className="subagent-task-panel-tab-pane"
            role="tabpanel"
          >
            <div className="subagent-task-detail">
              <SubagentProjectionDetail
                card={activeSubagentCard}
                {...(projection && { projection })}
                requestSpansById={requestSpansById}
                threadActive={isThreadActive(threadStatus ?? projection?.thread.status)}
                v2Only={v2Only}
              />
            </div>
          </div>
        ) : null}
        {terminalTasksSelected ? (
          <div
            id="subagent-task-tab-background-terminal"
            className="subagent-task-panel-tab-pane"
            role="tabpanel"
          >
            <BackgroundTerminalTasksPanel
              tasks={backgroundTasks}
              onOpenTask={onOpenTerminalTask}
              onStopTask={onStopTerminalTask}
            />
          </div>
        ) : null}
        {sshBookmarksSelected ? (
          <div id="subagent-task-tab-ssh-bookmarks" className="subagent-task-panel-tab-pane" role="tabpanel">
            <SshBookmarksPanel
              workspacePath={workspacePath}
              bookmarks={[...sshBookmarks]}
              {...(centerServerSyncVisible !== undefined ? { centerServerSyncVisible } : {})}
              {...(onSyncDomain ? { onSyncDomain } : {})}
              onBookmarksChange={onSshBookmarksChange}
              onConnect={onConnectSshBookmark}
            />
          </div>
        ) : null}
      </div>
    </section>
  );
}
