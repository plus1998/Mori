import { describe, expect, test } from "bun:test";
import { AccountWakeBatches } from "../src/main/account-wake-batches";
import type { AccountWakeBatchInput, AccountWakeBatchState } from "../src/shared/account-wake-batch";
import type { OpenAIAccountWakeResult } from "../src/shared/openai-account";

function fixture(wake?: (id: string) => Promise<OpenAIAccountWakeResult>) {
  let now = Date.parse("2026-11-01T04:59:00+08:00");
  let stored: AccountWakeBatchState = { version: 1, batches: [] };
  let failSave = false;
  const calls: string[] = [];
  const dependencies = {
    load: () => structuredClone(stored),
    save: (state: AccountWakeBatchState) => {
      if (failSave) throw new Error("disk full");
      stored = structuredClone(state);
    },
    accounts: () => ["a", "b", "c"].map((id) => ({ id, name: `Account ${id}` })),
    wake: async (id: string) => {
      // The send must never precede its persisted account-specific claim.
      expect(
        stored.batches.some((batch) =>
          batch.lastRun?.items.some((item) => item.accountId === id && item.status === "running"),
        ),
      ).toBe(true);
      calls.push(id);
      return wake ? wake(id) : { reply: "hi" };
    },
    clock: () => now,
  };
  const service = new AccountWakeBatches(dependencies);
  const add = (overrides: Partial<AccountWakeBatchInput> = {}) => {
    const batch = service
      .save({
        name: "早班",
        time: "05:00",
        timezone: "Asia/Shanghai",
        repeat: "daily",
        accountIds: ["a", "b"],
        enabled: true,
        ...overrides,
      })
      .batches.at(-1);
    if (!batch) throw new Error("Expected a saved batch");
    return batch;
  };
  return {
    service,
    add,
    calls,
    dependencies,
    time: (value: string) => {
      now = Date.parse(value);
    },
    stored: () => structuredClone(stored),
    failSave: () => {
      failSave = true;
    },
  };
}

