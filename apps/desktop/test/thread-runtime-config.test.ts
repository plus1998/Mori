import { expect, test } from "bun:test";
import {
  buildResourcesFromRouteProfile,
  resolveOrchestrationSnapshot,
} from "../src/shared/agent-orchestration";
import type { ModelSettingsSnapshot, SubagentEnabledSettings } from "../src/shared/ipc";
import {
  buildAcpThreadRuntimeConfig,
  buildThreadRuntimeConfigFromDefaults,
  deriveSubagentEnabledFromSnapshot,
  hasCompleteOrchestrationSelection,
  isAutonomousThreadRuntime,
  isBashReviewModeOnlyRuntimeConfigUpdate,
  isBusyMutableOnlyRuntimeConfigUpdate,
  isThreadRuntimeConfig,
  lockThreadRuntimeConfigSnapshotOnContinue,
  materializeThreadOrchestrationSnapshot,
  normalizeThreadRuntimeConfig,
  parseThreadRuntimeConfigJson,
  resolveAcpCursorModelIdForSend,
  resolveBusyThreadRuntimeConfigUpdate,
  resolveMainAgentSystemPromptPreset,
  resolveThreadOrchestrationSnapshot,
  resolveThreadRuntimeMcpServerKeys,
  resolveThreadRuntimeConfigUpdate,
  runtimeRoleRoutesFromOrchestrationSnapshot,
  serializeThreadRuntimeConfig,
  shouldRematerializeThreadRuntimeConfigOnContinue,
  threadRuntimeConfigsEquivalent,
  withAgentSessionMode,
} from "../src/shared/thread-runtime-config";

const presetBundle = buildResourcesFromRouteProfile(
  {
    id: "coding-default",
    name: "Default coding",
    routes: [
      { role: "main", providerId: "p1", modelId: "m1" },
      { role: "explore", providerId: "p1", modelId: "m1" },
      { role: "architect", providerId: "p1", modelId: "m1" },
      { role: "coder", providerId: "p1", modelId: "m1" },
      { role: "reviewer", providerId: "p1", modelId: "m1" },
      { role: "tester", providerId: "p1", modelId: "m1" },
    ],
    createdAt: "2026-07-27T00:00:00.000Z",
    updatedAt: "2026-07-27T00:00:00.000Z",
  },
  {
    mainAgentConfigId: "user.coding.main",
    subagentOrchestrationId: "user.coding.subagents",
  },
);

const settings: ModelSettingsSnapshot = {
  providers: [],
  routeProfiles: [],
  agentTemplates: [],
  mainAgentConfigs: [presetBundle.mainAgentConfig],
  mainAgentPrompts: presetBundle.mainAgentPrompt ? [presetBundle.mainAgentPrompt] : [],
  subagentOrchestrations: [presetBundle.subagentOrchestration],
};

const threadSubagentEnabled: SubagentEnabledSettings = {
  explore: true,
  architect: true,
  coder: true,
  reviewer: true,
  tester: true,
};

test("hasCompleteOrchestrationSelection accepts builtin prompt and orchestration subagents", () => {
  expect(hasCompleteOrchestrationSelection(presetBundle.selection)).toBe(true);
});

test("hasCompleteOrchestrationSelection accepts none subagents", () => {
  expect(
    hasCompleteOrchestrationSelection({
      mainAgentConfigId: "user.coding.main",
      mainPrompt: { mode: "builtin" },
      subagents: { mode: "none" },
    }),
  ).toBe(true);
});

test("resolveOrchestrationSnapshot returns empty agents for none subagents", () => {
  const snapshot = resolveOrchestrationSnapshot(
    {
      mainAgentConfigId: presetBundle.mainAgentConfig.id,
      mainPrompt: { mode: "builtin" },
      subagents: { mode: "none" },
    },
    {
      mainAgentConfigs: settings.mainAgentConfigs,
      mainAgentPrompts: settings.mainAgentPrompts,
      subagentOrchestrations: settings.subagentOrchestrations,
    },
  );
  expect(snapshot.agents).toEqual([]);
});

