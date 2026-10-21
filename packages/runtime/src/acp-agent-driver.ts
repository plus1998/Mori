import type { ChildProcess, SpawnOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import { type AgentEvent, createAgentEvent } from "../../shared/src";
import { AcpClient } from "./acp-client.js";
import {
  cursorAcpSpawnError,
  getCursorAcpDiagnostics,
  killChildProcessTree,
  resolveCursorAgentExecutable,
  spawnCursorAcpProcess,
} from "./acp-cursor-agent.js";
import {
  type AcpEventMapContext,
  mapAcpCursorTask,
  mapAcpCursorUpdateTodos,
  mapAcpSessionUpdate,
} from "./acp-event-map.js";
import { AcpFsHandler } from "./acp-fs.js";
import { AcpJsonRpcPeer } from "./acp-jsonrpc.js";
import type { AcpMcpServer } from "./acp-mcp.js";
import { resolveAcpPermissionSelection } from "./acp-permission.js";
import {
  type AcpPromptImageAttachment,
  agentSupportsImagePrompt,
  buildAcpPromptBlocks,
} from "./acp-prompt.js";
import { isAcpUnstartedProviderFailure } from "./acp-provider-exhaustion.js";
import {
  isAcpSessionModeId,
  parseAcpAvailableModels,
  resolveAcpWireModelId,
  type AcpAvailableModel,
} from "./acp-session-config.js";
import type {
  AcpAskQuestionHandler,
  AcpCreatePlanHandler,
  AcpCreatePlanRequest,
  AcpInitializeResult,
  AcpPermissionHandler,
  AcpSessionModeId,
} from "./acp-types.js";
import type { AcpAgentId } from "./core-runtime.js";

/**
 * After cursor/create_plan is accepted, Cursor often ends the planning turn without
 * executing (HAPI #1097 / Cursor ACP dogfood). Eco must continue in the same session.
 */
export const ACP_PLAN_CONTINUE_PROMPT =
  "The user approved the plan. Implement it now with full Agent tools. Follow the approved plan toward the original request.";

export type AcpAgentRunInput = {
  threadId: string;
  prompt: string;
  workspacePath: string;
  signal?: AbortSignal;
  acpAgentId: AcpAgentId;
  resumeSessionId?: string;
  model?: string;
  sessionMode?: AcpSessionModeId;
  executable?: string;
  /** Extra env for the child (e.g. `{ CURSOR_API_KEY }`); merged over driver options env. */
  env?: NodeJS.ProcessEnv;
  attachments?: readonly AcpPromptImageAttachment[];
  /** Eco MCP servers mapped to ACP `session/new` / `session/load` `mcpServers`. */
  mcpServers?: readonly AcpMcpServer[];
  /** Plan mode: park cursor/create_plan until Eco plan approval resolves. */
  onCreatePlan?: AcpCreatePlanHandler;
  onAskQuestion?: AcpAskQuestionHandler;
  /** Eco host takes over session/request_permission (Zed/ACP: client decides). */
  onRequestPermission?: AcpPermissionHandler;
  /** User prompt context for plan.ready payload. */
  userPromptForPlan?: string;
  /** Override plan→execute continue text (defaults to ACP_PLAN_CONTINUE_PROMPT). */
  planContinuePrompt?: string;
};

export type AcpAgentDriverOptions = {
  executable?: string;
  env?: NodeJS.ProcessEnv;
  spawnFn?: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
};

/** Per-turn hooks bound while `run()` is in flight; cleared when the turn ends. */
type AcpLiveTurn = {
  input: AcpAgentRunInput;
  sessionRunId: string;
  mapCtx: AcpEventMapContext;
  enqueue: (events: AgentEvent[]) => void;
  openToolCalls: number;
  suppressSessionUpdates: boolean;
  planAcceptedThisRun: boolean;
};

type AcpConnection = {
  child: ChildProcess;
  peer: AcpJsonRpcPeer;
  client: AcpClient;
  rl: ReadlineInterface;
  workspacePath: string;
  envFingerprint: string;
  mcpFingerprint: string;
  initializeResult?: AcpInitializeResult;
  availableModels: readonly AcpAvailableModel[];
  sessionId?: string;
  busy: boolean;
  cancelRequested: boolean;
  turn: AcpLiveTurn | null;
  disposing: boolean;
};

function acpFailedTerminalPayload(
  error: string,
  ctx?: Pick<AcpEventMapContext, "agentMessageText" | "turnProgress">,
): { status: "failed"; error: string; unstarted?: boolean } {
  const unstarted = isAcpUnstartedProviderFailure({
    agentText: ctx?.agentMessageText?.value ?? "",
    sawTool: Boolean(ctx?.turnProgress?.tools),
    sawThought: Boolean(ctx?.turnProgress?.thoughts),
  });
  return { status: "failed", error, ...(unstarted ? { unstarted: true } : {}) };
}

function acpStageError(
  stage:
    | "initialize"
    | "session/new"
    | "session/load"
    | "session/set_model"
    | "session/set_mode"
    | "session/prompt",
  error: unknown,
): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`Cursor ACP ${stage} failed: ${message}`, { cause: error });
}

