import { ECO_MCP_HUB_TOOL_NAMES, ecoMcpHubNamespace } from "@eco/shared";

const HUB_TOOL_NAMES = new Set<string>(ECO_MCP_HUB_TOOL_NAMES);

/**
 * Local models (e.g. qwen3.8 via a native Responses upstream) intermittently
 * emit Hub function calls without the per-thread `namespace` field. Codex's
 * tool registry then rejects the call inside its own binary (`unsupported
 * call: <name>`), before the request can reach the Hub, so neither the Hub
 * nor the provider can recover. The gateway sits on the model→Codex path, so
 * it repairs the namespace on the way back from the upstream model.
 */

/** Resolve the per-thread Hub namespace for a Codex thread id, or undefined when unavailable. */
export function resolveEcoMcpHubNamespace(
  resolveEcoThreadId: ((codexThreadId: string) => string | undefined) | undefined,
  codexThreadId: string | undefined,
): string | undefined {
  if (!resolveEcoThreadId) {
    return undefined;
  }
  const trimmed = codexThreadId?.trim();
  if (!trimmed) {
    return undefined;
  }
  let ecoThreadId: string | undefined;
  try {
    ecoThreadId = resolveEcoThreadId(trimmed);
  } catch {
    return undefined;
  }
  const normalized = ecoThreadId?.trim();
  return normalized ? ecoMcpHubNamespace(normalized) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Force the Hub namespace on one function_call item; returns a new item when changed. */
function fixupFunctionCallItem(item: Record<string, unknown>, namespace: string): Record<string, unknown> {
  if (item.type !== "function_call") {
    return item;
  }
  const name = typeof item.name === "string" ? item.name.trim() : "";
  // A non-empty namespace may belong to another MCP server exposing the same
  // short tool name. Only repair the failure mode this adapter owns: a Hub
  // call whose namespace was omitted entirely.
  if (!HUB_TOOL_NAMES.has(name) || typeof item.namespace === "string" && item.namespace.trim() !== "") {
    return item;
  }
  return { ...item, namespace };
}

function fixupOutputArray(output: unknown[], namespace: string): unknown[] {
  return output.map((item) => (isRecord(item) ? fixupFunctionCallItem(item, namespace) : item));
}

/**
 * Repair Hub function calls inside one Responses stream event. Returns the
 * same reference when nothing changed so callers can skip re-serialization.
 */
export function fixupEcoMcpHubStreamEvent(event: unknown, namespace: string): unknown {
  if (!isRecord(event)) {
    return event;
  }
  let changed = false;
  const output = { ...event };
  if (isRecord(event.item)) {
    const fixedItem = fixupFunctionCallItem(event.item as Record<string, unknown>, namespace);
    if (fixedItem !== event.item) {
      output.item = fixedItem;
      changed = true;
    }
  }
  if (isRecord(event.response)) {
    const response = event.response as Record<string, unknown>;
    const responseOutput = response.output;
    if (Array.isArray(responseOutput)) {
      const fixedOutput = fixupOutputArray(responseOutput, namespace);
      if (fixedOutput.some((item, index) => item !== responseOutput[index])) {
        output.response = { ...response, output: fixedOutput };
        changed = true;
      }
    }
  }
  // Some providers place name/namespace at the event top level; repair there too.
  if (
    typeof event.name === "string" &&
    HUB_TOOL_NAMES.has(event.name.trim()) &&
    (event.namespace === undefined || (typeof event.namespace === "string" && event.namespace.trim() === ""))
  ) {
    output.namespace = namespace;
    changed = true;
  }
  return changed ? output : event;
}

/** Repair Hub function calls inside a non-stream Responses payload (root `output` and/or `response` object). */
export function fixupEcoMcpHubResponsesPayload(payload: unknown, namespace: string): unknown {
  if (!isRecord(payload)) {
    return payload;
  }
  let changed = false;
  const output = { ...payload };
  const fixResponseRecord = (record: Record<string, unknown>): Record<string, unknown> => {
    const recordOutput = record.output;
    if (Array.isArray(recordOutput)) {
      const fixed = fixupOutputArray(recordOutput, namespace);
      if (fixed.some((item, index) => item !== recordOutput[index])) {
        return { ...record, output: fixed };
      }
    }
    return record;
  };
  if (isRecord(payload.response)) {
    const fixed = fixResponseRecord(payload.response as Record<string, unknown>);
    if (fixed !== payload.response) {
      output.response = fixed;
      changed = true;
    }
  }
  const payloadOutput = payload.output;
  if (Array.isArray(payloadOutput)) {
    const fixed = fixupOutputArray(payloadOutput, namespace);
    if (fixed.some((item, index) => item !== payloadOutput[index])) {
      output.output = fixed;
      changed = true;
    }
  }
  return changed ? output : payload;
}
