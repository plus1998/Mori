import { expect, test } from "bun:test";
import type { ResolvedModelRoute } from "../../model-router/src";
import { applyClaudeSubagentCompactionWindows } from "../src/claude-subagent-compaction";

function route(role: string, contextWindow?: number): ResolvedModelRoute {
  return {
    role,
    primary: {
      id: role,
      displayName: role,
      provider: "custom",
      baseUrl: "http://local",
      modelId: `eco-${role}`,
      enabled: true,
      capabilities: ["messages_api"],
      ...(contextWindow !== undefined && { contextWindow }),
    },
    fallbacks: [],
  };
}

test("each Claude child gets its own model window while the parent and input definitions stay unchanged", () => {
  const routes = [route("planner", 1_000_000), route("small", 128_000), route("large", 524_288)];
  const definitions = {
    eco_small: { model: "eco-small", prompt: "small" },
    eco_large: { model: "eco-large", prompt: "large" },
  };
  const result = applyClaudeSubagentCompactionWindows(definitions, routes);
  expect(result.eco_small).toMatchObject({ autoCompactWindow: 128_000 });
  expect(result.eco_large).toMatchObject({ autoCompactWindow: 524_288 });
  expect(definitions.eco_small).not.toHaveProperty("autoCompactWindow");
  expect(routes[0]?.primary.contextWindow).toBe(1_000_000);
});

test("custom windows only lower the model and inherited parent ceiling", () => {
  const routes = [route("planner", 200_000), route("child", 1_000_000)];
  const definitions = { eco_child: { model: "eco-child", autoCompactWindow: 150_000 } };
  expect(applyClaudeSubagentCompactionWindows(definitions, routes).eco_child).toMatchObject({
    autoCompactWindow: 150_000,
  });
  expect(
    applyClaudeSubagentCompactionWindows(
      { eco_child: { model: "eco-child", autoCompactWindow: 500_000 } },
      routes,
    ).eco_child,
  ).toMatchObject({ autoCompactWindow: 200_000 });
  routes[1]!.primary.contextWindow = 128_000;
  expect(applyClaudeSubagentCompactionWindows(definitions, routes).eco_child).toMatchObject({
    autoCompactWindow: 128_000,
  });
});

test("fallback routes use the smallest available window, including parent fallbacks", () => {
  const parent = route("planner", 1_000_000),
    child = route("child", 500_000);
  child.fallbacks = [route("fallback", 128_000).primary];
  expect(
    applyClaudeSubagentCompactionWindows({ eco_child: { model: "eco-child" } }, [parent, child]).eco_child,
  ).toMatchObject({ autoCompactWindow: 128_000 });
  parent.fallbacks = [route("parent-fallback", 100_000).primary];
  expect(
    applyClaudeSubagentCompactionWindows({ eco_child: { model: "eco-child" } }, [parent, child]).eco_child,
  ).toMatchObject({ autoCompactWindow: 100_000 });
  child.fallbacks = [route("unresolved").primary];
  expect(() =>
    applyClaudeSubagentCompactionWindows({ eco_child: { model: "eco-child" } }, [parent, child]),
  ).toThrow("缺少已确认");
});

test("unknown, assumed or sub-100K windows fail before making a model request", () => {
  for (const window of [undefined, 64_000, 0, NaN, Infinity, 100_000.5]) {
    expect(() =>
      applyClaudeSubagentCompactionWindows({ eco_child: { model: "eco-child" } }, [
        route("planner", 1_000_000),
        route("child", window),
      ]),
    ).toThrow();
  }
  const assumed = route("child", 200_000);
  assumed.primary.contextWindowResolved = false;
  expect(() =>
    applyClaudeSubagentCompactionWindows({ eco_child: { model: "eco-child" } }, [
      route("planner", 1_000_000),
      assumed,
    ]),
  ).toThrow("缺少已确认");
  expect(applyClaudeSubagentCompactionWindows({}, [route("planner", 64_000)])).toEqual({});
});

test("SDK range validation rejects invalid explicit windows rather than omitting them", () => {
  for (const autoCompactWindow of [64_000, 1_000_001, NaN, Infinity, 100_000.5, "128000"]) {
    expect(() =>
      applyClaudeSubagentCompactionWindows({ eco_child: { model: "eco-child", autoCompactWindow } }, [
        route("planner", 1_000_000),
        route("child", 200_000),
      ]),
    ).toThrow("100000～1000000");
  }
});

test("new runs recompute window after model changes and preserve the per-agent request", () => {
  const definitions = { eco_child: { model: "eco-child", autoCompactWindow: 150_000 } };
  expect(
    applyClaudeSubagentCompactionWindows(definitions, [route("planner", 1_000_000), route("child", 200_000)])
      .eco_child,
  ).toMatchObject({ autoCompactWindow: 150_000 });
  expect(
    applyClaudeSubagentCompactionWindows(definitions, [route("planner", 1_000_000), route("child", 128_000)])
      .eco_child,
  ).toMatchObject({ autoCompactWindow: 128_000 });
  expect(definitions.eco_child.autoCompactWindow).toBe(150_000);
});
