import { expect, test } from "bun:test";
import {
  createFeedEntryIdentityReconciler,
  createFeedSectionIdentityReconciler,
} from "../src/renderer/feed-reading-identity";
import {
  projectionMainFeedEntryKey,
  type ThreadRunProjectionMainFeedEntry,
} from "../src/renderer/conversation-v2-projection-view";
import type { ThreadRunProjectionTimelineItem } from "../src/shared/ipc";
import type { ThreadRunTurnFeedSection } from "../src/renderer/conversation-v2-turn-feed";

const item = (id: string, sequence: number): ThreadRunProjectionTimelineItem => ({
  id,
  sequence,
  eventType: "message.final",
  scope: "main",
  role: "main",
  text: id,
  at: "2026-01-01T00:00:00Z",
  streamKey: id,
  runAttemptId: "attempt",
  metadata: { conversationV2MessageId: id, logicalEntityId: id },
});
const entry = (id: string): ThreadRunProjectionMainFeedEntry => ({
  kind: "timeline",
  key: id,
  item: item(id, 10),
  sequence: 10,
  at: "2026-01-01T00:00:00Z",
});
const group = (...ids: string[]): ThreadRunProjectionMainFeedEntry => ({
  kind: "tool-group",
  key: `tool-group:${ids[0]}`,
  entries: ids.map((id) => entry(id) as Extract<ThreadRunProjectionMainFeedEntry, { kind: "timeline" }>),
  sequence: 10,
  at: "2026-01-01T00:00:00Z",
});
const turn = (key: string, ...ids: string[]): ThreadRunTurnFeedSection => ({
  kind: "turn",
  key,
  attempt: {
    attemptId: "attempt",
    phase: "execute",
    retryIndex: 0,
    status: "completed",
    startedAt: "2026-01-01T00:00:00Z",
  },
  running: false,
  processEntries: ids.map(entry),
});

test("durable V2 message keys survive prepend, eviction, request-span arrival and mid-turn prompts", () => {
  const message = item("message", 20),
    prompt = { ...item("user", 10), role: "user", metadata: { liveType: "thread.user_prompt" } };
  const key = projectionMainFeedEntryKey(message);
  expect(projectionMainFeedEntryKey(message, { timeline: [prompt, message] })).toBe(key);
  expect(
    projectionMainFeedEntryKey({ ...message, requestId: "request" }, { timeline: [prompt, message] }),
  ).toBe(key);
  expect(projectionMainFeedEntryKey({ ...message, eventType: "message.delta" })).toBe(key);
});

test("tool groups retain mounted identity when either side of the window changes", () => {
  const reconcile = createFeedEntryIdentityReconciler();
  const first = reconcile([group("b", "c")]);
  const prepended = reconcile([group("a", "b", "c")]);
  expect(prepended[0]!.key).toBe(first[0]!.key);
  const trimmed = reconcile([group("c", "d")]);
  expect(trimmed[0]!.key).toBe(first[0]!.key);
  const replaced = reconcile([group("e", "f")]);
  expect(replaced[0]!.key).not.toBe(first[0]!.key);
});

test("an inserted initial turn cannot steal the identity of the visible continuation", () => {
  const reconcile = createFeedSectionIdentityReconciler();
  const [original] = reconcile([turn("turn:attempt#after:0", "visible")]);
  const next = reconcile([
    turn("turn:attempt#after:0", "older"),
    turn("turn:attempt#after:prompt", "visible"),
  ]);
  expect(next[1]!.key).toBe(original!.key);
  expect(next[1]!.kind === "turn" && next[1]!.continuation).toBe(false);
  expect(next[0]!.kind === "turn" && next[0]!.continuation).toBe(true);
  expect(next[0]!.key).not.toBe(original!.key);
  expect(new Set(next.map((row) => row.key)).size).toBe(next.length);
  expect(reconcile([turn("turn:attempt#after:prompt", "visible")])[0]!.key).toBe(original!.key);
});

test("a loaded summary stays visible when a later page extends the same completed turn", () => {
  const reconcile = createFeedSectionIdentityReconciler();
  const initial = turn("turn:attempt#after:0", "tool");
  if (initial.kind !== "turn") throw new Error("turn required");
  const first = reconcile([{ ...initial, finalEntry: entry("summary-a") }]);
  const extended = reconcile([
    {
      ...initial,
      processEntries: [entry("tool"), entry("summary-a"), entry("later-tool")],
      finalEntry: entry("summary-b"),
    },
  ]);
  expect(extended).toHaveLength(2);
  expect(extended[0]!.key).toBe(first[0]!.key);
  expect(extended[0]!.kind === "turn" && extended[0]!.finalEntry?.key).toBe("summary-a");
  expect(extended[1]!.kind === "turn" && extended[1]!.continuation).toBe(true);
  expect(extended[1]!.kind === "turn" && extended[1]!.finalEntry?.key).toBe("summary-b");
  const again = reconcile([
    {
      ...initial,
      processEntries: [entry("tool"), entry("summary-a"), entry("later-tool")],
      finalEntry: entry("summary-b"),
    },
  ]);
  expect(again.map((section) => section.key)).toEqual(extended.map((section) => section.key));
});

test("late tool timestamps cannot pull an existing process group past the visible summary", () => {
  const reconcile = createFeedSectionIdentityReconciler();
  const base = turn("turn:attempt#after:0");
  if (base.kind !== "turn") throw new Error("turn required");
  const summary = { ...entry("summary"), sequence: 20 };
  const oldTool = { ...entry("old-tool"), sequence: 30 };
  const newTool = { ...entry("new-tool"), sequence: 40 };
  const tools = {
    ...group("old-tool"),
    entries: [oldTool as Extract<ThreadRunProjectionMainFeedEntry, { kind: "timeline" }>],
    sequence: 30,
  };
  const initial = reconcile([{ ...base, processEntries: [tools], finalEntry: summary }]);
  const extended = reconcile([
    {
      ...base,
      processEntries: [
        summary,
        {
          ...tools,
          entries: [oldTool, newTool] as Extract<ThreadRunProjectionMainFeedEntry, { kind: "timeline" }>[],
        },
      ],
      finalEntry: { ...entry("new-summary"), sequence: 50 },
    },
  ]);
  expect(extended).toHaveLength(2);
  const oldSection = extended[0],
    newSection = extended[1];
  if (oldSection?.kind !== "turn" || newSection?.kind !== "turn" || initial[0]?.kind !== "turn")
    throw new Error("turn sections required");
  expect(oldSection.key).toBe(initial[0].key);
  expect(oldSection.finalEntry?.key).toBe("summary");
  expect(oldSection.processEntries[0]?.key).toBe(initial[0].processEntries[0]?.key);
  expect(
    oldSection.processEntries[0]?.kind === "tool-group" &&
      oldSection.processEntries[0].entries.map((child) => child.key),
  ).toEqual(["old-tool"]);
  expect(
    newSection.processEntries[0]?.kind === "tool-group" &&
      newSection.processEntries[0].entries.map((child) => child.key),
  ).toEqual(["new-tool"]);
});
