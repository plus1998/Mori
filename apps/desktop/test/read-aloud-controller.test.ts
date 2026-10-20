import { expect, test } from "bun:test";
import {
  ReadAloudAutoReadTracker,
  ReadAloudController,
  type ReadAloudPlayer,
  type ReadAloudTransport,
} from "../src/renderer/read-aloud-controller";

async function until(predicate: () => boolean) {
  for (let i = 0; i < 50 && !predicate(); i++) await Bun.sleep(1);
  expect(predicate()).toBe(true);
}
function fixture(overrides: Partial<ReadAloudTransport> = {}) {
  const segments: number[] = [];
  const played: number[] = [];
  const cancelled: string[] = [];
  let finish: (() => void) | undefined;
  const player: ReadAloudPlayer = {
    play: async (bytes, _mime, started) => {
      played.push(bytes[0]!);
      started();
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    },
    speak: async () => {},
    stop: () => {
      finish?.();
      finish = undefined;
    },
  };
  const transport: ReadAloudTransport = {
    startReadAloud: async (input) => ({ requestId: input.requestId, segmentCount: 3 }),
    synthesizeReadAloudSegment: async ({ index }) => {
      segments.push(index);
      return { mimeType: "audio/mpeg", totalBytes: 1 };
    },
    readReadAloudChunk: async ({ index, offset }) => ({
      offset,
      totalBytes: 1,
      chunkBytes: 1,
      mimeType: "audio/mpeg",
      dataBase64: Buffer.from([index]).toString("base64"),
    }),
    cancelReadAloud: async (id) => {
      cancelled.push(id);
    },
    ...overrides,
  };
  const controller = new ReadAloudController(() => transport, player);
  return {
    controller,
    segments,
    played,
    cancelled,
    finish: () => {
      finish?.();
      finish = undefined;
    },
  };
}
test("starts first audio without waiting for all segments and prefetches only one", async () => {
  const f = fixture();
  const playback = f.controller.speak("thread", "entry", "正文");
  await until(() => f.played.length === 1 && f.segments.length === 2);
  expect(f.played).toEqual([0]);
  expect(f.segments).toEqual([0, 1]);
  f.finish();
  await until(() => f.played.length === 2 && f.segments.length === 3);
  f.finish();
  await until(() => f.played.length === 3);
  f.finish();
  await playback;
  expect(f.played).toEqual([0, 1, 2]);
  expect(f.controller.getSnapshot().state).toBe("idle");
});
test("stop during start cancels the known ID and ignores a late response", async () => {
  let resolve!: (value: { requestId: string; segmentCount: number }) => void;
  let id = "";
  const f = fixture({
    startReadAloud: (input) => {
      id = input.requestId;
      return new Promise((done) => {
        resolve = done;
      });
    },
  });
  const playback = f.controller.speak("thread", "a", "正文");
  expect(f.controller.getSnapshot().state).toBe("preparing");
  f.controller.stop();
  expect(f.cancelled).toEqual([id]);
  resolve({ requestId: id, segmentCount: 1 });
  await playback;
  expect(f.played).toEqual([]);
  expect(f.segments).toEqual([]);
});
test("switching entries or engines cannot revive the previous audio", async () => {
  const f = fixture();
  const a = f.controller.speak("thread", "a", "第一条");
  await until(() => f.played.length === 1);
  const b = f.controller.speak("thread", "b", "第二条");
  await until(() => f.played.length === 2);
  expect(f.controller.getSnapshot().entryId).toBe("b");
  f.controller.setEngine("system");
  await Promise.all([a, b]);
  expect(f.controller.getSnapshot()).toMatchObject({ state: "idle", engine: "system" });
});
test("prefetch failure stops playback, remains visible, and does not skip ahead", async () => {
  const f = fixture({
    synthesizeReadAloudSegment: async ({ index }) => {
      if (index === 1) {
        await Bun.sleep(2);
        throw new Error("供应商限流");
      }
      return { mimeType: "audio/mpeg", totalBytes: 1 };
    },
  });
  await f.controller.speak("thread", "entry", "正文");
  expect(f.controller.getSnapshot()).toMatchObject({ state: "failed", error: "供应商限流" });
  expect(f.played).toEqual([0]);
});
test("out-of-order chunks fail visibly before playing", async () => {
  const f = fixture({
    readReadAloudChunk: async () => ({
      offset: 8,
      chunkBytes: 1,
      totalBytes: 1,
      mimeType: "audio/mpeg",
      dataBase64: "AA==",
    }),
  });
  await f.controller.speak("thread", "entry", "正文");
  expect(f.controller.getSnapshot().state).toBe("failed");
  expect(f.played).toEqual([]);
});
test("auto-read excludes history, backfill, other turns, disabled state and repeated updates", () => {
  const tracker = new ReadAloudAutoReadTracker();
  const old = { id: "old", text: "旧回复", runId: "old-run" };
  const next = { id: "next", text: "新回复", runId: "new-run" };
  expect(tracker.observe("thread", false, old, true)).toBeUndefined();
  expect(tracker.observe("thread", false, next, true)).toBeUndefined();
  tracker.observe("thread", true, undefined, true, "new-run");
  expect(tracker.observe("thread", false, old, true)).toBeUndefined();
  expect(tracker.observe("thread", false, next, true)).toBeUndefined(); // already observed before this run
  const fresh = { ...next, id: "fresh" };
  expect(tracker.observe("thread", false, fresh, true)).toEqual(fresh);
  expect(tracker.observe("thread", false, fresh, true)).toBeUndefined();
  expect(tracker.observe("other-thread", false, fresh, true)).toBeUndefined();
  tracker.observe("other-thread", true, undefined, false, "new-run");
  expect(tracker.observe("other-thread", false, fresh, true)).toBeUndefined();
});

test("auto-read handles final output while the next queued turn is running", () => {
  const tracker = new ReadAloudAutoReadTracker();
  const first = { id: "first", text: "第一条", runId: "run-1" };
  const second = { id: "second", text: "第二条", runId: "run-2" };
  tracker.observe("thread", true, undefined, true, "run-1");
  expect(tracker.observe("thread", true, first, true, "run-2")).toEqual(first);
  expect(tracker.observe("thread", true, first, true, "run-2")).toBeUndefined();
  expect(tracker.observe("thread", false, second, true)).toEqual(second);
});
