import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  listWorkspaceEntries,
  readWorkspaceFile,
  writeWorkspaceFile,
} from "../src/main/workspace-file-browser";

let workspacePath = "";
let outsidePath = "";

beforeEach(async () => {
  workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), "eco-workspace-browser-"));
  outsidePath = await fs.mkdtemp(path.join(os.tmpdir(), "eco-workspace-outside-"));
});

afterEach(async () => {
  await fs.rm(workspacePath, { recursive: true, force: true });
  await fs.rm(outsidePath, { recursive: true, force: true });
});

test("lists direct entries with directories first and case-insensitive names", async () => {
  await fs.mkdir(path.join(workspacePath, "z-dir"));
  await fs.mkdir(path.join(workspacePath, "A-dir"));
  await fs.writeFile(path.join(workspacePath, "b.txt"), "b");
  await fs.writeFile(path.join(workspacePath, "A.txt"), "a");
  const entries = await listWorkspaceEntries({ workspacePath, directoryPath: workspacePath });

  expect(entries.map((entry) => [entry.name, entry.kind])).toEqual([
    ["A-dir", "directory"],
    ["z-dir", "directory"],
    ["A.txt", "file"],
    ["b.txt", "file"],
  ]);
});

test("reads UTF-8 text and truncates it at 2 MiB", async () => {
  const filePath = path.join(workspacePath, "notes.txt");
  await fs.writeFile(filePath, "a".repeat(2 * 1024 * 1024 + 10));
  const result = await readWorkspaceFile({ workspacePath, filePath });

  expect(result.kind).toBe("text");
  expect(result.content?.length).toBe(2 * 1024 * 1024);
  expect(result.truncated).toBe(true);
  expect(result.size).toBe(2 * 1024 * 1024 + 10);
});

test("reads extensionless, dotfile, and unknown-extension UTF-8 text", async () => {
  for (const name of ["README", ".env", "notes.custom"]) {
    const filePath = path.join(workspacePath, name);
    await fs.writeFile(filePath, "KEY=值\n");
    const result = await readWorkspaceFile({ workspacePath, filePath });
    expect(result).toMatchObject({ kind: "text", content: "KEY=值\n" });
  }
});

test("limits large text reads and keeps UTF-8 truncation on a character boundary", async () => {
  const filePath = path.join(workspacePath, "large.custom");
  const prefix = "a".repeat(2 * 1024 * 1024 - 2);
  const source = `${prefix}😀tail`;
  await fs.writeFile(filePath, source);
  const result = await readWorkspaceFile({ workspacePath, filePath });

  expect(result.kind).toBe("text");
  expect(result.truncated).toBe(true);
  expect(result.content).toBe(prefix);
  expect(result.content).not.toContain("\ufffd");
});

test("rejects invalid UTF-8 and NUL-containing files", async () => {
  const invalidPath = path.join(workspacePath, "invalid.data");
  const nulPath = path.join(workspacePath, "has-nul");
  await fs.writeFile(invalidPath, Buffer.from([0xc3, 0x28]));
  await fs.writeFile(nulPath, Buffer.from("valid\0text"));

  const invalid = await readWorkspaceFile({ workspacePath, filePath: invalidPath });
  const nul = await readWorkspaceFile({ workspacePath, filePath: nulPath });
  expect(invalid).toMatchObject({ kind: "unsupported" });
  expect(nul).toMatchObject({ kind: "unsupported" });
  expect(invalid.reason).toContain("UTF-8");
  expect(nul.reason).toContain("UTF-8");
});

test("rejects unknown binary files and supports whitelisted media", async () => {
  const binaryPath = path.join(workspacePath, "data.bin");
  const imagePath = path.join(workspacePath, "photo.PNG");
  await fs.writeFile(binaryPath, Buffer.from([0, 1, 2, 255]));
  await fs.writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

  const binary = await readWorkspaceFile({ workspacePath, filePath: binaryPath });
  const image = await readWorkspaceFile({ workspacePath, filePath: imagePath });
  expect(binary.kind).toBe("unsupported");
  expect(binary.reason).toContain("UTF-8");
  expect(image).toMatchObject({
    kind: "image",
    mimeType: "image/png",
    base64: "iVBORw0KGgo=",
  });
});

