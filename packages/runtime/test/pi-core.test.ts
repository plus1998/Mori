import { expect, test } from "bun:test";
import { clampThinkingLevel } from "@earendil-works/pi-ai";
import type { AgentEvent } from "../../shared/src";
import type { SdkToolPermissionHandler } from "../src/ask-user-question";
import {
  decidePiPromptRunTerminal,
  ECO_PI_SESSION_RETRY,
  PiCodingAgentDriver,
  type PiSessionHandle,
  PiSessionRegistry,
} from "../src/pi-coding-agent-driver";
import {
  applyPiAssistantErrorTracker,
  createPiEventAdapterState,
  mapPiSessionEventToAgentEvents,
  type PiEventAdapterContext,
  readPiAssistantErrorMessage,
} from "../src/pi-event-adapter";
import {
  buildEcoPiModel,
  computePiRouteFingerprint,
  mapEcoThinkingEffortToPiThinkingLevel,
} from "../src/pi-model-bridge";
import { parsePiUsage } from "../src/pi-usage";

function makeCtx(): PiEventAdapterContext {
  let seq = 0;
  return {
    threadId: "thr_pi",
    sessionId: "sess_1",
    state: createPiEventAdapterState(),
    nextSeq: () => {
      seq += 1;
      return seq;
    },
  };
}

function streamKey(event: AgentEvent | undefined): string | undefined {
  const payload = event?.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const key = (payload as { stream_block_key?: unknown }).stream_block_key;
  return typeof key === "string" ? key : undefined;
}

function isFinalize(event: AgentEvent | undefined): boolean {
  const payload = event?.payload;
  return Boolean(
    payload &&
      typeof payload === "object" &&
      !Array.isArray(payload) &&
      (payload as { streamFinalize?: unknown }).streamFinalize === true,
  );
}

test("parsePiUsage maps pi-ai usage fields", () => {
  const usage = parsePiUsage(
    {
      input: 100,
      output: 20,
      cacheRead: 50,
      cacheWrite: 10,
      cost: { total: 0.01 },
    },
    "model-x",
  );
  expect(usage).toEqual({
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 50,
    cacheCreationTokens: 10,
    totalCostUsd: 0.01,
    modelId: "model-x",
  });
});

test("parsePiUsage returns null when empty", () => {
  expect(parsePiUsage({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })).toBeNull();
});

test("PI exposes a thinking placeholder before content on the same stream", () => {
  const ctx = makeCtx();
  const started = mapPiSessionEventToAgentEvents(
    { type: "message_update", assistantMessageEvent: { type: "thinking_start", contentIndex: 0 } },
    ctx,
  );
  expect(started).toHaveLength(1);
  expect(started[0]).toMatchObject({
    type: "message.delta",
    payload: { type: "eco_stream", blockKind: "thinking", streamPlaceholder: true },
  });
  const content = mapPiSessionEventToAgentEvents(
    {
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "先检查代码" },
    },
    ctx,
  );
  expect(streamKey(started[0])).toBe(streamKey(content[0]));
  expect(content[0]?.payload).toMatchObject({ text: "先检查代码" });
});

test("mapPiSessionEvent maps text deltas and tools", () => {
  const ctx = makeCtx();
  mapPiSessionEventToAgentEvents({ type: "message_start", message: { role: "assistant", content: [] } }, ctx);
  const deltas = mapPiSessionEventToAgentEvents(
    {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "Hello", contentIndex: 0 },
    },
    ctx,
  );
  expect(deltas).toHaveLength(1);
  expect(deltas[0]?.type).toBe("message.delta");
  expect((deltas[0]?.payload as { text?: string }).text).toBe("Hello");
  expect(streamKey(deltas[0])).toContain("pi-text:sess_1:m1");
  expect(deltas[0]?.agentId).toBe("sess_1");

  const thinking = mapPiSessionEventToAgentEvents(
    {
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", delta: "Plan: check files", contentIndex: 0 },
    },
    makeCtx(),
  );
  expect(thinking[0]?.type).toBe("message.delta");
  expect((thinking[0]?.payload as { blockKind?: string; reasoningDisplay?: string }).blockKind).toBe(
    "thinking",
  );
  expect((thinking[0]?.payload as { reasoningDisplay?: string }).reasoningDisplay).toBeUndefined();

  const openaiThinking = mapPiSessionEventToAgentEvents(
    {
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", delta: "Plan: check files", contentIndex: 0 },
    },
    { ...makeCtx(), apiCompat: "openai_responses" },
  );
  expect((openaiThinking[0]?.payload as { reasoningDisplay?: string }).reasoningDisplay).toBe("summary");

  const anthropicThinking = mapPiSessionEventToAgentEvents(
    {
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", delta: "先看 adapter", contentIndex: 0 },
    },
    { ...makeCtx(), apiCompat: "anthropic" },
  );
  expect((anthropicThinking[0]?.payload as { reasoningDisplay?: string }).reasoningDisplay).toBe("raw");

  const start = mapPiSessionEventToAgentEvents(
    {
      type: "tool_execution_start",
      toolCallId: "tc1",
      toolName: "bash",
      args: { command: "ls" },
    },
    ctx,
  );
  // open text finalizes before tool.started
  expect(start.some((e) => e.type === "tool.started")).toBe(true);
  expect(start.some((e) => isFinalize(e) && streamKey(e)?.includes("pi-text"))).toBe(true);

  const end = mapPiSessionEventToAgentEvents(
    {
      type: "tool_execution_end",
      toolCallId: "tc1",
      toolName: "bash",
      result: { content: [{ type: "text", text: "ok" }] },
      isError: false,
    },
    ctx,
  );
  expect(end[0]?.type).toBe("tool.completed");
});

/**
 * The wait PI used to leave unnamed. `tool_execution_start` only fires once the arguments
 * are complete, so between the last narrative token and that event the model was visibly
 * idle while it wrote the call. PI does stream `toolcall_start` / `toolcall_delta` — those
 * carry the tool name — so the adapter must hand that state over instead of dropping it.
 */
test("mapPiSessionEvent announces a tool call the model is still writing", () => {
  const ctx = makeCtx();
  mapPiSessionEventToAgentEvents({ type: "message_start", message: { role: "assistant", content: [] } }, ctx);
  const partial = {
    role: "assistant",
    content: [{ type: "toolCall", id: "call_1", name: "create_file", arguments: {}, partialJson: '{"pa' }],
  };

  const started = mapPiSessionEventToAgentEvents(
    { type: "message_update", assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, partial } },
    ctx,
  );
  expect(started).toHaveLength(1);
  expect(started[0]?.type).toBe("tool.started");
  expect(started[0]?.payload).toMatchObject({
    type: "tool_use",
    tool_name: "create_file",
    tool_use_id: "call_1",
    streaming: true,
    input_complete: false,
  });
  // Still incomplete: the Feed must not treat this as a runnable tool row.
  expect((started[0]?.payload as { input?: unknown }).input).toBeUndefined();

  // PI streams one delta per argument fragment; the state changes once, not per fragment.
  const fragment = mapPiSessionEventToAgentEvents(
    {
      type: "message_update",
      assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: 'th":', partial },
    },
    ctx,
  );
  expect(fragment).toHaveLength(0);

  // A second call in the same message is a different state, so it must be announced too.
  const secondPartial = {
    role: "assistant",
    content: [
      partial.content[0],
      { type: "toolCall", id: "call_2", name: "read_file", arguments: {}, partialJson: "{" },
    ],
  };
  const second = mapPiSessionEventToAgentEvents(
    {
      type: "message_update",
      assistantMessageEvent: { type: "toolcall_start", contentIndex: 1, partial: secondPartial },
    },
    ctx,
  );
  expect(second).toHaveLength(1);
  expect((second[0]?.payload as { tool_name?: string }).tool_name).toBe("read_file");

  // A new assistant message resets the announcement set.
  mapPiSessionEventToAgentEvents({ type: "message_end", message: { role: "assistant", content: [] } }, ctx);
  mapPiSessionEventToAgentEvents({ type: "message_start", message: { role: "assistant", content: [] } }, ctx);
  const afterReset = mapPiSessionEventToAgentEvents(
    { type: "message_update", assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, partial } },
    ctx,
  );
  expect(afterReset).toHaveLength(1);
});

