import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  CodexEventAdapter,
  CodexTurnRouteRegistry,
  type CodexTurnTokenUsageBreakdown as Tokens,
} from "@eco/runtime";
import {
  CodexLiveUsageBilling,
  type CodexLiveUsageInput,
  type CodexLiveUsageRequest,
} from "../src/main/codex-live-usage-billing";
import { createConversationStore } from "../src/main/conversation-store";
import { projectBillingFromUsageLedger } from "../src/main/billing-projector";
import { parseOpenAiApiPricing, resolveOpenAiApiRates } from "../src/main/openai-api-pricing";
import { resolveSingleUsageBillingArtifacts } from "../src/main/usage-billing-artifacts";
import type { UsageLedgerEvent } from "../src/main/usage-ledger";
import { PRICING_MARKDOWN } from "./openai-api-pricing-fixture";

const threadId = "thr_live_usage";
const one: Tokens = {
  inputTokens: 200_000,
  cachedInputTokens: 100_000,
  outputTokens: 1_000,
  reasoningOutputTokens: 100,
  totalTokens: 201_000,
};
const two: Tokens = { ...one, inputTokens: 300_000, totalTokens: 301_000 };
const add = (a: Tokens, b: Tokens): Tokens =>
  Object.fromEntries(
    Object.keys(a).map((key) => [key, a[key as keyof Tokens] + b[key as keyof Tokens]]),
  ) as unknown as Tokens;
const total = add(one, two);
function input(usage = one, raw = usage, requests: Tokens[] | undefined = [usage]): CodexLiveUsageInput {
  return {
    codexThreadId: "native",
    turnId: "turn",
    appServerTokenUsage: usage,
    ...(requests && { appServerTokenUsageRequests: requests }),
    appServerTokenUsageSnapshot: { last: requests?.at(-1) ?? two, total: raw },
  };
}

function services(initial: UsageLedgerEvent[] = []) {
  const events = [...initial];
  const requests: CodexLiveUsageRequest[] = [];
  const prices = parseOpenAiApiPricing(PRICING_MARKDOWN);
  return {
    events,
    requests,
    listEvents: () => events,
    bill: async (request: CodexLiveUsageRequest) => {
      requests.push(request);
      const artifacts = await resolveSingleUsageBillingArtifacts({
        threadId,
        role: "main",
        source: "codex",
        providerId: "openai",
        modelId: "gpt-6.1-sol",
        codexPlannerModelId: "gpt-6.1-sol",
        plannerAgentId: "main:attempt_live",
        usage: request.usage,
        runtimeRoutes: [],
        lookupPricing: async () => null,
        lookupCodexApiRates: async (id, usage) =>
          resolveOpenAiApiRates(prices[id], usage, request.codexUsageIsAggregate),
        requestKey: request.requestKey,
      });
      artifacts.ledgerEvent.metadata = { ...artifacts.ledgerEvent.metadata, ...request.metadata };
      if (!events.some((event) => event.idempotencyKey === artifacts.ledgerEvent.idempotencyKey))
        events.push(artifacts.ledgerEvent);
    },
  };
}

test("usage becomes billable before completion; duplicates, history replay and completion do not charge again", async () => {
  const billing = new CodexLiveUsageBilling();
  const store = services();
  await billing.enqueue(input(), store);
  expect(store.events).toHaveLength(1);
  expect(projectBillingFromUsageLedger({ events: store.events }).snapshot?.ecoCostUsd).toBeGreaterThan(0);
  const next = input(total, total, [one, two]);
  await billing.enqueue(next, store);
  await billing.enqueue(input(), store);
  await billing.enqueue(next, store);
  expect(store.events).toHaveLength(2);
  expect(store.requests.map((request) => request.codexUsageIsAggregate)).toEqual([false, false]);
  const projection = projectBillingFromUsageLedger({ events: store.events });
  expect(projection.unresolvedEventCount).toBe(0);
  expect(projection.snapshot?.ecoCostUsd).toBeCloseTo(1.055, 6);
  expect(projection.snapshot?.totalTokens).toEqual({
    input: 300_000,
    output: 2_000,
    cacheRead: 200_000,
    cacheCreation: 0,
  });
});

test("native cumulative history is not billed when the first observed request belongs to a resumed thread", async () => {
  const store = services();
  await new CodexLiveUsageBilling().enqueue(input(one, add(total, one)), store);
  expect(store.events[0]?.inputTokens).toBe(100_000);
  expect(store.events[0]?.cacheReadTokens).toBe(100_000);
});

