import { expect, test } from "bun:test";
import path from "node:path";
import { ApprovalService } from "../../approval/src";
import { type AgentRuntimeDriver, ThreadSupervisor } from "../../runtime/src";
import { type AgentRoleRoute, InMemoryEventStore, type ModelProfile } from "../../shared/src";
import { createApprovalBackedPermissionHandler, resolveRoutes, ThreadOrchestrator } from "../src";

/** 跨平台的工作区 fixture：POSIX 上是 `/repo`，Windows 上是 `<当前盘>:/repo`。 */
const REPO = path.resolve(path.parse(process.cwd()).root, "repo");

const profiles: ModelProfile[] = [
  {
    id: "sonnet",
    provider: "anthropic",
    displayName: "Sonnet",
    baseUrl: "https://gateway.test",
    modelId: "claude-sonnet",
    capabilities: ["messages_api", "streaming", "tool_use"],
    enabled: true,
  },
];

const roleRoutes: AgentRoleRoute[] = [
  {
    role: "main",
    primaryModelId: "sonnet",
    fallbackModelIds: [],
    requiredCapabilities: ["messages_api"],
  },
];

test("resolves requested role routes before starting workers", () => {
  const routes = resolveRoutes(["main"], roleRoutes, profiles);
  expect(routes[0]?.primary.modelId).toBe("claude-sonnet");
});

test("starts thread worker in workspace without isolated worktree", async () => {
  const driver: AgentRuntimeDriver = {
    async *run() {},
  };
  const supervisor = new ThreadSupervisor(new InMemoryEventStore(), driver);
  const orchestrator = new ThreadOrchestrator(supervisor);

  const result = await orchestrator.start({
    threadId: "thr_1",
    title: "Test",
    workspacePath: REPO,
    prompt: "do work",
    roles: ["main"],
    roleRoutes,
    modelProfiles: profiles,
  });

  await result.running.done;

  expect(result.worktree.worktreePath).toBe(REPO);
  expect(result.worktree.workspacePath).toBe(REPO);
});

test("turns risky SDK Bash tools into pending approvals", async () => {
  const approvalService = new ApprovalService({
    store: { async saveApproval() {} },
    idFactory: () => "approval_1",
  });
  const handler = createApprovalBackedPermissionHandler({
    approvalService,
    threadId: "thr_1",
    workspacePath: REPO,
    cwd: REPO,
  });

  const decision = await handler({
    toolName: "Bash",
    input: { command: "echo ok && rm -rf src" },
    toolUseId: "tool_1",
    agentId: "coder",
    signal: new AbortController().signal,
  });

  expect(decision).toEqual({
    behavior: "deny",
    message: "Approval required: File deletion requires approval",
    interrupt: true,
  });
});
