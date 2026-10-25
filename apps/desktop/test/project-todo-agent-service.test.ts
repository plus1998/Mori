import { afterEach, expect, test } from "bun:test";
import { DatabaseSync } from "node:sqlite";
import { ComposerReferenceService } from "../src/main/composer-reference-service";
import { ContextReferenceMcpGateway } from "../src/main/context-reference-mcp-gateway";
import type { McpToolCallResult, McpToolDefinition } from "../src/main/mcp-streamable-http";
import { ProjectTodoAgentService } from "../src/main/project-todo-agent-service";
import { ProjectTodoStore } from "../src/main/project-todo-store";
import { composerReferenceToken } from "../src/shared/composer-references";

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

function setup() {
  const store = new ProjectTodoStore(
    new DatabaseSync(":memory:"),
    (bytes) => `data:image/png;base64,${bytes.toString("base64")}`,
  );
  cleanup.push(() => store.close());
  let changes = 0;
  const todos = new ProjectTodoAgentService({
    store,
    changed: () => {
      changes++;
    },
    workspacePath: (id) => {
      if (id === "a") return "/project/a";
      if (id === "b") return "/project/b";
      throw new Error("Unknown conversation");
    },
  });
  const references = new ComposerReferenceService({
    todos,
    listSsh: () => [],
    listBrowsers: () => [],
    listThreads: () => [],
    getThread: () => undefined,
    listCapabilities: async () => [],
    readHistory: () => ({ messages: [], historyRevision: 0, hasMore: false }),
    readMessage: () => undefined,
    readTools: () => ({}),
    browserTool: async () => ({}),
  });
  return { store, todos, references, changes: () => changes };
}
function json(result: McpToolCallResult) {
  const content = result.content[0];
  if (content?.type !== "text") throw new Error("Missing tool response");
  return JSON.parse(content.text);
}
const note = { projectPath: "/project/a", text: "User task", completed: false, images: [] };

test("Agent creates project-scoped todos and updates the original item with conflict protection", () => {
  const { todos, store, changes } = setup();
  const created = json(todos.invoke("a", "create_todo", { text: "New task" }));
  expect(created).toMatchObject({ projectPath: "/project/a", status: "pending", revision: 1 });
  const started = json(
    todos.invoke("a", "update_todo_status", { todoId: created.todoId, revision: 1, status: "in_progress" }),
  );
  expect(store.get(created.todoId)).toMatchObject({
    id: created.todoId,
    completed: false,
    status: "in_progress",
    revision: 2,
  });
  // A human edit races with the Agent completing its work.
  const edited = store.save({ ...store.get(created.todoId), text: "User changed the task" });
  expect(() =>
    todos.invoke("a", "update_todo_status", {
      todoId: created.todoId,
      revision: started.revision,
      status: "completed",
    }),
  ).toThrow("changed");
  expect(store.get(created.todoId).text).toBe(edited.text);
  expect(changes()).toBe(2);
  const current = json(todos.invoke("a", "read_todo", { todoId: created.todoId }));
  todos.invoke("a", "update_todo_status", {
    todoId: current.todoId,
    revision: current.revision,
    status: "completed",
  });
  expect(store.get(created.todoId).completed).toBe(true);
  expect(store.list()).toHaveLength(1);
  expect(changes()).toBe(3);
  expect(() => todos.invoke("a", "create_todo", { text: " " })).toThrow();
  expect(() =>
    todos.invoke("a", "update_todo_status", { todoId: current.todoId, revision: 4, status: "broken" }),
  ).toThrow("status");
  expect(() => todos.invoke("missing", "create_todo", { text: "No project" })).toThrow(
    "Unknown conversation",
  );
});

test("Agent list filters and paginates current project without leaking other project todos", () => {
  const { todos, store } = setup();
  store.save(note);
  store.save({ ...note, text: "Another task" });
  store.save({ ...note, projectPath: "/project/b", text: "Other project" });
  const first = json(todos.invoke("a", "list_todos", { limit: 1 }));
  const second = json(todos.invoke("a", "list_todos", { limit: 1, offset: first.nextOffset }));
  expect(first.hasMore).toBe(true);
  expect(second.hasMore).toBe(false);
  expect(first.items[0].todoId).not.toBe(second.items[0].todoId);
  expect(json(todos.invoke("a", "list_todos", { query: "Other project" })).items).toEqual([]);
  expect(json(todos.invoke("a", "list_todos", { status: "completed" })).items).toEqual([]);
  expect(() => todos.invoke("a", "list_todos", { limit: 51 })).toThrow();
  expect(() => todos.invoke("a", "list_todos", { offset: -1 })).toThrow();
});

