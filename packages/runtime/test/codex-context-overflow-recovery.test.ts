import { expect, test } from "bun:test";
import type { CodexAppServerClient, CodexAppServerNotificationHandler } from "../src/codex-app-server-client";
import {
  codexThreadNeedsContextRecovery,
  compactCodexThreadForRetry,
} from "../src/codex-context-overflow-recovery";
import { CodexTurnRouteRegistry } from "../src/codex-turn-route-registry";

const route = { aliasModelId: "eco_alias", providerId: "fixture", upstreamModelId: "model" };
function fixture() {
  const handlers = new Set<CodexAppServerNotificationHandler>();
  const calls: Array<{ method: string; params: unknown }> = [];
  const client: Pick<CodexAppServerClient, "request" | "addNotificationHandler"> = {
    async request<T>(method: string, params: unknown): Promise<T> {
      calls.push({ method, params });
      return {} as T;
    },
    addNotificationHandler(handler) {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
  };
  const registry = new CodexTurnRouteRegistry();
  const controller = new AbortController();
  const run = () =>
    compactCodexThreadForRetry(client, {
      threadId: "native",
      signal: controller.signal,
      route,
      registry,
      timeoutMs: 1_000,
    });
  const emit = (method: string, turn: unknown, threadId = "native") => {
    for (const handler of handlers) handler(method, { threadId, turn });
  };
  return { client, handlers, calls, registry, controller, run, emit };
}

test("only the latest native context-window failure requests recovery", () => {
  const overflow = { status: "failed", error: { codexErrorInfo: "contextWindowExceeded" } };
  expect(codexThreadNeedsContextRecovery({ turns: [overflow] })).toBe(true);
  expect(codexThreadNeedsContextRecovery({ turns: [overflow, { status: "completed" }] })).toBe(false);
  expect(
    codexThreadNeedsContextRecovery({
      turns: [{ status: "failed", error: { message: "contextWindowExceeded" } }],
    }),
  ).toBe(false);
  expect(codexThreadNeedsContextRecovery({})).toBe(false);
});

test("queue acknowledgement does not complete recovery; unrelated terminal events are ignored", async () => {
  const f = fixture();
  let settled = false;
  const recovery = f.run().then(() => {
    settled = true;
  });
  await Bun.sleep(0);
  expect(f.calls.map((call) => call.method)).toEqual(["thread/compact/start"]);
  expect(settled).toBe(false);
  f.emit("turn/started", { id: "compact", status: "inProgress" });
  expect(f.registry.peek("native", "compact")).toMatchObject(route);
  f.emit("turn/completed", { id: "other", status: "completed" });
  f.emit("turn/completed", { id: "compact", status: "completed" }, "child");
  await Bun.sleep(0);
  expect(settled).toBe(false);
  f.emit("turn/completed", { id: "compact", status: "completed" });
  await recovery;
  expect(f.handlers.size).toBe(0);
  expect(f.registry.size).toBe(0);
});

test("native compaction failure keeps its reason and prevents successful recovery", async () => {
  const f = fixture();
  const recovery = f.run();
  const rejected = recovery.catch((error: Error) => error);
  f.emit("turn/started", { id: "compact" });
  f.emit("turn/completed", {
    id: "compact",
    status: "failed",
    error: { message: "Provider refused", additionalDetails: "diagnostic detail" },
  });
  expect(await rejected).toBeInstanceOf(Error);
  expect(String(await rejected)).toContain("未提交新输入：Provider refused: diagnostic detail");
  expect(f.registry.size).toBe(0);
  expect(f.handlers.size).toBe(0);
});

test("cancellation interrupts the native compaction turn rather than the business turn", async () => {
  const f = fixture();
  const recovery = f.run();
  const rejected = recovery.catch((error: Error) => error);
  f.emit("turn/started", { id: "compact" });
  f.controller.abort(new Error("user stopped"));
  expect(String(await rejected)).toContain("user stopped");
  expect(f.calls.at(-1)).toEqual({
    method: "turn/interrupt",
    params: { threadId: "native", turnId: "compact" },
  });
  expect(f.registry.size).toBe(0);
});

test("an abort while the operation is being queued waits for its id and then interrupts it", async () => {
  const f = fixture();
  const recovery = f.run();
  const rejected = recovery.catch((error: Error) => error);
  f.controller.abort(new Error("queued cancellation"));
  f.emit("turn/started", { id: "queued" });
  expect(String(await rejected)).toContain("queued cancellation");
  expect(f.calls.at(-1)).toEqual({
    method: "turn/interrupt",
    params: { threadId: "native", turnId: "queued" },
  });
});

test("a pre-aborted request never queues native compaction", async () => {
  const f = fixture();
  f.controller.abort(new Error("already stopped"));
  await expect(f.run()).rejects.toThrow("already stopped");
  expect(f.calls).toHaveLength(0);
});

test("RPC failure releases the pending route and notification listener", async () => {
  const f = fixture();
  f.client.request = async () => {
    throw new Error("compact RPC rejected");
  };
  await expect(f.run()).rejects.toThrow("compact RPC rejected");
  expect(f.registry.size).toBe(0);
  expect(f.handlers.size).toBe(0);
});

test("recovery timeout interrupts the native turn and remains a failure", async () => {
  const f = fixture();
  const recovery = compactCodexThreadForRetry(f.client, {
    threadId: "native",
    signal: f.controller.signal,
    route,
    registry: f.registry,
    timeoutMs: 10,
  });
  f.emit("turn/started", { id: "timed-out" });
  await expect(recovery).rejects.toThrow("context recovery timed out");
  expect(f.calls.at(-1)).toEqual({
    method: "turn/interrupt",
    params: { threadId: "native", turnId: "timed-out" },
  });
  expect(f.registry.size).toBe(0);
});

test("interrupt failure is exposed instead of claiming cancellation succeeded", async () => {
  const f = fixture();
  const original = f.client.request;
  f.client.request = async (method, params, options) => {
    if (method === "turn/interrupt") throw new Error("interrupt refused");
    return original(method, params, options);
  };
  const rejected = f.run().catch((error: Error) => error);
  f.emit("turn/started", { id: "compact" });
  f.controller.abort(new Error("user stopped"));
  expect(String(await rejected)).toContain("turn/interrupt failed");
  expect(String(await rejected)).toContain("interrupt refused");
  expect(f.registry.size).toBe(0);
});
