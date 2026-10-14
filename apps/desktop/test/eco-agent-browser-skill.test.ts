import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ensureClaudeUserEcoAgentBrowserSkill,
  isEcoManagedClaudeSkillDir,
  removeClaudeUserEcoAgentBrowserSkill,
  resolveBundledEcoAgentBrowserSkillDir,
  resolveEcoAgentBrowserSkillFileForCodex,
} from "../src/main/eco-agent-browser-skill";
import { ECO_AGENT_BROWSER_PROMPT_APPEND, ECO_AGENT_BROWSER_SKILL_NAME } from "../src/shared/browser";

test("bundled eco-agent-browser skill resolves in monorepo / desktop cwd", () => {
  const dir = resolveBundledEcoAgentBrowserSkillDir({
    cwd: path.join(import.meta.dir, ".."),
  });
  expect(dir).toBeTruthy();
  expect(dir!.endsWith(path.join("packaging", "skills", ECO_AGENT_BROWSER_SKILL_NAME))).toBe(true);
});

test("Codex skill file points at package SKILL.md", () => {
  const skillFile = resolveEcoAgentBrowserSkillFileForCodex();
  expect(skillFile).toBeTruthy();
  expect(skillFile!.endsWith(`${path.sep}SKILL.md`)).toBe(true);
});

test("Claude ensure installs managed skill and remove only cleans Eco install", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "eco-browser-skill-"));
  try {
    const ensured = await ensureClaudeUserEcoAgentBrowserSkill({ homedir: tmp });
    expect(ensured.ok).toBe(true);
    if (!ensured.ok) return;
    expect(ensured.skillFilePath).toContain(path.join(".claude", "skills", ECO_AGENT_BROWSER_SKILL_NAME));
    const body = await fs.readFile(ensured.skillFilePath, "utf8");
    expect(body).toContain("name: eco-agent-browser");
    expect(body).toContain("mcp__eco_agent_browser__");
    expect(isEcoManagedClaudeSkillDir(path.dirname(ensured.skillFilePath))).toBe(true);

    await removeClaudeUserEcoAgentBrowserSkill({ homedir: tmp });
    await expect(fs.access(ensured.skillFilePath)).rejects.toBeDefined();
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("remove does not delete non-managed same-name skill", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "eco-browser-skill-user-"));
  try {
    const dir = path.join(tmp, ".claude", "skills", ECO_AGENT_BROWSER_SKILL_NAME);
    await fs.mkdir(dir, { recursive: true });
    const skillPath = path.join(dir, "SKILL.md");
    await fs.writeFile(skillPath, "---\nname: eco-agent-browser\n---\nuser skill\n", "utf8");
    await removeClaudeUserEcoAgentBrowserSkill({ homedir: tmp });
    const stillThere = await fs.readFile(skillPath, "utf8");
    expect(stillThere).toContain("user skill");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("prompt append forbids inventing session names", () => {
  expect(ECO_AGENT_BROWSER_PROMPT_APPEND).toContain("do not pass a custom `session`");
  expect(ECO_AGENT_BROWSER_PROMPT_APPEND).toContain("binds the browser session automatically");
  expect(ECO_AGENT_BROWSER_PROMPT_APPEND).toContain("eco_agent_browser");
});

test("prompt append describes thread-scoped multi-browser Agent access", () => {
  expect(ECO_AGENT_BROWSER_PROMPT_APPEND).toContain(ECO_AGENT_BROWSER_SKILL_NAME);
  expect(ECO_AGENT_BROWSER_PROMPT_APPEND).toContain("thread");
  expect(ECO_AGENT_BROWSER_PROMPT_APPEND).toContain("eco_agent_browser");
  expect(ECO_AGENT_BROWSER_PROMPT_APPEND.length).toBeLessThan(1600);
});
