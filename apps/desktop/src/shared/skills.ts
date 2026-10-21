import type { ResolvedOrchestrationSnapshot } from "./agent-orchestration";

export type SkillSource = "user" | "project";
export type SkillLayout = "claude" | "agents" | "codex" | "pi";

export const CLAUDE_SKILLS_REL = ".claude/skills" as const;
export const AGENTS_SKILLS_REL = ".agents/skills" as const;
export const CODEX_SKILLS_REL = ".codex/skills" as const;
/** Project-local Pi skills (see https://pi.dev/docs/latest/skills). */
export const PI_SKILLS_REL = ".pi/skills" as const;

export const USER_SKILL_ROOTS = [CLAUDE_SKILLS_REL, AGENTS_SKILLS_REL, CODEX_SKILLS_REL] as const;
export const PROJECT_SKILL_ROOTS = [
  CLAUDE_SKILLS_REL,
  AGENTS_SKILLS_REL,
  CODEX_SKILLS_REL,
  PI_SKILLS_REL,
] as const;

export interface SkillInfo {
  name: string;
  description: string;
  source: SkillSource;
  /** Directory containing SKILL.md */
  directory: string;
  skillFilePath: string;
  /** Stable project/user settings key; project keys remain stable across worktrees. */
  settingsKey?: string;
  layout: SkillLayout;
  /** True when Claude Agent SDK can load this skill (.claude path or symlink). */
  sdkReady: boolean;
  /** Project directory layer containing .claude / .agents (user skills: homedir). */
  baseDir?: string;
  /** skills.sh repository identity when recorded by a compatible Skill lock file. */
  catalogSource?: string;
  /** skills.sh Skill id when recorded by a compatible Skill lock file. */
  catalogSkillId?: string;
}

export interface SkillsListResult {
  workspacePath?: string;
  userSkills: SkillInfo[];
  projectSkills: SkillInfo[];
  agentsOnlySkills: SkillInfo[];
  scannedAt: string;
}

export interface SkillUninstallRequest {
  directory: string;
}

export interface SkillUninstallResult {
  ok: true;
  directory: string;
  removed: "directory" | "link";
  method: "skills-cli" | "filesystem";
}

export interface SkillCatalogEntry {
  id: string;
  skillId: string;
  name: string;
  source: string;
  installs: number;
  url: string;
}

export interface SkillCatalogSearchRequest {
  query: string;
  limit?: number;
}

export interface SkillCatalogSearchResult {
  query: string;
  searchType: "fuzzy" | "semantic" | "unknown";
  entries: SkillCatalogEntry[];
  durationMs?: number;
}

export interface SkillCatalogInstallRequest {
  source: string;
  skillId: string;
  layout: SkillLayout;
}

export interface SkillCatalogInstallResult {
  ok: true;
  directory: string;
  fileCount: number;
}

export interface LinkAgentsSkillsRequest {
  workspacePath: string;
  /** When set, only link skills under this base directory layer. */
  baseDir?: string;
}

export interface LinkAgentsSkillsSkipped {
  name: string;
  baseDir: string;
  reason: string;
}

export interface LinkAgentsSkillsResult {
  created: Array<{ name: string; baseDir: string; linkPath: string }>;
  skipped: LinkAgentsSkillsSkipped[];
  errors: string[];
}