test("buildThreadRuntimeConfigFromDefaults inherits defaultBashReviewMode", () => {
  const config = buildThreadRuntimeConfigFromDefaults({
    settings,
    workflowDefaults: {
      sessionMode: "agent",
      defaultBashReviewMode: "auto",
      defaultOrchestrationSelection: presetBundle.selection,
      defaultAuxiliaryModel: {
        providerId: "p1",
        modelId: "m1",
        candidateModelId: "candidate-1",
      },
    },
  });
  expect(config.bashReviewMode).toBe("auto");
});

test("buildThreadRuntimeConfigFromDefaults materializes orchestration snapshot", () => {
  const config = buildThreadRuntimeConfigFromDefaults({
    settings,
    workflowDefaults: {
      sessionMode: "agent",
      defaultOrchestrationSelection: presetBundle.selection,
      defaultAuxiliaryModel: {
        providerId: "p1",
        modelId: "m1",
        candidateModelId: "candidate-1",
      },
      defaultVisionModel: {
        providerId: "p1",
        modelId: "vision-1",
        candidateModelId: "candidate-vision-1",
      },
    },
  });
  expect(config.orchestrationSelection).toEqual(presetBundle.selection);
  expect(config.resolvedOrchestrationSnapshot?.mainAgent.modelRef.modelId).toBe("m1");
  expect(config.auxiliaryModel?.candidateModelId).toBe("candidate-1");
  expect(config.visionModel?.candidateModelId).toBe("candidate-vision-1");
  expect(isAutonomousThreadRuntime(config)).toBe(true);
  expect(config.bashReviewMode).toBe("always");
});

test("buildThreadRuntimeConfigFromDefaults ignores main agent tools.confirmation", () => {
  const settingsWithConfirmation: ModelSettingsSnapshot = {
    ...settings,
    mainAgentConfigs: [
      {
        ...presetBundle.mainAgentConfig,
        tools: {
          ...presetBundle.mainAgentConfig.tools,
          confirmation: "never",
        },
      },
    ],
  };
  const config = buildThreadRuntimeConfigFromDefaults({
    settings: settingsWithConfirmation,
    workflowDefaults: {
      sessionMode: "agent",
      defaultOrchestrationSelection: presetBundle.selection,
    },
  });
  expect(config.bashReviewMode).toBe("always");
  expect(config.resolvedOrchestrationSnapshot?.mainAgent.tools.confirmation).toBe("never");
});

test("threadRuntimeConfigsEquivalent ignores resolvedAt churn", () => {
  const config = buildThreadRuntimeConfigFromDefaults({
    settings,
    workflowDefaults: {
      sessionMode: "agent",
      defaultOrchestrationSelection: presetBundle.selection,
    },
  });
  const refreshed = materializeThreadOrchestrationSnapshot(settings, presetBundle.selection);
  const other = {
    ...config,
    ...refreshed,
  };
  expect(threadRuntimeConfigsEquivalent(config, other)).toBe(true);
});

test("buildThreadRuntimeConfigFromDefaults throws without main agent configs", () => {
  expect(() =>
    buildThreadRuntimeConfigFromDefaults({
      settings: { ...settings, mainAgentConfigs: [] },
      workflowDefaults: { sessionMode: "agent" },
    }),
  ).toThrow(/主代理.*提示词.*子代理编排|main agent.*prompt.*subagent orchestration/i);
});

test("buildThreadRuntimeConfigFromDefaults rejects a missing selection", () => {
  expect(() =>
    buildThreadRuntimeConfigFromDefaults({
      settings,
      workflowDefaults: { sessionMode: "agent" },
    }),
  ).toThrow(/主代理.*提示词.*子代理编排|main agent.*prompt.*subagent orchestration/i);
});

