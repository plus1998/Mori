import { expect, test } from "bun:test";
import { createElectronEventSink, DesktopEventCenter } from "../src/main/event-center";
import { ConversationV2Error, CONVERSATION_V2_ERROR } from "@eco/shared";
import {
  classifyThreadLiveEventForCenter,
  EVENT_CENTER_JSON_RPC_ERROR,
  EVENT_CENTER_JSON_RPC_METHODS,
  IPC_CHANNELS,
  type ThreadLiveEvent,
} from "../src/shared/ipc";

const fixedNow = () => new Date("2026-01-01T00:00:00.000Z");

function makeThreadEvent(input: Partial<ThreadLiveEvent> = {}): ThreadLiveEvent {
  return {
    threadId: "thr_event_center",
    type: "thread.running",
    message: "running",
    role: "system",
    stream: false,
    ...input,
  };
}

test("classifies thread live events for event center topics", () => {
  expect(
    classifyThreadLiveEventForCenter(
      makeThreadEvent({
        type: "thread.awaiting_plan",
        plan: {
          userPrompt: "build it",
          analysis: "needs plan",
          plan: "1. implement",
        },
      }),
    ),
  ).toBe("thread.plan");

  expect(
    classifyThreadLiveEventForCenter(
      makeThreadEvent({
        type: "clarification.requested",
        clarification: {
          toolUseId: "toolu_question",
          threadId: "thr_event_center",
          questions: [],
        },
      }),
    ),
  ).toBe("thread.clarification");

  expect(
    classifyThreadLiveEventForCenter(
      makeThreadEvent({
        type: "thread.run_projection_updated",
      }),
    ),
  ).toBe("thread.lifecycle");

  expect(classifyThreadLiveEventForCenter(makeThreadEvent({ stream: true }))).toBe("thread.stream");

  expect(
    classifyThreadLiveEventForCenter(
      makeThreadEvent({
        type: "thread.execution_failed",
        message: "fetch failed",
      }),
    ),
  ).toBe("thread.lifecycle");

  expect(
    classifyThreadLiveEventForCenter(
      makeThreadEvent({
        type: "thread.plan_cleared",
        message: "plan cleared",
      }),
    ),
  ).toBe("thread.plan");
});

test("publishes settings updates with a global aggregate key", () => {
  const center = new DesktopEventCenter({ now: fixedNow, idPrefix: "test_evt" });
  const seen: unknown[] = [];
  center.subscribe({
    publish(envelope, notification) {
      seen.push({ envelope, notification });
    },
  });

  const envelope = center.publishSettingsUpdated({
    threadId: "settings",
    type: "settings.updated",
    message: "Model provider settings saved.",
  });

  expect(envelope.kind).toBe("settings.updated");
  expect(envelope.aggregateKey).toBe("settings:global");
  expect(envelope.threadId).toBeUndefined();
  expect(seen).toHaveLength(1);
});

test("publishes center envelopes and JSON-RPC event notifications", () => {
  const center = new DesktopEventCenter({ now: fixedNow, idPrefix: "test_evt" });
  const seen: unknown[] = [];
  center.subscribe({
    publish(envelope, notification) {
      seen.push({ envelope, notification });
    },
  });

  const envelope = center.publishThreadLiveEvent(
    makeThreadEvent({
      type: "clarification.requested",
      message: "Planner needs answers.",
      clarification: {
        toolUseId: "toolu_question",
        threadId: "thr_event_center",
        questions: [],
      },
    }),
    "/repo/app",
  );

  expect(envelope.kind).toBe("thread.clarification");
  expect(envelope.threadId).toBe("thr_event_center");
  expect(envelope.aggregateKey).toBe("thread:thr_event_center");
  expect(envelope.workspacePath).toBe("/repo/app");
  expect(envelope.occurredAt).toBe("2026-01-01T00:00:00.000Z");
  expect(seen).toHaveLength(1);
  expect((seen[0] as { notification: { method: string } }).notification.method).toBe(
    EVENT_CENTER_JSON_RPC_METHODS.event,
  );
});

