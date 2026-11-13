import { expect, test } from "bun:test";
import type { ThreadRunProjectionTimelineItem } from "../src/shared/ipc";
import { floatingConversationResultPreview } from "../src/renderer/floating-conversation-result";

function item(input: Partial<ThreadRunProjectionTimelineItem>): ThreadRunProjectionTimelineItem {
  return { id: "message", sequence: 1, eventType: "message.final", scope: "main", role: "main", text: "", at: "2026-11-13T00:00:00Z", ...input };
}

test("completion preview uses the main reply instead of child output, thinking, or lifecycle text", () => {
  expect(floatingConversationResultPreview([
    item({ text: "主回复\n\n最终结果" }),
    item({ scope: "agent", text: "子任务回复" }),
    item({ eventType: "thinking.final", text: "内部思考" }),
    item({ eventType: "thread.status", text: "已完成" }),
  ])).toBe("主回复 最终结果");
});

test("a new prompt or attempt never displays a stale previous result", () => {
  expect(floatingConversationResultPreview([item({ text: "旧回复" }), item({ role: "user", text: "新问题" })])).toBe("");
  expect(floatingConversationResultPreview([item({ text: "旧回复" }), item({ eventType: "run.attempt.started" })])).toBe("");
});

test("an empty final retains the preceding actual reply and accepts the legacy planner role", () => {
  expect(floatingConversationResultPreview([item({ role: "planner", text: "完成结果" }), item({ text: "" })])).toBe("完成结果");
});

test("a streaming reply is not presented as a completed result", () => {
  expect(floatingConversationResultPreview([item({ eventType: "message.delta", text: "尚未完成" })])).toBe("");
});
