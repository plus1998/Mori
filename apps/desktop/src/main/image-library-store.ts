import { randomUUID } from "node:crypto";
import { constants, existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { generationToolScopeId } from "../shared/generation-tools";
import {
  type GeneratedImageFile,
  type ImageGenerationArtifact,
  ImageGenerationError,
} from "../shared/image-generation";
import type {
  ImageLibraryBatchResult,
  ImageLibraryPage,
  ImageLibraryQuery,
  LibraryImage,
} from "../shared/image-library";
import type { ImagePayload } from "./image-generation-client";

type Row = {
  id: string;
  artifact_id: string;
  image_index: number;
  file_name: string;
  mime_type: string;
  bytes: number;
  width: number;
  height: number;
  workspace_path: string;
  thread_id: string;
  prompt: string;
  provider: LibraryImage["provider"];
  model: string;
  parameters_json: string;
  created_at: string;
  trashed_at: string | null;
  purged_at: string | null;
};

export async function createImageLibraryStore(
  dbPath: string,
  rootDir: string,
  inspect: (data: Buffer) => { width: number; height: number },
) {
  await fs.mkdir(rootDir, { recursive: true });
  const { DatabaseSync } = await import("node:sqlite");
  const store = new ImageLibraryStore(new DatabaseSync(dbPath), rootDir, inspect);
  store.initialize();
  return store;
}

/** Original bytes are application-owned. Only independent working copies leave this store. */
export class ImageLibraryStore {
  private mutations: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly db: DatabaseSync,
    private readonly rootDir: string,
    private readonly inspect: (data: Buffer) => { width: number; height: number },
    private readonly workDir = path.join(os.tmpdir(), "mori-generated-images"),
  ) {}

  initialize() {
    this.db.exec(`CREATE TABLE IF NOT EXISTS image_library (
      id TEXT PRIMARY KEY, artifact_id TEXT NOT NULL, image_index INTEGER NOT NULL,
      file_name TEXT NOT NULL, mime_type TEXT NOT NULL, bytes INTEGER NOT NULL,
      width INTEGER NOT NULL, height INTEGER NOT NULL, workspace_path TEXT NOT NULL,
      thread_id TEXT NOT NULL, prompt TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL,
      parameters_json TEXT NOT NULL, created_at TEXT NOT NULL, trashed_at TEXT, purged_at TEXT,
      UNIQUE(artifact_id, image_index)
    );
    CREATE INDEX IF NOT EXISTS image_library_created_idx ON image_library(created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS image_library_source_idx ON image_library(workspace_path, thread_id);`);
  }

  private serialize<T>(action: () => Promise<T>): Promise<T> {
    const result = this.mutations.then(action);
    this.mutations = result.catch(() => undefined);
    return result;
  }

  private row(id: string): Row {
    if (typeof id !== "string" || !id.trim()) throw new Error("图片 ID 无效。");
    const row = this.db.prepare("SELECT * FROM image_library WHERE id = ?").get(id) as Row | undefined;
    if (!row) throw new Error("图片不存在。");
    return row;
  }

  private originalPath(row: Row) {
    const ext = row.mime_type === "image/png" ? "png" : row.mime_type === "image/jpeg" ? "jpg" : "webp";
    return path.join(this.rootDir, "originals", `${row.id}.${ext}`);
  }

  private thumbnailPath(id: string) {
    return path.join(this.rootDir, "thumbnails", `${id}.png`);
  }

  private toImage(row: Row): LibraryImage {
    return {
      id: row.id,
      artifactId: row.artifact_id,
      imageIndex: row.image_index,
      fileName: row.file_name,
      mimeType: row.mime_type,
      bytes: row.bytes,
      width: row.width,
      height: row.height,
      workspacePath: row.workspace_path,
      threadId: row.thread_id,
      sourceKind:
        row.thread_id === generationToolScopeId({ workspacePath: row.workspace_path })
          ? "project"
          : "conversation",
      prompt: row.prompt,
      provider: row.provider,
      model: row.model,
      parameters: JSON.parse(row.parameters_json),
      createdAt: row.created_at,
      trashedAt: row.trashed_at,
      purgedAt: row.purged_at,
      missing: !row.purged_at && !existsSync(this.originalPath(row)),
    };
  }

  get(id: string) {
    return this.toImage(this.row(id));
  }

  saveGeneratedImage(
    artifact: ImageGenerationArtifact,
    payload: ImagePayload,
    imageIndex: number,
    fileName: string,
  ): Promise<GeneratedImageFile> {
    return this.serialize(async () => {
      let row = this.db
        .prepare("SELECT * FROM image_library WHERE artifact_id = ? AND image_index = ?")
        .get(artifact.id, imageIndex) as Row | undefined;
      if (!row) {
        const size = this.inspect(payload.bytes);
        if (size.width <= 0 || size.height <= 0) throw new Error("无法解码生成图片。");
        if (payload.bytes.length > 64 * 1024 * 1024) throw new Error("图片文件超过 64 MB 限制。");
        row = {
          id: randomUUID(),
          artifact_id: artifact.id,
          image_index: imageIndex,
          file_name: path.basename(fileName),
          mime_type: payload.mimeType,
          bytes: payload.bytes.length,
          width: size.width,
          height: size.height,
          workspace_path: artifact.workspacePath,
          thread_id: artifact.threadId,
          prompt: artifact.prompt,
          provider: artifact.provider,
          model: artifact.model,
          parameters_json: JSON.stringify(artifact.parameters),
          created_at: new Date().toISOString(),
          trashed_at: null,
          purged_at: null,
        };
        const target = this.originalPath(row);
        await this.writeAtomic(target, payload.bytes);
        try {
          this.db
            .prepare(`INSERT INTO image_library (id, artifact_id, image_index, file_name, mime_type, bytes, width, height,
            workspace_path, thread_id, prompt, provider, model, parameters_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(
              row.id,
              row.artifact_id,
              row.image_index,
              row.file_name,
              row.mime_type,
              row.bytes,
              row.width,
              row.height,
              row.workspace_path,
              row.thread_id,
              row.prompt,
              row.provider,
              row.model,
              row.parameters_json,
              row.created_at,
            );
        } catch (error) {
          await fs.rm(target, { force: true });
          throw error;
        }
      }
      // Retries reuse the original and never overwrite it with a modified working copy.
      const original = this.resolveOriginal(row.id);
      const absolutePath = path.join(this.workDir, artifact.id, row.file_name);
      const image: GeneratedImageFile = {
        libraryImageId: row.id,
        absolutePath,
        relativePath: path.relative(artifact.generationRoot, absolutePath),
        mimeType: row.mime_type,
        bytes: row.bytes,
      };
      try {
        await fs.mkdir(path.dirname(absolutePath), { recursive: true });
        await fs.copyFile(original, absolutePath);
      } catch (error) {
        throw new ImageGenerationError(
          "work_copy_failed",
          `原图已入库，创建工作副本失败：${String(error)}`,
          undefined,
          undefined,
          [image],
        );
      }
      return image;
    });
  }

  list(input: ImageLibraryQuery = {}): ImageLibraryPage {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("图片查询无效。");
    if (input.trash !== undefined && typeof input.trash !== "boolean") throw new Error("回收站筛选无效。");
    for (const key of ["limit", "offset"] as const) {
      if (
        input[key] !== undefined &&
        (typeof input[key] !== "number" || !Number.isFinite(input[key]) || input[key] < 0)
      )
        throw new Error("分页参数无效。");
    }
    const clauses = [
      "purged_at IS NULL",
      input.trash === true ? "trashed_at IS NOT NULL" : "trashed_at IS NULL",
    ];
    const params: (string | number)[] = [];
    for (const [key, column] of [
      ["workspacePath", "workspace_path"],
      ["threadId", "thread_id"],
    ] as const) {
      if (input[key]) {
        if (typeof input[key] !== "string") throw new Error("图片筛选无效。");
        clauses.push(`${column} = ?`);
        params.push(input[key]);
      }
    }
    if (input.search) {
      if (typeof input.search !== "string") throw new Error("图片搜索无效。");
      clauses.push("(instr(lower(prompt), lower(?)) > 0 OR instr(lower(file_name), lower(?)) > 0)");
      params.push(input.search, input.search);
    }
    for (const [key, operator] of [
      ["fromDate", ">="],
      ["toDate", "<="],
    ] as const) {
      if (!input[key]) continue;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(input[key])) throw new Error("日期筛选无效。");
      clauses.push(`date(created_at, 'localtime') ${operator} ?`);
      params.push(input[key]);
    }
    const where = clauses.join(" AND ");
    const totals = this.db
      .prepare(`SELECT COUNT(*) AS total, COALESCE(SUM(bytes), 0) AS bytes FROM image_library WHERE ${where}`)
      .get(...params) as { total: number; bytes: number };
    const limit = Math.max(1, Math.min(100, input.limit === undefined ? 48 : Math.floor(input.limit)));
    const offset = Math.max(0, input.offset === undefined ? 0 : Math.floor(input.offset));
    const rows = this.db
      .prepare(
        `SELECT * FROM image_library WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as Row[];
    const facets = this.db
      .prepare(
        "SELECT DISTINCT workspace_path, thread_id FROM image_library WHERE purged_at IS NULL ORDER BY workspace_path, thread_id",
      )
      .all() as { workspace_path: string; thread_id: string }[];
    return {
      ...totals,
      items: rows.map((row) => this.toImage(row)),
      projects: [...new Set(facets.map((row) => row.workspace_path))],
      threads: facets
        .filter((row) => row.thread_id !== generationToolScopeId({ workspacePath: row.workspace_path }))
        .map((row) => ({ id: row.thread_id, workspacePath: row.workspace_path })),
    };
  }

  /** Managed images never fall back to the temporary or legacy workspace paths. */
  resolveOriginal(id: string, allowTrash = false): string {
    const row = this.row(id);
    if (row.purged_at) throw new Error("图片已删除。");
    if (row.trashed_at && !allowTrash) throw new Error("图片已移入回收站，可在图片库恢复。");
    const filePath = this.originalPath(row);
    if (!existsSync(filePath)) throw new Error("原图缺失。");
    return filePath;
  }

  async read(
    id: string,
    thumbnail: boolean,
    makeThumbnail: (data: Buffer) => Buffer,
  ): Promise<{ dataBase64: string; mimeType: string }> {
    const readOriginal = async () => {
      const original = this.resolveOriginal(id, true);
      if ((await fs.stat(original)).size > 64 * 1024 * 1024) throw new Error("图片文件超过 64 MB 限制。");
      return fs.readFile(original);
    };
    if (!thumbnail)
      return { dataBase64: (await readOriginal()).toString("base64"), mimeType: this.row(id).mime_type };
    // Limit original decoding to one thumbnail at a time, and serialize it with purge.
    return this.serialize(async () => {
      this.resolveOriginal(id, true);
      const thumbPath = this.thumbnailPath(id);
      let data: Buffer;
      try {
        data = await fs.readFile(thumbPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        data = makeThumbnail(await readOriginal());
        await this.writeAtomic(thumbPath, data);
      }
      return { dataBase64: data.toString("base64"), mimeType: "image/png" };
    });
  }

  changeState(ids: string[], action: "trash" | "restore" | "purge"): Promise<ImageLibraryBatchResult> {
    return this.serialize(async () => {
      const result: ImageLibraryBatchResult = { succeededIds: [], errors: [], freedBytes: 0 };
      for (const id of validateImageIds(ids)) {
        try {
          const row = this.row(id);
          if (action === "purge") {
            if (!row.trashed_at) throw new Error("只能彻底删除回收站中的图片。");
            for (const target of [this.thumbnailPath(id), this.originalPath(row)]) {
              try {
                const stat = await fs.stat(target);
                await fs.unlink(target);
                result.freedBytes += stat.size;
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
              }
            }
            this.db
              .prepare("UPDATE image_library SET purged_at = ? WHERE id = ? AND purged_at IS NULL")
              .run(new Date().toISOString(), id);
          } else {
            if (row.purged_at) throw new Error("图片已删除。");
            this.db
              .prepare("UPDATE image_library SET trashed_at = ? WHERE id = ?")
              .run(action === "trash" ? (row.trashed_at ?? new Date().toISOString()) : null, id);
          }
          result.succeededIds.push(id);
        } catch (error) {
          result.errors.push({ id, message: error instanceof Error ? error.message : String(error) });
        }
      }
      return result;
    });
  }

  async exportImage(id: string, targetPath: string, overwrite = false) {
    return this.serialize(async () => {
      const source = this.resolveOriginal(id, true);
      const resolved = path.resolve(targetPath);
      const root = await fs.realpath(this.rootDir);
      const parent = await fs.realpath(path.dirname(resolved));
      const assertOutside = (candidate: string) => {
        const relative = path.relative(root, candidate);
        if (
          !relative ||
          (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
        )
          throw new Error("不能将导出文件写入图片库内部。");
      };
      assertOutside(path.join(parent, path.basename(resolved)));
      try {
        assertOutside(await fs.realpath(resolved));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await fs.copyFile(source, resolved, overwrite ? 0 : constants.COPYFILE_EXCL);
    });
  }

  private async writeAtomic(target: string, data: Buffer) {
    await fs.mkdir(path.dirname(target), { recursive: true });
    const temp = `${target}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temp, data, { flag: "wx" });
      await fs.rename(temp, target);
    } finally {
      await fs.rm(temp, { force: true });
    }
  }

  close() {
    this.db.close();
  }
}

export function validateImageIds(input: unknown): string[] {
  if (
    !Array.isArray(input) ||
    !input.length ||
    input.length > 10000 ||
    input.some((id) => typeof id !== "string" || !id.trim())
  )
    throw new Error("图片 ID 列表无效。");
  return [...new Set(input)] as string[];
}
