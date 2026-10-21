import type { RuntimeAgentRole } from "../shared/ipc";
import type {
  AgentInstanceRecord,
  RunAttemptCommandDispatch,
  RunAttemptPhase,
  RunAttemptRecord,
  RunAttemptStatus,
} from "./usage-ledger";

export interface AgentLifecycleStore {
  upsertRunAttempt(
    record: RunAttemptRecord,
    commandDispatch?: RunAttemptCommandDispatch,
  ): void;
  upsertAgentInstance(record: AgentInstanceRecord): void;
  listAgentInstances?(threadId: string): AgentInstanceRecord[];
}

export interface AgentLifecycleServiceOptions {
  now?: () => string;
  attemptId?: (input: { threadId: string; phase: RunAttemptPhase; retryIndex: number }) => string;
}

export interface AgentLifecycleRecoveryInput {
  threadId: string;
  attempts: readonly RunAttemptRecord[];
  agents: readonly AgentInstanceRecord[];
  runStatus: Exclude<RunAttemptStatus, "running">;
}

export interface AgentLifecycleRecoveryResult {
  runAttemptsSettled: number;
  agentInstancesSettled: number;
  settledRunAttemptIds: string[];
}

interface ThreadLifecycleState {
  currentAttempt?: RunAttemptRecord;
  currentPlannerAgentId?: string;
  lastAttemptId?: string;
  lastPlannerAgentId?: string;
  activeAgents: Map<string, AgentInstanceRecord>;
}

export class AgentLifecycleService {
  private readonly threads = new Map<string, ThreadLifecycleState>();
  private sequence = 0;

  constructor(
    private readonly store: AgentLifecycleStore,
    private readonly options: AgentLifecycleServiceOptions = {},
  ) {}

  startRunAttempt(input: {
    threadId: string;
    phase: RunAttemptPhase;
    retryIndex: number;
    attemptId?: string;
    metadata?: Record<string, unknown>;
    commandDispatch?: RunAttemptCommandDispatch;
  }): RunAttemptRecord {
    const state = this.getOrCreateThread(input.threadId);
    if (state.currentAttempt) {
      this.finishRunAttempt(input.threadId, "failed");
    }

    const now = this.now();
    const attempt: RunAttemptRecord = {
      threadId: input.threadId,
      attemptId: input.attemptId?.trim() || this.createAttemptId(input),
      phase: input.phase,
      retryIndex: input.retryIndex,
      status: "running",
      startedAt: now,
      ...(input.metadata && { metadata: input.metadata }),
    };
    this.store.upsertRunAttempt(attempt, input.commandDispatch);
    state.currentAttempt = attempt;
    state.currentPlannerAgentId = `main:${attempt.attemptId}`;
    this.store.upsertAgentInstance({
      threadId: input.threadId,
      agentId: state.currentPlannerAgentId,
      role: "main",
      kind: "main",
      status: "active",
      runAttemptId: attempt.attemptId,
      startedAt: now,
      updatedAt: now,
    });
    return attempt;
  }

  finishRunAttempt(threadId: string, status: Exclude<RunAttemptStatus, "running">): void {
    const state = this.threads.get(threadId);
    const attempt = state?.currentAttempt;
    if (!state || !attempt) {
      return;
    }
    const now = this.now();
    this.store.upsertRunAttempt({
      ...attempt,
      status,
      endedAt: now,
    });
    state.lastAttemptId = attempt.attemptId;
    if (state.currentPlannerAgentId) {
      state.lastPlannerAgentId = state.currentPlannerAgentId;
    } else {
      delete state.lastPlannerAgentId;
    }
    for (const agent of state.activeAgents.values()) {
      this.upsertAgent(threadId, {
        ...agent,
        status: "abandoned",
        endedAt: now,
        updatedAt: now,
      });
    }
    if (state.currentPlannerAgentId) {
      this.store.upsertAgentInstance({
        threadId,
        agentId: state.currentPlannerAgentId,
        role: "main",
        kind: "main",
        status: status === "completed" ? "stopped" : "abandoned",
        runAttemptId: attempt.attemptId,
        startedAt: attempt.startedAt,
        endedAt: now,
        updatedAt: now,
      });
    }
    delete state.currentAttempt;
    delete state.currentPlannerAgentId;
    state.activeAgents.clear();
  }

