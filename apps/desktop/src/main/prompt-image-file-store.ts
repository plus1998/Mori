import { createHash, randomUUID } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { PromptImageAttachment } from "../shared/ipc";

const STORE_DIR_NAME = "prompt-images";
const SPOOL_DIR_NAME = "spool";
const MESSAGES_DIR_NAME = "messages";
const OBJECTS_DIR_NAME = "objects";
const CONTENT_REF_PREFIX = "sha256:";
const DEFAULT_READ_CHUNK_BYTES = 64 * 1024;
const DEFAULT_GC_GRACE_MS = 24 * 60 * 60 * 1000;
/** Matches mobile remote uploads; desktop renderer still caps picks at 5 MB. */
export const PROMPT_IMAGE_UPLOAD_MAX_BYTES = 20 * 1024 * 1024;

const MEDIA_TYPE_EXTENSION: Record<PromptImageAttachment["mediaType"], string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
};

export interface PromptImageObjectGcResult {
  scanned: number;
  retainedReferenced: number;
  retainedRecent: number;
  removed: number;
  dryRun: boolean;
}

export function isPromptImageContentRef(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value.trim());
}

/** Collect durable image references from a JSON-compatible V2 payload. */
export function collectPromptImageContentRefs(
  value: unknown,
  refs: Set<string> = new Set<string>(),
): Set<string> {
  if (typeof value === "string") {
    for (const match of value.matchAll(/sha256:[0-9a-f]{64}/g)) {
      refs.add(match[0]);
    }
    return refs;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectPromptImageContentRefs(entry, refs);
    return refs;
  }
  if (value && typeof value === "object") {
    for (const entry of Object.values(value)) collectPromptImageContentRefs(entry, refs);
  }
  return refs;
}

export class PromptImageFileStore {
  private readonly rootDir: string;

  constructor(userDataDir: string, options?: { rootDir?: string }) {
    this.rootDir = path.resolve(options?.rootDir ?? path.join(userDataDir, STORE_DIR_NAME));
  }

  getRootDir(): string {
    return this.rootDir;
  }

  /**
   * Validate a legacy attachment before a maintenance migration writes its V2
   * event. This is deliberately synchronous because the legacy migrator owns a
   * synchronous SQLite transaction; validation never mutates the object store.
   */
  validateAttachmentForMigration(attachment: PromptImageAttachment): void {
    const buffer = this.readAttachmentBytesForMigration(attachment);
    assertImageByteLength(buffer.length);
  }

  /**
   * Materialize a legacy attachment as a content-addressed object without
   * retaining a local path or inline bytes in the V2 event. The source file is
   * read but never moved, so a failed/restarted migration leaves its source
   * backup intact.
   */
  persistAttachmentForMigration(attachment: PromptImageAttachment): PromptImageAttachment {
    const buffer = this.readAttachmentBytesForMigration(attachment);
    assertImageByteLength(buffer.length);
    const contentRef = contentRefForBuffer(buffer);
    const suppliedRef = attachment.contentRef?.trim();
    if (suppliedRef && suppliedRef !== contentRef) {
      throw new Error("Prompt image attachment contentRef does not match its bytes.");
    }
    const objectPath = this.contentObjectPath(contentRef, attachment.mediaType);
    fsSync.mkdirSync(path.dirname(objectPath), { recursive: true });
    if (fsSync.existsSync(objectPath)) {
      const existing = fsSync.readFileSync(objectPath);
      if (contentRefForBuffer(existing) !== contentRef) {
        throw new Error("Prompt image content object hash mismatch.");
      }
    } else {
      const tempPath = `${objectPath}.${randomUUID()}.tmp`;
      try {
        fsSync.writeFileSync(tempPath, buffer, { flag: "wx" });
        fsSync.renameSync(tempPath, objectPath);
      } catch (error) {
        try {
          fsSync.unlinkSync(tempPath);
        } catch {
          // Preserve the original write/rename error.
        }
        throw error;
      }
    }
    return {
      mediaType: attachment.mediaType,
      contentRef,
      byteLength: buffer.length,
    };
  }

  isManagedPath(candidate: string): boolean {
    const resolved = path.resolve(candidate.trim());
    const root = path.resolve(this.rootDir);
    if (resolved === root) return true;
    const relative = path.relative(root, resolved);
    return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
  }

