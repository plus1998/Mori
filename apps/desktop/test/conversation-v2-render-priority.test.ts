import { expect, test } from "bun:test";
import type { ConversationMessage, ConversationRun } from "@eco/shared";
import { isConversationV2InteractionEffect } from "../src/renderer/conversation-v2-render-priority";

test("native thinking boundaries are published without waiting for a text batch", () => {
  expect(isConversationV2InteractionEffect({ type: "noop", reason: "runtime.thinking.changed" })).toBe(true);
  expect(isConversationV2InteractionEffect({ type: "noop", reason: "runtime.input" })).toBe(false);
});

const message: ConversationMessage = {
  messageId: "message_1",
  conversationId: "thread_1",
  turnId: "turn_1",
  role: "user",
  channel: "answer",
  createdSeq: 1,
  versionSeq: 1,
  contentVersion: 0,
  body: "hello",
  status: "queued",
  isDeleted: false,
};

test.each([
  "queued",
  "completed",
] as const)("user acknowledgement is urgent even when imported as %s", (status) => {
  expect(isConversationV2InteractionEffect({ type: "message.create", message: { ...message, status } })).toBe(
    true,
  );
  expect(
    isConversationV2InteractionEffect({ type: "message.create", message: { ...message, role: "assistant" } }),
  ).toBe(false);
});

test.each([
  "completed",
  "cancelled",
  "failed",
] as const)("%s ends processing ahead of the stream backlog", (status) => {
  const run: ConversationRun = {
    runId: "run_1",
    conversationId: "thread_1",
    turnId: "turn_1",
    status,
    versionSeq: 2,
    timingQuality: "recorded",
  };
  expect(isConversationV2InteractionEffect({ type: "run.upsert", run })).toBe(true);
  for (const active of ["queued", "running"] as const) {
    expect(isConversationV2InteractionEffect({ type: "run.upsert", run: { ...run, status: active } })).toBe(
      false,
    );
  }
});
