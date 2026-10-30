import { expect, mock, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { buildCodexGatewayModelAlias } from "../src/codex-config-sync.js";
import {
  CodexEventAdapter,
  type CodexThreadRunEventInput,
  type CodexTurnPlanUpdatedInput,
  replayCodexNotificationFixture,
} from "../src/codex-event-adapter.js";
import { CodexTurnRouteRegistry } from "../src/codex-turn-route-registry.js";

const FIXTURE_PATH = path.resolve(import.meta.dir, "fixtures/codex-item-stream/plan-turn.jsonl");

const ECO_THREAD = "thr_eco_fixture";
const CODEX_THREAD = "thr_codex_fixture_001";

function resolveEcoThreadId(codexThreadId: string): string {
  if (codexThreadId === CODEX_THREAD) {
    return ECO_THREAD;
  }
  return codexThreadId;
}

function collectEvents(
  run: (record: (event: CodexThreadRunEventInput) => void) => void,
): CodexThreadRunEventInput[] {
  const events: CodexThreadRunEventInput[] = [];
  run((event) => events.push(event));
  return events;
}

test("dispatch maps turn/started to run.attempt.started", () => {
  const events = collectEvents((record) => {
    const adapter = new CodexEventAdapter({ resolveEcoThreadId, recordThreadRunEvent: record });
    adapter.dispatch("turn/started", {
      threadId: CODEX_THREAD,
      turn: { id: "turn_001", items: [], status: "inProgress" },
    });
  });

  expect(events).toHaveLength(1);
  expect(events[0]?.eventType).toBe("run.attempt.started");
  expect(events[0]?.threadId).toBe(ECO_THREAD);
  expect(events[0]?.runAttemptId).toBeUndefined();
  expect(events[0]?.metadata?.turnId).toBe("turn_001");
});

test("dispatch forwards authoritative turn plan snapshots and status changes", () => {
  const updates: CodexTurnPlanUpdatedInput[] = [];
  const adapter = new CodexEventAdapter({
    resolveEcoThreadId,
    recordThreadRunEvent: () => {},
    onTurnPlanUpdated: (input) => updates.push(input),
  });

  adapter.dispatch("turn/plan/updated", {
    threadId: CODEX_THREAD,
    turnId: "turn_plan_progress",
    explanation: "Starting implementation",
    plan: [
      { step: "Inspect protocol", status: "completed" },
      { step: "Wire progress", status: "inProgress" },
      { step: "Run tests", status: "pending" },
    ],
  });
  adapter.dispatch("turn/plan/updated", {
    threadId: CODEX_THREAD,
    turnId: "turn_plan_progress",
    explanation: null,
    plan: [
      { step: "Inspect protocol", status: "completed" },
      { step: "Wire progress", status: "completed" },
      { step: "Run tests", status: "inProgress" },
    ],
  });

  expect(updates).toHaveLength(2);
  expect(updates[0]).toEqual({
    ecoThreadId: ECO_THREAD,
    codexThreadId: CODEX_THREAD,
    turnId: "turn_plan_progress",
    explanation: "Starting implementation",
    plan: [
      { step: "Inspect protocol", status: "completed" },
      { step: "Wire progress", status: "inProgress" },
      { step: "Run tests", status: "pending" },
    ],
  });
  expect(updates[1]?.explanation).toBeUndefined();
  expect(updates[1]?.plan[2]?.status).toBe("inProgress");
});

test("dispatch accepts an empty turn plan as an explicit clear snapshot", () => {
  const updates: CodexTurnPlanUpdatedInput[] = [];
  const adapter = new CodexEventAdapter({
    resolveEcoThreadId,
    recordThreadRunEvent: () => {},
    onTurnPlanUpdated: (input) => updates.push(input),
  });

  adapter.dispatch("turn/plan/updated", {
    threadId: CODEX_THREAD,
    turnId: "turn_plan_clear",
    plan: [],
  });

  expect(updates).toEqual([
    {
      ecoThreadId: ECO_THREAD,
      codexThreadId: CODEX_THREAD,
      turnId: "turn_plan_clear",
      plan: [],
    },
  ]);
});

test("invalid turn plan snapshots emit explicit protocol gaps and are not forwarded", () => {
  const updates: CodexTurnPlanUpdatedInput[] = [];
  const events = collectEvents((record) => {
    const adapter = new CodexEventAdapter({
      resolveEcoThreadId,
      recordThreadRunEvent: record,
      onTurnPlanUpdated: (input) => updates.push(input),
    });
    adapter.dispatch("turn/plan/updated", {
      threadId: CODEX_THREAD,
      turnId: "turn_plan_invalid_status",
      plan: [{ step: "Do work", status: "failed" }],
    });
    adapter.dispatch("turn/plan/updated", {
      threadId: CODEX_THREAD,
      turnId: "turn_plan_blank_step",
      plan: [{ step: "   ", status: "pending" }],
    });
    adapter.dispatch("turn/plan/updated", {
      threadId: CODEX_THREAD,
      turnId: "turn_plan_invalid_shape",
      plan: { step: "Not an array", status: "pending" },
    });
  });

  expect(updates).toEqual([]);
  expect(events).toHaveLength(3);
  expect(events.every((event) => event.metadata?.gap === true)).toBe(true);
  expect(events[0]).toMatchObject({
    eventType: "thread.status",
    message: "Codex 任务步骤协议异常",
    metadata: {
      codexMethod: "turn/plan/updated",
      liveType: "codex.turn_plan.invalid",
    },
  });
  expect(String(events[0]?.metadata?.gapReason)).toContain("status");
  expect(String(events[1]?.metadata?.gapReason)).toContain("step");
  expect(String(events[2]?.metadata?.gapReason)).toContain("array");
});

test("subagent turn plan snapshots never overwrite the main task list", () => {
  const updates: CodexTurnPlanUpdatedInput[] = [];
  const events = collectEvents((record) => {
    const adapter = new CodexEventAdapter({
      resolveEcoThreadId,
      recordThreadRunEvent: record,
      resolveThreadAttribution: () => ({
        ecoThreadId: ECO_THREAD,
        billingRole: "coder",
        agentId: CODEX_THREAD,
        isSubagentThread: true,
      }),
      onTurnPlanUpdated: (input) => updates.push(input),
    });
    adapter.dispatch("turn/plan/updated", {
      threadId: CODEX_THREAD,
      turnId: "turn_child_plan",
      plan: [{ step: "Child-only work", status: "inProgress" }],
    });
  });

  expect(updates).toEqual([]);
  expect(events).toEqual([]);
});

test("webSearch items project as WebSearch tool lifecycle for Feed", () => {
  const events = collectEvents((record) => {
    const adapter = new CodexEventAdapter({ resolveEcoThreadId, recordThreadRunEvent: record });
    adapter.dispatch("item/started", {
      threadId: CODEX_THREAD,
      turnId: "turn_search",
      item: {
        id: "item_web_search_1",
        type: "webSearch",
        query: "codex upgrade",
      },
    });
    adapter.dispatch("item/completed", {
      threadId: CODEX_THREAD,
      turnId: "turn_search",
      item: {
        id: "item_web_search_1",
        type: "webSearch",
        query: "codex upgrade",
        action: { type: "search", query: "codex upgrade" },
      },
    });
  });

  expect(events).toHaveLength(2);
  expect(events[0]).toMatchObject({
    eventType: "tool.started",
    id: "tre:codex:tool:item_web_search_1:started",
    message: "Tool: WebSearch · codex upgrade",
    metadata: {
      liveType: "tool.started",
      itemType: "webSearch",
      tool: {
        name: "WebSearch",
        detail: "codex upgrade",
        status: "started",
        toolUseId: "item_web_search_1",
        webSearch: {
          mode: "search",
          query: "codex upgrade",
        },
      },
    },
  });
  expect(events[1]).toMatchObject({
    eventType: "tool.completed",
    id: "tre:codex:tool:item_web_search_1:done",
    message: "Tool: WebSearch · codex upgrade",
    metadata: {
      liveType: "tool.completed",
      itemType: "webSearch",
      tool: {
        name: "WebSearch",
        detail: "codex upgrade",
        status: "completed",
        webSearch: {
          mode: "search",
          query: "codex upgrade",
          actionType: "search",
        },
      },
    },
  });
});

test("imageView items project as image-view tool lifecycle events", () => {
  const events = collectEvents((record) => {
    const adapter = new CodexEventAdapter({ resolveEcoThreadId, recordThreadRunEvent: record });
    adapter.dispatch("item/started", {
      threadId: CODEX_THREAD,
      turnId: "turn_image_view",
      item: {
        id: "item_image_view_1",
        type: "imageView",
        path: "/tmp/screenshot.png",
      },
    });
    adapter.dispatch("item/completed", {
      threadId: CODEX_THREAD,
      turnId: "turn_image_view",
      item: {
        id: "item_image_view_1",
        type: "imageView",
        path: "/tmp/screenshot.png",
      },
    });
  });

  expect(events).toHaveLength(2);
  expect(events).toEqual([
    expect.objectContaining({
      eventType: "tool.started",
      id: "tre:codex:tool:item_image_view_1:started",
      message: "Tool: ViewImage · /tmp/screenshot.png",
      streamState: "streaming",
      metadata: expect.objectContaining({
        liveType: "tool.started",
        itemType: "imageView",
        tool: {
          name: "ViewImage",
          detail: "/tmp/screenshot.png",
          toolUseId: "item_image_view_1",
          status: "started",
          imageView: { path: "/tmp/screenshot.png" },
        },
      }),
    }),
    expect.objectContaining({
      eventType: "tool.completed",
      id: "tre:codex:tool:item_image_view_1:done",
      streamState: "finalized",
      metadata: expect.objectContaining({
        liveType: "tool.completed",
        itemType: "imageView",
        tool: {
          name: "ViewImage",
          detail: "/tmp/screenshot.png",
          toolUseId: "item_image_view_1",
          status: "completed",
          imageView: { path: "/tmp/screenshot.png" },
        },
      }),
    }),
  ]);
});

test("eco_image_view MCP calls project imageView metadata from absolute path arguments", () => {
  const events = collectEvents((record) => {
    const adapter = new CodexEventAdapter({ resolveEcoThreadId, recordThreadRunEvent: record });
    adapter.dispatch("item/started", {
      threadId: CODEX_THREAD,
      turnId: "turn_mcp_view",
      item: {
        id: "item_mcp_view_1",
        type: "mcpToolCall",
        server: "eco_image_view",
        tool: "view_image",
        arguments: { path: "/tmp/shot.png", question: "找报错" },
      },
    });
  });
  expect(events[0]?.metadata?.tool).toEqual(
    expect.objectContaining({
      name: "mcp__eco_image_view__view_image",
      // `question` is the deprecated alias of `prompt`; either one is what the vision
      // model was asked, and the Feed shows it beside the answer.
      imageView: { path: "/tmp/shot.png", prompt: "找报错" },
    }),
  );
});

test("per-thread MCP Hub wrapper calls unwrap to the nested tool for the Feed", () => {
  // Codex sessions register the Hub under `eco_mcp_<hash>_<threadSuffix>`; the
  // wrapper call carries the real tool id in `arguments.name`.
  const events = collectEvents((record) => {
    const adapter = new CodexEventAdapter({ resolveEcoThreadId, recordThreadRunEvent: record });
    adapter.dispatch("item/started", {
      threadId: CODEX_THREAD,
      turnId: "turn_hub_view",
      item: {
        id: "item_hub_view_1",
        type: "mcpToolCall",
        server: "eco_mcp_4b6e103b_thr_1790688274221",
        tool: "call_tool",
        arguments: {
          name: "eco_image_view:view_image",
          arguments: { path: "/tmp/shot.png", prompt: "描述这张图" },
        },
      },
    });
    adapter.dispatch("item/completed", {
      threadId: CODEX_THREAD,
      turnId: "turn_hub_view",
      item: {
        id: "item_hub_view_1",
        type: "mcpToolCall",
        server: "eco_mcp_4b6e103b_thr_1790688274221",
        tool: "call_tool",
        status: "completed",
        arguments: {
          name: "eco_image_view:view_image",
          arguments: { path: "/tmp/shot.png", prompt: "描述这张图" },
        },
        aggregatedOutput: "这是一张终端截图。",
      },
    });
  });
  expect(events[0]?.metadata?.tool).toEqual(
    expect.objectContaining({
      name: "mcp__eco_image_view__view_image",
      imageView: { path: "/tmp/shot.png", prompt: "描述这张图" },
    }),
  );
  const completed = events.find((event) => event.id === "tre:codex:tool:item_hub_view_1:done");
  expect(completed?.metadata?.tool).toEqual(
    expect.objectContaining({
      name: "mcp__eco_image_view__view_image",
      imageView: { path: "/tmp/shot.png", prompt: "描述这张图" },
      outputPreview: "这是一张终端截图。",
    }),
  );
});

test("eco_image_view MCP completion carries the vision answer as the tool output", () => {
  const events = collectEvents((record) => {
    const adapter = new CodexEventAdapter({ resolveEcoThreadId, recordThreadRunEvent: record });
    adapter.dispatch("item/completed", {
      threadId: CODEX_THREAD,
      turnId: "turn_mcp_view_done",
      item: {
        id: "item_mcp_view_done",
        type: "mcpToolCall",
        server: "eco_image_view",
        tool: "view_image",
        status: "completed",
        arguments: { path: "/tmp/shot.png", prompt: "找报错" },
        aggregatedOutput: "第 3 行的类型不匹配。",
      },
    });
  });
  expect(events[0]?.metadata?.tool).toEqual(
    expect.objectContaining({
      imageView: { path: "/tmp/shot.png", prompt: "找报错" },
      outputPreview: "第 3 行的类型不匹配。",
    }),
  );
});

test("failed Hub image analysis retains the MCP error alongside its image input", () => {
  const error = "MCP error -32000: 图片查看失败：The image_view model did not return text.";
  const events = collectEvents((record) => {
    const adapter = new CodexEventAdapter({ resolveEcoThreadId, recordThreadRunEvent: record });
    adapter.dispatch("item/completed", {
      threadId: CODEX_THREAD,
      turnId: "turn_hub_view_failed",
      item: {
        id: "item_hub_view_failed",
        type: "mcpToolCall",
        server: "eco_mcp_4b6e103b_thr_1790688274221",
        tool: "call_tool",
        status: "failed",
        arguments: {
          name: "eco_image_view:view_image",
          arguments: { path: "/tmp/shot.png", prompt: "描述这张图" },
        },
        error: { message: error },
      },
    });
  });
  expect(events[0]?.eventType).toBe("tool.failed");
  expect(events[0]?.metadata?.tool).toMatchObject({
    status: "failed",
    imageView: { path: "/tmp/shot.png", prompt: "描述这张图" },
    outputPreview: error,
  });
});

test("eco_image_view MCP completion reads the answer out of a raw MCP result envelope", () => {
  const events = collectEvents((record) => {
    const adapter = new CodexEventAdapter({ resolveEcoThreadId, recordThreadRunEvent: record });
    adapter.dispatch("item/completed", {
      threadId: CODEX_THREAD,
      turnId: "turn_mcp_view_envelope",
      item: {
        id: "item_mcp_view_envelope",
        type: "mcpToolCall",
        server: "eco_image_view",
        tool: "view_image",
        status: "completed",
        arguments: { path: "/tmp/shot.png", prompt: "找报错" },
        result: { content: [{ type: "text", text: "第 3 行的类型不匹配。" }] },
      },
    });
  });
  expect(events[0]?.metadata?.tool?.outputPreview).toBe("第 3 行的类型不匹配。");
});

test("eco_image_view MCP completion keeps both halves of a real call", () => {
  // Values taken from a live call: a long multi-line prompt and an answer that arrives as a
  // raw MCP content envelope rather than a flattened string.
  const events = collectEvents((record) => {
    const adapter = new CodexEventAdapter({ resolveEcoThreadId, recordThreadRunEvent: record });
    adapter.dispatch("item/completed", {
      threadId: CODEX_THREAD,
      turnId: "turn_mcp_view_live",
      item: {
        type: "mcpToolCall",
        id: "call_00_ET_1enklUHENuk398PNWfYx2663",
        server: "eco_image_view",
        tool: "view_image",
        arguments: {
          path: "/Users/plus/img_0_76f9aad9eac302601f1b04ac.png",
          prompt: "请详细描述这张图片的全部内容：包括画面中的文字（逐字列出）。",
        },
        status: "completed",
        result: { content: [{ type: "text", text: "## 整体印象\n\n这是一幅数字拼贴图像。" }] },
      },
    });
  });
  expect(events[0]?.metadata?.tool).toEqual(
    expect.objectContaining({
      name: "mcp__eco_image_view__view_image",
      imageView: {
        path: "/Users/plus/img_0_76f9aad9eac302601f1b04ac.png",
        prompt: "请详细描述这张图片的全部内容：包括画面中的文字（逐字列出）。",
      },
      outputPreview: "## 整体印象\n\n这是一幅数字拼贴图像。",
    }),
  );
});

test("eco_image_view MCP start does not invent an output before the answer exists", () => {  const events = collectEvents((record) => {
    const adapter = new CodexEventAdapter({ resolveEcoThreadId, recordThreadRunEvent: record });
    adapter.dispatch("item/started", {
      threadId: CODEX_THREAD,
      turnId: "turn_mcp_view_start",
      item: {
        id: "item_mcp_view_start",
        type: "mcpToolCall",
        server: "eco_image_view",
        tool: "view_image",
        arguments: { path: "/tmp/shot.png", prompt: "找报错" },
      },
    });
  });
  expect(events[0]?.metadata?.tool?.outputPreview).toBeUndefined();
});

test("eco_image_view MCP calls with relative path do not attach imageView", () => {
  const events = collectEvents((record) => {
    const adapter = new CodexEventAdapter({ resolveEcoThreadId, recordThreadRunEvent: record });
    adapter.dispatch("item/started", {
      threadId: CODEX_THREAD,
      turnId: "turn_mcp_rel",
      item: {
        id: "item_mcp_rel",
        type: "mcpToolCall",
        server: "eco_image_view",
        tool: "view_image",
        arguments: { path: "shot.png" },
      },
    });
  });
  expect(events[0]?.metadata?.tool?.imageView).toBeUndefined();
});

test("eco_image_display MCP completed calls attach imageDisplay artifactId", () => {
  const events = collectEvents((record) => {
    const adapter = new CodexEventAdapter({ resolveEcoThreadId, recordThreadRunEvent: record });
    adapter.dispatch("item/completed", {
      threadId: CODEX_THREAD,
      turnId: "turn_display",
      item: {
        id: "item_display_1",
        type: "mcpToolCall",
        server: "eco_image_display",
        tool: "display_image",
        status: "completed",
        aggregatedOutput: JSON.stringify({
          status: "ok",
          artifactId: "art-feed-1",
          title: "封面图",
        }),
      },
    });
  });
  expect(events[0]?.metadata?.tool).toEqual(
    expect.objectContaining({
      name: "mcp__eco_image_display__display_image",
      imageDisplay: { artifactId: "art-feed-1", title: "封面图" },
    }),
  );
});

test("eco_web_search MCP completed calls attach webSearch results", () => {
  const events = collectEvents((record) => {
    const adapter = new CodexEventAdapter({ resolveEcoThreadId, recordThreadRunEvent: record });
    adapter.dispatch("item/completed", {
      threadId: CODEX_THREAD,
      turnId: "turn_web_search",
      item: {
        id: "item_web_search_1",
        type: "mcpToolCall",
        server: "eco_web_search",
        tool: "search",
        status: "completed",
        arguments: { query: "shanghai weather" },
        aggregatedOutput: [
          'Doubao Search results for "shanghai weather":',
          "",
          "1. AccuWeather",
          "   https://accuweather.example/shanghai",
          "   30°C cloudy",
        ].join("\n"),
        structuredContent: {
          provider: "doubao",
          query: "shanghai weather",
          results: [
            {
              title: "AccuWeather",
              url: "https://accuweather.example/shanghai",
              description: "30°C cloudy",
            },
          ],
        },
      },
    });
  });
  expect(events[0]?.metadata?.tool).toEqual(
    expect.objectContaining({
      name: "mcp__eco_web_search__search",
      detail: "shanghai weather",
      webSearch: expect.objectContaining({
        mode: "search",
        actionType: "search",
        query: "shanghai weather",
        provider: "doubao",
        results: [
          {
            title: "AccuWeather",
            url: "https://accuweather.example/shanghai",
            description: "30°C cloudy",
          },
        ],
      }),
    }),
  );
});

test("Eco MCP Hub calls expose the nested tool in Codex activity metadata", () => {
  const events = collectEvents((record) => {
    const adapter = new CodexEventAdapter({ resolveEcoThreadId, recordThreadRunEvent: record });
    adapter.dispatch("item/completed", {
      threadId: CODEX_THREAD,
      turnId: "turn_hub_call",
      item: {
        id: "item_hub_call_1",
        type: "mcpToolCall",
        server: "eco_mcp",
        tool: "call_tool",
        status: "completed",
        arguments: {
          name: "eco_image_view:view_image",
          arguments: { path: "/tmp/hub-shot.png", prompt: "描述" },
        },
        aggregatedOutput: "一张截图",
      },
    });
  });
  expect(events[0]?.metadata?.tool).toEqual(
    expect.objectContaining({
      name: "mcp__eco_image_view__view_image",
      imageView: { path: "/tmp/hub-shot.png", prompt: "描述" },
    }),
  );
  expect(events[0]?.message).toContain("mcp__eco_image_view__view_image");
});

test("Eco MCP Hub search calls remain classified as MCP discovery", () => {
  const events = collectEvents((record) => {
    const adapter = new CodexEventAdapter({ resolveEcoThreadId, recordThreadRunEvent: record });
    adapter.dispatch("item/started", {
      threadId: CODEX_THREAD,
      turnId: "turn_hub_search",
      item: {
        id: "item_hub_search_1",
        type: "mcpToolCall",
        server: "eco_mcp",
        tool: "search_tools",
        arguments: { query: "image" },
      },
    });
  });
  expect(events[0]?.metadata?.tool).toEqual(
    expect.objectContaining({
      name: "mcp__eco_mcp__search_tools",
      mcpDiscovery: { kind: "search" },
    }),
  );
});

test("agent_browser_screenshot completed attaches imageView path from output", () => {
  const events = collectEvents((record) => {
    const adapter = new CodexEventAdapter({ resolveEcoThreadId, recordThreadRunEvent: record });
    adapter.dispatch("item/completed", {
      threadId: CODEX_THREAD,
      turnId: "turn_shot",
      item: {
        id: "item_shot_1",
        type: "mcpToolCall",
        server: "eco_agent_browser",
        tool: "agent_browser_screenshot",
        status: "completed",
        aggregatedOutput: "/tmp/eco-browser-screenshot-1.png",
      },
    });
  });
  expect(events[0]?.metadata?.tool?.imageView).toEqual({
    path: "/tmp/eco-browser-screenshot-1.png",
  });
});

test("unprojected item types surface an explicit Feed gap instead of silent drop", () => {
  const events = collectEvents((record) => {
    const adapter = new CodexEventAdapter({ resolveEcoThreadId, recordThreadRunEvent: record });
    adapter.dispatch("item/completed", {
      threadId: CODEX_THREAD,
      turnId: "turn_gap",
      item: {
        id: "item_sleep_1",
        type: "sleep",
        durationMs: 1000,
      },
    });
  });

  expect(events).toHaveLength(1);
  expect(events[0]?.eventType).toBe("thread.status");
  expect(events[0]?.id).toBe("tre:codex:unprojected:item_sleep_1");
  expect(events[0]?.metadata?.liveType).toBe("codex.item.unprojected");
  expect(events[0]?.metadata?.itemType).toBe("sleep");
  expect(events[0]?.metadata?.gap).toBe(true);
  expect(events[0]?.metadata?.unprojectedPhase).toBe("completed");
  expect(String(events[0]?.metadata?.payloadJson ?? "")).toContain("sleep");
  expect(events[0]?.message).toContain("sleep");
});

test("process-global deprecationNotice writes stderr without inventing thread attribution", () => {
  const writes: string[] = [];
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stderr.write;
  try {
    const events = collectEvents((record) => {
      const adapter = new CodexEventAdapter({ resolveEcoThreadId, recordThreadRunEvent: record });
      adapter.dispatch("deprecationNotice", {
        method: "thread/rollback",
        message: "thread/rollback is deprecated",
      });
    });
    expect(events).toHaveLength(0);
    expect(writes.join("")).toContain("deprecationNotice");
    expect(writes.join("")).toContain("thread/rollback");
  } finally {
    process.stderr.write = originalWrite;
  }
});

test("schema-shaped turn/completed consumes a registered route without notification usage", () => {
  const registry = new CodexTurnRouteRegistry();
  registry.register(CODEX_THREAD, "turn_001", {
    aliasModelId: "eco_custom__vendor-model",
    providerId: "custom",
    upstreamModelId: "vendor-model",
  });
  const events = collectEvents((record) => {
    const adapter = new CodexEventAdapter({
      resolveEcoThreadId,
      recordThreadRunEvent: record,
      turnRouteRegistry: registry,
    });
    adapter.dispatch("turn/completed", {
      threadId: CODEX_THREAD,
      turn: {
        id: "turn_001",
        items: [],
        status: "completed",
      },
    });
  });

  expect(events).toHaveLength(1);
  expect(events[0]?.eventType).toBe("run.attempt.completed");
  expect(events[0]?.metadata?.usage).toBeUndefined();
  expect(events[0]?.metadata?.appServerTokenUsage).toBeUndefined();
  expect(registry.size).toBe(0);
});

test("turn/completed rejects top-level compatibility fields and preserves the exact route", () => {
  const registry = new CodexTurnRouteRegistry();
  registry.register(CODEX_THREAD, "turn_invalid_shape", {
    aliasModelId: "eco_custom__vendor-model",
    providerId: "custom",
    upstreamModelId: "vendor-model",
  });
  const events = collectEvents((record) => {
    const adapter = new CodexEventAdapter({
      resolveEcoThreadId,
      recordThreadRunEvent: record,
      turnRouteRegistry: registry,
    });
    adapter.dispatch("turn/completed", {
      threadId: CODEX_THREAD,
      turnId: "turn_invalid_shape",
      status: "completed",
    });
  });

  expect(events).toEqual([]);
  expect(registry.peek(CODEX_THREAD, "turn_invalid_shape")).toBeDefined();
});

test("thread/started rejects top-level and snake_case attribution compatibility fields", () => {
  let recorded = false;
  const adapter = new CodexEventAdapter({
    resolveEcoThreadId,
    recordThreadRunEvent: () => {},
    recordThreadAttribution: () => {
      recorded = true;
    },
  });

  adapter.dispatch("thread/started", {
    threadId: "thr_codex_child_invalid",
    parent_thread_id: CODEX_THREAD,
    agent_role: "explore",
  });

  expect(recorded).toBe(false);
});

test("dispatch emits api.error when turn/completed status is failed", () => {
  const events = collectEvents((record) => {
    const adapter = new CodexEventAdapter({ resolveEcoThreadId, recordThreadRunEvent: record });
    adapter.dispatch("turn/completed", {
      threadId: CODEX_THREAD,
      turn: {
        id: "turn_fail_001",
        items: [],
        status: "failed",
        error: {
          message: "Model provider eco_custom not found",
          code: "provider_error",
          param: "model_provider",
          codexErrorInfo: {
            type: "http_connection_failed",
            httpStatusCode: 503,
          },
          additionalDetails: "The provider process exited.",
        },
      },
    });
  });

  expect(events.map((event) => event.eventType)).toEqual(["run.attempt.failed", "api.error"]);
  expect(events[1]?.message).toBe("Model provider eco_custom not found");
  expect(events[1]?.metadata?.apiError).toEqual({
    message: "Model provider eco_custom not found",
    code: "provider_error",
    param: "model_provider",
    codexErrorInfo: {
      type: "http_connection_failed",
      httpStatusCode: 503,
    },
    additionalDetails: "The provider process exited.",
    rawTurnError: {
      message: "Model provider eco_custom not found",
      code: "provider_error",
      param: "model_provider",
      codexErrorInfo: {
        type: "http_connection_failed",
        httpStatusCode: 503,
      },
      additionalDetails: "The provider process exited.",
    },
    codexThreadId: "thr_codex_fixture_001",
    turnId: "turn_fail_001",
  });
});

test("dispatch cancels without api.error when turn/completed status is interrupted", () => {
  const events = collectEvents((record) => {
    const adapter = new CodexEventAdapter({ resolveEcoThreadId, recordThreadRunEvent: record });
    adapter.dispatch("turn/completed", {
      threadId: CODEX_THREAD,
      turn: {
        id: "turn_interrupt_001",
        items: [],
        status: "interrupted",
      },
    });
  });

  expect(events.map((event) => event.eventType)).toEqual(["run.attempt.cancelled"]);
  expect(events[0]?.message).toBe("Turn interrupted");
  expect(events[0]?.metadata?.status).toBe("interrupted");
});

for (const status of ["completed", "failed", "interrupted"] as const) {
  test(`turn/completed status ${status} always clears its registered route`, () => {
    const registry = new CodexTurnRouteRegistry();
    registry.register(CODEX_THREAD, `turn_${status}`, {
      aliasModelId: "eco_custom__vendor-model",
      providerId: "custom",
      upstreamModelId: "vendor-model",
    });
    const adapter = new CodexEventAdapter({
      resolveEcoThreadId,
      recordThreadRunEvent: () => {},
      turnRouteRegistry: registry,
    });

    adapter.dispatch("turn/completed", {
      threadId: CODEX_THREAD,
      turn: { id: `turn_${status}`, items: [], status },
    });

    expect(registry.size).toBe(0);
  });
}

test("thread/deleted clears pending and active route state", () => {
  const registry = new CodexTurnRouteRegistry();
  registry.registerPending(CODEX_THREAD, {
    aliasModelId: "eco_custom__vendor-model",
    providerId: "custom",
    upstreamModelId: "vendor-model",
  });
  registry.register(CODEX_THREAD, "turn_active", {
    aliasModelId: "eco_custom__vendor-model",
    providerId: "custom",
    upstreamModelId: "vendor-model",
  });
  const adapter = new CodexEventAdapter({
    resolveEcoThreadId,
    recordThreadRunEvent: () => {},
    turnRouteRegistry: registry,
  });

  adapter.dispatch("thread/deleted", { threadId: CODEX_THREAD });

  expect(registry.size).toBe(0);
});

test("tokenUsage is correlated as explicit app-server diagnostics and never creates a bill", () => {
  const registry = new CodexTurnRouteRegistry();
  registry.register(CODEX_THREAD, "turn_bill_001", {
    aliasModelId: "eco_custom__vendor-model",
    providerId: "custom",
    upstreamModelId: "vendor-model",
  });
  const events = collectEvents((record) => {
    const adapter = new CodexEventAdapter({
      resolveEcoThreadId,
      recordThreadRunEvent: record,
      turnRouteRegistry: registry,
    });
    adapter.dispatch("thread/tokenUsage/updated", {
      threadId: CODEX_THREAD,
      turnId: "turn_bill_001",
      tokenUsage: {
        last: {
          inputTokens: 10,
          cachedInputTokens: 2,
          outputTokens: 5,
          reasoningOutputTokens: 1,
          totalTokens: 15,
        },
        total: {
          inputTokens: 10,
          cachedInputTokens: 2,
          outputTokens: 5,
          reasoningOutputTokens: 1,
          totalTokens: 15,
        },
        modelContextWindow: 200_000,
      },
    });
    adapter.dispatch("turn/completed", {
      threadId: CODEX_THREAD,
      turn: {
        id: "turn_bill_001",
        items: [],
        status: "completed",
      },
    });
  });

  expect(events).toHaveLength(1);
  expect(events[0]?.metadata?.appServerTokenUsage).toEqual({
    inputTokens: 10,
    cachedInputTokens: 2,
    outputTokens: 5,
    reasoningOutputTokens: 1,
    totalTokens: 15,
  });
  expect(registry.size).toBe(0);
});

test("historical tokenUsage cannot bind a new pending owner after resume", () => {
  const registry = new CodexTurnRouteRegistry();
  const alias = buildCodexGatewayModelAlias("custom-provider", "vendor-model", "openai_chat_completions");
  const owner = registry.registerPending(CODEX_THREAD, {
    aliasModelId: alias,
    providerId: "custom-provider",
    upstreamModelId: "vendor-model",
    apiCompat: "openai_chat_completions",
  });
  let contextModelId: string | undefined;
  const adapter = new CodexEventAdapter({
    resolveEcoThreadId,
    recordThreadRunEvent: () => {},
    turnRouteRegistry: registry,
    onTokenUsageUpdated: (resolution) => {
      contextModelId = resolution.context.modelId;
    },
  });

  adapter.dispatch("thread/tokenUsage/updated", {
    threadId: CODEX_THREAD,
    turnId: "turn_historical_replay",
    tokenUsage: {
      last: {
        inputTokens: 10,
        cachedInputTokens: 0,
        outputTokens: 5,
        reasoningOutputTokens: 0,
        totalTokens: 15,
      },
      total: {
        inputTokens: 10,
        cachedInputTokens: 0,
        outputTokens: 5,
        reasoningOutputTokens: 0,
        totalTokens: 15,
      },
      modelContextWindow: 200_000,
    },
  });

  expect(contextModelId).toBeUndefined();
  expect(registry.peek(CODEX_THREAD, "turn_historical_replay")).toBeUndefined();
  expect(registry.size).toBe(1);

  adapter.dispatch("turn/started", {
    threadId: CODEX_THREAD,
    turn: { id: "turn_current", items: [], status: "inProgress" },
  });
  expect(registry.peek(CODEX_THREAD, "turn_current")).toBeUndefined();
  expect(registry.size).toBe(1);
  expect(registry.bindPending(owner, "turn_current")?.aliasModelId).toBe(alias);
});

test("turn/started cannot consume a pending route without its owner", () => {
  const registry = new CodexTurnRouteRegistry();
  const route = {
    aliasModelId: "eco_custom__vendor-model",
    providerId: "custom",
    upstreamModelId: "vendor-model",
  };
  registry.register(CODEX_THREAD, "turn_old", route);
  registry.consume(CODEX_THREAD, "turn_old");
  const owner = registry.registerPending(CODEX_THREAD, route);
  const adapter = new CodexEventAdapter({
    resolveEcoThreadId,
    recordThreadRunEvent: () => {},
    turnRouteRegistry: registry,
  });

  adapter.dispatch("turn/started", {
    threadId: CODEX_THREAD,
    turn: { id: "turn_old", items: [], status: "inProgress" },
  });

  expect(registry.peek(CODEX_THREAD, "turn_old")).toBeUndefined();
  expect(registry.size).toBe(1);
  expect(registry.bindPending(owner, "turn_current")?.turnId).toBe("turn_current");
});

test("tokenUsage context uses the registered V1 route and ignores fake completion model fields", () => {
  const registry = new CodexTurnRouteRegistry();
  const alias = buildCodexGatewayModelAlias("custom-provider", "vendor-model", "openai_chat_completions");
  registry.register(CODEX_THREAD, "turn_bill_model", {
    aliasModelId: alias,
    providerId: "custom-provider",
    upstreamModelId: "vendor-model",
    apiCompat: "openai_chat_completions",
  });
  let contextUpdate: unknown;
  const adapter = new CodexEventAdapter({
    resolveEcoThreadId,
    recordThreadRunEvent: () => {},
    turnRouteRegistry: registry,
    onTokenUsageUpdated: (resolution) => {
      contextUpdate = resolution;
    },
  });
  adapter.dispatch("thread/tokenUsage/updated", {
    threadId: CODEX_THREAD,
    turnId: "turn_bill_model",
    tokenUsage: {
      last: {
        inputTokens: 10,
        cachedInputTokens: 0,
        outputTokens: 5,
        reasoningOutputTokens: 0,
        totalTokens: 15,
      },
      total: {
        inputTokens: 10,
        cachedInputTokens: 0,
        outputTokens: 5,
        reasoningOutputTokens: 0,
        totalTokens: 15,
      },
      modelContextWindow: 200_000,
    },
  });
  adapter.dispatch("turn/completed", {
    threadId: CODEX_THREAD,
    turn: {
      id: "turn_bill_model",
      items: [],
      status: "completed",
      modelId: "wrong-model-from-non-schema-fixture",
      usage: { input_tokens: 10, output_tokens: 5 },
    },
  });

  expect((contextUpdate as { context?: { modelId?: string } }).context?.modelId).toBe("vendor-model");
  expect(registry.size).toBe(0);
});

test("dispatch merges agentMessage deltas on stable streamKey (itemId)", () => {
  const events = collectEvents((record) => {
    const adapter = new CodexEventAdapter({ resolveEcoThreadId, recordThreadRunEvent: record });
    adapter.dispatch("item/agentMessage/delta", {
      threadId: CODEX_THREAD,
      turnId: "turn_001",
      itemId: "item_agent_001",
      delta: "Hello ",
    });
    adapter.dispatch("item/agentMessage/delta", {
      threadId: CODEX_THREAD,
      turnId: "turn_001",
      itemId: "item_agent_001",
      delta: "world",
    });
    adapter.dispatch("item/completed", {
      threadId: CODEX_THREAD,
      turnId: "turn_001",
      item: { type: "agentMessage", id: "item_agent_001", text: "Hello world" },
    });
  });

  const deltas = events.filter((event) => event.eventType === "message.delta");
  const finalMessage = events.find((event) => event.eventType === "message.final");

  expect(deltas).toHaveLength(2);
  expect(deltas[0]?.id).toBe(deltas[1]?.id);
  expect(deltas[0]?.message).toBe("Hello ");
  expect(deltas[1]?.message).toBe("Hello world");
  expect(deltas.every((event) => event.streamKey === "item_agent_001")).toBe(true);
  expect(deltas.every((event) => event.metadata?.logicalEntityId === "item_agent_001")).toBe(true);
  expect(deltas.every((event) => event.streamState === "streaming")).toBe(true);
  expect(finalMessage?.streamKey).toBe("item_agent_001");
  expect(finalMessage?.message).toBe("Hello world");
  expect(finalMessage?.role).toBe("assistant");
});

test("dispatch maps userMessage completed with clientId", () => {
  const events = collectEvents((record) => {
    const adapter = new CodexEventAdapter({ resolveEcoThreadId, recordThreadRunEvent: record });
    adapter.dispatch("item/completed", {
      threadId: CODEX_THREAD,
      turnId: "turn_001",
      item: {
        type: "userMessage",
        id: "item_user_001",
        clientId: "msg_eco_opt_1",
        content: [{ type: "text", text: "Summarize README" }],
      },
    });
  });

  expect(events).toHaveLength(1);
  expect(events[0]?.role).toBe("user");
  expect(events[0]?.message).toBe("Summarize README");
  expect(events[0]?.metadata?.liveType).toBe("message.user");
  expect(events[0]?.metadata?.clientUserMessageId).toBe("msg_eco_opt_1");
  expect(events[0]?.metadata?.rewindTarget).toEqual({
    activityLineId: "item_user_001",
    userMessageId: "item_user_001",
  });
  expect(events[0]?.streamKey).toBe("item_user_001");
});

test("plan-turn.jsonl fixture replays to expected ThreadRunEvent sequence", () => {
  const fixture = fs.readFileSync(FIXTURE_PATH, "utf8");
  const events = replayCodexNotificationFixture(fixture, {
    resolveEcoThreadId,
    recordThreadRunEvent: () => {},
    now: () => "2026-07-03T12:00:00.000Z",
  });

  expect(events.map((event) => event.eventType)).toEqual([
    "run.attempt.started",
    "message.final",
    "message.delta",
    "message.delta",
    "message.final",
    "run.attempt.completed",
  ]);

  expect(events.every((event) => event.threadId === ECO_THREAD)).toBe(true);

  const completed = events.find((event) => event.eventType === "run.attempt.completed");
  expect(completed?.runAttemptId).toBeUndefined();
  expect(completed?.metadata?.turnId).toBe("turn_fixture_001");
  expect(completed?.metadata?.status).toBe("completed");

  const userMessage = events.find((event) => event.metadata?.liveType === "message.user");
  expect(userMessage?.metadata?.clientUserMessageId).toBe("msg_eco_optimistic_fixture_001");
  expect(userMessage?.message).toContain("Read README.md");
});

test("dispatch maps collabAgentToolCall spawn_agent item/started to agent.started", () => {
  const events = collectEvents((record) => {
    const adapter = new CodexEventAdapter({
      resolveEcoThreadId,
      recordThreadRunEvent: record,
      dequeueSpawnPayloadMatching: ({ toolUseId }) =>
        toolUseId === "item_spawn_001" ? { agentRole: "explore", toolUseId } : undefined,
    });
    adapter.dispatch("item/started", {
      threadId: CODEX_THREAD,
      turnId: "turn_spawn_001",
      item: {
        type: "collabAgentToolCall",
        id: "item_spawn_001",
        tool: "spawnAgent",
        status: "inProgress",
        senderThreadId: CODEX_THREAD,
        receiverThreadIds: ["thr_codex_child_001"],
        prompt: "Explore the auth module and list key entry points.",
      },
    });
  });

  expect(events).toHaveLength(1);
  expect(events[0]?.eventType).toBe("agent.started");
  expect(events[0]?.scope).toBe("agent");
  expect(events[0]?.role).toBe("explore");
  expect(events[0]?.agentId).toBe("thr_codex_child_001");
  expect(events[0]?.parentToolUseId).toBe("item_spawn_001");
  expect(events[0]?.metadata?.codexNewThreadId).toBe("thr_codex_child_001");
  expect(events[0]?.metadata?.delegationPrompt).toBe("Explore the auth module and list key entry points.");
});

test("dispatch maps completed spawnAgent item to agent.started until the child turn completes", () => {
  const events = collectEvents((record) => {
    const adapter = new CodexEventAdapter({ resolveEcoThreadId, recordThreadRunEvent: record });
    adapter.dispatch("item/completed", {
      threadId: CODEX_THREAD,
      turnId: "turn_spawn_001",
      item: {
        type: "collabAgentToolCall",
        id: "item_spawn_001",
        tool: "spawnAgent",
        status: "completed",
        senderThreadId: CODEX_THREAD,
        receiverThreadIds: ["thr_codex_child_001"],
      },
    });
  });

  expect(events).toHaveLength(1);
  expect(events[0]?.eventType).toBe("agent.started");
  expect(events[0]?.scope).toBe("agent");
  expect(events[0]?.agentId).toBe("thr_codex_child_001");
});

test("collabAgentToolCall completed captures nickname from receiverAgents", () => {
  const attributions: Array<{ codexThreadId: string; record: Record<string, unknown> }> = [];
  const events = collectEvents((record) => {
    const adapter = new CodexEventAdapter({
      resolveEcoThreadId,
      recordThreadRunEvent: record,
      recordThreadAttribution: (codexThreadId, attribution) => {
        attributions.push({ codexThreadId, record: attribution });
      },
      dequeueSpawnPayloadMatching: ({ toolUseId }) =>
        toolUseId === "item_spawn_nick"
          ? {
              agentRole: "coder",
              message: "Fix the drawer",
              toolUseId,
            }
          : undefined,
    });
    adapter.dispatch("item/completed", {
      threadId: CODEX_THREAD,
      turnId: "turn_spawn_nick",
      item: {
        type: "collabAgentToolCall",
        id: "item_spawn_nick",
        tool: "spawnAgent",
        status: "completed",
        senderThreadId: CODEX_THREAD,
        receiverThreadIds: ["thr_codex_child_nick"],
        receiverAgents: [
          {
            threadId: "thr_codex_child_nick",
            agentNickname: "Avicenna",
            agentRole: "coder",
          },
        ],
      },
    });
  });

  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    eventType: "agent.started",
    agentId: "thr_codex_child_nick",
    role: "coder",
    metadata: {
      agentNickname: "Avicenna",
    },
  });
  expect(attributions[0]?.record).toMatchObject({
    agentNickname: "Avicenna",
    agentRole: "coder",
  });
});

