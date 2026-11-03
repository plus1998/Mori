import { afterEach, expect, test } from "bun:test";
import { ECO_WECHAT_TOOL, WechatMcpGateway } from "../src/main/wechat-mcp-gateway";
import type { WechatMcpInjection } from "../src/main/wechat-mcp-gateway";

const gateways: WechatMcpGateway[] = [];

afterEach(async () => {
  await Promise.all(gateways.splice(0).map((gateway) => gateway.close()));
});

async function send(injection: WechatMcpInjection, args: Record<string, unknown>) {
  const response = await fetch(String(injection.sdkEntry?.url), {
    method: "POST", headers: { "content-type": "application/json", ...injection.sdkEntry?.headers as Record<string, string> },
    body: JSON.stringify({ jsonrpc: "2.0", id: crypto.randomUUID(), method: "tools/call",
      params: { name: ECO_WECHAT_TOOL, arguments: args } }),
  });
  return response.json() as Promise<{ result?: { isError?: boolean; content?: unknown[] }; error?: unknown }>;
}

test("对话指令的发送失败如实返回；重试使用相同通知 ID，新任务使用新 ID", async () => {
  const ids: string[] = [];
  let online = false;
  const gateway = new WechatMcpGateway({ send: async (_thread, _notification, id) => {
    ids.push(id);
    if (!online) throw new Error("微信渠道未在线");
  } });
  gateways.push(gateway);
  const first = await gateway.resolveInjection("thread", true, "request-1");
  const failed = await send(first, { text: "完成" });
  expect(JSON.stringify(failed)).toContain("微信渠道未在线");
  expect(JSON.stringify(failed)).not.toContain('"sent":true');
  online = true;
  expect((await send(first, { text: "完成" })).result?.isError).not.toBe(true);
  expect(ids[0]).toBe(ids[1]);
  const next = await gateway.resolveInjection("thread", true, "request-2");
  await send(next, { text: "完成" });
  expect(ids[2]).not.toBe(ids[1]);
  const count = ids.length;
  await send(first, { text: "旧请求不能再发" });
  expect(ids).toHaveLength(count);
  await gateway.resolveInjection("thread", false, "request-3");
  await send(next, { text: "没有新授权不能发" });
  expect(ids).toHaveLength(count);
});

test("对话指令支持绝对图片路径，拒绝同时提供路径和 URL", async () => {
  const calls: unknown[] = [];
  const gateway = new WechatMcpGateway({ send: async (_thread, notification) => { calls.push(notification); } });
  gateways.push(gateway);
  const injection = await gateway.resolveInjection("thread", true, "request");
  await send(injection, { imagePath: "/tmp/screenshot.png" });
  expect(calls).toEqual([{ image: { path: "/tmp/screenshot.png" } }]);
  expect(JSON.stringify(await send(injection, { imagePath: "/tmp/a.png", imageUrl: "https://example.test/a.png" }))).toContain("其中之一");
  expect(calls).toHaveLength(1);
});

test("多个对话同时首次启用微信能力时，共享已就绪的网关", async () => {
  const gateway = new WechatMcpGateway({ send: async () => {} });
  gateways.push(gateway);
  const injections = await Promise.all(["one", "two", "three"].map(id => gateway.resolveInjection(id, true, `request-${id}`)));
  for (const injection of injections) expect((await send(injection, { text: "完成" })).result?.isError).not.toBe(true);
});

test("微信 MCP 只在显式授权时注入，并可发送文字/图片", async () => {
  const calls: Array<{ threadId: string; text?: string; image?: { path?: string; url?: string } }> = [];
  const gateway = new WechatMcpGateway({
    send: async (threadId, notification) => {
      calls.push({ threadId, ...notification });
    },
  });
  gateways.push(gateway);
  expect((await gateway.resolveInjection("thread-off", false, "request-off")).enabled).toBe(false);
  const injection = await gateway.resolveInjection("thread-on", true, "request-on");
  expect(injection.enabled).toBe(true);
  const url = String(injection.sdkEntry?.url);
  const headers = injection.sdkEntry?.headers as Record<string, string>;
  const init = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" } },
    }),
  });
  expect(init.status).toBe(200);
  const called = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: ECO_WECHAT_TOOL,
        arguments: { text: "已完成", imageUrl: "https://example.test/shot.png" },
      },
    }),
  });
  expect(called.status).toBe(200);
  expect(calls).toEqual([
    { threadId: "thread-on", text: "已完成", image: { url: "https://example.test/shot.png" } },
  ]);
});
