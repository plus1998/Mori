import { describe, expect, test } from "bun:test";
import { DisplayControl } from "../src/main/display-control";
import {
  displayLevelsAreMinimum,
  type MacDisplayInfo,
  type MacDisplayLevels,
} from "../src/main/mac-display-native";

interface Monitor extends MacDisplayInfo {
  levels: MacDisplayLevels;
  unsupported?: boolean;
  failDim?: boolean;
  failRestore?: boolean;
}

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

function clone(levels: MacDisplayLevels): MacDisplayLevels {
  return levels.method === "backlight"
    ? { ...levels }
    : {
        method: "software",
        red: levels.red.slice(),
        green: levels.green.slice(),
        blue: levels.blue.slice(),
      };
}

function fixture(
  options: { activityFails?: boolean; brightnessFails?: boolean; shortcutFails?: boolean } = {},
  initial = [monitor(1)],
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
    "darwin",
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
        set(id: number, value: MacDisplayLevels) {
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

function enabled(controller: DisplayControl, value = true) {
  return controller.set({ control: "dimmed", enabled: value });
}

describe("display controls", () => {
  test("shortcut toggles use the existing lock and brightness recovery paths", () => {
    const display = monitor(1);
    const f = fixture({}, [display]);
    try {
      expect(f.controller.toggle("preventAutoLock").preventAutoLock).toBe(true);
      expect(f.controller.toggle("preventAutoLock").preventAutoLock).toBe(false);
      expect(f.controller.toggle("dimmed").dimmed).toBe(true);
      expect(displayLevelsAreMinimum(display.levels)).toBe(true);
      expect(f.registered()).toBe(1);
      expect(f.controller.toggle("dimmed").dimmed).toBe(false);
      expect(display.levels).toEqual({ method: "backlight", value: 0.7 });
      expect(f.unregistered()).toBe(1);
    } finally {
      f.controller.dispose();
    }
  });

  test("independent controls release assertions and restore all display profiles on quit", () => {
    const internal = monitor(1),
      external = monitor(2, "software"),
      appleExternal = monitor(3, "backlight", 0.4);
    const originalGamma = clone(external.levels);
    const f = fixture({}, [internal, external, appleExternal]);
    try {
      f.controller.set({ control: "preventAutoLock", enabled: true });
      const state = enabled(f.controller);
      expect(state.displays.map((d) => d.status)).toEqual(["dimmed", "dimmed", "dimmed"]);
      expect(state.displays.map((d) => d.method)).toEqual(["backlight", "software", "backlight"]);
      expect([internal, external, appleExternal].every((d) => displayLevelsAreMinimum(d.levels))).toBe(true);
      expect(f.registered()).toBe(1);
    } finally {
      f.controller.dispose();
    }
    expect(internal.levels).toEqual({ method: "backlight", value: 0.7 });
    expect(appleExternal.levels).toEqual({ method: "backlight", value: 0.4 });
    expect(external.levels).toEqual(originalGamma);
    expect(f.releases()).toBe(1);
    expect(f.unregistered()).toBe(1);
  });

  test("repeated activation preserves each original brightness", () => {
    const d = monitor(1),
      f = fixture({}, [d]);
    try {
      enabled(f.controller);
      enabled(f.controller);
      expect(f.registered()).toBe(1);
      enabled(f.controller, false);
      expect(d.levels).toEqual({ method: "backlight", value: 0.7 });
    } finally {
      f.controller.dispose();
    }
  });

  test("brightness up on one display restores the group and preserves its manual value", () => {
    const internal = monitor(1),
      external = monitor(2, "software"),
      original = clone(external.levels);
    const f = fixture({}, [internal, external]);
    try {
      enabled(f.controller);
      internal.levels = { method: "backlight", value: 0.2 };
      f.controller.refresh();
      expect(f.controller.getState().dimmed).toBe(false);
      expect(internal.levels).toEqual({ method: "backlight", value: 0.2 });
      expect(external.levels).toEqual(original);
      expect(f.unregistered()).toBe(1);
    } finally {
      f.controller.dispose();
    }
  });

  test("disabling before polling preserves a manual brightness change", () => {
    const d = monitor(1),
      f = fixture({}, [d]);
    try {
      enabled(f.controller);
      d.levels = { method: "backlight", value: 0.4 };
      enabled(f.controller, false);
      expect(d.levels).toEqual({ method: "backlight", value: 0.4 });
    } finally {
      f.controller.dispose();
    }
  });

  test("unsupported displays remain visible and are never reported as dimmed", () => {
    const unsupported = { ...monitor(2), unsupported: true },
      f = fixture({}, [monitor(1), unsupported]);
    try {
      const state = enabled(f.controller);
      expect(state.displays[1]).toMatchObject({
        id: 2,
        status: "unsupported",
        error: "Error: display 2 unavailable",
      });
      expect(f.writes).toEqual([1]);
    } finally {
      f.controller.dispose();
    }
  });

  test("no supported screens never registers a shortcut or changes any screen", () => {
    const f = fixture({}, [{ ...monitor(2), unsupported: true }]);
    expect(() => enabled(f.controller)).toThrow("No display supports");
    expect(f.registered()).toBe(0);
    expect(f.writes).toEqual([]);
    f.controller.dispose();
  });

  test("failed recovery shortcut registration prevents all dimming", () => {
    const f = fixture({ shortcutFails: true });
    expect(() => enabled(f.controller)).toThrow("shortcut unavailable");
    expect(f.writes).toEqual([]);
    expect(f.controller.getState().dimmed).toBe(false);
    f.controller.dispose();
  });

  test("activation failure rolls back earlier screens and a partially changed screen", () => {
    const first = monitor(1),
      second = { ...monitor(2), failDim: true },
      f = fixture({}, [first, second]);
    try {
      expect(() => enabled(f.controller)).toThrow("dimming write failed");
      expect(first.levels).toEqual({ method: "backlight", value: 0.7 });
      expect(second.levels).toEqual({ method: "backlight", value: 0.7 });
      expect(f.controller.getState()).toMatchObject({ dimmed: false, pendingRestores: 0 });
      expect(f.unregistered()).toBe(1);
    } finally {
      f.controller.dispose();
    }
  });

  test("a failed restore does not prevent other screens from being restored; retry retains the original", () => {
    const first = monitor(1),
      second = { ...monitor(2), failRestore: true },
      f = fixture({}, [first, second]);
    try {
      enabled(f.controller);
      expect(() => enabled(f.controller, false)).toThrow("restoration failed");
      expect(first.levels).toEqual({ method: "backlight", value: 0.7 });
      expect(f.controller.getState().pendingRestores).toBe(1);
      expect(f.unregistered()).toBe(0);
      second.failRestore = false;
      f.controller.refresh();
      expect(second.levels).toEqual({ method: "backlight", value: 0.7 });
      expect(f.controller.getState().pendingRestores).toBe(0);
      expect(f.unregistered()).toBe(1);
    } finally {
      f.controller.dispose();
    }
  });

  test("hot-plugged screens join active dimming", () => {
    const first = monitor(1),
      second = monitor(2, "software"),
      original = clone(second.levels),
      f = fixture({}, [first]);
    try {
      enabled(f.controller);
      f.connected([first, second]);
      f.controller.refresh();
      expect(displayLevelsAreMinimum(second.levels)).toBe(true);
      enabled(f.controller, false);
      expect(second.levels).toEqual(original);
    } finally {
      f.controller.dispose();
    }
  });

  test("disconnected screens restore on reconnect by UUID, never by a reused numeric id", () => {
    const first = monitor(1),
      second = monitor(2, "software"),
      original = clone(second.levels),
      f = fixture({}, [first, second]);
    try {
      enabled(f.controller);
      const unrelated = { ...monitor(2), key: "unrelated" };
      f.connected([first, unrelated]);
      enabled(f.controller, false);
      expect(unrelated.levels).toEqual({ method: "backlight", value: 0.7 });
      expect(f.controller.getState().pendingRestores).toBe(1);
      second.id = 8;
      f.connected([first, unrelated, second]);
      f.controller.refresh();
      expect(second.levels).toEqual(original);
      expect(f.controller.getState().pendingRestores).toBe(0);
    } finally {
      f.controller.dispose();
    }
  });

  test("renewal failure reports the error and releases the assertion", () => {
    const options = { activityFails: false },
      f = fixture(options);
    try {
      f.controller.set({ control: "preventAutoLock", enabled: true });
      options.activityFails = true;
      f.controller.refresh();
      expect(f.controller.getState()).toMatchObject({
        preventAutoLock: false,
        error: "Error: activity denied",
      });
      expect(f.releases()).toBe(1);
    } finally {
      f.controller.dispose();
    }
  });

  test("failure to keep active releases the newly created assertion", () => {
    const f = fixture({ activityFails: true });
    expect(() => f.controller.set({ control: "preventAutoLock", enabled: true })).toThrow("activity denied");
    expect(f.releases()).toBe(1);
    expect(f.controller.getState().preventAutoLock).toBe(false);
    f.controller.dispose();
  });

  test("brightness API failures do not disable the independent lock control", () => {
    const f = fixture({ brightnessFails: true });
    try {
      expect(f.controller.set({ control: "preventAutoLock", enabled: true })).toMatchObject({
        preventAutoLock: true,
        brightnessAvailable: false,
        brightnessError: "Error: brightness unavailable",
      });
      expect(() => enabled(f.controller)).toThrow("brightness unavailable");
    } finally {
      f.controller.dispose();
    }
  });

  test("invalid payloads are rejected without touching native state", () => {
    const f = fixture();
    expect(() => f.controller.set({ control: "unknown", enabled: true } as never)).toThrow("Invalid");
    expect(f.refreshes()).toBe(0);
    expect(f.writes).toEqual([]);
    f.controller.dispose();
  });

  test("other platforms never load macOS frameworks", () => {
    const controller = new DisplayControl(
      "linux",
      () => {
        throw new Error("loaded native");
      },
      () => {
        throw new Error("loaded native");
      },
    );
    expect(controller.getState()).toEqual({
      preventAutoLock: false,
      dimmed: false,
      brightnessAvailable: false,
      displays: [],
      pendingRestores: 0,
    });
    expect(() => enabled(controller)).toThrow("require macOS");
    controller.dispose();
  });
});
