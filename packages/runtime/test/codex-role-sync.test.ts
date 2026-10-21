import { afterEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  EcoAgentTemplateConfig,
  EcoOrchestrationConfig,
  EcoToolPolicy,
} from "../src/agent-orchestration";
import {
  buildCodexGatewayModelAlias,
  resolveCodexHomeDir,
  syncCodexConfigFromEcoProviders,
} from "../src/codex-config-sync";
import {
  assertCodexRoleProvidersAvailable,
  mapEcoThinkingEffortToCodexReasoningEffort,
  sanitizeCodexRoleId,
  syncOrchestrationAgentsToCodexRoles,
  withCodexNativeImageView,
  withCodexRemoteCompaction,
  withCodexSkillConfig,
} from "../src/codex-role-sync";

const tempDirs: string[] = [];

test("Codex effort mapping keeps max and ultra distinct", () => {
  expect(mapEcoThinkingEffortToCodexReasoningEffort("off")).toBe("none");
  expect(mapEcoThinkingEffortToCodexReasoningEffort("max")).toBe("max");
  expect(mapEcoThinkingEffortToCodexReasoningEffort("ultra")).toBe("ultra");
  expect(mapEcoThinkingEffortToCodexReasoningEffort(" focused ")).toBe("focused");
  expect(() => mapEcoThinkingEffortToCodexReasoningEffort("   ")).toThrow("non-empty string");
});

test("Codex thread Skill visibility is path-scoped", () => {
  const config = withCodexSkillConfig({ mcp_servers: {} }, [
    { path: "/repo/.agents/skills/project/SKILL.md", enabled: true },
    { path: "/Users/test/.agents/skills/user/SKILL.md", enabled: false },
  ]);
  expect(config.skills).toEqual({
    config: [
      { path: "/repo/.agents/skills/project/SKILL.md", enabled: true },
      { path: "/Users/test/.agents/skills/user/SKILL.md", enabled: false },
    ],
  });
});

test("disabling built-in imagegen preserves user skill switches on repeated config updates", () => {
  const initial = withCodexSkillConfig({ mcp_servers: {} }, [
    { path: "/repo/.agents/skills/project/SKILL.md", enabled: true },
    { path: "/Users/test/.agents/skills/user/SKILL.md", enabled: false },
  ]);
  const updated = withCodexSkillConfig(initial, [
    { path: "/system/imagegen/SKILL.md", enabled: false },
    { path: "/repo/.agents/skills/project/SKILL.md", enabled: false },
  ]);
  expect(updated.skills?.config).toEqual([
    { path: "/repo/.agents/skills/project/SKILL.md", enabled: false },
    { path: "/Users/test/.agents/skills/user/SKILL.md", enabled: false },
    { path: "/system/imagegen/SKILL.md", enabled: false },
  ]);
  expect(initial.skills?.config).toEqual([
    { path: "/repo/.agents/skills/project/SKILL.md", enabled: true },
    { path: "/Users/test/.agents/skills/user/SKILL.md", enabled: false },
  ]);
  expect(withCodexSkillConfig(updated, []).skills).toEqual(updated.skills);
});

test("native image viewing follows the selected provider without changing other thread features", () => {
  const config = {
    features: { multi_agent: true, hooks: true, multi_agent_v2: false },
    mcp_servers: { eco_image_view: { enabled: true } },
  };
  expect(withCodexNativeImageView(config, "custom")).toEqual({
    ...config,
    features: { ...config.features, view_image: false },
  });
  expect(withCodexNativeImageView(withCodexNativeImageView(config, "custom"), "openai")).toEqual({
    ...config,
    features: { ...config.features, view_image: true },
  });
  expect(config.features).not.toHaveProperty("view_image");
});

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function makeTempEcoDataDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eco-codex-roles-"));
  tempDirs.push(dir);
  return dir;
}

