import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { WebContents } from "electron";
import { captureBrowserScreenshotArtifact } from "../src/main/browser-screenshot";
import { createImageDisplayStore } from "../src/main/image-display-store";
import { browserAddressDisplayValue } from "../src/renderer/BrowserAddressInput";
import type { BrowserInstanceView } from "../src/shared/browser";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

test("captures the requested browser into a readable personal-scope image artifact", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mori-browser-screenshot-test-"));
  const store = await createImageDisplayStore(path.join(root, "db.sqlite"), path.join(root, "images"));
  const scopeId = "__personal__:persist-123";
  const instance = {
    id: "browser-1",
    threadId: scopeId,
    url: "https://example.com/page",
    title: "Example page",
  } as BrowserInstanceView;
  const guest = {} as WebContents;
  let temporaryFile = "";
  try {
    const artifact = await captureBrowserScreenshotArtifact(instance.id, {
      host: {
        getSelectionTarget(id) {
          expect(id).toBe(instance.id);
          return { guest, instance };
        },
        getState: () => ({ uiScopeId: scopeId }),
      },
      store,
      capture: async (target, output) => {
        expect(target).toBe(guest);
        temporaryFile = output;
        await fs.writeFile(output, PNG);
        return output;
      },
    });
    expect(artifact).toMatchObject({ threadId: scopeId, title: "Example page", mimeType: "image/png" });
    expect(path.basename(path.dirname(artifact.filePath))).toBe(encodeURIComponent(scopeId));
    expect((await store.readArtifactFile(artifact.id)).dataBase64).toBe(PNG.toString("base64"));
    await expect(fs.stat(temporaryFile)).rejects.toThrow();
  } finally {
    store.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("rejects screenshots from a different browser scope before capturing", async () => {
  const instance = { id: "other", threadId: "thr_other", url: "https://example.com" } as BrowserInstanceView;
  let captured = false;
  await expect(
    captureBrowserScreenshotArtifact(instance.id, {
      host: {
        getSelectionTarget: () => ({ guest: {} as WebContents, instance }),
        getState: () => ({ uiScopeId: "thr_current" }),
      },
      store: {
        ingestFromToolInput: async () => {
          throw new Error("unexpected persistence");
        },
      },
      capture: async () => {
        captured = true;
        throw new Error("unexpected capture");
      },
    }),
  ).rejects.toThrow("只能截取当前会话中的网页");
  expect(captured).toBe(false);
});

test("address display keeps only the hostname while retaining special URLs", () => {
  expect(browserAddressDisplayValue("https://www.example.com:8443/a?b=1#c")).toBe("www.example.com");
  expect(browserAddressDisplayValue("http://127.0.0.1:8080/page")).toBe("127.0.0.1");
  expect(browserAddressDisplayValue("about:blank")).toBe("");
  expect(browserAddressDisplayValue("file:///tmp/example.html")).toBe("file:///tmp/example.html");
});
