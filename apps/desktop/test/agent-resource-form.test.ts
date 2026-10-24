import { expect, test } from "bun:test";
import {
  type AgentResourceFormState,
  buildMainAgentConfigFromForm,
  buildMainAgentPromptFromForm,
  buildSubagentOrchestrationFromForm,
  createBlankAgentResourceForm,
  createBlankMainAgentConfigForm,
  createCopiedMainAgentConfigForm,
  createCopiedSubagentOrchestrationForm,
  createResourceAgentFormFromTemplate,
  mainAgentConfigToForm,
  mainAgentPromptToForm,
  subagentOrchestrationToForm,
} from "../src/renderer/agent-resource-form";
import {
  CODING_AGENT_TEMPLATE_IDS,
  createBuiltInAgentTemplates,
  resolveOrchestrationSnapshot,
} from "../src/shared/agent-orchestration";
import type { AgentTemplate, ProviderConfigView } from "../src/shared/ipc";
import { runtimeRoleRoutesFromOrchestrationSnapshot } from "../src/shared/thread-runtime-config";

const provider: ProviderConfigView = {
  id: "provider_1",
  name: "Provider One",
  baseUrl: "https://example.test",
  requestPath: "",
  version: "v1",
  apiCompat: "anthropic",
  defaultModel: "model-default",
  enabled: true,
  hasApiKey: true,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const researcherTemplate: AgentTemplate = {
  id: "builtin.research.researcher",
  name: "Researcher",
  description: "Research agent",
  prompt: "Research.",
  whenToUse: "Use for research.",
  defaultTools: {
    allowed: ["Read", "WebSearch"],
    disallowed: ["Bash"],
    filesystem: { read: "workspace", write: "none" },
    network: { webSearch: true, webFetch: false },
  },
  mcpServers: ["docs"],
  skills: ["citations"],
  allowDelegation: false,
  builtIn: true,
  source: "built_in",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const exploreTemplate = createBuiltInAgentTemplates().find(
  (template) => template.id === CODING_AGENT_TEMPLATE_IDS.explore,
)!;

function withRequiredCandidateIds(form: AgentResourceFormState): AgentResourceFormState {
  form.mainCandidateModelId = form.mainCandidateModelId || "cand-main";
  for (const agent of form.agents) {
    if (agent.enabled && !agent.candidateModelId) {
      agent.candidateModelId = `cand-${agent.agentKey}`;
    }
  }
  return form;
}

function requireFormAgent(form: AgentResourceFormState, agentKey: string) {
  const agent = form.agents.find((candidate) => candidate.agentKey === agentKey);
  if (!agent) {
    throw new Error(`Missing form agent: ${agentKey}`);
  }
  return agent;
}

function sampleOrchestrationForm(): AgentResourceFormState {
  const form = subagentOrchestrationToForm(
    {
      id: "user.research.subagents",
      name: "Research Subagents",
      agents: [
        {
          agentKey: "researcher",
          templateId: researcherTemplate.id,
          displayName: "Researcher",
          modelRef: {
            providerId: provider.id,
            modelId: "model-research",
            candidateModelId: "cand-researcher",
          },
          tools: researcherTemplate.defaultTools,
          mcpServers: ["docs"],
          skills: ["citations"],
          enabled: true,
        },
        {
          agentKey: "explore",
          templateId: exploreTemplate.id,
          displayName: "Explore",
          modelRef: {
            providerId: provider.id,
            modelId: "model-explore",
            candidateModelId: "cand-explore",
          },
          tools: exploreTemplate.defaultTools,
          mcpServers: [],
          skills: [],
          enabled: true,
        },
      ],
      strategy: {
        kind: "autonomous",
        guidancePrompt: "Use the researcher when evidence quality matters.",
      },
      updatedAt: "2026-01-01T00:00:00.000Z",
      source: "user",
    },
    [researcherTemplate],
  );
  return withRequiredCandidateIds(form);
}

test("createBlankMainAgentConfigForm defaults the main agent to hands-on capabilities", () => {
  const form = withRequiredCandidateIds(createBlankMainAgentConfigForm({ providers: [provider] }));

  expect(form.mainWriteCodebase).toBe(true);
  expect(form.mainBash).toBe(true);
  expect(form.mainAllowDelegation).toBe(true);
  expect(form.agents).toEqual([]);

  const built = buildMainAgentConfigFromForm(form, {
    nowIso: "2026-06-10T00:00:00.000Z",
  });
  expect(built.tools.allowed).toEqual([]);
  expect(built.tools.filesystem).toEqual({ read: "workspace", write: "workspace" });
  expect(built.tools.bash).toMatchObject({ enabled: true });
  expect(built.skills).toEqual([]);
});

test("createBlankAgentResourceForm still seeds Explore for orchestration defaults", () => {
  const form = withRequiredCandidateIds(
    createBlankAgentResourceForm({ providers: [provider], templates: createBuiltInAgentTemplates() }),
  );
  expect(form.agents.map((agent) => agent.agentKey)).toEqual(["explore"]);

  form.agents = form.agents.filter((agent) => agent.agentKey !== "explore");
  const withoutExplore = buildSubagentOrchestrationFromForm(form, {
    templates: createBuiltInAgentTemplates(),
  });
  expect(withoutExplore.agents).toEqual([]);

  form.agents.push(
    createResourceAgentFormFromTemplate(exploreTemplate, {
      provider,
      existingAgentKeys: form.agents.map((agent) => agent.agentKey),
    }),
  );
  expect(form.agents.map((agent) => agent.agentKey)).toEqual(["explore"]);
});

test("createCopiedSubagentOrchestrationForm creates user-editable copies", () => {
  const form = createCopiedSubagentOrchestrationForm(
    buildSubagentOrchestrationFromForm(sampleOrchestrationForm(), {
      templates: [researcherTemplate],
    }),
    {
      existingIds: ["user.research.subagents"],
      existingNames: ["Research Subagents Copy"],
      templates: [researcherTemplate],
    },
  );

  expect(form.id).toBe("user.research.subagents_2");
  expect(form.name).toBe("Research Subagents Copy 2");
  expect(form.source).toBe("user");
  expect(form.agents[0]?.agentKey).toBe("researcher");
  expect(form.agents[1]?.agentKey).toBe("explore");
});

test("buildSubagentOrchestrationFromForm binds models and preserves guidance", () => {
  const form = sampleOrchestrationForm();
  form.id = "user.research.subagents";
  form.source = "project";
  requireFormAgent(form, "explore").modelId = "model-explore-fast";
  form.guidancePrompt = "Delegate research only when it materially improves the answer.";
  form.agents.push(
    createResourceAgentFormFromTemplate(researcherTemplate, {
      provider,
      existingAgentKeys: form.agents.map((agent) => agent.agentKey),
    }),
  );
  const sourceVerifier = form.agents[2]!;
  sourceVerifier.agentKey = "source_verifier";
  sourceVerifier.displayName = "Source Verifier";
  sourceVerifier.candidateModelId = "cand-source-verifier";

  const built = buildSubagentOrchestrationFromForm(form, {
    templates: [researcherTemplate],
    nowIso: "2026-06-08T00:00:00.000Z",
  });

  expect(built).toMatchObject({
    id: "user.research.subagents",
    source: "project",
    updatedAt: "2026-06-08T00:00:00.000Z",
  });
  expect(built.agents.map((agent) => agent.agentKey)).toEqual(["researcher", "explore", "source_verifier"]);
  expect(built.agents[2]?.tools.disallowed).toContain("Bash");
  expect(built.strategy).toEqual({
    kind: "autonomous",
    guidancePrompt: "Delegate research only when it materially improves the answer.",
  });
});

test("buildMainAgentConfigFromForm saves capability policies", () => {
  const form = withRequiredCandidateIds(
    mainAgentConfigToForm(
      buildMainAgentConfigFromForm(
        {
          ...createBlankMainAgentConfigForm({ providers: [provider] }),
          id: "user.structured.main",
          mainProviderId: provider.id,
          mainModelId: "model-main",
          mainCandidateModelId: "cand-main",
        },
        { nowIso: "2026-01-01T00:00:00.000Z" },
      ),
    ),
  );
  form.mainWriteCodebase = false;
  form.mainNetwork = false;

  const built = buildMainAgentConfigFromForm(form);

  expect(built.tools).toMatchObject({
    allowed: [],
    disallowed: expect.arrayContaining(["Write", "WebSearch", "WebFetch"]),
    bash: { enabled: true },
    filesystem: { read: "workspace", write: "none" },
    network: { webSearch: false, webFetch: false },
  });
  expect(built.tools).not.toHaveProperty("mcp");
});

test("V4A teaching form defaults false and round-trips when enabled", () => {
  const blankMain = createBlankMainAgentConfigForm({ providers: [provider] });
  expect(blankMain.mainV4aTeachingEnabled).toBe(false);

  const mainForm = withRequiredCandidateIds({
    ...blankMain,
    id: "user.v4a.main",
    mainProviderId: provider.id,
    mainModelId: "model-main",
    mainV4aTeachingEnabled: true,
  });
  const mainBuilt = buildMainAgentConfigFromForm(mainForm);
  expect(mainBuilt.v4aTeachingEnabled).toBe(true);
  expect(mainAgentConfigToForm(mainBuilt).mainV4aTeachingEnabled).toBe(true);

  const orchForm = withRequiredCandidateIds(sampleOrchestrationForm());
  expect(orchForm.agents.every((agent) => agent.v4aTeachingEnabled === false)).toBe(true);
  const researcher = requireFormAgent(orchForm, "researcher");
  researcher.v4aTeachingEnabled = true;
  const orchBuilt = buildSubagentOrchestrationFromForm(orchForm, {
    templates: [researcherTemplate, exploreTemplate],
  });
  expect(orchBuilt.agents.find((agent) => agent.agentKey === "researcher")?.v4aTeachingEnabled).toBe(true);
  expect(orchBuilt.agents.find((agent) => agent.agentKey === "explore")?.v4aTeachingEnabled).toBeUndefined();
  expect(
    subagentOrchestrationToForm(orchBuilt).agents.find((agent) => agent.agentKey === "researcher")
      ?.v4aTeachingEnabled,
  ).toBe(true);
});

test("buildSubagentOrchestrationFromForm rejects reserved and duplicate agent keys", () => {
  const form = sampleOrchestrationForm();
  form.id = "user.bad";
  const firstAgent = form.agents[0]!;
  firstAgent.agentKey = "system";

  expect(() => buildSubagentOrchestrationFromForm(form, { templates: [researcherTemplate] })).toThrow(
    /系统保留名称|reserved/i,
  );

  firstAgent.agentKey = "researcher";
  form.agents.push({ ...firstAgent });
  expect(() => buildSubagentOrchestrationFromForm(form, { templates: [researcherTemplate] })).toThrow(
    /Agent key 重复|Duplicate agent key/i,
  );
});

test("buildMainAgentConfigFromForm requires candidate model selection", () => {
  const form = mainAgentConfigToForm(
    buildMainAgentConfigFromForm(
      withRequiredCandidateIds(createBlankMainAgentConfigForm({ providers: [provider] })),
    ),
  );
  form.mainCandidateModelId = "";

  expect(() => buildMainAgentConfigFromForm(form)).toThrow(/可选模型|candidate model/i);
});

test("mainAgentConfig and subagent orchestration round-trip apiCompat", () => {
  const mainForm = withRequiredCandidateIds(
    mainAgentConfigToForm(
      buildMainAgentConfigFromForm({
        ...withRequiredCandidateIds(createBlankMainAgentConfigForm({ providers: [provider] })),
        id: "user.main",
        mainProviderId: provider.id,
        mainModelId: "model-main",
        mainApiCompat: "anthropic",
      }),
    ),
  );
  const orchestrationForm = sampleOrchestrationForm();
  requireFormAgent(orchestrationForm, "explore").apiCompat = "openai_chat_completions";
  orchestrationForm.agents[0]!.apiCompat = "openai_responses";

  const mainBuilt = buildMainAgentConfigFromForm(mainForm);
  const orchestrationBuilt = buildSubagentOrchestrationFromForm(orchestrationForm, {
    templates: [researcherTemplate],
  });

  expect(mainBuilt.modelRef.apiCompat).toBe("anthropic");
  expect(orchestrationBuilt.agents.find((agent) => agent.agentKey === "explore")?.modelRef.apiCompat).toBe(
    "openai_chat_completions",
  );
  expect(orchestrationBuilt.agents[0]?.modelRef.apiCompat).toBe("openai_responses");

  const snapshot = resolveOrchestrationSnapshot(
    {
      mainAgentConfigId: mainBuilt.id,
      mainPrompt: { mode: "builtin" },
      subagents: { mode: "orchestration", orchestrationId: orchestrationBuilt.id },
    },
    {
      mainAgentConfigs: [mainBuilt],
      mainAgentPrompts: [],
      subagentOrchestrations: [orchestrationBuilt],
    },
  );
  const routes = runtimeRoleRoutesFromOrchestrationSnapshot(snapshot);
  expect(routes.find((route) => route.role === "main")?.apiCompat).toBe("anthropic");
  expect(routes.find((route) => route.role === "explore")?.apiCompat).toBe("openai_chat_completions");
});

test("buildMainAgentPromptFromForm stores custom append text", () => {
  const form = mainAgentPromptToForm(
    buildMainAgentPromptFromForm({
      ...createBlankMainAgentConfigForm(),
      id: "user.prompt",
      name: "Research Prompt",
      mainPrompt: "Coordinate research.",
    }),
  );
  const built = buildMainAgentPromptFromForm(form);
  expect(built.mode).toBe("custom_append");
  expect(built.prompt).toBe("Coordinate research.");
});

test("createCopiedMainAgentConfigForm preserves configuration", () => {
  const source = buildMainAgentConfigFromForm(
    withRequiredCandidateIds(
      mainAgentConfigToForm(
        buildMainAgentConfigFromForm(
          withRequiredCandidateIds({
            ...createBlankMainAgentConfigForm({ providers: [provider] }),
            id: "user.main",
            name: "Main Config",
            mainProviderId: provider.id,
            mainModelId: "model-main",
          }),
        ),
      ),
    ),
  );
  const copied = createCopiedMainAgentConfigForm(source, {
    existingIds: [source.id],
    existingNames: [`${source.name} Copy`],
  });
  expect(copied.id).not.toBe(source.id);
  expect(copied.name).toContain("Copy");
  expect(copied.mainModelId).toBe("model-main");
});
