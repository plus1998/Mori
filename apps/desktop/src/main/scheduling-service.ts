import type {
  ScheduleCreateInput, ScheduleDefinition, ScheduleExecutionProfile, ScheduleOccurrence,
  ScheduleOccurrenceStatus, ScheduleUpdateInput,
} from "../shared/scheduling";
import { stableHash } from "@eco/shared";
import { normalizeScheduleTrigger, nextScheduleTime } from "./schedule-time";
import { normalizeSchedulingAttachments } from "./scheduling-attachments";
import { newScheduleId, SchedulingStore } from "./scheduling-store";

export interface SchedulingActor { source: "user" | "agent"; threadId?: string; wakeDelaySeconds?: number }
export interface SchedulingDeps {
  inheritProfile(threadId: string): { workspacePath: string; executionProfile: ScheduleExecutionProfile };
  validateProfile(profile: ScheduleExecutionProfile): void;
  assertThread(threadId: string): void;
  canDispatch(occurrence: ScheduleOccurrence): boolean;
  dispatch(occurrence: ScheduleOccurrence): Promise<{ threadId: string; followUpId?: string }>;
  inspect(occurrence: ScheduleOccurrence): { status: ScheduleOccurrenceStatus; error?: string };
  onChanged(): void;
  onError(error: unknown): void;
}
const requiredText = (value: string, label: string, max = 100_000) => {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`${label}不能为空，且最多 ${max} 字符。`);
  return value.trim();
};
const lateness = (value = 86400) => {
  if (!Number.isSafeInteger(value) || value < 0 || value > 86400) throw new Error("补跑窗口须为 0–86400 秒。");
  return value;
};

export class SchedulingService {
  private timer: ReturnType<typeof setInterval> | undefined;
  private ticking = false;
  private stopped = false;
  constructor(readonly store: SchedulingStore, private readonly deps: SchedulingDeps, private readonly clock = Date.now) {}

  hasWorkRequiringAwake(): boolean {
    return !this.stopped && this.store.hasWorkRequiringAwake();
  }