test("thread/started enriches nickname after collab agent.started without receiverAgents", () => {
  const events = collectEvents((record) => {
    const adapter = new CodexEventAdapter({
      resolveEcoThreadId,
      recordThreadRunEvent: record,
      recordThreadAttribution: () => {},
      dequeueSpawnPayloadMatching: ({ toolUseId }) =>
        toolUseId === "item_spawn_enrich"
          ? { agentRole: "coder", message: "Implement ASR", toolUseId }
          : undefined,
    });
    adapter.dispatch("item/completed", {
      threadId: CODEX_THREAD,
      turnId: "turn_spawn_enrich",
      item: {
        type: "collabAgentToolCall",
        id: "item_spawn_enrich",
        tool: "spawnAgent",
        status: "completed",
        senderThreadId: CODEX_THREAD,
        receiverThreadIds: ["thr_codex_child_enrich"],
      },
    });
    adapter.dispatch("thread/started", {
      thread: {
        id: "thr_codex_child_enrich",
        parentThreadId: CODEX_THREAD,
        agentRole: "coder",
        agent_nickname: "Goodall",
      },
    });
  });

  expect(events.map((event) => event.eventType)).toEqual(["agent.started", "agent.started"]);
  expect(events[0]?.metadata?.agentNickname).toBeUndefined();
  expect(events[1]).toMatchObject({
    id: events[0]?.id,
    metadata: { agentNickname: "Goodall" },
  });
});

