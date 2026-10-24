import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DownloadItem } from "electron";
import type { BrowserDownload } from "../shared/browser-downloads";

interface RetainedDownload {
  metadata: BrowserDownload;
  path: string;
  item?: DownloadItem;
}

export function sanitizeBrowserDownloadName(name: string): string {
  const cleaned = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/[. ]+$/, "").slice(-120);
  if (!cleaned || /^\.+$/.test(cleaned)) return "download";
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(cleaned) ? `_${cleaned}` : cleaned;
}

/** Browser-owned temporary files, isolated by tab and download. Never re-fetches the URL. */
export class BrowserDownloads {
  private directory: string | undefined;
  private readonly files = new Map<string, RetainedDownload>();
  private disposed = false;

  constructor(private readonly changed: () => void, private readonly tempDirectory = os.tmpdir()) {}

  /** Must run synchronously inside will-download, before Electron opens its save dialog. */
  capture(browserId: string, item: DownloadItem): void {
    if (this.disposed) throw new Error("Browser download service is closed.");
    const id = `file_${randomUUID()}`;
    const name = sanitizeBrowserDownloadName(item.getFilename());
    const file: RetainedDownload = {
      path: "",
      item,
      metadata: {
        id, browserId, name,
        mimeType: item.getMimeType() || "application/octet-stream",
        url: item.getURL(),
        receivedBytes: item.getReceivedBytes(),
        totalBytes: item.getTotalBytes(),
        state: "pending",
        createdAt: Date.now(),
      },
    };
    this.files.set(id, file);
    try {
      this.directory ??= fs.mkdtempSync(path.join(this.tempDirectory, "eco-browser-downloads-"));
      const directory = path.join(this.directory, id);
      fs.mkdirSync(directory, { mode: 0o700 });
      file.path = path.join(directory, name);
      item.setSavePath(file.path);
    } catch (error) {
      file.metadata.state = "failed";
      file.metadata.error = error instanceof Error ? error.message : String(error);
      delete file.item;
      this.changed();
      throw error;
    }
    item.on("updated", (_event, state) => {
      file.metadata.receivedBytes = item.getReceivedBytes();
      file.metadata.totalBytes = item.getTotalBytes();
      if (state === "interrupted") file.metadata.error = "Download interrupted; waiting for completion or failure.";
      else delete file.metadata.error;
      this.changed();
    });
    item.once("done", (_event, state) => {
      file.metadata.receivedBytes = item.getReceivedBytes();
      file.metadata.totalBytes = item.getTotalBytes();
      file.metadata.state = state === "completed" ? "completed" : state === "cancelled" ? "cancelled" : "failed";
      delete file.item;
      delete file.metadata.error;
      if (state === "interrupted") file.metadata.error = "Download failed before completion.";
      if (state === "completed") {
        try {
          fs.chmodSync(file.path, 0o600);
        } catch (error) {
          file.metadata.state = "failed";
          file.metadata.error = error instanceof Error ? error.message : String(error);
        }
      }
      this.changed();
    });
    this.changed();
  }

  list(browserId: string): BrowserDownload[] {
    return [...this.files.values()]
      .filter(file => file.metadata.browserId === browserId)
      .map(file => ({ ...file.metadata }));
  }

  getCompleted(browserId: string, id: string): BrowserDownload & { path: string } {
    const file = this.requireFile(browserId, id);
    if (file.metadata.state !== "completed") {
      throw new Error(`Download is ${file.metadata.state}. List files and wait for completed; do not start a duplicate download.`);
    }
    if (!fs.lstatSync(file.path).isFile()) throw new Error("Downloaded file is no longer available.");
    return { ...file.metadata, path: file.path };
  }

  cancel(browserId: string, id: string): void {
    const file = this.requireFile(browserId, id);
    if (file.metadata.state !== "pending" || !file.item) throw new Error("Download is no longer pending.");
    file.item.cancel();
  }

  async remove(browserId: string, id: string): Promise<void> {
    const file = this.requireFile(browserId, id);
    if (file.metadata.state === "pending") throw new Error("Cancel the download before deleting it.");
    // Only this retained download's private directory is removed. Keep the
    // record visible if cleanup fails so the user can retry the operation.
    if (file.path) {
      await fs.promises.rm(path.dirname(file.path), { recursive: true, force: true, maxRetries: 3 });
    }
    this.files.delete(id);
    this.changed();
  }

  async removeBrowser(browserId: string): Promise<void> {
    const directories: string[] = [];
    for (const [id, file] of this.files) {
      if (file.metadata.browserId !== browserId) continue;
      file.item?.cancel();
      this.files.delete(id);
      if (file.path) directories.push(path.dirname(file.path));
    }
    await Promise.all(directories.map(directory => fs.promises.rm(directory, { recursive: true, force: true, maxRetries: 3 })));
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    for (const file of this.files.values()) file.item?.cancel();
    this.files.clear();
    if (this.directory) await fs.promises.rm(this.directory, { recursive: true, force: true, maxRetries: 3 });
  }

  private requireFile(browserId: string, id: string): RetainedDownload {
    const file = this.files.get(id);
    if (!file || file.metadata.browserId !== browserId) throw new Error("File ID does not belong to this browser tab. List its files again.");
    return file;
  }
}
