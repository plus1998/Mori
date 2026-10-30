import { expect, test } from "bun:test";
import {
  applyIntegratedWebSearchToAgentToolFields,
  buildBuiltinPlanToolPermissionEntry,
  buildClaudeCodeSystemPrompt,
  buildCodexMainAgentOrchestrationAppend,
  buildMainAgentSystemPrompt,
  buildToolPermissionPolicyFromOrchestration,
  createAgentDefinitionsFromOrchestration,
  type EcoAgentTemplateConfig,
  type EcoOrchestrationConfig,
  type EcoToolPolicy,
  mergeMainAgentAppendParts,
  resolveMainAgentAllowedTools,
  resolveMainAgentHandsOnCapability,
  resolveToolPermissionEntryForActor,
  sdkAgentKeyForOrchestrationAgent,
} from "../src/agent-orchestration";
import { SDK_GENERAL_PURPOSE_AGENT_KEY, SDK_PLAN_AGENT_KEY } from "../src/subagent-availability";

const updatedAt = "2026-06-07T00:00:00.000Z";

function toolPolicy(
  allowed: string[],
  disallowed: string[] = [],
  mcp?: { allowedServers: string[]; allowedTools: string[] },
): EcoToolPolicy {
  return { allowed, disallowed, ...(mcp ? { mcp } : {}) };
}

function modelRef(modelId: string) {
  return { providerId: "provider", modelId };
}

const researchTemplate: EcoAgentTemplateConfig = {
  id: "user.research.deep",
  name: "Deep Researcher",
  description: "Collects credible sources and competing views.",
  prompt: "CHILD SECRET PROMPT: research broadly and cite carefully.",
  whenToUse: "Need sourced findings or external context",
  outputContract: "Return findings, sources, confidence, and open questions.",
  defaultTools: toolPolicy(["WebSearch", "WebFetch"], ["Write"]),
  mcpServers: ["sources"],
  skills: ["citation"],
  allowDelegation: false,
  builtIn: false,
  source: "user",
  updatedAt,
};

const orchestration: EcoOrchestrationConfig = {
  mainAgent: {
    agentKey: "main",
    name: "Research Coordinator",
    systemPromptPreset: "custom_append",
    prompt: "You coordinate research work without assuming a coding task.",
    modelRef: modelRef("main-model"),
    tools: toolPolicy(["Agent", "Read", "WebSearch"], ["Write"], {
      allowedServers: ["browser"],
      allowedTools: ["mcp__sources__quote"],
    }),
    skills: [],
  },
  agents: [
    {
      agentKey: "researcher",
      templateId: researchTemplate.id,
      displayName: "Evidence Researcher",
      modelRef: modelRef("research-model"),
      tools: toolPolicy(["Read", "WebSearch"], ["Bash"]),
      mcpServers: ["browser"],
      skills: ["pdf"],
      enabled: true,
    },
    {
      agentKey: "disabled",
      templateId: researchTemplate.id,
      modelRef: modelRef("disabled-model"),
      tools: toolPolicy(["Read"]),
      mcpServers: [],
      skills: [],
      enabled: false,
    },
  ],
  strategy: { kind: "autonomous", guidancePrompt: "Delegate only when evidence quality improves." },
};

function requireElement<T>(values: readonly T[], index: number, label: string): T {
  const value = values[index];
  if (!value) {
    throw new Error(`${label} ${index} missing in test fixture.`);
  }
  return value;
}

test("createAgentDefinitionsFromOrchestration builds enabled SDK agent definitions", () => {
  const resolved = createAgentDefinitionsFromOrchestration(orchestration, [researchTemplate]);

  expect(resolved.agentKeys).toEqual(["eco_researcher"]);
  expect(resolved.definitions).not.toHaveProperty("eco_disabled");

  const definition = resolved.definitions.eco_researcher as Record<string, unknown>;
  expect(definition).toMatchObject({
    model: "research-model",
    tools: ["Read", "WebSearch", "LS", "NotebookRead"],
    disallowedTools: ["Bash", "Agent", "Task"],
    prompt: researchTemplate.prompt,
    mcpServers: ["sources", "browser"],
  });
  expect(definition.description).toContain("Evidence Researcher");
  expect(definition.description).toContain("Use when: Need sourced findings or external context");
});

