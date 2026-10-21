import { expect, test } from "bun:test";
import fs from "node:fs";

const source = fs.readFileSync(new URL("../src/main/index.ts", import.meta.url), "utf8");

test("Codex global MCP pool stays empty so threads load their own Hub descriptor", () => {
  expect(source).toContain("listGlobalMcpServers: resolveCodexGlobalMcpServers");
  expect(source).toMatch(
    /function resolveCodexGlobalMcpServers\(\)[^{]*\{\s*(?:\/\/[^\n]*\n\s*)*return \[\];/,
  );
  expect(source).not.toContain("configuredServers: mcpHubGateway.listThreadCodexServers()");
  expect(source).not.toContain("buildCodexMcpServersForConfigSync(mcpStore.listServers()");
  expect(source).toMatch(
    /resolveMcpServers:\s*async \(\) => \{\s*const configuredMcp = mcpStore\.buildSdkConfig\(\)/,
  );
  expect(source).toContain("mcpHubGateway.registerThreadServerEntry");
  expect(source).toContain("allowedServers: [...hubMcpKeys, ...builtinHubServers]");
  expect(source).toContain("mcpHubGateway.prepareThreadFromSdkConfig");
  expect(source).toContain("runtimeName: codexHubName");
  expect(source).toContain("function codexHubServerName(threadId: string)");
});

test("thread Hub registration and descriptor changes never restart the shared runtime", () => {
  const start = source.indexOf("resolveMcpServers: async () => {");
  const end = source.indexOf("resolveEnabledMcpServerKeys:", start);
  const handler = source.slice(start, end);
  expect(handler).toContain("mcpHubGateway.prepareThreadFromSdkConfig");
  expect(handler).not.toContain("requestCodexAccountRuntimeRestart");
  expect(handler).not.toContain("scheduleCodexGlobalRuntimeRefresh");
});

test("saving browser, computer, image, and speech settings never queues a runtime restart", () => {
  const start = source.indexOf("IPC_CHANNELS.imageGenerationSettingsGet");
  const end = source.indexOf("IPC_CHANNELS.notificationSettingsGet", start);
  const handler = source.slice(start, end);
  expect(handler).toContain("IPC_CHANNELS.browserSettingsSave");
  expect(handler).toContain("IPC_CHANNELS.computerUseSettingsSave");
  expect(handler).toContain("IPC_CHANNELS.ttsSettingsSave");
  expect(handler).not.toContain("scheduleCodexGlobalRuntimeRefresh");
  expect(source).not.toContain("onHtmlHostingCapabilityChange: () => scheduleCodexGlobalRuntimeRefresh()");
});

test("Codex system prompt rewrites fixed Hub tool names to the per-thread registered server", () => {
  expect(source).toContain(
    'import { rewriteEcoMcpHubPromptForCodexServer } from "../shared/mcp-hub-tool-usage"',
  );
  // The rewrite must wrap the resolved append so every Hub usage line
  // (image view / display / web search / ...) uses the registered name. Line breaks are the
  // formatter's business, so the call is matched on its arguments alone.
  expect(source).toMatch(
    /return rewriteEcoMcpHubPromptForCodexServer\(\s*append,\s*codexHubServerName\(input\.thread\.id\),?\s*\)\s*;/,
  );
});

test("codexHubServerName delegates to the @eco/shared name builder (single source of truth)", () => {
  expect(source).toContain("ecoMcpHubServerName");
  expect(source).toMatch(
    /function codexHubServerName\(threadId: string\): string \{\s*(?:\/\/[^\n]*\n\s*)*return ecoMcpHubServerName\(threadId\);\s*\}/,
  );
});

test("the embedded gateway receives the Codex→Eco thread resolver for Hub namespace repair", () => {
  const lifecycle = fs.readFileSync(new URL("../src/main/eco-gateway-lifecycle.ts", import.meta.url), "utf8");
  const callSite = readCallSite(lifecycle, "startEcoGateway(");
  expect(callSite.length).toBeGreaterThan(0);
  // The resolver must be part of the startEcoGateway options (not only the bridge face):
  // the gateway repairs `namespace` on the model→Codex Responses path.
  expect(callSite).toContain("resolveEcoThreadIdFromCodex: this.options.resolveEcoThreadIdFromCodex");
});

test("the Codex→Eco resolver falls back through subagent attribution", () => {
  expect(source).toMatch(
    /resolveEcoThreadIdFromCodex:\s*\(codexThreadId\)\s*=>\s*codexThreadMap\.getEcoThreadId\(codexThreadId\)\s*\?\?\s*resolveCodexThreadAttribution\(codexThreadMap, codexThreadId\)\?\.ecoThreadId/,
  );
});

/**
 * Reads one call site with balanced parentheses. Searching for the first `);`
 * instead stops at a nested call (a dynamic `await import("...")` inside the
 * options object) and hides the option the assertion is about.
 */
function readCallSite(source: string, opener: string): string {
  const start = source.indexOf(opener);
  if (start < 0) {
    return "";
  }
  let depth = 0;
  for (let index = start + opener.length - 1; index < source.length; index += 1) {
    const char = source[index];
    if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(start, index + 1);
      }
    }
  }
  return "";
}