test("syncOrchestrationAgentsToCodexRoles writes role toml for explore and enabled agents", async () => {
  const ecoDataDir = await makeTempEcoDataDir();
  const codexHomeDir = resolveCodexHomeDir(ecoDataDir);
  const templates = [researchTemplate, codingTemplate];

  const result = await syncOrchestrationAgentsToCodexRoles({
    codexHomeDir,
    orchestration: buildOrchestration(),
    templates,
  });

  expect(result.roleIds).toEqual(["explore", "researcher", "coder"]);
  expect(result.agentRoles.map((role) => role.roleId)).toEqual(["explore", "researcher", "coder"]);
  expect(result.roles.map((role) => role.modelId)).toEqual([
    "explore-model",
    "research-model",
    "coder-model",
  ]);
  const exploreToml = await fs.readFile(path.join(result.agentsDir, "explore.toml"), "utf8");
  expect(exploreToml).toContain('name = "explore"');
  expect(exploreToml).toContain("Read-only codebase exploration");
  expect(exploreToml).toContain("You are a read-only codebase exploration subagent.");
  expect(exploreToml).toContain("Do not create, edit, or delete files.");
  expect(exploreToml).not.toContain('developer_instructions = ""');
  expect(exploreToml).toContain('sandbox_mode = "read-only"');
  expect(exploreToml).toContain('approval_policy = "on-request"');
  expect(exploreToml).toContain('model = "eco_main__explore-model"');
  expect(exploreToml).toContain('model_provider = "eco_main"');
  expect(exploreToml).toContain("[features]\nview_image = false");
  const researcherToml = await fs.readFile(path.join(result.agentsDir, "researcher.toml"), "utf8");
  expect(researcherToml).toContain('name = "researcher"');
  expect(researcherToml).toContain("developer_instructions = ");
  expect(researcherToml).toContain("Research carefully and cite sources.");
  expect(researcherToml).toContain('sandbox_mode = "read-only"');
  expect(researcherToml).toContain('web_search = "live"');
  expect(researcherToml).toContain('model = "eco_main__research-model"');
  expect(researcherToml).toContain('model_provider = "eco_main"');
  expect(result.roleThreadConfigs.researcher?.features?.view_image).toBe(false);
  const coderToml = await fs.readFile(path.join(result.agentsDir, "coder.toml"), "utf8");
  expect(coderToml).toContain('model_reasoning_effort = "high"');
  await expect(fs.stat(path.join(result.agentsDir, "architect.toml"))).rejects.toThrow();
});

test("execution mode changes per-turn role policy without changing immutable role configs", async () => {
  const ecoDataDir = await makeTempEcoDataDir();
  const initial = await syncOrchestrationAgentsToCodexRoles({
    codexHomeDir: resolveCodexHomeDir(ecoDataDir),
    orchestration: buildOrchestration(),
    templates: [researchTemplate, codingTemplate],
    executionConfirmationMode: "always",
  });
  const initialFiles = await Promise.all(initial.roles.map((role) => fs.readFile(role.rolePath, "utf8")));
  const result = await syncOrchestrationAgentsToCodexRoles({
    codexHomeDir: resolveCodexHomeDir(ecoDataDir),
    orchestration: buildOrchestration(),
    templates: [researchTemplate, codingTemplate],
    executionConfirmationMode: "allow_all",
  });

  for (const role of result.roles) {
    expect(role.toolPolicy.sandboxMode).toBe("danger-full-access");
    expect(role.toolPolicy.approvalPolicy).toBe("never");
  }
  expect(result.agentsDir).toBe(initial.agentsDir);
  expect(result.threadConfig).toEqual(initial.threadConfig);
  expect(result.roleThreadConfigs).toEqual(initial.roleThreadConfigs);
  expect(await Promise.all(result.roles.map((role) => fs.readFile(role.rolePath, "utf8")))).toEqual(
    initialFiles,
  );
  const restored = await syncOrchestrationAgentsToCodexRoles({
    codexHomeDir: resolveCodexHomeDir(ecoDataDir),
    orchestration: buildOrchestration(),
    templates: [researchTemplate, codingTemplate],
    executionConfirmationMode: "auto",
  });
  expect(restored.threadConfig).toEqual(initial.threadConfig);
  expect(restored.roles.every((role) => role.toolPolicy.approvalPolicy === "on-request")).toBe(true);
});

test("syncOrchestrationAgentsToCodexRoles appends V4A teaching to role developer instructions when enabled", async () => {
  const ecoDataDir = await makeTempEcoDataDir();
  const codexHomeDir = resolveCodexHomeDir(ecoDataDir);
  const orchestration = buildOrchestration();
  const result = await syncOrchestrationAgentsToCodexRoles({
    codexHomeDir,
    orchestration: {
      ...orchestration,
      mainAgent: { ...orchestration.mainAgent, v4aTeachingEnabled: true },
      agents: orchestration.agents.map((agent) =>
        agent.agentKey === "researcher" ? { ...agent, v4aTeachingEnabled: true } : agent,
      ),
    },
    templates: [researchTemplate, codingTemplate],
  });

  const exploreToml = await fs.readFile(path.join(result.agentsDir, "explore.toml"), "utf8");
  const researcherToml = await fs.readFile(path.join(result.agentsDir, "researcher.toml"), "utf8");
  const coderToml = await fs.readFile(path.join(result.agentsDir, "coder.toml"), "utf8");
  expect(researcherToml).toContain("Eco V4A teaching");
  expect(coderToml).not.toContain("Eco V4A teaching");
  expect(exploreToml).not.toContain("Eco V4A teaching");
});

