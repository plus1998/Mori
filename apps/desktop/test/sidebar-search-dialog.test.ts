import { expect, test } from "bun:test";
import { buildSidebarSearchResults, type SidebarSearchProject } from "../src/renderer/SidebarSearchDialog";
import { buildProjectSearchTerms } from "../src/shared/project-pinyin";
import type { ThreadSummary } from "../src/shared/ipc";
import type { ScheduleDefinition } from "../src/shared/scheduling";
import type { ProjectTodo } from "../src/shared/project-todos";
import type { SshBookmarkView } from "../src/shared/ssh-bookmarks";
import type { WebChatItem } from "../src/shared/web-chat-list";

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

test("sidebar search finds a Chinese project name through its stored pinyin", () => {
  const pinyinProjects: SidebarSearchProject[] = [
    { path: "/workspace/chat", name: "会话存档", searchTerms: buildProjectSearchTerms("会话存档") },
    { path: "/workspace/eco-coding", name: "eco-coding" },
  ];
  for (const query of ["huihua", "huihuacundang", "cundang", "hhcd", "会话"]) {
    expect(buildSidebarSearchResults(threads, pinyinProjects, query).map((result) => result.key)).toEqual([
      "project:/workspace/chat",
    ]);
  }
  expect(buildSidebarSearchResults(threads, pinyinProjects, "huihuacundangg").length).toBe(0);
});

test("empty sidebar search lists recent threads before projects", () => {
  expect(buildSidebarSearchResults(threads, projects, "").map((result) => result.key)).toEqual([
    "thread:newer",
    "thread:older",
    "project:/workspace/eco-coding",
    "project:/workspace/notes",
  ]);
});

test("sidebar search derives Windows project names for threads outside the project list", () => {
  const workspacePath = "C:\\work\\项目\\";
  const results = buildSidebarSearchResults(
    [thread("windows", "检查", workspacePath, "2026-01-02T00:00:00.000Z")],
    [],
    "",
  );
  expect(results[0]).toMatchObject({ kind: "thread", projectName: "项目" });
  expect(
    buildSidebarSearchResults(
      [thread("windows", "检查", workspacePath, "2026-01-02T00:00:00.000Z")],
      [{ path: workspacePath, name: "重命名项目" }],
      "",
    )[0],
  ).toMatchObject({
    kind: "thread",
    projectName: "重命名项目",
  });
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

function scheduledMessage(
  id: string,
  threadId: string,
  name: string,
  prompt: string,
  at: string,
): ScheduleDefinition {
  return {
    id,
    threadId,
    name,
    prompt,
    kind: "session_message",
    trigger: { type: "at", at },
    nextRunAt: at,
    enabled: true,
    source: "user",
    revision: 1,
    maxLatenessSeconds: 86400,
    createdAt: at,
    updatedAt: at,
  };
}

test("scheduled messages are searchable by name, body, and target conversation", () => {
  const messages = [scheduledMessage("check", "older", "稍后检查", "检查构建进度", "2026-10-08T09:00:00Z")];
  for (const query of ["稍后", "构建", "回退"]) {
    const results = buildSidebarSearchResults(threads, projects, query, messages);
    const result = results.find((item) => item.kind === "scheduled_message");
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
  expect(
    buildSidebarSearchResults([...threads, running], projects, "", messages).map((item) => item.key),
  ).toEqual([
    "thread:active",
    "scheduled_message:first",
    "scheduled_message:later",
    "thread:newer",
    "thread:older",
    "project:/workspace/eco-coding",
    "project:/workspace/notes",
  ]);
});

test("sidebar search includes todos, custom websites, SSH bookmarks, and browser pages", () => {
  const todos: ProjectTodo[] = [
    {
      id: "todo-1",
      revision: 1,
      projectPath: "/workspace/eco-coding",
      text: "整理搜索分类",
      images: [],
      completed: false,
      status: "pending",
      createdAt: "2026-01-03T00:00:00Z",
      updatedAt: "2026-01-03T00:00:00Z",
    },
  ];
  const websites: WebChatItem[] = [
    { id: "site-1", title: "内部站点", url: "https://internal.example", builtin: false, order: 0 },
  ];
  const sshBookmarks: SshBookmarkView[] = [
    {
      id: "ssh-1",
      name: "开发机",
      host: "dev.example",
      port: 22,
      username: "root",
      authType: "key",
      order: 0,
      hasPassword: false,
      hasStoredKey: false,
    },
  ];
  const results = buildSidebarSearchResults(threads, projects, "", [], {
    todos,
    websites,
    sshBookmarks,
    browserPages: [{ id: "page-1", title: "项目文档", url: "https://docs.example" }],
  });
  expect(results.map((result) => result.key)).toEqual(
    expect.arrayContaining(["todo:todo-1", "web_chat:site-1", "ssh_bookmark:ssh-1", "browser_page:page-1"]),
  );
  expect(
    buildSidebarSearchResults(threads, projects, "dev.example", [], { sshBookmarks }).map(
      (result) => result.key,
    ),
  ).toEqual(["ssh_bookmark:ssh-1"]);
});
