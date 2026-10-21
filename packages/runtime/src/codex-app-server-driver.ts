import path from "node:path";
import { type AgentEvent, createAgentEvent } from "../../shared/src";
import {
  type CodexAppServerClient,
  type CodexAppServerNotificationHandler,
  resolveCodexTurnStartTimeoutMs,
} from "./codex-app-server-client.js";
import {
  buildCodexGatewayModelAlias,
  buildCodexModelProviderSlug,
  CODEX_BUILT_IN_OPENAI_PROVIDER_ID,
} from "./codex-config-sync.js";
import {
  buildPlanHandoff,
  buildPlanHandoffContinuePlan,
  planHandoffToTurnOptions,
} from "./codex-plan-handoff.js";
import {
  applyCodexTurnModel,
  buildCodexTurnOptions,
  type CodexAppServerSandboxPolicy,
  type CodexCollaborationMode,
  type CodexReasoningEffort,
  type CodexSessionMode,
  type CodexTurnOptions,
  toCodexAppServerSandboxPolicy,
} from "./codex-prompt-materializer.js";
import {
  isCodexThreadConfigApplied,
  recordAppliedCodexThreadConfig,
} from "./codex-thread-config-fingerprint.js";
import { resumeCodexThread } from "./codex-thread-resume.js";
import { interruptCodexTurn } from "./codex-turn-interrupt.js";
import type { CodexTurnRoutePendingOwner, CodexTurnRouteRegistry } from "./codex-turn-route-registry.js";
import type {
  AgentRuntimeDriver,
  AgentRuntimeRunInput,
  CodexSkillInput,
  EcoPlanningContext,
} from "./index.js";

export type CodexTurnReasoningEffort = CodexReasoningEffort;

export function toCodexTurnReasoningEffort(
  effort: AgentRuntimeRunInput["routes"][number]["thinkingEffort"],
): CodexTurnReasoningEffort | undefined {
  if (effort === undefined) {
    return undefined;
  }
  const normalized = effort.trim();
  if (!normalized) {
    throw new Error("Codex reasoning effort must be a non-empty string.");
  }
  return normalized === "off" ? "none" : normalized;
}

export interface CodexThreadStartParams {
  cwd?: string;
  model: string;
  modelProvider?: string;
  ephemeral?: boolean;
  /** Official per-thread ConfigToml layer (agents and MCP visibility). */
  config?: Record<string, unknown>;
  /** Additional thread-level developer instructions, separate from collaboration mode. */
  developerInstructions?: string;
}

export interface CodexThreadStartResult {
  thread: {
    id: string;
    ephemeral?: boolean;
    path?: string | null;
  };
}

export interface CodexTurnStartParams {
  threadId: string;
  input: Array<
    | { type: "text"; text: string }
    | CodexSkillInput
    | { type: "localImage"; path: string; detail?: "low" | "high" }
  >;
  cwd?: string;
  /** Top-level model override; must match collaborationMode.settings.model. */
  model: string;
  /** Top-level reasoning override; persists for subsequent turns on the thread. */
  effort?: CodexTurnReasoningEffort;
  /** Codex Settings.model is required whenever collaborationMode is sent. */
  collaborationMode: CodexCollaborationMode;
  sandboxPolicy: CodexAppServerSandboxPolicy;
  /** Codex `AskForApproval`: on-request | never. */
  approvalPolicy?: "on-request" | "never";
}

export interface CodexTurnStartResult {
  turn: {
    id: string;
    items: unknown[];
    status: "completed" | "inProgress" | "failed" | "interrupted";
  };
}

export interface CodexAppServerDriverOptions {
  client: CodexAppServerClient;
  sessionMode?: CodexSessionMode;
  /** Eco orchestration guidance sent through thread/start and thread/resume. */
  developerInstructions?: string;
  /** Orchestration mainAgent.tools; intersects sessionMode for sandbox / approvalPolicy. */
  orchestrationToolPolicy?: import("./codex-tool-policy.js").EcoToolPolicy;
  /** Reapplied on both thread/start and thread/resume. */
  threadConfig?: Record<string, unknown>;
  existingCodexThreadId?: string;
  /** Exact immutable role config is known to own the existing child on this client. */
  threadConfigAlreadyApplied?: boolean;
  onThreadMapped?: (ecoThreadId: string, codexThreadId: string) => void;
  /** Fires as soon as turn/start returns a turn id (before tools run). */
  onTurnBound?: (input: { ecoThreadId: string; codexThreadId: string; turnId: string }) => void;
  /**
   * Mid-turn lifecycle: closeIngress should run before the driver drops the active turn
   * so in-flight turn/steer can finish; onTurnClosed clears product ports afterward.
   */
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
  onNotification?: CodexAppServerNotificationHandler;
  onItemNotification?: (method: string, params: unknown) => void;
  logNotifications?: boolean;
  /** Shared with CodexEventAdapter for route correlation and terminal diagnostics, never billing. */
  turnRouteRegistry?: CodexTurnRouteRegistry;
  onResumeDiagnostic?: (diagnostic: import("./codex-thread-resume.js").CodexResumeDiagnostic) => void;
}

