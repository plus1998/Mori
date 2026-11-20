import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import {
  ecoAgentBrowserAllowedToolPatternForThread,
  ecoAgentBrowserRuntimeServerName,
  extractUrlFromBrowserOpenToolPayload,
  isBrowserPlaceholderUrl,
  isEcoAgentBrowserOpenToolName,
  isEcoAgentBrowserRuntimeServerName,
  isEcoAgentBrowserToolName,
  normalizeBrowserNavigateUrl,
  shouldRevealBrowserForCdpActivity,
  shouldSurfaceBrowserInstance,
} from "../src/shared/browser";

test("agent_browser_open vs tab_new semantics are split in BrowserHost", () => {
  const browserHostSource = fs.readFileSync(
    path.join(import.meta.dir, "../src/main/browser-host.ts"),
    "utf8",
  );
  const indexSource = fs.readFileSync(path.join(import.meta.dir, "../src/main/index.ts"), "utf8");
  const openFn = browserHostSource.match(/private async invokeNativeAgentBrowserOpen[\s\S]*?^ {2}\}/m)?.[0];
  const tabNewFn = browserHostSource.match(
    /private async invokeNativeAgentBrowserTabNew[\s\S]*?^ {2}\}/m,
  )?.[0];
  expect(openFn).toBeDefined();
  expect(tabNewFn).toBeDefined();
  expect(openFn).toContain('source: "agent"');
  expect(openFn).not.toContain("newBrowser: true");
  expect(openFn).toContain("updateUiFocus: false");
  expect(tabNewFn).toContain("newBrowser: true");
  expect(tabNewFn).toContain("updateUiFocus: false");
  expect(browserHostSource).not.toContain("shouldOpenAgentUrlInNewBrowser");
  expect(browserHostSource).not.toContain("notifyAgentBrowserOpen");
  expect(indexSource).not.toContain("notifyAgentBrowserOpen(");
});

test("browser MCP logical name stays fixed (no eco_ab multi-name)", () => {
  expect(ecoAgentBrowserRuntimeServerName("thr_1786166513794")).toBe("mori_agent_browser");
  expect(ecoAgentBrowserRuntimeServerName("thr_1786166511000")).toBe("mori_agent_browser");
  expect(isEcoAgentBrowserRuntimeServerName("mori_agent_browser")).toBe(true);
  expect(isEcoAgentBrowserRuntimeServerName("github")).toBe(false);
  expect(ecoAgentBrowserAllowedToolPatternForThread("thr_x")).toBe("mcp__mori_agent_browser__*");
});

test("MCP/CDP handshake and non-open tools do not reveal browser panel", () => {
  expect(shouldRevealBrowserForCdpActivity({ kind: "ws-connect" })).toBe(false);
  expect(shouldRevealBrowserForCdpActivity({ kind: "cdp-method", method: "Page.enable" })).toBe(false);
  expect(shouldRevealBrowserForCdpActivity({ kind: "cdp-method", method: "Runtime.evaluate" })).toBe(false);
  expect(shouldRevealBrowserForCdpActivity({ kind: "cdp-method", method: "Target.getTargets" })).toBe(false);
  expect(
    shouldRevealBrowserForCdpActivity({
      kind: "cdp-method",
      method: "Target.createTarget",
      url: "about:blank",
    }),
  ).toBe(false);
  expect(
    shouldRevealBrowserForCdpActivity({
      kind: "cdp-method",
      method: "Target.createTarget",
    }),
  ).toBe(false);
  // snapshot / click / screenshot are not agent_browser_open
  expect(shouldRevealBrowserForCdpActivity({ kind: "cdp-method", method: "Page.captureScreenshot" })).toBe(
    false,
  );
  expect(shouldRevealBrowserForCdpActivity({ kind: "cdp-method", method: "Input.dispatchMouseEvent" })).toBe(
    false,
  );
});

test("agent CDP navigate/activate no longer drives UI focus (legacy classifier unchanged)", () => {
  // Policy: onClientActivity / onActivateTarget do not move focusedBrowserId.
  const browserHostSource = fs.readFileSync(
    path.join(import.meta.dir, "../src/main/browser-host.ts"),
    "utf8",
  );
  expect(browserHostSource).toContain("onActivateTarget: (_targetId) => {");
  expect(browserHostSource).toContain("CDP navigate/activate must not move UI focus");
  expect(shouldRevealBrowserForCdpActivity({ kind: "cdp-method", method: "Page.navigate" })).toBe(true);
});

test("placeholder about:blank is not a user-facing browser tab", () => {
  expect(isBrowserPlaceholderUrl(undefined)).toBe(true);
  expect(isBrowserPlaceholderUrl("")).toBe(true);
  expect(isBrowserPlaceholderUrl("about:blank")).toBe(true);
  expect(isBrowserPlaceholderUrl("https://example.com")).toBe(false);
  expect(shouldSurfaceBrowserInstance({ url: "about:blank" })).toBe(false);
  expect(shouldSurfaceBrowserInstance({ url: "about:blank", surfacePlaceholder: true })).toBe(true);
  expect(shouldSurfaceBrowserInstance({ url: "https://example.com" })).toBe(true);
});

test("detects any eco agent browser tool name", () => {
  expect(isEcoAgentBrowserToolName("mcp__mori_agent_browser__agent_browser_click")).toBe(true);
  expect(isEcoAgentBrowserToolName("mcp__mori_agent_browser__agent_browser_open")).toBe(true);
  expect(isEcoAgentBrowserToolName("agent_browser_snapshot")).toBe(true);
  expect(isEcoAgentBrowserToolName("mcp__eco_ab_ea4a60abe66__agent_browser_fill")).toBe(true);
  expect(isEcoAgentBrowserToolName("mcp__mori_image_generation__create_image")).toBe(false);
  expect(isEcoAgentBrowserToolName("Bash")).toBe(false);
});

test("detects eco agent browser open tool names and urls", () => {
  expect(isEcoAgentBrowserOpenToolName("mcp__mori_agent_browser__agent_browser_open")).toBe(true);
  expect(isEcoAgentBrowserOpenToolName("agent_browser_open")).toBe(true);
  expect(isEcoAgentBrowserOpenToolName("mcp__mori_agent_browser__agent_browser_snapshot")).toBe(false);
  expect(isEcoAgentBrowserOpenToolName("mcp__mori_agent_browser__agent_browser_click")).toBe(false);
  expect(isEcoAgentBrowserOpenToolName("Bash")).toBe(false);
  expect(extractUrlFromBrowserOpenToolPayload({ input: { url: "https://google.com" } })).toBe(
    "https://google.com",
  );
});

test("does not treat tool.started / tool.completed event labels as browser URLs", () => {
  expect(normalizeBrowserNavigateUrl("tool.started")).toBeUndefined();
  expect(normalizeBrowserNavigateUrl("tool.completed")).toBeUndefined();
  expect(extractUrlFromBrowserOpenToolPayload({ url: "tool.completed" })).toBeUndefined();
  expect(
    extractUrlFromBrowserOpenToolPayload({
      liveType: "tool.started",
      detail: "tool.completed",
      name: "mcp__mori_agent_browser__agent_browser_snapshot",
    }),
  ).toBeUndefined();
  expect(
    extractUrlFromBrowserOpenToolPayload({
      tool: { name: "agent_browser_open", detail: "tool.started" },
    }),
  ).toBeUndefined();
});
