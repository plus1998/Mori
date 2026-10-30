import { expect, test } from "bun:test";
import {
  CODEX_MCP_SERVER_ELICITATION_REQUEST,
  type CodexApprovalBridgeDeps,
  cancelCodexApprovalsForThread,
  handleCodexApprovalNotification,
  handleCodexServerRequest,
  resolvePendingCodexBashApproval,
} from "../src/main/codex-approval-bridge";
import type { ThreadLiveEvent } from "../src/shared/ipc";
import { presentMcpApproval } from "../src/shared/mcp-approval-presentation";

for (const mode of ["always", "auto", "allow_all"] as const) {
  test(`registered Hub metadata discovery does not park or review in ${mode}, even with a pending call_tool`, async () => {
    const server = `eco_mcp_abc123_thr_${mode}`;
    const reviewed: unknown[] = [],
      events: ThreadLiveEvent[] = [];
    const deps: CodexApprovalBridgeDeps = {
      resolveEcoThreadId: () => "eco-thread",
      getThread: () => ({ prompt: "任务", workspacePath: "/repo" }),
      getWorktreePath: () => "/repo",
      getPlannerAgentId: () => "main",
      getRoutesJson: () => "[]",
      savePendingPlan: () => {},
      updateThreadStatus: () => {},
      getApprovalMode: () => mode,
      getMcpHubServerName: () => server,
      reviewApproval: async (_thread, _request, tool) => {
        reviewed.push(tool);
        return { action: "human_required", rationale: "Confirm actual action" };
      },
      emitThreadLive: (event) => {
        events.push(event);
        const request = event.bashApproval;
        if (request)
          queueMicrotask(() => resolvePendingCodexBashApproval(request.toolUseId, { decision: "denied" }));
      },
    };
    handleCodexApprovalNotification(deps, "item/started", {
      threadId: `codex-${mode}`,
      item: {
        id: "pending-call",
        type: "mcpToolCall",
        server,
        tool: "call_tool",
        arguments: { name: "mysql:mysql_query", arguments: { sql: "DROP TABLE records" } },
      },
    });
    const request = { threadId: `codex-${mode}`, serverName: server, mode: "form", requestedSchema: {} };
    const result = await handleCodexServerRequest(deps, CODEX_MCP_SERVER_ELICITATION_REQUEST, {
      ...request,
      message: `Allow the ${server} MCP server to run tool "search_tools"?`,
    });
    expect(result).toEqual({ action: "accept", content: {} });
    expect(reviewed).toHaveLength(0);
    expect(events).toHaveLength(0);
    if (mode !== "allow_all") {
      const actual = await handleCodexServerRequest(deps, CODEX_MCP_SERVER_ELICITATION_REQUEST, {
        ...request,
        message: `Allow the ${server} MCP server to run tool "call_tool"?`,
      });
      expect(actual).toEqual({ action: "decline" });
      expect(events[0]?.bashApproval?.filesystemPath).toContain("DROP TABLE records");
      if (mode === "auto")
        expect(reviewed[0]).toMatchObject({
          toolName: "mcp__mysql__mysql_query",
          toolInput: { sql: "DROP TABLE records" },
        });
    }
    cancelCodexApprovalsForThread("eco-thread", "cleanup");
  });
}

test("a similarly named external server cannot bypass ordinary approval", async () => {
  let reviewed = false,
    parked = false;
  const deps: CodexApprovalBridgeDeps = {
    resolveEcoThreadId: () => "eco-thread",
    getThread: () => ({ prompt: "任务", workspacePath: "/repo" }),
    getWorktreePath: () => "/repo",
    getPlannerAgentId: () => "main",
    getRoutesJson: () => "[]",
    savePendingPlan: () => {},
    updateThreadStatus: () => {},
    getApprovalMode: () => "auto",
    getMcpHubServerName: () => "eco_mcp_owned",
    reviewApproval: async () => {
      reviewed = true;
      return { action: "human_required", rationale: "External tool" };
    },
    emitThreadLive: (event) => {
      const request = event.bashApproval;
      if (request) {
        parked = true;
        queueMicrotask(() => resolvePendingCodexBashApproval(request.toolUseId, { decision: "denied" }));
      }
    },
  };
  expect(
    await handleCodexServerRequest(deps, CODEX_MCP_SERVER_ELICITATION_REQUEST, {
      threadId: "codex-external",
      serverName: "eco_mcp_other_thread",
      mode: "form",
      requestedSchema: {},
      message: 'Allow eco_mcp_other_thread to run tool "search_tools"?',
    }),
  ).toEqual({ action: "decline" });
  expect(reviewed).toBe(true);
  expect(parked).toBe(true);
});

test("legacy cards hide runtime ids while retaining exact tool arguments and the routing command", () => {
  const server = "eco_mcp_c19172d3_thr_1791441942755";
  const request = {
    kind: "mcp",
    filesystemTool: "MCP",
    command: `mcp__${server}__search_tools`,
    filesystemPath: `${server}/mcp__${server}__search_tools`,
    description: `Allow the ${server} MCP server to run tool "search_tools"?`,
    reason: `Agent 请求调用 ${server}`,
  };
  const display = presentMcpApproval(request);
  expect(display.description).toBe("查找 MCP 工具");
  expect(display.filesystemPath).toBe("Mori MCP Hub · 查找 MCP 工具");
  expect(display.reason).not.toContain("1791441942755");
  expect(display.command).toBe(request.command);
  expect(request.description).toContain(server);
  const nested = presentMcpApproval({
    ...request,
    filesystemPath: "mysql/mcp__mysql__query__records",
    description:
      'Allow mysql to run tool "query__records" with arguments {"sql":"SELECT MIN(id) FROM records"}?',
  });
  expect(nested.filesystemPath).toBe('mysql · query__records\n{"sql":"SELECT MIN(id) FROM records"}');
});
