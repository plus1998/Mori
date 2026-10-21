import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  cancelBashApprovalsForThread,
  getPendingBashApprovalByToolUseId,
  registerPendingBashApproval,
  resolvePendingBashApproval,
} from "../src/main/bash-approval-bridge";
import {
  CODEX_MCP_SERVER_ELICITATION_REQUEST,
  type CodexApprovalBridgeDeps,
  cancelCodexApprovalsForThread,
  handleCodexApprovalNotification,
  handleCodexServerRequest,
} from "../src/main/codex-approval-bridge";
import { executeBashApprovalResolutionCommand } from "../src/main/conversation-interaction-command";
import { ConversationV2Store } from "../src/main/conversation-v2-store";
import { createMcpHubNestedToolPermissionHandler } from "../src/main/mcp-hub-permission";
import { McpStore } from "../src/main/mcp-store";
import { buildBashApprovalChoices, canSubmitBashApprovalWithEnter } from "../src/shared/bash-approval-ui";
import type { BashApprovalRequest, ThreadLiveEvent } from "../src/shared/ipc";
import { mcpServerToInput } from "../src/shared/mcp";

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function harness() {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  const store = new McpStore(db);
  store.initialize();
  const server = store.saveServer({
    id: "db-server",
    name: "mysql",
    transport: "http",
    enabled: true,
    url: "https://db.test/mcp",
  });
  const v2 = new ConversationV2Store(db);
  v2.initialize();
  return { db, store, server, v2 };
}