/** One entry per skill name; prefers `.claude` layout when both exist. */
export function dedupeSkillsByName(skills: readonly SkillInfo[]): SkillInfo[] {
  const byName = new Map<string, SkillInfo>();
  for (const skill of skills) {
    const existing = byName.get(skill.name);
    if (!existing) {
      byName.set(skill.name, skill);
      continue;
    }
    if (skill.layout === "claude" && existing.layout !== "claude") {
      byName.set(skill.name, skill);
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function listSdkReadyProjectSkills(skills: readonly SkillInfo[]): SkillInfo[] {
  return dedupeSkillsByName(skills.filter((skill) => skill.source === "project" && skill.sdkReady));
}

export function isSkillAvailableForCore(
  skill: Pick<SkillInfo, "layout" | "sdkReady" | "skillFilePath">,
  coreKind: "claude" | "codex" | "pi" | "acp",
): boolean {
  if (coreKind === "acp") {
    // ACP (Cursor) owns its native rules/skills; Eco does not inject or rewrite them.
    return false;
  }
  if (coreKind === "pi") {
    // Eco injects agents + .pi skills; Claude/Codex-only layouts stay hidden.
    return skill.layout === "agents" || skill.layout === "pi";
  }
  if (coreKind === "claude") {
    return skill.sdkReady;
  }
  return (
    (skill.layout === "agents" || skill.layout === "codex") &&
    !/[/\\]\.codex[/\\]skills[/\\]\.system[/\\]/.test(skill.skillFilePath)
  );
}

export const SKILL_NAME_TOKEN = /\$([a-zA-Z0-9][a-zA-Z0-9_-]*)/g;

/** Skill names from Codex-style `$skill-name` tokens in a prompt. */
export function parseExplicitSkillNames(prompt: string | undefined): string[] {
  if (!prompt?.trim()) {
    return [];
  }
  const names: string[] = [];
  const seen = new Set<string>();
  for (const match of prompt.matchAll(SKILL_NAME_TOKEN)) {
    const name = match[1];
    if (!name || seen.has(name)) {
      continue;
    }
    seen.add(name);
    names.push(name);
  }
  return names;
}

export function promptIncludesSkillName(prompt: string | undefined, skillName: string): boolean {
  return parseExplicitSkillNames(prompt).includes(skillName);
}

export interface StructuredCodexSkillInput {
  type: "skill";
  name: string;
  path: string;
}

export function resolveExplicitCodexSkillInputs(
  prompt: string | undefined,
  skills: readonly SkillInfo[],
): StructuredCodexSkillInput[] {
  const byName = new Map(dedupeSkillsByName(skills).map((skill) => [skill.name, skill]));
  return parseExplicitSkillNames(prompt).flatMap((name) => {
    const skill = byName.get(name);
    return skill ? [{ type: "skill" as const, name: skill.name, path: skill.skillFilePath }] : [];
  });
}

/** `$name` tokens that match discovered user-level skills (sdk-ready only). */
export function filterExplicitUserSkillNames(
  prompt: string | undefined,
  userSkills: readonly Pick<SkillInfo, "name" | "sdkReady">[],
): string[] {
  const allowed = new Set(userSkills.filter((skill) => skill.sdkReady).map((skill) => skill.name));
  return parseExplicitSkillNames(prompt).filter((name) => allowed.has(name));
}

export type SdkSessionSkillsScope = "planning" | "default";

/**
 * Read roots Eco may allow without a separate outside-workspace prompt.
 * Project skills are scoped to the opened project/repo. User-level skills must be
 * supplied explicitly in `skills`; Eco never opens the whole user skills tree.
 */
export function resolveSdkSessionSkillConfig(
  scope: SdkSessionSkillsScope,
  input: {
    projectNames: readonly string[];
    explicitUser: readonly string[];
  },
): { settingSources: Array<"user" | "project">; skills: string[] } {
  const usesUserSource = input.explicitUser.length > 0;
  if (scope === "planning") {
    const skills = mergeSkillNames(input.projectNames, input.explicitUser);
    return {
      settingSources: usesUserSource ? (["project", "user"] as const) : (["project"] as const),
      skills,
    };
  }
  const skills = mergeSkillNames(input.projectNames, input.explicitUser);
  return {
    settingSources: usesUserSource ? (["project", "user"] as const) : (["project"] as const),
    skills,
  };
}

export function mergeSkillNames(...lists: readonly (readonly string[])[]): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const list of lists) {
    for (const name of list) {
      const trimmed = name.trim();
      if (!trimmed || seen.has(trimmed)) {
        continue;
      }
      seen.add(trimmed);
      merged.push(trimmed);
    }
  }
  return merged.sort((a, b) => a.localeCompare(b));
}

const LEGACY_AGENT_SKILL_ROLES = ["main", "explore", "architect", "coder", "reviewer", "tester"] as const;

export function buildRuntimeAgentSkillAssignments(
  skills: readonly string[],
  orchestration?: Pick<ResolvedOrchestrationSnapshot, "agents">,
): Partial<Record<string, string[]>> {
  if (skills.length === 0) {
    return {};
  }
  const cleanSkills = [...skills];
  const assignments: Partial<Record<string, string[]>> = Object.fromEntries(
    LEGACY_AGENT_SKILL_ROLES.map((role) => [role, [...cleanSkills]]),
  );
  for (const agent of orchestration?.agents ?? []) {
    if (!agent.enabled) {
      continue;
    }
    assignments[agent.agentKey] = [...cleanSkills];
    assignments[sdkAgentKeyForSkillAssignment(agent.agentKey)] = [...cleanSkills];
  }
  return assignments;
}

function sdkAgentKeyForSkillAssignment(agentKey: string): string {
  const sanitized = agentKey
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return sanitized.startsWith("eco_") ? sanitized : `eco_${sanitized || "agent"}`;
}

export function parseSkillFrontmatter(content: string): { name: string; description: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) {
    return { name: "", description: "" };
  }

  const block = match[1] ?? "";
  const name = readYamlScalar(block, "name");
  const description = readYamlScalar(block, "description");
  return { name, description };
}

function readYamlScalar(block: string, key: string): string {
  const pattern = new RegExp(`^${key}:\\s*(.+)$`, "m");
  const match = block.match(pattern);
  if (!match?.[1]) {
    return "";
  }
  let value = match[1].trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  return value;
}
