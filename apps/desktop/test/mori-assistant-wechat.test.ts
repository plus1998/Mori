import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { MoriAssistantWechat } from "../src/main/mori-assistant-wechat";
import { createDecipheriv } from "node:crypto";

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

test("微信通知支持本地图片和 URL 图片，并按媒体消息流程上传后发送", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "mori-wechat-image-test-"));
  directories.push(dir);
  const file = path.join(dir, "state.json");
  const imagePath = path.join(dir, "shot.png");
  await writeFile(file, JSON.stringify({
    token: "token",
    userId: "user",
    cursor: "",
    inbox: [{ id: "42", userId: "user", contextToken: "context", text: "截图", status: "done" }],
    outbox: [],
  }));
  await writeFile(imagePath, Buffer.from("local-image"));
  const sent: Array<Record<string, unknown>> = [];
  let polls = 0;
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url.endsWith("/getupdates")) {
      polls++;
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) reject(signal.reason);
        else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }
    if (url === "https://example.test/shot.png")
      return new Response(Buffer.from("remote-image"), { headers: { "content-type": "image/png" } });
    if (url.endsWith("/getuploadurl")) return Response.json({ upload_param: "upload-param" });
    if (url.includes("novac2c.cdn.weixin.qq.com/c2c/upload")) {
      return new Response(null, { headers: { "x-encrypted-param": "download-param" } });
    }
    if (url.endsWith("/sendmessage")) {
      sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json({});
    }
    throw new Error(`unexpected request ${url}`);
  }) as typeof fetch;
  const wechat = new MoriAssistantWechat(file, { changed() {}, receive: async () => "unused" });
  await wechat.load();
  await wechat.setEnabled(true);
  try {
    await wechat.enqueueMediaNotification(
      { text: "本地截图", image: { path: imagePath } },
      "42",
      "image-local",
    );
    await wechat.enqueueMediaNotification({ image: { url: "https://example.test/shot.png" } }, "42", "image-url");
    expect(sent).toHaveLength(3);
    expect((sent[0]?.msg as { item_list?: unknown[] }).item_list?.[0]).toEqual({
      type: 1,
      text_item: { text: "本地截图" },
    });
    expect((sent[1]?.msg as { item_list?: Array<{ image_item?: unknown }> }).item_list?.[0]?.image_item).toMatchObject({
      media: { encrypt_query_param: "download-param", encrypt_type: 1 },
    });
    expect((sent[2]?.msg as { item_list?: Array<{ image_item?: unknown }> }).item_list?.[0]?.image_item).toMatchObject({
      media: { encrypt_query_param: "download-param", encrypt_type: 1 },
    });
    expect(wechat.hasSentNotification("image-local")).toBe(true);
    expect(wechat.hasSentNotification("image-url")).toBe(true);
    expect(polls).toBeGreaterThan(0);
  } finally {
    await wechat.close();
  }
});

