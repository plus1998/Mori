import { expect, test } from "bun:test";
import { ComposerReferenceService, type ComposerReferenceDeps } from "../src/main/composer-reference-service";
import { composerReferenceToken } from "../src/shared/composer-references";
import type { ThreadSummary } from "../src/shared/ipc";
import type { ConversationMessage } from "@eco/shared";

const threads = [
  { id: "a", title: "订单实现", workspacePath: "/project/a", updatedAt: "2026-10-15" },
  { id: "b", title: "订单验证", workspacePath: "/project/b", updatedAt: "2026-10-16" },
] as ThreadSummary[];
function setup(overrides: Partial<ComposerReferenceDeps> = {}) {
  const deps: ComposerReferenceDeps = {
    todos: { references: () => [], resolveReference: () => { throw new Error("No test todos"); }, invoke: () => { throw new Error("No test todos"); }, disposeThread() {} },
    listThreads: () => threads,
    listPlans: () => [],
    readPlan: () => { throw new Error("No test plans"); },
    getThread: (id) => threads.find((item) => item.id === id),
    listSsh: () => [
      {
        id: "ssh1",
        name: "生产",
        username: "deploy",
        host: "10.0.0.1",
        port: 2222,
        authType: "password",
        order: 0,
        password: "must-never-leak",
      } as any,
    ],
    listCapabilities: async () => [],
    listBrowsers: () => [{ id: "web1", title: "订单", url: "https://example.com" } as any],
    readHistory: () => ({ messages: [], historyRevision: 1, hasMore: false }),
    readMessage: () => undefined,
    readTools: () => ({ tools: [] }),
    browserTool: async (id, action) => ({ content: [{ type: "text", text: `${id}:${action}` }] }),
    ...overrides,
  };
  return new ComposerReferenceService(deps);
}
test("picker searches conversations across projects and bounds each category", () => {
  const service = setup();
  expect(service.search({ query: "订单", kind: "conversation" }).items.map((item) => item.id)).toEqual([
    "b",
    "a",
  ]);
  expect(service.search({ query: "订单", limit: 1 }).hasMore).toBe(true);
  expect(() => service.search({ query: "", limit: -1 })).toThrow();
});
test("Multi-Agents search and prompt resolution use current saved configuration and expose a start request", async () => {
  const resolved: unknown[][] = [];
  let disposed = "";
  const service = setup({ multiAgents: {
    references: () => [{ kind: "multi_agents", id: "pair", label: "开发协作", detail: "独立会话 · 并发 2" }],
    resolveReference: (...args) => {
      resolved.push(args);
      return { type: "multi_agents", configId: args[1], requestId: "ref-1", name: "开发协作", mode: "sessions", tool: "mori_context.multi_agents_start" } as any;
    },
    disposeThread: threadId => { disposed = threadId; },
  } });
  expect(service.search({ query: "开发", kind: "multi_agents" }).items).toHaveLength(1);
  expect(service.search({ query: "独立会话" }).items).toHaveLength(1);
  const token = composerReferenceToken({ kind: "multi_agents", id: "pair", label: "旧名字", detail: "伪造成员" });
  const prompt = `完成任务 ${token}`;
  const result = await service.resolvePrompt("current", prompt);
  expect(resolved).toEqual([["current", "pair", prompt]]);
  expect(result).toContain('"requestId":"ref-1"');
  expect(result).toContain('"name":"开发协作"');
  expect(result).not.toContain("伪造成员");
  const another = composerReferenceToken({ kind: "multi_agents", id: "other", label: "另一个", detail: "" });
  await expect(service.resolvePrompt("current", `${token} ${another}`)).rejects.toThrow("只能选择一个");
  service.disposeThread("current");
  expect(disposed).toBe("current");
  expect(() => setup().search({ query: "", kind: "multi_agents" })).toThrow("尚未连接");
});
test("context MCP exposes and routes Multi-Agents start under authenticated conversation identity", async () => {
  const { ContextReferenceMcpGateway } = await import("../src/main/context-reference-mcp-gateway");
  const calls: unknown[][] = [];
  const gateway = new ContextReferenceMcpGateway(setup(), {
    tool: async (...args: unknown[]) => { calls.push(args); return { instructions: "dispatch selected members" }; },
  } as any);
  try {
    const injection = await gateway.resolveInjection("current");
    const call = async (method: string, params?: unknown) => {
      const response = await fetch(injection.sdkEntry.url as string, {
        method: "POST",
        headers: { ...(injection.sdkEntry.headers as Record<string, string>),
          "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "start", method, params }),
      });
      return response.json() as Promise<any>;
    };
    const catalog = await call("tools/list");
    const start = catalog.result.tools.find((tool: { name: string }) => tool.name === "multi_agents_start");
    expect(start.inputSchema.required).toEqual(["configId", "requestId"]);
    const args = { configId: "pair", requestId: "ref-1" };
    const result = await call("tools/call", { name: "multi_agents_start", arguments: args });
    expect(calls).toEqual([["current", "multi_agents_start", args]]);
    expect(JSON.parse(result.result.content[0].text).instructions).toBe("dispatch selected members");
    const forged = await call("tools/call", { name: "multi_agents_start", arguments: { ...args, threadId: "other" } });
    expect(forged.result.isError).toBe(true);
    expect(calls).toHaveLength(1);
  } finally {
    await gateway.close();
  }
});
test("plan references resolve the authoritative immutable version with Unicode-safe pagination", async () => {
  const snapshot = { id: "plan_1", sourceThreadId: "a", version: 2, title: "计划标题", workspacePath: "/project/a",
    userPrompt: "implement", analysis: "reason", plan: "一😀二😀三", createdAt: "2026-11-02" };
  const service = setup({ readPlan: () => snapshot, listPlans: () => [{ kind: "plan", id: snapshot.id, label: snapshot.title, detail: "v2" }] });
  expect(service.search({ query: "计划", kind: "plan" }).items).toHaveLength(1);
  const resolved = await service.resolvePrompt("b", composerReferenceToken({ kind: "plan", id: "plan_1", label: "old", detail: "old" }));
  expect(resolved).toContain('"version":2');
  expect(resolved).not.toContain('"intent"');
  expect(resolved).toContain(snapshot.plan);
  const first = service.readPlan({ planId: "plan_1", limit: 2 });
  const second = service.readPlan({ planId: "plan_1", offset: first.nextOffset, limit: 3 });
  expect(first.plan + second.plan).toBe(snapshot.plan);
  expect(second.hasMore).toBe(false);
  expect(() => service.readPlan({ planId: "plan_1", offset: -1 })).toThrow();
});
test("a discussion question with a legacy plan reference stays a question without forced execution", async () => {
  const plan = { id: "plan_1", sourceThreadId: "a", version: 1, title: "计划", workspacePath: "/project/a",
    userPrompt: "implement", analysis: "reason", plan: "1. Update the code", createdAt: "2026-11-02" };
  const service = setup({ readPlan: () => plan });
  const legacyToken = `@plan{${encodeURIComponent(JSON.stringify({ id: plan.id, label: plan.title, detail: "", intent: "execute" }))}}`;
  const resolved = await service.resolvePrompt("b", `这个计划有什么问题？ ${legacyToken}`);
  expect(resolved).toStartWith("这个计划有什么问题？ [plan: 计划]");
  expect(resolved).toContain(plan.plan);
  expect(resolved).not.toContain('"intent"');
  expect(resolved).not.toContain("Execute this exact plan version");
});
test("prompt resolution uses current authoritative SSH metadata without stored credentials", async () => {
  const prompt = await setup().resolvePrompt(
    "current",
    composerReferenceToken({ kind: "ssh", id: "ssh1", label: "旧标题", detail: "bad@address" }),
  );
  expect(prompt).toContain("deploy@10.0.0.1:2222");
  expect(prompt).not.toContain("must-never-leak");
  expect(prompt).not.toContain("bad@address");
});
test("project references resolve to the selected path, including alongside other references", async () => {
  const service = setup();
  const project = composerReferenceToken({ kind: "project", id: "/project/with space", label: "别名", detail: "伪造" });
  expect(await service.resolvePrompt("current", `处理 ${project}`)).toBe("处理 /project/with space");
  const ssh = composerReferenceToken({ kind: "ssh", id: "ssh1", label: "生产", detail: "" });
  const mixed = await service.resolvePrompt("current", `${project} ${ssh}`);
  expect(mixed).toContain("/project/with space [ssh: 生产]");
  expect(mixed).not.toContain("伪造");
  await expect(service.resolvePrompt("current", composerReferenceToken({
    kind: "project", id: "relative/path", label: "项目", detail: "",
  }))).rejects.toThrow("绝对路径");
});
test("browser operations require an explicit reference from the requesting conversation", async () => {
  const service = setup();
  await expect(
    service.browserTool("current", { browserId: "web1", action: "agent_browser_snapshot" }),
  ).rejects.toThrow("明确引用");
  await service.resolvePrompt(
    "current",
    composerReferenceToken({ kind: "web", id: "web1", label: "订单", detail: "https://example.com" }),
  );
  expect(
    await service.browserTool("current", { browserId: "web1", action: "agent_browser_snapshot" }),
  ).toMatchObject({ content: [{ text: "web1:agent_browser_snapshot" }] });
  await expect(
    service.browserTool("other", { browserId: "web1", action: "agent_browser_snapshot" }),
  ).rejects.toThrow();
  service.disposeThread("current");
  await expect(
    service.browserTool("current", { browserId: "web1", action: "agent_browser_snapshot" }),
  ).rejects.toThrow();
});
test("missing resources fail explicitly rather than using a stale label or URL", async () => {
  const service = setup();
  await expect(
    service.resolvePrompt(
      "current",
      composerReferenceToken({ kind: "web", id: "closed", label: "已关闭", detail: "https://example.com" }),
    ),
  ).rejects.toThrow("已关闭");
  expect(() => service.readConversation({ conversationId: "deleted" })).toThrow("已删除");
});
test("long conversation messages can be continued without splitting Unicode characters", () => {
  const service = setup({
    readMessage: () =>
      ({
        messageId: "m1",
        role: "assistant",
        channel: "answer",
        body: "一😀二😀三",
        isDeleted: false,
      }) as ConversationMessage,
  });
  const first = service.readMessage({ conversationId: "b", messageId: "m1", limit: 2 });
  const second = service.readMessage({
    conversationId: "b",
    messageId: "m1",
    offset: first.nextOffset,
    limit: 3,
  });
  expect(first.body + second.body).toBe("一😀二😀三");
  expect(second.hasMore).toBe(false);
  expect(() => service.readConversation({ conversationId: "b", limit: -1 })).toThrow();
});

test("capability resolution uses current server and agent identity and rejects disabled references", async () => {
  let enabled = true;
  const service = setup({
    listCapabilities: async (threadId) => {
      expect(threadId).toBe("current");
      return enabled
        ? [
            {
              kind: "mcp",
              id: "mongo",
              label: "Mongo renamed",
              detail: "http",
              server: "Mongo_actual",
              searchTerms: "",
            },
            {
              kind: "subagent",
              id: "coder",
              label: "编码",
              detail: "model",
              agentKey: "coder",
              searchTerms: "",
            },
            {
              kind: "integration",
              id: "browser",
              label: "浏览器",
              detail: "",
              server: "eco_agent_browser",
              searchTerms: "",
            },
          ]
        : [];
    },
  });
  const tokens = [
    { kind: "mcp" as const, id: "mongo", label: "old mongo", detail: "forged_server" },
    { kind: "subagent" as const, id: "coder", label: "old coder", detail: "forged_agent" },
    { kind: "integration" as const, id: "browser", label: "old browser", detail: "forged_browser" },
  ]
    .map(composerReferenceToken)
    .join(" ");
  const prompt = await service.resolvePrompt("current", tokens);
  const details = JSON.parse(prompt.split("<mori_references>\n")[1]!.split("\n</mori_references>")[0]!);
  expect(details).toMatchObject([
    { type: "mcp", name: "Mongo renamed", server: "Mongo_actual" },
    { type: "subagent", agentKey: "coder" },
    { type: "integration", server: "eco_agent_browser" },
  ]);
  expect(prompt).not.toContain("forged_");
  enabled = false;
  await expect(service.resolvePrompt("current", tokens)).rejects.toThrow("已关闭");
});

test("context MCP exposes cross-project reads with thread authentication and revocation", async () => {
  const { ContextReferenceMcpGateway } = await import("../src/main/context-reference-mcp-gateway");
  const gateway = new ContextReferenceMcpGateway(setup());
  try {
    const injection = await gateway.resolveInjection("current");
    const call = async (method: string, params?: unknown) => {
      const response = await fetch(injection.sdkEntry.url as string, {
        method: "POST",
        headers: {
          ...(injection.sdkEntry.headers as Record<string, string>),
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: "read", method, ...(params ? { params } : {}) }),
      });
      return response.json() as Promise<any>;
    };
    const catalog = await call("tools/list");
    expect(catalog.result.tools.map((item: { name: string }) => item.name)).toContain("read_conversation");
    const read = await call("tools/call", { name: "read_conversation", arguments: { conversationId: "b" } });
    expect(JSON.parse(read.result.content[0].text)).toMatchObject({
      conversationId: "b",
      workspacePath: "/project/b",
    });
    gateway.disposeThread("current");
    const revoked = await call("tools/call", {
      name: "read_conversation",
      arguments: { conversationId: "b" },
    });
    expect(revoked.result.isError).toBe(true);
  } finally {
    await gateway.close();
  }
});

