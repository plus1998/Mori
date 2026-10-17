import { afterEach, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DownloadItem } from "electron";
import { BrowserDownloads, sanitizeBrowserDownloadName } from "../src/main/browser-downloads";

class Download extends EventEmitter {
  savedPath = "";
  received = 0;
  total = 0;
  constructor(readonly name = "report.pdf", readonly url = "blob:https://example.test/report") { super(); }
  getFilename() { return this.name; }
  getURL() { return this.url; }
  getMimeType() { return "application/pdf"; }
  getReceivedBytes() { return this.received; }
  getTotalBytes() { return this.total; }
  setSavePath(value: string) { this.savedPath = value; }
  cancel() { this.emit("done", {}, "cancelled"); }
  complete(text = "pdf bytes") {
    fs.writeFileSync(this.savedPath, text);
    this.received = Buffer.byteLength(text);
    this.emit("done", {}, "completed");
  }
  asItem() { return this as unknown as DownloadItem; }
}

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const run of cleanup.splice(0)) await run(); });

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "eco-download-test-"));
  const downloads = new BrowserDownloads(() => {}, root);
  cleanup.push(async () => { await downloads.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, downloads };
}

test("sets save path synchronously and only exposes completed files", () => {
  const { downloads } = setup();
  const item = new Download();
  downloads.capture("tab-a", item.asItem());
  expect(path.isAbsolute(item.savedPath)).toBe(true);
  const [file] = downloads.list("tab-a");
  expect(file).toMatchObject({ state: "pending", name: "report.pdf", url: item.url });
  expect(file).not.toHaveProperty("path");
  expect(() => downloads.getCompleted("tab-a", file!.id)).toThrow("pending");
  item.complete();
  expect(downloads.getCompleted("tab-a", file!.id).path).toBe(item.savedPath);
  if (process.platform !== "win32") expect(fs.statSync(item.savedPath).mode & 0o777).toBe(0o600);
});

test("same filenames have separate paths and files cannot cross tabs", () => {
  const { downloads } = setup();
  const a = new Download("../report.pdf"), b = new Download("../report.pdf");
  downloads.capture("tab-a", a.asItem());
  downloads.capture("tab-b", b.asItem());
  expect(a.savedPath).not.toBe(b.savedPath);
  expect(path.basename(a.savedPath)).toBe(".._report.pdf");
  a.complete("one"); b.complete("two");
  const [file] = downloads.list("tab-a");
  expect(() => downloads.getCompleted("tab-b", file!.id)).toThrow("does not belong");
  expect(fs.readFileSync(a.savedPath, "utf8")).toBe("one");
});

test("interruption is not completion, cancellation and terminal failure stay explicit", () => {
  const { downloads } = setup();
  const item = new Download();
  downloads.capture("tab", item.asItem());
  item.received = 42;
  item.emit("updated", {}, "interrupted");
  const [file] = downloads.list("tab");
  expect(file).toMatchObject({ state: "pending", receivedBytes: 42 });
  downloads.cancel("tab", file!.id);
  expect(downloads.list("tab")[0]!.state).toBe("cancelled");
  const failed = new Download();
  downloads.capture("tab", failed.asItem());
  failed.emit("done", {}, "interrupted");
  expect(downloads.list("tab")[1]!.state).toBe("failed");
});

test("closing a tab cancels its pending downloads and removes only its files", async () => {
  const { downloads } = setup();
  const a = new Download(), b = new Download();
  downloads.capture("tab-a", a.asItem()); downloads.capture("tab-b", b.asItem());
  b.complete();
  let cancelled = false;
  a.on("done", () => { cancelled = true; });
  await downloads.removeBrowser("tab-a");
  expect(cancelled).toBe(true);
  expect(downloads.list("tab-a")).toEqual([]);
  expect(fs.existsSync(path.dirname(a.savedPath))).toBe(false);
  expect(fs.existsSync(b.savedPath)).toBe(true);
});

test("storage failures leave a visible failed download rather than an invented path", () => {
  const { root } = setup();
  const downloads = new BrowserDownloads(() => {}, path.join(root, "missing"));
  const item = new Download();
  expect(() => downloads.capture("tab", item.asItem())).toThrow();
  expect(item.savedPath).toBe("");
  expect(downloads.list("tab")[0]).toMatchObject({ state: "failed" });
  expect(downloads.list("tab")[0]!.error).toBeTruthy();
});

test("download names reject path separators, control characters and Windows device names", () => {
  expect(sanitizeBrowserDownloadName("..\\..\\evil\u0000.txt")).toBe(".._.._evil_.txt");
  expect(sanitizeBrowserDownloadName("CON.txt")).toBe("_CON.txt");
  expect(sanitizeBrowserDownloadName("... ")).toBe("download");
  expect(sanitizeBrowserDownloadName("中文报告.pdf")).toBe("中文报告.pdf");
});
