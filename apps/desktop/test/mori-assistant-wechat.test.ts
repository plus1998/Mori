import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { MoriAssistantWechat } from "../src/main/mori-assistant-wechat";

const originalFetch = globalThis.fetch;
const directories: string[] = [];

afterEach(async () => {
  globalThis.fetch = originalFetch;
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

test("接收省略 ret 的拉取响应并确认省略 ret 的发送响应", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "mori-wechat-test-"));
  directories.push(dir);
  const file = path.join(dir, "state.json");
  await writeFile(
    file,
    JSON.stringify({ token: "token", userId: "user", cursor: "", inbox: [], outbox: [] }),
  );
  let pollCount = 0;
  let sent = false;
  const requests: string[] = [];
  globalThis.fetch = (async (input, init) => {
    requests.push(String(input));
    if (String(input).endsWith("/getupdates")) {
      if (pollCount++ === 0)
        return Response.json({
          msgs: [
            {
              message_id: "42",
              from_user_id: "user",
              context_token: "context",
              item_list: [{ text_item: { text: "你好" } }],
            },
          ],
          get_updates_buf: "cursor",
        });
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) reject(signal.reason);
        else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }
    if (String(input).endsWith("/sendmessage")) {
      sent = true;
      return Response.json({});
    }
    throw new Error("unexpected request");
  }) as typeof fetch;
  const wechat = new MoriAssistantWechat(file, { changed() {}, receive: async (text) => `回复：${text}` });
  await wechat.load();
  await wechat.setEnabled(true);
  try {
    for (let i = 0; i < 100 && !sent; i++) await Bun.sleep(10);
    expect(sent).toBe(true);
  } finally {
    await wechat.close();
  }
  const state = JSON.parse(await readFile(file, "utf8"));
  expect(state.cursor).toBe("cursor");
  expect(state.inbox[0].status).toBe("done");
  expect(state.outbox).toEqual([]);
  expect(requests.some((url) => url.endsWith("/getconfig") || url.endsWith("/sendtyping"))).toBe(false);
});

test.each([
  [{ ret: 0, errcode: -14, errmsg: "expired" }, "微信返回错误 -14：expired"],
  [{ msgs: "invalid", get_updates_buf: "cursor" }, "微信返回了无效的消息拉取结果。"],
  [{}, "微信返回了无效的消息拉取结果。"],
])("拒绝错误或缺少有效数据的拉取响应", async (response, expected) => {
  const dir = await mkdtemp(path.join(tmpdir(), "mori-wechat-test-"));
  directories.push(dir);
  const file = path.join(dir, "state.json");
  await writeFile(
    file,
    JSON.stringify({ token: "token", userId: "user", cursor: "", inbox: [], outbox: [] }),
  );
  globalThis.fetch = (async () => Response.json(response)) as typeof fetch;
  const wechat = new MoriAssistantWechat(file, { changed() {}, receive: async () => "reply" });
  await wechat.load();
  await wechat.setEnabled(true);
  try {
    for (let i = 0; i < 100 && wechat.status.status !== "error"; i++) await Bun.sleep(10);
    expect(wechat.status).toEqual({ status: "error", error: expected });
  } finally {
    await wechat.close();
  }
  const state = JSON.parse(await readFile(file, "utf8"));
  expect(state.cursor).toBe("");
});

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (check()) return;
    await Bun.sleep(10);
  }
  throw new Error("Timed out waiting for WeChat");
}

