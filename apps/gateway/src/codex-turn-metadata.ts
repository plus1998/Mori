import type { GatewayCodexRequestKind, GatewayCodexTurnMetadata, ResolvedProviderRoute } from "./types.js";

export const CODEX_TURN_METADATA_HEADER = "x-codex-turn-metadata";

/**
 * Parse the direct HTTP compatibility header emitted by Codex 0.142.5.
 * Missing or malformed turn identity stays unavailable; callers must not infer it.
 */
export function parseCodexTurnMetadataHeader(
  headers: Pick<Headers, "get">,
): GatewayCodexTurnMetadata | undefined {
  const raw = headers.get(CODEX_TURN_METADATA_HEADER)?.trim();
  if (!raw) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) {
    return undefined;
  }

  const threadId = readRequiredString(parsed, "thread_id");
  const turnId = readRequiredString(parsed, "turn_id");
  const requestKind = readRequiredString(parsed, "request_kind");
  if (!threadId || !turnId || !isGatewayCodexRequestKind(requestKind)) {
    return undefined;
  }

  const parentThreadId = readOptionalString(parsed, "parent_thread_id");
  const subagentKind = readOptionalString(parsed, "subagent_kind");
  if (!parentThreadId.valid || !subagentKind.valid) {
    return undefined;
  }
  return {
    threadId,
    turnId,
    ...(parentThreadId.value && { parentThreadId: parentThreadId.value }),
    ...(subagentKind.value && { subagentKind: subagentKind.value }),
    requestKind,
  };
}

function readRequiredString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readOptionalString(
  record: Record<string, unknown>,
  key: string,
): { valid: true; value?: string } | { valid: false } {
  if (!Object.hasOwn(record, key)) {
    return { valid: true };
  }
  const value = record[key];
  if (typeof value !== "string" || !value.trim()) {
    return { valid: false };
  }
  return { valid: true, value: value.trim() };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isGatewayCodexRequestKind(value: string | undefined): value is GatewayCodexRequestKind {
  return value === "turn" || value === "prewarm" || value === "compaction";
}

/** Bind Codex turn_id onto gateway route identity for lifecycle + usage join. */
export function enrichResolvedRouteWithCodexTurnIdentity(
  route: ResolvedProviderRoute,
  codexTurnMetadata?: GatewayCodexTurnMetadata,
): ResolvedProviderRoute {
  const turnId = codexTurnMetadata?.turnId?.trim();
  const threadId = codexTurnMetadata?.threadId?.trim();
  if (!turnId && !threadId) {
    return route;
  }
  return {
    ...route,
    ...(route.logicalRequestId?.trim() ? {} : turnId ? { logicalRequestId: turnId } : {}),
    ...(turnId ? { turnId } : {}),
    ...(threadId && !route.threadId?.trim() ? { threadId } : {}),
  };
}
