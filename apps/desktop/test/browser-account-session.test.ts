import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { WebPreferences } from "electron";
import { installBrowserGuestBridge } from "../src/main/browser-guest-bridge";

test("account webviews use the existing session even when Electron omits custom DOM attributes", () => {
  const contents = Object.assign(new EventEmitter(), { isDestroyed: () => false });
  const accountSession = {};
  const pending: string[] = [];
  const registered: unknown[] = [];
  const dispose = installBrowserGuestBridge({ webContents: contents } as never, {
    getAccountGuestSession: (id: string) => id === "tab-a" ? accountSession : undefined,
    notePendingGuestAttach: (id: string) => pending.push(id),
    consumePendingGuestAttach: (id: number, session: unknown) => {
      expect(id).toBe(42);
      expect(session).toBe(accountSession);
      return "tab-a";
    },
    registerGuestWebContents: (...args: unknown[]) => { registered.push(args); },
  } as never);
  try {
    const preferences: WebPreferences = {};
    contents.emit("will-attach-webview", { preventDefault() { throw new Error("Unexpected rejection"); } }, preferences, { partition: "account:tab-a" });
    expect(preferences.session).toBe(accountSession);
    expect(preferences.partition).toBeUndefined();
    expect(preferences).toMatchObject({ sandbox: true, nodeIntegration: false, contextIsolation: true });
    expect(pending).toEqual(["tab-a"]);
    const guest = { id: 42, session: accountSession };
    contents.emit("did-attach-webview", {}, guest);
    expect(registered).toEqual([["tab-a", guest, contents]]);
  } finally { dispose(); }
  expect(contents.listenerCount("will-attach-webview")).toBe(0);
});

test("unknown account sessions are rejected instead of opening with another profile", () => {
  const contents = Object.assign(new EventEmitter(), { isDestroyed: () => false });
  let prevented = false;
  const dispose = installBrowserGuestBridge({ webContents: contents } as never, {
    getAccountGuestSession: () => undefined,
    notePendingGuestAttach() { throw new Error("Rejected guest must not be registered"); },
  } as never);
  try {
    contents.emit("will-attach-webview", { preventDefault() { prevented = true; } }, {}, { partition: "account:missing" });
    expect(prevented).toBe(true);
  } finally { dispose(); }
});

test("standalone guests wait for dom-ready identity rather than attaching to a pending main-window tab", () => {
  const contents = Object.assign(new EventEmitter(), { isDestroyed: () => false });
  const pending: string[] = [];
  const dispose = installBrowserGuestBridge({ webContents: contents } as never, {
    getAccountGuestSession: () => undefined,
    notePendingGuestAttach: (id: string) => pending.push(id),
    consumePendingGuestAttach() { throw new Error("Separate window must not consume main-window attachments"); },
    registerGuestWebContents() { throw new Error("Guest is not ready to restore its navigation"); },
  } as never, "separate-tab");
  try {
    const preferences: WebPreferences = { preload: "/untrusted/preload.js" };
    contents.emit("will-attach-webview", {}, preferences, { partition: "persist:workspace" });
    expect(pending).toEqual(["separate-tab"]);
    expect(preferences.preload).toBeUndefined();
    expect(preferences.partition).toBe("persist:workspace");
    contents.emit("did-attach-webview", {}, { id: 99 });
  } finally { dispose(); }
});
