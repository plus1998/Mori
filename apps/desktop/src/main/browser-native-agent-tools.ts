import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { WebContents } from "electron";
import { isBrowserPlaceholderUrl } from "../shared/browser";
import type { AgentBrowserMcpToolResult } from "./agent-browser-cli-bridge";

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
  outputPath: string,
  full: boolean,
  fromSurface: boolean,
): Promise<number> {
  const dbg = ensureDebugger(webContents);
  // Prefer WebContents.focus — raw CDP Page.bringToFront can mis-target embedder on <webview>.
  try {
    webContents.focus();
  } catch {
    // ignore
  }
  const params: Record<string, unknown> = {
    format: "png",
    fromSurface,
    captureBeyondViewport: full,
  };
  if (full) {
    const layout = (await dbg.sendCommand("Page.getLayoutMetrics")) as {
      contentSize?: { width?: number; height?: number };
    };
    const width = Math.ceil(layout.contentSize?.width ?? 1280);
    const height = Math.ceil(layout.contentSize?.height ?? 720);
    params.clip = { x: 0, y: 0, width, height, scale: 1 };
  }
  const shot = (await dbg.sendCommand("Page.captureScreenshot", params)) as { data?: string };
  if (!shot.data) {
    throw new Error("Page.captureScreenshot returned no image data");
  }
  const buffer = Buffer.from(shot.data, "base64");
  if (buffer.length < SCREENSHOT_MIN_BYTES) {
    throw new Error(`Page.captureScreenshot image too small (${buffer.length} bytes)`);
  }
  fs.writeFileSync(outputPath, buffer);
  return buffer.length;
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

async function tryCapturePage(webContents: WebContents, outputPath: string): Promise<number> {
  const image = await webContents.capturePage(undefined, {
    stayHidden: true,
    stayAwake: true,
  });
  const png = image.toPNG();
  if (png.length < SCREENSHOT_MIN_BYTES) {
    throw new Error(`capturePage image too small (${png.length} bytes)`);
  }
  fs.writeFileSync(outputPath, png);
  return png.length;
}

const SCREENSHOT_TIER_TIMEOUT_MS = 12_000;

export async function captureGuestScreenshot(
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

  const tiers: Array<{ name: string; run: () => Promise<number> }> = [
    {
      name: "cdp-fromSurface-true",
      run: () => tryCdpCapture(webContents, outputPath, full, true),
    },
    {
      name: "cdp-fromSurface-false",
      run: () => tryCdpCapture(webContents, outputPath, full, false),
    },
    {
      name: "capturePage-stayHidden",
      run: () => tryCapturePage(webContents, outputPath),
    },
  ];

  let lastError: unknown;
  for (const tier of tiers) {
    try {
      await withTimeout(tier.run(), SCREENSHOT_TIER_TIMEOUT_MS, tier.name);
      return outputPath;
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(
    `Screenshot failed after all capture methods: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
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
