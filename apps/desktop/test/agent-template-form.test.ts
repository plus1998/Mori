import { expect, test } from "bun:test";
import {
  buildAgentTemplateCapabilityOptions,
  buildAgentTemplateFromForm,
  buildAgentTemplatePermissionChips,
  createBlankAgentTemplateForm,
  createCopiedAgentTemplateForm,
  createUniqueTemplateId,
  normalizeDisallowedTools,
  toggleAgentTemplateAdvancedDisallowedTool,
  toggleAgentTemplateListValue,
} from "../src/renderer/agent-template-form";
import { createDefaultToolCapabilityFields } from "../src/renderer/tool-capability-groups";
import type { AgentTemplate } from "../src/shared/ipc";

const builtInTemplate: AgentTemplate = {
  id: "builtin.research.researcher",
  name: "Researcher",
  description: "Research agent",
  prompt: "Research.",
  whenToUse: "Use for research.",
  defaultTools: { allowed: ["Read", "WebSearch"], disallowed: ["Bash"] },
  mcpServers: [],
  skills: [],
  allowDelegation: false,
  builtIn: true,
  source: "built_in",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function templateForm(overrides: Partial<ReturnType<typeof createBlankAgentTemplateForm>> = {}) {
  return {
    id: "user.research.custom",
    name: "Custom Research",
    description: "Custom research agent",
    prompt: "Research deeply.",
    whenToUse: "Use for research.",
    outputContract: "Return sources.",
    ...createDefaultToolCapabilityFields({
      writeCodebase: false,
      bash: true,
      network: false,
      allowDelegation: true,
    }),
    ...overrides,
  };
}

test("copied built-in template becomes a user template form with unique id", () => {
  const form = createCopiedAgentTemplateForm(builtInTemplate, [
    builtInTemplate,
    {
      ...builtInTemplate,
      id: "user.custom.researcher",
      builtIn: false,
      source: "user",
    },
  ]);

  expect(form.id).toBe("user.custom.researcher_2");
  expect(form.name).toBe("Researcher Copy");
});

test("blank template form avoids existing default ids", () => {
  const form = createBlankAgentTemplateForm([
    {
      ...builtInTemplate,
      id: "user.custom.agent",
      builtIn: false,
      source: "user",
    },
  ]);

  expect(form.id).toBe("user.custom.agent_2");
});

test("buildAgentTemplateFromForm validates and derives tool policy", () => {
  const template = buildAgentTemplateFromForm(templateForm(), {
    nowIso: "2026-06-07T00:00:00.000Z",
  });

  expect(template).toMatchObject({
    id: "user.research.custom",
    builtIn: false,
    source: "user",
    mcpServers: [],
    skills: [],
    allowDelegation: true,
  });
  expect(template.defaultTools.allowed).toEqual([]);
  expect(template.defaultTools.bash).toEqual({ enabled: true });
  expect(template.defaultTools).not.toHaveProperty("mcp");
  expect(template.defaultTools.filesystem).toEqual({ read: "workspace", write: "none" });
  expect(template.defaultTools.network).toEqual({ webSearch: false, webFetch: false });
});

test("buildAgentTemplateFromForm syncs delegation tools with allowDelegation", () => {
  const blocked = buildAgentTemplateFromForm(
    templateForm({
      allowDelegation: false,
      writeCodebase: true,
      taskProgress: true,
      advancedDisallowedTools: "",
    }),
  );
  expect(blocked.defaultTools.disallowed).toEqual(expect.arrayContaining(["Agent", "Task"]));
  expect(blocked.defaultTools.disallowed).not.toContain("TaskList");
  expect(blocked.defaultTools.disallowed).not.toContain("TaskGet");
  expect(blocked.defaultTools.disallowed).not.toContain("TaskOutput");

  const allowed = buildAgentTemplateFromForm(
    templateForm({
      allowDelegation: true,
      writeCodebase: true,
      network: true,
      askUser: true,
      taskProgress: true,
      advancedDisallowedTools: "CustomOnly",
    }),
  );
  expect(allowed.defaultTools.disallowed).toEqual([]);
  expect(allowed.defaultTools.coreOverrides?.claude?.disallowedTools).toEqual(["CustomOnly"]);
});

test("normalizeDisallowedTools merges legacy bash and network flags into disallowed list", () => {
  expect(
    normalizeDisallowedTools({
      allowed: [],
      disallowed: ["Write"],
      bash: { enabled: false },
      network: { webSearch: false, webFetch: true },
    }),
  ).toEqual(["Write", "Bash", "WebSearch"]);
});

test("buildAgentTemplateCapabilityOptions only exposes advanced tools", () => {
  const options = buildAgentTemplateCapabilityOptions({
    templates: [builtInTemplate],
    form: {
      advancedDisallowedTools: "UnknownTool",
    },
  });

  expect(options.tools.map((option) => option.value)).toEqual(["UnknownTool"]);
  expect(options.tools.map((option) => option.value)).not.toContain("Agent");
  expect(options.tools.map((option) => option.value)).not.toContain("Read");
});

test("template list toggles preserve unknown values and advanced toggles update list", () => {
  expect(toggleAgentTemplateListValue("docs, missing", "docs", false)).toBe("missing");
  expect(toggleAgentTemplateListValue("docs", "mcp__docs__*", true)).toBe("docs, mcp__docs__*");

  expect(toggleAgentTemplateAdvancedDisallowedTool("Bash, Write", "Read", true)).toBe("");
  expect(toggleAgentTemplateAdvancedDisallowedTool("Bash, Custom", "Bash", false)).toBe("Custom");
  expect(toggleAgentTemplateAdvancedDisallowedTool("Agent, Custom", "Agent", true)).toBe("Custom");
});

test("buildAgentTemplatePermissionChips summarizes capability policy", () => {
  const chips = buildAgentTemplatePermissionChips({
    ...builtInTemplate,
    defaultTools: {
      allowed: [],
      disallowed: ["Write", "Edit", "WebSearch"],
      bash: { enabled: true },
      filesystem: { read: "workspace", write: "none" },
      network: { webSearch: false, webFetch: true },
      mcp: { allowedServers: ["docs"], allowedTools: ["mcp__docs__search"] },
    },
    mcpServers: ["docs"],
  });

  expect(chips).toEqual([
    { label: "读 工作区", tone: "allow" },
    { label: "写 禁用", tone: "deny" },
    { label: "Bash", tone: "allow" },
    { label: "联网", tone: "allow" },
    { label: "可更新进度", tone: "allow" },
    { label: "委派关闭", tone: "deny" },
    { label: "Skill", tone: "allow" },
    { label: "询问用户", tone: "allow" },
  ]);
});

test("template form rejects protected and malformed ids", () => {
  const baseForm = templateForm({ id: "builtin.custom.agent" });

  expect(() => buildAgentTemplateFromForm(baseForm)).toThrow("内置子 Agent 模板 id 不可用于用户配置");
  expect(() => buildAgentTemplateFromForm({ ...baseForm, id: "bad id" })).toThrow("子 Agent 模板 id 只能包含");
});

test("createUniqueTemplateId increments suffixes", () => {
  expect(createUniqueTemplateId("user.custom.agent", ["user.custom.agent", "user.custom.agent_2"])).toBe(
    "user.custom.agent_3",
  );
});
