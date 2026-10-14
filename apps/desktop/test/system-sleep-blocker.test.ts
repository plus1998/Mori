import { expect, test } from "bun:test";
import { type PowerSaveBlockerApi, SystemSleepBlocker } from "../src/main/system-sleep-blocker";

function createFakePowerSaveBlocker(): PowerSaveBlockerApi & {
  starts: Array<"prevent-app-suspension" | "prevent-display-sleep">;
  stops: number[];
} {
  let nextId = 1;
  const started = new Set<number>();
  const starts: Array<"prevent-app-suspension" | "prevent-display-sleep"> = [];
  const stops: number[] = [];
  return {
    starts,
    stops,
    start(type) {
      starts.push(type);
      const id = nextId++;
      started.add(id);
      return id;
    },
    stop(id) {
      stops.push(id);
      return started.delete(id);
    },
    isStarted(id) {
      return started.has(id);
    },
  };
}

test("SystemSleepBlocker starts prevent-app-suspension once while work is active", () => {
  const api = createFakePowerSaveBlocker();
  const blocker = new SystemSleepBlocker(api);

  blocker.sync(true);
  blocker.sync(true);
  expect(api.starts).toEqual(["prevent-app-suspension"]);
  expect(blocker.isBlocking).toBe(true);

  blocker.sync(false);
  blocker.sync(false);
  expect(api.stops).toEqual([1]);
  expect(blocker.isBlocking).toBe(false);
});

test("SystemSleepBlocker dispose releases an active blocker", () => {
  const api = createFakePowerSaveBlocker();
  const blocker = new SystemSleepBlocker(api);

  blocker.sync(true);
  blocker.dispose();
  blocker.sync(true);
  blocker.sync(true, { refresh: true });
  blocker.dispose();
  expect(api.stops).toEqual([1]);
  expect(api.starts).toHaveLength(1);
  expect(blocker.isBlocking).toBe(false);
});

test("SystemSleepBlocker releases before reacquiring so Electron renews the native assertion on resume", () => {
  const api = createFakePowerSaveBlocker();
  const blocker = new SystemSleepBlocker(api);
  blocker.sync(true);
  const start = api.start.bind(api);
  api.start = (type) => {
    expect(api.isStarted(1)).toBe(false);
    return start(type);
  };

  blocker.sync(true, { refresh: true });
  expect(api.starts).toEqual(["prevent-app-suspension", "prevent-app-suspension"]);
  expect(api.stops).toEqual([1]);
  expect(blocker.isBlocking).toBe(true);
});

test("SystemSleepBlocker does not acquire on an idle resume", () => {
  const api = createFakePowerSaveBlocker();
  const blocker = new SystemSleepBlocker(api);
  blocker.sync(false, { refresh: true });
  expect(api.starts).toHaveLength(0);
});

test("SystemSleepBlocker restarts after the OS drops a previous blocker id", () => {
  const api = createFakePowerSaveBlocker();
  const blocker = new SystemSleepBlocker(api);

  blocker.sync(true);
  expect(api.starts).toHaveLength(1);
  api.stop(1);
  blocker.sync(true);
  expect(api.starts).toEqual(["prevent-app-suspension", "prevent-app-suspension"]);
  expect(blocker.isBlocking).toBe(true);
});
