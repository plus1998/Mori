import type { AccountUsageHistory, AccountUsageQuery, UsageOverview, UsageOverviewQuery } from "../shared/account-usage";
import type { GenerationToolRequest } from "../shared/generation-tools";
import type { ImageGenerationToolInput } from "../shared/image-generation";
import type { TtsToolInput } from "../shared/tts";
import type { ProjectTodo, ProjectTodoCompose, ProjectTodoSave, ProjectTodoTrash } from "../shared/project-todos";
import type { ReadAloudSettingsInput, ReadAloudSettingsSnapshot, ReadAloudStatus, ReadAloudStartInput, ReadAloudStartResult, ReadAloudSegmentInput, ReadAloudSegmentResult, ReadAloudReadInput, ReadAloudReadResult } from "../shared/tts";
import type { TtsArtifact, TtsArtifactReadRequest, TtsArtifactReadResult, TtsProfileSaveInput, TtsProfileSnapshot, TtsSettingsSnapshot } from "../shared/tts";
import type { ScheduleCreateInput, ScheduleUpdateInput, ScheduleTrigger, ScheduleDefinition, ScheduleOccurrence, SchedulingSnapshot } from "../shared/scheduling";
import type {
  ConversationBootstrap,
  ConversationCapabilities,
  ConversationDetailItem,
  ConversationDetailsPage,
  ConversationHead,
  ConversationMessage,
  ConversationMessagesPage,
  ConversationRun,
  ConversationSendMessageResult,
  ConversationSyncPage,
  ConversationToolsPage,
} from "@eco/shared";
import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { DesktopUpdateState } from "../shared/desktop-update";
import type {
  OpenAIAccount,
  OpenAIAccountAssistantAction,
  OpenAIAccountAssistantActionResult,
  OpenAIAccountAssistantState,
  OpenAIAccountCreateInput,
  OpenAIAccountDetails,
  OpenAIAccountImportResult,
  OpenAIAccountQuota,
  OpenAIAccountImageQuota,
  OpenAIAccountSyncStatus,
  OpenAIAccountUpdateInput,
} from "../shared/openai-account";
import type { SupabaseDeploymentConnection, SupabaseDeploymentSnapshot } from "../shared/supabase-deployment";
import {
  type AddCodexCatalogModelRequest,
  type AgentTemplate,
  type AgentTemplateExportRequest,
  type AgentTemplateExportResult,
  type AgentTemplateImportResult,
  type AppMenuCommand,
  type AsrInputDeviceSaveInput,
  type AsrProfileActivateRequest,
  type AsrProfileDeleteRequest,
  type AsrProfileSaveInput,
  type AsrProfileSnapshot,
  type AsrProfilesSnapshot,
  type AsrSettingsInput,
  type AsrSettingsSnapshot,
  type AsrTranscribeRequest,
  type AsrTranscribeResult,
  type BackgroundTerminalListRequest,
  type BackgroundTerminalOpenRequest,
  type BackgroundTerminalStartRequest,
  type BackgroundTerminalStopRequest,
  type BackgroundTerminalStopResult,
  type BackgroundTerminalTask,
  type BashApprovalRequest,
  type BashApprovalResolvePayload,
  type BrowserAgentPresenceEvent,
  type BrowserCloseRequest,
  type BrowserFocusRequest,
  type BrowserNavigateRequest,
  type BrowserOpenRequest,
  type BrowserRegisterGuestRequest,
  type BrowserSettingsSnapshot,
  type BrowserSetUiScopeRequest,
  type BrowserSetVisibleRequest,
  type BrowserSetViewportRequest,
  type BrowserViewState,
  type CandidateModelInput,
  type CandidateModelView,
  type CenterServerAccountAuthResult,
  type CenterServerApproveVaultClaimResult,
  type CenterServerCreatePairingResult,
  type CenterServerDeviceBindingView,
  type CenterServerDevicePresenceView,
  type CenterServerRegisterDesktopRequest,
  type CenterServerRegisterDesktopResult,
  type CenterServerRemoveConnectionOptions,
  type CenterServerRemoveConnectionResult,
  type CenterServerRequestVaultClaimResult,
  type CenterServerSettingsInput,
  type CenterServerSettingsSnapshot,
  type CenterServerSignInRequest,
  type CenterServerSignUpRequest,
  type CenterServerSubmitVaultClaimCodeResult,
  type CenterServerSyncConfigResult,
  type CenterServerSyncDomain,
  type CenterServerSyncDomainResult,
  type CenterServerSyncStatusSnapshot,
  type CenterServerTestConnectionRequest,
  type CenterServerTestConnectionResult,
  type CenterServerVaultClaimView,
  type CenterServerVaultStatus,
  type ClarificationDismissPayload,
  type ClarificationRequest,
  type ClarificationSubmitPayload,
  type ClarificationSubmitResult,
  type ClipboardReadImageResult,
  type ClipboardWriteImageRequest,
  type CodexBackgroundTerminal,
  type CodexBackgroundTerminalTerminateRequest,
  type CodexBackgroundTerminalTerminateResult,
  type ClaudeBackgroundTask,
  type ClaudeBackgroundTaskStopRequest,
  type ClaudeBackgroundTaskStopResult,
  type CodexModelCatalogSnapshot,
  type ComposerDraftDeleteRequest,
  type ComposerDraftDeleteResult,
  type ComposerDraftRecord,
  type ComposerDraftSaveRequest,
  type ConversationV2ProjectionExtras,
  type CoreAvailabilitySnapshot,
  type CursorAgentsListResult,
  type CursorModelOption,
  type GitCheckoutBranchRequest,
  type GitCommitRequest,
  type GitCommitResult,
  type GitCreateBranchRequest,
  type GitDiscardWorkspaceChangesRequest,
  type GitDiscardWorkspaceChangesResult,
  type GitFetchRequest,
  type GitFetchResult,
  type GitGenerateCommitMessageDeltaPayload,
  type GitGenerateCommitMessageRequest,
  type GitGenerateCommitMessageResult,
  type GitGetWorkspaceFileDiffRequest,
  type GitListCommitModelOptionsRequest,
  type GitListCommitModelOptionsResult,
  type GitListCommitsRequest,
  type GitListCommitsResult,
  type GitPullRequest,
  type GitPullResult,
  type GitPushRequest,
  type GitPushResult,
  type GitSettingsSnapshot,
  type GitWorkingTreeStatus,
  type ImageDisplayArtifact,
  type ImageDisplayArtifactReadRequest,
  type ImageDisplayReadResult,
  type ImageGenerationArtifact,
  type ImageGenerationArtifactReadRequest,
  type ImageGenerationArtifactReadResult,
  type ImageGenerationProfileSaveInput,
  type ImageGenerationProfileSnapshot,
  type ImageGenerationSettingsSnapshot,
  type ImageRevealInFolderRequest,
  type ImageViewReadRequest,
  type ImageViewReadResult,
  type IntegratedWebSearchSettingsSaveInput,
  type IntegratedWebSearchSettingsSnapshot,
  type IntegratedWebSearchTestInput,
  type IntegratedWebSearchTestResult,
  type IntegrationAvailabilitySnapshot,
  IPC_CHANNELS,
  type IpcChannel,
  type LinkAgentsSkillsRequest,
  type LinkAgentsSkillsResult,
  type ListUpstreamModelsRequest,
  type ListUpstreamModelsResult,
  type MainAgentConfigResource,
  type MainAgentPromptResource,
  type McpServerCheckResult,
  type McpServerConfigInput,
  type McpServerConfigView,
  type McpSettingsSnapshot,
  type ModelSettingsSnapshot,
  type ModelsDevModelOption,
  type PackageScriptsListResult,
  type PackageScriptTerminalLaunchPayload,
  type PersonalizationSettingsSnapshot,
  type ProjectIntegrationsSettingsSnapshot,
  type ProjectMcpSettingsSnapshot,
  type ProjectOrchestrationSettingsSnapshot,
  type ProjectSkillsSettingsSnapshot,
  type ProjectTerminalSettingsSnapshot,
  type PromptImageAttachment,
  type PromptImageReadChunkResult,
  type PromptImageReleaseRequest,
  type PromptImageStageRequest,
  type PromptImageStageResult,
  type ProviderConfigInput,
  type ProviderConfigView,
  type ProviderDeleteResult,
  type ProxyBridgeSettingsSnapshot,  type RouteCapabilityHint,
  type RoutePricingHint,
  type RouteProfileInput,
  type RouteProfileView,
  type RunPackageScriptRequest,
  type RuntimeRoleRouteConfig,
  type SavePackageScriptArgsRequest,
  type SavePackageScriptArgsResult,
  type SkillCatalogInstallRequest,
  type SkillCatalogInstallResult,
  type SkillCatalogSearchRequest,
  type SkillCatalogSearchResult,
  type SkillsListResult,
  type SkillUninstallRequest,
  type SkillUninstallResult,
  type StartPackageScriptResult,
  type StorageCleanupRequest,
  type StorageCleanupResult,
  type StorageUsageSnapshot,
  type SubagentOrchestrationResource,
  type TerminalInputRequest,
  type TerminalListRequest,
  type TerminalResizeRequest,
  type TerminalSessionView,
  type TerminalSpawnRequest,
  type TerminalSpawnResult,
  type TerminalStreamEvent,
  type TestProviderConnectionRequest,
  type TestProviderConnectionResult,
  type TestRoleRoutesRequest,
  type TestRoleRoutesResult,
  type ThreadAppliedDiffResult,
  type ThreadApprovalNotificationRequest,
  type ThreadApprovalNotificationResult,
  type ThreadApprovePlanRequest,
  type ThreadCancelRequest,
  type ThreadClarificationNotificationRequest,
  type ThreadClarificationNotificationResult,
  type ThreadCompletionNotificationRequest,
  type ThreadCompletionNotificationResult,
  type ThreadContinueResult,
  type ThreadDeleteRequest,
  type ThreadDeleteResult,
  type ThreadDismissPlanRequest,
  type ThreadFollowUpCancelRequest,
  type ThreadFollowUpEditingRequest,
  type ThreadFollowUpEditingResult,
  type ThreadFollowUpEnqueueRequest,
  type ThreadFollowUpEscalateRequest,
  type ThreadFollowUpListResult,
  type ThreadFollowUpMutationResult,
  type ThreadFollowUpQueuePausedRequest,
  type ThreadFollowUpQueuePausedResult,
  type ThreadFollowUpReorderRequest,
  type ThreadFollowUpUpdateRequest,
  type ThreadPendingPlan,
  type ThreadRetryFromMessageRequest,
  type ThreadRevertAppliedDiffResult,
  type ThreadRewriteFromMessageRequest,
  type ThreadRollbackResult,
  type ThreadSessionBootstrapResult,
  type ThreadStartRequest,
  type ThreadStartResult,
  type ThreadSummary,
  type ThreadUpdateRuntimeConfigRequest,
  type ThreadUserMessageEditGetRequest,
  type ThreadUserMessageEditGetResult,
  type WorkflowSettingsSnapshot,
  type WorkspaceDiffResult,
  type WorkspaceDirectoryListing,
  type WorkspaceFileBrowserRequest,
  type WorkspaceFileDiffResult,
  type WorkspaceFileEntry,
  type WorkspaceFileReadRequest,
  type WorkspaceFileReadResult,
  type WorkspaceFileWriteRequest,
  type WorkspaceFileWriteResult,
  type WorkspaceInfo,
  type WorkspaceOpenResult,
  type WorktreeApplyResult,
  type WorktreeStatusResult,
} from "../shared/ipc";
import type { AppLocalePreference } from "../shared/locale";
import type { NotificationSettingsSnapshot } from "../shared/notification-settings";
import type { WebChatListSnapshot, WebChatListView } from "../shared/web-chat-list";

