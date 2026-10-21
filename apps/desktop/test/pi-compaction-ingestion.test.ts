import { expect, test } from "bun:test";
import type { AgentEvent } from "@eco/runtime";
import { isPiCompactionEvent, piCompactionStatusInput } from "../src/main/sdk-stream-activity-ingestion";

function piEvent(type: AgentEvent["type"], payload: unknown): AgentEvent {
  return {
    id: `thr_pi:pi:1:${type}`,
    threadId: "thr_pi",
    agentId: "sess_1",
    role: "main",
    type,
    timestamp: "2026-01-01T00:00:00.000Z",
    payload,
  };
}

test("isPiCompactionEvent recognizes only compaction lifecycle types", () => {
  expect(isPiCompactionEvent(piEvent("context.compaction.started", {}))).toBe(true);
  expect(isPiCompactionEvent(piEvent("context.compaction.completed", {}))).toBe(true);
  expect(isPiCompactionEvent(piEvent("context.compaction.failed", {}))).toBe(true);
  expect(isPiCompactionEvent(piEvent("message.delta", {}))).toBe(false);
  expect(isPiCompactionEvent(piEvent("usage.recorded", {}))).toBe(false);
});

test("piCompactionStatusInput maps started without tokens", () => {
  expect(
    piCompactionStatusInput(
      piEvent("context.compaction.started", { source: "pi", sessionId: "sess_1", reason: "threshold" }),
    ),
  ).toEqual({ stage: "started", trigger: "auto" });
});

test("piCompactionStatusInput maps completed with token delta detail", () => {
  expect(
    piCompactionStatusInput(
      piEvent("context.compaction.completed", {
        source: "pi",
        sessionId: "sess_1",
        reason: "threshold",
        tokensBefore: 180_000,
        estimatedTokensAfter: 42_000,
      }),
    ),
  ).toEqual({
    stage: "completed",
    trigger: "auto",
    preTokens: 180_000,
    postTokens: 42_000,
    detail: "180K → 42.0K",
  });
});

test("piCompactionStatusInput maps failed with error detail", () => {
  expect(
    piCompactionStatusInput(
      piEvent("context.compaction.failed", {
        source: "pi",
        sessionId: "sess_1",
        reason: "overflow",
        message: "summary failed",
      }),
    ),
  ).toEqual({ stage: "failed", trigger: "auto", detail: "summary failed" });
});

test("piCompactionStatusInput tolerates missing payload fields", () => {
  expect(piCompactionStatusInput(piEvent("context.compaction.completed", undefined))).toEqual({
    stage: "completed",
    trigger: "auto",
  });
});
