import { expect, test } from "bun:test";
import {
  ThreadRunPreparationCancelled,
  ThreadRunPreparationRegistry,
} from "../src/main/thread-run-preparation";
import { ThreadFollowUpDrainScheduler } from "../src/main/thread-follow-up-drain-scheduler";
import { ThreadFollowUpQueueControl } from "../src/main/thread-follow-up-queue-control";

test("Pause then Resume during queue preparation cancels the old start and retries exactly once", async () => {
  const registry = new ThreadRunPreparationRegistry();
  const scheduler = new ThreadFollowUpDrainScheduler();
  const control = new ThreadFollowUpQueueControl();
  let release!: () => void;
  let enter!: () => void;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  let starts = 0;
  let calls = 0;
  let paused = false;
  const drain = () => registry.prepare("thread", async (signal) => {
    const revision = control.revision("thread");
    calls += 1;
    try {
      if (calls === 1) { enter(); await waiting; }
      signal.throwIfAborted();
      if (!paused) starts += 1;
    } catch (error) {
      if (!(error instanceof ThreadRunPreparationCancelled)) throw error;
      if (control.revision("thread") === revision) paused = true;
    }
  });
  const first = scheduler.drain("thread", drain);
  await entered;
  control.changed("thread");
  paused = true;
  registry.cancel("thread");
  control.changed("thread");
  paused = false;
  const resumed = scheduler.drain("thread", drain);
  release();
  await Promise.all([first, resumed]);
  expect(paused).toBe(false);
  expect(calls).toBe(2);
  expect(starts).toBe(1);
});

test("Stop revokes a continuation awaiting workspace/SDK preparation before it starts a run", async () => {
  const registry = new ThreadRunPreparationRegistry();
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started = false;
  const continuation = registry.prepare("thread", async (signal) => {
    await ready;
    signal.throwIfAborted();
    started = true;
  });
  expect(registry.cancel("thread")).toBe(true);
  release();
  await expect(continuation).rejects.toBeInstanceOf(ThreadRunPreparationCancelled);
  expect(started).toBe(false);
  expect(registry.cancel("thread")).toBe(false);
});

test("Stop revokes all pending starts for one thread and permits a later explicit continuation", async () => {
  const registry = new ThreadRunPreparationRegistry();
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  const prepare = (id: string) =>
    registry.prepare(id, async (signal) => {
      await ready;
      return signal.aborted;
    });
  const first = prepare("a");
  const second = prepare("a");
  const other = prepare("b");
  registry.cancel("a");
  release();
  expect(await Promise.all([first, second, other])).toEqual([true, true, false]);
  expect(await registry.prepare("a", async (signal) => signal.aborted)).toBe(false);
});