function withCursorProcessDiagnostics(error: unknown, child: ChildProcess): string {
  const message = error instanceof Error ? error.message : String(error);
  const diagnostics = getCursorAcpDiagnostics(child);
  const exit =
    diagnostics.exitCode !== undefined
      ? `exit code ${diagnostics.exitCode}`
      : diagnostics.exitSignal
        ? `exit signal ${diagnostics.exitSignal}`
        : "";
  const details = [exit, diagnostics.stderr ? `stderr: ${diagnostics.stderr}` : ""].filter(Boolean);
  return details.length > 0 ? `${message} (${details.join("; ")})` : message;
}

function fingerprintEnv(env: NodeJS.ProcessEnv | undefined): string {
  if (!env) return "{}";
  const keys = Object.keys(env).sort();
  const normalized: Record<string, string> = {};
  for (const key of keys) {
    const value = env[key];
    if (value !== undefined) {
      normalized[key] = value;
    }
  }
  return JSON.stringify(normalized);
}

function fingerprintMcp(servers: readonly AcpMcpServer[] | undefined): string {
  return JSON.stringify(servers ?? []);
}

function childIsAlive(child: ChildProcess): boolean {
  return !child.killed && child.exitCode == null && child.signalCode == null;
}

/**
 * Spawns Cursor `agent acp`, drives AcpClient over stdio, maps to AgentEvent.
 * Keeps one long-lived process per thread (Zed-style); cancel is soft (session/cancel only).
 */
export class AcpAgentDriver {
  private readonly connections = new Map<string, AcpConnection>();

  constructor(private readonly options: AcpAgentDriverOptions = {}) {}

