import { expect, test } from "bun:test";
import {
  mergeBreakdownWithOccupancy,
  normalizeContextSegments,
  parseContextCommandHeader,
  parseContextCommandResult,
  parseSdkGetContextUsageBreakdown,
} from "../src/context-breakdown";
import {
  computeOccupancyRatio,
  computeWindowOccupancy,
  DEFAULT_AUTOCOMPACT_BUFFER,
  effectiveContextLimit,
  formatContextLimit,
  isGlobalContextWindowLimit,
  isGlobalMaxOutputTokens,
  lookupModelLimitsInCatalog,
  normalizeGlobalContextWindowLimit,
  normalizeGlobalMaxOutputTokens,
  occupancyPercent,
  resolveAppliedMaxOutputTokens,
  resolveDynamicMaxOutputTokens,
  resolveEffectiveContextLimit,
} from "../src/models-dev-limits";
import { parseModelsDevCatalog } from "../src/models-dev-pricing";

const mockCatalog = parseModelsDevCatalog({
  anthropic: {
    id: "anthropic",
    models: {
      "claude-sonnet-4-6": {
        id: "claude-sonnet-4-6",
        name: "Claude Sonnet 4.6",
        limit: { context: 200000, output: 64000 },
        cost: { input: 3, output: 15 },
      },
    },
  },
});

test("lookupModelLimitsInCatalog exact match", () => {
  const result = lookupModelLimitsInCatalog(mockCatalog, "anthropic", "claude-sonnet-4-6");
  expect(result?.limits.contextTokens).toBe(200000);
  expect(result?.limits.maxOutputTokens).toBe(64000);
});

test("formatContextLimit compacts token counts", () => {
  expect(formatContextLimit(200_000)).toBe("200K");
  expect(formatContextLimit(1_000_000)).toBe("1.0M");
});

test("computeWindowOccupancy uses input and cache only", () => {
  expect(
    computeWindowOccupancy({
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 200,
      cacheCreationTokens: 100,
    }),
  ).toBe(1300);
});

test("computeWindowOccupancy dedupes OpenAI-compat total plus cache subset", () => {
  expect(
    computeWindowOccupancy({
      inputTokens: 24_748,
      outputTokens: 20,
      cacheReadTokens: 24_588,
      cacheCreationTokens: 0,
    }),
  ).toBe(24_748);
});

test("computeWindowOccupancy dedupes newapi-style total with small uncached tail", () => {
  expect(
    computeWindowOccupancy({
      inputTokens: 3790,
      outputTokens: 20,
      cacheReadTokens: 3677,
      cacheCreationTokens: 0,
    }),
  ).toBe(3790);
});

test("computeWindowOccupancy keeps Anthropic separate input and cache counts", () => {
  expect(
    computeWindowOccupancy({
      inputTokens: 5000,
      outputTokens: 20,
      cacheReadTokens: 3000,
      cacheCreationTokens: 0,
    }),
  ).toBe(8000);
});

test("computeOccupancyRatio at threshold", () => {
  const { atThreshold } = computeOccupancyRatio(170_000, 200_000, 0.85);
  expect(atThreshold).toBe(true);
});

test("occupancyPercent caps at 100", () => {
  expect(occupancyPercent(250_000, 200_000)).toBe(100);
});

test("parseContextCommandResult parses labeled lines", () => {
  const segments = parseContextCommandResult(`
System prompt: 461 tokens
Tool definitions: 8.3K
Conversation: 42.8K
`);
  expect(segments.find((s) => s.key === "systemPrompt")?.tokens).toBe(461);
  expect(segments.find((s) => s.key === "toolDefinitions")?.tokens).toBe(8300);
  expect(segments.find((s) => s.key === "conversation")?.tokens).toBe(42800);
});

test("parseContextCommandResult maps Claude and Cursor style categories", () => {
  const segments = parseContextCommandResult(`
Messages: 10K
MCP tools: 2K
Memory files: 500
Subagents: 1.2K
Custom extension: 300
Total: 14K
`);
  expect(segments.find((s) => s.key === "conversation")?.tokens).toBe(10_000);
  expect(segments.find((s) => s.key === "mcp")?.tokens).toBe(2000);
  expect(segments.find((s) => s.key === "rules")?.tokens).toBe(500);
  expect(segments.find((s) => s.key === "subagentDefinitions")?.tokens).toBe(1200);
  expect(segments.find((s) => s.key === "unattributed")?.tokens).toBe(300);
});

test("parseContextCommandResult fallback conversation", () => {
  const segments = parseContextCommandResult("no structured data", 50_000);
  expect(segments).toHaveLength(1);
  expect(segments[0]?.key).toBe("conversation");
  expect(segments[0]?.tokens).toBe(50_000);
});

