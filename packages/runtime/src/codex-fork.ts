import type { CodexAppServerClient } from "./codex-app-server-client.js";

export const CODEX_FORK_METHOD = "thread/fork";

/** @deprecated Prefer CODEX_FORK_METHOD — production rewind no longer uses thread/rollback. */
export const CODEX_ROLLBACK_METHOD = "thread/rollback";

export interface CodexThreadForkOverrides {
  model?: string;
  modelProvider?: string;
  cwd?: string;
  config?: Record<string, unknown>;
  developerInstructions?: string;
}

export interface CodexThreadForkInput extends CodexThreadForkOverrides {
  threadId: string;
  /** Codex user item id of the turn being rewound (dropped + replayed). */
  itemId: string;
  /** Zero-based Eco user-turn ordinal for Codex versions that rebuild item ids on thread/read. */
  targetTurnIndex?: number;
}

export interface CodexThreadForkParams extends CodexThreadForkOverrides {
  threadId: string;
  lastTurnId: string;
}

export interface CodexThreadForkResult {
  /** Effective settings returned by app-server, never inferred from the source thread. */
  model?: string;
  modelProvider?: string;
  /** When true, drop Eco↔Codex mapping so the next turn uses thread/start. */
  clearMapping: boolean;
  /** Present when fork copied history; absent when clearMapping. */
  thread?: {
    id: string;
    forkedFromId?: string;
  };
  /** Source Codex thread id that was forked or cleared. */
  sourceThreadId: string;
  /** Inclusive last kept turn id (present only for remote fork). */
  lastTurnId?: string;
}

export interface CodexForkNotAvailableOptions {
  nextAction: string;
  cause?: unknown;
}

export class CodexForkNotAvailable extends Error {
  readonly code: string = "CodexForkNotAvailable";
  readonly nextAction: string;

  constructor(message: string, options: CodexForkNotAvailableOptions) {
    super(`${message} Next action: ${options.nextAction}`, { cause: options.cause });
    this.name = "CodexForkNotAvailable";
    this.nextAction = options.nextAction;
  }
}

/** @deprecated Alias of CodexForkNotAvailable for call sites that still import the old name. */
export class CodexRollbackNotAvailable extends CodexForkNotAvailable {
  override readonly code = "CodexRollbackNotAvailable" as const;

  constructor(message: string, options: CodexForkNotAvailableOptions) {
    super(message, options);
    this.name = "CodexRollbackNotAvailable";
  }
}

type CodexTurnReadShape = {
  id?: unknown;
  items?: Array<{ id?: unknown; clientId?: unknown; type?: unknown }>;
};

type CodexThreadReadPage = {
  thread?: {
    cwd?: string;
    turns?: CodexTurnReadShape[];
    turnsBackwardsCursor?: string | null;
    turns_backwards_cursor?: string | null;
  };
};

/** Read all rewind-relevant turns while honoring Codex 0.167 paginated history. */
async function readCodexThreadTurns(
  client: Pick<CodexAppServerClient, "request">,
  threadId: string,
): Promise<{ turns: CodexTurnReadShape[]; cwd?: string }> {
  const first = await client.request<CodexThreadReadPage>("thread/read", {
    threadId,
    includeTurns: true,
  });
  const firstThread = first.thread;
  const turns = [...(firstThread?.turns ?? [])];
  let cursor = firstThread?.turnsBackwardsCursor ?? firstThread?.turns_backwards_cursor ?? null;
  const seen = new Set<string>();
  for (let page = 0; cursor && page < 64; page += 1) {
    if (seen.has(cursor)) {
      throw new CodexForkNotAvailable("Codex thread/read returned a repeated history cursor.", {
        nextAction: "Reload the thread history and retry rewind.",
      });
    }
    seen.add(cursor);
    const next = await client.request<CodexThreadReadPage>("thread/read", {
      threadId,
      includeTurns: true,
      turnsBackwardsCursor: cursor,
    });
    const nextTurns = next.thread?.turns ?? [];
    // A backwards cursor returns older turns; keep chronological order for
    // target-turn lookup and preserve the first page's cwd.
    turns.unshift(...nextTurns);
    cursor = next.thread?.turnsBackwardsCursor ?? next.thread?.turns_backwards_cursor ?? null;
  }
  if (cursor) {
    throw new CodexForkNotAvailable("Codex thread history exceeded the pagination limit.", {
      nextAction: "Select a newer user message and retry rewind.",
    });
  }
  return { turns, ...(firstThread?.cwd ? { cwd: firstThread.cwd } : {}) };
}

