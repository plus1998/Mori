import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";
import type {
  WorkspaceFileBrowserRequest,
  WorkspaceFileEntry,
  WorkspaceFileReadRequest,
  WorkspaceFileReadResult,
  WorkspaceFileWriteRequest,
  WorkspaceFileWriteResult,
} from "../shared/ipc";
import { WorkspaceFileStreams } from "./workspace-file-stream";

const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const TEXT_PROBE_BYTES = 4;
const MEDIA_SIGNATURE_BYTES = 64;

const MEDIA_TYPES = new Map<string, { kind: "image" | "audio" | "video" | "pdf"; mimeType: string }>([
  [".png", { kind: "image", mimeType: "image/png" }],
  [".jpg", { kind: "image", mimeType: "image/jpeg" }],
  [".jpeg", { kind: "image", mimeType: "image/jpeg" }],
  [".gif", { kind: "image", mimeType: "image/gif" }],
  [".webp", { kind: "image", mimeType: "image/webp" }],
  [".avif", { kind: "image", mimeType: "image/avif" }],
  [".bmp", { kind: "image", mimeType: "image/bmp" }],
  [".ico", { kind: "image", mimeType: "image/x-icon" }],
  [".pdf", { kind: "pdf", mimeType: "application/pdf" }],
  [".weba", { kind: "audio", mimeType: "audio/webm" }],
  [".m4v", { kind: "video", mimeType: "video/mp4" }],
  [".mov", { kind: "video", mimeType: "video/mp4" }],
  [".mp3", { kind: "audio", mimeType: "audio/mpeg" }],
  [".wav", { kind: "audio", mimeType: "audio/wav" }],
  [".ogg", { kind: "audio", mimeType: "audio/ogg" }],
  // Ogg containers that Chromium decodes as Opus; `audio/ogg` is the type <audio> accepts here.
  [".oga", { kind: "audio", mimeType: "audio/ogg" }],
  [".opus", { kind: "audio", mimeType: "audio/ogg" }],
  [".flac", { kind: "audio", mimeType: "audio/flac" }],
  [".aac", { kind: "audio", mimeType: "audio/aac" }],
  [".m4a", { kind: "audio", mimeType: "audio/mp4" }],
  [".m4b", { kind: "audio", mimeType: "audio/mp4" }],
  [".mp4", { kind: "video", mimeType: "video/mp4" }],
  [".webm", { kind: "video", mimeType: "video/webm" }],
]);

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} is required.`);
  }
  return value.trim();
}

function isContained(workspacePath: string, targetPath: string): boolean {
  const relative = path.relative(workspacePath, targetPath);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

function sameFile(left: { dev: number; ino: number }, right: { dev: number; ino: number }): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function openReadFlags(): number {
  const noFollow = (fsConstants as typeof fsConstants & { O_NOFOLLOW?: number }).O_NOFOLLOW;
  return fsConstants.O_RDONLY | (typeof noFollow === "number" ? noFollow : 0);
}

/**
 * 只用 `O_WRONLY`（POSIX 上再叠加 `O_NOFOLLOW`）打开：截断交给校验通过后的
 * `handle.truncate(0)` —— Windows 的 open 会拒绝 `O_WRONLY|O_TRUNC`（EINVAL），先校验再截断也避免
 * 竞态下截断到别的文件。
 */
function openWriteFlags(): number {
  const noFollow = (fsConstants as typeof fsConstants & { O_NOFOLLOW?: number }).O_NOFOLLOW;
  return fsConstants.O_WRONLY | (typeof noFollow === "number" ? noFollow : 0);
}

async function readHandleBytes(handle: fs.FileHandle, length: number, start = 0): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  let bytesRead = 0;
  while (bytesRead < length) {
    const result = await handle.read(buffer, bytesRead, length - bytesRead, start + bytesRead);
    if (result.bytesRead === 0) break;
    bytesRead += result.bytesRead;
  }
  return buffer.subarray(0, bytesRead);
}

async function resolveWorkspace(workspacePath: string): Promise<string> {
  const resolved = await fs.realpath(requireString(workspacePath, "Workspace path"));
  const stat = await fs.stat(resolved);
  if (!stat.isDirectory()) {
    throw new Error("Workspace path must be a directory.");
  }
  return resolved;
}

async function resolveContainedTarget(
  workspacePath: string,
  targetPath: string,
): Promise<{
  workspaceRealPath: string;
  requestedPath: string;
  realPath: string;
}> {
  const workspaceRealPath = await resolveWorkspace(workspacePath);
  const requestedPath = path.resolve(requireString(targetPath, "Path"));
  const realPath = await fs.realpath(requestedPath);
  if (!isContained(workspaceRealPath, realPath)) {
    throw new Error("Path must be inside the workspace.");
  }
  return { workspaceRealPath, requestedPath, realPath };
}

async function resolvePreviewTarget(targetPath: string) {
  const requestedPath = requireString(targetPath, "Path");
  if (!path.isAbsolute(requestedPath)) throw new Error("Preview path must be absolute.");
  return { requestedPath, realPath: await fs.realpath(requestedPath) };
}

export async function listWorkspaceEntries(
  request: WorkspaceFileBrowserRequest,
): Promise<WorkspaceFileEntry[]> {
  const { requestedPath, realPath } = await resolvePreviewTarget(request.directoryPath);
  const stat = await fs.stat(realPath);
  if (!stat.isDirectory()) {
    throw new Error("Directory path must be a directory.");
  }
  const entries = await fs.readdir(realPath, { withFileTypes: true });
  const result: WorkspaceFileEntry[] = [];
  for (const entry of entries) {
    const entryPath = path.join(requestedPath, entry.name);
    const entryStat = await fs.stat(entryPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "ELOOP") return undefined;
      throw error;
    });
    if (!entryStat) continue;
    if (entryStat.isDirectory()) {
      result.push({ name: entry.name, path: entryPath, kind: "directory" });
    } else if (entryStat.isFile()) {
      result.push({ name: entry.name, path: entryPath, kind: "file", size: entryStat.size });
    }
  }
  const finalDirectoryPath = await fs.realpath(requestedPath);
  if (finalDirectoryPath !== realPath) {
    throw new Error("Directory changed while it was being read.");
  }
  return result.sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;
    return left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
  });
}

function hasMediaSignature(kind: "image" | "audio" | "video" | "pdf", buffer: Buffer): boolean {
  const startsWith = (...bytes: number[]): boolean => bytes.every((byte, index) => buffer[index] === byte);
  switch (kind) {
    case "pdf":
      return buffer.subarray(0, 5).toString("ascii") === "%PDF-";
    case "image":
      return (
        startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a) ||
        startsWith(0xff, 0xd8, 0xff) ||
        startsWith(0x42, 0x4d) ||
        startsWith(0, 0, 1, 0) ||
        (buffer.subarray(4, 8).toString("ascii") === "ftyp" && buffer.includes(Buffer.from("avif"))) ||
        buffer.subarray(0, 6).toString("ascii") === "GIF87a" ||
        buffer.subarray(0, 6).toString("ascii") === "GIF89a" ||
        (startsWith(0x52, 0x49, 0x46, 0x46) && buffer.subarray(8, 12).toString("ascii") === "WEBP")
      );
    case "audio":
      return (
        buffer.subarray(0, 3).toString("ascii") === "ID3" ||
        (buffer.length >= 2 && buffer[0] === 0xff && (buffer[1]! & 0xe0) === 0xe0) ||
        (buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
          buffer.subarray(8, 12).toString("ascii") === "WAVE") ||
        buffer.subarray(0, 4).toString("ascii") === "OggS" ||
        buffer.subarray(0, 4).toString("ascii") === "fLaC" ||
        (startsWith(0x1a, 0x45, 0xdf, 0xa3) && buffer.includes(Buffer.from("webm"))) ||
        (buffer.subarray(4, 8).toString("ascii") === "ftyp" &&
          buffer.subarray(8, 12).toString("ascii").toLowerCase().startsWith("m4"))
      );
    case "video":
      return (
        (buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
          buffer.subarray(8, 12).toString("ascii") === "WEBM") ||
        buffer.subarray(0, 4).toString("ascii") === "OggS" ||
        buffer.subarray(4, 8).toString("ascii") === "ftyp" ||
        (startsWith(0x1a, 0x45, 0xdf, 0xa3) && buffer.includes(Buffer.from("webm")))
      );
  }
}

function unsupportedResult(
  filePath: string,
  name: string,
  size: number,
  reason: string,
): WorkspaceFileReadResult {
  return { path: filePath, name, size, kind: "unsupported", reason };
}

function findUtf8Boundary(buffer: Buffer, allowIncompleteAtEnd: boolean): number | undefined {
  let index = 0;
  while (index < buffer.length) {
    const first = buffer[index];
    if (first === undefined) return undefined;
    if (first === 0) return undefined;
    if (first <= 0x7f) {
      index += 1;
      continue;
    }

    const sequenceLength =
      first >= 0xc2 && first <= 0xdf
        ? 2
        : first >= 0xe0 && first <= 0xef
          ? 3
          : first >= 0xf0 && first <= 0xf4
            ? 4
            : 0;
    if (sequenceLength === 0) return undefined;
    if (index + sequenceLength > buffer.length) {
      return allowIncompleteAtEnd ? index : undefined;
    }
    const second = buffer[index + 1];
    if (second === undefined) return undefined;
    for (let offset = 1; offset < sequenceLength; offset += 1) {
      const continuation = buffer[index + offset];
      if (continuation === undefined || continuation < 0x80 || continuation > 0xbf) return undefined;
    }
    if (
      (sequenceLength === 3 && ((first === 0xe0 && second < 0xa0) || (first === 0xed && second > 0x9f))) ||
      (sequenceLength === 4 && ((first === 0xf0 && second < 0x90) || (first === 0xf4 && second > 0x8f)))
    ) {
      return undefined;
    }
    index += sequenceLength;
  }
  return index;
}

function readTextSample(
  sample: Buffer,
  size: number,
  bytesRead: number,
):
  | {
      content: string;
      truncated: boolean;
    }
  | undefined {
  const boundary = findUtf8Boundary(sample, size > bytesRead);
  if (boundary === undefined) return undefined;

  const outputBytes = Math.min(boundary, MAX_TEXT_BYTES);
  const outputBoundary = findUtf8Boundary(sample.subarray(0, outputBytes), true);
  if (outputBoundary === undefined) return undefined;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  return {
    content: decoder.decode(sample.subarray(0, outputBoundary)),
    truncated: size > MAX_TEXT_BYTES || bytesRead > MAX_TEXT_BYTES,
  };
}

export const workspaceFileStreams = new WorkspaceFileStreams(openWorkspaceFileForStreaming);

export async function openWorkspaceFileForStreaming(
  request: WorkspaceFileReadRequest,
): Promise<{ handle: fs.FileHandle; size: number; revision: string }> {
  const { requestedPath, realPath } = await resolveContainedTarget(request.workspacePath, request.filePath);
  return openPreviewFile(requestedPath, realPath, request.revision);
}

async function openPreviewFile(requestedPath: string, realPath: string, expectedRevision?: string) {
  const handle = await fs.open(realPath, openReadFlags());
  try {
    const fileStat = await handle.stat();
    if (!fileStat.isFile()) {
      throw new Error("File path must be a regular file.");
    }
    const refreshedFilePath = await fs.realpath(requestedPath);
    if (refreshedFilePath !== realPath) {
      throw new Error("File changed while it was being opened.");
    }
    const pathStat = await fs.stat(requestedPath);
    if (!sameFile(fileStat, pathStat)) {
      throw new Error("File changed while it was being opened.");
    }
    const revision = `${fileStat.dev}:${fileStat.ino}:${fileStat.size}:${fileStat.mtimeMs}`;
    if (expectedRevision !== undefined && expectedRevision !== revision)
      throw new Error("File changed. Reopen it before loading more content.");
    return { handle, size: fileStat.size, revision };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

export async function readWorkspaceFile(request: WorkspaceFileReadRequest): Promise<WorkspaceFileReadResult> {
  const { requestedPath, realPath } = await resolvePreviewTarget(request.filePath);
  const workspaceRealPath = await resolveWorkspace(request.workspacePath);
  // External files get a directory-scoped stream capability for sibling resources.
  const streamRoot = isContained(workspaceRealPath, realPath) ? workspaceRealPath : path.dirname(realPath);
  const name = path.basename(requestedPath);
  const extension = path.extname(name).toLowerCase();
  const media = MEDIA_TYPES.get(extension);
  const { handle, size, revision } = await openPreviewFile(requestedPath, realPath, request.revision);
  try {
    if (media) {
      const mediaBuffer = await readHandleBytes(handle, Math.min(size, MEDIA_SIGNATURE_BYTES));
      if (!hasMediaSignature(media.kind, mediaBuffer)) {
        return unsupportedResult(
          requestedPath,
          name,
          size,
          "Media signature does not match the file extension.",
        );
      }
      return {
        path: requestedPath,
        name,
        size,
        kind: media.kind,
        mimeType: media.mimeType,
        url: workspaceFileStreams.urlForFile(streamRoot, realPath),
      };
    }
    const offset = request.offset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > size) throw new Error("Invalid file offset.");
    const remainingSize = size - offset;
    const textBuffer = await readHandleBytes(
      handle,
      Math.min(remainingSize, MAX_TEXT_BYTES + TEXT_PROBE_BYTES),
      offset,
    );
    const text = readTextSample(textBuffer, remainingSize, textBuffer.length);
    if (!text) {
      return unsupportedResult(requestedPath, name, size, "File is not valid UTF-8 text.");
    }
    return {
      path: requestedPath,
      name,
      size,
      kind: "text",
      mimeType: "text/plain",
      url: workspaceFileStreams.urlForFile(streamRoot, realPath),
      readOnly: !isContained(workspaceRealPath, realPath) || (await fs.lstat(requestedPath)).isSymbolicLink(),
      content: text.content,
      revision,
      ...(text.truncated
        ? { truncated: true, nextOffset: offset + Buffer.byteLength(text.content, "utf8") }
        : {}),
    };
  } finally {
    await handle.close();
  }
}

export async function writeWorkspaceFile(
  request: WorkspaceFileWriteRequest,
): Promise<WorkspaceFileWriteResult> {
  if (typeof request.content !== "string") {
    throw new Error("Content must be a string.");
  }
  const { requestedPath } = await resolveContainedTarget(request.workspacePath, request.filePath);
  const name = path.basename(requestedPath);
  const linkStat = await fs.lstat(requestedPath);
  if (linkStat.isSymbolicLink()) {
    throw new Error("Refusing to write through a symbolic link.");
  }
  if (!linkStat.isFile()) {
    throw new Error("File path must be a regular file.");
  }
  const handle = await fs.open(requestedPath, openWriteFlags());
  try {
    const fileStat = await handle.stat();
    if (!fileStat.isFile()) {
      throw new Error("File path must be a regular file.");
    }
    if (!sameFile(linkStat, fileStat)) {
      throw new Error("File changed while it was being opened.");
    }
    const refreshedWorkspacePath = await resolveWorkspace(request.workspacePath);
    const refreshedFilePath = await fs.realpath(requestedPath);
    if (!isContained(refreshedWorkspacePath, refreshedFilePath)) {
      throw new Error("Path must be inside the workspace.");
    }
    const buffer = Buffer.from(request.content, "utf8");
    await handle.truncate(0);
    await handle.writeFile(buffer);
    const writtenStat = await handle.stat();
    const finalWorkspacePath = await resolveWorkspace(request.workspacePath);
    const finalFilePath = await fs.realpath(requestedPath);
    if (!isContained(finalWorkspacePath, finalFilePath)) {
      throw new Error("Path must be inside the workspace.");
    }
    return {
      path: requestedPath,
      name,
      size: writtenStat.size,
    };
  } finally {
    await handle.close();
  }
}
