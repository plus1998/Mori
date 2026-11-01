/**
 * Codex-native orchestration Agent tool policy.
 *
 * Maps Eco settings to Codex `sandbox_mode`, `approval_policy`, `web_search`,
 * and MCP allowlists — not Claude Agent SDK tool names.
 *
 * @see docs/codex-permissions.md
 * @see docs/codex-integration-plan.md §6
 */

export const CODEX_SANDBOX_MODES = ["read-only", "workspace-write", "danger-full-access"] as const;
export type CodexSandboxMode = (typeof CODEX_SANDBOX_MODES)[number];

/** Codex `AskForApproval` (app-server / config.toml). `on-failure` is not a live enum value. */
export const CODEX_APPROVAL_POLICIES = ["on-request", "never"] as const;
export type CodexApprovalPolicy = (typeof CODEX_APPROVAL_POLICIES)[number];

export type CodexExecutionConfirmationMode = "always" | "auto" | "allow_all";

export const CODEX_WEB_SEARCH_MODES = ["disabled", "cached", "live"] as const;
export type CodexWebSearchMode = (typeof CODEX_WEB_SEARCH_MODES)[number];

/**
 * Product-default orchestration tool policy:
 * - workspace write (project-edit)
 * - outside workspace requires Codex approval prompts
 * - approvalPolicy on-request (Codex decides when to ask)
 */
export const DEFAULT_CODEX_TOOL_POLICY: EcoToolPolicy = {
  sandboxMode: "workspace-write",
  approvalPolicy: "on-request",
  networkAccess: false,
  webSearch: "disabled",
  allowSpawn: true,
};

export interface EcoToolPolicy {
  /** Codex `sandbox_mode` / turn `sandboxPolicy`. */
  sandboxMode: CodexSandboxMode;
  /** Codex `approval_policy` / turn `approvalPolicy`. */
  approvalPolicy: CodexApprovalPolicy;
  /**
   * When `sandboxMode` is `workspace-write`, maps to
   * `[sandbox_workspace_write] network_access`.
   */
  networkAccess?: boolean;
  /** Codex `web_search` mode. */
  webSearch?: CodexWebSearchMode;
  mcp?: {
    /** Servers not listed are omitted from config (unavailable). */
    allowedServers: string[];
    /** Tool names without `mcp__<server>__` prefix; omit = all tools from allowed servers. */
    enabledTools?: string[];
  };
  /** Main agent may register spawn_agent roles. Subagents default false. */
  allowSpawn?: boolean;
}

export type CodexTurnSandboxPolicy = "readOnly" | "workspaceWrite" | "dangerFullAccess";

export type CodexAppServerSandboxPolicyWire =
  | { type: "readOnly"; networkAccess?: boolean }
  | { type: "workspaceWrite"; networkAccess?: boolean }
  | { type: "dangerFullAccess" };

/** Role / config.toml keys written for an orchestration agent. */
export interface CodexRolePermissionTomlFields {
  sandbox_mode: CodexSandboxMode;
  approval_policy: CodexApprovalPolicy;
  web_search?: CodexWebSearchMode;
  sandbox_workspace_write?: { network_access: boolean };
}

const CLAUDE_WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const CLAUDE_DELEGATION_TOOLS = new Set(["Agent", "Task", "TaskList", "TaskGet"]);

export function isCodexSandboxMode(value: unknown): value is CodexSandboxMode {
  return typeof value === "string" && (CODEX_SANDBOX_MODES as readonly string[]).includes(value);
}

export function isCodexApprovalPolicy(value: unknown): value is CodexApprovalPolicy {
  return typeof value === "string" && (CODEX_APPROVAL_POLICIES as readonly string[]).includes(value);
}

export function isCodexWebSearchMode(value: unknown): value is CodexWebSearchMode {
  return typeof value === "string" && (CODEX_WEB_SEARCH_MODES as readonly string[]).includes(value);
}

/**
 * Normalize stored / form policy to Codex shape.
 * Legacy Claude fields (`allowed`/`disallowed`/`bash`/`filesystem`/`network`) map once;
 * invalid values throw (no silent defaults that hide gaps).
 */
