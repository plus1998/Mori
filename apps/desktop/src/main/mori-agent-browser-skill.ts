import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import {
  LEGACY_ECO_AGENT_BROWSER_SKILL_NAME,
  MORI_AGENT_BROWSER_SKILL_NAME,
  MORI_BROWSER_PLUGIN_NAME,
  MORI_CLAUDE_BROWSER_SKILL_NAME,
} from "../shared/browser";
import { CLAUDE_SKILLS_REL, type SkillInfo } from "../shared/skills";

const MANAGED_MARKER = ".mori-managed";
const LEGACY_MANAGED_MARKER = ".eco-managed";

function tryGetAppPath(): string | undefined {
  try {
    const require = createRequire(import.meta.url);
    const electron = require("electron") as { app?: { getAppPath?: () => string } };
    return electron.app?.getAppPath?.();
  } catch {
    return undefined;
  }
}

type BundledPluginOptions = { resourcesPath?: string; cwd?: string; appPath?: string };

/** The local Claude plugin also owns the skill file consumed by Codex and PI. */
export function resolveBundledMoriBrowserPluginDir(options: BundledPluginOptions = {}): string | undefined {
  const candidates: string[] = [];
  const resourcesPath =
    options.resourcesPath ?? (typeof process.resourcesPath === "string" ? process.resourcesPath : undefined);
  if (resourcesPath) {
    candidates.push(path.join(resourcesPath, "plugins", MORI_BROWSER_PLUGIN_NAME));
  }
  const appPath = options.appPath ?? tryGetAppPath();
  if (appPath) {
    candidates.push(path.join(appPath, "packaging", "plugins", MORI_BROWSER_PLUGIN_NAME));
    candidates.push(path.join(appPath, "..", "packaging", "plugins", MORI_BROWSER_PLUGIN_NAME));
  }
  const cwd = options.cwd ?? process.cwd();
  candidates.push(path.join(cwd, "packaging", "plugins", MORI_BROWSER_PLUGIN_NAME));
  candidates.push(path.join(cwd, "apps", "desktop", "packaging", "plugins", MORI_BROWSER_PLUGIN_NAME));

  return candidates.find(
    (directory) =>
      fs.existsSync(path.join(directory, ".claude-plugin", "plugin.json")) &&
      fs.existsSync(path.join(directory, "skills", MORI_AGENT_BROWSER_SKILL_NAME, "SKILL.md")),
  );
}

export function resolveBundledMoriAgentBrowserSkillDir(
  options: BundledPluginOptions = {},
): string | undefined {
  const plugin = resolveBundledMoriBrowserPluginDir(options);
  return plugin ? path.join(plugin, "skills", MORI_AGENT_BROWSER_SKILL_NAME) : undefined;
}

/** Resolve only for enabled browser sessions; never install into user skill directories. */
export function resolveClaudeBrowserPlugin(
  enabled: boolean,
  options: BundledPluginOptions = {},
):
  | { plugins: Array<{ type: "local"; path: string }>; skillName: string; skillDirectory: string }
  | undefined {
  if (!enabled) return undefined;
  const directory = resolveBundledMoriBrowserPluginDir(options);
  if (!directory) throw new Error("未找到打包的 Mori 浏览器插件（mori-agent-browser）。");
  return {
    plugins: [{ type: "local", path: directory }],
    skillName: MORI_CLAUDE_BROWSER_SKILL_NAME,
    skillDirectory: path.join(directory, "skills", MORI_AGENT_BROWSER_SKILL_NAME),
  };
}

export function isMoriManagedClaudeSkillDir(directory: string): boolean {
  return (
    fs.existsSync(path.join(directory, MANAGED_MARKER)) ||
    fs.existsSync(path.join(directory, LEGACY_MANAGED_MARKER))
  );
}

async function removeManagedSkill(directory: string): Promise<void> {
  const entry = await fsPromises.lstat(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (entry?.isDirectory() && isMoriManagedClaudeSkillDir(directory)) {
    await fsPromises.rm(directory, { recursive: true, force: true });
  }
}

/** Cleanup only historical app-managed copies; user skills and symlinks are untouched. */
export async function cleanupLegacyClaudeBrowserSkills(options: { homedir?: string } = {}): Promise<void> {
  for (const name of [MORI_AGENT_BROWSER_SKILL_NAME, LEGACY_ECO_AGENT_BROWSER_SKILL_NAME]) {
    await removeManagedSkill(path.join(options.homedir ?? os.homedir(), CLAUDE_SKILLS_REL, name));
  }
}

/** Codex uses path + enabled; layout agents|codex is required by resolveCodexThreadSkills filter. */
export function buildMoriAgentBrowserCodexSkillInfo(skillFilePath: string): SkillInfo {
  const directory = path.dirname(skillFilePath);
  return {
    name: MORI_AGENT_BROWSER_SKILL_NAME,
    description:
      "Mori built-in browser via agent-browser MCP; snapshot-and-ref workflow for the in-app browser.",
    source: "user",
    directory,
    skillFilePath,
    layout: "agents",
    sdkReady: false,
    settingsKey: `builtin:${MORI_AGENT_BROWSER_SKILL_NAME}:${skillFilePath}`,
  };
}

/**
 * Absolute path to the shared packaged SKILL.md for Codex and PI.
 */
export function resolveMoriAgentBrowserSkillFile(): string | undefined {
  const dir = resolveBundledMoriAgentBrowserSkillDir();
  if (!dir) return undefined;
  const skillFilePath = path.join(dir, "SKILL.md");
  return fs.existsSync(skillFilePath) ? skillFilePath : undefined;
}
