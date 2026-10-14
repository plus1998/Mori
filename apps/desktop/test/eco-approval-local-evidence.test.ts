import { afterAll, beforeAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  approvalHostEvidenceState,
  collectApprovalHostEvidence,
} from "../src/main/eco-approval-local-evidence";

let root: string, repo: string;
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
const evidence = (command: string, cwd = repo) =>
  collectApprovalHostEvidence({ toolName: "Bash", toolInput: { command }, cwd, workspacePath: repo });

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "eco-approval-evidence-"));
  repo = path.join(root, "repo");
  await mkdir(repo);
  git("init", "-q");
  await mkdir(path.join(repo, "src"));
  for (const name of ["clean.ts", "dirty.ts", "staged.ts", "assumed.ts", "skipped.ts"])
    await writeFile(path.join(repo, "src", name), "original\n");
  await writeFile(path.join(repo, ".gitignore"), "ignored.txt\n");
  git("add", ".");
  git("-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-qm", "fixture");
  await writeFile(path.join(repo, "src", "dirty.ts"), "user edits\n");
  await writeFile(path.join(repo, "src", "staged.ts"), "staged user edits\n");
  git("add", "src/staged.ts");
  git("update-index", "--assume-unchanged", "src/assumed.ts");
  git("update-index", "--skip-worktree", "src/skipped.ts");
  await writeFile(path.join(repo, "src/assumed.ts"), "hidden user changes\n");
  await writeFile(path.join(repo, "src/skipped.ts"), "hidden user changes\n");
  await writeFile(path.join(repo, "untracked.txt"), "untracked work\n");
  await writeFile(path.join(repo, "ignored.txt"), "important local data\n");
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

test("only the exact clean tracked target gets verified Git recovery", async () => {
  const result = await evidence("rm src/clean.ts");
  expect(result.paths[0]).toMatchObject({
    scope: "workspace",
    exists: true,
    kind: "file",
    git: { recovery: "clean_in_head", trackedFiles: 1, changedEntries: 0 },
  });
  expect(result.paths[0]?.git?.head).toMatch(/^[a-f0-9]{40,64}$/);
});

test.skipIf(process.platform === "win32")(
  "null-device revalidation ignores only timestamps, preserving identity and type",
  async () => {
    const before = await evidence("find . -print 2>/dev/null | head -50");
    expect(typeof before.paths[0]?.characterDeviceId).toBe("number");
    const after = structuredClone(before);
    const fact = after.paths[0];
    if (!fact?.identity) throw new Error("Missing null device identity");
    fact.identity.mtimeMs += 1_000;
    fact.identity.ctimeMs += 1_000;
    expect(approvalHostEvidenceState(after)).toBe(approvalHostEvidenceState(before));
    for (const change of [
      (value: typeof fact) => {
        if (value.identity) value.identity.inode += 1;
      },
      (value: typeof fact) => {
        if (value.identity) value.identity.mode += 1;
      },
      (value: typeof fact) => {
        value.characterDeviceId = (value.characterDeviceId ?? 0) + 1;
      },
      (value: typeof fact) => {
        value.canonicalPath = "/tmp/important.txt";
      },
      (value: typeof fact) => {
        value.kind = "file";
      },
      (value: typeof fact) => {
        value.kind = "symlink";
      },
      (value: typeof fact) => {
        delete value.characterDeviceId;
      },
    ]) {
      const changed = structuredClone(after);
      const target = changed.paths[0];
      if (!target) throw new Error("Missing target");
      change(target);
      expect(approvalHostEvidenceState(changed)).not.toBe(approvalHostEvidenceState(before));
    }
    const regular = await evidence("printf report > report.txt");
    const altered = structuredClone(regular);
    if (altered.paths[0]) altered.paths[0].exists = true;
    expect(approvalHostEvidenceState(altered)).not.toBe(approvalHostEvidenceState(regular));
  },
);

for (const target of ["src/assumed.ts", "src/skipped.ts"]) {
  test(`Git index flags cannot conceal missing recovery evidence: ${target}`, async () => {
    const result = await evidence(`rm ${target}`);
    expect(result.paths[0]?.git).toMatchObject({ recovery: "unknown", indexFlagsHideChanges: true });
  });
}