async function mediaFixture(options: {
  send?(msg: { client_id: string; item_list: Array<{ type: number; image_item?: { media: { aes_key: string } } }> }): Promise<Response>;
  upload?(): Promise<Response>;
  followed?(threadId: string, requestId: string | undefined): boolean;
} = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "mori-wechat-media-"));
  directories.push(dir);
  const file = path.join(dir, "state.json");
  const imagePath = path.join(dir, "shot.png");
  const bytes = Buffer.from("screenshot-test-image");
  await writeFile(imagePath, bytes);
  await writeFile(file, JSON.stringify({ token: "token", userId: "user", cursor: "",
    inbox: [{ id: "42", userId: "user", contextToken: "context", text: "ready", status: "done" }], outbox: [] }));
  const sends: Array<{ client_id: string; item_list: Array<{ type: number; image_item?: { media: { aes_key: string } } }> }> = [];
  const uploads: Buffer[] = [];
  let uploadRequests = 0;
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url.endsWith("/getupdates")) return new Promise<Response>((_resolve, reject) => {
      if (init?.signal?.aborted) reject(init.signal.reason);
      else init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    });
    if (url.endsWith("/getuploadurl")) { uploadRequests++; return Response.json({ upload_param: "param" }); }
    if (url.includes("/upload?")) {
      uploads.push(Buffer.from(init?.body as Uint8Array));
      return options.upload ? options.upload() : new Response(null, { headers: { "x-encrypted-param": "download" } });
    }
    if (url.endsWith("/sendmessage")) {
      const { msg } = JSON.parse(String(init?.body));
      sends.push(msg);
      return options.send ? options.send(msg) : Response.json({});
    }
    if (url === "https://example.test/bad.png") return new Response("unavailable", { status: 503 });
    throw new Error(`unexpected media request ${url}`);
  }) as typeof fetch;
  const create = () => new MoriAssistantWechat(file, {
    changed() {}, receive: async () => "unused",
    ...(options.followed ? { canSendFollowNotification: options.followed } : {}),
  });
  const wechat = create();
  await wechat.load();
  await wechat.setEnabled(true);
  return { wechat, create, file, imagePath, bytes, sends, uploads, uploadRequests: () => uploadRequests };
}

test("并发发送同一图片通知只上传/发送一次，媒体密钥遵循 ClawBot 编码且能解密", async () => {
  const f = await mediaFixture();
  try {
    const notification = { image: { path: f.imagePath } };
    await Promise.all(Array.from({ length: 4 }, () => f.wechat.enqueueMediaNotification(notification, "42", "concurrent-image")));
    expect(f.uploadRequests()).toBe(1);
    expect(f.sends).toHaveLength(1);
    const encoded = f.sends[0]?.item_list[0]?.image_item?.media.aes_key ?? "";
    const hex = Buffer.from(encoded, "base64").toString();
    expect(hex).toMatch(/^[a-f0-9]{32}$/);
    const decipher = createDecipheriv("aes-128-ecb", Buffer.from(hex, "hex"), null);
    expect(Buffer.concat([decipher.update(f.uploads[0]!), decipher.final()])).toEqual(f.bytes);
  } finally { await f.wechat.close(); }
});

test("图片发送失败重启后只重试未发送媒体，不重复文字、不重新上传；送达回执持久去重", async () => {
  let fail = true;
  const f = await mediaFixture({ send: async (msg) => Response.json(msg.item_list[0]?.type === 2 && fail ? { ret: -1, errmsg: "send failed" } : {}) });
  let restored: MoriAssistantWechat | undefined;
  try {
    await expect(f.wechat.enqueueMediaNotification({ text: "结果", image: { path: f.imagePath } }, "42", "partial")).rejects.toThrow("send failed");
    expect(f.wechat.hasSentNotification("partial")).toBe(false);
    expect(JSON.parse(await readFile(f.file, "utf8")).outbox[0].sentItemCount).toBe(1);
    await f.wechat.close();
    await rm(f.imagePath);
    fail = false;
    restored = f.create(); await restored.load(); await restored.setEnabled(true);
    await restored.enqueueMediaNotification({ image: { path: f.imagePath } }, "42", "partial");
    expect(f.sends.map(msg => msg.item_list[0]?.type)).toEqual([1, 2, 2]);
    expect(f.sends.map(msg => msg.client_id)).toEqual(["partial:0", "partial:1", "partial:1"]);
    expect(f.uploadRequests()).toBe(1);
    expect(restored.hasSentNotification("partial")).toBe(true);
    await restored.enqueueMediaNotification({ text: "结果" }, "42", "partial");
    expect(f.sends).toHaveLength(3);
  } finally { await restored?.close(); await f.wechat.close(); }
});

