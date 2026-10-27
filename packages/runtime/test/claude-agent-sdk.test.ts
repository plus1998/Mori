import { expect, test } from "bun:test";
import type { ResolvedModelRoute } from "../../model-router/src";
import { parseSubagentMissionMessage } from "../src/agent-mission";
import type { EcoAgentRuntimeConfig, EcoToolPolicy } from "../src/agent-orchestration";
import {
  appendToPhaseTranscript,
  applyClaudeJsonlSessionPersistence,
  applyEcoSdkSettings,
  applyResumeToQueryOptions,
  buildAutonomousPlanContinuationPrompt,
  buildSdkProcessEnv,
  ClaudeAgentSdkDriver,
  createAgentDefinitions,
  createAskAgentDefinitions,
  createAutonomousAgentDefinitions,
  createCanUseTool,
  createClaudeQueryHandle,
  createHeldPromptStream,
  createPhaseBoundaryEvent,
  createPlanningAgentDefinitions,
  createPlanReadyEvent,
  createSessionCapturedEvent,
  createToolPermissionDeniedEvent,
  deleteClaudeAgentSdkSession,
  extractSdkRunFailure,
  extractSdkRunIncompleteReason,
  formatAgentEventDisplay,
  formatAgentEventLine,
  formatSdkPayloadMessage,
  getDefaultAllowedTools,
  type HeldPromptStream,
  inferActivityRole,
  interruptOrCloseSdkQuery,
  isCompactBoundarySdkMessage,
  isSdkInitMessage,
  mapSdkMessageToEvents,
  readClaudeBackgroundTasksChanged,
  mergeAllowedTools,
  readSdkSessionId,
  readSdkUserMessageCheckpointId,
  resolveAgentSkills,
  resolveClaudeSessionCwd,
  resolveResumeSessionAtBeforeUserMessage,
  resolveSdkPromptCaptureText,
  resolveSdkSessionOptions,
  stripBashAutoApprovedTools,
  stripProtectedPlanModeAutoApprovedTools,
  teardownClaudeQueryHandle,
  toSdkAgentModel,
  toStreamingUserPrompt,
} from "../src/claude-agent-sdk";
import { executionCoderPrompt, executionTesterPrompt, reviewerAgentPrompt } from "../src/prompts/index";
import { createSdkStreamContext } from "../src/sdk-stream-events";
import { ecoSubagentKeyForRole } from "../src/subagent-availability";

function createFakeHeldPromptStream(
  overrides?: Partial<Pick<HeldPromptStream, "push" | "close">>,
): HeldPromptStream {
  return {
    ecoPromptText: "fake",
    async *[Symbol.asyncIterator]() {},
    push: overrides?.push ?? (async () => {}),
    close: overrides?.close ?? (() => {}),
  };
}

const routes: ResolvedModelRoute[] = [
  {
    role: "main",
    primary: {
      id: "opus",
      provider: "anthropic",
      displayName: "Opus",
      baseUrl: "https://gateway.test",
      modelId: "claude-opus-4",
      capabilities: ["messages_api"],
      enabled: true,
      contextWindow: 200_000,
    },
    fallbacks: [],
  },
  {
    role: "explore",
    primary: {
      id: "haiku",
      provider: "anthropic",
      displayName: "Haiku",
      baseUrl: "https://gateway.test",
      modelId: "claude-haiku-explore",
      capabilities: ["messages_api"],
      enabled: true,
      contextWindow: 200_000,
    },
    fallbacks: [],
  },
  {
    role: "coder",
    primary: {
      id: "qwen",
      provider: "custom",
      displayName: "Qwen Coder",
      baseUrl: "https://gateway.test",
      modelId: "qwen-coder-anthropic",
      capabilities: ["messages_api"],
      enabled: true,
      contextWindow: 200_000,
    },
    fallbacks: [],
  },
  {
    role: "architect",
    primary: {
      id: "architect-sonnet",
      provider: "anthropic",
      displayName: "Architect Sonnet",
      baseUrl: "https://gateway.test",
      modelId: "claude-sonnet-architect",
      capabilities: ["messages_api"],
      enabled: true,
      contextWindow: 200_000,
    },
    fallbacks: [],
  },
  {
    role: "reviewer",
    primary: {
      id: "reviewer-sonnet",
      provider: "anthropic",
      displayName: "Reviewer Sonnet",
      baseUrl: "https://gateway.test",
      modelId: "claude-sonnet-reviewer",
      capabilities: ["messages_api"],
      enabled: true,
      contextWindow: 200_000,
    },
    fallbacks: [],
  },
  {
    role: "tester",
    primary: {
      id: "tester-haiku",
      provider: "anthropic",
      displayName: "Tester Haiku",
      baseUrl: "https://gateway.test",
      modelId: "claude-haiku-tester",
      capabilities: ["messages_api"],
      enabled: true,
      contextWindow: 200_000,
    },
    fallbacks: [],
  },
];

async function* emptySdkQuery(): AsyncIterable<unknown> {}

function universalToolPolicy(allowed: string[], disallowed: string[] = []): EcoToolPolicy {
  return { allowed, disallowed };
}

const universalAgentRegistry: EcoAgentRuntimeConfig = {
  templates: [
    {
      id: "builtin.coding.explore",
      name: "Explore",
      description: "Read-only codebase discovery agent.",
      prompt: "Explore the codebase read-only and report relevant paths and symbols.",
      whenToUse: "Use when codebase context is needed.",
      outputContract: "Return relevant paths, symbols, and context gaps.",
      defaultTools: universalToolPolicy(["Read", "Glob", "Grep"], ["Bash", "Write"]),
      mcpServers: [],
      skills: [],
      allowDelegation: false,
      builtIn: true,
      source: "built_in",
      updatedAt: "2026-06-07T00:00:00.000Z",
    },
    {
      id: "user.researcher",
      name: "Researcher",
      description: "Finds credible external evidence.",
      prompt: "CHILD SECRET PROMPT: find source-backed evidence.",
      whenToUse: "Use for market or factual research.",
      outputContract: "Return findings, sources, and confidence.",
      defaultTools: universalToolPolicy(["WebSearch", "WebFetch"], ["Write"]),
      mcpServers: ["sources"],
      skills: ["citation"],
      allowDelegation: false,
      builtIn: false,
      source: "user",
      updatedAt: "2026-06-07T00:00:00.000Z",
    },
  ],
  orchestration: {
    mainAgent: {
      agentKey: "main",
      name: "Research Coordinator",
      systemPromptPreset: "custom_append",
      prompt: "Coordinate a research answer without assuming a coding task.",
      modelRef: { providerId: "anthropic", modelId: "research-main-model" },
      tools: {
        ...universalToolPolicy(["Agent", "Read", "WebSearch"], ["Write"]),
        mcp: { allowedServers: ["browser"], allowedTools: ["mcp__sources__quote"] },
      },
      skills: [],
    },
    agents: [
      {
        agentKey: "explore",
        templateId: "builtin.coding.explore",
        displayName: "Explore",
        modelRef: { providerId: "anthropic", modelId: "research-explore-model" },
        tools: universalToolPolicy(["Read", "Glob", "Grep"], ["Bash", "Write"]),
        mcpServers: [],
        skills: [],
        enabled: true,
      },
      {
        agentKey: "researcher",
        templateId: "user.researcher",
        displayName: "Evidence Researcher",
        modelRef: { providerId: "anthropic", modelId: "research-agent-model" },
        tools: universalToolPolicy(["WebSearch", "WebFetch"], ["Bash"]),
        mcpServers: ["browser"],
        skills: ["pdf"],
        enabled: true,
      },
    ],
    strategy: { kind: "autonomous", guidancePrompt: "Delegate when evidence quality improves." },
  },
};

const guidedResearchAgentRegistry: EcoAgentRuntimeConfig = {
  templates: [
    ...universalAgentRegistry.templates,
    {
      id: "user.synthesizer",
      name: "Synthesizer",
      description: "Turns evidence into a concise answer.",
      prompt: "Synthesize evidence into a clear final answer.",
      whenToUse: "Use after source discovery.",
      outputContract: "Return final synthesis.",
      defaultTools: universalToolPolicy(["Read"], ["Bash"]),
      mcpServers: [],
      skills: [],
      allowDelegation: false,
      builtIn: false,
      source: "user",
      updatedAt: "2026-06-07T00:00:00.000Z",
    },
  ],
  orchestration: {
    ...universalAgentRegistry.orchestration,
    agents: [
      ...universalAgentRegistry.orchestration.agents,
      {
        agentKey: "synthesizer",
        templateId: "user.synthesizer",
        displayName: "Research Synthesizer",
        modelRef: { providerId: "anthropic", modelId: "synthesis-agent-model" },
        tools: universalToolPolicy(["Read"], ["Bash"]),
        mcpServers: [],
        skills: [],
        enabled: true,
      },
    ],
    strategy: {
      kind: "autonomous",
      guidancePrompt:
        "Use researcher for evidence discovery and synthesizer when synthesis improves the answer.",
    },
  },
};

test("deleteClaudeAgentSdkSession delegates to SDK deleteSession", async () => {
  const calls: Array<{ sessionId: string; options: unknown }> = [];

  await deleteClaudeAgentSdkSession({
    sessionId: " session_123 ",
    dir: " /tmp/project ",
    loadSdk: async () => ({
      query: () => emptySdkQuery(),
      deleteSession: async (sessionId, options) => {
        calls.push({ sessionId, options });
      },
    }),
  });

  expect(calls).toEqual([
    {
      sessionId: "session_123",
      options: { dir: "/tmp/project" },
    },
  ]);
});

