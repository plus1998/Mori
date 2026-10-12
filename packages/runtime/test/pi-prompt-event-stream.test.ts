import { expect, test } from "bun:test";
import { streamPiPromptEvents } from "../src/pi-prompt-event-stream";

test("Stop wakes a PI tool that emits no events and waits for its real exit", async () => {
  const controller = new AbortController();
  let finish!: () => void;
  let abortStarted!: () => void;
  const aborted = new Promise<void>((resolve) => {
    abortStarted = resolve;
  });
  const prompt = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let promptStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    promptStarted = resolve;
  });
  let unsubscribed = false;
  let settled = false;
  const run = (async () => {
    for await (const _event of streamPiPromptEvents({
      signal: controller.signal,
      subscribe: () => () => {
        unsubscribed = true;
      },
      run: () => {
        promptStarted();
        return prompt;
      },
      abort: async () => {
        abortStarted();
        await prompt;
      },
    })) {
    }
    settled = true;
  })();
  await started;
  controller.abort("cancelled by user");
  await aborted;
  expect(settled).toBe(false);
  finish();
  await run;
  expect(settled).toBe(true);
  expect(unsubscribed).toBe(true);
});

test("PI prompt events finish normally and preserve SDK failures", async () => {
  let push!: (events: readonly string[]) => void;
  let finish!: () => void;
  const work = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const events = streamPiPromptEvents({
    subscribe: (listener: typeof push) => {
      push = listener;
      return () => {};
    },
    run: () => work,
    abort: async () => {
      throw new Error("unexpected abort");
    },
  });
  const first = events.next();
  push(["tool.started", "tool.completed"]);
  expect(await first).toEqual({ done: false, value: "tool.started" });
  expect(await events.next()).toEqual({ done: false, value: "tool.completed" });
  finish();
  expect(await events.next()).toEqual({ done: true, value: { done: true, runError: undefined } });

  const error = new Error("provider failed");
  const failed = streamPiPromptEvents({
    subscribe: () => () => {},
    run: async () => {
      throw error;
    },
    abort: async () => {},
  });
  expect(await failed.next()).toEqual({ done: true, value: { done: true, runError: error } });
});