export interface CodexDriverTurnOverrides {
  prompt?: string;
  turnOptions?: CodexTurnOptions;
  existingCodexThreadId?: string;
  forkThread?: boolean;
}

// Codex app-server can return the same thread id for overlapping thread/start
// requests. Serialize only creation per client; turns on distinct threads stay parallel.
const threadStartTailByClient = new WeakMap<CodexAppServerClient, Promise<void>>();

async function startCodexThreadSerially<T>(
  client: CodexAppServerClient,
  start: () => Promise<T>,
): Promise<T> {
  const previous = threadStartTailByClient.get(client) ?? Promise.resolve();
  let releaseCurrent!: () => void;
  const current = new Promise<void>((resolve) => {
    releaseCurrent = resolve;
  });
  threadStartTailByClient.set(
    client,
    previous.then(
      () => current,
      () => current,
    ),
  );

  await previous.catch(() => {});
  try {
    return await start();
  } finally {
    releaseCurrent();
  }
}

export class CodexAppServerDriver implements AgentRuntimeDriver {
  private readonly client: CodexAppServerClient;
  private readonly sessionMode: CodexSessionMode;
  private readonly developerInstructions: string | undefined;
  private readonly orchestrationToolPolicy: import("./codex-tool-policy.js").EcoToolPolicy | undefined;
  private readonly threadConfig: Record<string, unknown> | undefined;
  private readonly existingCodexThreadId: string | undefined;
  private readonly threadConfigAlreadyApplied: boolean;
  private readonly onThreadMapped: ((ecoThreadId: string, codexThreadId: string) => void) | undefined;
  private readonly onTurnBound:
    | ((input: { ecoThreadId: string; codexThreadId: string; turnId: string }) => void)
    | undefined;
  private readonly onTurnClosing:
    | ((input: { ecoThreadId: string; codexThreadId: string; turnId?: string }) => void | Promise<void>)
    | undefined;
  private readonly onTurnClosed:
    | ((input: { ecoThreadId: string; codexThreadId: string; turnId?: string }) => void | Promise<void>)
    | undefined;
  private readonly onItemNotification: ((method: string, params: unknown) => void) | undefined;
  private readonly logNotifications: boolean;
  private readonly turnRouteRegistry: CodexTurnRouteRegistry | undefined;
  private readonly onResumeDiagnostic:
    | ((diagnostic: import("./codex-thread-resume.js").CodexResumeDiagnostic) => void)
    | undefined;
  private readonly activeTurnRoutes = new Map<string, { codexThreadId: string; turnId: string }>();
  private readonly pendingRouteOwners = new Map<string, CodexTurnRoutePendingOwner>();
  private removeNotificationHandler: (() => void) | undefined;

  constructor(options: CodexAppServerDriverOptions) {
    this.client = options.client;
    this.sessionMode = options.sessionMode ?? "agent";
    this.developerInstructions = options.developerInstructions?.trim() || undefined;
    this.orchestrationToolPolicy = options.orchestrationToolPolicy;
    this.threadConfig = options.threadConfig;
    this.existingCodexThreadId = options.existingCodexThreadId;
    this.threadConfigAlreadyApplied = options.threadConfigAlreadyApplied ?? false;
    this.onThreadMapped = options.onThreadMapped;
    this.onTurnBound = options.onTurnBound;
    this.onTurnClosing = options.onTurnClosing;
    this.onTurnClosed = options.onTurnClosed;
    this.onItemNotification = options.onItemNotification;
    this.logNotifications = options.logNotifications ?? false;
    this.turnRouteRegistry = options.turnRouteRegistry;
    this.onResumeDiagnostic = options.onResumeDiagnostic;
    if (this.existingCodexThreadId && this.threadConfig && this.threadConfigAlreadyApplied) {
      recordAppliedCodexThreadConfig(this.client, this.existingCodexThreadId, this.threadConfig);
    }
    this.removeNotificationHandler = this.client.addNotificationHandler((method, params) => {
      options.onNotification?.(method, params);
      if (method.startsWith("item/")) {
        this.onItemNotification?.(method, params);
        if (this.logNotifications) {
          console.info("[codex-app-server]", method, params);
        }
      }
    });
  }

