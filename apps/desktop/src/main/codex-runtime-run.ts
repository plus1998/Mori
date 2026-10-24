import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ResolvedModelRoute } from "@eco/model-router";
import {
  applyCodexExecutionConfirmation,
  assertCodexRoleProvidersAvailable,
  buildCodexConfigToml,
  buildCodexGatewayModelAlias,
  buildCodexMainAgentOrchestrationAppend,
  buildCodexModelProviderSlug,
  buildCodexSubagentFollowupPrompt,
  type CodexAccountModelContext,
  type CodexAppServerClient,
  CodexAppServerDriver,
  type CodexCatalogManualCapabilities,
  type CodexContextSnapshotResolution,
  CodexEventAdapter,
  type CodexExecutionConfirmationMode,
  CodexForkNotAvailable,
  type CodexGatewayCatalogRoute,
  type CodexMcpServerForConfigSync,
  CodexResumeNotAvailable,
  type CodexSessionMode,
  type CodexThreadAttribution,
  type CodexThreadConfigOverrides,
  type CodexThreadResumeResult,
  type CodexThreadStatusKind,
  type CodexToolPolicy,
  CodexTurnRouteRegistry,
  type CodexTurnTokenUsageBreakdown,
  type CodexWebSearchMode,
  clearCodexSpawnPayloadQueueSync,
  collectCodexGatewayCatalogRoutes,
  DEFAULT_CODEX_TOOL_POLICY,
  dequeueCodexSpawnPayloadMatchingSync,
  type EcoAgentRuntimeConfig,
  type EcoProviderForCodexConfig,
  ensureCodexSkillsExtraRoots,
  forkCodexThread,
  listCodexSkills,
  mergeMainAgentAppendParts,
  normalizeCodexToolPolicy,
  parseCodexGatewayModelAlias,
  readCodexThreadStatus,
  recordAppliedCodexThreadConfig,
  requireCodexAccountContextWindow,
  requireCodexSubagentThreadId,
  resolveCodexHomeDir,
  resumeCodexThread,
  syncCodexConfigFromEcoProviders,
  syncEcoCodexModelCatalog,
  syncOrchestrationAgentsToCodexRoles,
  withCodexMcpServerDefinitions,
  withCodexNativeImageView,
  withCodexRemoteCompaction,
  withCodexSkillConfig,
} from "@eco/runtime";
import { resolveUpstreamApiCompat } from "../shared/api-compat";
import type { SkillsEnabledSettings } from "../shared/composer-skills-settings";
import type { CodexModelCatalogEntryView } from "../shared/models";
import type { ThreadRunEventInput } from "../shared/thread-run-events";
import type { RuntimeRoute } from "./billing-resolver";
import {
  type CodexApprovalBridge,
  type CodexApprovalBridgeDeps,
  createCodexApprovalBridge,
} from "./codex-approval-bridge";
import {
  assertCodexSubagentCompactionCompatible,
  createCodexRemoteCompactionResolver,
  fingerprintCodexProviderConfig,
} from "./codex-model-capability-config";
import { CodexModelCatalogService } from "./codex-model-catalog";
import {
  CodexRuntimeLifecycle,
  ensureGlobalCodexRuntimeLifecycle,
  getCodexRuntimeClientForThread,
  getGlobalCodexRuntimeLifecycle,
  handoffCodexRuntimeThread,
  recordCodexRuntimeThreadOwner,
  replaceGlobalCodexRuntimeLifecycle,
  retainCodexRuntimeClient,
} from "./codex-runtime-lifecycle";
import {
  CODEX_SKILLS_CONFIG_RELOAD_BLOCKED_MESSAGE,
  shouldBlockCodexSkillsConfigReload,
  skillsEnabledSettingsChanged,
} from "./codex-skills-config-reload";
import type { CodexThreadMap } from "./codex-thread-map";
import { resolveCodexThreadAttribution } from "./codex-thread-map";
import { normalizeCodexThreadRunEventForProjection } from "./codex-thread-run-event-normalizer";
import { ensureGlobalEcoGateway } from "./eco-gateway-lifecycle";
import { assertEcoHttpMcpServersReachable } from "./mcp-streamable-http";
import {
  probeCliVersionExecutable,
  readElectronResourcesPath,
  resolvePackagedCodexExecutableCandidate,
} from "./packaged-runtime-executables";
import type { RequestAttemptResult } from "./request-retry";
import { buildDriverRoutesFromRuntime, type RuntimeConfigResolution } from "./thread-runtime-routes";

export type ThreadRuntimeProxyResult = RequestAttemptResult & Record<string, unknown>;

export interface CodexRuntimeAttempt {
  routes: ResolvedModelRoute[];
  /** ThreadRuntimeConfig planner modelId (upstream), for logging / diagnostics. */
  plannerRoute?: { modelId: string };
}

export interface RunThreadRequestWithRuntimeProxyInput {
  threadId: string;
  attachments?: unknown;
  signal?: AbortSignal;
  resolveRuntimeConfig: () => RuntimeConfigResolution;
  resolveAgentRegistry?: () => EcoAgentRuntimeConfig | undefined;
  /** Thread-scoped integration instructions appended to Codex developerInstructions. */
  resolveSystemPromptAppend?: () => string | undefined;
  /** Composer execution-confirmation setting mapped onto Codex approvalPolicy. */
  resolveExecutionConfirmationMode?: () => CodexExecutionConfirmationMode;
  /** Codex subagents remain disabled until their product lifecycle is complete. */
  enableSubagents?: boolean;
  /** Thread-level subagent toggles (explore/coder/…). */
  resolveSubagentAvailability?: () => Partial<Record<string, boolean>> | undefined;
  /**
   * MCP servers visible to the current thread. Codex receives the full
   * definitions through `thread/start` / `thread/resume` config, never through
   * the process-global config.toml.
   */
  resolveMcpServers?: () =>
    | readonly CodexMcpServerForConfigSync[]
    | Promise<readonly CodexMcpServerForConfigSync[]>;
  /** Composer-selected MCP names, intersected with each actor's orchestration assignment. */
  resolveEnabledMcpServerKeys?: () => readonly string[] | Promise<readonly string[]>;
  /** Exact per-thread Skill path visibility. */
  resolveSkillConfig?: () => readonly { path: string; enabled: boolean }[];
  /** CWD used to discover and explicitly disable Codex's built-in imagegen Skill. */
  skillDiscoveryCwd?: string;
  /** Disable native search on roles + thread config when search is off or Eco Integrated is selected. */
  resolveWebSearchOverride?: () => CodexWebSearchMode | undefined;
  /** Wait for thread-selected MCP servers to leave `starting` before the turn. */
  ensureMcpReady?: () => Promise<void>;
  /** Runs after the exact thread config is bound, before the driver starts the turn. */
  onPrepared?: (prepared: PreparedCodexRuntime) => void | Promise<void>;
  /** Reports active Codex turns that temporarily prevent an app-server config reload. */
  onConfigReloadWait?: (input: {
    reason: CodexRuntimeRestartReason;
    activeThreadIds: readonly string[];
  }) => void;
  recordRouteFingerprint: (threadId: string, routes: readonly RuntimeRoute[]) => void;
  startRuntimeProxy?: unknown;
  onProxyReady?: (attempt: CodexRuntimeAttempt) => void | Promise<void>;
  run: (attempt: CodexRuntimeAttempt) => Promise<ThreadRuntimeProxyResult>;
}

export interface EcoProviderForCodexCatalog extends EcoProviderForCodexConfig {
  defaultModel?: string;
  models?: readonly {
    modelId: string;
    displayName?: string;
    apiCompat?: EcoProviderForCodexConfig["apiCompat"];
    manualSpec?: CodexCatalogManualCapabilities;
  }[];
}

export interface CodexRuntimeRunDeps {
  ecoDataDir: string;
  listProviders: () => readonly EcoProviderForCodexCatalog[];
  getGlobalContextWindowLimit?: () => number;
  listAccountModels?: () => Promise<readonly CodexAccountModelContext[]>;
  /** Eco personalization rules for thread developerInstructions. */
  getGlobalUserRules?: () => string | undefined;
  /**
   * Enrich catalog routes with resolved context windows (models.dev / manual) so
   * Codex aliases do not fall back to the unknown-model 128k default.
   */
  enrichCatalogRoutes?: (routes: readonly CodexGatewayCatalogRoute[]) => Promise<CodexGatewayCatalogRoute[]>;
  /** Secret-free settings-level catalog expansion sources beyond provider defaults. */
  listCatalogRouteConfigs?: () => readonly CodexGatewayCatalogRoute[];
  listCatalogOrchestrationAgents?: () => readonly CodexGatewayCatalogRoute[];
  /** Persisted thread snapshots retained so historical sessions can always resume. */
  listCatalogThreadRoutes?: () => readonly CodexGatewayCatalogRoute[];
  /** Every enabled MCP server is a process-global pool; thread config controls visibility. */
  listGlobalMcpServers?: () =>
    | readonly CodexMcpServerForConfigSync[]
    | Promise<readonly CodexMcpServerForConfigSync[]>;
  threadMap: CodexThreadMap;
  resolveRunAttemptId?: (ecoThreadId: string) => string | undefined;
  appendConversationRuntimeEvent: (event: ThreadRunEventInput) => void;
  /**
   * Emit feed projection. Pass `{ streaming: true }` for delta events so the
   * scheduler throttles streaming projections instead of debouncing away all
   * intermediate updates while deltas keep arriving.
   */
  scheduleThreadRunProjectionUpdated: (threadId: string, options?: { streaming?: boolean }) => void;
  /**
   * Bind a Codex user item by its follow-up client id when present; otherwise
   * bind the pending local prompt. A true result suppresses the duplicate echo.
   */
  bindLatestUserPromptToCodexItem?: (
    threadId: string,
    itemId: string,
    turnId?: string,
    clientUserMessageId?: string,
  ) => boolean;
  /** Local prune after a successful app-server `thread/fork` rewind. */
  pruneThreadAfterCodexFork?: (ecoThreadId: string, itemId: string) => void;
  /** @deprecated Use pruneThreadAfterCodexFork. */
  pruneThreadAfterCodexRollback?: (ecoThreadId: string, itemId: string) => void;
  /** Archive a remote fork when local prune/mapping cannot be committed. */
  archiveCodexThread?: (codexThreadId: string) => Promise<void>;
  /** Map Eco's persisted user-message UUID to its zero-based Codex turn ordinal. */
  resolveCodexForkTurnIndex?: (ecoThreadId: string, itemId: string) => number | undefined;
  /** @deprecated Use resolveCodexForkTurnIndex. */
  resolveCodexRollbackTurnIndex?: (ecoThreadId: string, itemId: string) => number | undefined;
  /** @deprecated Prefer built-in `threadMap` attribution via `resolveCodexThreadAttribution`. */
  resolveCodexThreadAttribution?: (codexThreadId: string) => CodexThreadAttribution | undefined;
  /** Runs only after a child attribution record has been persisted successfully. */
  onCodexThreadAttributionRecorded?: (codexThreadId: string) => void;
  /** Runs only after the root Eco -> Codex thread mapping has been persisted successfully. */
  onCodexThreadMapped?: (codexThreadId: string) => void;
  onCodexContextUpdated?: (resolution: CodexContextSnapshotResolution) => void;
  /**
   * Codex app-server per-turn token usage (terminal `turn/completed`). Used as
   * the billing source for direct (non-gateway) routes such as built-in OpenAI.
   */
  onCodexTurnTokenUsage?: (input: {
    threadId: string;
    codexThreadId: string;
    turnId: string;
    appServerTokenUsage: CodexTurnTokenUsageBreakdown;
    appServerTokenUsageRequests?: CodexTurnTokenUsageBreakdown[];
  }) => void;
  onCodexTurnPlanUpdated?: NonNullable<
    ConstructorParameters<typeof CodexEventAdapter>[0]["onTurnPlanUpdated"]
  >;
  onCodexPlanReady?: NonNullable<ConstructorParameters<typeof CodexEventAdapter>[0]["onPlanReady"]>;
  /** Codex 0.160 `agentMessage` items carrying `delivery: "async"` + questions. */
  onCodexAsyncQuestions?: NonNullable<ConstructorParameters<typeof CodexEventAdapter>[0]["onAsyncQuestions"]>;
  onStderr?: (message: string) => void;
}

