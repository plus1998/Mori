import type { ProjectTodoImage, ProjectTodoSave } from "../shared/project-todos";
import { TODO_MAX_IMAGE_BYTES, TODO_MAX_IMAGES } from "../shared/project-todos";

/** Resolve mobile chunked uploads before the store's synchronous revision check. */
export async function resolveProjectTodoUploads(
  input: ProjectTodoSave,
  readContent: (contentRef: string) => Promise<{
    mediaType: ProjectTodoImage["mediaType"];
    byteLength: number;
    dataBase64: string;
  }>,
): Promise<ProjectTodoSave> {
  if (!input || !Array.isArray(input.images) || input.images.length > TODO_MAX_IMAGES) {
    throw new Error("Invalid todo.");
  }
  const images = await Promise.all(input.images.map(async (image) => {
    if (image?.contentRef === undefined) return image;
    if (typeof image.contentRef !== "string" || !image.contentRef.trim()) {
      throw new Error("Invalid todo image content reference.");
    }
    const content = await readContent(image.contentRef);
    if (content.mediaType !== image.mediaType || content.byteLength > TODO_MAX_IMAGE_BYTES) {
      throw new Error("Invalid todo image.");
    }
    return { ...image, data: content.dataBase64 };
  }));
  return { ...input, images };
}