test("MCP grants survive closing and reopening the on-disk database", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "eco-mcp-approval-"));
  let db = new DatabaseSync(path.join(directory, "settings.sqlite"));
  try {
    const first = new McpStore(db);
    first.initialize();
    first.saveServer({
      id: "restart",
      name: "restart",
      enabled: true,
      transport: "stdio",
      command: "test-mcp",
    });
    const target = first.getToolApprovalTarget("restart", "read")!;
    first.rememberToolApproval(target);
    db.close();
    db = new DatabaseSync(path.join(directory, "settings.sqlite"));
    const second = new McpStore(db);
    second.initialize();
    expect(second.isToolApproved(target)).toBe(true);
    const changed = second.saveServer({
      ...mcpServerToInput(second.listServers()[0]!),
      command: "different-mcp",
    });
    expect(changed.rememberedTools).toEqual([]);
    expect(second.isToolApproved(target)).toBe(false);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("saved MCP grants survive store reconstruction and match exact server/tool identities", () => {
  const { db, store } = harness();
  const target = store.getToolApprovalTarget("mysql", "mcp__mysql__query__records")!;
  expect(target.toolName).toBe("query__records");
  store.rememberToolApproval(target);
  const reopened = new McpStore(db);
  reopened.initialize();
  expect(reopened.isToolApproved(target)).toBe(true);
  expect(reopened.isToolApproved({ ...target, toolName: "query__records_delete" })).toBe(false);
  expect(reopened.getToolApprovalTarget("mysql", "mcp__other__query__records")).toBeUndefined();
  expect(reopened.getToolApprovalTarget("mysql", "*")).toBeUndefined();
  expect(reopened.resolveToolApprovalTarget("mcp__mysql__query__records")).toEqual(target);
  expect(reopened.listServers()[0]?.rememberedTools).toEqual(["query__records"]);
});

test("changing endpoint or tool scope invalidates saved and pending grants", () => {
  const { store, server } = harness();
  const target = store.getToolApprovalTarget("mysql", "read")!;
  store.rememberToolApproval(target);
  const changed = store.saveServer({ ...mcpServerToInput(server), url: "https://new-db.test/mcp" });
  expect(store.isToolApproved(target)).toBe(false);
  expect(() => store.rememberToolApproval(target)).toThrow("已变化");
  const current = store.getToolApprovalTarget("mysql", "read")!;
  store.rememberToolApproval(current);
  store.saveServer({ ...mcpServerToInput(changed), allowedTools: "mcp__mysql__write" });
  expect(store.isToolApproved(current)).toBe(false);
  expect(store.getToolApprovalTarget("mysql", "read")).toBeUndefined();
});

test("disabled/deleted/recreated servers cannot reuse authorization; reset revokes without removing the server", () => {
  const { store, server } = harness();
  const target = store.getToolApprovalTarget("mysql", "read")!;
  store.rememberToolApproval(target);
  store.saveServer({ ...mcpServerToInput(server), enabled: false });
  expect(store.isToolApproved(target)).toBe(false);
  store.saveServer({ ...mcpServerToInput(server), resetToolApprovals: true });
  expect(store.isToolApproved(target)).toBe(false);
  store.rememberToolApproval(target);
  store.deleteServer(server.id);
  store.saveServer({ ...mcpServerToInput(server), id: "replacement" });
  expect(store.isToolApproved(target)).toBe(false);
  expect(store.listServers()[0]?.rememberedTools).toEqual([]);
});

test("remembered grants are persisted before tool continuation and idempotent retries do not regrant", async () => {
  const { store, v2 } = harness();
  const target = store.getToolApprovalTarget("mysql", "read")!;
  const request: BashApprovalRequest = {
    threadId: "remember-thread",
    toolUseId: "remember-call",
    command: "mcp__mysql__read",
    cwd: "/repo",
    reason: "read",
    riskScore: 30,
    riskLevel: "low",
    agentId: "main",
    kind: "mcp",
    mcpToolApproval: target,
  };
  v2.ensureConversation(request.threadId);
  const waiting = registerPendingBashApproval(request.threadId, request);
  const input = {
    principalId: "local",
    clientCommandId: "remember",
    conversationId: request.threadId,
    toolUseId: request.toolUseId,
    decision: "approved_remember_mcp_tool" as const,
    expectedHistoryRevision: 0,
  };
  let writes = 0;
  const deps = {
    v2,
    getPending: getPendingBashApprovalByToolUseId,
    rememberMcpToolApproval: () => {
      writes++;
      store.rememberToolApproval(target);
    },
    resolve: (id: string, resolution: Parameters<typeof resolvePendingBashApproval>[1]) => {
      expect(store.isToolApproved(target)).toBe(true);
      return resolvePendingBashApproval(id, resolution);
    },
    errorMessage: String,
  };
  expect(executeBashApprovalResolutionCommand(input, deps)).toMatchObject({ alreadyResolved: false });
  await expect(waiting).resolves.toEqual({ decision: "approved_remember_mcp_tool" });
  store.saveServer({ ...mcpServerToInput(store.listServers()[0]!), resetToolApprovals: true });
  expect(executeBashApprovalResolutionCommand(input, deps)).toEqual({ ok: true, alreadyResolved: true });
  expect(writes).toBe(1);
  expect(store.isToolApproved(target)).toBe(false);
});

test("persistence failure leaves approval parked and does not execute the tool", async () => {
  const { store, v2 } = harness();
  const request: BashApprovalRequest = {
    threadId: "failure-thread",
    toolUseId: "failure-call",
    command: "mcp__mysql__read",
    cwd: "/repo",
    reason: "read",
    riskScore: 30,
    riskLevel: "low",
    agentId: "main",
    mcpToolApproval: store.getToolApprovalTarget("mysql", "read")!,
  };
  v2.ensureConversation(request.threadId);
  const waiting = registerPendingBashApproval(request.threadId, request);
  const deps = {
    v2,
    getPending: getPendingBashApprovalByToolUseId,
    resolve: resolvePendingBashApproval,
    rememberMcpToolApproval: () => {
      throw new Error("disk full");
    },
    errorMessage: String,
  };
  expect(() =>
    executeBashApprovalResolutionCommand(
      {
        principalId: "local",
        clientCommandId: "failed",
        conversationId: request.threadId,
        toolUseId: request.toolUseId,
        decision: "approved_remember_mcp_tool",
        expectedHistoryRevision: 0,
      },
      deps,
    ),
  ).toThrow("disk full");
  expect(getPendingBashApprovalByToolUseId(request.toolUseId)).toBe(request);
  resolvePendingBashApproval(request.toolUseId, { decision: "denied" });
  await waiting;
});

for (const approvalMode of ["always", "auto"] as const) {
  test(`Codex ${approvalMode}: first approval remembers the real Hub tool, another conversation skips it, another tool still asks`, async () => {
    const { store, v2 } = harness();
    const events: ThreadLiveEvent[] = [];
    let reviewCount = 0;
    const deps: CodexApprovalBridgeDeps = {
      resolveEcoThreadId: (id) => id,
      getThread: () => ({ prompt: "read", workspacePath: "/repo" }),
      getWorktreePath: () => "/repo",
      getPlannerAgentId: () => "main",
      getRoutesJson: () => "[]",
      savePendingPlan: () => {},
      updateThreadStatus: () => {},
      getApprovalMode: () => approvalMode,
      getMcpHubServerName: (id) => `eco_mcp_${id}`,
      getMcpToolApprovalTarget: (server, tool) => store.getToolApprovalTarget(server, tool),
      isMcpToolApproved: (target) => store.isToolApproved(target),
      reviewApproval: async () => {
        reviewCount++;
        return { action: "human_required", rationale: "ask" };
      },
      emitThreadLive: (event) => {
        events.push(event);
        if (event.type !== "bash_approval.requested" || !event.bashApproval) return;
        const request = event.bashApproval;
        queueMicrotask(() => {
          v2.ensureConversation(request.threadId);
          executeBashApprovalResolutionCommand(
            {
              principalId: "local",
              clientCommandId: request.toolUseId,
              conversationId: request.threadId,
              toolUseId: request.toolUseId,
              decision:
                request.mcpToolApproval?.toolName === "read" ? "approved_remember_mcp_tool" : "denied",
              expectedHistoryRevision: 0,
            },
            {
              v2,
              getPending: getPendingBashApprovalByToolUseId,
              resolve: resolvePendingBashApproval,
              rememberMcpToolApproval: (target) => store.rememberToolApproval(target),
              errorMessage: String,
            },
          );
        });
      },
    };
    async function call(threadId: string, tool: string) {
      handleCodexApprovalNotification(deps, "item/started", {
        threadId,
        item: {
          id: `call-${tool}`,
          type: "mcpToolCall",
          server: `eco_mcp_${threadId}`,
          tool: "call_tool",
          arguments: { name: `mysql:${tool}`, arguments: { sql: "SELECT 1" } },
        },
      });
      return handleCodexServerRequest(deps, CODEX_MCP_SERVER_ELICITATION_REQUEST, {
        threadId,
        itemId: `call-${tool}`,
        serverName: `eco_mcp_${threadId}`,
        mode: "form",
        requestedSchema: {},
        message: 'run tool "call_tool"',
      });
    }
    expect(await call(`first-${approvalMode}`, "read")).toEqual({ action: "accept", content: {} });
    expect(events[0]?.bashApproval?.mcpToolApproval?.toolName).toBe("read");
    const parked = events.length,
      reviewed = reviewCount;
    expect(await call(`second-${approvalMode}`, "read")).toEqual({ action: "accept", content: {} });
    expect(events).toHaveLength(parked);
    expect(reviewCount).toBe(reviewed);
    expect(await call(`third-${approvalMode}`, "delete")).toEqual({ action: "decline" });
    expect(events.length).toBeGreaterThan(parked);
    for (const prefix of ["first", "second", "third"])
      cancelCodexApprovalsForThread(`${prefix}-${approvalMode}`, "cleanup");
  });
}

test("MCP remember choice is explicit and hidden when SDK forbids persistence", async () => {
  expect(buildBashApprovalChoices({ includeRememberPrefix: false, includeRememberMcpTool: true })).toEqual([
    "approve",
    "approve_remember_mcp_tool",
    "deny",
    "deny_custom",
  ]);
  expect(buildBashApprovalChoices({ includeRememberMcpTool: true, suppressAlwaysAllowRule: true })).toEqual([
    "approve",
    "deny",
    "deny_custom",
  ]);
  expect(canSubmitBashApprovalWithEnter("approve_remember_mcp_tool", true)).toBe(false);
  const { store } = harness();
  const request: BashApprovalRequest = {
    threadId: "suppressed",
    toolUseId: "suppressed-call",
    command: "read",
    cwd: "/repo",
    reason: "read",
    riskScore: 1,
    riskLevel: "low",
    agentId: "main",
    suppressAlwaysAllowRule: true,
    mcpToolApproval: store.getToolApprovalTarget("mysql", "read")!,
  };
  const waiting = registerPendingBashApproval(request.threadId, request);
  expect(() =>
    resolvePendingBashApproval(request.toolUseId, { decision: "approved_remember_mcp_tool" }),
  ).toThrow("forbids persistent");
  cancelBashApprovalsForThread(request.threadId, "cleanup");
  await expect(waiting).rejects.toThrow("cleanup");
});

test("Hub permission delegation preserves the wrapper, including updated nested arguments", async () => {
  const handler = createMcpHubNestedToolPermissionHandler([
    async (request) => {
      expect(request.toolName).toBe("mcp__mysql__read");
      expect(request.input).toEqual({ sql: "SELECT 1" });
      return { behavior: "allow", updatedInput: { sql: "SELECT 2" } };
    },
  ]);
  expect(
    await handler({
      toolName: "mcp__eco_mcp__call_tool",
      toolUseId: "call",
      input: { name: "mysql:read", arguments: { sql: "SELECT 1" } },
      signal: new AbortController().signal,
    }),
  ).toEqual({ behavior: "allow", updatedInput: { name: "mysql:read", arguments: { sql: "SELECT 2" } } });
});

test("concurrent Hub calls cannot borrow another call's remembered identity", async () => {
  const { store } = harness();
  const target = store.getToolApprovalTarget("mysql", "read")!;
  store.rememberToolApproval(target);
  const cards: BashApprovalRequest[] = [];
  const deps: CodexApprovalBridgeDeps = {
    resolveEcoThreadId: () => "concurrent-mcp",
    getThread: () => ({ prompt: "read", workspacePath: "/repo" }),
    getWorktreePath: () => "/repo",
    getPlannerAgentId: () => "main",
    getRoutesJson: () => "[]",
    savePendingPlan: () => {},
    updateThreadStatus: () => {},
    getMcpHubServerName: () => "eco_mcp_concurrent",
    getMcpToolApprovalTarget: (server, tool) => store.getToolApprovalTarget(server, tool),
    isMcpToolApproved: (target) => store.isToolApproved(target),
    emitThreadLive: (event) => {
      if (!event.bashApproval) return;
      cards.push(event.bashApproval);
      queueMicrotask(() => resolvePendingBashApproval(event.bashApproval!.toolUseId, { decision: "denied" }));
    },
  };
  for (const tool of ["delete", "read"])
    handleCodexApprovalNotification(deps, "item/started", {
      threadId: "concurrent-codex",
      item: {
        id: tool,
        type: "mcpToolCall",
        server: "eco_mcp_concurrent",
        tool: "call_tool",
        arguments: { name: `mysql:${tool}`, arguments: {} },
      },
    });
  const params = {
    threadId: "concurrent-codex",
    serverName: "eco_mcp_concurrent",
    mode: "form",
    requestedSchema: {},
    message: 'run tool "call_tool"',
  };
  // Without an item id there is no safe tool-level grant.
  expect(await handleCodexServerRequest(deps, CODEX_MCP_SERVER_ELICITATION_REQUEST, params)).toEqual({
    action: "decline",
  });
  expect(cards[0]?.mcpToolApproval).toBeUndefined();
  expect(
    await handleCodexServerRequest(deps, CODEX_MCP_SERVER_ELICITATION_REQUEST, {
      ...params,
      itemId: "delete",
    }),
  ).toEqual({ action: "decline" });
  expect(cards.at(-1)?.mcpToolApproval?.toolName).toBe("delete");
  const count = cards.length;
  expect(
    await handleCodexServerRequest(deps, CODEX_MCP_SERVER_ELICITATION_REQUEST, { ...params, itemId: "read" }),
  ).toEqual({ action: "accept", content: {} });
  expect(cards).toHaveLength(count);
  cancelCodexApprovalsForThread("concurrent-mcp", "cleanup");
});
