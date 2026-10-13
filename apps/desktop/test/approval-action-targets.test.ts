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
