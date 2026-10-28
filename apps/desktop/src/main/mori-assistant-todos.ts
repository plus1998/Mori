import { IPC_CHANNELS } from "../shared/ipc";
import {
  appendProjectTodoReference,
  PROJECT_TODO_STATUSES,
  type ProjectTodo,
  type ProjectTodoPage,
  type ProjectTodoStatus,
} from "../shared/project-todos";
import type { AssistantTool } from "./mori-assistant-runtime";

const id = { type: "string", minLength: 1 };
const revision = { type: "integer", minimum: 1 };
const status = { type: "string", enum: PROJECT_TODO_STATUSES };
const tool = (
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[] = [],
): AssistantTool => ({
  name,
  description,
  inputSchema: { type: "object", properties, required, additionalProperties: false },
});

export const MORI_TODO_TOOLS: AssistantTool[] = [
  tool(
    "mori_list_todos",
    "查询用户待办，可按项目、完成状态和关键词筛选。默认查询所有项目的未完成待办（含进行中）；completed=true 查询已完成。返回文字预览、图片数量及分页游标，继续查询时传回 nextCursor。待办与 Agent 会话内部执行计划不同。",
    {
      projectPath: id,
      completed: { type: "boolean" },
      search: { type: "string", maxLength: 1000 },
      cursor: id,
      limit: { type: "integer", minimum: 1, maximum: 50 },
    },
  ),
  tool(
    "mori_read_todo",
    "读取原始待办的最新 revision、状态、文字及图片元数据。长文字通过 nextOffset 分页；图片原文由执行 Agent 通过待办引用读取。修改、删除前先读取。",
    {
      todoId: id,
      offset: { type: "integer", minimum: 0 },
      limit: { type: "integer", minimum: 1, maximum: 16000 },
    },
    ["todoId"],
  ),
  tool(
    "mori_create_todo",
    "按用户要求在明确的项目中新增文字待办，默认 pending。projectPath 必须是绝对路径；项目不明确时先询问，不能使用助手自身工作区。",
    { projectPath: id, text: { type: "string", minLength: 1, maxLength: 100000 }, status },
    ["projectPath", "text"],
  ),
  tool(
    "mori_update_todo",
    "按用户要求修改待办文字或状态，保留原图片与所属项目。必须提供最新 revision；冲突时重新读取，不能覆盖用户的新修改。至少提供 text 或 status。仅实际完成后才能标记 completed。",
    { todoId: id, revision, text: { type: "string", maxLength: 100000 }, status },
    ["todoId", "revision"],
  ),
  tool(
    "mori_delete_todo",
    "仅按用户删除要求将指定待办移入回收状态，必须提供最新 revision；版本冲突时报错。删除不会取消已启动的 Agent 任务。",
    { todoId: id, revision },
    ["todoId", "revision"],
  ),
];

function summary(todo: ProjectTodo) {
  const characters = Array.from(todo.text);
  return {
    todoId: todo.id,
    revision: todo.revision,
    projectPath: todo.projectPath,
    status: todo.status,
    completed: todo.completed,
    text: characters.slice(0, 500).join(""),
    textTruncated: characters.length > 500,
    imageCount: todo.images.length,
    createdAt: todo.createdAt,
    updatedAt: todo.updatedAt,
  };
}

export class MoriAssistantTodos {
  constructor(
    private readonly invoke: (channel: string, args: unknown[]) => Promise<unknown>,
    private readonly projectPath: (value: string) => string,
  ) {}

  private async get(todoId: string): Promise<ProjectTodo> {
    // Keep image bytes out of the assistant context; save reuses stored images by ID.
    return (await this.invoke(IPC_CHANNELS.projectTodoGet, [todoId, false])) as ProjectTodo;
  }

  async task(todoId: string, prompt: string, signal: AbortSignal) {
    const todo = await this.get(todoId);
    signal.throwIfAborted();
    return {
      projectPath: this.projectPath(todo.projectPath),
      prompt: appendProjectTodoReference(
        prompt ||
          "请执行这个待办。先读取完整内容和附图，开始工作时更新为 in_progress，成功完成后再更新为 completed。",
        todo,
      ),
      todoId: todo.id,
    };
  }

  async call(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted();
    if (name === "mori_list_todos") {
      let cursor: ProjectTodoPage["nextCursor"] | undefined;
      if (args.cursor !== undefined) {
        try {
          cursor = JSON.parse(String(args.cursor));
        } catch {
          throw new Error("待办分页游标无效，请使用上次查询返回的 nextCursor。");
        }
        if (!cursor || typeof cursor.createdAt !== "string" || typeof cursor.id !== "string")
          throw new Error("待办分页游标无效，请使用上次查询返回的 nextCursor。");
      }
      const page = (await this.invoke(IPC_CHANNELS.projectTodoQuery, [
        {
          completed: args.completed ?? false,
          ...(args.projectPath !== undefined
            ? { projectPath: this.projectPath(String(args.projectPath)) }
            : {}),
          ...(args.search !== undefined ? { search: args.search } : {}),
          ...(args.limit !== undefined ? { limit: args.limit } : {}),
          ...(cursor ? { cursor } : {}),
        },
      ])) as ProjectTodoPage;
      return {
        items: page.items.map(summary),
        counts: page.counts,
        projectPaths: page.projectPaths,
        nextCursor: page.nextCursor ? JSON.stringify(page.nextCursor) : null,
      };
    }
    if (name === "mori_create_todo") {
      const status = (args.status ?? "pending") as ProjectTodoStatus;
      const todo = (await this.invoke(IPC_CHANNELS.projectTodoSave, [
        {
          projectPath: this.projectPath(String(args.projectPath)),
          text: args.text,
          images: [],
          completed: status === "completed",
          status,
        },
      ])) as ProjectTodo;
      return summary(todo);
    }
    const todo = await this.get(String(args.todoId));
    signal.throwIfAborted();
    if (name === "mori_read_todo") {
      const characters = Array.from(todo.text);
      const offset = Number(args.offset ?? 0);
      const end = Math.min(characters.length, offset + Number(args.limit ?? 8000));
      return {
        ...summary(todo),
        text: characters.slice(offset, end).join(""),
        textTruncated: end < characters.length,
        totalCharacters: characters.length,
        ...(end < characters.length ? { nextOffset: end } : {}),
        images: todo.images.map((image) => ({ imageId: image.id, mediaType: image.mediaType })),
      };
    }
    if (todo.revision !== args.revision) throw new Error("待办已修改，请重新读取最新 revision 后再操作。");
    if (name === "mori_delete_todo") {
      const revision = await this.invoke(IPC_CHANNELS.projectTodoTrash, [
        {
          id: todo.id,
          revision: args.revision,
          deleted: true,
        },
      ]);
      return { todoId: todo.id, revision, deleted: true };
    }
    if (name === "mori_update_todo") {
      if (args.text === undefined && args.status === undefined) throw new Error("至少提供 text 或 status。");
      const status = (args.status ?? todo.status) as ProjectTodoStatus;
      const updated = (await this.invoke(IPC_CHANNELS.projectTodoSave, [
        {
          ...todo,
          revision: args.revision,
          text: args.text ?? todo.text,
          status,
          completed: status === "completed",
        },
      ])) as ProjectTodo;
      return summary(updated);
    }
    throw new Error("未知的 Mori 待办工具。");
  }
}