test("syncOrchestrationAgentsToCodexRoles keeps bundles outside discovery and removes legacy Eco roles", async () => {
  const ecoDataDir = await makeTempEcoDataDir();
  const codexHomeDir = resolveCodexHomeDir(ecoDataDir);
  const legacyRolePath = path.join(codexHomeDir, "agents", "eco", "old-bundle", "coder.toml");
  await fs.mkdir(path.dirname(legacyRolePath), { recursive: true });
  await fs.writeFile(legacyRolePath, 'name = "coder"\n', "utf8");

  const result = await syncOrchestrationAgentsToCodexRoles({
    codexHomeDir,
    orchestration: buildOrchestration(),
    templates: [researchTemplate, codingTemplate],
  });

  expect(result.agentsDir.startsWith(path.join(codexHomeDir, "eco-agent-bundles"))).toBe(true);
  expect(result.agentsDir.startsWith(path.join(codexHomeDir, "agents"))).toBe(false);
  await expect(fs.stat(path.join(codexHomeDir, "agents", "eco"))).rejects.toThrow();
  expect(await fs.stat(path.join(result.agentsDir, "coder.toml"))).toBeTruthy();
});

test("syncOrchestrationAgentsToCodexRoles reads Explore from the editable roster", async () => {
  const ecoDataDir = await makeTempEcoDataDir();
  const orchestration = buildOrchestration();
  const result = await syncOrchestrationAgentsToCodexRoles({
    codexHomeDir: resolveCodexHomeDir(ecoDataDir),
    orchestration: {
      ...orchestration,
      agents: orchestration.agents.map((agent) =>
        agent.agentKey === "explore"
          ? { ...agent, modelRef: { providerId: "fast", modelId: "explore-roster" } }
          : agent,
      ),
    },
    templates: [researchTemplate, codingTemplate],
  });

  expect(result.roleIds).toEqual(["explore", "researcher", "coder"]);
  expect(result.roles[0]?.modelId).toBe("explore-roster");
});

test("multi-agent config keeps roles thread-scoped and heterogeneous models immutable", async () => {
  const ecoDataDir = await makeTempEcoDataDir();
  const codexHomeDir = resolveCodexHomeDir(ecoDataDir);
  const orchestration = buildOrchestration({
    agents: [
      exploreAgent({ providerId: "fast", modelId: "explore-fast" }),
      {
        ...firstOrchestrationAgent(),
        agentKey: "coder",
        templateId: codingTemplate.id,
        displayName: "Implementation Coder",
        modelRef: { providerId: "strong", modelId: "coder-strong", thinkingEffort: "high" },
        enabled: true,
      },
    ],
  });

  const roleSync = await syncOrchestrationAgentsToCodexRoles({
    codexHomeDir,
    orchestration,
    templates: [codingTemplate],
  });
  assertCodexRoleProvidersAvailable(roleSync.roles, [
    { id: "fast", name: "Fast", enabled: true },
    { id: "strong", name: "Strong", enabled: true },
  ]);

  const configSync = await syncCodexConfigFromEcoProviders({
    ecoDataDir,
    providers: [
      { id: "fast", name: "Fast", enabled: true },
      { id: "strong", name: "Strong", enabled: true },
    ],
    agentRoles: roleSync.agentRoles,
  });

  const configToml = await fs.readFile(configSync.configPath, "utf8");
  expect(configToml).not.toContain("multi_agent_v2");
  expect(configToml).toContain("multi_agent = true");
  expect(configToml).toContain("[features]");
  expect(configToml).toContain("[agents]");
  expect(configToml).toContain("max_threads = 16");
  expect(configToml).toContain("max_depth = 1");
  expect(roleSync.threadConfig.features).toMatchObject({
    multi_agent: true,
    hooks: true,
    multi_agent_v2: false,
  });
  expect(configToml).not.toContain("[agents.explore]");
  expect(configToml).not.toContain("[agents.coder]");
  expect(configToml).not.toContain("config_file");
  expect(configToml).toContain("[model_providers.eco_fast]");
  expect(configToml).toContain("[model_providers.eco_strong]");
  expect(roleSync.threadConfig.agents?.explore).toEqual({
    description: roleSync.roles.find((role) => role.roleId === "explore")?.description,
    config_file: roleSync.roles.find((role) => role.roleId === "explore")?.rolePath,
  });
  expect(roleSync.threadConfig.agents?.coder).toEqual({
    description: roleSync.roles.find((role) => role.roleId === "coder")?.description,
    config_file: roleSync.roles.find((role) => role.roleId === "coder")?.rolePath,
  });

  const exploreToml = await fs.readFile(path.join(roleSync.agentsDir, "explore.toml"), "utf8");
  const coderToml = await fs.readFile(path.join(roleSync.agentsDir, "coder.toml"), "utf8");
  expect(exploreToml).toContain('model = "eco_fast__explore-fast"');
  expect(exploreToml).toContain('model_provider = "eco_fast"');
  expect(coderToml).toContain('model = "eco_strong__coder-strong"');
  expect(coderToml).toContain('model_provider = "eco_strong"');
  expect(coderToml).toContain("[features]\nview_image = false");
});