export interface PrepareCodexRuntimeInput {
  ecoThreadId?: string;
  /** Reserve the selected generation until the request has created and disposed its driver. */
  reserveRuntime?: boolean;
  signal?: AbortSignal;
  onConfigReloadWait?: RunThreadRequestWithRuntimeProxyInput["onConfigReloadWait"];
  agentRegistry?: EcoAgentRuntimeConfig | undefined;
  systemPromptAppend?: string;
  executionConfirmationMode?: CodexExecutionConfirmationMode;
  enableSubagents?: boolean;
  /** Thread-level subagent toggles (explore/coder/…). */
  subagentAvailability?: Partial<Record<string, boolean>>;
  /** Provider ids required by the current thread routes; incomplete providers fail with a Settings hint. */
  requiredProviderIds?: readonly string[];
  /** Main thread's selected provider (the built-in `openai` route retains native image viewing). */
  mainProviderId?: string;
  mainModelId?: string;
  mainApiCompat?: EcoProviderForCodexConfig["apiCompat"];
  mainSupportsImageInput?: boolean;
  /**
   * MCP servers visible to this thread. Definitions are passed to Codex through
   * the thread config; they are not written to the process-global config.toml.
   */
  mcpServers?: readonly CodexMcpServerForConfigSync[];
  /**
   * Stable process-global MCP servers written to `config.toml` `[mcp_servers.*]`.
   * Defaults to `listGlobalMcpServers`. Thread-specific Hub descriptors must not
   * be passed here.
   */
  globalMcpServers?: readonly CodexMcpServerForConfigSync[];
  /** Composer-selected MCP names for this thread. Omitted means all supplied servers. */
  threadEnabledMcpServerNames?: readonly string[];
  skillConfig?: readonly { path: string; enabled: boolean }[];
  skillDiscoveryCwd?: string;
  /** Validate that these thread-selected routes exist in the already global catalog. */
  requiredCatalogRoutes?: readonly CodexGatewayCatalogRoute[];
  /**
   * Force Codex native `web_search` on synced role TOML files and the main thread config
   * (e.g. `"disabled"` when Eco Integrated Web Search MCP is armed). Role files are the
   * reliable path for subagents; `web_search` on thread/start config covers the main actor
   * (Codex defaults to disabled when omitted).
   */
  webSearchOverride?: CodexWebSearchMode;
  /** Refresh only global baseline state after a settings change; do not start a new client. */
  globalOnly?: boolean;
  /** Internal desired-baseline revision captured by the refresh coordinator. */
  globalRuntimeRevision?: number;
}

/** Exhaustive process-only restart reasons; thread settings must never enter this path. */
export type CodexRuntimeRestartReason = "account" | "account_proxy" | "model_catalog" | "launch_config";

export interface PreparedCodexRuntime {
  /** Wire settings for thread/fork, which otherwise uses the process-global defaults. */
  mainThreadModel?: { model: string; modelProvider: string };
  runtimeClient?: CodexAppServerClient;
  releaseRuntime?: () => void;
  orchestrationAppend?: string;
  orchestrationToolPolicy?: CodexToolPolicy;
  roleIds: readonly string[];
  roleToolPolicies: Readonly<Record<string, CodexToolPolicy>>;
  threadConfig: CodexThreadConfigOverrides;
  roleThreadConfigs: Readonly<Record<string, CodexThreadConfigOverrides>>;
}

/** Prepared configs are scoped by Eco thread; concurrent orchestrations never share mutable state. */
const preparedRuntimeByThread = new Map<string, PreparedCodexRuntime>();
const controlPlaneAppliedConfigByClient = new WeakMap<object, Map<string, object>>();
/** Used only for Feed role labels when no thread attribution is available yet. */
let lastPreparedRoleIds: readonly string[] = [];
/** Serializes writes/reloads of the process-global CODEX_HOME config. */
let prepareRuntimeTail: Promise<void> = Promise.resolve();
/** Once installed, keep global hook support stable; each thread still enables/disables it explicitly. */
let globalMultiAgentSupportRequired = false;
let lastPreparedGlobalConfigFingerprint = "";
let globalRefreshPromise: Promise<void> | undefined;
/** Monotonic desired-baseline revision. A settings save never mutates the loaded baseline directly. */
let desiredGlobalRuntimeRevision = 0;
let loadedGlobalRuntimeRevision = -1;
let refreshPending = false;
let globalRefreshError: Error | undefined;
let globalRuntimeRefreshShuttingDown = false;
let globalRefreshIdleAbortController = new AbortController();
let beforeGlobalRuntimeRefresh: (() => Promise<void>) | undefined;
let forcedRuntimeRestart: "account" | "account_proxy" | undefined;
let loadedModelCatalogSlugs: readonly string[] = [];
let loadedGlobalMcpServerNames: readonly string[] = [];
let loadedGatewayProviderFingerprint = "";
let loadedAccountModelContexts = "";
let accountRefreshPending = false;
let accountRestartRevision = 0;

export function bindPreparedCodexRuntimeToThread(ecoThreadId: string, prepared: PreparedCodexRuntime): void {
  const threadId = ecoThreadId.trim();
  if (!threadId) {
    throw new Error("Eco thread id is required when binding prepared Codex runtime config.");
  }
  preparedRuntimeByThread.set(threadId, prepared);
}

export function clearPreparedCodexRuntimeForThread(ecoThreadId: string): boolean {
  const threadId = ecoThreadId.trim();
  return threadId ? preparedRuntimeByThread.delete(threadId) : false;
}

export function isCodexThreadForkPrepared(ecoThreadId: string): boolean {
  return Boolean(preparedRuntimeByThread.get(ecoThreadId.trim())?.mainThreadModel);
}
/** Skip MCP reload when the prepared server set is unchanged (keeps warm connections). */
let lastPreparedMcpFingerprint = "";
/** Formal Eco model catalog fingerprint currently loaded by the running app-server. */
let lastPreparedModelCatalogFingerprint = "";

const LOCAL_CODEX_CANDIDATES: readonly string[] = [];

let deps: CodexRuntimeRunDeps | undefined;
let eventAdapter: CodexEventAdapter | undefined;
let approvalBridge: CodexApprovalBridge | undefined;
let modelCatalogService: CodexModelCatalogService | undefined;
const turnRouteRegistry = new CodexTurnRouteRegistry();

export function configureCodexApprovalBridge(bridgeDeps: CodexApprovalBridgeDeps): void {
  approvalBridge = createCodexApprovalBridge(bridgeDeps);
}

export function getCodexApprovalBridge(): CodexApprovalBridge | undefined {
  return approvalBridge;
}

export function configureCodexRuntimeRun(config: CodexRuntimeRunDeps): void {
  deps = config;
  modelCatalogService = undefined;
  turnRouteRegistry.clearAll();
  preparedRuntimeByThread.clear();
  lastPreparedRoleIds = [];
  lastPreparedMcpFingerprint = "";
  lastPreparedModelCatalogFingerprint = "";
  lastPreparedGlobalConfigFingerprint = "";
  desiredGlobalRuntimeRevision = 0;
  loadedGlobalRuntimeRevision = -1;
  refreshPending = false;
  globalRefreshError = undefined;
  globalRuntimeRefreshShuttingDown = false;
  globalRefreshIdleAbortController = new AbortController();
  beforeGlobalRuntimeRefresh = undefined;
  forcedRuntimeRestart = undefined;
  loadedModelCatalogSlugs = [];
  loadedGlobalMcpServerNames = [];
  loadedGatewayProviderFingerprint = "";
  loadedAccountModelContexts = "";
  accountRefreshPending = false;
  accountRestartRevision = 0;
  // Role declarations remain thread-scoped, but the shared runtime always needs
  // the stable multi-agent capability available before a thread enables it.
  globalMultiAgentSupportRequired = true;
  const resolveAttribution =
    config.resolveCodexThreadAttribution ??
    ((codexThreadId: string) => resolveCodexThreadAttribution(config.threadMap, codexThreadId));

  const codexHomeDir = resolveCodexHomeDir(config.ecoDataDir);
  // Clear crash leftovers once at process setup. Per-turn cleanup can erase a
  // concurrent thread's hook payload before its child attribution is recorded.
  clearCodexSpawnPayloadQueueSync(codexHomeDir);
  const resolveEcoThreadId = (codexThreadId: string): string => {
    const mapped = config.threadMap.getEcoThreadId(codexThreadId);
    if (mapped) {
      return mapped;
    }
    return resolveAttribution(codexThreadId)?.ecoThreadId ?? codexThreadId;
  };
  eventAdapter = new CodexEventAdapter({
    resolveEcoThreadId,
    turnRouteRegistry,
    recordThreadRunEvent: (event) => {
      const projectionEvent = normalizeCodexThreadRunEventForProjection(event as ThreadRunEventInput);
      const itemId =
        typeof projectionEvent.metadata?.itemId === "string"
          ? projectionEvent.metadata.itemId.trim()
          : projectionEvent.streamKey?.trim();
      if (
        projectionEvent.role === "user" &&
        projectionEvent.scope === "main" &&
        projectionEvent.metadata?.itemType === "userMessage" &&
        itemId &&
        config.bindLatestUserPromptToCodexItem?.(
          projectionEvent.threadId,
          itemId,
          typeof projectionEvent.metadata?.turnId === "string" ? projectionEvent.metadata.turnId : undefined,
          typeof projectionEvent.metadata?.clientUserMessageId === "string"
            ? projectionEvent.metadata.clientUserMessageId
            : undefined,
        )
      ) {
        // Projection-only: local user prompt already carries the Codex item id / rewindTarget.
        config.scheduleThreadRunProjectionUpdated(projectionEvent.threadId, { streaming: false });
        return;
      }
      config.appendConversationRuntimeEvent(
        bindCodexThreadRunEventAttempt(
          projectionEvent,
          config.resolveRunAttemptId?.(projectionEvent.threadId),
        ),
      );
      // Pass the raw (un-normalized) event: projectionEvent renames
      // run.attempt.* to request.* and would bypass the terminal-turn gate.
      emitCodexTurnTokenUsage(config, event as ThreadRunEventInput);
      config.scheduleThreadRunProjectionUpdated(projectionEvent.threadId, {
        streaming: isCodexStreamingProjectionEvent(projectionEvent),
      });
    },
    resolveThreadAttribution: resolveAttribution,
    recordThreadAttribution: (codexThreadId, record) => {
      config.threadMap.setThreadAttribution(codexThreadId, record);
      config.onCodexThreadAttributionRecorded?.(codexThreadId);
      // Flush all pending: nested grandchildren may resolve only after an ancestor link lands.
      eventAdapter?.flushAllPendingEvents();
    },
    getThreadAttributionRecord: (codexThreadId) => config.threadMap.getThreadAttribution(codexThreadId),
    dequeueSpawnPayloadMatching: (input) => dequeueCodexSpawnPayloadMatchingSync(codexHomeDir, input),
    resolveOrchestrationRoleIds: () => [
      ...new Set([
        ...lastPreparedRoleIds,
        ...[...preparedRuntimeByThread.values()].flatMap((prepared) => prepared.roleIds),
      ]),
    ],
    ...(config.onCodexContextUpdated && {
      onTokenUsageUpdated: config.onCodexContextUpdated,
    }),
    ...(config.onCodexTurnPlanUpdated && {
      onTurnPlanUpdated: config.onCodexTurnPlanUpdated,
    }),
    ...(config.onCodexPlanReady && { onPlanReady: config.onCodexPlanReady }),
    ...(config.onCodexAsyncQuestions && { onAsyncQuestions: config.onCodexAsyncQuestions }),
  });
}

/**
 * Surface Codex app-server per-turn token usage on terminal turn events so the
 * host can bill direct (non-gateway) routes. Gateway-routed turns are billed from
 * gateway usage events instead; the host must gate on the route provider.
 */
