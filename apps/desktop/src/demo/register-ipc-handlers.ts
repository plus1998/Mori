import { ipcMain, type WebContents } from "electron";
import type { BrowserViewState } from "../shared/browser";
import { defaultBrowserSettings } from "../shared/browser";
import { defaultComputerUseSettings } from "../shared/computer-use";
import type { DesktopUpdateState } from "../shared/desktop-update";
import type { IntegrationAvailabilitySnapshot } from "../shared/integrations";
import { IPC_CHANNELS } from "../shared/ipc";
import { defaultShortcutBindings } from "../shared/keyboard-shortcuts";
import { DEMO_THREAD_ID, DEMO_WORKSPACE_PATH } from "./constants";
import { getDemoFeedReplayState } from "./feed-replay-bootstrap";
import {
  demoCandidateModels,
  demoCenterServerSettings,
  demoCoreAvailability,
  demoGitSettings,
  demoGitStatus,
  demoIntegratedWebSearchSettings,
  demoMcpSettings,
  demoModelSettings,
  demoPersonalizationSettings,
  demoProvider,
  demoProxyBridgeSettings,
  demoThreads,
  demoWorkflowSettings,
  demoWorkspace,
  demoWorkspaceInspect,
  resolveDemoThreadId,
} from "./fixtures";
import { createQueueDemoScene } from "./queue-scene";

export interface DemoRuntimeState {
  pendingThreadOpenId?: string;
}

export const demoRuntimeState: DemoRuntimeState = {
  pendingThreadOpenId: DEMO_THREAD_ID,
};

const queueScene = process.env.ECO_DEMO_SCENE === "queue" ? createQueueDemoScene() : undefined;

function effectiveDemoThreads() {
  if (queueScene) return [queueScene.thread];
  const replay = getDemoFeedReplayState();
  return replay.enabled && replay.threads.length > 0 ? replay.threads : demoThreads;
}

function effectiveDemoThreadId(payload: unknown): string | undefined {
  return resolveDemoThreadId(payload) ?? getDemoFeedReplayState().defaultThreadId;
}

function buildDemoSessionBootstrapForThread(threadId: string) {
  const thread = effectiveDemoThreads().find((entry) => entry.id === threadId);
  return {
    thread,
    followUps: queueScene?.followUps ?? [],
  };
}

const DEMO_UPDATE_CURRENT = "0.1.0-beta.2";
const DEMO_UPDATE_AVAILABLE = "0.1.0-beta.3";
const DEMO_UPDATE_RELEASE_URL = "https://github.com/plus1998/Mori/releases";

let demoUpdateState: DesktopUpdateState = {
  phase: "available",
  capability: "auto",
  currentVersion: DEMO_UPDATE_CURRENT,
  availableVersion: DEMO_UPDATE_AVAILABLE,
  channel: "beta",
  releaseUrl: DEMO_UPDATE_RELEASE_URL,
};

let demoUpdateTimer: ReturnType<typeof setInterval> | undefined;
let demoUpdateTarget: WebContents | undefined;

function publishDemoUpdateState(next: DesktopUpdateState, target?: WebContents): DesktopUpdateState {
  demoUpdateState = next;
  const recipients = new Set<WebContents>();
  if (target && !target.isDestroyed()) {
    recipients.add(target);
  }
  if (demoUpdateTarget && !demoUpdateTarget.isDestroyed()) {
    recipients.add(demoUpdateTarget);
  }
  for (const webContents of recipients) {
    webContents.send(IPC_CHANNELS.appUpdateStateChanged, demoUpdateState);
  }
  return demoUpdateState;
}

function clearDemoUpdateTimer(): void {
  if (demoUpdateTimer) {
    clearInterval(demoUpdateTimer);
    demoUpdateTimer = undefined;
  }
}

function rememberDemoUpdateTarget(event?: Electron.IpcMainInvokeEvent): void {
  if (event?.sender && !event.sender.isDestroyed()) {
    demoUpdateTarget = event.sender;
  }
}

