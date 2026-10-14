import { expect, test } from "bun:test";
import type { AcpAgentDriver } from "@eco/runtime";
import type { WorktreePlan } from "@eco/workspace";
import {
  ACP_MAX_ATTEMPTS,
  type AcpRuntimeOrchestrationDeps,
  type AcpThreadStartRunInput,
  MAX_ACP_AUTORETRIES,
  resolveAcprAutoRetry,
  startAcpThreadRunWithDriver,
} from "../src/main/acp-runtime-run";
import type { RequestAttemptResult } from "../src/main/request-retry";
import { consumeSdkRunEvents, type SdkRunEventLike } from "../src/main/sdk-run-event-loop";

const KEEPALIVE_ERROR = "Error: RetriableError: [internal] HTTP/2 keepalive ping timed out after 5000ms";

/** Unstarted retriable failure result (the keepalive ping timeout case). */
const retriableUnstarted: RequestAttemptResult = {
  ok: false,
  reason: KEEPALIVE_ERROR,
  unstarted: true,
};

test("resolveAcprAutoRetry gates on unstarted retriable failures only", () => {
  const base = { attempt: 1, maxAttempts: ACP_MAX_ATTEMPTS, aborted: false };
  expect(resolveAcprAutoRetry({ ...base, result: retriableUnstarted })).toBe(true);
  expect(
    resolveAcprAutoRetry({
      ...base,
      attempt: ACP_MAX_ATTEMPTS,
      result: retriableUnstarted,
    }),
  ).toBe(false);
  expect(resolveAcprAutoRetry({ ...base, aborted: true, result: retriableUnstarted })).toBe(false);
  expect(resolveAcprAutoRetry({ ...base, result: { ok: true } })).toBe(false);
  expect(
    resolveAcprAutoRetry({
      ...base,
      result: { ok: false, reason: "cancelled by user", aborted: true, unstarted: true },
    }),
  ).toBe(false);
  expect(
    resolveAcprAutoRetry({
      ...base,
      result: { ok: false, reason: KEEPALIVE_ERROR, incomplete: true, unstarted: true },
    }),
  ).toBe(false);
  expect(
    resolveAcprAutoRetry({
      ...base,
      result: { ok: false, reason: KEEPALIVE_ERROR },
    }),
  ).toBe(false);
  expect(
    resolveAcprAutoRetry({
      ...base,
      result: { ok: false, reason: "Cursor ACP session/new failed: boom", unstarted: true },
    }),
  ).toBe(false);
  expect(
    resolveAcprAutoRetry({
      ...base,
      result: {
        ok: false,
        reason: "Error: RetriableError: [resource_exhausted] Error",
        unstarted: true,
      },
    }),
  ).toBe(true);
});

type FakeTerminalPayload = { status: "completed" } | { status: "failed"; error: string; unstarted?: boolean };

type FakeDriver = {
  run(input: { threadId: string; signal?: AbortSignal }): AsyncGenerator<SdkRunEventLike, void, unknown>;
  runs: number;
  disposed: number;
};

function terminalEvent(
  threadId: string,
  index: number,
  payload: SdkRunEventLike["payload"],
): SdkRunEventLike {
  return {
    id: `${threadId}:acp:fake:${index}`,
    threadId,
    agentId: "planner",
    role: "planner",
    type: "run.terminal",
    payload,
  };
}

/** Fake ACP driver: replays the given terminals per run; records dispose calls. */
function makeFakeDriver(terminals: FakeTerminalPayload[]): AcpAgentDriver {
  const state = { runs: 0, disposed: 0, prompts: [] as string[], userPromptsForPlan: [] as string[] };
  const fake = {
    run(input: { threadId: string; signal?: AbortSignal; prompt: string; userPromptForPlan: string }): AsyncGenerator<SdkRunEventLike, void, unknown> {
      const index = state.runs;
      state.runs += 1;
      state.prompts.push(input.prompt);
      state.userPromptsForPlan.push(input.userPromptForPlan);
      const payload: SdkRunEventLike["payload"] = input.signal?.aborted
        ? { status: "cancelled", reason: "cancelled by user" }
        : (terminals[Math.min(index, terminals.length - 1)] ?? { status: "completed" });
      return (async function* () {
        yield terminalEvent(input.threadId, index, payload);
      })();
    },
    cancel(): boolean {
      return true;
    },
    dispose(): boolean {
      state.disposed += 1;
      return true;
    },
    disposeAll(): number {
      return 0;
    },
  };
  // Expose run counters for assertions; the driver API cast is test-only.
  (fake as unknown as { state: typeof state }).state = state;
  return fake as unknown as AcpAgentDriver & { state: typeof state };
}

type Calls = {
  runOnce: number;
  retryIndices: number[];
  notify: { threadId: string; attempt: number; maxAttempts: number; reason: string }[];
  markInterrupted: string[];
  discard: { restorePrompt: string; recordedUserActivityLineId?: string } | undefined;
  decision: { kind: string } | undefined;
};

