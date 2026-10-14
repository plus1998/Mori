import { expect, test } from "bun:test";
import type { AcpPermissionRequest } from "@eco/runtime";
import {
  createAcpPermissionHandler,
  mapAcpPermissionToBashApprovalRequest,
  mapBashResolutionToAcpPermission,
  shouldAutoAllowAcpEcoBrowserTool,
  shouldAutoAllowAcpEcoComputerUseTool,
} from "../src/main/acp-permission-bridge";
import type { BashApprovalRequest } from "../src/shared/ipc";

const EXECUTE_REQUEST: AcpPermissionRequest = {
  sessionId: "sess-1",
  toolCall: {
    toolCallId: "call_sh",
    kind: "execute",
    title: "ls -la",
    rawInput: { command: "ls -la" },
  },
  options: [
    { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
    { optionId: "allow-always", name: "Allow always", kind: "allow_always" },
    { optionId: "reject-once", name: "Reject", kind: "reject_once" },
  ],
};

const BROWSER_EVAL_REQUEST: AcpPermissionRequest = {
  toolCall: {
    toolCallId: "call_browser_eval",
    kind: "other",
    title: "eco_agent_browser-agent_browser_eval: agent_browser_eval",
    rawInput: { script: "1+1" },
  },
  options: [
    { optionId: "allow-once", kind: "allow_once" },
    { optionId: "reject-once", kind: "reject_once" },
  ],
};

const BROWSER_OPEN_REQUEST: AcpPermissionRequest = {
  toolCall: {
    toolCallId: "call_browser_open",
    kind: "other",
    title: "eco_agent_browser-agent_browser_open: agent_browser_open",
    rawInput: { url: "https://example.com" },
  },
  options: [
    { optionId: "allow-once", kind: "allow_once" },
    { optionId: "reject-once", kind: "reject_once" },
  ],
};

test("maps execute toolCall command into Eco bash approval request", () => {
  const mapped = mapAcpPermissionToBashApprovalRequest({
    threadId: "thr_1",
    request: EXECUTE_REQUEST,
    cwd: "/tmp/ws",
    agentId: "planner_1",
    reason: "needs confirmation",
  });
  expect(mapped.command).toBe("ls -la");
  expect(mapped.kind).toBe("command");
  expect(mapped.toolUseId).toBe("call_sh");
});

test("approved_remember_prefix selects allow_always when Cursor offers it", () => {
  expect(mapBashResolutionToAcpPermission(EXECUTE_REQUEST, { decision: "approved_remember_prefix" })).toEqual(
    { outcome: { outcome: "selected", optionId: "allow-always" } },
  );
  expect(mapBashResolutionToAcpPermission(EXECUTE_REQUEST, { decision: "approved" })).toEqual({
    outcome: { outcome: "selected", optionId: "allow-once" },
  });
  expect(mapBashResolutionToAcpPermission(EXECUTE_REQUEST, { decision: "denied" })).toEqual({
    outcome: { outcome: "selected", optionId: "reject-once" },
  });
});

test("allow_all auto-allows without parking Eco bash approval", async () => {
  const parked: BashApprovalRequest[] = [];
  const handler = createAcpPermissionHandler("thr_1", {
    getBashReviewMode: () => "allow_all",
    getCwd: () => "/tmp/ws",
    getWorkspacePath: () => "/tmp/ws",
    getPlannerAgentId: () => "planner_1",
    getRememberPrefixes: () => [],
    evaluateConfirmation: () => {
      throw new Error("should not evaluate when allow_all");
    },
    registerPending: async (_threadId, request) => {
      parked.push(request);
      return { decision: "approved" };
    },
    rememberPrefix: () => {},
    emit: () => {},
  });
  await expect(handler(EXECUTE_REQUEST)).resolves.toEqual({
    outcome: { outcome: "selected", optionId: "allow-once" },
  });
  expect(parked).toEqual([]);
});

test("auto mode reviews script effects even when the preliminary shell policy allows", async () => {
  let reviewed = 0;
  const handler = createAcpPermissionHandler("thr_1", {
    getBashReviewMode: () => "auto",
    getCwd: () => "/repo",
    getWorkspacePath: () => "/repo",
    getPlannerAgentId: () => "planner_1",
    getRememberPrefixes: () => [],
    evaluateConfirmation: () => ({
      action: "allow",
      reason: "Low preliminary score",
      userMessage: "Allowed",
    }),
    reviewApproval: async (_request, tool) => {
      reviewed += 1;
      expect(tool.toolInput).toEqual({ command: "python3 -c \"import shutil; shutil.rmtree('src')\"" });
      return { action: "deny", rationale: "Deletes uncommitted user work" };
    },
    registerPending: async (_threadId, request) => {
      expect(request.reviewRationale).toContain("Deletes uncommitted user work");
      return { decision: "approved" };
    },
    rememberPrefix: () => {},
    emit: () => {},
  });
  const result = await handler({
    ...EXECUTE_REQUEST,
    toolCall: {
      ...EXECUTE_REQUEST.toolCall,
      rawInput: { command: "python3 -c \"import shutil; shutil.rmtree('src')\"" },
    },
  });
  expect(result).toEqual({ outcome: { outcome: "selected", optionId: "allow-once" } });
  expect(reviewed).toBe(1);
});

test("always parks execute commands on Eco bash approval", async () => {
  const parked: BashApprovalRequest[] = [];
  const handler = createAcpPermissionHandler("thr_1", {
    getBashReviewMode: () => "always",
    getCwd: () => "/tmp/ws",
    getWorkspacePath: () => "/tmp/ws",
    getPlannerAgentId: () => "planner_1",
    getRememberPrefixes: () => [],
    evaluateConfirmation: () => ({
      action: "ask",
      reason: "always mode",
      userMessage: "需要确认",
    }),
    registerPending: async (_threadId, request) => {
      parked.push(request);
      return { decision: "approved" };
    },
    rememberPrefix: () => {},
    emit: () => {},
  });
  await expect(handler(EXECUTE_REQUEST)).resolves.toEqual({
    outcome: { outcome: "selected", optionId: "allow-once" },
  });
  expect(parked).toHaveLength(1);
  expect(parked[0]?.command).toBe("ls -la");
});

function createAutoHandler(input: {
  parked: BashApprovalRequest[];
  reviewed: Array<{ toolName: string }>;
  reviewAction?: "allow" | "human_required" | "deny";
}) {
  return createAcpPermissionHandler("thr_1", {
    getBashReviewMode: () => "auto",
    getCwd: () => "/tmp/ws",
    getWorkspacePath: () => "/tmp/ws",
    getPlannerAgentId: () => "planner_1",
    getRememberPrefixes: () => [],
    evaluateConfirmation: () => ({
      action: "ask",
      reason: "auto mode",
      userMessage: "需要确认",
    }),
    reviewApproval: async (_request, tool) => {
      input.reviewed.push({ toolName: tool.toolName });
      if (input.reviewAction === "human_required") {
        return {
          action: "human_required",
          rationale: "need a person",
          policyMatches: [],
        };
      }
      if (input.reviewAction === "deny") {
        return {
          action: "deny",
          rationale: "blocked",
          policyMatches: [],
        };
      }
      return {
        action: "allow",
        rationale: "safe",
        riskLevel: "low",
        policyMatches: [],
      };
    },
    registerPending: async (_threadId, request) => {
      input.parked.push(request);
      return { decision: "approved" };
    },
    rememberPrefix: () => {},
    emit: () => {},
  });
}

test("替我审批 uses Eco auxiliary review, not Cursor config", async () => {
  const parked: BashApprovalRequest[] = [];
  const reviewed: Array<{ toolName: string }> = [];
  const handler = createAutoHandler({ parked, reviewed });
  await expect(handler(EXECUTE_REQUEST)).resolves.toEqual({
    outcome: { outcome: "selected", optionId: "allow-once" },
  });
  expect(reviewed).toEqual([{ toolName: "Bash" }]);
  expect(parked).toEqual([]);
});

test("替我审批 reviews non-execute ACP tools instead of parking immediately", async () => {
  const parked: BashApprovalRequest[] = [];
  const reviewed: Array<{ toolName: string }> = [];
  const handler = createAutoHandler({ parked, reviewed });
  const edit: AcpPermissionRequest = {
    toolCall: {
      toolCallId: "call_edit",
      kind: "edit",
      title: "Write file",
      rawInput: { path: "/tmp/ws/a.ts" },
    },
    options: [
      { optionId: "allow-once", kind: "allow_once" },
      { optionId: "reject-once", kind: "reject_once" },
    ],
  };
  await expect(handler(edit)).resolves.toEqual({
    outcome: { outcome: "selected", optionId: "allow-once" },
  });
  expect(reviewed).toEqual([{ toolName: "Edit" }]);
  expect(parked).toEqual([]);
});

test("替我审批 parks after auxiliary review returns human_required", async () => {
  const parked: BashApprovalRequest[] = [];
  const reviewed: Array<{ toolName: string }> = [];
  const handler = createAutoHandler({ parked, reviewed, reviewAction: "human_required" });
  const search: AcpPermissionRequest = {
    toolCall: {
      toolCallId: "web_search_0",
      kind: "search",
      title: "Web search",
    },
    options: [
      { optionId: "allow-once", kind: "allow_once" },
      { optionId: "reject-once", kind: "reject_once" },
    ],
  };
  await expect(handler(search)).resolves.toEqual({
    outcome: { outcome: "selected", optionId: "allow-once" },
  });
  expect(reviewed).toEqual([{ toolName: "WebSearch" }]);
  expect(parked).toHaveLength(1);
  expect(parked[0]?.reviewRationale).toBe("need a person");
});

test("missing planner agentId rejects instead of inventing an id", async () => {
  const handler = createAcpPermissionHandler("thr_1", {
    getBashReviewMode: () => "always",
    getCwd: () => "/tmp/ws",
    getWorkspacePath: () => "/tmp/ws",
    getPlannerAgentId: () => undefined,
    getRememberPrefixes: () => [],
    evaluateConfirmation: () => {
      throw new Error("should not evaluate without agentId");
    },
    registerPending: async () => {
      throw new Error("should not park without agentId");
    },
    rememberPrefix: () => {},
    emit: () => {},
  });
  await expect(handler(EXECUTE_REQUEST)).resolves.toEqual({
    outcome: { outcome: "selected", optionId: "reject-once" },
  });
});

test("switch_mode is auto-allowed; web search still parks in Eco always", async () => {
  const parked: BashApprovalRequest[] = [];
  const handler = createAcpPermissionHandler("thr_1", {
    getBashReviewMode: () => "always",
    getCwd: () => "/tmp/ws",
    getWorkspacePath: () => "/tmp/ws",
    getPlannerAgentId: () => "planner_1",
    getRememberPrefixes: () => [],
    evaluateConfirmation: () => {
      throw new Error("switch_mode/search should not use bash policy");
    },
    registerPending: async (_threadId, request) => {
      parked.push(request);
      return { decision: "approved" };
    },
    rememberPrefix: () => {},
    emit: () => {},
  });

  const switchMode: AcpPermissionRequest = {
    toolCall: { toolCallId: "call_switch", kind: "switch_mode", title: "Ready" },
    options: [
      { optionId: "agent", kind: "allow_always" },
      { optionId: "reject", kind: "reject_once" },
    ],
  };
  await expect(handler(switchMode)).resolves.toEqual({
    outcome: { outcome: "selected", optionId: "agent" },
  });
  expect(parked).toEqual([]);

  const search: AcpPermissionRequest = {
    toolCall: { toolCallId: "web_search_0", kind: "search", title: "Web search" },
    options: [
      { optionId: "allow-once", kind: "allow_once" },
      { optionId: "reject-once", kind: "reject_once" },
    ],
  };
  await expect(handler(search)).resolves.toEqual({
    outcome: { outcome: "selected", optionId: "allow-once" },
  });
  expect(parked).toHaveLength(1);
  expect(parked[0]?.kind).toBe("network");
});

test("shouldAutoAllowAcpEcoBrowserTool mirrors settings always_allow / always_ask", () => {
  expect(
    shouldAutoAllowAcpEcoBrowserTool({
      toolName: "eco_agent_browser-agent_browser_eval: agent_browser_eval",
      openApprovalMode: "always_allow",
    }),
  ).toBe(true);
  expect(
    shouldAutoAllowAcpEcoBrowserTool({
      toolName: "eco_agent_browser-agent_browser_open: agent_browser_open",
      openApprovalMode: "always_ask",
    }),
  ).toBe(false);
  expect(
    shouldAutoAllowAcpEcoBrowserTool({
      toolName: "eco_agent_browser-agent_browser_eval: agent_browser_eval",
      openApprovalMode: "always_ask",
    }),
  ).toBe(true);
  expect(
    shouldAutoAllowAcpEcoComputerUseTool({
      toolName: "eco_computer_use-click: click",
      actionApprovalMode: "always_allow",
    }),
  ).toBe(true);
});

test("browser always_allow skips auxiliary review under ACP auto mode", async () => {
  const parked: BashApprovalRequest[] = [];
  const reviewed: Array<{ toolName: string }> = [];
  const handler = createAcpPermissionHandler("thr_1", {
    getBashReviewMode: () => "auto",
    getBrowserOpenApprovalMode: () => "always_allow",
    getCwd: () => "/tmp/ws",
    getWorkspacePath: () => "/tmp/ws",
    getPlannerAgentId: () => "planner_1",
    getRememberPrefixes: () => [],
    evaluateConfirmation: () => {
      throw new Error("browser tools should not hit bash policy");
    },
    reviewApproval: async (_request, tool) => {
      reviewed.push({ toolName: tool.toolName });
      return {
        action: "human_required",
        rationale: "辅助模型审批失败或返回了无效 JSON，已按失败关闭策略转人工审批。",
        policyMatches: ["review_failed_closed"],
      };
    },
    registerPending: async (_threadId, request) => {
      parked.push(request);
      return { decision: "approved" };
    },
    rememberPrefix: () => {},
    emit: () => {},
  });

  await expect(handler(BROWSER_EVAL_REQUEST)).resolves.toEqual({
    outcome: { outcome: "selected", optionId: "allow-once" },
  });
  expect(reviewed).toEqual([]);
  expect(parked).toEqual([]);
});

test("browser always_ask still reviews open tools under ACP auto mode", async () => {
  const parked: BashApprovalRequest[] = [];
  const reviewed: Array<{ toolName: string }> = [];
  const handler = createAcpPermissionHandler("thr_1", {
    getBashReviewMode: () => "auto",
    getBrowserOpenApprovalMode: () => "always_ask",
    getCwd: () => "/tmp/ws",
    getWorkspacePath: () => "/tmp/ws",
    getPlannerAgentId: () => "planner_1",
    getRememberPrefixes: () => [],
    evaluateConfirmation: () => {
      throw new Error("open tools should go to review, not bash policy");
    },
    reviewApproval: async (_request, tool) => {
      reviewed.push({ toolName: tool.toolName });
      return {
        action: "human_required",
        rationale: "need a person",
        policyMatches: [],
      };
    },
    registerPending: async (_threadId, request) => {
      parked.push(request);
      return { decision: "approved" };
    },
    rememberPrefix: () => {},
    emit: () => {},
  });

  await expect(handler(BROWSER_OPEN_REQUEST)).resolves.toEqual({
    outcome: { outcome: "selected", optionId: "allow-once" },
  });
  expect(reviewed).toHaveLength(1);
  expect(parked).toHaveLength(1);

  // Non-open tools remain auto-allowed even under always_ask.
  reviewed.length = 0;
  parked.length = 0;
  await expect(handler(BROWSER_EVAL_REQUEST)).resolves.toEqual({
    outcome: { outcome: "selected", optionId: "allow-once" },
  });
  expect(reviewed).toEqual([]);
  expect(parked).toEqual([]);
});