  async *run(input: AcpAgentRunInput): AsyncGenerator<AgentEvent> {
    if (input.acpAgentId !== "cursor") {
      yield createAgentEvent({
        id: `${input.threadId}:acp:unsupported`,
        threadId: input.threadId,
        agentId: "acp",
        role: "main",
        type: "run.terminal",
        payload: acpFailedTerminalPayload(`Unsupported acpAgentId: ${String(input.acpAgentId)}`),
      });
      return;
    }

    const sessionRunId = randomUUID();
    const sessionMode: AcpSessionModeId = isAcpSessionModeId(input.sessionMode) ? input.sessionMode : "agent";
    const queue: AgentEvent[] = [];
    let wake: (() => void) | undefined;
    let finished = false;
    let connection: AcpConnection | undefined;
    let mapCtx: AcpEventMapContext | undefined;

    const trackToolEvent = (event: AgentEvent): void => {
      const turn = connection?.turn;
      if (!turn) return;
      if (event.type === "tool.started") {
        turn.openToolCalls += 1;
        return;
      }
      if (event.type === "tool.completed" || event.type === "tool.failed") {
        turn.openToolCalls = Math.max(0, turn.openToolCalls - 1);
      }
    };
    const enqueue = (events: AgentEvent[]) => {
      if (events.length === 0) return;
      for (const event of events) {
        trackToolEvent(event);
      }
      queue.push(...events);
      wake?.();
      wake = undefined;
    };

    const isCancelled = () =>
      Boolean(
        input.signal?.aborted ||
          connection?.cancelRequested ||
          this.connections.get(input.threadId)?.cancelRequested,
      );

    const abort = () => {
      void this.cancel(input.threadId);
    };
    input.signal?.addEventListener("abort", abort, { once: true });

    try {
      const requestedModel = input.model?.trim() || undefined;
      const executable = resolveCursorAgentExecutable(
        input.executable?.trim() || this.options.executable?.trim(),
        {
          env: { ...process.env, ...(this.options.env ?? {}), ...(input.env ?? {}) },
        },
      );

      yield createAgentEvent({
        id: `${input.threadId}:acp:${sessionRunId}:agent_start`,
        threadId: input.threadId,
        agentId: sessionRunId,
        role: "main",
        type: "agent.started",
        payload: {
          source: "acp",
          acpAgentId: input.acpAgentId,
          executable,
          sessionMode,
          ...(requestedModel ? { requestedModel } : {}),
        },
      });

      connection = await this.ensureConnection(input, executable);
      if (connection.busy) {
        throw new Error("ACP connection already has an in-flight prompt for this thread");
      }
      connection.busy = true;
      connection.cancelRequested = false;

      mapCtx = {
        threadId: input.threadId,
        agentId: sessionRunId,
        sessionRunId,
        tools: new Map<string, { tool_name: string; input: Record<string, unknown> }>(),
        agentMessageText: { value: "" },
        turnProgress: { tools: false, thoughts: false },
        openSubagents: new Map(),
      };
      connection.turn = {
        input,
        sessionRunId,
        mapCtx,
        enqueue,
        openToolCalls: 0,
        suppressSessionUpdates: false,
        planAcceptedThisRun: false,
      };

      const sessionId = await this.ensureSession(connection, input);
      const availableModels = connection.availableModels;

      yield createAgentEvent({
        id: `${input.threadId}:acp:${sessionRunId}:session`,
        threadId: input.threadId,
        agentId: sessionRunId,
        role: "main",
        type: "session.captured",
        payload: {
          source: "acp",
          acpAgentId: input.acpAgentId,
          sessionId,
          cwd: input.workspacePath,
        },
      });

      if (requestedModel) {
        try {
          const wireModelId = resolveAcpWireModelId(requestedModel, availableModels);
          await connection.client.setModel({ sessionId, modelId: wireModelId });
        } catch (error) {
          throw acpStageError("session/set_model", error);
        }
      }
      try {
        await connection.client.setMode({ sessionId, modeId: sessionMode });
      } catch (error) {
        throw acpStageError("session/set_mode", error);
      }

      const promptWork = (async () => {
        const active = connection!;
        const turn = active.turn!;
        try {
          const prompt = buildAcpPromptBlocks({
            prompt: input.prompt,
            imageSupported: agentSupportsImagePrompt(active.initializeResult ?? {}),
            ...(input.attachments?.length ? { attachments: input.attachments } : {}),
          });
          const result = await active.client.prompt({
            sessionId,
            prompt,
          });
          enqueue(mapAcpSessionUpdate(result, turn.mapCtx));

          // Cursor ACP: accept alone often ends the planning turn with no execution (HAPI #1097).
          // Same-session continue is the standard client handoff — not a Pi/Codex-style new run.
          if (turn.planAcceptedThisRun && !isCancelled()) {
            turn.planAcceptedThisRun = false;
            const continueText = input.planContinuePrompt?.trim() || ACP_PLAN_CONTINUE_PROMPT;
            enqueue([
              createAgentEvent({
                id: `${input.threadId}:acp:${sessionRunId}:plan_continue`,
                threadId: input.threadId,
                agentId: sessionRunId,
                role: "main",
                type: "terminal.output",
                payload: {
                  source: "acp",
                  liveType: "acp.plan_continue",
                  prompt: continueText,
                },
              }),
            ]);
            try {
              await active.client.setMode({ sessionId, modeId: "agent" });
              const continueResult = await active.client.prompt({
                sessionId,
                prompt: buildAcpPromptBlocks({
                  prompt: continueText,
                  imageSupported: agentSupportsImagePrompt(active.initializeResult ?? {}),
                }),
              });
              enqueue(mapAcpSessionUpdate(continueResult, turn.mapCtx));
            } catch (continueError) {
              if (isCancelled()) {
                enqueue([
                  createAgentEvent({
                    id: `${input.threadId}:acp:${sessionRunId}:plan_continue_terminal`,
                    threadId: input.threadId,
                    agentId: sessionRunId,
                    role: "main",
                    type: "run.terminal",
                    payload: { status: "cancelled", reason: "cancelled by user" },
                  }),
                ]);
              } else {
                enqueue([
                  createAgentEvent({
                    id: `${input.threadId}:acp:${sessionRunId}:plan_continue_terminal`,
                    threadId: input.threadId,
                    agentId: sessionRunId,
                    role: "main",
                    type: "run.terminal",
                    payload: acpFailedTerminalPayload(
                      continueError instanceof Error ? continueError.message : String(continueError),
                      turn.mapCtx,
                    ),
                  }),
                ]);
              }
            }
          }
        } catch (error) {
          if (isCancelled()) {
            enqueue([
              createAgentEvent({
                id: `${input.threadId}:acp:${sessionRunId}:terminal`,
                threadId: input.threadId,
                agentId: sessionRunId,
                role: "main",
                type: "run.terminal",
                payload: { status: "cancelled", reason: "cancelled by user" },
              }),
            ]);
          } else {
            const promptError =
              error instanceof Error && error.message.startsWith("Cursor ACP ")
                ? error
                : acpStageError("session/prompt", error);
            enqueue([
              createAgentEvent({
                id: `${input.threadId}:acp:${sessionRunId}:terminal`,
                threadId: input.threadId,
                agentId: sessionRunId,
                role: "main",
                type: "run.terminal",
                payload: acpFailedTerminalPayload(
                  withCursorProcessDiagnostics(promptError, active.child),
                  turn.mapCtx,
                ),
              }),
            ]);
          }
        } finally {
          finished = true;
          wake?.();
          wake = undefined;
        }
      })();

      while (!finished || queue.length > 0) {
        while (queue.length > 0) {
          yield queue.shift()!;
        }
        if (finished) break;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }

      await promptWork;
    } catch (error) {
      const cancelled = isCancelled();
      // ensureConnection may have registered the connection before throwing on soft-cancel.
      connection ??= this.connections.get(input.threadId);
      yield createAgentEvent({
        id: `${input.threadId}:acp:${sessionRunId}:terminal`,
        threadId: input.threadId,
        agentId: sessionRunId,
        role: "main",
        type: "run.terminal",
        payload: cancelled
          ? { status: "cancelled", reason: "cancelled by user" }
          : acpFailedTerminalPayload(
              connection
                ? withCursorProcessDiagnostics(error, connection.child)
                : error instanceof Error
                  ? error.message
                  : String(error),
              mapCtx,
            ),
      });
      // Fatal handshake / session errors: drop the connection so the next run can respawn.
      if (!cancelled && connection) {
        this.dispose(input.threadId);
        connection = undefined;
      }
    } finally {
      input.signal?.removeEventListener("abort", abort);
      if (connection && this.connections.get(input.threadId) === connection) {
        connection.turn = null;
        connection.busy = false;
      }
    }
  }

