import { expect, test } from "bun:test";
import { formatIpcInvokeError } from "../src/renderer/AppMessage";

import { resolveGitRemoteSyncAction } from "../src/renderer/WorkspaceGitSection";
import { getWorkspaceGitCommitEntryLabel } from "../src/renderer/workspace-git-action-store";
import { withTestLanguage } from "./support/test-language";

withTestLanguage("en-US");

test("remote sync fetches until the local branch is behind", () => {
  expect(resolveGitRemoteSyncAction(0)).toBe("fetch");
  expect(resolveGitRemoteSyncAction(-1)).toBe("fetch");
  expect(resolveGitRemoteSyncAction(1)).toBe("pull");
  expect(resolveGitRemoteSyncAction(3)).toBe("pull");
});

test("formatIpcInvokeError strips Electron invoke wrapper", () => {
  expect(
    formatIpcInvokeError(
      new Error("Error invoking remote method 'git:pull': Error: Updating c9acc8b5..d8a206d5"),
    ),
  ).toBe("Updating c9acc8b5..d8a206d5");
  expect(formatIpcInvokeError(new Error(""), "同步远程失败")).toBe("同步远程失败");
});

test("work panel commit entry labels stay project-progress oriented", () => {
  expect(getWorkspaceGitCommitEntryLabel(undefined)).toBe("Commit or push");
  expect(getWorkspaceGitCommitEntryLabel("generating")).toBe("Generating commit");
  expect(getWorkspaceGitCommitEntryLabel("committing")).toBe("Committing");
  expect(getWorkspaceGitCommitEntryLabel("pushing")).toBe("Pushing");
});

test("summary keeps formatted changes visible and moves secondary actions out of the default card", async () => {
  const { createElement } = await import("react");
  const { renderLocalized } = await import("./i18n-test");
  const { WorkspaceGitSection } = await import("../src/renderer/WorkspaceGitSection");
  const props = {
    workspacePath: "/repo",
    workspaceLabel: "eco-coding",
    gitStatus: {
      workspacePath: "/repo", isGitRepository: true, hasGitCommits: true,
      branch: "review-branch", branches: ["review-branch", "main"], dirtyFileCount: 2,
      insertions: 34911, deletions: 13797, canCommit: true,
      aheadCount: 0, behindCount: 0, hasUpstream: true,
      gh: { available: false, authenticated: false },
    },
    onOpenScriptsDialog: () => undefined,
  };
  const summary = renderLocalized(createElement(WorkspaceGitSection, { ...props, summary: true }), "en-US");
  expect(summary).toContain("+34,911");
  expect(summary).toContain("-13,797");
  expect(summary).not.toContain("review-branch");
  expect(summary).not.toContain(">Fetch</span>");
  const full = renderLocalized(createElement(WorkspaceGitSection, props), "en-US");
  expect(full).toContain("review-branch");
  expect(full).toContain(">Fetch</span>");
});
