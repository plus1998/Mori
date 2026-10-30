import { createHash } from "node:crypto";
import type {
  CodexTurnTokenUsageBreakdown as Tokens,
  CodexTurnTokenUsageSnapshot,
  ParsedUsage,
} from "@eco/runtime";
import {
  buildCodexAppServerBillingRequests,
  normalizeCodexAppServerUsage,
} from "./codex-app-server-usage-billing";
import type { UsageLedgerEvent } from "./usage-ledger";

const KEYS = [
  "inputTokens",
  "cachedInputTokens",
  "outputTokens",
  "reasoningOutputTokens",
  "totalTokens",
] as const;
const CHECKPOINT = "codexUsageCheckpoint";

export interface CodexLiveUsageInput {
  codexThreadId: string;
  turnId: string;
  appServerTokenUsage: Tokens;
  appServerTokenUsageRequests?: readonly Tokens[];
  appServerTokenUsageSnapshot?: CodexTurnTokenUsageSnapshot;
}

export interface CodexLiveUsageRequest {
  usage: ParsedUsage;
  requestKey: string;
  codexUsageIsAggregate: boolean;
  metadata?: Record<string, unknown>;
}

interface Services {
  listEvents(): readonly UsageLedgerEvent[];
  bill(request: CodexLiveUsageRequest): Promise<unknown>;
}

/** Serialize each native turn; the ledger row is also its durable checkpoint.
 * No separate cursor can advance past a failed or partially completed write.
 */
export class CodexLiveUsageBilling {
  private readonly pending = new Map<string, Promise<void>>();

  enqueue(input: CodexLiveUsageInput, services: Services): Promise<void> {
    const key = JSON.stringify([input.codexThreadId, input.turnId]);
    const task = (this.pending.get(key) ?? Promise.resolve())
      // The failed caller still receives its rejection; allow the next snapshot to retry.
      .catch(() => {})
      .then(() => billSnapshot(input, services));
    this.pending.set(key, task);
    const clear = () => {
      if (this.pending.get(key) === task) this.pending.delete(key);
    };
    void task.then(clear, clear);
    return task;
  }
}

async function billSnapshot(input: CodexLiveUsageInput, services: Services): Promise<void> {
  const prefix = `codex-turn-usage:${input.codexThreadId}:${input.turnId}`;
  const events = services
    .listEvents()
    .filter(
      (event) =>
        event.source === "codex" &&
        event.usageKind === "request_final" &&
        (event.requestKey === prefix || event.requestKey?.startsWith(`${prefix}:`)),
    );
  const snapshot = input.appServerTokenUsageSnapshot;
  // Compatibility with older terminal events. Never stack an aggregate over
  // already persisted live deltas when its native checkpoint is unavailable.
  if (!snapshot) {
    const current = normalizeCodexAppServerUsage(input.appServerTokenUsage);
    if (events.length) {
      const keys = [
        "inputTokens",
        "outputTokens",
        "cacheReadTokens",
        "cacheCreationTokens",
        "reasoningTokens",
      ] as const;
      if (
        keys.every((key) => events.reduce((sum, event) => sum + (event[key] ?? 0), 0) === (current[key] ?? 0))
      )
        return;
      throw new Error("Codex terminal usage cannot reconcile without its native checkpoint.");
    }
    for (const request of buildCodexAppServerBillingRequests({
      usage: input.appServerTokenUsage,
      ...(input.appServerTokenUsageRequests && { requests: input.appServerTokenUsageRequests }),
      requestKey: prefix,
    })) {
      await services.bill(request);
    }
    return;
  }
  validate(snapshot.total);
  validate(snapshot.last);
  const identity = (total: Tokens) =>
    `${prefix}:usage:${createHash("sha256")
      .update(JSON.stringify(KEYS.map((key) => total[key])))
      .digest("hex")
      .slice(0, 32)}`;
  // Includes historical replay and the repeated terminal notification, even
  // after a process restart or after newer checkpoints were committed.
  if (events.some((event) => event.requestKey === identity(snapshot.total))) return;
  if (events.some((event) => !event.metadata?.[CHECKPOINT])) {
    throw new Error("Codex live usage overlaps legacy terminal billing without a checkpoint.");
  }
  const checkpoints = events.map((event) => {
    const checkpoint = event.metadata?.[CHECKPOINT] as { sequence: number; threadTotal: Tokens };
    if (!checkpoint || !Number.isSafeInteger(checkpoint.sequence) || checkpoint.sequence < 1) {
      throw new Error("Invalid persisted Codex usage checkpoint.");
    }
    validate(checkpoint.threadTotal);
    return checkpoint;
  });
  const previous = checkpoints.reduce<(typeof checkpoints)[number] | undefined>(
    (latest, checkpoint) => (!latest || checkpoint.sequence > latest.sequence ? checkpoint : latest),
    undefined,
  );
  const delta = previous
    ? KEYS.every((key) => snapshot.total[key] >= previous.threadTotal[key])
      ? subtract(snapshot.total, previous.threadTotal)
      : snapshot.last // Native totals reset after compaction; never charge the historical total.
    : input.appServerTokenUsage;
  validate(delta);
  if (!KEYS.some((key) => delta[key] > 0)) return;

  const chunks = partition(delta, input.appServerTokenUsageRequests, snapshot.last);
  let remaining = delta;
  let sequence = previous?.sequence ?? 0;
  for (const chunk of chunks) {
    remaining = subtract(remaining, chunk.usage);
    const threadTotal = subtract(snapshot.total, remaining);
    validate(threadTotal);
    const requestKey = identity(threadTotal);
    await services.bill({
      usage: normalizeCodexAppServerUsage(chunk.usage),
      requestKey,
      codexUsageIsAggregate: chunk.aggregate,
      metadata: { [CHECKPOINT]: { sequence: ++sequence, threadTotal } },
    });
    // The existing billing effects report write failures. Do not silently treat
    // one as success: the next observation/completion must retry the same delta.
    if (!services.listEvents().some((event) => event.source === "codex" && event.requestKey === requestKey)) {
      throw new Error(`Codex usage checkpoint was not persisted: ${requestKey}`);
    }
  }
}

function partition(
  delta: Tokens,
  requests: readonly Tokens[] | undefined,
  last: Tokens,
): Array<{ usage: Tokens; aggregate: boolean }> {
  let remainder = delta;
  const suffix: Tokens[] = [];
  for (const request of [...(requests ?? [])].reverse()) {
    if (!KEYS.every((key) => request[key] <= remainder[key])) break;
    suffix.unshift(request);
    remainder = subtract(remainder, request);
    if (KEYS.every((key) => remainder[key] === 0))
      return suffix.map((usage) => ({ usage, aggregate: false }));
  }
  return [{ usage: delta, aggregate: !KEYS.every((key) => delta[key] === last[key]) }];
}

function subtract(left: Tokens, right: Tokens): Tokens {
  return Object.fromEntries(KEYS.map((key) => [key, left[key] - right[key]])) as unknown as Tokens;
}

function validate(tokens: Tokens) {
  if (!tokens || KEYS.some((key) => !Number.isSafeInteger(tokens[key]) || tokens[key] < 0)) {
    throw new Error("Invalid Codex usage checkpoint token counts.");
  }
  normalizeCodexAppServerUsage(tokens);
}
