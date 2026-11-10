import { expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { WebContents } from "electron";
import {
  captureGuestScreenshot,
  formatAgentBrowserTabList,
  isFullPageScreenshot,
  resolveAgentBrowserScreenshotPath,
} from "../src/main/browser-native-agent-tools";

test("capturing background guest screenshots never takes native focus", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mori-screenshot-focus-"));
  const png = Buffer.alloc(1024, 1);
  let focusCalls = 0;
  const guest = {
    isDestroyed: () => false,
    getType: () => "webview",
    focus: () => { focusCalls++; },
    debugger: {
      isAttached: () => true,
      sendCommand: async () => ({ data: png.toString("base64") }),
    },
  } as unknown as WebContents;
  try {
    const output = path.join(directory, "guest.png");
    expect(await captureGuestScreenshot(guest, output)).toBe(output);
    expect(fs.readFileSync(output)).toEqual(png);
    expect(focusCalls).toBe(0);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("hidden guest frame preparation is restored even when native capture fails", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mori-screenshot-restore-"));
  const operations: string[] = [];
  const guest = {
    id: 42,
    isDestroyed: () => false,
    getType: () => "webview",
    backgroundThrottling: true,
    setBackgroundThrottling: (value: boolean) => operations.push(`throttling:${value}`),
    beginFrameSubscription: () => operations.push("subscribe"),
    endFrameSubscription: () => operations.push("unsubscribe"),
    hostWebContents: {
      isDestroyed: () => false,
      backgroundThrottling: true,
      setBackgroundThrottling: (value: boolean) => operations.push(`embedder-throttling:${value}`),
      executeJavaScript: async (script: string) => {
        if (script.endsWith("(42, true)")) { operations.push("prepare"); return true; }
        if (script.endsWith("(42, false)")) { operations.push("restore"); return false; }
      },
    },
    capturePage: async () => { operations.push("capture"); throw new Error("UnknownVizError"); },
  } as unknown as WebContents;
  try {
    const output = path.join(directory, "guest.png");
    await expect(captureGuestScreenshot(guest, output)).rejects.toThrow("UnknownVizError");
    expect(operations).toEqual(["prepare", "throttling:false", "embedder-throttling:false", "subscribe", "capture", "restore", "unsubscribe", "throttling:true", "embedder-throttling:true"]);
    expect(fs.existsSync(output)).toBe(false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("simultaneous screenshots in one window finish restoring before the next capture", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mori-screenshot-concurrent-"));
  const png = Buffer.alloc(1024, 1);
  const operations: string[] = [];
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const firstStarted = new Promise<void>(resolve => { started = resolve; });
  const guest = {
    id: 43,
    isDestroyed: () => false,
    getType: () => "webview",
    backgroundThrottling: true,
    setBackgroundThrottling: () => {},
    beginFrameSubscription: () => {},
    endFrameSubscription: () => {},
    hostWebContents: {
      isDestroyed: () => false,
      backgroundThrottling: true,
      setBackgroundThrottling: () => {},
      executeJavaScript: async (script: string) => {
        if (script.endsWith(", true)")) { operations.push("prepare"); return true; }
        if (script.endsWith(", false)")) { operations.push("restore"); return false; }
      },
    },
    capturePage: async () => { operations.push("frame"); started(); await gate; },
    debugger: {
      isAttached: () => true,
      sendCommand: async (method: string) => {
        if (method === "Page.getLayoutMetrics") return {
          cssVisualViewport: { pageX: 0, pageY: 0, clientWidth: 600, clientHeight: 400, scale: 1 },
        };
        operations.push("capture");
        return { data: png.toString("base64") };
      },
    },
  } as unknown as WebContents;
  try {
    const first = captureGuestScreenshot(guest, path.join(directory, "first.png"));
    const sibling = { ...guest, id: 44 } as unknown as WebContents;
    const second = captureGuestScreenshot(sibling, path.join(directory, "second.png"));
    await firstStarted;
    expect(operations).toEqual(["prepare", "frame"]);
    release();
    await Promise.all([first, second]);
    expect(operations).toEqual(["prepare", "frame", "capture", "restore", "prepare", "frame", "capture", "restore"]);
  } finally {
    release();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("CDP failures preserve their cause instead of substituting a native screenshot", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mori-screenshot-errors-"));
  const guest = {
    isDestroyed: () => false,
    getType: () => "webview",
    debugger: {
      isAttached: () => true,
      sendCommand: async (_method: string, params: { fromSurface: boolean }) => {
        throw new Error(params.fromSurface ? "No compositor frame" : "View unavailable");
      },
    },
    capturePage: async () => { throw new Error("UnknownVizError"); },
  } as unknown as WebContents;
  try {
    await expect(captureGuestScreenshot(guest, path.join(directory, "guest.png"))).rejects.toThrow(
      "Screenshot CDP capture failed: No compositor frame",
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("full-page captures use CSS content dimensions and fail without a viewport substitute", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mori-screenshot-full-"));
  const png = Buffer.alloc(1024, 1);
  let clip: unknown;
  let fail = false;
  let nativeCalls = 0;
  const guest = {
    isDestroyed: () => false,
    getType: () => "webview",
    capturePage: async () => { nativeCalls++; },
    debugger: {
      isAttached: () => true,
      sendCommand: async (method: string, params: { clip?: unknown }) => {
        if (method === "Page.getLayoutMetrics") return {
          cssContentSize: { width: 600, height: 1800 },
          contentSize: { width: 1200, height: 3600 },
        };
        if (fail) throw new Error("Full surface unavailable");
        clip = params.clip;
        return { data: png.toString("base64") };
      },
    },
  } as unknown as WebContents;
  try {
    await captureGuestScreenshot(guest, path.join(directory, "full.png"), true);
    expect(clip).toEqual({ x: 0, y: 0, width: 600, height: 1800, scale: 1 });
    fail = true;
    await expect(captureGuestScreenshot(guest, path.join(directory, "failed.png"), true)).rejects.toThrow("Full surface unavailable");
    expect(nativeCalls).toBe(0);
    expect(fs.existsSync(path.join(directory, "failed.png"))).toBe(false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("resolveAgentBrowserScreenshotPath defaults to temp png", () => {
  const resolved = resolveAgentBrowserScreenshotPath({});
  expect(path.dirname(resolved)).toBe(os.tmpdir());
  expect(path.basename(resolved)).toMatch(/^eco-browser-screenshot-\d+\.png$/);
});

test("resolveAgentBrowserScreenshotPath honors explicit path", () => {
  expect(resolveAgentBrowserScreenshotPath({ path: "C:/shots/a.png" })).toBe("C:/shots/a.png");
});

test("isFullPageScreenshot detects full flag", () => {
  expect(isFullPageScreenshot({})).toBe(false);
  expect(isFullPageScreenshot({ full: true })).toBe(true);
  expect(isFullPageScreenshot({ fullPage: true })).toBe(true);
});

test("formatAgentBrowserTabList returns empty sentinel without minting tabs", () => {
  expect(formatAgentBrowserTabList([])).toBe("(no tabs)");
});

test("formatAgentBrowserTabList matches agent-browser tab list lines", () => {
  expect(formatAgentBrowserTabList([{ url: "about:blank" }, { url: "https://example.com/" }])).toBe(
    "[t1] about:blank\n[t2] https://example.com/",
  );
});
