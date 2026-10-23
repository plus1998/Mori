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

test("account publication does not wait for an active turn or read global idle status", async () => {
  let transitionRan = false;
  const client = {
    isInitialized: true,
    async request(method: string) {
      throw new Error(`Account publication must not query ${method}`);
    },
  };
  setGlobalCodexRuntimeLifecycle({ getClient: () => client } as unknown as CodexRuntimeLifecycle);
  configureRefreshTest();
  requestCodexAccountRuntimeRestart("account");
  scheduleCodexGlobalRuntimeRefresh({
    beforePrepare: async () => {
      transitionRan = true;
      throw new Error("explicit account publication failure");
    },
  });
  await expect(prepareCodexRuntime({ requiredProviderIds: ["openai"] })).rejects.toThrow(
    "explicit account publication failure",
  );
  expect(transitionRan).toBe(true);
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
