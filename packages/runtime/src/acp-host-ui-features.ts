import type { AcpAgentId } from "./core-runtime.js";

export const ACP_HOST_UI_FEATURES = ["contextUsage", "billing"] as const;
export type AcpHostUiFeature = (typeof ACP_HOST_UI_FEATURES)[number];
export type AcpHostUiVisibility = "show" | "hide";
export type AcpHostUiFeatures = Record<AcpHostUiFeature, AcpHostUiVisibility>;

export const DEFAULT_ACP_HOST_UI_FEATURES: AcpHostUiFeatures = {
  contextUsage: "show",
  billing: "show",
};

export const ACP_HOST_UI_FEATURE_TABLE: Record<AcpAgentId, AcpHostUiFeatures> = {
  antigravity: { contextUsage: "hide", billing: "hide" },
  cursor: { contextUsage: "hide", billing: "hide" },
};

export function resolveAcpHostUiFeatures(input: {
  coreKind?: string;
  acpAgentId?: string;
}): AcpHostUiFeatures {
  if (input.coreKind !== "acp") {
    return { ...DEFAULT_ACP_HOST_UI_FEATURES };
  }
  const id = input.acpAgentId?.trim() ?? "";
  if (id && Object.hasOwn(ACP_HOST_UI_FEATURE_TABLE, id)) {
    return { ...ACP_HOST_UI_FEATURE_TABLE[id as AcpAgentId] };
  }
  return { ...DEFAULT_ACP_HOST_UI_FEATURES };
}

export function normalizeAcpHostUiFeatures(raw: unknown): AcpHostUiFeatures {
  const record =
    raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return {
    contextUsage: record.contextUsage === "hide" ? "hide" : "show",
    billing: record.billing === "hide" ? "hide" : "show",
  };
}

export function isAcpHostUiFeatureVisible(
  features: AcpHostUiFeatures | undefined,
  feature: AcpHostUiFeature,
): boolean {
  return normalizeAcpHostUiFeatures(features)[feature] === "show";
}