test("parseContextCommandResult maps Chinese session usage labels", () => {
  const segments = parseContextCommandResult(`会话占用 | 87k\n其他占用 | 9k`);
  expect(segments.find((s) => s.key === "conversation")).toMatchObject({
    label: "会话",
    tokens: 87_000,
  });
  expect(segments.find((s) => s.key === "unattributed")).toMatchObject({
    label: "其他",
    tokens: 9_000,
  });
});

test("normalizeContextSegments refreshes stale labels", () => {
  const segments = normalizeContextSegments([
    { key: "conversation", label: "会话占用", tokens: 87_000, color: "#ea580c" },
    { key: "unattributed", label: "其他占用", tokens: 9_000, color: "#78716c" },
  ]);
  expect(segments).toEqual([
    { key: "conversation", label: "会话", tokens: 87_000, color: "#ea580c" },
    { key: "unattributed", label: "其他", tokens: 9_000, color: "#78716c" },
  ]);
});

test("mergeBreakdownWithOccupancy adds unattributed gap", () => {
  const segments = mergeBreakdownWithOccupancy(
    [{ key: "conversation", label: "会话", tokens: 520_000, color: "#ea580c" }],
    840_000,
  );
  expect(segments.find((s) => s.key === "unattributed")?.tokens).toBe(320_000);
  expect(segments.find((s) => s.key === "unattributed")?.label).toBe("其他");
});

test("mergeBreakdownWithOccupancy merges gap into existing unattributed", () => {
  const segments = mergeBreakdownWithOccupancy(
    [
      { key: "conversation", label: "会话", tokens: 520_000, color: "#ea580c" },
      { key: "unattributed", label: "其他", tokens: 300, color: "#78716c" },
    ],
    840_000,
  );
  expect(segments.filter((s) => s.key === "unattributed")).toHaveLength(1);
  expect(segments.find((s) => s.key === "unattributed")?.tokens).toBe(320_000);
});

test("parseContextCommandHeader parses Claude Code summary line", () => {
  const header = parseContextCommandHeader(`
claude-sonnet-4-20250514 · 76k/200k tokens (38%)
System prompt: 2.7k tokens
`);
  expect(header).toEqual({ occupied: 76_000, limit: 200_000, occupancyPct: 38 });
});

test("parseContextCommandHeader parses compact numeric forms", () => {
  const header = parseContextCommandHeader("gpt-5.5 · 17k/1.1M tokens (2%)");
  expect(header?.occupied).toBe(17_000);
  expect(header?.limit).toBe(1_100_000);
  expect(header?.occupancyPct).toBe(2);
});

test("parseSdkGetContextUsageBreakdown maps SDK categories", () => {
  const parsed = parseSdkGetContextUsageBreakdown({
    totalTokens: 64_700,
    maxTokens: 200_000,
    percentage: 32,
    model: "eco-planner",
    categories: [
      { name: "System prompt", tokens: 12_500, color: "#aaa" },
      { name: "Messages", tokens: 50_000, color: "#bbb" },
    ],
  });
  expect(parsed?.occupied).toBe(64_700);
  expect(parsed?.limit).toBe(200_000);
  expect(parsed?.occupancyPct).toBe(32);
  const segmentSum = parsed?.segments.reduce((sum, segment) => sum + segment.tokens, 0) ?? 0;
  expect(segmentSum).toBe(64_700);
});

test("parseSdkGetContextUsageBreakdown skips deferred sizes and uses messageBreakdown", () => {
  const parsed = parseSdkGetContextUsageBreakdown({
    totalTokens: 31_528,
    maxTokens: 200_000,
    percentage: 16,
    categories: [
      { name: "System prompt", tokens: 409_864, color: "#aaa" },
      { name: "Messages", tokens: 31_528, color: "#bbb" },
      { name: "Free space", tokens: 0, color: "#ccc" },
    ],
    messageBreakdown: {
      userMessageTokens: 2098,
      assistantMessageTokens: 270,
      toolCallTokens: 28,
      toolResultTokens: 42,
      attachmentTokens: 1672,
      unattributedTokens: 27_418,
      toolCallsByType: [{ name: "WebSearch", callTokens: 28, resultTokens: 42 }],
      attachmentsByType: [{ name: "skill_listing", tokens: 1672 }],
    },
  });
  expect(parsed?.occupied).toBe(31_528);
  expect(parsed?.segments.reduce((sum, segment) => sum + segment.tokens, 0)).toBe(31_528);
  expect(parsed?.segments.find((segment) => segment.label === "用户消息")?.tokens).toBe(2098);
  expect(parsed?.segments.find((segment) => segment.label === "未归因上下文")?.tokens).toBe(27_418);
  expect(parsed?.segments.some((segment) => segment.label.startsWith("工具 ·"))).toBe(true);
});

