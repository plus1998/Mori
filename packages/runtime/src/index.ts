import type { ResolvedModelRoute } from "../../model-router/src";
import type { EventStore, ThreadRecord } from "../../shared/src";
import { type AgentEvent, createAgentEvent, type RuntimeAgentRole } from "../../shared/src";
import type { WorktreePlan } from "../../workspace/src";
import type { EcoAgentRuntimeConfig } from "./agent-orchestration.js";
import type { PlanHandoffChoice } from "./codex-plan-handoff.js";
import type { SubagentRole } from "./subagent-availability.js";

export interface ThreadStartRequest {
  threadId: string;
  title: string;
  workspacePath: string;
  prompt: string;
  routes: ResolvedModelRoute[];
  worktree: WorktreePlan;
}

export type EcoSettingSource = "user" | "project" | "local";

export interface EcoSdkSessionOptions {
  /** Loads CLAUDE.md, rules, skills, hooks, and project .mcp.json */
  settingSources?: EcoSettingSource[];
  /** Main session (Planner) skill directories to preload */
  skills?: string[];
  /** Per-agent skill directories for subagent definitions. Keys may be built-in roles, orchestration agentKeys, or SDK eco_* keys. */
  agentSkills?: Partial<Record<RuntimeAgentRole, string[]>>;
  /** File read roots for project skills and explicitly referenced user skills in this SDK run. */
  implicitReadAllowRoots?: string[];
  /** Subagent on/off. */
  enabledSubagents?: Partial<Record<SubagentRole, boolean>>;
  mcpServers?: Record<string, unknown>;
  mcpAllowedTools?: string[];
  /** Extra bare tool names removed from model context for this session (e.g. WebSearch when Eco Integrated search is armed). */
  disallowedTools?: string[];
  /** Composer-selected MCP servers for this session (merged with orchestration assignment). */
  runtimeMcpServers?: string[];
}

export interface EcoSdkResumeOptions {
  /** Initialize the empty conversation allocated by /clear; no transcript exists to resume yet. */
  newSessionId?: string;
  /** Resume an existing SDK session by ID. */
  resumeSessionId?: string;
  /** Resume transcript up to and including this SDK message UUID. */
  resumeSessionAt?: string;
  /**
   * With `resumeSessionAt`: prompt UUID of the turn this truncating resume intends to drop.
   * Claude CLI refuses when the discarded range contains non-turn content
   * (`Resume rejected by --resume-drops-turn:`).
   */
  resumeDropsTurn?: string;
  /** Fork from resumeSessionId into a new session (explore alternatives). */
  forkSession?: boolean;
}

export interface ResumableSubagentRef {
  role: string;
  agentId: string;
}

export interface CodexSkillInput {
  type: "skill";
  name: string;
  path: string;
}

export interface CodexSessionOptions {
  skillInputs?: CodexSkillInput[];
  /** Absolute paths to validated, locally materialized image attachments. */
  localImagePaths?: string[];
}

/** Per-run PI skill / MCP visibility (Eco-selected; private agentDir/skills always included). */
export interface PiSessionOptions {
  /** Host identity of the dispatched prompt, bound to the exact persisted Pi user entry. */
  promptActivityLineId?: string;
  /** Absolute skill directories or SKILL.md paths enabled for this thread. */
  skillPaths?: string[];
  /**
   * Isolated MCP server map for this thread (Claude-SDK shaped entries).
   * Loaded via the official PI MCP extension with an in-memory config — never
   * merged with ambient mcp.json / ~/.pi.
   */
  mcpServers?: Record<string, unknown>;
  /** Extra system prompt segments (e.g. browser / image integration guidance). */
  appendSystemPrompt?: string[];
  /**
   * Absolute path to a prior PI session JSONL under ecoDataDir/pi-agent/<threadId>/sessions/.
   * Opened only when resume identity + MCP fingerprints match the current run.
   */
  sessionFile?: string;
  /** Identity fingerprint captured with sessionFile (excludes bindingId). */
  resumeIdentityFingerprint?: string;
  /** MCP fingerprint captured with sessionFile. */
  resumeMcpFingerprint?: string;
  /**
   * Desktop-provided spawn handler for the Eco Agent tool.
   * Required when agentRegistry has enabled subagents; omitted for child sessions.
   */
  onSubagentSpawn?: import("./pi-subagent.js").PiSubagentSpawnHandler;
  /** Eco tool permission callback (Claude canUseTool shape). */
  toolPermissionHandler?: import("./ask-user-question.js").SdkToolPermissionHandler;
  toolApprovalAgentId?: string;
  toolApprovalAgentType?: string;
  /** Eco session mode for PI Ask / Plan / Agent tool policy. */
  sessionMode?: import("./core-runtime.js").CoreSessionMode;
  /** Resolved PI web search backend for this run. */
  webSearchBackend?: import("./pi-web-search-plan.js").PiWebSearchBackend;
  /** Integrated search provider when webSearchBackend is integrated. */
  integratedWebSearchProvider?: import("./pi-integrated-web-search.js").IntegratedWebSearchProvider;
  /** Runtime-only integrated search API key when webSearchBackend is integrated. */
  integratedWebSearchApiKey?: string;
}

