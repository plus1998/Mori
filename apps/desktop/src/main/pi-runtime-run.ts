import type { ResolvedModelRoute } from "@eco/model-router";
import {
  type AgentEvent,
  type CoreKind,
  type EcoAgentRuntimeConfig,
  type EcoApiCompat,
  globalPiSessionRegistry,
  listEnabledPiSubagents,
  materializeEcoToolPolicy,
  PiCodingAgentDriver,
  probePiCoreAvailability,
  removePiAgentThreadDir,
  resolvePiAgentDir,
  resolvePiPlannerRoute,
  resolvePiRouteByRole,
  resolvePiWebSearchContext,
  resolveSupportsNativeWebSearch,
} from "@eco/runtime";
import type { WorktreePlan } from "@eco/workspace";
import { resolveUpstreamApiCompat } from "../shared/api-compat";
import type {
  IntegratedWebSearchSettingsSnapshot,
  PromptImageAttachment,
  RouteManualSpec,
  RuntimeRoleRouteConfig,
  ThreadSummary,
  WorkspaceInfo,
} from "../shared/ipc";
import type { ActiveRunRuntimeStateInput } from "./active-run-runtime-state";
import type { AgentLifecycleService } from "./agent-lifecycle-service.js";
import type { RuntimeRoute } from "./billing-resolver";
import type { PreparedConversationCommandDispatch } from "./conversation-command-dispatch";
import type { ConversationStore } from "./conversation-store.js";
import { buildPiGatewayRequestHeaders, type StartedGatewayRouteBinding } from "./gateway-route-binding";
import { createPiSubagentSpawnHandler } from "./pi-subagent-host.js";
import type { RequestAttemptResult } from "./request-retry";
import type { SubagentMetricsRegistry } from "./subagent-metrics-registry.js";
import type { RunAttemptContext } from "./thread-run-attempt";
import { buildDriverRoutes } from "./thread-runtime-routes";

export interface PiThreadStartRunInput {
  thread: ThreadSummary;
  workspace: WorkspaceInfo;
  runtimeConfig: { routes: RuntimeRoute[] };
  prompt: string;
  attachments?: PromptImageAttachment[];
  roleRoutes?: unknown;
  continuation?: boolean;
  /** Absolute skill directories enabled for this PI thread (Eco visibility isolation). */
  skillPaths?: string[];
  /** Isolated MCP servers for this PI thread (Claude-SDK shaped entries). */
  mcpServers?: Record<string, unknown>;
  /** Extra system prompt append (global rules, then browser / image integration). */
  appendSystemPrompt?: string[];
  /** Thread orchestration snapshot — enables session-scoped Agent tool. */
  agentRegistry?: EcoAgentRuntimeConfig;
  runtimeDispatch?: PreparedConversationCommandDispatch;
}

