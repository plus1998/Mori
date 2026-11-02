import { expect, test } from "bun:test";
import os from "node:os";
import {
  expandHomeInPolicyPath,
  filesystemReadScopeAskReason,
  isPathInsidePolicyScope,
  isSystemTemporaryPolicyPath,
  readFilesystemPath,
  resolveFilesystemScopeRoot,
  resolvePolicyPath,
  resolvePolicySearchBase,
} from "../src/filesystem-scope-policy.js";
import { evaluateFilesystemWriteConfirmation } from "../src/tool-confirmation.js";

test("expandHomeInPolicyPath expands tilde and $HOME prefixes", () => {
  const homedir = os.homedir().replace(/\\/g, "/");
  expect(expandHomeInPolicyPath("~/.claude/skills/foo")).toBe(`${homedir}/.claude/skills/foo`);
  expect(expandHomeInPolicyPath("$HOME/.agents/skills/bar")).toBe(`${homedir}/.agents/skills/bar`);
});

test("resolvePolicyPath expands tilde before resolving against cwd", () => {
  const homedir = os.homedir().replace(/\\/g, "/");
  expect(resolvePolicyPath("~/.claude/skills/foo/SKILL.md", "/repo")).toBe(
    `${homedir}/.claude/skills/foo/SKILL.md`,
  );
});

test("readFilesystemPath treats Glob pattern as a filesystem path", () => {
  expect(readFilesystemPath({ pattern: "/tmp/**/*.ts" }, "Glob")).toBe("/tmp/**/*.ts");
  expect(readFilesystemPath({ pattern: "secret", path: "/repo/src" }, "Grep")).toBe("/repo/src");
});

test("resolvePolicySearchBase strips glob meta to static search root", () => {
  expect(resolvePolicySearchBase("/tmp/**/*.ts", "/repo")).toBe("/tmp");
  expect(resolvePolicySearchBase("../**/*.ts", "/repo/app")).toBe("/repo");
  expect(resolvePolicySearchBase("src/**/*.ts", "/repo/app")).toBe("/repo/app/src");
  expect(resolvePolicySearchBase("**/*.ts", "/repo/app")).toBe("/repo/app");
});

test("resolveFilesystemScopeRoot expands to parent cwd for subdirectory workspaces", () => {
  expect(resolveFilesystemScopeRoot("/repo/apps/desktop", "/repo")).toBe("/repo");
});

test("selected sibling worktree is the filesystem permission scope", () => {
  const worktree = "/tmp/.mori-worktrees/repo/123";
  const decision = evaluateFilesystemWriteConfirmation({
    toolName: "Write",
    toolInput: { file_path: `${worktree}/src/index.ts` },
    cwd: worktree,
    workspacePath: worktree,
    confirmationMode: "always",
  });
  expect(decision?.action).toBe("allow");
});

test("filesystemReadScopeAskReason describes approval intent", () => {
  expect(filesystemReadScopeAskReason("Glob", "/repo", "/repo/apps/desktop")).toContain("Approve");
});

test("isPathInsidePolicyScope treats workspace descendants as inside", () => {
  expect(isPathInsidePolicyScope("/repo/apps/desktop/src", "/repo/apps/desktop")).toBe(true);
  expect(isPathInsidePolicyScope("/repo/other", "/repo/apps/desktop")).toBe(false);
});

test("isSystemTemporaryPolicyPath allows system temp descendants without path escapes", () => {
  expect(
    isSystemTemporaryPolicyPath(
      resolvePolicyPath(`${os.tmpdir()}/claude-501/tasks/result.output`, "/repo"),
    ),
  ).toBe(true);
  expect(isSystemTemporaryPolicyPath(resolvePolicyPath(`${os.tmpdir()}/eco/result.json`, "/repo"))).toBe(
    true,
  );
  expect(isSystemTemporaryPolicyPath(resolvePolicyPath(`${os.tmpdir()}/../etc/hosts`, "/repo"))).toBe(
    false,
  );
  if (process.platform === "darwin") {
    expect(isSystemTemporaryPolicyPath("/private/tmp/claude-501/tasks/result.output")).toBe(true);
  }
});
