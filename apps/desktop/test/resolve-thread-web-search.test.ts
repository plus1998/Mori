import { expect, test } from "bun:test";
import {
  resolveCodexThreadWebSearchPlan,
  resolveThreadWebSearchPlan,
} from "../src/main/resolve-thread-web-search";

const configuredSearch = {
  networkWebSearch: true,
  integratedSettings: {
    enabled: true,
    provider: "doubao" as const,
    hasApiKey: true,
    approvalMode: "always_allow" as const,
  },
  integratedApiKey: "test-search-key",
};

test("Codex account routes keep native search when Eco Integrated Search is configured", () => {
  expect(resolveCodexThreadWebSearchPlan({ ...configuredSearch, mainProviderId: "openai" })).toEqual({
    backend: "native",
  });
  expect(
    resolveCodexThreadWebSearchPlan({
      ...configuredSearch,
      mainProviderId: "openai",
      networkWebSearch: undefined,
      integratedApiKey: "",
    }),
  ).toEqual({ backend: "native" });
});

test("Codex account routes respect the orchestration search switch", () => {
  expect(
    resolveCodexThreadWebSearchPlan({
      ...configuredSearch,
      mainProviderId: "openai",
      networkWebSearch: false,
    }),
  ).toEqual({ backend: "none" });
});

test("Codex account models explicitly lacking native search can use Integrated Search", () => {
  const input = {
    ...configuredSearch,
    mainProviderId: "openai",
    plannerManualSpec: { supportsNativeWebSearch: false },
  };
  expect(resolveCodexThreadWebSearchPlan(input).backend).toBe("integrated");
  expect(resolveCodexThreadWebSearchPlan({ ...input, integratedApiKey: "" }).backend).toBe("none");
});

test("third-party Codex routes and other harnesses retain their search selection", () => {
  for (const mainProviderId of ["vendor", "eco-coding-chatgpt", undefined]) {
    expect(resolveCodexThreadWebSearchPlan({ ...configuredSearch, mainProviderId }).backend).toBe(
      "integrated",
    );
  }
  expect(resolveThreadWebSearchPlan(configuredSearch).backend).toBe("integrated");
  expect(
    resolveCodexThreadWebSearchPlan({
      ...configuredSearch,
      mainProviderId: "vendor",
      integratedApiKey: "",
    }).backend,
  ).toBe("native");
});
