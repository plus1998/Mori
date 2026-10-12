/**
 * Desktop host for PI Agent-tool subagents.
 * Spawns isolated PI sessions with per-agent Gateway model routes.
 */
import { randomUUID } from "node:crypto";
import type { ResolvedModelRoute } from "@eco/model-router";
import {
  type AgentEvent,
  buildEcoPiModel,
  collectPiSubagentFinalText,
  computePiRouteFingerprint,
  createDefaultPiSession,
  type EcoAgentRuntimeConfig,
  type EcoApiCompat,
  filterMcpServersForPiSubagent,
  globalPiSessionRegistry,
  listEnabledPiSubagents,
  mapEcoThinkingEffortToPiThinkingLevel,
  materializeEcoToolPolicy,
  type PiSubagentSpawnHandler,
  type PiSubagentSpawnResult,
  piChildSessionKey,
  piParentSessionKey,
  resolvePiRouteByRole,
  resolvePiSubagentAgentDir,
  resolvePiSubagentToolAllowlist,
  truncatePiSubagentResult,
} from "@eco/runtime";
import { createAgentEvent } from "@eco/shared";
import { resolveUpstreamApiCompat } from "../shared/api-compat";
import type { IntegratedWebSearchSettingsSnapshot, RouteManualSpec } from "../shared/ipc";
import type { AgentLifecycleService } from "./agent-lifecycle-service.js";
import type { ConversationStore } from "./conversation-store.js";
import { forcedPlanDelegationStore } from "./forced-plan-delegation-runtime.js";
import type { StartedGatewayRouteBinding } from "./gateway-route-binding";
import { buildPiGatewayRequestHeaders } from "./gateway-route-binding";
import { buildPiSessionToolApprovalFields, buildPiWebSearchSessionFields } from "./pi-runtime-run.js";
import type { SubagentMetricsRegistry } from "./subagent-metrics-registry.js";
import { createSubagentSessionHooks } from "./subagent-session-hooks.js";

export interface CreatePiSubagentSpawnHandlerInput {
  threadId: string;
  ecoDataDir: string;
  /** Armed parent-run Gateway binding (must include each subagent role alias). */
  getArmedBinding: () =>
    | {
        binding: StartedGatewayRouteBinding;
        driverRoutes: ResolvedModelRoute[];
        runAttemptId?: string;
        globalContextWindowLimit: number;
      }
    | undefined;
  parentMcpServers?: Record<string, unknown>;
  parentSkillPaths?: readonly string[];
  registry: EcoAgentRuntimeConfig;
  conversationStore: ConversationStore;
  lifecycle?: AgentLifecycleService;
  metricsRegistry?: SubagentMetricsRegistry;
  /** Required: child sessions must not spawn ungated. */
  toolPermissionHandler: import("@eco/runtime").SdkToolPermissionHandler;
  getIntegratedWebSearchRuntime: () => {
    settings: IntegratedWebSearchSettingsSnapshot;
    apiKey?: string;
  };
  resolveRouteManualSpec?: (role: string) => RouteManualSpec | undefined;
}

