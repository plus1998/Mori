import { describe, expect, test } from "bun:test";
import { DisplayControl } from "../src/main/display-control";
import { displayLevelsAreMinimum, type DisplayInfo, type DisplayLevels } from "../src/main/display-native";

interface Monitor extends DisplayInfo {
  levels: DisplayLevels;
  unsupported?: boolean;
  failDim?: boolean;
  failRestore?: boolean;
}

test("Windows async writes serialize toggles and finish restoring before disposal", async () => {
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let value = 0.7;
  let closed = false;
  const events: string[] = [];
  const controller = new DisplayControl("win32", undefined, () => ({
    async displays() {
      return [{ id: 1, key: "pnp:internal", name: "Internal", internal: true }];
    },
    async get() {
      return { method: "backlight", value };
    },
    async set(_id, levels) {
      if (levels.method !== "backlight") throw new Error("unexpected method");
      if (levels.value === 0) {
        enter();
        await gate;
      }
      value = levels.value;
      events.push(`write:${value}`);
    },
    dispose() {
      closed = true;
      events.push("closed");
    },
  }));
  const enabled = controller.toggle("dimmed");
  await entered;
  const disabled = controller.toggle("dimmed");
  const disposing = controller.dispose();
  expect(closed).toBe(false);
  release();
  expect((await enabled).dimmed).toBe(true);
  expect((await disabled).dimmed).toBe(false);
  await disposing;
  expect(events).toEqual(["write:0", "write:0.7", "closed"]);
  expect(value).toBe(0.7);
  await expect(controller.toggle("dimmed")).rejects.toThrow("closing");
});

function monitor(id: number, method: "backlight" | "software" = "backlight", value = 0.7): Monitor {
  return {
    id,
    key: `uuid-${id}`,
    name: `Display ${id}`,
    internal: id === 1,
    levels:
      method === "backlight"
        ? { method, value }
        : {
            method,
            red: new Float32Array([0, value, 1]),
            green: new Float32Array([0, value / 2, 0.9]),
            blue: new Float32Array([0, value / 3, 0.8]),
          },
  };
}

function clone(levels: DisplayLevels): DisplayLevels {
  return levels.method === "backlight"
    ? { ...levels }
    : {
        method: "software",
        red: levels.red.slice(),
        green: levels.green.slice(),
        blue: levels.blue.slice(),
      };
}

function createFixture(
  options: { activityFails?: boolean; brightnessFails?: boolean; shortcutFails?: boolean } = {},
  initial = [monitor(1)],
  platform: NodeJS.Platform = "darwin",
) {
  let monitors = initial;
  let refreshes = 0,
    releases = 0,
    registered = 0,
    unregistered = 0;
  const writes: number[] = [];
  const byId = (id: number) => {
    const display = monitors.find((display) => display.id === id);
    if (!display || display.unsupported) throw new Error(`display ${id} unavailable`);
    return display;
  };
  const controller = new DisplayControl(
    platform,
    () => ({
      refresh() {
        refreshes++;
        if (options.activityFails) throw new Error("activity denied");
      },
      release() {
        releases++;
      },
    }),
    () => {
      if (options.brightnessFails) throw new Error("brightness unavailable");
      return {
        displays: () => monitors.map(({ id, key, name, internal }) => ({ id, key, name, internal })),
        get: (id: number) => clone(byId(id).levels),
        set(id: number, value: DisplayLevels) {
          const display = byId(id);
          writes.push(id);
          if (displayLevelsAreMinimum(value) && display.failDim) {
            display.failDim = false;
            // Native failure can leave the monitor partly changed.
            display.levels = { method: "backlight", value: 0.1 };
            throw new Error("dimming write failed");
          }
          if (!displayLevelsAreMinimum(value) && display.failRestore) throw new Error("restoration failed");
          display.levels = clone(value);
        },
      };
    },
    {
      register() {
        if (options.shortcutFails) throw new Error("shortcut unavailable");
        registered++;
      },
      unregister() {
        unregistered++;
      },
    },
  );
  return {
    controller,
    writes,
    connected: (next: Monitor[]) => {
      monitors = next;
    },
    refreshes: () => refreshes,
    releases: () => releases,
    registered: () => registered,
    unregistered: () => unregistered,
  };
}

async function enabled(controller: DisplayControl, value = true) {
  return controller.set({ control: "dimmed", enabled: value });
}

