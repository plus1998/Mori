import {
  type IntegratedWebSearchProvider,
  type IntegratedWebSearchResult,
} from "./pi-integrated-web-search.js";

export const ECO_WEB_SEARCH_MCP_SERVER = "eco_web_search";
export const ECO_WEB_SEARCH_TOOL = "search";
export const ECO_WEB_SEARCH_FULL_TOOL = `mcp__${ECO_WEB_SEARCH_MCP_SERVER}__${ECO_WEB_SEARCH_TOOL}`;

export interface EcoWebSearchToolResultHit {
  title: string;
  url: string;
  description: string;
}

export interface EcoWebSearchToolResult {
  provider?: IntegratedWebSearchProvider | string;
  query?: string;
  results: EcoWebSearchToolResultHit[];
  /** Raw text payload when available (formatted SERP or JSON). */
  text?: string;
}

export function isEcoWebSearchToolName(name: string | undefined): boolean {
  const normalized = name?.trim().toLowerCase() ?? "";
  if (!normalized) {
    return false;
  }
  return normalized.includes(ECO_WEB_SEARCH_MCP_SERVER);
}

export function readEcoWebSearchQuery(input: unknown): string | undefined {
  if (!isRecord(input)) {
    return undefined;
  }
  const query = input.query;
  return typeof query === "string" && query.trim() ? query.trim() : undefined;
}

/**
 * Parse Eco Integrated web-search MCP output (Codex aggregatedOutput / Claude tool_result).
 * Accepts formatted text (`Doubao Search results for "…":`) or JSON structuredContent.
 */
export function parseEcoWebSearchToolOutput(raw: unknown): EcoWebSearchToolResult | undefined {
  if (isRecord(raw)) {
    // Prefer structuredContent when Codex/MCP return both text + structured payload.
    const structured =
      (isRecord(raw.structuredContent) && raw.structuredContent) ||
      (isRecord(raw.result) &&
        isRecord(raw.result.Ok) &&
        isRecord(raw.result.Ok.structuredContent) &&
        raw.result.Ok.structuredContent) ||
      (isRecord(raw.result) &&
        isRecord(raw.result.structuredContent) &&
        raw.result.structuredContent) ||
      undefined;
    if (structured) {
      const provider =
        typeof structured.provider === "string" && structured.provider.trim()
          ? structured.provider.trim()
          : undefined;
      const query =
        typeof structured.query === "string" && structured.query.trim()
          ? structured.query.trim()
          : undefined;
      const results = readResultHits(structured.results);
      if (provider || query || results.length > 0) {
        const text = readToolOutputText(raw);
        return {
          ...(provider ? { provider } : {}),
          ...(query ? { query } : {}),
          results,
          ...(text ? { text } : {}),
        };
      }
    }
  }

  const text = readToolOutputText(raw);
  if (!text) {
    return undefined;
  }

  const fromJson = parseJsonEcoWebSearch(text);
  if (fromJson && (fromJson.results.length > 0 || fromJson.query || fromJson.provider)) {
    return { ...fromJson, text };
  }

  const fromText = parseFormattedEcoWebSearch(text);
  if (fromText) {
    return { ...fromText, text };
  }

  return { results: [], text };
}

function parseJsonEcoWebSearch(text: string): EcoWebSearchToolResult | undefined {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!isRecord(parsed)) {
      return undefined;
    }
    // Claude may wrap structuredContent; also accept gateway-shaped payloads.
    const root =
      isRecord(parsed.structuredContent)
        ? parsed.structuredContent
        : isRecord(parsed.result) && isRecord(parsed.result.structuredContent)
          ? parsed.result.structuredContent
          : parsed;
    const provider =
      typeof root.provider === "string" && root.provider.trim() ? root.provider.trim() : undefined;
    const query = typeof root.query === "string" && root.query.trim() ? root.query.trim() : undefined;
    const results = readResultHits(root.results);
    if (!provider && !query && results.length === 0) {
      return undefined;
    }
    return {
      ...(provider ? { provider } : {}),
      ...(query ? { query } : {}),
      results,
    };
  } catch {
    return undefined;
  }
}

function parseFormattedEcoWebSearch(text: string): EcoWebSearchToolResult | undefined {
  const firstLine = text.split(/\r?\n/u, 1)[0] ?? "";
  const header = firstLine.match(/^(Brave|Tavily|Doubao|DeepSeek)\s+Search results for\s+"([\s\S]*?)":\s*$/iu);
  if (!header?.[1] || header[2] === undefined) {
    return undefined;
  }
  return parseFormattedBody(text, header[1], header[2]);
}

function parseFormattedBody(
  text: string,
  providerLabel: string,
  query: string,
): EcoWebSearchToolResult {
  const provider = providerLabel.toLowerCase() as IntegratedWebSearchProvider;
  const results: EcoWebSearchToolResultHit[] = [];
  const blockRe =
    /^\s*\d+\.\s+(.+?)\s*\n\s*(https?:\/\/\S+)\s*(?:\n\s*([\s\S]*?))?(?=\n\s*\d+\.\s+|\s*$)/gmu;
  for (const match of text.matchAll(blockRe)) {
    const title = (match[1] ?? "").trim();
    const url = (match[2] ?? "").trim();
    const description = (match[3] ?? "").trim();
    if (title || url || description) {
      results.push({ title, url, description });
    }
  }
  return {
    provider,
    query: query.trim(),
    results,
  };
}

function readResultHits(value: unknown): EcoWebSearchToolResultHit[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const hits: EcoWebSearchToolResultHit[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const title = typeof entry.title === "string" ? entry.title.trim() : "";
    const url = typeof entry.url === "string" ? entry.url.trim() : "";
    const description =
      typeof entry.description === "string"
        ? entry.description.trim()
        : typeof entry.content === "string"
          ? entry.content.trim()
          : "";
    if (title || url || description) {
      hits.push({ title, url, description });
    }
  }
  return hits.slice(0, 12);
}

function readToolOutputText(raw: unknown): string | undefined {
  if (typeof raw === "string" && raw.trim()) {
    return raw.trim();
  }
  if (Array.isArray(raw)) {
    const joined = raw
      .map((entry) => {
        if (typeof entry === "string") return entry;
        if (isRecord(entry) && typeof entry.text === "string") return entry.text;
        return "";
      })
      .filter(Boolean)
      .join("\n")
      .trim();
    return joined || undefined;
  }
  if (!isRecord(raw)) {
    return undefined;
  }
  for (const key of [
    "aggregatedOutput",
    "result",
    "output",
    "response",
    "content",
    "text",
  ] as const) {
    const nested = readToolOutputText(raw[key]);
    if (nested) {
      return nested;
    }
  }
  // Codex Ok wrapper: result.Ok.content
  if (isRecord(raw.Ok)) {
    const nested = readToolOutputText(raw.Ok);
    if (nested) {
      return nested;
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Map parsed hits into runtime IntegratedWebSearchResult shape when needed. */
export function toIntegratedWebSearchResults(
  hits: readonly EcoWebSearchToolResultHit[],
): IntegratedWebSearchResult[] {
  return hits.map((hit) => ({
    title: hit.title,
    url: hit.url,
    description: hit.description,
  }));
}
