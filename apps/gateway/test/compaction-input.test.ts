import { expect, test } from "bun:test";
import { coalesceResponsesCompactionInput } from "../src/compaction-input.js";
import { withDynamicOutputBudget } from "../src/model-output-limit.js";
import type { GatewayProvider } from "../src/types.js";

const message = (text: string) => ({
  type: "message",
  role: "user",
  content: [{ type: "input_text", text }],
});
const history = () => [
  ...Array.from({ length: 6 }, (_, i) => message(`instruction ${i}`)),
  ...Array.from({ length: 999 }, (_, i) => ({
    type: "function_call_output",
    call_id: `call_${i}`,
    output: `result ${i}`,
  })),
];

for (const compact of [false, true]) {
  test(`only verified compaction coalesces long Responses input before counting: ${compact}`, async () => {
    const provider: GatewayProvider = {
      id: "compact",
      name: "Compact",
      baseUrl: "https://example.test",
      apiKey: "test",
      upstreamKind: "responses",
      upstreamModelId: "m",
      models: ["m"],
      modelContextTokens: { m: 524_288 },
    };
    const input = history();
    let counted: unknown;
    let sent = { input: [] as ReturnType<typeof history> };
    const fetcher = withDynamicOutputBudget(
      async (_url, init) => {
        sent = JSON.parse(String(init?.body));
        return Response.json({}, { status: sent.input.length > 1000 ? 400 : 200 });
      },
      { provider, requestedModel: "m", upstreamModelId: "m", upstreamKind: "responses" },
      {
        host: "127.0.0.1",
        port: 0,
        providers: [provider],
        resolveModelLimits: async () => (compact ? { compactionContextTokens: 1_048_576 } : {}),
        countInputTokens: async ({ body }) => {
          counted = body.input;
          return { tokens: 100, precision: "provider_exact", source: "test" };
        },
      },
      new AbortController().signal,
      () => {},
    );
    const response = await fetcher("https://example.test/v1/responses", {
      method: "POST",
      body: JSON.stringify({ model: "m", input }),
    });
    expect(response.status).toBe(compact ? 200 : 400);
    expect(counted).toEqual(sent.input);
    expect(sent.input).toHaveLength(compact ? 1000 : 1005);
    expect(sent.input.slice(compact ? 1 : 6)).toEqual(input.slice(6));
    const textBlocks = (items: typeof input) => items.flatMap((m) => ("content" in m ? m.content : []));
    expect(textBlocks(sent.input.slice(0, compact ? 1 : 6)).filter((p) => p.text !== "\n\n")).toEqual(
      textBlocks(input.slice(0, 6)),
    );
  });
}

test("coalescing preserves image, metadata and reasoning boundaries and leaves short inputs untouched", () => {
  const short = { input: [message("a"), message("b")] };
  const original = short.input;
  coalesceResponsesCompactionInput(short);
  expect(short.input).toBe(original);
  const boundaries = [
    message("a"),
    {
      type: "message",
      role: "user",
      content: [{ type: "input_image", image_url: "https://example.test/image.png" }],
    },
    message("b"),
    { ...message("c"), id: "msg_c" },
    message("d"),
    { type: "reasoning", encrypted_content: "opaque" },
    message("e"),
  ];
  const body = { input: [...boundaries, ...history().slice(6)] };
  const before = structuredClone(body);
  coalesceResponsesCompactionInput(body);
  expect(body).toEqual(before);
});
