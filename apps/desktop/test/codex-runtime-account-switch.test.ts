import { afterEach, expect, test } from "bun:test";
import {
  type CodexRuntimeLifecycle,
  setGlobalCodexRuntimeLifecycle,
} from "../src/main/codex-runtime-lifecycle";
import {
  configureCodexRuntimeRun,
  prepareCodexRuntime,
  requestCodexAccountRuntimeRestart,
  scheduleCodexGlobalRuntimeRefresh,
  shutdownCodexGlobalRuntimeRefresh,
} from "../src/main/codex-runtime-run";
import type { CodexThreadMap } from "../src/main/codex-thread-map";

let releaseFakeActiveTurn: (() => void) | undefined;

test("thread and integration settings cannot force a process restart", () => {
  expect(() => requestCodexAccountRuntimeRestart("thread_runtime" as never)).toThrow("Only account");
  expect(() => requestCodexAccountRuntimeRestart("mcp" as never)).toThrow("Only account");
});

afterEach(async () => {
  releaseFakeActiveTurn?.();
  releaseFakeActiveTurn = undefined;
  await shutdownCodexGlobalRuntimeRefresh();
  setGlobalCodexRuntimeLifecycle(undefined);
});

function configureRefreshTest(onStderr?: (message: string) => void): void {
  configureCodexRuntimeRun({
    ecoDataDir: "/tmp/eco-codex-runtime-account-switch-test",
    listProviders: () => [],
    threadMap: {} as CodexThreadMap,
    appendConversationRuntimeEvent: () => {},
    scheduleThreadRunProjectionUpdated: () => {},
    ...(onStderr ? { onStderr } : {}),
  });
}

async function expectShutdownToFinish(shutdown: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      shutdown,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("shutdown is still waiting for idle")), 500);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

test("account transition waits for an active Codex turn and blocks new runtime preparation", async () => {
  let active = true;
  let transitionRan = false;
  let transitionSawIdle = false;
  let markBusy!: () => void;
  const busyObserved = new Promise<void>((resolve) => {
    markBusy = resolve;
  });
  const client = {
    isInitialized: true,
    async request(method: string) {
      if (method === "thread/loaded/list") return { data: ["codex-active"] };
      if (method === "thread/read") {
        return { thread: { status: { type: active ? "active" : "idle" } } };
      }
      throw new Error(`Unexpected fake app-server request: ${method}`);
    },
  };
  releaseFakeActiveTurn = () => {
    active = false;
  };
  setGlobalCodexRuntimeLifecycle({ getClient: () => client } as unknown as CodexRuntimeLifecycle);
  configureCodexRuntimeRun({
    ecoDataDir: "/tmp/eco-codex-runtime-account-switch-test",
    listProviders: () => [],
    threadMap: {} as CodexThreadMap,
    appendConversationRuntimeEvent: () => {},
    scheduleThreadRunProjectionUpdated: () => {},
    onStderr: (message) => {
      if (message.includes("waiting to refresh global runtime")) markBusy();
    },
  });

  requestCodexAccountRuntimeRestart("account");
  scheduleCodexGlobalRuntimeRefresh({
    beforePrepare: async () => {
      transitionRan = true;
      transitionSawIdle = !active;
      // Stop before config materialization: this test exercises the scheduler's
      // active-turn gate without launching a Codex CLI process.
      throw new Error("test-only stop before runtime preparation");
    },
  });
  await busyObserved;

  const blockedTaskPreparation = prepareCodexRuntime().then(
    () => undefined,
    (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
  );
  await new Promise((resolve) => setTimeout(resolve, 25));
  expect(transitionRan).toBe(false);

  active = false;
  const preparationError = await blockedTaskPreparation;
  expect(transitionRan).toBe(true);
  expect(transitionSawIdle).toBe(true);
  expect(preparationError?.message).toBe("test-only stop before runtime preparation");
});

test("shutdown interrupts the queued refresh while a Codex turn remains active", async () => {
  let active = true;
  let transitionRan = false;
  let markBusy!: () => void;
  const busy = new Promise<void>((resolve) => {
    markBusy = resolve;
  });
  const errors: string[] = [];
  const client = {
    isInitialized: true,
    async request(method: string) {
      if (method === "thread/loaded/list") return { data: ["codex-active"] };
      return { thread: { status: { type: active ? "active" : "idle" } } };
    },
  };
  releaseFakeActiveTurn = () => {
    active = false;
  };
  setGlobalCodexRuntimeLifecycle({ getClient: () => client } as unknown as CodexRuntimeLifecycle);
  configureRefreshTest((message) => {
    if (message.includes("waiting to refresh")) markBusy();
    if (message.includes("refresh failed")) errors.push(message);
  });
  requestCodexAccountRuntimeRestart("account");
  scheduleCodexGlobalRuntimeRefresh({
    beforePrepare: async () => {
      transitionRan = true;
    },
  });
  await busy;
  await expectShutdownToFinish(shutdownCodexGlobalRuntimeRefresh());
  expect(active).toBe(true);
  expect(transitionRan).toBe(false);
  expect(errors).toEqual([]);
  await expect(prepareCodexRuntime()).rejects.toThrow("shutting down");
});

test("shutdown interrupts an idle check whose app-server request has not returned", async () => {
  let requestStarted!: () => void;
  let releaseRequest!: () => void;
  const started = new Promise<void>((resolve) => {
    requestStarted = resolve;
  });
  const request = new Promise<void>((resolve) => {
    releaseRequest = resolve;
  });
  let statusRequests = 0;
  const client = {
    isInitialized: true,
    async request(method: string) {
      if (method !== "thread/loaded/list") {
        statusRequests += 1;
        return { thread: { status: { type: "idle" } } };
      }
      requestStarted();
      await request;
      return { data: ["codex-old-runtime"] };
    },
  };
  let transitionRan = false;
  releaseFakeActiveTurn = releaseRequest;
  setGlobalCodexRuntimeLifecycle({ getClient: () => client } as unknown as CodexRuntimeLifecycle);
  configureRefreshTest();
  requestCodexAccountRuntimeRestart("account");
  scheduleCodexGlobalRuntimeRefresh({
    beforePrepare: async () => {
      transitionRan = true;
    },
  });
  await started;
  try {
    await expectShutdownToFinish(shutdownCodexGlobalRuntimeRefresh());
    expect(transitionRan).toBe(false);
  } finally {
    releaseRequest();
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(statusRequests).toBe(0);
});

test("shutdown still waits for an account transition already publishing credentials", async () => {
  let enteredTransition!: () => void;
  let releaseTransition!: () => void;
  const entered = new Promise<void>((resolve) => {
    enteredTransition = resolve;
  });
  const publication = new Promise<void>((resolve) => {
    releaseTransition = resolve;
  });
  releaseFakeActiveTurn = releaseTransition;
  configureRefreshTest();
  requestCodexAccountRuntimeRestart("account");
  scheduleCodexGlobalRuntimeRefresh({
    beforePrepare: async () => {
      enteredTransition();
      await publication;
    },
  });
  await entered;
  let stopped = false;
  const shutdown = shutdownCodexGlobalRuntimeRefresh().then(() => {
    stopped = true;
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(stopped).toBe(false);
  } finally {
    releaseTransition();
  }
  await expectShutdownToFinish(shutdown);
  expect(stopped).toBe(true);
});
