import type { AcpAgentId } from "@eco/runtime/core-runtime";

/**
 * Resolve the persisted ACP agent. Missing IDs belong to legacy Cursor threads.
 */
export function resolveAcpThreadAgentId(thread: { acpAgentId?: string | undefined }): AcpAgentId {
  const raw = typeof thread.acpAgentId === "string" ? thread.acpAgentId.trim() : "";
  if (!raw || raw === "cursor") {
    return "cursor";
  }
  if (raw === "antigravity") return raw;
  throw new Error(`Unsupported acpAgentId: ${raw}`);
}
