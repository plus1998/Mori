import { expect, test } from "bun:test";
import path from "node:path";
import { ECO_IMAGE_VIEW_MCP_SERVER } from "@eco/runtime";
import { buildPiMcpSessionConfig, mergePiAppendSystemPrompt } from "../src/main/pi-mcp-session";
import { ECO_AGENT_BROWSER_MCP_SERVER } from "../src/shared/browser";
import { ECO_IMAGE_GENERATION_MCP_SERVER } from "../src/shared/image-generation";

test("buildPiMcpSessionConfig only includes Composer-selected servers", () => {
  const result = buildPiMcpSessionConfig({
    globalSdkConfig: {
      mcpServers: {
        github: { command: "uvx", args: ["mcp-github"] },
        slack: { command: "npx", args: ["slack-mcp"] },
      },
      allowedTools: ["mcp__github__*", "mcp__slack__*"],
    },
    enabledMcpServerKeys: ["github"],
    browserInject: { enabled: false },
    imageInject: { enabled: false },
  });
  expect(Object.keys(result.mcpServers)).toEqual(["github"]);
  expect(result.appendSystemPrompt).toEqual([]);
  expect(result.extraSkillDirectories).toEqual([]);
});

test("buildPiMcpSessionConfig merges browser and image integrations", () => {
  const result = buildPiMcpSessionConfig({
    globalSdkConfig: {
      mcpServers: {
        github: { command: "uvx", args: ["mcp-github"] },
      },
      allowedTools: [],
    },
    enabledMcpServerKeys: ["github"],
    browserInject: {
      enabled: true,
      sdkEntry: {
        type: "stdio",
        command: "/bin/node",
        args: ["browser.mjs"],
        env: { ECO_BROWSER_AUTH_TOKEN: "tok-a" },
      },
      promptAppend: "Use eco_agent_browser for this thread.",
    },
    computerUseInject: {
      enabled: true,
      sdkEntry: {
        type: "stdio",
        command: "/bin/open-computer-use",
        args: ["mcp"],
      },
      promptAppend: "Use eco_computer_use for desktop control.",
    },
    imageInject: {
      enabled: true,
      sdkEntry: {
        type: "stdio",
        command: "/bin/node",
        args: ["image.mjs"],
      },
      promptAppend: "Use eco_image_generation when asked.",
    },
    browserSkillDirectory: "/tmp/skills/eco-agent-browser",
  });
  expect(Object.keys(result.mcpServers).sort()).toEqual([
    ECO_AGENT_BROWSER_MCP_SERVER,
    "eco_computer_use",
    ECO_IMAGE_GENERATION_MCP_SERVER,
    "github",
  ]);
  expect(result.appendSystemPrompt).toEqual([
    "Use eco_agent_browser for this thread.",
    "Use eco_computer_use for desktop control.",
    "Use eco_image_generation when asked.",
  ]);
  expect(result.extraSkillDirectories).toEqual([path.resolve("/tmp/skills/eco-agent-browser")]);
});

test("buildPiMcpSessionConfig always merges imageViewInject even when Composer integrations are off", () => {
  const result = buildPiMcpSessionConfig({
    globalSdkConfig: {
      mcpServers: {
        github: { command: "uvx", args: ["mcp-github"] },
        [ECO_IMAGE_VIEW_MCP_SERVER]: { command: "user-override" },
      },
      allowedTools: [],
    },
    enabledMcpServerKeys: ["github", ECO_IMAGE_VIEW_MCP_SERVER],
    browserInject: { enabled: false },
    imageInject: { enabled: false },
    imageViewInject: {
      enabled: true,
      sdkEntry: {
        type: "stdio",
        command: "/bin/node",
        args: ["image-view.mjs"],
      },
      promptAppend: "Use eco_image_view with an absolute path.",
    },
  });
  expect(Object.keys(result.mcpServers).sort()).toEqual([ECO_IMAGE_VIEW_MCP_SERVER, "github"]);
  expect(result.mcpServers[ECO_IMAGE_VIEW_MCP_SERVER]).toMatchObject({
    type: "stdio",
    args: ["image-view.mjs"],
  });
  expect((result.mcpServers[ECO_IMAGE_VIEW_MCP_SERVER] as { command?: string }).command).not.toBe(
    "user-override",
  );
  expect(result.appendSystemPrompt).toEqual(["Use eco_image_view with an absolute path."]);
});

test("buildPiMcpSessionConfig isolates different browser tokens per call", () => {
  const base = {
    globalSdkConfig: { mcpServers: {}, allowedTools: [] as string[] },
    enabledMcpServerKeys: [] as string[],
    imageInject: { enabled: false as const },
  };
  const a = buildPiMcpSessionConfig({
    ...base,
    browserInject: {
      enabled: true,
      sdkEntry: {
        command: "node",
        args: ["b.mjs"],
        env: { ECO_BROWSER_AUTH_TOKEN: "token-a" },
      },
    },
  });
  const b = buildPiMcpSessionConfig({
    ...base,
    browserInject: {
      enabled: true,
      sdkEntry: {
        command: "node",
        args: ["b.mjs"],
        env: { ECO_BROWSER_AUTH_TOKEN: "token-b" },
      },
    },
  });
  const envA = (a.mcpServers[ECO_AGENT_BROWSER_MCP_SERVER] as { env?: Record<string, string> }).env;
  const envB = (b.mcpServers[ECO_AGENT_BROWSER_MCP_SERVER] as { env?: Record<string, string> }).env;
  expect(envA?.ECO_BROWSER_AUTH_TOKEN).toBe("token-a");
  expect(envB?.ECO_BROWSER_AUTH_TOKEN).toBe("token-b");
});

test("mergePiAppendSystemPrompt prepends trimmed global rules before integration append", () => {
  expect(
    mergePiAppendSystemPrompt({
      globalUserRules: "  Always reply in Chinese.  ",
      integrationAppend: ["Use eco_agent_browser for this thread."],
    }),
  ).toEqual(["Always reply in Chinese.", "Use eco_agent_browser for this thread."]);
});

test("mergePiAppendSystemPrompt omits blank global rules", () => {
  expect(
    mergePiAppendSystemPrompt({
      globalUserRules: "   ",
      integrationAppend: ["Use eco_agent_browser for this thread."],
    }),
  ).toEqual(["Use eco_agent_browser for this thread."]);
});

test("mergePiAppendSystemPrompt returns only global rules when integrations are empty", () => {
  expect(
    mergePiAppendSystemPrompt({
      globalUserRules: "Prefer small commits.",
      integrationAppend: ["", "  "],
    }),
  ).toEqual(["Prefer small commits."]);
});

test("TTS uses the session injection and never inherits an ambient speech server when disabled", () => {
  const base = {
    globalSdkConfig: { mcpServers: { eco_tts: { url: "https://ambient.example/mcp" } }, allowedTools: [] },
    enabledMcpServerKeys: ["eco_tts"],
    browserInject: { enabled: false },
    imageInject: { enabled: false },
  };
  const disabled = buildPiMcpSessionConfig({ ...base, ttsInject: { enabled: false } });
  expect(disabled.mcpServers).toEqual({});
  const enabled = buildPiMcpSessionConfig({ ...base, ttsInject: { enabled: true, sdkEntry: { type: "http", url: "http://127.0.0.1/session/mcp", headers: { Authorization: "Bearer thread-a" } }, promptAppend: "Choose voice and delivery style." } });
  expect(enabled.mcpServers.eco_tts).toMatchObject({ headers: { Authorization: "Bearer thread-a" } });
  expect(enabled.appendSystemPrompt).toEqual(["Choose voice and delivery style."]);
});
