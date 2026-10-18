import { expect, test } from "bun:test";
import {
  buildProjectionDisplayTimelineItems,
  collapseRedundantMessageDisplayItems,
  isProjectionUserPromptItem,
  readProjectionToolMetadata,
} from "../src/renderer/conversation-v2-projection-view";
import type { ThreadRunProjectionTimelineItem as Item } from "../src/shared/ipc";

// The original pairwise rules are an independent oracle for the indexed path.
function pairwiseCollapse(items: readonly Item[]): Item[] {
  const speech = items.flatMap((item, index) =>
    !isProjectionUserPromptItem(item) &&
    item.role !== "user" &&
    ["message.delta", "message.final"].includes(item.eventType) &&
    item.text.trim()
      ? [index]
      : [],
  );
  const drop = new Set<number>();
  const normalized = (value?: string) => value?.trim() ?? "";
  const between = (left: number, right: number, predicate: (item: Item) => boolean) =>
    items.slice(left + 1, right).some(predicate);
  for (let a = 0; a < speech.length; a++) {
    const left = speech[a]!;
    if (drop.has(left)) continue;
    const earlier = items[left]!;
    for (let b = a + 1; b < speech.length; b++) {
      const right = speech[b]!;
      if (drop.has(right)) continue;
      const later = items[right]!;
      if (
        normalized(earlier.agentId) !== normalized(later.agentId) ||
        normalized(earlier.runAttemptId) !== normalized(later.runAttemptId)
      )
        continue;
      if (
        earlier.requestId?.trim() &&
        later.requestId?.trim() &&
        earlier.requestId.trim() !== later.requestId.trim()
      )
        continue;
      if (between(left, right, isProjectionUserPromptItem)) continue;
      const first = earlier.text.trim();
      const last = later.text.trim();
      if (last === first) {
        drop.add(left);
        break;
      }
      if (
        between(left, right, (item) =>
          ["tool.started", "tool.completed", "tool.failed"].includes(item.eventType),
        )
      )
        continue;
      if (last.startsWith(first) && last.length > first.length) {
        drop.add(left);
        break;
      }
      if (first.startsWith(last) && first.length > last.length) drop.add(right);
    }
  }
  return items.filter((_, index) => !drop.has(index));
}

function item(id: string, overrides: Partial<Item> = {}): Item {
  return {
    id,
    sequence: Number(id) || 1,
    scope: "main",
    eventType: "message.final",
    role: "planner",
    text: "answer",
    at: "2026-10-01T00:00:00.000Z",
    ...overrides,
  };
}

test("indexed speech collapse preserves the original rules across turns, agents, requests and tool boundaries", () => {
  let seed = 71;
  const pick = <T>(values: readonly T[]): T => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return values[seed % values.length]!;
  };
  for (let sample = 0; sample < 150; sample++) {
    const timeline = Array.from({ length: 80 }, (_, index) => {
      const kind = pick(["speech", "speech", "speech", "tool", "user"]);
      return item(String(index + 1), {
        eventType:
          kind === "tool"
            ? pick(["tool.started", "tool.completed", "tool.failed"])
            : pick(["message.delta", "message.final"]),
        text: pick(["", "answer", " answer ", "answer extended", "other", "an"]),
        role: kind === "user" ? "user" : "planner",
        ...(kind === "user" ? { metadata: { liveType: "thread.user_prompt" } } : {}),
        ...pick([{}, { agentId: "agent-a" }, { agentId: " agent-a " }, { agentId: "agent-b" }]),
        ...pick([{}, { runAttemptId: "run-a" }, { runAttemptId: "run-b" }]),
        ...pick([{}, { requestId: "req-a" }, { requestId: "req-b" }]),
      });
    });
    expect(collapseRedundantMessageDisplayItems(timeline)).toEqual(pairwiseCollapse(timeline));
  }
});

test("independent historical turns do not require pairwise scope reads", () => {
  let scopeReads = 0;
  const timeline = Array.from({ length: 2500 }, (_, index) => {
    const row = item(String(index + 1));
    Object.defineProperty(row, "runAttemptId", {
      get() {
        scopeReads++;
        return `run-${index}`;
      },
    });
    return row;
  });
  expect(collapseRedundantMessageDisplayItems(timeline)).toEqual(timeline);
  expect(scopeReads).toBeLessThan(timeline.length * 10);
});

test("final echoes use exact text and respect user boundaries when a new timeline replaces the old one", () => {
  const block = item("1", { streamKey: "message:block:1", requestId: "request", text: "same" });
  const echo = item("3", { text: "same" });
  const original = [block, echo];
  expect(buildProjectionDisplayTimelineItems(original, new Map()).map((row) => row.id)).toEqual(["1"]);
  const prompt = item("2", { role: "user", text: "继续", metadata: { liveType: "thread.user_prompt" } });
  const next = [block, prompt, echo];
  expect(buildProjectionDisplayTimelineItems(next, new Map()).map((row) => row.id)).toEqual(["1", "2", "3"]);
  expect(buildProjectionDisplayTimelineItems(original, new Map()).map((row) => row.id)).toEqual(["1"]);
});

test("tool metadata is parsed once per immutable version and updates are not hidden by the cache", () => {
  const old = item("1", { metadata: { tool: { name: " Bash ", detail: " pwd ", status: "started" } } });
  const parsed = readProjectionToolMetadata(old);
  expect(parsed).toMatchObject({ name: "Bash", detail: "pwd", status: "started" });
  expect(readProjectionToolMetadata({ ...old })).toBe(parsed);
  const updated = { ...old, metadata: { tool: { name: "Bash", detail: "ls", status: "completed" } } };
  expect(readProjectionToolMetadata(updated)).toMatchObject({ detail: "ls", status: "completed" });
  expect(readProjectionToolMetadata(old)).toBe(parsed);
  expect(readProjectionToolMetadata(item("2", { metadata: { tool: {} } }))).toBeUndefined();
});
