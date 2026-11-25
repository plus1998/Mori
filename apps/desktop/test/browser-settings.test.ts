import { expect, test } from "bun:test";
import fs from "node:fs";
import { FORBIDDEN_CDP_PORT } from "../src/main/browser-cdp-proxy";
import { isHttpishHref } from "../src/renderer/browser-link";
import {
  appendBrowserPrompt,
  browserAgentSessionKey,
  browserTaskTabId,
  buildHtmlDataNavigateUrl,
  defaultBrowserSettings,
  ECO_AGENT_BROWSER_ALLOWED_TOOL,
  ECO_AGENT_BROWSER_MCP_SERVER,
  ECO_HTML_PREVIEW_FILE_PREFIX,
  isBrowserHtmlDataUrl,
  isBrowserHttpUrl,
  isBrowserPreviewFileUrl,
  isBrowserSettingsSnapshot,
  isBrowserTaskTabId,
  isEcoAgentBrowserEnabledInSettingsMap,
  normalizeBrowserNavigateUrl,
  normalizeBrowserSettingsSnapshot,
  parseBrowserTaskTabId,
  partitionForBrowserWorkspace,
  planAdoptPersonalBrowsersToThread,
  requiresBrowserOpenApproval,
  resolveBrowserNavigateTarget,
  resolveBrowserScopePartition,
  shouldAutoApproveEcoAgentBrowserTools,
} from "../src/shared/browser";

test("browser integration defaults on and preserves an explicit off setting", () => {
  expect(defaultBrowserSettings()).toEqual({
    agentIntegrationEnabled: true,
    openApprovalMode: "always_allow",
  });
  expect(normalizeBrowserSettingsSnapshot({})).toEqual({
    agentIntegrationEnabled: true,
    openApprovalMode: "always_allow",
  });
  expect(normalizeBrowserSettingsSnapshot({ agentIntegrationEnabled: true })).toEqual({
    agentIntegrationEnabled: true,
    openApprovalMode: "always_allow",
  });
  expect(
    normalizeBrowserSettingsSnapshot({
      agentIntegrationEnabled: true,
      openApprovalMode: "always_ask",
    }),
  ).toEqual({
    agentIntegrationEnabled: true,
    openApprovalMode: "always_ask",
  });
  expect(normalizeBrowserSettingsSnapshot({ agentIntegrationEnabled: false })).toEqual({
    agentIntegrationEnabled: false,
    openApprovalMode: "always_allow",
  });
  expect(normalizeBrowserSettingsSnapshot({ agentIntegrationEnabled: "yes" })).toEqual({
    agentIntegrationEnabled: false,
    openApprovalMode: "always_allow",
  });
});

test("isBrowserSettingsSnapshot validates shape", () => {
  expect(isBrowserSettingsSnapshot(defaultBrowserSettings())).toBe(true);
  expect(isBrowserSettingsSnapshot({ agentIntegrationEnabled: false })).toBe(true);
  expect(
    isBrowserSettingsSnapshot({
      agentIntegrationEnabled: true,
      openApprovalMode: "always_ask",
    }),
  ).toBe(true);
  expect(
    isBrowserSettingsSnapshot({
      agentIntegrationEnabled: true,
      openApprovalMode: "invalid",
    }),
  ).toBe(false);
  expect(isBrowserSettingsSnapshot({})).toBe(false);
  expect(isBrowserSettingsSnapshot(null)).toBe(false);
});

test("requiresBrowserOpenApproval only for open / tab_new navigations", () => {
  expect(requiresBrowserOpenApproval("mcp__mori_agent_browser__agent_browser_open")).toBe(true);
  expect(requiresBrowserOpenApproval("mcp__mori_agent_browser__agent_browser_tab_new")).toBe(true);
  expect(requiresBrowserOpenApproval("mcp__mori_agent_browser__agent_browser_snapshot")).toBe(false);
  expect(requiresBrowserOpenApproval("mcp__mori_agent_browser__agent_browser_click")).toBe(false);
  expect(requiresBrowserOpenApproval("Bash")).toBe(false);
});

