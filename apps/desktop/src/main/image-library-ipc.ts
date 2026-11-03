import { existsSync } from "node:fs";
import path from "node:path";
import { BrowserWindow, dialog, nativeImage } from "electron";
import type { ImageLibraryBatchResult, ImageLibraryQuery, LibraryImage } from "../shared/image-library";
import { IPC_CHANNELS, type IpcChannel } from "../shared/ipc";
import { type ImageLibraryStore, validateImageIds } from "./image-library-store";

type Register = (channel: IpcChannel, handler: (payload: unknown) => unknown) => void;
const inputRecord = (input: unknown): Record<string, unknown> => {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("图片库请求无效。");
  return input as Record<string, unknown>;
};

export function notifyImageLibraryChanged() {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(IPC_CHANNELS.imageLibraryChanged);
  }
}

export function registerImageLibraryCommands(
  register: Register,
  store: ImageLibraryStore,
  getThread: (id: string) => { title: string } | undefined,
) {
  const source = (item: LibraryImage): LibraryImage => {
    const thread = getThread(item.threadId);
    return {
      ...item,
      sourceDeleted: item.sourceKind === "conversation" && !thread,
      ...(thread ? { sourceTitle: thread.title } : {}),
    };
  };
  register(IPC_CHANNELS.imageLibraryList, (payload) => {
    const result = store.list(inputRecord(payload) as ImageLibraryQuery);
    return {
      ...result,
      items: result.items.map(source),
      threads: result.threads.map((thread) => {
        const title = getThread(thread.id)?.title;
        return { ...thread, ...(title ? { title } : {}) };
      }),
    };
  });
  register(IPC_CHANNELS.imageLibraryGet, (payload) =>
    source(store.get(String(inputRecord(payload).id ?? ""))),
  );
  register(IPC_CHANNELS.imageLibraryRead, (payload) => {
    const input = inputRecord(payload);
    return store.read(String(input.id ?? ""), input.thumbnail === true, (bytes) => {
      const image = nativeImage.createFromBuffer(bytes);
      if (image.isEmpty()) throw new Error("无法解码图片缩略图。");
      const size = image.getSize();
      const scale = Math.min(1, 320 / Math.max(size.width, size.height));
      return image
        .resize({
          width: Math.max(1, Math.round(size.width * scale)),
          height: Math.max(1, Math.round(size.height * scale)),
          quality: "good",
        })
        .toPNG();
    });
  });
  register(IPC_CHANNELS.imageLibraryChangeState, async (payload) => {
    const input = inputRecord(payload);
    if (input.action !== "trash" && input.action !== "restore" && input.action !== "purge")
      throw new Error("图片操作无效。");
    const result = await store.changeState(validateImageIds(input.ids), input.action);
    if (result.succeededIds.length) notifyImageLibraryChanged();
    return result;
  });
  register(IPC_CHANNELS.imageLibraryExport, async (payload) => {
    const ids = validateImageIds(inputRecord(payload).ids);
    const result: ImageLibraryBatchResult = { succeededIds: [], errors: [], freedBytes: 0 };
    let directory: string | undefined;
    if (ids.length > 1) {
      const picked = await dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"] });
      if (picked.canceled || !picked.filePaths[0]) return result;
      directory = picked.filePaths[0];
    }
    for (const id of ids) {
      try {
        const image = store.get(id);
        let target: string;
        if (directory) target = path.join(directory, image.fileName);
        else {
          const picked = await dialog.showSaveDialog({ defaultPath: image.fileName });
          if (picked.canceled || !picked.filePath) continue;
          target = picked.filePath;
        }
        let overwrite = false;
        // showSaveDialog already obtains native overwrite confirmation for single exports.
        if (existsSync(target)) {
          if (!directory) overwrite = true;
          else {
            const confirmation = await dialog.showMessageBox({
              type: "question",
              message: `替换已有文件 ${path.basename(target)}？`,
              buttons: ["取消", "替换"],
              defaultId: 0,
              cancelId: 0,
            });
            if (confirmation.response !== 1) continue;
            overwrite = true;
          }
        }
        await store.exportImage(id, target, overwrite);
        result.succeededIds.push(id);
      } catch (error) {
        result.errors.push({ id, message: error instanceof Error ? error.message : String(error) });
      }
    }
    return result;
  });
}
