/**
 * Smoke / regression surface for Claude Agent SDK 0.3.266 Eco wiring.
 * Keeps the high-value option + mapping contracts in one fast file.
 */
import { expect, test } from "bun:test";
import {
  ClaudeAgentSdkDriver,
  buildSdkTodoUpdatedPayload,
  formatAgentEventLine,
  interruptOrCloseSdkQuery,
  mapSdkMessageToEvents,
} from "../src/claude-agent-sdk";
import { parseModelUsage, parseSdkModelUsageBilling } from "../src/usage";
import { createFinalizePlanMcpServer } from "../src/finalize-plan";
import { createClassifierContextPostToolHook } from "../src/eco-sdk-hooks";

const routes = [
  {
    role: "main" as const,
    primary: { modelId: "claude-sonnet-4", provider: "anthropic", contextWindow: 200_000 },
  },
];

test("smoke: ask phase wires pluginDelivery / perTaskStop / permissionPrompts none", async () => {
  let captured: Record<string, unknown> | undefined;
  const driver = new ClaudeAgentSdkDriver({
    apiKey: "test-key",
    baseUrl: "http://127.0.0.1:36037",
    loadSdk: async () => ({
      query: ({ options }) => {
        captured = options;
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: "system", subtype: "init", session_id: "s1", uuid: "u1" };
            yield {
              type: "result",
              subtype: "success",
              session_id: "s1",
              uuid: "r1",
              usage: { input_tokens: 1, output_tokens: 1 },
              total_cost_usd: 0,
            };
          },
          getContextUsage: async (opts) => {
            expect(opts).toEqual({ detail: "summary" });
            return { totalTokens: 1 };
          },
          close: () => {},
        };
      },
    }),
  });

  for await (const _ of driver.runAsk({
    threadId: "thr_smoke",
    prompt: "hi",
    workspacePath: "/tmp/ws",
    worktreePath: "/tmp/wt",
    routes,
    signal: new AbortController().signal,
  })) {
    // drain
  }

  expect(captured?.pluginDelivery).toBe("initialize");
  expect(captured?.perTaskStopAffordance).toBe(true);
  expect(captured?.permissionPrompts).toBe("none");
});

test("smoke: modelUsage thinkingTokens + costBasis parse", () => {
  const parsed = parseModelUsage({
    modelUsage: {
      "claude-opus": {
        inputTokens: 10,
        outputTokens: 20,
        thinkingTokens: 7,
        costUSD: 0.01,
        costBasis: "managed",
      },
    },
  });
  expect(parsed?.["claude-opus"]).toMatchObject({
    thinkingTokens: 7,
    costBasis: "managed",
    costUsd: 0.01,
  });
  const billing = parseSdkModelUsageBilling({
    modelUsage: {
      "claude-opus": {
        inputTokens: 10,
        outputTokens: 20,
        thinkingTokens: 7,
        costUSD: 0.01,
      },
    },
  });
  expect(billing?.[0]?.usage.reasoningTokens).toBe(7);
});

test("smoke: result uuid + queued_turn_count + task ambient mapping", () => {
  const usageEvents = mapSdkMessageToEvents(
    {
      type: "result",
      subtype: "success",
      session_id: "s1",
      uuid: "r1",
      user_message_uuid: "um-1",
      user_message_uuids: ["um-0", "um-1"],
      queued_turn_count: 2,
      usage: { input_tokens: 1, output_tokens: 1 },
      total_cost_usd: 0.1,
    },
    "thr_1",
  );
  expect(usageEvents.find((e) => e.type === "usage.recorded")?.payload).toMatchObject({
    user_message_uuid: "um-1",
    user_message_uuids: ["um-0", "um-1"],
    queued_turn_count: 2,
  });

  const started = buildSdkTodoUpdatedPayload({
    subtype: "task_started",
    task_id: "t1",
    ambient: true,
    is_backgrounded: true,
    spawn_depth: 1,
    description: "housekeeping",
  });
  expect(started).toMatchObject({
    ambient: true,
    is_backgrounded: true,
    spawn_depth: 1,
  });
  expect(
    formatAgentEventLine({
      type: "todo.updated",
      role: "main",
      payload: started!,
    }),
  ).toBeNull();
});

test("smoke: tool resourceLinks + interrupt cancelQueued + finalize timeout", async () => {
  const toolEvents = mapSdkMessageToEvents(
    {
      type: "user",
      session_id: "s1",
      uuid: "u1",
      parent_tool_use_id: null,
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tool_1", content: "ok" }],
      },
      tool_use_result: {
        resourceLinks: [{ uri: "file:///tmp/a.png", name: "a.png", mimeType: "image/png" }],
      },
    },
    "thr_1",
  );
  expect(toolEvents[0]?.payload).toMatchObject({
    resource_links: [{ uri: "file:///tmp/a.png", name: "a.png" }],
  });

  let interruptOpts: unknown;
  await interruptOrCloseSdkQuery({
    async *[Symbol.asyncIterator]() {},
    interrupt: async (options) => {
      interruptOpts = options;
      return { still_queued: [], cancelled: ["c1"] };
    },
  });
  expect(interruptOpts).toEqual({ cancelQueued: true });

  let mcpOpts: Record<string, unknown> | undefined;
  await createFinalizePlanMcpServer(
    () => {},
    {
      loadSdk: async () =>
        ({
          tool: (..._args: unknown[]) => ({}),
          createSdkMcpServer: (options: Record<string, unknown>) => {
            mcpOpts = options;
            return options;
          },
        }) as never,
    },
  );
  expect(mcpOpts?.timeout).toBe(60_000);

  const hook = createClassifierContextPostToolHook();
  const out = await hook(
    {
      hook_event_name: "PostToolUse",
      tool_name: "Read",
      tool_response: "file contents here",
      tool_input: {},
      tool_use_id: "t1",
      session_id: "s1",
      transcript_path: "/tmp/t",
      cwd: "/tmp",
      permission_mode: "default",
    } as never,
    "cb",
    { signal: new AbortController().signal },
  );
  expect(out.hookSpecificOutput).toMatchObject({
    hookEventName: "PostToolUse",
    classifierContext: expect.stringContaining("Read"),
  });
});