  private materializeTurnOptions(sessionMode: CodexSessionMode) {
    return buildCodexTurnOptions({
      sessionMode,
      ...(this.orchestrationToolPolicy ? { orchestrationToolPolicy: this.orchestrationToolPolicy } : {}),
    });
  }

  async *run(input: AgentRuntimeRunInput): AsyncIterable<AgentEvent> {
    yield* this.executeTurn(input, {
      turnOptions: this.materializeTurnOptions(this.sessionMode),
    });
  }

  async *runAsk(input: AgentRuntimeRunInput): AsyncIterable<AgentEvent> {
    yield* this.executeTurn(input, {
      turnOptions: this.materializeTurnOptions("ask"),
    });
  }

  async *runPlan(input: AgentRuntimeRunInput): AsyncIterable<AgentEvent> {
    yield* this.executeTurn(input, {
      turnOptions: this.materializeTurnOptions("plan"),
    });
  }

  async *runContinuation(
    input: AgentRuntimeRunInput,
    mode: "planning" | "execution" | "ask",
    planning?: EcoPlanningContext,
  ): AsyncIterable<AgentEvent> {
    if (mode === "execution" && planning) {
      const handoff = buildPlanHandoff(planning.handoffChoice ?? "same_thread", {
        planMarkdown: planning.plan,
        ...(planning.planUserEdited ? { planUserEdited: true } : {}),
        ...(planning.userFollowUp?.trim() ? { userFollowUp: planning.userFollowUp.trim() } : {}),
      });
      const turnOptions = planHandoffToTurnOptions(handoff);
      const existingCodexThreadId = handoff.forkThread ? undefined : this.existingCodexThreadId;
      yield* this.executeTurn(input, {
        prompt: handoff.userMessage,
        turnOptions,
        ...(existingCodexThreadId && { existingCodexThreadId }),
        forkThread: handoff.forkThread,
      });
      return;
    }

    if (mode === "planning" && planning?.handoffChoice === "continue_plan") {
      const handoff = buildPlanHandoffContinuePlan({
        planMarkdown: planning.plan,
        ...(planning.userFollowUp?.trim() ? { userFollowUp: planning.userFollowUp.trim() } : {}),
      });
      const turnOptions = planHandoffToTurnOptions(handoff);
      yield* this.executeTurn(input, {
        prompt: handoff.userMessage,
        turnOptions,
        forkThread: false,
      });
      return;
    }

    const sessionMode: CodexSessionMode = mode === "planning" ? "plan" : mode === "ask" ? "ask" : "agent";
    yield* this.executeTurn(input, {
      turnOptions: this.materializeTurnOptions(sessionMode),
    });
  }

  dispose(): void {
    for (const { codexThreadId, turnId } of this.activeTurnRoutes.values()) {
      this.turnRouteRegistry?.clearTurn(codexThreadId, turnId);
    }
    this.activeTurnRoutes.clear();
    for (const owner of this.pendingRouteOwners.values()) {
      this.turnRouteRegistry?.clearPending(owner);
    }
    this.pendingRouteOwners.clear();
    this.removeNotificationHandler?.();
    this.removeNotificationHandler = undefined;
  }

