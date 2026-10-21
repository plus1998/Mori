import type { RuntimeAgentRole } from "../shared/ipc";
import type { UsageBillingObservation } from "./billing-orchestration";
import {
  resolveSdkEventUsageBilling,
  type SdkEventUsageBillingResolution,
  type SdkUsageEventLike,
} from "./sdk-event-usage-billing";
import type {
  SdkUsageBillingDispatchResult,
  SdkUsageBillingDispatchServices,
} from "./sdk-usage-billing-dispatch";
import type { SubagentUsageAttributionResolver } from "./subagent-usage-attribution";

export interface SdkUsageRecordedContextEventInput {
  threadId: string;
  eventId: string;
  payload: unknown;
}

export interface SdkUsageRecordedEventHandlerServices {
  handleContextEvent(input: SdkUsageRecordedContextEventInput): boolean;
  usageRunAttemptId(threadId: string): string | undefined;
  usagePlannerAgentId(threadId: string): string | undefined;
  listObservedAuthoritativeUsage(threadId: string): readonly UsageBillingObservation[] | undefined;
  noteAssistantMessageIdentity(input: {
    threadId: string;
    messageId: string;
    agentId: string;
    role: RuntimeAgentRole;
    parentToolUseId?: string;
  }): void;
  resolver: SubagentUsageAttributionResolver;
  dispatchUsageBilling(input: {
    threadId: string;
    resolved: SdkEventUsageBillingResolution;
    services: SdkUsageBillingDispatchServices;
  }): SdkUsageBillingDispatchResult;
  dispatchServices: SdkUsageBillingDispatchServices;
}

export type SdkUsageRecordedEventHandlerResult =
  | { handled: "context" }
  | {
      handled: "usage";
      resolutionKind: SdkEventUsageBillingResolution["kind"];
      dispatch: SdkUsageBillingDispatchResult;
    };

export function handleSdkUsageRecordedEvent(input: {
  threadId: string;
  event: SdkUsageEventLike;
  services: SdkUsageRecordedEventHandlerServices;
}): SdkUsageRecordedEventHandlerResult {
  const { threadId, event, services } = input;
  if (
    services.handleContextEvent({
      threadId,
      eventId: event.id,
      payload: event.payload,
    })
  ) {
    return { handled: "context" };
  }

  const runAttemptId = services.usageRunAttemptId(threadId);
  const plannerAgentId = services.usagePlannerAgentId(threadId);
  const observedAuthoritativeUsage = services.listObservedAuthoritativeUsage(threadId);
  const resolved = resolveSdkEventUsageBilling({
    threadId,
    event,
    resolver: services.resolver,
    ...(runAttemptId && { runAttemptId }),
    ...(plannerAgentId && { plannerAgentId }),
    ...(observedAuthoritativeUsage && { observedAuthoritativeUsage }),
  });

  if (
    (resolved.kind === "assistant_ignored" || resolved.kind === "assistant_subagent") &&
    resolved.messageId
  ) {
    const exactAgentId =
      resolved.subagentAgentId ??
      (resolved.billingRole === "main" && !resolved.parentToolUseId ? plannerAgentId : undefined);
    if (exactAgentId) {
      services.noteAssistantMessageIdentity({
        threadId,
        messageId: resolved.messageId,
        agentId: exactAgentId,
        role: resolved.billingRole,
        ...(resolved.parentToolUseId && { parentToolUseId: resolved.parentToolUseId }),
      });
    }
  }

  return {
    handled: "usage",
    resolutionKind: resolved.kind,
    dispatch: services.dispatchUsageBilling({
      threadId,
      resolved,
      services: services.dispatchServices,
    }),
  };
}
