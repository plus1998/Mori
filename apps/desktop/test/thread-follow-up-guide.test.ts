import { expect, mock, test } from "bun:test";
import { deliverThreadFollowUpGuide } from "../src/main/thread-follow-up-guide";
import type { ThreadPendingFollowUp } from "../src/shared/ipc";

const queued: ThreadPendingFollowUp = {
  id: "guide", threadId: "thread", prompt: "补充要求", priority: "escalated",
  status: "queued", deliveryMode: "queued", createdAt: "2026-10-28T00:00:00Z",
  updatedAt: "2026-10-28T00:00:00Z",
};

for (const core of ["claude", "codex", "pi"]) {
  for (const skipped of [undefined, queued]) {
    test(`${core} Guide waits for a missing ingress instead of stopping the run (${skipped?.status})`, async () => {
      const interrupt = mock(async () => queued);
      const wait = mock(() => {});
      const result = await deliverThreadFollowUpGuide(core, queued, {
        push: async () => skipped, current: () => queued, wait, interrupt,
      });
      expect(result).toBe(queued);
      expect(wait).toHaveBeenCalledTimes(1);
      expect(interrupt).not.toHaveBeenCalled();
    });
  }

  test(`${core} Guide hands input to the live run and accepts a later acknowledgment`, async () => {
    let accept!: (row: ThreadPendingFollowUp) => void;
    const applied = { ...queued, status: "applied" as const, deliveryMode: "streaming_push" as const };
    const push = mock(() => new Promise<ThreadPendingFollowUp>((resolve) => { accept = resolve; }));
    const interrupt = mock(async () => queued);
    const wait = mock(() => {});
    const delivery = deliverThreadFollowUpGuide(core, queued, { push, current: () => queued, wait, interrupt });
    expect(push).toHaveBeenCalledTimes(1);
    expect(interrupt).not.toHaveBeenCalled();
    accept(applied);
    expect(await delivery).toBe(applied);
    expect(wait).not.toHaveBeenCalled();
    expect(interrupt).not.toHaveBeenCalled();
  });

  test(`${core} Guide never resends a failed or unknown delivery`, async () => {
    const failed = { ...queued, status: "failed" as const, error: "delivery unknown" };
    const interrupt = mock(async () => queued);
    const wait = mock(() => {});
    expect(await deliverThreadFollowUpGuide(core, queued, {
      push: async () => failed, current: () => failed, wait, interrupt,
    })).toBe(failed);
    expect(wait).not.toHaveBeenCalled();
    expect(interrupt).not.toHaveBeenCalled();
  });

  test(`${core} Guide respects cancellation while the ingress is being checked`, async () => {
    const cancelled = { ...queued, status: "cancelled" as const };
    const wait = mock(() => {});
    const interrupt = mock(async () => queued);
    expect(await deliverThreadFollowUpGuide(core, queued, {
      push: async () => undefined, current: () => cancelled, wait, interrupt,
    })).toBe(cancelled);
    expect(wait).not.toHaveBeenCalled();
    expect(interrupt).not.toHaveBeenCalled();
  });
}

test("ACP guidance retains its explicit cancel/resume path", async () => {
  const push = mock(async () => queued);
  const wait = mock(() => {});
  const interrupt = mock(async () => queued);
  expect(await deliverThreadFollowUpGuide("acp", queued, { push, current: () => queued, wait, interrupt })).toBe(queued);
  expect(interrupt).toHaveBeenCalledTimes(1);
  expect(push).not.toHaveBeenCalled();
  expect(wait).not.toHaveBeenCalled();
});
