import { composerReferences, composerReferenceToken } from "./composer-references";
import type { PromptImageAttachment } from "./ipc";

export const TODO_MAX_IMAGES = 5;
export const TODO_MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const PROJECT_TODO_STATUSES = ["pending", "in_progress", "completed"] as const;
export type ProjectTodoStatus = (typeof PROJECT_TODO_STATUSES)[number];
export interface ProjectTodoImage {
  id: string;
  mediaType: PromptImageAttachment["mediaType"];
  thumbnail: string;
  /** Only included when opening a todo for editing or composing. */
  data?: string;
}
export interface ProjectTodo {
  id: string;
  revision: number;
  projectPath: string;
  text: string;
  images: ProjectTodoImage[];
  completed: boolean;
  status: ProjectTodoStatus;
  createdAt: string;
  updatedAt: string;
  /** Last successful transfer into a conversation composer. */
  composedAt?: string;
}
export interface ProjectTodoSave {
  id?: string;
  revision?: number;
  projectPath: string;
  text: string;
  images: Array<
    Pick<ProjectTodoImage, "id" | "mediaType" | "data"> & { thumbnail?: string; contentRef?: string }
  >;
  completed: boolean;
  /** Older clients use completed; omitting status preserves an in-progress todo. */
  status?: ProjectTodoStatus;
}
export interface ProjectTodoStatusUpdate {
  id: string;
  revision: number;
  status: ProjectTodoStatus;
}

export function projectTodoReference(todo: Pick<ProjectTodo, "id" | "text" | "projectPath">) {
  return {
    kind: "todo" as const,
    id: todo.id,
    label: todo.text.trim().split(/\r?\n/)[0]?.slice(0, 80) || "待办",
    detail: todo.projectPath,
  };
}
export function appendProjectTodoReference(
  prompt: string,
  todo: Pick<ProjectTodo, "id" | "text" | "projectPath">,
): string {
  if (composerReferences(prompt).some((ref) => ref.kind === "todo" && ref.id === todo.id)) return prompt;
  return `${prompt}${prompt && !/\s$/.test(prompt) ? "\n" : ""}${composerReferenceToken(projectTodoReference(todo))} `;
}
export interface ProjectTodoTrash {
  id: string;
  revision: number;
  deleted: boolean;
}
export interface ProjectTodoCompose {
  id: string;
  revision: number;
}
