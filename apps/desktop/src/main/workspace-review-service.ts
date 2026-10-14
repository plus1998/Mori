import { type FSWatcher, watch } from "node:fs";
import { lstat } from "node:fs/promises";
import path from "node:path";
import type { WorkspaceDiffChangedEvent, WorkspaceDiffResult, WorkspaceFileDiffResult } from "../shared/ipc";
import { type GitRunner, getWorkspaceFileDiff } from "./git-operations";
import {
  getWorkspaceDiffSummary,
  readUntrackedFileStats,
  type UntrackedFileStats,
  type WorkspaceDiffContext,
} from "./workspace-diff-summary";
import { findGitRootOnDisk } from "./workspace-inspect";

const MAX_WORKSPACES = 8;
const MAX_FILE_CACHE_BYTES = 16 * 1024 * 1024;
const CHANGE_DELAY_MS = 150;
const SUMMARY_MAX_AGE_MS = 30_000;

interface WorkspaceState {
  workspacePath: string;
  context?: WorkspaceDiffContext;
  setup: Promise<void>;
  refreshSetup?: Promise<void>;
  watchers: FSWatcher[];
  generation: number;
  baseFileGeneration: number;
  fileGenerations: Map<string, number>;
  summary?: WorkspaceDiffResult;
  summaryAt: number;
  summaryRun?: Promise<WorkspaceDiffResult>;
  summaryController?: AbortController;
  fileQueue: Promise<void>;
  files: Map<
    string,
    {
      generation: number;
      promise: Promise<WorkspaceFileDiffResult>;
      bytes: number;
      controller: AbortController;
    }
  >;
  untracked: Map<string, { key: string; stats: UntrackedFileStats }>;
  pendingPaths: Set<string>;
  pendingAll: boolean;
  changeTimer?: ReturnType<typeof setTimeout>;
  changeRun?: Promise<void>;
  watchError?: string;
  retryTimer?: ReturnType<typeof setTimeout>;
  retryDelay: number;
  disposed: boolean;
}

/** One watched snapshot per workspace, shared by all desktop and remote review consumers. */
export class WorkspaceReviewService {
  private readonly states = new Map<string, WorkspaceState>();
  private nextGeneration = 1;

  constructor(
    private readonly run: GitRunner,
    private readonly onChanged: (event: WorkspaceDiffChangedEvent) => void,
  ) {}

  private state(workspacePath: string): WorkspaceState {
    const cwd = path.resolve(workspacePath);
    let state = this.states.get(cwd);
    if (state) {
      this.states.delete(cwd);
      this.states.set(cwd, state);
      return state;
    }
    const generation = this.nextGeneration++;
    state = {
      workspacePath: cwd,
      setup: Promise.resolve(),
      watchers: [],
      generation,
      baseFileGeneration: generation,
      fileGenerations: new Map(),
      summaryAt: 0,
      files: new Map(),
      fileQueue: Promise.resolve(),
      untracked: new Map(),
      pendingPaths: new Set(),
      pendingAll: false,
      disposed: false,
      retryDelay: 1_000,
    };
    this.states.set(cwd, state);
    state.setup = this.setup(state).catch((error) => {
      this.reportWatchError(state, error);
      throw error;
    });
    while (this.states.size > MAX_WORKSPACES) {
      const oldest = this.states.entries().next().value;
      if (oldest === undefined) break;
      this.close(oldest[1]);
      this.states.delete(oldest[0]);
    }
    return state;
  }