export interface PiRuntimeOrchestrationDeps {
  ecoDataDir: string;
  requireThreadCore: (thread: Pick<ThreadSummary, "id" | "coreKind">, expected: CoreKind, op: string) => void;
  resolveSessionMode: (runtimeConfig: ThreadSummary["runtimeConfig"]) => "agent" | "plan" | "ask";
  startActiveRun: (threadId: string, run: ActiveRunRuntimeStateInput) => void;
  createSessionPlan: (workspacePath: string, threadId: string) => WorktreePlan;
  resolveThreadWorktree: (
    workspace: WorkspaceInfo,
    threadId: string,
  ) => Promise<{ worktreePlan: WorktreePlan; cwd: string }>;
  runThreadRequestOnce: (
    threadId: string,
    phase: "execution" | "ask" | "planning" | "continuation",
    signal: AbortSignal,
    run: (context: RunAttemptContext) => Promise<RequestAttemptResult>,
    retryIndex?: number,
    runtimeDispatch?: PreparedConversationCommandDispatch,
  ) => Promise<RequestAttemptResult>;
  resolveRuntimeConfigForThreadId: (
    threadId: string,
  ) =>
    | { ok: true; routes: RuntimeRoute[]; reason?: undefined }
    | { ok: false; routes?: undefined; reason: string }
    | { ok: true; routes: RuntimeRoute[] }
    | { ok: false; reason: string };
  recordRouteFingerprint: (threadId: string, routes: readonly RuntimeRoute[]) => void;
  /** Attempt-scoped Gateway binding (Claude-compatible control plane). */
  startRuntimeProxy: (
    routes: RuntimeRoute[],
    attachments: PromptImageAttachment[] | undefined,
    context: RunAttemptContext,
  ) => Promise<StartedGatewayRouteBinding>;
  /** Composer supplies image paths/refs; PI decides when to call image_view. */
  resolvePromptImagesForMainContext: (input: {
    threadId: string;
    prompt: string;
    attachments?: readonly PromptImageAttachment[];
    routesOverride?: readonly RuntimeRoleRouteConfig[];
    signal?: AbortSignal;
  }) => Promise<string>;
  getGlobalContextWindowLimit: () => number;
  consumeEvents: (input: {
    events: AsyncIterable<AgentEvent>;
    threadId: string;
    worktreePath: string;
    signal: AbortSignal;
  }) => Promise<RequestAttemptResult>;
  applyRunDecision: (input: {
    threadId: string;
    decision: RequestAttemptResult;
    mode: "agent" | "plan" | "ask";
    hasPendingPlan: boolean;
  }) => Promise<void> | Promise<boolean> | void;
  finalizeCleanup: (threadId: string) => Promise<void>;
  markInterrupted: (threadId: string, reason: string) => void;
  updateThread: (threadId: string, patch: Pick<ThreadSummary, "message" | "status">) => void;
  captureSession: (
    threadId: string,
    sessionId: string,
    cwd: string,
    metadata?: {
      sessionFile?: string;
      identityFingerprint?: string;
      mcpFingerprint?: string;
    },
  ) => void;
  /** Stored PI core-session binding for disk resume (cwd checked against live worktree). */
  getThreadCoreSession: (threadId: string) =>
    | {
        coreKind: string;
        externalSessionId: string;
        cwd: string;
        metadata?: Record<string, unknown>;
      }
    | undefined;
  errorMessage: (error: unknown) => string;
  conversationStore: ConversationStore;
  lifecycle?: AgentLifecycleService;
  metricsRegistry?: SubagentMetricsRegistry;
  getToolPermissionHandler: (
    threadId: string,
    skipExecutionApprovals: boolean,
  ) => import("@eco/runtime").SdkToolPermissionHandler;
  getBashReviewMode: (threadId: string) => "always" | "auto" | "allow_all";
  /** Persist plan.ready from finalize_plan (Codex-style async approval). */
  capturePlanReady?: (input: {
    threadId: string;
    workspacePath: string;
    worktreePath: string;
    payload: {
      userPrompt: string;
      analysis: string;
      plan: string;
      planFilePath?: string;
    };
  }) => boolean;
  getIntegratedWebSearchRuntime: () => {
    settings: IntegratedWebSearchSettingsSnapshot;
    apiKey?: string;
  };
}

export function resolvePiSkipExecutionApprovals(bashReviewMode: string | undefined): boolean {
  return bashReviewMode === "allow_all";
}

export function buildPiSessionToolApprovalFields(input: {
  toolPermissionHandler?: import("@eco/runtime").SdkToolPermissionHandler;
  agentId?: string;
  agentType?: string;
}): Pick<
  import("@eco/runtime").PiSessionOptions,
  "toolPermissionHandler" | "toolApprovalAgentId" | "toolApprovalAgentType"
> {
  if (!input.toolPermissionHandler) {
    return {};
  }
  return {
    toolPermissionHandler: input.toolPermissionHandler,
    ...(input.agentId ? { toolApprovalAgentId: input.agentId } : {}),
    ...(input.agentType ? { toolApprovalAgentType: input.agentType } : {}),
  };
}

export function buildPiWebSearchSessionFields(input: {
  plannerManualSpec?: RouteManualSpec;
  networkWebSearch: boolean | undefined;
  integratedSettings: IntegratedWebSearchSettingsSnapshot;
  integratedApiKey?: string;
}): Pick<
  import("@eco/runtime").PiSessionOptions,
  "webSearchBackend" | "integratedWebSearchApiKey" | "integratedWebSearchProvider"