  /** True when this thread has a live connection with an in-flight prompt turn. */
  hasInFlightTurn(threadId: string): boolean {
    const connection = this.connections.get(threadId);
    return Boolean(connection?.busy && connection.turn);
  }

  /**
   * Soft-cancel the in-flight prompt (session/cancel). Keeps the process alive for reuse.
   * Also rejects pending JSON-RPC requests so Eco can finish the turn as cancelled without
   * waiting on a hung agent (Zed-style cancel + local abort of the prompt await).
   */
  cancel(threadId: string): boolean {
    const connection = this.connections.get(threadId);
    if (!connection) return false;
    connection.cancelRequested = true;
    if (connection.sessionId) {
      try {
        void connection.client.cancel({ sessionId: connection.sessionId });
      } catch {
        // best-effort ACP cancel
      }
    }
    try {
      connection.peer.rejectPending(new Error("ACP turn cancelled"));
    } catch {
      // best-effort
    }
    return true;
  }

  /** Soft-cancel every in-flight turn without killing processes. */
  cancelAll(): number {
    let cancelled = 0;
    for (const threadId of this.connections.keys()) {
      if (this.cancel(threadId)) {
        cancelled += 1;
      }
    }
    return cancelled;
  }

  /** Tear down the long-lived process for a thread (delete thread / fatal / fingerprint miss). */
  dispose(threadId: string): boolean {
    const connection = this.connections.get(threadId);
    if (!connection) return false;
    connection.disposing = true;
    connection.cancelRequested = true;
    connection.turn = null;
    connection.busy = false;
    try {
      connection.peer.dispose();
    } catch {
      // peer may already be disposed on child exit
    }
    try {
      connection.rl.close();
    } catch {
      // readline may already be closed
    }
    try {
      killChildProcessTree(connection.child);
    } catch {
      // best-effort
    }
    this.connections.delete(threadId);
    return true;
  }

