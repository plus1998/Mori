import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  isThreadWaitingForApproval,
  ProjectSidebarTree,
  sidebarThreadStatus,
} from "../src/renderer/ProjectSidebarTree";
import type { ThreadSummary } from "../src/shared/ipc";

test("renders stable reveal targets for projects and threads", () => {
  const thread = {
    id: "thread_1",
    title: "Locate sidebar item",
    prompt: "Find it",
    workspacePath: "/repo",
    status: "completed",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:01.000Z",
    message: "Done",
  } satisfies ThreadSummary;
  const markup = renderToStaticMarkup(
    createElement(ProjectSidebarTree, {
      projectTree: [
        {
          project: { path: "/repo", name: "repo" },
          projectThreads: [thread],
          collapsed: false,
          visibleThreads: [thread],
          hasMore: false,
        },
      ],
      currentProjectPath: "/repo",
      activeThreadId: thread.id,
      unreadThreadIds: new Set<string>(),
      pinnedThreadIds: new Set<string>(),
      onSwitchProject: () => undefined,
      onSelectThread: () => undefined,
      onToggleProjectCollapsed: () => undefined,
      onExpandProjectThreads: () => undefined,
      onReorderProjects: () => undefined,
      onOpenProjectPath: async () => undefined,
      onPinProject: () => undefined,
      onUnpinProject: () => undefined,
      onRemoveProject: () => undefined,
      onRenameProject: () => undefined,
      onResetProjectName: () => undefined,
      onPinThread: () => undefined,
      onUnpinThread: () => undefined,
      onDeleteThread: () => undefined,
    }),
  );

  expect(markup).toContain('data-project-path="/repo"');
  expect(markup).toContain('data-thread-id="thread_1"');
  expect(markup).not.toContain('class="chat-item-time"');
  expect(markup).not.toContain('role="tooltip"');
});

test("detects waiting threads from status and pending approvals, not slogans", () => {
  expect(
    isThreadWaitingForApproval({
      id: "thread_plan",
      title: "Plan billing",
      prompt: "Plan it",
      workspacePath: "/repo",
      status: "awaiting_plan",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:01.000Z",
      message: "",
    } satisfies ThreadSummary),
  ).toBe(true);

  expect(
    isThreadWaitingForApproval(
      {
        id: "thread_1",
        title: "Install dependencies",
        prompt: "Run install",
        workspacePath: "/repo",
        status: "running",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:01.000Z",
        message: "",
      } satisfies ThreadSummary,
      { hasPendingBashApproval: true },
    ),
  ).toBe(true);

  expect(
    isThreadWaitingForApproval({
      id: "thread_2",
      title: "Regular run",
      prompt: "Check status",
      workspacePath: "/repo",
      status: "running",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:01.000Z",
      message: "等待确认 Read：/etc/hosts",
    } satisfies ThreadSummary),
  ).toBe(false);
});

test("linked execution replaces plan approval presentation without changing source runtime status", () => {
  const source = { status: "awaiting_plan" } as const;
  for (const status of ["queued", "running", "completed", "failed", "cancelled", "interrupted"] as const) {
    expect(isThreadWaitingForApproval(source, { planExecutionStatus: status })).toBe(false);
    expect(
      isThreadWaitingForApproval(source, {
        planExecutionStatus: status,
        hasPendingBashApproval: true,
      }),
    ).toBe(true);
  }
  expect(sidebarThreadStatus(source, "running")).toBe("running");
  expect(sidebarThreadStatus(source, "queued")).toBe("queued");
  expect(sidebarThreadStatus(source, "completed")).toBe("completed");
  expect(sidebarThreadStatus(source, "failed")).toBe("failed");
  expect(sidebarThreadStatus(source, "interrupted")).toBe("blocked");
  expect(sidebarThreadStatus(source, "cancelled")).toBe("idle");
  expect(sidebarThreadStatus(source)).toBe("awaiting_plan");
  expect(sidebarThreadStatus({ status: "running" }, "completed")).toBe("running");
  expect(source.status).toBe("awaiting_plan");
});
