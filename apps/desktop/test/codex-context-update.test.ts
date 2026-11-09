import { expect, mock, test } from "bun:test";
import { DatabaseSync } from "node:sqlite";
import { CodexEventAdapter, CodexTurnRouteRegistry, resolveCodexContextSnapshot } from "@eco/runtime";
import { applyCodexContextUpdate } from "../src/main/codex-context-update";
import { ContextSnapshotScheduler } from "../src/main/context-snapshot-scheduler";
import { ContextWindowMonitor } from "../src/main/context-window-monitor";
import type { ModelsDevPricingCache } from "../src/main/models-dev-pricing-cache";
import type { ThreadContextSnapshot } from "../src/shared/ipc";
import { ConversationV2Store } from "../src/main/conversation-v2-store";
import { ConversationV2RuntimeWriter } from "../src/main/conversation-v2-runtime-writer";
import { bindCodexThreadRunEventAttempt } from "../src/main/codex-runtime-run";
import type { ThreadRunEventInput } from "../src/shared/thread-run-events";

const THREAD_ID = "thr_context_provider";
const CODEX_THREAD_ID = "native_context_provider";
const MODEL_ID = "gpt-6.1-sol";
const PROVIDER_ID = "sk-deepseek-renamed";
const missingProviderMessage = "缺少供应商身份（providerId），无法确定上下文窗口。";
const params = {
  threadId: CODEX_THREAD_ID,
  turnId: "turn_context",
  tokenUsage: {
    last: {
      inputTokens: 315_557,
      cachedInputTokens: 314_496,
      outputTokens: 184,
      reasoningOutputTokens: 30,
      totalTokens: 315_741,
    },
    total: {
      inputTokens: 8_080_717,
      cachedInputTokens: 7_853_184,
      outputTokens: 35_956,
      reasoningOutputTokens: 9_783,
      totalTokens: 8_116_673,
    },
    modelContextWindow: 498_073,
  },
};

function createHarness() {
  const monitor = new ContextWindowMonitor({} as ModelsDevPricingCache, () => 524_288);
  const snapshots: ThreadContextSnapshot[] = [];
  const scheduler = new ContextSnapshotScheduler({
    monitor,
    emitContext: (_id, snapshot) => snapshots.push(snapshot),
  });
  const resolveModelLimit = mock(async () => 1_050_000);
  return { monitor, scheduler, snapshots, resolveModelLimit };
}

function resolution(providerId?: string) {
  return resolveCodexContextSnapshot({
    params,
    attribution: { ecoThreadId: THREAD_ID, billingRole: "main" },
    modelId: MODEL_ID,
    ...(providerId !== undefined && { providerId }),
  })!;
}

test("registered vendor identity reaches the UI with its capped window instead of a stale account window", async () => {
  const h = createHarness();
  h.scheduler.restoreSnapshot(THREAD_ID, {
    occupied: 315_741,
    limit: 272_000,
    occupancyPct: 100,
    limitsResolved: true,
    modelId: MODEL_ID,
    segments: [],
    updatedAt: 0,
  });
  const registry = new CodexTurnRouteRegistry();
  registry.register(CODEX_THREAD_ID, params.turnId, {
    providerId: PROVIDER_ID,
    upstreamModelId: MODEL_ID,
    aliasModelId: "cand-provider-gpt-sol",
    apiCompat: "openai_responses",
  });
  let update: Promise<void> | undefined;
  const adapter = new CodexEventAdapter({
    resolveEcoThreadId: () => THREAD_ID,
    recordThreadRunEvent: () => {},
    turnRouteRegistry: registry,
    onTokenUsageUpdated: (value) => {
      update = applyCodexContextUpdate(value, h);
    },
  });
  adapter.dispatch("thread/tokenUsage/updated", params);
  expect(update).toBeDefined();
  await update;
  expect(h.resolveModelLimit).toHaveBeenCalledWith({
    threadId: THREAD_ID,
    role: "main",
    providerId: PROVIDER_ID,
    modelId: MODEL_ID,
  });
  expect(h.snapshots.at(-1)).toMatchObject({
    occupied: 315_741,
    limit: 524_288,
    limitsResolved: true,
    occupancyPct: 60,
  });
  expect(h.snapshots.at(-1)?.error).toBeUndefined();
});

test("missing provider identity is visible before the first valid snapshot and never queries a model catalog", async () => {
  const h = createHarness();
  for (const providerId of [undefined, "", "   "]) {
    await expect(applyCodexContextUpdate(resolution(providerId), h)).rejects.toThrow(missingProviderMessage);
    expect(h.snapshots.at(-1)).toMatchObject({
      error: missingProviderMessage,
      limit: 0,
      limitsResolved: false,
    });
  }
  expect(h.resolveModelLimit).not.toHaveBeenCalled();
  expect(h.monitor.getSnapshot(THREAD_ID)).toBeUndefined();
});