function emitCodexTurnTokenUsage(config: CodexRuntimeRunDeps, event: ThreadRunEventInput): void {
  if (
    event.eventType !== "run.attempt.completed" &&
    event.eventType !== "run.attempt.failed" &&
    event.eventType !== "run.attempt.cancelled"
  ) {
    return;
  }
  const appServerTokenUsage = event.metadata?.appServerTokenUsage;
  if (!appServerTokenUsage || typeof appServerTokenUsage !== "object") {
    return;
  }
  const codexThreadId =
    typeof event.metadata?.codexThreadId === "string" ? event.metadata.codexThreadId.trim() : "";
  const turnId = typeof event.metadata?.turnId === "string" ? event.metadata.turnId.trim() : "";
  if (!codexThreadId || !turnId) {
    return;
  }
  config.onCodexTurnTokenUsage?.({
    threadId: event.threadId,
    codexThreadId,
    turnId,
    appServerTokenUsage: appServerTokenUsage as CodexTurnTokenUsageBreakdown,
    ...(Array.isArray(event.metadata?.appServerTokenUsageRequests)
      ? {
          appServerTokenUsageRequests: event.metadata
            .appServerTokenUsageRequests as CodexTurnTokenUsageBreakdown[],
        }
      : {}),
  });
}

export function bindCodexThreadRunEventAttempt(
  event: ThreadRunEventInput,
  ecoRunAttemptId: string | undefined,
): ThreadRunEventInput {
  const { runAttemptId: codexTurnAsAttemptId, ...eventWithoutAttempt } = event;
  const turnId =
    typeof event.metadata?.turnId === "string" ? event.metadata.turnId.trim() : codexTurnAsAttemptId?.trim();
  const runAttemptId = ecoRunAttemptId?.trim();
  return {
    ...eventWithoutAttempt,
    ...(runAttemptId && { runAttemptId }),
    metadata: {
      ...(event.metadata ?? {}),
      ...(turnId && { turnId }),
    },
  };
}

export function requireCodexRouteForRole(
  routes: readonly ResolvedModelRoute[],
  roleId: string,
): ResolvedModelRoute {
  const normalizedRoleId = roleId.trim();
  const route = normalizedRoleId
    ? routes.find((candidate) => candidate.role === normalizedRoleId)
    : undefined;
  if (!route) {
    throw new Error(
      `Codex subagent resume is missing the exact route for role '${normalizedRoleId || "unknown"}'.`,
    );
  }
  return route;
}

export function getCodexThreadId(ecoThreadId: string): string | undefined {
  return deps?.threadMap.getCodexThreadId(ecoThreadId);
}

export function getCodexRuntimeClientForEcoThread(ecoThreadId: string): CodexAppServerClient | undefined {
  const codexThreadId = deps?.threadMap.getCodexThreadId(ecoThreadId);
  return codexThreadId
    ? getCodexRuntimeClientForThread(codexThreadId)
    : (preparedRuntimeByThread.get(ecoThreadId)?.runtimeClient ??
        getGlobalCodexRuntimeLifecycle()?.getClient());
}

/**
 * Resume a main Eco thread's Codex session via `thread/resume`.
 * Map missing → explicit error (never silently `thread/start`).
 */
export async function resumeCodexThreadForEcoThread(input: {
  ecoThreadId: string;
  cwd?: string;
  model?: string;
  modelProvider?: string;
}): Promise<CodexThreadResumeResult> {
  const runtimeDeps = requireDeps();
  const ecoThreadId = input.ecoThreadId.trim();
  if (!ecoThreadId) {
    throw new CodexResumeNotAvailable("Codex resume is not available because the Eco thread id is missing.", {
      nextAction: "Retry resume from a Codex-backed thread that has a persisted Eco thread id.",
    });
  }
  const codexThreadId = runtimeDeps.threadMap.getCodexThreadId(ecoThreadId);
  if (!codexThreadId) {
    throw new CodexResumeNotAvailable(
      "Codex resume is not available because this Eco thread has no Codex thread mapping.",
      {
        nextAction:
          "Run this thread through the Codex app-server once so Eco can persist its Codex thread id, then retry resume.",
      },
    );
  }
  const client = getCodexRuntimeClientForThread(codexThreadId);
  if (!client) {
    throw new CodexResumeNotAvailable(
      "Codex resume is not available because the Codex app-server client is not running.",
      {
        nextAction:
          "Start a Codex-backed turn to bring the app-server online, then retry resume against the same thread.",
      },
    );
  }
  const prepared = preparedRuntimeByThread.get(ecoThreadId);
  if (!prepared) {
    throw new CodexResumeNotAvailable(
      "Codex resume cannot reapply this thread's runtime policy because no prepared config is bound.",
      {
        nextAction:
          "Prepare the Eco thread with its current orchestration and MCP selection, then retry resume.",
      },
    );
  }
  return resumeCodexThread(client, {
    threadId: codexThreadId,
    ...(input.cwd?.trim() && { cwd: input.cwd.trim() }),
    ...(input.model?.trim() && { model: input.model.trim() }),
    ...(input.modelProvider?.trim() && { modelProvider: input.modelProvider.trim() }),
    config: prepared.threadConfig,
  });
}

/**
 * Resume an interrupted subagent (Codex child thread) via `thread/resume`.
 * Requires `codex_thread_attribution` for agentId (= child codexThreadId).
 * Map missing → explicit error (never silently create a new child thread).
 */
export async function resumeCodexSubagentThread(input: {
  agentId: string;
  followupTask: string;
  cwd?: string;
  model?: string;
  modelProvider?: string;
}): Promise<{
  codexThreadId: string;
  followupPrompt: string;
  resume: CodexThreadResumeResult;
}> {
  const runtimeDeps = requireDeps();
  const codexThreadId = requireCodexSubagentThreadId(
    (id) => runtimeDeps.threadMap.getThreadAttribution(id),
    input.agentId,
  );
  const attribution = runtimeDeps.threadMap.getThreadAttribution(codexThreadId);
  const parentEcoThreadId = attribution?.parentThreadId
    ? runtimeDeps.threadMap.getEcoThreadId(attribution.parentThreadId)
    : undefined;
  const roleId = attribution?.agentRole?.trim();
  const roleThreadConfig =
    parentEcoThreadId && roleId
      ? preparedRuntimeByThread.get(parentEcoThreadId)?.roleThreadConfigs[roleId]
      : undefined;
  if (!roleThreadConfig) {
    throw new CodexResumeNotAvailable(
      `Codex subagent resume cannot reapply the MCP policy for role '${roleId || "unknown"}'.`,
      {
        nextAction:
          "Prepare the parent Eco thread with the same orchestration before resuming this subagent.",
      },
    );
  }
  const client = getCodexRuntimeClientForThread(codexThreadId);
  if (!client) {
    throw new CodexResumeNotAvailable(
      "Codex subagent resume is not available because the Codex app-server client is not running.",
      {
        nextAction: "Start a Codex-backed turn to bring the app-server online, then retry subagent resume.",
      },
    );
  }
  const resume = await resumeCodexThread(client, {
    threadId: codexThreadId,
    ...(input.cwd?.trim() && { cwd: input.cwd.trim() }),
    ...(input.model?.trim() && { model: input.model.trim() }),
    ...(input.modelProvider?.trim() && { modelProvider: input.modelProvider.trim() }),
    config: roleThreadConfig,
  });
  return {
    codexThreadId,
    followupPrompt: buildCodexSubagentFollowupPrompt(codexThreadId, input.followupTask),
    resume,
  };
}

/** Query app-server status for a mapped Eco thread (orphan recovery). */
export async function queryCodexThreadStatusForEcoThread(
  ecoThreadId: string,
): Promise<CodexThreadStatusKind | undefined> {
  const runtimeDeps = requireDeps();
  const codexThreadId = runtimeDeps.threadMap.getCodexThreadId(ecoThreadId.trim());
  if (!codexThreadId) {
    return undefined;
  }
  const client = getCodexRuntimeClientForThread(codexThreadId);
  if (!client) {
    return undefined;
  }
  return readCodexThreadStatus(client, codexThreadId);
}

/**
 * Refuse Skills toggles on a loaded Codex thread.
 * Loaded-idle resume cannot prove config reload (Codex defect); Eco never cold-restarts
 * the shared app-server for Skills. Block at save time so chat stays usable.
 */
export async function assertCodexSkillsConfigReloadAllowed(
  ecoThreadId: string,
  existingSkills: SkillsEnabledSettings | undefined,
  nextSkills: SkillsEnabledSettings | undefined,
): Promise<void> {
  const skillsChanged = skillsEnabledSettingsChanged(existingSkills, nextSkills);
  if (!skillsChanged) {
    return;
  }
  const codexThreadId = getCodexThreadId(ecoThreadId);
  const hasCodexMapping = Boolean(codexThreadId);
  let status: CodexThreadStatusKind | undefined;
  if (hasCodexMapping) {
    const client = getCodexRuntimeClientForThread(codexThreadId ?? "");
    if (client?.isInitialized && codexThreadId) {
      try {
        status = await readCodexThreadStatus(client, codexThreadId);
      } catch {
        // Cannot prove notLoaded → treat as loaded so we never save a doomed config.
        status = "unknown";
      }
    }
  }
  if (
    shouldBlockCodexSkillsConfigReload({
      skillsChanged,
      hasCodexMapping,
      status,
    })
  ) {
    throw new Error(CODEX_SKILLS_CONFIG_RELOAD_BLOCKED_MESSAGE);
  }
}

