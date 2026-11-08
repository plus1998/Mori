import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import type { WebContents } from "electron";
import { invokeGuestCdp } from "../src/main/browser-debug-tools";

function setup(run: (method: string, params?: Record<string, unknown>) => Promise<unknown>) {
  const commands: Array<{ method: string; params?: Record<string, unknown> }> = [];
  const dbg = Object.assign(new EventEmitter(), {
    isAttached: () => true,
    sendCommand: async (method: string, params?: Record<string, unknown>) => {
      commands.push({ method, ...(params ? { params } : {}) });
      return run(method, params);
    },
  });
  const guest = Object.assign(new EventEmitter(), {
    isDestroyed: () => false, getType: () => "webview", debugger: dbg,
  });
  return { guest: guest as unknown as WebContents, dbg, commands };
}
function payload(result: Awaited<ReturnType<typeof invokeGuestCdp>>) {
  return JSON.parse(result.content[0]!.text!);
}

test("cross-origin JS/CSS/SVG resource bytes come directly from the attached guest's DevTools", async () => {
  const source = "<svg xmlns='http://www.w3.org/2000/svg'><path d='M0 0h10v10z'/></svg>";
  const env = setup(async () => ({ content: source, base64Encoded: false }));
  const params = { frameId: "frame-main", url: "https://cdn.other.test/logo.svg" };
  const result = payload(await invokeGuestCdp(env.guest, { method: "Page.getResourceContent", params }));
  expect(env.commands).toEqual([{ method: "Page.getResourceContent", params }]);
  expect(result.result).toEqual({ content: source, base64Encoded: false });
  expect(env.dbg.listenerCount("message")).toBe(0);
});

test("script and stylesheet discovery captures synchronous enable events without removing other listeners", async () => {
  const env = setup(async method => {
    env.dbg.emit("message", {}, "Debugger.scriptParsed", { scriptId: "js-1", url: "https://cdn.test/app.js" });
    env.dbg.emit("message", {}, "CSS.styleSheetAdded", { header: { styleSheetId: "css-1" } });
    return { enabled: method };
  });
  const unrelated = () => {};
  env.dbg.on("message", unrelated);
  const result = payload(await invokeGuestCdp(env.guest, {
    method: "Debugger.enable", captureEvents: ["Debugger.*"], maxEvents: 1,
  }));
  expect(result.events).toEqual([{ method: "Debugger.scriptParsed", params: { scriptId: "js-1", url: "https://cdn.test/app.js" } }]);
  expect(result.totalEvents).toBe(1);
  expect(result.droppedEvents).toBe(0);
  expect(env.dbg.listeners("message")).toEqual([unrelated]);
});

test("event collection reports dropped events explicitly", async () => {
  const env = setup(async () => {
    for (let i = 0; i < 3; i++) env.dbg.emit("message", {}, "Network.responseReceived", { requestId: String(i) });
    return {};
  });
  const result = payload(await invokeGuestCdp(env.guest, {
    method: "Network.enable", captureEvents: ["Network.*"], maxEvents: 1,
  }));
  expect(result.events).toHaveLength(1);
  expect(result.totalEvents).toBe(3);
  expect(result.droppedEvents).toBe(2);
});

test("binary logos and large JS sources are preserved intact in temporary output files", async () => {
  for (const data of [
    { content: Buffer.from([0, 255, 137, 80, 78, 71]).toString("base64"), base64Encoded: true },
    { scriptSource: "const greeting='你好😀';\n".repeat(5000) },
  ]) {
    const env = setup(async () => data);
    const result = payload(await invokeGuestCdp(env.guest, {
      method: "Page.getResourceContent", ...(Object.hasOwn(data, "content") ? { output: "file" } : {}),
    }));
    try {
      expect(result.complete).toBe(true);
      expect(JSON.parse(fs.readFileSync(result.filePath, "utf8")).result).toEqual(data);
    } finally { fs.rmSync(path.dirname(result.filePath), { recursive: true, force: true }); }
  }
});

test("protocol failures propagate without refetching or fabricating resource data", async () => {
  const failure = new Error("No resource with given URL found");
  const env = setup(async () => { throw failure; });
  await expect(invokeGuestCdp(env.guest, { method: "Page.getResourceContent", params: { url: "https://cdn.test/missing.js", frameId: "f" } })).rejects.toBe(failure);
  expect(env.commands).toHaveLength(1);
  expect(env.dbg.listenerCount("message")).toBe(0);
});

