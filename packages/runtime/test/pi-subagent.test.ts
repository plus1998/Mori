import { expect, test } from "bun:test";
import type { EcoAgentRuntimeConfig } from "../src/agent-orchestration";
import { PI_CORE_CAPABILITIES } from "../src/core-runtime";
import { PI_MCP_HUB_TOOL_NAMES } from "../src/pi-mcp";
import { resolvePiRouteByRole } from "../src/pi-model-bridge";
import {
  collectPiSubagentFinalText,
  filterMcpServersForPiSubagent,
  listEnabledPiSubagents,
  PI_AGENT_TOOL_NAME,
  piChildSessionKey,
  piParentSessionKey,
  resolvePiSubagentToolAllowlist,
  truncatePiSubagentResult,
} from "../src/pi-subagent";

function sampleRegistry(enabled: boolean): EcoAgentRuntimeConfig {
  return {
    templates: [
      {
        id: "builtin.coding.explore",
        name: "Explore",
        description: "Find code",
        prompt: "Explore the codebase.",
        whenToUse: "When locating files",
        defaultTools: {
          allowed: [],
          disallowed: [],
          bash: { enabled: false },
          filesystem: { read: "workspace", write: "none" },
        },
        mcpServers: [],
        skills: [],
        allowDelegation: false,
        builtIn: true,
        source: "built_in",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "builtin.coding.coder",
        name: "Coder",
        description: "Implement changes",
        prompt: "Implement the task.",
        whenToUse: "When writing code",
        defaultTools: {
          allowed: [],
          disallowed: [],
          bash: { enabled: true },
          filesystem: { read: "workspace", write: "workspace" },
        },
        mcpServers: [],
        skills: [],
        allowDelegation: false,
        builtIn: true,
        source: "built_in",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
    orchestration: {
      mainAgent: {
        agentKey: "main",
        name: "Main",
        systemPromptPreset: "core_native",
        prompt: "",
        modelRef: { providerId: "p1", modelId: "m1" },
        tools: { allowed: [], disallowed: [] },
        skills: [],
      },
      agents: [
        {
          agentKey: "explore",
          templateId: "builtin.coding.explore",
          modelRef: { providerId: "p1", modelId: "fast" },
          tools: {
            allowed: [],
            disallowed: [],
            bash: { enabled: false },
            filesystem: { read: "workspace", write: "none" },
          },
          mcpServers: [],
          skills: [],
          enabled,
        },
        {
          agentKey: "coder",
          templateId: "builtin.coding.coder",
          modelRef: { providerId: "p2", modelId: "strong" },
          tools: {
            allowed: [],
            disallowed: [],
            bash: { enabled: true },
            filesystem: { read: "workspace", write: "workspace" },
          },
          mcpServers: ["browser"],
          skills: [],
          enabled,
        },
      ],
      strategy: { kind: "autonomous" },
    },
  };
}

test("listEnabledPiSubagents returns only enabled non-planner agents", () => {
  expect(listEnabledPiSubagents(undefined)).toEqual([]);
  expect(listEnabledPiSubagents(sampleRegistry(false))).toEqual([]);
  const enabled = listEnabledPiSubagents(sampleRegistry(true));
  expect(enabled.map((agent) => agent.agentKey)).toEqual(["explore", "coder"]);
  expect(enabled[0]?.modelRef.modelId).toBe("fast");
  expect(enabled[1]?.modelRef.providerId).toBe("p2");
});

test("resolvePiSubagentToolAllowlist never includes Agent and respects policy", () => {
  const readOnly = resolvePiSubagentToolAllowlist(
    {
      allowed: [],
      disallowed: [],
      bash: { enabled: false },
      filesystem: { read: "workspace", write: "none" },
    },
    false,
  );
  // codemode mirrors Agent mode: a script may batch the tools this subagent was
  // already granted, but never delegate.
  expect(readOnly).toEqual(["read", "codemode"]);
  expect(readOnly).not.toContain(PI_AGENT_TOOL_NAME);

  const fullTools = resolvePiSubagentToolAllowlist(
    {
      allowed: [],
      disallowed: [],
      bash: { enabled: true },
      filesystem: { read: "workspace", write: "workspace" },
    },
    true,
  );
  // The Hub tool wire names come from the official PI MCP extension
  // (`mcp__<server>__<tool>`); PI 1.0.3 has no `mcp` / `mcpScript` proxy tools.
  expect(fullTools).toEqual(["read", "edit", "write", "bash", ...PI_MCP_HUB_TOOL_NAMES, "codemode"]);
  expect(fullTools).not.toContain(PI_AGENT_TOOL_NAME);
});

test("resolvePiSubagentToolAllowlist includes web_search when backend is armed", () => {
  expect(
    resolvePiSubagentToolAllowlist(
      {
        allowed: [],
        disallowed: [],
        bash: { enabled: true },
        filesystem: { read: "workspace", write: "workspace" },
        network: { webSearch: true, webFetch: false },
      },
      false,
      { webSearchBackend: "native" },
    ),
  ).toContain("web_search");
});

test("truncatePiSubagentResult keeps short text and marks long text truncated", () => {
  expect(truncatePiSubagentResult("hello")).toEqual({ text: "hello", truncated: false });
  const long = Array.from({ length: 2500 }, (_, index) => `line-${index}`).join("\n");
  const result = truncatePiSubagentResult(long);
  expect(result.truncated).toBe(true);
  expect(result.text).toContain("[truncated:");
  expect(result.text.split("\n").length).toBeLessThan(long.split("\n").length);
});

test("session keys isolate parent and child slots", () => {
  expect(piParentSessionKey("thr_1")).toBe("thr_1");
  expect(piChildSessionKey("thr_1", "pi_coder_abc")).toBe("thr_1::sub::pi_coder_abc");
});

test("filterMcpServersForPiSubagent only keeps assigned servers", () => {
  expect(
    filterMcpServersForPiSubagent({ browser: { command: "x" }, other: { command: "y" } }, ["browser"]),
  ).toEqual({ browser: { command: "x" } });
  expect(filterMcpServersForPiSubagent({ browser: { command: "x" } }, [])).toBeUndefined();
});

test("PI_CORE_CAPABILITIES marks subagents as eco", () => {
  expect(PI_CORE_CAPABILITIES.subagents).toBe("eco");
  expect(PI_CORE_CAPABILITIES.mcp).toBe("eco");
  expect(PI_CORE_CAPABILITIES.skills).toBe("eco");
  expect(PI_CORE_CAPABILITIES.toolApproval).toBe("eco");
  expect(PI_CORE_CAPABILITIES.planApproval).toBe("eco");
  expect(PI_CORE_CAPABILITIES.sessionModes).toEqual(["agent", "plan", "ask"]);
});

test("resolvePiRouteByRole never falls back to planner", () => {
  const routes = [
    {
      role: "main",
      primary: { providerId: "p1", modelId: "m1" },
      fallbacks: [],
    },
    {
      role: "coder",
      primary: { providerId: "p2", modelId: "m2" },
      fallbacks: [],
    },
  ] as const;
  expect(resolvePiRouteByRole(routes as never, "coder")?.primary.modelId).toBe("m2");
  expect(resolvePiRouteByRole(routes as never, "explore")).toBeUndefined();
  expect(resolvePiRouteByRole(routes as never, "main")?.primary.modelId).toBe("m1");
});

test("parent tools allowlist must include Agent when eco-pi-agent is loaded", () => {
  // Documents PI SDK contract: options.tools is an allowlist; extension tools
  // omitted here are stripped in AgentSession._refreshToolRegistry.
  const base = ["read", "bash", "edit", "write", "mcp", "mcpScript"];
  const withAgent = base.includes(PI_AGENT_TOOL_NAME) ? base : [...base, PI_AGENT_TOOL_NAME];
  expect(withAgent).toContain(PI_AGENT_TOOL_NAME);
  expect(PI_AGENT_TOOL_NAME).toBe("Agent");
});

test("collectPiSubagentFinalText joins text deltas and skips thinking", () => {
  const text = collectPiSubagentFinalText([
    {
      id: "1",
      threadId: "t",
      agentId: "a",
      role: "coder",
      type: "message.delta",
      timestamp: "2026-01-01T00:00:00.000Z",
      payload: { type: "eco_stream", blockKind: "thinking", text: "secret" },
    },
    {
      id: "2",
      threadId: "t",
      agentId: "a",
      role: "coder",
      type: "message.delta",
      timestamp: "2026-01-01T00:00:00.000Z",
      payload: { type: "eco_stream", blockKind: "text", text: "hello " },
    },
    {
      id: "3",
      threadId: "t",
      agentId: "a",
      role: "coder",
      type: "message.delta",
      timestamp: "2026-01-01T00:00:00.000Z",
      payload: { type: "eco_stream", blockKind: "text", text: "world" },
    },
    {
      id: "4",
      threadId: "t",
      agentId: "a",
      role: "coder",
      type: "message.delta",
      timestamp: "2026-01-01T00:00:00.000Z",
      payload: { type: "eco_stream", blockKind: "text", text: "", streamFinalize: true },
    },
  ]);
  expect(text).toBe("hello world");
});