test("collabAgentToolCall completed consumes queued Orchestration role when completed carries child thread id", () => {
  const attributions: Array<{ codexThreadId: string; record: Record<string, unknown> }> = [];
  const events = collectEvents((record) => {
    const adapter = new CodexEventAdapter({
      resolveEcoThreadId,
      recordThreadRunEvent: record,
      recordThreadAttribution: (codexThreadId, attribution) => {
        attributions.push({ codexThreadId, record: attribution });
      },
      dequeueSpawnPayloadMatching: ({ toolUseId }) =>
        toolUseId === "item_spawn_completed_only"
          ? {
              agentRole: "coder",
              message: "Suggest a scoped implementation step",
              toolUseId,
            }
          : undefined,
    });
    adapter.dispatch("item/completed", {
      threadId: CODEX_THREAD,
      turnId: "turn_spawn_completed_only",
      item: {
        type: "collabAgentToolCall",
        id: "item_spawn_completed_only",
        tool: "spawnAgent",
        status: "completed",
        senderThreadId: CODEX_THREAD,
        receiverThreadIds: ["thr_codex_child_completed_only"],
      },
    });
  });

  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    eventType: "agent.started",
    scope: "agent",
    agentId: "thr_codex_child_completed_only",
    role: "coder",
    metadata: {
      agentRole: "coder",
      orchestrationRole: "coder",
      delegationPrompt: "Suggest a scoped implementation step",
    },
  });
  expect(attributions).toEqual([
    {
      codexThreadId: "thr_codex_child_completed_only",
      record: {
        parentThreadId: CODEX_THREAD,
        agentRole: "coder",
        spawnCallId: "item_spawn_completed_only",
        spawnMessage: "Suggest a scoped implementation step",
      },
    },
  ]);
});

