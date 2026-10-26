import { type CodexAppServerClient, resolveCodexTurnStartTimeoutMs } from "./codex-app-server-client.js";
import { interruptCodexTurn } from "./codex-turn-interrupt.js";
import type { CodexTurnRouteIdentity, CodexTurnRouteRegistry } from "./codex-turn-route-registry.js";

/** Check the native terminal classification, never the translated error message. */
export function codexThreadNeedsContextRecovery(thread: { turns?: unknown[] }): boolean {
  const turn = thread.turns?.at(-1);
  return (
    isRecord(turn) &&
    turn.status === "failed" &&
    isRecord(turn.error) &&
    turn.error.codexErrorInfo === "contextWindowExceeded"
  );
}

/**
 * Recover an already failed thread before submitting new user input. Codex owns
 * summarization and history replacement; Eco neither edits rollouts nor retries
 * business turns. Waiting for terminal success is essential: the RPC only queues it.
 */
export async function compactCodexThreadForRetry(
  client: Pick<CodexAppServerClient, "request" | "addNotificationHandler">,
  input: {
    threadId: string;
    signal: AbortSignal;
    route: CodexTurnRouteIdentity;
    registry?: CodexTurnRouteRegistry;
    timeoutMs?: number;
  },
): Promise<void> {
  input.signal.throwIfAborted();
  const owner = input.registry?.registerPending(input.threadId, input.route);
  let turnId: string | undefined;
  let settling = false;
  let resolveCompleted!: () => void;
  let rejectCompleted!: (error: unknown) => void;
  const completed = new Promise<void>((resolve, reject) => {
    resolveCompleted = resolve;
    rejectCompleted = reject;
  });
  const stop = (reason: unknown) => {
    if (settling) return;
    settling = true;
    if (turnId) {
      void interruptCodexTurn(client, { threadId: input.threadId, turnId }).then(
        () => rejectCompleted(reason),
        rejectCompleted,
      );
    } else {
      rejectCompleted(reason);
    }
  };
  // An abort before turn/started waits for the id so the native operation can be interrupted.
  const onAbort = () => {
    if (turnId) stop(input.signal.reason ?? new Error("Context recovery aborted."));
  };
  const remove = client.addNotificationHandler((method, params) => {
    if (!isRecord(params) || params.threadId !== input.threadId || !isRecord(params.turn)) return;
    const turn = params.turn;
    if (method === "turn/started" && typeof turn.id === "string" && !turnId) {
      turnId = turn.id;
      try {
        if (owner) input.registry?.bindPending(owner, turnId);
      } catch (error) {
        stop(error);
        return;
      }
      if (input.signal.aborted) onAbort();
    }
    if (method !== "turn/completed" || !turnId || turn.id !== turnId || settling) return;
    settling = true;
    if (turn.status === "completed") {
      resolveCompleted();
    } else {
      const error = isRecord(turn.error) ? turn.error : undefined;
      const detail = typeof error?.message === "string" ? error.message : `turn ${String(turn.status)}`;
      const extra = typeof error?.additionalDetails === "string" ? `: ${error.additionalDetails}` : "";
      rejectCompleted(new Error(`Codex 原生上下文压缩失败，未提交新输入：${detail}${extra}`));
    }
  });
  input.signal.addEventListener("abort", onAbort, { once: true });
  const timeoutMs = input.timeoutMs ?? resolveCodexTurnStartTimeoutMs();
  const timer = setTimeout(
    () => stop(new Error(`Codex context recovery timed out after ${timeoutMs}ms.`)),
    timeoutMs,
  );
  try {
    await Promise.all([
      client.request("thread/compact/start", { threadId: input.threadId }, { timeoutMs }),
      completed,
    ]);
  } finally {
    clearTimeout(timer);
    input.signal.removeEventListener("abort", onAbort);
    remove();
    if (owner) input.registry?.clearPending(owner);
    if (turnId) input.registry?.clearTurn(input.threadId, turnId);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
