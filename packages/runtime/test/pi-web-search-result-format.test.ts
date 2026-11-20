import { describe, expect, test } from "bun:test";
import { parseEcoWebSearchToolOutput } from "../src/mori-web-search-tool.ts";

/**
 * Mirrors packages/runtime/src/pi-event-adapter.ts formatToolResult priority for
 * Eco Integrated web_search: details.{provider,query,results} → JSON string.
 */
function formatPiIntegratedWebSearchResult(result: unknown): string {
  if (result === undefined || result === null) {
    return "";
  }
  if (typeof result === "string") {
    return result;
  }
  if (
    result &&
    typeof result === "object" &&
    !Array.isArray(result) &&
    "details" in result &&
    result.details &&
    typeof result.details === "object" &&
    !Array.isArray(result.details) &&
    Array.isArray((result.details as { results?: unknown }).results)
  ) {
    const details = result.details as {
      provider?: string;
      query?: string;
      results: unknown[];
    };
    return JSON.stringify({
      ...(typeof details.provider === "string" ? { provider: details.provider } : {}),
      ...(typeof details.query === "string" ? { query: details.query } : {}),
      resultCount: details.results.length,
      results: details.results,
    });
  }
  if (
    result &&
    typeof result === "object" &&
    !Array.isArray(result) &&
    Array.isArray((result as { content?: unknown }).content)
  ) {
    const texts = ((result as { content: unknown[] }).content)
      .filter(
        (part): part is { type: string; text: string } =>
          !!part &&
          typeof part === "object" &&
          (part as { type?: unknown }).type === "text" &&
          typeof (part as { text?: unknown }).text === "string",
      )
      .map((part) => part.text);
    if (texts.length > 0) {
      return texts.join("\n");
    }
  }
  return JSON.stringify(result);
}

describe("PI integrated web_search result formatting", () => {
  test("prefers details JSON so Feed can attach webSearch.results", () => {
    const toolResult = {
      content: [
        {
          type: "text",
          text: 'Doubao Search results for "cursor":\n1. Cursor\n   https://cursor.com\n   Editor.',
        },
      ],
      details: {
        provider: "doubao",
        query: "cursor",
        resultCount: 1,
        results: [
          {
            title: "Cursor",
            url: "https://cursor.com",
            description: "Editor.",
          },
        ],
      },
    };

    const formatted = formatPiIntegratedWebSearchResult(toolResult);
    const parsed = parseEcoWebSearchToolOutput(formatted);
    expect(parsed?.provider).toBe("doubao");
    expect(parsed?.query).toBe("cursor");
    expect(parsed?.results).toEqual([
      {
        title: "Cursor",
        url: "https://cursor.com",
        description: "Editor.",
      },
    ]);
  });

  test("formatted Doubao text still parses when details are absent", () => {
    const text =
      'Doubao Search results for "cursor":\n1. Cursor\n   https://cursor.com\n   Editor.';
    const parsed = parseEcoWebSearchToolOutput(text);
    expect(parsed?.provider).toBe("doubao");
    expect(parsed?.query).toBe("cursor");
    expect(parsed?.results?.[0]?.url).toBe("https://cursor.com");
  });
});