export interface AgentRuntimeRunInput {
  threadId: string;
  prompt: string;
  workspacePath: string;
  worktreePath: string;
  routes: ResolvedModelRoute[];
  signal: AbortSignal;
  sdkSession?: EcoSdkSessionOptions;
  codexSession?: CodexSessionOptions;
  piSession?: PiSessionOptions;
  resume?: EcoSdkResumeOptions;
  /** Stopped subagent sessions Eco may auto-Resume via PreToolUse. */
  resumableSubagents?: readonly ResumableSubagentRef[];
  /** Optional universal agent registry used to generate SDK AgentDefinitions dynamically. */
  agentRegistry?: EcoAgentRuntimeConfig;
  /** Eco personalization rules injected into Claude systemPrompt.append. */
  globalUserRules?: string;
}

export interface EcoPlanningContext {
  userPrompt: string;
  analysis: string;
  plan: string;
  /** Claude Code `.claude/plans/` file path (workspace-relative when possible). */
  planFilePath?: string;
  /** User edited plan/analysis in Eco UI before approving execution. */
  planUserEdited?: boolean;
  /** Codex plan approval handoff; Claude ignores this field. */
  handoffChoice?: PlanHandoffChoice;
  /** Optional plan-refinement follow-up for Codex. */
  userFollowUp?: string;
  /** Exact deferred ExitPlanMode tool use approved with this plan, when fallback resume is required. */
  deferredExitPlanToolUseId?: string;
}

export interface AgentRuntimeDriver {
  run(input: AgentRuntimeRunInput): AsyncIterable<AgentEvent>;
  runAsk?(input: AgentRuntimeRunInput): AsyncIterable<AgentEvent>;
  runPlan?(input: AgentRuntimeRunInput): AsyncIterable<AgentEvent>;
  runContinuation?(
    input: AgentRuntimeRunInput,
    mode: "planning" | "execution" | "ask",
    planning?: EcoPlanningContext,
  ): AsyncIterable<AgentEvent>;
  /** Sends `/compact` on an existing session (requires resume). */
  compactSession?(input: AgentRuntimeRunInput): AsyncIterable<AgentEvent>;
}

export interface RunningThread {
  threadId: string;
  cancel(reason?: string): Promise<void>;
  done: Promise<void>;
}

export class ThreadSupervisor {
  private readonly running = new Map<string, AbortController>();

  constructor(
    private readonly store: EventStore,
    private readonly driver: AgentRuntimeDriver,
  ) {}

  startThread(request: ThreadStartRequest): RunningThread {
    if (this.running.has(request.threadId)) {
      throw new Error(`Thread ${request.threadId} is already running`);
    }

    const controller = new AbortController();
    this.running.set(request.threadId, controller);

    const done = this.runThread(request, controller).finally(() => {
      this.running.delete(request.threadId);
    });

    return {
      threadId: request.threadId,
      done,
      cancel: async (reason = "cancelled by user") => {
        await this.cancelThread(request.threadId, reason);
      },
    };
  }

  async cancelThread(threadId: string, reason = "cancelled by user"): Promise<void> {
    const controller = this.running.get(threadId);
    if (!controller) {
      return;
    }
    controller.abort(reason);
  }

  isRunning(threadId: string): boolean {
    return this.running.has(threadId);
  }