test("context errors survive other refreshes and reopening, and clear after a valid update", async () => {
  const h = createHarness();
  await applyCodexContextUpdate(resolution(PROVIDER_ID), h);
  await expect(applyCodexContextUpdate(resolution(), h)).rejects.toThrow(missingProviderMessage);
  h.scheduler.emitLiveFromMonitor(THREAD_ID);
  h.scheduler.clearSubagentState(THREAD_ID);
  expect(h.scheduler.getDisplaySnapshot(THREAD_ID)?.error).toBe(missingProviderMessage);
  const reopened = createHarness();
  reopened.scheduler.restoreSnapshot(THREAD_ID, h.scheduler.getDisplaySnapshot(THREAD_ID)!);
  reopened.scheduler.emitLiveFromMonitor(THREAD_ID);
  expect(reopened.snapshots.at(-1)?.error).toBe(missingProviderMessage);
  await applyCodexContextUpdate(resolution(PROVIDER_ID), reopened);
  expect(reopened.snapshots.at(-1)?.error).toBeUndefined();
  expect(reopened.snapshots.at(-1)?.limit).toBe(524_288);
});

test("catalog errors and invalid windows are visible instead of reusing the old window", async () => {
  const h = createHarness();
  await applyCodexContextUpdate(resolution(PROVIDER_ID), h);
  await expect(
    applyCodexContextUpdate(resolution(PROVIDER_ID), {
      ...h,
      resolveModelLimit: async () => {
        throw new Error("模型窗口配置缺失");
      },
    }),
  ).rejects.toThrow("模型窗口配置缺失");
  expect(h.scheduler.getDisplaySnapshot(THREAD_ID)?.error).toBe("模型窗口配置缺失");
  await expect(
    applyCodexContextUpdate(resolution(PROVIDER_ID), {
      ...h,
      resolveModelLimit: async () => 0,
    }),
  ).rejects.toThrow("上下文窗口无效");
  expect(h.scheduler.getDisplaySnapshot(THREAD_ID)?.limit).toBe(0);
});

for (const status of ["completed", "failed", "interrupted"] as const) {
  test(`late usage after ${status} keeps the original identity and does not bill twice`, async () => {
    const h = createHarness();
    const registry = new CodexTurnRouteRegistry();
    registry.register(CODEX_THREAD_ID, params.turnId, {
      aliasModelId: "old-alias", providerId: PROVIDER_ID, upstreamModelId: MODEL_ID,
    });
    const onTurnTokenUsageUpdated = mock(() => {});
    let update: Promise<void> | undefined;
    const adapter = new CodexEventAdapter({
      resolveEcoThreadId: () => THREAD_ID,
      recordThreadRunEvent: () => {},
      turnRouteRegistry: registry,
      onTurnTokenUsageUpdated,
      onTokenUsageUpdated: (value) => { update = applyCodexContextUpdate(value, h); },
    });
    adapter.dispatch("thread/tokenUsage/updated", params);
    await update;
    expect(onTurnTokenUsageUpdated).toHaveBeenCalledTimes(1);
    adapter.dispatch("turn/completed", { threadId: CODEX_THREAD_ID, turn: { id: params.turnId, status } });
    registry.clearTurn(CODEX_THREAD_ID, params.turnId); // Driver finally/dispose cleanup.
    registry.registerPending(CODEX_THREAD_ID, {
      aliasModelId: "new-alias", providerId: "new-provider", upstreamModelId: "new-model",
    });
    adapter.dispatch("thread/tokenUsage/updated", params);
    await update;
    expect(h.snapshots.at(-1)?.error).toBeUndefined();
    expect(h.resolveModelLimit.mock.calls.at(-1)?.[0]).toMatchObject({ providerId: PROVIDER_ID, modelId: MODEL_ID });
    expect(onTurnTokenUsageUpdated).toHaveBeenCalledTimes(1);
    expect(registry.peek(CODEX_THREAD_ID, params.turnId)).toBeUndefined();
    expect(registry.size).toBe(1);
  });
}

