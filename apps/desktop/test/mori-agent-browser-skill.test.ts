import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildMoriAgentBrowserCodexSkillInfo,
  cleanupLegacyClaudeBrowserSkills,
  resolveBundledMoriAgentBrowserSkillDir,
  resolveBundledMoriBrowserPluginDir,
  resolveClaudeBrowserPlugin,
  resolveMoriAgentBrowserSkillFile,
} from "../src/main/mori-agent-browser-skill";
import {
  buildEcoAgentBrowserPromptAppend,
  ECO_AGENT_BROWSER_PROMPT_APPEND,
  LEGACY_ECO_AGENT_BROWSER_SKILL_NAME,
  MORI_AGENT_BROWSER_SKILL_NAME,
  MORI_CLAUDE_BROWSER_SKILL_NAME,
} from "../src/shared/browser";
import { buildRuntimeAgentSkillAssignments, resolveSdkSessionSkillConfig } from "../src/shared/skills";

async function writeSkill(home: string, name: string, marker?: string): Promise<string> {
  const directory = path.join(home, ".claude", "skills", name);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, "SKILL.md"), `---\nname: ${name}\n---\nuser skill\n`);
  if (marker) await fs.writeFile(path.join(directory, marker), "managed install\n");
  return directory;
}

test("Claude plugin, Codex and PI resolve the same packaged skill in development", async () => {
  const plugin = resolveClaudeBrowserPlugin(true);
  if (!plugin) throw new Error("Browser plugin is missing");
  expect(plugin.plugins[0]?.type).toBe("local");
  const root = plugin.plugins[0]?.path;
  expect(root).toBe(resolveBundledMoriBrowserPluginDir({ cwd: path.join(import.meta.dir, "..") }));
  expect(plugin.skillName).toBe("mori:mori-agent-browser");
  expect(plugin.skillDirectory).toBe(resolveBundledMoriAgentBrowserSkillDir());
  const skillFile = resolveMoriAgentBrowserSkillFile();
  expect(skillFile).toBe(path.join(plugin.skillDirectory, "SKILL.md"));
  if (!skillFile || !root) throw new Error("Packaged skill file is missing");
  const manifest = JSON.parse(await fs.readFile(path.join(root, ".claude-plugin", "plugin.json"), "utf8"));
  expect(`${manifest.name}:${MORI_AGENT_BROWSER_SKILL_NAME}`).toBe(plugin.skillName);
  const body = await fs.readFile(skillFile, "utf8");
  expect(body).toContain("name: mori-agent-browser");
  expect(body).toContain("mcp__eco_agent_browser__");
  const codex = buildMoriAgentBrowserCodexSkillInfo(skillFile);
  expect(codex.name).toBe("mori-agent-browser");
  expect(codex.settingsKey).toBe(`builtin:mori-agent-browser:${skillFile}`);
});

test("plugin and shared skill resolve from the packaged resources layout", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mori-browser-resources-"));
  try {
    const source = resolveBundledMoriBrowserPluginDir();
    if (!source) throw new Error("Browser plugin is missing");
    const root = path.join(tmp, "plugins", "mori");
    await fs.cp(source, root, { recursive: true });
    expect(resolveBundledMoriBrowserPluginDir({ resourcesPath: tmp })).toBe(root);
    expect(resolveBundledMoriAgentBrowserSkillDir({ resourcesPath: tmp })).toBe(
      path.join(root, "skills", "mori-agent-browser"),
    );
    expect(resolveClaudeBrowserPlugin(true, { resourcesPath: tmp })?.plugins).toEqual([
      { type: "local", path: root },
    ]);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("browser plugin remains session-scoped and does not require user settings", () => {
  expect(resolveClaudeBrowserPlugin(false)).toBeUndefined();
  const plugin = resolveClaudeBrowserPlugin(true);
  if (!plugin) throw new Error("Browser plugin is missing");
  const config = resolveSdkSessionSkillConfig("default", { projectNames: ["review"], explicitUser: [] });
  config.skills.push(plugin.skillName);
  expect(config.settingSources).toEqual(["project"]);
  expect(config.skills).toEqual(["review", "mori:mori-agent-browser"]);
  const assignments = buildRuntimeAgentSkillAssignments(config.skills);
  expect(assignments.main).toContain(plugin.skillName);
  expect(assignments.coder).toContain(plugin.skillName);
  expect(assignments.explore).toContain(plugin.skillName);
});

test("cleanup removes only historical app-managed copies of either name", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mori-browser-skill-cleanup-"));
  try {
    const legacy = await writeSkill(tmp, LEGACY_ECO_AGENT_BROWSER_SKILL_NAME, ".eco-managed");
    const current = await writeSkill(tmp, MORI_AGENT_BROWSER_SKILL_NAME, ".mori-managed");
    const unrelated = await writeSkill(tmp, "user-browser", ".mori-managed");
    await cleanupLegacyClaudeBrowserSkills({ homedir: tmp });
    await expect(fs.access(legacy)).rejects.toBeDefined();
    await expect(fs.access(current)).rejects.toBeDefined();
    expect(await fs.readFile(path.join(unrelated, "SKILL.md"), "utf8")).toContain("user skill");
    await cleanupLegacyClaudeBrowserSkills({ homedir: tmp });
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("cleanup preserves user-created skills with either built-in name", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mori-browser-skill-user-"));
  try {
    const directories = await Promise.all([
      writeSkill(tmp, LEGACY_ECO_AGENT_BROWSER_SKILL_NAME),
      writeSkill(tmp, MORI_AGENT_BROWSER_SKILL_NAME),
    ]);
    await cleanupLegacyClaudeBrowserSkills({ homedir: tmp });
    for (const directory of directories) {
      expect(await fs.readFile(path.join(directory, "SKILL.md"), "utf8")).toContain("user skill");
    }
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("cleanup preserves user symlinks even when their targets contain a managed marker", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mori-browser-skill-symlink-"));
  try {
    const target = await writeSkill(tmp, "external-skill", ".eco-managed");
    const link = path.join(tmp, ".claude", "skills", MORI_AGENT_BROWSER_SKILL_NAME);
    await fs.symlink(target, link, "dir");
    await cleanupLegacyClaudeBrowserSkills({ homedir: tmp });
    expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(path.join(target, "SKILL.md"), "utf8")).toContain("user skill");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("browser prompts select the runtime skill name and retain session routing rules", () => {
  const claudePrompt = buildEcoAgentBrowserPromptAppend("thr_test", MORI_CLAUDE_BROWSER_SKILL_NAME);
  expect(claudePrompt).toContain("Skill `mori:mori-agent-browser`");
  expect(ECO_AGENT_BROWSER_PROMPT_APPEND).toContain("Skill `mori-agent-browser`");
  for (const prompt of [claudePrompt, ECO_AGENT_BROWSER_PROMPT_APPEND]) {
    expect(prompt).toContain("do not pass a custom `session`");
    expect(prompt).toContain("binds the browser session automatically");
    expect(prompt).toContain("eco_agent_browser");
    expect(prompt).not.toContain(LEGACY_ECO_AGENT_BROWSER_SKILL_NAME);
    expect(prompt.length).toBeLessThan(1600);
  }
});
