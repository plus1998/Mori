import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { CommandRunner, WorktreePlan } from "@eco/workspace";
import type { ThreadSummary } from "../shared/ipc";
import type {
  ThreadWorkLocation,
  ThreadWorkLocationRequest,
  ThreadWorktreeActionRequest,
  ThreadWorktreeRecord,
  ThreadWorktreeStatus,
  ManagedWorktree,
} from "../shared/thread-worktree";

interface WorktreeStore {
  getThread(id: string): ThreadSummary | undefined;
  saveThreadWorkLocation(id: string, location: ThreadWorkLocation): void;
  getWorktree(id: string): ThreadWorktreeRecord | undefined;
  listWorktrees(): ThreadWorktreeRecord[];
  saveWorktree(record: ThreadWorktreeRecord): void;
  listWorktreeThreads(worktreeId: string): ThreadSummary[];
}
interface Registration {
  path: string;
  branch?: string;
  locked: boolean;
}

/** Only manages recorded worktrees. Never stages, commits, merges, resets or copies files. */
export class ThreadWorktreeService {
  private readonly pending = new Map<string, Promise<void>>();
  constructor(
    private readonly store: WorktreeStore,
    private readonly runner: CommandRunner,
    private readonly options: { rootPath: () => string },
  ) {}

  private async exclusive<T>(id: string, task: () => Promise<T>): Promise<T> {
    const previous = this.pending.get(id) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.pending.set(id, current);
    await previous;
    try {
      return await task();
    } finally {
      release();
      if (this.pending.get(id) === current) this.pending.delete(id);
    }
  }

  private exclusiveThread<T>(threadId: string, task: () => Promise<T>, ownerId?: string): Promise<T> {
    const owner = ownerId ?? this.store.getThread(threadId)?.workLocation?.worktree?.threadId;
    const keys = [...new Set([threadId, ...(owner ? [owner] : [])])].sort();
    const lock = (index: number): Promise<T> => index === keys.length
      ? task() : this.exclusive(keys[index]!, () => lock(index + 1));
    return lock(0);
  }

