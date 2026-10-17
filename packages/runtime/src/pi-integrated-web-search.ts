export type IntegratedWebSearchProvider = "brave" | "tavily" | "doubao" | "deepseek";

export interface IntegratedWebSearchResult {
  title: string;
  url: string;
  description: string;
}

/** @deprecated Use IntegratedWebSearchResult */
export type BraveWebSearchResult = IntegratedWebSearchResult;

export interface BraveWebSearchResponse {
  web?: {
    results?: Array<{
      title?: string;
      url?: string;
      description?: string;
    }>;
  };
}

export interface TavilySearchResponse {
  results?: Array<{
    title?: string;
    url?: string;
    content?: string;
  }>;
}

export interface DoubaoGlobalSearchResponse {
  ResponseMetadata?: {
    Error?: {
      CodeN?: number;
      Code?: string;
      Message?: string;
    };
  };
  Result?: {
    TotalDocCount?: number;
    Documents?: Array<{
      Title?: string;
      Url?: string;
      Snippet?: Array<{
        Type?: string;
        Text?: string;
      }>;
    }>;
    ErrorCode?: number;
    ErrorMsg?: string;
  };
}

const BRAVE_WEB_SEARCH_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
const TAVILY_SEARCH_ENDPOINT = "https://api.tavily.com/search";
const DOUBAO_GLOBAL_SEARCH_ENDPOINT = "https://open.feedcoopapi.com/search_api/global_search";
const DEEPSEEK_SEARCH_ENDPOINT = "https://api.deepseek.com/v1/tools/search";
const DEFAULT_RESULT_COUNT = 5;
const DOUBAO_DEFAULT_SNIPPET_LENGTH = 1000;

export function integratedWebSearchProviderLabel(provider: IntegratedWebSearchProvider): string {
  if (provider === "tavily") {
    return "Tavily";
  }
  if (provider === "doubao") {
    return "Doubao";
  }
  if (provider === "deepseek") {
    return "DeepSeek";
  }
  return "Brave";
}

function extractDoubaoGlobalSnippet(snippets: Array<{ Type?: string; Text?: string }> | undefined): string {
  if (!Array.isArray(snippets)) {
    return "";
  }
  return snippets
    .filter((entry) => entry.Type === "text" && typeof entry.Text === "string")
    .map((entry) => entry.Text!.trim())
    .filter(Boolean)
    .join("\n");
}

function throwDoubaoApiError(payload: DoubaoGlobalSearchResponse): void {
  const metaError = payload.ResponseMetadata?.Error;
  if (metaError?.Message) {
    const code = metaError.CodeN ?? metaError.Code;
    const suffix = code !== undefined ? ` (${code})` : "";
    throw new Error(`Doubao Search request failed${suffix}: ${metaError.Message}`);
  }
  const result = payload.Result;
  if (result && typeof result.ErrorCode === "number" && result.ErrorCode !== 0) {
    const message = typeof result.ErrorMsg === "string" ? result.ErrorMsg.trim() : "Unknown error";
    throw new Error(`Doubao Search request failed (${result.ErrorCode}): ${message}`);
  }
}

export async function searchBraveWeb(
  query: string,
  apiKey: string,
  options?: { count?: number; signal?: AbortSignal },
): Promise<IntegratedWebSearchResult[]> {
  const trimmedQuery = query.trim();
  if (!trimmedQuery) {
    throw new Error("web_search requires a non-empty query.");
  }
  const key = apiKey.trim();
  if (!key) {
    throw new Error("Brave Search API key is not configured.");
  }

  const url = new URL(BRAVE_WEB_SEARCH_ENDPOINT);
  url.searchParams.set("q", trimmedQuery);
  url.searchParams.set("count", String(options?.count ?? DEFAULT_RESULT_COUNT));

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/json",
      "X-Subscription-Token": key,
    },
    ...(options?.signal ? { signal: options.signal } : {}),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    const detail = body.trim() ? `: ${body.trim().slice(0, 240)}` : "";
    throw new Error(`Brave Search request failed (${response.status})${detail}`);
  }

  const payload = (await response.json()) as BraveWebSearchResponse;
  const raw = payload.web?.results ?? [];
  return raw
    .map((entry) => ({
      title: typeof entry.title === "string" ? entry.title.trim() : "",
      url: typeof entry.url === "string" ? entry.url.trim() : "",
      description: typeof entry.description === "string" ? entry.description.trim() : "",
    }))
    .filter((entry) => entry.title || entry.url || entry.description);
}

export async function searchTavilyWeb(
  query: string,
  apiKey: string,
  options?: { count?: number; signal?: AbortSignal },
): Promise<IntegratedWebSearchResult[]> {
  const trimmedQuery = query.trim();
  if (!trimmedQuery) {
    throw new Error("web_search requires a non-empty query.");
  }
  const key = apiKey.trim();
  if (!key) {
    throw new Error("Tavily API key is not configured.");
  }

  const response = await fetch(TAVILY_SEARCH_ENDPOINT, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      query: trimmedQuery,
      max_results: options?.count ?? DEFAULT_RESULT_COUNT,
      search_depth: "basic",
    }),
    ...(options?.signal ? { signal: options.signal } : {}),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    const detail = body.trim() ? `: ${body.trim().slice(0, 240)}` : "";
    throw new Error(`Tavily Search request failed (${response.status})${detail}`);
  }

  const payload = (await response.json()) as TavilySearchResponse;
  const raw = payload.results ?? [];
  return raw
    .map((entry) => ({
      title: typeof entry.title === "string" ? entry.title.trim() : "",
      url: typeof entry.url === "string" ? entry.url.trim() : "",
      description: typeof entry.content === "string" ? entry.content.trim() : "",
    }))
    .filter((entry) => entry.title || entry.url || entry.description);
}

