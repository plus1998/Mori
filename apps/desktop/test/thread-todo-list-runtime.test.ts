import { expect, test } from "bun:test";
import { loadThreadTodoList, type ThreadTodoListRuntimeServices } from "../src/main/thread-todo-list-runtime";
import type { CoderTodoItem, ThreadActivityLine } from "../src/shared/ipc";

function todo(input: Partial<CoderTodoItem> = {}): CoderTodoItem {
  return {
    id: "todo_1",
    threadId: "thr_todo",
    title: "Existing task",
    detail: "title: Existing task",
    status: "pending",
    position: 0,
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...input,
  };
}

function activity(input: Partial<ThreadActivityLine> = {}): ThreadActivityLine {
  return {
    id: "activity_1",
    role: "main",
    message: "## Coder Tasks\n1. title: Wire TODO IPC\n   scope: main process",
    ...input,
  };
}

function services(input: {
  todos?: CoderTodoItem[];
  activity?: ThreadActivityLine[];
  onListActivity?: () => void;
  onReplace?: (todos: CoderTodoItem[]) => void;
}): ThreadTodoListRuntimeServices {
  return {
    listTodos: () => input.todos ?? [],
    listActivity: async () => {
      input.onListActivity?.();
      return input.activity ?? [];
    },
    replaceTodos: (_threadId, todos) => {
      input.onReplace?.(todos);
    },
  };
}

test("loadThreadTodoList returns stored todos without reading activity", async () => {
  let activityReads = 0;
  const stored = [todo()];

  const result = await loadThreadTodoList({
    threadId: "thr_todo",
    services: services({
      todos: stored,
      onListActivity: () => {
        activityReads += 1;
      },
      onReplace: () => {
        throw new Error("stored todo list should not be replaced");
      },
    }),
  });

  expect(result).toBe(stored);
  expect(activityReads).toBe(0);
});

test("loadThreadTodoList returns empty list when no activity tasks are present", async () => {
  let replaced = false;

  const result = await loadThreadTodoList({
    threadId: "thr_empty",
    services: services({
      activity: [activity({ role: "tool", message: "Tool: Read" })],
      onReplace: () => {
        replaced = true;
      },
    }),
  });

  expect(result).toEqual([]);
  expect(replaced).toBe(false);
});

test("loadThreadTodoList rehydrates todos from planner activity and persists them", async () => {
  let persisted: CoderTodoItem[] | undefined;

  const result = await loadThreadTodoList({
    threadId: "thr_rehydrate",
    services: services({
      activity: [activity()],
      onReplace: (todos) => {
        persisted = todos;
      },
    }),
  });

  expect(result).toHaveLength(1);
  expect(result[0]).toMatchObject({
    id: "thr_rehydrate:coder-task:1",
    threadId: "thr_rehydrate",
    title: "Wire TODO IPC",
    status: "pending",
  });
  expect(persisted).toEqual(result);
});