  private async runThread(request: ThreadStartRequest, controller: AbortController): Promise<void> {
    const now = new Date().toISOString();
    await this.store.upsertThread({
      id: request.threadId,
      title: request.title,
      workspacePath: request.workspacePath,
      status: "running",
      createdAt: now,
      updatedAt: now,
    });

    await this.store.appendEvent(
      createAgentEvent({
        id: `${request.threadId}:thread-started`,
        threadId: request.threadId,
        agentId: "system",
        role: "planner",
        type: "thread.started",
        payload: { title: request.title, workspacePath: request.workspacePath },
      }),
    );

    try {
      for await (const event of this.driver.run({
        threadId: request.threadId,
        prompt: request.prompt,
        workspacePath: request.workspacePath,
        worktreePath: request.worktree.worktreePath,
        routes: request.routes,
        signal: controller.signal,
      })) {
        await this.store.appendEvent(event);
        if (controller.signal.aborted) {
          break;
        }
      }

      const status: ThreadRecord["status"] = controller.signal.aborted ? "cancelled" : "completed";
      await this.finishThread(request, status, controller.signal.reason);
    } catch (error) {
      await this.store.appendEvent(
        createAgentEvent({
          id: `${request.threadId}:thread-failed`,
          threadId: request.threadId,
          agentId: "system",
          role: "planner",
          type: "thread.failed",
          payload: { message: error instanceof Error ? error.message : String(error) },
        }),
      );
      await this.finishThread(request, "failed");
      throw error;
    }
  }

  private async finishThread(
    request: ThreadStartRequest,
    status: ThreadRecord["status"],
    reason?: unknown,
  ): Promise<void> {
    const now = new Date().toISOString();
    const existing = await this.store.getThread(request.threadId);
    await this.store.upsertThread({
      id: request.threadId,
      title: existing?.title ?? request.title,
      workspacePath: existing?.workspacePath ?? request.workspacePath,
      status,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });

    await this.store.appendEvent(
      createAgentEvent({
        id: `${request.threadId}:thread-${status}`,
        threadId: request.threadId,
        agentId: "system",
        role: "planner",
        type:
          status === "completed"
            ? "thread.completed"
            : status === "failed"
              ? "thread.failed"
              : "thread.completed",
        payload: { status, reason },
      }),
    );
  }
}

export function buildRoleModelMap(routes: readonly ResolvedModelRoute[]): Record<RuntimeAgentRole, string> {
  return routes.reduce(
    (mapping, route) => {
      mapping[route.role] = route.primary.modelId;
      return mapping;
    },
    {} as Record<RuntimeAgentRole, string>,
  );
}