  private async *executeTurn(
    input: AgentRuntimeRunInput,
    overrides: CodexDriverTurnOverrides = {},
  ): AsyncIterable<AgentEvent> {
    const route = input.routes[0];
    if (!route) {
      throw new Error("ResolvedModelRoute is required for Codex turn/start.");
    }
    const ecoProviderId = route.providerId?.trim();
    if (!ecoProviderId) {
      throw new Error(
        "ResolvedModelRoute.providerId is required for Codex model_provider (do not use primary.provider ModelProviderKind).",
      );
    }
    // ThreadRuntimeConfig modelId — not primary.modelId (eco SDK alias for the Anthropic proxy path).
    const turnModel = route.upstreamModelId?.trim();
    if (!turnModel) {
      throw new Error(
        "ResolvedModelRoute.upstreamModelId is required for Codex turn/start model (ThreadRuntimeConfig modelId; do not use primary.modelId eco alias).",
      );
    }
    // Built-in OpenAI (auth.json) must be pinned explicitly: config.toml sets a
    // global `model_provider = "eco_*"` default, so omitting modelProvider would
    // send the official-subscription route into eco-gateway, which has no
    // "openai" provider (route miss → 404).
    const isBuiltInOpenAi = ecoProviderId === CODEX_BUILT_IN_OPENAI_PROVIDER_ID;
    const modelProvider = isBuiltInOpenAi
      ? CODEX_BUILT_IN_OPENAI_PROVIDER_ID
      : buildCodexModelProviderSlug(ecoProviderId);
    const codexGatewayModel = isBuiltInOpenAi ? turnModel : buildCodexGatewayModelAlias(ecoProviderId, turnModel, route.apiCompat);
    const cwd = input.worktreePath || input.workspacePath;
    const turnOptions = overrides.turnOptions ?? this.materializeTurnOptions(this.sessionMode);
    const prompt = overrides.prompt?.trim() || input.prompt;
    const effort = toCodexTurnReasoningEffort(route.thinkingEffort);
    const collaborationMode = applyCodexTurnModel(turnOptions.collaborationMode, codexGatewayModel, effort);
    const turnInput = buildCodexTurnInput(
      prompt,
      input.codexSession?.skillInputs,
      input.codexSession?.localImagePaths,
    );

    let codexThreadId = overrides.forkThread
      ? undefined
      : overrides.existingCodexThreadId?.trim() || this.existingCodexThreadId?.trim();

    const turnStartTimeoutMs = resolveCodexTurnStartTimeoutMs();

    if (codexThreadId) {
      // Existing map → thread/resume (never silently thread/start a new thread).
      const resumed = await resumeCodexThread(this.client, {
        threadId: codexThreadId,
        cwd,
        model: codexGatewayModel,
        ...(modelProvider ? { modelProvider } : {}),
        ...(this.developerInstructions ? { developerInstructions: this.developerInstructions } : {}),
        ...(this.threadConfig ? { config: this.threadConfig } : {}),
        ...(this.threadConfig && isCodexThreadConfigApplied(this.client, codexThreadId, this.threadConfig)
          ? { configAlreadyApplied: true }
          : {}),
        ...(this.onResumeDiagnostic ? { onDiagnostic: this.onResumeDiagnostic } : {}),
      });
      codexThreadId = resumed.thread.id.trim() || codexThreadId;
      if (this.threadConfig) {
        recordAppliedCodexThreadConfig(this.client, codexThreadId, this.threadConfig);
      }
      // Keep eco↔codex mapping current (resume may refresh the id) and unblock
      // any child events buffered before the parent map was available.
      this.onThreadMapped?.(input.threadId, codexThreadId);
      yield createAgentEvent({
        id: `${input.threadId}:codex-thread-resumed`,
        threadId: input.threadId,
        agentId: "system",
        role: "main",
        type: "agent.started",
        payload: { codexThreadId, resumed: true },
      });
    } else {
      const thread = await startCodexThreadSerially(this.client, () =>
        this.client.request<CodexThreadStartResult>(
          "thread/start",
          {
            cwd,
            model: codexGatewayModel,
            ...(modelProvider ? { modelProvider } : {}),
            ...(this.developerInstructions ? { developerInstructions: this.developerInstructions } : {}),
            ...(this.threadConfig ? { config: this.threadConfig } : {}),
          } satisfies CodexThreadStartParams,
          { timeoutMs: turnStartTimeoutMs },
        ),
      );
      codexThreadId = thread.thread.id;
      if (this.threadConfig) {
        recordAppliedCodexThreadConfig(this.client, codexThreadId, this.threadConfig);
      }
      this.onThreadMapped?.(input.threadId, codexThreadId);
      yield createAgentEvent({
        id: `${input.threadId}:codex-thread-started`,
        threadId: input.threadId,
        agentId: "system",
        role: "main",
        type: "agent.started",
        payload: { codexThreadId },
      });
    }

    // No active turn yet — abort only tears down local waiters (no turn/interrupt).
    if (input.signal.aborted) {
      throw input.signal.reason ?? new Error("aborted");
    }

    // Codex calls eco-gateway at model_providers.<slug>.base_url with this model id.
    process.stderr.write(
      `[eco-codex] turn/start thread=${codexThreadId} modelProvider=${modelProvider} model=${codexGatewayModel} upstreamModel=${turnModel} effort=${effort ?? "default"} cwd=${cwd}\n`,
    );
    const routeIdentity = {
      aliasModelId: codexGatewayModel,
      providerId: ecoProviderId,
      upstreamModelId: turnModel,
      ...(route.apiCompat && { apiCompat: route.apiCompat }),
    };
    const pendingRouteOwner = this.turnRouteRegistry?.registerPending(codexThreadId, routeIdentity);
    if (pendingRouteOwner) {
      this.pendingRouteOwners.set(codexThreadId, pendingRouteOwner);
    }
    const completionObserver = observeTurnCompletions(this.client, codexThreadId);
    let turnId: string | undefined;
    let activeTurnKey: string | undefined;
    let routeBound = false;

    try {
      await this.client.request<unknown>(
        "turn/start",
        {
          threadId: codexThreadId,
          input: turnInput,
          cwd,
          model: codexGatewayModel,
          ...(effort ? { effort } : {}),
          collaborationMode,
          sandboxPolicy: toCodexAppServerSandboxPolicy(turnOptions.sandboxPolicy, turnOptions.networkAccess),
          approvalPolicy: turnOptions.approvalPolicy,
        } satisfies CodexTurnStartParams,
        {
          timeoutMs: turnStartTimeoutMs,
          onResult: (result) => {
            const turnStart = parseCodexTurnStartResult(result);
            turnId = turnStart.turn.id;
            activeTurnKey = `${codexThreadId}\u0000${turnId}`;
            if (pendingRouteOwner) {
              if (!this.turnRouteRegistry) {
                throw new Error("Codex turn route pending owner has no registry.");
              }
              this.turnRouteRegistry.bindPending(pendingRouteOwner, turnId);
              this.forgetPendingRouteOwner(pendingRouteOwner);
              routeBound = true;
              this.activeTurnRoutes.set(activeTurnKey, { codexThreadId, turnId });
            }
            this.onTurnBound?.({
              ecoThreadId: input.threadId,
              codexThreadId,
              turnId,
            });
          },
        },
      );
      if (!turnId) {
        throw new Error("turn/start response hook did not provide turn.id.");
      }

      yield createAgentEvent({
        id: `${input.threadId}:codex-turn-started`,
        threadId: input.threadId,
        agentId: "main",
        role: "main",
        type: "message.delta",
        payload: { text: "" },
      });

      const completed = await completionObserver.wait({
        turnId,
        signal: input.signal,
      });
      const turnFailure = readCodexTurnFailure(completed);
      if (turnFailure) {
        throw new Error(turnFailure);
      }
      yield createAgentEvent({
        id: `${input.threadId}:codex-turn-completed`,
        threadId: input.threadId,
        agentId: "main",
        role: "main",
        type: "agent.completed",
        payload: { codexThreadId, turn: completed },
      });
    } finally {
      try {
        await this.onTurnClosing?.({
          ecoThreadId: input.threadId,
          codexThreadId,
          ...(turnId ? { turnId } : {}),
        });
      } catch {
        // Port closeIngress must not mask turn terminal cleanup.
      }
      completionObserver.dispose();
      if (pendingRouteOwner) {
        this.turnRouteRegistry?.clearPending(pendingRouteOwner);
        this.forgetPendingRouteOwner(pendingRouteOwner);
      }
      if (routeBound && turnId) {
        this.turnRouteRegistry?.clearTurn(codexThreadId, turnId);
      }
      if (activeTurnKey) {
        this.activeTurnRoutes.delete(activeTurnKey);
      }
      try {
        await this.onTurnClosed?.({
          ecoThreadId: input.threadId,
          codexThreadId,
          ...(turnId ? { turnId } : {}),
        });
      } catch {
        // Port close must not mask turn terminal cleanup.
      }
    }
  }