test("collabAgentToolCall completed ignores non-schema item role and uses queued role", () => {
  const attributions: Array<{ codexThreadId: string; record: Record<string, unknown> }> = [];
  const events = collectEvents((record) => {
    const adapter = new CodexEventAdapter({
      resolveEcoThreadId,
      recordThreadRunEvent: record,
      recordThreadAttribution: (codexThreadId, attribution) => {
        attributions.push({ codexThreadId, record: attribution });
      },
      dequeueSpawnPayloadMatching: ({ toolUseId }) =>
        toolUseId === "item_spawn_inherited_role"
          ? {
              agentRole: "coder",
              message: "Suggest a scoped implementation step",
              taskName: "coder",
              toolUseId,
            }
          : undefined,
    });
    adapter.dispatch("item/completed", {
      threadId: CODEX_THREAD,
      turnId: "turn_spawn_inherited_role",
      item: {
        type: "collabAgentToolCall",
        id: "item_spawn_inherited_role",
        tool: "spawnAgent",
        status: "completed",
        senderThreadId: CODEX_THREAD,
        receiverThreadIds: ["thr_codex_child_inherited_role"],
        agentRole: "explore",
      },
    });
  });

  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    eventType: "agent.started",
    agentId: "thr_codex_child_inherited_role",
    role: "coder",
    metadata: {
      agentRole: "coder",
      orchestrationRole: "coder",
      delegationPrompt: "Suggest a scoped implementation step",
    },
  });
  expect(attributions).toEqual([
    {
      codexThreadId: "thr_codex_child_inherited_role",
      record: {
        parentThreadId: CODEX_THREAD,
        agentRole: "coder",
        spawnCallId: "item_spawn_inherited_role",
        spawnMessage: "Suggest a scoped implementation step",
      },
    },
  ]);
});

test("collabAgentToolCall completed matches queued payload over stale attribution role", () => {
  const attributions: Array<{ codexThreadId: string; record: Record<string, unknown> }> = [];
  const matchingInputs: unknown[] = [];
  const childThreadId = "thr_codex_child_stale_attribution";
  const spawnMessage = "Implement the Codex usage ledger attribution fix.";
  const events = collectEvents((record) => {
    const adapter = new CodexEventAdapter({
      resolveEcoThreadId,
      recordThreadRunEvent: record,
      getThreadAttributionRecord: (codexThreadId) => {
        if (codexThreadId !== childThreadId) {
          return undefined;
        }
        return {
          parentThreadId: CODEX_THREAD,
          agentRole: "explore",
          spawnCallId: "item_spawn_previous",
          spawnMessage,
        };
      },
      recordThreadAttribution: (codexThreadId, attribution) => {
        attributions.push({ codexThreadId, record: attribution });
      },
      dequeueSpawnPayloadMatching: (input) => {
        matchingInputs.push(input);
        if (input.toolUseId === "item_spawn_stale_attribution") {
          return {
            agentRole: "coder",
            message: spawnMessage,
            taskName: "implementation_fix",
            toolUseId: "item_spawn_stale_attribution",
          };
        }
        return undefined;
      },
    });
    adapter.dispatch("item/completed", {
      threadId: CODEX_THREAD,
      turnId: "turn_spawn_stale_attribution",
      item: {
        type: "collabAgentToolCall",
        id: "item_spawn_stale_attribution",
        tool: "spawnAgent",
        status: "completed",
        senderThreadId: CODEX_THREAD,
        receiverThreadIds: [childThreadId],
      },
    });
  });

  expect(matchingInputs).toEqual([
    {
      toolUseId: "item_spawn_stale_attribution",
    },
  ]);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    eventType: "agent.started",
    agentId: childThreadId,
    role: "coder",
    metadata: {
      agentRole: "coder",
      orchestrationRole: "coder",
      delegationPrompt: spawnMessage,
    },
  });
  expect(attributions).toEqual([
    {
      codexThreadId: childThreadId,
      record: {
        parentThreadId: CODEX_THREAD,
        agentRole: "coder",
        spawnCallId: "item_spawn_stale_attribution",
        spawnMessage,
      },
    },
  ]);
});

test("collabAgentToolCall started without child thread id does not consume queued role", () => {
  let payloadDequeues = 0;
  const events = collectEvents((record) => {
    const adapter = new CodexEventAdapter({
      resolveEcoThreadId,
      recordThreadRunEvent: record,
      dequeueSpawnPayloadMatching: () => {
        payloadDequeues += 1;
        return { agentRole: "explore" };
      },
    });
    adapter.dispatch("item/started", {
      threadId: CODEX_THREAD,
      turnId: "turn_spawn_started_no_child",
      item: {
        type: "collabAgentToolCall",
        id: "item_spawn_started_no_child",
        tool: "spawnAgent",
        status: "inProgress",
        senderThreadId: CODEX_THREAD,
      },
    });
  });

  expect(events).toEqual([]);
  expect(payloadDequeues).toBe(0);
});

test("dispatch records parent link and general display role when spawn omits agent_type", () => {
  const attributions: Array<{ codexThreadId: string; record: Record<string, unknown> }> = [];
  const events = collectEvents((record) => {
    const adapter = new CodexEventAdapter({
      resolveEcoThreadId,
      recordThreadRunEvent: record,
      recordThreadAttribution: (codexThreadId, attribution) => {
        attributions.push({ codexThreadId, record: attribution });
      },
    });
    adapter.dispatch("item/started", {
      threadId: CODEX_THREAD,
      turnId: "turn_spawn_missing_role",
      item: {
        type: "collabAgentToolCall",
        id: "item_spawn_missing_role",
        tool: "spawnAgent",
        status: "inProgress",
        senderThreadId: CODEX_THREAD,
        receiverThreadIds: ["thr_codex_child_missing_role"],
      },
    });
  });

  expect(events.map((event) => event.eventType)).toEqual(["agent.started"]);
  expect(events[0]).toMatchObject({
    threadId: ECO_THREAD,
    agentId: "thr_codex_child_missing_role",
    role: "general",
    eventType: "agent.started",
  });
  expect(attributions).toEqual([
    {
      codexThreadId: "thr_codex_child_missing_role",
      record: {
        parentThreadId: CODEX_THREAD,
        agentRole: "general",
        spawnCallId: "item_spawn_missing_role",
      },
    },
  ]);
});

