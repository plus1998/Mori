import { expect, test } from "bun:test";
import { mergePiAppendSystemPrompt } from "../src/main/pi-mcp-session";
import { appendBrowserPrompt, buildEcoAgentBrowserPromptAppend } from "../src/shared/browser";
import { buildEcoComputerUsePromptAppend } from "../src/shared/computer-use";
import { buildHtmlHostPromptAppend } from "../src/shared/html-host-tool";
import { buildImageDisplayPromptAppend } from "../src/shared/image-display-tool";
import { buildImageGenerationPromptAppend } from "../src/shared/image-generation";
import { buildImageViewPromptAppend } from "../src/shared/image-view-tool";
import { buildIntegratedWebSearchPromptAppend } from "../src/shared/integrated-web-search";
import { SCHEDULING_PROMPT } from "../src/shared/scheduling";
import {
  buildEcoMcpHubToolUsage,
  buildEcoMcpHubDirectoryPrompt,
  mergeEcoMcpHubPromptParts,
  rewriteEcoMcpHubPromptForCodexServer,
} from "../src/shared/mcp-hub-tool-usage";

test("Hub tool usage tells agents to search and dispatch by the canonical tool id", () => {
  const prompt = buildEcoMcpHubToolUsage({ server: "eco_image_view", tool: "view_image" });
  expect(prompt).toContain("mcp__eco_mcp__search_tools");
  expect(prompt).toContain("mcp__eco_mcp__call_tool");
  expect(prompt).toContain("eco_image_view:view_image");
  expect(prompt).toContain("tool id in `name`");
  expect(prompt).toContain("Use direct MCP tools only when explicitly listed");
});

test("external service directory bounds real capability excerpts and keeps missing metadata explicit", () => {
  const tools = Array.from({ length: 9 }, (_, index) => ({
    name: `database:query_${index}`,
    description: index === 0 ? undefined : `Read documents\n${"detail ".repeat(100)}`,
    inputSchema: { properties: { secretParameter: { type: "string" } } },
  }));
  const prompt = buildEcoMcpHubDirectoryPrompt([
    { server: "database", tools },
    { server: "offline", tools: [], error: "Connection refused\nTry again later" },
    { server: "empty", tools: [] },
  ])!;
  const entries = prompt.split("\n").filter((line) => line.startsWith("{")).map((line) => JSON.parse(line));
  expect(entries[0]).toMatchObject({ server: "database", authorizedToolCount: 9, additionalTools: 4 });
  expect(entries[0].capabilityExamples).toHaveLength(5);
  expect(entries[0].capabilityExamples[0].description).toBe("Description not provided by this MCP server.");
  expect(entries[0].capabilityExamples[1].description).toEndWith("…");
  expect(entries[0].capabilityExamples[1].description.length).toBeLessThanOrEqual(161);
  expect(entries[1]).toEqual({ server: "offline", metadataError: "Connection refused Try again later" });
  expect(entries[2]).toEqual({ server: "empty", authorizedToolCount: 0, capabilityExamples: [] });
  expect(prompt).not.toContain("secretParameter");
  expect(prompt).not.toContain("inputSchema");
  expect(prompt).toContain("Use each server name as the Hub search query");
  expect(buildEcoMcpHubDirectoryPrompt([])).toBeUndefined();
});

test("image view prompt matches the runtime-visible Hub instead of requiring a missing direct tool", () => {
  const prompt = buildImageViewPromptAppend();
  expect(prompt).toContain("mcp__eco_mcp__search_tools");
  expect(prompt).toContain("Hub target: `eco_image_view`");
  expect(prompt).toContain("explicitly listed");
});

test("browser prompt accepts the Hub tool pair as available and does not require direct MCP exposure", () => {
  const prompt = buildEcoAgentBrowserPromptAppend();
  expect(prompt).toContain("mcp__eco_mcp__search_tools");
  expect(prompt).toContain("mcp__eco_mcp__call_tool");
  expect(prompt).toContain("Hub target: `eco_agent_browser`");
  expect(prompt).toContain("Report discovery or execution failures");
  expect(prompt).not.toContain("If `mcp__eco_agent_browser__*` tools are missing");
});

