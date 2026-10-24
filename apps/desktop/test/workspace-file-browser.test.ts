import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  listWorkspaceEntries,
  readWorkspaceFile,
  writeWorkspaceFile,
  workspaceFileStreams,
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
    url: expect.stringMatching(/^eco-workspace:\/\//),
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
    expect(result.kind).toBe("audio");
    expect(result.mimeType).toBe(mimeType);
    expect(result.url).toStartWith("eco-workspace://");
    expect(result.base64).toBeUndefined();
    const response = await workspaceFileStreams.respond(new Request(result.url!));
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
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

test("large media returns a stream descriptor without reading the whole file", async () => {
  const filePath = path.join(workspacePath, "large.mp4");
  const handle = await fs.open(filePath, "w");
  await handle.write(Buffer.from("\x00\x00\x00\x18ftypisom", "latin1"));
  await handle.truncate(5 * 1024 * 1024 * 1024);
  await handle.close();
  const result = await readWorkspaceFile({ workspacePath, filePath });
  expect(result.kind).toBe("video");
  expect(result.size).toBe(5 * 1024 * 1024 * 1024);
  expect(result.base64).toBeUndefined();
  const response = await workspaceFileStreams.respond(
    new Request(result.url!, { headers: { Range: "bytes=-4" } }),
  );
  expect(response.status).toBe(206);
  expect(response.headers.get("Content-Length")).toBe("4");
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array(4));
});

test("previews external files, including symlinks, and keeps them read-only", async () => {
  await expect(readWorkspaceFile({ workspacePath, filePath: workspacePath })).rejects.toThrow("regular file");
  const outsideFile = path.join(outsidePath, "external.txt");
  await fs.writeFile(outsideFile, "external content");
  const symlinkPath = path.join(workspacePath, "linked.txt");
  await fs.symlink(outsideFile, symlinkPath);
  for (const filePath of [outsideFile, symlinkPath]) {
    const result = await readWorkspaceFile({ workspacePath, filePath });
    expect(result).toMatchObject({
      path: filePath,
      kind: "text",
      content: "external content",
      readOnly: true,
    });
    const response = await workspaceFileStreams.respond(new Request(result.url!));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("external content");
  }
  await expect(readWorkspaceFile({ workspacePath, filePath: "relative.txt" })).rejects.toThrow("absolute");
});

test("lists external directories and file/directory symlinks, skipping dangling links", async () => {
  const outsideDirectory = path.join(outsidePath, "outside-dir");
  await fs.mkdir(outsideDirectory);
  await fs.writeFile(path.join(outsideDirectory, "note.txt"), "visible");
  const linkedDirectory = path.join(workspacePath, "linked-dir");
  await fs.symlink(outsideDirectory, linkedDirectory);
  await fs.symlink(path.join(outsideDirectory, "note.txt"), path.join(workspacePath, "linked.txt"));
  await fs.symlink(path.join(outsidePath, "missing"), path.join(workspacePath, "dangling"));
  const entries = await listWorkspaceEntries({ workspacePath, directoryPath: workspacePath });
  expect(entries.map((entry) => [entry.name, entry.kind])).toEqual([
    ["linked-dir", "directory"],
    ["linked.txt", "file"],
  ]);
  for (const directoryPath of [outsideDirectory, linkedDirectory]) {
    expect(await listWorkspaceEntries({ workspacePath, directoryPath })).toEqual([
      { name: "note.txt", kind: "file", path: path.join(directoryPath, "note.txt"), size: 7 },
    ]);
  }
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

test("large UTF-8 text can be loaded across chunk boundaries without losing multibyte characters", async () => {
  const filePath = path.join(outsidePath, "large.txt");
  const content = `${"a".repeat(2 * 1024 * 1024 - 2)}😀最后一段`;
  await fs.writeFile(filePath, content);
  const first = await readWorkspaceFile({ workspacePath, filePath });
  expect(first.nextOffset).toBe(2 * 1024 * 1024 - 2);
  const next = await readWorkspaceFile({
    workspacePath,
    filePath,
    offset: first.nextOffset!,
    revision: first.revision!,
  });
  expect(first.content + next.content!).toBe(content);
  expect(next.truncated).toBeUndefined();
  expect(next.nextOffset).toBeUndefined();
  await fs.writeFile(filePath, `${content}changed`);
  await expect(
    readWorkspaceFile({ workspacePath, filePath, offset: first.nextOffset!, revision: first.revision! }),
  ).rejects.toThrow("File changed");
});

test("PDF and extra native image/video formats are recognized without Base64 payloads", async () => {
  for (const [name, header, kind] of [
    ["document.pdf", Buffer.from("%PDF-1.7\n"), "pdf"],
    ["image.bmp", Buffer.from([0x42, 0x4d, 0, 0]), "image"],
    ["image.ico", Buffer.from([0, 0, 1, 0]), "image"],
    ["image.avif", Buffer.from("\x00\x00\x00\x18ftypavif", "latin1"), "image"],
    ["video.mov", Buffer.from("\x00\x00\x00\x18ftypqt  ", "latin1"), "video"],
  ] as const) {
    const filePath = path.join(outsidePath, name);
    await fs.writeFile(filePath, header);
    const result = await readWorkspaceFile({ workspacePath, filePath });
    expect(result.kind).toBe(kind);
    expect(result.url).toStartWith("eco-workspace://");
    expect(result.base64).toBeUndefined();
  }
});

test("external HTML retains sibling resources without granting access to parent directories", async () => {
  const filePath = path.join(outsidePath, "page.html");
  await fs.writeFile(filePath, '<link rel="stylesheet" href="style.css"><h1>Hello</h1>');
  await fs.writeFile(path.join(outsidePath, "style.css"), "h1 { color: red }");
  const result = await readWorkspaceFile({ workspacePath, filePath });
  const style = await workspaceFileStreams.respond(new Request(new URL("./style.css", result.url!)));
  expect(style.status).toBe(200);
  expect(await style.text()).toBe("h1 { color: red }");
  const host = new URL(result.url!).host;
  expect(
    (await workspaceFileStreams.respond(new Request(`eco-workspace://${host}/%2e%2e%2foutside`))).status,
  ).toBe(403);
});