test("subAgentActivity started with queued Orchestration role opens agent.started", () => {
  const attributions: Array<{ codexThreadId: string; record: Record<string, unknown> }> = [];
  const events = collectEvents((record) => {
    const adapter = new CodexEventAdapter({
      resolveEcoThreadId,
      recordThreadRunEvent: record,
      recordThreadAttribution: (codexThreadId, attribution) => {
        attributions.push({ codexThreadId, record: attribution });
      },
      resolveThreadAttribution: (codexThreadId) => {
        const hit = attributions.find((entry) => entry.codexThreadId === codexThreadId);
        if (!hit?.record.parentThreadId) {
          return undefined;
        }
        return {
          ecoThreadId: ECO_THREAD,
          billingRole: "explore",
          parentEcoThreadId: ECO_THREAD,
          isSubagentThread: true,
          agentId: codexThreadId,
        };
      },
      dequeueSpawnPayloadMatching: ({ toolUseId }) =>
        toolUseId === "item_sub_activity_role"
          ? {
              agentRole: "explore",
              message: "Scan weather for Guangzhou",
              taskName: "weather_check",
              toolUseId,
            }
          : undefined,
    });
    adapter.dispatch("item/completed", {
      threadId: CODEX_THREAD,
      turnId: "turn_parent_spawn",
      item: {
        type: "subAgentActivity",
        id: "item_sub_activity_role",
        kind: "started",
        agentThreadId: "thr_codex_child_explore_v2",
        agentPath: "/root/weather_check",
      },
    });
  });

  expect(events.map((event) => event.eventType)).toEqual(["agent.started"]);
  expect(events[0]).toMatchObject({
    threadId: ECO_THREAD,
    agentId: "thr_codex_child_explore_v2",
    role: "explore",
    eventType: "agent.started",
    metadata: {
      delegationPrompt: "Scan weather for Guangzhou",
    },
  });
});

test("subAgentActivity started consumes queued spawn payload only once", () => {
  const queued = [
    {
      agentRole: "explore",
      message: "Explore the repository shape",
      taskName: "repo_scan",
    },
    {
      agentRole: "coder",
      message: "Suggest an implementation path",
      taskName: "implementation_hint",
    },
  ];
  const events = collectEvents((record) => {
    const adapter = new CodexEventAdapter({
      resolveEcoThreadId,
      recordThreadRunEvent: record,
      recordThreadAttribution: () => {},
      dequeueSpawnPayloadMatching: ({ toolUseId }) => {
        const index = toolUseId === "item_sub_activity_single_dequeue" ? 0 : -1;
        return index < 0 ? undefined : queued.splice(index, 1)[0];
      },
    });
    adapter.dispatch("item/completed", {
      threadId: CODEX_THREAD,
      turnId: "turn_parent_spawn",
      item: {
        type: "subAgentActivity",
        id: "item_sub_activity_single_dequeue",
        kind: "started",
        agentThreadId: "thr_codex_child_single_dequeue",
        agentPath: "/root/repo_scan",
      },
    });
  });

  expect(events[0]).toMatchObject({
    agentId: "thr_codex_child_single_dequeue",
    role: "explore",
    metadata: {
      delegationPrompt: "Explore the repository shape",
    },
  });
  expect(queued.map((entry) => entry.agentRole)).toEqual(["coder"]);
});

test("subAgentActivity started accepts queued custom Orchestration role", () => {
  const events = collectEvents((record) => {
    const adapter = new CodexEventAdapter({
      resolveEcoThreadId,
      recordThreadRunEvent: record,
      recordThreadAttribution: () => {},
      orchestrationRoleIds: ["Deep_Research"],
      dequeueSpawnPayloadMatching: ({ toolUseId }) =>
        toolUseId === "item_sub_activity_custom_role"
          ? {
              agentRole: "deep_research",
              message: "Investigate integration risks",
              taskName: "integration_risks",
              toolUseId,
            }
          : undefined,
    });
    adapter.dispatch("item/completed", {
      threadId: CODEX_THREAD,
      turnId: "turn_parent_spawn",
      item: {
        type: "subAgentActivity",
        id: "item_sub_activity_custom_role",
        kind: "started",
        agentThreadId: "thr_codex_child_deep_research",
        agentPath: "/root/integration_risks",
      },
    });
  });

  expect(events[0]).toMatchObject({
    agentId: "thr_codex_child_deep_research",
    role: "Deep_Research",
    metadata: {
      orchestrationRole: "Deep_Research",
      delegationPrompt: "Investigate integration risks",
    },
  });
});

test("subAgentActivity started without agent_type displays general", () => {
  const attributions: Array<{ codexThreadId: string; record: Record<string, unknown> }> = [];
  const events = collectEvents((record) => {
    const adapter = new CodexEventAdapter({
      resolveEcoThreadId,
      recordThreadRunEvent: record,
      recordThreadAttribution: (codexThreadId, attribution) => {
        attributions.push({ codexThreadId, record: attribution });
      },
    });
    adapter.dispatch("item/completed", {
      threadId: CODEX_THREAD,
      turnId: "turn_parent_spawn",
      item: {
        type: "subAgentActivity",
        id: "item_sub_activity_general",
        kind: "started",
        agentThreadId: "thr_codex_child_general",
        agentPath: "/root/task_1",
      },
    });
  });

  expect(events.map((event) => event.eventType)).toEqual(["agent.started"]);
  expect(events[0]).toMatchObject({
    threadId: ECO_THREAD,
    agentId: "thr_codex_child_general",
    role: "general",
    eventType: "agent.started",
  });
});

test("thread/started does not use preview text as role attribution evidence", () => {
  const queued = [
    {
      agentRole: "explore",
      message: "Scan repository top-level folders",
      taskName: "top_level_scan",
    },
  ];
  const attributions: Array<{ codexThreadId: string; record: Record<string, unknown> }> = [];
  const events = collectEvents((record) => {
    const adapter = new CodexEventAdapter({
      resolveEcoThreadId,
      recordThreadRunEvent: record,
      recordThreadAttribution: (codexThreadId, attribution) => {
        attributions.push({ codexThreadId, record: attribution });
      },
      resolveThreadAttribution: (codexThreadId) => {
        const hit = attributions.find((entry) => entry.codexThreadId === codexThreadId);
        if (!hit?.record.parentThreadId) {
          return undefined;
        }
        return {
          ecoThreadId: ECO_THREAD,
          billingRole: "explore",
          parentEcoThreadId: ECO_THREAD,
          isSubagentThread: true,
          agentId: codexThreadId,
        };
      },
      dequeueSpawnPayloadMatching: () => queued.shift(),
    });
    adapter.dispatch("thread/started", {
      thread: {
        id: "thr_codex_child_thread_started_queue",
        parentThreadId: CODEX_THREAD,
        preview: "Scan repository top-level folders",
      },
    });
  });

  expect(events).toEqual([]);
  expect(attributions).toEqual([
    {
      codexThreadId: "thr_codex_child_thread_started_queue",
      record: {
        parentThreadId: CODEX_THREAD,
        agentRole: "general",
        spawnMessage: "Scan repository top-level folders",
      },
    },
  ]);
  expect(queued).toHaveLength(1);
});

test("thread/started without role evidence waits for subAgentActivity call_id before emitting", () => {
  const attributionByThread = new Map<string, Record<string, unknown>>();
  let recordedEvents = 0;
  const events = collectEvents((record) => {
    const adapter = new CodexEventAdapter({
      resolveEcoThreadId,
      recordThreadRunEvent: (event) => {
        recordedEvents += 1;
        record(event);
      },
      getThreadAttributionRecord: (codexThreadId) => attributionByThread.get(codexThreadId) as never,
      recordThreadAttribution: (codexThreadId, attribution) => {
        attributionByThread.set(codexThreadId, attribution);
      },
      dequeueSpawnPayloadMatching: ({ toolUseId }) =>
        toolUseId === "call_precise_role"
          ? {
              agentRole: "coder",
              message: "Implement the precise fix",
              taskName: "precise_fix",
              toolUseId,
            }
          : undefined,
    });

    adapter.dispatch("thread/started", {
      thread: {
        id: "thr_codex_child_precise_role",
        parentThreadId: CODEX_THREAD,
      },
    });
    expect(recordedEvents).toBe(0);

    adapter.dispatch("item/completed", {
      threadId: CODEX_THREAD,
      turnId: "turn_parent_precise_role",
      item: {
        type: "subAgentActivity",
        id: "call_precise_role",
        kind: "started",
        agentThreadId: "thr_codex_child_precise_role",
        agentPath: "/root/precise_fix",
      },
    });
  });

  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    eventType: "agent.started",
    agentId: "thr_codex_child_precise_role",
    role: "coder",
    metadata: {
      orchestrationRole: "coder",
      delegationPrompt: "Implement the precise fix",
    },
  });
  expect(attributionByThread.get("thr_codex_child_precise_role")).toMatchObject({
    parentThreadId: CODEX_THREAD,
    agentRole: "coder",
    spawnCallId: "call_precise_role",
  });
});

test("thread/started does not infer a custom Orchestration role from preview text", () => {
  const queued = [
    {
      agentRole: "researcher",
      message: "Find the risky Codex integration path",
    },
  ];
  const attributions: Array<{ codexThreadId: string; record: Record<string, unknown> }> = [];
  const events = collectEvents((record) => {
    const adapter = new CodexEventAdapter({
      resolveEcoThreadId,
      recordThreadRunEvent: record,
      recordThreadAttribution: (codexThreadId, attribution) => {
        attributions.push({ codexThreadId, record: attribution });
      },
      resolveThreadAttribution: (codexThreadId) => {
        const hit = attributions.find((entry) => entry.codexThreadId === codexThreadId);
        if (!hit?.record.parentThreadId) {
          return undefined;
        }
        return {
          ecoThreadId: ECO_THREAD,
          billingRole: "researcher",
          parentEcoThreadId: ECO_THREAD,
          isSubagentThread: true,
          agentId: codexThreadId,
        };
      },
      resolveOrchestrationRoleIds: () => ["researcher"],
      dequeueSpawnPayloadMatching: () => queued.shift(),
    });
    adapter.dispatch("thread/started", {
      thread: {
        id: "thr_codex_child_researcher",
        parentThreadId: CODEX_THREAD,
        preview: "Find the risky Codex integration path",
      },
    });
  });

  expect(events).toEqual([]);
  expect(attributions[0]).toEqual({
    codexThreadId: "thr_codex_child_researcher",
    record: {
      parentThreadId: CODEX_THREAD,
      agentRole: "general",
      spawnMessage: "Find the risky Codex integration path",
    },
  });
  expect(queued).toHaveLength(1);
});

test("thread/started with explicit Orchestration role does not consume queued payload", () => {
  let payloadDequeues = 0;
  const events = collectEvents((record) => {
    const adapter = new CodexEventAdapter({
      resolveEcoThreadId,
      recordThreadRunEvent: record,
      recordThreadAttribution: () => {},
      dequeueSpawnPayloadMatching: () => {
        payloadDequeues += 1;
        return { agentRole: "coder", message: "Should stay queued" };
      },
    });
    adapter.dispatch("thread/started", {
      thread: {
        id: "thr_codex_child_explicit_role",
        parentThreadId: CODEX_THREAD,
        agentRole: "explore",
      },
    });
  });

  expect(events[0]).toMatchObject({
    agentId: "thr_codex_child_explicit_role",
    role: "explore",
  });
  expect(payloadDequeues).toBe(0);
});

test("child subagent turn/completed emits agent.stopped on parent without run.attempt.failed", () => {
  const attributions: Array<{ codexThreadId: string; record: Record<string, unknown> }> = [];
  const events = collectEvents((record) => {
    const adapter = new CodexEventAdapter({
      resolveEcoThreadId,
      recordThreadRunEvent: record,
      recordThreadAttribution: (codexThreadId, attribution) => {
        attributions.push({ codexThreadId, record: attribution });
      },
      getThreadAttributionRecord: (codexThreadId) => {
        const hit = attributions.find((entry) => entry.codexThreadId === codexThreadId);
        return hit?.record as { parentThreadId: string; agentRole?: string; spawnCallId?: string };
      },
      resolveThreadAttribution: (codexThreadId) => {
        if (codexThreadId === "thr_codex_child_done") {
          return {
            ecoThreadId: ECO_THREAD,
            billingRole: "explore",
            parentEcoThreadId: ECO_THREAD,
            isSubagentThread: true,
            agentId: codexThreadId,
          };
        }
        return undefined;
      },
    });
    attributions.push({
      codexThreadId: "thr_codex_child_done",
      record: {
        parentThreadId: CODEX_THREAD,
        agentRole: "explore",
        spawnCallId: "item_spawn_done",
      },
    });
    adapter.dispatch("turn/completed", {
      threadId: "thr_codex_child_done",
      turn: { id: "turn_child_done", status: "completed" },
    });
  });

  expect(events.map((event) => event.eventType)).toEqual(["agent.stopped"]);
  expect(events[0]).toMatchObject({
    threadId: ECO_THREAD,
    agentId: "thr_codex_child_done",
    role: "explore",
    eventType: "agent.stopped",
  });
});

test("child subagent turn/completed emits agent.stopped without persisted agentRole", () => {
  const attributions: Array<{ codexThreadId: string; record: Record<string, unknown> }> = [];
  const events = collectEvents((record) => {
    const adapter = new CodexEventAdapter({
      resolveEcoThreadId,
      recordThreadRunEvent: record,
      recordThreadAttribution: (codexThreadId, attribution) => {
        attributions.push({ codexThreadId, record: attribution });
      },
      getThreadAttributionRecord: (codexThreadId) => {
        const hit = attributions.find((entry) => entry.codexThreadId === codexThreadId);
        return hit?.record as { parentThreadId: string; agentRole?: string; spawnCallId?: string };
      },
      resolveThreadAttribution: (codexThreadId) => {
        if (codexThreadId === "thr_codex_child_no_role") {
          return {
            ecoThreadId: ECO_THREAD,
            billingRole: "coder",
            parentEcoThreadId: ECO_THREAD,
            isSubagentThread: true,
            agentId: codexThreadId,
          };
        }
        return undefined;
      },
    });
    attributions.push({
      codexThreadId: "thr_codex_child_no_role",
      record: {
        parentThreadId: CODEX_THREAD,
        spawnCallId: "item_spawn_no_role",
      },
    });
    adapter.dispatch("turn/completed", {
      threadId: "thr_codex_child_no_role",
      turn: { id: "turn_child_no_role", status: "completed" },
    });
  });

  expect(events.map((event) => event.eventType)).toEqual(["agent.stopped"]);
  expect(events[0]).toMatchObject({
    threadId: ECO_THREAD,
    agentId: "thr_codex_child_no_role",
    role: "general",
    eventType: "agent.stopped",
  });
});