  /**
   * Resolve a legacy attachment path against the configured maintenance root.
   * Relative paths are accepted only inside that root; absolute paths must also
   * remain inside it. Returning undefined keeps callers fail-closed without
   * exposing the private storage root in a durable event.
   */
  resolveManagedPath(candidate: string): string | undefined {
    const trimmed = candidate.trim();
    if (!trimmed) return undefined;
    const resolved = path.resolve(path.isAbsolute(trimmed) ? trimmed : path.join(this.rootDir, trimmed));
    return this.isManagedPath(resolved) ? resolved : undefined;
  }

  /** Resolve an existing path without allowing a symlink to escape the root. */
  private resolveManagedExistingPath(candidate: string): string | undefined {
    const resolved = this.resolveManagedPath(candidate);
    if (!resolved) return undefined;
    try {
      const realRoot = fsSync.realpathSync(this.rootDir);
      const realPath = fsSync.realpathSync(resolved);
      return isPathWithinRoot(realRoot, realPath) ? realPath : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Validate a historical non-image attachment without making it executable in
   * the V2 prompt path. Its bytes stay in the source/native-fact audit; the
   * rebuilt message receives only opaque metadata.
   */
  validateLegacyAttachmentForMigration(attachment: Record<string, unknown>): { byteLength?: number } {
    const filePath = typeof attachment.path === "string" ? attachment.path.trim() : "";
    if (filePath) {
      const resolved = this.resolveManagedExistingPath(filePath);
      if (!resolved) throw new Error("Legacy attachment path is outside the configured attachments root.");
      const stat = fsSync.statSync(resolved);
      if (!stat.isFile()) throw new Error("Legacy attachment path is not a regular file.");
      return { byteLength: stat.size };
    }
    const inline = typeof attachment.data === "string" ? attachment.data.trim() : "";
    if (inline) {
      const buffer = decodeBase64(inline);
      if (buffer.length <= 0) throw new Error("Legacy attachment data is empty.");
      return { byteLength: buffer.length };
    }
    if (typeof attachment.id === "string" && attachment.id.trim()) return {};
    throw new Error("Legacy attachment has no verifiable path, data, or id.");
  }

  async stageComposerImage(input: {
    contextKey: string;
    imageId: string;
    mediaType: PromptImageAttachment["mediaType"];
    dataBase64: string;
  }): Promise<{ path: string; contentRef: string; byteLength: number }> {
    const data = decodeBase64(input.dataBase64);
    assertImageByteLength(data.length);
    const targetPath = this.spoolFilePath(input.contextKey, input.imageId, input.mediaType);
    await this.writeFileAtomic(targetPath, data);
    await this.unlinkIfExists(this.partialSpoolFilePath(input.contextKey, input.imageId, input.mediaType));
    return this.describePersistedFile(targetPath, input.mediaType);
  }

  async beginComposerImageUpload(input: {
    contextKey: string;
    imageId: string;
    mediaType: PromptImageAttachment["mediaType"];
    totalBytes: number;
  }): Promise<{ path: string; receivedBytes: number; complete: boolean }> {
    const totalBytes = integerAtLeast(input.totalBytes, "Image upload totalBytes");
    if (totalBytes <= 0) throw new Error("Image upload totalBytes must be positive.");
    assertImageByteLength(totalBytes);
    const targetPath = this.spoolFilePath(input.contextKey, input.imageId, input.mediaType);
    const partialPath = this.partialSpoolFilePath(input.contextKey, input.imageId, input.mediaType);
    await fs.mkdir(path.dirname(targetPath), { recursive: true });

    const existingFinal = await this.safeStatSize(targetPath);
    if (existingFinal === totalBytes) {
      await this.unlinkIfExists(partialPath);
      return {
        ...(await this.describePersistedFile(targetPath, input.mediaType)),
        receivedBytes: totalBytes,
        complete: true,
      };
    }
    if (existingFinal !== undefined) await this.unlinkIfExists(targetPath);

    const existingPartial = await this.safeStatSize(partialPath);
    if (existingPartial !== undefined) {
      if (existingPartial > totalBytes) {
        await this.unlinkIfExists(partialPath);
        await fs.writeFile(partialPath, Buffer.alloc(0));
        return { path: targetPath, receivedBytes: 0, complete: false };
      }
      return { path: targetPath, receivedBytes: existingPartial, complete: false };
    }
    await fs.writeFile(partialPath, Buffer.alloc(0));
    return { path: targetPath, receivedBytes: 0, complete: false };
  }

  async writeComposerImageChunk(input: {
    contextKey: string;
    imageId: string;
    mediaType: PromptImageAttachment["mediaType"];
    offset: number;
    dataBase64: string;
  }): Promise<{ receivedBytes: number }> {
    const offset = integerAtLeast(input.offset, "Image upload offset");
    const chunk = decodeBase64(input.dataBase64);
    if (chunk.length === 0) throw new Error("Image upload chunk is empty.");
    assertImageByteLength(offset + chunk.length);
    const targetPath = this.spoolFilePath(input.contextKey, input.imageId, input.mediaType);
    const partialPath = this.partialSpoolFilePath(input.contextKey, input.imageId, input.mediaType);
    const finalSize = await this.safeStatSize(targetPath);
    if (finalSize !== undefined) return { receivedBytes: finalSize };
    const current = (await this.safeStatSize(partialPath)) ?? 0;
    if (offset !== current) {
      throw new Error(`Image upload offset mismatch: expected ${current}, got ${offset}.`);
    }
    await fs.mkdir(path.dirname(partialPath), { recursive: true });
    await fs.appendFile(partialPath, chunk);
    return { receivedBytes: current + chunk.length };
  }

  async finishComposerImageUpload(input: {
    contextKey: string;
    imageId: string;
    mediaType: PromptImageAttachment["mediaType"];
    totalBytes: number;
  }): Promise<{ path: string; contentRef: string; byteLength: number }> {
    const totalBytes = integerAtLeast(input.totalBytes, "Image upload totalBytes");
    if (totalBytes <= 0) throw new Error("Image upload totalBytes must be positive.");
    assertImageByteLength(totalBytes);
    const targetPath = this.spoolFilePath(input.contextKey, input.imageId, input.mediaType);
    const partialPath = this.partialSpoolFilePath(input.contextKey, input.imageId, input.mediaType);
    const finalSize = await this.safeStatSize(targetPath);
    if (finalSize === totalBytes) {
      await this.unlinkIfExists(partialPath);
      return this.describePersistedFile(targetPath, input.mediaType);
    }
    const partialSize = await this.safeStatSize(partialPath);
    if (partialSize !== totalBytes) {
      throw new Error(`Image upload incomplete: expected ${totalBytes} bytes, got ${partialSize ?? 0}.`);
    }
    await fs.rename(partialPath, targetPath);
    return this.describePersistedFile(targetPath, input.mediaType);
  }

  async releasePaths(paths: readonly string[]): Promise<void> {
    for (const rawPath of paths) {
      const filePath = rawPath.trim();
      if (!filePath || !this.isManagedPath(filePath)) continue;
      await this.unlinkIfExists(filePath);
      await this.unlinkIfExists(`${filePath}.partial`);
    }
  }

  /**
   * Remove content-addressed objects that have no durable V2 reference.
   *
   * A grace period is mandatory by default: a producer can write the object
   * before its event/command transaction commits, so an immediate sweep must
   * never race that write sequence. Only objects past the grace period can be
   * collected, so `resolveReferencedContentRefs` — which walks every durable V2
   * payload and is the expensive half of the sweep — is called only when such
   * an object exists. Callers use dryRun for maintenance previews.
   */
  async sweepUnreferencedContentObjects(input: {
    resolveReferencedContentRefs: () => Iterable<string> | Promise<Iterable<string>>;
    minAgeMs?: number;
    dryRun?: boolean;
  }): Promise<PromptImageObjectGcResult> {
    const graceMs =
      input.minAgeMs === undefined
        ? DEFAULT_GC_GRACE_MS
        : integerAtLeast(input.minAgeMs, "Image object GC minAgeMs");
    const dryRun = input.dryRun === true;
    const result: PromptImageObjectGcResult = {
      scanned: 0,
      retainedReferenced: 0,
      retainedRecent: 0,
      removed: 0,
      dryRun,
    };
    const objectsDir = path.join(this.rootDir, OBJECTS_DIR_NAME);
    let entries: Array<{ name: string; isFile(): boolean }>;
    try {
      entries = await fs.readdir(objectsDir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return result;
      throw error;
    }
    const cutoff = Date.now() - graceMs;
    const objects: Array<{ contentRef: string; filePath: string; mtimeMs: number }> = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const match = /^([0-9a-f]{64})\.(jpg|png|gif|webp)$/.exec(entry.name);
      if (!match) continue;
      result.scanned += 1;
      const filePath = path.join(objectsDir, entry.name);
      const stat = await fs.stat(filePath);
      objects.push({
        contentRef: `${CONTENT_REF_PREFIX}${match[1]}`,
        filePath,
        mtimeMs: stat.mtimeMs,
      });
    }
    // Nothing is old enough to collect, so this sweep cannot delete anything
    // and never needs to know which refs are live.
    if (!objects.some((object) => object.mtimeMs <= cutoff)) {
      result.retainedRecent = objects.length;
      return result;
    }
    const referenced = new Set(
      [...(await input.resolveReferencedContentRefs())]
        .map((value) => value.trim())
        .filter((value) => isPromptImageContentRef(value)),
    );
    for (const object of objects) {
      if (referenced.has(object.contentRef)) {
        result.retainedReferenced += 1;
        continue;
      }
      if (object.mtimeMs > cutoff) {
        result.retainedRecent += 1;
        continue;
      }
      if (!dryRun) {
        await this.unlinkIfExists(object.filePath);
      }
      result.removed += 1;
    }
    return result;
  }

  async deleteSpoolContext(contextKey: string): Promise<void> {
    await this.removeDirectoryIfExists(this.spoolContextDir(contextKey));
  }

  async deleteThreadMessages(threadId: string): Promise<void> {
    await this.removeDirectoryIfExists(path.join(this.rootDir, MESSAGES_DIR_NAME, sanitizeSegment(threadId)));
  }

  async deleteMessageActivity(threadId: string, activityLineId: string): Promise<void> {
    await this.removeDirectoryIfExists(
      path.join(this.rootDir, MESSAGES_DIR_NAME, sanitizeSegment(threadId), sanitizeSegment(activityLineId)),
    );
  }

  async persistMessageAttachments(
    threadId: string,
    activityLineId: string,
    attachments: readonly PromptImageAttachment[],
  ): Promise<PromptImageAttachment[]> {
    const persisted: PromptImageAttachment[] = [];
    for (const [index, attachment] of attachments.entries()) {
      const suppliedRef = attachment.contentRef?.trim();
      const imageId = `img_${index}_${stableAttachmentKey({
        threadId,
        activityLineId,
        index,
        ...(suppliedRef ? { contentRef: suppliedRef } : {}),
        ...(attachment.data ? { data: attachment.data } : {}),
      })}`;
      const targetPath = this.messageFilePath(threadId, activityLineId, imageId, attachment.mediaType);
      const sourcePath = attachment.path?.trim();
      let sourceMoved = false;
      const managedSourcePath = sourcePath ? this.resolveManagedExistingPath(sourcePath) : undefined;
      if (managedSourcePath) {
        try {
          const objectsRoot = path.join(fsSync.realpathSync(this.rootDir), OBJECTS_DIR_NAME);
          if (isPathWithinRoot(objectsRoot, managedSourcePath)) {
            // Runtime image paths may point at shared content objects. Never
            // consume an object while persisting another message's attachment.
            await this.writeFileAtomic(targetPath, await fs.readFile(managedSourcePath));
          } else {
            await this.moveOrCopy(managedSourcePath, targetPath);
          }
          sourceMoved = true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      if (!sourceMoved && !(await this.fileExists(targetPath))) {
        const data = attachment.data?.trim();
        if (data) {
          await this.writeFileAtomic(targetPath, decodeBase64(data));
        } else if (suppliedRef) {
          await this.copyContentObjectToPath(suppliedRef, attachment.mediaType, targetPath);
        } else {
          throw new Error("Prompt image attachment is missing path, contentRef, and data.");
        }
      }
      const descriptor = await this.describePersistedFile(targetPath, attachment.mediaType);
      if (suppliedRef && descriptor.contentRef !== suppliedRef) {
        throw new Error("Prompt image attachment contentRef does not match its bytes.");
      }
      if (attachment.byteLength !== undefined && attachment.byteLength !== descriptor.byteLength) {
        throw new Error("Prompt image attachment byteLength does not match its bytes.");
      }
      persisted.push({ mediaType: attachment.mediaType, ...descriptor });
    }
    return persisted;
  }

  async readAttachmentData(attachment: PromptImageAttachment): Promise<string> {
    return (await this.readAttachmentBytes(attachment)).toString("base64");
  }

  async readContentRefAttachment(contentRef: string): Promise<{
    mediaType: PromptImageAttachment["mediaType"];
    dataBase64: string;
    byteLength: number;
  }> {
    const normalized = requireContentRef(contentRef);
    const mediaTypes = Object.keys(MEDIA_TYPE_EXTENSION) as PromptImageAttachment["mediaType"][];
    for (const mediaType of mediaTypes) {
      try {
        const buffer = await this.readContentObject(normalized, mediaType);
        return {
          mediaType,
          dataBase64: buffer.toString("base64"),
          byteLength: buffer.length,
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
    }
    throw new Error("Prompt image content reference was not found.");
  }

  async resolveAttachmentsForRuntime(
    attachments: readonly PromptImageAttachment[],
  ): Promise<Array<PromptImageAttachment & { data: string }>> {
    const resolved: Array<PromptImageAttachment & { data: string }> = [];
    for (const attachment of attachments) {
      const data = await this.readAttachmentData(attachment);
      // V2 retries retain only a contentRef. Give path-based image tools the
      // verified original object, which survives message/spool path cleanup.
      const contentRef = attachment.contentRef?.trim();
      const runtimePath = contentRef
        ? this.contentObjectPath(contentRef, attachment.mediaType)
        : attachment.path;
      resolved.push({
        mediaType: attachment.mediaType,
        data,
        ...(runtimePath ? { path: runtimePath } : {}),
        ...(attachment.contentRef ? { contentRef: attachment.contentRef } : {}),
        ...(attachment.byteLength !== undefined ? { byteLength: attachment.byteLength } : {}),
      });
    }
    return resolved;
  }

  async hasReadableContentRef(attachment: PromptImageAttachment): Promise<boolean> {
    const contentRef = attachment.contentRef?.trim();
    if (!contentRef || !isPromptImageContentRef(contentRef)) return false;
    try {
      await this.readContentObject(contentRef, attachment.mediaType);
      return true;
    } catch {
      return false;
    }
  }

  async readAttachmentChunk(input: {
    contentRef: string;
    mediaType: PromptImageAttachment["mediaType"];
    offset: number;
    maxBytes?: number;
  }): Promise<{
    contentRef: string;
    mediaType: PromptImageAttachment["mediaType"];
    offset: number;
    nextOffset: number;
    totalBytes: number;
    complete: boolean;
    data: string;
  }> {
    const contentRef = requireContentRef(input.contentRef);
    const offset = integerAtLeast(input.offset, "Image read offset");
    const requestedMaxBytes =
      input.maxBytes === undefined
        ? DEFAULT_READ_CHUNK_BYTES
        : integerAtLeast(input.maxBytes, "Image read maxBytes");
    if (requestedMaxBytes <= 0) throw new Error("Image read maxBytes must be positive.");
    const maxBytes = Math.min(DEFAULT_READ_CHUNK_BYTES, requestedMaxBytes);
    const buffer = await this.readContentObject(contentRef, input.mediaType);
    if (offset > buffer.length) throw new Error(`Image read offset exceeds content length: ${offset}.`);
    const nextOffset = Math.min(buffer.length, offset + maxBytes);
    return {
      contentRef,
      mediaType: input.mediaType,
      offset,
      nextOffset,
      totalBytes: buffer.length,
      complete: nextOffset >= buffer.length,
      data: buffer.subarray(offset, nextOffset).toString("base64"),
    };
  }

  collectAttachmentPaths(attachments: readonly PromptImageAttachment[] | undefined): string[] {
    if (!attachments?.length) return [];
    return attachments
      .map((attachment) => attachment.path?.trim() ?? "")
      .filter((filePath) => filePath.length > 0 && this.isManagedPath(filePath));
  }

  private async readAttachmentBytes(attachment: PromptImageAttachment): Promise<Buffer> {
    const contentRef = attachment.contentRef?.trim();
    if (contentRef) {
      if (!isPromptImageContentRef(contentRef)) throw new Error("Prompt image contentRef is invalid.");
      return this.readContentObject(contentRef, attachment.mediaType);
    }
    const filePath = attachment.path?.trim();
    const resolvedPath = filePath ? this.resolveManagedExistingPath(filePath) : undefined;
    if (resolvedPath) return fs.readFile(resolvedPath);
    const inline = attachment.data?.trim();
    if (inline) return decodeBase64(inline);
    throw new Error("Prompt image attachment is missing readable data.");
  }

  private readAttachmentBytesForMigration(attachment: PromptImageAttachment): Buffer {
    const contentRef = attachment.contentRef?.trim();
    if (contentRef) {
      if (!isPromptImageContentRef(contentRef)) throw new Error("Prompt image contentRef is invalid.");
      const buffer = fsSync.readFileSync(this.contentObjectPath(contentRef, attachment.mediaType));
      if (contentRefForBuffer(buffer) !== contentRef) {
        throw new Error("Prompt image content object hash mismatch.");
      }
      return buffer;
    }
    const filePath = attachment.path?.trim();
    if (filePath) {
      const resolvedPath = this.resolveManagedExistingPath(filePath);
      if (!resolvedPath) {
        throw new Error(
          "Legacy prompt image path is outside the configured attachments root or is unreadable.",
        );
      }
      return fsSync.readFileSync(resolvedPath);
    }
    const inline = attachment.data?.trim();
    if (inline) return decodeBase64(inline);
    throw new Error("Prompt image attachment is missing readable data.");
  }

  private async describePersistedFile(
    filePath: string,
    mediaType: PromptImageAttachment["mediaType"],
  ): Promise<{ path: string; contentRef: string; byteLength: number }> {
    const buffer = await fs.readFile(filePath);
    assertImageByteLength(buffer.length);
    const contentRef = contentRefForBuffer(buffer);
    const objectPath = this.contentObjectPath(contentRef, mediaType);
    if (!(await this.fileExists(objectPath))) {
      await this.writeFileAtomic(objectPath, buffer);
    } else if (contentRefForBuffer(await fs.readFile(objectPath)) !== contentRef) {
      throw new Error("Prompt image content object hash mismatch.");
    }
    return { path: filePath, contentRef, byteLength: buffer.length };
  }

  private async copyContentObjectToPath(
    contentRef: string,
    mediaType: PromptImageAttachment["mediaType"],
    targetPath: string,
  ): Promise<void> {
    await this.writeFileAtomic(
      targetPath,
      await this.readContentObject(requireContentRef(contentRef), mediaType),
    );
  }

  private async readContentObject(
    contentRef: string,
    mediaType: PromptImageAttachment["mediaType"],
  ): Promise<Buffer> {
    const normalized = requireContentRef(contentRef);
    const buffer = await fs.readFile(this.contentObjectPath(normalized, mediaType));
    assertImageByteLength(buffer.length);
    if (contentRefForBuffer(buffer) !== normalized)
      throw new Error("Prompt image content object hash mismatch.");
    return buffer;
  }

  private contentObjectPath(contentRef: string, mediaType: PromptImageAttachment["mediaType"]): string {
    return path.join(
      this.rootDir,
      OBJECTS_DIR_NAME,
      `${contentRef.slice(CONTENT_REF_PREFIX.length)}.${MEDIA_TYPE_EXTENSION[mediaType]}`,
    );
  }

  private spoolContextDir(contextKey: string): string {
    return path.join(this.rootDir, SPOOL_DIR_NAME, sanitizeSegment(contextKey));
  }

  private spoolFilePath(
    contextKey: string,
    imageId: string,
    mediaType: PromptImageAttachment["mediaType"],
  ): string {
    return path.join(
      this.spoolContextDir(contextKey),
      `${sanitizeSegment(imageId)}.${MEDIA_TYPE_EXTENSION[mediaType]}`,
    );
  }

  private partialSpoolFilePath(
    contextKey: string,
    imageId: string,
    mediaType: PromptImageAttachment["mediaType"],
  ): string {
    return `${this.spoolFilePath(contextKey, imageId, mediaType)}.partial`;
  }

  private async safeStatSize(filePath: string): Promise<number | undefined> {
    try {
      const stat = await fs.stat(filePath);
      return stat.isFile() ? stat.size : undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  private messageFilePath(
    threadId: string,
    activityLineId: string,
    imageId: string,
    mediaType: PromptImageAttachment["mediaType"],
  ): string {
    return path.join(
      this.rootDir,
      MESSAGES_DIR_NAME,
      sanitizeSegment(threadId),
      sanitizeSegment(activityLineId),
      `${sanitizeSegment(imageId)}.${MEDIA_TYPE_EXTENSION[mediaType]}`,
    );
  }

  private async fileExists(filePath: string): Promise<boolean> {
    try {
      const stat = await fs.stat(filePath);
      return stat.isFile();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  private async writeFileAtomic(filePath: string, data: Buffer): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.${randomUUID()}.tmp`;
    await fs.writeFile(tempPath, data, { flag: "wx" });
    await fs.rename(tempPath, filePath);
  }

  private async moveOrCopy(sourcePath: string, targetPath: string): Promise<void> {
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    try {
      await fs.rename(sourcePath, targetPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
      const data = await fs.readFile(sourcePath);
      await this.writeFileAtomic(targetPath, data);
      await this.unlinkIfExists(sourcePath);
    }
  }

  private async unlinkIfExists(filePath: string): Promise<void> {
    try {
      await fs.unlink(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private async removeDirectoryIfExists(directory: string): Promise<void> {
    try {
      await fs.rm(directory, { recursive: true, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

export function isPromptImageAttachmentRecord(value: unknown): value is PromptImageAttachment {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (
    record.mediaType !== "image/jpeg" &&
    record.mediaType !== "image/png" &&
    record.mediaType !== "image/gif" &&
    record.mediaType !== "image/webp"
  )
    return false;
  const data = typeof record.data === "string" ? record.data.trim() : "";
  const filePath = typeof record.path === "string" ? record.path.trim() : "";
  const contentRef = typeof record.contentRef === "string" ? record.contentRef.trim() : "";
  return data.length > 0 || filePath.length > 0 || isPromptImageContentRef(contentRef);
}

function stableAttachmentKey(input: {
  threadId: string;
  activityLineId: string;
  index: number;
  contentRef?: string;
  data?: string;
}): string {
  const material =
    input.contentRef?.trim() || (input.data ? contentRefForBuffer(decodeBase64(input.data)) : "unknown");
  return createHash("sha256")
    .update(`${input.threadId}\u0000${input.activityLineId}\u0000${input.index}\u0000${material}`)
    .digest("hex")
    .slice(0, 24);
}

function contentRefForBuffer(buffer: Buffer): string {
  return `${CONTENT_REF_PREFIX}${createHash("sha256").update(buffer).digest("hex")}`;
}

function isPathWithinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function assertImageByteLength(byteLength: number): void {
  if (!Number.isSafeInteger(byteLength) || byteLength <= 0 || byteLength > PROMPT_IMAGE_UPLOAD_MAX_BYTES) {
    throw new Error("Image attachment has an invalid byte length.");
  }
}

function requireContentRef(value: string): string {
  const normalized = value.trim();
  if (!isPromptImageContentRef(normalized)) throw new Error("Prompt image contentRef is invalid.");
  return normalized;
}

function integerAtLeast(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer.`);
  return value;
}

function sanitizeSegment(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("Prompt image storage key is required.");
  return trimmed.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 180);
}

function decodeBase64(value: string): Buffer {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("Prompt image data is required.");
  const normalized = trimmed.replace(/\s+/g, "");
  if (
    !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized) ||
    normalized.length % 4 === 1 ||
    (normalized.includes("=") && normalized.length % 4 !== 0)
  ) {
    throw new Error("Prompt image data must be valid base64.");
  }
  const buffer = Buffer.from(normalized, "base64");
  if (buffer.length === 0) throw new Error("Prompt image data is empty.");
  return buffer;
}
