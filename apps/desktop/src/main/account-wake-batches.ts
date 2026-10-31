import { randomUUID } from "node:crypto";
import type {
  AccountWakeBatch,
  AccountWakeBatchInput,
  AccountWakeBatchState,
  AccountWakeRun,
} from "../shared/account-wake-batch";
import type { OpenAIAccountWakeResult } from "../shared/openai-account";
import { nextScheduleTime } from "./schedule-time";

interface Dependencies {
  load(): AccountWakeBatchState;
  save(state: AccountWakeBatchState): void;
  accounts(): { id: string; name: string }[];
  wake(id: string): Promise<OpenAIAccountWakeResult>;
  changed?(): void;
  clock?(): number;
}
const retryable = new Set(["failed", "unknown", "skipped"]);

/** Durable, account-specific greetings. No conversation scheduling or global account switch. */
export class AccountWakeBatches {
  private state: AccountWakeBatchState;
  private timer: ReturnType<typeof setInterval> | undefined;
  private queue: Promise<void> = Promise.resolve();
  private stopped = false;
  private readonly clock: () => number;
  constructor(private readonly deps: Dependencies) {
    this.clock = deps.clock ?? Date.now;
    this.state = structuredClone(deps.load());
    if (this.state.version !== 1 || !Array.isArray(this.state.batches))
      throw new Error("唤醒批次数据格式无效。");
    let recovered = false;
    for (const batch of this.state.batches) {
      if (batch.lastRun?.status !== "running") continue;
      recovered = true;
      batch.lastRun.status = "interrupted";
      batch.lastRun.finishedAt = new Date(this.clock()).toISOString();
      for (const item of batch.lastRun.items) {
        if (item.status === "running") {
          item.status = "unknown";
          item.error = "上次执行中断，请确认额度后决定是否重试。";
        } else if (item.status === "pending") {
          item.status = "skipped";
          item.error = "上次执行中断，尚未发送。";
        }
      }
    }
    if (recovered) this.persist();
  }
  start(): void {
    if (this.timer || this.stopped) return;
    this.tick();
    this.timer = setInterval(() => {
      try {
        this.tick();
      } catch (error) {
        console.error("[account-wake-batches] scheduling stopped", error);
      }
    }, 5_000);
    this.timer.unref?.();
  }
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.queue;
  }
  snapshot(): AccountWakeBatchState {
    return structuredClone(this.state);
  }
  private persist(): void {
    try {
      this.deps.save(structuredClone(this.state));
    } catch (error) {
      // Never send another greeting if the durable claim/result cannot be saved.
      this.stopped = true;
      if (this.timer) clearInterval(this.timer);
      this.timer = undefined;
      throw error;
    }
    this.deps.changed?.();
  }
  private get(id: string): AccountWakeBatch {
    const batch = this.state.batches.find((row) => row.id === id);
    if (!batch) throw new Error("唤醒批次不存在。");
    return batch;
  }
  save(input: AccountWakeBatchInput): AccountWakeBatchState {
    if (this.stopped) throw new Error("账号唤醒服务已停止，请重启 Mori 后重试。");
    if (
      !input ||
      typeof input !== "object" ||
      typeof input.name !== "string" ||
      input.name.length > 80 ||
      typeof input.time !== "string" ||
      !/^([01]\d|2[0-3]):[0-5]\d$/.test(input.time) ||
      typeof input.timezone !== "string" ||
      !["daily", "once"].includes(input.repeat) ||
      typeof input.enabled !== "boolean" ||
      !Array.isArray(input.accountIds) ||
      input.accountIds.length < 1 ||
      input.accountIds.length > 1000 ||
      input.accountIds.some((id) => typeof id !== "string")
    )
      throw new Error("请填写有效时间并选择至少一个账号。");
    new Intl.DateTimeFormat("en", { timeZone: input.timezone }).format();
    const ids = [...new Set(input.accountIds)];
    const current = input.id ? this.get(input.id) : undefined;
    const available = new Set(this.deps.accounts().map((a) => a.id));
    if (ids.some((id) => !available.has(id) && (input.enabled || !current?.accountIds.includes(id))))
      throw new Error("所选账号已被删除，请重新选择。");
    if (current?.lastRun?.status === "running") throw new Error("此批次正在执行，请结束后再编辑。");
    if (current && input.expectedRevision !== current.revision)
      throw new Error("批次已更新，请重新打开后编辑。");
    if (!current && this.state.batches.length >= 100) throw new Error("最多可保存 100 个唤醒批次。");
    const sameTiming =
      current &&
      current.time === input.time &&
      current.timezone === input.timezone &&
      current.repeat === input.repeat;
    const nextRunAt =
      sameTiming && (!input.enabled || current.enabled)
        ? current.nextRunAt
        : this.next(input.time, input.timezone);
    if (input.enabled && !nextRunAt) throw new Error("此一次性批次已结束，请重新选择执行时间。");
    const batch: AccountWakeBatch = {
      id: current?.id ?? `awb_${randomUUID()}`,
      revision: (current?.revision ?? 0) + 1,
      name: input.name.trim() || `${input.time} 批次`,
      time: input.time,
      timezone: input.timezone,
      repeat: input.repeat,
      accountIds: ids,
      enabled: input.enabled,
      nextRunAt,
      ...(current?.lastRun ? { lastRun: current.lastRun } : {}),
    };
    this.state.batches = current
      ? this.state.batches.map((b) => (b.id === current.id ? batch : b))
      : [...this.state.batches, batch];
    this.persist();
    return this.snapshot();
  }
  remove(id: string, expectedRevision: number): AccountWakeBatchState {
    const batch = this.get(id);
    if (batch.lastRun?.status === "running") throw new Error("正在执行的批次不能删除。");
    if (batch.revision !== expectedRevision) throw new Error("批次已更新，请刷新后重试。");
    this.state.batches = this.state.batches.filter((b) => b.id !== id);
    this.persist();
    return this.snapshot();
  }
  private next(time: string, timezone: string): string {
    const [hour, minute] = time.split(":").map(Number);
    const next = nextScheduleTime(
      { type: "cron", expression: `${minute} ${hour} * * *`, timezone },
      this.clock(),
    );
    if (!next) throw new Error("无法计算下次唤醒时间。");
    return next;
  }
  tick(): void {
    if (this.stopped) return;
    const now = this.clock();
    for (const batch of this.state.batches) {
      if (!batch.enabled || !batch.nextRunAt || Date.parse(batch.nextRunAt) > now) continue;
      const due = batch.nextRunAt;
      batch.nextRunAt = batch.repeat === "daily" ? this.next(batch.time, batch.timezone) : null;
      if (batch.repeat === "once") batch.enabled = false;
      if (batch.lastRun?.status === "running") {
        this.persist();
        continue;
      }
      if (now - Date.parse(due) > 60_000) {
        batch.lastRun = {
          id: randomUUID(),
          source: "scheduled",
          scheduledAt: due,
          startedAt: new Date(now).toISOString(),
          status: "missed",
          items: [],
        };
        this.persist();
      } else this.run(batch.id, false, due);
    }
  }
  run(id: string, retry = false, scheduledAt?: string): AccountWakeBatchState {
    if (this.stopped) throw new Error("账号服务正在关闭。");
    const batch = this.get(id);
    if (batch.lastRun?.status === "running") throw new Error("此批次正在执行。");
    const names = new Map(this.deps.accounts().map((a) => [a.id, a.name]));
    const selected = new Set(batch.accountIds);
    if (
      retry &&
      !batch.lastRun?.items.some((item) => selected.has(item.accountId) && retryable.has(item.status))
    )
      throw new Error("没有需要重试的账号。");
    const items =
      retry && batch.lastRun
        ? batch.lastRun.items
            .filter((item) => selected.has(item.accountId))
            .map((item) =>
              retryable.has(item.status)
                ? {
                    accountId: item.accountId,
                    name: names.get(item.accountId) ?? item.name,
                    status: "pending" as const,
                  }
                : structuredClone(item),
            )
        : batch.accountIds.map((accountId) => ({
            accountId,
            name: names.get(accountId) ?? accountId,
            status: "pending" as const,
          }));
    const now = new Date(this.clock()).toISOString();
    const run: AccountWakeRun = {
      id: randomUUID(),
      source: scheduledAt ? "scheduled" : retry ? "retry" : "manual",
      scheduledAt: scheduledAt ?? now,
      startedAt: now,
      status: "running",
      items,
    };
    batch.lastRun = run;
    // Persist the claim before sending. A restart never automatically resends an uncertain greeting.
    this.persist();
    this.queue = this.queue
      .then(async () => {
        for (const item of run.items) {
          if (item.status !== "pending") continue;
          if (this.stopped) {
            item.status = "skipped";
            item.error = "服务已停止，尚未发送。";
            continue;
          }
          item.status = "running";
          this.persist();
          try {
            const result = await this.deps.wake(item.accountId);
            item.status = "succeeded";
            if (result.quotaError) item.quotaError = result.quotaError;
          } catch (error) {
            item.status = "failed";
            item.error = error instanceof Error ? error.message : String(error);
          }
          this.persist();
        }
        run.status = this.stopped ? "interrupted" : "completed";
        run.finishedAt = new Date(this.clock()).toISOString();
        this.persist();
      })
      .catch((error) => {
        console.error("[account-wake-batches] execution stopped", error);
        run.status = "interrupted";
        for (const item of run.items) {
          if (item.status === "running") item.status = "unknown";
          else if (item.status === "pending") item.status = "skipped";
        }
        run.finishedAt = new Date(this.clock()).toISOString();
        try {
          this.persist();
        } catch (saveError) {
          console.error("[account-wake-batches] could not save interrupted run", saveError);
        }
      });
    return this.snapshot();
  }
  async settled(): Promise<void> {
    await this.queue;
  }
}
