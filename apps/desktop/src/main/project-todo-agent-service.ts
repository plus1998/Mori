import {
  PROJECT_TODO_STATUSES,
  type ProjectTodo,
  type ProjectTodoStatus,
  projectTodoReference,
} from "../shared/project-todos";
import type { McpToolCallResult } from "./mcp-streamable-http";
import type { ProjectTodoStore } from "./project-todo-store";

export class ProjectTodoAgentService {
  private readonly grants = new Map<string, Set<string>>();
  constructor(
    private readonly deps: {
      store: Pick<ProjectTodoStore, "list" | "get" | "save" | "updateStatus" | "markComposed">;
      workspacePath(threadId: string): string;
      changed(): void;
    },
  ) {}

  references() {
    return this.deps.store.list().map(projectTodoReference);
  }

  resolveReference(threadId: string, id: string) {
    const todo = this.deps.store.get(id, false);
    this.deps.store.markComposed({ id: todo.id, revision: todo.revision });
    this.deps.changed();
    const grants = this.grants.get(threadId) ?? new Set<string>();
    grants.add(id);
    this.grants.set(threadId, grants);
    return {
      type: "todo",
      ...this.summary(todo),
      readTool: "eco_context.read_todo",
      statusTool: "eco_context.update_todo_status",
    };
  }

  disposeThread(threadId: string) {
    this.grants.delete(threadId);
  }

  private summary(todo: ProjectTodo) {
    return {
      todoId: todo.id,
      revision: todo.revision,
      projectPath: todo.projectPath,
      text: todo.text.slice(0, 500),
      textTruncated: todo.text.length > 500,
      status: todo.status,
      imageCount: todo.images.length,
      updatedAt: todo.updatedAt,
    };
  }
  private scopedTodo(threadId: string, id: unknown, images = false) {
    if (typeof id !== "string" || !id.trim()) throw new Error("todoId 必须是非空字符串。");
    const todo = this.deps.store.get(id, images);
    if (todo.projectPath !== this.deps.workspacePath(threadId) && !this.grants.get(threadId)?.has(id))
      throw new Error("只能操作当前项目的待办，或用户在当前会话中通过 @待办 明确引用的条目。");
    return todo;
  }
  private status(value: unknown): ProjectTodoStatus {
    if (!PROJECT_TODO_STATUSES.includes(value as ProjectTodoStatus))
      throw new Error("status 必须是 pending、in_progress 或 completed。");
    return value as ProjectTodoStatus;
  }
  private integer(value: unknown, defaultValue: number, max: number, min = 0) {
    const result = value ?? defaultValue;
    if (!Number.isSafeInteger(result) || Number(result) < min || Number(result) > max)
      throw new Error(`分页参数必须是 ${min}–${max} 之间的整数。`);
    return Number(result);
  }
  invoke(threadId: string, name: string, args: Record<string, unknown>): McpToolCallResult {
    let result: unknown;
    if (name === "list_todos") {
      const workspace = this.deps.workspacePath(threadId);
      if (args.query !== undefined && typeof args.query !== "string") throw new Error("query 必须是字符串。");
      const query = (args.query as string | undefined)?.trim().toLocaleLowerCase() ?? "";
      const status = args.status === undefined ? undefined : this.status(args.status);
      const offset = this.integer(args.offset, 0, Number.MAX_SAFE_INTEGER);
      const limit = this.integer(args.limit, 20, 50, 1);
      const rows = this.deps.store
        .list()
        .filter(
          (todo) =>
            todo.projectPath === workspace &&
            (!status || todo.status === status) &&
            (!query || todo.text.toLocaleLowerCase().includes(query)),
        );
      const end = Math.min(rows.length, offset + limit);
      result = {
        projectPath: workspace,
        items: rows.slice(offset, end).map((todo) => this.summary(todo)),
        hasMore: end < rows.length,
        ...(end < rows.length ? { nextOffset: end } : {}),
      };
    } else if (name === "read_todo") {
      if (args.includeImages !== undefined && typeof args.includeImages !== "boolean")
        throw new Error("includeImages 必须是布尔值。");
      const todo = this.scopedTodo(threadId, args.todoId, args.includeImages === true);
      const offset = this.integer(args.offset, 0, Number.MAX_SAFE_INTEGER);
      const limit = this.integer(args.limit, 8000, 16000, 1);
      const characters = Array.from(todo.text);
      const end = Math.min(characters.length, offset + limit);
      result = {
        ...this.summary(todo),
        text: characters.slice(offset, end).join(""),
        textTruncated: end < characters.length,
        totalCharacters: characters.length,
        ...(end < characters.length ? { nextOffset: end } : {}),
        images: todo.images.map((image) => ({ imageId: image.id, mediaType: image.mediaType })),
      };
      const content: McpToolCallResult["content"] = [{ type: "text", text: JSON.stringify(result) }];
      if (args.includeImages === true)
        for (const image of todo.images) {
          if (!image.data) throw new Error("待办图片数据缺失。");
          content.push({ type: "image", data: image.data, mimeType: image.mediaType });
        }
      return { content };
    } else if (name === "create_todo") {
      if (typeof args.text !== "string" || !args.text.trim()) throw new Error("text 必须是非空字符串。");
      const status = args.status === undefined ? "pending" : this.status(args.status);
      const todo = this.deps.store.save({
        projectPath: this.deps.workspacePath(threadId),
        text: args.text,
        images: [],
        status,
        completed: status === "completed",
      });
      this.deps.changed();
      result = this.summary(todo);
    } else if (name === "update_todo_status") {
      const todo = this.scopedTodo(threadId, args.todoId);
      if (!Number.isSafeInteger(args.revision) || Number(args.revision) < 1)
        throw new Error("请提供读取待办时返回的 revision。");
      const updated = this.deps.store.updateStatus({
        id: todo.id,
        revision: Number(args.revision),
        status: this.status(args.status),
      });
      this.deps.changed();
      result = this.summary(updated);
    } else throw new Error("未知待办工具。");
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  }
}