  noteTaskToolUse(_threadId: string, _toolUseId: string, _role?: RuntimeAgentRole): void {}

  startSubagent(input: {
    threadId: string;
    agentId: string;
    role: RuntimeAgentRole;
    missionKey?: string;
    todoId?: string;
    parentToolUseId?: string;
  }): AgentInstanceRecord | undefined {
    const state = this.getOrCreateThread(input.threadId);
    const now = this.now();
    const parentToolUseId = input.parentToolUseId?.trim() || undefined;
    const record: AgentInstanceRecord = {
      threadId: input.threadId,
      agentId: input.agentId,
      role: input.role,
      kind: "subagent",
      status: "active",
      startedAt: now,
      updatedAt: now,
      ...(state.currentAttempt?.attemptId && { runAttemptId: state.currentAttempt.attemptId }),
      ...(state.currentPlannerAgentId && { parentAgentId: state.currentPlannerAgentId }),
      ...(parentToolUseId && { parentToolUseId }),
      ...(input.missionKey && { missionKey: input.missionKey }),
      ...(input.todoId && { todoId: input.todoId }),
    };
    this.upsertAgent(input.threadId, record);
    return record;
  }

  linkSubagentParentToolUse(input: {
    threadId: string;
    agentId: string;
    parentToolUseId: string;
  }): AgentInstanceRecord | undefined {
    const agentId = input.agentId.trim();
    const parentToolUseId = input.parentToolUseId.trim();
    if (!agentId || !parentToolUseId) {
      return undefined;
    }
    const state = this.threads.get(input.threadId);
    const existing = state?.activeAgents.get(agentId);
    if (!existing) {
      return undefined;
    }
    const now = this.now();
    const updated: AgentInstanceRecord = {
      ...existing,
      parentToolUseId,
      updatedAt: now,
    };
    this.upsertAgent(input.threadId, updated);
    return updated;
  }

  stopSubagent(input: { threadId: string; agentId: string; role: RuntimeAgentRole }): void {
    this.finishSubagent(input, "stopped");
  }

  abandonSubagent(input: { threadId: string; agentId: string; role: RuntimeAgentRole }): void {
    this.finishSubagent(input, "abandoned");
  }

  private finishSubagent(
    input: { threadId: string; agentId: string; role: RuntimeAgentRole },
    status: "stopped" | "abandoned",
  ): void {
    const state = this.getOrCreateThread(input.threadId);
    const existing =
      state.activeAgents.get(input.agentId) ?? this.readPersistedSubagent(input.threadId, input.agentId);
    if (!existing || !shouldApplyAgentInstanceStatus(existing.status, status)) {
      return;
    }
    const now = this.now();
    this.upsertAgent(input.threadId, {
      ...existing,
      role: existing.role || input.role,
      status,
      endedAt: now,
      updatedAt: now,
    });
    state.activeAgents.delete(input.agentId);
  }

  private readPersistedSubagent(threadId: string, agentId: string): AgentInstanceRecord | undefined {
    return this.store.listAgentInstances?.(threadId).find((row) => row.agentId === agentId);
  }