test("subAgentActivity with task_name path opens general agent card", () => {
  const attributions: Array<{ codexThreadId: string; record: Record<string, unknown> }> = [];
  const events = collectEvents((record) => {
    const adapter = new CodexEventAdapter({
      resolveEcoThreadId,
      recordThreadRunEvent: record,
      recordThreadAttribution: (codexThreadId, attribution) => {
        attributions.push({ codexThreadId, record: attribution });
      },
      resolveThreadAttribution: (codexThreadId) => {
        const hit = attributions.find((entry) => entry.codexThreadId === codexThreadId);
        if (!hit) {
          return undefined;
        }
        return {
          ecoThreadId: ECO_THREAD,
          billingRole: "coder",
          parentEcoThreadId: ECO_THREAD,
          isSubagentThread: true,
          agentId: codexThreadId,
        };
      },
    });
    adapter.dispatch("item/completed", {
      threadId: CODEX_THREAD,
      turnId: "turn_parent_spawn",
      item: {
        type: "subAgentActivity",
        id: "item_sub_activity_001",
        kind: "started",
        agentThreadId: "thr_codex_child_live",
        agentPath: "/root/weather_check",
      },
    });
    adapter.dispatch("turn/started", {
      threadId: "thr_codex_child_live",
      turn: { id: "turn_child_live", status: "inProgress" },
    });
  });

  expect(attributions).toEqual([
    {
      codexThreadId: "thr_codex_child_live",
      record: {
        parentThreadId: CODEX_THREAD,
        agentRole: "general",
        spawnCallId: "item_sub_activity_001",
        spawnMessage: "weather_check",
      },
    },
  ]);
  expect(events.map((event) => event.eventType)).toEqual(["agent.started", "run.attempt.started"]);
  expect(events[0]).toMatchObject({
    threadId: ECO_THREAD,
    agentId: "thr_codex_child_live",
    role: "general",
    eventType: "agent.started",
  });
});

test("subAgentActivity started uses dequeued spawn message for card mission text", () => {
  const events = collectEvents((record) => {
    const adapter = new CodexEventAdapter({
      resolveEcoThreadId,
      recordThreadRunEvent: record,
      recordThreadAttribution: () => {},
      dequeueSpawnPayloadMatching: ({ toolUseId }) =>
        toolUseId === "item_sub_activity_msg"
          ? {
              message: "Find all API entry points under src/auth",
              taskName: "auth_scan",
              toolUseId,
            }
          : undefined,
    });
    adapter.dispatch("item/completed", {
      threadId: CODEX_THREAD,
      turnId: "turn_parent_spawn",
      item: {
        type: "subAgentActivity",
        id: "item_sub_activity_msg",
        kind: "started",
        agentThreadId: "thr_codex_child_msg",
        agentPath: "/root/auth_scan",
      },
    });
  });

  expect(events[0]?.metadata?.delegationPrompt).toBe("Find all API entry points under src/auth");
});

test("thread/started with agentRole opens agent.started card on parent eco thread", () => {
  const attributions: Array<{ codexThreadId: string; record: Record<string, unknown> }> = [];
  const events = collectEvents((record) => {
    const adapter = new CodexEventAdapter({
      resolveEcoThreadId,
      recordThreadRunEvent: record,
      recordThreadAttribution: (codexThreadId, attribution) => {
        attributions.push({ codexThreadId, record: attribution });
        adapter.flushPendingEventsForThread(codexThreadId);
      },
      resolveThreadAttribution: (codexThreadId) => {
        const hit = attributions.find((entry) => entry.codexThreadId === codexThreadId);
        if (!hit?.record.parentThreadId) {
          return undefined;
        }
        return {
          ecoThreadId: ECO_THREAD,
          billingRole: "explore",
          parentEcoThreadId: ECO_THREAD,
          isSubagentThread: true,
          agentId: codexThreadId,
        };
      },
    });
    adapter.dispatch("thread/started", {
      thread: {
        id: "thr_codex_child_role",
        parentThreadId: CODEX_THREAD,
        agentRole: "explore",
      },
    });
  });

  expect(attributions).toEqual([
    {
      codexThreadId: "thr_codex_child_role",
      record: {
        parentThreadId: CODEX_THREAD,
        agentRole: "explore",
      },
    },
  ]);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    threadId: ECO_THREAD,
    eventType: "agent.started",
    agentId: "thr_codex_child_role",
    role: "explore",
    scope: "agent",
  });
});

test("ignores self-parent subAgentActivity so planner thinking stays on main scope", () => {
  const attributions: Array<{ codexThreadId: string; record: Record<string, unknown> }> = [];
  const events = collectEvents((record) => {
    const adapter = new CodexEventAdapter({
      resolveEcoThreadId,
      recordThreadRunEvent: record,
      recordThreadAttribution: (codexThreadId, attribution) => {
        attributions.push({ codexThreadId, record: attribution });
      },
      resolveThreadAttribution: (codexThreadId) => {
        if (codexThreadId !== CODEX_THREAD) {
          return undefined;
        }
        return {
          ecoThreadId: ECO_THREAD,
          billingRole: "main",
        };
      },
    });
    adapter.dispatch("item/completed", {
      threadId: CODEX_THREAD,
      turnId: "turn_self_parent",
      item: {
        type: "subAgentActivity",
        id: "item_self_parent",
        kind: "started",
        agentThreadId: CODEX_THREAD,
        agentPath: "/root/explore",
      },
    });
    adapter.dispatch("item/reasoning/textDelta", {
      threadId: CODEX_THREAD,
      turnId: "turn_self_parent",
      itemId: "item_main_think",
      delta: "planner thinking",
    });
  });

  expect(attributions).toEqual([]);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    threadId: ECO_THREAD,
    eventType: "thinking.delta",
    scope: "main",
    message: "planner thinking",
  });
  expect(events[0]?.agentId).toBeUndefined();
  expect(typeof events[0]?.metadata?.thinkingStartedAt).toBe("string");
});

test("Codex exposes a reasoning start placeholder and replaces it with content", () => {
  const events: CodexThreadRunEventInput[] = [];
  const adapter = new CodexEventAdapter({
    resolveEcoThreadId,
    recordThreadRunEvent: (event) => events.push(event),
  });
  const params = {
    threadId: CODEX_THREAD,
    turnId: "turn_pending_reasoning",
    item: { type: "reasoning", id: "reasoning_pending", summary: [], content: [] },
  };
  adapter.dispatch("item/started", params);
  adapter.dispatch("item/started", params);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ eventType: "thinking.delta", streamState: "placeholder", message: "" });
  adapter.dispatch("item/reasoning/summaryTextDelta", {
    threadId: CODEX_THREAD,
    turnId: params.turnId,
    itemId: params.item.id,
    delta: "先检查代码",
  });
  expect(events[1]).toMatchObject({
    eventType: "thinking.delta",
    streamState: "streaming",
    message: "先检查代码",
  });
  expect(events[1]?.id).toBe(events[0]?.id);
  expect(events[1]?.metadata?.thinkingStartedAt).toBe(events[0]?.metadata?.thinkingStartedAt);
});

test("dispatch stamps thinking duration on reasoning completion", () => {
  const events = collectEvents((record) => {
    const adapter = new CodexEventAdapter({
      resolveEcoThreadId,
      recordThreadRunEvent: record,
      now: (() => {
        let tick = 0;
        return () => {
          tick += 1;
          return `2026-01-01T00:00:0${tick}.000Z`;
        };
      })(),
    });
    adapter.dispatch("item/reasoning/textDelta", {
      threadId: CODEX_THREAD,
      turnId: "turn_think_duration",
      itemId: "item_think_duration",
      delta: "first",
    });
    adapter.dispatch("item/reasoning/textDelta", {
      threadId: CODEX_THREAD,
      turnId: "turn_think_duration",
      itemId: "item_think_duration",
      delta: " second",
    });
    adapter.dispatch("item/completed", {
      threadId: CODEX_THREAD,
      turnId: "turn_think_duration",
      item: {
        type: "reasoning",
        id: "item_think_duration",
        text: "first second",
      },
    });
  });

  expect(events).toHaveLength(3);
  expect(events[0]?.metadata?.thinkingStartedAt).toBe("2026-01-01T00:00:01.000Z");
  expect(events[0]?.metadata?.reasoningDisplay).toBe("raw");
  expect(events[1]?.metadata?.thinkingStartedAt).toBe("2026-01-01T00:00:01.000Z");
  expect(events[2]).toMatchObject({
    eventType: "thinking.final",
    metadata: {
      thinkingStartedAt: "2026-01-01T00:00:01.000Z",
      thinkingDurationMs: 2000,
      reasoningDisplay: "raw",
    },
  });
});

test("dispatch stamps reasoningDisplay summary on summaryTextDelta and completed summary", () => {
  const events = collectEvents((record) => {
    const adapter = new CodexEventAdapter({ resolveEcoThreadId, recordThreadRunEvent: record });
    adapter.dispatch("item/reasoning/summaryTextDelta", {
      threadId: CODEX_THREAD,
      turnId: "turn_summary_stage",
      itemId: "item_summary_stage",
      delta: "定位入口",
    });
    adapter.dispatch("item/completed", {
      threadId: CODEX_THREAD,
      turnId: "turn_summary_stage",
      item: {
        type: "reasoning",
        id: "item_summary_stage",
        summary: [{ type: "summary_text", text: "定位入口" }],
      },
    });
  });

  expect(events).toHaveLength(2);
  expect(events[0]).toMatchObject({
    eventType: "thinking.delta",
    message: "定位入口",
    metadata: { reasoningDisplay: "summary", codexMethod: "item/reasoning/summaryTextDelta" },
  });
  expect(events[1]).toMatchObject({
    eventType: "thinking.final",
    message: "定位入口",
    metadata: { reasoningDisplay: "summary" },
  });
});

test("dispatch inserts newlines between summary parts on the same reasoning item", () => {
  const events = collectEvents((record) => {
    const adapter = new CodexEventAdapter({ resolveEcoThreadId, recordThreadRunEvent: record });
    adapter.dispatch("item/reasoning/summaryPartAdded", {
      threadId: CODEX_THREAD,
      turnId: "turn_summary_parts",
      itemId: "item_summary_parts",
      summaryIndex: 0,
    });
    adapter.dispatch("item/reasoning/summaryTextDelta", {
      threadId: CODEX_THREAD,
      turnId: "turn_summary_parts",
      itemId: "item_summary_parts",
      summaryIndex: 0,
      delta: "**Planning ordered file reading**",
    });
    adapter.dispatch("item/reasoning/summaryPartAdded", {
      threadId: CODEX_THREAD,
      turnId: "turn_summary_parts",
      itemId: "item_summary_parts",
      summaryIndex: 1,
    });
    adapter.dispatch("item/reasoning/summaryTextDelta", {
      threadId: CODEX_THREAD,
      turnId: "turn_summary_parts",
      itemId: "item_summary_parts",
      summaryIndex: 1,
      delta: "**Confirming smoke-skill file path**",
    });
  });

  expect(events).toHaveLength(2);
  expect(events[0]?.message).toBe("**Planning ordered file reading**");
  expect(events[1]?.message).toBe(
    "**Planning ordered file reading**\n**Confirming smoke-skill file path**",
  );
});

test("dispatch inserts newlines when summaryIndex advances without summaryPartAdded", () => {
  const events = collectEvents((record) => {
    const adapter = new CodexEventAdapter({ resolveEcoThreadId, recordThreadRunEvent: record });
    adapter.dispatch("item/reasoning/summaryTextDelta", {
      threadId: CODEX_THREAD,
      turnId: "turn_summary_index",
      itemId: "item_summary_index",
      summaryIndex: 0,
      delta: "First stage",
    });
    adapter.dispatch("item/reasoning/summaryTextDelta", {
      threadId: CODEX_THREAD,
      turnId: "turn_summary_index",
      itemId: "item_summary_index",
      summaryIndex: 1,
      delta: "Second stage",
    });
  });

  expect(events).toHaveLength(2);
  expect(events[1]?.message).toBe("First stage\nSecond stage");
});

test("dispatch reads structured reasoning summary text on item completion", () => {
  const events = collectEvents((record) => {
    const adapter = new CodexEventAdapter({ resolveEcoThreadId, recordThreadRunEvent: record });
    adapter.dispatch("item/completed", {
      threadId: CODEX_THREAD,
      turnId: "turn_reasoning_summary",
      item: {
        type: "reasoning",
        id: "item_reasoning_summary",
        summary: [
          { type: "summary_text", text: "先定位事件合并。" },
          { type: "summary_text", text: "再检查 Feed 投影。" },
        ],
        encryptedContent: "opaque",
      },
    });
  });

  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    eventType: "thinking.final",
    message: "先定位事件合并。\n再检查 Feed 投影。",
    streamKey: "item_reasoning_summary",
    metadata: { reasoningDisplay: "summary" },
  });
});