async function typingFixture(
  receive: (text: string, id: string) => Promise<string>,
  handle?: (
    endpoint: string,
    body: Record<string, unknown>,
    signal: AbortSignal | null | undefined,
  ) => Promise<Response> | undefined,
) {
  const dir = await mkdtemp(path.join(tmpdir(), "mori-wechat-typing-test-"));
  directories.push(dir);
  const file = path.join(dir, "state.json");
  await writeFile(
    file,
    JSON.stringify({ token: "token", userId: "user", cursor: "", inbox: [], outbox: [] }),
  );
  const calls: Array<{ endpoint: string; body: Record<string, unknown> }> = [];
  const diagnostics: Array<{ event: string; fields: Record<string, string | number | boolean | null> }> = [];
  const inbound = {
    message_id: "42",
    from_user_id: "user",
    context_token: "context",
    item_list: [{ text_item: { text: "慢任务" } }],
  };
  let polls = 0;
  globalThis.fetch = (async (input, init) => {
    const endpoint = new URL(String(input)).pathname;
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push({ endpoint, body });
    const result = handle?.(endpoint, body, init?.signal);
    if (result) return result;
    if (endpoint.endsWith("/getupdates")) {
      if (polls++ === 0) return Response.json({ msgs: [inbound, inbound], get_updates_buf: "cursor" });
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) reject(signal.reason);
        else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }
    if (endpoint.endsWith("/getconfig")) return Response.json({ typing_ticket: "ticket" });
    if (endpoint.endsWith("/sendtyping") || endpoint.endsWith("/sendmessage")) return Response.json({});
    throw new Error(`Unexpected endpoint ${endpoint}`);
  }) as typeof fetch;
  const wechat = new MoriAssistantWechat(file, {
    changed() {},
    receive,
    typingDiagnostic: (event, fields) => diagnostics.push({ event, fields }),
  });
  await wechat.load();
  await wechat.setEnabled(true);
  const statuses = () =>
    calls.filter((call) => call.endpoint.endsWith("/sendtyping")).map((call) => call.body.status);
  const replies = () =>
    calls.filter((call) => call.endpoint.endsWith("/sendmessage")).map((call) => call.body.msg);
  return { wechat, file, calls, statuses, replies, diagnostics };
}

test("慢回复使用原生状态；重复收件只处理一次，清理请求挂起也不阻塞正式答复", async () => {
  const reply = Promise.withResolvers<string>();
  const cancel = Promise.withResolvers<Response>();
  let received = 0;
  const { wechat, file, statuses, replies, diagnostics } = await typingFixture(
    async () => {
      received++;
      return reply.promise;
    },
    (endpoint, body) => (endpoint.endsWith("/sendtyping") && body.status === 2 ? cancel.promise : undefined),
  );
  try {
    await until(() => statuses().includes(1));
    reply.resolve("正式答复");
    await until(() => replies().length === 1);
    expect(received).toBe(1);
    expect(replies()).toEqual([
      {
        from_user_id: "",
        to_user_id: "user",
        client_id: "mori-42",
        message_type: 2,
        message_state: 2,
        context_token: "context",
        item_list: [{ type: 1, text_item: { text: "正式答复" } }],
      },
    ]);
  } finally {
    reply.resolve("正式答复");
    cancel.resolve(Response.json({}));
    await wechat.close();
  }
  expect(statuses()).toEqual([1, 2]);
  const state = JSON.parse(await readFile(file, "utf8"));
  expect(state.inbox).toHaveLength(1);
  expect(state.inbox[0].status).toBe("done");
  expect(state.outbox).toEqual([]);
  expect(JSON.stringify(state)).not.toContain("typing_ticket");
  const turn = diagnostics.filter((entry) => entry.fields.traceId);
  expect(new Set(turn.map((entry) => entry.fields.traceId)).size).toBe(1);
  expect(turn.find((entry) => entry.event === "processing")?.fields.waitingForInput).toBe(false);
  expect(turn.find((entry) => entry.event === "stopped")?.fields.reason).toBe("reply-ready");
  expect(turn.filter((entry) => entry.event === "request").map((entry) => entry.fields.stage)).toEqual([
    "getconfig",
    "start-or-renew",
    "cancel",
  ]);
  expect(JSON.stringify(turn)).not.toContain('"context"');
});

test("处理失败取消原生状态，仅发送现有失败答复", async () => {
  const reply = Promise.withResolvers<string>();
  const { wechat, file, statuses, replies } = await typingFixture(async () => reply.promise);
  try {
    await until(() => statuses().includes(1));
    reply.reject(new Error("模型不可用"));
    await until(() => replies().length === 1);
  } finally {
    reply.resolve("cleanup");
    await wechat.close();
  }
  expect(statuses()).toEqual([1, 2]);
  expect(JSON.stringify(replies())).toContain("Mori 处理未完成：模型不可用");
  expect(JSON.parse(await readFile(file, "utf8")).inbox[0].status).toBe("failed");
});

