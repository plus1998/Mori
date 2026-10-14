import { randomUUID } from "node:crypto";

export type Protocol = "responses" | "anthropic" | "chat";
export type Call = { name: string; input: Record<string, unknown>; namespace?: string };
export type Block =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown>; namespace?: string };

export function toolsIn(body: Record<string, any>): Call[] {
  const out: Call[] = [];
  for (const t of body.tools ?? []) {
    if (t.type === "namespace")
      for (const c of t.tools ?? []) out.push({ name: c.name, namespace: t.name, input: {} });
    else out.push({ name: t.function?.name ?? t.name, input: {} });
  }
  return out;
}

export function wireReply(protocol: Protocol, body: Record<string, any>, calls: Call[] = []): Response {
  const id = `resp_${randomUUID().replaceAll("-", "")}`;
  const blocks: Block[] = calls.length
    ? calls.map((c, i) => ({ type: "tool_use", id: `call_${id}_${i}`, ...c }))
    : [{ type: "text", text: "OUTPUT_BUDGET_OK" }];
  if (protocol === "anthropic") {
    const usage = {
      input_tokens: 100,
      output_tokens: 10,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    };
    const message = {
      id: `msg_${id}`,
      type: "message",
      role: "assistant",
      model: body.model,
      content: blocks,
      stop_reason: calls.length ? "tool_use" : "end_turn",
      stop_sequence: null,
      usage,
    };
    if (!body.stream) return Response.json(message);
    const events: any[] = [
      {
        type: "message_start",
        message: { ...message, content: [], stop_reason: null, usage: { ...usage, output_tokens: 0 } },
      },
    ];
    blocks.forEach((block, index) =>
      events.push(
        {
          type: "content_block_start",
          index,
          content_block: block.type === "text" ? { type: "text", text: "" } : { ...block, input: {} },
        },
        {
          type: "content_block_delta",
          index,
          delta:
            block.type === "text"
              ? { type: "text_delta", text: block.text }
              : { type: "input_json_delta", partial_json: JSON.stringify(block.input) },
        },
        { type: "content_block_stop", index },
      ),
    );
    events.push(
      {
        type: "message_delta",
        delta: { stop_reason: message.stop_reason, stop_sequence: null },
        usage: { output_tokens: 10 },
      },
      { type: "message_stop" },
    );
    return sse(events);
  }
  if (protocol === "chat") {
    const tool_calls = calls.map((c, i) => ({
      id: `call_${id}_${i}`,
      type: "function",
      function: { name: c.name, arguments: JSON.stringify(c.input) },
    }));
    const message = {
      role: "assistant",
      content: calls.length ? null : "OUTPUT_BUDGET_OK",
      ...(calls.length && { tool_calls }),
    };
    const finish_reason = calls.length ? "tool_calls" : "stop";
    if (!body.stream)
      return Response.json({
        id: `chatcmpl_${id}`,
        object: "chat.completion",
        created: 1,
        model: body.model,
        choices: [{ index: 0, message, finish_reason }],
        usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
      });
    const base = { id: `chatcmpl_${id}`, object: "chat.completion.chunk", created: 1, model: body.model };
    const chunks = [
      {
        ...base,
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
              ...(calls.length
                ? { tool_calls: tool_calls.map((c, index) => ({ ...c, index })) }
                : { content: "OUTPUT_BUDGET_OK" }),
            },
            finish_reason: null,
          },
        ],
      },
      {
        ...base,
        choices: [{ index: 0, delta: {}, finish_reason }],
        usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
      },
    ];
    return new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n", {
      headers: { "content-type": "text/event-stream" },
    });
  }
  const output = blocks.map((b, i) =>
    b.type === "text"
      ? {
          id: `msg_${id}_${i}`,
          type: "message" as const,
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: b.text, annotations: [] }],
        }
      : {
          id: `fc_${id}_${i}`,
          call_id: b.id,
          type: "function_call" as const,
          name: b.name,
          arguments: JSON.stringify(b.input),
          status: "completed",
          ...(b.namespace && { namespace: b.namespace }),
        },
  );
  const response = {
    id,
    object: "response",
    model: body.model,
    status: "completed",
    output,
    usage: {
      input_tokens: 100,
      output_tokens: 10,
      total_tokens: 110,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    },
  };
  if (!body.stream) return Response.json(response);
  const events: any[] = [
    { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
  ];
  output.forEach((item, output_index) => {
    events.push({
      type: "response.output_item.added",
      output_index,
      item:
        item.type === "function_call"
          ? { ...item, arguments: "", status: "in_progress" }
          : { ...item, content: [], status: "in_progress" },
    });
    if (item.type === "function_call")
      events.push(
        {
          type: "response.function_call_arguments.delta",
          output_index,
          item_id: item.id,
          delta: item.arguments,
        },
        {
          type: "response.function_call_arguments.done",
          output_index,
          item_id: item.id,
          arguments: item.arguments,
        },
      );
    else
      events.push(
        {
          type: "response.content_part.added",
          output_index,
          content_index: 0,
          item_id: item.id,
          part: { type: "output_text", text: "", annotations: [] },
        },
        {
          type: "response.output_text.delta",
          output_index,
          content_index: 0,
          item_id: item.id,
          delta: "OUTPUT_BUDGET_OK",
        },
        {
          type: "response.output_text.done",
          output_index,
          content_index: 0,
          item_id: item.id,
          text: "OUTPUT_BUDGET_OK",
        },
        {
          type: "response.content_part.done",
          output_index,
          content_index: 0,
          item_id: item.id,
          part: item.content?.[0],
        },
      );
    events.push({ type: "response.output_item.done", output_index, item });
  });
  events.push({ type: "response.completed", response });
  return sse(events.map((e, sequence_number) => ({ ...e, sequence_number })));
}
function sse(events: any[]): Response {
  return new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}