test("orchestration forwards the optional Claude compaction policy into the SDK agent definition", () => {
  const configured = {
    ...orchestration,
    agents: orchestration.agents.map((agent) => ({ ...agent, claudeAutoCompactWindow: 128_000 })),
  };
  const result = createAgentDefinitionsFromOrchestration(configured, [researchTemplate]);
  expect(result.definitions.eco_researcher).toMatchObject({ autoCompactWindow: 128_000 });
  expect(result.definitions).not.toHaveProperty("eco_disabled");
});

test("createAgentDefinitionsFromOrchestration swaps native WebSearch for Integrated MCP", () => {
  const resolved = createAgentDefinitionsFromOrchestration(orchestration, [researchTemplate], {
    integratedWebSearch: {
      serverName: "eco_web_search",
      fullToolName: "mcp__eco_web_search__search",
    },
  });

  const definition = resolved.definitions.eco_researcher as Record<string, unknown>;
  expect(definition.tools).toEqual(expect.arrayContaining(["Read", "mcp__eco_web_search__search"]));
  expect(definition.tools).not.toContain("WebSearch");
  expect(definition.disallowedTools).toEqual(expect.arrayContaining(["Bash", "Agent", "Task", "WebSearch"]));
  expect(definition.mcpServers).toEqual(expect.arrayContaining(["sources", "browser", "eco_web_search"]));
});

test("applyIntegratedWebSearchToAgentToolFields skips MCP for network.webSearch false", () => {
  const applied = applyIntegratedWebSearchToAgentToolFields({
    tools: ["Read", "Glob", "Grep"],
    disallowedTools: ["Bash"],
    mcpServers: [],
    networkWebSearch: false,
    integratedWebSearch: {
      serverName: "eco_web_search",
      fullToolName: "mcp__eco_web_search__search",
    },
  });
  expect(applied.tools).toEqual(["Read", "Glob", "Grep"]);
  expect(applied.disallowedTools).toContain("WebSearch");
  expect(applied.mcpServers).toEqual([]);
});

test("buildMainAgentSystemPrompt appends only UI-configured main prompts", () => {
  const prompt = buildMainAgentSystemPrompt(orchestration, [researchTemplate]);

  expect(prompt).toMatchObject({ type: "preset", preset: "claude_code" });
  const append = String((prompt as Record<string, unknown>).append);
  expect(append).toContain("You coordinate research work without assuming a coding task.");
  expect(append).toContain("Delegate only when evidence quality improves.");
  expect(append).not.toContain("PHASE APPEND");
  expect(append).not.toContain("Eco orchestration.");
  expect(append).not.toContain("Orchestration has finite time, token, cost");
  expect(append).not.toContain("Never treat subagents as free or unlimited");
  expect(append).not.toContain("CHILD SECRET PROMPT");
  expect(append).not.toContain("Agent(eco_researcher)");
});

test("mergeMainAgentAppendParts orders personalization before custom and strategy", () => {
  expect(
    mergeMainAgentAppendParts({
      globalUserRules: "Always reply in Chinese.",
      customPrompt: "Custom orchestration append.",
      strategySummary: "Strategy guidance.",
    }),
  ).toBe("Always reply in Chinese.\n\nCustom orchestration append.\n\nStrategy guidance.");
});

test("buildMainAgentSystemPrompt prepends global user rules", () => {
  const prompt = buildMainAgentSystemPrompt(orchestration, [researchTemplate], {
    globalUserRules: "Always reply in Chinese.",
  }) as Record<string, unknown>;
  const append = String(prompt.append);
  expect(append.startsWith("Always reply in Chinese.")).toBe(true);
  expect(append).toContain("You coordinate research work without assuming a coding task.");
  expect(append).toContain("Delegate only when evidence quality improves.");
});

test("buildClaudeCodeSystemPrompt injects personalization without orchestration", () => {
  const prompt = buildClaudeCodeSystemPrompt({
    globalUserRules: "Prefer small commits.",
  }) as Record<string, unknown>;
  expect(prompt).toMatchObject({
    type: "preset",
    preset: "claude_code",
    append: "Prefer small commits.",
  });
});

test("buildCodexMainAgentOrchestrationAppend prepends global user rules", () => {
  const append = buildCodexMainAgentOrchestrationAppend(orchestration, [researchTemplate], {
    globalUserRules: "Always reply in Chinese.",
  });
  expect(append.startsWith("Always reply in Chinese.")).toBe(true);
  expect(append).toContain("You coordinate research work without assuming a coding task.");
});

