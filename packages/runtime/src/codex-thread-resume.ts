import { setTimeout as delay } from "node:timers/promises";
import type { CodexAppServerClient } from "./codex-app-server-client.js";
import {
  fingerprintCodexThreadConfig,
  forgetAppliedCodexThreadConfig,
  getAppliedCodexThreadConfigFingerprint,
} from "./codex-thread-config-fingerprint.js";

export const CODEX_RESUME_METHOD = "thread/resume";
export const CODEX_THREAD_READ_METHOD = "thread/read";

export interface CodexThreadResumeInput {
  threadId: string;
  cwd?: string;
  model?: string;
  modelProvider?: string;
  /** Additional thread-level developer instructions, separate from collaboration mode. */
  developerInstructions?: string;
  /** Official thread/resume config layer; reapplies thread/actor MCP policy. */
  config?: Record<string, unknown>;
  /** Same app-server client already created this thread with the exact config. */
  configAlreadyApplied?: boolean;
  /** Emits sanitized config/status evidence without changing resume behavior. */
  onDiagnostic?: (diagnostic: CodexResumeDiagnostic) => void;
  signal?: AbortSignal;
  /** Bound the per-thread unload; never restart the shared app-server. */
  configReloadTimeoutMs?: number;
}

export interface CodexThreadResumeParams {
  threadId: string;
  cwd?: string;
  model?: string;
  modelProvider?: string;
  developerInstructions?: string;
  config?: Record<string, unknown>;
}

export interface CodexThreadResumeResult {
  model?: string;
  modelProvider?: string;
  thread: {
    id: string;
    status?: CodexThreadStatusPayload;
    parentThreadId?: string | null;
    agentRole?: string | null;
    turns?: unknown[];
  };
}

export interface CodexThreadReadParams {
  threadId: string;
  includeTurns?: boolean;
}

export interface CodexThreadReadResult {
  thread: {
    id: string;
    status?: CodexThreadStatusPayload;
    modelProvider?: string;
  };
}

/** App-server `ThreadStatus` (tag = type). */
export type CodexThreadStatusPayload =
  | { type: "notLoaded" }
  | { type: "idle" }
  | { type: "systemError" }
  | { type: "active"; activeFlags?: string[] };

export type CodexThreadStatusKind = "notLoaded" | "idle" | "systemError" | "active" | "unknown";

export interface CodexThreadStatusSnapshot {
  kind: CodexThreadStatusKind;
  payload: unknown;
  modelProvider?: string;
}

export interface CodexResumeDiagnostic {
  threadId: string;
  clientInstanceId?: number;
  clientGeneration?: number;
  previousConfigFingerprint?: string;
  nextConfigFingerprint: string;
  configAlreadyApplied: boolean;
  status?: CodexThreadStatusKind;
  activeFlags?: string[];
  decision:
    | "read_failed"
    | "omit_known_config"
    | "resume_cold_with_config"
    | "reload_loaded_config"
    | "reject_loaded_config"
    | "reload_failed";
  error?: string;
}

export interface CodexResumeNotAvailableOptions {
  nextAction: string;
  cause?: unknown;
}

export class CodexResumeNotAvailable extends Error {
  readonly code = "CodexResumeNotAvailable";
  readonly nextAction: string;

  constructor(message: string, options: CodexResumeNotAvailableOptions) {
    super(`${message} Next action: ${options.nextAction}`, { cause: options.cause });
    this.name = "CodexResumeNotAvailable";
    this.nextAction = options.nextAction;
  }
}

export function buildCodexThreadResumeParams(input: CodexThreadResumeInput): CodexThreadResumeParams {
  const threadId = input.threadId.trim();
  if (!threadId) {
    throw new CodexResumeNotAvailable("Codex resume requires a thread id.", {
      nextAction: "Persist a Codex thread id via eco_thread_codex_map / attribution, then retry resume.",
    });
  }
  const params: CodexThreadResumeParams = { threadId };
  const cwd = input.cwd?.trim();
  const model = input.model?.trim();
  const modelProvider = input.modelProvider?.trim();
  const developerInstructions = input.developerInstructions?.trim();
  if (cwd) {
    params.cwd = cwd;
  }
  if (model) {
    params.model = model;
  }
  if (modelProvider) {
    params.modelProvider = modelProvider;
  }
  if (developerInstructions) {
    params.developerInstructions = developerInstructions;
  }
  if (input.config) {
    params.config = input.config;
  }
  return params;
}

