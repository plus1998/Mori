import { expect, test } from "bun:test";
import type { MoriAvatarSettings } from "../src/shared/mori-avatar";
import { getMoriAvatarSnapshot, subscribeMoriAvatar } from "../src/renderer/mori-avatar-store";

test("navigation avatars share a subscription and refresh independently of the chat panel", async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const avatar: MoriAvatarSettings = { petKey: "codex:doro", animation: "idle", frame: 0, zoom: 1.3 };
  let saved: MoriAvatarSettings | null = avatar;
  let changed: (() => void) | undefined;
  let reads = 0, connections = 0, disconnected = 0, updates = 0;
  let release: (() => void) | undefined;
  let hold = false;
  const focusListeners = new Set<() => void>();
  const unsubscribes: Array<() => void> = [];
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    eco: {
      async moriAssistantSnapshot() {
        reads++;
        if (hold) { hold = false; await new Promise<void>((resolve) => { release = resolve; }); }
        return { settings: { avatar: saved } };
      },
      onMoriAssistantChanged(listener: () => void) {
        connections++;
        changed = listener;
        return () => { disconnected++; changed = undefined; };
      },
    },
    addEventListener: (_event: string, listener: () => void) => focusListeners.add(listener),
    removeEventListener: (_event: string, listener: () => void) => focusListeners.delete(listener),
  } });
  const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
  try {
    unsubscribes.push(subscribeMoriAvatar(() => updates++));
    unsubscribes.push(subscribeMoriAvatar(() => updates++));
    await settle();
    expect(connections).toBe(1);
    expect(reads).toBe(1);
    expect(focusListeners.size).toBe(1);
    expect(getMoriAvatarSnapshot().avatar).toEqual(avatar);

    const unchanged = getMoriAvatarSnapshot();
    const before = updates;
    changed?.();
    await settle();
    expect(getMoriAvatarSnapshot()).toBe(unchanged);
    expect(updates).toBe(before);

    hold = true;
    changed?.();
    saved = { ...avatar, zoom: 1.6 };
    changed?.();
    release?.();
    await settle();
    expect(getMoriAvatarSnapshot().avatar?.zoom).toBe(1.6);
    expect(reads).toBe(4);

    saved = null;
    for (const focus of focusListeners) focus();
    await settle();
    expect(getMoriAvatarSnapshot().avatar).toBeNull();
  } finally {
    for (const unsubscribe of unsubscribes) unsubscribe();
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
  expect(disconnected).toBe(1);
  expect(focusListeners.size).toBe(0);
});
