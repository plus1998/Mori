import { expect, test } from "bun:test";
import { submitClarification } from "../src/main/clarification-bridge";
import {
  CODEX_MCP_SERVER_ELICITATION_REQUEST,
  CODEX_TOOL_REQUEST_USER_INPUT,
  type CodexApprovalBridgeDeps,
  handleCodexApprovalNotification,
  handleCodexServerRequest,
  parseMcpToolRunElicitationMessage,
  resolvePendingCodexBashApproval,
  shouldAutoAcceptEcoBrowserToolElicitation,
} from "../src/main/codex-approval-bridge";
import type { ThreadLiveEvent } from "../src/shared/ipc";

test("Codex clarification publishes the answered summary and exits the waiting status", async () => {
  const events: ThreadLiveEvent[] = [];
  const statuses: Array<{ status: string; message: string }> = [];
  const deps: CodexApprovalBridgeDeps = {
    resolveEcoThreadId: () => "thread-1",
    getThread: () => ({ prompt: "实现功能", workspacePath: "/workspace" }),
    getWorktreePath: () => undefined,
    getPlannerAgentId: () => "planner-1",
    getRoutesJson: () => "[]",
    savePendingPlan: () => undefined,
    emitThreadLive: (event) => events.push(event),
    updateThreadStatus: (_threadId, patch) => statuses.push(patch),
  };

  const response = handleCodexServerRequest(deps, CODEX_TOOL_REQUEST_USER_INPUT, {
    threadId: "codex-thread-1",
    turnId: "turn-1",
    itemId: "question-1",
    questions: [
      {
        id: "deployment",
        header: "部署方式",
        question: "应该使用哪种部署方式？",
        options: [
          { label: "蓝绿部署", description: "保持两套环境" },
          { label: "滚动发布", description: "逐步替换实例" },
        ],
      },
    ],
  });

  expect(
    submitClarification("question-1", {
      toolUseId: "question-1",
      selections: [["蓝绿部署"]],
    }),
  ).toBe(true);
  await expect(response).resolves.toEqual({
    answers: { deployment: { answers: ["蓝绿部署"] } },
  });

  expect(statuses).toEqual([
    { status: "running", message: "" },
    { status: "running", message: "" },
  ]);
  expect(events.map((event) => event.type)).toEqual(["clarification.requested", "clarification.answered"]);
  expect(events[1]?.message).toBe("澄清回答：应该使用哪种部署方式？ → 蓝绿部署");
  expect(events[0]?.tool).toEqual({
    name: "AskUserQuestion",
    toolUseId: "question-1",
    status: "started",
  });
  expect(events[1]?.tool).toEqual({
    name: "AskUserQuestion",
    toolUseId: "question-1",
    status: "completed",
  });
});

test("parseMcpToolRunElicitationMessage extracts tool name", () => {
  expect(
    parseMcpToolRunElicitationMessage(
      "eco_agent_browser",
      'Allow the eco_agent_browser MCP server to run tool "agent_browser_open"?',
    ),
  ).toBe("mcp__eco_agent_browser__agent_browser_open");
});

test("shouldAutoAcceptEcoBrowserToolElicitation respects open approval mode", () => {
  const openMsg = 'Allow the eco_agent_browser MCP server to run tool "agent_browser_open"?';
  const snapMsg = 'Allow the eco_agent_browser MCP server to run tool "agent_browser_snapshot"?';
  expect(
    shouldAutoAcceptEcoBrowserToolElicitation({
      serverName: "eco_agent_browser",
      message: openMsg,
      openApprovalMode: "always_allow",
    }),
  ).toBe(true);
  expect(
    shouldAutoAcceptEcoBrowserToolElicitation({
      serverName: "eco_agent_browser",
      message: openMsg,
      openApprovalMode: "always_ask",
    }),
  ).toBe(false);
  expect(
    shouldAutoAcceptEcoBrowserToolElicitation({
      serverName: "eco_agent_browser",
      message: snapMsg,
      openApprovalMode: "always_ask",
    }),
  ).toBe(true);
  expect(
    shouldAutoAcceptEcoBrowserToolElicitation({
      serverName: "github",
      message: openMsg,
      openApprovalMode: "always_allow",
    }),
  ).toBe(false);
  expect(
    shouldAutoAcceptEcoBrowserToolElicitation({
      serverName: "eco_ab_ea4a60abe66",
      message: 'Allow the eco_ab_ea4a60abe66 MCP server to run tool "agent_browser_open"?',
      openApprovalMode: "always_allow",
    }),
  ).toBe(true);
});

