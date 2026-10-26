import type { DatabaseSync } from "node:sqlite";
import type {
  AccountUsageHistory,
  AccountUsageKind,
  AccountUsageQuery,
  AccountUsageTotals,
  UsageOverview,
  UsageOverviewQuery,
} from "../shared/account-usage";

export interface AccountUsageRecord {
  kind: AccountUsageKind;
  accountId: string;
  eventId: string;
  modelId: string;
  observedAt: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  reasoningTokens?: number;
  providerName?: string;
}

const FIVE_HOURS = 5 * 60 * 60 * 1_000;
const PAGE_SIZE = 32;
const SUMS = `COALESCE(SUM(input_tokens),0) AS inputTokens,
  COALESCE(SUM(output_tokens),0) AS outputTokens,
  COALESCE(SUM(cache_read_tokens),0) AS cacheReadTokens,
  COALESCE(SUM(cache_creation_tokens),0) AS cacheCreationTokens,
  COALESCE(SUM(reasoning_tokens),0) AS reasoningTokens,
  COALESCE(SUM(input_tokens+output_tokens+cache_read_tokens+cache_creation_tokens),0) AS totalTokens,
  COUNT(*) AS records, COALESCE(SUM(estimated_cost_usd),0) AS estimatedCostUsd,
  COALESCE(SUM(CASE WHEN estimated_cost_usd IS NULL THEN 1 ELSE 0 END),0) AS unpricedRecords`;

