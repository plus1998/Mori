import { expect, test } from "bun:test";
import { isMainAgentId, isMainAgentRole, normalizeAgentRole } from "../src/agent-role";

test("main is canonical and planner remains an explicit historical alias", () => {
  expect(normalizeAgentRole("planner")).toBe("main");
  expect(normalizeAgentRole("main")).toBe("main");
  expect(normalizeAgentRole("coder")).toBe("coder");
  expect(normalizeAgentRole("planner_custom")).toBe("planner_custom");
  expect(isMainAgentRole("planner")).toBe(true);
  expect(isMainAgentRole("main")).toBe(true);
  expect(isMainAgentRole("architect")).toBe(false);
  expect(isMainAgentId("planner:old-attempt")).toBe(true);
  expect(isMainAgentId("main:new-attempt")).toBe(true);
  expect(isMainAgentId("coder:child")).toBe(false);
});