test("buildSdkProcessEnv forces local router env over inherited Anthropic auth", () => {
  const previous = {
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
    ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN,
    PATH: process.env.PATH,
  };
  process.env.ANTHROPIC_API_KEY = "real-key";
  process.env.ANTHROPIC_BASE_URL = "https://api.anthropic.com";
  process.env.ANTHROPIC_AUTH_TOKEN = "oauth-token";

  try {
    const env = buildSdkProcessEnv({
      apiKey: "eco-local-model-router",
      baseUrl: "http://127.0.0.1:36037/",
    });
    expect(env.ANTHROPIC_API_KEY).toBe("eco-local-model-router");
    expect(env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:36037");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.PATH).toBe(previous.PATH);
    expect(env.CLAUDE_CODE_DISABLE_WORKFLOWS).toBe("1");
    expect(env.CLAUDE_CODE_ATTRIBUTION_HEADER).toBe("0");
    expect(env.CLAUDE_CODE_GATEWAY_HINT_HEADERS).toBe("1");
  } finally {
    if (previous.ANTHROPIC_API_KEY === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previous.ANTHROPIC_API_KEY;
    if (previous.ANTHROPIC_BASE_URL === undefined) delete process.env.ANTHROPIC_BASE_URL;
    else process.env.ANTHROPIC_BASE_URL = previous.ANTHROPIC_BASE_URL;
    if (previous.ANTHROPIC_AUTH_TOKEN === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN;
    else process.env.ANTHROPIC_AUTH_TOKEN = previous.ANTHROPIC_AUTH_TOKEN;
  }
});

test("applyEcoSdkSettings sets autoCompactWindow from the effective context cap", () => {
  const options: Record<string, unknown> = {};
  applyEcoSdkSettings(options, "router-key", "http://127.0.0.1:36037/", {
    autoCompactWindow: 262_144,
  });
  const settings = options.settings as { autoCompactWindow?: number };
  expect(settings.autoCompactWindow).toBe(262_144);
});

test("applyEcoSdkSettings omits autoCompactWindow outside the SDK schema range", () => {
  const options: Record<string, unknown> = {};
  applyEcoSdkSettings(options, "router-key", "http://127.0.0.1:36037/", {
    autoCompactWindow: 32_000,
  });
  const settings = options.settings as { autoCompactWindow?: number };
  expect(settings.autoCompactWindow).toBeUndefined();
});

test("applyEcoSdkSettings disables workflows and denies non-open SDK built-in subagents", () => {
  const options: Record<string, unknown> = {};
  applyEcoSdkSettings(options, "router-key", "http://127.0.0.1:36037/");
  const settings = options.settings as {
    disableWorkflows?: boolean;
    autoCompactEnabled?: boolean;
    permissions?: { deny?: string[] };
    env?: Record<string, string>;
  };
  const deny = settings.permissions?.deny ?? [];
  expect(settings.disableWorkflows).toBe(true);
  expect(settings.autoCompactEnabled).toBe(true);
  expect(deny).toEqual([
    "Agent(general-purpose)",
    "Agent(statusline-setup)",
    "Agent(Explore)",
    "Agent(Plan)",
    "Agent(Bash)",
  ]);
  expect(settings.env).toEqual({
    ANTHROPIC_API_KEY: "router-key",
    ANTHROPIC_BASE_URL: "http://127.0.0.1:36037",
    CLAUDE_CODE_ATTRIBUTION_HEADER: "0",
    CLAUDE_CODE_GATEWAY_HINT_HEADERS: "1",
  });
});

test("applyEcoSdkSettings opens Plan when plan mode allows it", () => {
  const options: Record<string, unknown> = {};
  applyEcoSdkSettings(options, "router-key", "http://127.0.0.1:36037/", {
    allowedSdkBuiltinAgentKeys: ["Plan"],
  });
  const settings = options.settings as {
    permissions?: { deny?: string[] };
  };
  const deny = settings.permissions?.deny ?? [];
  expect(deny).toEqual([
    "Agent(general-purpose)",
    "Agent(statusline-setup)",
    "Agent(Explore)",
    "Agent(Bash)",
  ]);
  expect(deny.includes("Agent(Plan)")).toBe(false);
});

test("createAutonomousAgentDefinitions registers all subagent roles", () => {
  const definitions = createAutonomousAgentDefinitions(routes);
  expect(Object.keys(definitions).sort()).toEqual([
    ecoSubagentKeyForRole("architect"),
    ecoSubagentKeyForRole("coder"),
    ecoSubagentKeyForRole("explore"),
    ecoSubagentKeyForRole("reviewer"),
    ecoSubagentKeyForRole("tester"),
  ]);
  const reviewer = definitions[ecoSubagentKeyForRole("reviewer")] as { description: string };
  expect(reviewer.description).toContain("High-risk");
});

test("createAutonomousAgentDefinitions filters disabled subagent roles", () => {
  const definitions = createAutonomousAgentDefinitions(routes, undefined, {
    explore: true,
    architect: true,
    coder: true,
    reviewer: false,
    tester: false,
  });
  expect(Object.keys(definitions).sort()).toEqual([
    ecoSubagentKeyForRole("architect"),
    ecoSubagentKeyForRole("coder"),
    ecoSubagentKeyForRole("explore"),
  ]);
});

test("agent definitions omit Explore when it is disabled in every session mode", () => {
  const availability = {
    explore: false,
    architect: true,
    coder: true,
    reviewer: true,
    tester: true,
  };
  expect(createAskAgentDefinitions(routes, undefined, availability)).not.toHaveProperty(
    ecoSubagentKeyForRole("explore"),
  );
  expect(createPlanningAgentDefinitions(routes, undefined, availability)).not.toHaveProperty(
    ecoSubagentKeyForRole("explore"),
  );
  expect(createAutonomousAgentDefinitions(routes, undefined, availability)).not.toHaveProperty(
    ecoSubagentKeyForRole("explore"),
  );
});

test("maps Claude family model ids to SDK subagent aliases", () => {
  expect(toSdkAgentModel("claude-opus-4")).toBe("claude-opus-4");
  expect(toSdkAgentModel("claude-sonnet")).toBe("claude-sonnet");
  expect(toSdkAgentModel("claude-haiku")).toBe("claude-haiku");
  expect(toSdkAgentModel("qwen-coder-anthropic")).toBe("qwen-coder-anthropic");
  expect(() => toSdkAgentModel(undefined, "coder")).toThrow(
    "Missing model id for coder subagent. Subagents must use explicit models.",
  );
});

test("includes network tools in default allowed tools", () => {
  const allowedTools = getDefaultAllowedTools();
  expect(allowedTools).toContain("Agent");
  expect(allowedTools).toContain("TaskList");
  expect(allowedTools).toContain("TaskGet");
  expect(allowedTools).toContain("Skill");
  expect(allowedTools).toContain("TaskCreate");
  expect(allowedTools).toContain("TaskUpdate");
  expect(allowedTools).toContain("TodoWrite");
  expect(allowedTools).toContain("LS");
  expect(allowedTools).toContain("NotebookRead");
  expect(allowedTools).toContain("MultiEdit");
  expect(allowedTools).toContain("NotebookEdit");
  expect(allowedTools).toContain("WebSearch");
  expect(allowedTools).toContain("WebFetch");
});

test("merges MCP tool allowlist and defaults filesystem session options", () => {
  expect(mergeAllowedTools(["Read", "Grep"], { mcpAllowedTools: ["mcp__github__*"] })).toEqual([
    "Read",
    "Grep",
    "mcp__github__*",
  ]);
  expect(resolveSdkSessionOptions()).toEqual({
    settingSources: ["project"],
    skills: undefined,
    mcpServers: {},
  });
  expect(
    resolveSdkSessionOptions({
      agentSkills: { main: ["pdf"], coder: ["docx", "lint"] },
    }),
  ).toEqual({
    settingSources: ["project"],
    skills: ["pdf"],
    mcpServers: {},
  });
});

test("removes Bash from SDK auto-approved tools when confirmation is enabled", () => {
  expect(stripBashAutoApprovedTools(["Read", "Bash", "mcp__github__*"])).toEqual(["Read", "mcp__github__*"]);
});

test("explicit empty skill selections stay empty instead of enabling CLI defaults", () => {
  expect(resolveSdkSessionOptions({ skills: [] }).skills).toEqual([]);
  expect(resolveSdkSessionOptions({ skills: ["pdf"], agentSkills: { main: [] } }).skills).toEqual([]);
  expect(resolveSdkSessionOptions({ agentSkills: { eco_planner: [] } }).skills).toEqual([]);
  expect(resolveAgentSkills("main", { main: [], eco_planner: ["pdf"] }, ["docx"])).toEqual([]);
  expect(resolveAgentSkills("main", undefined, ["pdf"])).toEqual(["pdf"]);
});

test("removes Plan Mode submission tools from SDK auto-approved tools", () => {
  expect(
    stripProtectedPlanModeAutoApprovedTools([
      "Read",
      "ExitPlanMode",
      "EnterPlanMode",
      "mcp__eco_plan__finalize_plan",
      "mcp__eco_plan__*",
      "mcp__github__*",
      "Exit*",
      "*",
    ]),
  ).toEqual(["Read", "mcp__github__*"]);
});

test("creates native SDK subagent definitions", () => {
  const agentSkills = { coder: ["docx"], architect: ["pdf"] };
  const definitions = createAgentDefinitions(routes, agentSkills);
  expect(definitions).toHaveProperty(ecoSubagentKeyForRole("coder"));
  expect(definitions[ecoSubagentKeyForRole("coder")]).toMatchObject({
    description: expect.stringContaining("focused coding"),
    skills: ["docx"],
    tools: [
      "Read",
      "Glob",
      "Grep",
      "LS",
      "NotebookRead",
      "Write",
      "Edit",
      "MultiEdit",
      "NotebookEdit",
      "Bash",
      "Skill",
    ],
    model: "qwen-coder-anthropic",
  });
  expect(definitions[ecoSubagentKeyForRole("architect")]).toMatchObject({
    skills: ["pdf"],
    tools: ["Read", "Glob", "Grep", "LS", "NotebookRead", "WebSearch", "WebFetch", "Skill"],
  });
  expect(definitions[ecoSubagentKeyForRole("reviewer")]).not.toHaveProperty("skills");
  expect((definitions[ecoSubagentKeyForRole("reviewer")] as { tools: string[] }).tools).not.toContain(
    "Skill",
  );
  expect(resolveAgentSkills("tester", agentSkills)).toEqual([]);
  expect(resolveAgentSkills("researcher", { eco_researcher: ["workspace-research"] })).toEqual([
    "workspace-research",
  ]);
  expect(resolveAgentSkills("eco_researcher", { researcher: ["raw-research"] })).toEqual(["raw-research"]);
});

test("execution architect prompt requires Coder Tasks section", () => {
  const definitions = createAutonomousAgentDefinitions(routes);
  const architectPrompt = (definitions[ecoSubagentKeyForRole("architect")] as { prompt: string }).prompt;
  expect(architectPrompt).toContain("## Coder Tasks");
  expect(architectPrompt).toContain("Context Digest");
  expect(architectPrompt).toContain("## Context Gaps");
  expect(definitions[ecoSubagentKeyForRole("coder")]).toMatchObject({
    prompt: expect.stringMatching(/runnable, verified code/),
  });
  expect(executionCoderPrompt).toContain("AGENTS.md");
  expect(executionCoderPrompt).toContain("root causes");
  expect(executionCoderPrompt).toContain("git reset --hard");
  expect(definitions[ecoSubagentKeyForRole("tester")]).toMatchObject({
    prompt: expect.stringContaining("## Test Verdict"),
  });
  expect(executionTesterPrompt).toContain("## Requirement Coverage");
});

test("reviewer prompt limits scope to current session workspace diff", () => {
  const definitions = createAutonomousAgentDefinitions(routes);
  expect(definitions[ecoSubagentKeyForRole("reviewer")]).toMatchObject({
    description: expect.stringContaining("High-risk"),
    prompt: expect.stringMatching(/git diff --name-only HEAD/),
  });
  expect(reviewerAgentPrompt).toContain("confidence");
  expect(reviewerAgentPrompt).toContain("code_location");
  expect(reviewerAgentPrompt).toContain("missing test coverage");
});

test("buildAutonomousPlanContinuationPrompt carries approved plan context", () => {
  const prompt = buildAutonomousPlanContinuationPrompt({
    userPrompt: "Add feature X",
    analysis: "Needs tests",
    plan: "Do the thing",
    planUserEdited: true,
    followUp: "also add unit tests",
  });
  expect(prompt).toContain("Implement the following approved plan:");
  expect(prompt).toContain("Do the thing");
  expect(prompt).toContain("also add unit tests");
  expect(prompt).not.toContain("system-reminder");
  expect(prompt).not.toContain("Eco subagents");
});

test("buildAutonomousPlanContinuationPrompt includes plan when execution cannot resume SDK session", () => {
  const prompt = buildAutonomousPlanContinuationPrompt({
    userPrompt: "Add feature X",
    analysis: "Needs tests",
    plan: "Do the thing",
    isResume: false,
  });
  expect(prompt).toContain("Implement the following approved plan:");
  expect(prompt).toContain("Do the thing");
});

test("buildAutonomousPlanContinuationPrompt avoids duplicating unedited plan on SDK resume", () => {
  const prompt = buildAutonomousPlanContinuationPrompt({
    userPrompt: "Add feature X",
    analysis: "Needs tests",
    plan: "Do the thing",
    isResume: true,
  });
  expect(prompt).toBe("Implement the plan.");
  expect(prompt).not.toContain("Do the thing");
});

test("planning explore uses only codebase read tools while architect keeps network lookup", () => {
  const definitions = createPlanningAgentDefinitions(routes);
  expect(definitions[ecoSubagentKeyForRole("explore")]).toMatchObject({
    description: expect.stringContaining("Read-only"),
    prompt: expect.stringContaining("read-only"),
    tools: ["Read", "Glob", "Grep"],
    model: "claude-haiku-explore",
  });
  expect(definitions).not.toHaveProperty("Explore");
  expect(definitions).not.toHaveProperty("explore");
  const architectPrompt = (definitions[ecoSubagentKeyForRole("architect")] as { prompt: string }).prompt;
  expect(architectPrompt).toContain("targeted structural reviewer");
  expect(architectPrompt).toContain("## Context Gaps");
  expect(definitions[ecoSubagentKeyForRole("architect")]).toMatchObject({
    tools: ["Read", "Glob", "Grep", "LS", "NotebookRead", "WebSearch", "WebFetch"],
  });
});

test("question explore subagent uses only codebase read tools", () => {
  const definitions = createAskAgentDefinitions(routes);
  expect(definitions[ecoSubagentKeyForRole("explore")]).toMatchObject({
    model: "claude-haiku-explore",
    tools: ["Read", "Glob", "Grep"],
  });
  expect(definitions).not.toHaveProperty("Explore");
  expect(definitions).not.toHaveProperty("explore");
});

test("autonomous subagents scope tools: explore read-only, coder writable, others read+bash+network", () => {
  const definitions = createAutonomousAgentDefinitions(routes);
  expect(definitions[ecoSubagentKeyForRole("explore")]).toMatchObject({
    model: "claude-haiku-explore",
    tools: ["Read", "Glob", "Grep"],
  });
  expect(definitions[ecoSubagentKeyForRole("architect")]).toMatchObject({
    tools: ["Read", "Glob", "Grep", "LS", "NotebookRead", "WebSearch", "WebFetch"],
  });
  expect(definitions[ecoSubagentKeyForRole("reviewer")]).toMatchObject({
    tools: ["Read", "Glob", "Grep", "LS", "NotebookRead", "Bash", "WebSearch", "WebFetch"],
  });
  expect(definitions[ecoSubagentKeyForRole("tester")]).toMatchObject({
    tools: ["Read", "Glob", "Grep", "LS", "NotebookRead", "Bash", "WebSearch", "WebFetch"],
  });
  expect(definitions[ecoSubagentKeyForRole("coder")]).toMatchObject({
    tools: [
      "Read",
      "Glob",
      "Grep",
      "LS",
      "NotebookRead",
      "Write",
      "Edit",
      "MultiEdit",
      "NotebookEdit",
      "Bash",
    ],
  });
  const coderTools = (definitions[ecoSubagentKeyForRole("coder")] as { tools: string[] }).tools;
  expect(coderTools).not.toContain("WebSearch");
  expect(coderTools).not.toContain("WebFetch");
  const architectTools = (definitions[ecoSubagentKeyForRole("architect")] as { tools: string[] }).tools;
  const reviewerTools = (definitions[ecoSubagentKeyForRole("reviewer")] as { tools: string[] }).tools;
  const testerTools = (definitions[ecoSubagentKeyForRole("tester")] as { tools: string[] }).tools;
  expect(architectTools).toContain("WebSearch");
  expect(reviewerTools).toContain("WebSearch");
  expect(testerTools).toContain("WebSearch");
});

test("createAutonomousAgentDefinitions omits every disabled role", () => {
  const availability = {
    explore: true,
    architect: true,
    coder: false,
    reviewer: false,
    tester: false,
  };
  const definitions = createAutonomousAgentDefinitions(routes, undefined, availability);
  expect(definitions).not.toHaveProperty(ecoSubagentKeyForRole("coder"));
  expect(definitions).not.toHaveProperty(ecoSubagentKeyForRole("reviewer"));
  expect(definitions).not.toHaveProperty(ecoSubagentKeyForRole("tester"));
});

test("createAutonomousAgentDefinitions skips architect when no route is configured", () => {
  const partialRoutes = routes.filter((route) => route.role !== "architect");
  const definitions = createAutonomousAgentDefinitions(partialRoutes);
  expect(definitions).not.toHaveProperty(ecoSubagentKeyForRole("architect"));
  expect(definitions).toHaveProperty(ecoSubagentKeyForRole("coder"));
});

test("inferActivityRole does not map SDK built-in Agent(Explore) to Eco Explore", () => {
  expect(
    inferActivityRole({
      type: "tool.started",
      role: "main",
      payload: {
        type: "tool_use",
        tool_name: "Agent",
        input: { subagent_type: "Explore", prompt: "Find auth middleware" },
      },
    }),
  ).toBe("tool");
});

test("inferActivityRole maps Agent(general-purpose) to general-purpose", () => {
  expect(
    inferActivityRole({
      type: "tool.started",
      role: "main",
      payload: {
        type: "tool_use",
        tool_name: "Agent",
        input: { subagent_type: "general-purpose", prompt: "Research and modify" },
      },
    }),
  ).toBe("general-purpose");
});

test("inferActivityRole maps Agent(Plan) to Plan", () => {
  expect(
    inferActivityRole({
      type: "tool.started",
      role: "main",
      payload: {
        type: "tool_use",
        tool_name: "Agent",
        input: { subagent_type: "Plan", prompt: "Research plan context" },
      },
    }),
  ).toBe("Plan");
});

test("formats eco phase boundary events", () => {
  const event = createPhaseBoundaryEvent("thr_1", "plan", "【1/2】分析与制定计划");
  expect(formatSdkPayloadMessage(event.payload)).toBe("【1/2】分析与制定计划");
});

test("uses the last SDK result to decide execution success", () => {
  const errorPayload = {
    subtype: "error",
    totalCostUsd: 0.1,
    usage: { input_tokens: 1 },
    result: "subagent failed",
  };
  const successPayload = {
    subtype: "success",
    totalCostUsd: 0.2,
    usage: { input_tokens: 2 },
  };

  expect(extractSdkRunFailure(errorPayload)).toBe("subagent failed");
  expect(extractSdkRunFailure(successPayload)).toBeNull();

  let executionFailure: string | undefined = extractSdkRunFailure(errorPayload) ?? undefined;
  executionFailure = extractSdkRunFailure(successPayload) ?? undefined;
  expect(executionFailure).toBeUndefined();
});

test("extracts SDK error results for execution rollback", () => {
  expect(
    extractSdkRunFailure({
      type: "result",
      subtype: "error",
      result: "Claude Code returned an error result: model not found",
    }),
  ).toBe("Claude Code returned an error result: model not found");
  expect(extractSdkRunFailure({ type: "result", subtype: "success", result: "ok" })).toBeNull();
  expect(
    extractSdkRunFailure({
      subtype: "error",
      totalCostUsd: 0.1,
      result: "model not found",
    }),
  ).toBe("model not found");
});

test("extracts SDK terminal_reason failures without treating deferred plans as errors", () => {
  expect(
    extractSdkRunFailure({
      type: "result",
      subtype: "success",
      terminal_reason: "api_error",
      api_error_status: 529,
    }),
  ).toBe("上游模型过载，请稍后重试或切换 Provider。");
  expect(
    extractSdkRunFailure({
      type: "result",
      subtype: "success",
      terminal_reason: "tool_deferred",
    }),
  ).toBeNull();
  expect(
    extractSdkRunFailure({
      type: "result",
      subtype: "success",
      terminal_reason: "completed",
    }),
  ).toBeNull();
  expect(
    extractSdkRunFailure({
      type: "result",
      subtype: "success",
      is_error: true,
      errors: ["turn setup failed"],
      terminal_reason: "turn_setup_failed",
    }),
  ).toBe("turn setup failed");
});

test("extracts structured incomplete SDK terminal results", () => {
  expect(
    extractSdkRunIncompleteReason({
      type: "result",
      subtype: "success",
      stop_reason: "max_tokens",
      terminal_reason: "completed",
    }),
  ).toContain("max_tokens");
  expect(
    extractSdkRunIncompleteReason({
      type: "result",
      subtype: "success",
      stop_reason: "end_turn",
      terminal_reason: "stop_hook_prevented",
    }),
  ).toContain("stop_hook_prevented");
  expect(
    extractSdkRunIncompleteReason({
      type: "result",
      subtype: "success",
      stop_reason: "end_turn",
      terminal_reason: "completed",
    }),
  ).toBeNull();
});

test("creates plan.ready event with transcript payload", () => {
  const event = createPlanReadyEvent("thr_1", {
    userPrompt: "Add styles",
    analysis: "Need CSS",
    plan: "1. Edit styles.css",
  });
  expect(event.type).toBe("plan.ready");
  expect(formatAgentEventLine(event)).toBe("计划已生成，等待确认。");
});

test("appends stream deltas into phase transcript", () => {
  let transcript = "";
  transcript = appendToPhaseTranscript(transcript, {
    id: "1",
    threadId: "thr_1",
    agentId: "a",
    role: "main",
    type: "message.delta",
    timestamp: "",
    payload: {
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "hel" } },
    },
  });
  transcript = appendToPhaseTranscript(transcript, {
    id: "2",
    threadId: "thr_1",
    agentId: "a",
    role: "main",
    type: "message.delta",
    timestamp: "",
    payload: {
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "lo" } },
    },
  });
  expect(transcript).toBe("hello");
});

test("formats assistant, thinking, and stream payloads for UI output", () => {
  expect(
    formatSdkPayloadMessage({
      type: "assistant",
      message: {
        content: [{ type: "text", text: "Hello from the agent." }],
      },
    }),
  ).toBe("Hello from the agent.");

  expect(
    formatSdkPayloadMessage({
      type: "assistant",
      message: {
        content: [{ type: "thinking", thinking: "Let me inspect the repo layout first." }],
      },
    }),
  ).toBe("Let me inspect the repo layout first.");

  expect(
    formatSdkPayloadMessage({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "partial" },
      },
    }),
  ).toBe("partial");

  expect(
    formatSdkPayloadMessage({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "thinking_delta", thinking: "Planning the patch…" },
      },
    }),
  ).toBe("Planning the patch…");

  expect(
    formatSdkPayloadMessage({
      type: "eco_stream",
      blockKind: "text",
      text: "Final answer from assistant.",
      streamFinalize: true,
    }),
  ).toBe("Final answer from assistant.");

  const toolDisplay = formatAgentEventDisplay({
    type: "tool.started",
    role: "coder",
    payload: {
      type: "tool_use",
      tool_name: "Read",
      input: { file_path: "/tmp/project/src/styles.css", offset: 120, limit: 40 },
    },
  });
  expect(toolDisplay).toEqual({
    message: "Tool: Read · styles.css:L120-159",
    role: "coder",
    stream: false,
  });

  const askDisplay = formatAgentEventDisplay({
    type: "tool.started",
    role: "main",
    payload: {
      type: "tool_use",
      tool_name: "AskUserQuestion",
      input: {
        questions: [{ question: "导出未建联名单要按哪个建联口径筛选？", options: [{ label: "A" }] }],
      },
    },
  });
  expect(askDisplay?.message).toContain("导出未建联");

  const webSearchDisplay = formatAgentEventDisplay({
    type: "tool.started",
    role: "main",
    payload: {
      type: "tool_use",
      tool_name: "WebSearch",
      input: { query: "flutter keyboard dismiss" },
    },
  });
  expect(webSearchDisplay?.message).toBe("Tool: WebSearch · flutter keyboard dismiss");

  const agentDisplay = formatAgentEventDisplay({
    type: "tool.started",
    role: "main",
    payload: {
      type: "tool_use",
      tool_name: "Agent",
      input: { subagent_type: "coder", prompt: "Add markdown rendering" },
    },
  });
  expect(agentDisplay?.role).toBe("coder");
  const mission = parseSubagentMissionMessage(agentDisplay?.message ?? "");
  expect(mission?.role).toBe("coder");
  expect(mission?.summary).toContain("markdown");

  const assistantEvents = mapSdkMessageToEvents(
    {
      type: "assistant",
      uuid: "sdk_3",
      session_id: "session_1",
      message: {
        content: [
          { type: "text", text: "Already streamed elsewhere." },
          { type: "tool_use", name: "Read", input: { file_path: "/tmp/a.ts" } },
        ],
      },
    },
    "thr_1",
  );
  expect(assistantEvents.length).toBeGreaterThanOrEqual(1);
  expect(
    assistantEvents.some(
      (event) =>
        event.type === "message.delta" &&
        formatAgentEventDisplay(event)?.message === "Already streamed elsewhere.",
    ),
  ).toBe(true);
  expect(assistantEvents.some((event) => event.type === "tool.started")).toBe(true);

  expect(
    inferActivityRole({
      type: "message.delta",
      role: "main",
      payload: {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: { type: "thinking_delta", thinking: "hmm" },
        },
      },
    }),
  ).toBe("thinking");
});

test("skips assistant text and thinking blocks already emitted by stream events", () => {
  const ctx = createSdkStreamContext();
  const streamInputs = [
    {
      type: "stream_event",
      uuid: "stream_thinking_start",
      session_id: "session_1",
      event: { type: "content_block_start", index: 0, content_block: { type: "thinking" } },
    },
    {
      type: "stream_event",
      uuid: "stream_thinking_delta",
      session_id: "session_1",
      event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm" } },
    },
    {
      type: "stream_event",
      uuid: "stream_thinking_stop",
      session_id: "session_1",
      event: { type: "content_block_stop", index: 0 },
    },
    {
      type: "stream_event",
      uuid: "stream_text_start",
      session_id: "session_1",
      event: { type: "content_block_start", index: 1, content_block: { type: "text" } },
    },
    {
      type: "stream_event",
      uuid: "stream_text_delta",
      session_id: "session_1",
      event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Final answer." } },
    },
    {
      type: "stream_event",
      uuid: "stream_text_stop",
      session_id: "session_1",
      event: { type: "content_block_stop", index: 1 },
    },
  ];
  for (const input of streamInputs) {
    mapSdkMessageToEvents(input, "thr_1", ctx);
  }

  const assistantEvents = mapSdkMessageToEvents(
    {
      type: "assistant",
      uuid: "assistant_final",
      session_id: "session_1",
      message: {
        content: [
          { type: "thinking", thinking: "hmm" },
          { type: "text", text: "Final answer." },
        ],
      },
    },
    "thr_1",
    ctx,
  );

  expect(assistantEvents.filter((event) => event.type === "message.delta")).toEqual([]);
});

