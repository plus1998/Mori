import { expect, test } from "bun:test";
import {
  buildEcoComputerUsePromptAppend,
  defaultComputerUseSettings,
  ECO_COMPUTER_USE_ALLOWED_TOOL,
  ECO_COMPUTER_USE_MCP_SERVER,
  ECO_COMPUTER_USE_TOOLS,
  isComputerUseSettingsSnapshot,
  isEcoComputerUseToolName,
  normalizeComputerUseSettingsSnapshot,
  requiresComputerUseActionApproval,
  shouldAutoApproveEcoComputerUseTools,
} from "../src/shared/computer-use";
import { openComputerUseNativeRelativePath } from "../src/main/open-computer-use-resolve";
import { INTEGRATION_IDS } from "../src/shared/integrations";

test("normalizeComputerUseSettingsSnapshot defaults integration off and action always ask", () => {
  expect(normalizeComputerUseSettingsSnapshot({})).toEqual({
    agentIntegrationEnabled: false,
    actionApprovalMode: "always_ask",
  });
  expect(normalizeComputerUseSettingsSnapshot({ agentIntegrationEnabled: true })).toEqual({
    agentIntegrationEnabled: true,
    actionApprovalMode: "always_ask",
  });
  expect(
    normalizeComputerUseSettingsSnapshot({
      agentIntegrationEnabled: true,
      actionApprovalMode: "always_allow",
    }),
  ).toEqual({
    agentIntegrationEnabled: true,
    actionApprovalMode: "always_allow",
  });
  expect(normalizeComputerUseSettingsSnapshot({ agentIntegrationEnabled: "yes" })).toEqual({
    agentIntegrationEnabled: false,
    actionApprovalMode: "always_ask",
  });
});

test("isComputerUseSettingsSnapshot validates shape", () => {
  expect(isComputerUseSettingsSnapshot(defaultComputerUseSettings())).toBe(true);
  expect(isComputerUseSettingsSnapshot({ agentIntegrationEnabled: false })).toBe(true);
  expect(
    isComputerUseSettingsSnapshot({
      agentIntegrationEnabled: true,
      actionApprovalMode: "always_ask",
    }),
  ).toBe(true);
  expect(
    isComputerUseSettingsSnapshot({
      agentIntegrationEnabled: true,
      actionApprovalMode: "invalid",
    }),
  ).toBe(false);
  expect(isComputerUseSettingsSnapshot({})).toBe(false);
  expect(isComputerUseSettingsSnapshot(null)).toBe(false);
});

test("requiresComputerUseActionApproval only for mutating eco_computer_use tools", () => {
  expect(requiresComputerUseActionApproval("mcp__eco_computer_use__click")).toBe(true);
  expect(requiresComputerUseActionApproval("mcp__eco_computer_use__type_text")).toBe(true);
  expect(requiresComputerUseActionApproval("mcp__eco_computer_use__list_apps")).toBe(false);
  expect(requiresComputerUseActionApproval("mcp__eco_computer_use__get_app_state")).toBe(false);
  expect(requiresComputerUseActionApproval("mcp__eco_agent_browser__agent_browser_click")).toBe(false);
  expect(requiresComputerUseActionApproval("click")).toBe(false);
  expect(requiresComputerUseActionApproval("Bash")).toBe(false);
});

test("isEcoComputerUseToolName matches eco server tools only", () => {
  expect(isEcoComputerUseToolName("mcp__eco_computer_use__click")).toBe(true);
  expect(isEcoComputerUseToolName("eco_computer_use")).toBe(true);
  expect(isEcoComputerUseToolName("mcp__eco-computer-use__click")).toBe(true);
  expect(isEcoComputerUseToolName("open-computer-use")).toBe(true);
  expect(isEcoComputerUseToolName("mcp__eco_agent_browser__agent_browser_click")).toBe(false);
  expect(isEcoComputerUseToolName("click")).toBe(false);
  expect(isEcoComputerUseToolName(undefined)).toBe(false);
});

test("shouldAutoApproveEcoComputerUseTools follows actionApprovalMode", () => {
  expect(shouldAutoApproveEcoComputerUseTools("always_allow")).toBe(true);
  expect(shouldAutoApproveEcoComputerUseTools("always_ask")).toBe(false);
});

test("ECO_COMPUTER_USE_TOOLS lists the nine upstream tools", () => {
  expect(ECO_COMPUTER_USE_TOOLS).toHaveLength(9);
  expect(ECO_COMPUTER_USE_MCP_SERVER).toBe("eco_computer_use");
  expect(ECO_COMPUTER_USE_ALLOWED_TOOL).toBe("mcp__eco_computer_use__*");
});

test("buildEcoComputerUsePromptAppend mentions shared desktop and MCP server", () => {
  const append = buildEcoComputerUsePromptAppend();
  expect(append).toContain("eco_computer_use");
  expect(append).toContain("shared across conversations");
  expect(append).toContain("do not launch substitute MCP servers or CLIs");
});

test("openComputerUseNativeRelativePath maps current platforms", () => {
  expect(openComputerUseNativeRelativePath("win32", "x64")?.at(-1)).toBe("open-computer-use.exe");
  expect(openComputerUseNativeRelativePath("linux", "x64")?.at(-1)).toBe("open-computer-use");
  expect(openComputerUseNativeRelativePath("darwin", "arm64")?.at(-1)).toBe("OpenComputerUse");
  expect(openComputerUseNativeRelativePath("freebsd" as NodeJS.Platform, "x64")).toBeUndefined();
});

test("INTEGRATION_IDS includes computerUse", () => {
  expect(INTEGRATION_IDS).toContain("computerUse");
});
