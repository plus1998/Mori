import type {
  ThreadRunProjectionRequestSpan,
  ThreadRunProjectionSnapshot,
} from "./conversation-v2-projection";
import type {
  ImageGenerationArtifact,
  ImageGenerationArtifactListRequest,
  ImageGenerationArtifactReadRequest,
  ImageGenerationArtifactReadResult,
  ImageGenerationProfileSaveInput,
  ImageGenerationProfileSnapshot,
  ImageGenerationSettingsSaveInput,
  ImageGenerationSettingsSnapshot,
} from "./image-generation";
import type { IntegrationAvailabilitySnapshot, IntegrationsEnabledSettings } from "./integrations";
import type { McpSettingsSnapshot } from "./mcp";
import type { ThreadRunToolMetadata } from "./thread-run-events";
import type {
  TtsArtifact,
  TtsArtifactListRequest,
  TtsArtifactReadRequest,
  TtsArtifactReadResult,
  TtsProfileSaveInput,
  TtsProfileSnapshot,
  TtsSettingsSaveInput,
  TtsSettingsSnapshot,
} from "./tts";

export const IPC_CHANNELS = {
  schedulingList: "scheduling:list",
  schedulingCreate: "scheduling:create",
  schedulingUpdate: "scheduling:update",
  schedulingDelete: "scheduling:delete",
  schedulingRunNow: "scheduling:run-now",
  schedulingPreview: "scheduling:preview",
  schedulingChanged: "scheduling:changed",
  appMenuCommand: "app:menu-command",
  appRendererReady: "app:renderer-ready",
  appScreenRecordingAppLabel: "app:screen-recording-app-label",
  appSetThemeSource: "app:set-theme-source",
  appSetWindowTitlebarMode: "app:set-window-titlebar-mode",
  appSetLocale: "app:set-locale",
  appUpdateGetState: "app:update-get-state",
  appUpdateCheck: "app:update-check",
  appUpdateDownload: "app:update-download",
  appUpdateInstall: "app:update-install",
  appUpdateOpenRelease: "app:update-open-release",
  appUpdateStateChanged: "app:update-state-changed",
  appShowThreadCompletionNotification: "app:show-thread-completion-notification",
  appShowThreadApprovalNotification: "app:show-thread-approval-notification",
  appShowThreadClarificationNotification: "app:show-thread-clarification-notification",
  appConsumePendingThreadOpen: "app:consume-pending-thread-open",
  appThreadOpenRequested: "app:thread-open-requested",
  coreAvailabilityGet: "core:availability-get",
  clipboardReadText: "clipboard:read-text",
  clipboardReadImage: "clipboard:read-image",
  clipboardWriteImage: "clipboard:write-image",
  cursorModelsList: "cursor:models-list",
  workspaceOpen: "workspace:open",
  workspaceOpenPath: "workspace:open-path",
  workspaceGetCurrent: "workspace:get-current",
  workspaceGetHomePath: "workspace:get-home-path",
  workspaceGetUserHomePath: "workspace:get-user-home-path",
  workspaceListDirectories: "workspace:list-directories",
  workspaceListEntries: "workspace:list-entries",
  workspaceReadFile: "workspace:read-file",
  workspaceWriteFile: "workspace:write-file",
  workspaceInspect: "workspace:inspect",
  workspaceOpenInFileManager: "workspace:open-in-file-manager",
  workspaceOpenFileExternally: "workspace:open-file-externally",
  workspaceOpenContainingFolder: "workspace:open-containing-folder",
  workspaceGetAssociatedApps: "workspace:get-associated-apps",
  workspaceOpenFileWithApp: "workspace:open-file-with-app",
  workspaceListPackageScripts: "workspace:list-package-scripts",
  workspaceSavePackageScriptArgs: "workspace:save-package-script-args",
  workspaceWatchPackageJson: "workspace:watch-package-json",
  workspacePackageJsonChanged: "workspace:package-json-changed",
  workspaceStartPackageScript: "workspace:start-package-script",
  workspacePackageScriptTerminal: "workspace:package-script-terminal",
  backgroundTerminalList: "background-terminal:list",
  backgroundTerminalStart: "background-terminal:start",
  backgroundTerminalOpen: "background-terminal:open",
  backgroundTerminalStop: "background-terminal:stop",
  codexBackgroundTerminalList: "codex-background-terminal:list",
  codexBackgroundTerminalTerminate: "codex-background-terminal:terminate",
  claudeBackgroundTaskList: "claude-background-task:list",
  claudeBackgroundTaskStop: "claude-background-task:stop",
  workspacePrepareGit: "workspace:prepare-git",
  modelSettingsGet: "model-settings:get",
  settingsDigest: "settings:digest",
  modelProviderSave: "model-provider:save",
  modelProviderDelete: "model-provider:delete",
  modelProviderListModels: "model-provider:list-models",
  modelProviderTest: "model-provider:test",
  chatGptSubscriptionAccountsList: "chatgpt-subscription:accounts-list",
  chatGptSubscriptionAccountCreate: "chatgpt-subscription:account-create",
  chatGptSubscriptionAccountDelete: "chatgpt-subscription:account-delete",
  chatGptSubscriptionAccountLogin: "chatgpt-subscription:account-login",
  chatGptSubscriptionAccountAuthorizationUrl: "chatgpt-subscription:account-authorization-url",
  chatGptSubscriptionAccountSetEnabled: "chatgpt-subscription:account-set-enabled",
  chatGptSubscriptionAccountResetAvailability: "chatgpt-subscription:account-reset-availability",
  chatGptSubscriptionAccountSetProxy: "chatgpt-subscription:account-set-proxy",
  chatGptSubscriptionAccountTest: "chatgpt-subscription:account-test",
  chatGptModelCatalogGet: "chatgpt-model-catalog:get",
  chatGptModelCatalogRefresh: "chatgpt-model-catalog:refresh",
  chatGptModelCatalogAdd: "chatgpt-model-catalog:add",
  chatGptModelCatalogRemove: "chatgpt-model-catalog:remove",
  codexOAuthGetStatus: "codex-oauth:get-status",
  codexOAuthStartLogin: "codex-oauth:start-login",
  codexOAuthLogout: "codex-oauth:logout",
  openAIAccountsList: "openai-accounts:list",
  openAIAccountsCreate: "openai-accounts:create",
  openAIAccountsDelete: "openai-accounts:delete",
  openAIAccountsStartLogin: "openai-accounts:start-login",
  openAIAccountsSetActive: "openai-accounts:set-active",
  openAIAccountsGetActive: "openai-accounts:get-active",
  openAIAccountsSetAuthJson: "openai-accounts:set-auth-json",
  openAIAccountsQueryQuota: "openai-accounts:query-quota",
  openAIAccountsResetQuota: "openai-accounts:reset-quota",
  openAIAccountsImageEnabled: "openai-accounts:image-enabled",
  openAIAccountsImageQuota: "openai-accounts:image-quota",
  openAIAccountsUpdate: "openai-accounts:update",
  openAIAccountsGetAuthJson: "openai-accounts:get-auth-json",
  openAIAccountsGetDetails: "openai-accounts:get-details",
  openAIAccountsImport: "openai-accounts:import",
  openAIAccountsCancelSwitch: "openai-accounts:cancel-switch",
  openAIAccountsChanged: "openai-accounts:changed",
  openAIAccountsOpenAssistant: "openai-accounts:open-assistant",
  openAIAccountsAssistantState: "openai-accounts:assistant-state",
  openAIAccountsAssistantAction: "openai-accounts:assistant-action",
  modelRouteProfileTest: "model-route-profile:test",
  modelRouteProfileSave: "model-route-profile:save",
  modelRouteProfileDelete: "model-route-profile:delete",
  agentTemplateList: "agent-template:list",
  agentTemplateSave: "agent-template:save",
  agentTemplateDelete: "agent-template:delete",
  agentTemplateExport: "agent-template:export",
  agentTemplateImport: "agent-template:import",
  mainAgentConfigSave: "main-agent-config:save",
  mainAgentConfigDelete: "main-agent-config:delete",
  mainAgentPromptSave: "main-agent-prompt:save",
  mainAgentPromptDelete: "main-agent-prompt:delete",
  subagentOrchestrationSave: "subagent-orchestration:save",
  subagentOrchestrationDelete: "subagent-orchestration:delete",
  threadStart: "thread:start",
  threadUpdateRuntimeConfig: "thread:update-runtime-config",
  composerReferencesSearch: "composer-references:search",
  threadList: "thread:list",
  threadListInitial: "thread:list-initial",
  threadListMore: "thread:list-more",
  threadGet: "thread:get",
  projectTodoList: "project-todo:list",
  projectTodoGet: "project-todo:get",
  projectTodoSave: "project-todo:save",
  projectTodoTrash: "project-todo:trash",
  composerDraftGet: "composer-draft:get",
  composerDraftSave: "composer-draft:save",
  composerDraftDelete: "composer-draft:delete",
  promptImageStage: "prompt-image:stage",
  promptImageRelease: "prompt-image:release",
  promptImageUploadBegin: "prompt-image:upload-begin",
  promptImageUploadChunk: "prompt-image:upload-chunk",
  promptImageUploadFinish: "prompt-image:upload-finish",
  promptImageReadChunk: "prompt-image:read-chunk",
  threadSessionBootstrap: "thread:session-bootstrap",
  conversationCapabilities: "conversation:capabilities",
  conversationBootstrap: "conversation:bootstrap",
  conversationProjection: "conversation:projection",
  conversationMessagesPage: "conversation:messages-page",
  conversationDetailsPage: "conversation:details-page",
  conversationToolsPage: "conversation:tools-page",
  conversationSync: "conversation:sync",
  conversationHead: "conversation:head",
  conversationMessageGet: "conversation:message-get",
  conversationRunGet: "conversation:run-get",
  conversationDetailGet: "conversation:detail-get",
  conversationSendMessage: "conversation:send-message",
  threadUserMessageEditGet: "thread:user-message-edit-get",
  threadRewriteFromMessage: "thread:rewrite-from-message",
  threadForkFromMessage: "thread:fork-from-message",
  threadRetryFromMessage: "thread:retry-from-message",
  threadDelete: "thread:delete",
  threadRegenerateTitle: "thread:regenerate-title",
  threadCancel: "thread:cancel",
  threadRollbackTo: "thread:rollback-to",
  threadGetAppliedDiff: "thread:get-applied-diff",
  threadRevertAppliedDiff: "thread:revert-applied-diff",
  threadApprovePlan: "thread:approve-plan",
  threadDismissPlan: "thread:dismiss-plan",
  threadFollowUpEnqueue: "thread:follow-up-enqueue",
  threadFollowUpEscalate: "thread:follow-up-escalate",
  threadFollowUpEditing: "thread:follow-up-editing",
  threadFollowUpQueuePaused: "thread:follow-up-queue-paused",
  threadFollowUpUpdate: "thread:follow-up-update",
  threadFollowUpReorder: "thread:follow-up-reorder",
  threadFollowUpList: "thread:follow-up-list",
  threadFollowUpCancel: "thread:follow-up-cancel",
  threadGetPendingPlan: "thread:get-pending-plan",
  threadGetApprovedPlan: "thread:get-approved-plan",
  clarificationGetPending: "clarification:get-pending",
  clarificationSubmit: "clarification:submit",
  clarificationDismiss: "clarification:dismiss",
  bashApprovalGetPending: "bash-approval:get-pending",
  bashApprovalResolve: "bash-approval:resolve",
  threadEventsSubscribe: "thread-events:subscribe",
  approvalResolve: "approval:resolve",
  modelProfilesList: "model-profiles:list",
  modelProfileSave: "model-profile:save",
  conformanceRun: "conformance:run",
  worktreeApply: "worktree:apply",
  worktreeGetStatus: "worktree:get-status",
  terminalList: "terminal:list",
  terminalSpawn: "terminal:spawn",
  terminalInput: "terminal:input",
  terminalResize: "terminal:resize",
  terminalKill: "terminal:kill",
  terminalEvent: "terminal:event",
  mcpSettingsGet: "mcp-settings:get",
  mcpServerSave: "mcp-server:save",
  mcpServerDelete: "mcp-server:delete",
  mcpServerCheck: "mcp-server:check",
  skillsList: "skills:list",
  skillsLinkAgents: "skills:link-agents",
  skillsUninstall: "skills:uninstall",
  skillsCatalogLeaderboard: "skills:catalog-leaderboard",
  skillsCatalogSearch: "skills:catalog-search",
  skillsCatalogInstall: "skills:catalog-install",
  cursorAgentsList: "cursor-agents:list",
  projectSkillsSettingsGet: "project-skills-settings:get",
  projectSkillsSettingsSave: "project-skills-settings:save",
  projectMcpSettingsGet: "project-mcp-settings:get",
  projectMcpSettingsSave: "project-mcp-settings:save",
  projectIntegrationsSettingsGet: "project-integrations-settings:get",
  projectIntegrationsSettingsSave: "project-integrations-settings:save",
  projectOrchestrationSettingsGet: "project-orchestration-settings:get",
  projectOrchestrationSettingsSave: "project-orchestration-settings:save",
  workflowSettingsGet: "workflow-settings:get",
  workflowSettingsSave: "workflow-settings:save",
  proxyBridgeSettingsGet: "proxy-bridge-settings:get",
  proxyBridgeSettingsSave: "proxy-bridge-settings:save",
  integratedWebSearchSettingsGet: "integrated-web-search-settings:get",
  integratedWebSearchSettingsSave: "integrated-web-search-settings:save",
  integratedWebSearchTest: "integrated-web-search:test",
  centerServerSettingsGet: "center-server-settings:get",
  supabaseDeploymentGet: "supabase-deployment:get",
  supabaseDeploymentAuthorize: "supabase-deployment:authorize",
  supabaseDeploymentForget: "supabase-deployment:forget",
  supabaseDeploymentInspect: "supabase-deployment:inspect",
  supabaseDeploymentRun: "supabase-deployment:run",
  supabaseDeploymentConnection: "supabase-deployment:connection",
  supabaseDeploymentChanged: "supabase-deployment:changed",
  centerServerSettingsSave: "center-server-settings:save",
  centerServerRegisterDesktop: "center-server:register-desktop",
  centerServerSignUp: "center-server:sign-up",
  centerServerSignIn: "center-server:sign-in",
  centerServerCreatePairing: "center-server:create-pairing",
  centerServerBuildConnectQr: "center-server:build-connect-qr",
  centerServerListBindings: "center-server:list-bindings",
  centerServerListPresence: "center-server:list-presence",
  centerServerRevokeBinding: "center-server:revoke-binding",
  centerServerConnect: "center-server:connect",
  centerServerDisconnect: "center-server:disconnect",
  centerServerRemoveConnection: "center-server:remove-connection",
  centerServerTestConnection: "center-server:test-connection",
  centerServerStatusChanged: "center-server:status-changed",
  centerServerVaultStatusGet: "center-server:vault-status-get",
  centerServerSyncConfig: "center-server:sync-config",
  centerServerSyncConfigDomain: "center-server:sync-config-domain",
  centerServerGetSyncStatus: "center-server:get-sync-status",
  centerServerUnlockVaultWithPassword: "center-server:unlock-vault-with-password",
  centerServerWrapVaultWithPassword: "center-server:wrap-vault-with-password",
  centerServerRequestVaultClaim: "center-server:request-vault-claim",
  centerServerListPendingVaultClaims: "center-server:list-pending-vault-claims",
  centerServerApproveVaultClaim: "center-server:approve-vault-claim",
  centerServerSubmitVaultClaimCode: "center-server:submit-vault-claim-code",
  centerServerCancelVaultClaim: "center-server:cancel-vault-claim",
  billingRefreshPricing: "billing:refresh-pricing",
  billingRoutePricing: "billing:route-pricing",
  billingRouteCapabilities: "billing:route-capabilities",
  billingModelsDevList: "billing:models-dev-list",
  candidateModelList: "candidate-model:list",
  candidateModelSave: "candidate-model:save",
  candidateModelDelete: "candidate-model:delete",
  candidateModelReorder: "candidate-model:reorder",
  candidateModelBulkImport: "candidate-model:bulk-import",
  codexModelCatalogGet: "codex-model-catalog:get",
  codexModelCatalogRefresh: "codex-model-catalog:refresh",
  codexModelCatalogAdd: "codex-model-catalog:add",
  codexModelCatalogRemove: "codex-model-catalog:remove",
  gitGetStatus: "git:get-status",
  gitGetWorkspaceDiff: "git:get-workspace-diff",
  gitGetWorkspaceFileDiff: "git:get-workspace-file-diff",
  gitDiffChanged: "git:diff-changed",
  gitStatusChanged: "git:status-changed",
  gitDiscardWorkspaceChanges: "git:discard-workspace-changes",
  gitListCommits: "git:list-commits",
  gitCheckoutBranch: "git:checkout-branch",
  gitCreateBranch: "git:create-branch",
  gitGenerateCommitMessage: "git:generate-commit-message",
  gitGenerateCommitMessageDelta: "git:generate-commit-message-delta",
  gitListCommitModelOptions: "git:list-commit-model-options",
  approvalListModelOptions: "approval:list-model-options",
  gitSaveCommitModelPreference: "git:save-commit-model-preference",
  gitCommit: "git:commit",
  gitPush: "git:push",
  gitFetch: "git:fetch",
  gitPull: "git:pull",
  gitRemoteFetched: "git:remote-fetched",
  gitSettingsGet: "git-settings:get",
  gitSettingsSave: "git-settings:save",
  personalizationSettingsGet: "personalization-settings:get",
  personalizationSettingsSave: "personalization-settings:save",
  asrSettingsGet: "asr-settings:get",
  asrSettingsSave: "asr-settings:save",
  asrProfilesList: "asr-profiles:list",
  asrProfileSave: "asr-profile:save",
  asrProfileDelete: "asr-profile:delete",
  asrProfileActivate: "asr-profile:activate",
  asrInputDeviceSave: "asr-input-device:save",
  asrTranscribe: "asr:transcribe",
  asrSettingsGetStatus: "asr-settings:get-status",
  asrSettingsGetClientConfig: "asr-settings:get-client-config",
  storageGetUsage: "storage:get-usage",
  storageCleanup: "storage:cleanup",
  browserSettingsGet: "browser-settings:get",
  browserSettingsSave: "browser-settings:save",
  computerUseSettingsGet: "computer-use-settings:get",
  computerUseSettingsSave: "computer-use-settings:save",
  computerUseDoctor: "computer-use:doctor",
  computerUsePermissionStatus: "computer-use:permission-status",
  webChatListGet: "web-chat-list:get",
  webChatListSave: "web-chat-list:save",
  sshBookmarksGet: "ssh-bookmarks:get",
  sshBookmarksSave: "ssh-bookmarks:save",
  sshBookmarksDelete: "ssh-bookmarks:delete",
  sshBookmarksConnect: "ssh-bookmarks:connect",
  sshBookmarksGetDefaultKeyPath: "ssh-bookmarks:get-default-key-path",
  notificationSettingsGet: "notification-settings:get",
  notificationSettingsSave: "notification-settings:save",
  browserOpen: "browser:open",
  browserNavigate: "browser:navigate",
  browserFocus: "browser:focus",
  browserClose: "browser:close",
  browserSetUiScope: "browser:set-ui-scope",
  browserGoBack: "browser:go-back",
  browserGoForward: "browser:go-forward",
  browserReload: "browser:reload",
  browserSetViewport: "browser:set-viewport",
  browserRegisterGuest: "browser:register-guest",
  browserSetVisible: "browser:set-visible",
  browserGetState: "browser:get-state",
  browserAgentProcessesList: "browser:agent-processes-list",
  browserAgentProcessStop: "browser:agent-process-stop",
  /** Dev-only: mint thread-scoped browser CDP for smoke/probe scripts. */
  browserDevPrepareAgentCdp: "browser:dev-prepare-agent-cdp",
  browserOpenExternal: "browser:open-external",
  browserDownloadAction: "browser:download-action",
  browserCaptureSelection: "browser:capture-selection",
  browserCancelSelection: "browser:cancel-selection",
  browserReadSelection: "browser:read-selection",
  browserRevealSelection: "browser:reveal-selection",
  browserStateChanged: "browser:state-changed",
  /** Agent operating the built-in browser (rainbow edge / synthetic cursor). */
  browserAgentPresence: "browser:agent-presence",
  integrationAvailabilityGet: "integration-availability:get",
  imageGenerationSettingsGet: "image-generation-settings:get",
  imageGenerationSettingsSave: "image-generation-settings:save",
  imageGenerationProfileSave: "image-generation-profile:save",
  imageGenerationProfileDelete: "image-generation-profile:delete",
  imageGenerationProfileActivate: "image-generation-profile:activate",
  imageGenerationArtifactsList: "image-generation-artifacts:list",
  imageGenerationArtifactRead: "image-generation-artifact:read",
  imageGenerationArtifactReveal: "image-generation-artifact:reveal",
  imageGenerationArtifactChanged: "image-generation-artifact:changed",
  ttsReadAloudStatus: "tts-read-aloud:status",
  ttsReadAloudSettingsGet: "tts-read-aloud:settings:get",
  ttsReadAloudSettingsSave: "tts-read-aloud:settings:save",
  ttsReadAloudStart: "tts-read-aloud:start",
  ttsReadAloudSegment: "tts-read-aloud:segment",
  ttsReadAloudRead: "tts-read-aloud:read",
  ttsReadAloudCancel: "tts-read-aloud:cancel",
  ttsSettingsGet: "tts-settings:get",
  ttsSettingsSave: "tts-settings:save",
  ttsProfileSave: "tts-profile:save",
  ttsProfileDelete: "tts-profile:delete",
  ttsProfileActivate: "tts-profile:activate",
  ttsArtifactsList: "tts-artifacts:list",
  ttsArtifactRead: "tts-artifact:read",
  ttsArtifactReveal: "tts-artifact:reveal",
  ttsArtifactChanged: "tts-artifact:changed",
  imageViewRead: "image-view:read",
  imageRevealInFolder: "image:reveal-in-folder",
  imageDisplayArtifactsList: "image-display-artifacts:list",
  imageDisplayRead: "image-display:read",
  imageDisplayArtifactChanged: "image-display-artifact:changed",
  htmlHostArtifactsList: "html-host-artifacts:list",
  htmlHostArtifactChanged: "html-host-artifact:changed",
  centerServerHtmlHostingRefresh: "center-server:html-hosting-refresh",
  appEcoDeepLinkOpen: "app:eco-deep-link-open",
} as const;

