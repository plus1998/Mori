import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);

/** Git snapshots use a private index. Never stages or commits in the user's index/branch. */
export class MultiAgentsWorkspace {
  private async git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
    const result = await execute("git", args, {
      cwd,
      env: { ...process.env, ...env },
      maxBuffer: 64 * 1024 * 1024,
    });
    return result.stdout.trim();
  }
  private async withIndex<T>(task: (env: NodeJS.ProcessEnv) => Promise<T>): Promise<T> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mori-multi-agents-"));
    try {
      return await task({ GIT_INDEX_FILE: path.join(dir, "index") });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
  private async commit(cwd: string, tree: string, parent: string, env: NodeJS.ProcessEnv) {
    const commit = await this.git(
      cwd,
      [
        "-c",
        "user.name=Mori",
        "-c",
        "user.email=mori@localhost",
        "commit-tree",
        tree,
        "-p",
        parent,
        "-m",
        "Multi-Agents working snapshot",
      ],
      env,
    );
    await this.git(cwd, ["update-ref", `refs/mori/multi-agents/${commit}`, commit]);
    return commit;
  }
  async capture(cwd: string): Promise<string> {
    const root = await this.git(cwd, ["rev-parse", "--show-toplevel"]);
    if ((await fs.realpath(cwd)) !== (await fs.realpath(root)))
      throw new Error("Multi-Agents 隔离执行目前要求项目目录是 Git 仓库根目录。");
    return this.withIndex(async (env) => {
      const parent = await this.git(cwd, ["rev-parse", "HEAD"]);
      await this.git(cwd, ["read-tree", parent], env);
      await this.git(cwd, ["add", "-A", "--", "."], env);
      const tree = await this.git(cwd, ["write-tree"], env);
      return this.commit(cwd, tree, parent, env);
    });
  }
  /** Only called before the newly created member worktree has run any model tools. */
  async seed(cwd: string, baseline: string): Promise<void> {
    const dirty = await this.git(cwd, ["status", "--porcelain"]);
    if (dirty) throw new Error("新成员工作树不干净，拒绝覆盖。");
    await this.git(cwd, ["reset", "--hard", baseline]);
  }
  private async patch(cwd: string, base: string, result: string): Promise<string> {
    const { stdout } = await execute("git", ["diff", "--binary", "--full-index", base, result, "--"], {
      cwd,
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout;
  }
  private async withPatch<T>(patch: string, task: (file: string) => Promise<T>): Promise<T> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mori-multi-agents-patch-"));
    try {
      const file = path.join(dir, "changes.patch");
      await fs.writeFile(file, patch);
      return await task(file);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
  async compose(cwd: string, baseline: string, changes: { base: string; result: string }[]): Promise<string> {
    if (!changes.length) return baseline;
    return this.withIndex(async (env) => {
      await this.git(cwd, ["read-tree", baseline], env);
      for (const change of changes) {
        const patch = await this.patch(cwd, change.base, change.result);
        if (patch)
          await this.withPatch(patch, (file) => this.git(cwd, ["apply", "--cached", "--3way", file], env));
      }
      return this.commit(cwd, await this.git(cwd, ["write-tree"], env), baseline, env);
    });
  }
  async integrate(cwd: string, base: string, result: string): Promise<void> {
    const patch = await this.patch(cwd, base, result);
    if (!patch) return;
    await this.withPatch(patch, async (file) => {
      try {
        await this.git(cwd, ["apply", "--check", file]);
      } catch (error) {
        // A crash after apply but before the durable receipt must not apply twice.
        try {
          await this.git(cwd, ["apply", "--reverse", "--check", file]);
          return;
        } catch {
          throw error;
        }
      }
      await this.git(cwd, ["apply", file]);
    });
  }
}
