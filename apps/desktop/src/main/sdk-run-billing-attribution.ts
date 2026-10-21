import type { RuntimeAgentRole } from "../shared/ipc";
import {
  resolveSubagentUsageAttribution,
  type SubagentUsageAttributionResolver,
} from "./subagent-usage-attribution";
import type { ResolvedSdkRunBillingModel } from "./usage-billing-artifacts";

export interface SdkRunBillingAttributionResolver extends SubagentUsageAttributionResolver {}

export interface ResolveSdkRunBillingAttributionInput {
  threadId: string;
  role: RuntimeAgentRole;
  models: readonly ResolvedSdkRunBillingModel[];
  resolver: SdkRunBillingAttributionResolver;
  parentToolUseId?: string;
  subagentAgentId?: string;
  plannerAgentId?: string;
  stampedAgentId?: string;
  stampedBillingRole?: RuntimeAgentRole;
}

export interface SdkRunBillingAttribution {
  billingRole: RuntimeAgentRole;
  allLedgerRowsArePlanner: boolean;
  resolvedSubagentId?: string;
  ledgerAgentId?: string;
}

export function resolveSdkRunBillingAttribution(
  input: ResolveSdkRunBillingAttributionInput,
): SdkRunBillingAttribution {
  const primaryModel = input.models[0];
  const initialRole = primaryModel?.role ?? input.role;
  const attribution = resolveSubagentUsageAttribution({
    threadId: input.threadId,
    role: initialRole,
    resolver: input.resolver,
    ...(input.subagentAgentId && { explicitSubagentId: input.subagentAgentId }),
    ...(input.stampedAgentId && { stampedAgentId: input.stampedAgentId }),
    ...(input.stampedBillingRole && { stampedBillingRole: input.stampedBillingRole }),
    ...(input.parentToolUseId && { parentToolUseId: input.parentToolUseId }),
  });

  const { billingRole, subagentAgentId: resolvedSubagentId } = attribution;
  const allLedgerRowsArePlanner = input.models.every((model) => (model.role ?? input.role) === "main");
  const ledgerAgentId = resolvedSubagentId ?? (allLedgerRowsArePlanner ? input.plannerAgentId : undefined);

  return {
    billingRole,
    allLedgerRowsArePlanner,
    ...(resolvedSubagentId && { resolvedSubagentId }),
    ...(ledgerAgentId && { ledgerAgentId }),
  };
}