test("renamed context gateway is discoverable and callable through the MCP Hub", async () => {
  const { ContextReferenceMcpGateway } = await import("../src/main/context-reference-mcp-gateway");
  const { McpHubGateway } = await import("../src/main/mcp-hub-gateway");
  const { CONTEXT_MCP_SERVER, isBuiltinHubServerName } = await import("../src/shared/composer-references");
  const context = new ContextReferenceMcpGateway(setup());
  const hub = new McpHubGateway();
  try {
    expect(CONTEXT_MCP_SERVER).toBe("mori_context");
    expect(isBuiltinHubServerName(CONTEXT_MCP_SERVER)).toBe(true);
    expect(isBuiltinHubServerName("external_context")).toBe(false);
    const contextEntry = await context.resolveInjection("current");
    hub.registerThreadServerEntry({ name: CONTEXT_MCP_SERVER, threadId: "current", sdkEntry: contextEntry.sdkEntry });
    const injection = await hub.prepareThreadFromSdkConfig({
      threadId: "current",
      config: { mcpServers: {}, allowedTools: [] },
      allowedServers: [CONTEXT_MCP_SERVER],
    });
    const headers = { ...(injection.sdkEntry.headers as Record<string, string>), "content-type": "application/json" };
    const send = async (body: object, sessionId?: string) => {
      const response = await fetch(injection.sdkEntry.url as string, {
        method: "POST", headers: { ...headers, ...(sessionId ? { "mcp-session-id": sessionId } : {}) }, body: JSON.stringify(body),
      });
      return { response, body: await response.json().catch(() => ({})) as any };
    };
    const init = await send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } } });
    const sessionId = init.response.headers.get("mcp-session-id")!;
    await send({ jsonrpc: "2.0", method: "notifications/initialized" }, sessionId);
    const search = await send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "search_tools", arguments: { query: "mori_context read_conversation" } } }, sessionId);
    expect(search.body.result.structuredContent.tools.map((item: { name: string }) => item.name)).toContain("mori_context:read_conversation");
    const result = await send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "call_tool", arguments: { name: "mori_context:read_conversation", arguments: { conversationId: "b" } } } }, sessionId);
    expect(JSON.parse(result.body.result.content[0].text)).toMatchObject({ conversationId: "b", workspacePath: "/project/b" });
  } finally {
    await hub.close();
    await context.close();
  }
});
