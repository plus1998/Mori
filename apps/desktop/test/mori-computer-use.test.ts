import { expect, test } from "bun:test";
import { MoriAssistantToolGateway } from "../src/main/mori-assistant-tool-gateway";
import { MoriComputerUse } from "../src/main/mori-computer-use";

function fixture() {
  let enabled = true;
  const calls: string[] = [];
  const viewed: string[] = [];
  const computer = new MoriComputerUse({
    settings: () => ({ agentIntegrationEnabled: enabled, actionApprovalMode: "always_ask" }),
    gateway: {
      isFeatureAvailableQuick: () =>
        enabled ? { available: true } : { available: false, reason: "电脑操作未开启" },
      listTools: async () => ({ tools: [{ name: "get_app_state", inputSchema: { type: "object" } }] }),
      callTool: async (name, _args, signal) => {
        signal?.throwIfAborted();
        calls.push(name);
        return {
          content: [
            {
              type: "text",
              text: '截图已保存："/tmp/mori-owned.png"。如需分析，请调用 eco_image_view:view_image。',
            },
          ],
        };
      },
    },
    imageView: {
      viewForThread: async (threadId, args) => {
        viewed.push(threadId);
        return { content: [{ type: "text", text: `分析：${args.prompt}` }] };
      },
    },
  });
  return {
    computer,
    calls,
    viewed,
    setEnabled: (value: boolean) => {
      enabled = value;
    },
  };
}

test("Mori computer tools obey the global switch, tool allowlist and cancellation", async () => {
  const { computer, calls, setEnabled } = fixture();
  const signal = new AbortController().signal;
  setEnabled(false);
  await expect(computer.listTools(signal)).rejects.toThrow("未开启");
  await expect(computer.callTool("one", "click", {}, signal)).rejects.toThrow("未开启");
  expect(calls).toEqual([]);
  setEnabled(true);
  await expect(computer.callTool("one", "shell", {}, signal)).rejects.toThrow("未知");
  const aborted = new AbortController();
  aborted.abort(new Error("stopped"));
  await expect(computer.callTool("one", "click", {}, aborted.signal)).rejects.toThrow("stopped");
  expect(calls).toEqual([]);
});

test("screenshot analysis is bound to the observing Mori thread and preserves the requested question", async () => {
  const { computer, viewed } = fixture();
  const signal = new AbortController().signal;
  const observed = await computer.callTool("one", "get_app_state", {}, signal);
  expect(JSON.stringify(observed)).toContain("mori_computer_view");
  expect(JSON.stringify(observed)).not.toContain("eco_image_view");
  await expect(
    computer.viewScreenshot("two", "/tmp/mori-owned.png", "当前页面是什么", signal),
  ).rejects.toThrow("当前 Mori 会话");
  await expect(computer.viewScreenshot("one", "/tmp/arbitrary.png", "查看", signal)).rejects.toThrow(
    "当前 Mori 会话",
  );
  expect(await computer.viewScreenshot("one", "/tmp/mori-owned.png", "当前页面是什么", signal)).toEqual({
    content: [{ type: "text", text: "分析：当前页面是什么" }],
  });
  expect(viewed).toEqual(["one"]);
  computer.close();
  await expect(computer.viewScreenshot("one", "/tmp/mori-owned.png", "查看", signal)).rejects.toThrow(
    "当前 Mori 会话",
  );
});

test.each([
  "mori_computer",
  "mori_tasks",
])("runtime %s MCP authenticates calls and propagates failures", async (serverName) => {
  const calls: string[] = [];
  const toolName = serverName === "mori_computer" ? "mori_computer_tools" : "mori_create_todo";
  const gateway = new MoriAssistantToolGateway(
    [{ name: toolName, description: "test", inputSchema: { type: "object" } }],
    async (name) => {
      calls.push(name);
      throw new Error("desktop not ready");
    },
    serverName,
  );
  const config = await gateway.start();
  try {
    const request = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: toolName, arguments: {} },
    };
    const response = await fetch(String(config.url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });
    expect(response.status).toBe(401);
    expect(calls).toEqual([]);
    const headers: Record<string, string> = {
      ...(config.http_headers as Record<string, string>),
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    const initialized = await fetch(String(config.url), {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 0,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "test", version: "1" },
        },
      }),
    });
    const session = initialized.headers.get("mcp-session-id");
    if (session) headers["Mcp-Session-Id"] = session;
    const authorized = await fetch(String(config.url), {
      method: "POST",
      headers,
      body: JSON.stringify(request),
    });
    const body = (await authorized.json()) as {
      result: { isError: boolean; content: Array<{ text: string }> };
    };
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0]?.text).toBe("desktop not ready");
    expect(calls).toEqual([toolName]);
  } finally {
    await gateway.close();
  }
});
