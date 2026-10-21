import { expect, test } from "bun:test";
import { resolveSdkEventUsageBilling, type SdkUsageEventLike } from "../src/main/sdk-event-usage-billing";
import type { SubagentUsageAttributionResolver } from "../src/main/subagent-usage-attribution";
import type { RuntimeAgentRole } from "../src/shared/ipc";

function event(input: Partial<SdkUsageEventLike> = {}): SdkUsageEventLike {
  return {
    id: "evt_sdk_1",
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
  input: {
    agentByRole?: Partial<Record<RuntimeAgentRole, string>>;
    roleByAgent?: Record<string, RuntimeAgentRole>;
  } = {},
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

test("resolveSdkEventUsageBilling returns none without billable usage", () => {
  const resolved = resolveSdkEventUsageBilling({
    threadId: "thr_sdk",
    event: event({ payload: { type: "sdk_context_usage" } }),
    resolver: resolver(),
  });

  expect(resolved.kind).toBe("none");
});

test("resolveSdkEventUsageBilling builds assistant subagent billing input", () => {
  const resolved = resolveSdkEventUsageBilling({
    threadId: "thr_sdk",
    event: event({
      role: "main",
      payload: {
        messageId: "msg_1",
        model: "haiku",
        parent_tool_use_id: "toolu_parent",
        subagentAgentId: "agent_coder_1",
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          cache_read_input_tokens: 3,
          cache_creation_input_tokens: 4,
        },
      },
    }),
    runAttemptId: "attempt_1",
    plannerAgentId: "planner_attempt_1",
    resolver: resolver({
      roleByAgent: { agent_coder_1: "coder" },
    }),
  });

  expect(resolved.kind).toBe("assistant_subagent");
  if (resolved.kind !== "assistant_subagent") {
    throw new Error("expected assistant_subagent");
  }
  expect(resolved.billingRole).toBe("coder");
  expect(resolved.subagentAgentId).toBe("agent_coder_1");
  expect(resolved.billingInput).toMatchObject({
    threadId: "thr_sdk",
    role: "coder",
    agentId: "agent_coder_1",
    source: "sdk",
    usage: {
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 3,
      cacheCreationTokens: 4,
    },
    modelId: "haiku",
    messageId: "msg_1",
    runAttemptId: "attempt_1",
    plannerAgentId: "planner_attempt_1",
    parentToolUseId: "toolu_parent",
    requestKey: "sdk-assistant:msg_1",
  });
});

test("resolveSdkEventUsageBilling builds assistant billing input for dynamic subagents", () => {
  const resolved = resolveSdkEventUsageBilling({
    threadId: "thr_sdk",
    event: event({
      role: "main",
      payload: {
        messageId: "msg_dynamic_1",
        model: "haiku",
        subagentAgentId: "agent_researcher_1",
        usage: {
          input_tokens: 80,
          output_tokens: 12,
        },
      },
    }),
    resolver: resolver({
      roleByAgent: { agent_researcher_1: "researcher" },
    }),
  });

  expect(resolved.kind).toBe("assistant_subagent");
  if (resolved.kind !== "assistant_subagent") {
    throw new Error("expected assistant_subagent");
  }
  expect(resolved.billingRole).toBe("researcher");
  expect(resolved.billingInput).toMatchObject({
    role: "researcher",
    agentId: "agent_researcher_1",
    requestKey: "sdk-assistant:msg_dynamic_1",
    usage: {
      inputTokens: 80,
      outputTokens: 12,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    },
  });
});

test("resolveSdkEventUsageBilling skips assistant fallback when authoritative observation matches", () => {
  const resolved = resolveSdkEventUsageBilling({
    threadId: "thr_sdk",
    event: event({
      role: "main",
      payload: {
        messageId: "msg_1",
        model: "haiku",
        subagentAgentId: "agent_coder_1",
        usage: { input_tokens: 100, output_tokens: 20 },
      },
    }),
    observedAuthoritativeUsage: [
      {
        source: "proxy",
        role: "coder",
        agentId: "agent_coder_1",
        modelId: "haiku",
        usage: {
          inputTokens: 100,
          outputTokens: 20,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        },
      },
    ],
    resolver: resolver({
      roleByAgent: { agent_coder_1: "coder" },
    }),
  });

  expect(resolved.kind).toBe("assistant_ignored");
});

test("resolveSdkEventUsageBilling builds stream partial input", () => {
  const resolved = resolveSdkEventUsageBilling({
    threadId: "thr_sdk",
    event: event({
      id: "evt_stream_1",
      payload: {
        model: "haiku",
        parent_tool_use_id: "toolu_parent",
        usage: {
          input_tokens: 40,
          output_tokens: 5,
          cache_read_input_tokens: 2,
          cache_creation_input_tokens: 1,
        },
      },
    }),
    runAttemptId: "attempt_1",
    plannerAgentId: "planner_attempt_1",
    resolver: resolver({
      agentByRole: { coder: "agent_coder_1" },
      roleByAgent: { agent_coder_1: "coder" },
    }),
  });

  expect(resolved.kind).toBe("stream_partial");
  if (resolved.kind !== "stream_partial") {
    throw new Error("expected stream_partial");
  }
  expect(resolved.diagnostic).toMatchObject({
    throttleKey: "sdk-usage:thr_sdk:coder",
    role: "coder",
    stream: true,
    explicit: false,
    subagentAgentId: "agent_coder_1",
    parentToolUseId: "toolu_parent",
    inputTokens: 40,
    outputTokens: 5,
  });
  expect(resolved.streamInput).toMatchObject({
    threadId: "thr_sdk",
    eventId: "evt_stream_1",
    role: "coder",
    modelId: "haiku",
    runAttemptId: "attempt_1",
    plannerAgentId: "planner_attempt_1",
    subagentAgentId: "agent_coder_1",
    parentToolUseId: "toolu_parent",
    usage: {
      inputTokens: 40,
      outputTokens: 5,
      cacheReadTokens: 2,
      cacheCreationTokens: 1,
    },
  });
});

test("resolveSdkEventUsageBilling builds sdk run input and miss diagnostic", () => {
  const resolved = resolveSdkEventUsageBilling({
    threadId: "thr_sdk",
    event: event({
      id: "evt_final_1",
      payload: {
        parent_tool_use_id: "toolu_missing",
        modelUsage: {
          haiku: {
            inputTokens: 100,
            outputTokens: 20,
            cacheReadInputTokens: 3,
            cacheCreationInputTokens: 4,
          },
        },
      },
    }),
    runAttemptId: "attempt_1",
    plannerAgentId: "planner_attempt_1",
    resolver: resolver(),
  });

  expect(resolved.kind).toBe("sdk_run");
  if (resolved.kind !== "sdk_run") {
    throw new Error("expected sdk_run");
  }
  expect(resolved.missDiagnostic).toMatchObject({
    role: "coder",
    eventId: "evt_final_1",
    parentToolUseId: "toolu_missing",
  });
  expect(resolved.runInput).toMatchObject({
    threadId: "thr_sdk",
    role: "coder",
    requestKey: "sdk-result:evt_final_1",
    runAttemptId: "attempt_1",
    plannerAgentId: "planner_attempt_1",
    parentToolUseId: "toolu_missing",
  });
});