test("parseThreadRuntimeConfigJson rejects legacy profile fields", () => {
  const legacy = {
    routeProfileId: "old-profile",
    agentProfileId: "old-profile",
    mainAgentConfigId: presetBundle.mainAgentConfig.id,
    subagentOrchestrationId: presetBundle.subagentOrchestration.id,
    mainPrompt: { mode: "builtin" },
    subagentEnabled: threadSubagentEnabled,
    sessionMode: "agent",
    bashReviewMode: "auto",
  };
  expect(parseThreadRuntimeConfigJson(JSON.stringify(legacy))).toBeUndefined();
});

test("materializeThreadOrchestrationSnapshot persists selection and snapshot", () => {
  const materialized = materializeThreadOrchestrationSnapshot(settings, presetBundle.selection);
  expect(materialized.orchestrationSelection).toEqual(presetBundle.selection);
  expect(materialized.resolvedOrchestrationSnapshot?.agents.length).toBeGreaterThan(0);
});

test("runtimeRoleRoutesFromOrchestrationSnapshot includes planner and enabled agents", () => {
  const snapshot = resolveOrchestrationSnapshot(presetBundle.selection, {
    mainAgentConfigs: settings.mainAgentConfigs,
    mainAgentPrompts: settings.mainAgentPrompts,
    subagentOrchestrations: settings.subagentOrchestrations,
  });
  const routes = runtimeRoleRoutesFromOrchestrationSnapshot(snapshot);
  expect(routes.some((route) => route.role === "main")).toBe(true);
  expect(routes.some((route) => route.role === "coder")).toBe(true);
});

test("deriveSubagentEnabledFromSnapshot intersects with roster", () => {
  const snapshot = resolveOrchestrationSnapshot(
    {
      mainAgentConfigId: presetBundle.mainAgentConfig.id,
      mainPrompt: { mode: "builtin" },
      subagents: { mode: "none" },
    },
    {
      mainAgentConfigs: settings.mainAgentConfigs,
      mainAgentPrompts: settings.mainAgentPrompts,
      subagentOrchestrations: settings.subagentOrchestrations,
    },
  );
  const enabled = deriveSubagentEnabledFromSnapshot(snapshot);
  expect(enabled.coder).toBe(false);
});

test("serialize and parse round-trip new runtime config", () => {
  const config = buildThreadRuntimeConfigFromDefaults({
    settings,
    workflowDefaults: {
      sessionMode: "agent",
      defaultOrchestrationSelection: presetBundle.selection,
    },
  });
  const parsed = parseThreadRuntimeConfigJson(serializeThreadRuntimeConfig(config));
  expect(parsed?.orchestrationSelection).toEqual(presetBundle.selection);
  expect(parsed?.resolvedOrchestrationSnapshot?.mainAgentConfigName).toBe("Default coding Main Config");
});

test("runtime integrations round-trip and legacy browser MCP migrates", () => {
  const config = buildThreadRuntimeConfigFromDefaults({
    settings,
    workflowDefaults: {
      sessionMode: "agent",
      defaultOrchestrationSelection: presetBundle.selection,
      integrationsEnabled: { browser: true, imageGeneration: false },
    },
  });
  expect(parseThreadRuntimeConfigJson(serializeThreadRuntimeConfig(config))?.integrationsEnabled).toEqual({
    browser: true,
    imageGeneration: false,
  });

  const legacy = {
    ...config,
    integrationsEnabled: undefined,
    mcpServersEnabled: { eco_agent_browser: true, docs: false },
  };
  const migrated = parseThreadRuntimeConfigJson(JSON.stringify(legacy));
  expect(migrated?.integrationsEnabled).toEqual({ browser: true });
  expect(migrated?.mcpServersEnabled).toEqual({ docs: false });
});

test("isBashReviewModeOnlyRuntimeConfigUpdate ignores bashReviewMode-only changes", () => {
  const base = buildThreadRuntimeConfigFromDefaults({
    settings,
    workflowDefaults: {
      sessionMode: "agent",
      defaultOrchestrationSelection: presetBundle.selection,
    },
  });
  const next = JSON.parse(JSON.stringify({ ...base, bashReviewMode: "auto" })) as typeof base;
  expect(isBashReviewModeOnlyRuntimeConfigUpdate(base, next)).toBe(true);
  expect(base.bashReviewMode).toBe("always");
});

