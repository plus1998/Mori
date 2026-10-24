import { expect, test } from "bun:test";
import type { CodexQuotaClient } from "../src/main/codex-account-quota";
import { wakeCodexAccount } from "../src/main/codex-account-wake";
import { latestLunaModelId } from "../src/shared/codex-wake-model";

function fixture(
  options: {
    status?: string;
    reply?: string;
    silent?: boolean;
    early?: boolean;
    noLuna?: boolean;
  } = {},
) {
  const calls: Array<{ method: string; params: unknown }> = [];
  let notify: ((method: string, params: unknown) => void) | undefined;
  let removed = false;
  const complete = () => {
    notify?.("turn/completed", { threadId: "other", turn: { id: "other", status: "completed" } });
    notify?.("item/completed", {
      threadId: "wake",
      item: { id: "reply", type: "agentMessage", text: options.reply ?? "Hello!" },
    });
    notify?.("turn/completed", {
      threadId: "wake",
      turn: { id: "turn", status: options.status ?? "completed", error: { message: "quota exhausted" } },
    });
  };
  const client: CodexQuotaClient = {
    addNotificationHandler(handler) {
      notify = handler;
      return () => {
        removed = true;
        notify = undefined;
      };
    },
    async request<T>(method: string, params?: unknown): Promise<T> {
      calls.push({ method, params });
      if (method === "model/list")
        return { data: [{ model: "gpt-6.1-sol", isDefault: true }, ...(options.noLuna ? [] : [{ model: "gpt-5.6-luna" }, { model: "gpt-6-luna" }])] } as T;
      if (method === "thread/start") return { thread: { id: "wake" } } as T;
      if (method === "turn/start") {
        if (!options.silent) {
          if (options.early) complete();
          else setTimeout(complete, 0);
        }
        return { turn: { id: "turn", status: "inProgress" } } as T;
      }
      return {} as T;
    },
  };
  return { client, calls, removed: () => removed };
}

test("wake sends exactly hi on an ephemeral official-provider thread and waits for a reply", async () => {
  const { client, calls, removed } = fixture();
  expect(await wakeCodexAccount(client)).toBe("Hello!");
  expect(calls.find((entry) => entry.method === "thread/start")?.params).toMatchObject({
    ephemeral: true,
    modelProvider: "openai",
    model: "gpt-6-luna",
    sandbox: "read-only",
    approvalPolicy: "never",
  });
  expect(calls.find((entry) => entry.method === "turn/start")?.params).toMatchObject({
    input: [{ type: "text", text: "hi" }],
  });
  expect(calls.filter((entry) => entry.method === "turn/start")).toHaveLength(1);
  expect(calls.at(-1)?.method).toBe("thread/unsubscribe");
  expect(removed()).toBe(true);
});

test("a completion before turn/start resolves is retained", async () => {
  expect(await wakeCodexAccount(fixture({ early: true }).client)).toBe("Hello!");
});

test("an explicit user model is used by both start calls without replacing it with the catalog default", async () => {
  const { client, calls } = fixture({ noLuna: true });
  expect(await wakeCodexAccount(client, "gpt-5.6-luna")).toBe("Hello!");
  expect(calls.some((call) => call.method === "model/list")).toBe(false);
  for (const method of ["thread/start", "turn/start"]) {
    expect(calls.find((call) => call.method === method)?.params).toMatchObject({ model: "gpt-5.6-luna" });
  }
});

test("latest Luna compares version numbers and excludes other model families and variants", () => {
  expect(latestLunaModelId(["gpt-6.1-sol", "gpt-5.6-luna", "gpt-6-luna", "gpt-6-luna-mini"])).toBe("gpt-6-luna");
  expect(latestLunaModelId(["gpt-6.9-luna", "gpt-6.10-luna", "gpt-6-luna"])).toBe("gpt-6.10-luna");
  expect(latestLunaModelId(["gpt-6.1-sol"])).toBeUndefined();
});

test("automatic Luna discovery reads all catalog pages", async () => {
  const { client, calls } = fixture();
  const original = client.request.bind(client);
  client.request = async <T>(method: string, params?: unknown): Promise<T> => {
    if (method !== "model/list") return original<T>(method, params);
    calls.push({ method, params });
    return ((params as { cursor?: string }).cursor
      ? { data: [{ model: "gpt-6-luna" }], nextCursor: null }
      : { data: [{ model: "gpt-5.6-luna" }], nextCursor: "page-2" }) as T;
  };
  expect(await wakeCodexAccount(client)).toBe("Hello!");
  expect(calls.find((call) => call.method === "thread/start")?.params).toMatchObject({ model: "gpt-6-luna" });
  expect(calls.filter((call) => call.method === "model/list")).toHaveLength(2);
});

test("failed or empty replies never report wake success", async () => {
  await expect(wakeCodexAccount(fixture({ status: "failed" }).client)).rejects.toThrow("quota exhausted");
  await expect(wakeCodexAccount(fixture({ reply: "" }).client)).rejects.toThrow("未返回文本回复");
});

test("timeout interrupts the turn, detaches listeners and never retries hi", async () => {
  const { client, calls, removed } = fixture({ silent: true });
  await expect(wakeCodexAccount(client, null, 10)).rejects.toThrow("唤醒超时");
  expect(calls.filter((entry) => entry.method === "turn/start")).toHaveLength(1);
  expect(calls.some((entry) => entry.method === "turn/interrupt")).toBe(true);
  expect(removed()).toBe(true);
});

test("missing Luna fails before sending a model request", async () => {
  const { client, calls } = fixture({ noLuna: true });
  await expect(wakeCodexAccount(client)).rejects.toThrow("没有 Luna 模型");
  expect(calls.map((entry) => entry.method)).toEqual(["model/list"]);
});