test("buffers child events until parent eco mapping is known then flushes", () => {
  const parentMapped = { value: false };
  const attributions = new Map<string, { parentThreadId: string; agentRole?: string }>();
  const events: Array<{ threadId: string; eventType: string; agentId?: string; scope: string }> = [];
  const resolveAttribution = (codexThreadId: string) => {
    const record = attributions.get(codexThreadId);
    if (!record?.parentThreadId) {
      return undefined;
    }
    if (!parentMapped.value) {
      return undefined;
    }
    return {
      ecoThreadId: ECO_THREAD,
      billingRole: "explore" as const,
      parentEcoThreadId: ECO_THREAD,
      isSubagentThread: true,
      agentId: codexThreadId,
    };
  };
  const adapter = new CodexEventAdapter({
    resolveEcoThreadId: (codexThreadId) => {
      if (codexThreadId === CODEX_THREAD && parentMapped.value) {
        return ECO_THREAD;
      }
      return resolveAttribution(codexThreadId)?.ecoThreadId ?? codexThreadId;
    },
    resolveThreadAttribution: resolveAttribution,
    recordThreadAttribution: (codexThreadId, record) => {
      attributions.set(codexThreadId, record);
      adapter.flushPendingEventsForThread(codexThreadId);
    },
    recordThreadRunEvent: (event) => {
      events.push({
        threadId: event.threadId,
        eventType: event.eventType,
        scope: event.scope,
        ...(event.agentId && { agentId: event.agentId }),
      });
    },
  });

  adapter.dispatch("thread/started", {
    thread: {
      id: "thr_codex_child_wait_parent",
      parentThreadId: CODEX_THREAD,
      agentRole: "explore",
    },
  });
  adapter.dispatch("item/reasoning/textDelta", {
    threadId: "thr_codex_child_wait_parent",
    turnId: "turn_child_wait",
    itemId: "item_child_think_wait",
    delta: "child thinking",
  });
  expect(events).toHaveLength(0);

  parentMapped.value = true;
  adapter.flushAllPendingEvents();

  expect(events).toEqual([
    {
      threadId: ECO_THREAD,
      eventType: "agent.started",
      scope: "agent",
      agentId: "thr_codex_child_wait_parent",
    },
    {
      threadId: ECO_THREAD,
      eventType: "thinking.delta",
      scope: "agent",
      agentId: "thr_codex_child_wait_parent",
    },
  ]);
});

test("buffers child events until attribution arrives then flushes to parent eco thread", () => {
  const attributions = new Map<string, { parentThreadId: string; agentRole?: string }>();
  const events: Array<{ threadId: string; eventType: string; agentId?: string }> = [];
  const adapter = new CodexEventAdapter({
    resolveEcoThreadId: (codexThreadId) => (codexThreadId === CODEX_THREAD ? ECO_THREAD : codexThreadId),
    resolveThreadAttribution: (codexThreadId) => {
      const record = attributions.get(codexThreadId);
      if (!record?.parentThreadId) {
        return undefined;
      }
      return {
        ecoThreadId: ECO_THREAD,
        billingRole: "explore",
        parentEcoThreadId: ECO_THREAD,
        isSubagentThread: true,
        agentId: codexThreadId,
      };
    },
    recordThreadAttribution: (codexThreadId, record) => {
      attributions.set(codexThreadId, record);
      adapter.flushPendingEventsForThread(codexThreadId);
    },
    recordThreadRunEvent: (event) => {
      events.push({
        threadId: event.threadId,
        eventType: event.eventType,
        ...(event.agentId && { agentId: event.agentId }),
      });
    },
  });

  // Child turn starts before spawn attribution (live race).
  adapter.dispatch("turn/started", {
    threadId: "thr_codex_child_race",
    turn: { id: "turn_child_race", status: "inProgress" },
  });
  expect(events).toHaveLength(0);

  adapter.dispatch("thread/started", {
    thread: {
      id: "thr_codex_child_race",
      parentThreadId: CODEX_THREAD,
      agentRole: "explore",
    },
  });

  expect(events.map((event) => event.eventType)).toEqual(["run.attempt.started", "agent.started"]);
  expect(events[0]).toMatchObject({
    threadId: ECO_THREAD,
    eventType: "run.attempt.started",
    agentId: "thr_codex_child_race",
  });
  expect(events[1]).toMatchObject({
    threadId: ECO_THREAD,
    eventType: "agent.started",
    agentId: "thr_codex_child_race",
  });
});

test("child thread events resolve to parent eco thread via attribution", () => {
  const attributions = new Map<
    string,
    { parentThreadId: string; agentRole?: string; spawnCallId?: string }
  >();
  const events: Array<{
    threadId: string;
    eventType: string;
    agentId?: string;
    scope: string;
    role?: string;
  }> = [];
  const adapter = new CodexEventAdapter({
    resolveEcoThreadId: (codexThreadId) => (codexThreadId === CODEX_THREAD ? ECO_THREAD : codexThreadId),
    resolveThreadAttribution: (codexThreadId) => {
      const record = attributions.get(codexThreadId);
      if (!record?.parentThreadId) {
        return undefined;
      }
      return {
        ecoThreadId: ECO_THREAD,
        billingRole: (record.agentRole?.trim() || "subagent") as "subagent",
        parentEcoThreadId: ECO_THREAD,
        isSubagentThread: true,
        agentId: codexThreadId,
      };
    },
    recordThreadAttribution: (codexThreadId, record) => {
      attributions.set(codexThreadId, record);
    },
    recordThreadRunEvent: (event) => {
      events.push({
        threadId: event.threadId,
        eventType: event.eventType,
        scope: event.scope,
        ...(event.agentId && { agentId: event.agentId }),
        ...(event.role && { role: event.role }),
      });
    },
  });

  adapter.dispatch("item/started", {
    threadId: CODEX_THREAD,
    turnId: "turn_spawn_parent",
    item: {
      type: "collabAgentToolCall",
      id: "item_spawn_parent",
      tool: "spawnAgent",
      status: "inProgress",
      senderThreadId: CODEX_THREAD,
      receiverThreadIds: ["thr_codex_child_live"],
    },
  });
  adapter.dispatch("turn/started", {
    threadId: "thr_codex_child_live",
    turn: { id: "turn_child_live", status: "inProgress" },
  });
  adapter.dispatch("item/reasoning/textDelta", {
    threadId: "thr_codex_child_live",
    turnId: "turn_child_live",
    itemId: "item_child_think",
    delta: "looking",
  });

  const childEvents = events.filter((event) => event.agentId === "thr_codex_child_live");
  expect(childEvents.length).toBeGreaterThanOrEqual(2);
  expect(childEvents.every((event) => event.threadId === ECO_THREAD)).toBe(true);
  expect(childEvents.every((event) => event.scope === "agent")).toBe(true);
  expect(childEvents.some((event) => event.eventType === "run.attempt.started")).toBe(true);
  expect(childEvents.some((event) => event.eventType === "thinking.delta")).toBe(true);
});

test("dispatch records thread attribution on spawn item/started and thread/started", () => {
  const attributions: Array<{ codexThreadId: string; record: Record<string, unknown> }> = [];
  const adapter = new CodexEventAdapter({
    resolveEcoThreadId,
    recordThreadRunEvent: () => {},
    recordThreadAttribution: (codexThreadId, record) => {
      attributions.push({ codexThreadId, record });
    },
    dequeueSpawnPayloadMatching: ({ toolUseId }) =>
      toolUseId === "item_spawn_001" ? { agentRole: "explore", toolUseId } : undefined,
  });

  adapter.dispatch("item/started", {
    threadId: CODEX_THREAD,
    turnId: "turn_spawn_001",
    item: {
      type: "collabAgentToolCall",
      id: "item_spawn_001",
      tool: "spawnAgent",
      status: "inProgress",
      senderThreadId: CODEX_THREAD,
      receiverThreadIds: ["thr_codex_child_001"],
    },
  });
  adapter.dispatch("thread/started", {
    thread: {
      id: "thr_codex_child_001",
      parentThreadId: CODEX_THREAD,
      agentRole: "explore",
      agentNickname: "scout-1",
    },
  });

  expect(attributions).toHaveLength(2);
  expect(attributions[0]).toEqual({
    codexThreadId: "thr_codex_child_001",
    record: {
      parentThreadId: CODEX_THREAD,
      agentRole: "explore",
      spawnCallId: "item_spawn_001",
    },
  });
  expect(attributions[1]).toEqual({
    codexThreadId: "thr_codex_child_001",
    record: {
      parentThreadId: CODEX_THREAD,
      agentRole: "explore",
      agentNickname: "scout-1",
    },
  });
});

test("spawn-turn.jsonl fixture replays to expected agent lifecycle sequence", () => {
  const fixturePath = path.resolve(import.meta.dir, "fixtures/codex-item-stream/spawn-turn.jsonl");
  const fixture = fs.readFileSync(fixturePath, "utf8");
  const events = replayCodexNotificationFixture(fixture, {
    resolveEcoThreadId: (codexThreadId) =>
      codexThreadId === "thr_codex_parent_001" ? ECO_THREAD : codexThreadId,
    recordThreadRunEvent: () => {},
    dequeueSpawnPayloadMatching: ({ toolUseId }) =>
      toolUseId === "item_spawn_001" ? { agentRole: "explore", toolUseId } : undefined,
    now: () => "2026-07-03T12:00:00.000Z",
  });

  // The spawn RPC only confirms child creation. Child turn/completed owns the terminal lifecycle.
  // agent.started may be emitted once from collab, then enriched when nickname arrives.
  expect(events.map((event) => event.eventType).filter((type) => type !== "agent.started")).toEqual([
    "run.attempt.started",
    "run.attempt.completed",
  ]);
  expect(events.some((event) => event.eventType === "agent.started")).toBe(true);

  const startedEvents = events.filter((event) => event.eventType === "agent.started");
  expect(startedEvents.length).toBeGreaterThanOrEqual(1);
  expect(startedEvents.some((event) => event.metadata?.agentNickname === "scout-1")).toBe(true);
  expect(
    startedEvents.some(
      (event) => event.metadata?.delegationPrompt === "Explore the auth module and list key entry points.",
    ),
  ).toBe(true);
  const started = startedEvents[0];
  expect(started?.threadId).toBe(ECO_THREAD);
  expect(started?.role).toBe("explore");
  expect(started?.agentId).toBe("thr_codex_child_explore_001");
  expect(started?.parentToolUseId).toBe("item_spawn_001");
});

test("dispatch maps commandExecution lifecycle to tool.started and tool.completed", () => {
  const events = collectEvents((record) => {
    const adapter = new CodexEventAdapter({ resolveEcoThreadId, recordThreadRunEvent: record });
    adapter.dispatch("item/started", {
      threadId: CODEX_THREAD,
      turnId: "turn_bash_001",
      item: {
        type: "commandExecution",
        id: "item_bash_001",
        processId: "process-bash-001",
        command: "git status",
        cwd: "/repo",
        commandActions: [{ type: "listFiles", command: "git status", path: "/repo" }],
        status: "inProgress",
      },
    });
    adapter.dispatch("item/completed", {
      threadId: CODEX_THREAD,
      turnId: "turn_bash_001",
      item: {
        type: "commandExecution",
        id: "item_bash_001",
        processId: "process-bash-001",
        command: "git status",
        commandActions: [{ type: "listFiles", command: "git status", path: "/repo" }],
        status: "completed",
        aggregatedOutput: "clean\n",
        exitCode: 0,
        durationMs: 12,
      },
    });
  });

  expect(events.map((event) => event.eventType)).toEqual(["tool.started", "tool.completed"]);
  expect(events.every((event) => event.streamKey === "item_bash_001")).toBe(true);
  expect(events[0]?.metadata?.tool).toMatchObject({
    name: "Bash",
    detail: "git status",
    description: "列出文件 · /repo",
    toolUseId: "item_bash_001",
    processId: "process-bash-001",
    status: "started",
  });
  expect(events[1]?.metadata?.tool).toMatchObject({
    name: "Bash",
    detail: "git status",
    description: "列出文件 · /repo",
    toolUseId: "item_bash_001",
    processId: "process-bash-001",
    status: "completed",
    exitCode: 0,
    durationMs: 12,
  });
});

test("command output deltas stay bounded in memory and only completed shell commands persist a preview", () => {
  const events = collectEvents((record) => {
    const adapter = new CodexEventAdapter({ resolveEcoThreadId, recordThreadRunEvent: record });
    adapter.dispatch("item/started", {
      threadId: CODEX_THREAD,
      turnId: "turn_bash_preview",
      item: {
        type: "commandExecution",
        id: "item_bash_preview",
        command: "bun test",
        status: "inProgress",
        commandActions: [],
      },
    });
    adapter.dispatch("item/commandExecution/outputDelta", {
      threadId: CODEX_THREAD,
      turnId: "turn_bash_preview",
      itemId: "item_bash_preview",
      delta: `head\n${"x".repeat(20_000)}`,
    });
    adapter.dispatch("item/commandExecution/outputDelta", {
      threadId: CODEX_THREAD,
      turnId: "turn_bash_preview",
      itemId: "item_bash_preview",
      delta: "\ntail",
    });
    adapter.dispatch("item/completed", {
      threadId: CODEX_THREAD,
      turnId: "turn_bash_preview",
      item: {
        type: "commandExecution",
        id: "item_bash_preview",
        command: "bun test",
        status: "completed",
        commandActions: [],
        exitCode: 0,
      },
    });
  });

  expect(events.map((event) => event.eventType)).toEqual(["tool.started", "tool.completed"]);
  const preview = events[1]?.metadata?.tool as Record<string, unknown>;
  expect(preview.outputPreviewTruncated).toBe(true);
  expect(String(preview.outputPreview)).toStartWith("head\n");
  expect(String(preview.outputPreview)).toEndWith("\ntail");
  expect(String(preview.outputPreview).length).toBeLessThanOrEqual(8_000);
});