test("skips assistant text replay even when stream and final block indexes differ", () => {
  const ctx = createSdkStreamContext();
  const streamInputs = [
    {
      type: "stream_event",
      uuid: "stream_text_start",
      session_id: "session_1",
      event: { type: "content_block_start", index: 1, content_block: { type: "text" } },
    },
    {
      type: "stream_event",
      uuid: "stream_text_delta",
      session_id: "session_1",
      event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "收到2" } },
    },
    {
      type: "stream_event",
      uuid: "stream_text_stop",
      session_id: "session_1",
      event: { type: "content_block_stop", index: 1 },
    },
  ];
  for (const input of streamInputs) {
    mapSdkMessageToEvents(input, "thr_1", ctx);
  }

  const assistantEvents = mapSdkMessageToEvents(
    {
      type: "assistant",
      uuid: "assistant_final",
      session_id: "session_1",
      message: {
        content: [{ type: "text", text: "收到2" }],
      },
    },
    "thr_1",
    ctx,
  );

  expect(assistantEvents.filter((event) => event.type === "message.delta")).toEqual([]);
});

test("keeps forwarded subagent text after main-session stream output", () => {
  const ctx = createSdkStreamContext({
    resolveSubagentAgentId: ({ parentToolUseId }) =>
      parentToolUseId === "call_explore" ? "agent_explore" : undefined,
  });
  mapSdkMessageToEvents(
    {
      type: "stream_event",
      uuid: "main_start",
      session_id: "session_1",
      event: { type: "message_start", message: { id: "main_message" } },
    },
    "thr_1",
    ctx,
  );
  mapSdkMessageToEvents(
    {
      type: "stream_event",
      uuid: "main_text",
      session_id: "session_1",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "主代理输出" },
      },
    },
    "thr_1",
    ctx,
  );

  const subagentEvents = mapSdkMessageToEvents(
    {
      type: "assistant",
      uuid: "subagent_final",
      session_id: "session_1",
      parent_tool_use_id: "call_explore",
      subagent_type: "eco_explore",
      message: {
        id: "subagent_message",
        content: [{ type: "text", text: "完整探索结论" }],
      },
    },
    "thr_1",
    ctx,
  );

  expect(subagentEvents).toHaveLength(1);
  expect(subagentEvents[0]).toMatchObject({
    type: "message.delta",
    role: "explore",
    agentId: "agent_explore",
    payload: {
      text: "完整探索结论",
      parent_tool_use_id: "call_explore",
      messageId: "subagent_message",
    },
  });
});

test("ignores SDK messages without displayable text", () => {
  expect(
    mapSdkMessageToEvents(
      {
        type: "system",
        subtype: "thinking_tokens",
        estimated_tokens: 42,
        estimated_tokens_delta: 3,
        uuid: "sdk_2",
        session_id: "session_1",
      },
      "thr_1",
    ),
  ).toEqual([]);
});

test("maps assistant message usage to usage.recorded events", () => {
  const events = mapSdkMessageToEvents(
    {
      type: "assistant",
      uuid: "sdk_u1",
      session_id: "session_1",
      message: {
        id: "msg_abc",
        usage: { input_tokens: 1200, output_tokens: 80 },
        content: [{ type: "text", text: "ok" }],
      },
    },
    "thr_1",
  );

  const usageEvent = events.find((event) => event.type === "usage.recorded");
  expect(usageEvent).toBeDefined();
  expect((usageEvent?.payload as { messageId?: string }).messageId).toBe("msg_abc");
});

/**
 * Adapter-boundary contract: SDKAssistantMessage.request_id (from Gateway response
 * `request-id` header per Anthropic client) must surface on usage.recorded / stream
 * payloads as request_id for desktop exact late-bind. This does NOT prove end-to-end
 * Agent SDK CLI header→message wiring; that remains package-source evidence.
 */
test("adapter contract: assistant request_id is threaded into usage.recorded payload", () => {
  const events = mapSdkMessageToEvents(
    {
      type: "assistant",
      uuid: "sdk_req_id",
      session_id: "session_1",
      request_id: "req_logical_from_gateway",
      parent_tool_use_id: "tool_parent_bind",
      subagent_type: "eco_coder",
      message: {
        id: "msg_bind",
        usage: { input_tokens: 10, output_tokens: 4 },
        content: [{ type: "text", text: "bound" }],
      },
    },
    "thr_1",
  );

  const usageEvent = events.find((event) => event.type === "usage.recorded");
  expect(usageEvent).toBeDefined();
  expect((usageEvent?.payload as { request_id?: string }).request_id).toBe("req_logical_from_gateway");
  const textEvent = events.find(
    (event) =>
      event.type === "message.delta" &&
      event.payload &&
      typeof event.payload === "object" &&
      !Array.isArray(event.payload) &&
      (event.payload as { blockKind?: string }).blockKind === "text",
  );
  expect((textEvent?.payload as { request_id?: string } | undefined)?.request_id).toBe(
    "req_logical_from_gateway",
  );
  // Must not leak into user-visible display text.
  expect(formatAgentEventDisplay(textEvent!)?.message).toBe("bound");
});

test("propagates parent_tool_use_id onto assistant usage events for billing attribution", () => {
  const events = mapSdkMessageToEvents(
    {
      type: "assistant",
      uuid: "sdk_sub_usage",
      session_id: "session_1",
      parent_tool_use_id: "tool_parent_1",
      subagent_type: "eco_explore",
      message: {
        id: "msg_sub",
        usage: { input_tokens: 500, output_tokens: 40 },
        content: [{ type: "text", text: "found it" }],
      },
    },
    "thr_1",
  );

  const usageEvent = events.find((event) => event.type === "usage.recorded");
  expect(usageEvent).toBeDefined();
  const payload = usageEvent?.payload as Record<string, unknown>;
  expect(payload.parent_tool_use_id).toBe("tool_parent_1");
  expect(payload.subagent_type).toBe("eco_explore");
});

test("does not attribute main assistant or result usage to a stale subagent stream context", () => {
  const ctx = createSdkStreamContext({
    resolveSubagentAgentId() {
      return "agent_stale_subagent";
    },
  });
  ctx.parentToolUseId = "toolu_stale";

  const assistantEvents = mapSdkMessageToEvents(
    {
      type: "assistant",
      uuid: "sdk_main_usage",
      session_id: "session_1",
      message: {
        id: "msg_main",
        usage: { input_tokens: 900, output_tokens: 90 },
        content: [{ type: "text", text: "final answer" }],
      },
    },
    "thr_1",
    ctx,
  );
  const assistantUsage = assistantEvents.find((event) => event.type === "usage.recorded");
  expect(assistantUsage?.agentId).toBe("session_1");
  expect((assistantUsage?.payload as Record<string, unknown>).parent_tool_use_id).toBeUndefined();

  const resultEvents = mapSdkMessageToEvents(
    {
      type: "result",
      subtype: "success",
      uuid: "sdk_result",
      session_id: "session_1",
      total_cost_usd: 0.5,
      usage: { input_tokens: 100, output_tokens: 20 },
      modelUsage: { "claude-opus-4": { input_tokens: 100 } },
    },
    "thr_1",
    ctx,
  );
  const resultUsage = resultEvents.find((event) => event.type === "usage.recorded");
  expect(resultUsage?.agentId).toBe("session_1");
  expect((resultUsage?.payload as Record<string, unknown>).parent_tool_use_id).toBeUndefined();
});

test("preserves subagent metadata on tool_use events", () => {
  const events = mapSdkMessageToEvents(
    {
      type: "assistant",
      uuid: "sdk_subagent_1",
      session_id: "session_coder_1",
      parent_tool_use_id: "tool_parent_1",
      subagent_type: "coder",
      message: {
        content: [
          {
            type: "tool_use",
            id: "tool_child_1",
            name: "Read",
            input: { file_path: "/tmp/work.ts" },
          },
        ],
      },
    },
    "thr_1",
  );

  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    type: "tool.started",
    agentId: "session_coder_1",
    role: "coder",
    payload: {
      type: "tool_use",
      tool_name: "Read",
      tool_use_id: "tool_child_1",
      parent_tool_use_id: "tool_parent_1",
      subagent_type: "coder",
    },
  });
});

test("maps SDK result messages to usage and run.terminal events", () => {
  const events = mapSdkMessageToEvents(
    {
      type: "result",
      subtype: "success",
      uuid: "sdk_1",
      session_id: "session_1",
      total_cost_usd: 0.12,
      usage: { input_tokens: 10, output_tokens: 20 },
      modelUsage: { "claude-opus-4": { input_tokens: 10 } },
    },
    "thr_1",
  );

  expect(events).toHaveLength(2);
  expect(events[0]).toMatchObject({
    id: "sdk_1:usage",
    type: "usage.recorded",
    agentId: "session_1",
  });
  expect(events[1]).toMatchObject({
    id: "sdk_1:run-terminal",
    type: "run.terminal",
    agentId: "session_1",
    payload: { status: "completed" },
  });
});

test("preserves SDK result failure metadata on usage events and run.terminal", () => {
  const events = mapSdkMessageToEvents(
    {
      type: "result",
      subtype: "success",
      uuid: "sdk_terminal_failure",
      session_id: "session_1",
      is_error: true,
      terminal_reason: "api_error",
      api_error_status: 529,
      errors: ["upstream overloaded"],
      total_cost_usd: 0.01,
      usage: { input_tokens: 10, output_tokens: 0 },
      modelUsage: {},
    },
    "thr_1",
  );

  expect(events[0]?.payload).toMatchObject({
    type: "result",
    subtype: "success",
    is_error: true,
    terminal_reason: "api_error",
    api_error_status: 529,
    errors: ["upstream overloaded"],
  });
  expect(extractSdkRunFailure(events[0]?.payload)).toBe("上游模型过载，请稍后重试或切换 Provider。");
  expect(events[1]).toMatchObject({
    type: "run.terminal",
    payload: { status: "failed", error: "上游模型过载，请稍后重试或切换 Provider。" },
  });
});

test("formatAgentEventLine omits usage.recorded display text", () => {
  expect(
    formatAgentEventLine({
      type: "usage.recorded",
      payload: { totalCostUsd: 2.1695, usage: { input_tokens: 1, output_tokens: 1 } },
      role: "main",
    }),
  ).toBeNull();
});

test("formatSdkPayloadMessage omits result cost lines", () => {
  expect(
    formatAgentEventLine({
      type: "tool.completed",
      payload: { type: "result", total_cost_usd: 2.1695, subtype: "success" },
      role: "main",
    }),
  ).toBeNull();
});

test("createToolPermissionDeniedEvent formats audit-friendly tool failures", () => {
  const event = createToolPermissionDeniedEvent(
    "thr_1",
    {
      permissionDecision: "deny",
      toolName: "Bash",
      toolUseId: "tool_denied",
      reason: "Bash is disabled for this Mori agent.",
      actor: "eco_researcher",
      sessionId: "session_1",
      agentId: "agent_researcher",
      agentType: "eco_researcher",
      cwd: "/repo",
    },
    () => "uuid_1",
  );

  expect(event).toMatchObject({
    id: "thr_1:tool-permission-denied:tool_denied:uuid_1",
    type: "tool.failed",
    agentId: "agent_researcher",
    payload: {
      type: "tool_permission_denied",
      tool_name: "Bash",
      tool_use_id: "tool_denied",
      message: "Bash is disabled for this Mori agent.",
      actor: "eco_researcher",
    },
  });
  expect(formatAgentEventLine(event)).toBe(
    "Permission denied for Bash: Bash is disabled for this Mori agent.",
  );
  expect(inferActivityRole(event)).toBe("tool");
});

test("adapts SDK permission callbacks to app approval decisions", async () => {
  const canUseTool = createCanUseTool(async (request) => {
    expect(request.toolName).toBe("Bash");
    expect(request.toolUseId).toBe("tool_1");
    expect(request.requestId).toBe("req_1");
    expect(request.agentId).toBe("agent_1");
    expect(request.agentType).toBe("eco_coder");
    expect(request.cwd).toBe("/tmp/workspace");
    expect(request.title).toBe("Claude wants to run a command");
    expect(request.displayName).toBe("Run command");
    expect(request.description).toBe("rm -rf src");
    return { behavior: "deny", message: "Approval required", interrupt: true };
  });

  const decision = await canUseTool(
    "Bash",
    { command: "rm -rf src" },
    {
      toolUseID: "tool_1",
      requestId: "req_1",
      agentID: "agent_1",
      agentType: "eco_coder",
      cwd: "/tmp/workspace",
      title: "Claude wants to run a command",
      displayName: "Run command",
      description: "rm -rf src",
      signal: new AbortController().signal,
    },
  );

  expect(decision).toEqual({
    behavior: "deny",
    message: "Approval required",
    interrupt: true,
  });
});

test("canUseTool denies honestly when the permission AbortSignal is already aborted", async () => {
  let handlerCalled = false;
  const canUseTool = createCanUseTool(async () => {
    handlerCalled = true;
    return { behavior: "allow" };
  });
  const controller = new AbortController();
  controller.abort();

  const decision = await canUseTool(
    "Read",
    { file_path: "a.ts" },
    {
      toolUseID: "tool_aborted",
      signal: controller.signal,
    },
  );

  expect(handlerCalled).toBe(false);
  expect(decision).toMatchObject({
    behavior: "deny",
    message: expect.stringContaining("not a user denial"),
  });
});

test("canUseTool does not auto-allow ExitPlanMode during user-approval", async () => {
  let handlerCalled = false;
  const canUseTool = createCanUseTool(
    async () => {
      handlerCalled = true;
      return { behavior: "allow" };
    },
    { planModeToolPolicy: "user-approval" },
  );

  const decision = await canUseTool(
    "ExitPlanMode",
    { plan: "## Plan\n\nShip it." },
    { toolUseID: "tool_plan", signal: new AbortController().signal },
  );

  expect(handlerCalled).toBe(false);
  expect(decision).toMatchObject({
    behavior: "deny",
    interrupt: true,
  });
});

test("canUseTool waits for Eco plan approval before allowing ExitPlanMode", async () => {
  let handlerCalled = false;
  let resolveApproval!: (decision: "approved" | "denied") => void;
  const approval = new Promise<"approved" | "denied">((resolve) => {
    resolveApproval = resolve;
  });
  const canUseTool = createCanUseTool(
    async () => {
      handlerCalled = true;
      return { behavior: "allow" };
    },
    {
      planModeToolPolicy: "user-approval",
      awaitPlanApproval: async () => approval,
    },
  );

  const pending = canUseTool(
    "ExitPlanMode",
    { plan: "## Plan\n\nShip it." },
    { toolUseID: "tool_plan", signal: new AbortController().signal },
  );
  let settled = false;
  void pending.then(() => {
    settled = true;
  });
  await Promise.resolve();
  expect(handlerCalled).toBe(false);
  expect(settled).toBe(false);

  resolveApproval("approved");
  await expect(pending).resolves.toMatchObject({
    behavior: "allow",
    updatedInput: { plan: "## Plan\n\nShip it." },
  });
  expect(handlerCalled).toBe(false);
});

test("canUseTool denies ExitPlanMode when Eco plan approval is denied", async () => {
  let handlerCalled = false;
  const canUseTool = createCanUseTool(
    async () => {
      handlerCalled = true;
      return { behavior: "allow" };
    },
    {
      planModeToolPolicy: "user-approval",
      awaitPlanApproval: async () => "denied",
    },
  );

  const decision = await canUseTool(
    "ExitPlanMode",
    { plan: "## Plan\n\nShip it." },
    { toolUseID: "tool_plan", signal: new AbortController().signal },
  );

  expect(handlerCalled).toBe(false);
  expect(decision).toMatchObject({
    behavior: "deny",
    interrupt: false,
  });
});

test("canUseTool refuses other Plan Mode tools before generic approval handler", async () => {
  let handlerCalled = false;
  const canUseTool = createCanUseTool(async () => {
    handlerCalled = true;
    return { behavior: "allow" };
  });

  const decision = await canUseTool(
    "EnterPlanMode",
    {},
    { toolUseID: "tool_enter", signal: new AbortController().signal },
  );

  expect(handlerCalled).toBe(false);
  expect(decision).toMatchObject({
    behavior: "deny",
    interrupt: true,
  });
  expect(decision.message).toBe("Plan Mode tools are unavailable in Agent and Ask sessions.");
});

test("canUseTool denies ExitPlanMode in Agent mode before generic auto-approval", async () => {
  let handlerCalled = false;
  const canUseTool = createCanUseTool(async () => {
    handlerCalled = true;
    return { behavior: "allow" };
  });

  const decision = await canUseTool(
    "ExitPlanMode",
    { plan: "## Plan\n\nUnexpected." },
    { toolUseID: "tool_unexpected", signal: new AbortController().signal },
  );

  expect(handlerCalled).toBe(false);
  expect(decision).toMatchObject({ behavior: "deny", interrupt: true });
  expect(decision.message).toBe("Plan Mode tools are unavailable in Agent and Ask sessions.");
});

test("canUseTool completes only the exact approved deferred ExitPlanMode call", async () => {
  const canUseTool = createCanUseTool(async () => ({ behavior: "allow" }), {
    planModeToolPolicy: "resume-approved-exit",
    approvedExitPlanToolUseId: "tool_approved",
  });

  const approved = await canUseTool(
    "ExitPlanMode",
    { plan: "## Plan\n\nApproved." },
    { toolUseID: "tool_approved", signal: new AbortController().signal },
  );
  const unexpected = await canUseTool(
    "ExitPlanMode",
    { plan: "## Plan\n\nUnexpected." },
    { toolUseID: "tool_other", signal: new AbortController().signal },
  );

  expect(approved).toMatchObject({ behavior: "allow" });
  expect(unexpected).toMatchObject({ behavior: "deny", interrupt: true });
});

test("maps SDK compact_boundary system messages", () => {
  const message = {
    type: "system",
    subtype: "compact_boundary",
    uuid: "sdk_compact_1",
    session_id: "session_1",
    compact_metadata: {
      trigger: "auto",
      pre_tokens: 180_000,
      post_tokens: 42_000,
    },
  };
  expect(isCompactBoundarySdkMessage(message)).toBe(true);

  const events = mapSdkMessageToEvents(message, "thr_1");
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    type: "agent.started",
    payload: {
      type: "system",
      subtype: "compact_boundary",
      session_id: "session_1",
      compact_metadata: {
        trigger: "auto",
        pre_tokens: 180_000,
        post_tokens: 42_000,
      },
    },
  });
});