test("image display prompt distinguishes presentation from image analysis", () => {
  const prompt = buildImageDisplayPromptAppend();
  expect(prompt).toContain("Image analysis is provided by Eco image viewing");
  expect(prompt).toContain("mcp__eco_mcp__call_tool");
  expect(prompt).not.toContain(
    "To analyze an image for yourself (vision report), use `mcp__eco_image_view__view_image`",
  );
});

test("Codex rewrite maps fixed Hub wrapper names to the per-thread registered server", () => {
  const codexHubName = "eco_mcp_b7c11635_thr_1790693503071";
  const prompt = buildImageViewPromptAppend();
  const rewritten = rewriteEcoMcpHubPromptForCodexServer(prompt, codexHubName);
  expect(rewritten).toContain("mcp__eco_mcp_b7c11635_thr_1790693503071__search_tools");
  expect(rewritten).toContain("mcp__eco_mcp_b7c11635_thr_1790693503071__call_tool");
  expect(rewritten).not.toContain("mcp__eco_mcp__search_tools");
  expect(rewritten).not.toContain("mcp__eco_mcp__call_tool");
  // Service search targets are independent of the runtime's wrapper namespace.
  expect(rewritten).toContain("Hub target: `eco_image_view`");
  expect(rewritten).not.toContain("mcp__eco_image_view__view_image");
});

test("Codex rewrite is idempotent and leaves the fixed-name SDK prompt untouched", () => {
  const codexHubName = "eco_mcp_b7c11635_thr_1790693503071";
  const once = rewriteEcoMcpHubPromptForCodexServer(buildImageViewPromptAppend(), codexHubName);
  expect(rewriteEcoMcpHubPromptForCodexServer(once, codexHubName)).toBe(once);
  const sdkPrompt = buildImageViewPromptAppend();
  expect(rewriteEcoMcpHubPromptForCodexServer(sdkPrompt, "eco_mcp")).toBe(sdkPrompt);
  expect(rewriteEcoMcpHubPromptForCodexServer(undefined, codexHubName)).toBeUndefined();
  expect(rewriteEcoMcpHubPromptForCodexServer("no hub names here", codexHubName)).toBe("no hub names here");
});

test("combined integration prompts include the Hub protocol once for every runtime", () => {
  const parts = [
    buildEcoAgentBrowserPromptAppend(),
    buildEcoComputerUsePromptAppend(),
    buildImageGenerationPromptAppend({
      provider: "openai",
      profileName: "test",
      model: "gpt-image-2",
      supportsImageToImage: true,
    }),
    buildImageViewPromptAppend(),
    buildImageDisplayPromptAppend(),
    buildHtmlHostPromptAppend(),
    buildIntegratedWebSearchPromptAppend("test"),
    SCHEDULING_PROMPT,
    buildEcoMcpHubDirectoryPrompt([{ server: "mongo", tools: [{ name: "mongo:find", description: "Query documents" }] }])!,
  ];
  const userRules = "Keep this rule.\nKeep this rule.";
  const sdkPrompt = parts.reduce<string | undefined>(
    (base, part) => appendBrowserPrompt(base, part),
    userRules,
  );
  const piPrompt = mergePiAppendSystemPrompt({ globalUserRules: userRules, integrationAppend: parts }).join(
    "\n\n",
  );
  const codexPrompt = rewriteEcoMcpHubPromptForCodexServer(sdkPrompt, "eco_mcp_thread");
  for (const [prompt, server] of [
    [sdkPrompt, "eco_mcp"],
    [piPrompt, "eco_mcp"],
    [codexPrompt, "eco_mcp_thread"],
  ] as const) {
    expect(prompt?.split(`mcp__${server}__search_tools`)).toHaveLength(2);
    expect(prompt?.split(`mcp__${server}__call_tool`)).toHaveLength(2);
    expect(prompt).toContain(userRules);
    for (const target of [
      "eco_agent_browser",
      "eco_computer_use",
      "eco_image_generation",
      "eco_image_view",
      "eco_image_display",
      "eco_html_host",
      "eco_web_search",
      "eco_scheduling",
      "mongo",
    ]) {
      expect(prompt).toContain(target);
    }
  }
  const merged = mergeEcoMcpHubPromptParts(parts);
  expect(mergeEcoMcpHubPromptParts(merged)).toEqual(merged);
});
