import { expect, test } from "bun:test";
import {
  CODEX_COMMAND_EXECUTION_REQUEST_APPROVAL,
  CODEX_FILE_CHANGE_REQUEST_APPROVAL,
  CODEX_MCP_SERVER_ELICITATION_REQUEST,
  type CodexApprovalBridgeDeps,
  cancelCodexApprovalsForThread,
  handleCodexApprovalNotification,
  handleCodexServerRequest,
  resolvePendingCodexBashApproval,
} from "../src/main/codex-approval-bridge";
import type { BashApprovalDecision, ThreadLiveEvent } from "../src/shared/ipc";

test("Codex file review receives exact changes from item/started, then clears completed/cancelled evidence", async () => {
  const reviewed: Record<string, unknown>[] = [];
  const deps: CodexApprovalBridgeDeps = {
    resolveEcoThreadId: () => "file-evidence-thread",
    getThread: () => ({ prompt: "Remove obsolete file", workspacePath: "/repo" }),
    getWorktreePath: () => "/repo",
    getPlannerAgentId: () => "planner",
    getRoutesJson: () => "[]",
    savePendingPlan: () => {},
    emitThreadLive: () => {},
    updateThreadStatus: () => {},
    getApprovalMode: () => "auto",
    reviewApproval: async (_thread, _request, tool) => {
      reviewed.push(tool.toolInput);
      return { action: "allow", rationale: "Scoped change" };
    },
  };
  const changes = [{ path: "/repo/obsolete.ts", kind: { type: "delete" }, diff: "-old" }];
  const params = {
    threadId: "codex-file-evidence",
    turnId: "turn",
    itemId: "file-item",
    startedAtMs: 1,
    reason: "file change",
  };
  handleCodexApprovalNotification(deps, "item/started", {
    threadId: params.threadId,
    item: { id: params.itemId, type: "fileChange", changes },
  });
  await handleCodexServerRequest(deps, CODEX_FILE_CHANGE_REQUEST_APPROVAL, params);
  expect(reviewed[0]?.changes).toEqual(changes);
  handleCodexApprovalNotification(deps, "item/completed", {
    threadId: params.threadId,
    item: { id: params.itemId, type: "fileChange" },
  });
  await handleCodexServerRequest(deps, CODEX_FILE_CHANGE_REQUEST_APPROVAL, params);
  expect(reviewed[1]?.changes).toBeUndefined();
  handleCodexApprovalNotification(deps, "item/started", {
    threadId: params.threadId,
    item: { id: params.itemId, type: "fileChange", changes },
  });
  cancelCodexApprovalsForThread("file-evidence-thread", "test cleanup");
  await handleCodexServerRequest(deps, CODEX_FILE_CHANGE_REQUEST_APPROVAL, params);
  expect(reviewed[2]?.changes).toBeUndefined();
});

test("Codex auto mode returns accept when the approval reviewer allows the command", async () => {
  const events: ThreadLiveEvent[] = [];
  const deps: CodexApprovalBridgeDeps = {
    resolveEcoThreadId: () => "thread-1",
    getThread: () => ({ prompt: "检查仓库状态", workspacePath: "/workspace" }),
    getWorktreePath: () => "/workspace",
    getPlannerAgentId: () => "planner-1",
    getRoutesJson: () => "[]",
    savePendingPlan: () => undefined,
    emitThreadLive: (event) => events.push(event),
    updateThreadStatus: () => undefined,
    getApprovalMode: () => "auto",
    reviewApproval: async () => ({ action: "allow", rationale: "Read-only inspection." }),
  };

  await expect(
    handleCodexServerRequest(deps, CODEX_COMMAND_EXECUTION_REQUEST_APPROVAL, {
      threadId: "codex-thread-1",
      turnId: "turn-1",
      itemId: "command-1",
      startedAtMs: 1,
      command: "git status",
      cwd: "/workspace",
      reason: "Sandbox requires approval",
    }),
  ).resolves.toEqual({ decision: "accept" });

  expect(events.map((event) => event.type)).toEqual(["bash_approval.approved"]);
  expect(events[0]?.message).toContain("审批模型已允许");
  expect(events[0]?.bashApproval).toMatchObject({
    reason: "Sandbox requires approval",
    description: "Sandbox requires approval",
    reviewRationale: "Read-only inspection.",
  });
});

