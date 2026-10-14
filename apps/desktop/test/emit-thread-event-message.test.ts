import { expect, test } from "bun:test";
import {
  hasStructuredThreadEventExtras,
  resolveEmitThreadEventMessage,
} from "../src/main/emit-thread-event-message";

function decide(input: Partial<Parameters<typeof resolveEmitThreadEventMessage>[0]> & { type: string }) {
  return resolveEmitThreadEventMessage({
    message: "",
    stream: false,
    hasStructuredExtras: false,
    hasPlan: false,
    ...input,
  });
}

test("a tool write with no text of its own is still recorded", () => {
  // The Feed reads what is being written out of `toolWriting` metadata. A call the provider
  // never named (a `web_search_call`) has no message at all, and dropping it would lose the
  // wait the Feed exists to narrate.
  const decision = decide({ type: "tool.writing" });
  expect(decision.drop).toBe(false);
  expect(decision.persistedMessage).toBe("");
  // No placeholder either: the Feed must not be told「状态已更新」about something else.
  expect(decision.liveMessage).toBe("");
});

test("a nameless tool write named only by its target keeps the target as its message", () => {
  const decision = decide({ type: "tool.writing", message: "/tmp/eco.md" });
  expect(decision.drop).toBe(false);
  expect(decision.persistedMessage).toBe("/tmp/eco.md");
  expect(decision.liveMessage).toBe("/tmp/eco.md");
});

test("an empty activity is dropped", () => {
  expect(decide({ type: "tool.started" }).drop).toBe(true);
  expect(decide({ type: "message.delta" }).drop).toBe(true);
});

test("an empty stream chunk is allowed through", () => {
  expect(decide({ type: "message.delta", stream: true }).drop).toBe(false);
});

test("extras carry the event when the text does not", () => {
  expect(decide({ type: "plan.approval_requested", hasStructuredExtras: true }).drop).toBe(false);
  expect(decide({ type: "plan.ready", hasStructuredExtras: true, hasPlan: true }).liveMessage).toBe(
    "计划已就绪",
  );
});

test("thread status events keep their summary wording", () => {
  const decision = decide({ type: "thread.status" });
  expect(decision.drop).toBe(false);
  expect(decision.persistedMessage).toBe("状态已更新");
  expect(decision.liveMessage).toBe("状态已更新");
  // Metrics flips are worded like any other thread transition when they have no text of their
  // own — unchanged from before; the type is only special for the *Feed*.
  expect(decide({ type: "thread.usage_updated" }).persistedMessage).toBe("状态已更新");
});

test("a silent follow-up stays silent", () => {
  const decision = decide({ type: "thread.follow_up.enqueued" });
  expect(decision.drop).toBe(false);
  expect(decision.persistedMessage).toBe("");
  expect(decision.liveMessage).toBe("");
});

test("a plan carried inside metadata still counts as the event's payload", () => {
  // Bridged events put the plan in `metadata` rather than on the extras themselves; the rule is
  // about the payload existing, not about which of the two places holds it.
  expect(hasStructuredThreadEventExtras({ metadata: { plan: { steps: [] } } })).toBe(true);
  expect(hasStructuredThreadEventExtras({ metadata: { clarification: { question: "?" } } })).toBe(true);
  expect(hasStructuredThreadEventExtras({ plan: { steps: [] } })).toBe(true);
  expect(hasStructuredThreadEventExtras({ subagentSessions: [{}] })).toBe(true);
  // Metadata that is merely about the event (an agent, a parent tool) says nothing by itself.
  expect(hasStructuredThreadEventExtras({ metadata: { parent_tool_use_id: "call_1" } })).toBe(false);
  expect(hasStructuredThreadEventExtras({ metadata: {} })).toBe(false);
  expect(hasStructuredThreadEventExtras(undefined)).toBe(false);
});
