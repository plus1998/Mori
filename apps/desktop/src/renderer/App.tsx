import { ReadAloudControls, ReadAloudThreadContext } from "./ReadAloud";
import { buildComposerCapabilityReferences } from "../shared/composer-capability-references";
import { ComposerReferencesMenu } from "./ComposerReferencesMenu";
import { useComposerReferences } from "./use-composer-references";
import { composerReferenceToken } from "../shared/composer-references";
import { browserSelectionReference, type BrowserSelection } from "../shared/browser-selection";
import { BrowserSelectionPreview } from "./BrowserSelectionPreview";
import { BROWSER_SELECTION_INSERT_EVENT, BROWSER_SELECTION_REVEAL_EVENT } from "./browser-selection-events";
import { ACP_IMAGE_ONLY_PROMPT } from "@eco/runtime/acp-prompt";
import type { CoreKind } from "@eco/runtime/core-runtime";
import {
  listPlanDelegationAgents,
  type PlanDelegationAgentOption,
  type PlanExecutionTarget,
} from "@eco/runtime/forced-plan-delegation";
import { defaultSubagentAvailability } from "@eco/runtime/subagent-availability";
import { type ConversationSyncEffect, type ConversationTodo, stableHash } from "@eco/shared";
import { AnimatePresence, motion, useAnimationControls, useReducedMotion } from "framer-motion";
import {
  Activity,
  ArrowUp,
  BookOpen,
  ChevronDown,
  ChevronLeft,
  ChevronUp,
  Clock3,
  Cloud,
  Cog,
  CornerDownRight,
  Cpu,
  FolderOpen,
  Gauge,
  GitBranch,
  Globe,
  Globe2,
  GripVertical,
  HardDrive,
  KeyRound,
  LoaderCircle,
  type LucideIcon,
  Maximize2,
  MessageCirclePlus,
  MessageSquare,
  Mic,
  Minimize2,
  Monitor,
  Palette,
  PanelBottom,
  PanelLeft,
  PanelRight,
  Pause,
  Play,
  RefreshCw,
  Search,
  Settings,
  Settings2,
  SlidersHorizontal,
  Sparkles,
  Square,
  Trash2,
  Unplug,
  Volume2,
  Workflow,
  X,
} from "lucide-react";
import {
  type ClipboardEvent,
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  startTransition,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { I18nextProvider, useTranslation } from "react-i18next";
import { isAcpSubagentAgentId } from "../shared/acp-subagent";
import { type BashReviewMode, normalizeBashReviewMode } from "../shared/bash-review-ui";
import { enrichBillingDisplaySource } from "../shared/billing-display-source";
import type { BrowserSettingsSnapshot, BrowserViewState } from "../shared/browser";
import {
  browserPersonalScopeId,
  browserTaskTabId,
  isBrowserTaskTabId,
  parseBrowserTaskTabId,
} from "../shared/browser";
import { deriveSkillsEnabled, type ProjectSkillsSettingsSnapshot } from "../shared/composer-skills-settings";
import type { ComputerUseSettingsSnapshot } from "../shared/computer-use";
import type { DesktopUpdateState } from "../shared/desktop-update";
import {
  HOME_PROJECT_DISPLAY_NAME,
  HOME_PROJECT_IMPORTED_AT,
  isCustomProjectName,
  isHomeProjectPath,
  normalizeProjectPath,
  pathToName,
  resolveProjectName,
} from "../shared/home-project";
import type { HtmlHostArtifact } from "../shared/html-host";
import { imageDisplayTaskTabId, parseImageDisplayTaskTabId } from "../shared/image-display";
import { imageGenerationTaskTabId, parseImageGenerationTaskTabId } from "../shared/image-generation";
import type { IntegrationId } from "../shared/integrations";
import {
  type AppMenuCommand,
  type ApprovalModelSelection,
  type AsrProfileSaveInput,
  type AsrProfileSnapshot,
  type AsrProfilesSnapshot,
  type AuxiliaryModelSelection,
  type BackgroundTerminalTask,
  type BashApprovalRequest,
  buildThreadRuntimeConfigFromDefaults,
  type CandidateModelView,
  type CenterServerConnectionState,
  type CenterServerSettingsInput,
  type CenterServerSettingsSnapshot,
  type CenterServerSignInRequest,
  type CenterServerSignUpRequest,
  type CenterServerSyncDomain,
  type ClarificationRequest,
  type CoderTodoItem,
  type ClaudeBackgroundTask,
  type CodexBackgroundTerminal,
  type CoreAvailabilitySnapshot,
  type CursorAgentsListResult,
  type CursorModelOption,
  deriveMcpServersEnabled,
  deriveSubagentEnabledFromSnapshot,
  type EcoConnectDeepLink,
  type FollowUpDeliveryMode,
  type GitSettingsSnapshot,
  type GitWorkingTreeStatus,
  hasCompleteOrchestrationSelection,
  type ImageDisplayArtifact,
  type ImageGenerationArtifact,
  type ImageGenerationSettingsSnapshot,
  type IntegratedWebSearchSettingsSaveInput,
  type IntegratedWebSearchSettingsSnapshot,
  type IntegrationAvailabilitySnapshot,
  type LinkAgentsSkillsResult,
  listEnabledGlobalMcpServerKeys,
  type MainAgentModelOverride,
  type MainAgentPromptSelection,
  type McpServerCheckResult,
  type McpServerConfigInput,
  type McpSettingsSnapshot,
  type ModelSettingsSnapshot,
  type OrchestrationSelection,
  type PackageScriptsListResult,
  type PersonalizationSettingsSnapshot,
  type ProjectIntegrationsSettingsSnapshot,
  type ProjectMcpSettingsSnapshot,
  type ProjectOrchestrationSettingsSnapshot,
  type PromptImageAttachment,
  type ProxyBridgeSettingsSnapshot,
  parseEcoConnectDeepLink,
  type ResolvedOrchestrationSnapshot,
  type RouteCapabilityHint,
  type RoutePricingHint,
  resolveMainAgentModelOverrideForProvider,
  resolveThreadOrchestrationSnapshot,
  runtimeRoleRoutesFromOrchestrationSnapshot,
  type SkillsListResult,
  type SubagentRole,
  type SubagentSelection,
  type TerminalSessionView,
  type ThreadActivityRewindTarget,
  type ThreadLiveEvent,
  type ThreadPendingFollowUp,
  type ThreadPendingPlan,
  type ThreadRuntimeConfig,
  type ThreadStatus,
  type ThreadSubagentMetricsSummary,
  type ThreadSubagentSessionTiming,
  type ThreadSummary,
  UPSTREAM_AGENT_CORES,
  type UpstreamAgentCore,
  type VisionModelSelection,
  type WorkflowSettingsSnapshot,
  type WorkspaceDiffResult,
  type WorkspaceInfo,
} from "../shared/ipc";
import type { AppLocalePreference } from "../shared/locale";
import {
  defaultNotificationSettings,
  type NotificationSettingsSnapshot,
} from "../shared/notification-settings";
import { type SessionMode, withSessionMode } from "../shared/plan-mode-ui";
import {
  loadProjectPinyin,
  planProjectSearchTermIndex,
  projectSearchTermPlanChanged,
  type ProjectSearchTermIndex,
} from "../shared/project-pinyin-search";
import {
  formatPromptCacheConfigDriftHint,
  resolvePromptCacheConfigDrift,
  resolvePromptCacheOrchestrationLabel,
} from "../shared/prompt-cache-config";
import { resolveDraftCoreKindWhenAcpHidden } from "../shared/resolve-draft-core-kind-when-acp-hidden";
import type { ScheduleDefinition } from "../shared/scheduling";
import {
  dedupeSkillsByName,
  isSkillAvailableForCore,
  listSdkReadyProjectSkills,
  parseExplicitSkillNames,
  promptIncludesSkillName,
  type SkillCatalogEntry,
  type SkillInfo,
  type SkillLayout,
} from "../shared/skills";
import type { SshBookmarkView } from "../shared/ssh-bookmarks";
import { isContinuableThreadStatus } from "../shared/thread-continuation";
import {
  extractPlanFailureMessage,
  persistThreadSummaryMessage,
  resolveThreadMessageFromLiveEvent,
  shouldUpdateThreadSummaryFromLiveEvent,
} from "../shared/thread-failure-message";
import {
  coreSupportsFollowUpEscalate,
  coreSupportsMidTurnFollowUp,
  resolveFollowUpDeliveryModeForCore,
} from "../shared/thread-follow-up-core";
import { usesRewindOnRequestRetry } from "../shared/thread-request-retry";
import {
  buildAcpThreadRuntimeConfig,
  materializeThreadOrchestrationSnapshot,
  resolveAcpCursorModelIdForSend,
  threadRuntimeConfigsEquivalent,
} from "../shared/thread-runtime-config";
import { canRegenerateThreadTitle } from "../shared/thread-title-pending";
import { buildThreadUsageSummary } from "../shared/thread-usage-summary";
import { parseTtsTaskTabId, type TtsArtifact, type TtsSettingsSnapshot, ttsTaskTabId } from "../shared/tts";
import type { WebChatItem, WebChatListView } from "../shared/web-chat-list";
import { defaultWebChatListSnapshot, mergeWebChatList } from "../shared/web-chat-list";
import { ActivityHeaderProjectInfo } from "./ActivityHeaderProjectInfo";
import { buildConversationV2OnlyProjection } from "./ActivityLogView";
import type { PendingMainAgentConfigCreateSeed } from "./AgentCompositionResourcesSection";
import { AppMessage, useAppMessage } from "./AppMessage";
import { AsrMicButton, AsrVoiceComposer, isAsrComposerConfigured, useAsrRecorder } from "./AsrRecorder";
import { resolveActivityUserMessageActiveAnchorId } from "./activity-user-message-nav";
import {
  type ActivityWorkspaceLayoutMode,
  activityUserMessageNavListMaxHeightPx,
  activityUserMessageNavShellMaxHeightPx,
  clampTaskPanelWidth,
  computeActivityUserMessageNavDensity,
  MAIN_SHELL_MEDIA_QUERIES,
  measureFeedColumnLeftGutterPx,
  panelChromeCssVariables,
  resolveActivityWorkspaceLayoutMode,
  resolveTaskPanelLayoutPhase,
  shouldAutoOpenWorkspacePanel,
  shouldResetTaskPanelFullscreenOnBrowserOpen,
  shouldShowActivityMessageNav,
  shouldShowPanelChromeGroupB,
  shouldShowWorkspaceActionGroupA,
  TASK_PANEL_GEOMETRY,
  taskPanelGeometryCssVariables,
  taskPanelMaxWidthForPane,
  workspacePanelLayoutForMode,
} from "./activity-workspace-layout";
import {
  isStalePendingBashApprovalError,
  shouldClearPendingBashApproval,
  shouldClearPendingPlanApproval,
} from "./approval-ui-state";
import { mergeAsrTextAtSelection } from "./asr-composer";
import { BashApprovalPanel, type BashApprovalResolutionInput } from "./BashApprovalPanel";
import { BROWSER_HTML_OPEN_EVENT, BROWSER_LINK_OPEN_EVENT, openPublishedHtmlInBrowser } from "./browser-link";
import {
  browserStateStore,
  useBrowserInstanceIds,
  useBrowserStateSelector,
  useBrowserTaskInstances,
} from "./browser-state-store";
import { ClarificationPanel } from "./ClarificationPanel";
import { ComposerAcpModelTrigger } from "./ComposerAcpModelTrigger";
import { ComposerAgentModels } from "./ComposerAgentModels";
import { ComposerBashReviewToggle } from "./ComposerBashReviewToggle";
import { ComposerDockMorph } from "./ComposerDockMorph";
import { ComposerFloatingLoading } from "./ComposerFloatingLoading";
import { useComposerIconOnlyToolbar } from "./ComposerHoverTooltip";
import { ComposerIntegrations } from "./ComposerIntegrations";
import { ComposerMcpServers } from "./ComposerMcpServers";
import { ComposerModelEmptyTrigger } from "./ComposerModelEmptyTrigger";
import {
  buildComposerModelOptions,
  type ComposerModelOption,
  ComposerModelSelector,
} from "./ComposerModelSelector";
import { ComposerPlusMenu, ComposerSessionModeTag } from "./ComposerPlusMenu";
import { ComposerRoutePopover } from "./ComposerRoutePopover";
import { ComposerSkillsBar } from "./ComposerSkillsBar";
import { ComposerSkillsControl } from "./ComposerSkillsControl";
import { ComposerSkillsInput, type ComposerSkillsInputHandle } from "./ComposerSkillsInput";
import { ComposerSkillsSlashMenu } from "./ComposerSkillsSlashMenu";
import { ComposerThreadUsagePills } from "./ComposerThreadUsagePills";
import { createClarificationNotifications } from "./clarification-notifications";
import { createClarificationQueueSync } from "./clarification-queue-sync";
import { buildComposerAgentModelLabels } from "./composer-agent-model-labels";
import {
  COMPOSER_MAX_IMAGES,
  type ComposerImageAttachment,
  fromPromptImageAttachments,
  hydrateComposerImageAttachments,
  readImageFileAsAttachment,
  revokeComposerAttachmentPreview,
  revokeComposerAttachmentPreviews,
  toPromptImageAttachments,
} from "./composer-attachments";
import {
  type ComposerFollowUpEditSnapshot,
  captureComposerBeforeFollowUpEdit,
  resolveComposerAfterFollowUpEdit,
} from "./composer-follow-up-edit-draft";
import { buildComposerGlobalRuntimeConfig } from "./composer-global-runtime-config";
import { buildEffectiveComposerRuntimeConfig } from "./composer-runtime-config";
import {
  composerRequiresOrchestration,
  composerShowsRouteConfig,
  isBuiltInOpenAiProvider,
  resolveComposerModelAvailability,
} from "./composer-model-availability";
import {
  type ComposerPlanHandoff,
  resolveComposerContextPrompt,
  resolveComposerPlanRuntimeConfig,
} from "./composer-plan-handoff";
import { shouldOpenOrchestrationFullSettings } from "./composer-route-open";
import {
  applySlashSkillSelection,
  buildSkillMap,
  fileAttachmentToken,
  filterSkillsForSlash,
  parseSlashQuery,
} from "./composer-skills";
import { buildConversationV2CommandEnvelope } from "./conversation-v2-command-envelope";
import {
  buildThreadRunProjectionViewModel,
  isProjectionUserPromptItem,
  isThreadAutoCompactSuspended,
  isThreadContextCompactionInFlight,
  isThreadPromptCacheInvalidated,
  projectionItemToDetailBlock,
  type ThreadRunProjectionMainFeedEntry,
} from "./conversation-v2-projection-view";
import { isConversationV2InteractionEffect } from "./conversation-v2-render-priority";
import {
  applyConversationV2Effects,
  type ConversationV2RendererState,
  catchUpConversationV2RendererState,
  conversationV2ToolRunIdsForHydration,
  installConversationV2Bootstrap,
  installConversationV2ProjectionExtras,
  mergeConversationV2OlderPage,
  mergeConversationV2ToolPage,
} from "./conversation-v2-renderer-state";
import { FeedStatusDivider } from "./FeedStatusDivider";
import { FullAccessNotice } from "./FullAccessNotice";
import { dispatchFeedScrollToAnchor } from "./feed-virtual-sections";
import { applyLocalePreference, i18n, initialLocalePreference } from "./i18n";
import { COMPOSER_SEND_ICON_PX, ICON_SIZE, ICON_STROKE } from "./icon-metrics";
import {
  advanceImageGalleryQueue,
  appendImageGalleryItems,
  type ImageGalleryQueueItem,
  imageGalleryDisplayItem,
  imageGalleryGenerationItem,
} from "./image-gallery-float-state";
import { ImageLightbox } from "./image-lightbox";
import {
  LazyActivityLogView,
  LazyAsrSettingsPanel,
  LazyBrowserSettingsPanel,
  LazyBrowserWebviewLayer,
  LazyCenterServerSettingsPanel,
  LazyComputerUseSettingsPanel,
  LazyCodexAccountSwitchDialog,
  LazyContextWindowSettingsPanel,
  LazyDefaultAgentSettingsPanel,
  LazyGeneralSettingsPanel,
  LazyGitSettingsPanel,
  LazyImageGalleryFloat,
  LazyImageGenerationSettingsPanel,
  LazyIntegratedWebSearchSettingsPanel,
  LazyMcpSettingsPanel,
  LazyModelsSettingsPanel,
  LazyNotificationPreferencesPanel,
  LazyOpenAIAccountsPanel,
  LazyPersonalizationSettingsPanel,
  LazyProxySettingsPanel,
  LazyScheduledMessageDialog,
  LazySchedulingPanel,
  LazySkillsSettingsPanel,
  LazyStorageSettingsPanel,
  LazySubagentTaskDrawer,
  LazyTerminalPanel,
  LazyTtsSettingsPanel,
  SuspensePanel,
} from "./lazy-app-panels";
import type { ModelsSettingsTab } from "./ModelsSettingsPanel";
import {
  diagnoseOrchestrationSnapshotReadiness,
  invalidOrchestrationFieldsFromIssues,
  isOrchestrationSnapshotReady,
  orchestrationIssueDetailKey,
} from "./orchestration-readiness";
import { PackageScriptsDialog } from "./PackageScriptsDialog";
import { PlanApprovalPanel } from "./PlanApprovalPanel";
import { ProjectSidebarTree } from "./ProjectSidebarTree";
import { waitForOverlayDismiss } from "./package-script-ui";
import {
  buildInitialProjectOrder,
  ensureHomeProjectFirst,
  type ProjectReorderPosition,
  prependProjectOrder,
  reorderProjectPaths,
  sortProjectsByOrder,
  sortThreadsForSidebar,
} from "./project-sidebar-order";
import {
  isConversationV2ProjectionRefreshEffect,
  shouldRefreshConversationV2ProjectionExtras,
  TOOL_WRITING_REFRESH_LIVE_TYPES,
} from "./projection-extras-refresh";
import {
  type PromptCacheTipPreferences,
  persistPromptCacheTipPreferences,
  readStoredPromptCacheTipPreferences,
} from "./prompt-cache-tip-preferences";
import { type RequestFailureRetryTarget, readUserPromptRetryIdentity } from "./request-failure-retry";
import { buildRuntimeAgentDisplayNames } from "./runtime-agent-display";
import { buildRuntimeAgentThemes } from "./runtime-agent-theme";
import { SettingsSyncControl } from "./SettingsSyncControl";
import { SidebarCoreSelector } from "./SidebarCoreSelector";
import { SidebarSearchDialog } from "./SidebarSearchDialog";
import { SidebarSettingsUpdateControl } from "./SidebarSettingsUpdateControl";
import { buildSidebarAttentionItems } from "./sidebar-attention-items";
import type { TerminalSessionPresentation } from "./TerminalPanel";
import { ThreadIdleCacheWarning } from "./ThreadIdleCacheWarning";
import { OpenTtsArtifactContext, TtsArtifactsContext } from "./TtsArtifactPlayer";
import { loadTaskPanelReviewDiff } from "./task-panel-review-loader";
import {
  captureTaskPanelSessionUiState,
  emptyTaskPanelSessionUiState,
  normalizeTaskPanelSessionUiState,
  type TaskPanelSessionUiState,
} from "./task-panel-session-ui-state";
import {
  addOpenTaskPanelTab,
  removeOpenTaskPanelTab,
  replaceOpenTaskPanelTab,
  resolveTaskPanelReopenTab,
} from "./task-panel-tab-state";
import {
  isNewTaskPanelTabId,
  newTaskPanelTabId,
  TASK_PANEL_BACKGROUND_TERMINAL_TAB_ID,
  TASK_PANEL_FILE_VIEWER_TAB_ID,
  TASK_PANEL_FILES_TAB_ID,
  TASK_PANEL_HOME_TAB_ID,
  TASK_PANEL_PLAN_TAB_ID,
  TASK_PANEL_REVIEW_TAB_ID,
  TASK_PANEL_SSH_BOOKMARKS_TAB_ID,
  type TaskPanelActiveTab,
  type TaskPanelHomeTool,
} from "./task-panel-tabs";
import {
  createProjectTerminalState,
  DEFAULT_TERMINAL_HEIGHT,
  getProjectTerminalState,
  type InjectedTerminalSessionIdentity,
  type ProjectTerminalState,
  readTerminalWorkspaceState,
  resolveTerminalTabForInjectedSession,
  saveTerminalWorkspaceState,
  type TerminalTabRecord,
  type TerminalWorkspaceState,
} from "./terminal-panel-storage";
import {
  deleteTerminalSessionId,
  hasTerminalSessionsForProject,
  listTerminalSessionEntriesForProject,
  listTerminalSessionsForProject,
  replaceTerminalSessionsForProject,
  type TerminalSessionCacheEntry,
} from "./terminal-session-cache";
import { type AppTheme, persistAppTheme, readStoredAppTheme, subscribeToSystemTheme } from "./theme";
import {
  persistThinkingDisplayPreferences,
  readStoredThinkingDisplayPreferences,
  type ThinkingDisplayPreferences,
} from "./thinking-display-preferences";
import {
  canEscalateThreadFollowUp,
  formatThreadFollowUpPreview,
  mergeThreadFollowUp,
  mergeThreadFollowUps,
  queuedThreadFollowUps,
  shouldComposerUseFollowUpQueue,
} from "./thread-follow-up-ui";
import { resolveLatestThreadActivityAt } from "./thread-idle-cache-warning";
import {
  collectProtectedProjectionThreadIds,
  isProjectionCacheHotThreadStatus,
  listEvictableProjectionThreadIds,
  PROJECTION_CACHE_EVICT_DELAY_MS,
  rememberRecentlyViewedThread,
  removeRecordKeys,
} from "./thread-projection-cache-policy";
import {
  persistTokenSpeedPreferences,
  readStoredTokenSpeedPreferences,
  type TokenSpeedPreferences,
} from "./token-speed-preferences";
import {
  persistTypographyPreferences,
  readStoredTypographyPreferences,
  type TypographyPreferences,
} from "./typography-preferences";
import { useSchedulingSnapshot } from "./use-scheduling-snapshot";
import { useStableCallback } from "./use-stable-callback";
import { installVitePreloadRecovery } from "./vite-preload-recovery";
import { WebChatListPopover } from "./WebChatListPopover";
import { RunningResourcesPopover } from "./RunningResourcesPopover";
import {
  selectClaudeBackgroundTasksForThread,
  selectCodexBackgroundTerminalsForThread,
  type RunningTerminal,
} from "./running-resources";
import { WorkspaceFloatingCards } from "./WorkspaceFloatingCards";
import { isThreadActivelyViewed, subscribeToWindowFocus } from "./window-focus";
import {
  isAbsoluteLocalFilePath,
  isWorkspacePathContained,
  WORKSPACE_FILE_REFERENCE_EVENT,
  type WorkspaceFileReference,
} from "./workspace-file-reference";
import {
  cacheWorkspaceGitStatus,
  shouldRefreshWorkspaceGitStatus,
  type WorkspaceGitStatusCache,
} from "./workspace-git-status-cache";
import {
  cacheWorkspaceReviewSummary,
  invalidateWorkspaceReviewSummary,
  readWorkspaceReviewSummary,
} from "./workspace-review-cache";
import "./themes.css";
import "./styles.css";
import "./theme-overrides.css";

const TASK_PANEL_WIDTH_STORAGE_KEY = "eco.task-panel.width";
const CONVERSATION_V2_PENDING_EVENT_LIMIT = 512;

function readTaskPanelWidth(): number {
  try {
    if (typeof localStorage === "undefined") {
      return TASK_PANEL_GEOMETRY.defaultWidth;
    }
    const raw = localStorage.getItem(TASK_PANEL_WIDTH_STORAGE_KEY);
    if (!raw) {
      return TASK_PANEL_GEOMETRY.defaultWidth;
    }
    return clampTaskPanelWidth(Number.parseInt(raw, 10));
  } catch {
    return TASK_PANEL_GEOMETRY.defaultWidth;
  }
}

function saveTaskPanelWidth(width: number): void {
  try {
    if (typeof localStorage === "undefined") {
      return;
    }
    localStorage.setItem(TASK_PANEL_WIDTH_STORAGE_KEY, String(clampTaskPanelWidth(width)));
  } catch {
    // ignore quota and private-mode storage errors
  }
}

const EXPECTED_NOTIFICATION_NOOP_REASONS = new Set([
  "unsupported",
  "preference_disabled",
  "thread_not_found",
  "thread_not_completed",
  "notification_content_unavailable",
  "approval_not_pending",
  "clarification_not_pending",
]);

function reportDesktopNotification(
  request: Promise<{ shown: boolean; reason?: string }>,
  notificationLabel: string,
): void {
  void request.then(
    (result) => {
      if (!result.shown && (!result.reason || !EXPECTED_NOTIFICATION_NOOP_REASONS.has(result.reason))) {
        console.error(`[eco] ${notificationLabel} notification was not shown: ${result.reason}`);
      }
    },
    (notificationError) => {
      console.error(`[eco] ${notificationLabel} notification request failed`, notificationError);
    },
  );
}

const emptySettings: ModelSettingsSnapshot = {
  providers: [],
  routeProfiles: [],
  agentTemplates: [],
  mainAgentConfigs: [],
  mainAgentPrompts: [],
  subagentOrchestrations: [],
};

const recentProjectsStorageKey = "eco.recent-projects";
const projectOrderStorageKey = "eco.project-order";
const pinnedProjectsStorageKey = "eco.sidebar.pinned-projects";
const pinnedThreadsStorageKey = "eco.sidebar.pinned-threads";
const unreadThreadsStorageKey = "eco.sidebar.unread-threads";
const collapsedProjectsStorageKey = "eco.sidebar.collapsed-projects";
const hiddenProjectsStorageKey = "eco.sidebar.hidden-projects";
const customProjectNamesStorageKey = "eco.sidebar.custom-project-names";
const customProjectSearchTermsStorageKey = "eco.sidebar.custom-project-search-terms";
const compactSidebarMediaQuery = MAIN_SHELL_MEDIA_QUERIES.sidebarOverlay;
const taskPanelNarrowMediaQuery = MAIN_SHELL_MEDIA_QUERIES.taskOverlay;
const sidebarThreadsCollapsed = 5;

interface RecentProject {
  path: string;
  name: string;
  /** Set once when the project is first opened in the app; used for stable sidebar order. */
  importedAt: string;
  /** Pinyin spellings of a Chinese display name, used to widen sidebar search. */
  searchTerms?: string[];
}

/** Pinyin index persisted for Chinese project names, keyed by project path. */
function readStoredProjectSearchTerms(): ProjectSearchTermIndex {
  const saved = window.localStorage.getItem(customProjectSearchTermsStorageKey);
  if (!saved) {
    return {};
  }
  try {
    const parsed = JSON.parse(saved) as unknown;
    if (!isRecordValue(parsed)) {
      return {};
    }
    const index: ProjectSearchTermIndex = {};
    for (const [projectPath, value] of Object.entries(parsed)) {
      if (!isRecordValue(value)) {
        continue;
      }
      const name = value.name;
      const terms = value.terms;
      if (typeof name === "string" && Array.isArray(terms) && terms.every((item) => typeof item === "string")) {
        index[projectPath] = { name, terms: terms as string[] };
      }
    }
    return index;
  } catch {
    window.localStorage.removeItem(customProjectSearchTermsStorageKey);
    return {};
  }
}

type SettingsSectionId =
  | "preferences"
  | "general"
  | "personalization"
  | "storage"
  | "browser"
  | "computerUse"
  | "imageGeneration"
  | "tts"
  | "integratedWebSearch"
  | "providers"
  | "proxy"
  | "mcp"
  | "centerServer"
  | "defaultAgent"
  | "contextWindow"
  | "agentLibrary"
  | "orchestrationComponents"
  | "skills"
  | "git"
  | "asr";

interface SettingsSection {
  id: SettingsSectionId;
  label: string;
  icon: LucideIcon;
  keywords?: string[];
}

interface SettingsNavGroup {
  label: string;
  sections: SettingsSection[];
}

const emptyCenterServerSettings: CenterServerSettingsSnapshot = {
  settings: {
    enabled: false,
    supabaseUrl: "",
    serverUrl: "",
    hasAnonKey: false,
    deviceName: "Eco Desktop",
    hasDeviceSecret: false,
    hasRefreshToken: false,
    hasVaultKey: false,
  },
  status: { state: "disabled" },
};

/** Sidebar presence: green online, yellow reconnecting, red offline. */
function sidebarCenterPresenceDotKind(state: CenterServerConnectionState): "online" | "pending" | "error" {
  if (state === "connected") {
    return "online";
  }
  if (state === "connecting") {
    return "pending";
  }
  return "error";
}

const emptyMcpSettings: McpSettingsSnapshot = { servers: [] };

const emptyImageGenerationSettings: ImageGenerationSettingsSnapshot = {
  enabled: false,
  activeProfileId: "",
  profiles: [],
  apiKeyEncryptionAvailable: false,
};

const emptyIntegrationAvailability: IntegrationAvailabilitySnapshot = {
  integrations: [
    { id: "browser", enabled: false, available: false },
    { id: "imageGeneration", enabled: false, available: false },
    { id: "tts", enabled: false, available: false },
    { id: "computerUse", enabled: false, available: false },
  ],
};

const emptyGitSettings: GitSettingsSnapshot = {
  commitMessageRoleByMainAgentConfigId: {},
  commitMessageCandidateModelIdByMainAgentConfigId: {},
};

const emptyPersonalizationSettings: PersonalizationSettingsSnapshot = {};
const emptyAsrProfiles: AsrProfilesSnapshot = {
  profiles: [],
  activeProfileId: "",
  apiKeyEncryptionAvailable: false,
};

interface ComposerRewindTarget extends ThreadActivityRewindTarget {
  threadId: string;
}

interface ComposerDraft {
  prompt: string;
  attachments: ComposerImageAttachment[];
  rewindTarget?: ComposerRewindTarget;
}

interface TerminalProjectSyncResult {
  state?: ProjectTerminalState;
  cacheEntries: TerminalSessionCacheEntry[];
}

const RESTORED_TERMINAL_TAB_PREFIX = "session:";

function terminalTabIdForSession(sessionId: string): string {
  return `${RESTORED_TERMINAL_TAB_PREFIX}${sessionId}`;
}

function cacheEntryForTab(tab: TerminalTabRecord, sessionId: string): TerminalSessionCacheEntry {
  return {
    tabId: tab.id,
    sessionId,
    kind: tab.kind,
    ...(tab.label ? { label: tab.label } : {}),
    ...(tab.endpoint ? { endpoint: tab.endpoint } : {}),
  };
}

function buildTerminalStateForLiveSessions(
  existing: ProjectTerminalState | undefined,
  workspacePath: string,
  workspaceLabel: string,
  sessions: readonly TerminalSessionView[],
): TerminalProjectSyncResult {
  if (sessions.length === 0) {
    return { cacheEntries: [] };
  }

  const cachedEntries = listTerminalSessionEntriesForProject(workspacePath);
  const tabsById = new Map((existing?.tabs ?? []).map((tab) => [tab.id, tab]));
  const tabIdBySessionId = new Map(cachedEntries.map((entry) => [entry.sessionId, entry.tabId]));
  const usedLabels = new Set<string>();
  const cacheEntries: TerminalSessionCacheEntry[] = [];

  const tabs = sessions.map((session, index): TerminalTabRecord => {
    const cachedTabId = tabIdBySessionId.get(session.sessionId);
    const restoredTabId = terminalTabIdForSession(session.sessionId);
    const existingTab = cachedTabId ? tabsById.get(cachedTabId) : tabsById.get(restoredTabId);
    if (existingTab) {
      // The live PTY owns the identity: a restored SSH tab keeps its bookmark name
      // even if it was persisted before the session was labelled.
      const sshEndpoint = session.kind === "ssh" ? session.endpoint?.trim() : "";
      const tab: TerminalTabRecord =
        session.kind === "ssh"
          ? {
              ...existingTab,
              kind: "ssh",
              label: session.label?.trim() || existingTab.label,
              ...(sshEndpoint ? { endpoint: sshEndpoint } : {}),
            }
          : existingTab;
      usedLabels.add(tab.label);
      cacheEntries.push(cacheEntryForTab(tab, session.sessionId));
      return tab;
    }

    // A live SSH PTY keeps its bookmark identity across a renderer reload; only
    // local shells fall back to the workspace name.
    const isSsh = session.kind === "ssh";
    const sshLabel = isSsh ? session.label?.trim() || session.endpoint?.trim() : "";
    const labelBase = sshLabel || workspaceLabel.trim() || i18n.t("app.terminalFallback");
    const baseLabel = index === 0 ? labelBase : `${labelBase} ${index + 1}`;
    let label = baseLabel;
    let suffix = 2;
    while (usedLabels.has(label)) {
      label = `${baseLabel} ${suffix}`;
      suffix += 1;
    }
    usedLabels.add(label);
    const sshEndpoint = isSsh ? session.endpoint?.trim() : "";
    const tab: TerminalTabRecord = {
      id: terminalTabIdForSession(session.sessionId),
      label,
      kind: isSsh ? "ssh" : "local",
      ...(sshEndpoint ? { endpoint: sshEndpoint } : {}),
    };
    cacheEntries.push(cacheEntryForTab(tab, session.sessionId));
    return tab;
  });

  const firstTab = tabs[0];
  if (!firstTab) {
    return { cacheEntries: [] };
  }
  const activeTabId =
    existing?.activeTabId && tabs.some((tab) => tab.id === existing.activeTabId)
      ? existing.activeTabId
      : firstTab.id;

  return {
    state: {
      open: true,
      height: existing?.height ?? DEFAULT_TERMINAL_HEIGHT,
      tabs,
      activeTabId,
    },
    cacheEntries,
  };
}

function composerContextKeyFromParts(threadId?: string, projectPath?: string): string | undefined {
  if (threadId) {
    return `thread:${threadId}`;
  }
  if (projectPath) {
    return `landing:${projectPath}`;
  }
  return undefined;
}

function measureTopbarFeedOverlap(scrollBody: HTMLElement, topbar: HTMLElement): boolean {
  const feed = scrollBody.querySelector(".codex-feed-stack");
  if (!feed) {
    return false;
  }
  const feedRect = feed.getBoundingClientRect();
  const zones = [
    topbar.querySelector(".activity-header"),
    topbar.querySelector(".codex-main-topbar-actions"),
  ].filter((node): node is Element => node instanceof Element);
  if (zones.length === 0) {
    return false;
  }
  return zones.some((zone) => {
    const zoneRect = zone.getBoundingClientRect();
    if (zoneRect.width <= 0 || zoneRect.height <= 0) {
      return false;
    }
    return feedRect.left < zoneRect.right - 1 && feedRect.right > zoneRect.left + 1;
  });
}

function threadIdFromComposerContextKey(key: string): string | undefined {
  return key.startsWith("thread:") ? key.slice("thread:".length) : undefined;
}

function persistComposerDraftSnapshot(
  store: Record<string, ComposerDraft>,
  key: string,
  snapshot: {
    prompt: string;
    attachments: readonly ComposerImageAttachment[];
    rewindTarget?: ComposerRewindTarget;
  },
) {
  const threadId = threadIdFromComposerContextKey(key);
  const rewindTarget =
    snapshot.rewindTarget && (!threadId || snapshot.rewindTarget.threadId === threadId)
      ? snapshot.rewindTarget
      : undefined;
  if (!snapshot.prompt.trim() && snapshot.attachments.length === 0 && !rewindTarget) {
    delete store[key];
    return;
  }
  store[key] = {
    prompt: snapshot.prompt,
    attachments: [...snapshot.attachments],
    ...(rewindTarget && { rewindTarget }),
  };
}

function clearComposerDraft(store: Record<string, ComposerDraft>, key: string | undefined) {
  if (key) {
    delete store[key];
  }
}

const ACTIVITY_FEED_STICK_THRESHOLD_PX = 120;
const ACTIVITY_FEED_SCROLL_JUMP_THRESHOLD_PX = 200;
/**
 * Coalesce provider effects for a short frame-sized window. The Markdown
 * renderer paces the text between these commits, so this is an IPC/React
 * batching guard rather than the visible typing cadence.
 */
const CONVERSATION_V2_LIVE_FLUSH_TARGET_MS = 48;
const CONVERSATION_V2_LIVE_FLUSH_BACKPRESSURE_MS = 80;
const ACTIVITY_FEED_USER_SCROLL_DELTA_PX = 2;
const ACTIVITY_FEED_FORCE_SCROLL_MS = 800;
const ACTIVITY_FEED_LAYOUT_SCROLL_DEBOUNCE_MS = 80;
const ACTIVITY_FEED_BOOT_TIMEOUT_MS = 10_000;
const COMPOSER_DRAFT_SAVE_DEBOUNCE_MS = 250;
const WORKSPACE_CARDS_PANEL_WIDTH_PX = 300;

type ActivityFeedScrollJump = "bottom" | "top";
type ActivityFeedUserScrollDirection = "up" | "down";
interface ActivityUserMessageNavItem {
  id: string;
  userMessage: string;
  fileNames: string[];
  index: number;
  agentReply?: string;
}

interface ActivityUserMessageNavItemDraft {
  id: string;
  userMessage: string;
  index: number;
  fileNames: Set<string>;
  agentReply?: string;
}

function resolveActivityFeedScrollJump(
  scrollTop: number,
  distanceFromBottom: number,
  userScrollDirection: ActivityFeedUserScrollDirection | null,
): ActivityFeedScrollJump | null {
  if (!userScrollDirection) {
    return null;
  }
  if (distanceFromBottom <= ACTIVITY_FEED_SCROLL_JUMP_THRESHOLD_PX) {
    return null;
  }
  if (scrollTop <= ACTIVITY_FEED_SCROLL_JUMP_THRESHOLD_PX) {
    return null;
  }
  return userScrollDirection === "up" ? "top" : "bottom";
}

function normalizeActivityUserMessageText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function clipActivityUserMessageText(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

function buildActivityUserMessageNavItem(
  id: string,
  text: string,
  index: number,
): ActivityUserMessageNavItemDraft {
  return {
    id,
    userMessage: normalizeActivityUserMessageText(text) || i18n.t("app.userMessage", { count: index + 1 }),
    index,
    fileNames: new Set(),
  };
}

function finishActivityUserMessageNavItem(
  draft: ActivityUserMessageNavItemDraft,
): ActivityUserMessageNavItem {
  const agentReply = draft.agentReply ? normalizeActivityUserMessageText(draft.agentReply) : "";
  return {
    id: draft.id,
    userMessage: draft.userMessage,
    fileNames: [...draft.fileNames],
    index: draft.index,
    ...(agentReply && { agentReply }),
  };
}

function activityUserMessageAriaLabel(item: ActivityUserMessageNavItem): string {
  return i18n.t("app.jumpToMessage", {
    message: clipActivityUserMessageText(item.userMessage, 34),
  });
}

function formatActivityUserMessageFileList(fileNames: readonly string[]): string {
  return fileNames.join(" · ");
}

function collectActivityUserMessageRoundItem(
  draft: ActivityUserMessageNavItemDraft,
  item: Parameters<typeof projectionItemToDetailBlock>[0],
  options?: { collectReply?: boolean },
) {
  const block = projectionItemToDetailBlock(item);
  if (!block) {
    return;
  }
  if (options?.collectReply && block.kind === "narrative" && !block.streaming && block.text.trim()) {
    draft.agentReply = block.text;
    return;
  }
  if (block.kind !== "action") {
    return;
  }
  if (block.fileChange) {
    draft.fileNames.add(block.fileChange.fileName || block.fileChange.path);
  }
}

function collectActivityUserMessageRoundEntry(
  draft: ActivityUserMessageNavItemDraft,
  entry: ThreadRunProjectionMainFeedEntry,
) {
  if (entry.kind === "timeline") {
    collectActivityUserMessageRoundItem(draft, entry.item, { collectReply: true });
    return;
  }
  if (entry.kind === "tool-group") {
    for (const child of entry.entries) {
      collectActivityUserMessageRoundItem(draft, child.item);
    }
    return;
  }
  if (entry.kind === "agent-echo") {
    collectActivityUserMessageRoundItem(draft, entry.item);
    return;
  }
  for (const item of entry.card.agent.timeline) {
    collectActivityUserMessageRoundItem(draft, item);
  }
}

function ActivityUserMessageNavigator({
  items,
  activeId,
  hidden = false,
  onJump,
}: {
  items: ActivityUserMessageNavItem[];
  activeId?: string;
  hidden?: boolean;
  onJump: (id: string) => void;
}) {
  const [hoveredId, setHoveredId] = useState<string>();
  const navRef = useRef<HTMLElement>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const [cardTopPx, setCardTopPx] = useState<number>();
  const [shellMaxHeightPx, setShellMaxHeightPx] = useState(() =>
    activityUserMessageNavShellMaxHeightPx(window.innerHeight),
  );

  useLayoutEffect(() => {
    const syncShellMaxHeight = () => {
      setShellMaxHeightPx(activityUserMessageNavShellMaxHeightPx(window.innerHeight));
    };
    syncShellMaxHeight();
    window.addEventListener("resize", syncShellMaxHeight);
    return () => window.removeEventListener("resize", syncShellMaxHeight);
  }, []);

  const listMaxHeightPx = activityUserMessageNavListMaxHeightPx(shellMaxHeightPx);
  const density = useMemo(
    () => computeActivityUserMessageNavDensity(items.length, listMaxHeightPx),
    [items.length, listMaxHeightPx],
  );
  const resolvedActiveId = activeId && items.some((item) => item.id === activeId) ? activeId : items[0]?.id;

  useLayoutEffect(() => {
    if (hidden || items.length === 0 || !resolvedActiveId || !listRef.current) {
      return;
    }
    const activeButton = listRef.current.querySelector<HTMLElement>('button[aria-current="location"]');
    activeButton?.scrollIntoView({ block: "nearest" });
  }, [hidden, items.length, resolvedActiveId, density.buttonHeightPx, density.itemGapPx, density.scrollable]);

  useLayoutEffect(() => {
    if (!hoveredId || !listRef.current || !navRef.current) {
      setCardTopPx(undefined);
      return;
    }
    const hoveredIndex = items.findIndex((item) => item.id === hoveredId);
    if (hoveredIndex < 0) {
      setCardTopPx(undefined);
      return;
    }
    const button = listRef.current.querySelectorAll("button").item(hoveredIndex);
    if (!(button instanceof HTMLElement)) {
      setCardTopPx(undefined);
      return;
    }
    const navRect = navRef.current.getBoundingClientRect();
    const buttonRect = button.getBoundingClientRect();
    setCardTopPx(buttonRect.top + buttonRect.height / 2 - navRect.top);
  }, [hoveredId, items, density.buttonHeightPx, density.itemGapPx, density.scrollable]);

  if (hidden || items.length === 0) {
    return null;
  }
  const hoveredIndex = hoveredId ? items.findIndex((item) => item.id === hoveredId) : -1;
  const hoveredItem = hoveredIndex >= 0 ? items[hoveredIndex] : undefined;
  const clearHoverIfLeaving = (nextTarget: EventTarget | null, currentTarget: EventTarget) => {
    if (nextTarget instanceof Node && currentTarget instanceof Node && currentTarget.contains(nextTarget)) {
      return;
    }
    setHoveredId(undefined);
  };

  return (
    <nav
      ref={navRef}
      className="activity-user-message-nav"
      aria-label={i18n.t("app.userMessageList")}
      style={
        {
          "--activity-user-message-nav-button-height": `${density.buttonHeightPx}px`,
          "--activity-user-message-nav-item-gap": `${density.itemGapPx}px`,
          ...(cardTopPx !== undefined && {
            "--activity-user-message-nav-card-top": `${cardTopPx}px`,
          }),
        } as CSSProperties
      }
      onPointerLeave={() => setHoveredId(undefined)}
      onBlur={(event) => clearHoverIfLeaving(event.relatedTarget, event.currentTarget)}
    >
      <ol
        ref={listRef}
        className={["activity-user-message-nav-list", density.scrollable ? "is-scrollable" : ""]
          .filter(Boolean)
          .join(" ")}
      >
        {items.map((item, index) => {
          const active = item.id === resolvedActiveId;
          const hoverDistance = hoveredIndex >= 0 ? Math.abs(index - hoveredIndex) : -1;
          const buttonClassName = [
            "activity-user-message-nav-button",
            active ? "is-active" : "",
            hoverDistance === 0 ? "is-hovered" : "",
            hoverDistance === 1 ? "is-neighbor-1" : "",
            hoverDistance === 2 ? "is-neighbor-2" : "",
          ]
            .filter(Boolean)
            .join(" ");
          return (
            <li key={item.id} className="activity-user-message-nav-item">
              <button
                type="button"
                className={buttonClassName}
                onClick={() => onJump(item.id)}
                onFocus={() => setHoveredId(item.id)}
                onPointerEnter={() => setHoveredId(item.id)}
                aria-label={activityUserMessageAriaLabel(item)}
                aria-current={active ? "location" : undefined}
              >
                <span className="activity-user-message-nav-line" aria-hidden />
              </button>
            </li>
          );
        })}
      </ol>
      {hoveredItem ? (
        <span className="activity-user-message-nav-card" role="tooltip">
          <span className="activity-user-message-nav-card-user">
            {clipActivityUserMessageText(hoveredItem.userMessage, 132)}
          </span>
          {hoveredItem.agentReply ? (
            <span className="activity-user-message-nav-card-agent">
              {clipActivityUserMessageText(hoveredItem.agentReply, 150)}
            </span>
          ) : null}
          {hoveredItem.fileNames.length > 0 ? (
            <span
              className="activity-user-message-nav-card-files"
              title={formatActivityUserMessageFileList(hoveredItem.fileNames)}
            >
              {formatActivityUserMessageFileList(hoveredItem.fileNames)}
            </span>
          ) : null}
        </span>
      ) : null}
    </nav>
  );
}

function App() {
  const { t } = useTranslation();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [codexAccountSwitchOpen, setCodexAccountSwitchOpen] = useState(false);
  const [schedulingOpen, setSchedulingOpen] = useState(false);
  const scheduling = useSchedulingSnapshot();
  const scheduledMessages = useMemo(
    () => scheduling.snapshot.schedules.filter((item) => item.kind === "session_message"),
    [scheduling.snapshot.schedules],
  );
  const [scheduledMessageEditor, setScheduledMessageEditor] = useState<{
    threadId: string;
    definition?: ScheduleDefinition;
  }>();
  const [scheduledMessagesReveal, setScheduledMessagesReveal] = useState<{
    threadId: string;
    requestId: number;
  }>();
  const [ecoConnectLink, setEcoConnectLink] = useState<EcoConnectDeepLink>();
  const [sidebarOpen, setSidebarOpen] = useState(() => !window.matchMedia(compactSidebarMediaQuery).matches);
  const menuCommandHandlerRef = useRef<(command: AppMenuCommand) => void>(() => {});
  const [desktopUpdateState, setDesktopUpdateState] = useState<DesktopUpdateState>();
  const [sidebarSearchOpen, setSidebarSearchOpen] = useState(false);
  const [gitCommitDialogOpen, setGitCommitDialogOpen] = useState(false);
  const handleCommitDialogOpenChange = useCallback((open: boolean) => {
    setGitCommitDialogOpen(open);
  }, []);
  const [sidebarRevealTarget, setSidebarRevealTarget] = useState<{
    kind: "project" | "thread";
    id: string;
    requestId: number;
  }>();
  const [settingsSection, setSettingsSection] = useState<SettingsSectionId>("preferences");
  const [settingsSearch, setSettingsSearch] = useState("");
  const [appTheme, setAppTheme] = useState<AppTheme>(() => readStoredAppTheme());
  const [localePreference, setLocalePreference] = useState<AppLocalePreference>(initialLocalePreference);
  const [typographyPreferences, setTypographyPreferences] = useState<TypographyPreferences>(() =>
    readStoredTypographyPreferences(),
  );
  const [promptCacheTipPreferences, setPromptCacheTipPreferences] = useState<PromptCacheTipPreferences>(() =>
    readStoredPromptCacheTipPreferences(),
  );
  const [tokenSpeedPreferences, setTokenSpeedPreferences] = useState<TokenSpeedPreferences>(() =>
    readStoredTokenSpeedPreferences(),
  );
  const [thinkingDisplayPreferences, setThinkingDisplayPreferences] = useState<ThinkingDisplayPreferences>(
    () => readStoredThinkingDisplayPreferences(),
  );

  useEffect(() => {
    const mediaQuery = window.matchMedia(compactSidebarMediaQuery);
    const collapseSidebar = () => {
      if (mediaQuery.matches) {
        setSidebarOpen(false);
      }
    };
    collapseSidebar();
    mediaQuery.addEventListener("change", collapseSidebar);
    return () => mediaQuery.removeEventListener("change", collapseSidebar);
  }, []);

  useEffect(() => {
    persistAppTheme(appTheme);
  }, [appTheme]);

  useEffect(() => {
    persistTypographyPreferences(typographyPreferences);
  }, [typographyPreferences]);

  useEffect(() => {
    persistPromptCacheTipPreferences(promptCacheTipPreferences);
  }, [promptCacheTipPreferences]);

  useEffect(() => {
    persistTokenSpeedPreferences(tokenSpeedPreferences);
  }, [tokenSpeedPreferences]);

  useEffect(() => {
    persistThinkingDisplayPreferences(thinkingDisplayPreferences);
  }, [thinkingDisplayPreferences]);

  useEffect(() => {
    void applyLocalePreference(localePreference);
  }, [localePreference]);

  useEffect(() => {
    if (!window.eco) {
      return undefined;
    }
    return window.eco.onAppMenuCommand((command) => menuCommandHandlerRef.current(command));
  }, []);

  useEffect(() => {
    if (!window.eco?.getDesktopUpdateState || !window.eco.onDesktopUpdateStateChanged) {
      return undefined;
    }
    let active = true;
    const applyUpdateState = (state: DesktopUpdateState) => {
      if (!active) {
        return;
      }
      setDesktopUpdateState(state);
    };
    void window.eco.getDesktopUpdateState().then(applyUpdateState);
    const unsubscribe = window.eco.onDesktopUpdateStateChanged(applyUpdateState);
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (localePreference !== "system") {
      return undefined;
    }
    const handleLanguageChange = () => {
      void applyLocalePreference("system");
    };
    window.addEventListener("languagechange", handleLanguageChange);
    return () => window.removeEventListener("languagechange", handleLanguageChange);
  }, [localePreference]);

  const settingsNavGroups = useMemo<SettingsNavGroup[]>(
    () => [
      {
        label: t("settings.group.general"),
        sections: [
          {
            id: "preferences",
            label: t("settings.preferences"),
            icon: Settings,
            keywords: [
              t("settings.preferences.general"),
              t("settings.language"),
              t("settings.cacheBreakTips"),
              t("settings.showBilling"),
              t("settings.followUpDelivery"),
              t("settings.followUpDelivery.queue"),
              t("settings.followUpDelivery.steer"),
              t("settings.defaultBashReviewMode"),
              t("bash.review.always"),
              t("bash.review.auto"),
              t("bash.review.allowAll"),
              t("settings.thinkingContentDefault"),
              t("settings.thinkingContentDefault.ephemeral"),
              t("settings.thinkingContentDefault.collapsed"),
              t("settings.thinkingContentDefault.expanded"),
              t("settings.notifications"),
              t("settings.notifications.turnCompletion"),
              t("settings.notifications.permission"),
              t("settings.notifications.question"),
              "notification",
              "通知",
              "语言",
              "language",
              "轮次",
              "cache break",
              "prompt cache",
              "cache",
              "billing",
              "计费",
            ],
          },
          {
            id: "general",
            label: t("settings.general"),
            icon: Monitor,
            keywords: [t("settings.theme"), t("settings.fonts"), "code"],
          },
          {
            id: "personalization",
            label: t("settings.personalization"),
            icon: SlidersHorizontal,
            keywords: [t("settings.personalization.rules"), "rules", "prompt", "claude", "codex"],
          },
          {
            id: "storage",
            label: t("settings.storage"),
            icon: HardDrive,
            keywords: [
              t("settings.storage.usage"),
              t("settings.storage.cleanup"),
              t("settings.storage.clearOldConversations"),
              "disk",
              "logs",
              "sqlite",
              "存储",
              "清理",
              "retention",
              "old chats",
            ],
          },
          { id: "centerServer", label: t("settings.connection"), icon: Cloud },
          {
            id: "proxy",
            label: t("settings.gateway"),
            icon: Globe2,
            keywords: [
              "gateway",
              "proxy",
              "网关",
              "代理",
              "socks5",
              "http",
              "upgrade",
              "升级",
              "outbound",
              "user-agent",
              "ua",
              "请求头",
            ],
          },
        ],
      },
      {
        label: t("settings.group.models"),
        sections: [
          { id: "providers", label: t("settings.providers"), icon: Settings2 },
          {
            id: "orchestrationComponents",
            label: t("settings.orchestrationComponents"),
            icon: Workflow,
          },
          { id: "defaultAgent", label: t("settings.defaultAgent"), icon: Cpu },
          {
            id: "contextWindow",
            label: t("settings.contextWindow"),
            icon: Gauge,
            keywords: ["context", "tokens", "compact", "上下文", "压缩"],
          },
        ],
      },
      {
        label: t("settings.group.capabilities"),
        sections: [
          { id: "mcp", label: t("settings.mcp.title"), icon: Unplug },
          {
            id: "browser",
            label: t("settings.browser"),
            icon: Globe,
            keywords: [t("settings.browser.agentIntegration"), "browser", "cdp", "agent-browser", "浏览器"],
          },
          {
            id: "computerUse",
            label: t("settings.computerUse"),
            icon: Monitor,
            keywords: [
              t("settings.computerUse.masterTitle"),
              "computer use",
              "open-computer-use",
              "电脑操控",
              "accessibility",
            ],
          },
          {
            id: "imageGeneration",
            label: t("settings.imageGeneration.title"),
            icon: Palette,
            keywords: [
              t("settings.imageGeneration.masterTitle"),
              "creative drawing",
              "OpenAI",
              "Gemini",
              "创意绘画",
            ],
          },
          {
            id: "tts",
            label: t("settings.tts.title"),
            icon: Volume2,
            keywords: ["TTS", "语音", "Gemini", "OpenRouter"],
          },
          { id: "asr", label: t("asr.title"), icon: Mic },
          {
            id: "integratedWebSearch",
            label: t("settings.integratedWebSearch.title"),
            icon: Search,
            keywords: ["web search", "tavily", "brave", "doubao", "deepseek", "网络搜索", "Integrated Web Search"],
          },
        ],
      },
      {
        label: t("settings.group.coding"),
        sections: [
          { id: "agentLibrary", label: t("settings.agentLibrary"), icon: BookOpen },
          { id: "skills", label: t("settings.skills.store"), icon: Sparkles },
          { id: "git", label: "Git", icon: GitBranch },
        ],
      },
    ],
    [t],
  );

  useEffect(() => {
    if (appTheme !== "system") {
      return undefined;
    }
    return subscribeToSystemTheme(() => {
      persistAppTheme("system");
    });
  }, [appTheme]);

  const [workspace, setWorkspace] = useState<WorkspaceInfo>();
  const [projectWorkspace, setProjectWorkspace] = useState<WorkspaceInfo>();
  const [selectedProjectPath, setSelectedProjectPath] = useState<string>();
  const [collapsedProjectPaths, setCollapsedProjectPaths] = useState<Set<string>>(() => new Set());
  const [expandedProjectThreadPaths, setExpandedProjectThreadPaths] = useState<Set<string>>(() => new Set());
  const [hiddenProjectPaths, setHiddenProjectPaths] = useState<Set<string>>(() => new Set());
  const [pinnedProjectPaths, setPinnedProjectPaths] = useState<Set<string>>(() => new Set());
  const [pinnedThreadIds, setPinnedThreadIds] = useState<Set<string>>(() => new Set());
  const [unreadThreadIds, setUnreadThreadIds] = useState<Set<string>>(() => new Set());
  const [recentProjects, setRecentProjects] = useState<RecentProject[]>([]);
  const [customProjectNames, setCustomProjectNames] = useState<Record<string, string>>({});
  const [customProjectSearchTerms, setCustomProjectSearchTerms] =
    useState<ProjectSearchTermIndex>(readStoredProjectSearchTerms);
  const [homeProjectPath, setHomeProjectPath] = useState<string>();
  const [projectOrder, setProjectOrder] = useState<string[]>([]);
  const projectOrderInitializedRef = useRef(false);
  const prevThreadStatusByIdRef = useRef(new Map<string, ThreadStatus>());
  const [selectedThreadId, setSelectedThreadId] = useState<string>();
  const selectedThreadIdRef = useRef<string | undefined>(undefined);
  const [feedThreadId, setFeedThreadId] = useState<string | undefined>(undefined);
  const feedThreadIdRef = useRef<string | undefined>(undefined);
  const pendingFeedThreadSwitchFrameRef = useRef<number | undefined>(undefined);
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [titleGeneratingThreadIds, setTitleGeneratingThreadIds] = useState<Set<string>>(() => new Set());
  const [settings, setSettings] = useState<ModelSettingsSnapshot>(emptySettings);
  const [mcpSettings, setMcpSettings] = useState<McpSettingsSnapshot>(emptyMcpSettings);
  const [workflowSettings, setWorkflowSettings] = useState<WorkflowSettingsSnapshot>({
    sessionMode: "agent",
    defaultCoreKind: "claude",
    showBilling: true,
    defaultBashReviewMode: "always",
    contextWindowLimitTokens: 262_144,
    maxOutputLimitTokens: "dynamic",
    followUpDeliveryMode: "steer",
  });
  const [centerServerSettings, setCenterServerSettings] =
    useState<CenterServerSettingsSnapshot>(emptyCenterServerSettings);
  const centerServerSyncVisible = useMemo(() => {
    const settings = centerServerSettings.settings;
    return (
      centerServerSettings.status.state === "connected" &&
      (settings.hasDeviceSecret || settings.hasRefreshToken)
    );
  }, [centerServerSettings]);
  const centerServerRegistered =
    centerServerSettings.settings.hasDeviceSecret || centerServerSettings.settings.hasRefreshToken;
  const sidebarCenterDeviceName =
    centerServerSettings.settings.deviceName.trim() || t("settings.center.remoteService");
  const sidebarCenterPresenceDot = sidebarCenterPresenceDotKind(centerServerSettings.status.state);
  const sidebarCenterPresenceLabel =
    centerServerSettings.status.state === "connected"
      ? t("settings.center.online")
      : centerServerSettings.status.state === "connecting"
        ? t("settings.center.reconnecting")
        : t("settings.center.offline");
  const [asrProfiles, setAsrProfiles] = useState<AsrProfilesSnapshot>(emptyAsrProfiles);
  const [asrSettingsLoadError, setAsrSettingsLoadError] = useState<string>();
  const [asrBusy, setAsrBusy] = useState(false);
  const asrBusyRef = useRef(false);

  useEffect(() => {
    if (!window.eco?.onCenterServerStatusChange) {
      return undefined;
    }
    return window.eco.onCenterServerStatusChange((snapshot) => {
      setCenterServerSettings(snapshot);
    });
  }, []);

  // Import a Supabase project from an eco://connect deep link
  // (eco://connect?url=...&token=...). Opens the connection panel where a
  // confirmation dialog is shown.
  useEffect(() => {
    if (!window.eco?.onEcoDeepLinkOpen) {
      return undefined;
    }
    return window.eco.onEcoDeepLinkOpen((rawUrl) => {
      const link = parseEcoConnectDeepLink(rawUrl);
      if (!link) {
        return;
      }
      setEcoConnectLink(link);
      setSettingsSection("centerServer");
      setSettingsOpen(true);
    });
  }, []);
  const [skillsSnapshot, setSkillsSnapshot] = useState<SkillsListResult>();
  const [cursorAgentsSnapshot, setCursorAgentsSnapshot] = useState<CursorAgentsListResult>();
  const [projectMcpSettings, setProjectMcpSettings] = useState<ProjectMcpSettingsSnapshot>();
  const [projectIntegrationsSettings, setProjectIntegrationsSettings] =
    useState<ProjectIntegrationsSettingsSnapshot>();
  const [projectOrchestrationSettings, setProjectOrchestrationSettings] =
    useState<ProjectOrchestrationSettingsSnapshot>();
  const [projectSkillsSettings, setProjectSkillsSettings] = useState<ProjectSkillsSettingsSnapshot>();
  const [proxyBridgeSettings, setProxyBridgeSettings] = useState<ProxyBridgeSettingsSnapshot | null>(null);
  const [integratedWebSearchSettings, setIntegratedWebSearchSettings] =
    useState<IntegratedWebSearchSettingsSnapshot | null>(null);
  const [isSavingProxyBridgeSettings, setIsSavingProxyBridgeSettings] = useState(false);
  const [isSavingIntegratedWebSearchSettings, setIsSavingIntegratedWebSearchSettings] = useState(false);
  const [composerPlusMenuOpen, setComposerPlusMenuOpen] = useState(false);
  const [composerRoutePopoverOpen, setComposerRoutePopoverOpen] = useState(false);
  const [composerRouteAnchor, setComposerRouteAnchor] = useState<"plus" | "model-empty">("plus");
  const [modelsSettingsTab, setModelsSettingsTab] = useState<ModelsSettingsTab>("subagents");
  const [modelsSettingsChatGptAccountId, setModelsSettingsChatGptAccountId] = useState<string>();
  const [pendingCreateMainConfig, setPendingCreateMainConfig] = useState<PendingMainAgentConfigCreateSeed>();
  const composerPlusButtonRef = useRef<HTMLButtonElement>(null);
  const composerModelEmptyTriggerRef = useRef<HTMLButtonElement>(null);
  const composerImageInputRef = useRef<HTMLInputElement>(null);
  const composerAnchorRef = useRef<HTMLDivElement>(null);
  const composerInputOverlaysRef = useRef<HTMLDivElement>(null);
  const [composerInputOverlaysHeight, setComposerInputOverlaysHeight] = useState(0);
  const [composerCursor, setComposerCursor] = useState(0);
  const [composerSkillActiveIndex, setComposerSkillActiveIndex] = useState(0);
  const [isLoadingSkills, setIsLoadingSkills] = useState(false);
  const [skillsLinking, setSkillsLinking] = useState(false);
  const [skillsLinkResult, setSkillsLinkResult] = useState<LinkAgentsSkillsResult>();
  const [prompt, setPrompt] = useState("");
  const [composerRewindTarget, setComposerRewindTarget] = useState<ComposerRewindTarget>();
  const [composerAttachments, setComposerAttachments] = useState<ComposerImageAttachment[]>([]);
  const [composerLightbox, setComposerLightbox] = useState<{
    src: string;
    alt: string;
    label: string;
  } | null>(null);
  const closeComposerLightbox = useCallback(() => setComposerLightbox(null), []);
  const [plannerCapability, setPlannerCapability] = useState<RouteCapabilityHint>();
  const [composerImageNotice, setComposerImageNotice] = useState<string>();
  const [isOpening, setIsOpening] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const [planActionBusy, setPlanActionBusy] = useState(false);
  const [deletingThreadId, setDeletingThreadId] = useState<string>();
  const threadDeleteCommandsRef = useRef(
    new Map<string, { clientCommandId: string; expectedHistoryRevision: number }>(),
  );
  const [pendingPlansByThread, setPendingPlansByThread] = useState<Record<string, ThreadPendingPlan>>({});
  const pendingPlansByThreadRef = useRef<Record<string, ThreadPendingPlan>>({});
  const [planDelegationMessagesByThread, setPlanDelegationMessagesByThread] = useState<
    Record<string, string>
  >({});
  const [approvedPlansByThread, setApprovedPlansByThread] = useState<Record<string, ThreadPendingPlan>>({});
  const [pendingClarificationsByThread, setPendingClarificationsByThread] = useState<
    Record<string, ClarificationRequest>
  >({});
  const [refreshPendingClarificationForThread] = useState(() =>
    createClarificationQueueSync({
      getPending: (threadId) => {
        if (!window.eco) throw new Error("Desktop clarification bridge is unavailable.");
        return window.eco.getPendingClarification(threadId);
      },
      apply: (threadId, request) =>
        setPendingClarificationsByThread((current) => {
          if (current[threadId]?.toolUseId === request?.toolUseId) return current;
          return request ? { ...current, [threadId]: request } : removeRecordKey(current, threadId);
        }),
    }),
  );
  const [clarificationBusy, setClarificationBusy] = useState(false);
  const [pendingBashApprovalsByThread, setPendingBashApprovalsByThread] = useState<
    Record<string, BashApprovalRequest>
  >({});
  const [bashApprovalBusy, setBashApprovalBusy] = useState(false);
  const [followUpsByThread, setFollowUpsByThread] = useState<Record<string, ThreadPendingFollowUp[]>>({});
  const [followUpBusy, setFollowUpBusy] = useState(false);
  const [followUpCancelBusyId, setFollowUpCancelBusyId] = useState<string>();
  const [followUpEscalateBusyId, setFollowUpEscalateBusyId] = useState<string>();
  const [followUpQueuePauseBusy, setFollowUpQueuePauseBusy] = useState(false);
  const followUpQueuePauseRevisionRef = useRef<Record<string, number>>({});
  const [editingFollowUpId, setEditingFollowUpId] = useState<string>();
  const editingFollowUpIdRef = useRef<string | undefined>(undefined);
  const editingFollowUpThreadIdRef = useRef<string | undefined>(undefined);
  const savedComposerBeforeFollowUpEditRef = useRef<ComposerFollowUpEditSnapshot | undefined>(undefined);
  const [isSavingSettings, setIsSavingSettings] = useState(false);
  const {
    showError: showAppMessageError,
    showSuccess: showAppMessageSuccess,
    dismiss: dismissAppMessage,
    state: appMessageState,
  } = useAppMessage();
  const showAppMessageErrorRef = useRef(showAppMessageError);
  showAppMessageErrorRef.current = showAppMessageError;
  // Errors are surfaced only through the app message banner, never inline in the composer.
  const setError = useCallback((message?: string) => {
    if (message) showAppMessageErrorRef.current(message);
  }, []);
  const showAppMessageSuccessRef = useRef(showAppMessageSuccess);
  showAppMessageSuccessRef.current = showAppMessageSuccess;
  const [conversationV2ByThread, setConversationV2ByThread] = useState<
    Record<string, ConversationV2RendererState>
  >({});
  const conversationV2ByThreadRef = useRef(conversationV2ByThread);
  // A stream effect can advance the imperative ref between React renders. Do
  // not let an unrelated render publish an older snapshot back into that ref.
  const renderedConversationV2ByThread = { ...conversationV2ByThread };
  for (const [threadId, state] of Object.entries(conversationV2ByThreadRef.current)) {
    const rendered = renderedConversationV2ByThread[threadId];
    if (rendered && rendered.storeEpoch === state.storeEpoch && rendered.appliedSeq < state.appliedSeq) {
      renderedConversationV2ByThread[threadId] = state;
    }
  }
  conversationV2ByThreadRef.current = renderedConversationV2ByThread;
  const conversationV2PendingEventsRef = useRef(new Map<string, ConversationSyncEffect[]>());
  const conversationV2PendingOverflowRef = useRef(new Set<string>());
  const conversationV2LoadingThreadsRef = useRef(new Set<string>());
  const conversationV2LoadGenerationRef = useRef(new Map<string, number>());
  const conversationV2RecoveryRequestsRef = useRef(new Set<string>());
  const conversationV2RecoveryInFlightRef = useRef(new Set<string>());
  const conversationV2RenderPendingRef = useRef(new Map<string, ConversationV2RendererState>());
  const conversationV2RenderFramesRef = useRef(new Map<string, number>());
  const conversationV2RenderUrgentRef = useRef(new Set<string>());
  // Live streams can deliver hundreds of sync effects per second. Keep the
  // durable cursor in the imperative ref, but apply short bounded batches. The
  // streaming Markdown pacer fills the gaps between these commits, so users
  // see a continuous reveal without making React parse every provider delta.
  const conversationV2LiveEffectsRef = useRef(new Map<string, ConversationSyncEffect[]>());
  const conversationV2LiveFlushTimersRef = useRef(new Map<string, number>());
  const scheduleConversationV2Render = useCallback(
    (threadId: string, state: ConversationV2RendererState, urgent = false) => {
      conversationV2RenderPendingRef.current.set(threadId, state);
      if (urgent) conversationV2RenderUrgentRef.current.add(threadId);
      if (conversationV2RenderFramesRef.current.has(threadId)) {
        return;
      }
      const frame = window.requestAnimationFrame(() => {
        conversationV2RenderFramesRef.current.delete(threadId);
        const pending = conversationV2RenderPendingRef.current.get(threadId);
        if (!pending) {
          return;
        }
        conversationV2RenderPendingRef.current.delete(threadId);
        const publish = () => {
          setConversationV2ByThread((current) => {
            const latest = current[threadId];
            if (
              !latest ||
              latest.storeEpoch !== pending.storeEpoch ||
              latest.appliedSeq >= pending.appliedSeq
            ) {
              return current;
            }
            return { ...current, [threadId]: pending };
          });
        };
        if (conversationV2RenderUrgentRef.current.delete(threadId)) publish();
        else startTransition(publish);
      });
      conversationV2RenderFramesRef.current.set(threadId, frame);
    },
    [],
  );
  const scheduleConversationV2LiveFlush = useCallback(
    (threadId: string, immediate = false) => {
      const pendingTimer = conversationV2LiveFlushTimersRef.current.get(threadId);
      if (pendingTimer !== undefined) {
        if (!immediate) return;
        // A user message can arrive while a stream batch is waiting. Do not
        // let that older timer delay the prompt acknowledgement.
        window.clearTimeout(pendingTimer);
        conversationV2LiveFlushTimersRef.current.delete(threadId);
      }
      const pendingEffects = conversationV2LiveEffectsRef.current.get(threadId)?.length ?? 0;
      const delayMs = immediate
        ? 0
        : pendingEffects >= 96
          ? CONVERSATION_V2_LIVE_FLUSH_BACKPRESSURE_MS
          : CONVERSATION_V2_LIVE_FLUSH_TARGET_MS;
      const timer = window.setTimeout(() => {
        conversationV2LiveFlushTimersRef.current.delete(threadId);
        const effects = conversationV2LiveEffectsRef.current.get(threadId);
        if (!effects || effects.length === 0) return;
        conversationV2LiveEffectsRef.current.delete(threadId);
        const existing = conversationV2ByThreadRef.current[threadId];
        if (!existing) {
          if (threadId === selectedThreadIdRef.current) {
            for (const effect of effects) bufferConversationV2Event(threadId, effect);
          }
          return;
        }
        try {
          const appliedState = applyConversationV2Effects(existing, effects);
          conversationV2ByThreadRef.current = {
            ...conversationV2ByThreadRef.current,
            [threadId]: appliedState,
          };
          scheduleConversationV2Render(
            threadId,
            appliedState,
            effects.some((entry) => isConversationV2InteractionEffect(entry.effect)),
          );
          refreshConversationV2ProjectionExtras(threadId, {
            force: effects.some((entry) => isConversationV2ProjectionRefreshEffect(entry.effect)),
          });
        } catch (error) {
          console.warn("[eco] conversation V2 live batch deferred:", error);
          if (threadId === selectedThreadIdRef.current) {
            for (const effect of effects) bufferConversationV2Event(threadId, effect);
          }
        }
      }, delayMs);
      conversationV2LiveFlushTimersRef.current.set(threadId, timer);
    },
    [scheduleConversationV2Render],
  );
  const conversationV2DuplicateVerificationInFlightRef = useRef(new Set<string>());
  const conversationV2ProjectionExtrasInFlightRef = useRef(new Set<string>());
  const conversationV2ProjectionExtrasPendingRef = useRef(new Set<string>());
  const conversationV2ProjectionExtrasNextAllowedRef = useRef(new Map<string, number>());
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const readSnapshot = () =>
      Object.fromEntries(
        Object.entries(conversationV2ByThreadRef.current).map(([threadId, state]) => [
          threadId,
          {
            storeEpoch: state.storeEpoch,
            appliedSeq: state.appliedSeq,
            historyRevision: state.historyRevision,
            messageCount: state.messages.size,
            runCount: state.runs.size,
            toolCount: state.tools.size,
            effectHashCount: state.effectHashes.size,
            bufferedEffectSeqs: (conversationV2PendingEventsRef.current.get(threadId) ?? []).map(
              (effect) => effect.seq,
            ),
            loading: conversationV2LoadingThreadsRef.current.has(threadId),
            recoveryRequested: conversationV2RecoveryRequestsRef.current.has(threadId),
            recoveryInFlight: conversationV2RecoveryInFlightRef.current.has(threadId),
          },
        ]),
      );
    window.__ecoConversationV2RendererSnapshot = readSnapshot;
    return () => {
      if (window.__ecoConversationV2RendererSnapshot === readSnapshot) {
        delete window.__ecoConversationV2RendererSnapshot;
      }
    };
  }, []);
  const [conversationV2RecoveryVersion, setConversationV2RecoveryVersion] = useState(0);
  const queueConversationV2Recovery = useCallback((threadId: string) => {
    if (conversationV2RecoveryRequestsRef.current.has(threadId)) {
      return;
    }
    conversationV2RecoveryRequestsRef.current.add(threadId);
    setConversationV2RecoveryVersion((version) => version + 1);
  }, []);
  const bufferConversationV2Event = useCallback(
    (threadId: string, effect: ConversationSyncEffect) => {
      const pending = conversationV2PendingEventsRef.current.get(threadId) ?? [];
      if (pending.length < CONVERSATION_V2_PENDING_EVENT_LIMIT) {
        pending.push(effect);
        conversationV2PendingEventsRef.current.set(threadId, pending);
      } else {
        conversationV2PendingOverflowRef.current.add(threadId);
      }
      if (!conversationV2LoadingThreadsRef.current.has(threadId)) {
        queueConversationV2Recovery(threadId);
      }
    },
    [queueConversationV2Recovery],
  );
  const nextConversationV2LoadGeneration = useCallback((threadId: string) => {
    const next = (conversationV2LoadGenerationRef.current.get(threadId) ?? 0) + 1;
    conversationV2LoadGenerationRef.current.set(threadId, next);
    return next;
  }, []);
  const mergeConversationV2LoadedState = useCallback(
    (threadId: string, recovered: ConversationV2RendererState): boolean => {
      const latest = conversationV2ByThreadRef.current[threadId];
      const base =
        latest && latest.storeEpoch === recovered.storeEpoch && latest.appliedSeq > recovered.appliedSeq
          ? latest
          : recovered;
      const pending = conversationV2PendingEventsRef.current.get(threadId) ?? [];
      let merged = base;
      try {
        merged = applyConversationV2Effects(
          merged,
          [...pending].sort((left, right) => left.seq - right.seq),
        );
      } catch (error) {
        console.warn("[eco] conversation V2 renderer buffered effect deferred:", error);
        queueConversationV2Recovery(threadId);
        return false;
      }
      setConversationV2ByThread((current) => {
        const currentState = current[threadId];
        if (
          currentState &&
          currentState.storeEpoch === merged.storeEpoch &&
          currentState.appliedSeq > merged.appliedSeq
        ) {
          return current;
        }
        return { ...current, [threadId]: merged };
      });
      // IPC can deliver several committed effects in the same macrotask. React has not
      // rendered the first setState yet when the next notification arrives, so the ref
      // must advance synchronously or the second effect is folded against a stale seq
      // and is incorrectly reported as a gap.
      const currentRefState = conversationV2ByThreadRef.current[threadId];
      if (
        !currentRefState ||
        currentRefState.storeEpoch !== merged.storeEpoch ||
        currentRefState.appliedSeq <= merged.appliedSeq
      ) {
        conversationV2ByThreadRef.current = {
          ...conversationV2ByThreadRef.current,
          [threadId]: merged,
        };
      }
      const retained = pending.filter((effect) => effect.seq > merged.appliedSeq);
      if (retained.length > 0) {
        conversationV2PendingEventsRef.current.set(threadId, retained);
      } else {
        conversationV2PendingEventsRef.current.delete(threadId);
      }
      return conversationV2PendingOverflowRef.current.delete(threadId) || retained.length > 0;
    },
    [queueConversationV2Recovery],
  );
  /**
   * Refresh the mutable V2 panel facts. Normally effect-driven and throttled: they ride on the
   * event stream, and `getConversationV2ProjectionExtras` re-derives request spans on every call,
   * so paying for it per streamed token would be waste.
   *
   * `force` also carries thinking block starts and first content. Empty starts create no
   * message, so the dedicated V2 notice wakes this path and a busy fetch queues the update.
   * While the model writes a
   * tool call's arguments, *nothing* happens on the wire until the arguments are complete. Relying
   * on the next effect-driven refresh (up to a second away, and none at all if the throttle ate
   * the call the fact itself triggered) is what left the Feed showing a still timeline for the
   * whole write — measured at 12–17s on this endpoint.
   */
  const refreshConversationV2ProjectionExtras = useCallback(
    (threadId: string, options?: { force?: boolean }): void => {
      const api = window.eco;
      const current = conversationV2ByThreadRef.current[threadId];
      const now = Date.now();
      if (options?.force && conversationV2ProjectionExtrasInFlightRef.current.has(threadId)) {
        conversationV2ProjectionExtrasPendingRef.current.add(threadId);
        return;
      }
      if (
        !current ||
        !api ||
        !shouldRefreshConversationV2ProjectionExtras({
          hasThreadState: true,
          hasProjectionApi: typeof api.conversationV2Projection === "function",
          inFlight: conversationV2ProjectionExtrasInFlightRef.current.has(threadId),
          now,
          nextAllowed: conversationV2ProjectionExtrasNextAllowedRef.current.get(threadId) ?? 0,
          ...(options?.force !== undefined ? { force: options.force } : {}),
        })
      ) {
        return;
      }
      conversationV2ProjectionExtrasNextAllowedRef.current.set(threadId, now + 1000);
      conversationV2ProjectionExtrasInFlightRef.current.add(threadId);
      void api
        .conversationV2Projection(threadId)
        .then((extras) => {
          const latest = conversationV2ByThreadRef.current[threadId];
          if (!latest || latest.storeEpoch !== current.storeEpoch) {
            return;
          }
          const next = installConversationV2ProjectionExtras(latest, extras);
          startTransition(() => {
            setConversationV2ByThread((states) => {
              const state = states[threadId];
              if (!state || state.storeEpoch !== next.storeEpoch || state.appliedSeq !== next.appliedSeq) {
                return state && state.appliedSeq > next.appliedSeq ? states : { ...states, [threadId]: next };
              }
              return { ...states, [threadId]: next };
            });
          });
        })
        .catch((error: unknown) => {
          console.warn("[eco] conversation V2 projection extras refresh failed:", error);
        })
        .finally(() => {
          conversationV2ProjectionExtrasInFlightRef.current.delete(threadId);
          if (conversationV2ProjectionExtrasPendingRef.current.delete(threadId)) {
            refreshConversationV2ProjectionExtras(threadId, { force: true });
          }
        });
    },
    [],
  );
  const recentlyViewedThreadIdsRef = useRef<string[]>([]);
  const projectionEvictTimersRef = useRef(new Map<string, number>());
  const threadsRef = useRef(threads);
  threadsRef.current = threads;
  const syncActivityFeedBootRef = useRef<() => void>(() => {});
  const tryAdvanceActivityFeedBootRef = useRef<() => void>(() => {});
  const [feedProjectionSettledByThread, setFeedProjectionSettledByThread] = useState<Record<string, boolean>>(
    {},
  );
  const feedProjectionSettledByThreadRef = useRef(feedProjectionSettledByThread);
  feedProjectionSettledByThreadRef.current = feedProjectionSettledByThread;
  const [activityFeedBootReady, setActivityFeedBootReady] = useState(true);
  const activityFeedBootReadyRef = useRef(true);
  const activityFeedBootThreadIdRef = useRef<string | undefined>(undefined);
  const activityFeedRevealedThreadIdsRef = useRef(new Set<string>());

  const cancelPendingFeedThreadSwitch = useCallback(() => {
    if (pendingFeedThreadSwitchFrameRef.current !== undefined) {
      window.cancelAnimationFrame(pendingFeedThreadSwitchFrameRef.current);
      pendingFeedThreadSwitchFrameRef.current = undefined;
    }
  }, []);

  const syncActivityFeedBootForThread = useCallback((threadId: string | undefined) => {
    activityFeedBootThreadIdRef.current = threadId;
    const nextReady = !threadId || activityFeedRevealedThreadIdsRef.current.has(threadId);
    if (activityFeedBootReadyRef.current === nextReady) {
      return;
    }
    activityFeedBootReadyRef.current = nextReady;
    setActivityFeedBootReady(nextReady);
  }, []);

  const beginActivityFeedBoot = useCallback((threadId: string) => {
    activityFeedBootThreadIdRef.current = threadId;
    if (activityFeedBootReadyRef.current) {
      activityFeedBootReadyRef.current = false;
      setActivityFeedBootReady(false);
    }
  }, []);

  const finishActivityFeedBoot = useCallback((threadId: string) => {
    if (activityFeedBootThreadIdRef.current !== threadId || activityFeedBootReadyRef.current) {
      return;
    }
    activityFeedRevealedThreadIdsRef.current.add(threadId);
    activityFeedBootReadyRef.current = true;
    startTransition(() => {
      setActivityFeedBootReady(true);
    });
  }, []);

  const applyFeedThreadSelection = useCallback(
    (nextThreadId: string | undefined, options?: { immediate?: boolean }) => {
      cancelPendingFeedThreadSwitch();
      const previousFeedThreadId = feedThreadIdRef.current;
      if (nextThreadId === previousFeedThreadId) {
        syncActivityFeedBootForThread(nextThreadId);
        return;
      }

      const needsBoot = Boolean(nextThreadId && !options?.immediate);
      if (!needsBoot || !nextThreadId) {
        feedThreadIdRef.current = nextThreadId;
        setFeedThreadId(nextThreadId);
        syncActivityFeedBootForThread(nextThreadId);
        return;
      }

      const bootThreadId = nextThreadId;
      beginActivityFeedBoot(bootThreadId);
      pendingFeedThreadSwitchFrameRef.current = window.requestAnimationFrame(() => {
        pendingFeedThreadSwitchFrameRef.current = undefined;
        if (selectedThreadIdRef.current !== bootThreadId) {
          return;
        }
        feedThreadIdRef.current = bootThreadId;
        setFeedThreadId(bootThreadId);
        tryAdvanceActivityFeedBootRef.current();
      });
    },
    [beginActivityFeedBoot, cancelPendingFeedThreadSwitch, syncActivityFeedBootForThread],
  );

  const commitSidebarThreadSelection = useCallback(
    (nextThreadId: string | undefined, options?: { immediate?: boolean }) => {
      const needsBoot = Boolean(
        nextThreadId && nextThreadId !== feedThreadIdRef.current && !options?.immediate,
      );
      if (needsBoot && nextThreadId) {
        const bootThreadId = nextThreadId;
        flushSync(() => {
          selectedThreadIdRef.current = bootThreadId;
          setSelectedThreadId(bootThreadId);
          beginActivityFeedBoot(bootThreadId);
        });
        return;
      }
      selectedThreadIdRef.current = nextThreadId;
      setSelectedThreadId(nextThreadId);
    },
    [beginActivityFeedBoot],
  );

  /** Landing → new thread: keep the same window (no boot splash / feed gate). */
  const adoptLandingThreadSelection = useCallback(
    (threadId: string) => {
      activityFeedRevealedThreadIdsRef.current.add(threadId);
      commitSidebarThreadSelection(threadId, { immediate: true });
      applyFeedThreadSelection(threadId, { immediate: true });
    },
    [applyFeedThreadSelection, commitSidebarThreadSelection],
  );
  const [cancelBusy, setCancelBusy] = useState(false);
  const [composerRuntimeConfig, setComposerRuntimeConfig] = useState<ThreadRuntimeConfig | null>(null);
  const [newThreadCoreKind, setNewThreadCoreKind] = useState<CoreKind>("claude");
  const [coreAvailability, setCoreAvailability] = useState<CoreAvailabilitySnapshot>();
  const [cursorProbeLoading, setCursorProbeLoading] = useState(false);
  const [acpEnableInFlight, setAcpEnableInFlight] = useState(false);
  const [cursorModels, setCursorModels] = useState<CursorModelOption[]>([]);
  const [cursorModelsLoading, setCursorModelsLoading] = useState(false);
  const [cursorModelsError, setCursorModelsError] = useState<string>();
  const [composerCandidateModels, setComposerCandidateModels] = useState<CandidateModelView[]>([]);
  const [composerModelsLoading, setComposerModelsLoading] = useState(false);
  const [composerModelsError, setComposerModelsError] = useState<string>();
  const [composerModelsRefreshNonce, setComposerModelsRefreshNonce] = useState(0);
  const [gitStatusByWorkspace, setGitStatusByWorkspace] = useState<WorkspaceGitStatusCache>({});
  const gitStatusByWorkspaceRef = useRef<WorkspaceGitStatusCache>({});
  const [gitStatusBusy, setGitStatusBusy] = useState(false);
  const [gitStatusLoadingByWorkspace, setGitStatusLoadingByWorkspace] = useState<Record<string, boolean>>({});
  const gitStatusRequestRef = useRef(new Map<string, number>());
  const [gitSettings, setGitSettings] = useState<GitSettingsSnapshot>(emptyGitSettings);
  const [personalizationSettings, setPersonalizationSettings] = useState<PersonalizationSettingsSnapshot>(
    emptyPersonalizationSettings,
  );
  const [browserSettings, setBrowserSettings] = useState<BrowserSettingsSnapshot>({
    agentIntegrationEnabled: false,
    openApprovalMode: "always_allow",
  });
  const [computerUseSettings, setComputerUseSettings] = useState<ComputerUseSettingsSnapshot>({
    agentIntegrationEnabled: false,
    actionApprovalMode: "always_ask",
  });
  const [ttsSettings, setTtsSettings] = useState<TtsSettingsSnapshot>({
    enabled: false,
    activeProfileId: "",
    profiles: [],
    apiKeyEncryptionAvailable: false,
  });
  const [ttsArtifactsByThread, setTtsArtifactsByThread] = useState<Record<string, TtsArtifact[]>>({});
  const [imageGenerationSettings, setImageGenerationSettings] = useState<ImageGenerationSettingsSnapshot>(
    emptyImageGenerationSettings,
  );
  const [integrationAvailability, setIntegrationAvailability] = useState<IntegrationAvailabilitySnapshot>(
    emptyIntegrationAvailability,
  );
  const [webChatList, setWebChatList] = useState<WebChatListView>(() =>
    mergeWebChatList(defaultWebChatListSnapshot()),
  );
  const [webChatListOpen, setWebChatListOpen] = useState(false);
  const webChatListAnchorRef = useRef<HTMLButtonElement>(null);
  const [runningResourcesOpen, setRunningResourcesOpen] = useState(false);
  const runningResourcesAnchorRef = useRef<HTMLButtonElement>(null);
  const [sshBookmarks, setSshBookmarks] = useState<SshBookmarkView[]>([]);
  const [notificationSettings, setNotificationSettings] = useState<NotificationSettingsSnapshot>(
    defaultNotificationSettings(),
  );
  const [scriptsDialogOpen, setScriptsDialogOpen] = useState(false);
  const [packageScriptArgsRevision, setPackageScriptArgsRevision] = useState(0);
  const [packageScripts, setPackageScripts] = useState<PackageScriptsListResult>();
  const [storedTerminalByProject] = useState<TerminalWorkspaceState>(() => readTerminalWorkspaceState());
  const [terminalByProject, setTerminalByProject] = useState<TerminalWorkspaceState>({});
  const [workspacePanelManualOverride, setWorkspacePanelManualOverride] = useState<{
    layoutMode: ActivityWorkspaceLayoutMode;
    projectPath: string | undefined;
    threadId: string | undefined;
    open: boolean;
  }>();
  const [backgroundTerminalTasks, setBackgroundTerminalTasks] = useState<BackgroundTerminalTask[]>([]);
  const [codexBackgroundTerminals, setCodexBackgroundTerminals] = useState<CodexBackgroundTerminal[]>([]);
  const [codexBackgroundTerminalError, setCodexBackgroundTerminalError] = useState<string>();
  const [claudeBackgroundTasks, setClaudeBackgroundTasks] = useState<ClaudeBackgroundTask[]>([]);
  const [claudeBackgroundTaskError, setClaudeBackgroundTaskError] = useState<string>();
  const [imageArtifactsByThread, setImageArtifactsByThread] = useState<
    Record<string, ImageGenerationArtifact[]>
  >({});
  const [imageDisplayArtifactsByThread, setImageDisplayArtifactsByThread] = useState<
    Record<string, ImageDisplayArtifact[]>
  >({});
  const imageArtifactsByThreadRef = useRef(imageArtifactsByThread);
  imageArtifactsByThreadRef.current = imageArtifactsByThread;
  const imageDisplayArtifactsByThreadRef = useRef(imageDisplayArtifactsByThread);
  imageDisplayArtifactsByThreadRef.current = imageDisplayArtifactsByThread;
  const [imageGalleryQueue, setImageGalleryQueue] = useState<ImageGalleryQueueItem[]>([]);
  const [imageGalleryOpen, setImageGalleryOpen] = useState(false);
  /** 已入队过的画廊项（按 key 去重，保证每次工具调用只触发一次悬浮窗）。 */
  const imageGalleryEnqueuedRef = useRef<Set<string>>(new Set());
  const activeThreadIdRef = useRef<string | undefined>(undefined);

  const enqueueImageGalleryItems = useCallback((items: ImageGalleryQueueItem[]) => {
    const fresh = items.filter((item) => !imageGalleryEnqueuedRef.current.has(item.key));
    if (fresh.length === 0) {
      return;
    }
    for (const item of fresh) {
      imageGalleryEnqueuedRef.current.add(item.key);
    }
    setImageGalleryQueue((current) => appendImageGalleryItems(current, fresh));
    setImageGalleryOpen(true);
  }, []);

  const advanceImageGallery = useCallback((item: ImageGalleryQueueItem) => {
    setImageGalleryQueue((current) => advanceImageGalleryQueue(current, item.key));
  }, []);

  const closeImageGallery = useCallback(() => {
    setImageGalleryOpen(false);
    setImageGalleryQueue([]);
  }, []);
  const [htmlHostArtifactsByThread, setHtmlHostArtifactsByThread] = useState<
    Record<string, HtmlHostArtifact[]>
  >({});
  const htmlHostArtifactsByThreadRef = useRef(htmlHostArtifactsByThread);
  htmlHostArtifactsByThreadRef.current = htmlHostArtifactsByThread;
  const [selectedSubagentAgentId, setSelectedSubagentAgentId] = useState<string>();
  const [taskPanelActiveTab, setTaskPanelActiveTab] = useState<TaskPanelActiveTab>(TASK_PANEL_HOME_TAB_ID);
  const [openTaskPanelTabIds, setOpenTaskPanelTabIds] = useState<TaskPanelActiveTab[]>([]);
  const [taskDrawerOpen, setTaskDrawerOpen] = useState(false);
  const [taskPanelLayoutPresent, setTaskPanelLayoutPresent] = useState(false);
  const [taskPanelExiting, setTaskPanelExiting] = useState(false);
  const [taskPanelFullscreen, setTaskPanelFullscreen] = useState(false);
  const [taskPanelWidth, setTaskPanelWidth] = useState(readTaskPanelWidth);
  const [activityWorkspaceLayoutMode, setActivityWorkspaceLayoutMode] =
    useState<ActivityWorkspaceLayoutMode>("feed-only");
  /** Measured left gutter beside the feed stack — drives message-nav, not program mode. */
  const [feedLeftGutterPx, setFeedLeftGutterPx] = useState(0);
  const [activityMessageNavSpaceVisible, setActivityMessageNavSpaceVisible] = useState(false);
  const prefersReducedMotion = useReducedMotion();
  const taskPanelAnimationControls = useAnimationControls();
  const taskPanelResizeRef = useRef<{ startX: number; startWidth: number } | undefined>(undefined);
  const mainPaneRef = useRef<HTMLDivElement>(null);
  const pendingTaskPanelTabCloseRef = useRef<TaskPanelActiveTab | undefined>(undefined);
  const taskPanelCloseRequestRef = useRef(0);
  const taskPanelClosingRef = useRef(false);
  const taskDrawerOpenRef = useRef(false);
  taskDrawerOpenRef.current = taskDrawerOpen;
  const taskPanelActiveTabRef = useRef(taskPanelActiveTab);
  taskPanelActiveTabRef.current = taskPanelActiveTab;
  /** Last `activateBrowserId` already turned into a tab switch — main keeps the field set. */
  const handledActivateBrowserIdRef = useRef<string | undefined>(undefined);
  /**
   * Last `revealBrowserId` main advertised. Main keeps it set for the whole life of that
   * page, so every later emit repeats the same value; only a new or changed id is a fresh
   * "show this page" request.
   */
  const lastRevealBrowserIdRef = useRef<string | undefined>(undefined);
  /** Home tools replace their blank tab immediately while its guest closes asynchronously. */
  const replacingBrowserHomeIdsRef = useRef(new Set<string>());
  const pendingNewTabNavigationsRef = useRef(new Set<string>());
  const taskPanelUiByThreadRef = useRef<Record<string, TaskPanelSessionUiState>>({});
  const taskPanelUiThreadIdRef = useRef<string | undefined>(undefined);
  /** After startThread from landing, keep live panel tabs (browsers opened before first send). */
  const adoptLandingTaskPanelUiRef = useRef(false);
  const liveTaskPanelUiRef = useRef<TaskPanelSessionUiState>(emptyTaskPanelSessionUiState());
  const refreshReviewDiffRef = useRef<() => Promise<void>>(async () => undefined);
  const [reviewDiff, setReviewDiff] = useState<WorkspaceDiffResult>();
  const [reviewDiffLoading, setReviewDiffLoading] = useState(false);
  const [reviewDiffError, setReviewDiffError] = useState<string>();
  const [reviewSelectedPath, setReviewSelectedPath] = useState<string>();
  const [reviewDiffRevision, setReviewDiffRevision] = useState(0);
  const reviewDiffRequestRef = useRef(0);
  const reviewDiffRef = useRef<WorkspaceDiffResult | undefined>(undefined);
  /** Set by a manual refresh; the next successful load drops cached per-file diffs. */
  const reviewDiffManualRefreshRef = useRef(false);
  reviewDiffRef.current = reviewDiff;
  const [fileTarget, setFileTarget] = useState<
    (WorkspaceFileReference & { requestId: number; restricted?: boolean }) | undefined
  >();
  liveTaskPanelUiRef.current = captureTaskPanelSessionUiState({
    open: taskDrawerOpen && !taskPanelExiting && !taskPanelClosingRef.current,
    activeTab: taskPanelActiveTab,
    openTabIds: openTaskPanelTabIds,
    fullscreen: taskPanelFullscreen,
    ...(selectedSubagentAgentId ? { selectedSubagentAgentId } : {}),
    ...(fileTarget ? { fileTarget } : {}),
  });
  const fileReferenceRequestIdRef = useRef(0);
  const [scriptsBusy, setScriptsBusy] = useState(false);
  const [injectedTerminalSessionId, setInjectedTerminalSessionId] = useState<string | null>(null);
  const packageScriptByTerminalSessionRef = useRef(
    new Map<string, { command: string; projectName: string }>(),
  );
  const packageScriptTaskByTerminalSessionRef = useRef(new Map<string, string>());
  const settledPackageScriptTerminalSessionRef = useRef(new Map<string, boolean>());
  const [terminalSessionPresentations, setTerminalSessionPresentations] = useState<
    Record<string, TerminalSessionPresentation>
  >({});
  const [terminalLifecycleEpoch, setTerminalLifecycleEpoch] = useState(0);
  const [routePricingHints, setRoutePricingHints] = useState<RoutePricingHint[]>([]);

  const refreshCoreAvailability = useCallback(async (options?: { reportError?: boolean }) => {
    if (!window.eco?.getCoreAvailability) {
      return undefined;
    }
    setCursorProbeLoading(true);
    try {
      const availability = await window.eco.getCoreAvailability();
      setCoreAvailability(availability);
      // Main demotes defaultCoreKind away from acp when Cursor CLI probe fails.
      if (!availability.cursor.available && window.eco.getWorkflowSettings) {
        const workflow = await window.eco.getWorkflowSettings();
        setWorkflowSettings(workflow);
      }
      return availability;
    } catch (error) {
      console.error("Failed to probe Core availability", error);
      if (options?.reportError) {
        setError(errorMessage(error));
      }
      return undefined;
    } finally {
      setCursorProbeLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshCoreAvailability();
  }, [refreshCoreAvailability]);

  const refreshCursorModels = useCallback(() => {
    if (!window.eco?.listCursorModels) return;
    setCursorModelsLoading(true);
    setCursorModelsError(undefined);
    void window.eco
      .listCursorModels()
      .then(setCursorModels)
      .catch((error) => setCursorModelsError(errorMessage(error)))
      .finally(() => setCursorModelsLoading(false));
  }, []);

  useEffect(() => {
    selectedThreadIdRef.current = selectedThreadId;
  }, [selectedThreadId]);

  useEffect(() => {
    return () => {
      if (pendingFeedThreadSwitchFrameRef.current !== undefined) {
        window.cancelAnimationFrame(pendingFeedThreadSwitchFrameRef.current);
      }
    };
  }, []);

  useEffect(
    () =>
      subscribeToWindowFocus((focused) => {
        if (!focused) {
          return;
        }
        const activeThreadId = selectedThreadIdRef.current;
        if (!activeThreadId) {
          return;
        }
        setUnreadThreadIds((current) => {
          if (!current.has(activeThreadId)) {
            return current;
          }
          const next = new Set(current);
          next.delete(activeThreadId);
          window.localStorage.setItem(unreadThreadsStorageKey, JSON.stringify([...next]));
          return next;
        });
      }),
    [],
  );

  useEffect(() => {
    if (!window.eco) {
      setError("Electron preload API is unavailable. Run the desktop app with bun run dev:electron.");
      return undefined;
    }
    const eco = window.eco;

    const initializationPromise = Promise.all([
      eco.getCurrentWorkspace(),
      eco.getHomeProjectPath(),
      eco.listThreads(),
      eco.getModelSettings(),
      eco.getMcpSettings(),
      eco.getWorkflowSettings(),
      eco.getCenterServerSettings(),
      eco.getProxyBridgeSettings(),
      eco.getIntegratedWebSearchSettings(),
    ]).then(
      ([
        currentWorkspace,
        resolvedHomeProjectPath,
        currentThreads,
        modelSettings,
        mcp,
        workflow,
        centerServer,
        proxyBridge,
        integratedWebSearch,
      ]) => {
        setHomeProjectPath(resolvedHomeProjectPath);
        setWorkspace(currentWorkspace);
        if (currentWorkspace) {
          setSelectedProjectPath(currentWorkspace.path);
          registerImportedProject(currentWorkspace.path, resolvedHomeProjectPath);
        }
        setThreads(currentThreads);
        setSettings(modelSettings);
        setMcpSettings(mcp);
        setWorkflowSettings(workflow);
        setNewThreadCoreKind(workflow.defaultCoreKind ?? "claude");
        setCenterServerSettings(centerServer);
        setProxyBridgeSettings(proxyBridge);
        setIntegratedWebSearchSettings(integratedWebSearch);
      },
    );

    let rendererReadyFrame: number | undefined;
    let rendererReadySecondFrame: number | undefined;
    const notifyRendererReady = () => {
      rendererReadyFrame = window.requestAnimationFrame(() => {
        rendererReadySecondFrame = window.requestAnimationFrame(() => {
          void eco.markRendererReady().catch((error: unknown) => {
            console.error("[eco] failed to reveal native window controls:", error);
          });
        });
      });
    };
    const initializationResult = initializationPromise.then(
      () => true,
      (caught: unknown) => {
        setError(errorMessage(caught));
        console.error("[eco] renderer initialization failed:", caught);
        return false;
      },
    );
    void initializationResult.then(() => notifyRendererReady());

    let threadListRefreshTimer: number | undefined;
    const ensureThreadListed = (threadId: string) => {
      setThreads((current) => {
        if (current.some((thread) => thread.id === threadId)) {
          return current;
        }
        if (threadListRefreshTimer !== undefined) {
          window.clearTimeout(threadListRefreshTimer);
        }
        threadListRefreshTimer = window.setTimeout(() => {
          threadListRefreshTimer = undefined;
          void window.eco!.listThreads().then(setThreads);
        }, 120);
        return current;
      });
    };
    const openPendingNotificationThread = async (requestedThreadId?: string) => {
      const pendingThreadId = await eco.consumePendingThreadOpen();
      const threadId = requestedThreadId?.trim() || pendingThreadId;
      if (!threadId) {
        return;
      }
      const thread = await eco.getThread(threadId);
      if (!thread) {
        return;
      }
      setThreads((current) => {
        const existingIndex = current.findIndex((item) => item.id === thread.id);
        if (existingIndex < 0) {
          return [thread, ...current];
        }
        const next = [...current];
        next[existingIndex] = thread;
        return next;
      });
      setUnreadThreadIds((current) => {
        if (!current.has(thread.id)) {
          return current;
        }
        const next = new Set(current);
        next.delete(thread.id);
        window.localStorage.setItem(unreadThreadsStorageKey, JSON.stringify([...next]));
        return next;
      });
      commitSidebarThreadSelection(thread.id);
      applyFeedThreadSelection(thread.id);
      setSelectedProjectPath(thread.workspacePath);
      setSettingsOpen(false);
      setComposerRewindTarget(undefined);
      setCollapsedProjectPaths((current) => {
        if (!current.has(thread.workspacePath)) {
          return current;
        }
        const next = new Set(current);
        next.delete(thread.workspacePath);
        window.localStorage.setItem(collapsedProjectsStorageKey, JSON.stringify([...next]));
        return next;
      });
      setExpandedProjectThreadPaths((current) => {
        if (current.has(thread.workspacePath)) {
          return current;
        }
        const next = new Set(current);
        next.add(thread.workspacePath);
        return next;
      });
      setSidebarRevealTarget((current) => ({
        kind: "thread",
        id: thread.id,
        requestId: (current?.requestId ?? 0) + 1,
      }));
    };
    const unsubscribeThreadOpen = window.eco.onThreadOpenRequested((requestedThreadId) => {
      void initializationResult.then((initialized) => {
        if (initialized) {
          openPendingNotificationThread(requestedThreadId);
        }
      });
    });
    void initializationResult.then((initialized) => {
      if (initialized) {
        openPendingNotificationThread();
      }
    });

    const refreshSyncedSettingsFromMain = () => {
      void Promise.all([
        eco.getModelSettings(),
        eco.getMcpSettings(),
        eco.getWorkflowSettings(),
        eco.getProxyBridgeSettings(),
        eco.getImageGenerationSettings?.() ?? Promise.resolve(undefined),
        eco.listAsrProfiles(),
      ])
        .then(([modelSettings, mcp, workflow, proxyBridge, imageGeneration, asrSnapshot]) => {
          setSettings(modelSettings);
          setMcpSettings(mcp);
          setWorkflowSettings(workflow);
          setProxyBridgeSettings(proxyBridge);
          if (imageGeneration) {
            setImageGenerationSettings(imageGeneration);
          }
          setAsrProfiles(asrSnapshot);
          setAsrSettingsLoadError(undefined);
        })
        .catch((caught: unknown) => {
          console.error("[eco] failed to refresh settings after sync:", caught);
        });
    };

    const clarificationNotifications = createClarificationNotifications({
      refreshPending: refreshPendingClarificationForThread,
      notify: (threadId, toolUseId) => {
        ensureThreadListed(threadId);
        reportDesktopNotification(
          eco.showThreadClarificationNotification({
            threadId,
            toolUseId,
            activelyViewed: isThreadActivelyViewed(selectedThreadIdRef.current, threadId, document.hasFocus()),
          }),
          "clarification",
        );
      },
      onError: (error) => setError(errorMessage(error)),
    });

    const handleThreadEvent: Parameters<typeof eco.onThreadEvent>[0] = (event) => {
      const conversationEvent = readConversationV2SyncEvent(event);
      if (conversationEvent) {
        const threadId = conversationEvent.conversationId;
        clarificationNotifications.handleSyncEffect(threadId, conversationEvent.effect.effect);
        const existing = conversationV2ByThreadRef.current[threadId];
        if (!existing || existing.storeEpoch !== conversationEvent.storeEpoch) {
          if (threadId === selectedThreadIdRef.current) {
            bufferConversationV2Event(threadId, conversationEvent.effect);
          }
          return;
        }
        if (
          conversationEvent.effect.seq <= existing.appliedSeq &&
          !existing.effectHashes.has(conversationEvent.effect.seq)
        ) {
          const verificationKey = `${threadId}:${conversationEvent.storeEpoch}:${conversationEvent.effect.seq}`;
          if (!conversationV2DuplicateVerificationInFlightRef.current.has(verificationKey)) {
            conversationV2DuplicateVerificationInFlightRef.current.add(verificationKey);
            void verifyConversationV2DuplicateEffect(threadId, existing, conversationEvent.effect)
              .catch((error: unknown) => {
                console.warn("[eco] conversation V2 duplicate effect verification failed:", error);
                queueConversationV2Recovery(threadId);
              })
              .finally(() => {
                conversationV2DuplicateVerificationInFlightRef.current.delete(verificationKey);
              });
          }
          return;
        }
        const pending = conversationV2LiveEffectsRef.current.get(threadId) ?? [];
        const duplicatePending = pending.find((effect) => effect.seq === conversationEvent.effect.seq);
        if (duplicatePending) {
          // React is intentionally behind the imperative cursor while the
          // 200ms batch is waiting. Treat a repeated IPC notification for a
          // queued sequence as idempotent instead of misclassifying it as a
          // gap and starting recovery.
          if (duplicatePending.effectHash === conversationEvent.effect.effectHash) {
            return;
          }
          console.warn("[eco] conversation V2 pending effect conflict:", conversationEvent.effect.seq);
          if (threadId === selectedThreadIdRef.current) {
            bufferConversationV2Event(threadId, conversationEvent.effect);
          }
          return;
        }
        const lastSeq = pending.length > 0 ? pending[pending.length - 1]!.seq : existing.appliedSeq;
        if (conversationEvent.effect.seq !== lastSeq + 1) {
          // A gap/conflict is recoverable by an authoritative bootstrap and
          // range sync. Flush the already queued contiguous prefix first so
          // the recovery starts from the newest durable cursor we have.
          if (pending.length > 0) {
            conversationV2LiveEffectsRef.current.set(threadId, pending);
            scheduleConversationV2LiveFlush(threadId);
          }
          console.warn("[eco] conversation V2 live effect sequence deferred:", {
            expected: lastSeq + 1,
            received: conversationEvent.effect.seq,
          });
          if (threadId === selectedThreadIdRef.current) {
            bufferConversationV2Event(threadId, conversationEvent.effect);
          }
          return;
        }
        pending.push(conversationEvent.effect);
        conversationV2LiveEffectsRef.current.set(threadId, pending);
        scheduleConversationV2LiveFlush(
          threadId,
          isConversationV2InteractionEffect(conversationEvent.effect.effect),
        );
        return;
      }
      if (!isThreadLiveEvent(event)) {
        return;
      }
      clarificationNotifications.handleLiveEvent(event);
      // The tool-writing fact is the only thing that changes the Feed's request spans without
      // producing events of its own: the model is writing a call's arguments, and nothing else
      // happens on the wire until they are complete. Fetch the derived spans when *it* arrives
      // (and when the call's row lands, or the turn ends, which clear it again) instead of
      // waiting for the next event-driven refresh that this window never produces.
      if (TOOL_WRITING_REFRESH_LIVE_TYPES.has(event.type)) {
        refreshConversationV2ProjectionExtras(event.threadId, { force: true });
      }
      // Main emits settings.updated with threadId "settings" after config pull/push
      // and local settings saves. Ignoring it left the renderer on stale React state
      // while the toast said pull succeeded — disk was updated, UI was not.
      if (event.threadId === "settings" || event.type === "settings.updated") {
        refreshSyncedSettingsFromMain();
        return;
      }

      if (event.type === "thread.deleted") {
        clearThreadClientState(event.threadId);
        conversationV2PendingEventsRef.current.delete(event.threadId);
        conversationV2LiveEffectsRef.current.delete(event.threadId);
        conversationV2ProjectionExtrasNextAllowedRef.current.delete(event.threadId);
        conversationV2ProjectionExtrasPendingRef.current.delete(event.threadId);
        const liveTimer = conversationV2LiveFlushTimersRef.current.get(event.threadId);
        if (liveTimer !== undefined) {
          window.clearTimeout(liveTimer);
          conversationV2LiveFlushTimersRef.current.delete(event.threadId);
        }
        conversationV2PendingOverflowRef.current.delete(event.threadId);
        conversationV2LoadGenerationRef.current.delete(event.threadId);
        conversationV2RecoveryRequestsRef.current.delete(event.threadId);
        conversationV2RecoveryInFlightRef.current.delete(event.threadId);
        conversationV2LoadingThreadsRef.current.delete(event.threadId);
        setConversationV2ByThread((current) => removeRecordKey(current, event.threadId));
        setTitleGeneratingThreadIds((current) => {
          if (!current.has(event.threadId)) {
            return current;
          }
          const next = new Set(current);
          next.delete(event.threadId);
          return next;
        });
        return;
      }
      ensureThreadListed(event.threadId);

      if (
        event.type === "thread.failed" ||
        event.type === "thread.execution_failed" ||
        event.type === "thread.cancelled" ||
        event.type === "thread.idle" ||
        event.type === "thread.blocked" ||
        event.type === "thread.unstarted_turn_discarded"
      ) {
      }

      if (event.type === "thread.unstarted_turn_discarded") {
        if (event.threadId === selectedThreadIdRef.current && event.composerRestore) {
          persistComposerDraftSnapshot(composerDraftsByKeyRef.current, `thread:${event.threadId}`, {
            prompt: event.composerRestore.prompt,
            attachments: fromPromptImageAttachments(event.composerRestore.attachments ?? []),
          });
          setPrompt(event.composerRestore.prompt);
          setComposerAttachments(fromPromptImageAttachments(event.composerRestore.attachments ?? []));
          setComposerRewindTarget(undefined);
          setError(event.message);
        } else if (event.composerRestore) {
          persistComposerDraftSnapshot(composerDraftsByKeyRef.current, `thread:${event.threadId}`, {
            prompt: event.composerRestore.prompt,
            attachments: fromPromptImageAttachments(event.composerRestore.attachments ?? []),
          });
        }
      }

      if (event.threadPrompt !== undefined) {
        const threadPrompt = event.threadPrompt;
        setThreads((current) =>
          current.map((thread) =>
            thread.id === event.threadId
              ? { ...thread, prompt: threadPrompt, updatedAt: new Date().toISOString() }
              : thread,
          ),
        );
      }

      if (event.titleGenerating !== undefined) {
        setTitleGeneratingThreadIds((current) => {
          const next = new Set(current);
          if (event.titleGenerating) {
            next.add(event.threadId);
          } else {
            next.delete(event.threadId);
          }
          return next;
        });
      }

      if (event.title) {
        setThreads((current) =>
          current.map((thread) =>
            thread.id === event.threadId ? { ...thread, title: event.title ?? thread.title } : thread,
          ),
        );
        if (event.type === "thread.title_updated" || event.type === "thread.title_delta") {
          return;
        }
      }

      if (event.type === "thread.title_failed" && event.threadId === selectedThreadIdRef.current) {
        showAppMessageErrorRef.current(t("thread.titleGenerationFailed"));
        return;
      }

      if (event.type === "thread.todos_updated") {
        return;
      }

      if (typeof event.followUpQueuePaused === "boolean") {
        followUpQueuePauseRevisionRef.current[event.threadId] =
          (followUpQueuePauseRevisionRef.current[event.threadId] ?? 0) + 1;
      }

      if (shouldUpdateThreadSummaryFromLiveEvent(event.type)) {
        setThreads((current) =>
          current.map((thread) => {
            if (thread.id !== event.threadId) {
              return thread;
            }
            const { cancelling: _previousCancelling, ...rest } = thread;
            const cancelling = nextThreadCancelling(event, thread);
            return {
              ...rest,
              message: resolveThreadMessageFromLiveEvent(event.type, event.message),
              status: statusFromLiveEvent(event.type, thread.status),
              updatedAt: new Date().toISOString(),
              ...(cancelling ? { cancelling: true } : {}),
              ...(typeof event.followUpQueuePaused === "boolean"
                ? { followUpQueuePaused: event.followUpQueuePaused }
                : {}),
            };
          }),
        );
      } else if (typeof event.followUpQueuePaused === "boolean") {
        const followUpQueuePaused = event.followUpQueuePaused;
        setThreads((current) =>
          current.map((thread) =>
            thread.id === event.threadId
              ? {
                  ...thread,
                  followUpQueuePaused,
                  updatedAt: new Date().toISOString(),
                }
              : thread,
          ),
        );
      }

      if (event.type === "thread.plan_cleared") {
        const promoted = promotePendingPlanForThread(event.threadId);
        clearPendingPlanForThread(event.threadId);
        if (!promoted) {
          void fetchApprovedPlanForThread(event.threadId);
        }
      } else if (event.type === "thread.completed") {
        clearPendingPlanForThread(event.threadId);
        const activelyViewed = isThreadActivelyViewed(
          selectedThreadIdRef.current,
          event.threadId,
          document.hasFocus(),
        );
        if (!activelyViewed) {
          setUnreadThreadIds((current) => {
            if (current.has(event.threadId)) {
              return current;
            }
            const next = new Set(current);
            next.add(event.threadId);
            window.localStorage.setItem(unreadThreadsStorageKey, JSON.stringify([...next]));
            return next;
          });
        }
        // Main process re-checks app preferences + OS permission before calling Electron Notification.
        reportDesktopNotification(
          window.eco!.showThreadCompletionNotification({
            threadId: event.threadId,
            activelyViewed,
          }),
          "task completion",
        );
      }

      if (event.plan && event.threadId) {
        upsertPendingPlanForThread(event.threadId, {
          threadId: event.threadId,
          userPrompt: event.plan.userPrompt,
          analysis: event.plan.analysis,
          plan: event.plan.plan,
          workspacePath: "",
          worktreePath: "",
          ...(event.plan.planFilePath ? { planFilePath: event.plan.planFilePath } : {}),
        });
      }

      if (event.runtimeConfig) {
        const runtimeConfig = event.runtimeConfig;
        setThreads((current) =>
          current.map((thread) => (thread.id === event.threadId ? { ...thread, runtimeConfig } : thread)),
        );
      }

      if (event.externalSessionId) {
        const externalSessionId = event.externalSessionId;
        setThreads((current) =>
          current.map((thread) => (thread.id === event.threadId ? { ...thread, externalSessionId } : thread)),
        );
      }

      if (event.type === "bash_approval.requested" && event.bashApproval) {
        upsertPendingBashApprovalForThread(event.threadId, event.bashApproval);
      }

      if (event.type === "plan_approval.requested" && event.plan) {
        upsertPendingPlanForThread(event.threadId, {
          threadId: event.threadId,
          userPrompt: event.plan.userPrompt,
          analysis: event.plan.analysis,
          plan: event.plan.plan,
          workspacePath: "",
          worktreePath: "",
          ...(event.plan.planFilePath ? { planFilePath: event.plan.planFilePath } : {}),
        });
      }

      const approvalNotificationKind =
        event.type === "plan_approval.requested"
          ? "plan"
          : event.type === "bash_approval.requested"
            ? "bash"
            : undefined;
      if (approvalNotificationKind) {
        const activelyViewed = isThreadActivelyViewed(
          selectedThreadIdRef.current,
          event.threadId,
          document.hasFocus(),
        );
        reportDesktopNotification(
          window.eco!.showThreadApprovalNotification({
            threadId: event.threadId,
            kind: approvalNotificationKind,
            activelyViewed,
          }),
          `${approvalNotificationKind} approval`,
        );
      }

      if (event.followUp) {
        setFollowUpsByThread((current) => ({
          ...current,
          [event.threadId]: mergeThreadFollowUp(current[event.threadId] ?? [], event.followUp!),
        }));
        if (
          event.type === "thread.follow_up.escalated" &&
          typeof window.eco?.listThreadFollowUps === "function"
        ) {
          void window.eco.listThreadFollowUps(event.threadId).then((result) => {
            setFollowUpsByThread((current) => ({
              ...current,
              [event.threadId]: mergeThreadFollowUps(current[event.threadId] ?? [], result.followUps),
            }));
          });
        }
      }

      if (event.type.startsWith("bash_approval.")) {
        setThreads((current) =>
          current.map((thread) => {
            if (thread.id !== event.threadId) {
              return thread;
            }
            const status = event.type === "bash_approval.requested" ? "running" : thread.status;
            return {
              ...thread,
              message: persistThreadSummaryMessage(status, thread.message),
              status,
              updatedAt: new Date().toISOString(),
            };
          }),
        );
      }
      if (event.type.startsWith("plan_approval.")) {
        setThreads((current) =>
          current.map((thread) => {
            if (thread.id !== event.threadId) {
              return thread;
            }
            const status = event.type === "plan_approval.requested" ? "awaiting_plan" : thread.status;
            return {
              ...thread,
              message: persistThreadSummaryMessage(status, thread.message),
              status,
              updatedAt: new Date().toISOString(),
            };
          }),
        );
      }
      if (shouldClearPendingBashApproval(event.type)) {
        clearPendingBashApprovalForThread(event.threadId);
      }
      if (shouldClearPendingPlanApproval(event.type)) {
        clearPendingPlanForThread(event.threadId);
      }
      if (event.type === "plan_approval.approved") {
        if (event.planApproval) {
          rememberPlanApprovalForThread(event.threadId, event.planApproval);
        }
      }

      if (
        (event.type === "thread.awaiting_plan" ||
          event.type === "thread.execution_failed" ||
          event.type === "plan_approval.requested") &&
        !event.plan &&
        window.eco
      ) {
        void window.eco.getPendingPlan(event.threadId).then((plan) => {
          if (plan) {
            upsertPendingPlanForThread(event.threadId, plan);
          }
        });
      }
    };
    const unsubscribe = window.eco.onThreadEvent((event) => {
      if (
        isThreadLiveEvent(event) &&
        [
          "thread.completed",
          "thread.failed",
          "thread.idle",
          "thread.stopped",
          "thread.cancelled",
          "thread.blocked",
        ].includes(event.type)
      ) {
        handleThreadEvent(event);
      } else {
        startTransition(() => handleThreadEvent(event));
      }
    });
    return () => {
      if (rendererReadyFrame !== undefined) {
        window.cancelAnimationFrame(rendererReadyFrame);
      }
      if (rendererReadySecondFrame !== undefined) {
        window.cancelAnimationFrame(rendererReadySecondFrame);
      }
      if (threadListRefreshTimer !== undefined) {
        window.clearTimeout(threadListRefreshTimer);
      }
      for (const frame of conversationV2RenderFramesRef.current.values()) {
        window.cancelAnimationFrame(frame);
      }
      conversationV2RenderFramesRef.current.clear();
      conversationV2RenderPendingRef.current.clear();
      conversationV2RenderUrgentRef.current.clear();
      for (const timer of conversationV2LiveFlushTimersRef.current.values()) {
        window.clearTimeout(timer);
      }
      conversationV2LiveFlushTimersRef.current.clear();
      conversationV2LiveEffectsRef.current.clear();
      conversationV2ProjectionExtrasNextAllowedRef.current.clear();
      conversationV2ProjectionExtrasPendingRef.current.clear();
      unsubscribe();
      unsubscribeThreadOpen();
    };
  }, []);

  const selectedThreadStatus = threads.find((thread) => thread.id === selectedThreadId)?.status;

  useEffect(() => {
    if (conversationV2RecoveryVersion === 0) {
      return;
    }
    const requestedThreadIds = [...conversationV2RecoveryRequestsRef.current];
    conversationV2RecoveryRequestsRef.current.clear();
    for (const threadId of requestedThreadIds) {
      if (
        threadId !== selectedThreadIdRef.current ||
        conversationV2RecoveryInFlightRef.current.has(threadId) ||
        conversationV2LoadingThreadsRef.current.has(threadId)
      ) {
        continue;
      }
      conversationV2RecoveryInFlightRef.current.add(threadId);
      conversationV2LoadingThreadsRef.current.add(threadId);
      const loadGeneration = nextConversationV2LoadGeneration(threadId);
      let installed = false;
      let retryAfterLoad = false;
      void loadConversationV2RendererState(threadId)
        .then((recovered) => {
          if (
            !recovered ||
            selectedThreadIdRef.current !== threadId ||
            conversationV2LoadGenerationRef.current.get(threadId) !== loadGeneration
          ) {
            return;
          }
          installed = true;
          retryAfterLoad = mergeConversationV2LoadedState(threadId, recovered);
        })
        .catch((recoveryError) => {
          console.warn("[eco] conversation V2 renderer recovery failed:", recoveryError);
        })
        .finally(() => {
          conversationV2LoadingThreadsRef.current.delete(threadId);
          conversationV2RecoveryInFlightRef.current.delete(threadId);
          if (
            installed &&
            (retryAfterLoad ||
              (conversationV2PendingEventsRef.current.get(threadId)?.length ?? 0) > 0 ||
              conversationV2PendingOverflowRef.current.has(threadId))
          ) {
            queueConversationV2Recovery(threadId);
          }
        });
    }
  }, [conversationV2RecoveryVersion]);

  useEffect(() => {
    if (!selectedThreadId || !window.eco) {
      return;
    }

    let cancelled = false;

    if (
      typeof window.eco.conversationV2Bootstrap === "function" &&
      !conversationV2LoadingThreadsRef.current.has(selectedThreadId)
    ) {
      conversationV2LoadingThreadsRef.current.add(selectedThreadId);
      const loadGeneration = nextConversationV2LoadGeneration(selectedThreadId);
      let installed = false;
      let retryAfterLoad = false;
      void loadConversationV2RendererState(selectedThreadId)
        .then((state) => {
          if (
            cancelled ||
            !state ||
            conversationV2LoadGenerationRef.current.get(selectedThreadId) !== loadGeneration
          ) {
            return;
          }
          installed = true;
          retryAfterLoad = mergeConversationV2LoadedState(selectedThreadId, state);
          setFeedProjectionSettledByThread((current) =>
            current[selectedThreadId] === true ? current : { ...current, [selectedThreadId]: true },
          );
        })
        .catch((error) => {
          // V2 is the durable renderer boundary. A missing/incompatible stream is
          // surfaced as an explicit failure; it must not silently revive the legacy
          // projection as a page correctness source.
          setFeedProjectionSettledByThread((current) =>
            current[selectedThreadId] === true ? current : { ...current, [selectedThreadId]: true },
          );
          // A thread row can outlive its V2 stream after an interrupted
          // migration or an older cleanup run. It cannot be reopened, so
          // remove the stale sidebar entry instead of leaving the user stuck
          // on a permanently failing conversation.
          const message = errorMessage(error);
          const errorCode =
            typeof error === "object" && error !== null && "code" in error
              ? String((error as { code?: unknown }).code ?? "")
              : "";
          if (
            errorCode === "conversation_not_found" ||
            message.includes("Conversation V2 conversation was not found")
          ) {
            clearThreadClientState(selectedThreadId);
            setError(undefined);
          } else {
            setError(message);
          }
          console.error("[eco] conversation V2 renderer bootstrap unavailable:", error);
        })
        .finally(() => {
          conversationV2LoadingThreadsRef.current.delete(selectedThreadId);
          if (
            installed &&
            (retryAfterLoad ||
              (conversationV2PendingEventsRef.current.get(selectedThreadId)?.length ?? 0) > 0 ||
              conversationV2PendingOverflowRef.current.has(selectedThreadId))
          ) {
            queueConversationV2Recovery(selectedThreadId);
          }
        });
    }

    // Do not hydrate the V2 Feed from the legacy projection, subagent-session
    // snapshot, or metrics RPCs. Those values are either derived from the V2
    // state above or intentionally absent until their V2 read model lands.

    if (window.eco) {
      void Promise.all([
        window.eco.getPendingPlan(selectedThreadId),
        typeof window.eco.getApprovedPlan === "function"
          ? window.eco.getApprovedPlan(selectedThreadId)
          : Promise.resolve(undefined),
      ]).then(([plan, approvedPlan]) => {
        if (cancelled) {
          return;
        }
        if (plan) {
          upsertPendingPlanForThread(selectedThreadId, plan);
        } else {
          clearPendingPlanForThread(selectedThreadId);
          if (approvedPlan) {
            rememberApprovedPlanForThread(selectedThreadId, approvedPlan);
          } else {
            clearApprovedPlanForThread(selectedThreadId);
          }
        }
      });
      void window.eco.getPendingClarification(selectedThreadId).then((clarification) => {
        if (cancelled) {
          return;
        }
        if (clarification) {
          upsertPendingClarificationForThread(selectedThreadId, clarification);
        } else {
          clearPendingClarificationForThread(selectedThreadId);
        }
      });
      if (typeof window.eco.getPendingBashApproval === "function") {
        void window.eco.getPendingBashApproval(selectedThreadId).then((approval) => {
          if (cancelled) {
            return;
          }
          if (approval) {
            upsertPendingBashApprovalForThread(selectedThreadId, approval);
          } else {
            clearPendingBashApprovalForThread(selectedThreadId);
          }
        });
      }
      if (typeof window.eco.listThreadFollowUps === "function") {
        void window.eco.listThreadFollowUps(selectedThreadId).then((result) => {
          if (cancelled) {
            return;
          }
          setFollowUpsByThread((current) => ({
            ...current,
            [selectedThreadId]: mergeThreadFollowUps(current[selectedThreadId] ?? [], result.followUps),
          }));
        });
      }
    }

    return () => {
      cancelled = true;
    };
  }, [selectedThreadId, selectedThreadStatus]);

  useEffect(() => {
    const api = window.eco;
    if (!selectedThreadId || !api || typeof api.conversationV2Head !== "function") {
      return;
    }
    let cancelled = false;
    const checkHead = () => {
      const threadId = selectedThreadIdRef.current;
      if (cancelled || !threadId || conversationV2LoadingThreadsRef.current.has(threadId)) {
        return;
      }
      const local = conversationV2ByThreadRef.current[threadId];
      if (!local) return;
      void api
        .conversationV2Head(threadId)
        .then((head) => {
          if (cancelled || selectedThreadIdRef.current !== threadId) return;
          if (
            head.conversationId !== threadId ||
            head.storeEpoch !== local.storeEpoch ||
            head.lastSeq < local.appliedSeq ||
            head.lastSeq > local.appliedSeq
          ) {
            queueConversationV2Recovery(threadId);
          }
        })
        .catch((error) => {
          console.debug("[eco] conversation V2 renderer head check failed:", error);
        });
    };
    const interval = window.setInterval(checkHead, 10_000);
    const unsubscribeFocus = subscribeToWindowFocus((focused) => {
      if (focused) checkHead();
    });
    checkHead();
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      unsubscribeFocus();
    };
  }, [selectedThreadId, queueConversationV2Recovery]);

  const cancelProjectionCacheEviction = useCallback((threadId: string) => {
    const timer = projectionEvictTimersRef.current.get(threadId);
    if (timer === undefined) {
      return;
    }
    window.clearTimeout(timer);
    projectionEvictTimersRef.current.delete(threadId);
  }, []);

  const evictInactiveThreadProjectionCaches = useCallback(
    (threadId: string) => {
      cancelProjectionCacheEviction(threadId);
      activityFeedRevealedThreadIdsRef.current.delete(threadId);
      conversationV2PendingEventsRef.current.delete(threadId);
      conversationV2PendingOverflowRef.current.delete(threadId);
      conversationV2LoadGenerationRef.current.delete(threadId);
      conversationV2RecoveryRequestsRef.current.delete(threadId);
      conversationV2RecoveryInFlightRef.current.delete(threadId);
      conversationV2LoadingThreadsRef.current.delete(threadId);
      setConversationV2ByThread((current) => removeRecordKeys(current, [threadId]));
      setFeedProjectionSettledByThread((current) => removeRecordKeys(current, [threadId]));
      setImageArtifactsByThread((current) => removeRecordKeys(current, [threadId]));
      setImageDisplayArtifactsByThread((current) => removeRecordKeys(current, [threadId]));
      setHtmlHostArtifactsByThread((current) => removeRecordKeys(current, [threadId]));
    },
    [cancelProjectionCacheEviction],
  );

  useEffect(() => {
    if (selectedThreadId) {
      recentlyViewedThreadIdsRef.current = rememberRecentlyViewedThread(
        recentlyViewedThreadIdsRef.current,
        selectedThreadId,
      );
    }
  }, [feedThreadId, selectedThreadId]);

  useEffect(() => {
    const hotThreadIds = threads
      .filter((thread) => isProjectionCacheHotThreadStatus(thread.status))
      .map((thread) => thread.id);
    const protectedIds = collectProtectedProjectionThreadIds({
      selectedThreadId,
      feedThreadId,
      recentlyViewedThreadIds: recentlyViewedThreadIdsRef.current,
      hotThreadIds,
    });

    for (const threadId of [...projectionEvictTimersRef.current.keys()]) {
      if (protectedIds.has(threadId)) {
        cancelProjectionCacheEviction(threadId);
      }
    }

    const cachedThreadIds = [
      ...Object.keys(imageArtifactsByThreadRef.current),
      ...Object.keys(imageDisplayArtifactsByThreadRef.current),
      ...Object.keys(htmlHostArtifactsByThreadRef.current),
    ];

    for (const threadId of listEvictableProjectionThreadIds(cachedThreadIds, protectedIds)) {
      if (projectionEvictTimersRef.current.has(threadId)) {
        continue;
      }
      const timer = window.setTimeout(() => {
        projectionEvictTimersRef.current.delete(threadId);
        const hotNow = threadsRef.current
          .filter((thread) => isProjectionCacheHotThreadStatus(thread.status))
          .map((thread) => thread.id);
        const protectedNow = collectProtectedProjectionThreadIds({
          selectedThreadId: selectedThreadIdRef.current,
          feedThreadId: feedThreadIdRef.current,
          recentlyViewedThreadIds: recentlyViewedThreadIdsRef.current,
          hotThreadIds: hotNow,
        });
        if (protectedNow.has(threadId)) {
          return;
        }
        evictInactiveThreadProjectionCaches(threadId);
      }, PROJECTION_CACHE_EVICT_DELAY_MS);
      projectionEvictTimersRef.current.set(threadId, timer);
    }
  }, [
    cancelProjectionCacheEviction,
    evictInactiveThreadProjectionCaches,
    feedThreadId,
    selectedThreadId,
    threads,
  ]);

  useEffect(() => {
    return () => {
      for (const timer of projectionEvictTimersRef.current.values()) {
        window.clearTimeout(timer);
      }
      projectionEvictTimersRef.current.clear();
    };
  }, []);

  useEffect(() => {
    const saved = window.localStorage.getItem(recentProjectsStorageKey);
    if (!saved) return;
    try {
      const parsed = JSON.parse(saved) as Array<RecentProject & { lastUsedAt?: string; importedAt?: string }>;
      if (Array.isArray(parsed)) {
        setRecentProjects(
          parsed.map((project) => ({
            path: project.path,
            name: project.name,
            importedAt: project.importedAt ?? project.lastUsedAt ?? new Date(0).toISOString(),
          })),
        );
      }
    } catch {
      window.localStorage.removeItem(recentProjectsStorageKey);
    }
  }, []);

  useEffect(() => {
    const saved = window.localStorage.getItem(customProjectNamesStorageKey);
    if (!saved) return;
    try {
      const parsed = JSON.parse(saved) as unknown;
      if (isRecordValue(parsed)) {
        const next: Record<string, string> = {};
        for (const [path, name] of Object.entries(parsed)) {
          if (typeof name === "string") {
            next[path] = name;
          }
        }
        setCustomProjectNames(next);
      }
    } catch {
      window.localStorage.removeItem(customProjectNamesStorageKey);
    }
  }, []);

  function setCustomProjectName(projectPath: string, name: string | undefined) {
    const trimmed = name?.trim();
    setCustomProjectNames((current) => {
      const next = { ...current };
      if (!trimmed) {
        delete next[projectPath];
      } else {
        next[projectPath] = trimmed;
      }
      window.localStorage.setItem(customProjectNamesStorageKey, JSON.stringify(next));
      return next;
    });
    // A Chinese name is stored together with its pinyin spelling, so the project
    // stays searchable as "huihua" after the rename. Dropping the entry here lets
    // the search-term effect regenerate it for the new name.
    setCustomProjectSearchTerms((current) => {
      if (!current[projectPath]) {
        return current;
      }
      const next = { ...current };
      delete next[projectPath];
      window.localStorage.setItem(customProjectSearchTermsStorageKey, JSON.stringify(next));
      return next;
    });
  }

  useEffect(() => {
    const saved = window.localStorage.getItem(projectOrderStorageKey);
    if (!saved) {
      return;
    }
    try {
      const parsed = JSON.parse(saved);
      if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) {
        setProjectOrder(parsed);
        projectOrderInitializedRef.current = true;
      }
    } catch {
      window.localStorage.removeItem(projectOrderStorageKey);
    }
  }, []);

  useEffect(() => {
    const saved = window.localStorage.getItem(pinnedProjectsStorageKey);
    if (!saved) return;
    try {
      const parsed = JSON.parse(saved);
      if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) {
        setPinnedProjectPaths(new Set(parsed));
      }
    } catch {
      window.localStorage.removeItem(pinnedProjectsStorageKey);
    }
  }, []);

  useEffect(() => {
    const saved = window.localStorage.getItem(pinnedThreadsStorageKey);
    if (!saved) return;
    try {
      const parsed = JSON.parse(saved);
      if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) {
        setPinnedThreadIds(new Set(parsed));
      }
    } catch {
      window.localStorage.removeItem(pinnedThreadsStorageKey);
    }
  }, []);

  useEffect(() => {
    const saved = window.localStorage.getItem(unreadThreadsStorageKey);
    if (!saved) return;
    try {
      const parsed = JSON.parse(saved);
      if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) {
        setUnreadThreadIds(new Set(parsed));
      }
    } catch {
      window.localStorage.removeItem(unreadThreadsStorageKey);
    }
  }, []);

  useEffect(() => {
    const saved = window.localStorage.getItem(collapsedProjectsStorageKey);
    if (!saved) return;
    try {
      const parsed = JSON.parse(saved);
      if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) {
        setCollapsedProjectPaths(new Set(parsed));
      }
    } catch {
      window.localStorage.removeItem(collapsedProjectsStorageKey);
    }
  }, []);

  useEffect(() => {
    const saved = window.localStorage.getItem(hiddenProjectsStorageKey);
    if (!saved) return;
    try {
      const parsed = JSON.parse(saved);
      if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) {
        setHiddenProjectPaths(new Set(parsed));
      }
    } catch {
      window.localStorage.removeItem(hiddenProjectsStorageKey);
    }
  }, []);

  const mergedProjects = useMemo(() => {
    const merged = new Map<string, RecentProject>();
    if (homeProjectPath) {
      merged.set(normalizeProjectPath(homeProjectPath), {
        path: homeProjectPath,
        name: HOME_PROJECT_DISPLAY_NAME,
        importedAt: HOME_PROJECT_IMPORTED_AT,
      });
    }
    for (const project of recentProjects) {
      if (homeProjectPath && isHomeProjectPath(project.path, homeProjectPath)) {
        continue;
      }
      // Prefer the user's custom name; a stored name that differs from the path
      // basename is a custom name persisted from an older version.
      merged.set(normalizeProjectPath(project.path), {
        ...project,
        name: resolveProjectName(
          project.path,
          customProjectNames[project.path] ?? project.name,
          homeProjectPath,
        ).name,
      });
    }
    if (workspace) {
      const workspacePathKey = normalizeProjectPath(workspace.path);
      const existing = merged.get(workspacePathKey);
      // Keep a custom name when one is set; only adopt the inspected name
      // (folder basename) when no explicit rename exists.
      if (existing && !isCustomProjectName(customProjectNames[workspace.path], workspace.path)) {
        merged.set(workspacePathKey, {
          ...existing,
          name: resolveProjectName(workspace.path, customProjectNames[workspace.path], homeProjectPath).name,
        });
      }
    }
    for (const thread of threads) {
      const workspacePathKey = normalizeProjectPath(thread.workspacePath);
      if (!merged.has(workspacePathKey)) {
        const workspaceThreads = threads.filter((item) => item.workspacePath === thread.workspacePath);
        const importedAt = workspaceThreads.reduce(
          (earliest, item) => (item.createdAt < earliest ? item.createdAt : earliest),
          workspaceThreads[0]!.createdAt,
        );
        merged.set(workspacePathKey, {
          path: thread.workspacePath,
          name: resolveProjectName(
            thread.workspacePath,
            customProjectNames[thread.workspacePath],
            homeProjectPath,
          ).name,
          importedAt,
        });
      }
    }
    return [...merged.values()]
      .filter(
        (project) =>
          !hiddenProjectPaths.has(project.path) ||
          (homeProjectPath !== undefined && isHomeProjectPath(project.path, homeProjectPath)),
      )
      .map((project) => ({
        ...project,
        searchTerms: customProjectSearchTerms[project.path]?.terms ?? [],
      }));
  }, [customProjectNames, customProjectSearchTerms, hiddenProjectPaths, homeProjectPath, recentProjects, threads, workspace]);

  const projects = useMemo(
    () => ensureHomeProjectFirst(sortProjectsByOrder(mergedProjects, projectOrder), homeProjectPath),
    [homeProjectPath, mergedProjects, projectOrder],
  );

  // Chinese project names keep a pinyin spelling in storage ("会话存档" -> "huihua").
  // Renames and first-time backfills generate it off the startup path, because the
  // pinyin dictionary is a separate chunk.
  useEffect(() => {
    const plan = planProjectSearchTermIndex(projects, customProjectSearchTerms);
    if (!projectSearchTermPlanChanged(plan, customProjectSearchTerms)) {
      return;
    }
    const persist = (index: ProjectSearchTermIndex) => {
      setCustomProjectSearchTerms(index);
      window.localStorage.setItem(customProjectSearchTermsStorageKey, JSON.stringify(index));
    };
    if (plan.pending.length === 0) {
      persist(plan.kept);
      return;
    }
    let cancelled = false;
    void loadProjectPinyin().then(({ buildProjectSearchTerms }) => {
      if (cancelled) {
        return;
      }
      const index = { ...plan.kept };
      for (const project of plan.pending) {
        index[project.path] = { name: project.name, terms: buildProjectSearchTerms(project.name) };
      }
      persist(index);
    });
    return () => {
      cancelled = true;
    };
  }, [customProjectSearchTerms, projects]);

  useEffect(() => {
    if (projectOrderInitializedRef.current || mergedProjects.length === 0) {
      return;
    }
    const initial = buildInitialProjectOrder(mergedProjects);
    setProjectOrder(initial);
    window.localStorage.setItem(projectOrderStorageKey, JSON.stringify(initial));
    projectOrderInitializedRef.current = true;
  }, [mergedProjects]);

  const threadsByProject = useMemo(() => {
    const grouped = new Map<string, ThreadSummary[]>();
    for (const thread of threads) {
      const projectPathKey = normalizeProjectPath(thread.workspacePath);
      const bucket = grouped.get(projectPathKey) ?? [];
      bucket.push(thread);
      grouped.set(projectPathKey, bucket);
    }
    for (const [path, projectThreads] of grouped) {
      grouped.set(path, sortThreadsForSidebar(projectThreads, pinnedThreadIds));
    }
    return grouped;
  }, [pinnedThreadIds, threads]);

  const projectTree = useMemo(
    () =>
      projects.map((project) => {
        const projectThreads = threadsByProject.get(normalizeProjectPath(project.path)) ?? [];
        const threadsExpanded = expandedProjectThreadPaths.has(project.path);
        const visibleCount = threadsExpanded ? projectThreads.length : sidebarThreadsCollapsed;
        return {
          project: {
            ...project,
            pinned: pinnedProjectPaths.has(project.path),
            isHome: homeProjectPath ? isHomeProjectPath(project.path, homeProjectPath) : false,
          },
          projectThreads,
          collapsed: collapsedProjectPaths.has(project.path),
          visibleThreads: projectThreads.slice(0, visibleCount),
          hasMore: !threadsExpanded && projectThreads.length > visibleCount,
        };
      }),
    [
      collapsedProjectPaths,
      expandedProjectThreadPaths,
      homeProjectPath,
      pinnedProjectPaths,
      projects,
      threadsByProject,
    ],
  );
  const sidebarSearchThreads = useMemo(
    () => projectTree.flatMap((item) => item.projectThreads),
    [projectTree],
  );

  const currentProjectPath = useMemo(() => {
    if (selectedProjectPath && projects.some((project) => project.path === selectedProjectPath)) {
      return selectedProjectPath;
    }
    if (workspace && !hiddenProjectPaths.has(workspace.path)) {
      return workspace.path;
    }
    return projects[0]?.path;
  }, [hiddenProjectPaths, projects, selectedProjectPath, workspace]);
  const currentProjectName = useMemo(() => {
    if (!currentProjectPath) {
      return t("nav.projectFallback");
    }
    const project = projects.find((item) => item.path === currentProjectPath);
    return project?.name ?? pathToName(currentProjectPath);
  }, [currentProjectPath, projects, t]);
  const gitStatus = currentProjectPath ? gitStatusByWorkspace[currentProjectPath]?.status : undefined;
  const gitStatusLoading = currentProjectPath
    ? gitStatusLoadingByWorkspace[currentProjectPath] === true
    : false;
  const currentTerminalState = useMemo(() => {
    if (!currentProjectPath) {
      return undefined;
    }
    return getProjectTerminalState(terminalByProject, currentProjectPath);
  }, [currentProjectPath, terminalByProject]);
  const activeThread = useMemo(
    () => (feedThreadId ? threads.find((thread) => thread.id === feedThreadId) : undefined),
    [feedThreadId, threads],
  );
  const browserScopeId = activeThread?.id ?? browserPersonalScopeId(currentProjectPath);
  const browserScopeIdRef = useRef(browserScopeId);
  browserScopeIdRef.current = browserScopeId;
  const browserInstanceIds = useBrowserInstanceIds(browserScopeId);
  const browserTaskInstances = useBrowserTaskInstances(browserScopeId);
  const browserScopeReady = useBrowserStateSelector((state) => state?.uiScopeId === browserScopeId);
  useEffect(() => {
    if (!window.eco?.getTtsSettings) return;
    void window.eco
      .getTtsSettings()
      .then(setTtsSettings)
      .catch((caught) => setError(errorMessage(caught)));
  }, []);
  useEffect(() => {
    if (!selectedThreadId || !window.eco?.listTtsArtifacts) return;
    let cancelled = false;
    void window.eco
      .listTtsArtifacts(selectedThreadId)
      .then((artifacts) => {
        if (cancelled) return;
        setTtsArtifactsByThread((current) => {
          const byId = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
          for (const artifact of current[selectedThreadId] ?? []) {
            if (!byId.has(artifact.id) || artifact.updatedAt > byId.get(artifact.id)!.updatedAt)
              byId.set(artifact.id, artifact);
          }
          return {
            ...current,
            [selectedThreadId]: [...byId.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
          };
        });
      })
      .catch((caught) => {
        if (!cancelled) setError(errorMessage(caught));
      });
    return () => {
      cancelled = true;
    };
  }, [selectedThreadId]);
  useEffect(
    () =>
      window.eco?.onTtsArtifactChanged?.((artifact) => {
        setTtsArtifactsByThread((current) => ({
          ...current,
          [artifact.threadId]: [
            artifact,
            ...(current[artifact.threadId] ?? []).filter((item) => item.id !== artifact.id),
          ].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
        }));
      }),
    [],
  );

  useEffect(() => {
    if (!selectedThreadId || !window.eco?.listImageGenerationArtifacts) return;
    let cancelled = false;
    void window.eco
      .listImageGenerationArtifacts(selectedThreadId)
      .then((artifacts) => {
        if (!cancelled) {
          setImageArtifactsByThread((current) => ({ ...current, [selectedThreadId]: artifacts }));
        }
      })
      .catch((caught) => {
        if (!cancelled) setError(errorMessage(caught));
      });
    return () => {
      cancelled = true;
    };
  }, [selectedThreadId]);

  useEffect(() => {
    if (!selectedThreadId || !window.eco?.listImageDisplayArtifacts) return;
    let cancelled = false;
    void window.eco
      .listImageDisplayArtifacts(selectedThreadId)
      .then((artifacts) => {
        if (!cancelled) {
          setImageDisplayArtifactsByThread((current) => ({
            ...current,
            [selectedThreadId]: artifacts,
          }));
        }
      })
      .catch((caught) => {
        if (!cancelled) setError(errorMessage(caught));
      });
    return () => {
      cancelled = true;
    };
  }, [selectedThreadId]);

  useEffect(() => {
    if (!selectedThreadId || !window.eco?.listHtmlHostArtifacts) return;
    let cancelled = false;
    void window.eco
      .listHtmlHostArtifacts(selectedThreadId)
      .then((artifacts) => {
        if (!cancelled) {
          setHtmlHostArtifactsByThread((current) => ({
            ...current,
            [selectedThreadId]: artifacts,
          }));
        }
      })
      .catch((caught) => {
        if (!cancelled) setError(errorMessage(caught));
      });
    return () => {
      cancelled = true;
    };
  }, [selectedThreadId]);

  useEffect(() => {
    if (!window.eco?.onImageGenerationArtifactChanged) return;
    return window.eco.onImageGenerationArtifactChanged((artifact) => {
      setImageArtifactsByThread((current) => {
        const existing = current[artifact.threadId] ?? [];
        const next = [artifact, ...existing.filter((item) => item.id !== artifact.id)].sort((a, b) =>
          b.createdAt.localeCompare(a.createdAt),
        );
        return { ...current, [artifact.threadId]: next };
      });
      // 创意绘画完成且有产出图片时排入右侧画廊队列（仅当前查看的会话触发）。
      if (
        artifact.threadId === activeThreadIdRef.current &&
        artifact.status === "completed" &&
        artifact.images.length > 0
      ) {
        enqueueImageGalleryItems(
          artifact.images.map((_image, imageIndex) => imageGalleryGenerationItem(artifact.id, imageIndex)),
        );
      }
    });
  }, [enqueueImageGalleryItems]);

  useEffect(() => {
    if (!window.eco?.onImageDisplayArtifactChanged) return;
    return window.eco.onImageDisplayArtifactChanged((artifact) => {
      setImageDisplayArtifactsByThread((current) => {
        const existing = current[artifact.threadId] ?? [];
        const next = [artifact, ...existing.filter((item) => item.id !== artifact.id)].sort((a, b) =>
          b.createdAt.localeCompare(a.createdAt),
        );
        return { ...current, [artifact.threadId]: next };
      });
      // 展示图片成功时排入右侧画廊队列（仅当前查看的会话触发）。
      if (artifact.threadId === activeThreadIdRef.current && artifact.status === "completed") {
        enqueueImageGalleryItems([imageGalleryDisplayItem(artifact.id)]);
      }
    });
  }, [enqueueImageGalleryItems]);

  useEffect(() => {
    if (!window.eco?.onHtmlHostArtifactChanged) return;
    return window.eco.onHtmlHostArtifactChanged((artifact) => {
      setHtmlHostArtifactsByThread((current) => {
        const existing = current[artifact.threadId] ?? [];
        const next = [artifact, ...existing.filter((item) => item.id !== artifact.id)].sort((a, b) =>
          b.updatedAt.localeCompare(a.updatedAt),
        );
        return { ...current, [artifact.threadId]: next };
      });
    });
  }, []);
  useEffect(() => {
    activeThreadIdRef.current = activeThread?.id;
  }, [activeThread?.id]);
  // 切换会话时清空画廊队列（其他会话的图片仍保留在各自 cards）。
  useEffect(() => {
    setImageGalleryQueue([]);
    setImageGalleryOpen(false);
  }, [selectedThreadId]);
  // 队列清空后自动收起悬浮窗，图片回到 cards。
  useEffect(() => {
    if (imageGalleryOpen && imageGalleryQueue.length === 0) {
      setImageGalleryOpen(false);
    }
  }, [imageGalleryOpen, imageGalleryQueue.length]);
  const workspacePanelResponsiveDefaultOpen = Boolean(
    activeThread && shouldAutoOpenWorkspacePanel(activityWorkspaceLayoutMode),
  );
  const workspacePanelManualOpen =
    workspacePanelManualOverride?.layoutMode === activityWorkspaceLayoutMode &&
    workspacePanelManualOverride.projectPath === currentProjectPath &&
    workspacePanelManualOverride.threadId === activeThread?.id
      ? workspacePanelManualOverride.open
      : undefined;
  const workspacePanelResolvedOpen = workspacePanelManualOpen ?? workspacePanelResponsiveDefaultOpen;
  useLayoutEffect(() => {
    setWorkspacePanelManualOverride(undefined);
  }, [activityWorkspaceLayoutMode, currentProjectPath, activeThread?.id]);
  useLayoutEffect(() => {
    if (scheduledMessagesReveal?.threadId !== activeThread?.id || !currentProjectPath) return;
    setWorkspacePanelManualOverride({
      layoutMode: activityWorkspaceLayoutMode,
      projectPath: currentProjectPath,
      threadId: activeThread?.id,
      open: true,
    });
    const panel = workspaceCardsPanelRef.current;
    const scroller = panel?.querySelector<HTMLElement>(".workspace-floating-cards-sections") ?? panel;
    if (!scroller) return;
    const section = scroller
      .querySelector<HTMLElement>("#workspace-scheduled-messages-body")
      ?.closest<HTMLElement>(".workspace-panel-section");
    if (section) {
      const delta = section.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
      scroller.scrollTo({ top: scroller.scrollTop + delta });
    } else {
      scroller.scrollTo({ top: 0 });
    }
  }, [scheduledMessagesReveal, activeThread?.id, currentProjectPath, activityWorkspaceLayoutMode]);
  useEffect(() => {
    reviewDiffRequestRef.current += 1;
    reviewDiffManualRefreshRef.current = false;
    setReviewDiff(currentProjectPath ? readWorkspaceReviewSummary(currentProjectPath) : undefined);
    setReviewDiffLoading(false);
    setReviewDiffError(undefined);
    setReviewSelectedPath(undefined);
  }, [currentProjectPath]);
  const updateProjectTerminal = useCallback((workspacePath: string, next: ProjectTerminalState) => {
    setTerminalByProject((current) => ({
      ...current,
      [workspacePath]: next,
    }));
  }, []);
  const toggleTerminalForCurrentProject = useCallback(() => {
    if (!currentProjectPath) {
      return;
    }
    setTerminalByProject((current) => {
      const existing = current[currentProjectPath];
      const stored = storedTerminalByProject[currentProjectPath];
      const hasLiveSessions = hasTerminalSessionsForProject(currentProjectPath);
      if (existing?.open && hasLiveSessions) {
        return {
          ...current,
          [currentProjectPath]: { ...existing, open: false },
        };
      }
      if (!hasLiveSessions || !existing || existing.tabs.length === 0) {
        const nextState = createProjectTerminalState(currentProjectName, true);
        return {
          ...current,
          [currentProjectPath]: {
            ...nextState,
            height: existing?.height ?? stored?.height ?? nextState.height,
          },
        };
      }
      return {
        ...current,
        [currentProjectPath]: { ...existing, open: true },
      };
    });
  }, [currentProjectName, currentProjectPath, storedTerminalByProject]);
  const toggleWorkspacePanelForCurrentProject = useCallback(() => {
    if (!currentProjectPath) {
      return;
    }
    setWorkspacePanelManualOverride({
      layoutMode: activityWorkspaceLayoutMode,
      projectPath: currentProjectPath,
      threadId: activeThread?.id,
      open: !workspacePanelResolvedOpen,
    });
  }, [activeThread?.id, activityWorkspaceLayoutMode, currentProjectPath, workspacePanelResolvedOpen]);
  const pendingPlan = activeThread ? pendingPlansByThread[activeThread.id] : undefined;
  const approvedPlan = activeThread ? approvedPlansByThread[activeThread.id] : undefined;
  const taskPanelPlan = pendingPlan ?? approvedPlan;
  const pendingClarification = activeThread ? pendingClarificationsByThread[activeThread.id] : undefined;
  const pendingBashApproval = activeThread ? pendingBashApprovalsByThread[activeThread.id] : undefined;
  const attentionItems = buildSidebarAttentionItems({
    threads,
    unreadThreadIds,
    pendingPlansByThread,
    pendingBashApprovalsByThread,
    pendingClarificationsByThread,
  });

  useEffect(() => {
    pendingPlansByThreadRef.current = pendingPlansByThread;
  }, [pendingPlansByThread]);

  function upsertPendingPlanForThread(threadId: string, plan: ThreadPendingPlan) {
    setPendingPlansByThread((current) => ({ ...current, [threadId]: plan }));
    clearApprovedPlanForThread(threadId);
  }

  function rememberApprovedPlanForThread(threadId: string, plan: ThreadPendingPlan) {
    setApprovedPlansByThread((current) => ({ ...current, [threadId]: plan }));
  }

  function clearApprovedPlanForThread(threadId: string) {
    setApprovedPlansByThread((current) => removeRecordKey(current, threadId));
  }

  async function fetchApprovedPlanForThread(threadId: string) {
    if (typeof window.eco?.getApprovedPlan !== "function") {
      return;
    }
    const plan = await window.eco.getApprovedPlan(threadId);
    if (plan) {
      rememberApprovedPlanForThread(threadId, plan);
    }
  }

  function rememberPlanApprovalForThread(
    threadId: string,
    plan: Pick<ThreadPendingPlan, "analysis" | "plan" | "userPrompt" | "planFilePath">,
  ) {
    rememberApprovedPlanForThread(threadId, {
      threadId,
      userPrompt: plan.userPrompt,
      analysis: plan.analysis,
      plan: plan.plan,
      workspacePath: "",
      worktreePath: "",
      ...(plan.planFilePath ? { planFilePath: plan.planFilePath } : {}),
    });
  }

  function promotePendingPlanForThread(threadId: string): boolean {
    const plan = pendingPlansByThreadRef.current[threadId];
    if (plan) {
      rememberApprovedPlanForThread(threadId, plan);
      return true;
    }
    return false;
  }

  function clearPendingPlanForThread(threadId: string) {
    setPendingPlansByThread((current) => removeRecordKey(current, threadId));
  }

  function upsertPendingClarificationForThread(threadId: string, clarification: ClarificationRequest) {
    setPendingClarificationsByThread((current) => ({ ...current, [threadId]: clarification }));
  }

  function clearPendingClarificationForThread(threadId: string) {
    setPendingClarificationsByThread((current) => removeRecordKey(current, threadId));
  }

  function upsertPendingBashApprovalForThread(threadId: string, approval: BashApprovalRequest) {
    setPendingBashApprovalsByThread((current) => ({ ...current, [threadId]: approval }));
  }

  function clearPendingBashApprovalForThread(threadId: string) {
    setPendingBashApprovalsByThread((current) => removeRecordKey(current, threadId));
  }
  const composerContextKey = useMemo(
    () => composerContextKeyFromParts(activeThread?.id, activeThread ? undefined : currentProjectPath),
    [activeThread?.id, currentProjectPath],
  );
  const composerDraftsByKeyRef = useRef<Record<string, ComposerDraft>>({});
  const pendingPlanComposerHandoffRef = useRef<ComposerPlanHandoff | undefined>(undefined);
  const prevComposerContextKeyRef = useRef<string | undefined>(undefined);
  const composerContextKeyRef = useRef(composerContextKey);
  const composerPromptRef = useRef(prompt);
  const composerAttachmentsRef = useRef(composerAttachments);
  const composerRewindTargetRef = useRef(composerRewindTarget);
  const composerDraftLoadRequestRef = useRef(0);
  const composerDraftSaveTimerRef = useRef<{ key: string; timer: number } | undefined>(undefined);
  composerContextKeyRef.current = composerContextKey;
  composerPromptRef.current = prompt;
  composerAttachmentsRef.current = composerAttachments;
  composerRewindTargetRef.current = composerRewindTarget;
  useEffect(() => {
    saveTerminalWorkspaceState(terminalByProject);
  }, [terminalByProject]);
  useEffect(() => {
    saveTaskPanelWidth(taskPanelWidth);
  }, [taskPanelWidth]);
  useLayoutEffect(() => {
    if (!taskPanelLayoutPresent) {
      return undefined;
    }
    const pane = mainPaneRef.current;
    if (!pane) {
      return undefined;
    }
    const sync = () => {
      setTaskPanelWidth((current) => clampTaskPanelWidth(current, pane.clientWidth));
    };
    const observer = new ResizeObserver(sync);
    observer.observe(pane);
    sync();
    return () => observer.disconnect();
  }, [taskPanelLayoutPresent]);
  useEffect(() => {
    if (!currentProjectPath) {
      return undefined;
    }

    let cancelled = false;
    const workspacePath = currentProjectPath;
    const workspaceLabel = currentProjectName;
    const loadLiveSessions = async (): Promise<TerminalSessionView[]> => {
      if (!window.eco?.listTerminalSessions) {
        return listTerminalSessionEntriesForProject(workspacePath).map((entry) => ({
          sessionId: entry.sessionId,
          workspacePath,
          kind: entry.kind,
          ...(entry.label ? { label: entry.label } : {}),
          ...(entry.endpoint ? { endpoint: entry.endpoint } : {}),
        }));
      }
      try {
        return await window.eco.listTerminalSessions({ workspacePath });
      } catch {
        return [];
      }
    };

    void loadLiveSessions().then((sessions) => {
      if (cancelled) {
        return;
      }
      setTerminalByProject((current) => {
        const existing = current[workspacePath] ?? storedTerminalByProject[workspacePath];
        const syncResult = buildTerminalStateForLiveSessions(
          existing,
          workspacePath,
          workspaceLabel,
          sessions,
        );
        replaceTerminalSessionsForProject(workspacePath, syncResult.cacheEntries);
        if (!syncResult.state) {
          const currentState = current[workspacePath];
          if (currentState?.open && currentState.tabs.length > 0) {
            return current;
          }
          if (currentState === undefined) {
            return current;
          }
          const next = { ...current };
          delete next[workspacePath];
          return next;
        }
        return {
          ...current,
          [workspacePath]: syncResult.state,
        };
      });
    });

    return () => {
      cancelled = true;
    };
  }, [
    activeThread?.id,
    currentProjectName,
    currentProjectPath,
    storedTerminalByProject,
    terminalLifecycleEpoch,
  ]);
  useEffect(() => {
    if (!currentProjectPath) {
      return undefined;
    }
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "`" && event.key !== "~") {
        return;
      }
      if (!event.ctrlKey && !event.metaKey) {
        return;
      }
      event.preventDefault();
      toggleTerminalForCurrentProject();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [currentProjectPath, toggleTerminalForCurrentProject]);
  const activeComposerRewindTarget =
    activeThread && composerRewindTarget?.threadId === activeThread.id ? composerRewindTarget : undefined;
  useEffect(() => {
    if (!currentProjectPath || !window.eco) {
      setProjectWorkspace(undefined);
      return undefined;
    }

    let cancelled = false;
    void window.eco.inspectWorkspace(currentProjectPath).then((info) => {
      if (!cancelled) {
        setProjectWorkspace(info);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [currentProjectPath]);

  const storeGitStatus = useCallback((workspacePath: string, status: GitWorkingTreeStatus) => {
    setGitStatusByWorkspace((current) => {
      const next = cacheWorkspaceGitStatus(current, workspacePath, status, Date.now());
      gitStatusByWorkspaceRef.current = next;
      return next;
    });
  }, []);

  const refreshGitStatus = useCallback(
    async (workspacePath?: string, options: { force?: boolean } = {}) => {
      const path = workspacePath ?? currentProjectPath;
      if (!path || !window.eco) {
        return;
      }
      if (
        !shouldRefreshWorkspaceGitStatus(gitStatusByWorkspaceRef.current, path, Date.now(), options.force)
      ) {
        return;
      }
      const requestId = (gitStatusRequestRef.current.get(path) ?? 0) + 1;
      gitStatusRequestRef.current.set(path, requestId);
      setGitStatusLoadingByWorkspace((current) => ({ ...current, [path]: true }));
      try {
        const status = await window.eco.getGitStatus(path);
        if (requestId === gitStatusRequestRef.current.get(path)) {
          storeGitStatus(path, status);
        }
      } catch {
      } finally {
        if (requestId === gitStatusRequestRef.current.get(path)) {
          setGitStatusLoadingByWorkspace((current) => ({ ...current, [path]: false }));
        }
      }
    },
    [currentProjectPath, storeGitStatus],
  );

  useEffect(() => {
    void refreshGitStatus();
  }, [currentProjectPath, activeThread?.id, refreshGitStatus]);

  const refreshPackageScripts = useCallback(async () => {
    if (!currentProjectPath || !window.eco) {
      setPackageScripts(undefined);
      return;
    }
    setScriptsBusy(true);
    try {
      const result = await window.eco.listPackageScripts(currentProjectPath);
      setPackageScripts(result);
    } catch {
      setPackageScripts(undefined);
    } finally {
      setScriptsBusy(false);
    }
  }, [currentProjectPath]);

  useEffect(() => {
    setPackageScripts(undefined);
    void refreshPackageScripts();
  }, [refreshPackageScripts]);

  useEffect(() => {
    if (!currentProjectPath || !window.eco?.watchPackageJson) {
      return undefined;
    }
    void window.eco.watchPackageJson(currentProjectPath);
    if (!window.eco.onPackageJsonChanged) {
      return undefined;
    }
    return window.eco.onPackageJsonChanged((workspacePath) => {
      if (workspacePath === currentProjectPath) {
        void refreshPackageScripts();
      }
    });
  }, [currentProjectPath, refreshPackageScripts]);

  useEffect(() => {
    const onFocus = () => {
      void refreshPackageScripts();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refreshPackageScripts]);

  useEffect(() => {
    if (!currentProjectPath) {
      return;
    }
    let shouldRefresh = false;
    for (const thread of threads) {
      if (thread.workspacePath !== currentProjectPath) {
        continue;
      }
      const previousStatus = prevThreadStatusByIdRef.current.get(thread.id);
      if (previousStatus === undefined) {
        prevThreadStatusByIdRef.current.set(thread.id, thread.status);
        continue;
      }
      if (isActiveThreadStatus(previousStatus) && !isActiveThreadStatus(thread.status)) {
        shouldRefresh = true;
      }
      prevThreadStatusByIdRef.current.set(thread.id, thread.status);
    }
    if (shouldRefresh) {
      void refreshPackageScripts();
      void refreshGitStatus(currentProjectPath, { force: true });
    }
  }, [threads, currentProjectPath, refreshGitStatus, refreshPackageScripts]);

  const showPackageScriptsEntry = Boolean(
    packageScripts?.hasPackageJson && packageScripts.scripts.length > 0,
  );

  const refreshBackgroundTerminalTasks = useCallback(async () => {
    if (!currentProjectPath || !window.eco?.listBackgroundTerminalTasks) {
      setBackgroundTerminalTasks([]);
      return;
    }
    try {
      const tasks = await window.eco.listBackgroundTerminalTasks({ workspacePath: currentProjectPath });
      setBackgroundTerminalTasks(tasks);
    } catch {
      setBackgroundTerminalTasks([]);
    }
  }, [currentProjectPath]);

  useEffect(() => {
    void refreshBackgroundTerminalTasks();
  }, [refreshBackgroundTerminalTasks]);

  const refreshCodexBackgroundTerminals = useCallback(async () => {
    if (!window.eco?.listCodexBackgroundTerminals) {
      setCodexBackgroundTerminals([]);
      setCodexBackgroundTerminalError(undefined);
      return;
    }
    try {
      setCodexBackgroundTerminals(await window.eco.listCodexBackgroundTerminals());
      setCodexBackgroundTerminalError(undefined);
    } catch (error) {
      setCodexBackgroundTerminalError(String(error));
    }
  }, []);

  const stopCodexBackgroundTerminal = useCallback(
    async (terminal: Pick<CodexBackgroundTerminal, "codexThreadId" | "processId">) => {
      if (!window.eco?.terminateCodexBackgroundTerminal) {
        throw new Error(t("app.running.terminateUnavailable"));
      }
      const result = await window.eco.terminateCodexBackgroundTerminal({
        codexThreadId: terminal.codexThreadId,
        processId: terminal.processId,
      });
      if (!result.terminated) {
        throw new Error(t("app.running.terminateUnavailable"));
      }
      await refreshCodexBackgroundTerminals();
    },
    [refreshCodexBackgroundTerminals, t],
  );

  const refreshClaudeBackgroundTasks = useCallback(async () => {
    if (!window.eco?.listClaudeBackgroundTasks) {
      setClaudeBackgroundTasks([]);
      setClaudeBackgroundTaskError(undefined);
      return;
    }
    try {
      setClaudeBackgroundTasks(await window.eco.listClaudeBackgroundTasks());
      setClaudeBackgroundTaskError(undefined);
    } catch (error) {
      setClaudeBackgroundTaskError(String(error));
    }
  }, []);

  const stopClaudeBackgroundTask = useCallback(
    async (task: Pick<ClaudeBackgroundTask, "threadId" | "taskId">) => {
      if (!window.eco?.stopClaudeBackgroundTask) {
        throw new Error(t("app.running.terminateUnavailable"));
      }
      const result = await window.eco.stopClaudeBackgroundTask({
        threadId: task.threadId,
        taskId: task.taskId,
      });
      if (!result.stopped) {
        throw new Error(t("app.running.terminateUnavailable"));
      }
      await refreshClaudeBackgroundTasks();
    },
    [refreshClaudeBackgroundTasks, t],
  );

  const handleRunningTerminalClosed = useCallback((terminal: RunningTerminal) => {
    const closedTabIds = new Set(
      listTerminalSessionEntriesForProject(terminal.workspacePath)
        .filter((entry) => entry.sessionId === terminal.sessionId)
        .map((entry) => entry.tabId),
    );
    for (const tabId of closedTabIds) deleteTerminalSessionId(terminal.workspacePath, tabId);
    setTerminalByProject((current) => {
      const state = current[terminal.workspacePath];
      if (!state || closedTabIds.size === 0) return current;
      const tabs = state.tabs.filter((tab) => !closedTabIds.has(tab.id));
      return {
        ...current,
        [terminal.workspacePath]: {
          ...state,
          tabs,
          activeTabId: closedTabIds.has(state.activeTabId) ? (tabs.at(-1)?.id ?? "") : state.activeTabId,
          open: state.open && tabs.length > 0,
        },
      };
    });
    setInjectedTerminalSessionId((current) => current === terminal.sessionId ? null : current);
    setTerminalLifecycleEpoch((epoch) => epoch + 1);
    void refreshBackgroundTerminalTasks();
  }, [refreshBackgroundTerminalTasks]);

  const trackPackageScriptTerminalSession = useCallback(
    (sessionId: string, meta: { command: string; projectName: string }, taskId?: string) => {
      if (!settledPackageScriptTerminalSessionRef.current.has(sessionId)) {
        packageScriptByTerminalSessionRef.current.set(sessionId, meta);
      }
      if (taskId) {
        packageScriptTaskByTerminalSessionRef.current.set(sessionId, taskId);
      }
    },
    [],
  );

  const settlePackageScriptTerminalSession = useCallback(
    (sessionId: string, exitCode?: number): boolean | undefined => {
      const settledResult = settledPackageScriptTerminalSessionRef.current.get(sessionId);
      if (settledResult !== undefined) {
        return settledResult;
      }
      const meta = packageScriptByTerminalSessionRef.current.get(sessionId);
      if (!meta) {
        return undefined;
      }
      packageScriptByTerminalSessionRef.current.delete(sessionId);
      const succeeded = exitCode === 0;
      settledPackageScriptTerminalSessionRef.current.set(sessionId, succeeded);
      if (settledPackageScriptTerminalSessionRef.current.size > 100) {
        const oldestSessionId = settledPackageScriptTerminalSessionRef.current.keys().next().value;
        if (oldestSessionId) {
          settledPackageScriptTerminalSessionRef.current.delete(oldestSessionId);
        }
      }
      if (succeeded) {
        showAppMessageSuccessRef.current(
          t("app.scriptSucceeded", { project: meta.projectName, command: meta.command }),
        );
      } else {
        const exitCodeDetail = exitCode === undefined ? "" : t("app.exitCode", { code: exitCode });
        showAppMessageErrorRef.current(
          t("app.scriptFailed", {
            project: meta.projectName,
            command: meta.command,
            detail: exitCodeDetail,
          }),
        );
      }
      return succeeded;
    },
    [],
  );

  const syncPackageScriptTerminalPresentation = useCallback(
    async (sessionId: string, taskId?: string) => {
      const resolvedTaskId = taskId ?? packageScriptTaskByTerminalSessionRef.current.get(sessionId);
      if (!resolvedTaskId || !window.eco?.openBackgroundTerminalTask) {
        return;
      }
      try {
        const task = await window.eco.openBackgroundTerminalTask({ taskId: resolvedTaskId });
        const isSettled = task.status === "exited" || task.status === "failed" || task.status === "stopped";
        setTerminalSessionPresentations((current) => ({
          ...current,
          [sessionId]: {
            ...(task.output !== undefined && { initialOutput: task.output }),
            ...(isSettled && { exitCode: task.exitCode ?? (task.status === "exited" ? 0 : 1) }),
          },
        }));
        if (isSettled) {
          settlePackageScriptTerminalSession(sessionId, task.exitCode ?? (task.status === "exited" ? 0 : 1));
        }
      } catch {
        // The live terminal event path still handles sessions whose task snapshot is unavailable.
      }
    },
    [settlePackageScriptTerminalSession],
  );

  useEffect(() => {
    if (!window.eco?.onTerminalEvent) {
      return undefined;
    }
    return window.eco.onTerminalEvent((event) => {
      if (event.type === "exit") {
        settlePackageScriptTerminalSession(event.sessionId, event.exitCode);
        void syncPackageScriptTerminalPresentation(event.sessionId);
      } else if (event.type === "error") {
        settlePackageScriptTerminalSession(event.sessionId);
        void syncPackageScriptTerminalPresentation(event.sessionId);
      }
      if (event.type === "started" || event.type === "exit" || event.type === "error") {
        void refreshBackgroundTerminalTasks();
      }
      if (event.type === "exit" || event.type === "error") {
        setTerminalLifecycleEpoch((epoch) => epoch + 1);
      }
    });
  }, [
    refreshBackgroundTerminalTasks,
    settlePackageScriptTerminalSession,
    syncPackageScriptTerminalPresentation,
  ]);

  const dismissPackageScriptRunOverlays = useCallback(() => {
    setScriptsDialogOpen(false);
  }, []);

  const openTerminalSessionTab = useCallback(
    (workspacePath: string, sessionId: string, identity?: InjectedTerminalSessionIdentity) => {
      setTerminalByProject((current) => {
        const existing = getProjectTerminalState(current, workspacePath);
        const stored = storedTerminalByProject[workspacePath];
        const workspaceLabel =
          projects.find((item) => item.path === workspacePath)?.name ?? pathToName(workspacePath);
        // An SSH session always owns its own tab, so with nothing open yet the tab
        // list starts empty and the SSH tab becomes the first one — no stray shell.
        const baseState: ProjectTerminalState =
          existing && existing.tabs.length > 0
            ? { ...existing, open: true }
            : identity?.kind === "ssh"
              ? { open: true, height: DEFAULT_TERMINAL_HEIGHT, tabs: [], activeTabId: "" }
              : createProjectTerminalState(workspaceLabel, true);
        const sessionByTabId = listTerminalSessionsForProject(
          workspacePath,
          baseState.tabs.map((tab) => tab.id),
        );
        const assigned = resolveTerminalTabForInjectedSession({
          state: {
            ...baseState,
            height: existing?.height ?? stored?.height ?? baseState.height,
          },
          workspaceLabel,
          sessionId,
          sessionByTabId,
          ...identity,
        });
        return {
          ...current,
          [workspacePath]: assigned.state,
        };
      });
      setInjectedTerminalSessionId(sessionId);
    },
    [projects, storedTerminalByProject],
  );

  const handleTerminalSessionExit = useCallback(
    (sessionId: string, exitCode: number) => {
      const isPackageScript =
        packageScriptByTerminalSessionRef.current.has(sessionId) ||
        settledPackageScriptTerminalSessionRef.current.has(sessionId) ||
        packageScriptTaskByTerminalSessionRef.current.has(sessionId);
      settlePackageScriptTerminalSession(sessionId, exitCode);
      void syncPackageScriptTerminalPresentation(sessionId);
      return !isPackageScript;
    },
    [settlePackageScriptTerminalSession, syncPackageScriptTerminalPresentation],
  );

  const openBackgroundTerminalTask = useCallback(
    async (task: BackgroundTerminalTask) => {
      if (!window.eco?.openBackgroundTerminalTask) {
        openTerminalSessionTab(task.workspacePath, task.sessionId);
        return;
      }
      try {
        const resolved = await window.eco.openBackgroundTerminalTask({ taskId: task.taskId });
        openTerminalSessionTab(resolved.workspacePath, resolved.sessionId);
      } catch {
        openTerminalSessionTab(task.workspacePath, task.sessionId);
      }
    },
    [openTerminalSessionTab],
  );

  const stopBackgroundTerminalTask = useCallback(
    async (task: BackgroundTerminalTask) => {
      if (!window.eco?.stopBackgroundTerminalTask) {
        return;
      }
      try {
        await window.eco.stopBackgroundTerminalTask({ taskId: task.taskId });
      } finally {
        void refreshBackgroundTerminalTasks();
      }
    },
    [refreshBackgroundTerminalTasks],
  );

  const presentPackageScriptTerminal = useCallback(
    async (
      workspacePath: string,
      sessionId: string,
      scriptMeta: { command: string; projectName: string },
      taskId?: string,
    ) => {
      trackPackageScriptTerminalSession(sessionId, scriptMeta, taskId);
      const dismissStartedAt = performance.now();
      dismissPackageScriptRunOverlays();
      void refreshBackgroundTerminalTasks();
      await waitForOverlayDismiss(dismissStartedAt);
      openTerminalSessionTab(workspacePath, sessionId);
      void syncPackageScriptTerminalPresentation(sessionId, taskId);
    },
    [
      dismissPackageScriptRunOverlays,
      openTerminalSessionTab,
      refreshBackgroundTerminalTasks,
      syncPackageScriptTerminalPresentation,
      trackPackageScriptTerminalSession,
    ],
  );

  useEffect(() => {
    if (!window.eco?.onPackageScriptTerminalLaunch) {
      return undefined;
    }
    return window.eco.onPackageScriptTerminalLaunch((payload) => {
      const projectName =
        projects.find((item) => item.path === payload.workspacePath)?.name ??
        pathToName(payload.workspacePath);
      const scriptMeta = {
        command:
          payload.commandLabel ?? (payload.command.length > 0 ? payload.command.join(" ") : payload.script),
        projectName,
      };
      trackPackageScriptTerminalSession(payload.sessionId, scriptMeta, payload.taskId);
      if (!currentProjectPath || payload.workspacePath !== currentProjectPath) {
        return;
      }
      void presentPackageScriptTerminal(payload.workspacePath, payload.sessionId, scriptMeta, payload.taskId);
    });
  }, [currentProjectPath, presentPackageScriptTerminal, projects, trackPackageScriptTerminalSession]);

  const startPackageScript = useCallback(
    async (scriptName: string, args?: string, prefix?: string) => {
      if (!currentProjectPath || !window.eco) {
        return;
      }
      const trimmedArgs = args?.trim();
      const trimmedPrefix = prefix?.trim();
      const dismissStartedAt = performance.now();
      dismissPackageScriptRunOverlays();
      setScriptsBusy(true);
      try {
        const result = await window.eco.startPackageScript({
          workspacePath: currentProjectPath,
          script: scriptName,
          ...(trimmedArgs && { args: trimmedArgs }),
          ...(trimmedPrefix && { prefix: trimmedPrefix }),
          ...(activeThread?.id && { threadId: activeThread.id }),
        });
        const scriptMeta = {
          command: result.commandLabel || result.command.join(" "),
          projectName: currentProjectName,
        };
        trackPackageScriptTerminalSession(result.sessionId, scriptMeta, result.taskId);
        void refreshBackgroundTerminalTasks();
        await waitForOverlayDismiss(dismissStartedAt);
        openTerminalSessionTab(currentProjectPath, result.sessionId);
        void syncPackageScriptTerminalPresentation(result.sessionId, result.taskId);
      } catch (error) {
        console.error(error);
      } finally {
        setScriptsBusy(false);
      }
    },
    [
      activeThread?.id,
      currentProjectName,
      currentProjectPath,
      dismissPackageScriptRunOverlays,
      openTerminalSessionTab,
      refreshBackgroundTerminalTasks,
      syncPackageScriptTerminalPresentation,
      trackPackageScriptTerminalSession,
    ],
  );

  useEffect(() => {
    const onFocus = () => {
      void refreshGitStatus();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refreshGitStatus]);

  useEffect(() => {
    if (!currentProjectPath || !window.eco?.onGitRemoteFetched) {
      return undefined;
    }
    return window.eco.onGitRemoteFetched((workspacePath) => {
      if (workspacePath === currentProjectPath) {
        void refreshGitStatus(workspacePath, { force: true });
      }
    });
  }, [currentProjectPath, refreshGitStatus]);

  useEffect(() => {
    if (!window.eco) {
      return;
    }
    void window.eco.getGitSettings().then(setGitSettings);
    void window.eco.getPersonalizationSettings().then(setPersonalizationSettings);
    void window.eco.getBrowserSettings?.().then(setBrowserSettings);
    void window.eco.getComputerUseSettings?.().then(setComputerUseSettings);
    void window.eco
      .getTtsSettings?.()
      .then(setTtsSettings)
      .catch((caught) => setError(errorMessage(caught)));
    void window.eco.getImageGenerationSettings?.().then(setImageGenerationSettings);
    void window.eco.getIntegrationAvailability?.().then(setIntegrationAvailability);
    void window.eco.getWebChatList?.().then(setWebChatList);
    void window.eco.getSshBookmarks?.().then(setSshBookmarks);
    void window.eco.getNotificationSettings?.().then(setNotificationSettings);
    void browserStateStore.hydrate();
    asrBusyRef.current = true;
    setAsrBusy(true);
    void window.eco
      .listAsrProfiles()
      .then((snapshot) => {
        setAsrProfiles(snapshot);
        setAsrSettingsLoadError(undefined);
      })
      .catch((caught: unknown) => {
        setAsrSettingsLoadError(caught instanceof Error ? caught.message : "");
      })
      .finally(() => {
        asrBusyRef.current = false;
        setAsrBusy(false);
      });
  }, []);

  useEffect(() => {
    if (!settingsOpen || settingsSection !== "skills" || !window.eco) {
      return;
    }
    void refreshSkillsList();
  }, [settingsOpen, settingsSection]);

  useEffect(() => {
    const eco = window.eco;
    if (!eco?.onOpenAIAccountsChanged) return;
    let alive = true;
    let revision = 0;
    const unsubscribe = eco.onOpenAIAccountsChanged(() => {
      const requestedRevision = ++revision;
      void eco
        .getIntegrationAvailability()
        .then((snapshot) => {
          if (alive && requestedRevision === revision) setIntegrationAvailability(snapshot);
        })
        .catch((caught) => {
          if (alive && requestedRevision === revision) setError(errorMessage(caught));
        });
    });
    return () => {
      alive = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!settingsOpen || settingsSection !== "defaultAgent") {
      return;
    }
    void refreshCoreAvailability();
  }, [settingsOpen, settingsSection, refreshCoreAvailability]);

  useEffect(() => {
    if (!window.eco) {
      return;
    }
    void refreshSkillsList(currentProjectPath);
    void refreshCursorAgentsList(currentProjectPath);
  }, [currentProjectPath]);

  useEffect(() => {
    if (!window.eco || !currentProjectPath) {
      setProjectMcpSettings(undefined);
      setProjectIntegrationsSettings(undefined);
      setProjectOrchestrationSettings(undefined);
      setProjectSkillsSettings(undefined);
      return;
    }
    let cancelled = false;
    setProjectMcpSettings(undefined);
    setProjectIntegrationsSettings(undefined);
    setProjectOrchestrationSettings(undefined);
    void window.eco
      .getProjectMcpSettings(currentProjectPath)
      .then((snapshot) => {
        if (!cancelled) setProjectMcpSettings(snapshot);
      })
      .catch((caught) => {
        if (!cancelled) setError(errorMessage(caught));
      });
    void window.eco
      .getProjectIntegrationsSettings(currentProjectPath)
      .then((snapshot) => {
        if (!cancelled) setProjectIntegrationsSettings(snapshot);
      })
      .catch((caught) => {
        if (!cancelled) setError(errorMessage(caught));
      });
    void window.eco
      .getProjectOrchestrationSettings(currentProjectPath)
      .then((snapshot) => {
        if (!cancelled) setProjectOrchestrationSettings(snapshot);
      })
      .catch((caught) => {
        if (!cancelled) setError(errorMessage(caught));
      });
    void window.eco
      .getProjectSkillsSettings(currentProjectPath)
      .then((snapshot) => {
        if (!cancelled) setProjectSkillsSettings(snapshot);
      })
      .catch((caught) => {
        if (!cancelled) setError(errorMessage(caught));
      });
    return () => {
      cancelled = true;
    };
  }, [currentProjectPath]);

  useEffect(() => {
    setComposerPlusMenuOpen(false);
    setComposerRoutePopoverOpen(false);
    setScheduledMessageEditor(undefined);
  }, [activeThread?.id, currentProjectPath]);

  // Cursor ACP is available when CLI probe succeeds (legacy acpAgentsEnabled switch has no UI).
  const showAcpCursor = coreAvailability?.cursor.available === true;

  useEffect(() => {
    if (showAcpCursor) refreshCursorModels();
  }, [showAcpCursor, refreshCursorModels]);

  useEffect(() => {
    const next = resolveDraftCoreKindWhenAcpHidden({
      draftCoreKind: newThreadCoreKind,
      coreAvailabilityResolved: coreAvailability !== undefined,
      showAcpCursor,
      selectionInFlight: acpEnableInFlight || cursorProbeLoading,
      ...(workflowSettings.defaultCoreKind !== undefined
        ? { defaultCoreKind: workflowSettings.defaultCoreKind }
        : {}),
    });
    if (next !== undefined) {
      setNewThreadCoreKind(next);
    }
  }, [
    newThreadCoreKind,
    showAcpCursor,
    coreAvailability,
    acpEnableInFlight,
    cursorProbeLoading,
    workflowSettings.defaultCoreKind,
  ]);

  const composerCoreKind = activeThread?.coreKind ?? newThreadCoreKind;
  const effectiveDefaultOrchestrationSelection = workflowSettings.defaultOrchestrationSelection;
  const projectOrchestrationSelection =
    projectOrchestrationSettings?.workspacePath === currentProjectPath
      ? projectOrchestrationSettings?.orchestrationSelection
      : undefined;
  const composerAvailableSkills = useMemo(() => {
    const projectSkills = skillsSnapshot?.projectSkills ?? [];
    const userSkills = skillsSnapshot?.userSkills ?? [];
    const candidates =
      composerCoreKind === "codex"
        ? [...projectSkills, ...userSkills].filter((skill) =>
            isSkillAvailableForCore(skill, composerCoreKind),
          )
        : [
            ...listSdkReadyProjectSkills(projectSkills),
            ...dedupeSkillsByName(
              userSkills.filter((skill) => isSkillAvailableForCore(skill, composerCoreKind)),
            ),
          ];
    return [
      ...new Map(candidates.map((skill) => [skill.settingsKey ?? skill.skillFilePath, skill])).values(),
    ];
  }, [composerCoreKind, skillsSnapshot?.projectSkills, skillsSnapshot?.userSkills]);
  const composerSkillsEnabled = useMemo(
    () =>
      deriveSkillsEnabled(composerAvailableSkills, {
        ...(activeThread && composerRuntimeConfig?.skillsEnabled
          ? { existing: composerRuntimeConfig.skillsEnabled }
          : {}),
        ...(projectSkillsSettings?.enabledByPath ? { remembered: projectSkillsSettings.enabledByPath } : {}),
      }),
    [
      activeThread?.id,
      composerAvailableSkills,
      composerRuntimeConfig?.skillsEnabled,
      projectSkillsSettings?.enabledByPath,
    ],
  );
  const slashPickerSkills = useMemo(
    () =>
      dedupeSkillsByName(
        composerAvailableSkills.filter(
          (skill) => composerSkillsEnabled[skill.settingsKey ?? skill.skillFilePath],
        ),
      ),
    [composerAvailableSkills, composerSkillsEnabled],
  );
  const composerSupportsSkills = true;
  const projectAgentsOnly = useMemo(
    () =>
      composerCoreKind === "claude"
        ? (skillsSnapshot?.agentsOnlySkills ?? []).filter((skill) => skill.source === "project")
        : [],
    [composerCoreKind, skillsSnapshot?.agentsOnlySkills],
  );
  const projectCoreSkills = useMemo(
    () => composerAvailableSkills.filter((skill) => skill.source === "project"),
    [composerAvailableSkills],
  );
  const showProjectSkillsPanel =
    Boolean(currentProjectPath) &&
    (isLoadingSkills || projectCoreSkills.length > 0 || projectAgentsOnly.length > 0);
  const composerSkillSlash = useMemo(() => parseSlashQuery(prompt, composerCursor), [prompt, composerCursor]);
  const referencedSkillNames = useMemo(() => new Set(parseExplicitSkillNames(prompt)), [prompt]);
  const composerSkillMatches = useMemo(() => {
    if (!composerSkillSlash) {
      return [];
    }
    return filterSkillsForSlash(composerSkillSlash.query, slashPickerSkills, referencedSkillNames);
  }, [composerSkillSlash, slashPickerSkills, referencedSkillNames]);
  const composerSkillPopoverOpen =
    composerSupportsSkills && Boolean(composerSkillSlash) && slashPickerSkills.length > 0;

  useEffect(() => {
    setComposerSkillActiveIndex(Math.max(0, composerSkillMatches.length - 1));
  }, [composerSkillSlash?.query, composerSkillSlash?.start, composerSkillMatches.length]);

  const buildComposerDefaultConfig = useCallback(
    (options?: {
      planModeOverride?: boolean;
      workflowDefaults?: WorkflowSettingsSnapshot;
      orchestrationSelection?: OrchestrationSelection;
    }): ThreadRuntimeConfig | undefined => {
      if (settings.mainAgentConfigs.length === 0) {
        return undefined;
      }
      try {
        const defaults = options?.workflowDefaults ?? workflowSettings;
        if (currentProjectPath && projectOrchestrationSettings?.workspacePath !== currentProjectPath) {
          return undefined;
        }
        const projectMcpServersEnabled =
          projectMcpSettings?.workspacePath === currentProjectPath
            ? projectMcpSettings?.enabledByServer
            : undefined;
        const rememberedMcpServersEnabled =
          projectMcpServersEnabled && Object.keys(projectMcpServersEnabled).length > 0
            ? projectMcpServersEnabled
            : defaults.mcpServersEnabled;
        const rememberedIntegrationsEnabled =
          projectIntegrationsSettings && projectIntegrationsSettings.workspacePath === currentProjectPath
            ? projectIntegrationsSettings.enabled
            : defaults.integrationsEnabled;
        const orchestrationSelection =
          options?.orchestrationSelection ??
          projectOrchestrationSelection ??
          defaults.defaultOrchestrationSelection;
        if (!hasCompleteOrchestrationSelection(orchestrationSelection)) {
          return undefined;
        }
        const workflowDefaults =
          options?.planModeOverride === undefined
            ? {
                ...defaults,
                ...(rememberedMcpServersEnabled ? { mcpServersEnabled: rememberedMcpServersEnabled } : {}),
                ...(rememberedIntegrationsEnabled
                  ? { integrationsEnabled: rememberedIntegrationsEnabled }
                  : {}),
              }
            : {
                ...defaults,
                sessionMode: options.planModeOverride ? ("plan" as const) : ("agent" as const),
                ...(rememberedMcpServersEnabled ? { mcpServersEnabled: rememberedMcpServersEnabled } : {}),
                ...(rememberedIntegrationsEnabled
                  ? { integrationsEnabled: rememberedIntegrationsEnabled }
                  : {}),
              };
        return buildThreadRuntimeConfigFromDefaults({
          settings,
          workflowDefaults,
          mcpServers: mcpSettings.servers,
          orchestrationSelection,
        });
      } catch {
        return undefined;
      }
    },
    [
      settings,
      workflowSettings,
      mcpSettings.servers,
      currentProjectPath,
      projectMcpSettings,
      projectIntegrationsSettings,
      projectOrchestrationSelection,
      projectOrchestrationSettings?.workspacePath,
    ],
  );

  const resetComposerDefaultConfig = useCallback(() => {
    setComposerRuntimeConfig(buildComposerDefaultConfig() ?? null);
  }, [buildComposerDefaultConfig]);

  useEffect(() => {
    if (activeThread?.runtimeConfig) {
      setComposerRuntimeConfig((current) => {
        const next = activeThread.runtimeConfig!;
        return current && threadRuntimeConfigsEquivalent(current, next) ? current : next;
      });
      return;
    }
    if (composerCoreKind === "acp") {
      setComposerRuntimeConfig((current) => {
        const keepDraftModel =
          Boolean(current) && !hasCompleteOrchestrationSelection(current?.orchestrationSelection);
        const next = buildAcpThreadRuntimeConfig({
          ...(keepDraftModel && current?.cursorModelId
            ? { cursorModelId: current.cursorModelId }
            : !keepDraftModel && (current?.cursorModelId ?? workflowSettings.acpCursorModelId)
              ? { cursorModelId: current?.cursorModelId ?? workflowSettings.acpCursorModelId }
              : {}),
          sessionMode: current?.sessionMode ?? workflowSettings.sessionMode,
          bashReviewMode: current?.bashReviewMode ?? "always",
          ...(current?.subagentEnabled ? { subagentEnabled: current.subagentEnabled } : {}),
          ...((current?.auxiliaryModel ?? workflowSettings.defaultAuxiliaryModel)
            ? { auxiliaryModel: current?.auxiliaryModel ?? workflowSettings.defaultAuxiliaryModel }
            : {}),
          ...((current?.approvalModel ?? workflowSettings.defaultApprovalModel)
            ? { approvalModel: current?.approvalModel ?? workflowSettings.defaultApprovalModel }
            : {}),
          ...((current?.visionModel ?? workflowSettings.defaultVisionModel)
            ? { visionModel: current?.visionModel ?? workflowSettings.defaultVisionModel }
            : {}),
          ...(current?.mcpServersEnabled ? { mcpServersEnabled: current.mcpServersEnabled } : {}),
          ...(current?.integrationsEnabled ? { integrationsEnabled: current.integrationsEnabled } : {}),
          ...(current?.skillsEnabled ? { skillsEnabled: current.skillsEnabled } : {}),
        });
        return current && threadRuntimeConfigsEquivalent(current, next) ? current : next;
      });
      return;
    }
    if (settings.mainAgentConfigs.length === 0) {
      setComposerRuntimeConfig((current) => (current ? null : current));
      return;
    }
    setComposerRuntimeConfig((current) => {
      if (
        current?.orchestrationSelection &&
        hasCompleteOrchestrationSelection(current.orchestrationSelection)
      ) {
        try {
          const refreshed = materializeThreadOrchestrationSnapshot(settings, current.orchestrationSelection);
          const next: ThreadRuntimeConfig = {
            ...current,
            ...refreshed,
            subagentEnabled: deriveSubagentEnabledFromSnapshot(
              refreshed.resolvedOrchestrationSnapshot!,
              current.subagentEnabled,
            ),
          };
          return threadRuntimeConfigsEquivalent(current, next) ? current : next;
        } catch {
          return current;
        }
      }
      const defaults = buildComposerDefaultConfig();
      if (!defaults) {
        return current;
      }
      return current && threadRuntimeConfigsEquivalent(current, defaults) ? current : defaults;
    });
  }, [
    activeThread?.id,
    activeThread?.runtimeConfig,
    buildComposerDefaultConfig,
    composerCoreKind,
    settings.mainAgentConfigs,
    settings.mainAgentPrompts,
    settings.subagentOrchestrations,
    workflowSettings.acpCursorModelId,
    workflowSettings.sessionMode,
  ]);

  const selectedOrchestrationSnapshot = useMemo(
    () =>
      composerRuntimeConfig ? resolveThreadOrchestrationSnapshot(settings, composerRuntimeConfig) : undefined,
    [settings, composerRuntimeConfig],
  );
  // "指定子代理执行已批准计划": the delegation roster shown on the plan card comes from
  // the thread's locked orchestration snapshot (the host re-validates before arming).
  const planDelegationAgents = useMemo<readonly PlanDelegationAgentOption[]>(
    () => listPlanDelegationAgents(selectedOrchestrationSnapshot),
    [selectedOrchestrationSnapshot],
  );
  const composerMcpSettings = useMemo(() => {
    const availableServerKeys = listEnabledGlobalMcpServerKeys(mcpSettings.servers);
    if (availableServerKeys.length === 0) {
      return {};
    }
    const projectMcpServersEnabled =
      projectMcpSettings?.workspacePath === currentProjectPath
        ? projectMcpSettings?.enabledByServer
        : undefined;
    const projectRemembered =
      projectMcpServersEnabled && Object.keys(projectMcpServersEnabled).length > 0
        ? projectMcpServersEnabled
        : workflowSettings.mcpServersEnabled;
    return deriveMcpServersEnabled(availableServerKeys, {
      ...(composerRuntimeConfig?.mcpServersEnabled
        ? { existing: composerRuntimeConfig.mcpServersEnabled }
        : {}),
      ...(projectRemembered ? { remembered: projectRemembered } : {}),
    });
  }, [
    composerRuntimeConfig?.mcpServersEnabled,
    currentProjectPath,
    mcpSettings.servers,
    projectMcpSettings,
    workflowSettings.mcpServersEnabled,
  ]);
  const composerIntegrationSettings = useMemo(
    () =>
      composerRuntimeConfig?.integrationsEnabled ??
      (projectIntegrationsSettings && projectIntegrationsSettings.workspacePath === currentProjectPath
        ? projectIntegrationsSettings.enabled
        : workflowSettings.integrationsEnabled) ??
      {},
    [
      composerRuntimeConfig?.integrationsEnabled,
      currentProjectPath,
      projectIntegrationsSettings,
      workflowSettings.integrationsEnabled,
    ],
  );
  const effectiveComposerRuntimeConfig = useMemo(
    () =>
      buildEffectiveComposerRuntimeConfig(composerRuntimeConfig, {
        hasThread: Boolean(activeThread),
        skillsEnabled: composerSkillsEnabled,
        mcpServersEnabled: composerMcpSettings,
        integrationsEnabled: composerIntegrationSettings,
      }),
    [
      activeThread?.id,
      composerRuntimeConfig,
      composerIntegrationSettings,
      composerMcpSettings,
      composerSkillsEnabled,
    ],
  );
  const resolveComposerRuntimeConfigForSend = useCallback((): ThreadRuntimeConfig | null => {
    const base = effectiveComposerRuntimeConfig ?? composerRuntimeConfig;
    if (composerCoreKind === "acp") {
      const resolvedCursorModelId = resolveAcpCursorModelIdForSend({
        runtimeConfig: base,
        ...(workflowSettings.acpCursorModelId !== undefined
          ? { workflowDefault: workflowSettings.acpCursorModelId }
          : {}),
      });
      return buildAcpThreadRuntimeConfig({
        ...(resolvedCursorModelId ? { cursorModelId: resolvedCursorModelId } : {}),
        sessionMode: base?.sessionMode ?? workflowSettings.sessionMode,
        bashReviewMode:
          base?.bashReviewMode ?? normalizeBashReviewMode(workflowSettings.defaultBashReviewMode),
        ...(base?.subagentEnabled ? { subagentEnabled: base.subagentEnabled } : {}),
        ...((base?.auxiliaryModel ?? workflowSettings.defaultAuxiliaryModel)
          ? { auxiliaryModel: base?.auxiliaryModel ?? workflowSettings.defaultAuxiliaryModel }
          : {}),
        ...((base?.approvalModel ?? workflowSettings.defaultApprovalModel)
          ? { approvalModel: base?.approvalModel ?? workflowSettings.defaultApprovalModel }
          : {}),
        ...((base?.visionModel ?? workflowSettings.defaultVisionModel)
          ? { visionModel: base?.visionModel ?? workflowSettings.defaultVisionModel }
          : {}),
        ...(base?.mcpServersEnabled ? { mcpServersEnabled: base.mcpServersEnabled } : {}),
        ...(base?.integrationsEnabled ? { integrationsEnabled: base.integrationsEnabled } : {}),
        ...(base?.skillsEnabled ? { skillsEnabled: base.skillsEnabled } : {}),
      });
    }
    const sessionSelection =
      base?.orchestrationSelection && hasCompleteOrchestrationSelection(base.orchestrationSelection)
        ? base.orchestrationSelection
        : undefined;
    const selection = activeThread
      ? sessionSelection
      : (sessionSelection ??
        (hasCompleteOrchestrationSelection(projectOrchestrationSelection)
          ? projectOrchestrationSelection
          : undefined) ??
        (hasCompleteOrchestrationSelection(workflowSettings.defaultOrchestrationSelection)
          ? workflowSettings.defaultOrchestrationSelection
          : undefined));
    if (!hasCompleteOrchestrationSelection(selection)) {
      return null;
    }
    try {
      const shell =
        base ??
        buildThreadRuntimeConfigFromDefaults({
          settings,
          workflowDefaults: workflowSettings,
          orchestrationSelection: selection,
          mcpServers: mcpSettings.servers,
        });
      const lockedSnapshot = activeThread ? base?.resolvedOrchestrationSnapshot : undefined;
      const materialized = lockedSnapshot
        ? {
            orchestrationSelection: selection,
            resolvedOrchestrationSnapshot: lockedSnapshot,
          }
        : materializeThreadOrchestrationSnapshot(settings, selection);
      return {
        ...shell,
        ...materialized,
        ...(base?.mainAgentModelOverride ? { mainAgentModelOverride: base.mainAgentModelOverride } : {}),
        ...(base?.mainAgentSystemPromptPresetOverride
          ? { mainAgentSystemPromptPresetOverride: base.mainAgentSystemPromptPresetOverride }
          : {}),
        ...(effectiveComposerRuntimeConfig?.mcpServersEnabled
          ? { mcpServersEnabled: effectiveComposerRuntimeConfig.mcpServersEnabled }
          : {}),
        ...(effectiveComposerRuntimeConfig?.skillsEnabled
          ? { skillsEnabled: effectiveComposerRuntimeConfig.skillsEnabled }
          : {}),
        subagentEnabled: deriveSubagentEnabledFromSnapshot(
          materialized.resolvedOrchestrationSnapshot!,
          base?.subagentEnabled ?? shell.subagentEnabled,
        ),
        sessionMode: base?.sessionMode ?? shell.sessionMode,
        bashReviewMode: base?.bashReviewMode ?? shell.bashReviewMode,
      };
    } catch {
      return null;
    }
  }, [
    composerRuntimeConfig,
    composerCoreKind,
    effectiveComposerRuntimeConfig,
    activeThread,
    mcpSettings.servers,
    settings,
    workflowSettings,
    projectOrchestrationSelection,
  ]);
  // Built-in OpenAI (auth.json) is Codex-exclusive; other kernels cannot call it via the gateway.
  const composerUsableProviders = useMemo(
    () =>
      composerCoreKind === "codex"
        ? settings.providers
        : settings.providers.filter((provider) => !isBuiltInOpenAiProvider(provider)),
    [composerCoreKind, settings.providers],
  );
  const templateMainModel = useMemo<ComposerModelOption | undefined>(() => {
    if (!selectedOrchestrationSnapshot) {
      return undefined;
    }
    const route = runtimeRoleRoutesFromOrchestrationSnapshot(selectedOrchestrationSnapshot).find(
      (candidate) => candidate.role === "main",
    );
    if (!route) {
      return undefined;
    }
    // Built-in OpenAI (auth.json) is only usable with the Codex kernel.
    const provider = composerUsableProviders.find((candidate) => candidate.id === route.providerId);
    if (!provider) {
      return undefined;
    }
    return {
      providerId: route.providerId,
      providerName: provider.name.trim() || route.providerId,
      modelId: route.modelId,
      ...(route.candidateModelId ? { candidateModelId: route.candidateModelId } : {}),
      ...(route.thinkingEffort ? { thinkingEffort: route.thinkingEffort } : {}),
    };
  }, [composerUsableProviders, selectedOrchestrationSnapshot]);
  const composerModelProvider = templateMainModel
    ? composerUsableProviders.find((provider) => provider.id === templateMainModel.providerId)
    : undefined;
  const composerModelProviderId = composerModelProvider?.enabled ? composerModelProvider.id : undefined;
  const composerMainAgentModelOverride = resolveMainAgentModelOverrideForProvider(
    templateMainModel?.providerId,
    composerRuntimeConfig?.mainAgentModelOverride,
  );
  const refreshComposerCandidateModels = useCallback(() => {
    setComposerModelsRefreshNonce((current) => current + 1);
  }, []);

  useEffect(() => {
    const eco = window.eco;
    if (!eco || !composerModelProviderId) {
      setComposerCandidateModels([]);
      setComposerModelsError(undefined);
      setComposerModelsLoading(false);
      return;
    }
    let cancelled = false;
    setComposerModelsError(undefined);
    setComposerModelsLoading(true);
    void eco
      .listCandidateModels(composerModelProviderId)
      .then((candidates) => {
        if (!cancelled) {
          setComposerCandidateModels(candidates);
        }
      })
      .catch((caught) => {
        if (!cancelled) {
          setComposerCandidateModels([]);
          setComposerModelsError(t("app.candidateModelsFailed", { detail: errorMessage(caught) }));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setComposerModelsLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [composerModelProviderId, composerModelsRefreshNonce]);

  const composerModelOptions = useMemo<ComposerModelOption[]>(() => {
    return templateMainModel
      ? buildComposerModelOptions({
          provider: composerModelProvider,
          candidates: composerCandidateModels,
          templateModel: templateMainModel,
        })
      : [];
  }, [composerCandidateModels, composerModelProvider, templateMainModel]);
  const activeRoutes = useMemo(() => {
    return selectedOrchestrationSnapshot
      ? runtimeRoleRoutesFromOrchestrationSnapshot(
          selectedOrchestrationSnapshot,
          composerMainAgentModelOverride,
        )
      : [];
  }, [composerMainAgentModelOverride, selectedOrchestrationSnapshot]);

  useEffect(() => {
    if (!window.eco || activeRoutes.length === 0) {
      setRoutePricingHints([]);
      return;
    }
    void window.eco.getRoutePricing(activeRoutes).then(setRoutePricingHints);
  }, [activeRoutes, settings.providers]);

  useEffect(() => {
    if (!window.eco?.getRouteCapabilities || activeRoutes.length === 0) {
      return;
    }
    void window.eco.getRouteCapabilities(activeRoutes).then((hints) => {
      setPlannerCapability(hints.find((hint) => hint.role === "main"));
    });
  }, [activeRoutes, settings.providers]);
  const providerById = useMemo(
    () => new Map(settings.providers.map((provider) => [provider.id, provider])),
    [settings.providers],
  );
  const routesReady = selectedOrchestrationSnapshot
    ? isOrchestrationSnapshotReady(
        selectedOrchestrationSnapshot,
        providerById,
        composerMainAgentModelOverride,
      )
    : false;
  const orchestrationIssues = useMemo(
    () =>
      selectedOrchestrationSnapshot
        ? diagnoseOrchestrationSnapshotReadiness(
            selectedOrchestrationSnapshot,
            providerById,
            composerMainAgentModelOverride,
          )
        : [],
    [composerMainAgentModelOverride, providerById, selectedOrchestrationSnapshot, t],
  );
  const invalidOrchestrationFields = useMemo(
    () => invalidOrchestrationFieldsFromIssues(orchestrationIssues),
    [orchestrationIssues],
  );
  const primaryOrchestrationIssue = orchestrationIssues[0];
  const composerModelAvailability = resolveComposerModelAvailability(
    composerUsableProviders,
    templateMainModel,
    composerCoreKind,
  );
  const composerNeedsOrchestration = composerRequiresOrchestration(composerCoreKind);
  const composerShowsRoute = composerShowsRouteConfig(composerCoreKind);
  const composerRoutesReady = !composerNeedsOrchestration || routesReady;
  const threadAcceptsInput = !activeThread || isContinuableThreadStatus(activeThread.status);
  const composerFollowUpMode = Boolean(
    activeThread &&
      shouldComposerUseFollowUpQueue({
        status: activeThread.status,
        ...(editingFollowUpId !== undefined ? { editingFollowUpId } : {}),
        ...(activeThread.followUpQueuePaused !== undefined
          ? { followUpQueuePaused: activeThread.followUpQueuePaused }
          : {}),
      }),
  );
  const showBashApproval = Boolean(pendingBashApproval);
  const composerHasContent = Boolean(prompt.trim() || composerAttachments.length > 0);
  const activeConversationV2 = activeThread ? conversationV2ByThread[activeThread.id] : undefined;
  // A verified sync cursor can advance without any Feed content changing.
  // Pass the projector's content fields so receipt-only batches reuse it.
  const v2RunProjection = useMemo(
    () =>
      activeConversationV2?.conversationId !== undefined
        ? buildConversationV2OnlyProjection(
            {
              conversationId: activeConversationV2.conversationId,
              messages: activeConversationV2.messages,
              runs: activeConversationV2.runs,
              agents: activeConversationV2.agents,
              tools: activeConversationV2.tools,
              details: activeConversationV2.details,
              historyRevision: activeConversationV2.historyRevision,
              ...(activeConversationV2.projectionExtras
                ? { projectionExtras: activeConversationV2.projectionExtras }
                : {}),
            },
            activeThread?.createdAt !== undefined
              ? { createdAt: activeThread.createdAt, status: activeThread.status }
              : undefined,
          )
        : undefined,
    [
      activeConversationV2?.conversationId,
      activeConversationV2?.messages,
      activeConversationV2?.runs,
      activeConversationV2?.agents,
      activeConversationV2?.tools,
      activeConversationV2?.details,
      activeConversationV2?.projectionExtras,
      activeConversationV2?.historyRevision,
      activeThread?.createdAt,
      activeThread?.status,
    ],
  );
  // V2 is the only renderer projection source. A missing V2 state is a visible
  // bootstrap/recovery condition; it never falls back to a legacy projection or
  // local stream overlay.
  const runProjection = v2RunProjection;
  const runProjectionRef = useRef(runProjection);
  runProjectionRef.current = runProjection;
  const displayProjection = runProjection;
  const contextCompactionInFlight = isThreadContextCompactionInFlight(runProjection);
  const autoCompactSuspended = isThreadAutoCompactSuspended(runProjection);
  const promptCacheInvalidated =
    promptCacheTipPreferences.enabled && isThreadPromptCacheInvalidated(runProjection);
  const promptCacheBaselineByThreadRef = useRef<Record<string, ThreadRuntimeConfig>>({});
  const [promptCacheBaselineVersion, setPromptCacheBaselineVersion] = useState(0);

  useEffect(() => {
    const threadId = activeThread?.id;
    const runtimeConfig = activeThread?.runtimeConfig;
    if (!threadId || !runtimeConfig || !runProjection?.timeline.length) {
      return;
    }
    if (promptCacheBaselineByThreadRef.current[threadId]) {
      return;
    }
    promptCacheBaselineByThreadRef.current[threadId] = runtimeConfig;
    setPromptCacheBaselineVersion((current) => current + 1);
  }, [activeThread?.id, activeThread?.runtimeConfig, runProjection?.timeline.length]);

  const composerPromptCacheDrift = useMemo(() => {
    const threadId = activeThread?.id;
    if (!threadId || !composerRuntimeConfig || !runProjection?.timeline.length) {
      return null;
    }
    const baseline = promptCacheBaselineByThreadRef.current[threadId];
    if (!baseline) {
      return null;
    }
    const drift = resolvePromptCacheConfigDrift({
      baseline,
      current: composerRuntimeConfig,
      settings,
      mcpServers: mcpSettings.servers,
    });
    return drift.length > 0 ? drift : null;
  }, [
    activeThread?.id,
    composerRuntimeConfig,
    mcpSettings.servers,
    promptCacheBaselineVersion,
    runProjection?.timeline.length,
    settings,
  ]);
  const composerPromptCacheOrchestrationLabel =
    composerPromptCacheDrift?.includes("orchestration") && composerRuntimeConfig
      ? resolvePromptCacheOrchestrationLabel(settings, composerRuntimeConfig)
      : undefined;
  const composerPromptCacheHint =
    promptCacheTipPreferences.enabled && composerPromptCacheDrift
      ? formatPromptCacheConfigDriftHint(
          composerPromptCacheDrift,
          composerPromptCacheOrchestrationLabel
            ? { orchestrationLabel: composerPromptCacheOrchestrationLabel }
            : undefined,
        )
      : null;
  const threadIdleCacheWarningEligible = Boolean(
    promptCacheTipPreferences.enabled &&
      activeThread &&
      runProjection?.timeline.length &&
      isContinuableThreadStatus(activeThread.status),
  );
  const threadIdleCacheWarningActivityAt = runProjection
    ? resolveLatestThreadActivityAt(runProjection.timeline)
    : undefined;

  function saveComposerDraftInBackground(
    contextKey: string,
    value: string,
    attachments: readonly ComposerImageAttachment[],
  ): void {
    if (typeof window.eco?.saveComposerDraft !== "function") {
      return;
    }
    void window.eco
      .saveComposerDraft({
        contextKey,
        prompt: value,
        ...(attachments.length > 0 ? { attachments: toPromptImageAttachments(attachments) } : {}),
      })
      .catch((caught) => {
        console.error("[eco] composer draft save failed", caught);
      });
  }

  function removeComposerDraft(
    contextKey: string | undefined,
    options?: { releaseAttachments?: boolean },
  ): void {
    clearComposerDraft(composerDraftsByKeyRef.current, contextKey);
    if (!contextKey) {
      return;
    }
    if (composerContextKeyRef.current === contextKey) {
      composerPromptRef.current = "";
    }
    const pending = composerDraftSaveTimerRef.current;
    if (pending?.key === contextKey) {
      window.clearTimeout(pending.timer);
      composerDraftSaveTimerRef.current = undefined;
    }
    if (typeof window.eco?.deleteComposerDraft !== "function") {
      return;
    }
    // Send handoff must keep spool files until main persists them into message storage.
    const releaseAttachments = options?.releaseAttachments !== false;
    void window.eco
      .deleteComposerDraft(releaseAttachments ? contextKey : { contextKey, releaseAttachments: false })
      .catch((caught) => {
        console.error("[eco] composer draft delete failed", caught);
      });
  }

  const canSendFollowUp = Boolean(
    currentProjectPath &&
      activeThread &&
      composerFollowUpMode &&
      composerHasContent &&
      !followUpBusy &&
      !isStarting &&
      !planActionBusy &&
      !contextCompactionInFlight,
  );
  const canSendThreadMessage = Boolean(
    currentProjectPath &&
      composerHasContent &&
      composerRoutesReady &&
      !isStarting &&
      !planActionBusy &&
      !clarificationBusy &&
      !bashApprovalBusy &&
      !pendingClarification &&
      !pendingBashApproval &&
      !contextCompactionInFlight &&
      threadAcceptsInput,
  );
  const canSend = composerFollowUpMode ? canSendFollowUp : canSendThreadMessage;
  // Forced delegation retains the plan for retry until the child finishes.
  // That retained record must not keep the approval dock open during execution.
  const showPlanApproval = Boolean(
    activeThread && pendingPlan && activeThread.status !== "running" && activeThread.status !== "queued",
  );
  const showClarification = Boolean(pendingClarification);
  const showComposerDockApproval = showBashApproval || showPlanApproval || showClarification;
  const composerDockSurfaceKey = showBashApproval
    ? `bash-${pendingBashApproval!.toolUseId}`
    : showPlanApproval
      ? `plan-${activeThread?.id ?? "unknown"}`
      : showClarification
        ? `clarification-${pendingClarification!.toolUseId}`
        : "composer";

  const planFailureMessage = activeThread ? extractPlanFailureMessage(activeThread.message) : undefined;

  useEffect(() => {
    const prevKey = prevComposerContextKeyRef.current;
    if (prevKey !== undefined && prevKey !== composerContextKey) {
      persistComposerDraftSnapshot(composerDraftsByKeyRef.current, prevKey, {
        prompt: composerPromptRef.current,
        attachments: composerAttachmentsRef.current,
        ...(composerRewindTargetRef.current ? { rewindTarget: composerRewindTargetRef.current } : {}),
      });
      saveComposerDraftInBackground(prevKey, composerPromptRef.current, composerAttachmentsRef.current);
    }

    if (prevKey !== composerContextKey) {
      const draft = composerContextKey ? composerDraftsByKeyRef.current[composerContextKey] : undefined;
      const threadId = composerContextKey ? threadIdFromComposerContextKey(composerContextKey) : undefined;
      const prevThreadId = prevKey ? threadIdFromComposerContextKey(prevKey) : undefined;
      if (editingFollowUpIdRef.current && prevThreadId) {
        void releaseThreadFollowUpEditingLock(prevThreadId).catch((caught) => setError(errorMessage(caught)));
      }
      const promptResolution = resolveComposerContextPrompt(
        composerContextKey,
        draft?.prompt,
        pendingPlanComposerHandoffRef.current,
      );
      if (promptResolution.handoffConsumed) {
        pendingPlanComposerHandoffRef.current = undefined;
        setComposerRuntimeConfig(
          (current) =>
            resolveComposerPlanRuntimeConfig(current, promptResolution.sessionMode) ??
            buildComposerDefaultConfig({ planModeOverride: false }) ??
            current,
        );
      }
      const nextPrompt = promptResolution.prompt;
      editingFollowUpIdRef.current = undefined;
      editingFollowUpThreadIdRef.current = undefined;
      savedComposerBeforeFollowUpEditRef.current = undefined;
      setEditingFollowUpId(undefined);
      composerPromptRef.current = nextPrompt;
      setPrompt(nextPrompt);
      setComposerAttachments(
        promptResolution.handoffConsumed ? [] : draft?.attachments ? [...draft.attachments] : [],
      );
      setComposerRewindTarget(
        !promptResolution.handoffConsumed &&
          draft?.rewindTarget &&
          (!threadId || draft.rewindTarget.threadId === threadId)
          ? draft.rewindTarget
          : undefined,
      );
      setComposerImageNotice(undefined);
      prevComposerContextKeyRef.current = composerContextKey;

      if (promptResolution.handoffConsumed) {
        window.requestAnimationFrame(() => {
          if (
            composerContextKeyRef.current === composerContextKey &&
            composerPromptRef.current === nextPrompt
          ) {
            composerRef.current?.focus();
          }
        });
      }

      const requestId = ++composerDraftLoadRequestRef.current;
      if (
        promptResolution.shouldLoadPersistedDraft &&
        composerContextKey &&
        typeof window.eco?.getComposerDraft === "function"
      ) {
        void window.eco
          .getComposerDraft(composerContextKey)
          .then((persisted) => {
            if (
              requestId !== composerDraftLoadRequestRef.current ||
              composerContextKeyRef.current !== composerContextKey ||
              composerPromptRef.current !== nextPrompt ||
              !persisted
            ) {
              return;
            }
            const restored: ComposerDraft = {
              prompt: persisted.prompt,
              attachments: fromPromptImageAttachments(persisted.attachments ?? []),
            };
            composerDraftsByKeyRef.current[composerContextKey] = restored;
            composerPromptRef.current = persisted.prompt;
            setPrompt(persisted.prompt);
            setComposerAttachments(restored.attachments);
          })
          .catch((caught) => {
            console.error("[eco] composer draft load failed", caught);
          });
      }
    }
  }, [composerContextKey]);

  useEffect(() => {
    // Only durable-reference attachments without a renderer-owned preview need a read.
    // A freshly pasted/dropped image already owns a local blob preview, and its staged
    // content reference is not persisted in the draft yet, so reading it back would fail
    // authorization and wrongly report the preview as unavailable.
    const needsPreview = composerAttachments.some(
      (attachment) => attachment.contentRef && !attachment.data && !attachment.previewUrl,
    );
    if (!composerContextKey || !needsPreview) {
      return;
    }
    const readChunk = window.eco?.readPromptImageChunk;
    if (typeof readChunk !== "function") {
      setComposerImageNotice(t("app.imagePreviewUnavailable"));
      return;
    }
    const contextKey = composerContextKey;
    const sourceAttachments = composerAttachments;
    let cancelled = false;
    const isCurrent = () =>
      !cancelled &&
      composerContextKeyRef.current === contextKey &&
      composerAttachmentsRef.current.length === sourceAttachments.length &&
      sourceAttachments.every(
        (attachment, index) => composerAttachmentsRef.current[index] === attachment,
      );
    void hydrateComposerImageAttachments(sourceAttachments, contextKey, (request) => readChunk(request))
      .then((hydrated) => {
        if (!isCurrent()) {
          hydrated.forEach((attachment, index) => {
            if (attachment.previewUrl !== sourceAttachments[index]?.previewUrl) {
              revokeComposerAttachmentPreview(attachment);
            }
          });
          return;
        }
        setComposerAttachments(hydrated);
        setComposerImageNotice(undefined);
      })
      .catch((caught) => {
        if (!isCurrent()) {
          return;
        }
        console.error("[eco] composer image preview load failed", caught);
        setComposerImageNotice(t("app.imagePreviewUnavailable"));
      });
    return () => {
      cancelled = true;
    };
  }, [composerAttachments, composerContextKey, t]);

  useEffect(() => {
    if (
      !composerContextKey ||
      prevComposerContextKeyRef.current !== composerContextKey ||
      composerPromptRef.current !== prompt
    ) {
      return;
    }
    // While a send is in flight the composer is cleared for UX; do not autosave that empty
    // state (empty save deletes the draft and would release still-needed spool images).
    if (isStarting || followUpBusy) {
      const pending = composerDraftSaveTimerRef.current;
      if (pending) {
        window.clearTimeout(pending.timer);
        composerDraftSaveTimerRef.current = undefined;
      }
      return;
    }
    persistComposerDraftSnapshot(composerDraftsByKeyRef.current, composerContextKey, {
      prompt,
      attachments: composerAttachmentsRef.current,
      ...(composerRewindTargetRef.current ? { rewindTarget: composerRewindTargetRef.current } : {}),
    });
    const pending = composerDraftSaveTimerRef.current;
    if (pending) {
      window.clearTimeout(pending.timer);
    }
    const timer = window.setTimeout(() => {
      composerDraftSaveTimerRef.current = undefined;
      saveComposerDraftInBackground(composerContextKey, prompt, composerAttachmentsRef.current);
    }, COMPOSER_DRAFT_SAVE_DEBOUNCE_MS);
    composerDraftSaveTimerRef.current = { key: composerContextKey, timer };
    return () => window.clearTimeout(timer);
  }, [composerAttachments, composerContextKey, followUpBusy, isStarting, prompt]);

  useEffect(() => {
    const flushComposerDraft = () => {
      const contextKey = composerContextKeyRef.current;
      if (contextKey) {
        saveComposerDraftInBackground(contextKey, composerPromptRef.current, composerAttachmentsRef.current);
      }
    };
    const flushHiddenComposerDraft = () => {
      if (document.visibilityState === "hidden") {
        flushComposerDraft();
      }
    };
    window.addEventListener("beforeunload", flushComposerDraft);
    document.addEventListener("visibilitychange", flushHiddenComposerDraft);
    return () => {
      window.removeEventListener("beforeunload", flushComposerDraft);
      document.removeEventListener("visibilitychange", flushHiddenComposerDraft);
    };
  }, []);

  const canStopThread =
    activeThread?.status === "running" ||
    activeThread?.status === "queued" ||
    activeThread?.status === "awaiting_plan";

  // A settled failed/cancelled Codex attempt can start a new empty-input turn.
  // A completed attempt is not an interruption, even when the thread is idle.
  const latestContinueAttempt = displayProjection?.attempts.at(-1);
  const lastRunInterrupted =
    activeThread?.coreKind === "codex" &&
    (latestContinueAttempt?.status === "failed" || latestContinueAttempt?.status === "cancelled") &&
    (activeThread.status === "failed" || activeThread.status === "blocked" || activeThread.status === "idle");

  const composerContinueTarget = useMemo(() => {
    if (!lastRunInterrupted || !activeThread || !threadAcceptsInput || !latestContinueAttempt)
      return undefined;
    const timeline = displayProjection?.timeline ?? [];
    for (let i = timeline.length - 1; i >= 0; i -= 1) {
      const item = timeline[i];
      if (!item) continue;
      const target = readUserPromptRetryIdentity(item, { allowEmptyPrompt: true });
      if (target) return { ...target, sourceAttemptId: latestContinueAttempt.attemptId };
    }
    return undefined;
  }, [lastRunInterrupted, activeThread, threadAcceptsInput, displayProjection, latestContinueAttempt]);

  // Show only for a settled Codex attempt with an empty composer.
  const composerShowContinue =
    Boolean(composerContinueTarget) &&
    !composerHasContent &&
    !composerFollowUpMode &&
    !showComposerDockApproval &&
    composerRoutesReady &&
    !planActionBusy &&
    !contextCompactionInFlight;

  const activeFollowUps = activeThread ? (followUpsByThread[activeThread.id] ?? []) : [];
  const queuedFollowUps = useMemo(() => queuedThreadFollowUps(activeFollowUps), [activeFollowUps]);
  const activeSubagentTimings = activeConversationV2?.projectionExtras?.subagentTimings;
  const activeSubagentMetrics = activeConversationV2?.projectionExtras?.subagentMetrics;
  const coderTodos = activeConversationV2 ? conversationV2TodosToCoderTodos(activeConversationV2) : [];
  const threadModelByRole = useMemo(() => {
    const models: Record<string, string> = {};
    for (const metric of activeSubagentMetrics ?? []) {
      const modelId = metric.modelId?.trim();
      if (modelId && metric.role) {
        models[metric.role] = modelId;
      }
    }
    return models;
  }, [activeSubagentMetrics]);
  const activeRuntimeAgentDisplayNames = useMemo(
    () => buildRuntimeAgentDisplayNames(settings, activeThread?.runtimeConfig),
    [settings, activeThread?.runtimeConfig, t],
  );
  const activeRuntimeAgentThemes = useMemo(
    () => buildRuntimeAgentThemes(settings, activeThread?.runtimeConfig),
    [settings, activeThread?.runtimeConfig],
  );
  const activeProjectionViewModel = useMemo(
    () =>
      activityFeedBootReady && displayProjection
        ? buildThreadRunProjectionViewModel(
            displayProjection,
            activeThread ? { id: activeThread.id, prompt: activeThread.prompt } : undefined,
            {
              agentDisplayNames: activeRuntimeAgentDisplayNames,
              includePromptCacheTips: promptCacheTipPreferences.enabled,
              thinkingDisplayMode: thinkingDisplayPreferences.mode,
            },
          )
        : undefined,
    [
      activityFeedBootReady,
      activeRuntimeAgentDisplayNames,
      activeThread?.id,
      activeThread?.prompt,
      displayProjection,
      promptCacheTipPreferences.enabled,
      thinkingDisplayPreferences.mode,
    ],
  );
  const activeSubagentCards = useMemo(
    () => activeProjectionViewModel?.subagentCards ?? [],
    [activeProjectionViewModel?.subagentCards],
  );
  const activityUserMessageNavItems = useMemo(() => {
    if (!activeThread || !activeProjectionViewModel) {
      return [];
    }
    const drafts: ActivityUserMessageNavItemDraft[] = [];
    let currentDraft: ActivityUserMessageNavItemDraft | undefined;
    if (activeProjectionViewModel.showThreadPrompt && activeThread.prompt.trim()) {
      currentDraft = buildActivityUserMessageNavItem(
        `thread:${activeThread.id}`,
        activeThread.prompt,
        drafts.length,
      );
      drafts.push(currentDraft);
    }
    for (const entry of activeProjectionViewModel.mainFeedEntries) {
      if (entry.kind === "timeline" && isProjectionUserPromptItem(entry.item)) {
        currentDraft = buildActivityUserMessageNavItem(entry.item.id, entry.item.text, drafts.length);
        drafts.push(currentDraft);
        continue;
      }
      if (currentDraft) {
        collectActivityUserMessageRoundEntry(currentDraft, entry);
      }
    }
    return drafts.map(finishActivityUserMessageNavItem);
  }, [activeProjectionViewModel, activeThread?.id, activeThread?.prompt]);

  useEffect(() => {
    const nextThreadId = browserScopeId;
    const prevThreadId = taskPanelUiThreadIdRef.current;
    if (prevThreadId === nextThreadId) {
      return;
    }

    if (prevThreadId) {
      taskPanelUiByThreadRef.current[prevThreadId] = liveTaskPanelUiRef.current;
    }

    taskPanelAnimationControls.stop();
    taskPanelCloseRequestRef.current += 1;
    taskPanelClosingRef.current = false;
    setTaskPanelExiting(false);
    pendingTaskPanelTabCloseRef.current = undefined;

    let restored: TaskPanelSessionUiState;
    if (
      prevThreadId === browserPersonalScopeId(currentProjectPath) &&
      activeThread?.id && adoptLandingTaskPanelUiRef.current
    ) {
      adoptLandingTaskPanelUiRef.current = false;
      restored = normalizeTaskPanelSessionUiState(liveTaskPanelUiRef.current);
      taskPanelUiByThreadRef.current[nextThreadId] = restored;
    } else {
      adoptLandingTaskPanelUiRef.current = false;
      restored = nextThreadId
        ? normalizeTaskPanelSessionUiState(taskPanelUiByThreadRef.current[nextThreadId])
        : emptyTaskPanelSessionUiState();
    }

    setTaskPanelActiveTab(restored.activeTab);
    setOpenTaskPanelTabIds(restored.openTabIds);
    setSelectedSubagentAgentId(restored.selectedSubagentAgentId);
    setTaskPanelFullscreen(restored.open && restored.fullscreen);

    if (restored.fileTarget?.path) {
      fileReferenceRequestIdRef.current += 1;
      setFileTarget({
        path: restored.fileTarget.path,
        requestId: fileReferenceRequestIdRef.current,
        ...(typeof restored.fileTarget.line === "number" ? { line: restored.fileTarget.line } : {}),
        ...(typeof restored.fileTarget.column === "number" ? { column: restored.fileTarget.column } : {}),
        ...(restored.fileTarget.restricted === true ? { restricted: true } : {}),
      });
    } else {
      setFileTarget(undefined);
    }

    taskPanelActiveTabRef.current = restored.activeTab;
    if (restored.open) {
      taskDrawerOpenRef.current = true;
      taskPanelAnimationControls.set(prefersReducedMotion ? { opacity: 1 } : { opacity: 1, x: 0 });
      setTaskPanelLayoutPresent(true);
      setTaskDrawerOpen(true);
      if (restored.activeTab === TASK_PANEL_REVIEW_TAB_ID) {
        void refreshReviewDiffRef.current();
      }
    } else {
      taskDrawerOpenRef.current = false;
      setTaskDrawerOpen(false);
      setTaskPanelLayoutPresent(false);
      void window.eco?.browserSetVisible?.({ visible: false });
    }

    taskPanelUiThreadIdRef.current = nextThreadId;
  }, [activeThread?.id, browserScopeId, currentProjectPath, prefersReducedMotion, taskPanelAnimationControls]);

  useEffect(() => {
    const mediaQuery = window.matchMedia(taskPanelNarrowMediaQuery);
    const exitFullscreenOnNarrow = () => {
      if (mediaQuery.matches) {
        setTaskPanelFullscreen(false);
      }
    };
    exitFullscreenOnNarrow();
    mediaQuery.addEventListener("change", exitFullscreenOnNarrow);
    return () => mediaQuery.removeEventListener("change", exitFullscreenOnNarrow);
  }, []);

  const revealTaskPanel = useCallback(() => {
    const openRequest = taskPanelCloseRequestRef.current + 1;
    taskPanelCloseRequestRef.current = openRequest;
    const reversingExit = taskPanelClosingRef.current;
    taskPanelClosingRef.current = false;
    // Cancel parallel exit reflow immediately so the panel returns to grid flow.
    setTaskPanelExiting(false);
    pendingTaskPanelTabCloseRef.current = undefined;
    taskPanelAnimationControls.stop();
    if (!taskPanelLayoutPresent) {
      taskPanelAnimationControls.set(
        prefersReducedMotion ? { opacity: 0 } : { opacity: 0, x: taskPanelWidth + 18 },
      );
    }
    setTaskPanelLayoutPresent(true);
    setTaskDrawerOpen(true);
    requestAnimationFrame(() => {
      if (taskPanelCloseRequestRef.current !== openRequest) {
        return;
      }
      void taskPanelAnimationControls.start(
        { opacity: 1, x: 0 },
        prefersReducedMotion
          ? { duration: 0.12, ease: "easeOut" }
          : {
              x: {
                type: "spring",
                bounce: 0,
                duration: reversingExit ? 0.28 : 0.34,
              },
              opacity: { duration: 0.18, ease: "easeOut" },
            },
      );
    });
  }, [prefersReducedMotion, taskPanelAnimationControls, taskPanelLayoutPresent, taskPanelWidth]);

  const dismissTaskPanel = useCallback(() => {
    if (!taskPanelLayoutPresent || taskPanelClosingRef.current) {
      return;
    }
    taskPanelClosingRef.current = true;
    const closeRequest = taskPanelCloseRequestRef.current + 1;
    taskPanelCloseRequestRef.current = closeRequest;
    // Hide browser surfaces via viewport rects (BrowserWebviewLayer); do not destroy guests.
    void window.eco?.browserSetVisible?.({ visible: false });
    // Detach the panel from grid flow immediately so the feed reflows in parallel
    // with the exit transform (avoids "animation finishes then layout pops open").
    setTaskPanelExiting(true);
    void taskPanelAnimationControls
      .start(
        prefersReducedMotion ? { opacity: 0 } : { opacity: 0, x: taskPanelWidth + 18 },
        prefersReducedMotion
          ? { duration: 0.12, ease: "easeOut" }
          : {
              x: { type: "spring", bounce: 0, duration: 0.34 },
              opacity: { duration: 0.2, ease: "easeOut" },
            },
      )
      .then(() => {
        if (taskPanelCloseRequestRef.current !== closeRequest) {
          return;
        }
        taskPanelClosingRef.current = false;
        setTaskPanelExiting(false);
        const pendingTabId = pendingTaskPanelTabCloseRef.current;
        pendingTaskPanelTabCloseRef.current = undefined;
        const availableWidth = mainPaneRef.current?.getBoundingClientRect().width;
        const nextLayoutMode = availableWidth
          ? resolveActivityWorkspaceLayoutMode(availableWidth, activityWorkspaceLayoutMode)
          : undefined;
        // Release layout on the critical path — startTransition delayed the grid reclaim
        // and read as a post-exit hitch.
        setTaskDrawerOpen(false);
        setTaskPanelLayoutPresent(false);
        setTaskPanelFullscreen(false);
        // Idempotent: covers any late reveal race during the exit spring.
        void window.eco?.browserSetVisible?.({ visible: false });
        if (pendingTabId) {
          setOpenTaskPanelTabIds((current) => removeOpenTaskPanelTab(current, pendingTabId).tabs);
          setTaskPanelActiveTab((current) => (current === pendingTabId ? TASK_PANEL_HOME_TAB_ID : current));
          setSelectedSubagentAgentId(undefined);
        }
        if (nextLayoutMode) {
          startTransition(() => {
            setActivityWorkspaceLayoutMode(nextLayoutMode);
            if (shouldAutoOpenWorkspacePanel(nextLayoutMode)) {
              setWorkspacePanelManualOverride({
                layoutMode: nextLayoutMode,
                projectPath: currentProjectPath,
                threadId: activeThread?.id,
                open: true,
              });
            }
          });
        }
      });
  }, [
    activityWorkspaceLayoutMode,
    activeThread?.id,
    currentProjectPath,
    prefersReducedMotion,
    taskPanelAnimationControls,
    taskPanelLayoutPresent,
    taskPanelWidth,
  ]);

  const connectSshBookmark = useCallback(
    async (bookmark: SshBookmarkView) => {
      if (!currentProjectPath || !window.eco?.connectSshBookmark) {
        return;
      }
      try {
        const result = await window.eco.connectSshBookmark({
          workspacePath: currentProjectPath,
          bookmarkId: bookmark.id,
        });
        dismissTaskPanel();
        openTerminalSessionTab(currentProjectPath, result.sessionId, {
          kind: "ssh",
          label: result.label,
          endpoint: result.endpoint,
        });
        if (result.passwordAutoInject === false && bookmark.authType === "password") {
          showAppMessageError(t("app.sshBookmarks.passwordManualHint"));
        }
      } catch (error) {
        showAppMessageError(error instanceof Error ? error.message : t("app.sshBookmarks.connectFailed"));
      }
    },
    [currentProjectPath, dismissTaskPanel, openTerminalSessionTab, showAppMessageError, t],
  );

  useEffect(() => {
    const handleFileReference = (event: Event) => {
      const reference = (event as CustomEvent<WorkspaceFileReference>).detail;
      if (!reference?.path || !currentProjectPath) {
        return;
      }
      fileReferenceRequestIdRef.current += 1;
      setFileTarget({
        ...reference,
        requestId: fileReferenceRequestIdRef.current,
        restricted: !isWorkspacePathContained(currentProjectPath, reference.path),
      });
      setOpenTaskPanelTabIds((current) => addOpenTaskPanelTab(current, TASK_PANEL_FILE_VIEWER_TAB_ID));
      setTaskPanelActiveTab(TASK_PANEL_FILE_VIEWER_TAB_ID);
      setSelectedSubagentAgentId(undefined);
      setTaskPanelFullscreen(false);
      revealTaskPanel();
    };
    window.addEventListener(WORKSPACE_FILE_REFERENCE_EVENT, handleFileReference);
    return () => window.removeEventListener(WORKSPACE_FILE_REFERENCE_EVENT, handleFileReference);
  }, [currentProjectPath, revealTaskPanel]);

  useEffect(() => {
    const handleBrowserLink = (event: Event) => {
      const requestedScopeId = browserScopeIdRef.current;
      const url = (event as CustomEvent<string>).detail;
      if (typeof url !== "string" || !url.trim()) {
        return;
      }
      if (!currentProjectPath) {
        return;
      }
      void window.eco
        ?.browserOpen?.({
          url,
          reveal: true,
          newBrowser: true,
          ...(activeThread?.id ? { threadId: activeThread.id } : { workspacePath: currentProjectPath }),
        })
        .then((state) => {
          if (
            !state || state.uiScopeId !== requestedScopeId ||
            requestedScopeId !== browserScopeIdRef.current
          ) return;
          const focusId = state.focusedBrowserId ?? state.revealBrowserId ?? state.instances.at(-1)?.id;
          if (focusId) {
            const tabId = browserTaskTabId(focusId);
            setOpenTaskPanelTabIds((current) => addOpenTaskPanelTab(current, tabId));
            setTaskPanelActiveTab(tabId);
          }
          setSelectedSubagentAgentId(undefined);
          setTaskPanelFullscreen(false);
          revealTaskPanel();
        });
    };
    window.addEventListener(BROWSER_LINK_OPEN_EVENT, handleBrowserLink);
    return () => window.removeEventListener(BROWSER_LINK_OPEN_EVENT, handleBrowserLink);
  }, [activeThread?.id, currentProjectPath, revealTaskPanel]);

  useEffect(() => {
    const handleBrowserHtml = (event: Event) => {
      const requestedScopeId = browserScopeIdRef.current;
      const html = (event as CustomEvent<string>).detail;
      if (typeof html !== "string" || !html.trim()) {
        return;
      }
      if (!currentProjectPath) {
        return;
      }
      void window.eco
        ?.browserOpen?.({
          htmlContent: html,
          reveal: true,
          newBrowser: true,
          ...(activeThread?.id ? { threadId: activeThread.id } : { workspacePath: currentProjectPath }),
        })
        .then((state) => {
          if (
            !state || state.uiScopeId !== requestedScopeId ||
            requestedScopeId !== browserScopeIdRef.current
          ) return;
          const focusId = state.focusedBrowserId ?? state.revealBrowserId ?? state.instances.at(-1)?.id;
          if (focusId) {
            const tabId = browserTaskTabId(focusId);
            setOpenTaskPanelTabIds((current) => addOpenTaskPanelTab(current, tabId));
            setTaskPanelActiveTab(tabId);
          }
          setSelectedSubagentAgentId(undefined);
          setTaskPanelFullscreen(false);
          revealTaskPanel();
        });
    };
    window.addEventListener(BROWSER_HTML_OPEN_EVENT, handleBrowserHtml);
    return () => window.removeEventListener(BROWSER_HTML_OPEN_EVENT, handleBrowserHtml);
  }, [activeThread?.id, currentProjectPath, revealTaskPanel]);

  useEffect(() => {
    if (settingsOpen) {
      void window.eco?.browserSetVisible?.({ visible: false });
    }
  }, [settingsOpen]);

  useEffect(() => {
    void window.eco
      ?.browserSetUiScope?.({
        threadId: activeThread?.id ?? null,
        ...(currentProjectPath ? { workspacePath: currentProjectPath } : {}),
      })
      .then(() => {
        // Switching chats while the work panel is collapsed must not leave guests painted.
        if (!taskDrawerOpenRef.current) {
          void window.eco?.browserSetVisible?.({ visible: false });
        }
      });
  }, [activeThread?.id, currentProjectPath]);

  useEffect(() => {
    const unsubscribe = browserStateStore.onStateChange((state) => {
      if (state.uiScopeId !== browserScopeIdRef.current) return;
      // `revealBrowserId` is sticky in main (it survives every emit until the page is
      // closed or the panel hides it), so an unchanged id is not a new request. Treating
      // every snapshot as one drags the panel back to the previous tab right after the
      // user opens a new one — the new tab's own switch is undone by the old reveal.
      const isNewRevealIntent = lastRevealBrowserIdRef.current !== state.revealBrowserId;
      lastRevealBrowserIdRef.current = state.revealBrowserId;
      // Navigation replaces a local start tab before exposing its newly created guest.
      if (pendingNewTabNavigationsRef.current.size > 0) return;
      // Agent navigated / created a page: track tabs, but never force-open the work panel.
      // When the panel is already open on a non-browser tab (files / plan / …), do not
      // switch active tab — that would mount BrowserPanel and steal composer focus.
      // Only follow the agent when the human is already watching a browser tab.
      if (
        state.revealBrowserId &&
        currentProjectPath &&
        !replacingBrowserHomeIdsRef.current.has(state.revealBrowserId)
      ) {
        const tabId = browserTaskTabId(state.revealBrowserId);
        setOpenTaskPanelTabIds((current) => addOpenTaskPanelTab(current, tabId));
        if (
          taskDrawerOpenRef.current &&
          isNewRevealIntent &&
          isBrowserTaskTabId(String(taskPanelActiveTabRef.current ?? ""))
        ) {
          setTaskPanelActiveTab(tabId);
          setSelectedSubagentAgentId(undefined);
        }
      }
      // User-initiated browser open: switch to the browser tab — but only once per intent.
      // Main keeps `activateBrowserId` set for the page's lifetime, so re-switching on every
      // later emit would drag the user off whatever tab they opened next (files / file viewer).
      if (
        state.activateBrowserId &&
        currentProjectPath &&
        !replacingBrowserHomeIdsRef.current.has(state.activateBrowserId)
      ) {
        const tabId = browserTaskTabId(state.activateBrowserId);
        const isNewActivation = handledActivateBrowserIdRef.current !== state.activateBrowserId;
        handledActivateBrowserIdRef.current = state.activateBrowserId;
        setOpenTaskPanelTabIds((current) => addOpenTaskPanelTab(current, tabId));
        if (taskDrawerOpenRef.current && isNewActivation) {
          setTaskPanelActiveTab(tabId);
          setSelectedSubagentAgentId(undefined);
        }
      }
      // Keep open browser tabs aligned with live instances for current UI scope.
      if (state.instances.length > 0) {
        setOpenTaskPanelTabIds((current) => {
          let next = current;
          for (const instance of state.instances) {
            if (replacingBrowserHomeIdsRef.current.has(instance.id)) continue;
            next = addOpenTaskPanelTab(next, browserTaskTabId(instance.id));
          }
          return next;
        });
      }
    });
    return () => unsubscribe?.();
  }, [currentProjectPath]);

  useEffect(() => {
    // IPC still describes the previous chat until the scope-switch broadcast arrives.
    // Do not remove the newly restored chat's tabs using the previous chat's ids.
    if (!browserScopeReady) return;
    const liveBrowserIds = new Set(browserInstanceIds);
    const projectionLoaded = Boolean(activeProjectionViewModel);
    setOpenTaskPanelTabIds((current) => {
      const next = current.filter((tabId) => {
        if (
          tabId === TASK_PANEL_FILES_TAB_ID ||
          tabId === TASK_PANEL_FILE_VIEWER_TAB_ID ||
          tabId === TASK_PANEL_REVIEW_TAB_ID ||
          tabId === TASK_PANEL_BACKGROUND_TERMINAL_TAB_ID ||
          tabId === TASK_PANEL_PLAN_TAB_ID ||
          tabId === TASK_PANEL_SSH_BOOKMARKS_TAB_ID ||
          isNewTaskPanelTabId(tabId) ||
          activeSubagentCards.some((card) => card.key === tabId)
        ) {
          return true;
        }
        if (parseTtsTaskTabId(String(tabId))) return true;
        if (parseImageGenerationTaskTabId(String(tabId))) {
          return true;
        }
        if (parseImageDisplayTaskTabId(String(tabId))) {
          return true;
        }
        const browserId = parseBrowserTaskTabId(String(tabId));
        if (browserId) {
          return liveBrowserIds.has(browserId);
        }
        // Subagent tabs restored before projection hydrates must not be dropped.
        return !projectionLoaded;
      });
      if (next.length === current.length && next.every((tabId, index) => tabId === current[index])) {
        return current;
      }
      if (taskPanelActiveTab !== TASK_PANEL_HOME_TAB_ID && !next.includes(taskPanelActiveTab)) {
        const fallback = next.at(-1);
        setTaskPanelActiveTab(fallback ?? TASK_PANEL_HOME_TAB_ID);
        setSelectedSubagentAgentId(
          fallback && activeSubagentCards.some((card) => card.key === fallback) ? fallback : undefined,
        );
      }
      return next;
    });
  }, [activeProjectionViewModel, activeSubagentCards, browserInstanceIds, browserScopeReady, taskPanelActiveTab]);

  const toggleWorkPanelForCurrentProject = useCallback(() => {
    toggleWorkspacePanelForCurrentProject();
  }, [toggleWorkspacePanelForCurrentProject]);

  const toggleFileTreeForCurrentProject = useCallback(() => {
    if (!currentProjectPath) {
      return;
    }
    if (taskDrawerOpen && taskPanelActiveTab === TASK_PANEL_FILES_TAB_ID && !taskPanelClosingRef.current) {
      dismissTaskPanel();
      return;
    }
    setOpenTaskPanelTabIds((current) => addOpenTaskPanelTab(current, TASK_PANEL_FILES_TAB_ID));
    setTaskPanelActiveTab(TASK_PANEL_FILES_TAB_ID);
    setSelectedSubagentAgentId(undefined);
    setTaskPanelFullscreen(false);
    revealTaskPanel();
  }, [currentProjectPath, dismissTaskPanel, revealTaskPanel, taskDrawerOpen, taskPanelActiveTab]);

  const selectBrowserTaskTab = useCallback((browserId: string) => {
    const state = browserStateStore.getState();
    if (
      state?.uiScopeId !== browserScopeIdRef.current ||
      !state.guestInstances.some((g) => g.id === browserId)
    ) return;
    const tabId = browserTaskTabId(browserId);
    setOpenTaskPanelTabIds((current) => addOpenTaskPanelTab(current, tabId));
    setTaskPanelActiveTab(tabId);
    setSelectedSubagentAgentId(undefined);
    void window.eco?.browserFocus?.({ browserId, reveal: true });
  }, []);

  const openBrowserTaskPanel = useCallback(
    (options?: string | { browserId?: string; url?: string; webChatSiteId?: string }) => {
      const requestedScopeId = browserScopeIdRef.current;
      if (!currentProjectPath) {
        return;
      }
      const resolved = typeof options === "string" ? { browserId: options } : (options ?? {});
      if (shouldResetTaskPanelFullscreenOnBrowserOpen(taskDrawerOpenRef.current)) {
        setTaskPanelFullscreen(false);
      }
      if (resolved.browserId) {
        selectBrowserTaskTab(resolved.browserId);
        if (!taskDrawerOpenRef.current) {
          revealTaskPanel();
        }
        return;
      }
      setSelectedSubagentAgentId(undefined);
      if (!resolved.url) {
        const tabId = newTaskPanelTabId(crypto.randomUUID());
        setOpenTaskPanelTabIds((current) => addOpenTaskPanelTab(current, tabId));
        setTaskPanelActiveTab(tabId);
        if (!taskDrawerOpenRef.current) revealTaskPanel();
        return;
      }
      void window.eco
        ?.browserOpen?.({
          reveal: true,
          newBrowser: true,
          ...(resolved.webChatSiteId ? { webChatSiteId: resolved.webChatSiteId } : {}),
          ...(resolved.url ? { url: resolved.url } : {}),
          ...(activeThread?.id ? { threadId: activeThread.id } : { workspacePath: currentProjectPath }),
        })
        .then((state) => {
          if (
            !state || state.uiScopeId !== requestedScopeId ||
            requestedScopeId !== browserScopeIdRef.current
          ) return;
          const focusId = state.focusedBrowserId ?? state.revealBrowserId ?? state.instances.at(-1)?.id;
          if (focusId) {
            selectBrowserTaskTab(focusId);
            if (!taskDrawerOpenRef.current) {
              revealTaskPanel();
            }
          }
        })
        .catch((error) => showAppMessageError(error instanceof Error ? error.message : String(error)));
    },
    [activeThread?.id, currentProjectPath, revealTaskPanel, selectBrowserTaskTab, showAppMessageError],
  );

  const navigateNewTaskPanelTab = useCallback(
    async (sourceTabId: string, url: string) => {
      const eco = window.eco;
      if (!eco || !currentProjectPath || pendingNewTabNavigationsRef.current.has(sourceTabId)) return;
      const requestedScopeId = browserScopeIdRef.current;
      pendingNewTabNavigationsRef.current.add(sourceTabId);
      try {
        const next = await eco.browserOpen({
          url,
          reveal: false,
          newBrowser: true,
          ...(activeThread?.id ? { threadId: activeThread.id } : { workspacePath: currentProjectPath }),
        });
        if (next.uiScopeId !== requestedScopeId || requestedScopeId !== browserScopeIdRef.current) return;
        const browserId = next.focusedBrowserId;
        if (!browserId) throw new Error("浏览器未返回新页面实例");
        const tabId = browserTaskTabId(browserId);
        setOpenTaskPanelTabIds((current) => replaceOpenTaskPanelTab(current, sourceTabId, tabId));
        if (taskPanelActiveTabRef.current === sourceTabId) {
          taskPanelActiveTabRef.current = tabId;
          setTaskPanelActiveTab(tabId);
        }
        browserStateStore.setState(next);
      } catch (error) {
        showAppMessageError(error instanceof Error ? error.message : String(error));
      } finally {
        pendingNewTabNavigationsRef.current.delete(sourceTabId);
        if (pendingNewTabNavigationsRef.current.size === 0) {
          const latest = browserStateStore.getState();
          if (latest) browserStateStore.setState({ ...latest });
        }
      }
    },
    [activeThread?.id, currentProjectPath, showAppMessageError],
  );

  const toggleTaskPanelForCurrentProject = useCallback(() => {
    if (!currentProjectPath) {
      return;
    }
    if (taskDrawerOpen) {
      if (taskPanelClosingRef.current) {
        revealTaskPanel();
      } else {
        dismissTaskPanel();
      }
      return;
    }
    setTaskPanelFullscreen(false);
    // Reopening the sidebar restores the tab it was collapsed on; only an empty panel
    // (every tab closed) gets a fresh start page.
    const restoreTab = resolveTaskPanelReopenTab(openTaskPanelTabIds, taskPanelActiveTabRef.current);
    if (!restoreTab) {
      openBrowserTaskPanel();
      return;
    }
    setTaskPanelActiveTab(restoreTab);
    setSelectedSubagentAgentId(
      activeSubagentCards.some((card) => card.key === restoreTab) ? restoreTab : undefined,
    );
    revealTaskPanel();
  }, [
    activeSubagentCards,
    currentProjectPath,
    dismissTaskPanel,
    openBrowserTaskPanel,
    openTaskPanelTabIds,
    revealTaskPanel,
    taskDrawerOpen,
  ]);

  const openWebChatItem = useCallback(
    (item: WebChatItem) => {
      openBrowserTaskPanel({ url: item.url, webChatSiteId: item.id });
    },
    [openBrowserTaskPanel],
  );

  const toggleBrowserForCurrentProject = useCallback(() => {
    if (!currentProjectPath) {
      return;
    }
    if (
      taskDrawerOpen &&
      (isBrowserTaskTabId(taskPanelActiveTab) || isNewTaskPanelTabId(taskPanelActiveTab)) &&
      !taskPanelClosingRef.current
    ) {
      dismissTaskPanel();
      return;
    }
    openBrowserTaskPanel();
  }, [currentProjectPath, dismissTaskPanel, openBrowserTaskPanel, taskDrawerOpen, taskPanelActiveTab]);

  menuCommandHandlerRef.current = (command) => {
    switch (command) {
      case "new-chat":
        startNewChat();
        return;
      case "open-folder":
        void openWorkspace();
        return;
      case "check-for-updates":
        void window.eco?.checkDesktopForUpdates();
        return;
      case "toggle-sidebar":
        setSidebarOpen((current) => !current);
        return;
      case "toggle-bottom-panel":
        toggleTerminalForCurrentProject();
        return;
      case "toggle-work-panel":
        toggleWorkPanelForCurrentProject();
        return;
      case "toggle-review-panel":
        toggleTaskPanelForCurrentProject();
        return;
      case "toggle-file-tree":
        toggleFileTreeForCurrentProject();
        return;
      case "toggle-browser":
        toggleBrowserForCurrentProject();
        return;
      default: {
        const exhaustiveCommand: never = command;
        throw new Error(`Unhandled app menu command: ${exhaustiveCommand}`);
      }
    }
  };

  const openPlanTaskDrawer = useCallback(() => {
    if (!taskPanelPlan) {
      return;
    }
    setOpenTaskPanelTabIds((current) => addOpenTaskPanelTab(current, TASK_PANEL_PLAN_TAB_ID));
    setTaskPanelActiveTab(TASK_PANEL_PLAN_TAB_ID);
    setSelectedSubagentAgentId(undefined);
    setTaskPanelFullscreen(false);
    revealTaskPanel();
  }, [revealTaskPanel, taskPanelPlan]);

  const openSubagentTaskDrawer = useCallback(
    (agentId: string) => {
      if (isAcpSubagentAgentId(agentId)) {
        return;
      }
      setOpenTaskPanelTabIds((current) => addOpenTaskPanelTab(current, agentId));
      setTaskPanelActiveTab(agentId);
      setSelectedSubagentAgentId(agentId);
      setTaskPanelFullscreen(false);
      revealTaskPanel();
    },
    [revealTaskPanel],
  );

  const openImageGenerationArtifact = useCallback(
    (artifactId: string) => {
      const tabId = imageGenerationTaskTabId(artifactId);
      setOpenTaskPanelTabIds((current) => addOpenTaskPanelTab(current, tabId));
      setTaskPanelActiveTab(tabId);
      setSelectedSubagentAgentId(undefined);
      setTaskPanelFullscreen(false);
      revealTaskPanel();
    },
    [revealTaskPanel],
  );

  const openTtsArtifact = useCallback(
    (artifactId: string) => {
      const tabId = ttsTaskTabId(artifactId);
      setOpenTaskPanelTabIds((current) => addOpenTaskPanelTab(current, tabId));
      setTaskPanelActiveTab(tabId);
      setSelectedSubagentAgentId(undefined);
      setTaskPanelFullscreen(false);
      revealTaskPanel();
    },
    [revealTaskPanel],
  );

  const openImageGenerationTool = useCallback(
    (toolUseId: string) => {
      const threadId = activeThread?.id;
      if (!threadId) return;
      const artifact = (imageArtifactsByThread[threadId] ?? []).find(
        (candidate) => candidate.toolUseId === toolUseId,
      );
      if (artifact) openImageGenerationArtifact(artifact.id);
    },
    [activeThread?.id, imageArtifactsByThread, openImageGenerationArtifact],
  );

  const openImageDisplayArtifact = useCallback(
    (artifactId: string) => {
      const tabId = imageDisplayTaskTabId(artifactId);
      setOpenTaskPanelTabIds((current) => addOpenTaskPanelTab(current, tabId));
      setTaskPanelActiveTab(tabId);
      setSelectedSubagentAgentId(undefined);
      setTaskPanelFullscreen(false);
      revealTaskPanel();
    },
    [revealTaskPanel],
  );

  const openImageDisplayTool = useCallback(
    (toolUseId: string) => {
      const threadId = activeThread?.id;
      if (!threadId) return;
      const artifact = (imageDisplayArtifactsByThread[threadId] ?? []).find(
        (candidate) => candidate.toolUseId === toolUseId,
      );
      if (artifact) openImageDisplayArtifact(artifact.id);
    },
    [activeThread?.id, imageDisplayArtifactsByThread, openImageDisplayArtifact],
  );

  const openHtmlHostArtifact = useCallback(
    (artifactId: string) => {
      const threadId = activeThread?.id;
      if (!threadId) return;
      const artifact = (htmlHostArtifactsByThread[threadId] ?? []).find(
        (candidate) => candidate.id === artifactId,
      );
      if (!artifact?.publicUrl?.trim()) return;
      void openPublishedHtmlInBrowser(artifact.publicUrl);
    },
    [activeThread?.id, htmlHostArtifactsByThread],
  );

  const closeTaskPanelTab = useCallback(
    (tabId: TaskPanelActiveTab) => {
      const result = removeOpenTaskPanelTab(openTaskPanelTabIds, tabId);
      if (!openTaskPanelTabIds.includes(tabId)) {
        return;
      }
      const browserId = parseBrowserTaskTabId(String(tabId));
      if (browserId) {
        // Tab × closes the page for real (Agent target goes away with that WebContents).
        void window.eco?.browserCloseInstance?.({ browserId });
      }
      if (result.tabs.length === 0) {
        pendingTaskPanelTabCloseRef.current = tabId;
        dismissTaskPanel();
        return;
      }
      setOpenTaskPanelTabIds(result.tabs);
      if (taskPanelActiveTab === tabId) {
        const fallback = result.fallback;
        setTaskPanelActiveTab(fallback ?? TASK_PANEL_HOME_TAB_ID);
        setSelectedSubagentAgentId(
          fallback && activeSubagentCards.some((card) => card.key === fallback) ? fallback : undefined,
        );
      }
    },
    [activeSubagentCards, dismissTaskPanel, openTaskPanelTabIds, taskPanelActiveTab],
  );

  const handleTaskPanelResizePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (!taskDrawerOpen || event.button !== 0) {
        return;
      }
      event.preventDefault();
      taskPanelResizeRef.current = {
        startX: event.clientX,
        startWidth: taskPanelWidth,
      };
      document.body.classList.add("is-resizing-task-panel");
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [taskDrawerOpen, taskPanelWidth],
  );

  const handleTaskPanelResizePointerMove = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const session = taskPanelResizeRef.current;
    if (!session) {
      return;
    }
    setTaskPanelWidth(
      clampTaskPanelWidth(
        session.startWidth + (session.startX - event.clientX),
        mainPaneRef.current?.clientWidth,
      ),
    );
  }, []);

  const handleTaskPanelResizePointerEnd = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (!taskPanelResizeRef.current) {
      return;
    }
    taskPanelResizeRef.current = undefined;
    document.body.classList.remove("is-resizing-task-panel");
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  const handleTaskPanelResizeKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 48 : 24;
    const paneWidth = mainPaneRef.current?.clientWidth;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      setTaskPanelWidth((current) => clampTaskPanelWidth(current + step, paneWidth));
      return;
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      setTaskPanelWidth((current) => clampTaskPanelWidth(current - step, paneWidth));
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      setTaskPanelWidth(TASK_PANEL_GEOMETRY.minWidth);
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      if (paneWidth && paneWidth > 0) {
        setTaskPanelWidth(taskPanelMaxWidthForPane(paneWidth));
      }
    }
  }, []);

  const threadUsageSummary = useMemo(() => {
    if (!activeThread) {
      return undefined;
    }
    const rawBilling = activeConversationV2?.projectionExtras?.billing;
    const billing = rawBilling ? enrichBillingDisplaySource(rawBilling, activeThread.status) : undefined;
    return buildThreadUsageSummary({
      ...(billing && { billing }),
      ...(activeConversationV2?.projectionExtras?.ledgerEvents && {
        ledgerEvents: activeConversationV2.projectionExtras.ledgerEvents,
      }),
      ...(activeConversationV2?.projectionExtras?.context
        ? { context: activeConversationV2.projectionExtras.context }
        : {}),
      ...(activeThread.hostUiFeatures && { hostUiFeatures: activeThread.hostUiFeatures }),
    });
  }, [activeConversationV2, activeThread]);
  const canEditComposerConfig =
    !activeThread ||
    (threadAcceptsInput && activeThread.status !== "running" && activeThread.status !== "queued");
  const canEditBashReviewMode = Boolean(composerRuntimeConfig);
  // Route settings remain viewable for every thread state, including an active run;
  // canEditComposerConfig continues to gate every route mutation handler/control.
  // Auxiliary / approval / vision requests are stateless single-shot calls: the host
  // re-reads their selection for each request, so they stay switchable mid-run and
  // take effect on the next auxiliary / approval / vision request.
  const canEditStatelessModelConfig = !isSavingSettings;
  // Open permission only collapses while settings are saving.
  const canOpenComposerRoute = !isSavingSettings;
  const resetComposerToGlobalSettings = useCallback(async () => {
    if (!canEditComposerConfig || isSavingSettings) {
      return;
    }

    try {
      const next = buildComposerGlobalRuntimeConfig({
        coreKind: composerCoreKind,
        settings,
        workflowDefaults: workflowSettings,
        mcpServers: mcpSettings.servers,
      });
      if (!next) {
        setError(t("composer.route.globalResetUnavailable"));
        return;
      }
      setError(undefined);
      await persistComposerRuntimeConfig(next);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }, [
    canEditComposerConfig,
    composerCoreKind,
    errorMessage,
    isSavingSettings,
    mcpSettings.servers,
    persistComposerRuntimeConfig,
    settings,
    t,
    workflowSettings,
  ]);
  const openComposerRoutePopover = useCallback(
    (anchor: "plus" | "model-empty" = "plus") => {
      if (!canOpenComposerRoute) {
        return;
      }
      setComposerPlusMenuOpen(false);
      setScheduledMessageEditor(undefined);
      setComposerRouteAnchor(anchor);
      setComposerRoutePopoverOpen(true);
    },
    [canOpenComposerRoute],
  );
  const openComposerOrchestrationChooser = useCallback(() => {
    if (!canOpenComposerRoute) {
      return;
    }
    // 无主代理资源时：可编辑才进完整设置；只读态打开空 popover 查看。
    if (
      shouldOpenOrchestrationFullSettings({
        canEditComposerConfig,
        mainAgentConfigCount: settings.mainAgentConfigs.length,
      })
    ) {
      openModelsSettings("compositionParts");
      return;
    }
    openComposerRoutePopover("model-empty");
  }, [
    canEditComposerConfig,
    canOpenComposerRoute,
    openComposerRoutePopover,
    settings.mainAgentConfigs.length,
  ]);
  const agentModelLabels = useMemo(
    () =>
      buildComposerAgentModelLabels({
        routes: activeRoutes,
        threadModelByRole,
        snapshot: selectedOrchestrationSnapshot,
        templates: settings.agentTemplates,
      }),
    [activeRoutes, selectedOrchestrationSnapshot, settings.agentTemplates, threadModelByRole, t],
  );
  const activityModelByRole = useMemo(() => {
    const configured: Record<string, string> = {};
    for (const route of activeRoutes) {
      const modelId = route.modelId.trim();
      if (modelId) {
        configured[route.role] = modelId;
      }
    }
    const merged: Record<string, string> = { ...configured };
    for (const [role, live] of Object.entries(threadModelByRole ?? {})) {
      const displayModelId = live.trim() || configured[role];
      if (displayModelId) {
        merged[role] = displayModelId;
      }
    }
    return merged;
  }, [activeRoutes, threadModelByRole]);
  const activityMessagesRef = useRef<HTMLDivElement>(null);
  const activityEndRef = useRef<HTMLDivElement>(null);
  const activityWorkspaceRef = useRef<HTMLDivElement>(null);
  const scrollBodyRef = useRef<HTMLDivElement>(null);
  const topbarRef = useRef<HTMLElement>(null);
  const workspaceCardsPanelRef = useRef<HTMLElement>(null);
  const [topbarSolid, setTopbarSolid] = useState(true);
  const userDetachedFromBottomRef = useRef(false);
  const [feedUserDetached, setFeedUserDetached] = useState(false);
  const activityFeedScrollTopRef = useRef(0);
  const programmaticActivityFeedScrollRef = useRef(false);
  const forceActivityFeedScrollUntilRef = useRef(0);
  const activityFeedUserScrollDirectionRef = useRef<ActivityFeedUserScrollDirection | null>(null);
  const activityFeedScrollJumpRef = useRef<ActivityFeedScrollJump | null>(null);
  const [activityFeedScrollJump, setActivityFeedScrollJump] = useState<ActivityFeedScrollJump | null>(null);
  const activeActivityUserMessageNavIdRef = useRef<string | undefined>(undefined);
  const [activeActivityUserMessageNavId, setActiveActivityUserMessageNavId] = useState<string>();
  const activityFeedLayoutScrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastActivityFeedLayoutScrollAtRef = useRef(0);
  const activityUserMessageJumpTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const composerRef = useRef<ComposerSkillsInputHandle>(null);
  const composerCapabilityReferences = useMemo(
    () =>
      buildComposerCapabilityReferences({
        availability: integrationAvailability,
        integrationsEnabled: composerIntegrationSettings,
        integrationLabels: {
          browser: t("settings.browser"),
          imageGeneration: t("settings.imageGeneration.title"),
          tts: t("settings.tts.title"),
          computerUse: t("settings.computerUse"),
        },
        mcpServers: mcpSettings.servers,
        mcpServersEnabled: composerMcpSettings,
        agents:
          composerCoreKind === "acp" || !selectedOrchestrationSnapshot
            ? []
            : agentModelLabels
                .filter((agent) => !agent.main)
                .map((agent) => ({
                  agentKey: agent.role,
                  name: agent.displayName,
                  modelId: activeRoutes.find((route) => route.role === agent.role)?.modelId ?? "",
                  enabled:
                    selectedOrchestrationSnapshot.agents.some(
                      (entry) => entry.agentKey === agent.role && entry.enabled,
                    ) &&
                    (!agent.subagentRole ||
                      (composerRuntimeConfig?.subagentEnabled ?? defaultSubagentAvailability())[
                        agent.subagentRole
                      ] === true),
                })),
      }),
    [
      integrationAvailability,
      composerIntegrationSettings,
      mcpSettings.servers,
      composerMcpSettings,
      composerCoreKind,
      selectedOrchestrationSnapshot,
      agentModelLabels,
      activeRoutes,
      composerRuntimeConfig?.subagentEnabled,
      t,
    ],
  );
  const composerReferencesMenu = useComposerReferences({
    prompt,
    cursor: composerCursor,
    inputRef: composerRef,
    onChange: setPrompt,
    capabilities: composerCapabilityReferences,
  });
  useEffect(() => {
    if (composerReferencesMenu.open) {
      setComposerPlusMenuOpen(false);
      setComposerRoutePopoverOpen(false);
      setScheduledMessageEditor(undefined);
    }
  }, [composerReferencesMenu.open]);
  const COMPOSER_TEXTAREA_MAX_HEIGHT = 200;
  const runProjectionLayoutSignature = useMemo(() => {
    if (!runProjection?.sourceEventCount) {
      return "";
    }
    const lastMainItem = runProjection.timeline.at(-1);
    const agentSignature = runProjection.agents
      .map((agent) => {
        const lastAgentItem = agent.timeline.at(-1);
        return `${agent.agentId}:${agent.status}:${agent.timeline.length}:${lastAgentItem?.id ?? ""}:${lastAgentItem?.text.length ?? 0}`;
      })
      .join(",");
    return [
      runProjection.sourceEventCount,
      runProjection.thread.status,
      lastMainItem?.id ?? "",
      agentSignature,
    ].join("|");
  }, [runProjection]);

  const composerSkillsByName = useMemo(() => buildSkillMap(slashPickerSkills), [slashPickerSkills]);

  const distanceFromActivityFeedBottom = useCallback((container: HTMLElement) => {
    return container.scrollHeight - container.scrollTop - container.clientHeight;
  }, []);

  const clampActivityFeedOverscroll = useCallback((container: HTMLElement): boolean => {
    // A reader mid-history may sit past the (shrinking) bottom: the rubber-band gap self-heals
    // when the tail regrows, and snapping them back would lurch the content they are reading.
    // Only the follow state needs the hard clamp.
    if (userDetachedFromBottomRef.current) {
      return false;
    }
    const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
    if (container.scrollTop <= maxScrollTop) {
      return false;
    }
    programmaticActivityFeedScrollRef.current = true;
    container.scrollTop = maxScrollTop;
    activityFeedScrollTopRef.current = container.scrollTop;
    requestAnimationFrame(() => {
      programmaticActivityFeedScrollRef.current = false;
    });
    return true;
  }, []);

  const syncActivityFeedScrollJump = useCallback(
    (container: HTMLElement) => {
      const next = resolveActivityFeedScrollJump(
        container.scrollTop,
        distanceFromActivityFeedBottom(container),
        activityFeedUserScrollDirectionRef.current,
      );
      if (next !== activityFeedScrollJumpRef.current) {
        activityFeedScrollJumpRef.current = next;
        setActivityFeedScrollJump(next);
      }
    },
    [distanceFromActivityFeedBottom],
  );

  const updateActiveActivityUserMessageNavId = useCallback((next: string | undefined) => {
    if (activeActivityUserMessageNavIdRef.current === next) {
      return;
    }
    activeActivityUserMessageNavIdRef.current = next;
    setActiveActivityUserMessageNavId(next);
  }, []);

  const syncActivityUserMessageNavigator = useCallback(
    (container: HTMLElement) => {
      const containerRect = container.getBoundingClientRect();
      const anchors = Array.from(
        container.querySelectorAll<HTMLElement>("[data-user-message-anchor-id]"),
      )
        .map((anchor) => ({
          id: anchor.dataset.userMessageAnchorId ?? "",
          top: anchor.getBoundingClientRect().top - containerRect.top,
        }))
        .filter((anchor) => anchor.id);
      updateActiveActivityUserMessageNavId(
        resolveActivityUserMessageActiveAnchorId(anchors, {
          top: 0,
          height: containerRect.height,
          distanceFromBottomPx: distanceFromActivityFeedBottom(container),
        }),
      );
    },
    [distanceFromActivityFeedBottom, updateActiveActivityUserMessageNavId],
  );

  // Hand scroll anchoring back to the browser while the reader is detached from the bottom.
  // The follow state uses overflow-anchor: none so Chromium can't fight the JS stick-to-bottom
  // on a growing tail — but with anchoring off, any content reflow *above* the viewport
  // (thinking-block auto-collapse, lazy mounts, expanding blocks) lurches the reading position
  // with no compensation. Anchoring on while detached keeps the content the user is reading
  // stable; the class flips back off as soon as they return to the bottom (or force-scroll).
  const setActivityFeedDetachedAnchor = useCallback((detached: boolean) => {
    activityMessagesRef.current?.classList.toggle("is-reading-detached", detached);
    setFeedUserDetached(detached);
  }, []);

  /**
   * True while the Feed renders virtualized rows. Those rows are end-anchored,
   * so virtual-core already compensates content growth at the tail
   * (`resizeItem`'s `wasAtEnd` path). Writing `scrollTop` here as well makes the
   * two writers disagree inside one frame: the follow write moves the viewport,
   * the virtual window re-derives its boundary from the moved offset, the
   * spacers change, and the ResizeObserver fires the follow again.
   */
  const feedEndAnchoredRef = useRef(false);
  const handleFeedEndAnchorChange = useCallback((endAnchored: boolean) => {
    feedEndAnchoredRef.current = endAnchored;
  }, []);

  const jumpToActivityUserMessage = useCallback(
    (anchorId: string) => {
      const container = activityMessagesRef.current;
      if (!container) {
        return;
      }
      const scrollToMountedAnchor = () => {
        const anchors = Array.from(container.querySelectorAll<HTMLElement>("[data-user-message-anchor-id]"));
        const target = anchors.find((anchor) => anchor.dataset.userMessageAnchorId === anchorId);
        if (!target) {
          return false;
        }
        if (activityUserMessageJumpTimerRef.current) {
          clearTimeout(activityUserMessageJumpTimerRef.current);
        }
        const containerRect = container.getBoundingClientRect();
        const targetRect = target.getBoundingClientRect();
        const targetTop = Math.max(0, container.scrollTop + targetRect.top - containerRect.top - 18);
        userDetachedFromBottomRef.current = true;
        activityFeedUserScrollDirectionRef.current = targetTop < container.scrollTop ? "up" : "down";
        setActivityFeedDetachedAnchor(true);
        programmaticActivityFeedScrollRef.current = true;
        updateActiveActivityUserMessageNavId(anchorId);
        container.scrollTo({ top: targetTop, behavior: "smooth" });
        activityUserMessageJumpTimerRef.current = setTimeout(() => {
          activityUserMessageJumpTimerRef.current = null;
          programmaticActivityFeedScrollRef.current = false;
          if (activityMessagesRef.current !== container) {
            return;
          }
          activityFeedScrollTopRef.current = container.scrollTop;
          syncActivityFeedScrollJump(container);
          syncActivityUserMessageNavigator(container);
        }, 360);
        return true;
      };
      if (scrollToMountedAnchor()) {
        return;
      }
      // Virtualized rows may be unmounted — ask the feed to bring the section into range first.
      if (!dispatchFeedScrollToAnchor(container, anchorId)) {
        return;
      }
      userDetachedFromBottomRef.current = true;
      setActivityFeedDetachedAnchor(true);
      updateActiveActivityUserMessageNavId(anchorId);
      window.setTimeout(() => {
        if (activityMessagesRef.current !== container) {
          return;
        }
        if (!scrollToMountedAnchor()) {
          syncActivityFeedScrollJump(container);
          syncActivityUserMessageNavigator(container);
        }
      }, 48);
    },
    [
      syncActivityFeedScrollJump,
      syncActivityUserMessageNavigator,
      setActivityFeedDetachedAnchor,
      updateActiveActivityUserMessageNavId,
    ],
  );

  const scrollActivityFeedToEnd = useCallback(
    (force = false) => {
      const container = activityMessagesRef.current;
      if (!container) {
        return;
      }
      const effectiveForce = force || Date.now() < forceActivityFeedScrollUntilRef.current;
      if (!effectiveForce) {
        if (userDetachedFromBottomRef.current) {
          return;
        }
        // An end-anchored Feed is pinned inside virtual-core already. Following
        // again from here is the second writer that made the virtual boundary
        // re-derive on nearly every stream tick.
        if (feedEndAnchoredRef.current) {
          return;
        }
      }
      programmaticActivityFeedScrollRef.current = true;
      const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
      container.scrollTop = maxScrollTop;
      activityFeedScrollTopRef.current = container.scrollTop;
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          programmaticActivityFeedScrollRef.current = false;
          const el = activityMessagesRef.current;
          if (!el) {
            return;
          }
          activityFeedScrollTopRef.current = el.scrollTop;
          if (distanceFromActivityFeedBottom(el) <= ACTIVITY_FEED_STICK_THRESHOLD_PX) {
            userDetachedFromBottomRef.current = false;
            activityFeedUserScrollDirectionRef.current = null;
            setActivityFeedDetachedAnchor(false);
          }
          syncActivityFeedScrollJump(el);
          // Programmatic writes never reach the scroll listener (it early-returns on
          // `programmaticActivityFeedScrollRef`), so the rail would keep whatever the
          // pre-scroll geometry produced — a freshly opened thread stayed pinned to
          // the first message while the Feed sat at its end.
          syncActivityUserMessageNavigator(el);
        });
      });
    },
    [distanceFromActivityFeedBottom, syncActivityFeedScrollJump, syncActivityUserMessageNavigator],
  );

  const cancelActivityFeedLayoutScroll = useCallback(() => {
    if (activityFeedLayoutScrollTimerRef.current) {
      clearTimeout(activityFeedLayoutScrollTimerRef.current);
      activityFeedLayoutScrollTimerRef.current = null;
    }
  }, []);

  const markActivityFeedUserDetached = useCallback(
    (direction: ActivityFeedUserScrollDirection = "up") => {
      userDetachedFromBottomRef.current = true;
      activityFeedUserScrollDirectionRef.current = direction;
      setActivityFeedDetachedAnchor(true);
      // Stop stick-to-bottom timers so virtualization remounts cannot snap back mid-gesture.
      cancelActivityFeedLayoutScroll();
      forceActivityFeedScrollUntilRef.current = 0;
    },
    [cancelActivityFeedLayoutScroll, setActivityFeedDetachedAnchor],
  );

  const scheduleActivityFeedLayoutScroll = useCallback(() => {
    if (userDetachedFromBottomRef.current) {
      return;
    }
    const now = Date.now();
    const elapsed = now - lastActivityFeedLayoutScrollAtRef.current;
    if (elapsed >= ACTIVITY_FEED_LAYOUT_SCROLL_DEBOUNCE_MS) {
      lastActivityFeedLayoutScrollAtRef.current = now;
      scrollActivityFeedToEnd();
      requestAnimationFrame(() => scrollActivityFeedToEnd());
      return;
    }
    if (activityFeedLayoutScrollTimerRef.current) {
      return;
    }
    activityFeedLayoutScrollTimerRef.current = setTimeout(() => {
      activityFeedLayoutScrollTimerRef.current = null;
      if (userDetachedFromBottomRef.current) {
        return;
      }
      lastActivityFeedLayoutScrollAtRef.current = Date.now();
      scrollActivityFeedToEnd();
      requestAnimationFrame(() => scrollActivityFeedToEnd());
    }, ACTIVITY_FEED_LAYOUT_SCROLL_DEBOUNCE_MS - elapsed);
  }, [scrollActivityFeedToEnd]);

  const flushActivityFeedLayoutScroll = useCallback(() => {
    cancelActivityFeedLayoutScroll();
    if (userDetachedFromBottomRef.current) {
      return;
    }
    lastActivityFeedLayoutScrollAtRef.current = Date.now();
    scrollActivityFeedToEnd();
    requestAnimationFrame(() => scrollActivityFeedToEnd());
  }, [cancelActivityFeedLayoutScroll, scrollActivityFeedToEnd]);

  useEffect(
    () => () => {
      if (activityFeedLayoutScrollTimerRef.current) {
        clearTimeout(activityFeedLayoutScrollTimerRef.current);
      }
      if (activityUserMessageJumpTimerRef.current) {
        clearTimeout(activityUserMessageJumpTimerRef.current);
      }
      if (activityFeedStickRecoveryFrameRef.current !== null) {
        cancelAnimationFrame(activityFeedStickRecoveryFrameRef.current);
        activityFeedStickRecoveryFrameRef.current = null;
      }
    },
    [],
  );

  useLayoutEffect(() => {
    if (!currentProjectPath || !activeThread) {
      setActivityWorkspaceLayoutMode("feed-only");
      return undefined;
    }

    const activityWorkspace = activityWorkspaceRef.current;
    if (!activityWorkspace) {
      return undefined;
    }

    let frame = 0;
    const update = () => {
      if (frame) {
        cancelAnimationFrame(frame);
      }
      frame = requestAnimationFrame(() => {
        frame = 0;
        // MainPane / activity-workspace width → cards dock|float program only.
        const width = activityWorkspace.clientWidth;
        setActivityWorkspaceLayoutMode((current) => resolveActivityWorkspaceLayoutMode(width, current));
      });
    };

    const observer = new ResizeObserver(update);
    observer.observe(activityWorkspace);
    window.addEventListener("resize", update);
    update();

    return () => {
      if (frame) {
        cancelAnimationFrame(frame);
      }
      observer.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [activeThread?.id, currentProjectPath]);

  useLayoutEffect(() => {
    if (!currentProjectPath || !activeThread) {
      setFeedLeftGutterPx(0);
      return undefined;
    }

    const feedColumn = scrollBodyRef.current;
    if (!feedColumn) {
      return undefined;
    }

    let frame = 0;
    const update = () => {
      if (frame) {
        cancelAnimationFrame(frame);
      }
      frame = requestAnimationFrame(() => {
        frame = 0;
        setFeedLeftGutterPx(measureFeedColumnLeftGutterPx(feedColumn));
      });
    };

    const observer = new ResizeObserver(update);
    observer.observe(feedColumn);
    const feedStack = feedColumn.querySelector(".codex-feed-stack");
    if (feedStack) {
      observer.observe(feedStack);
    }
    window.addEventListener("resize", update);
    update();

    return () => {
      if (frame) {
        cancelAnimationFrame(frame);
      }
      observer.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [activeThread?.id, activityWorkspaceLayoutMode, currentProjectPath]);

  useEffect(() => {
    setActivityMessageNavSpaceVisible((current) =>
      shouldShowActivityMessageNav(feedLeftGutterPx, activityUserMessageNavItems.length, current),
    );
  }, [activityUserMessageNavItems.length, feedLeftGutterPx]);

  const requestActivityFeedForceScroll = useCallback(() => {
    forceActivityFeedScrollUntilRef.current = Date.now() + ACTIVITY_FEED_FORCE_SCROLL_MS;
    userDetachedFromBottomRef.current = false;
    activityFeedUserScrollDirectionRef.current = null;
    setActivityFeedDetachedAnchor(false);
    activityFeedScrollJumpRef.current = null;
    setActivityFeedScrollJump(null);
    scrollActivityFeedToEnd(true);
    requestAnimationFrame(() => {
      scrollActivityFeedToEnd(true);
      requestAnimationFrame(() => scrollActivityFeedToEnd(true));
    });
  }, [scrollActivityFeedToEnd, setActivityFeedDetachedAnchor]);

  const activityFeedStickRecoveryFrameRef = useRef<number | null>(null);
  /**
   * The virtualizer swaps a top spacer for a freshly mounted (often heavy,
   * ProseMirror-backed) row inside one commit. A forced layout landing between
   * those mutations makes Chromium clamp `scrollTop` against the transiently
   * shorter `scrollHeight`; once the row lands the height is restored but the
   * offset is not, and virtual-core's end anchor declines to correct it because
   * it no longer sees the feed at its end. The follow state deliberately runs
   * `overflow-anchor: none`, so nothing else heals a drift past the growth band
   * (the content observer only re-pins within `STICK_THRESHOLD * 2`). Re-pin
   * once the layout settles, and never for a reader who scrolled away.
   */
  const recoverActivityFeedStick = useCallback(() => {
    if (userDetachedFromBottomRef.current) {
      return;
    }
    const container = activityMessagesRef.current;
    if (
      !container ||
      distanceFromActivityFeedBottom(container) <= ACTIVITY_FEED_STICK_THRESHOLD_PX
    ) {
      return;
    }
    // `force` past `feedEndAnchoredRef`; the anchor already declined to correct
    // this offset (it no longer considers the feed at its end). Correct before
    // the next paint when `scrollHeight` already settled, then verify once on the
    // next frame for a clamp measured against a still-transient height.
    scrollActivityFeedToEnd(true);
    if (activityFeedStickRecoveryFrameRef.current !== null) {
      return;
    }
    activityFeedStickRecoveryFrameRef.current = requestAnimationFrame(() => {
      activityFeedStickRecoveryFrameRef.current = null;
      if (userDetachedFromBottomRef.current) {
        return;
      }
      const el = activityMessagesRef.current;
      if (!el || distanceFromActivityFeedBottom(el) <= ACTIVITY_FEED_STICK_THRESHOLD_PX) {
        return;
      }
      scrollActivityFeedToEnd(true);
    });
  }, [distanceFromActivityFeedBottom, scrollActivityFeedToEnd]);

  const jumpActivityFeedToTop = useCallback(() => {
    const container = activityMessagesRef.current;
    if (!container) {
      return;
    }
    markActivityFeedUserDetached("up");
    programmaticActivityFeedScrollRef.current = true;
    container.scrollTo({ top: 0, behavior: "smooth" });
    activityFeedScrollTopRef.current = 0;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        programmaticActivityFeedScrollRef.current = false;
        if (activityMessagesRef.current) {
          syncActivityFeedScrollJump(activityMessagesRef.current);
        }
      });
    });
  }, [markActivityFeedUserDetached, syncActivityFeedScrollJump]);

  const handleActivityFeedScrollJump = useCallback(() => {
    if (activityFeedScrollJump === "top") {
      jumpActivityFeedToTop();
      return;
    }
    requestActivityFeedForceScroll();
  }, [activityFeedScrollJump, jumpActivityFeedToTop, requestActivityFeedForceScroll]);

  const handleActivityPlannerLayoutChange = useCallback(
    (options?: { immediate?: boolean }) => {
      if (userDetachedFromBottomRef.current) {
        const container = activityMessagesRef.current;
        if (container) {
          clampActivityFeedOverscroll(container);
        }
        return;
      }
      if (options?.immediate) {
        const container = activityMessagesRef.current;
        if (container) {
          clampActivityFeedOverscroll(container);
        }
        flushActivityFeedLayoutScroll();
        return;
      }
      scheduleActivityFeedLayoutScroll();
    },
    [clampActivityFeedOverscroll, flushActivityFeedLayoutScroll, scheduleActivityFeedLayoutScroll],
  );

  const tryAdvanceActivityFeedBoot = useCallback(() => {
    const threadId = selectedThreadIdRef.current;
    if (!threadId || activityFeedBootReadyRef.current) {
      return;
    }
    const projection = runProjectionRef.current;
    const settled = feedProjectionSettledByThreadRef.current[threadId] === true;
    if (!projection && !settled) {
      return;
    }
    const container = activityMessagesRef.current;
    if (!container || container.clientHeight < 32) {
      return;
    }
    const finish = () => finishActivityFeedBoot(threadId);
    const hasMountedFeed = container.scrollHeight > container.clientHeight + 8;
    if (!hasMountedFeed) {
      finish();
      return;
    }
    programmaticActivityFeedScrollRef.current = true;
    container.scrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
    activityFeedScrollTopRef.current = container.scrollTop;
    requestAnimationFrame(() => {
      programmaticActivityFeedScrollRef.current = false;
      finish();
    });
  }, [finishActivityFeedBoot]);
  tryAdvanceActivityFeedBootRef.current = tryAdvanceActivityFeedBoot;

  const syncActivityFeedBoot = useCallback((container?: HTMLElement | null) => {
    if (!container && !activityMessagesRef.current) {
      return;
    }
    if (!activityFeedBootReadyRef.current) {
      tryAdvanceActivityFeedBootRef.current();
    }
  }, []);
  syncActivityFeedBootRef.current = syncActivityFeedBoot;

  useEffect(() => {
    if (!activeThread?.id || activityFeedBootReady) {
      return;
    }
    const threadId = activeThread.id;
    const timer = window.setTimeout(() => {
      finishActivityFeedBoot(threadId);
    }, ACTIVITY_FEED_BOOT_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [activeThread?.id, activityFeedBootReady, finishActivityFeedBoot]);

  useLayoutEffect(() => {
    if (activityFeedBootReady) {
      return;
    }
    tryAdvanceActivityFeedBoot();
  }, [activityFeedBootReady, feedProjectionSettledByThread, runProjection, tryAdvanceActivityFeedBoot]);

  useEffect(() => {
    const container = activityMessagesRef.current;
    if (!container) {
      return;
    }
    activityFeedScrollTopRef.current = container.scrollTop;
    let scrollbarDragging = false;
    let userScrollUntil = 0;
    let touchStartY: number | undefined;
    const onScroll = () => {
      if (programmaticActivityFeedScrollRef.current) {
        return;
      }
      const scrollTop = container.scrollTop;
      if (Date.now() < forceActivityFeedScrollUntilRef.current) {
        activityFeedScrollTopRef.current = scrollTop;
        syncActivityFeedBoot(container);
        return;
      }
      const distanceFromBottom = distanceFromActivityFeedBottom(container);
      if (scrollTop < activityFeedScrollTopRef.current - ACTIVITY_FEED_USER_SCROLL_DELTA_PX) {
        // Virtualizer corrections and browser clamps also emit scroll events.
        // Wheel, touch and keyboard intent detach before scrolling; only a
        // scrollbar drag still needs to infer its direction here.
        if (scrollbarDragging) {
          markActivityFeedUserDetached("up");
        }
      } else if (scrollTop > activityFeedScrollTopRef.current + ACTIVITY_FEED_USER_SCROLL_DELTA_PX) {
        if (scrollbarDragging || performance.now() < userScrollUntil) {
          activityFeedUserScrollDirectionRef.current = "down";
        }
        if (
          distanceFromBottom <= ACTIVITY_FEED_STICK_THRESHOLD_PX &&
          (scrollbarDragging || performance.now() < userScrollUntil)
        ) {
          userDetachedFromBottomRef.current = false;
          setActivityFeedDetachedAnchor(false);
        }
      } else if (
        distanceFromBottom <= ACTIVITY_FEED_STICK_THRESHOLD_PX &&
        (scrollbarDragging || performance.now() < userScrollUntil) &&
        activityFeedUserScrollDirectionRef.current !== "up"
      ) {
        // A trackpad can report an upward gesture as a sequence of 1px scroll
        // events. The wheel handler has already recorded that intent, so do not
        // interpret the sub-threshold movement as a return to the bottom.
        userDetachedFromBottomRef.current = false;
        activityFeedUserScrollDirectionRef.current = null;
        setActivityFeedDetachedAnchor(false);
      }
      activityFeedScrollTopRef.current = scrollTop;
      if (scrollTop <= ACTIVITY_FEED_SCROLL_JUMP_THRESHOLD_PX) {
        activityFeedUserScrollDirectionRef.current = null;
      }
      syncActivityFeedBoot(container);
      syncActivityFeedScrollJump(container);
      syncActivityUserMessageNavigator(container);
      // No wheel/touch/keyboard intent, yet the follow state is far from the
      // bottom: the browser clamped a transient spacer collapse. Recover it.
      if (
        !userDetachedFromBottomRef.current &&
        !scrollbarDragging &&
        performance.now() >= userScrollUntil &&
        distanceFromBottom > ACTIVITY_FEED_STICK_THRESHOLD_PX
      ) {
        recoverActivityFeedStick();
      }
    };
    const onWheel = (event: WheelEvent) => {
      userScrollUntil = performance.now() + 500;
      if (event.deltaY > 0) {
        if (userDetachedFromBottomRef.current) {
          activityFeedUserScrollDirectionRef.current = "down";
        }
        return;
      }
      if (event.deltaY === 0) {
        return;
      }
      // Detach before virtualization ResizeObserver can snap stick-to-bottom mid-gesture.
      if (userDetachedFromBottomRef.current) {
        markActivityFeedUserDetached("up");
      } else {
        // Disable virtual-core's resize/append follow before the next observer
        // callback, even when this gesture has not left the 120px stick band.
        flushSync(() => markActivityFeedUserDetached("up"));
      }
      syncActivityFeedBoot(container);
    };
    const detachForInput = () => flushSync(() => markActivityFeedUserDetached("up"));
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (event.defaultPrevented) return;
      if (target instanceof Element) {
        if (target.closest("input, textarea, [contenteditable=true]")) return;
        if (event.key === " " && target.closest("button")) return;
      }
      if (event.key === "End") {
        event.preventDefault();
        requestActivityFeedForceScroll();
        return;
      }
      userScrollUntil = performance.now() + 500;
      if (["ArrowUp", "PageUp", "Home"].includes(event.key) || (event.key === " " && event.shiftKey)) {
        detachForInput();
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      if (event.pointerType === "touch") {
        touchStartY = event.clientY;
      } else if (
        event.target === container &&
        event.clientX >= container.getBoundingClientRect().right - 20
      ) {
        scrollbarDragging = true;
      }
    };
    const onPointerMove = (event: PointerEvent) => {
      if (touchStartY === undefined) return;
      userScrollUntil = performance.now() + 500;
      const deltaY = event.clientY - touchStartY;
      if (deltaY > 2) {
        detachForInput();
      } else if (deltaY < -2 && userDetachedFromBottomRef.current) {
        activityFeedUserScrollDirectionRef.current = "down";
      }
    };
    const onPointerUp = () => {
      scrollbarDragging = false;
      touchStartY = undefined;
    };
    container.addEventListener("scroll", onScroll, { passive: true });
    container.addEventListener("wheel", onWheel, { passive: true });
    container.addEventListener("keydown", onKeyDown);
    container.addEventListener("pointerdown", onPointerDown);
    container.addEventListener("pointermove", onPointerMove, { passive: true });
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
    syncActivityFeedBoot(container);
    syncActivityFeedScrollJump(container);
    syncActivityUserMessageNavigator(container);
    return () => {
      container.removeEventListener("scroll", onScroll);
      container.removeEventListener("wheel", onWheel);
      container.removeEventListener("keydown", onKeyDown);
      container.removeEventListener("pointerdown", onPointerDown);
      container.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
    };
  }, [
    activeThread?.id,
    distanceFromActivityFeedBottom,
    markActivityFeedUserDetached,
    recoverActivityFeedStick,
    requestActivityFeedForceScroll,
    setActivityFeedDetachedAnchor,
    syncActivityFeedBoot,
    syncActivityFeedScrollJump,
    syncActivityUserMessageNavigator,
  ]);

  useEffect(() => {
    const container = activityMessagesRef.current;
    if (!container || !activeThread?.id) {
      return;
    }
    const content = container.querySelector(".run-log");
    if (!(content instanceof HTMLElement)) {
      return;
    }
    let lastContentHeight = content.getBoundingClientRect().height;
    const observer = new ResizeObserver(() => {
      const nextContentHeight = content.getBoundingClientRect().height;
      const heightDelta = nextContentHeight - lastContentHeight;
      lastContentHeight = nextContentHeight;
      const distanceFromBottom = distanceFromActivityFeedBottom(container);
      clampActivityFeedOverscroll(container);
      syncActivityFeedBoot(container);
      if (userDetachedFromBottomRef.current) {
        syncActivityUserMessageNavigator(container);
        return;
      }
      // Virtualization remounts change .run-log height while the user is mid scroll-up,
      // often before detach is committed. Never treat "far from bottom" as stick recovery
      // here — that path snapped the viewport back and caused jitter.
      if (distanceFromBottom <= ACTIVITY_FEED_STICK_THRESHOLD_PX) {
        scrollActivityFeedToEnd();
        requestAnimationFrame(() => scrollActivityFeedToEnd());
        requestAnimationFrame(() => syncActivityUserMessageNavigator(container));
        return;
      }
      // Content grew while we were slightly outside the stick zone (stream append) — follow.
      if (heightDelta > 1 && distanceFromBottom <= ACTIVITY_FEED_STICK_THRESHOLD_PX * 2) {
        scheduleActivityFeedLayoutScroll();
      }
      syncActivityUserMessageNavigator(container);
    });
    observer.observe(content);
    syncActivityUserMessageNavigator(container);
    return () => observer.disconnect();
  }, [
    activeThread?.id,
    clampActivityFeedOverscroll,
    distanceFromActivityFeedBottom,
    scheduleActivityFeedLayoutScroll,
    scrollActivityFeedToEnd,
    syncActivityFeedBoot,
    syncActivityUserMessageNavigator,
  ]);

  useEffect(() => {
    const container = activityMessagesRef.current;
    if (!container || !activeThread?.id) {
      return;
    }
    let lastClientHeight = container.clientHeight;
    const observer = new ResizeObserver(() => {
      const nextClientHeight = container.clientHeight;
      const delta = lastClientHeight - nextClientHeight;
      lastClientHeight = nextClientHeight;
      if (delta === 0) {
        return;
      }
      clampActivityFeedOverscroll(container);
      syncActivityFeedBoot(container);
      // Terminal open/close resizes the feed viewport. Keep stick-to-bottom so content
      // rises with the panel instead of being clipped under it. End-anchored rows
      // compensate item growth, not a shrinking scroll element (upstream
      // TanStack/virtual#1297 is still open on that), so this writer stays on even
      // when the Feed is virtualized — hence the forced call.
      if (userDetachedFromBottomRef.current) {
        if (delta > 0) {
          container.scrollTop = Math.max(0, container.scrollTop + delta);
          activityFeedScrollTopRef.current = container.scrollTop;
        }
        syncActivityFeedScrollJump(container);
        syncActivityUserMessageNavigator(container);
        return;
      }
      scrollActivityFeedToEnd(true);
      requestAnimationFrame(() => scrollActivityFeedToEnd(true));
      syncActivityUserMessageNavigator(container);
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [
    activeThread?.id,
    clampActivityFeedOverscroll,
    scrollActivityFeedToEnd,
    syncActivityFeedBoot,
    syncActivityFeedScrollJump,
    syncActivityUserMessageNavigator,
  ]);

  useEffect(() => {
    if (!activeThread?.id || !currentProjectPath) {
      return;
    }
    if (userDetachedFromBottomRef.current) {
      return;
    }
    // Follow terminal height animation frames while stick-to-bottom is active.
    const startedAt = performance.now();
    const durationMs = 360;
    let frame = 0;
    const tick = () => {
      scrollActivityFeedToEnd();
      if (performance.now() - startedAt < durationMs) {
        frame = requestAnimationFrame(tick);
      }
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [
    activeThread?.id,
    currentProjectPath,
    currentTerminalState?.height,
    currentTerminalState?.open,
    scrollActivityFeedToEnd,
  ]);

  useLayoutEffect(() => {
    activityFeedUserScrollDirectionRef.current = null;
    activityFeedScrollJumpRef.current = null;
    activeActivityUserMessageNavIdRef.current = undefined;
    setActiveActivityUserMessageNavId(undefined);
    setActivityFeedScrollJump(null);
  }, [activeThread?.id]);

  useLayoutEffect(() => {
    const container = activityMessagesRef.current;
    if (container) {
      const distanceFromBottom = distanceFromActivityFeedBottom(container);
      if (distanceFromBottom <= ACTIVITY_FEED_STICK_THRESHOLD_PX) {
        activityFeedUserScrollDirectionRef.current = null;
      } else if (container.scrollTop <= ACTIVITY_FEED_SCROLL_JUMP_THRESHOLD_PX) {
        activityFeedUserScrollDirectionRef.current = null;
      }
      syncActivityFeedScrollJump(container);
      syncActivityUserMessageNavigator(container);
    }
  }, [
    distanceFromActivityFeedBottom,
    runProjectionLayoutSignature,
    syncActivityFeedScrollJump,
    syncActivityUserMessageNavigator,
  ]);

  useLayoutEffect(() => {
    if (!activityFeedBootReady || !activeThread?.id) {
      return;
    }
    requestActivityFeedForceScroll();
    scrollActivityFeedToEnd(true);
    const frame = requestAnimationFrame(() => scrollActivityFeedToEnd(true));
    return () => cancelAnimationFrame(frame);
  }, [activeThread?.id, activityFeedBootReady, requestActivityFeedForceScroll, scrollActivityFeedToEnd]);

  useLayoutEffect(() => {
    requestActivityFeedForceScroll();
  }, [activeThread?.id, requestActivityFeedForceScroll]);

  useLayoutEffect(() => {
    if (!runProjectionLayoutSignature || !activeThread) {
      return;
    }
    const container = activityMessagesRef.current;
    if (container) {
      clampActivityFeedOverscroll(container);
    }
    const forceScroll = Date.now() < forceActivityFeedScrollUntilRef.current;
    if (forceScroll) {
      scrollActivityFeedToEnd(true);
      const frame = requestAnimationFrame(() => scrollActivityFeedToEnd(true));
      return () => cancelAnimationFrame(frame);
    }
    if (userDetachedFromBottomRef.current) {
      return;
    }
    if (activeThread.status === "running") {
      scheduleActivityFeedLayoutScroll();
      return;
    }
    flushActivityFeedLayoutScroll();
    const frame = requestAnimationFrame(() => scrollActivityFeedToEnd(true));
    return () => cancelAnimationFrame(frame);
  }, [
    activeThread?.id,
    activeThread?.status,
    clampActivityFeedOverscroll,
    flushActivityFeedLayoutScroll,
    runProjectionLayoutSignature,
    scheduleActivityFeedLayoutScroll,
    scrollActivityFeedToEnd,
  ]);

  useLayoutEffect(() => {
    if (!showPlanApproval || !activeThread) {
      return;
    }
    scrollActivityFeedToEnd(true);
    const frame = requestAnimationFrame(() => scrollActivityFeedToEnd(true));
    return () => cancelAnimationFrame(frame);
  }, [activeThread?.id, scrollActivityFeedToEnd, showPlanApproval]);

  async function openWorkspace() {
    setError(undefined);
    if (!window.eco) {
      setError("Electron preload API is unavailable. Run the desktop app with bun run dev:electron.");
      return;
    }

    setIsOpening(true);
    try {
      const result = await window.eco.openWorkspace();
      if (!result.canceled && result.workspace) {
        activateWorkspace(result.workspace);
        await refreshGitStatus(result.workspace.path);
      }
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setIsOpening(false);
    }
  }

  async function openProjectFromPath(path: string) {
    if (!window.eco) {
      throw new Error("Electron preload API is unavailable. Run the desktop app with bun run dev:electron.");
    }
    const workspace = await window.eco.openWorkspacePath(path);
    activateWorkspace(workspace);
  }

  async function handleOpenProjectFromDrop(path: string) {
    setError(undefined);
    setIsOpening(true);
    try {
      await openProjectFromPath(path);
      await refreshGitStatus(path);
    } catch (caught) {
      setError(errorMessage(caught));
      throw caught;
    } finally {
      setIsOpening(false);
    }
  }

  function handleOpenProjectRowDragOver(event: ReactDragEvent<HTMLElement>) {
    if (!Array.from(event.dataTransfer.types).includes("Files")) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }

  function handleOpenProjectRowDrop(event: ReactDragEvent<HTMLElement>) {
    if (!window.eco || !Array.from(event.dataTransfer.types).includes("Files")) {
      return;
    }
    event.preventDefault();
    for (const file of Array.from(event.dataTransfer.files)) {
      const path = window.eco.getPathForFile(file);
      if (!path) {
        continue;
      }
      void handleOpenProjectFromDrop(path).catch(() => {
        // handleOpenProjectFromDrop already surfaced the error in the sidebar.
      });
      return;
    }
  }

  async function resyncThreadSummaryAfterWaitForRun(threadId: string): Promise<void> {
    if (!window.eco) {
      return;
    }
    try {
      const [summary, threads] = await Promise.all([
        typeof window.eco.getThread === "function"
          ? window.eco.getThread(threadId)
          : Promise.resolve(undefined),
        typeof window.eco.listThreads === "function" ? window.eco.listThreads() : Promise.resolve(undefined),
      ]);
      if (threads) {
        setThreads(threads);
      } else if (summary) {
        setThreads((current) => current.map((thread) => (thread.id === summary.id ? summary : thread)));
      }
      await refreshThreadState(threadId);
    } catch {
      // Best-effort resync so Stop becomes available when renderer/main status drifted.
    }
  }

  async function refreshThreadState(threadId: string) {
    if (!window.eco) {
      return;
    }
    const [plan, approvedPlan, clarification, bashApproval, followUps] = await Promise.all([
      window.eco.getPendingPlan(threadId),
      typeof window.eco.getApprovedPlan === "function"
        ? window.eco.getApprovedPlan(threadId)
        : Promise.resolve(undefined),
      window.eco.getPendingClarification(threadId),
      typeof window.eco.getPendingBashApproval === "function"
        ? window.eco.getPendingBashApproval(threadId)
        : Promise.resolve(undefined),
      typeof window.eco.listThreadFollowUps === "function"
        ? window.eco.listThreadFollowUps(threadId)
        : Promise.resolve({ followUps: [] }),
    ]);
    if (plan) {
      upsertPendingPlanForThread(threadId, plan);
    } else {
      clearPendingPlanForThread(threadId);
      if (approvedPlan) {
        rememberApprovedPlanForThread(threadId, approvedPlan);
      } else {
        clearApprovedPlanForThread(threadId);
      }
    }
    if (clarification) {
      upsertPendingClarificationForThread(threadId, clarification);
    } else {
      clearPendingClarificationForThread(threadId);
    }
    if (bashApproval) {
      upsertPendingBashApprovalForThread(threadId, bashApproval);
    } else {
      clearPendingBashApprovalForThread(threadId);
    }
    setFollowUpsByThread((current) => {
      const previous = current[threadId];
      if (!previous?.length && followUps.followUps.length === 0) return current;
      return { ...current, [threadId]: mergeThreadFollowUps(previous ?? [], followUps.followUps) };
    });
    refreshConversationV2ProjectionExtras(threadId);
  }

  const restorePrompt = useCallback(
    (text: string, rewindTarget?: ThreadActivityRewindTarget) => {
      setPrompt(text);
      if (activeThread && rewindTarget) {
        setComposerRewindTarget({ ...rewindTarget, threadId: activeThread.id });
      } else {
        setComposerRewindTarget(undefined);
      }
      window.requestAnimationFrame(() => {
        composerRef.current?.focus();
        composerRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
      });
    },
    [activeThread?.id],
  );

  async function loadUserMessageEdit(activityLineId: string) {
    if (!activeThread) {
      throw new Error(t("activity.editUnavailable", { defaultValue: "未选择会话，无法编辑此消息" }));
    }
    if (typeof window.eco?.getUserMessageEdit !== "function") {
      throw new Error(t("activity.editUnavailable", { defaultValue: "当前版本不支持消息编辑" }));
    }
    return window.eco.getUserMessageEdit({
      threadId: activeThread.id,
      activityLineId,
    });
  }

  async function rewriteUserMessage(input: {
    activityLineId: string;
    prompt: string;
    attachments: PromptImageAttachment[];
    expectedHistoryRevision: number;
    runtimeConfig?: ThreadRuntimeConfig;
  }) {
    if (!activeThread) {
      throw new Error(t("activity.editUnavailable", { defaultValue: "未选择会话，无法编辑此消息" }));
    }
    if (typeof window.eco?.rewriteThreadFromMessage !== "function") {
      throw new Error(t("activity.editUnavailable", { defaultValue: "当前版本不支持消息编辑" }));
    }
    const threadId = activeThread.id;
    try {
      const result = await window.eco.rewriteThreadFromMessage({
        principalId: "desktop-local",
        clientCommandId: `history_rewrite_${stableHash({
          threadId,
          activityLineId: input.activityLineId,
          prompt: input.prompt,
          attachments: input.attachments,
          expectedHistoryRevision: input.expectedHistoryRevision,
          ...(input.runtimeConfig ? { runtimeConfig: input.runtimeConfig } : {}),
        })}`,
        threadId,
        activityLineId: input.activityLineId,
        prompt: input.prompt,
        attachments: input.attachments,
        expectedHistoryRevision: input.expectedHistoryRevision,
        ...(input.runtimeConfig ? { runtimeConfig: input.runtimeConfig } : {}),
      });
      setThreads((current) =>
        current.map((thread) => (thread.id === result.thread.id ? result.thread : thread)),
      );
      clearPendingPlanForThread(threadId);
      clearPendingClarificationForThread(threadId);
      clearPendingBashApprovalForThread(threadId);
      queueConversationV2Recovery(threadId);
      try {
        await refreshThreadState(threadId);
      } catch (caught) {
        throw new Error(
          t("activity.editRefreshFailed", {
            defaultValue: "消息已提交，但历史刷新失败：{{detail}}",
            detail: errorMessage(caught),
          }),
        );
      }
      requestActivityFeedForceScroll();
      return result;
    } catch (caught) {
      queueConversationV2Recovery(threadId);
      try {
        await refreshThreadState(threadId);
      } catch {
        // Preserve the original rewrite failure.
      }
      throw caught;
    }
  }

  const activityLoadUserMessageEdit = useStableCallback(loadUserMessageEdit);
  const activityRewriteUserMessage = useStableCallback(rewriteUserMessage);
  const activityForkMessage = useStableCallback(
    async (input: { activityLineId: string; expectedHistoryRevision: number }) => {
      if (!activeThread || !window.eco) throw new Error("当前会话不可用。");
      const result = await window.eco.forkThreadFromMessage({
        principalId: "desktop-local",
        clientCommandId: `history_fork_${crypto.randomUUID()}`,
        threadId: activeThread.id,
        ...input,
      });
      persistComposerDraftSnapshot(composerDraftsByKeyRef.current, `thread:${result.thread.id}`, {
        prompt: result.draft.prompt,
        attachments: fromPromptImageAttachments(result.draft.attachments),
      });
      setThreads((current) =>
        current.some((thread) => thread.id === result.thread.id)
          ? current.map((thread) => (thread.id === result.thread.id ? result.thread : thread))
          : [result.thread, ...current],
      );
      selectThread(result.thread);
      queueConversationV2Recovery(result.thread.id);
      await refreshThreadState(result.thread.id);
    },
  );
  const activityRetryFailedRequest = useStableCallback(retryFailedRequest);

  async function sendConversationV2Continuation(input: {
    thread: ThreadSummary;
    prompt: string;
    runtimeConfig: ThreadRuntimeConfig;
    attachments?: PromptImageAttachment[];
    commandScope: string;
    historyRevision?: number;
  }): Promise<ThreadSummary | undefined> {
    const eco = window.eco;
    if (
      !eco ||
      typeof eco.conversationV2SendMessage !== "function" ||
      typeof eco.updateThreadRuntimeConfig !== "function"
    ) {
      throw new Error("Conversation V2 sending is unavailable; refusing legacy continuation.");
    }
    const configured = await eco.updateThreadRuntimeConfig(
      await buildV2CommandEnvelope(input.thread.id, "runtime-config", {
        runtimeConfig: input.runtimeConfig,
      }),
    );
    try {
      const clientCommandId = `conversation_send_${input.commandScope}_${crypto.randomUUID()}`;
      await eco.conversationV2SendMessage({
        principalId: "desktop-local",
        conversationId: input.thread.id,
        clientCommandId,
        text: input.prompt,
        ...(input.attachments?.length ? { attachments: input.attachments } : {}),
      });
      clearPendingPlanForThread(input.thread.id);
      clearPendingClarificationForThread(input.thread.id);
      clearPendingBashApprovalForThread(input.thread.id);
      const [updated] = await Promise.all([
        eco.getThread(input.thread.id),
        refreshThreadState(input.thread.id),
      ]);
      const summary = updated ?? configured.thread;
      startTransition(() =>
        setThreads((current) => current.map((thread) => (thread.id === summary.id ? summary : thread))),
      );
      return summary;
    } catch (caught) {
      // Configuration was committed even if sending or refreshing failed.
      setThreads((current) =>
        current.map((thread) => (thread.id === configured.thread.id ? configured.thread : thread)),
      );
      throw caught;
    }
  }

  async function continueInterruptedCodexTurn(
    target: RequestFailureRetryTarget & { sourceAttemptId: string },
  ) {
    if (!activeThread || isStarting || !window.eco) return;
    const threadId = activeThread.id;
    const expectedHistoryRevision = displayProjection?.historyRevision ?? 0;
    setIsStarting(true);
    setError(undefined);
    try {
      const result = await window.eco.continueCodexThread({
        principalId: "desktop-local",
        clientCommandId: `codex_continue_${stableHash({ threadId, sourceAttemptId: target.sourceAttemptId })}`,
        threadId,
        activityLineId: target.activityLineId,
        prompt: target.prompt,
        hasImages: target.hasImages,
        sourceAttemptId: target.sourceAttemptId,
        expectedHistoryRevision,
      });
      setThreads((current) =>
        current.map((thread) => (thread.id === result.thread.id ? result.thread : thread)),
      );
      queueConversationV2Recovery(threadId);
      await refreshThreadState(threadId);
      requestActivityFeedForceScroll();
    } catch (caught) {
      setError(errorMessage(caught));
      queueConversationV2Recovery(threadId);
    } finally {
      setIsStarting(false);
    }
  }

  async function retryFailedRequest(target: RequestFailureRetryTarget) {
    if (!activeThread) {
      setError(t("activity.retryUnavailable"));
      return;
    }
    if (typeof window.eco?.retryThreadFromMessage !== "function") {
      setError(t("activity.retryUnavailable"));
      return;
    }
    if (isStarting) {
      return;
    }
    const threadId = activeThread.id;
    const historyRevision = displayProjection?.historyRevision ?? 0;
    const useRewrite = usesRewindOnRequestRetry(activeThread.coreKind);
    setError(undefined);
    requestActivityFeedForceScroll();
    if (useRewrite) {
    }
    setIsStarting(true);
    try {
      const result = await window.eco.retryThreadFromMessage({
        principalId: "desktop-local",
        clientCommandId: `history_retry_${stableHash({
          threadId,
          activityLineId: target.activityLineId,
          prompt: target.prompt,
          hasImages: target.hasImages,
          expectedHistoryRevision: historyRevision,
        })}`,
        threadId,
        activityLineId: target.activityLineId,
        prompt: target.prompt,
        hasImages: target.hasImages,
        expectedHistoryRevision: historyRevision,
      });
      setThreads((current) =>
        current.map((thread) => (thread.id === result.thread.id ? result.thread : thread)),
      );
      clearPendingPlanForThread(threadId);
      clearPendingClarificationForThread(threadId);
      clearPendingBashApprovalForThread(threadId);
      queueConversationV2Recovery(threadId);
      try {
        await refreshThreadState(threadId);
      } catch (caught) {
        setError(
          t("activity.editRefreshFailed", {
            defaultValue: "消息已提交，但历史刷新失败：{{detail}}",
            detail: errorMessage(caught),
          }),
        );
      }
      requestActivityFeedForceScroll();
    } catch (caught) {
      if (useRewrite) {
        queueConversationV2Recovery(threadId);
        try {
          await refreshThreadState(threadId);
        } catch {
          // Preserve the original retry failure.
        }
      }
      setError(errorMessage(caught));
    } finally {
      setIsStarting(false);
    }
  }

  async function buildV2CommandEnvelope<T extends Record<string, unknown>>(
    threadId: string,
    operation: string,
    payload: T,
  ): Promise<
    T & { principalId: string; clientCommandId: string; threadId: string; expectedHistoryRevision: number }
  > {
    const api = window.eco;
    if (!api) {
      throw new Error("Desktop API is unavailable.");
    }
    return buildConversationV2CommandEnvelope({
      threadId,
      operation,
      payload,
      getHead: (id) => api.conversationV2Head(id),
    });
  }

  async function releaseThreadFollowUpEditingLock(threadId: string) {
    if (typeof window.eco?.setThreadFollowUpEditing !== "function") {
      return;
    }
    await window.eco.setThreadFollowUpEditing(await buildV2CommandEnvelope(threadId, "editing-release", {}));
  }

  function restoreComposerAfterFollowUpEdit() {
    const restored = resolveComposerAfterFollowUpEdit(savedComposerBeforeFollowUpEditRef.current);
    savedComposerBeforeFollowUpEditRef.current = undefined;
    const restoredAttachments = restored.attachments as ComposerImageAttachment[];
    const restoredPreviewUrls = new Set(
      restoredAttachments.map((attachment) => attachment.previewUrl).filter(Boolean),
    );
    composerAttachmentsRef.current.forEach((attachment) => {
      if (!restoredPreviewUrls.has(attachment.previewUrl)) {
        revokeComposerAttachmentPreview(attachment);
      }
    });
    composerPromptRef.current = restored.prompt;
    setPrompt(restored.prompt);
    setComposerAttachments(restoredAttachments);
    setComposerRewindTarget(restored.rewindTarget as ComposerRewindTarget | undefined);
    setComposerImageNotice(restored.imageNotice);
  }

  async function startEditingFollowUp(followUp: ThreadPendingFollowUp) {
    if (typeof window.eco?.setThreadFollowUpEditing !== "function") {
      setError(t("app.preload.followUpEditing"));
      return;
    }
    setFollowUpBusy(true);
    setError(undefined);
    try {
      await window.eco.setThreadFollowUpEditing({
        ...(await buildV2CommandEnvelope(followUp.threadId, "editing-acquire", {
          followUpId: followUp.id,
        })),
      });
      if (selectedThreadIdRef.current !== followUp.threadId) {
        await releaseThreadFollowUpEditingLock(followUp.threadId);
        return;
      }
      const savedDraft = captureComposerBeforeFollowUpEdit({
        alreadyEditing: Boolean(editingFollowUpIdRef.current),
        prompt: composerPromptRef.current,
        attachments: composerAttachmentsRef.current,
        ...(composerRewindTargetRef.current ? { rewindTarget: composerRewindTargetRef.current } : {}),
        ...(composerImageNotice ? { imageNotice: composerImageNotice } : {}),
      });
      if (savedDraft) {
        savedComposerBeforeFollowUpEditRef.current = savedDraft;
      }
      editingFollowUpIdRef.current = followUp.id;
      editingFollowUpThreadIdRef.current = followUp.threadId;
      setEditingFollowUpId(followUp.id);
      setPrompt(followUp.prompt);
      setComposerAttachments(fromPromptImageAttachments(followUp.attachments ?? []));
      setComposerImageNotice(undefined);
      setComposerRewindTarget(undefined);
      composerRef.current?.focus();
    } catch (caught) {
      await refreshFollowUpsAfterMutationError(followUp.threadId, caught);
    } finally {
      setFollowUpBusy(false);
    }
  }

  async function cancelEditingFollowUp() {
    const expectedFollowUpId = editingFollowUpIdRef.current;
    const threadId = editingFollowUpThreadIdRef.current ?? selectedThreadIdRef.current;
    if (editingFollowUpIdRef.current && threadId) {
      await releaseThreadFollowUpEditingLock(threadId);
    }
    // A thread switch during the unlock must not clear the new composer/draft.
    if (
      editingFollowUpIdRef.current !== expectedFollowUpId ||
      editingFollowUpThreadIdRef.current !== threadId
    )
      return;
    editingFollowUpIdRef.current = undefined;
    editingFollowUpThreadIdRef.current = undefined;
    setEditingFollowUpId(undefined);
    restoreComposerAfterFollowUpEdit();
  }

  useEffect(() => {
    if (!editingFollowUpId || followUpBusy) return;
    const edited = activeFollowUps.find((followUp) => followUp.id === editingFollowUpId);
    if (edited && edited.status !== "queued") {
      void cancelEditingFollowUp().catch((caught) => setError(errorMessage(caught)));
    }
  }, [activeFollowUps, editingFollowUpId, followUpBusy]);

  useEffect(() => {
    return () => {
      const threadId = editingFollowUpThreadIdRef.current ?? selectedThreadIdRef.current;
      if (editingFollowUpIdRef.current && threadId) {
        void buildV2CommandEnvelope(threadId, "editing-release", {})
          .then((request) => window.eco?.setThreadFollowUpEditing?.(request))
          .catch(() => undefined);
      }
    };
  }, []);

  async function sendComposerMessage(
    promptOverride?: string,
    options?: { followUpDeliveryMode?: FollowUpDeliveryMode },
  ) {
    const promptForSend = promptOverride ?? prompt;
    if (!currentProjectPath || !window.eco || (!promptForSend.trim() && composerAttachments.length === 0)) {
      return;
    }
    const canSendWithPrompt = composerFollowUpMode
      ? Boolean(activeThread && !followUpBusy && !isStarting && !planActionBusy && !contextCompactionInFlight)
      : Boolean(
          composerRoutesReady &&
            !isStarting &&
            !planActionBusy &&
            !clarificationBusy &&
            !bashApprovalBusy &&
            !pendingClarification &&
            !pendingBashApproval &&
            !contextCompactionInFlight &&
            threadAcceptsInput,
        );
    if (!canSendWithPrompt) return;
    if (isStarting || followUpBusy) {
      return;
    }
    if (contextCompactionInFlight) {
      setError(t("app.contextCompacting"));
      return;
    }
    setError(undefined);
    requestActivityFeedForceScroll();
    const attachments =
      composerAttachments.length > 0 ? toPromptImageAttachments(composerAttachments) : undefined;
    const messagePrompt =
      promptForSend.trim() || (attachments?.length ? t("app.imagePrompt") || ACP_IMAGE_ONLY_PROMPT : "");

    if (composerFollowUpMode && activeThread) {
      if (editingFollowUpId) {
        if (typeof window.eco.updateThreadFollowUp !== "function") {
          setError(t("app.preload.followUpUpdate"));
          return;
        }
        setFollowUpBusy(true);
        try {
          const result = await window.eco.updateThreadFollowUp(
            await buildV2CommandEnvelope(activeThread.id, "update", {
              followUpId: editingFollowUpId,
              prompt: messagePrompt,
              ...(attachments && { attachments }),
            }),
          );
          setFollowUpsByThread((current) => ({
            ...current,
            [activeThread.id]: mergeThreadFollowUps(current[activeThread.id] ?? [], result.followUps),
          }));
          await cancelEditingFollowUp();
        } catch (caught) {
          setError(errorMessage(caught));
        } finally {
          setFollowUpBusy(false);
        }
        return;
      }

      if (typeof window.eco.enqueueThreadFollowUp !== "function") {
        setError(t("app.preload.followUpEnqueue"));
        return;
      }
      setFollowUpBusy(true);
      // Clear composer immediately so mid-turn waits do not leave text in the input
      // while a (possibly transient) queue card is visible.
      const restorePrompt = messagePrompt;
      const restoreAttachments = [...composerAttachments];
      removeComposerDraft(composerContextKey, { releaseAttachments: false });
      setPrompt("");
      setComposerRewindTarget(undefined);
      setComposerAttachments([]);
      setComposerImageNotice(undefined);
      try {
        const defaultDelivery = workflowSettings.followUpDeliveryMode ?? "steer";
        const deliveryMode = resolveFollowUpDeliveryModeForCore(
          activeThread.coreKind,
          options?.followUpDeliveryMode ?? defaultDelivery,
        );
        const result = await window.eco.enqueueThreadFollowUp(
          await buildV2CommandEnvelope(activeThread.id, "enqueue", {
            prompt: messagePrompt,
            ...(attachments && { attachments }),
            followUpDeliveryMode: deliveryMode,
          }),
        );
        setFollowUpsByThread((current) => ({
          ...current,
          [activeThread.id]: mergeThreadFollowUps(current[activeThread.id] ?? [], result.followUps),
        }));
        requestActivityFeedForceScroll();
        // 用户已发送消息，接受当前的 prompt cache 配置漂移
        const acceptedRuntimeConfig = effectiveComposerRuntimeConfig ?? composerRuntimeConfig;
        if (acceptedRuntimeConfig) {
          promptCacheBaselineByThreadRef.current[activeThread.id] = acceptedRuntimeConfig;
          setPromptCacheBaselineVersion((v) => v + 1);
        }
        revokeComposerAttachmentPreviews(restoreAttachments);
      } catch (caught) {
        setPrompt(restorePrompt);
        setComposerAttachments(restoreAttachments);
        setError(errorMessage(caught));
      } finally {
        setFollowUpBusy(false);
      }
      return;
    }

    setIsStarting(true);
    const runtimeConfigForSend = resolveComposerRuntimeConfigForSend();
    if (!runtimeConfigForSend) {
      setError(t("app.configureOrchestration"));
      setIsStarting(false);
      return;
    }
    const continuable = Boolean(activeThread && isContinuableThreadStatus(activeThread.status));
    const rewindTarget =
      continuable && activeComposerRewindTarget
        ? {
            activityLineId: activeComposerRewindTarget.activityLineId,
            ...(activeComposerRewindTarget.userMessageId
              ? { userMessageId: activeComposerRewindTarget.userMessageId }
              : {}),
          }
        : undefined;
    const restorePrompt = messagePrompt;
    const restoreAttachments = [...composerAttachments];
    removeComposerDraft(composerContextKey, { releaseAttachments: false });
    setPrompt("");
    setComposerRewindTarget(undefined);
    setComposerAttachments([]);
    setComposerImageNotice(undefined);
    requestActivityFeedForceScroll();
    try {
      if (continuable && activeThread) {
        if (rewindTarget) {
          const result = await rewriteUserMessage({
            activityLineId: rewindTarget.activityLineId,
            prompt: messagePrompt,
            attachments: attachments ?? [],
            expectedHistoryRevision: displayProjection?.historyRevision ?? 0,
            runtimeConfig: runtimeConfigForSend,
          });
          setThreads((current) =>
            current.map((thread) => (thread.id === result.thread.id ? result.thread : thread)),
          );
        } else {
          await sendConversationV2Continuation({
            thread: activeThread,
            prompt: messagePrompt,
            runtimeConfig: runtimeConfigForSend,
            ...(attachments ? { attachments } : {}),
            commandScope: "composer",
          });
        }
        requestActivityFeedForceScroll();
        // 用户已发送消息，接受当前的 prompt cache 配置漂移
        promptCacheBaselineByThreadRef.current[activeThread.id] = runtimeConfigForSend;
        setPromptCacheBaselineVersion((v) => v + 1);
      } else {
        const result = await window.eco.startThread({
          workspacePath: currentProjectPath,
          prompt: messagePrompt,
          coreKind: newThreadCoreKind,
          runtimeConfig: runtimeConfigForSend,
          ...(attachments && { attachments }),
        });
        adoptLandingTaskPanelUiRef.current = true;
        setThreads((current) => [
          result.thread,
          ...current.filter((thread) => thread.id !== result.thread.id),
        ]);
        adoptLandingThreadSelection(result.thread.id);
        clearPendingPlanForThread(result.thread.id);
        if (result.thread.status === "blocked") {
          setError(result.thread.message?.trim() || t("app.configureOrchestration"));
        }
        // 用户已发送消息，接受当前的 prompt cache 配置漂移
        promptCacheBaselineByThreadRef.current[result.thread.id] =
          result.thread.runtimeConfig ?? runtimeConfigForSend;
        setPromptCacheBaselineVersion((v) => v + 1);
        requestActivityFeedForceScroll();
      }
      revokeComposerAttachmentPreviews(restoreAttachments);
    } catch (caught) {
      setPrompt(restorePrompt);
      setComposerAttachments(restoreAttachments);
      setError(errorMessage(caught));
      if (isWaitForRunError(caught) && activeThread) {
        void resyncThreadSummaryAfterWaitForRun(activeThread.id);
      }
    } finally {
      setIsStarting(false);
    }
  }

  async function refreshFollowUpsAfterMutationError(threadId: string, caught: unknown) {
    setError(errorMessage(caught));
    try {
      const api = window.eco;
      if (!api) throw new Error("Desktop API is unavailable.");
      const result = await api.listThreadFollowUps(threadId);
      setFollowUpsByThread((current) => ({
        ...current,
        [threadId]: mergeThreadFollowUps(current[threadId] ?? [], result.followUps),
      }));
    } catch (refreshError) {
      setError(`${errorMessage(caught)}；队列刷新失败：${errorMessage(refreshError)}`);
    }
  }

  async function reorderQueuedFollowUps(followUpIds: string[]) {
    if (!activeThread || typeof window.eco?.reorderThreadFollowUps !== "function") {
      return;
    }
    const threadId = activeThread.id;
    setError(undefined);
    try {
      const result = await window.eco.reorderThreadFollowUps(
        await buildV2CommandEnvelope(threadId, "reorder", { followUpIds }),
      );
      setFollowUpsByThread((current) => ({
        ...current,
        [threadId]: mergeThreadFollowUps(current[threadId] ?? [], result.followUps),
      }));
    } catch (caught) {
      // A row may have been delivered during the drag. Never roll back a whole
      // captured queue over live events; reload current rows and retain the error.
      await refreshFollowUpsAfterMutationError(threadId, caught);
    }
  }

  async function cancelQueuedFollowUp(followUp: ThreadPendingFollowUp) {
    if (!window.eco || typeof window.eco.cancelThreadFollowUp !== "function") {
      setError(t("app.preload.followUpCancel"));
      return;
    }
    setError(undefined);
    setFollowUpCancelBusyId(followUp.id);
    try {
      const result = await window.eco.cancelThreadFollowUp(
        await buildV2CommandEnvelope(followUp.threadId, "cancel", { followUpId: followUp.id }),
      );
      setFollowUpsByThread((current) => ({
        ...current,
        [followUp.threadId]: mergeThreadFollowUps(current[followUp.threadId] ?? [], result.followUps),
      }));
      if (editingFollowUpId === followUp.id) {
        await cancelEditingFollowUp();
      }
    } catch (caught) {
      await refreshFollowUpsAfterMutationError(followUp.threadId, caught);
    } finally {
      setFollowUpCancelBusyId(undefined);
    }
  }

  async function toggleFollowUpQueuePaused(paused: boolean) {
    if (!activeThread || typeof window.eco?.setThreadFollowUpQueuePaused !== "function") {
      setError(t("app.preload.followUpQueuePause"));
      return;
    }
    setError(undefined);
    setFollowUpQueuePauseBusy(true);
    const threadId = activeThread.id;
    const pauseRevision = followUpQueuePauseRevisionRef.current[threadId] ?? 0;
    try {
      const result = await window.eco.setThreadFollowUpQueuePaused(
        await buildV2CommandEnvelope(activeThread.id, "queue-paused", { paused }),
      );
      if ((followUpQueuePauseRevisionRef.current[threadId] ?? 0) !== pauseRevision) return;
      setThreads((current) =>
        current.map((thread) =>
          thread.id === result.thread.id
            ? {
                ...thread,
                // Resume can start a run before this receipt arrives. Only update
                // the queue flag; its captured thread status may already be stale.
                followUpQueuePaused: result.paused === true,
              }
            : thread,
        ),
      );
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setFollowUpQueuePauseBusy(false);
    }
  }

  async function escalateQueuedFollowUp(followUp: ThreadPendingFollowUp) {
    if (!window.eco || typeof window.eco.escalateThreadFollowUp !== "function") {
      setError(t("app.preload.followUpEscalate"));
      return;
    }
    setError(undefined);
    setFollowUpEscalateBusyId(followUp.id);
    try {
      const result = await window.eco.escalateThreadFollowUp(
        await buildV2CommandEnvelope(followUp.threadId, "escalate", { followUpId: followUp.id }),
      );
      setFollowUpsByThread((current) => ({
        ...current,
        [followUp.threadId]: mergeThreadFollowUps(current[followUp.threadId] ?? [], result.followUps),
      }));
      if (editingFollowUpId === followUp.id) {
        await cancelEditingFollowUp();
      }
    } catch (caught) {
      await refreshFollowUpsAfterMutationError(followUp.threadId, caught);
    } finally {
      setFollowUpEscalateBusyId(undefined);
    }
  }

  async function approvePendingPlan() {
    await approvePendingPlanWithTarget({ kind: "main" });
  }

  async function reviewPendingPlanCode() {
    if (!activeThread || !pendingPlan || !window.eco || planActionBusy || isStarting) return;
    const threadId = activeThread.id;
    const planToRemember = pendingPlan;
    const runtimeConfigForSend = resolveComposerRuntimeConfigForSend();
    if (!runtimeConfigForSend) {
      setError(t("app.configureOrchestration"));
      return;
    }
    setError(undefined);
    setPlanActionBusy(true);
    try {
      const expectedHistoryRevision = displayProjection?.historyRevision ?? 0;
      // Awaiting-plan messages only queue. Resolve the gate before sending the review request.
      const result = await window.eco.dismissPlan({
        principalId: "desktop-local",
        clientCommandId: `plan_resolve_${stableHash({
          threadId,
          resolution: "review-code",
          expectedHistoryRevision,
        })}`,
        threadId,
        expectedHistoryRevision,
      });
      rememberApprovedPlanForThread(threadId, planToRemember);
      clearPendingPlanForThread(threadId);
      const updatedThread = result.thread;
      if (!updatedThread) {
        throw new Error("计划待审批状态已结束，但未能获取当前会话，无法发送审查请求。");
      }
      setThreads((current) =>
        current.map((thread) => (thread.id === updatedThread.id ? updatedThread : thread)),
      );
      await sendConversationV2Continuation({
        thread: updatedThread,
        prompt: "计划已经实施，请审查代码。",
        runtimeConfig: { ...runtimeConfigForSend, sessionMode: "agent" },
        commandScope: "plan_review",
      });
      requestActivityFeedForceScroll();
    } catch (caught) {
      setError(errorMessage(caught));
      if (isWaitForRunError(caught)) {
        void resyncThreadSummaryAfterWaitForRun(threadId);
      }
    } finally {
      setPlanActionBusy(false);
    }
  }

  async function approvePendingPlanWithSubagent(agentKey: string, additionalMessage?: string) {
    await approvePendingPlanWithTarget({
      kind: "subagent",
      agentKey,
      ...(additionalMessage ? { additionalMessage } : {}),
    });
  }

  async function approvePendingPlanWithTarget(executionTarget: PlanExecutionTarget) {
    if (!activeThread || !window.eco) return;
    const threadId = activeThread.id;
    const planToRemember = pendingPlan;
    setError(undefined);
    setPlanActionBusy(true);
    try {
      const result = await window.eco.approvePlan({
        principalId: "desktop-local",
        clientCommandId: `plan_resolve_${stableHash({
          threadId,
          resolution: "approve",
          executionTarget,
          // A failed delegation leaves the same plan and history revision in place.
          // Retrying after that run must dispatch a new command, not replay its receipt.
          previousAttemptId: displayProjection?.attempts.at(-1)?.attemptId,
          expectedHistoryRevision: displayProjection?.historyRevision ?? 0,
        })}`,
        threadId,
        expectedHistoryRevision: displayProjection?.historyRevision ?? 0,
        executionTarget,
      });
      if (planToRemember) {
        rememberApprovedPlanForThread(threadId, planToRemember);
      }
      clearPendingPlanForThread(threadId);
      setPlanDelegationMessagesByThread((current) => {
        if (!(threadId in current)) {
          return current;
        }
        const next = { ...current };
        delete next[threadId];
        return next;
      });
      const updatedThread = result.thread;
      if (updatedThread) {
        setThreads((current) =>
          current.map((thread) => (thread.id === updatedThread.id ? updatedThread : thread)),
        );
      }
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setPlanActionBusy(false);
    }
  }

  async function submitClarificationAnswers(answers: { toolUseId: string; selections: string[][] }) {
    if (!window.eco || !activeThread) return;
    setClarificationBusy(true);
    setError(undefined);
    try {
      const expectedHistoryRevision = displayProjection?.historyRevision ?? 0;
      const result = await window.eco.submitClarification({
        principalId: "desktop-local",
        clientCommandId: `clarification_resolve_${stableHash({
          threadId: activeThread.id,
          toolUseId: answers.toolUseId,
          resolution: "submit",
          selections: answers.selections,
          expectedHistoryRevision,
        })}`,
        threadId: activeThread.id,
        ...answers,
        expectedHistoryRevision,
      });
      // An async Codex question is answered by a message into the run, not by the RPC
      // return. Only an unconfirmed delivery keeps the question open (with its answers)
      // so the answer can be sent again — everything else is done with it.
      if (result.delivery?.state === "unknown") {
        setError(
          `回答已记录，但未能确认送达 Codex：${result.delivery.message ?? "原因未知"}。可重新提交或忽略。`,
        );
        return;
      }
      if (result.delivery?.state === "queued") {
        showAppMessageSuccessRef.current(
          result.delivery.message ?? "回答已排队，将在当前步骤结束后作为普通消息发送。",
        );
      } else if (result.delivery) {
        showAppMessageSuccessRef.current("回答已送达 Codex。");
      }
      await refreshPendingClarificationForThread(activeThread.id);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setClarificationBusy(false);
    }
  }

  async function dismissPendingClarification() {
    if (!pendingClarification || !window.eco) return;
    setClarificationBusy(true);
    setError(undefined);
    try {
      const expectedHistoryRevision = displayProjection?.historyRevision ?? 0;
      await window.eco.dismissClarification({
        principalId: "desktop-local",
        clientCommandId: `clarification_resolve_${stableHash({
          threadId: pendingClarification.threadId,
          toolUseId: pendingClarification.toolUseId,
          resolution: "dismiss",
          expectedHistoryRevision,
        })}`,
        threadId: pendingClarification.threadId,
        toolUseId: pendingClarification.toolUseId,
        expectedHistoryRevision,
      });
      await refreshPendingClarificationForThread(pendingClarification.threadId);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setClarificationBusy(false);
    }
  }

  async function resolvePendingBashApproval(resolution: BashApprovalResolutionInput) {
    if (!pendingBashApproval || !window.eco) return;
    setBashApprovalBusy(true);
    setError(undefined);
    try {
      await window.eco.resolveBashApproval({
        principalId: "desktop-local",
        clientCommandId: `approval_resolve_${stableHash({
          threadId: pendingBashApproval.threadId,
          toolUseId: pendingBashApproval.toolUseId,
          decision: resolution.decision,
          feedback: resolution.feedback?.trim() || null,
          expectedHistoryRevision: displayProjection?.historyRevision ?? 0,
        })}`,
        threadId: pendingBashApproval.threadId,
        toolUseId: pendingBashApproval.toolUseId,
        decision: resolution.decision,
        ...(resolution.feedback ? { feedback: resolution.feedback } : {}),
        expectedHistoryRevision: displayProjection?.historyRevision ?? 0,
      });
      clearPendingBashApprovalForThread(pendingBashApproval.threadId);
      if (typeof window.eco.getPendingBashApproval === "function") {
        const next = await window.eco.getPendingBashApproval(pendingBashApproval.threadId);
        if (next) {
          upsertPendingBashApprovalForThread(pendingBashApproval.threadId, next);
        }
      }
    } catch (caught) {
      const message = errorMessage(caught);
      if (isStalePendingBashApprovalError(message)) {
        clearPendingBashApprovalForThread(pendingBashApproval.threadId);
        if (typeof window.eco.getPendingBashApproval === "function") {
          const next = await window.eco.getPendingBashApproval(pendingBashApproval.threadId);
          if (next) {
            upsertPendingBashApprovalForThread(pendingBashApproval.threadId, next);
          }
        }
      } else {
        setError(message);
      }
    } finally {
      setBashApprovalBusy(false);
    }
  }

  async function dismissPendingPlan() {
    if (!activeThread || !window.eco) return;
    setError(undefined);
    setPlanActionBusy(true);
    try {
      const expectedHistoryRevision = displayProjection?.historyRevision ?? 0;
      const result = await window.eco.dismissPlan({
        principalId: "desktop-local",
        clientCommandId: `plan_resolve_${stableHash({
          threadId: activeThread.id,
          resolution: "dismiss",
          expectedHistoryRevision,
        })}`,
        threadId: activeThread.id,
        expectedHistoryRevision,
      });
      const updatedThread = result.thread;
      if (updatedThread) {
        setThreads((current) =>
          current.map((thread) => (thread.id === updatedThread.id ? updatedThread : thread)),
        );
      }
      clearPendingPlanForThread(activeThread.id);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setPlanActionBusy(false);
    }
  }

  async function performCancel() {
    if (!activeThread || !window.eco) {
      return;
    }
    const threadId = activeThread.id;
    setError(undefined);
    setCancelBusy(true);
    setThreads((current) =>
      current.map((thread) => (thread.id === threadId ? { ...thread, cancelling: true } : thread)),
    );
    try {
      const command = await buildConversationV2CommandEnvelope({
        threadId,
        operation: "run_cancel",
        payload: {},
        getHead: (id) => window.eco!.conversationV2Head(id),
      });
      await window.eco.cancelThread(command);
    } catch (caught) {
      setThreads((current) =>
        current.map((thread) => {
          if (thread.id !== threadId) {
            return thread;
          }
          const { cancelling: _cleared, ...rest } = thread;
          return rest;
        }),
      );
      setError(errorMessage(caught));
    } finally {
      setCancelBusy(false);
    }
  }

  async function requestStopThread() {
    if (!activeThread || !window.eco || cancelBusy) {
      return;
    }
    await performCancel();
  }

  async function refreshSkillsList(workspacePath?: string) {
    if (!window.eco) return;
    setIsLoadingSkills(true);
    try {
      const snapshot = await window.eco.listSkills(workspacePath);
      setSkillsSnapshot(snapshot);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setIsLoadingSkills(false);
    }
  }

  async function refreshCursorAgentsList(workspacePath?: string) {
    if (!window.eco?.listCursorAgents) return;
    try {
      const snapshot = await window.eco.listCursorAgents(workspacePath);
      setCursorAgentsSnapshot(snapshot);
    } catch (caught) {
      console.warn("[eco] listCursorAgents failed", caught);
    }
  }

  async function linkProjectAgentsSkills() {
    if (!window.eco || !currentProjectPath) {
      return;
    }
    setSkillsLinking(true);
    setError(undefined);
    try {
      const result = await window.eco.linkAgentsSkills({ workspacePath: currentProjectPath });
      setSkillsLinkResult(result);
      await refreshSkillsList(currentProjectPath);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSkillsLinking(false);
    }
  }

  async function linkUserAgentsSkills() {
    const userAgents = skillsSnapshot?.agentsOnlySkills.filter((skill) => skill.source === "user") ?? [];
    const baseDir = userAgents[0]?.baseDir;
    if (!window.eco || !baseDir) {
      return;
    }
    setSkillsLinking(true);
    setError(undefined);
    try {
      const result = await window.eco.linkAgentsSkills({
        workspacePath: currentProjectPath ?? baseDir,
        baseDir,
      });
      setSkillsLinkResult(result);
      await refreshSkillsList(currentProjectPath);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSkillsLinking(false);
    }
  }

  async function uninstallSkill(skill: SkillInfo) {
    if (!window.eco) {
      throw new Error("Desktop bridge is unavailable.");
    }
    await window.eco.uninstallSkill({ directory: skill.directory });
    await refreshSkillsList(currentProjectPath);
  }

  async function searchSkillsCatalog(query: string) {
    if (!window.eco) throw new Error("Desktop bridge is unavailable.");
    return window.eco.searchSkillsCatalog({ query, limit: 20 });
  }

  async function loadSkillsCatalogLeaderboard() {
    if (!window.eco) throw new Error("Desktop bridge is unavailable.");
    return window.eco.listSkillsCatalogLeaderboard(12);
  }

  async function installCatalogSkill(entry: SkillCatalogEntry, layout: SkillLayout) {
    if (!window.eco) throw new Error("Desktop bridge is unavailable.");
    await window.eco.installCatalogSkill({ source: entry.source, skillId: entry.skillId, layout });
    await refreshSkillsList(currentProjectPath);
  }

  function openModelsSettings(tab: ModelsSettingsTab = "subagents") {
    setModelsSettingsTab(tab);
    setSettingsSection(tab === "compositionParts" ? "orchestrationComponents" : "agentLibrary");
    setSettingsOpen(true);
  }

  function openProviderSettings() {
    setSettingsSection("providers");
    setSettingsOpen(true);
  }

  const openCodexAccountSwitch = useCallback(() => setCodexAccountSwitchOpen(true), []);
  const closeCodexAccountSwitch = useCallback(() => setCodexAccountSwitchOpen(false), []);
  const openChatGptSubscriptionAccounts = useCallback((accountId?: string) => {
    setModelsSettingsChatGptAccountId(accountId?.trim() || undefined);
    setModelsSettingsTab("chatgptAccounts");
    setSettingsSection("agentLibrary");
    setSettingsOpen(true);
  }, []);

  function openSettings() {
    setSettingsSection("preferences");
    setSettingsOpen(true);
  }

  function openGitSettings() {
    setSettingsSection("git");
    setSettingsOpen(true);
  }

  async function saveGitSettingsSnapshot(snapshot: GitSettingsSnapshot) {
    if (!window.eco) {
      return;
    }
    const saved = await window.eco.saveGitSettings(snapshot);
    setGitSettings(saved);
  }

  async function savePersonalizationSettingsSnapshot(snapshot: PersonalizationSettingsSnapshot) {
    if (!window.eco) {
      return;
    }
    const saved = await window.eco.savePersonalizationSettings(snapshot);
    setPersonalizationSettings(saved);
  }

  async function saveBrowserSettingsSnapshot(snapshot: BrowserSettingsSnapshot) {
    if (!window.eco?.saveBrowserSettings) {
      return;
    }
    const saved = await window.eco.saveBrowserSettings(snapshot);
    setBrowserSettings(saved);
    setIntegrationAvailability(await window.eco.getIntegrationAvailability());
  }

  async function saveComputerUseSettingsSnapshot(snapshot: ComputerUseSettingsSnapshot) {
    if (!window.eco?.saveComputerUseSettings) {
      return;
    }
    const saved = await window.eco.saveComputerUseSettings(snapshot);
    setComputerUseSettings(saved);
    setIntegrationAvailability(await window.eco.getIntegrationAvailability());
  }

  async function runComputerUseDoctor() {
    if (!window.eco?.runComputerUseDoctor) {
      return { ok: false, onboardingLaunched: false, reason: "电脑操控 doctor 不可用。" };
    }
    return window.eco.runComputerUseDoctor();
  }

  async function checkComputerUsePermissionStatus() {
    if (!window.eco?.checkComputerUsePermissionStatus) {
      return { ok: false, missing: [] as string[] };
    }
    return window.eco.checkComputerUsePermissionStatus();
  }

  async function saveNotificationSettingsSnapshot(snapshot: NotificationSettingsSnapshot) {
    if (!window.eco?.saveNotificationSettings) {
      return;
    }
    const saved = await window.eco.saveNotificationSettings(snapshot);
    setNotificationSettings(saved);
  }

  async function saveContextWindowLimit(contextWindowLimitTokens: number) {
    if (!window.eco?.saveWorkflowSettings) {
      return;
    }
    try {
      const saved = await window.eco.saveWorkflowSettings({
        ...workflowSettings,
        contextWindowLimitTokens,
      });
      setWorkflowSettings(saved);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  async function saveMaxOutputLimit(maxOutputLimitTokens: WorkflowSettingsSnapshot["maxOutputLimitTokens"]) {
    if (!window.eco?.saveWorkflowSettings) {
      return;
    }
    try {
      const saved = await window.eco.saveWorkflowSettings({
        ...workflowSettings,
        maxOutputLimitTokens,
      });
      setWorkflowSettings(saved);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  async function saveFollowUpDeliveryMode(followUpDeliveryMode: FollowUpDeliveryMode) {
    if (!window.eco?.saveWorkflowSettings) {
      return;
    }
    try {
      const saved = await window.eco.saveWorkflowSettings({
        ...workflowSettings,
        followUpDeliveryMode,
      });
      setWorkflowSettings(saved);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  async function saveShowBilling(showBilling: boolean) {
    if (!window.eco?.saveWorkflowSettings) {
      return;
    }
    try {
      const saved = await window.eco.saveWorkflowSettings({
        ...workflowSettings,
        showBilling,
      });
      setWorkflowSettings(saved);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  async function saveDefaultBashReviewMode(defaultBashReviewMode: BashReviewMode) {
    if (!window.eco?.saveWorkflowSettings) {
      return;
    }
    try {
      const saved = await window.eco.saveWorkflowSettings({
        ...workflowSettings,
        defaultBashReviewMode,
      });
      setWorkflowSettings(saved);
      if (!activeThread) {
        setComposerRuntimeConfig(buildComposerDefaultConfig({ workflowDefaults: saved }) ?? null);
      }
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  async function runAsrProfilesMutation(mutation: () => Promise<AsrProfilesSnapshot>): Promise<void> {
    if (asrBusyRef.current) throw new Error(t("asr.busy"));
    asrBusyRef.current = true;
    setAsrBusy(true);
    try {
      setAsrProfiles(await mutation());
      setAsrSettingsLoadError(undefined);
    } finally {
      asrBusyRef.current = false;
      setAsrBusy(false);
    }
  }

  async function saveAsrProfile(input: AsrProfileSaveInput): Promise<AsrProfileSnapshot> {
    const eco = window.eco;
    if (!eco) throw new Error(t("asr.apiUnavailable"));
    if (asrBusyRef.current) throw new Error(t("asr.busy"));
    asrBusyRef.current = true;
    setAsrBusy(true);
    try {
      const saved = await eco.saveAsrProfile(input);
      setAsrProfiles(await eco.listAsrProfiles());
      setAsrSettingsLoadError(undefined);
      return saved;
    } finally {
      asrBusyRef.current = false;
      setAsrBusy(false);
    }
  }

  async function deleteAsrProfile(profileId: string) {
    const eco = window.eco;
    if (!eco) throw new Error(t("asr.apiUnavailable"));
    await runAsrProfilesMutation(() => eco.deleteAsrProfile({ id: profileId }));
  }

  async function activateAsrProfile(profileId: string) {
    const eco = window.eco;
    if (!eco) throw new Error(t("asr.apiUnavailable"));
    await runAsrProfilesMutation(async () => {
      await eco.activateAsrProfile({ id: profileId });
      return eco.listAsrProfiles();
    });
  }

  async function saveAsrInputDevice(inputDeviceId: string) {
    const eco = window.eco;
    if (!eco) throw new Error(t("asr.apiUnavailable"));
    await runAsrProfilesMutation(() => eco.saveAsrInputDevice({ inputDeviceId: inputDeviceId || null }));
  }

  async function saveCommitMessageModelPreference(candidateModelId: string) {
    const mainAgentConfigId = composerRuntimeConfig?.orchestrationSelection?.mainAgentConfigId;
    if (!window.eco?.listGitCommitModelOptions) {
      return;
    }
    const result = await window.eco.listGitCommitModelOptions(mainAgentConfigId ? { mainAgentConfigId } : {});
    const option = result.options.find((candidate) => candidate.candidateModelId === candidateModelId);
    if (!option) {
      throw new Error("所选 Git 提交模型已不在候选模型列表中。");
    }
    if (!mainAgentConfigId) {
      await selectComposerAuxiliaryModel({
        providerId: option.providerId,
        modelId: option.modelId,
        candidateModelId: option.candidateModelId,
      });
      return;
    }
    const saved = await window.eco.saveGitSettings({
      ...gitSettings,
      commitMessageCandidateModelIdByMainAgentConfigId: {
        ...gitSettings.commitMessageCandidateModelIdByMainAgentConfigId,
        [mainAgentConfigId]: option.candidateModelId,
      },
    });
    setGitSettings(saved);
  }

  async function handleGitCheckoutBranch(branch: string) {
    if (!currentProjectPath || !window.eco) {
      return;
    }
    setGitStatusBusy(true);
    try {
      const status = await window.eco.checkoutGitBranch({
        workspacePath: currentProjectPath,
        branch,
      });
      storeGitStatus(currentProjectPath, status);
      const workspace = await window.eco.inspectWorkspace(currentProjectPath);
      setProjectWorkspace(workspace);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setGitStatusBusy(false);
    }
  }

  async function handleGitCreateBranch(branch: string) {
    if (!currentProjectPath || !window.eco) {
      return;
    }
    setGitStatusBusy(true);
    try {
      const status = await window.eco.createGitBranch({
        workspacePath: currentProjectPath,
        branch,
      });
      storeGitStatus(currentProjectPath, status);
      const workspace = await window.eco.inspectWorkspace(currentProjectPath);
      setProjectWorkspace(workspace);
    } finally {
      setGitStatusBusy(false);
    }
  }

  async function handleGitCommitSuccess() {
    if (!currentProjectPath || !window.eco) {
      return;
    }
    await refreshGitStatus(undefined, { force: true });
    const workspace = await window.eco.inspectWorkspace(currentProjectPath);
    setProjectWorkspace(workspace);
  }

  const handleChangesDiffLoaded = useCallback(
    async (diff: WorkspaceDiffResult) => {
      cacheWorkspaceReviewSummary(diff);
      setReviewDiff(diff);
      if (reviewDiffManualRefreshRef.current) {
        reviewDiffManualRefreshRef.current = false;
        // Only a manual refresh forces a per-file diff refetch: an automatic reload
        // already invalidates the cache through its path/stat signature.
        setReviewDiffRevision((current) => current + 1);
      }
      setReviewDiffError(diff.watchError);
      setReviewSelectedPath((current) =>
        current && diff.files.some((file) => file.path === current) ? current : diff.files[0]?.path,
      );
      if (!currentProjectPath || !window.eco) {
        return;
      }
      const current = gitStatusByWorkspaceRef.current[currentProjectPath]?.status;
      if (current) {
        storeGitStatus(currentProjectPath, {
          ...current,
          insertions: diff.totalAdditions,
          deletions: diff.totalDeletions,
          dirtyFileCount: diff.fileCount,
          canCommit: diff.fileCount > 0,
        });
      }
      setProjectWorkspace((current) =>
        current?.path === currentProjectPath ? { ...current, dirtyFileCount: diff.fileCount } : current,
      );
    },
    [currentProjectPath, storeGitStatus],
  );

  const handleChangesDiffLoadingChange = useCallback((loading: boolean) => {
    setReviewDiffLoading(loading);
  }, []);

  const handleChangesDiffError = useCallback((message?: string) => {
    setReviewDiffError(message);
    if (!message) {
      return;
    }
    reviewDiffManualRefreshRef.current = false;
    if (reviewDiffRef.current) {
      // A failed refresh keeps the last good list on screen (shown as an inline error
      // banner); wiping it would throw away the file the reviewer is reading.
      return;
    }
    setReviewDiff(undefined);
    setReviewSelectedPath(undefined);
  }, []);

  const refreshReviewDiff = useCallback(async () => {
    const eco = window.eco;
    if (!currentProjectPath || !eco) {
      return;
    }
    const requestId = reviewDiffRequestRef.current + 1;
    reviewDiffRequestRef.current = requestId;
    await loadTaskPanelReviewDiff({
      workspacePath: currentProjectPath,
      getWorkspaceDiff: (workspacePath) =>
        eco.getWorkspaceDiff(workspacePath, { refresh: reviewDiffManualRefreshRef.current }),
      isCurrent: () => reviewDiffRequestRef.current === requestId,
      onLoadingChange: handleChangesDiffLoadingChange,
      onLoaded: handleChangesDiffLoaded,
      onError: handleChangesDiffError,
    });
  }, [currentProjectPath, handleChangesDiffError, handleChangesDiffLoaded, handleChangesDiffLoadingChange]);
  refreshReviewDiffRef.current = refreshReviewDiff;

  useEffect(() => {
    if (!window.eco?.onGitStatusChanged) return;
    return window.eco.onGitStatusChanged((event) => {
      const current = gitStatusByWorkspaceRef.current[event.workspacePath]?.status;
      if (!current) return;
      storeGitStatus(event.workspacePath, {
        ...current,
        dirtyFileCount: event.dirtyFileCount,
        insertions: event.insertions,
        deletions: event.deletions,
        canCommit: event.dirtyFileCount > 0,
      });
    });
  }, [storeGitStatus]);

  useEffect(() => {
    if (!currentProjectPath || !window.eco?.onGitDiffChanged) return;
    const unsubscribe = window.eco.onGitDiffChanged((event) => {
      if (event.workspacePath !== currentProjectPath) return;
      invalidateWorkspaceReviewSummary(currentProjectPath);
      if (event.error) {
        setReviewDiffError(event.error);
        return;
      }
      if (taskDrawerOpenRef.current && taskPanelActiveTabRef.current === TASK_PANEL_REVIEW_TAB_ID) {
        void refreshReviewDiffRef.current();
      }
    });
    const onFocus = () => {
      if (taskDrawerOpenRef.current && taskPanelActiveTabRef.current === TASK_PANEL_REVIEW_TAB_ID) {
        reviewDiffManualRefreshRef.current = true;
        void refreshReviewDiffRef.current();
      }
    };
    window.addEventListener("focus", onFocus);
    return () => {
      unsubscribe();
      window.removeEventListener("focus", onFocus);
    };
  }, [currentProjectPath]);

  const requestReviewDiffRefresh = useCallback(() => {
    reviewDiffManualRefreshRef.current = true;
    void refreshReviewDiff();
  }, [refreshReviewDiff]);

  const openTaskPanelHomeTool = useCallback(
    async (sourceTabId: string, tool: TaskPanelHomeTool) => {
      const eco = window.eco;
      if (!eco) return;
      const browserId = parseBrowserTaskTabId(sourceTabId);
      if (browserId && replacingBrowserHomeIdsRef.current.has(browserId)) return;
      if (browserId) replacingBrowserHomeIdsRef.current.add(browserId);
      try {
        setSelectedSubagentAgentId(undefined);
        if (tool === "terminal") {
          setOpenTaskPanelTabIds((current) => removeOpenTaskPanelTab(current, sourceTabId).tabs);
          taskPanelActiveTabRef.current = TASK_PANEL_HOME_TAB_ID;
          setTaskPanelActiveTab(TASK_PANEL_HOME_TAB_ID);
          toggleTerminalForCurrentProject();
          dismissTaskPanel();
        } else {
          const tabId = {
            review: TASK_PANEL_REVIEW_TAB_ID,
            files: TASK_PANEL_FILES_TAB_ID,
            sshBookmarks: TASK_PANEL_SSH_BOOKMARKS_TAB_ID,
          }[tool];
          setOpenTaskPanelTabIds((current) => replaceOpenTaskPanelTab(current, sourceTabId, tabId));
          taskPanelActiveTabRef.current = tabId;
          setTaskPanelActiveTab(tabId);
          if (tool === "review") void refreshReviewDiff();
        }
        // UI replacement happens in the click batch, before IPC can emit a browser removal.
        if (browserId) {
          const next = await eco.browserCloseInstance({ browserId });
          browserStateStore.setState(next);
        }
      } catch (error) {
        showAppMessageError(error instanceof Error ? error.message : String(error));
      } finally {
        if (browserId) replacingBrowserHomeIdsRef.current.delete(browserId);
      }
    },
    [dismissTaskPanel, refreshReviewDiff, showAppMessageError, toggleTerminalForCurrentProject],
  );

  const openReviewTaskDrawer = useCallback(async () => {
    setOpenTaskPanelTabIds((current) => addOpenTaskPanelTab(current, TASK_PANEL_REVIEW_TAB_ID));
    setTaskPanelActiveTab(TASK_PANEL_REVIEW_TAB_ID);
    setSelectedSubagentAgentId(undefined);
    setTaskPanelFullscreen(false);
    revealTaskPanel();
    await refreshReviewDiff();
  }, [refreshReviewDiff, revealTaskPanel]);

  async function handleGitPullSuccess() {
    await handleGitCommitSuccess();
  }

  async function handleGitPullConflictsWithAgent(conflictFiles: string[]) {
    if (!currentProjectPath || !window.eco || conflictFiles.length === 0) {
      return;
    }
    const runtimeConfigForSend = resolveComposerRuntimeConfigForSend();
    if (!runtimeConfigForSend) {
      setError(t("app.configureOrchestration"));
      return;
    }
    const fileList = conflictFiles.map((file) => `- ${file}`).join("\n");
    const prompt = `Git pull 产生了合并冲突，请解决以下文件的冲突并完成合并：\n${fileList}\n\n请查看冲突标记（<<<<<<< / ======= / >>>>>>>），保留正确代码，然后 git add 相关文件并完成合并提交。`;
    setError(undefined);

    if (activeThread) {
      if (
        activeThread.status === "running" ||
        activeThread.status === "queued" ||
        activeThread.followUpQueuePaused
      ) {
        if (typeof window.eco.enqueueThreadFollowUp !== "function") {
          setError(t("app.preload.followUpEnqueue"));
          return;
        }
        setFollowUpBusy(true);
        try {
          const result = await window.eco.enqueueThreadFollowUp(
            await buildV2CommandEnvelope(activeThread.id, "enqueue", { prompt }),
          );
          setFollowUpsByThread((current) => ({
            ...current,
            [activeThread.id]: mergeThreadFollowUps(current[activeThread.id] ?? [], result.followUps),
          }));
        } catch (caught) {
          setError(errorMessage(caught));
        } finally {
          setFollowUpBusy(false);
        }
        return;
      }
      if (isContinuableThreadStatus(activeThread.status)) {
        setIsStarting(true);
        try {
          await sendConversationV2Continuation({
            thread: activeThread,
            prompt,
            runtimeConfig: runtimeConfigForSend,
            commandScope: "git_conflict",
          });
        } catch (caught) {
          setError(errorMessage(caught));
          if (isWaitForRunError(caught)) {
            void resyncThreadSummaryAfterWaitForRun(activeThread.id);
          }
        } finally {
          setIsStarting(false);
        }
        return;
      }
    }

    setIsStarting(true);
    try {
      const result = await window.eco.startThread({
        workspacePath: currentProjectPath,
        prompt,
        coreKind: newThreadCoreKind,
        runtimeConfig: runtimeConfigForSend,
      });
      adoptLandingTaskPanelUiRef.current = true;
      setThreads((current) => [result.thread, ...current.filter((thread) => thread.id !== result.thread.id)]);
      adoptLandingThreadSelection(result.thread.id);
      clearPendingPlanForThread(result.thread.id);
      await refreshThreadState(result.thread.id);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setIsStarting(false);
    }
  }

  async function persistComposerRuntimeConfig(
    next: ThreadRuntimeConfig,
    options?: { persistWhileRunning?: boolean },
  ): Promise<boolean> {
    if (!activeThread) {
      setComposerRuntimeConfig(next);
      return true;
    }
    if (!window.eco) {
      setError("当前会话配置保存不可用。");
      return false;
    }
    const isRunning = activeThread.status === "running" || activeThread.status === "queued";
    const canPersist = canEditComposerConfig || (options?.persistWhileRunning === true && isRunning);
    if (!canPersist) {
      return false;
    }
    setIsSavingSettings(true);
    setError(undefined);
    try {
      const result = await window.eco.updateThreadRuntimeConfig(
        await buildV2CommandEnvelope(activeThread.id, "runtime-config", {
          runtimeConfig: next,
        }),
      );
      setThreads((current) =>
        current.map((thread) => (thread.id === result.thread.id ? result.thread : thread)),
      );
      return true;
    } catch (caught) {
      setError(errorMessage(caught));
      return false;
    } finally {
      setIsSavingSettings(false);
    }
  }

  function emptyOrchestrationSelection(): OrchestrationSelection {
    return {
      mainAgentConfigId: "",
      mainPrompt: { mode: "builtin" },
      subagents: { mode: "none" },
    };
  }

  async function applyComposerOrchestrationSelection(patch: {
    mainAgentConfigId?: string;
    mainPrompt?: MainAgentPromptSelection;
    subagents?: SubagentSelection;
  }) {
    if (!canEditComposerConfig) {
      return;
    }
    const current: OrchestrationSelection =
      composerRuntimeConfig?.orchestrationSelection ??
      projectOrchestrationSelection ??
      workflowSettings.defaultOrchestrationSelection ??
      emptyOrchestrationSelection();
    const nextSelection: OrchestrationSelection = {
      mainAgentConfigId: patch.mainAgentConfigId ?? current.mainAgentConfigId,
      mainPrompt: patch.mainPrompt ?? current.mainPrompt,
      subagents: patch.subagents ?? current.subagents,
    };
    if (!hasCompleteOrchestrationSelection(nextSelection)) {
      const partialBase = composerRuntimeConfig ?? {
        subagentEnabled: defaultSubagentAvailability(),
        sessionMode: workflowSettings.sessionMode ?? "agent",
        bashReviewMode: normalizeBashReviewMode(workflowSettings.defaultBashReviewMode),
      };
      const { resolvedOrchestrationSnapshot: _removed, ...base } = partialBase;
      await persistComposerRuntimeConfig({
        ...base,
        orchestrationSelection: nextSelection,
      });
      return;
    }
    let materialized: Pick<ThreadRuntimeConfig, "orchestrationSelection" | "resolvedOrchestrationSnapshot">;
    try {
      materialized = materializeThreadOrchestrationSnapshot(settings, nextSelection);
    } catch (caught) {
      setError(errorMessage(caught));
      return;
    }
    const snapshot = materialized.resolvedOrchestrationSnapshot!;
    const availableMcpServerKeys = listEnabledGlobalMcpServerKeys(mcpSettings.servers);
    const projectMcpServersEnabled =
      projectMcpSettings?.workspacePath === currentProjectPath
        ? projectMcpSettings?.enabledByServer
        : undefined;
    const bootstrapped =
      composerRuntimeConfig ??
      buildThreadRuntimeConfigFromDefaults({
        settings,
        workflowDefaults: workflowSettings,
        orchestrationSelection: nextSelection,
        mcpServers: mcpSettings.servers,
      });
    const next: ThreadRuntimeConfig = {
      ...bootstrapped,
      ...materialized,
      subagentEnabled: deriveSubagentEnabledFromSnapshot(
        snapshot,
        composerRuntimeConfig?.subagentEnabled ?? bootstrapped.subagentEnabled,
      ),
      ...(availableMcpServerKeys.length > 0
        ? {
            mcpServersEnabled: deriveMcpServersEnabled(availableMcpServerKeys, {
              ...(composerRuntimeConfig?.mcpServersEnabled
                ? { existing: composerRuntimeConfig.mcpServersEnabled }
                : bootstrapped.mcpServersEnabled
                  ? { existing: bootstrapped.mcpServersEnabled }
                  : {}),
              ...(projectMcpServersEnabled && Object.keys(projectMcpServersEnabled).length > 0
                ? { remembered: projectMcpServersEnabled }
                : workflowSettings.mcpServersEnabled
                  ? { remembered: workflowSettings.mcpServersEnabled }
                  : {}),
            }),
          }
        : {}),
    };
    await persistComposerRuntimeConfig(next);
    if (!activeThread && hasCompleteOrchestrationSelection(nextSelection)) {
      await saveProjectOrchestrationSelection(nextSelection);
    }
  }

  async function selectComposerMainAgentConfig(id: string) {
    if (!id.trim()) {
      return;
    }
    await applyComposerOrchestrationSelection({ mainAgentConfigId: id });
  }

  async function selectComposerMainPrompt(selection: MainAgentPromptSelection) {
    await applyComposerOrchestrationSelection({ mainPrompt: selection });
  }

  async function selectComposerSubagents(selection: SubagentSelection) {
    await applyComposerOrchestrationSelection({ subagents: selection });
  }

  async function selectComposerAuxiliaryModel(selection: AuxiliaryModelSelection) {
    if (!canEditStatelessModelConfig || !window.eco?.saveWorkflowSettings) {
      return;
    }
    const base =
      composerRuntimeConfig ??
      (composerCoreKind === "acp"
        ? buildAcpThreadRuntimeConfig({
            sessionMode: workflowSettings.sessionMode,
            ...(workflowSettings.acpCursorModelId
              ? { cursorModelId: workflowSettings.acpCursorModelId }
              : {}),
            ...(workflowSettings.defaultVisionModel
              ? { visionModel: workflowSettings.defaultVisionModel }
              : {}),
          })
        : null);
    if (!base) {
      return;
    }
    await persistComposerRuntimeConfig({ ...base, auxiliaryModel: selection }, { persistWhileRunning: true });
    try {
      const saved = await window.eco.saveWorkflowSettings({
        ...workflowSettings,
        defaultAuxiliaryModel: selection,
      });
      setWorkflowSettings(saved);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  async function selectComposerApprovalModel(selection: ApprovalModelSelection) {
    if (!canEditStatelessModelConfig || !window.eco?.saveWorkflowSettings) {
      return;
    }
    const base =
      composerRuntimeConfig ??
      (composerCoreKind === "acp"
        ? buildAcpThreadRuntimeConfig({
            sessionMode: workflowSettings.sessionMode,
            ...(workflowSettings.acpCursorModelId
              ? { cursorModelId: workflowSettings.acpCursorModelId }
              : {}),
            ...(workflowSettings.defaultVisionModel
              ? { visionModel: workflowSettings.defaultVisionModel }
              : {}),
          })
        : null);
    if (!base) {
      return;
    }
    await persistComposerRuntimeConfig({ ...base, approvalModel: selection }, { persistWhileRunning: true });
    try {
      const saved = await window.eco.saveWorkflowSettings({
        ...workflowSettings,
        defaultApprovalModel: selection,
      });
      setWorkflowSettings(saved);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  async function selectComposerVisionModel(selection: VisionModelSelection) {
    if (!canEditStatelessModelConfig || !window.eco?.saveWorkflowSettings) {
      return;
    }
    const base =
      composerRuntimeConfig ??
      (composerCoreKind === "acp"
        ? buildAcpThreadRuntimeConfig({
            sessionMode: workflowSettings.sessionMode,
            ...(workflowSettings.acpCursorModelId
              ? { cursorModelId: workflowSettings.acpCursorModelId }
              : {}),
            ...(workflowSettings.defaultAuxiliaryModel
              ? { auxiliaryModel: workflowSettings.defaultAuxiliaryModel }
              : {}),
            ...(workflowSettings.defaultApprovalModel
              ? { approvalModel: workflowSettings.defaultApprovalModel }
              : {}),
          })
        : null);
    if (!base) {
      return;
    }
    await persistComposerRuntimeConfig({ ...base, visionModel: selection }, { persistWhileRunning: true });
    try {
      const saved = await window.eco.saveWorkflowSettings({
        ...workflowSettings,
        defaultVisionModel: selection,
      });
      setWorkflowSettings(saved);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  async function selectComposerAcpModel(modelId: string | undefined) {
    if (!canEditComposerConfig) {
      return;
    }
    const base =
      composerRuntimeConfig ??
      buildAcpThreadRuntimeConfig({
        sessionMode: workflowSettings.sessionMode,
        ...(workflowSettings.acpCursorModelId ? { cursorModelId: workflowSettings.acpCursorModelId } : {}),
        ...(workflowSettings.defaultAuxiliaryModel
          ? { auxiliaryModel: workflowSettings.defaultAuxiliaryModel }
          : {}),
        ...(workflowSettings.defaultApprovalModel
          ? { approvalModel: workflowSettings.defaultApprovalModel }
          : {}),
        ...(workflowSettings.defaultVisionModel ? { visionModel: workflowSettings.defaultVisionModel } : {}),
        ...(modelId ? { cursorModelId: modelId } : {}),
      });
    const { cursorModelId: _current, ...rest } = base;
    await persistComposerRuntimeConfig({
      ...rest,
      ...(modelId ? { cursorModelId: modelId } : {}),
    });
  }

  async function selectComposerMainAgentModel(override: MainAgentModelOverride | undefined) {
    if (!composerRuntimeConfig || !canEditComposerConfig) {
      return;
    }
    if (override && !resolveMainAgentModelOverrideForProvider(templateMainModel?.providerId, override)) {
      setError(t("app.modelBackendMismatch"));
      return;
    }
    const { mainAgentModelOverride: _currentOverride, ...baseRuntimeConfig } = composerRuntimeConfig;
    const next: ThreadRuntimeConfig = {
      ...baseRuntimeConfig,
      ...(override ? { mainAgentModelOverride: override } : {}),
    };
    await persistComposerRuntimeConfig(next);
  }

  async function toggleComposerSubagent(role: SubagentRole, enabled: boolean) {
    if (!composerRuntimeConfig) {
      return;
    }
    const next: ThreadRuntimeConfig = {
      ...composerRuntimeConfig,
      subagentEnabled: { ...composerRuntimeConfig.subagentEnabled, [role]: enabled },
    };
    await persistComposerRuntimeConfig(next);
  }

  async function toggleComposerMcpServer(serverKey: string, enabled: boolean) {
    if (!composerRuntimeConfig || !currentProjectPath) {
      return;
    }
    const nextMcpServersEnabled = { ...composerMcpSettings, [serverKey]: enabled };
    const next: ThreadRuntimeConfig = {
      ...composerRuntimeConfig,
      mcpServersEnabled: nextMcpServersEnabled,
    };
    if (!(await persistComposerRuntimeConfig(next, { persistWhileRunning: true }))) return;
    if (!window.eco) {
      return;
    }
    try {
      const saved = await window.eco.saveProjectMcpSettings({
        workspacePath: currentProjectPath,
        enabledByServer: nextMcpServersEnabled,
      });
      setProjectMcpSettings(saved);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  async function toggleComposerIntegration(integrationId: IntegrationId, enabled: boolean) {
    if (!composerRuntimeConfig || !currentProjectPath || !window.eco) return;
    const nextEnabled = { ...composerIntegrationSettings, [integrationId]: enabled };
    const persisted = await persistComposerRuntimeConfig(
      { ...composerRuntimeConfig, integrationsEnabled: nextEnabled },
      { persistWhileRunning: true },
    );
    if (!persisted) return;
    try {
      const saved = await window.eco.saveProjectIntegrationsSettings({
        workspacePath: currentProjectPath,
        enabled: nextEnabled,
      });
      setProjectIntegrationsSettings(saved);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  async function toggleComposerSkill(settingsKey: string, enabled: boolean) {
    if (!composerRuntimeConfig || !currentProjectPath) return;
    const nextSkillsEnabled = { ...composerSkillsEnabled, [settingsKey]: enabled };
    const persisted = await persistComposerRuntimeConfig(
      { ...composerRuntimeConfig, skillsEnabled: nextSkillsEnabled },
      { persistWhileRunning: true },
    );
    if (!persisted) return;
    if (!window.eco) return;
    try {
      const saved = await window.eco.saveProjectSkillsSettings({
        workspacePath: currentProjectPath,
        enabledByPath: nextSkillsEnabled,
      });
      setProjectSkillsSettings(saved);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  async function selectComposerSessionMode(sessionMode: SessionMode) {
    if (!composerRuntimeConfig || !canEditComposerConfig) {
      return;
    }
    const next: ThreadRuntimeConfig = withSessionMode(composerRuntimeConfig, sessionMode);
    if (!(await persistComposerRuntimeConfig(next))) return;
    if (!window.eco?.saveWorkflowSettings) {
      return;
    }
    try {
      const saved = await window.eco.saveWorkflowSettings({
        ...workflowSettings,
        sessionMode: next.sessionMode,
      });
      setWorkflowSettings(saved);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  async function toggleComposerBashReviewMode(bashReviewMode: ThreadRuntimeConfig["bashReviewMode"]) {
    if (!composerRuntimeConfig || !canEditBashReviewMode) {
      return;
    }
    const next: ThreadRuntimeConfig = { ...composerRuntimeConfig, bashReviewMode };
    await persistComposerRuntimeConfig(next, { persistWhileRunning: true });
  }

  async function saveProxyBridgeSettings(next: ProxyBridgeSettingsSnapshot) {
    if (!window.eco) return;
    setIsSavingProxyBridgeSettings(true);
    setError(undefined);
    try {
      const saved = await window.eco.saveProxyBridgeSettings(next);
      setProxyBridgeSettings(saved);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setIsSavingProxyBridgeSettings(false);
    }
  }

  async function saveIntegratedWebSearchSettings(next: IntegratedWebSearchSettingsSaveInput) {
    if (!window.eco) return;
    setIsSavingIntegratedWebSearchSettings(true);
    setError(undefined);
    try {
      const saved = await window.eco.saveIntegratedWebSearchSettings(next);
      setIntegratedWebSearchSettings(saved);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setIsSavingIntegratedWebSearchSettings(false);
    }
  }

  async function saveDefaultOrchestrationSelection(selection: OrchestrationSelection | undefined) {
    if (!window.eco?.saveWorkflowSettings) {
      return;
    }
    setIsSavingSettings(true);
    setError(undefined);
    try {
      const nextWorkflowSettings: WorkflowSettingsSnapshot = {
        ...workflowSettings,
      };
      if (selection && hasCompleteOrchestrationSelection(selection)) {
        nextWorkflowSettings.defaultOrchestrationSelection = selection;
      } else {
        delete nextWorkflowSettings.defaultOrchestrationSelection;
      }
      const saved = await window.eco.saveWorkflowSettings(nextWorkflowSettings);
      setWorkflowSettings(saved);
      if (!activeThread && !projectOrchestrationSelection) {
        setComposerRuntimeConfig(
          selection
            ? (buildComposerDefaultConfig({
                workflowDefaults: saved,
                orchestrationSelection: selection,
              }) ?? null)
            : null,
        );
      }
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setIsSavingSettings(false);
    }
  }

  async function saveDefaultAuxiliaryModel(selection: AuxiliaryModelSelection | undefined) {
    if (!window.eco?.saveWorkflowSettings) {
      return;
    }
    setIsSavingSettings(true);
    setError(undefined);
    try {
      const nextWorkflowSettings: WorkflowSettingsSnapshot = {
        ...workflowSettings,
      };
      if (selection) {
        nextWorkflowSettings.defaultAuxiliaryModel = selection;
      } else {
        delete nextWorkflowSettings.defaultAuxiliaryModel;
      }
      const saved = await window.eco.saveWorkflowSettings(nextWorkflowSettings);
      setWorkflowSettings(saved);
      if (!activeThread && composerRuntimeConfig) {
        const { auxiliaryModel: _previous, ...baseRuntimeConfig } = composerRuntimeConfig;
        setComposerRuntimeConfig({
          ...baseRuntimeConfig,
          ...(selection ? { auxiliaryModel: selection } : {}),
        });
      } else if (!activeThread && !composerRuntimeConfig && selection) {
        const next = buildComposerDefaultConfig({
          workflowDefaults: saved,
        });
        if (next) {
          setComposerRuntimeConfig(next);
        }
      }
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setIsSavingSettings(false);
    }
  }

  async function saveDefaultApprovalModel(selection: ApprovalModelSelection | undefined) {
    if (!window.eco?.saveWorkflowSettings) {
      return;
    }
    setIsSavingSettings(true);
    setError(undefined);
    try {
      const nextWorkflowSettings: WorkflowSettingsSnapshot = {
        ...workflowSettings,
      };
      if (selection) {
        nextWorkflowSettings.defaultApprovalModel = selection;
      } else {
        delete nextWorkflowSettings.defaultApprovalModel;
      }
      const saved = await window.eco.saveWorkflowSettings(nextWorkflowSettings);
      setWorkflowSettings(saved);
      if (!activeThread && composerRuntimeConfig) {
        const { approvalModel: _previous, ...baseRuntimeConfig } = composerRuntimeConfig;
        setComposerRuntimeConfig({
          ...baseRuntimeConfig,
          ...(selection ? { approvalModel: selection } : {}),
        });
      } else if (!activeThread && !composerRuntimeConfig && selection) {
        const next = buildComposerDefaultConfig({
          workflowDefaults: saved,
        });
        if (next) {
          setComposerRuntimeConfig(next);
        }
      }
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setIsSavingSettings(false);
    }
  }

  async function saveDefaultVisionModel(selection: VisionModelSelection | undefined) {
    if (!window.eco?.saveWorkflowSettings) {
      return;
    }
    setIsSavingSettings(true);
    setError(undefined);
    try {
      const nextWorkflowSettings: WorkflowSettingsSnapshot = {
        ...workflowSettings,
      };
      if (selection) {
        nextWorkflowSettings.defaultVisionModel = selection;
      } else {
        delete nextWorkflowSettings.defaultVisionModel;
      }
      const saved = await window.eco.saveWorkflowSettings(nextWorkflowSettings);
      setWorkflowSettings(saved);
      if (!activeThread && composerRuntimeConfig) {
        const { visionModel: _previous, ...baseRuntimeConfig } = composerRuntimeConfig;
        setComposerRuntimeConfig({
          ...baseRuntimeConfig,
          ...(selection ? { visionModel: selection } : {}),
        });
      } else if (!activeThread && !composerRuntimeConfig && selection) {
        const next = buildComposerDefaultConfig({
          workflowDefaults: saved,
        });
        if (next) {
          setComposerRuntimeConfig(next);
        }
      }
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setIsSavingSettings(false);
    }
  }

  async function saveProjectOrchestrationSelection(selection: OrchestrationSelection): Promise<void> {
    if (
      !window.eco?.saveProjectOrchestrationSettings ||
      !currentProjectPath ||
      !hasCompleteOrchestrationSelection(selection)
    ) {
      return;
    }
    setIsSavingSettings(true);
    setError(undefined);
    try {
      const saved = await window.eco.saveProjectOrchestrationSettings({
        workspacePath: currentProjectPath,
        orchestrationSelection: selection,
      });
      setProjectOrchestrationSettings(saved);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setIsSavingSettings(false);
    }
  }

  async function saveDefaultCoreKind(coreKind: CoreKind) {
    if (!window.eco?.saveWorkflowSettings) {
      return;
    }
    setIsSavingSettings(true);
    setError(undefined);
    try {
      const saved = await window.eco.saveWorkflowSettings({
        ...workflowSettings,
        defaultCoreKind: coreKind,
      });
      setWorkflowSettings(saved);
      if (!activeThread) {
        setNewThreadCoreKind(saved.defaultCoreKind ?? "claude");
      }
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setIsSavingSettings(false);
    }
  }

  async function saveAcpCursorModelId(acpCursorModelId: string | undefined) {
    if (!window.eco?.saveWorkflowSettings) return;
    setIsSavingSettings(true);
    setError(undefined);
    try {
      const saved = await window.eco.saveWorkflowSettings({
        ...workflowSettings,
        acpCursorModelId: acpCursorModelId ?? "",
      });
      setWorkflowSettings(saved);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setIsSavingSettings(false);
    }
  }

  async function saveAcpCursorApiKey(acpCursorApiKey: string | undefined) {
    if (!window.eco?.saveWorkflowSettings) return;
    setIsSavingSettings(true);
    setError(undefined);
    try {
      const saved = await window.eco.saveWorkflowSettings({
        ...workflowSettings,
        acpCursorApiKey: acpCursorApiKey ?? "",
      });
      setWorkflowSettings(saved);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setIsSavingSettings(false);
    }
  }

  async function saveMcpServer(input: McpServerConfigInput) {
    if (!window.eco) return;
    setIsSavingSettings(true);
    try {
      await window.eco.saveMcpServer(input);
      const snapshot = await window.eco.getMcpSettings();
      setMcpSettings(snapshot);
    } finally {
      setIsSavingSettings(false);
    }
  }

  async function deleteMcpServer(serverId: string) {
    if (!window.eco) return;
    setIsSavingSettings(true);
    try {
      await window.eco.deleteMcpServer(serverId);
      const snapshot = await window.eco.getMcpSettings();
      setMcpSettings(snapshot);
    } finally {
      setIsSavingSettings(false);
    }
  }

  async function checkMcpServer(input: McpServerConfigInput): Promise<McpServerCheckResult> {
    if (!window.eco) {
      throw new Error("Eco desktop API is not available.");
    }
    return window.eco.checkMcpServer(input);
  }

  async function saveCenterServerSettings(input: CenterServerSettingsInput) {
    if (!window.eco) {
      return emptyCenterServerSettings;
    }
    setIsSavingSettings(true);
    try {
      const snapshot = await window.eco.saveCenterServerSettings(input);
      setCenterServerSettings(snapshot);
      return snapshot;
    } finally {
      setIsSavingSettings(false);
    }
  }

  async function applyCenterServerAuthResult(result: {
    settings?: CenterServerSettingsSnapshot["settings"];
    status?: CenterServerSettingsSnapshot["status"];
    emailConfirmationRequired?: boolean;
  }) {
    if (result.emailConfirmationRequired || !result.settings || !result.status) {
      return {
        settings: centerServerSettings.settings,
        status: centerServerSettings.status,
      };
    }
    setCenterServerSettings({
      settings: result.settings,
      status: result.status,
    });
    return {
      settings: result.settings,
      status: result.status,
    };
  }

  async function signUpCenterServer(request: CenterServerSignUpRequest) {
    if (!window.eco) {
      return { emailConfirmationRequired: true };
    }
    setIsSavingSettings(true);
    try {
      const result = await window.eco.signUpCenterServer(request);
      await applyCenterServerAuthResult(result);
      return result;
    } finally {
      setIsSavingSettings(false);
    }
  }

  async function signInCenterServer(request: CenterServerSignInRequest) {
    if (!window.eco) {
      return { emailConfirmationRequired: true };
    }
    setIsSavingSettings(true);
    try {
      const result = await window.eco.signInCenterServer(request);
      await applyCenterServerAuthResult(result);
      return result;
    } finally {
      setIsSavingSettings(false);
    }
  }

  async function testCenterServerConnection(input: { supabaseUrl: string; anonKey: string }) {
    if (!window.eco) {
      return { ok: false, error: "Electron preload API is unavailable." };
    }
    return window.eco.testCenterServerConnection(input);
  }

  async function createCenterServerPairing() {
    if (!window.eco) {
      throw new Error("Electron preload API is unavailable.");
    }
    return window.eco.createCenterServerPairing();
  }

  async function listCenterServerBindings() {
    if (!window.eco) {
      return [];
    }
    return window.eco.listCenterServerBindings();
  }

  async function listCenterServerPresence() {
    if (!window.eco) {
      return [];
    }
    return window.eco.listCenterServerPresence();
  }

  async function revokeCenterServerBinding(bindingId: string) {
    if (!window.eco) {
      throw new Error("Electron preload API is unavailable.");
    }
    return window.eco.revokeCenterServerBinding(bindingId);
  }

  async function connectCenterServer() {
    if (!window.eco) {
      return emptyCenterServerSettings;
    }
    const snapshot = await window.eco.connectCenterServer();
    setCenterServerSettings(snapshot);
    return snapshot;
  }

  async function disconnectCenterServer() {
    if (!window.eco) {
      return emptyCenterServerSettings;
    }
    const snapshot = await window.eco.disconnectCenterServer();
    setCenterServerSettings(snapshot);
    return snapshot;
  }

  async function removeCenterServerConnection(options?: { forceLocal?: boolean }) {
    if (!window.eco) {
      return emptyCenterServerSettings;
    }
    const snapshot = await window.eco.removeCenterServerConnection(options);
    setCenterServerSettings(snapshot);
    return snapshot;
  }

  async function getCenterServerVaultStatus() {
    if (!window.eco) {
      return { hasVaultKey: false, state: "idle" as const };
    }
    return window.eco.getCenterServerVaultStatus();
  }

  async function getCenterServerSyncStatus() {
    if (!window.eco) {
      return { domains: [] };
    }
    return window.eco.getCenterServerSyncStatus();
  }

  async function syncCenterServerConfigDomain(domain: CenterServerSyncDomain, mode: "pull" | "push") {
    if (!window.eco) {
      throw new Error("Electron preload API is unavailable.");
    }
    const eco = window.eco;
    const result = await eco.syncCenterServerConfigDomain(domain, mode);
    await Promise.all([
      eco.getModelSettings().then(setSettings),
      eco.getMcpSettings().then(setMcpSettings),
      eco.getWorkflowSettings().then(setWorkflowSettings),
      eco.getProxyBridgeSettings().then(setProxyBridgeSettings),
      eco.getIntegratedWebSearchSettings?.().then(setIntegratedWebSearchSettings) ?? Promise.resolve(),
      eco.getImageGenerationSettings?.().then(setImageGenerationSettings) ?? Promise.resolve(),
      eco.listAsrProfiles().then(setAsrProfiles),
    ]);
    if (domain === "defaultAgent") {
      await refreshCoreAvailability();
    }
    if (domain === "git") {
      await eco.getGitSettings().then(setGitSettings);
    }
    if (domain === "personalization") {
      await eco.getPersonalizationSettings().then(setPersonalizationSettings);
    }
    if (domain === "packageScriptArgs") {
      setPackageScriptArgsRevision((revision) => revision + 1);
    }
    return result;
  }

  async function unlockCenterServerVaultWithPassword(password: string) {
    if (!window.eco) {
      throw new Error("Electron preload API is unavailable.");
    }
    return window.eco.unlockCenterServerVaultWithPassword(password);
  }

  async function wrapCenterServerVaultWithPassword(password: string) {
    if (!window.eco) {
      throw new Error("Electron preload API is unavailable.");
    }
    return window.eco.wrapCenterServerVaultWithPassword(password);
  }

  async function requestCenterServerVaultClaim() {
    if (!window.eco) {
      throw new Error("Electron preload API is unavailable.");
    }
    return window.eco.requestCenterServerVaultClaim();
  }

  async function listCenterServerPendingVaultClaims() {
    if (!window.eco) {
      return [];
    }
    return window.eco.listCenterServerPendingVaultClaims();
  }

  async function approveCenterServerVaultClaim(claimId: string) {
    if (!window.eco) {
      throw new Error("Electron preload API is unavailable.");
    }
    return window.eco.approveCenterServerVaultClaim(claimId);
  }

  async function submitCenterServerVaultClaimCode(code: string) {
    if (!window.eco) {
      throw new Error("Electron preload API is unavailable.");
    }
    return window.eco.submitCenterServerVaultClaimCode(code);
  }

  async function cancelCenterServerVaultClaim() {
    if (!window.eco) {
      return { hasVaultKey: false, state: "idle" as const };
    }
    return window.eco.cancelCenterServerVaultClaim();
  }

  function activateWorkspace(nextWorkspace: WorkspaceInfo) {
    setWorkspace(nextWorkspace);
    setSelectedProjectPath(nextWorkspace.path);
    registerImportedProject(nextWorkspace.path);
    setCollapsedProjectPaths((current) => {
      if (!current.has(nextWorkspace.path)) {
        return current;
      }
      const next = new Set(current);
      next.delete(nextWorkspace.path);
      window.localStorage.setItem(collapsedProjectsStorageKey, JSON.stringify([...next]));
      return next;
    });
    commitSidebarThreadSelection(undefined);
    applyFeedThreadSelection(undefined, { immediate: true });
    setComposerRuntimeConfig(null);
    setFollowUpsByThread({});
  }

  function registerImportedProject(path: string, resolvedHomeProjectPath?: string) {
    const homePath = resolvedHomeProjectPath ?? homeProjectPath;
    const isHome = homePath ? isHomeProjectPath(path, homePath) : false;

    setHiddenProjectPaths((current) => {
      if (!current.has(path)) {
        return current;
      }
      const next = new Set(current);
      next.delete(path);
      window.localStorage.setItem(hiddenProjectsStorageKey, JSON.stringify([...next]));
      return next;
    });
    if (!isHome) {
      setRecentProjects((current) => {
        const withoutHome = homePath
          ? current.filter((item) => !isHomeProjectPath(item.path, homePath))
          : current;
        const existing = withoutHome.find((item) => item.path === path);
        // Preserve the user's custom name; otherwise keep the resolved display name.
        const next = existing
          ? withoutHome.map((item) =>
              item.path === path
                ? {
                    ...item,
                    name: resolveProjectName(item.path, customProjectNames[item.path], homePath).name,
                  }
                : item,
            )
          : [
              {
                path,
                name: resolveProjectName(path, customProjectNames[path], homePath).name,
                importedAt: new Date().toISOString(),
              },
              ...withoutHome,
            ].slice(0, 12);
        window.localStorage.setItem(recentProjectsStorageKey, JSON.stringify(next));
        return next;
      });
    }
    setProjectOrder((current) => {
      const next = prependProjectOrder(current, path);
      window.localStorage.setItem(projectOrderStorageKey, JSON.stringify(next));
      projectOrderInitializedRef.current = true;
      return next;
    });
  }

  function pinProject(projectPath: string) {
    setPinnedProjectPaths((current) => {
      if (current.has(projectPath)) {
        return current;
      }
      const next = new Set(current);
      next.add(projectPath);
      window.localStorage.setItem(pinnedProjectsStorageKey, JSON.stringify([...next]));
      return next;
    });
    setProjectOrder((current) => {
      const next = prependProjectOrder(current, projectPath);
      window.localStorage.setItem(projectOrderStorageKey, JSON.stringify(next));
      projectOrderInitializedRef.current = true;
      return next;
    });
  }

  function unpinProject(projectPath: string) {
    setPinnedProjectPaths((current) => {
      if (!current.has(projectPath)) {
        return current;
      }
      const next = new Set(current);
      next.delete(projectPath);
      window.localStorage.setItem(pinnedProjectsStorageKey, JSON.stringify([...next]));
      return next;
    });
  }

  function pinThread(threadId: string) {
    setPinnedThreadIds((current) => {
      if (current.has(threadId)) {
        return current;
      }
      const next = new Set(current);
      next.add(threadId);
      window.localStorage.setItem(pinnedThreadsStorageKey, JSON.stringify([...next]));
      return next;
    });
  }

  function unpinThread(threadId: string) {
    setPinnedThreadIds((current) => {
      if (!current.has(threadId)) {
        return current;
      }
      const next = new Set(current);
      next.delete(threadId);
      window.localStorage.setItem(pinnedThreadsStorageKey, JSON.stringify([...next]));
      return next;
    });
  }

  function removeProject(projectPath: string) {
    if (homeProjectPath && isHomeProjectPath(projectPath, homeProjectPath)) {
      return;
    }
    setHiddenProjectPaths((current) => {
      const next = new Set(current);
      next.add(projectPath);
      window.localStorage.setItem(hiddenProjectsStorageKey, JSON.stringify([...next]));
      return next;
    });
    setRecentProjects((current) => {
      const next = current.filter((project) => project.path !== projectPath);
      window.localStorage.setItem(recentProjectsStorageKey, JSON.stringify(next));
      return next;
    });
    setProjectOrder((current) => {
      const next = current.filter((path) => path !== projectPath);
      window.localStorage.setItem(projectOrderStorageKey, JSON.stringify(next));
      return next;
    });
    setPinnedProjectPaths((current) => {
      if (!current.has(projectPath)) {
        return current;
      }
      const next = new Set(current);
      next.delete(projectPath);
      window.localStorage.setItem(pinnedProjectsStorageKey, JSON.stringify([...next]));
      return next;
    });
    setCollapsedProjectPaths((current) => {
      if (!current.has(projectPath)) {
        return current;
      }
      const next = new Set(current);
      next.delete(projectPath);
      window.localStorage.setItem(collapsedProjectsStorageKey, JSON.stringify([...next]));
      return next;
    });
    setExpandedProjectThreadPaths((current) => {
      if (!current.has(projectPath)) {
        return current;
      }
      const next = new Set(current);
      next.delete(projectPath);
      return next;
    });
    setSelectedProjectPath((current) => (current === projectPath ? undefined : current));
    if (selectedThreadIdRef.current) {
      const thread = threads.find((item) => item.id === selectedThreadIdRef.current);
      if (thread?.workspacePath === projectPath) {
        commitSidebarThreadSelection(undefined);
        applyFeedThreadSelection(undefined, { immediate: true });
      }
    }
    resetComposerDefaultConfig();
  }

  function reorderProjects(draggedPath: string, targetPath: string, position: ProjectReorderPosition) {
    if (
      homeProjectPath &&
      (isHomeProjectPath(draggedPath, homeProjectPath) || isHomeProjectPath(targetPath, homeProjectPath))
    ) {
      return;
    }
    setProjectOrder((current) => {
      const next = reorderProjectPaths(current, draggedPath, targetPath, position);
      window.localStorage.setItem(projectOrderStorageKey, JSON.stringify(next));
      return next;
    });
  }

  function switchProject(nextPath: string) {
    const leavingThread = Boolean(selectedThreadIdRef.current);
    const sameProject = nextPath === currentProjectPath || nextPath === selectedProjectPath;
    setSelectedProjectPath(nextPath);
    commitSidebarThreadSelection(undefined);
    applyFeedThreadSelection(undefined, { immediate: true });
    setComposerRewindTarget(undefined);
    if (!sameProject) {
      // Different project: drop in-memory config so project/default defaults load.
      setComposerRuntimeConfig(null);
    } else if (leavingThread) {
      // Same project, leaving a real thread → project/default composition.
      resetComposerDefaultConfig();
    }
    // Same project while already on landing: keep composerRuntimeConfig (new-chat affordance).
  }

  function requestSidebarReveal(kind: "project" | "thread", id: string) {
    setSidebarRevealTarget((current) => ({ kind, id, requestId: (current?.requestId ?? 0) + 1 }));
  }

  function selectSearchProject(projectPath: string) {
    switchProject(projectPath);
    setCollapsedProjectPaths((current) => {
      if (!current.has(projectPath)) {
        return current;
      }
      const next = new Set(current);
      next.delete(projectPath);
      window.localStorage.setItem(collapsedProjectsStorageKey, JSON.stringify([...next]));
      return next;
    });
    requestSidebarReveal("project", projectPath);
  }

  function selectThread(thread: ThreadSummary) {
    setUnreadThreadIds((current) => {
      if (!current.has(thread.id)) {
        return current;
      }
      const next = new Set(current);
      next.delete(thread.id);
      window.localStorage.setItem(unreadThreadsStorageKey, JSON.stringify([...next]));
      return next;
    });
    commitSidebarThreadSelection(thread.id);
    applyFeedThreadSelection(thread.id);
    setSelectedProjectPath(thread.workspacePath);
    setComposerRewindTarget(undefined);
    setCollapsedProjectPaths((current) => {
      if (!current.has(thread.workspacePath)) {
        return current;
      }
      const next = new Set(current);
      next.delete(thread.workspacePath);
      window.localStorage.setItem(collapsedProjectsStorageKey, JSON.stringify([...next]));
      return next;
    });
    const projectThreads = threadsByProject.get(thread.workspacePath) ?? [];
    const threadIndex = projectThreads.findIndex((item) => item.id === thread.id);
    if (threadIndex >= sidebarThreadsCollapsed) {
      expandProjectThreads(thread.workspacePath);
    }
  }

  function selectSearchThread(thread: ThreadSummary) {
    selectThread(thread);
    requestSidebarReveal("thread", thread.id);
  }

  function clearThreadClientState(threadId: string) {
    cancelProjectionCacheEviction(threadId);
    removeComposerDraft(`thread:${threadId}`);
    setThreads((current) => current.filter((thread) => thread.id !== threadId));
    setUnreadThreadIds((current) => {
      if (!current.has(threadId)) {
        return current;
      }
      const next = new Set(current);
      next.delete(threadId);
      window.localStorage.setItem(unreadThreadsStorageKey, JSON.stringify([...next]));
      return next;
    });
    if (selectedThreadIdRef.current === threadId) {
      commitSidebarThreadSelection(undefined);
      applyFeedThreadSelection(undefined, { immediate: true });
      resetComposerDefaultConfig();
      setComposerRewindTarget(undefined);
    } else {
      setSelectedThreadId((current) => (current === threadId ? undefined : current));
    }
    if (feedThreadIdRef.current === threadId) {
      feedThreadIdRef.current = undefined;
      setFeedThreadId(undefined);
      syncActivityFeedBootForThread(undefined);
    }
    setFollowUpsByThread((current) => removeRecordKey(current, threadId));
    clearPendingPlanForThread(threadId);
    setApprovedPlansByThread((current) => removeRecordKey(current, threadId));
    clearPendingClarificationForThread(threadId);
    clearPendingBashApprovalForThread(threadId);
  }

  async function deleteThread(thread: ThreadSummary) {
    if (!window.eco) {
      return;
    }
    if (thread.status === "running" || thread.status === "queued") {
      setError(t("thread.stopFirst"));
      return;
    }
    if (deletingThreadId) {
      return;
    }
    setDeletingThreadId(thread.id);
    try {
      let command = threadDeleteCommandsRef.current.get(thread.id);
      if (!command) {
        const head = await window.eco.conversationV2Head(thread.id);
        command = {
          expectedHistoryRevision: head.historyRevision,
          clientCommandId: `thread_delete_${stableHash({
            threadId: thread.id,
            expectedHistoryRevision: head.historyRevision,
          })}`,
        };
        threadDeleteCommandsRef.current.set(thread.id, command);
      }
      await window.eco.deleteThread({
        principalId: "desktop-local",
        clientCommandId: command.clientCommandId,
        threadId: thread.id,
        expectedHistoryRevision: command.expectedHistoryRevision,
      });
      threadDeleteCommandsRef.current.delete(thread.id);
      clearThreadClientState(thread.id);
      setPinnedThreadIds((current) => {
        if (!current.has(thread.id)) {
          return current;
        }
        const next = new Set(current);
        next.delete(thread.id);
        window.localStorage.setItem(pinnedThreadsStorageKey, JSON.stringify([...next]));
        return next;
      });
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setDeletingThreadId(undefined);
    }
  }

  function expandProjectThreads(projectPath: string) {
    setExpandedProjectThreadPaths((current) => {
      if (current.has(projectPath)) {
        return current;
      }
      const next = new Set(current);
      next.add(projectPath);
      return next;
    });
  }

  function toggleProjectCollapsed(projectPath: string) {
    setCollapsedProjectPaths((current) => {
      const next = new Set(current);
      if (next.has(projectPath)) {
        next.delete(projectPath);
      } else {
        next.add(projectPath);
      }
      window.localStorage.setItem(collapsedProjectsStorageKey, JSON.stringify([...next]));
      return next;
    });
  }

  function startNewChat() {
    const leavingThread = Boolean(selectedThreadIdRef.current);
    const editingThreadId = editingFollowUpThreadIdRef.current;
    setComposerRoutePopoverOpen(false);
    removeComposerDraft(composerContextKeyFromParts(undefined, currentProjectPath));
    commitSidebarThreadSelection(undefined);
    applyFeedThreadSelection(undefined, { immediate: true });
    setNewThreadCoreKind(workflowSettings.defaultCoreKind ?? "claude");
    // Already on an unstarted landing composer: keep orchestration / model edits.
    // Only reset when leaving an existing thread into a new landing surface.
    if (leavingThread) {
      if (editingFollowUpIdRef.current && editingThreadId) {
        void releaseThreadFollowUpEditingLock(editingThreadId).catch((caught) =>
          setError(errorMessage(caught)),
        );
      }
      editingFollowUpIdRef.current = undefined;
      editingFollowUpThreadIdRef.current = undefined;
      savedComposerBeforeFollowUpEditRef.current = undefined;
      resetComposerDefaultConfig();
    }
    setEditingFollowUpId(undefined);
    setPrompt("");
    setComposerRewindTarget(undefined);
    revokeComposerAttachmentPreviews(composerAttachmentsRef.current);
    setComposerAttachments([]);
    setComposerImageNotice(undefined);
    setError(undefined);
  }

  function startNewChatWithPlan(plan: ThreadPendingPlan) {
    const contextKey = composerContextKeyFromParts(undefined, currentProjectPath);
    if (!contextKey) {
      return;
    }
    pendingPlanComposerHandoffRef.current = {
      contextKey,
      prompt: plan.plan,
      sessionMode: "agent",
    };
    startNewChat();
  }

  async function addComposerImageFiles(files: FileList | File[]) {
    if (plannerCapability && !plannerCapability.capabilitiesResolved) {
      setComposerImageNotice(t("app.imageCapabilityUnknown"));
    } else {
      setComposerImageNotice(undefined);
    }

    const additions: ComposerImageAttachment[] = [];
    for (const file of files) {
      if (composerAttachments.length + additions.length >= COMPOSER_MAX_IMAGES) {
        break;
      }
      const attachment = await readImageFileAsAttachment(file);
      if (!attachment) {
        continue;
      }
      if (composerContextKey && attachment.data && typeof window.eco?.stagePromptImage === "function") {
        try {
          const staged = await window.eco.stagePromptImage({
            contextKey: composerContextKey,
            imageId: attachment.id,
            mediaType: attachment.mediaType,
            data: attachment.data,
          });
          additions.push({
            id: attachment.id,
            mediaType: attachment.mediaType,
            path: staged.path,
            contentRef: staged.contentRef,
            byteLength: staged.byteLength,
            previewUrl: attachment.previewUrl,
          });
          continue;
        } catch (caught) {
          console.error("[eco] prompt image stage failed", caught);
        }
      }
      additions.push(attachment);
    }
    if (additions.length === 0) {
      return;
    }
    setComposerAttachments((current) => [...current, ...additions].slice(0, COMPOSER_MAX_IMAGES));
  }

  function handleComposerPaste(event: ClipboardEvent<HTMLDivElement>) {
    const items = event.clipboardData?.items;
    if (!items?.length) {
      return;
    }
    const imageFiles: File[] = [];
    for (const item of items) {
      if (item.kind === "file" && item.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (file) {
          imageFiles.push(file);
        }
      }
    }
    if (imageFiles.length === 0) {
      return;
    }
    event.preventDefault();
    void addComposerImageFiles(imageFiles);
  }

  function handleComposerDragOver(event: ReactDragEvent<HTMLDivElement>) {
    if (![...event.dataTransfer.types].includes("Files")) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }

  function handleComposerDrop(event: ReactDragEvent<HTMLDivElement>) {
    if (![...event.dataTransfer.types].includes("Files")) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (composerDisabled) {
      return;
    }
    const files = [...event.dataTransfer.files];
    if (files.length === 0) {
      return;
    }
    const resolvedPaths: string[] = [];
    let failed = 0;
    for (const file of files) {
      const rawPath = window.eco?.getPathForFile?.(file)?.trim() ?? "";
      if (!rawPath || !isAbsoluteLocalFilePath(rawPath)) {
        failed += 1;
        continue;
      }
      resolvedPaths.push(rawPath);
    }
    if (resolvedPaths.length === 0) {
      setComposerImageNotice(t("app.fileDropNoPath"));
      return;
    }
    if (failed > 0) {
      setComposerImageNotice(t("app.fileDropPartial", { ok: resolvedPaths.length, failed }));
    } else {
      setComposerImageNotice(undefined);
    }

    const composer = composerRef.current;
    const selectionStart = composer?.getSelectionStart() ?? prompt.length;
    const selectionEnd = composer?.getSelectionEnd() ?? prompt.length;
    const insertion = resolvedPaths.map((path) => `${fileAttachmentToken(path)} `).join("");
    const next = `${prompt.slice(0, selectionStart)}${insertion}${prompt.slice(selectionEnd)}`;
    const cursor = selectionStart + insertion.length;
    composerPromptRef.current = next;
    setPrompt(next);
    queueMicrotask(() => {
      composer?.setCursor(cursor);
      composer?.focus();
      composer?.fitHeight();
      setComposerCursor(cursor);
    });
  }

  function removeComposerAttachment(id: string) {
    setComposerAttachments((current) => {
      const target = current.find((attachment) => attachment.id === id);
      if (target) {
        revokeComposerAttachmentPreview(target);
      }
      const path = target?.path?.trim();
      if (path && typeof window.eco?.releasePromptImages === "function") {
        void window.eco.releasePromptImages({ paths: [path] }).catch((caught) => {
          console.error("[eco] prompt image release failed", caught);
        });
      }
      return current.filter((attachment) => attachment.id !== id);
    });
  }

  function insertComposerNewline() {
    const composer = composerRef.current;
    if (!composer) {
      return;
    }
    composer.insertNewline();
    composer.focus();
  }

  function syncComposerCursor() {
    const composer = composerRef.current;
    if (composer) {
      setComposerCursor(composer.getSelectionEnd());
    }
  }

  function selectComposerSkill(skill: SkillInfo) {
    const composer = composerRef.current;
    if (!composerSkillSlash || !composer || promptIncludesSkillName(prompt, skill.name)) {
      return;
    }
    const selectionEnd = composer.getSelectionEnd();
    const { next, cursor } = applySlashSkillSelection(
      prompt,
      { start: composerSkillSlash.start, end: selectionEnd },
      skill.name,
    );
    setPrompt(next);
    setComposerSkillActiveIndex(0);
    queueMicrotask(() => {
      composer.setCursor(cursor);
      composer.focus();
      composer.fitHeight();
      setComposerCursor(cursor);
    });
  }

  function handleComposerKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (composerReferencesMenu.onKeyDown(event)) return;
    if (composerSkillPopoverOpen) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setComposerSkillActiveIndex((current) =>
          composerSkillMatches.length === 0 ? 0 : (current + 1) % composerSkillMatches.length,
        );
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setComposerSkillActiveIndex((current) =>
          composerSkillMatches.length === 0
            ? 0
            : (current - 1 + composerSkillMatches.length) % composerSkillMatches.length,
        );
        return;
      }
      if (event.key === "Enter" && !event.shiftKey && !event.metaKey && !event.altKey) {
        event.preventDefault();
        const match = composerSkillMatches[composerSkillActiveIndex];
        if (match) {
          selectComposerSkill(match.skill);
        }
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        return;
      }
    }

    if (event.key !== "Enter") {
      return;
    }
    // Follow-up mode: ⌘↩ does the opposite of the default delivery (queue ↔ steer).
    // ACP has no mid-turn steer; ⌘↩ queues the same as Enter.
    if (composerFollowUpMode && event.metaKey && !event.shiftKey && !event.altKey) {
      event.preventDefault();
      if (!canSend) {
        return;
      }
      if (!coreSupportsMidTurnFollowUp(activeThread?.coreKind)) {
        void sendComposerMessage(undefined, { followUpDeliveryMode: "queue" });
        return;
      }
      const defaultDelivery = workflowSettings.followUpDeliveryMode ?? "steer";
      const opposite: FollowUpDeliveryMode = defaultDelivery === "queue" ? "steer" : "queue";
      void sendComposerMessage(undefined, { followUpDeliveryMode: opposite });
      return;
    }
    if (event.shiftKey || event.metaKey || event.altKey) {
      if (event.metaKey || event.altKey) {
        event.preventDefault();
        insertComposerNewline();
      }
      return;
    }
    event.preventDefault();
    if (canSend) void sendComposerMessage();
  }

  const showLanding = !activeThread;
  const showWorkspacePanel = Boolean(currentProjectPath);
  useEffect(() => {
    if (window.eco?.platform !== "win32" && window.eco?.platform !== "linux") {
      return;
    }
    void window.eco.setWindowTitlebarMode(showLanding ? "landing" : "conversation");
  }, [showLanding]);
  const workspaceCardsLayoutMode = workspacePanelLayoutForMode(activityWorkspaceLayoutMode);
  const workspaceCardsPanelOpen = Boolean(showWorkspacePanel && workspacePanelResolvedOpen);
  const codexBackgroundTerminalsForActiveThread = useMemo(
    () => selectCodexBackgroundTerminalsForThread(codexBackgroundTerminals, activeThread?.id),
    [activeThread?.id, codexBackgroundTerminals],
  );
  const claudeBackgroundTasksForActiveThread = useMemo(
    () => selectClaudeBackgroundTasksForThread(claudeBackgroundTasks, activeThread?.id),
    [activeThread?.id, claudeBackgroundTasks],
  );
  useEffect(() => {
    if (!workspaceCardsPanelOpen && !runningResourcesOpen) {
      return;
    }
    void refreshCodexBackgroundTerminals();
    void refreshClaudeBackgroundTasks();
    const timer = window.setInterval(() => {
      void refreshCodexBackgroundTerminals();
      void refreshClaudeBackgroundTasks();
    }, 2000);
    return () => {
      window.clearInterval(timer);
    };
  }, [
    refreshClaudeBackgroundTasks,
    refreshCodexBackgroundTerminals,
    runningResourcesOpen,
    workspaceCardsPanelOpen,
  ]);
  useEffect(() => {
    if (showWorkspacePanel) {
      void refreshGitStatus();
    }
  }, [showWorkspacePanel, workspaceCardsPanelOpen, activeThread?.id, refreshGitStatus]);
  const workspaceCardsDockedLayout = Boolean(
    workspaceCardsPanelOpen && !showLanding && workspaceCardsLayoutMode === "docked",
  );
  const taskPanelOpen = Boolean(showWorkspacePanel && taskDrawerOpen);
  const taskPanelLayoutOpen = Boolean(showWorkspacePanel && taskPanelLayoutPresent);
  const taskPanelFullscreenOpen = Boolean(taskPanelLayoutOpen && taskPanelFullscreen);
  const taskPanelPhase = resolveTaskPanelLayoutPhase({
    layoutPresent: taskPanelLayoutOpen,
    exiting: taskPanelExiting,
    fullscreen: taskPanelFullscreenOpen,
  });
  const chromeFsSlotOpen = taskPanelPhase === "open" || taskPanelPhase === "fullscreen";
  const activityUserMessageNavHidden = !activityMessageNavSpaceVisible;
  const activityFeedPanelLayout = activityWorkspaceLayoutMode === "feed-panel";
  const showWorkspaceActionGroupA = shouldShowWorkspaceActionGroupA({
    settingsOpen,
    showWorkspacePanel,
  });
  const showPanelChromeGroupB = shouldShowPanelChromeGroupB({
    settingsOpen,
    showWorkspacePanel,
  });
  const rightPanelStyle = {
    "--workspace-panel-width": `${WORKSPACE_CARDS_PANEL_WIDTH_PX}px`,
    "--workspace-cards-panel-width": `${WORKSPACE_CARDS_PANEL_WIDTH_PX}px`,
    "--task-panel-width": `${taskPanelWidth}px`,
    ...taskPanelGeometryCssVariables(),
    ...(showPanelChromeGroupB ? panelChromeCssVariables({ fullscreenSlotOpen: chromeFsSlotOpen }) : {}),
  } as CSSProperties;
  const toggleTaskPanelFullscreen = useCallback(() => {
    if (window.matchMedia(taskPanelNarrowMediaQuery).matches) {
      setTaskPanelFullscreen(false);
      return;
    }
    setTaskPanelFullscreen((current) => !current);
  }, []);

  // B group (ChromeStrip): top-only MainPane overlay — never mounts on settings.
  const renderPanelControlButtons = () =>
    showPanelChromeGroupB ? (
      <div
        className="codex-main-pane-panel-actions"
        data-group="chrome"
        aria-label={t("app.workspaceControls")}
      >
        <span
          className={[
            "codex-main-pane-panel-action-slot",
            // Open only while docked; collapse as soon as exit reflow starts so the slot
            // motion runs with the panel (not after the spring settles).
            taskPanelLayoutOpen && !taskPanelExiting ? "is-open" : "",
          ]
            .filter(Boolean)
            .join(" ")}
          aria-hidden={!taskPanelLayoutOpen || taskPanelExiting}
        >
          <button
            type="button"
            className={
              taskPanelFullscreenOpen
                ? "codex-main-toolbar-button is-active codex-main-topbar-fullscreen"
                : "codex-main-toolbar-button codex-main-topbar-fullscreen"
            }
            onClick={toggleTaskPanelFullscreen}
            title={taskPanelFullscreenOpen ? t("task.exitFullscreenTitle") : t("task.enterFullscreen")}
            aria-label={taskPanelFullscreenOpen ? t("task.exitFullscreen") : t("task.enterFullscreen")}
            aria-pressed={taskPanelFullscreenOpen}
            tabIndex={taskPanelLayoutOpen && !taskPanelExiting ? 0 : -1}
            disabled={!taskPanelLayoutOpen || taskPanelExiting}
          >
            {taskPanelFullscreenOpen ? (
              <Minimize2 size={15} aria-hidden />
            ) : (
              <Maximize2 size={15} aria-hidden />
            )}
          </button>
        </span>
        <button
          type="button"
          className={
            currentTerminalState?.open ? "codex-main-toolbar-button is-active" : "codex-main-toolbar-button"
          }
          onClick={toggleTerminalForCurrentProject}
          title={`${currentTerminalState?.open ? t("app.terminalClose") : t("app.terminalOpen")} (Ctrl+\`)`}
          aria-label={currentTerminalState?.open ? t("app.terminalClose") : t("app.terminalOpen")}
          aria-expanded={currentTerminalState?.open === true}
          aria-controls="terminal-panel"
        >
          <PanelBottom size={15} aria-hidden />
        </button>
        <button
          type="button"
          className={taskPanelOpen ? "codex-main-toolbar-button is-active" : "codex-main-toolbar-button"}
          onClick={toggleTaskPanelForCurrentProject}
          title={taskPanelOpen ? t("app.taskSidebarCollapse") : t("app.taskSidebarOpen")}
          aria-label={taskPanelOpen ? t("app.taskSidebarCollapse") : t("app.taskSidebarOpen")}
          aria-expanded={taskPanelOpen}
          aria-controls="task-panel"
        >
          <PanelRight size={15} aria-hidden />
        </button>
      </div>
    ) : null;

  // A group (workspace): web chat + workpanel — rides the feed topbar. Hidden on settings.
  const renderWorkspaceTopbarActions = () =>
    showWorkspaceActionGroupA ? (
      <div className="codex-main-topbar-actions" aria-label={t("app.workspaceControls")}>
        <div className="codex-main-topbar-action-group" data-group="workspace">
          <button
            ref={runningResourcesAnchorRef}
            type="button"
            className={runningResourcesOpen ? "codex-main-toolbar-button is-active" : "codex-main-toolbar-button"}
            onClick={() => {
              setWebChatListOpen(false);
              setRunningResourcesOpen((open) => !open);
            }}
            title={t("app.running.title")}
            aria-label={t("app.running.title")}
            aria-expanded={runningResourcesOpen}
            aria-haspopup="dialog"
          >
            <Activity size={15} aria-hidden />
          </button>
          {runningResourcesOpen ? (
            <RunningResourcesPopover
              anchorRef={runningResourcesAnchorRef}
              threads={threads}
              projects={projects}
              terminalByProject={terminalByProject}
              codexTerminals={codexBackgroundTerminals}
              {...(codexBackgroundTerminalError && { codexTerminalError: codexBackgroundTerminalError })}
              onTerminateCodexTerminal={stopCodexBackgroundTerminal}
              claudeTasks={claudeBackgroundTasks}
              {...(claudeBackgroundTaskError && { claudeTaskError: claudeBackgroundTaskError })}
              onStopClaudeTask={stopClaudeBackgroundTask}
              onClose={() => setRunningResourcesOpen(false)}
              onTerminalClosed={handleRunningTerminalClosed}
            />
          ) : null}
          <button
            ref={webChatListAnchorRef}
            type="button"
            className={webChatListOpen ? "codex-main-toolbar-button is-active" : "codex-main-toolbar-button"}
            onClick={() => {
              setRunningResourcesOpen(false);
              setWebChatListOpen((open) => !open);
            }}
            title={t("app.webChat.openList")}
            aria-label={t("app.webChat.openList")}
            aria-expanded={webChatListOpen}
            aria-haspopup="dialog"
          >
            <MessageSquare size={15} aria-hidden />
          </button>
          <WebChatListPopover
            open={webChatListOpen}
            items={webChatList.items}
            siteProxies={webChatList.siteProxies}
            anchorRef={webChatListAnchorRef}
            onClose={() => setWebChatListOpen(false)}
            onSelect={openWebChatItem}
            onListChange={setWebChatList}
          />
          <button
            type="button"
            className={
              workspaceCardsPanelOpen ? "codex-main-toolbar-button is-active" : "codex-main-toolbar-button"
            }
            onClick={toggleWorkspacePanelForCurrentProject}
            title={workspaceCardsPanelOpen ? t("app.workspaceCardsCollapse") : t("app.workspaceCardsOpen")}
            aria-label={
              workspaceCardsPanelOpen ? t("app.workspaceCardsCollapse") : t("app.workspaceCardsOpen")
            }
            aria-expanded={workspaceCardsPanelOpen}
            aria-controls="workspace-cards-panel"
          >
            <SlidersHorizontal size={15} aria-hidden />
          </button>
        </div>
      </div>
    ) : null;
  const renderTaskPanel = () =>
    showWorkspacePanel && taskPanelLayoutOpen && taskPanelUiThreadIdRef.current === browserScopeId ? (
      <motion.aside
        id="task-panel-container"
        className={["workspace-panel", "is-task-panel-mode", taskPanelFullscreenOpen ? "is-fullscreen" : ""]
          .filter(Boolean)
          .join(" ")}
        aria-label={taskPanelFullscreenOpen ? t("app.taskPanelFullscreen") : t("app.taskPanel")}
        aria-hidden={!taskPanelOpen}
        initial={false}
        animate={taskPanelAnimationControls}
        style={{ willChange: "transform, opacity" }}
      >
        <hr
          className="task-panel-resize-handle"
          aria-label={t("app.taskPanelResize")}
          aria-orientation="vertical"
          tabIndex={0}
          title={t("app.dragResize")}
          onPointerDown={handleTaskPanelResizePointerDown}
          onPointerMove={handleTaskPanelResizePointerMove}
          onPointerUp={handleTaskPanelResizePointerEnd}
          onPointerCancel={handleTaskPanelResizePointerEnd}
          onKeyDown={handleTaskPanelResizeKeyDown}
        />
        <SuspensePanel>
          <OpenTtsArtifactContext value={openTtsArtifact}>
          <TtsArtifactsContext value={activeThread ? (ttsArtifactsByThread[activeThread.id] ?? []) : []}>
          <LazySubagentTaskDrawer
            browserInstances={browserTaskInstances}
            open={taskPanelLayoutOpen}
            surfaceActive={taskPanelOpen && !taskPanelExiting}
            fullscreen={taskPanelFullscreenOpen}
            cards={activeSubagentCards}
            v2Only={Boolean(activeConversationV2)}
            {...(taskPanelPlan && { plan: taskPanelPlan })}
            activeTab={taskPanelActiveTab}
            openTabIds={openTaskPanelTabIds}
            {...(runProjection && { projection: runProjection })}
            {...(activeThread && { threadStatus: activeThread.status })}
            agentDisplayNames={activeRuntimeAgentDisplayNames}
            agentThemes={activeRuntimeAgentThemes}
            backgroundTasks={backgroundTerminalTasks}
            ttsArtifacts={activeThread ? (ttsArtifactsByThread[activeThread.id] ?? []) : []}
            onSelectTtsArtifact={openTtsArtifact}
            imageArtifacts={activeThread ? (imageArtifactsByThread[activeThread.id] ?? []) : []}
            onSelectImageArtifact={openImageGenerationArtifact}
            imageDisplayArtifacts={activeThread ? (imageDisplayArtifactsByThread[activeThread.id] ?? []) : []}
            onSelectImageDisplayArtifact={openImageDisplayArtifact}
            {...(reviewDiff && { reviewDiff })}
            reviewLoading={reviewDiffLoading}
            {...(reviewDiffError && { reviewError: reviewDiffError })}
            {...(reviewSelectedPath && { reviewSelectedPath })}
            reviewRevision={reviewDiffRevision}
            onRefreshReview={requestReviewDiffRefresh}
            onSelectAgent={(agentId) => {
              setTaskPanelActiveTab(agentId);
              setSelectedSubagentAgentId(agentId);
            }}
            onSelectPlan={() => {
              setOpenTaskPanelTabIds((current) => addOpenTaskPanelTab(current, TASK_PANEL_PLAN_TAB_ID));
              setTaskPanelActiveTab(TASK_PANEL_PLAN_TAB_ID);
              setSelectedSubagentAgentId(undefined);
            }}
            onCloseTab={closeTaskPanelTab}
            onSelectBackgroundTasks={() => {
              setOpenTaskPanelTabIds((current) =>
                addOpenTaskPanelTab(current, TASK_PANEL_BACKGROUND_TERMINAL_TAB_ID),
              );
              setTaskPanelActiveTab(TASK_PANEL_BACKGROUND_TERMINAL_TAB_ID);
              setSelectedSubagentAgentId(undefined);
            }}
            onSelectReview={() => {
              setOpenTaskPanelTabIds((current) => addOpenTaskPanelTab(current, TASK_PANEL_REVIEW_TAB_ID));
              setTaskPanelActiveTab(TASK_PANEL_REVIEW_TAB_ID);
              setSelectedSubagentAgentId(undefined);
              void refreshReviewDiff();
            }}
            workspacePath={currentProjectPath ?? ""}
            {...(fileTarget && { fileTarget })}
            onSelectFiles={() => {
              setOpenTaskPanelTabIds((current) => addOpenTaskPanelTab(current, TASK_PANEL_FILES_TAB_ID));
              setTaskPanelActiveTab(TASK_PANEL_FILES_TAB_ID);
              setSelectedSubagentAgentId(undefined);
            }}
            onSelectFileViewer={() => {
              setOpenTaskPanelTabIds((current) =>
                addOpenTaskPanelTab(current, TASK_PANEL_FILE_VIEWER_TAB_ID),
              );
              setTaskPanelActiveTab(TASK_PANEL_FILE_VIEWER_TAB_ID);
              setSelectedSubagentAgentId(undefined);
            }}
            onSelectBrowser={(browserId) => {
              if (browserId) {
                selectBrowserTaskTab(browserId);
                return;
              }
              openBrowserTaskPanel();
            }}
            onViewedFileChange={(target) => {
              fileReferenceRequestIdRef.current = Math.max(
                fileReferenceRequestIdRef.current,
                target.requestId,
              );
              setFileTarget(target);
            }}
            onOpenHomeTool={(sourceTabId, tool) => void openTaskPanelHomeTool(sourceTabId, tool)}
            onNavigateNewTab={navigateNewTaskPanelTab}
            onSelectNewTab={(tabId) => {
              setTaskPanelActiveTab(tabId);
              setSelectedSubagentAgentId(undefined);
            }}
            onNewBrowserTab={openBrowserTaskPanel}
            onSelectReviewPath={setReviewSelectedPath}
            onOpenTerminalTask={(task) => void openBackgroundTerminalTask(task)}
            onStopTerminalTask={(task) => void stopBackgroundTerminalTask(task)}
            sshBookmarks={sshBookmarks}
            onSshBookmarksChange={setSshBookmarks}
            onSelectSshBookmarks={() => {
              setOpenTaskPanelTabIds((current) =>
                addOpenTaskPanelTab(current, TASK_PANEL_SSH_BOOKMARKS_TAB_ID),
              );
              setTaskPanelActiveTab(TASK_PANEL_SSH_BOOKMARKS_TAB_ID);
              setSelectedSubagentAgentId(undefined);
            }}
            onConnectSshBookmark={(bookmark) => void connectSshBookmark(bookmark)}
            centerServerSyncVisible={centerServerSyncVisible}
            onSyncDomain={async (domain, mode) => {
              const result = await syncCenterServerConfigDomain(domain, mode);
              if (domain === "sshBookmarks") {
                const next = await window.eco?.getSshBookmarks?.();
                if (next) {
                  setSshBookmarks(next);
                }
              }
              return result;
            }}
          />
          </TtsArtifactsContext>
          </OpenTtsArtifactContext>
        </SuspensePanel>
      </motion.aside>
    ) : null;
  const syncTopbarMode = useCallback(() => {
    const scrollBody = scrollBodyRef.current;
    const topbar = topbarRef.current;
    if (!scrollBody || !topbar) {
      return;
    }
    const overlap = measureTopbarFeedOverlap(scrollBody, topbar);
    setTopbarSolid(overlap);
  }, []);
  useEffect(() => {
    if (showLanding || !currentProjectPath) {
      return undefined;
    }
    const scrollBody = scrollBodyRef.current;
    const topbar = topbarRef.current;
    if (!scrollBody || !topbar) {
      return undefined;
    }
    const run = () => {
      requestAnimationFrame(() => {
        syncTopbarMode();
      });
    };
    run();
    const observer = new ResizeObserver(run);
    observer.observe(scrollBody);
    observer.observe(topbar);
    const feed = scrollBody.querySelector(".codex-feed-stack");
    if (feed) {
      observer.observe(feed);
    }
    const title = topbar.querySelector(".activity-header");
    if (title) {
      observer.observe(title);
    }
    return () => observer.disconnect();
  }, [
    showLanding,
    currentProjectPath,
    activeThread?.id,
    workspaceCardsPanelOpen,
    workspaceCardsLayoutMode,
    taskDrawerOpen,
    syncTopbarMode,
  ]);
  useEffect(() => {
    if (showLanding || !currentProjectPath) {
      return undefined;
    }
    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0) {
        return;
      }
      const topbar = topbarRef.current;
      if (!topbar) {
        return;
      }
      const topbarRect = topbar.getBoundingClientRect();
      if (event.clientY > topbarRect.bottom + 1) {
        return;
      }
      const active = document.activeElement;
      if (
        active instanceof HTMLElement &&
        active.closest(
          ".terminal-panel, .ghostty-terminal-host, .xterm, textarea, input, [contenteditable='true']",
        )
      ) {
        active.blur();
      }
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => window.removeEventListener("pointerdown", onPointerDown, true);
  }, [showLanding, currentProjectPath]);
  const shellClassName = [
    "shell",
    settingsOpen ? "shell-settings-open" : "",
    sidebarOpen ? "" : "shell-sidebar-hidden",
  ]
    .filter(Boolean)
    .join(" ");
  const composerPlaceholder = showClarification
    ? t("thread.composer.answerQuestion")
    : showBashApproval
      ? t("thread.composer.approveTool")
      : showPlanApproval
        ? t("thread.composer.approvePlan")
        : contextCompactionInFlight
          ? t("thread.composer.compacting")
          : activeThread?.status === "awaiting_plan"
            ? t("thread.composer.confirmPlan")
            : activeThread && isContinuableThreadStatus(activeThread.status)
              ? t("thread.composer.continue")
              : composerFollowUpMode
                ? editingFollowUpId
                  ? t("thread.composer.editFollowUp")
                  : t("thread.composer.requestChanges")
                : activeThread
                  ? t("thread.composer.unavailable")
                  : t("thread.composer.placeholder");
  const composerDisabled = Boolean(activeThread && !threadAcceptsInput && !composerFollowUpMode);

  useEffect(() => {
    const insert = (event: Event) => {
      const selection = (event as CustomEvent<BrowserSelection>).detail;
      if (!selection || selection.scopeId !== browserScopeIdRef.current) return;
      if (composerDisabled) { showAppMessageError(t("browser.selection.composerDisabled")); return; }
      const current = composerPromptRef.current;
      const offset = Math.max(0, Math.min(composerCursor, current.length));
      const token = `${composerReferenceToken(browserSelectionReference(selection))} `;
      const next = current.slice(0, offset) + token + current.slice(offset);
      composerPromptRef.current = next;
      setPrompt(next);
      const cursor = offset + token.length;
      window.requestAnimationFrame(() => {
        if (browserScopeIdRef.current !== selection.scopeId || composerPromptRef.current !== next) return;
        composerRef.current?.focus();
        composerRef.current?.setCursor(cursor);
        composerRef.current?.fitHeight();
        setComposerCursor(cursor);
      });
    };
    const reveal = (event: Event) => {
      const state = (event as CustomEvent<BrowserViewState>).detail;
      if (state?.uiScopeId !== browserScopeIdRef.current || !state.focusedBrowserId) return;
      const tabId = browserTaskTabId(state.focusedBrowserId);
      setOpenTaskPanelTabIds(current => addOpenTaskPanelTab(current, tabId));
      setTaskPanelActiveTab(tabId);
      setTaskPanelFullscreen(false);
      setSelectedSubagentAgentId(undefined);
      revealTaskPanel();
    };
    window.addEventListener(BROWSER_SELECTION_INSERT_EVENT, insert);
    window.addEventListener(BROWSER_SELECTION_REVEAL_EVENT, reveal);
    return () => {
      window.removeEventListener(BROWSER_SELECTION_INSERT_EVENT, insert);
      window.removeEventListener(BROWSER_SELECTION_REVEAL_EVENT, reveal);
    };
  }, [composerCursor, composerDisabled, revealTaskPanel, showAppMessageError, t]);
  const composerActionMode = editingFollowUpId
    ? "save-follow-up"
    : canStopThread
      ? composerHasContent
        ? "queue"
        : "stop"
      : composerShowContinue
        ? "continue"
        : "send";
  // The follow-up delivery mode actually applied when sending while the thread is running
  // (steer = 调整方向, queue = 排队); used to pick the composer action icon/label.
  const composerFollowUpDeliveryMode: FollowUpDeliveryMode = resolveFollowUpDeliveryModeForCore(
    activeThread?.coreKind,
    workflowSettings.followUpDeliveryMode ?? "steer",
  );
  const composerActionBusy =
    composerActionMode === "stop"
      ? cancelBusy || Boolean(activeThread?.cancelling)
      : isStarting || followUpBusy;
  const composerActionDisabled =
    composerActionMode === "stop"
      ? cancelBusy || Boolean(activeThread?.cancelling)
      : composerActionMode === "continue"
        ? isStarting || followUpBusy
        : !canSend;
  const composerActionLabel =
    composerActionMode === "stop"
      ? activeThread?.cancelling || cancelBusy
        ? t("thread.action.stopping")
        : t("thread.action.stop")
      : composerActionMode === "continue"
        ? t("thread.action.continue")
        : composerActionMode === "queue"
          ? composerFollowUpDeliveryMode === "steer"
            ? t("thread.action.steer")
            : t("thread.action.queue")
          : composerActionMode === "save-follow-up"
            ? t("thread.action.saveFollowUp")
            : t("thread.action.send");
  const composerActionClassName = ["send-button", composerActionMode].filter(Boolean).join(" ");
  const composerCompact = !showLanding;
  useLayoutEffect(() => {
    // The same editor survives landing → conversation. Its CSS minimum height
    // changes with compact mode, so remeasure before the first keystroke.
    composerRef.current?.fitHeight();
  }, [composerCompact]);
  const composerIconOnly = useComposerIconOnlyToolbar();
  const handleAsrText = useCallback((text: string) => {
    const start = composerRef.current?.getSelectionStart() ?? composerPromptRef.current.length;
    const end = composerRef.current?.getSelectionEnd() ?? start;
    const merged = mergeAsrTextAtSelection(composerPromptRef.current, text, start, end);
    composerPromptRef.current = merged.prompt;
    setPrompt(merged.prompt);
    requestAnimationFrame(() => composerRef.current?.setCursor(merged.cursor));
  }, []);
  const handleAsrSend = useCallback(
    (text: string) => {
      const start = composerRef.current?.getSelectionStart() ?? composerPromptRef.current.length;
      const end = composerRef.current?.getSelectionEnd() ?? start;
      const merged = mergeAsrTextAtSelection(composerPromptRef.current, text, start, end);
      composerPromptRef.current = merged.prompt;
      setPrompt(merged.prompt);
      requestAnimationFrame(() => composerRef.current?.setCursor(merged.cursor));
      void sendComposerMessage(merged.prompt);
    },
    [sendComposerMessage],
  );
  const handleAsrError = useCallback((message: string) => {
    showAppMessageErrorRef.current(message);
  }, []);
  const asrComposerConfigured = isAsrComposerConfigured(asrProfiles);
  const asrSession = useAsrRecorder({
    ...(asrProfiles.activeProfileId ? { activeProfileId: asrProfiles.activeProfileId } : {}),
    selectedInputDeviceId: asrProfiles.inputDeviceId ?? "",
    disabled: composerDisabled,
    onText: handleAsrText,
    onSendText: handleAsrSend,
    onError: handleAsrError,
  });

  useEffect(() => {
    if (!asrSession.active) return;
    setComposerPlusMenuOpen(false);
    if (composerRoutePopoverOpen) setComposerRoutePopoverOpen(false);
  }, [asrSession.active, composerRoutePopoverOpen]);

  const renderComposerRouteControl = () => (
    <ComposerRoutePopover
      open={composerRoutePopoverOpen && canOpenComposerRoute && composerShowsRoute}
      settings={settings}
      busy={isSavingSettings}
      canEdit={canEditComposerConfig}
      canEditStatelessModels={canEditStatelessModelConfig}
      showOrchestration={composerNeedsOrchestration}
      invalidFields={invalidOrchestrationFields}
      orchestrationIssues={orchestrationIssues}
      anchorRef={composerAnchorRef}
      triggerRef={composerPlusButtonRef}
      onBack={() => { setComposerRoutePopoverOpen(false); setComposerPlusMenuOpen(true); }}
      runtimeConfig={composerRuntimeConfig ?? undefined}
      onClose={() => setComposerRoutePopoverOpen(false)}
      onSelectMainAgentConfig={selectComposerMainAgentConfig}
      onSelectMainPrompt={selectComposerMainPrompt}
      onSelectSubagents={selectComposerSubagents}
      onSelectAuxiliaryModel={selectComposerAuxiliaryModel}
      onSelectApprovalModel={selectComposerApprovalModel}
      onSelectVisionModel={selectComposerVisionModel}
      coreKind={composerCoreKind}
      onResetToGlobalSettings={() => void resetComposerToGlobalSettings()}
      onOpenFullSettings={() => openModelsSettings("compositionParts")}
    />
  );

  const renderComposerAgentModelsControl = () => (
    <div>
      <ComposerAgentModels
        labels={agentModelLabels}
        subagentSettings={composerRuntimeConfig?.subagentEnabled ?? defaultSubagentAvailability()}
        canEditSubagents={canEditComposerConfig}
        subagentSaving={isSavingSettings}
        compact={composerCompact}
        onToggleSubagent={(role, enabled) => void toggleComposerSubagent(role, enabled)}
      />
    </div>
  );

  const renderComposerMcpControl = () => (
    <div>
      <ComposerMcpServers
        servers={mcpSettings.servers}
        enabledSettings={composerMcpSettings}
        canEdit={canEditComposerConfig}
        saving={isSavingSettings}
        compact={composerCompact}
        onToggleServer={(serverKey, enabled) => void toggleComposerMcpServer(serverKey, enabled)}
      />
    </div>
  );

  const renderComposerIntegrationsControl = () => (
    <div>
      <ComposerIntegrations
        availability={integrationAvailability}
        enabledSettings={composerIntegrationSettings}
        canEdit={canEditComposerConfig}
        saving={isSavingSettings}
        compact={composerCompact}
        onToggle={(id, enabled) => void toggleComposerIntegration(id, enabled)}
      />
    </div>
  );

  const renderComposerSkillsControl = () => (
    <div>
      <ComposerSkillsControl
        skills={composerAvailableSkills}
        enabledSettings={composerSkillsEnabled}
        canEdit={canEditComposerConfig}
        saving={isSavingSettings}
        compact={composerCompact}
        onToggleSkill={(settingsKey, enabled) => void toggleComposerSkill(settingsKey, enabled)}
      />
    </div>
  );

  const composerAcpSelectedModelId = resolveAcpCursorModelIdForSend({
    runtimeConfig: composerRuntimeConfig,
    ...(workflowSettings.acpCursorModelId !== undefined
      ? { workflowDefault: workflowSettings.acpCursorModelId }
      : {}),
  });
  const renderComposerModelControl = () =>
    composerModelAvailability === "acp" ? (
      <ComposerAcpModelTrigger
        models={cursorModels}
        {...(composerAcpSelectedModelId ? { selectedModelId: composerAcpSelectedModelId } : {})}
        disabled={!canEditComposerConfig || isSavingSettings}
        loading={cursorModelsLoading}
        {...(cursorModelsError ? { error: cursorModelsError } : {})}
        onOpen={refreshCursorModels}
        onChange={(modelId) => void selectComposerAcpModel(modelId)}
      />
    ) : composerModelAvailability === "ready" &&
      templateMainModel &&
      !(composerRoutePopoverOpen && composerRouteAnchor === "model-empty") ? (
      <ComposerModelSelector
        options={composerModelOptions}
        templateModel={templateMainModel}
        value={composerMainAgentModelOverride}
        disabled={!canEditComposerConfig || isSavingSettings}
        loading={composerModelsLoading}
        error={composerModelsError}
        onOpen={refreshComposerCandidateModels}
        onChange={(override) => void selectComposerMainAgentModel(override)}
      />
    ) : composerModelAvailability === "no-provider" ? (
      <ComposerModelEmptyTrigger state="no-provider" onAction={openProviderSettings} />
    ) : (
      <ComposerModelEmptyTrigger
        state="no-orchestration"
        buttonRef={composerModelEmptyTriggerRef}
        disabled={!canOpenComposerRoute}
        onAction={openComposerOrchestrationChooser}
      />
    );

  const showComposerContextOverlays = showLanding && !asrSession.active;
  const showComposerInputOverlays = queuedFollowUps.length > 0 || showComposerContextOverlays;
  // Reported by the Feed, which owns the clock: the run is live, its waiting line is not up,
  // and nothing visible has changed for half a second — the gap while the agent writes its
  // next tool call. See `composer-floating-loading.ts`.
  const [composerAgentSilenceVisible, setComposerAgentSilenceVisible] = useState(false);

  useLayoutEffect(() => {
    const overlays = composerInputOverlaysRef.current;
    if (!overlays) {
      setComposerInputOverlaysHeight(0);
      return;
    }
    const updateHeight = () =>
      setComposerInputOverlaysHeight(Math.ceil(overlays.getBoundingClientRect().height));
    updateHeight();
    const observer = new ResizeObserver(updateHeight);
    observer.observe(overlays);
    return () => observer.disconnect();
  }, [queuedFollowUps.length, showComposerContextOverlays]);

  const renderComposer = () => (
    <div
      className="codex-composer-wrap"
      style={
        {
          "--composer-input-overlays-height": `${composerInputOverlaysHeight}px`,
        } as CSSProperties
      }
    >
      {composerImageNotice && <p className="composer-image-notice">{composerImageNotice}</p>}
      <div className="composer-feed-notices">
        {composerPromptCacheHint ? <FeedStatusDivider message={composerPromptCacheHint} /> : null}
        {composerRuntimeConfig ? (
          <FullAccessNotice
            bashReviewMode={composerRuntimeConfig.bashReviewMode}
            scopeKey={activeThread?.id ?? `draft:${currentProjectPath}`}
          />
        ) : null}
        {activeThread && threadIdleCacheWarningEligible ? (
          <ThreadIdleCacheWarning
            lastActivityAt={threadIdleCacheWarningActivityAt}
            onStartNewThread={startNewChat}
          />
        ) : null}
      </div>
      <div className="composer-input-stack">
        {showComposerInputOverlays ? (
          <div ref={composerInputOverlaysRef} className="composer-input-overlays">
            {queuedFollowUps.length > 0 ? (
              <FollowUpQueuePanel
                followUps={queuedFollowUps}
                editingFollowUpId={editingFollowUpId}
                queuePaused={Boolean(activeThread?.followUpQueuePaused)}
                pauseBusy={followUpQueuePauseBusy}
                cancelBusyId={followUpCancelBusyId}
                escalateBusyId={followUpEscalateBusyId}
                allowEscalate={activeThread ? coreSupportsFollowUpEscalate(activeThread.coreKind) : false}
                onCancel={(followUp) => void cancelQueuedFollowUp(followUp)}
                onEscalate={(followUp) => void escalateQueuedFollowUp(followUp)}
                onEdit={startEditingFollowUp}
                onReorder={(followUpIds) => void reorderQueuedFollowUps(followUpIds)}
                onTogglePause={(paused) => void toggleFollowUpQueuePaused(paused)}
              />
            ) : null}
            {showComposerContextOverlays ? (
              <div className="composer-context-bar">
                {composerNeedsOrchestration ? renderComposerAgentModelsControl() : null}
                {renderComposerMcpControl()}
                {renderComposerIntegrationsControl()}
                {renderComposerSkillsControl()}
              </div>
            ) : null}
          </div>
        ) : null}
        {/* The overlay band is shared: a queued follow-up panel or the landing context bar
            already owns it, and stacking the dots under either would just collide. */}
        {composerAgentSilenceVisible && !showComposerInputOverlays ? <ComposerFloatingLoading /> : null}
        <ComposerDockMorph
          showApproval={showComposerDockApproval}
          surfaceKey={composerDockSurfaceKey}
          approval={
            showBashApproval && pendingBashApproval ? (
              <BashApprovalPanel
                request={pendingBashApproval}
                busy={bashApprovalBusy}
                variant="dock"
                onResolve={(resolution) => void resolvePendingBashApproval(resolution)}
                onSkip={() => void resolvePendingBashApproval({ decision: "denied" })}
              />
            ) : showPlanApproval && pendingPlan ? (
              <PlanApprovalPanel
                plan={pendingPlan}
                busy={planActionBusy}
                variant="dock"
                {...(planFailureMessage && { failureMessage: planFailureMessage })}
                onApprove={() => void approvePendingPlan()}
                onStartNewSession={() => startNewChatWithPlan(pendingPlan)}
                onReviewCode={() => void reviewPendingPlanCode()}
                onApproveWithSubagent={(agentKey, additionalMessage) =>
                  void approvePendingPlanWithSubagent(agentKey, additionalMessage)
                }
                delegationAgents={planDelegationAgents}
                additionalMessage={planDelegationMessagesByThread[pendingPlan.threadId] ?? ""}
                onAdditionalMessageChange={(value) =>
                  setPlanDelegationMessagesByThread((current) => ({
                    ...current,
                    [pendingPlan.threadId]: value,
                  }))
                }
                onDismiss={() => void dismissPendingPlan()}
                onOpenInPanel={openPlanTaskDrawer}
              />
            ) : showClarification && pendingClarification ? (
              <ClarificationPanel
                request={pendingClarification}
                busy={clarificationBusy}
                variant="dock"
                onSubmit={submitClarificationAnswers}
                onDismiss={() => void dismissPendingClarification()}
              />
            ) : null
          }
          composer={
            asrSession.active ? (
              <div
                className={[
                  "codex-composer",
                  "is-voice-recording",
                  composerCompact ? "is-compact" : "",
                  composerIconOnly ? "is-icon-only" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                ref={composerAnchorRef}
              >
                <AsrVoiceComposer session={asrSession} />
              </div>
            ) : (
              <div
                className={[
                  "codex-composer",
                  composerCompact ? "is-compact" : "",
                  composerIconOnly ? "is-icon-only" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                ref={composerAnchorRef}
                onDragOver={handleComposerDragOver}
                onDrop={handleComposerDrop}
              >
                {composerReferencesMenu.open ? <ComposerReferencesMenu
                  anchorRef={composerAnchorRef}
                  items={composerReferencesMenu.items}
                  activeIndex={composerReferencesMenu.activeIndex}
                  loading={composerReferencesMenu.loading}
                  error={composerReferencesMenu.error}
                  hasMore={composerReferencesMenu.hasMore}
                  onActiveIndexChange={composerReferencesMenu.setActiveIndex}
                  onSelect={composerReferencesMenu.select}
                  onClose={composerReferencesMenu.close}
                /> : null}
                <ComposerSkillsSlashMenu
                  open={composerSkillPopoverOpen && !composerReferencesMenu.open}
                  query={composerSkillSlash?.query ?? ""}
                  skills={slashPickerSkills}
                  matches={composerSkillMatches}
                  activeIndex={composerSkillActiveIndex}
                  anchorRef={composerAnchorRef}
                  onActiveIndexChange={setComposerSkillActiveIndex}
                  onSelect={selectComposerSkill}
                  onClose={() => syncComposerCursor()}
                />
                <div className="composer-primary">
                  {composerAttachments.length > 0 ? (
                    <ul className="composer-attachments" aria-label={t("app.pastedImages")}>
                      {composerAttachments.map((attachment, index) => {
                        const alt = `${t("app.pastedImages")} ${index + 1}`;
                        const openLabel = t("app.openPastedImage", { count: index + 1 });
                        return (
                          <li key={attachment.id} className="composer-attachment">
                            <button
                              type="button"
                              className="composer-attachment-preview"
                              disabled={!attachment.previewUrl}
                              onClick={() => {
                                if (!attachment.previewUrl) return;
                                setComposerLightbox({
                                  src: attachment.previewUrl,
                                  alt,
                                  label: openLabel,
                                });
                              }}
                              aria-label={attachment.previewUrl ? openLabel : t("app.imagePreviewUnavailable")}
                            >
                              {attachment.previewUrl ? (
                                <img src={attachment.previewUrl} alt={alt} />
                              ) : (
                                <span className="composer-attachment-preview-missing">
                                  {t("app.imagePreviewUnavailable")}
                                </span>
                              )}
                            </button>
                            <button
                              type="button"
                              className="composer-attachment-remove"
                              aria-label={t("app.removeImage")}
                              onClick={() => removeComposerAttachment(attachment.id)}
                            >
                              <X size={14} />
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  ) : null}
                  {composerLightbox ? (
                    <ImageLightbox
                      src={composerLightbox.src}
                      alt={composerLightbox.alt}
                      title={composerLightbox.alt}
                      dialogLabel={composerLightbox.label}
                      onClose={closeComposerLightbox}
                    />
                  ) : null}
                  <ComposerSkillsInput
                    ref={composerRef}
                    referencePopup={composerReferencesMenu.open ? { activeIndex: composerReferencesMenu.items.length ? composerReferencesMenu.activeIndex : -1 } : undefined}
                    value={prompt}
                    onChange={(next) => {
                      composerPromptRef.current = next;
                      setPrompt(next);
                      if (composerRoutePopoverOpen) {
                        setComposerRoutePopoverOpen(false);
                      }
                    }}
                    skillsByName={composerSkillsByName}
                    onCursorChange={setComposerCursor}
                    onKeyDown={handleComposerKeyDown}
                    maxHeight={COMPOSER_TEXTAREA_MAX_HEIGHT}
                    onPaste={handleComposerPaste}
                    onPasteImageFiles={(files) => void addComposerImageFiles(files)}
                    placeholder={composerPlaceholder}
                    disabled={composerDisabled}
                  />
                  <div className="composer-footer">
                    <div className="composer-footer-row composer-footer-config-row">
                      <ComposerPlusMenu
                        buttonRef={composerPlusButtonRef}
                        anchorRef={composerAnchorRef}
                        open={composerPlusMenuOpen}
                        panelActive={composerPlusMenuOpen || composerRoutePopoverOpen || Boolean(scheduledMessageEditor && scheduledMessageEditor.threadId === activeThread?.id)}
                        sessionMode={composerRuntimeConfig?.sessionMode ?? "agent"}
                        canEditMode={canEditComposerConfig}
                        canOpenRoute={canOpenComposerRoute}
                        showRoute={composerShowsRoute}
                        saving={isSavingSettings}
                        onSelectMode={(mode) => void selectComposerSessionMode(mode)}
                        onPickImage={() => composerImageInputRef.current?.click()}
                        onAddScheduledMessage={
                          activeThread && window.eco
                            ? () => setScheduledMessageEditor({ threadId: activeThread.id })
                            : undefined
                        }
                        onOpenRoute={() => {
                          openComposerRoutePopover("plus");
                        }}
                        onOpenChange={(open) => {
                          setComposerPlusMenuOpen(open);
                          setComposerRoutePopoverOpen(false);
                          setScheduledMessageEditor(undefined);
                        }}
                      />
                      {composerRuntimeConfig &&
                      (composerRuntimeConfig.sessionMode === "plan" ||
                        composerRuntimeConfig.sessionMode === "ask") ? (
                        <ComposerSessionModeTag
                          mode={composerRuntimeConfig.sessionMode}
                          {...(canEditComposerConfig && !isSavingSettings
                            ? {
                                onClose: () => {
                                  void selectComposerSessionMode("agent");
                                },
                              }
                            : {})}
                        />
                      ) : null}
                      {composerRuntimeConfig ? (
                        <ComposerBashReviewToggle
                          bashReviewMode={composerRuntimeConfig.bashReviewMode}
                          canEdit={canEditBashReviewMode}
                          saving={isSavingSettings}
                          onToggle={(mode) => void toggleComposerBashReviewMode(mode)}
                        />
                      ) : null}
                    </div>
                    <div className="composer-footer-spacer" aria-hidden />
                    {renderComposerRouteControl()}
                    <input
                      ref={composerImageInputRef}
                      type="file"
                      accept="image/*"
                      multiple
                      className="composer-image-file-input"
                      tabIndex={-1}
                      aria-hidden
                      onChange={(event) => {
                        const files = event.target.files;
                        if (files && files.length > 0) {
                          void addComposerImageFiles(files);
                        }
                        event.target.value = "";
                      }}
                    />
                    <div className="composer-footer-actions">
                      {activeThread ? (
                        <ComposerThreadUsagePills
                          threadId={activeThread.id}
                          threadStatus={activeThread.status}
                          {...(threadUsageSummary && { usageSummary: threadUsageSummary })}
                          showBilling={workflowSettings.showBilling !== false}
                          {...(activeThread.hostUiFeatures && {
                            hostUiFeatures: activeThread.hostUiFeatures,
                          })}
                          contextCompactionInFlight={contextCompactionInFlight}
                          autoCompactSuspended={autoCompactSuspended}
                          promptCacheInvalidated={promptCacheInvalidated}
                          agentDisplayNames={activeRuntimeAgentDisplayNames}
                          agentThemes={activeRuntimeAgentThemes}
                          agentModelLabels={agentModelLabels}
                        />
                      ) : null}
                      {renderComposerModelControl()}
                      {asrComposerConfigured ? (
                        <AsrMicButton session={asrSession} disabled={composerDisabled} />
                      ) : null}
                      <button
                        type="button"
                        className={composerActionClassName}
                        onClick={() => {
                          if (composerActionMode === "stop") {
                            void requestStopThread();
                            return;
                          }
                          if (composerActionMode === "continue" && composerContinueTarget) {
                            void continueInterruptedCodexTurn(composerContinueTarget);
                            return;
                          }
                          void sendComposerMessage();
                        }}
                        disabled={composerActionDisabled}
                        title={composerActionLabel}
                        aria-label={composerActionLabel}
                      >
                        {composerActionBusy ? (
                          <LoaderCircle
                            size={COMPOSER_SEND_ICON_PX}
                            strokeWidth={ICON_STROKE}
                            className="spinning"
                          />
                        ) : composerActionMode === "stop" ? (
                          <Square size={COMPOSER_SEND_ICON_PX} strokeWidth={ICON_STROKE} />
                        ) : composerActionMode === "continue" ? (
                          <Play size={COMPOSER_SEND_ICON_PX} strokeWidth={ICON_STROKE} />
                        ) : composerActionMode === "queue" ? (
                          // Steer = 立即注入当前回合，与“发送”同义，复用发送图标；排队用折线入队图标。
                          composerFollowUpDeliveryMode === "steer" ? (
                            <ArrowUp size={COMPOSER_SEND_ICON_PX} strokeWidth={ICON_STROKE} />
                          ) : (
                            <CornerDownRight size={COMPOSER_SEND_ICON_PX} strokeWidth={ICON_STROKE} />
                          )
                        ) : (
                          <ArrowUp size={COMPOSER_SEND_ICON_PX} strokeWidth={ICON_STROKE} />
                        )}
                      </button>
                    </div>
                  </div>
                  {!composerRoutesReady &&
                  !composerFollowUpMode &&
                  composerModelAvailability !== "no-orchestration" && (
                    <p className="composer-hint">
                      {composerModelAvailability === "no-provider" ? (
                        <>
                          {t("composer.hint.noProviderPrefix")}{" "}
                          <button type="button" className="link-button" onClick={openProviderSettings}>
                            {t("settings.providers")}
                          </button>{" "}
                          {t("composer.hint.noProviderSuffix")}
                        </>
                      ) : (
                        <>
                          {t("composer.hint.fixOrchestrationPrefix")}{" "}
                          <button
                            type="button"
                            className="link-button"
                            disabled={!canOpenComposerRoute}
                            onClick={(event) => {
                              event.preventDefault();
                              event.stopPropagation();
                              openComposerRoutePopover("plus");
                            }}
                          >
                            {t("composer.hint.fixOrchestrationAction")}
                          </button>
                          {primaryOrchestrationIssue
                            ? t(orchestrationIssueDetailKey(primaryOrchestrationIssue), {
                                name:
                                  primaryOrchestrationIssue.mainAgentConfigName ||
                                  t("composer.route.mainAgent"),
                                orchestration:
                                  primaryOrchestrationIssue.orchestrationName ||
                                  t("composer.route.subagentOrchestration"),
                                agent: primaryOrchestrationIssue.agentKey
                                  ? t(`agent.role.${primaryOrchestrationIssue.agentKey}`, {
                                      defaultValue: primaryOrchestrationIssue.agentKey,
                                    })
                                  : "",
                                provider: primaryOrchestrationIssue.providerName,
                              })
                            : null}
                        </>
                      )}
                    </p>
                  )}
                </div>
              </div>
            )
          }
        />
      </div>
    </div>
  );

  const isMacWindowChrome = window.eco?.platform === "darwin";

  // Electron: sibling `no-drag` cannot punch another element's drag region.
  // Keep controls inside a dedicated drag root, and leave a chrome gap in the sidebar.
  // Windows uses WCO (titleBarOverlay); macOS uses hiddenInset; Linux keeps a native frame.
  const renderWindowSidebarToolbar = () => (
    <div className={isMacWindowChrome ? "macos-window-chrome-root" : "window-sidebar-chrome-root"}>
      <div className={isMacWindowChrome ? "macos-window-toolbar" : "window-sidebar-toolbar"}>
        <button
          type="button"
          className="codex-main-toolbar-button"
          onClick={() => setSidebarOpen((current) => !current)}
          title={sidebarOpen ? t("app.sidebarCollapse") : t("app.sidebarOpen")}
          aria-label={sidebarOpen ? t("app.sidebarCollapse") : t("app.sidebarOpen")}
          aria-expanded={sidebarOpen}
          aria-controls="primary-sidebar"
        >
          <PanelLeft size={15} aria-hidden />
        </button>
        {!sidebarOpen ? (
          <>
            <button
              type="button"
              className={
                sidebarSearchOpen ? "codex-main-toolbar-button is-active" : "codex-main-toolbar-button"
              }
              onClick={() => setSidebarSearchOpen((current) => !current)}
              title={t("nav.search")}
              aria-label={t("nav.search")}
              aria-expanded={sidebarSearchOpen}
              aria-haspopup="dialog"
            >
              <Search size={15} aria-hidden />
            </button>
            {activeThread ? (
              <button
                type="button"
                className="codex-main-toolbar-button is-narrow-new-thread"
                onClick={startNewChat}
                title={t("nav.newThread")}
                aria-label={t("nav.newThread")}
              >
                <MessageCirclePlus size={15} aria-hidden />
              </button>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );

  const renderAppLayout = () => (
    <main className={shellClassName}>
      {renderWindowSidebarToolbar()}
      {appMessageState ? (
        <AppMessage
          kind={appMessageState.kind}
          message={appMessageState.message}
          onDismiss={dismissAppMessage}
        />
      ) : null}
      <button
        type="button"
        className={["responsive-sidebar-backdrop", sidebarOpen ? "is-visible" : ""].filter(Boolean).join(" ")}
        onClick={() => setSidebarOpen(false)}
        aria-label={t("app.sidebarCollapse")}
        tabIndex={sidebarOpen ? 0 : -1}
        aria-hidden={!sidebarOpen}
      />
      <aside
        id="primary-sidebar"
        className="codex-sidebar"
        aria-hidden={!sidebarOpen || settingsOpen}
        inert={!sidebarOpen || settingsOpen ? true : undefined}
      >
        <div className="codex-sidebar-chrome" aria-hidden>
          <div className="codex-sidebar-chrome-drag" />
        </div>
        <div className="codex-sidebar-body-drag">
          <SidebarCoreSelector
            coreKind={activeThread ? activeThread.coreKind : newThreadCoreKind}
            locked={Boolean(activeThread)}
            busy={isStarting}
            codexAvailable={coreAvailability?.codex.available !== false}
            {...(coreAvailability?.codex.reason && {
              codexUnavailableReason: coreAvailability.codex.reason,
            })}
            {...(coreAvailability?.codex.version ? { codexVersion: coreAvailability.codex.version } : {})}
            piAvailable={coreAvailability?.pi.available !== false}
            {...(coreAvailability?.pi.reason && {
              piUnavailableReason: coreAvailability.pi.reason,
            })}
            {...(coreAvailability?.pi.version ? { piVersion: coreAvailability.pi.version } : {})}
            cursorAvailable={coreAvailability?.cursor.available === true}
            cursorProbeLoading={cursorProbeLoading || acpEnableInFlight}
            {...(coreAvailability?.cursor.reason && {
              cursorUnavailableReason: coreAvailability.cursor.reason,
            })}
            {...(coreAvailability?.cursor.version ? { cursorVersion: coreAvailability.cursor.version } : {})}
            {...(coreAvailability?.claude.version ? { claudeVersion: coreAvailability.claude.version } : {})}
            attentionItems={attentionItems}
            onChange={(coreKind) => {
              if (coreKind === "acp") {
                setNewThreadCoreKind("acp");
                void refreshCoreAvailability({ reportError: true });
                return;
              }
              setNewThreadCoreKind(coreKind);
            }}
            onOpenSearch={() => setSidebarSearchOpen(true)}
            onSelectAttentionThread={(threadId) => {
              const thread = threads.find((item) => item.id === threadId);
              if (thread) {
                selectSearchThread(thread);
              }
            }}
          />
          {/* "新对话" and "打开项目" read as one list; the list itself scrolls so the
              open-project row travels with the projects instead of staying pinned. */}
          <div className="sidebar-nav-list">
            <button type="button" className="sidebar-action" onClick={startNewChat}>
              <MessageCirclePlus size={ICON_SIZE.md} strokeWidth={ICON_STROKE} />
              {t("nav.newThread")}
            </button>
            <button type="button" className="sidebar-action muted" onClick={() => setSchedulingOpen(true)}>
              <Clock3 size={ICON_SIZE.md} strokeWidth={ICON_STROKE} />
              {t("scheduling.title")}
            </button>
            <div className="sidebar-section sidebar-section-grow">
              <button
                type="button"
                className="sidebar-action muted"
                onClick={openWorkspace}
                disabled={isOpening}
                onDragOver={handleOpenProjectRowDragOver}
                onDrop={handleOpenProjectRowDrop}
              >
                {isOpening ? (
                  <LoaderCircle
                    size={ICON_SIZE.md}
                    strokeWidth={ICON_STROKE}
                    className="spinning"
                    aria-hidden
                  />
                ) : (
                  <FolderOpen size={ICON_SIZE.md} strokeWidth={ICON_STROKE} />
                )}
                {isOpening ? t("nav.opening") : t("nav.openProject")}
              </button>
              <ProjectSidebarTree
                projectTree={projectTree}
                currentProjectPath={currentProjectPath}
                activeThreadId={selectedThreadId}
                revealTarget={sidebarRevealTarget}
                unreadThreadIds={unreadThreadIds}
                pinnedThreadIds={pinnedThreadIds}
                onSwitchProject={switchProject}
                onSelectThread={selectThread}
                onToggleProjectCollapsed={toggleProjectCollapsed}
                onExpandProjectThreads={expandProjectThreads}
                onReorderProjects={reorderProjects}
                onOpenProjectPath={handleOpenProjectFromDrop}
                onPinProject={pinProject}
                onUnpinProject={unpinProject}
                onRemoveProject={removeProject}
                onRenameProject={setCustomProjectName}
                onResetProjectName={(path) => setCustomProjectName(path, undefined)}
                customProjectNames={customProjectNames}
                onPinThread={pinThread}
                onUnpinThread={unpinThread}
                deletingThreadId={deletingThreadId}
                onDeleteThread={(thread) => void deleteThread(thread)}
                pendingBashApprovalThreadIds={new Set(Object.keys(pendingBashApprovalsByThread))}
                pendingPlanThreadIds={new Set(Object.keys(pendingPlansByThread))}
              />
            </div>
          </div>

          <div className="sidebar-settings">
            <button
              type="button"
              className="sidebar-settings-action"
              onClick={openSettings}
              aria-label={
                centerServerRegistered
                  ? `${sidebarCenterDeviceName} · ${sidebarCenterPresenceLabel} · ${t("nav.settings")}`
                  : t("nav.settings")
              }
              title={
                centerServerRegistered
                  ? `${sidebarCenterDeviceName} · ${sidebarCenterPresenceLabel}`
                  : t("nav.settings")
              }
            >
              <Cog size={ICON_SIZE.md} strokeWidth={ICON_STROKE} aria-hidden />
              {centerServerRegistered ? (
                <>
                  <span className="sidebar-settings-action-label">{sidebarCenterDeviceName}</span>
                  <span
                    className={`cs-dot cs-dot--${sidebarCenterPresenceDot} sidebar-settings-presence-dot`}
                    aria-hidden
                  />
                </>
              ) : (
                <span className="sidebar-settings-action-label">{t("nav.settings")}</span>
              )}
            </button>
            <SidebarSettingsUpdateControl
              state={desktopUpdateState}
              onCheck={() => {
                void window.eco?.checkDesktopForUpdates();
              }}
              onDownload={() => {
                void window.eco?.downloadDesktopUpdate();
              }}
              onInstall={() => {
                void window.eco?.installDesktopUpdate();
              }}
              onOpenRelease={() => {
                void window.eco?.openDesktopReleasePage();
              }}
            />
          </div>
        </div>
      </aside>

      <SidebarSearchDialog
        open={sidebarSearchOpen}
        threads={sidebarSearchThreads}
        projects={projects}
        scheduledMessages={scheduledMessages}
        schedulingError={scheduling.error}
        onClose={() => setSidebarSearchOpen(false)}
        onSelectThread={selectSearchThread}
        onSelectProject={selectSearchProject}
        onSelectScheduledMessage={(_message, thread) => {
          dismissTaskPanel();
          selectSearchThread(thread);
          setScheduledMessagesReveal({ threadId: thread.id, requestId: Date.now() });
        }}
      />

      <section
        className={[
          "codex-main",
          showLanding ? "codex-main-landing" : "",
          currentProjectPath ? "codex-main-has-toolbar" : "",
        ]
          .filter(Boolean)
          .join(" ")}
      >
        <div
          ref={mainPaneRef}
          className={[
            "codex-main-pane",
            showPanelChromeGroupB ? "has-panel-chrome" : "",
            chromeFsSlotOpen ? "is-chrome-fs-slot-open" : "",
            taskPanelLayoutOpen ? "is-task-panel-open" : "",
            taskPanelExiting ? "is-task-panel-exiting" : "",
            taskPanelFullscreenOpen ? "is-task-panel-fullscreen" : "",
            taskPanelPhase !== "closed" ? `is-task-phase-${taskPanelPhase}` : "",
            !showLanding && !activityFeedBootReady ? "is-booting" : "",
          ]
            .filter(Boolean)
            .join(" ")}
          aria-busy={!showLanding && !activityFeedBootReady}
          style={rightPanelStyle}
        >
          <div
            ref={activityWorkspaceRef}
            className={[
              "activity-workspace-shell",
              `is-${activityWorkspaceLayoutMode}`,
              workspaceCardsDockedLayout ? "has-docked-workspace-cards" : "",
            ]
              .filter(Boolean)
              .join(" ")}
          >
            <AnimatePresence>
              {imageGalleryOpen && imageGalleryQueue.length > 0 ? (
                <SuspensePanel>
                  <LazyImageGalleryFloat
                    key="image-gallery-float"
                    items={imageGalleryQueue}
                    avoidCards={Boolean(showWorkspacePanel && workspaceCardsPanelOpen)}
                    onAdvance={advanceImageGallery}
                    onCloseAll={closeImageGallery}
                  />
                </SuspensePanel>
              ) : null}
            </AnimatePresence>
            <div
              className={[
                "codex-main-scroll",
                showWorkspacePanel ? "has-workspace-panel" : "",
                workspaceCardsDockedLayout ? "is-workspace-cards-docked" : "",
                activityFeedPanelLayout ? "is-feed-panel-layout" : "",
                !showLanding && currentProjectPath && !topbarSolid ? "is-topbar-clear" : "",
                !showLanding && currentProjectPath && topbarSolid ? "is-topbar-solid" : "",
              ]
                .filter(Boolean)
                .join(" ")}
            >
              {currentProjectPath ? (
                <header
                  ref={topbarRef}
                  className={["codex-main-topbar", showLanding || topbarSolid ? "is-solid" : "is-clear"]
                    .filter(Boolean)
                    .join(" ")}
                >
                  {/* Keep the titlebar topology stable across landing and conversation states. */}
                  {activeThread ? (
                    <div className="activity-header">
                      <ActivityHeaderProjectInfo
                        projectName={
                          projects.find(
                            (item) =>
                              normalizeProjectPath(item.path) ===
                              normalizeProjectPath(activeThread.workspacePath),
                          )?.name ?? pathToName(activeThread.workspacePath)
                        }
                        projectPath={activeThread.workspacePath}
                        threadCount={
                          threadsByProject.get(normalizeProjectPath(activeThread.workspacePath))?.length ?? 0
                        }
                        threadId={activeThread.id}
                        {...(activeThread.coreKind === "acp" && activeThread.externalSessionId
                          ? { acpSessionId: activeThread.externalSessionId }
                          : {})}
                        onError={showAppMessageError}
                      />
                      <h2 title={activeThread.title}>{activeThread.title}</h2>
                      <ReadAloudControls
                        threadId={activeThread.id}
                        onOpenSettings={() => {
                          setSettingsSection("tts");
                          setSettingsOpen(true);
                        }}
                      />
                      {canRegenerateThreadTitle(
                        activeThread.title,
                        titleGeneratingThreadIds.has(activeThread.id),
                        activeThread.coreKind,
                      ) ? (
                        <button
                          type="button"
                          className="activity-header-regenerate-title"
                          title={t("thread.regenerateTitle")}
                          aria-label={t("thread.regenerateTitle")}
                          onClick={() => {
                            if (!window.eco) {
                              return;
                            }
                            void window.eco.regenerateThreadTitle(activeThread.id).catch((error) => {
                              showAppMessageError(
                                error instanceof Error ? error.message : t("thread.titleGenerationFailed"),
                              );
                            });
                          }}
                        >
                          <RefreshCw size={14} strokeWidth={2} aria-hidden />
                        </button>
                      ) : null}
                    </div>
                  ) : (
                    <div className="activity-header is-placeholder" aria-hidden>
                      <h2 />
                    </div>
                  )}
                  <div className="codex-main-topbar-drag-fill" aria-hidden />
                  {renderWorkspaceTopbarActions()}
                </header>
              ) : null}
              <div className="codex-main-left-column">
                <div ref={scrollBodyRef} className="codex-main-scroll-body">
                  <div
                    className={["codex-chat-shell", showLanding ? "is-landing" : "is-conversation"]
                      .filter(Boolean)
                      .join(" ")}
                    style={
                      {
                        "--composer-input-overlays-height": `${composerInputOverlaysHeight}px`,
                      } as CSSProperties
                    }
                  >
                    {showLanding ? (
                      <div className="codex-landing">
                        <div className="codex-landing-brand">
                          <img
                            className="codex-landing-logo"
                            src="./splash-icon.png"
                            alt=""
                            width={72}
                            height={72}
                          />
                          <h1 className="codex-hero">
                            {currentProjectPath
                              ? homeProjectPath && isHomeProjectPath(currentProjectPath, homeProjectPath)
                                ? t("app.landing.home")
                                : t("app.landing.project", { project: currentProjectName })
                              : t("app.landing.openProject")}
                          </h1>
                          {showProjectSkillsPanel && composerSupportsSkills ? (
                            <ComposerSkillsBar
                              availableSkills={projectCoreSkills}
                              skillsNeedingLink={projectAgentsOnly}
                              referencedSkillNames={referencedSkillNames}
                              linking={skillsLinking}
                              {...(skillsLinkResult && { lastLinkResult: skillsLinkResult })}
                              {...(composerCoreKind === "claude" && {
                                onLinkAgents: linkProjectAgentsSkills,
                              })}
                            />
                          ) : null}
                        </div>
                      </div>
                    ) : (
                      <div className="codex-feed-stack">
                        <div
                          className={["activity-feed", !activityFeedBootReady ? "is-booting" : ""]
                            .filter(Boolean)
                            .join(" ")}
                        >
                          <div className="activity-messages-shell">
                            <div className="activity-feed-top-mask" aria-hidden />
                            <ActivityUserMessageNavigator
                              items={activityUserMessageNavItems}
                              hidden={activityUserMessageNavHidden}
                              {...(activeActivityUserMessageNavId && {
                                activeId: activeActivityUserMessageNavId,
                              })}
                              onJump={jumpToActivityUserMessage}
                            />
                            <div
                              ref={activityMessagesRef}
                              className="activity-messages"
                              role="region"
                              aria-label={activeThread?.title}
                              // biome-ignore lint/a11y/noNoninteractiveTabindex: Scrollable history supports PageUp/PageDown and Home/End.
                              tabIndex={0}
                              aria-busy={!activityFeedBootReady}
                            >
                              {activityFeedBootReady ? (
                                <SuspensePanel>
                                  <ReadAloudThreadContext value={activeThread?.id ?? ""}>
                                  <OpenTtsArtifactContext value={openTtsArtifact}>
                                  <TtsArtifactsContext
                                    value={activeThread ? (ttsArtifactsByThread[activeThread.id] ?? []) : []}
                                  >
                                    <LazyActivityLogView
                                      {...(activeThread && { thread: activeThread })}
                                      {...(activeThread &&
                                        conversationV2ByThread[activeThread.id] && {
                                          conversationV2: conversationV2ByThread[activeThread.id],
                                        })}
                                      {...(v2RunProjection && { conversationV2Projection: v2RunProjection })}
                                      onRestorePrompt={restorePrompt}
                                      onLoadUserMessageEdit={activityLoadUserMessageEdit}
                                      onRewriteUserMessage={activityRewriteUserMessage}
                                      {...(activeThread &&
                                      activeThread.coreKind !== "acp"
                                        ? { onForkMessage: activityForkMessage }
                                        : {})}
                                      onRetryFailedRequest={activityRetryFailedRequest}
                                      onSwitchCodexAccount={openCodexAccountSwitch}
                                      onOpenChatGptSubscriptionAccounts={
                                        openChatGptSubscriptionAccounts
                                      }
                                      onPlannerLayoutChange={handleActivityPlannerLayoutChange}
                                      onComposerAgentSilenceChange={setComposerAgentSilenceVisible}
                                      onFeedEndAnchorChange={handleFeedEndAnchorChange}
                                      feedUserDetached={feedUserDetached}
                                      {...(Object.keys(activityModelByRole).length > 0 && {
                                        modelByRole: activityModelByRole,
                                      })}
                                      agentDisplayNames={activeRuntimeAgentDisplayNames}
                                      agentThemes={activeRuntimeAgentThemes}
                                      {...(taskDrawerOpen &&
                                        selectedSubagentAgentId && { selectedSubagentAgentId })}
                                      onOpenSubagent={openSubagentTaskDrawer}
                                      onOpenImageGenerationTool={openImageGenerationTool}
                                      onOpenImageDisplayTool={openImageDisplayTool}
                                      onOpenImageDisplayArtifact={openImageDisplayArtifact}
                                      thinkingDisplayMode={thinkingDisplayPreferences.mode}
                                      {...(activeSubagentTimings && {
                                        subagentTimings: activeSubagentTimings,
                                      })}
                                      {...(activeSubagentMetrics && {
                                        subagentMetrics: activeSubagentMetrics,
                                      })}
                                    />
                                  </TtsArtifactsContext>
                                  </OpenTtsArtifactContext>
                                  </ReadAloudThreadContext>
                                </SuspensePanel>
                              ) : null}
                              <div ref={activityEndRef} className="activity-scroll-anchor" aria-hidden />
                            </div>
                            {activityFeedScrollJump ? (
                              <button
                                type="button"
                                className="activity-feed-scroll-jump is-visible"
                                onClick={handleActivityFeedScrollJump}
                                aria-label={
                                  activityFeedScrollJump === "top"
                                    ? t("app.scrollTop")
                                    : t("app.scrollBottom")
                                }
                                title={
                                  activityFeedScrollJump === "top"
                                    ? t("app.scrollTop")
                                    : t("app.scrollBottom")
                                }
                              >
                                {activityFeedScrollJump === "top" ? (
                                  <ChevronUp size={18} />
                                ) : (
                                  <ChevronDown size={18} />
                                )}
                              </button>
                            ) : null}
                          </div>
                        </div>
                      </div>
                    )}
                    <AppRenderContent render={renderComposer} />
                  </div>
                </div>
                {Object.entries(terminalByProject).map(([workspacePath, terminalState]) => {
                  if (terminalState.tabs.length === 0) {
                    return null;
                  }
                  const isCurrentProject = workspacePath === currentProjectPath;
                  const workspaceLabel =
                    projects.find((item) => item.path === workspacePath)?.name ?? pathToName(workspacePath);
                  return (
                    <div
                      key={workspacePath}
                      className="codex-terminal-project-slot"
                      hidden={!isCurrentProject}
                    >
                      <SuspensePanel>
                        <LazyTerminalPanel
                          workspacePath={workspacePath}
                          workspaceLabel={workspaceLabel}
                          state={terminalState}
                          isCurrentProject={isCurrentProject}
                          onStateChange={(next) => updateProjectTerminal(workspacePath, next)}
                          onSessionExit={handleTerminalSessionExit}
                          sessionPresentations={terminalSessionPresentations}
                          {...(isCurrentProject && {
                            injectedSessionId: injectedTerminalSessionId,
                            onInjectedSessionConsumed: () => setInjectedTerminalSessionId(null),
                          })}
                        />
                      </SuspensePanel>
                    </div>
                  );
                })}
              </div>
            </div>
            {showWorkspacePanel ? (
              <aside
                ref={workspaceCardsPanelRef}
                id="workspace-cards-panel"
                className={[
                  "workspace-panel",
                  "workspace-panel--floating-cards",
                  workspaceCardsPanelOpen ? "is-open" : "",
                  workspaceCardsDockedLayout ? "is-docked" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                aria-label={t("app.workspacePanel")}
                aria-hidden={!workspaceCardsPanelOpen}
                style={
                  {
                    "--workspace-terminal-height": `${currentTerminalState?.open ? currentTerminalState.height : 0}px`,
                  } as CSSProperties
                }
              >
                <WorkspaceFloatingCards
                  codexBackgroundTerminals={codexBackgroundTerminalsForActiveThread}
                  {...(codexBackgroundTerminalError && {
                    codexBackgroundTerminalError,
                  })}
                  onStopCodexBackgroundTerminal={stopCodexBackgroundTerminal}
                  onCodexBackgroundTerminalError={(message) => showAppMessageErrorRef.current(message)}
                  claudeBackgroundTasks={claudeBackgroundTasksForActiveThread}
                  {...(claudeBackgroundTaskError && {
                    claudeBackgroundTaskError,
                  })}
                  onStopClaudeBackgroundTask={stopClaudeBackgroundTask}
                  onClaudeBackgroundTaskError={(message) => showAppMessageErrorRef.current(message)}
                  todos={activeThread ? coderTodos : []}
                  hasActiveThread={Boolean(activeThread)}
                  scheduledMessages={
                    activeThread ? scheduledMessages.filter((item) => item.threadId === activeThread.id) : []
                  }
                  scheduleOccurrences={scheduling.snapshot.occurrences}
                  schedulingError={scheduling.error}
                  scheduledMessagesRevealKey={`${activeThread?.id ?? ""}:${scheduledMessagesReveal?.requestId ?? 0}`}
                  onEditScheduledMessage={(definition) => {
                    if (activeThread) setScheduledMessageEditor({ threadId: activeThread.id, definition });
                  }}
                  onRefreshSchedules={scheduling.refresh}
                  onScheduledMessageActionError={(message) => showAppMessageErrorRef.current(message)}
                  agentModelLabels={activeThread?.coreKind === "acp" ? [] : agentModelLabels}
                  {...(activeThread?.coreKind === "acp" && cursorAgentsSnapshot
                    ? {
                        cursorAgentsRoster: {
                          agents: cursorAgentsSnapshot.agents,
                          builtins: cursorAgentsSnapshot.builtins,
                        },
                      }
                    : {})}
                  subagentRunCards={activeSubagentCards}
                  {...(selectedSubagentAgentId && { selectedSubagentAgentId })}
                  agentDisplayNames={activeRuntimeAgentDisplayNames}
                  agentThemes={activeRuntimeAgentThemes}
                  onOpenSubagent={openSubagentTaskDrawer}
                  {...(composerRuntimeConfig && { composerRuntimeConfig })}
                  subagentEnabled={defaultSubagentAvailability()}
                  canEditComposerConfig={canEditComposerConfig}
                  isSavingSettings={isSavingSettings}
                  mcpServers={mcpSettings.servers}
                  composerMcpSettings={composerMcpSettings}
                  integrationAvailability={integrationAvailability}
                  composerIntegrationSettings={composerIntegrationSettings}
                  skills={composerAvailableSkills}
                  composerSkillsEnabled={composerSkillsEnabled}
                  onToggleComposerSubagent={(role, enabled) => void toggleComposerSubagent(role, enabled)}
                  onToggleComposerMcpServer={(serverKey, enabled) =>
                    void toggleComposerMcpServer(serverKey, enabled)
                  }
                  onToggleComposerIntegration={(id, enabled) => void toggleComposerIntegration(id, enabled)}
                  onToggleComposerSkill={(settingsKey, enabled) =>
                    void toggleComposerSkill(settingsKey, enabled)
                  }
                  {...(approvedPlan && { approvedPlan })}
                  onOpenPlan={openPlanTaskDrawer}
                  onOpenBrowser={(browserId) => openBrowserTaskPanel(browserId)}
                  onCloseBrowser={(browserId) => {
                    void window.eco?.browserCloseInstance?.({ browserId });
                  }}
                  onCloseAllBrowsers={() => {
                    const instances = browserStateStore.getState()?.instances ?? [];
                    void Promise.all(
                      instances.map((instance) =>
                        window.eco?.browserCloseInstance?.({ browserId: instance.id }),
                      ),
                    );
                  }}
                  ttsArtifacts={activeThread ? (ttsArtifactsByThread[activeThread.id] ?? []) : []}
                  onOpenTtsArtifact={openTtsArtifact}
                  imageArtifacts={activeThread ? (imageArtifactsByThread[activeThread.id] ?? []) : []}
                  onOpenImageArtifact={openImageGenerationArtifact}
                  imageDisplayArtifacts={
                    activeThread ? (imageDisplayArtifactsByThread[activeThread.id] ?? []) : []
                  }
                  onOpenImageDisplayArtifact={openImageDisplayArtifact}
                  htmlHostArtifacts={activeThread ? (htmlHostArtifactsByThread[activeThread.id] ?? []) : []}
                  onOpenHtmlHostArtifact={openHtmlHostArtifact}
                  {...(projectWorkspace && { workspace: projectWorkspace })}
                  {...(currentProjectPath && { workspacePath: currentProjectPath })}
                  workspaceLabel={currentProjectName}
                  {...(gitStatus && { gitStatus })}
                  gitBusy={gitStatusBusy || gitStatusLoading}
                  onCheckoutGitBranch={handleGitCheckoutBranch}
                  onCreateGitBranch={handleGitCreateBranch}
                  onOpenGitSettings={openGitSettings}
                  {...(composerRuntimeConfig?.orchestrationSelection?.mainAgentConfigId && {
                    mainAgentConfigId: composerRuntimeConfig.orchestrationSelection.mainAgentConfigId,
                  })}
                  {...(composerRuntimeConfig?.auxiliaryModel?.candidateModelId && {
                    defaultCommitCandidateModelId: composerRuntimeConfig.auxiliaryModel.candidateModelId,
                  })}
                  gitSettings={gitSettings}
                  onSaveCommitModelPreference={saveCommitMessageModelPreference}
                  onCommitSuccess={() => void handleGitCommitSuccess()}
                  onPushSuccess={() => {
                    showAppMessageSuccessRef.current(t("git.pushSucceeded", { project: currentProjectName }));
                  }}
                  onCommitDialogOpenChange={handleCommitDialogOpenChange}
                  onOpenChangesReview={openReviewTaskDrawer}
                  onChangesDiffLoaded={(diff) => void handleChangesDiffLoaded(diff)}
                  onChangesDiffLoadingChange={handleChangesDiffLoadingChange}
                  onChangesDiffError={handleChangesDiffError}
                  onPullSuccess={() => void handleGitPullSuccess()}
                  onPullError={(message) => {
                    showAppMessageErrorRef.current(message);
                  }}
                  onResolveConflictsWithAgent={(conflictFiles) =>
                    void handleGitPullConflictsWithAgent(conflictFiles)
                  }
                  onRefreshGitStatus={(force = false) => refreshGitStatus(undefined, { force })}
                  {...(showPackageScriptsEntry && {
                    onOpenScriptsDialog: () => {
                      void refreshPackageScripts();
                      setScriptsDialogOpen(true);
                    },
                  })}
                />
              </aside>
            ) : null}
          </div>
          {taskPanelLayoutOpen ? renderTaskPanel() : null}
          <SuspensePanel>
            <LazyBrowserWebviewLayer />
          </SuspensePanel>
          {showPanelChromeGroupB ? renderPanelControlButtons() : null}
          {!showLanding && !activityFeedBootReady ? (
            <div
              className="codex-main-boot-loading"
              role="status"
              aria-live="polite"
              aria-label={t("feed.opening")}
            >
              <img
                className="codex-main-boot-loading-icon"
                src="./splash-icon.png"
                alt=""
                width={56}
                height={56}
              />
            </div>
          ) : null}
        </div>
      </section>

      {scriptsDialogOpen && currentProjectPath ? (
        <PackageScriptsDialog
          open={scriptsDialogOpen}
          workspacePath={currentProjectPath}
          {...(packageScripts?.packageName && { packageName: packageScripts.packageName })}
          packageManager={packageScripts?.packageManager ?? projectWorkspace?.packageManager ?? "npm"}
          scripts={packageScripts?.scripts ?? []}
          busy={scriptsBusy}
          argsRevision={packageScriptArgsRevision}
          centerServerSyncVisible={centerServerSyncVisible}
          onSyncDomain={syncCenterServerConfigDomain}
          onClose={() => setScriptsDialogOpen(false)}
          onRun={startPackageScript}
          onRefresh={refreshPackageScripts}
        />
      ) : null}

      {schedulingOpen && window.eco && (
        <SuspensePanel>
          <LazySchedulingPanel
            settings={settings}
            workflow={workflowSettings}
            snapshot={scheduling.snapshot}
            loading={scheduling.loading}
            loadError={scheduling.error}
            onRefresh={scheduling.refresh}
            workspacePath={currentProjectPath}
            projects={projects}
            defaultProfile={
              composerRuntimeConfig
                ? { coreKind: composerCoreKind, runtimeConfig: composerRuntimeConfig }
                : undefined
            }
            onClose={() => setSchedulingOpen(false)}
            onOpenThread={(id) => {
              void window
                .eco!.getThread(id)
                .then((thread) => {
                  if (!thread) throw new Error(t("scheduling.threadMissing"));
                  selectThread(thread);
                  setSchedulingOpen(false);
                })
                .catch((caught) => setError(errorMessage(caught)));
            }}
          />
        </SuspensePanel>
      )}
      {scheduledMessageEditor &&
        window.eco &&
        threads.find((thread) => thread.id === scheduledMessageEditor.threadId) && (
          <SuspensePanel>
            <LazyScheduledMessageDialog
              key={scheduledMessageEditor.definition?.id ?? scheduledMessageEditor.threadId}
              thread={threads.find((thread) => thread.id === scheduledMessageEditor.threadId)!}
              definition={scheduledMessageEditor.definition}
              anchorRef={scheduledMessageEditor.threadId === activeThread?.id ? composerAnchorRef : undefined}
              triggerRef={composerPlusButtonRef}
              onBack={() => { setScheduledMessageEditor(undefined); setComposerPlusMenuOpen(true); }}
              occurrences={scheduling.snapshot.occurrences}
              onClose={() => setScheduledMessageEditor(undefined)}
              onSaved={() => {
                dismissTaskPanel();
                void scheduling.refresh();
                setScheduledMessagesReveal({
                  threadId: scheduledMessageEditor.threadId,
                  requestId: Date.now(),
                });
                setScheduledMessageEditor(undefined);
                if (scheduledMessageEditor.threadId === activeThread?.id) setComposerPlusMenuOpen(true);
              }}
            />
          </SuspensePanel>
        )}
      {codexAccountSwitchOpen && (
        <SuspensePanel>
          <LazyCodexAccountSwitchDialog onClose={closeCodexAccountSwitch} />
        </SuspensePanel>
      )}
      {settingsOpen && (
        <div className="settings-page" role="dialog" aria-modal="true" aria-label={t("settings.dialog")}>
          <aside className="settings-nav">
            <button
              type="button"
              className="settings-nav-back"
              onClick={() => {
                setSettingsOpen(false);
                setSettingsSearch("");
              }}
            >
              <ChevronLeft size={18} />
              {t("settings.back")}
            </button>

            <div className="settings-nav-search">
              <Search size={15} className="settings-nav-search-icon" aria-hidden />
              <input
                type="search"
                className="settings-nav-search-input"
                placeholder={t("settings.searchPlaceholder")}
                value={settingsSearch}
                onChange={(event) => setSettingsSearch(event.target.value)}
                aria-label={t("settings.search")}
              />
            </div>

            <nav className="settings-nav-groups" aria-label={t("settings.categories")}>
              {settingsNavGroups
                .map((group) => ({
                  ...group,
                  sections: group.sections.filter((section) => {
                    const query = settingsSearch.trim().toLowerCase();
                    if (!query) {
                      return true;
                    }
                    return (
                      section.label.toLowerCase().includes(query) ||
                      group.label.toLowerCase().includes(query) ||
                      section.keywords?.some((keyword) => keyword.toLowerCase().includes(query))
                    );
                  }),
                }))
                .filter((group) => group.sections.length > 0)
                .map((group) => (
                  <div key={group.label} className="settings-nav-group">
                    <span className="settings-nav-group-label">{group.label}</span>
                    {group.sections.map((section) => {
                      const Icon = section.icon;
                      return (
                        <button
                          key={section.id}
                          type="button"
                          className={
                            settingsSection === section.id ? "settings-nav-item active" : "settings-nav-item"
                          }
                          onClick={() => setSettingsSection(section.id)}
                        >
                          <Icon size={16} />
                          {section.label}
                        </button>
                      );
                    })}
                  </div>
                ))}
            </nav>
          </aside>

          <div className="settings-main">
            <div className={settingsSection === "mcp" ? "settings-content is-wide" : "settings-content"}>
              <SuspensePanel>
                {settingsSection === "preferences" && (
                  <LazyNotificationPreferencesPanel
                    settings={notificationSettings}
                    onSave={saveNotificationSettingsSnapshot}
                    localePreference={localePreference}
                    onLocalePreferenceChange={setLocalePreference}
                    cacheBreakTipsEnabled={promptCacheTipPreferences.enabled}
                    onCacheBreakTipsEnabledChange={(enabled) => setPromptCacheTipPreferences({ enabled })}
                    followUpDeliveryMode={workflowSettings.followUpDeliveryMode ?? "steer"}
                    onFollowUpDeliveryModeChange={saveFollowUpDeliveryMode}
                    defaultBashReviewMode={normalizeBashReviewMode(workflowSettings.defaultBashReviewMode)}
                    onDefaultBashReviewModeChange={saveDefaultBashReviewMode}
                    showBilling={workflowSettings.showBilling !== false}
                    onShowBillingChange={saveShowBilling}
                    tokenSpeedMode={tokenSpeedPreferences.mode}
                    onTokenSpeedModeChange={(mode) => setTokenSpeedPreferences({ mode })}
                    thinkingDisplayMode={thinkingDisplayPreferences.mode}
                    onThinkingDisplayModeChange={(mode) => {
                      startTransition(() => {
                        setThinkingDisplayPreferences({ mode });
                      });
                    }}
                  />
                )}

                {settingsSection === "general" && (
                  <LazyGeneralSettingsPanel
                    theme={appTheme}
                    onThemeChange={setAppTheme}
                    typography={typographyPreferences}
                    onTypographyChange={setTypographyPreferences}
                  />
                )}

                {settingsSection === "personalization" && (
                  <LazyPersonalizationSettingsPanel
                    settings={personalizationSettings}
                    onSave={savePersonalizationSettingsSnapshot}
                    centerServerSyncVisible={centerServerSyncVisible}
                    onSyncDomain={syncCenterServerConfigDomain}
                  />
                )}

                {settingsSection === "storage" && <LazyStorageSettingsPanel />}

                {settingsSection === "browser" && (
                  <LazyBrowserSettingsPanel settings={browserSettings} onSave={saveBrowserSettingsSnapshot} />
                )}

                {settingsSection === "computerUse" &&
                  (() => {
                    const computerUseAvailability = integrationAvailability.integrations.find(
                      (item) => item.id === "computerUse",
                    );
                    return (
                      <LazyComputerUseSettingsPanel
                        settings={computerUseSettings}
                        {...(computerUseAvailability ? { availability: computerUseAvailability } : {})}
                        onSave={saveComputerUseSettingsSnapshot}
                        onRunDoctor={runComputerUseDoctor}
                        onCheckPermissionStatus={checkComputerUsePermissionStatus}
                      />
                    );
                  })()}

                {settingsSection === "tts" && (
                  <LazyTtsSettingsPanel
                    settings={ttsSettings}
                    onError={setError}
                    onChange={(snapshot) => {
                      setTtsSettings(snapshot);
                      void window.eco?.getIntegrationAvailability().then(setIntegrationAvailability);
                    }}
                  />
                )}

                {settingsSection === "imageGeneration" && (
                  <LazyImageGenerationSettingsPanel
                    settings={imageGenerationSettings}
                    onChange={(snapshot) => {
                      setImageGenerationSettings(snapshot);
                      void window.eco?.getIntegrationAvailability().then(setIntegrationAvailability);
                    }}
                    onError={setError}
                    centerServerSyncVisible={centerServerSyncVisible}
                    onSyncDomain={syncCenterServerConfigDomain}
                  />
                )}

                {settingsSection === "skills" && (
                  <LazySkillsSettingsPanel
                    {...(skillsSnapshot && { snapshot: skillsSnapshot })}
                    loading={isLoadingSkills}
                    onRefresh={() => void refreshSkillsList()}
                    onUninstall={uninstallSkill}
                    onLoadCatalogLeaderboard={loadSkillsCatalogLeaderboard}
                    onSearchCatalog={searchSkillsCatalog}
                    onInstallCatalog={installCatalogSkill}
                  />
                )}

                {settingsSection === "defaultAgent" && (
                  <LazyDefaultAgentSettingsPanel
                    defaultCoreKind={workflowSettings.defaultCoreKind ?? "claude"}
                    codexAvailable={coreAvailability?.codex.available !== false}
                    {...(coreAvailability?.codex.reason && {
                      codexUnavailableReason: coreAvailability.codex.reason,
                    })}
                    piAvailable={coreAvailability?.pi.available !== false}
                    {...(coreAvailability?.pi.reason && {
                      piUnavailableReason: coreAvailability.pi.reason,
                    })}
                    cursorAvailable={coreAvailability?.cursor.available === true}
                    {...(coreAvailability?.cursor.reason && {
                      cursorUnavailableReason: coreAvailability.cursor.reason,
                    })}
                    cursorProbeLoading={cursorProbeLoading || acpEnableInFlight}
                    busy={isSavingSettings}
                    onChange={(coreKind) => {
                      if (coreKind === "acp") {
                        void (async () => {
                          setAcpEnableInFlight(true);
                          try {
                            const availability = await refreshCoreAvailability({ reportError: true });
                            if (availability?.cursor.available !== true) {
                              return;
                            }
                            await saveDefaultCoreKind("acp");
                          } finally {
                            setAcpEnableInFlight(false);
                          }
                        })();
                        return;
                      }
                      void saveDefaultCoreKind(coreKind);
                    }}
                    acpCursorModelId={workflowSettings.acpCursorModelId}
                    acpCursorApiKey={workflowSettings.acpCursorApiKey}
                    cursorModels={cursorModels}
                    cursorModelsLoading={cursorModelsLoading}
                    {...(cursorModelsError && { cursorModelsError })}
                    onAcpCursorModelChange={(modelId) => void saveAcpCursorModelId(modelId)}
                    onAcpCursorApiKeyChange={(apiKey) => void saveAcpCursorApiKey(apiKey)}
                    onRefreshCursorModels={refreshCursorModels}
                    centerServerSyncVisible={centerServerSyncVisible}
                    onSyncDomain={syncCenterServerConfigDomain}
                  />
                )}

                {settingsSection === "contextWindow" && (
                  <LazyContextWindowSettingsPanel
                    contextWindowLimitTokens={workflowSettings.contextWindowLimitTokens}
                    maxOutputLimitTokens={workflowSettings.maxOutputLimitTokens}
                    onChangeContextWindow={saveContextWindowLimit}
                    onChangeMaxOutput={saveMaxOutputLimit}
                  />
                )}

                {settingsSection === "mcp" && (
                  <LazyMcpSettingsPanel
                    servers={mcpSettings.servers}
                    busy={isSavingSettings}
                    onSave={saveMcpServer}
                    onDelete={deleteMcpServer}
                    onCheck={checkMcpServer}
                  />
                )}

                {settingsSection === "centerServer" && (
                  <LazyCenterServerSettingsPanel
                    snapshot={centerServerSettings}
                    busy={isSavingSettings}
                    onSave={saveCenterServerSettings}
                    onTestConnection={testCenterServerConnection}
                    onSignUp={signUpCenterServer}
                    onSignIn={signInCenterServer}
                    onCreatePairing={createCenterServerPairing}
                    onListBindings={listCenterServerBindings}
                    onListPresence={listCenterServerPresence}
                    onRevokeBinding={revokeCenterServerBinding}
                    onConnect={connectCenterServer}
                    onDisconnect={disconnectCenterServer}
                    onRemoveConnection={removeCenterServerConnection}
                    onGetVaultStatus={getCenterServerVaultStatus}
                    onGetSyncStatus={getCenterServerSyncStatus}
                    onUnlockVaultWithPassword={unlockCenterServerVaultWithPassword}
                    onWrapVaultWithPassword={wrapCenterServerVaultWithPassword}
                    onRequestVaultClaim={requestCenterServerVaultClaim}
                    onListPendingVaultClaims={listCenterServerPendingVaultClaims}
                    onApproveVaultClaim={approveCenterServerVaultClaim}
                    onSubmitVaultClaimCode={submitCenterServerVaultClaimCode}
                    onCancelVaultClaim={cancelCenterServerVaultClaim}
                    ecoConnectLink={ecoConnectLink}
                    onEcoConnectLinkDismiss={() => setEcoConnectLink(undefined)}
                  />
                )}

                {settingsSection === "asr" && (
                  <LazyAsrSettingsPanel
                    snapshot={asrProfiles}
                    busy={asrBusy}
                    {...(asrSettingsLoadError !== undefined ? { loadError: asrSettingsLoadError } : {})}
                    onSave={saveAsrProfile}
                    onDelete={deleteAsrProfile}
                    onActivate={activateAsrProfile}
                    onInputDeviceChange={saveAsrInputDevice}
                    centerServerSyncVisible={centerServerSyncVisible}
                    onSyncDomain={syncCenterServerConfigDomain}
                  />
                )}

                {settingsSection === "integratedWebSearch" &&
                  (integratedWebSearchSettings ? (
                    <LazyIntegratedWebSearchSettingsPanel
                      settings={integratedWebSearchSettings}
                      busy={isSavingIntegratedWebSearchSettings}
                      onSave={(next) => void saveIntegratedWebSearchSettings(next)}
                      centerServerSyncVisible={centerServerSyncVisible}
                      onSyncDomain={syncCenterServerConfigDomain}
                    />
                  ) : (
                    <p className="settings-empty-hint">{t("settings.integratedWebSearch.loading")}</p>
                  ))}

                {settingsSection === "providers" && (
                  <LazyModelsSettingsPanel
                    settings={settings}
                    mode="providerSettings"
                    busy={isSavingSettings}
                    onSettingsChange={setSettings}
                    onSavingChange={setIsSavingSettings}
                    onRequestCreateMainAgentConfig={(seed) => {
                      setPendingCreateMainConfig(seed);
                      setSettingsSection("orchestrationComponents");
                    }}
                    centerServerSyncVisible={centerServerSyncVisible}
                    onSyncDomain={syncCenterServerConfigDomain}
                  />
                )}

                {settingsSection === "proxy" &&
                  (proxyBridgeSettings ? (
                    <LazyProxySettingsPanel
                      settings={proxyBridgeSettings}
                      busy={isSavingProxyBridgeSettings}
                      onSave={(next) => {
                        const merged: ProxyBridgeSettingsSnapshot = { ...(proxyBridgeSettings ?? {}) };
                        // 缺省视为开启（兼容旧数据）；未携带该键表示本次保存不修改开关。
                        if (next.enabled !== undefined) {
                          merged.enabled = next.enabled;
                        }
                        // 键存在与否表示是否修改：关闭开关时保留已保存 URL。
                        if (next.upstreamProxyUrl !== undefined) {
                          if (next.upstreamProxyUrl) {
                            merged.upstreamProxyUrl = next.upstreamProxyUrl;
                          } else {
                            delete merged.upstreamProxyUrl;
                          }
                        }
                        // 按 Harness 单独覆盖：空串 = 清除该 core，回退到 SDK 自己的 UA。
                        if (next.upstreamUserAgents !== undefined) {
                          const perCore: Partial<Record<UpstreamAgentCore, string>> = {};
                          for (const core of UPSTREAM_AGENT_CORES) {
                            const value = next.upstreamUserAgents[core]?.trim();
                            if (value) {
                              perCore[core] = value;
                            }
                          }
                          if (Object.keys(perCore).length > 0) {
                            merged.upstreamUserAgents = perCore;
                          } else {
                            delete merged.upstreamUserAgents;
                          }
                        }
                        // 空串 = 清除已保存的兼底请求头。
                        if (next.upstreamUserAgent !== undefined) {
                          if (next.upstreamUserAgent) {
                            merged.upstreamUserAgent = next.upstreamUserAgent;
                          } else {
                            delete merged.upstreamUserAgent;
                          }
                        }
                        void saveProxyBridgeSettings(merged);
                      }}
                      centerServerSyncVisible={centerServerSyncVisible}
                      onSyncDomain={syncCenterServerConfigDomain}
                    />
                  ) : (
                    <p className="settings-empty-hint">{t("settings.gateway.loading")}</p>
                  ))}

                {(settingsSection === "agentLibrary" || settingsSection === "orchestrationComponents") &&
                  (proxyBridgeSettings ? (
                    <LazyModelsSettingsPanel
                      settings={settings}
                      mcpServers={mcpSettings.servers}
                      skillsSnapshot={skillsSnapshot}
                      initialTab={
                        settingsSection === "orchestrationComponents"
                          ? "compositionParts"
                          : modelsSettingsTab
                      }
                      {...(modelsSettingsChatGptAccountId && {
                        initialChatGptAccountId: modelsSettingsChatGptAccountId,
                      })}
                      onInitialChatGptAccountHandled={() =>
                        setModelsSettingsChatGptAccountId(undefined)
                      }
                      mode="agentBuilder"
                      hideCategoryTabs
                      heading={
                        settingsSection === "orchestrationComponents"
                          ? t("settings.orchestrationComponents")
                          : t("settings.agentLibrary")
                      }
                      busy={isSavingSettings}
                      {...(effectiveDefaultOrchestrationSelection && {
                        defaultOrchestrationSelection: effectiveDefaultOrchestrationSelection,
                      })}
                      {...(workflowSettings.defaultAuxiliaryModel && {
                        defaultAuxiliaryModel: workflowSettings.defaultAuxiliaryModel,
                      })}
                      {...(workflowSettings.defaultApprovalModel && {
                        defaultApprovalModel: workflowSettings.defaultApprovalModel,
                      })}
                      {...(workflowSettings.defaultVisionModel && {
                        defaultVisionModel: workflowSettings.defaultVisionModel,
                      })}
                      {...(pendingCreateMainConfig ? { pendingCreateMainConfig } : {})}
                      onPendingCreateMainConfigConsumed={() => setPendingCreateMainConfig(undefined)}
                      onSettingsChange={setSettings}
                      onSavingChange={setIsSavingSettings}
                      onDefaultOrchestrationSelectionChange={(selection) =>
                        void saveDefaultOrchestrationSelection(selection)
                      }
                      onDefaultAuxiliaryModelChange={(selection) => void saveDefaultAuxiliaryModel(selection)}
                      onDefaultApprovalModelChange={(selection) => void saveDefaultApprovalModel(selection)}
                      onDefaultVisionModelChange={(selection) => void saveDefaultVisionModel(selection)}
                      {...(settingsSection === "orchestrationComponents" || settingsSection === "agentLibrary"
                        ? {
                            centerServerSyncVisible,
                            onSyncDomain: syncCenterServerConfigDomain,
                          }
                        : {})}
                    />
                  ) : (
                    <p className="settings-empty-hint">{t("settings.loadingModels")}</p>
                  ))}

                {settingsSection === "git" && (
                  <LazyGitSettingsPanel
                    settings={gitSettings}
                    onSave={saveGitSettingsSnapshot}
                    centerServerSyncVisible={centerServerSyncVisible}
                    onSyncDomain={syncCenterServerConfigDomain}
                  />
                )}
              </SuspensePanel>
            </div>
          </div>
        </div>
      )}
    </main>
  );
  return <><AppRenderContent render={renderAppLayout} /><BrowserSelectionPreview /></>;
}

async function loadConversationV2RendererState(
  conversationId: string,
): Promise<ConversationV2RendererState | undefined> {
  const api = window.eco;
  if (
    !api ||
    typeof api.conversationV2Bootstrap !== "function" ||
    typeof api.conversationV2Projection !== "function"
  ) {
    return undefined;
  }
  const capabilities = await api.conversationV2Capabilities();
  if (
    capabilities.protocolVersion !== 2 ||
    capabilities.eventSchemaVersion !== 1 ||
    capabilities.effectVersion !== 1 ||
    !Number.isSafeInteger(capabilities.maxEvents) ||
    capabilities.maxEvents <= 0 ||
    !Number.isSafeInteger(capabilities.maxBytes) ||
    capabilities.maxBytes <= 0 ||
    typeof capabilities.storeEpoch !== "string" ||
    !capabilities.storeEpoch.trim()
  ) {
    throw new Error("Conversation V2 renderer capabilities are unsupported.");
  }
  const bootstrap = await api.conversationV2Bootstrap(conversationId, {
    pageSize: 60,
    maxBytes: capabilities.maxBytes,
  });
  if (
    bootstrap.protocolVersion !== 2 ||
    bootstrap.conversationId !== conversationId ||
    bootstrap.storeEpoch !== capabilities.storeEpoch
  ) {
    throw new Error("Conversation V2 renderer bootstrap belongs to another stream.");
  }
  let state = installConversationV2Bootstrap(bootstrap);
  const syncThrough = (current: ConversationV2RendererState, throughSeq: number) =>
    catchUpConversationV2RendererState(
      current,
      throughSeq,
      (afterSeq, requestedThroughSeq) =>
        api.conversationV2Sync({
          conversationId,
          storeEpoch: current.storeEpoch,
          afterSeq,
          throughSeq: requestedThroughSeq,
          maxEvents: capabilities.maxEvents,
          maxBytes: capabilities.maxBytes,
        }),
      capabilities.maxEvents,
    );
  while (true) {
    const head = await api.conversationV2Head(conversationId);
    if (
      head.protocolVersion !== 2 ||
      head.conversationId !== conversationId ||
      head.storeEpoch !== state.storeEpoch ||
      !Number.isSafeInteger(head.lastSeq) ||
      !Number.isSafeInteger(head.historyRevision) ||
      head.lastSeq < 0 ||
      head.historyRevision < 0 ||
      head.lastSeq < state.appliedSeq ||
      head.historyRevision < state.historyRevision
    ) {
      throw new Error("Conversation V2 renderer head changed during recovery.");
    }
    if (head.lastSeq <= state.appliedSeq) {
      break;
    }
    state = await syncThrough(state, head.lastSeq);
    if (state.appliedSeq < head.lastSeq) {
      throw new Error("Conversation V2 renderer did not close the sync range.");
    }
  }
  state = await loadConversationV2OlderHistory(
    api,
    state,
    conversationId,
    capabilities.maxBytes,
    syncThrough,
  );
  state = await loadConversationV2ToolSummaries(
    api,
    state,
    conversationId,
    capabilities.maxBytes,
    syncThrough,
  );
  const projectionExtras = await api.conversationV2Projection(conversationId);
  return installConversationV2ProjectionExtras(state, projectionExtras);
}

function conversationV2TodosToCoderTodos(state: ConversationV2RendererState): CoderTodoItem[] {
  const todos: ConversationTodo[] = [...state.todos.values()];
  return todos
    .sort((left, right) => left.position - right.position || left.todoId.localeCompare(right.todoId))
    .map((todo) => ({
      id: todo.todoId,
      threadId: todo.conversationId,
      title: todo.title,
      detail: todo.detail,
      status: todo.status,
      position: todo.position,
      updatedAt: todo.updatedAt,
    }));
}

/** Messages per older-history page. The Feed holds the whole conversation, not one window. */
const CONVERSATION_V2_HISTORY_PAGE_SIZE = 100;

/**
 * Reads the conversation's history backwards until the client holds all of it.
 *
 * `bootstrap()` answers with the newest window and a cursor for the rest. Stopping there
 * leaves a migrated conversation's older turns — their messages, runs and tool calls — out
 * of the Feed entirely: the reader sees the last page of a long conversation as if the rest
 * had never been recorded. The legacy chain it replaces loaded the whole event log, so the
 * V2 read side has to hand over the same history before it can own the Feed.
 */
async function loadConversationV2OlderHistory(
  api: NonNullable<Window["eco"]>,
  initial: ConversationV2RendererState,
  conversationId: string,
  maxBytes: number,
  syncThrough: (
    state: ConversationV2RendererState,
    throughSeq: number,
  ) => Promise<ConversationV2RendererState>,
): Promise<ConversationV2RendererState> {
  let state = initial;
  const seenCursors = new Set<string>();
  while (state.hasOlder) {
    const cursor = state.olderCursor;
    if (!cursor || seenCursors.has(cursor)) {
      // A store that keeps answering with the same cursor would page forever; the client
      // cannot invent a cursor to escape it, so the read fails loudly instead of hanging.
      throw new Error("Conversation V2 renderer history page repeated its cursor.");
    }
    seenCursors.add(cursor);
    const page = await api.conversationV2MessagesPage(conversationId, {
      beforeCursor: cursor,
      limit: CONVERSATION_V2_HISTORY_PAGE_SIZE,
      maxBytes,
    });
    state = await syncThrough(state, page.readSeq);
    state = mergeConversationV2OlderPage(state, page);
  }
  return state;
}

/**
 * Tool summaries are paged independently from messages. Follow each run's
 * opaque cursor so the V2 Feed still contains every durable tool row without
 * making bootstrap carry an unbounded response.
 */
async function loadConversationV2ToolSummaries(
  api: NonNullable<Window["eco"]>,
  initial: ConversationV2RendererState,
  conversationId: string,
  maxBytes: number,
  syncThrough: (
    state: ConversationV2RendererState,
    throughSeq: number,
  ) => Promise<ConversationV2RendererState>,
): Promise<ConversationV2RendererState> {
  if (typeof api.conversationV2ToolsPage !== "function") {
    throw new Error("Conversation V2 tool-summary paging is unavailable.");
  }
  let state = initial;
  // A migrated store can retain a durable tool row whose run read model is
  // absent (for example after a partial legacy repair). Bootstrap still
  // returns that orphan row, so page by the union of known runs and tool run
  // ids instead of silently dropping the rest of an orphan run's pages.
  const runIds = conversationV2ToolRunIdsForHydration(state);
  for (const runId of runIds) {
    let cursor: string | undefined;
    const seenCursors = new Set<string>();
    while (true) {
      const page = await api.conversationV2ToolsPage(conversationId, runId, {
        ...(cursor ? { cursor } : {}),
        limit: 100,
        maxBytes,
      });
      state = await syncThrough(state, page.readSeq);
      state = mergeConversationV2ToolPage(state, page);
      if (!page.hasMore) break;
      const nextCursor = page.nextCursor?.trim();
      if (!nextCursor || seenCursors.has(nextCursor)) {
        throw new Error(`Conversation V2 tool-summary page repeated its cursor for run ${runId}.`);
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }
  }
  return state;
}

async function verifyConversationV2DuplicateEffect(
  conversationId: string,
  state: ConversationV2RendererState,
  effect: ConversationSyncEffect,
): Promise<void> {
  const api = window.eco;
  if (!api) {
    throw new Error("Conversation V2 renderer API is unavailable.");
  }
  const page = await api.conversationV2Sync({
    conversationId,
    storeEpoch: state.storeEpoch,
    afterSeq: effect.seq - 1,
    throughSeq: effect.seq,
    maxEvents: 1,
    maxBytes: 512 * 1024,
  });
  const authoritative = page.effects.find((candidate) => candidate.seq === effect.seq);
  if (
    page.protocolVersion !== 2 ||
    page.conversationId !== conversationId ||
    page.storeEpoch !== state.storeEpoch ||
    !authoritative ||
    authoritative.effectHash !== effect.effectHash
  ) {
    throw new Error(`Conversation V2 renderer duplicate verification failed at sequence ${effect.seq}.`);
  }
}

function readConversationV2SyncEvent(
  event: unknown,
): { conversationId: string; storeEpoch: string; effect: ConversationSyncEffect } | undefined {
  if (typeof event !== "object" || event === null) {
    return undefined;
  }
  const candidate = event as {
    conversationId?: unknown;
    storeEpoch?: unknown;
    effect?: unknown;
  };
  if (
    typeof candidate.conversationId !== "string" ||
    typeof candidate.storeEpoch !== "string" ||
    !candidate.conversationId.trim() ||
    !candidate.storeEpoch.trim() ||
    typeof candidate.effect !== "object" ||
    candidate.effect === null
  ) {
    return undefined;
  }
  const effect = candidate.effect as Partial<ConversationSyncEffect>;
  if (
    typeof effect.seq !== "number" ||
    !Number.isInteger(effect.seq) ||
    effect.seq <= 0 ||
    effect.effectVersion !== 1 ||
    typeof effect.effectHash !== "string" ||
    typeof effect.effect !== "object" ||
    effect.effect === null
  ) {
    return undefined;
  }
  return {
    conversationId: candidate.conversationId,
    storeEpoch: candidate.storeEpoch,
    effect: effect as ConversationSyncEffect,
  };
}

function isThreadLiveEvent(event: unknown): event is ThreadLiveEvent {
  if (typeof event !== "object" || event === null) {
    return false;
  }
  const candidate = event as ThreadLiveEvent;
  return typeof candidate.threadId === "string" && typeof candidate.message === "string";
}

function FollowUpQueuePanel({
  followUps,
  editingFollowUpId,
  queuePaused,
  pauseBusy,
  cancelBusyId,
  escalateBusyId,
  allowEscalate = true,
  onCancel,
  onEscalate,
  onEdit,
  onReorder,
  onTogglePause,
}: {
  followUps: ThreadPendingFollowUp[];
  editingFollowUpId: string | undefined;
  queuePaused: boolean;
  pauseBusy: boolean;
  cancelBusyId: string | undefined;
  escalateBusyId: string | undefined;
  allowEscalate?: boolean;
  onCancel: (followUp: ThreadPendingFollowUp) => void;
  onEscalate: (followUp: ThreadPendingFollowUp) => void;
  onEdit: (followUp: ThreadPendingFollowUp) => void;
  onReorder: (followUpIds: string[]) => void;
  onTogglePause: (paused: boolean) => void;
}) {
  const { t } = useTranslation();
  const [draggedId, setDraggedId] = useState<string>();
  const editingPaused = Boolean(editingFollowUpId);
  const showPauseHint = queuePaused || editingPaused;
  const pauseHint = editingPaused
    ? t("thread.followUpQueuePausedEditing")
    : queuePaused
      ? t("thread.followUpQueuePaused")
      : null;

  const moveDraggedBefore = (targetId: string) => {
    if (!draggedId || draggedId === targetId || draggedId === editingFollowUpId) return;
    const next = followUps.map((followUp) => followUp.id);
    const from = next.indexOf(draggedId);
    const to = next.indexOf(targetId);
    if (from < 0 || to < 0) return;
    next.splice(to, 0, next.splice(from, 1)[0]!);
    onReorder(next);
  };
  return (
    <div className="follow-up-queue" aria-label={t("app.queuedGuidance")}>
      <div className="follow-up-queue-header">
        {showPauseHint && pauseHint ? (
          <div className="follow-up-queue-pause-hint" role="status">
            {pauseHint}
          </div>
        ) : (
          <div className="follow-up-queue-pause-hint follow-up-queue-pause-hint-idle" aria-hidden>
            {t("thread.followUpQueueActive", { count: followUps.length })}
          </div>
        )}
        <button
          type="button"
          className="follow-up-queue-pause-toggle"
          disabled={pauseBusy}
          onClick={() => onTogglePause(!queuePaused)}
          title={queuePaused ? t("thread.followUpQueueResume") : t("thread.followUpQueuePause")}
          aria-label={queuePaused ? t("thread.followUpQueueResumeAria") : t("thread.followUpQueuePauseAria")}
        >
          {pauseBusy ? (
            <Activity size={12} aria-hidden />
          ) : queuePaused ? (
            <Play size={12} aria-hidden />
          ) : (
            <Pause size={12} aria-hidden />
          )}
          <span>{queuePaused ? t("thread.followUpQueueResume") : t("thread.followUpQueuePause")}</span>
        </button>
      </div>
      <div className="follow-up-queue-rows">
        {followUps.map((followUp) => {
          const isEditing = editingFollowUpId === followUp.id;
          const actionBusy = cancelBusyId === followUp.id || escalateBusyId === followUp.id || isEditing;
          const isEscalating = escalateBusyId === followUp.id;
          // Paused queues also let an already-escalated row be clicked: it is stuck
          // there, so the click means "send this one now".
          const canEscalate = canEscalateThreadFollowUp({
            priority: followUp.priority,
            coreSupportsEscalate: allowEscalate,
            queuePaused,
          });

          return (
            <div
              key={followUp.id}
              className={`follow-up-row${draggedId === followUp.id ? " is-dragging" : ""}${isEditing ? " is-editing" : ""}`}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault();
                moveDraggedBefore(followUp.id);
                setDraggedId(undefined);
              }}
            >
              <div
                className="follow-up-card-main follow-up-card-main-editable"
                role="button"
                tabIndex={actionBusy ? -1 : 0}
                aria-label={isEditing ? t("thread.followUpEditing") : t("thread.editFollowUpAria")}
                title={isEditing ? t("thread.followUpEditing") : t("thread.editFollowUp")}
                onClick={() => {
                  if (!actionBusy) {
                    onEdit(followUp);
                  }
                }}
                onKeyDown={(event) => {
                  if (actionBusy || (event.key !== "Enter" && event.key !== " ")) {
                    return;
                  }
                  event.preventDefault();
                  onEdit(followUp);
                }}
              >
                <span
                  className="follow-up-card-drag-handle"
                  draggable={!actionBusy && !isEditing}
                  role="button"
                  tabIndex={actionBusy || isEditing ? -1 : 0}
                  aria-label={t("thread.reorderFollowUpAria")}
                  title={t("thread.reorderFollowUp")}
                  onClick={(event) => event.stopPropagation()}
                  onDragStart={(event) => {
                    if (isEditing) {
                      event.preventDefault();
                      return;
                    }
                    event.stopPropagation();
                    setDraggedId(followUp.id);
                    event.dataTransfer.effectAllowed = "move";
                  }}
                  onDragEnd={() => setDraggedId(undefined)}
                >
                  <GripVertical size={14} aria-hidden />
                </span>
                <span className="follow-up-card-text">{formatThreadFollowUpPreview(followUp)}</span>
              </div>
              <div className="follow-up-card-actions">
                {isEditing ? (
                  <span className="follow-up-card-editing-badge">{t("thread.followUpEditing")}</span>
                ) : (
                  <>
                    {allowEscalate ? (
                      canEscalate ? (
                        <span
                          className="follow-up-card-type follow-up-card-type-action"
                          role="button"
                          tabIndex={actionBusy ? -1 : 0}
                          aria-disabled={actionBusy}
                          aria-label={t("thread.followUpNowAria")}
                          title={t("thread.followUpNow")}
                          onClick={() => {
                            if (!actionBusy) {
                              onEscalate(followUp);
                            }
                          }}
                          onKeyDown={(event) => {
                            if (actionBusy || (event.key !== "Enter" && event.key !== " ")) {
                              return;
                            }
                            event.preventDefault();
                            onEscalate(followUp);
                          }}
                        >
                          <CornerDownRight size={11} aria-hidden />
                          {isEscalating ? t("thread.processing") : t("thread.guide")}
                        </span>
                      ) : (
                        <span className="follow-up-card-type">
                          <CornerDownRight size={11} aria-hidden />
                          {t("thread.guide")}
                        </span>
                      )
                    ) : null}
                    <button
                      type="button"
                      className="follow-up-card-action"
                      onClick={() => onCancel(followUp)}
                      disabled={actionBusy}
                      title={t("common.delete")}
                      aria-label={t("thread.deleteFollowUpAria")}
                    >
                      {cancelBusyId === followUp.id ? <Activity size={12} /> : <Trash2 size={12} />}
                    </button>
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Construct the shell in its own React work unit, outside App's large hook frame.
// This also avoids copying that frame into every JSX owner stack in development.
function AppRenderContent({ render }: { render: () => ReactNode }) {
  return render();
}

function isActiveThreadStatus(status: ThreadStatus): boolean {
  return status === "running" || status === "queued";
}

function nextThreadCancelling(
  event: { type: string; cancelling?: boolean },
  thread: Pick<ThreadSummary, "status" | "cancelling">,
): boolean | undefined {
  const nextStatus = statusFromLiveEvent(event.type, thread.status);
  if (!isActiveThreadStatus(nextStatus)) {
    return undefined;
  }
  if (event.cancelling === true) {
    return true;
  }
  if (event.cancelling === false) {
    return undefined;
  }
  return thread.cancelling ? true : undefined;
}

function statusFromLiveEvent(type: string, fallback: ThreadStatus): ThreadStatus {
  if (type === "thread.completed") return "completed";
  if (type === "thread.unstarted_turn_discarded") return "failed";
  if (type === "thread.failed") return "failed";
  if (type === "thread.blocked") return "blocked";
  if (type === "thread.awaiting_plan" || type === "thread.execution_failed") return "awaiting_plan";
  if (type === "thread.idle" || type === "thread.stopped" || type === "thread.execution_done") return "idle";
  if (
    type === "thread.running" ||
    type === "thread.started" ||
    type === "thread.queued" ||
    type === "thread.retry"
  ) {
    return "running";
  }
  return fallback;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isWaitForRunError(error: unknown): boolean {
  const message = errorMessage(error);
  return (
    message.includes("Wait for the current run to finish") ||
    message.includes("请等待当前运行结束后再继续") ||
    message.includes("请等待当前运行结束后再修改配置")
  );
}

function removeRecordKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) {
    return record;
  }
  const next = { ...record };
  delete next[key];
  return next;
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

installVitePreloadRecovery();
document.documentElement.lang = i18n.resolvedLanguage ?? "zh-CN";
createRoot(document.getElementById("root") as HTMLElement).render(
  <I18nextProvider i18n={i18n}>
    <App />
  </I18nextProvider>,
);