function startDemoUpdateDownload(event?: Electron.IpcMainInvokeEvent): DesktopUpdateState {
  rememberDemoUpdateTarget(event);
  clearDemoUpdateTimer();
  let percent = 0;
  publishDemoUpdateState(
    {
      phase: "downloading",
      capability: "auto",
      currentVersion: DEMO_UPDATE_CURRENT,
      availableVersion: DEMO_UPDATE_AVAILABLE,
      channel: "beta",
      releaseUrl: DEMO_UPDATE_RELEASE_URL,
      progress: { percent: 0, transferred: 0, total: 100, bytesPerSecond: 0 },
    },
    event?.sender,
  );
  demoUpdateTimer = setInterval(() => {
    percent = Math.min(100, percent + 12);
    if (percent >= 100) {
      clearDemoUpdateTimer();
      publishDemoUpdateState({
        phase: "downloaded",
        capability: "auto",
        currentVersion: DEMO_UPDATE_CURRENT,
        availableVersion: DEMO_UPDATE_AVAILABLE,
        channel: "beta",
        releaseUrl: DEMO_UPDATE_RELEASE_URL,
      });
      return;
    }
    publishDemoUpdateState({
      phase: "downloading",
      capability: "auto",
      currentVersion: DEMO_UPDATE_CURRENT,
      availableVersion: DEMO_UPDATE_AVAILABLE,
      channel: "beta",
      releaseUrl: DEMO_UPDATE_RELEASE_URL,
      progress: {
        percent,
        transferred: percent,
        total: 100,
        bytesPerSecond: 12,
      },
    });
  }, 220);
  return demoUpdateState;
}

const demoIntegrationAvailability: IntegrationAvailabilitySnapshot = {
  integrations: [
    {
      id: "browser",
      enabled: false,
      available: true,
    },
    {
      id: "computerUse",
      enabled: false,
      available: false,
      reason: "演示模式未启用电脑操控",
    },
    {
      id: "imageGeneration",
      enabled: false,
      available: false,
      reason: "演示模式未配置创意绘画 Profile",
    },
  ],
};

const demoBrowserState: BrowserViewState = {
  uiScopeId: "personal",
  instances: [],
  guestInstances: [],
  allGuestInstances: [],
  allInstances: [],
  url: "",
  title: "",
  canGoBack: false,
  canGoForward: false,
  isLoading: false,
  visible: false,
  agentIntegrationEnabled: false,
  agentBrowserAvailable: true,
};

type DemoHandler = (payload?: unknown, event?: Electron.IpcMainInvokeEvent) => unknown | Promise<unknown>;

export interface RegisterDemoIpcHandlersOptions {
  onRendererReady?: (webContents: WebContents) => void;
}

const EVENT_CHANNELS = new Set<string>([
  IPC_CHANNELS.appMenuCommand,
  IPC_CHANNELS.appUpdateStateChanged,
  IPC_CHANNELS.appThreadOpenRequested,
  IPC_CHANNELS.centerServerStatusChanged,
  IPC_CHANNELS.threadEventsSubscribe,
  IPC_CHANNELS.terminalEvent,
  IPC_CHANNELS.workspacePackageJsonChanged,
  IPC_CHANNELS.browserStateChanged,
  IPC_CHANNELS.browserAgentPresence,
  IPC_CHANNELS.gitGenerateCommitMessageDelta,
  IPC_CHANNELS.gitRemoteFetched,
]);

