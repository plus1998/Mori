import type { ParsedUsage } from "@eco/runtime";
import type { RuntimeAgentRole } from "../shared/ipc";
import { USAGE_LEDGER_CONTEXT_UPDATE_METADATA_KEY } from "./proxy-usage-pending-settlement";
import {
  buildSubagentContextObservationInput,
  resolveSubagentBillingMetricsContext,
} from "./subagent-billing-metrics-effects";
import type { SubagentContextObservationInput } from "./subagent-metrics-registry";
import type { UsageBillingContextUpdate } from "./usage-billing-artifacts";
import type { UsageContextService } from "./usage-context-effects";
import type { UsageLedgerEvent } from "./usage-ledger";
import type { ProxyAttributionSettlement } from "./usage-ledger-coordinator";

export interface ProxyAttributionContextReconciliationServices {
  context: Pick<UsageContextService, "applyUpdate" | "getSnapshot" | "emitLive">;
  subagentMetrics: {
    recordContextObservation(threadId: string, input: SubagentContextObservationInput): unknown;
  };
  schedulePersistThreadMetrics(threadId: string): void;
  logDiag?: (topic: string, fields: Record<string, unknown>) => void;
}

export async function reconcileProxyAttributionContexts(
  services: ProxyAttributionContextReconciliationServices,
  threadId: string,
  settlements: readonly ProxyAttributionSettlement[],
): Promise<void> {
  let updated = false;
  for (const settlement of settlements) {
    const storedContextUpdate = readProxyUsageContextUpdate(settlement.event);
    if (!storedContextUpdate) {
      services.logDiag?.("usage_ledger.proxy_context_reconciliation_missing_metadata", {
        threadId,
        eventId: settlement.event.id,
        agentId: settlement.agentId,
        messageId: settlement.messageId ?? settlement.event.sdkMessageId ?? null,
      });
      continue;
    }

    const contextUpdate: UsageBillingContextUpdate = {
      ...storedContextUpdate,
      role: settlement.role,
    };
    const usage = usageFromLedgerEvent(settlement.event);
    const messageId = settlement.messageId ?? settlement.event.sdkMessageId;
    const plannerSettlement = settlement.role === "main";
    const contextUpdated = await services.context.applyUpdate({
      threadId,
      usage,
      contextUpdate,
      ...(!plannerSettlement && { agentId: settlement.agentId }),
      ...(messageId && { messageId }),
    });
    if (!contextUpdated) {
      services.logDiag?.("usage_ledger.proxy_context_reconciliation_skipped", {
        threadId,
        eventId: settlement.event.id,
        agentId: settlement.agentId,
      });
      continue;
    }

    const context = plannerSettlement
      ? undefined
      : resolveSubagentBillingMetricsContext({
          role: settlement.role,
          agentId: settlement.agentId,
          snapshot: services.context.getSnapshot(threadId),
          fallbackUsage: usage,
        });
    if (context) {
      services.subagentMetrics.recordContextObservation(
        threadId,
        buildSubagentContextObservationInput(context, {
          ...(settlement.parentToolUseId && {
            parentToolUseId: settlement.parentToolUseId,
          }),
          ...(settlement.event.modelId && {
            modelId: settlement.event.modelId,
          }),
          ...(settlement.event.requestKey && {
            requestKey: settlement.event.requestKey,
          }),
        }),
      );
    }
    updated = true;
  }

  if (updated) {
    services.context.emitLive(threadId);
    services.schedulePersistThreadMetrics(threadId);
  }
}

export function readProxyUsageContextUpdate(event: UsageLedgerEvent): UsageBillingContextUpdate | undefined {
  const value = event.metadata?.[USAGE_LEDGER_CONTEXT_UPDATE_METADATA_KEY];
  if (!isRecord(value)) {
    return undefined;
  }
  const role = readRequiredString(value.role) as RuntimeAgentRole | undefined;
  const modelId = readRequiredString(value.modelId);
  const providerBaseUrl = readRequiredString(value.providerBaseUrl);
  if (!role || !modelId || !providerBaseUrl) {
    return undefined;
  }
  const modelsDevMapping = readModelsDevMapping(value.modelsDevMapping);
  const manualSpec = readManualSpec(value.manualSpec);
  return {
    role,
    modelId,
    providerBaseUrl,
    ...(modelsDevMapping && { modelsDevMapping }),
    ...(manualSpec && { manualSpec }),
  };
}

function readModelsDevMapping(value: unknown): UsageBillingContextUpdate["modelsDevMapping"] | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const providerKey = readRequiredString(value.providerKey);
  const modelId = readRequiredString(value.modelId);
  return providerKey && modelId ? { providerKey, modelId } : undefined;
}

function readManualSpec(value: unknown): UsageBillingContextUpdate["manualSpec"] | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const result: NonNullable<UsageBillingContextUpdate["manualSpec"]> = {};
  for (const key of [
    "contextTokens",
    "maxOutputTokens",
    "inputPerM",
    "outputPerM",
    "cacheReadPerM",
    "cacheWritePerM",
    "priceMultiplier",
  ] as const) {
    const field = value[key];
    if (typeof field === "number" && Number.isFinite(field)) {
      result[key] = field;
    }
  }
  for (const key of ["supportsImageInput", "supportsReasoning"] as const) {
    const field = value[key];
    if (typeof field === "boolean") {
      result[key] = field;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function usageFromLedgerEvent(event: UsageLedgerEvent): ParsedUsage {
  return {
    inputTokens: event.inputTokens,
    outputTokens: event.outputTokens,
    cacheReadTokens: event.cacheReadTokens,
    cacheCreationTokens: event.cacheCreationTokens,
    ...(event.modelId && { modelId: event.modelId }),
  };
}

function readRequiredString(value: unknown): string | undefined {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