test("official OpenAI subagents retain native image viewing beside custom provider roles", async () => {
  const ecoDataDir = await makeTempEcoDataDir();
  const result = await syncOrchestrationAgentsToCodexRoles({
    codexHomeDir: resolveCodexHomeDir(ecoDataDir),
    orchestration: buildOrchestration({
      agents: [exploreAgent({ providerId: "openai", modelId: "gpt-5" }), firstOrchestrationAgent()],
    }),
    templates: [researchTemplate],
  });

  const officialToml = await fs.readFile(path.join(result.agentsDir, "explore.toml"), "utf8");
  const customToml = await fs.readFile(path.join(result.agentsDir, "researcher.toml"), "utf8");
  expect(officialToml).toContain('model = "gpt-5"');
  // Pinned to Codex's built-in provider: config.toml carries a global
  // `model_provider = "eco_*"` default, so an omitted value would route the
  // official-subscription role through eco-gateway (which has no "openai" provider).
  expect(officialToml).toContain('model_provider = "openai"');
  expect(officialToml).not.toContain("eco_openai");
  expect(officialToml).toContain("[features]\nview_image = true");
  expect(customToml).toContain("[features]\nview_image = false");
  expect(result.roleThreadConfigs.explore?.features?.view_image).toBe(true);
  expect(result.roleThreadConfigs.researcher?.features?.view_image).toBe(false);
});

test("disabled model vision hides Codex native image tools for main and subagent roles", async () => {
  const config = { features: { multi_agent: true, hooks: true }, mcp_servers: {} };
  expect(withCodexNativeImageView(config, "openai", false).features?.view_image).toBe(false);
  const ecoDataDir = await makeTempEcoDataDir();
  const result = await syncOrchestrationAgentsToCodexRoles({
    codexHomeDir: resolveCodexHomeDir(ecoDataDir),
    orchestration: buildOrchestration({ agents: [exploreAgent({ providerId: "openai", modelId: "gpt-5" })] }),
    templates: [],
    resolveSupportsImageInput: () => false,
  });
  const roleToml = await fs.readFile(path.join(result.agentsDir, "explore.toml"), "utf8");
  expect(roleToml).toContain("[features]\nview_image = false");
  expect(result.roleThreadConfigs.explore?.features?.view_image).toBe(false);
});

test("role TOML carries an explicit apiCompat override in the V1 gateway alias", async () => {
  const ecoDataDir = await makeTempEcoDataDir();
  const codexHomeDir = resolveCodexHomeDir(ecoDataDir);
  const roleSync = await syncOrchestrationAgentsToCodexRoles({
    codexHomeDir,
    orchestration: buildOrchestration({
      agents: [
        exploreAgent({
          providerId: "mixed-wire",
          modelId: "chat/model.__v1",
          apiCompat: "openai_chat_completions",
        }),
      ],
    }),
    templates: [],
  });

  expect(roleSync.roles[0]?.apiCompat).toBe("openai_chat_completions");
  const exploreToml = await fs.readFile(path.join(roleSync.agentsDir, "explore.toml"), "utf8");
  expect(exploreToml).toContain(
    `model = "${buildCodexGatewayModelAlias("mixed-wire", "chat/model.__v1", "openai_chat_completions")}"`,
  );
});

test("thread remote compaction changes do not mutate other threads or MCP policy", () => {
  const config = { mcp_servers: { eco_mcp: { enabled: true } } };
  const remote = withCodexRemoteCompaction(config, "vendor", "v2");
  const local = withCodexRemoteCompaction(remote, "vendor", "unsupported");
  expect(remote.model_providers?.eco_vendor?.capabilities.remote_compaction).toBe("v2");
  expect(local.model_providers?.eco_vendor?.capabilities.remote_compaction).toBe("unsupported");
  expect(local.mcp_servers).toEqual(config.mcp_servers);
  expect(config).not.toHaveProperty("model_providers");
  expect(withCodexRemoteCompaction(config, "openai", "unsupported")).toEqual(config);
});

test("role sync rejects unknown apiCompat values", async () => {
  const ecoDataDir = await makeTempEcoDataDir();
  await expect(
    syncOrchestrationAgentsToCodexRoles({
      codexHomeDir: resolveCodexHomeDir(ecoDataDir),
      orchestration: buildOrchestration({
        agents: [
          exploreAgent({
            providerId: "main",
            modelId: "explore-model",
            apiCompat: "unknown-wire",
          }),
        ],
      }),
      templates: [],
    }),
  ).rejects.toThrow("unsupported modelRef.apiCompat 'unknown-wire'");
});