  private forgetPendingRouteOwner(owner: CodexTurnRoutePendingOwner): void {
    const current = this.pendingRouteOwners.get(owner.codexThreadId);
    if (current?.generation === owner.generation) {
      this.pendingRouteOwners.delete(owner.codexThreadId);
    }
  }
}

export {
  isCodexThreadConfigApplied,
  recordAppliedCodexThreadConfig,
  transferAppliedCodexThreadConfig,
} from "./codex-thread-config-fingerprint.js";

export function buildCodexTurnInput(
  prompt: string,
  skillInputs: readonly CodexSkillInput[] | undefined,
  localImagePaths: readonly string[] | undefined = undefined,
): CodexTurnStartParams["input"] {
  const input: CodexTurnStartParams["input"] = prompt ? [{ type: "text", text: prompt }] : [];
  const seenPaths = new Set<string>();
  for (const [index, skill] of (skillInputs ?? []).entries()) {
    const name = skill.name.trim();
    const skillPath = skill.path.trim();
    if (skill.type !== "skill" || !name || !skillPath) {
      throw new Error(`Codex skillInputs[${index}] must contain type=skill, name, and path.`);
    }
    if (seenPaths.has(skillPath)) {
      continue;
    }
    seenPaths.add(skillPath);
    input.push({ type: "skill", name, path: skillPath });
  }
  const seenImages = new Set<string>();
  for (const [index, rawPath] of (localImagePaths ?? []).entries()) {
    const imagePath = rawPath.trim();
    if (!imagePath || !path.isAbsolute(imagePath)) {
      throw new Error(`Codex localImagePaths[${index}] must be an absolute path.`);
    }
    if (seenImages.has(imagePath)) continue;
    seenImages.add(imagePath);
    input.push({ type: "localImage", path: imagePath });
  }
  return input;
}

