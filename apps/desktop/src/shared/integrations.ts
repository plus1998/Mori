export const INTEGRATION_IDS = ["browser", "imageGeneration", "computerUse", "tts"] as const;

export type IntegrationId = (typeof INTEGRATION_IDS)[number];

export type IntegrationsEnabledSettings = Partial<Record<IntegrationId, boolean>>;

export interface IntegrationAvailabilityItem {
  id: IntegrationId;
  enabled: boolean;
  available: boolean;
  reason?: string;
  activeProfileName?: string;
}

export interface IntegrationAvailabilitySnapshot {
  integrations: IntegrationAvailabilityItem[];
}

export interface ProjectIntegrationsSettingsSnapshot {
  workspacePath: string;
  enabled: IntegrationsEnabledSettings;
}

export function normalizeIntegrationsEnabled(value: unknown): IntegrationsEnabledSettings | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const normalized: IntegrationsEnabledSettings = {};
  for (const id of INTEGRATION_IDS) {
    if (typeof record[id] === "boolean") normalized[id] = record[id];
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

export function integrationEnabled(
  settings: IntegrationsEnabledSettings | undefined,
  id: IntegrationId,
): boolean {
  return settings?.[id] === true;
}