export function createPiSubagentSpawnHandler(
  input: CreatePiSubagentSpawnHandlerInput,
): PiSubagentSpawnHandler {
  if (!input.toolPermissionHandler) {
    throw new Error("PI subagent tool permission handler is required.");
  }
  const agents = listEnabledPiSubagents(input.registry);
  const byKey = new Map(agents.map((agent) => [agent.agentKey, agent]));

  return async (spawnInput): Promise<PiSubagentSpawnResult> => {
    const agent = byKey.get(spawnInput.agentKey);
    if (!agent) {
      throw new Error(
        `PI subagent "${spawnInput.agentKey}" is not enabled in this session's orchestration snapshot.`,
      );
    }

    // "指定子代理执行已批准计划": when the host armed a one-shot delegation, the PI spawn
    // must dispatch the canonical task to exactly the chosen role. A wrong target or a
    // repeat spawn fails loudly instead of silently falling back to the parent's task.
    let task = spawnInput.task;
    if (forcedPlanDelegationStore.get(input.threadId)) {
      const claim = forcedPlanDelegationStore.claimSpawn({
        threadId: input.threadId,
        agentKey: agent.agentKey,
        ...(spawnInput.parentToolUseId ? { toolUseId: spawnInput.parentToolUseId } : {}),
      });
      if (!claim.ok) {
        throw new Error(claim.reason);
      }
      task = claim.attempt.canonicalTask;
    }

    const armed = input.getArmedBinding();
    if (!armed) {
      throw new Error("PI Gateway binding is not armed for this thread.");
    }

    const route = resolvePiRouteByRole(armed.driverRoutes, agent.agentKey);
    if (!route) {
      throw new Error(
        `No Gateway route for PI subagent "${agent.agentKey}". Configure a provider/model on that agent — do not fall back to the main agent model.`,
      );
    }

    const bindingRoute =
      armed.binding.routes.find((entry) => entry.role === agent.agentKey) ??
      armed.binding.routes.find((entry) => entry.aliasModelId === route.primary.modelId);
    if (!bindingRoute) {
      throw new Error(`PI Gateway binding is missing alias route for subagent "${agent.agentKey}".`);
    }

    const apiCompat = resolveUpstreamApiCompat(
      bindingRoute.apiCompat,
      bindingRoute.provider.apiCompat,
    ) as EcoApiCompat;

    const agentId = `pi_${agent.agentKey}_${randomUUID().slice(0, 8)}`;
    const childAgentDir = resolvePiSubagentAgentDir(input.ecoDataDir, input.threadId, agentId);
    const childKey = piChildSessionKey(input.threadId, agentId);

    const headers = buildPiGatewayRequestHeaders({
      bindingId: armed.binding.bindingId,
      threadId: input.threadId,
      ...(armed.runAttemptId ? { runAttemptId: armed.runAttemptId } : {}),
      providerId: bindingRoute.provider.id,
      requestedModel: bindingRoute.aliasModelId,
      apiCompat,
    });

    const modelSpec = buildEcoPiModel({
      bridgeBaseUrl: armed.binding.baseUrl,
      bridgeModelId: bindingRoute.aliasModelId,
      route,
      apiCompat,
      ...(route.primary.contextWindow !== undefined
        ? { contextWindow: route.primary.contextWindow }
        : bindingRoute.contextTokens !== undefined
          ? { contextWindow: bindingRoute.contextTokens }
          : {}),
      globalContextWindowLimit: armed.globalContextWindowLimit,
      ...(bindingRoute.maxOutputTokens !== undefined && {
        maxOutputTokens: bindingRoute.maxOutputTokens,
        globalMaxOutputTokens: bindingRoute.maxOutputTokens,
      }),
      headers,
    });
    const thinkingLevel = mapEcoThinkingEffortToPiThinkingLevel(route.thinkingEffort);

    const childMcp = filterMcpServersForPiSubagent(input.parentMcpServers, agent.mcpServers);
    const hasMcp = Boolean(childMcp && Object.keys(childMcp).length > 0);
    const integratedWebSearch = input.getIntegratedWebSearchRuntime();
    const plannerManualSpec = input.resolveRouteManualSpec?.(agent.agentKey);
    const webSearchSession = buildPiWebSearchSessionFields({
      ...(plannerManualSpec ? { plannerManualSpec } : {}),
      networkWebSearch: materializeEcoToolPolicy(agent.tools).network?.webSearch,
      integratedSettings: integratedWebSearch.settings,
      ...(integratedWebSearch.apiKey ? { integratedApiKey: integratedWebSearch.apiKey } : {}),
    });
    const toolsAllowlist = resolvePiSubagentToolAllowlist(
      agent.tools,
      hasMcp,
      webSearchSession.webSearchBackend === undefined
        ? {}
        : { webSearchBackend: webSearchSession.webSearchBackend },
    );

    const parentSession = globalPiSessionRegistry.get(piParentSessionKey(input.threadId));
    const cwd = parentSession?.cwd;
    if (!cwd) {
      throw new Error("PI parent session cwd is unavailable for subagent spawn.");
    }

    const routeFingerprint = computePiRouteFingerprint({
      cwd,
      providerId: bindingRoute.provider.id,
      modelId: bindingRoute.aliasModelId,
      apiCompat,
      baseUrl: armed.binding.baseUrl,
      bindingId: armed.binding.bindingId,
      routes: [route],
    });

    const sessionHooks = createSubagentSessionHooks(input.conversationStore, input.threadId, "execution", {
      ...(input.lifecycle ? { lifecycle: input.lifecycle } : {}),
      ...(input.metricsRegistry ? { metricsRegistry: input.metricsRegistry } : {}),
    });

    sessionHooks.onStart({
      agentId,
      agentType: agent.agentKey,
      parentToolUseId: spawnInput.parentToolUseId,
      prompt: task,
    });
    forcedPlanDelegationStore.confirmSpawn({
      threadId: input.threadId,
      agentKey: agent.agentKey,
      ...(spawnInput.parentToolUseId ? { toolUseIds: [spawnInput.parentToolUseId] } : {}),
    });

    spawnInput.emitEvent(
      createAgentEvent({
        id: `${input.threadId}:pi:subagent:start:${agentId}`,
        threadId: input.threadId,
        agentId,
        role: agent.agentKey,
        type: "agent.started",
        payload: {
          source: "pi",
          agentKey: agent.agentKey,
          parentToolUseId: spawnInput.parentToolUseId,
        },
      }),
    );

    const childSession = await createDefaultPiSession({
      threadId: input.threadId,
      cwd,
      agentDir: childAgentDir,
      model: modelSpec,
      thinkingLevel,
      apiKey: armed.binding.apiKey,
      apiCompat,
      bindingId: `${armed.binding.bindingId}:${agentId}`,
      routeFingerprint,
      skillPaths: input.parentSkillPaths ?? [],
      ...(childMcp ? { mcpServers: childMcp } : {}),
      systemPromptOverride: [
        agent.prompt.trim(),
        "You are a specialized subagent. Complete the delegated task.",
        "Do not attempt to spawn further subagents.",
      ]
        .filter(Boolean)
        .join("\n\n"),
      toolsAllowlist,
      eventRole: agent.agentKey,
      eventAgentId: agentId,
      replacePersistedSessions: true,
      ...buildPiSessionToolApprovalFields({
        toolPermissionHandler: input.toolPermissionHandler,
        agentId,
        agentType: agent.agentKey,
      }),
      ...webSearchSession,
    });
    globalPiSessionRegistry.set(childKey, childSession);

    const collected: AgentEvent[] = [];
    let failedMessage: string | undefined;
    try {
      for await (const event of childSession.prompt(task, spawnInput.signal)) {
        // Child run.terminal / thread.failed stay local; do not complete the parent run.
        if (event.type === "run.terminal" || event.type === "thread.failed") {
          if (event.type === "thread.failed") {
            const payload = event.payload as { message?: string };
            failedMessage = payload.message ?? "PI subagent failed.";
          } else {
            const payload = event.payload as { status?: string; error?: string; reason?: string };
            if (payload.status === "failed") {
              failedMessage = payload.error ?? "PI subagent failed.";
            } else if (payload.status === "cancelled") {
              failedMessage = payload.reason ?? "PI subagent cancelled.";
            }
          }
          continue;
        }
        collected.push(event);
        spawnInput.emitEvent(event);
        if (spawnInput.signal?.aborted) {
          break;
        }
      }

      if (failedMessage) {
        throw new Error(failedMessage);
      }

      const rawText = collectPiSubagentFinalText(collected);
      const truncated = truncatePiSubagentResult(rawText);
      sessionHooks.onStop?.({
        agentId,
        agentType: agent.agentKey,
      });
      spawnInput.emitEvent(
        createAgentEvent({
          id: `${input.threadId}:pi:subagent:stop:${agentId}`,
          threadId: input.threadId,
          agentId,
          role: agent.agentKey,
          type: "agent.completed",
          payload: {
            source: "pi",
            agentKey: agent.agentKey,
            truncated: truncated.truncated,
          },
        }),
      );
      return {
        agentId,
        agentKey: agent.agentKey,
        text: truncated.text,
        truncated: truncated.truncated,
      };
    } catch (error) {
      sessionHooks.onStop?.({
        agentId,
        agentType: agent.agentKey,
      });
      spawnInput.emitEvent(
        createAgentEvent({
          id: `${input.threadId}:pi:subagent:stop:${agentId}:error`,
          threadId: input.threadId,
          agentId,
          role: agent.agentKey,
          type: "agent.failed",
          payload: {
            source: "pi",
            agentKey: agent.agentKey,
            error: error instanceof Error ? error.message : String(error),
          },
        }),
      );
      throw error;
    } finally {
      await globalPiSessionRegistry.delete(childKey);
    }
  };
}