test("effectiveContextLimit deducts autocompact buffer and output reserve", () => {
  expect(effectiveContextLimit(200_000)).toBe(200_000 - DEFAULT_AUTOCOMPACT_BUFFER - 20_000);
  expect(effectiveContextLimit(200_000, 8_000)).toBe(200_000 - DEFAULT_AUTOCOMPACT_BUFFER - 8_000);
  expect(effectiveContextLimit(40_000)).toBe(20_000);
});

test("resolveEffectiveContextLimit caps large models and preserves smaller models", () => {
  expect(resolveEffectiveContextLimit(1_000_000, 262_144)).toBe(262_144);
  expect(resolveEffectiveContextLimit(200_000, 262_144)).toBe(200_000);
  expect(resolveEffectiveContextLimit(128_000, 1_048_576)).toBe(128_000);
  expect(resolveEffectiveContextLimit(0, 262_144)).toBe(200_000);
});

test("resolveAppliedMaxOutputTokens clamps model and defaults to global 32K", () => {
  expect(
    resolveAppliedMaxOutputTokens({
      modelMaxOutputTokens: 384_000,
      globalMaxOutputTokens: 32_000,
    }),
  ).toBe(32_000);
  expect(resolveAppliedMaxOutputTokens({})).toBe(32_768);
  expect(
    resolveAppliedMaxOutputTokens({
      modelMaxOutputTokens: 64_000,
      globalMaxOutputTokens: 128_000,
      contextTokens: 50_000,
    }),
  ).toBe(49_999);
  expect(
    resolveAppliedMaxOutputTokens({
      modelMaxOutputTokens: 8_192,
      globalMaxOutputTokens: 32_000,
    }),
  ).toBe(8_192);
  expect(normalizeGlobalMaxOutputTokens(300_000)).toBe(262_144);
  expect(normalizeGlobalMaxOutputTokens(2_000)).toBe(8_192);
  expect(isGlobalMaxOutputTokens(32_000)).toBe(true);
  expect(isGlobalMaxOutputTokens(30_000)).toBe(true);
  expect(isGlobalMaxOutputTokens(262_144)).toBe(true);
  expect(isGlobalMaxOutputTokens(1_500_000)).toBe(false);
});

test("normalizeGlobalContextWindowLimit clamps and snaps to step", () => {
  expect(normalizeGlobalContextWindowLimit(262_144)).toBe(262_144);
  expect(normalizeGlobalContextWindowLimit(262_400)).toBe(262_144);
  expect(normalizeGlobalContextWindowLimit(2_000_000)).toBe(1_048_576);
  expect(normalizeGlobalContextWindowLimit(4_000)).toBe(32_768);
  expect(isGlobalContextWindowLimit(150_000)).toBe(true);
  expect(isGlobalContextWindowLimit(2_000_000)).toBe(false);
  expect(isGlobalContextWindowLimit(4_000)).toBe(false);
});

test("dynamic output follows the effective window and model output limit", () => {
  expect(normalizeGlobalMaxOutputTokens(undefined)).toBe("dynamic");
  expect(isGlobalMaxOutputTokens("dynamic")).toBe(true);
  expect(isGlobalMaxOutputTokens("auto")).toBe(false);
  for (const [contextTokens, expected] of [
    [32_768, 32_767],
    [65_536, 65_535],
    [200_000, 199_999],
    [1_048_576, 1_048_575],
  ]) {
    expect(resolveAppliedMaxOutputTokens({ globalMaxOutputTokens: "dynamic", contextTokens })).toBe(expected);
  }
  expect(
    resolveAppliedMaxOutputTokens({
      globalMaxOutputTokens: "dynamic",
      contextTokens: 200_000,
      modelMaxOutputTokens: 4_096,
    }),
  ).toBe(4_096);
  expect(
    resolveAppliedMaxOutputTokens({
      globalMaxOutputTokens: "dynamic",
      contextTokens: resolveEffectiveContextLimit(1_000_000, 32_768),
    }),
  ).toBe(32_767);
  expect(() => resolveAppliedMaxOutputTokens({ globalMaxOutputTokens: "dynamic" })).toThrow(
    "resolved context window",
  );
});

test("dynamic output subtracts this request input and rejects exhausted windows", () => {
  for (const window of [8_000, 32_768, 40_000, 65_536, 200_000, 1_048_576]) {
    for (const input of [0, 100, Math.floor(window / 2), window - 2]) {
      const output = resolveDynamicMaxOutputTokens(window, input);
      expect(output).toBe(window - input - 1);
      expect(input + output).toBeLessThan(window);
    }
    for (const input of [window - 1, window, window + 1]) {
      expect(() => resolveDynamicMaxOutputTokens(window, input)).toThrow("Context window exhausted");
    }
  }
  for (const input of [-1, NaN, Infinity, 0.5]) {
    expect(() => resolveDynamicMaxOutputTokens(32_768, input)).toThrow("current input token count");
  }
});
