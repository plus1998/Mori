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
  await writeFile(file, JSON.stringify({ token: "token", userId: "user", cursor: "", inbox: [], outbox: [] }));
  let pollCount = 0;
  let sent = false;
  globalThis.fetch = (async (input, init) => {
    if (String(input).endsWith("/getupdates")) {
      if (pollCount++ === 0)
        return Response.json({
          msgs: [{ message_id: "42", from_user_id: "user", context_token: "context", item_list: [{ text_item: { text: "你好" } }] }],
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
});

test.each([
  [{ ret: 0, errcode: -14, errmsg: "expired" }, "微信返回错误 -14：expired"],
  [{ msgs: "invalid", get_updates_buf: "cursor" }, "微信返回了无效的消息拉取结果。"],
  [{}, "微信返回了无效的消息拉取结果。"],
])("拒绝错误或缺少有效数据的拉取响应", async (response, expected) => {
  const dir = await mkdtemp(path.join(tmpdir(), "mori-wechat-test-"));
  directories.push(dir);
  const file = path.join(dir, "state.json");
  await writeFile(file, JSON.stringify({ token: "token", userId: "user", cursor: "", inbox: [], outbox: [] }));
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