export type AppMenuCommand =
  | "new-chat"
  | "open-folder"
  | "check-for-updates"
  | "toggle-sidebar"
  | "toggle-bottom-panel"
  | "toggle-work-panel"
  | "toggle-review-panel"
  | "toggle-file-tree"
  | "toggle-browser";

export type {
  CenterServerAccountAuthResult,
  CenterServerAccountView,
  CenterServerApproveVaultClaimResult,
  CenterServerConnectionState,
  CenterServerConnectionStatus,
  CenterServerCreatePairingResult,
  CenterServerDeviceBindingView,
  CenterServerDevicePresenceView,
  CenterServerDeviceView,
  CenterServerRegisterDesktopRequest,
  CenterServerRegisterDesktopResult,
  CenterServerRemoveConnectionOptions,
  CenterServerRemoveConnectionResult,
  CenterServerRequestVaultClaimResult,
  CenterServerSettingsInput,
  CenterServerSettingsSnapshot,
  CenterServerSettingsView,
  CenterServerSignInRequest,
  CenterServerSignUpRequest,
  CenterServerSubmitVaultClaimCodeResult,
  CenterServerSyncConfigResult,
  CenterServerSyncDomain,
  CenterServerSyncDomainResult,
  CenterServerSyncStatusSnapshot,
  CenterServerTestConnectionRequest,
  CenterServerTestConnectionResult,
  CenterServerVaultClaimView,
  CenterServerVaultStatus,
  CenterServerVaultSyncState,
  EcoConnectDeepLink,
} from "./center-server";

export { parseEcoConnectDeepLink } from "./center-server";

export interface CoreAvailabilitySnapshot {
  claude: { available: true; version?: string };
  codex: { available: boolean; reason?: string; version?: string };
  pi: { available: boolean; reason?: string; version?: string };
  cursor: { available: boolean; reason?: string; version?: string };
}

