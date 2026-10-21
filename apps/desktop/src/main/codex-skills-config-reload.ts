import { normalizeSkillsEnabled, type SkillsEnabledSettings } from "../shared/composer-skills-settings";

/** Shown when Skills would change on a loaded Codex thread (upstream reload defect). */
export const CODEX_SKILLS_CONFIG_RELOAD_BLOCKED_MESSAGE =
  "无法修改 Skills：当前 Codex 会话已加载，所用版本不支持对已加载会话进行 Skills 配置重载。请保持现有选择继续对话，或在新会话中使用新选择。";

export type CodexSkillsReloadThreadStatus = "notLoaded" | "idle" | "systemError" | "active" | "unknown";

export function skillsEnabledSettingsChanged(
  existing: SkillsEnabledSettings | undefined,
  next: SkillsEnabledSettings | undefined,
): boolean {
  return fingerprintSkillsEnabled(existing) !== fingerprintSkillsEnabled(next);
}

function fingerprintSkillsEnabled(value: SkillsEnabledSettings | undefined): string {
  const normalized = normalizeSkillsEnabled(value);
  if (!normalized) {
    return "";
  }
  return JSON.stringify(
    Object.keys(normalized)
      .sort()
      .map((key) => [key, normalized[key] === true]),
  );
}

/**
 * Block Skills persistence when a mapped Codex thread is still loaded on app-server.
 * Status undefined = client not running (next start applies config) → allow.
 */
export function shouldBlockCodexSkillsConfigReload(input: {
  skillsChanged: boolean;
  hasCodexMapping: boolean;
  status: CodexSkillsReloadThreadStatus | undefined;
}): boolean {
  if (!input.skillsChanged || !input.hasCodexMapping) {
    return false;
  }
  if (input.status === undefined || input.status === "notLoaded") {
    return false;
  }
  return true;
}
