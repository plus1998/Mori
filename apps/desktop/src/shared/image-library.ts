import type { ImageGenerationProvider, ImageGenerationToolInput } from "./image-generation";

export interface LibraryImage {
  id: string;
  artifactId: string;
  imageIndex: number;
  fileName: string;
  mimeType: string;
  bytes: number;
  width: number;
  height: number;
  workspacePath: string;
  threadId: string;
  sourceKind: "conversation" | "project";
  sourceTitle?: string;
  sourceDeleted?: boolean;
  prompt: string;
  provider: ImageGenerationProvider;
  model: string;
  parameters: Omit<ImageGenerationToolInput, "prompt">;
  createdAt: string;
  trashedAt: string | null;
  purgedAt: string | null;
  missing: boolean;
}

export interface ImageLibraryQuery {
  trash?: boolean;
  search?: string;
  workspacePath?: string;
  threadId?: string;
  /** Inclusive local calendar days (YYYY-MM-DD). */
  fromDate?: string;
  toDate?: string;
  offset?: number;
  limit?: number;
}

export interface ImageLibraryPage {
  items: LibraryImage[];
  total: number;
  bytes: number;
  projects: string[];
  threads: { id: string; workspacePath: string; title?: string }[];
}

export interface ImageLibraryReadResult {
  dataBase64: string;
  mimeType: string;
}

export interface ImageLibraryBatchResult {
  succeededIds: string[];
  errors: { id: string; message: string }[];
  freedBytes: number;
}