  create(input: ScheduleCreateInput, actor: SchedulingActor = { source: "user" }): ScheduleDefinition {
    const requestId = requiredText(input.requestId, "请求标识", 200);
    const key = `${actor.source}:${actor.threadId ?? "local"}:${requestId}`;
    const name = requiredText(input.name, "名称", 200);
    const attachments = normalizeSchedulingAttachments("attachments" in input ? input.attachments : undefined);
    if (input.kind !== "session_message" && attachments.length) throw new Error("独立任务不支持定时消息图片。");
    const prompt = attachments.length && typeof input.prompt === "string" && !input.prompt.trim()
      ? "" : requiredText(input.prompt, "指令");
    const maxLatenessSeconds = lateness(input.maxLatenessSeconds);
    const requestedTrigger = normalizeScheduleTrigger(input.trigger);
    const creationSignature = stableHash({ kind: input.kind, name, prompt, maxLatenessSeconds,
      ...(attachments.length ? { attachments } : {}),
      trigger: actor.source === "agent" && input.kind === "session_message" && actor.wakeDelaySeconds !== undefined
        ? { delaySeconds: actor.wakeDelaySeconds } : requestedTrigger,
      ...(input.kind === "session_message" ? { threadId: input.threadId } : actor.source === "user" ? { workspacePath: input.workspacePath, executionProfile: input.executionProfile } : {}),
    });
    const existing = this.store.getByCreationKey(key);
    if (existing) {
      if (existing.creationSignature !== creationSignature) throw new Error("该请求标识已用于另一份定时配置或缺少原始请求凭据。");
      return existing;
    }
    const nowMs = this.clock();
    if (this.store.list().length >= 1000) throw new Error("定时项目数量已达到 1000 个，请先删除不需要的项目。");
    const now = new Date(nowMs).toISOString();
    if (actor.wakeDelaySeconds !== undefined && (!Number.isSafeInteger(actor.wakeDelaySeconds) || actor.wakeDelaySeconds < 60 || actor.wakeDelaySeconds > 86400 || actor.source !== "agent" || input.kind !== "session_message")) throw new Error("Agent 唤醒间隔须为 60–86400 秒。");
    const trigger = actor.wakeDelaySeconds !== undefined ? { type: "at" as const, at: new Date(nowMs + actor.wakeDelaySeconds * 1000).toISOString() } : requestedTrigger;
    const nextRunAt = nextScheduleTime(trigger, nowMs);
    if (!nextRunAt) throw new Error("触发时间必须在未来。");
    let target: Pick<ScheduleDefinition, "threadId" | "workspacePath" | "executionProfile">;
    if (input.kind === "session_message") {
      this.deps.assertThread(input.threadId);
      if (actor.source === "agent") {
        if (actor.threadId !== input.threadId) throw new Error("Agent 只能唤醒当前会话。");
        if (trigger.type !== "at" || Date.parse(nextRunAt) - nowMs < 60_000 || Date.parse(nextRunAt) - nowMs > 86400_000) throw new Error("Agent 唤醒必须为 60 秒至 24 小时之间的一次性消息。");
        if (this.store.countAgentWakeups(input.threadId, nowMs - 86400_000) >= 24) throw new Error("该会话在过去 24 小时内已创建 24 次自动唤醒，请由用户安排后续消息。");
        const pendingScheduleIds = new Set(this.store.occurrences(["pending"]).map(item => item.scheduleId));
        if (this.store.list().some(item => item.source === "agent" && item.kind === "session_message" && item.threadId === input.threadId && item.enabled &&
          (item.nextRunAt !== null || pendingScheduleIds.has(item.id)))) throw new Error("该会话已有待触发的自动唤醒，请先取消或等待触发。");
      }
      target = { threadId: input.threadId };
    } else if (input.kind === "scheduled_task") {
      target = actor.source === "agent"
        ? this.deps.inheritProfile(requiredText(actor.threadId!, "来源会话"))
        : { workspacePath: requiredText(input.workspacePath, "工作目录"), executionProfile: input.executionProfile };
      this.deps.validateProfile(target.executionProfile!);
    } else throw new Error("不支持的定时类型。");
    const definition: ScheduleDefinition = {
      id: newScheduleId(), kind: input.kind, name, prompt, trigger, enabled: true, maxLatenessSeconds, creationSignature,
      ...(attachments.length ? { attachments } : {}),
      source: actor.source, ...(actor.threadId ? { originThreadId: actor.threadId } : {}), ...structuredClone(target),
      revision: 1, nextRunAt, createdAt: now, updatedAt: now,
    };
    this.store.insert(definition, key);
    this.deps.onChanged();
    return definition;
  }

  private owned(id: string, actor: SchedulingActor): ScheduleDefinition {
    const definition = this.store.get(id);
    if (!definition) throw new Error("定时项目不存在。");
    if (actor.source === "agent" && !this.canManage(definition, actor.threadId)) throw new Error("Agent 只能管理从当前会话创建的定时项目或当前运行所属的任务。");
    return definition;
  }

  canManage(definition: ScheduleDefinition, threadId?: string): boolean {
    return Boolean(threadId && (definition.originThreadId === threadId ||
      this.store.ownsTaskRun(definition.id, threadId)));
  }