export async function forkCodexThreadForEcoThread(input: {
  ecoThreadId: string;
  targetItemId: string;
}): Promise<void> {
  const runtimeDeps = requireDeps();
  const ecoThreadId = input.ecoThreadId.trim();
  const targetItemId = input.targetItemId.trim();
  if (!ecoThreadId) {
    throw new CodexForkNotAvailable("Codex fork is not available because the Eco thread id is missing.", {
      nextAction: "Retry rewind from a Codex-backed thread that has a persisted Eco thread id.",
    });
  }
  if (!targetItemId) {
    throw new CodexForkNotAvailable(
      "Codex fork is not available because the target Codex item id is missing.",
      {
        nextAction: "Select a user message that has a persisted Codex item id, then retry rewind.",
      },
    );
  }
  const codexThreadId = runtimeDeps.threadMap.getCodexThreadId(ecoThreadId);
  if (!codexThreadId) {
    throw new CodexForkNotAvailable(
      "Codex fork is not available because this Eco thread has no Codex thread mapping.",
      {
        nextAction:
          "Run this thread through the Codex app-server once so Eco can persist its Codex thread id, then retry rewind.",
      },
    );
  }

  const prepared = preparedRuntimeByThread.get(ecoThreadId);
  if (!prepared?.mainThreadModel) {
    throw new CodexForkNotAvailable("Codex fork requires prepared model and session configuration.", {
      nextAction: "Prepare the current model, orchestration and MCP selection before rewinding.",
    });
  }
  const client = getCodexRuntimeClientForThread(codexThreadId) ?? (await ensureCodexControlPlaneClient());
  const status = await readCodexThreadStatus(client, codexThreadId);
  if (status === "notLoaded") {
    await resumeCodexThread(client, {
      threadId: codexThreadId,
      ...prepared.mainThreadModel,
      config: prepared.threadConfig,
    });
    const appliedByThread = controlPlaneAppliedConfigByClient.get(client) ?? new Map<string, object>();
    appliedByThread.set(codexThreadId, prepared.threadConfig);
    controlPlaneAppliedConfigByClient.set(client, appliedByThread);
  } else if (status !== "idle" && status !== "systemError") {
    throw new CodexForkNotAvailable(`Codex fork requires an idle thread; current status is ${status}.`, {
      nextAction: "Wait for the active turn to finish, then retry rewind.",
    });
  }

  const targetTurnIndex =
    runtimeDeps.resolveCodexForkTurnIndex?.(ecoThreadId, targetItemId) ??
    runtimeDeps.resolveCodexRollbackTurnIndex?.(ecoThreadId, targetItemId);

  const forkResult = await forkCodexThread(client, {
    threadId: codexThreadId,
    itemId: targetItemId,
    ...prepared.mainThreadModel,
    config: prepared.threadConfig,
    ...(prepared.orchestrationAppend ? { developerInstructions: prepared.orchestrationAppend } : {}),
    ...(targetTurnIndex !== undefined ? { targetTurnIndex } : {}),
  });

  // Remap Eco ↔ Codex (or clear) before local prune so the next turn/start reads
  // the post-fork thread id. A malformed fork response must not strand the local
  // mapping. The fork is conversation-only: worktree files are untouched.
  const appliedByThread = controlPlaneAppliedConfigByClient.get(client);
  const previousAppliedConfig = appliedByThread?.get(codexThreadId);
  appliedByThread?.delete(codexThreadId);

  try {
    if (forkResult.clearMapping) {
      runtimeDeps.threadMap.deleteMapping(ecoThreadId);
    } else {
      const newCodexThreadId = forkResult.thread?.id?.trim();
      if (!newCodexThreadId) {
        throw new CodexForkNotAvailable(
          "Codex fork returned no new thread id and did not request mapping clear.",
          {
            nextAction: "Retry rewind after confirming app-server thread/fork returns thread.id.",
          },
        );
      }
      if (
        forkResult.modelProvider !== prepared.mainThreadModel.modelProvider ||
        forkResult.model !== prepared.mainThreadModel.model
      ) {
        throw new CodexForkNotAvailable(
          `Codex fork returned unexpected model settings: requested ${prepared.mainThreadModel.modelProvider}/${prepared.mainThreadModel.model}, received ${forkResult.modelProvider ?? "(missing provider)"}/${forkResult.model ?? "(missing model)"}.`,
          { nextAction: "Check app-server thread/fork configuration support before retrying rewind." },
        );
      }
      runtimeDeps.threadMap.setMapping(ecoThreadId, newCodexThreadId);
      // This config was explicitly submitted to fork; a parent's fingerprint proves nothing here.
      recordAppliedCodexThreadConfig(client, newCodexThreadId, prepared.threadConfig);
      const nextApplied = controlPlaneAppliedConfigByClient.get(client) ?? new Map<string, object>();
      nextApplied.set(newCodexThreadId, prepared.threadConfig);
      controlPlaneAppliedConfigByClient.set(client, nextApplied);
      recordCodexRuntimeThreadOwner(newCodexThreadId, client);
      runtimeDeps.onCodexThreadMapped?.(newCodexThreadId);
    }

    // Remote fork succeeded — prune local run-event / activity / projection so the
    // Feed matches the post-fork thread. Files are untouched; fork is conversation-only.
    const pruneThread = runtimeDeps.pruneThreadAfterCodexFork ?? runtimeDeps.pruneThreadAfterCodexRollback;
    if (!pruneThread) {
      throw new CodexForkNotAvailable(
        "Codex fork succeeded on app-server but local prune is not configured.",
        {
          nextAction:
            "Wire pruneThreadAfterCodexFork during configureCodexRuntimeRun so local feed state matches the remote thread.",
        },
      );
    }
    pruneThread(ecoThreadId, targetItemId);
  } catch (error) {
    // Local prune/mapping failed after the remote fork. Archive the orphan forked
    // thread and restore the original mapping. Files are untouched — no rollback.
    const forkedThreadId = forkResult.thread?.id?.trim();
    if (forkedThreadId) {
      try {
        if (runtimeDeps.archiveCodexThread) {
          await runtimeDeps.archiveCodexThread(forkedThreadId);
        } else {
          await client.request("thread/archive", { threadId: forkedThreadId });
        }
      } catch (archiveError) {
        runtimeDeps.onStderr?.(
          `Codex orphan fork archive failed thread=${forkedThreadId}: ${String(archiveError)}`,
        );
      }
    }
    runtimeDeps.threadMap.setMapping(ecoThreadId, codexThreadId);
    if (previousAppliedConfig) {
      const restoredApplied = controlPlaneAppliedConfigByClient.get(client) ?? new Map<string, object>();
      restoredApplied.set(codexThreadId, previousAppliedConfig);
      controlPlaneAppliedConfigByClient.set(client, restoredApplied);
    }
    throw error;
  }
}

/** @deprecated Use forkCodexThreadForEcoThread. */
export async function rollbackCodexThreadForEcoThread(input: {
  ecoThreadId: string;
  targetItemId: string;
}): Promise<void> {
  return forkCodexThreadForEcoThread(input);
}

export function resolveCodexExecutable(): string | undefined {
  const fromEnv = process.env.CODEX_EXECUTABLE?.trim();
  if (fromEnv && isRunnableCodexExecutable(fromEnv)) {
    return fromEnv;
  }

  const resourcesPath = readElectronResourcesPath();
  const packaged = resolvePackagedCodexExecutableCandidate({
    resourcesPath,
  });
  if (packaged && isRunnableCodexExecutable(packaged)) {
    return packaged;
  }
  if (resourcesPath && fs.existsSync(path.join(resourcesPath, "app.asar"))) {
    return undefined;
  }

  for (const candidate of getProjectCodexCandidates()) {
    if (isRunnableCodexExecutable(candidate)) {
      return candidate;
    }
  }

  for (const candidate of LOCAL_CODEX_CANDIDATES) {
    if (isRunnableCodexExecutable(candidate)) {
      return candidate;
    }
  }

  const fromPath = resolveCodexExecutableFromPath();
  if (fromPath && isRunnableCodexExecutable(fromPath)) {
    return fromPath;
  }

  return undefined;
}

export function isCodexCliAvailable(): boolean {
  return resolveCodexExecutable() !== undefined;
}

export async function listCodexModels(): Promise<CodexModelCatalogEntryView[]> {
  return getCodexModelCatalogService().list();
}

/**
 * Starts the shared app-server with the same approval and event handlers used by turns.
 * Control-plane callers must use this entry point instead of creating an under-configured global lifecycle.
 */
export async function ensureCodexControlPlaneClient(): Promise<CodexAppServerClient> {
  const runtimeDeps = requireDeps();
  const codexExecutable = resolveCodexExecutable();
  if (!codexExecutable) {
    throw new Error(
      "Codex CLI not found or not runnable. Install workspace dependencies or set CODEX_EXECUTABLE before using Codex control-plane APIs.",
    );
  }
  const client = await startSharedCodexRuntimeLifecycle(runtimeDeps, codexExecutable);
  if (!client.isInitialized) {
    throw new Error("Codex app-server client is not initialized after lifecycle start.");
  }
  return client;
}

export function clearCodexModelCatalogCache(): void {
  modelCatalogService?.clear();
}

/**
 * Force the next global runtime prepare to cold-restart the shared app-server
 * even when the config/catalog contents are unchanged. Account credentials
 * (auth.json) and the account proxy are not part of the config fingerprint,
 * so the fingerprint gate in prepareCodexRuntime cannot detect those changes
 * on its own.
 */
export function requestCodexAccountRuntimeRestart(reason: "account" | "account_proxy"): void {
  if (reason !== "account" && reason !== "account_proxy") {
    throw new Error("Only account credentials or account proxy changes may force a Codex runtime restart.");
  }
  forcedRuntimeRestart = reason;
  accountRefreshPending = true;
  accountRestartRevision += 1;
}

/** Queue a settings-driven refresh without interrupting active Codex turns. */
export function scheduleCodexGlobalRuntimeRefresh(options?: { beforePrepare?: () => Promise<void> }): void {
  if (globalRuntimeRefreshShuttingDown) return;
  if (options?.beforePrepare) beforeGlobalRuntimeRefresh = options.beforePrepare;
  desiredGlobalRuntimeRevision += 1;
  refreshPending = true;
  globalRefreshError = undefined;
  if (globalRefreshPromise) {
    return;
  }
  globalRefreshPromise = (async () => {
    do {
      const revision = desiredGlobalRuntimeRevision;
      try {
        const beforePrepare = beforeGlobalRuntimeRefresh;
        // Account changes are explicit: old account requests may fail after
        // publication, while unrelated gateway requests keep their generation.
        if (beforePrepare) {
          if (forcedRuntimeRestart !== "account") {
            throw new Error("A Codex account transition requires the explicit account restart reason.");
          }
          if (globalRuntimeRefreshShuttingDown) return;
          if (revision !== desiredGlobalRuntimeRevision) continue;
        }
        beforeGlobalRuntimeRefresh = undefined;
        await beforePrepare?.();
        if (globalRuntimeRefreshShuttingDown) return;
        if (revision !== desiredGlobalRuntimeRevision) {
          continue;
        }
        await prepareCodexRuntime({
          globalOnly: true,
          globalRuntimeRevision: revision,
          signal: globalRefreshIdleAbortController.signal,
        });
        globalRefreshError = undefined;
        if (
          loadedGlobalRuntimeRevision === desiredGlobalRuntimeRevision &&
          forcedRuntimeRestart === undefined
        ) {
          accountRefreshPending = false;
        }
      } catch (error) {
        if (globalRuntimeRefreshShuttingDown && error === globalRefreshIdleAbortController.signal.reason)
          return;
        // A newer request may have superseded the operation that failed. Keep
        // the refresh coordinator alive and try the latest queued transition.
        if (revision !== desiredGlobalRuntimeRevision) {
          continue;
        }
        throw error;
      }
    } while (loadedGlobalRuntimeRevision !== desiredGlobalRuntimeRevision);
  })()
    .catch((error) => {
      globalRefreshError = error instanceof Error ? error : new Error(String(error));
      requireDeps().onStderr?.(
        `[eco-codex] deferred global runtime refresh failed: ${globalRefreshError.message}`,
      );
    })
    .finally(() => {
      globalRefreshPromise = undefined;
      refreshPending = loadedGlobalRuntimeRevision !== desiredGlobalRuntimeRevision;
    });
}

/** Stop queued refreshes and wait for in-flight account/config work before shutdown. */
export async function shutdownCodexGlobalRuntimeRefresh(): Promise<void> {
  globalRuntimeRefreshShuttingDown = true;
  beforeGlobalRuntimeRefresh = undefined;
  globalRefreshIdleAbortController.abort(new Error("Codex runtime refresh is shutting down."));
  await globalRefreshPromise;
}

export async function prepareCodexRuntime(
  input: PrepareCodexRuntimeInput = {},
): Promise<PreparedCodexRuntime> {
  if (globalRuntimeRefreshShuttingDown && !input.globalOnly) {
    throw new Error("Codex runtime is shutting down; new tasks are blocked.");
  }
  // Account publication/restart must not gate an unchanged custom provider.
  // This branch is thread-only and must not queue behind account I/O on the
  // global materialization tail.
  if (!input.globalOnly && refreshPending && canUseGatewayRuntimeDuringAccountRefresh(input)) {
    return prepareCodexRuntimeUnlocked(input);
  }
  // A thread selecting a just-saved model must wait for the already-scheduled
  // baseline refresh. Keep this outside prepareRuntimeTail: the refresher must
  // later enqueue its own materialization work on that same tail.
  if (!input.globalOnly && refreshPending) {
    if (globalRefreshPromise) {
      await awaitGlobalRuntimeRefresh(globalRefreshPromise, input.signal);
    }
    if (globalRefreshError) throw globalRefreshError;
    if (refreshPending)
      throw new Error("Codex runtime refresh did not complete; new tasks are blocked until it succeeds.");
  }
  const run = prepareRuntimeTail.then(() => prepareCodexRuntimeUnlocked(input));
  prepareRuntimeTail = run.then(
    () => undefined,
    () => undefined,
  );
  return await run;
}

function gatewayProviderFingerprint(providers = requireDeps().listProviders()): string {
  return JSON.stringify(providers.filter((provider) => provider.id !== "openai"));
}

type RuntimeBaselineInput = Pick<PrepareCodexRuntimeInput, "globalOnly" | "globalRuntimeRevision"> & {
  gatewayFingerprint: string;
  accountRestartRevision: number;
  accountModelContexts?: string;
};

function canUseGatewayRuntimeDuringAccountRefresh(input: PrepareCodexRuntimeInput): boolean {
  const orchestration = input.agentRegistry?.orchestration;
  const requiredProviders = [
    ...(input.requiredProviderIds ?? []),
    ...(input.mainProviderId ? [input.mainProviderId] : []),
    ...(orchestration
      ? [
          orchestration.mainAgent.modelRef.providerId,
          ...orchestration.agents.filter((agent) => agent.enabled).map((agent) => agent.modelRef.providerId),
        ]
      : []),
  ];
  return (
    accountRefreshPending &&
    hasLoadedGlobalRuntimeBaseline() &&
    requiredProviders.length > 0 &&
    requiredProviders.every((id) => id !== "openai") &&
    loadedGatewayProviderFingerprint === gatewayProviderFingerprint() &&
    catalogRoutesAreAvailable(input.requiredCatalogRoutes ?? [], loadedModelCatalogSlugs)
  );
}

