import type { TtsArtifact } from "../shared/tts";
import { TtsArtifactPlayer } from "./TtsArtifactPlayer";
import {
  Blocks,
  Bot,
  Check,
  ChevronDown,
  Clock3,
  Copy,
  GitBranch,
  GitGraph,
  Globe,
  Image as ImageIcon,
  Lightbulb,
  ListTodo,
  Sparkles,
  Unplug,
  Users,
  X,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { countEnabledMcpServers } from "../shared/composer-mcp";
import type { SkillsEnabledSettings } from "../shared/composer-skills-settings";
import type {
  IntegrationAvailabilitySnapshot,
  IntegrationId,
  IntegrationsEnabledSettings,
} from "../shared/integrations";
import type { HtmlHostArtifact } from "../shared/html-host";
import type {
  CoderTodoItem,
  CursorAgentInfo,
  CursorBuiltinSubagentType,
  GitSettingsSnapshot,
  GitWorkingTreeStatus,
  ImageGenerationArtifact,
  ImageDisplayArtifact,
  McpServerConfigView,
  SubagentEnabledSettings,
  SubagentRole,
  ThreadBillingSnapshot,
  ThreadUsageLedgerEventView,
  ThreadContextSnapshot,
  ThreadPendingPlan,
  ThreadRuntimeConfig,
  ThreadStatus,
  WorkspaceInfo,
} from "../shared/ipc";
import type { SkillInfo } from "../shared/skills";
import { formatSubagentTaskNameLabel } from "../shared/subagent-task-name";
import type { McpServersEnabledSettings } from "../shared/thread-runtime-config";
import { webChatHostname } from "../shared/web-chat-list";
import { resolveSubagentRunDisplayTitle } from "./activity-log";
import { useBrowserTaskInstances } from "./browser-state-store";
import { copyTextToClipboard } from "./clipboard";
import { CoderTodoPanel } from "./CoderTodoPanel";
import { ComposerAgentModelsCardBody } from "./ComposerAgentModels";
import { ComposerIntegrationsCardBody } from "./ComposerIntegrations";
import { ComposerMcpCardBody } from "./ComposerMcpServers";
import { ComposerSkillsCardBody } from "./ComposerSkillsControl";
import { CursorAgentsRosterCardBody } from "./CursorAgentsRosterCardBody";
import type { ComposerAgentModelLabel } from "./composer-agent-model-labels";
import { type RuntimeAgentDisplayNames, resolveRuntimeAgentName } from "./runtime-agent-display";
import { type RuntimeAgentThemes, resolveSubagentRowThemeStyle } from "./runtime-agent-theme";
import type { ThreadRunProjectionSubagentCard } from "./conversation-v2-projection-view";
import { WorkspaceGitCommitGraph } from "./WorkspaceGitCommitGraph";
import { WorkspaceGitSection } from "./WorkspaceGitSection";
import { persistCardExpanded, readCardExpanded } from "./workspace-floating-card-storage";
import { resolveWorkspacePlanTitle } from "./workspace-plan-title";
import type { ScheduleDefinition, ScheduleOccurrence } from "../shared/scheduling";
import { ScheduledMessagesCardBody } from "./ScheduledMessagesCardBody";

export interface ThreadUsageSummary {
  billing?: ThreadBillingSnapshot;
  ledgerEvents?: ThreadUsageLedgerEventView[];
  context?: ThreadContextSnapshot;
  contextTokens?: number;
}

export interface WorkspaceFloatingCardsProps {
  workspace?: WorkspaceInfo;
  workspacePath?: string;
  workspaceLabel?: string;
  gitStatus?: GitWorkingTreeStatus;
  gitBusy?: boolean;
  commitDisabled?: boolean;
  mainAgentConfigId?: string;
  defaultCommitCandidateModelId?: string;
  gitSettings?: GitSettingsSnapshot;
  onCheckoutGitBranch?: (branch: string) => void | Promise<void>;
  onCreateGitBranch?: (branch: string) => void | Promise<void>;
  onOpenGitSettings?: () => void;
  onSaveCommitModelPreference?: (candidateModelId: string) => void | Promise<void>;
  onCommitSuccess?: () => void | Promise<void>;
  onPushSuccess?: () => void | Promise<void>;
  onOpenChangesReview?: () => void;
  onChangesDiffLoaded?: (diff: import("../shared/ipc").WorkspaceDiffResult) => void | Promise<void>;
  onChangesDiffLoadingChange?: (loading: boolean) => void;
  onChangesDiffError?: (error?: string) => void;
  onPullSuccess?: () => void | Promise<void>;
  onPullError?: (message: string) => void;
  onResolveConflictsWithAgent?: (conflictFiles: string[]) => void | Promise<void>;
  onRefreshGitStatus?: (force?: boolean) => void | Promise<void>;
  scriptsDisabled?: boolean;
  onOpenScriptsDialog?: () => void;
  onCommitDialogOpenChange?: (open: boolean) => void;
  todos?: CoderTodoItem[];
  threadStatus?: ThreadStatus;
  hasActiveThread?: boolean;
  scheduledMessages?: readonly ScheduleDefinition[];
  scheduleOccurrences?: readonly ScheduleOccurrence[];
  schedulingError?: string;
  scheduledMessagesRevealKey?: string;
  onEditScheduledMessage?: (message: ScheduleDefinition) => void;
  onRefreshSchedules?: () => Promise<void>;
  onScheduledMessageActionError?: (message: string) => void;
  agentModelLabels?: ComposerAgentModelLabel[];
  /** ACP Cursor: read-only roster from `.cursor/agents` (no toggles). */
  cursorAgentsRoster?: {
    agents: readonly CursorAgentInfo[];
    builtins: readonly CursorBuiltinSubagentType[];
  };
  composerRuntimeConfig?: ThreadRuntimeConfig;
  subagentEnabled?: SubagentEnabledSettings;
  canEditComposerConfig?: boolean;
  isSavingSettings?: boolean;
  mcpServers?: readonly McpServerConfigView[];
  composerMcpSettings?: McpServersEnabledSettings;
  integrationAvailability?: IntegrationAvailabilitySnapshot;
  composerIntegrationSettings?: IntegrationsEnabledSettings;
  skills?: readonly SkillInfo[];
  composerSkillsEnabled?: SkillsEnabledSettings;
  onToggleComposerSubagent?: (role: SubagentRole, enabled: boolean) => void | Promise<void>;
  onToggleComposerMcpServer?: (serverKey: string, enabled: boolean) => void | Promise<void>;
  onToggleComposerIntegration?: (id: IntegrationId, enabled: boolean) => void | Promise<void>;
  onToggleComposerSkill?: (settingsKey: string, enabled: boolean) => void | Promise<void>;
  approvedPlan?: ThreadPendingPlan;
  onOpenPlan?: () => void;
  browserInstances?: readonly WorkspaceBrowserInstance[];
  onOpenBrowser?: (browserId: string) => void;
  onCloseBrowser?: (browserId: string) => void;
  onCloseAllBrowsers?: () => void;
  ttsArtifacts?: readonly TtsArtifact[];
  onOpenTtsArtifact?: (id: string) => void;
  imageArtifacts?: readonly ImageGenerationArtifact[];
  onOpenImageArtifact?: (artifactId: string) => void;
  imageDisplayArtifacts?: readonly ImageDisplayArtifact[];
  onOpenImageDisplayArtifact?: (artifactId: string) => void;
  htmlHostArtifacts?: readonly HtmlHostArtifact[];
  onOpenHtmlHostArtifact?: (artifactId: string) => void;
  subagentRunCards?: readonly ThreadRunProjectionSubagentCard[];
  selectedSubagentAgentId?: string;
  agentDisplayNames?: RuntimeAgentDisplayNames;
  agentThemes?: RuntimeAgentThemes;
  onOpenSubagent?: (agentId: string) => void;
}

/** Open built-in browser surfaces listed in the workspace cards panel. */
export interface WorkspaceBrowserInstance {
  id: string;
  title: string;
  url: string;
  faviconUrl?: string;
}

function BrowserFavicon({ faviconUrl, title }: { faviconUrl?: string; title: string }) {
  const [failed, setFailed] = useState(false);
  if (!faviconUrl || failed) {
    return <Globe size={16} strokeWidth={1.75} />;
  }
  return (
    <img
      className="workspace-resource-row-favicon"
      src={faviconUrl}
      alt=""
      title={title}
      draggable={false}
      onError={() => setFailed(true)}
    />
  );
}

function hasProgressInfo(todos: CoderTodoItem[]): boolean {
  return todos.some(
    (todo) => todo.status === "pending" || todo.status === "running" || todo.status === "blocked",
  );
}

function countRunningTodos(todos: CoderTodoItem[]): number {
  return todos.filter((todo) => todo.status === "running").length;
}

function subagentRoleLabel(role: string, displayNames?: RuntimeAgentDisplayNames): string {
  return resolveRuntimeAgentName(role, displayNames) ?? resolveSubagentRunDisplayTitle(role);
}

function WorkspacePanelSection({
  id,
  title,
  summary,
  children,
  defaultExpanded = true,
  persistExpanded = true,
  maxBodyHeight = 360,
  onExpandedChange,
}: {
  id: string;
  title: string;
  summary?: ReactNode;
  children: ReactNode;
  defaultExpanded?: boolean;
  persistExpanded?: boolean;
  maxBodyHeight?: number;
  onExpandedChange?: (expanded: boolean) => void;
}) {
  const [expanded, setExpanded] = useState(() =>
    persistExpanded ? readCardExpanded(id, defaultExpanded) : defaultExpanded,
  );
  const bodyId = `${id}-body`;

  function toggleExpanded() {
    setExpanded((current) => {
      const next = !current;
      if (persistExpanded) {
        persistCardExpanded(id, next);
      }
      onExpandedChange?.(next);
      return next;
    });
  }

  return (
    <section className={`workspace-panel-section${expanded ? " is-expanded" : " is-collapsed"}`}>
      <div className="workspace-panel-section-header">
        <button
          type="button"
          className="workspace-panel-section-toggle"
          onClick={toggleExpanded}
          aria-expanded={expanded}
          aria-controls={bodyId}
        >
          <span className="workspace-panel-section-title">{title}</span>
        </button>
        {summary ? <span className="workspace-panel-section-summary">{summary}</span> : null}
        <button
          type="button"
          className="workspace-panel-section-chevron-btn"
          onClick={toggleExpanded}
          aria-hidden="true"
          tabIndex={-1}
        >
          <ChevronDown size={14} className="workspace-panel-section-chevron" aria-hidden />
        </button>
      </div>
      {expanded ? (
        <div
          id={bodyId}
          className="workspace-panel-section-body floating-workspace-card-body"
          style={maxBodyHeight > 0 ? { maxHeight: maxBodyHeight } : undefined}
        >
          {children}
        </div>
      ) : null}
    </section>
  );
}

/** Sections with more than two items start collapsed to keep the workspace panel scannable. */
export function defaultConfigSectionExpanded(itemCount: number): boolean {
  return itemCount <= 2;
}

function SubagentRunsCardBody({
  cards,
  selectedAgentId,
  agentDisplayNames,
  agentThemes,
  onOpenSubagent,
}: {
  cards: readonly ThreadRunProjectionSubagentCard[];
  selectedAgentId?: string;
  agentDisplayNames?: RuntimeAgentDisplayNames;
  agentThemes?: RuntimeAgentThemes;
  onOpenSubagent?: (agentId: string) => void;
}) {
  return (
    <div className="workspace-subagent-runs-list">
      {cards.map((card) => {
        const roleLabel = subagentRoleLabel(card.agent.role, agentDisplayNames);
        const titleLabel = card.agent.nickname?.trim() || roleLabel;
        const taskLabel = card.agent.taskName ? formatSubagentTaskNameLabel(card.agent.taskName) : "";
        const openable = card.openable !== false;
        const className = `workspace-subagent-run-item${selectedAgentId === card.key ? " is-active" : ""}${openable ? "" : " is-status-only"}`;
        const content = (
          <>
            <span className="workspace-subagent-run-avatar" aria-hidden>
              <Bot size={14} strokeWidth={1.75} />
            </span>
            <span className="workspace-subagent-run-main">
              <span className="workspace-subagent-run-name">{titleLabel}</span>
              {taskLabel ? <span className="workspace-subagent-run-mission">{taskLabel}</span> : null}
            </span>
            {card.running ? <span className="workspace-subagent-run-live" aria-hidden /> : null}
          </>
        );
        if (!openable) {
          return (
            <div
              key={card.key}
              className={className}
              style={resolveSubagentRowThemeStyle(card.agent.role, agentThemes)}
              aria-disabled="true"
              title={taskLabel || titleLabel}
            >
              {content}
            </div>
          );
        }
        return (
          <button
            key={card.key}
            type="button"
            className={className}
            style={resolveSubagentRowThemeStyle(card.agent.role, agentThemes)}
            onClick={() => onOpenSubagent?.(card.key)}
            aria-pressed={selectedAgentId === card.key}
            title={taskLabel || titleLabel}
          >
            {content}
          </button>
        );
      })}
    </div>
  );
}

function PlanWorkspaceCardBody({ plan, onOpenPlan }: { plan: ThreadPendingPlan; onOpenPlan?: () => void }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const title = resolveWorkspacePlanTitle({
    plan: plan.plan,
    userPrompt: plan.userPrompt,
    fallback: t("workspaceCards.approvedPlan"),
  });
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

  const copyLabel = copied ? t("workspaceCards.planCopied") : t("workspaceCards.copyPlan");

  return (
    <div className="workspace-resource-row workspace-plan-card-trigger">
      <button
        type="button"
        className="workspace-plan-card-open"
        onClick={onOpenPlan}
        disabled={!onOpenPlan}
        title={t("workspaceCards.openFullPlan")}
      >
        <span className="workspace-resource-row-icon" aria-hidden>
          <Lightbulb size={16} strokeWidth={1.75} />
        </span>
        <span className="workspace-resource-row-title">{title}</span>
      </button>
      <button
        type="button"
        className={`workspace-plan-card-copy${copied ? " is-copied" : ""}`}
        onClick={copyPlan}
        disabled={!planText}
        title={copyLabel}
        aria-label={copyLabel}
      >
        {copied ? (
          <Check size={14} strokeWidth={2} aria-hidden />
        ) : (
          <Copy size={14} strokeWidth={1.75} aria-hidden />
        )}
      </button>
    </div>
  );
}

function BrowserWorkspaceCardBody({
  instances,
  onOpenBrowser,
  onCloseBrowser,
}: {
  instances: readonly WorkspaceBrowserInstance[];
  onOpenBrowser?: (browserId: string) => void;
  onCloseBrowser?: (browserId: string) => void;
}) {
  const { t } = useTranslation();

  return (
    <>
      <div className="workspace-resource-list">
        {instances.map((instance) => {
          const host = webChatHostname(instance.url);
          const title =
            instance.title.trim() &&
            instance.title.trim() !== "about:blank" &&
            instance.url.trim() !== "about:blank"
              ? instance.title.trim()
              : host || t("browser.title");
          const showHost = Boolean(host) && host !== title && instance.url.trim() !== "about:blank";
          const rowTitle = showHost ? `${title} · ${host}` : title;
          return (
            <div
              key={instance.id}
              className="workspace-resource-row workspace-browser-card-trigger"
              title={rowTitle}
            >
              <button
                type="button"
                className="workspace-browser-card-open"
                onClick={() => onOpenBrowser?.(instance.id)}
                disabled={!onOpenBrowser}
                title={rowTitle}
              >
                <span className="workspace-resource-row-icon" aria-hidden>
                  <BrowserFavicon
                    {...(instance.faviconUrl ? { faviconUrl: instance.faviconUrl } : {})}
                    title={title}
                  />
                </span>
                <span className="workspace-resource-row-title">{title}</span>
                {showHost ? <span className="workspace-resource-row-meta">{host}</span> : null}
              </button>
              {onCloseBrowser ? (
                <button
                  type="button"
                  className="workspace-browser-card-close"
                  onClick={(event) => {
                    event.stopPropagation();
                    onCloseBrowser(instance.id);
                  }}
                  title={t("workspaceCards.closeBrowser")}
                  aria-label={t("workspaceCards.closeBrowser")}
                >
                  <X size={14} strokeWidth={2} aria-hidden />
                </button>
              ) : null}
            </div>
          );
        })}
      </div>
    </>
  );
}

function ImageGenerationWorkspaceCardBody({
  artifacts,
  onOpenImageArtifact,
}: {
  artifacts: readonly ImageGenerationArtifact[];
  onOpenImageArtifact?: (artifactId: string) => void;
}) {
  const { t } = useTranslation();

  return (
    <div className="workspace-resource-list workspace-image-artifact-list">
      {artifacts.map((artifact) => {
        const prompt = artifact.prompt.trim() || t("task.image.title");
        const status = t(`task.image.status.${artifact.status}`);
        const meta = [status, artifact.model].filter(Boolean).join(" · ");
        return (
          <button
            key={artifact.id}
            type="button"
            className="workspace-resource-row workspace-image-artifact-trigger"
            onClick={() => onOpenImageArtifact?.(artifact.id)}
            disabled={!onOpenImageArtifact}
            title={prompt}
          >
            <span className="workspace-resource-row-icon" aria-hidden>
              <ImageIcon size={16} strokeWidth={1.75} />
            </span>
            <span className="workspace-resource-row-title">{prompt}</span>
            <span className="workspace-resource-row-meta">{meta}</span>
          </button>
        );
      })}
    </div>
  );
}

function ImageDisplayWorkspaceCardBody({
  artifacts,
  onOpenImageDisplayArtifact,
}: {
  artifacts: readonly ImageDisplayArtifact[];
  onOpenImageDisplayArtifact?: (artifactId: string) => void;
}) {
  const { t } = useTranslation();

  return (
    <div className="workspace-resource-list workspace-image-artifact-list">
      {artifacts.map((artifact) => {
        const title =
          artifact.title?.trim() ||
          artifact.sourceRef?.split(/[\\/]/u).at(-1) ||
          t("task.imageDisplay.emptyTitle");
        const status = t(`task.imageDisplay.status.${artifact.status}`);
        const source = t(`task.imageDisplay.source.${artifact.sourceKind}`);
        const meta = [status, source].filter(Boolean).join(" · ");
        return (
          <button
            key={artifact.id}
            type="button"
            className="workspace-resource-row workspace-image-artifact-trigger"
            onClick={() => onOpenImageDisplayArtifact?.(artifact.id)}
            disabled={!onOpenImageDisplayArtifact}
            title={title}
          >
            <span className="workspace-resource-row-icon" aria-hidden>
              <ImageIcon size={16} strokeWidth={1.75} />
            </span>
            <span className="workspace-resource-row-title">{title}</span>
            <span className="workspace-resource-row-meta">{meta}</span>
          </button>
        );
      })}
    </div>
  );
}

function HtmlHostWorkspaceCardBody({
  artifacts,
  onOpenHtmlHostArtifact,
}: {
  artifacts: readonly HtmlHostArtifact[];
  onOpenHtmlHostArtifact?: (artifactId: string) => void;
}) {
  const { t } = useTranslation();

  return (
    <div className="workspace-resource-list workspace-image-artifact-list">
      {artifacts.map((artifact) => {
        const title = artifact.title?.trim() || t("task.htmlHost.emptyTitle");
        const status = t(`task.htmlHost.status.${artifact.status}`);
        const expires = artifact.expiresAt
          ? t("task.htmlHost.expiresAt", {
              time: artifact.expiresAt.replace("T", " ").slice(0, 19),
            })
          : undefined;
        const meta = [status, expires].filter(Boolean).join(" · ");
        return (
          <button
            key={artifact.id}
            type="button"
            className="workspace-resource-row workspace-image-artifact-trigger"
            onClick={() => onOpenHtmlHostArtifact?.(artifact.id)}
            disabled={!onOpenHtmlHostArtifact || artifact.status !== "completed"}
            title={title}
          >
            <span className="workspace-resource-row-icon workspace-html-host-row-icon" aria-hidden>
              <img
                className="workspace-html-host-row-logo"
                src="./splash-icon.png"
                alt=""
                width={16}
                height={16}
                draggable={false}
              />
            </span>
            <span className="workspace-resource-row-title">{title}</span>
            <span className="workspace-resource-row-meta">{meta}</span>
          </button>
        );
      })}
    </div>
  );
}

export function WorkspaceFloatingCards({
  workspace,
  workspacePath,
  workspaceLabel,
  gitStatus,
  gitBusy,
  commitDisabled,
  mainAgentConfigId,
  defaultCommitCandidateModelId,
  gitSettings,
  onCheckoutGitBranch,
  onCreateGitBranch,
  onOpenGitSettings,
  onSaveCommitModelPreference,
  onCommitSuccess,
  onPushSuccess,
  onOpenChangesReview,
  onChangesDiffLoaded,
  onChangesDiffLoadingChange,
  onChangesDiffError,
  onPullSuccess,
  onPullError,
  onResolveConflictsWithAgent,
  onRefreshGitStatus,
  scriptsDisabled,
  onOpenScriptsDialog,
  onCommitDialogOpenChange,
  todos = [],
  hasActiveThread = false,
  scheduledMessages = [],
  scheduleOccurrences = [],
  schedulingError,
  scheduledMessagesRevealKey,
  onEditScheduledMessage,
  onRefreshSchedules,
  onScheduledMessageActionError,
  agentModelLabels = [],
  cursorAgentsRoster,
  composerRuntimeConfig,
  subagentEnabled,
  canEditComposerConfig,
  isSavingSettings,
  mcpServers = [],
  composerMcpSettings,
  integrationAvailability,
  composerIntegrationSettings,
  skills = [],
  composerSkillsEnabled,
  onToggleComposerSubagent,
  onToggleComposerMcpServer,
  onToggleComposerIntegration,
  onToggleComposerSkill,
  approvedPlan,
  onOpenPlan,
  browserInstances = [],
  onOpenBrowser,
  onCloseBrowser,
  onCloseAllBrowsers,
  ttsArtifacts = [],
  onOpenTtsArtifact,
  imageArtifacts = [],
  onOpenImageArtifact,
  imageDisplayArtifacts = [],
  onOpenImageDisplayArtifact,
  htmlHostArtifacts = [],
  onOpenHtmlHostArtifact,
  subagentRunCards = [],
  selectedSubagentAgentId,
  agentDisplayNames,
  agentThemes,
  onOpenSubagent,
}: WorkspaceFloatingCardsProps) {
  const { t } = useTranslation();
  const storedBrowserInstances = useBrowserTaskInstances();
  const resolvedBrowserInstances = browserInstances.length > 0 ? browserInstances : storedBrowserInstances;
  const projectLabel =
    workspaceLabel?.trim() ||
    workspacePath?.split("/").filter(Boolean).pop() ||
    workspace?.name ||
    t("workspaceCards.noProject");
  const showProgress = hasProgressInfo(todos);
  const [commitsRefreshKey, setCommitsRefreshKey] = useState(0);
  const showCommitGraph = Boolean(workspacePath && gitStatus?.isGitRepository && gitStatus.hasGitCommits);
  const branchLabel = gitStatus?.branch ?? "—";
  const insertions = gitStatus?.insertions ?? 0;
  const deletions = gitStatus?.deletions ?? 0;
  const enabledMcpCount = composerMcpSettings ? countEnabledMcpServers(composerMcpSettings) : 0;
  const enabledMcpServers = mcpServers.filter((server) => server.enabled && server.name.trim());
  const integrationItems = integrationAvailability?.integrations ?? [];
  const enabledIntegrationsCount = composerIntegrationSettings
    ? integrationItems.filter((item) => composerIntegrationSettings[item.id] === true).length
    : 0;
  const enabledSkillsCount = skills.filter(
    (skill) => composerSkillsEnabled?.[skill.settingsKey ?? skill.skillFilePath],
  ).length;
  const subagentLabels = agentModelLabels.filter((label) => !label.main);
  const cursorAgentsCount =
    (cursorAgentsRoster?.agents.length ?? 0) + (cursorAgentsRoster?.builtins.length ?? 0);
  const showCursorAgentsRoster = Boolean(hasActiveThread && cursorAgentsRoster && cursorAgentsCount > 0);
  const subagentSettings = composerRuntimeConfig?.subagentEnabled ?? subagentEnabled;
  const composerConfigEditableInWorkspace = Boolean(canEditComposerConfig);
  const enabledSubagents = subagentLabels.filter(
    ({ subagentRole }) => !subagentRole || !subagentSettings || subagentSettings[subagentRole],
  ).length;

  async function handleCommitSuccess() {
    setCommitsRefreshKey((current) => current + 1);
    await onCommitSuccess?.();
  }

  async function handlePullSuccess() {
    setCommitsRefreshKey((current) => current + 1);
    await onPullSuccess?.();
  }

  return (
    <section
      className="workspace-floating-cards"
      aria-label={t("workspaceCards.workspacePanels", { project: projectLabel })}
    >
      <div className="workspace-floating-cards-sections">
        <WorkspacePanelSection
          id="workspace-env"
          title={t("workspaceCards.environment")}
          defaultExpanded
          summary={
            <>
              <GitBranch size={14} aria-hidden />
              <span>{branchLabel}</span>
              <span className="floating-workspace-card-bubble-stats">
                <span className="git-commit-stat-add">+{insertions}</span>
                <span className="git-commit-stat-del">-{deletions}</span>
              </span>
            </>
          }
          onExpandedChange={() => void onRefreshGitStatus?.(false)}
        >
          <WorkspaceGitSection
            {...(workspacePath && { workspacePath })}
            workspaceLabel={projectLabel}
            {...(gitStatus && { gitStatus })}
            gitBusy={gitBusy ?? false}
            commitDisabled={commitDisabled ?? false}
            {...(mainAgentConfigId && { mainAgentConfigId })}
            {...(defaultCommitCandidateModelId && { defaultCommitCandidateModelId })}
            {...(gitSettings && { gitSettings })}
            {...(onCheckoutGitBranch && { onCheckoutGitBranch })}
            {...(onCreateGitBranch && { onCreateGitBranch })}
            {...(onOpenGitSettings && { onOpenGitSettings })}
            {...(onSaveCommitModelPreference && { onSaveCommitModelPreference })}
            onCommitSuccess={() => void handleCommitSuccess()}
            {...(onPushSuccess && { onPushSuccess })}
            {...(onOpenChangesReview && { onOpenChangesReview })}
            {...(onChangesDiffLoaded && { onChangesDiffLoaded })}
            {...(onChangesDiffLoadingChange && { onChangesDiffLoadingChange })}
            {...(onChangesDiffError && { onChangesDiffError })}
            onPullSuccess={() => void handlePullSuccess()}
            {...(onPullError && { onPullError })}
            {...(onResolveConflictsWithAgent && { onResolveConflictsWithAgent })}
            {...(onRefreshGitStatus && { onRefreshGitStatus })}
            {...(scriptsDisabled !== undefined && { scriptsDisabled })}
            {...(onOpenScriptsDialog && { onOpenScriptsDialog })}
            {...(onCommitDialogOpenChange && { onCommitDialogOpenChange })}
          />
        </WorkspacePanelSection>

        {hasActiveThread && (scheduledMessages.length > 0 || schedulingError) ? (
          <WorkspacePanelSection
            key={scheduledMessagesRevealKey}
            id="workspace-scheduled-messages"
            title={t("scheduling.session_message")}
            defaultExpanded
            persistExpanded={false}
            summary={
              <>
                <Clock3 size={14} aria-hidden />
                <span>{scheduledMessages.length}</span>
              </>
            }
            maxBodyHeight={360}
          >
            {schedulingError && (
              <p className="workspace-scheduled-message-error" role="alert">
                {schedulingError}
              </p>
            )}
            <ScheduledMessagesCardBody
              messages={scheduledMessages}
              occurrences={scheduleOccurrences}
              onEdit={onEditScheduledMessage}
              onRefresh={onRefreshSchedules}
              onError={onScheduledMessageActionError}
            />
          </WorkspacePanelSection>
        ) : null}

        {hasActiveThread && subagentRunCards.length > 0 ? (
          <WorkspacePanelSection
            id="workspace-subagent-runs"
            title={t("workspaceCards.subagents")}
            defaultExpanded
            summary={
              <>
                <Bot size={14} aria-hidden />
                <span>{subagentRunCards.length}</span>
              </>
            }
            maxBodyHeight={260}
          >
            <SubagentRunsCardBody
              cards={subagentRunCards}
              {...(selectedSubagentAgentId && { selectedAgentId: selectedSubagentAgentId })}
              {...(agentDisplayNames && { agentDisplayNames })}
              {...(agentThemes && { agentThemes })}
              {...(onOpenSubagent && { onOpenSubagent })}
            />
          </WorkspacePanelSection>
        ) : null}

        {approvedPlan ? (
          <WorkspacePanelSection
            id="workspace-approved-plan"
            title={t("workspaceCards.plan")}
            defaultExpanded
            maxBodyHeight={120}
          >
            <PlanWorkspaceCardBody plan={approvedPlan} {...(onOpenPlan && { onOpenPlan })} />
          </WorkspacePanelSection>
        ) : null}

        {resolvedBrowserInstances.length > 0 ? (
          <WorkspacePanelSection
            id="workspace-browser-tabs"
            title={t("workspaceCards.browser")}
            defaultExpanded
            summary={
              <>
                <Globe size={14} aria-hidden />
                <span>{resolvedBrowserInstances.length}</span>
                {onCloseAllBrowsers ? (
                  <button
                    type="button"
                    className="workspace-browser-card-close-all"
                    onClick={() => onCloseAllBrowsers()}
                    title={t("workspaceCards.closeAllBrowsers")}
                    aria-label={t("workspaceCards.closeAllBrowsers")}
                  >
                    <X size={13} strokeWidth={2} aria-hidden />
                  </button>
                ) : null}
              </>
            }
            maxBodyHeight={220}
          >
            <BrowserWorkspaceCardBody
              instances={resolvedBrowserInstances}
              {...(onOpenBrowser && { onOpenBrowser })}
              {...(onCloseBrowser && { onCloseBrowser })}
            />
          </WorkspacePanelSection>
        ) : null}

        {showProgress ? (
          <WorkspacePanelSection
            id="workspace-progress"
            title={t("workspaceCards.progress")}
            defaultExpanded
            summary={
              <>
                <ListTodo size={14} aria-hidden />
                <span>{t("workspaceCards.runningTodos", { count: countRunningTodos(todos) })}</span>
              </>
            }
            maxBodyHeight={280}
          >
            <CoderTodoPanel todos={todos} embedded compact />
          </WorkspacePanelSection>
        ) : null}

        {ttsArtifacts.length > 0 ? (
          <WorkspacePanelSection id="workspace-tts-artifacts" title={t("task.tts.history")} defaultExpanded maxBodyHeight={360}>
            <div className="workspace-resource-list">
              {ttsArtifacts.map(artifact => <TtsArtifactPlayer key={artifact.id} artifact={artifact} {...(onOpenTtsArtifact ? { onOpen: onOpenTtsArtifact } : {})} />)}
            </div>
          </WorkspacePanelSection>
        ) : null}

        {imageArtifacts.length > 0 ? (
          <WorkspacePanelSection
            id="workspace-image-artifacts"
            title={t("task.image.history")}
            defaultExpanded
            summary={
              <>
                <ImageIcon size={14} aria-hidden />
                <span>{imageArtifacts.length}</span>
              </>
            }
            maxBodyHeight={280}
          >
            <ImageGenerationWorkspaceCardBody
              artifacts={imageArtifacts}
              {...(onOpenImageArtifact && { onOpenImageArtifact })}
            />
          </WorkspacePanelSection>
        ) : null}

        {imageDisplayArtifacts.length > 0 ? (
          <WorkspacePanelSection
            id="workspace-image-display-artifacts"
            title={t("task.imageDisplay.history")}
            defaultExpanded
            summary={
              <>
                <ImageIcon size={14} aria-hidden />
                <span>{imageDisplayArtifacts.length}</span>
              </>
            }
            maxBodyHeight={280}
          >
            <ImageDisplayWorkspaceCardBody
              artifacts={imageDisplayArtifacts}
              {...(onOpenImageDisplayArtifact && { onOpenImageDisplayArtifact })}
            />
          </WorkspacePanelSection>
        ) : null}

        {htmlHostArtifacts.length > 0 ? (
          <WorkspacePanelSection
            id="workspace-html-host-artifacts"
            title={t("task.htmlHost.history")}
            defaultExpanded
            summary={
              <>
                <img
                  className="workspace-html-host-section-logo"
                  src="./splash-icon.png"
                  alt=""
                  width={14}
                  height={14}
                  draggable={false}
                  aria-hidden
                />
                <span>{htmlHostArtifacts.length}</span>
              </>
            }
            maxBodyHeight={280}
          >
            <HtmlHostWorkspaceCardBody
              artifacts={htmlHostArtifacts}
              {...(onOpenHtmlHostArtifact && { onOpenHtmlHostArtifact })}
            />
          </WorkspacePanelSection>
        ) : null}

        {hasActiveThread && subagentLabels.length > 0 && !showCursorAgentsRoster ? (
          <WorkspacePanelSection
            id="workspace-agents"
            title={t("workspaceCards.orchestration")}
            defaultExpanded={defaultConfigSectionExpanded(subagentLabels.length)}
            summary={
              <>
                <Users size={14} aria-hidden />
                <span>
                  {enabledSubagents}/{subagentLabels.length}
                </span>
              </>
            }
            maxBodyHeight={320}
          >
            <ComposerAgentModelsCardBody
              embedded
              labels={agentModelLabels}
              subagentSettings={subagentSettings ?? null}
              canEditSubagents={composerConfigEditableInWorkspace}
              {...(isSavingSettings !== undefined && { subagentSaving: isSavingSettings })}
              {...(onToggleComposerSubagent && { onToggleSubagent: onToggleComposerSubagent })}
            />
          </WorkspacePanelSection>
        ) : null}

        {showCursorAgentsRoster && cursorAgentsRoster ? (
          <WorkspacePanelSection
            id="workspace-cursor-agents"
            title={t("workspaceCards.orchestration")}
            defaultExpanded={defaultConfigSectionExpanded(cursorAgentsCount)}
            summary={
              <>
                <Users size={14} aria-hidden />
                <span>{cursorAgentsCount}</span>
              </>
            }
            maxBodyHeight={320}
          >
            <CursorAgentsRosterCardBody
              agents={cursorAgentsRoster.agents}
              builtins={cursorAgentsRoster.builtins}
            />
          </WorkspacePanelSection>
        ) : null}

        {hasActiveThread &&
        integrationItems.length > 0 &&
        integrationAvailability &&
        composerIntegrationSettings ? (
          <WorkspacePanelSection
            id="workspace-integrations"
            title={t("settings.integrations")}
            defaultExpanded={defaultConfigSectionExpanded(integrationItems.length)}
            summary={
              <>
                <Blocks size={14} aria-hidden />
                <span>
                  {enabledIntegrationsCount}/{integrationItems.length}
                </span>
              </>
            }
            maxBodyHeight={220}
          >
            <ComposerIntegrationsCardBody
              availability={integrationAvailability}
              enabledSettings={composerIntegrationSettings}
              canEdit={composerConfigEditableInWorkspace}
              {...(isSavingSettings !== undefined && { saving: isSavingSettings })}
              onToggle={(id, enabled) => void onToggleComposerIntegration?.(id, enabled)}
            />
          </WorkspacePanelSection>
        ) : null}

        {hasActiveThread && enabledMcpServers.length > 0 && composerMcpSettings ? (
          <WorkspacePanelSection
            id="workspace-mcp"
            title={t("settings.mcp.title")}
            defaultExpanded={defaultConfigSectionExpanded(enabledMcpServers.length)}
            summary={
              <>
                <Unplug size={14} aria-hidden />
                <span>
                  {enabledMcpCount}/{enabledMcpServers.length}
                </span>
              </>
            }
            maxBodyHeight={280}
          >
            <ComposerMcpCardBody
              servers={mcpServers}
              enabledSettings={composerMcpSettings}
              canEdit={composerConfigEditableInWorkspace}
              {...(isSavingSettings !== undefined && { saving: isSavingSettings })}
              {...(onToggleComposerMcpServer && { onToggleServer: onToggleComposerMcpServer })}
            />
          </WorkspacePanelSection>
        ) : null}

        {hasActiveThread && skills.length > 0 && composerSkillsEnabled ? (
          <WorkspacePanelSection
            id="workspace-skills"
            title={t("composer.skills.title")}
            defaultExpanded={defaultConfigSectionExpanded(skills.length)}
            summary={
              <>
                <Sparkles size={14} aria-hidden />
                <span>
                  {enabledSkillsCount}/{skills.length}
                </span>
              </>
            }
            maxBodyHeight={320}
          >
            <ComposerSkillsCardBody
              skills={skills}
              enabledSettings={composerSkillsEnabled}
              canEdit={composerConfigEditableInWorkspace}
              {...(isSavingSettings !== undefined && { saving: isSavingSettings })}
              {...(onToggleComposerSkill && { onToggleSkill: onToggleComposerSkill })}
            />
          </WorkspacePanelSection>
        ) : null}

        {showCommitGraph && workspacePath ? (
          <WorkspacePanelSection
            id="workspace-git-graph"
            title={t("workspaceCards.gitGraph")}
            defaultExpanded={false}
            persistExpanded={false}
            summary={
              <>
                <GitGraph size={14} aria-hidden />
                <span className="floating-workspace-card-bubble-detail">{branchLabel}</span>
              </>
            }
            maxBodyHeight={300}
          >
            <WorkspaceGitCommitGraph
              workspacePath={workspacePath}
              refreshToken={`${commitsRefreshKey}:${gitStatus?.branch ?? ""}`}
              embedded
            />
          </WorkspacePanelSection>
        ) : null}
      </div>
    </section>
  );
}