test("buildMainAgentSystemPrompt keeps an unmodified claude_code preset when UI prompts are empty", () => {
  const codingOrchestration: EcoOrchestrationConfig = {
    ...orchestration,
    mainAgent: {
      ...orchestration.mainAgent,
      systemPromptPreset: "core_native",
      prompt: "",
    },
    strategy: { ...orchestration.strategy, guidancePrompt: "" },
  };

  const systemPrompt = buildMainAgentSystemPrompt(codingOrchestration, [researchTemplate], {
    excludeDynamicSections: true,
  }) as Record<string, unknown>;

  expect(systemPrompt).toMatchObject({
    type: "preset",
    preset: "claude_code",
    excludeDynamicSections: true,
  });
  expect(systemPrompt).not.toHaveProperty("append");
});

test("buildCodexMainAgentOrchestrationAppend includes custom append prompt text", () => {
  const append = buildCodexMainAgentOrchestrationAppend(orchestration, [researchTemplate]);
  expect(append).toContain("You coordinate research work without assuming a coding task.");
  expect(append).not.toContain("Orchestration has finite time, token, cost");
  expect(append).not.toContain("Never treat subagents as free or unlimited");
});

test("buildCodexMainAgentOrchestrationAppend stays empty without custom guidance or subagents", () => {
  const append = buildCodexMainAgentOrchestrationAppend(
    {
      ...orchestration,
      mainAgent: {
        ...orchestration.mainAgent,
        systemPromptPreset: "core_native",
        prompt: "",
      },
      agents: [],
      strategy: { ...orchestration.strategy, guidancePrompt: "" },
    },
    [researchTemplate],
  );

  expect(append).toBe("");
});

test("buildCodexMainAgentOrchestrationAppend appends V4A teaching when enabled", () => {
  const append = buildCodexMainAgentOrchestrationAppend(
    {
      ...orchestration,
      mainAgent: { ...orchestration.mainAgent, v4aTeachingEnabled: true },
    },
    [researchTemplate],
  );
  expect(append).toContain("Mori V4A teaching");
  expect(append).toContain("*** Begin Patch");
});

test("buildCodexMainAgentOrchestrationAppend omits V4A teaching when disabled", () => {
  const append = buildCodexMainAgentOrchestrationAppend(orchestration, [researchTemplate]);
  expect(append).not.toContain("Mori V4A teaching");
});

test("resolveMainAgentHandsOnCapability mirrors the main agent tool policy enforcement", () => {
  expect(resolveMainAgentHandsOnCapability(undefined)).toEqual({
    canEditFiles: true,
    canRunBash: true,
  });

  const restricted: EcoOrchestrationConfig = {
    ...orchestration,
    mainAgent: {
      ...orchestration.mainAgent,
      tools: {
        allowed: ["Agent", "Read"],
        disallowed: [],
        filesystem: { read: "workspace", write: "none" },
      },
    },
  };
  expect(resolveMainAgentHandsOnCapability(restricted)).toEqual({
    canEditFiles: false,
    canRunBash: true,
  });

  const handsOn: EcoOrchestrationConfig = {
    ...orchestration,
    mainAgent: {
      ...orchestration.mainAgent,
      tools: {
        allowed: ["Agent", "Read", "Write", "Edit", "Bash"],
        disallowed: [],
        bash: { enabled: true },
        filesystem: { read: "workspace", write: "workspace" },
      },
    },
  };
  expect(resolveMainAgentHandsOnCapability(handsOn)).toEqual({
    canEditFiles: true,
    canRunBash: true,
  });

  const disallowedWrites: EcoOrchestrationConfig = {
    ...orchestration,
    mainAgent: {
      ...orchestration.mainAgent,
      tools: {
        allowed: ["Agent", "Read"],
        disallowed: ["Write", "Edit", "MultiEdit", "NotebookEdit", "Bash"],
        bash: { enabled: true },
        filesystem: { read: "workspace", write: "workspace" },
      },
    },
  };
  expect(resolveMainAgentHandsOnCapability(disallowedWrites)).toEqual({
    canEditFiles: false,
    canRunBash: false,
  });
});