test("mapPiSessionEvent ignores a tool call write with no name yet", () => {
  const ctx = makeCtx();
  mapPiSessionEventToAgentEvents({ type: "message_start", message: { role: "assistant", content: [] } }, ctx);
  const unnamed = mapPiSessionEventToAgentEvents(
    {
      type: "message_update",
      assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, partial: { content: [] } },
    },
    ctx,
  );
  expect(unnamed).toHaveLength(0);
});

test("PI thinking close keeps the same reasoningDisplay as the open stream", () => {
  const anthropic = { ...makeCtx(), apiCompat: "anthropic" as const };
  mapPiSessionEventToAgentEvents(
    {
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", delta: "先看 adapter", contentIndex: 0 },
    },
    anthropic,
  );
  const anthropicClose = mapPiSessionEventToAgentEvents(
    {
      type: "tool_execution_start",
      toolCallId: "t1",
      toolName: "bash",
      args: {},
    },
    anthropic,
  );
  const anthropicThinkClose = anthropicClose.find((event) => streamKey(event)?.includes("pi-thinking"));
  expect((anthropicThinkClose?.payload as { reasoningDisplay?: string }).reasoningDisplay).toBe("raw");

  const openai = { ...makeCtx(), apiCompat: "openai_responses" as const };
  mapPiSessionEventToAgentEvents(
    {
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", delta: "定位入口", contentIndex: 0 },
    },
    openai,
  );
  const openaiClose = mapPiSessionEventToAgentEvents(
    {
      type: "tool_execution_start",
      toolCallId: "t1",
      toolName: "bash",
      args: {},
    },
    openai,
  );
  const openaiThinkClose = openaiClose.find((event) => streamKey(event)?.includes("pi-thinking"));
  expect((openaiThinkClose?.payload as { reasoningDisplay?: string }).reasoningDisplay).toBe("summary");
});

test("mapPiSessionEvent surfaces PI compaction lifecycle", () => {
  const start = mapPiSessionEventToAgentEvents({ type: "compaction_start", reason: "threshold" }, makeCtx());
  expect(start).toHaveLength(1);
  expect(start[0]?.type).toBe("context.compaction.started");
  expect(start[0]?.payload).toEqual({ source: "pi", sessionId: "sess_1", reason: "threshold" });

  const done = mapPiSessionEventToAgentEvents(
    {
      type: "compaction_end",
      reason: "threshold",
      aborted: false,
      result: { tokensBefore: 180_000, estimatedTokensAfter: 42_000 },
    },
    makeCtx(),
  );
  expect(done).toHaveLength(1);
  expect(done[0]?.type).toBe("context.compaction.completed");
  expect(done[0]?.payload).toEqual({
    source: "pi",
    sessionId: "sess_1",
    reason: "threshold",
    tokensBefore: 180_000,
    estimatedTokensAfter: 42_000,
  });

  const failed = mapPiSessionEventToAgentEvents(
    {
      type: "compaction_end",
      reason: "overflow",
      aborted: true,
      result: undefined,
      errorMessage: "summary failed",
    },
    makeCtx(),
  );
  expect(failed).toHaveLength(1);
  expect(failed[0]?.type).toBe("context.compaction.failed");
  expect((failed[0]?.payload as { message?: string }).message).toBe("summary failed");

  const abortedNoMessage = mapPiSessionEventToAgentEvents(
    { type: "compaction_end", reason: "threshold", aborted: true, result: undefined },
    makeCtx(),
  );
  expect((abortedNoMessage[0]?.payload as { message?: string }).message).toBe("Compaction aborted.");
});

test("mapPiSessionEvent emits tool_result_error for failed PI tools", () => {
  const ctx = makeCtx();
  mapPiSessionEventToAgentEvents(
    {
      type: "tool_execution_start",
      toolCallId: "tc_edit",
      toolName: "edit",
      args: { path: "panel.ts", oldText: "a", newText: "b" },
    },
    ctx,
  );
  const end = mapPiSessionEventToAgentEvents(
    {
      type: "tool_execution_end",
      toolCallId: "tc_edit",
      toolName: "edit",
      result: { content: [{ type: "text", text: "Found 2 occurrences of the text" }] },
      isError: true,
    },
    ctx,
  );
  expect(end).toHaveLength(1);
  expect(end[0]).toMatchObject({
    type: "tool.failed",
    payload: {
      type: "tool_result_error",
      tool_name: "Edit",
      tool_use_id: "tc_edit",
      message: "Found 2 occurrences of the text",
    },
  });
});

test("mapPiSessionEvent keeps PI's structuredContent on a successful tool result", () => {
  const ctx = makeCtx();
  mapPiSessionEventToAgentEvents(
    { type: "tool_execution_start", toolCallId: "tc_bash", toolName: "bash", args: { command: "ls" } },
    ctx,
  );
  const end = mapPiSessionEventToAgentEvents(
    {
      type: "tool_execution_end",
      toolCallId: "tc_bash",
      toolName: "bash",
      result: {
        content: [{ type: "text", text: "a.txt" }],
        details: {},
        structuredContent: { output: "a.txt", truncated: false, exit_code: 0 },
      },
      isError: false,
    },
    ctx,
  );
  expect(end[0]?.payload).toMatchObject({
    type: "tool_result",
    content: "a.txt",
    structuredContent: { output: "a.txt", truncated: false, exit_code: 0 },
  });
});

test("mapPiSessionEvent links a nested tool call to its parent instead of the subagent key", () => {
  const ctx = makeCtx();
  const start = mapPiSessionEventToAgentEvents(
    {
      type: "tool_execution_start",
      toolCallId: "code_1/1",
      toolName: "read",
      args: { path: "a.txt" },
      parentToolCallId: "code_1",
    },
    ctx,
  );
  expect(start[0]?.payload).toMatchObject({
    type: "tool_use",
    tool_use_id: "code_1/1",
    parent_tool_call_id: "code_1",
  });
  expect(start[0]?.payload).not.toHaveProperty("parent_tool_use_id");

  // A tool end without the field still finds the link captured at start.
  const end = mapPiSessionEventToAgentEvents(
    {
      type: "tool_execution_end",
      toolCallId: "code_1/1",
      toolName: "read",
      result: { content: [{ type: "text", text: "body" }] },
      isError: false,
    },
    ctx,
  );
  expect(end[0]?.payload).toMatchObject({
    type: "tool_result",
    tool_use_id: "code_1/1",
    parent_tool_call_id: "code_1",
  });
});

test("mapPiSessionEvent leaves a top-level tool call without a parent link", () => {
  const ctx = makeCtx();
  const start = mapPiSessionEventToAgentEvents(
    { type: "tool_execution_start", toolCallId: "tc_top", toolName: "bash", args: { command: "ls" } },
    ctx,
  );
  expect(start[0]?.payload).not.toHaveProperty("parent_tool_call_id");
});

test("mapPiSessionEvent emits usage.recorded from message_end", () => {
  const events = mapPiSessionEventToAgentEvents(
    {
      type: "message_end",
      message: {
        role: "assistant",
        model: "eco-alias",
        content: [{ type: "text", text: "done" }],
        usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.002 } },
      },
    },
    makeCtx(),
  );
  expect(events.some((e) => e.type === "message.delta")).toBe(true);
  const usage = events.find((e) => e.type === "usage.recorded");
  expect(usage).toBeTruthy();
  expect((usage?.payload as { source?: string }).source).toBe("pi");
});

test("mapPiSessionEvent emits usage.recorded exactly once — agent_end must not re-emit it", () => {
  const ctx = makeCtx();
  const message = {
    role: "assistant",
    model: "eco-alias",
    content: [{ type: "text", text: "done" }],
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.002 } },
  };
  let usageCount = 0;
  let sawLoopEnded = false;
  const feed = (event: Parameters<typeof mapPiSessionEventToAgentEvents>[0]) => {
    for (const out of mapPiSessionEventToAgentEvents(event, ctx)) {
      if (out.type === "usage.recorded") usageCount += 1;
      if (out.type === "agent.loop_ended") sawLoopEnded = true;
    }
  };
  feed({ type: "message_start", message: { role: "assistant", content: [] } });
  feed({ type: "message_end", message });
  feed({ type: "agent_end", messages: [message] });
  expect(usageCount).toBe(1);
  expect(sawLoopEnded).toBe(true);
});

