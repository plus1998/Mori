export type BrowserDownloadState = "pending" | "completed" | "failed" | "cancelled";

/** Public metadata. A local file path is only returned by the reviewed file-access tool. */
export interface BrowserDownload {
  id: string;
  browserId: string;
  name: string;
  mimeType: string;
  url: string;
  receivedBytes: number;
  totalBytes: number;
  state: BrowserDownloadState;
  createdAt: number;
  error?: string;
}

export interface BrowserDownloadActionRequest {
  browserId: string;
  fileId: string;
  action: "reveal" | "save" | "cancel" | "remove";
}