test("a reopened SQLite ledger restores the checkpoint even when the runtime turn accumulator has reset", async () => {
  const dbPath = path.join(mkdtempSync(path.join(tmpdir(), "eco-live-billing-")), "eco.sqlite");
  const first = await createConversationStore(dbPath);
  first.saveThread({
    id: threadId,
    title: "Live usage",
    prompt: "test",
    workspacePath: "/tmp",
    status: "running",
    message: "",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  const memory = services();
  const persistent = (store: typeof first) => ({
    listEvents: () => store.listUsageLedgerEvents(threadId),
    bill: async (request: CodexLiveUsageRequest) => {
      await memory.bill(request);
      store.appendUsageLedgerEvent(memory.events.at(-1)!);
    },
  });
  await new CodexLiveUsageBilling().enqueue(input(), persistent(first));
  const reopened = await createConversationStore(dbPath);
  const restarted = new CodexLiveUsageBilling();
  await restarted.enqueue(input(), persistent(reopened));
  // The native runtime now knows only this response, while total includes both.
  await restarted.enqueue(input(two, total), persistent(reopened));
  await restarted.enqueue(input(two, total), persistent(reopened));
  expect(reopened.listUsageLedgerEvents(threadId)).toHaveLength(2);
  expect(reopened.listUsageLedgerEvents(threadId).reduce((n, event) => n + event.outputTokens, 0)).toBe(
    2_000,
  );
});

test("concurrent notifications serialize reads, pricing and writes for the same turn", async () => {
  const billing = new CodexLiveUsageBilling();
  const store = services();
  const third = add(total, one);
  await Promise.all([
    billing.enqueue(input(), store),
    billing.enqueue(input(total, total, [one, two]), store),
    billing.enqueue(input(third, third, [one, two, one]), store),
    billing.enqueue(input(third, third, [one, two, one]), store),
  ]);
  expect(store.events).toHaveLength(3);
  expect(store.events.reduce((n, event) => n + event.outputTokens, 0)).toBe(3_000);
});

test("completion retries failed live writes without advancing a separate cursor", async () => {
  const billing = new CodexLiveUsageBilling();
  const store = services();
  await expect(billing.enqueue(input(), { ...store, bill: async () => {} })).rejects.toThrow("not persisted");
  await billing.enqueue(input(), store);
  expect(store.events).toHaveLength(1);
});

test("a partial multi-request write retries only the missing request and preserves its price tier", async () => {
  const billing = new CodexLiveUsageBilling();
  const store = services();
  let count = 0;
  const snapshot = input(total, total, [one, two]);
  await expect(
    billing.enqueue(snapshot, {
      ...store,
      bill: async (request) => {
        if (++count === 2) throw new Error("disk write failed");
        await store.bill(request);
      },
    }),
  ).rejects.toThrow("disk write failed");
  expect(store.events).toHaveLength(1);
  await new CodexLiveUsageBilling().enqueue(snapshot, store);
  expect(store.events).toHaveLength(2);
  expect(projectBillingFromUsageLedger({ events: store.events }).snapshot?.ecoCostUsd).toBeCloseTo(1.055, 6);
});

test("native total resets use response-local usage and keep replayed old checkpoints inert", async () => {
  const billing = new CodexLiveUsageBilling();
  const store = services();
  await billing.enqueue(input(total, total, [one, two]), store);
  const reset = {
    inputTokens: 100,
    cachedInputTokens: 20,
    outputTokens: 10,
    reasoningOutputTokens: 2,
    totalTokens: 110,
  };
  await billing.enqueue(input(add(total, reset), reset, [one, two, reset]), store);
  await billing.enqueue(input(), store);
  expect(store.events).toHaveLength(3);
  expect(store.events.at(-1)?.inputTokens).toBe(80);
  expect(store.events.at(-1)?.reasoningTokens).toBe(2);
});

test("missing request boundaries remain explicitly unpriced for tiered models", async () => {
  const store = services();
  const aggregate = input(total);
  delete aggregate.appServerTokenUsageRequests;
  aggregate.appServerTokenUsageSnapshot!.last = two;
  await new CodexLiveUsageBilling().enqueue(aggregate, store);
  expect(store.requests[0]?.codexUsageIsAggregate).toBe(true);
  expect(projectBillingFromUsageLedger({ events: store.events }).unresolvedEventCount).toBe(1);
});

test("older terminal events reconcile persisted totals instead of stacking another bill", async () => {
  const store = services();
  const billing = new CodexLiveUsageBilling();
  await billing.enqueue(input(), store);
  const terminal = input();
  delete terminal.appServerTokenUsageSnapshot;
  await billing.enqueue(terminal, store);
  terminal.appServerTokenUsage = total;
  await expect(billing.enqueue(terminal, store)).rejects.toThrow("cannot reconcile");
  expect(store.events).toHaveLength(1);
});

test("adapter delivers registered live usage without adding feed events; completion keeps the same checkpoint", () => {
  const registry = new CodexTurnRouteRegistry();
  registry.register("native", "turn", {
    providerId: "openai",
    aliasModelId: "gpt-6.1-sol",
    upstreamModelId: "gpt-6.1-sol",
  });
  const live: unknown[] = [];
  const terminal: Record<string, unknown>[] = [];
  const adapter = new CodexEventAdapter({
    resolveEcoThreadId: () => threadId,
    turnRouteRegistry: registry,
    recordThreadRunEvent: (event) => terminal.push(event.metadata ?? {}),
    onTurnTokenUsageUpdated: (route) => live.push(route),
  });
  adapter.dispatch("thread/tokenUsage/updated", {
    threadId: "native",
    turnId: "history",
    tokenUsage: { last: one, total: one },
  });
  expect(live).toHaveLength(0);
  const snapshot = { last: two, total: add(one, two) };
  adapter.dispatch("thread/tokenUsage/updated", { threadId: "native", turnId: "turn", tokenUsage: snapshot });
  expect(live).toHaveLength(1);
  expect(terminal).toHaveLength(0);
  adapter.dispatch("turn/completed", { threadId: "native", turn: { id: "turn", status: "completed" } });
  expect(terminal[0]?.appServerTokenUsageSnapshot).toEqual(snapshot);
  expect(terminal[0]?.appServerTokenUsageRequests).toEqual([two]);
  expect(terminal[0]?.usageModelId).toBe("gpt-6.1-sol");
});