test("maps standalone compact_boundary message type", () => {
  const message = {
    type: "compact_boundary",
    uuid: "sdk_compact_2",
    session_id: "session_1",
    compact_metadata: { trigger: "manual", pre_tokens: 100_000 },
  };
  expect(isCompactBoundarySdkMessage(message)).toBe(true);
  const events = mapSdkMessageToEvents(message, "thr_1");
  expect(events[0]?.payload).toMatchObject({
    subtype: "compact_boundary",
    compact_metadata: { trigger: "manual", pre_tokens: 100_000 },
  });
});

test("maps SDK task_progress system messages to todo.updated events", () => {
  const events = mapSdkMessageToEvents(
    {
      type: "system",
      subtype: "task_progress",
      task_id: "task_abc",
      description: "Inspecting auth module",
      last_tool_name: "Read",
      uuid: "sdk_task_1",
      session_id: "session_1",
    },
    "thr_1",
  );

  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    type: "todo.updated",
    payload: {
      sdkKind: "task_progress",
      task_id: "task_abc",
      description: "Inspecting auth module",
    },
  });
});

test("maps SDK task_started system messages to todo.updated with ambient fields", () => {
  const events = mapSdkMessageToEvents(
    {
      type: "system",
      subtype: "task_started",
      task_id: "task_abc",
      description: "Review changes",
      ambient: true,
      is_backgrounded: true,
      spawn_depth: 2,
      uuid: "sdk_task_1",
      session_id: "session_1",
    },
    "thr_1",
  );

  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    type: "todo.updated",
    payload: {
      sdkKind: "task_started",
      task_id: "task_abc",
      description: "Review changes",
      ambient: true,
      is_backgrounded: true,
      spawn_depth: 2,
    },
  });
  expect(formatAgentEventLine(events[0]!)).toBeNull();
});

test("reads the Claude background task level signal without inventing task identities", () => {
  expect(
    readClaudeBackgroundTasksChanged({
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [
        {
          task_id: "shell_1",
          task_type: "local_bash",
          description: "bun run dev",
        },
        {
          task_id: "",
          task_type: "local_bash",
          description: "invalid",
        },
        {
          task_id: "agent_1",
          task_type: "local_agent",
          description: "Explore code",
        },
      ],
    }),
  ).toEqual([
    {
      taskId: "shell_1",
      taskType: "local_bash",
      description: "bun run dev",
    },
    {
      taskId: "agent_1",
      taskType: "local_agent",
      description: "Explore code",
    },
  ]);
  expect(readClaudeBackgroundTasksChanged({ type: "system", subtype: "task_started" })).toBeUndefined();
});

test("maps task_notification with resource_links and ambient", () => {
  const events = mapSdkMessageToEvents(
    {
      type: "system",
      subtype: "task_notification",
      task_id: "task_done",
      status: "completed",
      ambient: true,
      resource_links: [{ uri: "file:///tmp/out.md", name: "out.md", title: "Output" }],
      uuid: "sdk_task_note",
      session_id: "session_1",
    },
    "thr_1",
  );

  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    type: "todo.updated",
    payload: {
      sdkKind: "task_notification",
      task_id: "task_done",
      status: "completed",
      ambient: true,
      resource_links: [{ uri: "file:///tmp/out.md", name: "out.md", title: "Output" }],
    },
  });
});

test("maps SDK result user_message_uuid(s) and queued_turn_count onto usage.recorded", () => {
  const events = mapSdkMessageToEvents(
    {
      type: "result",
      subtype: "success",
      uuid: "result_1",
      session_id: "session_1",
      total_cost_usd: 0.05,
      user_message_uuid: "user-last",
      user_message_uuids: ["user-a", "user-last"],
      queued_turn_count: 2,
    },
    "thr_1",
  );

  expect(events[0]).toMatchObject({
    type: "usage.recorded",
    payload: {
      type: "result",
      user_message_uuid: "user-last",
      user_message_uuids: ["user-a", "user-last"],
      queued_turn_count: 2,
    },
  });
});

test("maps tool_use_result resourceLinks onto tool.completed", () => {
  const ctx = createSdkStreamContext();
  mapSdkMessageToEvents(
    {
      type: "assistant",
      uuid: "assistant_read",
      session_id: "session_1",
      message: {
        content: [{ type: "tool_use", id: "call_read", name: "Read", input: { file_path: "a.ts" } }],
      },
    },
    "thr_1",
    ctx,
  );

  const events = mapSdkMessageToEvents(
    {
      type: "user",
      uuid: "user_tool",
      session_id: "session_1",
      tool_use_result: {
        resourceLinks: [{ uri: "file:///tmp/a.ts", name: "a.ts" }],
      },
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "call_read", content: "ok" }],
      },
    },
    "thr_1",
    ctx,
  );

  expect(events[0]).toMatchObject({
    type: "tool.completed",
    payload: {
      type: "tool_result",
      tool_name: "Read",
      resource_links: [{ uri: "file:///tmp/a.ts", name: "a.ts" }],
    },
  });
});

test("formatAgentEventLine renders todo.updated task progress for activity", () => {
  expect(
    formatAgentEventLine({
      type: "todo.updated",
      role: "main",
      payload: {
        sdkKind: "task_progress",
        task_id: "task_abc",
        description: "Inspecting auth module",
        last_tool_name: "Read",
      },
    }),
  ).toBe("Tool: Read · Inspecting auth module");

  expect(
    inferActivityRole({
      type: "todo.updated",
      role: "main",
      payload: {
        sdkKind: "task_started",
        task_id: "task_abc",
        description: "Implement feature",
        subagent_type: "coder",
      },
    }),
  ).toBe("coder");
});

test("applyResumeToQueryOptions sets resume, resumeDropsTurn, and forkSession", () => {
  const options: Record<string, unknown> = {};
  applyResumeToQueryOptions(options, {
    resumeSessionId: "sess-123",
    resumeSessionAt: "msg-prev",
    resumeDropsTurn: "user-2",
    forkSession: true,
  });
  expect(options.resume).toBe("sess-123");
  expect(options.resumeSessionAt).toBe("msg-prev");
  expect(options.resumeDropsTurn).toBe("user-2");
  expect(options.forkSession).toBe(true);
});

test("a pending clear initializes its allocated ID without loading the old transcript", () => {
  const options: Record<string, unknown> = {};
  applyResumeToQueryOptions(options, { newSessionId: "reset-uuid" });
  expect(options).toEqual({ sessionId: "reset-uuid" });
  expect(() =>
    applyResumeToQueryOptions(
      {},
      {
        newSessionId: "reset-uuid",
        resumeSessionId: "old-uuid",
      },
    ),
  ).toThrow("cannot also resume or fork");
});

test("resolveResumeSessionAtBeforeUserMessage returns last chain entry before target user", async () => {
  const resumeAt = await resolveResumeSessionAtBeforeUserMessage({
    sessionId: "sess-123",
    userMessageId: "user-2",
    loadSdk: async () => ({
      query: (() => {
        throw new Error("not used");
      }) as never,
      getSessionMessages: async () => [
        { type: "user", uuid: "user-1" },
        { type: "assistant", uuid: "assistant-1" },
        { type: "user", uuid: "user-2" },
        { type: "assistant", uuid: "assistant-2" },
      ],
    }),
  });

  expect(resumeAt).toBe("assistant-1");
});

test("resolveResumeSessionAtBeforeUserMessage keeps tool_result tail as fork point", async () => {
  const resumeAt = await resolveResumeSessionAtBeforeUserMessage({
    sessionId: "sess-123",
    userMessageId: "user-2",
    loadSdk: async () => ({
      query: (() => {
        throw new Error("not used");
      }) as never,
      getSessionMessages: async () => [
        { type: "user", uuid: "user-1" },
        { type: "assistant", uuid: "assistant-1" },
        { type: "user", uuid: "tool-result-1" }, // kept-turn tail (any chain uuid)
        { type: "user", uuid: "user-2" },
      ],
    }),
  });

  expect(resumeAt).toBe("tool-result-1");
});

test("resolveResumeSessionAtBeforeUserMessage returns undefined for first user message", async () => {
  const resumeAt = await resolveResumeSessionAtBeforeUserMessage({
    sessionId: "sess-123",
    userMessageId: "user-1",
    loadSdk: async () => ({
      query: (() => {
        throw new Error("not used");
      }) as never,
      getSessionMessages: async () => [
        { type: "user", uuid: "user-1" },
        { type: "assistant", uuid: "assistant-1" },
      ],
    }),
  });

  expect(resumeAt).toBeUndefined();
});

test("extractSdkRunFailure formats resumeDropsTurn refusals without inviting retry", async () => {
  const { extractSdkRunFailure, isResumeDropsTurnRejection, formatResumeDropsTurnRejection } = await import(
    "../src/claude-agent-sdk"
  );
  const raw = "Resume rejected by --resume-drops-turn: discarded range has extra user message";
  expect(isResumeDropsTurnRejection(raw)).toBe(true);
  const failure = extractSdkRunFailure({
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    result: raw,
  });
  expect(failure).toBe(formatResumeDropsTurnRejection(raw));
  expect(failure).toContain("不会重试同一 fork");
});

test("interruptOrCloseSdkQuery passes cancelQueued true by default", async () => {
  let interruptArgs: unknown;
  const probes: Array<{ phase: string; detail: Record<string, unknown> }> = [];
  const receipt = await interruptOrCloseSdkQuery(
    {
      async *[Symbol.asyncIterator]() {},
      interrupt: async (options) => {
        interruptArgs = options;
        return { still_queued: [], cancelled: ["queued-1"] };
      },
    },
    (phase, detail) => {
      probes.push({ phase, detail });
    },
  );

  expect(interruptArgs).toEqual({ cancelQueued: true });
  expect(receipt).toEqual({ still_queued: [], cancelled: ["queued-1"] });
  expect(probes[0]).toMatchObject({
    phase: "interrupt",
    detail: { still_queued: [], cancelled: ["queued-1"] },
  });
});

test("teardownClaudeQueryHandle returns cancelled uuids from interrupt receipt", async () => {
  const result = await teardownClaudeQueryHandle(
    {
      query: {
        async *[Symbol.asyncIterator]() {},
        interrupt: async (options) => {
          expect(options).toEqual({ cancelQueued: true });
          return { still_queued: ["survive"], cancelled: ["drop-me"] };
        },
        close: () => {},
      },
      phase: "open",
    },
    {
      shouldInterrupt: true,
      drainDeadlineMs: 10,
    },
  );

  expect(result).toMatchObject({
    stillQueued: ["survive"],
    cancelled: ["drop-me"],
    interrupted: true,
    closed: true,
  });
});

test("applyClaudeJsonlSessionPersistence applies local JSONL persistence without file checkpointing", () => {
  const options: Record<string, unknown> = {
    sessionStore: { append: async () => {}, load: async () => null },
    extraArgs: { existing: "value" },
  };
  applyClaudeJsonlSessionPersistence(options);
  expect(options.sessionStore).toBeUndefined();
  expect(options.enableFileCheckpointing).toBeUndefined();
  expect(options.extraArgs).toEqual({ existing: "value", "replay-user-messages": null });
});

test("readSdkUserMessageCheckpointId reads user message uuid", () => {
  expect(readSdkUserMessageCheckpointId({ type: "assistant" })).toBeUndefined();
  expect(readSdkUserMessageCheckpointId({ type: "user", uuid: "msg-checkpoint-1" })).toBe("msg-checkpoint-1");
  expect(
    readSdkUserMessageCheckpointId({
      type: "user",
      uuid: "tool-result-uuid",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "bash", content: "ok" }] },
    }),
  ).toBeUndefined();
});

test("createSessionCapturedEvent and init message helpers", () => {
  const init = {
    type: "system",
    subtype: "init",
    session_id: "sess-abc",
  };
  expect(isSdkInitMessage(init)).toBe(true);
  expect(readSdkSessionId(init)).toBe("sess-abc");

  const event = createSessionCapturedEvent("thr_1", "sess-abc", "/tmp/worktree");
  expect(event.type).toBe("session.captured");
  expect(event.payload).toEqual({ sessionId: "sess-abc", cwd: "/tmp/worktree" });
});

test("ClaudeAgentSdkDriver does not inject fallback Eco agents without a UI registry", async () => {
  const capturedOptions: Record<string, unknown>[] = [];
  const driver = new ClaudeAgentSdkDriver({
    apiKey: "test-key",
    baseUrl: "http://127.0.0.1:36037",
    loadSdk: async () => ({
      query: ({ options }) => {
        capturedOptions.push(options);
        return {
          async *[Symbol.asyncIterator]() {
            yield {
              type: "system",
              subtype: "init",
              session_id: "sess-agents",
              uuid: "init-agents",
            };
            yield {
              type: "result",
              subtype: "success",
              session_id: "sess-agents",
              uuid: "result-agents",
            };
          },
          close: () => {},
        };
      },
    }),
  });
  const runInput = {
    threadId: "thr_agents",
    prompt: "Inspect and implement",
    workspacePath: "/tmp/workspace",
    worktreePath: "/tmp/worktree",
    routes,
    sdkSession: { skills: [] },
  };

  for await (const _event of driver.run({
    ...runInput,
    signal: new AbortController().signal,
  })) {
    // drain
  }
  for await (const _event of driver.runAsk({
    ...runInput,
    signal: new AbortController().signal,
  })) {
    // drain
  }
  for await (const _event of driver.runContinuation(
    {
      ...runInput,
      signal: new AbortController().signal,
    },
    "execution",
    {
      userPrompt: "Inspect and implement",
      analysis: "Needs execution",
      plan: "Run coders and review",
    },
  )) {
    // drain
  }

  expect(capturedOptions[0]?.forwardSubagentText).toBe(true);
  for (const options of capturedOptions) {
    expect(options.skills).toEqual([]);
    expect(options.tools).toEqual(
      expect.arrayContaining([
        "Read",
        "Skill",
        "WebSearch",
        "Agent",
        "SendMessage",
        "ListAgents",
        "TaskStop",
      ]),
    );
    for (const tool of [
      "CronCreate",
      "CronDelete",
      "CronList",
      "ScheduleWakeup",
      "ReportFindings",
      "EnterWorktree",
      "ExitWorktree",
    ]) {
      expect(options.tools).not.toContain(tool);
    }
  }
  expect(capturedOptions[0]?.tools).toEqual(expect.arrayContaining(["Bash", "Write", "AskUserQuestion"]));
  expect(capturedOptions[1]?.tools).not.toContain("Bash");
  expect(capturedOptions[1]?.tools).not.toContain("Write");
  expect(capturedOptions[0]?.tools).not.toContain("ExitPlanMode");
  expect(capturedOptions[0]?.agents).toBeUndefined();
  expect(capturedOptions[1]?.agents).toBeUndefined();
  expect(capturedOptions[1]?.permissionMode).toBe("dontAsk");
  expect(capturedOptions[1]?.disallowedTools).toEqual(
    expect.arrayContaining(["Write", "Bash", "ExitPlanMode", "EnterPlanMode"]),
  );
  expect(capturedOptions[1]?.allowedTools).not.toContain("AskUserQuestion");
  expect(capturedOptions[1]?.systemPrompt).toEqual({
    type: "preset",
    preset: "claude_code",
    snapshot: false,
  });

  expect(capturedOptions[0]?.allowedTools).toContain("WebSearch");
  expect(capturedOptions[1]?.allowedTools).toContain("WebSearch");
  expect(capturedOptions[2]?.allowedTools).toContain("WebSearch");

  expect(capturedOptions[2]?.agents).toBeUndefined();
  expect(capturedOptions[2]?.systemPrompt).toEqual({
    type: "preset",
    preset: "claude_code",
    snapshot: false,
  });
});

test("ClaudeAgentSdkDriver injects only UI-enabled agent definitions and prompts", async () => {
  const capturedQueries: Array<{ prompt: string; options: Record<string, unknown> }> = [];
  const driver = new ClaudeAgentSdkDriver({
    apiKey: "test-key",
    baseUrl: "http://127.0.0.1:36037",
    loadSdk: async () => ({
      query: ({ prompt, options }) => {
        capturedQueries.push({ prompt: resolveSdkPromptCaptureText(prompt), options });
        return {
          async *[Symbol.asyncIterator]() {
            yield {
              type: "system",
              subtype: "init",
              session_id: "sess-universal",
              uuid: "init-universal",
            };
            yield {
              type: "result",
              subtype: "success",
              session_id: "sess-universal",
              uuid: "result-universal",
            };
          },
          close: () => {},
        };
      },
    }),
  });

  for await (const _event of driver.runAsk({
    threadId: "thr_universal",
    prompt: "Summarize the 2026 market landscape.",
    workspacePath: "/tmp/workspace",
    worktreePath: "/tmp/worktree",
    routes,
    signal: new AbortController().signal,
    sdkSession: {
      mcpAllowedTools: ["mcp__browser__open"],
      agentSkills: { researcher: ["workspace-research"] },
    },
    agentRegistry: universalAgentRegistry,
  })) {
    // drain
  }

  const query = capturedQueries[0];
  expect(query?.prompt).toBe("Summarize the 2026 market landscape.");
  expect(query?.prompt).not.toContain("For a known file or symbol");
  expect(query?.prompt).not.toContain("Do not create an implementation plan");

  const options = query?.options ?? {};
  // Main agent requests go through the planner role route (proxy alias) so billing
  // attributes the usage to the planner role even when models are shared across roles.
  expect(options.model).toBe("claude-opus-4");
  expect(options.permissionMode).toBe("dontAsk");
  expect(options.allowedTools).toEqual([
    "Agent",
    "TaskList",
    "TaskGet",
    "Read",
    "Glob",
    "Grep",
    "LS",
    "NotebookRead",
    "WebSearch",
    "WebFetch",
    "mcp__browser__open",
  ]);
  expect(options.allowedTools).not.toContain("AskUserQuestion");
  expect(options.allowedTools).not.toContain("Skill");

  const agents = options.agents as Record<string, Record<string, unknown>>;
  expect(Object.keys(agents)).toEqual(["eco_explore", "eco_researcher"]);
  expect(agents.eco_explore).toMatchObject({
    model: "claude-haiku-explore",
    tools: ["Read", "Glob", "Grep", "LS", "NotebookRead"],
  });
  expect(agents.eco_researcher).toMatchObject({
    // Without a researcher route in test `routes`, resolveSdkModelId falls back to planner.
    model: "claude-opus-4",
    tools: ["WebSearch", "WebFetch"],
    disallowedTools: expect.arrayContaining([
      "Bash",
      "Agent",
      "Task",
      "Write",
      "Edit",
      "MultiEdit",
      "NotebookEdit",
      "AskUserQuestion",
      "ExitPlanMode",
    ]),
    prompt: "CHILD SECRET PROMPT: find source-backed evidence.",
    mcpServers: ["sources", "browser"],
    skills: ["workspace-research"],
  });

  const systemPrompt = options.systemPrompt as Record<string, unknown>;
  expect(systemPrompt).toMatchObject({ type: "preset", preset: "claude_code" });
  expect(String(systemPrompt.append)).toContain(
    "Coordinate a research answer without assuming a coding task.",
  );
  const systemPromptAppend = String(systemPrompt.append);
  expect(systemPromptAppend).toContain("Delegate when evidence quality improves.");
  expect(systemPromptAppend).not.toContain("CHILD SECRET PROMPT");
  expect(systemPromptAppend).not.toContain("File edits apply directly");
  expect(systemPromptAppend).not.toContain("Eco universal orchestration.");
  expect(systemPromptAppend).not.toContain("Session mode:");
  expect(Object.keys(agents)).toEqual(["eco_explore", "eco_researcher"]);

  for await (const _event of driver.runAsk({
    threadId: "thr_universal_without_explore",
    prompt: "Summarize without delegating exploration.",
    workspacePath: "/tmp/workspace",
    worktreePath: "/tmp/worktree",
    routes,
    signal: new AbortController().signal,
    sdkSession: {
      enabledSubagents: {
        explore: false,
      },
    },
    agentRegistry: universalAgentRegistry,
  })) {
    // drain
  }

  const disabledExploreAgents = capturedQueries[1]?.options.agents as Record<string, Record<string, unknown>>;
  expect(Object.keys(disabledExploreAgents)).toEqual(["eco_researcher"]);

  const orchestrationWithoutExplore: EcoAgentRuntimeConfig = {
    ...universalAgentRegistry,
    orchestration: {
      ...universalAgentRegistry.orchestration,
      agents: universalAgentRegistry.orchestration.agents.filter((agent) => agent.agentKey !== "explore"),
    },
  };
  for await (const _event of driver.runAsk({
    threadId: "thr_universal_deleted_explore",
    prompt: "Summarize with the configured roster.",
    workspacePath: "/tmp/workspace",
    worktreePath: "/tmp/worktree",
    routes: routes.filter((route) => route.role !== "explore"),
    signal: new AbortController().signal,
    agentRegistry: orchestrationWithoutExplore,
  })) {
    // drain
  }
  const deletedExploreAgents = capturedQueries[2]?.options.agents as Record<string, Record<string, unknown>>;
  expect(Object.keys(deletedExploreAgents)).toEqual(["eco_researcher"]);
});