test("shouldAutoApproveEcoAgentBrowserTools follows openApprovalMode", () => {
  expect(shouldAutoApproveEcoAgentBrowserTools("always_allow")).toBe(true);
  expect(shouldAutoApproveEcoAgentBrowserTools("always_ask")).toBe(false);
});

test("normalizeBrowserNavigateUrl accepts http(s) and bare hosts", () => {
  expect(normalizeBrowserNavigateUrl("https://example.com/a")).toBe("https://example.com/a");
  expect(normalizeBrowserNavigateUrl("example.com")).toBe("https://example.com");
  expect(normalizeBrowserNavigateUrl("not a url")).toBeUndefined();
});

test("isBrowserHttpUrl", () => {
  expect(isBrowserHttpUrl("https://x.test")).toBe(true);
  expect(isBrowserHttpUrl("file:///tmp")).toBe(false);
});

test("isBrowserHtmlDataUrl accepts inline html data urls only", () => {
  expect(isBrowserHtmlDataUrl("data:text/html,<html></html>")).toBe(true);
  expect(isBrowserHtmlDataUrl("data:text/html;charset=utf-8,%3Chtml%3E")).toBe(true);
  expect(isBrowserHtmlDataUrl("data:image/png,abc")).toBe(false);
  expect(isBrowserHtmlDataUrl("https://example.com")).toBe(false);
});

test("isBrowserPreviewFileUrl accepts eco temp preview files only", () => {
  const allowed = `file:///tmp/${ECO_HTML_PREVIEW_FILE_PREFIX}123.html`;
  expect(isBrowserPreviewFileUrl(allowed)).toBe(true);
  expect(isBrowserPreviewFileUrl("file:///tmp/other.html")).toBe(false);
  expect(isBrowserPreviewFileUrl("https://example.com/page.html")).toBe(false);
});

test("buildHtmlDataNavigateUrl encodes html for browser navigation", () => {
  const url = buildHtmlDataNavigateUrl("<html><body>Hi</body></html>");
  expect(url).toBe("data:text/html;charset=utf-8,%3Chtml%3E%3Cbody%3EHi%3C%2Fbody%3E%3C%2Fhtml%3E");
  expect(resolveBrowserNavigateTarget(url!)).toBe(url);
});

test("resolveBrowserNavigateTarget keeps existing http normalization", () => {
  expect(resolveBrowserNavigateTarget("https://example.com/a")).toBe("https://example.com/a");
  expect(resolveBrowserNavigateTarget("not a url")).toBeUndefined();
});

test("resolveBrowserNavigateTarget converts absolute file paths to file urls", () => {
  expect(resolveBrowserNavigateTarget("/Users/me/proj/index.html")).toBe(
    "file:///Users/me/proj/index.html",
  );
  expect(resolveBrowserNavigateTarget("/Users/me/my proj/index.html")).toBe(
    "file:///Users/me/my%20proj/index.html",
  );
  expect(resolveBrowserNavigateTarget("C:\\proj\\index.html")).toBe("file:///C:/proj/index.html");
  // Protocol-relative URLs are not local paths.
  expect(resolveBrowserNavigateTarget("//example.com/a")).toBeUndefined();
});

test("appendBrowserPrompt only joins non-empty parts", () => {
  expect(appendBrowserPrompt(undefined, undefined)).toBeUndefined();
  expect(appendBrowserPrompt("rules", undefined)).toBe("rules");
  expect(appendBrowserPrompt(undefined, "browser")).toBe("browser");
  expect(appendBrowserPrompt("rules", "browser")).toBe("rules\n\nbrowser");
});

test("forbidden CDP port constant is 9222", () => {
  expect(FORBIDDEN_CDP_PORT).toBe(9222);
});

