import { expect, test } from "bun:test";
import {
  canEscalateThreadFollowUp,
  formatThreadFollowUpPreview,
  isLiveFollowUpThreadStatus,
  isThreadFollowUpGuidancePending,
  mergeThreadFollowUp,
  mergeThreadFollowUps,
  queuedThreadFollowUps,
  shouldComposerUseFollowUpQueue,
} from "../src/renderer/thread-follow-up-ui";
import type { ThreadPendingFollowUp } from "../src/shared/ipc";
import {
  coreSupportsFollowUpEscalate,
  resolveFollowUpDeliveryModeForCore,
} from "../src/shared/thread-follow-up-core";
import { withTestLanguage } from "./support/test-language";
import { buildCodexAsyncQuestionReplyText } from "../src/shared/codex-async-questions";

function followUp(id: string, patch: Partial<ThreadPendingFollowUp> = {}): ThreadPendingFollowUp {
  return {
    id,
    threadId: "thr_1",
    prompt: `message ${id}`,
    priority: "normal",
    status: "queued",
    deliveryMode: "queued",
    createdAt: `2024-01-01T00:00:0${id.length}.000Z`,
    updatedAt: "2024-01-01T00:00:00.000Z",
    ...patch,
  };
}

test("async answer queue previews show the question and answer while preserving the wire prompt", () => {
  const prompt = buildCodexAsyncQuestionReplyText([
    { questionItemId: "q1", question: "处理方式？", answer: "保留记录" },
  ]);
  const row = followUp("async-answer", { prompt });
  expect(formatThreadFollowUpPreview(row)).toBe("处理方式？ → 保留记录");
  expect(row.prompt).toBe(prompt);
});

test("isLiveFollowUpThreadStatus only opens running and queued UI", () => {
  expect(isLiveFollowUpThreadStatus("running")).toBe(true);
  expect(isLiveFollowUpThreadStatus("queued")).toBe(true);
  expect(isLiveFollowUpThreadStatus("awaiting_plan")).toBe(false);
  expect(isLiveFollowUpThreadStatus("completed")).toBe(false);
});

test("guidance stays pending after its command receipt until delivery, cancellation or a paused stop", () => {
  const row = followUp("guiding", { priority: "escalated" });
  expect(isThreadFollowUpGuidancePending(row, { queuePaused: false, threadActive: true })).toBe(true);
  expect(isThreadFollowUpGuidancePending(row, { queuePaused: true, threadActive: true })).toBe(true);
  expect(isThreadFollowUpGuidancePending(row, { queuePaused: false, threadActive: false })).toBe(true);
  expect(isThreadFollowUpGuidancePending(row, { queuePaused: true, threadActive: false })).toBe(false);
  expect(isThreadFollowUpGuidancePending(followUp("ordinary"), { queuePaused: false, threadActive: true })).toBe(false);
  for (const status of ["applied", "cancelled", "superseded", "failed"] as const) {
    expect(isThreadFollowUpGuidancePending({ ...row, status }, { queuePaused: false, threadActive: true })).toBe(false);
  }
});

test("shouldComposerUseFollowUpQueue while live, editing, or paused", () => {
  expect(shouldComposerUseFollowUpQueue({ status: "running" })).toBe(true);
  expect(shouldComposerUseFollowUpQueue({ status: "idle" })).toBe(false);
  expect(
    shouldComposerUseFollowUpQueue({
      status: "idle",
      followUpQueuePaused: true,
    }),
  ).toBe(true);
  expect(
    shouldComposerUseFollowUpQueue({
      status: "completed",
      editingFollowUpId: "fu_1",
    }),
  ).toBe(true);
});

test("queuedThreadFollowUps hides non-queued records and preserves stable priority order", () => {
  const normal = followUp("normal", { createdAt: "2024-01-01T00:00:01.000Z" });
  const cancelled = followUp("cancelled", { status: "cancelled" });
  const escalated = followUp("escalated", {
    priority: "escalated",
    deliveryMode: "interrupt_resume",
    createdAt: "2024-01-01T00:00:02.000Z",
  });

  expect(queuedThreadFollowUps([normal, cancelled, escalated]).map((item) => item.id)).toEqual([
    "escalated",
    "normal",
  ]);
});

test("mergeThreadFollowUp replaces existing records by id", () => {
  const original = followUp("same", { prompt: "旧消息" });
  const updated = followUp("same", { prompt: "已取消", status: "cancelled" });

  expect(mergeThreadFollowUp([original], updated)).toEqual([updated]);
});

