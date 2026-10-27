import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { ECO_AGENT_BROWSER_SKILL_NAME } from "../shared/browser";
import { CLAUDE_SKILLS_REL, type SkillInfo } from "../shared/skills";

const MANAGED_MARKER = ".eco-managed";

function tryGetAppPath(): string | undefined {
  try {
    const require = createRequire(import.meta.url);
    const electron = require("electron") as { app?: { getAppPath?: () => string } };
    return electron.app?.getAppPath?.();
  } catch {
    return undefined;
  }
}

/** Directory containing packaging source SKILL.md for eco-agent-browser. */
export function resolveBundledEcoAgentBrowserSkillDir(
  options: { resourcesPath?: string; cwd?: string; appPath?: string } = {},
): string | undefined {
  const candidates: string[] = [];
  const resourcesPath =
    options.resourcesPath ?? (typeof process.resourcesPath === "string" ? process.resourcesPath : undefined);
  if (resourcesPath) {
    candidates.push(path.join(resourcesPath, "skills", ECO_AGENT_BROWSER_SKILL_NAME));
  }
  const appPath = options.appPath ?? tryGetAppPath();
  if (appPath) {
    candidates.push(path.join(appPath, "packaging", "skills", ECO_AGENT_BROWSER_SKILL_NAME));
    candidates.push(path.join(appPath, "..", "packaging", "skills", ECO_AGENT_BROWSER_SKILL_NAME));
  }
  const cwd = options.cwd ?? process.cwd();
  candidates.push(path.join(cwd, "packaging", "skills", ECO_AGENT_BROWSER_SKILL_NAME));
  candidates.push(path.join(cwd, "apps", "desktop", "packaging", "skills", ECO_AGENT_BROWSER_SKILL_NAME));

  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, "SKILL.md"))) {
      return dir;
    }
  }
  return undefined;
}

export function claudeUserEcoAgentBrowserSkillDir(homedir: string = os.homedir()): string {
  return path.join(homedir, CLAUDE_SKILLS_REL, ECO_AGENT_BROWSER_SKILL_NAME);
}

export function isEcoManagedClaudeSkillDir(directory: string): boolean {
  return fs.existsSync(path.join(directory, MANAGED_MARKER));
}

/**
 * Ensure Claude can load eco-agent-browser via ~/.claude/skills (name + user settingSources).
 * Copies from packaged skill content and marks the install as Eco-managed for safe cleanup.
 */
export async function ensureClaudeUserEcoAgentBrowserSkill(
  options: { homedir?: string } = {},
): Promise<{ ok: true; skillFilePath: string } | { ok: false; reason: string }> {
  const sourceDir = resolveBundledEcoAgentBrowserSkillDir();
  if (!sourceDir) {
    return { ok: false, reason: "未找到打包的 eco-agent-browser skill 文件。" };
  }
  const sourceSkill = path.join(sourceDir, "SKILL.md");
  const targetDir = claudeUserEcoAgentBrowserSkillDir(options.homedir);
  const targetSkill = path.join(targetDir, "SKILL.md");
  try {
    await fsPromises.mkdir(targetDir, { recursive: true });
    await fsPromises.copyFile(sourceSkill, targetSkill);
    await fsPromises.writeFile(
      path.join(targetDir, MANAGED_MARKER),
      "Mori managed skill — do not edit; toggled with Browser Agent integration\n",
      "utf8",
    );
    return { ok: true, skillFilePath: targetSkill };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Remove Eco-managed install only (never delete user-created skills with the same name). */
export async function removeClaudeUserEcoAgentBrowserSkill(
  options: { homedir?: string } = {},
): Promise<void> {
  const targetDir = claudeUserEcoAgentBrowserSkillDir(options.homedir);
  if (!isEcoManagedClaudeSkillDir(targetDir)) {
    return;
  }
  await fsPromises.rm(targetDir, { recursive: true, force: true });
}

export function buildEcoAgentBrowserSkillInfo(skillFilePath: string): SkillInfo {
  const directory = path.dirname(skillFilePath);
  return {
    name: ECO_AGENT_BROWSER_SKILL_NAME,
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
export function buildEcoAgentBrowserCodexSkillInfo(skillFilePath: string): SkillInfo {
  const directory = path.dirname(skillFilePath);
  return {
    name: ECO_AGENT_BROWSER_SKILL_NAME,
    description:
      "Mori built-in browser via agent-browser MCP; snapshot-and-ref workflow for the in-app browser.",
    source: "user",
    directory,
    skillFilePath,
    layout: "agents",
    sdkReady: false,
    settingsKey: `builtin:eco-agent-browser:${skillFilePath}`,
  };
}

/**
 * Prefer a stable absolute path to the packaged SKILL.md for Codex (no user-home copy required).
 */
export function resolveEcoAgentBrowserSkillFileForCodex(): string | undefined {
  const dir = resolveBundledEcoAgentBrowserSkillDir();
  if (!dir) return undefined;
  const skillFilePath = path.join(dir, "SKILL.md");
  return fs.existsSync(skillFilePath) ? skillFilePath : undefined;
}