test("resolveMainAgentAllowedTools merges phase tools for universal orchestrations", () => {
  expect(resolveMainAgentAllowedTools(orchestration, ["Bash", "Write"])).toEqual([
    "Bash",
    "Write",
    "Skill",
    "TaskCreate",
    "TaskGet",
    "TaskUpdate",
    "TaskList",
    "TodoWrite",
    "MultiEdit",
    "NotebookEdit",
    "Agent",
    "Read",
    "WebSearch",
    "LS",
    "NotebookRead",
    "mcp__browser__*",
    "mcp__sources__*",
  ]);

  const planningPhaseTools = ["Agent", "Read", "Glob", "Grep", "WebSearch", "WebFetch", "AskUserQuestion"];
  const planningResolved = resolveMainAgentAllowedTools(orchestration, planningPhaseTools);
  expect(planningResolved).not.toContain("ExitPlanMode");
  expect(planningResolved).toContain("AskUserQuestion");
  expect(planningResolved).not.toContain("Bash");

  const codingOrchestration: EcoOrchestrationConfig = { ...orchestration, preset: "coding" };
  const executionPhaseTools = [
    "Agent",
    "Read",
    "Glob",
    "Grep",
    "Write",
    "Edit",
    "Bash",
    "WebSearch",
    "WebFetch",
  ];
  expect(resolveMainAgentAllowedTools(codingOrchestration, executionPhaseTools)).toEqual([
    "Agent",
    "Read",
    "Glob",
    "Grep",
    "Write",
    "Edit",
    "Bash",
    "WebSearch",
    "WebFetch",
    "Skill",
    "TaskCreate",
    "TaskGet",
    "TaskUpdate",
    "TaskList",
    "TodoWrite",
    "LS",
    "NotebookRead",
    "MultiEdit",
    "NotebookEdit",
    "mcp__browser__*",
    "mcp__sources__*",
  ]);
});

test("resolveMainAgentAllowedTools caps coding orchestration tools to planning phase", () => {
  const codingOrchestration: EcoOrchestrationConfig = {
    ...orchestration,
    preset: "coding",
    mainAgent: {
      ...orchestration.mainAgent,
      tools: {
        allowed: ["Agent", "Read", "Write", "Edit", "Bash", "WebSearch", "WebFetch"],
        disallowed: [],
        bash: { enabled: true },
        filesystem: { read: "workspace", write: "workspace" },
        network: { webSearch: true, webFetch: true },
      },
    },
  };
  const planningPhaseTools = ["Agent", "Read", "Glob", "Grep", "WebSearch", "WebFetch", "AskUserQuestion"];
  const resolved = resolveMainAgentAllowedTools(codingOrchestration, planningPhaseTools);
  expect(resolved).not.toContain("ExitPlanMode");
  expect(resolved).toContain("AskUserQuestion");
  expect(resolved).toContain("Read");
  expect(resolved).not.toContain("Write");
  expect(resolved).not.toContain("Edit");
  expect(resolved).not.toContain("MultiEdit");
  expect(resolved).not.toContain("Bash");
});

test("buildBuiltinPlanToolPermissionEntry keeps plan agent read-only with network access", () => {
  const entry = buildBuiltinPlanToolPermissionEntry();
  expect(entry.disallowed).toContain("Write");
  expect(entry.disallowed).toContain("Bash");
  expect(entry.allowed).toEqual([]);
  expect(entry.filesystem).toEqual({ read: "workspace", write: "none" });
  expect(entry.network).toEqual({ webSearch: true, webFetch: true });
});

test("resolveToolPermissionEntryForActor prevents SDK general-purpose recursive delegation", () => {
  const policy = buildToolPermissionPolicyFromOrchestration(orchestration, [researchTemplate]);
  const entry = resolveToolPermissionEntryForActor(policy, SDK_GENERAL_PURPOSE_AGENT_KEY);
  expect(entry).not.toBe(policy.main);
  expect(entry?.disallowed).toEqual(expect.arrayContaining(["Agent", "Task"]));
  expect(entry?.allowed).not.toContain("Agent");
});

test("resolveToolPermissionEntryForActor maps SDK Plan to read-only policy", () => {
  const policy = buildToolPermissionPolicyFromOrchestration(orchestration, [researchTemplate]);
  const planEntry = resolveToolPermissionEntryForActor(policy, SDK_PLAN_AGENT_KEY);
  expect(planEntry?.disallowed).toContain("Write");
  expect(planEntry?.disallowed).toContain("Bash");
  expect(planEntry?.filesystem).toEqual({ read: "workspace", write: "none" });
});

