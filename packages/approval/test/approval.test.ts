import { expect, test } from "bun:test";
import type { ApprovalRequest } from "../../shared/src";
import { ApprovalService } from "../src";

test("creates pending approvals for dangerous commands", async () => {
  const saved: ApprovalRequest[] = [];
  const service = new ApprovalService({
    store: {
      async saveApproval(request) {
        saved.push(request);
      },
    },
    idFactory: () => "approval_1",
    clock: () => "2026-01-01T00:00:00.000Z",
  });

  const approval = await service.requestForCommand(
    { threadId: "thr_1", agentId: "coder" },
    { command: ["git", "reset", "--hard"], cwd: "/repo", workspacePath: "/repo" },
  );

  expect(approval).toMatchObject({
    id: "approval_1",
    decision: "pending",
    riskLevel: "high",
  });
  expect(saved).toHaveLength(1);
});

test("returns no approval for allowed commands", async () => {
  const service = new ApprovalService({
    store: { async saveApproval() {} },
  });

  const approval = await service.requestForCommand(
    { threadId: "thr_1", agentId: "tester" },
    { command: ["bun", "test"], cwd: "/repo", workspacePath: "/repo" },
  );

  expect(approval).toBeUndefined();
});

test("creates approvals for risky shell command strings", async () => {
  const service = new ApprovalService({
    store: { async saveApproval() {} },
    idFactory: () => "approval_1",
  });

  const approval = await service.requestForShellCommand(
    { threadId: "thr_1", agentId: "coder" },
    { command: "echo ok && rm -rf src", cwd: "/repo", workspacePath: "/repo" },
  );

  expect(approval).toMatchObject({
    decision: "pending",
    command: ["sh", "-lc", "echo ok && rm -rf src"],
    riskLevel: "high",
  });
});

test("allows safe shell command strings without approval", async () => {
  const service = new ApprovalService({
    store: { async saveApproval() {} },
  });

  const approval = await service.requestForShellCommand(
    { threadId: "thr_1", agentId: "tester" },
    { command: "NODE_ENV=test bun test", cwd: "/repo", workspacePath: "/repo" },
  );

  expect(approval).toBeUndefined();
});

test("resolves pending approvals", async () => {
  const saved: ApprovalRequest[] = [];
  const service = new ApprovalService({
    store: {
      async saveApproval(request) {
        saved.push(request);
      },
    },
    idFactory: () => "approval_1",
    clock: () => (saved.length === 0 ? "2026-01-01T00:00:00.000Z" : "2026-01-01T00:01:00.000Z"),
  });

  await service.requestForFileWrite(
    { threadId: "thr_1", agentId: "coder" },
    { filePath: "/etc/passwd", workspacePath: "/repo" },
  );
  const resolved = await service.resolve("approval_1", "denied");

  expect(resolved).toMatchObject({
    decision: "denied",
    resolvedAt: "2026-01-01T00:01:00.000Z",
  });
});