export interface CursorModelOption {
  id: string;
  displayName: string;
  current: boolean;
  default: boolean;
}
export type {
  ThreadRunProjectionAgent,
  ThreadRunProjectionAgentKind,
  ThreadRunProjectionAgentStatus,
  ThreadRunProjectionAttempt,
  ThreadRunProjectionAttemptStatus,
  ThreadRunProjectionContext,
  ThreadRunProjectionDetailKind,
  ThreadRunProjectionDetailRequest,
  ThreadRunProjectionDetailResult,
  ThreadRunProjectionDiagnostic,
  ThreadRunProjectionDiagnosticCode,
  ThreadRunProjectionRequestSpan,
  ThreadRunProjectionRequestStatus,
  ThreadRunProjectionSnapshot,
  ThreadRunProjectionTimelineItem,
  ThreadRunProjectionUsage,
  ThreadRunProjectionWritingTool,
  ToolWritingActivity,
} from "./conversation-v2-projection";
export type {
  CursorAgentInfo,
  CursorAgentLayout,
  CursorAgentSource,
  CursorAgentsListResult,
  CursorBuiltinSubagentType,
} from "./cursor-agents";
export {
  CURSOR_AGENTS_REL,
  CURSOR_BUILTIN_SUBAGENT_TYPES,
} from "./cursor-agents";
export type {
  EventCenterEnvelope,
  EventCenterEventKind,
  EventCenterInvokeParams,
  EventCenterInvokeResult,
  EventCenterJsonRpcFailure,
  EventCenterJsonRpcNotification,
  EventCenterJsonRpcRequest,
  EventCenterJsonRpcResponse,
  EventCenterJsonRpcSuccess,
  EventCenterPackageJsonChangedPayload,
  EventCenterPayloadMap,
  EventCenterSource,
  ThreadEventCenterEventKind,
} from "./event-center";
export {
  buildEventCenterJsonRpcFailure,
  buildEventCenterJsonRpcNotification,
  buildEventCenterJsonRpcSuccess,
  classifyThreadLiveEventForCenter,
  EVENT_CENTER_JSON_RPC_ERROR,
  EVENT_CENTER_JSON_RPC_METHODS,
  EVENT_CENTER_JSON_RPC_VERSION,
  EVENT_CENTER_PROTOCOL_VERSION,
  isEventCenterInvokeParams,
  isEventCenterJsonRpcRequest,
  isThreadPlanLiveEvent,
} from "./event-center";
export type {
  McpServerCheckResult,
  McpServerConfigInput,
  McpServerConfigView,
  McpSettingsSnapshot,
  McpTransport,
} from "./mcp";
export type {
  AddCodexCatalogModelRequest,
  CodexCatalogModelOrigin,
  CodexCatalogModelView,
  CodexModelCatalogSnapshot,
  CodexModelCatalogStatusView,
  ListUpstreamModelsRequest,
  ListUpstreamModelsResult,
  ProviderRequestError,
  RoleRouteTestResult,
  TestProviderConnectionRequest,
  TestProviderConnectionResult,
  TestRoleRouteItem,
  TestRoleRoutesRequest,
  TestRoleRoutesResult,
  UpstreamModelOption,
} from "./models";
export type {
  LinkAgentsSkillsRequest,
  LinkAgentsSkillsResult,
  SkillCatalogInstallRequest,
  SkillCatalogInstallResult,
  SkillCatalogSearchRequest,
  SkillCatalogSearchResult,
  SkillInfo,
  SkillSource,
  SkillsListResult,
  SkillUninstallRequest,
  SkillUninstallResult,
} from "./skills";
export type {
  ThreadRunBashApprovalMetadata,
  ThreadRunBashApprovalPhase,
  ThreadRunEvent,
  ThreadRunEventInput,
  ThreadRunEventScope,
  ThreadRunEventStreamState,
  ThreadRunEventType,
  ThreadRunImageViewMetadata,
  ThreadRunToolMetadata,
  ThreadRunWebSearchMetadata,
} from "./thread-run-events";

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];

/** V2-owned projection extras used by the desktop Feed panels. */
export interface ConversationV2ProjectionExtras {
  requestSpans: ThreadRunProjectionRequestSpan[];
  billing?: ThreadBillingSnapshot;
  /** V2-owned per-request billing observations used by the events breakdown. */
  ledgerEvents?: ThreadUsageLedgerEventView[];
  context?: ThreadContextSnapshot;
  subagentTimings?: ThreadSubagentSessionTiming[];
  subagentMetrics?: ThreadSubagentMetricsSummary[];
}

export type {
  ImageDisplayArtifact,
  ImageDisplayArtifactReadRequest,
  ImageDisplayArtifactReadResult,
  ImageDisplayReadFailureCode,
  ImageDisplayReadResult,
} from "./image-display";

export interface ImageViewReadRequest {
  path: string;
}

export interface ImageRevealInFolderRequest {
  path: string;
}

/**
 * PNG bytes for a system-clipboard image write performed in the main process.
 *
 * The renderer's `navigator.clipboard.write` needs a focused document, so the image viewer
 * falls back to this channel when that write is refused (see `image-clipboard.ts`).
 */
export interface ClipboardWriteImageRequest {
  pngBase64: string;
}

/**
 * PNG bytes read out of the system clipboard by the main process.
 *
 * Renderer clipboard-read stays denied (see `session-permissions.ts`), so right-click "Paste"
 * in the Composer asks main for the clipboard image the same way the terminal asks for text.
 * `null` means the clipboard holds no image.
 */
export interface ClipboardReadImageResult {
  pngBase64: string;
  byteLength: number;
}

/** Upper bound for the base64 PNG accepted by `clipboard:write-image` (≈30 MB of image bytes). */
export const MAX_CLIPBOARD_IMAGE_BASE64_CHARS = 40_000_000;

export type ImageViewReadFailureCode =
  | "invalid_path"
  | "not_found"
  | "symbolic_link"
  | "not_file"
  | "too_large"
  | "unsupported_type";

export type ImageViewReadResult =
  | {
      ok: true;
      dataBase64: string;
      mimeType:
        | "image/png"
        | "image/jpeg"
        | "image/gif"
        | "image/webp"
        | "image/svg+xml"
        | "image/x-icon"
        | "image/bmp";
      path: string;
      fileName: string;
      bytes: number;
      width: number;
      height: number;
    }
  | {
      ok: false;
      code: ImageViewReadFailureCode;
    };

/** ASR upstream protocol: Qwen-style chat completions vs OpenAI audio transcriptions. */
export type AsrApiMode = "chat_completions" | "audio_transcriptions";

export interface AsrSettingsSnapshot {
  endpoint: string;
  apiMode: AsrApiMode;
  model: string;
  systemPrompt: string;
  hasApiKey: boolean;
  apiKeyEncryptionAvailable: boolean;
  /** Present for profile-aware callers; legacy callers can ignore it. */
  profileId?: string;
  /** Present for profile-aware callers; legacy callers can ignore it. */
  profileName?: string;
  inputDeviceId?: string;
}
export interface AsrSettingsStatus {
  activeProfileId: string;
  activeProfileName: string;
  hasApiKey: boolean;
  apiKeyEncryptionAvailable: boolean;
  model: string;
}

export interface AsrSettingsInput {
  endpoint: string;
  apiMode?: AsrApiMode;
  model: string;
  systemPrompt: string;
  /** Empty means keep the existing key. */
  apiKey?: string;
}

export interface AsrClientConfig {
  endpoint: string;
  apiMode: AsrApiMode;
  model: string;
  systemPrompt: string;
  apiKey: string;
}