test("PI feed isolates thinking/text across messages and finalizes streams", () => {
  const ctx = makeCtx();
  const types: string[] = [];
  const keys: string[] = [];

  const feed = (event: Parameters<typeof mapPiSessionEventToAgentEvents>[0]) => {
    for (const out of mapPiSessionEventToAgentEvents(event, ctx)) {
      types.push(out.type);
      const key = streamKey(out);
      if (key) keys.push(`${isFinalize(out) ? "F" : "D"}:${key}`);
    }
  };

  // message 1: thinking then text
  feed({ type: "message_start", message: { role: "assistant", content: [] } });
  feed({
    type: "message_update",
    assistantMessageEvent: { type: "thinking_delta", delta: "reason-1", contentIndex: 0 },
  });
  feed({
    type: "message_update",
    assistantMessageEvent: { type: "thinking_end", content: "reason-1", contentIndex: 0 },
  });
  feed({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: "answer-1", contentIndex: 1 },
  });
  feed({
    type: "message_update",
    assistantMessageEvent: { type: "text_end", content: "answer-1", contentIndex: 1 },
  });
  feed({
    type: "message_end",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "reason-1" },
        { type: "text", text: "answer-1" },
      ],
    },
  });

  // tool barrier
  feed({
    type: "tool_execution_start",
    toolCallId: "t1",
    toolName: "bash",
    args: { command: "ls" },
  });
  feed({
    type: "tool_execution_end",
    toolCallId: "t1",
    toolName: "bash",
    result: "ok",
    isError: false,
  });

  // message 2: new thinking must NOT reuse message-1 stream keys
  feed({ type: "message_start", message: { role: "assistant", content: [] } });
  feed({
    type: "message_update",
    assistantMessageEvent: { type: "thinking_delta", delta: "reason-2", contentIndex: 0 },
  });
  feed({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: "answer-2", contentIndex: 1 },
  });
  feed({
    type: "message_end",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "reason-2" },
        { type: "text", text: "answer-2" },
      ],
    },
  });

  expect(keys.some((k) => k.includes(":m1:"))).toBe(true);
  expect(keys.some((k) => k.includes(":m2:"))).toBe(true);
  // thinking keys for m1 and m2 must differ
  const thinkingKeys = keys.filter((k) => k.includes("pi-thinking"));
  expect(thinkingKeys.some((k) => k.includes(":m1:"))).toBe(true);
  expect(thinkingKeys.some((k) => k.includes(":m2:"))).toBe(true);
  // message_end after stream should not re-dump full answer body as a third text block with body
  const reEmittedBodies = keys.filter((k) => k.startsWith("D:pi-text") && k.includes(":m1:"));
  // only the original text_delta should be non-finalize for m1 text
  expect(reEmittedBodies.length).toBeLessThanOrEqual(1);
  // post tool message-2 open streams finalize on message_end
  expect(keys.some((k) => k.startsWith("F:pi-thinking") && k.includes(":m2:"))).toBe(true);
  expect(keys.some((k) => k.startsWith("F:pi-text") && k.includes(":m2:"))).toBe(true);
  expect(types.includes("tool.started")).toBe(true);
});

test("message_end after streamed text does not re-emit full body", () => {
  const ctx = makeCtx();
  mapPiSessionEventToAgentEvents({ type: "message_start", message: { role: "assistant", content: [] } }, ctx);
  mapPiSessionEventToAgentEvents(
    {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "Hello ", contentIndex: 0 },
    },
    ctx,
  );
  mapPiSessionEventToAgentEvents(
    {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "world", contentIndex: 0 },
    },
    ctx,
  );
  const end = mapPiSessionEventToAgentEvents(
    {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Hello world" }],
      },
    },
    ctx,
  );
  const withBody = end.filter(
    (e) =>
      e.type === "message.delta" &&
      isRecord(e.payload) &&
      e.payload.blockKind === "text" &&
      typeof e.payload.text === "string" &&
      e.payload.text.length > 0,
  );
  expect(withBody).toHaveLength(0);
  expect(end.some((e) => isFinalize(e))).toBe(true);
});

test("PI planner agentId is session id; non-assistant message_start does not burn generation", () => {
  const ctx = makeCtx();
  mapPiSessionEventToAgentEvents({ type: "message_start", message: { role: "assistant", content: [] } }, ctx);
  const events = mapPiSessionEventToAgentEvents(
    {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "hi", contentIndex: 0 },
    },
    ctx,
  );
  expect(events[0]?.agentId).toBe("sess_1");
  // Tool-result-like non-assistant message_start must not burn a generation.
  const before = ctx.state.messageSeq;
  mapPiSessionEventToAgentEvents(
    { type: "message_start", message: { role: "toolResult", content: [] } },
    ctx,
  );
  expect(ctx.state.messageSeq).toBe(before);
});

test("buildEcoPiModel rejects non-HTTP base URLs", () => {
  expect(() =>
    buildEcoPiModel({
      bridgeBaseUrl: "not-a-url",
      bridgeModelId: "eco_planner__p1__m",
    }),
  ).toThrow(/HTTP/);
});

test("buildEcoPiModel contextWindow is min(model, global)", () => {
  expect(
    buildEcoPiModel({
      bridgeBaseUrl: "http://127.0.0.1:18765",
      bridgeModelId: "alias-1m",
      contextWindow: 1_000_000,
      globalContextWindowLimit: 262_144,
    }).contextWindow,
  ).toBe(262_144);
});

test("buildEcoPiModel keeps a model window smaller than the global cap", () => {
  expect(
    buildEcoPiModel({
      bridgeBaseUrl: "http://127.0.0.1:18765",
      bridgeModelId: "alias-128k",
      contextWindow: 128_000,
      globalContextWindowLimit: 262_144,
    }).contextWindow,
  ).toBe(128_000);
});

test("buildEcoPiModel honors disabled vision for every API face", () => {
  for (const apiCompat of ["anthropic", "openai_responses", "openai_chat_completions"] as const) {
    const input = { bridgeBaseUrl: "http://127.0.0.1:18765", bridgeModelId: "alias", apiCompat };
    expect(buildEcoPiModel({ ...input, supportsImageInput: false }).input).toEqual(["text"]);
    expect(buildEcoPiModel({ ...input, supportsImageInput: true }).input).toEqual(["text", "image"]);
  }
});

test("buildEcoPiModel maps apiCompat to Pi api / auth provider", () => {
  const anthropic = buildEcoPiModel({
    bridgeBaseUrl: "http://127.0.0.1:18765",
    bridgeModelId: "alias-a",
    apiCompat: "anthropic",
  });
  expect(anthropic.api).toBe("anthropic-messages");
  expect(anthropic.provider).toBe("anthropic");

  const responses = buildEcoPiModel({
    bridgeBaseUrl: "http://127.0.0.1:18765",
    bridgeModelId: "alias-r",
    apiCompat: "openai_responses",
  });
  expect(responses.api).toBe("openai-responses");
  expect(responses.provider).toBe("openai");

  const chat = buildEcoPiModel({
    bridgeBaseUrl: "http://127.0.0.1:18765",
    bridgeModelId: "alias-c",
    apiCompat: "openai_chat_completions",
  });
  expect(chat.api).toBe("openai-completions");
  expect(chat.provider).toBe("openai");
});

test("mapEcoThinkingEffortToPiThinkingLevel maps Eco effort 1:1 and fail-closes unknown to off", () => {
  expect(mapEcoThinkingEffortToPiThinkingLevel(undefined)).toBe("off");
  expect(mapEcoThinkingEffortToPiThinkingLevel("off")).toBe("off");
  expect(mapEcoThinkingEffortToPiThinkingLevel("low")).toBe("low");
  expect(mapEcoThinkingEffortToPiThinkingLevel("medium")).toBe("medium");
  expect(mapEcoThinkingEffortToPiThinkingLevel("high")).toBe("high");
  expect(mapEcoThinkingEffortToPiThinkingLevel("xhigh")).toBe("xhigh");
  expect(mapEcoThinkingEffortToPiThinkingLevel("max")).toBe("max");
  expect(mapEcoThinkingEffortToPiThinkingLevel("ultra")).toBe("off");
});

