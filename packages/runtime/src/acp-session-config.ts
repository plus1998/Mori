import type { AcpSessionModeId } from "./acp-types.js";

export type AcpAvailableModel = {
  modelId: string;
  name?: string;
};

/** Legacy selections can match a bare ID or name. An explicit wire ID must match exactly. */
export function findAcpWireModelId(requested: string, available: readonly AcpAvailableModel[]): string | undefined {
  const id = requested.trim();
  if (!id) return undefined;
  if (available.some(model => model.modelId === id)) return id;
  if (id.includes("[")) return undefined;
  if (id === "auto") {
    const auto = available.find(model => model.modelId === "default[]" || model.name?.toLowerCase() === "auto");
    if (auto) return auto.modelId;
  }
  return available.find(model => model.modelId.startsWith(`${id}[`) || model.name === id)?.modelId;
}

/** Map saved model selections to the ACP wire catalog returned by session/new or session/load. */
export function resolveAcpWireModelId(
  requested: string,
  available: readonly AcpAvailableModel[] = [],
): string {
  const trimmed = requested.trim();
  if (!trimmed) return trimmed;
  if (available.length === 0) {
    throw new Error(
      `ACP availableModels missing; cannot resolve model id "${trimmed}" to a wire id (CLI short names like "auto" are not valid for session/set_model)`,
    );
  }
  const wireId = findAcpWireModelId(trimmed, available);
  if (wireId) return wireId;
  const sample = available
    .slice(0, 5)
    .map((m) => m.modelId)
    .join(", ");
  throw new Error(
    `ACP model id "${trimmed}" is not in availableModels (e.g. ${sample}${available.length > 5 ? ", …" : ""}). Use an ACP wire id such as default[].`,
  );
}

export function isAcpSessionModeId(value: unknown): value is AcpSessionModeId {
  return value === "agent" || value === "plan" || value === "ask";
}

/** Parse `models.availableModels` from session/new or session/load results. */
export function parseAcpAvailableModels(sessionResult: unknown): AcpAvailableModel[] {
  if (!sessionResult || typeof sessionResult !== "object") return [];
  const models = (sessionResult as { models?: unknown }).models;
  if (!models || typeof models !== "object") return [];
  const available = (models as { availableModels?: unknown }).availableModels;
  if (!Array.isArray(available)) return [];
  const out: AcpAvailableModel[] = [];
  for (const entry of available) {
    if (!entry || typeof entry !== "object") continue;
    const modelId = (entry as { modelId?: unknown }).modelId;
    if (typeof modelId !== "string" || !modelId.trim()) continue;
    const name = (entry as { name?: unknown }).name;
    out.push({
      modelId: modelId.trim(),
      ...(typeof name === "string" && name.trim() ? { name: name.trim() } : {}),
    });
  }
  return out;
}