test("resolveToolPermissionEntryForActor inherits planning phase cap for general-purpose", () => {
  const codingOrchestration: EcoOrchestrationConfig = {
    ...orchestration,
    preset: "coding",
    mainAgent: {
      ...orchestration.mainAgent,
      tools: {
        allowed: ["Agent", "Read", "Write", "Edit", "Bash", "WebSearch", "WebFetch"],
        disallowed: [],
        bash: { enabled: true },
        filesystem: { read: "workspace", write: "workspace" },
        network: { webSearch: true, webFetch: true },
      },
    },
  };
  const policy = buildToolPermissionPolicyFromOrchestration(codingOrchestration, [researchTemplate], {
    phaseAllowedTools: ["Agent", "Read", "Glob", "Grep", "WebSearch", "WebFetch", "AskUserQuestion"],
  });
  const generalPurposeEntry = resolveToolPermissionEntryForActor(policy, SDK_GENERAL_PURPOSE_AGENT_KEY);
  expect(generalPurposeEntry?.disallowed).toEqual(
    expect.arrayContaining(["Write", "Bash", "Edit", "MultiEdit", "NotebookEdit", "Agent", "Task"]),
  );
});

test("resolveToolPermissionEntryForActor still resolves eco orchestration agents", () => {
  const policy = buildToolPermissionPolicyFromOrchestration(orchestration, [researchTemplate]);
  expect(resolveToolPermissionEntryForActor(policy, "eco_researcher")).toBe(policy.agents.eco_researcher);
});

test("buildToolPermissionPolicyFromOrchestration uses only runtime MCP servers for main and agents", () => {
  const policy = buildToolPermissionPolicyFromOrchestration(orchestration, [researchTemplate], {
    runtimeMcpServers: ["mongo"],
  });
  expect(policy.main.mcpServers).toEqual(["mongo"]);
  expect(policy.agents.eco_researcher?.mcpServers).toEqual(["mongo"]);
});

test("buildToolPermissionPolicyFromOrchestration enables bash for hands-on orchestrations without explicit bash field", () => {
  const handsOnOrchestration: EcoOrchestrationConfig = {
    ...orchestration,
    preset: "coding",
    mainAgent: {
      ...orchestration.mainAgent,
      tools: {
        allowed: [],
        disallowed: [],
        filesystem: { read: "workspace", write: "workspace" },
        network: { webSearch: true, webFetch: true },
      },
    },
  };
  const policy = buildToolPermissionPolicyFromOrchestration(handsOnOrchestration, [researchTemplate]);
  expect(policy.main.bash?.enabled).toBe(true);
});

test("buildToolPermissionPolicyFromOrchestration enables bash for legacy allowed Bash during execution", () => {
  const legacyCodingOrchestration: EcoOrchestrationConfig = {
    ...orchestration,
    preset: "coding",
    mainAgent: {
      ...orchestration.mainAgent,
      tools: {
        allowed: ["Agent", "Read", "Write", "Edit", "Bash", "WebSearch", "WebFetch"],
        disallowed: [],
        filesystem: { read: "workspace", write: "workspace" },
        network: { webSearch: true, webFetch: true },
      },
    },
  };
  const policy = buildToolPermissionPolicyFromOrchestration(legacyCodingOrchestration, [researchTemplate]);
  expect(policy.main.bash?.enabled).toBe(true);
});

test("buildToolPermissionPolicyFromOrchestration disables main writes during planning phase", () => {
  const codingOrchestration: EcoOrchestrationConfig = {
    ...orchestration,
    preset: "coding",
    mainAgent: {
      ...orchestration.mainAgent,
      tools: {
        allowed: ["Agent", "Read", "Write", "Edit", "Bash", "WebSearch", "WebFetch"],
        disallowed: [],
        bash: { enabled: true },
        filesystem: { read: "workspace", write: "workspace" },
        network: { webSearch: true, webFetch: true },
      },
    },
  };
  const policy = buildToolPermissionPolicyFromOrchestration(codingOrchestration, [researchTemplate], {
    phaseAllowedTools: ["Agent", "Read", "Glob", "Grep", "WebSearch", "WebFetch", "AskUserQuestion"],
  });
  expect(policy.main.allowed).not.toContain("ExitPlanMode");
  expect(policy.main.allowed).not.toContain("Write");
  expect(policy.main.disallowed).toEqual(
    expect.arrayContaining(["Bash", "Write", "Edit", "MultiEdit", "NotebookEdit"]),
  );
  expect(policy.main.filesystem).toEqual({ read: "workspace", write: "workspace" });
  expect(policy.main.bash?.enabled).toBe(false);
});

