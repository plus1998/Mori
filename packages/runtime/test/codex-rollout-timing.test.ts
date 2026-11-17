import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readCodexRolloutTurnTiming } from "../src/codex-rollout-timing";

test("reads Codex task_complete timing for the requested turn", () => {
  const rollout = path.join(mkdtempSync(path.join(tmpdir(), "codex-rollout-timing-")), "rollout.jsonl");
  writeFileSync(
    rollout,
    [
      JSON.stringify({
        type: "event_msg",
        payload: {
          type: "task_complete",
          turn_id: "older",
          duration_ms: 9_000,
          time_to_first_token_ms: 1_000,
        },
      }),
      JSON.stringify({
        type: "event_msg",
        payload: {
          type: "task_complete",
          turn_id: "current",
          duration_ms: 23_183,
          time_to_first_token_ms: 17_879,
        },
      }),
    ].join("\n"),
  );

  expect(readCodexRolloutTurnTiming(rollout, "current")).toEqual({
    durationMs: 23_183,
    timeToFirstTokenMs: 17_879,
    generationMs: 5_304,
  });
});

test("ignores missing, incomplete, and invalid rollout timing", () => {
  expect(readCodexRolloutTurnTiming("/does/not/exist", "turn")).toBeUndefined();
  const rollout = path.join(mkdtempSync(path.join(tmpdir(), "codex-rollout-timing-")), "rollout.jsonl");
  writeFileSync(
    rollout,
    JSON.stringify({
      type: "event_msg",
      payload: { type: "task_complete", turn_id: "turn", duration_ms: 10, time_to_first_token_ms: 11 },
    }),
  );
  expect(readCodexRolloutTurnTiming(rollout, "turn")).toBeUndefined();
});
