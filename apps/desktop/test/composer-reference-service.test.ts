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
test("prompt resolution uses current authoritative SSH metadata without stored credentials", async () => {
  const prompt = await setup().resolvePrompt(
    "current",
    composerReferenceToken({ kind: "ssh", id: "ssh1", label: "旧标题", detail: "bad@address" }),
  );
  expect(prompt).toContain("deploy@10.0.0.1:2222");
  expect(prompt).not.toContain("must-never-leak");
  expect(prompt).not.toContain("bad@address");
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
  const details = JSON.parse(prompt.split("<eco_references>\n")[1]!.split("\n</eco_references>")[0]!);
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
