import {
  isSubagentRole,
  SDK_GENERAL_PURPOSE_AGENT_KEY,
  SDK_PLAN_AGENT_KEY,
} from "@eco/runtime/subagent-availability";
import { normalizeSdkSubagentType } from "@eco/runtime/subagent-resume";

/** Fallback labels for sub-agent roles when a localized renderer label is unavailable. */
export const SUBAGENT_ROLE_SHORT: Record<string, string> = {
  vision: "看图",
  explore: "探索",
  architect: "架构",
  coder: "编码",
  reviewer: "审查",
  tester: "测试",
};

const SUBAGENT_ROLE_I18N_KEYS: Record<string, string> = {
  vision: "agent.role.vision",
  explore: "agent.role.explore",
  architect: "agent.role.architect",
  coder: "agent.role.coder",
  reviewer: "agent.role.reviewer",
  tester: "agent.role.tester",
};

export const SUBAGENT_ROLES = new Set(Object.keys(SUBAGENT_ROLE_SHORT));

const NON_AGENT_ACTIVITY_ROLES = new Set([
  "assistant",
  "main",
  "planner", // Historical main-agent role, never a custom subagent.
  "system",
  "thinking",
  "tool",
  "user",
]);

const CHINESE_ROLE_TO_ID: Record<string, string> = {
  探索: "explore",
  架构: "architect",
  编码: "coder",
  审查: "reviewer",
  测试: "tester",
};

export function isSubagentDisplayRole(role?: string): boolean {
  return Boolean(role && SUBAGENT_ROLES.has(role));
}

/** Map tool lines / mission payloads to canonical Eco sub-agent role ids. */
export function normalizeSubagentDisplayRole(role: string | undefined): string | undefined {
  if (!role?.trim()) {
    return undefined;
  }
  const trimmed = role.trim();
  const fromChinese = CHINESE_ROLE_TO_ID[trimmed];
  if (fromChinese) {
    return fromChinese;
  }
  const fromSdk = normalizeSdkSubagentType(trimmed);
  if (fromSdk) {
    return fromSdk;
  }
  return isSubagentRole(trimmed) ? trimmed : undefined;
}

export function normalizeAgentDisplayRole(role: string | undefined): string | undefined {
  const fixedRole = normalizeSubagentDisplayRole(role);
  if (fixedRole) {
    return fixedRole;
  }
  if (!role?.trim()) {
    return undefined;
  }
  const trimmed = role.trim();
  const withoutEcoPrefix = trimmed.startsWith("eco_") ? trimmed.slice(4) : trimmed;
  if (!withoutEcoPrefix || NON_AGENT_ACTIVITY_ROLES.has(withoutEcoPrefix)) {
    return undefined;
  }
  if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(withoutEcoPrefix)) {
    return undefined;
  }
  return withoutEcoPrefix;
}

export function isAgentDisplayRole(role?: string): boolean {
  return Boolean(normalizeAgentDisplayRole(role));
}

export function resolveSubagentRunDisplayTitle(role: string, translate?: (key: string) => string): string {
  const normalized = normalizeAgentDisplayRole(role) ?? role;
  const translationKey = SUBAGENT_ROLE_I18N_KEYS[normalized];
  if (translationKey && translate) {
    const localized = translate(translationKey).trim();
    if (localized && localized !== translationKey) {
      return localized;
    }
  }
  if (SUBAGENT_ROLE_SHORT[normalized]) {
    return SUBAGENT_ROLE_SHORT[normalized];
  }
  if (isAgentDisplayRole(normalized)) {
    return normalized.replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
  }
  return "子代理";
}

/** Canonical runtime role for billing hooks when SDK sends eco_* keys or orchestration display ids. */
export function resolveSubagentSessionRole(agentType: string | undefined): string | undefined {
  if (!agentType?.trim()) {
    return undefined;
  }
  const trimmed = agentType.trim();
  if (trimmed === SDK_GENERAL_PURPOSE_AGENT_KEY || trimmed === SDK_PLAN_AGENT_KEY) {
    return trimmed;
  }
  const fromSdk = normalizeSdkSubagentType(trimmed);
  if (fromSdk) {
    return fromSdk;
  }
  const fromDisplay = normalizeAgentDisplayRole(trimmed);
  if (fromDisplay) {
    return fromDisplay.toLowerCase();
  }
  return undefined;
}
