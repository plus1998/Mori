import { describe, expect, test } from "bun:test";
import { anthropicToResponses } from "../src/anthropic-to-responses.js";
import { responsesToChatCompletionsRequest } from "../src/chat-completions-responses-bridge.js";
import { jsonParse } from "../src/json.js";
import type { ResponsesContentPart, ResponsesInputItem } from "../src/types.js";

function responseInputItems(resp: { input: unknown }): ResponsesInputItem[] {
  expect(Array.isArray(resp.input)).toBe(true);
  return resp.input as ResponsesInputItem[];
}

function responseContentParts(raw: unknown): ResponsesContentPart[] {
  if (Array.isArray(raw)) {
    return raw as ResponsesContentPart[];
  }
  if (typeof raw === "string") {
    return jsonParse<ResponsesContentPart[]>(raw);
  }
  throw new Error("expected Responses content parts");
}

describe("anthropicToResponses", () => {
  test("basic text user message", () => {
    const resp = anthropicToResponses({
      model: "gpt-5.2",
      max_tokens: 1024,
      stream: true,
      messages: [{ role: "user", content: "Hello" }],
    });

    expect(resp.model).toBe("gpt-5.2");
    expect(resp.stream).toBe(true);
    expect(resp.max_output_tokens).toBe(1024);
    expect(resp.store).toBe(false);

    const items = responseInputItems(resp);
    expect(items).toHaveLength(1);
    expect(items[0]?.type).toBe("message");
    expect(items[0]?.role).toBe("user");
    const parts = responseContentParts(items[0]?.content);
    expect(parts).toHaveLength(1);
    expect(parts[0]?.type).toBe("input_text");
    expect(parts[0]?.text).toBe("Hello");
  });

  test("emits Responses input as an array, not a JSON string", () => {
    const resp = anthropicToResponses({
      model: "gpt-5.2",
      max_tokens: 128,
      messages: [{ role: "user", content: "Hello" }],
    });

    expect(Array.isArray(resp.input)).toBe(true);
    expect(typeof resp.input).not.toBe("string");
  });

  test("system prompt as Responses instructions", () => {
    const resp = anthropicToResponses({
      model: "gpt-5.2",
      max_tokens: 100,
      messages: [{ role: "user", content: "Hi" }],
      system: "You are helpful.",
    });

    const items = responseInputItems(resp);
    expect(items).toHaveLength(1);
    expect(items[0]?.role).toBe("user");
    expect(resp.instructions).toBe("You are helpful.");
  });

  test("skips anthropic billing header in system", () => {
    const resp = anthropicToResponses({
      model: "gpt-5.2",
      max_tokens: 100,
      messages: [{ role: "user", content: "Hi" }],
      system: [
        { type: "text", text: "x-anthropic-billing-header: cc_version=1;" },
        { type: "text", text: "Project prompt" },
      ],
    });

    const items = responseInputItems(resp);
    expect(items).toHaveLength(1);
    expect(resp.instructions).toBe("Project prompt");
  });

  test("tool use round-trip shape", () => {
    const resp = anthropicToResponses({
      model: "gpt-5.2",
      max_tokens: 1024,
      messages: [
        { role: "user", content: "What is the weather?" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Let me check." },
            {
              type: "tool_use",
              id: "call_1",
              name: "get_weather",
              input: { city: "NYC" },
            },
          ],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "call_1", content: "Sunny, 72°F" }],
        },
      ],
      tools: [
        {
          name: "get_weather",
          description: "Get weather",
          input_schema: { type: "object", properties: { city: { type: "string" } } },
        },
      ],
    });

    const items = responseInputItems(resp);
    const fc = items.find((i) => i.type === "function_call");
    expect(fc?.call_id).toBe("call_1");
    expect(fc?.name).toBe("get_weather");
    const out = items.find((i) => i.type === "function_call_output");
    expect(out?.output).toContain("Sunny");
  });

  test("omits reasoning when thinking is disabled", () => {
    const resp = anthropicToResponses({
      model: "gpt-5.2",
      max_tokens: 256,
      messages: [{ role: "user", content: "hi" }],
      thinking: { type: "disabled" },
    });

    expect(resp.reasoning).toBeUndefined();
  });

  test("maps output_config effort to reasoning", () => {
    const resp = anthropicToResponses({
      model: "gpt-5.2",
      max_tokens: 256,
      messages: [{ role: "user", content: "hi" }],
      output_config: { effort: "high" },
    });

    expect(resp.reasoning).toEqual({ effort: "high", summary: "auto" });
  });

  test("preserves top-level max effort in Responses reasoning", () => {
    const resp = anthropicToResponses({
      model: "gpt-5.2",
      max_tokens: 256,
      messages: [{ role: "user", content: "hi" }],
      effort: "max",
      thinking: { type: "adaptive" },
    });

    expect(resp.reasoning).toEqual({ effort: "max", summary: "auto" });
  });

  test("preserves output_config max effort in Responses reasoning", () => {
    const resp = anthropicToResponses({
      model: "gpt-6.1-terra",
      max_tokens: 256,
      messages: [{ role: "user", content: "hi" }],
      output_config: { effort: "max" },
    });
    expect(resp.reasoning).toEqual({ effort: "max", summary: "auto" });
  });

  test("maps Anthropic thinking budget to Responses reasoning effort", () => {
    const resp = anthropicToResponses({
      model: "gpt-5.2",
      max_tokens: 256,
      messages: [{ role: "user", content: "hi" }],
      thinking: { type: "enabled", budget_tokens: 4096 },
    });

    expect(resp.reasoning).toEqual({ effort: "high", summary: "auto" });
  });

  test("maps adaptive thinking to medium effort when no explicit effort is set", () => {
    const resp = anthropicToResponses({
      model: "gpt-5.2",
      max_tokens: 256,
      messages: [{ role: "user", content: "hi" }],
      thinking: { type: "adaptive" },
    });

    expect(resp.reasoning).toEqual({ effort: "medium", summary: "auto" });
  });

  test("omits reasoning when no effort is configured", () => {
    const resp = anthropicToResponses({
      model: "gpt-5.2",
      max_tokens: 256,
      messages: [{ role: "user", content: "hi" }],
    });

    expect(resp.reasoning).toBeUndefined();
  });

  test("maps web_search tool_choice to hosted web_search type", () => {
    const resp = anthropicToResponses({
      model: "gpt-5.5",
      max_tokens: 32000,
      messages: [{ role: "user", content: "Search the web" }],
      tools: [
        {
          type: "web_search_20250305",
          name: "web_search",
          allowed_domains: ["weather.com.cn", "tianqi.com"],
          max_uses: 8,
        },
      ],
      tool_choice: { type: "tool", name: "web_search" },
    });

    expect(resp.tool_choice).toEqual({ type: "web_search" });
    expect(resp.tools).toEqual([
      {
        type: "web_search",
        filters: { allowed_domains: ["weather.com.cn", "tianqi.com"] },
      },
    ]);
  });

  test("maps Anthropic any tool_choice to Responses required object", () => {
    const resp = anthropicToResponses({
      model: "gpt-5.2",
      max_tokens: 1024,
      messages: [{ role: "user", content: "hi" }],
      tool_choice: { type: "any" },
    });

    expect(resp.tool_choice).toBe("required");
  });

  test("keeps function tool_choice for non-web_search tools", () => {
    const resp = anthropicToResponses({
      model: "gpt-5.2",
      max_tokens: 1024,
      messages: [{ role: "user", content: "hi" }],
      tools: [
        {
          name: "get_weather",
          description: "Get weather",
          input_schema: { type: "object", properties: {} },
        },
      ],
      tool_choice: { type: "tool", name: "get_weather" },
    });

    expect(resp.tool_choice).toEqual({ type: "function", name: "get_weather" });
  });

  test("augments ExitPlanMode schema with required plan input", () => {
    const resp = anthropicToResponses({
      model: "gpt-5.2",
      max_tokens: 1024,
      messages: [{ role: "user", content: "Draft a plan" }],
      tools: [
        {
          name: "ExitPlanMode",
          description: "Exit plan mode",
          input_schema: {
            type: "object",
            properties: {
              allowedPrompts: { type: "array" },
            },
          },
        },
      ],
    });

    const tool = resp.tools?.find((candidate) => candidate.name === "ExitPlanMode");
    const params = tool?.parameters as
      | { properties?: Record<string, unknown>; required?: unknown }
      | undefined;

    expect(tool?.description).toContain("complete Markdown plan");
    expect(params?.properties?.allowedPrompts).toEqual({ type: "array" });
    expect(params?.properties?.plan).toMatchObject({
      type: "string",
      description: expect.stringContaining("Complete Markdown plan"),
    });
    expect(params?.properties?.planContent).toMatchObject({
      type: "string",
    });
    expect(params?.required).toContain("plan");
  });

  test("keeps augmented ExitPlanMode schema when targeting chat completions", () => {
    const responsesReq = anthropicToResponses({
      model: "gpt-5.2",
      max_tokens: 1024,
      messages: [{ role: "user", content: "Draft a plan" }],
      tools: [
        {
          name: "ExitPlanMode",
          input_schema: {
            type: "object",
            properties: {
              allowedPrompts: { type: "array" },
            },
          },
        },
      ],
    });

    const chatReq = responsesToChatCompletionsRequest(responsesReq);
    const exitPlanTool = chatReq.tools?.find((candidate) => candidate.function.name === "ExitPlanMode");
    const params = exitPlanTool?.function.parameters as
      | { properties?: Record<string, unknown>; required?: unknown }
      | undefined;

    expect(params?.properties?.plan).toMatchObject({
      type: "string",
    });
    expect(params?.required).toContain("plan");
  });

  test("does not promote Anthropic cache_control to a Responses top-level parameter", () => {
    const resp = anthropicToResponses({
      model: "gpt-5.2",
      max_tokens: 1024,
      cache_control: { type: "ephemeral" },
      system: [{ type: "text", text: "Project prompt", cache_control: { type: "ephemeral" } }],
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Use the cached context.",
              cache_control: { type: "ephemeral", ttl: "5m" },
            },
          ],
        },
      ],
      tools: [
        {
          name: "lookup",
          input_schema: { type: "object" },
          cache_control: { type: "ephemeral" },
        },
      ],
    });

    expect(resp).not.toHaveProperty("cache_control");
    expect(JSON.stringify(resp)).not.toContain('"cache_control"');
  });

  test("maps Anthropic structured output to Responses text.format", () => {
    const schema = {
      type: "object",
      properties: { decision: { type: "string", enum: ["allow", "deny"] } },
      required: ["decision"],
      additionalProperties: false,
    };
    const resp = anthropicToResponses({
      model: "gpt-5.6",
      max_tokens: 256,
      messages: [{ role: "user", content: "Review this action." }],
      output_format: { type: "json_schema", schema },
    });

    expect(resp.text).toEqual({
      verbosity: "medium",
      format: {
        type: "json_schema",
        name: "eco_structured_output",
        schema,
        strict: true,
      },
    });
  });

  test("maps compact context_management to Responses format and leaves clear_tool_uses to gateway polyfill", () => {
    const resp = anthropicToResponses({
      model: "gpt-5.2",
      max_tokens: 1024,
      messages: [{ role: "user", content: "hi" }],
      context_management: {
        edits: [
          {
            type: "clear_tool_uses_20250919",
            trigger: { type: "tool_uses", value: 3 },
          },
          {
            type: "compact_20260112",
            trigger: { type: "input_tokens", value: 150000 },
          },
        ],
      },
    });

    expect(resp.context_management).toEqual([{ type: "compaction", compact_threshold: 150000 }]);
  });
});