const handlers: Partial<Record<string, DemoHandler>> = {
  [IPC_CHANNELS.keyboardShortcutsGet]: () => ({ bindings: defaultShortcutBindings(process.platform) }),
  [IPC_CHANNELS.schedulingList]: () => ({ schedules: [], occurrences: [] }),
  [IPC_CHANNELS.appRendererReady]: (_payload, event) => {
    if (event?.sender) {
      demoUpdateTarget = event.sender;
      demoRendererReadyHook?.(event.sender);
    }
    return { ok: true as const };
  },
  [IPC_CHANNELS.appSetThemeSource]: (payload) => ({ themeSource: payload ?? "dark" }),
  [IPC_CHANNELS.appSetWindowTitlebarMode]: (payload) => ({
    mode: payload === "landing" ? "landing" : "conversation",
  }),
  [IPC_CHANNELS.appSetLocale]: (payload) => ({ localePreference: payload ?? "system" }),
  [IPC_CHANNELS.appUpdateGetState]: (_payload, event) => {
    rememberDemoUpdateTarget(event);
    return demoUpdateState;
  },
  [IPC_CHANNELS.appUpdateCheck]: (_payload, event) => {
    rememberDemoUpdateTarget(event);
    clearDemoUpdateTimer();
    publishDemoUpdateState(
      {
        phase: "checking",
        capability: "auto",
        currentVersion: DEMO_UPDATE_CURRENT,
        availableVersion: DEMO_UPDATE_AVAILABLE,
        channel: "beta",
        releaseUrl: DEMO_UPDATE_RELEASE_URL,
      },
      event?.sender,
    );
    setTimeout(() => {
      publishDemoUpdateState({
        phase: "available",
        capability: "auto",
        currentVersion: DEMO_UPDATE_CURRENT,
        availableVersion: DEMO_UPDATE_AVAILABLE,
        channel: "beta",
        releaseUrl: DEMO_UPDATE_RELEASE_URL,
      });
    }, 600);
    return demoUpdateState;
  },
  [IPC_CHANNELS.appUpdateDownload]: (_payload, event) => startDemoUpdateDownload(event),
  [IPC_CHANNELS.appUpdateInstall]: (_payload, event) => {
    rememberDemoUpdateTarget(event);
    clearDemoUpdateTimer();
    const installing = publishDemoUpdateState(
      {
        phase: "installing",
        capability: "auto",
        currentVersion: DEMO_UPDATE_CURRENT,
        availableVersion: DEMO_UPDATE_AVAILABLE,
        channel: "beta",
        releaseUrl: DEMO_UPDATE_RELEASE_URL,
      },
      event?.sender,
    );
    setTimeout(() => {
      publishDemoUpdateState({
        phase: "available",
        capability: "auto",
        currentVersion: DEMO_UPDATE_CURRENT,
        availableVersion: DEMO_UPDATE_AVAILABLE,
        channel: "beta",
        releaseUrl: DEMO_UPDATE_RELEASE_URL,
      });
    }, 1200);
    return installing;
  },
  [IPC_CHANNELS.appUpdateOpenRelease]: () => ({ ok: true as const }),
  [IPC_CHANNELS.appConsumePendingThreadOpen]: () => demoRuntimeState.pendingThreadOpenId ?? DEMO_THREAD_ID,
  [IPC_CHANNELS.appShowThreadCompletionNotification]: () => ({ shown: false, reason: "preference_disabled" }),
  [IPC_CHANNELS.appShowThreadApprovalNotification]: () => ({ shown: false, reason: "preference_disabled" }),
  [IPC_CHANNELS.appShowThreadClarificationNotification]: () => ({
    shown: false,
    reason: "preference_disabled",
  }),
  [IPC_CHANNELS.coreAvailabilityGet]: () => demoCoreAvailability,
  [IPC_CHANNELS.cursorModelsList]: () => [],
  [IPC_CHANNELS.workspaceGetCurrent]: () => demoWorkspace,
  [IPC_CHANNELS.workspaceGetHomePath]: () => demoWorkspace.path,
  [IPC_CHANNELS.workspaceGetUserHomePath]: () => "/Users/demo",
  [IPC_CHANNELS.workspaceInspect]: () => demoWorkspaceInspect,
  [IPC_CHANNELS.workspaceListEntries]: () => [
    { name: "apps", path: `${demoWorkspace.path}/apps`, kind: "directory" as const },
    { name: "packages", path: `${demoWorkspace.path}/packages`, kind: "directory" as const },
    { name: "supabase", path: `${demoWorkspace.path}/supabase`, kind: "directory" as const },
    { name: "README.md", path: `${demoWorkspace.path}/README.md`, kind: "file" as const },
  ],
  [IPC_CHANNELS.workspaceListPackageScripts]: () => ({ scripts: [] }),
  [IPC_CHANNELS.workspaceWatchPackageJson]: () => ({ ok: true as const }),
  [IPC_CHANNELS.workspaceOpen]: () => ({ canceled: true }),
  [IPC_CHANNELS.workspaceOpenPath]: () => demoWorkspace,
  [IPC_CHANNELS.imageRevealInFolder]: () => undefined,
  [IPC_CHANNELS.modelSettingsGet]: () => demoModelSettings,
  [IPC_CHANNELS.settingsDigest]: () => ({ digest: "demo-mode", updatedAt: demoThreads[0]?.updatedAt ?? "" }),
  [IPC_CHANNELS.mcpSettingsGet]: () => demoMcpSettings,
  [IPC_CHANNELS.workflowSettingsGet]: () => demoWorkflowSettings,
  [IPC_CHANNELS.workflowSettingsSave]: (payload) => payload,
  [IPC_CHANNELS.proxyBridgeSettingsGet]: () => demoProxyBridgeSettings,
  [IPC_CHANNELS.integratedWebSearchSettingsGet]: () => demoIntegratedWebSearchSettings,
  [IPC_CHANNELS.integratedWebSearchSettingsSave]: () => demoIntegratedWebSearchSettings,
  [IPC_CHANNELS.centerServerSettingsGet]: () => demoCenterServerSettings,
  [IPC_CHANNELS.gitSettingsGet]: () => demoGitSettings,
  [IPC_CHANNELS.personalizationSettingsGet]: () => demoPersonalizationSettings,
  [IPC_CHANNELS.browserSettingsGet]: () => defaultBrowserSettings(),
  [IPC_CHANNELS.computerUseSettingsGet]: () => defaultComputerUseSettings(),
  [IPC_CHANNELS.computerUseSettingsSave]: (payload) => payload,
  [IPC_CHANNELS.computerUseDoctor]: () => ({ ok: false, reason: "Demo mode has no Computer Use runtime." }),
  [IPC_CHANNELS.integrationAvailabilityGet]: () => demoIntegrationAvailability,
  [IPC_CHANNELS.imageGenerationSettingsGet]: () => ({
    enabled: false,
    profiles: [],
    activeProfileId: "",
    apiKeyEncryptionAvailable: false,
  }),
  [IPC_CHANNELS.webChatListGet]: () => ({ items: [] }),
  [IPC_CHANNELS.sshBookmarksGet]: () => [],
  [IPC_CHANNELS.sshBookmarksSave]: () => ({
    id: "demo-ssh",
    name: "Demo",
    host: "example.com",
    port: 22,
    username: "root",
    authType: "password",
    order: 0,
    hasPassword: false,
    hasStoredKey: false,
  }),
  [IPC_CHANNELS.sshBookmarksDelete]: () => [],
  [IPC_CHANNELS.sshBookmarksConnect]: () => ({
    sessionId: "demo-session",
    label: "Demo",
    passwordAutoInject: false,
  }),
  [IPC_CHANNELS.sshBookmarksGetDefaultKeyPath]: () => "",
  [IPC_CHANNELS.notificationSettingsGet]: () => ({
    turnCompletion: "never",
    permissionEnabled: true,
    questionEnabled: true,
  }),
  [IPC_CHANNELS.threadList]: () => effectiveDemoThreads(),
  [IPC_CHANNELS.threadListInitial]: () => ({ threads: effectiveDemoThreads(), hasMore: false }),
  [IPC_CHANNELS.threadListMore]: () => ({ threads: [], hasMore: false }),
  [IPC_CHANNELS.threadGet]: (payload) =>
    effectiveDemoThreads().find((thread) => thread.id === effectiveDemoThreadId(payload)),
  [IPC_CHANNELS.threadSessionBootstrap]: (payload) =>
    buildDemoSessionBootstrapForThread(effectiveDemoThreadId(payload) ?? DEMO_THREAD_ID),
  [IPC_CHANNELS.threadFollowUpList]: () => ({ followUps: [] }),
  [IPC_CHANNELS.threadGetPendingPlan]: () => undefined,
  [IPC_CHANNELS.threadGetApprovedPlan]: () => undefined,
  [IPC_CHANNELS.clarificationGetPending]: () => undefined,
  [IPC_CHANNELS.bashApprovalGetPending]: () => undefined,
  [IPC_CHANNELS.composerDraftGet]: () => undefined,
  [IPC_CHANNELS.promptImageStage]: () => ({ path: "" }),
  [IPC_CHANNELS.promptImageUploadBegin]: () => ({ path: "", receivedBytes: 0, complete: false }),
  [IPC_CHANNELS.promptImageUploadChunk]: () => ({ receivedBytes: 0 }),
  [IPC_CHANNELS.promptImageUploadFinish]: () => ({ path: "" }),
  [IPC_CHANNELS.promptImageRelease]: () => ({ ok: true as const }),
  [IPC_CHANNELS.gitGetStatus]: () => demoGitStatus,
  [IPC_CHANNELS.gitGetWorkspaceDiff]: () => ({ files: [] }),
  [IPC_CHANNELS.gitListCommitModelOptions]: () => ({ options: [] }),
  [IPC_CHANNELS.billingRoutePricing]: () => [],
  [IPC_CHANNELS.billingRouteCapabilities]: () => [],
  [IPC_CHANNELS.billingModelsDevList]: () => [],
  [IPC_CHANNELS.candidateModelList]: (payload) =>
    typeof payload === "string" && payload === demoProvider.id ? demoCandidateModels : [],
  [IPC_CHANNELS.agentTemplateList]: () => demoModelSettings.agentTemplates,
  [IPC_CHANNELS.skillsList]: () => ({
    userSkills: [],
    projectSkills: [],
    agentsOnlySkills: [],
    scannedAt: new Date().toISOString(),
  }),
  [IPC_CHANNELS.projectSkillsSettingsGet]: (payload) => ({
    workspacePath: typeof payload === "string" ? payload : DEMO_WORKSPACE_PATH,
    enabledByPath: {},
  }),
  [IPC_CHANNELS.projectMcpSettingsGet]: (payload) => ({
    workspacePath: typeof payload === "string" ? payload : DEMO_WORKSPACE_PATH,
    enabledByServer: {},
  }),
  [IPC_CHANNELS.projectIntegrationsSettingsGet]: (payload) => ({
    workspacePath: typeof payload === "string" ? payload : DEMO_WORKSPACE_PATH,
    enabled: {},
  }),
  [IPC_CHANNELS.projectOrchestrationSettingsGet]: (payload) => ({
    workspacePath: typeof payload === "string" ? payload : DEMO_WORKSPACE_PATH,
  }),
  [IPC_CHANNELS.storageGetUsage]: () => ({ totalBytes: 0, categories: [], unmetered: [] }),
  [IPC_CHANNELS.terminalList]: () => [],
  [IPC_CHANNELS.backgroundTerminalList]: () => [],
  [IPC_CHANNELS.browserGetState]: () => demoBrowserState,
  [IPC_CHANNELS.browserSetUiScope]: () => demoBrowserState,
  [IPC_CHANNELS.browserSetVisible]: () => demoBrowserState,
  [IPC_CHANNELS.asrSettingsGet]: () => ({ enabled: false, profiles: [], activeProfileId: undefined }),
  [IPC_CHANNELS.asrProfilesList]: () => ({
    profiles: [],
    activeProfileId: "",
    apiKeyEncryptionAvailable: false,
  }),
};

