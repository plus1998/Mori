import { fileAttachmentToken, isAbsoluteLocalFilePath } from "./workspace-file-reference";

export const WORKSPACE_FILE_DRAG_MIME = "application/x-mori-workspace-file";

export function startWorkspaceFileDrag(transfer: DataTransfer, path: string): void {
  transfer.setData(WORKSPACE_FILE_DRAG_MIME, path);
  transfer.setData("text/plain", fileAttachmentToken(path));
  transfer.effectAllowed = "copy";
}

export function readWorkspaceFileDrag(transfer: DataTransfer): string | undefined {
  const path = transfer.getData(WORKSPACE_FILE_DRAG_MIME);
  return path && isAbsoluteLocalFilePath(path) ? path : undefined;
}
