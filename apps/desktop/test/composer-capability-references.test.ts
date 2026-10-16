import { expect, test } from "bun:test";
import {
  buildComposerCapabilityReferences,
  filterComposerCapabilityReferences,
} from "../src/shared/composer-capability-references";
import {
  composerReferences,
  composerReferenceToken,
  parseMentionQuery,
} from "../src/shared/composer-references";
import { parsePromptSegments } from "../src/renderer/composer-skills";

function capabilities() {
  return buildComposerCapabilityReferences({
    availability: {
      integrations: [
        { id: "browser", enabled: true, available: true },
        { id: "imageGeneration", enabled: true, available: true, activeProfileName: "Gemini" },
        { id: "tts", enabled: true, available: false },
        { id: "computerUse", enabled: false, available: true },
      ],
    },
    integrationsEnabled: { browser: true, imageGeneration: true, tts: true, computerUse: true },
    integrationLabels: { browser: "Browser", imageGeneration: "Creative drawing" },
    mcpServers: [
      { id: "mysql", name: "My SQL", enabled: true, transport: "stdio" },
      { id: "mongo", name: "Mongo", enabled: true, transport: "http" },
      { id: "redis", name: "Redis", enabled: false, transport: "stdio" },
      { id: "off", name: "Session off", enabled: true, transport: "stdio" },
    ],
    mcpServersEnabled: { "my-sql": true, mongo: true, redis: true, "session-off": false },
    agents: [
      { agentKey: "coder", name: "编码", modelId: "gpt-5", enabled: true },
      { agentKey: "reviewer", name: "审查", modelId: "gpt-5", enabled: false },
      { agentKey: "custom", name: "未配置", modelId: "", enabled: true },
    ],
  });
}

test("capability picker includes only globally available and session-enabled services and configured agents", () => {
  expect(capabilities().map((item) => `${item.kind}:${item.id}`)).toEqual([
    "integration:browser",
    "integration:imageGeneration",
    "subagent:coder",
    "mcp:mysql",
    "mcp:mongo",
  ]);
  expect(capabilities()[0]).toMatchObject({ detail: "", server: "eco_agent_browser" });
});

test("Chinese aliases work in English UI; category prefixes select integrations, MCP and subagents", () => {
  for (const [text, ids] of [
    ["@浏览器", ["browser"]],
    ["@创意绘画", ["imageGeneration"]],
    ["@MCP：Mongo", ["mongo"]],
    ["@子代理", ["coder"]],
    ["@集成", ["browser", "imageGeneration"]],
  ] as const) {
    const query = parseMentionQuery(text, text.length)!;
    expect(filterComposerCapabilityReferences(capabilities(), query).map((item) => item.id)).toEqual([
      ...ids,
    ]);
  }
});

test("new reference tokens round-trip as atomic prompt segments without leaking capability config", () => {
  for (const { kind, id, label, detail } of capabilities()) {
    const reference = { kind, id, label, detail };
    const token = composerReferenceToken(reference);
    expect(composerReferences(token)).toEqual([reference]);
    expect(parsePromptSegments(token)).toEqual([{ type: "reference", reference }]);
  }
});