export function normalizeEcoToolPolicy(
  raw: unknown,
  options: { allowSpawnDefault?: boolean } = {},
): EcoToolPolicy {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Tool policy must be an object.");
  }
  const record = raw as Record<string, unknown>;

  if (isCodexSandboxMode(record.sandboxMode)) {
    return normalizeCodexShapedPolicy(record, options.allowSpawnDefault);
  }

  return migrateLegacyClaudeToolPolicy(record, options.allowSpawnDefault);
}

function normalizeCodexShapedPolicy(
  record: Record<string, unknown>,
  allowSpawnDefault?: boolean,
): EcoToolPolicy {
  const sandboxMode = record.sandboxMode;
  if (!isCodexSandboxMode(sandboxMode)) {
    throw new Error(`Invalid sandboxMode: ${String(record.sandboxMode)}`);
  }
  if (record.approvalPolicy === "untrusted") {
    // Codex 0.149+ removed untrusted; migrate stored policies to on-request.
    record = { ...record, approvalPolicy: "on-request" };
  }
  if (record.approvalPolicy !== undefined && !isCodexApprovalPolicy(record.approvalPolicy)) {
    throw new Error(`Invalid approvalPolicy: ${String(record.approvalPolicy)}`);
  }
  if (record.webSearch !== undefined && !isCodexWebSearchMode(record.webSearch)) {
    throw new Error(`Invalid webSearch: ${String(record.webSearch)}`);
  }
  if (record.networkAccess !== undefined && typeof record.networkAccess !== "boolean") {
    throw new Error("networkAccess must be a boolean.");
  }
  if (record.allowSpawn !== undefined && typeof record.allowSpawn !== "boolean") {
    throw new Error("allowSpawn must be a boolean.");
  }

  const approvalPolicy = isCodexApprovalPolicy(record.approvalPolicy)
    ? record.approvalPolicy
    : DEFAULT_CODEX_TOOL_POLICY.approvalPolicy;

  const policy: EcoToolPolicy = {
    sandboxMode,
    approvalPolicy,
  };

  if (sandboxMode === "workspace-write") {
    policy.networkAccess = record.networkAccess === true;
  } else if (record.networkAccess === true) {
    throw new Error(
      "networkAccess is only valid with sandboxMode workspace-write (Codex sandbox_workspace_write.network_access).",
    );
  }

  if (isCodexWebSearchMode(record.webSearch)) {
    policy.webSearch = record.webSearch;
  }

  if (record.mcp !== undefined) {
    policy.mcp = normalizeMcpPolicy(record.mcp);
  }

  if (typeof record.allowSpawn === "boolean") {
    policy.allowSpawn = record.allowSpawn;
  } else if (allowSpawnDefault !== undefined) {
    policy.allowSpawn = allowSpawnDefault;
  }

  return policy;
}

