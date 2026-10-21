import { expect, test } from "bun:test";
import { type CoreAdapter, type CoreCapabilities, CoreRegistry, isCoreKind } from "../src/core-runtime";

const capabilities: CoreCapabilities = {
  sessionModes: ["agent", "plan", "ask"],
  compact: "native",
  rewindFiles: "eco",
  toolApproval: "native",
  planApproval: "eco",
  mcp: "native",
  skills: "native",
  subagents: "unsupported",
};

function adapter(kind: "claude" | "codex" | "pi"): CoreAdapter {
  return {
    descriptor: { kind, displayName: kind, version: "test" },
    probe: async () => ({ available: true, version: "test" }),
    getCapabilities: async () => capabilities,
  };
}

test("isCoreKind accepts only registered product Core identifiers", () => {
  expect(isCoreKind("claude")).toBe(true);
  expect(isCoreKind("codex")).toBe(true);
  expect(isCoreKind("pi")).toBe(true);
  expect(isCoreKind("kimi")).toBe(false);
  expect(isCoreKind(undefined)).toBe(false);
});

test("CoreRegistry rejects duplicate adapters and fails explicitly for missing Core", () => {
  const registry = new CoreRegistry();
  const claude = adapter("claude");
  registry.register(claude);

  expect(registry.require("claude")).toBe(claude);
  expect(registry.has("codex")).toBe(false);
  expect(() => registry.require("codex")).toThrow("Harness adapter is not registered: codex");
  expect(() => registry.register(adapter("claude"))).toThrow("already registered");
});

test("CoreRegistry lists adapters in stable product order", () => {
  const registry = new CoreRegistry();
  registry.register(adapter("codex"));
  registry.register(adapter("claude"));
  registry.register(adapter("pi"));

  expect(registry.list().map((entry) => entry.descriptor.kind)).toEqual(["claude", "codex", "pi"]);
});
