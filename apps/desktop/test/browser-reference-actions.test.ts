import { expect, test } from "bun:test";
import {
  BROWSER_REFERENCE_ACTIONS,
  BROWSER_REFERENCE_ACTION_VALUES,
  normalizeBrowserReferenceAction,
} from "../src/shared/browser-reference-actions";
import { contextReferenceTools } from "../src/main/context-reference-mcp-gateway";

test("every advertised short action and full tool name resolve to the same browser operation", () => {
  const definition = contextReferenceTools.find((tool) => tool.name === "browser_reference")!;
  const properties = definition.inputSchema!.properties as Record<string, { enum?: string[] }>;
  expect(properties.action?.enum).toEqual(BROWSER_REFERENCE_ACTION_VALUES);
  expect(new Set(BROWSER_REFERENCE_ACTION_VALUES).size).toBe(BROWSER_REFERENCE_ACTIONS.length * 2);
  for (const action of BROWSER_REFERENCE_ACTIONS) {
    const fullName = `agent_browser_${action}`;
    expect(normalizeBrowserReferenceAction(action)).toBe(fullName);
    expect(normalizeBrowserReferenceAction(fullName)).toBe(fullName);
  }
});

test("aliases never authorize opening, switching or closing tabs, or arbitrary CLI commands", () => {
  for (const action of ["", "open", "navigate", "tab_new", "tab_switch", "tab_close", "close", "snapshot --url https://other.test"]) {
    for (const value of [action, `agent_browser_${action}`]) {
      expect(BROWSER_REFERENCE_ACTION_VALUES).not.toContain(value);
      expect(() => normalizeBrowserReferenceAction(value)).toThrow("该操作不适用于网页引用");
    }
  }
});