test("Codex auto mode preserves the original request when the reviewer requires a human", async () => {
  const events: ThreadLiveEvent[] = [];
  const deps: CodexApprovalBridgeDeps = {
    resolveEcoThreadId: () => "thread-human",
    getThread: () => ({ prompt: "检查仓库状态", workspacePath: "/workspace" }),
    getWorktreePath: () => "/workspace",
    getPlannerAgentId: () => "planner-human",
    getRoutesJson: () => "[]",
    savePendingPlan: () => undefined,
    emitThreadLive: (event) => {
      events.push(event);
      if (event.type === "bash_approval.requested") {
        queueMicrotask(() => {
          resolvePendingCodexBashApproval("command-human", { decision: "denied" });
        });
      }
    },
    updateThreadStatus: () => undefined,
    getApprovalMode: () => "auto",
    reviewApproval: async () => ({
      action: "human_required",
      rationale: "No tool action details provided; cannot assess risk or authorization.",
    }),
  };

  await expect(
    handleCodexServerRequest(deps, CODEX_COMMAND_EXECUTION_REQUEST_APPROVAL, {
      threadId: "codex-thread-human",
      turnId: "turn-human",
      itemId: "command-human",
      startedAtMs: 1,
      command: "git status",
      cwd: "/workspace",
      reason: "Sandbox requires approval",
    }),
  ).resolves.toEqual({ decision: "decline" });

  expect(events[0]).toMatchObject({
    type: "bash_approval.requested",
    bashApproval: {
      reason: "Sandbox requires approval",
      description: "Sandbox requires approval",
      reviewRationale: "No tool action details provided; cannot assess risk or authorization.",
    },
  });
});

test("Codex manual command rejection injects feedback before returning decline", async () => {
  const feedback: Array<{
    ecoThreadId: string;
    codexThreadId: string;
    turnId: string;
    toolUseId: string;
    text: string;
  }> = [];
  const deps: CodexApprovalBridgeDeps = {
    resolveEcoThreadId: () => "thread-feedback",
    getThread: () => ({ prompt: "运行命令", workspacePath: "/workspace" }),
    getWorktreePath: () => "/workspace",
    getPlannerAgentId: () => "planner-feedback",
    getRoutesJson: () => "[]",
    savePendingPlan: () => undefined,
    emitThreadLive: (event) => {
      if (event.type === "bash_approval.requested") {
        queueMicrotask(() => {
          resolvePendingCodexBashApproval("command-feedback", {
            decision: "denied",
            feedback: "改用只读命令，不要修改文件",
          });
        });
      }
    },
    updateThreadStatus: () => undefined,
    injectCodexApprovalFeedback: async (input) => {
      feedback.push(input);
    },
  };

  await expect(
    handleCodexServerRequest(deps, CODEX_COMMAND_EXECUTION_REQUEST_APPROVAL, {
      threadId: "codex-thread-feedback",
      turnId: "turn-feedback",
      itemId: "command-feedback",
      startedAtMs: 1,
      command: "rm -rf build",
      cwd: "/workspace",
      reason: "需要确认危险命令",
    }),
  ).resolves.toEqual({ decision: "decline" });

  expect(feedback).toHaveLength(1);
  expect(feedback[0]).toMatchObject({
    ecoThreadId: "thread-feedback",
    codexThreadId: "codex-thread-feedback",
    turnId: "turn-feedback",
    toolUseId: "command-feedback",
  });
  expect(feedback[0]?.text).toContain("改用只读命令，不要修改文件");
  expect(feedback[0]?.text).toContain("Do not retry the rejected request");
});

test("Codex file-change rejection injects feedback before returning decline", async () => {
  const feedback: string[] = [];
  const deps: CodexApprovalBridgeDeps = {
    resolveEcoThreadId: () => "thread-file-feedback",
    getThread: () => ({ prompt: "修改文件", workspacePath: "/workspace" }),
    getWorktreePath: () => "/workspace",
    getPlannerAgentId: () => "planner-file-feedback",
    getRoutesJson: () => "[]",
    savePendingPlan: () => undefined,
    emitThreadLive: (event) => {
      if (event.type === "bash_approval.requested") {
        queueMicrotask(() => {
          resolvePendingCodexBashApproval("file-feedback", {
            decision: "denied",
            feedback: "先展示 diff，不要直接写入",
          });
        });
      }
    },
    updateThreadStatus: () => undefined,
    injectCodexApprovalFeedback: async ({ text }) => {
      feedback.push(text);
    },
  };

  await expect(
    handleCodexServerRequest(deps, CODEX_FILE_CHANGE_REQUEST_APPROVAL, {
      threadId: "codex-thread-file-feedback",
      turnId: "turn-file-feedback",
      itemId: "file-feedback",
      startedAtMs: 1,
      reason: "需要确认文件变更",
      grantRoot: "/workspace",
    }),
  ).resolves.toEqual({ decision: "decline" });

  expect(feedback).toHaveLength(1);
  expect(feedback[0]).toContain("先展示 diff，不要直接写入");
  expect(feedback[0]).toContain("FileChange");
});