test("bashReviewMode-only update tolerates mobile snapshot round-trip drift", () => {
  const base = buildThreadRuntimeConfigFromDefaults({
    settings,
    workflowDefaults: {
      sessionMode: "agent",
      defaultOrchestrationSelection: presetBundle.selection,
    },
  });
  const withPreset = normalizeThreadRuntimeConfig({
    ...base,
    mainAgentSystemPromptPresetOverride: "custom_append",
  });
  const snapshot = withPreset.resolvedOrchestrationSnapshot!;
  // Mobile OrchestrationModelRef / ToolPolicyMcp omit host-only fields and rewrite mcp.allowedTools.
  const lossyMobileIncoming = normalizeThreadRuntimeConfig({
    ...withPreset,
    bashReviewMode: "allow_all",
    mainAgentSystemPromptPresetOverride: undefined,
    resolvedOrchestrationSnapshot: {
      ...snapshot,
      mainAgent: {
        ...snapshot.mainAgent,
        modelRef: {
          providerId: snapshot.mainAgent.modelRef.providerId,
          modelId: snapshot.mainAgent.modelRef.modelId,
          ...(snapshot.mainAgent.modelRef.thinkingEffort
            ? { thinkingEffort: snapshot.mainAgent.modelRef.thinkingEffort }
            : {}),
          ...(snapshot.mainAgent.modelRef.candidateModelId
            ? { candidateModelId: snapshot.mainAgent.modelRef.candidateModelId }
            : {}),
        },
        tools: {
          ...snapshot.mainAgent.tools,
          ...(snapshot.mainAgent.tools.mcp
            ? {
                mcp: {
                  allowedServers: snapshot.mainAgent.tools.mcp.allowedServers,
                  allowedTools: [],
                },
              }
            : {}),
        },
      },
    },
  });
  expect(isBashReviewModeOnlyRuntimeConfigUpdate(withPreset, lossyMobileIncoming)).toBe(true);
  expect(
    resolveBusyThreadRuntimeConfigUpdate({
      existing: withPreset,
      incoming: lossyMobileIncoming,
    }),
  ).toEqual({
    kind: "apply",
    runtimeConfig: { ...withPreset, bashReviewMode: "allow_all" },
  });
});

test("busy runtime-config updates allow bashReviewMode and stateless role models, including ACP", () => {
  const base = buildAcpThreadRuntimeConfig({
    cursorModelId: "default[]",
  });
  expect(
    resolveBusyThreadRuntimeConfigUpdate({
      existing: base,
      incoming: { ...base, bashReviewMode: "auto" },
    }),
  ).toEqual({
    kind: "apply",
    runtimeConfig: { ...base, bashReviewMode: "auto" },
  });
  expect(
    resolveBusyThreadRuntimeConfigUpdate({
      existing: base,
      incoming: { ...base, cursorModelId: "other[]" },
    }),
  ).toEqual({ kind: "blocked" });
});

test("busy runtime-config updates allow auxiliary / approval / vision switches", () => {
  const base = buildThreadRuntimeConfigFromDefaults({
    settings,
    workflowDefaults: {
      sessionMode: "agent",
      defaultOrchestrationSelection: presetBundle.selection,
    },
  });
  const auxiliaryModel = { providerId: "p1", modelId: "m1", candidateModelId: "cand-aux" };
  const approvalModel = { providerId: "p1", modelId: "m2", candidateModelId: "cand-appr" };
  const visionModel = { providerId: "p1", modelId: "m3", candidateModelId: "cand-vis" };
  const incoming = { ...base, auxiliaryModel, approvalModel, visionModel };
  expect(isBusyMutableOnlyRuntimeConfigUpdate(base, incoming)).toBe(true);
  expect(
    resolveBusyThreadRuntimeConfigUpdate({
      existing: base,
      incoming,
    }),
  ).toEqual({
    kind: "apply",
    runtimeConfig: { ...base, auxiliaryModel, approvalModel, visionModel },
  });
});

