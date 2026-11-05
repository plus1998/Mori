import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KeyboardShortcutsStore } from "../src/main/keyboard-shortcuts-store";
import { checkGlobalShortcutConflicts, GlobalShortcutBinding } from "../src/main/global-shortcut-binding";
import {
  acceleratorFromEvent,
  defaultShortcutBindings,
  formatAccelerator,
  matchesShortcut,
  validateShortcutBindings,
} from "../src/shared/keyboard-shortcuts";

for (const platform of ["darwin", "win32", "linux"]) {
  test(`shortcut defaults and modifier aliases are valid on ${platform}`, () => {
    const defaults = defaultShortcutBindings(platform);
    expect(() => validateShortcutBindings(defaults, platform)).not.toThrow();
    expect(defaults["open-scheduling"]).toHaveLength(1);
    expect(defaults["open-todos"]).toHaveLength(1);
    expect(defaults["toggle-prevent-auto-lock"]).toEqual(
      platform !== "linux" ? ["CommandOrControl+Shift+U"] : undefined,
    );
    expect(defaults["toggle-display-dimming"]).toEqual(
      platform !== "linux" ? ["CommandOrControl+Shift+D"] : undefined,
    );
    const event = {
      key: "J",
      code: "KeyJ",
      metaKey: platform === "darwin",
      ctrlKey: platform !== "darwin",
      altKey: false,
      shiftKey: true,
    };
    expect(matchesShortcut(event, "open-scheduling", defaults, platform)).toBe(true);
    expect(matchesShortcut({ ...event, isComposing: true }, "open-scheduling", defaults, platform)).toBe(
      false,
    );
    const next = validateShortcutBindings({ ...defaults, "open-scheduling": ["Alt+Shift+J"] }, platform);
    expect(matchesShortcut(event, "open-scheduling", next, platform)).toBe(false);
    expect(
      matchesShortcut(
        { ...event, metaKey: false, ctrlKey: false, altKey: true },
        "open-scheduling",
        next,
        platform,
      ),
    ).toBe(true);
  });
}
test("conflicts use actual platform modifiers and allow independent contextual commands", () => {
  const defaults = defaultShortcutBindings("darwin");
  expect(() =>
    validateShortcutBindings({ ...defaults, "open-todos": ["Command+Shift+J"] }, "darwin"),
  ).toThrow("定时任务");
  expect(() => validateShortcutBindings({ ...defaults, "open-todos": ["J"] }, "darwin")).toThrow("修饰键");
  expect(() =>
    validateShortcutBindings({ ...defaults, "open-todos": ["Control+Unknown"] }, "darwin"),
  ).toThrow("有效");
  expect(() =>
    validateShortcutBindings(
      { ...defaults, "git-commit": ["CommandOrControl+Enter"], "todo-save": ["CommandOrControl+Enter"] },
      "darwin",
    ),
  ).not.toThrow();
  expect(() =>
    validateShortcutBindings({ ...defaults, "open-todos": ["CommandOrControl+Enter"] }, "darwin"),
  ).toThrow("快捷键冲突");
  expect(() =>
    validateShortcutBindings({ ...defaults, "mori-floating": ["Command+Shift+M", "Control+M"] }, "darwin"),
  ).toThrow("配置无效");
  expect(() =>
    validateShortcutBindings({ ...defaults, "new-chat": ["Command+N", "CmdOrCtrl+N"] }, "darwin"),
  ).toThrow("冲突");
});
test("recording captures physical punctuation and formats platform-specific labels", () => {
  expect(
    acceleratorFromEvent({
      key: "CapsLock",
      code: "CapsLock",
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
    }),
  ).toBeUndefined();
  expect(
    acceleratorFromEvent({
      key: "~",
      code: "Backquote",
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      shiftKey: true,
    }),
  ).toBe("Shift+Command+`");
  expect(
    acceleratorFromEvent({ key: "Shift", metaKey: false, ctrlKey: false, altKey: false, shiftKey: true }),
  ).toBeUndefined();
  expect(formatAccelerator("CommandOrControl+Shift+J", "darwin")).toBe("⇧⌘J");
  expect(formatAccelerator("CommandOrControl+Shift+J", "win32")).toBe("Ctrl+Shift+J");
});
test("cleared bindings persist and legacy Mori shortcut migrates without adding a database", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mori-shortcuts-"));
  try {
    const file = path.join(directory, "keyboard-shortcuts.json");
    fs.writeFileSync(
      path.join(directory, "mori-assistant.json"),
      JSON.stringify({ settings: { shortcut: "CommandOrControl+Shift+P" } }),
    );
    const store = new KeyboardShortcutsStore(file, "darwin");
    store.load();
    expect(store.get()["mori-floating"]).toEqual(["CommandOrControl+Shift+P"]);
    store.save({ ...store.get(), "open-todos": [], "new-chat": ["Alt+N"] });
    fs.writeFileSync(file, JSON.stringify({ ...store.get(), copy: ["Alt+C"], paste: [], reload: ["Alt+R"], minimize: [] }));
    const reloaded = new KeyboardShortcutsStore(file, "darwin");
    reloaded.load();
    expect(reloaded.get().copy).toBeUndefined();
    expect(reloaded.get().paste).toBeUndefined();
    expect(reloaded.get().reload).toBeUndefined();
    expect(reloaded.get().minimize).toBeUndefined();
    expect(reloaded.get()["open-todos"]).toEqual([]);
    expect(reloaded.get()["new-chat"]).toEqual(["Alt+N"]);
    expect(() => reloaded.save({ ...reloaded.get(), "new-chat": ["Command+O"] })).toThrow("冲突");
    expect(reloaded.get()["new-chat"]).toEqual(["Alt+N"]);
    fs.writeFileSync(file, "broken");
    expect(() => reloaded.load()).toThrow();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("Windows global conflicts clear only unavailable bindings and persist across reloads", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mori-shortcut-conflict-"));
  try {
    const file = path.join(directory, "keyboard-shortcuts.json");
    const store = new KeyboardShortcutsStore(file, "win32");
    const defaults = store.get();
    const unavailable = defaults["mori-floating"]![0]!;
    const released: string[] = [];
    const checked = checkGlobalShortcutConflicts(store.snapshot(), {
      isRegistered: () => false,
      register: (key) => key !== unavailable,
      unregister: (key) => { released.push(key); },
    });
    expect(checked.bindings["mori-floating"]).toEqual([]);
    expect(checked.bindings["restore-display"]).toEqual(defaults["restore-display"]);
    expect(checked.bindings["new-chat"]).toEqual(defaults["new-chat"]);
    expect(checked.conflicts).toEqual({ "mori-floating": unavailable });
    expect(released).toEqual(defaults["restore-display"]!);
    expect(defaults["mori-floating"]).toEqual([unavailable]);
    store.save(checked.bindings, checked.conflicts);
    const reloaded = new KeyboardShortcutsStore(file, "win32");
    reloaded.load();
    expect(reloaded.snapshot()).toEqual(store.snapshot());
    reloaded.save({ ...reloaded.get(), "new-chat": ["Alt+N"] });
    expect(reloaded.snapshot().conflicts).toEqual({ "mori-floating": unavailable });
    reloaded.save({ ...reloaded.get(), "mori-floating": ["Alt+Shift+M"] });
    expect(reloaded.snapshot().conflicts).toEqual({});
    expect(reloaded.clearConflictingBinding("mori-floating", unavailable)).toBe(false);
    expect(reloaded.clearConflictingBinding("mori-floating", "Alt+Shift+M")).toBe(true);
    reloaded.load();
    expect(reloaded.get()["mori-floating"]).toEqual([]);
    expect(reloaded.snapshot().conflicts).toEqual({ "mori-floating": "Alt+Shift+M" });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("probing preserves owned registrations and clears all unavailable global keys", () => {
  const snapshot = { bindings: defaultShortcutBindings("win32") };
  const owned = snapshot.bindings["mori-floating"]![0]!;
  const attempted: string[] = [];
  const checked = checkGlobalShortcutConflicts(snapshot, {
    isRegistered: (key) => key === owned,
    register: (key) => { attempted.push(key); return false; },
    unregister: () => { throw new Error("must not unregister an owned or failed key"); },
  });
  expect(attempted).toEqual(snapshot.bindings["restore-display"]!);
  expect(checked.bindings["mori-floating"]).toEqual([owned]);
  expect(checked.bindings["restore-display"]).toEqual([]);
  const allConflicted = checkGlobalShortcutConflicts(snapshot, {
    isRegistered: () => false,
    register: () => false,
    unregister: () => {},
  });
  expect(allConflicted.conflicts).toEqual({
    "mori-floating": owned,
    "restore-display": snapshot.bindings["restore-display"]![0]!,
  });
});

test("registration conflicts release the old binding and do not block later settings applications", () => {
  const registered = new Set<string>();
  let available = true;
  const binding = new GlobalShortcutBinding({
    register: (key) => {
      if (!available) return false;
      if (registered.has(key)) throw new Error("duplicate registration");
      registered.add(key);
      return true;
    },
    unregister: (key) => { registered.delete(key); },
  }, () => {});
  expect(binding.set("Control+Shift+M")).toBe(true);
  expect(binding.set("Control+Shift+M")).toBe(true);
  available = false;
  expect(binding.set("Control+Shift+P")).toBe(false);
  expect(registered.size).toBe(0);
  expect(binding.set("")).toBe(true);
  available = true;
  expect(binding.set("Control+Shift+P")).toBe(true);
  binding.set(""); // Shortcut recording suspends the current registration.
  available = false;
  expect(binding.set("Control+Shift+P")).toBe(false);
  expect(binding.set("")).toBe(true);
  expect(registered.size).toBe(0);
});

test("unexpected registration errors remain visible", () => {
  const register = () => { throw new Error("registration failed unexpectedly"); };
  expect(() => checkGlobalShortcutConflicts({ bindings: defaultShortcutBindings("win32") }, {
    isRegistered: () => false, register, unregister: () => {},
  })).toThrow("registration failed unexpectedly");
  expect(() => new GlobalShortcutBinding({ register, unregister: () => {} }, () => {}).set("Control+M"))
    .toThrow("registration failed unexpectedly");
});