for (const cleanedBeforeCompletion of [false, true]) {
  test(`resume after a restart recovers the exact turn from durable events (early cleanup: ${cleanedBeforeCompletion})`, async () => {
    const db = new DatabaseSync(":memory:");
    try {
      const store = new ConversationV2Store(db);
      store.initialize();
      store.ensureConversation(THREAD_ID);
      store.append({
        conversationId: THREAD_ID, eventId: "run-start", runId: "run", turnId: "run",
        type: "run.started", occurredAt: "2026-11-09T00:00:00Z", payload: { status: "running" },
      });
      const writer = new ConversationV2RuntimeWriter(db, store);
      const oldRegistry = new CodexTurnRouteRegistry();
      oldRegistry.register(CODEX_THREAD_ID, params.turnId, {
        aliasModelId: "old-alias", providerId: PROVIDER_ID, upstreamModelId: MODEL_ID,
      });
      if (cleanedBeforeCompletion) oldRegistry.clearTurn(CODEX_THREAD_ID, params.turnId);
      new CodexEventAdapter({
        resolveEcoThreadId: () => THREAD_ID,
        turnRouteRegistry: oldRegistry,
        recordThreadRunEvent: (event) => {
          writer.append(bindCodexThreadRunEventAttempt(event as ThreadRunEventInput, "run"));
        },
      }).dispatch("turn/completed", { threadId: CODEX_THREAD_ID, turn: { id: params.turnId, status: "completed" } });

      const restoredStore = new ConversationV2Store(db);
      restoredStore.initialize();
      const h = createHarness();
      const registry = new CodexTurnRouteRegistry();
      registry.registerPending(CODEX_THREAD_ID, {
        aliasModelId: "new-alias", providerId: "new-provider", upstreamModelId: "new-model",
      });
      let update: Promise<void> | undefined;
      new CodexEventAdapter({
        resolveEcoThreadId: () => THREAD_ID,
        recordThreadRunEvent: () => {},
        turnRouteRegistry: registry,
        resolveTurnContextIdentity: (threadId, turnId) => restoredStore.resolveCodexTurnContextIdentity(THREAD_ID, threadId, turnId),
        onTokenUsageUpdated: (value) => { update = applyCodexContextUpdate(value, h); },
      }).dispatch("thread/tokenUsage/updated", params);
      expect(update).toBeDefined();
      await update;
      expect(h.snapshots.at(-1)?.error).toBeUndefined();
      expect(h.resolveModelLimit.mock.calls.at(-1)?.[0]).toMatchObject({ providerId: PROVIDER_ID, modelId: MODEL_ID });
      expect(registry.size).toBe(1);
      expect(registry.peek(CODEX_THREAD_ID, params.turnId)).toBeUndefined();
      expect(restoredStore.resolveCodexTurnContextIdentity(THREAD_ID, "other-thread", params.turnId)).toBeUndefined();
      expect(restoredStore.resolveCodexTurnContextIdentity(THREAD_ID, CODEX_THREAD_ID, "unknown-turn")).toBeUndefined();
    } finally {
      db.close();
    }
  });
}

for (const fails of [false, true]) {
  test(`an older ${fails ? "failed" : "successful"} catalog lookup cannot overwrite the latest model snapshot`, async () => {
    const h = createHarness();
    let finish!: (limit: number) => void;
    let fail!: (error: Error) => void;
    const deferred = new Promise<number>((resolve, reject) => { finish = resolve; fail = reject; });
    const older = applyCodexContextUpdate(resolution(PROVIDER_ID), { ...h, resolveModelLimit: () => deferred });
    const olderSettled = older.catch((error: unknown) => error);
    const latest = resolution("new-provider");
    latest.context.modelId = "new-model";
    latest.contextOccupied = 100;
    await applyCodexContextUpdate(latest, { ...h, resolveModelLimit: async () => 200_000 });
    if (fails) fail(new Error("old catalog failed"));
    else finish(100_000);
    await olderSettled;
    expect(h.snapshots.at(-1)).toMatchObject({ occupied: 100, limit: 200_000, modelId: "new-model" });
    expect(h.snapshots.at(-1)?.error).toBeUndefined();
  });
}

test("a delayed valid lookup cannot clear the latest identity error", async () => {
  const h = createHarness();
  let finish!: (limit: number) => void;
  const deferred = new Promise<number>((resolve) => { finish = resolve; });
  const older = applyCodexContextUpdate(resolution(PROVIDER_ID), { ...h, resolveModelLimit: () => deferred });
  await expect(applyCodexContextUpdate(resolution(), h)).rejects.toThrow(missingProviderMessage);
  finish(200_000);
  await older;
  expect(h.scheduler.getDisplaySnapshot(THREAD_ID)?.error).toBe(missingProviderMessage);
  expect(h.monitor.getSnapshot(THREAD_ID)).toBeUndefined();
});
