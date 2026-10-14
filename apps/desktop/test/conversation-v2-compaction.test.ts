import { expect, spyOn, test } from "bun:test";
import { DatabaseSync } from "node:sqlite";
import { CONVERSATION_V2_MAX_PAGE_SIZE, estimateConversationBytes } from "@eco/shared";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ConversationStore } from "../src/main/conversation-store";
import { migrateCodexCompactionDetails } from "../src/main/conversation-v2-compaction-migration";
import {
  ConversationV2RuntimeWriter,
  conversationV2ProviderReceipt,
} from "../src/main/conversation-v2-runtime-writer";
import { ConversationV2Store } from "../src/main/conversation-v2-store";
import { ActivityLogView, buildConversationV2OnlyProjection } from "../src/renderer/ActivityLogView";
import {
  buildThreadRunProjectionViewModel,
  isThreadAutoCompactSuspended,
  isThreadContextCompactionInFlight,
  projectionItemToDetailBlock,
} from "../src/renderer/conversation-v2-projection-view";
import {
  applyConversationV2Effects,
  installConversationV2Bootstrap,
} from "../src/renderer/conversation-v2-renderer-state";
import { resolveContextCompactionTiming } from "../src/shared/context-compaction-timing";
import type { ThreadRunEventInput } from "../src/shared/thread-run-events";

function setup() {
  const db = new DatabaseSync(":memory:");
  const store = new ConversationV2Store(db);
  store.initialize();
  store.append({
    conversationId: "thread",
    eventId: "run-start",
    runId: "run",
    turnId: "run",
    type: "run.started",
    occurredAt: "2026-10-07T03:28:00.000Z",
    payload: { status: "running" },
  });
  return { db, store, writer: new ConversationV2RuntimeWriter(db, store) };
}

function compaction(stage: "started" | "completed" | "failed" | "suspended"): ThreadRunEventInput {
  return {
    threadId: "thread",
    id: `codex-compaction-${stage}`,
    runAttemptId: "run",
    requestId: "01a11464-34ae-7f13-beee-577bd63834b5",
    streamKey: "01a11467-f269-74d3-b6b2-2a71c4818d15",
    eventType: `context.compaction.${stage}`,
    scope: "main",
    streamState: stage === "started" ? "none" : "finalized",
    message: stage === "started" ? "正在压缩上下文" : `上下文压缩：${stage}`,
    observedAt: stage === "started" ? "2026-10-07T03:28:39.020Z" : "2026-10-07T03:28:52.297Z",
    metadata: {
      codexMethod: stage === "started" ? "item/started" : "item/completed",
      itemType: "contextCompaction",
      itemId: "01a11467-f269-74d3-b6b2-2a71c4818d15",
      turnId: "01a11464-34ae-7f13-beee-577bd63834b5",
    },
  };
}

function project(store: ConversationV2Store, maxBytes?: number) {
  return buildConversationV2OnlyProjection(
    installConversationV2Bootstrap(store.bootstrap("thread", 30, maxBytes)),
  );
}

test("Codex compaction reaches the live Feed, reopen and durable replay without an assistant message", () => {
  const { db, store, writer } = setup();
  try {
    let state = installConversationV2Bootstrap(store.bootstrap("thread"));
    writer.append(compaction("started"));
    state = applyConversationV2Effects(
      state,
      store.sync("thread", state.storeEpoch, state.appliedSeq).effects,
    );
    const running = buildConversationV2OnlyProjection(state);
    expect(isThreadContextCompactionInFlight(running, Date.parse("2026-10-07T03:28:40Z"))).toBe(true);
    expect(running.timeline[0]).toMatchObject({
      eventType: "context.compaction.started",
      text: "正在压缩上下文",
      at: "2026-10-07T03:28:39.020Z",
      runAttemptId: "run",
      requestId: compaction("started").requestId,
      streamKey: compaction("started").streamKey,
      metadata: compaction("started").metadata,
    });
    expect(projectionItemToDetailBlock(running.timeline[0]!)).toEqual({
      kind: "phase",
      label: "正在压缩上下文",
      compaction: { lifecycle: "running", startedAt: "2026-10-07T03:28:39.020Z" },
    });
    expect(project(store).timeline).toEqual(running.timeline);

    // Native item completion can arrive after the active run pointer is cleared.
    writer.append({ ...compaction("completed"), runAttemptId: undefined });
    state = applyConversationV2Effects(
      state,
      store.sync("thread", state.storeEpoch, state.appliedSeq).effects,
    );
    const completed = buildConversationV2OnlyProjection(state);
    expect(isThreadContextCompactionInFlight(completed)).toBe(false);
    expect(completed.timeline.at(-1)?.runAttemptId).toBe("run");
    expect(projectionItemToDetailBlock(completed.timeline.at(-1)!)).toMatchObject({
      compaction: {
        lifecycle: "completed",
        startedAt: "2026-10-07T03:28:39.020Z",
        endedAt: "2026-10-07T03:28:52.297Z",
        durationMs: 13_277,
      },
    });
    expect(buildThreadRunProjectionViewModel(completed).mainFeedEntries).toHaveLength(1);
    expect(store.bootstrap("thread").messages).toEqual([]);
    expect(store.bootstrap("thread").runs).toHaveLength(1);
    expect(project(store).timeline).toEqual(completed.timeline);
    const head = store.head("thread").lastSeq;
    expect(writer.append(compaction("started")).duplicate).toBe(true);
    expect(store.head("thread").lastSeq).toBe(head);
    store.rebuildReadModels("thread");
    expect(project(store).timeline).toEqual(completed.timeline);
  } finally {
    db.close();
  }
});