test("buildEcoPiModel enables PI reasoning only when route thinkingEffort is on", () => {
  const base = {
    bridgeBaseUrl: "http://127.0.0.1:18765",
    bridgeModelId: "alias-r",
    apiCompat: "openai_responses" as const,
  };
  expect(buildEcoPiModel(base).reasoning).toBe(false);
  expect(
    buildEcoPiModel({
      ...base,
      route: {
        role: "planner",
        providerId: "p",
        modelId: "grok-4.5",
        primary: { modelId: "grok-4.5" },
        fallbacks: [],
        thinkingEffort: "off",
      },
    }).reasoning,
  ).toBe(false);
  expect(
    buildEcoPiModel({
      ...base,
      route: {
        role: "planner",
        providerId: "p",
        modelId: "grok-4.5",
        primary: { modelId: "grok-4.5" },
        fallbacks: [],
        thinkingEffort: "high",
      },
    }).reasoning,
  ).toBe(true);
});

test("buildEcoPiModel does not enable supportsMidConvoEffort (Gateway is not faithful Anthropic)", () => {
  const model = buildEcoPiModel({
    bridgeBaseUrl: "http://127.0.0.1:18765",
    bridgeModelId: "claude-alias",
    apiCompat: "anthropic",
    route: {
      role: "planner",
      providerId: "anthropic",
      modelId: "claude-opus-4",
      primary: { modelId: "claude-opus-4" },
      fallbacks: [],
      thinkingEffort: "high",
    },
  });
  expect(model.reasoning).toBe(true);
  expect(model.compat?.supportsMidConvoEffort).toBeUndefined();
  expect(model.compat).toBeUndefined();
});

test("buildEcoPiModel opts in xhigh/max so PI does not clamp max thinking to high", () => {
  const model = buildEcoPiModel({
    bridgeBaseUrl: "http://127.0.0.1:18765",
    bridgeModelId: "alias-r",
    apiCompat: "openai_responses",
    route: {
      role: "planner",
      providerId: "p",
      modelId: "gpt-5.6-luna",
      primary: { modelId: "gpt-5.6-luna" },
      fallbacks: [],
      thinkingEffort: "max",
    },
  });
  expect(model.thinkingLevelMap).toEqual({ xhigh: "xhigh", max: "max" });
  expect(clampThinkingLevel(model, "max")).toBe("max");
  expect(clampThinkingLevel(model, "xhigh")).toBe("xhigh");
});

test("computePiRouteFingerprint includes thinkingEffort so changing it rebuilds the PI session", () => {
  const base = {
    cwd: "/w",
    providerId: "p",
    modelId: "alias",
    apiCompat: "openai_responses" as const,
    baseUrl: "http://127.0.0.1:18765",
    bindingId: "",
  };
  const planner = {
    role: "planner" as const,
    providerId: "p",
    modelId: "grok-4.5",
    primary: { modelId: "grok-4.5" },
    fallbacks: [],
  };
  const unset = computePiRouteFingerprint({
    ...base,
    routes: [{ ...planner }],
  });
  const off = computePiRouteFingerprint({
    ...base,
    routes: [{ ...planner, thinkingEffort: "off" }],
  });
  const high = computePiRouteFingerprint({
    ...base,
    routes: [{ ...planner, thinkingEffort: "high" }],
  });
  expect(unset).toBe(off);
  expect(off).not.toContain(":te=");
  expect(off).not.toContain(":tlmap=");
  expect(high).toContain(":te=high");
  expect(high).toContain(":tlmap=xhigh,max");
  expect(off).not.toBe(high);
});

test("agent_end is not run terminal; agent_settled is settle-only", () => {
  const end = mapPiSessionEventToAgentEvents(
    { type: "agent_end", messages: [], willRetry: false },
    makeCtx(),
  );
  expect(end.some((e) => e.type === "agent.loop_ended")).toBe(true);
  expect(end.some((e) => e.type === "agent.completed")).toBe(false);
  expect(end.some((e) => e.type === "run.terminal")).toBe(false);

  const settled = mapPiSessionEventToAgentEvents({ type: "agent_settled" }, makeCtx());
  expect(settled.some((e) => e.type === "agent.settled")).toBe(true);
  expect(settled.some((e) => e.type === "run.terminal")).toBe(false);
});

test("decidePiPromptRunTerminal: only agent_settled may complete", () => {
  expect(
    decidePiPromptRunTerminal({
      sawAgentSettled: true,
      aborted: false,
      promptReturned: true,
    }),
  ).toEqual({ status: "completed" });

  expect(
    decidePiPromptRunTerminal({
      sawAgentSettled: false,
      aborted: false,
      promptReturned: true,
    }),
  ).toEqual({
    status: "incomplete",
    reason: "PI prompt returned without agent_settled.",
  });

  expect(
    decidePiPromptRunTerminal({
      sawAgentSettled: false,
      aborted: false,
      promptReturned: false,
      errorMessage: "boom",
    }),
  ).toEqual({ status: "failed", error: "boom" });

  expect(
    decidePiPromptRunTerminal({
      sawAgentSettled: true,
      aborted: false,
      promptReturned: true,
      errorMessage: "Our servers are currently overloaded. Please try again later.",
    }),
  ).toEqual({
    status: "failed",
    error: "Our servers are currently overloaded. Please try again later.",
  });

  expect(
    decidePiPromptRunTerminal({
      sawAgentSettled: true,
      aborted: true,
      promptReturned: false,
    }),
  ).toEqual({ status: "cancelled", reason: "cancelled by user" });

  // prompt done must NEVER invent completed without settle
  const fakeSuccess = decidePiPromptRunTerminal({
    sawAgentSettled: false,
    aborted: false,
    promptReturned: true,
  });
  expect(fakeSuccess?.status).not.toBe("completed");
});

test("readPiAssistantErrorMessage extracts stopReason error from PI message_end", () => {
  expect(
    readPiAssistantErrorMessage({
      type: "message_end",
      message: {
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage: "Our servers are currently overloaded. Please try again later.",
      },
    }),
  ).toBe("Our servers are currently overloaded. Please try again later.");
  expect(
    readPiAssistantErrorMessage({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop" },
    }),
  ).toBeUndefined();
});

test("applyPiAssistantErrorTracker keeps overloaded error until a later success", () => {
  const errorEvent = {
    type: "message_end",
    message: {
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: "Our servers are currently overloaded. Please try again later.",
    },
  };
  const tracked = applyPiAssistantErrorTracker(errorEvent, undefined);
  expect(tracked).toBe("Our servers are currently overloaded. Please try again later.");
  expect(
    applyPiAssistantErrorTracker(
      {
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop" },
      },
      tracked,
    ),
  ).toBeUndefined();
});

test("mapPiSessionEvent maps PI auto_retry_start to Claude-shaped api_retry status", () => {
  const events = mapPiSessionEventToAgentEvents(
    { type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: "overloaded" },
    makeCtx(),
  );
  expect(events).toHaveLength(1);
  expect(events[0]?.type).toBe("agent.started");
  expect(events[0]?.payload).toEqual({
    type: "system",
    subtype: "api_retry",
    attempt: 1,
    max_retries: 3,
  });
});

test("ECO_PI_SESSION_RETRY keeps agent retries on and provider fetch retries off", () => {
  expect(ECO_PI_SESSION_RETRY).toEqual({
    enabled: true,
    maxRetries: 3,
    provider: { maxRetries: 0 },
  });
});