  update(input: ScheduleUpdateInput, actor: SchedulingActor = { source: "user" }): ScheduleDefinition {
    const current = this.owned(input.id, actor);
    if (current.revision !== input.expectedRevision) throw new Error("配置已被修改，请刷新后重试。");
    if (actor.source === "agent" && (current.kind !== "scheduled_task" || input.executionProfile || input.workspacePath)) throw new Error("Agent 只能修改独立任务的指令、名称和时间，运行配置由用户管理。");
    if (current.kind === "session_message" && (input.executionProfile || input.workspacePath)) throw new Error("定时消息沿用目标会话配置，不能设置独立运行配置。");
    if (input.executionProfile) this.deps.validateProfile(input.executionProfile);
    if (input.enabled !== undefined && typeof input.enabled !== "boolean") throw new Error("enabled 必须为布尔值。");
    const trigger = input.trigger ? normalizeScheduleTrigger(input.trigger) : current.trigger;
    const triggerChanged = JSON.stringify(trigger) !== JSON.stringify(current.trigger);
    const now = new Date(this.clock()).toISOString();
    const enabled = input.enabled ?? current.enabled;
    const nextRunAt = triggerChanged || (enabled && !current.enabled)
      ? nextScheduleTime(trigger, this.clock()) : current.nextRunAt;
    if (enabled && !nextRunAt && (triggerChanged || !current.enabled)) throw new Error("一次性项目已到期，请设置新的未来时间。");
    const attachments = normalizeSchedulingAttachments(input.attachments ?? current.attachments);
    if (current.kind !== "session_message" && attachments.length) throw new Error("独立任务不支持定时消息图片。");
    const prompt = input.prompt ?? current.prompt;
    if (!attachments.length || prompt.trim()) requiredText(prompt, "指令");
    const { error: _error, ...clean } = current;
    const updated: ScheduleDefinition = {
      ...clean, ...(input.name !== undefined ? { name: requiredText(input.name, "名称", 200) } : {}),
      ...(input.prompt !== undefined ? { prompt: prompt.trim() } : {}),
      ...(input.attachments !== undefined ? { attachments } : {}),
      ...(input.executionProfile ? { executionProfile: structuredClone(input.executionProfile) } : {}),
      ...(input.workspacePath !== undefined ? { workspacePath: requiredText(input.workspacePath, "工作目录") } : {}),
      maxLatenessSeconds: lateness(input.maxLatenessSeconds ?? current.maxLatenessSeconds),
      trigger, enabled, nextRunAt, revision: current.revision + 1, updatedAt: now,
    };
    this.store.updateDefinition(updated, triggerChanged);
    this.deps.onChanged();
    return updated;
  }

  remove(id: string, actor: SchedulingActor = { source: "user" }): void {
    this.owned(id, actor);
    this.store.remove(id, new Date(this.clock()).toISOString());
    this.deps.onChanged();
  }

  pauseAutomaticMessages(threadId: string): void {
    const now = new Date(this.clock()).toISOString();
    for (const definition of this.store.list()) {
      if (definition.source === "agent" && definition.threadId === threadId && definition.kind === "session_message") {
        this.store.updateDefinition({ ...definition, enabled: false, revision: definition.revision + 1, updatedAt: now }, true);
      }
    }
    this.deps.onChanged();
  }
  threadDeleted(threadId: string): void {
    for (const definition of this.store.list()) if (definition.kind === "session_message" && definition.threadId === threadId) this.remove(definition.id);
  }
  runNow(id: string, requestId: string): ScheduleOccurrence {
    const definition = this.owned(id, { source: "user" });
    const occurrence = this.store.runNow(definition, requiredText(requestId, "请求标识", 200), this.clock());
    this.deps.onChanged();
    void this.tick();
    return occurrence;
  }