test("image generation MCP approval accepts only a one-time approval", async () => {
  const feedback: string[] = [];
  const claims: Array<{ threadId: string; toolName: string; toolUseId?: string }> = [];

  async function request(decision: BashApprovalDecision, userFeedback?: string) {
    const events: ThreadLiveEvent[] = [];
    const deps: CodexApprovalBridgeDeps = {
      resolveEcoThreadId: () => "thread-image",
      getThread: () => ({ prompt: "create image", workspacePath: "/workspace" }),
      getWorktreePath: () => "/workspace/worktree",
      getPlannerAgentId: () => "planner-image",
      getRoutesJson: () => "[]",
      savePendingPlan: () => undefined,
      emitThreadLive: (event) => {
        events.push(event);
        if (event.type === "bash_approval.requested" && event.bashApproval) {
          const toolUseId = event.bashApproval.toolUseId;
          queueMicrotask(() => {
            resolvePendingCodexBashApproval(toolUseId, {
              decision,
              ...(userFeedback ? { feedback: userFeedback } : {}),
            });
          });
        }
      },
      updateThreadStatus: () => undefined,
      getApprovalMode: () => "always",
      noteUpcomingImageGenerationTool: (threadId, toolName, toolUseId) => {
        claims.push({ threadId, toolName, ...(toolUseId ? { toolUseId } : {}) });
      },
      injectCodexApprovalFeedback: async ({ text }) => {
        feedback.push(text);
      },
    };
    const result = await handleCodexServerRequest(deps, CODEX_MCP_SERVER_ELICITATION_REQUEST, {
      threadId: "codex-thread-image",
      turnId: "turn-image",
      serverName: "eco_image_generation",
      mode: "form",
      message: 'Allow the MCP server to run tool "create_image"',
      requestedSchema: {},
    });
    expect(events[0]?.bashApproval).toMatchObject({
      kind: "image_generation",
      cwd: "/workspace/worktree",
    });
    return result;
  }

  await expect(request("approved")).resolves.toEqual({ action: "accept", content: {} });
  expect(claims).toEqual([expect.objectContaining({ threadId: "thread-image", toolName: "create_image" })]);
  await expect(request("approved_for_session")).resolves.toEqual({ action: "decline" });
  await expect(request("approved_remember_prefix")).resolves.toEqual({ action: "decline" });
  await expect(request("denied", "不要创建图片，先说明成本")).resolves.toEqual({ action: "decline" });
  expect(claims).toHaveLength(1);
  expect(feedback).toHaveLength(1);
  expect(feedback[0]).toContain("不要创建图片，先说明成本");
  expect(feedback[0]).toContain("image generation");
});

test("auto-accepts eco_image_view view_image elicitation without a bash card", async () => {
  const events: Array<{ type: string }> = [];
  const deps: CodexApprovalBridgeDeps = {
    resolveEcoThreadId: () => "codex-thread-view",
    getThread: () => ({ prompt: "看这张截图", workspacePath: "/workspace" }),
    getWorktreePath: () => "/workspace",
    getPlannerAgentId: () => "planner-view",
    getRoutesJson: () => "[]",
    savePendingPlan: () => undefined,
    emitThreadLive: (event) => events.push(event),
    updateThreadStatus: () => undefined,
    getApprovalMode: () => "always",
  };
  const result = await handleCodexServerRequest(deps, CODEX_MCP_SERVER_ELICITATION_REQUEST, {
    threadId: "codex-thread-view",
    turnId: "turn-view",
    serverName: "eco_image_view",
    mode: "form",
    message: 'Allow the MCP server to run tool "view_image"',
    requestedSchema: {},
  });
  expect(result).toEqual({ action: "accept", content: {} });
  expect(events.some((event) => event.type === "bash_approval.requested")).toBe(false);
  // Untested: item/permissions/requestApproval and item/tool/requestUserInput are not
  // Codex MCP tool-run gates (filesystem/network and clarification). MCP tool confirmations
  // go through mcpServer/elicitation/request, which this test covers.
});

test("Codex allow_all host-auto-allows command approval without parking", async () => {
  const events: ThreadLiveEvent[] = [];
  let reviewed = false;
  const deps: CodexApprovalBridgeDeps = {
    resolveEcoThreadId: () => "thread-allow-all",
    getThread: () => ({ prompt: "跑命令", workspacePath: "/workspace" }),
    getWorktreePath: () => "/workspace",
    getPlannerAgentId: () => "planner-allow-all",
    getRoutesJson: () => "[]",
    savePendingPlan: () => undefined,
    emitThreadLive: (event) => events.push(event),
    updateThreadStatus: () => undefined,
    getApprovalMode: () => "allow_all",
    reviewApproval: async () => {
      reviewed = true;
      return { action: "human_required", rationale: "should not run" };
    },
  };

  await expect(
    handleCodexServerRequest(deps, CODEX_COMMAND_EXECUTION_REQUEST_APPROVAL, {
      threadId: "codex-thread-allow-all",
      turnId: "turn-allow-all",
      itemId: "command-allow-all",
      startedAtMs: 1,
      command: "rm -rf /",
      cwd: "/workspace",
      reason: "Sandbox requires approval",
    }),
  ).resolves.toEqual({ decision: "accept" });

  expect(reviewed).toBe(false);
  expect(events).toEqual([]);
});