function awaitGlobalRuntimeRefresh(refresh: Promise<void>, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  if (!signal) {
    return refresh;
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error("Codex global runtime refresh was cancelled."));
    signal.addEventListener("abort", onAbort, { once: true });
    void refresh.then(
      () => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

async function prepareCodexRuntimeUnlocked(input: PrepareCodexRuntimeInput): Promise<PreparedCodexRuntime> {
  input.signal?.throwIfAborted();
  const runtimeDeps = requireDeps();
  const providers = [...runtimeDeps.listProviders()];
  const baselineInput: PrepareCodexRuntimeInput & RuntimeBaselineInput = {
    ...input,
    globalRuntimeRevision: input.globalRuntimeRevision ?? desiredGlobalRuntimeRevision,
    gatewayFingerprint: gatewayProviderFingerprint(providers),
    accountRestartRevision,
  };
  const codexExecutable = resolveCodexExecutable();
  if (!codexExecutable) {
    throw new Error(
      "Codex CLI not found or not runnable. Run workspace dependency install so `node_modules/.bin/codex` exists, set CODEX_EXECUTABLE to a working Codex CLI, or build from openai/codex (see docs/codex-integration-tasks.md §5.2).",
    );
  }

  const codexHomeDir = resolveCodexHomeDir(runtimeDeps.ecoDataDir);
  const resolveModelRemoteCompaction = createCodexRemoteCompactionResolver(
    providers,
    input.requiredCatalogRoutes,
  );
  // Global config.toml must stay identical across thread switches. Only the
  // thread-visible descriptors are per-thread and they travel through the
  // thread config overrides passed to thread/start / thread/resume.
  const threadMcpServers = input.globalOnly ? [] : (input.mcpServers ?? []);
  const globalMcpServers = input.globalMcpServers ?? (await runtimeDeps.listGlobalMcpServers?.()) ?? [];
  const globalUserRules =
    [runtimeDeps.getGlobalUserRules?.()?.trim(), input.systemPromptAppend?.trim()]
      .filter((value): value is string => Boolean(value))
      .join("\n\n") || undefined;
  const registryAppend = input.agentRegistry
    ? buildCodexMainAgentOrchestrationAppend(
        input.agentRegistry.orchestration,
        input.agentRegistry.templates,
        {
          ...(input.subagentAvailability ? { subagentAvailability: input.subagentAvailability } : {}),
          ...(globalUserRules ? { globalUserRules } : {}),
        },
      )
    : mergeMainAgentAppendParts({
        ...(globalUserRules ? { globalUserRules } : {}),
      });
  const orchestrationAppend = registryAppend?.trim() || undefined;
  const registryToolPolicy = input.agentRegistry
    ? normalizeCodexToolPolicy(input.agentRegistry.orchestration.mainAgent.tools, { allowSpawnDefault: true })
    : undefined;
  const confirmedToolPolicy = input.executionConfirmationMode
    ? applyCodexExecutionConfirmation(
        registryToolPolicy ?? DEFAULT_CODEX_TOOL_POLICY,
        input.executionConfirmationMode,
      )
    : registryToolPolicy;
  const orchestrationToolPolicy = input.webSearchOverride
    ? {
        ...(confirmedToolPolicy ?? DEFAULT_CODEX_TOOL_POLICY),
        webSearch: input.webSearchOverride,
      }
    : confirmedToolPolicy;
  const roleSync =
    input.agentRegistry && input.enableSubagents !== false
      ? await syncOrchestrationAgentsToCodexRoles({
          codexHomeDir,
          orchestration: input.agentRegistry.orchestration,
          templates: input.agentRegistry.templates,
          mcpServers: threadMcpServers,
          ...(input.threadEnabledMcpServerNames
            ? { threadEnabledMcpServers: input.threadEnabledMcpServerNames }
            : {}),
          ...(input.subagentAvailability ? { subagentAvailability: input.subagentAvailability } : {}),
          ...(input.executionConfirmationMode
            ? { executionConfirmationMode: input.executionConfirmationMode }
            : {}),
          ...(input.webSearchOverride ? { webSearchOverride: input.webSearchOverride } : {}),
          resolveSupportsImageInput: (ref) =>
            input.requiredCatalogRoutes?.find(
              (route) => route.providerId === ref.providerId && route.modelId === ref.modelId,
            )?.manualSpec?.supportsImageInput,
        })
      : undefined;

  if (roleSync && roleSync.roles.length > 0) {
    assertCodexRoleProvidersAvailable(roleSync.roles, providers);
  }
  lastPreparedRoleIds = roleSync?.roleIds ?? [];
  const baseThreadConfig =
    roleSync?.threadConfig ??
    withCodexMcpServerDefinitions(buildDenyAllMcpThreadConfig(threadMcpServers), threadMcpServers);
  // web_search is a thread config field, not a turn/start permission. Materializing
  // orchestrationToolPolicy alone does not register the native tool on the main actor.
  const threadConfigWithWebSearch = {
    ...baseThreadConfig,
    web_search: orchestrationToolPolicy?.webSearch ?? DEFAULT_CODEX_TOOL_POLICY.webSearch,
  };
  const mainProviderId =
    input.mainProviderId ?? input.agentRegistry?.orchestration.mainAgent.modelRef.providerId;
  const mainModelId = input.mainModelId ?? input.agentRegistry?.orchestration.mainAgent.modelRef.modelId;
  let accountModels: readonly CodexAccountModelContext[] | undefined;
  const accountRefs = [
    { providerId: mainProviderId, modelId: mainModelId },
    ...(roleSync?.roles ?? []),
  ].filter((ref) => ref.providerId === "openai" && ref.modelId);
  if (runtimeDeps.listAccountModels && accountRefs.length > 0) {
    accountModels = await runtimeDeps.listAccountModels();
    for (const ref of accountRefs) {
      if (ref.providerId === "openai" && ref.modelId) {
        requireCodexAccountContextWindow(accountModels, ref.modelId);
      }
    }
  }
  if (accountModels) {
    baselineInput.accountModelContexts = fingerprintAccountModelContexts(accountModels);
  }
  const mainRemoteCompaction =
    mainProviderId && mainModelId
      ? resolveModelRemoteCompaction({
          providerId: mainProviderId,
          modelId: mainModelId,
          ...(input.mainApiCompat ? { apiCompat: input.mainApiCompat } : {}),
        })
      : "unsupported";
  if (mainProviderId && mainModelId) {
    assertCodexSubagentCompactionCompatible(
      mainRemoteCompaction,
      roleSync?.roles ?? [],
      resolveModelRemoteCompaction,
    );
  }
  const prepared: PreparedCodexRuntime = {
    ...(mainProviderId && mainModelId
      ? {
          mainThreadModel: {
            modelProvider:
              mainProviderId === "openai" ? "openai" : buildCodexModelProviderSlug(mainProviderId),
            model:
              mainProviderId === "openai"
                ? mainModelId
                : buildCodexGatewayModelAlias(mainProviderId, mainModelId, input.mainApiCompat),
          },
        }
      : {}),
    ...(orchestrationAppend ? { orchestrationAppend } : {}),
    ...(orchestrationToolPolicy ? { orchestrationToolPolicy } : {}),
    roleIds: roleSync?.roleIds ?? [],
    roleToolPolicies: Object.fromEntries(
      (roleSync?.roles ?? []).map((role) => [role.roleId, role.toolPolicy]),
    ),
    threadConfig: withCodexSkillConfig(
      mainProviderId
        ? withCodexRemoteCompaction(
            withCodexNativeImageView(threadConfigWithWebSearch, mainProviderId, input.mainSupportsImageInput),
            mainProviderId,
            mainRemoteCompaction,
          )
        : threadConfigWithWebSearch,
      input.skillConfig ?? [],
    ),
    roleThreadConfigs: Object.fromEntries(
      Object.entries(roleSync?.roleThreadConfigs ?? {}).map(([role, config]) => {
        const definition = roleSync?.roles.find((entry) => entry.roleId === role);
        if (!definition) throw new Error(`Missing Codex role definition: ${role}`);
        return [
          role,
          withCodexSkillConfig(
            withCodexRemoteCompaction(
              input.webSearchOverride ? { ...config, web_search: input.webSearchOverride } : config,
              definition.providerId,
              mainRemoteCompaction,
            ),
            input.skillConfig ?? [],
          ),
        ];
      }),
    ),
  };

  runtimeDeps.onStderr?.(
    `[eco-codex] multi-agent roles=${roleSync?.roleIds.join(",") || "(none)"} orchestrationAppendChars=${orchestrationAppend?.length ?? 0}`,
  );

  // Push ProviderStore models into in-process eco-gateway before Codex calls /v1/responses.
  // Note: providerId "openai" is the built-in Codex provider (auth.json) — no Gateway needed.
  const roleProviderIds = roleSync?.roles.map((role) => role.providerId) ?? [];
  const requiredProviderIds = [
    ...new Set(
      [...(input.requiredProviderIds ?? []), ...roleProviderIds]
        .map((id) => id.trim())
        .filter((id) => Boolean(id) && id !== "openai"),
    ),
  ];
  const gatewayProviders =
    requiredProviderIds.length > 0 ? await ensureGlobalEcoGateway({ requiredProviderIds }) : [];
  if (gatewayProviders.length > 0) {
    runtimeDeps.onStderr?.(
      `[eco-gateway] ready providers=${gatewayProviders.map((p) => `${p.id}[${p.models.join("|")}]`).join(", ")}`,
    );
  } else {
    runtimeDeps.onStderr?.(`[eco-gateway] skipped (no Gateway providers needed)`);
  }

  // Once a global baseline is loaded, normal thread preparation is deliberately
  // thread-only: role files and thread/start config may differ, but neither the
  // catalog nor config.toml may be regenerated by a concurrent session.
  if (
    !input.globalOnly &&
    hasLoadedGlobalRuntimeBaseline() &&
    (baselineInput.accountModelContexts === undefined ||
      baselineInput.accountModelContexts === loadedAccountModelContexts)
  ) {
    assertCatalogRoutesAvailable(input.requiredCatalogRoutes ?? [], loadedModelCatalogSlugs);
    assertThreadMcpServersAvailable(input.threadEnabledMcpServerNames ?? [], [
      ...loadedGlobalMcpServerNames,
      ...threadMcpServers.map((server) => server.name),
    ]);
    assertCatalogRoutesAvailable(
      (roleSync?.roles ?? []).map((role) => ({
        providerId: role.providerId,
        modelId: role.modelId,
        apiCompat:
          role.apiCompat ??
          providers.find((provider) => provider.id === role.providerId)?.apiCompat ??
          "openai_responses",
      })),
      loadedModelCatalogSlugs,
    );
    const client = await startSharedCodexRuntimeLifecycle(runtimeDeps, codexExecutable);
    if (!client.isInitialized) {
      throw new Error("Codex app-server client is not initialized after lifecycle start.");
    }
    return finishPreparedRuntime(client, prepared, input);
  }

  // Formal model catalog is a settings-level superset, never a mutable per-thread input.
  const catalogRoutes = await collectCatalogRoutesForRuntime(runtimeDeps);
  accountModels ??= await runtimeDeps.listAccountModels?.();
  if (accountModels) baselineInput.accountModelContexts = fingerprintAccountModelContexts(accountModels);
  const catalogSync = await syncEcoCodexModelCatalog({
    ecoDataDir: runtimeDeps.ecoDataDir,
    codexExecutable,
    routes: catalogRoutes,
    ...(accountModels ? { accountModels } : {}),
    ...(runtimeDeps.getGlobalContextWindowLimit
      ? { globalContextWindowLimit: runtimeDeps.getGlobalContextWindowLimit() }
      : {}),
  });
  runtimeDeps.onStderr?.(
    `[eco-codex] model catalog path=${catalogSync.catalogPath} aliases=${catalogSync.aliasSlugs.length} native=${catalogSync.nativeModelCount} changed=${catalogSync.changed}`,
  );

  const globalConfigInput = {
    ecoDataDir: runtimeDeps.ecoDataDir,
    providers,
    mcpServers: globalMcpServers,
    modelCatalogJsonPath: catalogSync.catalogPath,
    ...(globalMultiAgentSupportRequired ? { enableMultiAgent: true } : {}),
  };
  const configSync = await syncCodexConfigFromEcoProviders(globalConfigInput);

  const configToml = fs.readFileSync(configSync.configPath, "utf8");
  if (!configToml.includes("model_catalog_json =")) {
    throw new Error(
      `Codex config sync failed: model_catalog_json was not written to ${configSync.configPath}.`,
    );
  }
  if (roleSync && roleSync.agentRoles.length > 0) {
    const hasStableMultiAgent =
      configToml.includes("[features]") &&
      configToml.includes("multi_agent = true") &&
      configToml.includes("hooks = true") &&
      configToml.includes("[agents]") &&
      configToml.includes("max_threads = 16") &&
      configToml.includes("max_depth = 1");
    if (!hasStableMultiAgent) {
      throw new Error(
        `Codex config sync failed: stable multi-agent [features]/[agents] settings were not written to ${configSync.configPath} despite agent roles.`,
      );
    }
    for (const role of roleSync.roles) {
      if (configToml.includes(`[agents.${role.roleId}]`)) {
        throw new Error(
          `Codex config sync failed: mutable global [agents.${role.roleId}] leaked into ${configSync.configPath}.`,
        );
      }
      if (!fs.existsSync(role.rolePath)) {
        throw new Error(`Codex role sync failed: missing immutable role file ${role.rolePath}.`);
      }
      const threadRole = prepared.threadConfig.agents?.[role.roleId];
      if (
        !threadRole ||
        typeof threadRole !== "object" ||
        (threadRole as { config_file?: unknown }).config_file !== role.rolePath
      ) {
        throw new Error(
          `Codex thread config failed: role '${role.roleId}' is not bound to ${role.rolePath}.`,
        );
      }
    }
  }

  for (const server of globalMcpServers) {
    if (!configToml.includes(`[mcp_servers.${server.name}]`)) {
      throw new Error(
        `Codex MCP sync failed: missing [mcp_servers.${server.name}] in ${configSync.configPath}.`,
      );
    }
  }
  if (globalMcpServers.length === 0 && configToml.includes("[mcp_servers.")) {
    throw new Error(
      `Codex MCP sync failed: config.toml still contains [mcp_servers.*] after clearing MCP selection (${configSync.configPath}).`,
    );
  }
  if (threadMcpServers.some((server) => configToml.includes(`[mcp_servers.${server.name}]`))) {
    throw new Error(
      `Codex MCP sync failed: a thread-scoped MCP server leaked into ${configSync.configPath}.`,
    );
  }

  // Fail before Codex app-server starts: dead ports / notification≠202 look like silent MCP absence.
  // Thread-scoped descriptors are checked here too; they reach Codex through the thread config.
  await assertEcoHttpMcpServersReachable([...globalMcpServers, ...threadMcpServers], (message) => {
    runtimeDeps.onStderr?.(`${message}\n`);
  });

  runtimeDeps.onStderr?.(
    `[eco-codex] config ${configSync.configPath} gateway=${configSync.gatewayBaseUrl} providers=${configSync.providerSlugs.join(",")} mcp=${configSync.mcpServerNames.join(",") || "(none)"} catalog=${configSync.modelCatalogJsonPath ?? "(none)"}`,
  );

  assertCatalogRoutesAvailable(input.requiredCatalogRoutes ?? [], catalogSync.modelSlugs);
  assertCatalogRoutesAvailable(
    (roleSync?.roles ?? []).map((role) => ({
      providerId: role.providerId,
      modelId: role.modelId,
      apiCompat:
        role.apiCompat ??
        providers.find((provider) => provider.id === role.providerId)?.apiCompat ??
        "openai_responses",
    })),
    catalogSync.modelSlugs,
  );

  // Global MCP has a native reload RPC; candidate capabilities are thread
  // overrides. Neither belongs in the process-launch restart fingerprint.
  const globalConfigFingerprint = fingerprintCodexProviderConfig(
    buildCodexConfigToml({ ...globalConfigInput, mcpServers: [] }),
  );
  // A save that races catalog/config generation is intentionally coalesced before
  // restart. It is safe to rewrite files while all threads are idle; only the
  // final desired revision may restart the shared app-server.
  if (
    input.globalOnly &&
    input.globalRuntimeRevision !== undefined &&
    input.globalRuntimeRevision !== desiredGlobalRuntimeRevision
  ) {
    return prepared;
  }
  const catalogNeedsRestart = catalogSync.runtimeFingerprint !== lastPreparedModelCatalogFingerprint;
  const configNeedsRestart =
    globalConfigFingerprint !== lastPreparedGlobalConfigFingerprint || forcedRuntimeRestart !== undefined;
  if (catalogNeedsRestart || configNeedsRestart) {
    await ensureCodexRuntimeRestart(
      runtimeDeps,
      codexExecutable,
      catalogSync.modelSlugs,
      configSync.mcpServerNames,
      catalogSync.runtimeFingerprint,
      globalConfigFingerprint,
      baselineInput,
      forcedRuntimeRestart ?? (catalogNeedsRestart ? "model_catalog" : "launch_config"),
    );
  }
  if (
    input.globalOnly &&
    input.globalRuntimeRevision !== undefined &&
    input.globalRuntimeRevision !== desiredGlobalRuntimeRevision
  )
    return prepared;

  if (input.globalOnly && !getGlobalCodexRuntimeLifecycle()?.getClient()) {
    markLoadedGlobalRuntimeBaseline(
      catalogSync.modelSlugs,
      configSync.mcpServerNames,
      catalogSync.runtimeFingerprint,
      globalConfigFingerprint,
      baselineInput,
    );
    return prepared;
  }

  const client = await startSharedCodexRuntimeLifecycle(runtimeDeps, codexExecutable);

  if (!client.isInitialized) {
    throw new Error("Codex app-server client is not initialized after lifecycle start.");
  }
  if (!catalogNeedsRestart && !configNeedsRestart) {
    // First successful prepare or unchanged baseline still pins the loaded fingerprints.
    markLoadedGlobalRuntimeBaseline(
      catalogSync.modelSlugs,
      configSync.mcpServerNames,
      catalogSync.runtimeFingerprint,
      globalConfigFingerprint,
      baselineInput,
    );
  }
  clearCodexModelCatalogCache();
  const mcpFingerprint = fingerprintPreparedMcpServers(globalMcpServers);
  const shouldReloadMcp = mcpFingerprint !== lastPreparedMcpFingerprint;
  if (!shouldReloadMcp) {
    runtimeDeps.onStderr?.(
      `[eco-codex] mcp unchanged servers=${configSync.mcpServerNames.join(",") || "(none)"} (skip reload)\n`,
    );
    return finishPreparedRuntime(client, prepared, input);
  }
  try {
    await client.request("config/mcpServer/reload", {});
    lastPreparedMcpFingerprint = mcpFingerprint;
  } catch (error) {
    lastPreparedMcpFingerprint = "";
    throw error;
  }
  runtimeDeps.onStderr?.(`[eco-codex] mcp reload servers=${configSync.mcpServerNames.join(",") || "(none)"}`);
  return finishPreparedRuntime(client, prepared, input);
}

async function finishPreparedRuntime(
  client: CodexAppServerClient,
  prepared: PreparedCodexRuntime,
  input: PrepareCodexRuntimeInput,
): Promise<PreparedCodexRuntime> {
  const release = input.reserveRuntime ? retainCodexRuntimeClient(client) : undefined;
  try {
    const codexThreadId = input.ecoThreadId ? deps?.threadMap.getCodexThreadId(input.ecoThreadId) : undefined;
    if (codexThreadId) await handoffCodexRuntimeThread(codexThreadId, client, input.signal);
    const result = await disableBuiltInImagegenSkill(client, prepared, input.skillDiscoveryCwd);
    result.runtimeClient = client;
    if (release) result.releaseRuntime = release;
    return result;
  } catch (error) {
    release?.();
    throw error;
  }
}

async function disableBuiltInImagegenSkill(
  client: CodexAppServerClient,
  prepared: PreparedCodexRuntime,
  cwd: string | undefined,
): Promise<PreparedCodexRuntime> {
  const discoveryCwd = cwd?.trim();
  if (!discoveryCwd) return prepared;
  const entries = await listCodexSkills(client, { cwds: [discoveryCwd], forceReload: false });
  const disabled = entries
    .flatMap((entry) => entry.skills)
    .filter((skill) => skill.scope === "system" && skill.name.trim().toLowerCase() === "imagegen")
    .map((skill) => ({ path: skill.path, enabled: false }));
  if (disabled.length === 0) return prepared;
  return {
    ...prepared,
    threadConfig: withCodexSkillConfig(prepared.threadConfig, disabled),
    roleThreadConfigs: Object.fromEntries(
      Object.entries(prepared.roleThreadConfigs).map(([role, config]) => [
        role,
        withCodexSkillConfig(config, disabled),
      ]),
    ),
  };
}

async function collectCatalogRoutesForRuntime(
  runtimeDeps: CodexRuntimeRunDeps,
): Promise<CodexGatewayCatalogRoute[]> {
  const providers = runtimeDeps.listProviders();
  const routes = collectCodexGatewayCatalogRoutes({
    providers: providers.map((provider) => {
      const models = (provider.models ?? []).map((model) => ({
        modelId: model.modelId,
        ...(model.displayName ? { displayName: model.displayName } : {}),
        ...(model.apiCompat ? { apiCompat: model.apiCompat } : {}),
        ...(model.manualSpec ? { manualSpec: model.manualSpec } : {}),
      }));
      return {
        id: provider.id,
        name: provider.name,
        enabled: provider.enabled,
        ...(provider.apiCompat ? { apiCompat: provider.apiCompat } : {}),
        ...(provider.defaultModel ? { defaultModel: provider.defaultModel } : {}),
        ...(models.length > 0 ? { models } : {}),
      };
    }),
    routeConfigs: runtimeDeps.listCatalogRouteConfigs?.() ?? [],
    orchestrationAgents: runtimeDeps.listCatalogOrchestrationAgents?.() ?? [],
    effectiveRoutes: runtimeDeps.listCatalogThreadRoutes?.() ?? [],
  });
  if (!runtimeDeps.enrichCatalogRoutes) {
    return routes;
  }
  return runtimeDeps.enrichCatalogRoutes(routes);
}

function assertCatalogRoutesAvailable(
  routes: readonly CodexGatewayCatalogRoute[],
  availableAliases: readonly string[],
): void {
  const available = new Set(availableAliases);
  for (const route of routes) {
    const providerId = route.providerId.trim();
    const modelId = route.modelId.trim();
    if (!providerId || !modelId) {
      continue;
    }
    const alias =
      providerId === "openai" ? modelId : buildCodexGatewayModelAlias(providerId, modelId, route.apiCompat);
    if (!available.has(alias)) {
      throw new Error(
        `Codex model '${providerId}/${modelId}' is not registered in the global model catalog. Save it as a candidate model or route configuration, then wait for the global runtime refresh to finish.`,
      );
    }
  }
}

function catalogRoutesAreAvailable(
  routes: readonly CodexGatewayCatalogRoute[],
  availableAliases: readonly string[],
): boolean {
  const available = new Set(availableAliases);
  return routes.every((route) => {
    const providerId = route.providerId.trim();
    const modelId = route.modelId.trim();
    return (
      !providerId ||
      !modelId ||
      available.has(
        providerId === "openai" ? modelId : buildCodexGatewayModelAlias(providerId, modelId, route.apiCompat),
      )
    );
  });
}

function threadMcpServersAreAvailable(
  enabledServerNames: readonly string[],
  availableServerNames: readonly string[],
): boolean {
  const available = new Set(availableServerNames);
  return enabledServerNames.every((name) => !name.trim() || available.has(name.trim()));
}

function assertThreadMcpServersAvailable(
  enabledServerNames: readonly string[],
  availableServerNames: readonly string[],
): void {
  if (threadMcpServersAreAvailable(enabledServerNames, availableServerNames)) {
    return;
  }
  const available = new Set(availableServerNames.map((name) => name.trim()).filter(Boolean));
  const missing = [
    ...new Set(enabledServerNames.map((name) => name.trim()).filter((name) => name && !available.has(name))),
  ];
  throw new Error(
    `Selected MCP servers have no thread connection descriptor: ${missing.join(", ")}. Check the selected MCP or integration settings before retrying.`,
  );
}

function hasLoadedGlobalRuntimeBaseline(): boolean {
  return loadedGlobalRuntimeRevision >= 0 && lastPreparedModelCatalogFingerprint !== "";
}

function fingerprintAccountModelContexts(models: readonly CodexAccountModelContext[]): string {
  return JSON.stringify(models.map((model) => [model.modelId, model.contextWindow]).sort());
}

function markLoadedGlobalRuntimeBaseline(
  modelSlugs: readonly string[],
  mcpServerNames: readonly string[],
  catalogFingerprint: string,
  configFingerprint: string,
  input: RuntimeBaselineInput,
): void {
  loadedModelCatalogSlugs = [...new Set(modelSlugs)].sort();
  loadedGlobalMcpServerNames = [...new Set(mcpServerNames.map((name) => name.trim()).filter(Boolean))].sort();
  lastPreparedModelCatalogFingerprint = catalogFingerprint;
  lastPreparedGlobalConfigFingerprint = configFingerprint;
  loadedGatewayProviderFingerprint = input.gatewayFingerprint;
  loadedAccountModelContexts = input.accountModelContexts ?? "";
  if (input.accountRestartRevision === accountRestartRevision) forcedRuntimeRestart = undefined;
  if (input.globalOnly) {
    loadedGlobalRuntimeRevision = input.globalRuntimeRevision ?? desiredGlobalRuntimeRevision;
    refreshPending = loadedGlobalRuntimeRevision !== desiredGlobalRuntimeRevision;
  } else if (loadedGlobalRuntimeRevision < 0) {
    // Initial thread startup materializes the first settings snapshot.
    loadedGlobalRuntimeRevision = input.globalRuntimeRevision ?? desiredGlobalRuntimeRevision;
    refreshPending = loadedGlobalRuntimeRevision !== desiredGlobalRuntimeRevision;
  }
}

/**
 * Catalog content is only reloaded by app-server process start.
 * Publish a replacement for new requests while existing turns drain on their original process.
 */
async function ensureCodexRuntimeRestart(
  runtimeDeps: CodexRuntimeRunDeps,
  codexExecutable: string,
  nextModelSlugs: readonly string[],
  nextMcpServerNames: readonly string[],
  nextCatalogFingerprint: string,
  nextConfigFingerprint: string,
  waitOptions: Pick<
    PrepareCodexRuntimeInput,
    "signal" | "onConfigReloadWait" | "globalOnly" | "globalRuntimeRevision"
  > &
    RuntimeBaselineInput,
  reason: CodexRuntimeRestartReason,
): Promise<void> {
  const lifecycle = getGlobalCodexRuntimeLifecycle();
  const client = lifecycle?.getClient();
  if (!client?.isInitialized) {
    // Not started yet — the first start after config write will load this baseline.
    markLoadedGlobalRuntimeBaseline(
      nextModelSlugs,
      nextMcpServerNames,
      nextCatalogFingerprint,
      nextConfigFingerprint,
      waitOptions,
    );
    return;
  }

  waitOptions.signal?.throwIfAborted();
  if (
    waitOptions.globalOnly &&
    waitOptions.globalRuntimeRevision !== undefined &&
    waitOptions.globalRuntimeRevision !== desiredGlobalRuntimeRevision
  )
    return;

  runtimeDeps.onStderr?.(
    `[eco-codex] rolling replacement app-server for ${reason} catalog=${nextCatalogFingerprint.slice(0, 12)}`,
  );
  await startSharedCodexRuntimeLifecycle(runtimeDeps, codexExecutable, true);
  clearCodexModelCatalogCache();
  markLoadedGlobalRuntimeBaseline(
    nextModelSlugs,
    nextMcpServerNames,
    nextCatalogFingerprint,
    nextConfigFingerprint,
    waitOptions,
  );
  // MCP processes are gone with the app-server; force a reload on the next prepare path.
  lastPreparedMcpFingerprint = "";
}

function resolveCodexUserSkillExtraRoots(): string[] {
  const root = path.join(os.homedir(), ".codex", "skills");
  return fs.existsSync(root) ? [root] : [];
}

function buildDenyAllMcpThreadConfig(
  servers: readonly CodexMcpServerForConfigSync[],
): CodexThreadConfigOverrides {
  return {
    features: {
      multi_agent: false,
      hooks: false,
      multi_agent_v2: false,
    },
    mcp_servers: Object.fromEntries(
      servers.map((server) => [server.name.trim(), { enabled: false }]).filter(([name]) => Boolean(name)),
    ),
  };
}

async function startSharedCodexRuntimeLifecycle(
  runtimeDeps: CodexRuntimeRunDeps,
  codexExecutable: string,
  replace = false,
): Promise<CodexAppServerClient> {
  let notificationClient: CodexAppServerClient | undefined;
  const start = replace ? replaceGlobalCodexRuntimeLifecycle : ensureGlobalCodexRuntimeLifecycle;
  const client = await start({
    ecoDataDir: runtimeDeps.ecoDataDir,
    codexExecutable,
    clientOptions: {
      onServerRequest: (method, params) => approvalBridge?.handleServerRequest(method, params),
    },
    onNotification: (method, params) => {
      if (notificationClient && params && typeof params === "object") {
        const payload = params as { threadId?: string; thread?: { id?: string } };
        const id = payload.threadId ?? payload.thread?.id;
        if (id) recordCodexRuntimeThreadOwner(id, notificationClient);
      }
      eventAdapter?.dispatch(method, params);
      approvalBridge?.handleNotification(method, params);
    },
    onStderr: (chunk) => {
      runtimeDeps.onStderr?.(`[codex app-server] ${chunk}`);
    },
  });
  notificationClient = client;
  const clientIdentity = client as CodexAppServerClient & {
    diagnosticInstanceId?: number;
    diagnosticGeneration?: number;
  };
  runtimeDeps.onStderr?.(
    `[eco-codex] app-server client instance=${clientIdentity.diagnosticInstanceId ?? "unknown"} generation=${clientIdentity.diagnosticGeneration ?? "unknown"}`,
  );
  await ensureCodexSkillsExtraRoots(client, resolveCodexUserSkillExtraRoots());
  return client;
}

function fingerprintPreparedMcpServers(servers: readonly CodexMcpServerForConfigSync[]): string {
  return JSON.stringify(
    servers.map((server) => ({
      name: server.name,
      transport: server.transport,
      command: server.command,
      args: server.args,
      env: server.env,
      url: server.url,
      httpHeaders: server.httpHeaders,
      enabledTools: server.enabledTools,
      startupTimeoutSec: server.startupTimeoutSec,
      toolTimeoutSec: server.toolTimeoutSec,
      toolOutputTokenLimits: server.toolOutputTokenLimits,
    })),
  );
}

/** Live MCP status from Codex app-server (requires lifecycle already started). */
export async function listCodexMcpServerStatus(): Promise<unknown> {
  const client = getGlobalCodexRuntimeLifecycle()?.getClient();
  if (!client?.isInitialized) {
    return { data: [] };
  }
  return client.request("mcpServerStatus/list", {});
}

export async function runThreadRequestWithRuntimeProxy(
  input: RunThreadRequestWithRuntimeProxyInput,
): Promise<ThreadRuntimeProxyResult> {
  const freshConfig = input.resolveRuntimeConfig();
  if (!freshConfig.ok) {
    return { ok: false, reason: freshConfig.reason };
  }

  input.recordRouteFingerprint(input.threadId, freshConfig.routes);

  const requiredProviderIds = [
    ...new Set(
      freshConfig.routes
        .map((route) => route.provider.id.trim())
        .filter((providerId) => providerId.length > 0),
    ),
  ];

  let prepared: PreparedCodexRuntime | undefined;
  try {
    try {
      const mcpServers = (await input.resolveMcpServers?.()) ?? [];
      const threadEnabledMcpServerNames = (await input.resolveEnabledMcpServerKeys?.()) ?? [];
      const skillConfig = input.resolveSkillConfig?.() ?? [];
      const subagentAvailability = input.resolveSubagentAvailability?.();
      const requiredCatalogRoutes: CodexGatewayCatalogRoute[] = [];
      for (const route of freshConfig.routes) {
        const providerId = route.provider.id.trim();
        const modelId = route.modelId.trim();
        if (!providerId || !modelId) {
          continue;
        }
        requiredCatalogRoutes.push({
          providerId,
          modelId,
          apiCompat: resolveUpstreamApiCompat(route.apiCompat, route.provider.apiCompat),
          displayName: `${route.provider.name} / ${modelId}`,
          ...(route.manualSpec
            ? {
                manualSpec: {
                  ...(route.manualSpec.contextTokens !== undefined
                    ? { contextTokens: route.manualSpec.contextTokens }
                    : {}),
                  ...(route.manualSpec.supportsImageInput !== undefined
                    ? { supportsImageInput: route.manualSpec.supportsImageInput }
                    : {}),
                  ...(route.manualSpec.supportsRemoteCompaction !== undefined
                    ? { supportsRemoteCompaction: route.manualSpec.supportsRemoteCompaction }
                    : {}),
                },
              }
            : {}),
        });
      }
      const systemPromptAppend = input.resolveSystemPromptAppend?.()?.trim();
      const plannerRoute = freshConfig.routes.find((route) => route.role === "main");
      const selectedRoute = plannerRoute ?? freshConfig.routes[0];
      const webSearchOverride = input.resolveWebSearchOverride?.();
      prepared = await prepareCodexRuntime({
        ecoThreadId: input.threadId,
        reserveRuntime: true,
        ...(input.signal ? { signal: input.signal } : {}),
        ...(input.onConfigReloadWait ? { onConfigReloadWait: input.onConfigReloadWait } : {}),
        agentRegistry: input.resolveAgentRegistry?.(),
        ...(systemPromptAppend ? { systemPromptAppend } : {}),
        ...(input.resolveExecutionConfirmationMode
          ? { executionConfirmationMode: input.resolveExecutionConfirmationMode() }
          : {}),
        ...(input.enableSubagents === false ? { enableSubagents: false } : {}),
        ...(subagentAvailability ? { subagentAvailability } : {}),
        requiredProviderIds,
        ...(selectedRoute ? { mainProviderId: selectedRoute.provider.id } : {}),
        ...(selectedRoute
          ? {
              mainModelId: selectedRoute.modelId,
              mainApiCompat: resolveUpstreamApiCompat(
                selectedRoute.apiCompat,
                selectedRoute.provider.apiCompat,
              ),
            }
          : {}),
        ...(selectedRoute?.manualSpec?.supportsImageInput !== undefined
          ? { mainSupportsImageInput: selectedRoute.manualSpec.supportsImageInput }
          : {}),
        mcpServers,
        threadEnabledMcpServerNames,
        skillConfig,
        ...(input.skillDiscoveryCwd ? { skillDiscoveryCwd: input.skillDiscoveryCwd } : {}),
        requiredCatalogRoutes,
        ...(webSearchOverride ? { webSearchOverride } : {}),
      });
      // Wait for readiness AFTER prepare: reload (when it runs) restarts MCP processes.
      await input.ensureMcpReady?.();
      // The driver passes thread overrides to thread/start and thread/resume.
      // Do not restart the shared app-server or block unrelated active threads.
      bindPreparedCodexRuntimeToThread(input.threadId, prepared);
      await input.onPrepared?.(prepared);
    } catch (error) {
      return {
        ok: false,
        reason: error instanceof Error ? error.message : String(error),
        ...(input.signal?.aborted ? { aborted: true } : {}),
      };
    }

    const routes = buildDriverRoutesFromRuntime(freshConfig.routes);
    const plannerRoute = freshConfig.routes.find((route) => route.role === "main");
    const attempt: CodexRuntimeAttempt = {
      routes,
      ...(plannerRoute && { plannerRoute: { modelId: plannerRoute.modelId } }),
    };

    await input.onProxyReady?.(attempt);
    return await input.run(attempt);
  } finally {
    prepared?.releaseRuntime?.();
  }
}

export function createCodexRuntimeDriver(
  threadId: string,
  sessionMode: CodexSessionMode,
  options?: {
    orchestrationAppend?: string;
    orchestrationToolPolicy?: CodexToolPolicy;
    existingCodexThreadId?: string;
    threadConfig?: Record<string, unknown>;
    threadConfigAlreadyApplied?: boolean;
    /**
     * Enable mid-turn port hooks for the main eco-thread regular turn only.
     * Subagent spawn paths must leave this false — shared ecoThreadId would clobber ports.
     */
    enableMidTurnPort?: boolean;
    onTurnBound?: (input: { ecoThreadId: string; codexThreadId: string; turnId: string }) => void;
    onTurnClosing?: (input: {
      ecoThreadId: string;
      codexThreadId: string;
      turnId?: string;
    }) => void | Promise<void>;
    onTurnClosed?: (input: {
      ecoThreadId: string;
      codexThreadId: string;
      turnId?: string;
    }) => void | Promise<void>;
  },
): CodexAppServerDriver {
  const runtimeDeps = requireDeps();
  const prepared = preparedRuntimeByThread.get(threadId);
  const existingId =
    options?.existingCodexThreadId?.trim() || runtimeDeps.threadMap.getCodexThreadId(threadId);
  const client = existingId
    ? getCodexRuntimeClientForThread(existingId, prepared?.runtimeClient)
    : (prepared?.runtimeClient ?? getGlobalCodexRuntimeLifecycle()?.getClient());
  if (!client) {
    throw new Error("Codex app-server client is not running. prepareCodexRuntime() must complete first.");
  }

  const orchestrationAppend = options?.orchestrationAppend ?? prepared?.orchestrationAppend;
  const orchestrationToolPolicy = options?.orchestrationToolPolicy ?? prepared?.orchestrationToolPolicy;
  const existingCodexThreadId =
    options?.existingCodexThreadId?.trim() || runtimeDeps.threadMap.getCodexThreadId(threadId);
  const preparedThreadConfig = options?.threadConfig ?? prepared?.threadConfig;
  const controlPlaneConfigApplied = Boolean(
    existingCodexThreadId &&
      preparedThreadConfig &&
      controlPlaneAppliedConfigByClient.get(client)?.get(existingCodexThreadId) === preparedThreadConfig,
  );
  if (controlPlaneConfigApplied && existingCodexThreadId) {
    controlPlaneAppliedConfigByClient.get(client)?.delete(existingCodexThreadId);
  }
  // Feed + approval notifications are owned by the global lifecycle handler in
  // prepareCodexRuntime. Drivers must not register another dispatch path — each
  // extra handler appends the same incremental delta again (N× stutter).
  const enableMidTurn = options?.enableMidTurnPort === true;
  const driverOptions = {
    client,
    turnRouteRegistry,
    sessionMode,
    ...(existingCodexThreadId ? { existingCodexThreadId } : {}),
    ...(options?.threadConfigAlreadyApplied || controlPlaneConfigApplied
      ? { threadConfigAlreadyApplied: true }
      : {}),
    ...(orchestrationAppend ? { developerInstructions: orchestrationAppend } : {}),
    ...(orchestrationToolPolicy ? { orchestrationToolPolicy } : {}),
    ...(preparedThreadConfig ? { threadConfig: preparedThreadConfig } : {}),
    onResumeDiagnostic: (diagnostic: unknown) => {
      runtimeDeps.onStderr?.(`[eco-codex] resume diagnostic ${JSON.stringify(diagnostic)}`);
    },
    onThreadMapped: (ecoThreadId: string, codexThreadId: string) => {
      recordCodexRuntimeThreadOwner(codexThreadId, client);
      // Subagent resume passes parent eco id + child Codex id — never remap parent → child.
      const isSubagentCodexThread = Boolean(
        runtimeDeps.threadMap.getThreadAttribution(codexThreadId)?.parentThreadId?.trim(),
      );
      if (!isSubagentCodexThread) {
        runtimeDeps.threadMap.setMapping(ecoThreadId, codexThreadId);
        runtimeDeps.onCodexThreadMapped?.(codexThreadId);
      }
      eventAdapter?.flushAllPendingEvents();
    },
    ...(enableMidTurn && options?.onTurnBound ? { onTurnBound: options.onTurnBound } : {}),
    ...(enableMidTurn && options?.onTurnClosing ? { onTurnClosing: options.onTurnClosing } : {}),
    ...(enableMidTurn && options?.onTurnClosed ? { onTurnClosed: options.onTurnClosed } : {}),
  };
  const release = retainCodexRuntimeClient(client);
  const driver = new CodexAppServerDriver(driverOptions);
  const dispose = driver.dispose.bind(driver);
  driver.dispose = () => {
    try {
      dispose();
    } finally {
      release();
    }
  };
  return driver;
}

export function clearCodexTurnRoutesForEcoThread(ecoThreadId: string): number {
  const codexThreadId = deps?.threadMap.getCodexThreadId(ecoThreadId.trim());
  return codexThreadId ? turnRouteRegistry.clearThread(codexThreadId) : 0;
}

export function clearAllCodexTurnRoutes(): void {
  turnRouteRegistry.clearAll();
}

export function getCodexTurnRouteRegistry(): CodexTurnRouteRegistry {
  return turnRouteRegistry;
}

export function registerCodexGatewayTurnRoute(
  input: {
    codexThreadId: string;
    turnId: string;
    requestKind: "turn" | "prewarm" | "compaction";
    requestedModel: string;
    providerId: string;
    upstreamModelId: string;
  },
  registry: CodexTurnRouteRegistry = turnRouteRegistry,
): boolean {
  if (input.requestKind !== "turn") {
    return false;
  }
  const providerId = input.providerId.trim();
  const upstreamModelId = input.upstreamModelId.trim();
  if (!providerId || !upstreamModelId) {
    return false;
  }
  const alias = parseCodexGatewayModelAlias(input.requestedModel);
  if (alias) {
    if (alias.providerId !== providerId || alias.upstreamModelId !== upstreamModelId) {
      return false;
    }
    registry.register(input.codexThreadId, input.turnId, {
      aliasModelId: input.requestedModel.trim(),
      providerId: alias.providerId,
      upstreamModelId: alias.upstreamModelId,
      ...(alias.apiCompat && { apiCompat: alias.apiCompat }),
    });
    return true;
  }
  // Real upstream model id path: Bridge already resolved via registry stamp/header
  registry.register(input.codexThreadId, input.turnId, {
    aliasModelId: input.requestedModel.trim() || upstreamModelId,
    providerId,
    upstreamModelId,
  });
  return true;
}

export type CodexGatewayTurnRouteRegistrationResult =
  | { status: "registered" }
  | { status: "skipped"; reason: "billing_rejected" | "non_turn_request" }
  | { status: "rejected"; reason: "invalid_exact_route" }
  | { status: "conflict"; error: unknown };

/** Register only usage events that already passed exact attribution and pricing-route resolution. */
export function registerResolvedCodexGatewayTurnRoute(
  input: {
    billingResult:
      | { status: "rejected" }
      | {
          status: "resolved";
          codexThreadId: string;
          turnId: string;
          requestKind: "turn" | "prewarm" | "compaction";
        };
    requestedModel: string;
    providerId: string;
    upstreamModelId: string;
  },
  registry: CodexTurnRouteRegistry = turnRouteRegistry,
): CodexGatewayTurnRouteRegistrationResult {
  if (input.billingResult.status !== "resolved") {
    return { status: "skipped", reason: "billing_rejected" };
  }
  if (input.billingResult.requestKind !== "turn") {
    return { status: "skipped", reason: "non_turn_request" };
  }
  try {
    const registered = registerCodexGatewayTurnRoute(
      {
        codexThreadId: input.billingResult.codexThreadId,
        turnId: input.billingResult.turnId,
        requestKind: input.billingResult.requestKind,
        requestedModel: input.requestedModel,
        providerId: input.providerId,
        upstreamModelId: input.upstreamModelId,
      },
      registry,
    );
    return registered ? { status: "registered" } : { status: "rejected", reason: "invalid_exact_route" };
  } catch (error) {
    return { status: "conflict", error };
  }
}

/**
 * Driver for an interrupted subagent: requires attribution map, then
 * `thread/resume` + `turn/start` with followup_task prompt (never thread/start).
 */
export function createCodexSubagentResumeDriver(input: {
  /** Parent Eco thread id (Feed / billing attribution). */
  parentEcoThreadId: string;
  /** Subagent agentId (= Codex child thread id). */
  agentId: string;
  sessionMode?: CodexSessionMode;
  orchestrationAppend?: string;
}): { driver: CodexAppServerDriver; followupPromptFor: (task: string) => string; codexThreadId: string } {
  const runtimeDeps = requireDeps();
  const codexThreadId = requireCodexSubagentThreadId(
    (id) => runtimeDeps.threadMap.getThreadAttribution(id),
    input.agentId,
  );
  const attribution = runtimeDeps.threadMap.getThreadAttribution(codexThreadId);
  const roleId = attribution?.agentRole?.trim();
  const roleThreadConfig = roleId
    ? preparedRuntimeByThread.get(input.parentEcoThreadId)?.roleThreadConfigs[roleId]
    : undefined;
  const roleToolPolicy = roleId
    ? preparedRuntimeByThread.get(input.parentEcoThreadId)?.roleToolPolicies[roleId]
    : undefined;
  if (!roleId || !roleThreadConfig || !roleToolPolicy) {
    throw new CodexResumeNotAvailable(
      `Codex subagent resume cannot reapply the MCP policy for role '${roleId || "unknown"}'.`,
      {
        nextAction:
          "Prepare the parent Eco thread with the same orchestration before resuming this subagent.",
      },
    );
  }
  const driver = createCodexRuntimeDriver(input.parentEcoThreadId, input.sessionMode ?? "agent", {
    existingCodexThreadId: codexThreadId,
    threadConfig: roleThreadConfig,
    threadConfigAlreadyApplied: true,
    orchestrationToolPolicy: roleToolPolicy,
    ...(input.orchestrationAppend ? { orchestrationAppend: input.orchestrationAppend } : {}),
  });
  return {
    driver,
    codexThreadId,
    followupPromptFor: (task: string) => buildCodexSubagentFollowupPrompt(codexThreadId, task),
  };
}

function requireDeps(): CodexRuntimeRunDeps {
  if (!deps) {
    throw new Error("Codex runtime is not configured. Call configureCodexRuntimeRun() during app startup.");
  }
  return deps;
}

function getCodexModelCatalogService(): CodexModelCatalogService {
  if (modelCatalogService) {
    return modelCatalogService;
  }
  const runtimeDeps = requireDeps();

  modelCatalogService = new CodexModelCatalogService({
    getLiveClient: () => getGlobalCodexRuntimeLifecycle()?.getClient(),
    createTemporaryLifecycle: () => {
      const codexExecutable = resolveCodexExecutable();
      if (!codexExecutable) {
        throw new Error(
          "Codex model catalog is unavailable because the Codex CLI executable could not be resolved.",
        );
      }
      return new CodexRuntimeLifecycle({
        ecoDataDir: runtimeDeps.ecoDataDir,
        codexExecutable,
        onStderr: (chunk) => runtimeDeps.onStderr?.(`[codex model/list] ${chunk}`),
      });
    },
  });
  return modelCatalogService;
}

/** User-visible messages and tool lifecycle events publish immediately. */
export function isCodexStreamingProjectionEvent(event: ThreadRunEventInput): boolean {
  return event.eventType === "thinking.delta";
}

function getProjectCodexCandidates(): string[] {
  const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const workspaceRoot = path.resolve(appRoot, "../..");
  const cwdWorkspaceRoot = path.resolve(process.cwd(), "../..");
  const binNames =
    process.platform === "win32" ? (["codex.exe", "codex.cmd"] as const) : (["codex"] as const);
  return uniquePaths(
    binNames.flatMap((binName) => [
      path.join(process.cwd(), "node_modules", ".bin", binName),
      path.join(appRoot, "node_modules", ".bin", binName),
      path.join(workspaceRoot, "node_modules", ".bin", binName),
      path.join(cwdWorkspaceRoot, "node_modules", ".bin", binName),
    ]),
  );
}

function resolveCodexExecutableFromPath(): string | undefined {
  const command = process.platform === "win32" ? "where" : "which";
  try {
    const resolved = execFileSync(command, ["codex"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
    return resolved;
  } catch {
    return undefined;
  }
}

function isRunnableCodexExecutable(filePath: string): boolean {
  if (!isExecutableFile(filePath)) {
    return false;
  }
  return probeCliVersionExecutable(filePath);
}

function isExecutableFile(filePath: string): boolean {
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

function uniquePaths(paths: readonly string[]): string[] {
  return [...new Set(paths)];
}