test("failed and suspended compaction remain visible and completion clears suspension", () => {
  const { db, store, writer } = setup();
  try {
    writer.appendBatch([compaction("started"), compaction("failed"), compaction("suspended")]);
    expect(isThreadContextCompactionInFlight(project(store))).toBe(false);
    expect(isThreadAutoCompactSuspended(project(store))).toBe(true);
    expect(project(store).timeline.map((item) => item.eventType)).toEqual([
      "context.compaction.started",
      "context.compaction.failed",
      "context.compaction.suspended",
    ]);
    writer.append(compaction("completed"));
    expect(isThreadAutoCompactSuspended(project(store))).toBe(false);
  } finally {
    db.close();
  }
});

test("child compaction stays in its card and cannot displace the main state from bounded bootstrap", () => {
  const { db, store, writer } = setup();
  try {
    store.append({
      conversationId: "thread",
      eventId: "child-start",
      runId: "run",
      agentId: "child",
      agentInstanceId: "child",
      type: "agent.started",
      occurredAt: "2026-10-07T03:28:01Z",
      payload: { role: "explore", kind: "subagent", status: "running" },
    });
    writer.appendBatch([compaction("started"), compaction("completed")]);
    for (let index = 0; index <= CONVERSATION_V2_MAX_PAGE_SIZE; index++) {
      writer.append({
        ...compaction("started"),
        id: `child-compaction-${index}`,
        agentId: "child",
        role: "explore",
        scope: "agent",
      });
    }
    const bootstrap = store.bootstrap("thread");
    expect(bootstrap.details).toHaveLength(CONVERSATION_V2_MAX_PAGE_SIZE + 1);
    const projection = project(store);
    expect(projection.timeline.map((item) => item.eventType)).toEqual(["context.compaction.completed"]);
    expect(isThreadContextCompactionInFlight(projection, Date.parse("2026-10-07T03:28:40Z"))).toBe(false);
    expect(projection.agents[0]?.timeline).toHaveLength(CONVERSATION_V2_MAX_PAGE_SIZE);
    const small = store.bootstrap("thread", 30, 4_096);
    expect(estimateConversationBytes(small)).toBeLessThanOrEqual(4_096);
    expect(small.details!.filter((detail) => !detail.agentId)).toHaveLength(1);
    expect(small.details!.some((detail) => detail.agentId === "child")).toBe(true);
    expect(JSON.parse(small.details!.find((detail) => !detail.agentId)!.content!).timing.durationMs).toBe(
      13_277,
    );
  } finally {
    db.close();
  }
});

test("compaction counts elapsed time inline while running and retains total duration after reopening", () => {
  const { db, store, writer } = setup();
  const now = spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-07T03:28:44.020Z"));
  const render = () =>
    renderToStaticMarkup(
      createElement(ActivityLogView, {
        conversationV2: installConversationV2Bootstrap(store.bootstrap("thread")),
      }),
    );
  try {
    writer.append(compaction("started"));
    expect(render()).toContain(
      'class="run-log-action-elapsed run-log-action-elapsed--inline">5s</span>',
    );
    now.mockReturnValue(Date.parse("2026-10-07T03:28:45.020Z"));
    expect(render()).toContain(
      'class="run-log-action-elapsed run-log-action-elapsed--inline">6s</span>',
    );
    writer.append(compaction("completed"));
    now.mockReturnValue(Date.parse("2026-10-07T04:00:00Z"));
    expect(render()).toContain(
      'class="run-log-action-elapsed run-log-action-elapsed--inline">13s</span>',
    );
    store.rebuildReadModels("thread");
    expect(render()).toContain(
      'class="run-log-action-elapsed run-log-action-elapsed--inline">13s</span>',
    );
  } finally {
    now.mockRestore();
    db.close();
  }
});

