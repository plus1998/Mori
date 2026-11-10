import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { WebContents } from "electron";
import { isBrowserPlaceholderUrl } from "../shared/browser";
import type { AgentBrowserMcpToolResult } from "./agent-browser-cli-bridge";
import { prepareGuestScreenshotSurface } from "./browser-screenshot-surface";

const SCREENSHOT_MIN_BYTES = 512;

function pickString(args: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

export function resolveAgentBrowserScreenshotPath(args: Record<string, unknown>): string {
  return (
    pickString(args, "path", "file", "output") ??
    path.join(os.tmpdir(), `eco-browser-screenshot-${Date.now()}.png`)
  );
}

export function isFullPageScreenshot(args: Record<string, unknown>): boolean {
  return args.full === true || args.fullPage === true;
}

function ensureDebugger(wc: WebContents) {
  const dbg = wc.debugger;
  if (!dbg.isAttached()) {
    dbg.attach("1.3");
  }
  return dbg;
}

async function tryCdpCapture(
  webContents: WebContents,
  full: boolean,
  requestFrame = false,
): Promise<Buffer> {
  const dbg = ensureDebugger(webContents);
  const params: Record<string, unknown> = {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: full || requestFrame,
  };
  if (full || requestFrame) {
    const layout = (await dbg.sendCommand("Page.getLayoutMetrics")) as {
      cssContentSize?: { width: number; height: number };
      cssVisualViewport?: { pageX: number; pageY: number; clientWidth: number; clientHeight: number; scale: number };
    };
    const viewport = layout.cssVisualViewport;
    const width = full ? Math.ceil(layout.cssContentSize?.width ?? 0) : viewport?.clientWidth ?? 0;
    const height = full ? Math.ceil(layout.cssContentSize?.height ?? 0) : viewport?.clientHeight ?? 0;
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      throw new Error("Page.getLayoutMetrics returned no valid CSS content size");
    }
    if (!full && (!viewport || !Number.isFinite(viewport.pageX) || !Number.isFinite(viewport.pageY) ||
        !Number.isFinite(viewport.scale) || viewport.scale <= 0)) {
      throw new Error("Page.getLayoutMetrics returned no valid CSS visual viewport");
    }
    // An explicit viewport clip also makes Chromium prepare the emulated-DPR
    // surface when the containing native window is hidden.
    params.clip = { x: full ? 0 : viewport!.pageX, y: full ? 0 : viewport!.pageY,
      width, height, scale: full ? 1 : viewport!.scale };
  }
  const pendingShot = dbg.sendCommand("Page.captureScreenshot", params);
  // Full-page capture temporarily expands Chromium's surface. A transparent
  // embedder does not paint that new size until another native frame is requested.
  const refreshFrame = async () => {
    if (!full || !requestFrame) return;
    await dbg.sendCommand("Page.getLayoutMetrics");
    await webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
  };
  const [shot] = await Promise.all([pendingShot, refreshFrame()]) as [{ data?: string }, unknown];
  if (!shot.data) {
    throw new Error("Page.captureScreenshot returned no image data");
  }
  const buffer = Buffer.from(shot.data, "base64");
  if (buffer.length < SCREENSHOT_MIN_BYTES) {
    throw new Error(`Page.captureScreenshot image too small (${buffer.length} bytes)`);
  }
  return buffer;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

const SCREENSHOT_TIMEOUT_MS = 12_000;

const screenshotCalls = new WeakMap<WebContents, Promise<unknown>>();

export async function captureGuestScreenshot(
  webContents: WebContents,
  outputPath: string,
  full = false,
): Promise<string> {
  // Guests in one window share its render scheduler and temporary capture styles.
  const key = webContents.hostWebContents ?? webContents;
  const previous = screenshotCalls.get(key) ?? Promise.resolve();
  const call = previous.catch(() => {}).then(() => captureGuestScreenshotNow(webContents, outputPath, full));
  screenshotCalls.set(key, call);
  try {
    return await call;
  } finally {
    if (screenshotCalls.get(key) === call) screenshotCalls.delete(key);
  }
}

async function captureGuestScreenshotNow(
  webContents: WebContents,
  outputPath: string,
  full = false,
): Promise<string> {
  if (webContents.isDestroyed()) {
    throw new Error("Guest WebContents is destroyed");
  }
  if (typeof webContents.getType === "function" && webContents.getType() !== "webview") {
    throw new Error(
      `Refusing screenshot on non-guest webContents (type=${webContents.getType()}); Mori main window must not handle browser automation`,
    );
  }
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  const surface = await prepareGuestScreenshotSurface(webContents);
  try {
    if (surface.prepared) {
      // A never-painted hidden guest has no surface for CDP. Request a real
      // guest frame first, then use CDP to preserve emulated viewport/DPR.
      try {
        await withTimeout(webContents.capturePage(undefined, { stayHidden: true, stayAwake: true }),
          SCREENSHOT_TIMEOUT_MS, "prepare-guest-frame");
      } catch (error) {
        throw new Error(`Screenshot guest frame preparation failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    let png: Buffer;
    try {
      png = await withTimeout(tryCdpCapture(webContents, full, surface.prepared),
        SCREENSHOT_TIMEOUT_MS, "Page.captureScreenshot");
    } catch (error) {
      // View/native captures can silently change DPR or truncate a full page.
      // Preserve the actual failure instead of returning a different screenshot.
      throw new Error(`Screenshot CDP capture failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    fs.writeFileSync(outputPath, png);
    return outputPath;
  } finally {
    await surface.dispose();
  }
}

export function agentBrowserTextResult(text: string, isError = false): AgentBrowserMcpToolResult {
  return {
    content: [{ type: "text", text }],
    ...(isError ? { isError: true } : {}),
  };
}

export type AgentBrowserTabEntry = {
  url: string;
};

/** Match agent-browser CLI `tab list` line format (`[t1] about:blank`). */
export function formatAgentBrowserTabList(tabs: AgentBrowserTabEntry[]): string {
  if (tabs.length === 0) {
    return "(no tabs)";
  }
  return tabs
    .map((tab, index) => {
      const raw = tab.url.trim() || "about:blank";
      const display = isBrowserPlaceholderUrl(raw) ? "about:blank" : raw;
      return `[t${index + 1}] ${display}`;
    })
    .join("\n");
}
