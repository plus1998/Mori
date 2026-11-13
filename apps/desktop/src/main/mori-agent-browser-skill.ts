import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { LEGACY_ECO_AGENT_BROWSER_SKILL_NAME, MORI_AGENT_BROWSER_SKILL_NAME } from "../shared/browser";
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

/** Directory containing packaging source SKILL.md for mori-agent-browser. */
export function resolveBundledMoriAgentBrowserSkillDir(
  options: { resourcesPath?: string; cwd?: string; appPath?: string } = {},
): string | undefined {
  const candidates: string[] = [];
  const resourcesPath =
    options.resourcesPath ?? (typeof process.resourcesPath === "string" ? process.resourcesPath : undefined);
  if (resourcesPath) {
    candidates.push(path.join(resourcesPath, "skills", MORI_AGENT_BROWSER_SKILL_NAME));
  }
  const appPath = options.appPath ?? tryGetAppPath();
  if (appPath) {
    candidates.push(path.join(appPath, "packaging", "skills", MORI_AGENT_BROWSER_SKILL_NAME));
    candidates.push(path.join(appPath, "..", "packaging", "skills", MORI_AGENT_BROWSER_SKILL_NAME));
  }
  const cwd = options.cwd ?? process.cwd();
  candidates.push(path.join(cwd, "packaging", "skills", MORI_AGENT_BROWSER_SKILL_NAME));
  candidates.push(path.join(cwd, "apps", "desktop", "packaging", "skills", MORI_AGENT_BROWSER_SKILL_NAME));

  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, "SKILL.md"))) {
      return dir;
    }
  }
  return undefined;
}

export function claudeUserMoriAgentBrowserSkillDir(homedir: string = os.homedir()): string {
  return path.join(homedir, CLAUDE_SKILLS_REL, MORI_AGENT_BROWSER_SKILL_NAME);
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

/**
 * Ensure Claude can load mori-agent-browser via ~/.claude/skills (name + user settingSources).
 * Copies from packaged skill content and marks the install as Mori-managed for safe cleanup.
 */
export async function ensureClaudeUserMoriAgentBrowserSkill(
  options: { homedir?: string } = {},
): Promise<{ ok: true; skillFilePath: string } | { ok: false; reason: string }> {
  const sourceDir = resolveBundledMoriAgentBrowserSkillDir();
  if (!sourceDir) {
    return { ok: false, reason: "未找到打包的 mori-agent-browser skill 文件。" };
  }
  const sourceSkill = path.join(sourceDir, "SKILL.md");
  const targetDir = claudeUserMoriAgentBrowserSkillDir(options.homedir);
  const targetSkill = path.join(targetDir, "SKILL.md");
  try {
    const existing = await fsPromises.lstat(targetDir).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (existing && (!existing.isDirectory() || !isMoriManagedClaudeSkillDir(targetDir))) {
      return { ok: false, reason: `技能目录已被用户文件占用，未覆盖：${targetDir}` };
    }
    await fsPromises.mkdir(targetDir, { recursive: true });
    await fsPromises.copyFile(sourceSkill, targetSkill);
    await fsPromises.writeFile(
      path.join(targetDir, MANAGED_MARKER),
      "Mori managed skill — do not edit; toggled with Browser Agent integration\n",
      "utf8",
    );
    await removeManagedSkill(
      path.join(options.homedir ?? os.homedir(), CLAUDE_SKILLS_REL, LEGACY_ECO_AGENT_BROWSER_SKILL_NAME),
    );
    return { ok: true, skillFilePath: targetSkill };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Remove current and legacy managed installs; preserve user-created skills. */
export async function removeClaudeUserMoriAgentBrowserSkill(
  options: { homedir?: string } = {},
): Promise<void> {
  const targetDir = claudeUserMoriAgentBrowserSkillDir(options.homedir);
  await removeManagedSkill(targetDir);
  await removeManagedSkill(
    path.join(options.homedir ?? os.homedir(), CLAUDE_SKILLS_REL, LEGACY_ECO_AGENT_BROWSER_SKILL_NAME),
  );
}

export function buildMoriAgentBrowserSkillInfo(skillFilePath: string): SkillInfo {
  const directory = path.dirname(skillFilePath);
  return {
    name: MORI_AGENT_BROWSER_SKILL_NAME,
    description:
      "Mori built-in browser via agent-browser MCP; snapshot-and-ref workflow for the in-app browser.",
    source: "user",
    directory,
    skillFilePath,
    layout: "claude",
    sdkReady: true,
    settingsKey: `user:claude:${skillFilePath}`,
  };
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
 * Prefer a stable absolute path to the packaged SKILL.md for Codex (no user-home copy required).
 */
export function resolveMoriAgentBrowserSkillFileForCodex(): string | undefined {
  const dir = resolveBundledMoriAgentBrowserSkillDir();
  if (!dir) return undefined;
  const skillFilePath = path.join(dir, "SKILL.md");
  return fs.existsSync(skillFilePath) ? skillFilePath : undefined;
}
