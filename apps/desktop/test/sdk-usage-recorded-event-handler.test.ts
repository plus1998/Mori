import { expect, test } from "bun:test";
import type { UsageBillingObservation } from "../src/main/billing-orchestration";
import type { SdkEventUsageBillingResolution, SdkUsageEventLike } from "../src/main/sdk-event-usage-billing";
import type {
  SdkUsageBillingDispatchResult,
  SdkUsageBillingDispatchServices,
} from "../src/main/sdk-usage-billing-dispatch";
import {
  handleSdkUsageRecordedEvent,
  type SdkUsageRecordedEventHandlerServices,
} from "../src/main/sdk-usage-recorded-event-handler";
import type { SubagentUsageAttributionResolver } from "../src/main/subagent-usage-attribution";
import type { AgentRole } from "../src/shared/ipc";

function event(input: Partial<SdkUsageEventLike> = {}): SdkUsageEventLike {
  return {
    id: "evt_sdk",
    role: "coder",
    payload: {
      modelUsage: {
        haiku: {
          inputTokens: 100,
          outputTokens: 20,
          cacheReadInputTokens: 3,
          cacheCreationInputTokens: 4,
        },
      },
    },
    ...input,
  };
}

function resolver(
  input: { agentByRole?: Partial<Record<AgentRole, string>>; roleByAgent?: Record<string, AgentRole> } = {},
): SubagentUsageAttributionResolver {
  return {
    resolveAgentId(_threadId, request) {
      if (request.subagentAgentId) {
        return request.subagentAgentId;
      }
      return input.agentByRole?.[request.role];
    },
    roleForAgentId(_threadId, agentId) {
      return input.roleByAgent?.[agentId];
    },
  };
}

function dispatchServices(): SdkUsageBillingDispatchServices {
  return {
    trackUsageUpdate: () => undefined,
    processUsageBilling: async () => undefined,
    processSdkStreamPartialUsage: async () => undefined,
    processSdkRunBilling: async () => undefined,
    logResolution: () => undefined,
    writeError: () => undefined,
  };
}

function createServices(
  input: Partial<SdkUsageRecordedEventHandlerServices> = {},
): SdkUsageRecordedEventHandlerServices {
  return {
    handleContextEvent: () => false,
    usageRunAttemptId: () => undefined,
    usagePlannerAgentId: () => undefined,
    listObservedAuthoritativeUsage: () => undefined,
    noteAssistantMessageIdentity: () => undefined,
    resolver: resolver(),
    dispatchUsageBilling: () => ({ dispatched: false, reason: "none" }),
    dispatchServices: dispatchServices(),
    ...input,
  };
}

test("handleSdkUsageRecordedEvent short-circuits SDK context events", () => {
  let contextInput: unknown;
  const result = handleSdkUsageRecordedEvent({
    threadId: "thr_sdk",
    event: event({ id: "evt_context", payload: { type: "sdk_context_usage" } }),
    services: createServices({
      handleContextEvent: (input) => {
        contextInput = input;
        return true;
      },
      usageRunAttemptId: () => {
        throw new Error("usage state must not be read for context events");
      },
    }),
  });

  expect(result).toEqual({ handled: "context" });
  expect(contextInput).toEqual({
    threadId: "thr_sdk",
    eventId: "evt_context",
    payload: { type: "sdk_context_usage" },
  });
});

