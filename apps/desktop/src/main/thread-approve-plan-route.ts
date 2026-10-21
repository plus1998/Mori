/**
 * Claude ExitPlanMode and Cursor ACP cursor/create_plan both park on the
 * Eco plan-approval bridge while the ACP child is alive (Cursor blocking contract).
 *
 * Codex/Pi use async pending-plan + continuation as their primary path.
 * ACP uses continuation only as an explicit disconnect fallback when the
 * parked create_plan RPC is already dead.
 */
export type ThreadApprovePlanRoute =
  | { kind: "codex" }
  | { kind: "pi" }
  | { kind: "bridge" }
  | { kind: "acp_continuation" }
  | { kind: "claude_execution" };

export function resolveThreadApprovePlanRoute(input: {
  coreKind?: string | null;
  hasPendingBridge: boolean;
}): ThreadApprovePlanRoute {
  const core = input.coreKind?.trim() || "";
  if (core === "codex") {
    return { kind: "codex" };
  }
  if (core === "pi") {
    return { kind: "pi" };
  }
  if (input.hasPendingBridge) {
    if (core === "claude" || core === "acp" || core === "cursor") {
      return { kind: "bridge" };
    }
    throw new Error(
      `CORE_ROUTE_MISMATCH: plan approval bridge is not supported for Harness "${core || "unknown"}".`,
    );
  }
  if (core === "acp" || core === "cursor") {
    return { kind: "acp_continuation" };
  }
  return { kind: "claude_execution" };
}