test("plays generated and common audio containers in the file browser", async () => {
  const cases: Array<[string, Buffer, string]> = [
    ["speech.mp3", Buffer.from("ID3\x03\x00fake-id3-tag", "latin1"), "audio/mpeg"],
    ["speech.wav", Buffer.from("RIFF\x00\x00\x00\x00WAVEfmt ", "latin1"), "audio/wav"],
    ["speech.ogg", Buffer.from("OggS\x00\x02", "latin1"), "audio/ogg"],
    ["speech.opus", Buffer.from("OggS\x00\x02", "latin1"), "audio/ogg"],
    ["speech.flac", Buffer.from("fLaC\x00\x00\x00\x22", "latin1"), "audio/flac"],
    ["speech.aac", Buffer.from([0xff, 0xf1, 0x50, 0x80]), "audio/aac"],
    ["book.m4b", Buffer.from("\x00\x00\x00\x18ftypM4A \x00\x00\x00\x00", "latin1"), "audio/mp4"],
  ];
  for (const [name, bytes, mimeType] of cases) {
    const filePath = path.join(workspacePath, name);
    await fs.writeFile(filePath, bytes);
    const result = await readWorkspaceFile({ workspacePath, filePath });
    expect(result, name).toMatchObject({ kind: "audio", mimeType, base64: bytes.toString("base64") });
  }
});

test("rejects media files whose signatures do not match their extensions", async () => {
  const fakePngPath = path.join(workspacePath, "fake.png");
  const fakeMp3Path = path.join(workspacePath, "fake.mp3");
  await fs.writeFile(fakePngPath, "plain text");
  await fs.writeFile(fakeMp3Path, Buffer.from([0, 1, 2, 3]));

  const fakePng = await readWorkspaceFile({ workspacePath, filePath: fakePngPath });
  const fakeMp3 = await readWorkspaceFile({ workspacePath, filePath: fakeMp3Path });
  expect(fakePng).toMatchObject({ kind: "unsupported" });
  expect(fakeMp3).toMatchObject({ kind: "unsupported" });
  expect(fakePng.reason).toContain("signature");
  expect(fakeMp3.reason).toContain("signature");
});

test("rejects oversized media with an understandable reason", async () => {
  const filePath = path.join(workspacePath, "large.mp4");
  await fs.writeFile(filePath, Buffer.alloc(20 * 1024 * 1024 + 1));
  const result = await readWorkspaceFile({ workspacePath, filePath });

  expect(result.kind).toBe("unsupported");
  expect(result.reason).toContain("20 MiB");
});

test("rejects directories, workspace escapes, and symlink escapes", async () => {
  await expect(readWorkspaceFile({ workspacePath, filePath: workspacePath })).rejects.toThrow("regular file");

  const outsideFile = path.join(outsidePath, "secret.txt");
  await fs.writeFile(outsideFile, "secret");
  await expect(readWorkspaceFile({ workspacePath, filePath: outsideFile })).rejects.toThrow(
    "inside the workspace",
  );

  const symlinkPath = path.join(workspacePath, "secret.txt");
  await fs.symlink(outsideFile, symlinkPath);
  await expect(readWorkspaceFile({ workspacePath, filePath: symlinkPath })).rejects.toThrow(
    "inside the workspace",
  );
});

test("does not expose symlink entries", async () => {
  const outsideDirectory = path.join(outsidePath, "outside-dir");
  await fs.mkdir(outsideDirectory);
  await fs.symlink(outsideDirectory, path.join(workspacePath, "linked-dir"));
  await fs.writeFile(path.join(workspacePath, "visible.txt"), "visible");

  const entries = await listWorkspaceEntries({ workspacePath, directoryPath: workspacePath });
  expect(entries.map((entry) => entry.name)).toEqual(["visible.txt"]);
});

test("writes UTF-8 text into an existing workspace file", async () => {
  const filePath = path.join(workspacePath, "notes.txt");
  await fs.writeFile(filePath, "old");
  const result = await writeWorkspaceFile({
    workspacePath,
    filePath,
    content: "你好\nworld",
  });

  expect(result).toEqual({
    path: filePath,
    name: "notes.txt",
    size: Buffer.byteLength("你好\nworld", "utf8"),
  });
  expect(await fs.readFile(filePath, "utf8")).toBe("你好\nworld");
});

test("rejects writing directories, workspace escapes, and symlinks", async () => {
  await expect(
    writeWorkspaceFile({ workspacePath, filePath: workspacePath, content: "nope" }),
  ).rejects.toThrow("regular file");

  const outsideFile = path.join(outsidePath, "secret.txt");
  await fs.writeFile(outsideFile, "secret");
  await expect(writeWorkspaceFile({ workspacePath, filePath: outsideFile, content: "nope" })).rejects.toThrow(
    "inside the workspace",
  );

  const symlinkPath = path.join(workspacePath, "linked.txt");
  await fs.symlink(outsideFile, symlinkPath);
  await expect(writeWorkspaceFile({ workspacePath, filePath: symlinkPath, content: "nope" })).rejects.toThrow(
    /symbolic link|inside the workspace/,
  );
  expect(await fs.readFile(outsideFile, "utf8")).toBe("secret");
});

test("does not create missing files when writing", async () => {
  const missingPath = path.join(workspacePath, "missing.txt");
  await expect(
    writeWorkspaceFile({ workspacePath, filePath: missingPath, content: "new" }),
  ).rejects.toThrow();
  await expect(fs.stat(missingPath)).rejects.toThrow();
});