test("ClaudeAgentSdkDriver emits tool failed audit events for denied dynamic permissions", async () => {
  const capturedQueries: Array<{ prompt: string; options: Record<string, unknown> }> = [];
  const driver = new ClaudeAgentSdkDriver({
    apiKey: "test-key",
    baseUrl: "http://127.0.0.1:36037",
    loadSdk: async () => ({
      query: ({ prompt, options }) => {
        capturedQueries.push({ prompt: resolveSdkPromptCaptureText(prompt), options });
        return {
          async *[Symbol.asyncIterator]() {
            const hooks = options.hooks as
              | Record<
                  string,
                  Array<{ hooks: Array<(input: unknown, toolUseId?: string, ctx?: unknown) => unknown> }>
                >
              | undefined;
            for (const matcher of hooks?.PreToolUse ?? []) {
              for (const hook of matcher.hooks) {
                await hook(
                  {
                    hook_event_name: "PreToolUse",
                    tool_name: "Bash",
                    tool_input: { command: "rm -rf src" },
                    tool_use_id: "tool_denied",
                    session_id: "sess-denied",
                    cwd: "/tmp/workspace",
                    agent_id: "agent_researcher",
                    agent_type: "eco_researcher",
                  },
                  "tool_denied",
                  { signal: new AbortController().signal },
                );
              }
            }
            yield {
              type: "system",
              subtype: "init",
              session_id: "sess-denied",
              uuid: "init-denied",
            };
            yield {
              type: "result",
              subtype: "success",
              session_id: "sess-denied",
              uuid: "result-denied",
            };
          },
          close: () => {},
        };
      },
    }),
  });

  const events = [];
  for await (const event of driver.runAsk({
    threadId: "thr_denied",
    prompt: "Research with a denied command.",
    workspacePath: "/tmp/workspace",
    worktreePath: "/tmp/workspace",
    routes,
    signal: new AbortController().signal,
    agentRegistry: universalAgentRegistry,
  })) {
    events.push(event);
  }

  expect(capturedQueries[0]?.options.hooks).toBeDefined();
  expect(events).toContainEqual(
    expect.objectContaining({
      type: "tool.failed",
      agentId: "agent_researcher",
      payload: expect.objectContaining({
        type: "tool_permission_denied",
        tool_name: "Bash",
        tool_use_id: "tool_denied",
        actor: "eco_researcher",
      }),
    }),
  );
});

test("ClaudeAgentSdkDriver registers every UI-enabled custom agent in Agent mode", async () => {
  const capturedQueries: Array<{ prompt: string; options: Record<string, unknown> }> = [];
  const driver = new ClaudeAgentSdkDriver({
    apiKey: "test-key",
    baseUrl: "http://127.0.0.1:36037",
    loadSdk: async () => ({
      query: ({ prompt, options }) => {
        const callIndex = capturedQueries.length + 1;
        capturedQueries.push({ prompt: resolveSdkPromptCaptureText(prompt), options });
        return {
          async *[Symbol.asyncIterator]() {
            yield {
              type: "system",
              subtype: "init",
              session_id: `sess-guided-${callIndex}`,
              uuid: `init-guided-${callIndex}`,
            };
            yield {
              type: "assistant",
              uuid: `assistant-guided-${callIndex}`,
              session_id: `sess-guided-${callIndex}`,
              message: {
                content: [{ type: "text", text: `step output ${callIndex}` }],
              },
            };
            yield {
              type: "result",
              subtype: "success",
              session_id: `sess-guided-${callIndex}`,
              uuid: `result-guided-${callIndex}`,
            };
          },
          close: () => {},
        };
      },
    }),
  });

  const events: Array<{ type: string; payload: unknown }> = [];
  for await (const event of driver.run({
    threadId: "thr_guided_universal",
    prompt: "Explain the market landscape.",
    workspacePath: "/tmp/workspace",
    worktreePath: "/tmp/worktree",
    routes,
    signal: new AbortController().signal,
    agentRegistry: guidedResearchAgentRegistry,
  })) {
    events.push({ type: event.type, payload: event.payload });
  }

  expect(capturedQueries).toHaveLength(1);
  expect(Object.keys((capturedQueries[0]?.options.agents ?? {}) as Record<string, unknown>)).toEqual([
    "eco_explore",
    "eco_researcher",
    "eco_synthesizer",
  ]);
  expect(capturedQueries[0]?.prompt).toBe("Explain the market landscape.");
  expect(events.length).toBeGreaterThan(0);

  const systemPrompt = JSON.stringify(capturedQueries[0]?.options.systemPrompt);
  expect(systemPrompt).toContain(
    "Use researcher for evidence discovery and synthesizer when synthesis improves the answer.",
  );
  expect(systemPrompt).not.toContain("Session mode:");
});

test("ClaudeAgentSdkDriver forwards resume options to SDK query", async () => {
  const capturedOptions: Record<string, unknown>[] = [];
  const driver = new ClaudeAgentSdkDriver({
    apiKey: "test-key",
    baseUrl: "http://127.0.0.1:36037",
    loadSdk: async () => ({
      query: ({ options }) => {
        capturedOptions.push(options);
        return {
          async *[Symbol.asyncIterator]() {
            yield {
              type: "system",
              subtype: "init",
              session_id: "sess-resume-test",
              uuid: "init-1",
            };
            yield {
              type: "result",
              subtype: "success",
              session_id: "sess-resume-test",
              uuid: "result-1",
            };
          },
          close: () => {},
        };
      },
    }),
  });

  const events: string[] = [];
  for await (const event of driver.runAsk({
    threadId: "thr_resume",
    prompt: "Follow up",
    workspacePath: "/tmp/workspace",
    worktreePath: "/tmp/worktree",
    routes,
    signal: new AbortController().signal,
    resume: { resumeSessionId: "sess-resume-test" },
  })) {
    events.push(event.type);
  }

  expect(capturedOptions[0]?.resume).toBe("sess-resume-test");
  expect(events).toContain("session.captured");
});

test("ClaudeAgentSdkDriver interrupts SDK query on abort before falling back to close", async () => {
  const controller = new AbortController();
  let closeCalled = false;
  let resolveInterrupted: (() => void) | undefined;
  const interrupted = new Promise<void>((resolve) => {
    resolveInterrupted = resolve;
  });
  const probes: Array<{ phase: string; detail: Record<string, unknown> }> = [];
  const driver = new ClaudeAgentSdkDriver({
    apiKey: "test-key",
    baseUrl: "http://127.0.0.1:36037",
    onContextProbe: (phase, detail) => probes.push({ phase, detail }),
    loadSdk: async () => ({
      query: () => ({
        async *[Symbol.asyncIterator]() {
          yield {
            type: "system",
            subtype: "init",
            session_id: "sess-interrupt",
            uuid: "init-interrupt",
          };
          yield {
            type: "result",
            subtype: "success",
            session_id: "sess-interrupt",
            uuid: "result-interrupt",
          };
        },
        interrupt: async () => {
          resolveInterrupted?.();
          return { still_queued: ["queued-follow-up"] };
        },
        close: () => {
          closeCalled = true;
        },
      }),
    }),
  });

  for await (const event of driver.runAsk({
    threadId: "thr_interrupt",
    prompt: "Explain quickly",
    workspacePath: "/tmp/workspace",
    worktreePath: "/tmp/worktree",
    routes,
    signal: controller.signal,
  })) {
    if (event.type === "session.captured") {
      controller.abort("cancelled by user");
    }
  }

  await Promise.race([
    interrupted,
    new Promise((_, reject) => setTimeout(() => reject(new Error("interrupt was not called")), 100)),
  ]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(closeCalled).toBe(true);
  expect(probes).toContainEqual({
    phase: "interrupt",
    detail: {
      receipt: { still_queued: ["queued-follow-up"] },
      still_queued: ["queued-follow-up"],
      cancelled: [],
    },
  });
  expect(probes.some((probe) => probe.phase === "query_teardown")).toBe(true);
  const teardown = probes.find((probe) => probe.phase === "query_teardown");
  expect(teardown?.detail).toMatchObject({
    interrupted: true,
    closed: true,
    still_queued: ["queued-follow-up"],
  });
});

test("ClaudeAgentSdkDriver force-closes when abort leaves interrupt and iterator pending", async () => {
  const controller = new AbortController();
  let nextCalls = 0;
  let interruptCalls = 0;
  let closeCalled = false;
  let resolvePendingNextStarted: (() => void) | undefined;
  const pendingNextStarted = new Promise<void>((resolve) => {
    resolvePendingNextStarted = resolve;
  });
  const neverNext = new Promise<IteratorResult<unknown>>(() => {});
  const neverInterrupt = new Promise<undefined>(() => {});
  const neverReturn = new Promise<IteratorResult<unknown>>(() => {});
  const probes: Array<{ phase: string; detail: Record<string, unknown> }> = [];

  const driver = new ClaudeAgentSdkDriver({
    apiKey: "test-key",
    baseUrl: "http://127.0.0.1:36037",
    queryControlDeadlineMs: 10,
    onContextProbe: (phase, detail) => probes.push({ phase, detail }),
    loadSdk: async () => ({
      query: () => {
        const query = {
          next: () => {
            nextCalls += 1;
            if (nextCalls === 1) {
              return Promise.resolve({
                done: false as const,
                value: {
                  type: "system",
                  subtype: "init",
                  session_id: "sess-stuck-abort",
                  uuid: "init-stuck-abort",
                },
              });
            }
            resolvePendingNextStarted?.();
            return neverNext;
          },
          return: () => neverReturn,
          interrupt: () => {
            interruptCalls += 1;
            return neverInterrupt;
          },
          close: () => {
            closeCalled = true;
          },
          [Symbol.asyncIterator]() {
            return query;
          },
        };
        return query;
      },
    }),
  });

  const consume = async () => {
    for await (const _event of driver.runAsk({
      threadId: "thr_stuck_abort",
      prompt: "Wait until cancelled",
      workspacePath: "/tmp/workspace",
      worktreePath: "/tmp/worktree",
      routes,
      signal: controller.signal,
    })) {
      // consume until the SDK iterator stalls
    }
  };

  const run = consume();
  await pendingNextStarted;
  controller.abort("cancelled by user");
  const outcome = await Promise.race([
    run.then(() => "completed"),
    new Promise<"timed-out">((resolve) => setTimeout(() => resolve("timed-out"), 250)),
  ]);

  expect(outcome).toBe("completed");
  expect(interruptCalls).toBe(1);
  expect(closeCalled).toBe(true);
  expect(probes).toContainEqual({
    phase: "interrupt_timeout",
    detail: { deadline_ms: 10 },
  });
  expect(probes.find((probe) => probe.phase === "query_teardown")?.detail).toMatchObject({
    interrupted: true,
    interrupt_timed_out: true,
    closed: true,
    drain_timed_out: false,
  });
});

test("teardownClaudeQueryHandle does not await iterator.return after drain timeout", async () => {
  let returnCalled = false;
  let closeCalled = false;
  const never = new Promise<IteratorResult<unknown>>(() => {});
  const iterator: AsyncIterator<unknown> = {
    next: () => never,
    return: () => {
      returnCalled = true;
      return never;
    },
  };
  const query = {
    close: () => {
      closeCalled = true;
    },
    [Symbol.asyncIterator]() {
      return iterator;
    },
  };

  const outcome = await Promise.race([
    teardownClaudeQueryHandle(
      { query, phase: "open" },
      {
        iterator,
        pendingNext: never,
        shouldInterrupt: false,
        drainDeadlineMs: 10,
      },
    ).then(() => "completed"),
    new Promise<"timed-out">((resolve) => setTimeout(() => resolve("timed-out"), 100)),
  ]);

  expect(outcome).toBe("completed");
  expect(returnCalled).toBe(false);
  expect(closeCalled).toBe(true);
});

test("Stop aborts the SDK transport and tears down even while a context probe and ingress close never resolve", async () => {
  const controller = new AbortController();
  let sdkController: AbortController | undefined;
  let closeCalled = false;
  let probeStarted!: () => void;
  const probing = new Promise<void>((resolve) => {
    probeStarted = resolve;
  });
  const never = new Promise<never>(() => {});
  const driver = new ClaudeAgentSdkDriver({
    apiKey: "test-key",
    baseUrl: "http://127.0.0.1:36037",
    queryControlDeadlineMs: 10,
    queryLifecycle: { onClosing: () => never },
    loadSdk: async () => ({
      query: ({ options }) => {
        sdkController = options.abortController as AbortController;
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: "system", subtype: "init", session_id: "sess-probe-abort" };
            yield { type: "result", subtype: "success", session_id: "sess-probe-abort" };
          },
          getContextUsage: () => {
            probeStarted();
            return never;
          },
          interrupt: () => never,
          close: () => {
            closeCalled = true;
          },
        };
      },
    }),
  });
  const run = (async () => {
    for await (const _event of driver.runAsk({
      threadId: "thr_probe_abort",
      prompt: "Wait",
      workspacePath: "/tmp/workspace",
      worktreePath: "/tmp/worktree",
      routes,
      signal: controller.signal,
    })) {
    }
  })();
  const stopped = run.catch((error: unknown) => error);
  await probing;
  controller.abort("cancelled by user");
  expect(sdkController?.signal.aborted).toBe(true);
  expect(await stopped).toBe("cancelled by user");
  expect(closeCalled).toBe(true);
});

test("ClaudeAgentSdkDriver wires SDK Bash confirmation callback", async () => {
  const capturedOptions: Record<string, unknown>[] = [];
  const handlerRequests: Array<{ toolName: string; toolUseId: string; cwd?: string }> = [];
  const driver = new ClaudeAgentSdkDriver({
    apiKey: "test-key",
    baseUrl: "http://127.0.0.1:36037",
    toolPermissionHandler: async (request) => {
      handlerRequests.push({
        toolName: request.toolName,
        toolUseId: request.toolUseId,
        ...(request.cwd ? { cwd: request.cwd } : {}),
      });
      return { behavior: "allow", updatedInput: request.input };
    },
    loadSdk: async () => ({
      query: ({ options }) => {
        capturedOptions.push(options);
        return {
          async *[Symbol.asyncIterator]() {
            const canUseTool = options.canUseTool as
              | ((
                  toolName: string,
                  input: Record<string, unknown>,
                  options: Record<string, unknown>,
                ) => Promise<unknown>)
              | undefined;
            await canUseTool?.(
              "Bash",
              { command: "date" },
              { toolUseID: "tool_bash", cwd: "/tmp/workspace" },
            );
            yield {
              type: "system",
              subtype: "init",
              session_id: "sess-bash-confirm",
              uuid: "init-bash-confirm",
            };
            yield {
              type: "result",
              subtype: "success",
              session_id: "sess-bash-confirm",
              uuid: "result-bash-confirm",
            };
          },
          close: () => {},
        };
      },
    }),
  });

  for await (const _event of driver.run({
    threadId: "thr_bash_confirm",
    prompt: "Run checks",
    workspacePath: "/tmp/workspace",
    worktreePath: "/tmp/worktree",
    routes,
    signal: new AbortController().signal,
  })) {
    // drain
  }

  expect(typeof capturedOptions[0]?.canUseTool).toBe("function");
  expect(capturedOptions[0]?.allowedTools).not.toContain("Bash");
  expect(capturedOptions[0]?.agents).toBeUndefined();
  expect(handlerRequests).toEqual([{ toolName: "Bash", toolUseId: "tool_bash", cwd: "/tmp/workspace" }]);
});

test("ClaudeAgentSdkDriver forwards excludeDynamicSections to systemPrompt", async () => {
  const capturedOptions: Record<string, unknown>[] = [];
  const driver = new ClaudeAgentSdkDriver({
    apiKey: "test-key",
    baseUrl: "http://127.0.0.1:36037",
    excludeDynamicSections: true,
    loadSdk: async () => ({
      query: ({ options }) => {
        capturedOptions.push(options);
        return {
          async *[Symbol.asyncIterator]() {
            yield {
              type: "result",
              subtype: "success",
              session_id: "sess-cache-test",
              uuid: "result-1",
            };
          },
          close: () => {},
        };
      },
    }),
  });

  for await (const _event of driver.runAsk({
    threadId: "thr_cache",
    prompt: "What changed?",
    workspacePath: "/tmp/workspace",
    worktreePath: "/tmp/worktree-a",
    routes,
    signal: new AbortController().signal,
  })) {
    // drain
  }

  expect(capturedOptions[0]?.systemPrompt).toMatchObject({
    type: "preset",
    preset: "claude_code",
    excludeDynamicSections: true,
  });
});