function defaultDemoHandler(channel: string, payload: unknown): unknown {
  if (channel.includes(":save") || channel.includes(":delete") || channel.includes(":resolve")) {
    return { ok: true };
  }
  if (channel.includes(":list") || channel.endsWith(":list")) {
    return [];
  }
  if (channel.includes(":get") || channel.startsWith("thread:")) {
    return undefined;
  }
  if (channel.includes(":start") || channel.includes(":continue") || channel.includes(":open")) {
    return { ok: true };
  }
  console.warn(`[eco-demo] fallback ipc ${channel}`, payload);
  return undefined;
}

let demoRendererReadyHook: ((webContents: WebContents) => void) | undefined;

export function registerDemoIpcHandlers(options: RegisterDemoIpcHandlersOptions = {}): void {
  demoRendererReadyHook = options.onRendererReady;
  ipcMain.on(IPC_CHANNELS.appScreenRecordingAppLabel, (event) => {
    event.returnValue = "Mori Demo";
  });
  for (const channel of Object.values(IPC_CHANNELS)) {
    if (EVENT_CHANNELS.has(channel)) {
      continue;
    }
    ipcMain.handle(channel, async (event, payload) => {
      const handler = queueScene?.handlers[channel] ?? handlers[channel];
      if (handler) {
        return handler(payload, event);
      }
      return defaultDemoHandler(channel, payload);
    });
  }
}

export function queueDemoThreadOpen(threadId: string = DEMO_THREAD_ID): void {
  demoRuntimeState.pendingThreadOpenId = threadId;
}