test.each([
  "missing-ticket",
  "config-error",
  "start-error",
])("%s 显示反馈异常但不影响正式答复，不发送处理中消息", async (mode) => {
  const reply = Promise.withResolvers<string>();
  const { wechat, replies, statuses } = await typingFixture(
    async () => reply.promise,
    (endpoint, body) => {
      if (mode === "missing-ticket" && endpoint.endsWith("/getconfig"))
        return Promise.resolve(Response.json({}));
      if (mode === "config-error" && endpoint.endsWith("/getconfig"))
        return Promise.resolve(Response.json({ ret: -4 }));
      if (mode === "start-error" && endpoint.endsWith("/sendtyping") && body.status === 1)
        return Promise.resolve(Response.json({ ret: 0, errcode: -2 }));
      return undefined;
    },
  );
  try {
    await until(() => Boolean(wechat.status.feedbackError));
    expect(wechat.status.status).toBe("connected");
    reply.resolve("正式答复");
    await until(() => replies().length === 1);
    expect(JSON.stringify(replies())).toContain("正式答复");
    expect(wechat.status.feedbackError).toContain("文字回复不受影响");
  } finally {
    reply.resolve("cleanup");
    await wechat.close();
  }
  expect(statuses()).toEqual(mode === "start-error" ? [1, 2] : []);
});

test.each(["disable", "disconnect"])("%s 清理正在处理的输入状态；断开后不发送旧答复", async (action) => {
  const reply = Promise.withResolvers<string>();
  const { wechat, statuses, replies } = await typingFixture(async () => reply.promise);
  try {
    await until(() => statuses().includes(1));
    if (action === "disconnect") await wechat.disconnect();
    else await wechat.setEnabled(false);
    expect(statuses()).toEqual([1, 2]);
  } finally {
    reply.resolve("晚到的答复");
    await wechat.close();
  }
  expect(replies()).toEqual([]);
});

test("重启不重放中断任务或其输入状态", async () => {
  const reply = Promise.withResolvers<string>();
  const { wechat, file, calls, statuses } = await typingFixture(async () => reply.promise);
  try {
    await until(() => statuses().includes(1));
    await wechat.setEnabled(false);
    const restarted = new MoriAssistantWechat(file, {
      changed() {},
      receive: async () => {
        throw new Error("must not replay");
      },
    });
    const count = calls.length;
    await restarted.load();
    await restarted.setEnabled(true);
    try {
      await until(() => calls.length > count);
      expect(calls.slice(count).every((call) => call.endpoint.endsWith("/getupdates"))).toBe(true);
    } finally {
      await restarted.close();
    }
  } finally {
    reply.resolve("cleanup");
    await wechat.close();
  }
});

test("定时通知只在实际发送后确认，重复重试沿用已保存的送达回执", async () => {
  let rejectNotification = true;
  const f = await typingFixture(async () => "准备好了", (endpoint, body) => {
    const msg = body.msg as { client_id?: string } | undefined;
    if (endpoint.endsWith("/sendmessage") && msg?.client_id === "schedule-notification" && rejectNotification)
      return Promise.resolve(Response.json({ ret: 1, errmsg: "test rejected" }));
    return undefined;
  });
  try {
    await until(() => f.replies().length === 1);
    await expect(f.wechat.enqueueNotification("提醒内容", "42", "schedule-notification")).rejects.toThrow();
    expect(f.wechat.hasSentNotification("schedule-notification")).toBe(false);
    rejectNotification = false;
    await f.wechat.enqueueNotification("提醒内容", "42", "schedule-notification");
    expect(f.wechat.hasSentNotification("schedule-notification")).toBe(true);
    const count = f.replies().length;
    await f.wechat.enqueueNotification("提醒内容", "42", "schedule-notification");
    expect(f.replies()).toHaveLength(count);
    const restored = new MoriAssistantWechat(f.file, { changed() {}, receive: async () => "unused" });
    await restored.load();
    expect(restored.hasSentNotification("schedule-notification")).toBe(true);
    await restored.close();
  } finally { await f.wechat.close(); }
});