test("buildToolPermissionPolicyFromOrchestration caps universal orchestration tools during planning phase", () => {
  const policy = buildToolPermissionPolicyFromOrchestration(orchestration, [researchTemplate], {
    phaseAllowedTools: ["Agent", "Read", "Glob", "Grep", "WebSearch", "WebFetch", "AskUserQuestion"],
  });
  expect(policy.main.allowed).not.toContain("ExitPlanMode");
  expect(policy.main.allowed).not.toContain("Write");
});

test("buildToolPermissionPolicyFromOrchestration does not phase-cap network during execution", () => {
  const handsOnOrchestration: EcoOrchestrationConfig = {
    ...orchestration,
    mainAgent: {
      ...orchestration.mainAgent,
      tools: {
        allowed: [],
        disallowed: [],
        filesystem: { read: "workspace", write: "workspace" },
        network: { webSearch: true, webFetch: true },
      },
    },
  };
  const policy = buildToolPermissionPolicyFromOrchestration(handsOnOrchestration, [researchTemplate]);
  expect(policy.main.disallowed).not.toContain("WebSearch");
  expect(policy.main.disallowed).not.toContain("WebFetch");
  expect(policy.main.bash?.enabled).toBe(true);
});

test("buildToolPermissionPolicyFromOrchestration resolves main and dynamic agent tools", () => {
  const policy = buildToolPermissionPolicyFromOrchestration(orchestration, [researchTemplate], {
    agentKeys: ["eco_researcher"],
    phaseAllowedTools: [
      "Agent",
      "TaskList",
      "TaskGet",
      "Skill",
      "Read",
      "Glob",
      "Grep",
      "LS",
      "NotebookRead",
      "WebSearch",
      "WebFetch",
      "AskUserQuestion",
    ],
    runtimeMcpServers: ["browser", "sources"],
  });

  expect(policy.main.allowed).toContain("Skill");
  expect(policy.main.allowed).not.toContain("TaskCreate");
  expect(policy.main.allowed).not.toContain("TaskUpdate");
  expect(policy.main.allowed).not.toContain("TodoWrite");
  expect(policy.main.mcpServers).toEqual(["browser", "sources"]);
  expect(policy.main.disallowed).toEqual(
    expect.arrayContaining(["Write", "Bash", "Edit", "MultiEdit", "NotebookEdit"]),
  );
  expect(policy.agents.eco_researcher).toMatchObject({
    allowed: ["Skill"],
    disallowed: expect.arrayContaining([
      "Bash",
      "Agent",
      "Task",
      "Write",
      "Edit",
      "MultiEdit",
      "NotebookEdit",
    ]),
    mcpServers: ["browser", "sources"],
  });
});

test("buildToolPermissionPolicyFromOrchestration preserves structured tool policies", () => {
  const firstAgent = requireElement(orchestration.agents, 0, "agent");
  const structuredOrchestration: EcoOrchestrationConfig = {
    ...orchestration,
    mainAgent: {
      ...orchestration.mainAgent,
      tools: {
        ...orchestration.mainAgent.tools,
        bash: { enabled: true },
        filesystem: { read: "workspace", write: "none" },
        network: { webSearch: false, webFetch: true },
      },
    },
    agents: [
      {
        ...firstAgent,
        tools: {
          ...firstAgent.tools,
          disallowed: firstAgent.tools.disallowed.filter((tool) => tool !== "Bash"),
          bash: { enabled: true },
          filesystem: { read: "workspace", write: "none" },
          network: { webSearch: true, webFetch: false },
        },
      },
    ],
  };

  const policy = buildToolPermissionPolicyFromOrchestration(structuredOrchestration, [researchTemplate]);

  expect(policy.main).toMatchObject({
    bash: { enabled: true },
    filesystem: { read: "workspace", write: "none" },
    network: { webSearch: false, webFetch: true },
  });
  expect(policy.agents.eco_researcher).toMatchObject({
    bash: { enabled: true },
    filesystem: { read: "workspace", write: "none" },
    network: { webSearch: true, webFetch: false },
  });
});

