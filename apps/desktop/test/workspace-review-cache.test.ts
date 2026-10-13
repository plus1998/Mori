import { expect, test } from "bun:test";
import {
  cacheWorkspaceReviewSummary,
  invalidateWorkspaceReviewSummary,
  loadCachedWorkspaceFileDiff,
  readCachedWorkspaceFileDiff,
  readWorkspaceReviewSummary,
} from "../src/renderer/workspace-review-cache";
import type { WorkspaceDiffResult, WorkspaceFileDiffResult } from "../src/shared/ipc";

const file: WorkspaceFileDiffResult = {
  path: "file.ts",
  patch: "+new",
  patchTruncated: false,
  additions: 1,
  deletions: 0,
  status: "modified",
  binary: false,
};

test("review file cache survives panel remounts and shares in-flight requests", async () => {
  let reads = 0;
  const load = async () => {
    reads++;
    return file;
  };
  const [first, second] = await Promise.all([
    loadCachedWorkspaceFileDiff("shared:1", load),
    loadCachedWorkspaceFileDiff("shared:1", load),
  ]);
  expect(first).toBe(second);
  expect(reads).toBe(1);
  expect(readCachedWorkspaceFileDiff("shared:1")).toBe(file);
  await loadCachedWorkspaceFileDiff("shared:1", load);
  expect(reads).toBe(1);
});

test("a changed revision refetches while other file revisions remain reusable", async () => {
  let reads = 0;
  const load = async () => {
    reads++;
    return file;
  };
  await loadCachedWorkspaceFileDiff("changed:1", load);
  await loadCachedWorkspaceFileDiff("unaffected:1", load);
  await loadCachedWorkspaceFileDiff("changed:2", load);
  await loadCachedWorkspaceFileDiff("unaffected:1", load);
  expect(reads).toBe(3);
});

test("failed loads are retried instead of caching an empty successful result", async () => {
  await expect(
    loadCachedWorkspaceFileDiff("retry", async () => {
      throw new Error("file failed");
    }),
  ).rejects.toThrow("file failed");
  expect(readCachedWorkspaceFileDiff("retry")).toBeUndefined();
  expect(await loadCachedWorkspaceFileDiff("retry", async () => file)).toBe(file);
});

test("workspace invalidation drops only the affected cached summary", () => {
  const base: WorkspaceDiffResult = {
    workspacePath: "one",
    patch: "",
    patchTruncated: false,
    fileCount: 0,
    files: [],
    totalAdditions: 0,
    totalDeletions: 0,
  };
  cacheWorkspaceReviewSummary(base);
  cacheWorkspaceReviewSummary({ ...base, workspacePath: "two" });
  invalidateWorkspaceReviewSummary("one");
  expect(readWorkspaceReviewSummary("one")).toBeUndefined();
  expect(readWorkspaceReviewSummary("two")?.workspacePath).toBe("two");
});