export interface AsrProfileSnapshot {
  id: string;
  name: string;
  endpoint: string;
  apiMode: AsrApiMode;
  model: string;
  systemPrompt: string;
  hasApiKey: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AsrProfilesSnapshot {
  profiles: AsrProfileSnapshot[];
  activeProfileId: string;
  inputDeviceId?: string;
  apiKeyEncryptionAvailable: boolean;
}

export interface AsrProfileSaveInput {
  /** Omit to create a new profile. */
  id?: string;
  name: string;
  endpoint: string;
  apiMode?: AsrApiMode;
  model: string;
  systemPrompt: string;
  /** Empty means keep the key of this same profile; a new profile remains keyless. */
  apiKey?: string;
}

export interface AsrProfileDeleteRequest {
  id: string;
}

export interface AsrProfileActivateRequest {
  id: string;
}

export interface AsrInputDeviceSaveInput {
  /** Empty or null clears the saved input device. */
  inputDeviceId?: string | null;
}

export interface AsrTranscribeRequest {
  audioWavBase64: string;
  /** Pins transcription to the profile selected when recording started. */
  profileId?: string;
}

export interface AsrTranscribeResult {
  text: string;
}

export function isKnownIpcChannel(channel: string): channel is IpcChannel {
  return Object.values(IPC_CHANNELS).includes(channel as IpcChannel);
}

export interface WorkspaceInfo {
  path: string;
  name: string;
  isGitRepository: boolean;
  /** False when the repo exists but has no commits yet (HEAD invalid for worktrees). */
  hasGitCommits?: boolean;
  gitRoot?: string;
  branch?: string;
  dirtyFileCount: number;
  packageManager?: "bun" | "pnpm" | "yarn" | "npm";
}

export interface WorkspaceDirectoryEntry {
  name: string;
  path: string;
}

export interface WorkspaceDirectoryListing {
  path: string;
  parentPath?: string;
  directories: WorkspaceDirectoryEntry[];
}

export interface WorkspaceFileBrowserRequest {
  workspacePath: string;
  directoryPath: string;
}

export interface WorkspaceFileEntry {
  name: string;
  path: string;
  kind: "directory" | "file";
  size?: number;
}

export interface WorkspaceFileReadRequest {
  workspacePath: string;
  filePath: string;
  /** UTF-8 byte boundary returned by the preceding chunk. */
  offset?: number;
  revision?: string;
}

export interface WorkspaceFileWriteRequest {
  workspacePath: string;
  filePath: string;
  content: string;
}

export interface WorkspaceFileWriteResult {
  path: string;
  name: string;
  size: number;
}

export type WorkspaceFileKind = "text" | "image" | "audio" | "video" | "pdf" | "unsupported";

export interface WorkspaceFileReadResult {
  path: string;
  name: string;
  size: number;
  kind: WorkspaceFileKind;
  mimeType?: string;
  content?: string;
  base64?: string;
  url?: string;
  nextOffset?: number;
  truncated?: boolean;
  reason?: string;
  revision?: string;
}

export type PackageManagerKind = "bun" | "pnpm" | "yarn" | "npm";

export interface PackageScriptInfo {
  name: string;
  command: string;
}

export interface PackageScriptsListResult {
  workspacePath: string;
  hasPackageJson: boolean;
  packageName?: string;
  packageManager: PackageManagerKind;
  scripts: PackageScriptInfo[];
  /** Per-script trailing args saved on Desktop; synced to Mobile via list RPC. */
  scriptArgs: Record<string, string>;
  /** Per-script leading shell commands (nvm switch, env exports) saved on Desktop. */
  scriptPrefixes: Record<string, string>;
}

/** Saved per-script overrides for one workspace: trailing args + leading command. */
export interface PackageScriptOverrides {
  args: Record<string, string>;
  prefixes: Record<string, string>;
}

export interface SavePackageScriptArgsRequest {
  workspacePath: string;
  script: string;
  /** Trailing args. Omitted keeps the stored value; blank clears it. */
  args?: string;
  /** Leading shell command. Omitted keeps the stored value; blank clears it. */
  prefix?: string;
}

export interface SavePackageScriptArgsResult {
  workspacePath: string;
  /** Full per-workspace args map after the write (key kept for Mobile compatibility). */
  scriptArgs: Record<string, string>;
  /** Full per-workspace leading-command map after the write. */
  scriptPrefixes: Record<string, string>;
}

export interface RunPackageScriptRequest {
  workspacePath: string;
  script: string;
  /** Ad-hoc trailing args; when blank/omitted the saved value is used. */
  args?: string;
  /** Ad-hoc leading command; when blank/omitted the saved value is used. */
  prefix?: string;
  threadId?: string;
}

export type StartPackageScriptRequest = RunPackageScriptRequest;

export interface StartPackageScriptResult {
  script: string;
  command: string[];
  /** Human-readable run line (prefix + argv) for tabs / notifications. */
  commandLabel: string;
  sessionId: string;
  taskId: string;
}

export interface PackageScriptTerminalLaunchPayload {
  workspacePath: string;
  sessionId: string;
  script: string;
  command: string[];
  commandLabel?: string;
  taskId?: string;
}

export type BackgroundTerminalTaskStatus = "starting" | "running" | "exited" | "failed" | "stopped";

export interface BackgroundTerminalTask {
  taskId: string;
  workspacePath: string;
  command: string[];
  label: string;
  sessionId: string;
  status: BackgroundTerminalTaskStatus;
  startedAt: string;
  threadId?: string;
  exitCode?: number;
  signal?: number;
  endedAt?: string;
  output?: string;
  outputTruncated?: boolean;
}

export interface BackgroundTerminalListRequest {
  workspacePath?: string;
  threadId?: string;
}

export interface BackgroundTerminalStartRequest {
  workspacePath: string;
  command: string[];
  label?: string;
  threadId?: string;
}

export interface BackgroundTerminalOpenRequest {
  taskId: string;
}

export interface BackgroundTerminalStopRequest {
  taskId: string;
}

export interface BackgroundTerminalStopResult {
  stopped: boolean;
  task?: BackgroundTerminalTask;
}

/**
 * A live Unified Exec process owned by Codex. Runtime state comes from
 * `thread/backgroundTerminals/list`; processId and osPid are deliberately separate.
 */
export interface CodexBackgroundTerminal {
  codexThreadId: string;
  threadId: string;
  itemId: string;
  processId: string;
  workspacePath: string;
  command: string;
  osPid?: number;
  cpuPercent?: number;
  rssKb?: number;
}

export interface CodexBackgroundTerminalTerminateRequest {
  codexThreadId: string;
  processId: string;
}

export interface CodexBackgroundTerminalTerminateResult {
  terminated: boolean;
}

/** A live Claude SDK background Bash task owned by an active Query. */
export interface ClaudeBackgroundTask {
  threadId: string;
  taskId: string;
  workspacePath: string;
  label: string;
  status: "running";
  taskType: string;
}

export interface ClaudeBackgroundTaskStopRequest {
  threadId: string;
  taskId: string;
}

export interface ClaudeBackgroundTaskStopResult {
  stopped: boolean;
  mode?: "task" | "query";
}

export interface TerminalSpawnRequest {
  workspacePath: string;
  cols?: number;
  rows?: number;
}

export interface TerminalListRequest {
  workspacePath?: string;
}

/**
 * What a live PTY is running. The renderer derives the terminal tab identity from
 * this: an SSH tab must never look like a local shell tab.
 */
export type TerminalSessionKind = "local" | "command" | "ssh";

export interface TerminalSessionView {
  sessionId: string;
  workspacePath: string;
  kind: TerminalSessionKind;
  /** Tab label supplied when the PTY was spawned (SSH bookmark name). */
  label?: string;
  /** SSH endpoint (`user@host[:port]`) shown in the tab tooltip. */
  endpoint?: string;
}

export interface TerminalSpawnResult {
  sessionId: string;
}

export type {
  SshAuthType,
  SshBookmarkConnectResult,
  SshBookmarkListSnapshot,
  SshBookmarkPublic,
  SshBookmarkSaveInput,
  SshBookmarkView,
  SshKeySource,
} from "./ssh-bookmarks";

export interface SshBookmarkDeleteRequest {
  id: string;
}

export interface SshBookmarkConnectRequest {
  workspacePath: string;
  bookmarkId: string;
}

export interface TerminalInputRequest {
  sessionId: string;
  data: string;
}

export interface TerminalResizeRequest {
  sessionId: string;
  cols: number;
  rows: number;
}

export interface TerminalKillRequest {
  sessionId: string;
}

export type TerminalStreamEvent =
  | { type: "started"; sessionId: string; workspacePath: string }
  | { type: "output"; sessionId: string; data: string }
  | { type: "exit"; sessionId: string; exitCode: number; signal?: number }
  | { type: "error"; sessionId: string; message: string };

export interface WorkspaceOpenResult {
  canceled: boolean;
  workspace?: WorkspaceInfo;
}

export interface WorkspacePrepareGitRequest {
  workspacePath: string;
}

export const AGENT_ROLES = ["main", "explore", "architect", "coder", "reviewer", "tester"] as const;

export type AgentRole = (typeof AGENT_ROLES)[number];
export type RuntimeAgentRole = string;

export const SUBAGENT_ROLES = ["explore", "architect", "coder", "reviewer", "tester"] as const;

export type SubagentRole = (typeof SUBAGENT_ROLES)[number];

export type SubagentEnabledSettings = Record<SubagentRole, boolean>;

export type OrchestrationModeSetting = "autonomous" | "manual";

/** Default follow-up delivery while a run is active (Codex-style queue vs mid-turn steer). */
export type FollowUpDeliveryMode = "queue" | "steer";

export interface WorkflowSettingsSnapshot {
  sessionMode: import("./session-mode").SessionMode;
  defaultCoreKind?: import("@eco/runtime/core-runtime").CoreKind;
  /** Per-ACP-agent opt-in. Absent/false = off. */
  acpAgentsEnabled?: { cursor?: boolean };
  /** Cursor ACP model id; absent means let Cursor use its own current/default. */
  acpCursorModelId?: string;
  /** Cursor ACP API key (spawned as `CURSOR_API_KEY`); absent = use local Cursor login. */
  acpCursorApiKey?: string;
  /** When defaultCoreKind is `"acp"`, which agent (MVP: `"cursor"`). */
  defaultAcpAgentId?: "cursor";
  /** Whether Composer shows billing usage. Defaults to true for older settings. */
  showBilling?: boolean;
  /** Default execution approval mode for new sessions. Absent → `"always"`. */
  defaultBashReviewMode?: import("../../../../packages/bash-policy/src").BashReviewMode;
  contextWindowLimitTokens: number;
  maxOutputLimitTokens: import("@eco/runtime/models-dev-limits").GlobalMaxOutputTokens;
  /**
   * When a thread is running: `steer` prefers mid-turn inject (streamInput / turn/steer);
   * `queue` only enqueues for post-turn drain. Escalated / "handle now" still tries mid-turn first.
   */
  followUpDeliveryMode: FollowUpDeliveryMode;
  defaultOrchestrationSelection?: import("./agent-orchestration").OrchestrationSelection;
  defaultAuxiliaryModel?: import("./auxiliary-model").AuxiliaryModelSelection;
  defaultApprovalModel?: import("./approval-model").ApprovalModelSelection;
  defaultVisionModel?: import("./vision-model").VisionModelSelection;
  /** Last model and reasoning choice made with the built-in Codex Auth config. */
  codexAuthModel?: import("./thread-runtime-config").MainAgentModelOverride;
  mcpServersEnabled?: Record<string, boolean>;
  integrationsEnabled?: IntegrationsEnabledSettings;
}

export type {
  ImageGenerationArtifact,
  ImageGenerationArtifactListRequest,
  ImageGenerationArtifactReadRequest,
  ImageGenerationArtifactReadResult,
  ImageGenerationProfileSaveInput,
  ImageGenerationProfileSnapshot,
  ImageGenerationSettingsSaveInput,
  ImageGenerationSettingsSnapshot,
  IntegrationAvailabilitySnapshot,
  TtsArtifact,
  TtsArtifactListRequest,
  TtsArtifactReadRequest,
  TtsArtifactReadResult,
  TtsProfileSaveInput,
  TtsProfileSnapshot,
  TtsSettingsSaveInput,
  TtsSettingsSnapshot,
};

export interface GhAvailabilityView {
  available: boolean;
  authenticated: boolean;
  reason?: string;
}

export interface GitWorkingTreeStatus {
  workspacePath: string;
  isGitRepository: boolean;
  hasGitCommits: boolean;
  branch?: string;
  branches: string[];
  dirtyFileCount: number;
  insertions: number;
  deletions: number;
  canCommit: boolean;
  aheadCount: number;
  behindCount: number;
  hasUpstream: boolean;
  remoteOriginUrl?: string;
  gh: GhAvailabilityView;
}

export interface GitCheckoutBranchRequest {
  workspacePath: string;
  branch: string;
}

export interface GitCreateBranchRequest {
  workspacePath: string;
  branch: string;
}

export interface GitCommitRecord {
  sha: string;
  shortSha: string;
  subject: string;
  author: string;
  relativeDate: string;
  decorations: string[];
  tags: string[];
}

export type WorkspaceDiffFileStatus = "modified" | "untracked" | "added" | "deleted";

export interface WorkspaceDiffResult {
  workspacePath: string;
  revision?: number;
  watchError?: string;
  patch: string;
  patchTruncated: boolean;
  fileCount: number;
  files: Array<{
    path: string;
    additions: number;
    deletions: number;
    status: WorkspaceDiffFileStatus;
    revision?: number;
    previousPath?: string;
    binary?: boolean;
    originalContent: string;
    currentContent: string;
  }>;
  totalAdditions: number;
  totalDeletions: number;
}

export interface WorkspaceDiffChangedEvent {
  workspacePath: string;
  revision: number;
  changedPaths?: string[];
  error?: string;
}

export interface GitGetWorkspaceFileDiffRequest {
  workspacePath: string;
  path: string;
}

/** 图片类二进制文件的预览数据（惰性加载，随单文件 diff 返回）。 */
export interface WorkspaceFileDiffImagePreview {
  mimeType: string;
  base64: string;
  /** workingTree：当前工作区版本；head：文件已删除，回退为 HEAD 版本。 */
  source: "workingTree" | "head";
}

/** Single-file unified patch for lazy review/diff views. */
export interface WorkspaceFileDiffResult {
  path: string;
  patch: string;
  patchTruncated: boolean;
  additions: number;
  deletions: number;
  status: WorkspaceDiffFileStatus;
  /** git 判定为二进制内容，patch 中不含文本行，review 视图需特殊渲染。 */
  binary: boolean;
  /** 仅当 binary 为 true 且文件为受支持的图片类型时返回。 */
  imagePreview?: WorkspaceFileDiffImagePreview;
}

export interface GitDiscardWorkspaceChangesRequest {
  workspacePath: string;
  path?: string;
}

export interface GitDiscardWorkspaceChangesResult {
  discardedPaths: string[];
}

export interface GitListCommitsRequest {
  workspacePath: string;
  skip: number;
  limit: number;
}

export interface GitListCommitsResult {
  commits: GitCommitRecord[];
  hasMore: boolean;
}

export interface GitGenerateCommitMessageRequest {
  workspacePath: string;
  mainAgentConfigId?: string;
  includeUnstaged: boolean;
  /** Correlates streaming deltas pushed on gitGenerateCommitMessageDelta. */
  requestId?: string;
  /** @deprecated Use candidateModelId */
  role?: RuntimeAgentRole | "auto";
  candidateModelId?: string | "auto";
}

export interface GitGenerateCommitMessageDeltaPayload {
  requestId: string;
  /** Accumulated assistant text so far. */
  text: string;
}

export interface GitGenerateCommitMessageResult {
  message: string;
  candidateModelId: string;
  modelId: string;
  providerName: string;
  /** @deprecated Always "explore" for commit message generation */
  role?: RuntimeAgentRole;
}

export interface GitCommitRequest {
  workspacePath: string;
  mainAgentConfigId?: string;
  includeUnstaged: boolean;
  message?: string;
  /** @deprecated Use candidateModelId */
  role?: RuntimeAgentRole | "auto";
  candidateModelId?: string | "auto";
}

export interface GitListCommitModelOptionsRequest {
  mainAgentConfigId?: string;
}

export interface GitListCommitModelOptionsResult {
  options: CommitModelOptionView[];
  savedCandidateModelId: string | "auto";
}

export interface GitSaveCommitModelPreferenceRequest {
  candidateModelId: string;
  mainAgentConfigId?: string;
}

export interface GitSaveCommitModelPreferenceResult {
  savedCandidateModelId: string;
}

export interface CommitModelOptionView {
  id: string;
  candidateModelId: string;
  providerId: string;
  providerName: string;
  modelId: string;
  modelLabel: string;
  providerColor: string;
  hint?: CommitModelPricingHint;
}

export interface GitCommitResult {
  commitSha: string;
  message: string;
  generated: boolean;
  candidateModelId?: string;
  modelId?: string;
  /** @deprecated Always "explore" when generated */
  role?: RuntimeAgentRole;
}

export interface GitPushRequest {
  workspacePath: string;
  branch?: string;
}

export interface GitPushResult {
  method: "git" | "gh";
  output: string;
}

export interface GitFetchRequest {
  workspacePath: string;
}

export interface GitFetchResult {
  output: string;
}

export interface GitPullRequest {
  workspacePath: string;
  branch?: string;
}

export interface GitPullResult {
  output: string;
  pulled: boolean;
  conflicted: boolean;
  conflictFiles: string[];
}

export interface GitSettingsSnapshot {
  commitMessageRoleByMainAgentConfigId: Record<string, RuntimeAgentRole | "auto">;
  commitMessageCandidateModelIdByMainAgentConfigId: Record<string, string | "auto">;
  /** 生成提交信息时附加给大模型的额外指令（格式、语言、长度等） */
  commitMessageInstructions?: string;
  /** 窗口聚焦且仓库空闲时周期性 git fetch，对齐 VS Code git.autofetch */
  autofetch?: boolean;
  /** 自动 fetch 间隔（秒），默认 180 */
  autofetchPeriod?: number;
}

export interface PersonalizationSettingsSnapshot {
  /** 注入 Claude systemPrompt.append / Codex developerInstructions 的全局个人规则 */
  globalRules?: string;
}

export type {
  BrowserCloseRequest,
  BrowserFocusRequest,
  BrowserInstanceView,
  BrowserNavigateRequest,
  BrowserOpenRequest,
  BrowserRegisterGuestRequest,
  BrowserSettingsSnapshot,
  BrowserSetUiScopeRequest,
  BrowserSetVisibleRequest,
  BrowserViewState,
} from "./browser";
export type { BrowserAgentPresenceEvent } from "./browser-agent-presence";
export { BROWSER_AGENT_PRESENCE_IDLE_MS } from "./browser-agent-presence";
export type {
  ComputerUseActionApprovalMode,
  ComputerUseSettingsSnapshot,
} from "./computer-use";
export {
  defaultComputerUseSettings,
  isComputerUseSettingsSnapshot,
  normalizeComputerUseSettingsSnapshot,
} from "./computer-use";

/** Harnesses that can carry their own upstream User-Agent. */
export const UPSTREAM_AGENT_CORES = ["codex", "claude", "pi"] as const;

export type UpstreamAgentCore = (typeof UPSTREAM_AGENT_CORES)[number];

export interface ProxyBridgeSettingsSnapshot {
  /** 出站代理总开关；关闭时忽略 upstreamProxyUrl */
  enabled?: boolean;
  /** 全局覆盖：未识别 Harness 时生效；留空 = 透传 SDK User-Agent */
  upstreamUserAgent?: string;
  /** 按 Harness 单独覆盖；留空（或缺失）表示回到该项目 SDK 自己的 UA */
  upstreamUserAgents?: Partial<Record<UpstreamAgentCore, string>>;
  /** 出站 HTTP/HTTPS/SOCKS5 代理 URL（gateway upstream + 在线升级）；留空直连 */
  upstreamProxyUrl?: string;
}

export type IntegratedWebSearchProvider = "brave" | "tavily" | "doubao" | "deepseek";

export interface IntegratedWebSearchSettingsSnapshot {
  enabled: boolean;
  provider: IntegratedWebSearchProvider;
  hasApiKey: boolean;
  approvalMode: WebSearchApprovalMode;
}

export interface IntegratedWebSearchSettingsSaveInput {
  enabled?: boolean;
  provider?: IntegratedWebSearchProvider;
  approvalMode?: WebSearchApprovalMode;
  /** Empty string clears the stored key. */
  apiKey?: string;
}

export interface IntegratedWebSearchTestInput {
  provider: IntegratedWebSearchProvider;
  query: string;
}

export interface IntegratedWebSearchTestResult {
  results: Array<{ title: string; url: string; description: string }>;
  elapsedMs: number;
}

import type { AgentTemplate } from "./agent-orchestration";
import type { UpstreamApiCompat } from "./api-compat";
import type { WebSearchApprovalMode } from "./integrated-web-search";
import type { ProviderTokenCountMode } from "./provider-token-count";
import type { ThreadRuntimeConfig, ThreadRuntimeConfigInput } from "./thread-runtime-config";

export type {
  AgentInstanceConfig,
  AgentTemplate,
  EcoOrchestrationConfig,
  MainAgentConfig,
  MainAgentConfigResource,
  MainAgentPromptMode,
  MainAgentPromptResource,
  MainAgentPromptSelection,
  ModelRef,
  ModelRequirementCapability,
  ModelRequirements,
  OrchestrationSelection,
  OrchestrationStrategy,
  ResolvedOrchestrationSnapshot,
  SubagentOrchestrationResource,
  SubagentSelection,
  ToolPolicy,
} from "./agent-orchestration";
export type { ProjectMcpSettingsSnapshot } from "./composer-mcp";
export type { ProjectSkillsSettingsSnapshot } from "./composer-skills-settings";
export type { ProjectIntegrationsSettingsSnapshot } from "./integrations";
export type { ProjectOrchestrationSettingsSnapshot } from "./project-orchestration-settings";
export type { ProviderTokenCountMode, UpstreamApiCompat };

export interface ProviderConfigInput {
  id?: string;
  name: string;
  baseUrl: string;
  /** Path prefix for Anthropic-compatible API requests, e.g. `/anthropic`. */
  requestPath?: string;
  /**
   * API path version segment (e.g. `v1`). Empty/missing defaults to `v1`.
   * Forms `{baseUrl}{requestPath}/{version}/messages|responses|...`.
   */
  version?: string;
  /** Default upstream API for this provider (role routes may override). */
  apiCompat?: UpstreamApiCompat;
  /** Explicit count_tokens implementation; never inferred from apiCompat. */
  tokenCountMode?: ProviderTokenCountMode;
  /** Authentication method: API key or OAuth. */
  authMethod?: "api_key" | "oauth" | "auth_json" | "chatgpt_subscription";
  /** Local ChatGPT subscription credential pool. Never contains tokens. */
  credentialPoolId?: string;
  /** Raw auth.json content for manual authentication. */
  authJsonContent?: string;
  apiKey?: string;
  /**
   * Per-provider upstream proxy (http/https/socks5). Empty/missing means this
   * provider follows the global outbound proxy setting.
   */
  upstreamProxyUrl?: string;
  defaultModel: string;
  enabled: boolean;
}

export interface ProviderConfigView {
  id: string;
  name: string;
  baseUrl: string;
  requestPath: string;
  /** Always normalized; empty historical values surface as `v1`. */
  version: string;
  apiCompat: UpstreamApiCompat;
  tokenCountMode?: ProviderTokenCountMode;
  /** Authentication method for this provider. */
  authMethod?: "api_key" | "oauth" | "auth_json" | "chatgpt_subscription";
  credentialPoolId?: string;
  defaultModel: string;
  enabled: boolean;
  hasApiKey: boolean;
  apiKeyPreview?: string;
  /** Set only when the provider has a per-provider upstream proxy. */
  upstreamProxyUrl?: string;
  createdAt: string;
  updatedAt: string;
}

export type ProviderDeleteReferenceKind =
  | "route_profile"
  | "main_agent_config"
  | "subagent_orchestration"
  | "active_thread";

export interface ProviderDeleteReference {
  kind: ProviderDeleteReferenceKind;
  id: string;
  name: string;
}

export type ProviderDeleteResult =
  | { ok: true }
  | {
      ok: false;
      reason: "not_found" | "in_use";
      references: ProviderDeleteReference[];
    };

export type ThinkingEffort = "off" | "low" | "medium" | "high" | "xhigh" | "max";

export interface ModelsDevMapping {
  providerKey: string;
  modelId: string;
}

/** User-provided pricing/context/capabilities when models.dev is absent or should be overridden. */
export interface RouteManualSpec {
  /** Context window in tokens. */
  contextTokens?: number;
  /** Max output tokens. */
  maxOutputTokens?: number;
  /** When set, overrides models.dev multimodal detection. */
  supportsImageInput?: boolean;
  /** When set, overrides models.dev reasoning detection. */
  supportsReasoning?: boolean;
  /** When false, PI uses Integrated web search instead of provider-native pi-web-search. Default true when omitted. */
  supportsNativeWebSearch?: boolean;
  /** Opt in to Codex remote compaction (Responses compaction_trigger). Default false. */
  supportsRemoteCompaction?: boolean;
  /** USD per million input tokens. */
  inputPerM?: number;
  /** USD per million output tokens. */
  outputPerM?: number;
  cacheReadPerM?: number;
  cacheWritePerM?: number;
  /** Multiplier applied to models.dev catalog rates; default 1. */
  priceMultiplier?: number;
}

export interface CandidateModelInput {
  id?: string;
  providerId: string;
  modelId: string;
  displayName?: string;
  modelsDevMapping?: ModelsDevMapping;
  manualSpec?: RouteManualSpec;
  sortOrder?: number;
}

export interface CandidateModelView {
  id: string;
  providerId: string;
  modelId: string;
  displayName?: string;
  modelsDevMapping?: ModelsDevMapping;
  manualSpec?: RouteManualSpec;
  sortOrder: number;
  /** models.dev 实时解析后的最终有效值（不持久化） */
  resolvedContextTokens?: number;
  resolvedMaxOutputTokens?: number;
  resolvedSupportsImageInput?: boolean;
  resolvedSupportsReasoning?: boolean;
  /** Default true when manualSpec omits supportsNativeWebSearch. */
  resolvedSupportsNativeWebSearch?: boolean;
  /** Default false; only enabled explicitly on the candidate model. */
  resolvedSupportsRemoteCompaction?: boolean;
  resolvedInputPerM?: number;
  resolvedOutputPerM?: number;
  resolvedCacheReadPerM?: number;
  resolvedCacheWritePerM?: number;
  modelsDevLabel?: string;
  createdAt: string;
  updatedAt: string;
}

export interface RuntimeRoleRouteConfig {
  role: RuntimeAgentRole;
  providerId: string;
  modelId: string;
  /** Overrides provider default when set. */
  apiCompat?: UpstreamApiCompat;
  thinkingEffort?: ThinkingEffort;
  modelsDevMapping?: ModelsDevMapping;
  manualSpec?: RouteManualSpec;
  candidateModelId?: string;
}

export interface RoleRouteConfig extends RuntimeRoleRouteConfig {
  role: AgentRole;
}

export interface RouteProfileView {
  id: string;
  name: string;
  routes: RoleRouteConfig[];
  createdAt: string;
  updatedAt: string;
}

export interface RouteProfileInput {
  id?: string;
  name: string;
  routes: RoleRouteConfig[];
}

export {
  countEnabledMcpServers,
  deriveMcpServersEnabled,
  listEnabledGlobalMcpServerKeys,
} from "./composer-mcp";
export type {
  ApprovalModelSelection,
  AuxiliaryModelSelection,
  MainAgentModelOverride,
  MainAgentSystemPromptPreset,
  McpServersEnabledSettings,
  ThreadRuntimeConfig,
  ThreadRuntimeConfigInput,
  VisionModelSelection,
} from "./thread-runtime-config";
export {
  applyBusyMutableRuntimeConfigFields,
  buildAcpThreadRuntimeConfig,
  buildThreadRuntimeConfigFromDefaults,
  deriveSubagentEnabledFromSnapshot,
  hasCompleteOrchestrationSelection,
  isAskSessionMode,
  isBashReviewModeOnlyRuntimeConfigUpdate,
  isBusyMutableOnlyRuntimeConfigUpdate,
  isThreadRuntimeConfig,
  lockThreadRuntimeConfigSnapshotOnContinue,
  materializeThreadOrchestrationSnapshot,
  normalizeThreadRuntimeConfig,
  orchestrationResourceLookupFromSettings,
  resolveAcpCursorModelIdForSend,
  resolveBusyThreadRuntimeConfigUpdate,
  resolveMainAgentModelOverrideForProvider,
  resolveMainAgentSystemPromptPreset,
  resolveSessionMode,
  resolveThreadOrchestrationConfig,
  resolveThreadOrchestrationSnapshot,
  resolveThreadRuntimeMcpServerKeys,
  runtimeRoleRoutesFromOrchestrationSnapshot,
  serializeThreadRuntimeConfigForCompare,
  shouldRematerializeThreadRuntimeConfigOnContinue,
  threadRuntimeConfigsEquivalent,
  withAgentSessionMode,
} from "./thread-runtime-config";

export interface PromptImageAttachment {
  mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
  /** Base64 payload without data: URL prefix. */
  data?: string;
  /** Absolute path under Eco userData prompt-images store. */
  path?: string;
  /** Content-addressed durable reference. Local paths must never be the V2 wire identity. */
  contentRef?: string;
  /** Original byte length for bounded remote reads and integrity checks. */
  byteLength?: number;
}

export interface PromptImageStageRequest {
  contextKey: string;
  imageId: string;
  mediaType: PromptImageAttachment["mediaType"];
  data: string;
}

export interface PromptImageStageResult {
  path: string;
  contentRef: string;
  byteLength: number;
}

export interface PromptImageReleaseRequest {
  paths: string[];
}

export interface PromptImageUploadBeginRequest {
  contextKey: string;
  imageId: string;
  mediaType: PromptImageAttachment["mediaType"];
  totalBytes: number;
}

export interface PromptImageUploadBeginResult {
  path: string;
  receivedBytes: number;
  complete: boolean;
  contentRef?: string;
  byteLength?: number;
}

export interface PromptImageUploadChunkRequest {
  contextKey: string;
  imageId: string;
  mediaType: PromptImageAttachment["mediaType"];
  offset: number;
  data: string;
}

export interface PromptImageUploadChunkResult {
  receivedBytes: number;
}

export interface PromptImageUploadFinishRequest {
  contextKey: string;
  imageId: string;
  mediaType: PromptImageAttachment["mediaType"];
  totalBytes: number;
}

export interface PromptImageUploadFinishResult {
  path: string;
  contentRef: string;
  byteLength: number;
}

export interface PromptImageReadChunkRequest {
  contextKey: string;
  contentRef: string;
  mediaType: PromptImageAttachment["mediaType"];
  offset: number;
  maxBytes?: number;
}

export interface PromptImageReadChunkResult {
  contentRef: string;
  mediaType: PromptImageAttachment["mediaType"];
  offset: number;
  nextOffset: number;
  totalBytes: number;
  complete: boolean;
  data: string;
}

export interface ModelSettingsSnapshot {
  providers: ProviderConfigView[];
  routeProfiles: RouteProfileView[];
  agentTemplates: AgentTemplate[];
  mainAgentConfigs: import("./agent-orchestration").MainAgentConfigResource[];
  mainAgentPrompts: import("./agent-orchestration").MainAgentPromptResource[];
  subagentOrchestrations: import("./agent-orchestration").SubagentOrchestrationResource[];
  mcpSettings?: McpSettingsSnapshot;
}

export interface AgentTemplateExportRequest {
  templateIds?: string[];
}

export interface AgentTemplateExportResult {
  ok: true;
  canceled: boolean;
  exported: number;
  path?: string;
}

export interface AgentTemplateImportResult {
  ok: true;
  canceled: boolean;
  imported: number;
  templates: AgentTemplate[];
  errors: string[];
}

export type ThreadStatus =
  | "queued"
  | "running"
  | "blocked"
  | "awaiting_plan"
  | "idle"
  | "completed"
  | "failed";

export interface ThreadPendingPlan {
  threadId: string;
  userPrompt: string;
  analysis: string;
  plan: string;
  workspacePath: string;
  worktreePath: string;
  /** Claude Code `.claude/plans/` path (workspace-relative when possible). */
  planFilePath?: string;
  /** Exact deferred ExitPlanMode call that may complete after approval. */
  deferredExitPlanToolUseId?: string;
}

/** Approve execution of the pending plan captured from the planner. */
export interface ThreadApprovePlanRequest {
  principalId: string;
  clientCommandId: string;
  threadId: string;
  expectedHistoryRevision: number;
  /** @deprecated UI no longer edits plan text; ignored if sent. */
  plan?: string;
  /** @deprecated UI no longer edits plan text; ignored if sent. */
  analysis?: string;
  runtimeConfig?: ThreadRuntimeConfigInput;
  /**
   * Which agent executes the approved plan. Omitted (or `main`) preserves the
   * legacy main-agent execution; `subagent` forces a one-shot delegation to the
   * named role from the thread's locked orchestration snapshot.
   */
  executionTarget?: import("@eco/runtime/forced-plan-delegation").PlanExecutionTarget;
}

export interface ThreadDismissPlanRequest {
  principalId: string;
  clientCommandId: string;
  threadId: string;
  expectedHistoryRevision: number;
}

export interface ThreadSummary {
  id: string;
  title: string;
  prompt: string;
  workspacePath: string;
  status: ThreadStatus;
  createdAt: string;
  updatedAt: string;
  message: string;
  /** Live-only: user asked to stop and the run is still winding down. Never persisted. */
  cancelling?: boolean;
  /** Live-only: desktop is currently auto-generating the thread title. Never persisted. */
  titleGenerating?: boolean;
  /** Derived from the saved composer draft; never persisted on the thread itself. */
  hasComposerDraft?: boolean;
  /** Harness permanently selected for this thread after first run. */
  coreKind?: import("@eco/runtime/core-runtime").CoreKind;
  /** ACP agent under `coreKind: "acp"` (MVP: `"cursor"`). */
  acpAgentId?: import("@eco/runtime/core-runtime").AcpAgentId;
  /** Derived ACP host UI visibility; never persisted. */
  hostUiFeatures?: import("@eco/runtime/acp-host-ui-features").AcpHostUiFeatures;
  /** ISO timestamp marking the point after which coreKind cannot change. */
  coreLockedAt?: string;
  /** Claude Agent SDK session ID when resume is available. */
  sdkSessionId?: string;
  /** Worktree path used as SDK cwd when the session was created. */
  sdkCwd?: string;
  /** External runtime session ID (ACP session/new, Codex thread, PI session). */
  externalSessionId?: string;
  /** Per-thread orchestration, subagent switches, and session mode (snapshotted at start). */
  runtimeConfig?: ThreadRuntimeConfig;
  /**
   * When true, queued follow-ups are not auto-drained / mid-turn steered until the user resumes.
   * Set by the user or automatically when the thread enters failed/blocked.
   */
  followUpQueuePaused?: boolean;
}

export interface ThreadCompletionNotificationRequest {
  threadId: string;
  /** Whether this thread is selected. Native window focus is checked in main. */
  threadSelected: boolean;
}

export interface ThreadCompletionNotificationResult {
  shown: boolean;
  reason?:
    | "unsupported"
    | "invalid_request"
    | "thread_not_found"
    | "thread_not_completed"
    | "notification_content_unavailable"
    | "preference_disabled";
}

export type ThreadApprovalNotificationKind = "plan" | "bash";

export interface ThreadApprovalNotificationRequest {
  threadId: string;
  kind: ThreadApprovalNotificationKind;
  threadSelected: boolean;
}

export interface ThreadApprovalNotificationResult {
  shown: boolean;
  reason?:
    | "unsupported"
    | "invalid_request"
    | "thread_not_found"
    | "approval_not_pending"
    | "notification_content_unavailable"
    | "preference_disabled";
}

export interface ThreadClarificationNotificationRequest {
  threadId: string;
  toolUseId: string;
  threadSelected: boolean;
}

export interface ThreadClarificationNotificationResult {
  shown: boolean;
  reason?:
    | "unsupported"
    | "invalid_request"
    | "thread_not_found"
    | "clarification_not_pending"
    | "notification_content_unavailable"
    | "preference_disabled";
}

export interface ThreadStartRequest {
  workspacePath: string;
  prompt: string;
  coreKind?: import("@eco/runtime/core-runtime").CoreKind;
  attachments?: PromptImageAttachment[];
  runtimeConfig: ThreadRuntimeConfigInput;
}

export interface ThreadUpdateRuntimeConfigRequest {
  principalId: string;
  clientCommandId: string;
  threadId: string;
  runtimeConfig: ThreadRuntimeConfigInput;
  expectedHistoryRevision: number;
}

export interface ThreadStartResult {
  thread: ThreadSummary;
}

export interface ThreadContinueResult {
  thread: ThreadSummary;
}

/** Internal compatibility type retained for migration-only projection tests. */
export interface ThreadProjectionFocusReport {
  selectedThreadId?: string;
  feedThreadId?: string;
  recentlyViewedThreadIds?: string[];
}

export type ThreadUserMessageEditReasonCode =
  | "thread_not_found"
  | "thread_running"
  | "unsupported_core"
  | "missing_upstream_mapping"
  | "missing_durable_attachment"
  | "workspace_unavailable"
  | "history_changed"
  | "invalid_message"
  | "runtime_unavailable";

export interface ThreadUserMessageEditCapability {
  status: "ready" | "unavailable";
  reasonCode?: ThreadUserMessageEditReasonCode;
  reason?: string;
}

export interface ThreadUserMessageEditGetRequest {
  threadId: string;
  activityLineId: string;
}

export interface ThreadUserMessageEditGetResult {
  threadId: string;
  activityLineId: string;
  upstreamMessageId?: string;
  text: string;
  attachments: PromptImageAttachment[];
  capability: ThreadUserMessageEditCapability;
  historyRevision: number;
}

export interface ThreadRewriteFromMessageRequest {
  principalId: string;
  clientCommandId: string;
  threadId: string;
  activityLineId: string;
  prompt: string;
  attachments?: PromptImageAttachment[];
  expectedHistoryRevision: number;
  runtimeConfig?: ThreadRuntimeConfigInput;
}

export interface ThreadForkFromMessageRequest {
  principalId: string;
  clientCommandId: string;
  threadId: string;
  activityLineId: string;
  expectedHistoryRevision: number;
}

export interface ThreadForkFromMessageResult {
  thread: ThreadSummary;
  sourceThreadId: string;
  draft: { prompt: string; attachments: PromptImageAttachment[] };
}

export interface ThreadRetryFromMessageRequest {
  principalId: string;
  clientCommandId: string;
  threadId: string;
  /** Stored user-message id when available; ACP fallback may only have feed text. */
  activityLineId?: string;
  prompt: string;
  /** True when the feed user bubble showed images. Missing originals is a hard gap. */
  hasImages?: boolean;
  expectedHistoryRevision: number;
  runtimeConfig?: ThreadRuntimeConfigInput;
  /** Continue a settled Codex turn with empty app-server input. */
  continueInterrupted?: boolean;
  /** Terminal run being continued; rejects stale UI actions. */
  sourceAttemptId?: string;
}

export interface ThreadResumeSubagentRequest {
  threadId: string;
  agentId: string;
  followupTask?: string;
}

export interface ThreadResumeSubagentResult {
  thread: ThreadSummary;
  agentId: string;
  codexThreadId: string;
}

export type ThreadFollowUpStatus = "queued" | "delivered" | "applied" | "superseded" | "cancelled" | "failed";

export type ThreadFollowUpPriority = "normal" | "escalated";

export type ThreadFollowUpDeliveryMode = "queued" | "resume" | "interrupt_resume" | "streaming_push";

export type ThreadFollowUpRunPhase = "planning" | "execution" | "ask" | "continuation";

export type ThreadFollowUpBoundary = "safe_boundary" | "forced_interrupt";

export interface ThreadPendingFollowUp {
  id: string;
  threadId: string;
  prompt: string;
  attachments?: PromptImageAttachment[];
  priority: ThreadFollowUpPriority;
  status: ThreadFollowUpStatus;
  deliveryMode: ThreadFollowUpDeliveryMode;
  createdAt: string;
  updatedAt: string;
  deliveredAt?: string;
  appliedAt?: string;
  sourceRunAttemptId?: string;
  targetRunAttemptId?: string;
  queuedDuringPhase?: ThreadFollowUpRunPhase;
  deliveryBoundary?: ThreadFollowUpBoundary;
  queuePosition?: number;
  error?: string;
  /** V2 message accepted before the legacy runtime queue was created. */
  conversationMessageId?: string;
}

export interface ThreadFollowUpEnqueueRequest {
  principalId: string;
  clientCommandId: string;
  threadId: string;
  prompt: string;
  attachments?: PromptImageAttachment[];
  expectedHistoryRevision: number;
  priority?: ThreadFollowUpPriority;
  /**
   * Per-message override of the default follow-up delivery mode
   * (e.g. ⌘↩ does the opposite of the settings default).
   */
  followUpDeliveryMode?: FollowUpDeliveryMode;
}

export interface ThreadFollowUpEscalateRequest {
  principalId: string;
  clientCommandId: string;
  threadId: string;
  followUpId?: string;
  prompt?: string;
  attachments?: PromptImageAttachment[];
  expectedHistoryRevision: number;
}

export interface ThreadFollowUpCancelRequest {
  principalId: string;
  clientCommandId: string;
  threadId: string;
  followUpId: string;
  expectedHistoryRevision: number;
}

export interface ThreadFollowUpEditingRequest {
  principalId: string;
  clientCommandId: string;
  threadId: string;
  followUpId?: string;
  expectedHistoryRevision: number;
}

export interface ThreadFollowUpEditingResult {
  editing: boolean;
}

export interface ThreadFollowUpQueuePausedRequest {
  principalId: string;
  clientCommandId: string;
  threadId: string;
  paused: boolean;
  expectedHistoryRevision: number;
}

export interface ThreadFollowUpQueuePausedResult {
  paused: boolean;
  thread: ThreadSummary;
}

export interface ThreadFollowUpUpdateRequest {
  principalId: string;
  clientCommandId: string;
  threadId: string;
  followUpId: string;
  prompt: string;
  attachments?: PromptImageAttachment[];
  expectedHistoryRevision: number;
}

export interface ThreadFollowUpReorderRequest {
  principalId: string;
  clientCommandId: string;
  threadId: string;
  followUpIds: string[];
  expectedHistoryRevision: number;
}

export interface ThreadFollowUpListResult {
  followUps: ThreadPendingFollowUp[];
}

export interface ThreadFollowUpMutationResult extends ThreadFollowUpListResult {
  followUp: ThreadPendingFollowUp;
}

export interface ThreadDeleteResult {
  ok: true;
  alreadyDeleted: boolean;
}

export interface ThreadDeleteRequest {
  principalId: string;
  clientCommandId: string;
  threadId: string;
  expectedHistoryRevision: number;
}

export interface ComposerDraftRecord {
  contextKey: string;
  prompt: string;
  attachments?: PromptImageAttachment[];
  /** Present only for a recoverable runtime failure, not an ordinary unsent draft. */
  recoveryReason?: string;
  /** Opaque compare-and-delete token; never infer it from updatedAt. */
  revision: string;
  updatedAt: string;
}

export interface ComposerDraftSaveRequest {
  contextKey: string;
  prompt: string;
  attachments?: PromptImageAttachment[];
  recoveryReason?: string;
}

export interface ComposerDraftDeleteRequest {
  contextKey: string;
  /** Delete only when this exact opaque draft revision is still current. */
  expectedRevision?: string;
  /**
   * When false, keep staged prompt-image spool files (send handoff).
   * Default true: abandoning a draft also releases its images.
   */
  releaseAttachments?: boolean;
}

export interface ComposerDraftDeleteResult {
  ok: true;
  deleted: boolean;
}

export interface ThreadRollbackResult {
  ok: true;
  revertedThreads: number;
  files: string[];
  message: string;
}

export type WorktreeCancelDisposition = "apply" | "keep" | "discard";

export interface ThreadCancelRequest {
  principalId: string;
  clientCommandId: string;
  threadId: string;
  expectedHistoryRevision: number;
  worktreeDisposition?: WorktreeCancelDisposition;
}

export type CoderTodoStatus = "pending" | "running" | "completed" | "blocked" | "cancelled";

export interface CoderTodoItem {
  id: string;
  threadId: string;
  title: string;
  detail: string;
  status: CoderTodoStatus;
  position: number;
  updatedAt: string;
}

export interface WorktreeStatusResult {
  exists: boolean;
  worktreePath: string;
  workspacePath: string;
  changedFiles: string[];
}

export interface WorktreeApplyResult {
  ok: true;
  files: string[];
  message: string;
}

export interface ThreadAppliedDiffFileStat {
  path: string;
  additions: number;
  deletions: number;
}

export interface ThreadAppliedDiffResult {
  diff: string;
  files: string[];
  fileStats: ThreadAppliedDiffFileStat[];
  totalAdditions: number;
  totalDeletions: number;
  rolledBackAt?: string;
}

export interface ThreadRevertAppliedDiffResult {
  ok: true;
  files: string[];
  message: string;
}

export interface ClarificationQuestionOption {
  label: string;
  description?: string;
  /** Matches AskUserQuestion option hint; shown as （推荐） in UI */
  recommended?: boolean;
}

export interface ClarificationQuestion {
  question: string;
  header?: string;
  options: ClarificationQuestionOption[];
  multiSelect?: boolean;
  allowCustom?: boolean;
  preserveCustomText?: boolean;
}

export interface ClarificationRequest {
  toolUseId: string;
  threadId: string;
  questions: ClarificationQuestion[];
  /**
   * Codex 0.153+ async user input: turn continues while Eco shows the panel.
   * Omitted / "sync" = blocking `item/tool/requestUserInput`.
   */
  delivery?: "sync" | "async";
}

/** selections[i] = chosen option labels for question i */
export interface ClarificationAnswers {
  toolUseId: string;
  selections: string[][];
  customInputIndices?: number[];
}

export interface ClarificationSubmitPayload {
  principalId: string;
  clientCommandId: string;
  threadId: string;
  toolUseId: string;
  selections: string[][];
  customInputIndices?: number[];
  expectedHistoryRevision: number;
}

export interface ClarificationDismissPayload {
  principalId: string;
  clientCommandId: string;
  threadId: string;
  toolUseId: string;
  expectedHistoryRevision: number;
}

/**
 * What happened to an async answer after it was recorded.
 *
 * The answer is persisted first, so a submission is never lost; this reports only
 * whether the Codex run actually received it. `unknown` means we cannot tell —
 * the UI must keep the answer on screen and must not resend on its own.
 */
export interface ClarificationAsyncDelivery {
  state: "delivered" | "queued" | "unknown";
  /** Follow-up row carrying the answer, when one was created. */
  followUpId?: string;
  /** Queued conversation message the follow-up row points at. */
  followUpMessageId?: string;
  /** Human-readable reason for `unknown` / `queued`. */
  message?: string;
}

/**
 * Result of answering or dismissing a question.
 *
 * `delivery` is present only for async questions: a blocking `item/tool/requestUserInput`
 * RPC is answered by the response itself, so there is nothing to confirm separately.
 */
export interface ClarificationSubmitResult {
  ok: true;
  delivery?: ClarificationAsyncDelivery;
}

export type BashApprovalKind = "command" | "file_change" | "network" | "image_generation" | "mcp";

export interface BashApprovalNetworkPolicyAmendment {
  host: string;
  action: "allow" | "deny";
}

export interface BashApprovalRequest {
  mcpToolApproval?: import("./mcp").McpToolApprovalTarget;
  defaultToNo?: boolean;
  suppressAlwaysAllowRule?: boolean;
  mcpServer?: { name: string; source: string };
  toolUseId: string;
  threadId: string;
  command: string;
  cwd: string;
  reason: string;
  riskScore: number;
  riskLevel: "low" | "medium" | "high" | "critical";
  agentId: string;
  agentType?: string;
  description?: string;
  /** Auxiliary-model explanation, kept separate from the original approval request. */
  reviewRationale?: string;
  kind?: BashApprovalKind;
  /** When set, this approval is for a filesystem tool outside the workspace. */
  filesystemTool?: string;
  filesystemPath?: string;
  proposedExecpolicyAmendment?: string[];
  proposedNetworkPolicyAmendments?: BashApprovalNetworkPolicyAmendment[];
}

export type BashApprovalDecision =
  | "approved"
  | "approved_remember_prefix"
  | "approved_remember_mcp_tool"
  | "approved_for_session"
  | "approved_execpolicy_amendment"
  | "approved_network_policy_amendment"
  | "denied"
  | "cancelled";

export interface BashApprovalResolvePayload {
  principalId: string;
  clientCommandId: string;
  threadId: string;
  toolUseId: string;
  decision: BashApprovalDecision;
  /** When denying, optional instructions for Eco on how to adjust. */
  feedback?: string;
  expectedHistoryRevision: number;
}

/** Result of `bash-approval:resolve`. `alreadyResolved` is true when the tool use was already gone (idempotent). */
export interface BashApprovalResolveResult {
  ok: true;
  alreadyResolved?: boolean;
}

export interface PlanApprovalRequest {
  toolUseId: string;
  threadId: string;
  userPrompt: string;
  analysis: string;
  plan: string;
  planFilePath?: string;
}

export type PlanApprovalDecision = "approved" | "denied";

export type ContextSegmentKey =
  | "systemPrompt"
  | "toolDefinitions"
  | "rules"
  | "skills"
  | "mcp"
  | "subagentDefinitions"
  | "conversation"
  | "unattributed";

export interface ContextBreakdownSegment {
  key: ContextSegmentKey;
  label: string;
  tokens: number;
  color: string;
}

export interface ThreadRoleContextSnapshot {
  role: RuntimeAgentRole;
  occupied: number;
  limit: number;
  occupancyPct: number;
  limitsResolved: boolean;
  modelId?: string;
  segments: ContextBreakdownSegment[];
  maxOutputTokens?: number;
}

export interface ThreadContextInstanceSnapshot {
  agentId: string;
  role: RuntimeAgentRole;
  occupied: number;
  limit: number;
  occupancyPct: number;
  limitsResolved: boolean;
  modelId?: string;
  segments: ContextBreakdownSegment[];
  maxOutputTokens?: number;
  updatedAt: number;
}

export interface ThreadContextSnapshot {
  occupied: number;
  limit: number;
  occupancyPct: number;
  limitsResolved: boolean;
  /** Which agent role/key's session fill is shown. */
  displayRole?: RuntimeAgentRole;
  modelId?: string;
  segments: ContextBreakdownSegment[];
  roles?: ThreadRoleContextSnapshot[];
  instances?: ThreadContextInstanceSnapshot[];
  updatedAt: number;
  maxOutputTokens?: number;
}

export interface ThreadUsageSnapshot {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  contextTokens: number;
  contextLimit?: number;
  occupancyPct?: number;
  modelId?: string;
}

export interface ThreadModelUsageEntry {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd?: number;
  thinkingTokens?: number;
  costBasis?: "list" | "managed" | "unknown";
}

export type BillingUsageSource = "proxy" | "sdk" | "codex" | "pi";

export interface TokenCostBreakdown {
  inputUsd: number;
  outputUsd: number;
  cacheReadUsd: number;
  cacheCreationUsd: number;
  totalUsd: number;
}

export interface ThreadBillingModelSnapshot {
  modelId: string;
  roles: RuntimeAgentRole[];
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  ecoCostUsd: number;
  /** Cost reported by the source itself, when available (SDK estimate). */
  reportedCostUsd?: number;
}

export interface ThreadBillingSourceSnapshot {
  source: BillingUsageSource;
  totalTokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheCreation: number;
  };
  plannerTokenCostUsd: number;
  ecoCostUsd: number;
  /** Cost reported by the source itself, when available (SDK estimate). */
  reportedCostUsd?: number;
  pricingResolved: boolean;
  byModel?: ThreadBillingModelSnapshot[];
  byRole?: Partial<
    Record<
      RuntimeAgentRole,
      {
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens: number;
        cacheCreationTokens: number;
        ecoCostUsd: number;
        modelId?: string;
      }
    >
  >;
}

