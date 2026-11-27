import { expect, mock, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readImageViewFile } from "../src/main/image-view-reader";
import { PromptImageFileStore } from "../src/main/prompt-image-file-store";
import { deliverThreadFollowUpGuide, resolveThreadFollowUpMidTurnPrompt } from "../src/main/thread-follow-up-guide";
import { buildPromptWithImageReferences } from "../src/shared/prompt-image-reference";
import { CodexMidTurnPortRegistry } from "../src/main/codex-mid-turn-port";
import type { ThreadPendingFollowUp } from "../src/shared/ipc";

const queued: ThreadPendingFollowUp = {
  id: "guide", threadId: "thread", prompt: "补充要求", priority: "escalated",
  status: "queued", deliveryMode: "queued", createdAt: "2026-10-28T00:00:00Z",
  updatedAt: "2026-10-28T00:00:00Z",
};

test("manual compact stays queued instead of entering a live model prompt", async () => {
  const resolvePrompt = mock(async () => "/compact");
  const resolveAttachments = mock(async () => []);
  expect(await resolveThreadFollowUpMidTurnPrompt({ ...queued, prompt: " /compact \n" }, { resolvePrompt, resolveAttachments })).toBeUndefined();
  expect(resolvePrompt).not.toHaveBeenCalled();
  expect(resolveAttachments).not.toHaveBeenCalled();
});

const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

for (const prompt of ["请核对这张图", ""]) {
  test(`live image guidance stays readable after the queued file moves (${prompt || "image only"})`, async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "eco-follow-up-images-"));
    try {
      const images = new PromptImageFileStore(directory);
      const attachments = await images.persistMessageAttachments(queued.threadId, "follow-up:queued", [
        { mediaType: "image/png", data: pngBase64 },
      ]);
      const followUp = { ...queued, prompt, attachments };
      const registry = new CodexMidTurnPortRegistry();
      const requests: unknown[] = [];
      registry.open(followUp.threadId, {
        codexThreadId: "codex-thread", turnId: "live-turn",
        client: { async request(_method, params) { requests.push(params); return { turnId: "live-turn" }; } },
      });
      const result = await deliverThreadFollowUpGuide("codex", followUp, {
        push: async () => {
          const text = await resolveThreadFollowUpMidTurnPrompt(followUp, {
            resolveAttachments: (queuedAttachments) => images.resolveAttachmentsForRuntime(queuedAttachments),
            resolvePrompt: async (input) => buildPromptWithImageReferences(input),
          });
          expect(text).toBeDefined();
          expect(text).not.toContain(pngBase64);
          const pushed = await registry.tryPushUserText(followUp.threadId, text!, { clientUserMessageId: followUp.id });
          expect(pushed.ok).toBe(true);
          // After the provider acknowledges, recording the user message consumes the queued path.
          await images.persistMessageAttachments(followUp.threadId, "user:recorded", attachments);
          await expect(readImageViewFile(attachments[0]!.path!)).rejects.toMatchObject({ code: "not_found" });
          const sentPath = JSON.parse(text!.match(/^- image 1: path=(.+)$/m)![1]!) as string;
          expect(sentPath).not.toBe(attachments[0]!.path);
          expect((await readImageViewFile(sentPath)).dataBase64).toBe(pngBase64);
          return { ...followUp, status: "applied", deliveryMode: "streaming_push" };
        },
        current: () => followUp,
        wait: () => { throw new Error("image guidance must reach the live port"); },
        interrupt: async () => { throw new Error("guidance must not interrupt"); },
      });
      expect(result.status).toBe("applied");
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({ expectedTurnId: "live-turn", clientUserMessageId: followUp.id });
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
}

test("empty guidance is skipped, and an unresolved image-only prompt fails explicitly", async () => {
  const resolvePrompt = mock(async () => "");
  const resolveAttachments = mock(async () => []);
  expect(await resolveThreadFollowUpMidTurnPrompt({ ...queued, prompt: " " }, { resolvePrompt, resolveAttachments })).toBeUndefined();
  expect(resolvePrompt).not.toHaveBeenCalled();
  expect(resolveAttachments).not.toHaveBeenCalled();
  await expect(resolveThreadFollowUpMidTurnPrompt({
    ...queued, prompt: "", attachments: [{ mediaType: "image/png", data: "bytes-without-reference" }],
  }, {
    resolveAttachments: async (attachments) => attachments,
    resolvePrompt: async (input) => buildPromptWithImageReferences(input),
  })).rejects.toThrow("没有可发送的文字或图片引用");
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