export async function searchDoubaoWeb(
  query: string,
  apiKey: string,
  options?: { count?: number; signal?: AbortSignal },
): Promise<IntegratedWebSearchResult[]> {
  const trimmedQuery = query.trim();
  if (!trimmedQuery) {
    throw new Error("web_search requires a non-empty query.");
  }
  const key = apiKey.trim();
  if (!key) {
    throw new Error("Doubao Search API key is not configured.");
  }

  const response = await fetch(DOUBAO_GLOBAL_SEARCH_ENDPOINT, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      Query: trimmedQuery,
      DocCount: Math.min(options?.count ?? DEFAULT_RESULT_COUNT, 20),
      MaxSnippetLength: DOUBAO_DEFAULT_SNIPPET_LENGTH,
      MaxImageCountPerDoc: 0,
    }),
    ...(options?.signal ? { signal: options.signal } : {}),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    const detail = body.trim() ? `: ${body.trim().slice(0, 240)}` : "";
    throw new Error(`Doubao Search request failed (${response.status})${detail}`);
  }

  const payload = (await response.json()) as DoubaoGlobalSearchResponse;
  throwDoubaoApiError(payload);

  const raw = payload.Result?.Documents ?? [];
  return raw
    .map((entry) => ({
      title: typeof entry.Title === "string" ? entry.Title.trim() : "",
      url: typeof entry.Url === "string" ? entry.Url.trim() : "",
      description: extractDoubaoGlobalSnippet(entry.Snippet),
    }))
    .filter((entry) => entry.title || entry.url || entry.description);
}

/** DeepSeek returns a model-oriented summary without fetching the full page. */
export async function searchDeepSeekWeb(
  query: string,
  apiKey: string,
  options?: { count?: number; signal?: AbortSignal },
): Promise<IntegratedWebSearchResult[]> {
  const trimmedQuery = query.trim();
  if (!trimmedQuery) {
    throw new Error("web_search requires a non-empty query.");
  }
  if (Array.from(trimmedQuery).length > 128) {
    throw new Error("DeepSeek Search query must contain at most 128 Unicode characters.");
  }
  const key = apiKey.trim();
  if (!key) {
    throw new Error("DeepSeek Search API key is not configured.");
  }
  const count = options?.count ?? DEFAULT_RESULT_COUNT;
  if (!Number.isInteger(count) || count < 1 || count > 50) {
    throw new Error("DeepSeek Search count must be an integer between 1 and 50.");
  }

  const response = await fetch(DEEPSEEK_SEARCH_ENDPOINT, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({ query: trimmedQuery, count, need_content: false }),
    ...(options?.signal ? { signal: options.signal } : {}),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    const detail = body.trim() ? `: ${body.trim().slice(0, 240)}` : "";
    throw new Error(`DeepSeek Search request failed (${response.status})${detail}`);
  }

  const payload = (await response.json()) as { results?: unknown } | null;
  if (!payload || !Array.isArray(payload.results)) {
    throw new Error("DeepSeek Search returned an invalid response: expected a results array.");
  }
  return payload.results.map((entry: unknown) => {
    if (
      !entry ||
      typeof entry !== "object" ||
      !("title" in entry) ||
      typeof entry.title !== "string" ||
      !("url" in entry) ||
      typeof entry.url !== "string" ||
      !("summary" in entry) ||
      typeof entry.summary !== "string"
    ) {
      throw new Error("DeepSeek Search returned an invalid result: expected title, url and summary strings.");
    }
    return {
      title: entry.title.trim(),
      url: entry.url.trim(),
      description: entry.summary.trim(),
    };
  });
}

export async function searchIntegratedWeb(
  provider: IntegratedWebSearchProvider,
  query: string,
  apiKey: string,
  options?: { count?: number; signal?: AbortSignal },
): Promise<IntegratedWebSearchResult[]> {
  if (provider === "tavily") {
    return searchTavilyWeb(query, apiKey, options);
  }
  if (provider === "doubao") {
    return searchDoubaoWeb(query, apiKey, options);
  }
  if (provider === "deepseek") {
    return searchDeepSeekWeb(query, apiKey, options);
  }
  return searchBraveWeb(query, apiKey, options);
}

export function formatIntegratedWebSearchResults(
  provider: IntegratedWebSearchProvider,
  query: string,
  results: readonly IntegratedWebSearchResult[],
): string {
  const label = integratedWebSearchProviderLabel(provider);
  if (results.length === 0) {
    return `No ${label} Search results for "${query}".`;
  }
  const lines = [`${label} Search results for "${query}":`, ""];
  for (const [index, result] of results.entries()) {
    lines.push(`${index + 1}. ${result.title || "(untitled)"}`);
    if (result.url) {
      lines.push(`   ${result.url}`);
    }
    if (result.description) {
      lines.push(`   ${result.description}`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

/** @deprecated Use formatIntegratedWebSearchResults */
export function formatBraveWebSearchResults(
  query: string,
  results: readonly IntegratedWebSearchResult[],
): string {
  return formatIntegratedWebSearchResults("brave", query, results);
}