import type { ThreadForkFromMessageRequest, ThreadForkFromMessageResult } from "../shared/ipc";

type InvokePayload = Record<string, unknown> | undefined;

function resolveWindowsBackdropVersion(): "win10" | "win11" | undefined {
  const argument = process.argv.find((value) => value.startsWith("--eco-windows-backdrop="));
  const version = argument?.slice("--eco-windows-backdrop=".length);
  return version === "win10" || version === "win11" ? version : undefined;
}

import {
  mapTermProgramToScreenHost,
  PACKAGED_SCREEN_RECORDING_APP_LABEL,
} from "../shared/computer-use-screen-host";

/** Sandboxed preload cannot use `electron.app` — infer packaging from process. */
function resolvePreloadIsPackaged(): boolean {
  return process.defaultApp !== true;
}

const preloadIsPackaged = resolvePreloadIsPackaged();

function resolvePreloadScreenRecordingAppLabel(): string {
  try {
    const label = ipcRenderer.sendSync(IPC_CHANNELS.appScreenRecordingAppLabel);
    if (typeof label === "string" && label.trim()) {
      return label.trim();
    }
  } catch {
    // Main may not have registered yet in odd boot races; fall through.
  }
  if (preloadIsPackaged) {
    return PACKAGED_SCREEN_RECORDING_APP_LABEL;
  }
  return mapTermProgramToScreenHost(process.env.TERM_PROGRAM) ?? "Electron";
}

