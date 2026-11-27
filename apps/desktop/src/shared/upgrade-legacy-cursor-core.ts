import type { AcpAgentId, CoreKind } from "@eco/runtime/core-runtime";
import { isCoreKind } from "@eco/runtime/core-runtime";

/**
 * Silent upgrade on read: legacy first-class `coreKind: "cursor"` → ACP + cursor agent.
 */
export function upgradeLegacyCursorCore(input: {
  coreKind?: string | null | undefined;
  acpAgentId?: string | null | undefined;
}): { coreKind?: CoreKind; acpAgentId?: AcpAgentId } {
  if (input.coreKind === "cursor") {
    return { coreKind: "acp", acpAgentId: "cursor" };
  }
  if (!isCoreKind(input.coreKind)) {
    return {};
  }
  if (input.coreKind === "acp") {
    return { coreKind: "acp", acpAgentId: input.acpAgentId === "antigravity" ? "antigravity" : "cursor" };
  }
  return { coreKind: input.coreKind };
}

/**
 * Whether a persisted `thread_core_sessions.core_kind` may be overwritten by `requested`.
 * Allows silent legacy `cursor` → `acp` upgrade; other mismatches are incompatible.
 */
export function isCompatibleCoreSessionKindWrite(existing: string, requested: string): boolean {
  if (existing === requested) {
    return true;
  }
  return upgradeLegacyCursorCore({ coreKind: existing }).coreKind === requested;
}