function makeDeps(calls: Calls, driver: AcpAgentDriver): AcpRuntimeOrchestrationDeps {
  return {
    requireThreadCore: () => {},
    resolveSessionMode: () => "agent",
    startActiveRun: () => {},
    createSessionPlan: () => ({}) as WorktreePlan,
    runThreadRequestOnce: async (_threadId, _phase, _signal, run, retryIndex = 0) => {
      calls.runOnce += 1;
      calls.retryIndices.push(retryIndex);
      return run();
    },
    consumeEvents: ({ events, threadId, worktreePath, signal }) =>
      consumeSdkRunEvents({
        events: events as AsyncIterable<SdkRunEventLike>,
        threadId,
        worktreePath,
        signal,
        onUsageRecorded: () => {},
        captureSession: () => {},
        emitActivity: () => {},
      }),
    updateThread: () => {},
    markInterrupted: (_threadId, reason) => {
      calls.markInterrupted.push(reason);
    },
    finalizeCleanup: async () => {},
    captureSession: () => {},
    getThreadCoreSession: () => undefined,
    hasStoredPendingPlan: () => false,
    releasePlanBridgeKeepPending: () => {},
    applyRunDecision: async (input) => {
      calls.decision = input.decision;
    },
    discardUnstartedTurn: async (input) => {
      calls.discard = {
        restorePrompt: input.restorePrompt,
        ...(input.recordedUserActivityLineId
          ? { recordedUserActivityLineId: input.recordedUserActivityLineId }
          : {}),
      };
    },
    errorMessage: (error) => String(error),
    loadSessionFailedMessage: (detail) => detail,
    cannotResumeWithoutSessionMessage: () => "cannot resume",
    threadHasPriorAgentOutput: () => false,
    notifyAcprAutoRetry: (input) => {
      calls.notify.push(input);
    },
  };
}

function makeInput(overrides: Partial<AcpThreadStartRunInput> = {}): AcpThreadStartRunInput {
  return {
    thread: { id: "t1", coreKind: "acp" } as AcpThreadStartRunInput["thread"],
    workspace: { path: "/tmp/ws" } as AcpThreadStartRunInput["workspace"],
    prompt: "hello",
    ...overrides,
  };
}

test("ACP receives the prepared MCP directory before the resolved user prompt", async () => {
  const driver = makeFakeDriver([{ status: "completed" }]);
  const calls: Calls = { runOnce: 0, retryIndices: [], notify: [], markInterrupted: [], discard: undefined, decision: undefined };
  const deps = makeDeps(calls, driver);
  let prepared = false;
  deps.resolveAcpMcpServers = async () => { prepared = true; return []; };
  deps.resolveAcpSystemPromptAppend = ({ threadId }) => {
    expect(prepared).toBe(true);
    expect(threadId).toBe("t1");
    return "External MCP: database — query records";
  };
  deps.resolvePromptImagesForMainContext = async () => "resolved user prompt";
  await startAcpThreadRunWithDriver(makeInput(), deps, driver);
  const state = (driver as unknown as { state: { prompts: string[]; userPromptsForPlan: string[] } }).state;
  expect(state.prompts).toEqual(["External MCP: database — query records\n\nresolved user prompt"]);
  expect(state.userPromptsForPlan).toEqual(["hello"]);
});

test("auto-retries once on unstarted keepalive failure, then completes", async () => {
  const driver = makeFakeDriver([
    { status: "failed", error: KEEPALIVE_ERROR, unstarted: true },
    { status: "completed" },
  ]);
  const calls: Calls = {
    runOnce: 0,
    retryIndices: [],
    notify: [],
    markInterrupted: [],
    discard: undefined,
    decision: undefined,
  };
  await startAcpThreadRunWithDriver(makeInput(), makeDeps(calls, driver), driver);

  expect(calls.runOnce).toBe(2);
  expect(calls.retryIndices).toEqual([0, 1]);
  expect(calls.notify).toEqual([
    { attempt: 1, maxAttempts: ACP_MAX_ATTEMPTS, reason: KEEPALIVE_ERROR, threadId: "t1" },
  ]);
  expect(calls.decision).toEqual({ kind: "completed" });
  expect(calls.discard).toBeUndefined();
  expect(calls.markInterrupted).toEqual([]);
  expect((driver as unknown as { state: { disposed: number } }).state.disposed).toBe(0);
});