const api = {
  platform: process.platform,
  getDisplayControlState(): Promise<import("../shared/display-control").DisplayControlState> {
    return ipcRenderer.invoke(IPC_CHANNELS.displayControlGet);
  },
  setDisplayControl(input: import("../shared/display-control").DisplayControlChange): Promise<import("../shared/display-control").DisplayControlState> {
    return ipcRenderer.invoke(IPC_CHANNELS.displayControlSet, input);
  },
  isPackaged: preloadIsPackaged,
  /** System Settings → Screen Recording toggle target for this process. */
  screenRecordingAppLabel: resolvePreloadScreenRecordingAppLabel(),
  windowsBackdropVersion: resolveWindowsBackdropVersion(),
  channels: IPC_CHANNELS,
  invoke(channel: IpcChannel, payload?: InvokePayload): Promise<unknown> {
    return ipcRenderer.invoke(channel, payload);
  },
  setAppThemeSource(
    themeSource: "dark" | "light" | "system",
  ): Promise<{ themeSource: "dark" | "light" | "system" }> {
    return ipcRenderer.invoke(IPC_CHANNELS.appSetThemeSource, themeSource);
  },
  setWindowTitlebarMode(mode: "landing" | "conversation"): Promise<{ mode: "landing" | "conversation" }> {
    return ipcRenderer.invoke(IPC_CHANNELS.appSetWindowTitlebarMode, mode);
  },
  markRendererReady(): Promise<{ ok: true }> {
    return ipcRenderer.invoke(IPC_CHANNELS.appRendererReady);
  },
  setLocalePreference(
    localePreference: AppLocalePreference,
  ): Promise<{ localePreference: AppLocalePreference }> {
    return ipcRenderer.invoke(IPC_CHANNELS.appSetLocale, localePreference);
  },
  getDesktopUpdateState(): Promise<DesktopUpdateState> {
    return ipcRenderer.invoke(IPC_CHANNELS.appUpdateGetState);
  },
  checkDesktopForUpdates(): Promise<DesktopUpdateState> {
    return ipcRenderer.invoke(IPC_CHANNELS.appUpdateCheck);
  },
  downloadDesktopUpdate(): Promise<DesktopUpdateState> {
    return ipcRenderer.invoke(IPC_CHANNELS.appUpdateDownload);
  },
  installDesktopUpdate(): Promise<DesktopUpdateState> {
    return ipcRenderer.invoke(IPC_CHANNELS.appUpdateInstall);
  },
  openDesktopReleasePage(): Promise<{ ok: true }> {
    return ipcRenderer.invoke(IPC_CHANNELS.appUpdateOpenRelease);
  },
  onDesktopUpdateStateChanged(callback: (state: DesktopUpdateState) => void): () => void {
    const listener = (_event: Electron.IpcRendererEvent, payload: DesktopUpdateState) => {
      callback(payload);
    };
    ipcRenderer.on(IPC_CHANNELS.appUpdateStateChanged, listener);
    return () => ipcRenderer.off(IPC_CHANNELS.appUpdateStateChanged, listener);
  },
  showThreadCompletionNotification(
    request: ThreadCompletionNotificationRequest,
  ): Promise<ThreadCompletionNotificationResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.appShowThreadCompletionNotification, request);
  },
  showThreadApprovalNotification(
    request: ThreadApprovalNotificationRequest,
  ): Promise<ThreadApprovalNotificationResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.appShowThreadApprovalNotification, request);
  },
  showThreadClarificationNotification(
    request: ThreadClarificationNotificationRequest,
  ): Promise<ThreadClarificationNotificationResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.appShowThreadClarificationNotification, request);
  },
  consumePendingThreadOpen(): Promise<string | undefined> {
    return ipcRenderer.invoke(IPC_CHANNELS.appConsumePendingThreadOpen);
  },
  onThreadOpenRequested(callback: (threadId?: string) => void): () => void {
    const listener = (_event: Electron.IpcRendererEvent, threadId?: unknown) => {
      callback(typeof threadId === "string" && threadId.trim() ? threadId.trim() : undefined);
    };
    ipcRenderer.on(IPC_CHANNELS.appThreadOpenRequested, listener);
    return () => ipcRenderer.off(IPC_CHANNELS.appThreadOpenRequested, listener);
  },
  onAppMenuCommand(callback: (command: AppMenuCommand) => void): () => void {
    const listener = (_event: Electron.IpcRendererEvent, command: AppMenuCommand) => callback(command);
    ipcRenderer.on(IPC_CHANNELS.appMenuCommand, listener);
    return () => ipcRenderer.off(IPC_CHANNELS.appMenuCommand, listener);
  },
  getCoreAvailability(): Promise<CoreAvailabilitySnapshot> {
    return ipcRenderer.invoke(IPC_CHANNELS.coreAvailabilityGet);
  },
  listCursorModels(): Promise<CursorModelOption[]> {
    return ipcRenderer.invoke(IPC_CHANNELS.cursorModelsList);
  },
  openWorkspace(): Promise<WorkspaceOpenResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.workspaceOpen);
  },
  openWorkspacePath(workspacePath: string): Promise<WorkspaceInfo> {
    return ipcRenderer.invoke(IPC_CHANNELS.workspaceOpenPath, workspacePath);
  },
  getPathForFile(file: File): string {
    return webUtils.getPathForFile(file);
  },
  getCurrentWorkspace(): Promise<WorkspaceInfo | undefined> {
    return ipcRenderer.invoke(IPC_CHANNELS.workspaceGetCurrent);
  },
  getHomeProjectPath(): Promise<string> {
    return ipcRenderer.invoke(IPC_CHANNELS.workspaceGetHomePath);
  },
  getUserHomePath(): Promise<string> {
    return ipcRenderer.invoke(IPC_CHANNELS.workspaceGetUserHomePath);
  },
  listWorkspaceDirectories(directoryPath: string): Promise<WorkspaceDirectoryListing> {
    return ipcRenderer.invoke(IPC_CHANNELS.workspaceListDirectories, directoryPath);
  },
  listWorkspaceEntries(request: WorkspaceFileBrowserRequest): Promise<WorkspaceFileEntry[]> {
    return ipcRenderer.invoke(IPC_CHANNELS.workspaceListEntries, request);
  },
  readWorkspaceFile(request: WorkspaceFileReadRequest): Promise<WorkspaceFileReadResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.workspaceReadFile, request);
  },
  writeWorkspaceFile(request: WorkspaceFileWriteRequest): Promise<WorkspaceFileWriteResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.workspaceWriteFile, request);
  },
  inspectWorkspace(workspacePath: string): Promise<WorkspaceInfo> {
    return ipcRenderer.invoke(IPC_CHANNELS.workspaceInspect, workspacePath);
  },
  openWorkspaceInFileManager(workspacePath: string): Promise<void> {
    return ipcRenderer.invoke(IPC_CHANNELS.workspaceOpenInFileManager, workspacePath);
  },
  openFileExternally(filePath: string): Promise<void> {
    return ipcRenderer.invoke(IPC_CHANNELS.workspaceOpenFileExternally, filePath);
  },
  openContainingFolder(filePath: string): Promise<void> {
    return ipcRenderer.invoke(IPC_CHANNELS.workspaceOpenContainingFolder, filePath);
  },
  getAssociatedApps(
    filePath: string,
  ): Promise<Array<{ name: string; bundleId: string; iconBase64?: string }>> {
    return ipcRenderer.invoke(IPC_CHANNELS.workspaceGetAssociatedApps, filePath);
  },
  openFileWithApp(filePath: string, bundleId: string): Promise<void> {
    console.log("[Preload] openFileWithApp:", JSON.stringify({ filePath, bundleId }));
    return ipcRenderer.invoke(IPC_CHANNELS.workspaceOpenFileWithApp, { filePath, bundleId });
  },
  prepareWorkspaceGit(workspacePath: string): Promise<WorkspaceInfo> {
    return ipcRenderer.invoke(IPC_CHANNELS.workspacePrepareGit, { workspacePath });
  },
  listPackageScripts(workspacePath: string): Promise<PackageScriptsListResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.workspaceListPackageScripts, workspacePath);
  },
  savePackageScriptArgs(request: SavePackageScriptArgsRequest): Promise<SavePackageScriptArgsResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.workspaceSavePackageScriptArgs, request);
  },
  watchPackageJson(workspacePath: string): Promise<{ ok: true }> {
    return ipcRenderer.invoke(IPC_CHANNELS.workspaceWatchPackageJson, workspacePath);
  },
  onPackageJsonChanged(callback: (workspacePath: string) => void): () => void {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => {
      if (typeof payload === "string") {
        callback(payload);
      }
    };
    ipcRenderer.on(IPC_CHANNELS.workspacePackageJsonChanged, listener);
    return () => ipcRenderer.off(IPC_CHANNELS.workspacePackageJsonChanged, listener);
  },
  onGitRemoteFetched(callback: (workspacePath: string) => void): () => void {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => {
      if (typeof payload === "string") {
        callback(payload);
      }
    };
    ipcRenderer.on(IPC_CHANNELS.gitRemoteFetched, listener);
    return () => ipcRenderer.off(IPC_CHANNELS.gitRemoteFetched, listener);
  },
  onGitDiffChanged(callback: (event: import("../shared/ipc").WorkspaceDiffChangedEvent) => void): () => void {
    const listener = (
      _event: Electron.IpcRendererEvent,
      payload: import("../shared/ipc").WorkspaceDiffChangedEvent,
    ) => callback(payload);
    ipcRenderer.on(IPC_CHANNELS.gitDiffChanged, listener);
    return () => ipcRenderer.off(IPC_CHANNELS.gitDiffChanged, listener);
  },
  onGitStatusChanged(
    callback: (event: import("../shared/event-center").EventCenterGitStatusChangedPayload) => void,
  ): () => void {
    const listener = (
      _event: Electron.IpcRendererEvent,
      payload: import("../shared/event-center").EventCenterGitStatusChangedPayload,
    ) => callback(payload);
    ipcRenderer.on(IPC_CHANNELS.gitStatusChanged, listener);
    return () => ipcRenderer.off(IPC_CHANNELS.gitStatusChanged, listener);
  },
  startPackageScript(request: RunPackageScriptRequest): Promise<StartPackageScriptResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.workspaceStartPackageScript, request);
  },
  onPackageScriptTerminalLaunch(callback: (payload: PackageScriptTerminalLaunchPayload) => void): () => void {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => {
      if (
        payload &&
        typeof payload === "object" &&
        typeof (payload as PackageScriptTerminalLaunchPayload).sessionId === "string"
      ) {
        callback(payload as PackageScriptTerminalLaunchPayload);
      }
    };
    ipcRenderer.on(IPC_CHANNELS.workspacePackageScriptTerminal, listener);
    return () => ipcRenderer.off(IPC_CHANNELS.workspacePackageScriptTerminal, listener);
  },
  listBackgroundTerminalTasks(request?: BackgroundTerminalListRequest): Promise<BackgroundTerminalTask[]> {
    return ipcRenderer.invoke(IPC_CHANNELS.backgroundTerminalList, request ?? {});
  },
  startBackgroundTerminalTask(request: BackgroundTerminalStartRequest): Promise<BackgroundTerminalTask> {
    return ipcRenderer.invoke(IPC_CHANNELS.backgroundTerminalStart, request);
  },
  openBackgroundTerminalTask(request: BackgroundTerminalOpenRequest): Promise<BackgroundTerminalTask> {
    return ipcRenderer.invoke(IPC_CHANNELS.backgroundTerminalOpen, request);
  },
  stopBackgroundTerminalTask(request: BackgroundTerminalStopRequest): Promise<BackgroundTerminalStopResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.backgroundTerminalStop, request);
  },
  listCodexBackgroundTerminals(): Promise<CodexBackgroundTerminal[]> {
    return ipcRenderer.invoke(IPC_CHANNELS.codexBackgroundTerminalList);
  },
  terminateCodexBackgroundTerminal(
    request: CodexBackgroundTerminalTerminateRequest,
  ): Promise<CodexBackgroundTerminalTerminateResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.codexBackgroundTerminalTerminate, request);
  },
  listClaudeBackgroundTasks(): Promise<ClaudeBackgroundTask[]> {
    return ipcRenderer.invoke(IPC_CHANNELS.claudeBackgroundTaskList);
  },
  stopClaudeBackgroundTask(
    request: ClaudeBackgroundTaskStopRequest,
  ): Promise<ClaudeBackgroundTaskStopResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.claudeBackgroundTaskStop, request);
  },
  listTerminalSessions(request?: TerminalListRequest): Promise<TerminalSessionView[]> {
    return ipcRenderer.invoke(IPC_CHANNELS.terminalList, request ?? {});
  },
  spawnTerminal(request: TerminalSpawnRequest): Promise<TerminalSpawnResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.terminalSpawn, request);
  },
  getProjectTerminalSettings(workspacePath: string): Promise<ProjectTerminalSettingsSnapshot> {
    return ipcRenderer.invoke(IPC_CHANNELS.projectTerminalSettingsGet, workspacePath);
  },
  saveProjectTerminalSettings(
    snapshot: ProjectTerminalSettingsSnapshot,
  ): Promise<ProjectTerminalSettingsSnapshot> {
    return ipcRenderer.invoke(IPC_CHANNELS.projectTerminalSettingsSave, snapshot);
  },
  writeTerminalInput(request: TerminalInputRequest): Promise<void> {
    return ipcRenderer.invoke(IPC_CHANNELS.terminalInput, request);
  },
  resizeTerminal(request: TerminalResizeRequest): Promise<void> {
    return ipcRenderer.invoke(IPC_CHANNELS.terminalResize, request);
  },
  killTerminal(sessionId: string): Promise<{ killed: boolean }> {
    return ipcRenderer.invoke(IPC_CHANNELS.terminalKill, { sessionId });
  },
  /** Plain-text system clipboard contents, read in the main process (the renderer has no clipboard-read). */
  readClipboardText(): Promise<string> {
    return ipcRenderer.invoke(IPC_CHANNELS.clipboardReadText);
  },
  /**
   * PNG system-clipboard image, read in the main process for the same reason. `null` when the
   * clipboard holds no image, which is how the Composer's right-click Paste picks text instead.
   */
  readClipboardImage(): Promise<ClipboardReadImageResult | null> {
    return ipcRenderer.invoke(IPC_CHANNELS.clipboardReadImage);
  },
  /**
   * Image system-clipboard write, performed in the main process. The renderer's own write
   * needs a focused document; this one does not, so it is the image viewer's fallback.
   */
  writeImageToClipboard(request: ClipboardWriteImageRequest): Promise<boolean> {
    return ipcRenderer.invoke(IPC_CHANNELS.clipboardWriteImage, request);
  },
  onTerminalEvent(callback: (event: TerminalStreamEvent) => void): () => void {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => {
      callback(payload as TerminalStreamEvent);
    };
    ipcRenderer.on(IPC_CHANNELS.terminalEvent, listener);
    return () => ipcRenderer.off(IPC_CHANNELS.terminalEvent, listener);
  },
  getModelSettings(): Promise<ModelSettingsSnapshot> {
    return ipcRenderer.invoke(IPC_CHANNELS.modelSettingsGet);
  },
  getSettingsDigest(): Promise<{ digest: string }> {
    return ipcRenderer.invoke(IPC_CHANNELS.settingsDigest);
  },
  saveProvider(provider: ProviderConfigInput): Promise<ProviderConfigView> {
    return ipcRenderer.invoke(IPC_CHANNELS.modelProviderSave, provider);
  },
  deleteProvider(providerId: string): Promise<ProviderDeleteResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.modelProviderDelete, providerId);
  },
  listProviderModels(request: ListUpstreamModelsRequest): Promise<ListUpstreamModelsResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.modelProviderListModels, request);
  },
  testProviderConnection(request: TestProviderConnectionRequest): Promise<TestProviderConnectionResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.modelProviderTest, request);
  },
  chatGptSubscriptionAccountsList(): Promise<Array<{
    accountId: string;
    displayName: string;
    email?: string;
    proxyUrl?: string;
    status: string;
    enabled: boolean;
    hasCredentials: boolean;
    lastErrorCode?: string;
    cooldownUntil?: number;
    lastSuccessAt?: number;
    createdAt: number;
    updatedAt: number;
  }>> {
    return ipcRenderer.invoke(IPC_CHANNELS.chatGptSubscriptionAccountsList);
  },
  accountUsageHistory(query: AccountUsageQuery): Promise<AccountUsageHistory> {
    return ipcRenderer.invoke(IPC_CHANNELS.accountUsageHistory, query);
  },
  usageOverview(query: UsageOverviewQuery): Promise<UsageOverview> {
    return ipcRenderer.invoke(IPC_CHANNELS.usageOverview, query);
  },
  chatGptSubscriptionAccountCreate(displayName?: string, proxyUrl?: string): Promise<unknown> {
    return ipcRenderer.invoke(IPC_CHANNELS.chatGptSubscriptionAccountCreate, { displayName, proxyUrl });
  },
  chatGptSubscriptionAccountDelete(accountId: string): Promise<{ success: boolean }> {
    return ipcRenderer.invoke(IPC_CHANNELS.chatGptSubscriptionAccountDelete, { accountId });
  },
  chatGptSubscriptionAccountSetEnabled(accountId: string, enabled: boolean): Promise<unknown> {
    return ipcRenderer.invoke(IPC_CHANNELS.chatGptSubscriptionAccountSetEnabled, { accountId, enabled });
  },
  chatGptSubscriptionAccountResetAvailability(accountId: string): Promise<unknown> {
    return ipcRenderer.invoke(IPC_CHANNELS.chatGptSubscriptionAccountResetAvailability, { accountId });
  },
  chatGptSubscriptionAccountSetProxy(accountId: string, proxyUrl?: string): Promise<unknown> {
    return ipcRenderer.invoke(IPC_CHANNELS.chatGptSubscriptionAccountSetProxy, { accountId, proxyUrl });
  },
  chatGptSubscriptionAccountTest(accountId: string, modelId: string): Promise<{ success: boolean; message: string }> {
    return ipcRenderer.invoke(IPC_CHANNELS.chatGptSubscriptionAccountTest, { accountId, modelId });
  },
  chatGptSubscriptionAccountLogin(accountId: string): Promise<{ success: boolean; message: string }> {
    return ipcRenderer.invoke(IPC_CHANNELS.chatGptSubscriptionAccountLogin, { accountId });
  },
  chatGptSubscriptionAccountAuthorizationUrl(accountId: string): Promise<{ success: boolean; message: string; authorizationUrl?: string }> {
    return ipcRenderer.invoke(IPC_CHANNELS.chatGptSubscriptionAccountAuthorizationUrl, { accountId });
  },
  onChatGptSubscriptionLoginResult(callback: (result: { success: boolean; message?: string; account?: unknown }) => void): () => void {
    const listener = (_event: Electron.IpcRendererEvent, result: { success: boolean; message?: string; account?: unknown }) => callback(result);
    ipcRenderer.on("chatgpt-subscription:login-result", listener);
    return () => ipcRenderer.off("chatgpt-subscription:login-result", listener);
  },
  codexOAuthGetStatus(): Promise<{ isLoggedIn: boolean; message: string; authState?: import("../shared/openai-account").OpenAIAccountAuthState }> {
    return ipcRenderer.invoke(IPC_CHANNELS.codexOAuthGetStatus);
  },
  codexOAuthStartLogin(upstreamProxyUrl?: string): Promise<{ success: boolean; message: string }> {
    return ipcRenderer.invoke(IPC_CHANNELS.codexOAuthStartLogin, { upstreamProxyUrl });
  },
  codexOAuthLogout(): Promise<{ success: boolean; message: string }> {
    return ipcRenderer.invoke(IPC_CHANNELS.codexOAuthLogout);
  },

  // ─── OpenAI Account Management ─────────────────────────────────────────────
  openAIAccountsList(): Promise<
    OpenAIAccount[]
  > {
    return ipcRenderer.invoke(IPC_CHANNELS.openAIAccountsList);
  },

  openAIAccountsCreate(input: OpenAIAccountCreateInput): Promise<OpenAIAccount> {
    return ipcRenderer.invoke(IPC_CHANNELS.openAIAccountsCreate, input);
  },

  openAIAccountsDelete(accountId: string): Promise<{ success: boolean }> {
    return ipcRenderer.invoke(IPC_CHANNELS.openAIAccountsDelete, { accountId });
  },

  openAIAccountsStartLogin(accountId: string, mode?: "external"): Promise<{ success: boolean; message: string; authUrl?: string; loginId?: string; expiresAt?: number }> {
    return ipcRenderer.invoke(IPC_CHANNELS.openAIAccountsStartLogin, { accountId, mode });
  },

  openAIAccountsSubmitLoginCallback(accountId: string, loginId: string, callbackUrl: string): Promise<void> {
    return ipcRenderer.invoke(IPC_CHANNELS.openAIAccountsSubmitLoginCallback, { accountId, loginId, callbackUrl });
  },

  openAIAccountsCancelLogin(accountId: string, loginId: string): Promise<void> {
    return ipcRenderer.invoke(IPC_CHANNELS.openAIAccountsCancelLogin, { accountId, loginId });
  },

  openAIAccountsOpenAssistant(accountId: string): Promise<void> {
    return ipcRenderer.invoke(IPC_CHANNELS.openAIAccountsOpenAssistant, { accountId });
  },

  openAIAccountsAssistantState(accountId: string): Promise<OpenAIAccountAssistantState> {
    return ipcRenderer.invoke(IPC_CHANNELS.openAIAccountsAssistantState, { accountId });
  },

  openAIAccountsAssistantAction(accountId: string, action: OpenAIAccountAssistantAction): Promise<OpenAIAccountAssistantActionResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.openAIAccountsAssistantAction, { accountId, action });
  },

  openAIAccountsSetActive(accountId: string | null): Promise<{ success: boolean; pending?: boolean }> {
    return ipcRenderer.invoke(IPC_CHANNELS.openAIAccountsSetActive, { accountId });
  },

  openAIAccountsSetAuthJson(accountId: string, content: string): Promise<{ success: boolean; message: string }> {
    return ipcRenderer.invoke(IPC_CHANNELS.openAIAccountsSetAuthJson, { accountId, content });
  },

  openAIAccountsQueryQuota(accountId: string, reason: "manual" | "switch" | "reset" = "manual"): Promise<OpenAIAccountQuota> {
    return ipcRenderer.invoke(IPC_CHANNELS.openAIAccountsQueryQuota, { accountId, reason });
  },

  openAIAccountsWake(accountId: string): Promise<import("../shared/openai-account").OpenAIAccountWakeResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.openAIAccountsWake, { accountId });
  },

  openAIAccountsGetWakeModel(): Promise<string | null> {
    return ipcRenderer.invoke(IPC_CHANNELS.openAIAccountsGetWakeModel);
  },

  openAIAccountsSetWakeModel(modelId: string | null): Promise<void> {
    return ipcRenderer.invoke(IPC_CHANNELS.openAIAccountsSetWakeModel, { modelId });
  },

  openAIAccountsResetQuota(accountId: string, idempotencyKey: string): Promise<{
    outcome: import("../shared/openai-account").CodexQuotaResetOutcome;
  }> {
    return ipcRenderer.invoke(IPC_CHANNELS.openAIAccountsResetQuota, { accountId, idempotencyKey });
  },

  openAIAccountsSetImageEnabled(accountId: string, enabled: boolean): Promise<void> {
    return ipcRenderer.invoke(IPC_CHANNELS.openAIAccountsImageEnabled, { accountId, enabled });
  },
  openAIAccountsQueryImageQuota(accountId: string): Promise<OpenAIAccountImageQuota> {
    return ipcRenderer.invoke(IPC_CHANNELS.openAIAccountsImageQuota, { accountId });
  },

  openAIAccountsUpdate(input: OpenAIAccountUpdateInput): Promise<{ success: boolean }> {
    return ipcRenderer.invoke(IPC_CHANNELS.openAIAccountsUpdate, input);
  },

  openAIAccountsGetAuthJson(accountId: string): Promise<string | null> {
    return ipcRenderer.invoke(IPC_CHANNELS.openAIAccountsGetAuthJson, { accountId });
  },

  openAIAccountsGetDetails(accountId: string): Promise<OpenAIAccountDetails> {
    return ipcRenderer.invoke(IPC_CHANNELS.openAIAccountsGetDetails, { accountId });
  },

  openAIAccountsImport(text: string): Promise<OpenAIAccountImportResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.openAIAccountsImport, { text });
  },

  openAIAccountsCancelSwitch(): Promise<{ success: boolean }> {
    return ipcRenderer.invoke(IPC_CHANNELS.openAIAccountsCancelSwitch);
  },

  openAIAccountsGetActive(): Promise<{
    activeAccountId: string | null;
    isLoggedIn: boolean;
    authState?: import("../shared/openai-account").OpenAIAccountAuthState;
    message: string;
    pendingAccountId?: string | null;
    syncStatus: OpenAIAccountSyncStatus;
  }> {
    return ipcRenderer.invoke(IPC_CHANNELS.openAIAccountsGetActive);
  },

  onOpenAIAccountsChanged(callback: (event: { syncStatus: OpenAIAccountSyncStatus }) => void): () => void {
    const listener = (_event: Electron.IpcRendererEvent, state: { syncStatus: OpenAIAccountSyncStatus }) => callback(state);
    ipcRenderer.on(IPC_CHANNELS.openAIAccountsChanged, listener);
    return () => ipcRenderer.off(IPC_CHANNELS.openAIAccountsChanged, listener);
  },
  onCodexOauthLoginResult(callback: (result: { success: boolean; message: string; accountId?: string; loginId?: string }) => void): () => void {
    const listener = (_event: Electron.IpcRendererEvent, result: { success: boolean; message: string; accountId?: string; loginId?: string }) => callback(result);
    ipcRenderer.on("codex-oauth:login-result", listener);
    return () => ipcRenderer.off("codex-oauth:login-result", listener);
  },
  testRouteProfile(request: TestRoleRoutesRequest): Promise<TestRoleRoutesResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.modelRouteProfileTest, request);
  },
  saveRouteProfile(profile: RouteProfileInput): Promise<RouteProfileView> {
    return ipcRenderer.invoke(IPC_CHANNELS.modelRouteProfileSave, profile);
  },
  deleteRouteProfile(profileId: string): Promise<{ ok: true }> {
    return ipcRenderer.invoke(IPC_CHANNELS.modelRouteProfileDelete, profileId);
  },
  listCandidateModels(providerId: string): Promise<CandidateModelView[]> {
    return ipcRenderer.invoke(IPC_CHANNELS.candidateModelList, providerId);
  },
  saveCandidateModel(input: CandidateModelInput): Promise<CandidateModelView> {
    return ipcRenderer.invoke(IPC_CHANNELS.candidateModelSave, input);
  },
  deleteCandidateModel(id: string): Promise<{ ok: true }> {
    return ipcRenderer.invoke(IPC_CHANNELS.candidateModelDelete, id);
  },
  reorderCandidateModels(providerId: string, orderedIds: string[]): Promise<{ ok: true }> {
    return ipcRenderer.invoke(IPC_CHANNELS.candidateModelReorder, providerId, orderedIds);
  },
  bulkImportCandidateModels(providerId: string, modelIds: string[]): Promise<CandidateModelView[]> {
    return ipcRenderer.invoke(IPC_CHANNELS.candidateModelBulkImport, providerId, modelIds);
  },
  getCodexModelCatalog(): Promise<CodexModelCatalogSnapshot> {
    return ipcRenderer.invoke(IPC_CHANNELS.codexModelCatalogGet);
  },
  getChatGptModelCatalog(): Promise<CodexModelCatalogSnapshot> {
    return ipcRenderer.invoke(IPC_CHANNELS.chatGptModelCatalogGet);
  },
  refreshChatGptModelCatalog(accountId?: string): Promise<CodexModelCatalogSnapshot> {
    return ipcRenderer.invoke(IPC_CHANNELS.chatGptModelCatalogRefresh, accountId);
  },
  addChatGptModelCatalogModel(request: AddCodexCatalogModelRequest): Promise<CodexModelCatalogSnapshot> {
    return ipcRenderer.invoke(IPC_CHANNELS.chatGptModelCatalogAdd, request);
  },
  removeChatGptModelCatalogModel(modelId: string): Promise<CodexModelCatalogSnapshot> {
    return ipcRenderer.invoke(IPC_CHANNELS.chatGptModelCatalogRemove, modelId);
  },
  refreshCodexModelCatalog(): Promise<CodexModelCatalogSnapshot> {
    return ipcRenderer.invoke(IPC_CHANNELS.codexModelCatalogRefresh);
  },
  addCodexModelCatalogModel(request: AddCodexCatalogModelRequest): Promise<CodexModelCatalogSnapshot> {
    return ipcRenderer.invoke(IPC_CHANNELS.codexModelCatalogAdd, request);
  },
  removeCodexModelCatalogModel(modelId: string): Promise<CodexModelCatalogSnapshot> {
    return ipcRenderer.invoke(IPC_CHANNELS.codexModelCatalogRemove, modelId);
  },
  listAgentTemplates(): Promise<AgentTemplate[]> {
    return ipcRenderer.invoke(IPC_CHANNELS.agentTemplateList);
  },
  saveAgentTemplate(template: AgentTemplate): Promise<AgentTemplate> {
    return ipcRenderer.invoke(IPC_CHANNELS.agentTemplateSave, template);
  },
  deleteAgentTemplate(templateId: string): Promise<{ ok: true }> {
    return ipcRenderer.invoke(IPC_CHANNELS.agentTemplateDelete, templateId);
  },
  exportAgentTemplates(request?: AgentTemplateExportRequest): Promise<AgentTemplateExportResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.agentTemplateExport, request);
  },
  importAgentTemplates(): Promise<AgentTemplateImportResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.agentTemplateImport);
  },
  saveMainAgentConfig(config: MainAgentConfigResource): Promise<MainAgentConfigResource> {
    return ipcRenderer.invoke(IPC_CHANNELS.mainAgentConfigSave, config);
  },
  deleteMainAgentConfig(configId: string): Promise<{ ok: true }> {
    return ipcRenderer.invoke(IPC_CHANNELS.mainAgentConfigDelete, configId);
  },
  saveMainAgentPrompt(prompt: MainAgentPromptResource): Promise<MainAgentPromptResource> {
    return ipcRenderer.invoke(IPC_CHANNELS.mainAgentPromptSave, prompt);
  },
  deleteMainAgentPrompt(promptId: string): Promise<{ ok: true }> {
    return ipcRenderer.invoke(IPC_CHANNELS.mainAgentPromptDelete, promptId);
  },
  saveSubagentOrchestration(
    orchestration: SubagentOrchestrationResource,
  ): Promise<SubagentOrchestrationResource> {
    return ipcRenderer.invoke(IPC_CHANNELS.subagentOrchestrationSave, orchestration);
  },
  deleteSubagentOrchestration(orchestrationId: string): Promise<{ ok: true }> {
    return ipcRenderer.invoke(IPC_CHANNELS.subagentOrchestrationDelete, orchestrationId);
  },
  updateThreadRuntimeConfig(request: ThreadUpdateRuntimeConfigRequest): Promise<{ thread: ThreadSummary }> {
    return ipcRenderer.invoke(IPC_CHANNELS.threadUpdateRuntimeConfig, request);
  },
  getRoutePricing(routes?: RuntimeRoleRouteConfig[]): Promise<RoutePricingHint[]> {
    return ipcRenderer.invoke(IPC_CHANNELS.billingRoutePricing, routes);
  },
  getRouteCapabilities(routes?: RuntimeRoleRouteConfig[]): Promise<RouteCapabilityHint[]> {
    return ipcRenderer.invoke(IPC_CHANNELS.billingRouteCapabilities, routes);
  },
  listModelsDevModels(): Promise<ModelsDevModelOption[]> {
    return ipcRenderer.invoke(IPC_CHANNELS.billingModelsDevList);
  },
  refreshPricingCatalog(): Promise<{ ok: true; cachedAt: number }> {
    return ipcRenderer.invoke(IPC_CHANNELS.billingRefreshPricing);
  },
  getMcpSettings(): Promise<McpSettingsSnapshot> {
    return ipcRenderer.invoke(IPC_CHANNELS.mcpSettingsGet);
  },
  saveMcpServer(server: McpServerConfigInput): Promise<McpServerConfigView> {
    return ipcRenderer.invoke(IPC_CHANNELS.mcpServerSave, server);
  },
  deleteMcpServer(serverId: string): Promise<{ ok: true }> {
    return ipcRenderer.invoke(IPC_CHANNELS.mcpServerDelete, serverId);
  },
  checkMcpServer(server: McpServerConfigInput): Promise<McpServerCheckResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.mcpServerCheck, server);
  },
  listSkills(workspacePath?: string): Promise<SkillsListResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.skillsList, workspacePath);
  },
  listCursorAgents(workspacePath?: string): Promise<CursorAgentsListResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.cursorAgentsList, workspacePath);
  },
  linkAgentsSkills(request: LinkAgentsSkillsRequest): Promise<LinkAgentsSkillsResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.skillsLinkAgents, request);
  },
  uninstallSkill(request: SkillUninstallRequest): Promise<SkillUninstallResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.skillsUninstall, request);
  },
  listSkillsCatalogLeaderboard(limit = 12): Promise<SkillCatalogSearchResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.skillsCatalogLeaderboard, limit);
  },
  searchSkillsCatalog(request: SkillCatalogSearchRequest): Promise<SkillCatalogSearchResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.skillsCatalogSearch, request);
  },
  installCatalogSkill(request: SkillCatalogInstallRequest): Promise<SkillCatalogInstallResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.skillsCatalogInstall, request);
  },
  getProjectSkillsSettings(workspacePath: string): Promise<ProjectSkillsSettingsSnapshot> {
    return ipcRenderer.invoke(IPC_CHANNELS.projectSkillsSettingsGet, workspacePath);
  },
  saveProjectSkillsSettings(snapshot: ProjectSkillsSettingsSnapshot): Promise<ProjectSkillsSettingsSnapshot> {
    return ipcRenderer.invoke(IPC_CHANNELS.projectSkillsSettingsSave, snapshot);
  },
  getProjectMcpSettings(workspacePath: string): Promise<ProjectMcpSettingsSnapshot> {
    return ipcRenderer.invoke(IPC_CHANNELS.projectMcpSettingsGet, workspacePath);
  },
  saveProjectMcpSettings(snapshot: ProjectMcpSettingsSnapshot): Promise<ProjectMcpSettingsSnapshot> {
    return ipcRenderer.invoke(IPC_CHANNELS.projectMcpSettingsSave, snapshot);
  },
  getProjectIntegrationsSettings(workspacePath: string): Promise<ProjectIntegrationsSettingsSnapshot> {
    return ipcRenderer.invoke(IPC_CHANNELS.projectIntegrationsSettingsGet, workspacePath);
  },
  saveProjectIntegrationsSettings(
    snapshot: ProjectIntegrationsSettingsSnapshot,
  ): Promise<ProjectIntegrationsSettingsSnapshot> {
    return ipcRenderer.invoke(IPC_CHANNELS.projectIntegrationsSettingsSave, snapshot);
  },
  getProjectOrchestrationSettings(workspacePath: string): Promise<ProjectOrchestrationSettingsSnapshot> {
    return ipcRenderer.invoke(IPC_CHANNELS.projectOrchestrationSettingsGet, workspacePath);
  },
  saveProjectOrchestrationSettings(
    snapshot: ProjectOrchestrationSettingsSnapshot,
  ): Promise<ProjectOrchestrationSettingsSnapshot> {
    return ipcRenderer.invoke(IPC_CHANNELS.projectOrchestrationSettingsSave, snapshot);
  },
  getWorkflowSettings(): Promise<WorkflowSettingsSnapshot> {
    return ipcRenderer.invoke(IPC_CHANNELS.workflowSettingsGet);
  },
  saveWorkflowSettings(settings: WorkflowSettingsSnapshot): Promise<WorkflowSettingsSnapshot> {
    return ipcRenderer.invoke(IPC_CHANNELS.workflowSettingsSave, settings);
  },
  getGitSettings(): Promise<GitSettingsSnapshot> {
    return ipcRenderer.invoke(IPC_CHANNELS.gitSettingsGet);
  },
  saveGitSettings(settings: GitSettingsSnapshot): Promise<GitSettingsSnapshot> {
    return ipcRenderer.invoke(IPC_CHANNELS.gitSettingsSave, settings);
  },
  getPersonalizationSettings(): Promise<PersonalizationSettingsSnapshot> {
    return ipcRenderer.invoke(IPC_CHANNELS.personalizationSettingsGet);
  },
  savePersonalizationSettings(
    settings: PersonalizationSettingsSnapshot,
  ): Promise<PersonalizationSettingsSnapshot> {
    return ipcRenderer.invoke(IPC_CHANNELS.personalizationSettingsSave, settings);
  },
  getBrowserSettings(): Promise<BrowserSettingsSnapshot> {
    return ipcRenderer.invoke(IPC_CHANNELS.browserSettingsGet);
  },
  saveBrowserSettings(settings: BrowserSettingsSnapshot): Promise<BrowserSettingsSnapshot> {
    return ipcRenderer.invoke(IPC_CHANNELS.browserSettingsSave, settings);
  },
  getComputerUseSettings(): Promise<import("../shared/computer-use").ComputerUseSettingsSnapshot> {
    return ipcRenderer.invoke(IPC_CHANNELS.computerUseSettingsGet);
  },
  saveComputerUseSettings(
    settings: import("../shared/computer-use").ComputerUseSettingsSnapshot,
  ): Promise<import("../shared/computer-use").ComputerUseSettingsSnapshot> {
    return ipcRenderer.invoke(IPC_CHANNELS.computerUseSettingsSave, settings);
  },
  runComputerUseDoctor(): Promise<{
    ok: boolean;
    onboardingLaunched: boolean;
    screenPromptOpened?: boolean;
    screenRecordingAppLabel?: string;
    reason?: string;
    output?: string;
    onboardingError?: string;
    missing?: string[];
  }> {
    return ipcRenderer.invoke(IPC_CHANNELS.computerUseDoctor);
  },
  checkComputerUsePermissionStatus(): Promise<{ ok: boolean; missing: string[] }> {
    return ipcRenderer.invoke(IPC_CHANNELS.computerUsePermissionStatus);
  },
  getIntegrationAvailability(): Promise<IntegrationAvailabilitySnapshot> {
    return ipcRenderer.invoke(IPC_CHANNELS.integrationAvailabilityGet);
  },
  getImageGenerationSettings(): Promise<ImageGenerationSettingsSnapshot> {
    return ipcRenderer.invoke(IPC_CHANNELS.imageGenerationSettingsGet);
  },
  saveImageGenerationEnabled(enabled: boolean): Promise<ImageGenerationSettingsSnapshot> {
    return ipcRenderer.invoke(IPC_CHANNELS.imageGenerationSettingsSave, { enabled });
  },
  saveImageGenerationProfile(
    profile: ImageGenerationProfileSaveInput,
  ): Promise<ImageGenerationProfileSnapshot> {
    return ipcRenderer.invoke(IPC_CHANNELS.imageGenerationProfileSave, profile);
  },
  deleteImageGenerationProfile(id: string): Promise<ImageGenerationSettingsSnapshot> {
    return ipcRenderer.invoke(IPC_CHANNELS.imageGenerationProfileDelete, { id });
  },
  activateImageGenerationProfile(id: string): Promise<ImageGenerationSettingsSnapshot> {
    return ipcRenderer.invoke(IPC_CHANNELS.imageGenerationProfileActivate, { id });
  },
  createImageGeneration(input: GenerationToolRequest<ImageGenerationToolInput>): Promise<ImageGenerationArtifact> {
    return ipcRenderer.invoke(IPC_CHANNELS.imageGenerationCreate, input);
  },
  pickImageGenerationInputs(): Promise<string[]> {
    return ipcRenderer.invoke(IPC_CHANNELS.imageGenerationPickInputs);
  },
  listImageGenerationArtifacts(threadId: string): Promise<ImageGenerationArtifact[]> {
    return ipcRenderer.invoke(IPC_CHANNELS.imageGenerationArtifactsList, { threadId });
  },
  readImageGenerationArtifact(
    request: ImageGenerationArtifactReadRequest,
  ): Promise<ImageGenerationArtifactReadResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.imageGenerationArtifactRead, request);
  },
  revealImageGenerationArtifact(request: ImageGenerationArtifactReadRequest): Promise<void> {
    return ipcRenderer.invoke(IPC_CHANNELS.imageGenerationArtifactReveal, request);
  },
  getReadAloudStatus(): Promise<ReadAloudStatus> { return ipcRenderer.invoke(IPC_CHANNELS.ttsReadAloudStatus); },
  getReadAloudSettings(): Promise<ReadAloudSettingsSnapshot> { return ipcRenderer.invoke(IPC_CHANNELS.ttsReadAloudSettingsGet); },
  saveReadAloudSettings(input: ReadAloudSettingsInput): Promise<ReadAloudSettingsSnapshot> { return ipcRenderer.invoke(IPC_CHANNELS.ttsReadAloudSettingsSave, input); },
  startReadAloud(input: ReadAloudStartInput): Promise<ReadAloudStartResult> { return ipcRenderer.invoke(IPC_CHANNELS.ttsReadAloudStart, input); },
  synthesizeReadAloudSegment(input: ReadAloudSegmentInput): Promise<ReadAloudSegmentResult> { return ipcRenderer.invoke(IPC_CHANNELS.ttsReadAloudSegment, input); },
  readReadAloudChunk(input: ReadAloudReadInput): Promise<ReadAloudReadResult> { return ipcRenderer.invoke(IPC_CHANNELS.ttsReadAloudRead, input); },
  cancelReadAloud(requestId: string): Promise<void> { return ipcRenderer.invoke(IPC_CHANNELS.ttsReadAloudCancel, { requestId }); },
  getTtsSettings(): Promise<TtsSettingsSnapshot> {
    return ipcRenderer.invoke(IPC_CHANNELS.ttsSettingsGet);
  },
  saveTtsEnabled(enabled: boolean): Promise<TtsSettingsSnapshot> {
    return ipcRenderer.invoke(IPC_CHANNELS.ttsSettingsSave, { enabled });
  },
  saveTtsProfile(
    profile: TtsProfileSaveInput,
  ): Promise<TtsProfileSnapshot> {
    return ipcRenderer.invoke(IPC_CHANNELS.ttsProfileSave, profile);
  },
  deleteTtsProfile(id: string): Promise<TtsSettingsSnapshot> {
    return ipcRenderer.invoke(IPC_CHANNELS.ttsProfileDelete, { id });
  },
  activateTtsProfile(id: string): Promise<TtsSettingsSnapshot> {
    return ipcRenderer.invoke(IPC_CHANNELS.ttsProfileActivate, { id });
  },
  createTts(input: GenerationToolRequest<TtsToolInput>): Promise<TtsArtifact> {
    return ipcRenderer.invoke(IPC_CHANNELS.ttsCreate, input);
  },
  listTtsArtifacts(threadId: string): Promise<TtsArtifact[]> {
    return ipcRenderer.invoke(IPC_CHANNELS.ttsArtifactsList, { threadId });
  },
  readTtsArtifact(
    request: TtsArtifactReadRequest,
  ): Promise<TtsArtifactReadResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.ttsArtifactRead, request);
  },
  revealTtsArtifact(request: TtsArtifactReadRequest): Promise<void> {
    return ipcRenderer.invoke(IPC_CHANNELS.ttsArtifactReveal, request);
  },
  readImageView(request: ImageViewReadRequest): Promise<ImageViewReadResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.imageViewRead, request);
  },
  revealImageInFolder(request: ImageRevealInFolderRequest): Promise<void> {
    return ipcRenderer.invoke(IPC_CHANNELS.imageRevealInFolder, request);
  },
  listImageDisplayArtifacts(threadId: string): Promise<ImageDisplayArtifact[]> {
    return ipcRenderer.invoke(IPC_CHANNELS.imageDisplayArtifactsList, { threadId });
  },
  readImageDisplay(request: ImageDisplayArtifactReadRequest): Promise<ImageDisplayReadResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.imageDisplayRead, request);
  },
  onImageDisplayArtifactChanged(callback: (artifact: ImageDisplayArtifact) => void): () => void {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => {
      if (payload && typeof payload === "object") callback(payload as ImageDisplayArtifact);
    };
    ipcRenderer.on(IPC_CHANNELS.imageDisplayArtifactChanged, listener);
    return () => ipcRenderer.off(IPC_CHANNELS.imageDisplayArtifactChanged, listener);
  },
  listHtmlHostArtifacts(threadId: string): Promise<import("../shared/html-host").HtmlHostArtifact[]> {
    return ipcRenderer.invoke(IPC_CHANNELS.htmlHostArtifactsList, { threadId });
  },
  onHtmlHostArtifactChanged(
    callback: (artifact: import("../shared/html-host").HtmlHostArtifact) => void,
  ): () => void {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => {
      if (payload && typeof payload === "object") {
        callback(payload as import("../shared/html-host").HtmlHostArtifact);
      }
    };
    ipcRenderer.on(IPC_CHANNELS.htmlHostArtifactChanged, listener);
    return () => ipcRenderer.off(IPC_CHANNELS.htmlHostArtifactChanged, listener);
  },
  refreshHtmlHostingCapability(): Promise<import("../shared/html-host").HtmlHostingCapability> {
    return ipcRenderer.invoke(IPC_CHANNELS.centerServerHtmlHostingRefresh);
  },
  onImageGenerationArtifactChanged(callback: (artifact: ImageGenerationArtifact) => void): () => void {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => {
      if (payload && typeof payload === "object") callback(payload as ImageGenerationArtifact);
    };
    ipcRenderer.on(IPC_CHANNELS.imageGenerationArtifactChanged, listener);
    return () => ipcRenderer.off(IPC_CHANNELS.imageGenerationArtifactChanged, listener);
  },
  onTtsArtifactChanged(callback: (artifact: TtsArtifact) => void): () => void {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => {
      if (payload && typeof payload === "object") callback(payload as TtsArtifact);
    };
    ipcRenderer.on(IPC_CHANNELS.ttsArtifactChanged, listener);
    return () => ipcRenderer.off(IPC_CHANNELS.ttsArtifactChanged, listener);
  },
  getWebChatList(): Promise<WebChatListView> {
    return ipcRenderer.invoke(IPC_CHANNELS.webChatListGet);
  },
  saveWebChatList(snapshot: WebChatListSnapshot): Promise<WebChatListView> {
    return ipcRenderer.invoke(IPC_CHANNELS.webChatListSave, snapshot);
  },
  getSshBookmarks(): Promise<import("../shared/ssh-bookmarks").SshBookmarkView[]> {
    return ipcRenderer.invoke(IPC_CHANNELS.sshBookmarksGet);
  },
  saveSshBookmark(
    input: import("../shared/ssh-bookmarks").SshBookmarkSaveInput,
  ): Promise<import("../shared/ssh-bookmarks").SshBookmarkView> {
    return ipcRenderer.invoke(IPC_CHANNELS.sshBookmarksSave, input);
  },
  deleteSshBookmark(id: string): Promise<import("../shared/ssh-bookmarks").SshBookmarkView[]> {
    return ipcRenderer.invoke(IPC_CHANNELS.sshBookmarksDelete, { id });
  },
  connectSshBookmark(
    request: import("../shared/ipc").SshBookmarkConnectRequest,
  ): Promise<import("../shared/ssh-bookmarks").SshBookmarkConnectResult & { passwordAutoInject?: boolean }> {
    return ipcRenderer.invoke(IPC_CHANNELS.sshBookmarksConnect, request);
  },
  getDefaultSshKeyPath(): Promise<string> {
    return ipcRenderer.invoke(IPC_CHANNELS.sshBookmarksGetDefaultKeyPath);
  },
  getNotificationSettings(): Promise<NotificationSettingsSnapshot> {
    return ipcRenderer.invoke(IPC_CHANNELS.notificationSettingsGet);
  },
  saveNotificationSettings(settings: NotificationSettingsSnapshot): Promise<NotificationSettingsSnapshot> {
    return ipcRenderer.invoke(IPC_CHANNELS.notificationSettingsSave, settings);
  },
  getBrowserState(): Promise<BrowserViewState> {
    return ipcRenderer.invoke(IPC_CHANNELS.browserGetState);
  },
  listAgentBrowserProcesses(): Promise<import("../shared/browser").AgentBrowserProcessView[]> {
    return ipcRenderer.invoke(IPC_CHANNELS.browserAgentProcessesList);
  },
  stopAgentBrowserProcess(id: string): Promise<void> {
    return ipcRenderer.invoke(IPC_CHANNELS.browserAgentProcessStop, { id });
  },
  browserDevPrepareAgentCdp(threadId: string): Promise<{ cdpPort: number }> {
    return ipcRenderer.invoke(IPC_CHANNELS.browserDevPrepareAgentCdp, { threadId });
  },
  browserSetVisible(request: BrowserSetVisibleRequest): Promise<BrowserViewState> {
    return ipcRenderer.invoke(IPC_CHANNELS.browserSetVisible, request);
  },
  browserRegisterGuest(request: BrowserRegisterGuestRequest): Promise<BrowserViewState> {
    return ipcRenderer.invoke(IPC_CHANNELS.browserRegisterGuest, request);
  },
  browserNavigate(request: BrowserNavigateRequest): Promise<BrowserViewState> {
    return ipcRenderer.invoke(IPC_CHANNELS.browserNavigate, request);
  },
  browserOpen(request?: BrowserOpenRequest | string): Promise<BrowserViewState> {
    if (typeof request === "string") {
      return ipcRenderer.invoke(IPC_CHANNELS.browserOpen, { url: request, reveal: true });
    }
    return ipcRenderer.invoke(IPC_CHANNELS.browserOpen, request ?? {});
  },
  browserFocus(request: BrowserFocusRequest): Promise<BrowserViewState> {
    return ipcRenderer.invoke(IPC_CHANNELS.browserFocus, request);
  },
  browserCloseInstance(request: BrowserCloseRequest): Promise<BrowserViewState> {
    return ipcRenderer.invoke(IPC_CHANNELS.browserClose, request);
  },
  browserSetUiScope(request: BrowserSetUiScopeRequest): Promise<BrowserViewState> {
    return ipcRenderer.invoke(IPC_CHANNELS.browserSetUiScope, request);
  },
  browserGoBack(browserId?: string): Promise<BrowserViewState> {
    return ipcRenderer.invoke(IPC_CHANNELS.browserGoBack, browserId ? { browserId } : undefined);
  },
  browserGoForward(browserId?: string): Promise<BrowserViewState> {
    return ipcRenderer.invoke(IPC_CHANNELS.browserGoForward, browserId ? { browserId } : undefined);
  },
  browserSetViewport(request: BrowserSetViewportRequest): Promise<BrowserViewState> {
    return ipcRenderer.invoke(IPC_CHANNELS.browserSetViewport, request);
  },
  browserReload(browserId?: string): Promise<BrowserViewState> {
    return ipcRenderer.invoke(IPC_CHANNELS.browserReload, browserId ? { browserId } : undefined);
  },
  browserOpenExternal(browserId?: string): Promise<{ ok: true }> {
    return ipcRenderer.invoke(IPC_CHANNELS.browserOpenExternal, browserId ? { browserId } : undefined);
  },
  browserDownloadAction(request: import("../shared/browser-downloads").BrowserDownloadActionRequest): Promise<{ cancelled: boolean }> {
    return ipcRenderer.invoke(IPC_CHANNELS.browserDownloadAction, request);
  },
  browserCaptureSelection(request: import("../shared/browser-selection").BrowserSelectionRequest): Promise<import("../shared/browser-selection").BrowserSelection | null> {
    return ipcRenderer.invoke(IPC_CHANNELS.browserCaptureSelection, request);
  },
  browserCancelSelection(browserId: string): Promise<void> {
    return ipcRenderer.invoke(IPC_CHANNELS.browserCancelSelection, { browserId });
  },
  browserReadSelection(id: string): Promise<import("../shared/browser-selection").BrowserSelectionPreview> {
    return ipcRenderer.invoke(IPC_CHANNELS.browserReadSelection, { id });
  },
  browserRevealSelection(id: string): Promise<BrowserViewState> {
    return ipcRenderer.invoke(IPC_CHANNELS.browserRevealSelection, { id });
  },
  onBrowserStateChanged(callback: (state: BrowserViewState) => void): () => void {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => {
      if (payload && typeof payload === "object") {
        callback(payload as BrowserViewState);
      }
    };
    ipcRenderer.on(IPC_CHANNELS.browserStateChanged, listener);
    return () => ipcRenderer.off(IPC_CHANNELS.browserStateChanged, listener);
  },
  onBrowserAgentPresence(callback: (event: BrowserAgentPresenceEvent) => void): () => void {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => {
      if (payload && typeof payload === "object" && "type" in payload) {
        callback(payload as BrowserAgentPresenceEvent);
      }
    };
    ipcRenderer.on(IPC_CHANNELS.browserAgentPresence, listener);
    return () => ipcRenderer.off(IPC_CHANNELS.browserAgentPresence, listener);
  },
  getAsrSettings(): Promise<AsrSettingsSnapshot> {
    return ipcRenderer.invoke(IPC_CHANNELS.asrSettingsGet);
  },
  saveAsrSettings(settings: AsrSettingsInput): Promise<AsrSettingsSnapshot> {
    return ipcRenderer.invoke(IPC_CHANNELS.asrSettingsSave, settings);
  },
  listAsrProfiles(): Promise<AsrProfilesSnapshot> {
    return ipcRenderer.invoke(IPC_CHANNELS.asrProfilesList);
  },
  saveAsrProfile(profile: AsrProfileSaveInput): Promise<AsrProfileSnapshot> {
    return ipcRenderer.invoke(IPC_CHANNELS.asrProfileSave, profile);
  },
  deleteAsrProfile(request: AsrProfileDeleteRequest): Promise<AsrProfilesSnapshot> {
    return ipcRenderer.invoke(IPC_CHANNELS.asrProfileDelete, request);
  },
  activateAsrProfile(request: AsrProfileActivateRequest): Promise<AsrSettingsSnapshot> {
    return ipcRenderer.invoke(IPC_CHANNELS.asrProfileActivate, request);
  },
  saveAsrInputDevice(settings: AsrInputDeviceSaveInput): Promise<AsrProfilesSnapshot> {
    return ipcRenderer.invoke(IPC_CHANNELS.asrInputDeviceSave, settings);
  },
  transcribeAsr(request: AsrTranscribeRequest): Promise<AsrTranscribeResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.asrTranscribe, request);
  },
  getGitStatus(workspacePath: string): Promise<GitWorkingTreeStatus> {
    return ipcRenderer.invoke(IPC_CHANNELS.gitGetStatus, workspacePath);
  },
  getWorkspaceDiff(workspacePath: string, options?: { refresh?: boolean }): Promise<WorkspaceDiffResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.gitGetWorkspaceDiff, workspacePath, options);
  },
  getWorkspaceFileDiff(request: GitGetWorkspaceFileDiffRequest): Promise<WorkspaceFileDiffResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.gitGetWorkspaceFileDiff, request);
  },
  discardWorkspaceChanges(
    request: GitDiscardWorkspaceChangesRequest,
  ): Promise<GitDiscardWorkspaceChangesResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.gitDiscardWorkspaceChanges, request);
  },
  listGitCommits(request: GitListCommitsRequest): Promise<GitListCommitsResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.gitListCommits, request);
  },
  checkoutGitBranch(request: GitCheckoutBranchRequest): Promise<GitWorkingTreeStatus> {
    return ipcRenderer.invoke(IPC_CHANNELS.gitCheckoutBranch, request);
  },
  createGitBranch(request: GitCreateBranchRequest): Promise<GitWorkingTreeStatus> {
    return ipcRenderer.invoke(IPC_CHANNELS.gitCreateBranch, request);
  },
  generateGitCommitMessage(
    request: GitGenerateCommitMessageRequest,
    options?: { onDelta?: (text: string) => void },
  ): Promise<GitGenerateCommitMessageResult> {
    const requestId = `commit-msg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    const listener = (_event: Electron.IpcRendererEvent, payload: GitGenerateCommitMessageDeltaPayload) => {
      if (payload.requestId === requestId) {
        options?.onDelta?.(payload.text);
      }
    };
    if (options?.onDelta) {
      ipcRenderer.on(IPC_CHANNELS.gitGenerateCommitMessageDelta, listener);
    }
    return ipcRenderer
      .invoke(IPC_CHANNELS.gitGenerateCommitMessage, { ...request, requestId })
      .finally(() => {
        if (options?.onDelta) {
          ipcRenderer.off(IPC_CHANNELS.gitGenerateCommitMessageDelta, listener);
        }
      });
  },
  listGitCommitModelOptions(
    request: GitListCommitModelOptionsRequest,
  ): Promise<GitListCommitModelOptionsResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.gitListCommitModelOptions, request);
  },
  listApprovalModelOptions(
    request: GitListCommitModelOptionsRequest,
  ): Promise<GitListCommitModelOptionsResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.approvalListModelOptions, request);
  },
  commitGitChanges(request: GitCommitRequest): Promise<GitCommitResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.gitCommit, request);
  },
  pushGitChanges(request: GitPushRequest): Promise<GitPushResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.gitPush, request);
  },
  fetchGitChanges(request: GitFetchRequest): Promise<GitFetchResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.gitFetch, request);
  },
  pullGitChanges(request: GitPullRequest): Promise<GitPullResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.gitPull, request);
  },
  getProxyBridgeSettings(): Promise<ProxyBridgeSettingsSnapshot> {
    return ipcRenderer.invoke(IPC_CHANNELS.proxyBridgeSettingsGet);
  },
  saveProxyBridgeSettings(settings: ProxyBridgeSettingsSnapshot): Promise<ProxyBridgeSettingsSnapshot> {
    return ipcRenderer.invoke(IPC_CHANNELS.proxyBridgeSettingsSave, settings);
  },
  getIntegratedWebSearchSettings(): Promise<IntegratedWebSearchSettingsSnapshot> {
    return ipcRenderer.invoke(IPC_CHANNELS.integratedWebSearchSettingsGet);
  },
  saveIntegratedWebSearchSettings(
    settings: IntegratedWebSearchSettingsSaveInput,
  ): Promise<IntegratedWebSearchSettingsSnapshot> {
    return ipcRenderer.invoke(IPC_CHANNELS.integratedWebSearchSettingsSave, settings);
  },
  testIntegratedWebSearch(input: IntegratedWebSearchTestInput): Promise<IntegratedWebSearchTestResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.integratedWebSearchTest, input);
  },
  getSupabaseDeployment(): Promise<SupabaseDeploymentSnapshot> {
    return ipcRenderer.invoke(IPC_CHANNELS.supabaseDeploymentGet);
  },
  authorizeSupabaseDeployment(token: string): Promise<SupabaseDeploymentSnapshot> {
    return ipcRenderer.invoke(IPC_CHANNELS.supabaseDeploymentAuthorize, token);
  },
  forgetSupabaseDeployment(): Promise<SupabaseDeploymentSnapshot> {
    return ipcRenderer.invoke(IPC_CHANNELS.supabaseDeploymentForget);
  },
  inspectSupabaseDeployment(projectRef: string): Promise<SupabaseDeploymentSnapshot> {
    return ipcRenderer.invoke(IPC_CHANNELS.supabaseDeploymentInspect, projectRef);
  },
  runSupabaseDeployment(projectRef: string): Promise<SupabaseDeploymentSnapshot> {
    return ipcRenderer.invoke(IPC_CHANNELS.supabaseDeploymentRun, projectRef);
  },
  getSupabaseDeploymentConnection(projectRef: string): Promise<SupabaseDeploymentConnection> {
    return ipcRenderer.invoke(IPC_CHANNELS.supabaseDeploymentConnection, projectRef);
  },
  onSupabaseDeploymentChanged(callback: (snapshot: SupabaseDeploymentSnapshot) => void): () => void {
    const listener = (_event: Electron.IpcRendererEvent, payload: SupabaseDeploymentSnapshot) => callback(payload);
    ipcRenderer.on(IPC_CHANNELS.supabaseDeploymentChanged, listener);
    return () => ipcRenderer.off(IPC_CHANNELS.supabaseDeploymentChanged, listener);
  },
  getCenterServerSettings(): Promise<CenterServerSettingsSnapshot> {
    return ipcRenderer.invoke(IPC_CHANNELS.centerServerSettingsGet);
  },
  saveCenterServerSettings(input: CenterServerSettingsInput): Promise<CenterServerSettingsSnapshot> {
    return ipcRenderer.invoke(IPC_CHANNELS.centerServerSettingsSave, input);
  },
  registerCenterServerDesktop(
    request: CenterServerRegisterDesktopRequest,
  ): Promise<CenterServerRegisterDesktopResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.centerServerRegisterDesktop, request);
  },
  signUpCenterServer(request: CenterServerSignUpRequest): Promise<CenterServerAccountAuthResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.centerServerSignUp, request);
  },
  signInCenterServer(request: CenterServerSignInRequest): Promise<CenterServerAccountAuthResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.centerServerSignIn, request);
  },
  createCenterServerPairing(): Promise<CenterServerCreatePairingResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.centerServerCreatePairing);
  },
  buildCenterServerConnectQr(): Promise<{ qrPayload: string }> {
    return ipcRenderer.invoke(IPC_CHANNELS.centerServerBuildConnectQr);
  },
  listCenterServerBindings(): Promise<CenterServerDeviceBindingView[]> {
    return ipcRenderer.invoke(IPC_CHANNELS.centerServerListBindings);
  },
  listCenterServerPresence(): Promise<CenterServerDevicePresenceView[]> {
    return ipcRenderer.invoke(IPC_CHANNELS.centerServerListPresence);
  },
  revokeCenterServerBinding(bindingId: string): Promise<CenterServerDeviceBindingView> {
    return ipcRenderer.invoke(IPC_CHANNELS.centerServerRevokeBinding, bindingId);
  },
  connectCenterServer(): Promise<CenterServerSettingsSnapshot> {
    return ipcRenderer.invoke(IPC_CHANNELS.centerServerConnect);
  },
  disconnectCenterServer(): Promise<CenterServerSettingsSnapshot> {
    return ipcRenderer.invoke(IPC_CHANNELS.centerServerDisconnect);
  },
  removeCenterServerConnection(
    options?: CenterServerRemoveConnectionOptions,
  ): Promise<CenterServerRemoveConnectionResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.centerServerRemoveConnection, options);
  },
  testCenterServerConnection(
    request: CenterServerTestConnectionRequest,
  ): Promise<CenterServerTestConnectionResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.centerServerTestConnection, request);
  },
  getCenterServerVaultStatus(): Promise<CenterServerVaultStatus> {
    return ipcRenderer.invoke(IPC_CHANNELS.centerServerVaultStatusGet);
  },
  syncCenterServerConfig(mode?: "pull" | "push" | "reconcile"): Promise<CenterServerSyncConfigResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.centerServerSyncConfig, mode);
  },
  syncCenterServerConfigDomain(
    domain: CenterServerSyncDomain,
    mode: "pull" | "push",
  ): Promise<CenterServerSyncDomainResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.centerServerSyncConfigDomain, domain, mode);
  },
  getCenterServerSyncStatus(): Promise<CenterServerSyncStatusSnapshot> {
    return ipcRenderer.invoke(IPC_CHANNELS.centerServerGetSyncStatus);
  },
  unlockCenterServerVaultWithPassword(password: string): Promise<{
    hasVaultKey: boolean;
    vaultStatus: CenterServerVaultStatus;
  }> {
    return ipcRenderer.invoke(IPC_CHANNELS.centerServerUnlockVaultWithPassword, password);
  },
  wrapCenterServerVaultWithPassword(password: string): Promise<{
    vaultStatus: CenterServerVaultStatus;
  }> {
    return ipcRenderer.invoke(IPC_CHANNELS.centerServerWrapVaultWithPassword, password);
  },
  requestCenterServerVaultClaim(): Promise<CenterServerRequestVaultClaimResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.centerServerRequestVaultClaim);
  },
  listCenterServerPendingVaultClaims(): Promise<CenterServerVaultClaimView[]> {
    return ipcRenderer.invoke(IPC_CHANNELS.centerServerListPendingVaultClaims);
  },
  approveCenterServerVaultClaim(claimId: string): Promise<CenterServerApproveVaultClaimResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.centerServerApproveVaultClaim, claimId);
  },
  submitCenterServerVaultClaimCode(code: string): Promise<CenterServerSubmitVaultClaimCodeResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.centerServerSubmitVaultClaimCode, code);
  },
  cancelCenterServerVaultClaim(): Promise<CenterServerVaultStatus> {
    return ipcRenderer.invoke(IPC_CHANNELS.centerServerCancelVaultClaim);
  },
  onCenterServerStatusChange(callback: (snapshot: CenterServerSettingsSnapshot) => void): () => void {
    const listener = (_event: Electron.IpcRendererEvent, payload: CenterServerSettingsSnapshot) =>
      callback(payload);
    ipcRenderer.on(IPC_CHANNELS.centerServerStatusChanged, listener);
    return () => ipcRenderer.off(IPC_CHANNELS.centerServerStatusChanged, listener);
  },
  onEcoDeepLinkOpen(callback: (url: string) => void): () => void {
    const listener = (_event: Electron.IpcRendererEvent, payload: string) => callback(payload);
    ipcRenderer.on(IPC_CHANNELS.appEcoDeepLinkOpen, listener);
    return () => ipcRenderer.off(IPC_CHANNELS.appEcoDeepLinkOpen, listener);
  },
  listSchedules(): Promise<SchedulingSnapshot> { return ipcRenderer.invoke(IPC_CHANNELS.schedulingList); },
  createSchedule(input: ScheduleCreateInput): Promise<ScheduleDefinition> { return ipcRenderer.invoke(IPC_CHANNELS.schedulingCreate, input); },
  updateSchedule(input: ScheduleUpdateInput): Promise<ScheduleDefinition> { return ipcRenderer.invoke(IPC_CHANNELS.schedulingUpdate, input); },
  deleteSchedule(id: string): Promise<void> { return ipcRenderer.invoke(IPC_CHANNELS.schedulingDelete, id); },
  runScheduleNow(input: { id: string; requestId: string }): Promise<ScheduleOccurrence> { return ipcRenderer.invoke(IPC_CHANNELS.schedulingRunNow, input); },
  previewSchedule(trigger: ScheduleTrigger): Promise<string[]> { return ipcRenderer.invoke(IPC_CHANNELS.schedulingPreview, trigger); },
  onSchedulesChanged(callback: () => void): () => void {
    const listener = () => callback();
    ipcRenderer.on(IPC_CHANNELS.schedulingChanged, listener);
    return () => ipcRenderer.off(IPC_CHANNELS.schedulingChanged, listener);
  },
  startThread(request: ThreadStartRequest): Promise<ThreadStartResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.threadStart, request);
  },
  enqueueThreadFollowUp(request: ThreadFollowUpEnqueueRequest): Promise<ThreadFollowUpMutationResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.threadFollowUpEnqueue, request);
  },
  escalateThreadFollowUp(request: ThreadFollowUpEscalateRequest): Promise<ThreadFollowUpMutationResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.threadFollowUpEscalate, request);
  },
  setThreadFollowUpEditing(request: ThreadFollowUpEditingRequest): Promise<ThreadFollowUpEditingResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.threadFollowUpEditing, request);
  },
  setThreadFollowUpQueuePaused(
    request: ThreadFollowUpQueuePausedRequest,
  ): Promise<ThreadFollowUpQueuePausedResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.threadFollowUpQueuePaused, request);
  },
  listThreadFollowUps(threadId: string): Promise<ThreadFollowUpListResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.threadFollowUpList, threadId);
  },
  cancelThreadFollowUp(request: ThreadFollowUpCancelRequest): Promise<ThreadFollowUpMutationResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.threadFollowUpCancel, request);
  },
  updateThreadFollowUp(request: ThreadFollowUpUpdateRequest): Promise<ThreadFollowUpMutationResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.threadFollowUpUpdate, request);
  },
  reorderThreadFollowUps(request: ThreadFollowUpReorderRequest): Promise<ThreadFollowUpListResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.threadFollowUpReorder, request);
  },
  cancelThread(request: ThreadCancelRequest): Promise<void> {
    return ipcRenderer.invoke(IPC_CHANNELS.threadCancel, request);
  },
  rollbackToThread(threadId: string): Promise<ThreadRollbackResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.threadRollbackTo, threadId);
  },
  getThreadAppliedDiff(threadId: string): Promise<ThreadAppliedDiffResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.threadGetAppliedDiff, threadId);
  },
  revertThreadAppliedDiff(threadId: string): Promise<ThreadRevertAppliedDiffResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.threadRevertAppliedDiff, threadId);
  },
  getPendingPlan(threadId: string): Promise<ThreadPendingPlan | undefined> {
    return ipcRenderer.invoke(IPC_CHANNELS.threadGetPendingPlan, threadId);
  },
  getApprovedPlan(threadId: string): Promise<ThreadPendingPlan | undefined> {
    return ipcRenderer.invoke(IPC_CHANNELS.threadGetApprovedPlan, threadId);
  },
  getPendingClarification(threadId: string): Promise<ClarificationRequest | undefined> {
    return ipcRenderer.invoke(IPC_CHANNELS.clarificationGetPending, threadId);
  },
  submitClarification(payload: ClarificationSubmitPayload): Promise<ClarificationSubmitResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.clarificationSubmit, payload);
  },
  dismissClarification(payload: ClarificationDismissPayload): Promise<{ ok: true }> {
    return ipcRenderer.invoke(IPC_CHANNELS.clarificationDismiss, payload);
  },
  getPendingBashApproval(threadId: string): Promise<BashApprovalRequest | undefined> {
    return ipcRenderer.invoke(IPC_CHANNELS.bashApprovalGetPending, threadId);
  },
  resolveBashApproval(payload: BashApprovalResolvePayload): Promise<{
    ok: true;
    alreadyResolved?: boolean;
  }> {
    return ipcRenderer.invoke(IPC_CHANNELS.bashApprovalResolve, payload);
  },
  approvePlan(request: ThreadApprovePlanRequest): Promise<{ thread?: ThreadSummary }> {
    return ipcRenderer.invoke(IPC_CHANNELS.threadApprovePlan, request);
  },
  dismissPlan(request: ThreadDismissPlanRequest): Promise<{ thread?: ThreadSummary }> {
    return ipcRenderer.invoke(IPC_CHANNELS.threadDismissPlan, request);
  },
  getWorktreeStatus(threadId: string): Promise<WorktreeStatusResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.worktreeGetStatus, threadId);
  },
  applyWorktree(threadId: string): Promise<WorktreeApplyResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.worktreeApply, threadId);
  },
  searchComposerReferences(request: import("../shared/composer-references").ComposerReferenceSearchRequest): Promise<import("../shared/composer-references").ComposerReferenceSearchResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.composerReferencesSearch, request);
  },
  listThreads(): Promise<ThreadSummary[]> {
    return ipcRenderer.invoke(IPC_CHANNELS.threadList);
  },
  getThread(threadId: string): Promise<ThreadSummary | undefined> {
    return ipcRenderer.invoke(IPC_CHANNELS.threadGet, threadId);
  },
  listProjectTodos(): Promise<ProjectTodo[]> { return ipcRenderer.invoke(IPC_CHANNELS.projectTodoList); },
  onProjectTodosChanged(callback: () => void): () => void {
    const listener = () => callback();
    ipcRenderer.on(IPC_CHANNELS.projectTodoChanged, listener);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.projectTodoChanged, listener);
  },
  getProjectTodo(id: string, includeImageData = true): Promise<ProjectTodo> { return ipcRenderer.invoke(IPC_CHANNELS.projectTodoGet, id, includeImageData); },
  saveProjectTodo(input: ProjectTodoSave): Promise<ProjectTodo> { return ipcRenderer.invoke(IPC_CHANNELS.projectTodoSave, input); },
  markProjectTodoComposed(input: ProjectTodoCompose): Promise<ProjectTodo> { return ipcRenderer.invoke(IPC_CHANNELS.projectTodoCompose, input); },
  trashProjectTodo(input: ProjectTodoTrash): Promise<number> { return ipcRenderer.invoke(IPC_CHANNELS.projectTodoTrash, input); },
  getComposerDraft(contextKey: string): Promise<ComposerDraftRecord | undefined> {
    return ipcRenderer.invoke(IPC_CHANNELS.composerDraftGet, contextKey);
  },
  saveComposerDraft(request: ComposerDraftSaveRequest): Promise<ComposerDraftRecord | undefined> {
    return ipcRenderer.invoke(IPC_CHANNELS.composerDraftSave, request);
  },
  deleteComposerDraft(request: string | ComposerDraftDeleteRequest): Promise<ComposerDraftDeleteResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.composerDraftDelete, request);
  },
  stagePromptImage(request: PromptImageStageRequest): Promise<PromptImageStageResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.promptImageStage, request);
  },
  releasePromptImages(request: PromptImageReleaseRequest): Promise<{ ok: true }> {
    return ipcRenderer.invoke(IPC_CHANNELS.promptImageRelease, request);
  },
  readPromptImageChunk(request: {
    contextKey: string;
    contentRef: string;
    mediaType: PromptImageAttachment["mediaType"];
    offset: number;
    maxBytes?: number;
  }): Promise<PromptImageReadChunkResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.promptImageReadChunk, request);
  },
  sessionBootstrap(threadId: string): Promise<ThreadSessionBootstrapResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.threadSessionBootstrap, threadId);
  },
  conversationV2Capabilities(): Promise<ConversationCapabilities> {
    return ipcRenderer.invoke(IPC_CHANNELS.conversationCapabilities);
  },
  conversationV2Bootstrap(
    conversationId: string,
    options?: { pageSize?: number; maxBytes?: number },
  ): Promise<ConversationBootstrap> {
    return ipcRenderer.invoke(IPC_CHANNELS.conversationBootstrap, {
      conversationId,
      ...options,
    });
  },
  conversationV2Projection(conversationId: string): Promise<ConversationV2ProjectionExtras> {
    return ipcRenderer.invoke(IPC_CHANNELS.conversationProjection, { conversationId });
  },
  conversationV2MessagesPage(
    conversationId: string,
    options?: { beforeCursor?: string; limit?: number; maxBytes?: number },
  ): Promise<ConversationMessagesPage> {
    return ipcRenderer.invoke(IPC_CHANNELS.conversationMessagesPage, {
      conversationId,
      ...options,
    });
  },
  conversationV2DetailsPage(
    conversationId: string,
    runId: string,
    options?: {
      cursor?: string;
      limit?: number;
      maxBytes?: number;
      toolCallId?: string;
      agentInstanceId?: string;
    },
  ): Promise<ConversationDetailsPage> {
    return ipcRenderer.invoke(IPC_CHANNELS.conversationDetailsPage, {
      conversationId,
      runId,
      ...options,
    });
  },
  conversationV2ToolsPage(
    conversationId: string,
    runId: string,
    options?: {
      cursor?: string;
      limit?: number;
      maxBytes?: number;
      toolCallId?: string;
      agentInstanceId?: string;
    },
  ): Promise<ConversationToolsPage> {
    return ipcRenderer.invoke(IPC_CHANNELS.conversationToolsPage, {
      conversationId,
      runId,
      ...options,
    });
  },
  conversationV2Sync(request: {
    conversationId: string;
    storeEpoch: string;
    afterSeq: number;
    throughSeq?: number;
    maxEvents?: number;
    maxBytes?: number;
  }): Promise<ConversationSyncPage> {
    return ipcRenderer.invoke(IPC_CHANNELS.conversationSync, request);
  },
  conversationV2Head(conversationId: string): Promise<ConversationHead> {
    return ipcRenderer.invoke(IPC_CHANNELS.conversationHead, conversationId);
  },
  conversationV2MessageGet(
    conversationId: string,
    messageId: string,
  ): Promise<ConversationMessage | undefined> {
    return ipcRenderer.invoke(IPC_CHANNELS.conversationMessageGet, { conversationId, messageId });
  },
  conversationV2RunGet(conversationId: string, runId: string): Promise<ConversationRun | undefined> {
    return ipcRenderer.invoke(IPC_CHANNELS.conversationRunGet, { conversationId, runId });
  },
  conversationV2DetailGet(
    conversationId: string,
    itemId: string,
  ): Promise<ConversationDetailItem | undefined> {
    return ipcRenderer.invoke(IPC_CHANNELS.conversationDetailGet, { conversationId, itemId });
  },
  conversationV2SendMessage(request: {
    principalId: string;
    conversationId: string;
    clientCommandId: string;
    text: string;
    turnId?: string;
    messageId?: string;
    attachments?: PromptImageAttachment[];
  }): Promise<ConversationSendMessageResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.conversationSendMessage, request);
  },
  deleteThread(request: ThreadDeleteRequest): Promise<ThreadDeleteResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.threadDelete, request);
  },
  regenerateThreadTitle(threadId: string): Promise<{ ok: true; regenerated: boolean }> {
    return ipcRenderer.invoke(IPC_CHANNELS.threadRegenerateTitle, threadId);
  },
  getUserMessageEdit(request: ThreadUserMessageEditGetRequest): Promise<ThreadUserMessageEditGetResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.threadUserMessageEditGet, request);
  },
  rewriteThreadFromMessage(request: ThreadRewriteFromMessageRequest): Promise<ThreadContinueResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.threadRewriteFromMessage, request);
  },
  forkThreadFromMessage(request: ThreadForkFromMessageRequest): Promise<ThreadForkFromMessageResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.threadForkFromMessage, request);
  },
  retryThreadFromMessage(request: ThreadRetryFromMessageRequest): Promise<ThreadContinueResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.threadRetryFromMessage, request);
  },
  continueCodexThread(request: ThreadRetryFromMessageRequest): Promise<ThreadContinueResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.threadRetryFromMessage, { ...request, continueInterrupted: true });
  },
  getStorageUsage(): Promise<StorageUsageSnapshot> {
    return ipcRenderer.invoke(IPC_CHANNELS.storageGetUsage);
  },
  cleanupStorage(request: StorageCleanupRequest): Promise<StorageCleanupResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.storageCleanup, request);
  },
  onThreadEvent(callback: (event: unknown) => void): () => void {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => callback(payload);
    ipcRenderer.on(IPC_CHANNELS.threadEventsSubscribe, listener);
    return () => ipcRenderer.off(IPC_CHANNELS.threadEventsSubscribe, listener);
  },
};

contextBridge.exposeInMainWorld("eco", api);

export type EcoDesktopApi = typeof api;
