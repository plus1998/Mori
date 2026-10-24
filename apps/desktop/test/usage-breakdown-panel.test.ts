import { expect, test } from "bun:test";
import {
  buildLedgerEventSummary,
  formatLedgerEventProviderModel,
  formatLedgerEventTime,
  formatUsageBreakdownAgentLabel,
  resolveEventsSummaryPopoverPosition,
} from "../src/renderer/UsageBreakdownPanel";
import type { ThreadUsageLedgerEventView } from "../src/shared/ipc";

test("formatUsageBreakdownAgentLabel uses runtime agent names with instance id", () => {
  expect(
    formatUsageBreakdownAgentLabel("researcher", "agent_researcher_123456789", {
      researcher: "Research Lead",
    }),
  ).toBe("Research Lead · #23456789");
});

test("formatUsageBreakdownAgentLabel falls back to role labels", () => {
  expect(formatUsageBreakdownAgentLabel("coder", "agent_coder_123456789")).toBe("编程 · #23456789");
  expect(formatUsageBreakdownAgentLabel("vision", "vision:thread:abcdef12")).toBe("视觉理解 · #abcdef12");
});

test("formatLedgerEventTime ignores invalid timestamps", () => {
  expect(formatLedgerEventTime("not-a-date")).toBe("");
});

test("formatLedgerEventProviderModel prefers the provider's resolved model over an alias", () => {
  expect(
    formatLedgerEventProviderModel({
      providerId: "anthropic",
      modelId: "claude-sonnet-4-6",
      aliasModelId: "eco_coder__abc123",
    }),
  ).toEqual({
    providerLabel: "anthropic",
    modelLabel: "Sonnet 4.6",
    title: "anthropic / claude-sonnet-4-6",
  });
  expect(
    formatLedgerEventProviderModel({
      aliasModelId: "eco_coder__abc123",
    }),
  ).toEqual({
    modelLabel: "Eco_coder__abc123",
    title: "eco_coder__abc123",
  });
  expect(
    formatLedgerEventProviderModel({
      modelId: "openai/gpt-5.6-sol",
    }),
  ).toEqual({
    providerLabel: "openai",
    modelLabel: "5.6 Sol",
    title: "openai / gpt-5.6-sol",
  });
  expect(
    formatLedgerEventProviderModel({
      providerId: "codex-whtqjz",
      modelId: "gpt-5.6-sol",
    }),
  ).toEqual({
    modelLabel: "5.6 Sol",
    title: "gpt-5.6-sol",
  });
});

test("buildLedgerEventSummary preserves the primary event token summary", () => {
  const event: ThreadUsageLedgerEventView = {
    id: "event_1",
    source: "proxy",
    role: "coder",
    routeRole: "coder",
    billingRole: "coder",
    attributionStatus: "attributed",
    usageKind: "request_final",
    inputTokens: 1200,
    outputTokens: 300,
    cacheReadTokens: 500,
    cacheCreationTokens: 0,
    observedAt: "2026-07-29T08:00:00.000Z",
  };

  const summary = buildLedgerEventSummary([event]);
  expect(summary?.tokensMatch).toBe(true);
  expect(summary?.text).toContain("↑1k");
  expect(summary?.text).toContain("↓300");
  expect(summary?.text).toContain("⊙500");
});

test("resolveEventsSummaryPopoverPosition keeps the portal inside the viewport", () => {
  expect(resolveEventsSummaryPopoverPosition({ top: 20, bottom: 40, right: 360 }, 400)).toEqual({
    top: 46,
    left: 80,
    width: 280,
  });

  expect(resolveEventsSummaryPopoverPosition({ top: 20, bottom: 40, right: 24 }, 240)).toEqual({
    top: 46,
    left: 8,
    width: 224,
  });
});