test("@todo resolves authoritative metadata and grants only that item in the referencing conversation", async () => {
  const { todos, store, references } = setup();
  const todo = store.save({ ...note, projectPath: "/project/b", text: "Actual task" });
  expect(references.search({ query: "Actual", kind: "todo" }).items[0]?.id).toBe(todo.id);
  expect(() => todos.invoke("a", "read_todo", { todoId: todo.id })).toThrow("当前项目");
  const token = composerReferenceToken({
    kind: "todo",
    id: todo.id,
    label: "Stale title",
    detail: "/forged/path",
  });
  const prompt = await references.resolvePrompt("a", token);
  expect(prompt).toContain('"text":"Actual task"');
  expect(prompt).toContain('"projectPath":"/project/b"');
  expect(prompt).not.toContain("/forged/path");
  todos.invoke("a", "update_todo_status", {
    todoId: todo.id,
    revision: todo.revision,
    status: "in_progress",
  });
  references.disposeThread("a");
  expect(() => todos.invoke("a", "read_todo", { todoId: todo.id })).toThrow("当前项目");
  expect(() =>
    todos.invoke("a", "update_todo_status", { todoId: todo.id, revision: 2, status: "completed" }),
  ).toThrow("当前项目");
  const latest = store.get(todo.id);
  store.trash({ ...latest, deleted: true });
  await expect(references.resolvePrompt("a", token)).rejects.toThrow("no longer exists");
  expect(() => todos.invoke("b", "read_todo", { todoId: todo.id })).toThrow("no longer exists");
});

test("Agent reads paginated Unicode text and original images; status writes preserve attachments", async () => {
  const { todos, store, references } = setup();
  const data = Buffer.from("original image bytes").toString("base64");
  const todo = store.save({
    ...note,
    text: "一😀二😀三",
    images: [
      { id: "image-1", mediaType: "image/png", data, thumbnail: "data:image/png;base64,cHJldmlldw==" },
    ],
  });
  const first = json(todos.invoke("a", "read_todo", { todoId: todo.id, limit: 2 }));
  const next = json(todos.invoke("a", "read_todo", { todoId: todo.id, offset: first.nextOffset }));
  expect(first.text + next.text).toBe(todo.text);
  const read = todos.invoke("a", "read_todo", { todoId: todo.id, includeImages: true });
  expect(read.content[1]).toMatchObject({ type: "image", data, mimeType: "image/png" });
  expect(todos.invoke("a", "read_todo", { todoId: todo.id }).content).toHaveLength(1);
  todos.invoke("a", "update_todo_status", {
    todoId: todo.id,
    revision: todo.revision,
    status: "in_progress",
  });
  expect(store.get(todo.id).images[0]?.data).toBe(data);
  const prompt = await references.resolvePrompt(
    "a",
    composerReferenceToken({ kind: "todo", id: todo.id, label: "task", detail: "" }),
  );
  expect(prompt).toContain('"imageCount":1');
  expect(prompt).not.toContain(data);
});

test("context MCP exposes todo writes through authenticated HTTP, validates fields and revokes access", async () => {
  const { references, store } = setup();
  const gateway = new ContextReferenceMcpGateway(references);
  cleanup.push(() => gateway.close());
  const injection = await gateway.resolveInjection("a");
  const call = async (method: string, params: unknown = {}) => {
    const response = await fetch(injection.sdkEntry.url as string, {
      method: "POST",
      headers: {
        ...(injection.sdkEntry.headers as Record<string, string>),
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: "todo", method, params }),
    });
    return response.json() as Promise<{ result: McpToolCallResult & { tools: McpToolDefinition[] } }>;
  };
  const catalog = await call("tools/list");
  expect(catalog.result.tools.find((item) => item.name === "create_todo")?.annotations?.readOnlyHint).toBe(
    false,
  );
  const created = json(
    (await call("tools/call", { name: "create_todo", arguments: { text: "Via MCP" } })).result,
  );
  expect(store.get(created.todoId).projectPath).toBe("/project/a");
  const updated = await call("tools/call", {
    name: "update_todo_status",
    arguments: { todoId: created.todoId, revision: created.revision, status: "completed" },
  });
  expect(json(updated.result).status).toBe("completed");
  expect(
    (
      await call("tools/call", {
        name: "create_todo",
        arguments: { text: "Spoof project", projectPath: "/project/b" },
      })
    ).result.isError,
  ).toBe(true);
  expect(
    (
      await call("tools/call", {
        name: "update_todo_status",
        arguments: { todoId: created.todoId, status: "pending" },
      })
    ).result.isError,
  ).toBe(true);
  gateway.disposeThread("a");
  expect((await call("tools/call", { name: "list_todos", arguments: {} })).result.isError).toBe(true);
});
