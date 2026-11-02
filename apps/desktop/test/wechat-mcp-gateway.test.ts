import { afterEach, expect, test } from "bun:test";
import { ECO_WECHAT_TOOL, WechatMcpGateway } from "../src/main/wechat-mcp-gateway";

const gateways: WechatMcpGateway[] = [];

afterEach(async () => {
  await Promise.all(gateways.splice(0).map((gateway) => gateway.close()));
});

test("微信 MCP 只在显式授权时注入，并可发送文字/图片", async () => {
  const calls: Array<{ threadId: string; text?: string; image?: { path?: string; url?: string } }> = [];
  const gateway = new WechatMcpGateway({
    send: async (threadId, notification) => {
      calls.push({ threadId, ...notification });
    },
  });
  gateways.push(gateway);
  expect((await gateway.resolveInjection("thread-off", false)).enabled).toBe(false);
  const injection = await gateway.resolveInjection("thread-on", true);
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
