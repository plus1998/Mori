import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { ResolvedModelRoute } from "../../model-router/src";
import { type AgentEvent, createAgentEvent } from "../../shared/src";
import type { SdkToolPermissionHandler } from "./ask-user-question.js";
import { createPlanReadyEvent } from "./claude-agent-sdk.js";
import type { CoreSessionMode } from "./core-runtime.js";
import type { AgentRuntimeDriver, AgentRuntimeRunInput } from "./index.js";
import { createPiCodemodeExtensionFactory, PI_CODEMODE_EXTENSION_NAME } from "./pi-codemode-extension.js";
import { createEcoPiAgentExtensionFactory } from "./pi-eco-extensions.js";
import {
  applyPiAssistantErrorTracker,
  createPiEventAdapterState,
  mapPiSessionEventToAgentEvents,
  type PiSessionEventLike,
} from "./pi-event-adapter.js";
import {
  createEcoPiFinalizePlanExtensionFactory,
  PI_FINALIZE_PLAN_EXTENSION_NAME,
} from "./pi-finalize-plan.js";
import { assertPiImageInputAllowed, createEcoPiImageInputExtensionFactory } from "./pi-image-input-policy.js";
import { canonicalizePiMcpFingerprint, fingerprintPiMcpServers, PI_MCP_HUB_TOOL_NAMES } from "./pi-mcp.js";
import { createPiMcpExtensionFactory } from "./pi-mcp-extension-factory.js";
import {
  type BuildEcoPiModelInput,
  buildEcoPiModel,
  computePiRouteFingerprint,
  type EcoApiCompat,
  type EcoPiModelSpec,
  mapApiCompatToPiAuthProvider,
  mapEcoThinkingEffortToPiThinkingLevel,
  type PiThinkingLevel,
  resolvePiPlannerRoute,
} from "./pi-model-bridge.js";
import { streamPiPromptEvents } from "./pi-prompt-event-stream.js";
import { disposePiSdkSession } from "./pi-session-dispose.js";
import {
  createPiModeAwareToolPermissionHandler,
  piSystemPromptForSessionMode,
  piToolsForSessionMode,
} from "./pi-session-mode.js";
import { clearPiSessionFiles, ensurePiSessionsDir, isUsablePiSessionFile } from "./pi-session-paths.js";
import {
  ensurePiPrivateSkillsDir,
  fingerprintPiSkillPaths,
  resolvePiSessionSkillPaths,
} from "./pi-skills.js";
import { listEnabledPiSubagents, PI_AGENT_TOOL_NAME, piParentSessionKey } from "./pi-subagent.js";
import {
  createEcoPiToolApprovalExtensionFactory,
  PI_TOOL_APPROVAL_EXTENSION_NAME,
  PI_TOOL_APPROVAL_HANDLER_MISSING,
} from "./pi-tool-approval.js";
import type { PiWebSearchBackend } from "./pi-web-search-plan.js";
import { appendPiWebSearchSessionParts } from "./pi-web-search-session.js";

export interface PiSideEventBus {
  push(event: AgentEvent): void;
  subscribe(listener: (event: AgentEvent) => void): () => void;
}