> {
  const webSearch = resolvePiWebSearchContext({
    networkWebSearch: input.networkWebSearch,
    supportsNativeWebSearch: resolveSupportsNativeWebSearch(input.plannerManualSpec),
    integratedEnabled: input.integratedSettings.enabled,
    ...(input.integratedApiKey === undefined ? {} : { integratedApiKey: input.integratedApiKey }),
  });
  return {
    webSearchBackend: webSearch.backend,
    ...(webSearch.integratedApiKey
      ? {
          integratedWebSearchApiKey: webSearch.integratedApiKey,
          integratedWebSearchProvider: input.integratedSettings.provider,
        }
      : {}),
  };
}

export function resolvePiMainNetworkWebSearch(agentRegistry?: EcoAgentRuntimeConfig): boolean | undefined {
  if (!agentRegistry) {
    return undefined;
  }
  const policy = materializeEcoToolPolicy(agentRegistry.orchestration.mainAgent.tools);
  return policy.network?.webSearch;
}

/** Shared driver resolveBridge uses the most recently armed Gateway binding per thread. */
const armedBindingByThread = new Map<
  string,
  {
    binding: StartedGatewayRouteBinding;
    driverRoutes: ResolvedModelRoute[];
    agentDir: string;
    runAttemptId?: string;
    globalContextWindowLimit: number;
  }
>();

let sharedDriver: PiCodingAgentDriver | undefined;

export function getPiCodingAgentDriver(ecoDataDir: string): PiCodingAgentDriver {
  if (!sharedDriver) {
    sharedDriver = new PiCodingAgentDriver({
      resolveBridgeModel: async ({ threadId, routes, role }) => {
        const armed = armedBindingByThread.get(threadId);
        if (!armed) {
          throw new Error("PI Gateway binding is not armed for this thread.");
        }
        const selectedRole = role?.trim();
        const bindingRoute = selectedRole
          ? armed.binding.routes.find((entry) => entry.role === selectedRole)
          : (armed.binding.routes.find((entry) => entry.role === "planner") ?? armed.binding.routes[0]);
        if (!bindingRoute) {
          throw new Error(
            selectedRole
              ? `PI Gateway binding has no model route for role "${selectedRole}".`
              : "PI Gateway binding has no model routes.",
          );
        }
        const driverRoute = selectedRole
          ? resolvePiRouteByRole(routes, selectedRole)
          : resolvePiPlannerRoute(routes);
        if (selectedRole && !driverRoute) {
          throw new Error(
            `No driver route for PI role "${selectedRole}". Configure an explicit provider/model.`,
          );
        }
        const apiCompat = resolveUpstreamApiCompat(
          bindingRoute.apiCompat,
          bindingRoute.provider.apiCompat,
        ) as EcoApiCompat;
        const headers = buildPiGatewayRequestHeaders({
          bindingId: armed.binding.bindingId,
          threadId,
          ...(armed.runAttemptId ? { runAttemptId: armed.runAttemptId } : {}),
          providerId: bindingRoute.provider.id,
          requestedModel: bindingRoute.aliasModelId,
          apiCompat,
        });
        return {
          bridgeBaseUrl: armed.binding.baseUrl,
          bridgeModelId: bindingRoute.aliasModelId,
          apiKey: armed.binding.apiKey,
          agentDir: armed.agentDir,
          apiCompat,
          bindingId: armed.binding.bindingId,
          providerId: bindingRoute.provider.id,
          headers,
          ...(bindingRoute.supportsImageInput !== undefined && {
            supportsImageInput: bindingRoute.supportsImageInput,
          }),
          ...(bindingRoute.maxOutputTokens !== undefined && {
            maxOutputTokens: bindingRoute.maxOutputTokens,
            globalMaxOutputTokens: bindingRoute.maxOutputTokens,
          }),
          ...(driverRoute?.primary.contextWindow !== undefined
            ? { contextWindow: driverRoute.primary.contextWindow }
            : bindingRoute.contextTokens !== undefined
              ? { contextWindow: bindingRoute.contextTokens }
              : {}),
          globalContextWindowLimit: armed.globalContextWindowLimit,
          ...(armed.runAttemptId ? { runAttemptId: armed.runAttemptId } : {}),
        };
      },
    });
  }
  void ecoDataDir;
  return sharedDriver;
}