export async function resumeCodexThread(
  client: Pick<CodexAppServerClient, "request">,
  input: CodexThreadResumeInput,
): Promise<CodexThreadResumeResult> {
  const params = buildCodexThreadResumeParams(input);
  input.signal?.throwIfAborted();
  let reloaded = false;
  if (params.config) {
    const clientIdentity = readClientDiagnosticIdentity(client);
    const nextConfigFingerprint = fingerprintCodexThreadConfig(params.config);
    const previousConfigFingerprint = getAppliedCodexThreadConfigFingerprint(client, params.threadId);
    const hasConfigProof =
      input.configAlreadyApplied === true && previousConfigFingerprint === nextConfigFingerprint;
    let snapshot: CodexThreadStatusSnapshot;
    try {
      snapshot = await readCodexThreadStatusSnapshot(client, params.threadId);
    } catch (error) {
      emitResumeDiagnostic(input.onDiagnostic, {
        threadId: params.threadId,
        ...clientIdentity,
        ...(previousConfigFingerprint ? { previousConfigFingerprint } : {}),
        nextConfigFingerprint,
        configAlreadyApplied: hasConfigProof,
        decision: "read_failed",
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    const activeFlags = readActiveFlags(snapshot.payload);
    // turn/start can change the model, but cannot switch the loaded provider.
    const providerChanged =
      params.modelProvider !== undefined && params.modelProvider !== snapshot.modelProvider;
    const configAlreadyApplied = hasConfigProof && !providerChanged;
    // A failed turn is terminal. Its loaded thread can reuse the exact config already owned by this client.
    const canReuseLoadedConfig = snapshot.kind === "idle" || snapshot.kind === "systemError";
    if (canReuseLoadedConfig && configAlreadyApplied) {
      emitResumeDiagnostic(input.onDiagnostic, {
        threadId: params.threadId,
        ...clientIdentity,
        ...(previousConfigFingerprint ? { previousConfigFingerprint } : {}),
        nextConfigFingerprint,
        configAlreadyApplied,
        status: snapshot.kind,
        ...(activeFlags ? { activeFlags } : {}),
        decision: "omit_known_config",
      });
      delete params.config;
    } else {
      const canUnload = snapshot.kind === "idle" || snapshot.kind === "systemError";
      const decision =
        snapshot.kind === "notLoaded"
          ? "resume_cold_with_config"
          : canUnload
            ? "reload_loaded_config"
            : "reject_loaded_config";
      emitResumeDiagnostic(input.onDiagnostic, {
        threadId: params.threadId,
        ...clientIdentity,
        ...(previousConfigFingerprint ? { previousConfigFingerprint } : {}),
        nextConfigFingerprint,
        configAlreadyApplied,
        status: snapshot.kind,
        ...(activeFlags ? { activeFlags } : {}),
        decision,
      });
      if (canUnload) {
        try {
          await unloadCodexThreadForConfigReload(client, params.threadId, snapshot.kind, input);
          reloaded = true;
        } catch (error) {
          emitResumeDiagnostic(input.onDiagnostic, {
            threadId: params.threadId,
            ...clientIdentity,
            ...(previousConfigFingerprint ? { previousConfigFingerprint } : {}),
            nextConfigFingerprint,
            configAlreadyApplied,
            status: snapshot.kind,
            decision: "reload_failed",
            error: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }
      } else {
        requireColdCodexThreadForConfigReload(params.threadId, snapshot.kind);
      }
    }
  }
  try {
    input.signal?.throwIfAborted();
    if (params.config) forgetAppliedCodexThreadConfig(client, params.threadId);
    const result = await client.request<CodexThreadResumeResult>(CODEX_RESUME_METHOD, params);
    if (
      reloaded &&
      (result.thread.id !== params.threadId ||
        (params.modelProvider !== undefined && result.modelProvider !== params.modelProvider) ||
        (params.model !== undefined && result.model !== params.model))
    ) {
      throw new CodexResumeNotAvailable("Codex 恢复结果与所选会话或模型配置不一致，已停止继续执行。", {
        nextAction: "请重试以重新加载所选配置；原会话历史保持不变。",
      });
    }
    return result;
  } catch (error) {
    throw mapCodexResumeFailure(params.threadId, error);
  }
}

/**
 * Codex 0.151+ indexes zero-turn threads without a rollout file (#42099).
 * Surface that as CodexResumeNotAvailable instead of a raw RPC error.
 */
export function isCodexZeroTurnRolloutMissingError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /no rollout found for thread id/i.test(message);
}

export function mapCodexResumeFailure(threadId: string, error: unknown): Error {
  if (isCodexZeroTurnRolloutMissingError(error)) {
    return new CodexResumeNotAvailable(
      `Codex resume failed because thread '${threadId}' has no durable rollout (often a zero-turn thread after thread/start).`,
      {
        nextAction:
          "Clear the stale eco↔codex mapping, start a fresh Codex thread with thread/start, run at least one turn, then retry resume.",
        cause: error,
      },
    );
  }
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Unsubscribe only this terminal thread, then verify notLoaded. An unsubscribe
 * acknowledgement alone is not proof: Codex can report success after shutdown
 * times out, leaving the old configuration loaded.
 */
export async function prepareLoadedCodexThreadForConfigReload(
  client: Pick<CodexAppServerClient, "request">,
  threadId: string,
  options: { signal?: AbortSignal; configReloadTimeoutMs?: number } = {},
): Promise<"notLoaded"> {
  const status = await readCodexThreadStatus(client, threadId);
  return unloadCodexThreadForConfigReload(client, threadId, status, options);
}

async function unloadCodexThreadForConfigReload(
  client: Pick<CodexAppServerClient, "request">,
  threadId: string,
  status: CodexThreadStatusKind,
  options: { signal?: AbortSignal; configReloadTimeoutMs?: number },
): Promise<"notLoaded"> {
  if (status === "notLoaded") return status;
  if (status !== "idle" && status !== "systemError") {
    return requireColdCodexThreadForConfigReload(threadId, status);
  }
  const timeoutMs = options.configReloadTimeoutMs ?? 15_000;
  const deadline = Date.now() + timeoutMs;
  try {
    options.signal?.throwIfAborted();
    // A timed-out unsubscribe may still unload the thread. Retire its old proof
    // before the RPC so a later retry cannot reuse it after a partial reload.
    forgetAppliedCodexThreadConfig(client, threadId);
    const result = await client.request<{ status: string }>(
      "thread/unsubscribe",
      { threadId },
      { timeoutMs },
    );
    if (
      result.status !== "unsubscribed" &&
      result.status !== "notLoaded" &&
      result.status !== "notSubscribed"
    ) {
      throw new Error(`thread/unsubscribe returned ${result.status}`);
    }
    do {
      options.signal?.throwIfAborted();
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const read = await client.request<CodexThreadReadResult>(
        CODEX_THREAD_READ_METHOD,
        {
          threadId,
          includeTurns: false,
        },
        { timeoutMs: remaining },
      );
      const current = parseCodexThreadStatus(read.thread?.status);
      if (current === "notLoaded") return current;
      if (current !== "idle" && current !== "systemError") {
        throw new Error(`thread became ${current} while unloading`);
      }
      await delay(Math.min(50, Math.max(0, deadline - Date.now())), undefined, { signal: options.signal });
    } while (Date.now() < deadline);
    throw new Error(`thread did not become notLoaded within ${timeoutMs}ms`);
  } catch (error) {
    options.signal?.throwIfAborted();
    throw new CodexResumeNotAvailable(
      `无法卸载 Codex 会话以切换模型：${error instanceof Error ? error.message : String(error)}`,
      {
        nextAction: "请等待当前会话释放后重试；尚未使用新配置继续执行。",
        cause: error,
      },
    );
  }
}

function requireColdCodexThreadForConfigReload(threadId: string, status: CodexThreadStatusKind): "notLoaded" {
  if (status === "notLoaded") {
    return "notLoaded";
  }
  throw new CodexResumeNotAvailable(
    `Codex cannot prove resume config reload while thread '${threadId}' is ${status}.`,
    {
      nextAction:
        "Keep this loaded thread's static configuration, or apply the changed configuration to a new thread.",
    },
  );
}

export async function readCodexThreadStatus(
  client: Pick<CodexAppServerClient, "request">,
  threadId: string,
): Promise<CodexThreadStatusKind> {
  return (await readCodexThreadStatusSnapshot(client, threadId)).kind;
}

export async function readCodexThreadStatusSnapshot(
  client: Pick<CodexAppServerClient, "request">,
  threadId: string,
): Promise<CodexThreadStatusSnapshot> {
  const trimmed = threadId.trim();
  if (!trimmed) {
    throw new CodexResumeNotAvailable("Codex thread status requires a thread id.", {
      nextAction: "Pass a persisted Codex thread id from eco_thread_codex_map.",
    });
  }
  const result = await client.request<CodexThreadReadResult>(CODEX_THREAD_READ_METHOD, {
    threadId: trimmed,
    includeTurns: false,
  } satisfies CodexThreadReadParams);
  const payload = result.thread?.status;
  return {
    kind: parseCodexThreadStatus(payload),
    payload,
    ...(result.thread?.modelProvider ? { modelProvider: result.thread.modelProvider } : {}),
  };
}

export function parseCodexThreadStatus(status: unknown): CodexThreadStatusKind {
  if (!isRecord(status) || typeof status.type !== "string") {
    return "unknown";
  }
  switch (status.type) {
    case "notLoaded":
    case "idle":
    case "systemError":
    case "active":
      return status.type;
    default:
      return "unknown";
  }
}

/** Terminal statuses: no in-flight turn Eco can reattach to. */
export function isCodexThreadStatusTerminal(kind: CodexThreadStatusKind): boolean {
  return kind === "idle" || kind === "systemError" || kind === "notLoaded" || kind === "unknown";
}

/**
 * Subagent agentId is the Codex child thread id (spawn / thread/started).
 * Resume requires a persisted attribution record — never invent a new thread.
 */
export function requireCodexSubagentThreadId(
  getThreadAttribution: (
    codexThreadId: string,
  ) => { parentThreadId: string; agentRole?: string | undefined } | undefined,
  agentId: string,
): string {
  const codexThreadId = agentId.trim();
  if (!codexThreadId) {
    throw new CodexResumeNotAvailable(
      "Codex subagent resume is not available because the agent id is missing.",
      {
        nextAction: "Resume from a subagent that has a persisted Codex child thread id.",
      },
    );
  }
  const attribution = getThreadAttribution(codexThreadId);
  if (!attribution?.parentThreadId?.trim() || !attribution.agentRole?.trim()) {
    throw new CodexResumeNotAvailable(
      "Codex subagent resume is not available because this agent has no Codex thread attribution mapping.",
      {
        nextAction:
          "Spawn the subagent once so Eco can persist codex_thread_attribution, then retry resume against the same agent id.",
      },
    );
  }
  return codexThreadId;
}

/**
 * Follow-up prompt for a resumed subagent thread (Codex multi-agent followup_task boundary).
 * Does not use Claude-style "Resume agent {id}" tool text.
 */
export function buildCodexSubagentFollowupPrompt(_agentId: string, task: string): string {
  const trimmedTask = task.trim() || "Continue the previous task from where you left off.";
  return trimmedTask;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readActiveFlags(payload: unknown): string[] | undefined {
  if (!isRecord(payload) || !Array.isArray(payload.activeFlags)) {
    return undefined;
  }
  return payload.activeFlags.filter((value): value is string => typeof value === "string");
}

function readClientDiagnosticIdentity(client: object): {
  clientInstanceId?: number;
  clientGeneration?: number;
} {
  const candidate = client as {
    diagnosticInstanceId?: unknown;
    diagnosticGeneration?: unknown;
  };
  return {
    ...(typeof candidate.diagnosticInstanceId === "number"
      ? { clientInstanceId: candidate.diagnosticInstanceId }
      : {}),
    ...(typeof candidate.diagnosticGeneration === "number"
      ? { clientGeneration: candidate.diagnosticGeneration }
      : {}),
  };
}

function emitResumeDiagnostic(
  handler: ((diagnostic: CodexResumeDiagnostic) => void) | undefined,
  diagnostic: CodexResumeDiagnostic,
): void {
  if (!handler) {
    return;
  }
  try {
    handler(diagnostic);
  } catch {
    // Diagnostics must never change resume behavior.
  }
}