test("Codex eco_agent_browser tool elicitation auto-accepts when always allow", async () => {
  const events: ThreadLiveEvent[] = [];
  const deps: CodexApprovalBridgeDeps = {
    resolveEcoThreadId: () => "thread-1",
    getThread: () => ({ prompt: "浏览", workspacePath: "/workspace" }),
    getWorktreePath: () => undefined,
    getPlannerAgentId: () => "planner-1",
    getRoutesJson: () => "[]",
    savePendingPlan: () => undefined,
    emitThreadLive: (event) => events.push(event),
    updateThreadStatus: () => undefined,
    getBrowserOpenApprovalMode: () => "always_allow",
  };

  await expect(
    handleCodexServerRequest(deps, CODEX_MCP_SERVER_ELICITATION_REQUEST, {
      threadId: "codex-thread-1",
      serverName: "eco_agent_browser",
      mode: "form",
      message: 'Allow the eco_agent_browser MCP server to run tool "agent_browser_open"?',
      requestedSchema: { type: "object", properties: {} },
    }),
  ).resolves.toEqual({ action: "accept", content: {} });

  expect(events).toEqual([]);
});

test("Codex eco_agent_browser open elicitation still asks when always_ask", async () => {
  const events: ThreadLiveEvent[] = [];
  const deps: CodexApprovalBridgeDeps = {
    resolveEcoThreadId: () => "thread-1",
    getThread: () => ({ prompt: "浏览", workspacePath: "/workspace" }),
    getWorktreePath: () => undefined,
    getPlannerAgentId: () => "planner-1",
    getRoutesJson: () => "[]",
    savePendingPlan: () => undefined,
    emitThreadLive: (event) => events.push(event),
    updateThreadStatus: () => undefined,
    getBrowserOpenApprovalMode: () => "always_ask",
  };

  const pending = handleCodexServerRequest(deps, CODEX_MCP_SERVER_ELICITATION_REQUEST, {
    threadId: "codex-thread-1",
    serverName: "eco_agent_browser",
    mode: "form",
    message: 'Allow the eco_agent_browser MCP server to run tool "agent_browser_open"?',
    requestedSchema: { type: "object", properties: {} },
  });

  // Wait a macrotask so the async handler can emit clarification before we resolve it.
  await Promise.resolve();
  await Promise.resolve();
  const toolUseId = events[0]?.clarification?.toolUseId;
  expect(toolUseId).toBeTruthy();
  expect(events[0]?.type).toBe("clarification.requested");
  expect(
    submitClarification(toolUseId!, {
      toolUseId: toolUseId!,
      selections: [["同意并继续"]],
    }),
  ).toBe(true);
  await expect(pending).resolves.toEqual({ action: "accept", content: {} });
});

test("Codex Hub elicitation unwraps the started call before showing MCP approval", async () => {
  const events: ThreadLiveEvent[] = [];
  const deps: CodexApprovalBridgeDeps = {
    resolveEcoThreadId: () => "thread-hub-approval",
    getThread: () => ({ prompt: "创建 issue", workspacePath: "/workspace" }),
    getWorktreePath: () => undefined,
    getPlannerAgentId: () => "planner-hub-approval",
    getRoutesJson: () => "[]",
    savePendingPlan: () => undefined,
    emitThreadLive: (event) => events.push(event),
    updateThreadStatus: () => undefined,
  };

  handleCodexApprovalNotification(deps, "item/started", {
    threadId: "codex-hub-approval",
    turnId: "turn-hub-approval",
    item: {
      id: "mcp-call-hub-approval",
      type: "mcpToolCall",
      server: "eco_mcp_abc123",
      tool: "call_tool",
      arguments: {
        name: "github:create_issue",
        arguments: { title: "example" },
      },
    },
  });

  const pending = handleCodexServerRequest(deps, CODEX_MCP_SERVER_ELICITATION_REQUEST, {
    threadId: "codex-hub-approval",
    turnId: "turn-hub-approval",
    serverName: "eco_mcp_abc123",
    mode: "form",
    message: 'Allow the eco_mcp_abc123 MCP server to run tool "call_tool"?',
    requestedSchema: { type: "object", properties: {} },
    _meta: { codex_approval_kind: "mcp_tool_call" },
  });
  await Promise.resolve();
  await Promise.resolve();
  const approval = events[0]?.bashApproval;
  expect(events[0]?.type).toBe("bash_approval.requested");
  expect(approval).toMatchObject({
    kind: "mcp",
    filesystemTool: "MCP",
    filesystemPath: 'github · create_issue\n{"title":"example"}',
  });
  expect(approval?.description).toContain("create_issue");
  expect(approval?.filesystemPath).toContain('"title":"example"');
  const approvalToolUseId = approval?.toolUseId;
  expect(approvalToolUseId).toBeTruthy();
  expect(resolvePendingCodexBashApproval(approvalToolUseId ?? "", { decision: "approved" })).toBe(true);
  await expect(pending).resolves.toEqual({ action: "accept", content: {} });
});