export interface ThreadSubagentBillingSnapshot {
  agentId: string;
  role: RuntimeAgentRole;
  status: "active" | "stopped";
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  contextOccupied: number;
  contextLimit?: number;
  ecoCostUsd: number;
  ecoCostBreakdown?: TokenCostBreakdown;
  modelId?: string;
}

export type ThreadBillingDiagnosticSeverity = "info" | "warning" | "error";

export type ThreadBillingDiagnosticType =
  | "pricing_unresolved"
  | "projection_missing"
  | "primary_source_mismatch"
  | "token_mismatch"
  | "cost_mismatch"
  | "subagent_metrics_mismatch"
  | "unattributed_usage"
  | "unresolved_usage"
  | "pending_attribution"
  | "shadow_reconciliation";

export interface ThreadBillingDiagnostic {
  type: ThreadBillingDiagnosticType;
  severity: ThreadBillingDiagnosticSeverity;
  message: string;
  source?: BillingUsageSource;
  agentId?: string;
  field?: string;
  delta?: number;
  count?: number;
}

export interface ThreadBillingSnapshot {
  totalTokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheCreation: number;
  };
  sourceReportedCostUsd: number;
  plannerTokenCostUsd: number;
  ecoCostUsd: number;
  savedUsd: number;
  savedPct: number;
  ecoCostBreakdown?: TokenCostBreakdown;
  plannerCostBreakdown?: TokenCostBreakdown;
  plannerModelLabel?: string;
  pricingResolved: boolean;
  /** Primary source used for settlement and validation; SDK-first when present. */
  primarySource?: BillingUsageSource;
  /** Headline totals shown in UI; uses proxy while running, otherwise matches primarySource. */
  displaySource?: BillingUsageSource;
  sourceBreakdown?: Partial<Record<BillingUsageSource, ThreadBillingSourceSnapshot>>;
  byModel?: ThreadBillingModelSnapshot[];
  byRole?: Partial<
    Record<
      RuntimeAgentRole,
      {
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens: number;
        cacheCreationTokens: number;
        ecoCostUsd: number;
        modelId?: string;
      }
    >
  >;
  subagents?: ThreadSubagentBillingSnapshot[];
  diagnostics?: ThreadBillingDiagnostic[];
}