test("busy runtime-config updates can clear a stateless role selection", () => {
  const base = buildThreadRuntimeConfigFromDefaults({
    settings,
    workflowDefaults: {
      sessionMode: "agent",
      defaultOrchestrationSelection: presetBundle.selection,
      defaultAuxiliaryModel: { providerId: "p1", modelId: "m1", candidateModelId: "cand-aux" },
      defaultVisionModel: { providerId: "p1", modelId: "m3", candidateModelId: "cand-vis" },
    },
  });
  expect(base.auxiliaryModel).toBeDefined();
  const result = resolveBusyThreadRuntimeConfigUpdate({
    existing: base,
    incoming: { ...base, auxiliaryModel: undefined, visionModel: undefined },
  });
  expect(result.kind).toBe("apply");
  if (result.kind !== "apply") {
    return;
  }
  expect(result.runtimeConfig.auxiliaryModel).toBeUndefined();
  expect(result.runtimeConfig.visionModel).toBeUndefined();
});

test("busy runtime-config updates reject session-bound fields even next to a role switch", () => {
  const base = buildThreadRuntimeConfigFromDefaults({
    settings,
    workflowDefaults: {
      sessionMode: "agent",
      defaultOrchestrationSelection: presetBundle.selection,
    },
  });
  const visionModel = { providerId: "p1", modelId: "m3", candidateModelId: "cand-vis" };
  const blocked: Array<{ label: string; incoming: typeof base }> = [
    { label: "sessionMode", incoming: { ...base, sessionMode: "plan" } },
    { label: "bashReviewMode+vision+sessionMode", incoming: { ...base, visionModel, sessionMode: "plan" } },
    {
      label: "mainAgentModelOverride",
      incoming: { ...base, visionModel, mainAgentModelOverride: { providerId: "p1", modelId: "m9" } },
    },
    {
      label: "mcpServersEnabled",
      incoming: { ...base, visionModel, mcpServersEnabled: { eco_browser: true } },
    },
    { label: "skillsEnabled", incoming: { ...base, visionModel, skillsEnabled: { "a/SKILL.md": true } } },
    {
      label: "orchestrationSelection",
      incoming: {
        ...base,
        visionModel,
        orchestrationSelection: {
          ...presetBundle.selection,
          mainAgentConfigId: "user.other.main",
        },
      },
    },
  ];
  for (const { label, incoming } of blocked) {
    expect(resolveBusyThreadRuntimeConfigUpdate({ existing: base, incoming }), label).toEqual({
      kind: "blocked",
    });
  }
});

test("busy vision switch tolerates mobile snapshot round-trip drift", () => {
  const base = buildThreadRuntimeConfigFromDefaults({
    settings,
    workflowDefaults: {
      sessionMode: "agent",
      defaultOrchestrationSelection: presetBundle.selection,
    },
  });
  const withPreset = normalizeThreadRuntimeConfig({
    ...base,
    mainAgentSystemPromptPresetOverride: "custom_append",
  });
  const visionModel = { providerId: "p1", modelId: "m3", candidateModelId: "cand-vis" };
  // Mobile drops host-only snapshot / preset fields when it round-trips the config.
  const lossyMobileIncoming = normalizeThreadRuntimeConfig({
    ...withPreset,
    mainAgentSystemPromptPresetOverride: undefined,
    resolvedOrchestrationSnapshot: undefined,
    visionModel,
  });
  const result = resolveBusyThreadRuntimeConfigUpdate({
    existing: withPreset,
    incoming: lossyMobileIncoming,
  });
  expect(result.kind).toBe("apply");
  if (result.kind !== "apply") {
    return;
  }
  expect(result.runtimeConfig.visionModel).toEqual(visionModel);
  expect(result.runtimeConfig.resolvedOrchestrationSnapshot).toEqual(
    withPreset.resolvedOrchestrationSnapshot,
  );
  expect(result.runtimeConfig.mainAgentSystemPromptPresetOverride).toBe("custom_append");
});