function migrateLegacyClaudeToolPolicy(
  record: Record<string, unknown>,
  allowSpawnDefault?: boolean,
): EcoToolPolicy {
  const disallowed = readStringArray(record.disallowed);
  const allowed = readStringArray(record.allowed);
  const disallowedSet = new Set(disallowed.map((entry) => entry.trim()).filter(Boolean));

  const filesystem = isRecord(record.filesystem) ? record.filesystem : undefined;
  const bash = isRecord(record.bash) ? record.bash : undefined;
  const network = isRecord(record.network) ? record.network : undefined;
  const mcp = record.mcp;
  // Legacy `confirmation` on tool policy is ignored: execution confirmation is Composer-only
  // (`bashReviewMode`). Old resources may still carry the field; it must not affect approvalPolicy.

  const writeNone =
    filesystem?.write === "none" || [...CLAUDE_WRITE_TOOLS].every((tool) => disallowedSet.has(tool));
  const writeWorkspace = filesystem?.write === "workspace" || !writeNone;

  // Codex has no separate "disable shell" switch. Legacy bash:false + write:none → read-only.
  // Legacy bash:false + write:workspace cannot be expressed; fail closed.
  if (bash?.enabled === false && writeWorkspace) {
    throw new Error(
      "Tool policy disables Bash while allowing writes. Codex cannot remove shell under workspace-write; re-save the orchestration resource with an explicit sandboxMode.",
    );
  }

  const sandboxMode: CodexSandboxMode = writeNone ? "read-only" : "workspace-write";

  const webSearch: CodexWebSearchMode =
    network?.webSearch === true || network?.webFetch === true || allowed.includes("WebSearch")
      ? "live"
      : "disabled";

  const delegation = isRecord(record.delegation) ? record.delegation : undefined;
  const delegationBlocked =
    delegation?.enabled === false || [...CLAUDE_DELEGATION_TOOLS].some((tool) => disallowedSet.has(tool));

  const coreOverrides = isRecord(record.coreOverrides) ? record.coreOverrides : undefined;
  const codexOverride = isRecord(coreOverrides?.codex) ? coreOverrides.codex : undefined;
  if (codexOverride?.sandboxMode !== undefined && codexOverride.sandboxMode !== "read-only") {
    throw new Error("Codex sandbox override may only tighten to read-only.");
  }
  if (codexOverride?.approvalPolicy !== undefined) {
    // Codex 0.149+ removed approval_policy = "untrusted"; drop legacy stored values.
    if (codexOverride.approvalPolicy !== "untrusted") {
      throw new Error(
        `Unsupported Codex approval override: ${String(codexOverride.approvalPolicy)}. Only read-only sandbox tightening is supported.`,
      );
    }
  }

  const policy: EcoToolPolicy = {
    sandboxMode: codexOverride?.sandboxMode === "read-only" ? "read-only" : sandboxMode,
    approvalPolicy: "on-request",
    webSearch,
    allowSpawn: allowSpawnDefault ?? !delegationBlocked,
  };

  if (policy.sandboxMode === "workspace-write") {
    policy.networkAccess = false;
  }

  if (mcp !== undefined) {
    policy.mcp = normalizeMcpPolicy(mcp, { migrateClaudeToolPatterns: true });
  }

  return policy;
}

function normalizeMcpPolicy(
  raw: unknown,
  options: { migrateClaudeToolPatterns?: boolean } = {},
): NonNullable<EcoToolPolicy["mcp"]> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("mcp policy must be an object.");
  }
  const record = raw as Record<string, unknown>;
  const allowedServers = readStringArray(record.allowedServers).map(sanitizeMcpServerName).filter(Boolean);
  const enabledToolsRaw =
    record.enabledTools !== undefined
      ? readStringArray(record.enabledTools)
      : options.migrateClaudeToolPatterns
        ? readStringArray(record.allowedTools).map(stripMcpToolPrefix)
        : [];
  const enabledTools = uniqueStrings(enabledToolsRaw.map((tool) => tool.trim()).filter(Boolean));

  if (allowedServers.length === 0 && enabledTools.length === 0) {
    return { allowedServers: [] };
  }
  return {
    allowedServers,
    ...(enabledTools.length > 0 ? { enabledTools } : {}),
  };
}

export function cloneEcoToolPolicy(policy: EcoToolPolicy): EcoToolPolicy {
  return {
    sandboxMode: policy.sandboxMode,
    approvalPolicy: policy.approvalPolicy,
    ...(policy.networkAccess !== undefined ? { networkAccess: policy.networkAccess } : {}),
    ...(policy.webSearch !== undefined ? { webSearch: policy.webSearch } : {}),
    ...(policy.mcp
      ? {
          mcp: {
            allowedServers: [...policy.mcp.allowedServers],
            ...(policy.mcp.enabledTools ? { enabledTools: [...policy.mcp.enabledTools] } : {}),
          },
        }
      : {}),
    ...(policy.allowSpawn !== undefined ? { allowSpawn: policy.allowSpawn } : {}),
  };
}

/** Map Eco's three user-facing modes to Codex's documented sandbox/approval pairs. */
export function applyCodexExecutionConfirmation(
  policy: EcoToolPolicy,
  mode: CodexExecutionConfirmationMode,
): EcoToolPolicy {
  const cloned = cloneEcoToolPolicy(policy);
  if (mode === "allow_all") {
    const { networkAccess: _networkAccess, ...fullAccessPolicy } = cloned;
    return {
      ...fullAccessPolicy,
      sandboxMode: "danger-full-access",
      approvalPolicy: "never",
    };
  }
  return {
    ...cloned,
    sandboxMode: "workspace-write",
    approvalPolicy: "on-request",
    networkAccess: false,
  };
}