export interface ThreadSessionBootstrapResult {
  thread?: ThreadSummary;
  followUps: ThreadPendingFollowUp[];
  pendingPlan?: ThreadPendingPlan;
  pendingBash?: BashApprovalRequest;
  pendingClarification?: ClarificationRequest;
}

export interface RoutePricingRates {
  inputPerM: number;
  outputPerM: number;
  cacheReadPerM?: number;
  cacheWritePerM?: number;
}

export interface RoutePricingHint {
  role: RuntimeAgentRole;
  modelId: string;
  providerName: string;
  /** models.dev 参考单价（每百万 token，USD） */
  rates?: RoutePricingRates;
  /** catalog 原始单价，用于手动覆盖面板的「自动」提示 */
  catalogRates?: RoutePricingRates;
  /** 完整说明，用于悬停提示 */
  pricingLabel?: string;
  pricingResolved: boolean;
}

export interface CommitModelPricingHint {
  candidateModelId: string;
  modelId: string;
  providerName: string;
  rates?: RoutePricingRates;
  catalogRates?: RoutePricingRates;
  pricingLabel?: string;
  pricingResolved: boolean;
}

export interface RouteCapabilityHint {
  role: RuntimeAgentRole;
  modelId: string;
  providerName: string;
  supportsImageInput: boolean;
  supportsReasoning: boolean;
  /** PI provider-native web search; default true when omitted from manualSpec. */
  supportsNativeWebSearch?: boolean;
  /** Codex remote compaction; default false when omitted from manualSpec. */
  supportsRemoteCompaction?: boolean;
  capabilitiesResolved: boolean;
  contextTokens?: number;
  maxOutputTokens?: number;
  contextLimitResolved: boolean;
  /** catalog 原始能力，用于手动覆盖面板的「自动」提示 */
  catalogSupportsImageInput?: boolean;
  catalogSupportsReasoning?: boolean;
  catalogContextTokens?: number;
  catalogMaxOutputTokens?: number;
  modelsDevMapping?: ModelsDevMapping;
  modelsDevLabel?: string;
  /** 自动匹配命中的 models.dev 模型（非手动映射） */
  resolvedModelsDevMapping?: ModelsDevMapping;
  resolvedModelsDevLabel?: string;
}

