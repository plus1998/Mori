import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createProxyBridgeSettingsStore,
  defaultProxyBridgeSettings,
  isProxyBridgeSettingsSnapshot,
  normalizeProxyBridgeSettingsSnapshot,
  resolveUpstreamUserAgentOverride,
  resolveUpstreamUserAgentOverrides,
} from "../src/main/proxy-bridge-settings-store";

const sqliteAvailable = await (async () => {
  try {
    await import("node:sqlite");
    return true;
  } catch {
    return false;
  }
})();

test("defaultProxyBridgeSettings is empty", () => {
  expect(defaultProxyBridgeSettings()).toEqual({});
});

test("normalizeProxyBridgeSettingsSnapshot trims and drops empty", () => {
  expect(normalizeProxyBridgeSettingsSnapshot({ upstreamUserAgent: "  my-ua  " })).toEqual({
    upstreamUserAgent: "my-ua",
  });
  expect(normalizeProxyBridgeSettingsSnapshot({ upstreamUserAgent: "   " })).toEqual({});
});

test("normalizeProxyBridgeSettingsSnapshot rejects newlines", () => {
  expect(() => normalizeProxyBridgeSettingsSnapshot({ upstreamUserAgent: "a\nb" })).toThrow(/换行/);
});

test("resolveUpstreamUserAgentOverride returns undefined when unset", () => {
  expect(resolveUpstreamUserAgentOverride({})).toBeUndefined();
  expect(resolveUpstreamUserAgentOverride({ upstreamUserAgent: "x" })).toBe("x");
});

test("normalizeProxyBridgeSettingsSnapshot keeps trimmed per-core User-Agents", () => {
  expect(
    normalizeProxyBridgeSettingsSnapshot({
      upstreamUserAgents: { codex: "  codex-sdk/1  ", claude: "   ", pi: "pi-ua/1" },
    }),
  ).toEqual({ upstreamUserAgents: { codex: "codex-sdk/1", pi: "pi-ua/1" } });
});

test("normalizeProxyBridgeSettingsSnapshot drops unknown cores and empty maps", () => {
  expect(
    normalizeProxyBridgeSettingsSnapshot({
      upstreamUserAgents: { cursor: "cursor-ua/1", claude: "" },
    }),
  ).toEqual({});
  expect(normalizeProxyBridgeSettingsSnapshot({ upstreamUserAgents: "nope" })).toEqual({});
});

test("per-core User-Agents reject newlines and overlong values", () => {
  expect(() => normalizeProxyBridgeSettingsSnapshot({ upstreamUserAgents: { pi: "a\nb" } })).toThrow(/换行/);
  expect(() =>
    normalizeProxyBridgeSettingsSnapshot({ upstreamUserAgents: { codex: "x".repeat(600) } }),
  ).toThrow(/512/);
});

test("resolveUpstreamUserAgentOverrides drops cleared cores", () => {
  expect(resolveUpstreamUserAgentOverrides({})).toBeUndefined();
  expect(resolveUpstreamUserAgentOverrides({ upstreamUserAgents: { pi: "  " } })).toBeUndefined();
  expect(resolveUpstreamUserAgentOverrides({ upstreamUserAgents: { codex: " c ", pi: " p " } })).toEqual({
    codex: "c",
    pi: "p",
  });
});

test("isProxyBridgeSettingsSnapshot validates the per-core map", () => {
  expect(isProxyBridgeSettingsSnapshot({ upstreamUserAgents: { codex: "a" } })).toBe(true);
  expect(isProxyBridgeSettingsSnapshot({ upstreamUserAgents: {} })).toBe(true);
  expect(isProxyBridgeSettingsSnapshot({ upstreamUserAgents: { codex: 1 } })).toBe(false);
  expect(isProxyBridgeSettingsSnapshot({ upstreamUserAgents: "nope" })).toBe(false);
});

test.skipIf(!sqliteAvailable)("proxy bridge settings persist round-trip", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eco-proxy-bridge-"));
  const store = await createProxyBridgeSettingsStore(path.join(dir, "eco.sqlite"));

  expect(store.get()).toEqual({});

  store.save({ upstreamUserAgent: "gateway/1" });
  expect(store.get()).toEqual({ upstreamUserAgent: "gateway/1" });

  store.save({ upstreamUserAgents: { codex: "codex/1", pi: "pi/1" } });
  expect(store.get()).toEqual({ upstreamUserAgents: { codex: "codex/1", pi: "pi/1" } });

  store.save({});
  expect(store.get()).toEqual({});
});
