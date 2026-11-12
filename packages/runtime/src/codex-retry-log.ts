export interface CodexRetryLogEntry {
  threadId?: string;
  turnId: string;
  attempt: number;
  maxRetries: number;
  delayMs: number;
  error: string;
}

export interface CodexRetryLogNotice extends CodexRetryLogEntry {
  threadId: string;
}

const RETRY_LOG_TARGET = "codex_core::responses_retry";
const MAX_LOG_LINE_CHARS = 128 * 1024;
const DURATION_UNIT_MS: Record<string, number> = {
  ns: 0.000001,
  µs: 0.001,
  μs: 0.001,
  us: 0.001,
  ms: 1,
  s: 1000,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Codex release builds omit the first WebSocket retry from JSON-RPC, but still log it. */
export function parseCodexRetryLog(line: string): CodexRetryLogEntry | undefined {
  if (!line.includes(RETRY_LOG_TARGET)) return;
  let entry: unknown;
  try {
    entry = JSON.parse(line);
  } catch {
    return;
  }
  if (!isRecord(entry) || entry.target !== RETRY_LOG_TARGET || !isRecord(entry.fields)) return;
  const fields = entry.fields;
  if (fields.retries !== 1 || !Number.isSafeInteger(fields.max_retries) || Number(fields.max_retries) < 1)
    return;
  if (typeof fields.turn_id !== "string" || !fields.turn_id.trim()) return;
  if (typeof fields.sampling_error !== "string" || !fields.sampling_error.trim()) return;
  if (typeof fields.message !== "string") return;
  const match = fields.message.match(
    /^stream disconnected - retrying sampling request \(1\/(\d+) in (\d+(?:\.\d+)?)(ns|µs|μs|us|ms|s)\)\.\.\.$/u,
  );
  if (!match || Number(match[1]) !== fields.max_retries) return;
  const unitMs = match[3] === undefined ? undefined : DURATION_UNIT_MS[match[3]];
  if (unitMs === undefined) return;
  const delayMs = Number(match[2]) * unitMs;
  if (!Number.isFinite(delayMs) || delayMs > Number.MAX_SAFE_INTEGER) return;

  // Resolve from structured span fields, never by scraping an arbitrary error's text.
  const threadIds = new Set<string>();
  const spans = [...(Array.isArray(entry.spans) ? entry.spans : []), entry.span, fields];
  for (const span of spans) {
    if (!isRecord(span)) continue;
    for (const key of ["thread_id", "thread.id"]) {
      const id = span[key];
      if (typeof id === "string" && id.trim()) threadIds.add(id.trim());
    }
  }
  if (threadIds.size > 1) return;
  const [threadId] = threadIds;
  return {
    ...(threadId ? { threadId } : {}),
    turnId: fields.turn_id.trim(),
    attempt: 1,
    maxRetries: Number(fields.max_retries),
    delayMs,
    error: fields.sampling_error.trim(),
  };
}

/** stderr chunks can split JSON anywhere or contain several complete records. */
export class CodexRetryLogDecoder {
  private buffer = "";
  private discarding = false;

  push(chunk: string): CodexRetryLogEntry[] {
    const notices: CodexRetryLogEntry[] = [];
    for (const part of chunk.split(/(?<=\n)/u)) {
      const complete = part.endsWith("\n");
      if (!this.discarding) {
        this.buffer += part;
        if (this.buffer.length > MAX_LOG_LINE_CHARS) this.discarding = true;
      }
      if (complete) {
        if (!this.discarding) {
          const notice = parseCodexRetryLog(this.buffer);
          if (notice) notices.push(notice);
        }
        this.buffer = "";
        this.discarding = false;
      } else if (this.discarding) {
        this.buffer = "";
      }
    }
    return notices;
  }
}

/** Bind log turn ids to native lifecycle events from this exact child process. */
export class CodexRetryLogObserver {
  private readonly decoder = new CodexRetryLogDecoder();
  private readonly threadsByTurn = new Map<string, string>();
  private readonly pendingByTurn = new Map<string, CodexRetryLogEntry>();

  constructor(private readonly onNotice: (notice: CodexRetryLogNotice) => void) {}

  push(chunk: string): void {
    for (const entry of this.decoder.push(chunk)) {
      if (this.threadsByTurn.has(entry.turnId)) {
        this.emit(entry);
      } else {
        // stdout and stderr are independent pipes; the log can arrive before turn/started.
        this.pendingByTurn.set(entry.turnId, entry);
        if (this.pendingByTurn.size > 128) {
          const [oldest] = this.pendingByTurn.keys();
          if (oldest) this.pendingByTurn.delete(oldest);
        }
      }
    }
  }

  observeNotification(method: string, params: unknown): void {
    if (!isRecord(params) || typeof params.threadId !== "string" || !params.threadId.trim()) return;
    const threadId = params.threadId.trim();
    if (method === "thread/closed" || method === "thread/deleted") {
      for (const [turnId, owner] of this.threadsByTurn) {
        if (owner === threadId) {
          this.threadsByTurn.delete(turnId);
          this.pendingByTurn.delete(turnId);
        }
      }
      return;
    }
    if (!isRecord(params.turn) || typeof params.turn.id !== "string" || !params.turn.id.trim()) return;
    const turnId = params.turn.id.trim();
    if (method === "turn/completed") {
      this.threadsByTurn.delete(turnId);
      this.pendingByTurn.delete(turnId);
    } else if (method === "turn/started") {
      this.threadsByTurn.set(turnId, threadId);
      const pending = this.pendingByTurn.get(turnId);
      this.pendingByTurn.delete(turnId);
      if (pending) this.emit(pending);
    }
  }

  private emit(entry: CodexRetryLogEntry): void {
    const threadId = this.threadsByTurn.get(entry.turnId);
    if (!threadId || (entry.threadId && entry.threadId !== threadId)) return;
    this.onNotice({ ...entry, threadId });
  }
}
