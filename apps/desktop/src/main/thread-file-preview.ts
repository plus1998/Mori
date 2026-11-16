import path from "node:path";
import { homedir } from "node:os";
import fs from "node:fs/promises";
import type { ThreadFileReadRequest } from "../shared/ipc";
import { readFilePreviewChunk } from "./workspace-file-browser";

export async function readThreadFilePreview(
  input: ThreadFileReadRequest,
  context: { workspacePath: string; worktreePathHint?: string },
) {
  if (typeof input.filePath !== "string" || !input.filePath.trim() || input.filePath.includes("\0")) {
    throw new Error("A file path is required.");
  }
  if (input.relativeTo !== undefined &&
      (typeof input.relativeTo !== "string" || !path.isAbsolute(input.relativeTo))) {
    throw new Error("The source file path must be absolute.");
  }
  if (input.revision !== undefined && typeof input.revision !== "string") {
    throw new Error("Invalid file revision.");
  }
  const requested = input.filePath.startsWith("~/")
    ? path.join(homedir(), input.filePath.slice(2))
    : input.filePath;
  const root = input.relativeTo
    ? path.dirname(input.relativeTo)
    : context.worktreePathHint ?? context.workspacePath;
  if (!path.isAbsolute(requested) && !root) throw new Error("The conversation has no file directory.");
  const roots = await Promise.all(
    [context.workspacePath, context.worktreePathHint].filter((value): value is string => Boolean(value)).map((value) => fs.realpath(value)),
  );
  const absolute = path.resolve(root, requested);
  const target = await fs.realpath(absolute);
  const contained = roots.some((allowed) => {
    const relative = path.relative(allowed, target);
    return relative === "" || (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  });
  if (!contained) throw new Error("The file must be inside the conversation workspace.");
  return readFilePreviewChunk({
    filePath: target,
    ...(input.offset !== undefined ? { offset: input.offset } : {}),
    ...(input.revision !== undefined ? { revision: input.revision } : {}),
  });
}

/**
 * Lists a directory referenced by a conversation file link. Keep the same
 * workspace/worktree containment rules as file previews; a directory link
 * must never turn into an arbitrary filesystem browser.
 */
export async function listThreadDirectory(
  input: { filePath: string; relativeTo?: string },
  context: { workspacePath: string; worktreePathHint?: string },
) {
  if (typeof input.filePath !== "string" || !input.filePath.trim() || input.filePath.includes("\0")) {
    throw new Error("A directory path is required.");
  }
  if (input.relativeTo !== undefined &&
      (typeof input.relativeTo !== "string" || !path.isAbsolute(input.relativeTo))) {
    throw new Error("The source file path must be absolute.");
  }
  const requested = input.filePath.startsWith("~/")
    ? path.join(homedir(), input.filePath.slice(2))
    : input.filePath;
  const root = input.relativeTo
    ? path.dirname(input.relativeTo)
    : context.worktreePathHint ?? context.workspacePath;
  if (!path.isAbsolute(requested) && !root) throw new Error("The conversation has no file directory.");
  const roots = await Promise.all(
    [context.workspacePath, context.worktreePathHint]
      .filter((value): value is string => Boolean(value))
      .map((value) => fs.realpath(value)),
  );
  const absolute = path.resolve(root, requested);
  const target = await fs.realpath(absolute);
  const contained = roots.some((allowed) => {
    const relative = path.relative(allowed, target);
    return relative === "" || (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  });
  if (!contained) throw new Error("The directory must be inside the conversation workspace.");
  const stat = await fs.stat(target);
  if (!stat.isDirectory()) throw new Error("Directory path must be a directory.");

  const entries: Array<{ name: string; path: string; kind: "directory" | "file"; size?: number }> = [];
  for (const entry of await fs.readdir(target, { withFileTypes: true })) {
    const entryPath = path.join(target, entry.name);
    const entryStat = await fs.stat(entryPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "ELOOP") return undefined;
      throw error;
    });
    if (!entryStat) continue;
    const entryRealPath = await fs.realpath(entryPath).catch(() => undefined);
    if (!entryRealPath) continue;
    const entryContained = roots.some((allowed) => {
      const relative = path.relative(allowed, entryRealPath);
      return relative === "" || (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
    });
    if (!entryContained) continue;
    if (entryStat.isDirectory()) {
      entries.push({ name: entry.name, path: entryRealPath, kind: "directory" });
    } else if (entryStat.isFile()) {
      entries.push({ name: entry.name, path: entryRealPath, kind: "file", size: entryStat.size });
    }
  }
  entries.sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;
    return left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
  });
  const parentPath = path.dirname(target);
  const hasParent = roots.some((allowed) => {
    const relative = path.relative(allowed, parentPath);
    return relative === "" || (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  });
  return {
    path: target,
    name: path.basename(target) || target,
    ...(hasParent && parentPath !== target ? { parentPath } : {}),
    entries,
  };
}
