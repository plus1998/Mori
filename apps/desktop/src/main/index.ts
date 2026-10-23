import { createAccountUsagePricingLookup } from "./account-usage-pricing";
import { ChatGptModelCatalogService, resolveChatGptModelCatalogCachePath } from "./chatgpt-model-catalog";
import { ProjectTodoStore } from "./project-todo-store";
import type { ProjectTodoSave, ProjectTodoTrash } from "../shared/project-todos";
import { TtsReadAloudService } from "./tts-read-aloud";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { buildComposerCapabilityReferences } from "../shared/composer-capability-references";
import {
  CONTEXT_MCP_SERVER,
  CONTEXT_REFERENCE_PROMPT,
  type ComposerReferenceSearchRequest,
} from "../shared/composer-references";
import {
  SCHEDULING_MCP_SERVER,
  SCHEDULING_PROMPT,
  type ScheduleCreateInput,
  type ScheduleExecutionProfile,
  type ScheduleOccurrence,
  type ScheduleTrigger,
  type ScheduleUpdateInput,
} from "../shared/scheduling";
import {
  buildTtsPromptAppend,
  ECO_TTS_MCP_SERVER,
  isEcoTtsToolName,
  type TtsProfileSaveInput,
} from "../shared/tts";
import { webChatProxyConfig, webChatSitePartition } from "../shared/web-chat-list";
import { ComposerReferenceService } from "./composer-reference-service";
import { BrowserSelectionService } from "./browser-selection-service";
import { authorizeBrowserDownloadAccess } from "./browser-download-approval";
import { ContextReferenceMcpGateway } from "./context-reference-mcp-gateway";
import { ConversationRecoveryGate } from "./conversation-recovery-gate";
import { finalizeAcceptedConversationV2Messages } from "./conversation-v2-accepted-finalization";
import { createMcpHubNestedToolPermissionHandler } from "./mcp-hub-permission";
import { previewSchedule } from "./schedule-time";
import { inspectScheduledRun } from "./scheduling-inspection";
import { SchedulingMcpGateway } from "./scheduling-mcp-gateway";
import { freezeSchedulingProfile } from "./scheduling-profile";
import { SchedulingService } from "./scheduling-service";
import { SchedulingStore } from "./scheduling-store";
import { TtsMcpGateway } from "./tts-mcp-gateway";
import { createTtsStore, type TtsStore } from "./tts-store";
import { WebChatProxyController } from "./web-chat-proxy";
import { isDevFeedReplayFrameUrl } from "../shared/dev-feed-replay";

const execFileAsync = promisify(execFile);

import type { ResolvedModelRoute } from "@eco/model-router";
import {
  type AgentEvent,
  acpSessionIdToDelete,
  type CodexAsyncQuestionsInput,
  type CodexGatewayCatalogRoute,
  type CodexMcpServerForConfigSync,
  type CodexTurnTokenUsageBreakdown,
  codexToolDisplayName,
  composeCanUseToolHandlers,
  createAskUserQuestionHandler,
  defaultSubagentAvailability,
  deleteCursorAcpSession,
  type EcoAgentRuntimeConfig,
  type EcoPlanningContext,
  type EcoSdkResumeOptions,
  type EcoSdkSessionOptions,
  type EcoSubagentAttributionHooks,
  evaluateFilesystemReadConfirmation,
  evaluateFilesystemWriteConfirmation,
  isAcpProviderExhaustionMessage,
  isCoreKind,
  isCodexTurnInterruptFailed,
  isPiThreadMidTurnAccepting,
  isReadFilesystemTool,
  integratedWebSearchProviderLabel,
  isWriteFilesystemTool,
  materializeEcoToolPolicy,
  normalizeSdkSubagentType,
  type ParsedUsage,
  type PlanReadyPayload,
  parsePiUsage,
  probePiCoreAvailability,
  readFilesystemPath,
  resolveAcpHostUiFeatures,
  resolveCodexHomeDir,
  resolveCursorAgentExecutable,
  resolveEffectiveContextLimit,
  requireCodexAccountContextWindow,
  sanitizeCodexRoleId,
  SDK_GENERAL_PURPOSE_AGENT_KEY,
  SDK_PLAN_AGENT_KEY,
  sdkAgentKeyForOrchestrationAgent,
  type SdkAskUserQuestionRequest,
  type SdkToolPermissionDecision,
  type SdkToolPermissionRequest,
  type SessionCapturedPayload,
  type SubagentRunPhase,
  steerPiThreadMidTurn,
  toAcpMcpServers,
} from "@eco/runtime";
import { steerCodexTurn } from "@eco/runtime/codex-turn-steer";
import { listCursorAgentModels } from "@eco/runtime/cursor-agent-models";
import type { PlanExecutionTarget } from "@eco/runtime/forced-plan-delegation";
import {
  buildForcedPlanDelegationContract,
  listPlanDelegationAgents,
  validatePlanExecutionTarget,
} from "@eco/runtime/forced-plan-delegation";
import {
  ClaudeAgentSdkDriver,
  deleteClaudeAgentSdkSession,
  type EcoHookContext,
  extractCompactPostTokens,
  findClaudeSessionByRecoveryTitle,
  forkClaudeSessionAt,
  resolveClaudeResumeSessionAtBeforeUserMessage,
} from "@eco/runtime/sdk";
import {
  CONVERSATION_V2_ERROR,
  ConversationV2Error,
  definedProps,
  ecoMcpHubServerName,
  isRemoteCommandChannel,
  stableHash,
} from "@eco/shared";
import {
  type CommandRunner,
  createSessionPlan,
  GitWorktreeService,
  isDirectWorkspacePlan,
  type WorktreePlan,
} from "@eco/workspace";
import {
  type AuthInfo,
  app,
  BrowserWindow,
  type BrowserWindowConstructorOptions,
  clipboard,
  dialog,
  type Event,
  ipcMain,
  Menu,
  type NativeImage,
  Notification,
  nativeImage,
  nativeTheme,
  net,
  powerMonitor,
  powerSaveBlocker,
  protocol,
  safeStorage,
  screen,
  session,
  shell,
  type WebContents,
} from "electron";
import { ClaudeMidTurnPortRegistry } from "./claude-mid-turn-port";
import { decideClaudeResume, snapshotClaudeResumeRoutes } from "./claude-resume-decision";
import {
  type ClaudePromptSessionLine,
  planClaudeUserMessageRebindMappings,
  resolveClaudeCurrentSessionUserMessageId,
} from "./claude-user-message-rebind";
import { CodexMidTurnPortRegistry } from "./codex-mid-turn-port";
import type { PreparedConversationCommandDispatch } from "./conversation-command-dispatch";
import {
  type AcceptedConversationMessageSchedule,
  buildAcceptedConversationMessageSchedule,
  parseConversationV2Request,
  readOptionalConversationV2String,
  readOptionalInteger,
  readPositiveInteger,
  requiredConversationV2Integer,
  requiredConversationV2String,
} from "./conversation-v2-request";
import { getClaudeVersion, getCodexVersion, getCursorVersion } from "./core-version";
import { configureDesktopDevIdentity } from "./desktop-app-identity";
import { ensureDesktopPath } from "./fix-desktop-path";
import { ImageViewReadError, readImageViewFile } from "./image-view-reader";
import { buildApplicationMenuTemplate } from "./native-menu";
import {
  readElectronResourcesPath,
  resolvePackagedClaudeExecutableCandidate,
} from "./packaged-runtime-executables";
import { isReloadShortcutInput } from "./packaged-window-shortcuts";
import { assertSdkSessionRetainedOnRunFailure } from "./sdk-session-run-failure";
import { isAllowedSessionPermission, isLocalRendererUrl } from "./session-permissions";
import { evaluateThreadToolConfirmation } from "./thread-bash-permission";
import {
  resolveWindowsBackdropVersion,
  resolveWindowsBackgroundMaterial,
} from "./windows-background-material";

ensureDesktopPath();

import { repairActivityText } from "../shared/activity-text";
import { isOrchestrationSelection, orchestrationConfigFromSnapshot } from "../shared/agent-orchestration";
import { buildAgentTemplateArchive, parseAgentTemplateArchive } from "../shared/agent-template-archive";
import { resolveUpstreamApiCompat, type UpstreamApiCompat } from "../shared/api-compat";
import {
  deriveBashApprovalRememberPrefix,
  formatBashApprovalDenyMessage,
  formatFilesystemApprovalDenyMessage,
} from "../shared/bash-approval-ui";
import { didSwitchToAllowAllBashReviewMode } from "../shared/bash-review-ui";
import { enrichBillingDisplaySource } from "../shared/billing-display-source";
import {
  type BrowserCloseRequest,
  type BrowserFocusRequest,
  type BrowserNavigateRequest,
  type BrowserOpenRequest,
  type BrowserRegisterGuestRequest,
  type BrowserSetUiScopeRequest,
  type BrowserSetVisibleRequest,
  type BrowserViewState,
  ECO_AGENT_BROWSER_MCP_SERVER,
  ECO_AGENT_BROWSER_SKILL_NAME,
  extractUrlFromBrowserOpenToolPayload,
  isEcoAgentBrowserOpenToolName,
  requiresBrowserOpenApproval,
  resolveToolNameFromActivityPayload,
} from "../shared/browser";
import { listEnabledGlobalMcpServerKeys } from "../shared/composer-mcp";
import type { SkillsEnabledSettings } from "../shared/composer-skills-settings";
import {
  ECO_COMPUTER_USE_MCP_SERVER,
  isEcoComputerUseToolName,
  requiresComputerUseActionApproval,
} from "../shared/computer-use";
import {
  describeFollowUpDelivery,
  scheduledAcceptedMessageDelivery,
  terminalAcceptedMessageDelivery,
} from "../shared/conversation-message-delivery";
import type { DesktopUpdateState } from "../shared/desktop-update";
import { computeGlobalSettingsDigest } from "../shared/global-settings-digest";
import {
  buildHtmlHostPromptAppend,
  ECO_HTML_HOST_MCP_SERVER,
  ECO_HTML_HOST_TOOL,
  isEcoHtmlHostToolName,
} from "../shared/html-host-tool";
import { expectedIpcErrorKey, translateCatalog } from "../shared/i18n-catalogs";
import {
  buildImageDisplayPromptAppend,
  ECO_IMAGE_DISPLAY_MCP_SERVER,
  ECO_IMAGE_DISPLAY_TOOL,
  isEcoImageDisplayToolName,
} from "../shared/image-display-tool";
import {
  buildImageGenerationPromptAppend,
  ECO_IMAGE_GENERATION_MCP_SERVER,
  type ImageGenerationArtifact,
  type ImageGenerationProfileSaveInput,
  isEcoImageGenerationToolName,
} from "../shared/image-generation";
import {
  buildImageViewPromptAppend,
  ECO_IMAGE_VIEW_MCP_SERVER,
  ECO_IMAGE_VIEW_TOOL,
  isEcoImageViewToolName,
} from "../shared/image-view-tool";
import {
  buildIntegratedWebSearchPromptAppend,
  ECO_WEB_SEARCH_MCP_SERVER,
  isEcoWebSearchToolName,
  isWebSearchApprovalToolName,
} from "../shared/integrated-web-search";
import { integrationEnabled } from "../shared/integrations";
import type { ThreadForkFromMessageRequest } from "../shared/ipc";
import {
  type AddCodexCatalogModelRequest,
  type AgentRole,
  type AgentTemplate,
  type AgentTemplateExportRequest,
  applyBusyMutableRuntimeConfigFields,
  type BashApprovalRequest,
  type BashApprovalResolvePayload,
  type CandidateModelInput,
  type CandidateModelView,
  type CenterServerRegisterDesktopRequest,
  type CenterServerSettingsInput,
  type CenterServerSignInRequest,
  type CenterServerSignUpRequest,
  type CenterServerSyncDomain,
  type CenterServerTestConnectionRequest,
  type ClarificationAnswers,
  type ClarificationAsyncDelivery,
  type ClarificationDismissPayload,
  type ClarificationSubmitPayload,
  type ClarificationSubmitResult,
  type ClipboardReadImageResult,
  type CoderTodoItem,
  type CodexCatalogModelView,
  type CodexModelCatalogSnapshot,
  hasCompleteOrchestrationSelection,
  IPC_CHANNELS,
  type IpcChannel,
  isBackgroundTerminalListRequest,
  isBackgroundTerminalOpenRequest,
  isBackgroundTerminalStartRequest,
  isBackgroundTerminalStopRequest,
  isBusyMutableOnlyRuntimeConfigUpdate,
  isCodexBackgroundTerminalTerminateRequest,
  isClaudeBackgroundTaskStopRequest,
  isGitCommitRequest,
  isGitFetchRequest,
  isGitGenerateCommitMessageRequest,
  isGitListCommitsRequest,
  isGitPullRequest,
  isGitPushRequest,
  isKnownIpcChannel,
  isRunPackageScriptRequest,
  isSavePackageScriptArgsRequest,
  isSshBookmarkConnectRequest,
  isSshBookmarkDeleteRequest,
  isSshBookmarkSaveInput,
  isStorageCleanupRequest,
  isTerminalInputRequest,
  isTerminalKillRequest,
  isTerminalListRequest,
  isTerminalResizeRequest,
  isTerminalSpawnRequest,
  isThreadRuntimeConfig,
  type ListUpstreamModelsRequest,
  lockThreadRuntimeConfigSnapshotOnContinue,
  MAX_CLIPBOARD_IMAGE_BASE64_CHARS,
  type MainAgentConfigResource,
  type MainAgentPromptResource,
  type McpServerConfigInput,
  type ModelSettingsSnapshot,
  materializeThreadOrchestrationSnapshot,
  normalizeThreadRuntimeConfig,
  type OrchestrationSelection,
  type PlanApprovalRequest,
  type PromptImageAttachment,
  type ProviderConfigInput,
  parseGitListCommitModelOptionsRequest,
  parseGitSaveCommitModelPreferenceRequest,
  type RouteManualSpec,
  type RouteProfileInput,
  type RuntimeAgentRole,
  type RuntimeRoleRouteConfig,
  resolveBusyThreadRuntimeConfigUpdate,
  resolveMainAgentSystemPromptPreset,
  resolveSessionMode,
  resolveThreadOrchestrationSnapshot,
  resolveThreadRuntimeMcpServerKeys,
  runtimeRoleRoutesFromOrchestrationSnapshot,
  SUBAGENT_ROLES,
  type SubagentOrchestrationResource,
  shouldRematerializeThreadRuntimeConfigOnContinue,
  type TerminalListRequest,
  type TestProviderConnectionRequest,
  type TestRoleRoutesRequest,
  type ThreadActivityLine,
  type ThreadActivityRewindTarget,
  type ThreadAppliedDiffResult,
  type ThreadBillingSnapshot,
  type ThreadContextSnapshot,
  type ThreadContinueResult,
  type ThreadFollowUpCancelRequest,
  type ThreadFollowUpEditingRequest,
  type ThreadFollowUpEditingResult,
  type ThreadFollowUpEnqueueRequest,
  type ThreadFollowUpEscalateRequest,
  type ThreadFollowUpMutationResult,
  type ThreadFollowUpQueuePausedRequest,
  type ThreadFollowUpQueuePausedResult,
  type ThreadFollowUpReorderRequest,
  type ThreadFollowUpRunPhase,
  type ThreadFollowUpUpdateRequest,
  type ThreadLiveEvent,
  type ThreadModelUsageEntry,
  type ThreadPendingFollowUp,
  type ThreadPendingPlan,
  type ThreadRetryFromMessageRequest,
  type ThreadRevertAppliedDiffResult,
  type ThreadRewriteFromMessageRequest,
  type ThreadRollbackResult,
  type ThreadRunBashApprovalMetadata,
  type ThreadRunBashApprovalPhase,
  type ThreadRunEvent,
  type ThreadRunEventScope,
  type ThreadRunToolMetadata,
  type ThreadRuntimeConfig,
  type ThreadRuntimeConfigInput,
  type ThreadSessionBootstrapResult,
  type ThreadStartRequest,
  type ThreadStartResult,
  type ThreadStatus,
  type ThreadSummary,
  type ThreadUpdateRuntimeConfigRequest,
  type ThreadUsageSnapshot,
  type ThreadUserMessageEditGetRequest,
  type ThreadUserMessageEditGetResult,
  type ToolWritingActivity,
  type WorkspaceInfo,
  type WorktreeApplyResult,
  type WorktreeCancelDisposition,
  type WorktreeStatusResult,
  withAgentSessionMode,
} from "../shared/ipc";
import {
  type AppLocale,
  type AppLocalePreference,
  normalizeLocalePreference,
  resolveAppLocale,
} from "../shared/locale";
import { filterMcpSdkConfigByAssignedServers } from "../shared/mcp";
import { rewriteEcoMcpHubPromptForCodexServer } from "../shared/mcp-hub-tool-usage";
import { evaluateDesktopNotificationPolicy } from "./desktop-notification-policy";
import type {
  OpenAIAccountAssistantAction,
  OpenAIAccountCreateInput,
  OpenAIAccountUpdateInput,
} from "../shared/openai-account";
import { parseThreadApprovePlanPayload, parseThreadDismissPlanPayload } from "../shared/plan-approval";
import {
  buildMainAgentModelKey,
  buildOrchestrationRuntimeKey,
  diffPromptCacheRuntimeSignatures,
  resolveMainAgentModelKey,
  resolvePromptCacheOrchestrationLabel,
  resolvePromptCacheRuntimeSignature,
} from "../shared/prompt-cache-config";
import { PROMPT_IMAGE_PREVIEWS_METADATA_KEY, type PromptImagePreview } from "../shared/prompt-image-metadata";
import { buildPromptWithImageReferences } from "../shared/prompt-image-reference";
import { BUILTIN_VISION_AGENT_ROLE } from "../shared/prompt-image-vision";
import { computeRouteFingerprint, routesMatchFingerprint } from "../shared/route-fingerprint";
import { resolveImplicitSkillReadRoots } from "../shared/skill-paths";
import {
  buildRuntimeAgentSkillAssignments,
  type LinkAgentsSkillsRequest,
  listSdkReadyProjectSkills,
  resolveExplicitCodexSkillInputs,
  resolveSdkSessionSkillConfig,
  type SdkSessionSkillsScope,
  type SkillCatalogInstallRequest,
  type SkillCatalogSearchRequest,
  type SkillInfo,
  type SkillUninstallRequest,
} from "../shared/skills";
import {
  activityLinesFromThreadRunEvents,
  buildThreadApprovalNotificationContent,
  buildThreadClarificationNotificationContent,
  buildThreadCompletionNotificationContentFromSources,
} from "../shared/thread-completion-notification";
import {
  activityLinesBeforeRewindTarget,
  buildAgentPromptWithContext,
  buildThreadTurnPrompt,
  resolveCodexContinueStrategy,
  resolveThreadContinueAction,
  type ThreadContinueAction,
  threadEnteredExecutionPhase,
  threadHasPriorAgentOutput,
} from "../shared/thread-continuation";
import {
  buildPlanExecutionFailureMessage,
  persistThreadSummaryMessage,
  planDelegationFailurePrefix,
  planExecutionFailurePrefix,
} from "../shared/thread-failure-message";
import { coreSupportsMidTurnFollowUp, coreUsesInterruptForSteer } from "../shared/thread-follow-up-core";
import {
  buildThreadFollowUpDisplayPrompt,
  buildThreadFollowUpDrainPrompt,
  canEscalatedFollowUpProgressNow,
  collectThreadFollowUpAttachments,
  isFollowUpMidTurnResultDelivered,
  selectThreadFollowUpDrainTarget,
  shouldAutoPauseFollowUpQueue,
  shouldBlockThreadFollowUpDrain,
  shouldDrainThreadFollowUps,
  shouldReleaseFollowUpQueuePause,
  threadAcceptsQueuedFollowUp,
} from "../shared/thread-follow-up-drain";
import {
  requiresEmptyTurnForRequestRetry,
  supportsOneClickRequestRetry,
  usesRewindOnRequestRetry,
} from "../shared/thread-request-retry";
import {
  projectThreadRunToolMetadata,
  projectThreadRunToolMetadataForFeed,
} from "../shared/thread-run-tool-projection";
import {
  buildWorktreeMergeSummary,
  formatWorktreeMergeThreadMessage,
  serializeWorktreeMergeMessage,
} from "../shared/worktree-merge";
import { createAcpAskQuestionHandler } from "./acp-ask-question-bridge";
import {
  type AcpCursorProbeResult,
  assertAcpCursorRunnable,
  handshakeAcpCursor,
  probeAcpCursorAvailability,
  reconcileAcpCursorEnabled,
} from "./acp-cursor-availability";
import { createAcpPermissionHandler } from "./acp-permission-bridge";
import {
  applyAcpPlanProgress,
  applyAcpUpdateTodos,
  isAcpPlanTodoPayload,
  isAcpUpdateTodosPayload,
} from "./acp-plan-progress";
import {
  acpThreadHasInFlightTurn,
  cancelAcpThread,
  disposeAcpThread,
  resolveAcpRunPrompt,
  startAcpThreadRun,
  stopAllAcpRuntimes,
  toAcpThreadStartRunInput,
} from "./acp-runtime-run";
import { ActiveRunBillingStateStore } from "./active-run-billing-state";
import { type ActiveRunRuntimeStateInput, ActiveRunRuntimeStateStore } from "./active-run-runtime-state";
import { AgentLifecycleService } from "./agent-lifecycle-service";
import { type AgentOrchestrationStore, createAgentOrchestrationStore } from "./agent-orchestration-store";
import { mergeAgentRegistrySettings } from "./agent-registry-settings";
import {
  type AnthropicProxyRoute,
  type AnthropicProxyStartOptions,
  type AnthropicProxyUsageHandler,
  type AnthropicProxyUsageInfo,
  emitClaudeGatewayUsageIfSession,
  resolveClaudeBridgeRoute,
  runtimeRouteToProxyRoute,
  startAnthropicModelProxy,
} from "./anthropic-proxy";
import {
  attachMainWindowQuitGuard,
  installApplicationShutdownHook,
  isApplicationQuitting,
} from "./application-shutdown";
import {
  type ApplicationShutdownDeps,
  collectRunningWorkSummary,
  hasRunningWork,
} from "./application-shutdown-work";
import { resolveApprovalModelRoute } from "./approval-model-route";
import { transcribeAsr } from "./asr-client";
import { type AsrSecretCodec, type AsrSettingsStore, createAsrSettingsStore } from "./asr-settings-store";
import { resolveAuxiliaryModelRoute } from "./auxiliary-model-route";
import { BackgroundTerminalTaskRegistry } from "./background-terminal-tasks";
import { resolveBashApprovalAgentId } from "./bash-approval-agent-id.js";
import { CodexBackgroundTerminalService } from "./codex-background-terminals";
import { ClaudeBackgroundTaskRegistry } from "./claude-background-tasks";
import {
  approveAllPendingBashApprovalsForThread,
  type BashApprovalResolution,
  buildResolvedBashApprovalThreadPatch,
  cancelBashApprovalsForThread,
  getPendingBashApprovalByToolUseId,
  getPendingBashApprovalForThread,
  registerPendingBashApproval,
  resolvePendingBashApproval,
} from "./bash-approval-bridge";
import type { UsageBillingObservation } from "./billing-orchestration";
import { isSubagentBillingRole } from "./billing-orchestration";
import {
  lookupRouteCapabilityHints,
  lookupRoutePricingHints,
  type RuntimeRoute,
  resolveRatesForRoute,
  resolveRuntimeRoutesFromSettings,
} from "./billing-resolver";
import {
  type BillingRuntimeEnvironment,
  createBillingRuntimeEnvironment,
  resolveBillingRuntimeContext,
} from "./billing-runtime-environment";
import { installBrowserGuestBridge } from "./browser-guest-bridge";
import { appendBrowserPrompt, BrowserHost } from "./browser-host";
import {
  type BrowserSettingsStore,
  createBrowserSettingsStore,
  isBrowserSettingsSnapshot,
  normalizeBrowserSettingsSnapshot,
} from "./browser-settings-store";
import {
  type FinalizeCancelledRunDeps,
  finalizeCancelledRun,
  parseThreadCancelRequest,
  takePendingCancelDisposition,
} from "./cancel-worktree";
import {
  createCenterServerStore,
  createElectronSafeStorageCenterServerSecretCodec,
} from "./center-server-store";
import {
  createChatGptSubscriptionFetch,
  createChatGptSubscriptionFetchForProxy,
} from "./chatgpt-subscription-fetch";
import type { ChatGptSubscriptionService } from "./chatgpt-subscription-service";
import {
  buildAskUserQuestionUpdatedInput,
  buildClarificationToolMetadata,
  buildIgnoredClarificationAnswers,
  cancelClarificationsForThread,
  formatClarificationAnswersSummary,
  getPendingClarificationByToolUseId,
  getPendingClarificationForThread,
  hasPendingBlockingClarificationForThread,
  registerPendingClarification,
  submitClarification,
} from "./clarification-bridge";
import { globalClaudeBridgeBindingRegistry } from "./claude-bridge-binding";
import {
  configureCodexAsyncQuestionBridge,
  deliverAsyncClarificationAnswers,
  handleCodexAsyncQuestions,
  isTrackedCodexAsyncQuestion,
  markCodexAsyncQuestionDismissed,
  prepareAsyncClarificationReply,
  releasePendingClarification,
} from "./codex-async-question-bridge";
import {
  buildCodexAppServerBillingRequests,
  normalizeCodexAppServerUsage,
} from "./codex-app-server-usage-billing";
import { isCodexAuthCompletionPageText } from "./codex-browser-login";
import {
  CodexGatewayUsageDeduplicator,
  resolveCodexGatewayUsageBilling,
} from "./codex-gateway-usage-billing";
import { CodexGatewayUsagePendingBuffer } from "./codex-gateway-usage-pending";
import { connectCodexImageAccount, disposeCodexImageConnections } from "./codex-image-electron-transport";
import { CodexImageService } from "./codex-image-service";
import { consumeCodexQuotaReset } from "./codex-quota-reset";
import {
  CodexRemoteModelCatalogService,
  resolveCodexModelCatalogCachePath,
} from "./codex-model-catalog-remote";
import {
  getGlobalCodexRuntimeLifecycle,
  getCodexRuntimeClientForThread,
  getCodexRuntimeClients,
  parseElectronProxyResolution,
  setCodexAccountProxyConfigGetter,
  setCodexSystemProxyResolver,
  stopGlobalCodexRuntimeLifecycle,
} from "./codex-runtime-lifecycle";
import {
  assertCodexSkillsConfigReloadAllowed,
  configureCodexApprovalBridge,
  configureCodexRuntimeRun,
  createCodexRuntimeDriver,
  ensureCodexControlPlaneClient,
  getCodexRuntimeClientForEcoThread,
  forkCodexThreadForEcoThread,
  getCodexTurnRouteRegistry,
  requestCodexAccountRuntimeRestart,
  isCodexCliAvailable,
  queryCodexThreadStatusForEcoThread,
  registerResolvedCodexGatewayTurnRoute,
  resolveCodexExecutable,
  runThreadRequestWithRuntimeProxy as runCodexThreadRequest,
  scheduleCodexGlobalRuntimeRefresh,
  shutdownCodexGlobalRuntimeRefresh,
} from "./codex-runtime-run";
import { applyCodexSubagentLifecycleEvent } from "./codex-subagent-lifecycle";
import { CodexSubagentRuntimeLimitController } from "./codex-subagent-runtime-limit";
import { type CodexThreadMap, resolveCodexThreadAttribution } from "./codex-thread-map";
import { applyCodexTurnPlanProgress } from "./codex-turn-plan-progress";
import { ComputerUseMcpGateway } from "./computer-use-mcp-gateway";
import { detectScreenRecordingAppLabel } from "./computer-use-screen-host-native";
import {
  type ComputerUseSettingsStore,
  createComputerUseSettingsStore,
  isComputerUseSettingsSnapshot,
  normalizeComputerUseSettingsSnapshot,
} from "./computer-use-settings-store";
import { type ContextLifecycleService, createContextLifecycleService } from "./context-lifecycle-service";
import { logContextSnapshot } from "./context-snapshot-log";
import { ContextSnapshotScheduler } from "./context-snapshot-scheduler";
import { ContextWindowMonitor } from "./context-window-monitor";
import { executeThreadCancelCommand, failInterruptedCancelCommands } from "./conversation-cancel-command";
import {
  observeConversationCommandRuntime,
  prepareConversationCommandDispatch,
  waitForConversationCommandDispatch,
} from "./conversation-command-dispatch";
import {
  type HistoryCommandRecoveryDecision,
  recoverNonRewindRetryToPrepared,
} from "./conversation-command-recovery";
import {
  abandonedQueuedAcceptedPrompts,
  discardAbandonedAcceptedPrompts,
} from "./conversation-follow-up-accepted-prompt";
import {
  executeFollowUpMutationCommand,
  failInterruptedFollowUpCommands,
} from "./conversation-follow-up-command";
import { ConversationForkCommands } from "./conversation-fork-command";
import {
  executeBashApprovalResolutionCommand,
  executeClarificationResolutionCommand,
  failInterruptedInteractionCommands,
  recoverAsyncClarificationCommands,
} from "./conversation-interaction-command";
import { cleanupNativeConversationFork, forkNativeConversation } from "./conversation-native-fork";
import {
  executeNonRewindRetryCommand,
  resolveNonRewindRetryUserMessage,
} from "./conversation-nonrewind-retry-command";
import { executePlanResolutionCommand, recoverInterruptedPlanCommands } from "./conversation-plan-command";
import { executeConversationRewriteCommand } from "./conversation-rewrite-command";
import {
  executeRuntimeConfigMutationCommand,
  failInterruptedRuntimeConfigCommands,
} from "./conversation-runtime-config-command";
import { reportConversationRuntimeEventFailure } from "./conversation-runtime-event-failure";
import {
  type ConversationStore,
  createConversationStore,
  type ThreadHistoryCommandContext,
  type ThreadListCursor,
} from "./conversation-store";
import { ConversationStoreCodexThreadMap } from "./conversation-store-codex-thread-map";
import { createThreadDeleteCommandCoordinator } from "./conversation-thread-delete-command";
import { listDiscoveredCursorAgents } from "./cursor-agents-discovery";
import { DesktopNotificationRetainer } from "./desktop-notification-retainer";
import { presentDesktopWindow } from "./desktop-single-instance";
import { DesktopUpdateService } from "./desktop-update-service";
import { resolveStartupWindowSizing } from "./desktop-window-placement";
import {
  createDesktopWindowStateStore,
  type DesktopWindowState,
  type DesktopWindowStateStore,
  WINDOW_STATE_FILE_NAME,
  WINDOW_STATE_SAVE_DEBOUNCE_MS,
} from "./desktop-window-state";
import {
  hydratePromptAttachmentsForComposerRestore,
  shouldClearThreadPromptAfterUnstartedDiscard,
  toSpoolStageAttachments,
} from "./discard-unstarted-composer-restore";
import {
  buildEcoAgentBrowserCodexSkillInfo,
  ensureClaudeUserEcoAgentBrowserSkill,
  removeClaudeUserEcoAgentBrowserSkill,
  resolveEcoAgentBrowserSkillFileForCodex,
} from "./eco-agent-browser-skill";
import { type ApprovalHostEvidence, collectApprovalHostEvidence } from "./eco-approval-local-evidence";
import {
  buildThreadApprovalEnvelope,
  type EcoApprovalReviewResult,
  reviewEcoApproval,
} from "./eco-approval-reviewer";
import { logEcoDiag, logEcoDiagThrottled, shortAgentId, shortThreadId } from "./eco-diag-log";
import {
  configureEcoGatewayLifecycle,
  ensureGlobalEcoGateway,
  stopGlobalEcoGateway,
} from "./eco-gateway-lifecycle";
import { hasStructuredThreadEventExtras, resolveEmitThreadEventMessage } from "./emit-thread-event-message";
import { createElectronEventSink, DesktopEventCenter } from "./event-center";
import {
  armForcedPlanDelegation,
  buildForcedPlanDelegationHookConfig,
  clearStaleForcedPlanDelegationState,
  configureForcedPlanDelegationCodexHome,
  confirmForcedPlanDelegationFromRuntimeEvent,
  forcedPlanDelegationStore,
  releaseForcedPlanDelegation,
  restrictAgentRuntimeConfigToForcedDelegation,
  settleForcedPlanDelegation,
} from "./forced-plan-delegation-runtime.js";
import { handleGatewayRequestLifecycleEvent } from "./gateway-request-lifecycle";
import { classifyGatewayUsageEvent } from "./gateway-usage-dispatch";
import { GitAutoFetcher } from "./git-autofetch";
import {
  checkoutGitBranch,
  createGitBranch,
  discardWorkspaceChanges,
  fetchFromOrigin,
  getGitWorkingTreeStatus,
  getWorkspaceDiff,
  getWorkspaceFileDiff,
  handleGitCommit,
  handleGitGenerateCommitMessage,
  handleGitListCommitModelOptions,
  handleGitPull,
  handleGitPush,
  handleGitSaveCommitModelPreference,
  listGitCommits,
} from "./git-service";
import {
  createGitSettingsStore,
  type GitSettingsStore,
  isGitSettingsSnapshot,
  normalizeGitSettingsSnapshot,
} from "./git-settings-store";
import { ensureHomeProject, getHomeProjectPath } from "./home-project-bootstrap";
import { HtmlHostMcpGateway } from "./html-host-mcp-gateway";
import { HtmlHostStore } from "./html-host-store";
import { ImageDisplayMcpGateway } from "./image-display-mcp-gateway";
import { createImageDisplayStore, ImageDisplayError, type ImageDisplayStore } from "./image-display-store";
import { imageGenerationAvailability } from "./image-generation-availability";
import { ImageGenerationMcpGateway } from "./image-generation-mcp-gateway";
import {
  createImageGenerationStore,
  type ImageGenerationSecretCodec,
  type ImageGenerationStore,
} from "./image-generation-store";
import { ImageViewMcpGateway } from "./image-view-mcp-gateway";
import { IntegratedWebSearchMcpGateway } from "./integrated-web-search-mcp-gateway";
import { testIntegratedWebSearch } from "./integrated-web-search-test";
import {
  createIntegratedWebSearchSettingsStore,
  type IntegratedWebSearchSettingsStore,
  isIntegratedWebSearchSettingsSaveInput,
} from "./integrated-web-search-settings-store";
import { InteractiveTerminalManager } from "./interactive-terminal-manager";
import { createLocalSecretCodec } from "./local-secret-codec";
import { checkMcpServerConnection } from "./mcp-checker";
import { McpHubGateway } from "./mcp-hub-gateway";
import { prepareMcpSdkConfigForRuntime } from "./mcp-runtime";
import { createMcpStore, type McpStore } from "./mcp-store";
import { ModelsDevPricingCache } from "./models-dev-pricing-cache";
import {
  createNotificationSettingsStore,
  isNotificationSettingsSnapshot,
  type NotificationSettingsStore,
  normalizeNotificationSettingsSnapshot,
} from "./notification-settings-store";
import { OpenAIAccountAssistant } from "./openai-account-assistant";
import type { OpenAIAccount, OpenAIAccountService } from "./openai-account-service";
import { resolveOrchestrationGuardrails } from "./orchestration-run-budget";
import { PackageJsonWatcher } from "./package-json-watcher";
import { createPackageScriptArgsStore, type PackageScriptArgsStore } from "./package-script-args-store";
import {
  listPackageScripts,
  preparePackageScriptRun,
  runPreparedPackageScriptAsBackgroundTask,
} from "./package-scripts";
import {
  createPersonalizationSettingsStore,
  isPersonalizationSettingsSnapshot,
  normalizePersonalizationSettingsSnapshot,
  type PersonalizationSettingsStore,
} from "./personalization-settings-store";
import { buildPiMcpSessionConfig, mergePiAppendSystemPrompt } from "./pi-mcp-session";
import {
  abortPiThread,
  disposeAllPiSessions,
  disposePiThreadSession,
  removePiThreadAgentDir,
  startPiThreadRun,
} from "./pi-runtime-run";
import {
  piSkillDirectoriesForSession,
  resolvePiThreadSkills,
  shouldBlockPiSkillsConfigReload,
  skillsEnabledSettingsChanged,
} from "./pi-skills-config";
import {
  acknowledgePlanApprovalContinuation,
  bindPendingPlanApprovalCommand,
  cancelPlanApprovalsForThread,
  clearPlanApprovalCommandBinding,
  getPendingPlanApprovalByToolUseId,
  getPendingPlanApprovalCommand,
  getPendingPlanApprovalForThread,
  getPendingPlanApprovalWaitForThread,
  registerPendingPlanApproval,
  rejectPlanApprovalContinuation,
  resolvePendingPlanApproval,
  waitForPlanApprovalContinuation,
} from "./plan-approval-bridge";
import {
  createProjectIntegrationsSettingsStore,
  type ProjectIntegrationsSettingsStore,
} from "./project-integrations-settings-store";
import { createProjectMcpSettingsStore, type ProjectMcpSettingsStore } from "./project-mcp-settings-store";
import {
  createProjectOrchestrationSettingsStore,
  type ProjectOrchestrationSettingsStore,
} from "./project-orchestration-settings-store";
import {
  createProjectSkillsSettingsStore,
  type ProjectSkillsSettingsStore,
} from "./project-skills-settings-store";
import { formatPromptCacheBreakLog, resolveClaudeMdDigest } from "./prompt-cache-fingerprint";
import { createPromptCacheRunEventEmitter } from "./prompt-cache-run-events";
import {
  isPromptImageAttachmentRecord,
  isPromptImageContentRef,
  PromptImageFileStore,
} from "./prompt-image-file-store";
import { collectProviderDeleteReferences, partitionProviderDeleteReferences } from "./provider-deletion";
import { listProviderUpstreamModels, testProviderConnection, testRoleRoutes } from "./provider-models";
import { createProviderStore, type ProviderStore } from "./provider-store";
import { reconcileProxyAttributionContexts } from "./proxy-attribution-context-reconciliation";
import { ProxyBillingStampRegistry } from "./proxy-billing-stamp";
import {
  createProxyBridgeSettingsStore,
  isProxyBridgeSettingsSnapshot,
  normalizeProxyBridgeSettingsSnapshot,
  type ProxyBridgeSettingsStore,
  resolveOutboundProxyUrl,
  resolveUpstreamUserAgentOverride,
  resolveUpstreamUserAgentOverrides,
} from "./proxy-bridge-settings-store";
import { resolveProxyUsageBilling } from "./proxy-usage-billing";
import { REMOTE_THREAD_LIST_INITIAL_LIMIT_PER_WORKSPACE } from "./remote-thread-list";
import { sendToLiveRenderer } from "./renderer-send";
import { formatUserFacingRequestError, type RequestAttemptResult } from "./request-retry";
import { resolveCommandExecutable } from "./resolve-command-executable";
import { resolveCodexThreadWebSearchPlan, resolveThreadWebSearchPlan } from "./resolve-thread-web-search";
import { reconcileSdkAgentTerminalEvent } from "./sdk-agent-terminal-reconciliation";
import type { resolveSdkEventUsageBilling, SdkRunUsageBillingInput } from "./sdk-event-usage-billing";
import { resolveSdkHintPermission } from "./sdk-hint-approval";
import { resolveSdkRunBillingResolution } from "./sdk-run-billing-resolution";
import { consumeSdkRunEvents } from "./sdk-run-event-loop";
import { type BuildSdkRunInput, buildSdkRunInput, sdkRunPhaseFromMode } from "./sdk-run-input";
import {
  listSdkSessionActivityLines,
  listSdkSubagentActivityLines,
  sdkActivityLineId,
} from "./sdk-session-activity.js";
import { SdkStreamActivityBridge } from "./sdk-stream-activity";
import {
  createSdkStreamActivityIngestion,
  type SdkStreamActivityIngestion,
} from "./sdk-stream-activity-ingestion";
import {
  resolveSdkStreamPartialBillingOrchestration,
  type SdkStreamPartialBillingRequest,
} from "./sdk-stream-partial-billing-orchestration";
import type { SdkRunHookContextExtras } from "./sdk-task-run-hooks";
import { dispatchSdkEventUsageBilling } from "./sdk-usage-billing-dispatch";
import { handleSdkUsageRecordedEvent } from "./sdk-usage-recorded-event-handler";
import {
  resolveSingleUsageBillingOrchestration,
  type SingleUsageBillingRequest,
} from "./single-usage-billing-orchestration";
import { installCatalogSkill, listSkillsLeaderboard, searchSkillsCatalog } from "./skills-catalog";
import { listDiscoveredSkills } from "./skills-discovery";
import { linkAgentsSkillsToClaude } from "./skills-symlink";
import { uninstallDiscoveredSkill } from "./skills-uninstall";
import { createSshBookmarkStore, type SshBookmarkStore } from "./ssh-bookmark-store";
import { connectSshBookmark, type SshConnectSecrets } from "./ssh-connect";
import { runStorageCleanup } from "./storage-cleanup";
import { buildStorageUsageSnapshot } from "./storage-inventory";
import { SubagentConcurrencyGate } from "./subagent-concurrency-gate";
import {
  clearThreadSubagentLaunchRegistry,
  getThreadSubagentLaunchRegistry,
} from "./subagent-launch-registry-store.js";
import { SubagentMetricsRegistry } from "./subagent-metrics-registry";
import { createSubagentSessionHooks } from "./subagent-session-hooks.js";
import { buildSubagentSessionTimings } from "./subagent-session-snapshots.js";
import { reconcileSubagentTerminalTranscript } from "./subagent-terminal-reconciliation.js";
import { SupabaseCenterDesktopClient } from "./supabase-center-client";
import { SupabaseCloudDeployment } from "./supabase-cloud-deployment";
import { readSupabaseDeploymentBundle } from "./supabase-deployment-bundle";
import { createDesktopSettingsSyncHooks } from "./supabase-settings-sync-hooks";
import { SystemSleepBlocker } from "./system-sleep-blocker";
import { normalizeTelemetryBillingRole } from "./telemetry-billing-role";
import { resolveThreadApprovePlanRoute } from "./thread-approve-plan-route";
import { ThreadCacheHitMonitor } from "./thread-cache-hit-monitor";
import {
  attachThreadCancelling,
  attachThreadListCancelling,
  clearThreadCancelling,
  isThreadCancelling,
  markThreadCancelling,
  shouldKeepThreadCancelling,
} from "./thread-cancelling-state";
import { requireThreadCore } from "./thread-core-routing";
import { ThreadFollowUpDrainScheduler } from "./thread-follow-up-drain-scheduler";
import { ThreadFollowUpQueueControl } from "./thread-follow-up-queue-control";
import {
  applyExactLogicalRequestLateBind,
  applyLogicalRequestTerminal,
  clearFinalizedLiveRequestsForAttempt,
  finalizeDisplayRequestTerminal,
  finalizeLiveRequest,
  GATEWAY_ATTEMPT_CONNECTION_ERROR_ORIGIN,
  handleBridgeMessagesRequest,
  markBridgeRequestStartedPersisted,
  recordProviderRequestIdForLogical,
  resolveExplicitBridgeRequestAgentId,
  resolveFrozenLiveRequestAttribution,
  resolvePiUsageLogicalRequestId,
  resolveSdkLateBindAttribution,
  resolveUpstreamConnectionErrorAttribution,
  shouldEmitRetryScheduledCancellation,
  shouldEmitSdkShadowRequestTerminal,
  shouldPersistRequestStartedShadowEvent,
} from "./thread-live-request-coordinator.js";
import { ThreadLiveRequestRegistry } from "./thread-live-request-registry.js";
import { readOptionalString, resolveThreadMessagePrompt } from "./thread-message-prompt";
import {
  flushThreadMetrics,
  persistThreadMetrics,
  restoreThreadMetricsFromStore,
} from "./thread-metrics-runtime";
import { resolveOrphanedThreadRecoveryAction, shouldClearGhostAcpActiveRun } from "./thread-orphan-recovery";
import { resolveThreadPendingPlanDismissal } from "./thread-pending-plan-dismissal";
import { buildThreadPendingPlanView, buildThreadPlanLivePayload } from "./thread-pending-plan-view";
import { resolveThreadPlanApprovalRuntime } from "./thread-plan-approval-runtime";
import {
  applyThreadPlanReadyEffects,
  buildExecutionFailureRestorePendingPlan,
} from "./thread-plan-ready-effects";
import { ThreadPromptCacheEpisodeMonitor } from "./thread-prompt-cache-episode";
import { resolveThreadPromptCacheFingerprint, ThreadPromptCacheMonitor } from "./thread-prompt-cache-monitor";
import {
  clearRequestStartedPersisted,
  type RequestTerminalStage,
  requestTerminalLiveType,
  requestTerminalMessage,
} from "./thread-request-lifecycle.js";
import { type RunAttemptContext, runThreadRequestWithLifecycle } from "./thread-run-attempt";
import {
  type FinalizeThreadRunCleanupInput,
  finalizeThreadRunCleanup,
  shouldDeferRunCleanupFinish,
  shouldPreservePlanApprovalsOnRunCleanup,
} from "./thread-run-cleanup";
import {
  type ApplyThreadRunDecisionEffectsInput,
  applyThreadRunDecisionEffects,
} from "./thread-run-decision-effects";
import { createThreadRunEventLivePersister } from "./thread-run-event-live-persist";
import {
  buildSubagentLifecycleRunEvent,
  buildSubagentMissionAttributedRunEvent,
  buildThreadRunEventFromLiveEvent,
  isMetricsOnlyThreadLiveEvent,
} from "./thread-run-event-normalizer";
import {
  resolveAskRunOutcome,
  resolveAutonomousRunOutcome,
  resolveContinuationRunOutcome,
  resolveExecutionRunOutcome,
  resolvePlanningRunOutcome,
  resolvePlanSessionRunOutcome,
  runAttemptPhaseFromThreadMode,
} from "./thread-run-outcome";
import { ThreadRunPreparationCancelled, ThreadRunPreparationRegistry } from "./thread-run-preparation";
import { ThreadRuntimeCoordinator } from "./thread-runtime-coordinator";
import {
  runThreadRequestWithRuntimeProxy,
  type ThreadRuntimeProxyResult,
} from "./thread-runtime-proxy-attempt";
import {
  buildDriverRoutes,
  type RuntimeConfig,
  type RuntimeConfigResolution,
  resolveContextTokensByRole,
  resolveThreadRuntimeConfig,
  roleRoutesFromRuntime,
} from "./thread-runtime-routes";
import { createThreadSdkTaskRuntime } from "./thread-sdk-task-runtime";
import { buildThreadSessionBootstrap } from "./thread-session-bootstrap";
import {
  canRegenerateThreadTitle,
  coreOwnsSessionTitle,
  normalizeAcpSessionTitle,
  resolveFailedThreadTitle,
  resolvePendingThreadTitle,
  shouldReplaceAutoThreadTitle,
  summarizeThreadTitle,
} from "./thread-title";
import { type SerializedThreadUsageState, ThreadUsageAccumulator } from "./thread-usage-accumulator";
import { getUpstreamLogFilePath, logUpstream } from "./upstream-log";
import type { UpstreamProxyCallBilling } from "./upstream-proxy-log";
import { buildDefaultUpstreamUserAgent, setDefaultUpstreamUserAgent } from "./upstream-request-headers";
import type { UsageBillingPricingLookup } from "./usage-billing-artifacts";
import {
  applySdkRunBillingEffects,
  applySdkStreamPartialBillingEffects,
  applySingleUsageBillingEffects,
  type UsageBillingUpdatedEvent,
} from "./usage-billing-effects";
import { createUsageContextService } from "./usage-context-effects";
import type { RunAttemptCommandDispatch, RunAttemptPhase, RunAttemptStatus } from "./usage-ledger";
import { UsageLedgerCoordinator } from "./usage-ledger-coordinator";
import { type ImageViewHost, runImageView } from "./vision-analysis";
import { resolveThreadVisionAnalysisRoute, resolveVisionModelRoute } from "./vision-model-route";
import {
  createWebChatListStore,
  isWebChatListSnapshot,
  normalizeWebChatListSnapshot,
  type WebChatListStore,
} from "./web-chat-list-store";
import {
  createWorkflowSettingsStore,
  isWorkflowSettingsSnapshot,
  normalizeWorkflowSettingsSnapshot,
  resolveAcpCursorApiKeyForSave,
  type WorkflowSettingsStore,
} from "./workflow-settings-store";
import {
  listWorkspaceEntries,
  readWorkspaceFile,
  workspaceFileStreams,
  writeWorkspaceFile,
} from "./workspace-file-browser";
import { prepareWorkspaceGit } from "./workspace-git-setup";
import { WorkspaceGitStatusPublisher } from "./workspace-git-status-publisher";
import { inspectWorkspace, resolveGitExecutable } from "./workspace-inspect";
import { WorkspaceReviewService } from "./workspace-review-service";
import {
  type ApprovedPlanArtifact,
  type ApprovedPlanSnapshot,
  approvedPlanRelativePath,
  claudePlanFileExists,
  readApprovedPlanSnapshot,
  readClaudePlanFile,
  resolveWorktreePathHint,
  verifyApprovedPlanArtifact,
  writeApprovedPlanSnapshot,
} from "./worktree-lifecycle";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = process.env.VITE_DEV_SERVER_URL !== undefined;
protocol.registerSchemesAsPrivileged([
  {
    scheme: "eco-workspace",
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
  },
]);

const packagingDir = path.join(__dirname, "../../packaging");

function loadAppIcon(): NativeImage | undefined {
  const candidates =
    process.platform === "win32"
      ? ["icon.ico", "icon.png"]
      : process.platform === "darwin"
        ? ["icon.icns", "icon.png"]
        : ["icon.png", "icon.ico"];
  for (const name of candidates) {
    const iconPath = path.join(packagingDir, name);
    if (!existsSync(iconPath)) {
      continue;
    }
    const image = nativeImage.createFromPath(iconPath);
    if (!image.isEmpty()) {
      return image;
    }
  }
  return undefined;
}

const appIcon = loadAppIcon();

function broadcastDesktopUpdateState(state: DesktopUpdateState): void {
  BrowserWindow.getAllWindows().forEach((window) => {
    if (!window.isDestroyed()) {
      window.webContents.send(IPC_CHANNELS.appUpdateStateChanged, state);
    }
  });
}

const desktopUpdateService = new DesktopUpdateService({
  manifestPath: path.join(__dirname, "../release-manifest.json"),
  onStateChange: broadcastDesktopUpdateState,
  getOutboundProxyUrl: () => resolveOutboundProxyUrl(proxyBridgeSettingsStore.get()),
});

configureDesktopDevIdentity();

// The shared SQLite store and fixed-port gateway require a single main-process writer.
const e2eMode = process.env.ECO_E2E === "1";
const hasSingleInstanceLock = e2eMode ? true : app.requestSingleInstanceLock();
if (!e2eMode && !hasSingleInstanceLock) {
  app.quit();
}

let desktopInitializationComplete = false;

/**
 * Pending deep link (eco://...) delivered while the renderer is not ready yet.
 * Sent to the renderer once it reports ready.
 */
let pendingEcoDeepLink: string | undefined;
// True once the renderer reports ready (it then subscribes to deep-link events).
let desktopRendererReady = false;
const startupSplashWindows = new WeakSet<BrowserWindow>();
let resolveInitialDesktopRendererReady: (() => void) | undefined;
const initialDesktopRendererReady = new Promise<void>((resolve) => {
  resolveInitialDesktopRendererReady = resolve;
});

function getMainWindow(): BrowserWindow | undefined {
  return BrowserWindow.getAllWindows().find(
    (window) => !window.isDestroyed() && !startupSplashWindows.has(window),
  );
}

/**
 * Create the OAuth browser window with native close controls.
 *
 * Electron renders a parented modal BrowserWindow as a sheet on macOS. Sheets
 * do not expose the traffic-light buttons, so the login window must be a
 * normal child window on that platform; otherwise users have no way to cancel
 * an in-progress login.
 */
function createOAuthAuthWindow(parent?: BrowserWindow, partition = "oauth-auth-session"): BrowserWindow {
  const isMac = process.platform === "darwin";
  return new BrowserWindow({
    width: 900,
    height: 700,
    title: "Eco Coding · ChatGPT 授权",
    ...(appIcon ? { icon: appIcon } : {}),
    ...(parent ? { parent } : {}),
    modal: Boolean(parent) && !isMac,
    closable: true,
    ...(isMac ? { titleBarStyle: "default" as const } : {}),
    autoHideMenuBar: true,
    webPreferences: {
      partition,
      nodeIntegration: false,
      contextIsolation: true,
    },
  });
}

/** Watch for the provider's success page while the local app-server callback is still in flight. */
function watchCodexAuthCompletionPage(authWindow: BrowserWindow, onDetected: () => void): () => void {
  let stopped = false;
  let checking = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  function stop(): void {
    if (stopped) return;
    stopped = true;
    if (timer) clearInterval(timer);
    authWindow.webContents.removeListener("dom-ready", check);
    authWindow.webContents.removeListener("did-finish-load", check);
    authWindow.webContents.removeListener("did-navigate", check);
    authWindow.webContents.removeListener("did-navigate-in-page", check);
  }

  function check(): void {
    if (stopped || checking || authWindow.isDestroyed()) return;
    checking = true;
    void authWindow.webContents
      .executeJavaScript("document.body?.innerText ?? ''", true)
      .then((bodyText) => {
        if (typeof bodyText !== "string" || !isCodexAuthCompletionPageText(bodyText)) return;
        stop();
        onDetected();
      })
      .catch(() => {
        // The document can be replaced while OAuth navigates. The next load event retries.
      })
      .finally(() => {
        checking = false;
      });
  }

  authWindow.webContents.on("dom-ready", check);
  authWindow.webContents.on("did-finish-load", check);
  authWindow.webContents.on("did-navigate", check);
  authWindow.webContents.on("did-navigate-in-page", check);
  timer = setInterval(check, 1_000);
  check();
  return stop;
}

/** Keep the OAuth window open after provider-side success until app-server confirms the callback. */
function installCodexAuthCompletionGuard(
  authWindow: BrowserWindow,
  cancelLogin: () => void,
): {
  allowClose: () => void;
  dispose: () => void;
} {
  let awaitingCallback = false;
  const stopWatching = watchCodexAuthCompletionPage(authWindow, () => {
    if (awaitingCallback || authWindow.isDestroyed()) return;
    awaitingCallback = true;
    authWindow.setClosable(false);
    process.stderr.write("[codex-oauth] provider authorization succeeded; waiting for local callback\n");
  });

  authWindow.on("close", (event) => {
    if (awaitingCallback && !isApplicationQuitting()) {
      event.preventDefault();
      return;
    }
    cancelLogin();
  });

  return {
    allowClose: () => {
      awaitingCallback = false;
      stopWatching();
      if (!authWindow.isDestroyed()) authWindow.setClosable(true);
    },
    dispose: stopWatching,
  };
}

/** Configure the shared embedded OAuth session with the desktop outbound proxy. */
async function configureChatGptOAuthSessionProxy(
  authSession: ReturnType<typeof session.fromPartition>,
  rawProxyUrl?: string,
): Promise<() => void> {
  const proxyUrl = rawProxyUrl?.trim();
  let socksBridge: { close: () => void } | undefined;
  let proxyAuthListener:
    | ((
        event: Event,
        webContents: WebContents,
        request: string,
        authInfo: AuthInfo,
        callback: (username?: string, password?: string) => void,
      ) => void)
    | undefined;
  try {
    if (!proxyUrl) {
      await authSession.setProxy({ mode: "direct" });
      return () => {};
    }

    const parsed = new URL(proxyUrl);
    let proxyHost = parsed.host;
    if (parsed.protocol === "socks:" || parsed.protocol === "socks5:") {
      const { startSocksToHttpBridge } = await import("./openai-account-service");
      const bridge = await startSocksToHttpBridge(proxyUrl);
      socksBridge = { close: bridge.close };
      proxyHost = `127.0.0.1:${bridge.port}`;
    } else if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(`OAuth 不支持此代理协议：${parsed.protocol}`);
    }

    const pacContent = `function FindProxyForURL(url, host) { return "PROXY ${proxyHost}"; }`;
    const pacDataUri =
      "data:application/x-ns-proxy-autoconfig;base64," + Buffer.from(pacContent, "utf8").toString("base64");
    if (parsed.username || parsed.password) {
      const username = decodeURIComponent(parsed.username);
      const password = decodeURIComponent(parsed.password);
      const proxyHostname = parsed.hostname.toLowerCase();
      const proxyPort = parsed.port ? Number(parsed.port) : undefined;
      proxyAuthListener = (_event, _webContents, _request, authInfo, callback) => {
        if (!authInfo.isProxy || authInfo.host.toLowerCase() !== proxyHostname) return;
        if (proxyPort !== undefined && authInfo.port !== proxyPort) return;
        callback(username, password);
      };
      // Electron's current type declarations omit the app-level `login`
      // event even though it is still the supported hook for proxy auth.
      app.on("login" as any, proxyAuthListener as any);
    }
    await authSession.setProxy({ mode: "pac_script", pacScript: pacDataUri });
    let closed = false;
    return () => {
      if (closed) return;
      closed = true;
      if (proxyAuthListener) app.off("login" as any, proxyAuthListener as any);
      socksBridge?.close();
    };
  } catch (error) {
    if (proxyAuthListener) app.off("login" as any, proxyAuthListener as any);
    socksBridge?.close();
    throw error;
  }
}

function getStartupSplashWindow(): BrowserWindow | undefined {
  return BrowserWindow.getAllWindows().find(
    (window) => !window.isDestroyed() && startupSplashWindows.has(window),
  );
}

// Deliver a deep link to the primary window: immediately when the renderer is
// already ready, otherwise stash it and flush once the renderer reports ready.
function deliverEcoDeepLink(url: string): void {
  const window = getMainWindow();
  if (window && !window.isDestroyed() && desktopRendererReady) {
    window.webContents.send(IPC_CHANNELS.appEcoDeepLinkOpen, url);
    return;
  }
  pendingEcoDeepLink = url;
}

// Bring the primary window to the front (creating it if none exists yet).
function presentPrimaryWindow(): void {
  const existingWindow = getStartupSplashWindow() ?? getMainWindow() ?? BrowserWindow.getAllWindows()[0];
  if (existingWindow && !existingWindow.isDestroyed()) {
    presentDesktopWindow(existingWindow);
    return;
  }
  if (desktopInitializationComplete) {
    void createMainWindow()
      .then((window) => {
        presentDesktopWindow(window);
      })
      .catch((error) => {
        process.stderr.write(`[eco] failed to reopen primary window: ${errorMessage(error)}\n`);
      });
  }
}

app.on("second-instance", (_event, argv) => {
  const ecoUrl = argv.find((arg) => arg.startsWith("eco://"));
  presentPrimaryWindow();
  if (ecoUrl) {
    deliverEcoDeepLink(ecoUrl);
  }
});

// Delivered by the OS when the registered eco:// scheme is opened.
app.on("open-url", (_event, url) => {
  if (!url.startsWith("eco://")) {
    return;
  }
  presentPrimaryWindow();
  deliverEcoDeepLink(url);
});

// Flush a deep link that arrived before the renderer reported ready.
function flushPendingEcoDeepLink(window: Electron.BrowserWindow): void {
  if (!pendingEcoDeepLink) {
    return;
  }
  const url = pendingEcoDeepLink;
  pendingEcoDeepLink = undefined;
  window.webContents.send(IPC_CHANNELS.appEcoDeepLinkOpen, url);
}
const gitRunner: CommandRunner = {
  run: runGitCommand,
};
const desktopEventCenter = new DesktopEventCenter();
desktopEventCenter.subscribe(
  createElectronEventSink((channel, payload) => {
    BrowserWindow.getAllWindows().forEach((window) => {
      sendToLiveRenderer(window, channel, payload);
    });
  }),
);

function broadcastGitCommitMessageDelta(requestId: string, text: string): void {
  const payload = { requestId, text };
  BrowserWindow.getAllWindows().forEach((window) => {
    sendToLiveRenderer(window, IPC_CHANNELS.gitGenerateCommitMessageDelta, payload);
  });
}
function broadcastPackageScriptTerminalLaunch(payload: {
  workspacePath: string;
  sessionId: string;
  script: string;
  command: string[];
  commandLabel?: string;
  taskId?: string;
}): void {
  BrowserWindow.getAllWindows().forEach((window) => {
    sendToLiveRenderer(window, IPC_CHANNELS.workspacePackageScriptTerminal, payload);
  });
}
let backgroundTerminalTaskRegistry: BackgroundTerminalTaskRegistry;
let codexBackgroundTerminalService: CodexBackgroundTerminalService | undefined;
const claudeBackgroundTaskRegistry = new ClaudeBackgroundTaskRegistry();
const systemSleepBlocker = new SystemSleepBlocker(powerSaveBlocker);
let applicationShutdownDeps: ApplicationShutdownDeps | undefined;

function syncSystemSleepBlocker(options: { refresh?: boolean } = {}): void {
  if (!applicationShutdownDeps || !conversationStore) {
    return;
  }
  try {
    const runningWork = hasRunningWork(collectRunningWorkSummary(applicationShutdownDeps));
    const scheduledWork = schedulingService?.hasWorkRequiringAwake() ?? false;
    const wasBlocking = systemSleepBlocker.isBlocking;
    systemSleepBlocker.sync(runningWork || scheduledWork, options);
    if (wasBlocking !== systemSleepBlocker.isBlocking || options.refresh) {
      logEcoDiag("system-sleep-blocker.changed", {
        blocking: systemSleepBlocker.isBlocking,
        runningWork,
        scheduledWork,
        refreshed: options.refresh ?? false,
      });
    }
  } catch (error) {
    process.stderr.write(
      `[eco] system sleep blocker sync failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
}

const interactiveTerminalManager = new InteractiveTerminalManager((event) => {
  backgroundTerminalTaskRegistry?.handleTerminalEvent(event);
  desktopEventCenter.publishTerminalEvent(event);
});
backgroundTerminalTaskRegistry = new BackgroundTerminalTaskRegistry(
  interactiveTerminalManager,
  syncSystemSleepBlocker,
);

function getCodexBackgroundTerminalService(): CodexBackgroundTerminalService {
  return (codexBackgroundTerminalService ??= new CodexBackgroundTerminalService({
    getClient: () => getGlobalCodexRuntimeLifecycle()?.getClient(),
    getClients: getCodexRuntimeClients,
    getClientForThread: getCodexRuntimeClientForThread,
    resolveEcoThreadId: (codexThreadId) => {
      const mapped = codexThreadMap?.getEcoThreadId(codexThreadId);
      if (mapped) {
        return mapped;
      }
      return codexThreadMap
        ? resolveCodexThreadAttribution(codexThreadMap, codexThreadId)?.ecoThreadId
        : undefined;
    },
  }));
}
const packageJsonWatcher = new PackageJsonWatcher((workspacePath) => {
  desktopEventCenter.publishPackageJsonChanged(workspacePath);
});
const workspaceReviewService = new WorkspaceReviewService(runGitCommand, (event) => {
  desktopEventCenter.publishGitDiffChanged(event);
  if (!event.error) workspaceGitStatusPublisher.schedule(event.workspacePath);
});
const workspaceGitStatusPublisher = new WorkspaceGitStatusPublisher(
  runGitCommand,
  (summary) => {
    desktopEventCenter.publishGitStatusChanged(summary);
  },
  undefined,
  async (workspacePath) => {
    const diff = await workspaceReviewService.getSummary(workspacePath);
    return {
      workspacePath,
      dirtyFileCount: diff.fileCount,
      insertions: diff.totalAdditions,
      deletions: diff.totalDeletions,
    };
  },
);
let gitAutoFetcher: GitAutoFetcher | undefined;
let activeGitOperations = 0;
const gitWorktrees = new GitWorktreeService(gitRunner);
let currentWorkspace: WorkspaceInfo | undefined;
let providerStore: ProviderStore;
let chatgptSubscriptionService: ChatGptSubscriptionService | undefined;
let chatgptSubscriptionServicePromise: Promise<ChatGptSubscriptionService> | undefined;
let agentOrchestrationStore: AgentOrchestrationStore;
let mcpStore: McpStore;
let mcpHubGateway: McpHubGateway;
let conversationStore: ConversationStore;
let projectTodoStore: ProjectTodoStore;
let conversationForkCommands: ConversationForkCommands | undefined;

function getConversationForkCommands(): ConversationForkCommands {
  return (conversationForkCommands ??= new ConversationForkCommands({
    store: conversationStore,
    ensureThreadRuntimeConfig,
    hasActiveRun: (threadId) => activeRunRuntimeState.hasRun(threadId),
    prepareHistory: async (_thread, history) => {
      for (const message of [...history.messages, history.target]) {
        for (const attachment of parsePromptImageAttachments(message.attachments)) {
          if (!attachment.contentRef || !(await promptImageFileStore.hasReadableContentRef(attachment)))
            throw new Error("分叉历史中的图片原图不可用，请重新发送该图片。");
        }
      }
    },
    forkNative: async (thread, history, childThreadId, onCreated) => {
      const binding = conversationStore.getThreadCoreSession(thread.id);
      if (!binding || !["claude", "codex", "pi"].includes(binding.coreKind))
        throw new Error("源会话缺少可恢复的原生绑定。");
      return forkNativeConversation({
        history,
        childThreadId,
        coreKind: binding.coreKind as "claude" | "codex" | "pi",
        sessionId: binding.externalSessionId,
        cwd: binding.cwd,
        ...(typeof binding.metadata?.sessionFile === "string"
          ? { sessionFile: binding.metadata.sessionFile }
          : {}),
        ecoDataDir: app.getPath("userData"),
        recoveryTitle: `eco-fork:${childThreadId}`,
        ...(resolveCodexExecutable() ? { codexExecutable: resolveCodexExecutable()! } : {}),
        codexHome: resolveCodexHomeDir(app.getPath("userData")),
        resolveClaudeUserId: (activityLineId) => resolveCurrentClaudeUserMessageId(thread.id, activityLineId),
        onCreated,
      });
    },
    cleanupNative: async (result) => {
      if (result.coreKind === "codex") {
        await (await ensureCodexControlPlaneClient()).request("thread/archive", {
          threadId: result.externalSessionId,
        });
      } else await cleanupNativeConversationFork(result);
    },
    validateRecoveredNative: (result) => {
      if (result.empty) return;
      const file = result.coreKind === "codex" ? result.metadata?.rolloutPath : result.metadata?.sessionFile;
      if (typeof file !== "string" || !existsSync(file))
        throw new Error("原生分支历史文件缺失，无法恢复该分叉。");
    },
  }));
}
let executeThreadDeleteCommand: ReturnType<typeof createThreadDeleteCommandCoordinator>;
let codexThreadMap: CodexThreadMap;
let workflowSettingsStore: WorkflowSettingsStore;
let projectMcpSettingsStore: ProjectMcpSettingsStore;
let projectIntegrationsSettingsStore: ProjectIntegrationsSettingsStore;
let projectOrchestrationSettingsStore: ProjectOrchestrationSettingsStore;
let projectSkillsSettingsStore: ProjectSkillsSettingsStore;
let gitSettingsStore: GitSettingsStore;
let personalizationSettingsStore: PersonalizationSettingsStore;
let browserSettingsStore: BrowserSettingsStore;
let computerUseSettingsStore: ComputerUseSettingsStore;
let computerUseGateway: ComputerUseMcpGateway;
let webChatListStore: WebChatListStore;
const webChatProxyControllers = new Map<ReturnType<typeof session.fromPartition>, WebChatProxyController>();
function webChatProxyControllerFor(siteId: string): WebChatProxyController {
  const siteSession = session.fromPartition(webChatSitePartition(siteId));
  let controller = webChatProxyControllers.get(siteSession);
  if (!controller) {
    controller = new WebChatProxyController(siteSession);
    webChatProxyControllers.set(siteSession, controller);
  }
  return controller;
}
let sshBookmarkStore: SshBookmarkStore;
let notificationSettingsStore: NotificationSettingsStore;
let browserHost: BrowserHost | undefined;
let ttsStore: TtsStore;
let ttsGateway: TtsMcpGateway;
let ttsReadAloud: TtsReadAloudService;
let imageGenerationStore: ImageGenerationStore;
let imageGenerationGateway: ImageGenerationMcpGateway;
let codexImages: CodexImageService;
let imageViewGateway: ImageViewMcpGateway;
let imageDisplayStore: ImageDisplayStore;
let imageDisplayGateway: ImageDisplayMcpGateway;
let htmlHostStore: HtmlHostStore;
let htmlHostGateway: HtmlHostMcpGateway;
let schedulingService: SchedulingService;
let schedulingGateway: SchedulingMcpGateway;
let composerReferenceService: ComposerReferenceService;
let browserSelectionService: BrowserSelectionService;
let contextReferenceGateway: ContextReferenceMcpGateway;
let integratedWebSearchGateway: IntegratedWebSearchMcpGateway;
let promptImageFileStore: PromptImageFileStore;

function requireBrowserHost(): BrowserHost {
  if (!browserHost) {
    throw new Error("BrowserHost is not initialized.");
  }
  return browserHost;
}

async function resolveCodexGlobalMcpServers(): Promise<CodexMcpServerForConfigSync[]> {
  // Eco exposes every MCP server through the per-thread Hub descriptor, and
  // that descriptor travels in the thread's own `thread/start` config. Keeping
  // `config.toml` free of `[mcp_servers.*]` lets independent threads load
  // concurrently instead of forcing a whole-file fingerprint change plus an
  // idle wait for each new thread. Direct stdio/HTTP entries and built-in Eco
  // gateways would also create a second dispatch path outside the Hub binding.
  return [];
}

function codexHubServerName(threadId: string): string {
  // Single source of truth lives in @eco/shared (packages/shared/src/eco-mcp-hub.ts);
  // the gateway derives the same name for Hub namespace repair.
  return ecoMcpHubServerName(threadId);
}
let asrSettingsStore: AsrSettingsStore;
let packageScriptArgsStore: PackageScriptArgsStore;
let proxyBridgeSettingsStore: ProxyBridgeSettingsStore;
let integratedWebSearchSettingsStore: IntegratedWebSearchSettingsStore;
let centerServerClient: SupabaseCenterDesktopClient;
let pendingThreadOpenId: string | undefined;
const desktopNotificationRetainer = new DesktopNotificationRetainer<Notification>();

function emitCenterServerStatus(): void {
  BrowserWindow.getAllWindows().forEach((window) => {
    window.webContents.send(IPC_CHANNELS.centerServerStatusChanged, centerServerClient.getSnapshot());
  });
}

function scheduleWorkspaceGitStatusPublish(workspacePath: string | undefined): void {
  if (!workspacePath?.trim()) {
    return;
  }
  workspaceGitStatusPublisher.schedule(workspacePath.trim());
  workspaceReviewService.invalidate(workspacePath.trim());
}

function scheduleWorkspaceGitStatusPublishForThread(threadId: string): void {
  scheduleWorkspaceGitStatusPublish(conversationStore.getThread(threadId)?.workspacePath);
}

const activeRunRuntimeState = new ActiveRunRuntimeStateStore();
const activeRunBillingState = new ActiveRunBillingStateStore();
const orchestrationGuardrails = resolveOrchestrationGuardrails();
const codexSubagentRuntimeLimit = new CodexSubagentRuntimeLimitController({
  maxRuntimeMs: orchestrationGuardrails.maxSubagentRuntimeMs,
  interruptTurn: async ({ agentId, turnId }) => {
    const client = getCodexRuntimeClientForThread(agentId);
    if (!client?.isInitialized) {
      throw new Error(`Codex app-server is unavailable; cannot interrupt child ${agentId} turn ${turnId}.`);
    }
    await client.request("turn/interrupt", { threadId: agentId, turnId });
  },
  onTimeout: ({ threadId, agentId, maxRuntimeMs }) => {
    const message = `Codex 子代理 ${agentId} 已运行 ${Math.round(maxRuntimeMs / 60_000)} 分钟，已单独停止。`;
    emitThreadEvent(threadId, "thread.subagent_runtime_limit", message, "system");
    logEcoDiag("codex.subagent_runtime_limit", {
      threadId: shortThreadId(threadId),
      agentId: shortAgentId(agentId),
      maxRuntimeMs,
    });
  },
  onInterruptError: ({ threadId, agentId, turnId, error }) => {
    const detail = errorMessage(error);
    const message = `Codex 子代理 ${agentId} 已超时，但停止失败：${detail}`;
    emitThreadEvent(threadId, "thread.subagent_runtime_limit_error", message, "system");
    process.stderr.write(
      `[eco-codex] timed-out subagent interrupt failed thread=${threadId} agent=${agentId} turn=${turnId}: ${detail}\n`,
    );
  },
});
const subagentConcurrencyGates = new Map<string, SubagentConcurrencyGate>();
const threadLiveRequestRegistry = new ThreadLiveRequestRegistry();

function runThreadRequestWithLiveRequestLifecycle(
  input: Omit<
    import("./thread-runtime-proxy-attempt.js").RunThreadRequestWithRuntimeProxyInput,
    "onAttemptSettled"
  > &
    Pick<
      Partial<import("./thread-runtime-proxy-attempt.js").RunThreadRequestWithRuntimeProxyInput>,
      "onAttemptSettled"
    >,
): Promise<ThreadRuntimeProxyResult> {
  return runThreadRequestWithRuntimeProxy({
    ...input,
    onAttemptSettled: (context) => {
      clearFinalizedLiveRequestsForAttempt(threadLiveRequestRegistry, context.threadId, context.runAttemptId);
      input.onAttemptSettled?.(context);
    },
  });
}

const conversationRecoveryGate = new ConversationRecoveryGate();
const pendingCancelDisposition = new Map<string, WorktreeCancelDisposition>();
const pendingEscalatedFollowUpDrain = new Set<string>();
const threadFollowUpDrainScheduler = new ThreadFollowUpDrainScheduler();
const threadFollowUpQueueControl = new ThreadFollowUpQueueControl();
const threadRunPreparations = new ThreadRunPreparationRegistry();
const titleGeneratingThreadIds = new Set<string>();
const editingThreadFollowUpByThread = new Map<string, string>();
const threadFollowUpOperationLocks = new Map<string, Promise<void>>();

async function withThreadFollowUpLock<T>(threadId: string, fn: () => Promise<T> | T): Promise<T> {
  const previous = threadFollowUpOperationLocks.get(threadId) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const current = previous.then(() => gate);
  threadFollowUpOperationLocks.set(threadId, current);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (threadFollowUpOperationLocks.get(threadId) === current) {
      threadFollowUpOperationLocks.delete(threadId);
    }
  }
}

function editingFollowUpClaimExclusion(threadId: string): string | undefined {
  return editingThreadFollowUpByThread.get(threadId);
}
/** Live Claude Query mid-turn inject ports (one per running Eco-run). */
const claudeMidTurnPorts = new ClaudeMidTurnPortRegistry();
/** Live Codex turn mid-turn inject ports (main regular turn only). */
const codexMidTurnPorts = new CodexMidTurnPortRegistry();
/** Recent streaming_push follow-up ids per thread for interrupt still_queued reconcile. */
const recentStreamingPushFollowUpIds = new Map<string, Set<string>>();
/** Follow-ups that already inserted a local user bubble (mid-turn between turns). Skip drain re-record. */
const midTurnLocalUserPromptFollowUpIds = new Set<string>();
const threadUsageAccumulator = new ThreadUsageAccumulator();
const proxyBillingStampRegistry = new ProxyBillingStampRegistry();
const codexGatewayUsageDeduplicator = new CodexGatewayUsageDeduplicator();
const codexGatewayUsagePending = new CodexGatewayUsagePendingBuffer({
  onDrop: (drop) => {
    process.stderr.write(
      `[eco-codex] dropping pending gateway usage reason=${drop.reason} codexThread=${drop.codexThreadId} turn=${drop.turnId}\n`,
    );
  },
});
let agentLifecycle: AgentLifecycleService;
let openaiAccountService: OpenAIAccountService | undefined;
let openaiAccountAssistant: OpenAIAccountAssistant | undefined;
let usageLedgerCoordinator: UsageLedgerCoordinator;
let subagentMetricsRegistry: SubagentMetricsRegistry;
const persistMetricsTimers = new Map<string, ReturnType<typeof setTimeout>>();
const pendingClaudeForksByThread = new Map<string, { sessionId: string; cwd: string }>();
const claudeUserMessageHydrationByThread = new Map<string, Promise<void>>();
const sdkStreamBridge = new SdkStreamActivityBridge();
let sdkStreamActivityIngestion: SdkStreamActivityIngestion;
let threadRunEventLivePersister: ReturnType<typeof createThreadRunEventLivePersister>;
let pricingCache: ModelsDevPricingCache;
let pricingCatalogReady: Promise<void> = Promise.resolve();
let codexModelCatalogService: CodexRemoteModelCatalogService | undefined;
let chatGptModelCatalogService: ChatGptModelCatalogService | undefined;
let billingRuntimeEnvironment: BillingRuntimeEnvironment;
let contextMonitor: ContextWindowMonitor;
let threadPromptCacheMonitor: ThreadPromptCacheMonitor;
let threadPromptCacheEpisodeMonitor: ThreadPromptCacheEpisodeMonitor;
let promptCacheRunEventEmitter: ReturnType<typeof createPromptCacheRunEventEmitter>;
let threadCacheHitMonitor: ThreadCacheHitMonitor;
let contextScheduler: ContextSnapshotScheduler;
let contextLifecycle: ContextLifecycleService;

interface ThreadCoreStartRunInput {
  thread: ThreadSummary;
  workspace: WorkspaceInfo;
  runtimeConfig: RuntimeConfig;
  prompt: string;
  attachments?: PromptImageAttachment[];
  roleRoutes: readonly RuntimeRoleRouteConfig[];
}

const threadRuntimeCoordinator = new ThreadRuntimeCoordinator<
  ThreadCoreStartRunInput,
  StartThreadContinuationInput,
  string,
  void,
  ThreadContinueResult,
  void
>();

threadRuntimeCoordinator.register({
  kind: "claude",
  start: dispatchClaudeThreadStart,
  continue: startClaudeThreadContinuation,
  cancel: (threadId) => {
    cancelClarificationsForThread(threadId, "cancelled by user");
    cancelBashApprovalsForThread(threadId, "cancelled by user");
    cancelPlanApprovalsForThreadKeepPending(threadId, "cancelled by user");
  },
});
threadRuntimeCoordinator.register({
  kind: "codex",
  start: (input) => startCodexThreadRun({ ...input, continuation: false }),
  continue: startCodexThreadContinuation,
  cancel: (threadId) => {
    cancelClarificationsForThread(threadId, "cancelled by user");
    cancelBashApprovalsForThread(threadId, "cancelled by user");
    cancelPlanApprovalsForThreadKeepPending(threadId, "cancelled by user");
  },
});
threadRuntimeCoordinator.register({
  kind: "pi",
  start: startPiThreadRunFromCoordinator,
  continue: startPiThreadContinuation,
  cancel: (threadId) => {
    void abortPiThread(threadId);
    activeRunRuntimeState.abortRun(threadId, "cancelled by user");
  },
});
threadRuntimeCoordinator.register({
  kind: "acp",
  start: (input) =>
    void startAcpThreadRun(
      toAcpThreadStartRunInput({
        thread: input.thread,
        workspace: input.workspace,
        prompt: resolveAcpRunPrompt({
          prompt: input.prompt,
          ...(input.attachments?.length ? { attachments: input.attachments } : {}),
        }),
        restorePrompt: input.prompt,
        ...(input.attachments?.length ? { attachments: input.attachments } : {}),
      }),
      acpRuntimeOrchestrationDeps(),
    ),
  continue: startAcpThreadContinuation,
  cancel: (threadId) => {
    cancelAcpThread(threadId);
    activeRunRuntimeState.abortRun(threadId, "cancelled by user");
  },
});

type SubagentDelegationLinker = (input: {
  agentId: string;
  agentType: string;
  parentToolUseId: string;
  prompt?: string;
  todoId?: string;
}) => void;
const subagentDelegationLinkersByThread = new Map<string, SubagentDelegationLinker>();

type AgentEventLike = Pick<AgentEvent, "id" | "type" | "payload" | "role" | "agentId" | "timestamp">;

function resolveRequestTerminalEventScope(input: { role: string; agentId?: string }): ThreadRunEventScope {
  if (input.agentId?.trim()) {
    return "agent";
  }
  return (SUBAGENT_ROLES as readonly string[]).includes(input.role) ? "agent" : "main";
}

function emitRequestTerminalUiEvent(
  threadId: string,
  input: {
    requestId: string;
    role: string;
    agentId?: string;
    stage: RequestTerminalStage;
    detail?: string;
    providerRequestId?: string;
  },
): void {
  const requestId = input.requestId.trim();
  if (!requestId || !conversationStore.getThread(threadId)) {
    return;
  }
  const eventType = requestTerminalLiveType(input.stage);
  const runAttemptId = resolveCurrentRunAttemptId(threadId);
  const observedAt = new Date().toISOString();
  const unique = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const agentId = input.agentId?.trim();
  try {
    conversationStore.appendConversationRuntimeEvent({
      id: `tre:${threadId}:${eventType}:${requestId}:${unique}`,
      threadId,
      eventType,
      scope: resolveRequestTerminalEventScope({
        role: input.role,
        ...(agentId && { agentId }),
      }),
      role: input.role,
      ...(agentId && { agentId }),
      requestId,
      streamState: "none",
      message: requestTerminalMessage(input.stage, input.detail),
      observedAt,
      ...(runAttemptId && { runAttemptId }),
      metadata: {
        liveType: eventType,
        ...(input.providerRequestId && {
          providerRequestId: input.providerRequestId,
        }),
      },
    });
    scheduleThreadRunProjectionUpdated(threadId);
  } catch (error) {
    process.stderr.write(`[eco] request terminal event write failed: ${errorMessage(error)}\n`);
  }
}

function emitRequestTerminalEvent(
  threadId: string,
  input: {
    requestId: string;
    role: string;
    agentId?: string;
    stage: RequestTerminalStage;
    detail?: string;
    providerRequestId?: string;
  },
): void {
  const requestId = input.requestId.trim();
  if (!requestId) {
    return;
  }
  emitRequestTerminalUiEvent(threadId, input);
  finalizeDisplayRequestTerminal(threadLiveRequestRegistry, threadId, requestId);
}

function startActiveRun(threadId: string, run: ActiveRunRuntimeStateInput): void {
  clearRequestStartedPersisted(threadId);
  activeRunRuntimeState.startRun(threadId, run);
  activeRunBillingState.startRun(threadId);
  getThreadSubagentConcurrencyGate(threadId).clear();
  syncSystemSleepBlocker();
  if (pendingEscalatedFollowUpDrain.has(threadId)) {
    queueMicrotask(() => {
      const thread = conversationStore.getThread(threadId);
      const followUp = conversationStore
        .listThreadFollowUps(threadId, { statuses: ["queued"] })
        .find((item) => item.priority === "escalated");
      if (thread && followUp && activeRunRuntimeState.hasRun(threadId)) {
        void requestEscalatedFollowUpInterrupt(thread, followUp).catch((error) => {
          process.stderr.write(
            `[eco] failed to interrupt starting follow-up (${threadId}): ${errorMessage(error)}\n`,
          );
        });
      }
    });
  }
}

function resolveAbortedRunReason(signal: AbortSignal, error?: unknown): string {
  if (
    error instanceof Error &&
    (error.name === "CodexTurnInterruptFailed" ||
      /turn\/interrupt.*failed|interrupt failed/i.test(error.message))
  ) {
    return `停止当前 Codex turn 失败：${error.message}`;
  }
  if (signal.reason instanceof Error && signal.reason.message.trim()) {
    return signal.reason.message.trim();
  }
  if (typeof signal.reason === "string" && signal.reason.trim()) {
    return signal.reason.trim();
  }
  return "cancelled by user";
}

function finishActiveRun(threadId: string): void {
  threadFollowUpQueueControl.finished(threadId);
  clearThreadCancelling(threadId);
  // Agent stopped operating this thread — drop the browser presence overlay now.
  browserHost?.clearAgentPresenceForThread(threadId);
  for (const active of threadLiveRequestRegistry.listActive(threadId)) {
    if (active.emitTimelineActivity) {
      emitRequestTerminalEvent(threadId, {
        requestId: active.logicalRequestId,
        role: active.role,
        ...(active.agentId && { agentId: active.agentId }),
        ...(active.providerRequestId && {
          providerRequestId: active.providerRequestId,
        }),
        stage: "cancelled",
      });
    } else {
      finalizeLiveRequest(threadLiveRequestRegistry, threadId, active.logicalRequestId);
    }
  }
  activeRunRuntimeState.finishRun(threadId);
  activeRunBillingState.clearRun(threadId);
  subagentConcurrencyGates.get(threadId)?.clear();
  subagentConcurrencyGates.delete(threadId);
  clearRequestStartedPersisted(threadId);
  threadLiveRequestRegistry.clearThread(threadId);
  proxyBillingStampRegistry.clearThread(threadId);
  syncSystemSleepBlocker();
}

function getThreadSubagentConcurrencyGate(threadId: string): SubagentConcurrencyGate {
  let gate = subagentConcurrencyGates.get(threadId);
  if (!gate) {
    gate = new SubagentConcurrencyGate({
      maxConcurrentSubagents: orchestrationGuardrails.maxConcurrentSubagents,
      readActiveSubagentCount: () => agentLifecycle.activeSubagentCount(threadId),
    });
    subagentConcurrencyGates.set(threadId, gate);
  }
  return gate;
}

const WINDOWS_TITLE_BAR_OVERLAY_HEIGHT = 40;

const WINDOW_CHROME_BY_THEME = {
  dark: {
    backgroundColor: "#212121",
    overlay: {
      color: "#212121",
      symbolColor: "#c8c8c8",
      height: WINDOWS_TITLE_BAR_OVERLAY_HEIGHT,
    },
  },
  light: {
    backgroundColor: "#ffffff",
    overlay: {
      color: "#ffffff",
      symbolColor: "#1a1a1a",
      height: WINDOWS_TITLE_BAR_OVERLAY_HEIGHT,
    },
  },
} as const;

const WINDOW_CONVERSATION_OVERLAY_COLOR_BY_THEME = {
  dark: "#171717",
  light: "#ffffff",
} as const;

function createStartupWindowUrl(): string {
  const iconPath = path.join(__dirname, "../renderer/splash-icon.png");
  const iconDataUrl = `data:image/png;base64,${readFileSync(iconPath).toString("base64")}`;
  const html = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Eco Coding</title>
    <style>
      html, body {
        width: 100%;
        height: 100%;
        margin: 0;
        background: transparent;
        overflow: hidden;
        -webkit-user-select: none;
        user-select: none;
      }
      #splash-icon {
        position: fixed;
        inset: 0;
        display: grid;
        place-items: center;
        pointer-events: none;
      }
      #splash-icon img {
        width: 96px;
        height: 96px;
        object-fit: contain;
        opacity: 0.92;
        -webkit-user-drag: none;
        user-select: none;
        animation: app-boot-splash-breathe 1.6s ease-in-out infinite;
      }
      @media (prefers-reduced-motion: reduce) {
        #splash-icon img { animation: none; }
      }
      @keyframes app-boot-splash-breathe {
        0%, 100% { opacity: 0.72; transform: scale(1); }
        50% { opacity: 1; transform: scale(1.03); }
      }
    </style>
  </head>
  <body>
    <div id="splash-icon" aria-hidden="true"><img src="${iconDataUrl}" alt="" width="96" height="96" /></div>
  </body>
</html>`;
  return `data:text/html;charset=UTF-8,${encodeURIComponent(html)}`;
}

const windowsUseConversationTitlebar = new WeakMap<BrowserWindow, boolean>();
const windowsAreBooting = new WeakSet<BrowserWindow>();
const BOOT_WINDOW_OVERLAY_SYMBOL_COLOR = "rgba(0, 0, 0, 0)";
const WINDOWS_MICA_OVERLAY_COLOR = "rgba(0, 0, 0, 0)";

function usesWindowControlsOverlay(): boolean {
  return process.platform === "win32" || process.platform === "linux";
}

function resolveWindowsMaterial(): "mica" | undefined {
  return resolveWindowsBackgroundMaterial(os.release());
}

function resolveWindowChromeTheme(): keyof typeof WINDOW_CHROME_BY_THEME {
  return nativeTheme.shouldUseDarkColors ? "dark" : "light";
}

function applyWindowControlsOverlay(window: BrowserWindow): void {
  if (!usesWindowControlsOverlay() || window.isDestroyed()) {
    return;
  }
  const chrome = WINDOW_CHROME_BY_THEME[resolveWindowChromeTheme()];
  const theme = resolveWindowChromeTheme();
  const overlayColor =
    process.platform === "win32" && resolveWindowsMaterial()
      ? WINDOWS_MICA_OVERLAY_COLOR
      : windowsUseConversationTitlebar.get(window)
        ? WINDOW_CONVERSATION_OVERLAY_COLOR_BY_THEME[theme]
        : chrome.overlay.color;

  if (process.platform === "win32") {
    const isWindows10 = resolveWindowsBackdropVersion(os.release()) === "win10";
    // Mica is rendered by DWM behind the window's system background. Do not use
    // Electron's transparent-window mode: it disables native Win32 interactions
    // in combination with the Window Controls Overlay.
    window.setBackgroundColor(isWindows10 ? chrome.backgroundColor : "#00000000");
    const material = resolveWindowsMaterial();
    if (material) {
      window.setBackgroundMaterial(material);
    }
  }

  window.setTitleBarOverlay({
    ...chrome.overlay,
    color: overlayColor,
    ...(windowsAreBooting.has(window) ? { symbolColor: BOOT_WINDOW_OVERLAY_SYMBOL_COLOR } : {}),
  });
}

function revealWindowControls(window: BrowserWindow): void {
  if (process.platform !== "win32" || window.isDestroyed()) {
    return;
  }
  windowsAreBooting.delete(window);
  window.setMinimizable(true);
  window.setMaximizable(true);
  window.setClosable(true);
  applyWindowControlsOverlay(window);
  applyPendingMaximizedRestore(window);
}

function syncWindowControlsOverlays(): void {
  if (!usesWindowControlsOverlay()) {
    return;
  }
  for (const window of BrowserWindow.getAllWindows()) {
    applyWindowControlsOverlay(window);
  }
}

function setWindowControlsOverlayMode(mode: "landing" | "conversation"): void {
  if (!usesWindowControlsOverlay()) {
    return;
  }
  for (const window of BrowserWindow.getAllWindows()) {
    windowsUseConversationTitlebar.set(window, mode === "conversation");
    applyWindowControlsOverlay(window);
  }
}

// Preferred startup size, used when there is no saved frame (first launch, or
// the saved display is gone). Both the size and the minimums are clamped to the
// work area of the display we open on, so a short display never gets a window
// that hangs off the bottom of the screen.
const MAIN_WINDOW_WIDTH = 1320;
const MAIN_WINDOW_HEIGHT = 860;
const MIN_MAIN_WINDOW_WIDTH = 480;
const MIN_MAIN_WINDOW_HEIGHT = 600;

/** Last window frame (size, position, display, maximized), persisted across launches. */
let windowStateStore: DesktopWindowStateStore | undefined;

/** Windows whose saved frame was maximized, waiting for a window that allows it. */
const pendingMaximizedWindows = new WeakSet<BrowserWindow>();

function readWindowState(window: BrowserWindow): DesktopWindowState | undefined {
  if (window.isDestroyed()) {
    return undefined;
  }
  // getNormalBounds(), not getBounds(): while maximized getBounds() returns the
  // display-sized frame, which would restore as a display-sized window instead
  // of the un-maximized size the user had.
  const bounds = window.getNormalBounds();
  return {
    bounds,
    displayId: screen.getDisplayMatching(bounds).id,
    isMaximized: window.isMaximized(),
  };
}

function saveWindowState(window: BrowserWindow): void {
  const state = readWindowState(window);
  if (!windowStateStore || !state) {
    return;
  }
  windowStateStore.save(state);
}

/**
 * Persist the frame as the user changes it, not only at quit: a crash or a
 * force-quit should still reopen where the window last was.
 */
function trackWindowState(window: BrowserWindow): void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const scheduleSave = () => {
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = undefined;
      saveWindowState(window);
    }, WINDOW_STATE_SAVE_DEBOUNCE_MS);
  };
  window.on("resize", scheduleSave);
  window.on("move", scheduleSave);
  // Not `once`: the quit guard can veto a close, and the frame must still be
  // written when that window closes for good later.
  window.on("close", () => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (!windowStateStore) {
      return;
    }
    // Quit may end the process before a queued write runs.
    const state = readWindowState(window);
    if (state) {
      windowStateStore.saveSync(state);
    }
  });
}

function requestMaximizedRestore(window: BrowserWindow): void {
  pendingMaximizedWindows.add(window);
  applyPendingMaximizedRestore(window);
}

function applyPendingMaximizedRestore(window: BrowserWindow): void {
  if (!pendingMaximizedWindows.has(window) || window.isDestroyed()) {
    return;
  }
  // While the Windows boot frame hides its caption controls the window is not
  // maximizable, and maximize() is ignored; retry when the controls are revealed.
  if (windowsAreBooting.has(window)) {
    return;
  }
  pendingMaximizedWindows.delete(window);
  if (!window.isMaximized()) {
    window.maximize();
  }
}

async function createMainWindow(
  options: { startupSplash?: boolean; show?: boolean } = {},
): Promise<BrowserWindow> {
  const isMac = process.platform === "darwin";
  const isStartupSplash = options.startupSplash === true;
  const windowControlsOverlay = usesWindowControlsOverlay();
  const isWindows = process.platform === "win32";
  const windowsChrome = WINDOW_CHROME_BY_THEME[resolveWindowChromeTheme()];
  const windowsMaterial = isWindows ? resolveWindowsMaterial() : undefined;
  const windowsBackdropVersion = isWindows ? resolveWindowsBackdropVersion(os.release()) : undefined;
  const initialSizing = resolveStartupWindowSizing(
    windowStateStore?.load(),
    MAIN_WINDOW_WIDTH,
    MAIN_WINDOW_HEIGHT,
    MIN_MAIN_WINDOW_WIDTH,
    MIN_MAIN_WINDOW_HEIGHT,
  );
  const windowOptions: BrowserWindowConstructorOptions = {
    ...initialSizing.bounds,
    // The boot splash is a progress indicator: it is shown explicitly (and
    // inactive) below, so it never becomes the key window. Otherwise launching
    // Eco steals keyboard focus from the app the user was already typing in.
    show: options.show ?? !isStartupSplash,
    ...(isStartupSplash ? { focusable: false } : {}),
    minWidth: initialSizing.minWidth,
    minHeight: initialSizing.minHeight,
    // macOS: frameless + traffic lights inset.
    // Windows and Linux: hidden title bar + native Window Controls Overlay.
    ...(isMac
      ? {
          titleBarStyle: "hiddenInset" as const,
          // Native vibrancy supplies translucency. An alpha-shaped window lets
          // macOS cast content-shaped shadows around sidebar text under scrims.
          transparent: false,
          backgroundColor: "#00000000",
          vibrancy: "under-window" as const,
          visualEffectState: "followWindow" as const,
        }
      : windowControlsOverlay
        ? {
            // Mica is a DWM backdrop, not a transparent Electron window.
            // Retaining the native frame preserves Win32 resize and caption
            // behavior while the renderer remains visually transparent.
            transparent: false,
            resizable: true,
            // Keep native caption controls out of the Windows boot frame until
            // the renderer reports that its initial app state is ready.
            ...(isWindows && !isStartupSplash
              ? {
                  minimizable: false,
                  maximizable: false,
                  closable: false,
                }
              : {}),
            titleBarStyle: "hidden" as const,
            titleBarOverlay: isWindows
              ? {
                  ...windowsChrome.overlay,
                  color: windowsMaterial ? WINDOWS_MICA_OVERLAY_COLOR : windowsChrome.overlay.color,
                  symbolColor: isStartupSplash
                    ? windowsChrome.overlay.symbolColor
                    : BOOT_WINDOW_OVERLAY_SYMBOL_COLOR,
                }
              : windowsChrome.overlay,
            ...(windowsMaterial ? { backgroundMaterial: windowsMaterial } : {}),
            backgroundColor: windowsBackdropVersion === "win10" ? windowsChrome.backgroundColor : "#00000000",
            // Keep accelerators; avoid a classic menu strip stacked under WCO.
            autoHideMenuBar: true,
          }
        : {
            backgroundColor: "#212121",
            autoHideMenuBar: true,
          }),
    ...(appIcon ? { icon: appIcon } : {}),
    ...(isStartupSplash ? { title: "Eco Coding" } : {}),
    webPreferences: {
      ...(!isStartupSplash ? { preload: path.join(__dirname, "../preload/index.cjs") } : {}),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      ...(!isStartupSplash ? { webviewTag: true } : {}),
      ...(windowsBackdropVersion
        ? {
            additionalArguments: [`--eco-windows-backdrop=${windowsBackdropVersion}`],
          }
        : {}),
    },
  };
  const window = new BrowserWindow(windowOptions);
  // Workspace HTML is a static, sandboxed preview. Block frame redirects to external sites too.
  window.webContents.on("will-frame-navigate", (event) => {
    if (
      !event.isMainFrame &&
      !event.url.startsWith("eco-workspace://") &&
      !/^about:(?:blank|srcdoc)(?:#.*)?$/.test(event.url) &&
      !isDevFeedReplayFrameUrl(event.url, { packaged: app.isPackaged, devServerUrl: process.env.VITE_DEV_SERVER_URL })
    ) {
      event.preventDefault();
    }
  });
  window.webContents.on("render-process-gone", (_event, details) => {
    logUpstream("desktop.render-process-gone", {
      webContentsId: window.webContents.id,
      reason: details.reason,
      exitCode: details.exitCode,
    });
  });
  if (isStartupSplash) {
    startupSplashWindows.add(window);
    // On screen right away, but ordered front without activating the app.
    window.showInactive();
    window.on("closed", () => {
      if (!desktopRendererReady && !desktopInitializationComplete) {
        app.quit();
      }
    });
  } else if (isWindows) {
    windowsAreBooting.add(window);
  }
  if (initialSizing.isMaximized) {
    requestMaximizedRestore(window);
  }
  // The boot splash is never resized by the user; only the real window writes back.
  if (!isStartupSplash) {
    trackWindowState(window);
  }

  if (app.isPackaged) {
    window.webContents.on("before-input-event", (event, input) => {
      if (isReloadShortcutInput(input)) {
        event.preventDefault();
      }
    });
  }

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalHttpUrl(url)) {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });

  if (isStartupSplash) {
    void window.loadURL(createStartupWindowUrl()).catch((error: unknown) => {
      const splashError = error instanceof Error ? error : new Error(String(error));
      logUpstream("desktop.startup-splash-load-failed", { message: splashError.message });
    });
    return window;
  }

  return loadMainWindow(window);
}

async function loadMainWindow(window: BrowserWindow): Promise<BrowserWindow> {
  if (process.platform === "win32") {
    windowsAreBooting.add(window);
    window.setMinimizable(false);
    window.setMaximizable(false);
    window.setClosable(false);
  }
  if (isDev) {
    try {
      await window.loadURL(process.env.VITE_DEV_SERVER_URL as string);
    } catch (error) {
      revealWindowControls(window);
      throw error;
    }
    // Auto-open devtools in detached mode during development. `activate: false`
    // keeps the detached devtools window from grabbing focus a third time.
    window.webContents.openDevTools({ mode: "detach", activate: false });
  } else {
    try {
      await window.loadFile(path.join(__dirname, "../renderer/index.html"));
    } catch (error) {
      revealWindowControls(window);
      throw error;
    }
  }
  if (browserHost) {
    installBrowserGuestBridge(window, browserHost);
  }
  attachMainWindowQuitGuard(window);
  return window;
}

async function waitForInitialDesktopRendererReady(timeoutMs = 180_000): Promise<void> {
  if (desktopRendererReady) {
    return;
  }
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      initialDesktopRendererReady,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("The desktop interface did not finish initializing.")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function isExternalHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

app
  .whenReady()
  .then(async () => {
    const startupStartedAt = Date.now();
    let startupWindow: BrowserWindow | undefined;
    const logStartupStage = (stage: string): void => {
      const elapsedMs = Date.now() - startupStartedAt;
      const fields = { stage, elapsedMs };
      if (app.isPackaged) {
        logUpstream("desktop.startup-stage", fields);
      } else {
        logEcoDiag("desktop.startup-stage", fields);
      }
    };

    logStartupStage("ready");
    protocol.handle("eco-workspace", (request) => workspaceFileStreams.respond(request));
    if (!hasSingleInstanceLock) {
      return;
    }
    // Read the saved frame before any window exists: the boot window has to open
    // where the last one closed, and an async read would show it centered first.
    windowStateStore = createDesktopWindowStateStore(
      path.join(app.getPath("userData"), WINDOW_STATE_FILE_NAME),
    );
    windowStateStore.load();
    startupWindow = await createMainWindow({ startupSplash: true });
    logStartupStage("startup-window.ready");
    // Let the OS hand eco://... deep links to this app.
    // Packaged only: in dev the scheme would register against the bare electron.exe,
    // which treats the URL as an app path and fails to launch.
    if (app.isPackaged) {
      app.setAsDefaultProtocolClient("eco");
    }
    if (appIcon && process.platform === "darwin") {
      app.dock?.setIcon(appIcon);
    }
    Menu.setApplicationMenu(
      Menu.buildFromTemplate(
        buildApplicationMenuTemplate(app.name, process.platform, (command, browserWindow) => {
          if (browserWindow instanceof BrowserWindow) {
            browserWindow.webContents.send(IPC_CHANNELS.appMenuCommand, command);
          }
        }),
      ),
    );
    const isLocalRendererWebContents = (webContents: Electron.WebContents | null): boolean => {
      if (!webContents) {
        return false;
      }
      try {
        return isLocalRendererUrl(webContents.getURL());
      } catch {
        return false;
      }
    };
    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
      const mediaTypes = (details as { mediaTypes?: string[] }).mediaTypes;
      callback(isAllowedSessionPermission(isLocalRendererWebContents(webContents), permission, mediaTypes));
    });
    session.defaultSession.setPermissionCheckHandler(
      (webContents, permission, _requestingOrigin, details) => {
        const mediaType = (details as { mediaType?: string }).mediaType;
        return isAllowedSessionPermission(
          isLocalRendererWebContents(webContents),
          permission,
          mediaType ? [mediaType] : undefined,
        );
      },
    );
    const dbPath = path.join(app.getPath("userData"), "eco-coding.sqlite");
    const todoSqlite = await import("node:sqlite");
    projectTodoStore = new ProjectTodoStore(new todoSqlite.DatabaseSync(dbPath), bytes => {
      const image = nativeImage.createFromBuffer(bytes);
      if (image.isEmpty()) return "";
      const size = image.getSize();
      return image.resize(size.width >= size.height ? { width: Math.min(240, size.width) } : { height: Math.min(180, size.height) }).toDataURL();
    });
    app.once("will-quit", () => projectTodoStore.close());
    providerStore = await createProviderStore(dbPath);
    agentOrchestrationStore = await createAgentOrchestrationStore(dbPath);
    mcpStore = await createMcpStore(dbPath);
    mcpHubGateway = new McpHubGateway();
    // The image store must be available before ConversationStore.initialize():
    // opening a legacy thread may need to materialize an attachment during its
    // lazy V2 migration.
    promptImageFileStore = new PromptImageFileStore(app.getPath("userData"));
    conversationStore = await createConversationStore(dbPath, {
      freshStorageMode: "v2_only",
      requiredStorageMode: null,
      promptImageFileStore,
    });
    logStartupStage("conversation-store.initialized");
    // Run reconciliation happens per conversation (conversationBootstrap and
    // repairConversationV2OnLoad). The startup sweep that walked every thread was
    // redundant with it.
    const startupToolRecovery = conversationStore.reconcileAllConversationV2TerminalRunTools();
    if (startupToolRecovery.settled > 0) {
      logEcoDiag("conversation-v2.startup-terminal-run-tool-recovery", startupToolRecovery);
    }
    const startupLedgerAttributionReconcile =
      conversationStore.reconcileAllConversationV2UsageLedgerAttribution();
    if (startupLedgerAttributionReconcile.attributed > 0 || startupLedgerAttributionReconcile.ambiguous > 0) {
      logEcoDiag("conversation-v2.startup-ledger-attribution-reconcile", startupLedgerAttributionReconcile);
    }
    // The accepted-prompt repair stays on the startup path because queue recovery
    // below delivers queued prompts without anyone opening the conversation. Its
    // candidates are only the conversations holding a queued user message.
    const startupAcceptedPromptDuplicateReconcile =
      conversationStore.reconcileAllConversationV2AcceptedPromptDuplicates();
    if (
      startupAcceptedPromptDuplicateReconcile.repaired > 0 ||
      startupAcceptedPromptDuplicateReconcile.ambiguous > 0
    ) {
      logEcoDiag(
        "conversation-v2.startup-accepted-prompt-duplicate-reconcile",
        startupAcceptedPromptDuplicateReconcile,
      );
    }
    logStartupStage("conversation-reconciliation.completed");
    executeThreadDeleteCommand = createThreadDeleteCommandCoordinator({
      conversationStore,
      cleanupExternalState: cleanupThreadExternalState,
      onDeleted: ({ threadId, workspacePath }) => {
        schedulingService?.threadDeleted(threadId);
        clearThreadRuntimeMemory(threadId);
        void requireBrowserHost().disposeThreadScope(threadId).catch((error) => {
          console.error("[browser] Deleted conversation cleanup failed", error);
        });
        emitThreadEvent(threadId, "thread.deleted", "对话已删除。", "system", false, {
          workspacePath,
        });
      },
    });
    conversationStore.conversationV2().onCommitted(({ event, effect }) => {
      desktopEventCenter.publish({
        kind: "conversation.sync_effect",
        threadId: event.conversationId,
        aggregateKey: `conversation:${event.conversationId}`,
        payload: {
          conversationId: event.conversationId,
          storeEpoch: event.storeEpoch,
          effect,
        },
      });
    });
    conversationStore.setPromptImageFileStore(promptImageFileStore);
    if (conversationStore.getConversationStorageMode() === "v2_only") {
      void promptImageFileStore
        .sweepUnreferencedContentObjects({
          resolveReferencedContentRefs: () => conversationStore.listReferencedPromptImageContentRefs(),
        })
        .then((result) => {
          if (result.removed > 0 || result.retainedReferenced > 0) {
            logEcoDiag("conversation-v2.prompt-image-object-gc", { ...result });
          }
        })
        .catch((error) => {
          process.stderr.write(`[eco] prompt image object GC failed: ${errorMessage(error)}\n`);
        });
    }
    await fs.rm(path.join(app.getPath("userData"), "codex-file-checkpoints"), {
      recursive: true,
      force: true,
    });
    // "指定子代理执行已批准计划": point the Codex hook-file arming at the resolved
    // CODEX_HOME, and drop any arm left over from a previous process.
    configureForcedPlanDelegationCodexHome(() => resolveCodexHomeDir(app.getPath("userData")));
    clearStaleForcedPlanDelegationState();
    subagentMetricsRegistry = new SubagentMetricsRegistry(conversationStore);
    usageLedgerCoordinator = new UsageLedgerCoordinator({
      store: conversationStore,
      metrics: subagentMetricsRegistry,
      logDiag: logEcoDiag,
      logDiagThrottled: logEcoDiagThrottled,
      onProxyAttributionSettled: async (threadId, settlements) => {
        await reconcileProxyAttributionContexts(
          {
            context: createUsageContextService({
              monitor: contextMonitor,
              emitLiveContext: (targetThreadId: string) =>
                contextScheduler.emitLiveFromMonitor(targetThreadId),
            }),
            subagentMetrics: subagentMetricsRegistry,
            schedulePersistThreadMetrics,
            logDiag: logEcoDiag,
          },
          threadId,
          settlements,
        );
        emitSubagentTimingUpdated(threadId);
      },
    });
    workflowSettingsStore = await createWorkflowSettingsStore(dbPath);
    logStartupStage("initial-settings.loaded");
    projectMcpSettingsStore = await createProjectMcpSettingsStore(dbPath);
    projectIntegrationsSettingsStore = await createProjectIntegrationsSettingsStore(dbPath);
    projectOrchestrationSettingsStore = await createProjectOrchestrationSettingsStore(dbPath);
    projectSkillsSettingsStore = await createProjectSkillsSettingsStore(dbPath);
    gitSettingsStore = await createGitSettingsStore(dbPath);
    personalizationSettingsStore = await createPersonalizationSettingsStore(dbPath);
    browserSettingsStore = await createBrowserSettingsStore(dbPath);
    computerUseSettingsStore = await createComputerUseSettingsStore(dbPath);
    computerUseGateway = new ComputerUseMcpGateway(() => computerUseSettingsStore.get());
    webChatListStore = await createWebChatListStore(dbPath);
    app.on("web-contents-created", (_event, contents) => {
      contents.on("login", (event, _details, authInfo, callback) => {
        const credentials = webChatProxyControllers.get(contents.session)?.credentials(authInfo);
        if (!credentials) return;
        event.preventDefault();
        callback(...credentials);
      });
    });
    app.once("before-quit", () => {
      for (const controller of webChatProxyControllers.values()) controller.dispose();
    });
    sshBookmarkStore = await createSshBookmarkStore(dbPath, createLocalSecretCodec());
    notificationSettingsStore = await createNotificationSettingsStore(dbPath);
    browserHost = new BrowserHost({
      getMainWindow,
      getSettings: () => browserSettingsStore,
      broadcast: (state: BrowserViewState) => {
        BrowserWindow.getAllWindows().forEach((window) => {
          if (!window.isDestroyed()) {
            window.webContents.send(IPC_CHANNELS.browserStateChanged, state);
          }
        });
      },
      broadcastAgentPresence: (event) => {
        BrowserWindow.getAllWindows().forEach((window) => {
          if (!window.isDestroyed()) {
            window.webContents.send(IPC_CHANNELS.browserAgentPresence, event);
          }
        });
      },
      resolveWorkspacePath: (threadId) => conversationStore.getThread(threadId)?.workspacePath,
      authorizeDownloadAccess: input => authorizeBrowserDownloadAccess(input, {
        context: threadId => {
          const thread = conversationStore.getThread(threadId);
          const agentId = agentLifecycle.usagePlannerAgentId(threadId);
          if (!thread || !agentId) throw new Error("Cannot attribute browser download access to an active conversation agent.");
          return {
            agentId,
            cwd: activeRunRuntimeState.worktreePlan(threadId)?.worktreePath || thread.sdkCwd || thread.workspacePath,
            mode: ensureThreadRuntimeConfig(thread).runtimeConfig?.bashReviewMode ?? "always",
          };
        },
        review: (request, toolInput) => reviewThreadToolApproval(input.threadId, request, {
          toolName: "BrowserDownload", toolInput,
        }, "browser"),
        requestHuman: request => registerPendingBashApproval(input.threadId, request),
        cancel: toolUseId => { resolvePendingBashApproval(toolUseId, { decision: "cancelled" }); },
        emit: (request, decision) => {
          const type = `bash_approval.${decision}` as const;
          const label = decision === "requested" ? "等待确认下载文件访问" : decision === "approved" ? "已允许下载文件访问" : "已拒绝下载文件访问";
          emitThreadEvent(input.threadId, type, `${label}：${input.file.name}`, "tool", false, bashApprovalEventExtras(request, type));
        },
      }),
    });
    const imageSecretCodec: ImageGenerationSecretCodec = {
      isAvailable: () => safeStorage.isEncryptionAvailable(),
      encrypt: (value) => `safe-v1:${safeStorage.encryptString(value).toString("base64")}`,
      decrypt: (value) => {
        if (!value.startsWith("safe-v1:")) throw new Error("创意绘画 API Key 存储格式无效。");
        return safeStorage.decryptString(Buffer.from(value.slice("safe-v1:".length), "base64"));
      },
    };
    imageGenerationStore = await createImageGenerationStore(dbPath, imageSecretCodec);
    imageGenerationGateway = new ImageGenerationMcpGateway({
      store: imageGenerationStore,
      generateCodex: (input, images, signal, route) => codexImages.generate(input, images, signal, route),
      resolveWorkspacePath: (threadId) => conversationStore.getThread(threadId)?.workspacePath,
      resolveGenerationRoot: (threadId) =>
        activeRunRuntimeState.worktreePlan(threadId)?.worktreePath ??
        conversationStore.getThread(threadId)?.sdkCwd ??
        conversationStore.getThread(threadId)?.workspacePath,
      onArtifactChanged: (artifact) => {
        BrowserWindow.getAllWindows().forEach((window) => {
          if (!window.isDestroyed())
            window.webContents.send(IPC_CHANNELS.imageGenerationArtifactChanged, artifact);
        });
      },
    });
    ttsStore = await createTtsStore(dbPath, imageSecretCodec);
    ttsReadAloud = new TtsReadAloudService(ttsStore);
    ttsGateway = new TtsMcpGateway({
      store: ttsStore,
      resolveWorkspacePath: (threadId) => conversationStore.getThread(threadId)?.workspacePath,
      resolveGenerationRoot: (threadId) =>
        activeRunRuntimeState.worktreePlan(threadId)?.worktreePath ??
        conversationStore.getThread(threadId)?.sdkCwd ??
        conversationStore.getThread(threadId)?.workspacePath,
      onArtifactChanged: (artifact) => {
        BrowserWindow.getAllWindows().forEach((window) => {
          if (!window.isDestroyed()) window.webContents.send(IPC_CHANNELS.ttsArtifactChanged, artifact);
        });
      },
    });
    imageViewGateway = new ImageViewMcpGateway({
      analyze: async ({ threadId, path: imagePath = "", ref, prompt, question, signal }) => {
        signal?.throwIfAborted();
        const requestedPrompt = prompt?.trim() || question?.trim() || "";
        if (!requestedPrompt) {
          throw new Error("image_view 调用必须提供 prompt。");
        }
        const file = ref
          ? (() => {
              const contextKey = `thread:${threadId}`;
              if (!conversationStore.isPromptImageContentRefAuthorized(contextKey, ref)) {
                throw new Error("图片 ref 未授权给当前线程。");
              }
              return promptImageFileStore.readContentRefAttachment(ref).then((resolved) => ({
                mimeType: resolved.mediaType,
                dataBase64: resolved.dataBase64,
              }));
            })()
          : readImageViewFile(imagePath);
        const resolvedFile = await file;
        signal?.throwIfAborted();
        if (!isPromptImageMediaType(resolvedFile.mimeType)) {
          throw new Error(`Unsupported image media type: ${resolvedFile.mimeType}`);
        }
        const attachments: PromptImageAttachment[] = [
          { mediaType: resolvedFile.mimeType, data: resolvedFile.dataBase64 },
        ];
        const agentId = `image_view:${threadId}:${randomUUID()}`;
        const runAttemptId = agentLifecycle.currentRunAttemptId(threadId);
        return runImageView(
          {
            threadId,
            prompt: requestedPrompt,
            attachments,
            billingAgentId: agentId,
            ...(signal ? { signal } : {}),
            ...(runAttemptId ? { runAttemptId } : {}),
          },
          createThreadImageViewHost(runAttemptId),
        );
      },
    });
    imageDisplayStore = await createImageDisplayStore(
      dbPath,
      path.join(app.getPath("userData"), "image-display"),
    );
    imageDisplayGateway = new ImageDisplayMcpGateway({
      store: imageDisplayStore,
      onArtifactChanged: (artifact) => {
        BrowserWindow.getAllWindows().forEach((window) => {
          if (!window.isDestroyed()) {
            window.webContents.send(IPC_CHANNELS.imageDisplayArtifactChanged, artifact);
          }
        });
      },
    });
    htmlHostStore = new HtmlHostStore();
    htmlHostGateway = new HtmlHostMcpGateway({
      store: htmlHostStore,
      api: {
        probeCapability: () => centerServerClient.refreshHtmlHostingCapability({ force: true }),
        publish: (input) => centerServerClient.publishHtmlPage(input),
      },
      getCapability: () => centerServerClient.refreshHtmlHostingCapability(),
      onArtifactChanged: (artifact) => {
        BrowserWindow.getAllWindows().forEach((window) => {
          if (!window.isDestroyed()) {
            window.webContents.send(IPC_CHANNELS.htmlHostArtifactChanged, artifact);
          }
        });
      },
    });
    const asrSecretCodec: AsrSecretCodec = {
      isAvailable: () => safeStorage.isEncryptionAvailable(),
      encrypt: (value) => `safe-v1:${safeStorage.encryptString(value).toString("base64")}`,
      decrypt: (value) => {
        if (!value.startsWith("safe-v1:")) {
          throw new Error("ASR API key 存储格式无效。");
        }
        return safeStorage.decryptString(Buffer.from(value.slice("safe-v1:".length), "base64"));
      },
    };
    asrSettingsStore = await createAsrSettingsStore(dbPath, asrSecretCodec);
    packageScriptArgsStore = createPackageScriptArgsStore(
      path.join(app.getPath("userData"), "package-script-args.json"),
    );
    await packageScriptArgsStore.warmCache();
    proxyBridgeSettingsStore = await createProxyBridgeSettingsStore(dbPath);
    const integratedWebSearchSecretCodec = {
      isAvailable: () => safeStorage.isEncryptionAvailable(),
      encrypt: (value: string) => `safe-v1:${safeStorage.encryptString(value).toString("base64")}`,
      decrypt: (value: string) => {
        if (!value.startsWith("safe-v1:")) {
          throw new Error("Integrated Web Search API key is stored in an unsupported format.");
        }
        return safeStorage.decryptString(Buffer.from(value.slice("safe-v1:".length), "base64"));
      },
    };
    integratedWebSearchSettingsStore = await createIntegratedWebSearchSettingsStore(
      dbPath,
      integratedWebSearchSecretCodec,
    );
    integratedWebSearchGateway = new IntegratedWebSearchMcpGateway({
      store: integratedWebSearchSettingsStore,
      getApiKey: () => integratedWebSearchSettingsStore.getApiKey() ?? undefined,
    });
    const centerServerSecretCodec = createElectronSafeStorageCenterServerSecretCodec(safeStorage);
    centerServerClient = new SupabaseCenterDesktopClient({
      store: await createCenterServerStore(dbPath, {
        ...(centerServerSecretCodec ? { secretCodec: centerServerSecretCodec } : {}),
      }),
      eventCenter: desktopEventCenter,
      log: (message) => process.stderr.write(message),
      onStatusChange: emitCenterServerStatus,
    });
    centerServerClient.setSettingsSyncHooks(
      createDesktopSettingsSyncHooks({
        providerStore,
        asrSettingsStore,
        imageGenerationStore,
        workflowSettingsStore,
        agentOrchestrationStore,
        proxyBridgeSettingsStore,
        integratedWebSearchSettingsStore,
        gitSettingsStore,
        personalizationSettingsStore,
        packageScriptArgsStore,
        projectOrchestrationSettingsStore,
        sshBookmarkStore,
      }),
    );
    // Warm the account catalog from disk before building synchronous agent settings.
    await getChatGptModelCatalogService().listModels();
    agentLifecycle = new AgentLifecycleService(conversationStore);
    codexThreadMap = new ConversationStoreCodexThreadMap(conversationStore);
    const defaultUpstreamUserAgent = buildDefaultUpstreamUserAgent({
      version: app.getVersion(),
      platform: os.platform(),
      release: os.release(),
      arch: os.arch(),
    });
    // Provider probes / model lists run outside the gateway: give them the same fallback.
    setDefaultUpstreamUserAgent(defaultUpstreamUserAgent);
    configureEcoGatewayLifecycle({
      ecoDataDir: app.getPath("userData"),
      listProviders: async () => {
        // The built-in ChatGPT provider may have been persisted by an older
        // version. Migrate it before every Gateway sync so stale auth metadata
        // cannot bypass the subscription Responses contract.
        ensureChatGptSubscriptionProvider();
        const routeModels = new Map<string, string[]>();
        for (const profile of providerStore.listRouteProfiles()) {
          for (const route of profile.routes) {
            const models = routeModels.get(route.providerId) ?? [];
            models.push(route.modelId);
            routeModels.set(route.providerId, models);
          }
        }
        return Promise.all(
          providerStore
            .listProvidersWithSecrets()
            .filter((provider) => provider.apiCompat !== "system_one")
            .map(async (provider) => {
              const candidates = provider.authMethod === "chatgpt_subscription"
                ? (await getChatGptModelCatalogService().listModels()).map((model) => ({ modelId: model.modelId, manualSpec: undefined, modelsDevMapping: undefined }))
                : providerStore.listCandidateModels(provider.id);
              const modelIds = [
                ...new Set([
                  provider.defaultModel,
                  ...candidates.map((model) => model.modelId),
                  ...(routeModels.get(provider.id) ?? []),
                ]),
              ].filter(Boolean);
              const models = await Promise.all(
                modelIds.map(async (modelId) => {
                  const candidate = candidates.find((model) => model.modelId === modelId);
                  const resolved = await pricingCache.resolveContextLimit(
                    provider.baseUrl,
                    modelId,
                    candidate?.modelsDevMapping,
                    candidate?.manualSpec?.contextTokens,
                    candidate?.manualSpec?.maxOutputTokens,
                  );
                  return {
                    modelId,
                    ...(candidate?.manualSpec?.supportsImageInput !== undefined && {
                      supportsImageInput: candidate.manualSpec.supportsImageInput,
                    }),
                    contextTokens: resolveEffectiveContextLimit(
                      resolved.limit,
                      workflowSettingsStore.get().contextWindowLimitTokens,
                    ),
                    ...(resolved.maxOutputTokens !== undefined && {
                      maxOutputTokens: resolved.maxOutputTokens,
                    }),
                  };
                }),
              );
              return {
                id: provider.id,
                name: provider.name,
                enabled: provider.enabled,
                baseUrl: provider.baseUrl,
                requestPath: provider.requestPath,
                version: provider.version,
                apiKey: provider.apiKey,
                ...(provider.authMethod ? { authMethod: provider.authMethod } : {}),
                ...(provider.credentialPoolId ? { credentialPoolId: provider.credentialPoolId } : {}),
                ...(provider.upstreamProxyUrl ? { upstreamProxyUrl: provider.upstreamProxyUrl } : {}),
                apiCompat: resolveUpstreamApiCompat(undefined, provider.apiCompat),
                ...(provider.tokenCountMode && { tokenCountMode: provider.tokenCountMode }),
                defaultModel: provider.defaultModel,
                models,
                modelIds: routeModels.get(provider.id) ?? [],
              };
            }),
        );
      },
      getUpstreamUserAgent: () => resolveUpstreamUserAgentOverride(proxyBridgeSettingsStore.get()),
      getUpstreamUserAgents: () => resolveUpstreamUserAgentOverrides(proxyBridgeSettingsStore.get()),
      getDefaultUpstreamUserAgent: () => defaultUpstreamUserAgent,
      getUpstreamProxyUrl: () => resolveOutboundProxyUrl(proxyBridgeSettingsStore.get()),
      getGatewayCredentialResolver:
        () =>
        async ({ provider }) => {
          const service = await getChatGptSubscriptionService();
          return service.resolveCredential(provider);
        },
      getGatewayCredentialReporter:
        () =>
        async (result) => {
          const service = await getChatGptSubscriptionService();
          await service.reportCredentialResult(result);
        },
      getTurnRouteRegistry: () => getCodexTurnRouteRegistry(),
      resolveEcoThreadIdFromCodex: (codexThreadId) =>
        codexThreadMap.getEcoThreadId(codexThreadId) ??
        resolveCodexThreadAttribution(codexThreadMap, codexThreadId)?.ecoThreadId,
      onToolWriteStarted: (observation) => {
        emitCodexToolWriteActivity(observation);
      },
      prepareClaudeMessages: async ({ path, body, model, headers }) => {
        const { prepareClaudeBridgeMessagesRequest } = await import("./anthropic-proxy");
        return prepareClaudeBridgeMessagesRequest({
          path,
          body,
          requestedModel: model,
          headers,
        });
      },
      resolveMessagesRoute: ({ model, headers }) => {
        const resolved = resolveClaudeBridgeRoute(model, headers);
        if (!resolved) return undefined;
        return {
          providerId: resolved.providerId,
          upstreamModelId: resolved.upstreamModelId,
          upstreamKind: resolved.upstreamKind,
        };
      },
      getGlobalMaxOutputTokens: () => workflowSettingsStore.get().maxOutputLimitTokens,
      onUsage: async (event) => {
        const dispatch = classifyGatewayUsageEvent(event);
        if (dispatch.kind === "claude_messages") {
          // Synchronously reserve settle before any await so proxy.close() cannot race past billing.
          const releaseUsageSettle = globalClaudeBridgeBindingRegistry.reserveUsageSettle(
            event.bridgeBindingId,
          );
          try {
            const binding = event.bridgeBindingId?.trim()
              ? globalClaudeBridgeBindingRegistry.getByBindingId(event.bridgeBindingId)
              : undefined;
            const stampThreadId = event.threadId?.trim() || binding?.threadId?.trim();
            const logicalRequestId = event.logicalRequestId?.trim();
            const frozen =
              stampThreadId && logicalRequestId
                ? resolveFrozenLiveRequestAttribution(
                    threadLiveRequestRegistry,
                    stampThreadId,
                    logicalRequestId,
                  )
                : undefined;
            const stampedAgentId = frozen?.agentId?.trim();
            const stampedBillingRole = frozen?.role?.trim() as RuntimeAgentRole | undefined;
            const handled = await emitClaudeGatewayUsageIfSession({
              providerId: event.providerId,
              requestedModel: event.requestedModel,
              upstreamModelId: event.upstreamModelId,
              usage: event.usage,
              ...(event.providerRequestId ? { requestId: event.providerRequestId } : {}),
              ...(event.bridgeBindingId ? { bridgeBindingId: event.bridgeBindingId } : {}),
              ...(logicalRequestId ? { logicalRequestId } : {}),
              ...(event.ttftMs !== undefined && { ttftMs: event.ttftMs }),
              ...(event.generationMs !== undefined && {
                generationMs: event.generationMs,
              }),
              ...(event.firstHeadersMs !== undefined && {
                firstHeadersMs: event.firstHeadersMs,
              }),
              ...(event.firstTokenMs !== undefined && {
                firstTokenMs: event.firstTokenMs,
              }),
              ...(stampedAgentId ? { stampedAgentId } : {}),
              ...(stampedBillingRole ? { stampedBillingRole } : {}),
            });
            if (!handled) {
              // Title/approval/aux or closed binding — do not fall into Codex turn billing.
              logEcoDiag("messages.usage_unattributed", {
                providerId: event.providerId,
                requestedModel: event.requestedModel,
                upstreamModelId: event.upstreamModelId,
                sourceEventId: event.sourceEventId,
                reason: "no_claude_bridge_binding_or_route",
              });
              process.stderr.write(
                `[eco] messages usage not billed: no Claude bridge binding route ` +
                  `provider=${event.providerId} model=${event.upstreamModelId || event.requestedModel}\n`,
              );
            }
          } finally {
            releaseUsageSettle?.();
          }
          return;
        }
        if (dispatch.kind === "unbillable") {
          logEcoDiag("gateway.usage_unbillable", {
            source: event.source,
            reason: dispatch.reason,
            providerId: event.providerId,
            requestedModel: event.requestedModel,
            sourceEventId: event.sourceEventId,
          });
          process.stderr.write(
            `[eco] ${event.source} usage will not be billed: ${dispatch.reason} ` +
              `provider=${event.providerId} model=${event.upstreamModelId || event.requestedModel}\n`,
          );
          return;
        }
        await handleCodexGatewayUsage(event);
      },
      onRequestLifecycle: (event) => {
        const lifecycleEvent = event.threadId
          ? {
              ...event,
              threadId:
                codexThreadMap.getEcoThreadId(event.threadId) ??
                event.threadId,
            }
          : event;
        handleGatewayRequestLifecycleEvent(lifecycleEvent, {
          onUpstreamRequestId: ({ threadId, role, requestId, logicalRequestId }) => {
            adoptLiveProviderRequestId(threadId, logicalRequestId, requestId);
          },
          onUpstreamConnectionError: (input) => {
            if (input.errorInfo?.code === "subscription_sharing_usage_limit_exceeded") {
              return;
            }
            emitUpstreamConnectionErrorActivity(input);
          },
          onLogicalCompleted: ({ threadId, role, logicalRequestId }) => {
            emitLogicalRequestTerminal(threadId, role, logicalRequestId, "completed");
          },
          onLogicalFailed: ({
            threadId,
            role,
            error,
            statusCode,
            logicalRequestId,
            accountId,
            providerRequestId,
            responseId,
            turnId,
            runAttemptId,
            errorInfo,
          }) => {
            // Keep the upstream reason. Collapsing to `HTTP <code>` loses the provider
            // body (for example "Context window exhausted") and leaves users with a
            // bare status code and no explanation.
            const detail = error.trim() || (statusCode !== undefined ? `HTTP ${statusCode}` : "");
            if (errorInfo?.code === "subscription_sharing_usage_limit_exceeded") {
              const handled = handleSubscriptionUsageLimitFailure({
                threadId,
                role,
                logicalRequestId,
                errorInfo,
                ...(turnId ? { turnId } : {}),
                ...(runAttemptId ? { runAttemptId } : {}),
                ...(accountId ? { accountId } : {}),
                ...(providerRequestId ? { providerRequestId } : {}),
                ...(responseId ? { responseId } : {}),
                ...(statusCode !== undefined ? { statusCode } : {}),
              });
              if (!handled) return;
            }
            emitLogicalRequestTerminal(threadId, role, logicalRequestId, "failed", detail);
          },
          onLogicalCancelled: ({ threadId, role, reason, logicalRequestId }) => {
            emitLogicalRequestTerminal(threadId, role, logicalRequestId, "cancelled", reason);
          },
        });
      },
      onStderr: (chunk) => process.stderr.write(chunk.endsWith("\n") ? chunk : `${chunk}\n`),
    });
    configureCodexRuntimeRun({
      ecoDataDir: app.getPath("userData"),
      getGlobalUserRules: () => personalizationSettingsStore.get().globalRules,
      getGlobalContextWindowLimit: () => workflowSettingsStore.get().contextWindowLimitTokens,
      listAccountModels: () => getCodexModelCatalogService().listRuntimeModels(),
      enrichCatalogRoutes: async (routes) => {
        const providers = providerStore.listProviders();
        const byId = new Map(providers.map((provider) => [provider.id, provider]));
        const enriched: CodexGatewayCatalogRoute[] = [];
        for (const route of routes) {
          if (typeof route.manualSpec?.contextTokens === "number" && route.manualSpec.contextTokens > 0) {
            enriched.push(route);
            continue;
          }
          const provider = byId.get(route.providerId);
          if (!provider) {
            enriched.push(route);
            continue;
          }
          const candidate = providerStore
            .listCandidateModels(provider.id)
            .find((model) => model.modelId === route.modelId);
          const manualContext = candidate?.manualSpec?.contextTokens;
          const mapping = candidate?.modelsDevMapping;
          let contextTokens: number | undefined =
            typeof manualContext === "number" && manualContext > 0 ? manualContext : undefined;
          if (contextTokens === undefined) {
            const lookup = await pricingCache.lookupLimitsForRoute({
              baseUrl: provider.baseUrl,
              modelId: route.modelId,
              ...(mapping && { mapping }),
            });
            if (lookup?.limits.contextTokens && lookup.limits.contextTokens > 0) {
              contextTokens = lookup.limits.contextTokens;
            }
          }
          if (contextTokens === undefined) {
            enriched.push(route);
            continue;
          }
          enriched.push({
            ...route,
            manualSpec: {
              ...(route.manualSpec ?? {}),
              contextTokens,
            },
          });
        }
        return enriched;
      },
      listProviders: () =>
        providerStore
          .listProviders()
          .filter((provider) => provider.apiCompat !== "system_one")
          .map((provider) => ({
            id: provider.id,
            name: provider.name,
            enabled: provider.enabled,
            apiCompat: resolveUpstreamApiCompat(undefined, provider.apiCompat),
            defaultModel: provider.defaultModel,
            models: providerStore.listCandidateModels(provider.id).map((model) => ({
              modelId: model.modelId,
              ...(model.displayName ? { displayName: model.displayName } : {}),
              ...(model.manualSpec
                ? {
                    manualSpec: {
                      ...(model.manualSpec.contextTokens !== undefined
                        ? { contextTokens: model.manualSpec.contextTokens }
                        : {}),
                      ...(model.manualSpec.supportsImageInput !== undefined
                        ? {
                            supportsImageInput: model.manualSpec.supportsImageInput,
                          }
                        : {}),
                      ...(model.manualSpec.supportsRemoteCompaction !== undefined
                        ? { supportsRemoteCompaction: model.manualSpec.supportsRemoteCompaction }
                        : {}),
                    },
                  }
                : {}),
            })),
          })),
      listCatalogRouteConfigs: () => {
        const routes: {
          providerId: string;
          modelId: string;
          apiCompat: import("../shared/api-compat").ChatApiCompat;
          displayName?: string;
          manualSpec?: { contextTokens?: number; supportsImageInput?: boolean };
        }[] = [];
        for (const profile of providerStore.listRouteProfiles()) {
          for (const route of profile.routes) {
            const provider = providerStore.listProviders().find((p) => p.id === route.providerId);
            if (!provider || !route.modelId.trim()) {
              continue;
            }
            routes.push({
              providerId: route.providerId,
              modelId: route.modelId,
              apiCompat: resolveUpstreamApiCompat(route.apiCompat, provider.apiCompat),
              displayName: `${provider.name} / ${route.modelId}`,
              ...(route.manualSpec
                ? {
                    manualSpec: {
                      ...(route.manualSpec.contextTokens !== undefined
                        ? { contextTokens: route.manualSpec.contextTokens }
                        : {}),
                      ...(route.manualSpec.supportsImageInput !== undefined
                        ? {
                            supportsImageInput: route.manualSpec.supportsImageInput,
                          }
                        : {}),
                    },
                  }
                : {}),
            });
          }
        }
        return routes;
      },
      listCatalogOrchestrationAgents: () => listCodexCatalogRoutesFromSettings(),
      listCatalogThreadRoutes: () => listCodexCatalogRoutesFromThreadSnapshots(),
      listGlobalMcpServers: resolveCodexGlobalMcpServers,
      threadMap: codexThreadMap,
      resolveRunAttemptId: (threadId) => agentLifecycle.currentRunAttemptId(threadId),
      appendConversationRuntimeEvent: (event) => {
        try {
          if (!conversationStore.getThread(event.threadId)) {
            throw new Error(`Refusing Codex event for unknown thread ${event.threadId}.`);
          }
          maybeRevealBrowserFromThreadRunEvent(event);
          const persisted = conversationStore.appendConversationRuntimeEvent(event);
          confirmForcedPlanDelegationFromRuntimeEvent(persisted);
          if (persisted.eventType === "run.attempt.started" && isRecord(persisted.metadata)) {
            const codexThreadId =
              typeof persisted.metadata.codexThreadId === "string"
                ? persisted.metadata.codexThreadId.trim()
                : "";
            const turnId =
              typeof persisted.metadata.turnId === "string" ? persisted.metadata.turnId.trim() : "";
            const attribution = codexThreadId
              ? resolveCodexThreadAttribution(codexThreadMap, codexThreadId)
              : undefined;
            if (codexThreadId && turnId && attribution?.isSubagentThread) {
              codexSubagentRuntimeLimit.start({
                threadId: persisted.threadId,
                agentId: codexThreadId,
                turnId,
              });
            }
          } else if (
            (persisted.eventType === "agent.stopped" || persisted.eventType === "agent.abandoned") &&
            persisted.agentId
          ) {
            codexSubagentRuntimeLimit.stop(persisted.agentId);
          }
          applyCodexSubagentLifecycleEvent(persisted, {
            getAgentState: (threadId, agentId) => {
              const agent = conversationStore
                .listAgentInstances(threadId)
                .find((candidate) => candidate.agentId === agentId);
              return agent
                ? {
                    status: agent.status,
                    ...(agent.parentToolUseId && {
                      parentToolUseId: agent.parentToolUseId,
                    }),
                  }
                : undefined;
            },
            resolvePhase: (threadId) => {
              const mode = conversationStore.getThread(threadId)?.runtimeConfig?.sessionMode;
              return mode === "plan" ? "planning" : mode === "ask" ? "ask" : "execution";
            },
            startSession: (input) => conversationStore.upsertSubagentSessionActive(input),
            stopSession: (threadId, agentId) =>
              conversationStore.markSubagentSessionStopped(threadId, agentId),
            startMetrics: (threadId, input) => subagentMetricsRegistry.onSubagentStart(threadId, input),
            stopMetrics: (threadId, input) => subagentMetricsRegistry.onSubagentStop(threadId, input),
            startAgent: (input) => {
              agentLifecycle.startSubagent(input);
            },
            stopAgent: (input) => agentLifecycle.stopSubagent(input),
            abandonAgent: (input) => agentLifecycle.abandonSubagent(input),
          });
        } catch (error) {
          reportConversationRuntimeEventFailure({
            event,
            error,
            appendEvent: (failure) => {
              conversationStore.appendConversationRuntimeEvent(failure);
            },
            onProjectionUpdated: (threadId) => {
              scheduleThreadRunProjectionUpdated(threadId, { streaming: false });
            },
            logError: (message) => process.stderr.write(`${message}\n`),
          });
        }
      },
      bindLatestUserPromptToCodexItem: (threadId, itemId, turnId, clientUserMessageId) => {
        const bound = Boolean(
          conversationStore.bindLatestUserRunEventToSdkMessage(threadId, itemId, clientUserMessageId),
        );
        if (bound && turnId) conversationStore.bindCodexForkTurn(threadId, itemId, turnId);
        return bound;
      },
      resolveCodexForkTurnIndex: (threadId, itemId) =>
        conversationStore.resolveCodexUserTurnIndex(threadId, itemId),
      pruneThreadAfterCodexFork: (threadId, itemId) => {
        conversationStore.rewindThreadToActivityLine(threadId, sdkActivityLineId(itemId));
        resetThreadRuntimeAfterHistoryRewrite(threadId);
        scheduleThreadRunProjectionUpdated(threadId, { streaming: false });
      },
      scheduleThreadRunProjectionUpdated,
      onCodexThreadMapped: flushPendingCodexGatewayUsage,
      onCodexThreadAttributionRecorded: flushPendingCodexGatewayUsage,
      onCodexTurnTokenUsage: ({ threadId, codexThreadId, turnId, appServerTokenUsage }) => {
        void handleCodexAppServerTurnUsage({ threadId, codexThreadId, turnId, appServerTokenUsage }).catch(
          (error) => {
            process.stderr.write(
              `[eco-codex] app-server turn usage billing failed thread=${threadId}: ${errorMessage(error)}\n`,
            );
          },
        );
      },
      onCodexContextUpdated: (resolution) => {
        void (async () => {
          const modelId = resolution.context.modelId;
          const catalogLimit =
            resolution.providerId === "openai" && modelId
              ? requireCodexAccountContextWindow(
                  await getCodexModelCatalogService().listRuntimeModels(),
                  modelId,
                )
              : undefined;
          return contextMonitor.updateOccupied(
            resolution.ecoThreadId,
            resolution.billingRole,
            resolution.contextOccupied,
            {
              limit: resolution.context.limit,
              ...(modelId ? { modelId } : {}),
              ...(catalogLimit !== undefined ? { catalogLimit } : {}),
            },
          );
        })()
          .then(() => contextScheduler.emitLiveFromMonitor(resolution.ecoThreadId))
          .catch((error) => {
            process.stderr.write(
              `[eco-codex] context update failed thread=${resolution.ecoThreadId}: ${errorMessage(error)}\n`,
            );
          });
      },
      onCodexTurnPlanUpdated: ({ ecoThreadId, plan }) => {
        if (!conversationStore.getThread(ecoThreadId)) {
          process.stderr.write(
            `[eco-codex] turn/plan/updated references unknown Eco thread ${ecoThreadId}\n`,
          );
          return;
        }
        applyCodexTurnPlanProgress({
          threadId: ecoThreadId,
          plan,
          services: {
            listTodos: (threadId) => conversationStore.listCoderTodos(threadId),
            replaceTodos: (threadId, todos) => conversationStore.replaceCoderTodos(threadId, todos),
            emitTodoList,
          },
        });
      },
      onCodexPlanReady: ({ ecoThreadId, plan, planFilePath }) => {
        const thread = conversationStore.getThread(ecoThreadId);
        const worktreePath = resolveThreadWorktreePath(ecoThreadId);
        const runtime = resolveRuntimeConfigForThreadId(ecoThreadId);
        if (!thread) {
          markThreadInterrupted(ecoThreadId, "Codex Plan completed for an unknown Eco thread.");
          return;
        }
        if (!worktreePath) {
          markThreadInterrupted(ecoThreadId, "Codex Plan completed without a persisted worktree path.");
          return;
        }
        if (!runtime.ok) {
          markThreadInterrupted(ecoThreadId, runtime.reason);
          return;
        }
        const activityLines = conversationStore.listActivityLines(ecoThreadId);
        const latestUserPrompt = [...activityLines]
          .reverse()
          .find((line) => line.role === "user" && line.message.trim())
          ?.message.trim();
        captureThreadPlanReady({
          threadId: ecoThreadId,
          workspacePath: thread.workspacePath,
          worktreePath,
          routesJson: JSON.stringify(runtime.routes),
          payload: {
            userPrompt: latestUserPrompt || thread.prompt,
            analysis: "",
            plan,
            ...(planFilePath ? { planFilePath } : {}),
          },
          awaitingPlanMessage: "",
        });
        updateThread(ecoThreadId, {
          status: "awaiting_plan",
          message: "",
        });
      },
      onCodexAsyncQuestions: (input) => handleCodexAsyncQuestions(input),
      onStderr: (message) => process.stderr.write(`${message}\n`),
    });
    configureCodexApprovalBridge({
      resolveEcoThreadId: (codexThreadId) => codexThreadMap.getEcoThreadId(codexThreadId) ?? codexThreadId,
      getThread: (threadId) => {
        const thread = conversationStore.getThread(threadId);
        return thread ? { prompt: thread.prompt, workspacePath: thread.workspacePath } : undefined;
      },
      getWorktreePath: (threadId) => activeRunRuntimeState.worktreePlan(threadId)?.worktreePath,
      getPlannerAgentId: (threadId) => agentLifecycle.usagePlannerAgentId(threadId),
      getMcpHubServerName: (threadId) => mcpHubGateway.getThreadCodexServerName(threadId),
      getMcpToolApprovalTarget: (server, tool) => mcpStore.getToolApprovalTarget(server, tool),
      isMcpToolApproved: (target) => mcpStore.isToolApproved(target),
      getApprovalMode: (threadId) => {
        const thread = conversationStore.getThread(threadId);
        return thread
          ? (ensureThreadRuntimeConfig(thread).runtimeConfig?.bashReviewMode ?? "always")
          : "always";
      },
      getBrowserOpenApprovalMode: () => browserSettingsStore.get().openApprovalMode,
      getComputerUseActionApprovalMode: () => computerUseSettingsStore.get().actionApprovalMode,
      getWebSearchApprovalMode: () => integratedWebSearchSettingsStore.get().approvalMode,
      noteUpcomingImageGenerationTool: (threadId, toolName, toolUseId) => {
        imageGenerationGateway.noteUpcomingTool(threadId, toolName, toolUseId);
        ttsGateway.noteUpcomingTool(threadId, toolName, toolUseId);
      },
      reviewApproval: (threadId, request, tool) => reviewThreadToolApproval(threadId, request, tool, "codex"),
      injectCodexApprovalFeedback: async ({ ecoThreadId, codexThreadId, turnId, toolUseId, text }) => {
        const phase = codexMidTurnPorts.getPhase(ecoThreadId);
        if (phase === "accepting") {
          const pushed = await codexMidTurnPorts.tryPushUserText(ecoThreadId, text, {
            clientUserMessageId: `approval-feedback:${toolUseId}`,
          });
          if (!pushed.ok) {
            throw new Error(`Codex approval feedback was not delivered: ${pushed.reason}`);
          }
          return;
        }
        if (phase === "closing" || phase === "closed") {
          throw new Error(`Codex approval feedback arrived after turn ingress closed (${phase}).`);
        }
        const client = getCodexRuntimeClientForThread(codexThreadId);
        if (!client) {
          throw new Error("Codex approval feedback cannot be delivered because Codex is not running.");
        }
        await steerCodexTurn(client, {
          threadId: codexThreadId,
          turnId,
          input: [{ type: "text", text }],
          clientUserMessageId: `approval-feedback:${toolUseId}`,
        });
      },
      getRoutesJson: (threadId) => JSON.stringify(resolveRoleRoutesForThread(threadId)),
      savePendingPlan: (plan) => conversationStore.savePendingPlan(plan),
      emitThreadLive: (event) => {
        if (event.type.startsWith("clarification.")) {
          const clarificationToolUseId =
            event.clarification?.toolUseId?.trim() || event.tool?.toolUseId?.trim();
          emitThreadEvent(
            event.threadId,
            event.type,
            event.message,
            event.role ?? "system",
            event.stream ?? false,
            {
              ...(event.clarification ? { clarification: event.clarification } : {}),
              ...(event.tool
                ? { tool: event.tool }
                : clarificationToolUseId
                  ? {
                      tool: buildClarificationToolMetadata(
                        clarificationToolUseId,
                        event.type === "clarification.answered" ? "completed" : "started",
                      ),
                    }
                  : {}),
            },
          );
          return;
        }
        desktopEventCenter.publishThreadLiveEvent(event);
      },
      updateThreadStatus: (threadId, patch) =>
        updateThread(threadId, {
          status: patch.status as ThreadSummary["status"],
          message: patch.message,
        }),
    });
    configureCodexAsyncQuestionBridge({
      getThread: (threadId) => conversationStore.getThread(threadId),
      emitEvent: (threadId, type, message, role, extras) =>
        emitThreadEvent(threadId, type, message, role, false, extras),
      registerPending: (threadId, toolUseId, parsed) =>
        registerPendingClarification(threadId, toolUseId, parsed),
      getPending: (toolUseId) => getPendingClarificationByToolUseId(toolUseId),
      submitPending: (toolUseId, answers) => submitClarification(toolUseId, answers),
      headHistoryRevision: (threadId) => conversationStore.conversationV2().head(threadId).historyRevision,
      enqueueFollowUp: (request) => enqueueThreadFollowUpCommand(request),
      sendMessage: (input) => {
        const accepted = conversationStore.conversationV2().sendMessage({
          principalId: input.principalId,
          conversationId: input.conversationId,
          clientCommandId: input.clientCommandId,
          text: input.text,
        });
        return { messageId: accepted.messageId, turnId: accepted.turnId };
      },
      scheduleAcceptedMessage: (input) => scheduleAcceptedConversationMessage(input),
      errorMessage: (error) => errorMessage(error),
      logDiag: (event, payload) => logEcoDiag(event, payload),
    });
    pricingCache = new ModelsDevPricingCache({
      cachePath: path.join(app.getPath("userData"), "models-dev-pricing.json"),
      // Chromium net stack honors OS system proxy (Clash / PAC / etc.); Node fetch does not.
      fetchImpl: net.fetch.bind(net) as typeof fetch,
    });
    pricingCatalogReady = pricingCache.getCatalog().then(() => {
      const loadError = pricingCache.getLastLoadError();
      if (loadError) {
        process.stderr.write(`[eco] models.dev pricing cache unavailable: ${loadError}\n`);
      }
    });
    billingRuntimeEnvironment = createBillingRuntimeEnvironment({
      waitUntilReady: () => pricingCatalogReady,
      resolveRuntimeRoutes: resolveRuntimeRoutesForThread,
      lookupPricing: lookupUsageBillingPricing,
    });
    contextMonitor = new ContextWindowMonitor(
      pricingCache,
      () => workflowSettingsStore.get().contextWindowLimitTokens,
    );
    threadPromptCacheMonitor = new ThreadPromptCacheMonitor();
    threadPromptCacheEpisodeMonitor = new ThreadPromptCacheEpisodeMonitor();
    promptCacheRunEventEmitter = createPromptCacheRunEventEmitter(
      {
        getThread: (threadId) => conversationStore.getThread(threadId),
        appendConversationRuntimeEvent: (event) => conversationStore.appendConversationRuntimeEvent(event),
        scheduleProjectionUpdated: (threadId) => scheduleThreadRunProjectionUpdated(threadId),
        emitThreadEvent: (threadId, type, message) => emitThreadEvent(threadId, type, message, "system"),
        resolveCurrentRunAttemptId: (threadId) => resolveCurrentRunAttemptId(threadId),
        writeStderr: (message) => process.stderr.write(message),
      },
      threadPromptCacheEpisodeMonitor,
    );
    threadCacheHitMonitor = new ThreadCacheHitMonitor();
    contextScheduler = new ContextSnapshotScheduler({
      monitor: contextMonitor,
      emitContext: emitThreadContextUpdated,
    });
    contextLifecycle = createContextLifecycleService({
      monitor: {
        markCompactCompleted: (threadId, postTokens) => {
          const snapshot = contextMonitor.markCompactCompleted(threadId, postTokens);
          syncSystemSleepBlocker();
          return snapshot;
        },
        noteCompactionObserved: (threadId) => {
          contextMonitor.noteCompactionObserved(threadId);
          syncSystemSleepBlocker();
        },
      },
      emitLiveContext: (threadId) => contextScheduler.emitLiveFromMonitor(threadId),
      applySdkContextUsageBreakdown: (threadId, payload) => {
        contextScheduler.applySdkContextUsageBreakdown(threadId, payload);
      },
      recordCompactionBoundary: (threadId, payload) => {
        const postTokens = extractCompactPostTokens(payload);
        emitContextCompactionStatus(threadId, {
          stage: "completed",
          trigger: "auto",
          ...(postTokens !== undefined && { postTokens }),
        });
      },
    });
    initializeSdkStreamActivityPipeline();
    loadThreadMetricsFromStore();
    logStartupStage("thread-metrics.restored");
    recoverOrphanedRunningThreads(logStartupStage);
    logStartupStage("orphaned-threads.recovered");
    recoverQueuedConversationV2Messages();
    logStartupStage("queued-v2-messages.recovered");
    syncSystemSleepBlocker();
    currentWorkspace = await ensureHomeProject();
    logStartupStage("home-workspace.ready");
    initializeGitAutoFetcher();
    schedulingService = createSchedulingService(dbPath);
    schedulingGateway = new SchedulingMcpGateway(schedulingService);
    browserSelectionService = new BrowserSelectionService({
      directory: path.join(app.getPath("userData"), "browser-selections"),
      getTarget: id => requireBrowserHost().getSelectionTarget(id),
    });
    composerReferenceService = new ComposerReferenceService({
      selections: browserSelectionService,
      listThreads: (query, limit) => conversationStore.searchThreadReferences(query, limit),
      getThread: (id) => conversationStore.getThread(id),
      listSsh: () => sshBookmarkStore.list(),
      listBrowsers: () => requireBrowserHost().getState().allInstances,
      listCapabilities: resolveComposerCapabilitiesForThread,
      readHistory: (id, before, limit, includeTools) =>
        conversationStore.conversationV2().transcriptPage(id, before, limit, includeTools),
      readMessage: (id, messageId) => conversationStore.conversationV2().getMessage(id, messageId),
      readTools: (id, runId, cursor, limit) =>
        conversationStore.conversationV2().toolsPage(id, runId, cursor, limit, 128 * 1024),
      browserTool: (id, action, args, signal) =>
        requireBrowserHost().invokeReferencedBrowserTool(id, action, args, signal),
    });
    contextReferenceGateway = new ContextReferenceMcpGateway(composerReferenceService);
    registerIpcHandlers();
    schedulingService.start();
    if (centerServerClient.getSnapshot().settings.enabled) {
      void centerServerClient.start();
    }
    if (startupWindow && !startupWindow.isDestroyed()) {
      const mainWindow = await createMainWindow({ show: false });
      await waitForInitialDesktopRendererReady();
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      // Hand over in this order: showing the real window first keeps a visible
      // window on screen throughout. Closing the splash first leaves the app
      // window-less for a moment, macOS hands focus back to the previous app,
      // and the window that follows takes it again — the second focus grab.
      // Neither window steals focus on launch; the OS still activates the app
      // when the user starts it from Finder or the Dock.
      mainWindow.showInactive();
      if (!startupWindow.isDestroyed()) {
        startupWindow.close();
      }
    } else {
      await createMainWindow();
    }
    logStartupStage("main-window.ready");
    // The Cursor ACP probe spawns `agent acp` and runs a JSON-RPC handshake with it
    // (~1.4s of subprocess + main-process work). It only repairs a stale "Cursor ACP
    // enabled" setting, and the use-time path re-probes through
    // assertAcpCursorRunnableForMain, so it runs after the window is up: measuring
    // showed that overlapping it with startup only moved the cost downstream.
    void reconcileAcpCursorAgainstProbe().catch((error: unknown) => {
      logEcoDiag("acp-cursor.startup-reconcile-failed", { error: errorMessage(error) });
    });
    desktopUpdateService.start();
    // Skill materials only when capability is ON (no CDP / no session inject at boot).
    if (browserSettingsStore.get().agentIntegrationEnabled) {
      void ensureClaudeUserEcoAgentBrowserSkill().catch((error) => {
        process.stderr.write(
          `[eco-browser] skill ensure failed: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      });
    }
    desktopInitializationComplete = true;

    // On Windows/Linux a deep link that cold-started the app arrives via argv
    // (the "open-url" event only fires for an already-running instance). Seed
    // the pending link so it is flushed to the renderer once it is ready.
    const argvDeepLink = process.argv.find((arg) => arg.startsWith("eco://"));
    if (argvDeepLink && !pendingEcoDeepLink) {
      pendingEcoDeepLink = argvDeepLink;
    }

    nativeTheme.on("updated", () => {
      syncWindowControlsOverlays();
    });

    app.on("browser-window-focus", () => {
      gitAutoFetcher?.setWindowFocused(true);
      void centerServerClient?.recoverAfterIdle("focus");
    });
    app.on("browser-window-blur", () => {
      gitAutoFetcher?.setWindowFocused(false);
    });

    powerMonitor.on("resume", () => {
      syncSystemSleepBlocker({ refresh: true });
      void centerServerClient?.recoverAfterIdle("resume");
    });
    powerMonitor.on("unlock-screen", () => {
      syncSystemSleepBlocker();
      void centerServerClient?.recoverAfterIdle("unlock-screen");
    });

    app.on("activate", async () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        await createMainWindow();
      }
    });
  })
  .catch((error: unknown) => {
    const startupError = error instanceof Error ? error : new Error(String(error));
    logUpstream("desktop.startup-failed", {
      message: startupError.message,
      ...(startupError.stack && { stack: startupError.stack }),
    });
    try {
      dialog.showErrorBox(
        "Eco Coding 启动失败",
        `${startupError.message}\n\n详细日志：${getUpstreamLogFilePath()}`,
      );
    } finally {
      app.quit();
    }
  });

app.on("window-all-closed", () => {
  // Main-window close already runs full shutdownApplication (stops eco-gateway).
  // Always quit so macOS does not leave a dock-resident process with globalGateway cleared —
  // otherwise activate → new window → Codex/Claude hits "lifecycle is not configured".
  app.quit();
});

installApplicationShutdownHook(
  (applicationShutdownDeps = {
    locale: currentAppLocale,
    listThreads: () => conversationStore.listThreads(),
    hasActiveRun: (threadId) => activeRunRuntimeState.hasRun(threadId),
    isCompactInFlight: (threadId) => contextMonitor?.isCompactInFlight(threadId) ?? false,
    countRunningBackgroundTasks: () => backgroundTerminalTaskRegistry.countRunning(),
    cancelThreadRuntime: async (coreKind, threadId) => {
      await threadRuntimeCoordinator.cancel(coreKind, threadId);
    },
    abortActiveRun: (threadId, reason) => activeRunRuntimeState.abortRun(threadId, reason),
    finishActiveRun,
    cancelClarifications: cancelClarificationsForThread,
    cancelBashApprovals: cancelBashApprovalsForThread,
    cancelPlanApprovals: cancelPlanApprovalsForThreadKeepPending,
    settleRecoveredLifecycleRecords,
    getPendingPlan: (threadId) => conversationStore.getPendingPlan(threadId),
    updateThreadOnQuit: (threadId, patch) => {
      updateThread(threadId, patch);
    },
    emitThreadQuitEvent: (threadId, type, message) => {
      if (type === "thread.awaiting_plan") {
        const pendingPlan = conversationStore.getPendingPlan(threadId);
        emitThreadEvent(threadId, type, message, "system", false, {
          plan: pendingPlan
            ? {
                userPrompt: pendingPlan.userPrompt,
                analysis: pendingPlan.analysis,
                plan: pendingPlan.plan,
              }
            : undefined,
        });
        return;
      }
      emitThreadEvent(threadId, type, message, "system");
    },
    stopAllBackgroundTasks: () => {
      backgroundTerminalTaskRegistry.stopAllRunning();
    },
    killAllInteractiveTerminals: () => {
      interactiveTerminalManager.killAll();
    },
    disposeBrowserHost: async () => {
      schedulingService?.stop();
      await browserHost?.dispose();
      void computerUseGateway?.close();
    },
    stopAllPiRuntimes: disposeAllPiSessions,
    closeImageGenerationGateway: async () => {
      ttsReadAloud?.close();
      await imageGenerationGateway?.close();
      await ttsGateway?.close();
    },
    closeImageViewGateway: async () => {
      await imageViewGateway?.close();
    },
    closeImageDisplayGateway: async () => {
      await imageDisplayGateway?.close();
      schedulingService?.stop();
      await schedulingGateway?.close();
      await contextReferenceGateway?.close();
      await htmlHostGateway?.close();
    },
    closeIntegratedWebSearchGateway: async () => {
      await integratedWebSearchGateway?.close();
    },
    closeMcpHubGateway: async () => {
      await mcpHubGateway?.close();
    },
    stopGlobalCodexRuntime: async () => {
      await shutdownCodexGlobalRuntimeRefresh();
      await stopGlobalCodexRuntimeLifecycle();
    },
    closeOpenAIAccountService: async () => {
      openaiAccountAssistant?.dispose();
      openaiAccountAssistant = undefined;
      await openaiAccountService?.dispose();
      openaiAccountService = undefined;
    },
    stopAllAcpRuntimes,
    stopGlobalEcoGateway: () => stopGlobalEcoGateway(),
    disposeDesktopUpdateService: () => {
      desktopUpdateService.dispose();
    },
    disposeSystemSleepBlocker: () => {
      systemSleepBlocker.dispose();
    },
    clearCodexSubagentRuntimeLimit: () => {
      codexSubagentRuntimeLimit.clear();
    },
    flushAllThreadMetrics: () => {
      flushAllThreadMetrics();
    },
    disposeCodexGatewayUsagePending: () => {
      codexGatewayUsagePending.dispose();
    },
    clearCodexGatewayUsageDeduplicator: () => {
      codexGatewayUsageDeduplicator.clear();
    },
    disposeGitAutoFetcher: () => {
      gitAutoFetcher?.dispose();
      workspaceReviewService.dispose();
      workspaceGitStatusPublisher.dispose();
    },
    disposeCenterServerClient: () => {
      centerServerClient?.dispose();
    },
    parentWindow: () => getMainWindow(),
    logError: (error) => {
      process.stderr.write(
        `[eco] application shutdown failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    },
  }),
);

function getModelSettingsSnapshot(): ModelSettingsSnapshot {
  // Check if OpenAI auth.json exists in CODEX_HOME (synchronous check)
  let openAiAccountActive = false;
  try {
    const authJsonPath = path.join(app.getPath("userData"), "codex", "auth.json");
    openAiAccountActive = existsSync(authJsonPath);
  } catch {
    /* app not ready yet */
  }
  const chatGptSubscriptionModelId = getChatGptModelCatalogService().getLoadedDefaultModelId();
  const codexAuthModel = workflowSettingsStore.getCodexAuthModel();
  return {
    ...mergeAgentRegistrySettings(providerStore.getSettings(), agentOrchestrationStore, {
      openAiAccountActive,
      ...(chatGptSubscriptionModelId ? { chatGptSubscriptionModelId } : {}),
      ...(codexAuthModel ? { codexAuthModel } : {}),
    }),
    mcpSettings: mcpStore.getSettings(),
  };
}

async function getChatGptSubscriptionService(): Promise<ChatGptSubscriptionService> {
  if (chatgptSubscriptionService) return chatgptSubscriptionService;
  if (!chatgptSubscriptionServicePromise) {
    chatgptSubscriptionServicePromise = (async () => {
      const { ChatGptSubscriptionService } = await import("./chatgpt-subscription-service");
      const codec = {
        isAvailable: () => safeStorage.isEncryptionAvailable(),
        encrypt: (value: string) => `safe-v1:${safeStorage.encryptString(value).toString("base64")}`,
        decrypt: (value: string) => {
          if (!value.startsWith("safe-v1:")) throw new Error("无效的 ChatGPT 订阅凭据存储格式");
          return safeStorage.decryptString(Buffer.from(value.slice("safe-v1:".length), "base64"));
        },
      };
      const service = new ChatGptSubscriptionService(
        app.getPath("userData"),
        codec,
        createChatGptSubscriptionFetch(() => resolveOutboundProxyUrl(proxyBridgeSettingsStore.get())),
        createChatGptSubscriptionFetchForProxy,
      );
      await service.initialize();
      chatgptSubscriptionService = service;
      return service;
    })().finally(() => {
      chatgptSubscriptionServicePromise = undefined;
    });
  }
  return chatgptSubscriptionServicePromise;
}

/** The official OAuth connection is a built-in provider; users should not have to create it manually. */
function ensureChatGptSubscriptionProvider(): void {
  const id = "eco-coding-chatgpt";
  const existing = providerStore.getProviderWithSecret(id);
  const defaultModel = existing?.defaultModel?.trim() || "gpt-5";
  const needsMigration =
    !existing ||
    existing.name !== "ChatGPT OAuth" ||
    existing.baseUrl !== "https://api.openai.com" ||
    existing.requestPath !== "" ||
    existing.version !== "v1" ||
    existing.apiCompat !== "openai_responses" ||
    existing.tokenCountMode !== "openai_responses" ||
    existing.authMethod !== "chatgpt_subscription" ||
    existing.credentialPoolId !== "chatgpt-default" ||
    existing.apiKey !== "" ||
    existing.enabled !== true ||
    existing.defaultModel !== defaultModel;
  if (!needsMigration) return;

  providerStore.saveProvider({
    id,
    name: "ChatGPT OAuth",
    baseUrl: "https://api.openai.com",
    requestPath: "",
    version: "v1",
    apiCompat: "openai_responses",
    tokenCountMode: "openai_responses",
    authMethod: "chatgpt_subscription",
    credentialPoolId: "chatgpt-default",
    apiKey: "",
    defaultModel,
    enabled: true,
  });
  if (existing?.apiKey) {
    providerStore.clearProviderApiKey(id);
  }
  emitSettingsUpdated();
}

function getChatGptModelCatalogService(): ChatGptModelCatalogService {
  if (!chatGptModelCatalogService) {
    chatGptModelCatalogService = new ChatGptModelCatalogService({
      cachePath: resolveChatGptModelCatalogCachePath(app.getPath("userData")),
      fetchImpl: net.fetch.bind(net) as typeof fetch,
      fetchModels: async (signal, accountId) => (await getChatGptSubscriptionService()).listModels(accountId, signal),
    });
  }
  return chatGptModelCatalogService;
}

async function chatGptModelCatalogSnapshot(): Promise<CodexModelCatalogSnapshot> {
  const catalog = getChatGptModelCatalogService();
  return { models: await catalog.listModels(), status: await catalog.getStatus() };
}

/**
 * Codex 账号 (built-in `openai` / auth.json) has no provider row and no upstream
 * /v1/models endpoint, so its candidate models come from the codex-rs
 * models-manager catalog plus whatever the user added by hand.
 */
function getCodexModelCatalogService(): CodexRemoteModelCatalogService {
  if (!codexModelCatalogService) {
    codexModelCatalogService = new CodexRemoteModelCatalogService({
      cachePath: resolveCodexModelCatalogCachePath(app.getPath("userData")),
      onContextWindowsChanged: () => scheduleCodexGlobalRuntimeRefresh(),
      // Chromium net stack honors OS system proxy (Clash / PAC / etc.); Node fetch does not.
      fetchImpl: net.fetch.bind(net) as typeof fetch,
    });
  }
  return codexModelCatalogService;
}

function codexCatalogCandidateViews(models: readonly CodexCatalogModelView[]): CandidateModelView[] {
  const timestamps = new Date().toISOString();
  return models.map((model, index) => ({
    id: `cand-openai-${model.modelId
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "")}`,
    providerId: "openai",
    modelId: model.modelId,
    displayName: model.displayName,
    sortOrder: index,
    ...(model.contextWindow !== undefined ? { resolvedContextTokens: model.contextWindow } : {}),
    ...(model.supportsImageInput !== undefined
      ? { resolvedSupportsImageInput: model.supportsImageInput }
      : {}),
    ...(model.reasoningEfforts.length > 0 ? { resolvedSupportsReasoning: true } : {}),
    resolvedSupportsNativeWebSearch: true,
    createdAt: timestamps,
    updatedAt: timestamps,
  }));
}

/** True when the provider id is the virtual Codex Auth provider rather than a user-created OpenAI provider. */
function isBuiltInCodexCatalogProvider(providerId: string): boolean {
  if (providerId !== "openai") {
    return false;
  }
  const stored = providerStore.listProviders().find((provider) => provider.id === providerId);
  if (!stored) {
    return true;
  }
  return stored.authMethod === "auth_json" && !stored.hasApiKey;
}

async function codexModelCatalogSnapshot(): Promise<CodexModelCatalogSnapshot> {
  const models = await getCodexModelCatalogService().listModels();
  const status = await getCodexModelCatalogService().getStatus();
  return { models, status };
}

function listCodexCatalogRoutesFromSettings(): CodexGatewayCatalogRoute[] {
  const settings = getModelSettingsSnapshot();
  const refs = [
    ...settings.mainAgentConfigs.map((config) => config.modelRef),
    ...settings.subagentOrchestrations.flatMap((orchestration) =>
      orchestration.agents.map((agent) => agent.modelRef),
    ),
  ];
  return collectCodexCatalogRoutesFromModelRefs(refs, settings.providers);
}

function listCodexCatalogRoutesFromThreadSnapshots(): CodexGatewayCatalogRoute[] {
  const settings = getModelSettingsSnapshot();
  const refs: Array<{
    providerId: string;
    modelId: string;
    apiCompat?: UpstreamApiCompat;
    manualSpec?: RouteManualSpec;
    candidateModelId?: string;
  }> = [];

  for (const thread of conversationStore.listThreads()) {
    const config = thread.runtimeConfig;
    const snapshot = config?.resolvedOrchestrationSnapshot;
    if (snapshot) {
      refs.push(snapshot.mainAgent.modelRef, ...snapshot.agents.map((agent) => agent.modelRef));
    }
    if (config?.mainAgentModelOverride) {
      refs.push(config.mainAgentModelOverride);
    }
  }
  return collectCodexCatalogRoutesFromModelRefs(refs, settings.providers);
}

function collectCodexCatalogRoutesFromModelRefs(
  refs: readonly {
    providerId: string;
    modelId: string;
    apiCompat?: UpstreamApiCompat;
    manualSpec?: RouteManualSpec;
    candidateModelId?: string;
  }[],
  providers: readonly {
    id: string;
    name: string;
    apiCompat: UpstreamApiCompat;
  }[],
): CodexGatewayCatalogRoute[] {
  const providerById = new Map(providers.map((provider) => [provider.id, provider]));
  return refs.flatMap((ref) => {
    const providerId = ref.providerId.trim();
    const candidate = ref.candidateModelId
      ? providerStore.listCandidateModels(providerId).find((model) => model.id === ref.candidateModelId)
      : undefined;
    const modelId = (candidate?.modelId || ref.modelId).trim();
    const manualSpec = mergeRouteManualSpec(candidate?.manualSpec, ref.manualSpec);
    const provider = providerById.get(providerId);
    if (!providerId || !modelId || !provider) {
      return [];
    }
    return [
      {
        providerId,
        modelId,
        apiCompat: resolveUpstreamApiCompat(ref.apiCompat, provider.apiCompat),
        displayName: `${provider.name} / ${modelId}`,
        ...(manualSpec
          ? {
              manualSpec: {
                ...(manualSpec.contextTokens !== undefined
                  ? { contextTokens: manualSpec.contextTokens }
                  : {}),
                ...(manualSpec.supportsImageInput !== undefined
                  ? { supportsImageInput: manualSpec.supportsImageInput }
                  : {}),
              },
            }
          : {}),
      } satisfies CodexGatewayCatalogRoute,
    ];
  });
}

function assertCanWriteAgentTemplateId(id: string): void {
  const templateId = id.trim();
  if (!templateId) {
    return;
  }
  const protectedIds = new Set(providerStore.getSettings().agentTemplates.map((template) => template.id));
  if (protectedIds.has(templateId)) {
    throw new Error("内置子代理模板不可直接修改，请先复制为用户模板。");
  }
}

function prepareImportedAgentTemplate(template: AgentTemplate, existingIds: Set<string>): AgentTemplate {
  const now = new Date().toISOString();
  const protectedId =
    template.builtIn ||
    template.source === "built_in" ||
    (typeof template.id === "string" && template.id.trim().startsWith("builtin."));
  if (protectedId) {
    const name =
      typeof template.name === "string" && template.name.trim() ? template.name.trim() : "Imported Agent";
    const id = createUniqueImportedTemplateId(
      `user.imported.${slugifyTemplateId(name) || "agent"}`,
      existingIds,
    );
    existingIds.add(id);
    return {
      ...template,
      id,
      name,
      builtIn: false,
      source: "user",
      updatedAt: now,
    };
  }
  const id = typeof template.id === "string" ? template.id.trim() : "";
  if (id) {
    existingIds.add(id);
  }
  return {
    ...template,
    id,
    builtIn: false,
    source: "user",
    updatedAt: now,
  };
}

function createUniqueImportedTemplateId(baseId: string, existingIds: ReadonlySet<string>): string {
  let candidate = baseId;
  let suffix = 2;
  while (existingIds.has(candidate)) {
    candidate = `${baseId}_${suffix}`;
    suffix += 1;
  }
  return candidate;
}

function slugifyTemplateId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function ensureThreadRuntimeConfig(thread: ThreadSummary): ThreadSummary {
  return thread;
}

function parseThreadRuntimeConfigInput(value: unknown): ThreadRuntimeConfig {
  if (!isThreadRuntimeConfig(value)) {
    throw new Error("Invalid thread runtime configuration.");
  }
  return normalizeThreadRuntimeConfig(value);
}

/**
 * Materialize component selection + resolved snapshot for persistence.
 * Callers that only change bashReviewMode while a snapshot already exists should
 * keep the existing snapshot instead of re-resolving.
 */
function getDefaultOrchestrationSelection(): OrchestrationSelection | undefined {
  return workflowSettingsStore.get().defaultOrchestrationSelection;
}

function materializeThreadRuntimeConfig(
  settings: ModelSettingsSnapshot,
  config: ThreadRuntimeConfig,
): ThreadRuntimeConfig {
  const normalized = normalizeThreadRuntimeConfig(config);
  if (!hasCompleteOrchestrationSelection(normalized.orchestrationSelection)) {
    throw new Error("无法物化线程运行时配置：编排组合不完整。");
  }
  try {
    const materialized = materializeThreadOrchestrationSnapshot(settings, normalized.orchestrationSelection);
    return normalizeThreadRuntimeConfig({
      ...normalized,
      ...materialized,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`无法物化线程运行时配置：${detail}`);
  }
}

function resolveContinueThreadRuntimeConfig(
  settings: ModelSettingsSnapshot,
  existing: ThreadRuntimeConfig | undefined,
  incoming: ThreadRuntimeConfig,
): ThreadRuntimeConfig {
  if (!shouldRematerializeThreadRuntimeConfigOnContinue(existing, incoming)) {
    return lockThreadRuntimeConfigSnapshotOnContinue(existing!, incoming);
  }
  return materializeThreadRuntimeConfig(settings, incoming);
}

function roleRoutesForThreadConfig(
  settings: ModelSettingsSnapshot,
  config: ThreadRuntimeConfig,
): RuntimeRoleRouteConfig[] {
  const snapshot = resolveThreadOrchestrationSnapshot(settings, config);
  if (!snapshot) {
    throw new Error("找不到线程编排快照，请重新选择完整组合。");
  }
  return resolveCandidateModelDefaults(
    runtimeRoleRoutesFromOrchestrationSnapshot(snapshot, config.mainAgentModelOverride),
  );
}

function resolveCandidateModelDefaults(routes: readonly RuntimeRoleRouteConfig[]): RuntimeRoleRouteConfig[] {
  return routes.map((route) => {
    if (!route.candidateModelId) {
      return route;
    }
    const candidate = providerStore
      .listCandidateModels(route.providerId)
      .find((entry) => entry.id === route.candidateModelId);
    if (!candidate) {
      return route;
    }
    const manualSpec = mergeRouteManualSpec(candidate.manualSpec, route.manualSpec);
    return {
      ...route,
      modelId: candidate.modelId || route.modelId,
      ...(route.modelsDevMapping
        ? { modelsDevMapping: route.modelsDevMapping }
        : candidate.modelsDevMapping
          ? { modelsDevMapping: candidate.modelsDevMapping }
          : {}),
      ...(manualSpec ? { manualSpec } : {}),
    };
  });
}

function mergeRouteManualSpec(
  candidateSpec: RouteManualSpec | undefined,
  profileSpec: RouteManualSpec | undefined,
): RouteManualSpec | undefined {
  if (!candidateSpec && !profileSpec) {
    return undefined;
  }
  return {
    ...(candidateSpec ?? {}),
    ...(profileSpec ?? {}),
  };
}

function runtimeValidationOptionsForThreadConfig(
  _settings: ModelSettingsSnapshot,
  config: ThreadRuntimeConfig,
): { requireCompleteCodingRoutes?: boolean } {
  // Orchestration snapshots only materialize routes that exist in the selection
  // (planner-only for subagents=none, planner + enabled roster agents otherwise).
  void resolveThreadOrchestrationSnapshot(_settings, config);
  return { requireCompleteCodingRoutes: false };
}

function resolveRuntimeConfigForThreadConfig(
  settings: ModelSettingsSnapshot,
  config: ThreadRuntimeConfig,
  roleRoutes?: readonly RuntimeRoleRouteConfig[],
): RuntimeConfigResolution {
  return resolveThreadRuntimeConfig(
    settings,
    providerStore.listProvidersWithSecrets(),
    resolveCandidateModelDefaults(roleRoutes ?? roleRoutesForThreadConfig(settings, config)),
    runtimeValidationOptionsForThreadConfig(settings, config),
  );
}

function resolveRuntimeConfigForThreadId(
  threadId: string,
  routesOverride?: readonly RuntimeRoleRouteConfig[],
  optionsOverride?: { requireCompleteCodingRoutes?: boolean },
): RuntimeConfigResolution {
  const settings = getModelSettingsSnapshot();
  const thread = conversationStore.getThread(threadId);
  if (!thread) {
    throw new Error("Thread was not found.");
  }
  const config = ensureThreadRuntimeConfig(thread).runtimeConfig;
  if (!config) {
    throw new Error("Thread runtime configuration is missing.");
  }
  return resolveThreadRuntimeConfig(
    settings,
    providerStore.listProvidersWithSecrets(),
    resolveCandidateModelDefaults(routesOverride ?? roleRoutesForThreadConfig(settings, config)),
    optionsOverride ?? runtimeValidationOptionsForThreadConfig(settings, config),
  );
}

function resolveRoleRoutesForThread(threadId: string): RuntimeRoleRouteConfig[] {
  const settings = getModelSettingsSnapshot();
  const thread = conversationStore.getThread(threadId);
  if (!thread) {
    throw new Error("Thread was not found.");
  }
  const config = ensureThreadRuntimeConfig(thread).runtimeConfig;
  if (!config) {
    throw new Error("Thread runtime configuration is missing.");
  }
  return roleRoutesForThreadConfig(settings, config);
}

function resolveRuntimeRoutesForThread(
  threadId: string,
): ReturnType<typeof resolveRuntimeRoutesFromSettings> {
  const settings = getModelSettingsSnapshot();
  const providers = providerStore.listProvidersWithSecrets();
  const roleRoutes = resolveRoleRoutesForThread(threadId);
  const routes = resolveRuntimeRoutesFromSettings(settings, providers, roleRoutes);
  if (routes.some((route) => route.role === BUILTIN_VISION_AGENT_ROLE)) {
    return routes;
  }
  const thread = conversationStore.getThread(threadId);
  const visionSelection = thread ? ensureThreadRuntimeConfig(thread).runtimeConfig?.visionModel : undefined;
  if (visionSelection) {
    try {
      const visionRoute = resolveVisionModelRoute(visionSelection, providerStore);
      return [
        ...routes,
        {
          ...visionRoute,
          role: BUILTIN_VISION_AGENT_ROLE,
          manualSpec: {
            ...visionRoute.manualSpec,
            maxOutputTokens: 1600,
          },
        },
      ];
    } catch {
      // Fall through to planner clone when the saved vision selection is stale.
    }
  }
  const plannerRoute = routes.find((route) => route.role === "main");
  if (!plannerRoute) {
    return routes;
  }
  return [
    ...routes,
    {
      ...plannerRoute,
      role: BUILTIN_VISION_AGENT_ROLE,
      manualSpec: {
        ...plannerRoute.manualSpec,
        maxOutputTokens: 1600,
      },
    },
  ];
}

function resolveAgentRuntimeConfigForThread(thread: ThreadSummary): EcoAgentRuntimeConfig | undefined {
  const runtimeConfig = ensureThreadRuntimeConfig(thread).runtimeConfig;
  if (!runtimeConfig) {
    return undefined;
  }
  const settings = getModelSettingsSnapshot();
  const snapshot = resolveThreadOrchestrationSnapshot(settings, runtimeConfig);
  if (!snapshot) {
    return undefined;
  }
  const systemPromptPreset = resolveMainAgentSystemPromptPreset(snapshot, runtimeConfig);
  const config = orchestrationConfigFromSnapshot(snapshot);
  const resolved: EcoAgentRuntimeConfig = {
    templates: settings.agentTemplates,
    orchestration:
      systemPromptPreset === snapshot.mainAgent.systemPromptPreset
        ? config
        : {
            ...config,
            mainAgent: { ...config.mainAgent, systemPromptPreset },
          },
  };
  // "指定子代理执行已批准计划": while a forced delegation is armed, the exposed roster is
  // limited to the chosen subagent so the parent cannot pick another role. Codex is excluded:
  // its app-server rejects a config change for a loaded (non-cold) thread, so a restricted
  // roster would block the approved continuation itself — Codex's spawn hook already denies
  // any wrong-role or repeat spawn_agent call.
  if (thread.coreKind === "codex") {
    return resolved;
  }
  return restrictAgentRuntimeConfigToForcedDelegation(resolved, thread.id) ?? resolved;
}

function resolveAgentRuntimeConfigForThreadId(threadId: string): EcoAgentRuntimeConfig | undefined {
  const thread = conversationStore.getThread(threadId);
  return thread ? resolveAgentRuntimeConfigForThread(thread) : undefined;
}

function threadSessionMode(threadId: string): import("../shared/session-mode").SessionMode {
  const thread = conversationStore.getThread(threadId);
  const config = thread ? ensureThreadRuntimeConfig(thread).runtimeConfig : undefined;
  if (config) {
    return resolveSessionMode(config);
  }
  return resolveSessionMode(workflowSettingsStore.get());
}

function disableThreadPlanMode(threadId: string): ThreadRuntimeConfig | undefined {
  const thread = conversationStore.getThread(threadId);
  if (!thread) {
    return undefined;
  }
  const config = ensureThreadRuntimeConfig(thread).runtimeConfig;
  if (!config) {
    return undefined;
  }
  const next = withAgentSessionMode(config, "agent");
  if (next === config) {
    return config;
  }
  conversationStore.saveThreadRuntimeConfig(threadId, next);
  return next;
}

function commitThreadPlanApprovalToAgentMode(threadId: string, reason: string): void {
  const runtimeConfig = disableThreadPlanMode(threadId);
  if (!runtimeConfig || resolveSessionMode(runtimeConfig) !== "agent") {
    return;
  }
  emitThreadEvent(threadId, "thread.runtime_config_updated", "", "system", false, {
    runtimeConfig,
  });
}

function buildPlanResolutionFrozenContext(threadId: string): Record<string, unknown> {
  const thread = conversationStore.getThread(threadId);
  const pendingPlan = conversationStore.getPendingPlan(threadId);
  const pendingBridge = getPendingPlanApprovalForThread(threadId);
  return {
    thread: thread
      ? {
          id: thread.id,
          status: thread.status,
          coreKind: thread.coreKind ?? null,
          workspacePath: thread.workspacePath,
          runtimeConfig: thread.runtimeConfig ?? null,
        }
      : null,
    pendingPlan: pendingPlan ?? null,
    bridge: pendingBridge
      ? {
          toolUseId: pendingBridge.toolUseId,
          threadId: pendingBridge.threadId,
          userPrompt: pendingBridge.userPrompt,
          analysis: pendingBridge.analysis,
          plan: pendingBridge.plan,
          planFilePath: pendingBridge.planFilePath ?? null,
        }
      : null,
  };
}

function assertPlanResolutionContextCurrent(threadId: string, frozenContext: Record<string, unknown>): void {
  const current = buildPlanResolutionFrozenContext(threadId);
  if (stableHash(current) !== stableHash(frozenContext)) {
    throw new ConversationV2Error(
      CONVERSATION_V2_ERROR.cursorStale,
      "The pending plan, runtime configuration, or approval bridge changed after the command was accepted.",
    );
  }
}

function registerDesktopCommand<Args extends unknown[], Result>(
  channel: IpcChannel,
  handler: (...args: Args) => Result | Promise<Result>,
  remoteHandler?: (...args: Args) => Result | Promise<Result>,
): void {
  const invokeLocal = async (...args: Args): Promise<Result> => {
    try {
      return await handler(...args);
    } catch (error) {
      throw localizeExpectedIpcError(error);
    }
  };
  const remote = remoteHandler ?? handler;
  const invokeRemote = async (...args: Args): Promise<Result> => {
    try {
      return await remote(...args);
    } catch (error) {
      throw localizeExpectedIpcError(error);
    }
  };
  if (isRemoteCommandChannel(channel)) {
    desktopEventCenter.registerCommand(channel, (args) => invokeRemote(...(args as Args)));
  }
  ipcMain.handle(channel, async (_event, ...args: unknown[]) => invokeLocal(...(args as Args)));
}

async function resolveTtsArtifactAudio(payload: unknown) {
  if (!isRecord(payload) || typeof payload.artifactId !== "string" || !Number.isInteger(payload.audioIndex))
    throw new Error("音频产物参数无效。");
  const artifact = ttsStore.getArtifact(payload.artifactId);
  const audio = artifact.audio[payload.audioIndex as number];
  if (!audio) throw new Error("音频产物索引不存在。");
  const root = await fs.realpath(artifact.generationRoot);
  const resolvedPath = await fs.realpath(audio.absolutePath);
  if (!resolvedPath.startsWith(`${root}${path.sep}`)) throw new Error("音频文件路径超出了工作目录。");
  return { audio, resolvedPath };
}

function resolveImageGenerationArtifactImage(payload: unknown): {
  image: ImageGenerationArtifact["images"][number];
  resolvedPath: string;
} {
  if (!isRecord(payload) || typeof payload.artifactId !== "string" || !Number.isInteger(payload.imageIndex)) {
    throw new Error("图片产物参数无效。");
  }
  const artifact = imageGenerationStore.getArtifact(payload.artifactId);
  const image = artifact.images[payload.imageIndex as number];
  if (!image) throw new Error("图片产物索引不存在。");
  const candidates = [image.absolutePath, path.resolve(artifact.workspacePath, image.relativePath)];
  const resolvedPath = candidates.find((candidate) => existsSync(candidate));
  if (!resolvedPath) throw new Error("图片文件已不存在。");
  return { image, resolvedPath };
}

function parseComposerDraftContextKey(value: unknown): string {
  const key = typeof value === "string" ? value.trim() : "";
  if (!key || key.length > 4_096 || (!key.startsWith("thread:") && !key.startsWith("landing:"))) {
    throw new Error("Invalid composer draft context key.");
  }
  return key;
}

type AppThemeSource = "dark" | "light" | "system";
let appLocalePreference: AppLocalePreference = "system";

function normalizeAppThemeSource(value: unknown): AppThemeSource {
  return value === "dark" || value === "light" || value === "system" ? value : "system";
}

function currentAppLocale(): AppLocale {
  return resolveAppLocale(appLocalePreference, [app.getLocale()]);
}

function mainText(
  key: Parameters<typeof translateCatalog>[1],
  variables?: Parameters<typeof translateCatalog>[2],
): string {
  return translateCatalog(currentAppLocale(), key, variables);
}

/**
 * Env for the Cursor ACP child. When the user configured a Cursor API key
 * (headless / no browser login), inject CURSOR_API_KEY; merged over
 * process.env so HOME/PATH-based executable resolution still works.
 */
function acpCursorSpawnEnv(): NodeJS.ProcessEnv | undefined {
  const apiKey = workflowSettingsStore.get().acpCursorApiKey?.trim();
  if (!apiKey) return undefined;
  return { ...process.env, CURSOR_API_KEY: apiKey };
}

async function probeAcpCursorForMain(): Promise<AcpCursorProbeResult> {
  const env = acpCursorSpawnEnv();
  return probeAcpCursorAvailability({
    resolveExecutable: () => resolveCursorAgentExecutable(),
    executableExists: (candidate) => existsSync(candidate),
    handshake: () => handshakeAcpCursor(env ? { env } : {}),
  });
}

function acpCursorUnavailableMessage(probe: AcpCursorProbeResult): string {
  if (probe.available) {
    return mainText("native.cursorUnavailable");
  }
  if (probe.reasonKey === "handshakeFailed") {
    const detail = probe.detail?.trim() ? `: ${probe.detail.trim()}` : "";
    return mainText("native.cursorModelsUnavailable", { detail });
  }
  return mainText("native.cursorUnavailable");
}

async function assertAcpCursorRunnableForMain(): Promise<void> {
  const probe = await probeAcpCursorForMain();
  assertAcpCursorRunnable({
    probe,
    unavailableMessage: acpCursorUnavailableMessage(probe),
  });
}

async function reconcileAcpCursorAgainstProbe(probe?: AcpCursorProbeResult): Promise<void> {
  const current = workflowSettingsStore.get();
  const resolved = probe ?? (await probeAcpCursorForMain());
  if (resolved.available) {
    return;
  }
  const shouldClear = current.acpAgentsEnabled?.cursor === true || current.defaultCoreKind === "acp";
  if (!shouldClear) {
    return;
  }
  const patch = reconcileAcpCursorEnabled(
    definedProps({
      acpCursorEnabled: true,
      defaultCoreKind: current.defaultCoreKind,
      probe: resolved,
    }),
  );
  if (!patch) {
    return;
  }
  const next: typeof current = {
    ...current,
    ...(patch.defaultCoreKind !== undefined ? { defaultCoreKind: patch.defaultCoreKind } : {}),
  };
  delete next.acpAgentsEnabled;
  if (patch.defaultCoreKind === "claude") {
    delete next.defaultAcpAgentId;
  }
  workflowSettingsStore.save(next);
}

function localizeExpectedIpcError(error: unknown): unknown {
  if (!(error instanceof Error)) {
    return error;
  }
  const message = error.message.trim();
  const key = expectedIpcErrorKey(message);
  if (!key) {
    return error;
  }
  if (key === "native.acpSessionDeleteFailed") {
    const prefix = "ACP session/delete 失败：";
    const detail = message.startsWith(prefix) ? message.slice(prefix.length) : message;
    return new Error(mainText(key, { detail }));
  }
  return new Error(mainText(key));
}

async function openThreadFromDesktopNotification(threadId: string): Promise<void> {
  pendingThreadOpenId = threadId;
  const splashWindow = getStartupSplashWindow();
  if (!desktopRendererReady && splashWindow) {
    presentDesktopWindow(splashWindow);
    return;
  }
  let window = getMainWindow();
  if (!window || window.isDestroyed()) {
    window = await createMainWindow();
  }
  const loading = window.webContents.isLoading();
  presentDesktopWindow(window);
  if (process.platform === "darwin") {
    app.focus({ steal: true });
  }
  if (loading) {
    await Promise.race([
      new Promise<void>((resolve) => {
        window.webContents.once("did-finish-load", () => resolve());
      }),
      new Promise<void>((resolve) => {
        setTimeout(resolve, 8_000);
      }),
    ]);
  }
  // Prefer payload over consume so open still works if pending was already drained.
  window.webContents.send(IPC_CHANNELS.appThreadOpenRequested, threadId);
}

function evaluateDesktopNotificationDelivery(
  kind: "completion" | "approval" | "question",
  threadSelected: boolean,
): { ok: true } | { ok: false; reason: "unsupported" | "preference_disabled" } {
  return evaluateDesktopNotificationPolicy(
    kind,
    threadSelected,
    Notification.isSupported(),
    notificationSettingsStore.get(),
    getMainWindow(),
  );
}

function showDesktopNotification(content: { title: string; body: string }, threadId: string): void {
  const notification = new Notification({
    title: content.title,
    body: content.body,
    ...(appIcon ? { icon: appIcon } : {}),
  });
  notification.on("click", () => {
    void openThreadFromDesktopNotification(threadId).catch((error) => {
      process.stderr.write(
        `[eco] failed to open thread from notification (${threadId}): ${errorMessage(error)}\n`,
      );
    });
  });
  desktopNotificationRetainer.show(notification);
}

function registerIpcHandlers(): void {
  registerDesktopCommand(IPC_CHANNELS.projectTodoList, () => projectTodoStore.list());
  registerDesktopCommand(IPC_CHANNELS.projectTodoGet, (id: string) => {
    if (typeof id !== "string") throw new Error("Invalid todo ID.");
    return projectTodoStore.get(id);
  });
  registerDesktopCommand(IPC_CHANNELS.projectTodoSave, (input: ProjectTodoSave) => projectTodoStore.save(input));
  registerDesktopCommand(IPC_CHANNELS.projectTodoTrash, (input: ProjectTodoTrash) => projectTodoStore.trash(input));
  registerDesktopCommand(IPC_CHANNELS.schedulingList, () => schedulingService.store.snapshot());
  registerDesktopCommand(IPC_CHANNELS.schedulingCreate, (input: ScheduleCreateInput) => {
    if (input.kind === "scheduled_task")
      input = { ...input, executionProfile: pinSchedulingProfile(input.executionProfile) };
    return schedulingService.create(input);
  });
  registerDesktopCommand(IPC_CHANNELS.schedulingUpdate, (input: ScheduleUpdateInput) =>
    schedulingService.update({
      ...input,
      ...(input.executionProfile ? { executionProfile: pinSchedulingProfile(input.executionProfile) } : {}),
    }),
  );
  registerDesktopCommand(IPC_CHANNELS.schedulingDelete, (id: string) => schedulingService.remove(id));
  registerDesktopCommand(IPC_CHANNELS.schedulingRunNow, (input: { id: string; requestId: string }) =>
    schedulingService.runNow(input.id, input.requestId),
  );
  registerDesktopCommand(IPC_CHANNELS.schedulingPreview, (trigger: ScheduleTrigger) =>
    previewSchedule(trigger),
  );
  // Terminal paste reads through the main process: the renderer clipboard-read permission
  // stays denied, and Electron's clipboard is not gated on window focus.
  registerDesktopCommand(IPC_CHANNELS.clipboardReadText, async () => clipboard.readText());

  // Composer right-click paste reads the clipboard image here for the same reason. PNG only:
  // Electron's nativeImage stops at that format, which is also what the Composer accepts.
  registerDesktopCommand(
    IPC_CHANNELS.clipboardReadImage,
    async (): Promise<ClipboardReadImageResult | null> => {
      const image = clipboard.readImage();
      if (image.isEmpty()) {
        return null;
      }
      const png = image.toPNG();
      if (png.length === 0) {
        return null;
      }
      const pngBase64 = png.toString("base64");
      if (pngBase64.length > MAX_CLIPBOARD_IMAGE_BASE64_CHARS) {
        return null;
      }
      return { pngBase64, byteLength: png.length };
    },
  );

  // Same reason for image writes: the renderer's `navigator.clipboard.write` refuses when the
  // document is unfocused, so the image viewer retries the copy here. PNG only — Chromium and
  // nativeImage both stop at that format.
  registerDesktopCommand(IPC_CHANNELS.clipboardWriteImage, async (payload: unknown) => {
    const pngBase64 =
      isRecord(payload) && typeof payload.pngBase64 === "string" ? payload.pngBase64.trim() : "";
    if (!pngBase64 || pngBase64.length > MAX_CLIPBOARD_IMAGE_BASE64_CHARS) {
      return false;
    }
    const image = nativeImage.createFromBuffer(Buffer.from(pngBase64, "base64"));
    if (image.isEmpty()) {
      return false;
    }
    clipboard.writeImage(image);
    return true;
  });

  registerDesktopCommand(IPC_CHANNELS.cursorModelsList, async () => {
    const apiKey = workflowSettingsStore.get().acpCursorApiKey?.trim();
    return listCursorAgentModels(apiKey ? { env: { CURSOR_API_KEY: apiKey } } : {});
  });

  registerDesktopCommand(IPC_CHANNELS.coreAvailabilityGet, async () => {
    const codexAvailable = isCodexCliAvailable();
    const pi = await probePiCoreAvailability();
    const cursorProbe = await probeAcpCursorForMain();
    if (!cursorProbe.available) {
      await reconcileAcpCursorAgainstProbe(cursorProbe);
    }
    const [codexVersion, claudeVersion, cursorVersion] = await Promise.all([
      getCodexVersion(),
      getClaudeVersion(),
      getCursorVersion(),
    ]);
    return {
      claude: {
        available: true as const,
        ...(claudeVersion && { version: claudeVersion }),
      },
      codex: {
        available: codexAvailable,
        ...(!codexAvailable && {
          reason: mainText("native.codexUnavailable"),
        }),
        ...(codexVersion && { version: codexVersion }),
      },
      pi: {
        available: pi.available,
        ...(!pi.available && pi.reason
          ? { reason: pi.reason }
          : !pi.available
            ? { reason: mainText("native.piUnavailable") }
            : {}),
        ...(pi.version && { version: pi.version }),
      },
      cursor: {
        available: cursorProbe.available,
        ...(!cursorProbe.available && {
          reason: acpCursorUnavailableMessage(cursorProbe),
        }),
        ...(cursorVersion && { version: cursorVersion }),
      },
    };
  });

  ipcMain.handle(IPC_CHANNELS.appRendererReady, async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) {
      throw new Error("Renderer ready notification came from an unknown window.");
    }
    revealWindowControls(window);
    desktopRendererReady = true;
    resolveInitialDesktopRendererReady?.();
    flushPendingEcoDeepLink(window);
    return { ok: true as const };
  });

  ipcMain.on(IPC_CHANNELS.appScreenRecordingAppLabel, (event) => {
    event.returnValue = detectScreenRecordingAppLabel(app.isPackaged);
  });

  registerDesktopCommand(IPC_CHANNELS.appSetThemeSource, async (payload: unknown) => {
    const themeSource = normalizeAppThemeSource(payload);
    nativeTheme.themeSource = themeSource;
    syncWindowControlsOverlays();
    return { themeSource };
  });

  registerDesktopCommand(IPC_CHANNELS.appSetWindowTitlebarMode, async (payload: unknown) => {
    if (payload !== "landing" && payload !== "conversation") {
      throw new Error("Invalid window titlebar mode.");
    }
    setWindowControlsOverlayMode(payload);
    return { mode: payload };
  });

  registerDesktopCommand(IPC_CHANNELS.appSetLocale, async (payload: unknown) => {
    appLocalePreference = normalizeLocalePreference(payload);
    openaiAccountAssistant?.refreshTitles();
    return { localePreference: appLocalePreference };
  });

  registerDesktopCommand(IPC_CHANNELS.appUpdateGetState, async () => desktopUpdateService.getState());

  registerDesktopCommand(IPC_CHANNELS.appUpdateCheck, async () => desktopUpdateService.checkForUpdates());

  registerDesktopCommand(IPC_CHANNELS.appUpdateDownload, async () => desktopUpdateService.downloadUpdate());

  registerDesktopCommand(IPC_CHANNELS.appUpdateInstall, async () => desktopUpdateService.installUpdate());

  registerDesktopCommand(IPC_CHANNELS.appUpdateOpenRelease, async () =>
    desktopUpdateService.openReleasePage(),
  );

  registerDesktopCommand(IPC_CHANNELS.appConsumePendingThreadOpen, async () => {
    const threadId = pendingThreadOpenId;
    pendingThreadOpenId = undefined;
    return threadId;
  });

  registerDesktopCommand(IPC_CHANNELS.appShowThreadCompletionNotification, async (payload: unknown) => {
    if (
      !isRecord(payload) ||
      typeof payload.threadId !== "string" ||
      !payload.threadId.trim() ||
      typeof payload.threadSelected !== "boolean"
    ) {
      return { shown: false, reason: "invalid_request" } as const;
    }
    const gate = evaluateDesktopNotificationDelivery("completion", payload.threadSelected);
    if (!gate.ok) {
      return { shown: false, reason: gate.reason } as const;
    }
    const thread = conversationStore.getThread(payload.threadId);
    if (!thread) {
      return { shown: false, reason: "thread_not_found" } as const;
    }
    if (thread.status !== "completed") {
      return { shown: false, reason: "thread_not_completed" } as const;
    }
    // Codex keeps finals in run events; Claude may still source from SDK session.
    const content = buildThreadCompletionNotificationContentFromSources(thread, [
      await listThreadActivityFromSdkSession(thread.id),
      conversationStore.listActivityLines(thread.id),
      activityLinesFromThreadRunEvents(conversationStore.listConversationRuntimeSources(thread.id)),
    ]);
    if (!content) {
      return {
        shown: false,
        reason: "notification_content_unavailable",
      } as const;
    }

    // Reading the SDK session above yields to the event loop. The user may have
    // returned to the window or changed preferences while it was loading.
    const deliveryGate = evaluateDesktopNotificationDelivery("completion", payload.threadSelected);
    if (!deliveryGate.ok) {
      return { shown: false, reason: deliveryGate.reason } as const;
    }
    showDesktopNotification(content, thread.id);
    return { shown: true } as const;
  });

  registerDesktopCommand(IPC_CHANNELS.appShowThreadApprovalNotification, async (payload: unknown) => {
    if (
      !isRecord(payload) ||
      typeof payload.threadId !== "string" ||
      (payload.kind !== "plan" && payload.kind !== "bash") ||
      typeof payload.threadSelected !== "boolean"
    ) {
      return { shown: false, reason: "invalid_request" } as const;
    }
    const gate = evaluateDesktopNotificationDelivery("approval", payload.threadSelected);
    if (!gate.ok) {
      return { shown: false, reason: gate.reason } as const;
    }
    const thread = conversationStore.getThread(payload.threadId);
    if (!thread) {
      return { shown: false, reason: "thread_not_found" } as const;
    }
    const kind = payload.kind;
    const approval =
      kind === "plan"
        ? getPendingPlanApprovalForThread(thread.id)
        : kind === "bash"
          ? getPendingBashApprovalForThread(thread.id)
          : undefined;
    if (!approval) {
      return { shown: false, reason: "approval_not_pending" } as const;
    }
    const content = buildThreadApprovalNotificationContent(thread, kind, approval, currentAppLocale());
    if (!content) {
      return {
        shown: false,
        reason: "notification_content_unavailable",
      } as const;
    }

    showDesktopNotification(content, thread.id);
    return { shown: true } as const;
  });

  registerDesktopCommand(IPC_CHANNELS.appShowThreadClarificationNotification, async (payload: unknown) => {
    if (
      !isRecord(payload) ||
      typeof payload.threadId !== "string" ||
      !payload.threadId.trim() ||
      typeof payload.toolUseId !== "string" ||
      !payload.toolUseId.trim() ||
      typeof payload.threadSelected !== "boolean"
    ) {
      return { shown: false, reason: "invalid_request" } as const;
    }
    const gate = evaluateDesktopNotificationDelivery("question", payload.threadSelected);
    if (!gate.ok) {
      return { shown: false, reason: gate.reason } as const;
    }
    const thread = conversationStore.getThread(payload.threadId);
    if (!thread) {
      return { shown: false, reason: "thread_not_found" } as const;
    }
    const clarification = getPendingClarificationByToolUseId(payload.toolUseId);
    if (!clarification || clarification.threadId !== thread.id) {
      return { shown: false, reason: "clarification_not_pending" } as const;
    }
    const content = buildThreadClarificationNotificationContent(thread, clarification, currentAppLocale());
    if (!content) {
      return {
        shown: false,
        reason: "notification_content_unavailable",
      } as const;
    }

    showDesktopNotification(content, thread.id);
    return { shown: true } as const;
  });

  registerDesktopCommand(IPC_CHANNELS.workspaceOpen, async () => {
    const result = await dialog.showOpenDialog({
      title: mainText("native.openProject"),
      properties: ["openDirectory"],
    });

    const selectedPath = result.filePaths[0];
    if (result.canceled || !selectedPath) {
      return { canceled: true };
    }

    currentWorkspace = await inspectWorkspace(selectedPath);
    syncGitAutoFetcherWorkspace();
    return { canceled: false, workspace: currentWorkspace };
  });

  registerDesktopCommand(IPC_CHANNELS.workspaceOpenPath, async (workspacePath: unknown) => {
    if (typeof workspacePath !== "string" || !workspacePath.trim()) {
      throw new Error("Workspace path is required.");
    }
    const resolvedPath = path.resolve(workspacePath.trim());
    const stat = await fs.stat(resolvedPath);
    if (!stat.isDirectory()) {
      throw new Error("请选择文件夹，而不是文件。");
    }
    currentWorkspace = await inspectWorkspace(resolvedPath);
    syncGitAutoFetcherWorkspace();
    return currentWorkspace;
  });

  registerDesktopCommand(IPC_CHANNELS.workspaceGetCurrent, async () => currentWorkspace);

  registerDesktopCommand(IPC_CHANNELS.workspaceGetHomePath, async () => getHomeProjectPath());

  registerDesktopCommand(IPC_CHANNELS.workspaceGetUserHomePath, async () => os.homedir());

  registerDesktopCommand(IPC_CHANNELS.workspaceListDirectories, async (directoryPath: unknown) => {
    if (typeof directoryPath !== "string" || !directoryPath.trim()) {
      throw new Error("Directory path is required.");
    }
    const resolvedPath = path.resolve(directoryPath.trim());
    const stat = await fs.stat(resolvedPath);
    if (!stat.isDirectory()) {
      throw new Error("请选择文件夹，而不是文件。");
    }
    const entries = await fs.readdir(resolvedPath, { withFileTypes: true });
    const directories = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({
        name: entry.name,
        path: path.join(resolvedPath, entry.name),
      }))
      .sort((left, right) =>
        left.name.localeCompare(right.name, undefined, {
          sensitivity: "base",
        }),
      );
    const parentPath = path.dirname(resolvedPath);
    return {
      path: resolvedPath,
      ...(parentPath !== resolvedPath ? { parentPath } : {}),
      directories,
    };
  });

  registerDesktopCommand(IPC_CHANNELS.workspaceListEntries, async (payload: unknown) => {
    if (!payload || typeof payload !== "object") {
      throw new Error("Invalid workspace list entries request.");
    }
    const request = payload as {
      workspacePath?: unknown;
      directoryPath?: unknown;
    };
    if (typeof request.workspacePath !== "string" || typeof request.directoryPath !== "string") {
      throw new Error("Workspace path and directory path are required.");
    }
    return listWorkspaceEntries({
      workspacePath: request.workspacePath,
      directoryPath: request.directoryPath,
    });
  });

  registerDesktopCommand(IPC_CHANNELS.workspaceReadFile, async (payload: unknown) => {
    if (!payload || typeof payload !== "object") {
      throw new Error("Invalid workspace read file request.");
    }
    const request = payload as {
      workspacePath?: unknown;
      filePath?: unknown;
      offset?: unknown;
      revision?: unknown;
    };
    if (typeof request.workspacePath !== "string" || typeof request.filePath !== "string") {
      throw new Error("Workspace path and file path are required.");
    }
    if (request.offset !== undefined && typeof request.offset !== "number") {
      throw new Error("Invalid file offset.");
    }
    if (request.revision !== undefined && typeof request.revision !== "string") {
      throw new Error("Invalid file revision.");
    }
    return readWorkspaceFile({
      workspacePath: request.workspacePath,
      filePath: request.filePath,
      ...(request.offset === undefined ? {} : { offset: request.offset }),
      ...(request.revision === undefined ? {} : { revision: request.revision }),
    });
  });

  async function openFileWithAppWindows(bundleId: string, filePath: string): Promise<void> {
    // If bundleId is an executable name, find its path and run it directly
    if (bundleId.toLowerCase().endsWith(".exe")) {
      const { stdout: exePathOutput } = await execFileAsync("where", [bundleId]).catch(() => ({
        stdout: "",
      }));
      const exePath = exePathOutput.split("\n")[0]?.trim();
      if (exePath) {
        const child = spawn(exePath, [filePath], {
          detached: true,
          stdio: "ignore",
          windowsHide: false,
        });
        child.on("error", (err) => {
          console.error("[OpenFileWithApp] spawn error:", err.message);
        });
        child.unref();
        return;
      }
      throw new Error("找不到应用程序: " + bundleId);
    }

    // For ProgIDs, get the command from HKCR\{ProgID}\shell\open\command
    const { stdout: commandOutput } = await execFileAsync("reg", [
      "query",
      `HKCR\\${bundleId}\\shell\\open\\command`,
      "/ve",
    ]).catch(() => ({ stdout: "" }));

    const cmdMatch = commandOutput.match(/REG_SZ\s+(.+)/);
    if (cmdMatch?.[1]) {
      const command = cmdMatch[1].trim().replace(/\r$/, "");
      // Extract the executable path (handling quotes)
      let exePath: string;
      if (command.startsWith('"')) {
        const endQuote = command.indexOf('"', 1);
        exePath = command.substring(1, endQuote);
      } else {
        const firstSpace = command.indexOf(" ");
        exePath = firstSpace === -1 ? command : command.substring(0, firstSpace);
      }
      // Verify the executable exists
      try {
        await fs.access(exePath);
      } catch {
        throw new Error(`找不到应用程序: ${exePath}`);
      }
      // Launch the executable with spawn (detached, no wait)
      // This is more reliable for GUI applications than execFile
      const child = spawn(exePath, [filePath], {
        detached: true,
        stdio: "ignore",
        windowsHide: false,
      });
      child.on("error", (err) => {
        console.error("[OpenFileWithApp] spawn error:", err.message);
      });
      child.unref();
      return;
    }

    // Fallback: use start command (opens with default app)
    await execFileAsync("cmd", ["/c", "start", `""`, `"${filePath}"`]);
  }

  registerDesktopCommand(IPC_CHANNELS.workspaceWriteFile, async (payload: unknown) => {
    if (!payload || typeof payload !== "object") {
      throw new Error("Invalid workspace write file request.");
    }
    const request = payload as {
      workspacePath?: unknown;
      filePath?: unknown;
      content?: unknown;
    };
    if (typeof request.workspacePath !== "string" || typeof request.filePath !== "string") {
      throw new Error("Workspace path and file path are required.");
    }
    if (typeof request.content !== "string") {
      throw new Error("Content must be a string.");
    }
    return writeWorkspaceFile({
      workspacePath: request.workspacePath,
      filePath: request.filePath,
      content: request.content,
    });
  });

  registerDesktopCommand(IPC_CHANNELS.workspaceInspect, async (workspacePath: unknown) => {
    if (typeof workspacePath !== "string" || !workspacePath.trim()) {
      throw new Error("Workspace path is required.");
    }
    return inspectWorkspace(workspacePath.trim());
  });

  registerDesktopCommand(IPC_CHANNELS.workspaceOpenInFileManager, async (workspacePath: unknown) => {
    if (typeof workspacePath !== "string" || !workspacePath.trim()) {
      throw new Error("Workspace path is required.");
    }
    const resolvedPath = path.resolve(workspacePath.trim());
    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stat = await fs.stat(resolvedPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error("找不到该项目目录。");
      }
      throw error;
    }
    if (!stat.isDirectory()) {
      throw new Error("请选择文件夹，而不是文件。");
    }
    const openError = await shell.openPath(resolvedPath);
    if (openError) {
      throw new Error(openError);
    }
  });

  registerDesktopCommand(IPC_CHANNELS.workspaceOpenFileExternally, async (filePath: unknown) => {
    if (typeof filePath !== "string" || !filePath.trim()) {
      throw new Error("File path is required.");
    }
    const cleanPath = filePath.trim().replace(/[\\/]+$/, "");
    const resolvedPath = path.resolve(cleanPath);
    let fileStat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      fileStat = await fs.stat(resolvedPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error("找不到该文件。");
      }
      throw error;
    }
    if (!fileStat.isFile()) {
      throw new Error("请选择一个文件。");
    }
    const openError = await shell.openPath(resolvedPath);
    if (openError) {
      throw new Error(openError);
    }
  });

  registerDesktopCommand(IPC_CHANNELS.workspaceOpenContainingFolder, async (filePath: unknown) => {
    if (typeof filePath !== "string" || !filePath.trim()) {
      throw new Error("File path is required.");
    }
    const cleanPath = filePath.trim().replace(/[\\/]+$/, "");
    const resolvedPath = path.resolve(cleanPath);
    let fileStat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      fileStat = await fs.stat(resolvedPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error("找不到该文件。");
      }
      throw error;
    }
    if (!fileStat.isFile()) {
      throw new Error("请选择一个文件。");
    }
    shell.showItemInFolder(resolvedPath);
  });

  registerDesktopCommand(IPC_CHANNELS.workspaceGetAssociatedApps, async (filePath: unknown) => {
    if (typeof filePath !== "string" || !filePath.trim()) {
      throw new Error("File path is required.");
    }
    const cleanPath = filePath.trim().replace(/[\\/]+$/, "");
    const resolvedPath = path.resolve(cleanPath);
    let fileStat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      fileStat = await fs.stat(resolvedPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error("找不到该文件。");
      }
      throw error;
    }
    if (!fileStat.isFile()) {
      throw new Error("请选择一个文件。");
    }
    const { getAssociatedApps } = await import("./get-associated-apps");
    return getAssociatedApps(resolvedPath);
  });

  registerDesktopCommand(IPC_CHANNELS.workspaceOpenFileWithApp, async (payload: unknown) => {
    if (!payload || typeof payload !== "object") {
      throw new Error("Invalid request payload.");
    }
    const { filePath, bundleId } = payload as {
      filePath?: string;
      bundleId?: string;
    };
    console.log(
      `[OpenFileWithApp] Received payload: filePath=${JSON.stringify(filePath)} bundleId=${JSON.stringify(bundleId)}`,
    );
    if (typeof filePath !== "string" || !filePath.trim()) {
      throw new Error("File path is required.");
    }
    if (typeof bundleId !== "string" || !bundleId.trim()) {
      throw new Error("Application identifier is required.");
    }
    const cleanPath = filePath.trim().replace(/[\\/]+$/, "");
    const resolvedPath = path.resolve(cleanPath);
    console.log(`[OpenFileWithApp] resolvedPath=${JSON.stringify(resolvedPath)}`);
    let fileStat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      fileStat = await fs.stat(resolvedPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error("找不到该文件。");
      }
      throw error;
    }
    if (!fileStat.isFile()) {
      throw new Error("请选择一个文件。");
    }
    console.log(
      `[OpenFileWithApp] platform=${process.platform} bundleId=${bundleId} resolvedPath=${resolvedPath}`,
    );
    if (process.platform === "darwin") {
      await execFileAsync("open", ["-b", bundleId.trim(), resolvedPath]);
    } else if (process.platform === "win32") {
      await openFileWithAppWindows(bundleId.trim(), resolvedPath);
    } else {
      // Linux: use xdg-open with the desktop file
      await execFileAsync("xdg-open", [resolvedPath]);
    }
  });

  registerDesktopCommand(IPC_CHANNELS.workspaceListPackageScripts, async (workspacePath: unknown) => {
    if (typeof workspacePath !== "string" || !workspacePath.trim()) {
      throw new Error("Workspace path is required.");
    }
    const trimmed = workspacePath.trim();
    const listing = await listPackageScripts(trimmed);
    const overrides = await packageScriptArgsStore.getWorkspaceOverrides(trimmed);
    return { ...listing, scriptArgs: overrides.args, scriptPrefixes: overrides.prefixes };
  });

  registerDesktopCommand(IPC_CHANNELS.workspaceSavePackageScriptArgs, async (payload: unknown) => {
    if (!isSavePackageScriptArgsRequest(payload)) {
      throw new Error("Invalid save package script args request.");
    }
    const overrides = await packageScriptArgsStore.saveScriptOverrides(
      payload.workspacePath,
      payload.script,
      {
        ...(payload.args !== undefined ? { args: payload.args } : {}),
        ...(payload.prefix !== undefined ? { prefix: payload.prefix } : {}),
      },
    );
    return {
      workspacePath: path.resolve(payload.workspacePath),
      scriptArgs: overrides.args,
      scriptPrefixes: overrides.prefixes,
    };
  });

  registerDesktopCommand(IPC_CHANNELS.workspaceWatchPackageJson, async (workspacePath: unknown) => {
    if (typeof workspacePath !== "string" || !workspacePath.trim()) {
      throw new Error("Workspace path is required.");
    }
    packageJsonWatcher.watch(workspacePath.trim());
    return { ok: true as const };
  });

  registerDesktopCommand(IPC_CHANNELS.workspaceStartPackageScript, async (payload: unknown) => {
    if (!isRunPackageScriptRequest(payload)) {
      throw new Error("Invalid start package script request.");
    }
    const saved = await packageScriptArgsStore.getWorkspaceOverrides(payload.workspacePath);
    const prepared = await preparePackageScriptRun(payload, saved);
    const launched = runPreparedPackageScriptAsBackgroundTask(backgroundTerminalTaskRegistry, prepared, {
      ...(payload.threadId?.trim() && {
        threadId: payload.threadId.trim(),
      }),
    });
    const result = {
      script: launched.script,
      command: launched.command,
      commandLabel: launched.commandLabel,
      sessionId: launched.sessionId,
      taskId: launched.taskId,
    };
    broadcastPackageScriptTerminalLaunch({
      workspacePath: prepared.workspacePath,
      ...result,
    });
    return result;
  });

  registerDesktopCommand(IPC_CHANNELS.backgroundTerminalList, async (payload: unknown) => {
    if (payload !== undefined && !isBackgroundTerminalListRequest(payload)) {
      throw new Error("Invalid background terminal list request.");
    }
    return backgroundTerminalTaskRegistry.list(payload ?? {});
  });

  registerDesktopCommand(IPC_CHANNELS.backgroundTerminalStart, async (payload: unknown) => {
    if (!isBackgroundTerminalStartRequest(payload)) {
      throw new Error("Invalid background terminal start request.");
    }
    const task = backgroundTerminalTaskRegistry.start(payload);
    desktopEventCenter.publishTerminalEvent({
      type: "started",
      sessionId: task.sessionId,
      workspacePath: task.workspacePath,
    });
    return task;
  });

  registerDesktopCommand(IPC_CHANNELS.backgroundTerminalOpen, async (payload: unknown) => {
    if (!isBackgroundTerminalOpenRequest(payload)) {
      throw new Error("Invalid background terminal open request.");
    }
    const task = backgroundTerminalTaskRegistry.get(payload.taskId);
    if (!task) {
      throw new Error(`Background terminal task not found: ${payload.taskId}`);
    }
    return task;
  });

  registerDesktopCommand(IPC_CHANNELS.backgroundTerminalStop, async (payload: unknown) => {
    if (!isBackgroundTerminalStopRequest(payload)) {
      throw new Error("Invalid background terminal stop request.");
    }
    return backgroundTerminalTaskRegistry.stop(payload.taskId);
  });

  registerDesktopCommand(IPC_CHANNELS.codexBackgroundTerminalList, async () => {
    return getCodexBackgroundTerminalService().list();
  });

  registerDesktopCommand(IPC_CHANNELS.codexBackgroundTerminalTerminate, async (payload: unknown) => {
    if (!isCodexBackgroundTerminalTerminateRequest(payload)) {
      throw new Error("Invalid Codex background terminal termination request.");
    }
    return getCodexBackgroundTerminalService().terminate(payload);
  });

  registerDesktopCommand(IPC_CHANNELS.claudeBackgroundTaskList, async () => {
    return claudeBackgroundTaskRegistry.list();
  });

  registerDesktopCommand(IPC_CHANNELS.claudeBackgroundTaskStop, async (payload: unknown) => {
    if (!isClaudeBackgroundTaskStopRequest(payload)) {
      throw new Error("Invalid Claude background task stop request.");
    }
    return claudeBackgroundTaskRegistry.stop(payload.threadId, payload.taskId);
  });

  registerDesktopCommand(IPC_CHANNELS.terminalList, async (payload: unknown) => {
    if (payload !== undefined && !isTerminalListRequest(payload)) {
      throw new Error("Invalid terminal list request.");
    }
    const request = (payload ?? {}) as TerminalListRequest;
    return interactiveTerminalManager.list(request.workspacePath);
  });

  registerDesktopCommand(IPC_CHANNELS.terminalSpawn, async (payload: unknown) => {
    if (!isTerminalSpawnRequest(payload)) {
      throw new Error("Invalid terminal spawn request.");
    }
    const workspacePath = payload.workspacePath.trim();
    if (!workspacePath) {
      throw new Error("Workspace path is required.");
    }
    const cols = payload.cols;
    const rows = payload.rows;
    const size =
      typeof cols === "number" &&
      typeof rows === "number" &&
      Number.isFinite(cols) &&
      Number.isFinite(rows) &&
      cols > 0 &&
      rows > 0
        ? { cols: Math.floor(cols), rows: Math.floor(rows) }
        : undefined;
    return interactiveTerminalManager.spawn(workspacePath, size);
  });

  registerDesktopCommand(IPC_CHANNELS.terminalInput, async (payload: unknown) => {
    if (!isTerminalInputRequest(payload)) {
      throw new Error("Invalid terminal input request.");
    }
    interactiveTerminalManager.write(payload.sessionId, payload.data);
  });

  registerDesktopCommand(IPC_CHANNELS.terminalResize, async (payload: unknown) => {
    if (!isTerminalResizeRequest(payload)) {
      throw new Error("Invalid terminal resize request.");
    }
    interactiveTerminalManager.resize(payload.sessionId, payload.cols, payload.rows);
  });

  registerDesktopCommand(IPC_CHANNELS.terminalKill, async (payload: unknown) => {
    if (!isTerminalKillRequest(payload)) {
      throw new Error("Invalid terminal kill request.");
    }
    return { killed: interactiveTerminalManager.kill(payload.sessionId) };
  });

  registerDesktopCommand(IPC_CHANNELS.workspacePrepareGit, async (payload: unknown) => {
    const workspacePath =
      payload &&
      typeof payload === "object" &&
      typeof (payload as { workspacePath?: unknown }).workspacePath === "string"
        ? (payload as { workspacePath: string }).workspacePath.trim()
        : "";
    if (!workspacePath) {
      throw new Error("Workspace path is required.");
    }
    const workspace = await prepareWorkspaceGit(workspacePath, gitRunner.run);
    currentWorkspace = workspace;
    syncGitAutoFetcherWorkspace();
    return workspace;
  });

  registerDesktopCommand(
    IPC_CHANNELS.composerReferencesSearch,
    async (request: ComposerReferenceSearchRequest) => composerReferenceService.search(request),
  );
  registerDesktopCommand(IPC_CHANNELS.threadList, async () =>
    attachThreadListCancelling(conversationStore.listThreads()),
  );

  registerDesktopCommand(IPC_CHANNELS.threadListInitial, async () => {
    const result = conversationStore.listInitialThreads(REMOTE_THREAD_LIST_INITIAL_LIMIT_PER_WORKSPACE);
    return {
      ...result,
      threads: attachThreadListCancelling(result.threads),
    };
  });

  registerDesktopCommand(IPC_CHANNELS.threadListMore, async (payload: unknown) => {
    if (!isRecord(payload) || typeof payload.workspacePath !== "string" || !isRecord(payload.cursor)) {
      throw new Error("Invalid thread list page request.");
    }
    const cursor = payload.cursor;
    if (
      typeof cursor.updatedAt !== "string" ||
      typeof cursor.createdAt !== "string" ||
      typeof cursor.id !== "string"
    ) {
      throw new Error("Invalid thread list page cursor.");
    }
    const limit = typeof payload.limit === "number" && Number.isFinite(payload.limit) ? payload.limit : 20;
    const page = conversationStore.listThreadPage(
      payload.workspacePath,
      {
        updatedAt: cursor.updatedAt,
        createdAt: cursor.createdAt,
        id: cursor.id,
      } satisfies ThreadListCursor,
      limit,
    );
    return { ...page, threads: attachThreadListCancelling(page.threads) };
  });

  registerDesktopCommand(IPC_CHANNELS.threadGet, async (threadId: unknown) => {
    const id = typeof threadId === "string" ? threadId.trim() : "";
    if (!id) {
      return undefined;
    }
    const thread = conversationStore.getThread(id);
    if (!thread) {
      return undefined;
    }
    const enriched = attachThreadCancelling(ensureThreadRuntimeConfig(thread));
    if (titleGeneratingThreadIds.has(id)) {
      return { ...enriched, titleGenerating: true } satisfies ThreadSummary;
    }
    return enriched;
  });

  registerDesktopCommand(IPC_CHANNELS.composerDraftGet, async (contextKey: unknown) => {
    const draft = conversationStore.getComposerDraft(parseComposerDraftContextKey(contextKey));
    if (!draft?.attachments?.length) {
      return draft;
    }
    const attachments = await Promise.all(
      draft.attachments.map(async (attachment) => {
        if (attachment.data?.trim()) {
          return attachment;
        }
        if (!attachment.path?.trim()) {
          return attachment;
        }
        return {
          mediaType: attachment.mediaType,
          path: attachment.path,
          data: await promptImageFileStore.readAttachmentData(attachment),
          ...(attachment.contentRef?.trim() ? { contentRef: attachment.contentRef.trim() } : {}),
          ...(attachment.byteLength !== undefined ? { byteLength: attachment.byteLength } : {}),
        };
      }),
    );
    return {
      ...draft,
      attachments,
    };
  });

  registerDesktopCommand(IPC_CHANNELS.composerDraftSave, async (payload: unknown) => {
    if (!payload || typeof payload !== "object") {
      throw new Error("Invalid composer draft save request.");
    }
    const record = payload as {
      contextKey?: unknown;
      prompt?: unknown;
      attachments?: unknown;
      recoveryReason?: unknown;
    };
    if (typeof record.prompt !== "string") {
      throw new Error("Composer draft prompt must be a string.");
    }
    const contextKey = parseComposerDraftContextKey(record.contextKey);
    const attachments = await normalizeComposerDraftAttachments(
      contextKey,
      parsePromptImageAttachments(record.attachments),
    );
    return conversationStore.saveComposerDraft(
      contextKey,
      record.prompt,
      attachments,
      typeof record.recoveryReason === "string" ? record.recoveryReason : undefined,
    );
  });

  registerDesktopCommand(IPC_CHANNELS.composerDraftDelete, async (payload: unknown) => {
    if (typeof payload === "string") {
      return {
        ok: true as const,
        deleted: conversationStore.deleteComposerDraft(parseComposerDraftContextKey(payload)),
      };
    }
    if (!payload || typeof payload !== "object") {
      throw new Error("Invalid composer draft delete request.");
    }
    const record = payload as {
      contextKey?: unknown;
      expectedRevision?: unknown;
      releaseAttachments?: unknown;
    };
    const expectedRevision =
      typeof record.expectedRevision === "string" && record.expectedRevision.trim()
        ? record.expectedRevision.trim()
        : undefined;
    const releaseAttachments =
      record.releaseAttachments === false ? { releaseAttachments: false as const } : undefined;
    return {
      ok: true as const,
      deleted: conversationStore.deleteComposerDraft(
        parseComposerDraftContextKey(record.contextKey),
        expectedRevision,
        releaseAttachments,
      ),
    };
  });

  registerDesktopCommand(IPC_CHANNELS.promptImageStage, async (payload: unknown) => {
    if (!payload || typeof payload !== "object") {
      throw new Error("Invalid prompt image stage request.");
    }
    const record = payload as {
      contextKey?: unknown;
      imageId?: unknown;
      mediaType?: unknown;
      data?: unknown;
    };
    const contextKey = parseComposerDraftContextKey(record.contextKey);
    const imageId = typeof record.imageId === "string" ? record.imageId.trim() : "";
    if (!imageId) {
      throw new Error("Prompt image id is required.");
    }
    if (!isPromptImageMediaType(record.mediaType)) {
      throw new Error("Unsupported image attachment media type.");
    }
    const data = typeof record.data === "string" ? record.data.trim() : "";
    if (!data) {
      throw new Error("Image attachment data is required.");
    }
    return promptImageFileStore.stageComposerImage({
      contextKey,
      imageId,
      mediaType: record.mediaType,
      dataBase64: data,
    });
  });

  registerDesktopCommand(IPC_CHANNELS.promptImageUploadBegin, async (payload: unknown) => {
    if (!payload || typeof payload !== "object") {
      throw new Error("Invalid prompt image upload begin request.");
    }
    const record = payload as {
      contextKey?: unknown;
      imageId?: unknown;
      mediaType?: unknown;
      totalBytes?: unknown;
    };
    const contextKey = parseComposerDraftContextKey(record.contextKey);
    const imageId = typeof record.imageId === "string" ? record.imageId.trim() : "";
    if (!imageId) {
      throw new Error("Prompt image id is required.");
    }
    if (!isPromptImageMediaType(record.mediaType)) {
      throw new Error("Unsupported image attachment media type.");
    }
    if (typeof record.totalBytes !== "number" || !Number.isFinite(record.totalBytes)) {
      throw new Error("Image upload totalBytes is required.");
    }
    return promptImageFileStore.beginComposerImageUpload({
      contextKey,
      imageId,
      mediaType: record.mediaType,
      totalBytes: record.totalBytes,
    });
  });

  registerDesktopCommand(IPC_CHANNELS.promptImageUploadChunk, async (payload: unknown) => {
    if (!payload || typeof payload !== "object") {
      throw new Error("Invalid prompt image upload chunk request.");
    }
    const record = payload as {
      contextKey?: unknown;
      imageId?: unknown;
      mediaType?: unknown;
      offset?: unknown;
      data?: unknown;
    };
    const contextKey = parseComposerDraftContextKey(record.contextKey);
    const imageId = typeof record.imageId === "string" ? record.imageId.trim() : "";
    if (!imageId) {
      throw new Error("Prompt image id is required.");
    }
    if (!isPromptImageMediaType(record.mediaType)) {
      throw new Error("Unsupported image attachment media type.");
    }
    if (typeof record.offset !== "number" || !Number.isFinite(record.offset)) {
      throw new Error("Image upload offset is required.");
    }
    const data = typeof record.data === "string" ? record.data.trim() : "";
    if (!data) {
      throw new Error("Image upload chunk data is required.");
    }
    return promptImageFileStore.writeComposerImageChunk({
      contextKey,
      imageId,
      mediaType: record.mediaType,
      offset: record.offset,
      dataBase64: data,
    });
  });

  registerDesktopCommand(IPC_CHANNELS.promptImageUploadFinish, async (payload: unknown) => {
    if (!payload || typeof payload !== "object") {
      throw new Error("Invalid prompt image upload finish request.");
    }
    const record = payload as {
      contextKey?: unknown;
      imageId?: unknown;
      mediaType?: unknown;
      totalBytes?: unknown;
    };
    const contextKey = parseComposerDraftContextKey(record.contextKey);
    const imageId = typeof record.imageId === "string" ? record.imageId.trim() : "";
    if (!imageId) {
      throw new Error("Prompt image id is required.");
    }
    if (!isPromptImageMediaType(record.mediaType)) {
      throw new Error("Unsupported image attachment media type.");
    }
    if (typeof record.totalBytes !== "number" || !Number.isFinite(record.totalBytes)) {
      throw new Error("Image upload totalBytes is required.");
    }
    return promptImageFileStore.finishComposerImageUpload({
      contextKey,
      imageId,
      mediaType: record.mediaType,
      totalBytes: record.totalBytes,
    });
  });

  registerDesktopCommand(IPC_CHANNELS.promptImageReadChunk, async (payload: unknown) => {
    if (!payload || typeof payload !== "object") {
      throw new Error("Invalid prompt image read request.");
    }
    const record = payload as {
      contextKey?: unknown;
      contentRef?: unknown;
      mediaType?: unknown;
      offset?: unknown;
      maxBytes?: unknown;
    };
    const contextKey = parseComposerDraftContextKey(record.contextKey);
    const contentRef = typeof record.contentRef === "string" ? record.contentRef.trim() : "";
    if (!contentRef) throw new Error("Prompt image contentRef is required.");
    if (!isPromptImageMediaType(record.mediaType)) {
      throw new Error("Unsupported image attachment media type.");
    }
    if (typeof record.offset !== "number" || !Number.isSafeInteger(record.offset) || record.offset < 0) {
      throw new Error("Image read offset is required.");
    }
    if (
      record.maxBytes !== undefined &&
      (typeof record.maxBytes !== "number" || !Number.isSafeInteger(record.maxBytes) || record.maxBytes <= 0)
    ) {
      throw new Error("Image read maxBytes must be a positive integer.");
    }
    if (!conversationStore.isPromptImageContentRefAuthorized(contextKey, contentRef)) {
      throw new ConversationV2Error(
        CONVERSATION_V2_ERROR.integrityFailure,
        "Prompt image content reference is not authorized for this context.",
      );
    }
    return promptImageFileStore.readAttachmentChunk({
      contentRef,
      mediaType: record.mediaType,
      offset: record.offset,
      ...(record.maxBytes !== undefined ? { maxBytes: record.maxBytes } : {}),
    });
  });

  registerDesktopCommand(IPC_CHANNELS.promptImageRelease, async (payload: unknown) => {
    if (!payload || typeof payload !== "object") {
      throw new Error("Invalid prompt image release request.");
    }
    const record = payload as { paths?: unknown };
    const paths = Array.isArray(record.paths)
      ? record.paths.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
      : [];
    await promptImageFileStore.releasePaths(paths);
    return { ok: true as const };
  });

  registerDesktopCommand(IPC_CHANNELS.threadSessionBootstrap, async (threadId: unknown) => {
    const id = typeof threadId === "string" ? threadId.trim() : "";
    const result = buildThreadSessionBootstrap(id, {
      getThread: (targetId) => {
        const thread = conversationStore.getThread(targetId);
        return thread ? ensureThreadRuntimeConfig(thread) : undefined;
      },
      listFollowUps: (targetId) => conversationStore.listThreadFollowUps(targetId),
      getPendingPlan: (targetId) => conversationStore.getPendingPlan(targetId),
      getPendingBashApproval: (targetId) => getPendingBashApprovalForThread(targetId),
      getPendingClarification: (targetId) => getPendingClarificationForThread(targetId),
    });
    if (id && result.thread && titleGeneratingThreadIds.has(id)) {
      return {
        ...result,
        thread: { ...result.thread, titleGenerating: true },
      } satisfies ThreadSessionBootstrapResult;
    }
    return result;
  });

  // Conversation storage/sync V2. These handlers expose the durable event
  // range and read models directly; retired projection commands are kept only
  // in internal migration/replay helpers and are not exposed to clients.
  registerDesktopCommand(IPC_CHANNELS.conversationCapabilities, async () =>
    conversationStore.conversationV2().capabilities(),
  );

  registerDesktopCommand(IPC_CHANNELS.conversationBootstrap, async (payload: unknown) => {
    const request = parseConversationV2Request(payload, ["conversationId"]);
    requireConversationV2Thread(request.conversationId);
    conversationStore.reconcileConversationV2Runs(request.conversationId);
    return conversationStore
      .conversationV2()
      .bootstrap(
        request.conversationId,
        readPositiveInteger(request.pageSize, 30),
        readPositiveInteger(request.maxBytes, undefined),
      );
  });

  registerDesktopCommand(IPC_CHANNELS.conversationProjection, async (payload: unknown) => {
    const request = parseConversationV2Request(payload, ["conversationId"]);
    requireConversationV2Thread(request.conversationId);
    return (
      conversationStore.getConversationV2ProjectionExtras(request.conversationId) ?? {
        requestSpans: [],
      }
    );
  });

  registerDesktopCommand(IPC_CHANNELS.conversationMessagesPage, async (payload: unknown) => {
    const request = parseConversationV2Request(payload, ["conversationId"]);
    requireConversationV2Thread(request.conversationId);
    return conversationStore
      .conversationV2()
      .messagesPage(
        request.conversationId,
        readOptionalConversationV2String(request.beforeCursor, "beforeCursor"),
        readPositiveInteger(request.limit, 30),
        readPositiveInteger(request.maxBytes, undefined),
      );
  });

  registerDesktopCommand(IPC_CHANNELS.conversationDetailsPage, async (payload: unknown) => {
    const request = parseConversationV2Request(payload, ["conversationId", "runId"]);
    requireConversationV2Thread(request.conversationId);
    return conversationStore
      .conversationV2()
      .detailsPage(
        request.conversationId,
        request.runId,
        readOptionalConversationV2String(request.cursor, "cursor"),
        readPositiveInteger(request.limit, 50),
        readPositiveInteger(request.maxBytes, undefined),
        readOptionalConversationV2String(request.toolCallId, "toolCallId"),
        readOptionalConversationV2String(request.agentInstanceId, "agentInstanceId"),
      );
  });

  registerDesktopCommand(IPC_CHANNELS.conversationToolsPage, async (payload: unknown) => {
    const request = parseConversationV2Request(payload, ["conversationId", "runId"]);
    requireConversationV2Thread(request.conversationId);
    return conversationStore
      .conversationV2()
      .toolsPage(
        request.conversationId,
        request.runId,
        readOptionalConversationV2String(request.cursor, "cursor"),
        readPositiveInteger(request.limit, 50),
        readPositiveInteger(request.maxBytes, undefined),
        readOptionalConversationV2String(request.toolCallId, "toolCallId"),
        readOptionalConversationV2String(request.agentInstanceId, "agentInstanceId"),
      );
  });

  registerDesktopCommand(IPC_CHANNELS.conversationSync, async (payload: unknown) => {
    const request = parseConversationV2Request(
      payload,
      ["conversationId", "storeEpoch", "afterSeq"],
      ["conversationId", "storeEpoch"],
    );
    requireConversationV2Thread(request.conversationId);
    const afterSeq = requiredConversationV2Integer(request.afterSeq, "afterSeq");
    return conversationStore
      .conversationV2()
      .sync(
        request.conversationId,
        request.storeEpoch,
        afterSeq,
        readOptionalInteger(request.throughSeq),
        readPositiveInteger(request.maxEvents, undefined),
        readPositiveInteger(request.maxBytes, undefined),
      );
  });

  registerDesktopCommand(IPC_CHANNELS.conversationHead, async (conversationId: unknown) => {
    const id = requiredConversationV2String(conversationId, "conversationId");
    // Reading a revision (including before deletion) does not load content.
    // Leave read-model repairs to the content-loading commands.
    requireConversationV2Thread(id, { repairOnLoad: false });
    return conversationStore.conversationV2().head(id);
  });

  registerDesktopCommand(IPC_CHANNELS.conversationMessageGet, async (payload: unknown) => {
    const request = parseConversationV2Request(payload, ["conversationId", "messageId"]);
    requireConversationV2Thread(request.conversationId);
    return conversationStore.conversationV2().getMessage(request.conversationId, request.messageId);
  });

  registerDesktopCommand(IPC_CHANNELS.conversationRunGet, async (payload: unknown) => {
    const request = parseConversationV2Request(payload, ["conversationId", "runId"]);
    requireConversationV2Thread(request.conversationId);
    return conversationStore.conversationV2().getRun(request.conversationId, request.runId);
  });

  registerDesktopCommand(IPC_CHANNELS.conversationDetailGet, async (payload: unknown) => {
    const request = parseConversationV2Request(payload, ["conversationId", "itemId"]);
    requireConversationV2Thread(request.conversationId);
    return conversationStore.conversationV2().getDetail(request.conversationId, request.itemId);
  });

  registerDesktopCommand(IPC_CHANNELS.conversationSendMessage, async (payload: unknown) => {
    const request = parseConversationV2Request(payload, [
      "principalId",
      "conversationId",
      "clientCommandId",
      "text",
    ]);
    requireConversationV2Thread(request.conversationId);
    const attachments = parsePromptImageAttachments(request.attachments);
    const turnId = readOptionalConversationV2String(request.turnId, "turnId");
    const messageId = readOptionalConversationV2String(request.messageId, "messageId");
    const accepted = conversationStore.conversationV2().sendMessage({
      principalId: request.principalId,
      conversationId: request.conversationId,
      clientCommandId: request.clientCommandId,
      text: request.text,
      ...(turnId ? { turnId } : {}),
      ...(messageId ? { messageId } : {}),
      ...(attachments.length > 0 ? { attachments } : {}),
    });
    void scheduleAcceptedConversationMessage({
      ...accepted,
      text: request.text,
      ...(attachments.length > 0 ? { attachments } : {}),
    }).catch((error) => {
      process.stderr.write(
        `[eco] failed to schedule accepted V2 message (${accepted.conversationId}): ${errorMessage(error)}\n`,
      );
    });
    return accepted;
  });

  registerDesktopCommand(IPC_CHANNELS.threadDelete, async (payload: unknown) => {
    if (!isRecord(payload)) {
      throw new Error("Invalid thread delete command envelope.");
    }
    const expectedHistoryRevision = payload.expectedHistoryRevision;
    if (!Number.isInteger(expectedHistoryRevision) || (expectedHistoryRevision as number) < 0) {
      throw new Error("Expected history revision is required.");
    }
    const request = {
      principalId: readRequiredString(payload.principalId, "Principal id is required."),
      clientCommandId: readRequiredString(payload.clientCommandId, "Client command id is required."),
      threadId: readRequiredString(payload.threadId, "Thread id is required."),
      expectedHistoryRevision: expectedHistoryRevision as number,
    };
    return executeThreadDeleteCommand(request);
  });

  registerDesktopCommand(IPC_CHANNELS.threadRegenerateTitle, async (payload: unknown) => {
    const threadId = typeof payload === "string" ? payload.trim() : "";
    if (!threadId) {
      throw new Error("Thread id is required.");
    }
    const thread = conversationStore.getThread(threadId);
    if (!thread) {
      throw new Error("Thread not found.");
    }
    if (coreOwnsSessionTitle(thread.coreKind)) {
      return { ok: true as const, regenerated: false };
    }
    const regenerated = scheduleThreadTitleSummary(threadId);
    return { ok: true as const, regenerated };
  });

  registerDesktopCommand(IPC_CHANNELS.threadUpdateRuntimeConfig, async (payload: unknown) => {
    const request = parseThreadUpdateRuntimeConfigRequest(payload);
    return executeRuntimeConfigMutationCommand(
      {
        principalId: request.principalId,
        clientCommandId: request.clientCommandId,
        conversationId: request.threadId,
        expectedHistoryRevision: request.expectedHistoryRevision,
        request: { runtimeConfig: request.runtimeConfig },
      },
      {
        v2: conversationStore.conversationV2(),
        errorMessage,
        execute: async () => {
          const thread = conversationStore.getThread(request.threadId);
          if (!thread) {
            throw new Error("Thread was not found.");
          }
          const threadId = request.threadId;
          const incoming = request.runtimeConfig;
          const existing = ensureThreadRuntimeConfig(thread).runtimeConfig;
          const settings = getModelSettingsSnapshot();
          let runtimeConfig = incoming;
          if (thread.status === "running" || thread.status === "queued") {
            const busy = resolveBusyThreadRuntimeConfigUpdate({
              existing,
              incoming,
            });
            if (busy.kind === "blocked") {
              throw new Error("请等待当前运行结束后再修改配置。");
            }
            runtimeConfig = busy.runtimeConfig;
          } else if (thread.coreKind === "acp") {
            runtimeConfig = normalizeThreadRuntimeConfig(incoming);
          } else if (
            existing &&
            isBusyMutableOnlyRuntimeConfigUpdate(existing, incoming) &&
            existing.resolvedOrchestrationSnapshot
          ) {
            // Only mid-run-safe fields changed (bash review + auxiliary / approval / vision
            // role selections): keep the locked session snapshot, patch those fields.
            runtimeConfig = applyBusyMutableRuntimeConfigFields(existing, incoming);
          } else {
            runtimeConfig = materializeThreadRuntimeConfig(settings, incoming);
          }
          if (thread.coreKind === "codex") {
            await assertCodexSkillsConfigReloadAllowed(
              threadId,
              existing?.skillsEnabled,
              runtimeConfig.skillsEnabled,
            );
          }
          if (thread.coreKind === "pi") {
            assertPiSkillsConfigReloadAllowed(
              thread.status,
              existing?.skillsEnabled,
              runtimeConfig.skillsEnabled,
            );
          }
          if (thread.coreKind === "acp") {
            conversationStore.saveThreadRuntimeConfig(threadId, runtimeConfig);
            const updatedThread = ensureThreadRuntimeConfig(conversationStore.getThread(threadId) ?? thread);
            const configChanged =
              !existing ||
              JSON.stringify(normalizeThreadRuntimeConfig(existing)) !==
                JSON.stringify(normalizeThreadRuntimeConfig(runtimeConfig));
            if (configChanged) {
              emitThreadEvent(threadId, "thread.runtime_config_updated", "", "system", false, {
                runtimeConfig,
              });
            }
            if (didSwitchToAllowAllBashReviewMode(existing?.bashReviewMode, runtimeConfig.bashReviewMode)) {
              flushPendingBashApprovalsForAllowAllSwitch(threadId);
            }
            return { thread: updatedThread };
          }
          const roleRoutes = roleRoutesForThreadConfig(settings, runtimeConfig);
          const configChanged =
            !existing ||
            JSON.stringify(normalizeThreadRuntimeConfig(existing)) !==
              JSON.stringify(normalizeThreadRuntimeConfig(runtimeConfig));
          conversationStore.saveThreadRuntimeConfig(threadId, runtimeConfig);
          if (!existing || !isBusyMutableOnlyRuntimeConfigUpdate(existing, runtimeConfig)) {
            noteSdkSessionRouteChange(threadId, roleRoutes);
          }
          const updatedThread = ensureThreadRuntimeConfig(conversationStore.getThread(threadId) ?? thread);
          if (configChanged && existing) {
            const availableMcpServerKeys = listEnabledGlobalMcpServerKeys(mcpStore.listServers());
            const driftKinds = diffPromptCacheRuntimeSignatures(
              resolvePromptCacheRuntimeSignature({
                runtimeConfig: existing,
                settings,
                availableMcpServerKeys,
              }),
              resolvePromptCacheRuntimeSignature({
                runtimeConfig,
                settings,
                availableMcpServerKeys,
              }),
            );
            if (driftKinds.length > 0) {
              const orchestrationLabel = driftKinds.includes("orchestration")
                ? resolvePromptCacheOrchestrationLabel(settings, runtimeConfig)
                : undefined;
              promptCacheRunEventEmitter.emitConfigDrift(threadId, driftKinds, {
                ...(orchestrationLabel && { orchestrationLabel }),
              });
            }
          }
          if (configChanged) {
            emitThreadEvent(threadId, "thread.runtime_config_updated", "", "system", false, {
              runtimeConfig,
            });
          }
          if (didSwitchToAllowAllBashReviewMode(existing?.bashReviewMode, runtimeConfig.bashReviewMode)) {
            flushPendingBashApprovalsForAllowAllSwitch(threadId);
          }
          return { thread: updatedThread };
        },
      },
    );
  });

  registerDesktopCommand(IPC_CHANNELS.threadUserMessageEditGet, async (payload: unknown) => {
    if (!payload || typeof payload !== "object") {
      throw new Error("Invalid user message edit request.");
    }
    const request = payload as Partial<ThreadUserMessageEditGetRequest>;
    const threadId = typeof request.threadId === "string" ? request.threadId.trim() : "";
    const activityLineId = typeof request.activityLineId === "string" ? request.activityLineId.trim() : "";
    if (!threadId || !activityLineId) {
      throw new Error("threadId and activityLineId are required.");
    }
    return getThreadUserMessageEdit(threadId, activityLineId);
  });

  registerDesktopCommand(IPC_CHANNELS.threadForkFromMessage, async (payload: unknown) => {
    const request = parseConversationV2Request(
      payload,
      ["principalId", "clientCommandId", "threadId", "activityLineId", "expectedHistoryRevision"],
      ["principalId", "clientCommandId", "threadId", "activityLineId"],
    ) as Partial<ThreadForkFromMessageRequest>;
    const input: ThreadForkFromMessageRequest = {
      principalId: requiredConversationV2String(request.principalId, "principalId"),
      clientCommandId: requiredConversationV2String(request.clientCommandId, "clientCommandId"),
      threadId: requiredConversationV2String(request.threadId, "threadId"),
      activityLineId: requiredConversationV2String(request.activityLineId, "activityLineId"),
      expectedHistoryRevision: requiredConversationV2Integer(
        request.expectedHistoryRevision,
        "expectedHistoryRevision",
      ),
    };
    requireConversationV2Thread(input.threadId);
    const result = await getConversationForkCommands().execute(input);
    emitThreadEvent(result.thread.id, "thread.created", "", "system", false, {
      metadata: { sourceThreadId: result.sourceThreadId },
    });
    return result;
  });

  registerDesktopCommand(IPC_CHANNELS.threadRewriteFromMessage, async (payload: unknown) => {
    if (!payload || typeof payload !== "object") {
      throw new Error("Invalid user message rewrite request.");
    }
    const request = payload as Partial<ThreadRewriteFromMessageRequest>;
    const principalId = typeof request.principalId === "string" ? request.principalId.trim() : "";
    const clientCommandId = typeof request.clientCommandId === "string" ? request.clientCommandId.trim() : "";
    const threadId = typeof request.threadId === "string" ? request.threadId.trim() : "";
    const activityLineId = typeof request.activityLineId === "string" ? request.activityLineId.trim() : "";
    const prompt = typeof request.prompt === "string" ? request.prompt.trim() : "";
    const attachments = parsePromptImageAttachments(request.attachments);
    const expectedHistoryRevision =
      typeof request.expectedHistoryRevision === "number" && Number.isInteger(request.expectedHistoryRevision)
        ? request.expectedHistoryRevision
        : undefined;
    if (
      !principalId ||
      !clientCommandId ||
      !threadId ||
      !activityLineId ||
      expectedHistoryRevision === undefined
    ) {
      throw new Error(
        "principalId, clientCommandId, threadId, activityLineId and expectedHistoryRevision are required.",
      );
    }
    if (!prompt && attachments.length === 0) {
      throw new Error("Message is required.");
    }
    return executeConversationRewriteCommand(
      {
        principalId,
        clientCommandId,
        threadId,
        activityLineId,
        prompt,
        attachments,
        expectedHistoryRevision,
        ...(request.runtimeConfig ? { runtimeConfig: request.runtimeConfig } : {}),
      },
      {
        v2: conversationStore.conversationV2(),
        requireConversationV2Thread,
        getThread: (id) => conversationStore.getThread(id),
        ensureThreadRuntimeConfig,
        getThreadUserMessageEdit,
        startThreadContinuation,
        errorMessage,
      },
    );
  });

  registerDesktopCommand(IPC_CHANNELS.threadRetryFromMessage, async (payload: unknown) => {
    if (!payload || typeof payload !== "object") {
      throw new Error("Invalid retry request.");
    }
    const request = payload as Partial<ThreadRetryFromMessageRequest>;
    const principalId = typeof request.principalId === "string" ? request.principalId.trim() : "";
    const clientCommandId = typeof request.clientCommandId === "string" ? request.clientCommandId.trim() : "";
    const threadId = typeof request.threadId === "string" ? request.threadId.trim() : "";
    const activityLineId = typeof request.activityLineId === "string" ? request.activityLineId.trim() : "";
    const prompt = typeof request.prompt === "string" ? request.prompt.trim() : "";
    const expectedHistoryRevision =
      typeof request.expectedHistoryRevision === "number" && Number.isInteger(request.expectedHistoryRevision)
        ? request.expectedHistoryRevision
        : undefined;
    if (!principalId || !clientCommandId || !threadId || expectedHistoryRevision === undefined) {
      throw new Error("principalId, clientCommandId, threadId and expectedHistoryRevision are required.");
    }
    return retryThreadFromFailedRequest({
      principalId,
      clientCommandId,
      threadId,
      prompt,
      expectedHistoryRevision,
      hasImages: request.hasImages === true,
      continueInterrupted: request.continueInterrupted === true,
      ...(typeof request.sourceAttemptId === "string" ? { sourceAttemptId: request.sourceAttemptId } : {}),
      ...(activityLineId ? { activityLineId } : {}),
      ...(request.runtimeConfig ? { runtimeConfig: request.runtimeConfig } : {}),
    });
  });

  registerDesktopCommand(IPC_CHANNELS.modelSettingsGet, async () => {
    ensureChatGptSubscriptionProvider();
    return getModelSettingsSnapshot();
  });

  registerDesktopCommand(IPC_CHANNELS.settingsDigest, async () =>
    computeGlobalSettingsDigest({
      modelSettings: getModelSettingsSnapshot(),
      workflowSettings: workflowSettingsStore.get(),
    }),
  );

  registerDesktopCommand(IPC_CHANNELS.modelProviderSave, async (payload: ProviderConfigInput) => {
    const provider = providerStore.saveProvider(payload);
    emitSettingsUpdated();
    return provider;
  });

  registerDesktopCommand(IPC_CHANNELS.modelProviderDelete, async (providerId: unknown) => {
    if (typeof providerId !== "string" || !providerId.trim()) {
      throw new Error("Provider id is required.");
    }
    const trimmedProviderId = providerId.trim();
    if (!providerStore.getProviderWithSecret(trimmedProviderId)) {
      return {
        ok: false as const,
        reason: "not_found" as const,
        references: [],
      };
    }
    const references = collectProviderDeleteReferences(
      trimmedProviderId,
      getModelSettingsSnapshot(),
      conversationStore.listThreads(),
    );
    const { blocking, cascadeMainAgentConfigs, cascadeSubagentOrchestrations } =
      partitionProviderDeleteReferences(references);
    if (blocking.length > 0) {
      return {
        ok: false as const,
        reason: "in_use" as const,
        references: blocking,
      };
    }

    for (const reference of cascadeMainAgentConfigs) {
      workflowSettingsStore.clearDefaultMainAgentConfigReference(reference.id);
      projectOrchestrationSettingsStore.clearMainAgentConfigReference(reference.id);
      agentOrchestrationStore.deleteMainAgentConfig(reference.id);
    }
    for (const reference of cascadeSubagentOrchestrations) {
      workflowSettingsStore.clearDefaultSubagentOrchestrationReference(reference.id);
      projectOrchestrationSettingsStore.clearSubagentOrchestrationReference(reference.id);
      agentOrchestrationStore.deleteSubagentOrchestration(reference.id);
    }

    providerStore.deleteProvider(trimmedProviderId);
    emitSettingsUpdated();
    return { ok: true as const };
  });

  registerDesktopCommand(IPC_CHANNELS.modelProviderListModels, async (payload: ListUpstreamModelsRequest) => {
    if (!payload || typeof payload !== "object") {
      return { ok: false, error: "Invalid models list request." } as const;
    }
    const requestedProvider = payload.providerId
      ? providerStore.getProviderWithSecret(payload.providerId)
      : undefined;
    // Codex Auth (auth.json) has no upstream /v1/models endpoint: its list comes from
    // the codex-rs models-manager catalog, refreshed from the Codex 账号 page.
    if (
      payload.authMethod === "auth_json" ||
      (requestedProvider?.authMethod === "auth_json" && !requestedProvider.hasApiKey)
    ) {
      try {
        const models = await getCodexModelCatalogService().listModels();
        return {
          ok: true,
          models: models.map((model) => ({ id: model.modelId, displayName: model.displayName })),
        } as const;
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          ...(requestedProvider?.id ? { providerId: requestedProvider.id } : {}),
          ...(requestedProvider?.name ? { providerName: requestedProvider.name } : {}),
        } as const;
      }
    }
    if (requestedProvider?.authMethod === "chatgpt_subscription" || payload.authMethod === "chatgpt_subscription") {
      try {
        const models = await getChatGptModelCatalogService().listModels();
        return { ok: true, models: models.map((model) => ({ id: model.modelId, displayName: model.displayName })) } as const;
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) } as const;
      }
    }
    return listProviderUpstreamModels(
      providerStore,
      payload,
      resolveUpstreamUserAgentOverride(proxyBridgeSettingsStore.get()),
      proxyBridgeSettingsStore.get().upstreamProxyUrl,
    );
  });

  registerDesktopCommand(IPC_CHANNELS.modelProviderTest, async (payload: TestProviderConnectionRequest) => {
    if (!payload || typeof payload !== "object") {
      return { ok: false, error: "Invalid provider test request." } as const;
    }
    return testProviderConnection(
      providerStore,
      payload,
      fetch,
      resolveUpstreamUserAgentOverride(proxyBridgeSettingsStore.get()),
      proxyBridgeSettingsStore.get().upstreamProxyUrl,
    );
  });

  registerDesktopCommand(IPC_CHANNELS.chatGptModelCatalogGet, chatGptModelCatalogSnapshot);
  registerDesktopCommand(IPC_CHANNELS.chatGptModelCatalogRefresh, async (accountId?: string) => {
    if (accountId !== undefined && typeof accountId !== "string") throw new Error("Invalid account id.");
    await getChatGptModelCatalogService().refresh(accountId);
    emitSettingsUpdated();
    return chatGptModelCatalogSnapshot();
  });
  registerDesktopCommand(IPC_CHANNELS.chatGptModelCatalogAdd, async (payload: unknown) => {
    if (!payload || typeof payload !== "object") throw new Error("Invalid ChatGPT model add request.");
    const request = payload as AddCodexCatalogModelRequest;
    await getChatGptModelCatalogService().addManualModel(request);
    emitSettingsUpdated();
    return chatGptModelCatalogSnapshot();
  });
  registerDesktopCommand(IPC_CHANNELS.chatGptModelCatalogRemove, async (modelId: unknown) => {
    if (typeof modelId !== "string" || !modelId.trim()) throw new Error("Model id is required.");
    await getChatGptModelCatalogService().removeManualModel(modelId);
    emitSettingsUpdated();
    return chatGptModelCatalogSnapshot();
  });

  registerDesktopCommand(IPC_CHANNELS.chatGptSubscriptionAccountsList, async () => {
    ensureChatGptSubscriptionProvider();
    const service = await getChatGptSubscriptionService();
    return service.listAccounts();
  });

  registerDesktopCommand(
    IPC_CHANNELS.chatGptSubscriptionAccountCreate,
    async (payload: { displayName?: string; proxyUrl?: string }) => {
      ensureChatGptSubscriptionProvider();
      const service = await getChatGptSubscriptionService();
      return service.createAccount(payload?.displayName ?? "ChatGPT 账号", payload?.proxyUrl);
    },
  );

  registerDesktopCommand(
    IPC_CHANNELS.chatGptSubscriptionAccountSetProxy,
    async (payload: { accountId: string; proxyUrl?: string }) => {
      const service = await getChatGptSubscriptionService();
      return service.setProxyUrl(payload.accountId, payload.proxyUrl);
    },
  );

  registerDesktopCommand(
    IPC_CHANNELS.chatGptSubscriptionAccountTest,
    async (payload: { accountId: string; modelId?: string }) => {
      try {
        const service = await getChatGptSubscriptionService();
        return await service.testAccount(payload.accountId, payload.modelId ?? "");
      } catch (error) {
        return { success: false, message: error instanceof Error ? error.message : String(error) };
      }
    },
  );

  registerDesktopCommand(
    IPC_CHANNELS.chatGptSubscriptionAccountDelete,
    async (payload: { accountId: string }) => {
      const service = await getChatGptSubscriptionService();
      await service.deleteAccount(payload.accountId);
      return { success: true };
    },
  );

  registerDesktopCommand(
    IPC_CHANNELS.chatGptSubscriptionAccountSetEnabled,
    async (payload: { accountId: string; enabled: boolean }) => {
      const service = await getChatGptSubscriptionService();
      return service.setEnabled(payload.accountId, payload.enabled);
    },
  );

  registerDesktopCommand(
    IPC_CHANNELS.chatGptSubscriptionAccountResetAvailability,
    async (payload: { accountId: string }) => {
      const service = await getChatGptSubscriptionService();
      return service.resetAvailability(payload.accountId);
    },
  );

  const observeChatGptSubscriptionLogin = (
    login: Awaited<ReturnType<ChatGptSubscriptionService["beginLogin"]>>,
  ): void => {
    void login.result
      .then((account) => {
        BrowserWindow.getAllWindows().forEach((win) => {
          if (!win.isDestroyed()) {
            win.webContents.send("chatgpt-subscription:login-result", { success: true, account });
          }
        });
        emitSettingsUpdated();
      })
      .catch((error) => {
        BrowserWindow.getAllWindows().forEach((win) => {
          if (!win.isDestroyed()) {
            win.webContents.send("chatgpt-subscription:login-result", {
              success: false,
              message: error instanceof Error ? error.message : String(error),
            });
          }
        });
      });
  };

  registerDesktopCommand(
    IPC_CHANNELS.chatGptSubscriptionAccountAuthorizationUrl,
    async (payload: { accountId: string }) => {
      try {
        const service = await getChatGptSubscriptionService();
        // Do not put id_token_hint in a copied URL. The user can select the
        // already logged-in browser account, and the ID token stays out of
        // clipboard/history. The saved client ID still preserves its workspace
        // binding during the code exchange.
        const login = await service.beginLogin(payload.accountId, { includeAccountHints: false });
        observeChatGptSubscriptionLogin(login);
        return {
          success: true,
          message: "授权链接已生成，打开后请完成 ChatGPT 授权。",
          authorizationUrl: login.authorizationUrl,
        };
      } catch (error) {
        return { success: false, message: error instanceof Error ? error.message : String(error) };
      }
    },
  );

  registerDesktopCommand(
    IPC_CHANNELS.chatGptSubscriptionAccountLogin,
    async (payload: { accountId: string }) => {
      const service = await getChatGptSubscriptionService();
      const login = await service.beginLogin(payload.accountId);
      const mainWin = getMainWindow();
      // Keep each ChatGPT account's browser cookies and proxy session isolated.
      // Reusing one Electron partition can silently submit a second account's
      // existing ChatGPT session during OAuth authorization.
      const authPartition = `oauth-chatgpt-${payload.accountId}`;
      const authSession = session.fromPartition(authPartition);
      const account = service.listAccounts().find((entry) => entry.accountId === payload.accountId);
      let closeProxy = () => {};
      let authWindow: BrowserWindow | undefined;
      let loginSettled = false;
      try {
        closeProxy = await configureChatGptOAuthSessionProxy(
          authSession,
          account?.proxyUrl || resolveOutboundProxyUrl(proxyBridgeSettingsStore.get()),
        );
        authWindow = createOAuthAuthWindow(mainWin, authPartition);
        authWindow.webContents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
        const cancelLogin = () => {
          if (loginSettled) return;
          loginSettled = true;
          service.cancelLogin(payload.accountId);
          closeProxy();
          for (const win of BrowserWindow.getAllWindows()) {
            if (!win.isDestroyed()) {
              win.webContents.send("chatgpt-subscription:login-result", {
                success: false,
                message: "ChatGPT 登录已取消",
              });
            }
          }
        };
        authWindow.on("close", cancelLogin);
        authWindow.on("closed", () => {
          cancelLogin();
          closeProxy();
        });
        await authWindow.loadURL(login.authorizationUrl);
      } catch (error) {
        loginSettled = true;
        service.cancelLogin(payload.accountId, error instanceof Error ? error.message : String(error));
        closeProxy();
        if (authWindow && !authWindow.isDestroyed()) authWindow.destroy();
        return {
          success: false,
          message: `打开 ChatGPT 登录页面失败：${error instanceof Error ? error.message : String(error)}`,
        };
      }
      void login.result
        .then((account) => {
          if (loginSettled) return;
          loginSettled = true;
          closeProxy();
          if (authWindow && !authWindow.isDestroyed()) authWindow.close();
          BrowserWindow.getAllWindows().forEach((win) => {
            if (!win.isDestroyed())
              win.webContents.send("chatgpt-subscription:login-result", { success: true, account });
          });
          emitSettingsUpdated();
        })
        .catch((error) => {
          if (loginSettled) return;
          loginSettled = true;
          closeProxy();
          if (authWindow && !authWindow.isDestroyed()) authWindow.close();
          BrowserWindow.getAllWindows().forEach((win) => {
            if (!win.isDestroyed()) {
              win.webContents.send("chatgpt-subscription:login-result", {
                success: false,
                message: error instanceof Error ? error.message : String(error),
              });
            }
          });
        });
      return { success: true, message: "ChatGPT OAuth 登录已在内置窗口打开" };
    },
  );

  // ─── Codex OAuth Login ──────────────────────────────────────────────────────

  registerDesktopCommand(IPC_CHANNELS.codexOAuthGetStatus, async () => {
    const codexHomeDir = resolveCodexHomeDir(app.getPath("userData"));
    const { CodexOAuthLoginService } = await import("./codex-oauth-login");
    const codexExecutable = resolveCodexExecutable();
    if (!codexExecutable) {
      return { isLoggedIn: false, message: "Codex CLI not found" };
    }
    const service = new CodexOAuthLoginService(codexHomeDir, codexExecutable);
    return service.getStatus();
  });

  registerDesktopCommand(
    IPC_CHANNELS.codexOAuthStartLogin,
    async (payload: { upstreamProxyUrl?: string }) => {
      const codexHomeDir = resolveCodexHomeDir(app.getPath("userData"));
      const { CodexOAuthLoginService } = await import("./codex-oauth-login");
      const codexExecutable = resolveCodexExecutable();
      if (!codexExecutable) {
        return { success: false, message: "Codex CLI not found" };
      }

      // Use the proxy URL passed from the form, or fall back to provider settings
      let upstreamProxyUrl = payload?.upstreamProxyUrl?.trim() || undefined;
      process.stderr.write(
        `[codex-oauth] payload.upstreamProxyUrl: ${JSON.stringify(payload?.upstreamProxyUrl)}\n`,
      );
      if (!upstreamProxyUrl) {
        try {
          const providers = providerStore.listProvidersWithSecrets();
          const openaiProvider = providers.find((p) => p.id === "openai");
          upstreamProxyUrl = openaiProvider?.upstreamProxyUrl?.trim() || undefined;
          process.stderr.write(`[codex-oauth] stored provider proxy: ${JSON.stringify(upstreamProxyUrl)}\n`);
        } catch {
          // ignore
        }
      }
      if (!upstreamProxyUrl) {
        upstreamProxyUrl = proxyBridgeSettingsStore.get().upstreamProxyUrl?.trim() || undefined;
        process.stderr.write(`[codex-oauth] global proxy: ${JSON.stringify(upstreamProxyUrl)}\n`);
      }
      process.stderr.write(`[codex-oauth] final upstreamProxyUrl: ${JSON.stringify(upstreamProxyUrl)}\n`);

      const service = new CodexOAuthLoginService(codexHomeDir, codexExecutable, upstreamProxyUrl);
      const authInfo = await service.startLogin();

      if (!authInfo) {
        return { success: false, message: "Failed to start login" };
      }

      // Log for debugging
      process.stderr.write(`[codex-oauth] authUrl: ${authInfo.authUrl}\n`);

      // Create a custom session with proxy for the auth window
      const { session: electronSession } = await import("electron");
      const mainWin = getMainWindow();

      const authSession = electronSession.fromPartition("oauth-auth-session");

      if (upstreamProxyUrl) {
        try {
          const parsed = new URL(upstreamProxyUrl);
          const protocol = parsed.protocol.replace(":", "");

          if (protocol.startsWith("socks")) {
            process.stderr.write(`[codex-oauth] SOCKS5 proxy not supported by Chromium\n`);
          } else {
            const pacContent = `function FindProxyForURL(url, host) {
            return "PROXY ${parsed.host}";
          }`;
            const pacDataUri =
              "data:application/x-ns-proxy-autoconfig;base64," +
              Buffer.from(pacContent, "utf8").toString("base64");
            await authSession.setProxy({
              mode: "pac_script",
              pacScript: pacDataUri,
            });
          }
        } catch (error) {
          process.stderr.write(`[codex-oauth] failed to set proxy: ${error}\n`);
        }
      }

      const authWindow = createOAuthAuthWindow(mainWin);
      let loginCancelled = false;

      const cancelLogin = () => {
        if (loginCancelled) return;
        loginCancelled = true;
        authInfo.cancel();
        process.stderr.write(`[codex-oauth] auth window closed\n`);
        // Notify UI that login was cancelled.
        BrowserWindow.getAllWindows().forEach((win) => {
          if (!win.isDestroyed()) {
            win.webContents.send("codex-oauth:login-result", {
              success: false,
              message: "登录已取消",
            });
          }
        });
      };

      // Register before loadURL: the user can close the native window while the
      // OAuth page is still loading.
      const completionGuard = installCodexAuthCompletionGuard(authWindow, cancelLogin);
      authWindow.on("closed", () => {
        completionGuard.dispose();
        // `destroy()` and application shutdown may skip the `close` event.
        cancelLogin();
      });

      // Prevent WebRTC IP leak (bypasses HTTP proxy)
      authWindow.webContents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
      process.stderr.write(`[codex-oauth] WebRTC IP handling: disable_non_proxied_udp\n`);

      // Load the URL
      process.stderr.write(`[codex-oauth] loading URL: ${authInfo.authUrl}\n`);
      try {
        await authWindow.loadURL(authInfo.authUrl);
      } catch (error) {
        completionGuard.allowClose();
        cancelLogin();
        if (!authWindow.isDestroyed()) authWindow.destroy();
        return {
          success: false,
          message: `打开登录页面失败: ${error instanceof Error ? error.message : String(error)}`,
        };
      }

      // Store the pending login result so we can notify when it completes
      void authInfo.result
        .then((res) => {
          if (loginCancelled) return;
          // Mark the flow as settled before closing so the close listener does not
          // report a successful login as a cancellation.
          loginCancelled = true;
          completionGuard.allowClose();
          if (!authWindow.isDestroyed()) authWindow.close();
          process.stderr.write(`[codex-oauth] login result: ${JSON.stringify(res)}\n`);
          if (res.success) {
            // This flow logs straight into CODEX_HOME/auth.json, which gates the virtual
            // Codex Auth provider/model in the settings snapshot.
            emitSettingsUpdated();
          }
          BrowserWindow.getAllWindows().forEach((win) => {
            if (!win.isDestroyed()) {
              win.webContents.send("codex-oauth:login-result", res);
            }
          });
        })
        .catch((error) => {
          if (loginCancelled) return;
          loginCancelled = true;
          authInfo.cancel();
          completionGuard.allowClose();
          if (!authWindow.isDestroyed()) authWindow.close();
          process.stderr.write(`[codex-oauth] login error: ${error}\n`);
          BrowserWindow.getAllWindows().forEach((win) => {
            if (!win.isDestroyed()) {
              win.webContents.send("codex-oauth:login-result", {
                success: false,
                message: `登录失败: ${error instanceof Error ? error.message : String(error)}`,
              });
            }
          });
        });

      return { success: true, message: "Login started" };
    },
  );

  registerDesktopCommand(IPC_CHANNELS.codexOAuthLogout, async () => {
    const codexHomeDir = resolveCodexHomeDir(app.getPath("userData"));
    const { CodexOAuthLoginService } = await import("./codex-oauth-login");
    const codexExecutable = resolveCodexExecutable();
    if (!codexExecutable) {
      return { success: false, message: "Codex CLI not found" };
    }
    const service = new CodexOAuthLoginService(codexHomeDir, codexExecutable);
    const result = await service.logout();
    // Logout removes CODEX_HOME/auth.json, which gates the virtual Codex Auth
    // provider/model in the settings snapshot.
    emitSettingsUpdated();
    return result;
  });

  // ─── OpenAI Account Management ─────────────────────────────────────────────

  let openaiAccountServicePromise: Promise<OpenAIAccountService> | undefined;
  const resolveSystemProxyResolution = () =>
    session.defaultSession.resolveProxy("https://chatgpt.com");
  const resolveSystemProxyUrl = async () =>
    parseElectronProxyResolution(await resolveSystemProxyResolution());
  setCodexSystemProxyResolver(resolveSystemProxyResolution);
  const getOpenAIAccountService = async () => {
    if (openaiAccountService) return openaiAccountService;
    if (!openaiAccountServicePromise) {
      openaiAccountServicePromise = (async () => {
        const { OpenAIAccountService } = await import("./openai-account-service");
        const service = new OpenAIAccountService(app.getPath("userData"), resolveCodexExecutable, (state) => {
          for (const window of BrowserWindow.getAllWindows()) {
            if (!window.isDestroyed()) window.webContents.send(IPC_CHANNELS.openAIAccountsChanged, state);
          }
        }, ensureCodexControlPlaneClient, resolveSystemProxyUrl);
        await service.initialize();
        openaiAccountService = service;
        return service;
      })().finally(() => {
        openaiAccountServicePromise = undefined;
      });
    }
    return openaiAccountServicePromise;
  };

  openaiAccountAssistant = new OpenAIAccountAssistant({
    getDetails: async (accountId) => (await getOpenAIAccountService()).getAccountDetails(accountId),
    preloadPath: path.join(__dirname, "../preload/index.cjs"),
    parent: getMainWindow,
    text: mainText,
    loadRenderer: async (window, accountId) => {
      const devUrl = process.env.VITE_DEV_SERVER_URL;
      if (devUrl) {
        const url = new URL("codex-account-assistant.html", devUrl);
        url.searchParams.set("accountId", accountId);
        await window.loadURL(url.href);
      } else {
        await window.loadFile(path.join(__dirname, "../renderer/codex-account-assistant.html"), {
          query: { accountId },
        });
      }
    },
  });
  const requireAccountAssistant = () => {
    if (!openaiAccountAssistant) throw new Error(mainText("assistant.notInitialized"));
    return openaiAccountAssistant;
  };
  registerDesktopCommand(IPC_CHANNELS.openAIAccountsOpenAssistant, async (payload: { accountId: string }) => {
    await requireAccountAssistant().open(payload.accountId);
  });
  registerDesktopCommand(
    IPC_CHANNELS.openAIAccountsAssistantState,
    async (payload: { accountId: string }) => {
      return requireAccountAssistant().state(payload.accountId);
    },
  );
  registerDesktopCommand(
    IPC_CHANNELS.openAIAccountsAssistantAction,
    async (payload: { accountId: string; action: OpenAIAccountAssistantAction }) => {
      return requireAccountAssistant().action(payload.accountId, payload.action);
    },
  );

  const scheduleOpenAIAccountTransition = (service: OpenAIAccountService) => {
    requestCodexAccountRuntimeRestart("account");
    scheduleCodexGlobalRuntimeRefresh({
      beforePrepare: async () => {
        try {
          if (service.getPendingAccountId() === undefined) return;
          // Account switching is explicit: publish immediately. Existing login
          // requests may fail authentication; gateway turns keep running.
          await service.flushFinalAuthWriteback();
          await service.applyPendingTransition();
          if (service.getPendingAccountId() === undefined) emitSettingsUpdated();
        } catch (error) {
          service.reportSyncError(error);
          throw error;
        }
      },
    });
  };

  // Register before any composer request can start Codex. The getter itself awaits
  // initialization, so a cold start cannot silently omit the active account proxy.
  setCodexAccountProxyConfigGetter(async () => (await getOpenAIAccountService()).getActiveProxyConfig());
  void getOpenAIAccountService().catch((error) => {
    console.error(
      `[openai-accounts] Initialization failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  });

  registerDesktopCommand(IPC_CHANNELS.openAIAccountsList, async () => {
    const svc = await getOpenAIAccountService();
    return svc.listAccounts();
  });

  registerDesktopCommand(IPC_CHANNELS.openAIAccountsCreate, async (payload: OpenAIAccountCreateInput) => {
    const svc = await getOpenAIAccountService();
    return svc.createAccount(payload);
  });

  registerDesktopCommand(IPC_CHANNELS.openAIAccountsDelete, async (payload: { accountId: string }) => {
    const svc = await getOpenAIAccountService();
    const prevActiveId = await svc.getActiveAccountId();
    const prevPendingAccountId = svc.getPendingAccountId();
    await svc.deleteAccount(payload.accountId);
    if (prevActiveId === payload.accountId) {
      scheduleOpenAIAccountTransition(svc);
    } else if (prevPendingAccountId === payload.accountId) {
      scheduleOpenAIAccountTransition(svc);
    }
    return { success: true, pending: prevActiveId === payload.accountId };
  });

  registerDesktopCommand(IPC_CHANNELS.openAIAccountsSubmitLoginCallback, async (payload: { accountId: string; loginId: string; callbackUrl: string }) => {
    await (await getOpenAIAccountService()).submitLoginCallback(payload.accountId, payload.loginId, payload.callbackUrl);
  });
  registerDesktopCommand(IPC_CHANNELS.openAIAccountsCancelLogin, async (payload: { accountId: string; loginId: string }) => {
    (await getOpenAIAccountService()).cancelLogin(payload.accountId, payload.loginId);
  });

  registerDesktopCommand(IPC_CHANNELS.openAIAccountsStartLogin, async (payload: { accountId: string; mode?: "external" }) => {
    const svc = await getOpenAIAccountService();
    const accounts = await svc.listAccounts();
    const account = accounts.find((a) => a.id === payload.accountId);
    const authInfo = await svc.startLogin(payload.accountId);
    if (!authInfo) {
      return { success: false, message: "Failed to start login" };
    }

    if (payload.mode === "external") {
      void authInfo.result.then(async (result) => {
        if (result.success && payload.accountId === await svc.getActiveAccountId()) scheduleOpenAIAccountTransition(svc);
        return result;
      }).catch((error: unknown) => ({
        success: false, message: `登录结果保存失败：${error instanceof Error ? error.message : String(error)}`,
      })).then((result) => {
        for (const win of BrowserWindow.getAllWindows()) {
          if (!win.isDestroyed()) win.webContents.send("codex-oauth:login-result", {
            ...result, accountId: payload.accountId, loginId: authInfo.loginId,
          });
        }
      });
      return { success: true, message: "授权链接已生成", authUrl: authInfo.authUrl, loginId: authInfo.loginId, expiresAt: authInfo.expiresAt };
    }

    const partition = `openai-account-auth-${payload.accountId}-${Date.now()}`;
    const authSession = session.fromPartition(partition);
    let releaseProxy: () => void;
    try {
      releaseProxy = await configureChatGptOAuthSessionProxy(authSession, account?.proxyUrl);
    } catch (error) {
      authInfo.cancel();
      return {
        success: false,
        message: `登录代理配置失败：${error instanceof Error ? error.message : String(error)}`,
      };
    }
    // Keep the OAuth page independent from the main window so it can move
    // across displays without being constrained by the main window's window group.
    const authWindow = createOAuthAuthWindow(undefined, partition);
    authWindow.setTitle(`Codex 登录 · ${account?.name ?? "账号"}`);
    requireAccountAssistant().attachLogin(payload.accountId, authWindow, authInfo.expiresAt);
    let loginCancelled = false;
    let proxyReleased = false;
    const closeSocksBridge = () => {
      if (proxyReleased) return;
      proxyReleased = true;
      releaseProxy();
    };

    const cancelLogin = () => {
      if (loginCancelled) return;
      loginCancelled = true;
      authInfo.cancel();
      BrowserWindow.getAllWindows().forEach((win) => {
        if (!win.isDestroyed()) {
          win.webContents.send("codex-oauth:login-result", {
            success: false,
            message: "登录已取消",
            accountId: payload.accountId,
          });
        }
      });
    };

    // Register before loadURL so closing while the OAuth page is loading still
    // cancels the CLI process and releases the proxy bridge.
    const completionGuard = installCodexAuthCompletionGuard(authWindow, cancelLogin);
    authWindow.on("closed", () => {
      completionGuard.dispose();
      closeSocksBridge();
      // `destroy()` and application shutdown may skip the `close` event.
      cancelLogin();
    });
    authWindow.webContents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
    try {
      await requireAccountAssistant().open(payload.accountId);
      await authWindow.loadURL(authInfo.authUrl);
    } catch (error) {
      completionGuard.allowClose();
      cancelLogin();
      closeSocksBridge();
      if (!authWindow.isDestroyed()) authWindow.destroy();
      return {
        success: false,
        message: `打开登录页面失败: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    void authInfo.result
      .then(async (res) => {
        if (loginCancelled) return;
        // Settle before closing so the close listener does not turn a completed
        // login into a cancellation notification.
        loginCancelled = true;
        completionGuard.allowClose();
        closeSocksBridge();
        if (!authWindow.isDestroyed()) authWindow.close();
        // `codex login` only writes the account's own CODEX_HOME. When this account is
        // already active, its fresh credentials are staged in SQLite and then applied
        // by the idle transition scheduler without replacing a newer switch request.
        if (res.success && payload.accountId === (await svc.getActiveAccountId())) {
          try {
            scheduleOpenAIAccountTransition(svc);
          } catch (error) {
            console.error(
              `[openai-accounts] Failed to sync fresh auth.json to CODEX_HOME: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
        BrowserWindow.getAllWindows().forEach((win) => {
          if (!win.isDestroyed()) {
            win.webContents.send("codex-oauth:login-result", { ...res, accountId: payload.accountId });
          }
        });
      })
      .catch((error) => {
        if (loginCancelled) return;
        loginCancelled = true;
        authInfo.cancel();
        completionGuard.allowClose();
        closeSocksBridge();
        if (!authWindow.isDestroyed()) authWindow.close();
        console.error(
          `[openai-accounts] Login failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        BrowserWindow.getAllWindows().forEach((win) => {
          if (!win.isDestroyed()) {
            win.webContents.send("codex-oauth:login-result", {
              accountId: payload.accountId,
              success: false,
              message: `登录失败: ${error instanceof Error ? error.message : String(error)}`,
            });
          }
        });
      });

    return { success: true, message: "Login started" };
  });

  registerDesktopCommand(
    IPC_CHANNELS.openAIAccountsSetActive,
    async (payload: { accountId: string | null }) => {
      const svc = await getOpenAIAccountService();
      const prevPendingAccountId = svc.getPendingAccountId();
      await svc.setActiveAccount(payload.accountId);
      const pending = svc.getPendingAccountId() !== undefined;
      if (pending || prevPendingAccountId !== undefined) scheduleOpenAIAccountTransition(svc);
      return { success: true, pending };
    },
  );

  registerDesktopCommand(IPC_CHANNELS.openAIAccountsGetActive, async () => {
    const svc = await getOpenAIAccountService();
    const activeId = await svc.getActiveAccountId();
    const status = await svc.getActiveStatus();
    const pendingAccountId = svc.getPendingAccountId();
    return {
      activeAccountId: activeId,
      ...(pendingAccountId !== undefined ? { pendingAccountId } : {}),
      syncStatus: svc.getSyncStatus(),
      ...status,
    };
  });

  registerDesktopCommand(
    IPC_CHANNELS.openAIAccountsSetAuthJson,
    async (payload: { accountId: string; content: string }) => {
      const svc = await getOpenAIAccountService();
      const result = await svc.setAuthJson(payload.accountId, payload.content);
      if (result.success && svc.getPendingAccountId() !== undefined) {
        scheduleOpenAIAccountTransition(svc);
      }
      return result;
    },
  );

  registerDesktopCommand(IPC_CHANNELS.openAIAccountsQueryQuota, async (payload: { accountId: string }) => {
    const svc = await getOpenAIAccountService();
    const quota = await svc.queryQuota(payload.accountId);
    return quota;
  });

  registerDesktopCommand(IPC_CHANNELS.openAIAccountsResetQuota, async (payload: unknown) => {
    if (!isRecord(payload) || typeof payload.accountId !== "string" || !payload.accountId.trim() ||
      typeof payload.idempotencyKey !== "string" || !/^[0-9a-f-]{36}$/i.test(payload.idempotencyKey)) {
      throw new Error("额度重置参数无效。");
    }
    const { accountId, idempotencyKey } = payload;
    const svc = await getOpenAIAccountService();
    return svc.withActiveAccount(accountId, async () => {
      const client = await ensureCodexControlPlaneClient();
      return consumeCodexQuotaReset(client, idempotencyKey);
    });
  });

  codexImages = new CodexImageService(
    {
      listAccounts: async () => (await getOpenAIAccountService()).listAccounts(),
      getAccountDetails: async (id) => (await getOpenAIAccountService()).getAccountDetails(id),
      saveImageQuota: async (id, authJson, quota) =>
        (await getOpenAIAccountService()).saveImageQuota(id, authJson, quota),
    },
    connectCodexImageAccount,
  );
  app.once("before-quit", () => {
    void disposeCodexImageConnections();
  });

  registerDesktopCommand(
    IPC_CHANNELS.openAIAccountsImageEnabled,
    async (payload: { accountId: string; enabled: boolean }) => {
      if (typeof payload.enabled !== "boolean") throw new Error("生图开关值无效。");
      await (await getOpenAIAccountService()).setImageGenerationEnabled(payload.accountId, payload.enabled);
    },
  );
  registerDesktopCommand(IPC_CHANNELS.openAIAccountsImageQuota, async (payload: { accountId: string }) => {
    return codexImages.queryQuota(payload.accountId);
  });

  registerDesktopCommand(IPC_CHANNELS.openAIAccountsUpdate, async (payload: OpenAIAccountUpdateInput) => {
    const svc = await getOpenAIAccountService();
    const prevAccount = (await svc.listAccounts()).find((a: OpenAIAccount) => a.id === payload.accountId);
    const result = await svc.updateAccount(payload);
    const nextProxyMode = payload.proxyMode ?? (
      payload.proxyUrl !== undefined
        ? payload.proxyUrl.trim() ? "manual" : "system"
        : prevAccount?.proxyMode
    );
    const nextProxyUrl = nextProxyMode === "manual" ? payload.proxyUrl?.trim() ?? "" : "";
    if (
      prevAccount &&
      (
        prevAccount.proxyMode !== nextProxyMode ||
        (prevAccount.proxyUrl?.trim() ?? "") !== nextProxyUrl
      ) &&
      payload.accountId === (await svc.getActiveAccountId())
    ) {
      // Proxy env vars are baked into the app-server at spawn time.
      requestCodexAccountRuntimeRestart("account_proxy");
      scheduleCodexGlobalRuntimeRefresh();
    }
    return result;
  });

  registerDesktopCommand(IPC_CHANNELS.openAIAccountsGetAuthJson, async (payload: { accountId: string }) => {
    const svc = await getOpenAIAccountService();
    const content = await svc.getAuthJsonContent(payload.accountId);
    return content;
  });

  registerDesktopCommand(IPC_CHANNELS.openAIAccountsGetDetails, async (payload: { accountId: string }) => {
    const svc = await getOpenAIAccountService();
    return svc.getAccountDetails(payload.accountId);
  });

  registerDesktopCommand(IPC_CHANNELS.openAIAccountsImport, async (payload: { text: string }) => {
    const svc = await getOpenAIAccountService();
    return svc.importAccounts(payload.text);
  });

  registerDesktopCommand(IPC_CHANNELS.openAIAccountsCancelSwitch, async () => {
    const svc = await getOpenAIAccountService();
    const hadPendingTransition = svc.getPendingAccountId() !== undefined;
    const result = await svc.cancelPendingAccountSwitch();
    if (hadPendingTransition) scheduleOpenAIAccountTransition(svc);
    return result;
  });

  registerDesktopCommand(IPC_CHANNELS.modelRouteProfileTest, async (payload: TestRoleRoutesRequest) => {
    if (!payload || typeof payload !== "object" || !Array.isArray(payload.routes)) {
      return { results: [], passed: 0, failed: 0 };
    }
    return testRoleRoutes(
      providerStore,
      payload,
      fetch,
      resolveUpstreamUserAgentOverride(proxyBridgeSettingsStore.get()),
      proxyBridgeSettingsStore.get().upstreamProxyUrl,
    );
  });

  registerDesktopCommand(IPC_CHANNELS.modelRouteProfileSave, async (payload: RouteProfileInput) => {
    const profile = providerStore.saveRouteProfile(payload);
    emitSettingsUpdated();
    return profile;
  });

  registerDesktopCommand(IPC_CHANNELS.modelRouteProfileDelete, async (profileId: unknown) => {
    if (typeof profileId !== "string" || !profileId.trim()) {
      throw new Error("Route profile id is required.");
    }
    providerStore.deleteRouteProfile(profileId.trim());
    emitSettingsUpdated();
    return { ok: true as const };
  });

  // ─── Candidate Models ─────────────────────────────────────────────────────────

  registerDesktopCommand(IPC_CHANNELS.candidateModelList, async (providerId: unknown) => {
    if (typeof providerId !== "string" || !providerId.trim()) {
      throw new Error("Provider id is required.");
    }
    const trimmedProviderId = providerId.trim();
    // Built-in Codex Auth (auth.json): codex-rs catalog + manual adds. A user-created
    // OpenAI provider that happens to reuse this id keeps its stored candidates.
    if (isBuiltInCodexCatalogProvider(trimmedProviderId)) {
      return codexCatalogCandidateViews(await getCodexModelCatalogService().listModels());
    }
    if (trimmedProviderId === "eco-coding-chatgpt") {
      const timestamps = new Date().toISOString();
      return (await getChatGptModelCatalogService().listModels()).map((model, index) => ({
        modelId: model.modelId,
        displayName: model.displayName,
        createdAt: timestamps,
        updatedAt: timestamps,
        id: `cand-chatgpt-${model.modelId}`,
        providerId: trimmedProviderId,
        sortOrder: index,
        ...(model.apiPricing ? {
          resolvedInputPerM: model.apiPricing.shortContext.input,
          resolvedOutputPerM: model.apiPricing.shortContext.output,
          ...(model.apiPricing.shortContext.cacheRead !== undefined ? { resolvedCacheReadPerM: model.apiPricing.shortContext.cacheRead } : {}),
        } : {}),
      }));
    }
    const candidates = providerStore.listCandidateModels(trimmedProviderId);
    const provider = providerStore.listProviders().find((p) => p.id === trimmedProviderId);
    const baseUrl = provider?.baseUrl ?? "";
    // models.dev enrichment is best-effort; never block listing/adding candidates.
    try {
      return await resolveCandidateModels(pricingCache, candidates, baseUrl);
    } catch (error) {
      process.stderr.write(`[eco] candidate-model:list pricing enrich failed: ${errorMessage(error)}\n`);
      return candidates;
    }
  });

  registerDesktopCommand(IPC_CHANNELS.candidateModelSave, async (payload: unknown) => {
    if (!payload || typeof payload !== "object") {
      throw new Error("Invalid candidate model input.");
    }
    const result = providerStore.saveCandidateModel(payload as CandidateModelInput);
    emitSettingsUpdated();
    return result;
  });

  registerDesktopCommand(IPC_CHANNELS.candidateModelDelete, async (id: unknown) => {
    if (typeof id !== "string" || !id.trim()) {
      throw new Error("Candidate model id is required.");
    }
    providerStore.deleteCandidateModel(id.trim());
    emitSettingsUpdated();
    return { ok: true as const };
  });

  registerDesktopCommand(
    IPC_CHANNELS.candidateModelReorder,
    async (providerId: unknown, orderedIds: unknown) => {
      if (typeof providerId !== "string" || !providerId.trim()) {
        throw new Error("Provider id is required.");
      }
      if (!Array.isArray(orderedIds) || !orderedIds.every((id) => typeof id === "string")) {
        throw new Error("Ordered ids must be a string array.");
      }
      providerStore.reorderCandidateModels(providerId.trim(), orderedIds as string[]);
      emitSettingsUpdated();
      return { ok: true as const };
    },
  );

  registerDesktopCommand(
    IPC_CHANNELS.candidateModelBulkImport,
    async (providerId: unknown, modelIds: unknown) => {
      if (typeof providerId !== "string" || !providerId.trim()) {
        throw new Error("Provider id is required.");
      }
      if (!Array.isArray(modelIds) || !modelIds.every((id) => typeof id === "string")) {
        throw new Error("Model ids must be a string array.");
      }
      const results = providerStore.bulkImportCandidateModels(providerId.trim(), modelIds as string[]);
      emitSettingsUpdated();
      return results;
    },
  );

  // ─── Codex 账号 model catalog (codex-rs models.json) ───────────────────────────

  registerDesktopCommand(IPC_CHANNELS.codexModelCatalogGet, async () => {
    return await codexModelCatalogSnapshot();
  });

  registerDesktopCommand(IPC_CHANNELS.codexModelCatalogRefresh, async () => {
    await getCodexModelCatalogService().refresh();
    emitSettingsUpdated();
    return await codexModelCatalogSnapshot();
  });

  registerDesktopCommand(IPC_CHANNELS.codexModelCatalogAdd, async (payload: unknown) => {
    if (!payload || typeof payload !== "object") {
      throw new Error("Invalid Codex model catalog add request.");
    }
    const request = payload as AddCodexCatalogModelRequest;
    await getCodexModelCatalogService().addManualModel({
      modelId: request.modelId ?? "",
      ...(typeof request.displayName === "string" ? { displayName: request.displayName } : {}),
    });
    emitSettingsUpdated();
    return await codexModelCatalogSnapshot();
  });

  registerDesktopCommand(IPC_CHANNELS.codexModelCatalogRemove, async (modelId: unknown) => {
    if (typeof modelId !== "string" || !modelId.trim()) {
      throw new Error("Model id is required.");
    }
    await getCodexModelCatalogService().removeManualModel(modelId.trim());
    emitSettingsUpdated();
    return await codexModelCatalogSnapshot();
  });

  registerDesktopCommand(
    IPC_CHANNELS.agentTemplateList,
    async () => getModelSettingsSnapshot().agentTemplates,
  );

  registerDesktopCommand(IPC_CHANNELS.agentTemplateSave, async (payload: unknown) => {
    if (!payload || typeof payload !== "object") {
      throw new Error("子代理模板配置不能为空。");
    }
    const template = payload as AgentTemplate;
    if (typeof template.id !== "string") {
      throw new Error("子代理模板 id 不能为空。");
    }
    assertCanWriteAgentTemplateId(template.id);
    const saved = agentOrchestrationStore.saveAgentTemplate(template);
    emitSettingsUpdated();
    return saved;
  });

  registerDesktopCommand(IPC_CHANNELS.agentTemplateDelete, async (templateId: unknown) => {
    if (typeof templateId !== "string" || !templateId.trim()) {
      throw new Error("子代理模板 id 不能为空。");
    }
    assertCanWriteAgentTemplateId(templateId);
    agentOrchestrationStore.deleteAgentTemplate(templateId);
    emitSettingsUpdated();
    return { ok: true as const };
  });

  registerDesktopCommand(IPC_CHANNELS.agentTemplateExport, async (payload?: unknown) => {
    const request = payload && typeof payload === "object" ? (payload as AgentTemplateExportRequest) : {};
    const requestedIds = Array.isArray(request.templateIds)
      ? new Set(request.templateIds.map((id) => id.trim()).filter(Boolean))
      : undefined;
    const templates = getModelSettingsSnapshot().agentTemplates.filter((template) => {
      if (requestedIds) {
        return requestedIds.has(template.id);
      }
      return !template.builtIn && template.source !== "built_in" && template.source !== "derived";
    });
    if (templates.length === 0) {
      throw new Error("没有可导出的子代理模板。");
    }
    const result = await dialog.showSaveDialog({
      title: "导出子代理模板",
      defaultPath: `eco-agent-templates-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (result.canceled || !result.filePath) {
      return { ok: true as const, canceled: true, exported: 0 };
    }
    await fs.writeFile(
      result.filePath,
      JSON.stringify(buildAgentTemplateArchive(templates), null, 2),
      "utf8",
    );
    return {
      ok: true as const,
      canceled: false,
      exported: templates.length,
      path: result.filePath,
    };
  });

  registerDesktopCommand(IPC_CHANNELS.agentTemplateImport, async () => {
    const result = await dialog.showOpenDialog({
      title: "导入子代理模板",
      properties: ["openFile"],
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    const filePath = result.filePaths[0];
    if (result.canceled || !filePath) {
      return {
        ok: true as const,
        canceled: true,
        imported: 0,
        templates: [],
        errors: [],
      };
    }
    const content = await fs.readFile(filePath, "utf8");
    const parsedTemplates = parseAgentTemplateArchive(content);
    const existingIds = new Set(getModelSettingsSnapshot().agentTemplates.map((template) => template.id));
    const imported: AgentTemplate[] = [];
    const errors: string[] = [];
    for (const [index, template] of parsedTemplates.entries()) {
      try {
        const prepared = prepareImportedAgentTemplate(template, existingIds);
        imported.push(agentOrchestrationStore.saveAgentTemplate(prepared));
      } catch (caught) {
        errors.push(`模板 ${index + 1}: ${caught instanceof Error ? caught.message : String(caught)}`);
      }
    }
    if (imported.length > 0) {
      emitSettingsUpdated();
    }
    return {
      ok: true as const,
      canceled: false,
      imported: imported.length,
      templates: imported,
      errors,
    };
  });

  registerDesktopCommand(IPC_CHANNELS.mainAgentConfigSave, async (payload: unknown) => {
    if (!payload || typeof payload !== "object") {
      throw new Error("主 Agent 配置不能为空。");
    }
    const config = payload as MainAgentConfigResource;
    if (typeof config.id !== "string" || !config.id.trim()) {
      throw new Error("主 Agent 配置 id 不能为空。");
    }
    if (config.modelRef) {
      resolveUpstreamApiCompat(
        config.modelRef.apiCompat,
        providerStore.getProviderWithSecret(config.modelRef.providerId)?.apiCompat,
      );
    }
    const saved = agentOrchestrationStore.saveMainAgentConfig(config);
    emitSettingsUpdated();
    return saved;
  });

  registerDesktopCommand(IPC_CHANNELS.mainAgentConfigDelete, async (configId: unknown) => {
    if (typeof configId !== "string" || !configId.trim()) {
      throw new Error("主 Agent 配置 id 不能为空。");
    }
    const trimmed = configId.trim();
    // Match subagent-delete behavior: clear dependents, then remove the resource.
    // Projects that pointed at this config fall back to the global default.
    workflowSettingsStore.clearDefaultMainAgentConfigReference(trimmed);
    projectOrchestrationSettingsStore.clearMainAgentConfigReference(trimmed);
    agentOrchestrationStore.deleteMainAgentConfig(trimmed);
    emitSettingsUpdated();
    return { ok: true as const };
  });

  registerDesktopCommand(IPC_CHANNELS.mainAgentPromptSave, async (payload: unknown) => {
    if (!payload || typeof payload !== "object") {
      throw new Error("主 Agent 提示词不能为空。");
    }
    const prompt = payload as MainAgentPromptResource;
    if (typeof prompt.id !== "string" || !prompt.id.trim()) {
      throw new Error("主 Agent 提示词 id 不能为空。");
    }
    const saved = agentOrchestrationStore.saveMainAgentPrompt(prompt);
    emitSettingsUpdated();
    return saved;
  });

  registerDesktopCommand(IPC_CHANNELS.mainAgentPromptDelete, async (promptId: unknown) => {
    if (typeof promptId !== "string" || !promptId.trim()) {
      throw new Error("主 Agent 提示词 id 不能为空。");
    }
    const trimmed = promptId.trim();
    workflowSettingsStore.clearDefaultMainAgentPromptReference(trimmed);
    projectOrchestrationSettingsStore.clearMainAgentPromptReference(trimmed);
    agentOrchestrationStore.deleteMainAgentPrompt(trimmed);
    emitSettingsUpdated();
    return { ok: true as const };
  });

  registerDesktopCommand(IPC_CHANNELS.subagentOrchestrationSave, async (payload: unknown) => {
    if (!payload || typeof payload !== "object") {
      throw new Error("子代理编排不能为空。");
    }
    const orchestration = payload as SubagentOrchestrationResource;
    if (typeof orchestration.id !== "string" || !orchestration.id.trim()) {
      throw new Error("子代理编排 id 不能为空。");
    }
    for (const agent of orchestration.agents ?? []) {
      resolveUpstreamApiCompat(
        agent.modelRef.apiCompat,
        providerStore.getProviderWithSecret(agent.modelRef.providerId)?.apiCompat,
      );
    }
    const saved = agentOrchestrationStore.saveSubagentOrchestration(orchestration);
    emitSettingsUpdated();
    return saved;
  });

  registerDesktopCommand(IPC_CHANNELS.subagentOrchestrationDelete, async (orchestrationId: unknown) => {
    if (typeof orchestrationId !== "string" || !orchestrationId.trim()) {
      throw new Error("子代理编排 id 不能为空。");
    }
    agentOrchestrationStore.deleteSubagentOrchestration(orchestrationId);
    workflowSettingsStore.clearDefaultSubagentOrchestrationReference(orchestrationId);
    projectOrchestrationSettingsStore.clearSubagentOrchestrationReference(orchestrationId);
    emitSettingsUpdated();
    return { ok: true as const };
  });

  registerDesktopCommand(IPC_CHANNELS.billingModelsDevList, async () => {
    await pricingCatalogReady;
    try {
      return await pricingCache.listModelOptions();
    } catch (error) {
      process.stderr.write(`[eco] billing:models-dev-list failed: ${errorMessage(error)}\n`);
      return [];
    }
  });

  registerDesktopCommand(IPC_CHANNELS.billingRefreshPricing, async () => {
    await pricingCache.refresh();
    return { ok: true as const, cachedAt: pricingCache.getCachedAt() };
  });

  registerDesktopCommand(
    IPC_CHANNELS.billingRoutePricing,
    async (routesOverride?: RuntimeRoleRouteConfig[]) => {
      await pricingCatalogReady;
      return lookupRoutePricingHints(
        pricingCache,
        getModelSettingsSnapshot(),
        providerStore.listProvidersWithSecrets(),
        routesOverride ? resolveCandidateModelDefaults(routesOverride) : routesOverride,
        (route) => lookupUsageBillingPricing(route, {
          inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
        }),
      );
    },
  );

  registerDesktopCommand(
    IPC_CHANNELS.billingRouteCapabilities,
    async (routesOverride?: RuntimeRoleRouteConfig[]) => {
      await pricingCatalogReady;
      return lookupRouteCapabilityHints(
        pricingCache,
        getModelSettingsSnapshot(),
        providerStore.listProvidersWithSecrets(),
        routesOverride ? resolveCandidateModelDefaults(routesOverride) : routesOverride,
      );
    },
  );

  registerDesktopCommand(IPC_CHANNELS.mcpSettingsGet, async () => mcpStore.getSettings());

  registerDesktopCommand(IPC_CHANNELS.mcpServerSave, async (payload: McpServerConfigInput) => {
    const server = mcpStore.saveServer(payload);
    emitSettingsUpdated();
    return server;
  });

  registerDesktopCommand(IPC_CHANNELS.mcpServerCheck, async (payload: McpServerConfigInput) => {
    return checkMcpServerConnection(payload);
  });

  registerDesktopCommand(IPC_CHANNELS.skillsList, async (workspacePath: unknown) => {
    const pathToScan =
      typeof workspacePath === "string" && workspacePath.trim()
        ? workspacePath.trim()
        : currentWorkspace?.path;
    return listDiscoveredSkills(pathToScan);
  });

  registerDesktopCommand(IPC_CHANNELS.cursorAgentsList, async (workspacePath: unknown) => {
    const pathToScan =
      typeof workspacePath === "string" && workspacePath.trim()
        ? workspacePath.trim()
        : currentWorkspace?.path;
    return listDiscoveredCursorAgents(pathToScan);
  });

  registerDesktopCommand(IPC_CHANNELS.skillsLinkAgents, async (payload: unknown) => {
    if (!isLinkAgentsSkillsRequest(payload)) {
      throw new Error("Invalid link agents skills request.");
    }
    const discovered = await listDiscoveredSkills(payload.workspacePath);
    const toLink = discovered.agentsOnlySkills.filter(
      (skill) => !payload.baseDir || skill.baseDir === payload.baseDir,
    );
    const linkResult = await linkAgentsSkillsToClaude(
      toLink,
      payload.baseDir ? { baseDir: payload.baseDir } : undefined,
    );
    return linkResult;
  });

  registerDesktopCommand(IPC_CHANNELS.skillsUninstall, async (payload: unknown) => {
    if (!isSkillUninstallRequest(payload)) {
      throw new Error("Invalid Skill uninstall request.");
    }
    const discovered = await listDiscoveredSkills();
    const requestedDirectory = path.resolve(payload.directory.trim());
    const skill = discovered.userSkills.find(
      (candidate) => path.resolve(candidate.directory) === requestedDirectory,
    );
    if (!skill) {
      throw new Error("Skill is not present in a supported user Skills directory.");
    }
    return uninstallDiscoveredSkill(skill);
  });

  registerDesktopCommand(IPC_CHANNELS.skillsCatalogSearch, async (payload: unknown) => {
    if (!isSkillCatalogSearchRequest(payload)) {
      throw new Error("Invalid Skills catalog search request.");
    }
    return searchSkillsCatalog(payload.query, {
      ...(payload.limit !== undefined ? { limit: payload.limit } : {}),
    });
  });

  registerDesktopCommand(IPC_CHANNELS.skillsCatalogLeaderboard, async (payload: unknown) => {
    if (typeof payload !== "number" || !Number.isInteger(payload)) {
      throw new Error("Invalid Skills catalog leaderboard limit.");
    }
    return listSkillsLeaderboard({ limit: payload });
  });

  registerDesktopCommand(IPC_CHANNELS.skillsCatalogInstall, async (payload: unknown) => {
    if (!isSkillCatalogInstallRequest(payload)) {
      throw new Error("Invalid Skills catalog install request.");
    }
    return installCatalogSkill(payload);
  });

  registerDesktopCommand(IPC_CHANNELS.projectSkillsSettingsGet, async (payload: unknown) => {
    if (typeof payload !== "string" || !payload.trim()) {
      throw new Error("Invalid project Skills settings workspace path.");
    }
    return projectSkillsSettingsStore.get(payload);
  });

  registerDesktopCommand(IPC_CHANNELS.projectSkillsSettingsSave, async (payload: unknown) => {
    if (!isRecord(payload) || typeof payload.workspacePath !== "string" || !isRecord(payload.enabledByPath)) {
      throw new Error("Invalid project Skills settings.");
    }
    return projectSkillsSettingsStore.save({
      workspacePath: payload.workspacePath,
      enabledByPath: Object.fromEntries(
        Object.entries(payload.enabledByPath).filter(
          (entry): entry is [string, boolean] => typeof entry[1] === "boolean",
        ),
      ),
    });
  });

  registerDesktopCommand(IPC_CHANNELS.projectMcpSettingsGet, async (payload: unknown) => {
    if (typeof payload !== "string" || !payload.trim()) {
      throw new Error("Invalid project MCP settings workspace path.");
    }
    return projectMcpSettingsStore.get(payload);
  });

  registerDesktopCommand(IPC_CHANNELS.projectMcpSettingsSave, async (payload: unknown) => {
    if (
      !isRecord(payload) ||
      typeof payload.workspacePath !== "string" ||
      !isRecord(payload.enabledByServer)
    ) {
      throw new Error("Invalid project MCP settings.");
    }
    return projectMcpSettingsStore.save({
      workspacePath: payload.workspacePath,
      enabledByServer: Object.fromEntries(
        Object.entries(payload.enabledByServer).filter(
          (entry): entry is [string, boolean] => typeof entry[1] === "boolean",
        ),
      ),
    });
  });

  registerDesktopCommand(IPC_CHANNELS.projectIntegrationsSettingsGet, async (payload: unknown) => {
    if (typeof payload !== "string" || !payload.trim()) {
      throw new Error("Invalid project integrations settings workspace path.");
    }
    return projectIntegrationsSettingsStore.get(payload);
  });

  registerDesktopCommand(IPC_CHANNELS.projectIntegrationsSettingsSave, async (payload: unknown) => {
    if (!isRecord(payload) || typeof payload.workspacePath !== "string" || !isRecord(payload.enabled)) {
      throw new Error("Invalid project integrations settings.");
    }
    return projectIntegrationsSettingsStore.save({
      workspacePath: payload.workspacePath,
      enabled: Object.fromEntries(
        Object.entries(payload.enabled).filter(
          (entry): entry is [string, boolean] => typeof entry[1] === "boolean",
        ),
      ),
    });
  });

  registerDesktopCommand(IPC_CHANNELS.projectOrchestrationSettingsGet, async (payload: unknown) => {
    if (typeof payload !== "string" || !payload.trim()) {
      throw new Error("Invalid project orchestration settings workspace path.");
    }
    return projectOrchestrationSettingsStore.get(payload);
  });

  registerDesktopCommand(IPC_CHANNELS.projectOrchestrationSettingsSave, async (payload: unknown) => {
    if (
      !isRecord(payload) ||
      typeof payload.workspacePath !== "string" ||
      !isOrchestrationSelection(payload.orchestrationSelection)
    ) {
      throw new Error("Invalid project orchestration settings.");
    }
    return projectOrchestrationSettingsStore.save({
      workspacePath: payload.workspacePath,
      orchestrationSelection: payload.orchestrationSelection,
    });
  });

  registerDesktopCommand(IPC_CHANNELS.workflowSettingsGet, async () => workflowSettingsStore.get());

  registerDesktopCommand(IPC_CHANNELS.workflowSettingsSave, async (payload: unknown) => {
    if (!isWorkflowSettingsSnapshot(payload)) {
      throw new Error("Invalid workflow settings.");
    }
    const previous = workflowSettingsStore.get();
    const normalized = normalizeWorkflowSettingsSnapshot(payload);
    for (const selection of [normalized.defaultAuxiliaryModel, normalized.defaultVisionModel]) {
      if (selection)
        resolveUpstreamApiCompat(
          undefined,
          providerStore.getProviderWithSecret(selection.providerId)?.apiCompat,
        );
    }
    // Legacy acpAgentsEnabled.cursor is no longer a user-facing gate; Cursor ACP
    // is allowed whenever the CLI probe succeeds (checked below for default=acp).
    const gated: typeof normalized = { ...normalized };
    // Older clients omit this device preference when saving other workflow settings.
    if (!("codexAuthModel" in payload) && previous.codexAuthModel) {
      gated.codexAuthModel = previous.codexAuthModel;
    }
    delete gated.acpAgentsEnabled;
    // The Cursor ACP API key is a device-local secret that partial-update callers
    // (e.g. the mobile `workflow-settings:save`) omit. Preserve it unless the payload
    // explicitly sets (a value) or clears (a blank string) it.
    const resolvedCursorKey = resolveAcpCursorApiKeyForSave(payload, previous.acpCursorApiKey);
    if (resolvedCursorKey === undefined) {
      delete gated.acpCursorApiKey;
    } else {
      gated.acpCursorApiKey = resolvedCursorKey;
    }

    if (gated.defaultCoreKind === "acp") {
      const probe = await probeAcpCursorForMain();
      if (!probe.available) {
        throw new Error(acpCursorUnavailableMessage(probe));
      }
      gated.defaultAcpAgentId = gated.defaultAcpAgentId ?? "cursor";
    } else {
      delete gated.defaultAcpAgentId;
    }

    const saved = workflowSettingsStore.save(gated);
    if (saved.contextWindowLimitTokens !== previous.contextWindowLimitTokens) {
      scheduleCodexGlobalRuntimeRefresh();
    }
    if (
      saved.maxOutputLimitTokens !== previous.maxOutputLimitTokens ||
      saved.contextWindowLimitTokens !== previous.contextWindowLimitTokens
    ) {
      void ensureGlobalEcoGateway().catch((error) => {
        process.stderr.write(
          `[eco] eco-gateway refresh after max output change failed: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      });
    }
    emitSettingsUpdated();
    return workflowSettingsStore.get();
  });

  registerDesktopCommand(IPC_CHANNELS.gitSettingsGet, async () => gitSettingsStore.get());

  registerDesktopCommand(IPC_CHANNELS.gitSettingsSave, async (payload: unknown) => {
    if (!isGitSettingsSnapshot(payload)) {
      throw new Error("Invalid git settings.");
    }
    const saved = gitSettingsStore.save(normalizeGitSettingsSnapshot(payload));
    applyGitAutoFetcherSettings();
    return saved;
  });

  registerDesktopCommand(IPC_CHANNELS.personalizationSettingsGet, async () =>
    personalizationSettingsStore.get(),
  );

  registerDesktopCommand(IPC_CHANNELS.personalizationSettingsSave, async (payload: unknown) => {
    if (!isPersonalizationSettingsSnapshot(payload)) {
      throw new Error("Invalid personalization settings.");
    }
    return personalizationSettingsStore.save(normalizePersonalizationSettingsSnapshot(payload));
  });

  registerDesktopCommand(IPC_CHANNELS.browserSettingsGet, async () => browserSettingsStore.get());

  registerDesktopCommand(IPC_CHANNELS.computerUseSettingsGet, async () => computerUseSettingsStore.get());

  registerDesktopCommand(IPC_CHANNELS.computerUseDoctor, async () => {
    const resolved = computerUseGateway.resolveBinary();
    if (!resolved.available || !resolved.binaryPath) {
      return {
        ok: false,
        onboardingLaunched: false,
        reason: resolved.reason ?? "open-computer-use 不可用",
      };
    }
    const {
      probeOpenComputerUsePermissionStatus,
      remediateMacOsComputerUsePermissions,
      openComputerUseUsesMacOsPrivacyGate,
    } = await import("./computer-use-mcp-gateway");
    const probe = await probeOpenComputerUsePermissionStatus(resolved.binaryPath);
    if (probe.ok) {
      return {
        ok: true,
        onboardingLaunched: false,
        ...(probe.output ? { output: probe.output } : {}),
      };
    }
    if (!openComputerUseUsesMacOsPrivacyGate()) {
      return {
        ok: false,
        onboardingLaunched: false,
        reason: probe.reason ?? "电脑操控运行时未就绪",
        ...(probe.output ? { output: probe.output } : {}),
      };
    }
    const remediation = await remediateMacOsComputerUsePermissions(
      resolved.binaryPath,
      resolved.appBundlePath,
      probe.missing,
    );
    return {
      ok: false,
      onboardingLaunched: remediation.onboardingLaunched,
      screenPromptOpened: remediation.screenPromptOpened,
      screenRecordingAppLabel: remediation.screenRecordingAppLabel,
      reason: remediation.reason,
      missing: probe.missing,
      ...(remediation.onboardingError ? { onboardingError: remediation.onboardingError } : {}),
      ...(probe.output ? { output: probe.output } : {}),
    };
  });

  registerDesktopCommand(IPC_CHANNELS.computerUsePermissionStatus, async () => {
    const resolved = computerUseGateway.resolveBinary();
    if (!resolved.available || !resolved.binaryPath) {
      return { ok: false, missing: [] as string[] };
    }
    const { probeOpenComputerUsePermissionStatus } = await import("./computer-use-mcp-gateway");
    const probe = await probeOpenComputerUsePermissionStatus(resolved.binaryPath);
    return { ok: probe.ok, missing: probe.missing };
  });

  registerDesktopCommand(IPC_CHANNELS.integrationAvailabilityGet, async () => {
    return resolveIntegrationAvailability();
  });

  registerDesktopCommand(IPC_CHANNELS.imageGenerationSettingsGet, async () =>
    imageGenerationStore.getSettings(),
  );
  registerDesktopCommand(IPC_CHANNELS.imageGenerationSettingsSave, async (payload: unknown) => {
    if (!isRecord(payload) || typeof payload.enabled !== "boolean") {
      throw new Error("创意绘画设置无效。");
    }
    const saved = imageGenerationStore.setEnabled(payload.enabled);
    return saved;
  });
  registerDesktopCommand(IPC_CHANNELS.imageGenerationProfileSave, async (payload: unknown) => {
    if (!isRecord(payload)) throw new Error("创意绘画 Profile 无效。");
    const saved = imageGenerationStore.saveProfile(payload as unknown as ImageGenerationProfileSaveInput);
    return saved;
  });
  registerDesktopCommand(IPC_CHANNELS.imageGenerationProfileDelete, async (payload: unknown) => {
    if (!isRecord(payload) || typeof payload.id !== "string") throw new Error("创意绘画 Profile ID 无效。");
    const saved = imageGenerationStore.deleteProfile(payload.id);
    return saved;
  });
  registerDesktopCommand(IPC_CHANNELS.imageGenerationProfileActivate, async (payload: unknown) => {
    if (!isRecord(payload) || typeof payload.id !== "string") throw new Error("创意绘画 Profile ID 无效。");
    const saved = imageGenerationStore.activateProfile(payload.id);
    return saved;
  });
  registerDesktopCommand(IPC_CHANNELS.imageGenerationArtifactsList, async (payload: unknown) => {
    if (!isRecord(payload) || typeof payload.threadId !== "string") throw new Error("threadId 无效。");
    return imageGenerationStore.listArtifacts(payload.threadId);
  });
  registerDesktopCommand(IPC_CHANNELS.imageGenerationArtifactRead, async (payload: unknown) => {
    const { image, resolvedPath } = resolveImageGenerationArtifactImage(payload);
    const data = await fs.readFile(resolvedPath);
    if (data.length > 64 * 1024 * 1024) throw new Error("图片文件超过 64 MB 限制。");
    return {
      dataBase64: data.toString("base64"),
      mimeType: image.mimeType,
      path: resolvedPath,
    };
  });
  registerDesktopCommand(IPC_CHANNELS.imageGenerationArtifactReveal, async (payload: unknown) => {
    const { resolvedPath } = resolveImageGenerationArtifactImage(payload);
    shell.showItemInFolder(resolvedPath);
  });
  registerDesktopCommand(IPC_CHANNELS.ttsReadAloudStatus, () => ttsReadAloud.status());
  registerDesktopCommand(IPC_CHANNELS.ttsReadAloudSettingsGet, () => ttsStore.getReadAloudSettings());
  registerDesktopCommand(IPC_CHANNELS.ttsReadAloudSettingsSave, (payload: unknown) => {
    if (!isRecord(payload)) throw new Error("正文朗读配置无效。");
    return ttsStore.saveReadAloudSettings(payload as unknown as import("../shared/tts").ReadAloudSettingsInput);
  });
  registerDesktopCommand(IPC_CHANNELS.ttsReadAloudStart, (payload: unknown) => {
    if (!isRecord(payload) || typeof payload.threadId !== "string" || !conversationStore.getThread(payload.threadId)) throw new Error("朗读会话不存在。");
    return ttsReadAloud.start(payload as unknown as import("../shared/tts").ReadAloudStartInput);
  });
  registerDesktopCommand(IPC_CHANNELS.ttsReadAloudSegment, (payload: unknown) => ttsReadAloud.segment(payload as import("../shared/tts").ReadAloudSegmentInput));
  registerDesktopCommand(IPC_CHANNELS.ttsReadAloudRead, (payload: unknown) => ttsReadAloud.read(payload as import("../shared/tts").ReadAloudReadInput));
  registerDesktopCommand(IPC_CHANNELS.ttsReadAloudCancel, (payload: unknown) => ttsReadAloud.cancel((payload as { requestId: string })?.requestId));
  registerDesktopCommand(IPC_CHANNELS.ttsSettingsGet, async () => ttsStore.getSettings());
  registerDesktopCommand(IPC_CHANNELS.ttsSettingsSave, async (payload: unknown) => {
    if (!isRecord(payload) || typeof payload.enabled !== "boolean") {
      throw new Error("语音生成设置无效。");
    }
    const saved = ttsStore.setEnabled(payload.enabled);
    return saved;
  });
  registerDesktopCommand(IPC_CHANNELS.ttsProfileSave, async (payload: unknown) => {
    if (!isRecord(payload)) throw new Error("语音生成 Profile 无效。");
    const saved = ttsStore.saveProfile(payload as unknown as TtsProfileSaveInput);
    return saved;
  });
  registerDesktopCommand(IPC_CHANNELS.ttsProfileDelete, async (payload: unknown) => {
    if (!isRecord(payload) || typeof payload.id !== "string") throw new Error("语音生成 Profile ID 无效。");
    const saved = ttsStore.deleteProfile(payload.id);
    return saved;
  });
  registerDesktopCommand(IPC_CHANNELS.ttsProfileActivate, async (payload: unknown) => {
    if (!isRecord(payload) || typeof payload.id !== "string") throw new Error("语音生成 Profile ID 无效。");
    const saved = ttsStore.activateProfile(payload.id);
    return saved;
  });
  registerDesktopCommand(IPC_CHANNELS.ttsArtifactsList, async (payload: unknown) => {
    if (!isRecord(payload) || typeof payload.threadId !== "string") throw new Error("threadId 无效。");
    return ttsStore.listArtifacts(payload.threadId);
  });
  registerDesktopCommand(IPC_CHANNELS.ttsArtifactRead, async (payload: unknown) => {
    const { audio, resolvedPath } = await resolveTtsArtifactAudio(payload);
    const data = await fs.readFile(resolvedPath);
    if (data.length > 64 * 1024 * 1024) throw new Error("音频文件超过 64 MB 限制。");
    return {
      dataBase64: data.toString("base64"),
      mimeType: audio.mimeType,
      path: resolvedPath,
    };
  });
  registerDesktopCommand(IPC_CHANNELS.ttsArtifactReveal, async (payload: unknown) => {
    const { resolvedPath } = await resolveTtsArtifactAudio(payload);
    shell.showItemInFolder(resolvedPath);
  });
  registerDesktopCommand(IPC_CHANNELS.imageViewRead, async (payload: unknown) => {
    if (!isRecord(payload) || typeof payload.path !== "string") {
      return { ok: false as const, code: "invalid_path" as const };
    }
    try {
      return {
        ok: true as const,
        ...(await readImageViewFile(payload.path)),
      };
    } catch (error) {
      if (error instanceof ImageViewReadError) {
        return { ok: false as const, code: error.code };
      }
      throw error;
    }
  });

  registerDesktopCommand(IPC_CHANNELS.imageRevealInFolder, async (payload: unknown) => {
    if (!isRecord(payload) || typeof payload.path !== "string" || !payload.path.trim()) {
      throw new Error("Image path is required.");
    }
    const resolvedPath = path.resolve(payload.path.trim());
    let fileStat: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      fileStat = await fs.lstat(resolvedPath);
    } catch {
      throw new Error("Image file not found.");
    }
    if (!fileStat.isFile()) {
      throw new Error("Please choose a file, not a folder.");
    }
    shell.showItemInFolder(resolvedPath);
  });
  registerDesktopCommand(IPC_CHANNELS.imageDisplayArtifactsList, async (payload: unknown) => {
    if (!isRecord(payload) || typeof payload.threadId !== "string") {
      throw new Error("Invalid image display list request.");
    }
    return imageDisplayStore.listArtifacts(payload.threadId);
  });
  registerDesktopCommand(IPC_CHANNELS.htmlHostArtifactsList, async (payload: unknown) => {
    if (!isRecord(payload) || typeof payload.threadId !== "string") {
      throw new Error("Invalid html host list request.");
    }
    return htmlHostStore.list(payload.threadId);
  });
  registerDesktopCommand(IPC_CHANNELS.centerServerHtmlHostingRefresh, async () => {
    return centerServerClient.refreshHtmlHostingCapability({ force: true });
  });
  registerDesktopCommand(IPC_CHANNELS.imageDisplayRead, async (payload: unknown) => {
    if (!isRecord(payload) || typeof payload.artifactId !== "string" || !payload.artifactId.trim()) {
      return { ok: false as const, code: "invalid_artifact" as const };
    }
    const offset = typeof payload.offset === "number" ? payload.offset : undefined;
    const length = typeof payload.length === "number" ? payload.length : undefined;
    try {
      const file = await imageDisplayStore.readArtifactFile(payload.artifactId.trim(), {
        ...(offset !== undefined ? { offset } : {}),
        ...(length !== undefined ? { length } : {}),
      });
      return { ok: true as const, ...file };
    } catch (error) {
      if (error instanceof ImageDisplayError) {
        const code =
          error.code === "not_found"
            ? ("not_found" as const)
            : error.code === "too_large"
              ? ("too_large" as const)
              : error.code === "invalid_artifact"
                ? ("invalid_artifact" as const)
                : ("read_failed" as const);
        return { ok: false as const, code };
      }
      throw error;
    }
  });

  registerDesktopCommand(IPC_CHANNELS.webChatListGet, async () => webChatListStore.get());

  registerDesktopCommand(IPC_CHANNELS.webChatListSave, async (payload: unknown) => {
    if (!isWebChatListSnapshot(payload)) {
      throw new Error("Invalid web chat list.");
    }
    const next = normalizeWebChatListSnapshot(payload);
    const previous = webChatListStore.getSnapshot();
    const items = webChatListStore.get().items;
    for (const proxy of Object.values(next.siteProxies ?? {})) webChatProxyConfig(proxy);
    const applied: string[] = [];
    try {
      for (const item of items) {
        const siteSession = session.fromPartition(webChatSitePartition(item.id));
        const controller = webChatProxyControllers.get(siteSession);
        if (!controller) continue;
        await controller.apply(next.siteProxies?.[item.id]);
        applied.push(item.id);
      }
      return webChatListStore.save(next);
    } catch (error) {
      for (const siteId of applied)
        await webChatProxyControllerFor(siteId).apply(previous.siteProxies?.[siteId]);
      throw error;
    }
  });

  registerDesktopCommand(IPC_CHANNELS.sshBookmarksGet, async () => sshBookmarkStore.list());

  registerDesktopCommand(IPC_CHANNELS.sshBookmarksSave, async (payload: unknown) => {
    if (!isSshBookmarkSaveInput(payload)) {
      throw new Error("Invalid SSH bookmark.");
    }
    return sshBookmarkStore.save(payload);
  });

  registerDesktopCommand(IPC_CHANNELS.sshBookmarksDelete, async (payload: unknown) => {
    if (!isSshBookmarkDeleteRequest(payload)) {
      throw new Error("Invalid SSH bookmark delete request.");
    }
    return sshBookmarkStore.delete(payload.id.trim());
  });

  registerDesktopCommand(IPC_CHANNELS.sshBookmarksGetDefaultKeyPath, async () => {
    const { resolveDefaultSshPrivateKeyPath } = await import("../shared/ssh-bookmarks");
    const resolved = resolveDefaultSshPrivateKeyPath(os.homedir(), existsSync);
    return resolved ?? "";
  });

  registerDesktopCommand(IPC_CHANNELS.sshBookmarksConnect, async (payload: unknown) => {
    if (!isSshBookmarkConnectRequest(payload)) {
      throw new Error("Invalid SSH bookmark connect request.");
    }
    const bookmark = sshBookmarkStore.getPublic(payload.bookmarkId.trim());
    if (!bookmark) {
      throw new Error("SSH bookmark not found.");
    }
    const password = sshBookmarkStore.getPassword(bookmark.id);
    const storedKey = sshBookmarkStore.getStoredKey(bookmark.id);
    const secrets: SshConnectSecrets = {
      ...(password ? { password } : {}),
      ...(storedKey ? { storedKey } : {}),
    };
    return connectSshBookmark(interactiveTerminalManager, {
      workspacePath: payload.workspacePath,
      bookmark,
      secrets,
      userDataDir: app.getPath("userData"),
    });
  });

  registerDesktopCommand(IPC_CHANNELS.browserSettingsSave, async (payload: unknown) => {
    if (!isBrowserSettingsSnapshot(payload)) {
      throw new Error("Invalid browser settings.");
    }
    const next = normalizeBrowserSettingsSnapshot(payload);
    if (next.agentIntegrationEnabled) {
      const ensured = await ensureClaudeUserEcoAgentBrowserSkill();
      if (!ensured.ok) {
        throw new Error(`无法安装内置浏览器 skill：${ensured.reason}`);
      }
      if (!resolveEcoAgentBrowserSkillFileForCodex()) {
        throw new Error("未找到打包的 eco-agent-browser skill 文件。");
      }
      // Persist so isFeatureAvailable sees the capability flag, then check binary only.
      const saved = browserSettingsStore.save(next);
      const feature = requireBrowserHost().isFeatureAvailable();
      if (!feature.available) {
        browserSettingsStore.save({
          agentIntegrationEnabled: false,
          openApprovalMode: next.openApprovalMode,
        });
        throw new Error(`无法启用内置浏览器 Agent 能力：${feature.reason ?? "未知原因"}`);
      }
      return saved;
    }
    await removeClaudeUserEcoAgentBrowserSkill();
    const saved = browserSettingsStore.save(next);
    return saved;
  });

  registerDesktopCommand(IPC_CHANNELS.computerUseSettingsSave, async (payload: unknown) => {
    if (!isComputerUseSettingsSnapshot(payload)) {
      throw new Error("Invalid computer use settings.");
    }
    const next = normalizeComputerUseSettingsSnapshot(payload);
    if (next.agentIntegrationEnabled) {
      const feature = await computerUseGateway.checkFeatureAvailable();
      if (!feature.available) {
        throw new Error(`无法启用电脑操控 Agent 能力：${feature.reason ?? "未知原因"}`);
      }
      const saved = computerUseSettingsStore.save(next);
      return saved;
    }
    const saved = computerUseSettingsStore.save(next);
    return saved;
  });

  registerDesktopCommand(IPC_CHANNELS.notificationSettingsGet, async () => notificationSettingsStore.get());

  registerDesktopCommand(IPC_CHANNELS.notificationSettingsSave, async (payload: unknown) => {
    if (!isNotificationSettingsSnapshot(payload)) {
      throw new Error("Invalid notification settings.");
    }
    return notificationSettingsStore.save(normalizeNotificationSettingsSnapshot(payload));
  });

  registerDesktopCommand(IPC_CHANNELS.browserGetState, async () => requireBrowserHost().getState());

  registerDesktopCommand(IPC_CHANNELS.browserAgentProcessesList, async () =>
    requireBrowserHost().getAgentBrowserProcesses(conversationStore.listThreads().map((thread) => thread.id)),
  );
  registerDesktopCommand(IPC_CHANNELS.browserAgentProcessStop, async (payload: unknown) => {
    const request = payload as { id?: unknown };
    if (typeof request?.id !== "string") throw new Error("无效的浏览器自动化进程 ID。");
    await requireBrowserHost().stopAgentBrowserProcess(request.id);
  });

  registerDesktopCommand(IPC_CHANNELS.browserCaptureSelection, async (payload: unknown) => {
    const request = payload as { browserId?: unknown; kind?: unknown };
    if (typeof request?.browserId !== "string" || !request.browserId.trim() || !["element", "text"].includes(String(request.kind)))
      throw new Error("网页选择需要 browserId 和 element/text 类型。");
    const host = requireBrowserHost();
    const { instance } = host.getSelectionTarget(request.browserId);
    if (instance.threadId !== host.getState().uiScopeId) throw new Error("只能选择当前会话中的网页内容。");
    return browserSelectionService.capture(request.browserId, request.kind as "element" | "text");
  });
  registerDesktopCommand(IPC_CHANNELS.browserCancelSelection, async (payload: unknown) => {
    const id = (payload as { browserId?: unknown })?.browserId;
    if (typeof id !== "string") throw new Error("取消网页选择需要 browserId。");
    browserSelectionService.cancel(id);
  });
  registerDesktopCommand(IPC_CHANNELS.browserReadSelection, async (payload: unknown) => {
    const id = (payload as { id?: unknown })?.id;
    if (typeof id !== "string") throw new Error("读取网页内容引用需要 id。");
    return browserSelectionService.preview(id);
  });
  registerDesktopCommand(IPC_CHANNELS.browserRevealSelection, async (payload: unknown) => {
    const id = (payload as { id?: unknown })?.id;
    if (typeof id !== "string") throw new Error("定位网页内容引用需要 id。");
    const selection = await browserSelectionService.validate(id, true);
    return requireBrowserHost().focusBrowser(selection.browserId, { reveal: true });
  });

  registerDesktopCommand(IPC_CHANNELS.browserDevPrepareAgentCdp, async (payload: unknown) => {
    const { isDevRuntime } = await import("../shared/dev-cdp");
    if (!isDevRuntime()) {
      throw new Error("browserDevPrepareAgentCdp is only available in dev builds.");
    }
    const threadId =
      typeof (payload as { threadId?: string } | null)?.threadId === "string"
        ? (payload as { threadId: string }).threadId.trim()
        : "";
    if (!threadId) {
      throw new Error("browserDevPrepareAgentCdp requires threadId.");
    }
    const cdpPort = await requireBrowserHost().ensureCdpPort(threadId);
    return { cdpPort };
  });

  registerDesktopCommand(IPC_CHANNELS.browserSetVisible, async (payload: unknown) => {
    const request = payload as BrowserSetVisibleRequest;
    if (!request || typeof request.visible !== "boolean") {
      throw new Error("Invalid browser visibility payload.");
    }
    return requireBrowserHost().setVisible(
      request.visible,
      typeof request.browserId === "string" ? request.browserId : undefined,
    );
  });

  registerDesktopCommand(IPC_CHANNELS.browserRegisterGuest, async (payload: unknown) => {
    const request = payload as BrowserRegisterGuestRequest;
    if (
      !request ||
      typeof request.browserId !== "string" ||
      !request.browserId.trim() ||
      typeof request.webContentsId !== "number" ||
      !Number.isFinite(request.webContentsId)
    ) {
      throw new Error("Invalid browser guest registration payload.");
    }
    return requireBrowserHost().registerGuestByWebContentsId(request.browserId.trim(), request.webContentsId);
  });

  registerDesktopCommand(IPC_CHANNELS.browserNavigate, async (payload: unknown) => {
    const request = payload as BrowserNavigateRequest;
    if (!request || typeof request.url !== "string") {
      throw new Error("Invalid browser navigate payload.");
    }
    return requireBrowserHost().openSharedSession({
      url: request.url,
      revealUi: request.reveal !== false,
      ...(typeof request.browserId === "string" ? { browserId: request.browserId } : {}),
      ...(typeof request.threadId === "string" ? { threadId: request.threadId } : {}),
      ...(typeof request.workspacePath === "string" && request.workspacePath.trim()
        ? { workspacePath: request.workspacePath.trim() }
        : {}),
    });
  });

  registerDesktopCommand(IPC_CHANNELS.browserOpen, async (payload: unknown) => {
    const request = (payload && typeof payload === "object" ? payload : {}) as BrowserOpenRequest;
    const url =
      typeof request.url === "string" ? request.url : typeof payload === "string" ? payload : undefined;
    const htmlContent = typeof request.htmlContent === "string" ? request.htmlContent : undefined;
    if (request.webChatSiteId) {
      const siteId = request.webChatSiteId;
      const site = webChatListStore.get().items.find((item) => item.id === siteId);
      if (!site || site.url !== url) throw new Error("无效的聊天站点");
      await webChatProxyControllerFor(siteId).apply(webChatListStore.getSnapshot().siteProxies?.[siteId]);
    }
    return requireBrowserHost().openSharedSession({
      ...(request.webChatSiteId ? { webChatSiteId: request.webChatSiteId } : {}),
      revealUi: request.reveal !== false,
      ...(url && url.trim() && url !== "about:blank" ? { url } : {}),
      ...(htmlContent && htmlContent.trim() ? { htmlContent: htmlContent.trim() } : {}),
      ...(typeof request.browserId === "string" ? { browserId: request.browserId } : {}),
      ...(typeof request.threadId === "string" ? { threadId: request.threadId } : {}),
      ...(request.newBrowser ? { newBrowser: true } : {}),
      ...(typeof request.workspacePath === "string" && request.workspacePath.trim()
        ? { workspacePath: request.workspacePath.trim() }
        : {}),
      ...(request.activate ? { activate: true } : {}),
    });
  });

  registerDesktopCommand(IPC_CHANNELS.browserFocus, async (payload: unknown) => {
    const request = payload as BrowserFocusRequest;
    if (!request || typeof request.browserId !== "string" || !request.browserId.trim()) {
      throw new Error("Invalid browser focus payload.");
    }
    return requireBrowserHost().focusBrowser(request.browserId, {
      reveal: request.reveal !== false,
    });
  });

  registerDesktopCommand(IPC_CHANNELS.browserClose, async (payload: unknown) => {
    const request = payload as BrowserCloseRequest;
    if (!request || typeof request.browserId !== "string" || !request.browserId.trim()) {
      throw new Error("Invalid browser close payload.");
    }
    return requireBrowserHost().closeBrowser(request.browserId);
  });

  registerDesktopCommand(IPC_CHANNELS.browserSetUiScope, async (payload: unknown) => {
    const request = payload as BrowserSetUiScopeRequest;
    if (!request || !("threadId" in request)) {
      throw new Error("Invalid browser ui-scope payload.");
    }
    return requireBrowserHost().setUiScope(
      typeof request.threadId === "string" ? request.threadId : null,
      request.workspacePath,
    );
  });

  registerDesktopCommand(IPC_CHANNELS.browserGoBack, async (payload: unknown) => {
    const browserId =
      payload &&
      typeof payload === "object" &&
      typeof (payload as { browserId?: string }).browserId === "string"
        ? (payload as { browserId: string }).browserId
        : undefined;
    return requireBrowserHost().goBack(browserId);
  });
  registerDesktopCommand(IPC_CHANNELS.browserGoForward, async (payload: unknown) => {
    const browserId =
      payload &&
      typeof payload === "object" &&
      typeof (payload as { browserId?: string }).browserId === "string"
        ? (payload as { browserId: string }).browserId
        : undefined;
    return requireBrowserHost().goForward(browserId);
  });
  registerDesktopCommand(IPC_CHANNELS.browserSetViewport, async (payload: unknown) => {
    const request = payload as { browserId?: unknown };
    if (!request || typeof request.browserId !== "string" || !request.browserId.trim()) {
      throw new Error("Invalid browser viewport payload: browserId is required.");
    }
    return requireBrowserHost().setViewport(request.browserId.trim(), payload);
  });

  registerDesktopCommand(IPC_CHANNELS.browserReload, async (payload: unknown) => {
    const browserId =
      payload &&
      typeof payload === "object" &&
      typeof (payload as { browserId?: string }).browserId === "string"
        ? (payload as { browserId: string }).browserId
        : undefined;
    return requireBrowserHost().reload(browserId);
  });
  registerDesktopCommand(IPC_CHANNELS.browserOpenExternal, async (payload: unknown) => {
    const browserId =
      payload &&
      typeof payload === "object" &&
      typeof (payload as { browserId?: string }).browserId === "string"
        ? (payload as { browserId: string }).browserId
        : undefined;
    await requireBrowserHost().openExternalCurrent(browserId);
    return { ok: true as const };
  });

  registerDesktopCommand(IPC_CHANNELS.browserDownloadAction, async (payload: unknown) => {
    const request = payload as import("../shared/browser-downloads").BrowserDownloadActionRequest;
    if (!request || typeof request.browserId !== "string" || typeof request.fileId !== "string" ||
      !["save", "reveal", "cancel", "remove"].includes(request.action)) throw new Error("Invalid download action.");
    const host = requireBrowserHost();
    if (request.action === "cancel") {
      host.cancelDownloadForUi(request.browserId, request.fileId);
      return { cancelled: false };
    }
    if (request.action === "remove") {
      await host.removeDownloadForUi(request.browserId, request.fileId);
      return { cancelled: false };
    }
    const file = host.getDownloadForUi(request.browserId, request.fileId);
    if (request.action === "reveal") {
      shell.showItemInFolder(file.path);
      return { cancelled: false };
    }
    const chosen = await dialog.showSaveDialog({ defaultPath: path.join(app.getPath("downloads"), file.name) });
    if (chosen.canceled || !chosen.filePath) return { cancelled: true };
    // Revalidate after the native dialog, because closing the tab deletes its temporary files.
    const current = host.getDownloadForUi(request.browserId, request.fileId);
    await fs.copyFile(current.path, chosen.filePath);
    return { cancelled: false };
  });

  registerDesktopCommand(IPC_CHANNELS.asrSettingsGet, async () => asrSettingsStore.get());
  registerDesktopCommand(IPC_CHANNELS.asrSettingsSave, async (payload: unknown) => {
    if (!payload || typeof payload !== "object") throw new Error("Invalid ASR settings.");
    const value = payload as Record<string, unknown>;
    if (
      value.apiMode !== undefined &&
      value.apiMode !== "chat_completions" &&
      value.apiMode !== "audio_transcriptions"
    ) {
      throw new Error("Invalid ASR API mode.");
    }
    const saved = asrSettingsStore.save({
      endpoint: typeof value.endpoint === "string" ? value.endpoint : "",
      ...(value.apiMode ? { apiMode: value.apiMode } : {}),
      model: typeof value.model === "string" ? value.model : "",
      systemPrompt: typeof value.systemPrompt === "string" ? value.systemPrompt : "",
      ...(typeof value.apiKey === "string" ? { apiKey: value.apiKey } : {}),
    });
    return saved;
  });
  registerDesktopCommand(IPC_CHANNELS.asrProfilesList, async () => asrSettingsStore.listProfiles());
  registerDesktopCommand(IPC_CHANNELS.asrProfileSave, async (payload: unknown) => {
    if (!payload || typeof payload !== "object") throw new Error("Invalid ASR profile.");
    const value = payload as Record<string, unknown>;
    if (
      value.apiMode !== undefined &&
      value.apiMode !== "chat_completions" &&
      value.apiMode !== "audio_transcriptions"
    ) {
      throw new Error("Invalid ASR API mode.");
    }
    const saved = asrSettingsStore.saveProfile({
      ...(typeof value.id === "string" ? { id: value.id } : {}),
      name: typeof value.name === "string" ? value.name : "",
      endpoint: typeof value.endpoint === "string" ? value.endpoint : "",
      ...(value.apiMode ? { apiMode: value.apiMode } : {}),
      model: typeof value.model === "string" ? value.model : "",
      systemPrompt: typeof value.systemPrompt === "string" ? value.systemPrompt : "",
      ...(typeof value.apiKey === "string" ? { apiKey: value.apiKey } : {}),
    });
    return saved;
  });
  registerDesktopCommand(IPC_CHANNELS.asrProfileDelete, async (payload: unknown) => {
    if (
      !payload ||
      typeof payload !== "object" ||
      typeof (payload as Record<string, unknown>).id !== "string"
    ) {
      throw new Error("Invalid ASR profile delete request.");
    }
    const saved = asrSettingsStore.deleteProfile((payload as { id: string }).id);
    return saved;
  });
  registerDesktopCommand(IPC_CHANNELS.asrProfileActivate, async (payload: unknown) => {
    if (
      !payload ||
      typeof payload !== "object" ||
      typeof (payload as Record<string, unknown>).id !== "string"
    ) {
      throw new Error("Invalid ASR profile activate request.");
    }
    const saved = asrSettingsStore.activateProfile((payload as { id: string }).id);
    return saved;
  });
  registerDesktopCommand(IPC_CHANNELS.asrInputDeviceSave, async (payload: unknown) => {
    if (!payload || typeof payload !== "object") throw new Error("Invalid ASR input device settings.");
    const inputDeviceId = (payload as Record<string, unknown>).inputDeviceId;
    if (inputDeviceId !== undefined && inputDeviceId !== null && typeof inputDeviceId !== "string") {
      throw new Error("Invalid ASR input device ID.");
    }
    return asrSettingsStore.saveInputDevice(inputDeviceId === undefined ? {} : { inputDeviceId });
  });
  registerDesktopCommand(IPC_CHANNELS.asrSettingsGetStatus, async () => asrSettingsStore.getStatus());
  registerDesktopCommand(IPC_CHANNELS.asrSettingsGetClientConfig, async () => {
    const config = asrSettingsStore.getClientConfig();
    if (!config) throw new Error("ASR 尚未配置 API key。");
    return config;
  });
  registerDesktopCommand(IPC_CHANNELS.asrTranscribe, async (payload: unknown) => {
    const value = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : undefined;
    const audioWavBase64 = typeof value?.audioWavBase64 === "string" ? value.audioWavBase64 : "";
    if (value?.profileId !== undefined && typeof value.profileId !== "string") {
      throw new Error("Invalid ASR profile ID.");
    }
    const profileId = typeof value?.profileId === "string" ? value.profileId : undefined;
    const config = asrSettingsStore.getClientConfig(profileId);
    if (!config) throw new Error("请先在设置中配置 ASR API key。");
    return transcribeAsr(config, { audioWavBase64 });
  });

  registerDesktopCommand(IPC_CHANNELS.storageGetUsage, async () => {
    const userDataDir = app.getPath("userData");
    return buildStorageUsageSnapshot({
      paths: {
        userDataDir,
        databasePath: path.join(userDataDir, "eco-coding.sqlite"),
      },
      threadCount: conversationStore.listThreads().length,
    });
  });

  registerDesktopCommand(IPC_CHANNELS.storageCleanup, async (payload: unknown) => {
    if (!isStorageCleanupRequest(payload)) {
      throw new Error("Invalid storage cleanup request.");
    }
    const userDataDir = app.getPath("userData");
    return runStorageCleanup(
      {
        userDataDir,
        databasePath: path.join(userDataDir, "eco-coding.sqlite"),
        conversationStore,
        deleteThreadWithExternalState: async (threadId) => {
          // A stale thread row can survive after its V2 stream was removed.
          // The normal delete command intentionally requires a V2 head for
          // optimistic concurrency, but cleanup must also be able to remove
          // these unreopenable rows.
          if (!conversationStore.conversationV2().hasConversation(threadId)) {
            const migrator = conversationStore.conversationV2LegacyMigrator();
            if (migrator.hasLegacySourceData(threadId)) {
              // Preserve V1 data until it has either been migrated or
              // explicitly reported as invalid. A missing V2 row alone is
              // never sufficient evidence that the conversation is safe to
              // delete.
              migrator.migrate(threadId);
              const head = conversationStore.conversationV2().head(threadId);
              await executeThreadDeleteCommand({
                principalId: "desktop-storage-cleanup",
                clientCommandId: `thread_delete_${stableHash({
                  threadId,
                  expectedHistoryRevision: head.historyRevision,
                })}`,
                threadId,
                expectedHistoryRevision: head.historyRevision,
              });
              return;
            }
            await cleanupThreadExternalState(threadId);
            conversationStore.deleteThread(threadId);
            return;
          }
          const head = conversationStore.conversationV2().head(threadId);
          await executeThreadDeleteCommand({
            principalId: "desktop-storage-cleanup",
            clientCommandId: `thread_delete_${stableHash({
              threadId,
              expectedHistoryRevision: head.historyRevision,
            })}`,
            threadId,
            expectedHistoryRevision: head.historyRevision,
          });
        },
        hasActiveThreadRuns: () =>
          conversationStore
            .listThreads()
            .some((thread) => thread.status === "running" || thread.status === "queued"),
      },
      payload,
    );
  });

  registerDesktopCommand(IPC_CHANNELS.gitGetStatus, async (workspacePath: unknown) => {
    if (typeof workspacePath !== "string" || !workspacePath.trim()) {
      throw new Error("Workspace path is required.");
    }
    const summary = workspaceReviewService.getSummary(workspacePath.trim());
    const [status] = await Promise.all([
      getGitWorkingTreeStatus(workspacePath.trim(), runGitCommand, { readSummary: () => summary }),
      summary,
    ]);
    return status;
  });

  registerDesktopCommand(
    IPC_CHANNELS.gitGetWorkspaceDiff,
    async (workspacePath: unknown, options: unknown) => {
      if (typeof workspacePath !== "string" || !workspacePath.trim()) {
        throw new Error("Workspace path is required.");
      }
      const refresh =
        !!options && typeof options === "object" && (options as { refresh?: unknown }).refresh === true;
      return workspaceReviewService.getSummary(workspacePath.trim(), refresh);
    },
  );

  registerDesktopCommand(IPC_CHANNELS.gitGetWorkspaceFileDiff, async (payload: unknown) => {
    if (!payload || typeof payload !== "object") {
      throw new Error("Invalid git workspace file diff request.");
    }
    const record = payload as Record<string, unknown>;
    if (typeof record.workspacePath !== "string" || !record.workspacePath.trim()) {
      throw new Error("Workspace path is required.");
    }
    if (typeof record.path !== "string" || !record.path.trim()) {
      throw new Error("File path is required.");
    }
    return workspaceReviewService.getFile(record.workspacePath.trim(), record.path);
  });

  registerDesktopCommand(IPC_CHANNELS.gitDiscardWorkspaceChanges, async (payload: unknown) => {
    if (!payload || typeof payload !== "object") {
      throw new Error("Invalid git discard workspace changes request.");
    }
    const record = payload as Record<string, unknown>;
    if (typeof record.workspacePath !== "string" || !record.workspacePath.trim()) {
      throw new Error("Invalid git discard workspace changes request.");
    }
    const filePath = typeof record.path === "string" ? record.path.trim() : undefined;
    const result = await discardWorkspaceChanges(
      record.workspacePath.trim(),
      filePath ? { path: filePath } : {},
      runGitCommand,
    );
    scheduleWorkspaceGitStatusPublish(record.workspacePath);
    return result;
  });

  registerDesktopCommand(IPC_CHANNELS.gitListCommits, async (payload: unknown) => {
    if (!isGitListCommitsRequest(payload)) {
      throw new Error("Invalid git list commits request.");
    }
    return listGitCommits(
      payload.workspacePath.trim(),
      { skip: payload.skip, limit: payload.limit },
      runGitCommand,
    );
  });

  registerDesktopCommand(IPC_CHANNELS.gitCheckoutBranch, async (payload: unknown) => {
    if (!payload || typeof payload !== "object") {
      throw new Error("Invalid git checkout request.");
    }
    const record = payload as Record<string, unknown>;
    if (typeof record.workspacePath !== "string" || typeof record.branch !== "string") {
      throw new Error("Invalid git checkout request.");
    }
    await checkoutGitBranch(record.workspacePath, record.branch, runGitCommand);
    scheduleWorkspaceGitStatusPublish(record.workspacePath);
    return getGitWorkingTreeStatus(record.workspacePath, runGitCommand);
  });

  registerDesktopCommand(IPC_CHANNELS.gitCreateBranch, async (payload: unknown) => {
    if (!payload || typeof payload !== "object") {
      throw new Error("Invalid git create branch request.");
    }
    const record = payload as Record<string, unknown>;
    if (typeof record.workspacePath !== "string" || typeof record.branch !== "string") {
      throw new Error("Invalid git create branch request.");
    }
    await createGitBranch(record.workspacePath, record.branch, runGitCommand);
    scheduleWorkspaceGitStatusPublish(record.workspacePath);
    return getGitWorkingTreeStatus(record.workspacePath, runGitCommand);
  });

  registerDesktopCommand(IPC_CHANNELS.gitGenerateCommitMessage, async (payload: unknown) => {
    if (!isGitGenerateCommitMessageRequest(payload)) {
      throw new Error("Invalid git generate commit message request.");
    }
    const requestId = payload.requestId?.trim();
    return handleGitGenerateCommitMessage(payload, {
      providerStore,
      agentOrchestrationStore,
      gitSettingsStore,
      pricingCache,
      run: runGitCommand,
      ...(requestId && {
        onCommitMessageDelta: (text) => {
          broadcastGitCommitMessageDelta(requestId, text);
        },
      }),
    });
  });

  registerDesktopCommand(IPC_CHANNELS.gitListCommitModelOptions, async (payload: unknown) => {
    return handleGitListCommitModelOptions(parseGitListCommitModelOptionsRequest(payload), {
      providerStore,
      agentOrchestrationStore,
      gitSettingsStore,
      pricingCache,
    });
  });

  registerDesktopCommand(IPC_CHANNELS.approvalListModelOptions, async (payload: unknown) => {
    return handleGitListCommitModelOptions(
      parseGitListCommitModelOptionsRequest(payload),
      {
        providerStore,
        agentOrchestrationStore,
        gitSettingsStore,
        pricingCache,
      },
      "approval",
    );
  });

  registerDesktopCommand(IPC_CHANNELS.gitSaveCommitModelPreference, async (payload: unknown) => {
    return handleGitSaveCommitModelPreference(parseGitSaveCommitModelPreferenceRequest(payload), {
      providerStore,
      gitSettingsStore,
      workflowSettingsStore,
    });
  });

  registerDesktopCommand(IPC_CHANNELS.gitCommit, async (payload: unknown) => {
    if (!isGitCommitRequest(payload)) {
      throw new Error("Invalid git commit request.");
    }
    const result = await handleGitCommit(payload, {
      providerStore,
      agentOrchestrationStore,
      gitSettingsStore,
      pricingCache,
      run: runGitCommand,
    });
    if (currentWorkspace?.path === payload.workspacePath.trim()) {
      currentWorkspace = await inspectWorkspace(payload.workspacePath.trim());
      syncGitAutoFetcherWorkspace();
    }
    scheduleWorkspaceGitStatusPublish(payload.workspacePath);
    return result;
  });

  registerDesktopCommand(IPC_CHANNELS.gitPush, async (payload: unknown) => {
    if (!isGitPushRequest(payload)) {
      throw new Error("Invalid git push request.");
    }
    const result = await handleGitPush(payload, runGitCommand);
    scheduleWorkspaceGitStatusPublish(payload.workspacePath);
    return result;
  });

  registerDesktopCommand(IPC_CHANNELS.gitPull, async (payload: unknown) => {
    if (!isGitPullRequest(payload)) {
      throw new Error("Invalid git pull request.");
    }
    const result = await handleGitPull(payload, runGitCommand);
    if (currentWorkspace?.path === payload.workspacePath.trim()) {
      currentWorkspace = await inspectWorkspace(payload.workspacePath.trim());
      syncGitAutoFetcherWorkspace();
    }
    scheduleWorkspaceGitStatusPublish(payload.workspacePath);
    return result;
  });

  registerDesktopCommand(IPC_CHANNELS.gitFetch, async (payload: unknown) => {
    if (!isGitFetchRequest(payload) || !payload.workspacePath.trim()) {
      throw new Error("Invalid git fetch request.");
    }
    const workspacePath = payload.workspacePath.trim();
    const result = await fetchFromOrigin(workspacePath, runGitCommand);
    if (!result.ok) {
      throw new Error(result.output || "抓取远程更新失败。");
    }
    desktopEventCenter.publishGitRemoteFetched(workspacePath);
    return { output: result.output };
  });

  registerDesktopCommand(IPC_CHANNELS.proxyBridgeSettingsGet, async () => proxyBridgeSettingsStore.get());

  registerDesktopCommand(IPC_CHANNELS.proxyBridgeSettingsSave, async (payload: unknown) => {
    if (!isProxyBridgeSettingsSnapshot(payload)) {
      throw new Error("Invalid proxy bridge settings.");
    }
    const saved = proxyBridgeSettingsStore.save(normalizeProxyBridgeSettingsSnapshot(payload));
    // Hot-apply to running gateway/bridge.
    try {
      await ensureGlobalEcoGateway();
    } catch {
      // Gateway may not be up yet; settings apply on next ensure.
    }
    return saved;
  });

  registerDesktopCommand(IPC_CHANNELS.integratedWebSearchSettingsGet, async () =>
    integratedWebSearchSettingsStore.get(),
  );

  registerDesktopCommand(IPC_CHANNELS.integratedWebSearchSettingsSave, async (payload: unknown) => {
    if (!isIntegratedWebSearchSettingsSaveInput(payload)) {
      throw new Error("Invalid integrated web search settings.");
    }
    return integratedWebSearchSettingsStore.save(payload);
  });

  registerDesktopCommand(IPC_CHANNELS.integratedWebSearchTest, async (payload: unknown) =>
    testIntegratedWebSearch(payload, integratedWebSearchSettingsStore),
  );

  registerDesktopCommand(IPC_CHANNELS.worktreeGetStatus, async (threadId: unknown) => {
    if (typeof threadId !== "string" || !threadId.trim()) {
      throw new Error("Thread id is required.");
    }
    return getWorkspaceChangeStatus(threadId);
  });

  registerDesktopCommand(IPC_CHANNELS.worktreeApply, async (threadId: unknown) => {
    if (typeof threadId !== "string" || !threadId.trim()) {
      throw new Error("Thread id is required.");
    }
    return {
      ok: true,
      files: [],
      message: "变更已在项目目录中，无需合并。",
    } satisfies WorktreeApplyResult;
  });

  registerDesktopCommand(IPC_CHANNELS.mcpServerDelete, async (serverId: unknown) => {
    if (typeof serverId !== "string" || !serverId.trim()) {
      throw new Error("MCP server id is required.");
    }
    mcpStore.deleteServer(serverId);
    emitSettingsUpdated();
    return { ok: true };
  });

  const supabaseDeployment = new SupabaseCloudDeployment({
    loadBundle: () =>
      readSupabaseDeploymentBundle(
        app.isPackaged
          ? path.join(process.resourcesPath, "supabase")
          : path.resolve(app.getAppPath(), "../../supabase"),
        app.getVersion(),
      ),
    onChange: (snapshot) => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) window.webContents.send(IPC_CHANNELS.supabaseDeploymentChanged, snapshot);
      }
    },
  });
  registerDesktopCommand(IPC_CHANNELS.supabaseDeploymentGet, async () => supabaseDeployment.getSnapshot());
  registerDesktopCommand(IPC_CHANNELS.supabaseDeploymentAuthorize, async (token: unknown) =>
    supabaseDeployment.authorize(token),
  );
  registerDesktopCommand(IPC_CHANNELS.supabaseDeploymentForget, async () =>
    supabaseDeployment.forgetAuthorization(),
  );
  registerDesktopCommand(IPC_CHANNELS.supabaseDeploymentInspect, async (ref: unknown) =>
    supabaseDeployment.inspect(ref),
  );
  registerDesktopCommand(IPC_CHANNELS.supabaseDeploymentRun, async (ref: unknown) =>
    supabaseDeployment.deploy(ref),
  );
  registerDesktopCommand(IPC_CHANNELS.supabaseDeploymentConnection, async (ref: unknown) =>
    supabaseDeployment.getConnection(ref),
  );

  registerDesktopCommand(IPC_CHANNELS.centerServerSettingsGet, async () => centerServerClient.getSnapshot());

  registerDesktopCommand(
    IPC_CHANNELS.centerServerSettingsSave,
    async (payload: CenterServerSettingsInput) => {
      const snapshot = await centerServerClient.saveSettings(payload);
      emitSettingsUpdated();
      return snapshot;
    },
  );

  registerDesktopCommand(
    IPC_CHANNELS.centerServerRegisterDesktop,
    async (payload: CenterServerRegisterDesktopRequest) => {
      const result = await centerServerClient.registerDesktop(payload);
      emitSettingsUpdated();
      return result;
    },
  );

  registerDesktopCommand(IPC_CHANNELS.centerServerSignUp, async (payload: CenterServerSignUpRequest) => {
    const result = await centerServerClient.signUpAndRegisterDesktop(payload);
    emitSettingsUpdated();
    return result;
  });

  registerDesktopCommand(IPC_CHANNELS.centerServerSignIn, async (payload: CenterServerSignInRequest) => {
    const result = await centerServerClient.signInAndRegisterDesktop(payload);
    emitSettingsUpdated();
    return result;
  });

  registerDesktopCommand(IPC_CHANNELS.centerServerCreatePairing, async () =>
    centerServerClient.createPairing(),
  );

  registerDesktopCommand(IPC_CHANNELS.centerServerBuildConnectQr, async () =>
    centerServerClient.buildConnectQr(),
  );

  registerDesktopCommand(IPC_CHANNELS.centerServerListBindings, async () =>
    centerServerClient.listBindings(),
  );

  registerDesktopCommand(IPC_CHANNELS.centerServerListPresence, async () =>
    centerServerClient.listPresence(),
  );

  registerDesktopCommand(IPC_CHANNELS.centerServerRevokeBinding, async (bindingId: string) =>
    centerServerClient.revokeBinding(bindingId),
  );

  registerDesktopCommand(IPC_CHANNELS.centerServerConnect, async () => {
    await centerServerClient.start();
    const snapshot = centerServerClient.getSnapshot();
    emitSettingsUpdated();
    return snapshot;
  });

  registerDesktopCommand(IPC_CHANNELS.centerServerDisconnect, async () => {
    centerServerClient.stop();
    const snapshot = centerServerClient.getSnapshot();
    emitSettingsUpdated();
    return snapshot;
  });

  registerDesktopCommand(
    IPC_CHANNELS.centerServerRemoveConnection,
    async (options?: { forceLocal?: boolean }) => {
      const snapshot = await centerServerClient.removeConnection(options);
      emitSettingsUpdated();
      return snapshot;
    },
  );

  registerDesktopCommand(
    IPC_CHANNELS.centerServerTestConnection,
    async (payload: CenterServerTestConnectionRequest) => centerServerClient.testConnection(payload),
  );

  registerDesktopCommand(IPC_CHANNELS.centerServerVaultStatusGet, async () =>
    centerServerClient.getVaultStatus(),
  );

  registerDesktopCommand(
    IPC_CHANNELS.centerServerSyncConfig,
    async (mode?: "pull" | "push" | "reconcile") => {
      const result = await centerServerClient.syncConfig(
        mode === "pull" || mode === "push" || mode === "reconcile" ? mode : "reconcile",
      );
      emitSettingsUpdated();
      return result;
    },
  );

  registerDesktopCommand(
    IPC_CHANNELS.centerServerSyncConfigDomain,
    async (domain: CenterServerSyncDomain, mode: "pull" | "push") => {
      const result = await centerServerClient.syncConfigDomain(domain, mode);
      emitSettingsUpdated();
      return result;
    },
  );

  registerDesktopCommand(IPC_CHANNELS.centerServerGetSyncStatus, async () =>
    centerServerClient.getSyncStatus(),
  );

  registerDesktopCommand(IPC_CHANNELS.centerServerUnlockVaultWithPassword, async (password: string) => {
    if (typeof password !== "string") {
      throw new Error("password is required.");
    }
    const result = await centerServerClient.unlockVaultWithPassword(password);
    emitSettingsUpdated();
    return result;
  });

  registerDesktopCommand(IPC_CHANNELS.centerServerWrapVaultWithPassword, async (password: string) => {
    if (typeof password !== "string") {
      throw new Error("password is required.");
    }
    const result = await centerServerClient.wrapVaultWithPassword(password);
    emitSettingsUpdated();
    return result;
  });

  registerDesktopCommand(IPC_CHANNELS.centerServerRequestVaultClaim, async () =>
    centerServerClient.requestVaultClaim(),
  );

  registerDesktopCommand(IPC_CHANNELS.centerServerListPendingVaultClaims, async () =>
    centerServerClient.listPendingVaultClaims(),
  );

  registerDesktopCommand(IPC_CHANNELS.centerServerApproveVaultClaim, async (claimId: string) => {
    if (typeof claimId !== "string" || !claimId.trim()) {
      throw new Error("claimId is required.");
    }
    return centerServerClient.approveVaultClaim(claimId.trim());
  });

  registerDesktopCommand(IPC_CHANNELS.centerServerSubmitVaultClaimCode, async (code: string) => {
    if (typeof code !== "string") {
      throw new Error("code is required.");
    }
    const result = await centerServerClient.submitVaultClaimCode(code);
    emitSettingsUpdated();
    return result;
  });

  registerDesktopCommand(IPC_CHANNELS.centerServerCancelVaultClaim, async () => {
    await centerServerClient.cancelActiveVaultClaim();
    return centerServerClient.getVaultStatus();
  });

  registerDesktopCommand(IPC_CHANNELS.threadStart, (payload: ThreadStartRequest) => startNewThread(payload));

  registerDesktopCommand(IPC_CHANNELS.clarificationGetPending, async (threadId: unknown) => {
    if (typeof threadId !== "string" || !threadId.trim()) {
      return undefined;
    }
    return getPendingClarificationForThread(threadId);
  });

  registerDesktopCommand(IPC_CHANNELS.clarificationDismiss, async (payload: unknown) => {
    if (!isClarificationDismissPayload(payload)) {
      throw new Error("Invalid clarification dismiss payload.");
    }
    requireConversationV2Thread(payload.threadId);
    // A dismissal is deliberately never forwarded to an async question: upstream treats
    // "no reply" as unanswered, and the synthetic skip text exists only to satisfy the
    // blocking RPC that must return something.
    markCodexAsyncQuestionDismissed(payload.toolUseId);
    const resolution = executeClarificationResolutionCommand(
      {
        principalId: payload.principalId,
        clientCommandId: payload.clientCommandId,
        conversationId: payload.threadId,
        toolUseId: payload.toolUseId,
        resolution: "dismiss",
        expectedHistoryRevision: payload.expectedHistoryRevision,
      },
      {
        v2: conversationStore.conversationV2(),
        getPending: getPendingClarificationByToolUseId,
        buildDismissAnswers: buildIgnoredClarificationAnswers,
        errorMessage,
      },
    );
    releasePendingClarification(payload.toolUseId, resolution.answers);
    // Do not emit a placeholder clarification.answered here — the awaiting AskUserQuestion /
    // Codex handler emits the real summary (with toolUseId) once submitClarification resolves.
    return { ok: true as const };
  });

  registerDesktopCommand(IPC_CHANNELS.clarificationSubmit, async (payload: unknown) => {
    if (!isClarificationSubmitPayload(payload)) {
      throw new Error("Invalid clarification payload.");
    }
    requireConversationV2Thread(payload.threadId);
    const resolution = executeClarificationResolutionCommand(
      {
        principalId: payload.principalId,
        clientCommandId: payload.clientCommandId,
        conversationId: payload.threadId,
        toolUseId: payload.toolUseId,
        resolution: "submit",
        answers: {
          toolUseId: payload.toolUseId,
          selections: payload.selections,
          ...(payload.customInputIndices ? { customInputIndices: payload.customInputIndices } : {}),
        },
        expectedHistoryRevision: payload.expectedHistoryRevision,
      },
      {
        v2: conversationStore.conversationV2(),
        getPending: getPendingClarificationByToolUseId,
        buildDismissAnswers: buildIgnoredClarificationAnswers,
        buildAsyncReplyText: prepareAsyncClarificationReply,
        errorMessage,
      },
    );
    // Real clarification.answered is emitted by the pending-handler awaiter with toolUseId so
    // the feed can anchor the answer next to the AskUserQuestion tool / request. Async
    // questions have no awaiter, so their answer must be delivered to the run here.
    const delivery = await deliverAsyncClarificationAnswers({
      threadId: payload.threadId,
      toolUseId: payload.toolUseId,
      answers: resolution.answers,
      commandIdempotencyKey: payload.clientCommandId,
      principalId: payload.principalId,
      ...(resolution.asyncMessage ? { acceptedMessage: resolution.asyncMessage } : {}),
    });
    // An unconfirmed async delivery keeps the question pending with its answers, so the user
    // can retry (same command id ⇒ same recorded answer) or dismiss it. Everything else —
    // blocking RPC answers, confirmed and queued deliveries — releases it now.
    if (delivery?.state !== "unknown") {
      releasePendingClarification(payload.toolUseId, resolution.answers);
    }
    return { ok: true as const, ...(delivery ? { delivery } : {}) } satisfies ClarificationSubmitResult;
  });

  registerDesktopCommand(IPC_CHANNELS.bashApprovalGetPending, async (threadId: unknown) => {
    if (typeof threadId !== "string" || !threadId.trim()) {
      return undefined;
    }
    return getPendingBashApprovalForThread(threadId);
  });

  registerDesktopCommand(IPC_CHANNELS.bashApprovalResolve, async (payload: unknown) => {
    if (!isBashApprovalResolvePayload(payload)) {
      throw new Error("Invalid Bash approval payload.");
    }
    requireConversationV2Thread(payload.threadId);
    const feedback = payload.feedback?.trim();
    const outcome = executeBashApprovalResolutionCommand(
      {
        principalId: payload.principalId,
        clientCommandId: payload.clientCommandId,
        conversationId: payload.threadId,
        toolUseId: payload.toolUseId,
        decision: payload.decision,
        ...(feedback ? { feedback } : {}),
        expectedHistoryRevision: payload.expectedHistoryRevision,
      },
      {
        v2: conversationStore.conversationV2(),
        getPending: getPendingBashApprovalByToolUseId,
        resolve: resolvePendingBashApproval,
        rememberMcpToolApproval: (target) => mcpStore.rememberToolApproval(target),
        errorMessage,
      },
    );
    if (outcome.alreadyResolved) {
      // Response-loss retry of the same durable command.
      return { ok: true as const, alreadyResolved: true as const };
    }
    if (payload.decision === "approved_remember_mcp_tool") emitSettingsUpdated();
    const threadPatch = buildResolvedBashApprovalThreadPatch(payload.decision);
    patchThreadSummary(outcome.request.threadId, threadPatch);
    desktopEventCenter.publishThreadLiveEvent({
      threadId: outcome.request.threadId,
      type: "bash_approval.resolved",
      message: threadPatch.message,
      role: "tool",
      stream: false,
      bashApproval: outcome.request,
    });
    return { ok: true as const, alreadyResolved: false as const };
  });

  registerDesktopCommand(IPC_CHANNELS.threadGetPendingPlan, async (threadId: unknown) => {
    if (typeof threadId !== "string" || !threadId.trim()) {
      return undefined;
    }
    return buildThreadPendingPlanView(conversationStore.getPendingPlan(threadId));
  });

  registerDesktopCommand(IPC_CHANNELS.threadGetApprovedPlan, async (threadId: unknown) => {
    if (typeof threadId !== "string" || !threadId.trim()) {
      return undefined;
    }
    return buildThreadApprovedPlanView(threadId.trim());
  });

  registerDesktopCommand(IPC_CHANNELS.threadApprovePlan, async (payload: unknown) => {
    const request = parseThreadApprovePlanPayload(payload);
    const { threadId } = request;
    requireConversationV2Thread(threadId);
    return executePlanResolutionCommand(
      {
        principalId: request.principalId,
        clientCommandId: request.clientCommandId,
        conversationId: threadId,
        resolution: "approve",
        expectedHistoryRevision: request.expectedHistoryRevision,
        request: {
          ...(request.runtimeConfig ? { runtimeConfig: request.runtimeConfig } : {}),
          ...(request.executionTarget ? { executionTarget: request.executionTarget } : {}),
        },
      },
      {
        v2: conversationStore.conversationV2(),
        errorMessage,
        freezeContext: () => buildPlanResolutionFrozenContext(threadId),
        execute: async (frozenContext, checkpoint) => {
          assertPlanResolutionContextCurrent(threadId, frozenContext);
          const approvalThread = conversationStore.getThread(threadId);
          if (!approvalThread) {
            throw new Error("Thread was not found.");
          }

          // "指定子代理执行已批准计划": the renderer only sends the choice; the host re-reads
          // the thread, pending plan, and locked orchestration snapshot to validate it.
          const approvalSnapshot = (() => {
            const config = ensureThreadRuntimeConfig(approvalThread).runtimeConfig;
            return config
              ? resolveThreadOrchestrationSnapshot(getModelSettingsSnapshot(), config)
              : undefined;
          })();
          const delegationAgents = listPlanDelegationAgents(approvalSnapshot);
          let forcedTarget: Extract<PlanExecutionTarget, { kind: "subagent" }> | undefined;
          if (request.executionTarget && request.executionTarget.kind === "subagent") {
            const validation = validatePlanExecutionTarget({
              target: request.executionTarget,
              coreKind: approvalThread.coreKind,
              agents: delegationAgents,
            });
            if (!validation.ok) {
              throw new Error(validation.reason);
            }
            forcedTarget = validation.target as Extract<PlanExecutionTarget, { kind: "subagent" }>;
          }
          const forcedContract = forcedTarget
            ? buildForcedPlanDelegationContract({
                agentKey:
                  approvalThread.coreKind === "claude"
                    ? sdkAgentKeyForOrchestrationAgent(forcedTarget.agentKey)
                    : approvalThread.coreKind === "codex"
                      ? sanitizeCodexRoleId(forcedTarget.agentKey)
                      : forcedTarget.agentKey,
              })
            : undefined;

          if (approvalThread.coreKind === "codex") {
            requireThreadCore(approvalThread, "codex", "approve a Codex plan");
            if (getPendingPlanApprovalForThread(threadId)) {
              throw new Error("Codex plan approval cannot use the Claude approval bridge.");
            }
            const pendingPlan = conversationStore.getPendingPlan(threadId);
            if (!pendingPlan) {
              throw new Error("找不到待批准的计划。");
            }
            if (approvalThread.status !== "awaiting_plan") {
              throw new Error("This thread is not waiting for plan approval.");
            }
            if (!pendingPlan.plan.trim()) {
              throw new Error("计划内容不能为空。");
            }
            const currentConfig = ensureThreadRuntimeConfig(approvalThread).runtimeConfig;
            if (!currentConfig) {
              throw new Error("Thread runtime configuration is missing.");
            }
            const runtimeConfig = withAgentSessionMode(
              request.runtimeConfig ? parseThreadRuntimeConfigInput(request.runtimeConfig) : currentConfig,
              "agent",
            );
            const snapshot = await persistApprovedPlanForThread(threadId, pendingPlan);
            checkpoint("plan.snapshot_persisted", approvedPlanCheckpointPayload(snapshot));
            conversationStore.saveThreadRuntimeConfigForPlanCommand(threadId, runtimeConfig, request, {
              coreKind: "codex",
              sessionMode: "agent",
            });
            commitThreadPlanApprovalToAgentMode(threadId, "codex_plan_approved");
            const forcedAttempt = forcedTarget
              ? armForcedPlanDelegation({
                  threadId,
                  coreKind: "codex",
                  target: forcedTarget,
                  plan: pendingPlan.plan,
                })
              : undefined;
            let result: ThreadContinueResult;
            let dispatchWait: Promise<void> | undefined;
            try {
              const runtimeDispatch = prepareConversationCommandDispatch({
                v2: conversationStore.conversationV2(),
                job: {
                  principalId: request.principalId,
                  conversationId: threadId,
                  clientCommandId: request.clientCommandId,
                },
                coreKind: "codex",
                actionKind: "plan_approval",
                phase: "execution",
                checkpointScope: "plan",
              });
              dispatchWait = waitForConversationCommandDispatch({
                v2: conversationStore.conversationV2(),
                conversationId: threadId,
                prepared: runtimeDispatch,
              });
              result = await startCodexThreadContinuation({
                threadId,
                prompt: forcedContract ?? "Implement the plan.",
                runtimeConfigInput: runtimeConfig,
                preparedRuntimeDispatch: runtimeDispatch,
              });
              await dispatchWait;
            } catch (error) {
              void dispatchWait?.catch(() => {});
              if (forcedAttempt) {
                settleForcedPlanDelegation(threadId, {
                  ok: false,
                  reason: errorMessage(error),
                });
              }
              throw error;
            }
            if (!forcedAttempt) {
              conversationStore.clearPendingPlanForCommand(threadId, request);
              emitThreadEvent(threadId, "thread.plan_cleared", "计划已进入执行阶段。", "system");
            }
            return { thread: result.thread };
          }
          if (approvalThread.coreKind === "pi") {
            requireThreadCore(approvalThread, "pi", "approve a PI plan");
            const pendingPlan = conversationStore.getPendingPlan(threadId);
            if (!pendingPlan) {
              throw new Error("找不到待批准的计划。");
            }
            if (approvalThread.status !== "awaiting_plan") {
              throw new Error("This thread is not waiting for plan approval.");
            }
            if (!pendingPlan.plan.trim()) {
              throw new Error("计划内容不能为空。");
            }
            const currentConfig = ensureThreadRuntimeConfig(approvalThread).runtimeConfig;
            if (!currentConfig) {
              throw new Error("Thread runtime configuration is missing.");
            }
            const runtimeConfig = withAgentSessionMode(
              request.runtimeConfig ? parseThreadRuntimeConfigInput(request.runtimeConfig) : currentConfig,
              "agent",
            );
            const snapshot = await persistApprovedPlanForThread(threadId, pendingPlan);
            checkpoint("plan.snapshot_persisted", approvedPlanCheckpointPayload(snapshot));
            conversationStore.saveThreadRuntimeConfigForPlanCommand(threadId, runtimeConfig, request, {
              coreKind: "pi",
              sessionMode: "agent",
            });
            commitThreadPlanApprovalToAgentMode(threadId, "pi_plan_approved");
            // Cancel any leftover Claude-style bridge if present; PI Plan is Codex-style async.
            cancelPlanApprovalsForThreadKeepPending(threadId, "pi plan approved asynchronously");
            const forcedAttempt = forcedTarget
              ? armForcedPlanDelegation({
                  threadId,
                  coreKind: "pi",
                  target: forcedTarget,
                  plan: pendingPlan.plan,
                })
              : undefined;
            let result: ThreadContinueResult;
            let dispatchWait: Promise<void> | undefined;
            try {
              const runtimeDispatch = prepareConversationCommandDispatch({
                v2: conversationStore.conversationV2(),
                job: {
                  principalId: request.principalId,
                  conversationId: threadId,
                  clientCommandId: request.clientCommandId,
                },
                coreKind: "pi",
                actionKind: "plan_approval",
                phase: "execution",
                checkpointScope: "plan",
              });
              dispatchWait = waitForConversationCommandDispatch({
                v2: conversationStore.conversationV2(),
                conversationId: threadId,
                prepared: runtimeDispatch,
              });
              result = await startPiThreadContinuation({
                threadId,
                prompt:
                  forcedContract ??
                  "The user approved the plan. Implement it now with full Agent tools. Follow the approved plan.",
                runtimeConfigInput: runtimeConfig,
                skipRecordUserPrompt: true,
                preparedRuntimeDispatch: runtimeDispatch,
              });
              await dispatchWait;
            } catch (error) {
              void dispatchWait?.catch(() => {});
              if (forcedAttempt) {
                settleForcedPlanDelegation(threadId, {
                  ok: false,
                  reason: errorMessage(error),
                });
              }
              throw error;
            }
            if (!forcedAttempt) {
              conversationStore.clearPendingPlanForCommand(threadId, request);
              emitThreadEvent(threadId, "thread.plan_cleared", "计划已进入执行阶段。", "system");
            }
            return { thread: result.thread };
          }

          const pendingBridge = getPendingPlanApprovalForThread(threadId);
          const approveRoute = resolveThreadApprovePlanRoute(
            definedProps({
              coreKind: approvalThread.coreKind,
              hasPendingBridge: Boolean(pendingBridge),
            }),
          );
          const pendingRuntimeConfig = request.runtimeConfig
            ? parseThreadRuntimeConfigInput(request.runtimeConfig)
            : undefined;
          if (pendingRuntimeConfig) {
            roleRoutesForThreadConfig(getModelSettingsSnapshot(), pendingRuntimeConfig);
          }

          if (approveRoute.kind === "bridge") {
            if (!pendingBridge) {
              throw new Error("No pending plan approval is active for this thread.");
            }
            const bridgeBaseRuntimeConfig =
              pendingRuntimeConfig ?? ensureThreadRuntimeConfig(approvalThread).runtimeConfig;
            if (!bridgeBaseRuntimeConfig) {
              throw new Error("Thread runtime configuration is missing.");
            }
            const pendingPlan = conversationStore.getPendingPlan(threadId);
            const planFilePath = pendingBridge.planFilePath ?? pendingPlan?.planFilePath;
            const snapshot = await persistApprovedPlanForThread(threadId, {
              workspacePath: pendingPlan?.workspacePath ?? approvalThread.workspacePath,
              userPrompt: pendingPlan?.userPrompt ?? pendingBridge.userPrompt,
              analysis: pendingPlan?.analysis ?? pendingBridge.analysis,
              plan: pendingPlan?.plan ?? pendingBridge.plan,
              ...(planFilePath ? { planFilePath } : {}),
            });
            checkpoint("plan.snapshot_persisted", approvedPlanCheckpointPayload(snapshot));
            const bridgeRuntimeConfig = withAgentSessionMode(bridgeBaseRuntimeConfig, "agent");
            conversationStore.saveThreadRuntimeConfigForPlanCommand(threadId, bridgeRuntimeConfig, request, {
              coreKind: approvalThread.coreKind ?? "claude",
              sessionMode: "agent",
            });
            commitThreadPlanApprovalToAgentMode(threadId, "bridge_plan_approved");
            const approvedThread = conversationStore.getThread(threadId);
            if (
              !approvedThread ||
              resolveSessionMode(ensureThreadRuntimeConfig(approvedThread).runtimeConfig) !== "agent"
            ) {
              throw new Error("Plan approval could not switch the thread to Agent mode.");
            }
            const bridgePlanText = pendingPlan?.plan ?? pendingBridge.plan;
            const forcedAttempt = forcedTarget
              ? armForcedPlanDelegation({
                  threadId,
                  coreKind: approvalThread.coreKind ?? "claude",
                  target: forcedTarget,
                  plan: bridgePlanText,
                })
              : undefined;
            if (
              !bindPendingPlanApprovalCommand(pendingBridge.toolUseId, {
                principalId: request.principalId,
                clientCommandId: request.clientCommandId,
              })
            ) {
              if (forcedAttempt) {
                releaseForcedPlanDelegation(threadId);
              }
              throw new Error("No pending plan approval is active for this thread.");
            }
            if (!resolvePendingPlanApproval(pendingBridge.toolUseId, "approved")) {
              clearPlanApprovalCommandBinding(pendingBridge.toolUseId);
              if (forcedAttempt) {
                releaseForcedPlanDelegation(threadId);
              }
              throw new Error("No pending plan approval is active for this thread.");
            }
            checkpoint("plan.bridge_resolved", { toolUseId: pendingBridge.toolUseId, decision: "approved" });
            try {
              await waitForPlanApprovalContinuation(pendingBridge.toolUseId);
            } catch (error) {
              rejectPlanApprovalContinuation(
                pendingBridge.toolUseId,
                error instanceof Error ? error : new Error(errorMessage(error)),
              );
              throw error;
            } finally {
              clearPlanApprovalCommandBinding(pendingBridge.toolUseId);
            }
            if (!forcedAttempt) {
              conversationStore.clearPendingPlanForCommand(threadId, request);
              emitThreadEvent(threadId, "thread.plan_cleared", "计划已批准，当前会话开始执行。", "system");
            }
            updateThread(threadId, {
              status: "running",
              message: "",
            });
            return {
              thread: ensureThreadRuntimeConfig(conversationStore.getThread(threadId) ?? approvedThread),
            };
          }

          if (approveRoute.kind === "acp_continuation") {
            if (approvalThread.coreKind !== "acp") {
              throw new Error(
                `CORE_ROUTE_MISMATCH: Thread ${approvalThread.id} belongs to ${approvalThread.coreKind ?? "unknown"}, not acp; cannot approve an ACP plan.`,
              );
            }
            const pendingPlan = conversationStore.getPendingPlan(threadId);
            if (!pendingPlan) {
              throw new Error(
                "ACP plan approval has no live cursor/create_plan bridge and no stored pending plan.",
              );
            }
            if (approvalThread.status !== "awaiting_plan") {
              throw new Error("This thread is not waiting for plan approval.");
            }
            if (!pendingPlan.plan.trim()) {
              throw new Error("计划内容不能为空。");
            }
            const currentConfig = ensureThreadRuntimeConfig(approvalThread).runtimeConfig;
            if (!currentConfig) {
              throw new Error("Thread runtime configuration is missing.");
            }
            const runtimeConfig = withAgentSessionMode(pendingRuntimeConfig ?? currentConfig, "agent");
            const snapshot = await persistApprovedPlanForThread(threadId, pendingPlan);
            checkpoint("plan.snapshot_persisted", approvedPlanCheckpointPayload(snapshot));
            conversationStore.saveThreadRuntimeConfigForPlanCommand(threadId, runtimeConfig, request, {
              coreKind: "acp",
              sessionMode: "agent",
            });
            commitThreadPlanApprovalToAgentMode(threadId, "acp_plan_approved");
            // Disconnect fallback only: live create_plan bridge is preferred (Cursor blocking contract).
            cancelPlanApprovalsForThreadKeepPending(threadId, "acp plan approved via disconnect fallback");
            const runtimeDispatch = prepareConversationCommandDispatch({
              v2: conversationStore.conversationV2(),
              job: {
                principalId: request.principalId,
                conversationId: threadId,
                clientCommandId: request.clientCommandId,
              },
              coreKind: "acp",
              actionKind: "plan_approval",
              phase: "execution",
              checkpointScope: "plan",
            });
            const dispatched = waitForConversationCommandDispatch({
              v2: conversationStore.conversationV2(),
              conversationId: threadId,
              prepared: runtimeDispatch,
            });
            let result: ThreadContinueResult;
            try {
              result = await startAcpThreadContinuation({
                threadId,
                prompt:
                  "The user approved the plan. Implement it now with full Agent tools. Follow the approved plan.",
                runtimeConfigInput: runtimeConfig,
                skipRecordUserPrompt: true,
                preparedRuntimeDispatch: runtimeDispatch,
              });
              await dispatched;
            } catch (error) {
              void dispatched.catch(() => {});
              throw error;
            }
            conversationStore.clearPendingPlanForCommand(threadId, request);
            emitThreadEvent(threadId, "thread.plan_cleared", "计划已进入执行阶段。", "system");
            return { thread: result.thread };
          }

          requireThreadCore(approvalThread, "claude", "approve a Claude plan");

          const approval = resolveThreadPlanApprovalRuntime(threadId, {
            getThread: (id) => conversationStore.getThread(id),
            hasActiveRun: (id) => activeRunRuntimeState.hasRun(id),
            getPendingPlan: (id) => conversationStore.getPendingPlan(id),
            resolveRoleRoutes: (id) =>
              pendingRuntimeConfig
                ? roleRoutesForThreadConfig(getModelSettingsSnapshot(), pendingRuntimeConfig)
                : resolveRoleRoutesForThread(id),
            resolveRuntimeConfig: (routes) => resolveRuntimeConfigForThreadId(threadId, routes),
          });

          const currentConfig = ensureThreadRuntimeConfig(
            conversationStore.getThread(threadId) ?? approval.thread,
          ).runtimeConfig;
          if (!currentConfig) {
            throw new Error("Thread runtime configuration is missing.");
          }
          const agentRuntimeConfig = withAgentSessionMode(pendingRuntimeConfig ?? currentConfig, "agent");
          const snapshot = await persistApprovedPlanForThread(threadId, approval.pendingPlan);
          checkpoint("plan.snapshot_persisted", approvedPlanCheckpointPayload(snapshot));
          conversationStore.saveThreadRuntimeConfigForPlanCommand(threadId, agentRuntimeConfig, request, {
            coreKind: "claude",
            sessionMode: "agent",
          });
          commitThreadPlanApprovalToAgentMode(threadId, "claude_plan_approved");

          const pendingBeforeExecution = conversationStore.getPendingPlan(threadId);
          const forcedAttempt = forcedTarget
            ? armForcedPlanDelegation({
                threadId,
                coreKind: "claude",
                target: forcedTarget,
                plan: pendingBeforeExecution?.plan ?? approval.pendingPlan.plan,
              })
            : undefined;

          updateThread(threadId, {
            status: "running",
            message: "",
          });
          const runtimeDispatch = prepareConversationCommandDispatch({
            v2: conversationStore.conversationV2(),
            job: {
              principalId: request.principalId,
              conversationId: threadId,
              clientCommandId: request.clientCommandId,
            },
            coreKind: "claude",
            actionKind: "plan_approval",
            phase: "execution",
            checkpointScope: "plan",
          });
          const dispatched = waitForConversationCommandDispatch({
            v2: conversationStore.conversationV2(),
            conversationId: threadId,
            prepared: runtimeDispatch,
          });
          const runtime = runCodingThreadExecution(threadId, approval.runtimeConfig, {
            routesOverride: approval.roleRoutes,
            ...(forcedAttempt && forcedContract ? { followUp: forcedContract } : {}),
            runtimeDispatch,
            ...(!forcedAttempt
              ? {
                  planCommand: {
                    principalId: request.principalId,
                    clientCommandId: request.clientCommandId,
                  },
                }
              : {}),
          });
          observeConversationCommandRuntime({
            runtime,
            v2: conversationStore.conversationV2(),
            conversationId: threadId,
            prepared: runtimeDispatch,
            notStartedReason: "Claude plan execution ended before creating its first run attempt.",
            onRejected: (error) => {
              if (forcedAttempt) {
                settleForcedPlanDelegation(threadId, {
                  ok: false,
                  reason: errorMessage(error),
                });
              }
              process.stderr.write(
                `[eco] Claude plan execution failed before dispatch (${threadId}): ${errorMessage(error)}\n`,
              );
            },
            onObserverError: (error) => {
              process.stderr.write(
                `[eco] failed to settle Claude plan dispatch (${threadId}): ${errorMessage(error)}\n`,
              );
            },
          });
          await dispatched;
          return {
            thread: ensureThreadRuntimeConfig(conversationStore.getThread(threadId) ?? approval.thread),
          };
        },
      },
    );
  });

  registerDesktopCommand(IPC_CHANNELS.threadDismissPlan, async (payload: unknown) => {
    const request = parseThreadDismissPlanPayload(payload);
    requireConversationV2Thread(request.threadId);
    return executePlanResolutionCommand(
      {
        principalId: request.principalId,
        clientCommandId: request.clientCommandId,
        conversationId: request.threadId,
        resolution: "dismiss",
        expectedHistoryRevision: request.expectedHistoryRevision,
        request: {},
      },
      {
        v2: conversationStore.conversationV2(),
        errorMessage,
        freezeContext: () => buildPlanResolutionFrozenContext(request.threadId),
        execute: async (frozenContext, checkpoint) => {
          assertPlanResolutionContextCurrent(request.threadId, frozenContext);
          const pendingBridge = getPendingPlanApprovalForThread(request.threadId);
          if (pendingBridge) {
            if (
              !bindPendingPlanApprovalCommand(pendingBridge.toolUseId, {
                principalId: request.principalId,
                clientCommandId: request.clientCommandId,
              })
            ) {
              throw new Error("No pending plan approval is active for this thread.");
            }
            if (!resolvePendingPlanApproval(pendingBridge.toolUseId, "denied")) {
              clearPlanApprovalCommandBinding(pendingBridge.toolUseId);
              throw new Error("No pending plan approval is active for this thread.");
            }
            checkpoint("plan.bridge_resolved", {
              toolUseId: pendingBridge.toolUseId,
              decision: "denied",
            });
            try {
              await waitForPlanApprovalContinuation(pendingBridge.toolUseId);
            } catch (error) {
              rejectPlanApprovalContinuation(
                pendingBridge.toolUseId,
                error instanceof Error ? error : new Error(errorMessage(error)),
              );
              throw error;
            } finally {
              clearPlanApprovalCommandBinding(pendingBridge.toolUseId);
            }
            conversationStore.clearPendingPlanForCommand(
              request.threadId,
              request,
              "plan.dismissal_committed",
            );
            const thread = conversationStore.getThread(request.threadId);
            return thread ? { thread } : {};
          }
          await dismissPendingPlan(request.threadId, "计划忽略");
          checkpoint("plan.dismissal_committed", { route: "stored_pending_plan" });
          const thread = conversationStore.getThread(request.threadId);
          return thread ? { thread } : {};
        },
      },
    );
  });

  registerDesktopCommand(IPC_CHANNELS.threadFollowUpEnqueue, async (payload: unknown) =>
    enqueueThreadFollowUpCommand(parseThreadFollowUpEnqueueRequest(payload)),
  );

  registerRemainingDesktopCommands();
}

/**
 * Enqueue a follow-up message for a thread.
 *
 * Extracted from the IPC registration so in-process callers (async Codex question
 * answers) reuse the same V2 acceptance, idempotent client command id, queue row,
 * mid-turn steer and post-run continuation instead of inventing a second path.
 */
function enqueueThreadFollowUpCommand(
  request: ThreadFollowUpEnqueueRequest,
): Promise<ThreadFollowUpMutationResult> {
  return executeFollowUpMutationCommand(
    {
      principalId: request.principalId,
      clientCommandId: request.clientCommandId,
      conversationId: request.threadId,
      expectedHistoryRevision: request.expectedHistoryRevision,
      operation: "enqueue",
      request: {
        prompt: request.prompt,
        ...(request.priority ? { priority: request.priority } : {}),
        ...(request.followUpDeliveryMode ? { followUpDeliveryMode: request.followUpDeliveryMode } : {}),
        ...(request.attachments?.length ? { attachmentsHash: stableHash(request.attachments) } : {}),
      },
    },
    {
      v2: conversationStore.conversationV2(),
      errorMessage,
      execute: async () => {
        const thread = conversationStore.getThread(request.threadId);
        if (!thread) {
          throw new Error("Thread was not found.");
        }
        if (!threadAcceptsLiveFollowUp(thread.id, thread.status)) {
          throw new Error("Thread is not accepting queued follow-up messages.");
        }
        if (contextMonitor.isCompactInFlight(thread.id)) {
          throw new Error("上下文正在压缩中，请稍候。");
        }
        const followUpPendingActivityLineId = `follow-up:${randomUUID()}`;
        const persistedAttachments = request.attachments?.length
          ? await promptImageFileStore.persistMessageAttachments(
              thread.id,
              followUpPendingActivityLineId,
              request.attachments,
            )
          : undefined;
        const acceptedMessage = conversationStore.conversationV2().sendMessage({
          principalId: request.principalId,
          conversationId: thread.id,
          clientCommandId: request.clientCommandId,
          text: request.prompt,
          ...(persistedAttachments?.length ? { attachments: persistedAttachments } : {}),
        });
        const isAsyncAnswer = conversationStore
          .conversationV2()
          .isAsyncClarificationAnswer(thread.id, acceptedMessage.messageId);
        const existingAcceptedFollowUp = conversationStore
          .listThreadFollowUps(thread.id)
          .find((candidate) => candidate.conversationMessageId === acceptedMessage.messageId);
        if (existingAcceptedFollowUp) {
          return buildThreadFollowUpMutationResult(existingAcceptedFollowUp);
        }
        const deliveryMode =
          request.followUpDeliveryMode ?? workflowSettingsStore.get().followUpDeliveryMode ?? "steer";
        const metadata = resolveThreadFollowUpEnqueueMetadata(thread.id);
        const queuePaused = Boolean(thread.followUpQueuePaused);
        // ACP has no mid-turn: steer means interrupt + resume. Escalated priority always interrupts.
        // Ordinary messages wait for Resume; submitted question answers use their own delivery lane.
        const preferInterrupt =
          !queuePaused &&
          (request.priority === "escalated" ||
            (coreUsesInterruptForSteer(thread.coreKind) && deliveryMode === "steer"));
        const followUp = conversationStore.enqueueThreadFollowUp({
          threadId: thread.id,
          prompt: request.prompt,
          ...(persistedAttachments?.length ? { attachments: persistedAttachments } : {}),
          conversationMessageId: acceptedMessage.messageId,
          ...(preferInterrupt
            ? { priority: "escalated" }
            : request.priority
              ? { priority: request.priority }
              : {}),
          deliveryMode: preferInterrupt ? "interrupt_resume" : "queued",
          ...metadata,
        });

        if ((queuePaused && !isAsyncAnswer) || deliveryMode === "queue") {
          // Keep queued while paused or when the user chose queue delivery.
          emitThreadFollowUpEvent(followUp, "thread.follow_up.queued", formatFollowUpQueuedMessage(followUp));
          return buildThreadFollowUpMutationResult(
            conversationStore.getThreadFollowUp(thread.id, followUp.id) ?? followUp,
          );
        }

        if (preferInterrupt) {
          const midTurnResult = await tryDeliverFollowUpViaMidTurn(thread, followUp);
          if (isFollowUpMidTurnResultDelivered(midTurnResult)) {
            return buildThreadFollowUpMutationResult(midTurnResult);
          }
          // Mid-turn was skipped (blocking approval, editing row, or a port that is not
          // accepting) and the row is still `queued`: "handle now" must fall through to the
          // interrupt instead of reporting a silent no-op. A starting run keeps the
          // request armed until startActiveRun registers its controller.
          const progressThread = conversationStore.getThread(thread.id);
          if (!progressThread) throw new Error("Thread was not found.");
          if (
            !canEscalatedFollowUpProgressNow({
              hasActiveRun: activeRunRuntimeState.hasRun(thread.id),
              status: progressThread.status,
            })
          ) {
            pendingEscalatedFollowUpDrain.add(thread.id);
            const settled =
              midTurnResult ?? conversationStore.getThreadFollowUp(thread.id, followUp.id) ?? followUp;
            if (settled.status === "queued") {
              emitThreadFollowUpEvent(
                settled,
                "thread.follow_up.queued",
                formatFollowUpQueuedMessage(settled),
              );
            }
            return buildThreadFollowUpMutationResult(settled);
          }
          const current = await requestEscalatedFollowUpInterrupt(
            thread,
            midTurnResult ?? conversationStore.getThreadFollowUp(thread.id, followUp.id) ?? followUp,
          );
          if (current.status === "queued") {
            emitThreadFollowUpEvent(current, "thread.follow_up.queued", formatFollowUpQueuedMessage(current));
          }
          return buildThreadFollowUpMutationResult(current);
        }

        const midTurnResult = await tryDeliverFollowUpViaMidTurn(thread, followUp);
        const settled =
          midTurnResult ?? conversationStore.getThreadFollowUp(thread.id, followUp.id) ?? followUp;
        // Announce queue only when the row is still waiting (mid-turn skipped/rejected and requeued).
        if (settled.status === "queued") {
          emitThreadFollowUpEvent(settled, "thread.follow_up.queued", formatFollowUpQueuedMessage(settled));
          if (isAsyncAnswer) void drainQueuedThreadFollowUpsAfterRun(thread.id);
        }
        return buildThreadFollowUpMutationResult(settled);
      },
    },
  );
}

function registerRemainingDesktopCommands(): void {
  registerDesktopCommand(IPC_CHANNELS.threadFollowUpEscalate, async (payload: unknown) => {
    const request = parseThreadFollowUpEscalateRequest(payload);
    return executeFollowUpMutationCommand(
      {
        principalId: request.principalId,
        clientCommandId: request.clientCommandId,
        conversationId: request.threadId,
        expectedHistoryRevision: request.expectedHistoryRevision,
        operation: "escalate",
        request: {
          ...(request.followUpId ? { followUpId: request.followUpId } : {}),
          ...(request.prompt ? { prompt: request.prompt } : {}),
          ...(request.attachments?.length ? { attachmentsHash: stableHash(request.attachments) } : {}),
        },
      },
      {
        v2: conversationStore.conversationV2(),
        errorMessage,
        execute: async () => {
          const thread = conversationStore.getThread(request.threadId);
          if (!thread) {
            throw new Error("Thread was not found.");
          }
          if (!threadAcceptsLiveFollowUp(thread.id, thread.status)) {
            throw new Error("Thread is not accepting queued follow-up messages.");
          }
          if (contextMonitor.isCompactInFlight(thread.id)) {
            throw new Error("上下文正在压缩中，请稍候。");
          }
          const base = request.followUpId
            ? conversationStore.escalateThreadFollowUp(thread.id, request.followUpId)
            : conversationStore.enqueueThreadFollowUp({
                threadId: thread.id,
                prompt: request.prompt ?? "",
                ...(request.attachments?.length ? { attachments: request.attachments } : {}),
                priority: "escalated",
                deliveryMode: "interrupt_resume",
                ...resolveThreadFollowUpEnqueueMetadata(thread.id),
              });
          if (!base) {
            throw new Error("Pending follow-up was not found or cannot be escalated.");
          }
          const followUp = request.followUpId
            ? base
            : (conversationStore.escalateThreadFollowUp(thread.id, base.id) ?? base);
          emitThreadFollowUpEvent(followUp, "thread.follow_up.escalated", "");
          // Escalating supersedes the other "handle now" rows: they will never deliver,
          // so their V2 acceptances are discarded with them.
          discardAbandonedAcceptedPrompts(conversationStore.conversationV2(), {
            conversationId: thread.id,
            messageIds: conversationStore
              .listThreadFollowUps(thread.id, { statuses: ["superseded"] })
              .map((superseded) => superseded.conversationMessageId ?? ""),
            reason: "follow-up-superseded",
          });

          const midTurnResult = await tryDeliverFollowUpViaMidTurn(thread, followUp);
          if (isFollowUpMidTurnResultDelivered(midTurnResult)) {
            return buildThreadFollowUpMutationResult(midTurnResult);
          }
          // A skipped mid-turn inject leaves the row `queued`; Guide must not be swallowed
          // by a paused queue (or a non-accepting port) — fall through to interrupt, which
          // arms one forced drain past the pause. When nothing can move (e.g. the run is
          // still starting up), keep the request armed until its controller is ready.
          const progressThread = conversationStore.getThread(thread.id);
          if (!progressThread) throw new Error("Thread was not found.");
          if (
            !canEscalatedFollowUpProgressNow({
              hasActiveRun: activeRunRuntimeState.hasRun(thread.id),
              status: progressThread.status,
            })
          ) {
            pendingEscalatedFollowUpDrain.add(thread.id);
            return buildThreadFollowUpMutationResult(
              midTurnResult ?? conversationStore.getThreadFollowUp(thread.id, followUp.id) ?? followUp,
            );
          }
          const current = await requestEscalatedFollowUpInterrupt(
            thread,
            midTurnResult ?? conversationStore.getThreadFollowUp(thread.id, followUp.id) ?? followUp,
          );
          return buildThreadFollowUpMutationResult(current);
        },
      },
    );
  });

  registerDesktopCommand(IPC_CHANNELS.threadFollowUpList, async (threadId: unknown) => {
    const id = typeof threadId === "string" ? threadId.trim() : "";
    if (!id) {
      return { followUps: [] };
    }
    return { followUps: conversationStore.listThreadFollowUps(id) };
  });

  registerDesktopCommand(IPC_CHANNELS.threadFollowUpEditing, async (payload: unknown) => {
    const request = parseThreadFollowUpEditingRequest(payload);
    return executeFollowUpMutationCommand(
      {
        principalId: request.principalId,
        clientCommandId: request.clientCommandId,
        conversationId: request.threadId,
        expectedHistoryRevision: request.expectedHistoryRevision,
        operation: "editing",
        request: { ...(request.followUpId ? { followUpId: request.followUpId } : {}) },
      },
      {
        v2: conversationStore.conversationV2(),
        errorMessage,
        execute: async () =>
          withThreadFollowUpLock(request.threadId, async () => {
            if (request.followUpId) {
              const followUp = conversationStore.getThreadFollowUp(request.threadId, request.followUpId);
              if (!followUp || followUp.status !== "queued") {
                throw new Error("Pending follow-up was not found or can no longer be edited.");
              }
              editingThreadFollowUpByThread.set(request.threadId, request.followUpId);
              return { editing: true } satisfies ThreadFollowUpEditingResult;
            }
            const released = editingThreadFollowUpByThread.delete(request.threadId);
            if (released) {
              void drainQueuedThreadFollowUpsAfterRun(request.threadId);
            }
            return { editing: false } satisfies ThreadFollowUpEditingResult;
          }),
      },
    );
  });

  registerDesktopCommand(IPC_CHANNELS.threadFollowUpQueuePaused, async (payload: unknown) => {
    const request = parseThreadFollowUpQueuePausedRequest(payload);
    return executeFollowUpMutationCommand(
      {
        principalId: request.principalId,
        clientCommandId: request.clientCommandId,
        conversationId: request.threadId,
        expectedHistoryRevision: request.expectedHistoryRevision,
        operation: "queue-paused",
        request: { paused: request.paused },
      },
      {
        v2: conversationStore.conversationV2(),
        errorMessage,
        execute: async () => {
          threadFollowUpQueueControl.changed(request.threadId);
          const thread = setThreadFollowUpQueuePausedState(request.threadId, request.paused);
          if (!thread) {
            throw new Error("Thread was not found.");
          }
          const hasPreparingAsyncAnswer = conversationStore
            .listThreadFollowUps(request.threadId, { statuses: ["delivered"] })
            .some(isAsyncClarificationAnswerFollowUp);
          if (
            request.paused &&
            threadFollowUpDrainScheduler.isDraining(request.threadId) &&
            !hasPreparingAsyncAnswer
          ) {
            threadRunPreparations.cancel(request.threadId);
          }
          // Pause only holds ordinary rows. Also retry after cancelled preparation so
          // an independent question answer does not wait for a later Resume click.
          void drainQueuedThreadFollowUpsAfterRun(request.threadId);
          return {
            paused: Boolean(thread.followUpQueuePaused),
            thread,
          } satisfies ThreadFollowUpQueuePausedResult;
        },
      },
    );
  });

  registerDesktopCommand(IPC_CHANNELS.threadFollowUpCancel, async (payload: unknown) => {
    const request = parseThreadFollowUpCancelRequest(payload);
    return executeFollowUpMutationCommand(
      {
        principalId: request.principalId,
        clientCommandId: request.clientCommandId,
        conversationId: request.threadId,
        expectedHistoryRevision: request.expectedHistoryRevision,
        operation: "cancel",
        request: { followUpId: request.followUpId },
      },
      {
        v2: conversationStore.conversationV2(),
        errorMessage,
        execute: async () => {
          const followUp = conversationStore.cancelThreadFollowUp(request.threadId, request.followUpId);
          if (!followUp) {
            throw new Error("Pending follow-up was not found or cannot be cancelled.");
          }
          // Store cancellation atomically discards the queued V2 acceptance.
          const attachmentPaths = promptImageFileStore.collectAttachmentPaths(followUp.attachments);
          if (attachmentPaths.length > 0) {
            await promptImageFileStore.releasePaths(attachmentPaths);
          }
          // Cancelling the last held row means the pause has nothing left to hold.
          releaseFollowUpQueuePauseWhenEmpty(request.threadId);
          if (editingThreadFollowUpByThread.get(request.threadId) === followUp.id) {
            editingThreadFollowUpByThread.delete(request.threadId);
            void drainQueuedThreadFollowUpsAfterRun(request.threadId);
          }
          emitThreadFollowUpEvent(followUp, "thread.follow_up.cancelled", "已取消排队的后续消息。");
          return buildThreadFollowUpMutationResult(followUp);
        },
      },
    );
  });

  registerDesktopCommand(IPC_CHANNELS.threadFollowUpReorder, async (payload: unknown) => {
    const request = parseThreadFollowUpReorderRequest(payload);
    return executeFollowUpMutationCommand(
      {
        principalId: request.principalId,
        clientCommandId: request.clientCommandId,
        conversationId: request.threadId,
        expectedHistoryRevision: request.expectedHistoryRevision,
        operation: "reorder",
        request: { followUpIds: request.followUpIds },
      },
      {
        v2: conversationStore.conversationV2(),
        errorMessage,
        execute: async () => {
          conversationStore.reorderQueuedThreadFollowUps(request.threadId, request.followUpIds);
          return {
            followUps: conversationStore.listThreadFollowUps(request.threadId),
          };
        },
      },
    );
  });

  registerDesktopCommand(IPC_CHANNELS.threadFollowUpUpdate, async (payload: unknown) => {
    const request = parseThreadFollowUpUpdateRequest(payload);
    return executeFollowUpMutationCommand(
      {
        principalId: request.principalId,
        clientCommandId: request.clientCommandId,
        conversationId: request.threadId,
        expectedHistoryRevision: request.expectedHistoryRevision,
        operation: "update",
        request: {
          followUpId: request.followUpId,
          prompt: request.prompt,
          ...(request.attachments?.length ? { attachmentsHash: stableHash(request.attachments) } : {}),
        },
      },
      {
        v2: conversationStore.conversationV2(),
        errorMessage,
        execute: async () => {
          const thread = conversationStore.getThread(request.threadId);
          if (!thread) {
            throw new Error("Thread was not found.");
          }
          if (contextMonitor.isCompactInFlight(thread.id)) {
            throw new Error("上下文正在压缩中，请稍候。");
          }
          const persistedAttachments = request.attachments?.length
            ? await promptImageFileStore.persistMessageAttachments(
                thread.id,
                `follow-up-edit:${request.clientCommandId}`,
                request.attachments,
              )
            : undefined;
          const followUp = conversationStore.updateThreadFollowUp(request.threadId, request.followUpId, {
            prompt: request.prompt,
            ...(persistedAttachments?.length ? { attachments: persistedAttachments } : {}),
          });
          if (!followUp) {
            throw new Error("Pending follow-up was not found or cannot be updated.");
          }
          if (editingThreadFollowUpByThread.get(request.threadId) === followUp.id) {
            editingThreadFollowUpByThread.delete(request.threadId);
            void drainQueuedThreadFollowUpsAfterRun(request.threadId);
          }
          emitThreadFollowUpEvent(followUp, "thread.follow_up.updated", "");
          return buildThreadFollowUpMutationResult(followUp);
        },
      },
    );
  });

  registerDesktopCommand(IPC_CHANNELS.threadCancel, async (payload: unknown) => {
    const request = parseThreadCancelRequest(payload);
    if (!request) {
      throw new ConversationV2Error(
        CONVERSATION_V2_ERROR.invalidParams,
        "Thread cancellation requires a complete Conversation V2 command envelope.",
      );
    }
    return executeThreadCancelCommand(request, {
      v2: conversationStore.conversationV2(),
      errorMessage,
      cancel: async ({ threadId, worktreeDisposition }) => {
        schedulingGateway.disposeThread(threadId);
        contextReferenceGateway.revokeThread(threadId);
        schedulingService.pauseAutomaticMessages(threadId);
        // Explicit Stop revokes an earlier Guide; cleanup must pause queued rows.
        pendingEscalatedFollowUpDrain.delete(threadId);
        threadFollowUpQueueControl.stopped(threadId);
        threadRunPreparations.cancel(threadId);
        autoPauseFollowUpQueueWhenQueuedRemain(threadId);
        const owner = conversationStore.getThread(threadId)?.coreKind;
        const hadActiveRun = activeRunRuntimeState.hasRun(threadId);
        if (hadActiveRun) {
          markThreadCancelling(threadId);
          updateThread(threadId, { status: "running", message: "" });
        }
        if (worktreeDisposition) {
          pendingCancelDisposition.set(threadId, worktreeDisposition);
        }
        // Abort before any async runtime cleanup or approval resolution can delay Stop.
        activeRunRuntimeState.abortRun(threadId, "cancelled by user");
        if (owner) {
          await threadRuntimeCoordinator.cancel(owner, threadId);
        }
        if (hadActiveRun) {
          return;
        }
        const thread = conversationStore.getThread(threadId);
        if (thread?.status === "awaiting_plan") {
          await dismissPendingPlan(threadId, "已取消。");
          return;
        }
        if (thread?.status === "running" || thread?.status === "queued") {
          const pending = conversationStore.getPendingPlan(threadId);
          const workspacePath = pending?.workspacePath ?? thread.workspacePath;
          if (workspacePath) {
            const plan = resolveWorktreePlan(workspacePath, threadId, pending?.worktreePath);
            await handleRunCancelled(threadId, plan);
          } else {
            updateThread(threadId, { status: "idle", message: "" });
          }
        }
      },
    });
  });

  registerDesktopCommand(IPC_CHANNELS.threadRollbackTo, async (threadId: unknown) => {
    if (typeof threadId !== "string" || !threadId.trim()) {
      throw new Error("Thread id is required.");
    }
    return rollbackWorkspaceToThread(threadId);
  });

  registerDesktopCommand(IPC_CHANNELS.threadGetAppliedDiff, async (threadId: unknown) => {
    if (typeof threadId !== "string" || !threadId.trim()) {
      throw new Error("Thread id is required.");
    }
    return getThreadAppliedDiff(threadId);
  });

  registerDesktopCommand(IPC_CHANNELS.threadRevertAppliedDiff, async (threadId: unknown) => {
    if (typeof threadId !== "string" || !threadId.trim()) {
      throw new Error("Thread id is required.");
    }
    return revertThreadAppliedDiff(threadId);
  });

  registerDesktopCommand(IPC_CHANNELS.modelProfilesList, async () => getModelSettingsSnapshot().providers);

  ipcMain.on("message", (event) => {
    if (!isKnownIpcChannel(event.type)) {
      event.preventDefault();
    }
  });
}

async function ensureWorkspace(workspacePath: string): Promise<WorkspaceInfo> {
  const resolvedPath = path.resolve(workspacePath);
  if (currentWorkspace?.path === resolvedPath) {
    return currentWorkspace;
  }

  const workspace = await inspectWorkspace(resolvedPath);
  currentWorkspace = workspace;
  syncGitAutoFetcherWorkspace();
  return workspace;
}

interface ThreadWorktreeResolution {
  worktreePlan: WorktreePlan;
  cwd: string;
  isolated: boolean;
}

async function resolveThreadWorktree(
  workspace: WorkspaceInfo,
  threadId: string,
  existingWorktreePlan?: WorktreePlan,
): Promise<ThreadWorktreeResolution> {
  const worktreePlan = existingWorktreePlan ?? createSessionPlan(workspace.path, threadId);
  return { worktreePlan, cwd: workspace.path, isolated: false };
}

function isIsolatedWorktreePlan(_plan: Pick<WorktreePlan, "workspacePath" | "worktreePath">): boolean {
  return false;
}

function normalizeSessionCwd(workspacePath: string, sessionCwd?: string): string {
  const workspace = path.resolve(workspacePath);
  const cwd = sessionCwd?.trim();
  if (!cwd) {
    return workspace;
  }
  if (path.resolve(cwd) === workspace) {
    return workspace;
  }
  if (cwd.includes(`${path.sep}.eco${path.sep}worktrees${path.sep}`)) {
    return workspace;
  }
  return cwd;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function applyThreadTitleSummary(threadId: string, title: string): void {
  const thread = conversationStore.getThread(threadId);
  if (!thread || thread.title === title || !shouldReplaceAutoThreadTitle(thread.title)) {
    return;
  }

  conversationStore.updateThreadTitle(threadId, title);
  emitThreadEvent(threadId, "thread.title_updated", "标题已更新", "system", false, { title });
}

/** ACP owns the sidebar title via session_info_update — do not require a placeholder. */
function applyAcpSessionTitle(threadId: string, rawTitle: string): void {
  const title = normalizeAcpSessionTitle(rawTitle);
  if (!title) {
    return;
  }
  const thread = conversationStore.getThread(threadId);
  if (!thread || thread.title === title) {
    return;
  }
  conversationStore.updateThreadTitle(threadId, title);
  emitThreadEvent(threadId, "thread.title_updated", "标题已更新", "system", false, { title });
}

function emitThreadTitleFailure(threadId: string, reason?: string): void {
  const thread = conversationStore.getThread(threadId);
  if (!thread || !shouldReplaceAutoThreadTitle(thread.title)) {
    return;
  }
  const message = reason?.trim() ? `会话标题生成失败：${reason.trim()}` : "会话标题生成失败";
  const fallbackTitle = resolveFailedThreadTitle(thread.prompt, currentAppLocale());
  if (fallbackTitle !== thread.title) {
    conversationStore.updateThreadTitle(threadId, fallbackTitle);
  }
  emitThreadEvent(threadId, "thread.title_failed", message, "system", false, {
    title: fallbackTitle,
  });
}

async function resolveSelectedModelOutputOptions(
  selection: { providerId: string; candidateModelId: string } | undefined,
) {
  const workflow = workflowSettingsStore.get();
  const baseOptions = {
    globalMaxOutputTokens: workflow.maxOutputLimitTokens,
    globalContextWindowLimit: workflow.contextWindowLimitTokens,
  };
  if (!selection) return baseOptions;
  const provider = providerStore
    .listProvidersWithSecrets()
    .find((entry) => entry.id === selection.providerId);
  const candidate = providerStore
    .listCandidateModels(selection.providerId)
    .find((entry) => entry.id === selection.candidateModelId);
  if (!provider || !candidate || provider.apiCompat === "system_one") return baseOptions;
  const resolved = await pricingCache.resolveContextLimit(
    provider.baseUrl,
    candidate.modelId,
    candidate.modelsDevMapping,
    candidate.manualSpec?.contextTokens,
    candidate.manualSpec?.maxOutputTokens,
  );
  return {
    ...baseOptions,
    contextTokens: resolveEffectiveContextLimit(resolved.limit, workflow.contextWindowLimitTokens),
    ...(resolved.maxOutputTokens !== undefined && { catalogMaxOutputTokens: resolved.maxOutputTokens }),
  };
}

function scheduleThreadTitleSummary(threadId: string): boolean {
  const thread = conversationStore.getThread(threadId);
  if (
    !thread ||
    !canRegenerateThreadTitle(thread.title, titleGeneratingThreadIds.has(threadId), thread.coreKind)
  ) {
    return false;
  }

  titleGeneratingThreadIds.add(threadId);
  const prompt = thread.prompt;
  emitThreadEvent(threadId, "thread.title_generating", "", "system", false, {
    titleGenerating: true,
  });
  if (!thread.runtimeConfig?.auxiliaryModel) {
    titleGeneratingThreadIds.delete(threadId);
    emitThreadEvent(threadId, "thread.title_generating", "", "system", false, {
      titleGenerating: false,
    });
    return true;
  }
  // Keep the placeholder until the generated title passes parsing and sanitization.
  void (async () => {
    const outputOptions = await resolveSelectedModelOutputOptions(thread.runtimeConfig?.auxiliaryModel);
    const titleRoute = resolveAuxiliaryModelRoute(
      thread.runtimeConfig?.auxiliaryModel,
      providerStore,
      outputOptions,
    );
    return summarizeThreadTitle([titleRoute], prompt, fetch);
  })()
    .then((title) => {
      if (title) {
        applyThreadTitleSummary(threadId, title);
        return;
      }
      emitThreadTitleFailure(threadId);
    })
    .catch((error) => {
      process.stderr.write(`[eco] title summary failed: ${errorMessage(error)}\n`);
      emitThreadTitleFailure(threadId);
    })
    .finally(() => {
      titleGeneratingThreadIds.delete(threadId);
      emitThreadEvent(threadId, "thread.title_generating", "", "system", false, {
        titleGenerating: false,
      });
    });
  return true;
}

function captureThreadPlanReady(input: {
  threadId: string;
  payload: PlanReadyPayload;
  workspacePath: string;
  worktreePath: string;
  routesJson: string;
  awaitingPlanMessage: string;
}): true {
  const result = applyThreadPlanReadyEffects({
    threadId: input.threadId,
    payload: input.payload,
    workspacePath: input.workspacePath,
    worktreePath: input.worktreePath,
    routesJson: input.routesJson,
    awaitingPlanMessage: input.awaitingPlanMessage,
    effects: {
      savePendingPlan: (plan) => {
        conversationStore.savePendingPlan(plan);
      },
      emitAwaitingPlan: (event) => {
        emitThreadEvent(event.threadId, "thread.awaiting_plan", event.message, "main", false, {
          plan: event.plan,
        });
      },
    },
  });

  return result.planCaptured;
}

function markThreadInterrupted(threadId: string, reason: string): void {
  const summary = formatUserFacingRequestError(reason);
  const truncated = summary.length > 240 ? `${summary.slice(0, 237)}…` : summary;
  process.stderr.write(`[eco] thread blocked (${threadId}): ${truncated}\n`);
  patchThreadSummary(threadId, {
    status: "blocked",
    message: truncated,
  });
  const followUpQueuePaused = autoPauseFollowUpQueueForErrorStatus(threadId, "blocked");
  emitThreadEvent(threadId, "thread.blocked", truncated, "system", false, {
    metadata: { activityOrigin: "eco.thread_blocked" },
    ...(typeof followUpQueuePaused === "boolean" ? { followUpQueuePaused } : {}),
  });
}

function threadHasResumableCheckpoint(
  thread: ThreadSummary,
  activityLines: readonly ThreadActivityLine[],
): boolean {
  if (conversationStore.getSdkSession(thread.id)?.sessionId) {
    return true;
  }
  if (thread.status === "idle" || thread.status === "blocked" || thread.status === "failed") {
    return activityLines.some((line) => line.role !== "tool");
  }
  return activityLines.some(
    (line) => line.role === "system" && (line.message.includes("已停止") || line.message.includes("检查点")),
  );
}

function runThreadRequestOnce(
  threadId: string,
  phase: RunAttemptPhase,
  signal: AbortSignal | undefined,
  runOnce: (context: RunAttemptContext) => Promise<RequestAttemptResult>,
  retryIndex = 0,
  runtimeDispatch?: PreparedHistoryRuntimeDispatch,
): Promise<RequestAttemptResult> {
  return runThreadRequestWithLifecycle({
    threadId,
    phase,
    runOnce,
    lifecycle: agentLifecycle,
    settlements: usageLedgerCoordinator,
    retryIndex,
    ...(runtimeDispatch
      ? {
          attemptId: runtimeDispatch.plannedAttemptId,
          commandDispatch: runtimeDispatch.commandDispatch,
          metadata: {
            commandDispatch: runtimeDispatch.commandDispatch,
          },
        }
      : {}),
    ...(signal && { signal }),
  }).finally(() => {
    // finishRunAttempt writes the authoritative V2 attempt state. The durable
    // writer publishes the corresponding sync effect; there is no legacy Feed
    // skeleton to refresh here.
    scheduleThreadRunProjectionUpdated(threadId, { streaming: false });
  });
}

/**
 * Cancel in-memory plan-approval bridges only.
 * Never clear persisted pending plans — users must be able to approve after quit/restart.
 */
function cancelPlanApprovalsForThreadKeepPending(threadId: string, reason: string): void {
  cancelPlanApprovalsForThread(threadId, reason);
}

const deferredRunCleanupByThread = new Map<string, FinalizeThreadRunCleanupInput>();

async function awaitThreadRunUserGates(threadId: string): Promise<void> {
  const planWait = getPendingPlanApprovalWaitForThread(threadId);
  if (planWait) {
    await planWait.catch(() => {});
  }
}

async function retryDeferredRunCleanupIfNeeded(threadId: string): Promise<void> {
  const deferred = deferredRunCleanupByThread.get(threadId);
  if (!deferred) {
    return;
  }
  // Only a blocking question holds the run open; an unanswered async Codex question must
  // not keep the cleanup deferred forever.
  if (
    shouldDeferRunCleanupFinish({
      hasPendingBridgeApproval: Boolean(getPendingPlanApprovalForThread(threadId)),
      hasPendingClarification: hasPendingBlockingClarificationForThread(threadId),
    })
  ) {
    return;
  }
  deferredRunCleanupByThread.delete(threadId);
  await finalizeMainThreadRunCleanup(deferred);
}

async function finalizeMainThreadRunCleanup(input: FinalizeThreadRunCleanupInput): Promise<void> {
  await awaitThreadRunUserGates(input.threadId);
  // Async Codex questions are answerable after the run; they never gate the cleanup.
  if (
    shouldDeferRunCleanupFinish({
      hasPendingBridgeApproval: Boolean(getPendingPlanApprovalForThread(input.threadId)),
      hasPendingClarification: hasPendingBlockingClarificationForThread(input.threadId),
    })
  ) {
    deferredRunCleanupByThread.set(input.threadId, input);
    return;
  }
  deferredRunCleanupByThread.delete(input.threadId);
  await finalizeThreadRunCleanup(input, {
    cancelClarifications: cancelClarificationsForThread,
    cancelBashApprovals: cancelBashApprovalsForThread,
    cancelPlanApprovals: cancelPlanApprovalsForThreadKeepPending,
    shouldPreservePlanApprovals: (threadId) => {
      const threadStatus = conversationStore.getThread(threadId)?.status;
      return shouldPreservePlanApprovalsOnRunCleanup({
        hasPendingBridgeApproval: Boolean(getPendingPlanApprovalForThread(threadId)),
        ...(threadStatus && { threadStatus }),
        hasStoredPendingPlan: Boolean(conversationStore.getPendingPlan(threadId)),
      });
    },
    shouldPreserveClarifications: (threadId) => Boolean(getPendingClarificationForThread(threadId)),
    shouldDeferRunCleanupFinish: (threadId) =>
      shouldDeferRunCleanupFinish({
        hasPendingBridgeApproval: Boolean(getPendingPlanApprovalForThread(threadId)),
        hasPendingClarification: hasPendingBlockingClarificationForThread(threadId),
      }),
    resetSdkStream: (threadId) => {
      sdkStreamBridge.flushPendingAndReset(threadId, (id, type, message, role, stream, agentId, extras) => {
        const metadata = extras?.metadata;
        emitThreadEvent(
          id,
          type,
          message,
          role as AgentRole | "system" | "thinking" | "tool" | "user",
          stream,
          agentId || extras
            ? {
                ...(agentId && { agentId }),
                ...(extras?.tool && { tool: extras.tool }),
                ...(metadata && { metadata }),
              }
            : undefined,
        );
      });
    },
    flushUsageUpdates: (threadId) => usageLedgerCoordinator.flushUsageUpdates(threadId),
    finishActiveRun,
    afterRunContextRefresh,
    getThread: (threadId) => conversationStore.getThread(threadId),
    updateThreadIdle: (threadId, message) => {
      updateThread(threadId, { status: "idle", message });
    },
  });
  await cleanupPendingClaudeFork(input.threadId);
  try {
    await drainQueuedThreadFollowUpsAfterRun(input.threadId);
  } catch (error) {
    process.stderr.write(
      `[eco] failed to drain queued follow-ups (${input.threadId}): ${errorMessage(error)}\n`,
    );
  }
}

async function requestEscalatedFollowUpInterrupt(
  snapshot: ThreadSummary,
  followUp: ThreadPendingFollowUp,
): Promise<ThreadPendingFollowUp> {
  // The mid-turn attempt can outlive the run. Use the current settled status.
  const thread = conversationStore.getThread(snapshot.id);
  if (!thread) throw new Error("Thread was not found.");
  // Match manual cancel: ACP needs session/cancel + process teardown, not only AbortSignal.
  if (thread.coreKind === "acp") {
    cancelAcpThread(thread.id);
  }
  if (activeRunRuntimeState.abortRun(thread.id, "follow-up escalated")) {
    pendingEscalatedFollowUpDrain.add(thread.id);
    updateThread(thread.id, {
      status: "running",
      message: "",
    });
    cancelClarificationsForThread(thread.id, "follow-up escalated");
    cancelBashApprovalsForThread(thread.id, "follow-up escalated");
    emitThreadEvent(
      thread.id,
      "thread.follow_up.interrupting",
      "正在停止当前步骤，随后处理最新后续消息。",
      "system",
      false,
      { followUp },
    );
    return followUp;
  }

  if (shouldDrainThreadFollowUps(thread.status)) {
    // Escalated owns exactly one drain: arm the forced flag so the paused queue does
    // not block it, while the remaining rows stay paused afterwards.
    pendingEscalatedFollowUpDrain.add(thread.id);
    void drainQueuedThreadFollowUpsAfterRun(thread.id);
    return followUp;
  }

  const reason = "当前对话没有可中断的 active run，无法立即处理后续消息。";
  const failed =
    conversationStore.updateThreadFollowUpStatus(thread.id, followUp.id, {
      status: "failed",
      error: reason,
    }) ?? followUp;
  emitThreadEvent(thread.id, "thread.follow_up.failed", `后续消息处理失败：${reason}`, "system", false, {
    followUp: failed,
  });
  return failed;
}

async function drainQueuedThreadFollowUpsAfterRun(threadId: string): Promise<void> {
  await threadFollowUpDrainScheduler.drain(threadId, () => drainNextQueuedThreadFollowUp(threadId));
}

async function drainNextQueuedThreadFollowUp(threadId: string): Promise<void> {
  return threadRunPreparations.prepare(threadId, (signal) =>
    drainPreparedNextQueuedThreadFollowUp(threadId, signal),
  );
}

async function drainPreparedNextQueuedThreadFollowUp(
  threadId: string,
  preparationSignal: AbortSignal,
): Promise<void> {
  const queueControlRevision = threadFollowUpQueueControl.revision(threadId);
  if (activeRunRuntimeState.hasRun(threadId)) {
    return;
  }
  const drainClaim = await withThreadFollowUpLock(threadId, async () => {
    if (preparationSignal.aborted)
      return { claimed: [] as ThreadPendingFollowUp[], forceEscalatedDrain: false };
    const thread = conversationStore.getThread(threadId);
    const forceEscalatedDrain = pendingEscalatedFollowUpDrain.delete(threadId);
    const excludeFollowUpId = editingFollowUpClaimExclusion(threadId);
    const target = selectThreadFollowUpDrainTarget({
      followUps: conversationStore.listThreadFollowUps(threadId, { statuses: ["queued"] }),
      forceEscalatedDrain,
      ...(excludeFollowUpId ? { excludeFollowUpId } : {}),
      isAsyncClarificationAnswer: isAsyncClarificationAnswerFollowUp,
    });
    // Escalated interrupt may force one drain while the queue remains user-paused.
    if (
      shouldBlockThreadFollowUpDrain({
        hasPendingBridgeApproval: Boolean(getPendingPlanApprovalForThread(threadId)),
        // Non-blocking questions must not stall the queue: the run finished, and the user
        // may answer the question much later (or never).
        hasPendingClarification: hasPendingBlockingClarificationForThread(threadId),
        hasEditingFollowUp: editingThreadFollowUpByThread.has(threadId),
        hasFollowUpQueuePaused: Boolean(thread?.followUpQueuePaused) && !forceEscalatedDrain,
        isAsyncClarificationAnswer: target.isAsyncClarificationAnswer,
        ...(thread?.status && { threadStatus: thread.status }),
        hasStoredPendingPlan: Boolean(conversationStore.getPendingPlan(threadId)),
      })
    ) {
      if (forceEscalatedDrain) {
        pendingEscalatedFollowUpDrain.add(threadId);
      }
      return {
        claimed: [] as ThreadPendingFollowUp[],
        forceEscalatedDrain: false,
      };
    }
    if (!thread || !shouldDrainThreadFollowUps(thread.status)) {
      if (thread && forceEscalatedDrain) pendingEscalatedFollowUpDrain.add(threadId);
      return {
        claimed: [] as ThreadPendingFollowUp[],
        forceEscalatedDrain: false,
      };
    }
    const claimed = conversationStore.claimQueuedThreadFollowUps(threadId, {
      deliveryMode: "resume",
      deliveryBoundary: forceEscalatedDrain ? "forced_interrupt" : "safe_boundary",
      ...(target.priority ? { priority: target.priority } : {}),
      ...(target.followUpId ? { followUpId: target.followUpId } : {}),
      ...(excludeFollowUpId ? { excludeFollowUpId } : {}),
    });
    return { claimed, forceEscalatedDrain };
  });
  const { claimed, forceEscalatedDrain } = drainClaim;
  if (claimed.length === 0) {
    return;
  }
  const thread = conversationStore.getThread(threadId);
  if (!thread) {
    return;
  }

  const prompt = buildThreadFollowUpDrainPrompt(claimed);
  const displayPrompt = buildThreadFollowUpDisplayPrompt(claimed);
  const attachments = collectThreadFollowUpAttachments(claimed);
  const v2AcceptedMessageIds = claimed
    .map((followUp) => followUp.conversationMessageId)
    .filter((messageId): messageId is string => Boolean(messageId?.trim()));
  const skipRecordUserPrompt = claimed.some((followUp) => midTurnLocalUserPromptFollowUpIds.has(followUp.id));
  for (const followUp of claimed) {
    midTurnLocalUserPromptFollowUpIds.delete(followUp.id);
  }
  try {
    if (!prompt && attachments.length === 0) {
      throw new Error("排队的后续消息缺少可发送内容。");
    }
    await startThreadContinuation({
      threadId,
      preparationSignal,
      prompt,
      displayPrompt,
      ...(attachments.length > 0 ? { attachments } : {}),
      ...(v2AcceptedMessageIds.length > 0 ? { v2AcceptedMessageIds } : {}),
      requireResumeForInterrupted:
        forceEscalatedDrain || thread.status === "failed" || thread.status === "blocked",
      ...(forceEscalatedDrain || claimed.some(isAsyncClarificationAnswerFollowUp)
        ? { allowWhileQueuePaused: true }
        : {}),
      ...(skipRecordUserPrompt ? { skipRecordUserPrompt: true } : {}),
    });
    for (const followUp of claimed) {
      const applied =
        conversationStore.updateThreadFollowUpStatus(threadId, followUp.id, {
          status: "applied",
        }) ?? followUp;
      emitThreadEvent(threadId, "thread.follow_up.applied", "已开始处理排队的后续消息。", "system", false, {
        followUp: applied,
      });
    }
  } catch (error) {
    if (error instanceof ThreadRunPreparationCancelled) {
      for (const followUp of claimed) {
        const queued = conversationStore.updateThreadFollowUpStatus(threadId, followUp.id, {
          status: "queued",
        });
        if (queued) emitThreadFollowUpEvent(queued, "thread.follow_up.queued", "");
      }
      // A later Resume is authoritative even if this cancelled preparation only
      // now returns. Retry after requeueing instead of overwriting Resume's pause.
      if (threadFollowUpQueueControl.revision(threadId) === queueControlRevision) {
        autoPauseFollowUpQueueWhenQueuedRemain(threadId);
      } else if (!conversationStore.getThread(threadId)?.followUpQueuePaused) {
        void drainQueuedThreadFollowUpsAfterRun(threadId);
      }
      if (
        !activeRunRuntimeState.hasRun(threadId) &&
        conversationStore.getThread(threadId)?.status === "running"
      ) {
        updateThread(threadId, { status: "idle", message: "" });
      }
      return;
    }
    const reason = errorMessage(error);
    failAcceptedV2Messages(threadId, v2AcceptedMessageIds, reason);
    for (const followUp of claimed) {
      const failed =
        conversationStore.updateThreadFollowUpStatus(threadId, followUp.id, {
          status: "failed",
          error: reason,
        }) ?? followUp;
      emitThreadEvent(
        threadId,
        "thread.follow_up.failed",
        `后续消息处理失败：${formatFollowUpDrainError(reason)}`,
        "system",
        false,
        { followUp: failed },
      );
    }
  } finally {
    releaseFollowUpQueuePauseWhenEmpty(threadId);
  }
}

function formatFollowUpDrainError(reason: string): string {
  const formatted = formatUserFacingRequestError(reason);
  return formatted.length > 180 ? `${formatted.slice(0, 177)}…` : formatted;
}

function applyMainThreadRunDecisionEffects(
  input: Omit<ApplyThreadRunDecisionEffectsInput, "effects">,
): Promise<boolean> {
  return applyThreadRunDecisionEffects({
    ...input,
    effects: {
      updateThread: (threadId, patch) => updateThread(threadId, patch),
    },
  });
}

async function discardUnstartedAcpTurn(input: {
  threadId: string;
  reason: string;
  restorePrompt: string;
  attachments?: PromptImageAttachment[];
  recordedUserActivityLineId?: string;
  continuation?: boolean;
}): Promise<void> {
  const records = conversationStore.listConversationUserMessageRecords(input.threadId);
  const activityLineId =
    input.recordedUserActivityLineId?.trim() ||
    (!input.continuation ? records[records.length - 1]?.activityLineId : undefined);
  if (!activityLineId) {
    markThreadInterrupted(input.threadId, input.reason);
    return;
  }
  // Scheduled input belongs to a durable occurrence, not the user's composer.
  // Keep its message and history when ACP fails before producing any output.
  const scheduledMessage = conversationStore
    .conversationV2()
    .listUserMessages(input.threadId)
    .find(
      (message) =>
        message.messageId.startsWith("message_occ_") &&
        message.historyTarget?.activityLineId === activityLineId,
    );
  if (scheduledMessage) {
    const failureMessage = formatUserFacingRequestError(input.reason);
    updateThread(input.threadId, { status: "failed", message: failureMessage });
    emitThreadEvent(input.threadId, "thread.failed", failureMessage, "system", false);
    return;
  }
  const stored = conversationStore.getConversationUserMessageRecord(input.threadId, activityLineId);
  const restorePrompt = stored?.text ?? input.restorePrompt;
  const primaryAttachments = stored?.attachments?.length ? stored.attachments : (input.attachments ?? []);
  let restoreAttachments = await hydratePromptAttachmentsForComposerRestore(
    primaryAttachments,
    (attachment) => promptImageFileStore.readAttachmentData(attachment),
  );
  if (
    restoreAttachments.length === 0 &&
    input.attachments?.length &&
    primaryAttachments !== input.attachments
  ) {
    restoreAttachments = await hydratePromptAttachmentsForComposerRestore(input.attachments, (attachment) =>
      promptImageFileStore.readAttachmentData(attachment),
    );
  }
  try {
    conversationStore.discardThreadTurnFromActivityLine(input.threadId, activityLineId);
  } catch (error) {
    process.stderr.write(`[eco] ACP unstarted discard failed (${input.threadId}): ${errorMessage(error)}\n`);
    markThreadInterrupted(input.threadId, input.reason);
    return;
  }
  resetThreadRuntimeAfterHistoryRewrite(input.threadId);
  const clearThreadPrompt = shouldClearThreadPromptAfterUnstartedDiscard(
    conversationStore.listConversationUserMessageRecords(input.threadId).length,
  );
  if (clearThreadPrompt) {
    conversationStore.updateThreadPrompt(input.threadId, "");
  }
  const draftContextKey = `thread:${input.threadId}`;
  const spoolAttachments = toSpoolStageAttachments(restoreAttachments);
  const draftAttachments =
    spoolAttachments.length > 0
      ? await normalizeComposerDraftAttachments(draftContextKey, spoolAttachments)
      : [];
  // Message-dir images are no longer referenced after staging into the composer spool.
  await promptImageFileStore.deleteMessageActivity(input.threadId, activityLineId).catch((error) => {
    process.stderr.write(
      `[eco] ACP unstarted image cleanup failed (${input.threadId}): ${errorMessage(error)}\n`,
    );
  });
  const failureMessage = formatUserFacingRequestError(input.reason);
  const draft = conversationStore.saveComposerDraft(
    draftContextKey,
    restorePrompt,
    draftAttachments,
    failureMessage,
  );
  if (!draft && !restorePrompt && restoreAttachments.length === 0) {
    markThreadInterrupted(input.threadId, input.reason);
    return;
  }
  // Prefer spool paths (+ data) so a resend does not chase deleted message-dir files.
  const uiAttachments =
    draftAttachments.length > 0
      ? await hydratePromptAttachmentsForComposerRestore(draftAttachments, (attachment) =>
          promptImageFileStore.readAttachmentData(attachment),
        )
      : toSpoolStageAttachments(restoreAttachments);
  updateThread(input.threadId, { status: "failed", message: failureMessage });
  emitThreadEvent(input.threadId, "thread.unstarted_turn_discarded", failureMessage, "system", false, {
    composerRestore: {
      prompt: restorePrompt,
      // Include inline data so the renderer can build preview URLs immediately.
      ...(uiAttachments.length ? { attachments: uiAttachments } : {}),
      ...(draft?.revision ? { revision: draft.revision } : {}),
    },
    ...(clearThreadPrompt ? { threadPrompt: "" } : {}),
  });
  scheduleThreadRunProjectionUpdated(input.threadId, { streaming: false });
}

function dispatchClaudeThreadStart(input: ThreadCoreStartRunInput): void {
  requireThreadCore(input.thread, "claude", "start a Claude thread");
  const sessionMode = resolveSessionMode(input.thread.runtimeConfig);
  if (sessionMode === "ask") {
    void runAskThread(
      input.thread,
      input.workspace,
      input.runtimeConfig,
      input.prompt,
      undefined,
      undefined,
      input.attachments,
      input.roleRoutes,
    );
    return;
  }
  if (sessionMode === "plan") {
    void runPlanThread(
      input.thread,
      input.workspace,
      input.runtimeConfig,
      input.prompt,
      undefined,
      undefined,
      input.attachments,
      input.roleRoutes,
    );
    return;
  }
  void runCodingThreadAutonomous(
    input.thread,
    input.workspace,
    input.runtimeConfig,
    input.prompt,
    undefined,
    undefined,
    input.attachments,
    input.roleRoutes,
  );
}

async function startPiThreadRunFromCoordinator(input: ThreadCoreStartRunInput): Promise<void> {
  try {
    await threadRunPreparations.prepare(input.thread.id, (signal) =>
      startPreparedPiThreadRunFromCoordinator(input, signal),
    );
  } catch (error) {
    if (!(error instanceof ThreadRunPreparationCancelled)) throw error;
  }
}

async function startPreparedPiThreadRunFromCoordinator(
  input: ThreadCoreStartRunInput,
  signal: AbortSignal,
): Promise<void> {
  imageViewGateway.noteThreadPrompt(input.thread.id, input.prompt);
  const prepared = await resolvePiSessionResourcesForThread(input.thread.id, input.workspace.path);
  const agentRegistry = resolveAgentRuntimeConfigForThread(input.thread);
  signal.throwIfAborted();
  await startPiThreadRun(
    {
      thread: input.thread,
      workspace: input.workspace,
      runtimeConfig: input.runtimeConfig,
      prompt: input.prompt,
      ...(input.attachments?.length ? { attachments: input.attachments } : {}),
      roleRoutes: input.roleRoutes,
      continuation: false,
      skillPaths: prepared.skillPaths,
      ...(Object.keys(prepared.mcpServers).length > 0 ? { mcpServers: prepared.mcpServers } : {}),
      ...(prepared.appendSystemPrompt.length > 0 ? { appendSystemPrompt: prepared.appendSystemPrompt } : {}),
      ...(agentRegistry ? { agentRegistry } : {}),
    },
    piRuntimeOrchestrationDeps(),
  );
}

async function startPiThreadContinuation(input: StartThreadContinuationInput): Promise<ThreadContinueResult> {
  const prompt = input.prompt.trim();
  if (!prompt && !input.attachments?.length) {
    throw new Error("Message is required.");
  }
  const thread = conversationStore.getThread(input.threadId);
  if (!thread) {
    throw new Error("Thread was not found.");
  }
  requireThreadCore(thread, "pi", "continue with PI");
  if (thread.status === "running" || thread.status === "queued") {
    throw new Error("Wait for the current run to finish.");
  }

  const settings = getModelSettingsSnapshot();
  if (input.runtimeConfigInput) {
    const next = resolveContinueThreadRuntimeConfig(
      settings,
      thread.runtimeConfig,
      parseThreadRuntimeConfigInput(input.runtimeConfigInput),
    );
    roleRoutesForThreadConfig(settings, next);
    conversationStore.saveThreadRuntimeConfig(thread.id, next);
  }
  const activeThread = ensureThreadRuntimeConfig(conversationStore.getThread(thread.id) ?? thread);
  const threadConfig = activeThread.runtimeConfig;
  if (!threadConfig) {
    throw new Error("Thread runtime configuration is missing.");
  }
  const roleRoutes = roleRoutesForThreadConfig(settings, threadConfig);
  const runtime = resolveRuntimeConfigForThreadConfig(settings, threadConfig, roleRoutes);
  if (!runtime.ok) {
    throw new Error(runtime.reason);
  }

  input.preparationSignal?.throwIfAborted();
  updateThread(thread.id, { status: "running", message: "" });
  const workspace = await ensureWorkspace(thread.workspacePath);
  let attachmentsForRuntime = await loadPromptAttachmentsForRuntime(input.attachments);
  if (!input.skipRecordUserPrompt) {
    input.preparationSignal?.throwIfAborted();
    const recorded = await recordUserPrompt(
      thread.id,
      input.displayPrompt?.trim() || prompt,
      input.attachments,
      input.v2AcceptedMessageIds,
      { finalizeAcceptedMessages: false },
    );
    attachmentsForRuntime = await loadPromptAttachmentsForRuntime(
      recorded.storedAttachments ?? input.attachments,
    );
  }
  imageViewGateway.noteThreadPrompt(thread.id, prompt);
  const updated = ensureThreadRuntimeConfig(conversationStore.getThread(thread.id) ?? activeThread);
  const prepared = await resolvePiSessionResourcesForThread(updated.id, workspace.path);
  const agentRegistry = resolveAgentRuntimeConfigForThread(updated);
  input.preparationSignal?.throwIfAborted();
  await finalizeAcceptedV2Messages(input.threadId, input.v2AcceptedMessageIds ?? [], input.preparationSignal);
  const piRuntimePromise = startPiThreadRun(
    {
      thread: updated,
      workspace,
      runtimeConfig: { routes: runtime.routes },
      prompt,
      ...(attachmentsForRuntime?.length ? { attachments: attachmentsForRuntime } : {}),
      roleRoutes,
      continuation: true,
      skillPaths: prepared.skillPaths,
      ...(Object.keys(prepared.mcpServers).length > 0 ? { mcpServers: prepared.mcpServers } : {}),
      ...(prepared.appendSystemPrompt.length > 0 ? { appendSystemPrompt: prepared.appendSystemPrompt } : {}),
      ...(agentRegistry ? { agentRegistry } : {}),
      ...(input.preparedRuntimeDispatch ? { runtimeDispatch: input.preparedRuntimeDispatch } : {}),
    },
    piRuntimeOrchestrationDeps(),
  );
  if (input.preparedRuntimeDispatch) {
    observeConversationCommandRuntime({
      runtime: piRuntimePromise,
      v2: conversationStore.conversationV2(),
      conversationId: thread.id,
      prepared: input.preparedRuntimeDispatch,
      notStartedReason: "PI runtime ended before creating its durable run attempt.",
      onRejected: (error) => {
        process.stderr.write(`[eco] PI command runtime rejected (${thread.id}): ${errorMessage(error)}\n`);
      },
      onObserverError: (error) => {
        process.stderr.write(
          `[eco] PI command runtime observer failed (${thread.id}): ${errorMessage(error)}\n`,
        );
      },
    });
  } else {
    void piRuntimePromise.catch((error) => {
      process.stderr.write(`[eco] PI runtime rejected (${thread.id}): ${errorMessage(error)}\n`);
    });
  }
  return { thread: updated };
}

async function startAcpThreadContinuation(
  input: StartThreadContinuationInput,
): Promise<ThreadContinueResult> {
  // Read spool images before ACP CLI probe — same race as thread:start.
  const attachmentsForPrompt = await loadPromptAttachmentsForRuntime(input.attachments);
  const prompt = resolveAcpRunPrompt({
    prompt: input.prompt,
    ...(attachmentsForPrompt?.length ? { attachments: attachmentsForPrompt } : {}),
  });
  if (!prompt && !attachmentsForPrompt?.length) {
    throw new Error("Message is required.");
  }
  const thread = conversationStore.getThread(input.threadId);
  if (!thread) {
    throw new Error("Thread was not found.");
  }
  requireThreadCore(thread, "acp", "continue with ACP");
  await assertAcpCursorRunnableForMain();
  if (thread.status === "running" || thread.status === "queued") {
    throw new Error("Wait for the current run to finish.");
  }
  input.preparationSignal?.throwIfAborted();
  updateThread(thread.id, { status: "running", message: "" });
  const workspace = await ensureWorkspace(thread.workspacePath);
  let recordedUserActivityLineId: string | undefined;
  let attachmentsForRuntime = attachmentsForPrompt;
  if (!input.skipRecordUserPrompt) {
    input.preparationSignal?.throwIfAborted();
    const recorded = await recordUserPrompt(
      thread.id,
      input.displayPrompt?.trim() || prompt,
      attachmentsForPrompt ?? input.attachments,
      input.v2AcceptedMessageIds,
      { finalizeAcceptedMessages: false },
    );
    recordedUserActivityLineId = recorded.line?.rewindTarget?.activityLineId ?? recorded.line?.id;
    attachmentsForRuntime = await loadPromptAttachmentsForRuntime(
      recorded.storedAttachments ?? attachmentsForPrompt ?? input.attachments,
    );
  }
  const updated = conversationStore.getThread(thread.id) ?? thread;
  if (input.runtimeConfigInput) {
    const next = normalizeThreadRuntimeConfig(parseThreadRuntimeConfigInput(input.runtimeConfigInput));
    conversationStore.saveThreadRuntimeConfig(thread.id, next);
  }
  const activeThread = conversationStore.getThread(thread.id) ?? updated;
  input.preparationSignal?.throwIfAborted();
  await finalizeAcceptedV2Messages(input.threadId, input.v2AcceptedMessageIds ?? [], input.preparationSignal);
  const runtime = startAcpThreadRun(
    toAcpThreadStartRunInput({
      thread: activeThread,
      workspace,
      prompt,
      continuation: true,
      restorePrompt: input.displayPrompt?.trim() || input.prompt,
      ...(recordedUserActivityLineId ? { recordedUserActivityLineId } : {}),
      ...(attachmentsForRuntime?.length ? { attachments: attachmentsForRuntime } : {}),
      ...(input.preparedRuntimeDispatch ? { runtimeDispatch: input.preparedRuntimeDispatch } : {}),
    }),
    acpRuntimeOrchestrationDeps(),
  );
  if (input.preparedRuntimeDispatch) {
    observeConversationCommandRuntime({
      runtime,
      v2: conversationStore.conversationV2(),
      conversationId: thread.id,
      prepared: input.preparedRuntimeDispatch,
      notStartedReason: "ACP runtime ended before creating its durable run attempt.",
      onRejected: (error) => {
        process.stderr.write(`[eco] ACP command runtime rejected (${thread.id}): ${errorMessage(error)}\n`);
      },
      onObserverError: (error) => {
        process.stderr.write(
          `[eco] ACP command runtime observer failed (${thread.id}): ${errorMessage(error)}\n`,
        );
      },
    });
  } else {
    void runtime.catch((error) => {
      process.stderr.write(`[eco] ACP runtime rejected (${thread.id}): ${errorMessage(error)}\n`);
    });
  }
  return { thread: activeThread };
}

function acpRuntimeOrchestrationDeps(): import("./acp-runtime-run").AcpRuntimeOrchestrationDeps {
  const captureSession = (threadId: string, sessionId: string, cwd: string): void => {
    const trimmedSessionId = sessionId.trim();
    conversationStore.saveThreadCoreSession({
      threadId,
      coreKind: "acp",
      externalSessionId: trimmedSessionId,
      cwd,
    });
    emitThreadEvent(threadId, "thread.session_captured", "", "system", false, {
      externalSessionId: trimmedSessionId,
    });
  };
  return {
    requireThreadCore,
    resolveSessionMode,
    startActiveRun,
    createSessionPlan,
    runThreadRequestOnce: (threadId, phase, signal, run, retryIndex, runtimeDispatch) =>
      runThreadRequestOnce(threadId, phase, signal, () => run(), retryIndex, runtimeDispatch),
    notifyAcprAutoRetry: ({ threadId, attempt, maxAttempts }) => {
      emitThreadEvent(
        threadId,
        "thread.event",
        `上游连接中断，正在自动重试（${attempt}/${maxAttempts - 1}）…`,
        "system",
        false,
        {
          metadata: {
            activityOrigin: "sdk.upstream_error",
            acpAutoRetry: { attempt, maxAttempts },
          },
        },
      );
    },
    consumeEvents: ({ events, threadId, worktreePath, signal }) =>
      consumeSdkRunEvents({
        events,
        threadId,
        worktreePath,
        signal,
        onUsageRecorded: () => {},
        captureSession: async (id, event, cwd) => {
          if (event.type !== "session.captured" || !isRecord(event.payload)) return;
          const sessionId = typeof event.payload.sessionId === "string" ? event.payload.sessionId.trim() : "";
          if (sessionId) {
            captureSession(id, sessionId, cwd);
          }
        },
        onEvent: async (event) => {
          if (event.type === "todo.updated" && isAcpPlanTodoPayload(event.payload)) {
            applyAcpPlanProgress({
              threadId,
              entries: event.payload.entries,
              services: {
                listTodos: (id) => conversationStore.listCoderTodos(id),
                replaceTodos: (id, todos) => conversationStore.replaceCoderTodos(id, todos),
                emitTodoList,
              },
            });
            return;
          }
          if (event.type === "todo.updated" && isAcpUpdateTodosPayload(event.payload)) {
            applyAcpUpdateTodos({
              threadId,
              todos: event.payload.todos,
              merge: event.payload.merge === true,
              services: {
                listTodos: (id) => conversationStore.listCoderTodos(id),
                replaceTodos: (id, todos) => conversationStore.replaceCoderTodos(id, todos),
                emitTodoList,
              },
            });
            return;
          }
          if (event.type !== "session.title" || !isRecord(event.payload)) return;
          const title = typeof event.payload.title === "string" ? event.payload.title : "";
          applyAcpSessionTitle(threadId, title);
        },
        emitActivity: emitSdkStreamActivity,
      }),
    updateThread,
    markInterrupted: markThreadInterrupted,
    finalizeCleanup: async (threadId) => {
      await finalizeMainThreadRunCleanup({
        threadId,
        worktreePath: resolveThreadWorktreePath(threadId),
        idleFallbackMessage: "",
      });
    },
    captureSession,
    getThreadCoreSession: (threadId) => conversationStore.getThreadCoreSession(threadId),
    resolveAcpCursorEnv: () => {
      const apiKey = workflowSettingsStore.get().acpCursorApiKey?.trim();
      return apiKey ? { CURSOR_API_KEY: apiKey } : {};
    },
    resolveAcpMcpServers: async ({ threadId, workspacePath }) => {
      const prepared = await resolvePiSessionResourcesForThread(threadId, workspacePath);
      return toAcpMcpServers(prepared.mcpServers);
    },
    resolveAcpSystemPromptAppend: ({ threadId }) =>
      appendBrowserPrompt(mcpHubGateway.getThreadPromptAppend(threadId), CONTEXT_REFERENCE_PROMPT),
    resolvePromptImagesForMainContext,
    resolveAcpCreatePlanHandler: ({ threadId, workspacePath, userPrompt }) => {
      return async (request) => {
        const overview =
          typeof request.overview === "string" && request.overview.trim()
            ? request.overview.trim()
            : typeof request.name === "string" && request.name.trim()
              ? request.name.trim()
              : "";
        const planPayload = {
          userPrompt: userPrompt.trim() || userPrompt,
          analysis: overview,
          plan: request.plan,
          deferredExitPlanToolUseId: request.toolCallId,
        };
        const approvalRequest: PlanApprovalRequest = {
          toolUseId: request.toolCallId,
          threadId,
          userPrompt: planPayload.userPrompt,
          analysis: planPayload.analysis,
          plan: planPayload.plan,
        };
        // Park the bridge before any UI emit so approve cannot race an empty map.
        const decisionPromise = registerPendingPlanApproval(threadId, approvalRequest);
        captureThreadPlanReady({
          threadId,
          workspacePath,
          worktreePath: workspacePath,
          routesJson: "[]",
          awaitingPlanMessage: "",
          payload: planPayload,
        });
        updateThread(threadId, { status: "awaiting_plan", message: "" });
        emitThreadEvent(threadId, "plan_approval.requested", "计划已提交，等待你确认。", "main", false, {
          plan: planPayload,
          planApproval: approvalRequest,
        });
        const decision = await decisionPromise;
        if (decision === "approved") {
          emitThreadEvent(threadId, "plan_approval.approved", "已批准计划。", "user", false, {
            planApproval: approvalRequest,
          });
          return { outcome: "accepted" as const };
        }
        conversationStore.clearPendingPlan(threadId);
        emitThreadEvent(threadId, "plan_approval.denied", "计划忽略", "user", false, {
          planApproval: approvalRequest,
        });
        return { outcome: "rejected" as const, reason: "user dismissed plan" };
      };
    },
    resolveAcpAskQuestionHandler: ({ threadId }) => {
      return createAcpAskQuestionHandler(threadId, {
        updateThreadRunning: () => {
          updateThread(threadId, { status: "running", message: "" });
        },
        emit: (type, message, clarification, toolStatus) => {
          emitThreadEvent(threadId, type, message, "main", false, {
            ...(type === "clarification.requested" ? { clarification } : {}),
            tool: buildClarificationToolMetadata(clarification.toolUseId, toolStatus),
          });
        },
      });
    },
    resolveAcpPermissionHandler: ({ threadId, workspacePath }) => {
      return createAcpPermissionHandler(threadId, {
        getBashReviewMode: () => {
          const thread = conversationStore.getThread(threadId);
          if (!thread) return "always";
          return ensureThreadRuntimeConfig(thread).runtimeConfig?.bashReviewMode ?? "always";
        },
        getBrowserOpenApprovalMode: () => browserSettingsStore.get().openApprovalMode,
        getComputerUseActionApprovalMode: () => computerUseSettingsStore.get().actionApprovalMode,
        getWebSearchApprovalMode: () => integratedWebSearchSettingsStore.get().approvalMode,
        getCwd: () =>
          activeRunRuntimeState.worktreePlan(threadId)?.worktreePath ||
          conversationStore.getThread(threadId)?.sdkCwd ||
          conversationStore.getThread(threadId)?.workspacePath ||
          workspacePath,
        getWorkspacePath: () => conversationStore.getThread(threadId)?.workspacePath || workspacePath,
        getPlannerAgentId: () => agentLifecycle.usagePlannerAgentId(threadId),
        getRememberPrefixes: () => activeRunRuntimeState.bashRememberPrefixes(threadId),
        evaluateConfirmation: evaluateThreadToolConfirmation,
        reviewApproval: (request, tool) => reviewThreadToolApproval(threadId, request, tool, "acp"),
        log: (phase, payload) => logUpstream(phase, payload),
        registerPending: registerPendingBashApproval,
        rememberPrefix: (tid, command) =>
          activeRunRuntimeState.rememberBashPrefix(tid, deriveBashApprovalRememberPrefix(command)),
        emit: (type, message, request) => {
          emitThreadEvent(threadId, type, message, "tool", false, bashApprovalEventExtras(request, type));
        },
      });
    },
    hasStoredPendingPlan: (threadId) => Boolean(conversationStore.getPendingPlan(threadId)),
    releasePlanBridgeKeepPending: cancelPlanApprovalsForThreadKeepPending,
    discardUnstartedTurn: discardUnstartedAcpTurn,
    applyRunDecision: async ({ threadId, decision }) => {
      await applyMainThreadRunDecisionEffects({
        threadId,
        decision,
        onCancelled: async (_reason) => {
          const thread = conversationStore.getThread(threadId);
          const plan = resolveWorktreePlan(
            thread?.workspacePath ?? "",
            threadId,
            resolveThreadWorktreePath(threadId),
          );
          await handleRunCancelled(threadId, plan);
        },
        onFailed: (reason) => {
          markThreadInterrupted(threadId, reason);
        },
        onCompleted: () => {
          updateThread(threadId, { status: "completed", message: "" });
        },
      });
    },
    errorMessage,
    loadSessionFailedMessage: (detail) =>
      mainText("native.acpLoadSessionFailed", {
        detail: detail.trim() ? `: ${detail.trim()}` : "",
      }),
    cannotResumeWithoutSessionMessage: () => mainText("native.acpCannotResumeWithoutSessionId"),
    threadHasPriorAgentOutput: (threadId) =>
      threadHasPriorAgentOutput(
        conversationStore.listActivityLines(threadId).map((line) => ({
          role: line.role,
          message: line.message,
        })),
      ),
  };
}

function piRuntimeOrchestrationDeps(): import("./pi-runtime-run").PiRuntimeOrchestrationDeps {
  return {
    ecoDataDir: app.getPath("userData"),
    requireThreadCore,
    resolveSessionMode,
    startActiveRun,
    createSessionPlan,
    resolveThreadWorktree: async (workspace: WorkspaceInfo, threadId: string) => {
      if (resolveSessionMode(conversationStore.getThread(threadId)?.runtimeConfig) === "ask") {
        return {
          worktreePlan: createSessionPlan(workspace.path, threadId),
          cwd: workspace.path,
        };
      }
      return resolveThreadWorktree(workspace, threadId);
    },
    runThreadRequestOnce: (
      threadId: string,
      phase: "execution" | "ask" | "planning" | "continuation",
      signal: AbortSignal,
      run: (context: RunAttemptContext) => Promise<RequestAttemptResult>,
      retryIndex?: number,
      runtimeDispatch?: PreparedConversationCommandDispatch,
    ) => runThreadRequestOnce(threadId, phase, signal, run, retryIndex, runtimeDispatch),
    resolveRuntimeConfigForThreadId: (threadId: string) => resolveRuntimeConfigForThreadId(threadId),
    recordRouteFingerprint: recordThreadRouteFingerprint,
    startRuntimeProxy: (routes, attachments, context) => startRuntimeProxy(routes, attachments, context),
    resolvePromptImagesForMainContext,
    getGlobalContextWindowLimit: () => workflowSettingsStore.get().contextWindowLimitTokens,
    consumeEvents: async (input: {
      events: AsyncIterable<AgentEvent>;
      threadId: string;
      worktreePath: string;
      signal: AbortSignal;
    }) =>
      consumeSdkRunEvents({
        events: input.events,
        threadId: input.threadId,
        worktreePath: input.worktreePath,
        signal: input.signal,
        onUsageRecorded: onPiUsageRecordedEvent,
        captureSession: async (threadId, event) => {
          if (
            event.type === "file.checkpoint" &&
            isRecord(event.payload) &&
            event.payload.source === "pi" &&
            typeof event.payload.activityLineId === "string" &&
            typeof event.payload.userMessageId === "string"
          ) {
            conversationStore.bindPiPromptEntry(
              threadId,
              event.payload.activityLineId,
              event.payload.userMessageId,
            );
          }
        },
        emitActivity: emitSdkStreamActivity,
      }),
    applyRunDecision: async (input: {
      threadId: string;
      decision: RequestAttemptResult;
      mode: "agent" | "plan" | "ask";
      hasPendingPlan: boolean;
    }) => {
      const forcedActive = Boolean(forcedPlanDelegationStore.get(input.threadId));
      // A forced delegation intentionally keeps the pending plan until it settles, so the
      // outcome resolver must not mistake that retained plan for a fresh plan capture.
      const pendingPlanForOutcome = forcedActive ? false : input.hasPendingPlan;
      const decision =
        input.mode === "ask"
          ? resolveAskRunOutcome(input.decision)
          : input.mode === "plan"
            ? resolvePlanningRunOutcome(input.decision, {
                hasPendingPlan: pendingPlanForOutcome,
              })
            : resolveAutonomousRunOutcome(input.decision, {
                hasPendingPlan: pendingPlanForOutcome,
                planCaptured: pendingPlanForOutcome,
              });
      await applyMainThreadRunDecisionEffects({
        threadId: input.threadId,
        decision,
        onCancelled: async (_reason) => {
          if (forcedActive) {
            settleForcedPlanDelegation(input.threadId, {
              ok: false,
              reason: "cancelled by user",
            });
          }
          const plan = resolveWorktreePlan(
            conversationStore.getThread(input.threadId)?.workspacePath ?? "",
            input.threadId,
            resolveThreadWorktreePath(input.threadId),
          );
          await handleRunCancelled(input.threadId, plan);
        },
        onFailed: (reason) => {
          if (forcedActive) {
            settleForcedPlanDelegation(input.threadId, { ok: false, reason });
          }
          markThreadInterrupted(input.threadId, reason);
        },
        onCompleted: () => {
          if (forcedActive) {
            const settled = settleForcedPlanDelegation(input.threadId, {
              ok: true,
            });
            if (settled?.outcome === "failed") {
              updateThread(input.threadId, {
                status: "awaiting_plan",
                message: `${planDelegationFailurePrefix}${settled.reason ?? "子代理未完成计划。"}`,
              });
              return;
            }
            conversationStore.clearPendingPlan(input.threadId);
            emitThreadEvent(input.threadId, "thread.plan_cleared", "计划已进入执行阶段。", "system");
          }
          updateThread(input.threadId, {
            status: "completed",
            message: "",
          });
        },
      });
    },
    finalizeCleanup: async (threadId: string) => {
      const worktreePath = resolveThreadWorktreePath(threadId);
      await finalizeMainThreadRunCleanup({
        threadId,
        worktreePath,
        cancelClarificationsReason: "run finished",
      });
    },
    markInterrupted: (threadId: string, reason: string) => {
      if (forcedPlanDelegationStore.get(threadId)) {
        settleForcedPlanDelegation(threadId, { ok: false, reason });
      }
      markThreadInterrupted(threadId, reason);
    },
    updateThread,
    captureSession: (
      threadId: string,
      sessionId: string,
      cwd: string,
      metadata?: {
        sessionFile?: string;
        identityFingerprint?: string;
        mcpFingerprint?: string;
      },
    ) => {
      conversationStore.saveThreadCoreSession({
        threadId,
        coreKind: "pi",
        externalSessionId: sessionId,
        cwd,
        ...(metadata && Object.keys(metadata).length > 0
          ? {
              metadata: {
                ...(metadata.sessionFile ? { sessionFile: metadata.sessionFile } : {}),
                ...(metadata.identityFingerprint
                  ? { identityFingerprint: metadata.identityFingerprint }
                  : {}),
                ...(metadata.mcpFingerprint !== undefined ? { mcpFingerprint: metadata.mcpFingerprint } : {}),
              },
            }
          : {}),
      });
    },
    getThreadCoreSession: (threadId: string) => conversationStore.getThreadCoreSession(threadId),
    errorMessage,
    conversationStore,
    lifecycle: agentLifecycle,
    metricsRegistry: subagentMetricsRegistry,
    getBashReviewMode: (threadId) => {
      const thread = conversationStore.getThread(threadId);
      return thread
        ? (ensureThreadRuntimeConfig(thread).runtimeConfig?.bashReviewMode ?? "always")
        : "always";
    },
    getToolPermissionHandler: (threadId, skipExecutionApprovals) =>
      createThreadToolPermissionHandler(threadId, "execution", skipExecutionApprovals),
    capturePlanReady: (input) =>
      captureThreadPlanReady({
        threadId: input.threadId,
        workspacePath: input.workspacePath,
        worktreePath: input.worktreePath,
        routesJson: JSON.stringify(resolveRoleRoutesForThread(input.threadId)),
        payload: input.payload,
        awaitingPlanMessage: "",
      }),
    getIntegratedWebSearchRuntime: () => {
      const settings = integratedWebSearchSettingsStore.get();
      const apiKey = integratedWebSearchSettingsStore.getApiKey();
      return apiKey ? { settings, apiKey } : { settings };
    },
  };
}

function onPiUsageRecordedEvent(threadId: string, event: AgentEventLike & { id: string }): void {
  const payload = event.payload;
  if (!isRecord(payload) || payload.source !== "pi") {
    return;
  }
  const usage = parsePiUsage(
    isRecord(payload.usage)
      ? {
          input: Number(payload.usage.input_tokens ?? payload.usage.input ?? 0),
          output: Number(payload.usage.output_tokens ?? payload.usage.output ?? 0),
          cacheRead: Number(payload.usage.cache_read_input_tokens ?? payload.usage.cacheRead ?? 0),
          cacheWrite: Number(payload.usage.cache_creation_input_tokens ?? payload.usage.cacheWrite ?? 0),
          cost: {
            total:
              typeof payload.total_cost_usd === "number"
                ? payload.total_cost_usd
                : typeof payload.totalCostUsd === "number"
                  ? payload.totalCostUsd
                  : undefined,
          },
        }
      : null,
    typeof payload.model === "string" ? payload.model : undefined,
  );
  if (!usage) {
    return;
  }
  const billingRequest: SingleUsageBillingRequest = {
    threadId,
    role: typeof event.role === "string" && event.role.trim() ? event.role.trim() : "main",
    source: "pi",
    usage,
    sourceEventId: event.id,
    updateContext: true,
    ...(typeof event.agentId === "string" && event.agentId.trim() && event.role && event.role !== "main"
      ? { agentId: event.agentId.trim() }
      : {}),
  };
  if (usage.modelId) {
    billingRequest.modelId = usage.modelId;
  }
  if (usage.totalCostUsd !== undefined) {
    billingRequest.sourceReportedCostUsd = usage.totalCostUsd;
  }
  const runAttemptId = agentLifecycle.usageRunAttemptId(threadId);
  if (runAttemptId) {
    billingRequest.runAttemptId = runAttemptId;
  }
  const plannerAgentId = agentLifecycle.usagePlannerAgentId(threadId);
  if (plannerAgentId) {
    billingRequest.plannerAgentId = plannerAgentId;
  }
  const billingRole = typeof event.role === "string" && event.role.trim() ? event.role.trim() : "main";
  const logicalRequestId = resolvePiUsageLogicalRequestId(threadLiveRequestRegistry, threadId, {
    role: billingRole,
    ...(typeof event.agentId === "string" && event.agentId.trim() ? { agentId: event.agentId.trim() } : {}),
  });
  if (logicalRequestId) {
    billingRequest.logicalRequestId = logicalRequestId;
  }
  usageLedgerCoordinator.trackUsageUpdate(
    threadId,
    processUsageBilling(billingRequest).then(
      () => undefined,
      (error) => {
        process.stderr.write(`[eco] PI usage billing failed: ${errorMessage(error)}\n`);
      },
    ),
  );
}

async function startCodexThreadContinuation(
  input: StartThreadContinuationInput,
): Promise<ThreadContinueResult> {
  const prompt = input.prompt.trim();
  if (!input.codexEmptyInput && !prompt && !input.attachments?.length) {
    throw new Error("Message is required.");
  }
  const thread = conversationStore.getThread(input.threadId);
  if (!thread) {
    throw new Error("Thread was not found.");
  }
  requireThreadCore(thread, "codex", "continue with Codex");
  if (thread.status === "running" || thread.status === "queued") {
    throw new Error("Wait for the current run to finish.");
  }
  const binding = conversationStore.getThreadCoreSession(thread.id);
  const hasBinding = binding?.coreKind === "codex" && Boolean(binding.externalSessionId.trim());
  if (input.codexEmptyInput && !hasBinding) {
    throw new Error("Codex 会话绑定已丢失，无法继续原有上下文。");
  }
  if (input.codexEmptyInput) {
    await ensureCodexControlPlaneClient();
    const status = await queryCodexThreadStatusForEcoThread(thread.id);
    if (status !== "idle" && status !== "systemError" && status !== "notLoaded") {
      throw new Error(`无法确认 Codex 会话处于可继续状态：${status ?? "missing"}。`);
    }
  }
  const strategy = resolveCodexContinueStrategy({
    hasBinding,
    hasRewindTarget: Boolean(input.rewindTarget),
  });
  if (strategy.kind === "error") {
    throw new Error(strategy.message);
  }
  const continuation = strategy.kind === "resume";
  if (strategy.kind === "cold_start") {
    process.stderr.write(
      `[eco-codex] continue cold-start thread=${thread.id} reason=missing_codex_binding\n`,
    );
  }
  const settings = getModelSettingsSnapshot();
  if (input.runtimeConfigInput) {
    const next = resolveContinueThreadRuntimeConfig(
      settings,
      thread.runtimeConfig,
      parseThreadRuntimeConfigInput(input.runtimeConfigInput),
    );
    roleRoutesForThreadConfig(settings, next);
    conversationStore.saveThreadRuntimeConfig(thread.id, next);
  }
  const activeThread = ensureThreadRuntimeConfig(conversationStore.getThread(thread.id) ?? thread);
  const threadConfig = activeThread.runtimeConfig;
  if (!threadConfig) {
    throw new Error("Thread runtime configuration is missing.");
  }
  const roleRoutes = roleRoutesForThreadConfig(settings, threadConfig);
  const runtime = resolveRuntimeConfigForThreadConfig(settings, threadConfig, roleRoutes);
  if (!runtime.ok) {
    throw new Error(runtime.reason);
  }

  // Cold start has no Codex remote history — carry original task + follow-up into the first turn.
  const runPrompt = input.codexEmptyInput
    ? ""
    : strategy.kind === "cold_start"
      ? buildThreadTurnPrompt(activeThread.prompt, prompt)
      : prompt;

  input.preparationSignal?.throwIfAborted();
  updateThread(thread.id, { status: "running", message: "" });
  const workspace = await ensureWorkspace(thread.workspacePath);
  // Prefer finishing fork+local prune before the rewrite IPC returns (clean feed on refresh).
  // notLoaded threads need prepareCodexRuntime first — defer those to onPrepared.
  let rewindCompletedEarly = false;
  let attachmentsForRuntime: PromptImageAttachment[] | undefined;
  if (input.rewindTarget) {
    const rewindResult = await tryPrepareCodexThreadRewindEarly({
      threadId: thread.id,
      prompt,
      ...(input.attachments !== undefined ? { attachments: input.attachments } : {}),
      target: input.rewindTarget,
      ...(input.displayPrompt?.trim() ? { displayPrompt: input.displayPrompt.trim() } : {}),
    });
    rewindCompletedEarly = rewindResult.completedEarly;
    attachmentsForRuntime = await loadPromptAttachmentsForRuntime(
      rewindResult.storedAttachments ?? input.attachments,
    );
  } else if (!input.skipRecordUserPrompt) {
    input.preparationSignal?.throwIfAborted();
    const recorded = await recordUserPrompt(
      thread.id,
      input.displayPrompt?.trim() || prompt,
      input.attachments,
      input.v2AcceptedMessageIds,
      { finalizeAcceptedMessages: false },
    );
    attachmentsForRuntime = await loadPromptAttachmentsForRuntime(
      recorded.storedAttachments ?? input.attachments,
    );
  } else {
    attachmentsForRuntime = await loadPromptAttachmentsForRuntime(input.attachments);
  }
  const updated = ensureThreadRuntimeConfig(conversationStore.getThread(thread.id) ?? activeThread);
  input.preparationSignal?.throwIfAborted();
  await finalizeAcceptedV2Messages(input.threadId, input.v2AcceptedMessageIds ?? [], input.preparationSignal);
  const codexRuntimePromise = startCodexThreadRun({
    thread: updated,
    workspace,
    runtimeConfig: { routes: runtime.routes },
    prompt: runPrompt,
    ...(attachmentsForRuntime?.length ? { attachments: attachmentsForRuntime } : {}),
    roleRoutes,
    continuation,
    ...(!rewindCompletedEarly && input.rewindTarget ? { rewindTarget: input.rewindTarget } : {}),
    ...(input.displayPrompt?.trim() ? { displayPrompt: input.displayPrompt.trim() } : {}),
    ...(input.preparedRuntimeDispatch ? { runtimeDispatch: input.preparedRuntimeDispatch } : {}),
  });
  if (input.preparedRuntimeDispatch) {
    observeConversationCommandRuntime({
      runtime: codexRuntimePromise,
      v2: conversationStore.conversationV2(),
      conversationId: thread.id,
      prepared: input.preparedRuntimeDispatch,
      notStartedReason: "Codex runtime ended before creating its durable run attempt.",
      onRejected: (error) => {
        process.stderr.write(`[eco] Codex command runtime rejected (${thread.id}): ${errorMessage(error)}\n`);
      },
      onObserverError: (error) => {
        process.stderr.write(
          `[eco] Codex command runtime observer failed (${thread.id}): ${errorMessage(error)}\n`,
        );
      },
    });
  } else {
    void codexRuntimePromise.catch((error) => {
      process.stderr.write(`[eco] Codex runtime rejected (${thread.id}): ${errorMessage(error)}\n`);
    });
  }
  return { thread: updated };
}

/**
 * Fork + prune when the Codex thread is already loaded (idle). Returns false when the
 * thread is notLoaded / unreadable and must wait for prepareCodexRuntime in onPrepared.
 */
async function tryPrepareCodexThreadRewindEarly(input: {
  threadId: string;
  prompt: string;
  displayPrompt?: string;
  attachments?: PromptImageAttachment[];
  target: ThreadActivityRewindTarget;
}): Promise<{
  completedEarly: boolean;
  storedAttachments?: PromptImageAttachment[];
}> {
  const targetItemId = input.target.userMessageId?.trim();
  if (!targetItemId) {
    throw new Error("该节点缺少当前 Codex 消息 id，无法安全 fork。");
  }
  await ensureCodexControlPlaneClient();
  const status = await queryCodexThreadStatusForEcoThread(input.threadId);
  if (status === undefined || status === "notLoaded") {
    return { completedEarly: false };
  }
  if (status !== "idle" && status !== "systemError") {
    throw new Error(
      `Codex fork requires an idle thread; current status is ${status}. Wait for the active turn to finish, then retry.`,
    );
  }
  await forkCodexThreadForEcoThread({
    ecoThreadId: input.threadId,
    targetItemId,
  });
  const recorded = await recordUserPrompt(
    input.threadId,
    input.displayPrompt?.trim() || input.prompt,
    input.attachments,
  );
  scheduleThreadRunProjectionUpdated(input.threadId, { streaming: false });
  return {
    completedEarly: true,
    ...(recorded.storedAttachments?.length ? { storedAttachments: recorded.storedAttachments } : {}),
  };
}

async function startCodexThreadRun(
  input: ThreadCoreStartRunInput & {
    continuation: boolean;
    rewindTarget?: ThreadActivityRewindTarget;
    displayPrompt?: string;
    runtimeDispatch?: PreparedHistoryRuntimeDispatch;
  },
): Promise<void> {
  requireThreadCore(input.thread, "codex", input.continuation ? "continue with Codex" : "start Codex");
  const mode = resolveSessionMode(input.thread.runtimeConfig);
  const controller = new AbortController();
  startActiveRun(input.thread.id, {
    controller,
    worktreePlan: createSessionPlan(input.workspace.path, input.thread.id),
  });

  let worktreePlan = createSessionPlan(input.workspace.path, input.thread.id);
  let cwd = input.workspace.path;
  try {
    if (mode !== "ask") {
      const resolved = await resolveThreadWorktree(input.workspace, input.thread.id);
      worktreePlan = resolved.worktreePlan;
      cwd = resolved.cwd;
      activeRunRuntimeState.setWorktreePlan(input.thread.id, worktreePlan);
    }

    const codexSkills = await resolveCodexThreadSkills(input.thread.id, cwd);
    const threadRuntimeForIntegrations = ensureThreadRuntimeConfig(
      conversationStore.getThread(input.thread.id) ?? input.thread,
    ).runtimeConfig;
    const sessionEcoBrowserEnabled =
      browserSettingsStore.get().agentIntegrationEnabled &&
      integrationEnabled(threadRuntimeForIntegrations?.integrationsEnabled, "browser");
    const sessionComputerUseEnabled =
      computerUseSettingsStore.get().agentIntegrationEnabled &&
      integrationEnabled(threadRuntimeForIntegrations?.integrationsEnabled, "computerUse");
    const sessionImageGenerationEnabled =
      imageGenerationStore.getSettings().enabled &&
      integrationEnabled(threadRuntimeForIntegrations?.integrationsEnabled, "imageGeneration");
    const sessionTtsEnabled =
      ttsStore.getSettings().enabled &&
      integrationEnabled(threadRuntimeForIntegrations?.integrationsEnabled, "tts");
    const codexAgentRegistry = resolveAgentRuntimeConfigForThreadId(input.thread.id);
    const codexPlannerRoute = resolveRoleRoutesForThread(input.thread.id).find(
      (route) => route.role === "main",
    );
    const integratedWebSearchSettings = integratedWebSearchSettingsStore.get();
    const integratedWebSearchApiKey = integratedWebSearchSettings.enabled
      ? integratedWebSearchSettingsStore.getApiKey()
      : undefined;
    const codexWebSearchPlan = resolveCodexThreadWebSearchPlan({
      mainProviderId: codexPlannerRoute?.providerId,
      networkWebSearch: codexAgentRegistry
        ? materializeEcoToolPolicy(codexAgentRegistry.orchestration.mainAgent.tools).network?.webSearch
        : undefined,
      ...(codexPlannerRoute?.manualSpec ? { plannerManualSpec: codexPlannerRoute.manualSpec } : {}),
      integratedSettings: integratedWebSearchSettings,
      ...(integratedWebSearchApiKey ? { integratedApiKey: integratedWebSearchApiKey } : {}),
    });
    const sessionIntegratedWebSearchEnabled = codexWebSearchPlan.backend === "integrated";
    const ecoBrowserSkillFile = sessionEcoBrowserEnabled
      ? resolveEcoAgentBrowserSkillFileForCodex()
      : undefined;
    if (sessionEcoBrowserEnabled && !ecoBrowserSkillFile) {
      throw new Error("本会话已开启内置浏览器，但未找到打包的 eco-agent-browser skill 文件。");
    }
    const outcome = await runThreadRequestOnce(
      input.thread.id,
      runAttemptPhaseFromThreadMode(mode === "plan" ? "planning" : mode === "ask" ? "ask" : "execution"),
      controller.signal,
      async () => {
        const mainPrompt = await resolvePromptImagesForMainContext({
          threadId: input.thread.id,
          prompt: input.prompt,
          ...(input.attachments?.length ? { attachments: input.attachments } : {}),
          ...(input.roleRoutes ? { routesOverride: input.roleRoutes } : {}),
          signal: controller.signal,
        });
        return runCodexThreadRequest({
          threadId: input.thread.id,
          signal: controller.signal,
          resolveRuntimeConfig: () => resolveRuntimeConfigForThreadId(input.thread.id, input.roleRoutes),
          resolveAgentRegistry: () => resolveAgentRuntimeConfigForThreadId(input.thread.id),
          resolveSystemPromptAppend: () => {
            let append = requireBrowserHost().getAgentPromptAppend(sessionEcoBrowserEnabled, input.thread.id);
            if (sessionComputerUseEnabled) {
              append = appendBrowserPrompt(append, computerUseGateway.getAgentPromptAppend(true));
            }
            if (sessionImageGenerationEnabled) {
              append = appendBrowserPrompt(
                append,
                buildImageGenerationPromptAppend(imageGenerationStore.getActiveClientConfig()),
              );
            }
            if (sessionTtsEnabled) {
              append = appendBrowserPrompt(append, buildTtsPromptAppend(ttsStore.getActiveClientConfig()));
            }
            append = appendBrowserPrompt(append, SCHEDULING_PROMPT);
            append = appendBrowserPrompt(append, CONTEXT_REFERENCE_PROMPT);
            append = appendBrowserPrompt(append, buildImageViewPromptAppend());
            append = appendBrowserPrompt(append, buildImageDisplayPromptAppend());
            if (centerServerClient.getHtmlHostingCapability().available) {
              append = appendBrowserPrompt(append, buildHtmlHostPromptAppend());
            }
            if (sessionIntegratedWebSearchEnabled) {
              append = appendBrowserPrompt(
                append,
                buildIntegratedWebSearchPromptAppend(
                  integratedWebSearchProviderLabel(integratedWebSearchSettingsStore.get().provider),
                ),
              );
            }
            append = appendBrowserPrompt(append, mcpHubGateway.getThreadPromptAppend(input.thread.id));
            // Codex registers this thread's Hub under a per-thread server
            // name (shared app-server global pool + per-thread bearer token),
            // so rewrite the fixed `mcp__eco_mcp__*` names emitted by the Hub
            // usage builders to the exact names Codex will register.
            return rewriteEcoMcpHubPromptForCodexServer(append, codexHubServerName(input.thread.id));
          },
          resolveWebSearchOverride: () =>
            codexWebSearchPlan.backend === "native" ? undefined : ("disabled" as const),
          resolveExecutionConfirmationMode: () =>
            ensureThreadRuntimeConfig(conversationStore.getThread(input.thread.id) ?? input.thread)
              .runtimeConfig?.bashReviewMode ?? "always",
          resolveSubagentAvailability: () =>
            ensureThreadRuntimeConfig(conversationStore.getThread(input.thread.id) ?? input.thread)
              .runtimeConfig?.subagentEnabled,
          resolveMcpServers: async () => {
            const configuredMcp = mcpStore.buildSdkConfig();
            const threadMcpKeys = resolveCodexThreadMcpServerKeys(input.thread.id);
            const hubMcpKeys = threadMcpKeys.filter(
              (key) => Object.hasOwn(configuredMcp.mcpServers, key) && !key.startsWith("eco_"),
            );
            const codexHubName = codexHubServerName(input.thread.id);
            const builtinHubServers: string[] = [];
            const registerBuiltin = (name: string, sdkEntry: Record<string, unknown> | undefined): void => {
              if (!sdkEntry) return;
              mcpHubGateway.registerThreadServerEntry({
                name,
                threadId: input.thread.id,
                sdkEntry,
              });
              builtinHubServers.push(name);
            };
            if (sessionEcoBrowserEnabled) {
              const browserInject = await requireBrowserHost().resolveAgentBrowserMcpInjection({
                threadId: input.thread.id,
                sessionEnabled: true,
              });
              if (!browserInject.enabled || !browserInject.codexServer || !browserInject.sdkEntry) {
                throw new Error(
                  `本会话已开启内置浏览器，但不可用：${browserInject.unavailableReason ?? "未知原因"}`,
                );
              }
              registerBuiltin(ECO_AGENT_BROWSER_MCP_SERVER, browserInject.sdkEntry);
            }
            if (sessionImageGenerationEnabled) {
              const imageInject = await imageGenerationGateway.resolveInjection({
                threadId: input.thread.id,
                sessionEnabled: true,
              });
              if (!imageInject.enabled || !imageInject.codexServer || !imageInject.sdkEntry) {
                throw new Error(
                  `本会话已开启创意绘画，但不可用：${imageInject.unavailableReason ?? "未知原因"}`,
                );
              }
              registerBuiltin(ECO_IMAGE_GENERATION_MCP_SERVER, imageInject.sdkEntry);
            }
            if (sessionTtsEnabled) {
              const ttsInject = await ttsGateway.resolveInjection({
                threadId: input.thread.id,
                sessionEnabled: true,
              });
              if (!ttsInject.enabled || !ttsInject.codexServer || !ttsInject.sdkEntry) {
                throw new Error(
                  `本会话已开启语音生成，但不可用：${ttsInject.unavailableReason ?? "未知原因"}`,
                );
              }
              registerBuiltin(ECO_TTS_MCP_SERVER, ttsInject.sdkEntry);
            }
            if (sessionComputerUseEnabled) {
              const computerUseInject = await computerUseGateway.resolveInjection({
                threadId: input.thread.id,
                sessionEnabled: true,
              });
              if (
                !computerUseInject.enabled ||
                !computerUseInject.codexServer ||
                !computerUseInject.sdkEntry
              ) {
                throw new Error(
                  `本会话已开启电脑操控，但不可用：${computerUseInject.unavailableReason ?? "未知原因"}`,
                );
              }
              registerBuiltin(ECO_COMPUTER_USE_MCP_SERVER, computerUseInject.sdkEntry);
            }
            if (sessionIntegratedWebSearchEnabled) {
              const webSearchInject = await integratedWebSearchGateway.resolveInjection({
                threadId: input.thread.id,
                sessionEnabled: true,
              });
              if (!webSearchInject.enabled || !webSearchInject.codexServer || !webSearchInject.sdkEntry) {
                throw new Error(
                  `本会话需要 Integrated Web Search，但不可用：${webSearchInject.unavailableReason ?? "未知原因"}`,
                );
              }
              registerBuiltin(ECO_WEB_SEARCH_MCP_SERVER, webSearchInject.sdkEntry);
            }
            const schedulingInject = await schedulingGateway.resolveInjection(input.thread.id);
            registerBuiltin(SCHEDULING_MCP_SERVER, schedulingInject.sdkEntry);
            registerBuiltin(
              CONTEXT_MCP_SERVER,
              (await contextReferenceGateway.resolveInjection(input.thread.id)).sdkEntry,
            );
            const imageViewInject = await imageViewGateway.resolveInjection(input.thread.id);
            registerBuiltin(ECO_IMAGE_VIEW_MCP_SERVER, imageViewInject.sdkEntry);
            const imageDisplayInject = await imageDisplayGateway.resolveInjection(input.thread.id);
            registerBuiltin(ECO_IMAGE_DISPLAY_MCP_SERVER, imageDisplayInject.sdkEntry);
            const htmlCap = await centerServerClient.refreshHtmlHostingCapability();
            if (htmlCap.available) {
              const htmlHostInject = await htmlHostGateway.resolveInjection(input.thread.id);
              registerBuiltin(ECO_HTML_HOST_MCP_SERVER, htmlHostInject.sdkEntry);
            }
            const hubInjection = await mcpHubGateway.prepareThreadFromSdkConfig({
              threadId: input.thread.id,
              config: configuredMcp,
              allowedServers: [...hubMcpKeys, ...builtinHubServers],
              runtimeName: codexHubName,
            });
            return hubInjection ? [hubInjection.codexServer] : [];
          },
          resolveEnabledMcpServerKeys: async () => {
            const codexHubName = codexHubServerName(input.thread.id);
            const keys = resolveCodexThreadMcpServerKeys(input.thread.id).filter(
              (key) =>
                !key.startsWith("eco_ab_") && !Object.hasOwn(mcpStore.buildSdkConfig().mcpServers, key),
            );
            const hasCodexHub = mcpHubGateway
              .listThreadCodexServers()
              .some((server) => server.name === codexHubName);
            if (hasCodexHub && !keys.includes(codexHubName)) {
              keys.push(codexHubName);
            }
            return keys.filter((key) => !key.startsWith("eco_") || key === codexHubName);
          },
          resolveSkillConfig: () => {
            const base = codexSkills.map(({ skill, enabled }) => ({
              path: skill.skillFilePath,
              enabled,
            }));
            if (!ecoBrowserSkillFile) {
              return base;
            }
            const withoutDup = base.filter(
              (entry) =>
                path.basename(path.dirname(entry.path)) !== ECO_AGENT_BROWSER_SKILL_NAME &&
                entry.path !== ecoBrowserSkillFile,
            );
            return [...withoutDup, { path: ecoBrowserSkillFile, enabled: true }];
          },
          skillDiscoveryCwd: cwd,
          onPrepared: async () => {
            if (input.rewindTarget) {
              const targetItemId = input.rewindTarget.userMessageId?.trim();
              if (!targetItemId) {
                throw new Error("该节点缺少当前 Codex 消息 id，无法安全 fork。");
              }
              await forkCodexThreadForEcoThread({
                ecoThreadId: input.thread.id,
                targetItemId,
              });
              // Prune removes attempts started after the edited user message, including the
              // continuation attempt created by startRunAttempt. Rehydrate before recording
              // the replacement prompt so feed attribution stays attached to this turn.
              agentLifecycle.rehydrateCurrentRunAttempt(input.thread.id);
              await recordUserPrompt(
                input.thread.id,
                input.displayPrompt?.trim() || input.prompt,
                input.attachments,
              );
              // Turn sections sort by attempt.startedAt while user prompts sort by event.at.
              // Retime the attempt after the replacement prompt so the turn stays below it.
              agentLifecycle.rehydrateCurrentRunAttempt(input.thread.id);
              scheduleThreadRunProjectionUpdated(input.thread.id, {
                streaming: false,
              });
            }
          },
          onConfigReloadWait: () => {
            updateThread(input.thread.id, {
              status: "running",
              message: "",
            });
          },
          recordRouteFingerprint: recordThreadRouteFingerprint,
          onProxyReady: () => {
            patchThreadSummary(input.thread.id, {
              status: "running",
              message: "",
            });
          },
          run: async ({ routes }) => {
            const driver = createCodexRuntimeDriver(input.thread.id, mode, {
              enableMidTurnPort: true,
              onTurnBound: ({ ecoThreadId, codexThreadId, turnId }) => {
                if (!activeRunRuntimeState.bindCodexTurn(ecoThreadId, controller, turnId)) {
                  return;
                }
                const client = getCodexRuntimeClientForEcoThread(ecoThreadId);
                if (!client) {
                  return;
                }
                codexMidTurnPorts.open(ecoThreadId, {
                  client,
                  codexThreadId,
                  turnId,
                });
              },
              onTurnClosing: async ({ ecoThreadId }) => {
                await codexMidTurnPorts.closeIngress(ecoThreadId);
              },
              onTurnClosed: ({ ecoThreadId, turnId }) => {
                if (turnId) {
                  activeRunRuntimeState.clearCodexTurn(ecoThreadId, controller, turnId);
                }
                codexMidTurnPorts.close(ecoThreadId);
              },
            });
            try {
              const agentRegistry = resolveAgentRuntimeConfigForThreadId(input.thread.id);
              const runInput = {
                threadId: input.thread.id,
                prompt: mainPrompt,
                workspacePath: input.workspace.path,
                worktreePath: cwd,
                routes,
                signal: controller.signal,
                codexSession: {
                  ...(await buildCodexSessionOptions(input.thread.id, mainPrompt, cwd)),
                },
                ...(agentRegistry ? { agentRegistry } : {}),
              };
              const events =
                input.continuation && driver.runContinuation
                  ? driver.runContinuation(
                      runInput,
                      mode === "plan" ? "planning" : mode === "ask" ? "ask" : "execution",
                    )
                  : mode === "plan" && driver.runPlan
                    ? driver.runPlan(runInput)
                    : mode === "ask" && driver.runAsk
                      ? driver.runAsk(runInput)
                      : driver.run(runInput);
              for await (const event of events) {
                if (event.type === "agent.started" || event.type === "agent.completed") {
                  process.stderr.write(`[eco-codex] ${event.type} thread=${input.thread.id}\n`);
                }
              }
              return controller.signal.aborted
                ? { ok: false, reason: resolveAbortedRunReason(controller.signal), aborted: true }
                : { ok: true };
            } catch (error) {
              if (controller.signal.aborted) {
                return {
                  ok: false,
                  reason: resolveAbortedRunReason(controller.signal, error),
                  aborted: true,
                  ...(isCodexTurnInterruptFailed(error) && { interruptFailed: true }),
                };
              }
              return { ok: false, reason: errorMessage(error) };
            } finally {
              driver.dispose();
            }
          },
        });
      },
      0,
      input.runtimeDispatch,
    );

    const forcedDelegationActive = Boolean(forcedPlanDelegationStore.get(input.thread.id));
    if (!outcome.ok) {
      if (forcedDelegationActive) {
        settleForcedPlanDelegation(input.thread.id, {
          ok: false,
          reason: outcome.reason,
        });
      }
      if (outcome.interruptFailed) {
        const message = `本轮停止失败：${formatUserFacingRequestError(outcome.reason)}`;
        emitThreadEvent(input.thread.id, "thread.api_error", message, "system", false, {
          metadata: {
            activityOrigin: "codex.turn_interrupt_failed",
            apiError: {
              code: "codex_turn_interrupt_failed",
              message,
            },
          },
        });
        markThreadInterrupted(input.thread.id, message);
      } else if (outcome.aborted) {
        await handleRunCancelled(input.thread.id, worktreePlan, outcome.reason);
      } else {
        markThreadInterrupted(input.thread.id, outcome.reason);
      }
      return;
    }

    if (forcedDelegationActive && mode === "agent") {
      const settled = settleForcedPlanDelegation(input.thread.id, { ok: true });
      if (settled?.outcome === "failed") {
        markThreadInterrupted(input.thread.id, settled.reason ?? "计划委派失败。");
        return;
      }
      conversationStore.clearPendingPlan(input.thread.id);
      emitThreadEvent(input.thread.id, "thread.plan_cleared", "计划已进入执行阶段。", "system");
    }

    if (mode === "agent") {
      await completeCodingThreadRun(input.thread.id, worktreePlan);
    } else if (mode === "ask") {
      updateThread(input.thread.id, { status: "completed", message: "" });
    } else if (conversationStore.getThread(input.thread.id)?.status !== "awaiting_plan") {
      updateThread(input.thread.id, { status: "idle", message: "" });
    }
  } catch (error) {
    if (forcedPlanDelegationStore.get(input.thread.id)) {
      settleForcedPlanDelegation(input.thread.id, {
        ok: false,
        reason: errorMessage(error),
      });
    }
    markThreadInterrupted(input.thread.id, errorMessage(error));
  } finally {
    await finalizeMainThreadRunCleanup({
      threadId: input.thread.id,
      worktreePath: cwd,
      idleFallbackMessage: "",
    });
  }
}

function resolveCodexThreadMcpServerKeys(threadId: string): string[] {
  const thread = conversationStore.getThread(threadId);
  const hydrated = thread ? ensureThreadRuntimeConfig(thread) : undefined;
  return resolveThreadRuntimeMcpServerKeys({
    ...(hydrated?.runtimeConfig ? { runtimeConfig: hydrated.runtimeConfig } : {}),
    settings: getModelSettingsSnapshot(),
    availableMcpServerKeys: [...listEnabledGlobalMcpServerKeys(mcpStore.listServers())],
  });
}

async function resolveCodexThreadSkills(
  threadId: string,
  workspacePath: string,
): Promise<Array<{ skill: SkillInfo; enabled: boolean }>> {
  const thread = conversationStore.getThread(threadId);
  const settings = thread ? ensureThreadRuntimeConfig(thread).runtimeConfig?.skillsEnabled : undefined;
  const discovered = await listDiscoveredSkills(workspacePath);
  const entries = [...discovered.userSkills, ...discovered.projectSkills]
    .filter(
      (skill) =>
        (skill.layout === "agents" || skill.layout === "codex") &&
        !/[/\\]\.codex[/\\]skills[/\\]\.system[/\\]/.test(skill.skillFilePath) &&
        skill.name !== ECO_AGENT_BROWSER_SKILL_NAME,
    )
    .map((skill) => ({
      skill,
      enabled: settings?.[skill.settingsKey ?? skill.skillFilePath] ?? skill.source === "project",
    }));
  if (browserSettingsStore.get().agentIntegrationEnabled) {
    const skillFile = resolveEcoAgentBrowserSkillFileForCodex();
    if (skillFile) {
      const thread = conversationStore.getThread(threadId);
      const sessionEnabled = integrationEnabled(
        thread ? ensureThreadRuntimeConfig(thread).runtimeConfig?.integrationsEnabled : undefined,
        "browser",
      );
      entries.push({
        skill: buildEcoAgentBrowserCodexSkillInfo(skillFile),
        enabled: sessionEnabled,
      });
    }
  }
  return entries;
}

async function resolvePiSkillPathsForThread(threadId: string, workspacePath: string): Promise<string[]> {
  const thread = conversationStore.getThread(threadId);
  const skillsEnabled = thread ? ensureThreadRuntimeConfig(thread).runtimeConfig?.skillsEnabled : undefined;
  const entries = await resolvePiThreadSkills({
    workspacePath,
    ...(skillsEnabled ? { skillsEnabled } : {}),
  });
  return piSkillDirectoriesForSession(entries);
}

/**
 * Resolve PI skill paths + isolated MCP/integration injection for one thread run.
 */
async function resolvePiSessionResourcesForThread(
  threadId: string,
  workspacePath: string,
): Promise<{
  skillPaths: string[];
  mcpServers: Record<string, unknown>;
  appendSystemPrompt: string[];
}> {
  const skillPaths = await resolvePiSkillPathsForThread(threadId, workspacePath);
  const thread = conversationStore.getThread(threadId);
  const hydrated = thread ? ensureThreadRuntimeConfig(thread) : undefined;
  const settings = getModelSettingsSnapshot();
  const availableMcpServerKeys = listEnabledGlobalMcpServerKeys(mcpStore.listServers());
  const enabledMcpServers = resolveThreadRuntimeMcpServerKeys({
    ...(hydrated?.runtimeConfig ? { runtimeConfig: hydrated.runtimeConfig } : {}),
    settings,
    availableMcpServerKeys,
  });

  const sessionEcoBrowserEnabled =
    browserSettingsStore.get().agentIntegrationEnabled &&
    integrationEnabled(hydrated?.runtimeConfig?.integrationsEnabled, "browser");
  const sessionComputerUseEnabled =
    computerUseSettingsStore.get().agentIntegrationEnabled &&
    integrationEnabled(hydrated?.runtimeConfig?.integrationsEnabled, "computerUse");
  const sessionImageGenerationEnabled =
    imageGenerationStore.getSettings().enabled &&
    integrationEnabled(hydrated?.runtimeConfig?.integrationsEnabled, "imageGeneration");
  const sessionTtsEnabled =
    ttsStore.getSettings().enabled && integrationEnabled(hydrated?.runtimeConfig?.integrationsEnabled, "tts");

  const browserInject = await requireBrowserHost().resolveAgentBrowserMcpInjection({
    threadId,
    sessionEnabled: sessionEcoBrowserEnabled,
  });
  if (sessionEcoBrowserEnabled && !browserInject.enabled) {
    throw new Error(`本会话已开启内置浏览器，但不可用：${browserInject.unavailableReason ?? "未知原因"}`);
  }
  const computerUseInject = await computerUseGateway.resolveInjection({
    threadId,
    sessionEnabled: sessionComputerUseEnabled,
  });
  if (sessionComputerUseEnabled && !computerUseInject.enabled) {
    throw new Error(`本会话已开启电脑操控，但不可用：${computerUseInject.unavailableReason ?? "未知原因"}`);
  }
  const imageInject = await imageGenerationGateway.resolveInjection({
    threadId,
    sessionEnabled: sessionImageGenerationEnabled,
  });
  if (sessionImageGenerationEnabled && !imageInject.enabled) {
    throw new Error(`本会话已开启创意绘画，但不可用：${imageInject.unavailableReason ?? "未知原因"}`);
  }
  const ttsInject = await ttsGateway.resolveInjection({
    threadId,
    sessionEnabled: sessionTtsEnabled,
  });
  if (sessionTtsEnabled && !ttsInject.enabled) {
    throw new Error(`本会话已开启语音生成，但不可用：${ttsInject.unavailableReason ?? "未知原因"}`);
  }
  const imageViewInject = await imageViewGateway.resolveInjection(threadId);
  const imageDisplayInject = await imageDisplayGateway.resolveInjection(threadId);
  const htmlHostingCapability = await centerServerClient.refreshHtmlHostingCapability();
  const htmlHostInject = htmlHostingCapability.available
    ? await htmlHostGateway.resolveInjection(threadId)
    : undefined;

  let browserSkillDirectory: string | undefined;
  if (browserInject.enabled) {
    const skillFile = resolveEcoAgentBrowserSkillFileForCodex();
    if (!skillFile) {
      throw new Error("本会话已开启内置浏览器，但未找到打包的 eco-agent-browser skill 文件。");
    }
    browserSkillDirectory = path.dirname(skillFile);
  }

  const schedulingInject = await schedulingGateway.resolveInjection(threadId);
  const mcpSession = buildPiMcpSessionConfig({
    globalSdkConfig: mcpStore.buildSdkConfig(),
    enabledMcpServerKeys: enabledMcpServers,
    browserInject: {
      enabled: browserInject.enabled,
      ...(browserInject.sdkEntry ? { sdkEntry: browserInject.sdkEntry } : {}),
      ...(browserInject.promptAppend ? { promptAppend: browserInject.promptAppend } : {}),
    },
    computerUseInject: {
      enabled: computerUseInject.enabled,
      ...(computerUseInject.sdkEntry ? { sdkEntry: computerUseInject.sdkEntry } : {}),
      ...(computerUseInject.promptAppend ? { promptAppend: computerUseInject.promptAppend } : {}),
    },
    imageInject: {
      enabled: imageInject.enabled,
      ...(imageInject.sdkEntry ? { sdkEntry: imageInject.sdkEntry } : {}),
      ...(imageInject.promptAppend ? { promptAppend: imageInject.promptAppend } : {}),
    },
    ttsInject: {
      enabled: ttsInject.enabled,
      ...(ttsInject.sdkEntry ? { sdkEntry: ttsInject.sdkEntry } : {}),
      ...(ttsInject.promptAppend ? { promptAppend: ttsInject.promptAppend } : {}),
    },
    imageViewInject: {
      enabled: true,
      sdkEntry: imageViewInject.sdkEntry,
      promptAppend: imageViewInject.promptAppend,
    },
    imageDisplayInject: {
      enabled: true,
      sdkEntry: imageDisplayInject.sdkEntry,
      promptAppend: imageDisplayInject.promptAppend,
    },
    ...(htmlHostInject
      ? {
          htmlHostInject: {
            enabled: true,
            sdkEntry: htmlHostInject.sdkEntry,
            promptAppend: htmlHostInject.promptAppend,
          },
        }
      : {}),
    ...(browserSkillDirectory ? { browserSkillDirectory } : {}),
  });

  mcpSession.mcpServers[CONTEXT_MCP_SERVER] = (
    await contextReferenceGateway.resolveInjection(threadId)
  ).sdkEntry;
  mcpSession.appendSystemPrompt.push(CONTEXT_REFERENCE_PROMPT);
  mcpSession.mcpServers[SCHEDULING_MCP_SERVER] = schedulingInject.sdkEntry;
  mcpSession.appendSystemPrompt.push(SCHEDULING_PROMPT);
  const globalMcpConfig = mcpStore.buildSdkConfig();
  const hubServerKeys = enabledMcpServers.filter(
    (key) => Object.hasOwn(globalMcpConfig.mcpServers, key) && !key.startsWith("eco_"),
  );
  const hubBuiltinKeys = Object.keys(mcpSession.mcpServers).filter(
    (key) => key.startsWith("eco_") && key !== "eco_mcp",
  );
  for (const key of hubBuiltinKeys) {
    const entry = mcpSession.mcpServers[key];
    if (isRecord(entry)) {
      mcpHubGateway.registerThreadServerEntry({ name: key, threadId, sdkEntry: entry });
    }
  }
  const hubInjection = await mcpHubGateway.prepareThreadFromSdkConfig({
    threadId,
    config: globalMcpConfig,
    allowedServers: [...hubServerKeys, ...hubBuiltinKeys],
  });
  if (hubInjection?.promptAppend) mcpSession.appendSystemPrompt.push(hubInjection.promptAppend);
  const resolvedMcpServers = { ...mcpSession.mcpServers };
  for (const key of hubServerKeys) delete resolvedMcpServers[key];
  for (const key of hubBuiltinKeys) delete resolvedMcpServers[key];
  if (hubInjection) resolvedMcpServers.eco_mcp = hubInjection.sdkEntry;

  return {
    skillPaths: [
      ...new Set([...skillPaths, ...mcpSession.extraSkillDirectories].map((entry) => path.resolve(entry))),
    ].sort((a, b) => a.localeCompare(b)),
    mcpServers: resolvedMcpServers,
    appendSystemPrompt: mergePiAppendSystemPrompt(
      definedProps({
        globalUserRules: personalizationSettingsStore.get().globalRules,
        integrationAppend: mcpSession.appendSystemPrompt,
      }),
    ),
  };
}

/**
 * PI hot-reloads skills on the next run via AgentSession.reload.
 * Unlike Codex, idle PI sessions do not block Skills toggles.
 */
function assertPiSkillsConfigReloadAllowed(
  threadStatus: string | undefined,
  existingSkills: SkillsEnabledSettings | undefined,
  nextSkills: SkillsEnabledSettings | undefined,
): void {
  const skillsChanged = skillsEnabledSettingsChanged(existingSkills, nextSkills);
  if (
    shouldBlockPiSkillsConfigReload({
      skillsChanged,
      threadStatus,
    })
  ) {
    throw new Error("请等待当前运行结束后再修改 Skills。");
  }
}

async function buildCodexSessionOptions(threadId: string, prompt: string, workspacePathOverride?: string) {
  const thread = conversationStore.getThread(threadId);
  const workspacePath = workspacePathOverride ?? thread?.workspacePath ?? currentWorkspace?.path;
  if (!workspacePath) return {};
  const resolved = await resolveCodexThreadSkills(threadId, workspacePath);
  const skillInputs = resolveExplicitCodexSkillInputs(
    prompt,
    resolved.filter((entry) => entry.enabled).map((entry) => entry.skill),
  );
  return skillInputs.length > 0 ? { skillInputs } : {};
}

async function runAskThread(
  thread: ThreadSummary,
  workspace: WorkspaceInfo,
  runtimeConfig: RuntimeConfig,
  prompt: string,
  worktreePath?: string,
  resume?: EcoSdkResumeOptions,
  attachments?: PromptImageAttachment[],
  routesOverride?: readonly RuntimeRoleRouteConfig[],
  runtimeDispatch?: PreparedHistoryRuntimeDispatch,
): Promise<void> {
  const controller = new AbortController();
  const cwd = worktreePath?.trim() || workspace.path;
  startActiveRun(thread.id, {
    controller,
    worktreePlan: createSessionPlan(workspace.path, thread.id),
  });
  resetSubagentContextWindows(thread.id);

  try {
    const outcome = await runThreadRequestOnce(
      thread.id,
      "ask",
      controller.signal,
      async (attemptContext) => {
        const mainPrompt = await resolvePromptImagesForMainContext({
          threadId: thread.id,
          prompt,
          ...(attachments?.length ? { attachments } : {}),
          ...(routesOverride ? { routesOverride } : {}),
          signal: controller.signal,
        });
        return runThreadRequestWithLiveRequestLifecycle({
          context: attemptContext,
          resolveRuntimeConfig: () => resolveRuntimeConfigForThreadId(thread.id, routesOverride),
          recordRouteFingerprint: recordThreadRouteFingerprint,
          startRuntimeProxy,
          onProxyReady: ({ proxy }) => {
            process.stderr.write(
              `[eco] 模型代理: ${proxy.baseUrl} · 上游日志: ${getUpstreamLogFilePath()}\n`,
            );
            patchThreadSummary(thread.id, {
              status: "running",
              message: "",
            });
          },
          run: async ({ proxy: attemptProxy, routes }) => {
            const resumeOpts = resume ?? resolveResumeOptions(thread.id, cwd);
            try {
              const driver = createSdkDriver(thread.id, attemptProxy, undefined, "ask");
              if (!driver.runAsk) {
                throw new Error("Runtime driver does not support ask mode.");
              }

              return await consumeSdkRunEvents({
                events: driver.runAsk(
                  buildDesktopSdkRunInput({
                    threadId: thread.id,
                    prompt: mainPrompt,
                    workspacePath: workspace.path,
                    worktreePath: cwd,
                    routes,
                    signal: controller.signal,
                    sdkSession: await buildSdkSessionOptions(thread.id, mainPrompt),
                    agentRegistry: resolveAgentRuntimeConfigForThread(thread),
                    ...(resumeOpts ? { resume: resumeOpts } : {}),
                  }),
                ),
                threadId: thread.id,
                worktreePath: cwd,
                signal: controller.signal,
                onUsageRecorded: onSdkUsageRecordedEvent,
                captureSession: captureSdkSessionFromEvent,
                emitActivity: emitSdkStreamActivity,
              });
            } catch (error) {
              if (controller.signal.aborted) {
                return {
                  ok: false,
                  reason: resolveAbortedRunReason(controller.signal, error),
                  aborted: true,
                };
              }
              return { ok: false, reason: errorMessage(error) };
            }
          },
        });
      },
      0,
      runtimeDispatch,
    );

    const decision = resolveAskRunOutcome(outcome);
    await applyMainThreadRunDecisionEffects({
      threadId: thread.id,
      decision,
      onCancelled: async (reason) => {
        cancelClarificationsForThread(thread.id, reason);
        const plan = resolveWorktreePlan(workspace.path, thread.id, cwd);
        await handleRunCancelled(thread.id, plan);
      },
      onFailed: (reason) => {
        markThreadInterrupted(thread.id, reason);
      },
      onCompleted: () => {
        updateThread(thread.id, { status: "completed", message: "" });
      },
    });
  } catch (error) {
    cancelClarificationsForThread(thread.id, errorMessage(error));
    markThreadInterrupted(thread.id, errorMessage(error));
  } finally {
    const worktreePath = resolveThreadWorktreePath(thread.id);
    await finalizeMainThreadRunCleanup({
      threadId: thread.id,
      worktreePath,
      cancelClarificationsReason: "run finished",
      idleFallbackMessage: "",
    });
  }
}

async function runPlanThread(
  thread: ThreadSummary,
  workspace: WorkspaceInfo,
  runtimeConfig: RuntimeConfig,
  prompt: string,
  worktreePath?: string,
  resume?: EcoSdkResumeOptions,
  attachments?: PromptImageAttachment[],
  routesOverride?: readonly RuntimeRoleRouteConfig[],
  runtimeDispatch?: PreparedHistoryRuntimeDispatch,
): Promise<void> {
  const controller = new AbortController();
  const cwd = worktreePath?.trim() || workspace.path;
  startActiveRun(thread.id, {
    controller,
    worktreePlan: createSessionPlan(workspace.path, thread.id),
  });
  resetSubagentContextWindows(thread.id);

  let worktreePlan = createSessionPlan(workspace.path, thread.id);
  let planningPlanCaptured = false;
  const taskRuntime = createThreadSdkTaskRuntime({
    threadId: thread.id,
    store: {
      listTodos: (id) => conversationStore.listCoderTodos(id),
      replaceTodos: (id, todos) => conversationStore.replaceCoderTodos(id, todos),
    },
    emitTodoList,
  });
  const taskRunHooks = taskRuntime.taskRunHooks;

  try {
    const { worktreePlan: resolvedPlan, cwd: resolvedCwd } = await resolveThreadWorktree(
      workspace,
      thread.id,
      worktreePlan,
    );
    worktreePlan = resolvedPlan;
    const effectiveCwd = worktreePath?.trim() || resolvedCwd;
    activeRunRuntimeState.setWorktreePlan(thread.id, worktreePlan);

    const outcome = await runThreadRequestOnce(
      thread.id,
      "planning",
      controller.signal,
      async (attemptContext) => {
        const mainPrompt = await resolvePromptImagesForMainContext({
          threadId: thread.id,
          prompt,
          ...(attachments?.length ? { attachments } : {}),
          ...(routesOverride ? { routesOverride } : {}),
          signal: controller.signal,
        });
        return runThreadRequestWithLiveRequestLifecycle({
          context: attemptContext,
          resolveRuntimeConfig: () => resolveRuntimeConfigForThreadId(thread.id, routesOverride),
          recordRouteFingerprint: recordThreadRouteFingerprint,
          startRuntimeProxy,
          onProxyReady: ({ proxy }) => {
            process.stderr.write(
              `[eco] 模型代理: ${proxy.baseUrl} · 上游日志: ${getUpstreamLogFilePath()}\n`,
            );
            patchThreadSummary(thread.id, {
              status: "running",
              message: "",
            });
          },
          run: async ({ proxy: attemptProxy, routes }) => {
            const resumeOpts = resume ?? resolveResumeOptions(thread.id, effectiveCwd);
            try {
              const driver = createSdkDriver(
                thread.id,
                attemptProxy,
                taskRunHooks.hookContextExtras,
                "planning",
              );
              if (!driver.runPlan) {
                throw new Error("Runtime driver does not support plan mode.");
              }

              const result = await consumeSdkRunEvents({
                events: driver.runPlan(
                  buildDesktopSdkRunInput({
                    threadId: thread.id,
                    prompt: mainPrompt,
                    workspacePath: workspace.path,
                    worktreePath: effectiveCwd,
                    routes,
                    signal: controller.signal,
                    sdkSession: await buildSdkSessionOptions(thread.id, mainPrompt, {
                      skillsScope: "planning",
                    }),
                    agentRegistry: resolveAgentRuntimeConfigForThread(thread),
                    ...(resumeOpts ? { resume: resumeOpts } : {}),
                  }),
                ),
                threadId: thread.id,
                worktreePath: effectiveCwd,
                signal: controller.signal,
                onUsageRecorded: onSdkUsageRecordedEvent,
                captureSession: captureSdkSessionFromEvent,
                emitActivity: emitSdkStreamActivity,
                onEvent: (event) => {
                  if (event.type === "plan.ready" && isPlanReadyPayload(event.payload)) {
                    planningPlanCaptured = captureThreadPlanReady({
                      threadId: thread.id,
                      workspacePath: workspace.path,
                      worktreePath: effectiveCwd,
                      routesJson: JSON.stringify(routes),
                      payload: event.payload,
                      awaitingPlanMessage: "",
                    });
                  }
                  taskRuntime.handleEvent(event);
                },
              });
              if (!result.ok) {
                return result;
              }
              return { ok: true, planningPlanCaptured };
            } catch (error) {
              if (controller.signal.aborted) {
                return {
                  ok: false,
                  reason: resolveAbortedRunReason(controller.signal, error),
                  aborted: true,
                };
              }
              return { ok: false, reason: errorMessage(error) };
            }
          },
        });
      },
      0,
      runtimeDispatch,
    );

    const currentThread = conversationStore.getThread(thread.id);
    const enteredExecution =
      currentThread !== undefined &&
      resolveSessionMode(ensureThreadRuntimeConfig(currentThread).runtimeConfig) === "agent";
    const hasPendingPlan = planningPlanCaptured || Boolean(conversationStore.getPendingPlan(thread.id));
    const decision = resolvePlanSessionRunOutcome(outcome, {
      hasPendingPlan,
      enteredExecution,
    });
    await applyMainThreadRunDecisionEffects({
      threadId: thread.id,
      decision,
      onCancelled: async (reason) => {
        if (forcedPlanDelegationStore.get(thread.id)) {
          settleForcedPlanDelegation(thread.id, { ok: false, reason });
        }
        taskRunHooks.stopIfUnhandled("cancelled");
        cancelClarificationsForThread(thread.id, reason);
        await handleRunCancelled(thread.id, worktreePlan);
      },
      onFailed: (reason) => {
        if (forcedPlanDelegationStore.get(thread.id)) {
          settleForcedPlanDelegation(thread.id, { ok: false, reason });
        }
        taskRunHooks.stopIfUnhandled("blocked");
        markThreadInterrupted(thread.id, reason);
      },
      onIncomplete: (reason) => {
        if (forcedPlanDelegationStore.get(thread.id)) {
          settleForcedPlanDelegation(thread.id, { ok: false, reason });
        }
        taskRunHooks.stopIfUnhandled("blocked");
        markThreadInterrupted(thread.id, reason);
      },
      onCompleted: () => {
        taskRunHooks.stopIfUnhandled("completed");
        // The pending plan is retained while a forced delegation is armed; only a
        // delegation that actually spawned and finished may release it.
        if (forcedPlanDelegationStore.get(thread.id)) {
          const settled = settleForcedPlanDelegation(thread.id, { ok: true });
          if (settled?.outcome === "failed") {
            markThreadInterrupted(thread.id, settled.reason ?? "计划委派失败。");
            return;
          }
          conversationStore.clearPendingPlan(thread.id);
          emitThreadEvent(thread.id, "thread.plan_cleared", "计划已进入执行阶段。", "system");
        }
        updateThread(thread.id, { status: "completed", message: "" });
      },
    });
  } catch (error) {
    taskRunHooks.stopIfUnhandled("blocked");
    cancelClarificationsForThread(thread.id, errorMessage(error));
    if (forcedPlanDelegationStore.get(thread.id)) {
      settleForcedPlanDelegation(thread.id, {
        ok: false,
        reason: errorMessage(error),
      });
    }
    markThreadInterrupted(thread.id, errorMessage(error));
  } finally {
    const worktreePathResolved = resolveThreadWorktreePath(thread.id);
    await finalizeMainThreadRunCleanup({
      threadId: thread.id,
      worktreePath: worktreePathResolved,
      cancelClarificationsReason: "run finished",
      idleFallbackMessage: "",
    });
  }
}

async function completeCodingThreadRun(threadId: string, worktreePlan: WorktreePlan): Promise<void> {
  if (isDirectWorkspacePlan(worktreePlan)) {
    updateThread(threadId, { status: "completed", message: "" });
    return;
  }

  try {
    const { files, diff } = await gitWorktrees.collectWorktreeChanges(worktreePlan);
    if (files.length > 0) {
      conversationStore.saveAppliedDiff(threadId, worktreePlan.workspacePath, diff, files);
      const summary = buildWorktreeMergeSummary(diff, files);
      emitThreadEvent(threadId, "workspace.changes", serializeWorktreeMergeMessage(summary), "system");
      updateThread(threadId, { status: "completed", message: "" });
      return;
    }
    updateThread(threadId, {
      status: "completed",
      message: "",
    });
  } catch (error) {
    process.stderr.write(`[eco] workspace diff snapshot failed: ${errorMessage(error)}\n`);
    updateThread(threadId, { status: "completed", message: "" });
  }
}

async function runCodingThreadAutonomous(
  thread: ThreadSummary,
  workspace: WorkspaceInfo,
  runtimeConfig: RuntimeConfig,
  prompt: string,
  existingWorktreePlan?: WorktreePlan,
  resume?: EcoSdkResumeOptions,
  attachments?: PromptImageAttachment[],
  routesOverride?: readonly RuntimeRoleRouteConfig[],
  runtimeDispatch?: PreparedHistoryRuntimeDispatch,
): Promise<void> {
  const controller = new AbortController();
  startActiveRun(thread.id, {
    controller,
    worktreePlan: existingWorktreePlan ?? createSessionPlan(workspace.path, thread.id),
  });
  resetSubagentContextWindows(thread.id);

  let worktreePlan = existingWorktreePlan ?? createSessionPlan(workspace.path, thread.id);
  const taskRuntime = createThreadSdkTaskRuntime({
    threadId: thread.id,
    store: {
      listTodos: (id) => conversationStore.listCoderTodos(id),
      replaceTodos: (id, todos) => conversationStore.replaceCoderTodos(id, todos),
    },
    emitTodoList,
  });
  const taskRunHooks = taskRuntime.taskRunHooks;

  try {
    const {
      worktreePlan: resolvedPlan,
      cwd,
      isolated,
    } = await resolveThreadWorktree(workspace, thread.id, existingWorktreePlan);
    worktreePlan = resolvedPlan;
    activeRunRuntimeState.setWorktreePlan(thread.id, worktreePlan);
    patchThreadSummary(thread.id, {
      message: "",
      status: "running",
    });

    const resumeOptsForRun = resume ?? resolveResumeOptions(thread.id, cwd);

    const runOutcome = await runThreadRequestOnce(
      thread.id,
      "execution",
      controller.signal,
      async (attemptContext) => {
        const mainPrompt = await resolvePromptImagesForMainContext({
          threadId: thread.id,
          prompt,
          ...(attachments?.length ? { attachments } : {}),
          ...(routesOverride ? { routesOverride } : {}),
          signal: controller.signal,
        });
        return runThreadRequestWithLiveRequestLifecycle({
          context: attemptContext,
          resolveRuntimeConfig: () => resolveRuntimeConfigForThreadId(thread.id, routesOverride),
          recordRouteFingerprint: recordThreadRouteFingerprint,
          startRuntimeProxy,
          onProxyReady: ({ proxy, plannerRoute }) => {
            process.stderr.write(
              `[eco] 模型代理: ${proxy.baseUrl} · 上游日志: ${getUpstreamLogFilePath()}\n`,
            );
            patchThreadSummary(thread.id, {
              message: "",
              status: "running",
            });
            process.stderr.write(
              `[eco] SDK model=${plannerRoute?.modelId ?? "?"} (direct / claude_code preset)\n`,
            );
          },
          run: async ({ proxy: attemptProxy, routes }) => {
            try {
              const driver = createSdkDriver(
                thread.id,
                attemptProxy,
                taskRunHooks.hookContextExtras,
                "execution",
              );
              return await consumeSdkRunEvents({
                events: driver.run(
                  buildDesktopSdkRunInput({
                    threadId: thread.id,
                    prompt: mainPrompt,
                    workspacePath: workspace.path,
                    worktreePath: cwd,
                    routes,
                    signal: controller.signal,
                    sdkSession: await buildSdkSessionOptions(thread.id, mainPrompt),
                    agentRegistry: resolveAgentRuntimeConfigForThread(thread),
                    ...(resumeOptsForRun ? { resume: resumeOptsForRun } : {}),
                  }),
                ),
                threadId: thread.id,
                worktreePath: cwd,
                signal: controller.signal,
                onUsageRecorded: onSdkUsageRecordedEvent,
                captureSession: captureSdkSessionFromEvent,
                emitActivity: emitSdkStreamActivity,
                onEvent: (event) => {
                  taskRuntime.handleEvent(event);
                },
              });
            } catch (error) {
              if (controller.signal.aborted) {
                return {
                  ok: false,
                  reason: resolveAbortedRunReason(controller.signal, error),
                  aborted: true,
                };
              }
              return { ok: false, reason: errorMessage(error) };
            }
          },
        });
      },
      0,
      runtimeDispatch,
    );

    const runDecision = resolveAutonomousRunOutcome(runOutcome, {
      hasPendingPlan: Boolean(conversationStore.getPendingPlan(thread.id)),
      planCaptured: false,
    });

    if (
      await applyMainThreadRunDecisionEffects({
        threadId: thread.id,
        decision: runDecision,
        onCancelled: async (reason) => {
          taskRunHooks.stopIfUnhandled("cancelled");
          cancelClarificationsForThread(thread.id, reason);
          await handleRunCancelled(thread.id, worktreePlan);
        },
        onFailed: (reason) => {
          taskRunHooks.stopIfUnhandled("blocked");
          cancelClarificationsForThread(thread.id, reason);
          assertSdkSessionRetainedOnRunFailure({
            hadResume: Boolean(resumeOptsForRun),
            reason,
          });
          markThreadInterrupted(thread.id, reason);
        },
        onIncomplete: (reason) => {
          taskRunHooks.stopIfUnhandled("blocked");
          cancelClarificationsForThread(thread.id, reason);
          markThreadInterrupted(thread.id, reason);
        },
      })
    ) {
      return;
    }

    taskRunHooks.stopIfUnhandled("completed");
    await completeCodingThreadRun(thread.id, worktreePlan);
  } catch (error) {
    taskRunHooks.stopIfUnhandled("blocked");
    cancelClarificationsForThread(thread.id, errorMessage(error));
    markThreadInterrupted(thread.id, errorMessage(error));
  } finally {
    const worktreePath = resolveThreadWorktreePath(thread.id);
    await finalizeMainThreadRunCleanup({
      threadId: thread.id,
      worktreePath,
      cancelClarificationsReason: "run finished",
      idleFallbackMessage: "",
    });
  }
}

async function runCodingThreadExecution(
  threadId: string,
  runtimeConfig: RuntimeConfig,
  options?: {
    planUserEdited?: boolean;
    routesOverride?: readonly RuntimeRoleRouteConfig[];
    followUp?: string;
    attachments?: PromptImageAttachment[];
    resume?: EcoSdkResumeOptions;
    runtimeDispatch?: PreparedHistoryRuntimeDispatch;
    planCommand?: { principalId: string; clientCommandId: string };
  },
): Promise<void> {
  const pending = conversationStore.getPendingPlan(threadId);
  const thread = conversationStore.getThread(threadId);
  if (!pending || !thread) {
    updateThread(threadId, {
      status: "failed",
      message: "执行失败：找不到待批准的计划。",
    });
    return;
  }

  commitThreadPlanApprovalToAgentMode(threadId, "execution_started");

  const planning: EcoPlanningContext = {
    userPrompt: pending.userPrompt,
    analysis: pending.analysis,
    plan: pending.plan,
    ...(pending.planFilePath ? { planFilePath: pending.planFilePath } : {}),
    ...(options?.planUserEdited ? { planUserEdited: true } : {}),
    ...(pending.deferredExitPlanToolUseId
      ? { deferredExitPlanToolUseId: pending.deferredExitPlanToolUseId }
      : {}),
  };

  // Persist before any await so status refresh can load approved plan from disk.
  await persistApprovedPlanForThread(threadId, {
    workspacePath: pending.workspacePath,
    userPrompt: pending.userPrompt,
    analysis: pending.analysis,
    plan: pending.plan,
    ...(pending.planFilePath ? { planFilePath: pending.planFilePath } : {}),
    ...(options?.planUserEdited !== undefined ? { planUserEdited: options.planUserEdited } : {}),
  });

  let worktreePlan = resolveWorktreePlan(pending.workspacePath, threadId, pending.worktreePath);
  const controller = new AbortController();
  startActiveRun(threadId, { controller, worktreePlan });
  resetSubagentContextWindows(threadId);

  const workspace = await ensureWorkspace(pending.workspacePath);
  const resolved = await resolveThreadWorktree(workspace, threadId, worktreePlan);
  worktreePlan = resolved.worktreePlan;
  const executionCwd = resolved.cwd;
  activeRunRuntimeState.setWorktreePlan(threadId, worktreePlan);

  const taskRuntime = createThreadSdkTaskRuntime({
    threadId,
    store: {
      listTodos: (id) => conversationStore.listCoderTodos(id),
      replaceTodos: (id, todos) => conversationStore.replaceCoderTodos(id, todos),
    },
    emitTodoList,
  });
  const taskRunHooks = taskRuntime.taskRunHooks;
  const executionPlan = buildExecutionFailureRestorePendingPlan(pending);

  try {
    const executionOutcome = await runThreadRequestOnce(
      threadId,
      "execution",
      controller.signal,
      async (attemptContext) => {
        if (!forcedPlanDelegationStore.get(threadId)) {
          if (options?.planCommand) {
            conversationStore.clearPendingPlanForCommand(threadId, options.planCommand);
          } else {
            conversationStore.clearPendingPlan(threadId);
          }
          emitThreadEvent(threadId, "thread.plan_cleared", "计划已进入执行阶段。", "system");
        }
        const followUp = options?.followUp?.trim();
        const runPrompt = followUp || pending.userPrompt;
        const mainPrompt = await resolvePromptImagesForMainContext({
          threadId,
          prompt: runPrompt,
          ...(options?.attachments?.length ? { attachments: options.attachments } : {}),
          ...(options?.routesOverride ? { routesOverride: options.routesOverride } : {}),
          signal: controller.signal,
        });
        return runThreadRequestWithLiveRequestLifecycle({
          context: attemptContext,
          resolveRuntimeConfig: () => resolveRuntimeConfigForThreadId(threadId, options?.routesOverride),
          recordRouteFingerprint: recordThreadRouteFingerprint,
          startRuntimeProxy,
          run: async ({ proxy: attemptProxy, routes: attemptRoutes }) => {
            executionPlan.routesJson = JSON.stringify(attemptRoutes);
            try {
              const driver = createSdkDriver(
                threadId,
                attemptProxy,
                taskRunHooks.hookContextExtras,
                "execution",
              );
              if (!driver.runContinuation) {
                throw new Error("Runtime driver does not support session continuation.");
              }
              const resume = options?.resume ?? resolveResumeOptions(threadId, executionCwd);
              const continuationPlanning = resume
                ? planning
                : {
                    userPrompt: planning.userPrompt,
                    analysis: planning.analysis,
                    plan: planning.plan,
                    ...(planning.planFilePath ? { planFilePath: planning.planFilePath } : {}),
                    ...(planning.planUserEdited ? { planUserEdited: true } : {}),
                  };
              return await consumeSdkRunEvents({
                events: driver.runContinuation(
                  buildDesktopSdkRunInput({
                    threadId,
                    prompt: mainPrompt,
                    workspacePath: pending.workspacePath,
                    worktreePath: executionCwd,
                    routes: attemptRoutes,
                    signal: controller.signal,
                    sdkSession: await buildSdkSessionOptions(threadId, mainPrompt),
                    agentRegistry: resolveAgentRuntimeConfigForThreadId(threadId),
                    ...(resume ? { resume } : {}),
                    ...(resume && {
                      resumableSubagents: listResumableSubagentRefs(threadId, "execution"),
                    }),
                  }),
                  "execution",
                  continuationPlanning,
                ),
                threadId,
                worktreePath: executionCwd,
                signal: controller.signal,
                onUsageRecorded: onSdkUsageRecordedEvent,
                captureSession: captureSdkSessionFromEvent,
                emitActivity: emitSdkStreamActivity,
                onEvent: (event) => {
                  taskRuntime.handleEvent(event);
                },
              });
            } catch (error) {
              if (controller.signal.aborted) {
                return {
                  ok: false,
                  reason: resolveAbortedRunReason(controller.signal, error),
                  aborted: true,
                };
              }
              return { ok: false, reason: errorMessage(error) };
            }
          },
        });
      },
      0,
      options?.runtimeDispatch,
    );

    const executionDecision = resolveExecutionRunOutcome(executionOutcome);
    await applyMainThreadRunDecisionEffects({
      threadId,
      decision: executionDecision,
      onCancelled: async (reason) => {
        if (forcedPlanDelegationStore.get(threadId)) {
          settleForcedPlanDelegation(threadId, { ok: false, reason });
        }
        taskRunHooks.stopIfUnhandled("cancelled");
        cancelClarificationsForThread(threadId, reason);
        await handleRunCancelled(threadId, worktreePlan);
      },
      onFailed: async (reason) => {
        if (forcedPlanDelegationStore.get(threadId)) {
          settleForcedPlanDelegation(threadId, { ok: false, reason });
        }
        taskRunHooks.stopIfUnhandled("blocked");
        await restoreAfterExecutionFailure(threadId, worktreePlan, reason, executionPlan);
      },
      onIncomplete: (reason) => {
        if (forcedPlanDelegationStore.get(threadId)) {
          settleForcedPlanDelegation(threadId, { ok: false, reason });
        }
        taskRunHooks.stopIfUnhandled("blocked");
        markThreadInterrupted(threadId, reason);
      },
      onCompleted: () => {
        taskRunHooks.stopIfUnhandled("completed");
        if (forcedPlanDelegationStore.get(threadId)) {
          const settled = settleForcedPlanDelegation(threadId, { ok: true });
          if (settled?.outcome === "failed") {
            markThreadInterrupted(threadId, settled.reason ?? "计划委派失败。");
            return;
          }
          conversationStore.clearPendingPlan(threadId);
          emitThreadEvent(threadId, "thread.plan_cleared", "计划已进入执行阶段。", "system");
        }
        updateThread(threadId, { status: "completed", message: "" });
      },
    });
  } catch (error) {
    taskRunHooks.stopIfUnhandled("blocked");
    if (forcedPlanDelegationStore.get(threadId)) {
      settleForcedPlanDelegation(threadId, {
        ok: false,
        reason: errorMessage(error),
      });
    }
    await restoreAfterExecutionFailure(threadId, worktreePlan, errorMessage(error), executionPlan);
  } finally {
    await finalizeMainThreadRunCleanup({
      threadId,
      worktreePath: worktreePlan.worktreePath,
      idleFallbackMessage: "",
    });
  }
}

function recoverQueuedConversationV2Messages(): void {
  const v2 = conversationStore.conversationV2();
  const queuedMessages = v2.listQueuedUserMessages();
  // A queued acceptance whose queue row was cancelled or superseded is not pending
  // work: the queue never delivers it, and rescheduling it here is exactly how a
  // deleted follow-up came back as a brand-new run.
  const abandoned = abandonedQueuedAcceptedPrompts({
    messages: queuedMessages,
    listFollowUps: (conversationId) => conversationStore.listThreadFollowUps(conversationId),
  });
  const abandonedIds = new Set(abandoned.map((message) => message.messageId));
  for (const message of abandoned) {
    discardAbandonedAcceptedPrompts(v2, {
      conversationId: message.conversationId,
      messageIds: [message.messageId],
      reason: "follow-up-abandoned",
    });
    releaseFollowUpQueuePauseWhenEmpty(message.conversationId);
  }

  for (const message of queuedMessages) {
    if (abandonedIds.has(message.messageId)) continue;
    // Scheduler accepted prompts are recovered from its persisted queue receipt.
    // A crash between acceptance and enqueue must remain unknown, never start a second run here.
    if (message.messageId.startsWith("message_occ_")) continue;
    if (conversationRecoveryGate.isBlocked(message.conversationId)) continue;
    let input: AcceptedConversationMessageSchedule;
    try {
      input = buildAcceptedConversationMessageSchedule(message);
    } catch (error) {
      const reason = errorMessage(error);
      markAcceptedConversationMessageFailed(
        {
          conversationId: message.conversationId,
          messageId: message.messageId,
          turnId: message.turnId,
          text: message.body,
        },
        reason,
      );
      process.stderr.write(`[eco] queued V2 message is not recoverable (${message.messageId}): ${reason}\n`);
      continue;
    }
    void scheduleAcceptedConversationMessage(input).catch((error) => {
      process.stderr.write(
        `[eco] failed to recover queued V2 message (${message.messageId}): ${errorMessage(error)}\n`,
      );
    });
  }
}

async function scheduleAcceptedConversationMessage(
  input: AcceptedConversationMessageSchedule,
): Promise<ClarificationAsyncDelivery> {
  conversationRecoveryGate.assertReady(input.conversationId);
  const thread = conversationStore.getThread(input.conversationId);
  // A V2 stream may exist independently of this desktop runtime. In that
  // case the durable acceptance is still correct; another execution owner
  // may consume it.
  if (!thread) return { state: "unknown", message: "对话不存在，回答未确认投递。" };
  const currentMessage = conversationStore.conversationV2().getMessage(input.conversationId, input.messageId);
  const isAsyncAnswer = conversationStore
    .conversationV2()
    .isAsyncClarificationAnswer(thread.id, input.messageId);
  const terminalDelivery = terminalAcceptedMessageDelivery(currentMessage, thread.coreKind === "codex");
  if (terminalDelivery) return { ...terminalDelivery, followUpMessageId: input.messageId };

  // A persisted queue receipt owns delivery even at an idle boundary. Recovery
  // must not start this message directly and then let the same row drain again.
  const existingFollowUp = conversationStore
    .listThreadFollowUps(thread.id)
    .find((followUp) => followUp.conversationMessageId === input.messageId);
  if (existingFollowUp) {
    if (existingFollowUp.status === "queued") {
      void drainQueuedThreadFollowUpsAfterRun(thread.id);
    } else if (existingFollowUp.status === "failed") {
      markAcceptedConversationMessageFailed(input, existingFollowUp.error ?? "Queued delivery failed.");
    }
    return describeFollowUpDelivery(existingFollowUp);
  }

  const queueIt =
    thread.status === "running" ||
    thread.status === "queued" ||
    thread.status === "awaiting_plan" ||
    Boolean(thread.followUpQueuePaused) ||
    isAsyncAnswer;
  if (queueIt) {
    if (!threadAcceptsLiveFollowUp(thread.id, thread.status, isAsyncAnswer)) {
      throw new Error("Thread cannot accept a queued conversation message.");
    }
    const persistedAttachments = input.attachments?.length
      ? await promptImageFileStore.persistMessageAttachments(
          thread.id,
          `conversation-v2:${input.messageId}`,
          input.attachments,
        )
      : undefined;
    const followUp = conversationStore.enqueueThreadFollowUp({
      threadId: thread.id,
      prompt: input.text,
      ...(persistedAttachments?.length ? { attachments: persistedAttachments } : {}),
      deliveryMode: "queued",
      conversationMessageId: input.messageId,
    });
    if (isAsyncAnswer) {
      const pushed = await tryDeliverFollowUpViaMidTurn(thread, followUp);
      const settled = pushed ?? conversationStore.getThreadFollowUp(thread.id, followUp.id) ?? followUp;
      if (settled.status === "queued") {
        emitThreadFollowUpEvent(settled, "thread.follow_up.queued", formatFollowUpQueuedMessage(settled));
        void drainQueuedThreadFollowUpsAfterRun(thread.id);
      }
      return describeFollowUpDelivery(settled);
    }
    emitThreadFollowUpEvent(followUp, "thread.follow_up.queued", formatFollowUpQueuedMessage(followUp));
    return describeFollowUpDelivery(followUp);
  }

  try {
    await startThreadContinuation({
      threadId: thread.id,
      prompt: input.text,
      ...(input.attachments?.length ? { attachments: input.attachments } : {}),
      v2AcceptedMessageIds: [input.messageId],
      ...(thread.status === "failed" || thread.status === "blocked"
        ? { requireResumeForInterrupted: true }
        : {}),
    });
    const delivered = scheduledAcceptedMessageDelivery(
      conversationStore.conversationV2().getMessage(input.conversationId, input.messageId),
      thread.coreKind === "codex",
    );
    // Dispatching a run is not a provider acknowledgment. Local finalization alone
    // has no SDK item id, so a newly scheduled answer remains queued until that bind arrives.
    return { ...delivered, followUpMessageId: input.messageId };
  } catch (error) {
    const reason = errorMessage(error);
    markAcceptedConversationMessageFailed(input, reason);
    throw error;
  }
}

function markAcceptedConversationMessageFailed(
  input: AcceptedConversationMessageSchedule,
  reason: string,
): void {
  const v2 = conversationStore.conversationV2();
  const message = v2.getMessage(input.conversationId, input.messageId);
  if (
    !message ||
    message.isDeleted ||
    message.status === "final" ||
    message.status === "failed" ||
    message.status === "cancelled" ||
    message.status === "deleted"
  ) {
    return;
  }
  const sourceEventKey = `desktop:user:accepted-failed:${input.conversationId}:${input.messageId}`;
  v2.appendRuntime({
    conversationId: input.conversationId,
    eventId: `desktop_v2_user_failed_${stableHash(sourceEventKey)}`,
    sourceEventKey,
    type: "message.finalized",
    occurredAt: new Date().toISOString(),
    messageId: input.messageId,
    turnId: input.turnId,
    payload: { status: "failed", reason },
  });
}

function pinSchedulingProfile(profile: ScheduleExecutionProfile): ScheduleExecutionProfile {
  const settings = getModelSettingsSnapshot();
  return freezeSchedulingProfile(profile, settings, (config) => roleRoutesForThreadConfig(settings, config));
}

function validateSchedulingProfile(profile: ScheduleExecutionProfile): void {
  if (!profile || !isCoreKind(profile.coreKind)) throw new Error("Harness 不可用。");
  if (profile.coreKind === "acp") {
    if (!profile.runtimeConfig.cursorModelId?.trim()) throw new Error("Cursor 任务缺少固定模型。");
    return;
  }
  const routes = roleRoutesForThreadConfig(getModelSettingsSnapshot(), profile.runtimeConfig);
  const resolution = resolveRuntimeConfigForThreadConfig(
    getModelSettingsSnapshot(),
    profile.runtimeConfig,
    routes,
  );
  if (!resolution.ok) throw new Error(resolution.reason);
}

function inspectScheduledOccurrence(occurrence: ScheduleOccurrence): {
  status: import("../shared/scheduling").ScheduleOccurrenceStatus;
  error?: string;
} {
  const thread = occurrence.threadId ? conversationStore.getThread(occurrence.threadId) : undefined;
  const followUp =
    thread && occurrence.definition.kind === "session_message"
      ? conversationStore
          .listThreadFollowUps(thread.id)
          .find(
            (item) =>
              item.id === occurrence.followUpId || item.conversationMessageId === `message_${occurrence.id}`,
          )
      : undefined;
  // Queue itself owns idempotent delivery and recovery. Scheduling must never re-enqueue.
  if (thread && followUp?.status === "queued" && !thread.followUpQueuePaused)
    void drainQueuedThreadFollowUpsAfterRun(thread.id);
  return inspectScheduledRun({
    kind: occurrence.definition.kind,
    thread,
    followUp,
    hasAcceptedMessage: Boolean(
      thread &&
        !followUp &&
        conversationStore.conversationV2().getMessage(thread.id, `message_${occurrence.id}`),
    ),
    hasActiveRun: Boolean(thread && activeRunRuntimeState.hasRun(thread.id)),
    isDraining: Boolean(thread && threadFollowUpDrainScheduler.isDraining(thread.id)),
  });
}

function createSchedulingService(dbPath: string): SchedulingService {
  return new SchedulingService(new SchedulingStore(dbPath), {
    inheritProfile: (threadId) => {
      const source = conversationStore.getThread(threadId);
      if (!source) throw new Error("来源会话不存在。");
      const thread = ensureThreadRuntimeConfig(source);
      if (!thread?.coreKind || !thread.runtimeConfig) throw new Error("当前会话缺少运行配置。");
      return {
        workspacePath: thread.workspacePath,
        executionProfile: pinSchedulingProfile({
          coreKind: thread.coreKind,
          runtimeConfig: thread.runtimeConfig,
        }),
      };
    },
    validateProfile: validateSchedulingProfile,
    assertThread: (threadId) => {
      if (!conversationStore.getThread(threadId)) throw new Error("目标会话不存在。");
    },
    canDispatch: (occurrence) => {
      if (occurrence.definition.kind === "scheduled_task") {
        const workspacePath = occurrence.definition.workspacePath!;
        return !conversationStore
          .listThreads()
          .some(
            (thread) =>
              path.resolve(thread.workspacePath) === path.resolve(workspacePath) &&
              (activeRunRuntimeState.hasRun(thread.id) ||
                thread.status === "running" ||
                thread.status === "queued" ||
                thread.status === "awaiting_plan"),
          );
      }
      const thread = conversationStore.getThread(occurrence.definition.threadId!);
      if (!thread) return true; // Dispatch reports a durable explicit error.
      return (
        !activeRunRuntimeState.hasRun(thread.id) &&
        !contextMonitor.isCompactInFlight(thread.id) &&
        (thread.status === "idle" || thread.status === "completed") &&
        !thread.followUpQueuePaused &&
        !getPendingPlanApprovalForThread(thread.id) &&
        !getPendingBashApprovalForThread(thread.id) &&
        !hasPendingBlockingClarificationForThread(thread.id) &&
        !conversationStore.getPendingPlan(thread.id) &&
        !editingThreadFollowUpByThread.has(thread.id)
      );
    },
    dispatch: async (occurrence) => {
      const definition = occurrence.definition;
      if (definition.kind === "scheduled_task") {
        const result = await startNewThread(
          {
            workspacePath: definition.workspacePath!,
            prompt: definition.prompt,
            coreKind: definition.executionProfile!.coreKind,
            runtimeConfig: definition.executionProfile!.runtimeConfig,
          },
          {
            scheduled: true,
            threadId: occurrence.threadId!,
            title: definition.name,
            occurrenceId: occurrence.id,
          },
        );
        return { threadId: result.thread.id };
      }
      const threadId = definition.threadId!;
      if (!conversationStore.getThread(threadId)) throw new Error("目标会话已删除。");
      const prompt = definition.prompt;
      const accepted = conversationStore.conversationV2().sendMessage({
        principalId: "eco-scheduler",
        conversationId: threadId,
        clientCommandId: occurrence.id,
        messageId: `message_${occurrence.id}`,
        text: prompt,
        origin: { kind: "scheduled_message", scheduleId: definition.id, name: definition.name },
      });
      const existing = conversationStore
        .listThreadFollowUps(threadId)
        .find((item) => item.conversationMessageId === accepted.messageId);
      const followUp =
        existing ??
        conversationStore.enqueueThreadFollowUp({
          threadId,
          prompt,
          conversationMessageId: accepted.messageId,
          deliveryMode: "queued",
          priority: "normal",
        });
      emitThreadFollowUpEvent(followUp, "thread.follow_up.queued", formatFollowUpQueuedMessage(followUp));
      void drainQueuedThreadFollowUpsAfterRun(threadId);
      return { threadId, followUpId: followUp.id };
    },
    inspect: inspectScheduledOccurrence,
    onChanged: () => {
      syncSystemSleepBlocker();
      desktopEventCenter.publish({ kind: "scheduling.changed", payload: {}, aggregateKey: "scheduling:global" });
    },
    onError: (error) => logEcoDiag("scheduling.error", { error: errorMessage(error) }),
  });
}

async function startNewThread(
  payload: ThreadStartRequest,
  options: { scheduled?: boolean; threadId?: string; title?: string; occurrenceId?: string } = {},
): Promise<ThreadStartResult> {
  const attachments = parsePromptImageAttachments(payload.attachments);
  const prompt = resolveThreadMessagePrompt(payload.prompt);
  if (!prompt && attachments.length === 0) {
    throw new Error("Task prompt is required.");
  }
  // Materialize path-only spool attachments before any slow await (e.g. ACP CLI probe).
  // Otherwise a concurrent composer-draft delete can wipe spool and yield ENOENT.
  const attachmentsForHandOff = attachments.length ? await loadPromptAttachmentsForRuntime(attachments) : [];
  const coreKind = payload.coreKind ?? "claude";
  if (!isCoreKind(coreKind)) {
    throw new Error(`Unsupported Harness: ${String(payload.coreKind)}`);
  }
  if (coreKind === "codex" && !isCodexCliAvailable()) {
    throw new Error("Codex Harness 不可用：未找到可执行的 Codex CLI。请安装工作区依赖或设置 CODEX_EXECUTABLE。");
  }
  if (coreKind === "pi") {
    const pi = await probePiCoreAvailability();
    if (!pi.available) {
      throw new Error(pi.reason ?? "PI Harness 不可用。");
    }
  }
  if (coreKind === "acp") {
    await assertAcpCursorRunnableForMain();
  }

  const workspace = options.scheduled
    ? await inspectWorkspace(path.resolve(payload.workspacePath))
    : await ensureWorkspace(payload.workspacePath);
  const settings = getModelSettingsSnapshot();
  const parsedRuntimeConfig = parseThreadRuntimeConfigInput(payload.runtimeConfig);
  const threadRuntime =
    coreKind === "acp" || options.scheduled
      ? normalizeThreadRuntimeConfig(parsedRuntimeConfig)
      : materializeThreadRuntimeConfig(settings, parsedRuntimeConfig);
  const roleRoutes = coreKind === "acp" ? [] : roleRoutesForThreadConfig(settings, threadRuntime);
  const resolvedRuntimeConfig =
    coreKind === "acp"
      ? { ok: true as const, routes: [] as RuntimeRoute[] }
      : resolveRuntimeConfigForThreadConfig(settings, threadRuntime, roleRoutes);
  if (options.scheduled && !resolvedRuntimeConfig.ok) throw new Error(resolvedRuntimeConfig.reason);
  const status: ThreadSummary["status"] = resolvedRuntimeConfig.ok ? "running" : "blocked";
  const now = new Date().toISOString();
  const acpAgentId = coreKind === "acp" ? ("cursor" as const) : undefined;
  const thread: ThreadSummary = {
    id: options.threadId ?? `thr_${randomUUID()}`,
    title: options.title ?? resolvePendingThreadTitle(currentAppLocale()),
    prompt,
    workspacePath: workspace.path,
    status,
    createdAt: now,
    updatedAt: now,
    coreKind,
    ...(acpAgentId ? { acpAgentId } : {}),
    hostUiFeatures: resolveAcpHostUiFeatures({
      coreKind,
      ...(acpAgentId ? { acpAgentId } : {}),
    }),
    coreLockedAt: now,
    message: resolvedRuntimeConfig.ok ? "" : resolvedRuntimeConfig.reason,
    runtimeConfig: threadRuntime,
  };

  conversationStore.saveThread(thread);
  const scheduledAccepted = options.occurrenceId
    ? conversationStore.conversationV2().sendMessage({
        principalId: "eco-scheduler",
        conversationId: thread.id,
        clientCommandId: options.occurrenceId,
        messageId: `message_${options.occurrenceId}`,
        text: prompt,
      })
    : undefined;
  const recorded = await recordUserPrompt(
    thread.id,
    prompt,
    attachmentsForHandOff,
    scheduledAccepted ? [scheduledAccepted.messageId] : undefined,
  );
  const attachmentsForRuntime = await loadPromptAttachmentsForRuntime(
    recorded.storedAttachments ?? attachmentsForHandOff,
  );
  emitThreadEvent(thread.id, status === "blocked" ? "thread.blocked" : "thread.started", thread.message);

  // Landing browsers opened before the first message must move onto this thread
  // before the renderer setUiScope effect runs (otherwise pages look "left behind").
  try {
    if (!options.scheduled) await requireBrowserHost().adoptPersonalScopeToThread(thread.id);
  } catch (error) {
    console.warn(
      `[eco-browser] adoptPersonalScopeToThread failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  if (resolvedRuntimeConfig.ok) {
    if (coreKind !== "acp" && !options.scheduled) {
      scheduleThreadTitleSummary(thread.id);
    }
    void threadRuntimeCoordinator
      .start(coreKind, {
        thread,
        workspace,
        runtimeConfig: { routes: resolvedRuntimeConfig.routes },
        prompt,
        ...(attachmentsForRuntime?.length ? { attachments: attachmentsForRuntime } : {}),
        roleRoutes,
      })
      .catch((error) => updateThread(thread.id, { status: "failed", message: errorMessage(error) }));
  }

  return { thread };
}

interface StartThreadContinuationInput {
  threadId: string;
  preparationSignal?: AbortSignal;
  prompt: string;
  /** Starts a new Codex turn with input: [] against the existing remote thread. */
  codexEmptyInput?: boolean;
  displayPrompt?: string;
  runtimeConfigInput?: ThreadRuntimeConfigInput;
  attachments?: PromptImageAttachment[];
  rewindTarget?: ThreadActivityRewindTarget;
  requireResumeForInterrupted?: boolean;
  /** Mid-turn already wrote thread.user_prompt for this follow-up; drain must not duplicate. */
  skipRecordUserPrompt?: boolean;
  /** V2 accepted these user messages before the legacy runtime was scheduled. */
  v2AcceptedMessageIds?: readonly string[];
  /**
   * Explicit question answer or "handle now": start this one row while the ordinary
   * queue remains paused.
   */
  allowWhileQueuePaused?: boolean;
  /** Durable V2 history command whose checkpoints must move with destructive work. */
  historyCommand?: ThreadHistoryCommandContext;
  /** Restart recovery: local rewrite and the prepared checkpoint already committed. */
  preparedRuntimeDispatch?: PreparedHistoryRuntimeDispatch;
  /** Restart recovery: resume the already-created SDK fork without rewinding again. */
  preparedResumeOverride?: EcoSdkResumeOptions;
}

interface PreparedHistoryRuntimeDispatch {
  plannedAttemptId: string;
  commandDispatch: RunAttemptCommandDispatch;
}

async function startThreadContinuation(input: StartThreadContinuationInput): Promise<ThreadContinueResult> {
  if (input.preparationSignal) return startPreparedThreadContinuation(input);
  return threadRunPreparations.prepare(input.threadId, (preparationSignal) =>
    startPreparedThreadContinuation({ ...input, preparationSignal }),
  );
}

async function startPreparedThreadContinuation(
  input: StartThreadContinuationInput,
): Promise<ThreadContinueResult> {
  input.preparationSignal?.throwIfAborted();
  healOrphanedThreadBeforeContinuation(input.threadId);
  const thread = conversationStore.getThread(input.threadId);
  if (!thread) {
    throw new Error("Thread was not found.");
  }
  if (!thread.coreKind) {
    throw new Error(`Thread ${thread.id} has unknown Harness ownership.`);
  }
  // Pause means new prompts join the queue; do not start a run ahead of it.
  // Rewind is allowed (explicit edit of history) and still must not drain while paused.
  // Explicit question answers and "handle now" send their own row while the rest
  // of the queue stays paused.
  if (thread.followUpQueuePaused && !input.rewindTarget && !input.allowWhileQueuePaused) {
    throw new Error("Follow-up queue is paused; enqueue the message or resume the queue before continuing.");
  }
  const resolvedTarget = input.rewindTarget
    ? conversationStore.getActivityRewindTarget(input.threadId, input.rewindTarget.activityLineId)
    : undefined;
  if (input.rewindTarget && !resolvedTarget) {
    throw new Error("该节点缺少当前 SDK 消息映射，无法安全改写。");
  }
  const currentTarget =
    resolvedTarget && thread.coreKind === "claude"
      ? {
          ...resolvedTarget,
          userMessageId: await resolveCurrentClaudeUserMessageId(
            input.threadId,
            resolvedTarget.activityLineId,
          ),
        }
      : resolvedTarget;
  input.preparationSignal?.throwIfAborted();
  return threadRuntimeCoordinator.continue(thread.coreKind, {
    ...input,
    ...(currentTarget ? { rewindTarget: currentTarget } : {}),
  });
}

async function startClaudeThreadContinuation(
  input: StartThreadContinuationInput,
): Promise<ThreadContinueResult> {
  const prompt = input.prompt.trim();
  const hasAttachments = Boolean(input.attachments?.length);
  if (!prompt && !hasAttachments) {
    throw new Error("Message is required.");
  }
  const thread = conversationStore.getThread(input.threadId);
  if (!thread) {
    throw new Error("Thread was not found.");
  }
  requireThreadCore(thread, "claude", "continue with Claude");
  if (thread.status === "running" || thread.status === "queued") {
    throw new Error("Wait for the current run to finish.");
  }
  if (contextMonitor.isCompactInFlight(input.threadId)) {
    throw new Error("上下文正在压缩中，请稍候。");
  }

  const workspace = await ensureWorkspace(thread.workspacePath);
  const settings = getModelSettingsSnapshot();
  if (input.runtimeConfigInput) {
    const nextConfig = resolveContinueThreadRuntimeConfig(
      settings,
      thread.runtimeConfig,
      parseThreadRuntimeConfigInput(input.runtimeConfigInput),
    );
    roleRoutesForThreadConfig(settings, nextConfig);
    conversationStore.saveThreadRuntimeConfig(input.threadId, nextConfig);
  }
  const activeThread = ensureThreadRuntimeConfig(conversationStore.getThread(input.threadId) ?? thread);
  const activeRuntimeConfig = activeThread.runtimeConfig;
  if (!activeRuntimeConfig) {
    throw new Error("Thread runtime configuration is missing.");
  }
  const roleRoutes = roleRoutesForThreadConfig(settings, activeRuntimeConfig);
  noteSdkSessionRouteChange(input.threadId, roleRoutes);

  const runtimeConfig = resolveRuntimeConfigForThreadConfig(settings, activeRuntimeConfig, roleRoutes);
  if (!runtimeConfig.ok) {
    throw new Error(runtimeConfig.reason);
  }
  const runtime: RuntimeConfig = { routes: runtimeConfig.routes };

  // Rewind mutates the persisted activity/session state. Capture the source
  // history before that mutation so rewinding the first user turn (which
  // clears the SDK session entirely) can still resolve the continuation mode.
  const activityLinesBeforeRewind = input.rewindTarget
    ? await listThreadActivityFromSdkSession(input.threadId)
    : undefined;
  const rewindResume = input.rewindTarget
    ? await prepareThreadRewindForContinue({
        threadId: input.threadId,
        prompt,
        workspace,
        target: input.rewindTarget,
        ...(input.historyCommand ? { command: input.historyCommand } : {}),
      })
    : input.preparedResumeOverride;
  const effectiveThread = ensureThreadRuntimeConfig(
    conversationStore.getThread(input.threadId) ?? activeThread,
  );
  const sessionMode = threadSessionMode(input.threadId);
  const activityLines = input.rewindTarget
    ? activityLinesBeforeRewindTarget(activityLinesBeforeRewind ?? [], input.rewindTarget)
    : await listThreadActivityFromSdkSession(input.threadId);
  const sdkSession = conversationStore.getSdkSession(input.threadId);
  const cwd = normalizeSessionCwd(workspace.path, sdkSession?.cwd);
  const canResume = Boolean(
    rewindResume?.resumeSessionId || (sdkSession?.sessionId && existsSync(cwd) && cwd === workspace.path),
  );
  if (
    input.requireResumeForInterrupted &&
    (effectiveThread.status === "failed" || effectiveThread.status === "blocked") &&
    !canResume
  ) {
    throw new Error("当前对话没有可恢复的 SDK 会话，无法自动处理排队的后续消息。");
  }
  const existingWorktreePlan = createSessionPlan(workspace.path, input.threadId);

  const hasPendingPlan = Boolean(conversationStore.getPendingPlan(input.threadId));
  const claudePlanPath = conversationStore.getThreadClaudePlanFilePath(input.threadId);
  const hasApprovedPlanOnDisk = claudePlanPath
    ? await claudePlanFileExists(workspace.path, claudePlanPath)
    : false;
  const hasCoderTodos = conversationStore.listCoderTodos(input.threadId).length > 0;
  const hasAppliedDiff = Boolean(conversationStore.getAppliedDiff(input.threadId));
  const enteredExecutionPhase = threadEnteredExecutionPhase({
    threadStatus: effectiveThread.status,
    hasPendingPlan,
    hasApprovedPlanOnDisk,
    enteredExecutionPhase: false,
    hasCoderTodos,
    hasAppliedDiff,
    activityLines,
  });

  const continueAction = resolveThreadContinueAction({
    sessionMode,
    followUp: prompt,
    canResume,
    hasPendingPlan,
    hasApprovedPlanOnDisk,
    enteredExecutionPhase,
    hasCoderTodos,
    hasAppliedDiff,
    threadStatus: effectiveThread.status,
    activityLines,
  });

  const agentPrompt =
    continueAction.kind === "resume_sdk" || continueAction.kind === "resume_execution"
      ? prompt
      : buildAgentPromptWithContext(effectiveThread.prompt, prompt, activityLines);

  input.preparationSignal?.throwIfAborted();
  updateThread(input.threadId, {
    status: "running",
    message: "",
  });
  let attachmentsForRuntime = await loadPromptAttachmentsForRuntime(input.attachments);
  if (!input.skipRecordUserPrompt) {
    input.preparationSignal?.throwIfAborted();
    const recorded = await recordUserPrompt(
      input.threadId,
      input.displayPrompt?.trim() || prompt,
      input.attachments,
      input.v2AcceptedMessageIds,
      { finalizeAcceptedMessages: false },
    );
    attachmentsForRuntime = await loadPromptAttachmentsForRuntime(
      recorded.storedAttachments ?? input.attachments,
    );
  }
  if (input.rewindTarget) {
    // Publish the new history revision only after its replacement prompt exists.
    // An empty rewind projection can otherwise race the renderer refresh and make
    // a live continuation look as though it was never submitted.
    scheduleThreadRunProjectionUpdated(input.threadId, { streaming: false });
  }

  const updated: ThreadSummary = {
    ...effectiveThread,
    status: "running",
    message: "",
  };

  let runtimeDispatch = input.preparedRuntimeDispatch;
  if (input.historyCommand && !runtimeDispatch) {
    runtimeDispatch = prepareConversationCommandDispatch({
      v2: conversationStore.conversationV2(),
      job: {
        principalId: input.historyCommand.principalId,
        conversationId: input.threadId,
        clientCommandId: input.historyCommand.clientCommandId,
      },
      coreKind: "claude",
      actionKind: continueAction.kind,
      ...(continueAction.kind === "resume_sdk" ? { phase: continueAction.phase } : {}),
    });
  }

  input.preparationSignal?.throwIfAborted();
  await finalizeAcceptedV2Messages(input.threadId, input.v2AcceptedMessageIds ?? [], input.preparationSignal);
  void dispatchThreadContinueAction({
    threadId: input.threadId,
    action: continueAction,
    updated,
    workspace,
    runtimeConfig: runtime,
    agentPrompt,
    cwd,
    existingWorktreePlan,
    ...(attachmentsForRuntime?.length ? { attachments: attachmentsForRuntime } : {}),
    roleRoutes,
    ...(rewindResume && { resumeOverride: rewindResume }),
    ...(runtimeDispatch && { runtimeDispatch }),
  }).catch((error) => {
    markThreadInterrupted(input.threadId, errorMessage(error));
  });

  return {
    thread: ensureThreadRuntimeConfig(conversationStore.getThread(input.threadId) ?? updated),
  } satisfies ThreadContinueResult;
}

function parseThreadFollowUpEnqueueRequest(payload: unknown): ThreadFollowUpEnqueueRequest {
  if (!isRecord(payload)) {
    throw new Error("Invalid follow-up payload.");
  }
  const expectedHistoryRevision = readExpectedHistoryRevision(payload.expectedHistoryRevision);
  const threadId = readRequiredString(payload.threadId, "Thread id is required.");
  const attachments = parsePromptImageAttachments(payload.attachments);
  const prompt = resolveThreadMessagePrompt(payload.prompt);
  if (!prompt && attachments.length === 0) {
    throw new Error("Follow-up message is required.");
  }
  const priority = payload.priority === "escalated" ? "escalated" : "normal";
  const followUpDeliveryMode =
    payload.followUpDeliveryMode === "queue" || payload.followUpDeliveryMode === "steer"
      ? payload.followUpDeliveryMode
      : undefined;
  return {
    principalId: readRequiredString(payload.principalId, "Principal id is required."),
    clientCommandId: readRequiredString(payload.clientCommandId, "Client command id is required."),
    threadId,
    prompt,
    ...(attachments.length > 0 ? { attachments } : {}),
    priority,
    ...(followUpDeliveryMode ? { followUpDeliveryMode } : {}),
    expectedHistoryRevision,
  };
}

function parseThreadFollowUpEscalateRequest(payload: unknown): ThreadFollowUpEscalateRequest {
  if (!isRecord(payload)) {
    throw new Error("Invalid follow-up escalation payload.");
  }
  const expectedHistoryRevision = readExpectedHistoryRevision(payload.expectedHistoryRevision);
  const threadId = readRequiredString(payload.threadId, "Thread id is required.");
  const followUpId = readOptionalString(payload.followUpId);
  const attachments = parsePromptImageAttachments(payload.attachments);
  const prompt = resolveThreadMessagePrompt(payload.prompt);
  if (!followUpId && !prompt && attachments.length === 0) {
    throw new Error("Follow-up id or message is required.");
  }
  return {
    principalId: readRequiredString(payload.principalId, "Principal id is required."),
    clientCommandId: readRequiredString(payload.clientCommandId, "Client command id is required."),
    threadId,
    ...(followUpId ? { followUpId } : {}),
    ...(prompt ? { prompt } : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
    expectedHistoryRevision,
  };
}

function parseThreadFollowUpCancelRequest(payload: unknown): ThreadFollowUpCancelRequest {
  if (!isRecord(payload)) {
    throw new Error("Invalid follow-up cancel payload.");
  }
  const expectedHistoryRevision = readExpectedHistoryRevision(payload.expectedHistoryRevision);
  return {
    principalId: readRequiredString(payload.principalId, "Principal id is required."),
    clientCommandId: readRequiredString(payload.clientCommandId, "Client command id is required."),
    threadId: readRequiredString(payload.threadId, "Thread id is required."),
    followUpId: readRequiredString(payload.followUpId, "Follow-up id is required."),
    expectedHistoryRevision,
  };
}

function parseThreadFollowUpEditingRequest(payload: unknown): ThreadFollowUpEditingRequest {
  if (!isRecord(payload)) {
    throw new Error("Invalid follow-up editing payload.");
  }
  const expectedHistoryRevision = readExpectedHistoryRevision(payload.expectedHistoryRevision);
  const followUpId = readOptionalString(payload.followUpId);
  return {
    principalId: readRequiredString(payload.principalId, "Principal id is required."),
    clientCommandId: readRequiredString(payload.clientCommandId, "Client command id is required."),
    threadId: readRequiredString(payload.threadId, "Thread id is required."),
    ...(followUpId ? { followUpId } : {}),
    expectedHistoryRevision,
  };
}

function parseThreadFollowUpQueuePausedRequest(payload: unknown): ThreadFollowUpQueuePausedRequest {
  if (!isRecord(payload)) {
    throw new Error("Invalid follow-up queue pause payload.");
  }
  const expectedHistoryRevision = readExpectedHistoryRevision(payload.expectedHistoryRevision);
  if (typeof payload.paused !== "boolean") {
    throw new Error("Follow-up queue paused flag is required.");
  }
  return {
    principalId: readRequiredString(payload.principalId, "Principal id is required."),
    clientCommandId: readRequiredString(payload.clientCommandId, "Client command id is required."),
    threadId: readRequiredString(payload.threadId, "Thread id is required."),
    paused: payload.paused,
    expectedHistoryRevision,
  };
}

function parseThreadFollowUpReorderRequest(payload: unknown): ThreadFollowUpReorderRequest {
  if (!isRecord(payload)) {
    throw new Error("Invalid follow-up reorder payload.");
  }
  const expectedHistoryRevision = readExpectedHistoryRevision(payload.expectedHistoryRevision);
  const followUpIds = Array.isArray(payload.followUpIds)
    ? payload.followUpIds.map((id) => readRequiredString(id, "Follow-up id is required."))
    : [];
  if (followUpIds.length === 0) {
    throw new Error("Follow-up order is required.");
  }
  return {
    principalId: readRequiredString(payload.principalId, "Principal id is required."),
    clientCommandId: readRequiredString(payload.clientCommandId, "Client command id is required."),
    threadId: readRequiredString(payload.threadId, "Thread id is required."),
    followUpIds,
    expectedHistoryRevision,
  };
}

function parseThreadFollowUpUpdateRequest(payload: unknown): ThreadFollowUpUpdateRequest {
  if (!isRecord(payload)) {
    throw new Error("Invalid follow-up update payload.");
  }
  const expectedHistoryRevision = readExpectedHistoryRevision(payload.expectedHistoryRevision);
  const threadId = readRequiredString(payload.threadId, "Thread id is required.");
  const followUpId = readRequiredString(payload.followUpId, "Follow-up id is required.");
  const attachments = parsePromptImageAttachments(payload.attachments);
  const prompt = resolveThreadMessagePrompt(payload.prompt);
  if (!prompt && attachments.length === 0) {
    throw new Error("Follow-up message is required.");
  }
  return {
    principalId: readRequiredString(payload.principalId, "Principal id is required."),
    clientCommandId: readRequiredString(payload.clientCommandId, "Client command id is required."),
    threadId,
    followUpId,
    prompt,
    ...(attachments.length > 0 ? { attachments } : {}),
    expectedHistoryRevision,
  };
}

function parseThreadUpdateRuntimeConfigRequest(payload: unknown): ThreadUpdateRuntimeConfigRequest {
  if (!isRecord(payload)) {
    throw new Error("Invalid runtime config payload.");
  }
  return {
    principalId: readRequiredString(payload.principalId, "Principal id is required."),
    clientCommandId: readRequiredString(payload.clientCommandId, "Client command id is required."),
    threadId: readRequiredString(payload.threadId, "Thread id is required."),
    runtimeConfig: parseThreadRuntimeConfigInput(payload.runtimeConfig),
    expectedHistoryRevision: readExpectedHistoryRevision(payload.expectedHistoryRevision),
  };
}

function readExpectedHistoryRevision(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("Expected history revision is required.");
  }
  return value;
}

function readRequiredString(value: unknown, message: string): string {
  const text = readOptionalString(value);
  if (!text) {
    throw new Error(message);
  }
  return text;
}

function parsePromptImageAttachments(value: unknown): PromptImageAttachment[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const attachments: PromptImageAttachment[] = [];
  for (const entry of value) {
    if (!isPromptImageAttachmentRecord(entry)) {
      throw new Error("Invalid image attachment.");
    }
    attachments.push({
      mediaType: entry.mediaType,
      ...(entry.data?.trim() ? { data: entry.data.trim() } : {}),
      ...(entry.path?.trim() ? { path: entry.path.trim() } : {}),
      ...(entry.contentRef?.trim() ? { contentRef: entry.contentRef.trim() } : {}),
      ...(entry.byteLength !== undefined ? { byteLength: entry.byteLength } : {}),
    });
  }
  return attachments;
}

async function normalizeComposerDraftAttachments(
  contextKey: string,
  attachments: readonly PromptImageAttachment[],
): Promise<PromptImageAttachment[]> {
  if (attachments.length === 0) {
    return [];
  }
  const existing = conversationStore.getComposerDraft(contextKey);
  const previousPaths = promptImageFileStore.collectAttachmentPaths(existing?.attachments);
  const next: PromptImageAttachment[] = [];
  const keptPaths = new Set<string>();

  for (const attachment of attachments) {
    const filePath = attachment.path?.trim();
    if (filePath && promptImageFileStore.isManagedPath(filePath)) {
      next.push({
        mediaType: attachment.mediaType,
        path: filePath,
        ...(attachment.contentRef?.trim() ? { contentRef: attachment.contentRef.trim() } : {}),
        ...(attachment.byteLength !== undefined ? { byteLength: attachment.byteLength } : {}),
      });
      keptPaths.add(filePath);
      continue;
    }
    const contentRef = attachment.contentRef?.trim();
    if (contentRef) {
      next.push({
        mediaType: attachment.mediaType,
        contentRef,
        ...(attachment.byteLength !== undefined ? { byteLength: attachment.byteLength } : {}),
      });
      continue;
    }
    const data = attachment.data?.trim();
    if (!data) {
      continue;
    }
    const staged = await promptImageFileStore.stageComposerImage({
      contextKey,
      imageId: `draft_${randomUUID()}`,
      mediaType: attachment.mediaType,
      dataBase64: data,
    });
    next.push({
      mediaType: attachment.mediaType,
      path: staged.path,
      contentRef: staged.contentRef,
      byteLength: staged.byteLength,
    });
    keptPaths.add(staged.path);
  }

  const released = previousPaths.filter((filePath) => !keptPaths.has(filePath));
  if (released.length > 0) {
    await promptImageFileStore.releasePaths(released);
  }
  return next;
}

async function loadPromptAttachmentsForRuntime(
  attachments?: readonly PromptImageAttachment[],
): Promise<PromptImageAttachment[] | undefined> {
  if (!attachments?.length) {
    return undefined;
  }
  return promptImageFileStore.resolveAttachmentsForRuntime(attachments);
}

function isPromptImageMediaType(value: unknown): value is PromptImageAttachment["mediaType"] {
  return value === "image/jpeg" || value === "image/png" || value === "image/gif" || value === "image/webp";
}

function threadAcceptsLiveFollowUp(
  threadId: string,
  status: ThreadStatus,
  isAsyncClarificationAnswer = false,
): boolean {
  return threadAcceptsQueuedFollowUp({
    status,
    isAsyncClarificationAnswer,
    hasEditingFollowUp: editingThreadFollowUpByThread.has(threadId),
    followUpQueuePaused: Boolean(conversationStore.getThread(threadId)?.followUpQueuePaused),
    hasPendingBridgeApproval: Boolean(getPendingPlanApprovalForThread(threadId)),
    // Any pending question, blocking or not: this is the acceptance gate that lets a
    // finished thread take one more message while a question is still on screen — which
    // is exactly how an async answer gets back into the conversation.
    hasPendingClarification: Boolean(getPendingClarificationForThread(threadId)),
    hasPendingBashApproval: Boolean(getPendingBashApprovalForThread(threadId)),
    hasPendingPlanApproval: Boolean(getPendingPlanApprovalForThread(threadId)),
  });
}

function isAsyncClarificationAnswerFollowUp(followUp: ThreadPendingFollowUp): boolean {
  return Boolean(
    followUp.conversationMessageId &&
      conversationStore
        .conversationV2()
        .isAsyncClarificationAnswer(followUp.threadId, followUp.conversationMessageId),
  );
}

/**
 * Mid-turn delivery for Claude (streamInput), Codex (turn/steer) and PI (AgentSession.steer).
 * Pure-text only; attachments / blocked approvals / no accepting port stay queued.
 * Returns a handled row (applied, failed, or concurrently finalized); undefined
 * only when the row is safely queued for the existing drain/interrupt path.
 *
 * The queue row remains the only visible representation until the provider
 * confirms the push. The user bubble is written after that confirmation so a
 * failed or unknown delivery cannot look like a sent prompt.
 */
async function tryDeliverFollowUpViaMidTurn(
  thread: ThreadSummary,
  followUp: ThreadPendingFollowUp,
): Promise<ThreadPendingFollowUp | undefined> {
  if (!coreSupportsMidTurnFollowUp(thread.coreKind)) {
    return undefined;
  }
  if ((followUp.attachments?.length ?? 0) > 0) {
    return undefined;
  }
  const prompt = followUp.prompt.trim();
  if (!prompt) {
    return undefined;
  }
  const isCodex = thread.coreKind === "codex";
  const isPi = thread.coreKind === "pi";
  const midTurnLabel = isCodex ? "Codex turn/steer" : isPi ? "PI steer" : "Claude streamInput";
  let runtimePrompt = "";
  const claimed = await withThreadFollowUpLock(thread.id, async () => {
    const currentThread = conversationStore.getThread(thread.id);
    if (!currentThread) throw new Error("Thread was not found.");
    const currentFollowUp = conversationStore.getThreadFollowUp(thread.id, followUp.id);
    if (
      !currentFollowUp ||
      currentFollowUp.status !== "queued" ||
      (currentFollowUp.attachments?.length ?? 0) > 0 ||
      !currentFollowUp.prompt.trim()
    ) {
      return undefined;
    }
    if (
      shouldBlockThreadFollowUpDrain({
        hasPendingBridgeApproval: Boolean(getPendingPlanApprovalForThread(thread.id)),
        // An async question must not block mid-turn delivery of an unrelated follow-up.
        hasPendingClarification: hasPendingBlockingClarificationForThread(thread.id),
        hasEditingFollowUp: editingThreadFollowUpByThread.has(thread.id),
        hasFollowUpQueuePaused: Boolean(currentThread.followUpQueuePaused),
        isAsyncClarificationAnswer: isAsyncClarificationAnswerFollowUp(currentFollowUp),
        threadStatus: currentThread.status,
        hasStoredPendingPlan: Boolean(conversationStore.getPendingPlan(thread.id)),
      })
    ) {
      return undefined;
    }
    if (!activeRunRuntimeState.hasRun(thread.id)) {
      return undefined;
    }

    if (isCodex) {
      if (!codexMidTurnPorts.isAccepting(thread.id)) {
        return undefined;
      }
    } else if (isPi) {
      // PI steer needs a live AgentSession run; an idle session keeps the row queued.
      if (!isPiThreadMidTurnAccepting(thread.id)) {
        return undefined;
      }
    } else if (!claudeMidTurnPorts.isAccepting(thread.id)) {
      return undefined;
    }

    const excludeFollowUpId = editingFollowUpClaimExclusion(thread.id);
    runtimePrompt = await composerReferenceService.resolvePrompt(thread.id, currentFollowUp.prompt.trim());
    return conversationStore.claimThreadFollowUpStreamingPush(thread.id, followUp.id, {
      ...(excludeFollowUpId ? { excludeFollowUpId } : {}),
    });
  });
  if (!claimed) {
    logEcoDiag(
      isCodex
        ? "follow_up.turn_steer_claim_miss"
        : isPi
          ? "follow_up.pi_steer_claim_miss"
          : "follow_up.stream_input_claim_miss",
      {
        threadId: shortThreadId(thread.id),
        followUpId: followUp.id,
      },
    );
    return conversationStore.getThreadFollowUp(thread.id, followUp.id);
  }

  const push = isCodex
    ? await codexMidTurnPorts.tryPushUserText(thread.id, runtimePrompt, {
        clientUserMessageId: followUp.id,
      })
    : isPi
      ? await pushPiMidTurnSteer(thread.id, runtimePrompt)
      : await claudeMidTurnPorts.tryPushUserText(thread.id, runtimePrompt, {
          uuid: followUp.id,
        });

  if (!push.ok) {
    if (push.deliveryUnknown) {
      midTurnLocalUserPromptFollowUpIds.delete(claimed.id);
      const failed =
        conversationStore.markThreadFollowUpDeliveryUnknown(
          thread.id,
          claimed.id,
          `${midTurnLabel} delivery is unknown: ${push.reason}`,
        ) ?? claimed;
      if (followUp.conversationMessageId) {
        failAcceptedV2Messages(thread.id, [followUp.conversationMessageId], push.reason);
      }
      emitThreadEvent(
        thread.id,
        "thread.follow_up.delivery_unknown",
        isCodex
          ? "Codex mid-turn 注入结果未知；为避免重复执行，不会自动重发。"
          : isPi
            ? "PI mid-turn 注入结果未知；为避免重复执行，不会自动重发。"
            : "Claude mid-turn 注入结果未知；为避免重复执行，不会自动重发。",
        "system",
        false,
        { followUp: failed },
      );
      return failed;
    }
    const requeued =
      conversationStore.requeueThreadFollowUpStreamingPush(thread.id, claimed.id, {
        error: push.reason,
      }) ?? claimed;
    // No local prompt row was written before the push. Let the later queue drain
    // record/finalize it after a real continuation starts.
    midTurnLocalUserPromptFollowUpIds.delete(claimed.id);
    emitThreadEvent(
      thread.id,
      "thread.follow_up.push_failed",
      `Mid-turn 注入失败，已保留排队：${formatFollowUpDrainError(push.reason)}`,
      "system",
      false,
      { followUp: requeued },
    );
    logEcoDiag(
      isCodex
        ? "follow_up.turn_steer_failed"
        : isPi
          ? "follow_up.pi_steer_failed"
          : "follow_up.stream_input_failed",
      {
        threadId: shortThreadId(thread.id),
        followUpId: followUp.id,
        reason: push.reason,
      },
    );
    return undefined;
  }

  if (!isCodex && !isPi) {
    const known = recentStreamingPushFollowUpIds.get(thread.id) ?? new Set<string>();
    known.add(claimed.id);
    recentStreamingPushFollowUpIds.set(thread.id, known);
  }

  const applied = conversationStore.markThreadFollowUpStreamingPushApplied(thread.id, claimed.id);
  if (!applied) {
    midTurnLocalUserPromptFollowUpIds.delete(claimed.id);
    const failed =
      conversationStore.markThreadFollowUpDeliveryUnknown(
        thread.id,
        claimed.id,
        isCodex
          ? "Codex accepted turn/steer, but Eco could not commit the applied state."
          : isPi
            ? "PI accepted steer, but Eco could not commit the applied state."
            : "Claude accepted streamInput, but Eco could not commit the applied state.",
      ) ?? claimed;
    if (followUp.conversationMessageId) {
      failAcceptedV2Messages(
        thread.id,
        [followUp.conversationMessageId],
        `${midTurnLabel} accepted the prompt, but Eco could not commit the applied state.`,
      );
    }
    logEcoDiag(
      isCodex
        ? "follow_up.turn_steer_commit_miss"
        : isPi
          ? "follow_up.pi_steer_commit_miss"
          : "follow_up.stream_input_commit_miss",
      {
        threadId: shortThreadId(thread.id),
        followUpId: followUp.id,
      },
    );
    return failed;
  }

  // The provider has accepted the irreversible push. Only now expose the user
  // bubble and finalize the durable V2 message, using this confirmation time
  // instead of the earlier queue-acceptance time for Feed ordering.
  // A Codex item receipt can arrive before turn/steer returns. Its exact client
  // id already recorded and bound the prompt; do not add another unbound source.
  const codexReceiptRecorded = Boolean(
    isCodex &&
      claimed.conversationMessageId &&
      conversationStore.conversationV2().getMessage(thread.id, claimed.conversationMessageId)?.historyTarget
        ?.userMessageId,
  );
  if (!codexReceiptRecorded)
    await recordUserPrompt(
      thread.id,
      claimed.prompt.trim(),
      claimed.attachments,
      claimed.conversationMessageId ? [claimed.conversationMessageId] : undefined,
      // Stamp the durable message in the explicit post-push finalization below,
      // rather than at the time this local activity row is assembled.
      { finalizeAcceptedMessages: false },
    );
  midTurnLocalUserPromptFollowUpIds.add(claimed.id);

  if (followUp.conversationMessageId) {
    await finalizeAcceptedV2Messages(thread.id, [followUp.conversationMessageId]);
  }

  emitThreadEvent(
    thread.id,
    "thread.follow_up.applied",
    isCodex
      ? "已注入当前 Codex 回合（streaming_push / turn/steer）。"
      : isPi
        ? "已引导当前 PI 回合（mid-turn steer）。"
        : "已注入当前 Claude 回合（streaming_push）。",
    "user",
    false,
    { followUp: applied },
  );
  releaseFollowUpQueuePauseWhenEmpty(thread.id);
  return applied;
}

/**
 * PI mid-turn steer through the live in-process AgentSession.
 *
 * `steer` fails closed: it throws (and reclaims any orphaned queue entry) when the run is
 * no longer accepting, so the caller requeues the row instead of pretending it landed.
 * PI steering is always recoverable in-process, so failures are never `deliveryUnknown`.
 */
async function pushPiMidTurnSteer(
  threadId: string,
  prompt: string,
): Promise<{ ok: true } | { ok: false; reason: string; retriable: boolean; deliveryUnknown: boolean }> {
  try {
    await steerPiThreadMidTurn(threadId, prompt);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      reason: errorMessage(error),
      retriable: true,
      deliveryUnknown: false,
    };
  }
}

/**
 * `still_queued` messages survive interrupt and may start immediately. Closing the
 * Query after the receipt makes their final outcome unknowable, so never resend them.
 * `cancelled` (from interrupt cancelQueued) will not run — mark them cancelled, not unknown.
 */
function reconcileInterruptedStreamingPushFollowUps(
  threadId: string,
  stillQueued: readonly string[],
  cancelled: readonly string[] = [],
): void {
  const knownIds = recentStreamingPushFollowUpIds.get(threadId);
  if (!knownIds || knownIds.size === 0) {
    if (stillQueued.length > 0 || cancelled.length > 0) {
      logEcoDiag("follow_up.still_queued_unmapped", {
        threadId: shortThreadId(threadId),
        stillQueued: stillQueued.slice(0, 20),
        cancelled: cancelled.slice(0, 20),
      });
    }
    return;
  }
  const cancelledSet = new Set(cancelled.map((id) => id.trim()).filter(Boolean));
  for (const uuid of cancelledSet) {
    if (!knownIds.has(uuid)) {
      logEcoDiag("follow_up.cancelled_unmapped", {
        threadId: shortThreadId(threadId),
        uuid,
        reason: "interrupt cancelled uuid is not a known Eco streaming_push follow-up id",
      });
      continue;
    }
    const cancelledFollowUp = conversationStore.markThreadFollowUpInterruptCancelled(
      threadId,
      uuid,
      "Cancelled by interrupt (cancelQueued).",
    );
    if (cancelledFollowUp) {
      emitThreadEvent(
        threadId,
        "thread.follow_up.cancelled",
        "中断已取消排队中的 mid-turn 消息。",
        "system",
        false,
        { followUp: cancelledFollowUp },
      );
    }
  }
  const still = new Set(stillQueued.map((id) => id.trim()).filter(Boolean));
  for (const uuid of still) {
    if (cancelledSet.has(uuid)) {
      continue;
    }
    if (!knownIds.has(uuid)) {
      logEcoDiag("follow_up.delivery_unknown", {
        threadId: shortThreadId(threadId),
        uuid,
        reason: "interrupt still_queued uuid is not a known Eco streaming_push follow-up id",
      });
      continue;
    }
    const failed = conversationStore.markThreadFollowUpDeliveryUnknown(
      threadId,
      uuid,
      "Message survived interrupt, but the Query closed before Eco could prove final delivery.",
    );
    if (failed) {
      emitThreadEvent(
        threadId,
        "thread.follow_up.delivery_unknown",
        "中断后无法确认 mid-turn 消息是否已执行；为避免重复执行，不会自动重发。",
        "system",
        false,
        { followUp: failed },
      );
    }
  }
}

function buildThreadFollowUpMutationResult(followUp: ThreadPendingFollowUp): ThreadFollowUpMutationResult {
  const safeFollowUp = sanitizeThreadFollowUpForWire(followUp);
  return {
    followUp: safeFollowUp,
    followUps: conversationStore.listThreadFollowUps(followUp.threadId).map(sanitizeThreadFollowUpForWire),
  };
}

function emitThreadFollowUpEvent(followUp: ThreadPendingFollowUp, type: string, message: string): void {
  emitThreadEvent(followUp.threadId, type, message, "user", false, {
    followUp: sanitizeThreadFollowUpForWire(followUp),
  });
}

/** Follow-up events and command receipts never expose local attachment paths. */
function sanitizeThreadFollowUpForWire(followUp: ThreadPendingFollowUp): ThreadPendingFollowUp {
  if (!followUp.attachments?.length) return followUp;
  const attachments = followUp.attachments.flatMap((attachment) => {
    const contentRef = attachment.contentRef?.trim() ?? "";
    const data = attachment.data?.trim() ?? "";
    const byteLength =
      typeof attachment.byteLength === "number" &&
      Number.isSafeInteger(attachment.byteLength) &&
      attachment.byteLength >= 0
        ? attachment.byteLength
        : undefined;
    if (!isPromptImageContentRef(contentRef) && !data) {
      return [];
    }
    return [
      {
        mediaType: attachment.mediaType,
        ...(isPromptImageContentRef(contentRef) ? { contentRef } : { data }),
        ...(byteLength !== undefined ? { byteLength } : {}),
      },
    ];
  });
  const { attachments: _attachments, ...rest } = followUp;
  return attachments.length > 0 ? { ...rest, attachments } : rest;
}

function formatFollowUpQueuedMessage(followUp: ThreadPendingFollowUp): string {
  if (followUp.priority === "escalated") {
    return "已记录后续消息，并标记为需要立即处理。";
  }
  return "";
}

function noteSdkSessionRouteChange(threadId: string, roleRoutes: readonly RuntimeRoleRouteConfig[]): void {
  const stored = conversationStore.getRouteFingerprint(threadId);
  if (!stored || routesMatchFingerprint(roleRoutes, stored)) {
    return;
  }
  const session = conversationStore.getSdkSession(threadId);
  if (!session?.sessionId) {
    return;
  }
  const thread = conversationStore.getThread(threadId);
  const workspacePath = thread?.workspacePath ?? "";
  const sessionCwd = workspacePath ? normalizeSessionCwd(workspacePath, session.cwd) : session.cwd.trim();
  const decision = decideClaudeResume({
    sessionId: session.sessionId,
    previousRoutes: { fingerprint: stored },
    nextRoutes: snapshotClaudeResumeRoutes(roleRoutes),
    sessionCwd,
    nextCwd: sessionCwd,
    sessionCwdExists: existsSync(sessionCwd),
  });
  logEcoDiagThrottled(
    `sdk-session-route-change:${threadId}`,
    "sdk_session.route_changed",
    {
      threadId: shortThreadId(threadId),
      decision: decision.kind,
      reason: decision.kind === "resume" ? "route_drift_resume_ok" : decision.reason,
    },
    30_000,
  );
  // Do not clearSdkSession here — resume policy runs at resolveResumeOptions.
}

function recordThreadRouteFingerprint(threadId: string, routes: readonly RuntimeRoute[]): void {
  conversationStore.saveRouteFingerprint(threadId, computeRouteFingerprint(roleRoutesFromRuntime(routes)));
}

/**
 * Mid-session heal for disconnect / ghost ActiveRun wedges.
 * Safe to call before continue/retry: clears ACP ghost runs, then applies the same
 * orphan status recovery used after crash (running→idle / pending plan→awaiting_plan).
 */
function healOrphanedThreadBeforeContinuation(threadId: string): void {
  const thread = conversationStore.getThread(threadId);
  if (!thread) {
    return;
  }
  const hasPendingPlan = Boolean(conversationStore.getPendingPlan(threadId));
  if (
    shouldClearGhostAcpActiveRun({
      coreKind: thread.coreKind,
      status: thread.status,
      hasActiveRun: activeRunRuntimeState.hasRun(threadId),
      acpTurnInFlight: acpThreadHasInFlightTurn(threadId),
      hasPendingPlan,
      hasPendingPlanBridge: Boolean(getPendingPlanApprovalForThread(threadId)),
    })
  ) {
    process.stderr.write(
      `[eco] clearing ghost ACP active run (${threadId}): status=${thread.status} no in-flight turn\n`,
    );
    cancelAcpThread(threadId);
    activeRunRuntimeState.abortRun(threadId, "orphaned acp active run");
    finishActiveRun(threadId);
  }

  if (activeRunRuntimeState.hasRun(threadId)) {
    return;
  }

  const recoveryAction = resolveOrphanedThreadRecoveryAction({
    status: conversationStore.getThread(threadId)?.status ?? thread.status,
    hasActiveRun: false,
    hasPendingPlan: Boolean(conversationStore.getPendingPlan(threadId)),
  });
  if (recoveryAction === "awaiting_plan") {
    restoreThreadAwaitingPlanAfterRecovery(threadId);
    return;
  }
  if (recoveryAction !== "idle") {
    return;
  }
  updateThread(threadId, {
    status: "idle",
    message: "",
  });
  emitThreadEvent(threadId, "thread.idle", "已从异常中断恢复。", "system");
}

/** After a crash, SQLite may still say running while no runtime run is active. */
function recoverOrphanedRunningThreads(logStartupStage?: (stage: string) => void): void {
  getConversationForkCommands().recover();
  logStartupStage?.("recovery-gate.start");
  const threads = conversationStore.listThreads();
  const v2 = conversationStore.conversationV2();
  const migrator = conversationStore.conversationV2LegacyMigrator();
  const recoverableThreads = threads.filter(
    (thread) => v2.hasConversation(thread.id) && !migrator.hasResumableMigration(thread.id),
  );
  const deferredLegacyCount = threads.length - recoverableThreads.length;
  if (deferredLegacyCount > 0) {
    logUpstream("conversation.v1-lazy-migration.pending", { conversationCount: deferredLegacyCount });
  }
  const failures = conversationRecoveryGate.inspect(
    recoverableThreads.map((thread) => thread.id),
    (threadId) => {
      conversationStore.listRunAttempts(threadId);
      conversationStore.listAgentInstances(threadId);
    },
  );
  logStartupStage?.("recovery-gate.completed");
  for (const [threadId, failure] of failures) {
    conversationStore.updateThread(threadId, {
      status: "failed",
      message: `V2 存储恢复已阻断：${failure.message}`,
    });
    logEcoDiag("conversation-v2.recovery-blocked", { threadId, code: failure.code, reason: failure.message });
  }
  recoverAsyncClarificationCommands(conversationStore.conversationV2());
  failInterruptedInteractionCommands(conversationStore.conversationV2());
  failInterruptedCancelCommands(conversationStore.conversationV2());
  failInterruptedFollowUpCommands(conversationStore.conversationV2());
  failInterruptedRuntimeConfigCommands(conversationStore.conversationV2());
  recoverInterruptedPlanCommands(
    conversationStore.conversationV2(),
    (threadId) => conversationStore.getThread(threadId),
    {
      isConversationBlocked: (threadId) => conversationRecoveryGate.isBlocked(threadId),
      listRunAttempts: (threadId) => conversationStore.listRunAttempts(threadId),
      clearPendingPlanForCommand: (threadId, command, checkpointName) =>
        conversationStore.clearPendingPlanForCommand(threadId, command, checkpointName),
      verifySnapshotArtifact: (job, artifact) => {
        const context = job.request.context;
        const thread =
          context && typeof context === "object" && !Array.isArray(context)
            ? (context as Record<string, unknown>).thread
            : undefined;
        const workspacePath =
          thread && typeof thread === "object" && !Array.isArray(thread)
            ? (thread as Record<string, unknown>).workspacePath
            : undefined;
        if (typeof workspacePath !== "string" || !workspacePath.trim()) {
          return {
            ok: false,
            reason: "Frozen plan context has no workspace path for snapshot verification.",
          };
        }
        return verifyApprovedPlanArtifact({
          workspacePath,
          threadId: job.conversationId,
          absolutePath: artifact.absolutePath,
          relativePath: artifact.relativePath,
          contentHash: artifact.contentHash,
        });
      },
    },
  );
  logStartupStage?.("interrupted-commands.reconciled");
  const preparedRedispatches: Array<
    Extract<HistoryCommandRecoveryDecision, { kind: "redispatch_prepared" }>
  > = [];
  for (const thread of recoverableThreads) {
    if (conversationRecoveryGate.isBlocked(thread.id)) continue;
    if (!activeRunRuntimeState.hasRun(thread.id)) {
      settleRecoveredLifecycleRecords(thread.id, "failed");
      const commandRecovery = conversationStore.reconcileRecoverableHistoryCommands(thread.id);
      for (const decision of commandRecovery) {
        logEcoDiag("conversation-v2.command-recovery-pending", {
          threadId: thread.id,
          clientCommandId: decision.job.clientCommandId,
          decision: decision.kind,
          ...(decision.kind === "integrity_failure" ? { reason: decision.reason } : {}),
        });
        if (decision.kind === "redispatch_prepared") {
          preparedRedispatches.push(decision);
        } else if (
          (decision.kind === "claim" || decision.kind === "prepare_runtime_dispatch") &&
          decision.job.request.rewind === false
        ) {
          const prepared = recoverNonRewindRetryToPrepared({
            decision,
            v2: conversationStore.conversationV2(),
            coreKind: thread.coreKind,
          });
          if (prepared) preparedRedispatches.push(prepared);
        }
      }
      settleRecoveredStreamingPushFollowUps(thread.id);
    }
  }
  logStartupStage?.("orphaned-run-loop.completed");
  for (const thread of recoverableThreads) {
    if (conversationRecoveryGate.isBlocked(thread.id)) continue;
    if (
      shouldClearGhostAcpActiveRun({
        coreKind: thread.coreKind,
        status: thread.status,
        hasActiveRun: activeRunRuntimeState.hasRun(thread.id),
        acpTurnInFlight: acpThreadHasInFlightTurn(thread.id),
        hasPendingPlan: Boolean(conversationStore.getPendingPlan(thread.id)),
        hasPendingPlanBridge: Boolean(getPendingPlanApprovalForThread(thread.id)),
      })
    ) {
      process.stderr.write(`[eco] startup: clearing ghost ACP active run (${thread.id})\n`);
      cancelAcpThread(thread.id);
      activeRunRuntimeState.abortRun(thread.id, "orphaned acp active run");
      finishActiveRun(thread.id);
    }
  }
  logStartupStage?.("ghost-run-loop.completed");
  for (const thread of recoverableThreads) {
    if (conversationRecoveryGate.isBlocked(thread.id)) continue;
    if (activeRunRuntimeState.hasRun(thread.id)) {
      continue;
    }
    const pendingPlan = conversationStore.getPendingPlan(thread.id);
    const recoveryAction = resolveOrphanedThreadRecoveryAction({
      status: thread.status,
      hasActiveRun: false,
      hasPendingPlan: Boolean(pendingPlan),
    });
    if (recoveryAction === "awaiting_plan") {
      restoreThreadAwaitingPlanAfterRecovery(thread.id);
      continue;
    }
    if (recoveryAction !== "idle") {
      continue;
    }
    // An unexpected process exit has the same queue safety boundary as Stop.
    // Leave unsent messages visible and paused for an explicit Resume.
    autoPauseFollowUpQueueWhenQueuedRemain(thread.id);
    updateThread(thread.id, {
      status: "idle",
      message: "",
    });
    emitThreadEvent(thread.id, "thread.idle", "已从异常退出恢复。", "system");
  }
  logStartupStage?.("idle-run-loop.completed");
  for (const decision of preparedRedispatches) {
    void redispatchPreparedHistoryCommand(decision).catch((error) => {
      process.stderr.write(
        `[eco] prepared history command redispatch failed (${decision.job.conversationId}/${decision.job.clientCommandId}): ${errorMessage(error)}\n`,
      );
    });
  }
}

async function redispatchPreparedHistoryCommand(
  decision: Extract<HistoryCommandRecoveryDecision, { kind: "redispatch_prepared" }>,
): Promise<void> {
  const { job } = decision;
  const prompt = typeof job.request.prompt === "string" ? job.request.prompt.trim() : "";
  const attachments = parsePromptImageAttachments(job.request.attachments);
  if (
    job.request.attachments !== undefined &&
    (!Array.isArray(job.request.attachments) || attachments.length !== job.request.attachments.length)
  ) {
    conversationStore.conversationV2().failCommand(job.principalId, job.conversationId, job.clientCommandId, {
      code: CONVERSATION_V2_ERROR.integrityFailure,
      reason: "Prepared history command attachments are malformed.",
    });
    return;
  }
  if (!prompt && attachments.length === 0 && job.request.continueInterrupted !== true) {
    conversationStore.conversationV2().failCommand(job.principalId, job.conversationId, job.clientCommandId, {
      code: CONVERSATION_V2_ERROR.invalidParams,
      reason: "Prepared history command request has no prompt or attachments.",
    });
    return;
  }
  const forkCreated = job.checkpoints.find((checkpoint) => checkpoint.name === "history.sdk_fork_created");
  const forkSkipped = job.checkpoints.some((checkpoint) => checkpoint.name === "history.sdk_fork_skipped");
  const nonRewindRetry = job.commandType === "history.retry" && job.request.rewind === false;
  if (!nonRewindRetry && !forkCreated && !forkSkipped) {
    conversationStore.conversationV2().failCommand(job.principalId, job.conversationId, job.clientCommandId, {
      code: CONVERSATION_V2_ERROR.integrityFailure,
      reason: "Prepared history command has no durable fork decision.",
    });
    return;
  }
  const forkedSessionId =
    typeof forkCreated?.payload.forkedSessionId === "string"
      ? forkCreated.payload.forkedSessionId.trim()
      : "";
  if (!nonRewindRetry && forkCreated && !forkedSessionId) {
    conversationStore.conversationV2().failCommand(job.principalId, job.conversationId, job.clientCommandId, {
      code: CONVERSATION_V2_ERROR.integrityFailure,
      reason: "Prepared history command has an invalid forked session identity.",
    });
    return;
  }
  if (job.request.runtimeConfig !== undefined && !isRecord(job.request.runtimeConfig)) {
    conversationStore.conversationV2().failCommand(job.principalId, job.conversationId, job.clientCommandId, {
      code: CONVERSATION_V2_ERROR.integrityFailure,
      reason: "Prepared history command runtime config is malformed.",
    });
    return;
  }
  const runtimeConfigInput = job.request.runtimeConfig as ThreadRuntimeConfigInput | undefined;
  await startThreadContinuation({
    threadId: job.conversationId,
    prompt,
    ...(job.request.continueInterrupted === true ? { codexEmptyInput: true } : {}),
    ...(attachments.length > 0 && job.request.continueInterrupted !== true ? { attachments } : {}),
    ...(runtimeConfigInput ? { runtimeConfigInput } : {}),
    displayPrompt: prompt,
    skipRecordUserPrompt: true,
    historyCommand: {
      principalId: job.principalId,
      clientCommandId: job.clientCommandId,
    },
    preparedRuntimeDispatch: {
      plannedAttemptId: decision.plannedAttemptId,
      commandDispatch: decision.commandDispatch,
    },
    ...(forkedSessionId ? { preparedResumeOverride: { resumeSessionId: forkedSessionId } } : {}),
  });
}

function settleRecoveredStreamingPushFollowUps(threadId: string): void {
  const orphaned = conversationStore
    .listThreadFollowUps(threadId, { statuses: ["delivered"] })
    .filter((followUp) => followUp.deliveryMode === "streaming_push");
  for (const followUp of orphaned) {
    const failed = conversationStore.markThreadFollowUpDeliveryUnknown(
      threadId,
      followUp.id,
      "Application exited while a mid-turn push was in flight; delivery is unknown.",
    );
    if (!failed) {
      continue;
    }
    emitThreadEvent(
      threadId,
      "thread.follow_up.delivery_unknown",
      "应用退出时 mid-turn 消息仍在发送中；无法确认是否已执行，因此不会自动重发。",
      "system",
      false,
      { followUp: failed },
    );
  }
}

function restoreThreadAwaitingPlanAfterRecovery(threadId: string): void {
  const pendingPlan = conversationStore.getPendingPlan(threadId);
  if (!pendingPlan) {
    return;
  }
  updateThread(threadId, {
    status: "awaiting_plan",
    message: "",
  });
  emitThreadEvent(threadId, "thread.awaiting_plan", "已从异常退出恢复，待批准计划。", "system", false, {
    plan: {
      userPrompt: pendingPlan.userPrompt,
      analysis: pendingPlan.analysis,
      plan: pendingPlan.plan,
    },
  });
}

function settleRecoveredLifecycleRecords(
  threadId: string,
  runStatus: Exclude<RunAttemptStatus, "running">,
): void {
  let subagentSessionsSettled = 0;
  for (const session of conversationStore.listSubagentSessions(threadId)) {
    if (session.status !== "active") continue;
    conversationStore.markSubagentSessionStopped(threadId, session.agentId);
    subagentMetricsRegistry.onSubagentStop(threadId, {
      agentId: session.agentId,
      role: session.role,
    });
    subagentSessionsSettled += 1;
  }
  const result = agentLifecycle.settleRecoveredThread({
    threadId,
    attempts: conversationStore.listRunAttempts(threadId),
    agents: conversationStore.listAgentInstances(threadId),
    runStatus,
  });
  if (
    result.runAttemptsSettled === 0 &&
    result.agentInstancesSettled === 0 &&
    subagentSessionsSettled === 0
  ) {
    return;
  }
  for (const runAttemptId of result.settledRunAttemptIds) {
    if (runStatus === "failed" || runStatus === "cancelled") {
      usageLedgerCoordinator.settleInterruptedStreamPartials(threadId, runAttemptId, runStatus);
    }
  }
  logEcoDiag("agent_lifecycle.recovered", {
    threadId: shortThreadId(threadId),
    runStatus,
    runAttemptsSettled: result.runAttemptsSettled,
    agentInstancesSettled: result.agentInstancesSettled,
    subagentSessionsSettled,
  });
}

async function restoreAfterExecutionFailure(
  threadId: string,
  worktreePlan: WorktreePlan,
  reason: string,
  pendingPlan?: ThreadPendingPlan & { routesJson: string },
): Promise<void> {
  if (!isDirectWorkspacePlan(worktreePlan)) {
    try {
      await gitWorktrees.discardWorktreeChanges(worktreePlan);
      emitThreadEvent(threadId, "worktree.restored", "已回退隔离工作树中的未批准更改。", "system");
    } catch (error) {
      console.error("Failed to restore worktree after execution failure:", error);
    }
  }

  if (pendingPlan) {
    conversationStore.savePendingPlan(pendingPlan);
  }

  const formattedReason = formatUserFacingRequestError(reason);
  const summary = formattedReason.length > 240 ? `${formattedReason.slice(0, 237)}…` : formattedReason;
  const failureMessage = buildPlanExecutionFailureMessage(summary);
  updateThread(threadId, {
    status: "awaiting_plan",
    message: failureMessage,
  });
  emitThreadEvent(threadId, "thread.execution_failed", summary, "system", false, {
    ...(pendingPlan && {
      plan: {
        userPrompt: pendingPlan.userPrompt,
        analysis: pendingPlan.analysis,
        plan: pendingPlan.plan,
      },
    }),
  });
}

async function dismissPendingPlan(threadId: string, message: string): Promise<void> {
  activeRunRuntimeState.abortRun(threadId, "dismissed by user");
  const dismissal = resolveThreadPendingPlanDismissal({
    threadId,
    message,
    pendingPlan: conversationStore.getPendingPlan(threadId),
    thread: conversationStore.getThread(threadId),
    resolveWorktreePlan,
    isIsolatedWorktreePlan,
  });
  conversationStore.clearPendingPlan(threadId);
  if (dismissal.kind === "cancel_worktree") {
    await handleRunCancelled(threadId, dismissal.worktreePlan, message);
    return;
  }
  updateThread(threadId, { status: "idle", message: "" });
}

function resolveWorktreePlan(workspacePath: string, threadId: string, _worktreePath?: string): WorktreePlan {
  return createSessionPlan(workspacePath, threadId);
}

function resolveWorktreeContextForThread(threadId: string): {
  workspacePath?: string;
  worktreePathHint?: string;
} {
  const thread = conversationStore.getThread(threadId);
  const pending = conversationStore.getPendingPlan(threadId);
  const workspacePath = pending?.workspacePath ?? thread?.workspacePath;
  if (!workspacePath) {
    return {};
  }
  const hintInput: Parameters<typeof resolveWorktreePathHint>[0] = {
    threadId,
    workspacePath,
  };
  const activePath = activeRunRuntimeState.worktreePlan(threadId)?.worktreePath;
  if (activePath?.trim()) {
    hintInput.activeWorktreePath = activePath.trim();
  }
  if (pending?.worktreePath?.trim()) {
    hintInput.pendingWorktreePath = pending.worktreePath.trim();
  }
  const sessionCwd = conversationStore.getSdkSession(threadId)?.cwd;
  if (sessionCwd?.trim()) {
    hintInput.sdkSessionCwd = sessionCwd.trim();
  }
  const coreSessionCwd = conversationStore.getThreadCoreSession(threadId)?.cwd;
  if (coreSessionCwd?.trim()) {
    hintInput.coreSessionCwd = coreSessionCwd.trim();
  }
  return {
    workspacePath,
    worktreePathHint: resolveWorktreePathHint(hintInput),
  };
}

async function getThreadUserMessageEdit(
  threadId: string,
  activityLineId: string,
): Promise<ThreadUserMessageEditGetResult> {
  let historyRevision = () => 0;
  const emptyCapability = (
    reasonCode: NonNullable<ThreadUserMessageEditGetResult["capability"]["reasonCode"]>,
    reason: string,
  ) => ({
    threadId,
    activityLineId,
    text: "",
    attachments: [],
    historyRevision: historyRevision(),
    capability: { status: "unavailable" as const, reasonCode, reason },
  });
  const thread = conversationStore.getThread(threadId);
  if (!thread) return emptyCapability("thread_not_found", "找不到该对话。");
  requireConversationV2Thread(threadId);
  const v2 = conversationStore.conversationV2();
  historyRevision = () => v2.head(threadId).historyRevision;
  if (thread.coreKind === "claude") {
    await hydrateClaudeUserMessageEditState(threadId);
  }
  const record = conversationStore.getUserMessageForEdit(threadId, activityLineId);
  if (!record) return emptyCapability("invalid_message", "找不到可编辑的用户消息。");
  const durableAttachmentsReadable =
    record.attachments.length > 0
      ? await Promise.all(
          record.attachments.map((attachment) => promptImageFileStore.hasReadableContentRef(attachment)),
        )
      : [];
  if (
    record.attachments.some(
      (attachment, index) => !attachment.contentRef || durableAttachmentsReadable[index] !== true,
    )
  ) {
    return {
      threadId,
      activityLineId,
      ...(record.upstreamMessageId && { upstreamMessageId: record.upstreamMessageId }),
      text: record.text,
      attachments: [],
      historyRevision: historyRevision(),
      capability: {
        status: "unavailable",
        reasonCode: "missing_durable_attachment",
        reason: "该消息只保存了图片预览，缺少可验证的原图引用，无法安全改写。请重新发送。",
      },
    };
  }
  if (thread.status === "running" || thread.status === "queued") {
    return {
      threadId,
      activityLineId,
      ...(record.upstreamMessageId && {
        upstreamMessageId: record.upstreamMessageId,
      }),
      text: record.text,
      attachments: record.attachments,
      historyRevision: historyRevision(),
      capability: {
        status: "unavailable",
        reasonCode: "thread_running",
        reason: "当前对话正在运行，请等待结束后再编辑。",
      },
    };
  }
  if (thread.coreKind !== "claude" && thread.coreKind !== "codex") {
    return {
      threadId,
      activityLineId,
      text: record.text,
      attachments: record.attachments,
      historyRevision: historyRevision(),
      capability: {
        status: "unavailable",
        reasonCode: "unsupported_core",
        reason: "当前 Harness 不支持历史消息改写。",
      },
    };
  }
  if (!thread.workspacePath || !existsSync(thread.workspacePath)) {
    return {
      threadId,
      activityLineId,
      ...(record.upstreamMessageId && {
        upstreamMessageId: record.upstreamMessageId,
      }),
      text: record.text,
      attachments: record.attachments,
      historyRevision: historyRevision(),
      capability: {
        status: "unavailable",
        reasonCode: "workspace_unavailable",
        reason: "工作区不存在，无法改写该消息。",
      },
    };
  }
  if (!record.upstreamMessageId) {
    return {
      threadId,
      activityLineId,
      text: record.text,
      attachments: record.attachments,
      historyRevision: historyRevision(),
      capability: {
        status: "unavailable",
        reasonCode: "missing_upstream_mapping",
        reason: "该消息尚未绑定到当前 SDK 会话。",
      },
    };
  }
  let upstreamMessageId = record.upstreamMessageId;
  if (thread.coreKind === "claude") {
    try {
      upstreamMessageId = await resolveCurrentClaudeUserMessageId(threadId, record.activityLineId);
    } catch (error) {
      return {
        threadId,
        activityLineId,
        text: record.text,
        attachments: record.attachments,
        historyRevision: historyRevision(),
        capability: {
          status: "unavailable",
          reasonCode: "missing_upstream_mapping",
          reason: errorMessage(error),
        },
      };
    }
  }
  return {
    threadId,
    activityLineId,
    upstreamMessageId,
    text: record.text,
    attachments: record.attachments,
    historyRevision: historyRevision(),
    capability: { status: "ready" },
  };
}

async function retryThreadFromFailedRequest(input: {
  principalId: string;
  clientCommandId: string;
  threadId: string;
  activityLineId?: string;
  prompt: string;
  hasImages: boolean;
  continueInterrupted?: boolean;
  sourceAttemptId?: string;
  expectedHistoryRevision: number;
  runtimeConfig?: ThreadRuntimeConfigInput;
}): Promise<ThreadContinueResult> {
  healOrphanedThreadBeforeContinuation(input.threadId);
  const thread = conversationStore.getThread(input.threadId);
  if (!thread) {
    throw new Error("Thread was not found.");
  }
  if (!supportsOneClickRequestRetry(thread.coreKind)) {
    throw new Error("当前 Harness 不支持一键重试失败请求。");
  }
  if (input.continueInterrupted && (thread.coreKind !== "codex" || !input.sourceAttemptId?.trim())) {
    throw new Error("Codex 继续需要有效的原执行标识。");
  }
  const activityLineId = input.activityLineId?.trim() ?? "";
  const prompt = input.prompt.trim();

  if (usesRewindOnRequestRetry(thread.coreKind)) {
    if (!activityLineId) {
      throw new Error("找不到可重试的用户消息。");
    }
    requireConversationV2Thread(input.threadId);
    const v2 = conversationStore.conversationV2();
    const existing = v2.getCommandJob(input.principalId, input.threadId, input.clientCommandId);
    let retryPrompt: string;
    let attachments: PromptImageAttachment[];
    let edit: ThreadUserMessageEditGetResult;
    if (existing) {
      if (
        existing.commandType !== "history.retry" ||
        existing.expectedHistoryRevision !== input.expectedHistoryRevision ||
        existing.request.activityLineId !== activityLineId ||
        existing.request.requestedPrompt !== prompt ||
        existing.request.hasImages !== input.hasImages
      ) {
        throw new ConversationV2Error(
          CONVERSATION_V2_ERROR.idempotencyConflict,
          "clientCommandId was already used with a different retry request.",
        );
      }
      retryPrompt = typeof existing.request.prompt === "string" ? existing.request.prompt.trim() : "";
      attachments = parsePromptImageAttachments(existing.request.attachments);
      if (
        !Array.isArray(existing.request.attachments) ||
        attachments.length !== existing.request.attachments.length
      ) {
        throw new ConversationV2Error(
          CONVERSATION_V2_ERROR.integrityFailure,
          "Stored retry attachments are malformed.",
        );
      }
      edit = {
        threadId: input.threadId,
        activityLineId,
        text: retryPrompt,
        attachments,
        historyRevision: input.expectedHistoryRevision,
        capability: { status: "ready" },
        ...(typeof existing.request.upstreamMessageId === "string" &&
        existing.request.upstreamMessageId.trim()
          ? { upstreamMessageId: existing.request.upstreamMessageId.trim() }
          : {}),
      };
    } else {
      edit = await getThreadUserMessageEdit(input.threadId, activityLineId);
      if (edit.capability.status !== "ready") {
        throw new Error(edit.capability.reason ?? "该消息当前无法重试。");
      }
      retryPrompt = edit.text.trim() || prompt;
      attachments = edit.attachments;
    }
    if (!retryPrompt && attachments.length === 0) {
      throw new Error("Message is required.");
    }
    return executeConversationRewriteCommand(
      {
        principalId: input.principalId,
        clientCommandId: input.clientCommandId,
        threadId: input.threadId,
        activityLineId,
        prompt: retryPrompt,
        attachments,
        expectedHistoryRevision: input.expectedHistoryRevision,
        ...(input.runtimeConfig ? { runtimeConfig: input.runtimeConfig } : {}),
      },
      {
        v2,
        requireConversationV2Thread,
        getThread: (id) => conversationStore.getThread(id),
        ensureThreadRuntimeConfig,
        getThreadUserMessageEdit: async () => edit,
        startThreadContinuation,
        errorMessage,
      },
      {
        commandType: "history.retry",
        durableRequestExtras: {
          requestedPrompt: prompt,
          hasImages: input.hasImages,
          ...(edit.upstreamMessageId ? { upstreamMessageId: edit.upstreamMessageId } : {}),
        },
      },
    );
  }

  requireConversationV2Thread(input.threadId);
  const v2 = conversationStore.conversationV2();
  const existing = v2.getCommandJob(input.principalId, input.threadId, input.clientCommandId);
  let retryPrompt: string;
  let storedAttachments: PromptImageAttachment[];
  if (existing) {
    if (
      existing.commandType !== "history.retry" ||
      existing.expectedHistoryRevision !== input.expectedHistoryRevision ||
      existing.request.rewind !== false ||
      existing.request.activityLineId !== activityLineId ||
      existing.request.requestedPrompt !== prompt ||
      existing.request.hasImages !== input.hasImages ||
      existing.request.continueInterrupted !== (input.continueInterrupted || undefined) ||
      existing.request.sourceAttemptId !== input.sourceAttemptId ||
      stableHash(existing.request.runtimeConfig ?? null) !== stableHash(input.runtimeConfig ?? null)
    ) {
      throw new ConversationV2Error(
        CONVERSATION_V2_ERROR.idempotencyConflict,
        "clientCommandId was already used with a different retry request.",
      );
    }
    retryPrompt = typeof existing.request.prompt === "string" ? existing.request.prompt.trim() : "";
    storedAttachments = input.continueInterrupted
      ? []
      : parsePromptImageAttachments(existing.request.attachments);
    if (
      !input.continueInterrupted &&
      (!Array.isArray(existing.request.attachments) ||
        storedAttachments.length !== existing.request.attachments.length)
    ) {
      throw new ConversationV2Error(
        CONVERSATION_V2_ERROR.integrityFailure,
        "Stored non-rewind retry attachments are malformed.",
      );
    }
  } else {
    if (thread.status === "running" || thread.status === "queued") {
      throw new Error("Wait for the current run to finish.");
    }
    const currentRevision = v2.head(input.threadId).historyRevision;
    if (currentRevision !== input.expectedHistoryRevision) {
      throw new Error("历史记录已变化，请刷新后再重试。");
    }
    if (input.continueInterrupted) {
      const attempts = conversationStore.listRunAttempts(input.threadId);
      const latest = attempts.at(-1);
      if (
        !latest ||
        latest.attemptId !== input.sourceAttemptId ||
        latest.status === "running" ||
        latest.status === "completed"
      ) {
        throw new Error("该执行已变化或尚未中断，请刷新后再继续。");
      }
      const binding = conversationStore.getThreadCoreSession(input.threadId);
      if (binding?.coreKind !== "codex" || !binding.externalSessionId.trim()) {
        throw new Error("Codex 会话绑定已丢失，无法继续原有上下文。");
      }
    }
    const message = resolveNonRewindRetryUserMessage(
      v2,
      input.threadId,
      activityLineId,
      requiresEmptyTurnForRequestRetry(thread.coreKind) && !input.continueInterrupted,
    );
    retryPrompt = message.body.trim() || prompt;
    const v2Attachments = input.continueInterrupted ? [] : parsePromptImageAttachments(message.attachments);
    if (
      v2Attachments.some(
        (attachment) => !attachment.contentRef || !isPromptImageContentRef(attachment.contentRef),
      )
    ) {
      storedAttachments = [];
    } else {
      storedAttachments = v2Attachments;
    }
  }
  if (!input.continueInterrupted && input.hasImages && storedAttachments.length === 0) {
    throw new Error("该次请求包含图片，但本地没有保存原图，无法一键重试。请重新发送。");
  }
  if (!retryPrompt && storedAttachments.length === 0 && !input.continueInterrupted) {
    throw new Error("Message is required.");
  }
  return executeNonRewindRetryCommand(
    {
      principalId: input.principalId,
      clientCommandId: input.clientCommandId,
      threadId: input.threadId,
      activityLineId,
      prompt: retryPrompt,
      requestedPrompt: prompt,
      attachments: storedAttachments,
      hasImages: input.hasImages,
      ...(input.continueInterrupted
        ? { continueInterrupted: true, sourceAttemptId: input.sourceAttemptId }
        : {}),
      expectedHistoryRevision: input.expectedHistoryRevision,
      ...(input.runtimeConfig ? { runtimeConfig: input.runtimeConfig } : {}),
    },
    {
      v2,
      getThread: (id) => conversationStore.getThread(id),
      ensureThreadRuntimeConfig,
      start: startThreadContinuation,
      errorMessage,
    },
  );
}

async function getWorkspaceChangeStatus(threadId: string): Promise<WorktreeStatusResult> {
  const thread = conversationStore.getThread(threadId);
  const workspacePath = thread?.workspacePath;
  if (!workspacePath) {
    return {
      exists: false,
      worktreePath: "",
      workspacePath: "",
      changedFiles: [],
    };
  }
  const plan = createSessionPlan(workspacePath, threadId);
  if (isDirectWorkspacePlan(plan)) {
    return {
      exists: false,
      worktreePath: workspacePath,
      workspacePath,
      changedFiles: [],
    };
  }

  try {
    const changedFiles = await gitWorktrees.changedFiles(plan);
    return {
      exists: changedFiles.length > 0,
      worktreePath: workspacePath,
      workspacePath,
      changedFiles,
    };
  } catch (error) {
    console.error("Failed to read workspace change status:", error);
    return {
      exists: false,
      worktreePath: workspacePath,
      workspacePath,
      changedFiles: [],
    };
  }
}

async function applyWorktreeChanges(plan: WorktreePlan): Promise<{
  files: string[];
  diff: string;
  threadMessage: string;
  activityMessage: string;
}> {
  if (isDirectWorkspacePlan(plan)) {
    throw new Error("该对话没有可合并的隔离工作树。");
  }

  if (!(await fileExists(plan.worktreePath))) {
    throw new Error(`找不到隔离工作树：${plan.worktreePath}`);
  }

  const { files, diff } = await gitWorktrees.collectWorktreeChanges(plan);
  if (files.length === 0) {
    const emptyMessage = "执行完成，工作树内无相对基线的文件变更。";
    return {
      files: [],
      diff: "",
      threadMessage: emptyMessage,
      activityMessage: emptyMessage,
    };
  }

  await gitWorktrees.applyWorktreeDiff(plan, diff, files);
  const summary = buildWorktreeMergeSummary(diff, files);
  return {
    files,
    diff,
    threadMessage: formatWorktreeMergeThreadMessage(files.length),
    activityMessage: serializeWorktreeMergeMessage(summary),
  };
}

async function applyWorktreeForThread(threadId: string): Promise<WorktreeApplyResult> {
  const status = await getWorkspaceChangeStatus(threadId);
  if (!status.exists) {
    throw new Error("该对话没有可合并的隔离工作树。");
  }

  const plan = resolveWorktreePlan(status.workspacePath, threadId, status.worktreePath);
  const { files, diff, threadMessage, activityMessage } = await applyWorktreeChanges(plan);
  conversationStore.saveAppliedDiff(threadId, plan.workspacePath, diff, files);
  await cleanupWorktreeForThread(threadId);
  updateThread(threadId, { status: "completed", message: "" });
  emitThreadEvent(threadId, "worktree.applied", activityMessage, "system");
  return { ok: true, files, message: threadMessage };
}

async function rollbackWorkspaceToThread(threadId: string): Promise<ThreadRollbackResult> {
  const target = conversationStore.getAppliedDiff(threadId);
  if (!target) {
    throw new Error("该对话没有已应用到工作区的变更记录，无法作为回滚点。");
  }

  const laterDiffs = conversationStore.listAppliedDiffsAfter(target.workspacePath, target.appliedAt);
  if (laterDiffs.length === 0) {
    const message = "当前工作区已经处于该对话之后的状态。";
    updateThread(threadId, { status: "idle", message: "" });
    return { ok: true, revertedThreads: 0, files: [], message };
  }

  const files = new Set<string>();
  for (const record of laterDiffs) {
    if (!record.diff.trim()) {
      conversationStore.markAppliedDiffRolledBack(record.threadId);
      continue;
    }
    const result = await runGitCommand(
      ["git", "apply", "-R", "--whitespace=nowarn", "-"],
      target.workspacePath,
      { stdin: record.diff },
    );
    if (result.exitCode !== 0) {
      throw new Error(`回滚 ${record.threadId} 失败：${result.stderr || result.stdout}`);
    }
    for (const file of record.files) {
      files.add(file);
    }
    conversationStore.markAppliedDiffRolledBack(record.threadId);
  }

  const changedFiles = [...files];
  const message =
    changedFiles.length > 0
      ? `已回滚 ${laterDiffs.length} 个后续对话的变更：${changedFiles.join(", ")}`
      : `已回滚 ${laterDiffs.length} 个后续对话的变更。`;
  updateThread(threadId, { status: "idle", message: "" });
  return {
    ok: true,
    revertedThreads: laterDiffs.length,
    files: changedFiles,
    message,
  };
}

async function getThreadAppliedDiff(threadId: string): Promise<ThreadAppliedDiffResult> {
  const record = conversationStore.getAppliedDiff(threadId);
  if (!record) {
    throw new Error("该对话没有已应用到工作区的变更记录。");
  }
  const stats = buildWorktreeMergeSummary(record.diff, record.files);
  return {
    diff: record.diff,
    files: record.files,
    fileStats: stats.files,
    totalAdditions: stats.totalAdditions,
    totalDeletions: stats.totalDeletions,
    ...(record.rolledBackAt && { rolledBackAt: record.rolledBackAt }),
  };
}

async function revertThreadAppliedDiff(threadId: string): Promise<ThreadRevertAppliedDiffResult> {
  const record = conversationStore.getAppliedDiff(threadId);
  if (!record) {
    throw new Error("该对话没有可撤销的已应用变更。");
  }
  if (record.rolledBackAt) {
    throw new Error("该对话的变更已撤销。");
  }
  if (!record.diff.trim()) {
    conversationStore.markAppliedDiffRolledBack(threadId);
    return {
      ok: true,
      files: record.files,
      message: "已撤销应用到工作区的变更。",
    };
  }

  const result = await runGitCommand(
    ["git", "apply", "-R", "--whitespace=nowarn", "-"],
    record.workspacePath,
    { stdin: record.diff },
  );
  if (result.exitCode !== 0) {
    throw new Error(`撤销失败：${result.stderr || result.stdout}`);
  }

  conversationStore.markAppliedDiffRolledBack(threadId);
  const message =
    record.files.length > 0
      ? `已撤销 ${record.files.length} 个文件的合并变更。`
      : "已撤销应用到工作区的变更。";
  updateThread(threadId, { status: "idle", message });
  emitThreadEvent(threadId, "worktree.reverted", message, "system");
  return { ok: true, files: record.files, message };
}

async function cleanupWorktreeForThread(threadId: string): Promise<void> {
  const { workspacePath, worktreePathHint } = resolveWorktreeContextForThread(threadId);
  if (!workspacePath || !worktreePathHint) {
    return;
  }
  const plan = resolveWorktreePlan(workspacePath, threadId, worktreePathHint);
  if (!isIsolatedWorktreePlan(plan)) {
    return;
  }
  await removeIsolatedWorktree(plan, threadId);
}

function createFinalizeCancelledRunDeps(): FinalizeCancelledRunDeps {
  return {
    updateThread: (threadId, patch) => updateThread(threadId, patch),
  };
}

async function listThreadActivityFromSdkSession(threadId: string): Promise<ThreadActivityLine[]> {
  return listSdkSessionActivityLines(threadId, {
    getSdkSession: (id) => conversationStore.getSdkSession(id),
    writeError: (message) => process.stderr.write(message),
  });
}

async function listSubagentActivityFromSdkSession(
  threadId: string,
  agentId: string,
): Promise<ThreadActivityLine[]> {
  return listSdkSubagentActivityLines(threadId, agentId, {
    getSdkSession: (id) => conversationStore.getSdkSession(id),
    writeError: (message) => process.stderr.write(message),
  });
}

async function handleRunCancelled(
  threadId: string,
  worktreePlan: WorktreePlan,
  message?: string,
): Promise<void> {
  // User stop lands on idle (which is drainable). Pause remaining queued follow-ups
  // so cancel cleanup does not silently send them; Resume/继续 is the explicit next step.
  // Skip for escalated follow-up interrupts: the triggering message is still in
  // "queued" state here and is force-drained right after — auto-pausing would
  // flash "排队发送已暂停" and then send the message anyway, and the paused
  // state would linger for the rest of the queue.
  if (
    !pendingEscalatedFollowUpDrain.has(threadId) &&
    threadFollowUpQueueControl.shouldPauseCancelledRun(threadId)
  ) {
    autoPauseFollowUpQueueWhenQueuedRemain(threadId);
  }
  const explicit = takePendingCancelDisposition(pendingCancelDisposition, threadId);
  await finalizeCancelledRun(threadId, worktreePlan, explicit, createFinalizeCancelledRunDeps(), message);
}

function parseStoredRoutes(routesJson: string): ResolvedModelRoute[] {
  const parsed = JSON.parse(routesJson) as ResolvedModelRoute[];
  if (!Array.isArray(parsed)) {
    throw new Error("Stored route configuration is invalid.");
  }
  return parsed;
}

function listResumableSubagentRefs(
  threadId: string,
  phase: SubagentRunPhase,
): { role: string; agentId: string }[] {
  return conversationStore.listResumableSubagentSessions(threadId, phase).map((row) => ({
    role: row.role,
    agentId: row.agentId,
  }));
}

function buildSdkHookContextExtras(
  threadId: string,
  phase: SubagentRunPhase,
  extras?: SdkRunHookContextExtras,
): Partial<EcoHookContext> {
  const peekPendingCoderTodoId = extras?.peekPendingCoderTodoId;
  const subagentAttribution: EcoSubagentAttributionHooks = {
    resolveAgentId: (input: { role: RuntimeAgentRole; parentToolUseId?: string; sessionId: string }) =>
      subagentMetricsRegistry.resolveAgentId(threadId, {
        role: input.role,
        ...(input.parentToolUseId && {
          parentToolUseId: input.parentToolUseId,
        }),
      }),
    onTaskToolUse: (toolUseId: string, input?: { role?: RuntimeAgentRole }) => {
      subagentMetricsRegistry.noteTaskToolUse(threadId, toolUseId, input?.role);
      agentLifecycle.noteTaskToolUse(threadId, toolUseId, input?.role);
    },
  };
  const subagentLaunchRegistry = getThreadSubagentLaunchRegistry(threadId);
  const subagentLaunchGate = getThreadSubagentConcurrencyGate(threadId);
  const subagentSessions = createSubagentSessionHooks(conversationStore, threadId, phase, {
    lifecycle: agentLifecycle,
    metricsRegistry: subagentMetricsRegistry,
    attribution: subagentAttribution,
    onSubagentStarted: ({ parentToolUseId }) => {
      subagentLaunchGate.releaseLaunch?.({
        ...(parentToolUseId && { toolUseId: parentToolUseId }),
      });
    },
    onTimingChanged: () => emitSubagentTimingUpdated(threadId),
    onProxyAttributionSettled: ({ agentId, role, parentToolUseId }) => {
      usageLedgerCoordinator.settleProxyPendingForSubagentStart(threadId, {
        agentId,
        role,
        ...(parentToolUseId && { parentToolUseId }),
      });
    },
    onSubagentBillingStamp: ({ agentId, role, parentToolUseId, runAttemptId }) => {
      proxyBillingStampRegistry.register(threadId, {
        agentId,
        role,
        ...(parentToolUseId && { parentToolUseId }),
        ...(runAttemptId && { runAttemptId }),
      });
    },
    onSubagentBillingStampClear: ({ agentId }) => {
      proxyBillingStampRegistry.unregister(threadId, agentId);
    },
    onTerminalReconciliation: async ({ agentId, role, agentTranscriptPath, transcriptPath }) => {
      const agentRecord = conversationStore
        .listAgentInstances(threadId)
        .find((record) => record.agentId === agentId);
      const result = await reconcileSubagentTerminalTranscript({
        threadId,
        agentId,
        role,
        ...(agentTranscriptPath && { agentTranscriptPath }),
        ...(agentRecord?.parentToolUseId && {
          parentToolUseId: agentRecord.parentToolUseId,
        }),
        bindMessageIdentity: (binding) => usageLedgerCoordinator.bindProxyMessageIdentity(threadId, binding),
        attributeFeedEvents: (messageIds, exactAgentId) =>
          conversationStore.attributeThreadRunEventsBySdkMessageIds(
            threadId,
            messageIds,
            exactAgentId,
            (conflict) =>
              logEcoDiag("subagent.feed_identity_rebound", {
                threadId: shortThreadId(threadId),
                agentId: exactAgentId,
                role,
                resolution: "exact_sdk_message_id",
                ...conflict,
              }),
          ),
        logDiagnostic: logEcoDiag,
      });
      if (result.attributedFeedEventCount > 0) {
        scheduleThreadRunProjectionUpdated(threadId);
      }
      if (!agentTranscriptPath && transcriptPath) {
        logEcoDiag("subagent.terminal_reconciliation_main_transcript_only", {
          threadId: shortThreadId(threadId),
          agentId,
          role,
          transcriptPath,
        });
      }
    },
    ...(peekPendingCoderTodoId && { todoIdHint: peekPendingCoderTodoId }),
  });
  if (subagentSessions.onDelegationLinked) {
    const linker = subagentSessions.onDelegationLinked.bind(subagentSessions);
    const wrappedLinker: SubagentDelegationLinker = (input) => {
      linker({ ...input, prompt: input.prompt ?? "" });
    };
    subagentDelegationLinkersByThread.set(threadId, wrappedLinker);
    sdkStreamActivityIngestion.registerDelegationLinker(threadId, wrappedLinker);
  }
  const { peekPendingCoderTodoId: _peek, ...rest } = extras ?? {};
  return {
    ...rest,
    subagentSessions,
    subagentLaunchGate,
    subagentMaxRuntimeMs: orchestrationGuardrails.maxSubagentRuntimeMs,
    subagentAttribution,
    subagentLaunchRegistry,
  };
}

async function withThreadSdkDriver(
  threadId: string,
  fn: (
    driver: ClaudeAgentSdkDriver,
    signal: AbortSignal,
    routes: readonly ResolvedModelRoute[],
  ) => Promise<void>,
  onContextProbe?: (phase: string, detail: Record<string, unknown>) => void,
): Promise<void> {
  const thread = conversationStore.getThread(threadId);
  if (!thread) {
    throw new Error("Thread was not found.");
  }
  requireThreadCore(thread, "claude", "create a Claude SDK driver");
  const roleRoutes = resolveRoleRoutesForThread(threadId);
  const runtimeConfig = resolveRuntimeConfigForThreadId(threadId, roleRoutes);
  if (!runtimeConfig.ok) {
    throw new Error(runtimeConfig.reason);
  }
  const attemptProxy = await startRuntimeProxy(
    runtimeConfig.routes,
    undefined,
    { threadId },
    {
      emitRequestActivity: false,
    },
  );
  const driverRoutes = buildDriverRoutes(attemptProxy.routes);
  try {
    const driver = createSdkDriver(threadId, attemptProxy, undefined, "execution", onContextProbe);
    const controller = new AbortController();
    await fn(driver, controller.signal, driverRoutes);
  } finally {
    await attemptProxy.close();
  }
}

function buildDesktopSdkRunInput(
  input: Omit<BuildSdkRunInput, "globalUserRules">,
): ReturnType<typeof buildSdkRunInput> {
  const threadId =
    "threadId" in input && typeof (input as { threadId?: unknown }).threadId === "string"
      ? (input as { threadId: string }).threadId
      : undefined;
  let sessionEco = false;
  let sessionImage = false;
  let sessionTts = false;
  let sessionComputerUse = false;
  if (threadId) {
    const thread = conversationStore.getThread(threadId);
    sessionEco =
      browserSettingsStore.get().agentIntegrationEnabled &&
      integrationEnabled(
        thread ? ensureThreadRuntimeConfig(thread).runtimeConfig?.integrationsEnabled : undefined,
        "browser",
      );
    sessionComputerUse =
      computerUseSettingsStore.get().agentIntegrationEnabled &&
      integrationEnabled(
        thread ? ensureThreadRuntimeConfig(thread).runtimeConfig?.integrationsEnabled : undefined,
        "computerUse",
      );
    sessionImage =
      imageGenerationStore.getSettings().enabled &&
      integrationEnabled(
        thread ? ensureThreadRuntimeConfig(thread).runtimeConfig?.integrationsEnabled : undefined,
        "imageGeneration",
      );
    sessionTts =
      ttsStore.getSettings().enabled &&
      integrationEnabled(
        thread ? ensureThreadRuntimeConfig(thread).runtimeConfig?.integrationsEnabled : undefined,
        "tts",
      );
  }
  let globalUserRules = appendBrowserPrompt(
    personalizationSettingsStore.get().globalRules,
    requireBrowserHost().getAgentPromptAppend(sessionEco, threadId),
  );
  if (sessionComputerUse) {
    globalUserRules = appendBrowserPrompt(globalUserRules, computerUseGateway.getAgentPromptAppend(true));
  }
  if (sessionImage && threadId) {
    const config = imageGenerationStore.getActiveClientConfig();
    globalUserRules = appendBrowserPrompt(globalUserRules, buildImageGenerationPromptAppend(config));
  }
  if (sessionTts && threadId) {
    const config = ttsStore.getActiveClientConfig();
    globalUserRules = appendBrowserPrompt(globalUserRules, buildTtsPromptAppend(config));
  }
  globalUserRules = appendBrowserPrompt(globalUserRules, SCHEDULING_PROMPT);
  globalUserRules = appendBrowserPrompt(globalUserRules, CONTEXT_REFERENCE_PROMPT);
  globalUserRules = appendBrowserPrompt(globalUserRules, buildImageViewPromptAppend());
  globalUserRules = appendBrowserPrompt(globalUserRules, buildImageDisplayPromptAppend());
  if (threadId) {
    globalUserRules = appendBrowserPrompt(globalUserRules, mcpHubGateway.getThreadPromptAppend(threadId));
  }
  if (centerServerClient.getHtmlHostingCapability().available) {
    globalUserRules = appendBrowserPrompt(globalUserRules, buildHtmlHostPromptAppend());
  }
  if (threadId) {
    const agentRegistry = resolveAgentRuntimeConfigForThreadId(threadId);
    const plannerRoute = resolveRoleRoutesForThread(threadId).find((route) => route.role === "main");
    const integratedWebSearchSettings = integratedWebSearchSettingsStore.get();
    const integratedWebSearchApiKey = integratedWebSearchSettings.enabled
      ? integratedWebSearchSettingsStore.getApiKey()
      : undefined;
    const webSearchPlan = resolveThreadWebSearchPlan({
      networkWebSearch: agentRegistry
        ? materializeEcoToolPolicy(agentRegistry.orchestration.mainAgent.tools).network?.webSearch
        : undefined,
      ...(plannerRoute?.manualSpec ? { plannerManualSpec: plannerRoute.manualSpec } : {}),
      integratedSettings: integratedWebSearchSettings,
      ...(integratedWebSearchApiKey ? { integratedApiKey: integratedWebSearchApiKey } : {}),
    });
    if (webSearchPlan.backend === "integrated") {
      const provider = integratedWebSearchSettingsStore.get().provider;
      globalUserRules = appendBrowserPrompt(
        globalUserRules,
        buildIntegratedWebSearchPromptAppend(
          integratedWebSearchProviderLabel(provider),
        ),
      );
    }
  }
  return buildSdkRunInput({
    ...input,
    ...(globalUserRules ? { globalUserRules } : {}),
  });
}

function createSdkDriver(
  threadId: string,
  proxy: { apiKey: string; baseUrl: string },
  hookContextExtras?: SdkRunHookContextExtras,
  runPhase: SubagentRunPhase = "execution",
  onContextProbe?: (phase: string, detail: Record<string, unknown>) => void,
): ClaudeAgentSdkDriver {
  const storedThread = conversationStore.getThread(threadId);
  if (!storedThread) {
    throw new Error("Thread was not found.");
  }
  const threadConfig = ensureThreadRuntimeConfig(storedThread).runtimeConfig;
  const bashReviewMode = threadConfig?.bashReviewMode ?? "always";
  const packagedClaudeExecutable = app.isPackaged
    ? resolvePackagedClaudeExecutableCandidate({
        resourcesPath: readElectronResourcesPath(),
      })
    : undefined;
  if (app.isPackaged && (!packagedClaudeExecutable || !existsSync(packagedClaudeExecutable))) {
    throw new Error("Packaged Claude Code executable is missing from app.asar.unpacked.");
  }
  return new ClaudeAgentSdkDriver({
    apiKey: proxy.apiKey,
    baseUrl: proxy.baseUrl,
    ...(packagedClaudeExecutable && existsSync(packagedClaudeExecutable)
      ? { pathToClaudeCodeExecutable: packagedClaudeExecutable }
      : {}),
    hookContext: {
      ...createThreadHookContext(threadId),
      ...buildSdkHookContextExtras(threadId, runPhase, hookContextExtras),
      resolveSupportsImageInput: ({ agentId, agentType }) => {
        const actorRole =
          agentId && agentId !== agentLifecycle.usagePlannerAgentId(threadId)
            ? (subagentMetricsRegistry.roleForAgentId(threadId, agentId) ??
              normalizeSdkSubagentType(agentType ?? ""))
            : "main";
        if (!actorRole) throw new Error("无法确认 Agent 的模型视觉配置，已禁止直接读图。");
        const routes = resolveRoleRoutesForThread(threadId);
        const route = routes.find((entry) => entry.role === actorRole);
        if (!route) throw new Error("无法确认 Agent 的模型视觉配置，已禁止直接读图。");
        return route.manualSpec?.supportsImageInput;
      },
      resolveBashReviewMode: () => {
        const current = conversationStore.getThread(threadId);
        if (!current) {
          return "always";
        }
        return ensureThreadRuntimeConfig(current).runtimeConfig?.bashReviewMode ?? "always";
      },
      resolveBrowserOpenApprovalMode: () => browserSettingsStore.get().openApprovalMode,
      resolveWebSearchApprovalMode: () => integratedWebSearchSettingsStore.get().approvalMode,
      // "指定子代理执行已批准计划": while armed, rewrite the parent's Agent/Task spawn to
      // the chosen role + canonical task and consume the one-shot attempt.
      resolveForcedPlanDelegation: () => buildForcedPlanDelegationHookConfig(threadId),
      workspacePath: storedThread.workspacePath,
    },
    executionPermissionMode: bashReviewMode === "allow_all" ? "bypassPermissions" : "default",
    toolPermissionHandler: createThreadToolPermissionHandler(
      threadId,
      runPhase,
      bashReviewMode === "allow_all",
    ),
    queryLifecycle: {
      onOpen: (handle) => {
        claudeMidTurnPorts.open(threadId, handle);
      },
      onClosing: async () => {
        await claudeMidTurnPorts.closeIngress(threadId);
      },
      onClosed: (_handle, detail) => {
        reconcileInterruptedStreamingPushFollowUps(threadId, detail.stillQueued, detail.cancelled);
        claudeMidTurnPorts.close(threadId);
        recentStreamingPushFollowUpIds.delete(threadId);
      },
    },
    onBackgroundTasksChanged: ({ threadId, query, tasks }) => {
      claudeBackgroundTaskRegistry.replaceThread({
        threadId,
        workspacePath: conversationStore.getThread(threadId)?.workspacePath ?? storedThread.workspacePath,
        owner: query,
        tasks,
        stopTask: async (taskId) => {
          if (typeof query.stopTask !== "function") {
            throw new Error("Claude Agent SDK cannot stop this background task: stopTask is unavailable.");
          }
          await query.stopTask(taskId);
        },
        forceClose: () => {
          if (typeof query.close !== "function") {
            throw new Error("Claude Agent SDK cannot close the Query owning this background task.");
          }
          query.close();
        },
      });
    },
    onBackgroundTasksClosed: ({ threadId, query }) => {
      claudeBackgroundTaskRegistry.clearThread(threadId, query as object);
    },
    onContextProbe: (phase, detail) => {
      onContextProbe?.(phase, detail);
      logContextSnapshot(phase, { threadId, ...detail });
      logEcoDiag(`sdk.${normalizeDiagTopicSegment(phase)}`, {
        threadId: shortThreadId(threadId),
        phase,
        ...summarizeSdkProbeForDiag(phase, detail),
      });
    },
  });
}

function normalizeDiagTopicSegment(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") || "probe"
  );
}

function summarizeSdkProbeForDiag(phase: string, detail: Record<string, unknown>): Record<string, unknown> {
  if (phase === "getContextUsage" && isRecord(detail.usage)) {
    return {
      timing: detail.timing,
      usage: summarizeSdkContextUsageForDiag(detail.usage),
    };
  }
  if (phase === "getContextUsage_error") {
    return { timing: detail.timing, error: detail.error };
  }
  if (phase === "query_start") {
    const { threadId: _threadId, ...rest } = detail;
    return rest;
  }
  if (phase === "query_result") {
    return detail;
  }
  if (phase === "interrupt" || phase === "interrupt_error") {
    return detail;
  }
  return { keys: Object.keys(detail).sort() };
}

function summarizeSdkContextUsageForDiag(usage: Record<string, unknown>): Record<string, unknown> {
  const modelUsage = isRecord(usage.modelUsage) ? usage.modelUsage : undefined;
  const breakdown = usage.breakdown;
  return {
    keys: Object.keys(usage).sort(),
    totalTokens: readNumberForDiag(usage.totalTokens),
    maxTokens: readNumberForDiag(usage.maxTokens),
    inputTokens: readNumberForDiag(usage.input_tokens ?? usage.inputTokens),
    outputTokens: readNumberForDiag(usage.output_tokens ?? usage.outputTokens),
    cacheReadTokens: readNumberForDiag(
      usage.cache_read_input_tokens ?? usage.cacheReadInputTokens ?? usage.cache_read_tokens,
    ),
    cacheCreationTokens: readNumberForDiag(
      usage.cache_creation_input_tokens ?? usage.cacheCreationInputTokens ?? usage.cache_creation_tokens,
    ),
    ...(modelUsage && {
      modelUsageCount: Object.keys(modelUsage).length,
      modelUsageModels: Object.keys(modelUsage).slice(0, 12),
    }),
    ...(Array.isArray(breakdown) && { breakdownRows: breakdown.length }),
    ...(isRecord(breakdown) && {
      breakdownKeys: Object.keys(breakdown).slice(0, 20),
    }),
    jsonBytes: Buffer.byteLength(JSON.stringify(usage), "utf8"),
  };
}

function readNumberForDiag(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

async function deleteThreadSdkSession(threadId: string): Promise<void> {
  const session = conversationStore.getSdkSession(threadId);
  if (!session?.sessionId) {
    return;
  }
  try {
    await deleteClaudeAgentSdkSession({
      sessionId: session.sessionId,
      dir: session.cwd,
    });
  } catch (error) {
    if (isSdkSessionAlreadyMissing(error)) {
      process.stderr.write(
        `[eco] SDK session already missing while deleting ${threadId}: ${errorMessage(error)}\n`,
      );
      return;
    }
    throw error;
  }
}

/** Delete an explicit Claude fork that never emitted a session capture event. */
async function cleanupPendingClaudeFork(threadId: string): Promise<void> {
  const pending = pendingClaudeForksByThread.get(threadId);
  if (!pending) {
    return;
  }
  try {
    await deleteClaudeAgentSdkSession({
      sessionId: pending.sessionId,
      dir: pending.cwd,
    });
    pendingClaudeForksByThread.delete(threadId);
  } catch (error) {
    if (isSdkSessionAlreadyMissing(error)) {
      pendingClaudeForksByThread.delete(threadId);
      return;
    }
    process.stderr.write(
      `[eco] pending Claude fork cleanup failed thread=${threadId}: ${errorMessage(error)}\n`,
    );
  }
}

async function cleanupThreadExternalState(threadId: string): Promise<void> {
  await cleanupPendingClaudeFork(threadId);
  await deleteThreadSdkSession(threadId);
  // Thread-scoped Hub descriptors live in that thread's own config, not in
  // `config.toml`, so revoking one never changes the shared runtime baseline.
  mcpHubGateway.revokeThread(threadId);
  await disposePiThreadSession(threadId);
  await removePiThreadAgentDir(app.getPath("userData"), threadId);
  imageGenerationGateway.disposeThread(threadId);
  ttsGateway.disposeThread(threadId);
  imageViewGateway.disposeThread(threadId);
  imageDisplayGateway.disposeThread(threadId);
  htmlHostGateway.disposeThread(threadId);
  schedulingGateway.disposeThread(threadId);
  contextReferenceGateway.disposeThread(threadId);
  computerUseGateway.disposeThread(threadId);
  integratedWebSearchGateway.disposeThread(threadId);
  disposeAcpThread(threadId);
  const acpSessionId = acpSessionIdToDelete(conversationStore.getThreadCoreSession(threadId));
  if (acpSessionId) {
    const env = acpCursorSpawnEnv();
    await deleteCursorAcpSession({
      sessionId: acpSessionId,
      ...(env ? { env } : {}),
    });
  }
  if (!conversationStore.hasForkImageDependents(threadId))
    await promptImageFileStore.deleteThreadMessages(threadId);
}

function isSdkSessionAlreadyMissing(error: unknown): boolean {
  const detail = errorMessage(error);
  return /\b(not found|no session|missing session|ENOENT)\b/i.test(detail);
}

function clearThreadRuntimeMemory(threadId: string): void {
  threadFollowUpQueueControl.clear(threadId);
  editingThreadFollowUpByThread.delete(threadId);
  pendingEscalatedFollowUpDrain.delete(threadId);
  activeRunBillingState.clearRun(threadId);
  threadUsageAccumulator.clear(threadId);
  contextScheduler.clearThread(threadId);
  contextMonitor?.clearThread(threadId);
  threadPromptCacheMonitor.clearThread(threadId);
  threadPromptCacheEpisodeMonitor.clearThread(threadId);
  threadCacheHitMonitor.clearThread(threadId);
  subagentMetricsRegistry.clearThread(threadId);
  usageLedgerCoordinator.clearProxyAttributionState(threadId);
  clearThreadSubagentLaunchRegistry(threadId);
  subagentDelegationLinkersByThread.delete(threadId);
  sdkStreamActivityIngestion.clearDelegationLinker(threadId);
}

function resetThreadRuntimeAfterHistoryRewrite(threadId: string): void {
  threadUsageAccumulator.clear(threadId);
  contextScheduler.clearThread(threadId);
  threadPromptCacheMonitor.clearThread(threadId);
  threadPromptCacheEpisodeMonitor.clearThread(threadId);
  threadCacheHitMonitor.clearThread(threadId);
  subagentMetricsRegistry.clearThread(threadId);
  usageLedgerCoordinator.clearProxyAttributionState(threadId);
}

async function prepareThreadRewindForContinue(input: {
  threadId: string;
  prompt: string;
  workspace: WorkspaceInfo;
  target: ThreadActivityRewindTarget;
  command?: ThreadHistoryCommandContext;
}): Promise<EcoSdkResumeOptions | undefined> {
  const storedTarget = conversationStore.getActivityRewindTarget(input.threadId, input.target.activityLineId);
  const currentUserMessageId = await resolveCurrentClaudeUserMessageId(
    input.threadId,
    input.target.activityLineId,
  );
  if (
    !storedTarget?.userMessageId ||
    (input.target.userMessageId && currentUserMessageId !== input.target.userMessageId)
  ) {
    throw new Error("该节点缺少 SDK 检查点，无法安全回滚。");
  }
  const storedUserMessageId = currentUserMessageId;

  const session = conversationStore.getSdkSession(input.threadId);
  if (!session?.sessionId) {
    throw new Error("没有可恢复的 SDK 会话，无法回到该节点。");
  }
  const sessionCwd = normalizeSessionCwd(input.workspace.path, session.cwd);
  if (!existsSync(sessionCwd)) {
    throw new Error("SDK 会话工作目录不存在，无法回到该节点。");
  }

  const resumeSessionAt = await resolveClaudeResumeSessionAtBeforeUserMessage({
    sessionId: session.sessionId,
    userMessageId: storedUserMessageId,
    dir: sessionCwd,
  });

  let forkedSessionId: string | undefined;
  let resumeOptions: EcoSdkResumeOptions | undefined;
  try {
    // Fork the remote transcript before pruning local conversation history.
    // The query-level resumeDropsTurn guard is intentionally not used here:
    // the official SDK may reject it asynchronously and cannot be retried safely.
    // Files on disk are left as-is; Eco does not snapshot or restore the worktree.
    if (resumeSessionAt) {
      const recoveryTitle = input.command
        ? `eco-v2:${stableHash(`${input.command.principalId}:${input.threadId}`)}:${input.command.clientCommandId}`
        : undefined;
      if (input.command && recoveryTitle) {
        conversationStore
          .conversationV2()
          .recordCommandCheckpoint(
            input.command.principalId,
            input.threadId,
            input.command.clientCommandId,
            "history.sdk_fork_requested",
            {
              sourceSessionId: session.sessionId,
              cwd: sessionCwd,
              upToMessageId: resumeSessionAt,
              recoveryTitle,
            },
          );
        forkedSessionId = await findClaudeSessionByRecoveryTitle({
          dir: sessionCwd,
          title: recoveryTitle,
        });
      }
      if (!forkedSessionId) {
        forkedSessionId = await forkClaudeSessionAt({
          sessionId: session.sessionId,
          dir: sessionCwd,
          upToMessageId: resumeSessionAt,
          ...(recoveryTitle ? { title: recoveryTitle } : {}),
        });
      }
      if (forkedSessionId === session.sessionId) {
        throw new Error("Claude fork recovery resolved the source session.");
      }
      if (input.command) {
        conversationStore
          .conversationV2()
          .recordCommandCheckpoint(
            input.command.principalId,
            input.threadId,
            input.command.clientCommandId,
            "history.sdk_fork_created",
            { forkedSessionId },
          );
      }
      pendingClaudeForksByThread.set(input.threadId, {
        sessionId: forkedSessionId,
        cwd: sessionCwd,
      });
    } else if (input.command) {
      conversationStore
        .conversationV2()
        .recordCommandCheckpoint(
          input.command.principalId,
          input.threadId,
          input.command.clientCommandId,
          "history.sdk_fork_skipped",
          { reason: "rewind_before_first_session_entry" },
        );
    }

    conversationStore.rewindThreadToActivityLine(input.threadId, storedTarget.activityLineId, input.command);
    resetThreadRuntimeAfterHistoryRewrite(input.threadId);
    conversationStore.clearThreadClaudePlanFilePath(input.threadId);
    if (!resumeSessionAt) {
      conversationStore.updateThreadPrompt(input.threadId, input.prompt);
    }
    if (!resumeSessionAt) {
      conversationStore.clearSdkSession(input.threadId);
    }
    clearThreadRuntimeMemory(input.threadId);
    emitTodoList(input.threadId, []);
    emitSubagentTimingUpdated(input.threadId);

    resumeOptions = forkedSessionId ? { resumeSessionId: forkedSessionId } : undefined;
  } catch (error) {
    if (forkedSessionId) {
      pendingClaudeForksByThread.delete(input.threadId);
      // A durable command may already reference this fork from its checkpoint.
      // Keep it so restart reconciliation can resume instead of creating a second
      // branch. Legacy in-memory rewinds still clean their orphan immediately.
      if (!input.command) {
        try {
          await deleteClaudeAgentSdkSession({
            sessionId: forkedSessionId,
            dir: sessionCwd,
          });
        } catch (deleteError) {
          throw new Error(
            `Claude rewind fork cleanup failed: ${errorMessage(deleteError)}; original error: ${errorMessage(error)}`,
          );
        }
      }
    }
    throw error;
  }

  return resumeOptions;
}

function isSessionCapturedPayload(payload: unknown): payload is SessionCapturedPayload {
  return (
    typeof payload === "object" &&
    payload !== null &&
    typeof (payload as SessionCapturedPayload).sessionId === "string" &&
    typeof (payload as SessionCapturedPayload).cwd === "string"
  );
}

async function captureSdkSessionFromEvent(
  threadId: string,
  event: { type: string; payload: unknown },
  worktreePath: string,
): Promise<void> {
  if (event.type === "file.checkpoint") {
    const payload = event.payload;
    if (
      payload &&
      typeof payload === "object" &&
      typeof (payload as { userMessageId?: string }).userMessageId === "string"
    ) {
      const userMessageId = (payload as { userMessageId: string }).userMessageId;
      const thread = conversationStore.getThread(threadId);
      if (thread?.coreKind === "claude") {
        // A queued SDK input can be absorbed into the running turn as an
        // attachment, and several inputs can arrive before one echo. Bind only
        // prompts the persisted session actually exposes, never the newest
        // unbound Eco message by arrival order.
        await rebindClaudeUserMessageRecordsFromSession(threadId);
        scheduleThreadRunProjectionUpdated(threadId);
        return;
      }
      const bound = conversationStore.bindLatestUserActivityToSdkMessage(threadId, userMessageId);
      if (bound) {
        scheduleThreadRunProjectionUpdated(threadId);
      }
    }
    return;
  }
  if (event.type !== "session.captured") {
    return;
  }
  if (isSessionCapturedPayload(event.payload)) {
    const pendingFork = pendingClaudeForksByThread.get(threadId);
    if (pendingFork) {
      const capturedSessionId = event.payload.sessionId.trim();
      if (pendingFork.sessionId !== capturedSessionId) {
        throw new Error(
          `Claude fork session capture mismatch: expected ${pendingFork.sessionId}, received ${capturedSessionId}.`,
        );
      }
    }
    conversationStore.captureSdkSessionAndConsumeCompactHandoff(
      threadId,
      event.payload.sessionId,
      worktreePath,
      { resetPending: event.payload.resetPending === true },
    );
    if (pendingFork) {
      pendingClaudeForksByThread.delete(threadId);
    }
    if (conversationStore.getThread(threadId)?.coreKind === "claude") {
      await rebindClaudeUserMessageRecordsFromSession(threadId);
    }
  }
}

async function rebindClaudeUserMessageRecordsFromSession(
  threadId: string,
): Promise<Array<{ activityLineId: string; upstreamMessageId: string }>> {
  const records = conversationStore.ensureClaudeUserMessageRecordsFromRunEvents(threadId);
  if (records.length === 0) {
    return [];
  }
  const userLines = await listClaudePromptSessionLines(threadId);
  if (userLines.length === 0) {
    return [];
  }

  const plan = planClaudeUserMessageRebindMappings(records, userLines);
  if (plan.rejected.length > 0) {
    // Rewriting an existing history target fails the V2 guard closed and blocks
    // the conversation for good, so rebind only ever fills in missing bindings.
    process.stderr.write(
      `[eco] claude rebind kept ${plan.rejected.length} existing history target(s) thread=${threadId}: ${JSON.stringify(plan.rejected)}\n`,
    );
  }
  conversationStore.rebindClaudeUserMessageRecords(threadId, plan.mappings);
  return plan.mappings;
}

async function resolveCurrentClaudeUserMessageId(threadId: string, activityLineId: string): Promise<string> {
  return resolveClaudeCurrentSessionUserMessageId(
    conversationStore.ensureClaudeUserMessageRecordsFromRunEvents(threadId),
    await listClaudePromptSessionLines(threadId),
    activityLineId,
  );
}

async function listClaudePromptSessionLines(threadId: string): Promise<ClaudePromptSessionLine[]> {
  return (await listThreadActivityFromSdkSession(threadId))
    .filter(
      (
        line,
      ): line is ThreadActivityLine & {
        rewindTarget: { activityLineId: string; userMessageId?: string };
      } => line.role === "user" && Boolean(line.rewindTarget?.activityLineId),
    )
    .map((line) => ({
      activityLineId: line.rewindTarget.activityLineId,
      text: line.message,
      upstreamMessageId: line.rewindTarget.userMessageId?.trim() ?? "",
    }));
}

async function hydrateClaudeUserMessageEditState(threadId: string): Promise<void> {
  const existing = claudeUserMessageHydrationByThread.get(threadId);
  if (existing) {
    return existing;
  }
  const hydration = hydrateClaudeUserMessageEditStateOnce(threadId).finally(() => {
    claudeUserMessageHydrationByThread.delete(threadId);
  });
  claudeUserMessageHydrationByThread.set(threadId, hydration);
  return hydration;
}

async function hydrateClaudeUserMessageEditStateOnce(threadId: string): Promise<void> {
  const thread = conversationStore.getThread(threadId);
  if (!thread || thread.coreKind !== "claude" || thread.status === "running" || thread.status === "queued") {
    return;
  }
  const promptEvents = conversationStore
    .listConversationRuntimeSources(threadId)
    .filter((event) => event.role === "user" && event.metadata?.liveType === "thread.user_prompt");
  if (promptEvents.length === 0) {
    return;
  }
  const records = conversationStore.ensureClaudeUserMessageRecordsFromRunEvents(threadId);
  const fullyMapped =
    records.length >= promptEvents.length &&
    records.every((record) => Boolean(record.upstreamMessageId?.trim())) &&
    promptEvents.every((event) => {
      const rewindTarget = event.metadata?.rewindTarget;
      return (
        rewindTarget &&
        typeof rewindTarget === "object" &&
        !Array.isArray(rewindTarget) &&
        typeof (rewindTarget as { userMessageId?: unknown }).userMessageId === "string" &&
        Boolean((rewindTarget as { userMessageId: string }).userMessageId.trim())
      );
    });
  if (!fullyMapped) {
    await rebindClaudeUserMessageRecordsFromSession(threadId);
  }
}

function evaluateClaudeResumeDecision(
  threadId: string,
  worktreePath: string,
): ReturnType<typeof decideClaudeResume> | null {
  const session = conversationStore.getSdkSession(threadId);
  if (!session?.sessionId) {
    return null;
  }
  const thread = conversationStore.getThread(threadId);
  const workspacePath = thread?.workspacePath;
  const sessionCwd = workspacePath ? normalizeSessionCwd(workspacePath, session.cwd) : session.cwd.trim();
  const cwd = workspacePath
    ? normalizeSessionCwd(workspacePath, worktreePath || session.cwd)
    : worktreePath.trim();

  // Prefer resolved RuntimeRoute fields (provider defaults) so fingerprint diagnostics match writes.
  const resolved = resolveRuntimeConfigForThreadId(threadId);
  const nextRoleRoutes = resolved.ok ? roleRoutesFromRuntime(resolved.routes) : [];
  const storedFingerprint = conversationStore.getRouteFingerprint(threadId);
  return decideClaudeResume({
    sessionId: session.sessionId,
    ...(storedFingerprint ? { previousRoutes: { fingerprint: storedFingerprint } } : {}),
    nextRoutes: snapshotClaudeResumeRoutes(nextRoleRoutes),
    sessionCwd,
    nextCwd: cwd || sessionCwd,
    sessionCwdExists: existsSync(sessionCwd),
    resetPending: session.resetPending === true,
  });
}

function resolveResumeOptions(threadId: string, worktreePath: string): EcoSdkResumeOptions | undefined {
  const decision = evaluateClaudeResumeDecision(threadId, worktreePath);
  if (!decision) {
    return undefined;
  }

  if (decision.kind === "resume") {
    return decision.resetPending
      ? { newSessionId: decision.sessionId }
      : { resumeSessionId: decision.sessionId };
  }

  logEcoDiag("sdk_session.resume_decision", {
    threadId: shortThreadId(threadId),
    decision: decision.kind,
    reason: decision.reason,
  });

  // reject (cwd missing/changed, corrupt, …): new session, drop unusable resume target.
  conversationStore.clearSdkSession(threadId);
  return undefined;
}

async function ensurePendingPlanForExecution(
  threadId: string,
  workspacePath: string,
  worktreePath: string,
  routesJson: string,
): Promise<boolean> {
  if (conversationStore.getPendingPlan(threadId)) {
    return true;
  }
  const planFilePath = conversationStore.getThreadClaudePlanFilePath(threadId);
  if (!planFilePath) {
    return false;
  }
  const planText = await readClaudePlanFile(workspacePath, planFilePath);
  if (!planText) {
    return false;
  }
  const thread = conversationStore.getThread(threadId);
  conversationStore.savePendingPlan({
    threadId,
    userPrompt: thread?.prompt.trim() || "",
    analysis: "",
    plan: planText,
    workspacePath,
    worktreePath,
    routesJson,
    planFilePath,
  });
  return true;
}

async function persistApprovedPlanForThread(
  threadId: string,
  pending: {
    workspacePath: string;
    userPrompt: string;
    analysis: string;
    plan: string;
    planFilePath?: string;
    planUserEdited?: boolean;
  },
): Promise<ApprovedPlanArtifact> {
  if (pending.planFilePath?.trim()) {
    conversationStore.setThreadClaudePlanFilePath(threadId, pending.planFilePath.trim());
  }
  if (!pending.plan.trim()) {
    throw new Error("Approved plan snapshot cannot be empty.");
  }
  const snapshot: ApprovedPlanSnapshot = {
    userPrompt: pending.userPrompt,
    analysis: pending.analysis,
    plan: pending.plan,
    ...(pending.planUserEdited ? { planUserEdited: true } : {}),
  };
  return writeApprovedPlanSnapshot(pending.workspacePath, threadId, snapshot);
}

function approvedPlanCheckpointPayload(artifact: ApprovedPlanArtifact): Record<string, unknown> {
  return {
    snapshotPath: artifact.absolutePath,
    snapshotRelativePath: artifact.relativePath,
    contentHash: artifact.contentHash,
    hashAlgorithm: "sha256",
  };
}

async function buildThreadApprovedPlanView(threadId: string): Promise<ThreadPendingPlan | undefined> {
  const id = threadId.trim();
  if (!id || conversationStore.getPendingPlan(id)) {
    return undefined;
  }

  const thread = conversationStore.getThread(id);
  if (!thread) {
    return undefined;
  }

  const worktreePath = createSessionPlan(thread.workspacePath, id).worktreePath;
  const planFilePath = conversationStore.getThreadClaudePlanFilePath(id);
  if (planFilePath) {
    const planText = await readClaudePlanFile(thread.workspacePath, planFilePath);
    if (planText) {
      return {
        threadId: id,
        userPrompt: thread.prompt.trim(),
        analysis: "",
        plan: planText,
        workspacePath: thread.workspacePath,
        worktreePath,
        planFilePath,
      };
    }
  }

  const legacySnapshot = await readApprovedPlanSnapshot(thread.workspacePath, id);
  if (!legacySnapshot) {
    return undefined;
  }
  return {
    threadId: id,
    userPrompt: legacySnapshot.userPrompt || thread.prompt.trim(),
    analysis: legacySnapshot.analysis,
    plan: legacySnapshot.plan,
    workspacePath: thread.workspacePath,
    worktreePath,
    planFilePath: approvedPlanRelativePath(id),
  };
}

async function resolvePlanningContextForThread(
  threadId: string,
  workspacePath: string,
): Promise<EcoPlanningContext | undefined> {
  const pending = conversationStore.getPendingPlan(threadId);
  if (pending) {
    return {
      userPrompt: pending.userPrompt,
      analysis: pending.analysis,
      plan: pending.plan,
      ...(pending.planFilePath ? { planFilePath: pending.planFilePath } : {}),
      ...(pending.deferredExitPlanToolUseId
        ? { deferredExitPlanToolUseId: pending.deferredExitPlanToolUseId }
        : {}),
    };
  }
  const planFilePath = conversationStore.getThreadClaudePlanFilePath(threadId);
  if (!planFilePath) {
    return undefined;
  }
  const planText = await readClaudePlanFile(workspacePath, planFilePath);
  if (!planText) {
    return undefined;
  }
  const thread = conversationStore.getThread(threadId);
  return {
    userPrompt: thread?.prompt.trim() || "",
    analysis: "",
    plan: planText,
    planFilePath,
  };
}

async function dispatchThreadContinueAction(input: {
  threadId: string;
  action: ThreadContinueAction;
  updated: ThreadSummary;
  workspace: WorkspaceInfo;
  runtimeConfig: RuntimeConfig;
  agentPrompt: string;
  cwd: string;
  existingWorktreePlan?: WorktreePlan;
  attachments?: PromptImageAttachment[];
  roleRoutes: readonly RuntimeRoleRouteConfig[];
  resumeOverride?: EcoSdkResumeOptions;
  runtimeDispatch?: PreparedHistoryRuntimeDispatch;
}): Promise<void> {
  const {
    threadId,
    action,
    updated,
    workspace,
    runtimeConfig,
    agentPrompt,
    cwd,
    existingWorktreePlan,
    attachments,
    roleRoutes,
    resumeOverride,
    runtimeDispatch,
  } = input;

  if (action.kind === "resume_execution") {
    const worktreePath = existingWorktreePlan?.worktreePath ?? cwd;
    const ok = await ensurePendingPlanForExecution(threadId, workspace.path, worktreePath, "[]");
    if (!ok) {
      markThreadInterrupted(threadId, "找不到可恢复的执行计划，请重新描述需求。");
      return;
    }
    void runCodingThreadExecution(threadId, runtimeConfig, {
      routesOverride: roleRoutes,
      followUp: agentPrompt,
      ...(attachments?.length ? { attachments } : {}),
      ...(resumeOverride && { resume: resumeOverride }),
      ...(runtimeDispatch && { runtimeDispatch }),
    });
    return;
  }

  if (action.kind === "resume_sdk" && action.phase === "ask") {
    let resume: EcoSdkResumeOptions | undefined;
    try {
      resume = action.resume !== false ? (resumeOverride ?? resolveResumeOptions(threadId, cwd)) : undefined;
    } catch (error) {
      markThreadInterrupted(threadId, errorMessage(error));
      return;
    }
    if (resume) {
      void runThreadContinuation(
        updated,
        workspace,
        runtimeConfig,
        agentPrompt,
        "ask",
        existingWorktreePlan,
        attachments,
        roleRoutes,
        undefined,
        resume,
        runtimeDispatch,
      );
    } else {
      void runAskThread(
        updated,
        workspace,
        runtimeConfig,
        agentPrompt,
        cwd !== workspace.path ? cwd : undefined,
        undefined,
        attachments,
        roleRoutes,
        runtimeDispatch,
      );
    }
    return;
  }

  if (action.kind === "resume_sdk") {
    void (async () => {
      const planningContext =
        action.phase === "execution"
          ? await resolvePlanningContextForThread(threadId, workspace.path)
          : undefined;
      if (action.phase === "execution") {
        conversationStore.clearPendingPlan(threadId);
      }
      await runThreadContinuation(
        updated,
        workspace,
        runtimeConfig,
        agentPrompt,
        action.phase,
        existingWorktreePlan,
        attachments,
        roleRoutes,
        planningContext,
        resumeOverride,
        runtimeDispatch,
      );
    })();
    return;
  }

  if (action.kind === "fresh_autonomous") {
    conversationStore.clearPendingPlan(threadId);
    conversationStore.clearSubagentSessions(threadId);
    subagentMetricsRegistry.clearThread(threadId);
    void runCodingThreadAutonomous(
      updated,
      workspace,
      runtimeConfig,
      agentPrompt,
      existingWorktreePlan,
      undefined,
      attachments,
      roleRoutes,
      runtimeDispatch,
    );
    return;
  }

  if (action.kind === "revise_plan" || action.kind === "fresh_plan") {
    if (action.kind === "fresh_plan") {
      conversationStore.clearSubagentSessions(threadId);
      subagentMetricsRegistry.clearThread(threadId);
    }
    void runPlanThread(
      updated,
      workspace,
      runtimeConfig,
      agentPrompt,
      existingWorktreePlan?.worktreePath,
      resumeOverride,
      attachments,
      roleRoutes,
      runtimeDispatch,
    );
  }
}

async function runThreadContinuation(
  thread: ThreadSummary,
  workspace: WorkspaceInfo,
  runtimeConfig: RuntimeConfig,
  followUp: string,
  mode: "planning" | "execution" | "ask",
  existingWorktreePlan?: WorktreePlan,
  attachments?: PromptImageAttachment[],
  routesOverride?: readonly RuntimeRoleRouteConfig[],
  planningContext?: EcoPlanningContext,
  resumeOverride?: EcoSdkResumeOptions,
  runtimeDispatch?: PreparedHistoryRuntimeDispatch,
): Promise<void> {
  const controller = new AbortController();
  startActiveRun(thread.id, {
    controller,
    worktreePlan: existingWorktreePlan ?? createSessionPlan(workspace.path, thread.id),
  });
  resetSubagentContextWindows(thread.id);

  let planningPlanCaptured = false;
  let worktreePlan = existingWorktreePlan ?? createSessionPlan(workspace.path, thread.id);
  let cwd = workspace.path;
  const taskRuntime =
    mode === "execution"
      ? createThreadSdkTaskRuntime({
          threadId: thread.id,
          store: {
            listTodos: (id) => conversationStore.listCoderTodos(id),
            replaceTodos: (id, todos) => conversationStore.replaceCoderTodos(id, todos),
          },
          emitTodoList,
        })
      : undefined;
  const taskRunHooks = taskRuntime?.taskRunHooks;

  try {
    if (mode !== "ask") {
      const resolved = await resolveThreadWorktree(workspace, thread.id, existingWorktreePlan);
      worktreePlan = resolved.worktreePlan;
      cwd = resolved.cwd;
      activeRunRuntimeState.setWorktreePlan(thread.id, worktreePlan);
    }

    const resumeOptsForContinuation = resumeOverride ?? resolveResumeOptions(thread.id, cwd);

    const outcome = await runThreadRequestOnce(
      thread.id,
      runAttemptPhaseFromThreadMode(mode),
      controller.signal,
      async (attemptContext) => {
        const mainPrompt = await resolvePromptImagesForMainContext({
          threadId: thread.id,
          prompt: followUp,
          ...(attachments?.length ? { attachments } : {}),
          ...(routesOverride ? { routesOverride } : {}),
          signal: controller.signal,
        });
        return runThreadRequestWithLiveRequestLifecycle({
          context: attemptContext,
          resolveRuntimeConfig: () => resolveRuntimeConfigForThreadId(thread.id, routesOverride),
          recordRouteFingerprint: recordThreadRouteFingerprint,
          startRuntimeProxy,
          run: async ({ proxy: attemptProxy, routes }) => {
            const resume = resumeOptsForContinuation;
            if (!resume) {
              return {
                ok: false,
                reason: "无法恢复 SDK 会话，请重新发送完整需求。",
              };
            }
            try {
              const continuationPhase = sdkRunPhaseFromMode(mode);
              const driver = createSdkDriver(
                thread.id,
                attemptProxy,
                taskRunHooks?.hookContextExtras,
                continuationPhase,
              );
              if (!driver.runContinuation) {
                throw new Error("Runtime driver does not support session continuation.");
              }
              return await consumeSdkRunEvents({
                events: driver.runContinuation(
                  buildDesktopSdkRunInput({
                    threadId: thread.id,
                    prompt: mainPrompt,
                    workspacePath: workspace.path,
                    worktreePath: cwd,
                    routes,
                    signal: controller.signal,
                    sdkSession: await buildSdkSessionOptions(thread.id, mainPrompt, {
                      skillsScope: mode === "planning" ? "planning" : "default",
                    }),
                    agentRegistry: resolveAgentRuntimeConfigForThread(thread),
                    resume,
                    resumableSubagents: listResumableSubagentRefs(thread.id, continuationPhase),
                  }),
                  mode,
                  planningContext,
                ),
                threadId: thread.id,
                worktreePath: cwd,
                signal: controller.signal,
                onUsageRecorded: onSdkUsageRecordedEvent,
                captureSession: captureSdkSessionFromEvent,
                emitActivity: emitSdkStreamActivity,
                onEvent: (event) => {
                  if (event.type === "plan.ready" && isPlanReadyPayload(event.payload)) {
                    planningPlanCaptured = captureThreadPlanReady({
                      threadId: thread.id,
                      workspacePath: workspace.path,
                      worktreePath: cwd,
                      routesJson: JSON.stringify(routes),
                      payload: event.payload,
                      awaitingPlanMessage: "",
                    });
                  }
                  taskRuntime?.handleEvent(event);
                },
              });
            } catch (error) {
              if (controller.signal.aborted) {
                return {
                  ok: false,
                  reason: resolveAbortedRunReason(controller.signal, error),
                  aborted: true,
                };
              }
              return { ok: false, reason: errorMessage(error) };
            }
          },
        });
      },
      0,
      runtimeDispatch,
    );

    const continuationDecision = resolveContinuationRunOutcome(outcome, {
      mode,
      planningPlanCaptured,
    });

    if (
      await applyMainThreadRunDecisionEffects({
        threadId: thread.id,
        decision: continuationDecision,
        onCancelled: async (reason) => {
          taskRunHooks?.stopIfUnhandled("cancelled");
          cancelClarificationsForThread(thread.id, reason);
          await handleRunCancelled(thread.id, worktreePlan);
        },
        onFailed: (reason) => {
          taskRunHooks?.stopIfUnhandled("blocked");
          assertSdkSessionRetainedOnRunFailure({
            hadResume: Boolean(resumeOptsForContinuation),
            reason,
          });
          markThreadInterrupted(thread.id, reason);
        },
        onIncomplete: (reason) => {
          taskRunHooks?.stopIfUnhandled("blocked");
          markThreadInterrupted(thread.id, reason);
        },
        onCompleted: async () => {
          if (mode === "execution") {
            taskRunHooks?.stopIfUnhandled("completed");
            await completeCodingThreadRun(thread.id, worktreePlan);
            return;
          }
          if (mode === "ask") {
            updateThread(thread.id, {
              status: "completed",
              message: "",
            });
            return;
          }
          updateThread(thread.id, { status: "idle", message: "" });
        },
      })
    ) {
      return;
    }

    updateThread(thread.id, { status: "idle", message: "" });
  } catch (error) {
    taskRunHooks?.stopIfUnhandled("blocked");
    markThreadInterrupted(thread.id, errorMessage(error));
  } finally {
    const worktreePath = resolveThreadWorktreePath(thread.id);
    await finalizeMainThreadRunCleanup({
      threadId: thread.id,
      worktreePath,
      cancelClarificationsReason: "run finished",
      idleFallbackMessage: "",
    });
  }
}

/** SDK drives narrative, tool, todo, and billing activity. */
function initializeSdkStreamActivityPipeline(): void {
  threadRunEventLivePersister = createThreadRunEventLivePersister({
    store: conversationStore,
    lifecycle: agentLifecycle,
    metricsRegistry: subagentMetricsRegistry,
    liveRequestRegistry: threadLiveRequestRegistry,
    resolveCurrentRunAttemptId,
    resolveAgentIdByParentToolUseId,
    buildBashApprovalMetadata: buildBashApprovalRunMetadataFromRequest,
    emitRequestTerminalEvent,
    onProjectionUpdated: scheduleThreadRunProjectionUpdated,
    onFileChange: scheduleWorkspaceGitStatusPublishForThread,
  });
  sdkStreamActivityIngestion = createSdkStreamActivityIngestion({
    store: conversationStore,
    lifecycle: agentLifecycle,
    metricsRegistry: subagentMetricsRegistry,
    usageLedger: usageLedgerCoordinator,
    contextLifecycle,
    liveRequestRegistry: threadLiveRequestRegistry,
    bridge: sdkStreamBridge,
    logDiagnostic: logEcoDiag,
    emitRequestTerminalEvent,
    onProjectionUpdated: scheduleThreadRunProjectionUpdated,
    onSubagentTimingUpdated: emitSubagentTimingUpdated,
    onContextCompactionStatus: (threadId, input) => emitContextCompactionStatus(threadId, input),
    onBrowserToolStarted: ({ threadId, payload }) => {
      maybeRevealBrowserFromAgentTool({ threadId, payload });
    },
    buildBashApprovalMetadata: buildBashApprovalRunMetadataFromRequest,
    emitBridgeThreadEvent: (threadId, type, message, role, stream, extras) => {
      emitThreadEvent(
        threadId,
        type,
        message,
        role as AgentRole | "system" | "thinking" | "tool" | "user",
        stream,
        extras as EmitThreadEventExtras | undefined,
      );
    },
  });
}

function tryResolveStreamSubagentDelegation(threadId: string, parentToolUseId: string): void {
  const linked = getThreadSubagentLaunchRegistry(threadId).resolveFromStreamParentToolUseId(parentToolUseId);
  if (!linked) {
    return;
  }
  subagentDelegationLinkersByThread.get(threadId)?.({
    agentId: linked.agentId,
    agentType: linked.launch.role,
    parentToolUseId: linked.launch.parentToolUseId,
    prompt: linked.launch.prompt,
    ...(linked.launch.todoIdHint && { todoId: linked.launch.todoIdHint }),
  });
}

/** ACP nested Agent/Task tools emit agent.started/completed; mint Cards store rows. */
function maybeHandleAcpNestedSubagentLifecycle(threadId: string, event: AgentEventLike): boolean {
  if (event.type !== "agent.started" && event.type !== "agent.completed") {
    return false;
  }
  if (!isRecord(event.payload) || event.payload.source !== "acp") {
    return false;
  }
  const agentId = event.agentId?.trim();
  const parentToolUseId =
    typeof event.payload.parentToolUseId === "string"
      ? event.payload.parentToolUseId.trim()
      : typeof event.payload.parent_tool_use_id === "string"
        ? event.payload.parent_tool_use_id.trim()
        : "";
  if (!agentId || !parentToolUseId) {
    return false;
  }
  const rawRole =
    typeof event.payload.subagent_type === "string"
      ? event.payload.subagent_type
      : typeof event.role === "string"
        ? event.role
        : "";
  const role =
    normalizeSdkSubagentType(rawRole) ??
    (rawRole === SDK_GENERAL_PURPOSE_AGENT_KEY || rawRole === SDK_PLAN_AGENT_KEY
      ? rawRole
      : SDK_GENERAL_PURPOSE_AGENT_KEY);
  const prompt =
    typeof event.payload.prompt === "string"
      ? event.payload.prompt.trim()
      : typeof event.payload.task === "string"
        ? event.payload.task.trim()
        : "";
  const observedAt = new Date().toISOString();
  const runAttemptId = agentLifecycle.usageRunAttemptId(threadId);
  const parentAgentId = agentLifecycle.currentPlannerAgentId(threadId);

  if (event.type === "agent.started") {
    const existing = conversationStore.listAgentInstances(threadId).find((row) => row.agentId === agentId);
    if (existing) {
      return true;
    }
    const lifecycleRecord = agentLifecycle.startSubagent({
      threadId,
      agentId,
      role,
      parentToolUseId,
      ...(prompt && { missionKey: prompt.slice(0, 120) }),
    });
    conversationStore.upsertSubagentSessionActive({
      threadId,
      role,
      agentId,
      phase: "execution",
      ...(prompt && { missionKey: prompt.slice(0, 120) }),
    });
    subagentMetricsRegistry.onSubagentStart(threadId, {
      agentId,
      role,
      parentToolUseId,
    });
    conversationStore.appendConversationRuntimeEvent(
      buildSubagentLifecycleRunEvent({
        threadId,
        agentId,
        role,
        lifecycle: "started",
        observedAt,
        parentToolUseId,
        ...(runAttemptId && { runAttemptId }),
        ...(parentAgentId && { parentAgentId }),
        ...(lifecycleRecord?.runAttemptId && {
          runAttemptId: lifecycleRecord.runAttemptId,
        }),
        ...(prompt && { delegationPrompt: prompt }),
      }),
    );
    if (prompt) {
      conversationStore.appendConversationRuntimeEvent(
        buildSubagentMissionAttributedRunEvent({
          threadId,
          agentId,
          role,
          prompt,
          observedAt,
          parentToolUseId,
          ...(runAttemptId && { runAttemptId }),
        }),
      );
    }
    scheduleThreadRunProjectionUpdated(threadId, { streaming: true });
    emitSubagentTimingUpdated(threadId);
    return true;
  }

  const failed = event.payload.failed === true;
  if (failed) {
    agentLifecycle.abandonSubagent({ threadId, agentId, role });
  } else {
    agentLifecycle.stopSubagent({ threadId, agentId, role });
  }
  subagentMetricsRegistry.onSubagentStop(threadId, { agentId, role });
  conversationStore.markSubagentSessionStopped(threadId, agentId);
  conversationStore.appendConversationRuntimeEvent(
    buildSubagentLifecycleRunEvent({
      threadId,
      agentId,
      role,
      lifecycle: failed ? "abandoned" : "stopped",
      observedAt,
      parentToolUseId,
      ...(runAttemptId && { runAttemptId }),
      ...(parentAgentId && { parentAgentId }),
      ...(prompt && { delegationPrompt: prompt }),
    }),
  );
  scheduleThreadRunProjectionUpdated(threadId, { streaming: false });
  emitSubagentTimingUpdated(threadId);
  return true;
}

/** SDK drives narrative, tool, todo, and billing activity. */
function emitSdkStreamActivity(threadId: string, event: AgentEventLike): void {
  sdkStreamActivityIngestion.ingest(threadId, event);
}

function noteUsageBillingObservation(threadId: string, observation: UsageBillingObservation): void {
  activeRunBillingState.appendObservation(threadId, observation);
}

async function handleCodexGatewayUsage(event: import("@eco/gateway").GatewayUsageEvent): Promise<void> {
  const resolved = resolveCodexGatewayUsageBilling({
    event,
    resolveThreadAttribution: (codexThreadId) => resolveCodexThreadAttribution(codexThreadMap, codexThreadId),
    resolveParentCodexThreadId: (codexThreadId) =>
      codexThreadMap.getThreadAttribution(codexThreadId)?.parentThreadId,
    resolveRuntimeRoutes: resolveRuntimeRoutesForThread,
    runAttemptId: (threadId) => agentLifecycle.usageRunAttemptId(threadId),
    plannerAgentId: (threadId) => agentLifecycle.usagePlannerAgentId(threadId),
  });

  if (resolved.status === "rejected") {
    if (resolved.reason === "missing_turn_metadata") {
      // Fail-closed billing without turning the Gateway observer into a thrown error storm.
      logEcoDiag("codex.gateway_usage_rejected", {
        reason: resolved.reason,
        source: event.source,
        providerId: event.providerId,
        sourceEventId: event.sourceEventId,
      });
      process.stderr.write(
        `[eco-codex] gateway usage will not be billed: missing_turn_metadata ` +
          `provider=${event.providerId} source=${event.source}\n`,
      );
      return;
    }
    if (resolved.reason === "thread_attribution_not_found" && event.codexTurnMetadata) {
      const queued = codexGatewayUsagePending.enqueue(event);
      if (queued.status === "queued") {
        logEcoDiag("codex.gateway_usage_pending", {
          codexThreadId: queued.entry.codexThreadId,
          turnId: queued.entry.turnId,
          pendingCount: queued.pendingCount,
        });
        return;
      }
    }
    throw new Error(
      `Codex Gateway usage rejected: ${resolved.reason}` +
        (resolved.codexThreadId ? ` (thread=${resolved.codexThreadId})` : ""),
    );
  }

  const routeRegistration = registerResolvedCodexGatewayTurnRoute({
    billingResult: resolved,
    requestedModel: event.requestedModel,
    providerId: event.providerId,
    upstreamModelId: event.upstreamModelId,
  });
  if (routeRegistration.status === "rejected" || routeRegistration.status === "conflict") {
    throw new Error(
      routeRegistration.status === "conflict"
        ? `Codex Gateway route conflict: ${errorMessage(routeRegistration.error)}`
        : `Codex Gateway route rejected: ${routeRegistration.reason}`,
    );
  }

  const deduplication = codexGatewayUsageDeduplicator.observe({
    requestKey: resolved.requestKey,
    usage: resolved.usage,
    ...(event.providerRequestId && {
      providerRequestId: event.providerRequestId,
    }),
    ...(event.usage.totalCostUsd !== undefined && {
      sourceReportedCostUsd: event.usage.totalCostUsd,
    }),
  });
  if (deduplication.status === "duplicate") {
    return;
  }
  if (deduplication.status === "conflict") {
    throw new Error(`Codex Gateway usage conflict for request ${resolved.requestKey}.`);
  }

  noteUsageBillingObservation(resolved.threadId, resolved.observation);
  logEcoDiag("codex.gateway_usage", {
    threadId: shortThreadId(resolved.threadId),
    codexThreadId: resolved.codexThreadId,
    turnId: resolved.turnId,
    requestKind: resolved.requestKind,
    role: resolved.billingRole,
    modelId: resolved.usage.modelId ?? null,
    inputTokens: resolved.usage.inputTokens,
    outputTokens: resolved.usage.outputTokens,
    cacheReadTokens: resolved.usage.cacheReadTokens,
    cacheCreationTokens: resolved.usage.cacheCreationTokens,
  });
  const timingIdsForBilling = {
    logicalRequestId: event.logicalRequestId?.trim() || resolved.turnId,
    providerRequestId: (event.providerRequestId ?? event.responseId)?.trim(),
  };
  const billingTask = processUsageBilling({
    ...resolved.billingInput,
    ...(event.ttftMs !== undefined && { ttftMs: event.ttftMs }),
    ...(event.generationMs !== undefined && {
      generationMs: event.generationMs,
    }),
    ...(event.firstHeadersMs !== undefined && {
      firstHeadersMs: event.firstHeadersMs,
    }),
    ...(event.firstTokenMs !== undefined && {
      firstTokenMs: event.firstTokenMs,
    }),
    logicalRequestId: timingIdsForBilling.logicalRequestId,
  }).then(
    () => undefined,
    (error) => {
      codexGatewayUsageDeduplicator.forget(resolved.requestKey);
      throw error;
    },
  );
  usageLedgerCoordinator.trackUsageUpdate(resolved.threadId, billingTask);
  await billingTask;
}

function flushPendingCodexGatewayUsage(codexThreadId: string): void {
  for (const pending of codexGatewayUsagePending.drain(codexThreadId)) {
    void handleCodexGatewayUsage(pending.event).catch((error) => {
      process.stderr.write(
        `[eco-codex] pending gateway usage failed codexThread=${codexThreadId}: ${errorMessage(error)}\n`,
      );
    });
  }
}

/**
 * Bill Codex turns from app-server token usage for direct (non-gateway) routes.
 *
 * eco-gateway only sees traffic that goes through it. Built-in OpenAI (auth.json)
 * and other direct routes bypass the gateway, so the app-server's per-turn
 * `appServerTokenUsage` is the only ledger source for those turns. Gateway-routed
 * turns keep billing from gateway usage events — the provider gate below keeps
 * the two sources mutually exclusive.
 */
async function handleCodexAppServerTurnUsage(input: {
  threadId: string;
  codexThreadId: string;
  turnId: string;
  appServerTokenUsage: CodexTurnTokenUsageBreakdown;
  appServerTokenUsageRequests?: CodexTurnTokenUsageBreakdown[];
}): Promise<void> {
  const { threadId, codexThreadId, turnId, appServerTokenUsage } = input;
  const attribution = resolveCodexThreadAttribution(codexThreadMap, codexThreadId);
  if (!attribution || attribution.ecoThreadId !== threadId) {
    // Thread mapping not persisted yet; never guess attribution for billing.
    process.stderr.write(
      `[eco-codex] app-server turn usage skipped: missing attribution codexThread=${codexThreadId} thread=${threadId}\n`,
    );
    return;
  }
  const billingRole = normalizeTelemetryBillingRole(attribution.billingRole);
  // Role routes only: resolveRuntimeRoutesForThread drops the built-in OpenAI route
  // because it joins providers from the ProviderStore, which has no auth.json entry.
  const roleRoute = resolveRoleRoutesForThread(threadId).find(
    (candidate) =>
      normalizeTelemetryBillingRole(candidate.role) === billingRole && candidate.providerId === "openai",
  );
  if (!roleRoute) {
    process.stderr.write(
      `[eco-codex] app-server turn usage skipped: no direct-openai role route role=${billingRole} thread=${threadId}\n`,
    );
    return;
  }
  // A real API-key OpenAI provider goes through eco-gateway; only the virtual
  // built-in (auth.json) route is billed from app-server usage.
  const storedOpenAi = providerStore.listProvidersWithSecrets().find((provider) => provider.id === "openai");
  if (storedOpenAi?.hasApiKey) {
    return;
  }
  const usage: ParsedUsage = {
    ...normalizeCodexAppServerUsage(appServerTokenUsage),
    modelId: roleRoute.modelId,
  };
  if (
    usage.inputTokens === 0 &&
    usage.outputTokens === 0 &&
    usage.cacheReadTokens === 0 &&
    usage.cacheCreationTokens === 0
  ) {
    return;
  }
  const requestKey = `codex-turn-usage:${codexThreadId}:${turnId}`;
  const runAttemptId = agentLifecycle.currentRunAttemptId(threadId);
  const plannerAgentId = attribution.isSubagentThread
    ? undefined
    : agentLifecycle.usagePlannerAgentId(threadId);
  noteUsageBillingObservation(threadId, {
    source: "codex",
    role: billingRole,
    usage,
    requestKey,
    modelId: roleRoute.modelId,
    ...(attribution.agentId ? { agentId: attribution.agentId } : {}),
  });
  const requests = buildCodexAppServerBillingRequests({
    usage: appServerTokenUsage,
    ...(input.appServerTokenUsageRequests && { requests: input.appServerTokenUsageRequests }),
    requestKey,
  });
  const billingTask = (async () => {
    for (const request of requests) {
      await processUsageBilling({
        threadId,
        role: billingRole,
        source: "codex",
        usage: { ...request.usage, modelId: roleRoute.modelId },
        modelId: roleRoute.modelId,
        providerId: "openai",
        requestKey: request.requestKey,
        codexUsageIsAggregate: request.codexUsageIsAggregate,
        // The context meter is fed directly by thread/tokenUsage/updated.
        updateContext: false,
        ...(runAttemptId ? { runAttemptId } : {}),
        ...(plannerAgentId ? { plannerAgentId } : {}),
        ...(attribution.agentId ? { agentId: attribution.agentId } : {}),
      });
    }
  })().then(
    () => undefined,
    (error) => {
      throw error;
    },
  );
  usageLedgerCoordinator.trackUsageUpdate(threadId, billingTask);
  await billingTask;
  logEcoDiag("codex.app_server_turn_usage", {
    threadId: shortThreadId(threadId),
    codexThreadId,
    turnId,
    role: billingRole,
    modelId: roleRoute.modelId,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens,
  });
}

function resolveProxyUsageApiCompat(
  threadId: string,
  role: RuntimeAgentRole,
  apiCompat?: UpstreamApiCompat,
): UpstreamApiCompat {
  if (apiCompat) {
    return apiCompat;
  }
  try {
    const roleRoutes = resolveRoleRoutesForThread(threadId);
    const route = roleRoutes.find((entry) => entry.role === role);
    if (!route) {
      return "anthropic";
    }
    const provider = providerStore.listProvidersWithSecrets().find((entry) => entry.id === route.providerId);
    return resolveUpstreamApiCompat(route.apiCompat, provider?.apiCompat);
  } catch {
    return "anthropic";
  }
}

async function emitProxyUsage(
  info: AnthropicProxyUsageInfo & { threadId: string },
): Promise<UpstreamProxyCallBilling | null> {
  // Prefer binding-stamped attempt id so late usage cannot attach to a newer attempt.
  const runAttemptId = info.stampedRunAttemptId?.trim();
  const plannerAgentId = agentLifecycle.usagePlannerAgentId(info.threadId);
  const currentRequestSeq = activeRunBillingState.proxyRequestSeq(info.threadId);
  const registryStamp = proxyBillingStampRegistry.resolveForRoute(info.threadId, info.role);
  const stampedAgentId = info.stampedAgentId ?? registryStamp?.agentId;
  const stampedBillingRole = info.stampedBillingRole ?? registryStamp?.billingRole;
  const stampedParentToolUseId = info.stampedParentToolUseId ?? registryStamp?.parentToolUseId;
  const resolved = resolveProxyUsageBilling({
    info: {
      ...info,
      apiCompat: resolveProxyUsageApiCompat(info.threadId, info.role, info.apiCompat),
    },
    ...(currentRequestSeq !== undefined && { currentRequestSeq }),
    ...(runAttemptId && { runAttemptId }),
    ...(plannerAgentId && { plannerAgentId }),
    resolver: subagentMetricsRegistry,
    ...(stampedAgentId ? { stampedAgentId } : {}),
    ...(stampedBillingRole ? { stampedBillingRole } : {}),
    ...(stampedParentToolUseId ? { stampedParentToolUseId } : {}),
  });
  activeRunBillingState.recordProxyRequest(info.threadId, {
    nextRequestSeq: resolved.nextRequestSeq,
    contextRole: resolved.contextRole,
    contextOccupied: resolved.contextOccupied,
  });
  logEcoDiag("proxy.usage", {
    threadId: shortThreadId(info.threadId),
    role: info.role,
    contextRole: resolved.contextRole,
    requestSeq: currentRequestSeq ?? null,
    providerId: info.providerId,
    provider: info.providerName,
    apiCompat: info.apiCompat,
    modelId: info.modelId,
    aliasModelId: info.aliasModelId ?? null,
    requestedModel: info.requestedModel ?? null,
    inputTokens: info.usage.inputTokens,
    outputTokens: info.usage.outputTokens,
    cacheReadTokens: info.usage.cacheReadTokens,
    cacheCreationTokens: info.usage.cacheCreationTokens,
    contextOccupied: resolved.contextOccupied,
    stampedAgentId: stampedAgentId ? shortAgentId(stampedAgentId) : null,
    stampedBillingRole: stampedBillingRole ?? null,
    stampedParentToolUseId: stampedParentToolUseId?.slice(-12) ?? null,
    runAttemptId: runAttemptId?.slice(-12) ?? null,
  });
  noteUsageBillingObservation(info.threadId, resolved.observation);
  const billingTask = processUsageBilling({
    ...resolved.billingInput,
    ...(info.ttftMs !== undefined && { ttftMs: info.ttftMs }),
    ...(info.generationMs !== undefined && { generationMs: info.generationMs }),
    ...(info.firstHeadersMs !== undefined && {
      firstHeadersMs: info.firstHeadersMs,
    }),
    ...(info.firstTokenMs !== undefined && { firstTokenMs: info.firstTokenMs }),
  });
  usageLedgerCoordinator.trackUsageUpdate(
    info.threadId,
    billingTask.then(
      () => undefined,
      (error) => {
        process.stderr.write(`[eco] proxy usage billing failed: ${errorMessage(error)}\n`);
      },
    ),
  );
  try {
    return await billingTask;
  } catch (error) {
    process.stderr.write(`[eco] proxy usage billing failed: ${errorMessage(error)}\n`);
    return null;
  }
}

function lookupUsageBillingPricing(...args: Parameters<UsageBillingPricingLookup>) {
  return createAccountUsagePricingLookup({
    lookupChatGptApiRates: (modelId, usage, aggregate) =>
      getChatGptModelCatalogService().resolveApiRates(modelId, usage, aggregate),
    lookupOtherPricing: (route) => pricingCache.lookupForRoute({
      baseUrl: route.provider.baseUrl,
      modelId: route.modelId,
      ...(route.modelsDevMapping && { mapping: route.modelsDevMapping }),
    }),
  })(...args);
}

function usageBillingEffectsServices() {
  return {
    reportSdkBillingWarning: (threadId: string, warning: string) =>
      emitThreadEvent(
        threadId,
        "billing.warning",
        warning === "sdk_session_usage_baseline_missing"
          ? "当前恢复会话缺少以前的累计用量；首次结果仅建立基线，该轮计费尚未核实。"
          : "SDK 返回的累计用量发生回退，本次计费已暂停，需核实会话用量。",
        "system",
        false,
      ),

    context: createUsageContextService({
      monitor: contextMonitor,
      emitLiveContext: (threadId: string) => contextScheduler.emitLiveFromMonitor(threadId),
    }),
    usageLedger: usageLedgerCoordinator,
    subagentMetrics: subagentMetricsRegistry,
    emitUsageUpdated: (event: UsageBillingUpdatedEvent) => {
      emitUsageUpdatedFromBillingEffects(event);
    },
    schedulePersistThreadMetrics,
  };
}

function emitUsageUpdatedFromBillingEffects(event: UsageBillingUpdatedEvent): void {
  const threadStatus = conversationStore.getThread(event.threadId)?.status;
  const billing = enrichBillingDisplaySource(event.payload.billing, threadStatus);
  emitThreadEvent(event.threadId, "thread.usage_updated", event.badge, event.role, false, {
    ...event.payload,
    billing,
    totalCostUsd: billing.sourceReportedCostUsd,
  });
}

async function processUsageBilling(
  input: SingleUsageBillingRequest,
): Promise<UpstreamProxyCallBilling | null> {
  const billingRuntime = await resolveBillingRuntimeContext(billingRuntimeEnvironment, input.threadId);
  const accountPlanner = resolveRoleRoutesForThread(input.threadId).find(
    (route) => route.role === "main" && isBuiltInCodexCatalogProvider(route.providerId),
  );

  const resolved = await resolveSingleUsageBillingOrchestration({
    request: input,
    runtimeRoutes: billingRuntime.runtimeRoutes,
    lookupPricing: billingRuntime.lookupPricing,
    lookupCodexApiRates: (modelId, usage) =>
      getCodexModelCatalogService().resolveApiRates(modelId, usage, input.codexUsageIsAggregate),
    ...(accountPlanner && { codexPlannerModelId: accountPlanner.modelId }),
  });
  if (!resolved) {
    return null;
  }

  await applySingleUsageBillingEffects(usageBillingEffectsServices(), resolved.effectsInput);
  maybeEmitPromptCacheHitDrop(input);
  return resolved.requestBillingLog;
}

function maybeEmitPromptCacheHitDrop(input: SingleUsageBillingRequest): void {
  if (input.reconciliationOnly || input.role !== "main") {
    return;
  }
  const detection = threadCacheHitMonitor.observePlannerUsage(input.threadId, {
    inputTokens: input.usage.inputTokens,
    cacheReadTokens: input.usage.cacheReadTokens,
    cacheCreationTokens: input.usage.cacheCreationTokens,
  });
  if (!detection) {
    return;
  }
  process.stderr.write(
    `[eco] prompt cache hit dropped thread=${input.threadId} ${Math.round(detection.previousRatio * 100)}%→${Math.round(detection.currentRatio * 100)}% cache_read_loss=${detection.cacheReadLossTokens}/${detection.currentPromptTokens}\n`,
  );
  promptCacheRunEventEmitter.emitHitDropped(input.threadId, detection, {
    ...(input.requestKey && { requestKey: input.requestKey }),
    ...(input.runAttemptId && { runAttemptId: input.runAttemptId }),
  });
}

function resolveThreadWorktreePath(threadId: string): string | undefined {
  const { workspacePath, worktreePathHint } = resolveWorktreeContextForThread(threadId);
  if (!workspacePath || !worktreePathHint || !existsSync(worktreePathHint)) {
    return undefined;
  }
  return worktreePathHint;
}

/** Call after finishActiveRun to refresh the context meter from monitor state. */
async function afterRunContextRefresh(threadId: string, worktreePath?: string): Promise<void> {
  await contextLifecycle.afterRunRefresh(threadId, worktreePath);
}

function resetSubagentContextWindows(threadId: string): void {
  contextScheduler.clearSubagentState(threadId);
  contextScheduler.emitLiveFromMonitor(threadId);
}

function emitThreadContextUpdated(threadId: string, context: ThreadContextSnapshot): void {
  emitThreadEvent(threadId, "thread.context_updated", "", "system", false, {
    context,
  });
  schedulePersistThreadMetrics(threadId);
}

function loadThreadMetricsFromStore(): void {
  const v2 = conversationStore.conversationV2();
  if (conversationStore.getConversationStorageMode() === "v2_only") {
    // In V2-only mode billing is reconstructed from the V2 usage ledger. The
    // old accumulator snapshot is intentionally not restored because it is a
    // historical migration input and can be stale or differently deduplicated.
    for (const thread of conversationStore.listThreads()) {
      if (!v2.hasConversation(thread.id)) {
        throw new ConversationV2Error(
          CONVERSATION_V2_ERROR.integrityFailure,
          `Conversation V2 stream is missing during metrics restore: ${thread.id}`,
        );
      }
      const context = v2.getProjectionSnapshot(thread.id)?.context;
      if (context !== undefined) {
        if (!isRecord(context)) {
          throw new ConversationV2Error(
            CONVERSATION_V2_ERROR.integrityFailure,
            `Conversation V2 context snapshot is invalid: ${thread.id}`,
          );
        }
        contextScheduler.restoreSnapshot(thread.id, context as unknown as ThreadContextSnapshot);
      }
      subagentMetricsRegistry.restoreFromStore(thread.id);
    }
    return;
  }
  const legacyRecords = conversationStore.listThreadMetrics().filter((record) => {
    if (!v2.hasConversation(record.threadId)) {
      return true;
    }
    const snapshot = v2.getProjectionSnapshot(record.threadId);
    const usageState = snapshot?.usageState;
    if (usageState === undefined) {
      return true;
    }
    if (!isRecord(usageState)) {
      throw new ConversationV2Error(
        CONVERSATION_V2_ERROR.integrityFailure,
        `Conversation V2 usage state is invalid: ${record.threadId}`,
      );
    }
    threadUsageAccumulator.restoreState(record.threadId, usageState as unknown as SerializedThreadUsageState);
    const context = snapshot?.context;
    if (context !== undefined) {
      if (!isRecord(context)) {
        throw new ConversationV2Error(
          CONVERSATION_V2_ERROR.integrityFailure,
          `Conversation V2 context snapshot is invalid: ${record.threadId}`,
        );
      }
      contextScheduler.restoreSnapshot(record.threadId, context as unknown as ThreadContextSnapshot);
    }
    return false;
  });
  restoreThreadMetricsFromStore({
    store: { listThreadMetrics: () => legacyRecords },
    accumulator: threadUsageAccumulator,
    contextSnapshots: contextScheduler,
    subagentMetrics: subagentMetricsRegistry,
    contextMonitor,
  });
  // Subagent metrics now live in the V2 projection snapshot. Restore them
  // through the same persistence facade so request dedupe and role ownership
  // survive a restart without rereading thread_subagent_metrics.
  for (const thread of conversationStore.listThreads()) {
    if (v2.hasConversation(thread.id)) {
      subagentMetricsRegistry.restoreFromStore(thread.id);
    }
  }
  // One-time maintenance bridge for databases cut over before the V2 panel
  // snapshot existed. The renderer never reads these legacy rows; this copies
  // their already-restored value into the V2-owned projection snapshot so a
  // restart does not blank the usage/context panels. Future writes go through
  // emitThreadEvent -> updateConversationV2ProjectionExtras.
  for (const record of conversationStore.listThreadMetrics()) {
    const v2 = conversationStore.conversationV2();
    if (!v2.hasConversation(record.threadId) || v2.getProjectionSnapshot(record.threadId)) {
      continue;
    }
    const thread = conversationStore.getThread(record.threadId);
    if (!thread) {
      continue;
    }
    const legacyBilling = threadUsageAccumulator.getSnapshot(record.threadId);
    const billing =
      usageLedgerCoordinator.projectBillingSnapshot(record.threadId, legacyBilling?.plannerModelLabel) ??
      (legacyBilling
        ? usageLedgerCoordinator.enrichBillingSnapshot(record.threadId, legacyBilling)
        : undefined);
    conversationStore.updateConversationV2ProjectionExtras(record.threadId, {
      ...(billing ? { billing } : {}),
      ...(record.context ? { context: record.context } : {}),
      subagentTimings: buildSubagentSessionTimings(conversationStore.listSubagentSessions(record.threadId)),
    });
  }
}

function persistThreadMetricsNow(threadId: string): void {
  const v2 = conversationStore.conversationV2();
  if (v2.hasConversation(threadId)) {
    const context = contextScheduler.getDisplaySnapshot(threadId);
    conversationStore.saveThreadMetrics(threadId, {
      ...(context ? { context } : {}),
    });
    return;
  }
  persistThreadMetrics(
    {
      store: conversationStore,
      accumulator: threadUsageAccumulator,
      contextSnapshots: contextScheduler,
    },
    threadId,
  );
}

function threadMetricsPersistenceServices() {
  return {
    store: conversationStore,
    accumulator: threadUsageAccumulator,
    contextSnapshots: contextScheduler,
  };
}

function schedulePersistThreadMetrics(threadId: string): void {
  const existing = persistMetricsTimers.get(threadId);
  if (existing) {
    clearTimeout(existing);
  }
  persistMetricsTimers.set(
    threadId,
    setTimeout(() => {
      persistMetricsTimers.delete(threadId);
      persistThreadMetricsNow(threadId);
    }, 400),
  );
}

function flushAllThreadMetrics(): void {
  for (const timer of persistMetricsTimers.values()) {
    clearTimeout(timer);
  }
  persistMetricsTimers.clear();

  for (const thread of conversationStore.listThreads()) {
    persistThreadMetricsNow(thread.id);
  }
}

function onSdkUsageRecordedEvent(threadId: string, event: AgentEventLike & { id: string }): void {
  handleSdkUsageRecordedEvent({
    threadId,
    event,
    services: sdkUsageRecordedEventHandlerServices(),
  });
}

function applySdkContextSideEffects(threadId: string, event: AgentEventLike): boolean {
  return applySdkContextEventSideEffects({
    threadId,
    eventId: event.id,
    payload: event.payload,
  });
}

function applySdkContextEventSideEffects(input: {
  threadId: string;
  eventId: string;
  payload: unknown;
}): boolean {
  return contextLifecycle.handleSdkContextEvent(input);
}

function sdkUsageRecordedEventHandlerServices() {
  return {
    handleContextEvent: applySdkContextEventSideEffects,
    usageRunAttemptId: (threadId: string) => agentLifecycle.usageRunAttemptId(threadId),
    usagePlannerAgentId: (threadId: string) => agentLifecycle.usagePlannerAgentId(threadId),
    listObservedAuthoritativeUsage: (threadId: string) => activeRunBillingState.listObservations(threadId),
    noteAssistantMessageIdentity: (input: {
      threadId: string;
      messageId: string;
      agentId: string;
      role: RuntimeAgentRole;
      parentToolUseId?: string;
    }) => {
      usageLedgerCoordinator.bindProxyMessageIdentity(input.threadId, {
        messageId: input.messageId,
        agentId: input.agentId,
        role: input.role,
        ...(input.parentToolUseId && {
          parentToolUseId: input.parentToolUseId,
        }),
      });
    },
    resolver: subagentMetricsRegistry,
    dispatchUsageBilling: dispatchSdkEventUsageBilling,
    dispatchServices: sdkUsageBillingDispatchServices(),
  };
}

function sdkUsageBillingDispatchServices() {
  return {
    trackUsageUpdate: (threadId: string, task: Promise<void>) =>
      usageLedgerCoordinator.trackUsageUpdate(threadId, task),
    processUsageBilling,
    processSdkStreamPartialUsage,
    processSdkRunBilling,
    logResolution: logSdkUsageResolution,
    writeError: (message: string) => process.stderr.write(message),
  };
}

function logSdkUsageResolution(
  threadId: string,
  resolved: Extract<ReturnType<typeof resolveSdkEventUsageBilling>, { kind: "stream_partial" | "sdk_run" }>,
): void {
  if (resolved.kind === "sdk_run" && resolved.missDiagnostic) {
    logEcoDiag("sdk.usage_miss", {
      threadId: shortThreadId(threadId),
      role: resolved.missDiagnostic.role,
      eventId: resolved.missDiagnostic.eventId.slice(-12),
      parentToolUseId: resolved.missDiagnostic.parentToolUseId?.slice(-12),
      explicitSubagentId: resolved.missDiagnostic.explicitSubagentId?.slice(-12) ?? null,
    });
  }

  const diagnostic = resolved.diagnostic;
  logEcoDiagThrottled(
    diagnostic.throttleKey,
    "sdk.usage",
    {
      threadId: shortThreadId(threadId),
      role: diagnostic.role,
      subagentAgentId: diagnostic.subagentAgentId?.slice(-12) ?? null,
      explicit: diagnostic.explicit,
      parentToolUseId: diagnostic.parentToolUseId?.slice(-12) ?? null,
      stream: diagnostic.stream,
      inputTokens: diagnostic.inputTokens,
      outputTokens: diagnostic.outputTokens,
      cacheReadTokens: diagnostic.cacheReadTokens,
      cacheCreationTokens: diagnostic.cacheCreationTokens,
    },
    500,
  );
}

async function processSdkStreamPartialUsage(input: SdkStreamPartialBillingRequest): Promise<void> {
  const billingRuntime = await resolveBillingRuntimeContext(billingRuntimeEnvironment, input.threadId);
  const resolved = await resolveSdkStreamPartialBillingOrchestration({
    request: input,
    runtimeRoutes: billingRuntime.runtimeRoutes,
    lookupPricing: billingRuntime.lookupPricing,
  });

  await applySdkStreamPartialBillingEffects(usageBillingEffectsServices(), resolved.effectsInput);
}

const sdkRunBillingQueues = new Map<string, Promise<void>>();
function processSdkRunBilling(input: SdkRunUsageBillingInput): Promise<void> {
  // Pricing lookup is async: preserve result arrival order before checkpoint settlement.
  const previous = sdkRunBillingQueues.get(input.threadId) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(() => processSdkRunBillingInOrder(input));
  sdkRunBillingQueues.set(input.threadId, next);
  void next
    .finally(() => {
      if (sdkRunBillingQueues.get(input.threadId) === next) sdkRunBillingQueues.delete(input.threadId);
    })
    .catch(() => {});
  return next;
}
async function processSdkRunBillingInOrder(input: SdkRunUsageBillingInput): Promise<void> {
  const billingRuntime = await resolveBillingRuntimeContext(billingRuntimeEnvironment, input.threadId);
  const resolved = await resolveSdkRunBillingResolution({
    threadId: input.threadId,
    role: input.role,
    requestKey: input.requestKey,
    bundle: input.bundle,
    runtimeRoutes: billingRuntime.runtimeRoutes,
    lookupPricing: billingRuntime.lookupPricing,
    resolver: subagentMetricsRegistry,
    ...(input.usagePayload !== undefined && {
      usagePayload: input.usagePayload,
    }),
    ...(input.runAttemptId && { runAttemptId: input.runAttemptId }),
    ...(input.plannerAgentId && { plannerAgentId: input.plannerAgentId }),
    ...(input.subagentAgentId && { subagentAgentId: input.subagentAgentId }),
    ...(input.parentToolUseId && { parentToolUseId: input.parentToolUseId }),
  });

  for (const observation of resolved.observations) {
    noteUsageBillingObservation(input.threadId, observation);
  }

  await applySdkRunBillingEffects(usageBillingEffectsServices(), resolved.effectsInput);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireConversationV2Thread(conversationId: string, options: { repairOnLoad?: boolean } = {}): void {
  const id = conversationId.trim();
  conversationRecoveryGate.assertReady(id);
  if (!conversationStore.getThread(id)) {
    throw new ConversationV2Error(
      CONVERSATION_V2_ERROR.conversationNotFound,
      "Conversation V2 conversation was not found.",
    );
  }
  const v2 = conversationStore.conversationV2();
  if (conversationStore.getConversationStorageMode() === "legacy_compat") {
    const migrator = conversationStore.conversationV2LegacyMigrator();
    if (!v2.hasConversation(id) || migrator.hasResumableMigration(id)) {
      const startedAt = Date.now();
      try {
        const report = migrator.migrate(id);
        logUpstream("conversation.v1-lazy-migration.completed", {
          threadId: shortThreadId(id),
          userMessageCount: report.userMessageCount,
          legacyEventCount: report.legacyEventCount,
          runAttemptCount: report.runAttemptCount,
          elapsedMs: Date.now() - startedAt,
        });
      } catch (error) {
        logUpstream("conversation.v1-lazy-migration.failed", {
          threadId: shortThreadId(id),
          message: errorMessage(error),
          elapsedMs: Date.now() - startedAt,
        });
        throw error;
      }
    }
  }
  if (!v2.hasConversation(id)) {
    throw new ConversationV2Error(
      CONVERSATION_V2_ERROR.migrationIncomplete,
      "Conversation V2 migration has not completed for this conversation.",
      { conversationId: id },
    );
  }
  // One-time data repairs for this conversation. Recorded per conversation, so
  // loading it again after the first pass costs only a lookup.
  if (options.repairOnLoad !== false) {
    conversationStore.repairConversationV2OnLoad(id);
  }
}

function isSdkCompactionStatusEvent(event: AgentEventLike): boolean {
  if (!isRecord(event.payload)) {
    return false;
  }
  return (
    event.payload.type === "system" &&
    event.payload.subtype === "status" &&
    event.payload.status === "compacting"
  );
}

function isSdkCompactionBoundaryEvent(event: AgentEventLike): boolean {
  return isRecord(event.payload) && event.payload.subtype === "compact_boundary";
}

function isLinkAgentsSkillsRequest(value: unknown): value is LinkAgentsSkillsRequest {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as LinkAgentsSkillsRequest).workspacePath === "string" &&
    ((value as LinkAgentsSkillsRequest).baseDir === undefined ||
      typeof (value as LinkAgentsSkillsRequest).baseDir === "string")
  );
}

function isSkillUninstallRequest(value: unknown): value is SkillUninstallRequest {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as SkillUninstallRequest).directory === "string" &&
    Boolean((value as SkillUninstallRequest).directory.trim())
  );
}

function isSkillCatalogSearchRequest(value: unknown): value is SkillCatalogSearchRequest {
  return (
    isRecord(value) &&
    typeof value.query === "string" &&
    value.query.trim().length >= 2 &&
    (value.limit === undefined || (typeof value.limit === "number" && Number.isInteger(value.limit)))
  );
}

function isSkillCatalogInstallRequest(value: unknown): value is SkillCatalogInstallRequest {
  return (
    isRecord(value) &&
    typeof value.source === "string" &&
    typeof value.skillId === "string" &&
    (value.layout === "agents" ||
      value.layout === "codex" ||
      value.layout === "claude" ||
      value.layout === "pi")
  );
}

async function resolveComposerCapabilitiesForThread(threadId: string) {
  const thread = conversationStore.getThread(threadId);
  if (!thread) throw new Error("会话不存在或已删除。");
  const config = ensureThreadRuntimeConfig(thread).runtimeConfig;
  if (!config) throw new Error("会话缺少运行配置。");
  const settings = getModelSettingsSnapshot();
  const snapshot =
    thread.coreKind === "acp" ? undefined : resolveThreadOrchestrationSnapshot(settings, config);
  const routes = snapshot ? roleRoutesForThreadConfig(settings, config) : [];
  const servers = mcpStore.listServers();
  const enabledMcp = new Set(
    resolveThreadRuntimeMcpServerKeys({
      runtimeConfig: config,
      settings,
      availableMcpServerKeys: listEnabledGlobalMcpServerKeys(servers),
    }),
  );
  return buildComposerCapabilityReferences({
    availability: await resolveIntegrationAvailability(),
    integrationsEnabled: config.integrationsEnabled ?? {},
    mcpServers: servers,
    mcpServersEnabled: Object.fromEntries([...enabledMcp].map((key) => [key, true])),
    agents: (snapshot?.agents ?? []).map((agent) => ({
      agentKey: agent.agentKey,
      name:
        agent.displayName?.trim() ||
        settings.agentTemplates.find((template) => template.id === agent.templateId)?.name ||
        agent.agentKey,
      modelId: routes.find((route) => route.role === agent.agentKey)?.modelId ?? "",
      enabled:
        agent.enabled &&
        (!Object.hasOwn(config.subagentEnabled, agent.agentKey) ||
          config.subagentEnabled[agent.agentKey as keyof typeof config.subagentEnabled] === true),
    })),
  });
}

async function resolveIntegrationAvailability() {
  const browserSettings = browserSettingsStore.get();
  const browserFeature = requireBrowserHost().isFeatureAvailable();
  const computerUseSettings = computerUseSettingsStore.get();
  const computerUseFeature = computerUseGateway.isFeatureAvailableQuick();
  const ttsSettings = ttsStore.getSettings();
  const ttsProfile = ttsSettings.profiles.find((profile) => profile.id === ttsSettings.activeProfileId);
  const ttsReason = !ttsProfile?.hasApiKey
    ? "当前语音生成 Profile 尚未配置 API Key。"
    : !ttsSettings.apiKeyEncryptionAvailable
      ? "系统加密不可用，无法读取语音生成 API Key。"
      : undefined;
  const imageSettings = imageGenerationStore.getSettings();
  const activeImageProfile = imageSettings.profiles.find(
    (profile) => profile.id === imageSettings.activeProfileId,
  );
  const imageAvailability = imageGenerationAvailability(
    imageSettings,
    activeImageProfile?.provider === "codex" || activeImageProfile?.provider === "chatgpt_web"
      ? await codexImages.getAvailability(activeImageProfile.provider)
      : undefined,
  );
  return {
    integrations: [
      {
        id: "browser" as const,
        enabled: browserSettings.agentIntegrationEnabled,
        available: browserFeature.available,
        ...(browserFeature.reason ? { reason: browserFeature.reason } : {}),
      },
      {
        id: "computerUse" as const,
        enabled: computerUseSettings.agentIntegrationEnabled,
        available: computerUseFeature.available,
        ...(computerUseFeature.reason ? { reason: computerUseFeature.reason } : {}),
      },
      {
        id: "tts" as const,
        enabled: ttsSettings.enabled,
        available: Boolean(ttsSettings.enabled && ttsProfile?.hasApiKey && !ttsReason),
        ...(ttsReason ? { reason: ttsReason } : {}),
        ...(ttsProfile ? { activeProfileName: ttsProfile.name } : {}),
      },
      {
        id: "imageGeneration" as const,
        enabled: imageSettings.enabled,
        ...imageAvailability,
        ...(activeImageProfile ? { activeProfileName: activeImageProfile.name } : {}),
      },
    ],
  };
}

async function buildSdkSessionOptions(
  threadId: string,
  prompt?: string,
  options?: { skillsScope?: SdkSessionSkillsScope },
): Promise<EcoSdkSessionOptions> {
  const mcp = mcpStore.buildSdkConfig();
  const thread = conversationStore.getThread(threadId);
  const hydrated = thread ? ensureThreadRuntimeConfig(thread) : undefined;
  const settings = getModelSettingsSnapshot();
  const availableMcpServerKeys = listEnabledGlobalMcpServerKeys(mcpStore.listServers());
  const enabledMcpServers = resolveThreadRuntimeMcpServerKeys({
    ...(hydrated?.runtimeConfig ? { runtimeConfig: hydrated.runtimeConfig } : {}),
    settings,
    availableMcpServerKeys,
  });
  const sessionEcoBrowserEnabled =
    browserSettingsStore.get().agentIntegrationEnabled &&
    integrationEnabled(hydrated?.runtimeConfig?.integrationsEnabled, "browser");
  const sessionComputerUseEnabled =
    computerUseSettingsStore.get().agentIntegrationEnabled &&
    integrationEnabled(hydrated?.runtimeConfig?.integrationsEnabled, "computerUse");
  const sessionImageGenerationEnabled =
    imageGenerationStore.getSettings().enabled &&
    integrationEnabled(hydrated?.runtimeConfig?.integrationsEnabled, "imageGeneration");
  const sessionTtsEnabled =
    ttsStore.getSettings().enabled && integrationEnabled(hydrated?.runtimeConfig?.integrationsEnabled, "tts");
  const browserInject = await requireBrowserHost().resolveAgentBrowserMcpInjection({
    threadId,
    sessionEnabled: sessionEcoBrowserEnabled,
  });
  if (sessionEcoBrowserEnabled && !browserInject.enabled) {
    throw new Error(`本会话已开启内置浏览器，但不可用：${browserInject.unavailableReason ?? "未知原因"}`);
  }
  const computerUseInject = await computerUseGateway.resolveInjection({
    threadId,
    sessionEnabled: sessionComputerUseEnabled,
  });
  if (sessionComputerUseEnabled && !computerUseInject.enabled) {
    throw new Error(`本会话已开启电脑操控，但不可用：${computerUseInject.unavailableReason ?? "未知原因"}`);
  }
  const imageInject = await imageGenerationGateway.resolveInjection({
    threadId,
    sessionEnabled: sessionImageGenerationEnabled,
  });
  if (sessionImageGenerationEnabled && !imageInject.enabled) {
    throw new Error(`本会话已开启创意绘画，但不可用：${imageInject.unavailableReason ?? "未知原因"}`);
  }
  const ttsInject = await ttsGateway.resolveInjection({
    threadId,
    sessionEnabled: sessionTtsEnabled,
  });
  if (sessionTtsEnabled && !ttsInject.enabled) {
    throw new Error(`本会话已开启语音生成，但不可用：${ttsInject.unavailableReason ?? "未知原因"}`);
  }
  const imageViewInject = await imageViewGateway.resolveInjection(threadId);
  const imageDisplayInject = await imageDisplayGateway.resolveInjection(threadId);
  const htmlHostingCapability = await centerServerClient.refreshHtmlHostingCapability();
  const htmlHostInject = htmlHostingCapability.available
    ? await htmlHostGateway.resolveInjection(threadId)
    : undefined;
  const agentRegistry = resolveAgentRuntimeConfigForThreadId(threadId);
  const plannerRoute = resolveRoleRoutesForThread(threadId).find((route) => route.role === "main");
  const integratedWebSearchSettings = integratedWebSearchSettingsStore.get();
  const integratedWebSearchApiKey = integratedWebSearchSettings.enabled
    ? integratedWebSearchSettingsStore.getApiKey()
    : undefined;
  const webSearchPlan = resolveThreadWebSearchPlan({
    networkWebSearch: agentRegistry
      ? materializeEcoToolPolicy(agentRegistry.orchestration.mainAgent.tools).network?.webSearch
      : undefined,
    ...(plannerRoute?.manualSpec ? { plannerManualSpec: plannerRoute.manualSpec } : {}),
    integratedSettings: integratedWebSearchSettings,
    ...(integratedWebSearchApiKey ? { integratedApiKey: integratedWebSearchApiKey } : {}),
  });
  const webSearchInject = await integratedWebSearchGateway.resolveInjection({
    threadId,
    sessionEnabled: webSearchPlan.backend === "integrated",
  });
  if (webSearchPlan.backend === "integrated" && !webSearchInject.enabled) {
    throw new Error(
      `本会话需要 Integrated Web Search，但不可用：${webSearchInject.unavailableReason ?? "未知原因"}`,
    );
  }
  let ecoBrowserSkillFilePath: string | undefined;
  if (browserInject.enabled) {
    const ensured = await ensureClaudeUserEcoAgentBrowserSkill();
    if (!ensured.ok) {
      throw new Error(`本会话已开启内置浏览器，但 skill 不可用：${ensured.reason}`);
    }
    ecoBrowserSkillFilePath = ensured.skillFilePath;
  }
  const filteredMcp = filterMcpSdkConfigByAssignedServers(
    mcp,
    enabledMcpServers.filter(
      (key) =>
        key !== ECO_AGENT_BROWSER_MCP_SERVER &&
        !key.startsWith("eco_ab_") &&
        key !== ECO_COMPUTER_USE_MCP_SERVER &&
        key !== ECO_IMAGE_VIEW_MCP_SERVER &&
        key !== ECO_IMAGE_DISPLAY_MCP_SERVER &&
        key !== ECO_HTML_HOST_MCP_SERVER &&
        key !== ECO_WEB_SEARCH_MCP_SERVER,
    ),
  );
  const hubServerKeys = enabledMcpServers.filter(
    (key) => Object.hasOwn(mcp.mcpServers, key) && !key.startsWith("eco_"),
  );
  const withBrowserMcp = requireBrowserHost().mergeIntoSdkMcpConfig(filteredMcp, browserInject);
  const withComputerUseMcp = computerUseGateway.mergeIntoSdkConfig(withBrowserMcp, computerUseInject);
  const withImageMcp = imageGenerationGateway.mergeIntoSdkConfig(withComputerUseMcp, imageInject);
  const withTtsMcp = ttsGateway.mergeIntoSdkConfig(withImageMcp, ttsInject);
  const withImageViewMcp = imageViewGateway.mergeIntoSdkConfig(withTtsMcp, imageViewInject);
  const withImageDisplayMcp = imageDisplayGateway.mergeIntoSdkConfig(withImageViewMcp, imageDisplayInject);
  const withHtmlHostMcp = htmlHostInject
    ? htmlHostGateway.mergeIntoSdkConfig(withImageDisplayMcp, htmlHostInject)
    : withImageDisplayMcp;
  const withWebSearchMcp = integratedWebSearchGateway.mergeIntoSdkConfig(withHtmlHostMcp, webSearchInject);
  withWebSearchMcp.mcpServers[SCHEDULING_MCP_SERVER] = (
    await schedulingGateway.resolveInjection(threadId)
  ).sdkEntry;
  withWebSearchMcp.mcpServers[CONTEXT_MCP_SERVER] = (
    await contextReferenceGateway.resolveInjection(threadId)
  ).sdkEntry;
  const hubBuiltinKeys = Object.keys(withWebSearchMcp.mcpServers).filter(
    (key) => key.startsWith("eco_") && key !== "eco_mcp",
  );
  for (const key of hubBuiltinKeys) {
    const entry = withWebSearchMcp.mcpServers[key];
    if (isRecord(entry)) {
      mcpHubGateway.registerThreadServerEntry({ name: key, threadId, sdkEntry: entry });
    }
  }
  const hubInjection = await mcpHubGateway.prepareThreadFromSdkConfig({
    threadId,
    config: mcp,
    allowedServers: [...hubServerKeys, ...hubBuiltinKeys],
  });
  const hubRuntimeConfig: typeof withWebSearchMcp = {
    mcpServers: { ...withWebSearchMcp.mcpServers },
    allowedTools: hubInjection ? ["mcp__eco_mcp__search_tools", "mcp__eco_mcp__call_tool"] : [],
  };
  for (const key of hubServerKeys) delete hubRuntimeConfig.mcpServers[key];
  for (const key of hubBuiltinKeys) delete hubRuntimeConfig.mcpServers[key];
  if (hubInjection) hubRuntimeConfig.mcpServers.eco_mcp = hubInjection.sdkEntry;
  const runtimeMcp = prepareMcpSdkConfigForRuntime(hubRuntimeConfig);
  const runtimeMcpServers = [...(hubInjection ? ["eco_mcp"] : [])];
  const enabledSubagents = hydrated?.runtimeConfig?.subagentEnabled ?? defaultSubagentAvailability();
  const workspacePath =
    thread?.workspacePath ??
    (currentWorkspace?.path && currentWorkspace.path.trim() ? currentWorkspace.path : undefined);
  const discovered = await listDiscoveredSkills(workspacePath);
  const skillsEnabled = hydrated?.runtimeConfig?.skillsEnabled;
  const enabledProjectSkills = listSdkReadyProjectSkills(discovered.projectSkills).filter(
    (skill) =>
      skill.name !== ECO_AGENT_BROWSER_SKILL_NAME &&
      (skillsEnabled?.[skill.settingsKey ?? skill.skillFilePath] ?? true),
  );
  const enabledUserSkills = discovered.userSkills.filter(
    (skill) =>
      skill.name !== ECO_AGENT_BROWSER_SKILL_NAME &&
      skill.sdkReady &&
      (skillsEnabled?.[skill.settingsKey ?? skill.skillFilePath] ?? false),
  );
  const projectNames = enabledProjectSkills.map((skill) => skill.name);
  const enabledUserNames = [
    ...enabledUserSkills.map((skill) => skill.name),
    ...(ecoBrowserSkillFilePath ? [ECO_AGENT_BROWSER_SKILL_NAME] : []),
  ];
  const implicitReadAllowRoots = resolveImplicitSkillReadRoots(os.homedir(), workspacePath, [
    ...enabledProjectSkills,
    ...enabledUserSkills,
    ...(ecoBrowserSkillFilePath
      ? [
          {
            name: ECO_AGENT_BROWSER_SKILL_NAME,
            description: "Eco built-in browser skill",
            source: "user" as const,
            directory: path.dirname(ecoBrowserSkillFilePath),
            skillFilePath: ecoBrowserSkillFilePath,
            layout: "claude" as const,
            sdkReady: true,
          },
        ]
      : []),
  ]);
  const skillConfig = resolveSdkSessionSkillConfig(options?.skillsScope ?? "default", {
    projectNames,
    explicitUser: enabledUserNames,
  });
  const snapshot = hydrated?.runtimeConfig
    ? resolveThreadOrchestrationSnapshot(settings, hydrated.runtimeConfig)
    : undefined;
  const mainAgentModelKey = hydrated?.runtimeConfig
    ? resolveMainAgentModelKey(settings, hydrated.runtimeConfig)
    : buildMainAgentModelKey(undefined);
  const orchestrationKey = buildOrchestrationRuntimeKey(
    snapshot,
    hydrated?.runtimeConfig?.orchestrationSelection,
  );
  if (!orchestrationKey) {
    throw new Error(
      "Thread orchestration snapshot is missing; select a complete orchestration before running.",
    );
  }
  const agentSkills = buildRuntimeAgentSkillAssignments(skillConfig.skills, snapshot);
  await auditThreadPromptCacheBeforeSdkSession({
    threadId,
    orchestrationKey,
    mainAgentModelKey,
    mcpServerKeys: runtimeMcpServers,
    ...(workspacePath ? { workspacePath } : {}),
    includeUserClaudeMd: skillConfig.settingSources.includes("user"),
  });
  return {
    settingSources: skillConfig.settingSources,
    skills: skillConfig.skills,
    ...(implicitReadAllowRoots.length > 0 ? { implicitReadAllowRoots } : {}),
    agentSkills,
    enabledSubagents,
    ...(runtimeMcpServers.length > 0 ? { runtimeMcpServers } : {}),
    ...(Object.keys(runtimeMcp.mcpServers).length > 0 ? { mcpServers: runtimeMcp.mcpServers } : {}),
    ...(runtimeMcp.allowedTools.length > 0 ? { mcpAllowedTools: runtimeMcp.allowedTools } : {}),
    ...(webSearchPlan.backend === "integrated" ? { disallowedTools: ["WebSearch"] } : {}),
  };
}

function isPlanReadyPayload(payload: unknown): payload is PlanReadyPayload {
  if (typeof payload !== "object" || payload === null) {
    return false;
  }
  const candidate = payload as PlanReadyPayload;
  return (
    typeof candidate.userPrompt === "string" &&
    typeof candidate.analysis === "string" &&
    typeof candidate.plan === "string" &&
    (candidate.planFilePath === undefined || typeof candidate.planFilePath === "string") &&
    (candidate.deferredExitPlanToolUseId === undefined ||
      typeof candidate.deferredExitPlanToolUseId === "string")
  );
}

async function removeIsolatedWorktree(plan: WorktreePlan, threadId: string): Promise<void> {
  const session = conversationStore.getSdkSession(threadId);
  const sessionCwd = session?.cwd;
  try {
    await gitWorktrees.removeWorktree(plan);
    emitThreadEvent(threadId, "worktree.removed", "已清理隔离工作树。", "system");
  } catch (error) {
    console.error("Failed to remove worktree:", error);
  } finally {
    if (sessionCwd && path.resolve(sessionCwd) === path.resolve(plan.worktreePath)) {
      conversationStore.clearSdkSession(threadId);
    }
  }
}

function initializeGitAutoFetcher(): void {
  gitAutoFetcher = new GitAutoFetcher({
    run: runGitCommand,
    isGitBusy: () => activeGitOperations > 0,
    onFetched: (workspacePath) => {
      desktopEventCenter.publishGitRemoteFetched(workspacePath);
    },
  });
  applyGitAutoFetcherSettings();
  syncGitAutoFetcherWorkspace();
}

function applyGitAutoFetcherSettings(): void {
  if (!gitAutoFetcher) {
    return;
  }
  const settings = gitSettingsStore.get();
  gitAutoFetcher.configure({
    enabled: settings.autofetch !== false,
    periodSeconds: settings.autofetchPeriod ?? 180,
  });
}

function syncGitAutoFetcherWorkspace(): void {
  if (!gitAutoFetcher) {
    return;
  }
  const workspacePath =
    currentWorkspace?.isGitRepository && currentWorkspace.path.trim()
      ? currentWorkspace.path.trim()
      : undefined;
  gitAutoFetcher.setWorkspace(workspacePath);
}

async function runGitCommand(
  command: string[],
  cwd: string,
  options?: { stdin?: string; signal?: AbortSignal },
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  activeGitOperations += 1;
  try {
    return await new Promise((resolve) => {
      const child = execFile(
        command[0] === "git" ? resolveGitExecutable() : (command[0] ?? resolveGitExecutable()),
        command.slice(1),
        { cwd, maxBuffer: 10 * 1024 * 1024, ...(options?.signal ? { signal: options.signal } : {}) },
        (error, stdout, stderr) => {
          if (error) {
            const failed = error as NodeJS.ErrnoException & { code?: number };
            resolve({
              exitCode: typeof failed.code === "number" ? failed.code : 1,
              stdout: String(stdout ?? ""),
              stderr: String(stderr ?? errorMessage(error)),
            });
            return;
          }
          resolve({
            exitCode: 0,
            stdout: String(stdout),
            stderr: String(stderr),
          });
        },
      );
      if (options?.stdin !== undefined) {
        child.stdin?.end(options.stdin);
      } else {
        child.stdin?.end();
      }
    });
  } finally {
    activeGitOperations -= 1;
  }
}

function normalizeThreadMessage(status: ThreadStatus, message: string): string {
  const persisted = persistThreadSummaryMessage(status, message);
  if (!persisted) {
    return "";
  }
  if (status === "failed") {
    return formatUserFacingRequestError(persisted);
  }
  if (persisted.startsWith(planExecutionFailurePrefix)) {
    const detail = persisted.slice(planExecutionFailurePrefix.length);
    return buildPlanExecutionFailureMessage(formatUserFacingRequestError(detail));
  }
  return persisted;
}

function updateThread(threadId: string, patch: Pick<ThreadSummary, "message" | "status">): void {
  if (!conversationStore.getThread(threadId)) {
    return;
  }
  if (!shouldKeepThreadCancelling(patch.status)) {
    clearThreadCancelling(threadId);
  }

  const message = normalizeThreadMessage(patch.status, patch.message);
  conversationStore.updateThread(threadId, { ...patch, message });
  const followUpQueuePaused = autoPauseFollowUpQueueForErrorStatus(threadId, patch.status);
  const pendingPlan =
    patch.status === "awaiting_plan" ? conversationStore.getPendingPlan(threadId) : undefined;
  emitThreadEvent(threadId, `thread.${patch.status}`, message, "system", false, {
    ...(pendingPlan ? { plan: buildThreadPlanLivePayload(pendingPlan) } : {}),
    ...(typeof followUpQueuePaused === "boolean" ? { followUpQueuePaused } : {}),
  });
  syncSystemSleepBlocker();
}

/**
 * Mid-run switch to Eco「完全访问」: approve parked execution cards so the UI clears
 * and awaiters continue. Mirrors bashApprovalResolve event side-effects.
 */
function flushPendingBashApprovalsForAllowAllSwitch(threadId: string): void {
  const approved = approveAllPendingBashApprovalsForThread(threadId);
  for (const request of approved) {
    const threadPatch = buildResolvedBashApprovalThreadPatch("approved");
    patchThreadSummary(threadId, threadPatch);
    desktopEventCenter.publishThreadLiveEvent({
      threadId,
      type: "bash_approval.resolved",
      message: threadPatch.message,
      role: "tool",
      stream: false,
      bashApproval: request,
    });
  }
}

function patchThreadSummary(threadId: string, patch: Pick<ThreadSummary, "message" | "status">): void {
  if (!conversationStore.getThread(threadId)) {
    return;
  }
  if (!shouldKeepThreadCancelling(patch.status)) {
    clearThreadCancelling(threadId);
  }

  const message = normalizeThreadMessage(patch.status, patch.message);
  conversationStore.updateThread(threadId, { ...patch, message });
  autoPauseFollowUpQueueForErrorStatus(threadId, patch.status);
  // Status can leave running/queued here (e.g. markThreadInterrupted → blocked)
  // without going through updateThread; keep the sleep blocker in sync.
  syncSystemSleepBlocker();
}

/** Auto-pause queued follow-ups when the session errors; returns current paused flag when known. */
function autoPauseFollowUpQueueForErrorStatus(
  threadId: string,
  status: ThreadSummary["status"],
): boolean | undefined {
  if (status !== "failed" && status !== "blocked") {
    return conversationStore.getThread(threadId)?.followUpQueuePaused ? true : undefined;
  }
  const current = conversationStore.getThread(threadId);
  if (!current) {
    return undefined;
  }
  if (current.followUpQueuePaused) {
    return true;
  }
  // Only a pause with a subject: an empty queue has no rows to protect, and arming it would
  // silently queue the next message the user composes after the error.
  autoPauseFollowUpQueueWhenQueuedRemain(threadId);
  return conversationStore.getThread(threadId)?.followUpQueuePaused ? true : undefined;
}

/** Pause the follow-up queue when queued rows remain after a user stop. */
function autoPauseFollowUpQueueWhenQueuedRemain(threadId: string): void {
  if (!shouldAutoPauseFollowUpQueue(countQueuedThreadFollowUps(threadId))) {
    return;
  }
  setThreadFollowUpQueuePausedState(threadId, true);
}

/**
 * Drop a pause that has no queued rows left (rows cancelled or force-drained). Keeps the
 * thread summary, the renderer flag, and the DB flag in sync through the resumed event.
 */
function releaseFollowUpQueuePauseWhenEmpty(threadId: string): void {
  const thread = conversationStore.getThread(threadId);
  if (!thread) {
    return;
  }
  if (
    !shouldReleaseFollowUpQueuePause({
      paused: Boolean(thread.followUpQueuePaused),
      queuedCount: countQueuedThreadFollowUps(threadId),
    })
  ) {
    return;
  }
  setThreadFollowUpQueuePausedState(threadId, false);
}

function countQueuedThreadFollowUps(threadId: string): number {
  return conversationStore.listThreadFollowUps(threadId, {
    statuses: ["queued"],
  }).length;
}

function setThreadFollowUpQueuePausedState(threadId: string, paused: boolean): ThreadSummary | undefined {
  const existing = conversationStore.getThread(threadId);
  if (!existing) {
    return undefined;
  }
  if (Boolean(existing.followUpQueuePaused) === paused) {
    return existing;
  }
  const thread = conversationStore.setThreadFollowUpQueuePaused(threadId, paused);
  if (!thread) {
    return undefined;
  }
  emitThreadEvent(
    threadId,
    paused ? "thread.follow_up_queue_paused" : "thread.follow_up_queue_resumed",
    paused ? "排队发送已暂停。" : "排队发送已恢复。",
    "system",
    false,
    { followUpQueuePaused: Boolean(thread.followUpQueuePaused) },
  );
  return thread;
}

function emitTodoList(threadId: string, todoList: CoderTodoItem[]): void {
  void todoList;
  emitThreadEvent(threadId, "thread.todos_updated", "TODO 已更新", "system", false);
}

function emitSubagentTimingUpdated(threadId: string): void {
  emitThreadEvent(threadId, "thread.subagent_timing_updated", "", "system", false, {
    subagentSessions: buildSubagentSessionTimings(conversationStore.listSubagentSessions(threadId)),
  });
}

interface EmitThreadEventExtras {
  workspacePath?: string;
  plan?: ThreadLiveEvent["plan"];
  planApproval?: ThreadLiveEvent["planApproval"];
  clarification?: ThreadLiveEvent["clarification"];
  bashApproval?: ThreadLiveEvent["bashApproval"];
  followUp?: ThreadLiveEvent["followUp"];
  title?: ThreadLiveEvent["title"];
  titleGenerating?: ThreadLiveEvent["titleGenerating"];
  usage?: ThreadUsageSnapshot;
  modelId?: string;
  totalCostUsd?: number;
  modelUsage?: Record<string, ThreadModelUsageEntry>;
  billing?: ThreadBillingSnapshot;
  context?: ThreadContextSnapshot;
  agentId?: string;
  subagentSessions?: ThreadLiveEvent["subagentSessions"];
  apiError?: ThreadLiveEvent["apiError"];
  runtimeConfig?: ThreadRuntimeConfig;
  externalSessionId?: string;
  tool?: ThreadRunToolMetadata;
  metadata?: Record<string, unknown>;
  requestId?: string;
  composerRestore?: ThreadLiveEvent["composerRestore"];
  threadPrompt?: string;
  followUpQueuePaused?: boolean;
}

function extractUrlFromLooseTextMessageForNavigate(message: string): string | undefined {
  const trimmed = message.trim();
  if (!trimmed) {
    return undefined;
  }
  // Only trust message when it is (or embeds) an explicit http(s) URL — never event labels.
  if (/https?:\/\//i.test(trimmed)) {
    return (
      extractUrlFromBrowserOpenToolPayload({ href: trimmed }) ??
      extractUrlFromBrowserOpenToolPayload({ url: trimmed })
    );
  }
  return undefined;
}

function resolveToolUseIdFromActivityPayload(payload: unknown): string | undefined {
  if (!isRecord(payload)) {
    return undefined;
  }
  const direct =
    typeof payload.tool_use_id === "string"
      ? payload.tool_use_id
      : typeof payload.toolUseId === "string"
        ? payload.toolUseId
        : undefined;
  if (direct?.trim()) {
    return direct.trim();
  }
  return isRecord(payload.tool) ? resolveToolUseIdFromActivityPayload(payload.tool) : undefined;
}

function maybeRevealBrowserFromAgentTool(input: {
  threadId?: string;
  toolName?: string;
  message?: string;
  payload?: unknown;
}): void {
  const fromPayload = resolveToolNameFromActivityPayload(input.payload);
  const fromMessage = input.message
    ? resolveToolNameFromActivityPayload({ message: input.message })
    : undefined;
  const toolName = (input.toolName ?? fromPayload ?? fromMessage ?? "").trim();
  if (toolName && isEcoTtsToolName(toolName)) {
    const threadId = input.threadId?.trim();
    if (threadId)
      ttsGateway.noteUpcomingTool(threadId, toolName, resolveToolUseIdFromActivityPayload(input.payload));
  }
  if (toolName && isEcoImageGenerationToolName(toolName)) {
    const threadId = input.threadId?.trim();
    const toolUseId = resolveToolUseIdFromActivityPayload(input.payload);
    if (threadId) imageGenerationGateway.noteUpcomingTool(threadId, toolName, toolUseId);
  }
  if (toolName && (isEcoImageViewToolName(toolName) || toolName === ECO_IMAGE_VIEW_TOOL)) {
    const threadId = input.threadId?.trim();
    const toolUseId = resolveToolUseIdFromActivityPayload(input.payload);
    if (threadId) imageViewGateway.noteUpcomingTool(threadId, toolName, toolUseId);
  }
  if (toolName && (isEcoImageDisplayToolName(toolName) || toolName === ECO_IMAGE_DISPLAY_TOOL)) {
    const threadId = input.threadId?.trim();
    const toolUseId = resolveToolUseIdFromActivityPayload(input.payload);
    if (threadId) imageDisplayGateway.noteUpcomingTool(threadId, toolName, toolUseId);
  }
  if (toolName && (isEcoHtmlHostToolName(toolName) || toolName === ECO_HTML_HOST_TOOL)) {
    const threadId = input.threadId?.trim();
    const toolUseId = resolveToolUseIdFromActivityPayload(input.payload);
    if (threadId) htmlHostGateway.noteUpcomingTool(threadId, toolName, toolUseId);
  }
  if (toolName && isEcoWebSearchToolName(toolName)) {
    const threadId = input.threadId?.trim();
    const toolUseId = resolveToolUseIdFromActivityPayload(input.payload);
    if (threadId) integratedWebSearchGateway.noteUpcomingTool(threadId, toolName, toolUseId);
  }
  const threadId = input.threadId?.trim();
  if (!threadId || !toolName) {
    return;
  }
  if (
    toolName.includes("agent_browser") ||
    toolName.includes("eco_agent_browser") ||
    toolName.includes("eco_ab_")
  ) {
    requireBrowserHost().noteBrowserToolStarted(threadId, toolName);
  }
  // Navigation / tab creation run once in BrowserHost.invokeNativeAgentBrowserTool (MCP path).
  // tool.started only registers auth claims — no notifyAgentBrowserOpen (avoid double open).
}

function maybeRevealBrowserFromThreadRunEvent(event: {
  threadId: string;
  eventType: string;
  message?: string;
  metadata?: Record<string, unknown> | undefined;
}): void {
  // Only on tool.started — tool.completed with the same URL used to mint a second tab.
  if (event.eventType !== "tool.started") {
    return;
  }
  const metaTool =
    event.metadata?.tool && typeof event.metadata.tool === "object"
      ? (event.metadata.tool as Record<string, unknown>)
      : undefined;
  const toolName =
    (typeof metaTool?.name === "string" ? metaTool.name : undefined) ??
    resolveToolNameFromActivityPayload(event.metadata) ??
    resolveToolNameFromActivityPayload({ message: event.message });
  const name = (toolName ?? "").trim();
  if (name && isEcoTtsToolName(name)) {
    ttsGateway.noteUpcomingTool(
      event.threadId,
      name,
      typeof metaTool?.toolUseId === "string" ? metaTool.toolUseId.trim() : undefined,
    );
  }
  if (name && isEcoImageGenerationToolName(name)) {
    const toolUseId = typeof metaTool?.toolUseId === "string" ? metaTool.toolUseId.trim() : undefined;
    imageGenerationGateway.noteUpcomingTool(event.threadId, name, toolUseId);
  }
  if (name && (isEcoImageViewToolName(name) || name === ECO_IMAGE_VIEW_TOOL)) {
    const toolUseId = typeof metaTool?.toolUseId === "string" ? metaTool.toolUseId.trim() : undefined;
    imageViewGateway.noteUpcomingTool(event.threadId, name, toolUseId);
  }
  if (name && (isEcoImageDisplayToolName(name) || name === ECO_IMAGE_DISPLAY_TOOL)) {
    const toolUseId = typeof metaTool?.toolUseId === "string" ? metaTool.toolUseId.trim() : undefined;
    imageDisplayGateway.noteUpcomingTool(event.threadId, name, toolUseId);
  }
  if (name && (isEcoHtmlHostToolName(name) || name === ECO_HTML_HOST_TOOL)) {
    const toolUseId = typeof metaTool?.toolUseId === "string" ? metaTool.toolUseId.trim() : undefined;
    htmlHostGateway.noteUpcomingTool(event.threadId, name, toolUseId);
  }
  if (name && isEcoWebSearchToolName(name)) {
    const toolUseId = typeof metaTool?.toolUseId === "string" ? metaTool.toolUseId.trim() : undefined;
    integratedWebSearchGateway.noteUpcomingTool(event.threadId, name, toolUseId);
  }
  if (!toolName || !isEcoAgentBrowserOpenToolName(toolName)) {
    if (
      name &&
      (name.includes("agent_browser") || name.includes("eco_agent_browser") || name.includes("eco_ab_"))
    ) {
      requireBrowserHost().noteBrowserToolStarted(event.threadId, name);
    }
    return;
  }
  maybeRevealBrowserFromAgentTool({
    threadId: event.threadId,
    ...(toolName ? { toolName } : {}),
    ...(event.message ? { message: event.message } : {}),
    payload: event.metadata,
  });
}

/**
 * The model has begun writing a tool call.
 *
 * Codex's app-server publishes a tool only once its arguments are complete, and a large
 * `apply_patch` is written for minutes: measured 65.8s and 125.3s of complete silence between
 * the last visible text and the tool row, with nothing on the wire to notice. The upstream
 * stream does state the fact (the tool item is added milliseconds after the last text), so the
 * gateway forwards it and it lands in the same Feed slot the SDK cores use.
 */
function emitCodexToolWriteActivity(observation: {
  state: "writing" | "ready";
  codexThreadId: string;
  turnId?: string;
  callId?: string;
  toolName?: string;
  kind: ToolWritingActivity["kind"];
  target?: string;
}): void {
  const attribution = resolveCodexThreadAttribution(codexThreadMap, observation.codexThreadId);
  const ecoThreadId = attribution?.ecoThreadId;
  if (!ecoThreadId) {
    return;
  }
  // `apply_patch` is announced as the card the Feed will open for it ("Edit"), not as the
  // function name the model sent.
  const toolName = observation.toolName ? codexToolDisplayName(observation.toolName) : undefined;
  const writing: ToolWritingActivity = {
    ...(observation.kind && { kind: observation.kind }),
    ...(toolName && { name: toolName }),
    ...(observation.target && { target: observation.target }),
  };
  // The Feed reads the fact from `toolWriting`; the message is the closest thing to a label for
  // any consumer that still reads one (empty for a provider-side call with neither name nor target).
  emitThreadEvent(
    ecoThreadId,
    observation.state === "ready" ? "tool.writing.completed" : "tool.writing",
    toolName ?? observation.target ?? "",
    "tool",
    false,
    {
      ...(attribution?.agentId && { agentId: attribution.agentId }),
      ...(observation.turnId && { requestId: observation.turnId }),
      metadata: {
        activityOrigin: "gateway.codex_tool_writing",
        toolWriting: writing,
        codexThreadId: observation.codexThreadId,
        ...(observation.turnId && { turnId: observation.turnId }),
        ...(observation.callId && { toolCallId: observation.callId }),
      },
    },
  );
}

function emitThreadEvent(
  threadId: string,
  type: string,
  message: string,
  role: RuntimeAgentRole | "system" | "thinking" | "tool" | "user" = "system",
  stream = false,
  extras?: EmitThreadEventExtras,
): ThreadActivityLine | undefined {
  extras = projectEmitThreadEventExtras(threadId, extras);
  let projectionExtrasPersisted = false;
  if (extras?.billing || extras?.context || extras?.subagentSessions) {
    try {
      conversationStore.updateConversationV2ProjectionExtras(threadId, {
        ...(extras.billing ? { billing: extras.billing } : {}),
        ...(extras.context ? { context: extras.context } : {}),
        ...(extras.subagentSessions ? { subagentTimings: extras.subagentSessions } : {}),
      });
      projectionExtrasPersisted = conversationStore.conversationV2().hasConversation(threadId);
    } catch (error) {
      logEcoDiag("conversation.v2_projection_snapshot_write_failed", {
        threadId: shortThreadId(threadId),
        eventType: type,
        error: errorMessage(error),
      });
      if (conversationStore.getConversationStorageMode() === "v2_only") {
        throw error;
      }
    }
  }
  if (projectionExtrasPersisted) {
    desktopEventCenter.publish({
      kind: "conversation.projection_extras",
      threadId,
      aggregateKey: `conversation:${threadId}:projection-extras`,
      payload: { conversationId: threadId },
    });
  }
  if (type === "tool.started") {
    maybeRevealBrowserFromAgentTool({
      threadId,
      ...(extras?.tool?.name ? { toolName: extras.tool.name } : {}),
      message,
      payload: {
        ...(extras?.metadata ?? {}),
        ...(extras?.tool ? { tool: extras.tool } : {}),
      },
    });
  }
  const { text: normalizedMessage } = repairActivityText(message);
  const trimmed = normalizedMessage.trim();
  const messageDecision = resolveEmitThreadEventMessage({
    type,
    message: trimmed,
    stream,
    hasStructuredExtras: hasStructuredThreadEventExtras(extras),
    hasPlan: Boolean(extras?.plan),
  });
  if (messageDecision.drop) {
    return undefined;
  }
  const displayMessage = messageDecision.persistedMessage;

  if (!isMetricsOnlyThreadLiveEvent(type)) {
    const persistExtras = extras
      ? {
          ...extras,
          metadata: {
            ...(extras.metadata ?? {}),
            ...(extras.clarification ? { clarification: extras.clarification } : {}),
            ...(extras.plan ? { plan: extras.plan } : {}),
            ...(extras.planApproval ? { planApproval: extras.planApproval } : {}),
          },
        }
      : undefined;
    recordThreadRunEventFromLiveEvent({
      threadId,
      type,
      displayMessage,
      role: String(role),
      stream,
      ...(persistExtras && { extras: persistExtras }),
    });
  }

  if (type.startsWith("bash_approval.")) {
    const thread = conversationStore.getThread(threadId);
    if (thread) {
      const status = type === "bash_approval.requested" ? "running" : thread.status;
      patchThreadSummary(threadId, {
        message: persistThreadSummaryMessage(status, thread.message),
        status,
      });
    }
  }

  if (type.startsWith("plan_approval.")) {
    const thread = conversationStore.getThread(threadId);
    if (thread) {
      const status = type === "plan_approval.requested" ? "awaiting_plan" : thread.status;
      patchThreadSummary(threadId, {
        message: persistThreadSummaryMessage(status, thread.message),
        status,
      });
    }
  }

  const payload: ThreadLiveEvent = {
    threadId,
    type,
    message: messageDecision.liveMessage,
    role,
    stream,
    ...(isThreadCancelling(threadId) ? { cancelling: true } : {}),
    ...(extras?.apiError && { apiError: extras.apiError }),
  };
  if (extras?.plan) {
    payload.plan = extras.plan;
  }
  if (extras?.clarification) {
    payload.clarification = extras.clarification;
  }
  if (extras?.bashApproval) {
    payload.bashApproval = extras.bashApproval;
  }
  if (extras?.planApproval) {
    payload.planApproval = extras.planApproval;
  }
  if (extras?.followUp) {
    payload.followUp = extras.followUp;
  }
  if (extras?.title) {
    payload.title = extras.title;
  }
  if (extras?.titleGenerating !== undefined) {
    payload.titleGenerating = extras.titleGenerating;
  }
  if (extras?.usage) {
    payload.usage = extras.usage;
  }
  if (extras?.modelId) {
    payload.modelId = extras.modelId;
  }
  if (extras?.totalCostUsd !== undefined) {
    payload.totalCostUsd = extras.totalCostUsd;
  }
  if (extras?.modelUsage) {
    payload.modelUsage = extras.modelUsage;
  }
  if (extras?.billing) {
    payload.billing = extras.billing;
  }
  if (extras?.context) {
    payload.context = extras.context;
  }
  if (extras?.subagentSessions) {
    payload.subagentSessions = extras.subagentSessions;
  }
  if (extras?.runtimeConfig) {
    payload.runtimeConfig = extras.runtimeConfig;
  }
  if (extras?.externalSessionId) {
    payload.externalSessionId = extras.externalSessionId;
  }
  if (extras?.tool) {
    const tool = projectThreadRunToolMetadataForFeed(
      enrichHtmlHostToolMetadata(threadId, enrichImageDisplayToolMetadata(threadId, extras.tool)),
    );
    if (tool) {
      payload.tool = tool;
    }
  }
  if (extras?.composerRestore) {
    payload.composerRestore = extras.composerRestore;
  }
  if (extras?.threadPrompt !== undefined) {
    payload.threadPrompt = extras.threadPrompt;
  }
  if (typeof extras?.followUpQueuePaused === "boolean") {
    payload.followUpQueuePaused = extras.followUpQueuePaused;
  }

  if (type === "workspace.changes" || type === "thread.completed" || type === "thread.idle") {
    scheduleWorkspaceGitStatusPublishForThread(threadId);
  }

  const workspacePath =
    extras?.workspacePath?.trim() || conversationStore.getThread(threadId)?.workspacePath?.trim();
  desktopEventCenter.publishThreadLiveEvent(payload, workspacePath);
  return undefined;
}

function projectEmitThreadEventExtras(
  threadId: string,
  extras: EmitThreadEventExtras | undefined,
): EmitThreadEventExtras | undefined {
  if (!extras?.tool && !extras?.followUp) {
    return extras;
  }
  const { tool: _tool, followUp: _followUp, ...rest } = extras;
  const tool = extras.tool
    ? projectThreadRunToolMetadata(
        enrichHtmlHostToolMetadata(threadId, enrichImageDisplayToolMetadata(threadId, extras.tool)),
      )
    : undefined;
  const followUp = extras.followUp ? sanitizeThreadFollowUpForWire(extras.followUp) : undefined;
  return {
    ...rest,
    ...(tool ? { tool } : {}),
    ...(followUp ? { followUp } : {}),
  };
}

/**
 * Feed preview is attached via store lookup (toolUseId / latest), not model-visible tool output.
 * display_image only returns `{ status: "ok" }` to the model.
 */
function enrichImageDisplayToolMetadata(
  threadId: string,
  tool: ThreadRunToolMetadata,
): ThreadRunToolMetadata {
  if (!isEcoImageDisplayToolName(tool.name) && tool.name.trim() !== ECO_IMAGE_DISPLAY_TOOL) {
    return tool;
  }
  if (tool.status === "started" || tool.imageDisplay?.artifactId?.trim()) {
    return tool;
  }
  if (!imageDisplayStore) {
    return tool;
  }
  const byToolUseId = tool.toolUseId?.trim()
    ? imageDisplayStore.getArtifactByToolUseId(tool.toolUseId)
    : undefined;
  const artifact = byToolUseId ?? imageDisplayStore.getLatestArtifact(threadId);
  if (!artifact || artifact.status !== "completed") {
    return tool;
  }
  return {
    ...tool,
    imageDisplay: {
      artifactId: artifact.id,
      ...(artifact.title?.trim() ? { title: artifact.title.trim() } : {}),
    },
  };
}

function enrichHtmlHostToolMetadata(threadId: string, tool: ThreadRunToolMetadata): ThreadRunToolMetadata {
  if (!isEcoHtmlHostToolName(tool.name) && tool.name.trim() !== ECO_HTML_HOST_TOOL) {
    return tool;
  }
  if (tool.status === "started" || tool.htmlHost?.pageId?.trim()) {
    return tool;
  }
  if (!htmlHostStore) {
    return tool;
  }
  const byToolUseId = tool.toolUseId?.trim()
    ? htmlHostStore.getArtifactByToolUseId(tool.toolUseId)
    : undefined;
  const artifact = byToolUseId ?? htmlHostStore.getLatestArtifact(threadId);
  if (!artifact || artifact.status !== "completed") {
    return tool;
  }
  return {
    ...tool,
    htmlHost: {
      pageId: artifact.pageId,
      publicUrl: artifact.publicUrl,
      title: artifact.title,
      expiresAt: artifact.expiresAt,
      canExtend: artifact.canExtend,
    },
  };
}

function emitContextCompactionStatus(
  threadId: string,
  input: {
    stage: "started" | "completed" | "failed" | "suspended";
    trigger?: "auto" | "manual";
    sessionId?: string;
    archiveId?: string;
    preTokens?: number;
    postTokens?: number;
    detail?: string;
    consecutiveFailures?: number;
  },
): void {
  if (!conversationStore.getThread(threadId)) {
    return;
  }
  const trigger = input.trigger ?? "auto";
  const message = formatContextCompactionMessage(input.stage, trigger, input.detail);
  const now = new Date().toISOString();
  const unique =
    input.archiveId ?? input.sessionId ?? `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const runAttemptId = resolveCurrentRunAttemptId(threadId);
  const metadata: Record<string, unknown> = {
    liveType: `context.compaction.${input.stage}`,
    compaction: {
      stage: input.stage,
      trigger,
      ...(input.sessionId && { sessionId: input.sessionId }),
      ...(input.archiveId && { archiveId: input.archiveId }),
      ...(input.preTokens !== undefined && { preTokens: input.preTokens }),
      ...(input.postTokens !== undefined && { postTokens: input.postTokens }),
      ...(input.detail && { detail: input.detail }),
      ...(input.consecutiveFailures !== undefined && {
        consecutiveFailures: input.consecutiveFailures,
      }),
    },
  };
  try {
    conversationStore.appendConversationRuntimeEvent({
      id: `tre:${threadId}:context-compaction:${input.stage}:${unique}`,
      threadId,
      eventType: `context.compaction.${input.stage}`,
      scope: "main",
      streamState: "none",
      message,
      observedAt: now,
      ...(runAttemptId && { runAttemptId }),
      metadata,
    });
    scheduleThreadRunProjectionUpdated(threadId);
  } catch (error) {
    process.stderr.write(`[eco] context compaction status write failed: ${errorMessage(error)}\n`);
  }
}

function formatContextCompactionMessage(
  stage: "started" | "completed" | "failed" | "suspended",
  trigger: "auto" | "manual",
  detail?: string,
): string {
  if (stage === "suspended") {
    return `自动上下文压缩已暂停（连续失败 3 次）。请手动压缩或开启新会话。`;
  }
  if (stage === "failed") {
    return detail ? `上下文压缩失败：${detail}` : "上下文压缩失败";
  }
  if (stage === "started") {
    return trigger === "manual" ? "正在手动压缩上下文" : "正在自动压缩上下文";
  }
  const base = trigger === "manual" ? "上下文已手动压缩" : "上下文已自动压缩";
  return detail ? `${base}（${detail}）` : base;
}

async function auditThreadPromptCacheBeforeSdkSession(input: {
  threadId: string;
  orchestrationKey: string;
  mainAgentModelKey: string;
  mcpServerKeys: readonly string[];
  workspacePath?: string;
  includeUserClaudeMd: boolean;
}): Promise<void> {
  if (!conversationStore.getThread(input.threadId)) {
    return;
  }
  const fingerprint = await resolveThreadPromptCacheFingerprint({
    orchestrationKey: input.orchestrationKey,
    mainAgentModelKey: input.mainAgentModelKey,
    mcpServerKeys: input.mcpServerKeys,
    ...(input.workspacePath ? { workspacePath: input.workspacePath } : {}),
    userHomeDir: os.homedir(),
    includeUserClaudeMd: input.includeUserClaudeMd,
    resolveClaudeMdDigest: resolveClaudeMdDigest,
  });
  const reasons = threadPromptCacheMonitor.observe(input.threadId, fingerprint);
  if (reasons.length === 0) {
    return;
  }
  const settings = getModelSettingsSnapshot();
  const thread = conversationStore.getThread(input.threadId);
  const orchestrationLabel =
    reasons.includes("orchestration_changed") && thread?.runtimeConfig
      ? resolvePromptCacheOrchestrationLabel(settings, thread.runtimeConfig)
      : undefined;
  process.stderr.write(
    `[eco] prompt cache invalidated thread=${input.threadId} reasons=${formatPromptCacheBreakLog(reasons)}\n`,
  );
  promptCacheRunEventEmitter.emitInvalidated(input.threadId, reasons, {
    ...(orchestrationLabel && { orchestrationLabel }),
  });
}

function recordThreadRunEventFromLiveEvent(input: {
  threadId: string;
  type: string;
  displayMessage: string;
  role: string;
  stream: boolean;
  extras?: EmitThreadEventExtras;
}): void {
  threadRunEventLivePersister.persistFromLiveEvent(
    definedProps({
      threadId: input.threadId,
      type: input.type,
      displayMessage: input.displayMessage,
      role: input.role,
      stream: input.stream,
      extras: input.extras as
        | import("./thread-run-event-live-persist").ThreadRunEventLivePersistExtras
        | undefined,
    }),
  );
}

function resolveAgentIdByParentToolUseId(threadId: string, parentToolUseId: string): string | undefined {
  const linked = subagentMetricsRegistry.resolveAgentIdByParentToolUse(threadId, parentToolUseId);
  if (linked) {
    return linked;
  }
  const agent = conversationStore
    .listAgentInstances(threadId)
    .find((row) => row.parentToolUseId?.trim() === parentToolUseId.trim());
  return agent?.agentId;
}

function readSdkEventParentToolUseId(event: AgentEventLike): string | undefined {
  const payload = event.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return undefined;
  }
  const parentToolUseId = (payload as { parent_tool_use_id?: unknown }).parent_tool_use_id;
  return typeof parentToolUseId === "string" && parentToolUseId.trim() ? parentToolUseId.trim() : undefined;
}

function readSdkEventLogicalRequestId(event: AgentEventLike): string | undefined {
  const payload = event.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return undefined;
  }
  const record = payload as Record<string, unknown>;
  const fromPayload = record.request_id ?? record.logicalRequestId;
  if (typeof fromPayload === "string" && fromPayload.trim()) {
    return fromPayload.trim();
  }
  return undefined;
}

/**
 * Exact late bind: SDK request_id (= Gateway logicalRequestId) + precise attribution.
 * Patches persisted started/terminal rows when agentId upgrades absent → known.
 */
function maybeLateBindLogicalRequestFromSdkEvent(
  threadId: string,
  event: AgentEventLike,
  options: {
    plannerSessionId?: string;
    metricsRegistry: SubagentMetricsRegistry;
  },
): void {
  const logicalRequestId = readSdkEventLogicalRequestId(event);
  if (!logicalRequestId) {
    return;
  }
  const attribution = resolveSdkLateBindAttribution(
    threadId,
    {
      type: event.type,
      role: String(event.role),
      ...(event.agentId ? { agentId: event.agentId } : {}),
      payload: event.payload,
    },
    {
      ...(options.plannerSessionId ? { plannerSessionId: options.plannerSessionId } : {}),
      metricsRegistry: options.metricsRegistry,
    },
  );
  if (!attribution) {
    return;
  }
  const lateBind = applyExactLogicalRequestLateBind(threadLiveRequestRegistry, conversationStore, {
    threadId,
    logicalRequestId,
    agentId: attribution.agentId,
    role: attribution.role,
  });
  if (!lateBind.ok) {
    if (
      lateBind.reason === "role_conflict" ||
      lateBind.reason === "agent_conflict" ||
      lateBind.reason === "db_conflict"
    ) {
      logEcoDiag("logical.late_bind_conflict", {
        threadId,
        logicalRequestId,
        agentId: attribution.agentId.slice(-12),
        reason: lateBind.reason,
        eventType: event.type,
      });
    }
    return;
  }
  if (lateBind.emitTimelineActivity && lateBind.updated > 0) {
    scheduleThreadRunProjectionUpdated(threadId);
  }
}

function readStreamAttributedAgentId(
  agentId: string | undefined,
  plannerSessionId: string | undefined,
): string | undefined {
  const trimmed = agentId?.trim();
  if (!trimmed || trimmed === "unknown-session" || trimmed === plannerSessionId) {
    return undefined;
  }
  return trimmed;
}

function resolveCurrentRunAttemptId(threadId: string): string | undefined {
  try {
    return agentLifecycle.currentRunAttemptId(threadId) ?? agentLifecycle.usageRunAttemptId(threadId);
  } catch {
    return undefined;
  }
}

function resolveThreadFollowUpEnqueueMetadata(threadId: string): {
  sourceRunAttemptId?: string;
  queuedDuringPhase?: ThreadFollowUpRunPhase;
} {
  const sourceRunAttemptId = resolveCurrentRunAttemptId(threadId);
  const phase = sourceRunAttemptId ? resolveRunAttemptPhase(threadId, sourceRunAttemptId) : undefined;
  return {
    ...(sourceRunAttemptId ? { sourceRunAttemptId } : {}),
    ...(phase ? { queuedDuringPhase: phase } : {}),
  };
}

function normalizeThreadFollowUpRunPhase(value: unknown): ThreadFollowUpRunPhase | undefined {
  if (value === "question") {
    return "ask";
  }
  if (value === "planning" || value === "execution" || value === "ask" || value === "continuation") {
    return value;
  }
  return undefined;
}

function resolveRunAttemptPhase(threadId: string, attemptId: string): ThreadFollowUpRunPhase | undefined {
  const phase = conversationStore
    .listRunAttempts(threadId)
    .find((attempt) => attempt.attemptId === attemptId)?.phase;
  return normalizeThreadFollowUpRunPhase(phase);
}

function isThreadFollowUpRunPhase(value: unknown): value is ThreadFollowUpRunPhase {
  return normalizeThreadFollowUpRunPhase(value) !== undefined;
}

function scheduleThreadRunProjectionUpdated(threadId: string, options?: { streaming?: boolean }): void {
  // V2 effects are published by the durable conversation writer. The renderer
  // folds those effects into its V2 state; no legacy projection or skeleton is
  // rebuilt on the production runtime path.
  void threadId;
  void options;
}

interface RecordedUserPromptResult {
  line?: ThreadActivityLine;
  storedAttachments?: PromptImageAttachment[];
}

async function recordUserPrompt(
  threadId: string,
  prompt: string,
  attachments?: readonly PromptImageAttachment[],
  v2AcceptedMessageIds?: readonly string[],
  options?: { finalizeAcceptedMessages?: boolean },
): Promise<RecordedUserPromptResult> {
  const resolvedForPreview = attachments?.length
    ? await loadPromptAttachmentsForRuntime(attachments)
    : undefined;
  const previewsByAttachment = createPromptImagePreviews(resolvedForPreview ?? []);
  const previews = previewsByAttachment.filter(
    (preview): preview is PromptImagePreview => preview !== undefined,
  );
  const thread = conversationStore.getThread(threadId);
  // Codex binds SDK item ids later; a local id here would desync conversation rewind mapping.
  const localActivityLineId = thread?.coreKind === "codex" ? undefined : `user:${randomUUID()}`;
  const codexPendingActivityLineId =
    !localActivityLineId && thread?.coreKind === "codex" ? `codex-pending:${randomUUID()}` : undefined;
  const acceptedIds = [...new Set(v2AcceptedMessageIds?.map((id) => id.trim()).filter(Boolean) ?? [])];
  const precomputedV2MessageId =
    acceptedIds.length === 1
      ? acceptedIds[0]
      : acceptedIds.length === 0 && (localActivityLineId || codexPendingActivityLineId)
        ? `message_user_${stableHash(
            `desktop:user:${threadId}:${localActivityLineId ?? codexPendingActivityLineId}`,
          )}`
        : undefined;
  const activityLineId = localActivityLineId ?? codexPendingActivityLineId;
  // Materialize the full image before writing the V2 message. The event keeps only
  // a content reference plus a bounded preview; the managed path remains a local
  // runtime detail and is never published to the V2/mobile read model.
  const storedAttachments =
    activityLineId && attachments?.length
      ? await promptImageFileStore.persistMessageAttachments(threadId, activityLineId, attachments)
      : undefined;
  const durableAttachments = storedAttachments?.length
    ? storedAttachments.map((attachment, index) => ({
        mediaType: attachment.mediaType,
        ...(attachment.contentRef ? { contentRef: attachment.contentRef } : {}),
        ...(attachment.byteLength !== undefined ? { byteLength: attachment.byteLength } : {}),
        ...(previewsByAttachment[index]?.data ? { data: previewsByAttachment[index].data } : {}),
      }))
    : [];
  // Create (and, unless deferred, finalize) the V2 message before the provider input
  // receipt is appended in the normal continuation path. The receipt intentionally
  // references the message identity, so both rows must exist in the same logical write
  // sequence instead of asking the reducer to resolve a future row. Mid-turn delivery
  // defers finalization until the provider push has been confirmed.
  if (activityLineId) {
    const v2MessageId =
      precomputedV2MessageId ??
      (acceptedIds.length === 0
        ? `message_user_${stableHash(`desktop:user:${threadId}:${activityLineId}`)}`
        : undefined);
    const v2 = conversationStore.conversationV2();
    if (acceptedIds.length > 0) {
      for (const messageId of acceptedIds) {
        const existing = v2.getMessage(threadId, messageId);
        if (
          !existing ||
          existing.status === "final" ||
          existing.status === "failed" ||
          existing.status === "cancelled"
        ) {
          continue;
        }
        if (options?.finalizeAcceptedMessages !== false) {
          const v2Key = `desktop:user:accepted:${threadId}:${messageId}:${activityLineId}`;
          v2.appendRuntime({
            conversationId: threadId,
            eventId: `desktop_v2_user_finalize_${stableHash(v2Key)}`,
            sourceEventKey: v2Key,
            type: "message.finalized",
            occurredAt: new Date().toISOString(),
            messageId,
            payload: {
              status: "final",
              // Keep the durable content reference and a small mobile preview. Never
              // persist the desktop-only managed path in the V2 event.
              ...(durableAttachments.length ? { attachments: durableAttachments } : {}),
            },
          });
        }
        // Accepted messages are created before the runtime knows the final
        // activity-line identity. Bind that identity as a separate immutable
        // V2 event once the line exists; retry/edit gates must not read the
        // retired thread_user_messages table to recover it.
        const finalizedMessage = v2.getMessage(threadId, messageId);
        // Codex receives its provider item id after the local prompt is durable.
        // The `codex-pending:*` activity id is only a temporary attachment/preview
        // identity; writing it as a V2 history target would make the later SDK bind
        // look like an illegal immutable-target rewrite.
        if (thread?.coreKind !== "codex" && !finalizedMessage?.historyTarget) {
          const historyTargetKey = `desktop:user:history-target:${threadId}:${messageId}:${activityLineId}`;
          v2.appendRuntime({
            conversationId: threadId,
            eventId: `desktop_v2_user_history_target_${stableHash(historyTargetKey)}`,
            sourceEventKey: historyTargetKey,
            type: "message.history_targeted",
            occurredAt: new Date().toISOString(),
            messageId,
            payload: { historyTarget: { activityLineId } },
          });
        }
      }
    } else {
      const v2Key = `desktop:user:${threadId}:${activityLineId}`;
      const messageId = v2MessageId ?? `message_user_${stableHash(v2Key)}`;
      v2.appendRuntime({
        conversationId: threadId,
        eventId: `desktop_v2_user_${stableHash(v2Key)}`,
        sourceEventKey: v2Key,
        type: "message.created",
        occurredAt: new Date().toISOString(),
        turnId: `turn_user_${stableHash(v2Key)}`,
        messageId,
        payload: {
          role: "user",
          channel: "answer",
          body: prompt,
          status: "final",
          ...(thread?.coreKind === "codex" ? {} : { historyTarget: { activityLineId } }),
          ...(durableAttachments.length ? { attachments: durableAttachments } : {}),
        },
      });
    }
  }
  const line = emitThreadEvent(threadId, "thread.user_prompt", prompt, "user", false, {
    ...((previews.length > 0 || localActivityLineId || precomputedV2MessageId) && {
      metadata: {
        ...(previews.length > 0 && {
          [PROMPT_IMAGE_PREVIEWS_METADATA_KEY]: previews,
        }),
        ...(localActivityLineId && {
          rewindTarget: { activityLineId: localActivityLineId },
        }),
        ...(codexPendingActivityLineId && {
          // Keep the provisional id in the source envelope so the pending prompt
          // remains discoverable until the Codex item bind supplies the canonical id.
          rewindTarget: { activityLineId: codexPendingActivityLineId },
        }),
        ...(precomputedV2MessageId && {
          conversationV2MessageId: precomputedV2MessageId,
        }),
      },
    }),
  });
  const resolvedLine =
    line ??
    (localActivityLineId
      ? {
          id: localActivityLineId,
          role: "user" as const,
          message: prompt,
          rewindTarget: { activityLineId: localActivityLineId },
        }
      : undefined);
  return {
    ...(resolvedLine ? { line: resolvedLine } : {}),
    ...(storedAttachments?.length ? { storedAttachments } : {}),
  };
}

/** Finalize only after dispatch preparation or a mid-turn provider push succeeds. */
function finalizeAcceptedV2Messages(
  threadId: string,
  messageIds: readonly string[],
  signal?: AbortSignal,
): Promise<void> {
  return finalizeAcceptedConversationV2Messages({
    store: conversationStore.conversationV2(),
    conversationId: threadId,
    messageIds,
    resolveAttachments: (attachments) => promptImageFileStore.resolveAttachmentsForRuntime(attachments),
    createPreviews: createPromptImagePreviews,
    ...(signal ? { signal } : {}),
  });
}

function failAcceptedV2Messages(threadId: string, messageIds: readonly string[], reason: string): void {
  const v2 = conversationStore.conversationV2();
  for (const rawMessageId of messageIds) {
    const messageId = rawMessageId.trim();
    if (!messageId) continue;
    const existing = v2.getMessage(threadId, messageId);
    if (
      !existing ||
      existing.status === "final" ||
      existing.status === "failed" ||
      existing.status === "cancelled"
    ) {
      continue;
    }
    const v2Key = `desktop:user:accepted-mid-turn-failed:${threadId}:${messageId}`;
    v2.appendRuntime({
      conversationId: threadId,
      eventId: `desktop_v2_user_failed_mid_turn_${stableHash(v2Key)}`,
      sourceEventKey: v2Key,
      type: "message.finalized",
      occurredAt: new Date().toISOString(),
      messageId,
      payload: { status: "failed", reason },
    });
  }
}

function createPromptImagePreviews(
  attachments: readonly PromptImageAttachment[],
): Array<PromptImagePreview | undefined> {
  const previews: Array<PromptImagePreview | undefined> = [];
  for (const attachment of attachments) {
    const data = attachment.data?.trim();
    if (!data) {
      previews.push(undefined);
      continue;
    }
    const image = nativeImage.createFromBuffer(Buffer.from(data, "base64"));
    if (image.isEmpty()) {
      process.stderr.write("[eco] unable to decode a prompt image preview\n");
      previews.push(undefined);
      continue;
    }
    const size = image.getSize();
    const longestEdge = Math.max(size.width, size.height);
    const scale = longestEdge > 512 ? 512 / longestEdge : 1;
    const preview =
      scale < 1
        ? image.resize({
            width: Math.max(1, Math.round(size.width * scale)),
            height: Math.max(1, Math.round(size.height * scale)),
            quality: "good",
          })
        : image;
    const bytes = preview.toJPEG(80);
    if (bytes.length === 0) {
      process.stderr.write("[eco] unable to encode a prompt image preview\n");
      previews.push(undefined);
      continue;
    }
    previews.push({
      id: `prompt_image_${randomUUID()}`,
      mediaType: "image/jpeg",
      data: bytes.toString("base64"),
    });
  }
  return previews;
}

function createThreadImageViewHost(runAttemptId?: string): ImageViewHost {
  return {
    resolveRoute(threadId, routesOverride) {
      const thread = conversationStore.getThread(threadId);
      const visionSelection = thread
        ? ensureThreadRuntimeConfig(thread).runtimeConfig?.visionModel
        : undefined;
      return resolveThreadVisionAnalysisRoute({
        ...(thread?.coreKind ? { coreKind: thread.coreKind } : {}),
        visionSelection,
        providerStore,
        resolveEcoFallback: () => {
          const runtime = resolveRuntimeConfigForThreadId(threadId, routesOverride);
          if (!runtime.ok) {
            throw new Error(runtime.reason);
          }
          const sourceRoute = runtime.routes.find((route) => route.role === "main") ?? runtime.routes[0];
          if (!sourceRoute) {
            throw new Error("image_view 缺少可用的模型路由。");
          }
          return sourceRoute;
        },
      });
    },
    async startProxy(route, attachments, stamp) {
      const proxy = await startRuntimeProxy([route], [...attachments], {
        threadId: stamp.threadId,
        ...(stamp.runAttemptId ? { runAttemptId: stamp.runAttemptId } : {}),
      });
      const alias = proxy.routes[0];
      if (!alias) {
        throw new Error("image_view 没有生成可调用的模型别名。");
      }
      return {
        baseUrl: proxy.baseUrl,
        apiKey: proxy.apiKey,
        aliasModelId: alias.aliasModelId,
        close: () => proxy.close(),
      };
    },
    registerBilling(threadId, agentId) {
      proxyBillingStampRegistry.register(threadId, {
        agentId,
        role: BUILTIN_VISION_AGENT_ROLE,
        ...(runAttemptId && { runAttemptId }),
      });
    },
    unregisterBilling(threadId, agentId) {
      proxyBillingStampRegistry.unregister(threadId, agentId);
    },
  };
}

async function resolvePromptImagesForMainContext(input: {
  threadId: string;
  prompt: string;
  attachments?: readonly PromptImageAttachment[];
  routesOverride?: readonly RuntimeRoleRouteConfig[];
  signal?: AbortSignal;
}): Promise<string> {
  imageViewGateway.noteThreadPrompt(input.threadId, input.prompt);
  return buildPromptWithImageReferences({
    prompt: await composerReferenceService.resolvePrompt(input.threadId, input.prompt),
    ...(input.attachments ? { attachments: input.attachments } : {}),
  });
}

async function handleThreadAskUserQuestion(
  threadId: string,
  parsed: SdkAskUserQuestionRequest & { toolUseId: string },
): Promise<Record<string, unknown>> {
  patchThreadSummary(threadId, { status: "running", message: "" });
  const clarificationRequest: ThreadLiveEvent["clarification"] = {
    toolUseId: parsed.toolUseId,
    threadId,
    questions: parsed.questions,
  };
  const answersPromise = registerPendingClarification(threadId, parsed.toolUseId, parsed);
  emitThreadEvent(threadId, "clarification.requested", "主代理需要你回答几个问题。", "main", false, {
    clarification: clarificationRequest,
    tool: buildClarificationToolMetadata(parsed.toolUseId, "started"),
  });
  const answers = await answersPromise;
  patchThreadSummary(threadId, { status: "running", message: "" });
  emitThreadEvent(
    threadId,
    "clarification.answered",
    formatClarificationAnswersSummary(
      { toolUseId: parsed.toolUseId, threadId, questions: parsed.questions },
      answers,
    ),
    "main",
    false,
    {
      tool: buildClarificationToolMetadata(parsed.toolUseId, "completed"),
    },
  );
  void retryDeferredRunCleanupIfNeeded(threadId);
  return buildAskUserQuestionUpdatedInput(
    { toolUseId: parsed.toolUseId, threadId, questions: parsed.questions },
    answers,
    parsed.rawInput,
  );
}

function createThreadHookContext(threadId: string): EcoHookContext {
  return {
    awaitPlanApproval: async (request) => {
      const existingWait = getPendingPlanApprovalWaitForThread(threadId);
      if (existingWait && getPendingPlanApprovalByToolUseId(request.toolUseId)) {
        return existingWait;
      }
      const thread = conversationStore.getThread(threadId);
      if (!thread) {
        throw new Error("Thread was not found.");
      }
      const worktreePlan = activeRunRuntimeState.worktreePlan(threadId);
      const worktreePath = worktreePlan?.worktreePath ?? thread.workspacePath;
      const roleRoutes = resolveRoleRoutesForThread(threadId);
      const analysis = [
        "Plan submitted for Eco approval.",
        request.planFilePath ? `Plan file: ${request.planFilePath}` : "",
      ]
        .filter(Boolean)
        .join("\n");
      const planPayload = {
        userPrompt: thread.prompt,
        analysis,
        plan: request.plan,
        ...(request.planFilePath ? { planFilePath: request.planFilePath } : {}),
      };
      const approvalRequest: PlanApprovalRequest = {
        toolUseId: request.toolUseId,
        threadId,
        ...planPayload,
      };
      // Park the bridge before any UI emit so approve cannot race an empty map.
      const decisionPromise = registerPendingPlanApproval(threadId, approvalRequest);
      applyThreadPlanReadyEffects({
        threadId,
        payload: planPayload,
        workspacePath: thread.workspacePath,
        worktreePath,
        routesJson: JSON.stringify(roleRoutes),
        awaitingPlanMessage: "",
        effects: {
          savePendingPlan: (plan) => {
            conversationStore.savePendingPlan(plan);
          },
          emitAwaitingPlan: () => {
            // Bridge path keeps the thread running until the user approves.
          },
        },
      });
      updateThread(threadId, { status: "awaiting_plan", message: "" });
      emitThreadEvent(threadId, "plan_approval.requested", "计划已提交，等待你确认。", "main", false, {
        plan: planPayload,
        planApproval: approvalRequest,
      });
      const decision = await decisionPromise;
      const command = getPendingPlanApprovalCommand(request.toolUseId);
      if (!command) {
        throw new Error("Plan approval command binding was lost before SDK continuation acknowledgement.");
      }
      try {
        conversationStore
          .conversationV2()
          .recordCommandCheckpoint(
            command.principalId,
            threadId,
            command.clientCommandId,
            "plan.bridge_continuation_resumed",
            {
              toolUseId: request.toolUseId,
              decision,
            },
          );
        if (!acknowledgePlanApprovalContinuation(request.toolUseId)) {
          throw new Error("Plan approval continuation acknowledgement was not pending.");
        }
      } catch (error) {
        rejectPlanApprovalContinuation(
          request.toolUseId,
          error instanceof Error ? error : new Error(errorMessage(error)),
        );
        throw error;
      }
      if (decision === "approved") {
        emitThreadEvent(threadId, "plan_approval.approved", "已批准计划。", "user", false, {
          planApproval: approvalRequest,
        });
        void retryDeferredRunCleanupIfNeeded(threadId);
        return "approved";
      }
      emitThreadEvent(threadId, "plan_approval.denied", "计划忽略", "user", false, {
        planApproval: approvalRequest,
      });
      void retryDeferredRunCleanupIfNeeded(threadId);
      return "denied";
    },
    resolveChangedFiles: async () => {
      const worktreePlan = activeRunRuntimeState.worktreePlan(threadId);
      if (!worktreePlan) {
        return [];
      }
      try {
        return await gitWorktrees.changedFiles(worktreePlan);
      } catch (error) {
        console.error("Failed to list worktree files for reviewer scope:", error);
        return [];
      }
    },
    onNotification: ({ message, notificationType }) => {
      if (notificationType === "permission_prompt") {
        updateThread(threadId, { status: "running", message: "" });
        return;
      }
      if (notificationType === "idle_prompt") {
        updateThread(threadId, { status: "running", message: "" });
      }
    },
  };
}

function resolveBashApprovalPhase(liveType: string): ThreadRunBashApprovalPhase | undefined {
  if (liveType === "bash_approval.requested") {
    return "requested";
  }
  if (liveType === "bash_approval.approved") {
    return "approved";
  }
  if (liveType === "bash_approval.rejected") {
    return "rejected";
  }
  if (liveType === "bash_approval.denied") {
    return "denied";
  }
  return undefined;
}

function buildBashApprovalRunMetadataFromRequest(
  liveType: string,
  request: BashApprovalRequest,
): ThreadRunBashApprovalMetadata | undefined {
  const phase = resolveBashApprovalPhase(liveType);
  if (!phase) {
    return undefined;
  }
  const toolName = request.filesystemTool ?? "Bash";
  const detail = request.filesystemPath ?? request.command;
  return {
    toolUseId: request.toolUseId,
    phase,
    toolName,
    ...(detail.trim() && { detail: detail.trim() }),
    ...(request.description?.trim() && {
      description: request.description.trim(),
    }),
  };
}

function toolMetadataFromBashApprovalRequest(
  request: BashApprovalRequest,
  liveType: string,
): ThreadRunToolMetadata {
  const toolName = request.filesystemTool ?? "Bash";
  const detail = request.filesystemPath ?? request.command;
  const phase = resolveBashApprovalPhase(liveType);
  const status: ThreadRunToolMetadata["status"] =
    phase === "rejected" || phase === "denied" ? "failed" : "started";
  return {
    name: toolName,
    detail: detail.trim() || request.command,
    toolUseId: request.toolUseId,
    ...(request.description?.trim() && {
      description: request.description.trim(),
    }),
    status,
  };
}

function bashApprovalEventExtras(request: BashApprovalRequest, liveType: string): EmitThreadEventExtras {
  return {
    bashApproval: request,
    tool: toolMetadataFromBashApprovalRequest(request, liveType),
    agentId: request.agentId.trim(),
  };
}

function resolveThreadBashApprovalAgentId(
  threadId: string,
  request: Pick<SdkToolPermissionRequest, "agentId" | "agentType">,
): string | undefined {
  return resolveBashApprovalAgentId(threadId, request, {
    plannerAgentId: agentLifecycle.usagePlannerAgentId(threadId),
    roleForAgentId: (tid, agentId) => subagentMetricsRegistry.roleForAgentId(tid, agentId),
    resolveSubagentId: (tid, input) => subagentMetricsRegistry.resolveAgentId(tid, input),
  });
}

function createThreadToolPermissionHandler(
  threadId: string,
  runPhase: SubagentRunPhase = "execution",
  skipExecutionApprovals = false,
): (request: SdkToolPermissionRequest) => Promise<SdkToolPermissionDecision> {
  const browserOpenHandler = createBrowserOpenToolPermissionHandler(threadId);
  const computerUseHandler = createComputerUseToolPermissionHandler(threadId);
  const imageGenerationHandler = createImageGenerationToolPermissionHandler(threadId);
  const webSearchHandler = createWebSearchToolPermissionHandler(threadId);
  if (skipExecutionApprovals) {
    return trackSdkHintApproval(
      composeCanUseToolHandlers(
        createAskUserQuestionHandler((parsed) => handleThreadAskUserQuestion(threadId, parsed)),
        createMcpHubNestedToolPermissionHandler([
          imageGenerationHandler,
          computerUseHandler,
          browserOpenHandler,
          webSearchHandler,
        ]),
        imageGenerationHandler,
        computerUseHandler,
        browserOpenHandler,
        webSearchHandler,
      ),
    );
  }
  const bashAndFilesystemHandler = createThreadBashAndFilesystemToolPermissionHandler(threadId, runPhase);
  return trackSdkHintApproval(
    composeCanUseToolHandlers(
      createAskUserQuestionHandler((parsed) => handleThreadAskUserQuestion(threadId, parsed)),
      createMcpHubNestedToolPermissionHandler([
        imageGenerationHandler,
        computerUseHandler,
        browserOpenHandler,
        webSearchHandler,
        bashAndFilesystemHandler,
      ]),
      imageGenerationHandler,
      computerUseHandler,
      browserOpenHandler,
      webSearchHandler,
      bashAndFilesystemHandler,
    ),
  );
}

function createWebSearchToolPermissionHandler(
  threadId: string,
): (request: SdkToolPermissionRequest) => Promise<SdkToolPermissionDecision> {
  return async (request) => {
    if (!isWebSearchApprovalToolName(request.toolName)) {
      return { behavior: "allow", updatedInput: request.input };
    }
    const mode = integratedWebSearchSettingsStore.get().approvalMode;
    if (mode !== "always_ask") {
      return { behavior: "allow", updatedInput: request.input };
    }

    const query = typeof request.input.query === "string" ? request.input.query.trim() : "";
    const thread = conversationStore.getThread(threadId);
    if (!thread) {
      return {
        behavior: "deny",
        message: "Thread was not found; Eco could not request web search approval.",
        interrupt: true,
      };
    }
    const approvalAgentId = resolveThreadBashApprovalAgentId(threadId, request);
    if (!approvalAgentId) {
      return {
        behavior: "deny",
        message: "Eco could not attribute this web search approval to an agent instance.",
        interrupt: false,
      };
    }

    const cwd = request.cwd?.trim() || thread.sdkCwd || thread.workspacePath || ".";
    const approvalRequest: BashApprovalRequest = {
      toolUseId: request.toolUseId,
      ...sdkPermissionApprovalHints(request),
      threadId,
      command: query ? `search ${query}` : request.toolName,
      cwd,
      reason: query ? `Agent 请求执行网络搜索：${query.slice(0, 500)}` : "Agent 请求执行网络搜索。",
      riskScore: 35,
      riskLevel: "low",
      agentId: approvalAgentId,
      ...(request.agentType ? { agentType: request.agentType } : {}),
      description: query
        ? `Web search: ${query.length > 80 ? `${query.slice(0, 77)}…` : query}`
        : "Web search",
      kind: "network",
    };

    emitThreadEvent(
      threadId,
      "bash_approval.requested",
      query ? `等待确认网络搜索：${query.slice(0, 80)}` : "等待确认网络搜索",
      "tool",
      false,
      bashApprovalEventExtras(approvalRequest, "bash_approval.requested"),
    );
    const resolution = await registerSdkHintApproval(threadId, approvalRequest);
    if (isBashApprovalGranted(resolution)) {
      emitThreadEvent(
        threadId,
        "bash_approval.approved",
        query ? `已允许网络搜索：${query.slice(0, 80)}` : "已允许网络搜索",
        "tool",
        false,
        bashApprovalEventExtras(approvalRequest, "bash_approval.approved"),
      );
      return { behavior: "allow", updatedInput: request.input };
    }
    emitThreadEvent(
      threadId,
      "bash_approval.rejected",
      query ? `已拒绝网络搜索：${query.slice(0, 80)}` : "已拒绝网络搜索",
      "tool",
      false,
      bashApprovalEventExtras(approvalRequest, "bash_approval.rejected"),
    );
    return {
      behavior: "deny",
      message: resolution.feedback?.trim() || "User rejected this web search request.",
      interrupt: false,
    };
  };
}

function createImageGenerationToolPermissionHandler(
  threadId: string,
): (request: SdkToolPermissionRequest) => Promise<SdkToolPermissionDecision> {
  return async (request) => {
    if (!isEcoImageGenerationToolName(request.toolName)) {
      return { behavior: "allow", updatedInput: request.input };
    }
    const thread = conversationStore.getThread(threadId);
    if (!thread) {
      return {
        behavior: "deny",
        message: "Thread was not found; Eco could not request image approval.",
        interrupt: true,
      };
    }
    const approvalAgentId = resolveThreadBashApprovalAgentId(threadId, request);
    if (!approvalAgentId) {
      return {
        behavior: "deny",
        message: "Eco could not attribute this image approval to an agent instance.",
        interrupt: false,
      };
    }
    const prompt = typeof request.input.prompt === "string" ? request.input.prompt.trim() : "";
    const count = typeof request.input.count === "number" ? request.input.count : 1;
    const config = imageGenerationStore.getActiveClientConfig();
    const approvalRequest: BashApprovalRequest = {
      toolUseId: request.toolUseId,
      ...sdkPermissionApprovalHints(request),
      threadId,
      command: `create_image count=${count}${request.input.size ? ` size=${String(request.input.size)}` : ""}`,
      cwd:
        request.cwd?.trim() ||
        activeRunRuntimeState.worktreePlan(threadId)?.worktreePath ||
        thread.sdkCwd ||
        thread.workspacePath,
      reason: prompt ? `Agent 请求生成图片：${prompt.slice(0, 500)}` : "Agent 请求生成图片。",
      riskScore: 55,
      riskLevel: "medium",
      agentId: approvalAgentId,
      ...(request.agentType ? { agentType: request.agentType } : {}),
      description: `${config.profileName} · ${config.model} · ${count} 张`,
      kind: "image_generation",
    };
    emitThreadEvent(
      threadId,
      "bash_approval.requested",
      "等待确认创意绘画请求",
      "tool",
      false,
      bashApprovalEventExtras(approvalRequest, "bash_approval.requested"),
    );
    const resolution = await registerSdkHintApproval(threadId, approvalRequest);
    if (resolution.decision === "approved") {
      emitThreadEvent(
        threadId,
        "bash_approval.approved",
        "已允许本次创意绘画",
        "tool",
        false,
        bashApprovalEventExtras(approvalRequest, "bash_approval.approved"),
      );
      return { behavior: "allow", updatedInput: request.input };
    }
    emitThreadEvent(
      threadId,
      "bash_approval.rejected",
      "已拒绝本次创意绘画",
      "tool",
      false,
      bashApprovalEventExtras(approvalRequest, "bash_approval.rejected"),
    );
    return {
      behavior: "deny",
      message: resolution.feedback?.trim() || "User rejected this image generation request.",
      interrupt: false,
    };
  };
}

function createComputerUseToolPermissionHandler(
  threadId: string,
): (request: SdkToolPermissionRequest) => Promise<SdkToolPermissionDecision> {
  return async (request) => {
    const needsGate = requiresComputerUseActionApproval(request.toolName);
    const mode = computerUseSettingsStore.get().actionApprovalMode;
    if (!needsGate) {
      return { behavior: "allow", updatedInput: request.input };
    }
    if (mode !== "always_ask") {
      return { behavior: "allow", updatedInput: request.input };
    }

    const thread = conversationStore.getThread(threadId);
    if (!thread) {
      return {
        behavior: "deny",
        message: "Thread was not found; Eco could not request Computer Use approval.",
        interrupt: true,
      };
    }
    const approvalAgentId = resolveThreadBashApprovalAgentId(threadId, request);
    if (!approvalAgentId) {
      return {
        behavior: "deny",
        message: "Eco could not attribute this Computer Use approval to an agent instance.",
        interrupt: false,
      };
    }

    const cwd = request.cwd?.trim() || thread.sdkCwd || thread.workspacePath || ".";
    const approvalRequest: BashApprovalRequest = {
      toolUseId: request.toolUseId,
      ...sdkPermissionApprovalHints(request),
      threadId,
      command: request.toolName,
      cwd,
      reason: "Agent 请求执行电脑操控动作（点击 / 输入等）。",
      riskScore: 55,
      riskLevel: "medium",
      agentId: approvalAgentId,
      ...(request.agentType ? { agentType: request.agentType } : {}),
      description: "Computer Use action",
    };

    emitThreadEvent(
      threadId,
      "bash_approval.requested",
      "等待确认电脑操控动作",
      "tool",
      false,
      bashApprovalEventExtras(approvalRequest, "bash_approval.requested"),
    );
    const resolution = await registerSdkHintApproval(threadId, approvalRequest);
    if (isBashApprovalGranted(resolution)) {
      emitThreadEvent(
        threadId,
        "bash_approval.approved",
        "已允许本次电脑操控",
        "tool",
        false,
        bashApprovalEventExtras(approvalRequest, "bash_approval.approved"),
      );
      return { behavior: "allow", updatedInput: request.input };
    }
    emitThreadEvent(
      threadId,
      "bash_approval.rejected",
      "已拒绝本次电脑操控",
      "tool",
      false,
      bashApprovalEventExtras(approvalRequest, "bash_approval.rejected"),
    );
    return {
      behavior: "deny",
      message: resolution.feedback?.trim() || "User rejected this Computer Use action.",
      interrupt: false,
    };
  };
}

function createBrowserOpenToolPermissionHandler(
  threadId: string,
): (request: SdkToolPermissionRequest) => Promise<SdkToolPermissionDecision> {
  return async (request) => {
    const needsOpenGate = requiresBrowserOpenApproval(request.toolName);
    const mode = browserSettingsStore.get().openApprovalMode;
    if (!needsOpenGate) {
      return { behavior: "allow", updatedInput: request.input };
    }
    if (mode !== "always_ask") {
      return { behavior: "allow", updatedInput: request.input };
    }

    const url =
      extractUrlFromBrowserOpenToolPayload(request.input) ??
      extractUrlFromBrowserOpenToolPayload({ input: request.input });
    const command = url ? `open ${url}` : request.toolName;
    const thread = conversationStore.getThread(threadId);
    if (!thread) {
      return {
        behavior: "deny",
        message: "Thread was not found; Eco could not request browser open approval.",
        interrupt: true,
      };
    }
    const approvalAgentId = resolveThreadBashApprovalAgentId(threadId, request);
    if (!approvalAgentId) {
      return {
        behavior: "deny",
        message: "Eco could not attribute this browser open approval to an agent instance.",
        interrupt: false,
      };
    }

    const cwd = request.cwd?.trim() || thread.sdkCwd || thread.workspacePath || ".";
    const approvalRequest: BashApprovalRequest = {
      toolUseId: request.toolUseId,
      ...sdkPermissionApprovalHints(request),
      threadId,
      command,
      cwd,
      reason: url
        ? `Agent wants to open ${url} in the built-in browser.`
        : "Agent wants to open a website in the built-in browser.",
      riskScore: 35,
      riskLevel: "low",
      agentId: approvalAgentId,
      ...(request.agentType ? { agentType: request.agentType } : {}),
      description: url ? `Open ${url}` : "Open website",
    };

    emitThreadEvent(
      threadId,
      "bash_approval.requested",
      url ? `等待确认打开浏览器：${url}` : "等待确认打开内置浏览器",
      "tool",
      false,
      bashApprovalEventExtras(approvalRequest, "bash_approval.requested"),
    );

    const resolution = await registerSdkHintApproval(threadId, approvalRequest);
    if (isBashApprovalGranted(resolution)) {
      emitThreadEvent(
        threadId,
        "bash_approval.approved",
        url ? `已允许打开浏览器：${url}` : "已允许打开内置浏览器",
        "tool",
        false,
        bashApprovalEventExtras(approvalRequest, "bash_approval.approved"),
      );
      return { behavior: "allow", updatedInput: request.input };
    }

    emitThreadEvent(
      threadId,
      "bash_approval.rejected",
      url ? `已拒绝打开浏览器：${url}` : "已拒绝打开内置浏览器",
      "tool",
      false,
      bashApprovalEventExtras(approvalRequest, "bash_approval.rejected"),
    );
    return {
      behavior: "deny",
      message: formatFilesystemApprovalDenyMessage(request.toolName, resolution.feedback),
      interrupt: false,
    };
  };
}

function sdkPermissionApprovalHints(request: SdkToolPermissionRequest) {
  return {
    ...(request.defaultToNo !== undefined && { defaultToNo: request.defaultToNo }),
    ...(request.suppressAlwaysAllowRule !== undefined && {
      suppressAlwaysAllowRule: request.suppressAlwaysAllowRule,
    }),
    ...(request.mcpServer && { mcpServer: request.mcpServer }),
  };
}
const sdkHintApprovalsHandled = new Set<string>();
function trackSdkHintApproval(
  handler: (request: SdkToolPermissionRequest) => Promise<SdkToolPermissionDecision>,
) {
  return async (request: SdkToolPermissionRequest): Promise<SdkToolPermissionDecision> => {
    try {
      return await handler(request);
    } finally {
      sdkHintApprovalsHandled.delete(request.toolUseId);
    }
  };
}
async function registerSdkHintApproval(
  threadId: string,
  request: BashApprovalRequest,
): Promise<BashApprovalResolution> {
  const resolution = await registerPendingBashApproval(threadId, request);
  if (request.defaultToNo || request.suppressAlwaysAllowRule) sdkHintApprovalsHandled.add(request.toolUseId);
  return resolution;
}
async function requestSdkHintApproval(
  threadId: string,
  request: SdkToolPermissionRequest,
): Promise<SdkToolPermissionDecision> {
  if (sdkHintApprovalsHandled.has(request.toolUseId))
    return { behavior: "allow", updatedInput: request.input };
  const mcpToolApproval = mcpStore.resolveToolApprovalTarget(request.toolName);
  if (!request.suppressAlwaysAllowRule && mcpToolApproval && mcpStore.isToolApproved(mcpToolApproval)) {
    sdkHintApprovalsHandled.add(request.toolUseId);
    return { behavior: "allow", updatedInput: request.input };
  }
  const thread = conversationStore.getThread(threadId);
  const agentId = resolveThreadBashApprovalAgentId(threadId, request);
  if (!thread || !agentId)
    return { behavior: "deny", message: "Eco could not attribute the SDK permission request." };
  let approval: BashApprovalRequest = {
    threadId,
    toolUseId: request.toolUseId,
    agentId,
    command: `${request.toolName} ${JSON.stringify(request.input)}`,
    cwd: request.cwd || thread.sdkCwd || thread.workspacePath || ".",
    reason: request.decisionReason || "Claude SDK requested permission review for this action.",
    riskScore: 50,
    riskLevel: "medium",
    filesystemTool: request.toolName,
    ...(mcpToolApproval
      ? {
          mcpToolApproval,
          kind: "mcp" as const,
          filesystemTool: "MCP",
          filesystemPath: `${mcpToolApproval.serverName}/mcp__${mcpToolApproval.serverName}__${mcpToolApproval.toolName}`,
        }
      : {}),
    ...sdkPermissionApprovalHints(request),
    ...(request.description && { description: request.description }),
  };
  return resolveSdkHintPermission({
    request,
    confirmationMode: ensureThreadRuntimeConfig(thread).runtimeConfig?.bashReviewMode ?? "always",
    review: () =>
      reviewThreadToolApproval(threadId, approval, {
        toolName: request.toolName,
        toolInput: request.input,
        sdkHints: sdkApprovalEvidenceHints(request),
      }),
    onReview: (review) => {
      approval = { ...approval, reviewRationale: review.rationale };
      if (review.action === "allow") {
        const type = "bash_approval.approved";
        emitThreadEvent(
          threadId,
          type,
          `审批模型已允许 ${request.toolName}：${review.rationale}`,
          "tool",
          false,
          bashApprovalEventExtras(approval, type),
        );
      }
    },
    requestHuman: async () => {
      emitThreadEvent(
        threadId,
        "bash_approval.requested",
        `等待确认 ${request.toolName}`,
        "tool",
        false,
        bashApprovalEventExtras(approval, "bash_approval.requested"),
      );
      const resolution = await registerSdkHintApproval(threadId, approval);
      return isBashApprovalGranted(resolution)
        ? { behavior: "allow", updatedInput: request.input }
        : { behavior: "deny", message: resolution.feedback || `User denied this ${request.toolName} call.` };
    },
  });
}

function sdkApprovalEvidenceHints(
  request: SdkToolPermissionRequest,
): NonNullable<ApprovalHostEvidence["sdkHints"]> {
  return {
    ...sdkPermissionApprovalHints(request),
    ...(request.decisionReason ? { decisionReason: request.decisionReason.slice(0, 800) } : {}),
  };
}

function createThreadBashAndFilesystemToolPermissionHandler(
  threadId: string,
  runPhase: SubagentRunPhase = "execution",
): (request: SdkToolPermissionRequest) => Promise<SdkToolPermissionDecision> {
  return async (request) => {
    if (isReadFilesystemTool(request.toolName) || isWriteFilesystemTool(request.toolName)) {
      const thread = conversationStore.getThread(threadId);
      if (!thread) {
        return {
          behavior: "deny",
          message: "Thread was not found; Eco could not request filesystem approval.",
          interrupt: true,
        };
      }

      const worktreePlan = activeRunRuntimeState.worktreePlan(threadId);
      const cwd = request.cwd?.trim() || worktreePlan?.worktreePath || thread.sdkCwd || thread.workspacePath;
      const runtimeConfig = ensureThreadRuntimeConfig(thread).runtimeConfig;
      const confirmationMode = runtimeConfig?.bashReviewMode ?? "always";
      const filesystemApproval = resolveFilesystemApprovalRequest({
        toolName: request.toolName,
        input: request.input,
        cwd: cwd ?? thread.workspacePath ?? ".",
        workspacePath: thread.workspacePath,
        confirmationMode,
        ...(request.decisionReason ? { fallbackReason: request.decisionReason } : {}),
      });
      if (!filesystemApproval) {
        return request.defaultToNo || request.suppressAlwaysAllowRule
          ? requestSdkHintApproval(threadId, request)
          : { behavior: "allow", updatedInput: request.input };
      }
      if (filesystemApproval.action === "deny") {
        return {
          behavior: "deny",
          message: filesystemApproval.reason,
          interrupt: false,
        };
      }
      const filesystemPath = filesystemApproval.filesystemPath;
      const approvalAgentId = resolveThreadBashApprovalAgentId(threadId, request);
      if (!approvalAgentId) {
        return {
          behavior: "deny",
          message: "Eco could not attribute this filesystem approval to an agent instance.",
          interrupt: false,
        };
      }

      let approvalRequest: BashApprovalRequest = {
        toolUseId: request.toolUseId,
        ...sdkPermissionApprovalHints(request),
        threadId,
        command: `${request.toolName} ${filesystemPath}`,
        cwd,
        reason: filesystemApproval.reason,
        riskScore: filesystemApproval.riskScore ?? 40,
        riskLevel: filesystemApproval.riskLevel ?? "medium",
        agentId: approvalAgentId,
        filesystemTool: request.toolName,
        filesystemPath,
        ...(request.agentType ? { agentType: request.agentType } : {}),
        description: filesystemApproval.userMessage,
      };

      if (confirmationMode === "auto") {
        const review = await reviewThreadToolApproval(threadId, approvalRequest, {
          toolName: request.toolName,
          toolInput: request.input,
          sdkHints: sdkApprovalEvidenceHints(request),
        });
        if (review.action === "allow") {
          const reviewedRequest = {
            ...approvalRequest,
            reviewRationale: review.rationale,
          };
          emitThreadEvent(
            threadId,
            "bash_approval.approved",
            `审批模型已允许 ${request.toolName}：${filesystemPath}`,
            "tool",
            false,
            bashApprovalEventExtras(reviewedRequest, "bash_approval.approved"),
          );
          return { behavior: "allow", updatedInput: request.input };
        }
        approvalRequest = {
          ...approvalRequest,
          reviewRationale: review.rationale,
        };
      }

      emitThreadEvent(
        threadId,
        "bash_approval.requested",
        `等待确认 ${request.toolName}：${filesystemPath}`,
        "tool",
        false,
        bashApprovalEventExtras(approvalRequest, "bash_approval.requested"),
      );

      const resolution = await registerSdkHintApproval(threadId, approvalRequest);
      if (isBashApprovalGranted(resolution)) {
        emitThreadEvent(
          threadId,
          "bash_approval.approved",
          `已允许本次 ${request.toolName}：${filesystemPath}`,
          "tool",
          false,
          bashApprovalEventExtras(approvalRequest, "bash_approval.approved"),
        );
        return { behavior: "allow", updatedInput: request.input };
      }

      emitThreadEvent(
        threadId,
        "bash_approval.rejected",
        `已拒绝 ${request.toolName}：${filesystemPath}`,
        "tool",
        false,
        bashApprovalEventExtras(approvalRequest, "bash_approval.rejected"),
      );
      return {
        behavior: "deny",
        message: formatFilesystemApprovalDenyMessage(request.toolName, resolution.feedback),
        interrupt: false,
      };
    }

    if (request.toolName !== "Bash") {
      return request.defaultToNo || request.suppressAlwaysAllowRule
        ? requestSdkHintApproval(threadId, request)
        : { behavior: "allow", updatedInput: request.input };
    }

    const command = readBashCommandInput(request.input);
    if (!command) {
      return {
        behavior: "deny",
        message: "Bash command is missing; Eco could not present it for approval.",
        interrupt: false,
      };
    }

    const thread = conversationStore.getThread(threadId);
    if (!thread) {
      return {
        behavior: "deny",
        message: "Thread was not found; Eco could not request Bash approval.",
        interrupt: true,
      };
    }

    const worktreePlan = activeRunRuntimeState.worktreePlan(threadId);
    const cwd = request.cwd?.trim() || worktreePlan?.worktreePath || thread.sdkCwd || thread.workspacePath;
    const runtimeConfig = ensureThreadRuntimeConfig(thread).runtimeConfig;
    const agentRegistry = resolveAgentRuntimeConfigForThread(thread);
    const bashReviewMode = runtimeConfig?.bashReviewMode ?? "always";
    const confirmation = evaluateThreadToolConfirmation({
      command,
      cwd,
      workspacePath: thread.workspacePath,
      confirmationMode: bashReviewMode,
      phaseAllowsExecution:
        runPhase !== "ask" && (runPhase !== "planning" || resolveSessionMode(runtimeConfig) === "agent"),
      sessionBashRememberPrefixes: activeRunRuntimeState.bashRememberPrefixes(threadId),
      ...(agentRegistry ? { agentRegistry } : {}),
      ...(request.agentId ? { agentId: request.agentId } : {}),
      ...(request.agentType ? { agentType: request.agentType } : {}),
    });
    if (confirmation.action === "deny") {
      const approvalAgentId = resolveThreadBashApprovalAgentId(threadId, request);
      if (!approvalAgentId) {
        return {
          behavior: "deny",
          message: "Eco could not attribute this Bash denial to an agent instance.",
          interrupt: false,
        };
      }
      const deniedApproval: BashApprovalRequest = {
        toolUseId: request.toolUseId,
        ...sdkPermissionApprovalHints(request),
        threadId,
        command,
        cwd: cwd ?? thread.workspacePath ?? ".",
        reason: confirmation.reason,
        riskScore: confirmation.riskScore ?? 100,
        riskLevel: confirmation.riskLevel ?? "critical",
        agentId: approvalAgentId,
        ...(request.agentType ? { agentType: request.agentType } : {}),
      };
      emitThreadEvent(
        threadId,
        "bash_approval.denied",
        `已拒绝：${confirmation.userMessage}`,
        "tool",
        false,
        {
          ...bashApprovalEventExtras(deniedApproval, "bash_approval.denied"),
        },
      );
      return {
        behavior: "deny",
        message: confirmation.reason,
        interrupt: false,
      };
    }
    if (
      confirmation.action === "allow" &&
      (bashReviewMode !== "auto" || confirmation.matchedRule === "session_bash_prefix") &&
      !request.defaultToNo &&
      !request.suppressAlwaysAllowRule
    ) {
      const description = readBashDescriptionInput(request.input);
      emitThreadEvent(threadId, "tool.started", `Tool: Bash · ${description ?? command}`, "tool", false, {
        ...(request.agentId ? { agentId: request.agentId } : {}),
        tool: {
          name: "Bash",
          detail: command,
          toolUseId: request.toolUseId,
          ...(description ? { description } : {}),
          status: "started",
        },
      });
      return { behavior: "allow", updatedInput: request.input };
    }

    const description = readBashDescriptionInput(request.input);
    const approvalAgentId = resolveThreadBashApprovalAgentId(threadId, request);
    if (!approvalAgentId) {
      return {
        behavior: "deny",
        message: "Eco could not attribute this Bash approval to an agent instance.",
        interrupt: false,
      };
    }
    let approvalRequest: BashApprovalRequest = {
      toolUseId: request.toolUseId,
      ...sdkPermissionApprovalHints(request),
      threadId,
      command,
      cwd,
      reason: confirmation.reason,
      riskScore: confirmation.riskScore ?? 50,
      riskLevel: confirmation.riskLevel ?? "medium",
      agentId: approvalAgentId,
      ...(request.agentType ? { agentType: request.agentType } : {}),
      ...(description ? { description } : { description: confirmation.userMessage }),
    };

    if (bashReviewMode === "auto") {
      const review = await reviewThreadToolApproval(threadId, approvalRequest, {
        toolName: "Bash",
        toolInput: request.input,
        sdkHints: sdkApprovalEvidenceHints(request),
      });
      if (review.action === "allow") {
        const reviewedRequest = {
          ...approvalRequest,
          reviewRationale: review.rationale,
        };
        emitThreadEvent(
          threadId,
          "bash_approval.approved",
          `审批模型已允许 Bash：${command}`,
          "tool",
          false,
          bashApprovalEventExtras(reviewedRequest, "bash_approval.approved"),
        );
        return { behavior: "allow", updatedInput: request.input };
      }
      approvalRequest = {
        ...approvalRequest,
        reviewRationale: review.rationale,
      };
    }

    emitThreadEvent(threadId, "bash_approval.requested", `等待确认 Bash：${command}`, "tool", false, {
      ...bashApprovalEventExtras(approvalRequest, "bash_approval.requested"),
    });

    const resolution = await registerSdkHintApproval(threadId, approvalRequest);
    if (isBashApprovalGranted(threadId, command, resolution)) {
      emitThreadEvent(threadId, "bash_approval.approved", `已允许本次 Bash：${command}`, "tool", false, {
        ...bashApprovalEventExtras(approvalRequest, "bash_approval.approved"),
      });
      return { behavior: "allow", updatedInput: request.input };
    }

    emitThreadEvent(threadId, "bash_approval.rejected", `已拒绝 Bash：${command}`, "tool", false, {
      ...bashApprovalEventExtras(approvalRequest, "bash_approval.rejected"),
    });
    return {
      behavior: "deny",
      message: formatBashApprovalDenyMessage(resolution.feedback),
      interrupt: false,
    };
  };
}

async function reviewThreadToolApproval(
  threadId: string,
  request: BashApprovalRequest,
  tool: {
    toolName: string;
    toolInput: Record<string, unknown>;
    sdkHints?: ApprovalHostEvidence["sdkHints"];
  },
  source: string = "claude",
): Promise<EcoApprovalReviewResult> {
  logUpstream("eco-approval-review-begin", {
    threadId,
    source,
    toolName: tool.toolName,
    command: request.command,
  });
  const thread = conversationStore.getThread(threadId);
  if (!thread) {
    logUpstream("eco-approval-review-skipped", {
      threadId,
      source,
      reason: "thread_missing",
    });
    return {
      action: "human_required",
      rationale: "线程不存在，自动审批已失败关闭并转人工审批。",
      policyMatches: ["thread_missing"],
    };
  }
  let route;
  try {
    route = resolveApprovalModelRoute(
      thread.runtimeConfig?.approvalModel,
      providerStore,
      await resolveSelectedModelOutputOptions(thread.runtimeConfig?.approvalModel),
    );
  } catch (error) {
    logUpstream("eco-approval-review-skipped", {
      threadId,
      source,
      reason: "approval_model_unavailable",
      detail: errorMessage(error),
    });
    return {
      action: "human_required",
      rationale: `审批模型不可用，自动审批已失败关闭并转人工审批：${errorMessage(error)}`,
      policyMatches: ["approval_model_unavailable"],
    };
  }

  const activityLines = conversationStore.listActivityLines(threadId).map((line) => ({
    role: line.role,
    message: line.message,
  }));
  const worktreePath = activeRunRuntimeState.worktreePlan(threadId)?.worktreePath;
  const hostEvidence = await collectApprovalHostEvidence({
    toolName: tool.toolName,
    toolInput: tool.toolInput,
    cwd: request.cwd,
    workspacePath: thread.workspacePath,
    ...(worktreePath ? { worktreePath } : {}),
    ...(tool.sdkHints ? { sdkHints: tool.sdkHints } : {}),
  });
  const built = buildThreadApprovalEnvelope({
    activityLines,
    initialPrompt: thread.prompt,
    toolName: tool.toolName,
    toolInput: tool.toolInput,
    cwd: request.cwd,
    workspacePath: thread.workspacePath,
    reason: request.reason,
    riskScore: request.riskScore,
    riskLevel: request.riskLevel,
    source,
    hostEvidence,
  });
  if (!built.ok) {
    logUpstream("eco-approval-review-skipped", {
      threadId,
      source,
      reason: "envelope_invalid",
      detail: built.rationale,
      policyMatches: built.policyMatches,
    });
    return {
      action: "human_required",
      rationale: built.rationale,
      policyMatches: built.policyMatches,
    };
  }
  const review = await reviewEcoApproval({
    route,
    envelope: built.envelope,
    serializedEnvelope: built.serialized,
    locale: currentAppLocale(),
    ...(proxyBridgeSettingsStore.get().upstreamProxyUrl
      ? { globalProxyUrl: proxyBridgeSettingsStore.get().upstreamProxyUrl! }
      : {}),
  });
  logUpstream("eco-approval-review-result", {
    threadId,
    source,
    toolName: tool.toolName,
    action: review.action,
    rationale: review.rationale,
    policyMatches: review.policyMatches,
    diagnostics: review.diagnostics,
    targetExtractionComplete: hostEvidence.targetExtractionComplete,
    evidenceLimitations: [
      ...hostEvidence.limitations,
      ...hostEvidence.paths.flatMap((entry) => entry.limitations),
    ],
  });
  if (review.action === "allow" && (tool.sdkHints?.defaultToNo || tool.sdkHints?.suppressAlwaysAllowRule)) {
    sdkHintApprovalsHandled.add(request.toolUseId);
  }
  return review;
}

function resolveFilesystemApprovalRequest(input: {
  toolName: string;
  input: Record<string, unknown>;
  cwd: string;
  workspacePath: string;
  confirmationMode: import("@eco/runtime").ExecutionConfirmationMode;
  fallbackReason?: string;
}):
  | {
      action: "ask";
      filesystemPath: string;
      reason: string;
      userMessage: string;
      riskScore?: number;
      riskLevel?: import("@eco/shared").ApprovalRiskLevel;
    }
  | { action: "deny"; reason: string; userMessage: string }
  | undefined {
  const evaluateConfirmation = isWriteFilesystemTool(input.toolName)
    ? evaluateFilesystemWriteConfirmation
    : evaluateFilesystemReadConfirmation;
  const decision = evaluateConfirmation({
    toolName: input.toolName,
    toolInput: input.input,
    cwd: input.cwd,
    workspacePath: input.workspacePath,
    confirmationMode: input.confirmationMode,
    ...(input.fallbackReason ? { fallbackReason: input.fallbackReason } : {}),
  });
  if (!decision || decision.action === "allow") {
    return undefined;
  }
  if (decision.action === "deny") {
    return {
      action: "deny",
      reason: decision.reason,
      userMessage: decision.userMessage,
    };
  }
  const filesystemPath = readFilesystemPath(input.input, input.toolName) ?? ".";
  return {
    action: "ask",
    filesystemPath,
    reason: decision.reason,
    userMessage: decision.userMessage,
    ...(decision.riskScore !== undefined && { riskScore: decision.riskScore }),
    ...(decision.riskLevel && { riskLevel: decision.riskLevel }),
  };
}

function readBashCommandInput(input: Record<string, unknown>): string | undefined {
  for (const key of ["command", "bash_command", "full_command"]) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function readBashDescriptionInput(input: Record<string, unknown>): string | undefined {
  const value = input.description;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isClarificationSubmitPayload(value: unknown): value is ClarificationSubmitPayload {
  if (!value || typeof value !== "object") {
    return false;
  }
  const payload = value as ClarificationSubmitPayload;
  return (
    typeof payload.principalId === "string" &&
    payload.principalId.trim().length > 0 &&
    typeof payload.clientCommandId === "string" &&
    payload.clientCommandId.trim().length > 0 &&
    typeof payload.threadId === "string" &&
    payload.threadId.trim().length > 0 &&
    typeof payload.toolUseId === "string" &&
    payload.toolUseId.trim().length > 0 &&
    Array.isArray(payload.selections) &&
    Number.isSafeInteger(payload.expectedHistoryRevision) &&
    payload.expectedHistoryRevision >= 0
  );
}

function isClarificationDismissPayload(value: unknown): value is ClarificationDismissPayload {
  if (!value || typeof value !== "object") return false;
  const payload = value as ClarificationDismissPayload;
  return (
    typeof payload.principalId === "string" &&
    payload.principalId.trim().length > 0 &&
    typeof payload.clientCommandId === "string" &&
    payload.clientCommandId.trim().length > 0 &&
    typeof payload.threadId === "string" &&
    payload.threadId.trim().length > 0 &&
    typeof payload.toolUseId === "string" &&
    payload.toolUseId.trim().length > 0 &&
    Number.isSafeInteger(payload.expectedHistoryRevision) &&
    payload.expectedHistoryRevision >= 0
  );
}

function isBashApprovalResolvePayload(value: unknown): value is BashApprovalResolvePayload {
  if (!value || typeof value !== "object") {
    return false;
  }
  const payload = value as BashApprovalResolvePayload;
  return (
    typeof payload.principalId === "string" &&
    payload.principalId.trim().length > 0 &&
    typeof payload.clientCommandId === "string" &&
    payload.clientCommandId.trim().length > 0 &&
    typeof payload.threadId === "string" &&
    payload.threadId.trim().length > 0 &&
    typeof payload.toolUseId === "string" &&
    payload.toolUseId.trim().length > 0 &&
    (payload.decision === "approved" ||
      payload.decision === "approved_remember_prefix" ||
      payload.decision === "approved_remember_mcp_tool" ||
      payload.decision === "approved_for_session" ||
      payload.decision === "approved_execpolicy_amendment" ||
      payload.decision === "approved_network_policy_amendment" ||
      payload.decision === "denied" ||
      payload.decision === "cancelled") &&
    (payload.feedback === undefined || typeof payload.feedback === "string") &&
    Number.isSafeInteger(payload.expectedHistoryRevision) &&
    payload.expectedHistoryRevision >= 0
  );
}

function isBashApprovalGranted(
  threadId: string,
  command: string,
  resolution: BashApprovalResolution,
): boolean;
function isBashApprovalGranted(resolution: BashApprovalResolution): boolean;
function isBashApprovalGranted(
  threadIdOrResolution: string | BashApprovalResolution,
  command?: string,
  resolution?: BashApprovalResolution,
): boolean {
  const resolved = typeof threadIdOrResolution === "string" ? resolution : threadIdOrResolution;
  if (!resolved) {
    return false;
  }
  if (resolved.decision === "approved" || resolved.decision === "approved_remember_mcp_tool") {
    return true;
  }
  if (resolved.decision === "approved_remember_prefix") {
    if (typeof threadIdOrResolution === "string" && command) {
      activeRunRuntimeState.rememberBashPrefix(
        threadIdOrResolution,
        deriveBashApprovalRememberPrefix(command),
      );
    }
    return true;
  }
  return false;
}

function emitSettingsUpdated(): void {
  const { digest } = computeGlobalSettingsDigest({
    modelSettings: getModelSettingsSnapshot(),
    workflowSettings: workflowSettingsStore.get(),
  });
  desktopEventCenter.publishSettingsUpdated({
    threadId: "settings",
    type: "settings.updated",
    message: "Model provider settings saved.",
    settingsDigest: digest,
  });
  scheduleCodexGlobalRuntimeRefresh();
}

const lastConnectionErrorEmitByThread = new Map<string, { at: number; message: string }>();

function emitUpstreamModelRequestActivity(
  threadId: string,
  snapshot: { role: string; agentId?: string; logicalRequestId: string },
): void {
  emitThreadEvent(
    threadId,
    "request.started",
    "Requesting model…",
    snapshot.role as RuntimeAgentRole,
    false,
    {
      requestId: snapshot.logicalRequestId,
      ...(snapshot.agentId ? { agentId: snapshot.agentId } : {}),
    },
  );
}

function emitUpstreamConnectionErrorActivity(input: {
  threadId: string;
  role: RuntimeAgentRole;
  error: string;
  logicalRequestId: string;
  statusCode?: number;
}): void {
  const attribution = resolveUpstreamConnectionErrorAttribution(threadLiveRequestRegistry, {
    threadId: input.threadId,
    logicalRequestId: input.logicalRequestId,
    eventRole: input.role,
    ...(input.statusCode !== undefined ? { statusCode: input.statusCode } : {}),
  });
  if (!attribution) {
    const frozen = resolveFrozenLiveRequestAttribution(
      threadLiveRequestRegistry,
      input.threadId,
      input.logicalRequestId,
    );
    if (frozen && frozen.role !== input.role) {
      logEcoDiag("logical.connection_role_conflict", {
        threadId: input.threadId,
        logicalRequestId: input.logicalRequestId,
        eventRole: input.role,
        entryRole: frozen.role,
      });
    }
    return;
  }
  const detail = formatUserFacingRequestError(input.error);
  const summary = input.statusCode ? `HTTP ${input.statusCode}` : detail;
  const message = summary === detail ? `【连接失败】${summary}` : `【连接失败】${summary}：${detail}`;
  const now = Date.now();
  const last = lastConnectionErrorEmitByThread.get(input.threadId);
  if (last && last.message === message && now - last.at < 4000) {
    return;
  }
  lastConnectionErrorEmitByThread.set(input.threadId, { at: now, message });
  emitThreadEvent(input.threadId, "thread.api_error", message, attribution.role as RuntimeAgentRole, false, {
    apiError: {
      message: detail,
      ...(input.statusCode !== undefined && { statusCode: input.statusCode }),
    },
    requestId: attribution.logicalRequestId,
    ...(attribution.agentId ? { agentId: attribution.agentId } : {}),
    metadata: {
      activityOrigin: GATEWAY_ATTEMPT_CONNECTION_ERROR_ORIGIN,
      logicalRequestId: attribution.logicalRequestId,
      ...(attribution.providerRequestId ? { providerRequestId: attribution.providerRequestId } : {}),
      ...(attribution.agentId ? { agentId: attribution.agentId } : {}),
    },
  });
}

function emitLogicalRequestTerminal(
  threadId: string,
  eventRole: string,
  logicalRequestId: string,
  stage: RequestTerminalStage,
  detail?: string,
): void {
  const result = applyLogicalRequestTerminal(
    threadLiveRequestRegistry,
    {
      threadId,
      logicalRequestId,
      stage,
      eventRole,
      ...(detail ? { detail } : {}),
      ...(resolveCurrentRunAttemptId(threadId)
        ? { runAttemptId: resolveCurrentRunAttemptId(threadId)! }
        : {}),
    },
    ({
      threadId: resolvedThreadId,
      role: resolvedRole,
      agentId,
      displayRequestId,
      providerRequestId,
      stage: resolvedStage,
      detail: resolvedDetail,
    }) => {
      emitRequestTerminalUiEvent(resolvedThreadId, {
        requestId: displayRequestId,
        role: resolvedRole,
        ...(agentId && { agentId }),
        ...(providerRequestId && { providerRequestId }),
        stage: resolvedStage,
        ...(resolvedDetail ? { detail: resolvedDetail } : {}),
      });
    },
  );
  if (!result.ok && result.reason === "role_conflict") {
    const frozen = resolveFrozenLiveRequestAttribution(threadLiveRequestRegistry, threadId, logicalRequestId);
    logEcoDiag("logical.terminal_role_conflict", {
      threadId,
      logicalRequestId,
      eventRole,
      ...(frozen ? { entryRole: frozen.role } : {}),
    });
  }
}

function adoptLiveProviderRequestId(
  threadId: string,
  logicalRequestId: string,
  providerRequestId: string,
): void {
  recordProviderRequestIdForLogical(threadLiveRequestRegistry, threadId, logicalRequestId, providerRequestId);
}

function startRuntimeProxy(
  routes: RuntimeRoute[],
  attachments?: PromptImageAttachment[],
  context?: RunAttemptContext | { threadId?: string; runAttemptId?: string },
  proxyThreadOptions?: { emitRequestActivity?: boolean; runAttemptId?: string },
): Promise<Awaited<ReturnType<typeof startAnthropicModelProxy>>> {
  return (async () => {
    const contextByRole = await resolveContextTokensByRole(
      routes,
      pricingCache,
      workflowSettingsStore.get().contextWindowLimitTokens,
    );
    const upstreamUserAgent = resolveUpstreamUserAgentOverride(proxyBridgeSettingsStore.get());
    const threadId = context?.threadId?.trim();
    const runAttemptId = context?.runAttemptId?.trim() || proxyThreadOptions?.runAttemptId?.trim();
    const options: AnthropicProxyStartOptions = {
      ...(threadId && { threadId }),
      ...(runAttemptId && { runAttemptId }),
      ...(upstreamUserAgent && { upstreamUserAgent }),
      ...(attachments && attachments.length > 0 && { pendingImages: attachments }),
      ...(threadId && {
        onMessagesRequest: ({ role, requestHeaders }) => {
          const explicitAgentId = resolveExplicitBridgeRequestAgentId(role, requestHeaders);
          if (!explicitAgentId && isSubagentBillingRole(role)) {
            logEcoDiag("bridge.missing_claude_agent_id_header", {
              threadId: shortThreadId(threadId),
              role,
              reason: "missing_claude_agent_id_header",
            });
          }
          const emitTimelineActivity = proxyThreadOptions?.emitRequestActivity !== false;
          const snapshot = handleBridgeMessagesRequest(threadLiveRequestRegistry, {
            threadId,
            role,
            ...(explicitAgentId && { agentId: explicitAgentId }),
            emitTimelineActivity,
          });
          if (snapshot.emitTimelineActivity) {
            emitUpstreamModelRequestActivity(threadId, snapshot);
          }
          return { logicalRequestId: snapshot.logicalRequestId };
        },
        onUsage: ((info) =>
          emitProxyUsage({
            ...info,
            threadId,
          })) satisfies AnthropicProxyUsageHandler,
      }),
    };
    return startAnthropicModelProxy(
      await Promise.all(
        routes.map(async (route): Promise<AnthropicProxyRoute> => {
          const contextTokens = contextByRole[route.role];
          const catalog = await pricingCache.lookupLimitsForRoute({
            baseUrl: route.provider.baseUrl,
            modelId: route.modelId,
            ...(route.modelsDevMapping && { mapping: route.modelsDevMapping }),
          });
          return runtimeRouteToProxyRoute(route, {
            globalMaxOutputTokens: workflowSettingsStore.get().maxOutputLimitTokens,
            ...(contextTokens !== undefined && { contextTokens }),
            contextTokensResolved: (route.manualSpec?.contextTokens ?? 0) > 0 || (catalog?.limits.contextTokens ?? 0) > 0,
            ...(catalog?.limits.maxOutputTokens !== undefined && {
              catalogMaxOutputTokens: catalog.limits.maxOutputTokens,
            }),
          });
        }),
      ),
      options,
    );
  })();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function resolveCandidateModels(
  pricingCache: ModelsDevPricingCache,
  candidates: CandidateModelView[],
  baseUrl: string,
): Promise<CandidateModelView[]> {
  return Promise.all(
    candidates.map(async (candidate) => {
      const lookupInput = {
        baseUrl,
        modelId: candidate.modelId,
        ...(candidate.modelsDevMapping && {
          mapping: candidate.modelsDevMapping,
        }),
      };
      const [pricingLookup, limitsLookup, capabilitiesLookup] = await Promise.all([
        pricingCache.lookupForRoute(lookupInput),
        pricingCache.lookupLimitsForRoute(lookupInput),
        pricingCache.lookupCapabilitiesForRoute(lookupInput),
      ]);
      const view: CandidateModelView = { ...candidate };
      const manual = candidate.manualSpec;
      if (limitsLookup) {
        view.resolvedContextTokens = manual?.contextTokens ?? limitsLookup.limits.contextTokens;
        const maxOut = manual?.maxOutputTokens ?? limitsLookup.limits.maxOutputTokens;
        if (maxOut !== undefined) view.resolvedMaxOutputTokens = maxOut;
      } else {
        if (manual?.contextTokens !== undefined) view.resolvedContextTokens = manual.contextTokens;
        if (manual?.maxOutputTokens !== undefined) view.resolvedMaxOutputTokens = manual.maxOutputTokens;
      }
      if (capabilitiesLookup) {
        view.resolvedSupportsImageInput =
          manual?.supportsImageInput ?? capabilitiesLookup.capabilities.supportsImageInput;
        view.resolvedSupportsReasoning =
          manual?.supportsReasoning ?? capabilitiesLookup.capabilities.supportsReasoning;
      } else {
        if (manual?.supportsImageInput !== undefined)
          view.resolvedSupportsImageInput = manual.supportsImageInput;
        if (manual?.supportsReasoning !== undefined)
          view.resolvedSupportsReasoning = manual.supportsReasoning;
      }
      view.resolvedSupportsNativeWebSearch = manual?.supportsNativeWebSearch !== false;
      view.resolvedSupportsRemoteCompaction = manual?.supportsRemoteCompaction === true;
      if (pricingLookup) {
        const rates = resolveRatesForRoute(pricingLookup, manual);
        if (rates) {
          view.resolvedInputPerM = rates.input;
          view.resolvedOutputPerM = rates.output;
          if (rates.cacheRead !== undefined) view.resolvedCacheReadPerM = rates.cacheRead;
          if (rates.cacheWrite !== undefined) view.resolvedCacheWritePerM = rates.cacheWrite;
        }
        if (pricingLookup.displayName !== undefined) view.modelsDevLabel = pricingLookup.displayName;
      } else {
        const rates = resolveRatesForRoute(null, manual);
        if (rates) {
          view.resolvedInputPerM = rates.input;
          view.resolvedOutputPerM = rates.output;
          if (rates.cacheRead !== undefined) view.resolvedCacheReadPerM = rates.cacheRead;
          if (rates.cacheWrite !== undefined) view.resolvedCacheWritePerM = rates.cacheWrite;
        }
      }
      return view;
    }),
  );
}

function handleSubscriptionUsageLimitFailure(input: {
  threadId: string;
  role: RuntimeAgentRole;
  logicalRequestId: string;
  turnId?: string;
  runAttemptId?: string;
  accountId?: string;
  providerRequestId?: string;
  responseId?: string;
  statusCode?: number;
  errorInfo: import("@eco/gateway").GatewayUpstreamErrorInfo;
}): boolean {
  const message = "该账号的 ChatGPT 订阅用量受限，本轮已停止";
  const currentRunAttemptId = resolveCurrentRunAttemptId(input.threadId);
  if (!activeRunRuntimeState.ownsRequest(input.threadId, {
    ...(input.runAttemptId ? { runAttemptId: input.runAttemptId } : {}),
    ...(currentRunAttemptId ? { currentRunAttemptId } : {}),
    ...(input.turnId ? { turnId: input.turnId } : {}),
  })) {
    logEcoDiag("gateway.subscription_usage_limit.unowned_request", {
      threadId: shortThreadId(input.threadId),
      eventRunAttemptId: input.runAttemptId,
      currentRunAttemptId,
      eventTurnId: input.turnId,
    });
    return false;
  }

  emitThreadEvent(input.threadId, "thread.api_error", message, input.role, false, {
    requestId: input.logicalRequestId,
    apiError: {
      statusCode: input.statusCode ?? 200,
      ...(input.errorInfo.code ? { code: input.errorInfo.code } : {}),
      message,
      logicalRequestId: input.logicalRequestId,
      ...(input.providerRequestId ? { providerRequestId: input.providerRequestId } : {}),
      ...(input.responseId ? { responseId: input.responseId } : {}),
      ...(input.accountId ? { accountId: input.accountId } : {}),
      threadId: input.threadId,
      ...(input.turnId ? { turnId: input.turnId } : {}),
      ...(input.runAttemptId ? { runAttemptId: input.runAttemptId } : {}),
      ...(input.errorInfo.param ? { param: input.errorInfo.param } : {}),
    },
    metadata: {
      activityOrigin: "gateway.subscription_usage_limit",
      logicalRequestId: input.logicalRequestId,
      ...(input.providerRequestId ? { providerRequestId: input.providerRequestId } : {}),
      ...(input.responseId ? { responseId: input.responseId } : {}),
      ...(input.accountId ? { accountId: input.accountId } : {}),
      threadId: input.threadId,
      ...(input.turnId ? { turnId: input.turnId } : {}),
      ...(input.runAttemptId ? { runAttemptId: input.runAttemptId } : {}),
      upstreamStatusCode: input.statusCode,
      upstreamError: input.errorInfo,
    },
  });

  const aborted = activeRunRuntimeState.abortRun(
    input.threadId,
    `ChatGPT subscription usage limit exceeded; ${message}`,
  );
  if (!aborted) {
    process.stderr.write(
      `[eco-codex] subscription usage limit reached but no active run to interrupt ` +
        `thread=${input.threadId} turn=${input.turnId ?? "(unknown)"} ` +
        `logical=${input.logicalRequestId}\n`,
    );
  }
  return true;
}