async function invokeExitPlanPermissionHook(
  options: Record<string, unknown>,
  plan: string,
): Promise<unknown> {
  const hooks = options.hooks as
    | Partial<Record<string, Array<{ matcher?: string; hooks: Array<(...args: unknown[]) => unknown> }>>>
    | undefined;
  const exitPlanHook = hooks?.PermissionRequest?.find((matcher) => matcher.matcher === "ExitPlanMode")
    ?.hooks[0];
  return exitPlanHook?.(
    {
      hook_event_name: "PermissionRequest",
      tool_name: "ExitPlanMode",
      tool_input: { plan },
      tool_use_id: "tool_exit_plan_1",
      session_id: "sess-plan",
      cwd: "/tmp/workspace",
    },
    undefined,
    { signal: new AbortController().signal },
  );
}

test("ClaudeAgentSdkDriver planning uses official plan mode and captures ExitPlanMode", async () => {
  const capturedOptions: Record<string, unknown>[] = [];
  const driver = new ClaudeAgentSdkDriver({
    apiKey: "test-key",
    baseUrl: "http://127.0.0.1:36037",
    hookContext: {
      awaitPlanApproval: async () => "approved",
    },
    loadSdk: async () => ({
      query: ({ options }) => {
        capturedOptions.push(options);
        return {
          async *[Symbol.asyncIterator]() {
            yield {
              type: "system",
              subtype: "init",
              session_id: "sess-plan",
              uuid: "init-plan",
            };
            await invokeExitPlanPermissionHook(options, "## Summary\n\nShip the official plan.");
            yield {
              type: "assistant",
              session_id: "sess-plan",
              uuid: "assistant-write-after-approval",
              message: {
                content: [
                  {
                    type: "tool_use",
                    id: "tool_write_after_approval",
                    name: "Write",
                    input: { file_path: "/tmp/workspace/result.md", content: "done" },
                  },
                ],
              },
            };
            yield {
              type: "result",
              subtype: "success",
              session_id: "sess-plan",
              uuid: "result-plan",
            };
          },
          close: () => {},
        };
      },
    }),
  });

  const events: Array<{ type: string; payload?: unknown }> = [];
  for await (const event of driver.runContinuation(
    {
      threadId: "thr_plan_tool",
      prompt: "Add markdown rendering",
      workspacePath: "/tmp/workspace",
      worktreePath: "/tmp/worktree",
      routes,
      signal: new AbortController().signal,
    },
    "planning",
  )) {
    events.push({ type: event.type, payload: event.payload });
  }
  expect(capturedOptions[0]?.allowedTools).not.toContain("Bash");
  expect(capturedOptions[0]?.allowedTools).not.toContain("Write");
  expect(capturedOptions[0]?.permissionMode).toBe("plan");
  expect(capturedOptions[0]?.tools).toEqual(
    expect.arrayContaining(["Write", "Edit", "Bash", "ExitPlanMode", "AskUserQuestion"]),
  );
  for (const tool of ["Write", "Edit", "MultiEdit", "NotebookEdit", "Bash"]) {
    expect(capturedOptions[0]?.disallowedTools ?? []).not.toContain(tool);
  }
  expect(capturedOptions[0]?.planModeInstructions).toBeUndefined();
  expect(capturedOptions[0]?.allowedTools).toContain("WebSearch");
  expect(capturedOptions[0]?.allowedTools).toContain("WebFetch");
  expect(capturedOptions[0]?.allowedTools).not.toContain("ExitPlanMode");
  expect(capturedOptions[0]?.allowedTools).not.toContain("mcp__eco_plan__finalize_plan");
  expect(capturedOptions[0]?.agents).toBeUndefined();
  const systemPrompt = capturedOptions[0]?.systemPrompt as { append?: string } | undefined;
  expect(systemPrompt).toEqual({ type: "preset", preset: "claude_code", snapshot: false });
  const settings = capturedOptions[0]?.settings as { permissions?: { deny?: string[] } } | undefined;
  expect(settings?.permissions?.deny).not.toContain("Agent(Plan)");
  expect(settings?.permissions?.deny).toContain("Agent(Explore)");
  expect(capturedOptions[0]?.mcpServers).toBeUndefined();
  expect(events.some((event) => event.type === "plan.ready")).toBe(false);
  expect(events.some((event) => event.type === "tool.started")).toBe(true);
  expect(capturedOptions).toHaveLength(1);
});

test("ClaudeAgentSdkDriver planning canUseTool waits for Eco plan approval on ExitPlanMode", async () => {
  const capturedOptions: Record<string, unknown>[] = [];
  let handlerCalled = false;
  let resolveApproval!: (decision: "approved" | "denied") => void;
  const approval = new Promise<"approved" | "denied">((resolve) => {
    resolveApproval = resolve;
  });
  const driver = new ClaudeAgentSdkDriver({
    apiKey: "test-key",
    baseUrl: "http://127.0.0.1:36037",
    toolPermissionHandler: async () => {
      handlerCalled = true;
      return { behavior: "allow" };
    },
    hookContext: {
      awaitPlanApproval: async () => approval,
    },
    loadSdk: async () => ({
      query: ({ options }) => {
        capturedOptions.push(options);
        return {
          async *[Symbol.asyncIterator]() {
            yield {
              type: "system",
              subtype: "init",
              session_id: "sess-plan-canuse",
              uuid: "init-plan-canuse",
            };
            const canUseTool = options.canUseTool as
              | ((
                  toolName: string,
                  input: Record<string, unknown>,
                  options: Record<string, unknown>,
                ) => Promise<unknown>)
              | undefined;
            const pending = canUseTool?.(
              "ExitPlanMode",
              { plan: "## Summary\n\nShip after user approval." },
              { toolUseID: "tool_exit_canuse", signal: new AbortController().signal },
            );
            let settled = false;
            void pending?.then(() => {
              settled = true;
            });
            await Promise.resolve();
            expect(settled).toBe(false);
            resolveApproval("approved");
            await expect(pending).resolves.toMatchObject({ behavior: "allow" });
            yield {
              type: "result",
              subtype: "success",
              session_id: "sess-plan-canuse",
              uuid: "result-plan-canuse",
            };
          },
          close: () => {},
        };
      },
    }),
  });

  for await (const _event of driver.runContinuation(
    {
      threadId: "thr_plan_canuse",
      prompt: "Add markdown rendering",
      workspacePath: "/tmp/workspace",
      worktreePath: "/tmp/worktree",
      routes,
      signal: new AbortController().signal,
    },
    "planning",
  )) {
    // drain
  }

  expect(typeof capturedOptions[0]?.canUseTool).toBe("function");
  expect(handlerCalled).toBe(false);
});

test("ClaudeAgentSdkDriver runPlan starts a fresh planning session", async () => {
  const capturedOptions: Record<string, unknown>[] = [];
  const driver = new ClaudeAgentSdkDriver({
    apiKey: "test-key",
    baseUrl: "http://127.0.0.1:36037",
    hookContext: {
      awaitPlanApproval: async () => "approved",
    },
    loadSdk: async () => ({
      query: ({ options }) => {
        capturedOptions.push(options);
        return {
          async *[Symbol.asyncIterator]() {
            yield {
              type: "system",
              subtype: "init",
              session_id: "sess-plan-start",
              uuid: "init-plan-start",
            };
            await invokeExitPlanPermissionHook(options, "## Summary\n\nShip the first plan.");
            yield {
              type: "result",
              subtype: "success",
              session_id: "sess-plan-start",
              uuid: "result-plan-start",
            };
          },
          close: () => {},
        };
      },
    }),
  });

  const events: Array<{ type: string; payload?: unknown }> = [];
  for await (const event of driver.runPlan({
    threadId: "thr_plan_start",
    prompt: "Add markdown rendering",
    workspacePath: "/tmp/workspace",
    worktreePath: "/tmp/worktree",
    routes,
    signal: new AbortController().signal,
  })) {
    events.push({ type: event.type, payload: event.payload });
  }

  expect(capturedOptions[0]?.permissionMode).toBe("plan");
  expect(capturedOptions[0]?.allowedTools).toContain("AskUserQuestion");
  expect(events.some((event) => event.type === "plan.ready")).toBe(false);
});

test("ClaudeAgentSdkDriver planning captures plan from deferred_tool_use result payload", async () => {
  const driver = new ClaudeAgentSdkDriver({
    apiKey: "test-key",
    baseUrl: "http://127.0.0.1:36037",
    loadSdk: async () => ({
      query: () => ({
        async *[Symbol.asyncIterator]() {
          yield {
            type: "system",
            subtype: "init",
            session_id: "sess-plan-deferred",
            uuid: "init-plan-deferred",
          };
          // Hook capture intentionally skipped: the defer payload on the result
          // message is the official primary channel.
          yield {
            type: "result",
            subtype: "success",
            session_id: "sess-plan-deferred",
            uuid: "result-plan-deferred",
            stop_reason: "tool_deferred",
            deferred_tool_use: {
              id: "tool_exit_deferred",
              name: "ExitPlanMode",
              input: {
                plan: "## Summary\n\nShip the deferred plan.",
                planFilePath: "/tmp/workspace/.claude/plans/deferred.md",
              },
            },
          };
        },
        close: () => {},
      }),
    }),
  });

  const events: Array<{ type: string; payload?: unknown }> = [];
  for await (const event of driver.runContinuation(
    {
      threadId: "thr_plan_deferred",
      prompt: "Add markdown rendering",
      workspacePath: "/tmp/workspace",
      worktreePath: "/tmp/worktree",
      routes,
      signal: new AbortController().signal,
    },
    "planning",
  )) {
    events.push({ type: event.type, payload: event.payload });
  }

  const ready = events.find((event) => event.type === "plan.ready");
  expect(ready?.payload).toMatchObject({
    plan: "## Summary\n\nShip the deferred plan.",
    planFilePath: ".claude/plans/deferred.md",
    deferredExitPlanToolUseId: "tool_exit_deferred",
  });
});

test("ClaudeAgentSdkDriver planning completes after PermissionRequest approval", async () => {
  const driver = new ClaudeAgentSdkDriver({
    apiKey: "test-key",
    baseUrl: "http://127.0.0.1:36037",
    hookContext: {
      awaitPlanApproval: async () => "approved",
    },
    loadSdk: async () => ({
      query: ({ options }) => ({
        async *[Symbol.asyncIterator]() {
          yield {
            type: "system",
            subtype: "init",
            session_id: "sess-plan",
            uuid: "init-plan",
          };
          await invokeExitPlanPermissionHook(options, "## Summary\n\nShip the captured plan.");
          yield {
            type: "result",
            subtype: "success",
            session_id: "sess-plan",
            uuid: "result-plan",
          };
        },
        close: () => {},
      }),
    }),
  });

  const events: Array<{ type: string; payload?: unknown }> = [];
  for await (const event of driver.runContinuation(
    {
      threadId: "thr_plan_bridge",
      prompt: "Add markdown rendering",
      workspacePath: "/tmp/workspace",
      worktreePath: "/tmp/worktree",
      routes,
      signal: new AbortController().signal,
    },
    "planning",
  )) {
    events.push({ type: event.type, payload: event.payload });
  }

  expect(events.some((event) => event.type === "plan.ready")).toBe(false);
});

test("ClaudeAgentSdkDriver execution continuation includes approved plan without SDK resume", async () => {
  const capturedQueries: Array<{ prompt: string; options: Record<string, unknown> }> = [];
  const driver = new ClaudeAgentSdkDriver({
    apiKey: "test-key",
    baseUrl: "http://127.0.0.1:36037",
    loadSdk: async () => ({
      query: ({ prompt, options }) => {
        capturedQueries.push({ prompt: resolveSdkPromptCaptureText(prompt), options });
        return {
          async *[Symbol.asyncIterator]() {
            yield {
              type: "result",
              subtype: "success",
              session_id: "sess-exec-no-resume",
              uuid: "result-exec-no-resume",
            };
          },
          close: () => {},
        };
      },
    }),
  });

  for await (const _event of driver.runContinuation(
    {
      threadId: "thr_exec_no_resume",
      prompt: "继续",
      workspacePath: "/tmp/workspace",
      worktreePath: "/tmp/worktree",
      routes,
      signal: new AbortController().signal,
    },
    "execution",
    {
      userPrompt: "Add markdown rendering",
      analysis: "Approved",
      plan: "## Summary\n\nShip it.",
    },
  )) {
    // drain
  }

  expect(capturedQueries[0]?.prompt).toContain("Implement the following approved plan:");
  expect(capturedQueries[0]?.prompt).toContain("## Summary\n\nShip it.");
});

test("ClaudeAgentSdkDriver execution resume applies official default mode", async () => {
  const capturedOptions: Record<string, unknown>[] = [];
  let setPermissionModeMode: string | undefined;
  const driver = new ClaudeAgentSdkDriver({
    apiKey: "test-key",
    baseUrl: "http://127.0.0.1:36037",
    loadSdk: async () => ({
      query: ({ options }) => {
        capturedOptions.push(options);
        return {
          async *[Symbol.asyncIterator]() {
            yield {
              type: "system",
              subtype: "init",
              session_id: "sess-exec-resume",
              uuid: "init-exec-resume",
            };
            yield {
              type: "result",
              subtype: "success",
              session_id: "sess-exec-resume",
              uuid: "result-exec-resume",
            };
          },
          setPermissionMode: (mode: string) => {
            setPermissionModeMode = mode;
          },
          close: () => {},
        };
      },
    }),
  });

  for await (const _event of driver.runContinuation(
    {
      threadId: "thr_exec_resume",
      prompt: "",
      workspacePath: "/tmp/workspace",
      worktreePath: "/tmp/worktree",
      routes,
      resume: { resumeSessionId: "sess-plan" },
      signal: new AbortController().signal,
    },
    "execution",
    {
      userPrompt: "Add markdown rendering",
      analysis: "Approved",
      plan: "## Summary\n\nShip it.",
    },
  )) {
    // drain
  }

  expect(setPermissionModeMode).toBe("default");
  expect(capturedOptions[0]?.permissionMode).toBe("default");
  expect(capturedOptions[0]?.disallowedTools ?? []).not.toContain("Bash");
  expect(capturedOptions[0]?.disallowedTools ?? []).toContain("ExitPlanMode");
  expect(capturedOptions[0]?.agents).toBeUndefined();
  const hooks = capturedOptions[0]?.hooks as Partial<Record<string, Array<{ matcher?: string }>>> | undefined;
  expect(
    hooks?.PermissionRequest?.filter((matcher) => matcher.matcher === "ExitPlanMode") ?? [],
  ).toHaveLength(0);
  expect(hooks?.PreToolUse?.some((matcher) => matcher.matcher?.includes("ExitPlanMode")) ?? false).toBe(true);
});

test("ClaudeAgentSdkDriver full access uses bypassPermissions with the dangerous opt-in", async () => {
  const capturedOptions: Record<string, unknown>[] = [];
  const driver = new ClaudeAgentSdkDriver({
    apiKey: "test-key",
    baseUrl: "http://127.0.0.1:36037",
    executionPermissionMode: "bypassPermissions",
    loadSdk: async () => ({
      query: ({ options }) => {
        capturedOptions.push(options);
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: "system", subtype: "init", session_id: "sess-full", uuid: "init-full" };
            yield { type: "result", subtype: "success", session_id: "sess-full", uuid: "result-full" };
          },
          close: () => {},
        };
      },
    }),
  });

  for await (const _event of driver.run({
    threadId: "thr_full_access",
    prompt: "Implement the change",
    workspacePath: "/tmp/workspace",
    worktreePath: "/tmp/worktree",
    routes,
    signal: new AbortController().signal,
  })) {
    // drain
  }

  expect(capturedOptions[0]?.permissionMode).toBe("bypassPermissions");
  expect(capturedOptions[0]?.allowDangerouslySkipPermissions).toBe(true);
});

test("ClaudeAgentSdkDriver autonomous does not register plan submission tools", async () => {
  const capturedOptions: Record<string, unknown>[] = [];
  const driver = new ClaudeAgentSdkDriver({
    apiKey: "test-key",
    baseUrl: "http://127.0.0.1:36037",
    hookContext: {
      awaitPlanApproval: async () => "approved",
    },
    loadSdk: async () => ({
      query: ({ options }) => {
        capturedOptions.push(options);
        return {
          async *[Symbol.asyncIterator]() {
            yield {
              type: "result",
              subtype: "success",
              session_id: "sess-autonomous-no-plan",
              uuid: "result-autonomous-no-plan",
            };
          },
          close: () => {},
        };
      },
    }),
  });

  const events: Array<{ type: string }> = [];
  for await (const event of driver.run({
    threadId: "thr_autonomous_no_plan_tool",
    prompt: "Fix typo",
    workspacePath: "/tmp/workspace",
    worktreePath: "/tmp/worktree",
    routes,
    signal: new AbortController().signal,
  })) {
    events.push({ type: event.type });
  }

  expect(capturedOptions[0]?.allowedTools).not.toContain("mcp__eco_plan__finalize_plan");
  expect(capturedOptions[0]?.allowedTools).not.toContain("ExitPlanMode");
  expect(capturedOptions[0]?.allowedTools).toContain("AskUserQuestion");
  expect(capturedOptions[0]?.disallowedTools).toEqual(
    expect.arrayContaining(["ExitPlanMode", "EnterPlanMode", "mcp__eco_plan__finalize_plan"]),
  );
  expect(capturedOptions[0]?.mcpServers).toBeUndefined();
  const systemPrompt = capturedOptions[0]?.systemPrompt as { append?: string } | undefined;
  expect(systemPrompt).toEqual({ type: "preset", preset: "claude_code", snapshot: false });
  const hooks = capturedOptions[0]?.hooks as Partial<Record<string, Array<{ matcher?: string }>>> | undefined;
  expect(hooks?.PermissionRequest ?? []).toHaveLength(0);
  expect(hooks?.PreToolUse?.some((matcher) => matcher.matcher?.includes("ExitPlanMode")) ?? false).toBe(true);
  expect(events.some((event) => event.type === "plan.ready")).toBe(false);
});

