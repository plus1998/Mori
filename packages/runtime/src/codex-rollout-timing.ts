import fs from "node:fs";

/** Timing persisted by Codex in an `event_msg/task_complete` rollout record. */
export interface CodexRolloutTurnTiming {
  durationMs: number;
  timeToFirstTokenMs: number;
  generationMs: number;
}

// Rollouts can contain a long transcript. The terminal task_complete record is
// appended near the end, so a bounded tail keeps the usage callback cheap.
const MAX_ROLLOUT_TAIL_BYTES = 16 * 1024 * 1024;

/**
 * Read Codex's authoritative turn timing from a rollout JSONL file.
 *
 * Missing or still-being-written files deliberately return undefined: callers
 * can continue using their normal live timing until the next native checkpoint.
 */
export function readCodexRolloutTurnTiming(
  rolloutPath: string | undefined,
  turnId: string | undefined,
): CodexRolloutTurnTiming | undefined {
  const file = rolloutPath?.trim();
  const expectedTurnId = turnId?.trim();
  if (!file || !expectedTurnId) {
    return undefined;
  }

  let descriptor: number | undefined;
  try {
    const stat = fs.statSync(file);
    const start = Math.max(0, stat.size - MAX_ROLLOUT_TAIL_BYTES);
    descriptor = fs.openSync(file, "r");
    const length = stat.size - start;
    const buffer = Buffer.allocUnsafe(length);
    fs.readSync(descriptor, buffer, 0, length, start);
    let text = buffer.toString("utf8");
    if (start > 0) {
      const firstNewline = text.indexOf("\n");
      text = firstNewline === -1 ? "" : text.slice(firstNewline + 1);
    }

    const lines = text.split(/\r?\n/);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index]?.trim();
      if (!line) continue;
      let record: unknown;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isRecord(record) || record.type !== "event_msg" || !isRecord(record.payload)) {
        continue;
      }
      const payload = record.payload;
      if (payload.type !== "task_complete") {
        continue;
      }
      const recordTurnId = readString(payload.turn_id) ?? readString(payload.turnId);
      if (recordTurnId !== expectedTurnId) {
        continue;
      }
      const durationMs = readNonNegativeNumber(payload.duration_ms);
      const timeToFirstTokenMs = readNonNegativeNumber(payload.time_to_first_token_ms);
      if (durationMs === undefined || timeToFirstTokenMs === undefined || timeToFirstTokenMs > durationMs) {
        return undefined;
      }
      return {
        durationMs,
        timeToFirstTokenMs,
        generationMs: durationMs - timeToFirstTokenMs,
      };
    }
  } catch {
    return undefined;
  } finally {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // The file may have disappeared during a concurrent rollout write.
      }
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