  private async setup(state: WorkspaceState): Promise<void> {
    const result = await this.run(
      [
        "git",
        "rev-parse",
        "--path-format=absolute",
        "--show-toplevel",
        "--absolute-git-dir",
        "--git-common-dir",
        "--show-prefix",
      ],
      state.workspacePath,
    );
    if (state.disposed) return;
    if (result.exitCode !== 0) {
      if (/not a git repository/i.test(result.stderr)) return;
      throw new Error(result.stderr || "Could not locate Git repository");
    }
    const [root, gitDir, commonDir, prefix = ""] = result.stdout.trimEnd().split("\n");
    if (!root || !gitDir || !commonDir) throw new Error("Git returned incomplete repository metadata");
    state.context = { root, prefix, hasHead: false };
    const metadataPath = (filePath: string) => {
      const relative = path.relative(root, filePath).split(path.sep).join("/");
      if (relative === ".git") return true;
      for (const directory of [gitDir, commonDir]) {
        const name = path.relative(directory, filePath).split(path.sep).join("/");
        if (
          [
            "HEAD",
            "index",
            "config",
            "config.worktree",
            "packed-refs",
            "commondir",
            "info/exclude",
            "info/attributes",
          ].includes(name) ||
          name.startsWith("refs/")
        )
          return true;
      }
      return false;
    };
    const addWatch = (directory: string, recursive: boolean, workingTree: boolean) => {
      try {
        const watcher = watch(directory, { recursive }, (_kind, filename) => {
          if (state.disposed) return;
          if (filename === null) {
            this.schedule(state, undefined);
            return;
          }
          const absolute = path.resolve(directory, filename.toString());
          if (metadataPath(absolute)) {
            this.schedule(state, undefined);
            return;
          }
          if (!workingTree) return;
          // Git's own objects, locks, LFS temp files and logs never invalidate review.
          const relative = path.relative(state.workspacePath, absolute).split(path.sep).join("/");
          if (relative.split("/").includes(".git")) return;
          this.schedule(state, relative);
        });
        watcher.unref();
        watcher.on("error", (error) => this.reportWatchError(state, error));
        state.watchers.push(watcher);
      } catch (error) {
        const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
        // Missing refs/info directories are covered by their parent's metadata watch.
        if (!missing || workingTree) this.reportWatchError(state, error);
      }
    };
    addWatch(state.workspacePath, true, true);
    for (const directory of new Set([gitDir, commonDir])) {
      const relative = path.relative(state.workspacePath, directory);
      if (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) continue;
      addWatch(directory, false, false);
      addWatch(path.join(directory, "refs"), true, false);
      addWatch(path.join(directory, "info"), false, false);
    }
  }

  private reportWatchError(state: WorkspaceState, error: unknown): void {
    if (state.disposed) return;
    state.watchError = `Git auto refresh unavailable: ${error instanceof Error ? error.message : String(error)}`;
    this.onChanged({
      workspacePath: state.workspacePath,
      revision: state.generation,
      error: state.watchError,
    });
    if (state.summary) state.summary = { ...state.summary, watchError: state.watchError };
    if (state.retryTimer) return;
    state.retryTimer = setTimeout(() => {
      delete state.retryTimer;
      for (const watcher of state.watchers) watcher.close();
      state.watchers = [];
      delete state.watchError;
      state.setup = this.setup(state)
        .then(() => {
          if (state.disposed || state.watchError) return;
          state.retryDelay = 1_000;
          this.invalidateState(state);
          this.onChanged({ workspacePath: state.workspacePath, revision: state.generation });
        })
        .catch((error) => this.reportWatchError(state, error));
    }, state.retryDelay);
    state.retryDelay = Math.min(state.retryDelay * 2, 30_000);
    state.retryTimer.unref();
  }

  private schedule(state: WorkspaceState, filePath: string | undefined): void {
    if (state.disposed) return;
    if (
      filePath === undefined ||
      filePath === "" ||
      [".gitignore", ".gitattributes"].includes(path.basename(filePath))
    )
      state.pendingAll = true;
    else state.pendingPaths.add(filePath);
    if (state.changeTimer || state.changeRun) return;
    state.changeTimer = setTimeout(() => {
      delete state.changeTimer;
      state.changeRun = this.flushChanges(state)
        .catch((error) => this.reportWatchError(state, error))
        .finally(() => {
          delete state.changeRun;
          if (state.pendingAll || state.pendingPaths.size > 0)
            this.schedule(state, state.pendingAll ? undefined : [...state.pendingPaths][0]);
        });
    }, CHANGE_DELAY_MS);
    state.changeTimer.unref();
  }

