import { expect, test } from "bun:test";
import {
  ThreadRunPreparationCancelled,
  ThreadRunPreparationRegistry,
} from "../src/main/thread-run-preparation";

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
