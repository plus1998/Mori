export interface VisionModelSelection {
  providerId: string;
  modelId: string;
  candidateModelId: string;
  /** Explicit account binding for ChatGPT OAuth; absent for API-key providers. */
  accountId?: string;
}

export function isVisionModelSelection(value: unknown): value is VisionModelSelection {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    (record.accountId === undefined ||
      (typeof record.accountId === "string" && Boolean(record.accountId.trim()))) &&
    typeof record.providerId === "string" &&
    Boolean(record.providerId.trim()) &&
    typeof record.modelId === "string" &&
    Boolean(record.modelId.trim()) &&
    typeof record.candidateModelId === "string" &&
    Boolean(record.candidateModelId.trim())
  );
}

export function normalizeVisionModelSelection(value: unknown): VisionModelSelection | undefined {
  if (!isVisionModelSelection(value)) {
    return undefined;
  }
  return {
    providerId: value.providerId.trim(),
    modelId: value.modelId.trim(),
    candidateModelId: value.candidateModelId.trim(),
    ...(value.accountId?.trim() ? { accountId: value.accountId.trim() } : {}),
  };
}
