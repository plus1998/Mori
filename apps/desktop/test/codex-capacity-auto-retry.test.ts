import { describe, expect, it, mock } from "bun:test";
import { CodexCapacityAutoRetry } from "../src/renderer/codex-capacity-auto-retry";

function input() {
  return {
    threadId: "thread-1",
    attemptId: "attempt-1",
    threadStatus: "running",
    enabled: true,
    isCodexLogin: true,
    notice: {
      id: "capacity-1",
      runAttemptId: "attempt-1",
      retryAt: new Date(Date.now() + 300_000).toISOString(),
    },
  };
}

describe("CodexCapacityAutoRetry", () => {
  it("sends continue immediately while the native retry deadline is still five minutes away", () => {
    const retry = new CodexCapacityAutoRetry();
    const sendContinue = mock(() => {});
    retry.observe(input(), sendContinue);
    expect(sendContinue).toHaveBeenCalledTimes(1);
  });

  it("does not send the same notice twice on rerender, toggle, or thread switching", () => {
    const retry = new CodexCapacityAutoRetry();
    const sendContinue = mock(() => {});
    const current = input();
    retry.observe(current, sendContinue);
    retry.observe({ ...current, notice: { ...current.notice, retryAt: "2099-01-01T00:00:00Z" } }, sendContinue);
    retry.observe({ ...current, enabled: false }, sendContinue);
    retry.observe({ ...current, threadId: "thread-2", notice: undefined }, sendContinue);
    retry.observe(current, sendContinue);
    expect(sendContinue).toHaveBeenCalledTimes(1);
  });

  it("sends again immediately for a new capacity notice in the same running attempt", () => {
    const retry = new CodexCapacityAutoRetry();
    const sendContinue = mock(() => {});
    const current = input();
    retry.observe(current, sendContinue);
    retry.observe({ ...current, notice: { ...current.notice, id: "capacity-2" } }, sendContinue);
    expect(sendContinue).toHaveBeenCalledTimes(2);
  });

  it("does not send after the turn settles, or before a turn is running", () => {
    for (const threadStatus of ["completed", "failed", "stopped", "idle", "queued"]) {
      const retry = new CodexCapacityAutoRetry();
      const sendContinue = mock(() => {});
      retry.observe({ ...input(), threadStatus }, sendContinue);
      expect(sendContinue).not.toHaveBeenCalled();
    }
  });

  it("requires an enabled Codex Login thread and a notice belonging to the current attempt", () => {
    const retry = new CodexCapacityAutoRetry();
    const sendContinue = mock(() => {});
    const current = input();
    retry.observe({ ...current, enabled: false }, sendContinue);
    retry.observe({ ...current, isCodexLogin: false }, sendContinue);
    retry.observe({ ...current, notice: undefined }, sendContinue);
    retry.observe({ ...current, attemptId: "different-attempt" }, sendContinue);
    expect(sendContinue).not.toHaveBeenCalled();
    retry.observe(current, sendContinue);
    expect(sendContinue).toHaveBeenCalledTimes(1);
  });

  it("keeps sending for new capacity notices after five retries in the same attempt", () => {
    const retry = new CodexCapacityAutoRetry();
    const sendContinue = mock(() => {});
    const current = input();
    for (let index = 1; index <= 10; index++) {
      const notice = { ...current.notice, id: `capacity-${index}` };
      retry.observe({ ...current, notice }, sendContinue);
      retry.observe({ ...current, notice }, sendContinue);
    }
    expect(sendContinue).toHaveBeenCalledTimes(10);
  });

  it("does not automatically resend a notice already retried manually", () => {
    const retry = new CodexCapacityAutoRetry();
    const sendContinue = mock(() => {});
    const current = input();
    retry.markHandled(current.threadId, current.notice);
    retry.observe(current, sendContinue);
    expect(sendContinue).not.toHaveBeenCalled();
  });
});
