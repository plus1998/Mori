import type { FeedReplaySession } from "./session";

export type ReplayCallKind = "recorded" | "local" | "environment-read" | "blocked";
export interface ReplayCall {
  name: string;
  kind: ReplayCallKind;
  wall: number;
  seq: number;
}

// Explicitly audited metadata reads. Never grant privileges by get*/read* naming alone.
const environmentReads = new Set([
  "getCurrentWorkspace",
  "getHomeProjectPath",
  "getModelSettings",
  "getMcpSettings",
  "getWorkflowSettings",
  "getCenterServerSettings",
  "getProxyBridgeSettings",
  "getIntegratedWebSearchSettings",
  "getDesktopUpdateState",
  "getGitSettings",
  "getPersonalizationSettings",
  "getBrowserSettings",
  "getComputerUseSettings",
  "getTtsSettings",
  "getImageGenerationSettings",
  "getIntegrationAvailability",
  "getWebChatList",
  "getSshBookmarks",
  "getNotificationSettings",
  "listSchedules",
  "listAsrProfiles",
  "getProjectMcpSettings",
  "getProjectIntegrationsSettings",
  "getProjectOrchestrationSettings",
  "getProjectSkillsSettings",
  "inspectWorkspace",
  "getGitStatus",
  "listPackageScripts",
  "listSkills",
  "listCursorAgents",
  "getRoutePricing",
  "getRouteCapabilities",
  "listCandidateModels",
  "getBrowserState",
  "browserGetState",
  "listTerminalSessions",
  "listBackgroundTerminalTasks",
  "listTtsArtifacts",
  "listImageGenerationArtifacts",
  "listImageDisplayArtifacts",
  "listHtmlHostArtifacts",
  "readPromptImageChunk",
]);

const localEffects = new Set([
  "rendererReady",
  "markRendererReady",
  "setWindowTitlebarMode",
  "setThemeSource",
  "setAppThemeSource",
  "setLocale",
  "setLocalePreference",
  "watchPackageJson",
  "browserSetUiScope",
  "browserSetVisible",
]);