  private async flushChanges(state: WorkspaceState): Promise<void> {
    const all = state.pendingAll;
    const paths = [...state.pendingPaths];
    state.pendingAll = false;
    state.pendingPaths.clear();
    let changed = paths;
    if (!all && paths.length > 0) {
      const result = await this.run(["git", "check-ignore", "-z", "--stdin"], state.workspacePath, {
        stdin: `${paths.join("\0")}\0`,
      });
      if (result.exitCode !== 0 && result.exitCode !== 1)
        throw new Error(result.stderr || "Could not filter ignored Git paths");
      const ignored = new Set(result.stdout.split("\0").filter(Boolean));
      changed = paths.filter((entry) => !ignored.has(entry));
    }
    if (state.disposed || (!all && changed.length === 0)) return;
    this.invalidateState(state, all ? undefined : changed);
    this.onChanged({
      workspacePath: state.workspacePath,
      revision: state.generation,
      ...(all ? {} : { changedPaths: changed }),
    });
  }

  private invalidateState(state: WorkspaceState, paths?: string[]): void {
    state.generation = this.nextGeneration++;
    state.summaryController?.abort();
    delete state.summary;
    if (!paths) {
      state.baseFileGeneration = state.generation;
      state.fileGenerations.clear();
      for (const file of state.files.values()) file.controller.abort();
      state.files.clear();
      state.untracked.clear();
      return;
    }
    const affected = (filePath: string) =>
      paths.some((entry) => filePath === entry || filePath.startsWith(`${entry}/`));
    for (const filePath of new Set([...state.fileGenerations.keys(), ...state.files.keys(), ...paths])) {
      if (!affected(filePath)) continue;
      state.fileGenerations.set(filePath, state.generation);
      state.files.get(filePath)?.controller.abort();
      state.files.delete(filePath);
    }
    for (const absolute of state.untracked.keys())
      if (affected(path.relative(state.workspacePath, absolute).split(path.sep).join("/")))
        state.untracked.delete(absolute);
  }

  invalidate(workspacePath: string, paths?: string[]): void {
    const state = this.states.get(path.resolve(workspacePath));
    if (state) this.schedule(state, paths?.length === 1 ? paths[0] : undefined);
  }