test("top-level CDP reload uses only the guest API, including cache bypass and captured events", async () => {
  for (const ignoreCache of [false, true]) {
    const env = setup(async () => { throw new Error("Raw Page.reload must not reach Electron CDP"); });
    const calls: string[] = [];
    const reloaded = (name: string) => {
      calls.push(name);
      env.dbg.emit("message", {}, "Page.loadEventFired", { timestamp: 123 });
    };
    env.guest.reload = () => reloaded("reload");
    env.guest.reloadIgnoringCache = () => reloaded("reloadIgnoringCache");
    const result = payload(await invokeGuestCdp(env.guest, {
      method: "Page.reload", params: { ignoreCache }, captureEvents: ["Page.loadEventFired"],
    }));
    expect(calls).toEqual([ignoreCache ? "reloadIgnoringCache" : "reload"]);
    expect(env.commands).toEqual([]);
    expect(result).toEqual({ method: "Page.reload", result: {},
      events: [{ method: "Page.loadEventFired", params: { timestamp: 123 } }], totalEvents: 1, droppedEvents: 0 });
    expect(env.dbg.listenerCount("message")).toBe(0);
    expect(env.dbg.listenerCount("detach")).toBe(0);
  }
});

test("child-session reload stays scoped to that session and never reloads the entire guest", async () => {
  const env = setup(async () => ({}));
  const calls: unknown[][] = [];
  env.guest.debugger.sendCommand = async (...args: unknown[]) => { calls.push(args); return {}; };
  env.guest.reload = env.guest.reloadIgnoringCache = () => { throw new Error("Must not reload parent guest"); };
  await invokeGuestCdp(env.guest, { method: "Page.reload", sessionId: "child-frame", params: { ignoreCache: true } });
  expect(calls).toEqual([["Page.reload", { ignoreCache: true }, "child-frame"]]);
});

test("reload validates the guest and cancellation before any side effect", async () => {
  const env = setup(async () => ({}));
  env.guest.reload = () => { throw new Error("Must not reload"); };
  const controller = new AbortController();
  controller.abort(new Error("cancelled before reload"));
  await expect(invokeGuestCdp(env.guest, { method: "Page.reload" }, controller.signal)).rejects.toThrow("cancelled before reload");
  env.guest.getType = () => "window";
  await expect(invokeGuestCdp(env.guest, { method: "Page.reload" })).rejects.toThrow("non-guest");
  expect(env.commands).toEqual([]);
});

test("browser-wide commands, target substitution and main-window inspection never reach CDP", async () => {
  const env = setup(async () => ({}));
  for (const method of ["Browser.close", "Target.attachToTarget", "Storage.getCookies", "Network.getAllCookies", "Page.bringToFront"]) {
    await expect(invokeGuestCdp(env.guest, { method })).rejects.toThrow("single webpage");
  }
  await expect(invokeGuestCdp(env.guest, { method: "DOM.getDocument", targetId: "another-target" })).rejects.toThrow("argument");
  await expect(invokeGuestCdp(env.guest, { method: "Target.setAutoAttach", params: { filter: [{ type: "page" }] } })).rejects.toThrow("child scope");
  env.guest.getType = () => "window";
  await expect(invokeGuestCdp(env.guest, { method: "DOM.getDocument" })).rejects.toThrow("non-guest");
  expect(env.commands).toEqual([]);
});

test("child iframe/worker inspection uses only the attached guest's debugger sessions", async () => {
  const env = setup(async () => ({}));
  const calls: unknown[][] = [];
  env.guest.debugger.sendCommand = async (...args: unknown[]) => { calls.push(args); return {}; };
  await invokeGuestCdp(env.guest, { method: "Target.setAutoAttach", params: { autoAttach: true }, captureEvents: ["Target.attachedToTarget"] });
  await invokeGuestCdp(env.guest, { method: "DOM.getDocument", sessionId: "child-frame", params: { depth: -1 } });
  expect(calls).toEqual([
    ["Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true, filter: [{ type: "iframe" }, { type: "worker" }, { exclude: true }] }],
    ["DOM.getDocument", { depth: -1 }, "child-frame"],
  ]);
});

test("cancellation during a pending command removes only this call's listeners", async () => {
  const env = setup(() => new Promise(() => {}));
  const controller = new AbortController();
  const pending = invokeGuestCdp(env.guest, { method: "DOM.getDocument" }, controller.signal);
  const reason = new Error("cancelled");
  controller.abort(reason);
  await expect(pending).rejects.toBe(reason);
  expect(env.dbg.listenerCount("message")).toBe(0);
  expect(env.guest.listenerCount("destroyed")).toBe(0);
});

test("closing the guest interrupts an event observation window", async () => {
  const env = setup(async () => ({}));
  const pending = invokeGuestCdp(env.guest, { method: "Page.getResourceTree", captureEvents: ["Network.*"], waitMs: 5000 });
  env.guest.emit("destroyed");
  await expect(pending).rejects.toThrow("destroyed");
  expect(env.dbg.listenerCount("message")).toBe(0);
});

test("debugger detachment fails immediately and clears listeners", async () => {
  const env = setup(() => new Promise(() => {}));
  const pending = invokeGuestCdp(env.guest, { method: "DOM.getDocument" });
  env.dbg.emit("detach", {}, "replaced_with_devtools");
  await expect(pending).rejects.toThrow("replaced_with_devtools");
  expect(env.dbg.listenerCount("message")).toBe(0);
  expect(env.dbg.listenerCount("detach")).toBe(0);
  expect(env.guest.listenerCount("destroyed")).toBe(0);
});