  settleRecoveredThread(input: AgentLifecycleRecoveryInput): AgentLifecycleRecoveryResult {
    const now = this.now();
    let runAttemptsSettled = 0;
    let agentInstancesSettled = 0;
    const settledRunAttemptIds: string[] = [];

    for (const attempt of input.attempts) {
      if (attempt.status !== "running") {
        continue;
      }
      this.store.upsertRunAttempt({
        ...attempt,
        status: input.runStatus,
        endedAt: attempt.endedAt ?? now,
      });
      runAttemptsSettled += 1;
      settledRunAttemptIds.push(attempt.attemptId);
    }

    for (const agent of input.agents) {
      if (agent.status !== "active" && agent.status !== "launching") {
        continue;
      }
      this.store.upsertAgentInstance({
        ...agent,
        status: "abandoned",
        endedAt: agent.endedAt ?? now,
        updatedAt: now,
      });
      agentInstancesSettled += 1;
    }

    const state = this.threads.get(input.threadId);
    if (state) {
      delete state.currentAttempt;
      delete state.currentPlannerAgentId;
      state.activeAgents.clear();
    }

    return { runAttemptsSettled, agentInstancesSettled, settledRunAttemptIds };
  }

  currentRunAttemptId(threadId: string): string | undefined {
    return this.threads.get(threadId)?.currentAttempt?.attemptId;
  }

  /**
   * Rewind/fork prunes DB rows with started_at ≥ the edited user message, which
   * also deletes the in-flight attempt started for the continuation. Re-persist
   * the lifecycle attempt (optionally retime startedAt after the replacement prompt).
   */
  rehydrateCurrentRunAttempt(threadId: string, startedAt?: string): boolean {
    const state = this.threads.get(threadId);
    const attempt = state?.currentAttempt;
    if (!attempt) {
      return false;
    }
    const now = startedAt?.trim() || this.now();
    const nextAttempt: RunAttemptRecord = {
      threadId: attempt.threadId,
      attemptId: attempt.attemptId,
      phase: attempt.phase,
      retryIndex: attempt.retryIndex,
      status: "running",
      startedAt: now,
      ...(attempt.metadata && { metadata: attempt.metadata }),
    };
    state.currentAttempt = nextAttempt;
    this.store.upsertRunAttempt(nextAttempt);
    if (state.currentPlannerAgentId) {
      this.store.upsertAgentInstance({
        threadId,
        agentId: state.currentPlannerAgentId,
        role: "main",
        kind: "main",
        status: "active",
        runAttemptId: nextAttempt.attemptId,
        startedAt: now,
        updatedAt: now,
      });
    }
    return true;
  }

  currentPlannerAgentId(threadId: string): string | undefined {
    return this.threads.get(threadId)?.currentPlannerAgentId;
  }

  activeSubagentCount(threadId: string): number {
    return this.threads.get(threadId)?.activeAgents.size ?? 0;
  }

  usageRunAttemptId(threadId: string): string | undefined {
    const state = this.threads.get(threadId);
    return state?.currentAttempt?.attemptId ?? state?.lastAttemptId;
  }

  usagePlannerAgentId(threadId: string): string | undefined {
    const state = this.threads.get(threadId);
    return state?.currentPlannerAgentId ?? state?.lastPlannerAgentId;
  }

  private upsertAgent(threadId: string, record: AgentInstanceRecord): void {
    const state = this.getOrCreateThread(threadId);
    if (record.status === "active" || record.status === "launching") {
      state.activeAgents.set(record.agentId, record);
    } else {
      state.activeAgents.delete(record.agentId);
    }
    this.store.upsertAgentInstance(record);
  }

  private getOrCreateThread(threadId: string): ThreadLifecycleState {
    let state = this.threads.get(threadId);
    if (!state) {
      state = {
        activeAgents: new Map(),
      };
      this.threads.set(threadId, state);
    }
    return state;
  }

  private now(): string {
    return this.options.now?.() ?? new Date().toISOString();
  }

  private createAttemptId(input: { threadId: string; phase: RunAttemptPhase; retryIndex: number }): string {
    if (this.options.attemptId) {
      return this.options.attemptId(input);
    }
    this.sequence += 1;
    return `attempt_${input.phase}_${input.retryIndex}_${Date.now()}_${this.sequence}`;
  }
}

function shouldApplyAgentInstanceStatus(
  from: AgentInstanceRecord["status"],
  to: "stopped" | "abandoned",
): boolean {
  if (from === to) {
    return true;
  }
  if (to === "abandoned") {
    return true;
  }
  return from === "active" || from === "launching";
}
