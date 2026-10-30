import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { ScheduleDefinition, ScheduleOccurrence, ScheduleOccurrenceStatus, SchedulingSnapshot } from "../shared/scheduling";
import { latestScheduleTime, nextScheduleTime } from "./schedule-time";

type JsonRow = { data: string };
const hash = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 32);

/** Same local database as conversations; scheduling transactions do not perform SDK work. */
export class SchedulingStore {
  private readonly db: DatabaseSync;
  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS schedule_definitions (
        id TEXT PRIMARY KEY, creation_key TEXT NOT NULL UNIQUE, enabled INTEGER NOT NULL,
        next_run_at TEXT, data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS schedule_due ON schedule_definitions(enabled, next_run_at);
      CREATE TABLE IF NOT EXISTS schedule_creation_receipts (creation_key TEXT PRIMARY KEY, schedule_id TEXT NOT NULL);
      INSERT OR IGNORE INTO schedule_creation_receipts SELECT creation_key, id FROM schedule_definitions;
      CREATE TABLE IF NOT EXISTS schedule_occurrences (
        id TEXT PRIMARY KEY, schedule_id TEXT NOT NULL, status TEXT NOT NULL,
        scheduled_at TEXT NOT NULL, data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS schedule_occurrence_status ON schedule_occurrences(status);
      CREATE INDEX IF NOT EXISTS schedule_occurrence_schedule ON schedule_occurrences(schedule_id, scheduled_at);
      CREATE TABLE IF NOT EXISTS schedule_agent_wakeups (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS schedule_agent_wakeup_budget ON schedule_agent_wakeups(thread_id, created_at);
    `);
  }

  close(): void { this.db.close(); }
  get(id: string): ScheduleDefinition | undefined {
    const row = this.db.prepare("SELECT data FROM schedule_definitions WHERE id = ?").get(id) as JsonRow | undefined;
    return row ? JSON.parse(row.data) : undefined;
  }
  getByCreationKey(key: string): ScheduleDefinition | undefined {
    const row = this.db.prepare("SELECT data FROM schedule_definitions WHERE creation_key = ?").get(key) as JsonRow | undefined;
    if (!row && this.db.prepare("SELECT 1 FROM schedule_creation_receipts WHERE creation_key=?").get(key)) throw new Error("该创建请求对应的项目已删除；请使用新的请求标识。");
    return row ? JSON.parse(row.data) : undefined;
  }
  list(): ScheduleDefinition[] {
    return (this.db.prepare("SELECT data FROM schedule_definitions ORDER BY rowid DESC").all() as JsonRow[]).map(row => JSON.parse(row.data));
  }
  /** Include claimed one-shots and manual runs even after their definition is paused or removed. */
  hasWorkRequiringAwake(): boolean {
    return Boolean(this.db.prepare(`
      SELECT 1 FROM schedule_definitions WHERE enabled=1 AND next_run_at IS NOT NULL
      UNION ALL
      SELECT 1 FROM schedule_occurrences WHERE status IN ('pending', 'dispatching', 'running')
      LIMIT 1
    `).get());
  }
  insert(definition: ScheduleDefinition, creationKey: string): ScheduleDefinition {
    this.transaction(() => this.insertInTransaction(this.db, definition, creationKey));
    return definition;
  }
  /** The caller owns the transaction, including creation of a new conversation. */
  insertInTransaction(db: DatabaseSync, definition: ScheduleDefinition, creationKey: string): void {
    db.prepare("INSERT INTO schedule_definitions(id, creation_key, enabled, next_run_at, data) VALUES(?,?,?,?,?)")
      .run(definition.id, creationKey, Number(definition.enabled), definition.nextRunAt, JSON.stringify(definition));
    db.prepare("INSERT INTO schedule_creation_receipts(creation_key,schedule_id) VALUES(?,?)").run(creationKey, definition.id);
    if (definition.source === "agent" && definition.kind === "session_message") db.prepare("INSERT INTO schedule_agent_wakeups(id,thread_id,created_at) VALUES(?,?,?)").run(definition.id, definition.threadId!, definition.createdAt);
  }
  save(definition: ScheduleDefinition): void {
    this.db.prepare("UPDATE schedule_definitions SET enabled=?, next_run_at=?, data=? WHERE id=?")
      .run(Number(definition.enabled), definition.nextRunAt, JSON.stringify(definition), definition.id);
  }
  snapshot(): SchedulingSnapshot {
    return { schedules: this.list(), occurrences: this.occurrences(undefined, 200) };
  }
  assistantSnapshot(threadId: string): SchedulingSnapshot {
    const schedules = this.list().filter(item => item.kind === "assistant_action" && item.threadId === threadId);
    const occurrences = (this.db.prepare(`SELECT data FROM schedule_occurrences
      WHERE json_extract(data, '$.definition.kind')='assistant_action' AND json_extract(data, '$.definition.threadId')=?
      ORDER BY scheduled_at DESC LIMIT 200`).all(threadId) as JsonRow[]).map(row => JSON.parse(row.data) as ScheduleOccurrence);
    return { schedules, occurrences: occurrences.map(item => {
      if (!item.assistant) return item;
      const { result: _result, ...receipt } = item.assistant;
      return { ...item, assistant: receipt };
    }) };
  }
  occurrences(statuses?: ScheduleOccurrenceStatus[], limit?: number): ScheduleOccurrence[] {
    const where = statuses?.length ? `WHERE status IN (${statuses.map(() => "?").join(",")})` : "";
    return (this.db.prepare(`SELECT data FROM schedule_occurrences ${where} ORDER BY scheduled_at DESC ${limit ? "LIMIT ?" : ""}`)
      .all(...(statuses ?? []), ...(limit ? [limit] : [])) as JsonRow[]).map(row => JSON.parse(row.data));
  }
  ownsTaskRun(scheduleId: string, threadId: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM schedule_occurrences WHERE schedule_id=? AND json_extract(data,'$.threadId')=? AND json_extract(data,'$.definition.kind')='scheduled_task' LIMIT 1").get(scheduleId, threadId));
  }
  saveOccurrence(occurrence: ScheduleOccurrence): void {
    this.db.prepare("INSERT INTO schedule_occurrences(id,schedule_id,status,scheduled_at,data) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,data=excluded.data")
      .run(occurrence.id, occurrence.scheduleId, occurrence.status, occurrence.scheduledAt, JSON.stringify(occurrence));
  }
  getOccurrence(id: string): ScheduleOccurrence | undefined {
    const row = this.db.prepare("SELECT data FROM schedule_occurrences WHERE id=?").get(id) as JsonRow | undefined;
    return row ? JSON.parse(row.data) : undefined;
  }
  assistantRecoveryOccurrences(): ScheduleOccurrence[] {
    return (this.db.prepare(`SELECT data FROM schedule_occurrences
      WHERE json_extract(data, '$.definition.kind')='assistant_action'
      AND (status IN ('dispatching','running','waiting_user')
        OR json_extract(data, '$.assistant.notification.status') IN ('sending','failed','unknown')
        OR (json_extract(data, '$.assistant.phase') IS NOT NULL AND json_extract(data, '$.assistant.notification') IS NULL))`)
      .all() as JsonRow[]).map(row => JSON.parse(row.data));
  }
  cancelPending(scheduleId: string, now: string): void {
    for (const occurrence of this.occurrences(["pending"])) {
      if (occurrence.scheduleId === scheduleId) this.saveOccurrence({ ...occurrence, status: "cancelled", updatedAt: now });
    }
  }
  updateDefinition(definition: ScheduleDefinition, resetPending: boolean): void {
    this.transaction(() => {
      this.save(definition);
      if (resetPending || !definition.enabled) this.cancelPending(definition.id, definition.updatedAt);
      else for (const occurrence of this.occurrences(["pending"])) {
        if (occurrence.scheduleId === definition.id) this.saveOccurrence({ ...occurrence, definition, updatedAt: definition.updatedAt });
      }
    });
  }
  remove(id: string, now: string): void {
    this.transaction(() => {
      this.cancelPending(id, now);
      this.db.prepare("DELETE FROM schedule_definitions WHERE id=?").run(id);
    });
  }

  /** Atomically consume due dates and persist their immutable execution snapshots. */
  collectDue(nowMs: number): boolean {
    const now = new Date(nowMs).toISOString();
    const rows = this.db.prepare("SELECT data FROM schedule_definitions WHERE enabled=1 AND next_run_at<=?").all(now) as JsonRow[];
    if (!rows.length) return false;
    this.transaction(() => {
      for (const row of rows) {
        const definition: ScheduleDefinition = JSON.parse(row.data);
        const scheduledAt = latestScheduleTime(definition.trigger, nowMs, definition.nextRunAt!);
        const id = `occ_${hash(`${definition.id}:${scheduledAt}`)}`;
        const existing = this.db.prepare("SELECT id FROM schedule_occurrences WHERE id=?").get(id);
        if (!existing) {
          // Replace older ticks still waiting for the same task/conversation to become available.
          for (const pending of this.occurrences(["pending"])) {
            if (pending.scheduleId === definition.id) this.saveOccurrence({ ...pending, status: "skipped", error: "已合并到最近一次触发。", updatedAt: now });
          }
          const tooLate = nowMs - Date.parse(scheduledAt) > definition.maxLatenessSeconds * 1000;
          this.saveOccurrence({
            id, scheduleId: definition.id, scheduledAt, definition,
            status: tooLate ? "skipped" : "pending",
            ...(tooLate ? { error: "已超过允许的补跑时间。" } : {}),
            createdAt: now, updatedAt: now,
          });
        }
        const nextRunAt = nextScheduleTime(definition.trigger, nowMs);
        this.save({ ...definition, nextRunAt, enabled: definition.trigger.type === "at" && nowMs - Date.parse(scheduledAt) > definition.maxLatenessSeconds * 1000 ? false : definition.enabled, updatedAt: now });
      }
    });
    return true;
  }

  runNow(definition: ScheduleDefinition, requestId: string, nowMs: number): ScheduleOccurrence {
    const id = `occ_${hash(`manual:${definition.id}:${requestId}`)}`;
    const existing = this.db.prepare("SELECT data FROM schedule_occurrences WHERE id=?").get(id) as JsonRow | undefined;
    if (existing) return JSON.parse(existing.data);
    const active = this.occurrences(["pending", "dispatching", "running", "waiting_user"])
      .filter(item => item.scheduleId === definition.id);
    if (active.some(item => item.status !== "pending" || definition.kind === "scheduled_task")) throw new Error("该项目已有等待或正在执行的运行。");
    const now = new Date(nowMs).toISOString();
    const occurrence: ScheduleOccurrence = { id, scheduleId: definition.id, scheduledAt: now, definition, status: "pending", createdAt: now, updatedAt: now };
    this.transaction(() => {
      // A due message may already be waiting for its conversation. The manual
      // send replaces that unclaimed delivery, with a fresh lateness window.
      // Keep the manual request ID as its durable receipt so retries deduplicate.
      if (definition.kind !== "scheduled_task") this.cancelPending(definition.id, now);
      this.saveOccurrence(occurrence);
      // Sending a one-shot message now consumes its planned date instead of sending twice.
      if (definition.kind !== "scheduled_task" && definition.trigger.type === "at") this.save({ ...definition, nextRunAt: null, updatedAt: now });
    });
    return occurrence;
  }

  countAgentWakeups(threadId: string, since: number): number {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM schedule_agent_wakeups WHERE thread_id=? AND created_at>=?").get(threadId, new Date(since).toISOString()) as { count: number };
    return row.count;
  }

  private transaction<T>(body: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = body(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
}

export const newScheduleId = () => `sch_${randomUUID()}`;