export type {
  AgentEvent,
  AgentRole,
  PlanReadyPayload,
  RuntimeAgentRole,
  SessionCapturedPayload,
} from "../../shared/src";
export * from "./acp-agent-driver.js";
export * from "./acp-client.js";
export * from "./acp-cursor-agent.js";
export * from "./acp-cursor-extensions.js";
export * from "./acp-event-map.js";
export * from "./acp-host-ui-features.js";
export * from "./acp-jsonrpc.js";
export * from "./acp-mcp.js";
export * from "./acp-permission.js";
export * from "./acp-prompt.js";
export * from "./acp-provider-exhaustion.js";
export * from "./acp-session-config.js";
export * from "./acp-session-delete.js";
export * from "./acp-types.js";
export {
  formatSubagentMissionMessage,
  isGenericMissionSummary,
  isSubagentMissionEnvelope,
  isToolElapsedDuration,
  isWeakAgentToolDetail,
  missionFromAgentToolDetail,
  parseSubagentMissionMessage,
  resolveMissionDisplayText,
  type SubagentMissionPayload,
  summarizeAgentObjective,
} from "./agent-mission";
export * from "./agent-orchestration";
export {
  apiErrorDedupeKey,
  formatApiErrorActivitySummary,
  formatApiErrorUserMessage,
  parseLegacyApiErrorActivityMessage,
  parseSdkApiErrorAttribute,
  type ThreadApiErrorInfo,
} from "./api-error";
export * from "./ask-user-question";
export {
  computeRequestBilling,
  computeSavings,
  computeThreadBillingTotals,
  emptyCostBreakdown,
  estimateCostBreakdown,
  estimateCostFromTokens,
  formatSavingsLine,
  formatSavingsPct,
  type ModelCostRates,
  mergeCostBreakdowns,
  type RequestBillingDelta,
  type ThreadBillingTotals,
  type TokenCostBreakdown,
  type TokenTotals,
  tokenTotalsFromUsage,
} from "./billing";
export type {
  SdkToolPermissionDecision,
  SdkToolPermissionRequest,
} from "./claude-agent-sdk";
export * from "./codex-app-server-client.js";
export * from "./codex-app-server-driver.js";
export * from "./codex-config-sync.js";
export * from "./codex-context-snapshot.js";
export * from "./codex-event-adapter.js";
export * from "./codex-external-agent-config.js";
export * from "./codex-fork.js";
export * from "./codex-gated-models.js";
export * from "./codex-hooks-sync.js";
export * from "./codex-mcp-output-spill.js";
export * from "./codex-model-catalog-sync.js";
export * from "./codex-model-list.js";
export * from "./codex-output-truncation.js";
export * from "./codex-plan-handoff.js";
export * from "./codex-prompt-materializer.js";
export * from "./codex-role-sync.js";
// codex-rollback re-exports fork for legacy import paths; don't `export *` it from the package root.
export * from "./codex-skills-extra-roots.js";
export * from "./codex-skills-list.js";
export {
  computeCodexCommandHookHash as computeCodexSpawnAgentHookHash,
  ECO_SPAWN_AGENT_PRETOOL_SCRIPT,
  SPAWN_AGENT_HOOK_MATCHER,
  SPAWN_AGENT_HOOK_STATUS,
  syncCodexSpawnAgentHook,
} from "./codex-spawn-agent-hook.js";
export * from "./codex-spawn-role-queue.js";
export * from "./codex-thread-attribution.js";
export * from "./codex-thread-resume.js";
export * from "./codex-tool-display-name.js";
export {
  applyCodexExecutionConfirmation,
  CODEX_APPROVAL_POLICIES,
  CODEX_SANDBOX_MODES,
  CODEX_WEB_SEARCH_MODES,
  type CodexApprovalPolicy,
  type CodexExecutionConfirmationMode,
  type CodexSandboxMode,
  type CodexWebSearchMode,
  cloneEcoToolPolicy as cloneCodexToolPolicy,
  DEFAULT_CODEX_TOOL_POLICY,
  type EcoToolPolicy as CodexToolPolicy,
  ecoSandboxModeToTurnPolicy,
  ecoToolPolicyToRoleTomlFields,
  isCodexApprovalPolicy,
  isCodexSandboxMode,
  isCodexWebSearchMode,
  normalizeEcoToolPolicy as normalizeCodexToolPolicy,
  resolveEffectiveTurnSandbox,
  resolveMainAgentHandsOnFromCodexPolicy,
  toCodexAppServerSandboxPolicyWire,
} from "./codex-tool-policy.js";
export * from "./codex-turn-interrupt.js";
export * from "./codex-turn-route-registry.js";
export * from "./codex-turn-steer.js";
export * from "./codex-version.js";
export {
  alignBreakdownSegmentsToOccupied,
  CONTEXT_SEGMENT_COLORS,
  CONTEXT_SEGMENT_LABELS,
  type ContextBreakdownSegment,
  type ContextCommandHeader,
  type ContextSegmentKey,
  contextSegmentDisplayLabel,
  mergeBreakdownWithOccupancy,
  normalizeContextSegments,
  parseContextCommandHeader,
  parseContextCommandResult,
  parseSdkGetContextUsageBreakdown,
  type SdkContextUsageBreakdown,
} from "./context-breakdown";
export * from "./core-runtime";
export {
  type CursorAgentModelListOptions,
  type CursorAgentModelOption,
  listCursorAgentModels,
  parseCursorAgentModelsOutput,
} from "./cursor-agent-models";
export * from "./eco-html-host-tool.js";
export * from "./eco-image-display-tool.js";
export * from "./eco-image-view-tool.js";
export * from "./eco-mcp-hub-tool.js";
export * from "./eco-sdk-hooks";
export * from "./eco-web-search-tool.js";
export * from "./filesystem-scope-policy.js";
export * from "./forced-plan-delegation.js";
export * from "./managed-process.js";
export {
  extractCapabilitiesFromModelEntry,
  lookupModelCapabilitiesInCatalog,
  type ModelCapabilities,
  type ModelCapabilitiesLookup,
  unresolvedModelCapabilities,
} from "./models-dev-capabilities";
export {
  computeOccupancyRatio,
  computeWindowOccupancy,
  DEFAULT_AUTOCOMPACT_BUFFER,
  DEFAULT_CONTEXT_LIMIT,
  DEFAULT_GLOBAL_CONTEXT_WINDOW_LIMIT,
  DEFAULT_GLOBAL_MAX_OUTPUT_LIMIT,
  DEFAULT_GLOBAL_MAX_OUTPUT_TOKENS,
  effectiveContextLimit,
  extractLimitsFromModelEntry,
  formatContextLimit,
  GLOBAL_CONTEXT_WINDOW_LIMIT_MAX,
  GLOBAL_CONTEXT_WINDOW_LIMIT_MIN,
  GLOBAL_CONTEXT_WINDOW_LIMIT_PRESETS,
  GLOBAL_CONTEXT_WINDOW_LIMIT_STEP,
  GLOBAL_MAX_OUTPUT_TOKEN_MAX,
  GLOBAL_MAX_OUTPUT_TOKEN_MIN,
  GLOBAL_MAX_OUTPUT_TOKEN_PRESETS,
  GLOBAL_MAX_OUTPUT_TOKEN_STEP,
  type GlobalContextWindowLimit,
  type GlobalMaxOutputTokens,
  isGlobalContextWindowLimit,
  isGlobalMaxOutputTokens,
  lookupModelLimitsInCatalog,
  type ModelContextLimits,
  type ModelLimitsLookup,
  normalizeGlobalContextWindowLimit,
  normalizeGlobalMaxOutputTokens,
  occupancyPercent,
  resolveAppliedMaxOutputTokens,
  resolveDynamicMaxOutputTokens,
  resolveEffectiveContextLimit,
} from "./models-dev-limits";
export {
  buildModelPricingSummary,
  expandModelLookupCandidates,
  fetchModelsDevCatalog,
  filterOfficialModelsDevProviders,
  findModelEntryByKey,
  formatModelPricingLabel,
  formatRatePerMillion,
  isOfficialModelsDevProvider,
  listModelsDevCatalogOptions,
  lookupModelCostByKey,
  lookupModelCostInCatalog,
  type ModelPricingLookup,
  type ModelPricingSummary,
  type ModelsDevCatalog,
  type ModelsDevCatalogModelOption,
  type ModelsDevModelEntry,
  type ModelsDevProviderEntry,
  parseModelsDevCatalog,
  resolveProviderKeyFromBaseUrl,
} from "./models-dev-pricing";
export {
  extractPhaseDeliverable,
  extractPlanningDeliverables,
  findPlanSectionStart,
  stripPlanningTranscriptNoise,
} from "./phase-deliverable";
export * from "./pi-availability.js";
export * from "./pi-codemode.js";
export * from "./pi-coding-agent-driver.js";
export * from "./pi-eco-extensions.js";
export * from "./pi-event-adapter.js";
export * from "./pi-finalize-plan.js";
export * from "./pi-integrated-web-search.js";
export * from "./pi-integrated-web-search-factory.js";
export * from "./pi-mcp.js";
export * from "./pi-model-bridge.js";
export * from "./pi-session-mode.js";
export * from "./pi-session-paths.js";
export * from "./pi-skills.js";
export * from "./pi-subagent.js";
export * from "./pi-tool-approval.js";
export * from "./pi-usage.js";
export * from "./pi-web-search-config.js";
export * from "./pi-web-search-factory.js";
export * from "./pi-web-search-plan.js";
export * from "./pi-web-search-session.js";
export * from "./reviewer-scope";
export * from "./send-message-tool.js";
export {
  formatSkillActivityLabel,
  isSkillActivityLabel,
  resolveSkillDisplayName,
  skillNameFromPath,
} from "./skill-display";
export { mergeStreamText } from "./stream-text";
export * from "./subagent-availability";
export {
  DEFAULT_SUBAGENT_HANDOFF_THRESHOLD,
  estimateHandoffTokens,
  shouldHandoffSubagentResume,
} from "./subagent-handoff.js";
export {
  buildResumeAgentPrompt,
  createSubagentMissionCapturePreToolHook,
  createSubagentResumePreToolHook,
  formatResumableSubagentsAppend,
  isFreshSubagentRequest,
  readAgentSubagentType,
  type SubagentResumeHookOptions,
  type SubagentResumeResolveInput,
} from "./subagent-resume.js";
export {
  applyThinkingToMessagesBody,
  applyThinkingToProcessEnv,
  applyThinkingToQueryOptions,
  buildThinkingQueryPatch,
  isThinkingEffort,
  type ThinkingEffort,
  type ThinkingQueryPatch,
} from "./thinking-options";
export * from "./tool-confirmation.js";
export * from "./tool-output-preview.js";
export * from "./tool-permission-policy.js";
export {
  accumulateThreadCost,
  estimateContextTokens,
  formatCostUsd,
  formatRoleModelLabel,
  formatTokenCount,
  formatUsageBadge,
  type ModelUsageEntry,
  mergeModelUsages,
  mergeUsageTotals,
  normalizeOverlappingCacheContextUsage,
  type ParsedUsage,
  parseModelUsage,
  parseSdkContextUsage,
  parseSdkModelUsageBilling,
  parseSdkUsageBilling,
  parseUsagePayload,
  type SdkModelUsageBilling,
  shortenModelId,
} from "./usage";
export * from "./v4a-teaching.js";
export * from "./v4a-teaching-flags.js";
export * from "./windows-job-object.js";