test("syncOrchestrationAgentsToCodexRoles keeps old bundles immutable when availability changes", async () => {
  const ecoDataDir = await makeTempEcoDataDir();
  const codexHomeDir = resolveCodexHomeDir(ecoDataDir);
  const coderAgent = buildOrchestration().agents.find((agent) => agent.agentKey === "coder");
  if (!coderAgent) {
    throw new Error("Expected coder fixture agent.");
  }
  const orchestration = buildOrchestration({
    agents: [exploreAgent(), coderAgent],
  });

  const initial = await syncOrchestrationAgentsToCodexRoles({
    codexHomeDir,
    orchestration,
    templates: [codingTemplate],
  });
  const initialCoderPath = initial.roles.find((role) => role.roleId === "coder")?.rolePath;
  expect(initialCoderPath).toBeTruthy();
  expect(await fs.stat(initialCoderPath!)).toBeTruthy();

  const exploreOnly = await syncOrchestrationAgentsToCodexRoles({
    codexHomeDir,
    orchestration,
    templates: [codingTemplate],
    subagentAvailability: { explore: true, coder: false },
  });

  expect(exploreOnly.roleIds).toEqual(["explore"]);
  expect(exploreOnly.agentsDir).not.toBe(initial.agentsDir);
  expect(await fs.stat(initialCoderPath!)).toBeTruthy();
});

test("role sync enables Multi-Agent v2 only for GPT-5.6 Terra or above", async () => {
  const ecoDataDir = await makeTempEcoDataDir();
  const base = buildOrchestration();
  const result = await syncOrchestrationAgentsToCodexRoles({
    codexHomeDir: resolveCodexHomeDir(ecoDataDir),
    orchestration: {
      ...base,
      mainAgent: {
        ...base.mainAgent,
        modelRef: { providerId: "main", modelId: "gpt-5.6-terra" },
      },
    },
    templates: [researchTemplate, codingTemplate],
  });

  expect(result.threadConfig.features).toMatchObject({
    multi_agent: true,
    hooks: true,
    multi_agent_v2: true,
  });
  expect(result.roleThreadConfigs.researcher?.features).toMatchObject({ multi_agent_v2: true });
});

test("role sync explicitly disables multi-agent features when no role is available", async () => {
  const ecoDataDir = await makeTempEcoDataDir();
  const result = await syncOrchestrationAgentsToCodexRoles({
    codexHomeDir: resolveCodexHomeDir(ecoDataDir),
    orchestration: buildOrchestration({ agents: [] }),
    templates: [],
    subagentAvailability: { explore: false },
  });

  expect(result.roleIds).toEqual([]);
  expect(result.threadConfig.features).toEqual({
    multi_agent: false,
    hooks: false,
    multi_agent_v2: false,
  });
  expect(result.threadConfig.agents).toBeUndefined();
});

test("assertCodexRoleProvidersAvailable fails when role provider is missing", async () => {
  const ecoDataDir = await makeTempEcoDataDir();
  const codexHomeDir = resolveCodexHomeDir(ecoDataDir);
  const roleSync = await syncOrchestrationAgentsToCodexRoles({
    codexHomeDir,
    orchestration: buildOrchestration({
      agents: [exploreAgent({ providerId: "missing-provider", modelId: "explore-model" })],
    }),
    templates: [],
  });

  expect(() =>
    assertCodexRoleProvidersAvailable(roleSync.roles, [{ id: "main", name: "Main", enabled: true }]),
  ).toThrow(/requires provider 'missing-provider'/);
});

test("syncOrchestrationAgentsToCodexRoles sanitizes unsafe keys without path traversal", async () => {
  const ecoDataDir = await makeTempEcoDataDir();
  const codexHomeDir = resolveCodexHomeDir(ecoDataDir);
  const agent = firstOrchestrationAgent();
  const orchestration = buildOrchestration({
    agents: [
      exploreAgent(),
      {
        ...agent,
        agentKey: "../Deep Research!",
      },
    ],
  });

  const result = await syncOrchestrationAgentsToCodexRoles({
    codexHomeDir,
    orchestration,
    templates: [researchTemplate],
  });

  expect(sanitizeCodexRoleId("../Deep Research!")).toBe("deep_research");
  expect(result.roleIds).toEqual(["explore", "deep_research"]);
  expect(result.roles.find((role) => role.roleId === "deep_research")?.rolePath).toBe(
    path.join(result.agentsDir, "deep_research.toml"),
  );
  await expect(fs.stat(path.join(codexHomeDir, "Deep Research!.toml"))).rejects.toThrow();
});

test("syncOrchestrationAgentsToCodexRoles rejects duplicate sanitized keys", async () => {
  const ecoDataDir = await makeTempEcoDataDir();
  const codexHomeDir = resolveCodexHomeDir(ecoDataDir);
  const agent = firstOrchestrationAgent();

  await expect(
    syncOrchestrationAgentsToCodexRoles({
      codexHomeDir,
      orchestration: buildOrchestration({
        agents: [
          { ...agent, agentKey: "a/b" },
          { ...agent, agentKey: "a_b" },
        ],
      }),
      templates: [researchTemplate],
    }),
  ).rejects.toThrow("Duplicate Codex role id");
});