test("withAgentSessionMode updates session mode", () => {
  const config = normalizeThreadRuntimeConfig({
    orchestrationSelection: presetBundle.selection,
    subagentEnabled: threadSubagentEnabled,
    sessionMode: "plan",
    bashReviewMode: "auto",
  });
  expect(withAgentSessionMode(config).sessionMode).toBe("agent");
});

test("resolveThreadOrchestrationSnapshot prefers stored snapshot", () => {
  const config = buildThreadRuntimeConfigFromDefaults({
    settings,
    workflowDefaults: {
      sessionMode: "agent",
      defaultOrchestrationSelection: presetBundle.selection,
    },
  });
  expect(resolveThreadOrchestrationSnapshot(settings, config)?.mainAgentConfigName).toBe(
    "Default coding Main Config",
  );
});

test("continue keeps locked snapshot when global model rematerializes", () => {
  const existing = buildThreadRuntimeConfigFromDefaults({
    settings,
    workflowDefaults: {
      sessionMode: "agent",
      defaultOrchestrationSelection: presetBundle.selection,
    },
  });
  const rematerializedSnapshot = {
    ...existing.resolvedOrchestrationSnapshot!,
    mainAgent: {
      ...existing.resolvedOrchestrationSnapshot!.mainAgent,
      modelRef: {
        ...existing.resolvedOrchestrationSnapshot!.mainAgent.modelRef,
        modelId: "global-default-model",
      },
    },
  };
  const incoming = {
    ...existing,
    resolvedOrchestrationSnapshot: rematerializedSnapshot,
    mainAgentModelOverride: { providerId: "p1", modelId: "session-override" },
  };
  expect(shouldRematerializeThreadRuntimeConfigOnContinue(existing, incoming)).toBe(false);
  const locked = lockThreadRuntimeConfigSnapshotOnContinue(existing, incoming);
  expect(locked.resolvedOrchestrationSnapshot?.mainAgent.modelRef.modelId).toBe("m1");
  expect(locked.mainAgentModelOverride?.modelId).toBe("session-override");
});

test("continue rematerializes after an explicit orchestration switch", () => {
  const existing = buildThreadRuntimeConfigFromDefaults({
    settings,
    workflowDefaults: {
      sessionMode: "agent",
      defaultOrchestrationSelection: presetBundle.selection,
    },
  });
  const incoming = {
    ...existing,
    orchestrationSelection: {
      ...presetBundle.selection,
      mainAgentConfigId: "other-main",
    },
  };
  expect(shouldRematerializeThreadRuntimeConfigOnContinue(existing, incoming)).toBe(true);
  const locked = lockThreadRuntimeConfigSnapshotOnContinue(existing, incoming);
  expect(locked.resolvedOrchestrationSnapshot).toBe(incoming.resolvedOrchestrationSnapshot);
});

test("new chat defaults cannot replace an existing model during mode, skills or MCP saves", () => {
  const old = buildThreadRuntimeConfigFromDefaults({
    settings,
    workflowDefaults: { sessionMode: "plan", defaultOrchestrationSelection: presetBundle.selection },
  });
  const changedSettings = structuredClone(settings);
  changedSettings.mainAgentConfigs[0]!.modelRef.modelId = "new-chat-model";
  const fresh = buildThreadRuntimeConfigFromDefaults({
    settings: changedSettings,
    workflowDefaults: { sessionMode: "agent", defaultOrchestrationSelection: presetBundle.selection },
  });
  expect(fresh.resolvedOrchestrationSnapshot?.mainAgent.modelRef.modelId).toBe("new-chat-model");
  const saved = resolveThreadRuntimeConfigUpdate(changedSettings, old, {
    ...old,
    sessionMode: "agent",
    skillsEnabled: { "project:skill": true },
    mcpServersEnabled: { mongo: true },
  });
  expect(saved.resolvedOrchestrationSnapshot?.mainAgent.modelRef.modelId).toBe("m1");
  expect(saved.sessionMode).toBe("agent");
  expect(saved.skillsEnabled).toEqual({ "project:skill": true });
  expect(saved.mcpServersEnabled).toEqual({ mongo: true });
  expect(old.resolvedOrchestrationSnapshot?.mainAgent.modelRef.modelId).toBe("m1");
});

