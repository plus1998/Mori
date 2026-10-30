import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import type {
  ImageDisplayArtifact,
  ImageDisplayArtifactReadResult,
  ImageDisplaySourceKind,
  ImageDisplayToolInput,
} from "../shared/image-display";
import { IMAGE_VIEW_MAX_BYTES, ImageViewReadError, inspectImageBuffer, readImageViewFile } from "./image-view-reader";
import { fetchImageDisplayUrl } from "./image-display-fetch";

export class ImageDisplayError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ImageDisplayError";
  }
}

interface ArtifactRow {
  id: string;
  thread_id: string;
  tool_use_id: string | null;
  status: string;
  source_kind: string;
  title: string | null;
  mime_type: string;
  file_path: string;
  source_ref: string | null;
  bytes: number;
  width: number | null;
  height: number | null;
  created_at: string;
  updated_at: string;
}

export async function createImageDisplayStore(
  dbPath: string,
  rootDir: string,
): Promise<ImageDisplayStore> {
  await fs.mkdir(path.dirname(dbPath), { recursive: true });
  await fs.mkdir(rootDir, { recursive: true });
  const sqlite = await import("node:sqlite");
  const store = new ImageDisplayStore(new sqlite.DatabaseSync(dbPath), rootDir);
  store.initialize();
  return store;
}

export class ImageDisplayStore {
  /** Avoid re-reading the same artifact file on every chunked RPC. */
  private readonly fileCache = new Map<string, Buffer>();
  private readonly thumbnailCache = new Map<string, Promise<ImageDisplayArtifactReadResult>>();

  constructor(
    private readonly db: DatabaseSyncType,
    private readonly rootDir: string,
  ) {}