test("syncOrchestrationAgentsToCodexRoles rejects case-only collisions and reserved Explore", async () => {
  const ecoDataDir = await makeTempEcoDataDir();
  const codexHomeDir = resolveCodexHomeDir(ecoDataDir);
  const agent = firstOrchestrationAgent();

  await expect(
    syncOrchestrationAgentsToCodexRoles({
      codexHomeDir,
      orchestration: buildOrchestration({
        agents: [
          { ...agent, agentKey: "Researcher" },
          { ...agent, agentKey: "researcher" },
        ],
      }),
      templates: [researchTemplate],
    }),
  ).rejects.toThrow("Duplicate Codex role id 'researcher'");

  await expect(
    syncOrchestrationAgentsToCodexRoles({
      codexHomeDir,
      orchestration: buildOrchestration({ agents: [{ ...agent, agentKey: "Explore" }] }),
      templates: [researchTemplate],
    }),
  ).rejects.toThrow("reserved Codex explore role id");
});

test("syncOrchestrationAgentsToCodexRoles redacts known secrets from roles and config declarations", async () => {
  const ecoDataDir = await makeTempEcoDataDir();
  const codexHomeDir = resolveCodexHomeDir(ecoDataDir);
  const secret = "sk-live-secret-value";
  const secretTemplate: EcoAgentTemplateConfig = {
    ...researchTemplate,
    prompt: `Use this role. Accidental secret: ${secret}`,
    description: `Research role ${secret}`,
  };

  const roleSync = await syncOrchestrationAgentsToCodexRoles({
    codexHomeDir,
    orchestration: buildOrchestration({ agents: [firstOrchestrationAgent()] }),
    templates: [secretTemplate],
    secretsToRedact: [secret],
  });
  await syncCodexConfigFromEcoProviders({
    ecoDataDir,
    providers: [{ id: "main", name: "Main", enabled: true }],
    agentRoles: roleSync.agentRoles,
  });

  const roleToml = await fs.readFile(path.join(roleSync.agentsDir, "researcher.toml"), "utf8");
  const configToml = await fs.readFile(path.join(codexHomeDir, "config.toml"), "utf8");
  const threadConfig = JSON.stringify(roleSync.threadConfig);
  expect(roleToml).not.toContain(secret);
  expect(configToml).not.toContain(secret);
  expect(threadConfig).not.toContain(secret);
  expect(roleToml).toContain("[redacted]");
  expect(threadConfig).toContain("[redacted]");
});

test("role MCP policy follows Composer thread selection for all actors", async () => {
  const ecoDataDir = await makeTempEcoDataDir();
  const orchestration = buildOrchestration({
    mainAgent: {
      ...buildOrchestration().mainAgent,
      tools: toolPolicy({
        allowSpawn: true,
        mcp: { allowedServers: ["github"], enabledTools: ["read", "missing"] },
      }),
    },
    agents: [
      {
        ...firstOrchestrationAgent(),
        tools: toolPolicy({
          sandboxMode: "read-only",
          mcp: { allowedServers: ["browser"], enabledTools: ["search", "missing"] },
        }),
      },
    ],
  });

  const result = await syncOrchestrationAgentsToCodexRoles({
    codexHomeDir: resolveCodexHomeDir(ecoDataDir),
    orchestration: orchestration,
    templates: [researchTemplate],
    mcpServers: [
      { name: "browser", transport: "stdio", command: "node", enabledTools: ["search", "open"] },
      { name: "github", transport: "stdio", command: "node", enabledTools: ["read", "write"] },
      { name: "sources", transport: "stdio", command: "node" },
    ],
    threadEnabledMcpServers: ["browser", "github"],
  });

  // Transport fields travel with the thread config; visibility still wins.
  expect(result.threadConfig.mcp_servers).toEqual({
    browser: { command: "node", enabled: true, enabled_tools: ["open", "search"] },
    github: { command: "node", enabled: true, enabled_tools: ["read", "write"] },
    sources: { command: "node", enabled: false },
  });
  const researcherConfig = result.roleThreadConfigs.researcher;
  expect(researcherConfig?.mcp_servers).toEqual({
    browser: { command: "node", enabled: true, enabled_tools: ["open", "search"] },
    github: { command: "node", enabled: true, enabled_tools: ["read", "write"] },
    sources: { command: "node", enabled: false },
  });

  const researcherToml = await fs.readFile(
    result.roles.find((role) => role.roleId === "researcher")!.rolePath,
    "utf8",
  );
  expect(researcherToml).toContain("[mcp_servers.browser]");
  expect(researcherToml).toContain("[mcp_servers.github]");
  expect(researcherToml).toMatch(/\[mcp_servers\.sources\][\s\S]*?enabled = false/);
  expect(researcherToml).not.toContain("Eco MCP allowlist");
});

