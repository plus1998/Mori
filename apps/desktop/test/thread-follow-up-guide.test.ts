import { expect, mock, test } from "bun:test";
import { deliverThreadFollowUpGuide, resolveThreadFollowUpMidTurnPrompt } from "../src/main/thread-follow-up-guide";
import { buildPromptWithImageReferences } from "../src/shared/prompt-image-reference";
import { CodexMidTurnPortRegistry } from "../src/main/codex-mid-turn-port";
import type { ThreadPendingFollowUp } from "../src/shared/ipc";

const queued: ThreadPendingFollowUp = {
  id: "guide", threadId: "thread", prompt: "补充要求", priority: "escalated",
  status: "queued", deliveryMode: "queued", createdAt: "2026-10-28T00:00:00Z",
  updatedAt: "2026-10-28T00:00:00Z",
};

for (const prompt of ["请核对这张图", ""]) {
  test(`image guidance reaches the live Codex ingress with its image reference (${prompt || "image only"})`, async () => {
    const followUp = {
      ...queued,
      prompt,
      attachments: [{ mediaType: "image/png" as const, contentRef: "sha256:guide-image", data: "private-image-bytes" }],
    };
    const registry = new CodexMidTurnPortRegistry();
    const requests: unknown[] = [];
    registry.open(followUp.threadId, {
      codexThreadId: "codex-thread", turnId: "live-turn",
      client: { async request(_method, params) { requests.push(params); return { turnId: "live-turn" }; } },
    });
    const result = await deliverThreadFollowUpGuide("codex", followUp, {
      push: async () => {
        const text = await resolveThreadFollowUpMidTurnPrompt(followUp, async (input) => buildPromptWithImageReferences(input));
        expect(text).toContain('ref="sha256:guide-image"');
        expect(text).not.toContain("private-image-bytes");
        const pushed = await registry.tryPushUserText(followUp.threadId, text!, { clientUserMessageId: followUp.id });
        expect(pushed.ok).toBe(true);
        return { ...followUp, status: "applied", deliveryMode: "streaming_push" };
      },
      current: () => followUp,
      wait: () => { throw new Error("image guidance must reach the live port"); },
      interrupt: async () => { throw new Error("guidance must not interrupt"); },
    });
    expect(result.status).toBe("applied");
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ expectedTurnId: "live-turn", clientUserMessageId: followUp.id });
  });
}

test("empty guidance is skipped, and an unresolved image-only prompt fails explicitly", async () => {
  const resolve = mock(async () => "");
  expect(await resolveThreadFollowUpMidTurnPrompt({ ...queued, prompt: " " }, resolve)).toBeUndefined();
  expect(resolve).not.toHaveBeenCalled();
  await expect(resolveThreadFollowUpMidTurnPrompt({
    ...queued, prompt: "", attachments: [{ mediaType: "image/png", data: "bytes-without-reference" }],
  }, async (input) => buildPromptWithImageReferences(input))).rejects.toThrow("没有可发送的文字或图片引用");
});

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