export async function startPiThreadRun(
  input: PiThreadStartRunInput,
  deps: PiRuntimeOrchestrationDeps,
): Promise<void> {
  deps.requireThreadCore(input.thread, "pi", input.continuation ? "continue with PI" : "start PI");
  const mode = deps.resolveSessionMode(input.thread.runtimeConfig);

  const availability = await probePiCoreAvailability();
  if (!availability.available) {
    throw new Error(availability.reason ?? "PI Core is unavailable.");
  }

  const controller = new AbortController();
  deps.startActiveRun(input.thread.id, {
    controller,
    worktreePlan: deps.createSessionPlan(input.workspace.path, input.thread.id),
  });

  let cwd = input.workspace.path;
  try {
    const resolved = await deps.resolveThreadWorktree(input.workspace, input.thread.id);
    cwd = resolved.cwd;
    deps.startActiveRun(input.thread.id, {
      controller,
      worktreePlan: resolved.worktreePlan,
    });

    const requestPhase = mode === "ask" ? "ask" : mode === "plan" ? "planning" : "execution";

    let planningPlanCaptured = false;
    const outcome = await deps.runThreadRequestOnce(
      input.thread.id,
      requestPhase,
      controller.signal,
      async (attemptContext) => {
        const config = deps.resolveRuntimeConfigForThreadId(input.thread.id);
        if (!config.ok) {
          return { ok: false, reason: config.reason };
        }
        deps.recordRouteFingerprint(input.thread.id, config.routes);
        const mainPrompt = await deps.resolvePromptImagesForMainContext({
          threadId: input.thread.id,
          prompt: input.prompt,
          ...(input.attachments?.length ? { attachments: input.attachments } : {}),
          ...(Array.isArray(input.roleRoutes)
            ? { routesOverride: input.roleRoutes as readonly RuntimeRoleRouteConfig[] }
            : {}),
          signal: controller.signal,
        });
        const binding = await deps.startRuntimeProxy(config.routes, undefined, attemptContext);
        const agentDir = resolvePiAgentDir(deps.ecoDataDir, input.thread.id);
        const driverRoutes = buildDriverRoutes(binding.routes);
        const diskResume = resolvePiDiskResume({
          binding: deps.getThreadCoreSession(input.thread.id),
          cwd,
        });
        armedBindingByThread.set(input.thread.id, {
          binding,
          driverRoutes,
          agentDir,
          globalContextWindowLimit: deps.getGlobalContextWindowLimit(),
          ...(attemptContext.runAttemptId ? { runAttemptId: attemptContext.runAttemptId } : {}),
        });
        try {
          // Do not surface local gateway baseUrl/port to the user — internal orchestration only.
          deps.updateThread(input.thread.id, {
            status: "running",
            message: "",
          });
          const driver = getPiCodingAgentDriver(deps.ecoDataDir);
          if (typeof deps.getToolPermissionHandler !== "function") {
            throw new Error("PI tool permission handler is not configured.");
          }
          const bashReviewMode = deps.getBashReviewMode(input.thread.id);
          const toolPermissionHandler = deps.getToolPermissionHandler(
            input.thread.id,
            resolvePiSkipExecutionApprovals(bashReviewMode),
          );
          const enabledSubagents = listEnabledPiSubagents(input.agentRegistry);
          const plannerRoute = config.routes.find((route) => route.role === "planner");
          const integratedWebSearch = deps.getIntegratedWebSearchRuntime();
          const webSearchSession = buildPiWebSearchSessionFields({
            ...(plannerRoute?.manualSpec ? { plannerManualSpec: plannerRoute.manualSpec } : {}),
            networkWebSearch: resolvePiMainNetworkWebSearch(input.agentRegistry),
            integratedSettings: integratedWebSearch.settings,
            ...(integratedWebSearch.apiKey ? { integratedApiKey: integratedWebSearch.apiKey } : {}),
          });
          const onSubagentSpawn =
            mode === "agent" && input.agentRegistry && enabledSubagents.length > 0
              ? createPiSubagentSpawnHandler({
                  threadId: input.thread.id,
                  ecoDataDir: deps.ecoDataDir,
                  getArmedBinding: () => {
                    const armed = armedBindingByThread.get(input.thread.id);
                    if (!armed) {
                      return undefined;
                    }
                    return {
                      binding: armed.binding,
                      driverRoutes: armed.driverRoutes,
                      globalContextWindowLimit: armed.globalContextWindowLimit,
                      ...(armed.runAttemptId ? { runAttemptId: armed.runAttemptId } : {}),
                    };
                  },
                  registry: input.agentRegistry,
                  conversationStore: deps.conversationStore,
                  toolPermissionHandler,
                  getIntegratedWebSearchRuntime: deps.getIntegratedWebSearchRuntime,
                  resolveRouteManualSpec: (role) =>
                    config.routes.find((entry) => entry.role === role)?.manualSpec,
                  ...(input.mcpServers ? { parentMcpServers: input.mcpServers } : {}),
                  ...(input.skillPaths ? { parentSkillPaths: input.skillPaths } : {}),
                  ...(deps.lifecycle ? { lifecycle: deps.lifecycle } : {}),
                  ...(deps.metricsRegistry ? { metricsRegistry: deps.metricsRegistry } : {}),
                })
              : undefined;
          const runInput = {
            threadId: input.thread.id,
            prompt: mainPrompt,
            workspacePath: input.workspace.path,
            worktreePath: cwd,
            routes: driverRoutes,
            signal: controller.signal,
            ...(input.agentRegistry && mode === "agent" ? { agentRegistry: input.agentRegistry } : {}),
            piSession: {
              ...(() => {
                const dispatched = deps.conversationStore
                  .listConversationRuntimeSources(input.thread.id, { historyOrder: true })
                  .filter(
                    (source) => source.role === "user" && source.metadata?.liveType === "thread.user_prompt",
                  )
                  .at(-1);
                const target = dispatched?.metadata?.rewindTarget as { activityLineId?: string } | undefined;
                return target?.activityLineId ? { promptActivityLineId: target.activityLineId } : {};
              })(),
              skillPaths: input.skillPaths ?? [],
              sessionMode: mode,
              ...(input.mcpServers && Object.keys(input.mcpServers).length > 0 && mode === "agent"
                ? { mcpServers: input.mcpServers }
                : {}),
              ...(input.appendSystemPrompt && input.appendSystemPrompt.length > 0
                ? { appendSystemPrompt: input.appendSystemPrompt }
                : {}),
              ...(diskResume
                ? {
                    sessionFile: diskResume.sessionFile,
                    resumeIdentityFingerprint: diskResume.resumeIdentityFingerprint,
                    resumeMcpFingerprint: diskResume.resumeMcpFingerprint,
                  }
                : {}),
              ...(onSubagentSpawn ? { onSubagentSpawn } : {}),
              ...buildPiSessionToolApprovalFields({ toolPermissionHandler }),
              ...webSearchSession,
            },
          };
          const events =
            mode === "ask" && driver.runAsk
              ? driver.runAsk(runInput)
              : mode === "plan" && driver.runPlan
                ? driver.runPlan(runInput)
                : driver.run(runInput);

          // Capture session.captured binding while streaming; persist plan.ready for async approval.
          async function* intercept(): AsyncIterable<AgentEvent> {
            for await (const event of events) {
              if (event.type === "session.captured") {
                const payload = event.payload as {
                  sessionId?: string;
                  cwd?: string;
                  sessionFile?: string;
                  identityFingerprint?: string;
                  mcpFingerprint?: string;
                };
                if (payload.sessionId && payload.cwd) {
                  deps.captureSession(input.thread.id, payload.sessionId, payload.cwd, {
                    ...(payload.sessionFile ? { sessionFile: payload.sessionFile } : {}),
                    ...(payload.identityFingerprint
                      ? { identityFingerprint: payload.identityFingerprint }
                      : {}),
                    ...(payload.mcpFingerprint !== undefined
                      ? { mcpFingerprint: payload.mcpFingerprint }
                      : {}),
                  });
                }
              }
              if (event.type === "plan.ready" && deps.capturePlanReady) {
                const payload = event.payload as {
                  userPrompt?: unknown;
                  analysis?: unknown;
                  plan?: unknown;
                  planFilePath?: unknown;
                };
                const plan = typeof payload.plan === "string" ? payload.plan.trim() : "";
                if (plan) {
                  planningPlanCaptured =
                    deps.capturePlanReady({
                      threadId: input.thread.id,
                      workspacePath: input.workspace.path,
                      worktreePath: cwd,
                      payload: {
                        userPrompt:
                          typeof payload.userPrompt === "string" && payload.userPrompt.trim()
                            ? payload.userPrompt
                            : input.prompt,
                        analysis: typeof payload.analysis === "string" ? payload.analysis : "",
                        plan,
                        ...(typeof payload.planFilePath === "string" && payload.planFilePath.trim()
                          ? { planFilePath: payload.planFilePath }
                          : {}),
                      },
                    }) || planningPlanCaptured;
                }
              }
              yield event;
            }
          }

          return await deps.consumeEvents({
            events: intercept(),
            threadId: input.thread.id,
            worktreePath: cwd,
            signal: controller.signal,
          });
        } finally {
          armedBindingByThread.delete(input.thread.id);
          await binding.close();
        }
      },
      0,
      input.runtimeDispatch,
    );

    const hasPendingPlan =
      planningPlanCaptured || Boolean(deps.conversationStore.getPendingPlan(input.thread.id));
    await deps.applyRunDecision({
      threadId: input.thread.id,
      decision: outcome,
      mode,
      hasPendingPlan,
    });
  } catch (error) {
    deps.markInterrupted(input.thread.id, deps.errorMessage(error));
  } finally {
    await deps.finalizeCleanup(input.thread.id);
  }
}

