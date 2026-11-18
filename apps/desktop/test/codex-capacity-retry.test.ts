import { describe, expect, it } from "bun:test";
import { hasCodexCapacityFailure, latestCodexCapacityRetryNotice } from "../src/shared/codex-capacity-retry";
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

describe("latestCodexCapacityRetryNotice", () => {
  it("uses the newest scheduled capacity row and preserves a valid deadline", () => {
    expect(
      latestCodexCapacityRetryNotice(
        [
          item({
            id: "old",
            eventType: "request.retry_scheduled",
            metadata: { retryAt: "2026-11-16T00:05:00.000Z" },
          }),
          item({
            id: "new",
            sequence: 2,
            eventType: "request.retry_scheduled",
            metadata: { retryAt: "2026-11-16T00:10:00.000Z" },
          }),
        ],
        "attempt-1",
      ),
    ).toEqual({
      id: "new",
      runAttemptId: "attempt-1",
      retryAt: "2026-11-16T00:10:00.000Z",
    });
  });

  it("does not use a scheduled row from another attempt", () => {
    expect(
      latestCodexCapacityRetryNotice(
        [item({ eventType: "request.retry_scheduled", runAttemptId: "old-attempt" })],
        "attempt-1",
      ),
    ).toBeUndefined();
  });
});