test("publishes committed conversation effects as durable-sync hints", () => {
  const center = new DesktopEventCenter({ now: fixedNow, idPrefix: "test_evt" });
  const seen: unknown[] = [];
  center.subscribe({
    publish(envelope) {
      seen.push(envelope);
    },
  });

  const envelope = center.publish({
    kind: "conversation.sync_effect",
    threadId: "thr_event_center",
    aggregateKey: "conversation:thr_event_center",
    payload: {
      conversationId: "thr_event_center",
      storeEpoch: "epoch_1",
      effect: {
        seq: 1,
        effectVersion: 1,
        effectHash: "hash_1",
        effect: { type: "noop", reason: "fixture" },
      },
    },
  });

  expect(envelope.kind).toBe("conversation.sync_effect");
  expect(seen).toHaveLength(1);
});

test("electron sink routes workspace Git updates independently of thread events", () => {
  const center = new DesktopEventCenter({ now: fixedNow, idPrefix: "test_evt" });
  const sent: Array<{ channel: string; payload: unknown }> = [];
  center.subscribe(
    createElectronEventSink((channel, payload) => {
      sent.push({ channel, payload });
    }),
  );

  center.publishTerminalEvent({ type: "output", sessionId: "term_1", data: "ready" });
  center.publishPackageJsonChanged("/repo/app");
  center.publishGitStatusChanged({
    workspacePath: "/repo/app",
    dirtyFileCount: 2,
    insertions: 10,
    deletions: 3,
  });
  center.publishThreadLiveEvent(makeThreadEvent({ type: "thread.completed", message: "done" }));

  expect(sent[0]).toEqual({
    channel: IPC_CHANNELS.terminalEvent,
    payload: { type: "output", sessionId: "term_1", data: "ready" },
  });
  expect(sent[1]).toEqual({
    channel: IPC_CHANNELS.workspacePackageJsonChanged,
    payload: "/repo/app",
  });
  expect(sent[2]).toEqual({
    channel: IPC_CHANNELS.gitStatusChanged,
    payload: {
      workspacePath: "/repo/app",
      dirtyFileCount: 2,
      insertions: 10,
      deletions: 3,
    },
  });
  expect(sent[3]).toEqual({
    channel: IPC_CHANNELS.threadEventsSubscribe,
    payload: makeThreadEvent({ type: "thread.completed", message: "done" }),
  });
  center.publishGitDiffChanged({ workspacePath: "/repo/app", revision: 2, changedPaths: ["file.ts"] });
  expect(sent[4]).toEqual({ channel: IPC_CHANNELS.gitDiffChanged,
    payload: { workspacePath: "/repo/app", revision: 2, changedPaths: ["file.ts"] } });
});

test("handles JSON-RPC invoke requests through registered desktop commands", async () => {
  const center = new DesktopEventCenter({ now: fixedNow, idPrefix: "test_evt" });
  center.registerCommand(IPC_CHANNELS.threadList, () => [{ id: "thr_1" }]);

  const response = await center.handleJsonRpcMessage({
    jsonrpc: "2.0",
    id: "req_1",
    method: EVENT_CENTER_JSON_RPC_METHODS.invoke,
    params: {
      channel: IPC_CHANNELS.threadList,
      args: [],
      caller: "mobile",
    },
  });

  expect(response).toMatchObject({
    jsonrpc: "2.0",
    id: "req_1",
    result: {
      channel: IPC_CHANNELS.threadList,
      result: [
        {
          id: "thr_1",
          prompt: "",
          message: "",
        },
      ],
    },
  });
});

test("rejects commands that are not remote-enabled", async () => {
  const center = new DesktopEventCenter({ now: fixedNow, idPrefix: "test_evt" });

  expect(() => center.registerCommand(IPC_CHANNELS.centerServerSignIn, () => undefined)).toThrow(
    "Event center command is not remote-enabled",
  );

  const response = await center.handleJsonRpcMessage({
    jsonrpc: "2.0",
    id: "req_1",
    method: EVENT_CENTER_JSON_RPC_METHODS.invoke,
    params: {
      channel: IPC_CHANNELS.centerServerSignIn,
      args: [],
    },
  });

  expect(response).toEqual({
    jsonrpc: "2.0",
    id: "req_1",
    error: {
      code: EVENT_CENTER_JSON_RPC_ERROR.methodNotFound,
      message: `Desktop command is not remote-enabled: ${IPC_CHANNELS.centerServerSignIn}`,
    },
  });
});