test("ClaudeAgentSdkDriver planning completes without ExitPlanMode", async () => {
  const driver = new ClaudeAgentSdkDriver({
    apiKey: "test-key",
    baseUrl: "http://127.0.0.1:36037",
    loadSdk: async () => ({
      query: () => ({
        async *[Symbol.asyncIterator]() {
          yield {
            type: "system",
            subtype: "init",
            session_id: "sess-plan-missing",
            uuid: "init-plan-missing",
          };
          yield {
            type: "assistant",
            uuid: "assistant-plan-missing",
            session_id: "sess-plan-missing",
            message: {
              content: [{ type: "text", text: "Here is analysis only." }],
            },
          };
          yield {
            type: "result",
            subtype: "success",
            session_id: "sess-plan-missing",
            uuid: "result-plan-missing",
          };
        },
        close: () => {},
      }),
    }),
  });

  const events: Array<{ type: string }> = [];
  for await (const event of driver.runContinuation(
    {
      threadId: "thr_plan_missing",
      prompt: "Plan this feature",
      workspacePath: "/tmp/workspace",
      worktreePath: "/tmp/worktree",
      routes,
      signal: new AbortController().signal,
    },
    "planning",
  )) {
    events.push({ type: event.type });
  }

  expect(events.some((event) => event.type === "plan.ready")).toBe(false);
});

test("maps camelCase AgentOutput from persisted Claude transcripts", () => {
  const events = mapSdkMessageToEvents(
    {
      type: "user",
      uuid: "sdk_agent_output_camel",
      session_id: "session_planner",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "call_general_camel", content: "done" }],
      },
      toolUseResult: {
        status: "completed",
        agentId: "agent_general_camel",
        agentType: "general-purpose",
        totalTokens: 321,
        content: [{ type: "text", text: "done" }],
      },
    },
    "thr_agent_output_camel",
  );

  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    agentId: "agent_general_camel",
    role: "general-purpose",
    type: "agent.completed",
    payload: {
      type: "agent_output",
      tool_use_id: "call_general_camel",
      totalTokens: 321,
    },
  });
});

test("maps completed AgentOutput as an exact terminal event without billing duplication", () => {
  const events = mapSdkMessageToEvents(
    {
      type: "user",
      uuid: "sdk_agent_output",
      session_id: "session_planner",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "call_general_output", content: "done" }],
      },
      tool_use_result: {
        status: "completed",
        agentId: "agent_general_output",
        agentType: "general-purpose",
        resolvedModel: "claude-sonnet-4-5",
        totalToolUseCount: 4,
        totalDurationMs: 5000,
        totalTokens: 700,
        usage: {
          input_tokens: 600,
          output_tokens: 100,
          cache_creation_input_tokens: null,
          cache_read_input_tokens: null,
          server_tool_use: null,
          service_tier: null,
          cache_creation: null,
        },
        content: [{ type: "text", text: "done" }],
        prompt: "inspect",
      },
    },
    "thr_agent_output",
  );

  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    agentId: "agent_general_output",
    role: "general-purpose",
    type: "agent.completed",
    payload: {
      type: "agent_output",
      status: "completed",
      agentId: "agent_general_output",
      agentType: "general-purpose",
      tool_use_id: "call_general_output",
      totalTokens: 700,
    },
  });
  expect(events.some((event) => event.type === "usage.recorded")).toBe(false);
});

test("maps AgentOutput API-error text as a failed agent.completed event", () => {
  const events = mapSdkMessageToEvents(
    {
      type: "user",
      uuid: "sdk_agent_output_failed",
      session_id: "session_planner",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_explore_failed",
            is_error: true,
            content:
              'Agent terminated early due to an API error: 400 {"error":"No provider route configured for model claude-sonnet-5"}',
          },
        ],
      },
      tool_use_result: {
        status: "completed",
        agentId: "agent_explore_failed",
        agentType: "explore",
        content: [
          {
            type: "text",
            text: 'Agent terminated early due to an API error: 400 {"error":"No provider route configured for model claude-sonnet-5"}',
          },
        ],
      },
    },
    "thr_agent_output_failed",
  );

  expect(events.some((event) => event.type === "agent.completed")).toBe(true);
  expect(events.find((event) => event.type === "agent.completed")).toMatchObject({
    agentId: "agent_explore_failed",
    type: "agent.completed",
    payload: {
      type: "agent_output",
      status: "failed",
      failed: true,
      agentId: "agent_explore_failed",
      tool_use_id: "call_explore_failed",
    },
  });
  expect(events.some((event) => event.type === "tool.failed")).toBe(true);
});

test("maps Agent tool_result API-error text as failed even without is_error", () => {
  const events = mapSdkMessageToEvents(
    {
      type: "user",
      uuid: "sdk_agent_output_failed_no_flag",
      session_id: "session_planner",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_explore_failed",
            content:
              'Agent terminated early due to an API error: 400 {"error":"No provider route configured for model claude-sonnet-5"}',
          },
        ],
      },
      tool_use_result: {
        status: "completed",
        agentId: "agent_explore_failed",
        agentType: "explore",
        content: [
          {
            type: "text",
            text: 'Agent terminated early due to an API error: 400 {"error":"No provider route configured for model claude-sonnet-5"}',
          },
        ],
      },
    },
    "thr_agent_output_failed_no_flag",
  );

  expect(events.find((event) => event.type === "agent.completed")).toMatchObject({
    payload: {
      type: "agent_output",
      status: "failed",
      failed: true,
      agentId: "agent_explore_failed",
      tool_use_id: "call_explore_failed",
    },
  });
  expect(events.some((event) => event.type === "tool.failed")).toBe(true);
});

test("maps successful SDK tool results onto the original tool use", () => {
  const ctx = createSdkStreamContext();
  mapSdkMessageToEvents(
    {
      type: "assistant",
      uuid: "assistant_read",
      session_id: "session_planner",
      message: {
        content: [
          {
            type: "tool_use",
            id: "call_read",
            name: "Read",
            input: { file_path: "panel.ts", offset: 10, limit: 20 },
          },
        ],
      },
    },
    "thr_read",
    ctx,
  );

  const events = mapSdkMessageToEvents(
    {
      type: "user",
      uuid: "result_read",
      session_id: "session_planner",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_read",
            content: "10\tconst value = true;",
          },
        ],
      },
    },
    "thr_read",
    ctx,
  );

  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    type: "tool.completed",
    payload: {
      type: "tool_result",
      tool_name: "Read",
      tool_use_id: "call_read",
      input: { file_path: "panel.ts", offset: 10, limit: 20 },
      output: "10\tconst value = true;",
    },
  });
  expect(formatAgentEventLine(events[0]!)).toBe("Tool: Read · panel.ts:L10-29");
});

test("maps failed SDK tool results onto the original tool use", () => {
  const ctx = createSdkStreamContext();
  mapSdkMessageToEvents(
    {
      type: "assistant",
      uuid: "assistant_edit",
      session_id: "session_planner",
      message: {
        content: [
          {
            type: "tool_use",
            id: "call_edit",
            name: "Edit",
            input: { file_path: "panel.ts", old_string: "\tline", new_string: "  line" },
          },
        ],
      },
    },
    "thr_edit",
    ctx,
  );

  const events = mapSdkMessageToEvents(
    {
      type: "user",
      uuid: "result_edit",
      session_id: "session_planner",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_edit",
            is_error: true,
            content: "String to replace not found in file.",
          },
        ],
      },
    },
    "thr_edit",
    ctx,
  );

  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    type: "tool.failed",
    payload: {
      type: "tool_result_error",
      tool_name: "Edit",
      tool_use_id: "call_edit",
      input: { file_path: "panel.ts" },
      message: "String to replace not found in file.",
    },
  });
  expect(formatAgentEventLine(events[0]!)).toBe("Tool failed: Edit: String to replace not found in file.");
});

test("toStreamingUserPrompt yields a single user message then completes", async () => {
  const prompt = toStreamingUserPrompt("hello streaming", { uuid: "um-1" });
  expect(prompt.ecoPromptText).toBe("hello streaming");
  expect(resolveSdkPromptCaptureText(prompt)).toBe("hello streaming");

  const messages = [];
  for await (const message of prompt) {
    messages.push(message);
  }
  expect(messages).toHaveLength(1);
  expect(messages[0]).toMatchObject({
    type: "user",
    parent_tool_use_id: null,
    uuid: "um-1",
    message: { role: "user", content: "hello streaming" },
  });
});

test("toStreamingUserPrompt holds the iterable open until holdOpenUntil settles", async () => {
  let release!: () => void;
  const holdOpenUntil = new Promise<void>((resolve) => {
    release = resolve;
  });
  const prompt = toStreamingUserPrompt("hold me", { holdOpenUntil });

  const iterator = prompt[Symbol.asyncIterator]();
  const first = await iterator.next();
  expect(first.done).toBe(false);
  expect(first.value).toMatchObject({
    type: "user",
    message: { role: "user", content: "hold me" },
  });

  const secondPromise = iterator.next();
  const raced = await Promise.race([
    secondPromise.then(() => "completed" as const),
    new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 30)),
  ]);
  expect(raced).toBe("pending");

  release();
  const second = await secondPromise;
  expect(second.done).toBe(true);
});

test("createHeldPromptStream yields the initial message then stays open", async () => {
  const stream = createHeldPromptStream("hello", { uuid: "um-1" });
  expect(stream.ecoPromptText).toBe("hello");
  expect(resolveSdkPromptCaptureText(stream)).toBe("hello");

  const iterator = stream[Symbol.asyncIterator]();
  const first = await iterator.next();
  expect(first.done).toBe(false);
  expect(first.value).toMatchObject({
    type: "user",
    parent_tool_use_id: null,
    uuid: "um-1",
    message: { role: "user", content: "hello" },
  });

  const raced = await Promise.race([
    iterator.next().then(() => "completed" as const),
    new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 30)),
  ]);
  expect(raced).toBe("pending");
  stream.close();
});

test("createHeldPromptStream push yields FIFO and acks after the consumer receives the item", async () => {
  const stream = createHeldPromptStream("start");
  const iterator = stream[Symbol.asyncIterator]();
  await iterator.next();

  const firstPush = stream.push("one", { uuid: "tfu_1" });
  const secondPush = stream.push("two", { uuid: "tfu_2" });

  const second = await iterator.next();
  expect(second.value).toMatchObject({
    uuid: "tfu_1",
    message: { role: "user", content: "one" },
  });
  await firstPush;

  const third = await iterator.next();
  expect(third.value).toMatchObject({
    uuid: "tfu_2",
    message: { role: "user", content: "two" },
  });
  await secondPush;

  stream.close();
  const done = await iterator.next();
  expect(done.done).toBe(true);
});

test("createHeldPromptStream close rejects queued and later pushes", async () => {
  const stream = createHeldPromptStream("start");
  const iterator = stream[Symbol.asyncIterator]();
  await iterator.next();

  const pending = stream.push("late");
  stream.close();
  await expect(pending).rejects.toThrow(/closed/i);
  await expect(stream.push("after")).rejects.toThrow(/closed/i);
  expect((await iterator.next()).done).toBe(true);
});

test("createHeldPromptStream push rejects empty text", async () => {
  const stream = createHeldPromptStream("start");
  await expect(stream.push("  ")).rejects.toThrow(/non-empty/i);
  stream.close();
});

test("ClaudeAgentSdkDriver closes the held prompt after result so the run can finish", async () => {
  let promptSettled = false;

  const driver = new ClaudeAgentSdkDriver({
    apiKey: "test-key",
    baseUrl: "http://127.0.0.1:36037",
    loadSdk: async () => ({
      query: ({ prompt }) => {
        void (async () => {
          for await (const _message of prompt as AsyncIterable<unknown>) {
            // Drain the mailbox until the result path closes it.
          }
          promptSettled = true;
        })();
        return {
          async *[Symbol.asyncIterator]() {
            yield {
              type: "system",
              subtype: "init",
              session_id: "sess-hold-open",
              uuid: "init-hold-open",
            };
            yield {
              type: "result",
              subtype: "success",
              session_id: "sess-hold-open",
              uuid: "result-hold-open",
            };
            while (!promptSettled) {
              await new Promise((resolve) => setTimeout(resolve, 1));
            }
          },
          streamInput: async () => {
            throw new Error("query.streamInput must not be called");
          },
          close: () => {},
        };
      },
    }),
  });

  for await (const _event of driver.runAsk({
    threadId: "thr_hold_open",
    prompt: "Spawn explorers and wait",
    workspacePath: "/tmp/workspace",
    worktreePath: "/tmp/worktree",
    routes,
    signal: new AbortController().signal,
  })) {
    // consume
  }

  expect(promptSettled).toBe(true);
});

test("ClaudeAgentSdkDriver delays held prompt close while queued_turn_count > 0", async () => {
  let promptSettled = false;
  let releaseSecondResult: (() => void) | undefined;
  const secondResultGate = new Promise<void>((resolve) => {
    releaseSecondResult = resolve;
  });

  const driver = new ClaudeAgentSdkDriver({
    apiKey: "test-key",
    baseUrl: "http://127.0.0.1:36037",
    loadSdk: async () => ({
      query: ({ prompt, options }) => {
        expect(options.pluginDelivery).toBe("initialize");
        expect(options.perTaskStopAffordance).toBe(true);
        expect(options.permissionPrompts).toBe("none");
        void (async () => {
          for await (const _message of prompt as AsyncIterable<unknown>) {
            // Drain until close.
          }
          promptSettled = true;
        })();
        return {
          async *[Symbol.asyncIterator]() {
            yield {
              type: "system",
              subtype: "init",
              session_id: "sess-queued",
              uuid: "init-queued",
            };
            yield {
              type: "result",
              subtype: "success",
              session_id: "sess-queued",
              uuid: "result-queued-1",
              queued_turn_count: 1,
            };
            await secondResultGate;
            yield {
              type: "result",
              subtype: "success",
              session_id: "sess-queued",
              uuid: "result-queued-2",
              queued_turn_count: 0,
            };
            while (!promptSettled) {
              await new Promise((resolve) => setTimeout(resolve, 1));
            }
          },
          close: () => {},
        };
      },
    }),
  });

  const run = (async () => {
    const terminals: unknown[] = [];
    for await (const event of driver.runAsk({
      threadId: "thr_queued_close",
      prompt: "queued turns",
      workspacePath: "/tmp/workspace",
      worktreePath: "/tmp/worktree",
      routes,
      signal: new AbortController().signal,
    })) {
      if (event.type === "run.terminal") {
        terminals.push(event.payload);
      }
    }
    return terminals;
  })();

  await new Promise((resolve) => setTimeout(resolve, 150));
  expect(promptSettled).toBe(false);
  releaseSecondResult?.();
  await run;
  expect(promptSettled).toBe(true);
});

test("ClaudeAgentSdkDriver getContextUsage is called with detail summary", async () => {
  let contextUsageOpts: unknown;
  const driver = new ClaudeAgentSdkDriver({
    apiKey: "test-key",
    baseUrl: "http://127.0.0.1:36037",
    loadSdk: async () => ({
      query: ({ prompt }) => {
        void (async () => {
          for await (const _message of prompt as AsyncIterable<unknown>) {
            // drain
          }
        })();
        return {
          async *[Symbol.asyncIterator]() {
            yield {
              type: "system",
              subtype: "init",
              session_id: "sess-ctx",
              uuid: "init-ctx",
            };
            yield {
              type: "result",
              subtype: "success",
              session_id: "sess-ctx",
              uuid: "result-ctx",
            };
            await new Promise((resolve) => setTimeout(resolve, 100));
          },
          getContextUsage: async (opts) => {
            contextUsageOpts = opts;
            return { type: "sdk_context_usage", categories: [] };
          },
          close: () => {},
        };
      },
    }),
  });

  for await (const _event of driver.runAsk({
    threadId: "thr_ctx_usage",
    prompt: "check context",
    workspacePath: "/tmp/workspace",
    worktreePath: "/tmp/worktree",
    routes,
    signal: new AbortController().signal,
  })) {
    // consume
  }

  expect(contextUsageOpts).toEqual({ detail: "summary" });
});

test("maps cancelled tool_result_meta onto tool.failed with non_execution_kind", () => {
  const ctx = createSdkStreamContext();
  mapSdkMessageToEvents(
    {
      type: "assistant",
      uuid: "assistant_read",
      session_id: "session_planner",
      message: {
        content: [
          {
            type: "tool_use",
            id: "call_read_cancelled",
            name: "Read",
            input: { file_path: "entity.ts" },
          },
        ],
      },
    },
    "thr_cancelled",
    ctx,
  );

  const events = mapSdkMessageToEvents(
    {
      type: "user",
      uuid: "result_read_cancelled",
      session_id: "session_planner",
      tool_result_meta: {
        non_execution_kind: "cancelled",
      },
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_read_cancelled",
            is_error: true,
            content:
              "The user doesn't want to take this action right now. STOP what you are doing and wait for the user to tell you how to proceed.",
          },
        ],
      },
    },
    "thr_cancelled",
    ctx,
  );

  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    type: "tool.failed",
    payload: {
      type: "tool_result_error",
      tool_name: "Read",
      tool_use_id: "call_read_cancelled",
      non_execution_kind: "cancelled",
      message:
        "The user doesn't want to take this action right now. STOP what you are doing and wait for the user to tell you how to proceed.",
    },
  });
  expect(formatAgentEventLine(events[0]!)).toBe(
    "Tool cancelled: Read (system cancelled — not a user denial)",
  );
});

test("maps JSONL toolDenialKind cancelled when tool_result_meta is absent", () => {
  const ctx = createSdkStreamContext();
  mapSdkMessageToEvents(
    {
      type: "assistant",
      uuid: "assistant_glob",
      session_id: "session_planner",
      message: {
        content: [{ type: "tool_use", id: "call_glob", name: "Glob", input: { pattern: "**/*" } }],
      },
    },
    "thr_denial_kind",
    ctx,
  );

  const events = mapSdkMessageToEvents(
    {
      type: "user",
      uuid: "result_glob",
      session_id: "session_planner",
      toolDenialKind: "cancelled",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_glob",
            is_error: true,
            content: "The user doesn't want to take this action right now. STOP...",
          },
        ],
      },
    },
    "thr_denial_kind",
    ctx,
  );

  expect(events[0]?.payload).toMatchObject({
    type: "tool_result_error",
    non_execution_kind: "cancelled",
  });
});

test("resolveClaudeSessionCwd prefers worktree over workspace", () => {
  expect(
    resolveClaudeSessionCwd({
      workspacePath: "/tmp/workspace",
      worktreePath: "/tmp/wt",
    }),
  ).toBe("/tmp/wt");
  expect(
    resolveClaudeSessionCwd({
      workspacePath: "/tmp/workspace",
      worktreePath: "  ",
    }),
  ).toBe("/tmp/workspace");
});

