import { afterEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ComposerFileStore } from "../src/main/composer-file-store";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const directory = tempDirs.pop();
    if (directory) await fs.rm(directory, { recursive: true, force: true });
  }
});

async function createStore(): Promise<ComposerFileStore> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "eco-composer-file-store-"));
  tempDirs.push(directory);
  return new ComposerFileStore(directory);
}

test("uploads arbitrary files in resumable chunks and returns a desktop path", async () => {
  const store = await createStore();
  const upload = { uploadId: "file_test_upload", fileName: "../notes.txt", totalBytes: 11 };

  await expect(store.beginUpload(upload)).resolves.toMatchObject({
    receivedBytes: 0,
    complete: false,
  });
  await expect(
    store.writeChunk({
      uploadId: upload.uploadId,
      fileName: upload.fileName,
      offset: 0,
      dataBase64: Buffer.from("hello ").toString("base64"),
    }),
  ).resolves.toEqual({ receivedBytes: 6 });
  await expect(
    store.writeChunk({
      uploadId: upload.uploadId,
      fileName: upload.fileName,
      offset: 6,
      dataBase64: Buffer.from("world").toString("base64"),
    }),
  ).resolves.toEqual({ receivedBytes: 11 });

  const finished = await store.finishUpload(upload);
  expect(finished.byteLength).toBe(11);
  expect(finished.path).toContain(`${path.sep}composer-files${path.sep}file_test_upload${path.sep}`);
  expect(path.basename(finished.path)).toBe("notes.txt");
  await expect(fs.readFile(finished.path, "utf8")).resolves.toBe("hello world");
});

test("resumes an existing partial upload and rejects offset mismatches", async () => {
  const store = await createStore();
  const upload = { uploadId: "file_resume_test", fileName: "data.bin", totalBytes: 5 };
  await store.beginUpload(upload);
  await store.writeChunk({
    uploadId: upload.uploadId,
    fileName: upload.fileName,
    offset: 0,
    dataBase64: Buffer.from("ab").toString("base64"),
  });

  await expect(store.beginUpload(upload)).resolves.toMatchObject({
    receivedBytes: 2,
    complete: false,
  });
  await expect(
    store.writeChunk({
      uploadId: upload.uploadId,
      fileName: upload.fileName,
      offset: 0,
      dataBase64: Buffer.from("c").toString("base64"),
    }),
  ).rejects.toThrow("offset mismatch");
});
