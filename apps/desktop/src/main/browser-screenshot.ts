import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { WebContents } from "electron";
import type { BrowserInstanceView } from "../shared/browser";
import type { ImageDisplayArtifact } from "../shared/image-display";
import { captureGuestScreenshot } from "./browser-native-agent-tools";
import type { ImageDisplayStore } from "./image-display-store";

/** Capture the requested guest and persist it through the same store as displayed images. */
export async function captureBrowserScreenshotArtifact(
  browserId: string,
  deps: {
    host: {
      getSelectionTarget(id: string): { guest: WebContents; instance: BrowserInstanceView };
      getState(): { uiScopeId: string };
    };
    store: Pick<ImageDisplayStore, "ingestFromToolInput">;
    capture?: typeof captureGuestScreenshot;
  },
): Promise<ImageDisplayArtifact> {
  const { guest, instance } = deps.host.getSelectionTarget(browserId);
  if (instance.threadId !== deps.host.getState().uiScopeId) {
    throw new Error("只能截取当前会话中的网页。");
  }
  if (!instance.url || instance.url === "about:blank") {
    throw new Error("网页尚未就绪，无法截图。");
  }

  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "mori-browser-capture-"));
  try {
    const filePath = path.join(directory, "screenshot.png");
    await (deps.capture ?? captureGuestScreenshot)(guest, filePath);
    const bytes = await fs.readFile(filePath);
    return await deps.store.ingestFromToolInput({
      threadId: instance.threadId,
      toolInput: {
        source: "base64",
        data: bytes.toString("base64"),
        mimeType: "image/png",
        title: instance.title || instance.url,
      },
    });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}