test("PiSessionRegistry isolates sessions and PiCodingAgentDriver streams events", async () => {
  const registry = new PiSessionRegistry();
  const eventsA: AgentEvent[] = [];
  const eventsB: AgentEvent[] = [];
  let createCount = 0;

  const makeHandle = (
    id: string,
    cwd: string,
    routeFingerprint: string,
    mcpFingerprint = "",
    sessionFile?: string,
  ): PiSessionHandle => ({
    sessionId: id,
    ...(sessionFile ? { sessionFile } : {}),
    cwd,
    routeFingerprint,
    bindingId: `bind_${id}`,
    skillsFingerprint: "",
    mcpFingerprint,
    abort: async () => {},
    dispose: () => {},
    isStreaming: () => false,
    steer: async () => {},
    rebind: async (input) => {
      // keep shape for driver rebind path
      void input;
    },
    updateSkillPaths: async () => {},
    async *prompt(text: string): AsyncIterable<AgentEvent> {
      yield {
        id: `${id}:msg`,
        threadId: "unused",
        agentId: id,
        role: "planner",
        type: "message.delta",
        payload: { type: "eco_stream", blockKind: "text", text: `echo:${text}` },
        createdAt: new Date().toISOString(),
      } as AgentEvent;
    },
  });

  const createInputs: Array<{
    sessionFile?: string;
    replacePersistedSessions?: boolean;
  }> = [];

  const driver = new PiCodingAgentDriver(
    {
      createSession: async (input) => {
        createCount += 1;
        createInputs.push({
          ...(input.sessionFile ? { sessionFile: input.sessionFile } : {}),
          ...(input.replacePersistedSessions ? { replacePersistedSessions: true } : {}),
        });
        const { fingerprintPiMcpServers } = await import("../src/pi-mcp");
        return makeHandle(
          `sess_${input.threadId}_${createCount}`,
          input.cwd,
          input.routeFingerprint,
          fingerprintPiMcpServers(input.mcpServers),
          input.sessionFile ?? `/tmp/${input.threadId}_${createCount}.jsonl`,
        );
      },
      resolveBridgeModel: async () => ({
        bridgeBaseUrl: "http://127.0.0.1:18765",
        bridgeModelId: "alias",
        apiKey: "k",
        agentDir: "/tmp/pi",
        apiCompat: "anthropic",
        bindingId: "cbb_test",
        providerId: "p",
      }),
    },
    registry,
  );

  const routes = [
    {
      role: "planner" as const,
      providerId: "p",
      modelId: "m",
      primary: { modelId: "m", contextWindow: 100_000 },
    },
  ];

  for await (const event of driver.run({
    threadId: "t1",
    prompt: "a",
    workspacePath: "/w1",
    worktreePath: "/w1",
    routes,
    signal: new AbortController().signal,
    piSession: { mcpServers: { github: { command: "uvx" } } },
  })) {
    eventsA.push(event);
  }
  for await (const event of driver.run({
    threadId: "t2",
    prompt: "b",
    workspacePath: "/w2",
    worktreePath: "/w2",
    routes,
    signal: new AbortController().signal,
    piSession: { mcpServers: { slack: { command: "npx" } } },
  })) {
    eventsB.push(event);
  }

  expect(registry.get("t1")?.sessionId).toBe("sess_t1_1");
  expect(registry.get("t2")?.sessionId).toBe("sess_t2_2");
  expect(registry.get("t1")?.mcpFingerprint).not.toBe(registry.get("t2")?.mcpFingerprint);
  expect(eventsA.some((e) => e.type === "session.captured")).toBe(true);
  expect(eventsB.some((e) => e.type === "session.captured")).toBe(true);

  // Same MCP set reuses session; changed MCP recreates AgentSession but keeps JSONL.
  const beforeReuse = createCount;
  for await (const _ of driver.run({
    threadId: "t1",
    prompt: "a2",
    workspacePath: "/w1",
    worktreePath: "/w1",
    routes,
    signal: new AbortController().signal,
    piSession: { mcpServers: { github: { command: "uvx" } } },
  })) {
    // drain
  }
  expect(createCount).toBe(beforeReuse);
  expect(registry.get("t1")?.sessionId).toBe("sess_t1_1");
  const keptSessionFile = registry.get("t1")?.sessionFile;

  for await (const _ of driver.run({
    threadId: "t1",
    prompt: "a3",
    workspacePath: "/w1",
    worktreePath: "/w1",
    routes,
    signal: new AbortController().signal,
    piSession: {
      mcpServers: { github: { command: "uvx" }, extra: { command: "true" } },
      sessionFile: keptSessionFile,
    },
  })) {
    // drain
  }
  expect(createCount).toBe(beforeReuse + 1);
  expect(registry.get("t1")?.sessionId).toBe("sess_t1_3");
  expect(createInputs[createInputs.length - 1]?.replacePersistedSessions).not.toBe(true);
  expect(createInputs[createInputs.length - 1]?.sessionFile).toBe(keptSessionFile);

  registry.delete("t1");
  expect(registry.get("t1")).toBeUndefined();

  // Cold start with matching fingerprints opens sessionFile.
  const { computePiSessionIdentityFingerprint } = await import("../src/pi-coding-agent-driver");
  const { fingerprintPiMcpServers } = await import("../src/pi-mcp");
  const identity = computePiSessionIdentityFingerprint({
    cwd: "/w1",
    providerId: "p",
    modelId: "alias",
    apiCompat: "anthropic",
    baseUrl: "http://127.0.0.1:18765",
    routes,
  });
  const mcpFp = fingerprintPiMcpServers({ github: { command: "uvx" } });
  const resumePath = "/tmp/pi-resume-t1.jsonl";
  for await (const _ of driver.run({
    threadId: "t1",
    prompt: "resume",
    workspacePath: "/w1",
    worktreePath: "/w1",
    routes,
    signal: new AbortController().signal,
    piSession: {
      mcpServers: { github: { command: "uvx" } },
      sessionFile: resumePath,
      resumeIdentityFingerprint: identity,
      resumeMcpFingerprint: mcpFp,
    },
  })) {
    // drain
  }
  expect(createInputs[createInputs.length - 1]?.sessionFile).toBe(resumePath);
  expect(createInputs[createInputs.length - 1]?.replacePersistedSessions).toBeUndefined();
  registry.delete("t1");

  // Cold start with mismatched MCP still opens the existing JSONL (conversation ≠ MCP).
  for await (const _ of driver.run({
    threadId: "t1",
    prompt: "fresh",
    workspacePath: "/w1",
    worktreePath: "/w1",
    routes,
    signal: new AbortController().signal,
    piSession: {
      mcpServers: { github: { command: "uvx" }, extra: { command: "true" } },
      sessionFile: resumePath,
      resumeIdentityFingerprint: identity,
      resumeMcpFingerprint: mcpFp,
    },
  })) {
    // drain
  }
  expect(createInputs[createInputs.length - 1]?.sessionFile).toBe(resumePath);
  expect(createInputs[createInputs.length - 1]?.replacePersistedSessions).not.toBe(true);
  registry.delete("t1");

  // Cold start with mismatched identity still opens the existing JSONL
  // (fingerprints rebuild AgentSession; they must not wipe transcript).
  for await (const _ of driver.run({
    threadId: "t1",
    prompt: "identity-drift",
    workspacePath: "/w1",
    worktreePath: "/w1",
    routes,
    signal: new AbortController().signal,
    piSession: {
      mcpServers: { github: { command: "uvx" } },
      sessionFile: resumePath,
      resumeIdentityFingerprint: "stale-identity-fingerprint",
      resumeMcpFingerprint: mcpFp,
    },
  })) {
    // drain
  }
  expect(createInputs[createInputs.length - 1]?.sessionFile).toBe(resumePath);
  expect(createInputs[createInputs.length - 1]?.replacePersistedSessions).not.toBe(true);
});