test("handleSdkUsageRecordedEvent resolves SDK final usage with run state and dispatches it", () => {
  const captured: SdkEventUsageBillingResolution[] = [];
  const result = handleSdkUsageRecordedEvent({
    threadId: "thr_sdk",
    event: event({ id: "evt_final" }),
    services: createServices({
      usageRunAttemptId: () => "attempt_1",
      usagePlannerAgentId: () => "planner_attempt_1",
      resolver: resolver({
        agentByRole: { coder: "agent_coder" },
        roleByAgent: { agent_coder: "coder" },
      }),
      dispatchUsageBilling: ({ resolved }) => {
        captured.push(resolved);
        return { dispatched: true, kind: "sdk_run" };
      },
    }),
  });

  expect(result).toEqual({
    handled: "usage",
    resolutionKind: "sdk_run",
    dispatch: { dispatched: true, kind: "sdk_run" },
  });
  expect(captured).toHaveLength(1);
  const resolved = captured[0];
  expect(resolved?.kind).toBe("sdk_run");
  if (resolved?.kind !== "sdk_run") {
    throw new Error("expected sdk_run");
  }
  expect(resolved.runInput).toMatchObject({
    threadId: "thr_sdk",
    requestKey: "sdk-result:evt_final",
    runAttemptId: "attempt_1",
    plannerAgentId: "planner_attempt_1",
    subagentAgentId: "agent_coder",
  });
});

test("handleSdkUsageRecordedEvent passes authoritative observations into assistant fallback gating", () => {
  const observed: UsageBillingObservation[] = [
    {
      source: "proxy",
      role: "coder",
      agentId: "agent_coder",
      modelId: "haiku",
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
    },
  ];
  const dispatches: SdkEventUsageBillingResolution[] = [];
  const identities: Array<{
    threadId: string;
    messageId: string;
    agentId: string;
    role: string;
    parentToolUseId?: string;
  }> = [];
  const result = handleSdkUsageRecordedEvent({
    threadId: "thr_sdk",
    event: event({
      role: "main",
      payload: {
        messageId: "msg_1",
        model: "haiku",
        subagentAgentId: "agent_coder",
        usage: {
          input_tokens: 100,
          output_tokens: 20,
        },
      },
    }),
    services: createServices({
      listObservedAuthoritativeUsage: () => observed,
      resolver: resolver({
        roleByAgent: { agent_coder: "coder" },
      }),
      noteAssistantMessageIdentity: (identity) => identities.push(identity),
      dispatchUsageBilling: ({ resolved }): SdkUsageBillingDispatchResult => {
        dispatches.push(resolved);
        return resolved.kind === "assistant_ignored"
          ? { dispatched: false, reason: "assistant_ignored" }
          : { dispatched: true, kind: "assistant_subagent" };
      },
    }),
  });

  expect(result).toEqual({
    handled: "usage",
    resolutionKind: "assistant_ignored",
    dispatch: { dispatched: false, reason: "assistant_ignored" },
  });
  expect(dispatches[0]?.kind).toBe("assistant_ignored");
  expect(identities).toEqual([
    {
      threadId: "thr_sdk",
      messageId: "msg_1",
      agentId: "agent_coder",
      role: "coder",
    },
  ]);
});

test("handleSdkUsageRecordedEvent binds an exact main-session message to the planner instance", () => {
  const identities: Array<{
    threadId: string;
    messageId: string;
    agentId: string;
    role: string;
    parentToolUseId?: string;
  }> = [];

  const result = handleSdkUsageRecordedEvent({
    threadId: "thr_sdk",
    event: event({
      role: "main",
      payload: {
        messageId: "resp_planner_exact",
        model: "sonnet",
        usage: {
          input_tokens: 10,
          output_tokens: 2,
        },
      },
    }),
    services: createServices({
      usagePlannerAgentId: () => "planner_attempt_1",
      noteAssistantMessageIdentity: (identity) => identities.push(identity),
      dispatchUsageBilling: ({ resolved }) =>
        resolved.kind === "assistant_ignored"
          ? { dispatched: false, reason: "assistant_ignored" }
          : { dispatched: false, reason: "none" },
    }),
  });

  expect(result.resolutionKind).toBe("assistant_ignored");
  expect(identities).toEqual([
    {
      threadId: "thr_sdk",
      messageId: "resp_planner_exact",
      agentId: "planner_attempt_1",
      role: "main",
    },
  ]);
});
