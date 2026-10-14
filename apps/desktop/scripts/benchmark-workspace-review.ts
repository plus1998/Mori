import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { defaultGitRunner, type GitRunner, type WorkspaceDiffResult } from "../src/main/git-operations";
import { WorkspaceReviewService } from "../src/main/workspace-review-service";
import { parseUnifiedDiffStats } from "../src/shared/worktree-merge";

// bun run scripts/benchmark-workspace-review.ts <revision-before-optimization>
// All file edits, staging and commits are confined to a temporary fixture repository.
const base = process.argv[2];
if (!base) throw new Error("Pass a Git revision from before the workspace review optimization.");
const oldSource = await defaultGitRunner(
  ["git", "show", `${base}:apps/desktop/src/main/git-operations.ts`],
  process.cwd(),
);
if (oldSource.exitCode !== 0) throw new Error(oldSource.stderr);
function extractFunction(name: string): string {
  const start = oldSource.stdout.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`Baseline does not contain ${name}`);
  const end = oldSource.stdout.indexOf("\n}", start);
  if (end < 0) throw new Error(`Could not extract baseline ${name}`);
  return oldSource.stdout.slice(start, end + 2);
}
const diffFunction = extractFunction("getWorkspaceDiff");
if (diffFunction.includes("getWorkspaceDiffSummary"))
  throw new Error("Select a revision preceding the metadata-only review implementation.");
const code = new Bun.Transpiler({ loader: "ts" }).transformSync(
  `${extractFunction("truncatePatch")}\nasync ${diffFunction}`,
);
const original = new Function(
  "path",
  "defaultGitRunner",
  "parseUnifiedDiffStats",
  "COMMIT_DIFF_MAX_CHARS",
  "readWorkspaceDiffContents",
  `${code}\nreturn getWorkspaceDiff;`,
)(path, defaultGitRunner, parseUnifiedDiffStats, 100_000, () => {
  throw new Error("Summary benchmark must not load file contents");
}) as (
  cwd: string,
  run: GitRunner,
  options: { includeContents: false; includePatch: false },
) => Promise<WorkspaceDiffResult>;

const cwd = await mkdtemp(path.join(tmpdir(), "eco-review-benchmark-"));
async function git(...args: string[]) {
  const result = await defaultGitRunner(["git", ...args], cwd);
  if (result.exitCode !== 0) throw new Error(result.stderr);
}
try {
  await git("init", "-b", "main");
  await git("config", "user.name", "Review benchmark");
  await git("config", "user.email", "review@example.test");
  await writeFile(path.join(cwd, "tracked.ts"), "export const value = 0;\n");
  await git("add", ".");
  await git("commit", "-m", "fixture");
  await writeFile(path.join(cwd, "tracked.ts"), "export const value = 1;\n");
  await Promise.all(
    Array.from({ length: 100 }, (_, i) =>
      writeFile(
        path.join(cwd, `new-${i.toString().padStart(3, "0")}.ts`),
        "export const added = 1;\n".repeat(200),
      ),
    ),
  );
  for (let round = 1; round <= 3; round++) {
    let baselineCommands = 0;
    const baselineRun: GitRunner = (args, dir, options) => {
      baselineCommands++;
      return defaultGitRunner(args, dir, options);
    };
    let start = performance.now();
    const oldDiff = await original(cwd, baselineRun, { includeContents: false, includePatch: false });
    const baselineMs = performance.now() - start;
    let commands = 0;
    const run: GitRunner = (args, dir, options) => {
      commands++;
      return defaultGitRunner(args, dir, options);
    };
    const service = new WorkspaceReviewService(run, () => {});
    try {
      start = performance.now();
      const diff = await service.getSummary(cwd);
      const coldMs = performance.now() - start;
      const coldCommands = commands;
      start = performance.now();
      await service.getSummary(cwd);
      const warmMs = performance.now() - start;
      start = performance.now();
      await service.getFile(cwd, "tracked.ts");
      const fileColdMs = performance.now() - start;
      start = performance.now();
      await service.getFile(cwd, "tracked.ts");
      const fileWarmMs = performance.now() - start;
      console.log(
        JSON.stringify({
          round,
          expectedFiles: 101,
          baseline: { ms: baselineMs, commands: baselineCommands, files: oldDiff.fileCount },
          optimized: { coldMs, coldCommands, warmMs, files: diff.fileCount, fileColdMs, fileWarmMs },
        }),
      );
    } finally {
      service.dispose();
    }
  }
} finally {
  await rm(cwd, { recursive: true, force: true });
}