  /** Dispose every tracked ACP connection (app quit). */
  disposeAll(): number {
    const threadIds = [...this.connections.keys()];
    let disposed = 0;
    for (const threadId of threadIds) {
      if (this.dispose(threadId)) {
        disposed += 1;
      }
    }
    return disposed;
  }

  private async ensureConnection(input: AcpAgentRunInput, executable: string): Promise<AcpConnection> {
    const env = { ...this.options.env, ...input.env };
    const envFingerprint = fingerprintEnv(env);
    const mcpFingerprint = fingerprintMcp(input.mcpServers);
    const existing = this.connections.get(input.threadId);
    if (
      existing &&
      !existing.disposing &&
      childIsAlive(existing.child) &&
      existing.workspacePath === input.workspacePath &&
      existing.envFingerprint === envFingerprint &&
      existing.mcpFingerprint === mcpFingerprint
    ) {
      return existing;
    }
    if (existing) {
      this.dispose(input.threadId);
    }

    const child = spawnCursorAcpProcess({
      executable,
      cwd: input.workspacePath,
      ...(Object.keys(env).length > 0 ? { env } : {}),
      ...(this.options.spawnFn ? { spawnFn: this.options.spawnFn } : {}),
    });
    const spawnFailure = cursorAcpSpawnError(child);
    if (!child.stdin || !child.stdout) {
      killChildProcessTree(child);
      throw new Error("ACP process requires piped stdin/stdout");
    }

    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    const peer = new AcpJsonRpcPeer({
      write: (line) => {
        child.stdin!.write(line);
      },
      onLine: (cb) => {
        rl.on("line", cb);
      },
    });

    // Placeholder filled after construction so turn handlers close over the live connection.
    const connectionHolder: { current: AcpConnection | null } = { current: null };

    const client = new AcpClient({
      peer,
      clientInfo: { name: "eco", version: "0.0.0" },
      onCreatePlan: async (request) => {
        const conn = connectionHolder.current;
        const turn = conn?.turn;
        if (!turn) {
          return {
            outcome: "rejected" as const,
            reason: "Eco ACP host has no active turn for create_plan",
          };
        }
        turn.enqueue([
          createAgentEvent({
            id: `${turn.input.threadId}:acp:${turn.sessionRunId}:plan_ready:${request.toolCallId}`,
            threadId: turn.input.threadId,
            agentId: turn.sessionRunId,
            role: "main",
            type: "plan.ready",
            payload: buildAcpPlanReadyPayload(request, turn.input),
          }),
        ]);
        if (Array.isArray(request.todos) && request.todos.length > 0) {
          turn.enqueue(
            mapAcpCursorUpdateTodos(
              { toolCallId: request.toolCallId, todos: request.todos, merge: false },
              turn.mapCtx,
            ),
          );
        }
        if (!turn.input.onCreatePlan) {
          return {
            outcome: "rejected" as const,
            reason: "Eco ACP host has no create_plan handler (plan approval not wired)",
          };
        }
        const outcome = await turn.input.onCreatePlan(request);
        if (outcome.outcome === "accepted" && conn?.sessionId) {
          try {
            await conn.client.setMode({ sessionId: conn.sessionId, modeId: "agent" });
            turn.planAcceptedThisRun = true;
          } catch (error) {
            turn.enqueue([
              createAgentEvent({
                id: `${turn.input.threadId}:acp:${turn.sessionRunId}:mode_after_plan`,
                threadId: turn.input.threadId,
                agentId: turn.sessionRunId,
                role: "main",
                type: "terminal.output",
                payload: {
                  source: "acp",
                  liveType: "acp.set_mode_after_plan_failed",
                  error: error instanceof Error ? error.message : String(error),
                },
              }),
            ]);
          }
        }
        return outcome;
      },
      onAskQuestion: async (request) => {
        const turn = connectionHolder.current?.turn;
        if (!turn?.input.onAskQuestion) {
          return { outcome: "skipped" as const, reason: "Eco ACP host has no ask_question handler" };
        }
        return turn.input.onAskQuestion(request);
      },
      onRequestPermission: async (request) => {
        const turn = connectionHolder.current?.turn;
        if (turn?.input.onRequestPermission) {
          return turn.input.onRequestPermission(request);
        }
        const selected = resolveAcpPermissionSelection(request.options, "allow");
        if (selected) return selected;
        throw new Error("ACP session/request_permission had no selectable option");
      },
      fsHandler: new AcpFsHandler(input.workspacePath),
      onTask: (request) => {
        const turn = connectionHolder.current?.turn;
        if (!turn) {
          return {
            outcome: "completed" as const,
            ...(request.agentId ? { agentId: request.agentId } : {}),
            ...(request.durationMs !== undefined ? { durationMs: request.durationMs } : {}),
          };
        }
        const events = mapAcpCursorTask(request, turn.mapCtx);
        turn.enqueue(events);
        const agentStarted = events.find((event) => event.type === "agent.started");
        const agentId = typeof agentStarted?.agentId === "string" ? agentStarted.agentId : undefined;
        return {
          outcome: "completed" as const,
          ...(agentId ? { agentId } : {}),
          ...(request.durationMs !== undefined ? { durationMs: request.durationMs } : {}),
        };
      },
      onUpdateTodos: (request) => {
        const turn = connectionHolder.current?.turn;
        if (turn) {
          turn.enqueue(mapAcpCursorUpdateTodos(request, turn.mapCtx));
        }
        return { outcome: "accepted" as const, todos: request.todos };
      },
      onGenerateImage: (request) => {
        const turn = connectionHolder.current?.turn;
        if (turn) {
          turn.enqueue([
            createAgentEvent({
              id: `${turn.input.threadId}:acp:${turn.sessionRunId}:generate_image:${request.toolCallId}`,
              threadId: turn.input.threadId,
              agentId: turn.sessionRunId,
              role: "main",
              type: "terminal.output",
              payload: {
                source: "acp",
                liveType: "acp.generate_image",
                toolCallId: request.toolCallId,
                ...(request.description ? { description: request.description } : {}),
                ...(request.filePath ? { filePath: request.filePath } : {}),
                ...(request.referenceImagePaths ? { referenceImagePaths: request.referenceImagePaths } : {}),
              },
            }),
          ]);
        }
        return {
          outcome: "rejected" as const,
          reason: "Eco ACP host has no generate_image handler",
        };
      },
    });

    peer.setToolActiveSignal(() => (connectionHolder.current?.turn?.openToolCalls ?? 0) > 0);

    client.onSessionUpdate((params) => {
      const turn = connectionHolder.current?.turn;
      if (!turn || turn.suppressSessionUpdates) return;
      turn.enqueue(mapAcpSessionUpdate(params, turn.mapCtx));
    });

    // Register before handshake so cancel/abort during initialize can soft-cancel.
    const connection: AcpConnection = {
      child,
      peer,
      client,
      rl,
      workspacePath: input.workspacePath,
      envFingerprint,
      mcpFingerprint,
      availableModels: parseAcpAvailableModels(undefined),
      busy: false,
      cancelRequested: false,
      turn: null,
      disposing: false,
    };
    connectionHolder.current = connection;
    this.connections.set(input.threadId, connection);

    child.once("exit", () => {
      if (connection.disposing) return;
      try {
        peer.dispose();
      } catch {
        // ignore
      }
      try {
        rl.close();
      } catch {
        // ignore
      }
      if (this.connections.get(input.threadId) === connection) {
        this.connections.delete(input.threadId);
      }
    });

    let initializeResult: AcpInitializeResult | undefined;
    const handshake = (async () => {
      try {
        initializeResult = await client.initialize();
        client.confInitialized();
      } catch (error) {
        throw acpStageError("initialize", error);
      }
    })();
    try {
      await Promise.race([handshake, spawnFailure]);
    } catch (error) {
      if (connection.cancelRequested || input.signal?.aborted) {
        throw error;
      }
      this.dispose(input.threadId);
      throw error;
    }
    if (!initializeResult) {
      if (connection.cancelRequested || input.signal?.aborted) {
        throw new Error("ACP turn cancelled");
      }
      this.dispose(input.threadId);
      throw acpStageError("initialize", "returned no result");
    }
    if (connection.cancelRequested || input.signal?.aborted) {
      // Soft-cancel during handshake: keep process for reuse, surface cancelled to run().
      throw new Error("ACP turn cancelled");
    }
    connection.initializeResult = initializeResult;

    return connection;
  }