test("read and search command actions discard aggregated output and keep structured targets", () => {
  const events = collectEvents((record) => {
    const adapter = new CodexEventAdapter({ resolveEcoThreadId, recordThreadRunEvent: record });
    for (const item of [
      {
        id: "item_read_projection",
        command: "sed -n '10,20p' src/main.ts",
        commandActions: [{ type: "read", path: "src/main.ts" }],
      },
      {
        id: "item_search_projection",
        command: "rg needle src",
        commandActions: [{ type: "search", query: "needle", path: "src" }],
      },
    ]) {
      adapter.dispatch("item/completed", {
        threadId: CODEX_THREAD,
        turnId: "turn_read_only_projection",
        item: {
          type: "commandExecution",
          status: "completed",
          aggregatedOutput: "source contents that must not persist",
          exitCode: 0,
          durationMs: 9,
          ...item,
        },
      });
    }
  });

  expect(events).toHaveLength(2);
  const read = events[0]?.metadata?.tool as Record<string, unknown>;
  const search = events[1]?.metadata?.tool as Record<string, unknown>;
  expect(read).not.toHaveProperty("outputPreview");
  expect(read.readTarget).toEqual({ filePath: "src/main.ts" });
  expect(search).not.toHaveProperty("outputPreview");
  expect(search.grepTarget).toEqual({ pattern: "needle", path: "src" });
});

test("failed shell commands keep exit metadata and a bounded output preview", () => {
  const events = collectEvents((record) => {
    const adapter = new CodexEventAdapter({ resolveEcoThreadId, recordThreadRunEvent: record });
    adapter.dispatch("item/completed", {
      threadId: CODEX_THREAD,
      turnId: "turn_bash_failed",
      item: {
        type: "commandExecution",
        id: "item_bash_failed",
        command: "bun test",
        status: "failed",
        commandActions: [],
        aggregatedOutput: `failure head\n${"x".repeat(20_000)}\nfailure tail`,
        exitCode: 1,
        durationMs: 42,
      },
    });
  });

  expect(events).toHaveLength(1);
  expect(events[0]?.eventType).toBe("tool.failed");
  const tool = events[0]?.metadata?.tool as Record<string, unknown>;
  expect(tool.exitCode).toBe(1);
  expect(tool.durationMs).toBe(42);
  expect(tool.outputPreviewTruncated).toBe(true);
  expect(String(tool.outputPreview)).toStartWith("failure head\n");
  expect(String(tool.outputPreview)).toEndWith("\nfailure tail");
  expect(String(tool.outputPreview).length).toBeLessThanOrEqual(8_000);
});

test("dispatch maps plan item completed to thread.status plan.ready", () => {
  const planReady = mock();
  const events = collectEvents((record) => {
    const adapter = new CodexEventAdapter({
      resolveEcoThreadId,
      recordThreadRunEvent: record,
      onPlanReady: planReady,
    });
    adapter.dispatch("item/completed", {
      threadId: CODEX_THREAD,
      turnId: "turn_plan_001",
      item: {
        type: "plan",
        id: "item_plan_001",
        text: "## Plan\n\nShip it.",
        planFilePath: ".codex/plan.md",
      },
    });
  });

  expect(events).toHaveLength(1);
  expect(events[0]?.eventType).toBe("thread.status");
  expect(events[0]?.role).toBe("main");
  expect(events[0]?.message).toBe("计划已生成，等待确认。");
  expect(events[0]?.metadata?.liveType).toBe("plan.ready");
  expect(events[0]?.metadata?.plan).toEqual({
    plan: "## Plan\n\nShip it.",
    planFilePath: ".codex/plan.md",
  });
  expect(planReady).toHaveBeenCalledWith({
    ecoThreadId: ECO_THREAD,
    codexThreadId: CODEX_THREAD,
    turnId: "turn_plan_001",
    itemId: "item_plan_001",
    plan: "## Plan\n\nShip it.",
    planFilePath: ".codex/plan.md",
  });
});

test("dispatch maps contextCompaction item lifecycle with Codex correlation metadata", () => {
  const events = collectEvents((record) => {
    const adapter = new CodexEventAdapter({ resolveEcoThreadId, recordThreadRunEvent: record });
    adapter.dispatch("item/started", {
      threadId: CODEX_THREAD,
      turnId: "turn_compact_001",
      item: { type: "contextCompaction", id: "item_compact_001" },
      startedAtMs: 1_788_000_000_000,
    });
    adapter.dispatch("item/completed", {
      threadId: CODEX_THREAD,
      turnId: "turn_compact_001",
      item: { type: "contextCompaction", id: "item_compact_001" },
      completedAtMs: 1_788_000_000_100,
    });
  });

  expect(events.map((event) => event.eventType)).toEqual([
    "context.compaction.started",
    "context.compaction.completed",
  ]);
  expect(events.map((event) => event.streamState)).toEqual(["none", "finalized"]);
  expect(events.map((event) => event.message)).toEqual(["正在压缩上下文", "上下文已压缩"]);
  expect(events.every((event) => event.threadId === ECO_THREAD)).toBe(true);
  expect(events.every((event) => event.runAttemptId === undefined)).toBe(true);
  expect(events.every((event) => event.metadata?.turnId === "turn_compact_001")).toBe(true);
  expect(events.every((event) => event.streamKey === "item_compact_001")).toBe(true);
  expect(events.map((event) => event.metadata)).toEqual([
    {
      codexMethod: "item/started",
      codexThreadId: CODEX_THREAD,
      logicalEntityId: "item_compact_001",
      itemId: "item_compact_001",
      itemType: "contextCompaction",
      turnId: "turn_compact_001",
    },
    {
      codexMethod: "item/completed",
      codexThreadId: CODEX_THREAD,
      logicalEntityId: "item_compact_001",
      itemId: "item_compact_001",
      itemType: "contextCompaction",
      turnId: "turn_compact_001",
    },
  ]);
});

test("dispatch ignores malformed contextCompaction items without lifecycle ids", () => {
  const events = collectEvents((record) => {
    const adapter = new CodexEventAdapter({ resolveEcoThreadId, recordThreadRunEvent: record });
    adapter.dispatch("item/started", {
      threadId: CODEX_THREAD,
      turnId: "turn_compact_001",
      item: { type: "contextCompaction" },
    });
    adapter.dispatch("item/completed", {
      threadId: CODEX_THREAD,
      item: { type: "contextCompaction", id: "item_compact_001" },
    });
  });

  expect(events).toEqual([]);
});

test("dispatch invokes onTokenUsageUpdated for thread/tokenUsage/updated", () => {
  let contextUpdate: unknown;
  const adapter = new CodexEventAdapter({
    resolveEcoThreadId,
    recordThreadRunEvent: () => {},
    onTokenUsageUpdated: (resolution) => {
      contextUpdate = resolution;
    },
  });
  adapter.dispatch("thread/tokenUsage/updated", {
    threadId: CODEX_THREAD,
    turnId: "turn_001",
    tokenUsage: {
      last: {
        cachedInputTokens: 0,
        inputTokens: 10_000,
        outputTokens: 500,
        reasoningOutputTokens: 0,
        totalTokens: 42_000,
      },
      total: {
        cachedInputTokens: 0,
        inputTokens: 10_000,
        outputTokens: 500,
        reasoningOutputTokens: 0,
        totalTokens: 42_000,
      },
      modelContextWindow: 200_000,
    },
  });

  expect(contextUpdate).toBeDefined();
  const resolved = contextUpdate as {
    ecoThreadId: string;
    contextOccupied: number;
    context: { segments: unknown[] };
  };
  expect(resolved.ecoThreadId).toBe(ECO_THREAD);
  expect(resolved.contextOccupied).toBe(42_000);
  expect(resolved.context.segments).toEqual([]);
});

test("dispatch maps model safety buffering and auth recovery to thread.status", () => {
  const events = collectEvents((record) => {
    const adapter = new CodexEventAdapter({ resolveEcoThreadId, recordThreadRunEvent: record });
    adapter.dispatch("model/safetyBuffering/updated", {
      threadId: CODEX_THREAD,
      useCases: ["cyber"],
      reasons: ["user_risk"],
    });
    adapter.dispatch("modelProvider/authRecoveryStarted", {
      threadId: CODEX_THREAD,
      provider: "bedrock",
    });
    adapter.dispatch("modelProvider/authRecoveryCompleted", {
      threadId: CODEX_THREAD,
      provider: "bedrock",
    });
  });

  expect(events.map((event) => event.eventType)).toEqual([
    "thread.status",
    "thread.status",
    "thread.status",
  ]);
  expect(events[0]?.metadata?.liveType).toBe("codex.safety_buffering");
  expect(events[0]?.message).toContain("cyber");
  expect(events[1]?.metadata?.liveType).toBe("codex.auth_recovery");
  expect(events[1]?.message).toContain("Refreshing credentials");
  expect(events[2]?.message).toContain("Credential refresh finished");
});

/**
 * Codex 0.160 `request_user_input_async`: the model's questions arrive as an `agentMessage`
 * item (`id` = tool call id, `delivery: "async"`, `phase: "final_answer"`) instead of a
 * server request. Upstream emits the same item on `item/started` and `item/completed`.
 */
const ASYNC_QUESTIONS_ITEM = {
  type: "agentMessage",
  id: "item_async_q",
  text: "需要确认两件事",
  phase: "final_answer",
  delivery: "async",
  questions: [
    { title: "用哪个包管理器？", options: ["bun", "npm"] },
    { title: "是否需要迁移历史数据？", options: null },
  ],
};

test("dispatch surfaces async questions from item/started and item/completed", () => {
  const seen: Array<{ ecoThreadId: string; itemId: string; turnId?: string | undefined; titles: string[] }> = [];
  const adapter = new CodexEventAdapter({
    resolveEcoThreadId,
    recordThreadRunEvent: () => {},
    onAsyncQuestions: (input) =>
      seen.push({
        ecoThreadId: input.ecoThreadId,
        itemId: input.itemId,
        turnId: input.turnId,
        titles: input.questions.map((question) => question.title),
      }),
  });

  adapter.dispatch("item/started", {
    threadId: CODEX_THREAD,
    turnId: "turn_async",
    item: ASYNC_QUESTIONS_ITEM,
  });
  adapter.dispatch("item/completed", {
    threadId: CODEX_THREAD,
    turnId: "turn_async",
    item: ASYNC_QUESTIONS_ITEM,
  });

  expect(seen).toHaveLength(2);
  expect(seen[0]).toEqual({
    ecoThreadId: ECO_THREAD,
    itemId: "item_async_q",
    turnId: "turn_async",
    titles: ["用哪个包管理器？", "是否需要迁移历史数据？"],
  });
  // The same item twice: deduplication is the consumer's job (thread + turn + item id).
  expect(seen[1]).toEqual(seen[0]);
});

test("dispatch ignores ordinary agent messages and malformed question payloads", () => {
  const seen: string[] = [];
  const adapter = new CodexEventAdapter({
    resolveEcoThreadId,
    recordThreadRunEvent: () => {},
    onAsyncQuestions: (input) => seen.push(input.itemId),
  });

  adapter.dispatch("item/completed", {
    threadId: CODEX_THREAD,
    turnId: "turn_async",
    item: { type: "agentMessage", id: "item_plain", text: "普通回复" },
  });
  // `delivery: "async"` but no questions: not a question message.
  adapter.dispatch("item/completed", {
    threadId: CODEX_THREAD,
    turnId: "turn_async",
    item: { type: "agentMessage", id: "item_no_q", text: "x", delivery: "async", questions: [] },
  });
  // Questions without a title cannot be addressed back to the model.
  adapter.dispatch("item/completed", {
    threadId: CODEX_THREAD,
    turnId: "turn_async",
    item: {
      type: "agentMessage",
      id: "item_bad_q",
      text: "x",
      delivery: "async",
      questions: [{ options: ["a"] }],
    },
  });
  // Sync delivery on an agent message is not an async question.
  adapter.dispatch("item/completed", {
    threadId: CODEX_THREAD,
    turnId: "turn_async",
    item: { ...ASYNC_QUESTIONS_ITEM, id: "item_sync", delivery: "sync" },
  });

  expect(seen).toEqual([]);
});

test("async questions from an unmapped Codex thread flush once the mapping lands", () => {
  const seen: Array<{ ecoThreadId: string; itemId: string }> = [];
  let mapping: string | undefined;
  const adapter = new CodexEventAdapter({
    resolveEcoThreadId: (codexThreadId) => mapping ?? codexThreadId,
    recordThreadRunEvent: () => {},
    onAsyncQuestions: (input) => seen.push({ ecoThreadId: input.ecoThreadId, itemId: input.itemId }),
  });

  adapter.dispatch("item/completed", {
    threadId: "codex_unmapped_thread",
    turnId: "turn_async",
    item: { ...ASYNC_QUESTIONS_ITEM, id: "item_pending_q" },
  });
  expect(seen).toEqual([]);

  mapping = "thr_eco_after_map";
  adapter.flushPendingEventsForThread("codex_unmapped_thread");
  expect(seen).toEqual([{ ecoThreadId: "thr_eco_after_map", itemId: "item_pending_q" }]);
});
