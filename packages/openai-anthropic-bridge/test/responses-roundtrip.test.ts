import { describe, expect, test } from "bun:test";
import { anthropicToResponses } from "../src/anthropic-to-responses.js";
import {
  chatCompletionsResponseToResponses,
  responsesToChatCompletionsRequest,
} from "../src/chat-completions-responses-bridge.js";
import { chatCompletionsToResponses } from "../src/chat-completions-to-responses.js";
import { responsesToAnthropic } from "../src/responses-to-anthropic.js";
import { responsesToAnthropicRequest } from "../src/responses-to-anthropic-request.js";
import { responsesToChatCompletions } from "../src/responses-to-chat-completions.js";
import type { ChatCompletionsRequest, ResponsesRequest, ResponsesResponse } from "../src/types.js";

describe("roundtrip", () => {
  test("non-streaming duplicate upstream call IDs keep separate tool results", () => {
    const response: ResponsesResponse = {
      id: "resp_duplicate_calls",
      object: "response",
      model: "model",
      status: "completed",
      output: [
        { type: "function_call", id: "fc_1", call_id: "call_same", name: "Read", arguments: '{"file_path":"a"}' },
        { type: "function_call", id: "fc_2", call_id: "call_same", name: "Read", arguments: '{"file_path":"b"}' },
      ],
    };
    const anthropic = responsesToAnthropic(response, "model");
    expect(anthropic.content.filter((block) => block.type === "tool_use").map((block) => block.id))
      .toEqual(["call_same", "call_same__eco_2"]);
  });

  test("chat completions text roundtrip via responses hub", () => {
    const chatReq: ChatCompletionsRequest = {
      model: "gpt-5.2",
      messages: [
        { role: "system", content: "You are helpful." },
        { role: "user", content: "Hello" },
      ],
      stream: false,
    };

    const responsesReq = chatCompletionsToResponses(chatReq);
    expect(Array.isArray(responsesReq.input)).toBe(true);
    expect(responsesReq.instructions).toBe("You are helpful.");
    const upstreamStyle: ResponsesResponse = {
      id: "resp_1",
      object: "response",
      model: "gpt-5.2",
      status: "completed",
      output: [
        {
          type: "message",
          id: "msg_1",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "Hi there!" }],
        },
      ],
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        total_tokens: 15,
      },
    };

    const chatResp = responsesToChatCompletions(upstreamStyle, "gpt-5.2");
    expect(chatResp.choices[0]?.message.content).toBeDefined();
    const content =
      typeof chatResp.choices[0]?.message.content === "string"
        ? chatResp.choices[0].message.content
        : JSON.stringify(chatResp.choices[0]?.message.content);
    expect(content).toContain("Hi there!");
  });

  test("chat completions assistant text and reasoning_items survive request roundtrip", () => {
    const chatReq: ChatCompletionsRequest = {
      model: "gpt-5.2",
      messages: [
        { role: "system", content: "System prompt" },
        { role: "user", content: "Use the tool" },
        {
          role: "assistant",
          content: "I will call it.",
          reasoning_items: [
            {
              type: "reasoning",
              id: "rs_keep",
              encrypted_content: "encrypted-state",
              summary: [{ type: "summary_text", text: "Need tool" }],
            },
          ],
          tool_calls: [
            {
              id: "call_keep",
              type: "function",
              function: { name: "lookup", arguments: '{"q":"x"}' },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_keep", content: "tool result" },
      ],
    };

    const responsesReq = chatCompletionsToResponses(chatReq);
    const items = responsesReq.input as Record<string, unknown>[];
    expect(responsesReq.instructions).toBe("System prompt");
    expect(items.find((item) => item.type === "reasoning")).toMatchObject({
      id: "rs_keep",
      encrypted_content: "encrypted-state",
    });
    const assistantMessage = items.find((item) => item.type === "message" && item.role === "assistant");
    expect(assistantMessage?.content).toEqual([{ type: "output_text", text: "I will call it." }]);

    const back = responsesToChatCompletionsRequest(responsesReq);
    const assistant = back.messages.find((m) => (m.tool_calls?.length ?? 0) > 0);
    expect(assistant?.reasoning_content).toBe("Need tool");
    expect(assistant?.reasoning_items?.[0]?.encrypted_content).toBe("encrypted-state");
  });

  test("anthropic request converts to anthropic-shaped request via responses", () => {
    const responsesReq = anthropicToResponses({
      model: "claude-sonnet-4",
      max_tokens: 256,
      messages: [{ role: "user", content: "Ping" }],
      output_config: { effort: "high" },
    });

    const back = responsesToAnthropicRequest(responsesReq);
    expect(back.model).toBe("claude-sonnet-4");
    expect(back.max_tokens).toBe(256);
    expect(back.messages).toEqual([{ role: "user", content: [{ type: "text", text: "Ping" }] }]);
  });

  test("consecutive Responses messages remain Anthropic content block arrays after merging", () => {
    const anthropic = responsesToAnthropicRequest({
      model: "claude-sonnet-4",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "first" }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "second" }] },
      ],
    });

    expect(anthropic.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "first" },
          { type: "text", text: "second" },
        ],
      },
    ]);
  });

  test("responses instructions become anthropic system prompt", () => {
    const responsesReq: ResponsesRequest = {
      model: "claude-sonnet-4",
      instructions: "Follow system.",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Ping" }] }],
      max_output_tokens: 128,
    };

    const anthropic = responsesToAnthropicRequest(responsesReq);
    expect(anthropic.system).toBe("Follow system.");
    expect(anthropic.messages).toHaveLength(1);
  });

  test("responses function_call_output list maps to chat tool text and anthropic tool_result blocks", () => {
    const responsesReq: ResponsesRequest = {
      model: "gpt-5.2",
      input: [
        { type: "function_call", call_id: "call_list", name: "lookup", arguments: '{"q":"x"}' },
        {
          type: "function_call_output",
          call_id: "call_list",
          output: [{ type: "input_text", text: "list result" }],
        },
      ],
    };

    const chat = responsesToChatCompletionsRequest(responsesReq);
    expect(chat.messages.find((m) => m.role === "tool")?.content).toBe("list result");

    const anthropic = responsesToAnthropicRequest(responsesReq);
    const toolResultMessage = anthropic.messages.find((m) => m.role === "user");
    const blocks = toolResultMessage?.content as Array<{
      type: string;
      content?: unknown;
    }>;
    expect(blocks[0]?.type).toBe("tool_result");
    expect(blocks[0]?.content).toEqual([{ type: "text", text: "list result" }]);
  });

  test("Anthropic history keeps the parse failure without replaying the rejected tool call", () => {
    const failedCall = {
      type: "function_call",
      call_id: "call_invalid",
      name: "call_tool",
      arguments: '{"arguments": , "name": "mori_agent_browser:agent_browser_snapshot"}',
    };
    const failedOutput = {
      type: "function_call_output",
      call_id: "call_invalid",
      output: [
        { type: "input_text", text: "Wall time: 0.0001 seconds\nOutput:" },
        { type: "input_text", text: "err: expected value at line 1 column 15" },
      ],
    };
    const followUp = {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Try again." }],
    };
    const request = responsesToAnthropicRequest({
      model: "claude-test",
      input: [
        { type: "function_call", call_id: "call_valid", name: "lookup", arguments: '{"q":"x"}' },
        failedCall,
        failedOutput,
        { type: "function_call_output", call_id: "call_valid", output: "found" },
        followUp,
      ],
    });
    expect(request.messages).toEqual([
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "call_valid", name: "lookup", input: { q: "x" } }],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "call_valid", content: "found" },
          { type: "text", text: expect.stringContaining("err: expected value at line 1 column 15") },
          { type: "text", text: "Try again." },
        ],
      },
    ]);
    expect(() => responsesToAnthropicRequest({
      model: "claude-test",
      input: [failedCall, { ...failedOutput, output: "found" }, followUp],
    })).toThrow();
  });

  test("responses reasoning summary and encrypted_content roundtrip through anthropic blocks", () => {
    const anthropic = responsesToAnthropic(
      {
        id: "resp_reasoning",
        object: "response",
        model: "gpt-5.2",
        status: "completed",
        output: [
          {
            type: "reasoning",
            id: "rs_1",
            encrypted_content: "ciphertext",
            summary: [{ type: "summary_text", text: "private summary" }],
          },
        ],
      },
      "gpt-5.2",
    );

    expect(anthropic.content).toEqual([
      { type: "thinking", thinking: "private summary" },
      { type: "redacted_thinking", data: "ciphertext" },
    ]);

    const responsesReq = anthropicToResponses({
      model: "gpt-5.2",
      max_tokens: 128,
      messages: [{ role: "assistant", content: anthropic.content }],
    });
    const reasoningItems = (responsesReq.input as Record<string, unknown>[]).filter(
      (item) => item.type === "reasoning",
    );
    expect(reasoningItems[0]).toMatchObject({
      summary: [],
      content: [{ type: "reasoning_text", text: "private summary" }],
    });
    expect(reasoningItems[1]?.encrypted_content).toBe("ciphertext");
  });

  test("responses reasoning summary strips upstream HTML comment artifacts", () => {
    const anthropic = responsesToAnthropic(
      {
        id: "resp_reasoning_comment",
        object: "response",
        model: "gpt-5.6-sol",
        status: "completed",
        output: [
          {
            type: "reasoning",
            id: "rs_comment",
            summary: [
              {
                type: "summary_text",
                text: "**Determining unique true statement**\n\n<!-- -->",
              },
            ],
          },
        ],
      },
      "gpt-5.6-sol",
    );

    expect(anthropic.content).toEqual([
      { type: "thinking", thinking: "**Determining unique true statement**\n\n" },
    ]);
  });

  test("responses reasoning_text content becomes anthropic thinking", () => {
    const anthropic = responsesToAnthropic(
      {
        id: "resp_reasoning_content",
        object: "response",
        model: "gpt-5.2",
        status: "completed",
        output: [
          {
            type: "reasoning",
            id: "rs_content",
            content: [{ type: "reasoning_text", text: "raw reasoning content" }],
          },
        ],
      },
      "gpt-5.2",
    );

    expect(anthropic.content).toEqual([{ type: "thinking", thinking: "raw reasoning content" }]);
  });

  test("chat reasoning effort requests an auto summary for response parsing", () => {
    const responses = chatCompletionsToResponses({
      model: "gpt-5.2",
      messages: [{ role: "user", content: "hi" }],
      reasoning_effort: "high",
    });

    expect(responses.reasoning).toEqual({ effort: "high", summary: "auto" });
  });

  test("treats null Responses reasoning as unset", () => {
    const anthropic = responsesToAnthropicRequest({
      model: "claude-sonnet-4-20250514",
      input: JSON.stringify("Hi"),
      reasoning: null,
    });

    expect(anthropic.thinking).toBeUndefined();
    expect(anthropic.output_config).toBeUndefined();
  });

  test("treats Responses reasoning without effort as unset", () => {
    const anthropic = responsesToAnthropicRequest({
      model: "claude-sonnet-4-20250514",
      input: JSON.stringify("Hi"),
      reasoning: {},
    });

    expect(anthropic.thinking).toBeUndefined();
    expect(anthropic.output_config).toBeUndefined();
  });

  test("anthropic user text survives anthropic → responses → chat completions", () => {
    const responsesReq = anthropicToResponses({
      model: "glm-5.1",
      max_tokens: 256,
      messages: [{ role: "user", content: "hi" }],
    });
    responsesReq.stream = false;

    const chatReq = responsesToChatCompletionsRequest(responsesReq);
    expect(chatReq.messages).toEqual([{ role: "user", content: "hi" }]);
    expect(chatReq.max_tokens).toBe(256);
    expect(chatReq.max_completion_tokens).toBe(256);
  });

  test("chat completions response with null usage details converts safely", () => {
    const raw = {
      id: "chatcmpl-test",
      object: "chat.completion",
      model: "z-ai/glm-5.1",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "pong",
          },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: 6,
        total_tokens: 48,
        completion_tokens: 42,
        prompt_tokens_details: null,
      },
    };

    const responses = chatCompletionsResponseToResponses(raw, raw.model);
    expect(responses.output[0]?.content?.[0]?.text).toBe("pong");
  });

  test("chat completions reasoning field becomes anthropic thinking", () => {
    const raw = {
      id: "gen-test",
      object: "chat.completion",
      model: "xiaomi/mimo",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "",
            reasoning: "Visible fallback reply",
          },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    };

    const anthropic = responsesToAnthropic(chatCompletionsResponseToResponses(raw, raw.model), raw.model);
    expect(anthropic.content).toEqual([{ type: "thinking", thinking: "Visible fallback reply" }]);
  });
});
