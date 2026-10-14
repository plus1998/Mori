import { expect, test } from "bun:test";
import {
  CLIPBOARD_IMAGE_MAX_SIDE,
  copyImageBlobToClipboard,
  fitImageCanvasSize,
  isClipboardNativeImageMime,
  normalizeImageMime,
} from "../src/renderer/image-clipboard";
import { withGlobalProperty } from "./support/global-document";

interface ClipboardProbe {
  written: string[];
  blobs: Array<Blob | Promise<Blob>>;
}

/** ClipboardItem is a browser global; the copy path only needs its "what went in" shape. */
class FakeClipboardItem {
  readonly entries: Record<string, Blob | Promise<Blob>>;
  constructor(items: Record<string, Blob | Promise<Blob>>) {
    this.entries = items;
  }
}

/** Stubs the clipboard API and records what reached it; restores every global afterwards. */
async function withClipboardProbe(run: (probe: ClipboardProbe) => Promise<void>): Promise<void> {
  const probe: ClipboardProbe = { written: [], blobs: [] };
  const original = navigator.clipboard;
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      write: async (items: FakeClipboardItem[]) => {
        for (const item of items) {
          for (const [mime, blob] of Object.entries(item.entries)) {
            probe.written.push(mime);
            probe.blobs.push(blob);
          }
        }
      },
    },
  });
  try {
    await run(probe);
  } finally {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: original });
  }
}

test("normalizeImageMime strips parameters and case", () => {
  expect(normalizeImageMime("IMAGE/PNG;charset=utf-8")).toBe("image/png");
  expect(normalizeImageMime("  image/jpeg ")).toBe("image/jpeg");
  expect(normalizeImageMime(undefined)).toBe("");
  expect(isClipboardNativeImageMime("image/png")).toBe(true);
  expect(isClipboardNativeImageMime("image/webp")).toBe(false);
});

test("fitImageCanvasSize keeps real sizes and clamps pathological ones", () => {
  expect(fitImageCanvasSize(1500, 900)).toEqual({ width: 1500, height: 900 });
  expect(fitImageCanvasSize(20_000, 10_000)).toEqual({
    width: CLIPBOARD_IMAGE_MAX_SIDE,
    height: CLIPBOARD_IMAGE_MAX_SIDE / 2,
  });
  expect(fitImageCanvasSize(0, 100)).toBeNull();
  expect(fitImageCanvasSize(Number.NaN, 100)).toBeNull();
});

test("copyImageBlobToClipboard hands PNG bytes to the clipboard untouched", async () => {
  const png = new Blob([new Uint8Array(64)], { type: "image/png" });
  await withGlobalProperty("ClipboardItem", FakeClipboardItem, async () => {
    await withGlobalProperty("document", undefined, async () => {
      await withClipboardProbe(async (probe) => {
        expect(await copyImageBlobToClipboard(png)).toBe(true);
        expect(probe.written).toEqual(["image/png"]);
        // Same bytes: a PNG copy never re-encodes, so quality cannot drop.
        expect(await probe.blobs[0]).toBe(png);
      });
    });
  });
});

test("copyImageBlobToClipboard re-encodes non-PNG through a canvas", async () => {
  const drawn: Array<{ width: number; height: number }> = [];
  let released = false;
  const fakeDocument = {
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: () => ({
        drawImage: (_source: unknown, _x: number, _y: number, width: number, height: number) => {
          drawn.push({ width, height });
        },
      }),
      toBlob: (callback: (blob: Blob | null) => void) => {
        callback(new Blob([new Uint8Array(64)], { type: "image/png" }));
      },
    }),
  };
  const createImageBitmap = async () => ({
    width: 20_000,
    height: 10_000,
    close: () => {
      released = true;
    },
  });
  await withGlobalProperty("ClipboardItem", FakeClipboardItem, async () => {
    await withGlobalProperty("document", fakeDocument, async () => {
      await withGlobalProperty("createImageBitmap", createImageBitmap, async () => {
        await withClipboardProbe(async (probe) => {
          const jpeg = new Blob([new Uint8Array(64)], { type: "image/jpeg" });
          expect(await copyImageBlobToClipboard(jpeg)).toBe(true);
          expect(probe.written).toEqual(["image/png"]);
          expect(drawn).toEqual([{ width: CLIPBOARD_IMAGE_MAX_SIDE, height: CLIPBOARD_IMAGE_MAX_SIDE / 2 }]);
          expect(released).toBe(true);
        });
      });
    });
  });
});

test("copyImageBlobToClipboard falls back to the main process when the renderer write is refused", async () => {
  const png = new Blob([new Uint8Array(64)], { type: "image/png" });
  const requests: string[] = [];
  const fakeWindow = {
    eco: {
      writeImageToClipboard: async (request: { pngBase64: string }) => {
        requests.push(request.pngBase64);
        return true;
      },
    },
  };
  const original = navigator.clipboard;
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      write: async () => {
        throw new Error("NotAllowedError: Document is not focused.");
      },
    },
  });
  try {
    await withGlobalProperty("ClipboardItem", FakeClipboardItem, async () => {
      await withGlobalProperty("window", fakeWindow, async () => {
        expect(await copyImageBlobToClipboard(png)).toBe(true);
        expect(requests).toHaveLength(1);
      });
    });
  } finally {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: original });
  }
});

test("copyImageBlobToClipboard fails instead of throwing when nothing can decode the image", async () => {
  await withGlobalProperty("ClipboardItem", FakeClipboardItem, async () => {
    await withGlobalProperty("document", undefined, async () => {
      await withGlobalProperty("createImageBitmap", undefined, async () => {
        await withGlobalProperty("window", undefined, async () => {
          await withClipboardProbe(async (probe) => {
            const webp = new Blob([new Uint8Array(64)], { type: "image/webp" });
            expect(await copyImageBlobToClipboard(webp)).toBe(false);
            expect(await copyImageBlobToClipboard(null)).toBe(false);
            expect(await copyImageBlobToClipboard(new Blob([], { type: "image/png" }))).toBe(false);
            expect(probe.written).toEqual([]);
          });
        });
      });
    });
  });
});