test("browser task tab ids are per browser; partitions are workspace-scoped", () => {
  expect(browserTaskTabId("abc")).toBe("browser:abc");
  expect(parseBrowserTaskTabId("browser:abc")).toBe("abc");
  expect(isBrowserTaskTabId("browser:abc")).toBe(true);
  expect(isBrowserTaskTabId("__browser__")).toBe(false);
  const wsA = "/Users/me/proj-a";
  const wsB = "/Users/me/proj-b";
  expect(partitionForBrowserWorkspace(wsA)).toMatch(/^persist:eco-browser-w-[0-9a-f]{16}$/);
  expect(partitionForBrowserWorkspace(wsA)).toBe(partitionForBrowserWorkspace(`${wsA}/`));
  expect(partitionForBrowserWorkspace(wsA)).toBe(partitionForBrowserWorkspace(wsA.replace(/\//g, "\\")));
  expect(partitionForBrowserWorkspace(wsA)).not.toBe(partitionForBrowserWorkspace(wsB));
  // Different threads in the same workspace share one storage bucket.
  expect(partitionForBrowserWorkspace(wsA)).toBe(partitionForBrowserWorkspace(wsA));
  expect(browserAgentSessionKey("thr_1/x")).toMatch(/^e[0-9a-f]{10}$/);
  expect(browserAgentSessionKey("thr_a")).not.toBe(browserAgentSessionKey("thr_b"));
  expect(browserAgentSessionKey("thr_1786165124188").length).toBeLessThan(16);
  expect(isEcoAgentBrowserEnabledInSettingsMap({ mori_agent_browser: true })).toBe(true);
  expect(isEcoAgentBrowserEnabledInSettingsMap({ mori_agent_browser: false })).toBe(false);
  expect(isEcoAgentBrowserEnabledInSettingsMap(undefined)).toBe(false);
});

test("resolveBrowserScopePartition aligns landing with workspace when known", () => {
  const ws = "/Users/me/proj-a";
  expect(resolveBrowserScopePartition("__personal__", { workspacePath: ws })).toBe(
    partitionForBrowserWorkspace(ws),
  );
  expect(resolveBrowserScopePartition("__personal__")).toBe(partitionForBrowserWorkspace("__personal__"));
  expect(resolveBrowserScopePartition("__personal__")).not.toBe(
    resolveBrowserScopePartition("__personal__", { workspacePath: ws }),
  );
  expect(resolveBrowserScopePartition("thr_1", { workspacePath: ws })).toBe(partitionForBrowserWorkspace(ws));
  expect(() => resolveBrowserScopePartition("thr_1")).toThrow(/workspacePath/);
});

test("planAdoptPersonalBrowsersToThread renames or merges and keeps workspace partition", () => {
  const ws = "/Users/me/proj-a";
  const personalPartition = partitionForBrowserWorkspace("__personal__");
  expect(
    planAdoptPersonalBrowsersToThread({
      personalBrowserCount: 0,
      targetExists: false,
      targetWorkspacePath: ws,
      personalPartition,
    }),
  ).toEqual({ kind: "noop" });
  expect(
    planAdoptPersonalBrowsersToThread({
      personalBrowserCount: 2,
      targetExists: false,
      targetWorkspacePath: ws,
      personalPartition: partitionForBrowserWorkspace(ws),
    }),
  ).toEqual({
    kind: "rename",
    partitionForFuture: partitionForBrowserWorkspace(ws),
  });
  expect(
    planAdoptPersonalBrowsersToThread({
      personalBrowserCount: 1,
      targetExists: true,
      targetWorkspacePath: ws,
      personalPartition: partitionForBrowserWorkspace(ws),
    }),
  ).toEqual({
    kind: "merge",
    partitionForFuture: partitionForBrowserWorkspace(ws),
  });
  // No workspace on target: keep personal partition for future tabs (explicit gap).
  expect(
    planAdoptPersonalBrowsersToThread({
      personalBrowserCount: 1,
      targetExists: false,
      personalPartition,
    }),
  ).toEqual({ kind: "rename", partitionForFuture: personalPartition });
});

test("thread start adopts personal browser scope before returning", () => {
  const source = fs.readFileSync(new URL("../src/main/index.ts", import.meta.url), "utf8");
  expect(source).toContain("adoptPersonalScopeToThread(thread.id)");
});

test("isHttpishHref for feed links", () => {
  expect(isHttpishHref("https://example.com/docs")).toBe(true);
  expect(isHttpishHref("http://localhost:3000")).toBe(true);
  expect(isHttpishHref("/relative")).toBe(false);
  expect(isHttpishHref("eco-file:/tmp/x")).toBe(false);
});
