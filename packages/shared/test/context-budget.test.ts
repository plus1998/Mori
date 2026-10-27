import { expect, test } from "bun:test";
import { contextInputReserve, gatewayAutoCompactTokenLimit } from "../src/context-budget";

test("native compaction leaves room for the Gateway reserve, estimator disagreement and a tool result", () => {
  const window = 262_144;
  const limit = gatewayAutoCompactTokenLimit(window);
  expect(contextInputReserve(window, "heuristic")).toBe(26_215);
  expect(limit).toBe(238_012);
  // The final wire count now comes from the server; Codex still estimates when to compact.
  expect(limit + 10_000 + 1_365 + contextInputReserve(window, "provider_exact")).toBeLessThan(window);
  expect(gatewayAutoCompactTokenLimit(1_000_000)).toBe(938_976);
  expect(contextInputReserve(window, "provider_exact")).toBe(1_024);
});

test("compaction budgets use the model tool output allowance and reject invalid capacities", () => {
  expect(gatewayAutoCompactTokenLimit(262_144, 20_000)).toBe(228_012);
  expect(() => contextInputReserve(0, "heuristic")).toThrow();
  expect(() => gatewayAutoCompactTokenLimit(262_144, -1)).toThrow();
  expect(() => gatewayAutoCompactTokenLimit(8_192)).toThrow(/cannot accommodate/);
});
