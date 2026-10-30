import { expect, test } from "./fixtures/electron-app";

test("desktop clipboard IPC reads text and round-trips PNG images with Electron's async API", async ({ electronApp, ecoPage }) => {
  const result = await electronApp.evaluate(async ({ BrowserWindow, clipboard, ClipboardItem, nativeImage }, url) => {
    const contents = BrowserWindow.getAllWindows().find((window) => window.webContents.getURL() === url)?.webContents;
    if (!contents) throw new Error("Main renderer not found");

    // Materialize lazy clipboard data before overwriting it, then restore it even on failure.
    const previous = await Promise.all((await clipboard.read()).map(async (item) => {
      const entries = await Promise.all(item.types.map(async (type) => [type, await item.getType(type)] as const));
      return new ClipboardItem(Object.fromEntries(entries));
    }));
    try {
      await clipboard.writeText("Mori Electron clipboard 文本");
      const text = await contents.executeJavaScript("window.eco.readClipboardText()");
      const noImage = await contents.executeJavaScript("window.eco.readClipboardImage()");

      const png = nativeImage.createFromBitmap(Buffer.from([0, 0, 255, 255]), { width: 1, height: 1 }).toPNG();
      const written = await contents.executeJavaScript(
        `window.eco.writeImageToClipboard(${JSON.stringify({ pngBase64: png.toString("base64") })})`,
      );
      const image = await contents.executeJavaScript("window.eco.readClipboardImage()");
      const decoded = image ? nativeImage.createFromBuffer(Buffer.from(image.pngBase64, "base64")) : null;
      const rejected = await contents.executeJavaScript(
        `window.eco.writeImageToClipboard(${JSON.stringify({ pngBase64: Buffer.from("invalid image").toString("base64") })})`,
      );
      return {
        text, noImage, written, rejected,
        imageSize: decoded?.getSize(),
        byteLength: image?.byteLength,
        actualByteLength: image ? Buffer.from(image.pngBase64, "base64").length : 0,
      };
    } finally {
      if (previous.length) await clipboard.write(previous);
      else clipboard.clear();
    }
  }, ecoPage.url());

  expect(result.text).toBe("Mori Electron clipboard 文本");
  expect(result.noImage).toBeNull();
  expect(result.written).toBe(true);
  expect(result.rejected).toBe(false);
  expect(result.imageSize).toEqual({ width: 1, height: 1 });
  expect(result.byteLength).toBeGreaterThan(0);
  expect(result.byteLength).toBe(result.actualByteLength);
});