for (const platform of ["darwin", "win32"] as const) {
  describe(`display controls on ${platform}`, () => {
    const fixture = (options: Parameters<typeof createFixture>[0] = {}, initial = [monitor(1)]) =>
      createFixture(options, initial, platform);
    test("shortcut toggles use the existing lock and brightness recovery paths", async () => {
      const display = monitor(1);
      const f = fixture({}, [display]);
      try {
        expect((await f.controller.toggle("preventAutoLock")).preventAutoLock).toBe(true);
        expect((await f.controller.toggle("preventAutoLock")).preventAutoLock).toBe(false);
        expect((await f.controller.toggle("dimmed")).dimmed).toBe(true);
        expect(displayLevelsAreMinimum(display.levels)).toBe(true);
        expect(f.registered()).toBe(1);
        expect((await f.controller.toggle("dimmed")).dimmed).toBe(false);
        expect(display.levels).toEqual({ method: "backlight", value: 0.7 });
        expect(f.unregistered()).toBe(1);
      } finally {
        await f.controller.dispose();
      }
    });

    test("independent controls release assertions and restore all display profiles on quit", async () => {
      const internal = monitor(1),
        external = monitor(2, "software"),
        appleExternal = monitor(3, "backlight", 0.4);
      const originalGamma = clone(external.levels);
      const f = fixture({}, [internal, external, appleExternal]);
      try {
        await f.controller.set({ control: "preventAutoLock", enabled: true });
        const state = await enabled(f.controller);
        expect(state.displays.map((d) => d.status)).toEqual(["dimmed", "dimmed", "dimmed"]);
        expect(state.displays.map((d) => d.method)).toEqual(["backlight", "software", "backlight"]);
        expect([internal, external, appleExternal].every((d) => displayLevelsAreMinimum(d.levels))).toBe(
          true,
        );
        expect(f.registered()).toBe(1);
      } finally {
        await f.controller.dispose();
      }
      expect(internal.levels).toEqual({ method: "backlight", value: 0.7 });
      expect(appleExternal.levels).toEqual({ method: "backlight", value: 0.4 });
      expect(external.levels).toEqual(originalGamma);
      expect(f.releases()).toBe(1);
      expect(f.unregistered()).toBe(1);
    });

    test("repeated activation preserves each original brightness", async () => {
      const d = monitor(1),
        f = fixture({}, [d]);
      try {
        await enabled(f.controller);
        await enabled(f.controller);
        expect(f.registered()).toBe(1);
        await enabled(f.controller, false);
        expect(d.levels).toEqual({ method: "backlight", value: 0.7 });
      } finally {
        await f.controller.dispose();
      }
    });

    test("brightness up on one display restores the group and preserves its manual value", async () => {
      const internal = monitor(1),
        external = monitor(2, "software"),
        original = clone(external.levels);
      const f = fixture({}, [internal, external]);
      try {
        await enabled(f.controller);
        internal.levels = { method: "backlight", value: 0.2 };
        await f.controller.refresh();
        expect((await f.controller.getState()).dimmed).toBe(false);
        expect(internal.levels).toEqual({ method: "backlight", value: 0.2 });
        expect(external.levels).toEqual(original);
        expect(f.unregistered()).toBe(1);
      } finally {
        await f.controller.dispose();
      }
    });

    test("disabling before polling preserves a manual brightness change", async () => {
      const d = monitor(1),
        f = fixture({}, [d]);
      try {
        await enabled(f.controller);
        d.levels = { method: "backlight", value: 0.4 };
        await enabled(f.controller, false);
        expect(d.levels).toEqual({ method: "backlight", value: 0.4 });
      } finally {
        await f.controller.dispose();
      }
    });

    test("unsupported displays remain visible and are never reported as dimmed", async () => {
      const unsupported = { ...monitor(2), unsupported: true },
        f = fixture({}, [monitor(1), unsupported]);
      try {
        const state = await enabled(f.controller);
        expect(state.displays[1]).toMatchObject({
          id: 2,
          status: "unsupported",
          error: "Error: display 2 unavailable",
        });
        expect(f.writes).toEqual([1]);
      } finally {
        await f.controller.dispose();
      }
    });

    test("no supported screens never registers a shortcut or changes any screen", async () => {
      const f = fixture({}, [{ ...monitor(2), unsupported: true }]);
      await expect(enabled(f.controller)).rejects.toThrow("No display supports");
      expect(f.registered()).toBe(0);
      expect(f.writes).toEqual([]);
      await f.controller.dispose();
    });

    test("failed recovery shortcut registration prevents all dimming", async () => {
      const f = fixture({ shortcutFails: true });
      await expect(enabled(f.controller)).rejects.toThrow("shortcut unavailable");
      expect(f.writes).toEqual([]);
      expect((await f.controller.getState()).dimmed).toBe(false);
      await f.controller.dispose();
    });

    test("activation failure rolls back earlier screens and a partially changed screen", async () => {
      const first = monitor(1),
        second = { ...monitor(2), failDim: true },
        f = fixture({}, [first, second]);
      try {
        await expect(enabled(f.controller)).rejects.toThrow("dimming write failed");
        expect(first.levels).toEqual({ method: "backlight", value: 0.7 });
        expect(second.levels).toEqual({ method: "backlight", value: 0.7 });
        expect(await f.controller.getState()).toMatchObject({ dimmed: false, pendingRestores: 0 });
        expect(f.unregistered()).toBe(1);
      } finally {
        await f.controller.dispose();
      }
    });

    test("a failed restore does not prevent other screens from being restored; retry retains the original", async () => {
      const first = monitor(1),
        second = { ...monitor(2), failRestore: true },
        f = fixture({}, [first, second]);
      try {
        await enabled(f.controller);
        await expect(enabled(f.controller, false)).rejects.toThrow("restoration failed");
        expect(first.levels).toEqual({ method: "backlight", value: 0.7 });
        expect((await f.controller.getState()).pendingRestores).toBe(1);
        expect(f.unregistered()).toBe(0);
        second.failRestore = false;
        await f.controller.refresh();
        expect(second.levels).toEqual({ method: "backlight", value: 0.7 });
        expect((await f.controller.getState()).pendingRestores).toBe(0);
        expect(f.unregistered()).toBe(1);
      } finally {
        await f.controller.dispose();
      }
    });

    test("hot-plugged screens join active dimming", async () => {
      const first = monitor(1),
        second = monitor(2, "software"),
        original = clone(second.levels),
        f = fixture({}, [first]);
      try {
        await enabled(f.controller);
        f.connected([first, second]);
        await f.controller.refresh();
        expect(displayLevelsAreMinimum(second.levels)).toBe(true);
        await enabled(f.controller, false);
        expect(second.levels).toEqual(original);
      } finally {
        await f.controller.dispose();
      }
    });

    test("failed quit restoration keeps recovery available for retry", async () => {
      const display = { ...monitor(1), failRestore: true };
      const f = fixture({}, [display]);
      await enabled(f.controller);
      await expect(f.controller.dispose()).rejects.toThrow("restoration failed");
      try {
        expect((await f.controller.getState()).pendingRestores).toBe(1);
        expect(f.unregistered()).toBe(0);
        display.failRestore = false;
        await enabled(f.controller, false);
        expect(display.levels).toEqual({ method: "backlight", value: 0.7 });
        expect(f.unregistered()).toBe(1);
      } finally {
        await f.controller.dispose();
      }
    });

    test("disconnected screens restore on reconnect by UUID, never by a reused numeric id", async () => {
      const first = monitor(1),
        second = monitor(2, "software"),
        original = clone(second.levels),
        f = fixture({}, [first, second]);
      try {
        await enabled(f.controller);
        const unrelated = { ...monitor(2), key: "unrelated" };
        f.connected([first, unrelated]);
        await enabled(f.controller, false);
        expect(unrelated.levels).toEqual({ method: "backlight", value: 0.7 });
        expect((await f.controller.getState()).pendingRestores).toBe(1);
        second.id = 8;
        f.connected([first, unrelated, second]);
        await f.controller.refresh();
        expect(second.levels).toEqual(original);
        expect((await f.controller.getState()).pendingRestores).toBe(0);
      } finally {
        await f.controller.dispose();
      }
    });

    test("renewal failure reports the error and releases the assertion", async () => {
      const options = { activityFails: false },
        f = fixture(options);
      try {
        await f.controller.set({ control: "preventAutoLock", enabled: true });
        options.activityFails = true;
        await f.controller.refresh();
        expect(await f.controller.getState()).toMatchObject({
          preventAutoLock: false,
          error: "Error: activity denied",
        });
        expect(f.releases()).toBe(1);
      } finally {
        await f.controller.dispose();
      }
    });

    test("failure to keep active releases the newly created assertion", async () => {
      const f = fixture({ activityFails: true });
      await expect(f.controller.set({ control: "preventAutoLock", enabled: true })).rejects.toThrow(
        "activity denied",
      );
      expect(f.releases()).toBe(1);
      expect((await f.controller.getState()).preventAutoLock).toBe(false);
      await f.controller.dispose();
    });

    test("brightness API failures do not disable the independent lock control", async () => {
      const f = fixture({ brightnessFails: true });
      try {
        expect(await f.controller.set({ control: "preventAutoLock", enabled: true })).toMatchObject({
          preventAutoLock: true,
          brightnessAvailable: false,
          brightnessError: "Error: brightness unavailable",
        });
        await expect(enabled(f.controller)).rejects.toThrow("brightness unavailable");
      } finally {
        await f.controller.dispose();
      }
    });

    test("invalid payloads are rejected without touching native state", async () => {
      const f = fixture();
      await expect(f.controller.set({ control: "unknown", enabled: true } as never)).rejects.toThrow(
        "Invalid",
      );
      expect(f.refreshes()).toBe(0);
      expect(f.writes).toEqual([]);
      await f.controller.dispose();
    });

    test("other platforms never load macOS frameworks", async () => {
      const controller = new DisplayControl(
        "linux",
        () => {
          throw new Error("loaded native");
        },
        () => {
          throw new Error("loaded native");
        },
      );
      expect(await controller.getState()).toEqual({
        preventAutoLock: false,
        dimmed: false,
        brightnessAvailable: false,
        displays: [],
        pendingRestores: 0,
      });
      await expect(enabled(controller)).rejects.toThrow("require macOS or Windows");
      await controller.dispose();
    });
  });
}
