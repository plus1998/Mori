import { describe, expect, it } from "bun:test";
import { hasCodexCapacityFailure } from "../src/shared/codex-capacity-retry";
import type { ThreadRunProjectionTimelineItem } from "../src/shared/conversation-v2-projection";

function item(overrides: Partial<ThreadRunProjectionTimelineItem> = {}): ThreadRunProjectionTimelineItem {
  return {
    id: "error-1",
    sequence: 1,
    eventType: "api.error",
    scope: "main",
    runAttemptId: "attempt-1",
    text: "Selected model is at capacity. Please try a different model.",
    at: "2026-11-16T00:00:00.000Z",
    ...overrides,
  };
}

describe("hasCodexCapacityFailure", () => {
  it("matches the current failed Codex attempt only", () => {
    expect(hasCodexCapacityFailure([item()], "attempt-1")).toBe(true);
    expect(hasCodexCapacityFailure([item()], "attempt-2")).toBe(false);
  });

  it("ignores unrelated events and similar wording", () => {
    expect(hasCodexCapacityFailure([item({ eventType: "message.delta" })], "attempt-1")).toBe(false);
    expect(hasCodexCapacityFailure([item({ text: "Try another model." })], "attempt-1")).toBe(false);
  });
});