test("compaction duration cannot borrow a start from a different operation, owner or already completed cycle", () => {
  const base = {
    eventType: "context.compaction.started",
    at: "2026-10-07T03:28:39.020Z",
    scope: "main",
    runAttemptId: "run",
    streamKey: "compaction-a",
    requestId: "turn-a",
  };
  const done = { ...base, eventType: "context.compaction.completed", at: "2026-10-07T03:28:52.297Z" };
  expect(resolveContextCompactionTiming(done, [base])).toMatchObject({ durationMs: 13_277 });
  for (const mismatch of [
    { streamKey: "compaction-b" },
    { requestId: "turn-b" },
    { runAttemptId: "other-run" },
    { agentId: "child" },
    { scope: "agent" },
  ]) {
    expect(resolveContextCompactionTiming(done, [{ ...base, ...mismatch }])).toBeUndefined();
  }
  expect(resolveContextCompactionTiming(done, [])).toBeUndefined();
  expect(resolveContextCompactionTiming(done, [base, done])).toBeUndefined();
  expect(resolveContextCompactionTiming({ ...done, at: "2026-10-07T03:28:00Z" }, [base])).toBeUndefined();
  expect(
    resolveContextCompactionTiming({ ...done, eventType: "context.compaction.failed" }, [base]),
  ).toMatchObject({ durationMs: 13_277 });
});

test("compaction with missing ownership fails atomically instead of becoming an invisible receipt", () => {
  const { db, store, writer } = setup();
  try {
    const head = store.head("thread").lastSeq;
    expect(() => writer.append({ ...compaction("started"), runAttemptId: undefined })).toThrow(
      /explicit runAttemptId/,
    );
    expect(store.head("thread").lastSeq).toBe(head);
    expect(store.bootstrap("thread").details).toBeUndefined();
    expect(() => writer.append({ ...compaction("started"), runAttemptId: "missing-run" })).toThrow(
      /has not been started/,
    );
    expect(store.head("thread").lastSeq).toBe(head);
  } finally {
    db.close();
  }
});

test("bootstrap rejects duplicate or malformed compaction details", () => {
  const { db, store, writer } = setup();
  try {
    writer.append(compaction("started"));
    const bootstrap = store.bootstrap("thread");
    const detail = bootstrap.details![0]!;
    expect(() => installConversationV2Bootstrap({ ...bootstrap, details: [detail, detail] })).toThrow(
      /duplicated/,
    );
    expect(() =>
      buildConversationV2OnlyProjection(
        installConversationV2Bootstrap({
          ...bootstrap,
          details: [{ ...detail, content: "{}" }],
        }),
      ),
    ).toThrow(/compaction detail .* is invalid/);
  } finally {
    db.close();
  }
});

test("startup upgrades old Codex receipts once and the recovered Feed survives a read model rebuild", () => {
  const { db, store } = setup();
  try {
    for (const stage of ["started", "completed"] as const) {
      store.append(conversationV2ProviderReceipt({ ...compaction(stage), sequence: 0 }, "runtime-input"));
    }
    expect(project(store).timeline).toEqual([]);
    const originalHead = store.head("thread").lastSeq;
    new ConversationStore(db).initialize();
    expect(store.head("thread").lastSeq).toBe(originalHead + 2);
    expect(project(store).timeline.map((item) => [item.eventType, item.at])).toEqual([
      ["context.compaction.started", "2026-10-07T03:28:39.020Z"],
      ["context.compaction.completed", "2026-10-07T03:28:52.297Z"],
    ]);
    expect(migrateCodexCompactionDetails(db, store)).toBe(0);
    expect(store.head("thread").lastSeq).toBe(originalHead + 2);
    store.rebuildReadModels("thread");
    expect(project(store).timeline).toHaveLength(2);
  } finally {
    db.close();
  }
});

test("failed historical compaction upgrade rolls back facts and remains retryable", () => {
  const { db, store } = setup();
  try {
    store.append(conversationV2ProviderReceipt({ ...compaction("started"), sequence: 0 }, "runtime-input"));
    store.append(
      conversationV2ProviderReceipt(
        {
          ...compaction("completed"),
          runAttemptId: "missing-run",
          sequence: 0,
        },
        "runtime-input",
      ),
    );
    const head = store.head("thread").lastSeq;
    expect(() => migrateCodexCompactionDetails(db, store)).toThrow(/has not been started/);
    expect(store.head("thread").lastSeq).toBe(head);
    expect(project(store).timeline).toEqual([]);
    expect(
      db
        .prepare("SELECT 1 FROM conversation_store_meta_v2 WHERE key = ?")
        .get("codex_context_compaction_details_v1"),
    ).toBeUndefined();
  } finally {
    db.close();
  }
});