test("main actor inherits Composer-selected MCP regardless of orchestration MCP policy", async () => {
  const ecoDataDir = await makeTempEcoDataDir();
  const orchestration = buildOrchestration({ agents: [] });

  const result = await syncOrchestrationAgentsToCodexRoles({
    codexHomeDir: resolveCodexHomeDir(ecoDataDir),
    orchestration,
    templates: [],
    mcpServers: [
      { name: "mongo", transport: "stdio", command: "node" },
      { name: "browser", transport: "stdio", command: "node" },
    ],
    threadEnabledMcpServers: ["mongo"],
  });

  expect(result.threadConfig.mcp_servers).toEqual({
    browser: { command: "node", enabled: false },
    mongo: { command: "node", enabled: true },
  });
});

test("legacy empty orchestration MCP policy no longer denies Composer-selected MCP", async () => {
  const ecoDataDir = await makeTempEcoDataDir();
  const base = buildOrchestration();
  const orchestration = buildOrchestration({
    mainAgent: {
      ...base.mainAgent,
      tools: toolPolicy({ mcp: { allowedServers: [] } }),
    },
    agents: [],
  });

  const result = await syncOrchestrationAgentsToCodexRoles({
    codexHomeDir: resolveCodexHomeDir(ecoDataDir),
    orchestration,
    templates: [],
    mcpServers: [{ name: "mongo", transport: "stdio", command: "node" }],
    threadEnabledMcpServers: ["mongo"],
  });

  expect(result.threadConfig.mcp_servers).toEqual({
    mongo: { command: "node", enabled: true },
  });
});

test("content-addressed role bundles survive a concurrent Orchestration preparation", async () => {
  const ecoDataDir = await makeTempEcoDataDir();
  const codexHomeDir = resolveCodexHomeDir(ecoDataDir);
  const first = await syncOrchestrationAgentsToCodexRoles({
    codexHomeDir,
    orchestration: buildOrchestration({ agents: [firstOrchestrationAgent()] }),
    templates: [researchTemplate],
    mcpServers: [
      { name: "browser", transport: "stdio", command: "node" },
      { name: "sources", transport: "stdio", command: "node" },
    ],
    threadEnabledMcpServers: ["browser"],
  });
  const firstRole = first.roles.find((role) => role.roleId === "researcher");
  if (!firstRole) {
    throw new Error("Expected researcher role.");
  }
  const before = await fs.readFile(firstRole.rolePath, "utf8");

  const second = await syncOrchestrationAgentsToCodexRoles({
    codexHomeDir,
    orchestration: buildOrchestration({
      agents: [
        {
          ...firstOrchestrationAgent(),
          modelRef: { providerId: "main", modelId: "research-model-v2" },
        },
      ],
    }),
    templates: [researchTemplate],
    mcpServers: [
      { name: "browser", transport: "stdio", command: "node" },
      { name: "sources", transport: "stdio", command: "node" },
    ],
    threadEnabledMcpServers: ["sources"],
  });

  expect(second.agentsDir).not.toBe(first.agentsDir);
  expect(await fs.readFile(firstRole.rolePath, "utf8")).toBe(before);
  expect(first.threadConfig.agents?.researcher).toMatchObject({ config_file: firstRole.rolePath });
});

test("role sync shares Composer MCP scope between main and subagents", async () => {
  const ecoDataDir = await makeTempEcoDataDir();
  const base = buildOrchestration();
  const result = await syncOrchestrationAgentsToCodexRoles({
    codexHomeDir: resolveCodexHomeDir(ecoDataDir),
    orchestration: buildOrchestration({
      mainAgent: {
        ...base.mainAgent,
        tools: toolPolicy({
          allowSpawn: true,
          mcp: { allowedServers: ["browser"], enabledTools: ["search"] },
        }),
      },
      agents: [firstOrchestrationAgent()],
    }),
    templates: [researchTemplate],
    mcpServers: [{ name: "browser", transport: "stdio", command: "node" }],
    threadEnabledMcpServers: ["browser"],
  });
  expect(result.threadConfig.mcp_servers).toEqual({
    browser: { command: "node", enabled: true },
  });
  expect(result.roleThreadConfigs.researcher?.mcp_servers).toEqual({
    browser: { command: "node", enabled: true },
  });
});