  initialize(): void {
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS image_display_artifacts (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        tool_use_id TEXT,
        status TEXT NOT NULL CHECK(status IN ('completed', 'failed')),
        source_kind TEXT NOT NULL CHECK(source_kind IN ('path', 'url', 'base64')),
        title TEXT,
        mime_type TEXT NOT NULL,
        file_path TEXT NOT NULL,
        source_ref TEXT,
        bytes INTEGER NOT NULL,
        width INTEGER,
        height INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS image_display_artifacts_thread_idx
        ON image_display_artifacts (thread_id, created_at DESC);
    `);
  }

  async ingestFromToolInput(input: {
    threadId: string;
    toolUseId?: string;
    toolInput: ImageDisplayToolInput;
    signal?: AbortSignal;
  }): Promise<ImageDisplayArtifact> {
    input.signal?.throwIfAborted();
    const normalized = normalizeImageDisplayToolInput(input.toolInput);
    const loaded = await loadImageDisplayBytes(normalized, input.signal);
    input.signal?.throwIfAborted();
    const artifactId = randomUUID();
    // Personal browser scopes contain ':' which is not a valid Windows filename.
    const threadDir = path.join(this.rootDir, encodeURIComponent(input.threadId.trim()));
    await fs.mkdir(threadDir, { recursive: true });
    const extension = extensionForMimeType(loaded.mimeType);
    const filePath = path.join(threadDir, `${artifactId}${extension}`);
    await fs.writeFile(filePath, loaded.data);
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO image_display_artifacts (
          id, thread_id, tool_use_id, status, source_kind, title, mime_type, file_path,
          source_ref, bytes, width, height, created_at, updated_at
        ) VALUES (?, ?, ?, 'completed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        artifactId,
        input.threadId.trim(),
        input.toolUseId ?? null,
        normalized.source,
        normalized.title ?? null,
        loaded.mimeType,
        filePath,
        normalized.sourceRef ?? null,
        loaded.bytes,
        loaded.width ?? null,
        loaded.height ?? null,
        now,
        now,
      );
    return this.getArtifact(artifactId);
  }

  getArtifact(id: string): ImageDisplayArtifact {
    const row = this.db
      .prepare("SELECT * FROM image_display_artifacts WHERE id = ?")
      .get(id.trim()) as unknown as ArtifactRow | undefined;
    if (!row) {
      throw new ImageDisplayError("not_found", `图片展示产物不存在：${id}`);
    }
    return toArtifact(row);
  }

  listArtifacts(threadId: string): ImageDisplayArtifact[] {
    const id = threadId.trim();
    if (!id) {
      throw new ImageDisplayError("invalid_thread", "threadId 不能为空。");
    }
    const rows = this.db
      .prepare(
        "SELECT * FROM image_display_artifacts WHERE thread_id = ? ORDER BY created_at DESC, id DESC",
      )
      .all(id) as unknown as ArtifactRow[];
    return rows.map(toArtifact);
  }

  getArtifactByToolUseId(toolUseId: string): ImageDisplayArtifact | undefined {
    const id = toolUseId.trim();
    if (!id) {
      return undefined;
    }
    const row = this.db
      .prepare(
        `SELECT * FROM image_display_artifacts
         WHERE tool_use_id = ?
         ORDER BY created_at DESC, id DESC
         LIMIT 1`,
      )
      .get(id) as unknown as ArtifactRow | undefined;
    return row ? toArtifact(row) : undefined;
  }

  getLatestArtifact(threadId: string): ImageDisplayArtifact | undefined {
    return this.listArtifacts(threadId)[0];
  }

  async readArtifactFile(
    artifactId: string,
    options?: { offset?: number; length?: number },
  ): Promise<{
    dataBase64: string;
    mimeType: string;
    path: string;
    fileName: string;
    bytes: number;
    totalBytes: number;
    offset: number;
    chunkBytes: number;
    width?: number;
    height?: number;
  }> {
    const artifact = this.getArtifact(artifactId);
    let data = this.fileCache.get(artifactId);
    if (!data) {
      data = await fs.readFile(artifact.filePath);
      if (data.length > IMAGE_VIEW_MAX_BYTES) {
        throw new ImageDisplayError("too_large", "图片超过 20 MB，无法在 Feed 中预览。");
      }
      this.fileCache.set(artifactId, data);
    }
    const totalBytes = data.length;
    const offset =
      typeof options?.offset === "number" && Number.isFinite(options.offset)
        ? Math.max(0, Math.floor(options.offset))
        : 0;
    if (offset > totalBytes) {
      throw new ImageDisplayError("invalid_artifact", "分片偏移超出文件大小。");
    }
    const length =
      typeof options?.length === "number" && Number.isFinite(options.length)
        ? Math.max(0, Math.floor(options.length))
        : undefined;
    const end = length === undefined ? totalBytes : Math.min(offset + length, totalBytes);
    const slice = length === undefined && offset === 0 ? data : data.subarray(offset, end);
    return {
      dataBase64: slice.toString("base64"),
      mimeType: artifact.mimeType,
      path: artifact.filePath,
      fileName: path.basename(artifact.filePath),
      bytes: totalBytes,
      totalBytes,
      offset,
      chunkBytes: slice.length,
      ...(artifact.width !== undefined ? { width: artifact.width } : {}),
      ...(artifact.height !== undefined ? { height: artifact.height } : {}),
    };
  }

  readArtifactThumbnail(
    artifactId: string,
    createThumbnail: (bytes: Buffer) => { data: Buffer; width: number; height: number },
  ): Promise<ImageDisplayArtifactReadResult> {
    const id = artifactId.trim();
    const cached = this.thumbnailCache.get(id);
    if (cached) return cached;
    const preview = (async () => {
      const artifact = this.getArtifact(id);
      const stat = await fs.stat(artifact.filePath);
      if (stat.size > IMAGE_VIEW_MAX_BYTES)
        throw new ImageDisplayError("too_large", "图片超过 20 MB，无法生成缩略图。");
      // Cache only the small preview, not every original shown in the history list.
      const bytes = this.fileCache.get(id) ?? (await fs.readFile(artifact.filePath));
      if (bytes.length > IMAGE_VIEW_MAX_BYTES)
        throw new ImageDisplayError("too_large", "图片超过 20 MB，无法生成缩略图。");
      const thumbnail = createThumbnail(bytes);
      return {
        dataBase64: thumbnail.data.toString("base64"),
        mimeType: "image/png",
        path: artifact.filePath,
        fileName: path.basename(artifact.filePath),
        bytes: thumbnail.data.length,
        width: thumbnail.width,
        height: thumbnail.height,
      };
    })();
    this.thumbnailCache.set(id, preview);
    if (this.thumbnailCache.size > 64) {
      const oldest = this.thumbnailCache.keys().next().value;
      if (oldest) this.thumbnailCache.delete(oldest);
    }
    void preview.catch(() => {
      if (this.thumbnailCache.get(id) === preview) this.thumbnailCache.delete(id);
    });
    return preview;
  }

  close(): void {
    this.fileCache.clear();
    this.thumbnailCache.clear();
    this.db.close();
  }
}

export function normalizeImageDisplayToolInput(input: ImageDisplayToolInput): NormalizedImageDisplayInput {
  const source = input.source;
  if (source !== "path" && source !== "url" && source !== "base64") {
    throw new ImageDisplayError("invalid_source", "source 必须是 path、url 或 base64。");
  }
  const title = typeof input.title === "string" && input.title.trim() ? input.title.trim() : undefined;
  if (source === "path") {
    const imagePath = typeof input.path === "string" ? input.path.trim() : "";
    if (!imagePath || !path.isAbsolute(imagePath)) {
      throw new ImageDisplayError("invalid_path", "path 必须是绝对路径。");
    }
    return { source, path: imagePath, ...(title ? { title } : {}), sourceRef: imagePath };
  }
  if (source === "url") {
    const url = typeof input.url === "string" ? input.url.trim() : "";
    if (!url || !/^https:\/\//i.test(url)) {
      throw new ImageDisplayError("invalid_url", "url 必须是 HTTPS 地址。");
    }
    return { source, url, ...(title ? { title } : {}), sourceRef: url };
  }
  const data = typeof input.data === "string" ? input.data.trim() : "";
  if (!data) {
    throw new ImageDisplayError("invalid_data", "base64 来源需要提供 data。");
  }
  const mimeType =
    typeof input.mimeType === "string" && input.mimeType.trim() ? input.mimeType.trim() : undefined;
  return { source, data, ...(mimeType ? { mimeType } : {}), ...(title ? { title } : {}) };
}

interface NormalizedImageDisplayInput {
  source: ImageDisplaySourceKind;
  path?: string;
  url?: string;
  data?: string;
  mimeType?: string;
  title?: string;
  sourceRef?: string;
}

async function loadImageDisplayBytes(
  input: NormalizedImageDisplayInput,
  signal?: AbortSignal,
): Promise<{
  data: Buffer;
  mimeType: string;
  bytes: number;
  width?: number;
  height?: number;
}> {
  try {
    if (input.source === "path" && input.path) {
      signal?.throwIfAborted();
      const file = await readImageViewFile(input.path);
      signal?.throwIfAborted();
      return {
        data: Buffer.from(file.dataBase64, "base64"),
        mimeType: file.mimeType,
        bytes: file.bytes,
        width: file.width,
        height: file.height,
      };
    }
    if (input.source === "url" && input.url) {
      const fetched = await fetchImageDisplayUrl(input.url, signal);
      const inspected = inspectImageBuffer(fetched.data);
      return {
        data: fetched.data,
        mimeType: inspected.mimeType,
        bytes: inspected.bytes,
        width: inspected.width,
        height: inspected.height,
      };
    }
    if (input.source === "base64" && input.data) {
      const raw = input.data.replace(/^data:[^;]+;base64,/iu, "").replace(/\s+/gu, "");
      const data = Buffer.from(raw, "base64");
      if (!data.length) {
        throw new ImageDisplayError("invalid_data", "base64 数据无效。");
      }
      const inspected = inspectImageBuffer(data);
      if (input.mimeType && !input.mimeType.startsWith("image/")) {
        throw new ImageDisplayError("invalid_mime", "mimeType 必须是 image/*。");
      }
      return {
        data,
        mimeType: input.mimeType?.startsWith("image/") ? input.mimeType : inspected.mimeType,
        bytes: inspected.bytes,
        width: inspected.width,
        height: inspected.height,
      };
    }
    throw new ImageDisplayError("invalid_source", "无法解析图片来源。");
  } catch (error) {
    if (error instanceof ImageDisplayError || error instanceof ImageViewReadError) {
      throw error;
    }
    throw new ImageDisplayError(
      "load_failed",
      error instanceof Error ? error.message : String(error),
    );
  }
}

function extensionForMimeType(mimeType: string): string {
  switch (mimeType) {
    case "image/jpeg":
      return ".jpg";
    case "image/gif":
      return ".gif";
    case "image/webp":
      return ".webp";
    case "image/svg+xml":
      return ".svg";
    case "image/x-icon":
      return ".ico";
    case "image/bmp":
      return ".bmp";
    default:
      return ".png";
  }
}

function toArtifact(row: ArtifactRow): ImageDisplayArtifact {
  return {
    id: row.id,
    threadId: row.thread_id,
    ...(row.tool_use_id ? { toolUseId: row.tool_use_id } : {}),
    status: row.status === "failed" ? "failed" : "completed",
    sourceKind: row.source_kind as ImageDisplaySourceKind,
    ...(row.title ? { title: row.title } : {}),
    mimeType: row.mime_type,
    filePath: row.file_path,
    ...(row.source_ref ? { sourceRef: row.source_ref } : {}),
    bytes: row.bytes,
    ...(row.width != null ? { width: row.width } : {}),
    ...(row.height != null ? { height: row.height } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
