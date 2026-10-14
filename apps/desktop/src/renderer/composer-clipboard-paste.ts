/**
 * Clipboard reads behind the Composer's right-click Paste.
 *
 * The renderer's own clipboard-read permission stays denied (see `main/session-permissions.ts`),
 * so both halves come from the main process. Image first: that matches Cmd+V, where
 * `handleComposerPaste` claims the paste as soon as the clipboard carries an image.
 */
import { type ClipboardReadImageResult, MAX_CLIPBOARD_IMAGE_BASE64_CHARS } from "../shared/ipc";

/** Name given to a clipboard PNG before it becomes a Composer attachment. */
export const COMPOSER_CLIPBOARD_IMAGE_NAME = "clipboard-paste.png";

/** The subset of `window.eco` these reads need, so callers can pass a stand-in. */
export interface ComposerClipboardReader {
  readClipboardText(): Promise<string>;
  readClipboardImage(): Promise<ClipboardReadImageResult | null>;
}

export type ComposerClipboardContent = { kind: "image"; file: File } | { kind: "text"; text: string } | null;

/** PNG bytes from `clipboard:read-image` as a File, or null when the read carried no image. */
export function composerClipboardImageFile(result: ClipboardReadImageResult | null | undefined): File | null {
  const pngBase64 = result?.pngBase64?.trim() ?? "";
  if (!pngBase64 || pngBase64.length > MAX_CLIPBOARD_IMAGE_BASE64_CHARS) {
    return null;
  }
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = base64ToUint8Array(pngBase64);
  } catch {
    return null;
  }
  if (bytes.byteLength === 0) {
    return null;
  }
  return new File([new Blob([bytes], { type: "image/png" })], COMPOSER_CLIPBOARD_IMAGE_NAME, {
    type: "image/png",
  });
}

/**
 * Read what the system clipboard currently holds. A clipboard image wins over the text that may
 * sit next to it; an empty clipboard yields null.
 */
export async function readComposerClipboard(
  eco: ComposerClipboardReader | undefined,
): Promise<ComposerClipboardContent> {
  if (!eco) {
    return null;
  }
  try {
    const image = composerClipboardImageFile(await eco.readClipboardImage());
    if (image) {
      return { kind: "image", file: image };
    }
  } catch (error) {
    console.error("[eco] clipboard image read failed", error);
  }
  try {
    const text = await eco.readClipboardText();
    return text ? { kind: "text", text } : null;
  } catch (error) {
    console.error("[eco] clipboard text read failed", error);
    return null;
  }
}

function base64ToUint8Array(dataBase64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(dataBase64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
