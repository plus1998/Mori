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