test("saving another edit cannot resurrect a sent row from an older command receipt", () => {
  const sent = followUp("sent", { status: "applied", updatedAt: "2026-10-05T09:46:20.407Z" });
  const editing = followUp("editing", { updatedAt: "2026-10-05T09:42:21.405Z" });
  const oldReceipt = [
    followUp("sent", { priority: "escalated", updatedAt: "2026-10-05T09:42:58.648Z" }),
    editing,
  ];
  const state = mergeThreadFollowUps([sent, editing], oldReceipt);
  expect(queuedThreadFollowUps(state).map((row) => row.id)).toEqual(["editing"]);
  expect(state.find((row) => row.id === "sent")).toEqual(sent);
});

test("queue lifecycle resists delayed snapshots/events without dropping newly enqueued rows", () => {
  for (const status of ["applied", "cancelled", "superseded", "failed"] as const) {
    const terminal = followUp("done", { status, updatedAt: "2026-10-05T10:00:03.000Z" });
    const stale = followUp("done", { updatedAt: "2026-10-05T10:00:01.000Z" });
    const state = mergeThreadFollowUps([terminal, followUp("new")], [stale]);
    expect(queuedThreadFollowUps(state).map((row) => row.id)).toEqual(["new"]);
    expect(mergeThreadFollowUp(state, { ...stale, updatedAt: terminal.updatedAt })).toEqual(state);
  }
  const original = followUp("edit", { prompt: "before", updatedAt: "2026-10-05T10:00:01.000Z" });
  const updated = { ...original, prompt: "after", updatedAt: "2026-10-05T10:00:02.000Z" };
  expect(mergeThreadFollowUps([updated], [original])).toEqual([updated]);
  expect(mergeThreadFollowUps([original], [updated])).toEqual([updated]);
});

test("a rejected streaming push can requeue its row, but cannot overwrite an applied row", () => {
  const delivered = followUp("push", {
    status: "delivered",
    deliveryMode: "streaming_push",
    updatedAt: "2026-10-05T10:00:01.000Z",
  });
  const requeued = {
    ...delivered,
    status: "queued" as const,
    error: "port closed",
    updatedAt: "2026-10-05T10:00:02.000Z",
  };
  expect(mergeThreadFollowUp([delivered], requeued)).toEqual([requeued]);
  const applied = { ...delivered, status: "applied" as const, updatedAt: "2026-10-05T10:00:03.000Z" };
  expect(mergeThreadFollowUps([applied], [delivered, requeued])).toEqual([applied]);
});

// One test needs localized previews in English. Switching the renderer's language is
// process-wide, so it is restored after every test in this file: leaving it switched made
// seven unrelated Feed assertions fail only in a full run.
withTestLanguage("en-US");

test("formatThreadFollowUpPreview localizes image and empty defaults", () => {
  const preview = formatThreadFollowUpPreview(
    followUp("with-image", {
      prompt: "a".repeat(140),
      attachments: [{ mediaType: "image/png", data: "abc" }],
    }),
  );

  expect(preview).toEndWith("... (1 image(s))");
  expect(preview.length).toBeLessThan(140);
  expect(
    formatThreadFollowUpPreview(
      followUp("images", {
        prompt: "",
        attachments: [{ mediaType: "image/png", data: "abc" }],
      }),
    ),
  ).toBe("1 image(s)");
  expect(formatThreadFollowUpPreview(followUp("empty", { prompt: "" }))).toBe("Empty follow-up message");
});

test("Guide stays clickable on an escalated row while the queue is paused", () => {
  expect(
    canEscalateThreadFollowUp({ priority: "normal", coreSupportsEscalate: true, queuePaused: true }),
  ).toBe(true);
  expect(
    canEscalateThreadFollowUp({
      priority: "escalated",
      coreSupportsEscalate: true,
      queuePaused: true,
    }),
  ).toBe(true);
  // Unpaused: an escalated row is already next in line, so the action is inert.
  expect(
    canEscalateThreadFollowUp({
      priority: "escalated",
      coreSupportsEscalate: true,
      queuePaused: false,
    }),
  ).toBe(false);
  expect(
    canEscalateThreadFollowUp({ priority: "normal", coreSupportsEscalate: false, queuePaused: true }),
  ).toBe(false);
});

test("follow-up UI allows escalate and preserves steer for mid-turn cores", () => {
  expect(coreSupportsFollowUpEscalate("acp")).toBe(true);
  expect(coreSupportsFollowUpEscalate("claude")).toBe(true);
  expect(coreSupportsFollowUpEscalate("pi")).toBe(true);
  expect(resolveFollowUpDeliveryModeForCore("acp", "steer")).toBe("steer");
  expect(resolveFollowUpDeliveryModeForCore("codex", "steer")).toBe("steer");
  expect(resolveFollowUpDeliveryModeForCore("pi", "steer")).toBe("steer");
});