test("token-only MCP env change reuses registry session", async () => {
  const registry = new PiSessionRegistry();
  let createCount = 0;
  const createInputs: Array<{
    sessionFile?: string;
    replacePersistedSessions?: boolean;
  }> = [];

  const makeHandle = (
    id: string,
    cwd: string,
    routeFingerprint: string,
    mcpFingerprint = "",
    sessionFile?: string,
  ): PiSessionHandle => ({
    sessionId: id,
    ...(sessionFile ? { sessionFile } : {}),
    cwd,
    routeFingerprint,
    bindingId: `bind_${id}`,
    skillsFingerprint: "",
    mcpFingerprint,
    abort: async () => {},
    dispose: () => {},
    isStreaming: () => false,
    steer: async () => {},
    rebind: async (input) => {
      void input;
    },
    updateSkillPaths: async () => {},
    async *prompt(text: string): AsyncIterable<AgentEvent> {
      yield {
        id: `${id}:msg`,
        threadId: "unused",
        agentId: id,
        role: "planner",
        type: "message.delta",
        payload: { type: "eco_stream", blockKind: "text", text: `echo:${text}` },
        createdAt: new Date().toISOString(),
      } as AgentEvent;
    },
  });

  const driver = new PiCodingAgentDriver(
    {
      createSession: async (input) => {
        createCount += 1;
        createInputs.push({
          ...(input.sessionFile ? { sessionFile: input.sessionFile } : {}),
          ...(input.replacePersistedSessions ? { replacePersistedSessions: true } : {}),
        });
        const { fingerprintPiMcpServers } = await import("../src/pi-mcp");
        return makeHandle(
          `sess_${input.threadId}_${createCount}`,
          input.cwd,
          input.routeFingerprint,
          fingerprintPiMcpServers(input.mcpServers),
          input.sessionFile ?? `/tmp/${input.threadId}_${createCount}.jsonl`,
        );
      },
      resolveBridgeModel: async () => ({
        bridgeBaseUrl: "http://127.0.0.1:18765",
        bridgeModelId: "alias",
        apiKey: "k",
        agentDir: "/tmp/pi",
        apiCompat: "anthropic",
        bindingId: "cbb_test",
        providerId: "p",
      }),
    },
    registry,
  );

  const routes = [
    {
      role: "planner" as const,
      providerId: "p",
      modelId: "m",
      primary: { modelId: "m", contextWindow: 100_000 },
    },
  ];

  const serversA = {
    eco_agent_browser: {
      command: "node",
      args: ["b.mjs"],
      env: { ECO_BROWSER_AUTH_TOKEN: "a", ELECTRON_RUN_AS_NODE: "1" },
    },
  };
  const serversB = {
    eco_agent_browser: {
      command: "node",
      args: ["b.mjs"],
      env: { ECO_BROWSER_AUTH_TOKEN: "b", ELECTRON_RUN_AS_NODE: "1" },
    },
  };

  for await (const _ of driver.run({
    threadId: "t_token",
    prompt: "1",
    workspacePath: "/w",
    worktreePath: "/w",
    routes,
    signal: new AbortController().signal,
    piSession: { mcpServers: serversA },
  })) {
    // drain
  }
  const before = createCount;
  const sid = registry.get("t_token")?.sessionId;

  for await (const _ of driver.run({
    threadId: "t_token",
    prompt: "2",
    workspacePath: "/w",
    worktreePath: "/w",
    routes,
    signal: new AbortController().signal,
    piSession: { mcpServers: serversB },
  })) {
    // drain
  }

  expect(createCount).toBe(before);
  expect(registry.get("t_token")?.sessionId).toBe(sid);
  expect(createInputs[createInputs.length - 1]?.replacePersistedSessions).toBeUndefined();
});

test("inherited spawn env in live MCP config does not recreate or clear JSONL", async () => {
  const registry = new PiSessionRegistry();
  let createCount = 0;
  const createInputs: Array<{
    sessionFile?: string;
    replacePersistedSessions?: boolean;
  }> = [];

  const makeHandle = (
    id: string,
    cwd: string,
    routeFingerprint: string,
    mcpFingerprint = "",
    sessionFile?: string,
  ): PiSessionHandle => ({
    sessionId: id,
    ...(sessionFile ? { sessionFile } : {}),
    cwd,
    routeFingerprint,
    bindingId: `bind_${id}`,
    skillsFingerprint: "",
    mcpFingerprint,
    abort: async () => {},
    dispose: () => {},
    isStreaming: () => false,
    steer: async () => {},
    rebind: async (input) => {
      void input;
    },
    updateSkillPaths: async () => {},
    async *prompt(text: string): AsyncIterable<AgentEvent> {
      yield {
        id: `${id}:msg`,
        threadId: "unused",
        agentId: id,
        role: "planner",
        type: "message.delta",
        payload: { type: "eco_stream", blockKind: "text", text: `echo:${text}` },
        createdAt: new Date().toISOString(),
      } as AgentEvent;
    },
  });

  const driver = new PiCodingAgentDriver(
    {
      createSession: async (input) => {
        createCount += 1;
        createInputs.push({
          ...(input.sessionFile ? { sessionFile: input.sessionFile } : {}),
          ...(input.replacePersistedSessions ? { replacePersistedSessions: true } : {}),
        });
        const { fingerprintPiMcpServers } = await import("../src/pi-mcp");
        return makeHandle(
          `sess_${input.threadId}_${createCount}`,
          input.cwd,
          input.routeFingerprint,
          fingerprintPiMcpServers(input.mcpServers),
          input.sessionFile ?? `/tmp/${input.threadId}_${createCount}.jsonl`,
        );
      },
      resolveBridgeModel: async () => ({
        bridgeBaseUrl: "http://127.0.0.1:18765",
        bridgeModelId: "alias",
        apiKey: "k",
        agentDir: "/tmp/pi",
        apiCompat: "anthropic",
        bindingId: "cbb_test",
        providerId: "p",
      }),
    },
    registry,
  );

  const routes = [
    {
      role: "planner" as const,
      providerId: "p",
      modelId: "m",
      primary: { modelId: "m", contextWindow: 100_000 },
    },
  ];

  const parentEnv = {
    eco_image_view: {
      command: "Electron",
      args: ["stdio.mjs"],
      env: {
        PI_CODING_AGENT_DIR: "/tmp/parent",
        ECO_IMAGE_VIEW_CONTROL_URL: "http://127.0.0.1:1111",
        PATH: "/usr/bin",
      },
    },
  };
  const subagentPoisonedEnv = {
    eco_image_view: {
      command: "Electron",
      args: ["stdio.mjs"],
      env: {
        PI_CODING_AGENT_DIR: "/tmp/parent/subagents/coder",
        ECO_IMAGE_VIEW_CONTROL_URL: "http://127.0.0.1:2222",
        PATH: "/usr/bin:/opt/homebrew/bin",
      },
    },
  };

  for await (const _ of driver.run({
    threadId: "t_env",
    prompt: "1",
    workspacePath: "/w",
    worktreePath: "/w",
    routes,
    signal: new AbortController().signal,
    piSession: { mcpServers: parentEnv },
  })) {
    // drain
  }
  const before = createCount;
  const sid = registry.get("t_env")?.sessionId;
  const sessionFile = registry.get("t_env")?.sessionFile;

  for await (const _ of driver.run({
    threadId: "t_env",
    prompt: "2",
    workspacePath: "/w",
    worktreePath: "/w",
    routes,
    signal: new AbortController().signal,
    piSession: { mcpServers: subagentPoisonedEnv, sessionFile },
  })) {
    // drain
  }

  expect(createCount).toBe(before);
  expect(registry.get("t_env")?.sessionId).toBe(sid);
  expect(createInputs.at(-1)?.replacePersistedSessions).not.toBe(true);
});