export function resolveAssignedMcpServers(policy: EcoToolPolicy, extra: readonly string[] = []): string[] {
  return uniqueStrings([
    ...(policy.mcp?.allowedServers ?? []).map(sanitizeMcpServerName),
    ...extra.map(sanitizeMcpServerName),
  ]).filter(Boolean);
}

export function ecoToolPolicyToRoleTomlFields(policy: EcoToolPolicy): CodexRolePermissionTomlFields {
  const fields: CodexRolePermissionTomlFields = {
    sandbox_mode: policy.sandboxMode,
    approval_policy: policy.approvalPolicy,
  };
  if (policy.webSearch) {
    fields.web_search = policy.webSearch;
  }
  if (policy.sandboxMode === "workspace-write") {
    fields.sandbox_workspace_write = { network_access: policy.networkAccess === true };
  }
  return fields;
}

export function ecoSandboxModeToTurnPolicy(mode: CodexSandboxMode): CodexTurnSandboxPolicy {
  switch (mode) {
    case "read-only":
      return "readOnly";
    case "workspace-write":
      return "workspaceWrite";
    case "danger-full-access":
      return "dangerFullAccess";
    default: {
      const _exhaustive: never = mode;
      throw new Error(`Unsupported sandbox mode: ${String(_exhaustive)}`);
    }
  }
}

export function toCodexAppServerSandboxPolicyWire(
  policy: CodexTurnSandboxPolicy,
  networkAccess?: boolean,
): CodexAppServerSandboxPolicyWire {
  if (policy === "readOnly") {
    return { type: "readOnly", ...(networkAccess ? { networkAccess: true } : {}) };
  }
  if (policy === "dangerFullAccess") {
    return { type: "dangerFullAccess" };
  }
  return { type: "workspaceWrite", ...(networkAccess ? { networkAccess: true } : {}) };
}

/**
 * Ask is read-only. Plan inherits the selected permissions so research can use
 * shell/network/MCP; the native Plan collaboration template prevents implementation.
 */
export function resolveEffectiveTurnSandbox(input: {
  sessionMode: "agent" | "plan" | "ask";
  orchestrationPolicy?: EcoToolPolicy;
}): { sandboxPolicy: CodexTurnSandboxPolicy; networkAccess?: boolean; approvalPolicy: CodexApprovalPolicy } {
  const orchestration = input.orchestrationPolicy ?? DEFAULT_CODEX_TOOL_POLICY;
  const approvalPolicy = orchestration.approvalPolicy;

  if (input.sessionMode === "ask") {
    return { sandboxPolicy: "readOnly", approvalPolicy };
  }

  const orchestrationTurn = ecoSandboxModeToTurnPolicy(orchestration.sandboxMode);
  // Agent and Plan share the user-selected execution permissions.
  return {
    sandboxPolicy: orchestrationTurn,
    ...(orchestrationTurn === "workspaceWrite" && orchestration.networkAccess ? { networkAccess: true } : {}),
    approvalPolicy,
  };
}

export function resolveMainAgentHandsOnFromCodexPolicy(policy: EcoToolPolicy): {
  canEditFiles: boolean;
  canRunBash: boolean;
} {
  return {
    canEditFiles: policy.sandboxMode === "workspace-write" || policy.sandboxMode === "danger-full-access",
    // Codex always exposes shell; sandbox restricts what it may do.
    canRunBash: true,
  };
}

export function sanitizeMcpServerName(name: string): string {
  const normalized = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "mcp-server";
}

function stripMcpToolPrefix(pattern: string): string {
  const trimmed = pattern.trim();
  if (!trimmed.startsWith("mcp__")) {
    return trimmed;
  }
  const rest = trimmed.slice(5);
  const separator = rest.indexOf("__");
  if (separator <= 0) {
    return trimmed;
  }
  return rest.slice(separator + 2);
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string");
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
