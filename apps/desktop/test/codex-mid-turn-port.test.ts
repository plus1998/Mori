import { expect, test } from "bun:test";
import type { CodexAppServerClient } from "@eco/runtime/codex-app-server-client";
import { CodexMidTurnPortRegistry } from "../src/main/codex-mid-turn-port";

function fakeClient(options?: {
  steer?: (params: Record<string, unknown>) => Promise<unknown>;
  fail?: boolean;
}): Pick<CodexAppServerClient, "request"> {
  return {
    async request(method, params) {
      if (method !== "turn/steer") {
        throw new Error(`unexpected method ${method}`);
      }
      if (options?.fail) {
        throw new Error("no active turn");
      }
      if (options?.steer) {
        await options.steer(params as Record<string, unknown>);
      }
      return { turnId: (params as { expectedTurnId: string }).expectedTurnId };
    },
  };
}

test("CodexMidTurnPortRegistry steers while accepting", async () => {
  const registry = new CodexMidTurnPortRegistry();
  const calls: Record<string, unknown>[] = [];
  registry.open("thr_eco", {
    client: fakeClient({
      steer: async (params) => {
        calls.push(params);
      },
    }),
    codexThreadId: "thr_codex",
    turnId: "turn_1",
  });
  expect(registry.isAccepting("thr_eco")).toBe(true);
  const ok = await registry.tryPushUserText("thr_eco", "hello", { clientUserMessageId: "tfu_1" });
  expect(ok).toEqual({ ok: true, turnId: "turn_1" });
  expect(calls).toEqual([
    {
      threadId: "thr_codex",
      expectedTurnId: "turn_1",
      input: [{ type: "text", text: "hello" }],
      clientUserMessageId: "tfu_1",
    },
  ]);

  await registry.closeIngress("thr_eco");
  const rejected = await registry.tryPushUserText("thr_eco", "after");
  expect(rejected.ok).toBe(false);
  registry.close("thr_eco");
  expect(registry.getPhase("thr_eco")).toBeUndefined();
});

test("CodexMidTurnPortRegistry closeIngress waits for inflight steer", async () => {
  const registry = new CodexMidTurnPortRegistry();
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  registry.open("thr_slow", {
    client: {
      async request() {
        await gate;
        return { turnId: "turn_slow" };
      },
    },
    codexThreadId: "thr_codex",
    turnId: "turn_slow",
  });

  const pushPromise = registry.tryPushUserText("thr_slow", "slow");
  const closing = registry.closeIngress("thr_slow");
  let closed = false;
  void closing.then(() => {
    closed = true;
  });
  await new Promise((r) => setTimeout(r, 5));
  expect(closed).toBe(false);
  release?.();
  await pushPromise;
  await closing;
  expect(closed).toBe(true);
});

test("only the matching consumption receipt completes a pushed Codex follow-up", async () => {
  const registry = new CodexMidTurnPortRegistry();
  registry.open("thread", {
    client: fakeClient(),
    codexThreadId: "codex",
    turnId: "current",
  });
  const receipts: string[] = [];
  const consumption = {
    onConsumed: (at: string) => receipts.push(at),
    onUnconfirmed: () => receipts.push("unconfirmed"),
  };
  expect(await registry.tryPushUserText("thread", "first", {
    clientUserMessageId: "first",
    consumption,
  })).toEqual({ ok: true, turnId: "current" });
  registry.confirmUserMessage("thread", "previous", "first", "old-turn");
  registry.confirmUserMessage("thread", "current", "other", "other-message");
  expect(receipts).toEqual([]);

  registry.confirmUserMessage("thread", "current", "first", "consumed");
  registry.confirmUserMessage("thread", "current", "first", "duplicate");
  await registry.tryPushUserText("thread", "second", {
    clientUserMessageId: "second",
    consumption,
  });
  await registry.closeIngress("thread", "current");
  registry.close("thread", "current");
  expect(receipts).toEqual(["consumed", "unconfirmed"]);
});

test("a Codex receipt can win the race with the steer RPC response", async () => {
  const registry = new CodexMidTurnPortRegistry();
  const response = Promise.withResolvers<void>();
  registry.open("thread", {
    client: fakeClient({ steer: () => response.promise }),
    codexThreadId: "codex",
    turnId: "current",
  });
  const receipts: string[] = [];
  const pending = registry.tryPushUserText("thread", "steer", {
    clientUserMessageId: "early",
    consumption: {
      onConsumed: at => receipts.push(at),
      onUnconfirmed: () => receipts.push("unconfirmed"),
    },
  });
  registry.confirmUserMessage("thread", "current", "early", "received");
  expect(receipts).toEqual(["received"]);
  response.resolve();
  expect(await pending).toEqual({ ok: true, turnId: "current" });
  await registry.closeIngress("thread", "current");
  registry.close("thread", "current");
  expect(receipts).toEqual(["received"]);
});

for (const deliveryUnknown of [false, true]) {
  test(`a failed steer preserves receipt tracking only when transport is uncertain (${deliveryUnknown})`, async () => {
    const registry = new CodexMidTurnPortRegistry();
    registry.open("thread", {
      client: fakeClient({
        steer: async () => {
          throw new Error(deliveryUnknown ? "connection closed" : "turn/steer failed: no active turn");
        },
      }),
      codexThreadId: "codex",
      turnId: "current",
    });
    const receipts: string[] = [];
    expect(await registry.tryPushUserText("thread", "steer", {
      clientUserMessageId: "pending",
      consumption: {
        onConsumed: at => receipts.push(at),
        onUnconfirmed: () => receipts.push("unconfirmed"),
      },
    })).toMatchObject({ ok: false, deliveryUnknown });
    registry.confirmUserMessage("thread", "current", "pending", "received");
    registry.close("thread", "current");
    expect(receipts).toEqual(deliveryUnknown ? ["received"] : []);
  });
}
