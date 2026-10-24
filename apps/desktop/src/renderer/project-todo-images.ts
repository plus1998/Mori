import type { ProjectTodoImage } from "../shared/project-todos";

/** Chromium decodes all composer formats; nativeImage only decodes PNG/JPEG.
 * Store a small PNG preview separately while retaining the original image bytes. */
export async function createTodoImage(
  id: string,
  mediaType: ProjectTodoImage["mediaType"],
  data: string,
): Promise<ProjectTodoImage> {
  const bytes = Uint8Array.from(atob(data), (char) => char.charCodeAt(0));
  const bitmap = await createImageBitmap(new Blob([bytes], { type: mediaType }));
  try {
    const scale = Math.min(1, 240 / bitmap.width, 180 / bitmap.height);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Image preview is unavailable.");
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return { id, mediaType, data, thumbnail: canvas.toDataURL("image/png") };
  } finally {
    bitmap.close();
  }
}