function parseCodexTurnStartResult(value: unknown): CodexTurnStartResult {
  if (!isRecord(value) || !isRecord(value.turn)) {
    throw new Error("Invalid turn/start response: missing turn object.");
  }
  const id = typeof value.turn.id === "string" ? value.turn.id.trim() : "";
  const status = value.turn.status;
  if (!id) {
    throw new Error("Invalid turn/start response: missing turn.id.");
  }
  if (!Array.isArray(value.turn.items)) {
    throw new Error("Invalid turn/start response: turn.items must be an array.");
  }
  if (status !== "completed" && status !== "inProgress" && status !== "failed" && status !== "interrupted") {
    throw new Error("Invalid turn/start response: unknown turn.status.");
  }
  return {
    turn: {
      id,
      items: value.turn.items,
      status,
    },
  };
}

/** Real `turn/completed` params: `{ threadId, turn: { id, status, error? } }`. */
function readCodexTurnFailure(completed: unknown): string | undefined {
  if (!isRecord(completed)) {
    throw new Error("Invalid turn/completed params: expected an object.");
  }
  const turn = isRecord(completed.turn) ? completed.turn : undefined;
  if (!turn) {
    throw new Error("Invalid turn/completed params: missing turn object.");
  }
  const status = typeof turn.status === "string" ? turn.status : undefined;
  if (status !== "completed" && status !== "failed" && status !== "interrupted") {
    throw new Error("Invalid turn/completed params: turn.status is not terminal.");
  }
  if (status !== "failed" && status !== "interrupted") {
    return undefined;
  }
  const error = isRecord(turn.error) ? turn.error : undefined;
  const message =
    error && typeof error.message === "string" && error.message.trim() ? error.message.trim() : undefined;
  const details =
    error && typeof error.additionalDetails === "string" && error.additionalDetails.trim()
      ? error.additionalDetails.trim()
      : undefined;
  if (message && details) {
    return `${message}: ${details}`;
  }
  return message ?? `Codex turn ${status}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Ignore child-thread or unrelated turn terminal events while waiting for the parent turn. */
function matchesTurnCompleted(params: unknown, expected: { threadId: string; turnId: string }): boolean {
  if (!isRecord(params)) {
    return false;
  }
  const turn = isRecord(params.turn) ? params.turn : undefined;
  const eventTurnId = typeof turn?.id === "string" ? turn.id.trim() : "";
  const eventThreadId = typeof params.threadId === "string" ? params.threadId.trim() : "";
  return eventThreadId === expected.threadId && eventTurnId === expected.turnId;
}

/**
 * Wait for `turn/completed`. On AbortSignal, send `turn/interrupt` for the active turn
 * before rejecting — interrupt failure is explicit (CodexTurnInterruptFailed), not silent.
 * Abort before an active turn exists is handled by the caller (no interrupt RPC).
 */
interface TurnCompletionObserver {
  wait(input: { turnId: string; signal: AbortSignal }): Promise<unknown>;
  dispose(): void;
}

/** Register before `turn/start` so response + terminal notifications in one chunk cannot race. */
function observeTurnCompletions(client: CodexAppServerClient, threadId: string): TurnCompletionObserver {
  const bufferedByTurnId = new Map<string, unknown>();
  let bufferedProtocolError: Error | undefined;
  let waiter:
    | {
        turnId: string;
        signal: AbortSignal;
        onAbort: () => void;
        resolve: (params: unknown) => void;
        reject: (error: unknown) => void;
        settling: boolean;
      }
    | undefined;
  let disposed = false;

  const remove = client.addNotificationHandler((notificationMethod, params) => {
    if (notificationMethod !== "turn/completed") {
      return;
    }
    const notificationThreadId =
      isRecord(params) && typeof params.threadId === "string" ? params.threadId.trim() : "";
    if (notificationThreadId !== threadId) {
      return;
    }
    const completedTurnId = readTurnCompletedId(params, threadId);
    if (!completedTurnId) {
      const error = new Error(
        `Invalid turn/completed params for thread ${threadId}: expected params.turn.id.`,
      );
      if (!waiter || waiter.settling) {
        bufferedProtocolError = error;
        return;
      }
      waiter.settling = true;
      waiter.signal.removeEventListener("abort", waiter.onAbort);
      const reject = waiter.reject;
      waiter = undefined;
      reject(error);
      return;
    }
    if (!waiter || waiter.turnId !== completedTurnId || waiter.settling) {
      bufferedByTurnId.set(completedTurnId, params);
      return;
    }
    waiter.settling = true;
    waiter.signal.removeEventListener("abort", waiter.onAbort);
    const resolve = waiter.resolve;
    waiter = undefined;
    resolve(params);
  });

  return {
    wait({ turnId, signal }) {
      if (bufferedProtocolError) {
        const error = bufferedProtocolError;
        bufferedProtocolError = undefined;
        return Promise.reject(error);
      }
      const buffered = bufferedByTurnId.get(turnId);
      if (buffered !== undefined) {
        bufferedByTurnId.delete(turnId);
        return Promise.resolve(buffered);
      }
      if (signal.aborted) {
        return interruptActiveTurnThenAbort(client, { threadId, turnId, signal });
      }
      if (disposed) {
        return Promise.reject(new Error("Codex turn completion observer is disposed."));
      }
      if (waiter) {
        return Promise.reject(new Error(`Codex thread ${threadId} already has an active turn waiter.`));
      }

      return new Promise((resolve, reject) => {
        const onAbort = () => {
          if (!waiter || waiter.turnId !== turnId || waiter.settling) {
            return;
          }
          waiter.settling = true;
          void interruptActiveTurnThenAbort(client, { threadId, turnId, signal }).catch((error) => {
            signal.removeEventListener("abort", onAbort);
            waiter = undefined;
            reject(error);
          });
        };
        waiter = { turnId, signal, onAbort, resolve, reject, settling: false };
        signal.addEventListener("abort", onAbort, { once: true });
      });
    },
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      remove();
      bufferedByTurnId.clear();
      bufferedProtocolError = undefined;
      if (waiter) {
        waiter.signal.removeEventListener("abort", waiter.onAbort);
        const reject = waiter.reject;
        waiter = undefined;
        reject(new Error("Codex turn completion observer was disposed before completion."));
      }
    },
  };
}

function readTurnCompletedId(params: unknown, expectedThreadId: string): string | undefined {
  if (!isRecord(params)) {
    return undefined;
  }
  const turn = isRecord(params.turn) ? params.turn : undefined;
  const turnId = typeof turn?.id === "string" ? turn.id.trim() : "";
  return turnId && matchesTurnCompleted(params, { threadId: expectedThreadId, turnId }) ? turnId : undefined;
}

async function interruptActiveTurnThenAbort(
  client: CodexAppServerClient,
  input: { threadId: string; turnId: string; signal: AbortSignal },
): Promise<never> {
  // interruptCodexTurn throws CodexTurnInterruptFailed on RPC failure — do not swallow.
  await interruptCodexTurn(client, {
    threadId: input.threadId,
    turnId: input.turnId,
  });
  throw input.signal.reason ?? new Error("aborted");
}
