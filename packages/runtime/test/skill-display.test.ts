import { expect, test } from "bun:test";
import { formatSkillActivityLabel, isSkillActivityLabel, resolveSkillDisplayName, skillNameFromPath } from "@eco/runtime";
import { formatAgentEventDisplay } from "@eco/runtime/sdk";

test("skillNameFromPath reads parent directory of SKILL.md", () => {
  expect(skillNameFromPath("/Users/me/.claude/skills/pdf/SKILL.md")).toBe("pdf");
  expect(skillNameFromPath("C:\\skills\\docx\\SKILL.md")).toBe("docx");
  expect(skillNameFromPath("/tmp/readme.md")).toBeNull();
});

test("resolveSkillDisplayName handles Skill tool input", () => {
  expect(resolveSkillDisplayName("Skill", { skill: "pdf" })).toBe("pdf");
  expect(resolveSkillDisplayName("Skill", { name: "docx" })).toBe("docx");
  expect(resolveSkillDisplayName("Skill", { skillName: "frontend-design" })).toBe("frontend-design");
  expect(resolveSkillDisplayName("Skill", { skill_path: "/home/.claude/skills/browser/SKILL.md" })).toBe(
    "browser",
  );
  expect(resolveSkillDisplayName("Read", { file_path: "/home/.claude/skills/lint/SKILL.md" })).toBe("lint");
});

test("formatSkillActivityLabel uses 读取 <name> 技能", () => {
  expect(formatSkillActivityLabel("pdf")).toBe("读取 pdf 技能");
  expect(isSkillActivityLabel("读取 pdf 技能")).toBe(true);
  expect(isSkillActivityLabel("Tool: Read · pdf")).toBe(false);
});

test("formatAgentEventDisplay shows skill read label", () => {
  const display = formatAgentEventDisplay({
    type: "tool.started",
    role: "main",
    payload: {
      type: "tool_use",
      tool_name: "Skill",
      input: { skill: "pdf" },
    },
  });
  expect(display?.message).toBe("读取 pdf 技能");
});

test("formatAgentEventDisplay shows Read SKILL.md as skill", () => {
  const display = formatAgentEventDisplay({
    type: "tool.started",
    role: "main",
    payload: {
      type: "tool_use",
      tool_name: "Read",
      input: { file_path: "/Users/me/.claude/skills/vue-best-practices/SKILL.md" },
    },
  });
  expect(display?.message).toBe("读取 vue-best-practices 技能");
});

test("formatAgentEventDisplay shows pi read path to SKILL.md as skill", () => {
  const display = formatAgentEventDisplay({
    type: "tool.started",
    role: "main",
    payload: {
      type: "tool_use",
      tool_name: "Read",
      input: { path: "/tmp/eco/skills/apple-design/SKILL.md" },
    },
  });
  expect(display?.message).toBe("读取 apple-design 技能");
});

test("formatAgentEventDisplay shows skill label on tool completion", () => {
  const display = formatAgentEventDisplay({
    type: "tool.completed",
    role: "main",
    payload: {
      type: "tool_result",
      tool_name: "Read",
      input: { path: "/tmp/eco/skills/apple-design/SKILL.md" },
      content: "# Apple Design\n...",
    },
  });
  expect(display?.message).toBe("读取 apple-design 技能");
});
