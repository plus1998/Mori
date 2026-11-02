import path from "node:path";
import type { WorktreePlan } from "@eco/workspace";

export interface ActiveRunRuntimeStateInput {
  controller: AbortController;
  worktreePlan?: WorktreePlan;
  exclusiveWorkspace?: boolean;
}

interface ActiveRunRuntimeState {
  controller: AbortController;
  codexTurnId?: string;
  worktreePlan?: WorktreePlan;
  bashRememberPrefixes: string[];
  exclusiveWorkspace?: boolean;
}

export class ActiveRunRuntimeStateStore {
  private readonly runs = new Map<string, ActiveRunRuntimeState>();

  startRun(threadId: string, input: ActiveRunRuntimeStateInput): void {
    this.assertWorkspaceAvailable(threadId, input.worktreePlan, input.exclusiveWorkspace);
    this.runs.set(threadId, {
      ...(input.exclusiveWorkspace !== undefined ? { exclusiveWorkspace: input.exclusiveWorkspace } : {}),
      controller: input.controller,
      bashRememberPrefixes: [],
      ...(input.worktreePlan && { worktreePlan: input.worktreePlan }),
    });
  }

  assertWorkspaceAvailable(threadId: string, plan?: WorktreePlan, exclusive?: boolean): void {
    if (!plan) return;
    for (const [owner, run] of this.runs) {
      if (owner !== threadId && (exclusive || run.exclusiveWorkspace) && run.worktreePlan &&
        path.resolve(run.worktreePlan.worktreePath) === path.resolve(plan.worktreePath))
        throw new Error(`该工作树正在被对话 ${owner} 使用，请等待其运行结束后重试。`);
    }
  }

  finishRun(threadId: string): void {
    this.runs.delete(threadId);
  }

  hasRun(threadId: string): boolean {
    return this.runs.has(threadId);
  }

  bindCodexTurn(threadId: string, controller: AbortController, turnId: string): boolean {
    const run = this.runs.get(threadId);
    if (!run || run.controller !== controller || controller.signal.aborted || !turnId.trim()) {
      return false;
    }
    run.codexTurnId = turnId.trim();
    return true;
  }

  clearCodexTurn(threadId: string, controller: AbortController, turnId: string): void {
    const run = this.runs.get(threadId);
    if (run?.controller === controller && run.codexTurnId === turnId) {
      delete run.codexTurnId;
    }
  }

  ownsRequest(threadId: string, input: {
    runAttemptId?: string;
    currentRunAttemptId?: string;
    turnId?: string;
  }): boolean {
    const run = this.runs.get(threadId);
    if (!run || run.controller.signal.aborted) {
      return false;
    }
    if (input.runAttemptId) {
      return input.runAttemptId === input.currentRunAttemptId;
    }
    // Native Codex requests do not carry an Eco runAttemptId. Thread identity
    // alone cannot distinguish a late failure from a previous turn.
    return Boolean(input.turnId && run.codexTurnId === input.turnId);
  }

  abortRun(threadId: string, reason: string): boolean {
    const run = this.runs.get(threadId);
    if (!run) {
      return false;
    }
    run.controller.abort(reason);
    return true;
  }

  worktreePlan(threadId: string): WorktreePlan | undefined {
    return this.runs.get(threadId)?.worktreePlan;
  }

  setWorktreePlan(threadId: string, worktreePlan: WorktreePlan): void {
    const run = this.runs.get(threadId);
    if (!run) {
      return;
    }
    this.assertWorkspaceAvailable(threadId, worktreePlan, run.exclusiveWorkspace);
    run.worktreePlan = worktreePlan;
  }

  bashRememberPrefixes(threadId: string): readonly string[] {
    return this.runs.get(threadId)?.bashRememberPrefixes ?? [];
  }

  rememberBashPrefix(threadId: string, prefix: string): void {
    const trimmed = prefix.trim();
    if (!trimmed) {
      return;
    }
    const run = this.runs.get(threadId);
    if (!run) {
      return;
    }
    if (run.bashRememberPrefixes.includes(trimmed)) {
      return;
    }
    run.bashRememberPrefixes.push(trimmed);
  }
}