  private async ensureSession(connection: AcpConnection, input: AcpAgentRunInput): Promise<string> {
    const resumeId = input.resumeSessionId?.trim();
    const mcpServers = input.mcpServers ?? [];
    const turn = connection.turn;

    if (connection.sessionId && (!resumeId || resumeId === connection.sessionId)) {
      return connection.sessionId;
    }

    if (resumeId) {
      if (turn) turn.suppressSessionUpdates = true;
      try {
        const loaded = await connection.client.loadSession({
          sessionId: resumeId,
          cwd: input.workspacePath,
          mcpServers,
        });
        connection.availableModels = parseAcpAvailableModels(loaded);
        connection.sessionId = resumeId;
        return resumeId;
      } catch (error) {
        throw acpStageError("session/load", error);
      } finally {
        if (turn) turn.suppressSessionUpdates = false;
      }
    }

    try {
      const created = await connection.client.newSession({
        cwd: input.workspacePath,
        mcpServers,
      });
      connection.availableModels = parseAcpAvailableModels(created);
      connection.sessionId = created.sessionId;
      return created.sessionId;
    } catch (error) {
      throw acpStageError("session/new", error);
    }
  }
}

function buildAcpPlanReadyPayload(
  request: AcpCreatePlanRequest,
  input: AcpAgentRunInput,
): {
  userPrompt: string;
  analysis: string;
  plan: string;
  deferredExitPlanToolUseId: string;
} {
  const overview =
    typeof request.overview === "string" && request.overview.trim()
      ? request.overview.trim()
      : typeof request.name === "string" && request.name.trim()
        ? request.name.trim()
        : "";
  return {
    userPrompt: (input.userPromptForPlan ?? input.prompt).trim() || input.prompt,
    analysis: overview,
    plan: request.plan,
    deferredExitPlanToolUseId: request.toolCallId,
  };
}
