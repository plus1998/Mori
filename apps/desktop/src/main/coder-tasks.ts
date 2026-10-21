import type { CoderTodoItem, CoderTodoStatus } from "../shared/ipc";

export interface CoderTaskDraft {
  title: string;
  detail: string;
}

const CODER_TASKS_HEADING = /^#{1,6}\s*(?:Coder\s*Tasks|CoderTasks|编码任务|Coder任务)\s*(.*)$/i;

export function extractCoderTasksFromText(text: string): CoderTaskDraft[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const headingIndex = lines.findIndex((line) => CODER_TASKS_HEADING.test(line.trim()));
  if (headingIndex < 0) {
    return [];
  }

  const sectionLines: string[] = [];
  const headingMatch = lines[headingIndex]?.trim().match(CODER_TASKS_HEADING);
  const inlineRemainder = headingMatch?.[1]?.trim();
  if (inlineRemainder) {
    sectionLines.push(inlineRemainder);
  }

  for (const line of lines.slice(headingIndex + 1)) {
    if (/^#{1,6}\s+\S/.test(line.trim())) {
      break;
    }
    sectionLines.push(line);
  }

  const numberedTasks = splitTaskItems(sectionLines, /^\s*\d+[.)]\s+(.+?)\s*$/);
  const rawTasks =
    numberedTasks.length > 0 ? numberedTasks : splitTaskItems(sectionLines, /^\s*[-*]\s+(.+?)\s*$/);

  return rawTasks
    .map((item) => {
      const detail = item.lines.join("\n").trim();
      const title = extractTaskTitle(item.firstLine, detail);
      return title ? { title, detail } : undefined;
    })
    .filter((task): task is CoderTaskDraft => Boolean(task));
}

export function extractCoderTasksFromActivity(
  lines: ReadonlyArray<{ role: string; message: string }>,
): CoderTaskDraft[] {
  const transcript = lines
    .filter((line) => line.role === "main" || line.role === "architect")
    .map((line) => line.message)
    .join("\n");
  return extractCoderTasksFromText(transcript);
}

export function mergeCoderTodoItems(
  threadId: string,
  drafts: CoderTaskDraft[],
  existing: CoderTodoItem[] = [],
  now = new Date().toISOString(),
): CoderTodoItem[] {
  const existingByTitle = new Map(existing.map((item) => [normalizeTaskTitle(item.title), item]));

  return drafts.map((draft, index) => {
    const previous = existingByTitle.get(normalizeTaskTitle(draft.title));
    return {
      id: previous?.id ?? `${threadId}:coder-task:${index + 1}`,
      threadId,
      title: draft.title,
      detail: draft.detail,
      status: previous?.status ?? "pending",
      position: index,
      updatedAt: previous?.updatedAt ?? now,
    };
  });
}

export function updateCoderTodoStatus(
  todos: CoderTodoItem[],
  todoId: string,
  status: CoderTodoStatus,
  now = new Date().toISOString(),
): CoderTodoItem[] {
  return todos.map((todo) =>
    todo.id === todoId && todo.status !== status ? { ...todo, status, updatedAt: now } : todo,
  );
}

export function completeRunningCoderTodos(
  todos: CoderTodoItem[],
  status: Extract<CoderTodoStatus, "completed" | "blocked" | "cancelled">,
  now = new Date().toISOString(),
): CoderTodoItem[] {
  return todos.map((todo) => (todo.status === "running" ? { ...todo, status, updatedAt: now } : todo));
}

export function findCoderTodoForPrompt(
  todos: CoderTodoItem[],
  prompt: string | undefined,
): CoderTodoItem | undefined {
  const normalizedPrompt = normalizeTaskTitle(prompt ?? "");
  if (normalizedPrompt) {
    const byTitle = todos.find((todo) => normalizedPrompt.includes(normalizeTaskTitle(todo.title)));
    if (byTitle) {
      return byTitle;
    }
  }
  return todos.find((todo) => todo.status === "pending") ?? todos.find((todo) => todo.status === "running");
}

export function todoListSignature(todos: CoderTodoItem[]): string {
  return todos.map((todo) => `${todo.position}:${todo.title}:${todo.detail}:${todo.status}`).join("\n---\n");
}

function splitTaskItems(
  lines: string[],
  startPattern: RegExp,
): Array<{ firstLine: string; lines: string[] }> {
  const items: Array<{ firstLine: string; lines: string[] }> = [];

  for (const line of lines) {
    const match = line.match(startPattern);
    if (match?.[1]) {
      items.push({ firstLine: match[1].trim(), lines: [match[1].trim()] });
      continue;
    }

    const current = items[items.length - 1];
    if (current && line.trim()) {
      current.lines.push(line.trim());
    }
  }

  return items;
}

function extractTaskTitle(firstLine: string, detail: string): string {
  const titleLine =
    detail
      .split("\n")
      .map((line) => line.trim())
      .find((line) => /^(\*\*)?title(\*\*)?\s*[:：]/i.test(stripMarkdown(line))) ?? firstLine;

  const stripped = stripMarkdown(titleLine)
    .replace(/^title\s*[:：]\s*/i, "")
    .replace(/\s+(scope|files\/areas|files|dependencies|parallel_group)\s*[:：].*$/i, "")
    .trim();

  return stripped.length > 120 ? `${stripped.slice(0, 117)}...` : stripped;
}

function stripMarkdown(value: string): string {
  return value.replace(/[`*_]/g, "").trim();
}

export function normalizeTaskTitle(value: string): string {
  return stripMarkdown(value).toLowerCase().replace(/\s+/g, " ").trim();
}
