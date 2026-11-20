import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spillOrTruncateMcpToolOutput } from "../src/codex-mcp-output-spill";
import {
  assertCodexGatedModelApiCompat,
  isCodexGatedOptionalModelId,
} from "../src/codex-gated-models";

test("spillOrTruncateMcpToolOutput writes artifact when over budget", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eco-mcp-spill-"));
  try {
    const big = "x".repeat(80_000);
    const result = await spillOrTruncateMcpToolOutput({
      text: big,
      spillDir: dir,
      serverName: "mori_agent_browser",
      toolName: "snapshot",
      tokenLimit: 100,
    });
    expect(result.spilled).toBe(true);
    expect(result.truncated).toBe(true);
    expect(result.artifactPath).toBeTruthy();
    expect(result.text).toContain("spilled to artifact");
    expect(result.text).toContain(result.artifactPath!);
    const stored = await fs.readFile(result.artifactPath!, "utf8");
    expect(stored).toBe(big);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("spillOrTruncateMcpToolOutput leaves small payloads untouched", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eco-mcp-spill-"));
  try {
    const result = await spillOrTruncateMcpToolOutput({
      text: "ok",
      spillDir: dir,
      serverName: "mori_agent_browser",
      toolName: "get_url",
      tokenLimit: 1000,
    });
    expect(result).toEqual({
      text: "ok",
      truncated: false,
      spilled: false,
      originalTokenCount: 1,
    });
    expect(await fs.readdir(dir)).toEqual([]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("gated Astra models require openai_responses and are detected by id", () => {
  expect(isCodexGatedOptionalModelId("gpt-6-astra")).toBe(true);
  expect(isCodexGatedOptionalModelId("gpt-6-astra-fast")).toBe(true);
  expect(isCodexGatedOptionalModelId("gpt-5.6-luna")).toBe(false);
  expect(() =>
    assertCodexGatedModelApiCompat({
      modelId: "gpt-6-astra",
      apiCompat: "openai_chat_completions",
    }),
  ).toThrow(/openai_responses/);
  expect(() =>
    assertCodexGatedModelApiCompat({
      modelId: "gpt-6-astra",
      apiCompat: "openai_responses",
    }),
  ).not.toThrow();
});