test("buildToolPermissionPolicyFromOrchestration tolerates legacy agent tools without allow lists", () => {
  const firstAgent = requireElement(orchestration.agents, 0, "agent");
  const legacyOrchestration: EcoOrchestrationConfig = {
    ...orchestration,
    agents: [
      {
        ...firstAgent,
        tools: {
          bash: { enabled: false },
        } as EcoToolPolicy,
      },
    ],
  };

  const policy = buildToolPermissionPolicyFromOrchestration(legacyOrchestration, [researchTemplate]);
  expect(policy.agents.eco_researcher?.disallowed).toEqual(expect.arrayContaining(["Bash", "Agent", "Task"]));

  const definitions = createAgentDefinitionsFromOrchestration(legacyOrchestration, [researchTemplate]);
  const definition = definitions.definitions.eco_researcher as Record<string, unknown>;
  expect(definition.disallowedTools).toEqual(expect.arrayContaining(["Bash", "Agent", "Task"]));
});

test("subagent delegation tools require allowDelegation", () => {
  const firstAgent = requireElement(orchestration.agents, 0, "agent");
  const delegatingOrchestration: EcoOrchestrationConfig = {
    ...orchestration,
    agents: [
      {
        ...firstAgent,
        tools: toolPolicy(["Read", "Agent", "Task"], []),
      },
    ],
  };
  const blockedTemplate: EcoAgentTemplateConfig = {
    ...researchTemplate,
    defaultTools: toolPolicy(["Read", "Agent", "Task"], []),
    allowDelegation: false,
  };

  const blockedDefinitions = createAgentDefinitionsFromOrchestration(delegatingOrchestration, [
    blockedTemplate,
  ]);
  const blockedDefinition = blockedDefinitions.definitions.eco_researcher as Record<string, unknown>;
  expect(blockedDefinition.tools).toEqual(["Read", "LS", "NotebookRead"]);
  expect(blockedDefinition.mcpServers).toEqual(["sources", "browser"]);
  expect(blockedDefinition.disallowedTools).toEqual(["Agent", "Task"]);

  const blockedPolicy = buildToolPermissionPolicyFromOrchestration(
    delegatingOrchestration,
    [blockedTemplate],
    {
      runtimeMcpServers: ["sources", "browser"],
    },
  );
  expect(blockedPolicy.agents.eco_researcher).toMatchObject({
    allowed: ["Read", "Skill", "LS", "NotebookRead"],
    disallowed: ["Agent", "Task"],
    mcpServers: ["sources", "browser"],
  });

  const allowedTemplate: EcoAgentTemplateConfig = { ...blockedTemplate, allowDelegation: true };
  const allowedDefinitions = createAgentDefinitionsFromOrchestration(delegatingOrchestration, [
    allowedTemplate,
  ]);
  const allowedDefinition = allowedDefinitions.definitions.eco_researcher as Record<string, unknown>;
  expect(allowedDefinition.tools).toEqual(["Read", "Agent", "Task", "LS", "NotebookRead"]);
  expect(allowedDefinition.mcpServers).toEqual(["sources", "browser"]);
  expect(allowedDefinition).not.toHaveProperty("disallowedTools");

  const allowedPolicy = buildToolPermissionPolicyFromOrchestration(
    delegatingOrchestration,
    [allowedTemplate],
    {
      runtimeMcpServers: ["sources", "browser"],
    },
  );
  expect(allowedPolicy.agents.eco_researcher).toMatchObject({
    allowed: ["Read", "Agent", "Task", "Skill", "LS", "NotebookRead"],
    disallowed: [],
    mcpServers: ["sources", "browser"],
  });
});

test("sdkAgentKeyForOrchestrationAgent normalizes custom keys", () => {
  expect(sdkAgentKeyForOrchestrationAgent(" Research Lead ")).toBe("eco_Research_Lead");
  expect(sdkAgentKeyForOrchestrationAgent("eco_writer")).toBe("eco_writer");
  expect(() => sdkAgentKeyForOrchestrationAgent("   ")).toThrow("Agent key cannot be empty.");
});