export interface ModelsDevModelOption {
  providerKey: string;
  modelId: string;
  displayName: string;
}

export interface ThreadSubagentSessionTiming {
  agentId: string;
  role: RuntimeAgentRole;
  phase?: "planning" | "execution" | "ask";
  status: "active" | "stopped" | "handed_off";
  startedAt: string;
  lastActiveAt: string;
  endedAt?: string;
  accumulatedMs: number;
  /** Active processing duration (accumulated + current segment when active). */
  durationMs: number;
}

export interface ThreadSubagentMetricsSummary {
  agentId: string;
  role: RuntimeAgentRole;
  status: "active" | "stopped";
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  contextOccupied: number;
  contextLimit?: number;
  ecoCostUsd: number;
  modelId?: string;
  lastRequestKey?: string;
  ecoCostBreakdown?: TokenCostBreakdown;
}

export interface ThreadLiveEvent {
  threadId: string;
  type: string;
  message: string;
  /** Live-only overlay mirrored from the main-process cancelling set. */
  cancelling?: boolean;
  title?: string;
  /** Whether an auxiliary model is currently generating this thread's title. */
  titleGenerating?: boolean;
  role?: RuntimeAgentRole | "system" | "thinking" | "tool" | "user";
  stream?: boolean;
  /** Set when the main process persisted this event in the durable V2 activity source. */
  activityLine?: ThreadActivityLine;
  plan?: Pick<ThreadPendingPlan, "analysis" | "plan" | "userPrompt" | "planFilePath">;
  planApproval?: PlanApprovalRequest;
  clarification?: ClarificationRequest;
  bashApproval?: BashApprovalRequest;
  followUp?: ThreadPendingFollowUp;
  usage?: ThreadUsageSnapshot;
  modelId?: string;
  /** Cumulative SDK-estimated cost across all query() calls in this thread. */
  totalCostUsd?: number;
  modelUsage?: Record<string, ThreadModelUsageEntry>;
  billing?: ThreadBillingSnapshot;
  context?: ThreadContextSnapshot;
  projection?: ThreadRunProjectionSnapshot;
  subagentSessions?: ThreadSubagentSessionTiming[];
  apiError?: ThreadApiErrorInfo;
  runtimeConfig?: ThreadRuntimeConfig;
  /**
   * Content digest of global model + workflow settings (see settings:digest).
   * Present on `settings.updated` so clients can skip a full pull when unchanged.
   */
  settingsDigest?: string;
  /** ACP/Codex/PI session id captured for resume; patches ThreadSummary.externalSessionId. */
  externalSessionId?: string;
  tool?: ThreadRunToolMetadata;
  /** Restore composer after a zero-output ACP start failure discarded the turn. */
  composerRestore?: {
    prompt: string;
    attachments?: PromptImageAttachment[];
    /** Opaque revision used for compare-and-delete acknowledgement. */
    revision?: string;
  };
  /**
   * When set, patches ThreadSummary.prompt (e.g. clear after unstarted first-turn discard
   * so the Feed does not re-show the prompt via showThreadPrompt).
   */
  threadPrompt?: string;
  /** Present when follow-up auto-drain pause state changes (or on failed/blocked). */
  followUpQueuePaused?: boolean;
}