export async function abortPiThread(threadId: string): Promise<void> {
  await globalPiSessionRegistry.abort(threadId);
}

export async function disposePiThreadSession(threadId: string): Promise<void> {
  await globalPiSessionRegistry.deleteThread(threadId);
}

export async function disposeAllPiSessions(): Promise<void> {
  await globalPiSessionRegistry.deleteAll();
}

/** Remove Eco-owned `pi-agent/<threadId>` tree after disposing the in-process session. */
export async function removePiThreadAgentDir(ecoDataDir: string, threadId: string): Promise<void> {
  await removePiAgentThreadDir(ecoDataDir, threadId);
}

/**
 * Resolve disk-resume fields from a stored PI core session binding.
 * Only `sessionFile` gates resume — fingerprints are passed through for the
 * driver to decide AgentSession rebuild, never to refuse opening the JSONL.
 * `cwd` is accepted for call-site symmetry but does not block resume.
 */
export function resolvePiDiskResume(input: {
  binding:
    | {
        coreKind: string;
        externalSessionId: string;
        cwd: string;
        metadata?: Record<string, unknown>;
      }
    | undefined;
  cwd: string;
}):
  | {
      sessionFile: string;
      resumeIdentityFingerprint: string;
      resumeMcpFingerprint: string;
    }
  | undefined {
  void input.cwd;
  const binding = input.binding;
  if (!binding || binding.coreKind !== "pi") {
    return undefined;
  }
  const metadata = binding.metadata ?? {};
  const sessionFile = typeof metadata.sessionFile === "string" ? metadata.sessionFile.trim() : "";
  if (!sessionFile) {
    return undefined;
  }
  const identityFingerprint =
    typeof metadata.identityFingerprint === "string" ? metadata.identityFingerprint.trim() : "";
  const mcpFingerprint = typeof metadata.mcpFingerprint === "string" ? metadata.mcpFingerprint.trim() : "";
  return {
    sessionFile,
    resumeIdentityFingerprint: identityFingerprint,
    resumeMcpFingerprint: mcpFingerprint,
  };
}
