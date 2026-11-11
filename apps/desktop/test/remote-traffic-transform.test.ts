import { expect, test } from "bun:test";
import { transformRemoteInvokeResult } from "../src/main/event-center";
import type { WorkspaceDiffResult } from "../src/main/git-operations";
import {
  REMOTE_THREAD_LIST_MESSAGE_MAX_CHARS,
  REMOTE_THREAD_LIST_PROMPT_MAX_CHARS,
  summarizeThreadForRemoteList,
} from "../src/main/remote-thread-list";
import { IPC_CHANNELS, type ThreadSummary } from "../src/shared/ipc";

const thread: ThreadSummary = {
  id: "thr_1",
  title: "Title",
  prompt: "p".repeat(REMOTE_THREAD_LIST_PROMPT_MAX_CHARS + 40),
  workspacePath: "/tmp/ws",
  status: "idle",
  createdAt: "t0",
  updatedAt: "t1",
  message: "m".repeat(REMOTE_THREAD_LIST_MESSAGE_MAX_CHARS + 10),
  runtimeConfig: {
    sessionMode: "execution",
  } as ThreadSummary["runtimeConfig"],
  sdkSessionId: "sess",
  sdkCwd: "/tmp/ws",
  externalSessionId: "acp-sess",
};

test("summarizeThreadForRemoteList keeps live cancelling overlay", () => {
  const summarized = summarizeThreadForRemoteList({
    ...thread,
    status: "running",
    cancelling: true,
  });
  expect(summarized.cancelling).toBe(true);
  expect(summarizeThreadForRemoteList(thread).cancelling).toBeUndefined();
});

test("remote summaries retain per-conversation WeChat notifications", () => {
  expect(summarizeThreadForRemoteList({ ...thread, wechatFollowEnabled: true }).wechatFollowEnabled).toBe(true);
  expect(summarizeThreadForRemoteList(thread).wechatFollowEnabled).toBeUndefined();
});

test("summarizeThreadForRemoteList truncates prompt/message and drops heavy fields", () => {
  const summarized = summarizeThreadForRemoteList(thread);
  expect(summarized.prompt).toHaveLength(REMOTE_THREAD_LIST_PROMPT_MAX_CHARS);
  expect(summarized.message).toHaveLength(REMOTE_THREAD_LIST_MESSAGE_MAX_CHARS);
  expect(summarized.runtimeConfig).toBeUndefined();
  expect(summarized.sdkSessionId).toBeUndefined();
  expect(summarized.sdkCwd).toBeUndefined();
  expect(summarized.externalSessionId).toBeUndefined();
});

test("remote thread list keeps hostUiFeatures", () => {
  const summarized = summarizeThreadForRemoteList({
    ...thread,
    coreKind: "acp",
    acpAgentId: "cursor",
    hostUiFeatures: { contextUsage: "hide", billing: "hide" },
  });
  expect(summarized.hostUiFeatures).toEqual({ contextUsage: "hide", billing: "hide" });
  expect(summarized.runtimeConfig).toBeUndefined();
});

test("transformRemoteInvokeResult reshapes list/git payloads", () => {
  const listed = transformRemoteInvokeResult(IPC_CHANNELS.threadList, [
    {
      id: "thr_1",
      title: "T",
      prompt: "x".repeat(500),
      workspacePath: "/w",
      status: "idle",
      createdAt: "a",
      updatedAt: "b",
      message: "ok",
      sdkSessionId: "s",
      externalSessionId: "acp-s",
    },
  ]);
  expect(Array.isArray(listed)).toBe(true);
  expect((listed as ThreadSummary[])[0]?.prompt.length).toBe(REMOTE_THREAD_LIST_PROMPT_MAX_CHARS);
  expect((listed as ThreadSummary[])[0]?.sdkSessionId).toBeUndefined();
  expect((listed as ThreadSummary[])[0]?.externalSessionId).toBeUndefined();

  const diff: WorkspaceDiffResult = {
    workspacePath: "/w",
    patch: "huge patch body",
    patchTruncated: true,
    fileCount: 1,
    files: [
      {
        path: "a.ts",
        additions: 1,
        deletions: 0,
        status: "modified",
        originalContent: "old",
        currentContent: "new",
      },
    ],
    totalAdditions: 1,
    totalDeletions: 0,
  };
  const remoteDiff = transformRemoteInvokeResult(
    IPC_CHANNELS.gitGetWorkspaceDiff,
    diff,
  ) as WorkspaceDiffResult;
  expect(remoteDiff.patch).toBe("");
  expect(remoteDiff.files[0]?.originalContent).toBe("");
  expect(remoteDiff.files[0]?.currentContent).toBe("");
  expect(remoteDiff.files[0]?.path).toBe("a.ts");
});

test("transformRemoteInvokeResult reshapes paged thread list payloads", () => {
  const initial = transformRemoteInvokeResult(IPC_CHANNELS.threadListInitial, {
    threads: [
      {
        ...thread,
        prompt: "x".repeat(500),
        runtimeConfig: thread.runtimeConfig,
      },
    ],
    pages: {
      "/tmp/ws": {
        hasMore: true,
        totalCount: 6,
        nextCursor: { updatedAt: "t1", createdAt: "t0", id: "thr_1" },
      },
    },
  }) as { threads: ThreadSummary[]; pages: Record<string, unknown> };
  expect(initial.threads[0]?.prompt).toHaveLength(REMOTE_THREAD_LIST_PROMPT_MAX_CHARS);
  expect(initial.threads[0]?.runtimeConfig).toBeUndefined();
  expect(initial.pages["/tmp/ws"]).toEqual({
    hasMore: true,
    totalCount: 6,
    nextCursor: { updatedAt: "t1", createdAt: "t0", id: "thr_1" },
  });

  const more = transformRemoteInvokeResult(IPC_CHANNELS.threadListMore, {
    threads: [thread],
    hasMore: false,
    totalCount: 6,
  }) as { threads: ThreadSummary[]; hasMore: boolean };
  expect(more.threads[0]?.runtimeConfig).toBeUndefined();
  expect(more.hasMore).toBe(false);
});

test("transformRemoteInvokeResult keeps workspace file diff patch for lazy review", () => {
  const fileDiff = {
    path: "a.ts",
    patch: "diff --git a/a.ts b/a.ts\n+hello\n",
    patchTruncated: false,
    additions: 1,
    deletions: 0,
    status: "modified" as const,
  };
  const remote = transformRemoteInvokeResult(IPC_CHANNELS.gitGetWorkspaceFileDiff, fileDiff);
  expect(remote).toEqual(fileDiff);
});
