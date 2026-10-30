/**
 * CDP smoke: image display IPC + readImageDisplay round-trip.
 */
import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { createImageDisplayStore } from "../src/main/image-display-store";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

const SMOKE_THREAD_ID = "thr_cdp_image_display_smoke";
const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".smoke-artifacts");
mkdirSync(outDir, { recursive: true });

const failures = [];

function assert(condition, message) {
  if (!condition) {
    failures.push(message);
    console.error("[image-display-smoke] FAIL:", message);
    return false;
  }
  console.log("[image-display-smoke] OK:", message);
  return true;
}

async function resolveCdpUrl() {
  if (process.env.ECO_DEV_CDP_URL?.trim()) {
    return process.env.ECO_DEV_CDP_URL.trim();
  }
  for (const port of [9333, 9334, 9335, 9344]) {
    try {
      const version = await fetch(`http://127.0.0.1:${port}/json/version`, {
        signal: AbortSignal.timeout(1500),
      });
      if (version.ok) {
        return `http://127.0.0.1:${port}`;
      }
    } catch {
      // try next port
    }
  }
  throw new Error("No Mori dev CDP endpoint on 9333/9334/9335/9344");
}

function devUserDataDir() {
  const appData = process.env.APPDATA?.trim();
  if (!appData) {
    throw new Error("APPDATA is required to locate dev userData on Windows.");
  }
  return path.join(appData, "@eco", "desktopDev");
}

async function seedArtifact() {
  const userData = devUserDataDir();
  const dbPath = path.join(userData, "eco-coding.sqlite");
  const filesDir = path.join(userData, "image-display");
  const store = await createImageDisplayStore(dbPath, filesDir);
  try {
    const artifact = await store.ingestFromToolInput({
      threadId: SMOKE_THREAD_ID,
      toolInput: {
        source: "base64",
        data: PNG.toString("base64"),
        mimeType: "image/png",
        title: "CDP smoke pixel",
      },
    });
    return artifact.id;
  } finally {
    store.close();
  }
}

const artifactId = await seedArtifact();
console.log("[image-display-smoke] seeded artifact:", artifactId);

const cdpUrl = await resolveCdpUrl();
console.log("[image-display-smoke] CDP:", cdpUrl);

const browser = await chromium.connectOverCDP(cdpUrl);
try {
  const context = browser.contexts()[0];
  const page = context?.pages().find((p) => p.url().includes("5173")) ?? context?.pages()[0];
  if (!page) {
    throw new Error("No Mori page from CDP");
  }

  console.log("[image-display-smoke] page:", page.url());
  await page.waitForFunction(() => typeof window.eco !== "undefined", undefined, { timeout: 30_000 });

  const ipc = await page.evaluate(async ({ artifactId: id, threadId }) => {
    const eco = window.eco;
    if (!eco?.readImageDisplay) {
      return { hasReadApi: false };
    }
    const invalid = await eco.readImageDisplay({ artifactId: "not-a-valid-id" });
    const read = await eco.readImageDisplay({ artifactId: id });
    const listed = eco.listImageDisplayArtifacts
      ? await eco.listImageDisplayArtifacts(threadId)
      : [];
    return {
      hasReadApi: true,
      invalidOk: invalid.ok === false,
      invalidCode: invalid.ok === false ? invalid.code : null,
      readOk: read.ok,
      readMime: read.ok ? read.mimeType : null,
      readBytes: read.ok ? read.bytes : null,
      listedCount: Array.isArray(listed) ? listed.length : -1,
    };
  }, { artifactId, threadId: SMOKE_THREAD_ID });

  assert(ipc.hasReadApi, "preload exposes readImageDisplay");
  assert(ipc.invalidOk, "invalid artifactId returns ok:false");
  assert(ipc.invalidCode === "invalid_artifact" || ipc.invalidCode === "not_found", "invalid artifact error code");
  assert(ipc.readOk === true, "readImageDisplay returns seeded artifact");
  assert(ipc.readMime === "image/png", "artifact mimeType is image/png");
  assert(ipc.readBytes === PNG.length, "artifact bytes match seeded PNG");
  assert(ipc.listedCount >= 1, "listImageDisplayArtifacts includes seeded artifact");

  await page.screenshot({ path: path.join(outDir, "cdp-image-display-smoke.png") });
  console.log("[image-display-smoke] screenshot:", path.join(outDir, "cdp-image-display-smoke.png"));

  if (failures.length > 0) {
    throw new Error(`Smoke failed (${failures.length}): ${failures.join("; ")}`);
  }
  console.log("[image-display-smoke] PASS");
} finally {
  await browser.close();
}
