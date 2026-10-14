import { expect, test } from "bun:test";
import { buildSidebarAttentionItems } from "../src/renderer/sidebar-attention-items";
import type {
  BashApprovalRequest,
  ClarificationRequest,
  ThreadPendingPlan,
  ThreadSummary,
} from "../src/shared/ipc";

function thread(partial: Partial<ThreadSummary> & Pick<ThreadSummary, "id" | "title">): ThreadSummary {
  return {
    prompt: "",
    workspacePath: "/repo",
    status: "idle",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    message: "",
    ...partial,
  };
}

function plan(partial: Partial<ThreadPendingPlan> & Pick<ThreadPendingPlan, "threadId">): ThreadPendingPlan {
  return {
    userPrompt: "做计划",
    analysis: "分析",
    plan: "1. 改代码",
    workspacePath: "/repo",
    worktreePath: "",
    ...partial,
  };
}

function bash(
  partial: Partial<BashApprovalRequest> & Pick<BashApprovalRequest, "threadId" | "toolUseId">,
): BashApprovalRequest {
  return {
    command: "rm -rf /tmp/x",
    cwd: "/repo",
    reason: "cleanup",
    riskScore: 1,
    riskLevel: "medium",
    agentId: "main",
    ...partial,
  };
}

test("aggregates plan, bash, awaiting_plan fallback, and unread completed", () => {
  const items = buildSidebarAttentionItems({
    threads: [
      thread({
        id: "t-plan",
        title: "计划会话",
        status: "awaiting_plan",
        updatedAt: "2026-01-03T00:00:00.000Z",
      }),
      thread({
        id: "t-await",
        title: "仅状态等待",
        status: "awaiting_plan",
        updatedAt: "2026-01-04T00:00:00.000Z",
      }),
      thread({
        id: "t-bash",
        title: "命令会话",
        status: "running",
        updatedAt: "2026-01-02T00:00:00.000Z",
      }),
      thread({
        id: "t-done",
        title: "已完成会话",
        status: "completed",
        message: "做完了",
        updatedAt: "2026-01-01T12:00:00.000Z",
      }),
    ],
    unreadThreadIds: new Set(["t-done"]),
    pendingClarificationsByThread: {},
    pendingPlansByThread: {
      "t-plan": plan({ threadId: "t-plan" }),
    },
    pendingBashApprovalsByThread: {
      "t-bash": bash({ threadId: "t-bash", toolUseId: "tool-1" }),
    },
  });

  expect(items.map((item) => item.id)).toEqual([
    "plan:t-await",
    "plan:t-plan",
    "bash:t-bash:tool-1",
    "completed:t-done",
  ]);
  expect(items[0]?.kind).toBe("plan");
  expect(items[2]?.detail).toBe("rm -rf /tmp/x");
  expect(items[3]?.detail).toBe("做完了");
});

test("keeps plan and completed items for the same thread", () => {
  const items = buildSidebarAttentionItems({
    threads: [
      thread({
        id: "t-1",
        title: "混合",
        status: "awaiting_plan",
        updatedAt: "2026-01-05T00:00:00.000Z",
      }),
    ],
    unreadThreadIds: new Set(["t-1"]),
    pendingClarificationsByThread: {},
    pendingPlansByThread: {
      "t-1": plan({ threadId: "t-1", plan: "审批计划" }),
    },
    pendingBashApprovalsByThread: {},
  });

  expect(items.map((item) => item.kind)).toEqual(["plan", "completed"]);
  expect(items[0]?.detail).toBe("审批计划");
});

test("skips items without a resolvable title", () => {
  const items = buildSidebarAttentionItems({
    threads: [thread({ id: "blank", title: " ", status: "completed" })],
    unreadThreadIds: new Set(["blank", "missing"]),
    pendingClarificationsByThread: {},
    pendingPlansByThread: {
      ghost: plan({ threadId: "ghost", userPrompt: " ", analysis: " ", plan: " " }),
    },
    pendingBashApprovalsByThread: {
      ghost: bash({ threadId: "ghost", toolUseId: "x", command: "ls" }),
    },
  });

  expect(items).toEqual([]);
});

test("sorts by kind priority then updatedAt descending", () => {
  const items = buildSidebarAttentionItems({
    threads: [
      thread({
        id: "p-old",
        title: "旧计划",
        status: "awaiting_plan",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
      thread({
        id: "p-new",
        title: "新计划",
        status: "awaiting_plan",
        updatedAt: "2026-01-03T00:00:00.000Z",
      }),
      thread({ id: "b-1", title: "命令", status: "running", updatedAt: "2026-01-04T00:00:00.000Z" }),
      thread({ id: "c-1", title: "完成", status: "completed", updatedAt: "2026-01-05T00:00:00.000Z" }),
    ],
    unreadThreadIds: new Set(["c-1"]),
    pendingClarificationsByThread: {},
    pendingPlansByThread: {
      "p-old": plan({ threadId: "p-old" }),
      "p-new": plan({ threadId: "p-new" }),
    },
    pendingBashApprovalsByThread: {
      "b-1": bash({ threadId: "b-1", toolUseId: "t" }),
    },
  });

  expect(items.map((item) => item.threadId)).toEqual(["p-new", "p-old", "b-1", "c-1"]);
});

test("pending questions remain in attention until answered, including async questions on completed threads", () => {
  const pendingClarificationsByThread: Record<string, ClarificationRequest> = {
    "q-1": {
      threadId: "q-1",
      toolUseId: "question-1",
      questions: [{ question: "选哪个数据库？", options: [] }],
    },
    "q-2": {
      threadId: "q-2",
      toolUseId: "question-2",
      delivery: "async",
      questions: [{ question: "颜色呢？", options: [] }],
    },
  };
  const input = {
    threads: [
      thread({ id: "q-1", title: "数据库", status: "running" }),
      thread({ id: "q-2", title: "界面", status: "completed" }),
      thread({ id: "p-1", title: "计划", status: "awaiting_plan" }),
    ],
    unreadThreadIds: new Set(["q-2"]),
    pendingPlansByThread: {},
    pendingBashApprovalsByThread: {},
    pendingClarificationsByThread,
  };
  const questions = buildSidebarAttentionItems(input).filter((item) => item.kind === "question");
  expect(questions.map((item) => item.id)).toEqual(["question:q-1:question-1", "question:q-2:question-2"]);
  expect(questions.map((item) => item.detail)).toEqual(["选哪个数据库？", "颜色呢？"]);
  expect(buildSidebarAttentionItems(input).map((item) => item.kind)).toEqual([
    "question",
    "question",
    "plan",
    "completed",
  ]);
  // Reading a question does not answer it.
  expect(
    buildSidebarAttentionItems({ ...input, unreadThreadIds: new Set() }).filter(
      (item) => item.kind === "question",
    ),
  ).toHaveLength(2);
  expect(
    buildSidebarAttentionItems({ ...input, pendingClarificationsByThread: {} }).some(
      (item) => item.kind === "question",
    ),
  ).toBe(false);
});