  private thread(id: string): ThreadSummary {
    const thread = this.store.getThread(id);
    if (!thread) throw new Error("找不到该对话。");
    return thread;
  }
  private async git(cwd: string, args: string[]): Promise<string> {
    const result = await this.runner.run(["git", ...args], cwd);
    if (result.exitCode !== 0)
      throw new Error(
        result.stderr.trim() || result.stdout.trim() || `git ${args[0]} failed (${result.exitCode})`,
      );
    return result.stdout.trim();
  }
  private save(threadId: string, location: ThreadWorkLocation): void {
    this.store.saveThreadWorkLocation(threadId, location);
  }
  private async repository(workspace: string): Promise<string> {
    await this.git(workspace, ["rev-parse", "--show-toplevel"]);
    const common = await this.git(workspace, ["rev-parse", "--git-common-dir"]);
    return fs.realpath(path.resolve(workspace, common));
  }
  private async repositoryRoot(workspace: string): Promise<string> {
    return fs.realpath(await this.git(workspace, ["rev-parse", "--show-toplevel"]));
  }
  private async registrations(workspace: string): Promise<Registration[]> {
    const result = await this.runner.run(["git", "worktree", "list", "--porcelain", "-z"], workspace);
    if (result.exitCode !== 0) throw new Error(result.stderr || "无法核验工作树列表。");
    const entries: Registration[] = [];
    let current: Registration | undefined;
    for (const field of result.stdout.split("\0")) {
      if (field.startsWith("worktree ")) {
        current = { path: path.resolve(field.slice(9)), locked: false };
        entries.push(current);
      } else if (current && field.startsWith("branch ")) current.branch = field.slice(7);
      else if (current && (field === "locked" || field.startsWith("locked "))) current.locked = true;
    }
    return entries;
  }
  private async present(file: string): Promise<boolean> {
    try {
      await fs.lstat(file);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }
  private async commit(workspace: string, ref: string): Promise<string | undefined> {
    const result = await this.runner.run(
      ["git", "rev-parse", "--verify", "--quiet", `${ref}^{commit}`],
      workspace,
    );
    if (result.exitCode === 1) return undefined;
    if (result.exitCode !== 0) throw new Error(result.stderr || `无法读取 ${ref}`);
    return result.stdout.trim();
  }
  private async ancestor(workspace: string, commit: string, target: string): Promise<boolean> {
    const result = await this.runner.run(["git", "merge-base", "--is-ancestor", commit, target], workspace);
    if (result.exitCode === 0) return true;
    if (result.exitCode === 1) return false;
    throw new Error(result.stderr || "无法核验提交包含关系。");
  }

  create(threadId: string): Promise<ThreadWorktreeStatus> {
    return this.exclusiveThread(threadId, () => this.createInner(threadId));
  }

  attach(threadId: string, worktreeId: string): Promise<ThreadWorktreeStatus> {
    const record = this.store.getWorktree(worktreeId);
    if (!record) throw new Error("找不到工作树管理记录。");
    return this.exclusiveThread(threadId, async () => {
      const thread = this.thread(threadId);
      if (thread.workLocation && (thread.workLocation.mode !== "needs_choice" || thread.workLocation.worktree))
        throw new Error("该对话已有工作位置。");
      this.store.saveThreadWorkLocation(threadId, { mode: "needs_choice" });
      const status = await this.managedStatusInner(worktreeId);
      if (status.record.state === "removed" || !status.exists || status.error)
        throw new Error(status.error || "工作树已清理或丢失，无法在其中新建聊天。");
      if (path.resolve(thread.workspacePath) !== path.resolve(status.record.workspacePath))
        throw new Error("工作树不属于所选项目。");
      this.save(threadId, { mode: "isolated", worktree: status.record });
      return this.statusInner(threadId);
    }, record.threadId);
  }
  private async createInner(threadId: string): Promise<ThreadWorktreeStatus> {
    const thread = this.thread(threadId);
    const previous = thread.workLocation;
    if (
      previous?.mode === "isolated" &&
      previous.worktree &&
      !["missing", "removed", "error"].includes(previous.worktree.state)
    ) {
      throw new Error("该对话已有关联的活动工作树。");
    }
    if (
      previous?.worktree &&
      previous.worktree.state !== "removed" &&
      (await this.present(previous.worktree.worktreePath))
    ) {
      throw new Error("旧工作树仍存在，请先核验并清理。");
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    const record: ThreadWorktreeRecord = {
      id,
      threadId,
      workspacePath: thread.workspacePath,
      threadTitle: thread.title,
      repositoryPath: "",
      worktreePath: path.join(
        this.options.rootPath(),
        createHash("sha256").update(thread.workspacePath).digest("hex").slice(0, 16),
        id,
      ),
      branchName: `mori/${threadId.replace(/[^a-zA-Z0-9_-]/g, "-")}/${id.slice(0, 8)}`,
      targetBranch: "",
      baseCommit: "",
      state: "creating",
      createdAt: now,
      updatedAt: now,
    };
    const location: ThreadWorkLocation = {
      mode: "isolated",
      worktree: record,
      ...(previous?.contextResetPending ? { contextResetPending: true } : {}),
    };
    this.save(threadId, location);
    try {
      const repositoryRoot = await this.repositoryRoot(thread.workspacePath);
      record.repositoryRoot = repositoryRoot;
      record.repositoryPath = await this.repository(thread.workspacePath);
      record.baseCommit = await this.git(thread.workspacePath, ["rev-parse", "--verify", "HEAD^{commit}"]);
      const branch = await this.runner.run(
        ["git", "symbolic-ref", "--quiet", "--short", "HEAD"],
        thread.workspacePath,
      );
      if (branch.exitCode !== 0) throw new Error("隔离开发需要有效的当前分支，不能从 detached HEAD 创建。");
      record.targetBranch = branch.stdout.trim();
      if (!record.targetBranch) throw new Error("隔离开发需要当前分支，不能从 detached HEAD 创建。");
      record.worktreePath = path.join(
        this.options.rootPath(),
        createHash("sha256").update(record.repositoryPath).digest("hex").slice(0, 16),
        id,
      );
      await fs.mkdir(path.dirname(record.worktreePath), { recursive: true });
      record.worktreePath = path.join(
        await fs.realpath(path.dirname(record.worktreePath)),
        path.basename(record.worktreePath),
      );
      this.save(threadId, location);
      await this.git(thread.workspacePath, [
        "worktree",
        "add",
        "-b",
        record.branchName,
        record.worktreePath,
        record.baseCommit,
      ]);
      await this.bindGitIdentity(record);
      record.state = "active";
      record.updatedAt = new Date().toISOString();
      this.save(threadId, location);
    } catch (error) {
      record.state = "error";
      record.error = error instanceof Error ? error.message : String(error);
      record.updatedAt = new Date().toISOString();
      location.mode = "needs_choice";
      this.save(threadId, location);
      return this.statusInner(threadId);
    }
    return this.statusInner(threadId);
  }

  status(threadId: string): Promise<ThreadWorktreeStatus> {
    return this.exclusiveThread(threadId, () => this.statusInner(threadId));
  }
  private async statusInner(threadId: string): Promise<ThreadWorktreeStatus> {
    const thread = this.thread(threadId);
    const location = thread.workLocation ?? { mode: "direct" as const };
    if (location.worktree) {
      const record = this.store.getWorktree(location.worktree.id);
      if (!record || path.resolve(record.workspacePath) !== path.resolve(thread.workspacePath))
        throw new Error("工作树管理记录缺失或所属项目不匹配。");
      location.worktree = record;
    }
    return this.inspect(location, thread.workspacePath, next => this.save(threadId, next));
  }

  private async bindGitIdentity(record: ThreadWorktreeRecord): Promise<void> {
    record.gitDirectory = await fs.realpath(await this.git(record.worktreePath, ["rev-parse", "--absolute-git-dir"]));
    record.gitIdentity = randomUUID();
    await fs.writeFile(path.join(record.gitDirectory, "mori-worktree-id"), record.gitIdentity, { flag: "wx" });
  }

  private async inspect(
    location: ThreadWorkLocation,
    workspacePath: string,
    persist: (location: ThreadWorkLocation) => void,
  ): Promise<ThreadWorktreeStatus> {
    const record = location.worktree;
    const reasons: string[] = [];
    const status: ThreadWorktreeStatus = {
      exists: false, workspacePath,
      worktreePath: location.mode === "direct" ? workspacePath : (record?.worktreePath ?? ""),
      changedFiles: [], ignoredFiles: [], location, blockingReasons: reasons,
    };
    if (!record || location.mode === "direct") return status;
    const before = JSON.stringify(location);
    try {
      status.exists = await this.present(record.worktreePath);
      if (!record.repositoryPath) {
        status.canForget = !status.exists && record.state === "error";
        throw new Error(record.error || "项目仓库与创建记录不匹配。");
      }
      if ((await this.repository(workspacePath)) !== record.repositoryPath)
        throw new Error("项目仓库与创建记录不匹配。");
      if (!record.repositoryRoot) record.repositoryRoot = await this.repositoryRoot(workspacePath);
      const entries = await this.registrations(workspacePath);
      const entry = entries.find(e => e.path === path.resolve(record.worktreePath));
      const ownedCommit = await this.commit(workspacePath, `refs/heads/${record.branchName}`);
      const targetCommit = await this.commit(workspacePath, `refs/heads/${record.targetBranch}`);
      if (ownedCommit) status.ownedBranchCommit = ownedCommit;
      let branchCommit: string | undefined;
      if (status.exists) {
        if (!entry) throw new Error("工作树路径与 Git 注册信息不匹配，拒绝操作。");
        if ((await fs.lstat(record.worktreePath)).isSymbolicLink())
          throw new Error("工作树路径已被符号链接替换，拒绝操作。");
        if ((await this.repository(record.worktreePath)) !== record.repositoryPath)
          throw new Error("工作树仓库与记录不匹配。");
        const gitDirectory = await fs.realpath(await this.git(record.worktreePath, ["rev-parse", "--absolute-git-dir"]));
        if (record.gitIdentity) {
          const identity = await fs.readFile(path.join(gitDirectory, "mori-worktree-id"), "utf8").catch(error => {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
            throw error;
          });
          if (record.gitDirectory !== gitDirectory || identity !== record.gitIdentity)
            throw new Error("工作树 Git 身份与创建记录不匹配，拒绝操作。");
        } else {
          if (entry.branch !== `refs/heads/${record.branchName}`)
            throw new Error("工作树 Git 身份与创建记录不匹配，拒绝操作。");
          await this.bindGitIdentity(record);
        }
        record.checkoutBranch = entry.branch?.replace(/^refs\/heads\//, "") ?? "";
        branchCommit = await this.commit(record.worktreePath, "HEAD");
        if (!branchCommit) throw new Error("工作树 HEAD 不是有效提交。");
        record.lastHeadCommit = branchCommit;
        const result = await this.runner.run(
          ["git", "status", "--porcelain=v1", "-z", "--untracked-files=all"], record.worktreePath,
        );
        if (result.exitCode !== 0) throw new Error(result.stderr || "无法读取工作树状态。");
        const fields = result.stdout.split("\0");
        for (let i = 0; i < fields.length; i++) {
          const field = fields[i];
          if (!field) continue;
          status.changedFiles.push(field.slice(3));
          if (/[RC]/.test(field.slice(0, 2))) i++;
        }
        if (status.changedFiles.length) reasons.push(`工作树仍有未提交或未跟踪的文件：${status.changedFiles.join("、")}`);
        const ignored = await this.git(record.worktreePath,
          ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"]);
        status.ignoredFiles = ignored.split("\0").filter(Boolean);
        if (status.ignoredFiles.length)
          reasons.push(`工作树包含忽略文件，请先备份或移除后再清理：${status.ignoredFiles.join("、")}`);
        if (record.state !== "removed") record.state = "active";
        delete record.error;
      } else {
        const checkoutBranch = record.checkoutBranch ?? record.branchName;
        if (entry && entry.branch !== (checkoutBranch ? `refs/heads/${checkoutBranch}` : undefined))
          throw new Error("残留工作树注册信息与记录不匹配。");
        branchCommit = await this.commit(workspacePath, checkoutBranch ? `refs/heads/${checkoutBranch}` : record.lastHeadCommit ?? "");
        status.canForget = !entry && !ownedCommit && !branchCommit && record.state !== "removed";
        if (record.state === "creating") {
          record.state = "error";
          record.error = "上次创建工作树的过程未完成，目录不存在。请重新选择工作位置。";
        } else if (record.state !== "removed" && record.state !== "error") record.state = "missing";
        location.mode = "needs_choice";
        if (record.state === "error" && record.error) throw new Error(record.error);
        if (!branchCommit && record.state !== "removed") {
          const message = `记录中的工作树分支不存在：${checkoutBranch || "detached HEAD"}；可在核验无目录和分支后移除失效记录。`;
          status.error = message;
          record.error = message;
          reasons.push(message);
        }
      }
      status.branchExists = Boolean(branchCommit);
      if (branchCommit) status.branchCommit = branchCommit;
      if (targetCommit) status.targetCommit = targetCommit;
      if (entry?.locked) reasons.push("工作树已锁定，请先由 Agent 处理。");
      if (!targetCommit) reasons.push(`目标分支不存在：${record.targetBranch}`);
      status.merged = "unmerged";
      if (branchCommit && targetCommit) {
        if (await this.ancestor(workspacePath, branchCommit, targetCommit)) status.merged = "git";
        else if (record.confirmedCommit === branchCommit && record.confirmedTargetCommit &&
          await this.ancestor(workspacePath, record.confirmedTargetCommit, targetCommit)) status.merged = "confirmed";
      }
      if (branchCommit && status.merged === "unmerged") reasons.push("尚未证明已并入目标分支；压缩合并后可由用户确认。");
      // Only delete the branch Mori created. A user's current branch is never owned by this record.
      if (ownedCommit && branchCommit && targetCommit &&
        !await this.ancestor(workspacePath, ownedCommit, targetCommit) &&
        !(status.merged === "confirmed" && await this.ancestor(workspacePath, ownedCommit, branchCommit)))
        reasons.push(`Mori 创建的分支仍有未并入的提交：${record.branchName}`);
      if (entries.some(e => e.path !== path.resolve(record.worktreePath) && e.branch === `refs/heads/${record.branchName}`))
        reasons.push("记录中的分支已在其他工作树使用。");
      status.canReattach = !status.error && Boolean(branchCommit) && !entry?.locked && record.state !== "removed" &&
        (status.exists ? location.mode === "needs_choice" : status.merged === "unmerged");
      status.canClean = reasons.length === 0 && record.state !== "removed";
    } catch (error) {
      status.error = error instanceof Error ? error.message : String(error);
      reasons.push(status.error);
      status.canClean = false;
      status.canReattach = false;
      record.error = status.error;
    }
    if (JSON.stringify(location) !== before) {
      record.updatedAt = new Date().toISOString();
      persist(location);
    }
    return status;
  }

  private persistManaged(location: ThreadWorkLocation, reactivated = false): void {
    const record = location.worktree;
    if (!record) throw new Error("工作树缺少管理记录。");
    this.store.saveWorktree(record);
    for (const thread of this.store.listWorktreeThreads(record.id)) {
      const current = thread.workLocation;
      if (!current) throw new Error("关联对话缺少工作位置记录。");
      this.store.saveThreadWorkLocation(thread.id, {
        ...current,
        worktree: record,
        ...(reactivated ? { mode: "isolated" as const } : location.mode === "needs_choice" ? { mode: "needs_choice" as const } : {}),
        ...((current.contextResetPending || location.contextResetPending)
          ? { contextResetPending: true } : {}),
      });
    }
  }

  private async managedStatusInner(worktreeId: string): Promise<ManagedWorktree> {
    const record = this.store.getWorktree(worktreeId);
    if (!record) throw new Error("找不到工作树管理记录。");
    const thread = this.store.getThread(record.threadId);
    const attached = thread?.workLocation?.worktree?.id === record.id && thread.workLocation.mode !== "direct";
    const location: ThreadWorkLocation = attached && thread?.workLocation
      ? { ...thread.workLocation, worktree: record } : { mode: "isolated", worktree: record };
    const status = await this.inspect(location, record.workspacePath, next => this.persistManaged(next));
    return {
      ...status,
      record: status.location?.worktree ?? record,
      threadTitle: thread?.title ?? record.threadTitle ?? record.threadId,
      threadExists: Boolean(thread),
      attached,
      busy: this.store.listWorktreeThreads(record.id).some(linked =>
        ["running", "queued", "awaiting_plan"].includes(linked.status)),
    };
  }

  async listManaged(): Promise<ManagedWorktree[]> {
    const records = this.store.listWorktrees().filter(record => record.state !== "removed");
    return Promise.all(records.map(record =>
      this.exclusive(record.threadId, () => this.managedStatusInner(record.id))));
  }

  forgetManaged(request: ThreadWorktreeActionRequest): Promise<ThreadWorktreeStatus> {
    return this.exclusiveThread(request.threadId, async () => {
      const status = await this.managedStatusInner(request.worktreeId);
      if (status.record.threadId !== request.threadId) throw new Error("工作树记录已变化，请刷新后重试。");
      if (status.busy || !status.canForget) throw new Error("工作树仍有目录、分支或注册信息，不能移除记录。");
      status.record.state = "removed";
      delete status.record.error;
      status.record.updatedAt = new Date().toISOString();
      this.persistManaged({ mode: "needs_choice", worktree: status.record, contextResetPending: true });
      return this.managedStatusInner(request.worktreeId);
    });
  }

  private async checked(
    request: ThreadWorktreeActionRequest,
    managed = false,
  ): Promise<ThreadWorktreeStatus & { location: ThreadWorkLocation & { worktree: ThreadWorktreeRecord } }> {
    if (managed) {
      const record = this.store.getWorktree(request.worktreeId);
      if (!record || record.threadId !== request.threadId)
        throw new Error("工作树记录已变化，请刷新后重试。");
    }
    const status = managed ? await this.managedStatusInner(request.worktreeId) : await this.statusInner(request.threadId);
    if (!status.location?.worktree || status.location.worktree.id !== request.worktreeId ||
      (managed && status.location.worktree.threadId !== request.threadId))
      throw new Error("工作树记录已变化，请刷新后重试。");
    if (this.store.listWorktreeThreads(request.worktreeId).some(thread =>
      ["running", "queued", "awaiting_plan"].includes(thread.status)))
      throw new Error("请先结束当前运行或待批准的计划，再操作工作树。");
    if (status.error) throw new Error(status.error);
    return status as ThreadWorktreeStatus & {
      location: ThreadWorkLocation & { worktree: ThreadWorktreeRecord };
    };
  }
  confirmMerged(request: ThreadWorktreeActionRequest): Promise<ThreadWorktreeStatus> {
    return this.confirm(request, false);
  }
  confirmManagedMerged(request: ThreadWorktreeActionRequest): Promise<ThreadWorktreeStatus> {
    return this.confirm(request, true);
  }
  private confirm(request: ThreadWorktreeActionRequest, managed: boolean): Promise<ThreadWorktreeStatus> {
    return this.exclusiveThread(request.threadId, async () => {
      const status = await this.checked(request, managed);
      if (!status.branchCommit || !status.targetCommit)
        throw new Error("缺少可核验的分支提交，不能确认已并入。");
      if (
        request.expectedBranchCommit !== status.branchCommit ||
        request.expectedTargetCommit !== status.targetCommit
      ) {
        throw new Error("分支提交已变化，请刷新状态后重新确认。");
      }
      status.location.worktree.confirmedCommit = status.branchCommit;
      status.location.worktree.confirmedTargetCommit = status.targetCommit;
      status.location.worktree.updatedAt = new Date().toISOString();
      if (managed) this.persistManaged(status.location);
      else this.save(request.threadId, status.location);
      return managed ? this.managedStatusInner(request.worktreeId) : this.statusInner(request.threadId);
    });
  }
  cleanup(request: ThreadWorktreeActionRequest): Promise<ThreadWorktreeStatus> {
    return this.remove(request, false);
  }
  cleanupManaged(request: ThreadWorktreeActionRequest): Promise<ThreadWorktreeStatus> {
    return this.remove(request, true);
  }
  private remove(request: ThreadWorktreeActionRequest, managed: boolean): Promise<ThreadWorktreeStatus> {
    return this.exclusiveThread(request.threadId, async () => {
      const status = await this.checked(request, managed);
      const { location } = status;
      const record = location.worktree;
      try {
        if ((request.expectedBranchCommit !== undefined && request.expectedBranchCommit !== status.branchCommit) ||
          (request.expectedTargetCommit !== undefined && request.expectedTargetCommit !== status.targetCommit))
          throw new Error("分支提交已变化，请刷新状态后重新确认清理。");
        if (!status.canClean) throw new Error(status.blockingReasons?.join("\n") || "不能清理该工作树。");
        const entries = await this.registrations(record.workspacePath);
        if (entries.some((e) => e.path === path.resolve(record.worktreePath))) {
          await this.git(record.workspacePath, ["worktree", "remove", record.worktreePath]);
        }
        if (await this.present(record.worktreePath)) throw new Error("工作树目录仍存在，未删除分支。");
        // Compare-and-delete only the acknowledged/proven tip. Never use branch -D or worktree --force.
        if (status.ownedBranchCommit)
          await this.git(record.workspacePath, [
            "update-ref",
            "-d",
            `refs/heads/${record.branchName}`,
            status.ownedBranchCommit,
          ]);
        record.state = "removed";
        delete record.error;
        location.mode = "needs_choice";
        location.contextResetPending = true;
        record.updatedAt = new Date().toISOString();
        this.persistManaged(location);
      } catch (error) {
        record.error = error instanceof Error ? error.message : String(error);
        record.updatedAt = new Date().toISOString();
        this.persistManaged(location);
        throw error;
      }
      return managed ? this.managedStatusInner(request.worktreeId) : this.statusInner(request.threadId);
    });
  }
  selectLocation(request: ThreadWorkLocationRequest): Promise<ThreadWorktreeStatus> {
    return this.exclusiveThread(request.threadId, async () => {
      const status = await this.statusInner(request.threadId);
      const location = status.location;
      if (location?.mode !== "needs_choice") throw new Error("工作位置仍可使用，无需重新选择。");
      if (location.worktree && request.worktreeId !== location.worktree.id)
        throw new Error("工作树记录已变化，请刷新后重试。");
      if (request.choice === "project") {
        if (status.exists) throw new Error("旧工作树仍存在，请先核验并清理。");
        this.save(request.threadId, { ...location, mode: "direct", contextResetPending: true });
      } else if (request.choice === "new_worktree") {
        this.save(request.threadId, { ...location, contextResetPending: true });
        return this.createInner(request.threadId);
      } else if (request.choice === "reattach") {
        if (!status.canReattach || !location.worktree) throw new Error("旧分支当前不能重新挂载。");
        const record = location.worktree;
        try {
          if (status.exists) {
            location.mode = "isolated";
            location.contextResetPending = true;
            this.persistManaged(location, true);
            return this.statusInner(request.threadId);
          }
          // Remove only this verified missing registration; never prune unrelated worktrees.
          const entries = await this.registrations(record.workspacePath);
          if (entries.some((e) => e.path === path.resolve(record.worktreePath))) {
            await this.git(record.workspacePath, ["worktree", "remove", record.worktreePath]);
          }
          await fs.mkdir(path.dirname(record.worktreePath), { recursive: true });
          const branch = record.checkoutBranch ?? record.branchName;
          const revision = branch || record.lastHeadCommit;
          if (!revision) throw new Error("缺少可恢复的工作树提交。");
          await this.git(record.workspacePath, ["worktree", "add", ...(branch ? [] : ["--detach"]),
            record.worktreePath, revision]);
          await this.bindGitIdentity(record);
          record.state = "active";
          delete record.error;
          location.mode = "isolated";
          location.contextResetPending = true;
          record.updatedAt = new Date().toISOString();
          this.save(request.threadId, location);
          this.persistManaged(location, true);
        } catch (error) {
          record.error = error instanceof Error ? error.message : String(error);
          this.save(request.threadId, location);
          throw error;
        }
      } else throw new Error("无效的后续工作位置。");
      return this.statusInner(request.threadId);
    });
  }
  async resolve(threadId: string): Promise<{ cwd: string; worktreePlan: WorktreePlan; isolated: boolean }> {
    const status = await this.status(threadId);
    const thread = this.thread(threadId);
    if (status.location?.mode === "needs_choice")
      throw new Error("工作树已清理或丢失。请先选择「在项目目录继续」或「新建隔离工作树」。");
    const isolated = status.location?.mode === "isolated";
    if (isolated && (!status.exists || status.error)) throw new Error(status.error || "隔离工作树不可用。");
    const record = status.location?.worktree;
    if (isolated && !record) throw new Error("隔离工作树缺少创建记录，无法启动运行时。");
    const cwd = isolated && record ? record.worktreePath : thread.workspacePath;
    return {
      cwd,
      isolated,
      worktreePlan: {
        workspacePath: thread.workspacePath,
        worktreePath: cwd,
        branchName: record?.checkoutBranch ?? record?.branchName ?? "",
      },
    };
  }
}