/**
 * Locate the zero-based turn index for the user message being rewound.
 * Reuses item id / clientId match, then Eco ordinal fallback when item ids rebuild.
 */
export function resolveCodexRewindTargetTurnIndex(
  turns: readonly CodexTurnReadShape[],
  input: Pick<CodexThreadForkInput, "itemId" | "targetTurnIndex">,
): number {
  const targetItemId = input.itemId.trim();
  let targetTurnIndex = turns.findIndex((turn) =>
    turn.items?.some((item) => isCodexUserMessageItem(item) && codexItemIds(item).includes(targetItemId)),
  );
  const requestedTurnIndex = input.targetTurnIndex;
  if (
    targetTurnIndex < 0 &&
    typeof requestedTurnIndex === "number" &&
    Number.isInteger(requestedTurnIndex) &&
    requestedTurnIndex >= 0
  ) {
    const userTurnIndexes = turns.flatMap((turn, index) =>
      turn.items?.some((item) => isCodexUserMessageItem(item)) ? [index] : [],
    );
    // Prefer exact ordinal; when Eco history is ahead of a rebuilt remote transcript,
    // fall back to the last remote user turn so the newest editable message still rewinds.
    const requested = requestedTurnIndex;
    targetTurnIndex =
      userTurnIndexes[requested] ??
      (requested >= userTurnIndexes.length ? (userTurnIndexes.at(-1) ?? -1) : -1);
  }
  if (targetTurnIndex < 0) {
    const availableUserItems = turns.flatMap((turn) =>
      (turn.items ?? []).filter((item) => isCodexUserMessageItem(item)).flatMap((item) => codexItemIds(item)),
    );
    throw new CodexForkNotAvailable(
      `Codex user item '${targetItemId}' was not found among ${availableUserItems.length} persisted user items.`,
      {
        nextAction:
          availableUserItems.length === 0
            ? "Refresh the activity feed and select a persisted Codex user message."
            : `Remote user item ids sample: ${availableUserItems.slice(0, 3).join(", ")}. Refresh and retry, or restart the session.`,
      },
    );
  }
  return targetTurnIndex;
}

function isCodexUserMessageItem(item: { type?: unknown }): boolean {
  return typeof item.type === "string" && /^user[_-]?message$/i.test(item.type.trim());
}

function codexItemIds(item: { id?: unknown; clientId?: unknown }): string[] {
  const ids: string[] = [];
  for (const key of ["id", "clientId"] as const) {
    const value = item[key];
    if (typeof value === "string" && value.trim()) {
      ids.push(value.trim());
    }
  }
  return ids;
}

export function buildCodexThreadForkParams(
  threadId: string,
  lastTurnId: string,
  overrides: CodexThreadForkOverrides = {},
): CodexThreadForkParams {
  const trimmedThreadId = threadId.trim();
  const trimmedLastTurnId = lastTurnId.trim();
  if (!trimmedThreadId || !trimmedLastTurnId) {
    throw new CodexForkNotAvailable("Codex fork requires a thread id and lastTurnId (last kept turn).", {
      nextAction: "Retry from a Codex-backed user message after reloading turn history with turn ids.",
    });
  }
  return {
    threadId: trimmedThreadId,
    lastTurnId: trimmedLastTurnId,
    ...(overrides.model !== undefined ? { model: overrides.model } : {}),
    ...(overrides.modelProvider !== undefined ? { modelProvider: overrides.modelProvider } : {}),
    ...(overrides.cwd !== undefined ? { cwd: overrides.cwd } : {}),
    ...(overrides.config !== undefined ? { config: overrides.config } : {}),
    ...(overrides.developerInstructions !== undefined
      ? { developerInstructions: overrides.developerInstructions }
      : {}),
  };
}

