import { createHash } from "node:crypto";
import type { ThreadForkFromMessageRequest, ThreadForkFromMessageResult, ThreadSummary } from "../shared/ipc";
import type { ConversationForkHistory } from "./conversation-fork-history";
import type { NativeConversationFork } from "./conversation-native-fork";
import type { ConversationStore } from "./conversation-store";

export interface ConversationForkCommandDeps {
  store: ConversationStore;
  ensureThreadRuntimeConfig: (thread: ThreadSummary) => ThreadSummary;
  prepareHistory?: (thread: ThreadSummary, history: ConversationForkHistory) => Promise<void>;
  forkNative: (
    thread: ThreadSummary,
    history: ConversationForkHistory,
    childThreadId: string,
    onCreated: (result: NativeConversationFork) => void,
  ) => Promise<NativeConversationFork>;
  cleanupNative: (result: NativeConversationFork) => Promise<void>;
  hasActiveRun?: (threadId: string) => boolean;
  validateRecoveredNative?: (native: NativeConversationFork) => void;
}

/** Serialize duplicate requests; the durable receipt also covers lost responses and restarts. */
export class ConversationForkCommands {
  private readonly pending = new Map<string, Promise<ThreadForkFromMessageResult>>();
  constructor(private readonly deps: ConversationForkCommandDeps) {}

  execute(request: ThreadForkFromMessageRequest): Promise<ThreadForkFromMessageResult> {
    const key = JSON.stringify([request.principalId, request.threadId, request.clientCommandId]);
    const existing = this.pending.get(key);
    if (existing) {
      // Still validate idempotency when a different node reuses the same command id.
      this.accept(request);
      return existing;
    }
    const result = this.run(request).finally(() => this.pending.delete(key));
    this.pending.set(key, result);
    return result;
  }

  private accept(request: ThreadForkFromMessageRequest) {
    return this.deps.store.conversationV2().acceptCommand({
      principalId: request.principalId,
      conversationId: request.threadId,
      clientCommandId: request.clientCommandId,
      commandType: "history.branch",
      expectedHistoryRevision: request.expectedHistoryRevision,
      request: { activityLineId: request.activityLineId },
    });
  }

