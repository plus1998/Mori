import type { CodexAppServerClient } from "./codex-app-server-client.js";

export const CODEX_MODEL_LIST_METHOD = "model/list";
export const DEFAULT_CODEX_MODEL_LIST_PAGE_SIZE = 100;

export interface CodexModelCatalogEntry {
  id: string;
  model: string;
  displayName: string;
  defaultReasoningEffort: string;
  supportedReasoningEfforts: string[];
  supportsUltrafast?: true;
}

export interface CodexModelListOptions {
  includeHidden?: boolean;
  pageSize?: number;
  modelProvider?: string;
}

interface CodexModelListPage {
  data: CodexModelCatalogEntry[];
  nextCursor: string | null;
}

export async function listCodexModelCatalog(
  client: Pick<CodexAppServerClient, "request">,
  options: CodexModelListOptions = {},
): Promise<CodexModelCatalogEntry[]> {
  const pageSize = options.pageSize ?? DEFAULT_CODEX_MODEL_LIST_PAGE_SIZE;
  if (!Number.isInteger(pageSize) || pageSize <= 0) {
    throw new Error(`Codex model/list pageSize must be a positive integer, received ${pageSize}.`);
  }

  const modelProvider = options.modelProvider?.trim();
  if (options.modelProvider !== undefined && !modelProvider) {
    throw new Error("Codex model/list modelProvider must not be blank.");
  }

  const entries: CodexModelCatalogEntry[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;

  for (;;) {
    const response = await client.request<unknown>(CODEX_MODEL_LIST_METHOD, {
      limit: pageSize,
      includeHidden: options.includeHidden ?? false,
      ...(cursor ? { cursor } : {}),
      ...(modelProvider !== undefined ? { modelProvider } : {}),
    });
    const page = parseCodexModelListPage(response);
    entries.push(...page.data);

    if (page.nextCursor === null) {
      return entries;
    }
    if (seenCursors.has(page.nextCursor)) {
      throw new Error(`Codex model/list returned a repeated nextCursor: ${page.nextCursor}.`);
    }
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
}

export function parseCodexModelListPage(value: unknown): CodexModelListPage {
  if (!isRecord(value)) {
    throw new Error("Codex model/list response must be an object.");
  }
  if (!Array.isArray(value.data)) {
    throw new Error("Codex model/list response.data must be an array.");
  }

  const nextCursor = value.nextCursor;
  if (nextCursor !== null && (typeof nextCursor !== "string" || !nextCursor.trim())) {
    throw new Error("Codex model/list response.nextCursor must be a non-empty string or null.");
  }

  return {
    data: value.data.map((entry, index) => parseCatalogEntry(entry, index)),
    nextCursor,
  };
}

function parseCatalogEntry(value: unknown, index: number): CodexModelCatalogEntry {
  if (!isRecord(value)) {
    throw new Error(`Codex model/list data[${index}] must be an object.`);
  }
  const id = readNonEmptyString(value, "id", `data[${index}]`);
  const model = readNonEmptyString(value, "model", `data[${index}]`);
  const displayName = readNonEmptyString(value, "displayName", `data[${index}]`);
  const defaultReasoningEffort = readNonEmptyString(value, "defaultReasoningEffort", `data[${index}]`);
  if (!Array.isArray(value.supportedReasoningEfforts)) {
    throw new Error(`Codex model/list data[${index}].supportedReasoningEfforts must be an array.`);
  }

  const supportedReasoningEfforts = value.supportedReasoningEfforts.map((option, optionIndex) => {
    if (!isRecord(option)) {
      throw new Error(
        `Codex model/list data[${index}].supportedReasoningEfforts[${optionIndex}] must be an object.`,
      );
    }
    if (typeof option.description !== "string") {
      throw new Error(
        `Codex model/list data[${index}].supportedReasoningEfforts[${optionIndex}].description must be a string.`,
      );
    }
    return readNonEmptyString(
      option,
      "reasoningEffort",
      `data[${index}].supportedReasoningEfforts[${optionIndex}]`,
    );
  });

  return {
    id,
    model,
    displayName,
    defaultReasoningEffort,
    supportedReasoningEfforts,
    ...(Array.isArray(value.serviceTiers) && value.serviceTiers.some(
      (tier) => isRecord(tier) && tier.id === "ultrafast",
    ) ? { supportsUltrafast: true as const } : {}),
  };
}

function readNonEmptyString(value: Record<string, unknown>, key: string, location: string): string {
  const field = value[key];
  if (typeof field !== "string" || !field.trim()) {
    throw new Error(`Codex model/list ${location}.${key} must be a non-empty string.`);
  }
  return field;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