export function createPiSideEventBus(): PiSideEventBus {
  const listeners = new Set<(event: AgentEvent) => void>();
  return {
    push(event) {
      for (const listener of listeners) {
        listener(event);
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/**
 * Raised when mid-turn steering cannot be delivered into a live PI run.
 * Callers must keep the message in their own queue; this is not a delivered state.
 */
export class PiMidTurnUnavailable extends Error {
  readonly code = "PiMidTurnUnavailable";

  constructor(message = "PI session is not accepting mid-turn steering.") {
    super(message);
    this.name = "PiMidTurnUnavailable";
  }
}

export function isPiMidTurnUnavailable(error: unknown): error is PiMidTurnUnavailable {
  return error instanceof PiMidTurnUnavailable;
}

/**
 * Outcome of queueing text into a session. PI 1.0 reports whether the text was
 * queued or consumed by an extension input handler; an older runtime resolved to
 * undefined, which `steerLiveSession` treats as queued.
 */
export type PiQueuedInputDisposition = "handled" | "queued";

/** Minimal AgentSession surface needed to steer a live PI run. */
export interface PiSteerableSessionLike {
  readonly isStreaming: boolean;
  steer(text: string): Promise<PiQueuedInputDisposition | undefined>;
  getSteeringMessages(): readonly string[];
  clearQueue(): { steering: string[]; followUp: string[] };
}

/**
 * Build the `isStreaming` + `steer` handle surface shared by the production session and
 * hosts that wrap an AgentSession themselves (round scripts, test doubles).
 *
 * `steer` fails closed: when the session is not streaming, or when the run took its final
 * steering poll before our enqueue landed, it reclaims the orphaned queue entry and throws
 * {@link PiMidTurnUnavailable} so the caller keeps its own queued copy.
 *
 * Steers for one session are serialized: PI exposes no selective dequeue, so the orphan
 * reclaim clears the whole queue, and overlapping steers could otherwise let one call
 * reclaim another call's still-pending entry and report it as delivered.
 */
export function createPiMidTurnHandle(session: PiSteerableSessionLike): {
  isStreaming: () => boolean;
  steer: (text: string) => Promise<void>;
} {
  const enqueue = createMidTurnSteerQueue();
  return {
    isStreaming: () => session.isStreaming,
    steer: (text) => enqueue(() => steerLiveSession(session, text)),
  };
}

/** Serializes same-session steers so each call observes a queue only it mutated. */
function createMidTurnSteerQueue(): (task: () => Promise<void>) => Promise<void> {
  let tail: Promise<void> = Promise.resolve();
  return (task) => {
    const run = tail.then(task);
    tail = run.catch(() => {});
    return run;
  };
}

/**
 * Queue one steering message into a live PI run.
 *
 * Throws {@link PiMidTurnUnavailable} when the session is not streaming, when an
 * extension input handler consumed the text instead of queueing it, or when the
 * run took its final steering poll between our enqueue and delivery. In the
 * latter case the orphaned entry is reclaimed instead of leaking into the next,
 * unrelated prompt; the caller requeues the original text and the drain resends
 * it as a turn.
 */
async function steerLiveSession(session: PiSteerableSessionLike, text: string): Promise<void> {
  if (!session.isStreaming) {
    throw new PiMidTurnUnavailable("PI session has no active run to steer.");
  }
  const pendingBefore = session.getSteeringMessages().length;
  const disposition = await session.steer(text);
  if (disposition === "handled") {
    // An input handler took the text: it never became a steering message, so
    // reporting delivery would drop the user's message silently.
    throw new PiMidTurnUnavailable("PI consumed the steering message without queueing it.");
  }
  if (session.isStreaming) {
    return;
  }
  if (session.getSteeringMessages().length > pendingBefore) {
    session.clearQueue();
    throw new PiMidTurnUnavailable("PI run ended before the steering message was delivered.");
  }
}

export interface PiSessionHandle {
  sessionId: string;
  /** Absolute JSONL path when persisting; undefined only for test doubles. */
  sessionFile?: string;
  cwd: string;
  /** Session-identity fingerprint (excludes attempt bindingId). */
  routeFingerprint: string;
  /** Last armed binding id — must not reuse across attempts. */
  bindingId: string;
  /** Fingerprint of Eco-selected skill paths (excludes private agentDir/skills). */
  skillsFingerprint: string;
  /** Fingerprint of Eco-selected MCP servers for this session. */
  mcpFingerprint: string;
  prompt: (text: string, signal?: AbortSignal, promptActivityLineId?: string) => AsyncIterable<AgentEvent>;
  abort: () => Promise<void>;
  dispose: () => void | Promise<void>;
  /** Whether the underlying AgentSession is inside an active run (mid-turn steer window). */
  isStreaming: () => boolean;
  /**
   * Queue mid-turn steering text into the live run. PI delivers it after the current
   * assistant turn's tool calls, before the next model call.
   * Throws {@link PiMidTurnUnavailable} when no run is live or the run ended before
   * delivery; callers must keep their own queued copy instead of pretending it landed.
   */
  steer: (text: string) => Promise<void>;
  /** Rebind model + attempt credential without disposing conversation state. */
  rebind: (input: PiSessionRebindInput) => Promise<void>;
  /**
   * Hot-update skill visibility without disposing conversation state.
   * Always re-includes `<agentDir>/skills` for session-private mounts.
   */
  updateSkillPaths: (skillPaths: readonly string[]) => Promise<void>;
  /** Parent-only: re-arm spawn handler for this run (session reuse). */
  armSubagentSpawn?: (handler: import("./pi-subagent.js").PiSubagentSpawnHandler | undefined) => void;
  /** Parent-only: re-arm tool permission handler for this run (session reuse). */
  armToolPermission?: (handler: SdkToolPermissionHandler | undefined) => void;
  /**
   * Parent-only: re-arm plan.ready emitter for this run (session reuse).
   * finalize_plan closes over a stable bridge object; each run must refresh emit.
   */
  armPlanReady?: (emit: ((plan: string, toolCallId: string) => void) | undefined) => void;
  /** Whether this session was created with the eco-pi-approval extension. */
  toolApprovalEnabled?: boolean;
  /** Session mode used when this AgentSession was created (Ask/Plan force tool drift). */
  sessionMode?: CoreSessionMode;
  /** Web search backend armed when the session was created. */
  webSearchBackend?: PiWebSearchBackend;
  /** A failed startup requires a fresh native MCP connection on the next attempt. */
  readonly mcpStartupFailed?: boolean;
  /** Parent-only side bus created with the session (stable across rebinds). */
  sideEventBus?: PiSideEventBus;
}

export interface PiSessionRebindInput {
  model: EcoPiModelSpec;
  apiKey: string;
  apiCompat: EcoApiCompat;
  bindingId: string;
  routeFingerprint: string;
}

export interface PiSessionFactoryInput {
  threadId: string;
  cwd: string;
  /** Eco-owned dir for PI auth/models/skills isolation (not ~/.pi). */
  agentDir: string;
  model: EcoPiModelSpec;
  /** PI session thinking level mapped from the route thinkingEffort. */
  thinkingLevel?: PiThinkingLevel;
  /** Attempt-scoped bridge credential (Eco Gateway binding). */
  apiKey: string;
  apiCompat: EcoApiCompat;
  bindingId: string;
  routeFingerprint: string;
  /** Eco-selected skill directories or SKILL.md paths for this thread. */
  skillPaths?: readonly string[];
  /** Isolated MCP servers for this thread (Claude-SDK shaped). */
  mcpServers?: Record<string, unknown>;
  /** Deadline for the native MCP startup wait; defaults to PI's 10 seconds. */
  mcpStartupWaitMs?: number;
  /** Extra system prompt append segments for integrations. */
  appendSystemPrompt?: readonly string[];
  sessionId?: string;
  /** Resume from this Eco-owned JSONL when present and readable. */
  sessionFile?: string;
  /** When true, delete existing `sessions/*.jsonl` before create (identity/MCP drift). */
  replacePersistedSessions?: boolean;
  /** Override default Eco PI system prompt (used by subagents). */
  systemPromptOverride?: string;
  /** Explicit tool allowlist; defaults to builtins (+ mcp proxies when MCP present). */
  toolsAllowlist?: readonly string[];
  /** Extra Eco extension factories (Agent tool, tests). */
  extensionFactories?: readonly {
    name: string;
    factory: (pi: unknown) => void | Promise<void>;
  }[];
  /** Parent sessions drain this bus so child events stream during Agent tool waits. */
  sideEventBus?: PiSideEventBus;
  /** Eco feed role (parent planner / subagent agentKey). */
  eventRole?: string;
  /** Eco feed agentId override (subagent instance id). */
  eventAgentId?: string;
  /** Eco tool permission callback (Claude canUseTool shape). */
  toolPermissionHandler?: SdkToolPermissionHandler;
  toolApprovalAgentId?: string;
  toolApprovalAgentType?: string;
  /** Resolved PI web search backend for this session. */
  webSearchBackend?: PiWebSearchBackend;
  /** Integrated search provider when webSearchBackend is integrated. */
  integratedWebSearchProvider?: import("./pi-integrated-web-search.js").IntegratedWebSearchProvider;
  /** Integrated search API key (runtime only, never persisted). */
  integratedWebSearchApiKey?: string;
}

export type PiSessionFactory = (input: PiSessionFactoryInput) => Promise<PiSessionHandle>;

/**
 * Agent-level retries cover in-stream overloaded/5xx. `provider.maxRetries: 0`
 * leaves the initial HTTP fetch to Gateway so the two layers do not stack.
 */
export const ECO_PI_SESSION_RETRY = {
  enabled: true,
  maxRetries: 3,
  provider: { maxRetries: 0 },
} as const;

/**
 * In-memory PI settings for every Eco session.
 *
 * PI owns native compaction and keeps its own reserve/overflow-recovery
 * defaults. Agent-level retry covers in-stream overloaded/5xx while
 * `provider.maxRetries: 0` leaves the initial HTTP fetch to Gateway, so the two
 * layers do not stack.
 *
 * `cacheWarming` is explicit because PI 1.0.3 turns it on by default:
 * `SettingsManager.getCacheWarmingMode()` returns `"streaming"` when the setting
 * is absent, which spends real tokens re-sending the conversation to keep the
 * prompt cache hot between runs. Eco bills per turn, so warming stays off until
 * it can be surfaced to the user and opted into.
 */
export function ecoPiSessionSettings() {
  return {
    compaction: { enabled: true },
    retry: { ...ECO_PI_SESSION_RETRY },
    cacheWarming: "off" as const,
  };
}

export interface PiBridgeModelResolution {
  bridgeBaseUrl: string;
  bridgeModelId: string;
  apiKey: string;
  agentDir: string;
  apiCompat: EcoApiCompat;
  bindingId: string;
  providerId: string;
  headers?: Record<string, string>;
  contextWindow?: number;
  maxOutputTokens?: number;
  supportsImageInput?: boolean;
  globalMaxOutputTokens?: import("./models-dev-limits").GlobalMaxOutputTokens;
  runAttemptId?: string;
  globalContextWindowLimit?: number;
}

export interface PiCodingAgentDriverOptions {
  /** Override for tests; production resolves `@earendil-works/pi-coding-agent`. */
  createSession?: PiSessionFactory;
  /**
   * Resolve attempt-scoped Gateway binding credentials + model alias from routes.
   * Desktop injects Bridge baseUrl / key / alias after starting Gateway route binding.
   * Pass `role` for subagent routes; omit for planner.
   */
  resolveBridgeModel: (input: {
    threadId: string;
    routes: readonly ResolvedModelRoute[];
    role?: string;
  }) => Promise<PiBridgeModelResolution>;
}

/**
 * Process-scoped PI sessions. Parent key = threadId; child key = threadId::sub::agentId.
 */
export class PiSessionRegistry {
  private readonly sessions = new Map<string, PiSessionHandle>();
  private readonly closing = new Map<string, Promise<void>>();

  get(key: string): PiSessionHandle | undefined {
    return this.sessions.get(key);
  }

  set(key: string, session: PiSessionHandle): void {
    this.sessions.set(key, session);
  }

  /** Delete one session key (parent or child). */
  delete(key: string): Promise<void> {
    const existing = this.sessions.get(key);
    this.sessions.delete(key);
    if (!existing) return this.closing.get(key) ?? Promise.resolve();
    let disposed: void | Promise<void>;
    try {
      disposed = existing.dispose();
    } catch (error) {
      disposed = Promise.reject(error);
    }
    const task = Promise.all([this.closing.get(key), disposed])
      .then(() => undefined)
      .finally(() => {
        if (this.closing.get(key) === task) this.closing.delete(key);
      });
    this.closing.set(key, task);
    return task;
  }

  /** Delete parent + every child session for an Eco thread. */
  async deleteThread(threadId: string): Promise<void> {
    const results = await Promise.allSettled(this.keysForThread(threadId).map((key) => this.delete(key)));
    const errors = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    if (errors.length > 0)
      throw new AggregateError(
        errors.map((result) => result.reason),
        "PI session shutdown failed",
      );
  }

  /** Close idle sessions as well as active ones before application exit. */
  async deleteAll(): Promise<void> {
    const keys = [...new Set([...this.sessions.keys(), ...this.closing.keys()])];
    const results = await Promise.allSettled(keys.map((key) => this.delete(key)));
    const errors = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    if (errors.length > 0)
      throw new AggregateError(
        errors.map((result) => result.reason),
        "PI session shutdown failed",
      );
  }

  async abort(threadId: string): Promise<void> {
    await Promise.all(
      this.keysForThread(threadId).map(async (key) => {
        const existing = this.sessions.get(key);
        if (!existing) {
          return;
        }
        await existing.abort();
      }),
    );
  }

  private keysForThread(threadId: string): string[] {
    const parent = piParentSessionKey(threadId);
    return [...new Set([...this.sessions.keys(), ...this.closing.keys()])].filter(
      (key) => key === parent || key.startsWith(`${parent}::sub::`),
    );
  }
}

export const globalPiSessionRegistry = new PiSessionRegistry();

/** True while the thread's live in-process PI parent session can take mid-turn steering. */
export function isPiThreadMidTurnAccepting(
  threadId: string,
  registry: PiSessionRegistry = globalPiSessionRegistry,
): boolean {
  const session = registry.get(piParentSessionKey(threadId));
  return session ? session.isStreaming() : false;
}

/**
 * Inject mid-turn steering text into the thread's live PI run.
 * Throws {@link PiMidTurnUnavailable} when the run is not accepting; the caller must keep
 * the message queued so the normal post-run drain sends it as a fresh turn instead.
 */
export async function steerPiThreadMidTurn(
  threadId: string,
  text: string,
  registry: PiSessionRegistry = globalPiSessionRegistry,
): Promise<void> {
  const session = registry.get(piParentSessionKey(threadId));
  if (!session) {
    throw new PiMidTurnUnavailable("PI session is not live for this thread.");
  }
  await session.steer(text);
}

export class PiCodingAgentDriver implements AgentRuntimeDriver {
  private readonly createSession: PiSessionFactory;
  private readonly resolveBridgeModel: PiCodingAgentDriverOptions["resolveBridgeModel"];
  private readonly registry: PiSessionRegistry;

  constructor(options: PiCodingAgentDriverOptions, registry: PiSessionRegistry = globalPiSessionRegistry) {
    this.createSession = options.createSession ?? createDefaultPiSession;
    this.resolveBridgeModel = options.resolveBridgeModel;
    this.registry = registry;
  }

  async *runAsk(input: AgentRuntimeRunInput): AsyncIterable<AgentEvent> {
    yield* this.run({
      ...input,
      piSession: { ...input.piSession, sessionMode: "ask" },
    });
  }

  async *runPlan(input: AgentRuntimeRunInput): AsyncIterable<AgentEvent> {
    yield* this.run({
      ...input,
      piSession: { ...input.piSession, sessionMode: "plan" },
    });
  }

  async *run(input: AgentRuntimeRunInput): AsyncIterable<AgentEvent> {
    const sessionMode: CoreSessionMode = input.piSession?.sessionMode ?? "agent";
    const cwd = input.worktreePath?.trim() || input.workspacePath;
    const planner = resolvePiPlannerRoute(input.routes);
    if (!planner) {
      yield createAgentEvent({
        id: `${input.threadId}:pi:no-route`,
        threadId: input.threadId,
        agentId: "system",
        role: "main",
        type: "thread.failed",
        payload: { message: "PI Harness 需要至少一条可用模型路由。" },
      });
      return;
    }

    const bridge = await this.resolveBridgeModel({
      threadId: input.threadId,
      routes: input.routes,
    });
    const apiCompat = bridge.apiCompat;
    const modelSpec = buildEcoPiModel({
      bridgeBaseUrl: bridge.bridgeBaseUrl,
      bridgeModelId: bridge.bridgeModelId,
      route: planner,
      apiCompat,
      ...(bridge.contextWindow !== undefined && { contextWindow: bridge.contextWindow }),
      ...(bridge.maxOutputTokens !== undefined && { maxOutputTokens: bridge.maxOutputTokens }),
      ...(bridge.supportsImageInput !== undefined && { supportsImageInput: bridge.supportsImageInput }),
      ...(bridge.globalMaxOutputTokens !== undefined && {
        globalMaxOutputTokens: bridge.globalMaxOutputTokens,
      }),
      ...(bridge.globalContextWindowLimit !== undefined && {
        globalContextWindowLimit: bridge.globalContextWindowLimit,
      }),
      ...(bridge.headers && { headers: bridge.headers }),
    } satisfies BuildEcoPiModelInput);
    const thinkingLevel = mapEcoThinkingEffortToPiThinkingLevel(planner.thinkingEffort);

    const fullFingerprint = computePiRouteFingerprint({
      cwd,
      providerId: bridge.providerId,
      modelId: bridge.bridgeModelId,
      apiCompat,
      baseUrl: bridge.bridgeBaseUrl,
      bindingId: bridge.bindingId,
      routes: input.routes,
    });
    const sessionIdentityFingerprint = computePiSessionIdentityFingerprint({
      cwd,
      providerId: bridge.providerId,
      modelId: bridge.bridgeModelId,
      apiCompat,
      baseUrl: bridge.bridgeBaseUrl,
      routes: input.routes,
    });

    let session = this.registry.get(piParentSessionKey(input.threadId));
    const hadRegistrySession = Boolean(session);
    const identityDrift =
      Boolean(session) &&
      (session!.cwd !== cwd ||
        stripBindingFromFingerprint(session!.routeFingerprint) !== sessionIdentityFingerprint);
    const selectedSkillPaths = input.piSession?.skillPaths ?? [];
    const skillsFingerprint = fingerprintPiSkillPaths(selectedSkillPaths);
    const mcpServers = input.piSession?.mcpServers;
    const mcpFingerprint = fingerprintPiMcpServers(mcpServers);
    const mcpDrift =
      Boolean(session) &&
      canonicalizePiMcpFingerprint(session!.mcpFingerprint) !== canonicalizePiMcpFingerprint(mcpFingerprint);
    const wantsAgentTool = sessionMode === "agent" && listEnabledPiSubagents(input.agentRegistry).length > 0;
    const agentToolDrift = Boolean(session) && wantsAgentTool !== Boolean(session!.armSubagentSpawn);
    const modeDrift = Boolean(session) && (session!.sessionMode ?? "agent") !== sessionMode;
    const webSearchBackend = input.piSession?.webSearchBackend ?? "none";
    const webSearchDrift = Boolean(session) && (session!.webSearchBackend ?? "none") !== webSearchBackend;

    const modeAwareHandler = input.piSession?.toolPermissionHandler
      ? createPiModeAwareToolPermissionHandler({
          mode: sessionMode,
          baseHandler: input.piSession.toolPermissionHandler,
        })
      : undefined;
    const permissionBridge: {
      handler: SdkToolPermissionHandler | undefined;
    } = {
      handler: modeAwareHandler,
    };
    const wantsToolApproval = Boolean(permissionBridge.handler);
    const approvalDrift = Boolean(session) && wantsToolApproval !== Boolean(session!.toolApprovalEnabled);
    const forceFresh =
      identityDrift ||
      mcpDrift ||
      agentToolDrift ||
      approvalDrift ||
      modeDrift ||
      webSearchDrift ||
      Boolean(session?.mcpStartupFailed);
    const appendSystemPrompt = [
      piSystemPromptForSessionMode(sessionMode),
      ...(input.piSession?.appendSystemPrompt ?? []),
    ].filter((entry) => entry.trim().length > 0);
    const hasMcpServers = Boolean(mcpServers && Object.keys(mcpServers).length > 0);
    const includeWebSearch = webSearchBackend !== "none";
    const toolsAllowlist = piToolsForSessionMode(sessionMode, {
      hasMcpServers: sessionMode === "agent" && hasMcpServers,
      includeFinalizePlan: sessionMode === "plan",
      includeWebSearch,
    });

    // Fingerprints decide whether to rebuild the in-process AgentSession.
    // Conversation JSONL is always resumed when a session file is available —
    // identity/MCP/mode drift must never wipe parent transcript.
    const resumeFile = input.piSession?.sessionFile?.trim() || session?.sessionFile?.trim() || "";
    const openExistingJsonl = Boolean(resumeFile);

    const spawnBridge: {
      handler: import("./pi-subagent.js").PiSubagentSpawnHandler | undefined;
    } = {
      handler: input.piSession?.onSubagentSpawn,
    };
    const planReadyBridge: {
      emit: ((plan: string, toolCallId: string) => void) | undefined;
    } = { emit: undefined };
    const enabledSubagents = listEnabledPiSubagents(input.agentRegistry);
    const extensionFactories: Array<{
      name: string;
      factory: (pi: unknown) => void | Promise<void>;
    }> = [];

    // MCP/tools/identity are extension- or model-bound at AgentSession create,
    // so fingerprint drift rebuilds the in-process session while still opening
    // the existing conversation JSONL.
    if (!session || forceFresh) {
      const sideEventBus = createPiSideEventBus();
      if (input.agentRegistry && enabledSubagents.length > 0 && wantsAgentTool) {
        extensionFactories.push({
          name: "eco-pi-agent",
          factory: createEcoPiAgentExtensionFactory({
            threadId: input.threadId,
            registry: input.agentRegistry,
            emitSideEvent: (event) => sideEventBus.push(event),
            onSubagentSpawn: async (spawnInput) => {
              const handler = spawnBridge.handler;
              if (!handler) {
                throw new Error("PI subagent spawn handler is not armed for this run.");
              }
              return handler(spawnInput);
            },
          }) as (pi: unknown) => void,
        });
      }
      if (sessionMode === "plan") {
        extensionFactories.push({
          name: PI_FINALIZE_PLAN_EXTENSION_NAME,
          factory: createEcoPiFinalizePlanExtensionFactory({
            onSubmitted: ({ plan, toolCallId }) => {
              planReadyBridge.emit?.(plan, toolCallId);
            },
          }) as (pi: unknown) => void,
        });
      }
      if (wantsToolApproval) {
        extensionFactories.push({
          name: PI_TOOL_APPROVAL_EXTENSION_NAME,
          factory: createEcoPiToolApprovalExtensionFactory({
            onToolPermission: async (request) => {
              const handler = permissionBridge.handler;
              if (!handler) {
                return {
                  behavior: "deny",
                  message: PI_TOOL_APPROVAL_HANDLER_MISSING,
                  interrupt: true,
                };
              }
              return handler(request);
            },
            cwd,
            ...(input.piSession?.toolApprovalAgentId ? { agentId: input.piSession.toolApprovalAgentId } : {}),
            ...(input.piSession?.toolApprovalAgentType
              ? { agentType: input.piSession.toolApprovalAgentType }
              : {}),
          }) as (pi: unknown) => void,
        });
      }
      const sessionToolsAllowlist = [...toolsAllowlist];
      await appendPiWebSearchSessionParts({
        backend: webSearchBackend,
        ...(input.piSession?.integratedWebSearchProvider
          ? { integratedProvider: input.piSession.integratedWebSearchProvider }
          : {}),
        ...(input.piSession?.integratedWebSearchApiKey
          ? { integratedApiKey: input.piSession.integratedWebSearchApiKey }
          : {}),
        extensionFactories,
        toolsAllowlist: sessionToolsAllowlist,
      });
      await this.registry.deleteThread(input.threadId);
      session = await this.createSession({
        threadId: input.threadId,
        cwd,
        agentDir: bridge.agentDir,
        model: modelSpec,
        thinkingLevel,
        apiKey: bridge.apiKey,
        apiCompat,
        bindingId: bridge.bindingId,
        routeFingerprint: fullFingerprint,
        skillPaths: selectedSkillPaths,
        toolsAllowlist: [
          ...new Set([...sessionToolsAllowlist, ...(wantsAgentTool ? [PI_AGENT_TOOL_NAME] : [])]),
        ],
        ...(mcpServers && Object.keys(mcpServers).length > 0 && sessionMode === "agent"
          ? { mcpServers }
          : {}),
        ...(appendSystemPrompt.length > 0 ? { appendSystemPrompt } : {}),
        ...(openExistingJsonl ? { sessionFile: resumeFile } : {}),
        sideEventBus,
        ...(extensionFactories.length > 0 ? { extensionFactories } : {}),
        webSearchBackend,
        ...(input.piSession?.integratedWebSearchProvider
          ? { integratedWebSearchProvider: input.piSession.integratedWebSearchProvider }
          : {}),
        ...(input.piSession?.integratedWebSearchApiKey
          ? { integratedWebSearchApiKey: input.piSession.integratedWebSearchApiKey }
          : {}),
      });
      session.sideEventBus = sideEventBus;
      if (input.agentRegistry && enabledSubagents.length > 0 && wantsAgentTool) {
        session.armSubagentSpawn = (handler) => {
          spawnBridge.handler = handler;
        };
      }
      if (sessionMode === "plan") {
        session.armPlanReady = (emit) => {
          planReadyBridge.emit = emit;
        };
      }
      session.toolApprovalEnabled = wantsToolApproval;
      session.sessionMode = sessionMode;
      session.webSearchBackend = webSearchBackend;
      session.armToolPermission = (handler) => {
        permissionBridge.handler = handler
          ? createPiModeAwareToolPermissionHandler({
              mode: sessionMode,
              baseHandler: handler,
            })
          : undefined;
      };
      this.registry.set(piParentSessionKey(input.threadId), session);
    } else if (session.bindingId !== bridge.bindingId) {
      // Same session identity — rebind attempt credential; never reuse old attempt key.
      await session.rebind({
        model: modelSpec,
        apiKey: bridge.apiKey,
        apiCompat,
        bindingId: bridge.bindingId,
        routeFingerprint: fullFingerprint,
      });
    }

    if (hadRegistrySession && !forceFresh) {
      session.armToolPermission?.(input.piSession?.toolPermissionHandler);
      session.toolApprovalEnabled = wantsToolApproval;
    }

    session.armSubagentSpawn?.(input.piSession?.onSubagentSpawn);

    if (sessionMode === "plan") {
      const bus = session.sideEventBus;
      session.armPlanReady?.((plan, _toolCallId) => {
        bus?.push(
          createPlanReadyEvent(input.threadId, {
            userPrompt: input.prompt,
            analysis: "PI Plan mode submitted this plan via finalize_plan.",
            plan,
          }),
        );
      });
    }

    if (session.skillsFingerprint !== skillsFingerprint) {
      await session.updateSkillPaths(selectedSkillPaths);
    }

    const activeSession = session;

    yield createAgentEvent({
      id: `${input.threadId}:pi:session.captured`,
      threadId: input.threadId,
      agentId: activeSession.sessionId,
      role: "main",
      type: "session.captured",
      payload: {
        sessionId: activeSession.sessionId,
        cwd,
        bindingId: bridge.bindingId,
        apiCompat,
        routeFingerprint: fullFingerprint,
        identityFingerprint: sessionIdentityFingerprint,
        mcpFingerprint,
        ...(activeSession.sessionFile ? { sessionFile: activeSession.sessionFile } : {}),
      },
    });

    const onAbort = () => {
      void this.registry.abort(input.threadId).catch((error) => {
        console.error(
          `[eco-pi] thread abort failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    };
    if (input.signal.aborted) {
      await this.registry.abort(input.threadId);
      return;
    }
    input.signal.addEventListener("abort", onAbort, { once: true });
    try {
      yield* activeSession.prompt(input.prompt, input.signal, input.piSession?.promptActivityLineId);
    } finally {
      input.signal.removeEventListener("abort", onAbort);
    }
  }
}

/** Session identity omits bindingId so conversation can survive attempt rebind. */
export function computePiSessionIdentityFingerprint(input: {
  cwd: string;
  providerId: string;
  modelId: string;
  apiCompat: EcoApiCompat;
  baseUrl: string;
  routes: readonly ResolvedModelRoute[];
}): string {
  return computePiRouteFingerprint({
    ...input,
    bindingId: "",
  }).replace(/;binding=;/, ";binding=;");
}

function stripBindingFromFingerprint(fingerprint: string): string {
  return fingerprint.replace(/;binding=[^;]*/, ";binding=");
}

async function createDefaultPiSession(input: PiSessionFactoryInput): Promise<PiSessionHandle> {
  const pi = await import("@earendil-works/pi-coding-agent");
  const {
    createAgentSession,
    DefaultResourceLoader,
    loadSkills,
    ModelRuntime,
    SessionManager,
    SettingsManager,
  } = pi;

  await ensurePiPrivateSkillsDir(input.agentDir);

  const modelRuntime = await ModelRuntime.create({
    authPath: `${input.agentDir}/auth.json`,
    modelsPath: `${input.agentDir}/models.json`,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  const authProvider = mapApiCompatToPiAuthProvider(input.apiCompat);
  await modelRuntime.setRuntimeApiKey(authProvider, input.apiKey);

  let selectedSkillPaths = [...(input.skillPaths ?? [])];
  let skillsFingerprint = fingerprintPiSkillPaths(selectedSkillPaths);
  let skillsState = loadSkills({
    cwd: input.cwd,
    agentDir: input.agentDir,
    skillPaths: resolvePiSessionSkillPaths({
      agentDir: input.agentDir,
      skillPaths: selectedSkillPaths,
    }),
    includeDefaults: false,
  });

  const mcpFingerprint = fingerprintPiMcpServers(input.mcpServers);
  const hasMcpServers = Boolean(input.mcpServers && Object.keys(input.mcpServers).length > 0);
  let mcpStartupError: string | undefined;
  const mcpFactory = await createPiMcpExtensionFactory(hasMcpServers ? input.mcpServers : undefined, {
    agentDir: input.agentDir,
    ...(input.mcpStartupWaitMs !== undefined ? { startupWaitMs: input.mcpStartupWaitMs } : {}),
    onNotification: (message, type) => {
      if (type === "warning" || type === "error" || message.includes("still connecting")) {
        mcpStartupError = message;
      }
    },
  });

  const appendSystemPrompt = [...(input.appendSystemPrompt ?? [])]
    .map((entry) => entry.trim())
    .filter(Boolean);

  // PI owns native compaction. Agent-level retry stays on: in-stream
  // overloaded/5xx never hits Gateway's HTTP fetch retry. Provider retry 0
  // avoids double-retrying the initial upstream fetch.
  // PI's native defaults (reserve 16K + overflow-recovery retry) are kept.
  // Do not set settings.defaultTools: Eco passes an explicit `tools` allowlist
  // (mode + MCP + Agent + web_search + finalize_plan). PI 0.84.2+ defaultTools
  // would only fight that ownership. Windows `powershell` is intentionally
  // omitted until Eco has a PS read-only policy (Ask/Plan).
  const settingsManager = SettingsManager.inMemory(ecoPiSessionSettings());

  const systemPromptText = input.systemPromptOverride?.trim();

  const extensionFactories: Array<{ name: string; factory: (pi: unknown) => void | Promise<void> }> = [];
  extensionFactories.push({
    name: "eco-pi-image-input",
    factory: createEcoPiImageInputExtensionFactory(pi.createReadToolDefinition(input.cwd)) as never,
  });
  if (mcpFactory) {
    extensionFactories.push({
      name: "eco-pi-mcp",
      factory: mcpFactory as never,
    });
  }
  // Registered for every mode; the tool only activates when the session's
  // allowlist names it (Agent), so Ask/Plan never see a script sandbox.
  extensionFactories.push({
    name: PI_CODEMODE_EXTENSION_NAME,
    factory: createPiCodemodeExtensionFactory() as never,
  });
  for (const entry of input.extensionFactories ?? []) {
    extensionFactories.push(entry);
  }
  if (input.toolPermissionHandler) {
    extensionFactories.push({
      name: PI_TOOL_APPROVAL_EXTENSION_NAME,
      factory: createEcoPiToolApprovalExtensionFactory({
        onToolPermission: input.toolPermissionHandler,
        cwd: input.cwd,
        ...(input.toolApprovalAgentId ? { agentId: input.toolApprovalAgentId } : {}),
        ...(input.toolApprovalAgentType ? { agentType: input.toolApprovalAgentType } : {}),
      }) as (pi: unknown) => void,
    });
  }

  const toolsAllowlistBase =
    input.toolsAllowlist && input.toolsAllowlist.length > 0
      ? [...input.toolsAllowlist]
      : // No explicit list (headless harnesses): use the Agent policy rather than
        // a second, drifting copy of it.
        piToolsForSessionMode("agent", { hasMcpServers });
  const webSearchBackend = input.webSearchBackend ?? "none";
  await appendPiWebSearchSessionParts({
    backend: webSearchBackend,
    ...(input.integratedWebSearchProvider ? { integratedProvider: input.integratedWebSearchProvider } : {}),
    ...(input.integratedWebSearchApiKey ? { integratedApiKey: input.integratedWebSearchApiKey } : {}),
    extensionFactories,
    toolsAllowlist: toolsAllowlistBase,
  });

  const allowedTools = new Set(toolsAllowlistBase);
  const hasAgentExtension = (input.extensionFactories ?? []).some((entry) => entry.name === "eco-pi-agent");
  if (hasAgentExtension) allowedTools.add(PI_AGENT_TOOL_NAME);
  const allowSelectedMcpTools = PI_MCP_HUB_TOOL_NAMES.some((name) => allowedTools.has(name));
  const nonHubServers = Object.keys(input.mcpServers ?? {})
    .map((name) => name.trim())
    .filter((name) => name !== "eco_mcp");
  // MCP names are only known after native registration (including sanitized/hash
  // suffixes). Filter registrations instead of freezing those names in SDK tools.
  const scopedFactory =
    (name: string, factory: ExtensionFactory): ExtensionFactory =>
    (api) =>
      factory({
        ...api,
        registerTool: (tool) => {
          const nativeMcpTool =
            name === "eco-pi-mcp" &&
            allowSelectedMcpTools &&
            ((tool.name.startsWith("mcp__") &&
              nonHubServers.some((server) => tool.label.startsWith(`${server}/`))) ||
              (nonHubServers.length > 0 &&
                ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"].includes(
                  tool.name,
                )));
          if (allowedTools.has(tool.name) || nativeMcpTool) api.registerTool(tool);
        },
      } satisfies ExtensionAPI);

  const resourceLoader = new DefaultResourceLoader({
    cwd: input.cwd,
    agentDir: input.agentDir,
    settingsManager,
    // Block ambient package/file extensions; only Eco-injected factories.
    noExtensions: true,
    ...(extensionFactories.length > 0
      ? {
          extensionFactories: extensionFactories.map((entry) => ({
            name: entry.name,
            factory: hasMcpServers
              ? scopedFactory(entry.name, entry.factory as ExtensionFactory)
              : (entry.factory as never),
          })),
        }
      : {}),
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    skillsOverride: () => skillsState,
    ...(systemPromptText ? { systemPromptOverride: () => systemPromptText } : {}),
    appendSystemPromptOverride: () => appendSystemPrompt,
  });
  await resourceLoader.reload();

  const sessionsDir = await ensurePiSessionsDir(input.agentDir);
  if (input.replacePersistedSessions) {
    await clearPiSessionFiles(input.agentDir);
  }

  let sessionManager;
  const resumePath = input.sessionFile?.trim();
  if (resumePath && !input.replacePersistedSessions) {
    if (!(await isUsablePiSessionFile(resumePath, sessionsDir)))
      throw new Error("PI 无法恢复指定的会话文件：文件缺失或不在当前会话目录内。");
    sessionManager = SessionManager.open(resumePath, sessionsDir, input.cwd);
  } else {
    sessionManager = SessionManager.create(input.cwd, sessionsDir, {
      ...(input.sessionId ? { id: input.sessionId } : {}),
    });
  }

  // PI's `tools` option is an allowlist: extension tools not listed here are dropped
  // from the registry (see AgentSession._refreshToolRegistry). Agent must be included
  // whenever eco-pi-agent is loaded, or the model only sees mcp/browser and never Agent.
  const toolsAllowlist = [...allowedTools];

  const { session } = await createAgentSession({
    cwd: input.cwd,
    agentDir: input.agentDir,
    model: input.model as never,
    thinkingLevel: input.thinkingLevel ?? "off",
    modelRuntime,
    resourceLoader: resourceLoader as never,
    ...(hasMcpServers
      ? {
          noTools: "builtin" as const,
          excludeTools: ["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"].filter(
            (name) => !allowedTools.has(name),
          ),
        }
      : { tools: toolsAllowlist }),
    sessionManager,
    settingsManager,
  });

  // PI CLI modes call bindExtensions (emits session_start → MCP init). Eco creates
  // sessions headlessly and must do the same; otherwise mcp() stays "MCP not initialized".
  // The native startup hook waits for direct tools. Its UI warnings are otherwise
  // swallowed in RPC mode; block the provider request if that startup failed or timed out.
  let disposed = false;
  const disposeSession = () => {
    disposed = true;
    return disposePiSdkSession(session);
  };
  const nativeStream = session.agent.streamFunction;
  session.agent.streamFunction = (model, context, options) => {
    if (disposed) throw new Error("PI session has been disposed");
    if (mcpStartupError) throw new Error(`PI MCP startup failed: ${mcpStartupError}`);
    // Validate before PI's provider adapter can silently omit unsupported images,
    // including persisted tool results when a session switches to a text model.
    assertPiImageInputAllowed(model, context.messages);
    return nativeStream(model, context, options);
  };
  session.setActiveToolsByName([...session.getActiveToolNames(), ...toolsAllowlist]);
  try {
    await session.bindExtensions({
      mode: "rpc",
      onError: (err: { extensionPath?: string; error?: string }) => {
        if (err.extensionPath?.includes("eco-pi-mcp")) mcpStartupError = err.error ?? "MCP extension failed";
        console.error(`PI extension error (${err.extensionPath ?? "?"}): ${err.error ?? "unknown"}`);
      },
    });
  } catch (error) {
    await disposeSession();
    throw error;
  }

  const sessionId = sessionManager.getSessionId();
  const sessionFile = sessionManager.getSessionFile() ?? undefined;
  let seq = 0;
  const adapterState = createPiEventAdapterState();
  let routeFingerprint = input.routeFingerprint;
  let bindingId = input.bindingId;
  let apiCompat = input.apiCompat;
  const eventRole = input.eventRole?.trim() || "main";
  const eventAgentId = input.eventAgentId?.trim() || sessionId;
  const sideEventBus = input.sideEventBus;
  let abortWork: Promise<void> | undefined;
  const abortSession = (): Promise<void> => {
    if (!abortWork) {
      abortWork = session.abort().finally(() => {
        abortWork = undefined;
      });
    }
    return abortWork;
  };

  return {
    sessionId,
    ...(sessionFile ? { sessionFile } : {}),
    cwd: input.cwd,
    get routeFingerprint() {
      return routeFingerprint;
    },
    get bindingId() {
      return bindingId;
    },
    get skillsFingerprint() {
      return skillsFingerprint;
    },
    get mcpFingerprint() {
      return mcpFingerprint;
    },
    webSearchBackend,
    get mcpStartupFailed() {
      return mcpStartupError !== undefined;
    },
    ...(sideEventBus ? { sideEventBus } : {}),
    abort: abortSession,
    dispose: disposeSession,
    ...createPiMidTurnHandle(session),
    rebind: async (rebindInput) => {
      const nextAuthProvider = mapApiCompatToPiAuthProvider(rebindInput.apiCompat);
      await modelRuntime.setRuntimeApiKey(nextAuthProvider, rebindInput.apiKey);
      // AgentSession.setModel is the supported rebind path (keeps conversation state).
      await (session as { setModel: (model: unknown) => Promise<void> }).setModel(rebindInput.model);
      bindingId = rebindInput.bindingId;
      routeFingerprint = rebindInput.routeFingerprint;
      apiCompat = rebindInput.apiCompat;
    },
    updateSkillPaths: async (skillPaths) => {
      selectedSkillPaths = [...skillPaths];
      skillsFingerprint = fingerprintPiSkillPaths(selectedSkillPaths);
      await ensurePiPrivateSkillsDir(input.agentDir);
      skillsState = loadSkills({
        cwd: input.cwd,
        agentDir: input.agentDir,
        skillPaths: resolvePiSessionSkillPaths({
          agentDir: input.agentDir,
          skillPaths: selectedSkillPaths,
        }),
        includeDefaults: false,
      });
      // AgentSession.reload re-reads ResourceLoader and rebuilds the system prompt.
      await (session as { reload: (options?: Record<string, never>) => Promise<void> }).reload();
    },
    async *prompt(
      text: string,
      signal?: AbortSignal,
      promptActivityLineId?: string,
    ): AsyncIterable<AgentEvent> {
      let sawSettled = false;
      let settledAborted = false;
      let assistantError: string | undefined;
      let promptBound = false;

      const mapCtx = {
        threadId: input.threadId,
        sessionId,
        agentId: eventAgentId,
        role: eventRole,
        apiCompat,
        state: adapterState,
        nextSeq: () => {
          seq += 1;
          return seq;
        },
      };

      try {
        const { done, runError } = yield* streamPiPromptEvents<AgentEvent>({
          signal,
          subscribe: (push) => {
            const unsubscribe = session.subscribe((event) => {
              if (
                !promptBound &&
                promptActivityLineId &&
                event.type === "message_end" &&
                event.message.role === "user"
              ) {
                promptBound = true;
                const message = event.message;
                // Pi emits message_end before persisting it. The microtask runs after the
                // synchronous append; object identity ties this receipt to that exact entry.
                queueMicrotask(() => {
                  const entry = sessionManager
                    .getEntries()
                    .find((entry) => entry.type === "message" && entry.message === message);
                  push([
                    createAgentEvent({
                      id: `${input.threadId}:pi:prompt-entry:${entry?.id ?? "missing"}`,
                      threadId: input.threadId,
                      agentId: eventAgentId,
                      role: eventRole,
                      type: entry ? "file.checkpoint" : "thread.failed",
                      payload: entry
                        ? { source: "pi", activityLineId: promptActivityLineId, userMessageId: entry.id }
                        : { message: "Pi 用户消息已发送，但原生节点身份未持久化。" },
                    }),
                  ]);
                });
              }
              const mapped = mapPiSessionEventToAgentEvents(event as PiSessionEventLike, mapCtx);
              if (mapped.length > 0) push(mapped);
              if (event.type === "agent_settled") {
                sawSettled = true;
                settledAborted ||= event.aborted;
              }
              assistantError = applyPiAssistantErrorTracker(event as PiSessionEventLike, assistantError);
            });
            const unsubscribeSide = sideEventBus?.subscribe((event) => push([event]));
            return () => {
              unsubscribe();
              unsubscribeSide?.();
            };
          },
          run: () => session.prompt(text, { source: "rpc" }),
          abort: abortSession,
        });
        if (runError) {
          const message = runError instanceof Error ? runError.message : String(runError);
          yield createAgentEvent({
            id: `${input.threadId}:pi:error:${seq + 1}`,
            threadId: input.threadId,
            agentId: eventAgentId,
            role: eventRole,
            type: "thread.failed",
            payload: { message },
          });
        }
        // Only real agent_settled may complete. prompt promise done alone is not settle.
        const terminal = decidePiPromptRunTerminal({
          sawAgentSettled: sawSettled,
          aborted: settledAborted || Boolean(signal?.aborted),
          ...(runError
            ? {
                errorMessage: runError instanceof Error ? runError.message : String(runError),
              }
            : assistantError
              ? { errorMessage: assistantError }
              : {}),
          promptReturned: done && !runError && !signal?.aborted,
        });
        if (terminal) {
          yield createAgentEvent({
            id: `${input.threadId}:pi:terminal:${terminal.status}:${seq + 1}`,
            threadId: input.threadId,
            agentId: eventAgentId,
            role: eventRole,
            type: "run.terminal",
            payload: terminal,
          });
        }
      } finally {
        if (mcpStartupError) await disposeSession();
      }
    },
  };
}

/** Exported for desktop subagent host / tests. */
export { createDefaultPiSession };

/**
 * Decide upward run.terminal after a PI prompt attempt.
 * `promptReturned` (promise done) is NOT settle — only `sawAgentSettled` may complete.
 */
export function decidePiPromptRunTerminal(input: {
  sawAgentSettled: boolean;
  aborted: boolean;
  errorMessage?: string;
  /** Prompt promise fulfilled without throw/abort — still not a settle signal. */
  promptReturned: boolean;
}):
  | { status: "completed" }
  | { status: "failed"; error: string }
  | { status: "cancelled"; reason: string }
  | { status: "incomplete"; reason: string }
  | undefined {
  if (input.aborted) {
    return { status: "cancelled", reason: "cancelled by user" };
  }
  if (input.errorMessage) {
    return { status: "failed", error: input.errorMessage };
  }
  if (input.sawAgentSettled) {
    return { status: "completed" };
  }
  if (input.promptReturned) {
    return {
      status: "incomplete",
      reason: "PI prompt returned without agent_settled.",
    };
  }
  return undefined;
}