test("concurrent threads keep independent thread MCP definitions", async () => {
  const ecoDataDir = await makeTempEcoDataDir();
  const codexHomeDir = resolveCodexHomeDir(ecoDataDir);
  const orchestration = buildOrchestration({ agents: [] });
  const [first, second] = await Promise.all(
    ["a", "b"].map((suffix) =>
      syncOrchestrationAgentsToCodexRoles({
        codexHomeDir,
        orchestration,
        templates: [],
        mcpServers: [
          {
            name: `eco_mcp_${suffix}`,
            transport: "http" as const,
            url: `http://127.0.0.1:19${suffix === "a" ? 1 : 2}/mcp`,
            httpHeaders: { Authorization: `Bearer ${suffix}` },
          },
        ],
      }),
    ),
  );

  // Each thread carries only its own Hub descriptor, so one thread's cache
  // refresh can never redirect another thread's MCP calls.
  expect(first.threadConfig.mcp_servers).toEqual({
    eco_mcp_a: {
      url: "http://127.0.0.1:191/mcp",
      http_headers: { Authorization: "Bearer a" },
      enabled: true,
    },
  });
  expect(second.threadConfig.mcp_servers).toEqual({
    eco_mcp_b: {
      url: "http://127.0.0.1:192/mcp",
      http_headers: { Authorization: "Bearer b" },
      enabled: true,
    },
  });
});

function toolPolicy(overrides: Partial<EcoToolPolicy> = {}): EcoToolPolicy {
  return {
    sandboxMode: "workspace-write",
    approvalPolicy: "on-request",
    networkAccess: false,
    webSearch: "disabled",
    allowSpawn: false,
    ...overrides,
  };
}

const updatedAt = "2026-07-04T00:00:00.000Z";

const researchTemplate: EcoAgentTemplateConfig = {
  id: "template.research",
  name: "Researcher",
  description: "Finds evidence.",
  prompt: "Research carefully and cite sources.",
  whenToUse: "Need external context.",
  outputContract: "Return bullets with sources.",
  defaultTools: toolPolicy({
    sandboxMode: "read-only",
    webSearch: "live",
  }),
  mcpServers: ["sources"],
  skills: [],
  allowDelegation: false,
  builtIn: false,
  source: "user",
  version: 1,
  updatedAt,
};

const codingTemplate: EcoAgentTemplateConfig = {
  ...researchTemplate,
  id: "template.coder",
  name: "Coder",
  description: "Implements code changes.",
  prompt: "Implement scoped code changes.",
  whenToUse: "Need implementation.",
  outputContract: "Return changed files and tests.",
  defaultTools: toolPolicy({ sandboxMode: "workspace-write" }),
};

function buildOrchestration(overrides: Partial<EcoOrchestrationConfig> = {}): EcoOrchestrationConfig {
  const orchestration: EcoOrchestrationConfig = {
    mainAgent: {
      agentKey: "main",
      name: "Main",
      systemPromptPreset: "custom_append",
      prompt: "Coordinate work.",
      modelRef: { providerId: "main", modelId: "main-model" },
      tools: toolPolicy({ sandboxMode: "workspace-write", allowSpawn: true }),
      skills: [],
    },
    agents: [
      exploreAgent(),
      {
        agentKey: "researcher",
        templateId: researchTemplate.id,
        displayName: "Evidence Researcher",
        modelRef: { providerId: "main", modelId: "research-model", thinkingEffort: "off" },
        tools: toolPolicy({ sandboxMode: "read-only", webSearch: "live" }),
        mcpServers: ["browser"],
        skills: ["citation"],
        enabled: true,
      },
      {
        agentKey: "coder",
        templateId: codingTemplate.id,
        displayName: "Implementation Coder",
        modelRef: { providerId: "main", modelId: "coder-model", thinkingEffort: "high" },
        tools: toolPolicy({ sandboxMode: "workspace-write" }),
        mcpServers: [],
        skills: [],
        enabled: true,
      },
      {
        agentKey: "architect",
        templateId: codingTemplate.id,
        displayName: "Disabled Architect",
        modelRef: { providerId: "main", modelId: "architect-model" },
        tools: toolPolicy({ sandboxMode: "read-only" }),
        mcpServers: [],
        skills: [],
        enabled: false,
      },
    ],
    strategy: { kind: "autonomous", guidancePrompt: "Delegate when it helps." },
  };
  return { ...orchestration, ...overrides };
}

function exploreAgent(
  modelRef: EcoOrchestrationConfig["agents"][number]["modelRef"] = {
    providerId: "main",
    modelId: "explore-model",
  },
): EcoOrchestrationConfig["agents"][number] {
  return {
    agentKey: "explore",
    templateId: "builtin.coding.explore",
    displayName: "Explore",
    modelRef,
    tools: toolPolicy({ sandboxMode: "read-only" }),
    mcpServers: [],
    skills: [],
    enabled: true,
  };
}

function firstOrchestrationAgent(): EcoOrchestrationConfig["agents"][number] {
  const agent = buildOrchestration().agents.find((candidate) => candidate.agentKey === "researcher");
  if (!agent) {
    throw new Error("Expected orchestration fixture to include an agent.");
  }
  return agent;
}