test("微信离线、无效路径、下载失败都如实报错，不能确认送达或生成待发送通知", async () => {
  const f = await mediaFixture();
  try {
    await expect(f.wechat.enqueueMediaNotification({ image: { path: "relative.png" } }, "42", "relative")).rejects.toThrow("绝对路径");
    await expect(f.wechat.enqueueMediaNotification({ image: { url: "https://example.test/bad.png" } }, "42", "download")).rejects.toThrow("下载失败");
    await f.wechat.setEnabled(false);
    await expect(f.wechat.enqueueMediaNotification({ text: "结果" }, "42", "offline")).rejects.toThrow("未在线");
    expect(f.wechat.canNotify).toBe(false);
    expect(f.sends).toEqual([]);
    expect(JSON.parse(await readFile(f.file, "utf8")).outbox).toEqual([]);
  } finally { await f.wechat.close(); }
});

test("上传 4xx 立即失败；临时错误重试最多三次，不能伪装成发送成功", async () => {
  for (const status of [403, 503]) {
    const f = await mediaFixture({ upload: async () => new Response(null, { status, headers: { "x-error-message": "rejected" } }) });
    try {
      await expect(f.wechat.enqueueMediaNotification({ image: { path: f.imagePath } }, "42", `upload-${status}`)).rejects.toThrow("上传");
      expect(f.uploads).toHaveLength(status === 403 ? 1 : 3);
      expect(f.sends).toEqual([]);
      expect(f.wechat.hasSentNotification(`upload-${status}`)).toBe(false);
    } finally { await f.wechat.close(); }
  }
});

test("关闭关注会取消失败待发通知；对话指令消息不受此开关影响", async () => {
  let followed = true;
  let fail = true;
  const f = await mediaFixture({ followed: () => followed, send: async () => Response.json(fail ? { ret: -1 } : {}) });
  try {
    await expect(f.wechat.enqueueMediaNotification({ text: "完工", followThreadId: "task" }, "42", "manual")).rejects.toThrow();
    followed = false;
    await f.wechat.cancelFollowNotifications("task");
    fail = false;
    await f.wechat.enqueueMediaNotification({ text: "用户明确要求的通知" }, "42", "agent");
    expect(f.sends.map(msg => msg.client_id)).toEqual(["manual", "agent"]);
    expect(f.wechat.hasSentNotification("manual")).toBe(false);
    expect(f.wechat.hasSentNotification("agent")).toBe(true);
  } finally { await f.wechat.close(); }
});

test("图片上传期间断开微信，不把旧账号的媒体塞进新连接队列", async () => {
  const uploaded = Promise.withResolvers<Response>();
  const f = await mediaFixture({ upload: () => uploaded.promise });
  try {
    const work = f.wechat.enqueueMediaNotification({ image: { path: f.imagePath } }, "42", "disconnect-image");
    const outcome = work.then(() => undefined, (error: Error) => error);
    await until(() => f.uploads.length > 0);
    await f.wechat.disconnect();
    uploaded.resolve(new Response(null, { headers: { "x-encrypted-param": "download" } }));
    expect((await outcome)?.message).toContain("连接已关闭");
    expect(f.sends).toEqual([]);
    expect(JSON.parse(await readFile(f.file, "utf8")).outbox).toEqual([]);
  } finally { uploaded.resolve(new Response(null)); await f.wechat.close(); }
});

test("同一对话开始新任务后，旧任务的待发完工通知失效", async () => {
  let requestId = "request-1";
  let fail = true;
  const f = await mediaFixture({ followed: (_thread, expected) => expected === requestId,
    send: async () => Response.json(fail ? { ret: -1 } : {}) });
  try {
    await expect(f.wechat.enqueueMediaNotification({ text: "旧结果", followThreadId: "task", followRequestId: requestId }, "42", "old-task")).rejects.toThrow();
    requestId = "request-2";
    fail = false;
    await f.wechat.enqueueMediaNotification({ text: "新结果", followThreadId: "task", followRequestId: requestId }, "42", "new-task");
    expect(f.sends.map(msg => msg.client_id)).toEqual(["old-task", "new-task"]);
    expect(f.wechat.hasSentNotification("old-task")).toBe(false);
    expect(f.wechat.hasSentNotification("new-task")).toBe(true);
  } finally { await f.wechat.close(); }
});
