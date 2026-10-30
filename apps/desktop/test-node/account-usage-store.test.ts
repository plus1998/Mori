import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type TestContext, test } from "node:test";
import { type AccountUsageRecord, AccountUsageStore } from "../src/main/account-usage-store";

// Node runs this suite in its own process. Bun's parallel runner shares process
// state, and its SQLite localtime does not follow a runtime TZ change. Start the
// timezone cases with TZ already set so SQLite and JavaScript use the same zone.
if (!process.versions.bun) process.env.TZ = "America/New_York";
function timezoneTest(name: string, run: (t: TestContext) => void) {
  test(
    name,
    process.versions.bun && process.env.ECO_ACCOUNT_USAGE_TZ_CHILD !== "1"
      ? () => {
          const result = spawnSync(
            process.execPath,
            ["test", fileURLToPath(import.meta.url), "--test-name-pattern", name],
            {
              env: { ...process.env, TZ: "America/New_York", ECO_ACCOUNT_USAGE_TZ_CHILD: "1" },
              encoding: "utf8",
              timeout: 30_000,
            },
          );
          assert.ifError(result.error);
          assert.equal(result.status, 0, result.stdout + result.stderr);
        }
      : run,
  );
}
const base: AccountUsageRecord = {
  kind: "chatgpt_login",
  accountId: "a",
  eventId: "one",
  modelId: "model",
  observedAt: Date.parse("2026-01-01T08:00:00Z"),
  inputTokens: 100,
  outputTokens: 20,
  cacheReadTokens: 30,
  cacheCreationTokens: 5,
  reasoningTokens: 10,
};
function fixture(t: TestContext) {
  const store = new AccountUsageStore(new DatabaseSync(":memory:"), 123);
  t.after(() => store.close());
  return store;
}

test("overview filters physical usage by provider, model and time without duplicating OAuth account rows", (t) => {
  const store = fixture(t);
  const custom = {
    ...base,
    kind: "custom_provider" as const,
    accountId: "vendor-a",
    providerName: "Vendor A",
  };
  assert.equal(store.append(custom), true);
  assert.equal(store.append(custom), false);
  store.setEstimatedCost(custom, 0.25);
  store.append({ ...custom, accountId: "vendor-b", providerName: "Vendor B", modelId: "another" });
  store.append({ ...base, kind: "chatgpt_oauth", accountId: "account-one" });
  store.append({ ...base, kind: "chatgpt_oauth", accountId: "account-two" });
  const all = store.overview({ period: "all" });
  assert.equal(all.totals.records, 4);
  assert.equal(all.rows.length, 3);
  assert.equal(all.rows.find((row) => row.providerKey === "chatgpt_oauth")?.records, 2);
  assert.equal(all.totals.totalTokens, 620);
  assert.equal(all.totals.estimatedCostUsd, 0.25);
  assert.equal(all.totals.unpricedRecords, 3);
  const filtered = store.overview({
    period: "month",
    at: base.observedAt,
    providerKey: "provider:vendor-a",
    modelId: "model",
  });
  assert.equal(filtered.totals.records, 1);
  assert.equal(filtered.rows[0]?.providerName, "Vendor A");
  assert.equal(filtered.dimensions.length, 3);
  assert.equal(
    store.overview({ period: "all", providerKey: "provider:vendor-a", modelId: "another" }).totals.records,
    0,
  );
  assert.equal(store.overview({ period: "month", at: Date.parse("2026-02-01T12:00:00Z") }).totals.records, 0);
  assert.throws(() => store.overview({ period: "invalid" as "day" }));
  assert.throws(() => store.overview({ period: "day", at: NaN }));
  assert.throws(() => store.overview({ period: "all", providerKey: " " }));
});

timezoneTest("overview uses half-open five-hour windows and local DST calendar boundaries", (t) => {
  const anchor = Date.parse("2026-03-08T00:00:00-05:00");
  const store = new AccountUsageStore(new DatabaseSync(":memory:"), anchor);
  t.after(() => store.close());
  for (const [eventId, observedAt] of [
    ["first", anchor],
    ["edge", anchor + 5 * 3600_000],
    ["next-day", anchor + 23 * 3600_000],
  ] as const)
    store.append({ ...base, eventId, observedAt });
  const five = store.overview({ period: "5h", at: anchor });
  assert.equal(five.startAt, anchor);
  assert.equal(five.endAt, anchor + 5 * 3600_000);
  assert.equal(five.totals.records, 1);
  const day = store.overview({ period: "day", at: anchor });
  assert.equal(day.startAt, anchor);
  assert.equal(day.endAt, anchor + 23 * 3600_000);
  assert.equal(day.totals.records, 2);
  const week = store.overview({ period: "week", at: anchor });
  assert.equal(week.startAt, Date.parse("2026-03-02T00:00:00-05:00"));
  assert.equal(week.endAt, Date.parse("2026-03-09T00:00:00-04:00"));
});