function readTurnId(turn: CodexTurnReadShape, index: number): string {
  const id = typeof turn.id === "string" ? turn.id.trim() : "";
  if (!id) {
    throw new CodexForkNotAvailable(
      `Codex turn at index ${index} has no stable id; cannot thread/fork with lastTurnId.`,
      {
        nextAction: "Upgrade Codex app-server so thread/read turns include id, then retry rewind.",
      },
    );
  }
  return id;
}

/**
 * Resolve rewind to either a remote `thread/fork` (keep history through the turn
 * *before* the target user message) or `clearMapping` when rewinding the first turn.
 *
 * Semantics match former thread/rollback which dropped the target turn inclusive:
 * lastTurnId = previous turn id; first user turn → no fork, clear Eco mapping + thread/start.
 */
export async function forkCodexThread(
  client: Pick<CodexAppServerClient, "request">,
  input: CodexThreadForkInput,
): Promise<CodexThreadForkResult> {
  const threadId = input.threadId.trim();
  const targetItemId = input.itemId.trim();
  if (!threadId || !targetItemId) {
    throw new CodexForkNotAvailable("Codex fork requires a thread id and target item id.", {
      nextAction: "Retry from a Codex-backed user message that has a persisted item id.",
    });
  }

  const read = await readCodexThreadTurns(client, threadId);
  const turns = read.turns;
  if (!Array.isArray(turns)) {
    throw new CodexForkNotAvailable("Codex thread history is unavailable for fork.", {
      nextAction: "Reload the Codex thread with turn history, then retry rewind.",
    });
  }

  const targetTurnIndex = resolveCodexRewindTargetTurnIndex(turns, {
    itemId: targetItemId,
    ...(input.targetTurnIndex !== undefined ? { targetTurnIndex: input.targetTurnIndex } : {}),
  });

  if (targetTurnIndex === 0) {
    return {
      clearMapping: true,
      sourceThreadId: threadId,
    };
  }

  const lastKeptTurn = turns[targetTurnIndex - 1];
  if (!lastKeptTurn) {
    throw new CodexForkNotAvailable(
      `Codex fork could not resolve the kept turn before index ${targetTurnIndex}.`,
      {
        nextAction: "Refresh the activity feed and select a later Codex user message, then retry.",
      },
    );
  }
  const lastTurnId = readTurnId(lastKeptTurn, targetTurnIndex - 1);
  const forked = await client.request<{
    thread?: { id?: unknown; forkedFromId?: unknown };
    model?: string;
    modelProvider?: string;
  }>(
    CODEX_FORK_METHOD,
    buildCodexThreadForkParams(threadId, lastTurnId, {
      ...input,
      ...(input.cwd === undefined && read.cwd ? { cwd: read.cwd } : {}),
    }),
  );

  const newThreadId = typeof forked.thread?.id === "string" ? forked.thread.id.trim() : "";
  if (!newThreadId) {
    throw new CodexForkNotAvailable("Codex thread/fork returned without a new thread id.", {
      nextAction: "Retry rewind after confirming app-server supports thread/fork with lastTurnId.",
    });
  }
  const forkedFromId =
    typeof forked.thread?.forkedFromId === "string" ? forked.thread.forkedFromId.trim() : undefined;

  return {
    clearMapping: false,
    ...(forked.model !== undefined ? { model: forked.model } : {}),
    ...(forked.modelProvider !== undefined ? { modelProvider: forked.modelProvider } : {}),
    sourceThreadId: threadId,
    lastTurnId,
    thread: {
      id: newThreadId,
      ...(forkedFromId ? { forkedFromId } : {}),
    },
  };
}