test("legacy resumeMcpFingerprint with embedded token still disk-resumes", async () => {
  const registry = new PiSessionRegistry();
  let createCount = 0;
  const createInputs: Array<{
    sessionFile?: string;
    replacePersistedSessions?: boolean;
  }> = [];

  const makeHandle = (
    id: string,
    cwd: string,
    routeFingerprint: string,
    mcpFingerprint = "",
    sessionFile?: string,
  ): PiSessionHandle => ({
    sessionId: id,
    ...(sessionFile ? { sessionFile } : {}),
    cwd,
    routeFingerprint,
    bindingId: `bind_${id}`,
    skillsFingerprint: "",
    mcpFingerprint,
    abort: async () => {},
    dispose: () => {},
    isStreaming: () => false,
    steer: async () => {},
    rebind: async (input) => {
      void input;
    },
    updateSkillPaths: async () => {},
    async *prompt(text: string): AsyncIterable<AgentEvent> {
      yield {
        id: `${id}:msg`,
        threadId: "unused",
        agentId: id,
        role: "planner",
        type: "message.delta",
        payload: { type: "eco_stream", blockKind: "text", text: `echo:${text}` },
        createdAt: new Date().toISOString(),
      } as AgentEvent;
    },
  });

  const driver = new PiCodingAgentDriver(
    {
      createSession: async (input) => {
        createCount += 1;
        createInputs.push({
          ...(input.sessionFile ? { sessionFile: input.sessionFile } : {}),
          ...(input.replacePersistedSessions ? { replacePersistedSessions: true } : {}),
        });
        const { fingerprintPiMcpServers } = await import("../src/pi-mcp");
        return makeHandle(
          `sess_${input.threadId}_${createCount}`,
          input.cwd,
          input.routeFingerprint,
          fingerprintPiMcpServers(input.mcpServers),
          input.sessionFile ?? `/tmp/${input.threadId}_${createCount}.jsonl`,
        );
      },
      resolveBridgeModel: async () => ({
        bridgeBaseUrl: "http://127.0.0.1:18765",
        bridgeModelId: "alias",
        apiKey: "k",
        agentDir: "/tmp/pi",
        apiCompat: "anthropic",
        bindingId: "cbb_test",
        providerId: "p",
      }),
    },
    registry,
  );

  const routes = [
    {
      role: "planner" as const,
      providerId: "p",
      modelId: "m",
      primary: { modelId: "m", contextWindow: 100_000 },
    },
  ];

  const serversA = {
    eco_agent_browser: {
      command: "node",
      args: ["b.mjs"],
      env: { ECO_BROWSER_AUTH_TOKEN: "a", ELECTRON_RUN_AS_NODE: "1" },
    },
  };
  const serversB = {
    eco_agent_browser: {
      command: "node",
      args: ["b.mjs"],
      env: { ECO_BROWSER_AUTH_TOKEN: "b", ELECTRON_RUN_AS_NODE: "1" },
    },
  };

  const { computePiSessionIdentityFingerprint } = await import("../src/pi-coding-agent-driver");
  const identity = computePiSessionIdentityFingerprint({
    cwd: "/w",
    providerId: "p",
    modelId: "alias",
    apiCompat: "anthropic",
    baseUrl: "http://127.0.0.1:18765",
    routes,
  });
  // Legacy fingerprint: raw JSON with embedded auth token (pre-strip era).
  const legacyMcpFp = JSON.stringify([["eco_agent_browser", serversA.eco_agent_browser]]);
  const resumePath = "/tmp/pi-resume-t_token.jsonl";

  for await (const _ of driver.run({
    threadId: "t_token",
    prompt: "resume",
    workspacePath: "/w",
    worktreePath: "/w",
    routes,
    signal: new AbortController().signal,
    piSession: {
      mcpServers: serversB,
      sessionFile: resumePath,
      resumeIdentityFingerprint: identity,
      resumeMcpFingerprint: legacyMcpFp,
    },
  })) {
    // drain
  }

  expect(createInputs.at(-1)?.sessionFile).toBe(resumePath);
  expect(createInputs.at(-1)?.replacePersistedSessions).not.toBe(true);
  expect(createCount).toBe(1);
});

test("PiCodingAgentDriver injects eco-pi-approval and re-arms handler on session reuse", async () => {
  const registry = new PiSessionRegistry();
  const captured: Array<{ names: string[] }> = [];
  let createCount = 0;
  const handlers: Array<SdkToolPermissionHandler | undefined> = [];

  const makeHandle = (
    id: string,
    cwd: string,
    routeFingerprint: string,
    mcpFingerprint = "",
    sessionFile?: string,
  ): PiSessionHandle => ({
    sessionId: id,
    ...(sessionFile ? { sessionFile } : {}),
    cwd,
    routeFingerprint,
    bindingId: `bind_${id}`,
    skillsFingerprint: "",
    mcpFingerprint,
    abort: async () => {},
    dispose: () => {},
    isStreaming: () => false,
    steer: async () => {},
    rebind: async (input) => {
      void input;
    },
    updateSkillPaths: async () => {},
    async *prompt(text: string): AsyncIterable<AgentEvent> {
      yield {
        id: `${id}:msg`,
        threadId: "unused",
        agentId: id,
        role: "planner",
        type: "message.delta",
        payload: { type: "eco_stream", blockKind: "text", text: `echo:${text}` },
        createdAt: new Date().toISOString(),
      } as AgentEvent;
    },
  });

  const driver = new PiCodingAgentDriver(
    {
      createSession: async (input) => {
        createCount += 1;
        captured.push({
          names: (input.extensionFactories ?? []).map((e) => e.name),
        });
        const handle = makeHandle(
          `sess_${input.threadId}_${createCount}`,
          input.cwd,
          input.routeFingerprint,
          "",
          input.sessionFile ?? `/tmp/${input.threadId}_${createCount}.jsonl`,
        ) as PiSessionHandle & {
          toolApprovalEnabled?: boolean;
          armToolPermission?: (handler: SdkToolPermissionHandler | undefined) => void;
        };
        handle.toolApprovalEnabled = Boolean(
          (input as { toolPermissionHandler?: unknown }).toolPermissionHandler,
        );
        handle.armToolPermission = (handler) => {
          handlers.push(handler);
        };
        return handle;
      },
      resolveBridgeModel: async () => ({
        bridgeBaseUrl: "http://127.0.0.1:18765",
        bridgeModelId: "alias",
        apiKey: "k",
        agentDir: "/tmp/pi",
        apiCompat: "anthropic",
        bindingId: "cbb_test",
        providerId: "p",
      }),
    },
    registry,
  );

  const routes = [
    {
      role: "planner" as const,
      providerId: "p",
      modelId: "m",
      primary: { modelId: "m", contextWindow: 100_000 },
    },
  ];

  const allow: SdkToolPermissionHandler = async () => ({ behavior: "allow" });
  const deny: SdkToolPermissionHandler = async () => ({
    behavior: "deny",
    message: "no",
  });

  for await (const _ of driver.run({
    threadId: "thr_perm",
    prompt: "hi",
    workspacePath: "/w1",
    worktreePath: "/w1",
    routes,
    signal: new AbortController().signal,
    piSession: { toolPermissionHandler: allow },
  } as never)) {
    void _;
  }
  expect(createCount).toBe(1);
  expect(captured[0]?.names).toContain("eco-pi-approval");

  const reused = registry.get("thr_perm") as
    | (PiSessionHandle & {
        armToolPermission?: (handler: SdkToolPermissionHandler | undefined) => void;
      })
    | undefined;
  const previousArm = reused?.armToolPermission;
  if (reused) {
    reused.armToolPermission = (handler) => {
      handlers.push(handler);
      previousArm?.(handler);
    };
  }

  for await (const _ of driver.run({
    threadId: "thr_perm",
    prompt: "hi2",
    workspacePath: "/w1",
    worktreePath: "/w1",
    routes,
    signal: new AbortController().signal,
    piSession: { toolPermissionHandler: deny },
  } as never)) {
    void _;
  }
  expect(createCount).toBe(1);
  expect(handlers.length).toBeGreaterThan(0);
  expect(handlers.at(-1)).toBe(deny);
});

test("PiCodingAgentDriver recreates session when tool approval presence drifts", async () => {
  const registry = new PiSessionRegistry();
  const captured: Array<{ names: string[] }> = [];
  let createCount = 0;

  const makeHandle = (
    id: string,
    cwd: string,
    routeFingerprint: string,
    mcpFingerprint = "",
    sessionFile?: string,
  ): PiSessionHandle => ({
    sessionId: id,
    ...(sessionFile ? { sessionFile } : {}),
    cwd,
    routeFingerprint,
    bindingId: `bind_${id}`,
    skillsFingerprint: "",
    mcpFingerprint,
    abort: async () => {},
    dispose: () => {},
    isStreaming: () => false,
    steer: async () => {},
    rebind: async (input) => {
      void input;
    },
    updateSkillPaths: async () => {},
    async *prompt(text: string): AsyncIterable<AgentEvent> {
      yield {
        id: `${id}:msg`,
        threadId: "unused",
        agentId: id,
        role: "planner",
        type: "message.delta",
        payload: { type: "eco_stream", blockKind: "text", text: `echo:${text}` },
        createdAt: new Date().toISOString(),
      } as AgentEvent;
    },
  });

  const driver = new PiCodingAgentDriver(
    {
      createSession: async (input) => {
        createCount += 1;
        captured.push({
          names: (input.extensionFactories ?? []).map((e) => e.name),
        });
        const handle = makeHandle(
          `sess_${input.threadId}_${createCount}`,
          input.cwd,
          input.routeFingerprint,
          "",
          input.sessionFile ?? `/tmp/${input.threadId}_${createCount}.jsonl`,
        ) as PiSessionHandle & { toolApprovalEnabled?: boolean };
        handle.toolApprovalEnabled = Boolean(
          (input as { toolPermissionHandler?: unknown }).toolPermissionHandler,
        );
        return handle;
      },
      resolveBridgeModel: async () => ({
        bridgeBaseUrl: "http://127.0.0.1:18765",
        bridgeModelId: "alias",
        apiKey: "k",
        agentDir: "/tmp/pi",
        apiCompat: "anthropic",
        bindingId: "cbb_test",
        providerId: "p",
      }),
    },
    registry,
  );

  const routes = [
    {
      role: "planner" as const,
      providerId: "p",
      modelId: "m",
      primary: { modelId: "m", contextWindow: 100_000 },
    },
  ];

  const allow: SdkToolPermissionHandler = async () => ({ behavior: "allow" });

  for await (const _ of driver.run({
    threadId: "thr_perm_drift",
    prompt: "hi",
    workspacePath: "/w1",
    worktreePath: "/w1",
    routes,
    signal: new AbortController().signal,
  })) {
    void _;
  }
  expect(createCount).toBe(1);
  expect(captured[0]?.names).not.toContain("eco-pi-approval");

  for await (const _ of driver.run({
    threadId: "thr_perm_drift",
    prompt: "hi2",
    workspacePath: "/w1",
    worktreePath: "/w1",
    routes,
    signal: new AbortController().signal,
    piSession: { toolPermissionHandler: allow },
  } as never)) {
    void _;
  }
  expect(createCount).toBe(2);
  expect(captured[1]?.names).toContain("eco-pi-approval");
});