for (const target of ["src/dirty.ts", "src/staged.ts", "untracked.txt", "ignored.txt", "src"]) {
  test(`dirty, staged, untracked, ignored and mixed directories are not declared recoverable: ${target}`, async () => {
    expect((await evidence(`rm -rf ${target}`)).paths[0]?.git?.recovery).toBe("dirty_or_untracked");
  });
}

test("a repo path alias keeps Git evidence, while symlink escapes keep actual scope", async () => {
  const alias = path.join(root, "repo-alias");
  await symlink(repo, alias);
  expect((await evidence("rm src/clean.ts", alias)).paths[0]?.git?.recovery).toBe("clean_in_head");
  const outside = path.join(root, "outside");
  await mkdir(outside);
  await writeFile(path.join(outside, "data"), "outside data");
  await symlink(outside, path.join(repo, "escape"));
  const result = await evidence("rm escape/data");
  expect(result.paths[0]?.scope).toBe("temporary");
  expect(result.paths[0]?.git).toBeUndefined();
});

test("temporary cwd and exact temp targets are inspectable, temp root is protected", async () => {
  const directory = path.join(root, "scratch");
  await mkdir(directory);
  await writeFile(path.join(directory, "result.json"), "{}");
  const result = await evidence("rm result.json", directory);
  expect(result.paths[0]).toMatchObject({
    scope: "temporary",
    kind: "file",
    protectedRoot: false,
    currentUserOwned: true,
  });
  expect((await evidence(`rm -rf ${os.tmpdir()}`)).paths[0]?.protectedRoot).toBe(true);
});

test("active project memory is identified without reading memory contents", async () => {
  const project = repo.replace(/[^a-zA-Z0-9]/g, "-");
  const memory = path.join(os.homedir(), ".claude/projects", project, "memory/MEMORY.md");
  const result = await collectApprovalHostEvidence({
    toolName: "Write",
    toolInput: { file_path: memory, content: "Tests run with Bun." },
    cwd: repo,
    workspacePath: repo,
  });
  expect(result.paths[0]?.scope).toBe("project_memory");
  const unrelated = await collectApprovalHostEvidence({
    toolName: "Write",
    toolInput: { file_path: path.join(os.homedir(), ".claude/projects/unrelated/memory/MEMORY.md") },
    cwd: repo,
    workspacePath: repo,
  });
  expect(unrelated.paths[0]?.scope).toBe("external");
});

test("symlinked memory directory is not treated as a registered project memory scope", async () => {
  const outside = path.join(root, "memory-outside");
  await mkdir(outside);
  await symlink(outside, path.join(repo, "memory"));
  const result = await collectApprovalHostEvidence({
    toolName: "Write",
    toolInput: { path: path.join(repo, "memory/new.md") },
    cwd: repo,
    workspacePath: repo,
  });
  expect(result.paths[0]?.scope).toBe("temporary");
});

test("recursive deletion reports nested Git metadata and inspection caps", async () => {
  const directory = path.join(repo, "nested");
  await mkdir(path.join(directory, "repo/.git"), { recursive: true });
  expect((await evidence("rm -rf nested")).paths[0]?.directory?.containsGitMetadata).toBe(true);
  const large = path.join(repo, "large");
  await mkdir(large);
  await Promise.all(
    Array.from({ length: 260 }, (_, index) => writeFile(path.join(large, String(index)), "data")),
  );
  expect((await evidence("rm -rf large")).paths[0]?.directory?.complete).toBe(false);
});

test("registered sibling worktree is inspected as workspace rather than an unrelated temp directory", async () => {
  const worktree = path.join(root, "worktree");
  git("worktree", "add", "-q", "-b", "approval-test", worktree);
  const result = await collectApprovalHostEvidence({
    toolName: "Bash",
    toolInput: { command: "rm src/clean.ts" },
    cwd: worktree,
    workspacePath: repo,
    worktreePath: worktree,
  });
  expect(result.paths[0]).toMatchObject({
    scope: "workspace",
    git: { recovery: "clean_in_head", branch: "approval-test" },
  });
});

test("agent-provided hostEvidence cannot fabricate Git proof", async () => {
  const result = await collectApprovalHostEvidence({
    toolName: "Bash",
    toolInput: { command: "rm untracked.txt", hostEvidence: { git: { recovery: "clean_in_head" } } },
    cwd: repo,
    workspacePath: repo,
  });
  expect(result.paths[0]?.git?.recovery).toBe("dirty_or_untracked");
});