test("ClaudeAgentSdkDriver thread path starts query in single-message streaming mode", async () => {
  let receivedPromptKind: "string" | "streaming" | "unknown" = "unknown";
  let promptText = "";
  let closeCalled = false;
  const driver = new ClaudeAgentSdkDriver({
    apiKey: "test-key",
    baseUrl: "http://127.0.0.1:36037",
    loadSdk: async () => ({
      query: ({ prompt, options }) => {
        if (typeof prompt === "string") {
          receivedPromptKind = "string";
          promptText = prompt;
        } else if (prompt && typeof prompt === "object" && Symbol.asyncIterator in prompt) {
          receivedPromptKind = "streaming";
          promptText = resolveSdkPromptCaptureText(prompt);
        }
        expect(options.cwd).toBe("/tmp/worktree");
        return {
          async *[Symbol.asyncIterator]() {
            yield {
              type: "system",
              subtype: "init",
              session_id: "sess-streaming",
              uuid: "init-streaming",
            };
            yield {
              type: "result",
              subtype: "success",
              session_id: "sess-streaming",
              uuid: "result-streaming",
            };
          },
          close: () => {
            closeCalled = true;
          },
        };
      },
    }),
  });

  for await (const _event of driver.runAsk({
    threadId: "thr_streaming",
    prompt: "Summarize streaming foundation",
    workspacePath: "/tmp/workspace",
    worktreePath: "/tmp/worktree",
    routes,
    signal: new AbortController().signal,
  })) {
    // consume
  }

  expect(receivedPromptKind).toBe("streaming");
  expect(promptText).toBe("Summarize streaming foundation");
  expect(closeCalled).toBe(true);
});

test("ClaudeAgentSdkDriver mid-turn pushUserMessage yields on the held prompt stream", async () => {
  let openHandle: import("../src/claude-agent-sdk").ClaudeQueryHandle | undefined;
  const promptMessages: Array<{ text: string; uuid?: string }> = [];
  let streamInputCalls = 0;
  let releaseResult: (() => void) | undefined;
  const resultGate = new Promise<void>((resolve) => {
    releaseResult = resolve;
  });
  const driver = new ClaudeAgentSdkDriver({
    apiKey: "test-key",
    baseUrl: "http://127.0.0.1:36037",
    queryLifecycle: {
      onOpen: (handle) => {
        openHandle = handle;
      },
    },
    loadSdk: async () => ({
      query: ({ prompt }) => {
        void (async () => {
          for await (const message of prompt as AsyncIterable<{
            uuid?: string;
            message: { content: string };
          }>) {
            promptMessages.push({
              text: message.message.content,
              ...(message.uuid ? { uuid: message.uuid } : {}),
            });
          }
        })();
        return {
          async *[Symbol.asyncIterator]() {
            yield {
              type: "system",
              subtype: "init",
              session_id: "sess-mid-turn",
              uuid: "init-mid-turn",
            };
            await resultGate;
            yield {
              type: "result",
              subtype: "success",
              session_id: "sess-mid-turn",
              uuid: "result-mid-turn",
            };
          },
          streamInput: async () => {
            streamInputCalls += 1;
          },
          close: () => {},
        };
      },
    }),
  });

  const run = (async () => {
    for await (const event of driver.runAsk({
      threadId: "thr_mid_turn",
      prompt: "Start",
      workspacePath: "/tmp/workspace",
      worktreePath: "/tmp/worktree",
      routes,
      signal: new AbortController().signal,
    })) {
      if (event.type === "session.captured" && openHandle) {
        await openHandle.pushUserMessage("Inject mid-turn", {
          uuid: "tfu_00000000-0000-4000-8000-000000000001",
        });
        releaseResult?.();
      }
    }
  })();

  await run;
  expect(streamInputCalls).toBe(0);
  expect(promptMessages).toEqual([
    { text: "Start", uuid: expect.stringMatching(/^[0-9a-f-]{36}$/) },
    { text: "Inject mid-turn", uuid: "00000000-0000-4000-8000-000000000001" },
  ]);
  expect(openHandle?.phase).toBe("closed");
});

test("ClaudeAgentSdkDriver finishes when SDK output ends only after prompt close", async () => {
  let promptDone = false;
  let queryClosed = false;

  const driver = new ClaudeAgentSdkDriver({
    apiKey: "test-key",
    baseUrl: "http://127.0.0.1:36037",
    loadSdk: async () => ({
      query: ({ prompt }) => {
        const promptDoneWork = (async () => {
          for await (const _message of prompt as AsyncIterable<unknown>) {
            // Simulate SDK streamInput draining the shared mailbox.
          }
          promptDone = true;
        })();
        return {
          async *[Symbol.asyncIterator]() {
            yield {
              type: "system",
              subtype: "init",
              session_id: "sess-close-after-result",
              uuid: "init-close-after-result",
            };
            yield {
              type: "result",
              subtype: "success",
              session_id: "sess-close-after-result",
              uuid: "result-close-after-result",
            };
            await promptDoneWork;
          },
          close: () => {
            queryClosed = true;
          },
        };
      },
    }),
  });

  for await (const _event of driver.runAsk({
    threadId: "thr_close_after_result",
    prompt: "finish normally",
    workspacePath: "/tmp/workspace",
    worktreePath: "/tmp/worktree",
    routes,
    signal: new AbortController().signal,
  })) {
    // consume
  }

  expect(promptDone).toBe(true);
  expect(queryClosed).toBe(true);
});

test("ClaudeAgentSdkDriver keeps the control channel for an active subagent after result", async () => {
  let promptDone = false;
  let subagentStarted = false;
  let subagentStopped = false;
  const subagentSessions = {
    phase: "execution" as const,
    threadId: "thr_active_subagent",
    onStart: () => {
      subagentStarted = true;
    },
    onStop: () => {
      subagentStopped = true;
    },
    resolveResume: () => undefined,
  };

  const driver = new ClaudeAgentSdkDriver({
    apiKey: "test-key",
    baseUrl: "http://127.0.0.1:36037",
    hookContext: { subagentSessions },
    loadSdk: async () => ({
      query: ({ prompt }) => {
        const promptDoneWork = (async () => {
          for await (const _message of prompt as AsyncIterable<unknown>) {
            // Keep the simulated SDK input consumer alive until close.
          }
          promptDone = true;
        })();
        return {
          async *[Symbol.asyncIterator]() {
            yield {
              type: "system",
              subtype: "init",
              session_id: "sess-active-subagent",
              uuid: "init-active-subagent",
            };
            subagentSessions.onStart({ agentId: "agent_1", agentType: "coder" });
            yield {
              type: "result",
              subtype: "success",
              session_id: "sess-active-subagent",
              uuid: "result-active-subagent",
            };
            expect(promptDone).toBe(false);
            subagentSessions.onStop({ agentId: "agent_1", agentType: "coder" });
            await promptDoneWork;
          },
        };
      },
    }),
  });

  for await (const _event of driver.runAsk({
    threadId: "thr_active_subagent",
    prompt: "wait for the background agent",
    workspacePath: "/tmp/workspace",
    worktreePath: "/tmp/worktree",
    routes,
    signal: new AbortController().signal,
  })) {
    // consume
  }

  expect(subagentStarted).toBe(true);
  expect(subagentStopped).toBe(true);
  expect(promptDone).toBe(true);
});

test("ClaudeAgentSdkDriver canUseTool AskUserQuestion after subagents stop and interim result", async () => {
  let promptDone = false;
  const askQuestionCalls: string[] = [];
  const subagentSessions = {
    phase: "execution" as const,
    threadId: "thr_ask_after_subagent",
    onStart: () => {},
    onStop: () => {},
    resolveResume: () => undefined,
  };

  const driver = new ClaudeAgentSdkDriver({
    apiKey: "test-key",
    baseUrl: "http://127.0.0.1:36037",
    hookContext: { subagentSessions },
    toolPermissionHandler: async (request) => {
      if (request.toolName === "AskUserQuestion") {
        askQuestionCalls.push(request.toolUseId);
      }
      return { behavior: "allow", updatedInput: request.input };
    },
    loadSdk: async () => ({
      query: ({ prompt, options }) => {
        void (async () => {
          for await (const _message of prompt as AsyncIterable<unknown>) {
            // Held mailbox stays open until teardown.
          }
          promptDone = true;
        })();
        return {
          async *[Symbol.asyncIterator]() {
            const canUseTool = options.canUseTool as
              | ((
                  toolName: string,
                  input: Record<string, unknown>,
                  options: Record<string, unknown>,
                ) => Promise<unknown>)
              | undefined;
            yield {
              type: "system",
              subtype: "init",
              session_id: "sess-ask-after-subagent",
              uuid: "init-ask-after-subagent",
            };
            subagentSessions.onStart({ agentId: "explore_1", agentType: "explore" });
            subagentSessions.onStop({ agentId: "explore_1", agentType: "explore" });
            yield {
              type: "result",
              subtype: "success",
              session_id: "sess-ask-after-subagent",
              uuid: "result-interim-summary",
            };
            expect(promptDone).toBe(false);
            await canUseTool?.(
              "AskUserQuestion",
              {
                questions: [
                  {
                    question: "Send path?",
                    options: [{ label: "SDK" }, { label: "Webhook" }],
                  },
                ],
              },
              { toolUseID: "call_ask_after_subagent" },
            );
            expect(promptDone).toBe(false);
            yield {
              type: "result",
              subtype: "success",
              session_id: "sess-ask-after-subagent",
              uuid: "result-final",
            };
            while (!promptDone) {
              await new Promise((resolve) => setTimeout(resolve, 1));
            }
          },
          streamInput: async () => {
            throw new Error("query.streamInput must not be called");
          },
          close: () => {},
        };
      },
    }),
  });

  for await (const _event of driver.runPlan({
    threadId: "thr_ask_after_subagent",
    prompt: "Plan a Feishu bot",
    workspacePath: "/tmp/workspace",
    worktreePath: "/tmp/worktree",
    routes,
    signal: new AbortController().signal,
  })) {
    // consume
  }

  expect(askQuestionCalls).toEqual(["call_ask_after_subagent"]);
  expect(promptDone).toBe(true);
});

test("ClaudeAgentSdkDriver emits incomplete when mid-turn input has no matching result", async () => {
  let openHandle: import("../src/claude-agent-sdk").ClaudeQueryHandle | undefined;
  let releaseAfterFirstResult: (() => void) | undefined;
  const afterFirstResult = new Promise<void>((resolve) => {
    releaseAfterFirstResult = resolve;
  });
  const driver = new ClaudeAgentSdkDriver({
    apiKey: "test-key",
    baseUrl: "http://127.0.0.1:36038",
    queryLifecycle: {
      onOpen: (handle) => {
        openHandle = handle;
      },
    },
    loadSdk: async () => ({
      query: ({ prompt }) => {
        // Mid-turn pushes only land when something consumes the held prompt iterable.
        void (async () => {
          for await (const _message of prompt as AsyncIterable<unknown>) {
            // drain until close
          }
        })();
        return {
          async *[Symbol.asyncIterator]() {
            yield {
              type: "system",
              subtype: "init",
              session_id: "sess-unmatched",
              uuid: "init-unmatched",
            };
            yield {
              type: "result",
              subtype: "success",
              session_id: "sess-unmatched",
              uuid: "result-1",
              result: "first turn ok",
            };
            await afterFirstResult;
            // Mid-turn accepted, but stream ends without a second result.
          },
          close: () => {},
        };
      },
    }),
  });

  const terminals: Array<Record<string, unknown>> = [];
  for await (const event of driver.runAsk({
    threadId: "thr_unmatched_mid",
    prompt: "Start",
    workspacePath: "/tmp/workspace",
    worktreePath: "/tmp/worktree",
    routes,
    signal: new AbortController().signal,
  })) {
    if (event.type === "run.terminal") {
      terminals.push(event.payload as Record<string, unknown>);
    }
    if (event.type === "run.terminal" && (event.payload as { status?: string }).status === "completed") {
      await openHandle!.pushUserMessage("Second turn");
      releaseAfterFirstResult?.();
    }
  }

  expect(terminals.length).toBeGreaterThanOrEqual(2);
  expect(terminals[0]).toMatchObject({ status: "completed" });
  expect(terminals.at(-1)).toMatchObject({
    status: "incomplete",
    reason: "Claude run ended while a user turn was still awaiting a result.",
  });
});

test("createClaudeQueryHandle rejects push after phase closes", async () => {
  const pushed: Array<{ text: string; options?: { uuid?: string } }> = [];
  const handle = createClaudeQueryHandle(
    { async *[Symbol.asyncIterator]() {} },
    {
      promptStream: createFakeHeldPromptStream({
        push: async (text, pushOptions) => {
          pushed.push({ text, options: pushOptions });
        },
      }),
    },
  );
  await handle.pushUserMessage("ok", { uuid: "tfu_ok" });
  expect(pushed).toEqual([{ text: "ok", options: { uuid: "tfu_ok" } }]);
  handle.phase = "closing";
  await expect(handle.pushUserMessage("nope")).rejects.toThrow(/not accepting mid-turn/i);
});

test("createClaudeQueryHandle marks promptStream push timeout as delivery unknown", async () => {
  const pushed: Array<{ text: string; options?: { uuid?: string } }> = [];
  let streamInputCalled = false;
  const handle = createClaudeQueryHandle(
    {
      async *[Symbol.asyncIterator]() {},
      streamInput: async () => {
        streamInputCalled = true;
        throw new Error("query.streamInput must not be called");
      },
    },
    {
      promptStream: createFakeHeldPromptStream({
        push: (text, pushOptions) => {
          pushed.push({ text, options: pushOptions });
          return new Promise<void>(() => {});
        },
      }),
      streamInputDeadlineMs: 5,
    },
  );
  try {
    await handle.pushUserMessage("  uncertain  ", { uuid: "tfu_timeout" });
    expect.unreachable("push should time out");
  } catch (error) {
    expect(error).toMatchObject({
      code: "ClaudeStreamInputFailed",
      deliveryUnknown: true,
    });
  }
  expect(streamInputCalled).toBe(false);
  expect(pushed).toEqual([{ text: "uncertain", options: { uuid: "tfu_timeout" } }]);
});

test("ClaudeAgentSdkDriver tears down the Query when onOpen fails", async () => {
  let closeCalled = false;
  let onClosedCalled = false;
  const driver = new ClaudeAgentSdkDriver({
    apiKey: "test-key",
    baseUrl: "http://127.0.0.1:36037",
    queryLifecycle: {
      onOpen: () => {
        throw new Error("port open failed");
      },
      onClosed: () => {
        onClosedCalled = true;
      },
    },
    loadSdk: async () => ({
      query: () => ({
        async *[Symbol.asyncIterator]() {},
        close: () => {
          closeCalled = true;
        },
      }),
    }),
  });

  const run = async () => {
    for await (const _event of driver.runAsk({
      threadId: "thr_open_failure",
      prompt: "Start",
      workspacePath: "/tmp/workspace",
      worktreePath: "/tmp/worktree",
      routes,
      signal: new AbortController().signal,
    })) {
      // No events are expected before onOpen rejects.
    }
  };

  await expect(run()).rejects.toThrow("port open failed");
  expect(closeCalled).toBe(true);
  expect(onClosedCalled).toBe(true);
});

test("Claude SDK resolved output ceiling overrides inherited 32K in process and settings env", () => {
  const inherited = process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS;
  process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = "32000";
  try {
    const env = buildSdkProcessEnv({
      apiKey: "router",
      baseUrl: "http://127.0.0.1:18765",
      maxOutputTokens: 128_000,
    });
    expect(env.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe("128000");
    const options: Record<string, unknown> = {
      settings: { env: { CLAUDE_CODE_MAX_OUTPUT_TOKENS: "32000" } },
    };
    applyEcoSdkSettings(options, "router", "http://127.0.0.1:18765", { maxOutputTokens: 128_000 });
    expect((options.settings as { env: Record<string, string> }).env.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe(
      "128000",
    );
    expect(() =>
      buildSdkProcessEnv({ apiKey: "router", baseUrl: "http://127.0.0.1", maxOutputTokens: NaN }),
    ).toThrow("valid resolved");
  } finally {
    if (inherited === undefined) delete process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS;
    else process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = inherited;
  }
});

test("Claude session context windows override inherited settings without mutating the host", async () => {
  const inherited = process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS;
  process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = "200000";
  const captured: Record<string, unknown>[] = [];
  try {
    const driver = new ClaudeAgentSdkDriver({
      apiKey: "local-test",
      baseUrl: "http://127.0.0.1:36037",
      loadSdk: async () => ({
        query: ({ options }) => {
          captured.push(options);
          return {
            close() {},
            async *[Symbol.asyncIterator]() {
              yield { type: "result", subtype: "success", num_turns: 1, session_id: crypto.randomUUID() };
            },
          };
        },
      }),
    });
    await Promise.all(
      [262_144, 524_288].map(async (contextWindow) => {
        const planner = routes[0];
        if (!planner) throw new Error("Missing planner test route.");
        for await (const _event of driver.runAsk({
          threadId: `thr_context_${contextWindow}`,
          prompt: "Check context window",
          workspacePath: "/tmp",
          worktreePath: "/tmp",
          routes: [{ ...planner, primary: { ...planner.primary, contextWindow } }],
          signal: new AbortController().signal,
        })) {
          // Consume both concurrent sessions.
        }
      }),
    );
    expect(captured).toHaveLength(2);
    expect(
      captured
        .map((options) => (options.env as Record<string, string>).CLAUDE_CODE_MAX_CONTEXT_TOKENS)
        .sort(),
    ).toEqual(["262144", "524288"]);
    expect(
      captured
        .map(
          (options) =>
            (options.settings as { env: Record<string, string> }).env.CLAUDE_CODE_MAX_CONTEXT_TOKENS,
        )
        .sort(),
    ).toEqual(["262144", "524288"]);
    expect(process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe("200000");
    const settings: Record<string, unknown> = {
      settings: { env: { CLAUDE_CODE_MAX_CONTEXT_TOKENS: "200000" } },
    };
    applyEcoSdkSettings(settings, "router", "http://127.0.0.1", { contextWindow: 262_144 });
    expect((settings.settings as { env: Record<string, string> }).env.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe(
      "262144",
    );
    for (const contextWindow of [NaN, Infinity, 0, -1, 1.5]) {
      expect(() =>
        buildSdkProcessEnv({ apiKey: "router", baseUrl: "http://127.0.0.1", contextWindow }),
      ).toThrow("valid resolved context window");
      expect(() => applyEcoSdkSettings({}, "router", "http://127.0.0.1", { contextWindow })).toThrow(
        "valid resolved context window",
      );
    }
  } finally {
    if (inherited === undefined) delete process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS;
    else process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = inherited;
  }
});
