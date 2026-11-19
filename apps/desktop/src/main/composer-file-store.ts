import fs from "node:fs/promises";
import path from "node:path";

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const MAX_FILE_NAME_LENGTH = 180;

function integerAtLeast(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer.`);
  }
  return value;
}

function safeFileName(value: string): string {
  const base = path.basename(value).trim().replace(/[\u0000-\u001f\u007f]/g, "_");
  const normalized = base || "mobile-file";
  return normalized.slice(0, MAX_FILE_NAME_LENGTH);
}

/**
 * Stores files uploaded by the mobile Composer in a private temporary area.
 * The returned path is intentionally a normal desktop path: the agent can
 * inspect it with its existing filesystem tools after the message is sent.
 */
export class ComposerFileStore {
  private readonly rootDir: string;

  constructor(userDataDir: string) {
    this.rootDir = path.resolve(userDataDir, "composer-files");
  }

  async beginUpload(input: {
    uploadId: string;
    fileName: string;
    totalBytes: number;
  }): Promise<{ path: string; receivedBytes: number; complete: boolean }> {
    const totalBytes = integerAtLeast(input.totalBytes, "File upload totalBytes");
    if (totalBytes <= 0 || totalBytes > MAX_UPLOAD_BYTES) {
      throw new Error("File upload must be between 1 byte and 100 MB.");
    }
    const targetPath = this.targetPath(input.uploadId, input.fileName);
    const partialPath = `${targetPath}.partial`;
    await fs.mkdir(path.dirname(targetPath), { recursive: true });

    const finalSize = await this.safeStatSize(targetPath);
    if (finalSize === totalBytes) {
      await this.unlinkIfExists(partialPath);
      return { path: targetPath, receivedBytes: totalBytes, complete: true };
    }
    if (finalSize !== undefined) await this.unlinkIfExists(targetPath);

    const partialSize = await this.safeStatSize(partialPath);
    if (partialSize !== undefined) {
      if (partialSize > totalBytes) {
        await fs.writeFile(partialPath, Buffer.alloc(0));
        return { path: targetPath, receivedBytes: 0, complete: false };
      }
      return { path: targetPath, receivedBytes: partialSize, complete: false };
    }
    await fs.writeFile(partialPath, Buffer.alloc(0), { flag: "wx" });
    return { path: targetPath, receivedBytes: 0, complete: false };
  }

  async writeChunk(input: {
    uploadId: string;
    fileName: string;
    offset: number;
    dataBase64: string;
  }): Promise<{ receivedBytes: number }> {
    const offset = integerAtLeast(input.offset, "File upload offset");
    const chunk = Buffer.from(input.dataBase64, "base64");
    if (chunk.length === 0) throw new Error("File upload chunk is empty.");
    if (offset + chunk.length > MAX_UPLOAD_BYTES) {
      throw new Error("File upload exceeds 100 MB.");
    }
    const targetPath = this.targetPath(input.uploadId, input.fileName);
    const partialPath = `${targetPath}.partial`;
    const finalSize = await this.safeStatSize(targetPath);
    if (finalSize !== undefined) return { receivedBytes: finalSize };
    const current = (await this.safeStatSize(partialPath)) ?? 0;
    if (offset !== current) {
      throw new Error(`File upload offset mismatch: expected ${current}, got ${offset}.`);
    }
    await fs.mkdir(path.dirname(partialPath), { recursive: true });
    await fs.appendFile(partialPath, chunk);
    return { receivedBytes: current + chunk.length };
  }

  async finishUpload(input: {
    uploadId: string;
    fileName: string;
    totalBytes: number;
  }): Promise<{ path: string; byteLength: number }> {
    const totalBytes = integerAtLeast(input.totalBytes, "File upload totalBytes");
    if (totalBytes <= 0 || totalBytes > MAX_UPLOAD_BYTES) {
      throw new Error("File upload must be between 1 byte and 100 MB.");
    }
    const targetPath = this.targetPath(input.uploadId, input.fileName);
    const partialPath = `${targetPath}.partial`;
    const finalSize = await this.safeStatSize(targetPath);
    if (finalSize === totalBytes) {
      await this.unlinkIfExists(partialPath);
      return { path: targetPath, byteLength: finalSize };
    }
    const partialSize = await this.safeStatSize(partialPath);
    if (partialSize !== totalBytes) {
      throw new Error(`File upload incomplete: expected ${totalBytes} bytes, got ${partialSize ?? 0}.`);
    }
    await fs.rename(partialPath, targetPath);
    return { path: targetPath, byteLength: totalBytes };
  }

  private targetPath(uploadId: string, fileName: string): string {
    if (!/^[A-Za-z0-9_-]{8,120}$/.test(uploadId)) {
      throw new Error("Invalid file upload id.");
    }
    return path.join(this.rootDir, uploadId, safeFileName(fileName));
  }

  private async safeStatSize(filePath: string): Promise<number | undefined> {
    try {
      const stat = await fs.stat(filePath);
      return stat.isFile() ? stat.size : undefined;
    } catch {
      return undefined;
    }
  }

  private async unlinkIfExists(filePath: string): Promise<void> {
    try {
      await fs.unlink(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

export const COMPOSER_FILE_UPLOAD_MAX_BYTES = MAX_UPLOAD_BYTES;