test("validates remote command args before invoking handlers", async () => {
  const center = new DesktopEventCenter({ now: fixedNow, idPrefix: "test_evt" });
  let called = false;
  center.registerCommand(IPC_CHANNELS.threadStart, () => {
    called = true;
    return { thread: { id: "thr_1" } };
  });

  const response = await center.handleJsonRpcMessage({
    jsonrpc: "2.0",
    id: "req_1",
    method: EVENT_CENTER_JSON_RPC_METHODS.invoke,
    params: {
      channel: IPC_CHANNELS.threadStart,
      args: [],
    },
  });

  expect(called).toBe(false);
  expect(response).toMatchObject({
    jsonrpc: "2.0",
    id: "req_1",
    error: {
      code: EVENT_CENTER_JSON_RPC_ERROR.invalidParams,
    },
  });
});

test("reports unregistered JSON-RPC commands explicitly", async () => {
  const center = new DesktopEventCenter({ now: fixedNow, idPrefix: "test_evt" });

  const response = await center.handleJsonRpcMessage({
    jsonrpc: "2.0",
    id: 2,
    method: EVENT_CENTER_JSON_RPC_METHODS.invoke,
    params: {
      channel: IPC_CHANNELS.threadStart,
      args: [{ workspacePath: "/repo", prompt: "ship it", runtimeConfig: {} }],
    },
  });

  expect(response).toEqual({
    jsonrpc: "2.0",
    id: 2,
    error: {
      code: EVENT_CENTER_JSON_RPC_ERROR.methodNotFound,
      message: `Desktop command is not registered: ${IPC_CHANNELS.threadStart}`,
    },
  });
});

test("keeps V2 domain error codes in JSON-RPC data", async () => {
  const center = new DesktopEventCenter({ now: fixedNow, idPrefix: "test_evt" });
  center.registerCommand(IPC_CHANNELS.conversationHead, () => {
    throw new ConversationV2Error(CONVERSATION_V2_ERROR.epochMismatch, "epoch changed", {
      expected: "epoch_2",
    });
  });

  const response = await center.handleJsonRpcMessage({
    jsonrpc: "2.0",
    id: "req_v2_error",
    method: EVENT_CENTER_JSON_RPC_METHODS.invoke,
    params: {
      channel: IPC_CHANNELS.conversationHead,
      args: ["thread_1"],
    },
  });

  expect(response).toMatchObject({
    error: {
      code: EVENT_CENTER_JSON_RPC_ERROR.invalidParams,
      data: { conversationCode: CONVERSATION_V2_ERROR.epochMismatch, expected: "epoch_2" },
    },
  });
});

test("reports malformed JSON-RPC payloads explicitly", async () => {
  const center = new DesktopEventCenter({ now: fixedNow, idPrefix: "test_evt" });
  const response = await center.handleJsonRpcMessage("{bad json");

  expect(response).toMatchObject({
    jsonrpc: "2.0",
    id: null,
    error: {
      code: EVENT_CENTER_JSON_RPC_ERROR.parseError,
      message: "Invalid JSON-RPC JSON payload.",
    },
  });
});

test("schedule changes reach desktop and paired mobile through one event", () => {
  const center = new DesktopEventCenter({ now: fixedNow });
  const sent: { channel: string; payload: unknown }[] = [];
  const remote: unknown[] = [];
  center.subscribe(createElectronEventSink((channel, payload) => sent.push({ channel, payload })));
  center.subscribe({ publish(_envelope, notification) { remote.push(notification); } });
  center.publish({ kind: "scheduling.changed", payload: {}, aggregateKey: "scheduling:global" });
  expect(sent).toEqual([{ channel: IPC_CHANNELS.schedulingChanged, payload: undefined }]);
  expect(remote).toMatchObject([{ params: { kind: "scheduling.changed", payload: {}, aggregateKey: "scheduling:global" } }]);
});

test("todo updates notify desktop panels and paired phones without entering thread streams", () => {
  const center = new DesktopEventCenter({ now: fixedNow });
  const sent: { channel: string; payload: unknown }[] = [];
  const remote: unknown[] = [];
  center.subscribe(createElectronEventSink((channel, payload) => sent.push({ channel, payload })));
  center.subscribe({ publish(_envelope, notification) { remote.push(notification); } });
  center.publish({ kind: "project-todo.changed", payload: {}, aggregateKey: "project-todos:global" });
  expect(sent).toEqual([{ channel: IPC_CHANNELS.projectTodoChanged, payload: undefined }]);
  expect(remote).toMatchObject([{ params: { kind: "project-todo.changed", payload: {} } }]);
});
