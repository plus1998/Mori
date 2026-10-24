import type { PromptImageAttachment } from "./ipc";

export const TODO_MAX_IMAGES = 5;
export const TODO_MAX_IMAGE_BYTES = 5 * 1024 * 1024;
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
  images: Array<Pick<ProjectTodoImage, "id" | "mediaType" | "data"> & { thumbnail?: string; contentRef?: string }>;
  completed: boolean;
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
