import { describe, expect, test } from "bun:test";
import { assertCodexLoginSubagentPolicy, isCodexLoginProvider } from "../src/shared/codex-login-subagent-policy";
import type { AgentInstanceConfig } from "../src/shared/agent-orchestration";
import type { RuntimeRoleRouteConfig } from "../src/shared/ipc";

const login = (providerId: string) => providerId === "openai";
const agent = (providerId: string, enabled = true): AgentInstanceConfig => ({
  agentKey: "reviewer", displayName: "审查员", templateId: "reviewer",
  enabled, modelRef: { providerId, modelId: "model" },
  tools: { allowed: [], disallowed: [] }, mcpServers: [], skills: [],
});
const route = (role: string, providerId: string): RuntimeRoleRouteConfig => ({ role, providerId, modelId: "model" });
const validate = (coreKind: string, main: string, subagent = agent("openai"), isCodexLoginProvider = login) =>
  assertCodexLoginSubagentPolicy({ coreKind, snapshot: { agents: [subagent] }, routes: [route("main", main), route("reviewer", subagent.modelRef.providerId)], isCodexLoginProvider });

describe("Codex Login subagent policy", () => {
  test("distinguishes built-in Login from a custom OpenAI API key provider", () => {
    expect(isCodexLoginProvider("openai", [])).toBe(true);
    expect(isCodexLoginProvider("eco-coding-chatgpt", [])).toBe(false);
    const provider = { id: "openai", authMethod: "api_key", hasApiKey: true } as import("../src/shared/ipc").ProviderConfigView;
    expect(isCodexLoginProvider("openai", [provider])).toBe(false);
    expect(isCodexLoginProvider("openai", [{ ...provider, authMethod: "auth_json", hasApiKey: false }])).toBe(true);
  });
  test("only a Codex Login main may use a Login subagent", () => {
    expect(() => validate("codex", "openai")).not.toThrow();
    for (const [core, main] of [["codex", "api"], ["codex", "eco-coding-chatgpt"], ["pi", "openai"], ["claude", "api"]]) {
      expect(() => validate(core!, main!)).toThrow("审查员");
    }
  });
  test("allows disabled Login agents and ordinary providers", () => {
    expect(() => validate("pi", "api", agent("openai", false))).not.toThrow();
    expect(() => validate("pi", "api", agent("eco-coding-chatgpt"))).not.toThrow();
    expect(() => validate("pi", "api", agent("openai"), () => false)).not.toThrow();
  });
  test("checks effective routes instead of only snapshot model refs", () => {
    expect(() => assertCodexLoginSubagentPolicy({ coreKind: "codex", snapshot: { agents: [agent("openai")] }, routes: [route("main", "api"), route("reviewer", "openai")], isCodexLoginProvider: login })).toThrow("Codex Login");
    expect(() => assertCodexLoginSubagentPolicy({ coreKind: "pi", snapshot: { agents: [agent("api")] }, routes: [route("main", "api"), route("reviewer", "openai")], isCodexLoginProvider: login })).toThrow("Codex Login");
  });
});
