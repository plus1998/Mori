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
