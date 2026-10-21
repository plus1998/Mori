import { expect, test } from "bun:test";
import { DatabaseSync } from "node:sqlite";
import { ConversationV2Store } from "../src/main/conversation-v2-store";

test("agent transcript paginates long history without exposing thinking or attachment payloads", () => {
  const db = new DatabaseSync(":memory:");
  const store = new ConversationV2Store(db);
  store.initialize();
  for (let i = 0; i < 5; i++) {
    store.append({
      conversationId: "history",
      eventId: `e${i}`,
      type: "message.created",
      occurredAt: "2026-10-16T00:00:00Z",
      turnId: `t${i}`,
      messageId: `m${i}`,
      payload: {
        role: "user",
        body: i === 2 ? "很长😀".repeat(5000) : `消息${i}`,
        attachments: [{ id: "secret-image", mediaType: "image/png", data: "payload" }],
      },
    });
  }
  store.append({
    conversationId: "history",
    eventId: "thinking",
    type: "message.created",
    occurredAt: "2026-10-16T00:00:00Z",
    turnId: "thinking",
    messageId: "thinking",
    payload: { role: "assistant", channel: "thinking", body: "private reasoning" },
  });
  const newest = store.transcriptPage("history", undefined, 2);
  const middle = store.transcriptPage("history", newest.nextCursor, 2);
  const oldest = store.transcriptPage("history", middle.nextCursor, 2);
  expect([...oldest.messages, ...middle.messages, ...newest.messages].map((item) => item.messageId)).toEqual([
    "m0",
    "m1",
    "m2",
    "m3",
    "m4",
  ]);
  expect(oldest.hasMore).toBe(false);
  expect(middle.messages.find((item) => item.messageId === "m2")).toMatchObject({
    truncated: true,
    totalCharacters: 15000,
  });
  expect(JSON.stringify([newest, middle, oldest])).not.toContain("private reasoning");
  expect(JSON.stringify(newest)).not.toContain("secret-image");
  db.close();
});
