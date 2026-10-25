import { randomUUID } from "node:crypto";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  PROJECT_TODO_STATUSES,
  type ProjectTodo,
  type ProjectTodoCompose,
  type ProjectTodoImage,
  type ProjectTodoPage,
  type ProjectTodoQuery,
  type ProjectTodoSave,
  type ProjectTodoStatus,
  type ProjectTodoStatusUpdate,
  type ProjectTodoTrash,
  TODO_MAX_IMAGE_BYTES,
  TODO_MAX_IMAGES,
} from "../shared/project-todos";

type Row = {
  id: string;
  revision: number;
  project_path: string;
  text: string;
  completed: number;
  status: ProjectTodoStatus;
  created_at: string;
  updated_at: string;
  composed_at: string | null;
};
type ImageRow = { id: string; media_type: ProjectTodoImage["mediaType"]; thumbnail: string; data?: string };
const MEDIA_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** Original images are read only for editing/handoff, never in list snapshots. */
export class ProjectTodoStore {
  constructor(
    private db: DatabaseSync,
    private thumbnail: (data: Buffer) => string,
  ) {
    db.exec(`PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS project_todos (
        id TEXT PRIMARY KEY, revision INTEGER NOT NULL, project_path TEXT NOT NULL,
        text TEXT NOT NULL, completed INTEGER NOT NULL, created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL, deleted_at TEXT, composed_at TEXT,
        status TEXT NOT NULL DEFAULT 'pending'
      );
      CREATE TABLE IF NOT EXISTS project_todo_images (
        todo_id TEXT NOT NULL REFERENCES project_todos(id) ON DELETE CASCADE,
        id TEXT NOT NULL, position INTEGER NOT NULL, media_type TEXT NOT NULL,
        thumbnail TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(todo_id, id)
      );`);
    const columns = db.prepare("PRAGMA table_info(project_todos)").all() as { name: string }[];
    if (!columns.some((column) => column.name === "composed_at")) {
      db.exec("ALTER TABLE project_todos ADD COLUMN composed_at TEXT");
    }
    if (!columns.some((column) => column.name === "status")) {
      db.exec("BEGIN IMMEDIATE");
      try {
        db.exec("ALTER TABLE project_todos ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'");
        db.exec("UPDATE project_todos SET status='completed' WHERE completed=1");
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    }
    db.exec(`
      CREATE INDEX IF NOT EXISTS project_todos_active_page
        ON project_todos(completed, created_at DESC, id) WHERE deleted_at IS NULL;
      CREATE INDEX IF NOT EXISTS project_todos_project_page
        ON project_todos(project_path, completed, created_at DESC, id) WHERE deleted_at IS NULL;
    `);
    db.prepare("DELETE FROM project_todos WHERE deleted_at < ?").run(
      new Date(Date.now() - 30 * 86400_000).toISOString(),
    );
  }
  list(): ProjectTodo[] {
    const rows = this.db
      .prepare("SELECT * FROM project_todos WHERE deleted_at IS NULL ORDER BY created_at DESC, id")
      .all() as Row[];
    return rows.map((row) => this.record(row, false));
  }
  query(input: ProjectTodoQuery): ProjectTodoPage {
    const limit = input?.limit ?? 20;
    if (
      !input ||
      typeof input.completed !== "boolean" ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 50 ||
      (input.projectPath !== undefined && typeof input.projectPath !== "string") ||
      (input.search !== undefined && (typeof input.search !== "string" || input.search.length > 1000)) ||
      (input.matchingProjectPaths !== undefined &&
        (!Array.isArray(input.matchingProjectPaths) ||
          input.matchingProjectPaths.length > 1000 ||
          input.matchingProjectPaths.some((p) => typeof p !== "string"))) ||
      (input.cursor !== undefined &&
        (!input.cursor ||
          typeof input.cursor.createdAt !== "string" ||
          !input.cursor.createdAt ||
          input.cursor.createdAt.length > 100 ||
          typeof input.cursor.id !== "string" ||
          !input.cursor.id ||
          input.cursor.id.length > 200))
    ) {
      throw new Error("Invalid todo query.");
    }
    const where = ["deleted_at IS NULL"];
    const params: Array<string | number> = [];
    if (input.projectPath) {
      where.push("project_path = ?");
      params.push(input.projectPath);
    }
    const search = input.search?.trim();
    if (search) {
      // Treat LIKE metacharacters as literal search text, and bind every value.
      const pattern = `%${search.replace(/[\\%_]/g, "\\$&")}%`;
      const paths = [...new Set(input.matchingProjectPaths ?? [])];
      where.push(
        `(text LIKE ? ESCAPE '\\' OR project_path LIKE ? ESCAPE '\\'${
          paths.length ? ` OR project_path IN (${paths.map(() => "?").join(",")})` : ""
        })`,
      );
      params.push(pattern, pattern, ...paths);
    }
    const counts = { pending: 0, completed: 0 };
    const grouped = this.db
      .prepare(`SELECT completed, COUNT(*) AS count FROM project_todos
      WHERE ${where.join(" AND ")} GROUP BY completed`)
      .all(...params) as { completed: number; count: number }[];
    for (const row of grouped) counts[row.completed ? "completed" : "pending"] = row.count;
    where.push("completed = ?");
    params.push(Number(input.completed));
    if (input.cursor) {
      where.push("(created_at < ? OR (created_at = ? AND id > ?))");
      params.push(input.cursor.createdAt, input.cursor.createdAt, input.cursor.id);
    }
    const rows = this.db
      .prepare(`SELECT * FROM project_todos WHERE ${where.join(" AND ")}
      ORDER BY created_at DESC, id LIMIT ?`)
      .all(...params, limit + 1) as Row[];
    const visible = rows.slice(0, limit);
    const last = visible.at(-1);
    return {
      items: visible.map((row) => this.record(row, false)),
      nextCursor: rows.length > limit && last ? { createdAt: last.created_at, id: last.id } : null,
      counts,
      // Include orphaned project paths in the picker without loading their todos/images.
      projectPaths: (
        this.db
          .prepare(
            "SELECT DISTINCT project_path FROM project_todos WHERE deleted_at IS NULL ORDER BY project_path",
          )
          .all() as { project_path: string }[]
      ).map((row) => row.project_path),
    };
  }
  get(id: string, includeImageData = true): ProjectTodo {
    const row = this.db.prepare("SELECT * FROM project_todos WHERE id=? AND deleted_at IS NULL").get(id) as
      | Row
      | undefined;
    if (!row) throw new Error("Todo no longer exists.");
    return this.record(row, includeImageData);
  }
  readImageChunk(input: { id: string; revision: number; imageId: string; offset: number }) {
    if (!input || typeof input.id !== "string" || typeof input.imageId !== "string" ||
      !Number.isInteger(input.revision) || !Number.isInteger(input.offset) || input.offset < 0) {
      throw new Error("Invalid todo image chunk request.");
    }
    const todo = this.db.prepare("SELECT revision FROM project_todos WHERE id=? AND deleted_at IS NULL")
      .get(input.id) as { revision: number } | undefined;
    if (!todo) throw new Error("Todo no longer exists.");
    if (todo.revision !== input.revision) throw new Error("Todo changed. Reopen it before saving.");
    const row = this.db.prepare("SELECT data FROM project_todo_images WHERE todo_id=? AND id=?")
      .get(input.id, input.imageId) as { data: string } | undefined;
    if (!row) throw new Error("Todo image no longer exists.");
    const bytes = Buffer.from(row.data, "base64");
    if (input.offset > bytes.length) throw new Error("Invalid todo image chunk offset.");
    const chunk = bytes.subarray(input.offset, input.offset + 64 * 1024);
    return { data: chunk.toString("base64"), totalBytes: bytes.length, nextOffset: input.offset + chunk.length };
  }
  private record(row: Row, full: boolean): ProjectTodo {
    const images = this.db
      .prepare(
        `SELECT id, media_type, thumbnail${full ? ", data" : ""} FROM project_todo_images WHERE todo_id=? ORDER BY position`,
      )
      .all(row.id) as ImageRow[];
    return {
      id: row.id,
      revision: row.revision,
      projectPath: row.project_path,
      text: row.text,
      completed: Boolean(row.completed),
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...(row.composed_at ? { composedAt: row.composed_at } : {}),
      images: images.map((image) => ({
        id: image.id,
        mediaType: image.media_type,
        thumbnail: image.thumbnail,
        ...(image.data ? { data: image.data } : {}),
      })),
    };
  }
  save(input: ProjectTodoSave): ProjectTodo {
    if (
      !input ||
      typeof input.projectPath !== "string" ||
      !path.isAbsolute(input.projectPath) ||
      typeof input.text !== "string" ||
      input.text.length > 100_000 ||
      typeof input.completed !== "boolean" ||
      !Array.isArray(input.images) ||
      input.images.length > TODO_MAX_IMAGES
    )
      throw new Error("Invalid todo.");
    if (!input.text.trim() && !input.images.length) throw new Error("A todo needs text or an image.");
    const id = input.id ?? randomUUID();
    if (typeof id !== "string" || !id || id.length > 200) throw new Error("Invalid todo ID.");
    const existing = input.id ? this.get(id) : undefined;
    if (existing && existing.revision !== input.revision)
      throw new Error("Todo changed. Reopen it before saving.");
    // Legacy clients and completion checkboxes only change the completed flag.
    const toggledCompletion = existing && input.completed !== existing.completed &&
      (input.status === undefined || input.status === existing.status);
    const status = toggledCompletion ? (input.completed ? "completed" : "pending") :
      input.status ?? (input.completed ? "completed" : existing?.status === "in_progress" ? "in_progress" : "pending");
    if (!PROJECT_TODO_STATUSES.includes(status) || (status === "completed") !== input.completed)
      throw new Error("Invalid todo status.");
    const ids = new Set<string>();
    const images = input.images.map((image) => {
      if (
        !image ||
        typeof image.id !== "string" ||
        !image.id ||
        image.id.length > 200 ||
        ids.has(image.id) ||
        !MEDIA_TYPES.has(image.mediaType)
      )
        throw new Error("Invalid todo image.");
      ids.add(image.id);
      const previous = existing?.images.find((item) => item.id === image.id);
      if (image.data === undefined && previous?.mediaType === image.mediaType) return previous;
      if (
        typeof image.data !== "string" ||
        image.data.length > Math.ceil(TODO_MAX_IMAGE_BYTES / 3) * 4 ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(image.data)
      )
        throw new Error("Invalid todo image data.");
      const bytes = Buffer.from(image.data, "base64");
      if (!bytes.length || bytes.length > TODO_MAX_IMAGE_BYTES) throw new Error("Todo image exceeds 5 MB.");
      const prefix = "data:image/png;base64,";
      if (
        typeof image.thumbnail !== "string" ||
        !image.thumbnail.startsWith(prefix) ||
        image.thumbnail.length > 300_000
      )
        throw new Error("Invalid todo image preview.");
      const thumbnail = this.thumbnail(Buffer.from(image.thumbnail.slice(prefix.length), "base64"));
      if (!thumbnail) throw new Error("Unable to decode todo image preview.");
      return { id: image.id, mediaType: image.mediaType, data: bytes.toString("base64"), thumbnail };
    });
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(`INSERT INTO project_todos (id, revision, project_path, text, completed, created_at, updated_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET revision=excluded.revision, project_path=excluded.project_path, text=excluded.text, completed=excluded.completed, updated_at=excluded.updated_at, status=excluded.status`)
        .run(
          id,
          (existing?.revision ?? 0) + 1,
          input.projectPath,
          input.text,
          Number(input.completed),
          existing?.createdAt ?? now,
          now,
          status,
        );
      this.db.prepare("DELETE FROM project_todo_images WHERE todo_id=?").run(id);
      const insert = this.db.prepare("INSERT INTO project_todo_images VALUES (?, ?, ?, ?, ?, ?)");
      images.forEach((image, index) => {
        if (!image.data) throw new Error("Todo image data missing.");
        insert.run(id, image.id, index, image.mediaType, image.thumbnail, image.data);
      });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.record(this.db.prepare("SELECT * FROM project_todos WHERE id=?").get(id) as Row, false);
  }
  updateStatus(input: ProjectTodoStatusUpdate): ProjectTodo {
    if (!input || typeof input.id !== "string" || !input.id || !Number.isSafeInteger(input.revision) ||
      !PROJECT_TODO_STATUSES.includes(input.status)) throw new Error("Invalid todo status update.");
    const result = this.db.prepare(
      "UPDATE project_todos SET status=?, completed=?, revision=revision+1, updated_at=? WHERE id=? AND revision=? AND deleted_at IS NULL",
    ).run(input.status, Number(input.status === "completed"), new Date().toISOString(), input.id, input.revision);
    if (!result.changes) throw new Error("Todo changed or no longer exists. Read it again before updating.");
    return this.get(input.id, false);
  }
  markComposed(input: ProjectTodoCompose): ProjectTodo {
    if (!input || typeof input.id !== "string" || !input.id || !Number.isInteger(input.revision)) {
      throw new Error("Invalid todo handoff.");
    }
    // Handoff metadata does not change the content revision or invalidate image reads/edits.
    const result = this.db.prepare(
      "UPDATE project_todos SET composed_at=? WHERE id=? AND revision=? AND deleted_at IS NULL",
    ).run(new Date().toISOString(), input.id, input.revision);
    if (!result.changes) throw new Error("Todo changed. Refresh before trying again.");
    return this.get(input.id, false);
  }
  trash(input: ProjectTodoTrash): number {
    if (
      !input ||
      typeof input.id !== "string" ||
      typeof input.deleted !== "boolean" ||
      !Number.isInteger(input.revision)
    )
      throw new Error("Invalid todo deletion.");
    const result = this.db
      .prepare("UPDATE project_todos SET deleted_at=?, revision=revision+1 WHERE id=? AND revision=?")
      .run(input.deleted ? new Date().toISOString() : null, input.id, input.revision);
    if (!result.changes) throw new Error("Todo changed. Refresh before trying again.");
    return input.revision + 1;
  }
  close() {
    this.db.close();
  }
}