export interface ThreadApiErrorInfo {
  statusCode?: number;
  code?: string;
  message: string;
  model?: string;
  codexErrorInfo?: unknown;
  additionalDetails?: string;
  rawTurnError?: unknown;
  param?: string;
  logicalRequestId?: string;
  providerRequestId?: string;
  responseId?: string;
  accountId?: string;
  threadId?: string;
  turnId?: string;
  runAttemptId?: string;
}

export interface ThreadActivityLine {
  id: string;
  role: string;
  message: string;
  stream?: boolean;
  /** SDK-backed target that can be used to fork from this user message. */
  rewindTarget?: ThreadActivityRewindTarget;
  /** Sub-agent instance id (SDK session_id / SubagentStart agent_id). */
  agentId?: string;
  /** Structured API failure from OTLP api_error event (not parsed from stream text). */
  apiError?: ThreadApiErrorInfo;
}

export interface ThreadUsageLedgerEventView {
  id: string;
  source: BillingUsageSource;
  role: RuntimeAgentRole;
  routeRole: RuntimeAgentRole;
  billingRole: RuntimeAgentRole;
  modelId?: string;
  aliasModelId?: string;
  providerId?: string;
  agentId?: string;
  requestKey?: string;
  providerRequestId?: string;
  attributionStatus: "attributed" | "pending" | "unattributed";
  attributionReason?: string;
  usageKind: "request_final" | "request_partial" | "assistant_fallback" | "context" | "session_total";
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  reasoningTokens?: number;
  /** Gateway-measured time to first content token (ms), when known. */
  ttftMs?: number;
  /** Gateway-measured first-chunk → stream-end window (ms, new-api generationMs). */
  generationMs?: number;
  /** Gateway-measured network RTT estimate (ms): upstream start → first headers. */
  firstHeadersMs?: number;
  /** Gateway-measured time to first text token delta (ms): upstream start → first content token. */
  firstTokenMs?: number;
  /** Feed logical request id — joins multi-invocation rows onto one span. */
  logicalRequestId?: string;
  /** Client-side request span start (fallback timing for rows without gateway timing). */
  spanStartedAt?: string;
  /** Client-side first narrative delta time (fallback timing). */
  spanFirstTokenAt?: string;
  /** Client-side request span end (fallback timing). */
  spanEndedAt?: string;
  ecoCostUsd?: number;
  reportedCostUsd?: number;
  pricingResolved?: boolean;
  observedAt: string;
}

export interface ThreadActivityRewindTarget {
  activityLineId: string;
  /** Current provider message id. Deprecated for new edit RPCs; server resolves it. */
  userMessageId?: string;
}

export function isGitGenerateCommitMessageRequest(value: unknown): value is GitGenerateCommitMessageRequest {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.workspacePath === "string" &&
    typeof record.includeUnstaged === "boolean" &&
    (record.mainAgentConfigId === undefined || typeof record.mainAgentConfigId === "string")
  );
}

export function parseGitListCommitModelOptionsRequest(value: unknown): GitListCommitModelOptionsRequest {
  if (!value || typeof value !== "object") {
    throw new Error("Invalid git list commit model options request.");
  }
  const record = value as Record<string, unknown>;
  const mainAgentConfigId =
    typeof record.mainAgentConfigId === "string" ? record.mainAgentConfigId.trim() : "";
  return mainAgentConfigId ? { mainAgentConfigId } : {};
}

export function isGitListCommitModelOptionsRequest(
  value: unknown,
): value is GitListCommitModelOptionsRequest {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return record.mainAgentConfigId === undefined || typeof record.mainAgentConfigId === "string";
}

export function parseGitSaveCommitModelPreferenceRequest(
  value: unknown,
): GitSaveCommitModelPreferenceRequest {
  if (!value || typeof value !== "object") {
    throw new Error("Invalid git save commit model preference request.");
  }
  const record = value as Record<string, unknown>;
  const candidateModelId = typeof record.candidateModelId === "string" ? record.candidateModelId.trim() : "";
  if (!candidateModelId || candidateModelId === "auto") {
    throw new Error("Invalid git save commit model preference request.");
  }
  const mainAgentConfigId =
    typeof record.mainAgentConfigId === "string" ? record.mainAgentConfigId.trim() : "";
  return mainAgentConfigId ? { candidateModelId, mainAgentConfigId } : { candidateModelId };
}

export function isGitSaveCommitModelPreferenceRequest(
  value: unknown,
): value is GitSaveCommitModelPreferenceRequest {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.candidateModelId !== "string" || !record.candidateModelId.trim()) {
    return false;
  }
  return record.mainAgentConfigId === undefined || typeof record.mainAgentConfigId === "string";
}

export function isGitListCommitsRequest(value: unknown): value is GitListCommitsRequest {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.workspacePath === "string" &&
    typeof record.skip === "number" &&
    Number.isFinite(record.skip) &&
    typeof record.limit === "number" &&
    Number.isFinite(record.limit) &&
    record.limit > 0
  );
}

export function isGitCommitRequest(value: unknown): value is GitCommitRequest {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.workspacePath === "string" &&
    typeof record.includeUnstaged === "boolean" &&
    (record.mainAgentConfigId === undefined || typeof record.mainAgentConfigId === "string")
  );
}

export function isGitPushRequest(value: unknown): value is GitPushRequest {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record.workspacePath === "string";
}

export function isGitFetchRequest(value: unknown): value is GitFetchRequest {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record.workspacePath === "string";
}

export function isGitPullRequest(value: unknown): value is GitPullRequest {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record.workspacePath === "string";
}

export function isRunPackageScriptRequest(value: unknown): value is RunPackageScriptRequest {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.workspacePath === "string" &&
    typeof record.script === "string" &&
    (record.args === undefined || typeof record.args === "string") &&
    (record.prefix === undefined || typeof record.prefix === "string") &&
    (record.threadId === undefined || typeof record.threadId === "string")
  );
}

export function isSavePackageScriptArgsRequest(value: unknown): value is SavePackageScriptArgsRequest {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.workspacePath === "string" &&
    typeof record.script === "string" &&
    (record.args === undefined || typeof record.args === "string") &&
    (record.prefix === undefined || typeof record.prefix === "string")
  );
}

export function isPackageScriptTerminalLaunchPayload(
  value: unknown,
): value is PackageScriptTerminalLaunchPayload {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.workspacePath === "string" &&
    typeof record.sessionId === "string" &&
    typeof record.script === "string" &&
    (record.taskId === undefined || typeof record.taskId === "string") &&
    (record.commandLabel === undefined || typeof record.commandLabel === "string") &&
    Array.isArray(record.command) &&
    record.command.every((entry) => typeof entry === "string")
  );
}

export function isBackgroundTerminalListRequest(value: unknown): value is BackgroundTerminalListRequest {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    (record.workspacePath === undefined || typeof record.workspacePath === "string") &&
    (record.threadId === undefined || typeof record.threadId === "string")
  );
}

export function isBackgroundTerminalStartRequest(value: unknown): value is BackgroundTerminalStartRequest {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.workspacePath === "string" &&
    Array.isArray(record.command) &&
    record.command.length > 0 &&
    record.command.every((entry) => typeof entry === "string") &&
    (record.label === undefined || typeof record.label === "string") &&
    (record.threadId === undefined || typeof record.threadId === "string")
  );
}

export function isBackgroundTerminalOpenRequest(value: unknown): value is BackgroundTerminalOpenRequest {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record.taskId === "string";
}

export function isBackgroundTerminalStopRequest(value: unknown): value is BackgroundTerminalStopRequest {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record.taskId === "string";
}

export function isCodexBackgroundTerminalTerminateRequest(
  value: unknown,
): value is CodexBackgroundTerminalTerminateRequest {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.codexThreadId === "string" &&
    Boolean(record.codexThreadId.trim()) &&
    typeof record.processId === "string" &&
    Boolean(record.processId.trim())
  );
}

export function isClaudeBackgroundTaskStopRequest(
  value: unknown,
): value is ClaudeBackgroundTaskStopRequest {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.threadId === "string" &&
    Boolean(record.threadId.trim()) &&
    typeof record.taskId === "string" &&
    Boolean(record.taskId.trim())
  );
}

export function isTerminalSpawnRequest(value: unknown): value is TerminalSpawnRequest {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.workspacePath === "string" &&
    (record.cols === undefined || typeof record.cols === "number") &&
    (record.rows === undefined || typeof record.rows === "number")
  );
}

export function isSshBookmarkSaveInput(
  value: unknown,
): value is import("./ssh-bookmarks").SshBookmarkSaveInput {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.name === "string" &&
    typeof record.host === "string" &&
    typeof record.username === "string" &&
    (record.authType === "password" || record.authType === "key") &&
    (record.id === undefined || typeof record.id === "string") &&
    (record.port === undefined || typeof record.port === "number") &&
    (record.keySource === undefined || record.keySource === "path" || record.keySource === "stored") &&
    (record.keyPath === undefined || typeof record.keyPath === "string") &&
    (record.password === undefined || typeof record.password === "string") &&
    (record.storedKey === undefined || typeof record.storedKey === "string") &&
    (record.extraArgs === undefined || typeof record.extraArgs === "string")
  );
}

export function isSshBookmarkDeleteRequest(value: unknown): value is SshBookmarkDeleteRequest {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record.id === "string" && record.id.trim().length > 0;
}

export function isSshBookmarkConnectRequest(value: unknown): value is SshBookmarkConnectRequest {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record.workspacePath === "string" && typeof record.bookmarkId === "string";
}

export function isTerminalListRequest(value: unknown): value is TerminalListRequest {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return record.workspacePath === undefined || typeof record.workspacePath === "string";
}

export function isTerminalInputRequest(value: unknown): value is TerminalInputRequest {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record.sessionId === "string" && typeof record.data === "string";
}

export function isTerminalResizeRequest(value: unknown): value is TerminalResizeRequest {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.sessionId === "string" && typeof record.cols === "number" && typeof record.rows === "number"
  );
}

export function isTerminalKillRequest(value: unknown): value is TerminalKillRequest {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record.sessionId === "string";
}

export function isTerminalStreamEvent(value: unknown): value is TerminalStreamEvent {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (record.type === "started") {
    return typeof record.sessionId === "string" && typeof record.workspacePath === "string";
  }
  if (record.type === "output") {
    return typeof record.sessionId === "string" && typeof record.data === "string";
  }
  if (record.type === "exit") {
    return typeof record.sessionId === "string" && typeof record.exitCode === "number";
  }
  if (record.type === "error") {
    return typeof record.sessionId === "string" && typeof record.message === "string";
  }
  return false;
}

export type {
  StorageCategoryId,
  StorageCategoryUsage,
  StorageCleanupAction,
  StorageCleanupOlderThanUnit,
  StorageCleanupRequest,
  StorageCleanupResult,
  StorageUnmeteredId,
  StorageUnmeteredItem,
  StorageUsageSnapshot,
} from "./storage-usage";

export function isStorageCleanupRequest(
  value: unknown,
): value is import("./storage-usage").StorageCleanupRequest {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  const action = record.action;
  if (
    action !== "clearLogs" &&
    action !== "clearCodexHomeCaches" &&
    action !== "clearClaudeSessions" &&
    action !== "clearPiAgent" &&
    action !== "clearOldConversations" &&
    action !== "clearAllConversations" &&
    action !== "vacuumDatabase"
  ) {
    return false;
  }
  if (record.options === undefined) {
    return action !== "clearOldConversations";
  }
  if (!record.options || typeof record.options !== "object") {
    return false;
  }
  const options = record.options as Record<string, unknown>;
  if (
    options.olderThanDays !== undefined &&
    (typeof options.olderThanDays !== "number" || !Number.isFinite(options.olderThanDays))
  ) {
    return false;
  }
  if (options.olderThanValue !== undefined) {
    if (typeof options.olderThanValue !== "number" || !Number.isFinite(options.olderThanValue)) {
      return false;
    }
  }
  if (options.olderThanUnit !== undefined) {
    if (options.olderThanUnit !== "hours" && options.olderThanUnit !== "days") {
      return false;
    }
  }
  if (options.orphansOnly !== undefined && typeof options.orphansOnly !== "boolean") {
    return false;
  }
  if (action === "clearOldConversations") {
    const valueOk =
      typeof options.olderThanValue === "number" &&
      Number.isFinite(options.olderThanValue) &&
      options.olderThanValue > 0;
    const unitOk = options.olderThanUnit === "hours" || options.olderThanUnit === "days";
    if (!valueOk || !unitOk) {
      return false;
    }
  }
  return true;
}

export type { BrowserSetViewportRequest } from "./browser-viewport";
