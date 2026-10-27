import { Type } from "typebox";
import {
  formatIntegratedWebSearchResults,
  integratedWebSearchProviderLabel,
  searchIntegratedWeb,
  type IntegratedWebSearchProvider,
} from "./pi-integrated-web-search.js";
import { PI_WEB_SEARCH_TOOL_NAME } from "./pi-web-search-plan.js";

export const PI_INTEGRATED_WEB_SEARCH_EXTENSION_NAME = "eco-pi-integrated-web-search" as const;

const parameters = Type.Object({
  query: Type.String({
    minLength: 1,
    description: "Search query.",
  }),
});

export interface EcoPiIntegratedWebSearchExtensionApi {
  registerTool(tool: {
    name: string;
    label: string;
    description: string;
    parameters: typeof parameters;
    executionMode?: "sequential" | "parallel";
    execute: (
      toolCallId: string,
      params: Record<string, unknown>,
      signal: AbortSignal | undefined,
      onUpdate:
        | ((partial: { content: Array<{ type: "text"; text: string }>; details: unknown }) => void)
        | undefined,
      ctx: { cwd: string },
    ) => Promise<{ content: Array<{ type: "text"; text: string }>; details: unknown }>;
  }): void;
}

export interface CreatePiIntegratedWebSearchExtensionInput {
  provider: IntegratedWebSearchProvider;
  apiKey: string;
}

export function createPiIntegratedWebSearchExtensionFactory(
  input: CreatePiIntegratedWebSearchExtensionInput,
): (pi: EcoPiIntegratedWebSearchExtensionApi) => void {
  const apiKey = input.apiKey.trim();
  const provider = input.provider;
  const providerLabel = integratedWebSearchProviderLabel(provider);
  return (pi) => {
    pi.registerTool({
      name: PI_WEB_SEARCH_TOOL_NAME,
      label: "Web Search",
      description: `Search the web via Mori Integrated search (${providerLabel}). Use when you need up-to-date information from the public web.`,
      parameters,
      executionMode: "sequential",
      execute: async (_toolCallId, rawParams, signal) => {
        const query = typeof rawParams.query === "string" ? rawParams.query.trim() : "";
        const results = await searchIntegratedWeb(
          provider,
          query,
          apiKey,
          signal === undefined ? {} : { signal },
        );
        const text = formatIntegratedWebSearchResults(provider, query, results);
        return {
          content: [{ type: "text", text }],
          details: {
            provider,
            query,
            resultCount: results.length,
            results: results.map((entry) => ({
              title: entry.title,
              url: entry.url,
              description: entry.description,
            })),
          },
        };
      },
    });
  };
}