describe("account wake batches", () => {
  test("runs only the due batch once and advances daily in the configured time zone", async () => {
    const f = fixture();
    const early = f.add();
    f.add({ time: "06:00", accountIds: ["c"] });
    f.service.tick();
    expect(f.calls).toEqual([]);
    f.time("2026-11-01T05:00:04+08:00");
    f.service.tick();
    f.service.tick();
    await f.service.settled();
    expect(f.calls).toEqual(["a", "b"]);
    const batch = f.service.snapshot().batches.find((b) => b.id === early.id);
    if (!batch) throw new Error("Expected the early batch");
    expect(batch.lastRun?.source).toBe("scheduled");
    expect(batch.nextRunAt).toBe("2026-11-01T21:00:00.000Z");
    expect(batch.lastRun?.status).toBe("completed");
  });

  test("one-time batch disables after execution; manual runs do not move its scheduled time", async () => {
    const f = fixture();
    const batch = f.add({ repeat: "once", accountIds: ["a"] });
    f.service.run(batch.id);
    await f.service.settled();
    expect(f.service.snapshot().batches[0]?.nextRunAt).toBe(batch.nextRunAt);
    f.time("2026-11-01T05:00:01+08:00");
    f.service.tick();
    await f.service.settled();
    f.time("2026-11-02T05:00:01+08:00");
    f.service.tick();
    expect(f.calls).toEqual(["a", "a"]);
    expect(f.service.snapshot().batches[0]).toMatchObject({ enabled: false, nextRunAt: null });
  });

  test("restart skips overdue batches instead of sending a burst", async () => {
    const f = fixture();
    f.add();
    f.add({ time: "06:00", repeat: "once", accountIds: ["c"] });
    f.time("2026-11-01T13:00:00+08:00");
    const restarted = new AccountWakeBatches(f.dependencies);
    restarted.tick();
    await restarted.settled();
    expect(f.calls).toEqual([]);
    expect(restarted.snapshot().batches.map((b) => b.lastRun?.status)).toEqual(["missed", "missed"]);
    expect(restarted.snapshot().batches[0]?.nextRunAt).toBe("2026-11-01T21:00:00.000Z");
    expect(restarted.snapshot().batches[1]?.enabled).toBe(false);
  });

  test("continues after failure and retries only unfinished accounts; quota warnings remain successful", async () => {
    let failed = false;
    const f = fixture(async (id) => {
      if (id === "b" && !failed) {
        failed = true;
        throw new Error("网络连接失败");
      }
      return { reply: "hello", ...(id === "a" ? { quotaError: "额度查询超时" } : {}) };
    });
    const batch = f.add({ accountIds: ["a", "b", "c"] });
    f.service.run(batch.id);
    await f.service.settled();
    expect(f.calls).toEqual(["a", "b", "c"]);
    expect(f.service.snapshot().batches[0]?.lastRun?.items[0]).toMatchObject({
      status: "succeeded",
      quotaError: "额度查询超时",
    });
    f.service.run(batch.id, true);
    await f.service.settled();
    expect(f.calls).toEqual(["a", "b", "c", "b"]);
    expect(f.service.snapshot().batches[0]?.lastRun?.items.every((item) => item.status === "succeeded")).toBe(
      true,
    );
    expect(() => f.service.run(batch.id, true)).toThrow("没有需要重试");
  });

  test("recovers an interrupted run without automatically resending uncertain messages", async () => {
    const pending = Promise.withResolvers<OpenAIAccountWakeResult>();
    const f = fixture(() => pending.promise);
    const batch = f.add();
    f.service.run(batch.id);
    await Promise.resolve();
    expect(f.calls).toEqual(["a"]);
    const restarted = new AccountWakeBatches(f.dependencies);
    expect(restarted.snapshot().batches[0]?.lastRun).toMatchObject({
      status: "interrupted",
      items: [
        { accountId: "a", status: "unknown" },
        { accountId: "b", status: "skipped" },
      ],
    });
    restarted.tick();
    await restarted.settled();
    expect(f.calls).toEqual(["a"]);
    pending.resolve({ reply: "hi" });
    await f.service.settled();
  });

  test("retry never sends to an account removed from the batch after a failure", async () => {
    const f = fixture(async (id) => {
      if (id === "b") throw new Error("offline");
      return { reply: "hi" };
    });
    const batch = f.add();
    f.service.run(batch.id);
    await f.service.settled();
    f.service.save({ ...batch, expectedRevision: batch.revision, accountIds: ["a"] });
    expect(() => f.service.run(batch.id, true)).toThrow("没有需要重试");
    expect(f.calls).toEqual(["a", "b"]);
  });

  test("serializes batches, blocks duplicate runs/edits, and stops before remaining sends", async () => {
    const pending = Promise.withResolvers<OpenAIAccountWakeResult>();
    const f = fixture(() => pending.promise);
    const a = f.add();
    const b = f.add({ time: "06:00", accountIds: ["c"] });
    f.service.run(a.id);
    f.service.run(b.id);
    expect(() => f.service.run(a.id)).toThrow("正在执行");
    expect(() => f.service.save({ ...a, expectedRevision: a.revision })).toThrow("正在执行");
    expect(() => f.service.remove(a.id, a.revision)).toThrow("正在执行");
    await Promise.resolve();
    expect(f.calls).toEqual(["a"]);
    const stopping = f.service.stop();
    pending.resolve({ reply: "hi" });
    await stopping;
    expect(f.calls).toEqual(["a"]);
    expect(f.service.snapshot().batches[0]?.lastRun?.items[1]?.status).toBe("skipped");
    expect(f.service.snapshot().batches[1]?.lastRun?.items[0]?.status).toBe("skipped");
  });

  test("validates selection, time, timezone, and stale edits", () => {
    const f = fixture();
    expect(() => f.add({ accountIds: [] })).toThrow();
    expect(() => f.add({ accountIds: ["deleted"] })).toThrow("已被删除");
    expect(() => f.add({ time: "25:00" })).toThrow();
    expect(() => f.add({ timezone: "invalid/timezone" })).toThrow();
    const batch = f.add({ accountIds: ["a", "a"] });
    expect(batch.accountIds).toEqual(["a"]);
    f.service.save({ ...batch, expectedRevision: batch.revision, enabled: false });
    expect(() => f.service.save({ ...batch, expectedRevision: batch.revision })).toThrow("批次已更新");
    expect(() => f.service.remove(batch.id, batch.revision)).toThrow("批次已更新");
  });

  test("saving, pausing and re-enabling survive a fresh instance", () => {
    const f = fixture();
    const batch = f.add({ enabled: false });
    const fresh = new AccountWakeBatches(f.dependencies);
    expect(fresh.snapshot()).toEqual(f.service.snapshot());
    f.time("2026-11-01T06:30:00+08:00");
    const next = fresh.save({ ...batch, expectedRevision: batch.revision, enabled: true });
    expect(next.batches[0]?.nextRunAt).toBe("2026-11-01T21:00:00.000Z");
    const saved = next.batches[0];
    if (!saved) throw new Error("Expected the saved batch");
    fresh.remove(batch.id, saved.revision);
    expect(new AccountWakeBatches(f.dependencies).snapshot().batches).toEqual([]);
  });

  test("a batch can still be paused after one of its accounts has been deleted", () => {
    const f = fixture();
    const batch = f.add();
    f.dependencies.accounts = () => [{ id: "a", name: "Account a" }];
    const next = f.service.save({ ...batch, expectedRevision: batch.revision, enabled: false });
    expect(next.batches[0]?.enabled).toBe(false);
    expect(() => f.service.save({ ...batch, expectedRevision: 2, enabled: true })).toThrow("已被删除");
  });

  test("does not contact accounts if the durable claim cannot be saved", async () => {
    const f = fixture();
    const batch = f.add();
    f.failSave();
    expect(() => f.service.run(batch.id)).toThrow("disk full");
    await f.service.settled();
    f.service.tick();
    expect(f.calls).toEqual([]);
  });
});
