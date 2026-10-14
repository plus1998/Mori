import { expect, test } from "bun:test";
import { buildSidebarSearchResults, type SidebarSearchProject } from "../src/renderer/SidebarSearchDialog";
import type { ThreadSummary } from "../src/shared/ipc";
import type { ScheduleDefinition } from "../src/shared/scheduling";

const projects: SidebarSearchProject[] = [
  { path: "/workspace/eco-coding", name: "eco-coding" },
  { path: "/workspace/notes", name: "Notes" },
];

function thread(
  id: string,
  title: string,
  workspacePath: string,
  updatedAt: string,
  status: ThreadSummary["status"] = "completed",
): ThreadSummary {
  return {
    id,
    title,
    prompt: title,
    workspacePath,
    status,
    createdAt: updatedAt,
    updatedAt,
    message: "",
  };
}

const threads = [
  thread("older", "修复回退重聊裁剪逻辑", "/workspace/eco-coding", "2026-01-01T00:00:00.000Z"),
  thread("newer", "排查接口报错差异", "/workspace/notes", "2026-01-02T00:00:00.000Z"),
];

test("sidebar search matches thread titles and project names separately", () => {
  expect(buildSidebarSearchResults(threads, projects, "接口").map((result) => result.key)).toEqual([
    "thread:newer",
  ]);
  expect(buildSidebarSearchResults(threads, projects, "eco-coding").map((result) => result.key)).toEqual([
    "project:/workspace/eco-coding",
  ]);
});

test("empty sidebar search lists recent threads before projects", () => {
  expect(buildSidebarSearchResults(threads, projects, "").map((result) => result.key)).toEqual([
    "thread:newer",
    "thread:older",
    "project:/workspace/eco-coding",
    "project:/workspace/notes",
  ]);
});

test("sidebar search puts running threads first", () => {
  const activeThreads = [
    ...threads,
    thread("running", "实现搜索分组", "/workspace/eco-coding", "2026-01-01T12:00:00.000Z", "running"),
    thread("queued", "等待执行", "/workspace/notes", "2025-12-31T12:00:00.000Z", "queued"),
  ];

  expect(buildSidebarSearchResults(activeThreads, projects, "").map((result) => result.key)).toEqual([
    "thread:running",
    "thread:newer",
    "thread:older",
    "thread:queued",
    "project:/workspace/eco-coding",
    "project:/workspace/notes",
  ]);
});

function scheduledMessage(id: string, threadId: string, name: string, prompt: string, at: string): ScheduleDefinition {
  return { id, threadId, name, prompt, kind: "session_message", trigger: { type: "at", at }, nextRunAt: at,
    enabled: true, source: "user", revision: 1, maxLatenessSeconds: 86400, createdAt: at, updatedAt: at };
}

test("scheduled messages are searchable by name, body, and target conversation", () => {
  const messages = [scheduledMessage("check", "older", "稍后检查", "检查构建进度", "2026-10-08T09:00:00Z")];
  for (const query of ["稍后", "构建", "回退"]) {
    const results = buildSidebarSearchResults(threads, projects, query, messages);
    const result = results.find(item => item.kind === "scheduled_message");
    expect(result?.key).toBe("scheduled_message:check");
    if (result?.kind === "scheduled_message") expect(result.thread.id).toBe("older");
  }
});

test("scheduled messages appear between running and recent conversations, with earliest first and no orphan targets", () => {
  const running = thread("active", "进行中", "/workspace/eco-coding", "2026-01-03T00:00:00Z", "running");
  const messages = [
    scheduledMessage("later", "older", "稍后", "稍后检查", "2026-10-08T10:00:00Z"),
    scheduledMessage("first", "newer", "最早", "先检查", "2026-10-08T09:00:00Z"),
    scheduledMessage("missing", "deleted", "删除会话", "无目标", "2026-10-08T08:00:00Z"),
  ];
  expect(buildSidebarSearchResults([...threads, running], projects, "", messages).map(item => item.key)).toEqual([
    "thread:active", "scheduled_message:first", "scheduled_message:later", "thread:newer", "thread:older",
    "project:/workspace/eco-coding", "project:/workspace/notes",
  ]);
});
