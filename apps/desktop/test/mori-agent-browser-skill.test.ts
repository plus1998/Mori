import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildMoriAgentBrowserCodexSkillInfo,
  buildMoriAgentBrowserSkillInfo,
  ensureClaudeUserMoriAgentBrowserSkill,
  isMoriManagedClaudeSkillDir,
  removeClaudeUserMoriAgentBrowserSkill,
  resolveBundledMoriAgentBrowserSkillDir,
  resolveMoriAgentBrowserSkillFileForCodex,
} from "../src/main/mori-agent-browser-skill";
import {
  ECO_AGENT_BROWSER_PROMPT_APPEND,
  LEGACY_ECO_AGENT_BROWSER_SKILL_NAME,
  MORI_AGENT_BROWSER_SKILL_NAME,
} from "../src/shared/browser";

async function writeSkill(home: string, name: string, managed = false): Promise<string> {
  const directory = path.join(home, ".claude", "skills", name);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, "SKILL.md"), `---\nname: ${name}\n---\nuser skill\n`);
  if (managed) await fs.writeFile(path.join(directory, ".eco-managed"), "legacy managed install\n");
  return directory;
}

test("bundled mori-agent-browser skill resolves in monorepo / desktop cwd", () => {
  const dir = resolveBundledMoriAgentBrowserSkillDir({
    cwd: path.join(import.meta.dir, ".."),
  });
  expect(dir).toBeTruthy();
  expect(dir?.endsWith(path.join("packaging", "skills", MORI_AGENT_BROWSER_SKILL_NAME))).toBe(true);
});

test("Codex skill file points at package SKILL.md", () => {
  const skillFile = resolveMoriAgentBrowserSkillFileForCodex();
  expect(skillFile).toBeTruthy();
  if (!skillFile) throw new Error("Bundled skill file is missing");
  expect(skillFile.endsWith(`${path.sep}SKILL.md`)).toBe(true);
  const codexSkill = buildMoriAgentBrowserCodexSkillInfo(skillFile);
  expect(codexSkill.name).toBe("mori-agent-browser");
  expect(codexSkill.settingsKey).toBe(`builtin:mori-agent-browser:${skillFile}`);
  expect(buildMoriAgentBrowserSkillInfo(skillFile).name).toBe("mori-agent-browser");
});

test("bundled skill resolves from the packaged resources layout", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mori-browser-resources-"));
  try {
    const directory = path.join(tmp, "skills", "mori-agent-browser");
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, "SKILL.md"), "---\nname: mori-agent-browser\n---\n");
    expect(resolveBundledMoriAgentBrowserSkillDir({ resourcesPath: tmp })).toBe(directory);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("Claude installs the renamed skill, migrates the managed legacy install and supports refresh", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mori-browser-skill-"));
  try {
    const legacyDirectory = await writeSkill(tmp, LEGACY_ECO_AGENT_BROWSER_SKILL_NAME, true);
    const ensured = await ensureClaudeUserMoriAgentBrowserSkill({ homedir: tmp });
    expect(ensured.ok).toBe(true);
    if (!ensured.ok) throw new Error(ensured.reason);
    expect(ensured.skillFilePath).toContain(path.join(".claude", "skills", MORI_AGENT_BROWSER_SKILL_NAME));
    const body = await fs.readFile(ensured.skillFilePath, "utf8");
    expect(body).toContain("name: mori-agent-browser");
    expect(body).toContain("mcp__eco_agent_browser__");
    expect(isMoriManagedClaudeSkillDir(path.dirname(ensured.skillFilePath))).toBe(true);
    await expect(fs.access(legacyDirectory)).rejects.toBeDefined();

    await fs.writeFile(ensured.skillFilePath, "outdated managed content");
    expect(await ensureClaudeUserMoriAgentBrowserSkill({ homedir: tmp })).toEqual(ensured);
    expect(await fs.readFile(ensured.skillFilePath, "utf8")).toBe(body);

    await removeClaudeUserMoriAgentBrowserSkill({ homedir: tmp });
    await expect(fs.access(ensured.skillFilePath)).rejects.toBeDefined();
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("installation preserves a user-created legacy skill", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mori-browser-skill-user-"));
  try {
    const dir = await writeSkill(tmp, LEGACY_ECO_AGENT_BROWSER_SKILL_NAME);
    const result = await ensureClaudeUserMoriAgentBrowserSkill({ homedir: tmp });
    expect(result.ok).toBe(true);
    await removeClaudeUserMoriAgentBrowserSkill({ homedir: tmp });
    expect(await fs.readFile(path.join(dir, "SKILL.md"), "utf8")).toContain("user skill");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("a user-created new-name skill blocks installation without deleting the old managed install", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mori-browser-skill-collision-"));
  try {
    const legacy = await writeSkill(tmp, LEGACY_ECO_AGENT_BROWSER_SKILL_NAME, true);
    const directory = await writeSkill(tmp, MORI_AGENT_BROWSER_SKILL_NAME);
    const result = await ensureClaudeUserMoriAgentBrowserSkill({ homedir: tmp });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected a user skill collision");
    expect(result.reason).toContain("未覆盖");
    expect(await fs.readFile(path.join(legacy, "SKILL.md"), "utf8")).toContain("user skill");
    await removeClaudeUserMoriAgentBrowserSkill({ homedir: tmp });
    expect(await fs.readFile(path.join(directory, "SKILL.md"), "utf8")).toContain("user skill");
    await expect(fs.access(legacy)).rejects.toBeDefined();
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("installation and removal preserve user symlinks even when their targets contain a managed marker", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mori-browser-skill-symlink-"));
  try {
    const target = await writeSkill(tmp, "external-skill", true);
    const link = path.join(tmp, ".claude", "skills", MORI_AGENT_BROWSER_SKILL_NAME);
    await fs.symlink(target, link, "dir");
    expect((await ensureClaudeUserMoriAgentBrowserSkill({ homedir: tmp })).ok).toBe(false);
    await removeClaudeUserMoriAgentBrowserSkill({ homedir: tmp });
    expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(path.join(target, "SKILL.md"), "utf8")).toContain("user skill");
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
  expect(ECO_AGENT_BROWSER_PROMPT_APPEND).toContain(MORI_AGENT_BROWSER_SKILL_NAME);
  expect(ECO_AGENT_BROWSER_PROMPT_APPEND).not.toContain(LEGACY_ECO_AGENT_BROWSER_SKILL_NAME);
  expect(ECO_AGENT_BROWSER_PROMPT_APPEND).toContain("thread");
  expect(ECO_AGENT_BROWSER_PROMPT_APPEND).toContain("eco_agent_browser");
  expect(ECO_AGENT_BROWSER_PROMPT_APPEND.length).toBeLessThan(1600);
});
