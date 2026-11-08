import { expect, test } from "bun:test";
import type { ConversationStore } from "../src/main/conversation-store";
import { createThreadRunEventLivePersister } from "../src/main/thread-run-event-live-persist";
import { ThreadLiveRequestRegistry } from "../src/main/thread-live-request-registry";

function createPersisterHarness(exists = true) {
  const appended: unknown[] = [];
  const existenceQueries: string[] = [];
  const steps: string[] = [];
  const projectionUpdates: Array<{ threadId: string; options?: { streaming?: boolean } }> = [];
  const store = {
    hasThread: (threadId: string) => {
      existenceQueries.push(threadId);
      return exists;
    },
    appendConversationRuntimeEvent: (event: unknown) => {
      steps.push("persisted");
      appended.push(event);
      return event;
    },
  } as unknown as ConversationStore;

  const persister = createThreadRunEventLivePersister({
    store,
    lifecycle: {} as never,
    metricsRegistry: {} as never,
    liveRequestRegistry: new ThreadLiveRequestRegistry(),
    resolveCurrentRunAttemptId: () => "att_1",
    resolveAgentIdByParentToolUseId: () => undefined,
    emitRequestTerminalEvent: () => {},
    onProjectionUpdated: (threadId, options) => {
      steps.push("notified");
      projectionUpdates.push({ threadId, ...(options ? { options } : {}) });
    },
  });

  return { persister, appended, projectionUpdates, existenceQueries, steps };
}

test("stream deltas persist synchronously before notifying projections", () => {
  const { persister, appended, existenceQueries, steps } = createPersisterHarness();
  for (const message of ["first", "second"]) {
    persister.persistFromLiveEvent({
      threadId: "thr_1", type: "message.delta", displayMessage: message, role: "assistant", stream: true,
    });
  }
  expect(existenceQueries).toEqual(["thr_1", "thr_1"]);
  expect(appended).toHaveLength(2);
  expect(steps).toEqual(["persisted", "notified", "persisted", "notified"]);
});

test("metrics-only updates do not query the database", () => {
  const { persister, existenceQueries } = createPersisterHarness();
  persister.persistFromLiveEvent({
    threadId: "thr_1", type: "thread.usage_updated", displayMessage: "Usage", role: "system", stream: false,
  });
  expect(existenceQueries).toEqual([]);
});

test("missing threads do not persist or notify", () => {
  const { persister, appended, projectionUpdates, existenceQueries } = createPersisterHarness(false);
  persister.persistFromLiveEvent({
    threadId: "deleted", type: "thread.completed", displayMessage: "Done", role: "system", stream: false,
  });
  expect(existenceQueries).toEqual(["deleted"]);
  expect(appended).toEqual([]);
  expect(projectionUpdates).toEqual([]);
});

test("shadow request starts need no thread query", () => {
  const { persister, existenceQueries } = createPersisterHarness();
  persister.persistFromLiveEvent({
    threadId: "thr_1", type: "request.started", displayMessage: "Start", role: "system", stream: false,
  });
  expect(existenceQueries).toEqual([]);
});

test("persistFromLiveEvent still schedules projection for omitted thread.completed", () => {
  const { persister, appended, projectionUpdates } = createPersisterHarness();

  persister.persistFromLiveEvent({
    threadId: "thr_1",
    type: "thread.completed",
    displayMessage: "状态已更新",
    role: "system",
    stream: false,
  });

  expect(appended).toEqual([]);
  expect(projectionUpdates).toEqual([{ threadId: "thr_1", options: { streaming: false } }]);
});

test("persistFromLiveEvent still schedules projection for omitted thread.started", () => {
  const { persister, appended, projectionUpdates } = createPersisterHarness();

  persister.persistFromLiveEvent({
    threadId: "thr_1",
    type: "thread.started",
    displayMessage: "状态已更新",
    role: "system",
    stream: false,
  });

  expect(appended).toEqual([]);
  expect(projectionUpdates).toEqual([{ threadId: "thr_1", options: { streaming: false } }]);
});
