import { expect, test } from "bun:test";
import {
  collectResponsesStream,
  ResponsesStreamError,
} from "../src/upstream/collect-responses-stream.js";

test("SSE 聚合拒绝 incomplete 终态并保留停止原因", async () => {
  const response = {
    id: "resp_1",
    output: [],
    status: "incomplete",
    incomplete_details: { reason: "max_output_tokens" },
  };
  const body = new Response(`event: response.incomplete\ndata: ${JSON.stringify({ response })}`).body;
  if (!body) throw new Error("Missing fixture stream");
  try {
    await collectResponsesStream(body);
    throw new Error("Expected incomplete response to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(ResponsesStreamError);
    expect(error).toMatchObject({
      code: "response_incomplete",
      responseId: "resp_1",
      errorInfo: {
        eventType: "response.incomplete",
        rawEvent: { type: "response.incomplete", response },
      },
    });
  }
});

test("SSE 聚合拒绝格式损坏或不完整的终态", async () => {
  for (const data of ['{"type":"response.completed"}', "invalid-json"]) {
    const body = new Response(`data: ${data}\n\n`).body;
    if (!body) throw new Error("Missing fixture stream");
    await expect(collectResponsesStream(body)).rejects.toThrow();
  }
});

test("SSE 聚合按输出索引排列已完成项目，避免 reasoning/text/tool 顺序错乱", async () => {
  const output = [
    { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "Thinking" }] },
    { type: "message", id: "msg_1", role: "assistant", content: [{ type: "output_text", text: "Hi" }] },
    { type: "function_call", id: "fc_1", call_id: "call_1", name: "lookup", arguments: "{}" },
  ];
  const events = [2, 0, 1].map((index) => ({
    type: "response.output_item.done",
    output_index: index,
    item: output[index],
  }));
  const response = { id: "resp_1", status: "completed", output: [] };
  const data = [...events, { type: "response.completed", response }]
    .map((event) => `data: ${JSON.stringify(event)}\n\n`)
    .join("");
  const body = new Response(data).body;
  if (!body) throw new Error("Missing fixture stream");
  expect((await collectResponsesStream(body)).output).toEqual(output);
});

test("SSE 聚合拒绝只有 delta 或尚未完成的项目，不能以空输出冒充成功", async () => {
  for (const event of [
    { type: "response.output_text.delta", delta: "partial", output_index: 0 },
    { type: "response.output_item.added", item: { type: "message" }, output_index: 0 },
  ]) {
    const data = `data: ${JSON.stringify(event)}\n\ndata: ${JSON.stringify({ type: "response.completed", response: { id: "resp_1", status: "completed", output: [] } })}\n\n`;
    const body = new Response(data).body;
    if (!body) throw new Error("Missing fixture stream");
    await expect(collectResponsesStream(body)).rejects.toThrow("missing completed output items");
  }
});

test("SSE 聚合超时会取消上游，避免非流式请求挂起", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true;
    },
  });
  await expect(collectResponsesStream(body, { idleTimeoutMs: 10 })).rejects.toThrow("Timed out");
  expect(cancelled).toBe(true);
});

test("SSE 聚合响应客户端取消并释放上游", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true;
    },
  });
  const controller = new AbortController();
  const collected = collectResponsesStream(body, { signal: controller.signal });
  controller.abort(new Error("Client cancelled"));
  await expect(collected).rejects.toThrow("Client cancelled");
  expect(cancelled).toBe(true);
});
