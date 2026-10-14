import { expect, test } from "bun:test";
import { DatabaseSync } from "node:sqlite";
import { CONVERSATION_V2_ERROR } from "@eco/shared";
import {
  executeThreadCancelCommand,
  failInterruptedCancelCommands,
} from "../src/main/conversation-cancel-command";
import { ConversationV2Store } from "../src/main/conversation-v2-store";
import { buildConversationV2CommandEnvelope } from "../src/renderer/conversation-v2-command-envelope";
import type { ThreadCancelRequest } from "../src/shared/ipc";

function harness() {
  const db = new DatabaseSync(":memory:");
  const v2 = new ConversationV2Store(db);
  v2.initialize();
  v2.ensureConversation("thread_cancel");
  const input: ThreadCancelRequest = {
    principalId: "principal_cancel",
    clientCommandId: "cancel_1",
    threadId: "thread_cancel",
    expectedHistoryRevision: 0,
  };
  let calls = 0;
  const deps = {
    v2,
    cancel: async () => {
      calls += 1;
    },
    errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
  };
  return { db, v2, input, deps, calls: () => calls };
}

test("thread cancellation is durable and idempotent after response loss", async () => {
  const state = harness();
  await expect(executeThreadCancelCommand(state.input, state.deps)).resolves.toEqual({
    ok: true,
    alreadyCancelled: false,
  });
  await expect(executeThreadCancelCommand(state.input, state.deps)).resolves.toEqual({
    ok: true,
    alreadyCancelled: true,
  });
  expect(state.calls()).toBe(1);
  expect(
    state.v2.getCommandJob(state.input.principalId, state.input.threadId, state.input.clientCommandId),
  ).toMatchObject({
    commandType: "run.cancel",
    status: "completed",
    request: { threadId: state.input.threadId },
    result: { ok: true, threadId: state.input.threadId },
  });
  state.db.close();
});

test("Stop after resuming at the same history revision cancels again; a transport retry stays idempotent", async () => {
  const state = harness();
  const command = () =>
    buildConversationV2CommandEnvelope({
      threadId: state.input.threadId,
      operation: "run_cancel",
      payload: {},
      getHead: async () => ({ historyRevision: 0 }),
    });
  const first = await command();
  await executeThreadCancelCommand(first, state.deps);
  await executeThreadCancelCommand(first, state.deps);
  expect(state.calls()).toBe(1);
  const afterResume = await command();
  expect(afterResume.clientCommandId).not.toBe(first.clientCommandId);
  await executeThreadCancelCommand(afterResume, state.deps);
  expect(state.calls()).toBe(2);
  state.db.close();
});

test("thread cancellation fails closed when a command id is already running", async () => {
  const state = harness();
  const accepted = state.v2.acceptCommand({
    principalId: state.input.principalId,
    conversationId: state.input.threadId,
    clientCommandId: state.input.clientCommandId,
    commandType: "run.cancel",
    request: { threadId: state.input.threadId },
    expectedHistoryRevision: 0,
  });
  state.v2.beginCommandExecution(accepted.principalId, accepted.conversationId, accepted.clientCommandId);
  await expect(executeThreadCancelCommand(state.input, state.deps)).rejects.toMatchObject({
    code: CONVERSATION_V2_ERROR.integrityFailure,
  });
  expect(state.calls()).toBe(0);
  state.db.close();
});

test("runtime cancellation errors are durably recorded", async () => {
  const state = harness();
  const error = new Error("runtime did not stop");
  const deps = {
    ...state.deps,
    cancel: async () => {
      throw error;
    },
  };
  await expect(executeThreadCancelCommand(state.input, deps)).rejects.toBe(error);
  expect(
    state.v2.getCommandJob(state.input.principalId, state.input.threadId, state.input.clientCommandId),
  ).toMatchObject({ status: "failed", error: { code: "cancel_failed", message: error.message } });
  state.db.close();
});

test("startup fails accepted and running cancellation commands without replaying them", () => {
  const state = harness();
  const accepted = state.v2.acceptCommand({
    principalId: state.input.principalId,
    conversationId: state.input.threadId,
    clientCommandId: "cancel_accepted",
    commandType: "run.cancel",
    request: { threadId: state.input.threadId },
    expectedHistoryRevision: 0,
  });
  const running = state.v2.acceptCommand({
    principalId: state.input.principalId,
    conversationId: state.input.threadId,
    clientCommandId: "cancel_running",
    commandType: "run.cancel",
    request: { threadId: state.input.threadId },
    expectedHistoryRevision: 0,
  });
  state.v2.beginCommandExecution(running.principalId, running.conversationId, running.clientCommandId);

  expect(failInterruptedCancelCommands(state.v2)).toBe(2);
  for (const clientCommandId of [accepted.clientCommandId, running.clientCommandId]) {
    expect(
      state.v2.getCommandJob(state.input.principalId, state.input.threadId, clientCommandId),
    ).toMatchObject({
      status: "failed",
      error: { code: "cancel_outcome_unknown" },
    });
  }
  expect(state.calls()).toBe(0);
  state.db.close();
});
