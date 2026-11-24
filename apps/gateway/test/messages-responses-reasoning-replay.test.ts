import { expect, test } from "bun:test";
import type { AnthropicMessage, ResponsesInputItem, ResponsesResponse } from "@eco/openai-anthropic-bridge";
import { GATEWAY_PROVIDER_ID_HEADER } from "../src/provider-router.js";
import { createGatewayFetchHandler } from "../src/server.js";

const model = "gpt-6.1-terra";
const thinking = "Check the workspace.";
const reply = "Found the file.";

for (const [name, baseUrl, authMethod, strict, encrypted] of [
  ["ChatGPT OAuth", "https://api.openai.com", "chatgpt_subscription", true, false],
  ["OpenAI API key", "https://api.openai.com", "api_key", true, true],
  ["compatible provider", "https://responses.example.test", "api_key", false, false],
] as const) {
  test(`${name}: Messages can continue after a thinking block and tool call`, async () => {
    const toolCallResponse: ResponsesResponse = {
      id: "resp_tool",
      object: "response",
      model,
      status: "completed",
      output: [
        {
          type: "reasoning", id: "rs_tool", summary: [{ type: "summary_text", text: thinking }],
          ...(encrypted ? { encrypted_content: "ciphertext" } : {}),
        },
        { type: "function_call", id: "fc_tool", call_id: "call_lookup", name: "lookup", arguments: '{"query":"file"}' },
      ],
    };
    const finalResponse: ResponsesResponse = {
      ...toolCallResponse,
      id: "resp_done",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: reply }] }],
    };
    const inputHistory: ResponsesInputItem[][] = [];
    const handler = createGatewayFetchHandler({
      host: "127.0.0.1", port: 0,
      providers: [{ id: "test", name, baseUrl, authMethod, upstreamKind: "responses", apiKey: "test", models: [model] }],
      resolveCredential: async () => ({ accessToken: "test-oauth" }),
    }, async (_url, init) => {
      const { input, stream } = JSON.parse(String(init?.body)) as { input: ResponsesInputItem[]; stream: boolean };
      inputHistory.push(input);
      const invalidIndex = input.findIndex((item) => item.type === "reasoning" && Array.isArray(item.content) && item.content.length > 0);
      if (strict && invalidIndex >= 0) {
        return Response.json({ error: {
          message: `Invalid 'input[${invalidIndex}].content': array too long. Expected an array with maximum length 0, but got an array with length 1 instead.`,
          code: "array_above_max_length",
        } }, { status: 400 });
      }
      const response = inputHistory.length === 1 ? toolCallResponse : finalResponse;
      if (!stream) return Response.json(response);
      const events = [
        { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
        { type: "response.completed", response },
      ];
      return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
        headers: { "content-type": "text/event-stream" },
      });
    });

    const send = (messages: AnthropicMessage[], stream: boolean) => handler(new Request("http://127.0.0.1/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", [GATEWAY_PROVIDER_ID_HEADER]: "test" },
      body: JSON.stringify({
        model, max_tokens: 128, stream, messages,
        tools: [{ name: "lookup", input_schema: { type: "object", properties: { query: { type: "string" } } } }],
      }),
    }));

    const user: AnthropicMessage = { role: "user", content: "Find the file." };
    const first = await send([user], false);
    expect(first.status).toBe(200);
    const assistant = (await first.json()) as AnthropicMessage & { stop_reason: string };
    expect(assistant.stop_reason).toBe("tool_use");
    expect(assistant.content).toContainEqual({ type: "thinking", thinking });
    expect(assistant.content).toContainEqual({ type: "tool_use", id: "call_lookup", name: "lookup", input: { query: "file" } });

    const second = await send([
      user,
      { role: "assistant", content: assistant.content },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_lookup", content: "Found: example.ts" }] },
    ], true);
    expect(second.status).toBe(200);
    const sse = await second.text();
    expect(sse).toContain(reply);
    expect(sse).toContain("event: message_stop");
    expect(sse).not.toContain("event: error");
    expect(inputHistory).toHaveLength(2);
    expect(inputHistory[1]).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "Find the file." }] },
      ...(!strict ? [{ type: "reasoning", id: "rs_0", summary: [], content: [{ type: "reasoning_text", text: thinking }] }] : []),
      ...(encrypted ? [{ type: "reasoning", id: expect.any(String), summary: [], encrypted_content: "ciphertext" }] : []),
      { type: "function_call", call_id: "call_lookup", name: "lookup", arguments: '{"query":"file"}' },
      { type: "function_call_output", call_id: "call_lookup", output: "Found: example.ts" },
    ]);
  });
}
