import { expect, test } from "bun:test";
import { stableHash, type ConversationSyncEffect, type ConversationSyncPage } from "@eco/shared";
import { loadConversationV2ProjectionUpdate } from "../src/renderer/conversation-v2-projection-update";
import {
  applyConversationV2Effects,
  installConversationV2Bootstrap,
  installConversationV2ProjectionExtras,
} from "../src/renderer/conversation-v2-renderer-state";

const initial = installConversationV2ProjectionExtras(
  installConversationV2Bootstrap({
    protocolVersion: 2,
    storeEpoch: "epoch",
    conversationId: "thread",
    snapshotSeq: 1,
    historyRevision: 0,
    messages: [],
    runs: [],
    turns: [],
    tools: [],
    hasOlder: false,
  }),
  {
    requestSpans: [
      {
        requestId: "req",
        status: "completed",
        startedAt: "2026-01-01T00:00:00Z",
        writingTool: { name: "mongo/find", since: "2026-01-01T00:00:01Z", phase: "dispatching" },
      },
    ],
  },
);

const tool = {
  type: "tool.summary.upsert",
  toolCall: {
    toolCallId: "call",
    conversationId: "thread",
    runId: "run",
    name: "mongo/find",
    status: "running",
    createdSeq: 2,
    versionSeq: 2,
  },
} as const;
const effects: ConversationSyncEffect[] = [
  { seq: 2, effectVersion: 1, effectHash: stableHash(tool), effect: tool },
];
const page: ConversationSyncPage = {
  protocolVersion: 2,
  conversationId: "thread",
  storeEpoch: "epoch",
  fromSeq: 2,
  throughSeq: 2,
  headSeq: 2,
  hasMore: false,
  effects,
};
const head = {
  protocolVersion: 2 as const,
  conversationId: "thread",
  storeEpoch: "epoch",
  lastSeq: 2,
  historyRevision: 0,
};
type Api = Parameters<typeof loadConversationV2ProjectionUpdate>[1];

test("a cleared preparation status waits for its actual tool row before either is published", async () => {
  let release!: (value: ConversationSyncPage) => void;
  let reachedSync!: () => void;
  const syncing = new Promise<void>((resolve) => {
    reachedSync = resolve;
  });
  const order: string[] = [];
  const api = {
    async conversationV2Projection() {
      order.push("extras");
      return { requestSpans: [] };
    },
    async conversationV2Head() {
      order.push("head");
      return head;
    },
    async conversationV2Capabilities() {
      return { maxEvents: 512, maxBytes: 2 * 1024 * 1024 };
    },
    conversationV2Sync() {
      reachedSync();
      return new Promise<ConversationSyncPage>((resolve) => {
        release = resolve;
      });
    },
  } as Api;
  let published = false;
  const update = loadConversationV2ProjectionUpdate(initial, api).then((state) => {
    published = true;
    return state;
  });
  await syncing;
  expect(order).toEqual(["extras", "head"]);
  expect(published).toBe(false);
  expect(initial.projectionExtras?.requestSpans[0]?.writingTool).toBeDefined();
  release(page);
  const next = await update;
  expect(next.tools.get("call")?.status).toBe("running");
  expect(next.projectionExtras?.requestSpans).toEqual([]);
  expect(next.appliedSeq).toBe(2);
});

test("projection catch-up preserves a newer live cursor while reading the sync page", async () => {
  let latest = initial;
  const noop = { type: "noop", reason: "newer live receipt" } as const;
  const api = {
    async conversationV2Projection() {
      return { requestSpans: [] };
    },
    async conversationV2Head() {
      return head;
    },
    async conversationV2Capabilities() {
      return { maxEvents: 512, maxBytes: 1024 * 1024 };
    },
    async conversationV2Sync() {
      latest = applyConversationV2Effects(initial, [
        ...effects,
        { seq: 3, effectVersion: 1, effectHash: stableHash(noop), effect: noop },
      ]);
      return page;
    },
  } as Api;
  const next = await loadConversationV2ProjectionUpdate(initial, api, () => latest);
  expect(next.appliedSeq).toBe(3);
  expect(next.tools.get("call")?.status).toBe("running");
});

test("projection updates reject another epoch instead of swapping out the current status", async () => {
  const api = {
    async conversationV2Projection() {
      return { requestSpans: [] };
    },
    async conversationV2Head() {
      return { ...head, storeEpoch: "another" };
    },
  } as Api;
  await expect(loadConversationV2ProjectionUpdate(initial, api)).rejects.toThrow("invalid stream boundary");
  expect(initial.projectionExtras?.requestSpans[0]?.writingTool).toBeDefined();
});