  private async run(request: ThreadForkFromMessageRequest): Promise<ThreadForkFromMessageResult> {
    const { store } = this.deps;
    const v2 = store.conversationV2();
    const accepted = this.accept(request);
    if (accepted.status === "completed") return accepted.result as ThreadForkFromMessageResult;
    if (accepted.status === "failed") throw new Error(`会话分叉失败：${JSON.stringify(accepted.error)}`);
    if (accepted.status === "running") {
      // A provider RPC is not transactional with SQLite. Never blindly create another native branch.
      throw new Error("该分叉请求尚未完成；请等待恢复结果，不要重复创建原生分支。");
    }
    const claim = v2.beginCommandExecution(request.principalId, request.threadId, request.clientCommandId);
    if (!claim.acquired) throw new Error("分叉请求正在执行。");
    let created: NativeConversationFork | undefined;
    let requested = false;
    try {
      const source = store.getThread(request.threadId);
      if (!source || !["claude", "codex", "pi"].includes(source.coreKind ?? ""))
        throw new Error("该 Harness 暂不支持原生会话分叉。");
      if (source.status === "running" || source.status === "queued" || this.deps.hasActiveRun?.(source.id))
        throw new Error("请等待当前执行结束后再分叉。");
      const thread = this.deps.ensureThreadRuntimeConfig(source);
      const history = v2.snapshotForkHistory(
        source.id,
        request.activityLineId,
        store.listConversationRuntimeSources(source.id, { historyOrder: true }),
      );
      if (this.deps.prepareHistory) await this.deps.prepareHistory(thread, history);
      if (v2.head(source.id).lastSeq !== history.sourceHeadSeq)
        throw new Error("源历史在准备分叉期间已变化，请刷新后重试。");
      const childThreadId = `thr_fork_${createHash("sha256")
        .update(JSON.stringify([request.principalId, source.id, request.clientCommandId]))
        .digest("hex")
        .slice(0, 24)}`;
      v2.recordCommandCheckpoint(request.principalId, source.id, request.clientCommandId, "fork.prepared", {
        thread,
        history,
        childThreadId,
      });
      v2.recordCommandCheckpoint(request.principalId, source.id, request.clientCommandId, "fork.requested", {
        childThreadId,
      });
      requested = true;
      const native = await this.deps.forkNative(thread, history, childThreadId, (result) => {
        created = result;
        v2.recordCommandCheckpoint(request.principalId, source.id, request.clientCommandId, "fork.created", {
          native: result,
        });
      });
      created = native;
      // The first checkpoint captures the new identity immediately; validation may enrich userIds.
      v2.appendRuntime({
        conversationId: source.id,
        eventId: `fork_verified_${childThreadId}`,
        sourceEventKey: `fork:verified:${childThreadId}`,
        type: "noop",
        occurredAt: new Date().toISOString(),
        payload: { reason: "history.fork_verified", native, childThreadId },
      });
      history.sourceHeadSeq += 1;
      return store.commitForkConversation({
        source: thread,
        history,
        childThreadId,
        native,
        principalId: request.principalId,
        clientCommandId: request.clientCommandId,
      });
    } catch (error) {
      const completed = v2.getCommandJob(request.principalId, request.threadId, request.clientCommandId);
      if (completed?.status === "completed") return completed.result as ThreadForkFromMessageResult;
      let cleanupError: string | undefined;
      if (created) {
        try {
          await this.deps.cleanupNative(created);
        } catch (failure) {
          cleanupError = failure instanceof Error ? failure.message : String(failure);
        }
      }
      v2.failCommand(request.principalId, request.threadId, request.clientCommandId, {
        code: requested && !created ? "fork_outcome_unknown" : "fork_failed",
        message: error instanceof Error ? error.message : String(error),
        ...(created ? { orphan: created } : {}),
        ...(cleanupError ? { cleanupError } : {}),
      });
      if (cleanupError)
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}；原生分支清理失败：${cleanupError}`,
        );
      throw error;
    }
  }

  /** Recover only a durably validated native result; unknown RPC outcomes fail explicitly. */
  recover(): void {
    const v2 = this.deps.store.conversationV2();
    for (const job of v2.listRecoverableCommandJobs().filter((job) => job.commandType === "history.branch")) {
      if (job.status === "accepted") {
        v2.beginCommandExecution(job.principalId, job.conversationId, job.clientCommandId);
        v2.failCommand(job.principalId, job.conversationId, job.clientCommandId, {
          code: "fork_not_started",
          message: "分叉请求在创建原生分支之前中断。",
        });
        continue;
      }
      const prepared = job.checkpoints.find((checkpoint) => checkpoint.name === "fork.prepared")?.payload;
      // Recovery is driven by the durable fork verification fact, not SDK calls or reconstructed text.
      const fact = this.deps.store.getForkVerification(
        job.conversationId,
        typeof prepared?.childThreadId === "string" ? prepared.childThreadId : "",
      );
      try {
        if (!prepared || !fact)
          throw new Error("分叉在原生请求或验证过程中中断，无法确认结果；未重新创建分支。");
        this.deps.validateRecoveredNative?.(fact);
        const history = prepared.history as unknown as ConversationForkHistory;
        this.deps.store.commitForkConversation({
          source: prepared.thread as unknown as ThreadSummary,
          history: { ...history, sourceHeadSeq: history.sourceHeadSeq + 1 },
          childThreadId: prepared.childThreadId as string,
          native: fact,
          principalId: job.principalId,
          clientCommandId: job.clientCommandId,
        });
      } catch (error) {
        v2.failCommand(job.principalId, job.conversationId, job.clientCommandId, {
          code: "fork_recovery_failed",
          message: error instanceof Error ? error.message : String(error),
          orphan: job.checkpoints.find((checkpoint) => checkpoint.name === "fork.created")?.payload.native,
        });
      }
    }
  }
}