  async getSummary(workspacePath: string, refresh = false): Promise<WorkspaceDiffResult> {
    const state = this.state(workspacePath);
    await state.setup;
    // A workspace inspected before git init must acquire its watcher and fresh snapshot afterward.
    if (!state.context && (await findGitRootOnDisk(state.workspacePath)) && !state.context) {
      state.refreshSetup ??= this.setup(state)
        .then(() => {
          this.invalidateState(state);
        })
        .catch((error) => {
          this.reportWatchError(state, error);
          throw error;
        })
        .finally(() => {
          delete state.refreshSetup;
        });
      await state.refreshSetup;
    }
    if (refresh) this.invalidateState(state);
    while (!state.disposed) {
      if (state.summary && Date.now() - state.summaryAt < SUMMARY_MAX_AGE_MS) return state.summary;
      if (state.summaryRun) {
        const controller = state.summaryController;
        try {
          await state.summaryRun;
        } catch (error) {
          if (!controller?.signal.aborted) throw error;
        }
        continue;
      }
      const generation = state.generation;
      const controller = new AbortController();
      state.summaryController = controller;
      const run: GitRunner = (args, cwd, options) =>
        this.run(args, cwd, { ...options, signal: controller.signal });
      const work = async () => {
        if (state.context) {
          const head = await run(["git", "rev-parse", "--verify", "--quiet", "HEAD"], state.workspacePath);
          state.context.hasHead = head.exitCode === 0;
        }
        const diff = await getWorkspaceDiffSummary(state.workspacePath, run, {
          ...(state.context ? { context: state.context } : {}),
          readUntracked: async (absolute, forceText) => {
            const info = await lstat(absolute);
            const key = `${forceText}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
            const cached = state.untracked.get(absolute);
            if (cached?.key === key) return cached.stats;
            const stats = await readUntrackedFileStats(absolute, forceText, controller.signal);
            if (state.generation === generation) {
              state.untracked.set(absolute, { key, stats });
              while (state.untracked.size > 4_096) {
                const oldest = state.untracked.keys().next().value;
                if (oldest === undefined) break;
                state.untracked.delete(oldest);
              }
            }
            return stats;
          },
        });
        const result: WorkspaceDiffResult = {
          ...diff,
          revision: generation,
          ...(state.watchError ? { watchError: state.watchError } : {}),
          files: diff.files.map((file) => ({
            ...file,
            revision: state.fileGenerations.get(file.path) ?? state.baseFileGeneration,
          })),
        };
        if (state.generation === generation && !state.disposed) {
          state.summary = result;
          state.summaryAt = Date.now();
        }
        return result;
      };
      state.summaryRun = work();
      try {
        await state.summaryRun;
      } catch (error) {
        if (!controller.signal.aborted) throw error;
      } finally {
        delete state.summaryRun;
        delete state.summaryController;
      }
    }
    throw new Error("Workspace review subscription was closed");
  }

  async getFile(workspacePath: string, filePath: string): Promise<WorkspaceFileDiffResult> {
    const state = this.state(workspacePath);
    while (!state.disposed) {
      const summary = await this.getSummary(workspacePath);
      const file = summary.files.find((entry) => entry.path === filePath);
      const generation = state.fileGenerations.get(filePath) ?? state.baseFileGeneration;
      let cached = state.files.get(filePath);
      if (!cached || cached.generation !== generation) {
        const controller = new AbortController();
        const run: GitRunner = (args, cwd, options) =>
          this.run(args, cwd, { ...options, signal: controller.signal });
        const promise = state.fileQueue.then(() => {
          controller.signal.throwIfAborted();
          if (state.disposed) throw new Error("Workspace review subscription was closed");
          return getWorkspaceFileDiff(state.workspacePath, filePath, run, {
            ...(state.context ? { context: state.context } : {}),
            ...(file ? { file } : {}),
          });
        });
        state.fileQueue = promise.then(
          () => {},
          () => {},
        );
        const entry = {
          generation,
          bytes: 0,
          promise,
          controller,
        };
        cached = entry;
        state.files.set(filePath, entry);
        entry.promise
          .then((result) => {
            entry.bytes = Buffer.byteLength(result.patch) + (result.imagePreview?.base64.length ?? 0);
            if (entry.bytes > MAX_FILE_CACHE_BYTES && state.files.get(filePath) === entry)
              state.files.delete(filePath);
            let total = [...state.files.values()].reduce((sum, file) => sum + file.bytes, 0);
            for (const [key, value] of state.files) {
              if (total <= MAX_FILE_CACHE_BYTES && state.files.size <= 32) break;
              if (key === filePath) continue;
              state.files.delete(key);
              total -= value.bytes;
            }
          })
          .catch(() => {
            if (state.files.get(filePath) === entry) state.files.delete(filePath);
          });
      }
      let result: WorkspaceFileDiffResult;
      try {
        result = await cached.promise;
      } catch (error) {
        if (generation !== (state.fileGenerations.get(filePath) ?? state.baseFileGeneration)) continue;
        throw error;
      }
      if (generation === (state.fileGenerations.get(filePath) ?? state.baseFileGeneration)) return result;
    }
    throw new Error("Workspace review subscription was closed");
  }

  private close(state: WorkspaceState): void {
    state.disposed = true;
    state.summaryController?.abort();
    if (state.changeTimer) clearTimeout(state.changeTimer);
    if (state.retryTimer) clearTimeout(state.retryTimer);
    for (const watcher of state.watchers) watcher.close();
    for (const file of state.files.values()) file.controller.abort();
    state.files.clear();
    state.untracked.clear();
  }

  dispose(): void {
    for (const state of this.states.values()) this.close(state);
    this.states.clear();
  }
}
