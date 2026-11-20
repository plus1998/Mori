import { describe, expect, test } from "bun:test";
import {
  extractAnthropicRequestToolNames,
  normalizeFunctionCallNameForRequest,
} from "../src/anthropic-to-responses.js";
import {
  newResponsesEventToAnthropicState,
  responsesEventToAnthropicEvents,
  responsesToAnthropic,
} from "../src/responses-to-anthropic.js";

describe("function call name normalization", () => {
  test("maps short MCP tool names back to request allowlist ids", () => {
    const requestTools = ["mcp__mori_plan__finalize_plan", "Read"];
    expect(normalizeFunctionCallNameForRequest("finalize_plan", requestTools)).toBe(
      "mcp__mori_plan__finalize_plan",
    );
    expect(normalizeFunctionCallNameForRequest("Read", requestTools)).toBe("Read");
  });

  test("extractAnthropicRequestToolNames reads tool definitions", () => {
    expect(
      extractAnthropicRequestToolNames({
        model: "gpt-5.5",
        max_tokens: 1024,
        messages: [],
        tools: [{ name: "mcp__mori_plan__finalize_plan", input_schema: { type: "object" } }],
      }),
    ).toEqual(["mcp__mori_plan__finalize_plan"]);
  });

  test("responsesToAnthropic normalizes function_call names", () => {
    const anthropic = responsesToAnthropic(
      {
        id: "resp_1",
        object: "response",
        model: "gpt-5.5",
        status: "completed",
        output: [
          {
            type: "function_call",
            call_id: "call_abc",
            name: "finalize_plan",
            arguments: '{"analysis":"a","plan":"b"}',
          },
        ],
      },
      "gpt-5.5",
      ["mcp__mori_plan__finalize_plan"],
    );
    const toolUse = anthropic.content.find((block) => block.type === "tool_use");
    expect(toolUse?.name).toBe("mcp__mori_plan__finalize_plan");
    expect(anthropic.stop_reason).toBe("tool_use");
  });
});

describe("responses stream tool arguments on output_item.done", () => {
  test("emits tool input when upstream only sends arguments on output_item.done", () => {
    const requestTools = ["mcp__mori_plan__finalize_plan"];
    const state = newResponsesEventToAnthropicState(requestTools);
    const push = (evt: Parameters<typeof responsesEventToAnthropicEvents>[0]) =>
      responsesEventToAnthropicEvents(evt, state);

    const events = [
      ...push({
        type: "response.created",
        response: { id: "r1", model: "m", status: "in_progress", output: [] },
      }),
      ...push({
        type: "response.output_item.added",
        output_index: 0,
        item: {
          type: "function_call",
          call_id: "call_abc",
          name: "finalize_plan",
        },
      }),
      ...push({
        type: "response.output_item.done",
        output_index: 0,
        item: {
          type: "function_call",
          call_id: "call_abc",
          name: "finalize_plan",
          arguments: '{"analysis":"summary","plan":"steps"}',
        },
      }),
      ...push({
        type: "response.completed",
        response: { id: "r1", model: "m", status: "completed", output: [] },
      }),
    ];

    const toolStart = events.find(
      (event) => event.type === "content_block_start" && event.content_block?.type === "tool_use",
    );
    expect(toolStart?.content_block?.name).toBe("mcp__mori_plan__finalize_plan");

    const toolDelta = events.find(
      (event) =>
        event.type === "content_block_delta" &&
        event.delta?.type === "input_json_delta" &&
        event.delta.partial_json?.includes('"plan":"steps"'),
    );
    expect(toolDelta).toBeDefined();
    expect(
      events.some((event) => event.type === "message_delta" && event.delta?.stop_reason === "tool_use"),
    ).toBe(true);
  });
});