test("an explicit per-session model and effort switch keeps the pinned template", () => {
  const old = buildThreadRuntimeConfigFromDefaults({
    settings,
    workflowDefaults: { sessionMode: "agent", defaultOrchestrationSelection: presetBundle.selection },
  });
  const saved = resolveThreadRuntimeConfigUpdate(settings, old, {
    ...old,
    mainAgentModelOverride: { providerId: "p1", modelId: "manual-model", thinkingEffort: "max" },
  });
  expect(saved.resolvedOrchestrationSnapshot).toEqual(old.resolvedOrchestrationSnapshot);
  expect(
    runtimeRoleRoutesFromOrchestrationSnapshot(
      saved.resolvedOrchestrationSnapshot!,
      saved.mainAgentModelOverride,
    )[0],
  ).toMatchObject({ modelId: "manual-model", thinkingEffort: "max" });
});

test("a subagent selection does not import a new global main model", () => {
  const old = buildThreadRuntimeConfigFromDefaults({
    settings,
    workflowDefaults: {
      sessionMode: "agent",
      defaultOrchestrationSelection: { ...presetBundle.selection, subagents: { mode: "none" } },
    },
  });
  const changedSettings = structuredClone(settings);
  changedSettings.mainAgentConfigs[0]!.modelRef.modelId = "new-chat-model";
  const saved = resolveThreadRuntimeConfigUpdate(changedSettings, old, {
    ...old,
    orchestrationSelection: presetBundle.selection,
  });
  expect(saved.resolvedOrchestrationSnapshot?.mainAgent.modelRef.modelId).toBe("m1");
  expect(saved.resolvedOrchestrationSnapshot?.agents.length).toBeGreaterThan(0);
});

test("an explicit main configuration switch or global reset can adopt another model", () => {
  const old = buildThreadRuntimeConfigFromDefaults({
    settings,
    workflowDefaults: { sessionMode: "agent", defaultOrchestrationSelection: presetBundle.selection },
  });
  const changedSettings = structuredClone(settings);
  changedSettings.mainAgentConfigs[0]!.modelRef.modelId = "new-chat-model";
  const reset = resolveThreadRuntimeConfigUpdate(changedSettings, old, old, { refreshSnapshot: true });
  expect(reset.resolvedOrchestrationSnapshot?.mainAgent.modelRef.modelId).toBe("new-chat-model");
  changedSettings.mainAgentConfigs.push({
    ...changedSettings.mainAgentConfigs[0]!,
    id: "another-config",
    modelRef: { providerId: "p1", modelId: "another-model" },
  });
  const switched = resolveThreadRuntimeConfigUpdate(changedSettings, old, {
    ...old,
    orchestrationSelection: { ...presetBundle.selection, mainAgentConfigId: "another-config" },
  });
  expect(switched.resolvedOrchestrationSnapshot?.mainAgent.modelRef.modelId).toBe("another-model");
});

test("existing snapshots survive a deleted global template; a new selection still reports the gap", () => {
  const old = buildThreadRuntimeConfigFromDefaults({
    settings,
    workflowDefaults: { sessionMode: "plan", defaultOrchestrationSelection: presetBundle.selection },
  });
  const missing = { ...settings, mainAgentConfigs: [] };
  expect(
    resolveThreadRuntimeConfigUpdate(missing, old, { ...old, sessionMode: "agent" })
      .resolvedOrchestrationSnapshot,
  ).toEqual(old.resolvedOrchestrationSnapshot);
  expect(() => resolveThreadRuntimeConfigUpdate(missing, undefined, old)).toThrow("找不到主 Agent 配置");
});