test("PiCodingAgentDriver passes planner thinkingEffort into PI session thinkingLevel", async () => {
  const thinkingLevels: Array<string | undefined> = [];
  const registry = new PiSessionRegistry();
  const driver = new PiCodingAgentDriver(
    {
      createSession: async (input) => {
        thinkingLevels.push(input.thinkingLevel);
        return {
          sessionId: `sess_${thinkingLevels.length}`,
          sessionFile: `/tmp/pi-think-${thinkingLevels.length}.jsonl`,
          cwd: input.cwd,
          routeFingerprint: input.routeFingerprint,
          bindingId: input.bindingId,
          skillsFingerprint: "",
          mcpFingerprint: "",
          abort: async () => {},
          dispose: () => {},
          isStreaming: () => false,
          steer: async () => {},
          rebind: async () => {},
          updateSkillPaths: async () => {},
          async *prompt(text: string): AsyncIterable<AgentEvent> {
            yield {
              id: "m",
              threadId: input.threadId,
              agentId: "planner",
              role: "planner",
              type: "message.delta",
              payload: { type: "eco_stream", blockKind: "text", text },
              createdAt: new Date().toISOString(),
            } as AgentEvent;
          },
        };
      },
      resolveBridgeModel: async () => ({
        bridgeBaseUrl: "http://127.0.0.1:18765",
        bridgeModelId: "alias",
        apiKey: "k",
        agentDir: "/tmp/pi",
        apiCompat: "openai_responses",
        bindingId: "cbb_test",
        providerId: "p",
      }),
    },
    registry,
  );

  const planner = {
    role: "planner" as const,
    providerId: "p",
    modelId: "grok-4.5",
    primary: { modelId: "grok-4.5", contextWindow: 100_000 },
    fallbacks: [],
  };

  for await (const _ of driver.run({
    threadId: "thr_think",
    prompt: "hi",
    workspacePath: "/w",
    worktreePath: "/w",
    routes: [{ ...planner, thinkingEffort: "high" }],
    signal: new AbortController().signal,
  })) {
    void _;
  }
  expect(thinkingLevels).toEqual(["high"]);

  for await (const _ of driver.run({
    threadId: "thr_think",
    prompt: "again",
    workspacePath: "/w",
    worktreePath: "/w",
    routes: [{ ...planner, thinkingEffort: "off" }],
    signal: new AbortController().signal,
  })) {
    void _;
  }
  expect(thinkingLevels).toEqual(["high", "off"]);
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

test("codemode reports its nested calls and full-output path on the tool result", () => {
  const ctx = makeCtx();
  mapPiSessionEventToAgentEvents(
    {
      type: "tool_execution_start",
      toolCallId: "code_1",
      toolName: "codemode",
      args: { code: 'await tools.bash({ command: "ls" });' },
    },
    ctx,
  );
  const end = mapPiSessionEventToAgentEvents(
    {
      type: "tool_execution_end",
      toolCallId: "code_1",
      toolName: "codemode",
      result: {
        content: [{ type: "text", text: "Script completed\nWall time 1.20 seconds\nOutput:\n12" }],
        details: {
          fullOutputPath: "/tmp/pi-out-1.txt",
          calls: [
            { id: "code_1/1", name: "bash", args: '{"command":"ls"}', status: "ok", durationMs: 120 },
            // Cancelled when the script ended: it never produced its own tool event.
            { id: "code_1/?", name: "read", args: '{"path":"a.ts"}', status: "cancelled" },
          ],
        },
      },
      isError: false,
    },
    ctx,
  );
  const payload = end[0]?.payload;
  expect(isRecord(payload) ? payload.codemodeDetails : undefined).toEqual({
    fullOutputPath: "/tmp/pi-out-1.txt",
    calls: [
      { id: "code_1/1", name: "bash", args: '{"command":"ls"}', status: "ok", durationMs: 120 },
      { id: "code_1/?", name: "read", args: '{"path":"a.ts"}', status: "cancelled" },
    ],
  });
});

test("a failed codemode script keeps its nested-call details", () => {
  const ctx = makeCtx();
  const end = mapPiSessionEventToAgentEvents(
    {
      type: "tool_execution_end",
      toolCallId: "code_2",
      toolName: "codemode",
      result: {
        content: [
          {
            type: "text",
            text: "Script failed\nWall time 0.40 seconds\nOutput:\n\nScript error: Error: boom",
          },
        ],
        details: { calls: [{ id: "code_2/1", name: "read", args: "{}", status: "error", error: "boom" }] },
      },
      isError: true,
    },
    ctx,
  );
  const payload = end[0]?.payload;
  expect(end[0]?.type).toBe("tool.failed");
  expect(isRecord(payload) ? payload.codemodeDetails : undefined).toEqual({
    calls: [{ id: "code_2/1", name: "read", args: "{}", status: "error", error: "boom" }],
  });
});

test("a call the codemode script made carries the script as its parent tool call", () => {
  const ctx = makeCtx();
  const start = mapPiSessionEventToAgentEvents(
    {
      type: "tool_execution_start",
      toolCallId: "code_1/1",
      toolName: "bash",
      args: { command: "ls" },
      parentToolCallId: "code_1",
    },
    ctx,
  );
  expect(isRecord(start[0]?.payload) ? start[0]?.payload.parent_tool_call_id : undefined).toBe("code_1");
  const end = mapPiSessionEventToAgentEvents(
    {
      type: "tool_execution_end",
      toolCallId: "code_1/1",
      toolName: "bash",
      result: { content: [{ type: "text", text: "a.ts" }], details: {} },
      isError: false,
      parentToolCallId: "code_1",
    },
    ctx,
  );
  expect(isRecord(end[0]?.payload) ? end[0]?.payload.parent_tool_call_id : undefined).toBe("code_1");
});

test("a tool result with unrelated details carries no codemode details", () => {
  const ctx = makeCtx();
  const end = mapPiSessionEventToAgentEvents(
    {
      type: "tool_execution_end",
      toolCallId: "tc_ws",
      toolName: "web_search",
      result: {
        content: [{ type: "text", text: "ok" }],
        details: { provider: "p", query: "q", results: [{ title: "t", url: "u" }] },
      },
      isError: false,
    },
    ctx,
  );
  const payload = end[0]?.payload;
  expect(isRecord(payload) ? payload.codemodeDetails : undefined).toBeUndefined();
});

test("PI model receives dynamic output budget and preserves explicitly larger fixed budgets", () => {
  const dynamic = buildEcoPiModel({
    bridgeBaseUrl: "http://127.0.0.1:18765",
    bridgeModelId: "small",
    contextWindow: 32_768,
    globalMaxOutputTokens: "dynamic",
  });
  expect(dynamic.maxTokens).toBe(32_767);
  const resolved = buildEcoPiModel({
    bridgeBaseUrl: "http://127.0.0.1:18765",
    bridgeModelId: "large",
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    globalMaxOutputTokens: 64_000,
  });
  expect(resolved.maxTokens).toBe(64_000);
});