test("overview exposes recording gaps for the selected provider even when no records exist", (t) => {
  const store = fixture(t);
  store.recordFailure({ kind: "custom_provider", accountId: "deleted" }, "disk error");
  store.recordFailure({ kind: "chatgpt_oauth", accountId: "a" }, "write failed");
  assert.equal(store.overview({ period: "all" }).recordingFailures, 2);
  assert.equal(store.overview({ period: "all", providerKey: "provider:deleted" }).recordingFailures, 1);
  assert.equal(store.overview({ period: "all", providerKey: "chatgpt_login" }).recordingFailures, 0);
});

test("overview migrates the existing account ledger without losing prices or identity", (t) => {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE account_usage_records (
    kind TEXT NOT NULL,account_id TEXT NOT NULL,event_id TEXT NOT NULL,model_id TEXT NOT NULL,
    observed_at INTEGER NOT NULL,input_tokens INTEGER NOT NULL,output_tokens INTEGER NOT NULL,
    cache_read_tokens INTEGER NOT NULL,cache_creation_tokens INTEGER NOT NULL,reasoning_tokens INTEGER NOT NULL,
    estimated_cost_usd REAL,PRIMARY KEY(kind,account_id,event_id));
    INSERT INTO account_usage_records VALUES('chatgpt_login','old','event','gpt',100,1,2,3,4,1,0.25);`);
  const store = new AccountUsageStore(db, 200);
  t.after(() => store.close());
  const overview = store.overview({ period: "all" });
  assert.equal(overview.totals.totalTokens, 10);
  assert.equal(overview.totals.estimatedCostUsd, 0.25);
  assert.equal(overview.rows[0]?.providerName, "ChatGPT Login");
});

test("idempotent account ledger separates identity and never double-counts cached or reasoning tokens", (t) => {
  const store = fixture(t);
  assert.equal(store.append(base), true);
  assert.equal(store.append({ ...base, inputTokens: 999 }), false);
  store.setEstimatedCost(base, 0.125);
  store.setEstimatedCost(base, 9);
  store.append({ ...base, accountId: "b" });
  store.append({ ...base, kind: "chatgpt_oauth" });
  const history = store.history({ kind: base.kind, accountId: "a", period: "5h" });
  assert.equal(history.totals.records, 1);
  assert.equal(history.totals.totalTokens, 155);
  assert.equal(history.totals.reasoningTokens, 10);
  assert.equal(history.totals.estimatedCostUsd, 0.125);
  assert.equal(history.totals.unpricedRecords, 0);
  assert.equal(
    store.history({ kind: "chatgpt_oauth", accountId: "a", period: "5h" }).totals.unpricedRecords,
    1,
  );
});

test("five-hour boundaries are exclusive and independently anchored per account", (t) => {
  const store = fixture(t);
  const duration = 5 * 3600_000;
  store.append(base);
  store.append({ ...base, eventId: "before", observedAt: base.observedAt + duration - 1 });
  store.append({ ...base, eventId: "after", observedAt: base.observedAt + duration });
  store.append({ ...base, accountId: "b", observedAt: base.observedAt + 3600_000 });
  const a = store.history({ kind: base.kind, accountId: "a", period: "5h" });
  assert.deepEqual(
    a.buckets.map((b) => [b.startAt, b.endAt, b.records]),
    [
      [base.observedAt + duration, base.observedAt + 2 * duration, 1],
      [base.observedAt, base.observedAt + duration, 2],
    ],
  );
  assert.equal(
    store.history({ kind: base.kind, accountId: "b", period: "5h" }).buckets[0]?.startAt,
    base.observedAt + 3600_000,
  );
});

timezoneTest("calendar groups use local midnight, Monday weeks and month/year boundaries", (t) => {
  const store = fixture(t);
  for (const [i, date] of [
    "2026-01-04T23:59:59-05:00",
    "2026-01-05T00:00:00-05:00",
    "2026-02-01T00:00:00-05:00",
  ].entries())
    store.append({ ...base, eventId: String(i), observedAt: Date.parse(date) });
  const query = { kind: base.kind, accountId: "a" };
  assert.deepEqual(
    store.history({ ...query, period: "week" }).buckets.map((b) => b.startAt),
    [
      Date.parse("2026-01-26T00:00:00-05:00"),
      Date.parse("2026-01-05T00:00:00-05:00"),
      Date.parse("2025-12-29T00:00:00-05:00"),
    ],
  );
  assert.deepEqual(
    store.history({ ...query, period: "month" }).buckets.map((b) => [b.startAt, b.records]),
    [
      [Date.parse("2026-02-01T00:00:00-05:00"), 1],
      [Date.parse("2026-01-01T00:00:00-05:00"), 2],
    ],
  );
  assert.equal(
    store.history({ ...query, period: "day" }).buckets.at(-1)?.startAt,
    Date.parse("2026-01-04T00:00:00-05:00"),
  );
});

timezoneTest("day and week ends respect daylight saving time", (t) => {
  const store = fixture(t);
  store.append({ ...base, observedAt: Date.parse("2026-03-08T12:00:00-04:00") });
  const day = store.history({ kind: base.kind, accountId: "a", period: "day" }).buckets[0]!;
  assert.equal(day.startAt, Date.parse("2026-03-08T00:00:00-05:00"));
  assert.equal(day.endAt - day.startAt, 23 * 3600_000);
  const week = store.history({ kind: base.kind, accountId: "a", period: "week" }).buckets[0]!;
  assert.equal(week.endAt - week.startAt, 167 * 3600_000);
});

test("history paginates without overlap while totals cover the entire account", (t) => {
  const store = fixture(t);
  for (let i = 0; i < 70; i++)
    store.append({ ...base, eventId: String(i), observedAt: base.observedAt + i * 5 * 3600_000 });
  const query = { kind: base.kind, accountId: "a", period: "5h" as const };
  const first = store.history(query);
  const second = store.history({ ...query, before: first.nextBefore });
  const third = store.history({ ...query, before: second.nextBefore });
  assert.equal(first.buckets.length, 32);
  assert.equal(second.buckets.length, 32);
  assert.equal(third.buckets.length, 6);
  assert.equal(third.nextBefore, undefined);
  assert.equal(first.totals.records, 70);
  assert.equal(
    new Set([...first.buckets, ...second.buckets, ...third.buckets].map((b) => b.startAt)).size,
    70,
  );
});

test("missing pricing stays unknown, explicitly priced zero stays free", (t) => {
  const store = fixture(t);
  store.append(base);
  store.append({ ...base, eventId: "free" });
  store.setEstimatedCost({ ...base, eventId: "free" }, 0);
  const totals = store.history({ kind: base.kind, accountId: "a", period: "day" }).totals;
  assert.equal(totals.estimatedCostUsd, 0);
  assert.equal(totals.unpricedRecords, 1);
  assert.throws(() => store.setEstimatedCost(base, NaN));
  assert.throws(() => store.append({ ...base, inputTokens: -1 }));
  assert.throws(() => store.history({ kind: base.kind, accountId: "a", period: "invalid" as "day" }));
  assert.throws(() => store.history({ kind: base.kind, accountId: "a", period: "day", before: NaN }));
});

test("recording failures are visible for the affected account without altering known totals", (t) => {
  const store = fixture(t);
  store.append(base);
  store.recordFailure(base, "Invalid upstream counters");
  store.recordFailure(base, "Database write failed");
  const history = store.history({ kind: base.kind, accountId: "a", period: "day" });
  assert.equal(history.totals.records, 1);
  assert.equal(history.recordingFailure?.count, 2);
  assert.equal(history.recordingFailure?.lastError, "Database write failed");
  assert.equal(store.history({ kind: base.kind, accountId: "b", period: "day" }).recordingFailure, undefined);
});

test("history and tracking start survive database reopening and conversation deletion", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "eco-account-usage-"));
  try {
    const file = path.join(dir, "usage.sqlite");
    const db = new DatabaseSync(file);
    const store = new AccountUsageStore(db, 123);
    db.exec("CREATE TABLE conversations(id TEXT); INSERT INTO conversations VALUES ('thread');");
    store.append(base);
    store.setEstimatedCost(base, 0.25);
    db.exec("DELETE FROM conversations");
    store.close();
    const reopened = new AccountUsageStore(new DatabaseSync(file), 999);
    try {
      const history = reopened.history({ kind: base.kind, accountId: "a", period: "month" });
      assert.equal(history.trackingStartedAt, 123);
      assert.equal(history.totals.estimatedCostUsd, 0.25);
      assert.equal(history.totals.records, 1);
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
