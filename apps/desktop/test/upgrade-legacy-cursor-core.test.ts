import { expect, test } from "bun:test";
import { upgradeLegacyCursorCore } from "../src/shared/upgrade-legacy-cursor-core";

test("upgrades legacy coreKind cursor to acp + acpAgentId cursor", () => {
  expect(upgradeLegacyCursorCore({ coreKind: "cursor" })).toEqual({
    coreKind: "acp",
    acpAgentId: "cursor",
  });
});

test("preserves acp threads and fills default acpAgentId", () => {
  expect(upgradeLegacyCursorCore({ coreKind: "acp" })).toEqual({
    coreKind: "acp",
    acpAgentId: "cursor",
  });
  expect(upgradeLegacyCursorCore({ coreKind: "acp", acpAgentId: "cursor" })).toEqual({
    coreKind: "acp",
    acpAgentId: "cursor",
  });
});

test("preserves the persisted Antigravity agent across reloads", () => {
  expect(upgradeLegacyCursorCore({ coreKind: "acp", acpAgentId: "antigravity" })).toEqual({
    coreKind: "acp",
    acpAgentId: "antigravity",
  });
});

test("passes through other core kinds without acpAgentId", () => {
  expect(upgradeLegacyCursorCore({ coreKind: "claude" })).toEqual({ coreKind: "claude" });
  expect(upgradeLegacyCursorCore({ coreKind: "codex" })).toEqual({ coreKind: "codex" });
  expect(upgradeLegacyCursorCore({ coreKind: "pi" })).toEqual({ coreKind: "pi" });
});

test("returns empty for unknown or missing core kinds", () => {
  expect(upgradeLegacyCursorCore({})).toEqual({});
  expect(upgradeLegacyCursorCore({ coreKind: null })).toEqual({});
  expect(upgradeLegacyCursorCore({ coreKind: "unknown" })).toEqual({});
});