test("resolveMainAgentSystemPromptPreset honors override", () => {
  const snapshot = resolveOrchestrationSnapshot(presetBundle.selection, {
    mainAgentConfigs: settings.mainAgentConfigs,
    mainAgentPrompts: settings.mainAgentPrompts,
    subagentOrchestrations: settings.subagentOrchestrations,
  });
  const config = normalizeThreadRuntimeConfig({
    orchestrationSelection: presetBundle.selection,
    resolvedOrchestrationSnapshot: snapshot,
    mainAgentSystemPromptPresetOverride: "custom_append",
    subagentEnabled: threadSubagentEnabled,
    sessionMode: "agent",
    bashReviewMode: "auto",
  });
  expect(resolveMainAgentSystemPromptPreset(snapshot, config)).toBe("custom_append");
});

test("isThreadRuntimeConfig validates orchestration selection", () => {
  expect(
    isThreadRuntimeConfig({
      orchestrationSelection: presetBundle.selection,
      subagentEnabled: threadSubagentEnabled,
      sessionMode: "agent",
      bashReviewMode: "auto",
    }),
  ).toBe(true);
});

test("isThreadRuntimeConfig accepts a Cursor-only config without Eco orchestration", () => {
  expect(
    isThreadRuntimeConfig({
      cursorModelId: "gpt-5.3-codex",
      subagentEnabled: threadSubagentEnabled,
      sessionMode: "agent",
      bashReviewMode: "always",
    }),
  ).toBe(true);
  expect(
    normalizeThreadRuntimeConfig({
      cursorModelId: "  gpt-5.3-codex  ",
      subagentEnabled: threadSubagentEnabled,
      sessionMode: "agent",
      bashReviewMode: "always",
    }).cursorModelId,
  ).toBe("gpt-5.3-codex");
});

test("buildAcpThreadRuntimeConfig does not require Eco orchestration", () => {
  expect(buildAcpThreadRuntimeConfig({ cursorModelId: "gpt-5.3-codex" })).toEqual({
    cursorModelId: "gpt-5.3-codex",
    subagentEnabled: threadSubagentEnabled,
    sessionMode: "agent",
    bashReviewMode: "always",
  });
  expect(hasCompleteOrchestrationSelection(buildAcpThreadRuntimeConfig({}).orchestrationSelection)).toBe(
    false,
  );
});

test("buildAcpThreadRuntimeConfig keeps auxiliary and vision models", () => {
  expect(
    buildAcpThreadRuntimeConfig({
      cursorModelId: "gpt-5.3-codex",
      auxiliaryModel: {
        providerId: "p1",
        modelId: "aux",
        candidateModelId: "cand-aux",
      },
      visionModel: {
        providerId: "p1",
        modelId: "vision",
        candidateModelId: "cand-vision",
      },
    }),
  ).toEqual({
    cursorModelId: "gpt-5.3-codex",
    subagentEnabled: threadSubagentEnabled,
    sessionMode: "agent",
    bashReviewMode: "always",
    auxiliaryModel: {
      providerId: "p1",
      modelId: "aux",
      candidateModelId: "cand-aux",
    },
    visionModel: {
      providerId: "p1",
      modelId: "vision",
      candidateModelId: "cand-vision",
    },
  });
});

test("ACP send uses thread model when a runtime config exists, otherwise the workflow default", () => {
  expect(
    resolveAcpCursorModelIdForSend({
      runtimeConfig: { cursorModelId: "claude-4-sonnet" },
      workflowDefault: "gpt-5.3-codex",
    }),
  ).toBe("claude-4-sonnet");
  expect(
    resolveAcpCursorModelIdForSend({
      runtimeConfig: {},
      workflowDefault: "gpt-5.3-codex",
    }),
  ).toBeUndefined();
  expect(
    resolveAcpCursorModelIdForSend({
      runtimeConfig: null,
      workflowDefault: "gpt-5.3-codex",
    }),
  ).toBe("gpt-5.3-codex");
});

test("resolveThreadRuntimeMcpServerKeys returns empty without snapshot", () => {
  expect(
    resolveThreadRuntimeMcpServerKeys({
      settings,
      availableMcpServerKeys: ["browser"],
      runtimeConfig: {
        subagentEnabled: threadSubagentEnabled,
        sessionMode: "agent",
        bashReviewMode: "auto",
      },
    }),
  ).toEqual([]);
});