test("Codex allow_all host-auto-allows file-change approval without parking", async () => {
  const events: ThreadLiveEvent[] = [];
  const deps: CodexApprovalBridgeDeps = {
    resolveEcoThreadId: () => "thread-allow-all-file",
    getThread: () => ({ prompt: "改文件", workspacePath: "/workspace" }),
    getWorktreePath: () => "/workspace",
    getPlannerAgentId: () => "planner-allow-all-file",
    getRoutesJson: () => "[]",
    savePendingPlan: () => undefined,
    emitThreadLive: (event) => events.push(event),
    updateThreadStatus: () => undefined,
    getApprovalMode: () => "allow_all",
  };

  await expect(
    handleCodexServerRequest(deps, CODEX_FILE_CHANGE_REQUEST_APPROVAL, {
      threadId: "codex-thread-allow-all-file",
      turnId: "turn-allow-all-file",
      itemId: "file-allow-all",
      startedAtMs: 1,
      reason: "需要确认文件变更",
      grantRoot: "/workspace",
    }),
  ).resolves.toEqual({ decision: "accept" });

  expect(events).toEqual([]);
});

test("Codex allow_all host-auto-allows generic MCP tool approval without parking", async () => {
  const events: ThreadLiveEvent[] = [];
  let reviewed = false;
  const deps: CodexApprovalBridgeDeps = {
    resolveEcoThreadId: () => "thread-allow-all-mcp",
    getThread: () => ({ prompt: "调用 MCP", workspacePath: "/workspace" }),
    getWorktreePath: () => "/workspace",
    getPlannerAgentId: () => "planner-allow-all-mcp",
    getRoutesJson: () => "[]",
    savePendingPlan: () => undefined,
    emitThreadLive: (event) => events.push(event),
    updateThreadStatus: () => undefined,
    getApprovalMode: () => "allow_all",
    reviewApproval: async () => {
      reviewed = true;
      return { action: "human_required", rationale: "should not run" };
    },
  };

  await expect(
    handleCodexServerRequest(deps, CODEX_MCP_SERVER_ELICITATION_REQUEST, {
      threadId: "codex-thread-allow-all-mcp",
      turnId: "turn-allow-all-mcp",
      serverName: "github",
      mode: "form",
      message: 'Allow the github MCP server to run tool "create_issue"?',
      requestedSchema: { type: "object", properties: {} },
    }),
  ).resolves.toEqual({ action: "accept", content: {} });

  expect(reviewed).toBe(false);
  expect(events).toEqual([]);
});

test("Codex auto mode routes generic MCP tool approval through the reviewer", async () => {
  const events: ThreadLiveEvent[] = [];
  let reviewedTool: { toolName: string; toolInput: Record<string, unknown> } | undefined;
  const deps: CodexApprovalBridgeDeps = {
    resolveEcoThreadId: () => "thread-auto-mcp",
    getThread: () => ({ prompt: "调用 MCP", workspacePath: "/workspace" }),
    getWorktreePath: () => "/workspace",
    getPlannerAgentId: () => "planner-auto-mcp",
    getRoutesJson: () => "[]",
    savePendingPlan: () => undefined,
    emitThreadLive: (event) => events.push(event),
    updateThreadStatus: () => undefined,
    getApprovalMode: () => "auto",
    reviewApproval: async (_threadId, _request, tool) => {
      reviewedTool = tool;
      return { action: "allow", rationale: "MCP action is within the user request." };
    },
  };

  await expect(
    handleCodexServerRequest(deps, CODEX_MCP_SERVER_ELICITATION_REQUEST, {
      threadId: "codex-thread-auto-mcp",
      turnId: "turn-auto-mcp",
      serverName: "github",
      mode: "form",
      message: 'Allow the github MCP server to run tool "create_issue"?',
      requestedSchema: { type: "object", properties: {} },
    }),
  ).resolves.toEqual({ action: "accept", content: {} });

  expect(reviewedTool).toEqual({ toolName: "mcp__github__create_issue", toolInput: {} });
  expect(events[0]).toMatchObject({
    type: "bash_approval.approved",
    bashApproval: {
      kind: "mcp",
      filesystemTool: "MCP",
      filesystemPath: "github/mcp__github__create_issue",
      reviewRationale: "MCP action is within the user request.",
    },
  });
});