  start(): void {
    // A crash after SDK dispatch can have external effects. Inspect receipts; never replay blindly.
    for (const occurrence of this.store.occurrences(["dispatching", "running", "waiting_user"])) {
      const inspected = this.deps.inspect(occurrence);
      this.settle(occurrence, inspected.status, inspected.error);
    }
    this.timer = setInterval(() => void this.tick(), 1000);
    this.timer.unref();
    // Restored future schedules must acquire the sleep assertion before the first due tick.
    this.deps.onChanged();
    void this.tick();
  }
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.deps.onChanged();
  }

  async tick(): Promise<void> {
    if (this.ticking || this.stopped) return;
    this.ticking = true;
    try {
      let changed = this.store.collectDue(this.clock());
      for (const occurrence of this.store.occurrences(["running", "waiting_user"])) {
        const inspected = this.deps.inspect(occurrence);
        if (inspected.status !== occurrence.status) { this.settle(occurrence, inspected.status, inspected.error); changed = true; }
      }
      for (const occurrence of this.store.occurrences(["pending"]).reverse()) {
        if (this.stopped) break;
        if (this.clock() - Date.parse(occurrence.scheduledAt) > occurrence.definition.maxLatenessSeconds * 1000) {
          this.settle(occurrence, "skipped", "等待执行时超过了补跑窗口。"); changed = true; continue;
        }
        // One background occurrence at a time; ordinary interactive runs keep their own coordinator.
        if (this.store.occurrences(["running", "dispatching"]).length > 0) continue;
        if (this.store.occurrences(["waiting_user"]).some(item => item.scheduleId === occurrence.scheduleId)) continue;
        if (!this.deps.canDispatch(occurrence)) continue;
        const dispatching: ScheduleOccurrence = {
          ...occurrence, status: "dispatching", updatedAt: new Date(this.clock()).toISOString(),
          threadId: occurrence.definition.kind === "scheduled_task" ? `thr_${occurrence.id}` : occurrence.definition.threadId!,
        };
        this.store.saveOccurrence(dispatching);
        // Publish before awaiting dispatch: even a paused/manual one-shot must stay awake.
        this.deps.onChanged();
        try {
          if (dispatching.definition.executionProfile) this.deps.validateProfile(dispatching.definition.executionProfile);
          const receipt = await this.deps.dispatch(dispatching);
          this.store.saveOccurrence({ ...dispatching, ...receipt, status: "running", updatedAt: new Date(this.clock()).toISOString() });
          this.consumeOneShotMessage(dispatching);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          // Host validation failure is known; a partially created thread/accepted message requires inspection.
          const inspected = this.deps.inspect(dispatching);
          this.settle(dispatching, inspected.status === "running" || inspected.status === "unknown" ? "unknown" : "failed", message);
        }
        changed = true;
      }
      if (changed) this.deps.onChanged();
    } catch (error) { this.deps.onError(error); }
    finally { this.ticking = false; }
  }

  private settle(occurrence: ScheduleOccurrence, status: ScheduleOccurrenceStatus, error?: string): void {
    const { error: _oldError, ...clean } = occurrence;
    this.store.saveOccurrence({ ...clean, status, ...(error ? { error } : {}), updatedAt: new Date(this.clock()).toISOString() });
    // Recover a successful queue hand-off after a crash before definition cleanup.
    if (status === "running" || status === "completed") this.consumeOneShotMessage(occurrence);
    if (status !== "running" && status !== "dispatching" && status !== "pending" && status !== "waiting_user") {
      const definition = this.store.get(occurrence.scheduleId);
      if (definition?.trigger.type === "at" && !definition.nextRunAt) this.store.save({ ...definition, enabled: false, updatedAt: new Date(this.clock()).toISOString() });
    }
    if (status === "failed" || status === "unknown" || status === "waiting_user") {
      const definition = this.store.get(occurrence.scheduleId);
      if (definition) this.store.updateDefinition({ ...definition, enabled: false, error: error ?? "执行状态不确定，请检查关联会话后再手动执行。", updatedAt: new Date(this.clock()).toISOString() }, true);
    }
  }

  private consumeOneShotMessage(occurrence: ScheduleOccurrence): void {
    if (occurrence.definition.kind !== "session_message" || occurrence.definition.trigger.type !== "at") return;
    const current = this.store.get(occurrence.scheduleId);
    // A user may have scheduled another date while dispatch was in flight. Keep it.
    if (current?.trigger.type === "at" && !current.nextRunAt && current.trigger.at === occurrence.definition.trigger.at) {
      this.store.remove(current.id, new Date(this.clock()).toISOString());
    }
  }
}
