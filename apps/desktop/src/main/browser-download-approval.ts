import { randomUUID } from "node:crypto";
import type { BrowserDownload } from "../shared/browser-downloads";
import type { BashApprovalRequest } from "../shared/ipc";
import type { BashApprovalResolution } from "./bash-approval-bridge";
import type { EcoApprovalReviewResult } from "./eco-approval-reviewer";

export interface BrowserDownloadAccessInput {
  threadId: string;
  file: BrowserDownload & { path: string };
  signal?: AbortSignal;
}

export interface BrowserDownloadApprovalDeps {
  context: (threadId: string) => { agentId: string; cwd: string; mode: "always" | "auto" | "allow_all" };
  review: (request: BashApprovalRequest, toolInput: Record<string, unknown>) => Promise<EcoApprovalReviewResult>;
  requestHuman: (request: BashApprovalRequest) => Promise<BashApprovalResolution>;
  cancel: (toolUseId: string) => void;
  emit: (request: BashApprovalRequest, decision: "requested" | "approved" | "rejected") => void;
}

/** Gate file access in the host even when an SDK auto-allows the browser MCP wildcard. */
export async function authorizeBrowserDownloadAccess(input: BrowserDownloadAccessInput, deps: BrowserDownloadApprovalDeps): Promise<void> {
  input.signal?.throwIfAborted();
  const { agentId, cwd, mode } = deps.context(input.threadId);
  const file = input.file;
  let request: BashApprovalRequest = {
    threadId: input.threadId,
    agentId,
    cwd,
    toolUseId: `browser-file-${randomUUID()}`,
    command: `Browser download: ${file.name}`,
    description: `获取下载文件 ${file.name}`,
    reason: `Agent 请求访问浏览器暂存的下载文件：${file.name}（${file.receivedBytes} 字节），来源：${file.url}`,
    riskLevel: "medium",
    riskScore: 45,
    kind: "network",
    filesystemTool: "BrowserDownload",
    filesystemPath: file.path,
    suppressAlwaysAllowRule: true,
  };
  if (mode === "allow_all") {
    deps.emit(request, "approved");
    return;
  }
  if (mode === "auto") {
    const review = await deps.review(request, {
      browserId: file.browserId, fileId: file.id,
      name: file.name, url: file.url, mimeType: file.mimeType,
      bytes: file.receivedBytes, path: file.path,
    });
    input.signal?.throwIfAborted();
    request = { ...request, reviewRationale: review.rationale };
    if (review.action === "allow") {
      deps.emit(request, "approved");
      return;
    }
    // Match Eco's existing model-review policy: withheld approval goes to the user.
  }
  input.signal?.throwIfAborted();
  const pending = deps.requestHuman(request);
  const cancel = () => deps.cancel(request.toolUseId);
  input.signal?.addEventListener("abort", cancel, { once: true });
  deps.emit(request, "requested");
  try {
    const resolution = await pending;
    if (input.signal?.aborted) deps.emit(request, "rejected");
    input.signal?.throwIfAborted();
    if (resolution.decision !== "approved") {
      deps.emit(request, "rejected");
      throw new Error(resolution.feedback?.trim() || "Browser download file access was rejected.");
    }
    deps.emit(request, "approved");
  } finally {
    input.signal?.removeEventListener("abort", cancel);
  }
}
