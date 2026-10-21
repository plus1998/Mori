import { expect, test } from "bun:test";
import {
  buildResourcesFromRouteProfile,
  CODING_AGENT_TEMPLATE_IDS,
  createBuiltInAgentTemplates,
  orchestrationConfigFromSnapshot,
  resolveOrchestrationSnapshot,
} from "../src/shared/agent-orchestration";
import type { RouteProfileView } from "../src/shared/ipc";

function codingRouteProfile(): RouteProfileView {
  return {
    id: "coding-default",
    name: "默认编程",
    routes: [
      { role: "main", providerId: "p1", modelId: "planner-model", thinkingEffort: "high" },
      { role: "explore", providerId: "p1", modelId: "explore-model" },
      { role: "architect", providerId: "p1", modelId: "architect-model" },
      { role: "coder", providerId: "p1", modelId: "coder-model" },
      { role: "reviewer", providerId: "p1", modelId: "reviewer-model" },
      { role: "tester", providerId: "p1", modelId: "tester-model" },
    ],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
  };
}

test("built-in agent templates define the default coding library", () => {
  const templates = createBuiltInAgentTemplates();
  expect(templates.map((template) => template.id)).toEqual([
    CODING_AGENT_TEMPLATE_IDS.explore,
    CODING_AGENT_TEMPLATE_IDS.architect,
    CODING_AGENT_TEMPLATE_IDS.coder,
    CODING_AGENT_TEMPLATE_IDS.reviewer,
    CODING_AGENT_TEMPLATE_IDS.tester,
  ]);
  expect(templates.every((template) => template.source === "built_in")).toBe(true);
  expect(
    templates.find((template) => template.id === CODING_AGENT_TEMPLATE_IDS.coder)?.defaultTools.filesystem
      ?.write,
  ).toBe("workspace");
  expect(
    templates.find((template) => template.id === CODING_AGENT_TEMPLATE_IDS.architect)?.defaultTools.filesystem
      ?.write,
  ).toBe("none");
});

test("route profile conversion creates resources without retaining route profile identity", () => {
  const bundle = buildResourcesFromRouteProfile(codingRouteProfile(), {
    mainAgentConfigId: "user.route.main",
    subagentOrchestrationId: "user.route.subagents",
  });
  expect(bundle.mainAgentConfig).toMatchObject({
    id: "user.route.main",
    modelRef: { providerId: "p1", modelId: "planner-model", thinkingEffort: "high" },
  });
  expect(bundle.subagentOrchestration.id).toBe("user.route.subagents");
  expect(
    bundle.subagentOrchestration.agents.find((agent) => agent.agentKey === "coder")?.modelRef.modelId,
  ).toBe("coder-model");
  expect(bundle).not.toHaveProperty("id");
  expect(bundle).not.toHaveProperty("sourceRouteProfileId");
});

test("route profile conversion honors subagent availability", () => {
  const bundle = buildResourcesFromRouteProfile(codingRouteProfile(), {
    mainAgentConfigId: "user.route.main",
    subagentOrchestrationId: "user.route.subagents",
    subagentEnabled: {
      explore: true,
      architect: false,
      coder: true,
      reviewer: false,
      tester: true,
    },
  });
  expect(bundle.subagentOrchestration.strategy.kind).toBe("autonomous");
  expect(bundle.subagentOrchestration.agents.find((agent) => agent.agentKey === "architect")?.enabled).toBe(
    false,
  );
  expect(bundle.subagentOrchestration.agents.find((agent) => agent.agentKey === "reviewer")?.enabled).toBe(
    false,
  );
});

test("strict snapshot resolution rejects missing resource references", () => {
  const bundle = buildResourcesFromRouteProfile(codingRouteProfile(), {
    mainAgentConfigId: "user.coding.main",
    subagentOrchestrationId: "user.coding.subagents",
  });
  expect(() =>
    resolveOrchestrationSnapshot(bundle.selection, {
      mainAgentConfigs: [],
      mainAgentPrompts: [],
      subagentOrchestrations: [bundle.subagentOrchestration],
    }),
  ).toThrow(/找不到主 Agent 配置|main agent config .*not found/i);
});

test("resolved snapshots are isolated from selections, resources, and runtime materialization", () => {
  const bundle = buildResourcesFromRouteProfile(codingRouteProfile(), {
    mainAgentConfigId: " user.route.main ",
    subagentOrchestrationId: " user.route.subagents ",
  });
  const selection = structuredClone(bundle.selection);
  selection.mainAgentConfigId = ` ${selection.mainAgentConfigId} `;
  if (selection.subagents.mode === "orchestration") {
    selection.subagents.orchestrationId = ` ${selection.subagents.orchestrationId} `;
  }
  const snapshot = resolveOrchestrationSnapshot(selection, {
    mainAgentConfigs: [bundle.mainAgentConfig],
    mainAgentPrompts: [],
    subagentOrchestrations: [bundle.subagentOrchestration],
  });

  selection.mainAgentConfigId = "changed";
  bundle.mainAgentConfig.modelRef.modelId = "changed-main";
  bundle.subagentOrchestration.agents[0]!.modelRef.modelId = "changed-explore";

  expect(snapshot.selection.mainAgentConfigId).toBe("user.route.main");
  expect(snapshot.mainAgent.modelRef.modelId).toBe("planner-model");
  expect(snapshot.agents[0]?.modelRef.modelId).toBe("explore-model");

  const runtimeConfig = orchestrationConfigFromSnapshot(snapshot);
  runtimeConfig.mainAgent.modelRef.modelId = "runtime-main";
  runtimeConfig.agents[0]!.modelRef.modelId = "runtime-explore";
  runtimeConfig.strategy.guidancePrompt = "runtime guidance";

  expect(snapshot.mainAgent.modelRef.modelId).toBe("planner-model");
  expect(snapshot.agents[0]?.modelRef.modelId).toBe("explore-model");
  expect(snapshot.strategy.guidancePrompt).not.toBe("runtime guidance");
});