export function createReplayApi(
  native: Record<string, unknown>,
  session: FeedReplaySession,
  record: (call: ReplayCall) => void,
): Record<string, unknown> {
  const id = session.fixture.conversationId;
  const drafts = new Map<string, Record<string, unknown>>();
  const check = (conversationId: string) => session.assertConversation(conversationId);
  const overrides: Record<string, (...args: any[]) => unknown> = {
    listThreads: () => [{ ...session.thread }],
    getThread: (conversationId: string) => {
      check(conversationId);
      return { ...session.thread };
    },
    consumePendingThreadOpen: () => id,
    // Availability here means a recorded core can be simulated, not that a local SDK was probed.
    getCoreAvailability: () => ({
      claude: { available: true },
      codex: { available: session.thread.coreKind === "codex" },
      pi: { available: session.thread.coreKind === "pi" },
      cursor: { available: session.thread.coreKind === "acp" },
    }),
    conversationV2Capabilities: () => ({
      protocolVersion: 2,
      eventSchemaVersion: 1,
      effectVersion: 1,
      storeEpoch: session.fixture.storeEpoch,
      maxEvents: 512,
      maxBytes: 2 * 1024 * 1024,
    }),
    conversationV2Bootstrap: (conversationId: string) => {
      check(conversationId);
      return session.bootstrap();
    },
    conversationV2Projection: (conversationId: string) => {
      check(conversationId);
      return { requestSpans: session.requestSpans };
    },
    conversationV2Head: (conversationId: string) => {
      check(conversationId);
      return session.head();
    },
    conversationV2Sync: (query) => session.sync(query),
    conversationV2ToolsPage: (...args) => session.toolsPage(args[0], args[1], args[2]),
    conversationV2DetailsPage: (...args) => session.detailsPage(args[0], args[1], args[2]),
    conversationV2MessageGet: (conversationId: string, messageId: string) => {
      check(conversationId);
      return session.state.messages.get(messageId);
    },
    conversationV2RunGet: (conversationId: string, runId: string) => {
      check(conversationId);
      return session.state.runs.get(runId);
    },
    conversationV2DetailGet: (conversationId: string, itemId: string) => {
      check(conversationId);
      const stored = session.fixture.detailItems.find((item) => item.itemId === itemId);
      if (stored && stored.versionSeq <= session.state.appliedSeq) return stored;
      const current = session.state.details.get(itemId);
      if (!current && stored)
        throw new Error("This detail's older body is not recorded at the current checkpoint.");
      return current;
    },
    conversationV2SendMessage: (request) => session.send(request),
    cancelThread: (request: string | { threadId: string }) =>
      session.cancel(typeof request === "string" ? request : request.threadId),
    updateThreadRuntimeConfig: (request) => session.updateConfig(request),
    // These panels are outside the captured history contract; coverage is surfaced by status/trace.
    getPendingPlan: () => undefined,
    getApprovedPlan: () => undefined,
    getPendingClarification: () => undefined,
    getPendingBashApproval: () => undefined,
    listThreadFollowUps: (conversationId: string) => {
      check(conversationId);
      return { followUps: session.fixture.uiScenario?.pausedFollowUps ?? [] };
    },
    getComposerDraft: (key: string) => drafts.get(key),
    saveComposerDraft: (request) => {
      const draft = {
        ...request,
        revision: `replay:${performance.now()}`,
        updatedAt: new Date().toISOString(),
      };
      drafts.set(request.contextKey, draft);
      return draft;
    },
    deleteComposerDraft: (request: string | { contextKey: string }) => ({
      deleted: drafts.delete(typeof request === "string" ? request : request.contextKey),
    }),
    showThreadCompletionNotification: () => ({ shown: false, reason: "preference_disabled" }),
    showThreadApprovalNotification: () => ({ shown: false, reason: "preference_disabled" }),
    showThreadClarificationNotification: () => ({ shown: false, reason: "preference_disabled" }),
  };
  if (session.fixture.uiScenario?.terminalHeight !== undefined) {
    // Render the real terminal panel without starting a shell or accepting input.
    overrides.listTerminalSessions = (request?: { workspacePath?: string }) =>
      !request?.workspacePath || request.workspacePath === session.thread.workspacePath
        ? [{ sessionId: "feed-replay-terminal", workspacePath: session.thread.workspacePath, kind: "local" }]
        : [];
    overrides.spawnTerminal = ({ workspacePath }) => {
      if (workspacePath !== session.thread.workspacePath) throw new Error("Unknown replay workspace.");
      return { sessionId: "feed-replay-terminal" };
    };
    overrides.resizeTerminal = (request) => {
      if (request.sessionId !== "feed-replay-terminal") throw new Error("Unknown replay terminal.");
    };
  }
  const api: Record<string, unknown> = {};
  const log = (name: string, kind: ReplayCallKind) =>
    record({ name, kind, wall: performance.now(), seq: session.state.appliedSeq });
  for (const name of new Set([...Object.keys(native), ...Object.keys(overrides)])) {
    if (name === "onTerminalEvent" && session.fixture.uiScenario?.terminalHeight !== undefined) {
      api[name] = (listener: Parameters<typeof session.terminalListeners.add>[0]) => {
        session.terminalListeners.add(listener);
        return () => session.terminalListeners.delete(listener);
      };
    } else if (name === "onThreadEvent") {
      api[name] = (listener: (event: unknown) => void) => {
        session.listeners.add(listener);
        return () => session.listeners.delete(listener);
      };
    } else if (overrides[name]) {
      api[name] = async (...args: unknown[]) => {
        log(name, name.startsWith("conversationV2") || name === "cancelThread" ? "recorded" : "local");
        return overrides[name]!(...args);
      };
    } else if (typeof native[name] !== "function") {
      api[name] = native[name];
    } else if (name.startsWith("on")) {
      // No native live events may enter the isolated recording.
      api[name] = () => () => {};
    } else if (localEffects.has(name)) {
      api[name] = async () => {
        log(name, "local");
      };
    } else if (environmentReads.has(name)) {
      api[name] = (...args: unknown[]) => {
        log(name, "environment-read");
        return (native[name] as (...input: unknown[]) => unknown)(...args);
      };
    } else {
      api[name] = async () => {
        log(name, "blocked");
        throw new Error(`Replay API is not implemented: ${name}. Native execution is blocked.`);
      };
    }
  }
  return api;
}
