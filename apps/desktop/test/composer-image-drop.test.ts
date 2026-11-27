import { expect, test } from "bun:test";
import { readImageFileAsAttachment, revokeComposerAttachmentPreview, toPromptImageAttachments } from "../src/renderer/composer-attachments";
import { readDroppedWebImage, readDroppedWebImageSource } from "../src/renderer/composer-image-drop";

test("a dropped browser image becomes a sendable attachment with image bytes", async () => {
  const data = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jJp0AAAAASUVORK5CYII=";
  const url = `data:image/png;base64,${data}`;
  const source = readDroppedWebImageSource({
    getData: type => type === "text/uri-list" ? `# Drag source\r\n${url}` : "",
  });
  expect(source).toBe(url);
  const image = await readImageFileAsAttachment(await readDroppedWebImage(source!));
  expect(image).not.toBeNull();
  try {
    expect(toPromptImageAttachments([image!])).toEqual([{ mediaType: "image/png", data }]);
  } finally {
    revokeComposerAttachmentPreview(image);
  }
});

test("rejects non-image and unsupported URL sources", async () => {
  await expect(readDroppedWebImage("data:text/html,hello")).rejects.toThrow();
  await expect(readDroppedWebImage("file:///image.png")).rejects.toThrow();
});

test("rejects an image larger than the composer size limit", async () => {
  const response = new Response(new Uint8Array(5 * 1024 * 1024 + 1), {
    headers: { "content-type": "image/png" },
  });
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = Object.assign(async () => response, { preconnect: originalFetch.preconnect });
    await expect(readDroppedWebImage("https://example.com/image.png")).rejects.toThrow("size limit");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
