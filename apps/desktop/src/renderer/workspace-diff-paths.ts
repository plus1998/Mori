import type { WorkspaceDiffResult } from "../shared/ipc";

type WorkspaceDiffFile = WorkspaceDiffResult["files"][number];

export type WorkspaceDiffSelection = {
  kind: "file" | "directory";
  path: string;
};

export function summarizeWorkspaceDiffFolder(files: readonly WorkspaceDiffFile[], folderPath: string) {
  const prefix = `${folderPath}/`;
  let fileCount = 0;
  let additions = 0;
  let deletions = 0;
  // Git paths always use `/` for directories. A literal backslash can be part of a filename.
  for (const file of files) {
    if (!file.path.startsWith(prefix)) continue;
    fileCount++;
    additions += file.additions;
    deletions += file.deletions;
  }
  return { fileCount, additions, deletions };
}

export function resolveWorkspaceDiffSelection(
  files: readonly WorkspaceDiffFile[],
  selection?: WorkspaceDiffSelection,
): WorkspaceDiffSelection | undefined {
  if (selection) {
    const { kind, path } = selection;
    const prefix = `${path}/`;
    const exists = files.some((file) =>
      kind === "file" ? file.path === path : file.path.startsWith(prefix),
    );
    if (exists) return selection;
  }
  const firstFile = files[0];
  return firstFile ? { kind: "file", path: firstFile.path } : undefined;
}