/** Independent of conversations: history survives conversation deletion and rewind. No credentials. */
export class AccountUsageStore {
  constructor(
    private readonly db: DatabaseSync,
    now = Date.now(),
  ) {
    db.exec(`PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS account_usage_settings (key TEXT PRIMARY KEY,value INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS account_usage_records (
        kind TEXT NOT NULL, account_id TEXT NOT NULL, event_id TEXT NOT NULL, model_id TEXT NOT NULL,
        observed_at INTEGER NOT NULL, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL,
        cache_read_tokens INTEGER NOT NULL, cache_creation_tokens INTEGER NOT NULL, reasoning_tokens INTEGER NOT NULL,
        estimated_cost_usd REAL, PRIMARY KEY(kind,account_id,event_id));
      CREATE INDEX IF NOT EXISTS account_usage_time ON account_usage_records(kind,account_id,observed_at);`);
    db.exec(`CREATE TABLE IF NOT EXISTS account_usage_errors (
      kind TEXT NOT NULL, account_id TEXT NOT NULL, count INTEGER NOT NULL,
      last_error TEXT NOT NULL, last_error_at INTEGER NOT NULL, PRIMARY KEY(kind,account_id));`);
    db.prepare("INSERT OR IGNORE INTO account_usage_settings VALUES ('tracking_started_at',?)").run(now);
    const columns = db.prepare("PRAGMA table_info(account_usage_records)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "provider_name"))
      db.exec("ALTER TABLE account_usage_records ADD COLUMN provider_name TEXT");
    db.exec("CREATE INDEX IF NOT EXISTS account_usage_observed ON account_usage_records(observed_at)");
  }

  append(record: AccountUsageRecord): boolean {
    if (
      !["chatgpt_login", "chatgpt_oauth", "custom_provider"].includes(record.kind) ||
      !record.accountId.trim() ||
      !record.eventId.trim() ||
      !record.modelId.trim() ||
      !Number.isSafeInteger(record.observedAt) ||
      record.observedAt < 0 ||
      ![
        record.inputTokens,
        record.outputTokens,
        record.cacheReadTokens,
        record.cacheCreationTokens,
        record.reasoningTokens ?? 0,
      ].every((value) => Number.isSafeInteger(value) && value >= 0)
    )
      throw new Error("Invalid account usage record.");
    return (
      this.db
        .prepare(`INSERT OR IGNORE INTO account_usage_records
      (kind,account_id,event_id,model_id,observed_at,input_tokens,output_tokens,cache_read_tokens,cache_creation_tokens,reasoning_tokens,provider_name)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
        .run(
          record.kind,
          record.accountId,
          record.eventId,
          record.modelId,
          record.observedAt,
          record.inputTokens,
          record.outputTokens,
          record.cacheReadTokens,
          record.cacheCreationTokens,
          record.reasoningTokens ?? 0,
          record.providerName ?? null,
        ).changes > 0
    );
  }

  setEstimatedCost(record: Pick<AccountUsageRecord, "kind" | "accountId" | "eventId">, cost: number): void {
    if (!Number.isFinite(cost) || cost < 0) throw new Error("Invalid account usage cost.");
    // Freeze the first resolved price; catalog changes must not rewrite historical costs.
    this.db
      .prepare(`UPDATE account_usage_records SET estimated_cost_usd=?
      WHERE kind=? AND account_id=? AND event_id=? AND estimated_cost_usd IS NULL`)
      .run(cost, record.kind, record.accountId, record.eventId);
  }

  recordFailure(identity: Pick<AccountUsageRecord, "kind" | "accountId">, error: string): void {
    this.db
      .prepare(`INSERT INTO account_usage_errors VALUES (?,?,1,?,?)
      ON CONFLICT(kind,account_id) DO UPDATE SET count=count+1,last_error=excluded.last_error,last_error_at=excluded.last_error_at`)
      .run(identity.kind, identity.accountId, error, Date.now());
  }

  history(query: AccountUsageQuery): AccountUsageHistory {
    if (
      !query ||
      !["chatgpt_login", "chatgpt_oauth", "custom_provider"].includes(query.kind) ||
      typeof query.accountId !== "string" ||
      !query.accountId.trim() ||
      !["5h", "day", "week", "month"].includes(query.period) ||
      (query.before !== undefined && (!Number.isSafeInteger(query.before) || query.before < 0))
    )
      throw new Error("Invalid account usage query.");
    const first = this.db
      .prepare(`SELECT MIN(observed_at) AS first FROM account_usage_records WHERE kind=? AND account_id=?`)
      .get(query.kind, query.accountId) as { first: number | null };
    const anchor = first.first ?? 0;
    const day = "date(observed_at/1000,'unixepoch','localtime')";
    const bucket =
      query.period === "5h"
        ? `(${anchor}+CAST((observed_at-${anchor})/${FIVE_HOURS} AS INTEGER)*${FIVE_HOURS})`
        : `CAST(strftime('%s',${query.period === "week" ? `date(${day},'weekday 0','-6 days')` : query.period === "month" ? `date(${day},'start of month')` : day},'utc') AS INTEGER)*1000`;
    const totals = this.db
      .prepare(`SELECT ${SUMS} FROM account_usage_records WHERE kind=? AND account_id=?`)
      .get(query.kind, query.accountId) as unknown as AccountUsageTotals;
    const rows = this.db
      .prepare(`SELECT ${bucket} AS startAt,${SUMS} FROM account_usage_records
      WHERE kind=? AND account_id=? GROUP BY startAt ${query.before === undefined ? "" : "HAVING startAt < ?"}
      ORDER BY startAt DESC LIMIT ${PAGE_SIZE + 1}`)
      .all(
        query.kind,
        query.accountId,
        ...(query.before === undefined ? [] : [query.before]),
      ) as unknown as Array<AccountUsageTotals & { startAt: number }>;
    const buckets = rows.slice(0, PAGE_SIZE).map((row) => {
      const end = new Date(row.startAt);
      if (query.period === "day") end.setDate(end.getDate() + 1);
      if (query.period === "week") end.setDate(end.getDate() + 7);
      if (query.period === "month") end.setMonth(end.getMonth() + 1);
      return { ...row, endAt: query.period === "5h" ? row.startAt + FIVE_HOURS : end.getTime() };
    });
    const lastBucket = buckets.at(-1);
    const recordingFailure = this.db
      .prepare(`SELECT count,last_error AS lastError,last_error_at AS lastErrorAt
      FROM account_usage_errors WHERE kind=? AND account_id=?`)
      .get(query.kind, query.accountId) as AccountUsageHistory["recordingFailure"];
    return {
      trackingStartedAt: (
        this.db.prepare("SELECT value FROM account_usage_settings WHERE key='tracking_started_at'").get() as {
          value: number;
        }
      ).value,
      firstUsageAt: first.first,
      totals,
      buckets,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      ...(recordingFailure ? { recordingFailure } : {}),
      ...(rows.length > PAGE_SIZE && lastBucket ? { nextBefore: lastBucket.startAt } : {}),
    };
  }

  close(): void {
    this.db.close();
  }

  overview(query: UsageOverviewQuery, now = Date.now()): UsageOverview {
    if (
      !query ||
      !["5h", "day", "week", "month", "all"].includes(query.period) ||
      (query.at !== undefined && (!Number.isSafeInteger(query.at) || query.at < 0)) ||
      [query.providerKey, query.modelId].some((v) => v !== undefined && (typeof v !== "string" || !v.trim()))
    )
      throw new Error("Invalid usage overview query.");
    const trackingStartedAt = (
      this.db.prepare("SELECT value FROM account_usage_settings WHERE key='tracking_started_at'").get() as {
        value: number;
      }
    ).value;
    const at = query.at ?? now;
    const start = new Date(at);
    start.setHours(0, 0, 0, 0);
    if (query.period === "week") start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
    if (query.period === "month") start.setDate(1);
    if (query.period === "5h")
      start.setTime(trackingStartedAt + Math.floor((at - trackingStartedAt) / FIVE_HOURS) * FIVE_HOURS);
    const end = new Date(start);
    if (query.period === "day") end.setDate(end.getDate() + 1);
    if (query.period === "week") end.setDate(end.getDate() + 7);
    if (query.period === "month") end.setMonth(end.getMonth() + 1);
    if (query.period === "5h") end.setTime(start.getTime() + FIVE_HOURS);
    const providerKey = "CASE WHEN kind='custom_provider' THEN 'provider:'||account_id ELSE kind END";
    const providerName =
      "CASE WHEN kind='custom_provider' THEN COALESCE(provider_name,account_id) WHEN kind='chatgpt_login' THEN 'ChatGPT Login' ELSE 'ChatGPT OAuth' END";
    const conditions = ["1=1"];
    const params: Array<string | number> = [];
    if (query.providerKey) {
      conditions.push(`${providerKey}=?`);
      params.push(query.providerKey);
    }
    if (query.modelId) {
      conditions.push("model_id=?");
      params.push(query.modelId);
    }
    if (query.period !== "all") {
      conditions.push("observed_at>=? AND observed_at<?");
      params.push(start.getTime(), end.getTime());
    }
    const where = conditions.join(" AND ");
    const totals = this.db
      .prepare(`SELECT ${SUMS} FROM account_usage_records WHERE ${where}`)
      .get(...params) as unknown as UsageOverview["totals"];
    const rows = this.db
      .prepare(`SELECT ${providerKey} AS providerKey,MAX(${providerName}) AS providerName,model_id AS modelId,${SUMS}
      FROM account_usage_records WHERE ${where} GROUP BY providerKey,model_id ORDER BY estimatedCostUsd DESC,totalTokens DESC,providerKey,model_id`)
      .all(...params) as unknown as UsageOverview["rows"];
    const dimensions = this.db
      .prepare(`SELECT ${providerKey} AS providerKey,MAX(${providerName}) AS providerName,model_id AS modelId
      FROM account_usage_records GROUP BY providerKey,model_id ORDER BY providerName,model_id`)
      .all() as unknown as UsageOverview["dimensions"];
    const recordingFailures = (
      this.db
        .prepare(`SELECT COALESCE(SUM(count),0) AS count FROM account_usage_errors
      ${query.providerKey ? `WHERE ${providerKey}=?` : ""}`)
        .get(...(query.providerKey ? [query.providerKey] : [])) as { count: number }
    ).count;
    return {
      trackingStartedAt,
      startAt: query.period === "all" ? null : start.getTime(),
      endAt: query.period === "all" ? null : end.getTime(),
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      totals,
      rows,
      dimensions,
      recordingFailures,
    };
  }
}