test("a durable command dispatch never issues an ACP automatic retry", async () => {
  const driver = makeFakeDriver([
    { status: "failed", error: KEEPALIVE_ERROR, unstarted: true },
    { status: "completed" },
  ]);
  const calls: Calls = {
    runOnce: 0,
    retryIndices: [],
    notify: [],
    markInterrupted: [],
    discard: undefined,
    decision: undefined,
  };
  const deps = makeDeps(calls, driver);
  const originalRunOnce = deps.runThreadRequestOnce;
  deps.runThreadRequestOnce = async (...args) => {
    expect(args[5]).toEqual({
      plannedAttemptId: "attempt_command_1",
      commandDispatch: {
        principalId: "principal_1",
        clientCommandId: "command_1",
        dispatchId: "dispatch_1",
      },
    });
    return originalRunOnce(...args);
  };

  await startAcpThreadRunWithDriver(
    makeInput({
      runtimeDispatch: {
        plannedAttemptId: "attempt_command_1",
        commandDispatch: {
          principalId: "principal_1",
          clientCommandId: "command_1",
          dispatchId: "dispatch_1",
        },
      },
    }),
    deps,
    driver,
  );

  expect(calls.runOnce).toBe(1);
  expect(calls.retryIndices).toEqual([0]);
  expect(calls.notify).toEqual([]);
  expect(calls.discard).toBeUndefined();
  expect(calls.markInterrupted).toEqual([KEEPALIVE_ERROR]);
  expect((driver as unknown as { state: { runs: number } }).state.runs).toBe(1);
});

test("exhausts retries then falls back to discardUnstartedTurn", async () => {
  const driver = makeFakeDriver([{ status: "failed", error: KEEPALIVE_ERROR, unstarted: true }]);
  const calls: Calls = {
    runOnce: 0,
    retryIndices: [],
    notify: [],
    markInterrupted: [],
    discard: undefined,
    decision: undefined,
  };
  await startAcpThreadRunWithDriver(
    makeInput({
      restorePrompt: "hello",
      recordedUserActivityLineId: "line-1",
    }),
    makeDeps(calls, driver),
    driver,
  );

  expect(calls.runOnce).toBe(ACP_MAX_ATTEMPTS);
  expect(calls.retryIndices).toEqual([0, 1, 2]);
  expect(calls.notify.length).toBe(MAX_ACP_AUTORETRIES);
  expect(calls.discard).toEqual({ restorePrompt: "hello", recordedUserActivityLineId: "line-1" });
  expect(calls.decision).toBeUndefined();
  expect(calls.markInterrupted).toEqual([]);
  expect((driver as unknown as { state: { disposed: number } }).state.disposed).toBe(0);
});

test("does not retry non-retriable failures (original discard path)", async () => {
  const driver = makeFakeDriver([
    { status: "failed", error: "Cursor ACP session/new failed: boom", unstarted: true },
  ]);
  const calls: Calls = {
    runOnce: 0,
    retryIndices: [],
    notify: [],
    markInterrupted: [],
    discard: undefined,
    decision: undefined,
  };
  await startAcpThreadRunWithDriver(makeInput(), makeDeps(calls, driver), driver);

  expect(calls.runOnce).toBe(1);
  expect(calls.notify).toEqual([]);
  expect(calls.discard).toEqual({ restorePrompt: "hello" });
  expect(calls.decision).toBeUndefined();
});

test("does not retry failures with turn progress (blocked + manual retry)", async () => {
  const driver = makeFakeDriver([{ status: "failed", error: KEEPALIVE_ERROR }]);
  const calls: Calls = {
    runOnce: 0,
    retryIndices: [],
    notify: [],
    markInterrupted: [],
    discard: undefined,
    decision: undefined,
  };
  await startAcpThreadRunWithDriver(makeInput(), makeDeps(calls, driver), driver);

  expect(calls.runOnce).toBe(1);
  expect(calls.notify).toEqual([]);
  expect(calls.discard).toBeUndefined();
  expect(calls.markInterrupted).toEqual([KEEPALIVE_ERROR]);
  // failed → markInterrupted only (no applyRunDecision on the failure path).
  expect(calls.decision).toBeUndefined();
});

test("aborted run (steer landed in the gap) is never retried", async () => {
  const controller = new AbortController();
  const driver = makeFakeDriver([{ status: "failed", error: KEEPALIVE_ERROR, unstarted: true }]);
  const calls: Calls = {
    runOnce: 0,
    retryIndices: [],
    notify: [],
    markInterrupted: [],
    discard: undefined,
    decision: undefined,
  };
  const deps = makeDeps(calls, driver);
  // Steer = cancel + resume: the in-flight run's signal aborts before the
  // attempt settles, so the retry gate must not fire.
  const realConsume = deps.consumeEvents;
  controller.abort();
  deps.consumeEvents = (entry) => realConsume({ ...entry, signal: controller.signal });
  await startAcpThreadRunWithDriver(makeInput(), deps, driver);

  expect(calls.runOnce).toBe(1);
  expect(calls.notify).toEqual([]);
  expect(calls.discard).toBeUndefined();
  expect(calls.markInterrupted).toEqual([]);
  expect(calls.decision).toEqual({ kind: "cancelled", reason: "cancelled by user" });
});
